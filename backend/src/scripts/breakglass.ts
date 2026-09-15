/**
 * Break-glass account management CLI.
 *
 * Accounts exist ONLY through this tool — there is deliberately no HTTP
 * endpoint for creating or editing them. An authenticated management API would
 * be a privilege-escalation surface: anyone who compromised a normal session
 * could mint themselves a permanent SSO bypass.
 *
 * Usage locally (from the repository root, no build needed):
 *
 *   make breakglass ARGS="list"
 *   make breakglass ARGS='set <username> --display "Nome Cognome" --expires YYYY-MM-DD'
 *   make breakglass ARGS="unlock <username>"
 *
 * In production, run it inside the backend container so it inherits the UAMI
 * and its Entra token for PostgreSQL. The image's WORKDIR is /app and the
 * build output is copied to /app/backend/dist (see Dockerfile), so the path is
 * the same one the container's CMD uses:
 *
 *   az containerapp exec -n <backend-app> -g <rg> \
 *     --command "node backend/dist/scripts/breakglass.js list"
 *
 * Commands: list | set | enable | disable | unlock | delete
 *
 * The password is NEVER passed as a command-line argument: argv is visible in
 * the shell history and in the process list of every other process in the
 * container. Either let the tool generate one (printed once, to be filed in the
 * password manager immediately) or pipe it in with --stdin-password.
 */
import { config } from '../config.js';
import { createMigrationClient } from '../db/migrate.js';
import type { DbClient } from '../db/index.js';
import {
  generateStrongPassword,
  hashPassword,
  MIN_PASSWORD_LENGTH,
} from '../auth/password.js';
import {
  deleteBreakGlassAccount,
  listBreakGlassAccounts,
  setBreakGlassEnabled,
  unlockBreakGlassAccount,
  upsertBreakGlassAccount,
} from '../repositories/breakglass.js';

const USAGE = `
Break-glass account management

  list                                    List all break-glass accounts
  set <username> --display "Name"         Create an account or rotate its password
                 [--expires YYYY-MM-DD]     Optional expiry date (recommended)
                 [--stdin-password]         Read the password from stdin instead
                                            of generating one
  enable  <username>                      Re-enable a disabled account
  disable <username>                      Disable an account (keeps the row)
  unlock  <username>                      Clear a lockout after failed attempts
  delete  <username>                      Remove an account permanently

Remember: creating an account is not enough — BREAKGLASS_ENABLED must be true
on the backend Container App for the login endpoint to answer at all.
`;

/** Parse `--flag value` / `--flag` pairs out of argv. */
function parseFlags(argv: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return flags;
}

/** Read the whole of stdin as a single trimmed line. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function formatDate(d: Date | null): string {
  return d ? d.toISOString().replace('T', ' ').slice(0, 19) : '—';
}

async function cmdList(client: DbClient): Promise<void> {
  const accounts = await listBreakGlassAccounts(client);
  if (accounts.length === 0) {
    console.log('No break-glass accounts configured.');
    return;
  }
  console.log('');
  console.log(
    ['USERNAME', 'DISPLAY NAME', 'STATE', 'EXPIRES', 'LOCKED UNTIL', 'LAST LOGIN']
      .map((h, i) => h.padEnd([22, 26, 10, 21, 21, 21][i]))
      .join(''),
  );
  for (const a of accounts) {
    const expired = a.expiresAt != null && a.expiresAt <= new Date();
    const state = !a.enabled ? 'disabled' : expired ? 'expired' : 'enabled';
    console.log(
      [
        a.username.padEnd(22),
        a.displayName.slice(0, 25).padEnd(26),
        state.padEnd(10),
        formatDate(a.expiresAt).padEnd(21),
        formatDate(a.lockedUntil).padEnd(21),
        formatDate(a.lastLoginAt).padEnd(21),
      ].join(''),
    );
  }
  console.log('');
}

async function cmdSet(client: DbClient, username: string, argv: string[]): Promise<void> {
  const flags = parseFlags(argv);

  const displayFlag = flags.get('display');
  const displayName = typeof displayFlag === 'string' ? displayFlag : username;

  let expiresAt: Date | null = null;
  const expiresFlag = flags.get('expires');
  if (typeof expiresFlag === 'string') {
    const parsed = new Date(`${expiresFlag}T23:59:59Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid --expires value "${expiresFlag}" (expected YYYY-MM-DD)`);
    }
    expiresAt = parsed;
  }

  let password: string;
  let generated = false;
  if (flags.get('stdin-password') === true) {
    password = await readStdin();
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `Password too short: ${password.length} characters, minimum ${MIN_PASSWORD_LENGTH}`,
      );
    }
  } else {
    password = generateStrongPassword();
    generated = true;
  }

  await upsertBreakGlassAccount(
    {
      username,
      displayName,
      passwordHash: hashPassword(password),
      expiresAt,
    },
    client,
  );

  console.log(`✅ Break-glass account "${username.toLowerCase()}" saved (enabled, lockout cleared).`);
  if (expiresAt) {
    console.log(`   Expires: ${formatDate(expiresAt)} UTC`);
  } else {
    console.log('   Expires: never — consider --expires to time-box the account.');
  }
  if (generated) {
    console.log('');
    console.log('   Generated password (shown once, it is not recoverable):');
    console.log('');
    console.log(`     ${password}`);
    console.log('');
    console.log('   Store it in the password manager now, then clear your terminal.');
  }
}

async function cmdSimple(
  client: DbClient,
  command: 'enable' | 'disable' | 'unlock' | 'delete',
  username: string,
): Promise<void> {
  let changed: boolean;
  switch (command) {
    case 'enable':
      changed = await setBreakGlassEnabled(username, true, client);
      break;
    case 'disable':
      changed = await setBreakGlassEnabled(username, false, client);
      break;
    case 'unlock':
      changed = await unlockBreakGlassAccount(username, client);
      break;
    case 'delete':
      changed = await deleteBreakGlassAccount(username, client);
      break;
  }
  if (!changed) {
    throw new Error(`No break-glass account named "${username}"`);
  }
  console.log(`✅ Account "${username.toLowerCase()}": ${command} done.`);
}

const SIMPLE_COMMANDS = ['enable', 'disable', 'unlock', 'delete'] as const;
type SimpleCommand = (typeof SIMPLE_COMMANDS)[number];

function isSimpleCommand(value: string): value is SimpleCommand {
  return (SIMPLE_COMMANDS as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }

  // Validate the command line BEFORE opening a database connection, so an
  // unknown command or a missing username reports what is actually wrong
  // instead of whatever the connection attempt happens to fail with.
  const [username] = rest;
  if (command !== 'list') {
    if (!isSimpleCommand(command) && command !== 'set') {
      console.error(`❌ Unknown command "${command}"`);
      console.log(USAGE);
      process.exit(1);
    }
    if (!username) {
      console.error(
        command === 'set'
          ? '❌ Usage: set <username> --display "Name" [--expires YYYY-MM-DD] [--stdin-password]'
          : `❌ Usage: ${command} <username>`,
      );
      process.exit(1);
    }
  }

  if (!config.databaseUrl) {
    console.error('❌ DATABASE_URL is not set — point it at the guestportal database.');
    process.exit(1);
  }

  let client: DbClient | null = null;
  try {
    client = await createMigrationClient();

    if (command === 'list') {
      await cmdList(client);
    } else if (command === 'set') {
      await cmdSet(client, username, rest.slice(1));
    } else if (isSimpleCommand(command)) {
      await cmdSimple(client, command, username);
    } else {
      // Unreachable: the validation above exits on an unknown command.
      throw new Error(`Unhandled command "${command}"`);
    }

    await client.close();
    process.exit(0);
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    if (client) {
      await client.close().catch(() => { /* ignore close errors */ });
    }
    process.exit(1);
  }
}

main();
