/**
 * Background services:
 *  - Real-time elapsed timer for active guests
 *  - Periodic sync with ALL authenticated WLC configs (one per sede)
 *  - Auto-expire guests whose duration has elapsed
 */
import { getDb } from '../db/index.js';
import { listGuests, updateGuest, createGuest, addSyncLog, getWlcConfigBySede, listSedi, } from '../repositories/index.js';
import { v4 as uuid } from 'uuid';
import { execSsh, parseUsernameList, getGuestUsers, extractGuestUsers } from './wlcSsh.js';
import { log } from '../logger.js';
let timerInterval = null;
let syncInterval = null;
async function tickTimers() {
    try {
        const db = await getDb();
        const guests = await listGuests();
        const now = Date.now();
        for (const g of guests) {
            if (g.status !== 'active' || !g.enabledAt)
                continue;
            const enabledMs = new Date(g.enabledAt).getTime();
            if (!Number.isFinite(enabledMs))
                continue;
            const elapsed = Math.floor((now - enabledMs) / 1000);
            const total = g.durationMinutes * 60;
            if (elapsed >= total) {
                await updateGuest(g.id, { status: 'expired', elapsedSeconds: total });
            }
            else if (elapsed !== g.elapsedSeconds) {
                await db.query(`UPDATE guests SET elapsed_seconds = ? WHERE id = ?`, [elapsed, g.id]);
            }
        }
    }
    catch (err) {
        log.warn({ err: err.message }, 'tickTimers failed');
    }
}
async function syncSedeWlc(sedeId) {
    const cfg = await getWlcConfigBySede(sedeId);
    if (!cfg.authenticated)
        return; // skip when in sandbox mode for this sede
    const result = await execSsh({
        host: cfg.host,
        port: cfg.sshPort,
        username: cfg.username,
        password: cfg.password,
        commands: [
            'terminal length 0',
            'show running-config | include ^username',
            'show running-config | section user-name',
            'exit',
        ],
    });
    if (!result.success) {
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
    const guestUsersByUsername = new Map();
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
        if (existingUsernames.has(gu.username))
            continue;
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
        if (g.status === 'deactivated')
            continue;
        if (!onController.has(g.username) && g.status === 'active') {
            await updateGuest(g.id, { status: 'deactivated' });
            await addSyncLog({
                action: `sync: deactivate ${g.username} (sede ${sedeId})`,
                method: 'SSH',
                url: `${cfg.host}:${cfg.sshPort}`,
                payload: null,
                statusCode: 200,
            });
        }
    }
    await addSyncLog({
        action: `sync: sede ${sedeId} ok`,
        method: 'SSH',
        url: `${cfg.host}:${cfg.sshPort}`,
        payload: `Found ${guestUsers.length} guest users (${managementCount} management) on controller`,
        statusCode: 200,
    });
}
async function syncWithAllWlc() {
    try {
        const sedi = await listSedi();
        for (const s of sedi) {
            await syncSedeWlc(s.id);
        }
    }
    catch (err) {
        log.warn({ err: err.message }, 'syncWithAllWlc failed');
    }
}
export function startBackgroundServices() {
    if (timerInterval)
        clearInterval(timerInterval);
    if (syncInterval)
        clearInterval(syncInterval);
    // Tick every 1s for the timer; sync every 30s
    timerInterval = setInterval(() => void tickTimers(), 1000);
    syncInterval = setInterval(() => void syncWithAllWlc(), 30_000);
    log.info('Background services started (timer 1s, sync 30s, per-sede)');
}
export function stopBackgroundServices() {
    if (timerInterval)
        clearInterval(timerInterval);
    if (syncInterval)
        clearInterval(syncInterval);
    timerInterval = null;
    syncInterval = null;
}
//# sourceMappingURL=timer.js.map