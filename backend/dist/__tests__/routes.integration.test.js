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
    updateWlcConfigBySede: vi.fn(),
    getWlcConfig: vi.fn(),
    updateWlcConfig: vi.fn(),
    getEmailConfig: vi.fn(),
    updateEmailConfig: vi.fn(),
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
const mockLog = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}));
// ── Module-level mocks ──────────────────────────────────────────────────
vi.mock('../middleware/ensureAuth.js', () => ({
    ensureAuthenticated: vi.fn((_req, _res, next) => next()),
}));
vi.mock('../repositories/index.js', () => mockRepo);
vi.mock('../services/wlcWebui.js', () => mockWlcWebui);
vi.mock('../services/wlcSsh.js', () => mockWlcSsh);
vi.mock('../services/email.js', () => mockEmail);
vi.mock('../logger.js', () => ({ log: mockLog }));
// ── Import router AFTER mocks (vi.mock is hoisted) ──────────────────────
import { router } from '../routes/index.js';
function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    return app;
}
// ── Default mock values used across tests ───────────────────────────────
const DEFAULT_WLC_CONFIG = {
    host: '192.168.1.1',
    port: 443,
    sshPort: 22,
    username: 'admin',
    password: 'admin',
    authenticated: true,
    wlanSsid: 'Dompe Guest',
};
const DEFAULT_SEDE = { id: 1, name: 'Sede Centrale' };
describe('Routes Integration', () => {
    let app;
    beforeEach(() => {
        vi.clearAllMocks();
        // Seed default mocks so most tests don't need to repeat them
        mockRepo.listSedi.mockResolvedValue([DEFAULT_SEDE]);
        mockRepo.getSedeById.mockResolvedValue(DEFAULT_SEDE);
        mockRepo.getWlcConfigBySede.mockResolvedValue(DEFAULT_WLC_CONFIG);
        mockRepo.getWlcConfig.mockResolvedValue(DEFAULT_WLC_CONFIG);
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
        it('returns sedi list from repository', async () => {
            const res = await request(app).get('/api/sedi');
            expect(res.status).toBe(200);
            expect(res.body.data).toHaveLength(1);
            expect(res.body.data[0].name).toBe('Sede Centrale');
            expect(mockRepo.listSedi).toHaveBeenCalledOnce();
        });
    });
    describe('GET /api/sedi/:id', () => {
        it('returns sede with WLC prefill data', async () => {
            const res = await request(app).get('/api/sedi/1');
            expect(res.status).toBe(200);
            expect(res.body.data.name).toBe('Sede Centrale');
            expect(res.body.data.wlcHost).toBe('192.168.1.1');
            expect(mockRepo.getSedeById).toHaveBeenCalledWith(1);
            expect(mockRepo.getWlcConfigBySede).toHaveBeenCalledWith(1);
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
    });
    // ═════════════════════════════════════════════════════════════════════
    //  WLC Login — command injection surface
    // ═════════════════════════════════════════════════════════════════════
    describe('POST /api/wlc/login (injection surface)', () => {
        const validBody = {
            host: '192.168.1.1',
            port: 443,
            username: 'admin',
            password: 'Admin@123',
            sedeId: 1,
        };
        it('returns 400 when mandatory fields missing', async () => {
            const res = await request(app).post('/api/wlc/login').send({ host: 'x' });
            expect(res.status).toBe(400);
        });
        it('rejects username with newline injection', async () => {
            const res = await request(app)
                .post('/api/wlc/login')
                .send({ ...validBody, username: 'admin\nconfigure terminal' });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/newline/i);
            expect(mockWlcWebui.loginWebUi).not.toHaveBeenCalled();
        });
        it('rejects username with semicolon injection', async () => {
            const res = await request(app)
                .post('/api/wlc/login')
                .send({ ...validBody, username: 'admin;id' });
            expect(res.status).toBe(400);
        });
        it('rejects username with pipe injection', async () => {
            const res = await request(app)
                .post('/api/wlc/login')
                .send({ ...validBody, username: 'admin|cat /etc/shadow' });
            expect(res.status).toBe(400);
        });
        it('rejects username with backtick injection', async () => {
            const res = await request(app)
                .post('/api/wlc/login')
                .send({ ...validBody, username: '`whoami`' });
            expect(res.status).toBe(400);
        });
        it('rejects username with subshell injection', async () => {
            const res = await request(app)
                .post('/api/wlc/login')
                .send({ ...validBody, username: '$(id)' });
            expect(res.status).toBe(400);
        });
        it('rejects password with newline injection', async () => {
            const res = await request(app)
                .post('/api/wlc/login')
                .send({ ...validBody, password: 'pass\nword' });
            expect(res.status).toBe(400);
        });
        it('rejects password with null byte', async () => {
            const res = await request(app)
                .post('/api/wlc/login')
                .send({ ...validBody, password: 'valid\0evil' });
            expect(res.status).toBe(400);
        });
        it('calls loginWebUi and updates config on success', async () => {
            mockWlcWebui.loginWebUi.mockResolvedValue({ success: true, sessionId: 'abc-123' });
            const res = await request(app).post('/api/wlc/login').send(validBody);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(mockWlcWebui.loginWebUi).toHaveBeenCalledOnce();
            expect(mockRepo.updateWlcConfigBySede).toHaveBeenCalledWith(1, expect.objectContaining({
                authenticated: true,
            }));
        });
        it('saves config even when login fails (records auth:false)', async () => {
            mockWlcWebui.loginWebUi.mockResolvedValue({ success: false, error: 'Wrong password' });
            const res = await request(app).post('/api/wlc/login').send(validBody);
            expect(res.status).toBe(200);
            expect(mockRepo.updateWlcConfigBySede).toHaveBeenCalledWith(1, expect.objectContaining({
                authenticated: false,
            }));
        });
    });
    // ═════════════════════════════════════════════════════════════════════
    //  WLC Create User — primary command injection surface
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
        it('passes search, status, and sedeId query params', async () => {
            await request(app).get('/api/guests?search=mario&status=active&sedeId=1');
            expect(mockRepo.listGuests).toHaveBeenCalledWith({
                search: 'mario',
                status: 'active',
                sedeId: 1,
            });
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
            mockEmail.sendCredentialEmail.mockResolvedValue({ ok: true, mode: 'smtp' });
            const res = await request(app).post('/api/guests').send(validBody);
            expect(res.status).toBe(200);
            expect(res.body.data.oneTimePassword).toBeDefined();
            expect(typeof res.body.data.oneTimePassword).toBe('string');
            expect(res.body.data.oneTimePassword.length).toBeGreaterThan(0);
        });
        it('still creates guest even without email (no email send)', async () => {
            mockRepo.createGuest.mockResolvedValue({ id: 'g-xyz', name: 'No Email' });
            const body = { ...validBody, email: undefined };
            const res = await request(app).post('/api/guests').send(body);
            expect(res.status).toBe(200);
            expect(res.body.data.oneTimePassword).toBeDefined();
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
            mockEmail.sendCredentialEmail.mockResolvedValue({ ok: true, mode: 'smtp' });
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
        it('GET /api/config/wlc returns WLC config', async () => {
            mockRepo.getWlcConfig.mockResolvedValue({ host: 'wlc.dompe.com' });
            const res = await request(app).get('/api/config/wlc');
            expect(res.status).toBe(200);
            expect(res.body.data.host).toBe('wlc.dompe.com');
        });
        it('PUT /api/config/wlc updates and returns config', async () => {
            mockRepo.updateWlcConfig.mockResolvedValue({ host: 'new-host' });
            const res = await request(app).put('/api/config/wlc').send({ host: 'new-host' });
            expect(res.status).toBe(200);
            expect(res.body.data.host).toBe('new-host');
        });
        it('GET /api/config/email returns email config', async () => {
            mockRepo.getEmailConfig.mockResolvedValue({ smtpHost: 'smtp.dompe.com' });
            const res = await request(app).get('/api/config/email');
            expect(res.status).toBe(200);
        });
        it('PUT /api/config/email updates and returns email config', async () => {
            mockRepo.updateEmailConfig.mockResolvedValue({ smtpHost: 'new.smtp.com' });
            const res = await request(app).put('/api/config/email').send({ smtpHost: 'new.smtp.com' });
            expect(res.status).toBe(200);
            expect(res.body.data.smtpHost).toBe('new.smtp.com');
            expect(mockRepo.updateEmailConfig).toHaveBeenCalledOnce();
        });
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
//# sourceMappingURL=routes.integration.test.js.map