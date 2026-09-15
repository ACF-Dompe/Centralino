/**
 * Integration tests for the break-glass login routes.
 *
 * The repository layer is mocked (no database), but session handling and
 * passport are real so that the session-establishing path is actually
 * exercised. The properties that matter most here are security properties:
 *
 *   - the endpoint is invisible (404) when disabled or when the caller is
 *     outside the CIDR allowlist
 *   - every denial reason returns byte-identical output, so the response
 *     cannot be used to enumerate accounts
 *   - only a wrong password advances the account lockout
 *   - a break-glass session never triggers SAML Single Logout
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import session from 'express-session';
import passport from 'passport';

const mockRepo = vi.hoisted(() => ({
  getBreakGlassAccount: vi.fn(),
  registerFailedAttempt: vi.fn(),
  registerSuccessfulLogin: vi.fn(),
}));
const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../repositories/breakglass.js', () => mockRepo);
vi.mock('../logger.js', () => ({ log: mockLog }));

import { createAuthRouter } from '../routes/auth.js';
import { hashPassword } from '../auth/password.js';

const PASSWORD = 'break-glass-test-password';
const PASSWORD_HASH = hashPassword(PASSWORD);

type BreakGlassConfig = NonNullable<Parameters<typeof createAuthRouter>[0]['breakGlass']>;

const BASE_CONFIG: BreakGlassConfig = {
  enabled: true,
  sessionTtlMinutes: 120,
  maxFailedAttempts: 5,
  lockoutMinutes: 15,
  maxAttemptsPerIp: 10,
  ipWindowMinutes: 15,
  ipAllowlist: '',
};

function account(overrides: Record<string, unknown> = {}) {
  return {
    username: 'bg.operator',
    displayName: 'Break Glass Operator',
    passwordHash: PASSWORD_HASH,
    enabled: true,
    expiresAt: null,
    failedAttempts: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

interface AppOptions {
  breakGlass?: Partial<BreakGlassConfig>;
  samlEnabled?: boolean;
  /** Fake SAML strategy; its `logout` must never be called for break-glass. */
  samlStrategy?: unknown;
}

function createApp(opts: AppOptions = {}): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      name: 'guestportal.sid',
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.use(passport.initialize());
  app.use(passport.session());

  app.use(
    '/api/auth',
    createAuthRouter({
      samlEnabled: opts.samlEnabled ?? false,
      samlStrategy: opts.samlStrategy as never,
      breakGlass: { ...BASE_CONFIG, ...opts.breakGlass },
    }),
  );
  return app;
}

// Passport serialisation is process-global, so register it once.
passport.serializeUser((user: unknown, done) => done(null, user as Express.User));
passport.deserializeUser((obj: unknown, done) => done(null, obj as Express.User));

beforeEach(() => {
  vi.clearAllMocks();
  mockRepo.registerFailedAttempt.mockResolvedValue(null);
  mockRepo.registerSuccessfulLogin.mockResolvedValue(undefined);
});

describe('GET /api/auth/breakglass/status', () => {
  it('reports enabled when the feature is on', async () => {
    const res = await request(createApp()).get('/api/auth/breakglass/status');
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
  });

  it('reports disabled when the feature is off', async () => {
    const res = await request(createApp({ breakGlass: { enabled: false } }))
      .get('/api/auth/breakglass/status');
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
  });

  it('reports disabled to a caller outside the allowlist', async () => {
    const app = createApp({ breakGlass: { ipAllowlist: '10.0.0.0/8' } });
    const denied = await request(app)
      .get('/api/auth/breakglass/status')
      .set('X-Forwarded-For', '203.0.113.9');
    expect(denied.body.data.enabled).toBe(false);

    const allowed = await request(app)
      .get('/api/auth/breakglass/status')
      .set('X-Forwarded-For', '10.1.2.3');
    expect(allowed.body.data.enabled).toBe(true);
  });
});

describe('POST /api/auth/breakglass/login — visibility', () => {
  it('returns 404 when the feature is disabled', async () => {
    const res = await request(createApp({ breakGlass: { enabled: false } }))
      .post('/api/auth/breakglass/login')
      .send({ username: 'bg.operator', password: PASSWORD });
    expect(res.status).toBe(404);
    expect(mockRepo.getBreakGlassAccount).not.toHaveBeenCalled();
  });

  it('returns 404 for a caller outside the allowlist, without touching the DB', async () => {
    const res = await request(createApp({ breakGlass: { ipAllowlist: '10.0.0.0/8' } }))
      .post('/api/auth/breakglass/login')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ username: 'bg.operator', password: PASSWORD });
    expect(res.status).toBe(404);
    expect(mockRepo.getBreakGlassAccount).not.toHaveBeenCalled();
  });

  it('serves a caller inside the allowlist', async () => {
    mockRepo.getBreakGlassAccount.mockResolvedValue(account());
    const res = await request(createApp({ breakGlass: { ipAllowlist: '10.0.0.0/8' } }))
      .post('/api/auth/breakglass/login')
      .set('X-Forwarded-For', '10.1.2.3')
      .send({ username: 'bg.operator', password: PASSWORD });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/auth/breakglass/login — denials', () => {
  it('rejects missing credentials', async () => {
    const app = createApp();
    for (const body of [{}, { username: 'bg.operator' }, { password: PASSWORD }, { username: '  ', password: '' }]) {
      const res = await request(app).post('/api/auth/breakglass/login').send(body);
      expect(res.status).toBe(401);
    }
    expect(mockRepo.getBreakGlassAccount).not.toHaveBeenCalled();
  });

  it('rejects a non-string username or password', async () => {
    const res = await request(createApp())
      .post('/api/auth/breakglass/login')
      .send({ username: { $ne: null }, password: ['x'] });
    expect(res.status).toBe(401);
    expect(mockRepo.getBreakGlassAccount).not.toHaveBeenCalled();
  });

  it('rejects an unknown account without advancing any lockout', async () => {
    mockRepo.getBreakGlassAccount.mockResolvedValue(null);
    const res = await request(createApp())
      .post('/api/auth/breakglass/login')
      .send({ username: 'nope', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(mockRepo.registerFailedAttempt).not.toHaveBeenCalled();
  });

  it('rejects a wrong password and advances the account lockout', async () => {
    mockRepo.getBreakGlassAccount.mockResolvedValue(account());
    const res = await request(createApp())
      .post('/api/auth/breakglass/login')
      .send({ username: 'bg.operator', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(mockRepo.registerFailedAttempt).toHaveBeenCalledWith('bg.operator', 5, 15);
  });

  it('rejects a disabled account without advancing the lockout', async () => {
    mockRepo.getBreakGlassAccount.mockResolvedValue(account({ enabled: false }));
    const res = await request(createApp())
      .post('/api/auth/breakglass/login')
      .send({ username: 'bg.operator', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(mockRepo.registerFailedAttempt).not.toHaveBeenCalled();
  });

  it('rejects an expired account', async () => {
    mockRepo.getBreakGlassAccount.mockResolvedValue(
      account({ expiresAt: new Date(Date.now() - 1000) }),
    );
    const res = await request(createApp())
      .post('/api/auth/breakglass/login')
      .send({ username: 'bg.operator', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(mockRepo.registerFailedAttempt).not.toHaveBeenCalled();
  });

  it('accepts an account whose expiry is still in the future', async () => {
    mockRepo.getBreakGlassAccount.mockResolvedValue(
      account({ expiresAt: new Date(Date.now() + 86_400_000) }),
    );
    const res = await request(createApp())
      .post('/api/auth/breakglass/login')
      .send({ username: 'bg.operator', password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('rejects a locked account even with the right password, and does not extend the lock', async () => {
    mockRepo.getBreakGlassAccount.mockResolvedValue(
      account({ lockedUntil: new Date(Date.now() + 600_000) }),
    );
    const res = await request(createApp())
      .post('/api/auth/breakglass/login')
      .send({ username: 'bg.operator', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(mockRepo.registerFailedAttempt).not.toHaveBeenCalled();
  });

  it('accepts an account whose lock has already expired', async () => {
    mockRepo.getBreakGlassAccount.mockResolvedValue(
      account({ lockedUntil: new Date(Date.now() - 1000) }),
    );
    const res = await request(createApp())
      .post('/api/auth/breakglass/login')
      .send({ username: 'bg.operator', password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('returns byte-identical output for every denial reason (no account enumeration)', async () => {
    const app = createApp();
    const scenarios = [
      { name: 'unknown', value: null, password: PASSWORD },
      { name: 'bad-password', value: account(), password: 'wrong' },
      { name: 'disabled', value: account({ enabled: false }), password: PASSWORD },
      { name: 'expired', value: account({ expiresAt: new Date(Date.now() - 1) }), password: PASSWORD },
      { name: 'locked', value: account({ lockedUntil: new Date(Date.now() + 1000) }), password: PASSWORD },
    ];

    const responses: string[] = [];
    for (const scenario of scenarios) {
      mockRepo.getBreakGlassAccount.mockResolvedValue(scenario.value);
      const res = await request(app)
        .post('/api/auth/breakglass/login')
        .send({ username: 'bg.operator', password: scenario.password });
      expect(res.status).toBe(401);
      responses.push(JSON.stringify(res.body));
    }

    expect(new Set(responses).size).toBe(1);
  });

  it('hides a database failure behind a generic 500', async () => {
    mockRepo.getBreakGlassAccount.mockRejectedValue(new Error('connection refused to pg'));
    const res = await request(createApp())
      .post('/api/auth/breakglass/login')
      .send({ username: 'bg.operator', password: PASSWORD });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('pg');
  });
});

describe('POST /api/auth/breakglass/login — per-IP throttle', () => {
  it('returns 429 once the per-IP budget is spent', async () => {
    mockRepo.getBreakGlassAccount.mockResolvedValue(account());
    const app = createApp({ breakGlass: { maxAttemptsPerIp: 3 } });

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app)
        .post('/api/auth/breakglass/login')
        .set('X-Forwarded-For', '198.51.100.7')
        .send({ username: 'bg.operator', password: 'wrong' });
      expect(res.status).toBe(401);
    }

    const throttled = await request(app)
      .post('/api/auth/breakglass/login')
      .set('X-Forwarded-For', '198.51.100.7')
      .send({ username: 'bg.operator', password: 'wrong' });
    expect(throttled.status).toBe(429);
  });

  it('throttles per source IP, not globally', async () => {
    mockRepo.getBreakGlassAccount.mockResolvedValue(account());
    const app = createApp({ breakGlass: { maxAttemptsPerIp: 2 } });

    for (let i = 0; i < 2; i += 1) {
      await request(app)
        .post('/api/auth/breakglass/login')
        .set('X-Forwarded-For', '198.51.100.7')
        .send({ username: 'bg.operator', password: 'wrong' });
    }

    const other = await request(app)
      .post('/api/auth/breakglass/login')
      .set('X-Forwarded-For', '198.51.100.8')
      .send({ username: 'bg.operator', password: 'wrong' });
    expect(other.status).toBe(401);
  });
});

describe('POST /api/auth/breakglass/login — success', () => {
  beforeEach(() => {
    mockRepo.getBreakGlassAccount.mockResolvedValue(account());
  });

  it('returns the break-glass profile and records the login', async () => {
    const res = await request(createApp())
      .post('/api/auth/breakglass/login')
      .send({ username: 'bg.operator', password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      nameID: 'bg.operator',
      displayName: 'Break Glass Operator',
      authMethod: 'breakglass',
      objectId: null,
      sessionTtlMinutes: 120,
    });
    expect(mockRepo.registerSuccessfulLogin).toHaveBeenCalledWith('bg.operator');
  });

  it('shortens the session cookie to the break-glass TTL', async () => {
    const res = await request(createApp({ breakGlass: { sessionTtlMinutes: 30 } }))
      .post('/api/auth/breakglass/login')
      .send({ username: 'bg.operator', password: PASSWORD });

    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    const cookie = setCookie?.find((c) => c.startsWith('guestportal.sid='));
    expect(cookie).toBeDefined();

    // express-session serialises the lifetime as Expires (derived from
    // cookie.maxAge); some versions also emit Max-Age. Accept either.
    const maxAge = /Max-Age=(\d+)/i.exec(cookie ?? '');
    const expires = /Expires=([^;]+)/i.exec(cookie ?? '');

    const remainingMs = maxAge
      ? Number(maxAge[1]) * 1000
      : new Date(expires?.[1] ?? 0).getTime() - Date.now();

    // ~30 minutes, and unmistakably not the 24 h SSO session.
    expect(remainingMs).toBeGreaterThan(25 * 60_000);
    expect(remainingMs).toBeLessThan(35 * 60_000);
  });

  it('never returns the password hash', async () => {
    const res = await request(createApp())
      .post('/api/auth/breakglass/login')
      .send({ username: 'bg.operator', password: PASSWORD });
    expect(JSON.stringify(res.body)).not.toContain('scrypt');
  });

  it('establishes a session that /me then recognises', async () => {
    const agent = request.agent(createApp({ samlEnabled: true }));

    const unauthenticated = await agent.get('/api/auth/me');
    expect(unauthenticated.status).toBe(401);

    const login = await agent
      .post('/api/auth/breakglass/login')
      .send({ username: 'bg.operator', password: PASSWORD });
    expect(login.status).toBe(200);

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({
      nameID: 'bg.operator',
      authMethod: 'breakglass',
    });
  });

  it('exposes a break-glass session through /me even with SAML switched off', async () => {
    const agent = request.agent(createApp({ samlEnabled: false }));

    // With no session, /me reports 404 = "SSO not configured".
    expect((await agent.get('/api/auth/me')).status).toBe(404);

    await agent
      .post('/api/auth/breakglass/login')
      .send({ username: 'bg.operator', password: PASSWORD });

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.authMethod).toBe('breakglass');
  });

  it('logs the successful bypass at warn level so alerting can fire', async () => {
    await request(createApp())
      .post('/api/auth/breakglass/login')
      .send({ username: 'bg.operator', password: PASSWORD });

    const events = mockLog.warn.mock.calls.map(([ctx]) => (ctx as { event?: string })?.event);
    expect(events).toContain('breakglass-login-success');
  });

  it('clears the per-IP throttle after a successful login', async () => {
    const app = createApp({ breakGlass: { maxAttemptsPerIp: 2 } });

    for (let i = 0; i < 2; i += 1) {
      await request(app)
        .post('/api/auth/breakglass/login')
        .set('X-Forwarded-For', '198.51.100.20')
        .send({ username: 'bg.operator', password: 'wrong' });
    }

    const ok = await request(app)
      .post('/api/auth/breakglass/login')
      .set('X-Forwarded-For', '198.51.100.20')
      .send({ username: 'bg.operator', password: PASSWORD });
    expect(ok.status).toBe(429);

    // A success from a fresh IP resets only that IP's bucket.
    const fresh = await request(app)
      .post('/api/auth/breakglass/login')
      .set('X-Forwarded-For', '198.51.100.21')
      .send({ username: 'bg.operator', password: PASSWORD });
    expect(fresh.status).toBe(200);
  });
});

describe('POST /api/auth/logout with a break-glass session', () => {
  it('does not attempt SAML Single Logout', async () => {
    mockRepo.getBreakGlassAccount.mockResolvedValue(account());

    // A strategy whose logout() would blow up if the route ever reached it:
    // a break-glass nameID is a local username, not a SAML subject.
    const samlStrategy = {
      logout: vi.fn(() => {
        throw new Error('SAML SLO must not be attempted for a break-glass session');
      }),
    };

    const agent = request.agent(createApp({ samlEnabled: true, samlStrategy }));
    await agent
      .post('/api/auth/breakglass/login')
      .send({ username: 'bg.operator', password: PASSWORD });

    const logout = await agent.post('/api/auth/logout');
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ success: true });
    expect(samlStrategy.logout).not.toHaveBeenCalled();

    // The session is really gone.
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
});
