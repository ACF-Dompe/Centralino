/**
 * Repository for break-glass local accounts (`breakglass_users`).
 *
 * Kept in its own module rather than added to `repositories/index.ts`: the
 * read/write paths here are security-sensitive and only two callers touch them
 * — the break-glass login route and the `breakglass` CLI.
 *
 * The lockout counters live in the database on purpose. ACA runs several
 * backend replicas, so an in-memory counter would let an attacker get
 * `maxFailedAttempts` tries per replica; a column gives one global budget.
 */
import { getDb } from '../db/index.js';
import type { DbClient } from '../db/index.js';

/** A row of `breakglass_users`, mapped to camelCase. */
export interface BreakGlassAccount {
  username: string;
  displayName: string;
  /** Authorization role. Defaults to 'admin' — see the migration for why. */
  role: string;
  /** scrypt hash — see auth/password.ts. Never leaves the backend. */
  passwordHash: string;
  enabled: boolean;
  expiresAt: Date | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

interface BreakGlassRow {
  username: string;
  display_name: string;
  role: string;
  password_hash: string;
  enabled: boolean;
  expires_at: string | Date | null;
  failed_attempts: number;
  locked_until: string | Date | null;
  last_login_at: string | Date | null;
  created_at: string | Date;
}

function toDate(value: string | Date | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function rowToAccount(r: BreakGlassRow): BreakGlassAccount {
  return {
    username: r.username,
    displayName: r.display_name,
    role: r.role ?? 'admin',
    passwordHash: r.password_hash,
    enabled: r.enabled,
    expiresAt: toDate(r.expires_at),
    failedAttempts: r.failed_attempts,
    lockedUntil: toDate(r.locked_until),
    lastLoginAt: toDate(r.last_login_at),
    createdAt: toDate(r.created_at) ?? new Date(0),
  };
}

/**
 * Resolve the database client.
 *
 * The CLI passes its own short-lived client (built by `createMigrationClient`)
 * because it runs outside the server process and must not spin up the runtime
 * pool, migrations and seed. The HTTP routes pass nothing and get the pool.
 */
async function resolveDb(client?: DbClient): Promise<DbClient> {
  return client ?? (await getDb());
}

/**
 * Look up a break-glass account by username.
 *
 * Usernames are compared case-insensitively (and stored lowercased) so that an
 * operator typing `Admin.BreakGlass` under pressure still authenticates.
 */
export async function getBreakGlassAccount(
  username: string,
  client?: DbClient,
): Promise<BreakGlassAccount | null> {
  const db = await resolveDb(client);
  const res = await db.query(
    `SELECT username, display_name, role, password_hash, enabled, expires_at,
            failed_attempts, locked_until, last_login_at, created_at
       FROM breakglass_users
      WHERE username = $1`,
    [username.trim().toLowerCase()],
  );
  const rows = res.rows as BreakGlassRow[];
  return rows.length > 0 ? rowToAccount(rows[0]) : null;
}

/** List every break-glass account (CLI only — password hashes are included). */
export async function listBreakGlassAccounts(client?: DbClient): Promise<BreakGlassAccount[]> {
  const db = await resolveDb(client);
  const res = await db.query(
    `SELECT username, display_name, role, password_hash, enabled, expires_at,
            failed_attempts, locked_until, last_login_at, created_at
       FROM breakglass_users
      ORDER BY username`,
  );
  return (res.rows as BreakGlassRow[]).map(rowToAccount);
}

/**
 * Record a failed login attempt and lock the account once it reaches the
 * threshold.
 *
 * The increment and the lock decision happen in a single statement so two
 * concurrent replicas cannot both read `failed_attempts = 4` and each write 5.
 * Returns the resulting lock expiry, or null if the account is still unlocked.
 */
export async function registerFailedAttempt(
  username: string,
  maxFailedAttempts: number,
  lockoutMinutes: number,
  client?: DbClient,
): Promise<Date | null> {
  const db = await resolveDb(client);
  const res = await db.query(
    `UPDATE breakglass_users
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE
              WHEN failed_attempts + 1 >= $2
                THEN NOW() + ($3 || ' minutes')::INTERVAL
              ELSE locked_until
            END,
            updated_at = NOW()
      WHERE username = $1
      RETURNING locked_until`,
    [username.trim().toLowerCase(), maxFailedAttempts, String(lockoutMinutes)],
  );
  const rows = res.rows as { locked_until: string | Date | null }[];
  return rows.length > 0 ? toDate(rows[0].locked_until) : null;
}

/** Clear the lockout counters and stamp the successful login. */
export async function registerSuccessfulLogin(
  username: string,
  client?: DbClient,
): Promise<void> {
  const db = await resolveDb(client);
  await db.query(
    `UPDATE breakglass_users
        SET failed_attempts = 0,
            locked_until = NULL,
            last_login_at = NOW(),
            updated_at = NOW()
      WHERE username = $1`,
    [username.trim().toLowerCase()],
  );
}

/**
 * Create or replace a break-glass account (CLI only).
 * Re-running it on an existing username rotates the password and clears any
 * lockout, which is exactly what a credential rotation needs to do.
 */
export async function upsertBreakGlassAccount(
  params: {
    username: string;
    displayName: string;
    passwordHash: string;
    expiresAt: Date | null;
    role?: string;
  },
  client?: DbClient,
): Promise<void> {
  const db = await resolveDb(client);
  await db.query(
    `INSERT INTO breakglass_users
       (username, display_name, password_hash, role, enabled, expires_at)
     VALUES ($1, $2, $3, $4, TRUE, $5)
     ON CONFLICT (username) DO UPDATE
        SET display_name    = EXCLUDED.display_name,
            password_hash   = EXCLUDED.password_hash,
            role            = EXCLUDED.role,
            enabled         = TRUE,
            expires_at      = EXCLUDED.expires_at,
            failed_attempts = 0,
            locked_until    = NULL,
            updated_at      = NOW()`,
    [
      params.username.trim().toLowerCase(),
      params.displayName,
      params.passwordHash,
      params.role ?? 'admin',
      params.expiresAt,
    ],
  );
}

/**
 * Create the bootstrap account, and only if it is missing.
 *
 * Kept separate from `upsertBreakGlassAccount` on purpose. That one rotates the
 * password, re-enables the account and clears the lockout — exactly right for a
 * deliberate rotation from the CLI, and exactly wrong for something that runs
 * on every migration: it would restore a password an operator had already
 * rotated away, and switch an account back on that somebody had turned off.
 *
 * Returns true when a row was actually inserted.
 */
export async function insertBreakGlassAccountIfMissing(
  params: {
    username: string;
    displayName: string;
    passwordHash: string;
    role?: string;
    expiresAt: Date | null;
  },
  client?: DbClient,
): Promise<boolean> {
  const db = await resolveDb(client);
  const res = await db.query(
    `INSERT INTO breakglass_users
       (username, display_name, password_hash, role, enabled, expires_at)
     VALUES ($1, $2, $3, $4, TRUE, $5)
     ON CONFLICT (username) DO NOTHING`,
    [
      params.username.trim().toLowerCase(),
      params.displayName,
      params.passwordHash,
      params.role ?? 'admin',
      params.expiresAt,
    ],
  );
  return res.rowCount > 0;
}

/** What the admin panel is allowed to see about a break-glass account. */
export interface BreakGlassAdminRow {
  username: string;
  displayName: string;
  role: string;
  enabled: boolean;
  expiresAt: Date | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

/**
 * List accounts for the admin panel.
 *
 * A separate query from `listBreakGlassAccounts` rather than a mapping over it:
 * that one selects `password_hash`, and a hash that is never fetched cannot be
 * leaked into an HTTP response by a later careless edit.
 */
export async function listBreakGlassAccountsForAdmin(
  client?: DbClient,
): Promise<BreakGlassAdminRow[]> {
  const db = await resolveDb(client);
  const res = await db.query(
    `SELECT username, display_name, role, enabled, expires_at,
            failed_attempts, locked_until, last_login_at, created_at
       FROM breakglass_users
      ORDER BY username`,
  );
  return (res.rows as Omit<BreakGlassRow, 'password_hash'>[]).map((r) => ({
    username: r.username,
    displayName: r.display_name,
    role: r.role ?? 'admin',
    enabled: r.enabled,
    expiresAt: toDate(r.expires_at),
    failedAttempts: r.failed_attempts,
    lockedUntil: toDate(r.locked_until),
    lastLoginAt: toDate(r.last_login_at),
    createdAt: toDate(r.created_at) ?? new Date(0),
  }));
}

/**
 * How many break-glass accounts would still be usable without `excludeUsername`.
 *
 * Guards the admin panel against disabling the last way back in when SSO is
 * down — which is the entire point of these accounts.
 */
export async function countUsableBreakGlassAccounts(
  excludeUsername?: string,
  client?: DbClient,
): Promise<number> {
  const db = await resolveDb(client);
  const res = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM breakglass_users
      WHERE enabled = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
        AND ($1::text IS NULL OR username <> $1)`,
    [excludeUsername ? excludeUsername.trim().toLowerCase() : null],
  );
  return Number((res.rows as Array<{ n: number }>)[0]?.n ?? 0);
}

/** Enable or disable an account without deleting it (CLI only). */
export async function setBreakGlassEnabled(
  username: string,
  enabled: boolean,
  client?: DbClient,
): Promise<boolean> {
  const db = await resolveDb(client);
  const res = await db.query(
    `UPDATE breakglass_users
        SET enabled = $2, updated_at = NOW()
      WHERE username = $1`,
    [username.trim().toLowerCase(), enabled],
  );
  return res.rowCount > 0;
}

/** Clear a lockout so a locked-out operator can retry immediately (CLI only). */
export async function unlockBreakGlassAccount(
  username: string,
  client?: DbClient,
): Promise<boolean> {
  const db = await resolveDb(client);
  const res = await db.query(
    `UPDATE breakglass_users
        SET failed_attempts = 0, locked_until = NULL, updated_at = NOW()
      WHERE username = $1`,
    [username.trim().toLowerCase()],
  );
  return res.rowCount > 0;
}

/** Permanently remove an account (CLI only). */
export async function deleteBreakGlassAccount(
  username: string,
  client?: DbClient,
): Promise<boolean> {
  const db = await resolveDb(client);
  const res = await db.query(
    `DELETE FROM breakglass_users WHERE username = $1`,
    [username.trim().toLowerCase()],
  );
  return res.rowCount > 0;
}
