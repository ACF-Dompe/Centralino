/**
 * Repository layer — one place to translate between DB rows and domain types.
 */
import { getDb } from '../db/index.js';
import { wlcPasswordForSede } from '../config.js';
import type { Guest, WlcConfig, SmsConfig, SyncLog, GuestStatus, Sede, AdminSede } from '../types.js';

interface GuestRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  host: string;
  username: string;
  duration_minutes: number;
  elapsed_seconds: number;
  status: GuestStatus;
  created_at: string;
  enabled_at: string | null;
  remarks: string | null;
  sede_id: number | null;
}

function rowToGuest(r: GuestRow): Guest {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    company: r.company,
    host: r.host,
    username: r.username,
    password: null, // one-time password is never persisted (no DB column)
    durationMinutes: r.duration_minutes,
    elapsedSeconds: r.elapsed_seconds,
    status: r.status,
    createdAt: r.created_at,
    enabledAt: r.enabled_at,
    remarks: r.remarks,
    sedeId: r.sede_id,
  };
}

export async function listGuests(filter?: { search?: string; status?: GuestStatus | 'all'; sedeId?: number | null }): Promise<Guest[]> {
  const db = await getDb();
  const params: unknown[] = [];
  const where: string[] = [];
  if (filter?.search && filter.search.trim().length > 0) {
    const like = `%${filter.search.toLowerCase()}%`;
    where.push(`(LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(company) LIKE ? OR LOWER(host) LIKE ? OR LOWER(username) LIKE ?)`);
    params.push(like, like, like, like, like);
  }
  if (filter?.status && filter.status !== 'all') {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter?.sedeId != null) {
    where.push('sede_id = ?');
    params.push(filter.sedeId);
  }
  // Plain `created_at DESC` works in both SQLite and PostgreSQL.
  // PostgreSQL sorts the native `timestamp` column chronologically via the
  // type's comparator; SQLite stores `CURRENT_TIMESTAMP` as an ISO-8601
  // string that sorts correctly lexicographically. Both yield the same
  // ordering. The previous `datetime(created_at)` wrapper was SQLite-only
  // and crashed PostgreSQL with
  // `function datetime(timestamp without time zone) does not exist`,
  // which put the app in a restart loop and broke every periodic background
  // job (including the WLC sync).
  const sql =
    `SELECT * FROM guests` + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ` ORDER BY created_at DESC`;
  const res = await db.query(sql, params);
  return (res.rows as GuestRow[]).map(rowToGuest);
}

export async function getGuest(id: string): Promise<Guest | null> {
  const db = await getDb();
  const res = await db.query(`SELECT * FROM guests WHERE id = ?`, [id]);
  const rows = res.rows as GuestRow[];
  return rows.length > 0 ? rowToGuest(rows[0]) : null;
}

export async function createGuest(
  g: Omit<Guest, 'createdAt' | 'elapsedSeconds' | 'status' | 'password'> & { status?: GuestStatus; password?: string | null },
): Promise<Guest> {
  const db = await getDb();
  const status = g.status ?? 'pending';
  await db.query(
    `INSERT INTO guests
       (id, name, email, phone, company, host, username, duration_minutes, elapsed_seconds, status, created_at, enabled_at, remarks, sede_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, ?, ?, ?)`,
    [
      g.id,
      g.name,
      g.email,
      g.phone,
      g.company ?? 'Ospite Individuale',
      g.host,
      g.username,
      g.durationMinutes,
      status,
      g.enabledAt ?? null,
      g.remarks ?? null,
      g.sedeId ?? null,
    ],
  );
  return (await getGuest(g.id))!;
}

export async function updateGuest(id: string, patch: Partial<Guest>): Promise<Guest | null> {
  const db = await getDb();
  const map: Record<string, string> = {
    name: 'name',
    email: 'email',
    phone: 'phone',
    company: 'company',
    host: 'host',
    username: 'username',
    durationMinutes: 'duration_minutes',
    elapsedSeconds: 'elapsed_seconds',
    status: 'status',
    enabledAt: 'enabled_at',
    remarks: 'remarks',
    sedeId: 'sede_id',
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = map[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    params.push(v);
  }
  if (sets.length === 0) return getGuest(id);
  params.push(id);
  await db.query(`UPDATE guests SET ${sets.join(', ')} WHERE id = ?`, params);
  return getGuest(id);
}

export async function deleteGuest(id: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.query(`DELETE FROM guests WHERE id = ?`, [id]);
  return res.rowCount > 0;
}

/* --------------------------- Sedi (with their WLC) --------------------------- */

/*
 * The WLC parameters used to sit in a separate 1:1 `wlc_config` table linked
 * from both sides, so the two links could disagree — which is why the old reads
 * carried an OR-fallback and the uniqueness of the binding was only
 * "best-effort". They now live on `sedi`, one row per site.
 *
 * The password is still never here: it comes from Key Vault as
 * WLC_PASSWORD_<CODE> and is resolved per request.
 */

interface SedeRow {
  id: number;
  code: string;
  name: string;
  city: string;
  address: string | null;
  wlc_config_id: number | null;
  created_at: string;
  active: boolean;
  wlc_host: string | null;
  wlc_port: number;
  wlc_ssh_port: number;
  wlc_username: string;
  wlc_ssid: string;
  wlc_last_check_at: string | null;
  wlc_last_check_ok: boolean | null;
  wlc_last_check_error: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

function rowToSede(r: SedeRow): Sede {
  return {
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    city: String(r.city),
    address: r.address ?? null,
    wlcConfigId: r.wlc_config_id != null ? Number(r.wlc_config_id) : null,
    createdAt: String(r.created_at),
    active: Boolean(r.active),
    wlcHost: r.wlc_host ?? null,
    wlcPort: Number(r.wlc_port),
    wlcSshPort: Number(r.wlc_ssh_port),
    wlcUsername: String(r.wlc_username),
    wlcSsid: String(r.wlc_ssid),
  };
}

/** The env var and Key Vault secret a site's WLC password arrives in. */
export function credentialNamesForSedeCode(code: string): {
  envVar: string;
  secretName: string;
} {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return {
    envVar: `WLC_PASSWORD_${normalized}`,
    secretName: `WLC-PASSWORD-${normalized.replace(/_/g, '-')}`,
  };
}

function rowToAdminSede(r: SedeRow): AdminSede {
  const sede = rowToSede(r);
  const names = credentialNamesForSedeCode(sede.code);
  return {
    ...sede,
    // Only ever whether a password is configured — never the value.
    credentialConfigured: wlcPasswordForSede(sede.code).length > 0,
    credentialEnvVar: names.envVar,
    credentialSecretName: names.secretName,
    wlcLastCheckAt: r.wlc_last_check_at ?? null,
    wlcLastCheckOk: r.wlc_last_check_ok ?? null,
    wlcLastCheckError: r.wlc_last_check_error ?? null,
    updatedAt: r.updated_at ?? null,
    updatedBy: r.updated_by ?? null,
  };
}

/**
 * List sites, optionally restricted to the ones a user may reach.
 *
 * `allowedIds` of null means no restriction; an EMPTY array means the user has
 * been granted nothing and must therefore see nothing. Collapsing the two would
 * turn "no sites" into "every site", which is the wrong way round to be wrong.
 */
export async function listSedi(opts?: {
  activeOnly?: boolean;
  allowedIds?: number[] | null;
}): Promise<Sede[]> {
  const db = await getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts?.activeOnly) where.push('active = TRUE');

  if (opts?.allowedIds !== undefined && opts.allowedIds !== null) {
    if (opts.allowedIds.length === 0) return [];
    params.push(opts.allowedIds);
    where.push(`id = ANY($${params.length}::int[])`);
  }

  const res = await db.query(
    `SELECT * FROM sedi${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id ASC`,
    params,
  );
  return (res.rows as SedeRow[]).map(rowToSede);
}

/** Every site, with diagnostics. Admin panel only. */
export async function listSediAdmin(): Promise<AdminSede[]> {
  const db = await getDb();
  const res = await db.query(`SELECT * FROM sedi ORDER BY id ASC`);
  return (res.rows as SedeRow[]).map(rowToAdminSede);
}

export async function getSedeById(id: number): Promise<Sede | null> {
  const db = await getDb();
  const res = await db.query(`SELECT * FROM sedi WHERE id = ?`, [id]);
  const rows = res.rows as SedeRow[];
  return rows.length > 0 ? rowToSede(rows[0]) : null;
}

export async function getAdminSedeById(id: number): Promise<AdminSede | null> {
  const db = await getDb();
  const res = await db.query(`SELECT * FROM sedi WHERE id = ?`, [id]);
  const rows = res.rows as SedeRow[];
  return rows.length > 0 ? rowToAdminSede(rows[0]) : null;
}

export async function getSedeByCode(code: string): Promise<Sede | null> {
  const db = await getDb();
  const res = await db.query(`SELECT * FROM sedi WHERE code = ?`, [code]);
  const rows = res.rows as SedeRow[];
  return rows.length > 0 ? rowToSede(rows[0]) : null;
}

export interface NewSedeInput {
  code: string;
  name: string;
  city: string;
  address?: string | null;
  wlcHost?: string | null;
  wlcPort?: number;
  wlcSshPort?: number;
  wlcUsername?: string;
  wlcSsid?: string;
  active?: boolean;
}

/**
 * Create a site.
 *
 * New sites start inactive unless told otherwise: their Key Vault secret does
 * not exist yet, so letting operators pick them straight away would only offer
 * a connection that cannot succeed.
 */
export async function createSede(input: NewSedeInput, actor: string): Promise<AdminSede> {
  const db = await getDb();
  const res = await db.query(
    `INSERT INTO sedi
       (code, name, city, address, wlc_host, wlc_port, wlc_ssh_port, wlc_username, wlc_ssid, active, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     RETURNING id`,
    [
      input.code,
      input.name,
      input.city,
      input.address ?? null,
      input.wlcHost ?? null,
      input.wlcPort ?? 443,
      input.wlcSshPort ?? 22,
      input.wlcUsername ?? 'admin_guest',
      input.wlcSsid ?? 'Dompe Guest',
      input.active ?? false,
      actor,
    ],
  );
  const id = Number((res.rows as Array<{ id: number }>)[0].id);
  return (await getAdminSedeById(id))!;
}

/**
 * Update a site.
 *
 * `code` is not patchable: it is what resolves the Key Vault secret, so
 * changing it would silently detach a site from its password.
 */
export async function updateSede(
  id: number,
  patch: Partial<Omit<NewSedeInput, 'code'>>,
  actor: string,
): Promise<AdminSede | null> {
  const db = await getDb();
  const map: Record<string, string> = {
    name: 'name',
    city: 'city',
    address: 'address',
    wlcHost: 'wlc_host',
    wlcPort: 'wlc_port',
    wlcSshPort: 'wlc_ssh_port',
    wlcUsername: 'wlc_username',
    wlcSsid: 'wlc_ssid',
    active: 'active',
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = map[k];
    if (!col || v === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(v);
  }
  if (sets.length === 0) return getAdminSedeById(id);

  sets.push('updated_by = ?');
  params.push(actor);
  sets.push('updated_at = NOW()');

  params.push(id);
  await db.query(`UPDATE sedi SET ${sets.join(', ')} WHERE id = ?`, params);
  return getAdminSedeById(id);
}

export async function setSedeActive(id: number, active: boolean, actor: string): Promise<AdminSede | null> {
  return updateSede(id, { active }, actor);
}

/** Record the outcome of a connectivity probe. Pure diagnostics. */
export async function recordWlcCheck(id: number, ok: boolean, error: string | null): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE sedi
        SET wlc_last_check_at = NOW(), wlc_last_check_ok = ?, wlc_last_check_error = ?
      WHERE id = ?`,
    [ok, error, id],
  );
}

export async function countGuestsBySede(id: number): Promise<number> {
  const db = await getDb();
  const res = await db.query(`SELECT COUNT(*)::int AS n FROM guests WHERE sede_id = ?`, [id]);
  return Number((res.rows as Array<{ n: number }>)[0]?.n ?? 0);
}

/**
 * Delete a site outright.
 *
 * Only safe while nothing references it: `guests.sede_id` carries no foreign
 * key, so a delete would leave guests pointing at an id that no longer exists,
 * and recreating the same code would hand that history to a different site.
 * The caller checks `countGuestsBySede` first; switching `active` off is the
 * normal way to retire a site.
 */
export async function deleteSede(id: number): Promise<boolean> {
  const db = await getDb();
  const res = await db.query(`DELETE FROM sedi WHERE id = ?`, [id]);
  return res.rowCount > 0;
}

/* --------------------------- WLC config (per-sede) --------------------------- */

/**
 * The WLC parameters for one site.
 *
 * There is deliberately no site-less variant. The old `getWlcConfig()` and
 * `updateWlcConfig()` fell back to "the first row", which is how an action on
 * one site could read — and write — another site's controller settings.
 *
 * `authenticated` is left false here: it describes an operator's session, and
 * the route fills it in from there. Background jobs and guest pushes branch on
 * `usable` instead.
 */
export async function getWlcConfigBySede(sedeId: number): Promise<WlcConfig | null> {
  const db = await getDb();
  const res = await db.query(`SELECT * FROM sedi WHERE id = ?`, [sedeId]);
  const rows = res.rows as SedeRow[];
  if (rows.length === 0) return null;

  const sede = rowToSede(rows[0]);
  const password = wlcPasswordForSede(sede.code);

  return {
    id: sede.id,
    host: sede.wlcHost ?? '',
    port: sede.wlcPort,
    sshPort: sede.wlcSshPort,
    username: sede.wlcUsername,
    password,
    wlanSsid: sede.wlcSsid,
    authenticated: false,
    usable: sede.active && !!sede.wlcHost && password.length > 0,
    sedeId: sede.id,
  };
}

/* --------------------------- SMS / Logs --------------------------- */
/* Email/SMTP config removed (§3): mail is sent only via Microsoft Graph
   (see services/email.ts + graphMail.ts); there is no email_config table. */

export async function getSmsConfig(): Promise<SmsConfig> {
  const db = await getDb();
  const res = await db.query(`SELECT * FROM sms_config WHERE id = 1`);
  const r = (res.rows as Array<Record<string, unknown>>)[0] ?? {};
  return {
    id: 1,
    gatewayType: (r.gateway_type as string | null) ?? 'textbelt',
    apiKey: (r.api_key as string | null) ?? null,
    senderId: (r.sender_id as string | null) ?? 'DompeGuest',
    webhookUrl: (r.webhook_url as string | null) ?? null,
  };
}

export async function updateSmsConfig(patch: Partial<SmsConfig>): Promise<SmsConfig> {
  const db = await getDb();
  const map: Record<string, string> = {
    gatewayType: 'gateway_type', apiKey: 'api_key',
    senderId: 'sender_id', webhookUrl: 'webhook_url',
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = map[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    params.push(v);
  }
  if (sets.length > 0) {
    await db.query(`UPDATE sms_config SET ${sets.join(', ')} WHERE id = 1`, params);
  }
  return getSmsConfig();
}

export async function listSyncLogs(limit = 100): Promise<SyncLog[]> {
  const db = await getDb();
  // Plain `timestamp DESC` (no `datetime()` wrapper) — same fix as
  // `listGuests` above; `timestamp` is stored as ISO-8601 via
  // `CURRENT_TIMESTAMP` so it sorts correctly in both SQLite and PostgreSQL.
  const res = await db.query(
    `SELECT * FROM sync_logs ORDER BY timestamp DESC LIMIT ?`,
    [limit],
  );
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    timestamp: String(r.timestamp),
    action: String(r.action),
    method: String(r.method),
    url: (r.url as string | null) ?? null,
    payload: (r.payload as string | null) ?? null,
    statusCode: r.status_code != null ? Number(r.status_code) : null,
  }));
}

export async function addSyncLog(entry: Omit<SyncLog, 'id' | 'timestamp'>): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO sync_logs (timestamp, action, method, url, payload, status_code) VALUES (CURRENT_TIMESTAMP, ?, ?, ?, ?, ?)`,
    [entry.action, entry.method, entry.url ?? null, entry.payload ?? null, entry.statusCode ?? null],
  );
}

export async function clearSyncLogs(): Promise<void> {
  const db = await getDb();
  await db.query(`DELETE FROM sync_logs`);
}
