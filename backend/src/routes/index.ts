/**
 * Express router for all REST endpoints.
 * Wires together repositories, WLC services, email service and the sync log.
 */
import { Router, type Request, type Response } from 'express';
import { v4 as uuid } from 'uuid';
import { ensureAuthenticated } from '../middleware/ensureAuth.js';
import {
  loadAuthorization,
  requireRole,
  requireSedeAccess,
  ensureSedeAllowed,
  allowedSedeIds,
} from '../middleware/authorize.js';
import {
  listGuests,
  getGuest,
  createGuest,
  updateGuest,
  deleteGuest,
  getWlcConfigBySede,
  recordWlcCheck,
  getSmsConfig,
  updateSmsConfig,
  listSyncLogs,
  clearSyncLogs,
  addSyncLog,
  listSedi,
  getSedeById,
} from '../repositories/index.js';
import { wlcPasswordForSede } from '../config.js';
import { loginWebUi } from '../services/wlcWebui.js';
import { execSsh, parseUsernameList, minutesToLifetime, extractGuestUsers } from '../services/wlcSsh.js';
import { sendCredentialEmail } from '../services/email.js';
import { searchDirectoryUsers, DirectoryDisabledError } from '../services/entraDirectory.js';
import { broadcast } from '../services/ws.js';
import { generateCredentials } from '../utils/credentials.js';
import { sanitizeIOSXE, validateUsername, validatePassword, validateHost, validateDurationMinutes } from '../utils/sanitize.js';
import { getDb } from '../db/index.js';
import { log } from '../logger.js';
import type { Guest, GuestStatus, Sede } from '../types.js';

export const router = Router();

/**
 * Bounds for a guest account lifetime, enforced server-side.
 *
 * They mirror the choices the register form offers (presets up to one week, or
 * a custom end date capped at the same week) — but the cap has to live here
 * too: the form used to expose a free-form minutes box that skipped it
 * entirely, and any client can post whatever it likes regardless.
 */
const MIN_GUEST_DURATION_MINUTES = 1;
const MAX_GUEST_DURATION_MINUTES = 7 * 24 * 60;

/**
 * Persist the session before answering.
 *
 * `connect-pg-simple` writes asynchronously, and the dashboard fires its first
 * `GET /guests` the instant this response lands. Without the wait that request
 * can read a session that does not yet know which site was chosen.
 */
function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * A site as an operator is allowed to see it.
 *
 * The SSID stays: it is the network name the guest has to type, and it appears
 * on the credentials the operator hands over. The controller address, its ports
 * and its admin account do not — an operator has no use for them, and the whole
 * point of moving them into the admin panel was to stop showing them.
 */
function toPublicSede(sede: Sede, isAdmin: boolean): Partial<Sede> {
  if (isAdmin) return sede;
  const { wlcHost: _h, wlcPort: _p, wlcSshPort: _sp, wlcUsername: _u, ...rest } = sede;
  return rest;
}

/** The site this operator is working on, or null if they have not picked one. */
function sessionSedeId(req: Request): number | null {
  return req.session.sedeId ?? null;
}

/* ----------------------------- Health ----------------------------- */

/**
 * Liveness probe — process alive, always 200, no dependency checks.
 * Used by ACA and Application Gateway health probes. Must stay open
 * (no auth) so the platform can assess container health.
 * Path: /api/healthz
 */
router.get('/healthz', async (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

/**
 * Readiness probe — checks PostgreSQL connectivity and returns 200
 * when the backend is ready to serve traffic. Returns 503 if DB is down.
 * Must stay open (no auth) for ACA and AGW health probes.
 * Path: /api/readyz
 */
router.get('/readyz', async (_req, res) => {
  try {
    const db = await getDb();
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', uptime: process.uptime(), timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      db: 'disconnected',
      error: (err as Error).message,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  }
});

/** @deprecated Use /api/healthz instead */
router.get('/health', async (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// All routes below this point require SSO authentication via SAML.
// Health probe is kept open for ACA load-balancer / container readiness.
router.use(ensureAuthenticated);
// Resolves req.authz, or answers 403/503 itself. Everything below can rely on
// req.authz being present and the user being active.
router.use(loadAuthorization);

/* ----------------------------- Session ----------------------------- */

/**
 * Everything the client needs to render itself: who the user is, what they may
 * do, and which site they are on.
 *
 * Replaces the old bootstrap, which inferred the current site from the first
 * row of the WLC config table — so a browser refresh could restore a site the
 * operator had never selected.
 */
router.get('/session/context', async (req: Request, res: Response) => {
  const authz = req.authz!;
  const sedeId = sessionSedeId(req);

  let sede: Sede | null = sedeId != null ? await getSedeById(sedeId) : null;
  let notice: string | undefined;

  // A site retired while somebody was working on it: drop them back to the
  // selector rather than leaving them pointed at something out of service.
  if (sede && !sede.active) {
    delete req.session.sedeId;
    delete req.session.wlcConnected;
    await saveSession(req);
    sede = null;
    notice = 'SEDE_INACTIVE';
  }

  const wlc = sede ? await getWlcConfigBySede(sede.id) : null;
  const isAdmin = authz.role === 'admin';

  res.json({
    data: {
      user: {
        displayName: authz.displayName,
        email: authz.email,
        role: authz.role,
        status: authz.status,
        sedeIds: authz.allSedi ? null : authz.sedeIds,
      },
      sede: sede ? toPublicSede(sede, isAdmin) : null,
      wlc: wlc
        ? {
            host: wlc.host,
            port: wlc.port,
            sshPort: wlc.sshPort,
            username: wlc.username,
            wlanSsid: wlc.wlanSsid,
            sedeId: wlc.sedeId,
            usable: wlc.usable,
            // Session state, not a controller property — see WlcConfig.
            authenticated: req.session.wlcConnected === true,
          }
        : null,
      ...(notice ? { notice } : {}),
    },
  });
});

/**
 * Release the current site without signing out.
 *
 * Deliberately not part of /auth/logout: "Cambia sede" keeps the application
 * session, it only forgets which controller this operator was bound to.
 */
router.delete('/session/sede', async (req: Request, res: Response) => {
  delete req.session.sedeId;
  delete req.session.wlcConnected;
  await saveSession(req);
  res.status(204).end();
});

/* ----------------------------- Sedi ----------------------------- */

router.get('/sedi', async (req: Request, res: Response) => {
  const authz = req.authz!;
  // Filtered here, not in the client: the selector hiding a site is a courtesy,
  // the API refusing it is the control.
  const sedi = await listSedi({ activeOnly: true, allowedIds: allowedSedeIds(authz) });
  const isAdmin = authz.role === 'admin';
  res.json({ data: sedi.map((s) => toPublicSede(s, isAdmin)) });
});

router.get('/sedi/:id', requireSedeAccess((req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) ? id : null;
}), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const sede = await getSedeById(id);
  if (!sede) return res.status(404).json({ success: false, error: 'Sede non trovata' });
  res.json({ data: toPublicSede(sede, req.authz!.role === 'admin') });
});

/* ----------------------------- WLC (per-sede) ----------------------------- */

router.post('/wlc/login', requireRole('admin', 'operator'), requireSedeAccess(), async (req: Request, res: Response) => {
  // Only the site id is accepted. Host, port and username used to come from the
  // request body and were written straight back to the database, which made the
  // login screen a way to reconfigure any controller. They now come from the
  // site record, and the password from Key Vault — never from the client (§2).
  const sedeId = Number((req.body ?? {}).sedeId);

  const sede = await getSedeById(sedeId);
  if (!sede) return res.status(404).json({ success: false, error: 'Sede non trovata' });
  if (!sede.active) {
    return res.status(409).json({ success: false, error: 'SEDE_INACTIVE', message: 'Sede disattivata.' });
  }
  if (!sede.wlcHost) {
    return res.status(400).json({
      success: false,
      error: 'WLC_NOT_CONFIGURED',
      message: 'Controller non ancora configurato per questa sede.',
    });
  }

  const password = wlcPasswordForSede(sede.code);
  if (!password) {
    return res.status(400).json({
      success: false,
      error: 'CREDENTIAL_MISSING',
      message: 'Password WLC non configurata per questa sede (impostare WLC_PASSWORD_<CODICE_SEDE> in Key Vault).',
    });
  }

  const result = await loginWebUi({
    host: sede.wlcHost,
    port: sede.wlcPort,
    username: sede.wlcUsername,
    password,
  });

  await recordWlcCheck(sede.id, result.success, result.success ? null : (result.error ?? null));

  if (result.success) {
    req.session.sedeId = sede.id;
    req.session.wlcConnected = true;
    await saveSession(req);
  }

  return res.json(result);
});

router.post('/wlc/create-user', requireRole('admin'), async (req: Request, res: Response) => {
  const { host, port, sshPort, username, password, config: cfg } = req.body ?? {};
  if (!host || !username || !password || !cfg?.targetUsername || !cfg?.targetPassword) {
    return res.status(400).json({ success: false, error: 'Parametri mancanti' });
  }

  // Sanitize inputs to prevent SSH command injection
  let safeUsername: string, safePassword: string, safeTargetUser: string, safeTargetPass: string;
  try {
    safeUsername = validateUsername(username);
    safePassword = validatePassword(password);
    safeTargetUser = validateUsername(cfg.targetUsername);
    safeTargetPass = validatePassword(cfg.targetPassword);
  } catch (err) {
    return res.status(400).json({ success: false, error: (err as Error).message });
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
  const safePayload = { ...cfg, targetPassword: '***' };
  await addSyncLog({
    action: `create-user ${safeTargetUser}`,
    method: 'SSH',
    url: `${host}:${sshPort ?? 22}`,
    payload: JSON.stringify(safePayload),
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

router.put('/wlc/status-user', requireRole('admin'), async (req: Request, res: Response) => {
  const { host, port, sshPort, username, password, targetUsername, enabled } = req.body ?? {};
  if (!host || !username || !password || !targetUsername) {
    return res.status(400).json({ success: false, error: 'Parametri mancanti' });
  }

  // Sanitize inputs to prevent SSH command injection
  let safeTargetUser: string;
  try {
    safeTargetUser = validateUsername(targetUsername);
  } catch (err) {
    return res.status(400).json({ success: false, error: (err as Error).message });
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

  let safeUsername: string, safePassword: string;
  try {
    safeUsername = validateUsername(username);
    safePassword = validatePassword(password);
  } catch (err) {
    return res.status(400).json({ success: false, error: (err as Error).message });
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

router.post('/wlc/delete-user', requireRole('admin'), async (req: Request, res: Response) => {
  const { host, port, sshPort, username, password, targetUsername } = req.body ?? {};
  if (!host || !username || !password || !targetUsername) {
    return res.status(400).json({ success: false, error: 'Parametri mancanti' });
  }

  // Sanitize inputs to prevent SSH command injection
  let safeUsername: string, safePassword: string, safeTargetUser: string;
  try {
    safeUsername = validateUsername(username);
    safePassword = validatePassword(password);
    safeTargetUser = validateUsername(targetUsername);
  } catch (err) {
    return res.status(400).json({ success: false, error: (err as Error).message });
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

router.post('/wlc/get-users', requireRole('admin'), async (req: Request, res: Response) => {
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
router.post('/wlc/import-users', requireRole('admin'), requireSedeAccess(), async (req: Request, res: Response) => {
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

  // 3. Get the WLC config to use its host/name as defaults.
  //    requireSedeAccess already rejected a request without a sedeId, so there
  //    is no legacy "first row" fallback left to reach for.
  if (targetSedeId == null) {
    return res.status(400).json({ success: false, error: 'sedeId è obbligatorio' });
  }
  const wlc = await getWlcConfigBySede(targetSedeId);
  if (!wlc) return res.status(404).json({ success: false, error: 'Sede non trovata' });

  // 4. For each WLC user, check if a guest with that username already
  //    exists for this sede; if not, create one.
  const existingGuests = targetSedeId != null
    ? await listGuests({ sedeId: targetSedeId, status: 'all' })
    : [];
  const existingUsernames = new Set(existingGuests.map((g) => g.username));

  const imported: Guest[] = [];
  const skipped: string[] = [];

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

/* ----------------------------- Directory ----------------------------- */

const DIRECTORY_QUERY_MIN = 2;
const DIRECTORY_QUERY_MAX = 64;

/**
 * Live people search in Entra ID for the "Referente" field.
 *
 * Nothing is cached, on purpose. Only display names come back, and the query is
 * never logged: it is somebody's name.
 */
router.get('/directory/users', requireRole('admin', 'operator'), async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  const hasControlChar = [...q].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (q.length < DIRECTORY_QUERY_MIN || q.length > DIRECTORY_QUERY_MAX || hasControlChar) {
    return res.status(400).json({
      success: false,
      error: 'invalid_query',
      message: `La ricerca deve contenere da ${DIRECTORY_QUERY_MIN} a ${DIRECTORY_QUERY_MAX} caratteri.`,
    });
  }

  try {
    const users = await searchDirectoryUsers(q);
    res.json({ success: true, data: users });
  } catch (err) {
    if (err instanceof DirectoryDisabledError) {
      return res.status(503).json({ success: false, error: 'directory_unavailable', message: err.message });
    }
    log.error(
      { err: (err as Error).message, queryLength: q.length, correlationId: req.correlationId },
      'Directory search failed',
    );
    res.status(502).json({ success: false, error: 'directory_error', message: 'Ricerca nella directory non riuscita.' });
  }
});

/* ----------------------------- Guests ----------------------------- */

router.get('/guests', async (req: Request, res: Response) => {
  const search = (req.query.search as string | undefined) ?? '';
  const status = (req.query.status as GuestStatus | 'all' | undefined) ?? 'all';

  // The site comes from the session. It used to come from the query string,
  // which meant any authenticated user could read another site's guests just by
  // editing the URL.
  const sedeId = sessionSedeId(req);
  if (sedeId == null) {
    return res.status(409).json({
      success: false,
      error: 'NO_SEDE_SELECTED',
      message: 'Nessuna sede selezionata.',
    });
  }

  // The client still sends the parameter; a mismatch is a bug worth seeing
  // rather than something to quietly honour or quietly ignore.
  const requested = req.query.sedeId ? Number(req.query.sedeId) : null;
  if (requested != null && requested !== sedeId) {
    return res.status(403).json({
      success: false,
      error: 'sede_mismatch',
      message: 'La sede richiesta non è quella della sessione.',
    });
  }

  const guests = await listGuests({ search, status, sedeId });
  res.json({ data: guests });
});

/**
 * Create a guest. The plaintext password is generated in RAM, pushed
 * to the WLC via SSH (fire-and-forget), sent via SMTP, and returned
 * to the operator one-time in the response under `oneTimePassword`.
 * It is NEVER written to the DB.
 */
router.post('/guests', requireRole('admin', 'operator'), requireSedeAccess(), async (req: Request, res: Response) => {
  const { name, email, phone, company, host, durationMinutes, remarks, sedeId } = req.body ?? {};
  if (!name || !host || !durationMinutes || !sedeId) {
    return res.status(400).json({ success: false, error: 'name, host, durationMinutes e sedeId sono obbligatori' });
  }

  // Validate inputs — host is used in SSH commands, durationMinutes is a number
  let minutes: number;
  try {
    validateHost(host);
    minutes = validateDurationMinutes(durationMinutes, MIN_GUEST_DURATION_MINUTES, MAX_GUEST_DURATION_MINUTES);
  } catch (err) {
    return res.status(400).json({ success: false, error: (err as Error).message });
  }

  const { username, password } = generateCredentials(String(name));
  const guestInput: Omit<Guest, 'createdAt' | 'elapsedSeconds' | 'password'> & { password: null } = {
    id: `g-${uuid().slice(0, 8)}`,
    name: String(name),
    email: email ? String(email) : null,
    phone: phone ? String(phone) : null,
    company: company ? String(company) : 'Ospite Individuale',
    host: String(host),
    username,
    password: null, // NEVER persisted
    durationMinutes: minutes,
    status: 'active',
    enabledAt: new Date().toISOString(),
    remarks: remarks ? String(remarks) : 'Registrato manualmente',
    sedeId: Number(sedeId),
  };
  const guest = await createGuest(guestInput);

  const wlc = await getWlcConfigBySede(Number(sedeId));
  const expiresAt = new Date(Date.now() + minutes * 60_000).toLocaleString();

  // Fire-and-forget WLC create + email send
  void (async () => {
    if (!wlc?.usable) {
      await addSyncLog({
        action: `create-user ${username} (offline)`,
        method: 'SSH',
        url: null,
        payload: null,
        statusCode: 0,
      });
    } else {
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
          `type network-user description Guest-User guest-user lifetime ${minutesToLifetime(minutes)}`,
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
        ssid: wlc?.wlanSsid ?? '',
        durationMinutes: minutes,
        expiresAt,
      });
      await addSyncLog({
        action: mail.ok ? `email-credentials sent (${mail.mode})` : `email-credentials failed: ${mail.error}`,
        method: 'GRAPH',
        url: String(email),
        payload: null,
        statusCode: mail.ok ? 200 : 500,
      });
    }
  })();

  broadcast({ type: 'guest:created', data: { id: guest.id, name: guest.name, username, sedeId: guest.sedeId } });

  // Return the one-time password to the operator for display.
  res.json({ data: { ...guest, oneTimePassword: password } });
});

/**
 * Re-send (or regenerate) credentials for an existing guest.
 * Always regenerates a new password (the old one is gone — we never
 * stored it), pushes it to the WLC, and emails it.
 */
router.post('/guests/:id/resend-credentials', requireRole('admin', 'operator'), async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const before = await getGuest(id);
  if (!before) return res.status(404).json({ success: false, error: 'Guest non trovato' });
  // The site is only known after the read, so the check happens here rather
  // than in a middleware that would have to fetch the guest a second time.
  if (!ensureSedeAllowed(req, res, before.sedeId)) return;
  if (!before.email) {
    return res.status(400).json({ success: false, error: 'L\'ospite non ha un indirizzo email — impossibile inviare le credenziali.' });
  }

  // Generate a fresh password (deterministic seed from the guest id to keep
  // the username stable; only the password changes).
  const { username, password } = generateCredentials(`${before.name}-${Date.now()}`);
  const newUsername = before.username; // keep the same WLC username

  const wlc = before.sedeId != null ? await getWlcConfigBySede(before.sedeId) : null;
  const expiresAt = new Date(Date.now() + before.durationMinutes * 60_000).toLocaleString();

  let wlcOk = false;
  if (wlc?.usable) {
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
  } else {
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
    ssid: wlc?.wlanSsid ?? '',
    durationMinutes: before.durationMinutes,
    expiresAt,
  });
  await addSyncLog({
    action: mail.ok ? `resend-email sent (${mail.mode})` : `resend-email failed: ${mail.error}`,
    method: 'GRAPH',
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

router.put('/guests/:id', requireRole('admin', 'operator'), async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const patch = req.body ?? {};
  const before = await getGuest(id);
  if (!before) return res.status(404).json({ success: false, error: 'Guest non trovato' });
  if (!ensureSedeAllowed(req, res, before.sedeId)) return;
  const updated = await updateGuest(id, patch);
  if (!updated) return res.status(500).json({ success: false, error: 'Errore aggiornamento guest' });

  if (patch.status && patch.status !== before.status) {
    // No fallback to "the first site": sending `no user-name` to the wrong
    // controller deletes a real account somewhere else.
    const cfg = before.sedeId != null ? await getWlcConfigBySede(before.sedeId) : null;
    if (cfg?.usable) {
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
      } else if (patch.status === 'deactivated') {
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
        }).then((r) =>
          addSyncLog({
            action: `deactivate-user ${before.username}`,
            method: 'SSH', url: `${cfg.host}:${cfg.sshPort}`,
            payload: null, statusCode: r.success ? 200 : 401,
          }),
        );
      }
    } else {
      await addSyncLog({
        action: `${patch.status} ${before.username} (offline)`,
        method: 'SSH', url: null, payload: null, statusCode: 0,
      });
    }
  }

  broadcast({ type: 'guest:updated', data: { id: updated.id, name: updated.name, username: updated.username, status: updated.status, sedeId: updated.sedeId } });

  res.json({ data: updated });
});

router.delete('/guests/:id', requireRole('admin', 'operator'), async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const before = await getGuest(id);
  if (!before) return res.status(404).json({ success: false, error: 'Guest non trovato' });
  if (!ensureSedeAllowed(req, res, before.sedeId)) return;
  await deleteGuest(id);

  const cfg = before.sedeId != null ? await getWlcConfigBySede(before.sedeId) : null;
  if (cfg?.usable) {
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
    }).then((r) =>
      addSyncLog({
        action: `delete-user ${before.username}`,
        method: 'SSH', url: `${cfg.host}:${cfg.sshPort}`,
        payload: null, statusCode: r.success ? 200 : 401,
      }),
    );
  }

  broadcast({ type: 'guest:deleted', data: { id: before.id, name: before.name, username: before.username, sedeId: before.sedeId } });

  res.json({ success: true });
});

/* ----------------------------- Configs (secrets stripped on GET) ----------------------------- */

/**
 * @deprecated Use GET /api/session/context.
 *
 * Kept for one release so an older frontend served by a previous ACA revision
 * keeps working during a rollout. Unlike the version it replaces, it resolves
 * the site from the session instead of reading whichever row happened to be
 * first.
 *
 * The PUT that used to sit alongside it is gone: it was the only caller of
 * `updateWlcConfig`, and that function always wrote to the first row whatever
 * site the operator was on. WLC settings are edited in the admin panel now.
 */
router.get('/config/wlc', async (req: Request, res: Response) => {
  const sedeId = sessionSedeId(req);
  if (sedeId == null) {
    return res.status(409).json({ success: false, error: 'NO_SEDE_SELECTED', message: 'Nessuna sede selezionata.' });
  }
  const cfg = await getWlcConfigBySede(sedeId);
  if (!cfg) return res.status(404).json({ success: false, error: 'Sede non trovata' });
  // Secrets stay in Key Vault, never in an API response (§4).
  res.json({ data: { ...cfg, password: undefined, authenticated: req.session.wlcConnected === true } });
});
// Email/SMTP config endpoints removed (§3): mail is Graph-only, no email_config.
router.get('/config/sms', requireRole('admin'), async (_req, res) => {
  const cfg = await getSmsConfig();
  // Strip apiKey from GET response.
  res.json({ data: { ...cfg, apiKey: undefined } });
});
router.put('/config/sms', requireRole('admin'), async (req, res) => res.json({ data: await updateSmsConfig(req.body ?? {}) }));

/* ----------------------------- Logs ----------------------------- */

router.get('/sync-logs', requireRole('admin', 'operator'), async (_req, res) => res.json({ data: await listSyncLogs(200) }));
router.delete('/sync-logs', requireRole('admin'), async (_req, res) => {
  await clearSyncLogs();
  res.json({ success: true });
});
