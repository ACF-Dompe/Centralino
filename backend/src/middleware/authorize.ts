/**
 * Authorization middleware: resolves `req.authz` and guards routes with it.
 *
 * `ensureAuth` stays exactly as it was and keeps answering the single question
 * "is there a session?". Everything about *what* that session may do lives
 * here, resolved per request rather than read back from the session — see
 * `auth/authorization.ts` for why that separation is not negotiable.
 *
 * Every failure path here is closed. A lookup that throws produces 503, never a
 * default profile: the repo's other security decisions (SSH host key checking,
 * the break-glass kill switch) fail the same way, and an authorization layer
 * that degrades to "allow" under load is not one.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { config } from '../config.js';
import { log } from '../logger.js';
import type { AppUser } from '../auth/user.js';
import { isSamlUser } from '../auth/user.js';
import {
  canAccessSede,
  type AuthProfile,
  type Role,
} from '../auth/authorization.js';
import { getAppUserBySubject, samlSubject, isAutoAdmin } from '../repositories/appUsers.js';
import { getBreakGlassAccount } from '../repositories/breakglass.js';

interface CacheEntry {
  profile: AuthProfile;
  expiresAt: number;
}

/**
 * Per-process authorization cache.
 *
 * In-process and per-replica on purpose: there is no Redis here, and adding one
 * to carry invalidations between ACA replicas would be a lot of moving parts
 * for a window the TTL already bounds. An admin's change takes effect
 * immediately on the replica that served it (see `invalidateAuthProfile`) and
 * within the TTL everywhere else.
 */
const cache = new Map<string, CacheEntry>();

/** Drop a cached decision — called whenever an admin changes a profile. */
export function invalidateAuthProfile(subject: string): void {
  cache.delete(subject);
}

/** Empty the cache. Tests use it; nothing in the request path should. */
export function clearAuthProfileCache(): void {
  cache.clear();
}

function cacheKeyFor(user: AppUser): string | null {
  if (isSamlUser(user)) return samlSubject(user);
  return `bg:${user.nameID.trim().toLowerCase()}`;
}

/**
 * Resolve the authorization profile behind a session.
 *
 * Returns null when the session identifies nobody the directory knows — the
 * caller turns that into a 403, not a 401: the user authenticated perfectly
 * well, they just have not been profiled yet, and telling them to sign in again
 * would send them round a loop that cannot end.
 *
 * Break-glass sessions are resolved from their own table and granted every
 * site. They deliberately do not depend on `app_users`: this is the account
 * that has to work when the rest is broken, so a bad row in the directory must
 * not be able to close the last door.
 */
export async function resolveAuthProfile(user: AppUser): Promise<AuthProfile | null> {
  const key = cacheKeyFor(user);
  if (!key) return null;

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.profile;

  let profile: AuthProfile | null = null;

  if (isSamlUser(user)) {
    const record = await getAppUserBySubject(key);
    if (record) {
      // The address convention wins over whatever the row says. Provisioning
      // already wrote it, so the two normally agree; enforcing it here as well
      // means an accidental demotion — or a row edited directly in the
      // database — cannot lock a platform administrator out of the panel.
      const auto = isAutoAdmin(record.email ?? user.email);
      const role = auto ? 'admin' : record.role;
      const status = auto ? 'active' : record.status;

      profile = {
        subject: record.subject,
        userId: record.id,
        source: 'app_user',
        role,
        status,
        sedeIds: record.sedeIds,
        allSedi: role === 'admin',
        displayName: record.displayName || user.displayName,
        email: record.email ?? user.email,
      };
    }
  } else {
    const account = await getBreakGlassAccount(user.nameID);
    if (account) {
      const expired = account.expiresAt != null && account.expiresAt.getTime() <= Date.now();
      profile = {
        subject: key,
        userId: null,
        source: 'breakglass',
        role: (account.role === 'operator' || account.role === 'viewer' ? account.role : 'admin') as Role,
        status: account.enabled && !expired ? 'active' : 'suspended',
        sedeIds: [],
        allSedi: true,
        displayName: account.displayName,
        email: '',
      };
    }
  }

  if (profile) {
    cache.set(key, {
      profile,
      expiresAt: Date.now() + config.rbac.cacheTtlSeconds * 1000,
    });
  }
  return profile;
}

/** Shape of every authorization refusal, so the client can branch on a code. */
function deny(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  log.warn(
    {
      event: 'authz-denied',
      reason: code,
      subject: req.authz?.subject ?? null,
      path: req.path,
      method: req.method,
      correlationId: req.correlationId,
    },
    'Authorization denied',
  );
  res.status(status).json({ success: false, error: code, message, ...extra });
}

/**
 * In 'log-only' mode a refusal is recorded and the request continues.
 *
 * It exists so the first rollout can be watched before it can lock anybody out
 * of a working system. `enforce` is the default; a deployment that turns this
 * off says so loudly at startup.
 */
function enforcing(): boolean {
  return config.rbac.enforcement !== 'log-only';
}

function softDeny(
  req: Request,
  res: Response,
  next: NextFunction,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (enforcing()) {
    deny(req, res, status, code, message, extra);
    return;
  }
  log.warn(
    {
      event: 'authz-would-deny',
      reason: code,
      subject: req.authz?.subject ?? null,
      path: req.path,
      method: req.method,
      correlationId: req.correlationId,
    },
    'Authorization WOULD have denied this request (RBAC_ENFORCEMENT=log-only)',
  );
  next();
}

/**
 * Populate `req.authz`, or refuse.
 *
 * Mount after `ensureAuthenticated`: it assumes a session already exists.
 */
export function loadAuthorization(req: Request, res: Response, next: NextFunction): void {
  void (async () => {
    const user = req.user as AppUser | undefined;
    if (!user) {
      // Should be unreachable behind ensureAuthenticated; treat as unauthenticated.
      res.status(401).json({ success: false, error: 'unauthenticated', message: 'Authentication required.' });
      return;
    }

    let profile: AuthProfile | null;
    try {
      profile = await resolveAuthProfile(user);
    } catch (err) {
      log.error(
        { err: (err as Error).message, correlationId: req.correlationId },
        'Authorization lookup failed — refusing the request rather than assuming a role',
      );
      res.status(503).json({
        success: false,
        error: 'authz_unavailable',
        message: 'Servizio di autorizzazione non disponibile. Riprova tra poco.',
      });
      return;
    }

    if (!profile) {
      softDeny(req, res, next, 403, 'user_not_provisioned',
        'Utente non ancora abilitato. Un amministratore deve profilare il tuo account.');
      return;
    }

    req.authz = profile;

    if (profile.status === 'pending') {
      softDeny(req, res, next, 403, 'user_not_provisioned',
        'Utente non ancora abilitato. Un amministratore deve profilare il tuo account.');
      return;
    }
    if (profile.status !== 'active') {
      softDeny(req, res, next, 403, 'user_suspended',
        'Accesso sospeso. Contatta un amministratore.');
      return;
    }

    next();
  })();
}

/** Require one of `roles`. Mount after `loadAuthorization`. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, res, next) => {
    const profile = req.authz;
    if (!profile) {
      res.status(503).json({
        success: false,
        error: 'authz_unavailable',
        message: 'Servizio di autorizzazione non disponibile. Riprova tra poco.',
      });
      return;
    }
    if (!roles.includes(profile.role)) {
      softDeny(req, res, next, 403, 'insufficient_role',
        'Non hai i permessi necessari per questa operazione.',
        { requiredRoles: roles });
      return;
    }
    next();
  };
}

/** Default place to find the site a request is about. */
function defaultSedeExtractor(req: Request): number | null {
  const raw =
    (req.body as Record<string, unknown> | undefined)?.['sedeId'] ??
    req.query['sedeId'] ??
    null;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

/**
 * Require access to the site the request names.
 *
 * A missing site is refused rather than waved through: "no site" used to mean
 * "fall back to the first row", and that fallback is what let one operator's
 * action land on another site's controller.
 */
export function requireSedeAccess(
  extract: (req: Request) => number | null = defaultSedeExtractor,
): RequestHandler {
  return (req, res, next) => {
    const profile = req.authz;
    if (!profile) {
      res.status(503).json({
        success: false,
        error: 'authz_unavailable',
        message: 'Servizio di autorizzazione non disponibile. Riprova tra poco.',
      });
      return;
    }
    const sedeId = extract(req);
    if (sedeId == null) {
      softDeny(req, res, next, 400, 'sede_required', 'sedeId è obbligatorio per questa operazione.');
      return;
    }
    if (!canAccessSede(profile, sedeId)) {
      softDeny(req, res, next, 403, 'sede_forbidden', 'Non sei abilitato a questa sede.');
      return;
    }
    next();
  };
}

/**
 * Same check, for handlers that only learn the site after a read.
 *
 * Returns false when it has already answered, so the caller returns too.
 */
export function ensureSedeAllowed(req: Request, res: Response, sedeId: number | null): boolean {
  const profile = req.authz;
  if (!profile) {
    res.status(503).json({
      success: false,
      error: 'authz_unavailable',
      message: 'Servizio di autorizzazione non disponibile. Riprova tra poco.',
    });
    return false;
  }
  if (canAccessSede(profile, sedeId)) return true;
  if (!enforcing()) {
    log.warn(
      { event: 'authz-would-deny', reason: 'sede_forbidden', subject: profile.subject, path: req.path },
      'Authorization WOULD have denied this request (RBAC_ENFORCEMENT=log-only)',
    );
    return true;
  }
  deny(req, res, 403, 'sede_forbidden', 'Non sei abilitato a questa sede.');
  return false;
}

/**
 * The sites a profile may see, or null for "no restriction".
 *
 * Null and an empty array mean opposite things and must not be conflated: null
 * is an admin who sees everything, `[]` is a user granted nothing, who must see
 * nothing rather than everything.
 */
export function allowedSedeIds(profile: AuthProfile): number[] | null {
  return profile.allSedi ? null : profile.sedeIds;
}
