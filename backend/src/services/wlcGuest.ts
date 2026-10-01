/**
 * Guest accounts on the Catalyst 9800.
 *
 * Create, resend and the admin endpoint used to carry three copies of the same
 * command list. They live here now, together with the read-back that says
 * whether the controller ended up with the account we meant to give it — the
 * old code threw the session output away, so an account that reached the
 * controller broken looked exactly like one that worked.
 */
import { execSsh, extractGuestUsers, minutesToLifetime } from './wlcSsh.js';
import { log } from '../logger.js';

export interface WlcTarget {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface GuestAccountInput {
  username: string;
  password: string;
  durationMinutes: number;
  /**
   * Delete the account before writing it. The controller counts the lifetime
   * from `creation-time`, which it sets when the account is created and keeps
   * when an existing one is edited: without this, new credentials for an old
   * account arrive already expired.
   */
  replace?: boolean;
}

export interface GuestAccountResult {
  /** The controller accepted every command. */
  ok: boolean;
  error?: string;
  /** What looked wrong reading the account back, in words for the sync log. */
  issues: string[];
  /** Tail of the session with every password masked, for the sync log. */
  transcript: string;
}

/** The controller's clock may drift this much from ours before it matters. */
const CLOCK_TOLERANCE_S = 120;
/** How long to wait for `show running-config` to print the account. */
const READBACK_TIMEOUT_MS = 6_000;
const TRANSCRIPT_MAX_CHARS = 1_500;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readbackCommand(username: string): string {
  return `show running-config | section user-name ${username}`;
}

/**
 * The part of the transcript printed after the read-back was sent.
 *
 * execSsh marks each command with a `>>> <command>` line as it sends it, so the
 * controller's echo of `user-name <name>` lands at the start of a line, where
 * it reads exactly like the header of the block we are looking for. Only what
 * follows the read-back is the controller describing the account.
 */
function readbackOutput(output: string, username: string): string {
  const marker = `>>> ${readbackCommand(username)}`;
  const at = output.lastIndexOf(marker);
  return at >= 0 ? output.slice(at + marker.length) : '';
}

/**
 * The command sequence for one guest account.
 *
 * `type` comes before `password`, as in Cisco's procedure: the lifetime is part
 * of the type, and an account cut off halfway must never be left with a
 * password but no lifetime.
 */
export function guestAccountCommands(input: GuestAccountInput): string[] {
  return [
    'terminal length 0',
    'configure terminal',
    ...(input.replace ? [`no user-name ${input.username}`] : []),
    `user-name ${input.username}`,
    `type network-user description Guest-User guest-user lifetime ${minutesToLifetime(input.durationMinutes)}`,
    `password 0 ${input.password}`,
    'do write memory',
    'end',
    readbackCommand(input.username),
  ];
}

/**
 * Matches once the read-back has printed the account block and returned to
 * the prompt. The block header has to start a line: the echoed command also
 * contains "user-name <name>", but after "| section ".
 */
function readbackDone(username: string): RegExp {
  return new RegExp(`\\n[ \\t]*user-name[ \\t]+${escapeRegExp(username)}[ \\t]*\\r?\\n[\\s\\S]*\\n[^\\n]*[#>][ \\t]*$`);
}

/** Mask every password in a session transcript. */
export function redactTranscript(output: string, secrets: string[]): string {
  let out = output.replace(/(password\s+\d+\s+)\S+/gi, '$1***');
  for (const s of secrets) {
    if (s) out = out.split(s).join('***');
  }
  return out;
}

function describeSkew(seconds: number): string {
  const minutes = Math.round(Math.abs(seconds) / 60);
  return seconds > 0 ? `avanti di ${minutes} min` : `indietro di ${minutes} min`;
}

/**
 * Compare the account as the controller printed it with what was asked for.
 *
 * @param output - the whole execSsh transcript of the provisioning run.
 * @param startedAtSec - our clock when the session started; the controller
 *   stamps `creation-time` a few seconds later, from its own clock.
 * @returns the problems found, empty when the account looks right.
 */
export function checkGuestAccount(
  output: string,
  username: string,
  durationMinutes: number,
  startedAtSec: number,
  nowSec: number,
): string[] {
  const readback = readbackOutput(output, username);
  const header = new RegExp(`(^|\\n)[ \\t]*user-name[ \\t]+${escapeRegExp(username)}[ \\t]*\\r?(\\n|$)`);
  if (!header.test(readback)) {
    return ['account non trovato nella running-config dopo la scrittura'];
  }
  const entry = extractGuestUsers(readback).find((u) => u.username === username);
  if (!entry) {
    return ['account presente ma senza "type network-user ... guest-user lifetime"'];
  }

  const issues: string[] = [];
  if (entry.durationMinutes == null) {
    issues.push('nessun guest-user lifetime registrato');
  } else if (entry.durationMinutes !== durationMinutes) {
    issues.push(`lifetime registrato ${entry.durationMinutes} min invece di ${durationMinutes}`);
  }
  if (entry.createdAt == null) {
    issues.push('creation-time assente');
    return issues;
  }
  const skew = entry.createdAt - startedAtSec;
  if (Math.abs(skew) > CLOCK_TOLERANCE_S) {
    issues.push(
      `creation-time del WLC ${describeSkew(skew)} rispetto al server ` +
      '(account preesistente non ricreato, oppure orologio/NTP del controller da verificare)',
    );
  }
  const lifetime = entry.durationMinutes ?? durationMinutes;
  if (entry.createdAt + lifetime * 60 <= nowSec) {
    issues.push('account già scaduto secondo creation-time + lifetime');
  }
  return issues;
}

/**
 * Create (or recreate) a guest account and read it back. Never throws: the
 * callers run it fire-and-forget, where a rejection would take the process down.
 */
export async function provisionGuestAccount(target: WlcTarget, input: GuestAccountInput): Promise<GuestAccountResult> {
  try {
    const startedAtSec = Math.floor(Date.now() / 1000);
    const run = (replace: boolean) => execSsh({
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      commands: guestAccountCommands({ ...input, replace }),
      waitFor: { pattern: readbackDone(input.username), timeoutMs: READBACK_TIMEOUT_MS },
    });

    let r = await run(Boolean(input.replace));
    // Some releases answer `no user-name` for an account they do not have with
    // an error, which aborts the run before anything is written. There was
    // nothing to restart then, so write it plainly.
    if (!r.success && input.replace && r.errorPattern) {
      r = await run(false);
    }

    const transcript = redactTranscript(r.output, [input.password, target.password]).slice(-TRANSCRIPT_MAX_CHARS);
    if (!r.success) {
      return { ok: false, error: r.error ?? 'Errore SSH', issues: [], transcript };
    }
    const issues = checkGuestAccount(r.output, input.username, input.durationMinutes, startedAtSec, Math.floor(Date.now() / 1000));
    if (issues.length > 0) {
      log.warn({ username: input.username, host: target.host, issues }, 'WLC guest account read back with problems');
    }
    return { ok: true, issues, transcript };
  } catch (err) {
    log.error({ err: (err as Error).message, username: input.username }, 'WLC guest provisioning failed');
    return { ok: false, error: (err as Error).message, issues: [], transcript: '' };
  }
}

/** Sync-log payload for a provisioning run: nothing when it went cleanly. */
export function provisionLogPayload(r: GuestAccountResult): string | null {
  if (r.ok && r.issues.length === 0) return null;
  const head = r.ok ? `Verifica: ${r.issues.join('; ')}` : `Errore: ${r.error ?? 'sconosciuto'}`;
  return r.transcript ? `${head}\n---\n${r.transcript}` : head;
}
