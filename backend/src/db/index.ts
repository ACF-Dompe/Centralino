/**
 * Database connection module.
 * Supports PostgreSQL only (via `pg`).
 *
 * Authentication:
 *   - If DATABASE_URL contains a password → used directly (local dev).
 *   - If DATABASE_URL has NO password → Entra ID token is obtained via
 *     DefaultAzureCredential (ACA managed identity, Azure CLI, etc.).
 *
 * Token lifecycle: the token is NOT acquired once and held as a static
 * password. `pg` accepts `password` as an async function and invokes it for
 * every new physical connection, so each connection authenticates with a
 * currently-valid token. Combined with a connection lifetime shorter than the
 * token TTL (guidelines §6), the pool is created once and never recreated.
 *
 * This replaces the previous design (periodic pool recreation on a 45-minute
 * timer), which swapped the module-level pool while the DbClient still held the
 * old one in a closure — after the first refresh every query failed with
 * "Cannot use a pool after calling end on the pool", permanently.
 */
import pg from 'pg';
import { DefaultAzureCredential } from '@azure/identity';
import { config, AZURE_DB_SCOPE } from '../config.js';
import { runMigrations } from './migrate.js';
import { runSeed } from './seed.js';
import { log } from '../logger.js';

const AZURE_SCOPE = AZURE_DB_SCOPE;

export type DbDriver = 'postgres';

export interface DbClient {
  driver: DbDriver;
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
  exec: (text: string) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Parse a postgres:// DATABASE_URL into connection parameters and detect
 * whether password-based or Entra ID authentication should be used.
 */
function parseDatabaseUrl(url: string): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | null; // null = use Entra ID token
} {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 5432,
    database: parsed.pathname.replace(/^\//, ''),
    user: decodeURIComponent(parsed.username),
    password: parsed.password ? decodeURIComponent(parsed.password) : null,
  };
}

let _pool: pg.Pool | null = null;
let _client: DbClient | null = null;

/**
 * Idle connections are recycled well inside the token validity window.
 * Guidelines §6: the connection lifecycle must be shorter than the token TTL.
 */
const IDLE_TIMEOUT_MS = 30_000;

/**
 * Hard cap on the lifetime of a physical connection (pg >= 8.11 / pg-pool >= 3.6).
 *
 * `idleTimeoutMillis` alone is not sufficient: a connection that stays busy is
 * never idle and could therefore outlive its Entra token (~60 min), after which
 * PostgreSQL rejects it. 30 minutes is comfortably below the ~3600s TTL, so
 * every connection is retired and re-authenticated with a fresh token long
 * before the token it was opened with expires.
 */
const MAX_CONNECTION_LIFETIME_SECONDS = 1_800;

/**
 * The credential is created ONCE and reused.
 *
 * The password callback below runs on every new physical connection, so a new
 * credential per call would defeat the SDK's internal token cache (and issue a
 * managed-identity HTTP request per connection). `DefaultAzureCredential`
 * caches tokens internally and only round-trips when the cached token is close
 * to expiry.
 */
let _credential: DefaultAzureCredential | null = null;

function getCredential(): DefaultAzureCredential {
  if (!_credential) {
    _credential = new DefaultAzureCredential();
  }
  return _credential;
}

/**
 * Obtain an Entra ID access token for PostgreSQL.
 *
 * Passed to `pg` as the `password` callback, so it is invoked for EVERY new
 * physical connection — each one authenticates with a currently-valid token.
 * This is what makes periodic pool recreation unnecessary.
 */
async function getEntraToken(): Promise<string> {
  let response;
  try {
    response = await getCredential().getToken(AZURE_SCOPE);
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Failed to obtain Entra ID token for DB');
    throw new Error(`Entra ID token acquisition failed: ${(err as Error).message}`);
  }
  // AccessToken: { token: string, expiresOnTimestamp: number }
  if (!response?.token) {
    throw new Error(`Entra ID token acquisition failed: no token returned for scope ${AZURE_SCOPE}`);
  }
  // Never log the token itself — the expiry timestamp is safe and useful.
  log.info(
    { expiresOn: new Date(response.expiresOnTimestamp).toISOString() },
    'Entra ID token acquired for PostgreSQL connection',
  );
  return response.token;
}

/**
 * Create a pg.Pool against DATABASE_URL, with TLS and authentication resolved
 * the same way for every caller.
 *
 * This is exported because it is the SINGLE place that knows how to reach the
 * database. Anything that needs its own pool — the session store, for one —
 * must go through here rather than handing a connection string to a library:
 * with Entra authentication the URL carries no password, and ACA's PostgreSQL
 * rejects unencrypted connections, so a bare `conString` produces
 * "no pg_hba.conf entry ... no encryption" and then an auth failure.
 *
 * Authentication:
 *   - DATABASE_URL contains a password → static string (local dev).
 *   - DATABASE_URL has NO password → `password` is set to the async token
 *     getter FUNCTION (not its result). `pg` calls it per new connection, so
 *     the pool never has to be closed and recreated to pick up a fresh token.
 *
 * @param overrides - per-caller pool tuning (e.g. a smaller `max`).
 */
export function createDbPool(overrides: Partial<pg.PoolConfig> = {}): pg.Pool {
  const conn = parseDatabaseUrl(config.databaseUrl);

  if (!conn.password) {
    log.info('DATABASE_URL has no password — using Entra ID token authentication for PostgreSQL');
  }

  const pool = new pg.Pool({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    // Pass the FUNCTION for Entra mode: pg awaits it on every new connection.
    password: conn.password ?? getEntraToken,
    max: 10,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    maxLifetimeSeconds: MAX_CONNECTION_LIFETIME_SECONDS,
    connectionTimeoutMillis: 10_000,
    // ACA requires SSL; bare Docker containers (e2e CI) do not.
    // When SSL is on, the server certificate is validated against the system
    // trust store unless DB_SSL_REJECT_UNAUTHORIZED=false (local self-signed).
    ssl: config.db.sslEnabled ? { rejectUnauthorized: config.db.sslRejectUnauthorized } : false,
    ...overrides,
  });

  // An error on an IDLE client must never take down the process.
  pool.on('error', (err) => {
    log.error({ err: err.message }, 'Unexpected PostgreSQL pool error');
  });

  return pool;
}

/**
 * Return the live pool.
 *
 * The client NEVER captures a pool in a closure: it resolves the current pool
 * on every call. With the per-connection token callback the pool is no longer
 * recreated, so this is defence-in-depth — it makes the
 * "Cannot use a pool after calling end on the pool" class of bug structurally
 * impossible even if pool replacement is ever reintroduced.
 */
function getPool(): pg.Pool {
  if (!_pool) {
    throw new Error('DB pool is not initialised — call getDb() first');
  }
  return _pool;
}

/**
 * Build a DB client backed by the current pg.Pool.
 *
 * No token-expiry retry logic is needed any more: `pg` resolves a fresh token
 * for every new physical connection, and connections are retired before their
 * token can expire (see MAX_CONNECTION_LIFETIME_SECONDS). Errors therefore
 * propagate to the caller instead of being masked by a pool rebuild.
 */
function buildClient(): DbClient {
  return {
    driver: 'postgres',

    query: async (text, params) => {
      const sql = toDriverSql(text, 'postgres');
      const res = await getPool().query(sql, (params ?? []) as never[]);
      return { rows: res.rows, rowCount: res.rowCount ?? 0 };
    },

    exec: async (text) => {
      await getPool().query(text);
    },

    close: async () => {
      const pool = _pool;
      _pool = null;
      _client = null;
      if (pool) {
        await pool.end();
      }
    },
  };
}

export async function getDb(): Promise<DbClient> {
  if (!_client) {
    _pool = createDbPool();
    _client = buildClient();

    // Run migrations on startup — controlled by SKIP_MIGRATIONS env var.
    // Guidelines §6/§8: migrations are a CI step, not run at app startup.
    // Set SKIP_MIGRATIONS=true in production CI-deployed environments;
    // keep default (false) for local dev where there's no CI migration step.
    if (!config.db.skipMigrations) {
      await runMigrations(_client);
      log.info('Migrations completed (startup)');
    } else {
      log.info('Skipping migrations at startup (SKIP_MIGRATIONS=true)');
    }

    // Seed on startup — controlled by SEED_ENABLED env var.
    // Guidelines §11: seed is Development-only.
    if (config.db.seedEnabled) {
      await runSeed(_client);
      log.info('Seed completed (startup)');
    } else {
      log.info('Skipping seed at startup (SEED_ENABLED=false)');
    }
  }
  return _client;
}

/**
 * Translate `?` placeholders into `$1, $2, ...` for the pg driver.
 * Walks the string while tracking single-quoted string literals (with
 * `''` escape) so that a literal `?` inside a string is not rewritten.
 */
export function toDriverSql(sql: string, driver: DbDriver): string {
  if (driver !== 'postgres') return sql;
  let out = '';
  let i = 0;
  let inString = false;
  for (let j = 0; j < sql.length; j++) {
    const ch = sql[j];
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (sql[j + 1] === "'") {
          out += sql[j + 1];
          j += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '?') {
      i += 1;
      out += `$${i}`;
      continue;
    }
    out += ch;
  }
  return out;
}
