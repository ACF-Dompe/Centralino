/**
 * Schema migration (PostgreSQL only).
 * Idempotent: creates tables/indexes if they do not exist.
 *
 * CLI entrypoint:
 *   node backend/dist/db/migrate.js
 *
 * Connects to DATABASE_URL, runs all pending migrations,
 * and exits with code 0 on success, 1 on failure.
 *
 * Authentication: password from DATABASE_URL when present (local dev),
 * otherwise an Entra ID access token via DefaultAzureCredential — the
 * production case on Azure PostgreSQL, where the DB login is the backend UAMI.
 */
import type { DbClient } from './index.js';
import { log } from '../logger.js';
import { ensureBreakGlassBootstrapAccount } from './bootstrapBreakGlass.js';
import { config, AZURE_DB_SCOPE } from '../config.js';
import { DefaultAzureCredential } from '@azure/identity';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS guests (
  id              VARCHAR(36) PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  email           VARCHAR(255),
  phone           VARCHAR(50),
  company         VARCHAR(255) DEFAULT 'Ospite Individuale',
  host            VARCHAR(255) NOT NULL,
  username        VARCHAR(100) NOT NULL UNIQUE,
  -- Guest password is one-time and NEVER persisted (generated in RAM, pushed to
  -- the WLC and emailed) — no password column.
  duration_minutes INTEGER NOT NULL DEFAULT 240,
  elapsed_seconds INTEGER NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  enabled_at      TIMESTAMP,
  remarks         TEXT,
  sede_id         INTEGER,
  CHECK (status IN ('pending','active','expired','deactivated'))
);
CREATE INDEX IF NOT EXISTS idx_guests_status ON guests(status);
CREATE INDEX IF NOT EXISTS idx_guests_created_at ON guests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guests_sede_id ON guests(sede_id);

CREATE TABLE IF NOT EXISTS sedi (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(20) UNIQUE NOT NULL,
  name            VARCHAR(100) NOT NULL,
  city            VARCHAR(100) NOT NULL,
  address         VARCHAR(255),
  wlc_config_id   INTEGER,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sedi_code ON sedi(code);

-- The WLC parameters used to live in their own 1:1 table, linked from both
-- sides (sedi.wlc_config_id and wlc_config.sede_id). The two links could
-- disagree, which is why every read carried an OR-fallback and the uniqueness
-- of the binding was only "best-effort". Folding the columns into sedi
-- removes the class of bug: one row per site, no orphans, no fallback.
-- wlc_config is still written for now and dropped in a later release.
-- wlc_host stays nullable on purpose: it means "site created, WLC not
-- configured yet", which is a legitimate state the admin panel can show.
ALTER TABLE sedi ADD COLUMN IF NOT EXISTS wlc_host VARCHAR(255);
ALTER TABLE sedi ADD COLUMN IF NOT EXISTS wlc_port INTEGER NOT NULL DEFAULT 443;
ALTER TABLE sedi ADD COLUMN IF NOT EXISTS wlc_ssh_port INTEGER NOT NULL DEFAULT 22;
ALTER TABLE sedi ADD COLUMN IF NOT EXISTS wlc_username VARCHAR(100) NOT NULL DEFAULT 'admin_guest';
ALTER TABLE sedi ADD COLUMN IF NOT EXISTS wlc_ssid VARCHAR(100) NOT NULL DEFAULT 'Dompe Guest';
ALTER TABLE sedi ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE sedi ADD COLUMN IF NOT EXISTS wlc_last_check_at TIMESTAMP;
ALTER TABLE sedi ADD COLUMN IF NOT EXISTS wlc_last_check_ok BOOLEAN;
ALTER TABLE sedi ADD COLUMN IF NOT EXISTS wlc_last_check_error TEXT;
ALTER TABLE sedi ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
ALTER TABLE sedi ADD COLUMN IF NOT EXISTS updated_by VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_sedi_active ON sedi(active);

-- Application user directory, filled just-in-time from Entra at the first
-- successful SSO login (routes/auth.ts, POST /callback) and then profiled by an
-- admin. A new row is ALWAYS 'pending'/'viewer': until somebody profiles it the
-- user can authenticate but not act, and that is enforced at the API, not in
-- the UI.
--
-- subject is the stable natural key: the Entra objectId when the tenant
-- releases it (it survives a mail change), otherwise 'email:<lower(email)>'.
-- Neither one works alone — objectId can be absent, and mail addresses change.
CREATE TABLE IF NOT EXISTS app_users (
  id               BIGSERIAL PRIMARY KEY,
  subject          VARCHAR(255) NOT NULL UNIQUE,
  entra_object_id  VARCHAR(64),
  email            VARCHAR(255),
  display_name     VARCHAR(255) NOT NULL DEFAULT '',
  given_name       VARCHAR(255),
  surname          VARCHAR(255),
  role             VARCHAR(20)  NOT NULL DEFAULT 'viewer',
  status           VARCHAR(20)  NOT NULL DEFAULT 'pending',
  created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  last_login_at    TIMESTAMP,
  profiled_at      TIMESTAMP,
  profiled_by      VARCHAR(255),
  CHECK (role   IN ('admin','operator','viewer')),
  CHECK (status IN ('pending','active','suspended'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_users_entra_object_id ON app_users(entra_object_id) WHERE entra_object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_users_email_lower ON app_users(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_app_users_status ON app_users(status);

-- Sites a user may connect to. A join table rather than an int[] column so the
-- foreign key can do its job: a deleted site disappears from every grant
-- instead of leaving a dangling id nothing can validate.
CREATE TABLE IF NOT EXISTS app_user_sedi (
  user_id    BIGINT  NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  sede_id    INTEGER NOT NULL REFERENCES sedi(id)      ON DELETE CASCADE,
  granted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, sede_id)
);
CREATE INDEX IF NOT EXISTS idx_app_user_sedi_sede_id ON app_user_sedi(sede_id);

-- WLC password is NOT stored in the DB (§2): it lives in Key Vault, injected
-- as WLC_PASSWORD_<CODE> env vars and resolved per-sede at runtime.
CREATE TABLE IF NOT EXISTS wlc_config (
  id              SERIAL PRIMARY KEY,
  host            VARCHAR(255) NOT NULL DEFAULT '172.18.106.100',
  port            INTEGER NOT NULL DEFAULT 443,
  ssh_port        INTEGER NOT NULL DEFAULT 22,
  username        VARCHAR(100) NOT NULL DEFAULT 'admin_guest',
  wlan_ssid       VARCHAR(100) NOT NULL DEFAULT 'Dompe Guest',
  authenticated   BOOLEAN NOT NULL DEFAULT FALSE,
  sede_id         INTEGER
);

CREATE TABLE IF NOT EXISTS sms_config (
  id              INTEGER PRIMARY KEY DEFAULT 1,
  gateway_type    VARCHAR(50),
  api_key         VARCHAR(255),
  sender_id       VARCHAR(11) DEFAULT 'DompeGuest',
  webhook_url     VARCHAR(500)
);

-- Break-glass local accounts, used only when Entra ID / SAML SSO is down.
-- Passwords are stored as scrypt hashes (auth/password.ts) — never plaintext.
-- Rows are created exclusively by the breakglass CLI, never over HTTP.
-- failed_attempts / locked_until live here (not in memory) so the lockout is
-- shared by every ACA replica.
CREATE TABLE IF NOT EXISTS breakglass_users (
  username        VARCHAR(100) PRIMARY KEY,
  display_name    VARCHAR(255) NOT NULL,
  password_hash   TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at      TIMESTAMP,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMP,
  last_login_at   TIMESTAMP,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Role of a break-glass account. CREATE TABLE IF NOT EXISTS does not touch a
-- table that already exists, so on a migrated database the column can only
-- arrive through this ALTER.
-- Default 'admin' because the break-glass account bootstraps the whole
-- directory: every SSO user starts blocked, so somebody has to be able to
-- profile the first ones. Validation lives in the repository, not in a CHECK —
-- there is no ADD CONSTRAINT IF NOT EXISTS to lean on.
ALTER TABLE breakglass_users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'admin';

-- Outstanding SAML AuthnRequest IDs, for InResponseTo replay validation.
-- Persisted rather than held in memory: node-saml default in-memory cache
-- cannot survive a container restart between the login redirect and the IdP
-- posting back, and cannot work across replicas at all (its own docs say so).
-- Rows are tiny and short-lived: one per login attempt, pruned past the
-- request-ID expiration window.
CREATE TABLE IF NOT EXISTS saml_request_ids (
  id              VARCHAR(255) PRIMARY KEY,
  value           TEXT NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saml_request_ids_created_at ON saml_request_ids(created_at);

CREATE TABLE IF NOT EXISTS sync_logs (
  id              SERIAL PRIMARY KEY,
  timestamp       TIMESTAMP NOT NULL DEFAULT NOW(),
  action          TEXT NOT NULL,
  method          VARCHAR(10) NOT NULL,
  url             TEXT,
  payload         TEXT,
  status_code     INTEGER
);
`;

export async function runMigrations(client: DbClient): Promise<void> {
  // Schema bootstrap (CREATE TABLE / CREATE INDEX)
  const statements = PG_SCHEMA
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    try {
      await client.exec(stmt);
    } catch (err) {
      throw new Error(`Migration statement failed: ${stmt.slice(0, 120)}...\n  ${(err as Error).message}`);
    }
  }

  // Partial unique index on wlc_config.sede_id (works on PostgreSQL 12+)
  // `NULLS NOT DISTINCT` (PG15+) would be ideal, but this approach is
  // compatible with all supported PostgreSQL versions.
  try {
    await client.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_wlc_config_sede_id ON wlc_config(sede_id) WHERE sede_id IS NOT NULL`,
    );
  } catch {
    // Best-effort; duplicate bindings prevented by application logic
  }

  await backfillSediWlcColumns(client);

  // The directory starts empty and every SSO user lands in it blocked, so the
  // deployment needs one account that can profile the others.
  try {
    await ensureBreakGlassBootstrapAccount(client);
  } catch (err) {
    // A failed bootstrap must not abort a deploy — the CLI can still create the
    // account. Making the failure loud is what counts.
    log.error(
      { err: (err as Error).message },
      'Bootstrap of the break-glass account failed — create it with `make breakglass` before enabling SSO',
    );
  }
}

/**
 * Copy the WLC parameters out of `wlc_config` and into `sedi`, once.
 *
 * `AND s.wlc_host IS NULL` is what makes this safe to leave in place. The
 * migration runner has no version table: it replays the whole schema on every
 * startup and on every migration job. Without the guard this UPDATE would run
 * again each time and quietly undo whatever an admin had just changed from the
 * panel — the same trap the seed documents for SEDE data.
 *
 * Matching on either side of the old double link (`wlc_config.sede_id` or
 * `sedi.wlc_config_id`) is deliberate: the two could disagree, and that
 * disagreement is precisely what this consolidation is retiring.
 */
async function backfillSediWlcColumns(client: DbClient): Promise<void> {
  try {
    await client.exec(
      `UPDATE sedi s
          SET wlc_host     = w.host,
              wlc_port     = w.port,
              wlc_ssh_port = w.ssh_port,
              wlc_username = w.username,
              wlc_ssid     = w.wlan_ssid
         FROM wlc_config w
        WHERE (w.sede_id = s.id OR w.id = s.wlc_config_id)
          AND s.wlc_host IS NULL`,
    );
  } catch (err) {
    // A failed backfill must not block a deploy: the columns exist either way,
    // and the admin panel can fill them in. Surfacing it is what matters.
    log.error(
      { err: (err as Error).message },
      'Backfill of the WLC columns on `sedi` failed — check the site parameters in the admin panel',
    );
  }
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────
// When executed directly (node backend/dist/db/migrate.js), creates a DB
// connection from DATABASE_URL and runs all pending migrations.
// Exits with code 0 on success, 1 on failure.

/**
 * Build a minimal DbClient directly from DATABASE_URL, bypassing getDb()
 * (which would also run migrations/seed based on config flags). The migration
 * job is an independent ACA job — it must connect and migrate on its own.
 *
 * Authentication (mirrors `db/index.ts`):
 *   - DATABASE_URL contains a password → used directly (local dev).
 *   - DATABASE_URL has NO password → an Entra ID access token is acquired via
 *     DefaultAzureCredential (ACA managed identity, Azure CLI, …) and used as
 *     the connection password. A single token is enough: the job is short-lived.
 */
export async function createMigrationClient(): Promise<DbClient> {
  // Guard before new URL(), whose "Invalid URL" says nothing useful. Shared by
  // the migration, seed and breakglass CLIs.
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set — point it at the guestportal database');
  }
  const parsed = new URL(config.databaseUrl);
  const urlPassword = parsed.password ? decodeURIComponent(parsed.password) : null;

  let password: string;
  if (urlPassword) {
    password = urlPassword;
  } else {
    console.log('DATABASE_URL has no password — obtaining Entra ID token for PostgreSQL...');
    try {
      const accessToken = await new DefaultAzureCredential().getToken(AZURE_DB_SCOPE);
      if (!accessToken?.token) {
        throw new Error('DefaultAzureCredential returned no token');
      }
      password = accessToken.token;
    } catch (err) {
      throw new Error(`Entra ID token acquisition failed: ${(err as Error).message}`);
    }
  }

  const pool = new pg.Pool({
    host: parsed.hostname,
    port: Number(parsed.port) || 5432,
    database: parsed.pathname.replace(/^\//, ''),
    user: decodeURIComponent(parsed.username),
    password,
    ssl: config.db.sslEnabled ? { rejectUnauthorized: config.db.sslRejectUnauthorized } : false,
    max: 1,
    connectionTimeoutMillis: 15_000,
  });

  return {
    driver: 'postgres',
    query: async (text, params) => {
      const res = await pool.query(text, (params ?? []) as never[]);
      return { rows: res.rows, rowCount: res.rowCount ?? 0 };
    },
    exec: async (text) => { await pool.query(text); },
    close: async () => { await pool.end(); },
  };
}

async function main(): Promise<void> {
  console.log('Migration CLI — connecting to database...');
  // The client is created INSIDE the try so that connection/token-acquisition
  // failures also produce the clean error message and exit code 1 (instead of
  // an unhandled rejection).
  let client: DbClient | null = null;
  try {
    client = await createMigrationClient();
    await runMigrations(client);
    console.log('✅ Migrations completed successfully');
    await client.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', (err as Error).message);
    if (client) {
      await client.close().catch(() => { /* ignore close errors */ });
    }
    process.exit(1);
  }
}

// Detect if this module is being executed directly (not imported)
const __filename = fileURLToPath(import.meta.url);
const entryArg = process.argv[1];
if (entryArg) {
  const resolvedEntry = path.resolve(entryArg);
  if (resolvedEntry === __filename || resolvedEntry.endsWith(path.sep + 'migrate.js')) {
    main();
  }
}
