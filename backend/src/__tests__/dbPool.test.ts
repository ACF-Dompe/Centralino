/**
 * Unit tests for the DB pool / Entra token lifecycle (`db/index.ts`).
 *
 * Regression under test: after the first token refresh, every query failed with
 * "Cannot use a pool after calling end on the pool" — the DbClient captured the
 * pool in a closure while the refresh timer replaced and ended it.
 *
 * The fix removes pool recreation entirely: `pg` receives `password` as an async
 * function and calls it for every new physical connection. These tests therefore
 * assert the properties that make the stale-pool bug impossible:
 *   - the pool is created ONCE and never replaced/ended while in use;
 *   - `password` reaches pg as a FUNCTION, so each connection re-authenticates;
 *   - the connection lifetime is capped below the token TTL;
 *   - the client resolves the live pool per call (never a captured one).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockConfigModule = vi.hoisted(() => ({
  config: {
    databaseUrl: '',
    db: {
      skipMigrations: true,
      seedEnabled: false,
      sslEnabled: true,
      sslRejectUnauthorized: true,
    },
  },
  AZURE_DB_SCOPE: 'https://ossrdbms-aad.database.windows.net/.default',
}));
vi.mock('../config.js', () => mockConfigModule);

/** Every constructed pool, in order, with the options it received. */
const pools = vi.hoisted(() => [] as Array<{
  options: Record<string, unknown>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  ended: boolean;
}>);

vi.mock('pg', () => ({
  default: {
    Pool: function PoolMock(options: Record<string, unknown>) {
      const self = {
        options,
        query: vi.fn(async () => ({ rows: [{ ok: 1 }], rowCount: 1 })),
        end: vi.fn(async () => { self.ended = true; }),
        on: vi.fn(),
        ended: false,
      };
      pools.push(self as never);
      return self;
    },
  },
}));

const mockGetToken = vi.hoisted(() => vi.fn());
const credentialCtorCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: function CredentialMock() {
    credentialCtorCalls.count += 1;
    return { getToken: mockGetToken };
  },
}));

vi.mock('../db/migrate.js', () => ({ runMigrations: vi.fn(), PG_SCHEMA: '' }));
vi.mock('../db/seed.js', () => ({ runSeed: vi.fn() }));
vi.mock('../logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

/** Fresh module registry per test so `getDb()`'s memoised state is reset. */
async function loadDb() {
  vi.resetModules();
  return import('../db/index.js');
}

const ENTRA_URL = 'postgres://uami-guestportal-backend-prod@psql.postgres.database.azure.com:5432/guestportal_prod';
const PASSWORD_URL = 'postgres://postgres:localpass@localhost:5432/guest_desk';

/** The `password` option pg received for the given pool. */
function passwordOption(i = 0): unknown {
  return pools[i].options.password;
}

describe('DB pool — Entra token lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pools.length = 0;
    credentialCtorCalls.count = 0;
    mockConfigModule.config.databaseUrl = ENTRA_URL;
    mockConfigModule.config.db.skipMigrations = true;
    mockConfigModule.config.db.seedEnabled = false;
    mockConfigModule.config.db.sslEnabled = true;
    mockConfigModule.config.db.sslRejectUnauthorized = true;
    mockGetToken.mockResolvedValue({ token: 'token-1', expiresOnTimestamp: Date.now() + 3_600_000 });
  });

  // ── The root-cause fix ───────────────────────────────────────────────────

  it('passes password to pg as a FUNCTION (not a pre-resolved token string)', async () => {
    const { getDb } = await loadDb();
    await getDb();

    expect(pools).toHaveLength(1);
    expect(typeof passwordOption()).toBe('function');
    // The old bug: a resolved string, fixed for the pool's whole lifetime.
    expect(typeof passwordOption()).not.toBe('string');
    // Acquiring a token must NOT happen at pool construction time.
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it('resolves a fresh token on every invocation (i.e. every new connection)', async () => {
    const { getDb } = await loadDb();
    await getDb();
    const getPassword = passwordOption() as () => Promise<string>;

    mockGetToken.mockResolvedValueOnce({ token: 'token-A', expiresOnTimestamp: Date.now() + 3_600_000 });
    await expect(getPassword()).resolves.toBe('token-A');

    // Simulates a connection opened later, after the first token would have expired.
    mockGetToken.mockResolvedValueOnce({ token: 'token-B', expiresOnTimestamp: Date.now() + 3_600_000 });
    await expect(getPassword()).resolves.toBe('token-B');

    expect(mockGetToken).toHaveBeenCalledTimes(2);
    expect(mockGetToken).toHaveBeenCalledWith(SCOPE);
  });

  it('never recreates or ends the pool (no refresh timer)', async () => {
    const { getDb } = await loadDb();
    const db = await getDb();

    // Repeated use over the lifetime of the process keeps the same pool.
    await db.query('SELECT 1');
    await db.exec('SELECT 1');
    await getDb();
    await db.query('SELECT 1');

    expect(pools).toHaveLength(1);
    expect(pools[0].end).not.toHaveBeenCalled();
    expect(pools[0].ended).toBe(false);
    expect(pools[0].query).toHaveBeenCalledTimes(3);
  });

  it('reuses a single credential instance across token acquisitions', async () => {
    const { getDb } = await loadDb();
    await getDb();
    const getPassword = passwordOption() as () => Promise<string>;

    await getPassword();
    await getPassword();
    await getPassword();

    // A credential per call would defeat the SDK's internal token cache.
    expect(credentialCtorCalls.count).toBe(1);
  });

  // ── Stale-pool regression guards ─────────────────────────────────────────

  it('the client resolves the live pool per call, never a captured one', async () => {
    const { getDb } = await loadDb();
    const db = await getDb();
    await db.query('SELECT 1');

    // Closing clears module state; a later query must fail with an explicit
    // message instead of hitting an ended pool ("Cannot use a pool after end").
    await db.close();
    expect(pools[0].end).toHaveBeenCalledOnce();

    await expect(db.query('SELECT 1')).rejects.toThrow(/not initialised/i);
    await expect(db.query('SELECT 1')).rejects.not.toThrow(/after calling end/i);
  });

  it('caps the connection lifetime below the ~3600s token TTL', async () => {
    const { getDb } = await loadDb();
    await getDb();

    const maxLifetime = pools[0].options.maxLifetimeSeconds as number;
    expect(maxLifetime).toBeGreaterThan(0);
    expect(maxLifetime).toBeLessThan(3_600);
    expect(pools[0].options.idleTimeoutMillis).toBeLessThan(3_600_000);
  });

  // ── Error handling ───────────────────────────────────────────────────────

  it('wraps a token acquisition failure with a clear message', async () => {
    const { getDb } = await loadDb();
    await getDb();
    const getPassword = passwordOption() as () => Promise<string>;

    mockGetToken.mockRejectedValueOnce(new Error('ManagedIdentityCredential unavailable'));
    await expect(getPassword()).rejects.toThrow(
      /Entra ID token acquisition failed: ManagedIdentityCredential unavailable/,
    );
  });

  it('throws naming the scope when the credential returns no token', async () => {
    const { getDb } = await loadDb();
    await getDb();
    const getPassword = passwordOption() as () => Promise<string>;

    mockGetToken.mockResolvedValueOnce(null);
    await expect(getPassword()).rejects.toThrow(new RegExp(SCOPE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('never logs the token value (only its expiry)', async () => {
    const { getDb } = await loadDb();
    const { log } = await import('../logger.js');
    await getDb();
    const getPassword = passwordOption() as () => Promise<string>;

    mockGetToken.mockResolvedValueOnce({ token: 'super-secret-token', expiresOnTimestamp: 1_800_000_000_000 });
    await getPassword();

    const logged = JSON.stringify((log.info as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain('super-secret-token');
    expect(logged).toContain('expiresOn');
  });

  // ── Password mode (local dev) ────────────────────────────────────────────

  it('uses the static URL password and no credential in password mode', async () => {
    mockConfigModule.config.databaseUrl = PASSWORD_URL;
    const { getDb } = await loadDb();
    await getDb();

    expect(passwordOption()).toBe('localpass');
    expect(credentialCtorCalls.count).toBe(0);
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it('passes discrete connection parameters and TLS settings', async () => {
    const { getDb } = await loadDb();
    await getDb();

    const o = pools[0].options;
    expect(o.host).toBe('psql.postgres.database.azure.com');
    expect(o.port).toBe(5432);
    expect(o.database).toBe('guestportal_prod');
    expect(o.user).toBe('uami-guestportal-backend-prod');
    expect(o.ssl).toEqual({ rejectUnauthorized: true });
  });
});
