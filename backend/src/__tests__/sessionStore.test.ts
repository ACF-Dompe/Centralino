/**
 * Tests for the session store wiring (`auth/session.ts`).
 *
 * Regression under test: the store used to be built from `conString`, which
 * makes connect-pg-simple create its OWN pg.Pool — with no TLS and no
 * password. Against Azure PostgreSQL that connection is refused outright:
 *
 *   no pg_hba.conf entry for host "...", user "uami-guestportal-backend-prod",
 *   database "guestportal_prod", no encryption
 *
 * and even over TLS there is still no credential, because Entra authentication
 * keeps the password out of DATABASE_URL — the token only arrives through the
 * `password` callback that `createDbPool()` installs.
 *
 * The bug stayed invisible for as long as SSO could not complete: nothing ever
 * had to persist a session successfully. These tests pin the contract so it
 * cannot regress.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Options every constructed pg.Pool received, in order. */
const pools = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('pg', () => ({
  default: {
    Pool: function PoolMock(options: Record<string, unknown>) {
      pools.push(options);
      return {
        options,
        query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
        end: vi.fn(async () => undefined),
        on: vi.fn(),
      };
    },
  },
}));

/** Options the connect-pg-simple store received. */
const storeOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('connect-pg-simple', () => ({
  default: () =>
    function PgStoreMock(options: Record<string, unknown>) {
      storeOptions.push(options);
      // express-session subscribes to 'disconnect'/'connect' on the store, so
      // the mock has to carry `on` like the real EventEmitter-based Store.
      return { get: vi.fn(), set: vi.fn(), destroy: vi.fn(), on: vi.fn() };
    },
}));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: function CredentialMock() {
    return { getToken: vi.fn(async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3_600_000 })) };
  },
}));

vi.mock('../db/migrate.js', () => ({ runMigrations: vi.fn() }));
vi.mock('../db/seed.js', () => ({ runSeed: vi.fn() }));
vi.mock('../logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockConfig = vi.hoisted(() => ({
  config: {
    databaseUrl: 'postgres://uami-guestportal-backend-prod@psql.postgres.database.azure.com:5432/guestportal_prod',
    sessionSecret: 'test-secret',
    db: {
      skipMigrations: true,
      seedEnabled: false,
      sslEnabled: true,
      sslRejectUnauthorized: true,
    },
  },
  AZURE_DB_SCOPE: 'https://ossrdbms-aad.database.windows.net/.default',
}));
vi.mock('../config.js', () => mockConfig);

async function loadSession() {
  vi.resetModules();
  return import('../auth/session.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  pools.length = 0;
  storeOptions.length = 0;
  mockConfig.config.db.sslEnabled = true;
  mockConfig.config.db.sslRejectUnauthorized = true;
});

describe('createSessionStore', () => {
  it('hands the store a pool, never a connection string', async () => {
    const { createSessionStore } = await loadSession();
    createSessionStore();

    expect(storeOptions).toHaveLength(1);
    expect(storeOptions[0].pool).toBeDefined();
    // A conString would make connect-pg-simple build its own unauthenticated,
    // unencrypted pool — the exact cause of the pg_hba failure.
    expect(storeOptions[0].conString).toBeUndefined();
  });

  it('builds that pool with TLS enabled', async () => {
    const { createSessionStore } = await loadSession();
    createSessionStore();

    expect(pools).toHaveLength(1);
    expect(pools[0].ssl).toEqual({ rejectUnauthorized: true });
  });

  it('builds that pool with the Entra token callback as the password', async () => {
    const { createSessionStore } = await loadSession();
    createSessionStore();

    // A FUNCTION, so pg re-authenticates on every new physical connection.
    expect(typeof pools[0].password).toBe('function');
  });

  it('keeps the session pool small so it cannot starve the application pool', async () => {
    const { createSessionStore } = await loadSession();
    createSessionStore();

    expect(pools[0].max).toBe(5);
  });

  it('honours DB_SSL_ENABLED=false for the local/e2e PostgreSQL container', async () => {
    mockConfig.config.db.sslEnabled = false;
    const { createSessionStore } = await loadSession();
    createSessionStore();

    expect(pools[0].ssl).toBe(false);
  });

  it('still asks the store to create the session table if missing', async () => {
    const { createSessionStore } = await loadSession();
    createSessionStore();

    expect(storeOptions[0].createTableIfMissing).toBe(true);
  });
});

describe('createSessionMiddleware', () => {
  it('reuses the store it is given instead of building another one', async () => {
    const { createSessionStore, createSessionMiddleware } = await loadSession();
    const store = createSessionStore();

    const poolsAfterStore = pools.length;
    createSessionMiddleware(store, 'secret');

    // No extra pool and no extra store: the middleware and the WebSocket
    // verifier must share one store, or they would read different sessions.
    expect(pools).toHaveLength(poolsAfterStore);
    expect(storeOptions).toHaveLength(1);
  });
});
