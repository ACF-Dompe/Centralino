/**
 * WLC SSH service.
 * Opens an interactive shell on the IOS-XE controller and runs a sequence
 * of commands (terminal length 0, enable, configure terminal, ...).
 *
 * Commands are paced by a fixed delay; a caller that needs a command's full
 * output passes `waitFor` with a pattern ending on the prompt (/[#>]$/).
 */
import { Client, type ConnectConfig } from 'ssh2';
import { config } from '../config.js';
import { log } from '../logger.js';

/**
 * Set once we have logged that host key verification is off, so the notice
 * appears in the logs without the 30-second background sync flooding them.
 */
let warnedUnverified = false;

export interface SshExecInput {
  host: string;
  port?: number;
  username: string;
  password: string;
  commands: string[];
  /**
   * Read-only probes sent after `commands`. The controller rejecting one — a
   * `show` this IOS-XE release does not know — is reported in `optionalFailed`
   * instead of failing the run and throwing away the output of the commands
   * that did work.
   */
  optionalCommands?: string[];
  /**
   * After the last command, wait until the raw output matches `pattern` (or
   * `timeoutMs` passes) before closing. The fixed per-command delay closes the
   * session before a slow `show running-config` has printed anything.
   */
  waitFor?: { pattern: RegExp; timeoutMs: number };
  perCommandDelayMs?: number;
  initialDelayMs?: number;
  /**
   * Budget for connecting and authenticating. Once the shell is open the
   * session also gets the time its command schedule needs: a single budget for
   * both used to cut a ten-command run off halfway through.
   */
  timeoutMs?: number;
  expectErrors?: RegExp[];
}

export interface SshExecResult {
  success: boolean;
  output: string;
  error?: string;
  errorPattern?: string;
  /** True when the controller rejected one of `optionalCommands`. */
  optionalFailed?: boolean;
}

/**
 * Wide enough for `show wireless client summary detail`, whose rows run past
 * 240 characters; 512 is the largest width IOS-XE accepts.
 */
const SHELL_COLS = 512;
/** Time left between the final `exit` and closing the connection. */
const EXIT_SETTLE_MS = 800;
const WAIT_POLL_MS = 200;

const ERROR_PATTERNS = [
  /%\s*Invalid input detected/i,
  /%\s*Access denied/i,
  /%\s*Incomplete command/i,
  /%\s*Unauthorized/i,
  /%\s*Error/i,
];

export function execSsh(input: SshExecInput): Promise<SshExecResult> {
  return new Promise((resolve) => {
    // Host key verification is opt-in (WLC_SSH_VERIFY_HOST_KEY, default false).
    //
    // When it is ON we fail closed if no expected key is configured: connecting
    // anyway would defeat the point of having asked for verification.
    if (config.wlc.sshVerifyHostKey && !config.wlc.sshHostKey) {
      log.error(
        { host: input.host },
        'Refusing SSH connection: WLC_SSH_VERIFY_HOST_KEY is true but WLC_SSH_HOST_KEY is not set',
      );
      resolve({
        success: false,
        output: '',
        error: 'SSH host key verification is enabled but no expected key is configured (set WLC_SSH_HOST_KEY).',
      });
      return;
    }

    // When it is OFF, say so once. The session is unauthenticated and carries
    // the WLC admin password and the guest credentials, so the state must be
    // visible in the logs rather than silent — but only once, because the
    // background sync would otherwise repeat it every 30s per sede.
    if (!config.wlc.sshVerifyHostKey && !warnedUnverified) {
      warnedUnverified = true;
      log.warn(
        { host: input.host, env: config.nodeEnv },
        'SSH host key verification is DISABLED (WLC_SSH_VERIFY_HOST_KEY=false) — WLC sessions are not authenticated',
      );
    }

    const conn = new Client();
    const timeoutMs = input.timeoutMs ?? config.wlc.sshTimeoutMs;
    const connectCfg: ConnectConfig = {
      host: input.host,
      port: input.port ?? 22,
      username: input.username,
      password: input.password,
      readyTimeout: timeoutMs,
      tryKeyboard: true,
      // Host key verification: when WLC_SSH_HOST_KEY is set, the SSH client
      // verifies the remote host's public key fingerprint before connecting.
      // In production, always set this to prevent MITM attacks.
      hostVerifier: config.wlc.sshVerifyHostKey && config.wlc.sshHostKey
        ? (key: Buffer, verified: (ok: boolean) => void) => {
            // ssh2's hostVerifier is async — call verified() with the result.
            // Compare the host key (base64 fingerprint or hex) against the expected value.
            const fingerprint = key.toString('base64');
            const match = fingerprint === config.wlc.sshHostKey ||
                          key.toString('hex') === config.wlc.sshHostKey;
            if (!match) {
              log.error({ host: input.host, fingerprint: fingerprint.slice(0, 32) + '...' }, 'SSH host key mismatch');
            }
            verified(match);
          }
        : undefined,
    };

    let settled = false;
    let allOutput = '';
    const safeResolve = (result: SshExecResult) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* ignore */ }
      resolve(result);
    };

    let timer = setTimeout(() => {
      safeResolve({ success: false, output: allOutput, error: `SSH timeout dopo ${timeoutMs}ms` });
    }, timeoutMs);

    conn.on('ready', () => {
      conn.shell({ term: 'vt100', cols: SHELL_COLS, rows: 2000 }, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return safeResolve({ success: false, output: '', error: `Shell error: ${err.message}` });
        }

        let buffer = '';
        let cmdIndex = 0;
        let aborted = false;
        const initialDelay = input.initialDelayMs ?? 1200;
        const cmdDelay = input.perCommandDelayMs ?? 800;
        const allCommands = [...input.commands, ...(input.optionalCommands ?? [])];
        /** Where the optional probes' output starts in `buffer`; -1 until they are sent. */
        let optionalStart = -1;
        let optionalFailed = false;

        // Connected: from here the session needs as long as its schedule, plus
        // the same budget again as slack for a controller that answers slowly.
        clearTimeout(timer);
        const sessionMs = timeoutMs + initialDelay + (allCommands.length + 1) * cmdDelay
          + EXIT_SETTLE_MS + (input.waitFor?.timeoutMs ?? 0);
        timer = setTimeout(() => {
          safeResolve({ success: false, output: allOutput, error: `SSH timeout dopo ${sessionMs}ms` });
        }, sessionMs);

        const finish = () => {
          if (aborted) return;
          stream.write('exit\n');
          setTimeout(() => {
            clearTimeout(timer);
            safeResolve({ success: true, output: allOutput, ...(optionalFailed ? { optionalFailed } : {}) });
          }, EXIT_SETTLE_MS);
        };

        const waitThenFinish = () => {
          const wait = input.waitFor;
          if (!wait) {
            setTimeout(finish, cmdDelay);
            return;
          }
          let waited = 0;
          const poll = () => {
            if (aborted) return;
            // A rejected probe will never print what we are waiting for.
            if (optionalFailed || wait.pattern.test(buffer) || waited >= wait.timeoutMs) return finish();
            waited += WAIT_POLL_MS;
            setTimeout(poll, WAIT_POLL_MS);
          };
          setTimeout(poll, cmdDelay);
        };

        const sendNext = () => {
          if (aborted) return;
          if (cmdIndex >= allCommands.length) {
            waitThenFinish();
            return;
          }
          if (cmdIndex === input.commands.length) optionalStart = buffer.length;
          const cmd = allCommands[cmdIndex++];
          stream.write(`${cmd}\n`);
          allOutput += `\n>>> ${cmd}\n`;
          setTimeout(sendNext, cmdDelay);
        };

        stream.on('data', (data: Buffer) => {
          const text = data.toString('utf8');
          allOutput += text;
          buffer += text;
          if (aborted) return;
          if (optionalStart >= 0) {
            // Everything from here is attributed to the probes — including a
            // late answer to the last required command, which is read-only by
            // the time any caller adds probes after it.
            if (!optionalFailed && ERROR_PATTERNS.some((re) => re.test(buffer.slice(optionalStart)))) {
              optionalFailed = true;
            }
            return;
          }
          for (const re of ERROR_PATTERNS) {
            const m = buffer.match(re);
            if (m) {
              aborted = true;
              clearTimeout(timer);
              safeResolve({
                success: false,
                output: allOutput,
                error: `Comando respinto: ${m[0]}`,
                errorPattern: m[0],
              });
              try { stream.write('exit\n'); } catch { /* ignore */ }
              return;
            }
          }
        });

        stream.on('close', () => {
          clearTimeout(timer);
          if (!settled) {
            safeResolve({ success: true, output: allOutput, ...(optionalFailed ? { optionalFailed } : {}) });
          }
        });

        setTimeout(sendNext, initialDelay);
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      log.warn({ err: err.message, host: input.host }, 'SSH connection error');
      safeResolve({ success: false, output: '', error: `SSH error: ${err.message}` });
    });

    conn.on('keyboard-interactive', (_name, _instructions, _instructionsLang, prompts, finish) => {
      // Reply to all prompts with the admin password.
      finish([...prompts.map(() => input.password)]);
    });

    conn.connect(connectCfg);
  });
}

/**
 * Parse the output of `show running-config | include ^username` and
 * extract the list of usernames with their privilege level.
 * Returns objects with `{ username, privilege }`.
 * Users without an explicit `privilege` keyword (guest users on AireOS)
 * have `privilege === null`.
 */
export function parseUsernameList(output: string): { username: string; privilege: number | null }[] {
  const lines = output.split(/\r?\n/);
  const result: { username: string; privilege: number | null }[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*username\s+(\S+)(?:.*\bprivilege\s+(\d+))?/i);
    if (m) {
      result.push({
        username: m[1],
        privilege: m[2] != null ? Number(m[2]) : null,
      });
    }
  }
  return result;
}

/**
 * Filter parsed users to return only guest-type users
 * (those WITHOUT a privilege level — management users have `privilege 15`).
 */
export function getGuestUsers(users: { username: string; privilege: number | null }[]): { username: string }[] {
  return users.filter((u) => u.privilege == null).map((u) => ({ username: u.username }));
}

export interface GuestUserInfo {
  username: string;
  /** Unix timestamp (seconds) when the guest was created on the WLC */
  createdAt: number | null;
  /** Total lifetime in minutes parsed from the WLC config */
  durationMinutes: number | null;
}

/**
 * Parse a `guest-user lifetime` string into total minutes.
 * Input format: `year X month X day X hour X minute X second X`
 * Uses 1 year = 365 days, 1 month = 30 days for the conversion.
 */
export function parseLifetimeToMinutes(lifetimeStr: string): number | null {
  const m = lifetimeStr.match(
    /year\s+(\d+)\s+month\s+(\d+)\s+day\s+(\d+)\s+hour\s+(\d+)\s+minute\s+(\d+)\s+second\s+(\d+)/i,
  );
  if (!m) return null;
  const years = Number(m[1]);
  const months = Number(m[2]);
  const days = Number(m[3]);
  const hours = Number(m[4]);
  const minutes = Number(m[5]);
  const totalDays = years * 365 + months * 30 + days;
  return totalDays * 24 * 60 + hours * 60 + minutes;
}

/**
 * Parse the output of `show running-config | section user-name` on an
 * IOS-XE WLC and extract guest-user info (username, creation-time, lifetime).
 *
 * Each guest-user block looks like:
 *   user-name <email>
 *    creation-time <unix_ts>
 *    description Guest-User
 *    password 0 <plaintext>
 *    type network-user description Guest-User guest-user lifetime year 0 month 6 day 0 hour 0 minute 0 second 0
 *
 * Lobby-admin blocks look like:
 *   user-name guestadmin
 *    creation-time <ts>
 *    privilege 0
 *    view LobbyAdminView
 *    type lobby-admin
 *
 * Returns only guest-user type entries (with `type network-user`),
 * excluding lobby-admin accounts, with their creation-time and duration.
 */
export function extractGuestUsers(output: string): GuestUserInfo[] {
  const lines = output.split(/\r?\n/);
  const users: GuestUserInfo[] = [];
  let currentUser: GuestUserInfo | null = null;
  let isGuestUser = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Start of a new user block
    const headerMatch = trimmed.match(/^user-name\s+(.+)$/i);
    if (headerMatch) {
      // Flush previous user if it was a guest
      if (currentUser && isGuestUser) {
        users.push(currentUser);
      }
      currentUser = {
        username: headerMatch[1].replace(/^"|"$/g, ''), // strip quotes
        createdAt: null,
        durationMinutes: null,
      };
      isGuestUser = false;
      continue;
    }

    if (!currentUser) continue;

    // Check type — only network-user entries are actual guests
    if (/^type\s+network-user/i.test(trimmed)) {
      isGuestUser = true;
      // Extract lifetime from the type line
      const lifeMatch = trimmed.match(/guest-user\s+lifetime\s+.+$/i);
      if (lifeMatch) {
        const parsed = parseLifetimeToMinutes(lifeMatch[0]);
        if (parsed !== null) {
          currentUser.durationMinutes = parsed;
        }
      }
      continue;
    }

    // Capture creation-time (unix timestamp in seconds)
    if (/^type\s+lobby-admin/i.test(trimmed)) {
      isGuestUser = false;
      continue;
    }

    const ctMatch = trimmed.match(/^creation-time\s+(\d+)$/i);
    if (ctMatch) {
      currentUser.createdAt = Number(ctMatch[1]);
      continue;
    }
  }

  // Flush last user
  if (currentUser && isGuestUser) {
    users.push(currentUser);
  }

  return users;
}

/**
 * Convert total minutes to a WLC guest-user lifetime string.
 * This is the reverse of `parseLifetimeToMinutes`.
 * Uses 1 year = 365 days, 1 month = 30 days for consistency with the WLC.
 */
export function minutesToLifetime(totalMinutes: number): string {
  let remaining = totalMinutes;
  const years = Math.floor(remaining / (365 * 24 * 60));
  remaining -= years * 365 * 24 * 60;
  const months = Math.floor(remaining / (30 * 24 * 60));
  remaining -= months * 30 * 24 * 60;
  const days = Math.floor(remaining / (24 * 60));
  remaining -= days * 24 * 60;
  const hours = Math.floor(remaining / 60);
  const minutes = remaining % 60;
  return `year ${years} month ${months} day ${days} hour ${hours} minute ${minutes} second 0`;
}

/** A client row of `show wireless client ...` starts with its MAC: aaaa.bbbb.cccc */
const CLIENT_ROW_RE = /^\s*[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\s/i;

export interface WirelessClientScan {
  /**
   * False when the output held no client table carrying user names — a
   * command this release does not know, or a layout without that column. The
   * caller must then say "unknown", never "nobody is connected".
   */
  readable: boolean;
  /**
   * Every token of every client row in the Run state, lower-cased.
   *
   * A guest is looked up by matching its username against these tokens rather
   * than reading a column at a fixed offset: the layout differs between
   * releases and shifts whenever an SSID or AP name outgrows its column, while
   * a `g.name123` username cannot be mistaken for anything else on the row.
   */
  runTokens: Set<string>;
}

/**
 * Parse `show wireless client summary detail`: which users are associated and
 * fully authenticated (state Run) right now.
 */
export function parseWirelessClients(output: string): WirelessClientScan {
  const runTokens = new Set<string>();
  let hasUserColumn = false;
  let noClients = false;
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*Number of Clients\s*:\s*0\s*$/i.test(line)) noClients = true;
    if (/MAC Address/i.test(line) && /\buser[\s-]?name\b/i.test(line)) hasUserColumn = true;
    if (!CLIENT_ROW_RE.test(line)) continue;
    const tokens = line.trim().split(/\s+/).map((t) => t.toLowerCase());
    if (!tokens.includes('run')) continue;
    for (const t of tokens) runTokens.add(t);
  }
  return { readable: hasUserColumn || noClients, runTokens };
}

/** @deprecated Use {@link extractGuestUsers} instead */
export function extractGuestUserNames(output: string): string[] {
  return extractGuestUsers(output).map((u) => u.username);
}
