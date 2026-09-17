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
 * Does this mail address make its owner a platform administrator by itself?
 *
 * The convention is `admin365-<anything>@dompe.onmicrosoft.com`: the prefix and
 * the domain are fixed, whatever sits between them is not. Such accounts hold
 * full privileges without anybody profiling them, which is what lets an
 * administrator reach a fresh deployment without the break-glass account.
 *
 * Two deliberate strictnesses, because this function grants administrator:
 *
 *   - The domain list is **required**. An empty one disables the rule instead of
 *     matching every domain, which is the opposite of how the other list-shaped
 *     settings in this file behave — and the right way round here, since the
 *     domain is what stops an Entra guest account from qualifying. A B2B
 *     invitee's UPN belongs to their own tenant, so without this an invited
 *     `admin365-x@attacker.com` would arrive as a platform administrator.
 *   - Something has to follow the prefix. A bare `admin365-@...` is not an
 *     account anybody means to create, so it does not qualify.
 *
 * Kept a pure function so both the provisioning path (which writes the role into
 * the directory, keeping the admin panel honest and `countActiveAdmins`
 * counting) and the per-request lookup (which enforces it, so an accidental
 * demotion cannot take effect) share one definition.
 */
export function isPlatformAdminEmail(
  email: string | null | undefined,
  opts: { prefixes: string; domains: string },
): boolean {
  const address = (email ?? '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return false;

  const localPart = address.slice(0, at);
  const domain = address.slice(at + 1);

  const domains = opts.domains
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => d.length > 0);
  // Fail closed: no configured domain means the rule is off.
  if (!domains.includes(domain)) return false;

  return opts.prefixes
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0)
    .some((p) => localPart.startsWith(p) && localPart.length > p.length);
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
