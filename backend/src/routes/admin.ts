/**
 * Administrative API: the user directory, site/WLC settings, and a read-mostly
 * view of the break-glass accounts.
 *
 * Kept in its own file rather than folded into `routes/index.ts` so the entire
 * administrative surface can be reviewed in one sitting — which is the sort of
 * thing a compliance review asks for and a 700-line router does not give you.
 *
 * Mounted behind `requireRole('admin')`; nothing here re-checks that.
 */
import { Router, type Request, type Response } from 'express';
import { log } from '../logger.js';
import { invalidateAuthProfile } from '../middleware/authorize.js';
import { isRole, isUserStatus, type Role, type UserStatus } from '../auth/authorization.js';
import {
  listAppUsers,
  getAppUserById,
  updateAppUserProfile,
  replaceAppUserSedi,
  countActiveAdmins,
  deleteAppUser,
  type AppUserRecord,
} from '../repositories/appUsers.js';
import {
  listBreakGlassAccountsForAdmin,
  setBreakGlassEnabled,
  unlockBreakGlassAccount,
  countUsableBreakGlassAccounts,
  getBreakGlassAccount,
} from '../repositories/breakglass.js';
import {
  listSediAdmin,
  getAdminSedeById,
  getSedeByCode,
  createSede,
  updateSede,
  setSedeActive,
  recordWlcCheck,
  deleteSede,
  countGuestsBySede,
  credentialNamesForSedeCode,
  addSyncLog,
} from '../repositories/index.js';
import { loginWebUi } from '../services/wlcWebui.js';
import {
  readWlcPasswordFromVault,
  writeWlcPasswordToVault,
  reloadWlcPasswords,
  describeKeyVaultError,
  KeyVaultNotConfiguredError,
  type WlcReloadResult,
} from '../services/wlcCredentials.js';
import { wlcPasswordForSede } from '../config.js';
import { validateHost, validateUsername, validatePassword } from '../utils/sanitize.js';

/** Site codes become Key Vault secret names, so they are tightly constrained. */
const SEDE_CODE_PATTERN = /^[A-Z0-9]{2,20}$/;

function actorOf(req: Request): string {
  return req.authz?.email || req.authz?.subject || 'unknown';
}

function toUserDto(u: AppUserRecord) {
  return {
    id: u.id,
    subject: u.subject,
    email: u.email,
    displayName: u.displayName,
    entraObjectId: u.entraObjectId,
    role: u.role,
    status: u.status,
    sedeIds: u.sedeIds,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    profiledAt: u.profiledAt?.toISOString() ?? null,
    profiledBy: u.profiledBy,
    autoAdmin: u.autoAdmin,
  };
}

export function createAdminRouter(): Router {
  const router = Router();

  /* ----------------------------- Users ----------------------------- */

  router.get('/users', async (req: Request, res: Response) => {
    const status = req.query.status;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const users = await listAppUsers({
      status: isUserStatus(status) ? status : undefined,
      search,
    });
    res.json({ success: true, data: users.map(toUserDto) });
  });

  router.get('/users/:id', async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: 'invalid_payload', message: 'Id utente non valido.' });
    }
    const user = await getAppUserById(id);
    if (!user) return res.status(404).json({ success: false, error: 'not_found', message: 'Utente non trovato.' });
    res.json({ success: true, data: toUserDto(user) });
  });

  /**
   * Profile a user: role, status, granted sites.
   *
   * The two guards exist because the alternative is an application nobody can
   * administer any more: an admin demoting themselves by mistake, or the last
   * admin being suspended, both leave a directory where every remaining user is
   * blocked and nobody can unblock them.
   */
  router.patch('/users/:id', async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: 'invalid_payload', message: 'Id utente non valido.' });
    }

    const body = (req.body ?? {}) as { role?: unknown; status?: unknown; sedeIds?: unknown };
    const target = await getAppUserById(id);
    if (!target) return res.status(404).json({ success: false, error: 'not_found', message: 'Utente non trovato.' });

    if (body.role !== undefined && !isRole(body.role)) {
      return res.status(400).json({ success: false, error: 'invalid_payload', message: 'Ruolo non valido.' });
    }
    if (body.status !== undefined && !isUserStatus(body.status)) {
      return res.status(400).json({ success: false, error: 'invalid_payload', message: 'Stato non valido.' });
    }
    if (body.sedeIds !== undefined && !Array.isArray(body.sedeIds)) {
      return res.status(400).json({ success: false, error: 'invalid_payload', message: 'sedeIds deve essere una lista.' });
    }

    const role = body.role as Role | undefined;
    const status = body.status as UserStatus | undefined;

    // A platform administrator by naming convention cannot be re-profiled: the
    // rule is reapplied on every login and at every authorization lookup, so
    // accepting the change would only be a lie that lasts until the next
    // request. Granting sites is still allowed — it just has no effect while the
    // account reaches every site anyway.
    if (target.autoAdmin && (role !== undefined || status !== undefined)) {
      return res.status(409).json({
        success: false,
        error: 'auto_admin_immutable',
        message: 'Questo account è amministratore per convenzione sull\'indirizzo: ruolo e stato non sono modificabili.',
      });
    }

    // Changing your own sites is fine; changing your own role or status is how
    // an admin accidentally locks themselves out.
    const isSelf = req.authz?.userId === target.id;
    if (isSelf && (role !== undefined || status !== undefined)) {
      return res.status(409).json({
        success: false,
        error: 'cannot_modify_self',
        message: 'Non puoi modificare il tuo ruolo o il tuo stato. Chiedi a un altro amministratore.',
      });
    }

    const wouldStopBeingAdmin =
      target.role === 'admin' &&
      target.status === 'active' &&
      ((role !== undefined && role !== 'admin') || (status !== undefined && status !== 'active'));

    if (wouldStopBeingAdmin && (await countActiveAdmins(target.id)) === 0) {
      return res.status(409).json({
        success: false,
        error: 'last_admin',
        message: 'È l\'ultimo amministratore attivo: promuovi qualcun altro prima di modificarlo.',
      });
    }

    if (body.sedeIds !== undefined) {
      const ids = (body.sedeIds as unknown[]).map(Number);
      if (ids.some((n) => !Number.isInteger(n))) {
        return res.status(400).json({ success: false, error: 'invalid_payload', message: 'sedeIds contiene valori non validi.' });
      }
      for (const sedeId of ids) {
        if (!(await getAdminSedeById(sedeId))) {
          return res.status(400).json({ success: false, error: 'unknown_sede', message: `Sede ${sedeId} inesistente.` });
        }
      }
      await replaceAppUserSedi(target.id, ids);
    }

    const updated =
      role !== undefined || status !== undefined
        ? await updateAppUserProfile(target.id, { role, status, profiledBy: actorOf(req) })
        : await getAppUserById(target.id);

    // Immediate on this replica; elsewhere within the cache TTL.
    invalidateAuthProfile(target.subject);

    // Logged at warn like every other privilege change, so an alert can watch
    // for promotions to admin without a new rule.
    log.warn(
      {
        event: 'admin-user-updated',
        actor: actorOf(req),
        target: target.subject,
        before: { role: target.role, status: target.status, sedeIds: target.sedeIds },
        after: { role: updated?.role, status: updated?.status, sedeIds: updated?.sedeIds },
        correlationId: req.correlationId,
      },
      'Admin updated a user profile',
    );

    res.json({ success: true, data: updated ? toUserDto(updated) : null });
  });

  router.delete('/users/:id', async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: 'invalid_payload', message: 'Id utente non valido.' });
    }
    const target = await getAppUserById(id);
    if (!target) return res.status(404).json({ success: false, error: 'not_found', message: 'Utente non trovato.' });

    if (req.authz?.userId === target.id) {
      return res.status(409).json({ success: false, error: 'cannot_modify_self', message: 'Non puoi eliminare il tuo account.' });
    }
    // Deleting a convention admin achieves nothing: the next sign-in re-creates
    // them as an active administrator.
    if (target.autoAdmin) {
      return res.status(409).json({
        success: false,
        error: 'auto_admin_immutable',
        message: 'Questo account è amministratore per convenzione sull\'indirizzo: non può essere eliminato.',
      });
    }
    if (target.role === 'admin' && target.status === 'active' && (await countActiveAdmins(target.id)) === 0) {
      return res.status(409).json({ success: false, error: 'last_admin', message: 'È l\'ultimo amministratore attivo.' });
    }

    await deleteAppUser(target.id);
    invalidateAuthProfile(target.subject);
    // The row is gone, so the log line is the only record of what it granted.
    log.warn(
      {
        event: 'admin-user-deleted',
        actor: actorOf(req),
        target: target.subject,
        before: { email: target.email, role: target.role, status: target.status, sedeIds: target.sedeIds },
        correlationId: req.correlationId,
      },
      'Admin deleted a user from the directory',
    );
    // The user can sign in again and will be re-created as pending.
    res.json({ success: true });
  });

  /* ----------------------------- Sedi / WLC ----------------------------- */

  router.get('/sedi', async (_req: Request, res: Response) => {
    res.json({ success: true, data: await listSediAdmin() });
  });

  router.get('/sedi/:id', async (req: Request, res: Response) => {
    const sede = await getAdminSedeById(Number(req.params.id));
    if (!sede) return res.status(404).json({ success: false, error: 'not_found', message: 'Sede non trovata.' });
    res.json({ success: true, data: sede });
  });

  /**
   * Create a site.
   *
   * The code is validated hard and checked for collisions on its *normalized*
   * form, because that is what becomes the environment variable: `SM-1` and
   * `SM_1` would otherwise map to one `WLC_PASSWORD_SM_1` and quietly share a
   * password between two different controllers.
   */
  router.post('/sedi', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = String(body.code ?? '').trim().toUpperCase();
    const name = String(body.name ?? '').trim();
    const city = String(body.city ?? '').trim();

    if (!SEDE_CODE_PATTERN.test(code)) {
      return res.status(400).json({
        success: false,
        error: 'invalid_code',
        message: 'Il codice sede deve essere di 2-20 caratteri, solo lettere maiuscole e cifre.',
      });
    }
    if (!name || !city) {
      return res.status(400).json({ success: false, error: 'invalid_payload', message: 'Nome e città sono obbligatori.' });
    }
    if (await getSedeByCode(code)) {
      return res.status(409).json({ success: false, error: 'duplicate_code', message: 'Codice sede già in uso.' });
    }

    const wanted = credentialNamesForSedeCode(code).envVar;
    const existing = await listSediAdmin();
    const clash = existing.find((sd) => credentialNamesForSedeCode(sd.code).envVar === wanted);
    if (clash) {
      return res.status(409).json({
        success: false,
        error: 'credential_collision',
        message: `Il codice normalizza su ${wanted}, già usato dalla sede ${clash.code}: le due condividerebbero la stessa password.`,
      });
    }

    const validation = validateSedeWlcFields(body);
    if (validation) return res.status(400).json({ success: false, error: 'invalid_payload', message: validation });

    const sede = await createSede(
      {
        code,
        name,
        city,
        address: body.address != null ? String(body.address) : null,
        wlcHost: body.wlcHost != null && String(body.wlcHost).trim() !== '' ? String(body.wlcHost).trim() : null,
        wlcPort: body.wlcPort != null ? Number(body.wlcPort) : undefined,
        wlcSshPort: body.wlcSshPort != null ? Number(body.wlcSshPort) : undefined,
        wlcUsername: body.wlcUsername != null ? String(body.wlcUsername) : undefined,
        wlcSsid: body.wlcSsid != null ? String(body.wlcSsid) : undefined,
        // New sites start out of service: their Key Vault secret does not exist
        // yet, so offering them to operators would only offer a failure.
        active: false,
      },
      actorOf(req),
    );

    await auditSede(req, 'admin-sede-created', sede.code);
    res.status(201).json({ success: true, data: sede });
  });

  router.put('/sedi/:id', async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const sede = await getAdminSedeById(id);
    if (!sede) return res.status(404).json({ success: false, error: 'not_found', message: 'Sede non trovata.' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.code != null && String(body.code).trim().toUpperCase() !== sede.code) {
      return res.status(400).json({
        success: false,
        error: 'code_immutable',
        message: 'Il codice sede non è modificabile: è ciò che collega la sede al suo segreto in Key Vault.',
      });
    }

    const validation = validateSedeWlcFields(body);
    if (validation) return res.status(400).json({ success: false, error: 'invalid_payload', message: validation });

    const updated = await updateSede(
      id,
      {
        name: body.name != null ? String(body.name).trim() : undefined,
        city: body.city != null ? String(body.city).trim() : undefined,
        address: body.address !== undefined ? (body.address != null ? String(body.address) : null) : undefined,
        wlcHost: body.wlcHost !== undefined
          ? (String(body.wlcHost ?? '').trim() || null)
          : undefined,
        wlcPort: body.wlcPort != null ? Number(body.wlcPort) : undefined,
        wlcSshPort: body.wlcSshPort != null ? Number(body.wlcSshPort) : undefined,
        wlcUsername: body.wlcUsername != null ? String(body.wlcUsername) : undefined,
        wlcSsid: body.wlcSsid != null ? String(body.wlcSsid) : undefined,
      },
      actorOf(req),
    );

    await auditSede(req, 'admin-sede-updated', sede.code);
    res.json({ success: true, data: updated });
  });

  /**
   * Switch a site in or out of service.
   *
   * Activating one that has never answered a probe is refused unless the caller
   * insists: the usual reason a site cannot be reached is that its Key Vault
   * secret has not been created yet, and turning it on regardless just moves the
   * failure to an operator who cannot do anything about it.
   */
  router.patch('/sedi/:id/active', async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const sede = await getAdminSedeById(id);
    if (!sede) return res.status(404).json({ success: false, error: 'not_found', message: 'Sede non trovata.' });

    const body = (req.body ?? {}) as { active?: unknown; force?: unknown };
    if (typeof body.active !== 'boolean') {
      return res.status(400).json({ success: false, error: 'invalid_payload', message: 'active deve essere booleano.' });
    }

    if (body.active && sede.wlcLastCheckOk !== true && body.force !== true) {
      return res.status(409).json({
        success: false,
        error: 'untested_sede',
        message: 'Esegui un test di connessione riuscito prima di attivare la sede, oppure forza l\'attivazione.',
        credentialConfigured: sede.credentialConfigured,
        credentialSecretName: sede.credentialSecretName,
      });
    }

    const updated = await setSedeActive(id, body.active, actorOf(req));
    await auditSede(req, body.active ? 'admin-sede-activated' : 'admin-sede-deactivated', sede.code);
    res.json({ success: true, data: updated });
  });

  /**
   * Probe a controller.
   *
   * Strictly a diagnostic: it records the outcome on the site and touches
   * nothing else. The old "Test Connessione" called the login endpoint and then
   * wrote `authenticated: true`, so running a test changed which controller the
   * application considered live — a test with a side effect is not a test.
   */
  router.post('/sedi/:id/test', async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const sede = await getAdminSedeById(id);
    if (!sede) return res.status(404).json({ success: false, error: 'not_found', message: 'Sede non trovata.' });

    if (!sede.wlcHost) {
      return res.status(400).json({
        success: false,
        error: 'WLC_NOT_CONFIGURED',
        message: 'Indirizzo del controller non configurato.',
      });
    }

    const password = wlcPasswordForSede(sede.code);
    if (!password) {
      await recordWlcCheck(id, false, 'CREDENTIAL_MISSING');
      return res.status(400).json({
        success: false,
        error: 'CREDENTIAL_MISSING',
        message: `Password non configurata: impostala dal pannello (segreto Key Vault ${sede.credentialSecretName}) oppure tramite ${sede.credentialEnvVar}.`,
        credentialSecretName: sede.credentialSecretName,
        credentialEnvVar: sede.credentialEnvVar,
      });
    }

    const result = await loginWebUi({
      host: sede.wlcHost,
      port: sede.wlcPort,
      username: sede.wlcUsername,
      password,
    });
    await recordWlcCheck(id, result.success, result.success ? null : (result.error ?? null));

    res.json({
      success: result.success,
      error: result.success ? undefined : result.error,
      isUnreachable: 'isUnreachable' in result ? result.isUnreachable : undefined,
      checkedAt: new Date().toISOString(),
    });
  });

  /*
   * Controller password, in Key Vault (COMPLIANCE.md D4).
   *
   * An accepted deviation from "secrets never cross the API": an admin can read
   * a site's password and replace it. What keeps it bounded:
   *   - admin-only (the whole router), and each read or write is audited at
   *     warn with the actor — a read is as sensitive as a write;
   *   - read on demand, one site at a time, never part of a list or of the site
   *     DTO, and sent with `Cache-Control: no-store`;
   *   - the value is never logged, and a write never echoes it back;
   *   - Key Vault stays the only store: nothing is written to the database.
   * The controller itself is not touched: the password must already have been
   * changed on the WLC before it is stored here.
   */

  router.get('/sedi/:id/password', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const sede = await getAdminSedeById(Number(req.params.id));
    if (!sede) return res.status(404).json({ success: false, error: 'not_found', message: 'Sede non trovata.' });

    let password: string | null;
    try {
      password = await readWlcPasswordFromVault(sede.code);
    } catch (err) {
      return keyVaultFailure(req, res, err, 'read', sede.code);
    }
    await auditSede(req, 'admin-wlc-password-viewed', sede.code);
    if (password == null) {
      return res.status(404).json({
        success: false,
        error: 'secret_not_found',
        message: `Il segreto ${sede.credentialSecretName} non esiste in Key Vault.`,
      });
    }
    res.json({ success: true, data: { password } });
  });

  router.put('/sedi/:id/password', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const sede = await getAdminSedeById(Number(req.params.id));
    if (!sede) return res.status(404).json({ success: false, error: 'not_found', message: 'Sede non trovata.' });

    const raw = (req.body ?? {}) as { password?: unknown };
    const submitted = typeof raw.password === 'string' ? raw.password : '';
    let password: string;
    try {
      // The validator trims, and a stored password quietly different from the
      // one on the controller would only surface as a failed login later.
      if (submitted !== submitted.trim()) {
        throw new Error('La password non può iniziare o finire con uno spazio');
      }
      // Same rules as any credential that ends up in an IOS-XE session:
      // printable ASCII, no line breaks.
      password = validatePassword(submitted);
    } catch (err) {
      return res.status(400).json({ success: false, error: 'invalid_payload', message: (err as Error).message });
    }

    try {
      await writeWlcPasswordToVault(sede.code, password);
    } catch (err) {
      return keyVaultFailure(req, res, err, 'write', sede.code);
    }
    await auditSede(req, 'admin-wlc-password-changed', sede.code);
    res.json({ success: true });
  });

  /**
   * Re-read every site's password from Key Vault into memory, so a secret
   * changed directly in the vault is used without restarting the container.
   */
  router.post('/wlc/reload', async (req: Request, res: Response) => {
    let result: WlcReloadResult;
    try {
      result = await reloadWlcPasswords();
    } catch (err) {
      return keyVaultFailure(req, res, err, 'reload', null);
    }
    log.warn(
      {
        event: 'admin-wlc-reload',
        actor: actorOf(req),
        loaded: result.loaded,
        missing: result.missing,
        failed: result.failed.map((f) => f.code),
        correlationId: req.correlationId,
      },
      'Admin reloaded the WLC passwords from Key Vault',
    );
    await addSyncLog({
      action: `admin-wlc-reload ${result.loaded.length} ok, ${result.missing.length} mancanti, ${result.failed.length} errori`,
      method: 'ADMIN',
      url: null,
      payload: null,
      statusCode: result.failed.length > 0 ? 207 : 200,
    });
    res.json({ success: true, data: result });
  });

  /**
   * Delete a site, but only while nothing points at it.
   *
   * `guests.sede_id` has no foreign key, so deleting a site with history would
   * leave those guests referencing an id that no longer resolves — and creating
   * a site with the same code later would hand it somebody else's past.
   */
  router.delete('/sedi/:id', async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const sede = await getAdminSedeById(id);
    if (!sede) return res.status(404).json({ success: false, error: 'not_found', message: 'Sede non trovata.' });

    const guests = await countGuestsBySede(id);
    if (guests > 0) {
      return res.status(409).json({
        success: false,
        error: 'SEDE_HAS_GUESTS',
        count: guests,
        message: `La sede ha ${guests} ospiti in archivio: disattivala invece di eliminarla.`,
      });
    }

    await deleteSede(id);
    await auditSede(req, 'admin-sede-deleted', sede.code);
    res.status(204).end();
  });

  /* ----------------------------- Break glass ----------------------------- */

  /*
   * Read, enable, disable, unlock — and nothing else.
   *
   * Creating an account and rotating its password stay in the CLI. These are
   * the credentials that bypass Entra and MFA entirely (COMPLIANCE.md D1), so a
   * compromised admin session must not be able to mint one.
   */

  router.get('/breakglass', async (req: Request, res: Response) => {
    // Even reading the list is audited: knowing which emergency accounts exist
    // is itself useful to an attacker.
    log.warn(
      { event: 'admin-breakglass-list', actor: actorOf(req), correlationId: req.correlationId },
      'Admin listed the break-glass accounts',
    );
    const accounts = await listBreakGlassAccountsForAdmin();
    const now = Date.now();
    res.json({
      success: true,
      data: accounts.map((a) => ({
        username: a.username,
        displayName: a.displayName,
        role: a.role,
        enabled: a.enabled,
        expiresAt: a.expiresAt?.toISOString() ?? null,
        lockedUntil: a.lockedUntil?.toISOString() ?? null,
        failedAttempts: a.failedAttempts,
        lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
        state: !a.enabled
          ? 'disabled'
          : a.expiresAt != null && a.expiresAt.getTime() <= now
            ? 'expired'
            : a.lockedUntil != null && a.lockedUntil.getTime() > now
              ? 'locked'
              : 'enabled',
      })),
    });
  });

  router.post('/breakglass/:username/enable', async (req: Request, res: Response) => {
    const username = String(req.params.username);
    if (!(await getBreakGlassAccount(username))) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Account non trovato.' });
    }
    await setBreakGlassEnabled(username, true);
    log.warn(
      { event: 'admin-breakglass-enable', actor: actorOf(req), target: username, correlationId: req.correlationId },
      'Admin enabled a break-glass account',
    );
    res.json({ success: true });
  });

  router.post('/breakglass/:username/disable', async (req: Request, res: Response) => {
    const username = String(req.params.username);
    if (!(await getBreakGlassAccount(username))) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Account non trovato.' });
    }
    // Refuse to close the last door. These accounts exist for when SSO is down,
    // and a directory where nobody can sign in is exactly when that matters.
    if ((await countUsableBreakGlassAccounts(username)) === 0) {
      return res.status(409).json({
        success: false,
        error: 'last_breakglass',
        message: 'È l\'ultimo account di emergenza utilizzabile: creane un altro dalla CLI prima di disabilitarlo.',
      });
    }
    await setBreakGlassEnabled(username, false);
    log.warn(
      { event: 'admin-breakglass-disable', actor: actorOf(req), target: username, correlationId: req.correlationId },
      'Admin disabled a break-glass account',
    );
    res.json({ success: true });
  });

  router.post('/breakglass/:username/unlock', async (req: Request, res: Response) => {
    const username = String(req.params.username);
    const ok = await unlockBreakGlassAccount(username);
    if (!ok) return res.status(404).json({ success: false, error: 'not_found', message: 'Account non trovato.' });
    log.warn(
      { event: 'admin-breakglass-unlock', actor: actorOf(req), target: username, correlationId: req.correlationId },
      'Admin cleared a break-glass lockout',
    );
    res.json({ success: true });
  });

  return router;
}

/**
 * Validate the WLC fields of a site payload.
 *
 * Host and username both end up inside SSH commands, so they go through the
 * same validators the guest endpoints use rather than a looser local check.
 * Returns an error message, or null when everything is acceptable.
 */
function validateSedeWlcFields(body: Record<string, unknown>): string | null {
  try {
    if (body.wlcHost != null && String(body.wlcHost).trim() !== '') {
      validateHost(String(body.wlcHost).trim());
    }
    if (body.wlcUsername != null) {
      validateUsername(String(body.wlcUsername));
    }
  } catch (err) {
    return (err as Error).message;
  }

  for (const key of ['wlcPort', 'wlcSshPort']) {
    const raw = body[key];
    if (raw == null) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return `${key} deve essere una porta valida (1-65535).`;
  }

  if (body.wlcSsid != null) {
    const ssid = String(body.wlcSsid);
    if (ssid.length > 100) return 'SSID troppo lungo (massimo 100 caratteri).';
    // Control characters would break the IOS-XE command the SSID ends up in.
    // Checked by code point rather than a regex so no control character has
    // to appear literally in this file.
    for (let i = 0; i < ssid.length; i++) {
      if (ssid.charCodeAt(i) < 0x20 || ssid.charCodeAt(i) === 0x7f) {
        return 'SSID contiene caratteri non validi.';
      }
    }
  }

  return null;
}

/**
 * Answer a failed Key Vault call: 503 when it is not configured, 502 otherwise.
 * The SDK message is logged (it names the missing permission, which is what the
 * operator needs) but not returned verbatim to the browser.
 */
function keyVaultFailure(
  req: Request,
  res: Response,
  err: unknown,
  operation: 'read' | 'write' | 'reload',
  code: string | null,
): Response {
  if (err instanceof KeyVaultNotConfiguredError) {
    return res.status(503).json({ success: false, error: 'keyvault_unavailable', message: err.message });
  }
  log.error(
    { event: 'admin-wlc-keyvault-error', operation, code, err: describeKeyVaultError(err), actor: actorOf(req), correlationId: req.correlationId },
    'Key Vault call failed',
  );
  return res.status(502).json({
    success: false,
    error: 'keyvault_error',
    message: operation === 'write'
      ? 'Scrittura su Key Vault non riuscita: verifica che l\'identità del backend abbia il ruolo "Key Vault Secrets Officer".'
      : 'Lettura da Key Vault non riuscita.',
  });
}

/** Structured log plus a sync-log entry, so changes are visible in the UI too. */
async function auditSede(req: Request, event: string, code: string): Promise<void> {
  log.warn(
    { event, actor: actorOf(req), code, correlationId: req.correlationId },
    'Admin changed a site configuration',
  );
  await addSyncLog({
    action: `${event} ${code}`,
    method: 'ADMIN',
    url: null,
    payload: null,
    statusCode: 200,
  });
}
