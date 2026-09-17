/**
 * Tests for the authorization middleware.
 *
 * Two properties carry most of the weight here and are worth stating plainly:
 *
 *   - Every failure path is closed. A lookup that throws produces 503, never a
 *     default profile, because an authorization layer that degrades to "allow"
 *     under load is not one.
 *   - The decision is cached but not frozen. It is deliberately NOT kept in the
 *     session, which lives for a day — a suspended user has to lose access in
 *     seconds, not tomorrow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

const mockConfig = vi.hoisted(() => ({
  config: {
    rbac: {
      cacheTtlSeconds: 15,
      enforcement: 'enforce' as 'enforce' | 'log-only',
      autoAdminPrefixes: 'admin365-',
      autoAdminDomains: 'dompe.onmicrosoft.com',
    },
  },
}));
const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const mockAppUsers = vi.hoisted(() => ({
  getAppUserBySubject: vi.fn(),
  samlSubject: vi.fn(),
  isAutoAdmin: vi.fn(),
}));
const mockBreakGlass = vi.hoisted(() => ({ getBreakGlassAccount: vi.fn() }));

vi.mock('../config.js', () => mockConfig);
vi.mock('../logger.js', () => ({ log: mockLog }));
vi.mock('../repositories/appUsers.js', () => mockAppUsers);
vi.mock('../repositories/breakglass.js', () => mockBreakGlass);

import {
  loadAuthorization,
  requireRole,
  requireSedeAccess,
  ensureSedeAllowed,
  allowedSedeIds,
  resolveAuthProfile,
  invalidateAuthProfile,
  clearAuthProfileCache,
} from '../middleware/authorize.js';
import type { AuthProfile } from '../auth/authorization.js';
import { isPlatformAdminEmail } from '../auth/authorization.js';

const samlUser = {
  authMethod: 'saml' as const,
  nameID: 'mario.rossi@dompe.com',
  email: 'mario.rossi@dompe.com',
  displayName: 'Mario Rossi',
  givenName: 'Mario',
  surname: 'Rossi',
  objectId: 'oid-123',
  raw: {},
};

const breakGlassUser = {
  authMethod: 'breakglass' as const,
  nameID: 'bk.guestportal',
  displayName: 'Break Glass',
  email: '',
  givenName: '',
  surname: '',
  objectId: null,
};

function directoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    subject: 'oid-123',
    entraObjectId: 'oid-123',
    email: 'mario.rossi@dompe.com',
    displayName: 'Mario Rossi',
    givenName: 'Mario',
    surname: 'Rossi',
    role: 'operator',
    status: 'active',
    sedeIds: [1, 3],
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
    profiledAt: null,
    profiledBy: null,
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
}

function mockReq(user: unknown, extra: Record<string, unknown> = {}) {
  return { user, path: '/api/guests', method: 'GET', ...extra } as unknown as Request;
}

/** Run the middleware and settle its internal async work. */
async function run(fn: () => void): Promise<void> {
  fn();
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAuthProfileCache();
  mockConfig.config.rbac.cacheTtlSeconds = 15;
  mockConfig.config.rbac.enforcement = 'enforce';
  mockAppUsers.samlSubject.mockImplementation((u: { objectId?: string }) => u.objectId ?? null);
  mockAppUsers.isAutoAdmin.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveAuthProfile', () => {
  it('builds a profile from the directory entry', async () => {
    mockAppUsers.getAppUserBySubject.mockResolvedValue(directoryRow());
    const profile = await resolveAuthProfile(samlUser);

    expect(profile).toMatchObject({
      subject: 'oid-123',
      userId: 7,
      source: 'app_user',
      role: 'operator',
      status: 'active',
      sedeIds: [1, 3],
      allSedi: false,
    });
  });

  it('gives an admin every sede', async () => {
    mockAppUsers.getAppUserBySubject.mockResolvedValue(directoryRow({ role: 'admin' }));
    const profile = await resolveAuthProfile(samlUser);
    expect(profile?.allSedi).toBe(true);
  });

  it('returns null when the user is not in the directory', async () => {
    mockAppUsers.getAppUserBySubject.mockResolvedValue(null);
    expect(await resolveAuthProfile(samlUser)).toBeNull();
  });

  it('returns null when the assertion identifies nobody', async () => {
    mockAppUsers.samlSubject.mockReturnValue(null);
    expect(await resolveAuthProfile(samlUser)).toBeNull();
    expect(mockAppUsers.getAppUserBySubject).not.toHaveBeenCalled();
  });

  /**
   * Break-glass authorization comes from its own table and never from the
   * directory. It is the account that has to work when everything else is
   * broken, so a bad row in `app_users` must not be able to close the last door.
   */
  it('resolves a break-glass session without touching the directory', async () => {
    mockBreakGlass.getBreakGlassAccount.mockResolvedValue({
      username: 'bk.guestportal',
      displayName: 'Break Glass',
      role: 'admin',
      enabled: true,
      expiresAt: null,
    });

    const profile = await resolveAuthProfile(breakGlassUser);

    expect(profile).toMatchObject({ source: 'breakglass', role: 'admin', status: 'active', allSedi: true });
    expect(mockAppUsers.getAppUserBySubject).not.toHaveBeenCalled();
  });

  it('treats a disabled break-glass account as suspended', async () => {
    mockBreakGlass.getBreakGlassAccount.mockResolvedValue({
      username: 'bk.guestportal', displayName: 'BG', role: 'admin', enabled: false, expiresAt: null,
    });
    expect((await resolveAuthProfile(breakGlassUser))?.status).toBe('suspended');
  });

  it('treats an expired break-glass account as suspended', async () => {
    mockBreakGlass.getBreakGlassAccount.mockResolvedValue({
      username: 'bk.guestportal', displayName: 'BG', role: 'admin', enabled: true,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect((await resolveAuthProfile(breakGlassUser))?.status).toBe('suspended');
  });

  describe('caching', () => {
    it('serves a second lookup from the cache', async () => {
      mockAppUsers.getAppUserBySubject.mockResolvedValue(directoryRow());
      await resolveAuthProfile(samlUser);
      await resolveAuthProfile(samlUser);
      expect(mockAppUsers.getAppUserBySubject).toHaveBeenCalledTimes(1);
    });

    it('looks the profile up again once the TTL passes', async () => {
      vi.useFakeTimers();
      mockAppUsers.getAppUserBySubject.mockResolvedValue(directoryRow());
      await resolveAuthProfile(samlUser);

      vi.advanceTimersByTime(16_000);
      await resolveAuthProfile(samlUser);

      expect(mockAppUsers.getAppUserBySubject).toHaveBeenCalledTimes(2);
    });

    /**
     * What an admin's change relies on: the replica that served the change
     * reflects it at once, and everywhere else the TTL bounds the delay.
     */
    it('drops the cached decision on invalidation', async () => {
      mockAppUsers.getAppUserBySubject.mockResolvedValue(directoryRow());
      await resolveAuthProfile(samlUser);

      invalidateAuthProfile('oid-123');
      mockAppUsers.getAppUserBySubject.mockResolvedValue(directoryRow({ status: 'suspended' }));

      expect((await resolveAuthProfile(samlUser))?.status).toBe('suspended');
      expect(mockAppUsers.getAppUserBySubject).toHaveBeenCalledTimes(2);
    });

    it('does not cache a missing user', async () => {
      mockAppUsers.getAppUserBySubject.mockResolvedValue(null);
      await resolveAuthProfile(samlUser);
      await resolveAuthProfile(samlUser);
      expect(mockAppUsers.getAppUserBySubject).toHaveBeenCalledTimes(2);
    });
  });
});

describe('loadAuthorization', () => {
  it('populates req.authz and continues for an active user', async () => {
    mockAppUsers.getAppUserBySubject.mockResolvedValue(directoryRow());
    const req = mockReq(samlUser);
    const res = mockRes();
    const next = vi.fn();

    await run(() => loadAuthorization(req, res, next));

    expect(next).toHaveBeenCalledOnce();
    expect(req.authz).toMatchObject({ role: 'operator', status: 'active' });
  });

  /**
   * 403 and not 401. The user authenticated perfectly well; telling them to
   * sign in again would send them round a loop that cannot end.
   */
  it('answers 403 user_not_provisioned for an unknown user', async () => {
    mockAppUsers.getAppUserBySubject.mockResolvedValue(null);
    const res = mockRes();
    const next = vi.fn();

    await run(() => loadAuthorization(mockReq(samlUser), res, next));

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('user_not_provisioned');
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 403 user_not_provisioned for a pending user', async () => {
    mockAppUsers.getAppUserBySubject.mockResolvedValue(directoryRow({ status: 'pending' }));
    const res = mockRes();
    const next = vi.fn();

    await run(() => loadAuthorization(mockReq(samlUser), res, next));

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('user_not_provisioned');
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 403 user_suspended for a suspended user', async () => {
    mockAppUsers.getAppUserBySubject.mockResolvedValue(directoryRow({ status: 'suspended' }));
    const res = mockRes();
    const next = vi.fn();

    await run(() => loadAuthorization(mockReq(samlUser), res, next));

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('user_suspended');
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 503 rather than assuming a role when the lookup fails', async () => {
    mockAppUsers.getAppUserBySubject.mockRejectedValue(new Error('db down'));
    const req = mockReq(samlUser);
    const res = mockRes();
    const next = vi.fn();

    await run(() => loadAuthorization(req, res, next));

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('authz_unavailable');
    expect(next).not.toHaveBeenCalled();
    expect(req.authz).toBeUndefined();
  });

  it('answers 401 when there is no session user at all', async () => {
    const res = mockRes();
    const next = vi.fn();

    await run(() => loadAuthorization(mockReq(undefined), res, next));

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  /**
   * The rollout valve: record what would have been refused, let it through, and
   * keep a working system working while the directory fills up. It is not the
   * default, and a deployment that turns it on says so in the logs.
   */
  describe('with RBAC_ENFORCEMENT=log-only', () => {
    beforeEach(() => { mockConfig.config.rbac.enforcement = 'log-only'; });

    it('lets an unprofiled user through and records the refusal', async () => {
      mockAppUsers.getAppUserBySubject.mockResolvedValue(null);
      const res = mockRes();
      const next = vi.fn();

      await run(() => loadAuthorization(mockReq(samlUser), res, next));

      expect(next).toHaveBeenCalledOnce();
      expect(res.statusCode).toBe(0);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'authz-would-deny', reason: 'user_not_provisioned' }),
        expect.any(String),
      );
    });

    it('still fails closed when the lookup itself breaks', async () => {
      mockAppUsers.getAppUserBySubject.mockRejectedValue(new Error('db down'));
      const res = mockRes();
      const next = vi.fn();

      await run(() => loadAuthorization(mockReq(samlUser), res, next));

      expect(res.statusCode).toBe(503);
      expect(next).not.toHaveBeenCalled();
    });
  });
});

describe('requireRole', () => {
  const profile = (role: string) => ({ role, allSedi: false, sedeIds: [1], subject: 's' } as unknown as AuthProfile);

  it('allows a listed role', () => {
    const req = mockReq(samlUser, { authz: profile('operator') });
    const res = mockRes();
    const next = vi.fn();

    requireRole('admin', 'operator')(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('refuses an unlisted role and says which were required', () => {
    const req = mockReq(samlUser, { authz: profile('viewer') });
    const res = mockRes();
    const next = vi.fn();

    requireRole('admin', 'operator')(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('insufficient_role');
    expect(res.body.requiredRoles).toEqual(['admin', 'operator']);
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 503 when no profile was resolved', () => {
    const res = mockRes();
    const next = vi.fn();

    requireRole('admin')(mockReq(samlUser), res, next);

    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireSedeAccess', () => {
  const operator = { role: 'operator', allSedi: false, sedeIds: [1, 3], subject: 's' } as unknown as AuthProfile;
  const admin = { role: 'admin', allSedi: true, sedeIds: [], subject: 'a' } as unknown as AuthProfile;

  it('allows a granted sede from the body', () => {
    const req = mockReq(samlUser, { authz: operator, body: { sedeId: 3 }, query: {} });
    const next = vi.fn();
    requireSedeAccess()(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('allows a granted sede from the query string', () => {
    const req = mockReq(samlUser, { authz: operator, body: {}, query: { sedeId: '1' } });
    const next = vi.fn();
    requireSedeAccess()(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('refuses a sede outside the grant', () => {
    const req = mockReq(samlUser, { authz: operator, body: { sedeId: 2 }, query: {} });
    const res = mockRes();
    const next = vi.fn();

    requireSedeAccess()(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('sede_forbidden');
    expect(next).not.toHaveBeenCalled();
  });

  /**
   * "No sede" used to mean "fall back to the first row", which is how an action
   * on one site could reach another site's controller. It is refused now.
   */
  it('refuses a request that names no sede', () => {
    const req = mockReq(samlUser, { authz: operator, body: {}, query: {} });
    const res = mockRes();
    const next = vi.fn();

    requireSedeAccess()(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('sede_required');
    expect(next).not.toHaveBeenCalled();
  });

  it('lets an admin reach any sede', () => {
    const req = mockReq(samlUser, { authz: admin, body: { sedeId: 99 }, query: {} });
    const next = vi.fn();
    requireSedeAccess()(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('honours a custom extractor', () => {
    const req = mockReq(samlUser, { authz: operator, params: { id: '3' }, body: {}, query: {} });
    const next = vi.fn();
    requireSedeAccess((r) => Number((r.params as { id: string }).id))(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('ensureSedeAllowed', () => {
  const operator = { role: 'operator', allSedi: false, sedeIds: [1], subject: 's' } as unknown as AuthProfile;
  const admin = { role: 'admin', allSedi: true, sedeIds: [], subject: 'a' } as unknown as AuthProfile;

  it('returns true for a granted sede', () => {
    const res = mockRes();
    expect(ensureSedeAllowed(mockReq(samlUser, { authz: operator }), res, 1)).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('answers 403 and returns false otherwise', () => {
    const res = mockRes();
    expect(ensureSedeAllowed(mockReq(samlUser, { authz: operator }), res, 5)).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  /**
   * Guests imported before sites existed carry no sede. Only an admin has a
   * wide enough remit to touch them.
   */
  it('lets an admin, but not an operator, act on a guest with no sede', () => {
    expect(ensureSedeAllowed(mockReq(samlUser, { authz: admin }), mockRes(), null)).toBe(true);
    expect(ensureSedeAllowed(mockReq(samlUser, { authz: operator }), mockRes(), null)).toBe(false);
  });
});

describe('allowedSedeIds', () => {
  /**
   * null and [] mean opposite things and must never be conflated: null is an
   * admin who sees everything, [] is a user granted nothing who must see
   * nothing — the wrong way round would show them every site.
   */
  it('returns null for an unrestricted profile', () => {
    expect(allowedSedeIds({ allSedi: true, sedeIds: [] } as unknown as AuthProfile)).toBeNull();
  });

  it('returns the empty list for a user with no grants', () => {
    expect(allowedSedeIds({ allSedi: false, sedeIds: [] } as unknown as AuthProfile)).toEqual([]);
  });

  it('returns the granted ids', () => {
    expect(allowedSedeIds({ allSedi: false, sedeIds: [2, 4] } as unknown as AuthProfile)).toEqual([2, 4]);
  });
});

/**
 * The platform-administrator convention.
 *
 * It grants full privileges from a string in an address, so the tests pin both
 * halves of the rule: the prefix AND the domain. The domain is what stops an
 * Entra guest account from qualifying — a B2B invitee's UPN belongs to their own
 * tenant, so without it an invited `admin365-x@attacker.com` would arrive as an
 * administrator of this platform.
 */
describe('isPlatformAdminEmail', () => {
  const opts = { prefixes: 'admin365-', domains: 'dompe.onmicrosoft.com' };

  it('accepts the convention', () => {
    expect(isPlatformAdminEmail('admin365-tommaso@dompe.onmicrosoft.com', opts)).toBe(true);
    expect(isPlatformAdminEmail('admin365-x@dompe.onmicrosoft.com', opts)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isPlatformAdminEmail('Admin365-Tommaso@Dompe.OnMicrosoft.Com', opts)).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isPlatformAdminEmail('  admin365-x@dompe.onmicrosoft.com  ', opts)).toBe(true);
  });

  it('refuses the prefix on any other domain', () => {
    expect(isPlatformAdminEmail('admin365-x@dompe.com', opts)).toBe(false);
    expect(isPlatformAdminEmail('admin365-x@attacker.com', opts)).toBe(false);
    // The sharp edge: an Entra guest brings their own tenant's domain.
    expect(isPlatformAdminEmail('admin365-evil@outlook.com', opts)).toBe(false);
  });

  it('refuses a different prefix on the right domain', () => {
    expect(isPlatformAdminEmail('admin-x@dompe.onmicrosoft.com', opts)).toBe(false);
    expect(isPlatformAdminEmail('tommaso@dompe.onmicrosoft.com', opts)).toBe(false);
  });

  it('requires the prefix at the start, not anywhere in the address', () => {
    expect(isPlatformAdminEmail('not-admin365-x@dompe.onmicrosoft.com', opts)).toBe(false);
    expect(isPlatformAdminEmail('x.admin365-y@dompe.onmicrosoft.com', opts)).toBe(false);
  });

  /** `admin365-<something>`: a bare prefix is not an account anybody means. */
  it('requires something after the prefix', () => {
    expect(isPlatformAdminEmail('admin365-@dompe.onmicrosoft.com', opts)).toBe(false);
  });

  it('refuses a subdomain of the allowed domain', () => {
    expect(isPlatformAdminEmail('admin365-x@evil.dompe.onmicrosoft.com', opts)).toBe(false);
  });

  /**
   * Fail closed, and deliberately the opposite of how the other list-shaped
   * settings behave: an empty domain list turns the rule off rather than
   * opening it to every domain.
   */
  it('is disabled when no domain is configured', () => {
    expect(isPlatformAdminEmail('admin365-x@dompe.onmicrosoft.com', { prefixes: 'admin365-', domains: '' })).toBe(false);
  });

  it('is disabled when no prefix is configured', () => {
    expect(isPlatformAdminEmail('admin365-x@dompe.onmicrosoft.com', { prefixes: '', domains: 'dompe.onmicrosoft.com' })).toBe(false);
  });

  it('handles several prefixes and domains', () => {
    const many = { prefixes: 'admin365-, svc-', domains: 'dompe.onmicrosoft.com, dompe.com' };
    expect(isPlatformAdminEmail('svc-deploy@dompe.com', many)).toBe(true);
    expect(isPlatformAdminEmail('admin365-x@dompe.com', many)).toBe(true);
    expect(isPlatformAdminEmail('other@dompe.com', many)).toBe(false);
  });

  it('refuses anything that is not an address', () => {
    for (const value of [null, undefined, '', 'not-an-address', '@dompe.onmicrosoft.com', 'admin365-x@']) {
      expect(isPlatformAdminEmail(value, opts)).toBe(false);
    }
  });
});

describe('resolveAuthProfile with the platform-administrator convention', () => {
  /**
   * The rule is enforced here as well as at provisioning time, so a row edited
   * straight in the database — or an accidental demotion — cannot lock a
   * platform administrator out of the panel.
   */
  it('overrides a directory row that says otherwise', async () => {
    mockAppUsers.isAutoAdmin.mockReturnValue(true);
    mockAppUsers.getAppUserBySubject.mockResolvedValue(
      directoryRow({ role: 'viewer', status: 'suspended', email: 'admin365-x@dompe.onmicrosoft.com' }),
    );

    const profile = await resolveAuthProfile(samlUser);

    expect(profile).toMatchObject({ role: 'admin', status: 'active', allSedi: true });
  });

  it('leaves an ordinary user alone', async () => {
    mockAppUsers.isAutoAdmin.mockReturnValue(false);
    mockAppUsers.getAppUserBySubject.mockResolvedValue(directoryRow({ role: 'viewer', status: 'suspended' }));

    const profile = await resolveAuthProfile(samlUser);

    expect(profile).toMatchObject({ role: 'viewer', status: 'suspended' });
  });

  /** The convention says nothing about accounts that are not in the directory. */
  it('does not conjure a profile for a user with no directory row', async () => {
    mockAppUsers.isAutoAdmin.mockReturnValue(true);
    mockAppUsers.getAppUserBySubject.mockResolvedValue(null);

    expect(await resolveAuthProfile(samlUser)).toBeNull();
  });
});
