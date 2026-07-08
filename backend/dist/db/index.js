/**
 * Database connection module.
 * Supports PostgreSQL only (via `pg`).
 *
 * Authentication:
 *   - If DATABASE_URL contains a password → used directly (local dev).
 *   - If DATABASE_URL has NO password → Entra ID token is obtained via
 *     DefaultAzureCredential (ACA managed identity, Azure CLI, etc.).
 *
 * The Entra ID token is refreshed every 45 minutes (tokens typically last 1h).
 * On connection/auth failure, the pool is recreated with a fresh token.
 */
import pg from 'pg';
import { DefaultAzureCredential } from '@azure/identity';
import { config } from '../config.js';
import { runMigrations } from './migrate.js';
import { runSeed } from './seed.js';
import { log } from '../logger.js';
const AZURE_SCOPE = 'https://ossrdbms.database.windows.net/.default';
const TOKEN_REFRESH_MS = 45 * 60 * 1000; // 45 minutes
/**
 * Parse a postgres:// DATABASE_URL into connection parameters and detect
 * whether password-based or Entra ID authentication should be used.
 */
function parseDatabaseUrl(url) {
    const parsed = new URL(url);
    return {
        host: parsed.hostname,
        port: Number(parsed.port) || 5432,
        database: parsed.pathname.replace(/^\//, ''),
        user: decodeURIComponent(parsed.username),
        password: parsed.password ? decodeURIComponent(parsed.password) : null,
    };
}
let _pool = null;
let _client = null;
let _tokenRefreshTimer = null;
/**
 * Obtain an Entra ID access token for PostgreSQL using DefaultAzureCredential.
 */
async function getEntraToken() {
    const credential = new DefaultAzureCredential();
    const response = await credential.getToken(AZURE_SCOPE);
    // AccessToken interface: { token: string, expiresOnTimestamp: number }
    return response.token;
}
/**
 * Create a pg.Pool, resolving the password either from the URL or
 * via Entra ID token.
 */
async function createPool() {
    const conn = parseDatabaseUrl(config.databaseUrl);
    let password;
    if (conn.password) {
        // Password-based authentication (local dev)
        password = conn.password;
    }
    else {
        // Entra ID token authentication (ACA / managed identity)
        log.info('DATABASE_URL has no password — obtaining Entra ID token for PostgreSQL...');
        try {
            password = await getEntraToken();
        }
        catch (err) {
            log.error({ err: err.message }, 'Failed to obtain Entra ID token for DB');
            throw new Error(`Entra ID token acquisition failed: ${err.message}`);
        }
    }
    const pool = new pg.Pool({
        host: conn.host,
        port: conn.port,
        database: conn.database,
        user: conn.user,
        password,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        // ACA requires SSL
        ssl: { rejectUnauthorized: false },
    });
    // Log pool errors (e.g., idle connection dropped by PG)
    pool.on('error', (err) => {
        log.error({ err: err.message }, 'Unexpected PostgreSQL pool error');
    });
    return pool;
}
/**
 * Handle authentication failures by refreshing the Entra ID token
 * and replacing the pool. Call this when you get an auth error.
 */
async function refreshTokenAndPool() {
    log.info('Refreshing Entra ID token and recreating DB pool...');
    try {
        const newPool = await createPool();
        // Drain old pool
        if (_pool) {
            await _pool.end().catch(() => { });
        }
        _pool = newPool;
        log.info('DB pool recreated with fresh token');
    }
    catch (err) {
        log.error({ err: err.message }, 'Failed to refresh DB pool');
    }
}
/**
 * Build a DB client backed by the pg.Pool.
 */
function buildClient(pool) {
    return {
        driver: 'postgres',
        query: async (text, params) => {
            try {
                const sql = toDriverSql(text, 'postgres');
                const res = await pool.query(sql, (params ?? []));
                return { rows: res.rows, rowCount: res.rowCount ?? 0 };
            }
            catch (err) {
                // Detect authentication failure — refresh token and retry once
                const msg = err.message;
                if (/password authentication failed|no pg_hba.conf entry|could not connect/i.test(msg)) {
                    log.warn({ err: msg }, 'Auth error — refreshing token and retrying query');
                    await refreshTokenAndPool();
                    // Retry with new pool
                    const sql = toDriverSql(text, 'postgres');
                    const res = await _pool.query(sql, (params ?? []));
                    return { rows: res.rows, rowCount: res.rowCount ?? 0 };
                }
                throw err;
            }
        },
        exec: async (text) => {
            try {
                await pool.query(text);
            }
            catch (err) {
                const msg = err.message;
                if (/password authentication failed|no pg_hba.conf entry|could not connect/i.test(msg)) {
                    log.warn({ err: msg }, 'Auth error — refreshing token and retrying exec');
                    await refreshTokenAndPool();
                    await _pool.query(text);
                    return;
                }
                throw err;
            }
        },
        close: async () => {
            if (_tokenRefreshTimer) {
                clearInterval(_tokenRefreshTimer);
                _tokenRefreshTimer = null;
            }
            await pool.end();
        },
    };
}
export async function getDb() {
    if (!_client) {
        _pool = await createPool();
        _client = buildClient(_pool);
        // Periodically refresh the Entra ID token (if using token auth)
        const conn = parseDatabaseUrl(config.databaseUrl);
        if (!conn.password) {
            _tokenRefreshTimer = setInterval(async () => {
                await refreshTokenAndPool();
            }, TOKEN_REFRESH_MS);
        }
        // Run migrations and seed on startup
        await runMigrations(_client);
        await runSeed(_client);
    }
    return _client;
}
/**
 * Translate `?` placeholders into `$1, $2, ...` for the pg driver.
 * Walks the string while tracking single-quoted string literals (with
 * `''` escape) so that a literal `?` inside a string is not rewritten.
 */
export function toDriverSql(sql, driver) {
    if (driver !== 'postgres')
        return sql;
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
                }
                else {
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
//# sourceMappingURL=index.js.map