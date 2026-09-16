/**
 * Tests for the SAML ACS endpoint body handling (`routes/auth.ts`).
 *
 * Regression under test: an infinite redirect loop between the app and Entra ID.
 *
 * Entra delivers the AuthnResponse with the HTTP-POST binding —
 * `application/x-www-form-urlencoded` carrying a `SAMLResponse` field. The app
 * only mounted `express.json()`, so `req.body` was empty, passport-saml found
 * no `SAMLResponse` and concluded the POST was a fresh login *initiation*: it
 * answered the callback with a brand-new AuthnRequest, the IdP posted the
 * response straight back, and the browser span in a loop with no error logged
 * anywhere. The defect was invisible until the AADSTS75011 fix let Entra reach
 * the ACS at all.
 *
 * The distinguishing signal is therefore the Location header: a callback must
 * NEVER be answered with a redirect to the IdP when a SAMLResponse was posted.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import session from 'express-session';
import passport from 'passport';

vi.mock('../logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../repositories/breakglass.js', () => ({
  getBreakGlassAccount: vi.fn(),
  registerFailedAttempt: vi.fn(),
  registerSuccessfulLogin: vi.fn(),
}));

import { createAuthRouter } from '../routes/auth.js';
import { createSamlStrategy } from '../auth/saml.js';

const IDP = 'https://login.microsoftonline.com/tenant-id/saml2';

/** PEM-shaped placeholder: createSamlStrategy validates the shape up front. */
const strategy = createSamlStrategy({
  entryPoint: IDP,
  issuer: 'https://guestportal.dompe.com/saml',
  callbackUrl: 'https://guestportal.dompe.com/api/auth/callback',
  cert: `-----BEGIN CERTIFICATE-----\nMIIBmTCCAQICCQDL4zPGUJ5x1DANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls\nb2NhbGhvc3QwHhcNMjQwMTAxMDAwMDAwWhcNMzQwMTAxMDAwMDAwWjAUMRIwEAYD\n-----END CERTIFICATE-----`,
});

beforeAll(() => {
  passport.use(strategy!);
  passport.serializeUser((user: unknown, done) => done(null, user as Express.User));
  passport.deserializeUser((obj: unknown, done) => done(null, obj as Express.User));
});

function createApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  // Deliberately NO express.urlencoded() here: the parser has to travel with
  // the routes that need it, so that wiring the app cannot reintroduce the bug.
  app.use(express.json({ limit: '1mb' }));
  app.use(session({ secret: 's', name: 'guestportal.sid', resave: false, saveUninitialized: false }));
  app.use(passport.initialize());
  app.use(passport.session());
  app.use('/api/auth', createAuthRouter({ samlEnabled: true, samlStrategy: strategy! }));
  // Swallow errors so a validation failure is a clean 500 rather than a throw.
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  });
  return app;
}

/** A syntactically valid base64 blob that is not a SAML assertion. */
const GARBAGE_RESPONSE = Buffer.from('<not-a-saml-response/>').toString('base64');

describe('POST /api/auth/callback', () => {
  it('parses a urlencoded SAMLResponse instead of treating it as a new login', async () => {
    const res = await request(createApp())
      .post('/api/auth/callback')
      .type('form')
      .send({ SAMLResponse: GARBAGE_RESPONSE });

    // The response is rejected (garbage assertion) — that is expected. What
    // must NOT happen is a redirect back to the IdP, which is how the loop
    // manifested.
    expect(res.headers.location ?? '').not.toContain('login.microsoftonline.com');
  });

  it('accepts a SAMLResponse large enough to be a real assertion', async () => {
    // The real one in the incident was ~7 KB; the default 100 KB body limit
    // would silently reject a bigger encrypted assertion.
    const big = Buffer.from('<x>' + 'a'.repeat(200_000) + '</x>').toString('base64');
    const res = await request(createApp())
      .post('/api/auth/callback')
      .type('form')
      .send({ SAMLResponse: big });

    expect(res.status).not.toBe(413);
    expect(res.headers.location ?? '').not.toContain('login.microsoftonline.com');
  });

  it('still redirects to the IdP when no SAMLResponse is posted', async () => {
    // Negative control: without this, the assertions above would pass even if
    // passport-saml stopped emitting AuthnRequests altogether.
    const res = await request(createApp())
      .post('/api/auth/callback')
      .type('form')
      .send({});

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('login.microsoftonline.com');
  });

  it('redirects to the IdP from /login, with a SAMLRequest', async () => {
    const res = await request(createApp()).get('/api/auth/login');

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('login.microsoftonline.com');
    expect(res.headers.location).toContain('SAMLRequest=');
  });
});

describe('SAML configured but the strategy could not be built', () => {
  /**
   * The third production symptom: an unusable `SAML_CERT` made
   * `createSamlStrategy` return null, so passport never received the strategy —
   * but the SSO routes were mounted anyway and answered
   * `Unknown authentication strategy "saml"`, which says nothing about the
   * cause. These tests pin the degraded behaviour.
   */
  function createBrokenApp(): express.Express {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 's', name: 'guestportal.sid', resave: false, saveUninitialized: false }));
    app.use(passport.initialize());
    app.use(passport.session());
    // samlEnabled: SAML *is* configured — but no strategy was built.
    app.use('/api/auth', createAuthRouter({ samlEnabled: true, samlStrategy: undefined }));
    return app;
  }

  it('answers /login with 501 rather than "Unknown authentication strategy"', async () => {
    const res = await request(createBrokenApp()).get('/api/auth/login');

    expect(res.status).toBe(501);
    expect(JSON.stringify(res.body)).not.toContain('Unknown authentication strategy');
    expect(res.body.error).toContain('SAML strategy could not be initialised');
  });

  it('points at the startup logs and at the emergency login', async () => {
    const res = await request(createBrokenApp()).get('/api/auth/login');

    expect(res.body.error).toContain('startup logs');
    expect(res.body.error).toContain('SAML_CERT');
    expect(res.body.error).toContain('emergency login');
  });

  it('answers /callback and /slo/callback with 501 too', async () => {
    const app = createBrokenApp();
    for (const path of ['/api/auth/callback', '/api/auth/slo/callback']) {
      const res = await request(app).post(path).type('form').send({ SAMLResponse: 'x' });
      expect(res.status).toBe(501);
    }
  });

  it('answers /me with 401, not 404, so the SSO screen stays visible', async () => {
    // A 404 means "SSO is not configured" to the frontend, which would then
    // skip the sign-in screen — and with it the emergency-login link.
    const res = await request(createBrokenApp()).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('answers /me with 404 when SAML is genuinely not configured', async () => {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 's', name: 'guestportal.sid', resave: false, saveUninitialized: false }));
    app.use(passport.initialize());
    app.use(passport.session());
    app.use('/api/auth', createAuthRouter({ samlEnabled: false }));

    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(404);
  });

  it('keeps the break-glass status endpoint reachable', async () => {
    // The emergency path must survive exactly this situation.
    const res = await request(createBrokenApp()).get('/api/auth/breakglass/status');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/auth/slo/callback', () => {
  it('parses a urlencoded body too', async () => {
    const res = await request(createApp())
      .post('/api/auth/slo/callback')
      .type('form')
      .send({ SAMLResponse: GARBAGE_RESPONSE });

    expect(res.headers.location ?? '').not.toContain('login.microsoftonline.com');
  });
});
