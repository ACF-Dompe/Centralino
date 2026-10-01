/**
 * Background services:
 *  - Real-time elapsed timer for active guests
 *  - Periodic sync with ALL authenticated WLC configs (one per sede)
 *  - Which guests are actually associated (services/wlcPresence.ts)
 *  - Auto-expire guests whose duration has elapsed
 */
import { getDb } from '../db/index.js';
import {
  listGuests,
  updateGuest,
  createGuest,
  addSyncLog,
  getWlcConfigBySede,
  listSedi,
} from '../repositories/index.js';
import { v4 as uuid } from 'uuid';
import {
  execSsh,
  parseUsernameList,
  getGuestUsers,
  extractGuestUsers,
  parseWirelessClients,
  type GuestUserInfo,
} from './wlcSsh.js';
import { recordPresence } from './wlcPresence.js';
import { broadcast } from './ws.js';
import { log } from '../logger.js';

const CLIENT_TABLE_COMMAND = 'show wireless client summary detail';
/** The client table has printed and the prompt is back (or the command was refused). */
const CLIENT_TABLE_DONE = /summary detail[\s\S]*\n[^\n]*[#>][ \t]*$/;

let timerInterval: NodeJS.Timeout | null = null;
let syncInterval: NodeJS.Timeout | null = null;
/** Sites whose controller has already been reported as not printing user names. */
const warnedNoClientTable = new Set<number>();

async function tickTimers(): Promise<void> {
  try {
    const db = await getDb();
    const guests = await listGuests();
    const now = Date.now();
    for (const g of guests) {
      if (g.status !== 'active' || !g.enabledAt) continue;
      const enabledMs = new Date(g.enabledAt).getTime();
      if (!Number.isFinite(enabledMs)) continue;
      const elapsed = Math.floor((now - enabledMs) / 1000);
      const total = g.durationMinutes * 60;
      if (elapsed >= total) {
        await updateGuest(g.id, { status: 'expired', elapsedSeconds: total });
        broadcast({ type: 'guest:expired', data: { id: g.id, name: g.name, username: g.username, sedeId: g.sedeId } });
      } else if (elapsed !== g.elapsedSeconds) {
        await db.query(`UPDATE guests SET elapsed_seconds = ? WHERE id = ?`, [elapsed, g.id]);
      }
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'tickTimers failed');
  }
}

async function syncSedeWlc(sedeId: number): Promise<void> {
  const cfg = await getWlcConfigBySede(sedeId);
  if (!cfg) return; // site deleted between listing and syncing

  // `usable` means the site is in service, has a host, and has a password in
  // the environment. This used to test `authenticated`, a column any operator
  // could flip from the header — and, because the write always landed on the
  // first row, flipping it for one site silently stopped the sync for another.
  if (!cfg.usable) {
    recordPresence(sedeId, null);
    return;
  }

  const result = await execSsh({
    host: cfg.host,
    port: cfg.sshPort,
    username: cfg.username,
    password: cfg.password,
    commands: [
      'terminal length 0',
      'show running-config | include ^username',
      'show running-config | section user-name',
    ],
    // Who is actually on the air. Optional: a release that refuses it must not
    // cost the import/deactivation pass below.
    optionalCommands: [CLIENT_TABLE_COMMAND],
    waitFor: { pattern: CLIENT_TABLE_DONE, timeoutMs: 4_000 },
  });

  if (!result.success) {
    recordPresence(sedeId, null);
    await addSyncLog({
      action: `sync: sede ${sedeId} failed`,
      method: 'SSH',
      url: `${cfg.host}:${cfg.sshPort}`,
      payload: null,
      statusCode: 502,
    });
    return;
  }

  // Parse ALL users from the WLC running-config.
  // 1. `username` entries (admin + g.testsecret1) — parsed with privilege level
  // 2. `user-name` entries (guest WebAuth users) — extracted from section config
  const allUsers = parseUsernameList(result.output);
  const legacyGuestUsers = getGuestUsers(allUsers);
  const guestUsersInfo = extractGuestUsers(result.output);

  // Combine guest users: from username entries (without privilege) + from user-name entries
  const guestUsersByUsername = new Map<string, GuestUserInfo>();
  for (const g of legacyGuestUsers) {
    guestUsersByUsername.set(g.username, {
      username: g.username,
      createdAt: null,
      durationMinutes: null,
    });
  }
  for (const gu of guestUsersInfo) {
    if (!guestUsersByUsername.has(gu.username)) {
      guestUsersByUsername.set(gu.username, gu);
    }
  }
  const guestUsers = [...guestUsersByUsername.values()];

  // Unknown rather than "nobody" when the table could not be read.
  const clients = result.optionalFailed ? null : parseWirelessClients(result.output);
  recordPresence(sedeId, clients);
  if (!clients?.readable && !warnedNoClientTable.has(sedeId)) {
    // Once per site, or the 30 s sync would flood the logs.
    warnedNoClientTable.add(sedeId);
    log.warn(
      { sedeId, command: CLIENT_TABLE_COMMAND, refused: result.optionalFailed === true },
      'WLC client table not readable: guest connection state will show as unknown',
    );
  }
  const managementCount = allUsers.length - legacyGuestUsers.length;
  const onController = new Set(allUsers.map((u) => u.username));
  // Also include user-name guest users in the controller set for deactivation checks
  for (const gu of guestUsersInfo) {
    onController.add(gu.username);
  }

  // Import guest users that are on the WLC but not yet in the local DB.
  const existing = await listGuests({ sedeId });
  const existingUsernames = new Set(existing.map((g) => g.username));

  for (const gu of guestUsers) {
    if (existingUsernames.has(gu.username)) continue;
    const enabledAt = gu.createdAt != null
      ? new Date(gu.createdAt * 1000).toISOString()
      : new Date().toISOString();
    const durationMinutes = gu.durationMinutes ?? 480;
    const newGuest = await createGuest({
      id: `g-${uuid().slice(0, 8)}`,
      name: gu.username,
      email: null, phone: null,
      company: 'Utente WLC',
      host: cfg.host,
      username: gu.username,
      password: null,
      durationMinutes,
      status: 'active',
      enabledAt,
      remarks: 'Importato dal WLC',
      sedeId,
    });
    existingUsernames.add(gu.username);
    broadcast({ type: 'guest:imported', data: { id: newGuest.id, name: newGuest.name, username: gu.username, sedeId } });
    await addSyncLog({
      action: `sync: import ${gu.username} (sede ${sedeId})`,
      method: 'SSH',
      url: `${cfg.host}:${cfg.sshPort}`,
      payload: null,
      statusCode: 201,
    });
    log.info({ username: gu.username, sedeId }, 'Guest imported from WLC via sync');
  }

  // Deactivate local guests that no longer exist on the WLC.
  for (const g of existing) {
    if (g.status === 'deactivated') continue;
    if (!onController.has(g.username) && g.status === 'active') {
      await updateGuest(g.id, { status: 'deactivated' });
      broadcast({ type: 'guest:deactivated', data: { id: g.id, name: g.name, username: g.username, sedeId: g.sedeId } });
      await addSyncLog({
        action: `sync: deactivate ${g.username} (sede ${sedeId})`,
        method: 'SSH',
        url: `${cfg.host}:${cfg.sshPort}`,
        payload: null,
        statusCode: 200,
      });
    }
  }

  broadcast({ type: 'sync:completed', data: { sedeId } });

  await addSyncLog({
    action: `sync: sede ${sedeId} ok`,
    method: 'SSH',
    url: `${cfg.host}:${cfg.sshPort}`,
    payload: `Found ${guestUsers.length} guest users (${managementCount} management) on controller`,
    statusCode: 200,
  });
}

async function syncWithAllWlc(): Promise<void> {
  try {
    // Only sites in service: a site switched off in the admin panel is one
    // nobody wants the background job reaching out to.
    const sedi = await listSedi({ activeOnly: true });
    for (const s of sedi) {
      await syncSedeWlc(s.id);
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'syncWithAllWlc failed');
  }
}

export function startBackgroundServices(): void {
  if (timerInterval) clearInterval(timerInterval);
  if (syncInterval) clearInterval(syncInterval);
  // Tick every 1s for the timer; sync every 30s
  timerInterval = setInterval(() => void tickTimers(), 1000);
  syncInterval = setInterval(() => void syncWithAllWlc(), 30_000);
  log.info('Background services started (timer 1s, sync 30s, per-sede)');
}

export function stopBackgroundServices(): void {
  if (timerInterval) clearInterval(timerInterval);
  if (syncInterval) clearInterval(syncInterval);
  timerInterval = null;
  syncInterval = null;
}
