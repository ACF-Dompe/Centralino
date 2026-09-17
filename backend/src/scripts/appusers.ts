/**
 * Application user directory CLI.
 *
 * The admin panel is the normal way to profile users. This exists for the one
 * situation the panel cannot help with: a fresh deployment, or a directory
 * where every remaining admin has been suspended. Every SSO user is created
 * blocked, so without a way in from outside the web surface there would be
 * nobody able to unblock anybody.
 *
 * It is a safer bootstrap than the alternative. Reaching the admin panel
 * without an admin means signing in through break-glass, which bypasses Entra
 * and MFA and has to be exposed to a network to be usable at all; running this
 * needs shell access to the container and nothing published.
 *
 * Usage locally (from the repository root, no build needed):
 *
 *   make appusers ARGS="list"
 *   make appusers ARGS="list --status pending"
 *   make appusers ARGS="show mario.rossi@dompe.com"
 *   make appusers ARGS="grant mario.rossi@dompe.com --role admin --sedi MIL,AQ"
 *   make appusers ARGS="suspend mario.rossi@dompe.com"
 *   make appusers ARGS="activate mario.rossi@dompe.com"
 *
 * In production, run it inside the backend container so it inherits the UAMI
 * and its Entra token for PostgreSQL:
 *
 *   az containerapp exec -n <backend-app> -g <rg> \
 *     --command "node backend/dist/scripts/appusers.js list --status pending"
 *
 * Commands: list | show | grant | suspend | activate | delete
 */
import { createMigrationClient } from '../db/migrate.js';
import type { DbClient } from '../db/index.js';
import { isRole, type Role, type UserStatus } from '../auth/authorization.js';
import {
  listAppUsers,
  getAppUserBySubject,
  updateAppUserProfile,
  replaceAppUserSedi,
  countActiveAdmins,
  deleteAppUser,
  type AppUserRecord,
} from '../repositories/appUsers.js';

const ACTOR = 'cli';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next != null && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, positional, flags };
}

/**
 * Find a user by whatever the operator is likely to have in front of them.
 *
 * The stored key is an Entra objectId or an `email:` marker, neither of which
 * anybody types from memory, so a plain mail address is accepted and tried in
 * both forms.
 */
async function findUser(needle: string, client: DbClient): Promise<AppUserRecord | null> {
  const direct = await getAppUserBySubject(needle, client);
  if (direct) return direct;

  const asEmail = await getAppUserBySubject(`email:${needle.trim().toLowerCase()}`, client);
  if (asEmail) return asEmail;

  const matches = await listAppUsers({ search: needle }, client);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    process.stderr.write(
      `Più utenti corrispondono a "${needle}":\n` +
        matches.map((m) => `  ${m.subject}  ${m.email ?? '-'}  ${m.displayName}\n`).join('') +
        'Ripeti il comando indicando il subject esatto.\n',
    );
    process.exit(2);
  }
  return null;
}

/** Resolve site codes to ids, refusing anything that does not exist. */
async function resolveSedeCodes(csv: string, client: DbClient): Promise<number[]> {
  const codes = csv
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c.length > 0);
  if (codes.length === 0) return [];

  const res = await client.query(
    `SELECT id, code FROM sedi WHERE UPPER(code) = ANY($1::text[])`,
    [codes],
  );
  const rows = res.rows as Array<{ id: number; code: string }>;
  const found = new Set(rows.map((r) => r.code.toUpperCase()));
  const missing = codes.filter((c) => !found.has(c));
  if (missing.length > 0) {
    process.stderr.write(`Sedi inesistenti: ${missing.join(', ')}\n`);
    process.exit(2);
  }
  return rows.map((r) => Number(r.id));
}

function formatRow(u: AppUserRecord, sedeCodes: Map<number, string>): string {
  const sites = u.sedeIds.length > 0
    ? u.sedeIds.map((id) => sedeCodes.get(id) ?? String(id)).join(',')
    : '-';
  const last = u.lastLoginAt ? u.lastLoginAt.toISOString().slice(0, 16).replace('T', ' ') : '-';
  return [
    u.status.padEnd(10),
    u.role.padEnd(9),
    (u.email ?? '-').padEnd(34),
    sites.padEnd(16),
    last,
    u.displayName,
  ].join('  ');
}

async function sedeCodeMap(client: DbClient): Promise<Map<number, string>> {
  const res = await client.query(`SELECT id, code FROM sedi`);
  return new Map((res.rows as Array<{ id: number; code: string }>).map((r) => [Number(r.id), r.code]));
}

function usage(): void {
  process.stdout.write(
    `Uso: appusers <comando> [argomenti]

  list [--status pending|active|suspended] [--search <testo>]
  show <email|subject>
  grant <email|subject> --role admin|operator|viewer [--sedi MIL,AQ]
  suspend <email|subject>
  activate <email|subject>
  delete <email|subject>

Un utente compare in elenco dopo il suo primo login SSO, in stato "pending".
`,
  );
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (command === 'help' || flags.help) {
    usage();
    return;
  }

  const client = await createMigrationClient();
  try {
    switch (command) {
      case 'list': {
        const status = typeof flags.status === 'string' ? (flags.status as UserStatus) : undefined;
        const search = typeof flags.search === 'string' ? flags.search : undefined;
        const users = await listAppUsers({ status, search }, client);
        const codes = await sedeCodeMap(client);
        if (users.length === 0) {
          process.stdout.write('Nessun utente in anagrafica.\n');
          break;
        }
        process.stdout.write(
          ['STATO'.padEnd(10), 'RUOLO'.padEnd(9), 'EMAIL'.padEnd(34), 'SEDI'.padEnd(16), 'ULTIMO ACCESSO', 'NOME'].join('  ') + '\n',
        );
        for (const u of users) process.stdout.write(formatRow(u, codes) + '\n');
        break;
      }

      case 'show': {
        const user = await findUser(positional[0] ?? '', client);
        if (!user) {
          process.stderr.write('Utente non trovato.\n');
          process.exit(1);
        }
        const codes = await sedeCodeMap(client);
        process.stdout.write(
          `subject:       ${user.subject}\n` +
          `email:         ${user.email ?? '-'}\n` +
          `nome:          ${user.displayName}\n` +
          `objectId:      ${user.entraObjectId ?? '-'}\n` +
          `ruolo:         ${user.role}\n` +
          `stato:         ${user.status}\n` +
          `sedi:          ${user.sedeIds.map((id) => codes.get(id) ?? id).join(', ') || '-'}\n` +
          `creato:        ${user.createdAt.toISOString()}\n` +
          `ultimo login:  ${user.lastLoginAt?.toISOString() ?? '-'}\n` +
          `profilato da:  ${user.profiledBy ?? '-'}${user.profiledAt ? ` (${user.profiledAt.toISOString()})` : ''}\n`,
        );
        break;
      }

      case 'grant': {
        const user = await findUser(positional[0] ?? '', client);
        if (!user) {
          process.stderr.write('Utente non trovato. Deve prima effettuare un login SSO.\n');
          process.exit(1);
        }
        const role = flags.role;
        if (typeof role !== 'string' || !isRole(role)) {
          process.stderr.write('--role è obbligatorio e deve essere admin, operator o viewer.\n');
          process.exit(2);
        }
        if (typeof flags.sedi === 'string') {
          await replaceAppUserSedi(user.id, await resolveSedeCodes(flags.sedi, client), client);
        }
        const updated = await updateAppUserProfile(
          user.id,
          { role: role as Role, status: 'active', profiledBy: ACTOR },
          client,
        );
        process.stdout.write(
          `${user.email ?? user.subject}: ruolo ${updated?.role}, stato ${updated?.status}.\n` +
          'Ha effetto entro il TTL della cache di autorizzazione (RBAC_CACHE_TTL_SECONDS).\n',
        );
        break;
      }

      case 'suspend': {
        const user = await findUser(positional[0] ?? '', client);
        if (!user) {
          process.stderr.write('Utente non trovato.\n');
          process.exit(1);
        }
        // The same guard the API applies: a directory with no active admin is
        // one nobody can administer, and this tool is the way back from that.
        if (user.role === 'admin' && user.status === 'active' && (await countActiveAdmins(user.id, client)) === 0) {
          process.stderr.write('È l\'ultimo amministratore attivo: promuovi qualcun altro prima di sospenderlo.\n');
          process.exit(2);
        }
        await updateAppUserProfile(user.id, { status: 'suspended', profiledBy: ACTOR }, client);
        process.stdout.write(`${user.email ?? user.subject}: sospeso.\n`);
        break;
      }

      case 'activate': {
        const user = await findUser(positional[0] ?? '', client);
        if (!user) {
          process.stderr.write('Utente non trovato.\n');
          process.exit(1);
        }
        await updateAppUserProfile(user.id, { status: 'active', profiledBy: ACTOR }, client);
        process.stdout.write(`${user.email ?? user.subject}: attivo (ruolo ${user.role}).\n`);
        break;
      }

      case 'delete': {
        const user = await findUser(positional[0] ?? '', client);
        if (!user) {
          process.stderr.write('Utente non trovato.\n');
          process.exit(1);
        }
        if (user.role === 'admin' && user.status === 'active' && (await countActiveAdmins(user.id, client)) === 0) {
          process.stderr.write('È l\'ultimo amministratore attivo.\n');
          process.exit(2);
        }
        await deleteAppUser(user.id, client);
        process.stdout.write(
          `${user.email ?? user.subject}: eliminato. Al prossimo login verrà ricreato in stato pending.\n`,
        );
        break;
      }

      default:
        process.stderr.write(`Comando sconosciuto: ${command}\n\n`);
        usage();
        process.exit(2);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
