/**
 * Authentication routes for SSO SAML 2.0 via Microsoft Entra ID, plus the
 * break-glass local login used when the IdP is unavailable.
 *
 * Routes (all mounted at /api/auth):
 *   GET  /api/auth/login    — redirect to the IdP (Entra ID)
 *   POST /api/auth/callback — SAML ACS (Assertion Consumer Service)
 *   POST /api/auth/logout   — initiate SLO (redirects to IdP) or local logout
 *   POST /api/auth/slo/callback — SAML LogoutResponse handler
 *   GET  /api/auth/me       — return the current user profile (or 401)
 *   GET  /api/auth/breakglass/status — whether break-glass login is usable
 *   POST /api/auth/breakglass/login  — break-glass username/password login
 *
 * When SAML is not configured (local dev), /me returns 404 and /login
 * returns 501 so the frontend knows SSO is unavailable. The break-glass routes
 * are mounted in BOTH cases on purpose: the whole point of the path is to work
 * when the SAML side is broken or absent.
 */
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import passport from 'passport';
import { config } from '../config.js';
import { log } from '../logger.js';
import type { SamlStrategy } from '../auth/saml.js';
import { buildSloRedirectUrl } from '../auth/saml.js';
import type { AppUser } from '../auth/user.js';
import { toBreakGlassUser, isSamlUser } from '../auth/user.js';
import type { AuthProfile } from '../auth/authorization.js';
import { resolveAuthProfile, invalidateAuthProfile } from '../middleware/authorize.js';
import { upsertAppUserFromSaml } from '../repositories/appUsers.js';
import { listSedi } from '../repositories/index.js';
import {
  DUMMY_PASSWORD_HASH,
  verifyPassword,
} from '../auth/password.js';
import {
  getBreakGlassAccount,
  registerFailedAttempt,
  registerSuccessfulLogin,
} from '../repositories/breakglass.js';
import { createIpAllowlist, type IpAllowlist } from '../utils/ipAllowlist.js';
import { createLoginThrottle, type LoginThrottle } from '../utils/loginThrottle.js';
import { isLocalUrl } from '../utils/sanitize.js';

/**
 * The break-glass settings the login path actually reads.
 *
 * The seed fields on `config.breakGlass` describe how the bootstrap account is
 * created by the migration; they have nothing to do with serving a login, so
 * they stay out of this contract rather than becoming something every caller
 * (and every test) has to supply.
 */
type BreakGlassConfig = Omit<
  typeof config.breakGlass,
  'seedUsername' | 'seedDisplayName' | 'seedPassword'
>;

interface AuthRouterOptions {
  samlEnabled: boolean;
  samlStrategy?: SamlStrategy;
  /** Break-glass settings. Defaults to `config.breakGlass`; injected by tests. */
  breakGlass?: BreakGlassConfig;
}

/**
 * The only message the break-glass endpoint ever returns on failure.
 *
 * Every rejection reason — unknown username, wrong password, disabled, expired,
 * locked out — produces this exact response. Distinguishing them would let an
 * attacker enumerate which break-glass accounts exist and which are live. The
 * real reason goes to the audit log instead.
 */
const BREAKGLASS_GENERIC_ERROR = 'Credenziali non valide.';

/**
 * Body parser for the two SAML POST endpoints.
 *
 * Entra ID delivers the AuthnResponse and the LogoutResponse with the
 * HTTP-POST binding, i.e. `application/x-www-form-urlencoded` with a
 * `SAMLResponse` field. It is attached HERE, to the routes that need it,
 * rather than left to whoever wires the app: without it `req.body` is empty,
 * passport-saml sees no `SAMLResponse` and concludes the request is a fresh
 * login *initiation* — so it answers the callback with a brand-new
 * AuthnRequest, the IdP posts the response straight back, and the browser
 * spins in an infinite redirect loop with no error anywhere.
 *
 * `extended: false` is enough (SAML fields are flat) and the limit matches the
 * JSON one: a signed assertion is a few KB, an encrypted one can be larger.
 */
const parseSamlBody = express.urlencoded({ extended: false, limit: '1mb' });

/**
 * Payload shape returned by /me and by a successful break-glass login.
 *
 * The role travels with the profile so the UI can hide what the user cannot do,
 * but it is resolved per request, never read back from the session — see
 * auth/authorization.ts. `status` defaults to 'pending' when no profile could
 * be resolved: an unknown user is an unprofiled one, not an allowed one.
 *
 * `sedeIds` is always a concrete list, including for admins and break-glass
 * sessions, so the client never has to reason about a wildcard.
 */
function toProfile(user: AppUser, authz: AuthProfile | null, allSedeIds: number[]) {
  return {
    nameID: user.nameID,
    // The UPN is what an administrator recognises, and the only address an
    // account without a mailbox has. Break-glass sessions have none.
    upn: isSamlUser(user) ? user.upn : '',
    email: user.email,
    displayName: user.displayName,
    givenName: user.givenName,
    surname: user.surname,
    objectId: user.objectId,
    authMethod: user.authMethod,
    role: authz?.role ?? null,
    status: authz?.status ?? 'pending',
    sedeIds: authz ? (authz.allSedi ? allSedeIds : authz.sedeIds) : [],
  };
}

/**
 * Build the profile payload for a session.
 *
 * Kept off `loadAuthorization` on purpose: that middleware answers 403 for an
 * unprofiled user, and /me is precisely the endpoint that has to tell such a
 * user *why* they are blocked. Answering 403 here would leave the frontend with
 * nothing to show but the sign-in screen, which they would complete
 * successfully, over and over.
 */
async function buildProfile(user: AppUser) {
  let authz: AuthProfile | null = null;
  try {
    authz = await resolveAuthProfile(user);
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Authorization lookup failed while building /me');
  }
  const allSedeIds = authz?.allSedi ? (await listSedi()).map((s) => s.id) : [];
  return toProfile(user, authz, allSedeIds);
}

/** Common audit fields for every break-glass log line. */
function auditContext(req: Request) {
  return {
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? '',
    correlationId: req.correlationId ?? '',
  };
}

/**
 * Mount the break-glass routes.
 *
 * SECURITY NOTE — this path deliberately bypasses Entra Conditional Access and
 * MFA and, by explicit decision, carries no second factor (see COMPLIANCE.md).
 * The controls that stand in for one are all implemented here or in the modules
 * this function pulls in:
 *   - `config.breakGlass.enabled` defaults to false: the feature ships dark
 *   - optional CIDR allowlist, evaluated before anything else
 *   - per-IP sliding-window throttle (per replica) + per-account lockout (in
 *     the database, therefore global)
 *   - a constant-cost password check and one single generic error message, so
 *     neither timing nor wording reveals whether an account exists
 *   - session regeneration on success and a shortened cookie lifetime
 *   - every attempt, allowed or denied, logged at warn level for alerting
 */
function registerBreakGlassRoutes(
  router: Router,
  bg: BreakGlassConfig,
  throttle: LoginThrottle,
  allowlist: IpAllowlist,
): void {
  /**
   * GET /api/auth/breakglass/status
   * Tells the frontend whether to offer the emergency login link at all.
   * Reports `enabled: false` to a client outside the allowlist too, so the
   * endpoint is not advertised to callers that could never use it.
   */
  router.get('/breakglass/status', (req: Request, res: Response) => {
    res.json({
      success: true,
      data: { enabled: bg.enabled && allowlist.allows(req.ip) },
    });
  });

  /**
   * POST /api/auth/breakglass/login
   * Body: { username, password }
   *
   * Returns 404 when the feature is disabled or the caller is outside the
   * allowlist — not 403, which would confirm that the endpoint exists.
   */
  router.post('/breakglass/login', (req: Request, res: Response, next: NextFunction) => {
    if (!bg.enabled) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const ip = req.ip;

    if (!allowlist.allows(ip)) {
      log.warn(
        { event: 'breakglass-login-denied', reason: 'ip-not-allowed', ...auditContext(req) },
        'Break-glass login refused — source IP outside BREAKGLASS_IP_ALLOWLIST',
      );
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    if (!throttle.check(ip)) {
      log.warn(
        { event: 'breakglass-login-denied', reason: 'ip-throttled', ...auditContext(req) },
        'Break-glass login refused — too many attempts from this source IP',
      );
      return res.status(429).json({ success: false, error: BREAKGLASS_GENERIC_ERROR });
    }

    const body = req.body as { username?: unknown; password?: unknown };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (username.length === 0 || password.length === 0) {
      throttle.recordFailure(ip);
      log.warn(
        { event: 'breakglass-login-denied', reason: 'missing-credentials', ...auditContext(req) },
        'Break-glass login refused — username or password missing',
      );
      return res.status(401).json({ success: false, error: BREAKGLASS_GENERIC_ERROR });
    }

    void (async () => {
      try {
        const account = await getBreakGlassAccount(username);

        // Always spend one scrypt derivation, whether or not the account
        // exists, so response latency cannot be used to enumerate usernames.
        const passwordOk = verifyPassword(
          password,
          account?.passwordHash ?? DUMMY_PASSWORD_HASH,
        );

        const now = new Date();
        const locked = account?.lockedUntil != null && account.lockedUntil > now;
        const expired = account?.expiresAt != null && account.expiresAt <= now;

        // Order matters: the lockout, disabled and expired checks come before
        // the password verdict so that a locked account never increments its
        // own counter again. Otherwise sustained guessing would keep extending
        // the lock and the legitimate operator could never wait it out.
        let reason: string | null = null;
        if (!account) {
          reason = 'unknown-account';
        } else if (locked) {
          reason = 'account-locked';
        } else if (!account.enabled) {
          reason = 'account-disabled';
        } else if (expired) {
          reason = 'account-expired';
        } else if (!passwordOk) {
          reason = 'bad-password';
        }

        if (reason !== null) {
          throttle.recordFailure(ip);

          // Only a wrong password counts towards the account lockout.
          if (reason === 'bad-password' && account) {
            const lockedUntil = await registerFailedAttempt(
              account.username,
              bg.maxFailedAttempts,
              bg.lockoutMinutes,
            );
            if (lockedUntil != null && lockedUntil > now) {
              log.warn(
                {
                  event: 'breakglass-account-locked',
                  username: account.username,
                  lockedUntil: lockedUntil.toISOString(),
                  ...auditContext(req),
                },
                'Break-glass account locked after repeated failures',
              );
            }
          }

          log.warn(
            { event: 'breakglass-login-denied', reason, username, ...auditContext(req) },
            'Break-glass login denied',
          );
          return res.status(401).json({ success: false, error: BREAKGLASS_GENERIC_ERROR });
        }

        // `account` is non-null here: `reason` is set whenever it is missing.
        const authenticated = account as NonNullable<typeof account>;
        const user = toBreakGlassUser(authenticated.username, authenticated.displayName);

        // No explicit session.regenerate() here: passport's own
        // SessionManager.logIn() already regenerates before serialising the
        // user, precisely to defeat session fixation. Calling it ourselves
        // first would mean two destroy+create round-trips against the session
        // store on the one code path that has to stay reliable.
        req.login(user, (loginErr: Error | null) => {
          if (loginErr) return next(loginErr);

          // Break-glass sessions expire sooner than SSO ones.
          //
          // This must be re-saved: passport already called session.save()
          // with the default 24 h expiry, and connect-pg-simple derives the
          // row's `expire` column from cookie.expires. Without the second
          // save the browser would stop sending the cookie after the short
          // TTL, but the row would stay valid for 24 h — so a stolen cookie
          // would outlive the window this setting is meant to enforce.
          req.session.cookie.maxAge = bg.sessionTtlMinutes * 60_000;

          req.session.save((saveErr) => {
            if (saveErr) return next(saveErr);

            throttle.reset(ip);

            // Best-effort bookkeeping: a failure here must not deny a login
            // that has already succeeded.
            registerSuccessfulLogin(authenticated.username).catch((err: Error) => {
              log.warn(
                { err: err.message, username: authenticated.username },
                'Could not record break-glass last_login_at',
              );
            });

            // Logged at warn (not info) so a Log Analytics alert can fire on
            // it: a successful break-glass login is an event someone should
            // look at, every single time.
            log.warn(
              {
                event: 'breakglass-login-success',
                username: authenticated.username,
                sessionTtlMinutes: bg.sessionTtlMinutes,
                ...auditContext(req),
              },
              'Break-glass login SUCCEEDED — SSO was bypassed',
            );

            void (async () => {
              const profile = await buildProfile(user);
              res.json({
                success: true,
                data: { ...profile, sessionTtlMinutes: bg.sessionTtlMinutes },
              });
            })();
          });
        });
      } catch (err) {
        // Never leak a database or hashing error to the client: it would
        // distinguish "account exists but something broke" from a plain miss.
        log.error(
          { err: (err as Error).message, username, ...auditContext(req) },
          'Break-glass login failed with an internal error',
        );
        res.status(500).json({ success: false, error: 'Internal Server Error' });
      }
    })();
  });
}

export function createAuthRouter(opts: AuthRouterOptions): Router {
  const { samlEnabled, samlStrategy } = opts;
  const bg = opts.breakGlass ?? config.breakGlass;
  const router = Router();

  // ── Break-glass (mounted regardless of the SAML configuration) ──────────
  const throttle = createLoginThrottle(
    bg.maxAttemptsPerIp,
    bg.ipWindowMinutes * 60_000,
  );
  const allowlist = createIpAllowlist(bg.ipAllowlist);

  if (bg.enabled) {
    log.warn(
      {
        ipAllowlistConfigured: !allowlist.unrestricted,
        sessionTtlMinutes: bg.sessionTtlMinutes,
        maxFailedAttempts: bg.maxFailedAttempts,
      },
      allowlist.unrestricted
        ? 'Break-glass login ENABLED with no IP allowlist — set BREAKGLASS_IP_ALLOWLIST'
        : 'Break-glass login ENABLED',
    );
  }

  registerBreakGlassRoutes(router, bg, throttle, allowlist);

  /**
   * Three states, not two:
   *
   *   - SAML configured AND the strategy was built  → full SSO routes
   *   - SAML configured but the strategy is MISSING → 501 on /login, and /me
   *     answers 401 so the frontend still shows the SSO screen (with the
   *     break-glass link) instead of concluding that SSO does not exist
   *   - SAML not configured at all (local dev)      → /me answers 404, which
   *     tells the frontend to skip the SSO screen entirely
   *
   * Mounting the SSO routes without a strategy is what produced
   * `Unknown authentication strategy "saml"` in production: passport had never
   * received the strategy because an unusable IdP certificate made
   * `createSamlStrategy` return null. A missing strategy must degrade to a
   * clear 501, never to that message.
   */
  const ssoUsable = samlEnabled && samlStrategy != null;

  if (!ssoUsable) {
    const unavailableError = samlEnabled
      ? 'SSO is configured but unavailable: the SAML strategy could not be initialised (see the backend startup logs for the reason — an unusable SAML_CERT is the usual cause). Use the emergency login if it is enabled.'
      : 'SSO (SAML) is not configured. Set SAML_ENTRY_POINT, SAML_ISSUER and SAML_CERT to enable.';

    router.get('/login', (_req: Request, res: Response) => {
      res.status(501).json({ success: false, error: unavailableError });
    });

    router.post('/callback', (_req: Request, res: Response) => {
      res.status(501).json({ success: false, error: unavailableError });
    });

    router.post('/logout', (req: Request, res: Response, next: NextFunction) => {
      req.logout((err) => {
        if (err) return next(err);
        req.session.destroy(() => {
          res.clearCookie('guestportal.sid');
          res.json({ success: true });
        });
      });
    });

    router.post('/slo/callback', (_req: Request, res: Response) => {
      res.status(501).json({ success: false, error: unavailableError });
    });

    router.get('/me', (req: Request, res: Response) => {
      // A break-glass session can exist in both of these states, so return it
      // when present.
      if (req.isAuthenticated() && req.user) {
        void (async () => {
          res.json({ success: true, data: await buildProfile(req.user as AppUser) });
        })();
        return;
      }

      // With SAML configured but broken, answer 401 — "you are not signed in" —
      // so the frontend keeps showing the SSO screen and its emergency-login
      // link. A 404 here would tell it SSO does not exist and send every user
      // straight past the sign-in step.
      if (samlEnabled) {
        return res.status(401).json({ success: false, error: unavailableError });
      }

      // SSO genuinely not configured (local dev): 404 tells the frontend to
      // skip the SSO prompt altogether.
      res.status(404).json({ success: false, error: unavailableError });
    });

    return router;
  }

  // ── SSO enabled ────────────────────────────────────────────────────────

  /**
   * GET /api/auth/login
   * Initiates the SAML authentication flow by redirecting to Entra ID.
   */
  router.get('/login', (req: Request, res: Response, next: NextFunction) => {
    // Validate redirect param to prevent open redirect attacks.
    // Only local (same-origin) paths are allowed.
    const rawRedirect = (req.query.redirect as string) || '/';
    const redirectTo = isLocalUrl(rawRedirect) ? rawRedirect : '/';
    (req.session as unknown as Record<string, unknown>).samlRedirect = redirectTo;
    passport.authenticate('saml')(req, res, next);
  });

  /**
   * POST /api/auth/callback
   * SAML Assertion Consumer Service — Entra ID POSTs the SAML response here.
   * Passport validates the assertion and creates the session.
   *
   * On success the browser is redirected to the frontend (or the saved
   * redirect path). On failure it is redirected to the root with an error.
   */
  router.post('/callback', parseSamlBody, (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate('saml', {
      failureRedirect: '/?sso_error=authentication-failed',
    })(req, res, (err: unknown) => {
      if (err) return next(err);
      if (!req.user) {
        return res.redirect('/?sso_error=authentication-failed');
      }

      const finishRedirect = (): void => {
        const sessionData = req.session as unknown as Record<string, unknown>;
        const redirectTo = (sessionData.samlRedirect as string) || '/';
        delete sessionData.samlRedirect;
        res.redirect(redirectTo);
      };

      // Just-in-time provisioning.
      //
      // It lives here rather than in the strategy's verify callback for two
      // reasons: that callback is registered for the logout flow as well, so a
      // LogoutResponse would trigger an upsert too, and putting a database
      // write in `auth/saml.ts` would turn a pure protocol module into one that
      // cannot be tested without a database.
      //
      // It cannot live in `deserializeUser` either — that runs on every single
      // request.
      void (async () => {
        const user = req.user as AppUser;
        if (!isSamlUser(user)) return finishRedirect();

        try {
          const provisioned = await upsertAppUserFromSaml(user);
          // The row may have been changed by an admin moments ago; make sure
          // this request sees the current state rather than a cached one.
          invalidateAuthProfile(provisioned.subject);

          log.info(
            {
              event: 'sso-jit-provisioning',
              subject: provisioned.subject,
              created: provisioned.created,
              role: provisioned.role,
              status: provisioned.status,
              autoAdmin: provisioned.autoAdmin,
              correlationId: req.correlationId,
            },
            provisioned.autoAdmin
              // Worth its own line at info: privileges granted by a naming
              // convention should be visible in the log, not inferred.
              ? 'SSO user granted platform administrator by the address convention'
              : provisioned.created
                ? 'New SSO user created in pending state — an admin has to profile it before they can work'
                : 'Existing SSO user, directory entry refreshed',
          );
          finishRedirect();
        } catch (err) {
          // Fail closed. No directory row means no authorization, so letting
          // the session stand would leave the user authenticated and refused
          // everywhere, with nothing explaining why.
          log.error(
            { err: (err as Error).message, correlationId: req.correlationId },
            'JIT provisioning failed — destroying the session rather than leaving it half-established',
          );
          req.logout(() =>
            req.session.destroy(() => res.redirect('/?sso_error=provisioning-failed')),
          );
        }
      })();
    });
  });

  /**
   * POST /api/auth/logout
   * Destroys the local session and, if SLO is configured, redirects the
   * browser to the IdP's Single Logout endpoint so the IdP-side session
   * is also terminated.
   *
   * If SLO is unavailable (no strategy, no logoutUrl, or the IdP is down)
   * the local session is still destroyed — the user is logged out of the
   * app even if the IdP session persists.
   */
  router.post('/logout', (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as AppUser | undefined;

    // A break-glass session has no IdP counterpart: its `nameID` is a local
    // username, so handing it to the SAML SLO builder would produce a
    // LogoutRequest for a subject Entra has never heard of. Local logout only.
    if (!user || !samlStrategy || user.authMethod !== 'saml') {
      req.logout(() => {
        req.session.destroy(() => {
          res.clearCookie('guestportal.sid');
          if (user?.authMethod === 'breakglass') {
            log.warn(
              { event: 'breakglass-logout', username: user.nameID, ...auditContext(req) },
              'Break-glass session terminated',
            );
          }
          res.json({ success: true });
        });
      });
      return;
    }

    // Build the SLO redirect URL and redirect the browser to the IdP
    buildSloRedirectUrl(samlStrategy, req)
      .then((redirectUrl) => {
        // Destroy the local session before redirecting
        req.logout(() => {
          req.session.destroy(() => {
            res.clearCookie('guestportal.sid');
            log.info(
              { nameID: user.nameID, email: user.email },
              'Local session destroyed, redirecting to IdP SLO endpoint',
            );
            res.redirect(redirectUrl);
          });
        });
      })
      .catch((err: Error) => {
        // SLO initiation failed — fall back to local logout only
        log.warn(
          { err: err.message, nameID: user.nameID },
          'SLO initiation failed, falling back to local logout',
        );
        req.logout(() => {
          req.session.destroy(() => {
            res.clearCookie('guestportal.sid');
            res.json({ success: true, slo: false });
          });
        });
      });
  });

  /**
   * POST /api/auth/slo/callback
   * Receives the SAML LogoutResponse from the IdP after SLO completes.
   * Passport validates the response and calls req.logout() automatically.
   * The browser is then redirected to the frontend root.
   */
  router.post(
    '/slo/callback',
    parseSamlBody,
    passport.authenticate('saml', {
      successRedirect: '/',
      failureRedirect: '/?sso_error=slo-failed',
    }),
  );

  /**
   * GET /api/auth/me
   * Returns the current user profile from the session.
   * 200 with user data when authenticated, 401 otherwise.
   * `authMethod` tells the frontend whether this is an SSO or break-glass
   * session, so it can surface the emergency-access banner.
   */
  router.get('/me', (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({
        success: false,
        error: 'Not authenticated. Use /api/auth/login to authenticate.',
      });
    }
    void (async () => {
      res.json({ success: true, data: await buildProfile(req.user as AppUser) });
    })();
  });

  return router;
}
