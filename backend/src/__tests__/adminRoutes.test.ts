/**
 * Tests for the administrative API.
 *
 * Two things this file exists to hold in place, both of which would be quiet
 * failures rather than loud ones:
 *
 *   - The break-glass surface is read-mostly. There is no HTTP route that can
 *     create an account or rotate a password, because those credentials bypass
 *     Entra and MFA entirely (COMPLIANCE.md D1) and a compromised admin session
 *     must not be able to mint one.
 *   - No response ever carries a password hash or a WLC password.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockAppUsers = vi.hoisted(() => ({
  listAppUsers: vi.fn(),
  getAppUserById: vi.fn(),
  updateAppUserProfile: vi.fn(),
  replaceAppUserSedi: vi.fn(),
  countActiveAdmins: vi.fn(),
  deleteAppUser: vi.fn(),
}));

const mockBreakGlass = vi.hoisted(() => ({
  listBreakGlassAccountsForAdmin: vi.fn(),
  setBreakGlassEnabled: vi.fn(),
  unlockBreakGlassAccount: vi.fn(),
  countUsableBreakGlassAccounts: vi.fn(),
  getBreakGlassAccount: vi.fn(),
}));

const mockRepo = vi.hoisted(() => ({
  listSediAdmin: vi.fn(),
  getAdminSedeById: vi.fn(),
  getSedeByCode: vi.fn(),
  createSede: vi.fn(),
  updateSede: vi.fn(),
  setSedeActive: vi.fn(),
  recordWlcCheck: vi.fn(),
  deleteSede: vi.fn(),
  countGuestsBySede: vi.fn(),
  credentialNamesForSedeCode: vi.fn((code: string) => ({
    envVar: `WLC_PASSWORD_${code}`,
    secretName: `WLC-PASSWORD-${code}`,
  })),
  addSyncLog: vi.fn(),
}));

const mockWlcWebui = vi.hoisted(() => ({ loginWebUi: vi.fn() }));
const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const mockAuthorize = vi.hoisted(() => ({ invalidateAuthProfile: vi.fn() }));

vi.mock('../repositories/appUsers.js', () => mockAppUsers);
vi.mock('../repositories/breakglass.js', () => mockBreakGlass);
vi.mock('../repositories/index.js', () => mockRepo);
vi.mock('../services/wlcWebui.js', () => mockWlcWebui);
vi.mock('../logger.js', () => ({ log: mockLog }));
vi.mock('../middleware/authorize.js', () => mockAuthorize);

import { createAdminRouter } from '../routes/admin.js';

const ADMIN = {
  subject: 'admin@dompe.com',
  userId: 1,
  source: 'app_user',
  role: 'admin',
  status: 'active',
  sedeIds: [],
  allSedi: true,
  displayName: 'Admin',
  email: 'admin@dompe.com',
};

let authz: Record<string, unknown> = ADMIN;

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.authz = authz; next(); });
  app.use('/api/admin', createAdminRouter());
  return app;
}

function directoryUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    subject: 'oid-7',
    email: 'mario@dompe.com',
    displayName: 'Mario Rossi',
    entraObjectId: 'oid-7',
    role: 'viewer',
    status: 'pending',
    sedeIds: [],
    createdAt: new Date('2026-01-01'),
    lastLoginAt: null,
    profiledAt: null,
    profiledBy: null,
    ...overrides,
  };
}

function adminSede(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    code: 'MIL',
    name: 'Milano',
    city: 'Milano',
    address: null,
    wlcConfigId: null,
    createdAt: '2026-01-01T00:00:00Z',
    active: true,
    wlcHost: '172.18.106.100',
    wlcPort: 443,
    wlcSshPort: 22,
    wlcUsername: 'admin_guest',
    wlcSsid: 'Dompe Guest',
    credentialConfigured: true,
    credentialEnvVar: 'WLC_PASSWORD_MIL',
    credentialSecretName: 'WLC-PASSWORD-MIL',
    wlcLastCheckAt: null,
    wlcLastCheckOk: null,
    wlcLastCheckError: null,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  authz = ADMIN;
  process.env.WLC_PASSWORD_MIL = 'test-wlc-pass';
  mockAppUsers.countActiveAdmins.mockResolvedValue(2);
  mockBreakGlass.countUsableBreakGlassAccounts.mockResolvedValue(1);
  mockRepo.listSediAdmin.mockResolvedValue([adminSede()]);
  mockRepo.getAdminSedeById.mockResolvedValue(adminSede());
  app = createApp();
});

describe('users', () => {
  it('lists the directory', async () => {
    mockAppUsers.listAppUsers.mockResolvedValue([directoryUser()]);
    const res = await request(app).get('/api/admin/users');

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ id: 7, role: 'viewer', status: 'pending' });
  });

  it('filters by status', async () => {
    mockAppUsers.listAppUsers.mockResolvedValue([]);
    await request(app).get('/api/admin/users?status=pending');
    expect(mockAppUsers.listAppUsers).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
    );
  });

  it('ignores a status that is not one of the three', async () => {
    mockAppUsers.listAppUsers.mockResolvedValue([]);
    await request(app).get('/api/admin/users?status=banana');
    expect(mockAppUsers.listAppUsers).toHaveBeenCalledWith(
      expect.objectContaining({ status: undefined }),
    );
  });

  it('profiles a user and records who did it', async () => {
    mockAppUsers.getAppUserById.mockResolvedValue(directoryUser());
    mockAppUsers.updateAppUserProfile.mockResolvedValue(
      directoryUser({ role: 'operator', status: 'active' }),
    );

    const res = await request(app)
      .patch('/api/admin/users/7')
      .send({ role: 'operator', status: 'active', sedeIds: [1] });

    expect(res.status).toBe(200);
    expect(mockAppUsers.replaceAppUserSedi).toHaveBeenCalledWith(7, [1]);
    expect(mockAppUsers.updateAppUserProfile).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ role: 'operator', status: 'active', profiledBy: 'admin@dompe.com' }),
    );
  });

  /** Immediate on this replica; elsewhere the cache TTL bounds the delay. */
  it('invalidates the cached authorization for the user it changed', async () => {
    mockAppUsers.getAppUserById.mockResolvedValue(directoryUser());
    mockAppUsers.updateAppUserProfile.mockResolvedValue(directoryUser({ status: 'active' }));

    await request(app).patch('/api/admin/users/7').send({ status: 'active' });

    expect(mockAuthorize.invalidateAuthProfile).toHaveBeenCalledWith('oid-7');
  });

  /** At warn, so an alert can watch for promotions to admin without a new rule. */
  it('audits the change', async () => {
    mockAppUsers.getAppUserById.mockResolvedValue(directoryUser());
    mockAppUsers.updateAppUserProfile.mockResolvedValue(directoryUser({ role: 'admin' }));

    await request(app).patch('/api/admin/users/7').send({ role: 'admin' });

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'admin-user-updated', actor: 'admin@dompe.com', target: 'oid-7' }),
      expect.any(String),
    );
  });

  it('rejects a role that is not one of the three', async () => {
    mockAppUsers.getAppUserById.mockResolvedValue(directoryUser());
    const res = await request(app).patch('/api/admin/users/7').send({ role: 'superuser' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
    expect(mockAppUsers.updateAppUserProfile).not.toHaveBeenCalled();
  });

  it('rejects a sede that does not exist', async () => {
    mockAppUsers.getAppUserById.mockResolvedValue(directoryUser());
    mockRepo.getAdminSedeById.mockResolvedValue(null);

    const res = await request(app).patch('/api/admin/users/7').send({ sedeIds: [99] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_sede');
    expect(mockAppUsers.replaceAppUserSedi).not.toHaveBeenCalled();
  });

  /**
   * An admin demoting themselves by mistake leaves a directory where every
   * remaining user is blocked and nobody can unblock them.
   */
  it('refuses to let an admin change their own role', async () => {
    mockAppUsers.getAppUserById.mockResolvedValue(directoryUser({ id: 1, role: 'admin', status: 'active' }));

    const res = await request(app).patch('/api/admin/users/1').send({ role: 'viewer' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_modify_self');
    expect(mockAppUsers.updateAppUserProfile).not.toHaveBeenCalled();
  });

  it('still lets an admin change their own sites', async () => {
    mockAppUsers.getAppUserById.mockResolvedValue(directoryUser({ id: 1, role: 'admin', status: 'active' }));
    const res = await request(app).patch('/api/admin/users/1').send({ sedeIds: [1] });
    expect(res.status).toBe(200);
  });

  it('refuses to remove the last active admin', async () => {
    mockAppUsers.getAppUserById.mockResolvedValue(directoryUser({ id: 9, role: 'admin', status: 'active' }));
    mockAppUsers.countActiveAdmins.mockResolvedValue(0);

    const res = await request(app).patch('/api/admin/users/9').send({ status: 'suspended' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('last_admin');
    expect(mockAppUsers.updateAppUserProfile).not.toHaveBeenCalled();
  });

  it('allows demoting an admin while another remains', async () => {
    mockAppUsers.getAppUserById.mockResolvedValue(directoryUser({ id: 9, role: 'admin', status: 'active' }));
    mockAppUsers.countActiveAdmins.mockResolvedValue(1);
    mockAppUsers.updateAppUserProfile.mockResolvedValue(directoryUser({ id: 9, role: 'operator' }));

    const res = await request(app).patch('/api/admin/users/9').send({ role: 'operator' });
    expect(res.status).toBe(200);
  });

  it('returns 404 for an unknown user', async () => {
    mockAppUsers.getAppUserById.mockResolvedValue(null);
    const res = await request(app).patch('/api/admin/users/404').send({ role: 'operator' });
    expect(res.status).toBe(404);
  });
});

describe('sedi', () => {
  it('lists every site, in service or not', async () => {
    const res = await request(app).get('/api/admin/sedi');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('never returns a WLC password', async () => {
    const res = await request(app).get('/api/admin/sedi');
    expect(JSON.stringify(res.body)).not.toContain('test-wlc-pass');
    expect(res.body.data[0].password).toBeUndefined();
    // Only whether one exists, and the names to ask for.
    expect(res.body.data[0].credentialConfigured).toBe(true);
    expect(res.body.data[0].credentialSecretName).toBe('WLC-PASSWORD-MIL');
  });

  it('creates a site out of service, since its secret does not exist yet', async () => {
    mockRepo.getSedeByCode.mockResolvedValue(null);
    mockRepo.listSediAdmin.mockResolvedValue([]);
    mockRepo.createSede.mockResolvedValue(adminSede({ code: 'TOR', active: false }));

    const res = await request(app)
      .post('/api/admin/sedi')
      .send({ code: 'TOR', name: 'Torino', city: 'Torino', wlcHost: '10.0.0.9' });

    expect(res.status).toBe(201);
    expect(mockRepo.createSede).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'TOR', active: false }),
      'admin@dompe.com',
    );
  });

  it('rejects a code that is not two to twenty letters and digits', async () => {
    const res = await request(app)
      .post('/api/admin/sedi')
      .send({ code: 'to-rino!', name: 'Torino', city: 'Torino' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_code');
    expect(mockRepo.createSede).not.toHaveBeenCalled();
  });

  it('rejects a duplicate code', async () => {
    mockRepo.getSedeByCode.mockResolvedValue(adminSede());
    const res = await request(app)
      .post('/api/admin/sedi')
      .send({ code: 'MIL', name: 'Milano 2', city: 'Milano' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('duplicate_code');
  });

  /**
   * The code becomes an environment variable name, and the normalisation that
   * produces it is lossy: two different codes can land on the same variable and
   * silently share one controller password.
   */
  it('rejects a code that collides once normalised', async () => {
    mockRepo.getSedeByCode.mockResolvedValue(null);
    mockRepo.listSediAdmin.mockResolvedValue([adminSede({ code: 'SM1' })]);
    mockRepo.credentialNamesForSedeCode.mockReturnValue({
      envVar: 'WLC_PASSWORD_SM1',
      secretName: 'WLC-PASSWORD-SM1',
    });

    const res = await request(app)
      .post('/api/admin/sedi')
      .send({ code: 'SM1', name: 'San Mateo', city: 'San Mateo' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('credential_collision');
    expect(mockRepo.createSede).not.toHaveBeenCalled();
  });

  it('rejects a host that would inject into an SSH command', async () => {
    mockRepo.getSedeByCode.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/admin/sedi')
      .send({ code: 'TOR', name: 'Torino', city: 'Torino', wlcHost: '10.0.0.1; rm -rf /' });

    expect(res.status).toBe(400);
    expect(mockRepo.createSede).not.toHaveBeenCalled();
  });

  it('rejects a port outside the valid range', async () => {
    mockRepo.getSedeByCode.mockResolvedValue(null);
    mockRepo.listSediAdmin.mockResolvedValue([]);
    const res = await request(app)
      .post('/api/admin/sedi')
      .send({ code: 'TOR', name: 'Torino', city: 'Torino', wlcPort: 99999 });

    expect(res.status).toBe(400);
  });

  /** Changing it would detach the site from its Key Vault secret. */
  it('refuses to change a site code', async () => {
    const res = await request(app).put('/api/admin/sedi/1').send({ code: 'MILANO', name: 'Milano' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('code_immutable');
    expect(mockRepo.updateSede).not.toHaveBeenCalled();
  });

  it('updates the other fields', async () => {
    mockRepo.updateSede.mockResolvedValue(adminSede({ name: 'Milano HQ' }));
    const res = await request(app).put('/api/admin/sedi/1').send({ name: 'Milano HQ' });

    expect(res.status).toBe(200);
    expect(mockRepo.updateSede).toHaveBeenCalledWith(
      1, expect.objectContaining({ name: 'Milano HQ' }), 'admin@dompe.com',
    );
  });

  /**
   * The usual reason a site cannot be reached is that its Key Vault secret does
   * not exist yet. Activating anyway just moves the failure to an operator who
   * cannot do anything about it — so it takes an explicit override.
   */
  it('refuses to activate a site whose probe has never succeeded', async () => {
    mockRepo.getAdminSedeById.mockResolvedValue(adminSede({ active: false, wlcLastCheckOk: null }));

    const res = await request(app).patch('/api/admin/sedi/1/active').send({ active: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('untested_sede');
    expect(mockRepo.setSedeActive).not.toHaveBeenCalled();
  });

  it('activates it when forced', async () => {
    mockRepo.getAdminSedeById.mockResolvedValue(adminSede({ active: false, wlcLastCheckOk: null }));
    mockRepo.setSedeActive.mockResolvedValue(adminSede({ active: true }));

    const res = await request(app).patch('/api/admin/sedi/1/active').send({ active: true, force: true });

    expect(res.status).toBe(200);
    expect(mockRepo.setSedeActive).toHaveBeenCalledWith(1, true, 'admin@dompe.com');
  });

  it('deactivates without needing a successful probe', async () => {
    mockRepo.getAdminSedeById.mockResolvedValue(adminSede({ wlcLastCheckOk: null }));
    mockRepo.setSedeActive.mockResolvedValue(adminSede({ active: false }));

    const res = await request(app).patch('/api/admin/sedi/1/active').send({ active: false });
    expect(res.status).toBe(200);
  });

  /**
   * The previous "Test Connessione" called the login endpoint and then wrote
   * `authenticated: true`, so running a diagnostic changed which controller the
   * application considered live. This one only records what it found.
   */
  it('probes the controller without touching the session', async () => {
    mockWlcWebui.loginWebUi.mockResolvedValue({ success: true });

    const res = await request(app).post('/api/admin/sedi/1/test');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockRepo.recordWlcCheck).toHaveBeenCalledWith(1, true, null);
    expect(mockRepo.setSedeActive).not.toHaveBeenCalled();
  });

  it('records a failed probe with its reason', async () => {
    mockWlcWebui.loginWebUi.mockResolvedValue({ success: false, error: 'ETIMEDOUT', isUnreachable: true });

    const res = await request(app).post('/api/admin/sedi/1/test');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(mockRepo.recordWlcCheck).toHaveBeenCalledWith(1, false, 'ETIMEDOUT');
  });

  it('names the secret to request when the password is missing', async () => {
    mockRepo.getAdminSedeById.mockResolvedValue(
      adminSede({ code: 'TOR', credentialConfigured: false, credentialSecretName: 'WLC-PASSWORD-TOR', credentialEnvVar: 'WLC_PASSWORD_TOR' }),
    );

    const res = await request(app).post('/api/admin/sedi/1/test');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('CREDENTIAL_MISSING');
    expect(res.body.credentialSecretName).toBe('WLC-PASSWORD-TOR');
    expect(mockWlcWebui.loginWebUi).not.toHaveBeenCalled();
  });

  /**
   * `guests.sede_id` carries no foreign key, so deleting a site with history
   * would leave those guests pointing at an id that no longer resolves.
   */
  it('refuses to delete a site that still has guests', async () => {
    mockRepo.countGuestsBySede.mockResolvedValue(12);

    const res = await request(app).delete('/api/admin/sedi/1');

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('SEDE_HAS_GUESTS');
    expect(res.body.count).toBe(12);
    expect(mockRepo.deleteSede).not.toHaveBeenCalled();
  });

  it('deletes a site nothing references', async () => {
    mockRepo.countGuestsBySede.mockResolvedValue(0);
    const res = await request(app).delete('/api/admin/sedi/1');

    expect(res.status).toBe(204);
    expect(mockRepo.deleteSede).toHaveBeenCalledWith(1);
  });
});

describe('break glass', () => {
  const account = {
    username: 'bk.guestportal',
    displayName: 'Break Glass',
    role: 'admin',
    enabled: true,
    expiresAt: null,
    lockedUntil: null,
    failedAttempts: 0,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01'),
  };

  it('lists the accounts with a derived state', async () => {
    mockBreakGlass.listBreakGlassAccountsForAdmin.mockResolvedValue([account]);
    const res = await request(app).get('/api/admin/breakglass');

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ username: 'bk.guestportal', state: 'enabled' });
  });

  it('never returns a password hash', async () => {
    mockBreakGlass.listBreakGlassAccountsForAdmin.mockResolvedValue([account]);
    const res = await request(app).get('/api/admin/breakglass');

    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('scrypt$');
  });

  it('reports a locked account as locked', async () => {
    mockBreakGlass.listBreakGlassAccountsForAdmin.mockResolvedValue([
      { ...account, lockedUntil: new Date(Date.now() + 600_000) },
    ]);
    const res = await request(app).get('/api/admin/breakglass');
    expect(res.body.data[0].state).toBe('locked');
  });

  it('reports an expired account as expired', async () => {
    mockBreakGlass.listBreakGlassAccountsForAdmin.mockResolvedValue([
      { ...account, expiresAt: new Date(Date.now() - 1000) },
    ]);
    const res = await request(app).get('/api/admin/breakglass');
    expect(res.body.data[0].state).toBe('expired');
  });

  /** A list of the emergency accounts is itself useful to an attacker. */
  it('audits even a read', async () => {
    mockBreakGlass.listBreakGlassAccountsForAdmin.mockResolvedValue([]);
    await request(app).get('/api/admin/breakglass');

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'admin-breakglass-list', actor: 'admin@dompe.com' }),
      expect.any(String),
    );
  });

  /**
   * The compliance boundary. These routes do not exist, and their absence is
   * what keeps a compromised admin session from minting a permanent SSO bypass.
   */
  it('exposes no route that creates an account', async () => {
    const res = await request(app).post('/api/admin/breakglass').send({
      username: 'bk.attacker', displayName: 'x', password: 'y',
    });
    expect(res.status).toBe(404);
  });

  it('exposes no route that rotates a password', async () => {
    const res = await request(app)
      .post('/api/admin/breakglass/bk.guestportal/password')
      .send({ password: 'new-password-value' });
    expect(res.status).toBe(404);
  });

  it('exposes no route that deletes an account', async () => {
    const res = await request(app).delete('/api/admin/breakglass/bk.guestportal');
    expect(res.status).toBe(404);
  });

  it('enables an account', async () => {
    mockBreakGlass.getBreakGlassAccount.mockResolvedValue(account);
    const res = await request(app).post('/api/admin/breakglass/bk.guestportal/enable');

    expect(res.status).toBe(200);
    expect(mockBreakGlass.setBreakGlassEnabled).toHaveBeenCalledWith('bk.guestportal', true);
  });

  it('disables an account while another remains usable', async () => {
    mockBreakGlass.getBreakGlassAccount.mockResolvedValue(account);
    mockBreakGlass.countUsableBreakGlassAccounts.mockResolvedValue(1);

    const res = await request(app).post('/api/admin/breakglass/bk.guestportal/disable');

    expect(res.status).toBe(200);
    expect(mockBreakGlass.setBreakGlassEnabled).toHaveBeenCalledWith('bk.guestportal', false);
  });

  /** These accounts exist for when SSO is down — which is exactly when nobody
   *  would be able to create a replacement. */
  it('refuses to disable the last usable account', async () => {
    mockBreakGlass.getBreakGlassAccount.mockResolvedValue(account);
    mockBreakGlass.countUsableBreakGlassAccounts.mockResolvedValue(0);

    const res = await request(app).post('/api/admin/breakglass/bk.guestportal/disable');

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('last_breakglass');
    expect(mockBreakGlass.setBreakGlassEnabled).not.toHaveBeenCalled();
  });

  it('clears a lockout', async () => {
    mockBreakGlass.unlockBreakGlassAccount.mockResolvedValue(true);
    const res = await request(app).post('/api/admin/breakglass/bk.guestportal/unlock');

    expect(res.status).toBe(200);
    expect(mockBreakGlass.unlockBreakGlassAccount).toHaveBeenCalledWith('bk.guestportal');
  });

  it('returns 404 for an unknown account', async () => {
    mockBreakGlass.getBreakGlassAccount.mockResolvedValue(null);
    const res = await request(app).post('/api/admin/breakglass/nope/enable');
    expect(res.status).toBe(404);
  });

  it('audits every mutation', async () => {
    mockBreakGlass.getBreakGlassAccount.mockResolvedValue(account);
    await request(app).post('/api/admin/breakglass/bk.guestportal/enable');

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'admin-breakglass-enable', target: 'bk.guestportal' }),
      expect.any(String),
    );
  });
});
