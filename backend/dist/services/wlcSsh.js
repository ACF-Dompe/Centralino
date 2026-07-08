/**
 * WLC SSH service.
 * Opens an interactive shell on the IOS-XE controller and runs a sequence
 * of commands (terminal length 0, enable, configure terminal, ...).
 *
 * The shell prompt is matched against /\[#>]$/ as in the original CLI logic.
 */
import { Client } from 'ssh2';
import { config } from '../config.js';
import { log } from '../logger.js';
const ERROR_PATTERNS = [
    /%\s*Invalid input detected/i,
    /%\s*Access denied/i,
    /%\s*Incomplete command/i,
    /%\s*Unauthorized/i,
    /%\s*Error/i,
];
export function execSsh(input) {
    return new Promise((resolve) => {
        const conn = new Client();
        const timeoutMs = input.timeoutMs ?? config.wlc.sshTimeoutMs;
        const connectCfg = {
            host: input.host,
            port: input.port ?? 22,
            username: input.username,
            password: input.password,
            readyTimeout: timeoutMs,
            // Cisco WLC self-signed certs — we accept anything for the demo.
            tryKeyboard: true,
        };
        let settled = false;
        let allOutput = '';
        const safeResolve = (result) => {
            if (settled)
                return;
            settled = true;
            try {
                conn.end();
            }
            catch { /* ignore */ }
            resolve(result);
        };
        const timer = setTimeout(() => {
            safeResolve({ success: false, output: allOutput, error: `SSH timeout dopo ${timeoutMs}ms` });
        }, timeoutMs);
        conn.on('ready', () => {
            conn.shell({ term: 'vt100', cols: 240, rows: 2000 }, (err, stream) => {
                if (err) {
                    clearTimeout(timer);
                    return safeResolve({ success: false, output: '', error: `Shell error: ${err.message}` });
                }
                let buffer = '';
                let cmdIndex = 0;
                let aborted = false;
                const initialDelay = input.initialDelayMs ?? 1200;
                const cmdDelay = input.perCommandDelayMs ?? 800;
                const sendNext = () => {
                    if (aborted)
                        return;
                    if (cmdIndex >= input.commands.length) {
                        setTimeout(() => {
                            if (aborted)
                                return;
                            stream.write('exit\n');
                            setTimeout(() => {
                                clearTimeout(timer);
                                safeResolve({ success: true, output: allOutput });
                            }, 800);
                        }, cmdDelay);
                        return;
                    }
                    const cmd = input.commands[cmdIndex++];
                    stream.write(`${cmd}\n`);
                    allOutput += `\n>>> ${cmd}\n`;
                    setTimeout(sendNext, cmdDelay);
                };
                stream.on('data', (data) => {
                    const text = data.toString('utf8');
                    allOutput += text;
                    buffer += text;
                    if (aborted)
                        return;
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
                            try {
                                stream.write('exit\n');
                            }
                            catch { /* ignore */ }
                            return;
                        }
                    }
                });
                stream.on('close', () => {
                    clearTimeout(timer);
                    if (!settled) {
                        safeResolve({ success: true, output: allOutput });
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
export function parseUsernameList(output) {
    const lines = output.split(/\r?\n/);
    const result = [];
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
export function getGuestUsers(users) {
    return users.filter((u) => u.privilege == null).map((u) => ({ username: u.username }));
}
/**
 * Parse a `guest-user lifetime` string into total minutes.
 * Input format: `year X month X day X hour X minute X second X`
 * Uses 1 year = 365 days, 1 month = 30 days for the conversion.
 */
export function parseLifetimeToMinutes(lifetimeStr) {
    const m = lifetimeStr.match(/year\s+(\d+)\s+month\s+(\d+)\s+day\s+(\d+)\s+hour\s+(\d+)\s+minute\s+(\d+)\s+second\s+(\d+)/i);
    if (!m)
        return null;
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
export function extractGuestUsers(output) {
    const lines = output.split(/\r?\n/);
    const users = [];
    let currentUser = null;
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
        if (!currentUser)
            continue;
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
export function minutesToLifetime(totalMinutes) {
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
/** @deprecated Use {@link extractGuestUsers} instead */
export function extractGuestUserNames(output) {
    return extractGuestUsers(output).map((u) => u.username);
}
//# sourceMappingURL=wlcSsh.js.map