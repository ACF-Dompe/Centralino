/**
 * Unit tests for the migration CLI client (`db/migrate.ts`).
 *
 * Focus: `createMigrationClient()` must authenticate the same way the runtime
 * pool does — password from DATABASE_URL when present, otherwise an Entra ID
 * access token via DefaultAzureCredential (never `password: undefined`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

// ── Mocks (hoisted so vi.mock can reference them) ──────────────────────────

const mockConfigModule = vi.hoisted(() => ({
  config: {
    databaseUrl: '',
    db: { sslEnabled: true, sslRejectUnauthorized: true },
  },
  AZURE_DB_SCOPE: 'https://ossrdbms-aad.database.windows.net/.default',
}));
vi.mock('../config.js', () => mockConfigModule);

const mockPoolCtor = vi.hoisted(() => vi.fn());
const mockPoolQuery = vi.hoisted(() => vi.fn());
const mockPoolEnd = vi.hoisted(() => vi.fn());
vi.mock('pg', () => ({
  default: {
    Pool: function PoolMock(opts: unknown) {
      mockPoolCtor(opts);
      return { query: mockPoolQuery, end: mockPoolEnd };
    },
  },
}));

const mockGetToken = vi.hoisted(() => vi.fn());
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: function CredentialMock() {
    return { getToken: mockGetToken };
  },
}));

// ── Subject under test (imported after the mocks are registered) ───────────
import { createMigrationClient } from '../db/migrate.js';

/** The options object handed to `new pg.Pool(...)`. */
function poolOptions(): Record<string, unknown> {
  return mockPoolCtor.mock.calls[0][0] as Record<string, unknown>;
}

describe('createMigrationClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigModule.config.db.sslEnabled = true;
    mockConfigModule.config.db.sslRejectUnauthorized = true;
    // Keep the CLI's informational logging out of the test output.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Entra ID token auth (production: no password in DATABASE_URL) ────────

  describe('when DATABASE_URL has NO password (Entra ID)', () => {
    beforeEach(() => {
      mockConfigModule.config.databaseUrl =
        'postgres://uami-guestportal-backend-prod@psql.postgres.database.azure.com:5432/guestportal_prod';
    });

    it('acquires an Entra token and uses it as the connection password', async () => {
      mockGetToken.mockResolvedValue({ token: 'entra-token-abc', expiresOnTimestamp: Date.now() + 3_600_000 });

      await createMigrationClient();

      expect(mockGetToken).toHaveBeenCalledOnce();
      expect(mockGetToken).toHaveBeenCalledWith(SCOPE);
      expect(poolOptions().password).toBe('entra-token-abc');
      // Regression guard: the bug was connecting with an undefined password.
      expect(poolOptions().password).not.toBeUndefined();
    });

    it('passes the parsed connection parameters through', async () => {
      mockGetToken.mockResolvedValue({ token: 'entra-token-abc' });

      await createMigrationClient();

      const opts = poolOptions();
      expect(opts.host).toBe('psql.postgres.database.azure.com');
      expect(opts.port).toBe(5432);
      expect(opts.database).toBe('guestportal_prod');
      expect(opts.user).toBe('uami-guestportal-backend-prod');
    });

    it('throws a clear error when token acquisition fails', async () => {
      mockGetToken.mockRejectedValue(new Error('ManagedIdentityCredential unavailable'));

      await expect(createMigrationClient()).rejects.toThrow(
        /Entra ID token acquisition failed: ManagedIdentityCredential unavailable/,
      );
      expect(mockPoolCtor).not.toHaveBeenCalled();
    });

    it('throws when the credential returns no token', async () => {
      mockGetToken.mockResolvedValue(null);

      await expect(createMigrationClient()).rejects.toThrow(/no token/i);
      expect(mockPoolCtor).not.toHaveBeenCalled();
    });
  });

  // ── Password auth (local dev) ────────────────────────────────────────────

  describe('when DATABASE_URL contains a password (local dev)', () => {
    beforeEach(() => {
      mockConfigModule.config.databaseUrl = 'postgres://postgres:localpass@localhost:5432/guest_desk';
    });

    it('uses the URL password and does NOT request a token', async () => {
      await createMigrationClient();

      expect(mockGetToken).not.toHaveBeenCalled();
      expect(poolOptions().password).toBe('localpass');
    });

    it('URL-decodes a percent-encoded password', async () => {
      mockConfigModule.config.databaseUrl = 'postgres://postgres:p%40ss%3Aword@localhost:5432/guest_desk';

      await createMigrationClient();

      expect(poolOptions().password).toBe('p@ss:word');
    });
  });

  // ── TLS behaviour (aligned with db/index.ts) ─────────────────────────────

  describe('TLS', () => {
    beforeEach(() => {
      mockConfigModule.config.databaseUrl = 'postgres://postgres:pw@localhost:5432/guest_desk';
    });

    it('validates the server certificate when SSL is enabled', async () => {
      mockConfigModule.config.db.sslEnabled = true;
      mockConfigModule.config.db.sslRejectUnauthorized = true;

      await createMigrationClient();

      expect(poolOptions().ssl).toEqual({ rejectUnauthorized: true });
    });

    it('honours DB_SSL_REJECT_UNAUTHORIZED=false', async () => {
      mockConfigModule.config.db.sslEnabled = true;
      mockConfigModule.config.db.sslRejectUnauthorized = false;

      await createMigrationClient();

      expect(poolOptions().ssl).toEqual({ rejectUnauthorized: false });
    });

    it('disables SSL entirely when sslEnabled is false', async () => {
      mockConfigModule.config.db.sslEnabled = false;

      await createMigrationClient();

      expect(poolOptions().ssl).toBe(false);
    });
  });

  // ── Returned client shape ────────────────────────────────────────────────

  it('returns a postgres DbClient backed by the pool', async () => {
    mockConfigModule.config.databaseUrl = 'postgres://postgres:pw@localhost:5432/guest_desk';
    mockPoolQuery.mockResolvedValue({ rows: [{ n: 1 }], rowCount: 1 });

    const client = await createMigrationClient();

    expect(client.driver).toBe('postgres');
    await expect(client.query('SELECT 1')).resolves.toEqual({ rows: [{ n: 1 }], rowCount: 1 });
    await client.close();
    expect(mockPoolEnd).toHaveBeenCalledOnce();
  });
});
