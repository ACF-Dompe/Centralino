/**
 * Express router for all REST endpoints.
 * Wires together repositories, WLC services, email service and the sync log.
 */
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { ensureAuthenticated } from '../middleware/ensureAuth.js';
import { listGuests, getGuest, createGuest, updateGuest, deleteGuest, getWlcConfigBySede, updateWlcConfigBySede, getWlcConfig, updateWlcConfig, getEmailConfig, updateEmailConfig, getSmsConfig, updateSmsConfig, listSyncLogs, clearSyncLogs, addSyncLog, listSedi, getSedeById, } from '../repositories/index.js';
import { loginWebUi } from '../services/wlcWebui.js';
import { execSsh, parseUsernameList, minutesToLifetime, extractGuestUsers } from '../services/wlcSsh.js';
import { sendCredentialEmail } from '../services/email.js';
import { generateCredentials } from '../utils/credentials.js';
import { validateUsername, validatePassword, validateHost } from '../utils/sanitize.js';
import { log } from '../logger.js';
export const router = Router();
/* ----------------------------- Health ----------------------------- */
router.get('/health', async (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});
// All routes below this point require SSO authentication via SAML.
// Health probe is kept open for ACA load-balancer / container readiness.
router.use(ensureAuthenticated);
/* ----------------------------- Sedi ----------------------------- */
router.get('/sedi', async (_req, res) => {
    const sedi = await listSedi();
    res.json({ data: sedi });
});
router.get('/sedi/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
        return res.status(400).json({ success: false, error: 'Invalid sede id' });
    }
    const sede = await getSedeById(id);
    if (!sede)
        return res.status(404).json({ success: false, error: 'Sede non trovata' });
    // Include the pre-filled WLC connection params so the frontend can
    // pre-populate the login form.
    const wlc = await getWlcConfigBySede(id);
    res.json({ data: { ...sede, wlcHost: wlc.host, wlcPort: wlc.port, wlcSshPort: wlc.sshPort, wlcSsid: wlc.wlanSsid } });
});
/* ----------------------------- WLC (per-sede) ----------------------------- */
router.post('/wlc/login', async (req, res) => {
    const { host, port, username, password, sedeId } = req.body ?? {};
    if (!host || !username || !password) {
        return res.status(400).json({ success: false, error: 'host, username e password sono obbligatori' });
    }
    // Sanitize before storing — these values flow through the DB and are later
    // used in SSH commands from guest CRUD endpoints.
    let safeUsername, safePassword;
    try {
        safeUsername = validateUsername(username);
        safePassword = validatePassword(password);
    }
    catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
    const result = await loginWebUi({
        host: String(host),
        port: Number(port) || 443,
        username: safeUsername,
        password: safePassword,
    });
    if (result.success && sedeId) {
        await updateWlcConfigBySede(Number(sedeId), {
            host: String(host),
            port: Number(port) || 443,
            username: safeUsername,
            password: safePassword,
            authenticated: true,
        });
    }
    else if (sedeId && (!('isUnreachable' in result) || !result.isUnreachable)) {
        await updateWlcConfigBySede(Number(sedeId), {
            host: String(host),
            port: Number(port) || 443,
            username: safeUsername,
            password: safePassword,
            authenticated: false,
        });
    }
    return res.json(result);
});
router.post('/wlc/create-user', async (req, res) => {
    const { host, port, sshPort, username, password, config: cfg } = req.body ?? {};
    if (!host || !username || !password || !cfg?.targetUsername || !cfg?.targetPassword) {
        return res.status(400).json({ success: false, error: 'Parametri mancanti' });
    }
    // Sanitize inputs to prevent SSH command injection
    let safeUsername, safePassword, safeTargetUser, safeTargetPass;
    try {
        safeUsername = validateUsername(username);
        safePassword = validatePassword(password);
        safeTargetUser = validateUsername(cfg.targetUsername);
        safeTargetPass = validatePassword(cfg.targetPassword);
    }
    catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
    const result = await execSsh({
        host: String(host),
        port: Number(sshPort) || 22,
        username: safeUsername,
        password: safePassword,
        commands: [
            'terminal length 0',
            'configure terminal',
            `user-name ${safeTargetUser}`,
            `password 0 ${safeTargetPass}`,
            `type network-user description Guest-User guest-user lifetime ${cfg.durationMinutes ? minutesToLifetime(cfg.durationMinutes) : minutesToLifetime(1440)}`,
            'description Guest-User',
            'do write memory', 'end',
            `show running-config | include user-name ${safeTargetUser}`,
            'exit',
        ],
    });
    await addSyncLog({
        action: `create-user ${safeTargetUser}`,
        method: 'SSH',
        url: `${host}:${sshPort ?? 22}`,
        payload: JSON.stringify(cfg),
        statusCode: result.success ? 201 : 401,
    });
    if (!result.success && /access denied|unauthorized/i.test(result.error ?? '')) {
        return res.json({ success: false, status: 401, error: 'Accesso SSH negato.' });
    }
    if (!result.success) {
        return res.json({ success: false, status: 401, error: result.error ?? 'Errore SSH' });
    }
    return res.json({ success: true, status: 201, method: 'ssh', message: `Utente ${safeTargetUser} creato.` });
});
router.put('/wlc/status-user', async (req, res) => {
    const { host, port, sshPort, username, password, targetUsername, enabled } = req.body ?? {};
    if (!host || !username || !password || !targetUsername) {
        return res.status(400).json({ success: false, error: 'Parametri mancanti' });
    }
    // Sanitize inputs to prevent SSH command injection
    let safeTargetUser;
    try {
        safeTargetUser = validateUsername(targetUsername);
    }
    catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
    if (enabled) {
        await addSyncLog({
            action: `verify-user ${safeTargetUser}`,
            method: 'SSH',
            url: `${host}:${sshPort ?? 22}`,
            payload: null,
            statusCode: 200,
        });
        return res.json({ success: true, status: 200, message: `Utente ${safeTargetUser} verificato.` });
    }
    let safeUsername, safePassword;
    try {
        safeUsername = validateUsername(username);
        safePassword = validatePassword(password);
    }
    catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
    const result = await execSsh({
        host: String(host),
        port: Number(sshPort) || 22,
        username: safeUsername,
        password: safePassword,
        commands: [
            'terminal length 0',
            'configure terminal',
            `no user-name ${safeTargetUser}`,
            'end',
            `show running-config | include user-name ${safeTargetUser}`,
            'exit',
        ],
    });
    await addSyncLog({
        action: `deactivate-user ${safeTargetUser}`,
        method: 'SSH',
        url: `${host}:${sshPort ?? 22}`,
        payload: null,
        statusCode: result.success ? 200 : 401,
    });
    if (!result.success) {
        return res.json({ success: false, status: 401, error: result.error ?? 'Errore SSH' });
    }
    return res.json({ success: true, status: 200, message: `Utente ${safeTargetUser} disattivato.` });
});
router.post('/wlc/delete-user', async (req, res) => {
    const { host, port, sshPort, username, password, targetUsername } = req.body ?? {};
    if (!host || !username || !password || !targetUsername) {
        return res.status(400).json({ success: false, error: 'Parametri mancanti' });
    }
    // Sanitize inputs to prevent SSH command injection
    let safeUsername, safePassword, safeTargetUser;
    try {
        safeUsername = validateUsername(username);
        safePassword = validatePassword(password);
        safeTargetUser = validateUsername(targetUsername);
    }
    catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
    const result = await execSsh({
        host: String(host),
        port: Number(sshPort) || 22,
        username: safeUsername,
        password: safePassword,
        commands: [
            'terminal length 0',
            'configure terminal',
            `no user-name ${safeTargetUser}`,
            'do write memory', 'end',
            `show running-config | include user-name ${safeTargetUser}`,
            'exit',
        ],
    });
    await addSyncLog({
        action: `delete-user ${safeTargetUser}`,
        method: 'SSH',
        url: `${host}:${sshPort ?? 22}`,
        payload: null,
        statusCode: result.success ? 200 : 401,
    });
    if (!result.success) {
        return res.json({ success: false, status: 401, error: result.error ?? 'Errore SSH' });
    }
    return res.json({ success: true, status: 200, message: `Utente ${safeTargetUser} eliminato.` });
});
router.post('/wlc/get-users', async (req, res) => {
    const { host, port, sshPort, username, password } = req.body ?? {};
    if (!host || !username || !password) {
        return res.status(400).json({ success: false, error: 'Parametri mancanti' });
    }
    const result = await execSsh({
        host: String(host),
        port: Number(sshPort) || 22,
        username: String(username),
        password: String(password),
        commands: [
            'terminal length 0',
            'show running-config | section user-name',
            'exit',
        ],
    });
    if (!result.success) {
        return res.json({ success: false, error: result.error ?? 'Errore SSH' });
    }
    const users = extractGuestUsers(result.output);
    return res.json({ success: true, data: { 'webauth-local-users': users } });
});
/**
 * Import WLC captive portal users into the local `guests` table.
 * For each user found on the WLC via SSH, this checks whether a guest
 * with the same username already exists for the given sede. If not, a
 * new guest entry is created with status='active' so it appears in the
 * Dashboard's guest table. The imported users have no known password
 * or duration — they are marks that the operator can later activate,
 * revoke, or delete via the usual flows.
 */
router.post('/wlc/import-users', async (req, res) => {
    const { host, port, sshPort, username, password, sedeId } = req.body ?? {};
    if (!host || !username || !password) {
        return res.status(400).json({ success: false, error: 'Parametri mancanti' });
    }
    // 1. Fetch the list of users from the WLC via SSH
    const ssh = await execSsh({
        host: String(host),
        port: Number(sshPort) || 22,
        username: String(username),
        password: String(password),
        commands: [
            'terminal length 0',
            'show running-config | include ^username',
            'exit',
        ],
    });
    if (!ssh.success) {
        return res.json({ success: false, error: ssh.error ?? 'Errore SSH' });
    }
    const wlcUsers = parseUsernameList(ssh.output);
    if (wlcUsers.length === 0) {
        return res.json({ success: true, data: { imported: [], message: 'Nessun utente trovato sul WLC.' } });
    }
    // 2. Find the target sede (body parameter, or fall back to the config)
    const targetSedeId = sedeId != null ? Number(sedeId) : null;
    // 3. Get the WLC config to use its host/name as defaults
    //    (if sedeId is provided, get the per-sede config; otherwise the legacy one)
    const wlc = targetSedeId != null ? await getWlcConfigBySede(targetSedeId) : await getWlcConfig();
    // 4. For each WLC user, check if a guest with that username already
    //    exists for this sede; if not, create one.
    const existingGuests = targetSedeId != null
        ? await listGuests({ sedeId: targetSedeId, status: 'all' })
        : [];
    const existingUsernames = new Set(existingGuests.map((g) => g.username));
    const imported = [];
    const skipped = [];
    for (const wu of wlcUsers) {
        if (existingUsernames.has(wu.username)) {
            skipped.push(wu.username);
            continue;
        }
        const newGuest = await createGuest({
            id: `g-${uuid().slice(0, 8)}`,
            name: wu.username, // WLC username used as display name (no real name available)
            email: null,
            phone: null,
            company: 'Utente WLC',
            host: wlc.host,
            username: wu.username,
            password: null, // we never know the password from a running-config
            durationMinutes: 480, // default 8h (unknown from WLC)
            status: 'active',
            enabledAt: new Date().toISOString(),
            remarks: 'Importato dal WLC',
            sedeId: targetSedeId,
        });
        imported.push(newGuest);
        await addSyncLog({
            action: `import-user ${wu.username} (sede ${targetSedeId ?? '?'})`,
            method: 'SSH',
            url: `${host}:${sshPort ?? 22}`,
            payload: null,
            statusCode: 201,
        });
    }
    return res.json({
        success: true,
        data: {
            imported,
            skipped,
            totalOnController: wlcUsers.length,
            message: `Importati ${imported.length} utenti dal WLC${skipped.length > 0 ? ` (${skipped.length} già presenti, saltati)` : ''}.`,
        },
    });
});
/* ----------------------------- Guests ----------------------------- */
router.get('/guests', async (req, res) => {
    const search = req.query.search ?? '';
    const status = req.query.status ?? 'all';
    const sedeId = req.query.sedeId ? Number(req.query.sedeId) : null;
    const guests = await listGuests({ search, status, sedeId: Number.isFinite(sedeId) ? sedeId : null });
    res.json({ data: guests });
});
/**
 * Create a guest. The plaintext password is generated in RAM, pushed
 * to the WLC via SSH (fire-and-forget), sent via SMTP, and returned
 * to the operator one-time in the response under `oneTimePassword`.
 * It is NEVER written to the DB.
 */
router.post('/guests', async (req, res) => {
    const { name, email, phone, company, host, durationMinutes, remarks, sedeId } = req.body ?? {};
    if (!name || !host || !durationMinutes || !sedeId) {
        return res.status(400).json({ success: false, error: 'name, host, durationMinutes e sedeId sono obbligatori' });
    }
    // Validate inputs — host is used in SSH commands, durationMinutes is a number
    try {
        validateHost(host);
    }
    catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
    const { username, password } = generateCredentials(String(name));
    const guestInput = {
        id: `g-${uuid().slice(0, 8)}`,
        name: String(name),
        email: email ? String(email) : null,
        phone: phone ? String(phone) : null,
        company: company ? String(company) : 'Ospite Individuale',
        host: String(host),
        username,
        password: null, // NEVER persisted
        durationMinutes: Number(durationMinutes),
        status: 'active',
        enabledAt: new Date().toISOString(),
        remarks: remarks ? String(remarks) : 'Registrato manualmente',
        sedeId: Number(sedeId),
    };
    const guest = await createGuest(guestInput);
    const wlc = await getWlcConfigBySede(Number(sedeId));
    const expiresAt = new Date(Date.now() + Number(durationMinutes) * 60_000).toLocaleString();
    // Fire-and-forget WLC create + email send
    void (async () => {
        if (!wlc.authenticated) {
            await addSyncLog({
                action: `create-user ${username} (offline)`,
                method: 'SSH',
                url: null,
                payload: null,
                statusCode: 0,
            });
        }
        else {
            const r = await execSsh({
                host: wlc.host,
                port: wlc.sshPort,
                username: wlc.username,
                password: wlc.password,
                commands: [
                    'terminal length 0',
                    'configure terminal',
                    `user-name ${username}`,
                    `password 0 ${password}`,
                    `type network-user description Guest-User guest-user lifetime ${minutesToLifetime(Number(durationMinutes))}`,
                    'description Guest-User',
                    'do write memory', 'end',
                    `show running-config | include user-name ${username}`,
                    'exit',
                ],
            });
            await addSyncLog({
                action: `create-user ${username}`,
                method: 'SSH',
                url: `${wlc.host}:${wlc.sshPort}`,
                payload: null,
                statusCode: r.success ? 201 : 401,
            });
            if (!r.success) {
                log.warn({ username, err: r.error }, 'WLC create-user failed');
            }
        }
        if (email) {
            const mail = await sendCredentialEmail({
                to: String(email),
                guestName: String(name),
                company: company ? String(company) : null,
                host: String(host),
                username,
                password,
                ssid: wlc.wlanSsid,
                durationMinutes: Number(durationMinutes),
                expiresAt,
            });
            await addSyncLog({
                action: mail.ok ? `email-credentials sent (${mail.mode})` : `email-credentials failed: ${mail.error}`,
                method: 'SMTP',
                url: String(email),
                payload: null,
                statusCode: mail.ok ? 200 : 500,
            });
        }
    })();
    // Return the one-time password to the operator for display.
    res.json({ data: { ...guest, oneTimePassword: password } });
});
/**
 * Re-send (or regenerate) credentials for an existing guest.
 * Always regenerates a new password (the old one is gone — we never
 * stored it), pushes it to the WLC, and emails it.
 */
router.post('/guests/:id/resend-credentials', async (req, res) => {
    const id = String(req.params.id);
    const before = await getGuest(id);
    if (!before)
        return res.status(404).json({ success: false, error: 'Guest non trovato' });
    if (!before.email) {
        return res.status(400).json({ success: false, error: 'L\'ospite non ha un indirizzo email — impossibile inviare le credenziali.' });
    }
    // Generate a fresh password (deterministic seed from the guest id to keep
    // the username stable; only the password changes).
    const { username, password } = generateCredentials(`${before.name}-${Date.now()}`);
    const newUsername = before.username; // keep the same WLC username
    const wlc = before.sedeId != null ? await getWlcConfigBySede(before.sedeId) : await getWlcConfig();
    const expiresAt = new Date(Date.now() + before.durationMinutes * 60_000).toLocaleString();
    let wlcOk = false;
    if (wlc.authenticated) {
        const r = await execSsh({
            host: wlc.host,
            port: wlc.sshPort,
            username: wlc.username,
            password: wlc.password,
            commands: [
                'terminal length 0',
                'configure terminal',
                `user-name ${newUsername}`,
                `password 0 ${password}`,
                `type network-user description Guest-User guest-user lifetime ${minutesToLifetime(before.durationMinutes)}`,
                'description Guest-User',
                'do write memory', 'end',
                `show running-config | include user-name ${newUsername}`,
                'exit',
            ],
        });
        wlcOk = r.success;
        await addSyncLog({
            action: `resend-credentials ${newUsername}`,
            method: 'SSH',
            url: `${wlc.host}:${wlc.sshPort}`,
            payload: null,
            statusCode: r.success ? 200 : 401,
        });
    }
    else {
        await addSyncLog({
            action: `resend-credentials ${newUsername} (offline)`,
            method: 'SSH',
            url: null,
            payload: null,
            statusCode: 0,
        });
    }
    const mail = await sendCredentialEmail({
        to: before.email,
        guestName: before.name,
        company: before.company,
        host: before.host,
        username: newUsername,
        password,
        ssid: wlc.wlanSsid,
        durationMinutes: before.durationMinutes,
        expiresAt,
    });
    await addSyncLog({
        action: mail.ok ? `resend-email sent (${mail.mode})` : `resend-email failed: ${mail.error}`,
        method: 'SMTP',
        url: before.email,
        payload: null,
        statusCode: mail.ok ? 200 : 500,
    });
    res.json({
        success: mail.ok,
        oneTimePassword: password,
        wlcUpdated: wlcOk,
        emailSent: mail.ok,
        emailMode: mail.mode,
    });
});
router.put('/guests/:id', async (req, res) => {
    const id = String(req.params.id);
    const patch = req.body ?? {};
    const before = await getGuest(id);
    if (!before)
        return res.status(404).json({ success: false, error: 'Guest non trovato' });
    const updated = await updateGuest(id, patch);
    if (patch.status && patch.status !== before.status) {
        const cfg = before.sedeId != null ? await getWlcConfigBySede(before.sedeId) : await getWlcConfig();
        if (cfg.authenticated) {
            if (patch.status === 'active') {
                // The plaintext password is never persisted, so we cannot push
                // it to the WLC on activation. The operator must use the
                // "Re-invia Credenziali" flow to (re)generate a password and
                // push it to the controller. We still flip the DB status
                // and set enabledAt so the timer tracks elapsed time.
                if (!before.enabledAt) {
                    await updateGuest(id, { enabledAt: new Date().toISOString() });
                }
                await addSyncLog({
                    action: `activate-user ${before.username} (no password stored; use resend-credentials)`,
                    method: 'SSH', url: `${cfg.host}:${cfg.sshPort}`,
                    payload: null, statusCode: 200,
                });
            }
            else if (patch.status === 'deactivated') {
                void execSsh({
                    host: cfg.host,
                    port: cfg.sshPort,
                    username: cfg.username,
                    password: cfg.password,
                    commands: [
                        'terminal length 0',
                        'configure terminal',
                        `no user-name ${before.username}`,
                        'do write memory', 'end', 'exit',
                    ],
                }).then((r) => addSyncLog({
                    action: `deactivate-user ${before.username}`,
                    method: 'SSH', url: `${cfg.host}:${cfg.sshPort}`,
                    payload: null, statusCode: r.success ? 200 : 401,
                }));
            }
        }
        else {
            await addSyncLog({
                action: `${patch.status} ${before.username} (offline)`,
                method: 'SSH', url: null, payload: null, statusCode: 0,
            });
        }
    }
    res.json({ data: updated });
});
router.delete('/guests/:id', async (req, res) => {
    const id = String(req.params.id);
    const before = await getGuest(id);
    if (!before)
        return res.status(404).json({ success: false, error: 'Guest non trovato' });
    await deleteGuest(id);
    const cfg = before.sedeId != null ? await getWlcConfigBySede(before.sedeId) : await getWlcConfig();
    if (cfg.authenticated) {
        void execSsh({
            host: cfg.host,
            port: cfg.sshPort,
            username: cfg.username,
            password: cfg.password,
            commands: [
                'terminal length 0',
                'configure terminal',
                `no user-name ${before.username}`,
                'do write memory', 'end', 'exit',
            ],
        }).then((r) => addSyncLog({
            action: `delete-user ${before.username}`,
            method: 'SSH', url: `${cfg.host}:${cfg.sshPort}`,
            payload: null, statusCode: r.success ? 200 : 401,
        }));
    }
    res.json({ success: true });
});
/* ----------------------------- Configs ----------------------------- */
router.get('/config/wlc', async (_req, res) => res.json({ data: await getWlcConfig() }));
router.put('/config/wlc', async (req, res) => res.json({ data: await updateWlcConfig(req.body ?? {}) }));
router.get('/config/email', async (_req, res) => res.json({ data: await getEmailConfig() }));
router.put('/config/email', async (req, res) => res.json({ data: await updateEmailConfig(req.body ?? {}) }));
router.get('/config/sms', async (_req, res) => res.json({ data: await getSmsConfig() }));
router.put('/config/sms', async (req, res) => res.json({ data: await updateSmsConfig(req.body ?? {}) }));
/* ----------------------------- Logs ----------------------------- */
router.get('/sync-logs', async (_req, res) => res.json({ data: await listSyncLogs(200) }));
router.delete('/sync-logs', async (_req, res) => {
    await clearSyncLogs();
    res.json({ success: true });
});
//# sourceMappingURL=index.js.map