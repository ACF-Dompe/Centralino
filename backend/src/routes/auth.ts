/**
 * Authentication routes for SSO SAML 2.0 via Microsoft Entra ID.
 *
 * Routes (all mounted at /api/auth):
 *   GET  /api/auth/login    — redirect to the IdP (Entra ID)
 *   POST /api/auth/callback — SAML ACS (Assertion Consumer Service)
 *   POST /api/auth/logout   — initiate SLO (redirects to IdP) or local logout
 *   POST /api/auth/slo/callback — SAML LogoutResponse handler
 *   GET  /api/auth/me       — return the current user profile (or 401)
 *
 * When SAML is not configured (local dev), /me returns 404 and /login
 * returns 501 so the frontend knows SSO is unavailable.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import passport from 'passport';
import { log } from '../logger.js';
import type { SamlUser, SamlStrategy } from '../auth/saml.js';
import { buildSloRedirectUrl } from '../auth/saml.js';
import { isLocalUrl } from '../utils/sanitize.js';

interface AuthRouterOptions {
  samlEnabled: boolean;
  samlStrategy?: SamlStrategy;
}

export function createAuthRouter(opts: AuthRouterOptions): Router {
  const { samlEnabled, samlStrategy } = opts;
  const router = Router();

  if (!samlEnabled) {
    // ── SSO disabled (local dev) ──────────────────────────────────────────
    router.get('/login', (_req: Request, res: Response) => {
      res.status(501).json({
        success: false,
        error: 'SSO (SAML) is not configured. Set SAML_ENTRY_POINT, SAML_ISSUER and SAML_CERT to enable.',
      });
    });

    router.post('/callback', (_req: Request, res: Response) => {
      res.status(501).json({ success: false, error: 'SSO is not configured.' });
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
      res.status(501).json({ success: false, error: 'SSO is not configured.' });
    });

    router.get('/me', (_req: Request, res: Response) => {
      // 404 = SSO not available; frontend should skip SSO prompt.
      res.status(404).json({ success: false, error: 'SSO is not configured.' });
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
  router.post('/callback', (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate('saml', {
      failureRedirect: '/?sso_error=authentication-failed',
    })(req, res, (err: unknown) => {
      if (err) return next(err);
      if (!req.user) {
        return res.redirect('/?sso_error=authentication-failed');
      }
      const sessionData = req.session as unknown as Record<string, unknown>;
      const redirectTo = (sessionData.samlRedirect as string) || '/';
      delete sessionData.samlRedirect;
      res.redirect(redirectTo);
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
    const user = req.user as SamlUser | undefined;

    if (!user || !samlStrategy) {
      // No user or no SAML strategy — local logout only
      req.logout(() => {
        req.session.destroy(() => {
          res.clearCookie('guestportal.sid');
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
    passport.authenticate('saml', {
      successRedirect: '/',
      failureRedirect: '/?sso_error=slo-failed',
    }),
  );

  /**
   * GET /api/auth/me
   * Returns the current user profile from the session.
   * 200 with user data when authenticated, 401 otherwise.
   */
  router.get('/me', (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({
        success: false,
        error: 'Not authenticated. Use /api/auth/login to authenticate.',
      });
    }
    const user = req.user as SamlUser;
    res.json({
      success: true,
      data: {
        nameID: user.nameID,
        email: user.email,
        displayName: user.displayName,
        givenName: user.givenName,
        surname: user.surname,
        objectId: user.objectId,
      },
    });
  });

  return router;
}
