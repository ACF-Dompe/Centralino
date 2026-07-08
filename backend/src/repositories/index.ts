/**
 * Repository layer — one place to translate between DB rows and domain types.
 */
import { getDb } from '../db/index.js';
import type { Guest, WlcConfig, EmailConfig, SmsConfig, SyncLog, GuestStatus, Sede } from '../types.js';

interface GuestRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  host: string;
  username: string;
  password: string | null;
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
    password: r.password, // null when not stored (post-refactor)
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
       (id, name, email, phone, company, host, username, password, duration_minutes, elapsed_seconds, status, created_at, enabled_at, remarks, sede_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, ?, ?, ?)`,
    [
      g.id,
      g.name,
      g.email,
      g.phone,
      g.company ?? 'Ospite Individuale',
      g.host,
      g.username,
      g.password ?? null,
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
    password: 'password',
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

/* --------------------------- Sedi --------------------------- */

interface SedeRow {
  id: number;
  code: string;
  name: string;
  city: string;
  address: string | null;
  wlc_config_id: number | null;
  created_at: string;
}

function rowToSede(r: SedeRow): Sede {
  return {
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    city: String(r.city),
    address: (r.address as string | null) ?? null,
    wlcConfigId: r.wlc_config_id != null ? Number(r.wlc_config_id) : null,
    createdAt: String(r.created_at),
  };
}

export async function listSedi(): Promise<Sede[]> {
  const db = await getDb();
  const res = await db.query(`SELECT * FROM sedi ORDER BY id ASC`);
  return (res.rows as SedeRow[]).map(rowToSede);
}

export async function getSedeById(id: number): Promise<Sede | null> {
  const db = await getDb();
  const res = await db.query(`SELECT * FROM sedi WHERE id = ?`, [id]);
  const rows = res.rows as SedeRow[];
  return rows.length > 0 ? rowToSede(rows[0]) : null;
}

export async function getSedeByCode(code: string): Promise<Sede | null> {
  const db = await getDb();
  const res = await db.query(`SELECT * FROM sedi WHERE code = ?`, [code]);
  const rows = res.rows as SedeRow[];
  return rows.length > 0 ? rowToSede(rows[0]) : null;
}

/* --------------------------- WLC config (per-sede) --------------------------- */

interface WlcRow {
  id: number;
  host: string;
  port: number;
  ssh_port: number;
  username: string;
  password: string;
  wlan_ssid: string;
  authenticated: number | boolean;
  sede_id: number | null;
}

function rowToWlc(r: WlcRow): WlcConfig {
  return {
    id: Number(r.id),
    host: String(r.host),
    port: Number(r.port),
    sshPort: Number(r.ssh_port),
    username: String(r.username),
    password: String(r.password),
    wlanSsid: String(r.wlan_ssid),
    authenticated: Boolean(r.authenticated),
    sedeId: r.sede_id != null ? Number(r.sede_id) : null,
  };
}

/**
 * Pick the WLC config for a specific sede. Falls back to the legacy
 * singleton (id=1) if no sede_id is set, for backward compatibility.
 */
export async function getWlcConfigBySede(sedeId: number | null): Promise<WlcConfig> {
  const db = await getDb();
  let res;
  if (sedeId != null) {
    res = await db.query(
      `SELECT * FROM wlc_config WHERE sede_id = ? OR id = (SELECT wlc_config_id FROM sedi WHERE id = ?) ORDER BY (sede_id = ?) DESC LIMIT 1`,
      [sedeId, sedeId, sedeId],
    );
    if (res.rows.length === 0) {
      res = await db.query(`SELECT * FROM wlc_config WHERE sede_id = ? LIMIT 1`, [sedeId]);
    }
  } else {
    res = await db.query(`SELECT * FROM wlc_config ORDER BY id ASC LIMIT 1`);
  }
  const r = (res.rows as WlcRow[])[0];
  if (!r) {
    return {
      id: 0, host: '172.18.106.100', port: 443, sshPort: 22,
      username: 'admin_guest', password: '', wlanSsid: 'Dompe Guest',
      authenticated: false, sedeId: null,
    };
  }
  return rowToWlc(r);
}

/**
 * Backward-compat: returns the first/legacy WLC config.
 * New code should use {@link getWlcConfigBySede}.
 */
export async function getWlcConfig(): Promise<WlcConfig> {
  return getWlcConfigBySede(null);
}

export async function updateWlcConfigBySede(sedeId: number, patch: Partial<WlcConfig>): Promise<WlcConfig | null> {
  const db = await getDb();
  const map: Record<string, string> = {
    host: 'host',
    port: 'port',
    sshPort: 'ssh_port',
    username: 'username',
    password: 'password',
    wlanSsid: 'wlan_ssid',
    authenticated: 'authenticated',
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
    await db.query(
      `UPDATE wlc_config SET ${sets.join(', ')}
       WHERE sede_id = ? OR id = (SELECT wlc_config_id FROM sedi WHERE id = ?)`,
      [...params, sedeId, sedeId],
    );
  }
  return getWlcConfigBySede(sedeId);
}

/**
 * Backward-compat: updates the first/legacy WLC config.
 */
export async function updateWlcConfig(patch: Partial<WlcConfig>): Promise<WlcConfig> {
  const db = await getDb();
  const map: Record<string, string> = {
    host: 'host',
    port: 'port',
    sshPort: 'ssh_port',
    username: 'username',
    password: 'password',
    wlanSsid: 'wlan_ssid',
    authenticated: 'authenticated',
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
    await db.query(`UPDATE wlc_config SET ${sets.join(', ')} WHERE id = (SELECT id FROM wlc_config ORDER BY id ASC LIMIT 1)`, params);
  }
  return getWlcConfig();
}

/* --------------------------- Email / SMS / Logs (unchanged) --------------------------- */

export async function getEmailConfig(): Promise<EmailConfig> {
  const db = await getDb();
  const res = await db.query(`SELECT * FROM email_config WHERE id = 1`);
  const r = (res.rows as Array<Record<string, unknown>>)[0] ?? {};
  return {
    id: 1,
    smtpHost: (r.smtp_host as string | null) ?? null,
    smtpPort: Number(r.smtp_port ?? 587),
    sender: (r.sender as string | null) ?? null,
    encryption: (r.encryption as string | null) ?? 'tls',
    requireAuth: Boolean(r.require_auth),
    username: (r.username as string | null) ?? null,
    password: (r.password as string | null) ?? null,
  };
}

export async function updateEmailConfig(patch: Partial<EmailConfig>): Promise<EmailConfig> {
  const db = await getDb();
  const map: Record<string, string> = {
    smtpHost: 'smtp_host', smtpPort: 'smtp_port', sender: 'sender',
    encryption: 'encryption', requireAuth: 'require_auth',
    username: 'username', password: 'password',
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
    await db.query(`UPDATE email_config SET ${sets.join(', ')} WHERE id = 1`, params);
  }
  return getEmailConfig();
}

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
