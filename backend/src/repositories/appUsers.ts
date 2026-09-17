/**
 * Repository for the application user directory (`app_users`, `app_user_sedi`).
 *
 * The directory mirrors Entra: a row appears the first time somebody completes
 * an SSO login, and an admin then profiles it. Nothing here ever creates an
 * already-authorized user — that separation is what makes the just-in-time
 * provisioning safe to run on the authentication path.
 *
 * Kept apart from `repositories/index.ts` for the same reason as
 * `breakglass.ts`: everything in here decides who may do what.
 */
import { getDb } from '../db/index.js';
import type { DbClient } from '../db/index.js';
import type { Role, UserStatus } from '../auth/authorization.js';
import { isPlatformAdminAddress } from '../auth/authorization.js';
import { config } from '../config.js';
import type { SamlUser } from '../auth/saml.js';

export interface AppUserRecord {
  id: number;
  subject: string;
  entraObjectId: string | null;
  /** User principal name. The identifier an administrator recognises. */
  upn: string | null;
  email: string | null;
  displayName: string;
  givenName: string | null;
  surname: string | null;
  role: Role;
  status: UserStatus;
  sedeIds: number[];
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  profiledAt: Date | null;
  profiledBy: string | null;
  /**
   * True when the role comes from the mail-address convention rather than from
   * somebody's decision. Such a row is not editable: a login would reapply the
   * rule and undo the change.
   */
  autoAdmin: boolean;
}

/**
 * Does the naming convention make this account a platform administrator?
 *
 * Evaluated on the **UPN**, because administrative accounts routinely have no
 * mailbox: `admin365-…@dompe.onmicrosoft.com` has none in this tenant, so a
 * rule keyed on mail missed exactly the accounts the convention exists for.
 *
 * The mail address is still consulted, but only when no UPN is available — a
 * tenant that releases no UPN-shaped claim would otherwise lose the convention
 * altogether. That is not a weakening: both paths go through the same
 * required-domain check, which is what stops a B2B guest from qualifying.
 */
export function isAutoAdmin(
  upn: string | null | undefined,
  email?: string | null,
): boolean {
  const opts = {
    prefixes: config.rbac.autoAdminPrefixes,
    domains: config.rbac.autoAdminDomains,
  };
  const principal = (upn ?? '').trim();
  if (principal.length > 0) {
    return isPlatformAdminAddress(principal, opts);
  }
  return isPlatformAdminAddress(email, opts);
}

interface AppUserRow {
  id: string | number;
  subject: string;
  entra_object_id: string | null;
  upn: string | null;
  email: string | null;
  display_name: string;
  given_name: string | null;
  surname: string | null;
  role: Role;
  status: UserStatus;
  sede_ids: Array<string | number> | null;
  created_at: string | Date;
  updated_at: string | Date;
  last_login_at: string | Date | null;
  profiled_at: string | Date | null;
  profiled_by: string | null;
}

function toDate(value: string | Date | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function rowToRecord(r: AppUserRow): AppUserRecord {
  return {
    id: Number(r.id),
    subject: r.subject,
    entraObjectId: r.entra_object_id,
    upn: r.upn,
    email: r.email,
    displayName: r.display_name,
    givenName: r.given_name,
    surname: r.surname,
    role: r.role,
    status: r.status,
    sedeIds: (r.sede_ids ?? []).map(Number),
    createdAt: toDate(r.created_at) ?? new Date(0),
    updatedAt: toDate(r.updated_at) ?? new Date(0),
    lastLoginAt: toDate(r.last_login_at),
    profiledAt: toDate(r.profiled_at),
    profiledBy: r.profiled_by,
    autoAdmin: isAutoAdmin(r.upn, r.email),
  };
}

/** The CLI runs outside the server and passes its own short-lived client. */
async function resolveDb(client?: DbClient): Promise<DbClient> {
  return client ?? (await getDb());
}

/** Columns every read returns, with the granted sites folded in. */
const SELECT_USER = `
  SELECT u.id, u.subject, u.entra_object_id, u.upn, u.email, u.display_name,
         u.given_name, u.surname, u.role, u.status,
         u.created_at, u.updated_at, u.last_login_at, u.profiled_at, u.profiled_by,
         COALESCE(ARRAY_AGG(s.sede_id) FILTER (WHERE s.sede_id IS NOT NULL), '{}') AS sede_ids
    FROM app_users u
    LEFT JOIN app_user_sedi s ON s.user_id = u.id`;

/**
 * The stable identifier for an SSO user.
 *
 * The Entra objectId is the right key — it outlives a change of surname or of
 * mail domain — but the claim is only present when the Enterprise Application
 * is configured to release it, and this tenant has already had claims go
 * missing. So fall back to the mail address, and then to the nameID, rather
 * than refuse to provision.
 *
 * Returns null when the assertion identifies nobody at all.
 */
export function samlSubject(u: SamlUser): string | null {
  const oid = (u.objectId ?? '').trim();
  if (oid) return oid;

  const email = (u.email ?? '').trim().toLowerCase();
  if (email) return `email:${email}`;

  const nameId = (u.nameID ?? '').trim().toLowerCase();
  return nameId ? `nameid:${nameId}` : null;
}

export interface ProvisionResult {
  subject: string;
  created: boolean;
  role: Role;
  status: UserStatus;
  /** True when the role was granted by the address convention. */
  autoAdmin: boolean;
}

/**
 * Record an SSO login, creating the directory entry the first time.
 *
 * Two properties matter here and are both load-bearing:
 *
 *   1. `role` and `status` are absent from the DO UPDATE clause. Logging in
 *      must never be able to promote or unblock anybody — profiling is an
 *      administrative act, and this is the authentication path.
 *   2. The whole thing is one statement, so two concurrent logins (two tabs,
 *      two replicas, an ACS posted twice) cannot race: there is no window
 *      between reading and writing for a second caller to slip into.
 *
 * `xmax = 0` is true only for a freshly inserted row, which distinguishes a
 * new user from a returning one without a second query.
 *
 * There is exactly one exception to (1), and it is deliberate: an address that
 * matches the platform-administrator convention is promoted, on every login, by
 * a separate statement below. Writing it into the directory rather than only
 * deriving it at request time keeps the admin panel showing the truth and keeps
 * `countActiveAdmins` counting these accounts — otherwise the last-administrator
 * guard would believe there were none.
 */
export async function upsertAppUserFromSaml(
  u: SamlUser,
  client?: DbClient,
): Promise<ProvisionResult> {
  const subject = samlSubject(u);
  if (!subject) {
    throw new Error('L\'asserzione SAML non contiene objectId, email né nameID: impossibile identificare l\'utente');
  }

  const db = await resolveDb(client);
  const objectId = (u.objectId ?? '').trim() || null;

  // Claim a row created before the objectId claim was available, so profiling
  // survives the tenant starting to release it. Harmless when it matches
  // nothing, which is the usual case.
  if (objectId) {
    const email = (u.email ?? '').trim().toLowerCase();
    if (email) {
      await db.query(
        `UPDATE app_users
            SET subject = $1, entra_object_id = $1, updated_at = NOW()
          WHERE entra_object_id IS NULL
            AND subject = $2
            AND NOT EXISTS (SELECT 1 FROM app_users WHERE subject = $1)`,
        [objectId, `email:${email}`],
      );
    }
  }

  const res = await db.query(
    `INSERT INTO app_users
       (subject, entra_object_id, upn, email, display_name, given_name, surname, role, status, last_login_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'viewer', 'pending', NOW())
     ON CONFLICT (subject) DO UPDATE
        SET upn             = COALESCE(NULLIF(EXCLUDED.upn, ''), app_users.upn),
            email           = COALESCE(NULLIF(EXCLUDED.email, ''), app_users.email),
            display_name    = COALESCE(NULLIF(EXCLUDED.display_name, ''), app_users.display_name),
            given_name      = COALESCE(EXCLUDED.given_name, app_users.given_name),
            surname         = COALESCE(EXCLUDED.surname, app_users.surname),
            entra_object_id = COALESCE(app_users.entra_object_id, EXCLUDED.entra_object_id),
            last_login_at   = NOW(),
            updated_at      = NOW()
     RETURNING subject, upn, email, role, status, (xmax = 0) AS created`,
    [
      subject,
      objectId,
      (u.upn ?? '').trim() || null,
      (u.email ?? '').trim() || null,
      (u.displayName ?? '').trim(),
      (u.givenName ?? '').trim() || null,
      (u.surname ?? '').trim() || null,
    ],
  );

  const row = (res.rows as Array<{
    subject: string;
    upn: string | null;
    email: string | null;
    role: Role;
    status: UserStatus;
    created: boolean;
  }>)[0];
  let { role, status } = row;

  // Evaluate the convention on what is now stored, not only on this assertion:
  // a returning user whose UPN arrived on an earlier login must keep matching
  // even if this particular assertion happened to omit the claim.
  const autoAdmin = isAutoAdmin(row.upn, row.email);

  // The naming convention grants platform administrator. Applied after the
  // upsert rather than inside it so the general rule — a login never changes a
  // role — stays visible in one place, with this as its single exception.
  if (autoAdmin) {
    if (role !== 'admin' || status !== 'active') {
      await db.query(
        `UPDATE app_users
            SET role = 'admin', status = 'active', updated_at = NOW()
          WHERE subject = $1`,
        [subject],
      );
      role = 'admin';
      status = 'active';
    }
  }

  return {
    subject: row.subject,
    created: Boolean(row.created),
    role,
    status,
    autoAdmin,
  };
}

export async function getAppUserBySubject(
  subject: string,
  client?: DbClient,
): Promise<AppUserRecord | null> {
  const db = await resolveDb(client);
  const res = await db.query(`${SELECT_USER} WHERE u.subject = $1 GROUP BY u.id`, [subject]);
  const rows = res.rows as AppUserRow[];
  return rows.length > 0 ? rowToRecord(rows[0]) : null;
}

export async function getAppUserById(
  id: number,
  client?: DbClient,
): Promise<AppUserRecord | null> {
  const db = await resolveDb(client);
  const res = await db.query(`${SELECT_USER} WHERE u.id = $1 GROUP BY u.id`, [id]);
  const rows = res.rows as AppUserRow[];
  return rows.length > 0 ? rowToRecord(rows[0]) : null;
}

export async function listAppUsers(
  filter?: { status?: UserStatus; search?: string },
  client?: DbClient,
): Promise<AppUserRecord[]> {
  const db = await resolveDb(client);
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter?.status) {
    params.push(filter.status);
    where.push(`u.status = $${params.length}`);
  }
  if (filter?.search && filter.search.trim().length > 0) {
    params.push(`%${filter.search.trim().toLowerCase()}%`);
    where.push(
      `(LOWER(u.upn) LIKE $${params.length}
         OR LOWER(u.email) LIKE $${params.length}
         OR LOWER(u.display_name) LIKE $${params.length})`,
    );
  }

  const res = await db.query(
    `${SELECT_USER}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      GROUP BY u.id
      ORDER BY
        CASE u.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
        LOWER(u.display_name)`,
    params,
  );
  return (res.rows as AppUserRow[]).map(rowToRecord);
}

/** Apply an admin's profiling decision. Returns null when the user is gone. */
export async function updateAppUserProfile(
  id: number,
  patch: { role?: Role; status?: UserStatus; profiledBy: string },
  client?: DbClient,
): Promise<AppUserRecord | null> {
  const db = await resolveDb(client);
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.role !== undefined) {
    params.push(patch.role);
    sets.push(`role = $${params.length}`);
  }
  if (patch.status !== undefined) {
    params.push(patch.status);
    sets.push(`status = $${params.length}`);
  }

  params.push(patch.profiledBy);
  sets.push(`profiled_by = $${params.length}`);
  sets.push('profiled_at = NOW()');
  sets.push('updated_at = NOW()');

  params.push(id);
  await db.query(`UPDATE app_users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  return getAppUserById(id, client);
}

/**
 * Replace a user's granted sites.
 *
 * One statement, because `DbClient` runs every query through a pool and hands
 * out no transaction: a BEGIN here would not be guaranteed to reach the same
 * physical connection as the statements after it. An empty array clears every
 * grant, which is the correct reading of "no sites".
 */
export async function replaceAppUserSedi(
  id: number,
  sedeIds: number[],
  client?: DbClient,
): Promise<void> {
  const db = await resolveDb(client);
  const unique = Array.from(new Set(sedeIds.map(Number).filter((n) => Number.isInteger(n))));
  await db.query(
    `WITH removed AS (
       DELETE FROM app_user_sedi
        WHERE user_id = $1 AND sede_id <> ALL($2::int[])
     )
     INSERT INTO app_user_sedi (user_id, sede_id)
     SELECT $1, s FROM unnest($2::int[]) AS s
     ON CONFLICT (user_id, sede_id) DO NOTHING`,
    [id, unique],
  );
}

/**
 * How many active admins would remain, ignoring one user.
 *
 * Used to refuse the change that would leave the directory with nobody able to
 * profile anyone. Break-glass accounts deliberately do not count: they are the
 * way back in when this goes wrong, not a seat in the normal rota.
 */
export async function countActiveAdmins(excludeId?: number, client?: DbClient): Promise<number> {
  const db = await resolveDb(client);
  const res = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM app_users
      WHERE role = 'admin' AND status = 'active' AND ($1::bigint IS NULL OR id <> $1)`,
    [excludeId ?? null],
  );
  return Number((res.rows as Array<{ n: number }>)[0]?.n ?? 0);
}

/** Remove a directory entry. The grants go with it via ON DELETE CASCADE. */
export async function deleteAppUser(id: number, client?: DbClient): Promise<boolean> {
  const db = await resolveDb(client);
  const res = await db.query(`DELETE FROM app_users WHERE id = $1`, [id]);
  return res.rowCount > 0;
}
