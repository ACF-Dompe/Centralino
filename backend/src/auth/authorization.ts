/**
 * The authorization model: who someone is allowed to be, and where.
 *
 * Deliberately separate from the session. `passport.serializeUser` stores the
 * whole user object in `session.passport.user`, which `connect-pg-simple` keeps
 * for a day — so a role cached there would let a suspended account keep working
 * until its session expired. Authorization is therefore resolved per request
 * (see `middleware/authorize.ts`) and never serialized.
 *
 * The practical benefit of leaving `SamlUser` and `BreakGlassUser` untouched is
 * that sessions already open when this ships keep working: they are authorized
 * by the new lookup without anybody having to sign in again.
 */

export type Role = 'admin' | 'operator' | 'viewer';
export type UserStatus = 'pending' | 'active' | 'suspended';

export const ROLES: readonly Role[] = ['admin', 'operator', 'viewer'] as const;
export const USER_STATUSES: readonly UserStatus[] = ['pending', 'active', 'suspended'] as const;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isUserStatus(value: unknown): value is UserStatus {
  return typeof value === 'string' && (USER_STATUSES as readonly string[]).includes(value);
}

/**
 * Authorization resolved for a single request.
 *
 * `allSedi` exists so a break-glass session does not depend on rows in
 * `app_users` at all — see the note on `resolveAuthProfile`.
 */
export interface AuthProfile {
  /** `app_users.subject`, or `bg:<username>` for a break-glass session. */
  subject: string;
  /** `app_users.id`, or null for a break-glass session. */
  userId: number | null;
  source: 'app_user' | 'breakglass';
  role: Role;
  status: UserStatus;
  /** Granted sites. Meaningless when `allSedi` is true. */
  sedeIds: number[];
  /** Break-glass only: every site, by construction. */
  allSedi: boolean;
  displayName: string;
  email: string;
}

/** Is this profile allowed to act on `sedeId`? */
export function canAccessSede(profile: AuthProfile, sedeId: number | null): boolean {
  if (profile.allSedi) return true;
  // Guests imported before sites existed carry no sede_id. Only an admin has a
  // wide enough remit to touch them.
  if (sedeId == null) return profile.role === 'admin';
  return profile.sedeIds.includes(sedeId);
}

/** Does this profile hold one of `roles`? */
export function hasRole(profile: AuthProfile, roles: readonly Role[]): boolean {
  return roles.includes(profile.role);
}

/** Can this profile change anything, or is it read-only? */
export function canWrite(profile: AuthProfile): boolean {
  return profile.role === 'admin' || profile.role === 'operator';
}
