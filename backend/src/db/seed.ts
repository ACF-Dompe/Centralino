/**
 * Reference data: the 5 Dompe sedi with their WLC connection defaults, plus
 * the dormant SMS config row.
 *
 * Despite living under the "seed" name this is master data, NOT demo data: the
 * sedi are the real locations, no guests are created, and the application is
 * unusable without them (the sede selector is the first screen after sign-in,
 * and there is no API to create a sede). A production database therefore needs
 * this to have run once — see the CLI entrypoint below, which is the supported
 * way to do it rather than toggling SEED_ENABLED on a running app.
 *
 * CREDENTIAL NOTICE:
 *   REAL credentials (WLC admin passwords, SMTP passwords) were previously
 *   hardcoded here and have been REMOVED for security. These credentials
 *   must be set by the operator through the WLC login flow in the UI.
 *   See: https://github.com/{owner}/centralino/security/advisories
 */
import type { DbClient } from './index.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

interface SedeSeed {
  code: string;
  name: string;
  city: string;
  address: string;
  wlc: { host: string; sshPort: number; username: string; wlanSsid: string };
}

/**
 * Sede (location) data with WLC connection defaults.
 * The WLC PASSWORD is NOT part of the DB/seed (§2): it lives in Key Vault
 * and is injected as WLC_PASSWORD_<CODE>. These are infrastructure defaults
 * (host/IPs/SSID) that are NOT secrets and are safe to keep in source.
 */
const SEDI: SedeSeed[] = [
  {
    code: 'MIL',
    name: 'Dompe Milano HQ',
    city: 'Milano',
    address: 'Via Santa Lucia 6, 20122 Milano (MI)',
    wlc: { host: '172.18.106.100', sshPort: 22, username: 'admin_guest', wlanSsid: 'Dompe Guest' },
  },
  {
    code: 'AQ',
    name: "Dompe L'Aquila",
    city: "L'Aquila",
    address: 'Via Campo di Pile s.n.c., 67100 L\'Aquila (AQ)',
    wlc: { host: '172.18.106.101', sshPort: 22, username: 'admin_guest', wlanSsid: 'Dompe Guest AQ' },
  },
  {
    code: 'NA',
    name: 'Dompe Napoli',
    city: 'Napoli',
    address: 'Via Tommaso De Amicis 95, 80131 Napoli (NA)',
    wlc: { host: '172.18.106.102', sshPort: 22, username: 'admin_guest', wlanSsid: 'Dompe Guest NA' },
  },
  {
    code: 'TIR',
    name: 'Dompe Tirana',
    city: 'Tirana',
    address: 'Arena Center, Hyrja D, Kati 6, Sheshi Italia, Tirana, Albania',
    wlc: { host: '172.18.106.103', sshPort: 22, username: 'admin_guest', wlanSsid: 'Dompe Guest TIR' },
  },
  {
    code: 'SM',
    name: 'Dompe San Mateo',
    city: 'San Mateo',
    address: '400 S El Camino Real, Suite 400, San Mateo, CA 94402, USA',
    wlc: { host: '172.18.106.104', sshPort: 22, username: 'admin_guest', wlanSsid: 'Dompe Guest SM' },
  },
];

export async function runSeed(client: DbClient): Promise<void> {
  // --- Sedi, with their WLC parameters ---
  //
  // INSERT ONLY. This used to UPDATE name, city and address for every known
  // site on each run, which was harmless while those values only existed in
  // source — but they are editable from the admin panel now, so re-applying
  // them would quietly revert an administrator's change on the next restart.
  // Correcting master data is an admin-panel job; the seed exists to make a
  // fresh database usable.
  for (const s of SEDI) {
    const existing = await client.query(`SELECT id FROM sedi WHERE code = ?`, [s.code]);
    if (existing.rows.length > 0) continue;

    await client.query(
      `INSERT INTO sedi
         (code, name, city, address, wlc_host, wlc_port, wlc_ssh_port, wlc_username, wlc_ssid, active)
       VALUES (?, ?, ?, ?, ?, 443, ?, ?, ?, TRUE)`,
      [s.code, s.name, s.city, s.address, s.wlc.host, s.wlc.sshPort, s.wlc.username, s.wlc.wlanSsid],
    );
  }

  // Email/SMTP config seed removed (§3): mail is Graph-only, sender is
  // MAIL_GRAPH_FROM_ADDRESS; there is no email_config table.

  // --- Global SMS config ---
  const smsCount = await client.query(`SELECT COUNT(*) as c FROM sms_config`);
  if (Number((smsCount.rows[0] as { c: number }).c) === 0) {
    await client.query(
      // No gateway_type: the SMS feature is dormant and naming a public
      // provider here would plant it in the database (compliance 3.4).
      `INSERT INTO sms_config (id, gateway_type, api_key, sender_id, webhook_url)
       VALUES (1, NULL, '', 'DompeGuest', '')`,
    );
  }
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────
// Populate the reference data of an existing database:
//
//   node backend/dist/db/seed.js
//
// This is the supported way to provision a production database. The
// alternative — flipping SEED_ENABLED on a running app — needs two revisions,
// and leaving it on makes every restart overwrite each sede's name, city and
// address with the values hardcoded above, silently undoing later edits.
//
// Idempotent: sedi are matched by `code`, so re-running updates instead of
// duplicating. Exits 0 on success, 1 on failure.
//
// Authentication mirrors the migration CLI: the password from DATABASE_URL when
// present, otherwise an Entra ID token via DefaultAzureCredential.

async function main(): Promise<void> {
  console.log('Seed CLI — connecting to database...');
  // The client is created INSIDE the try so that connection/token-acquisition
  // failures also produce a clean message and exit code 1.
  let client: DbClient | null = null;
  try {
    const { createMigrationClient } = await import('./migrate.js');
    client = await createMigrationClient();
    await runSeed(client);
    console.log('✅ Reference data seeded successfully');
    await client.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', (err as Error).message);
    if (client) {
      await client.close().catch(() => { /* ignore close errors */ });
    }
    process.exit(1);
  }
}

// Detect direct execution (not import). Mirrors db/migrate.ts.
const __filename = fileURLToPath(import.meta.url);
const entryArg = process.argv[1];
if (entryArg) {
  const resolvedEntry = path.resolve(entryArg);
  if (resolvedEntry === __filename || resolvedEntry.endsWith(path.sep + 'seed.js')) {
    main();
  }
}
