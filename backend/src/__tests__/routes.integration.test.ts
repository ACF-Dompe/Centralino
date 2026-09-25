/**
 * Integration tests for the main API router.
 *
 * Auth middleware is mocked to always pass (next()). Repository functions
 * and external services (WLC webui, SSH, email) are mocked so that no real
 * infrastructure is needed. The goal is to validate:
 *   - Input sanitization rejects injection payloads (400)
 *   - Missing mandatory fields are rejected (400)
 *   - Success paths call mocked services correctly (200)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Hoisted mocks (defined before vi.mock so vitest can hoist them) ─────

const mockRepo = vi.hoisted(() => ({
  listGuests: vi.fn(),
  getGuest: vi.fn(),
  createGuest: vi.fn(),
  updateGuest: vi.fn(),
  deleteGuest: vi.fn(),
  getWlcConfigBySede: vi.fn(),
  recordWlcCheck: vi.fn(),
  getSmsConfig: vi.fn(),
  updateSmsConfig: vi.fn(),
  listSyncLogs: vi.fn(),
  clearSyncLogs: vi.fn(),
  addSyncLog: vi.fn(),
  listSedi: vi.fn(),
  getSedeById: vi.fn(),
}));

const mockWlcWebui = vi.hoisted(() => ({ loginWebUi: vi.fn() }));
const mockWlcSsh = vi.hoisted(() => ({
  execSsh: vi.fn(),
  parseUsernameList: vi.fn(),
  minutesToLifetime: vi.fn(),
  extractGuestUsers: vi.fn(),
}));
const mockEmail = vi.hoisted(() => ({ sendCredentialEmail: vi.fn() }));
const mockDirectory = vi.hoisted(() => {
  class DirectoryDisabledError extends Error {}
  return { searchDirectoryUsers: vi.fn(), DirectoryDisabledError };
});
const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

/**
 * Authorization state the tests drive.
 *
 * `authz` is what `loadAuthorization` would have resolved; `sessionSedeId` is
 * the site the operator has connected to. Both are request state now, so the
 * harness has to supply them — which is the point: routes take the site from
 * the session, never from the query string.
 */
const mockAuthzState = vi.hoisted(() => ({
  authz: {
    subject: 'admin@dompe.com',
    userId: 1,
    source: 'app_user',
    role: 'admin',
    status: 'active',
    sedeIds: [1],
    allSedi: true,
    displayName: 'Admin',
    email: 'admin@dompe.com',
  } as any,
  sessionSedeId: 1 as number | null,
  wlcConnected: true,
}));

// ── Module-level mocks ──────────────────────────────────────────────────
vi.mock('../middleware/ensureAuth.js', () => ({
  ensureAuthenticated: vi.fn((_req: any, _res: any, next: any) => next()),
}));

/**
 * Thin but faithful stand-ins for the guards. The real implementations, with
 * their database lookup, caching and fail-closed behaviour, are covered by
 * `authorize.test.ts`; what these tests check is that each route is wired to
 * the right guard.
 */
vi.mock('../middleware/authorize.js', () => {
  const canAccess = (p: any, sedeId: number | null) =>
    p.allSedi || (sedeId != null && p.sedeIds.includes(sedeId));
  return {
    loadAuthorization: (req: any, _res: any, next: any) => {
      req.authz = mockAuthzState.authz;
      next();
    },
    requireRole: (...roles: string[]) => (req: any, res: any, next: any) =>
      roles.includes(req.authz?.role)
        ? next()
        : res.status(403).json({ success: false, error: 'insufficient_role', requiredRoles: roles }),
    requireSedeAccess: (extract?: (r: any) => number | null) => (req: any, res: any, next: any) => {
      const pick = extract ?? ((r: any) => {
        const raw = r.body?.sedeId ?? r.query?.sedeId ?? null;
        return raw == null || raw === '' ? null : Number(raw);
      });
      const sedeId = pick(req);
      if (sedeId == null) return res.status(400).json({ success: false, error: 'sede_required' });
      if (!canAccess(req.authz, sedeId)) return res.status(403).json({ success: false, error: 'sede_forbidden' });
      next();
    },
    ensureSedeAllowed: (req: any, res: any, sedeId: number | null) => {
      if (canAccess(req.authz, sedeId)) return true;
      res.status(403).json({ success: false, error: 'sede_forbidden' });
      return false;
    },
    allowedSedeIds: (p: any) => (p.allSedi ? null : p.sedeIds),
  };
});

vi.mock('../repositories/index.js', () => mockRepo);
vi.mock('../services/wlcWebui.js', () => mockWlcWebui);
vi.mock('../services/wlcSsh.js', () => mockWlcSsh);
vi.mock('../services/email.js', () => mockEmail);
vi.mock('../services/entraDirectory.js', () => mockDirectory);
vi.mock('../logger.js', () => ({ log: mockLog }));

// ── Import router AFTER mocks (vi.mock is hoisted) ──────────────────────
import { router } from '../routes/index.js';

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Minimal session stand-in: the routes read `sedeId` and `wlcConnected` from
  // it and call `save`, which connect-pg-simple would make asynchronous.
  app.use((req: any, _res, next) => {
    req.session = {
      sedeId: mockAuthzState.sessionSedeId ?? undefined,
      wlcConnected: mockAuthzState.wlcConnected,
      save: (cb: (err?: unknown) => void) => cb(),
    };
    next();
  });
  app.use('/api', router);
  return app;
}

// ── Default mock values used across tests ───────────────────────────────
const DEFAULT_WLC_CONFIG = {
  id: 1,
  host: '192.168.1.1',
  port: 443,
  sshPort: 22,
  username: 'admin',
  password: 'admin',
  // Session state, filled in by the route. Background work and guest pushes
  // branch on `usable`.
  authenticated: false,
  usable: true,
  wlanSsid: 'Dompe Guest',
  sedeId: 1,
};

const DEFAULT_SEDE = {
  id: 1,
  code: 'MIL',
  name: 'Sede Centrale',
  city: 'Milano',
  address: null,
  wlcConfigId: null,
  createdAt: '2025-01-01T00:00:00Z',
  active: true,
  wlcHost: '192.168.1.1',
  wlcPort: 443,
  wlcSshPort: 22,
  wlcUsername: 'admin',
  wlcSsid: 'Dompe Guest',
};

describe('Routes Integration', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();

    // WLC password now comes from Key Vault (env) per sede (§2).
    process.env.WLC_PASSWORD_MIL = 'test-wlc-pass';

    // Back to a full admin on the default site before each test.
    mockAuthzState.authz = {
      subject: 'admin@dompe.com',
      userId: 1,
      source: 'app_user',
      role: 'admin',
      status: 'active',
      sedeIds: [1],
      allSedi: true,
      displayName: 'Admin',
      email: 'admin@dompe.com',
    };
    mockAuthzState.sessionSedeId = 1;
    mockAuthzState.wlcConnected = true;

    // Seed default mocks so most tests don't need to repeat them
    mockRepo.listSedi.mockResolvedValue([DEFAULT_SEDE]);
    mockRepo.getSedeById.mockResolvedValue(DEFAULT_SEDE);
    mockRepo.getWlcConfigBySede.mockResolvedValue(DEFAULT_WLC_CONFIG);
    mockRepo.listGuests.mockResolvedValue([]);

    app = createApp();
  });

  // ═════════════════════════════════════════════════════════════════════
  //  Health (public — no auth needed)
  // ═════════════════════════════════════════════════════════════════════
  describe('GET /api/health', () => {
    it('returns 200 with status ok and uptime', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok' });
      expect(typeof res.body.uptime).toBe('number');
      expect(typeof res.body.timestamp).toBe('string');
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  Sedi
  // ═════════════════════════════════════════════════════════════════════
  describe('GET /api/sedi', () => {
    it('returns only sites in service', async () => {
      const res = await request(app).get('/api/sedi');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Sede Centrale');
      expect(mockRepo.listSedi).toHaveBeenCalledWith(
        expect.objectContaining({ activeOnly: true }),
      );
    });

    /**
     * Filtered server-side. A selector that merely hides a site is a courtesy;
     * this is the part that actually keeps an operator out of it.
     */
    it('restricts the list to the sites the operator was granted', async () => {
      mockAuthzState.authz = { ...mockAuthzState.authz, role: 'operator', allSedi: false, sedeIds: [2, 3] };
      const res = await request(app).get('/api/sedi');
      expect(res.status).toBe(200);
      expect(mockRepo.listSedi).toHaveBeenCalledWith(
        expect.objectContaining({ allowedIds: [2, 3] }),
      );
    });

    it('passes no restriction for an admin', async () => {
      await request(app).get('/api/sedi');
      expect(mockRepo.listSedi).toHaveBeenCalledWith(
        expect.objectContaining({ allowedIds: null }),
      );
    });

    /**
     * The controller address, ports and admin account are admin-only. An
     * operator picks a site by name; exposing the infrastructure to everyone
     * was the reason those fields sat on the login screen in the first place.
     */
    it('strips the controller parameters for a non-admin', async () => {
      mockAuthzState.authz = { ...mockAuthzState.authz, role: 'operator', allSedi: false, sedeIds: [1] };
      const res = await request(app).get('/api/sedi');
      expect(res.body.data[0].wlcHost).toBeUndefined();
      expect(res.body.data[0].wlcUsername).toBeUndefined();
      // The SSID stays: it goes on the credentials the guest receives.
      expect(res.body.data[0].wlcSsid).toBe('Dompe Guest');
    });

    it('keeps the controller parameters for an admin', async () => {
      const res = await request(app).get('/api/sedi');
      expect(res.body.data[0].wlcHost).toBe('192.168.1.1');
    });
  });

  describe('GET /api/sedi/:id', () => {
    it('returns the sede', async () => {
      const res = await request(app).get('/api/sedi/1');
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Sede Centrale');
      expect(mockRepo.getSedeById).toHaveBeenCalledWith(1);
    });

    it('returns 400 for non-numeric id', async () => {
      const res = await request(app).get('/api/sedi/abc');
      expect(res.status).toBe(400);
      expect(mockRepo.getSedeById).not.toHaveBeenCalled();
    });

    it('returns 404 when sede not found', async () => {
      mockRepo.getSedeById.mockResolvedValue(null);
      const res = await request(app).get('/api/sedi/999');
      expect(res.status).toBe(404);
    });

    it('refuses a sede the operator was not granted', async () => {
      mockAuthzState.authz = { ...mockAuthzState.authz, role: 'operator', allSedi: false, sedeIds: [2] };
      const res = await request(app).get('/api/sedi/1');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('sede_forbidden');
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  WLC Login — command injection surface
  // ═════════════════════════════════════════════════════════════════════
  describe('POST /api/wlc/login', () => {
    /*
     * The endpoint takes a site id and nothing else. It used to accept the
     * host, port and admin username from the request body and write them
     * straight back to the database, which made the login screen a way for any
     * authenticated user to repoint a controller — and made the username an
     * SSH command injection surface, since it flows into the guest CRUD
     * commands. Both problems disappear by not accepting the values at all.
     */

    it('rejects a request without a sede', async () => {
      const res = await request(app).post('/api/wlc/login').send({});
      expect(res.status).toBe(400);
      expect(mockWlcWebui.loginWebUi).not.toHaveBeenCalled();
    });

    it('ignores controller parameters supplied by the client', async () => {
      mockWlcWebui.loginWebUi.mockResolvedValue({ success: true });
      const res = await request(app).post('/api/wlc/login').send({
        sedeId: 1,
        host: 'attacker.example.com',
        port: 4443,
        username: 'admin\nconfigure terminal',
      });

      expect(res.status).toBe(200);
      expect(mockWlcWebui.loginWebUi).toHaveBeenCalledWith(
        expect.objectContaining({ host: '192.168.1.1', port: 443, username: 'admin' }),
      );
    });

    it('connects using the stored site parameters and the Key Vault password', async () => {
      mockWlcWebui.loginWebUi.mockResolvedValue({ success: true, sessionId: 'abc-123' });
      const res = await request(app).post('/api/wlc/login').send({ sedeId: 1 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockWlcWebui.loginWebUi).toHaveBeenCalledWith({
        host: '192.168.1.1',
        port: 443,
        username: 'admin',
        password: 'test-wlc-pass',
      });
    });

    it('records the probe result on the site', async () => {
      mockWlcWebui.loginWebUi.mockResolvedValue({ success: false, error: 'timeout' });
      await request(app).post('/api/wlc/login').send({ sedeId: 1 });
      expect(mockRepo.recordWlcCheck).toHaveBeenCalledWith(1, false, 'timeout');
    });

    it('returns 404 for an unknown sede', async () => {
      mockRepo.getSedeById.mockResolvedValue(null);
      const res = await request(app).post('/api/wlc/login').send({ sedeId: 99 });
      expect(res.status).toBe(404);
    });

    it('refuses a deactivated sede', async () => {
      mockRepo.getSedeById.mockResolvedValue({ ...DEFAULT_SEDE, active: false });
      const res = await request(app).post('/api/wlc/login').send({ sedeId: 1 });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('SEDE_INACTIVE');
      expect(mockWlcWebui.loginWebUi).not.toHaveBeenCalled();
    });

    it('refuses a sede with no controller configured', async () => {
      mockRepo.getSedeById.mockResolvedValue({ ...DEFAULT_SEDE, wlcHost: null });
      const res = await request(app).post('/api/wlc/login').send({ sedeId: 1 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('WLC_NOT_CONFIGURED');
    });

    /**
     * A site can exist before its Key Vault secret does — creating that secret
     * is a platform-team request. Saying so precisely is the difference between
     * an admin filing a ticket and an operator retrying forever.
     */
    it('reports a missing Key Vault secret distinctly', async () => {
      mockRepo.getSedeById.mockResolvedValue({ ...DEFAULT_SEDE, code: 'TOR' });
      const res = await request(app).post('/api/wlc/login').send({ sedeId: 1 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('CREDENTIAL_MISSING');
      expect(mockWlcWebui.loginWebUi).not.toHaveBeenCalled();
    });

    it('refuses a sede the operator was not granted', async () => {
      mockAuthzState.authz = { ...mockAuthzState.authz, role: 'operator', allSedi: false, sedeIds: [2] };
      const res = await request(app).post('/api/wlc/login').send({ sedeId: 1 });
      expect(res.status).toBe(403);
      expect(mockWlcWebui.loginWebUi).not.toHaveBeenCalled();
    });

    it('refuses a viewer', async () => {
      mockAuthzState.authz = { ...mockAuthzState.authz, role: 'viewer' };
      const res = await request(app).post('/api/wlc/login').send({ sedeId: 1 });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('insufficient_role');
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  describe('POST /api/wlc/create-user (injection surface)', () => {
    const validBody = {
      host: '192.168.1.1',
      port: 443,
      sshPort: 22,
      username: 'admin',
      password: 'Admin@123',
      config: {
        targetUsername: 'guest-user',
        targetPassword: 'Guest@123',
        durationMinutes: 240,
      },
    };

    it('returns 400 when mandatory fields missing', async () => {
      const res = await request(app).post('/api/wlc/create-user').send({ host: 'x' });
      expect(res.status).toBe(400);
    });

    // targetUsername sanitization
    it('rejects targetUsername with newline (command injection)', async () => {
      const res = await request(app)
        .post('/api/wlc/create-user')
        .send({ ...validBody, config: { ...validBody.config, targetUsername: 'guest\nno user-name admin' } });
      expect(res.status).toBe(400);
      expect(mockWlcSsh.execSsh).not.toHaveBeenCalled();
    });

    it('rejects targetUsername with space (username pattern violation)', async () => {
      const res = await request(app)
        .post('/api/wlc/create-user')
        .send({ ...validBody, config: { ...validBody.config, targetUsername: 'guest user' } });
      expect(res.status).toBe(400);
    });

    it('rejects targetUsername with pipe', async () => {
      const res = await request(app)
        .post('/api/wlc/create-user')
        .send({ ...validBody, config: { ...validBody.config, targetUsername: 'guest|shutdown' } });
      expect(res.status).toBe(400);
    });

    it('rejects targetUsername with shell metacharacters', async () => {
      const res = await request(app)
        .post('/api/wlc/create-user')
        .send({ ...validBody, config: { ...validBody.config, targetUsername: '$(rm -rf /)' } });
      expect(res.status).toBe(400);
    });

    // targetPassword sanitization
    it('rejects targetPassword with newline', async () => {
      const res = await request(app)
        .post('/api/wlc/create-user')
        .send({ ...validBody, config: { ...validBody.config, targetPassword: 'pass\nword' } });
      expect(res.status).toBe(400);
    });

    it('rejects targetPassword with null byte', async () => {
      const res = await request(app)
        .post('/api/wlc/create-user')
        .send({ ...validBody, config: { ...validBody.config, targetPassword: 'pass\0word' } });
      expect(res.status).toBe(400);
    });

    // Admin credentials sanitization
    it('rejects admin username with pipe injection', async () => {
      const res = await request(app)
        .post('/api/wlc/create-user')
        .send({ ...validBody, username: 'admin|grep something' });
      expect(res.status).toBe(400);
    });

    it('rejects admin password with newline', async () => {
      const res = await request(app)
        .post('/api/wlc/create-user')
        .send({ ...validBody, password: 'admin\nnewpass' });
      expect(res.status).toBe(400);
    });

    // Success path
    it('calls execSsh and adds sync log on success', async () => {
      mockWlcSsh.execSsh.mockResolvedValue({ success: true, output: 'user-name guest-user' });
      const res = await request(app).post('/api/wlc/create-user').send(validBody);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('guest-user');
      expect(mockWlcSsh.execSsh).toHaveBeenCalledOnce();
      expect(mockRepo.addSyncLog).toHaveBeenCalledOnce();
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  WLC Status User
  // ═════════════════════════════════════════════════════════════════════
  describe('PUT /api/wlc/status-user (injection surface)', () => {
    const validBody = {
      host: '192.168.1.1',
      username: 'admin',
      password: 'Admin@123',
      targetUsername: 'guest-user',
      enabled: false,
    };

    it('returns 400 when mandatory fields missing', async () => {
      const res = await request(app).put('/api/wlc/status-user').send({});
      expect(res.status).toBe(400);
    });

    it('rejects targetUsername with newline injection', async () => {
      const res = await request(app)
        .put('/api/wlc/status-user')
        .send({ ...validBody, targetUsername: 'guest\nno user-name admin' });
      expect(res.status).toBe(400);
    });

    it('rejects targetUsername with shell injection (backtick)', async () => {
      const res = await request(app)
        .put('/api/wlc/status-user')
        .send({ ...validBody, targetUsername: '`reboot`' });
      expect(res.status).toBe(400);
    });

    it('enabled=true does NOT call execSsh (log-only, no SSH)', async () => {
      const res = await request(app)
        .put('/api/wlc/status-user')
        .send({ ...validBody, enabled: true });
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('verificato');
      expect(mockWlcSsh.execSsh).not.toHaveBeenCalled();
      expect(mockRepo.addSyncLog).toHaveBeenCalledOnce();
    });

    it('enabled=false calls execSsh for deactivation', async () => {
      mockWlcSsh.execSsh.mockResolvedValue({ success: true, output: '' });
      const res = await request(app)
        .put('/api/wlc/status-user')
        .send(validBody);
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('disattivato');
      expect(mockWlcSsh.execSsh).toHaveBeenCalledOnce();
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  WLC Delete User
  // ═════════════════════════════════════════════════════════════════════
  describe('POST /api/wlc/delete-user (injection surface)', () => {
    const validBody = {
      host: '192.168.1.1',
      username: 'admin',
      password: 'Admin@123',
      targetUsername: 'guest-user',
    };

    it('returns 400 when mandatory fields missing', async () => {
      const res = await request(app).post('/api/wlc/delete-user').send({});
      expect(res.status).toBe(400);
    });

    it('rejects targetUsername with newline injection', async () => {
      const res = await request(app)
        .post('/api/wlc/delete-user')
        .send({ ...validBody, targetUsername: 'guest\nno user-name admin' });
      expect(res.status).toBe(400);
    });

    it('rejects targetUsername with subshell injection', async () => {
      const res = await request(app)
        .post('/api/wlc/delete-user')
        .send({ ...validBody, targetUsername: '$(id)' });
      expect(res.status).toBe(400);
    });

    it('deletes user via execSsh on success', async () => {
      mockWlcSsh.execSsh.mockResolvedValue({ success: true, output: '' });
      const res = await request(app).post('/api/wlc/delete-user').send(validBody);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockWlcSsh.execSsh).toHaveBeenCalledOnce();
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  WLC Get Users
  // ═════════════════════════════════════════════════════════════════════
  describe('POST /api/wlc/get-users', () => {
    it('returns 400 when mandatory fields missing', async () => {
      const res = await request(app).post('/api/wlc/get-users').send({});
      expect(res.status).toBe(400);
    });

    it('returns parsed WLC users on success', async () => {
      mockWlcSsh.execSsh.mockResolvedValue({ success: true, output: 'username guest1\nusername guest2' });
      mockWlcSsh.extractGuestUsers.mockReturnValue([
        { username: 'guest1' },
        { username: 'guest2' },
      ]);
      const res = await request(app).post('/api/wlc/get-users').send({
        host: '192.168.1.1', username: 'admin', password: 'admin',
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data['webauth-local-users']).toHaveLength(2);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  WLC Import Users
  // ═════════════════════════════════════════════════════════════════════
  describe('POST /api/wlc/import-users', () => {
    it('returns 400 when mandatory fields missing', async () => {
      const res = await request(app).post('/api/wlc/import-users').send({});
      expect(res.status).toBe(400);
    });

    it('returns message when no users found on WLC', async () => {
      mockWlcSsh.execSsh.mockResolvedValue({ success: true, output: '' });
      mockWlcSsh.parseUsernameList.mockReturnValue([]);
      const res = await request(app).post('/api/wlc/import-users').send({
        host: '192.168.1.1', username: 'admin', password: 'admin', sedeId: 1,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.message).toContain('Nessun utente');
    });

    it('imports new users from WLC, skipping existing ones', async () => {
      mockWlcSsh.execSsh.mockResolvedValue({ success: true, output: 'username guest1\nusername guest2' });
      mockWlcSsh.parseUsernameList.mockReturnValue([
        { username: 'guest1' },
        { username: 'guest2' },
      ]);
      // guest1 already exists in the DB
      mockRepo.listGuests.mockResolvedValue([{ id: 'g-1', username: 'guest1' }]);
      mockRepo.createGuest.mockResolvedValue({ id: 'g-new', username: 'guest2', name: 'guest2' });

      const res = await request(app).post('/api/wlc/import-users').send({
        host: '192.168.1.1', username: 'admin', password: 'admin', sedeId: 1,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.imported).toHaveLength(1);
      expect(res.body.data.skipped).toEqual(['guest1']);
      expect(mockRepo.createGuest).toHaveBeenCalledOnce();
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  WLC Get Users
  // ═════════════════════════════════════════════════════════════════════
  describe('POST /api/wlc/get-users', () => {
    it('returns 400 when mandatory fields missing', async () => {
      const res = await request(app).post('/api/wlc/get-users').send({});
      expect(res.status).toBe(400);
    });

    it('returns parsed WLC users on success', async () => {
      mockWlcSsh.execSsh.mockResolvedValue({ success: true, output: 'username guest1\nusername guest2' });
      mockWlcSsh.extractGuestUsers.mockReturnValue([
        { username: 'guest1' },
        { username: 'guest2' },
      ]);
      const res = await request(app).post('/api/wlc/get-users').send({
        host: '192.168.1.1', username: 'admin', password: 'admin',
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data['webauth-local-users']).toHaveLength(2);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  Guests
  // ═════════════════════════════════════════════════════════════════════
  describe('GET /api/guests', () => {
    it('returns guest list from repository', async () => {
      mockRepo.listGuests.mockResolvedValue([{ id: 'g-1', name: 'Mario' }]);
      const res = await request(app).get('/api/guests');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('passes search and status through, taking the sede from the session', async () => {
      await request(app).get('/api/guests?search=mario&status=active&sedeId=1');
      expect(mockRepo.listGuests).toHaveBeenCalledWith({
        search: 'mario',
        status: 'active',
        sedeId: 1,
      });
    });

    /**
     * The client used to name the site in the query string and the server
     * simply obeyed, so any authenticated user could read another site's guests
     * by editing the URL. The session is authoritative now, and a mismatch is
     * refused rather than quietly ignored — a silent override would hide the
     * bug that produced it.
     */
    it('refuses a sedeId that differs from the session', async () => {
      const res = await request(app).get('/api/guests?sedeId=2');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('sede_mismatch');
      expect(mockRepo.listGuests).not.toHaveBeenCalled();
    });

    it('never reads another sede even when the query asks for it', async () => {
      mockAuthzState.sessionSedeId = 3;
      await request(app).get('/api/guests?sedeId=3');
      expect(mockRepo.listGuests).toHaveBeenCalledWith(
        expect.objectContaining({ sedeId: 3 }),
      );
    });

    it('asks the operator to pick a sede first', async () => {
      mockAuthzState.sessionSedeId = null;
      const res = await request(app).get('/api/guests');
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('NO_SEDE_SELECTED');
      expect(mockRepo.listGuests).not.toHaveBeenCalled();
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  Session
  // ═════════════════════════════════════════════════════════════════════
  describe('Session endpoints', () => {
    it('GET /api/session/context returns user, sede and wlc', async () => {
      const res = await request(app).get('/api/session/context');
      expect(res.status).toBe(200);
      expect(res.body.data.user.role).toBe('admin');
      expect(res.body.data.sede.code).toBe('MIL');
      expect(res.body.data.wlc.host).toBe('192.168.1.1');
      // Session state, not the stored column.
      expect(res.body.data.wlc.authenticated).toBe(true);
    });

    it('reports no sede when the session has not picked one', async () => {
      mockAuthzState.sessionSedeId = null;
      const res = await request(app).get('/api/session/context');
      expect(res.status).toBe(200);
      expect(res.body.data.sede).toBeNull();
      expect(res.body.data.wlc).toBeNull();
    });

    /**
     * Retiring a site while somebody is working on it drops them back to the
     * selector instead of leaving them pointed at something out of service.
     */
    it('clears a sede that has been deactivated', async () => {
      mockRepo.getSedeById.mockResolvedValue({ ...DEFAULT_SEDE, active: false });
      const res = await request(app).get('/api/session/context');
      expect(res.status).toBe(200);
      expect(res.body.data.sede).toBeNull();
      expect(res.body.data.notice).toBe('SEDE_INACTIVE');
    });

    it('never returns the WLC password', async () => {
      const res = await request(app).get('/api/session/context');
      expect(JSON.stringify(res.body)).not.toContain('admin_password');
      expect(res.body.data.wlc.password).toBeUndefined();
    });

    it('DELETE /api/session/sede answers 204', async () => {
      const res = await request(app).delete('/api/session/sede');
      expect(res.status).toBe(204);
    });
  });

  describe('POST /api/guests', () => {
    const validBody = {
      name: 'Mario Rossi',
      email: 'mario@example.com',
      host: 'Ospitato da Anna',
      durationMinutes: 240,
      sedeId: 1,
    };

    it('returns 400 when mandatory fields missing', async () => {
      const res = await request(app).post('/api/guests').send({});
      expect(res.status).toBe(400);
    });

    it('creates guest and returns oneTimePassword', async () => {
      mockRepo.createGuest.mockResolvedValue({
        id: 'g-abc12345',
        name: 'Mario Rossi',
        username: 'g.mario_abc123',
      });
      mockWlcSsh.execSsh.mockResolvedValue({ success: true, output: '' });
      mockEmail.sendCredentialEmail.mockResolvedValue({ ok: true, mode: 'graph' });

      const res = await request(app).post('/api/guests').send(validBody);
      expect(res.status).toBe(200);
      expect(res.body.data.oneTimePassword).toBeDefined();
      expect(typeof res.body.data.oneTimePassword).toBe('string');
      expect(res.body.data.oneTimePassword!.length).toBeGreaterThan(0);
    });

    it('still creates guest even without email (no email send)', async () => {
      mockRepo.createGuest.mockResolvedValue({ id: 'g-xyz', name: 'No Email' });
      const body = { ...validBody, email: undefined };
      const res = await request(app).post('/api/guests').send(body);
      expect(res.status).toBe(200);
      expect(res.body.data.oneTimePassword).toBeDefined();
    });

    // The register form used to carry a free-form minutes box with no upper
    // bound, and the endpoint never checked the value it was handed.
    it('rejects a duration beyond the one-week cap', async () => {
      const res = await request(app)
        .post('/api/guests')
        .send({ ...validBody, durationMinutes: 999_999 });
      expect(res.status).toBe(400);
      expect(mockRepo.createGuest).not.toHaveBeenCalled();
    });

    it('rejects a non-integer duration', async () => {
      const res = await request(app)
        .post('/api/guests')
        .send({ ...validBody, durationMinutes: 'quattro ore' });
      expect(res.status).toBe(400);
      expect(mockRepo.createGuest).not.toHaveBeenCalled();
    });

    it('accepts the longest duration the form can produce', async () => {
      mockRepo.createGuest.mockResolvedValue({ id: 'g-week', name: 'Mario Rossi' });
      mockWlcSsh.execSsh.mockResolvedValue({ success: true, output: '' });
      mockEmail.sendCredentialEmail.mockResolvedValue({ ok: true, mode: 'graph' });

      const res = await request(app)
        .post('/api/guests')
        .send({ ...validBody, durationMinutes: 7 * 24 * 60 });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/guests/:id/resend-credentials', () => {
    it('returns 404 when guest not found', async () => {
      mockRepo.getGuest.mockResolvedValue(null);
      const res = await request(app).post('/api/guests/nonexistent/resend-credentials');
      expect(res.status).toBe(404);
    });

    it('returns 400 when guest has no email', async () => {
      mockRepo.getGuest.mockResolvedValue({ id: 'g-1', email: null });
      const res = await request(app)
        .post('/api/guests/g-1/resend-credentials');
      expect(res.status).toBe(400);
    });

    it('resends credentials via SSH and email', async () => {
      mockRepo.getGuest.mockResolvedValue({
        id: 'g-1',
        name: 'Mario',
        email: 'mario@example.com',
        host: 'Anna',
        username: 'g.mario_abc',
        durationMinutes: 240,
        sedeId: 1,
      });
      mockWlcSsh.execSsh.mockResolvedValue({ success: true, output: '' });
      mockEmail.sendCredentialEmail.mockResolvedValue({ ok: true, mode: 'graph' });

      const res = await request(app)
        .post('/api/guests/g-1/resend-credentials');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.oneTimePassword).toBeDefined();
      expect(mockWlcSsh.execSsh).toHaveBeenCalledOnce();
      expect(mockEmail.sendCredentialEmail).toHaveBeenCalledOnce();
    });
  });

  describe('PUT /api/guests/:id', () => {
    it('returns 404 when guest not found', async () => {
      mockRepo.getGuest.mockResolvedValue(null);
      const res = await request(app).put('/api/guests/g-1').send({ status: 'active' });
      expect(res.status).toBe(404);
    });

    it('updates guest status to active', async () => {
      mockRepo.getGuest.mockResolvedValue({
        id: 'g-1', name: 'Mario', status: 'pending', username: 'g.mario', sedeId: 1,
      });
      mockRepo.updateGuest.mockResolvedValue({
        id: 'g-1', name: 'Mario', status: 'active',
      });
      const res = await request(app).put('/api/guests/g-1').send({ status: 'active' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('active');
    });
  });

  describe('DELETE /api/guests/:id', () => {
    it('returns 404 when guest not found', async () => {
      mockRepo.getGuest.mockResolvedValue(null);
      const res = await request(app).delete('/api/guests/g-1');
      expect(res.status).toBe(404);
    });

    it('deletes guest and returns success', async () => {
      mockRepo.getGuest.mockResolvedValue({
        id: 'g-1', name: 'Mario', username: 'g.mario', sedeId: 1,
      });
      const res = await request(app).delete('/api/guests/g-1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockRepo.deleteGuest).toHaveBeenCalledWith('g-1');
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  Config endpoints
  // ═════════════════════════════════════════════════════════════════════
  describe('Config endpoints', () => {
    it('GET /api/config/wlc resolves the sede from the session', async () => {
      const res = await request(app).get('/api/config/wlc');
      expect(res.status).toBe(200);
      expect(res.body.data.host).toBe('192.168.1.1');
      expect(mockRepo.getWlcConfigBySede).toHaveBeenCalledWith(1);
    });

    it('GET /api/config/wlc strips the password', async () => {
      const res = await request(app).get('/api/config/wlc');
      expect(res.body.data.password).toBeUndefined();
    });

    /**
     * The writer is gone. It was the only caller of the site-less
     * `updateWlcConfig`, which always wrote to the first row whatever site the
     * operator was on — so disconnecting one site switched off provisioning for
     * another. Site settings are edited through /api/admin/sedi now.
     */
    it('PUT /api/config/wlc no longer exists', async () => {
      const res = await request(app).put('/api/config/wlc').send({ host: 'new-host' });
      expect(res.status).toBe(404);
    });

    // Email/SMTP config endpoints removed (§3): mail is Graph-only.

    it('GET /api/config/sms returns SMS config', async () => {
      mockRepo.getSmsConfig.mockResolvedValue({ provider: 'twilio' });
      const res = await request(app).get('/api/config/sms');
      expect(res.status).toBe(200);
    });

    it('PUT /api/config/sms updates and returns SMS config', async () => {
      mockRepo.updateSmsConfig.mockResolvedValue({ provider: 'messagebird' });
      const res = await request(app).put('/api/config/sms').send({ provider: 'messagebird' });
      expect(res.status).toBe(200);
      expect(res.body.data.provider).toBe('messagebird');
      expect(mockRepo.updateSmsConfig).toHaveBeenCalledOnce();
    });

    it('keeps the SMS config out of an operator\'s reach', async () => {
      mockAuthzState.authz = { ...mockAuthzState.authz, role: 'operator' };
      const res = await request(app).get('/api/config/sms');
      expect(res.status).toBe(403);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  Role enforcement on the guest endpoints
  // ═════════════════════════════════════════════════════════════════════
  describe('Role enforcement', () => {
    it('lets a viewer read guests', async () => {
      mockAuthzState.authz = { ...mockAuthzState.authz, role: 'viewer' };
      const res = await request(app).get('/api/guests');
      expect(res.status).toBe(200);
    });

    it('stops a viewer creating a guest', async () => {
      mockAuthzState.authz = { ...mockAuthzState.authz, role: 'viewer' };
      const res = await request(app).post('/api/guests').send({
        name: 'Mario', host: 'Anna', durationMinutes: 60, sedeId: 1,
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('insufficient_role');
      expect(mockRepo.createGuest).not.toHaveBeenCalled();
    });

    it('stops a viewer deleting a guest', async () => {
      mockAuthzState.authz = { ...mockAuthzState.authz, role: 'viewer' };
      mockRepo.getGuest.mockResolvedValue({ id: 'g-1', sedeId: 1, username: 'g.x' });
      const res = await request(app).delete('/api/guests/g-1');
      expect(res.status).toBe(403);
      expect(mockRepo.deleteGuest).not.toHaveBeenCalled();
    });

    it('stops an operator creating a guest at a sede they were not granted', async () => {
      mockAuthzState.authz = { ...mockAuthzState.authz, role: 'operator', allSedi: false, sedeIds: [2] };
      const res = await request(app).post('/api/guests').send({
        name: 'Mario', host: 'Anna', durationMinutes: 60, sedeId: 1,
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('sede_forbidden');
      expect(mockRepo.createGuest).not.toHaveBeenCalled();
    });

    /**
     * The site is discovered after reading the guest, so this check lives in the
     * handler rather than in a middleware that would have to fetch it twice.
     */
    it('stops an operator touching a guest belonging to another sede', async () => {
      mockAuthzState.authz = { ...mockAuthzState.authz, role: 'operator', allSedi: false, sedeIds: [1] };
      mockRepo.getGuest.mockResolvedValue({ id: 'g-9', sedeId: 7, username: 'g.other', email: 'x@y.z' });
      const res = await request(app).delete('/api/guests/g-9');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('sede_forbidden');
      expect(mockRepo.deleteGuest).not.toHaveBeenCalled();
    });

    it('keeps the raw WLC endpoints for admins only', async () => {
      mockAuthzState.authz = { ...mockAuthzState.authz, role: 'operator' };
      const res = await request(app).post('/api/wlc/create-user').send({});
      expect(res.status).toBe(403);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  Directory search (Referente)
  // ═════════════════════════════════════════════════════════════════════
  describe('GET /api/directory/users', () => {
    it('returns the display names found in Entra, uncached', async () => {
      mockDirectory.searchDirectoryUsers.mockResolvedValue([{ id: 'a', displayName: 'Maria Rossi' }]);

      const res = await request(app).get('/api/directory/users').query({ q: ' ros ' });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{ id: 'a', displayName: 'Maria Rossi' }]);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(mockDirectory.searchDirectoryUsers).toHaveBeenCalledWith('ros');
    });

    it.each([
      ['too short', 'r'],
      ['too long', 'x'.repeat(65)],
      ['a control character', 'ro\u0001s'],
    ])('rejects a query that is %s', async (_label, q) => {
      const res = await request(app).get('/api/directory/users').query({ q });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_query');
      expect(mockDirectory.searchDirectoryUsers).not.toHaveBeenCalled();
    });

    it('answers 503 when the search is switched off, so the field stays free text', async () => {
      mockDirectory.searchDirectoryUsers.mockRejectedValue(new mockDirectory.DirectoryDisabledError('off'));
      const res = await request(app).get('/api/directory/users').query({ q: 'ros' });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('directory_unavailable');
    });

    it('answers 502 on a Graph failure, without logging the query', async () => {
      mockDirectory.searchDirectoryUsers.mockRejectedValue(new Error('Insufficient privileges'));

      const res = await request(app).get('/api/directory/users').query({ q: 'Rossi' });

      expect(res.status).toBe(502);
      expect(res.body.error).toBe('directory_error');
      expect(JSON.stringify(mockLog.error.mock.calls)).not.toContain('Rossi');
    });

    it('is closed to viewers', async () => {
      mockAuthzState.authz = { ...mockAuthzState.authz, role: 'viewer' };
      const res = await request(app).get('/api/directory/users').query({ q: 'ros' });
      expect(res.status).toBe(403);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  //  Sync Logs
  // ═════════════════════════════════════════════════════════════════════
  describe('Sync logs endpoints', () => {
    it('GET /api/sync-logs returns log list', async () => {
      mockRepo.listSyncLogs.mockResolvedValue([{ id: 1, action: 'create-user test' }]);
      const res = await request(app).get('/api/sync-logs');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('DELETE /api/sync-logs clears logs and returns success', async () => {
      const res = await request(app).delete('/api/sync-logs');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockRepo.clearSyncLogs).toHaveBeenCalledOnce();
    });
  });
});
