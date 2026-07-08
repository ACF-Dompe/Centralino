/**
 * Tests for background services (src/services/timer.ts).
 *
 * Tests `tickTimers`, `syncWithAllWlc`, `startBackgroundServices`, and
 * `stopBackgroundServices` through the public API using fake timers and
 * mocked repository / DB / WLC dependencies.
 *
 * Note: Internal functions (tickTimers, syncSedeWlc, syncWithAllWlc) are
 * NOT exported — they are tested indirectly via the setInterval callbacks
 * started by startBackgroundServices().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Guest, Sede, WlcConfig } from '../types.js';

// ── Mock Database ─────────────────────────────────────────────────────────

const mockDb = {
  query: vi.fn(),
};

vi.mock('../db/index.js', () => ({
  getDb: vi.fn(() => mockDb),
}));

// ── Mock Repositories ──────────────────────────────────────────────────────

vi.mock('../repositories/index.js', () => ({
  listGuests: vi.fn(),
  updateGuest: vi.fn(),
  createGuest: vi.fn(),
  addSyncLog: vi.fn(),
  getWlcConfigBySede: vi.fn(),
  listSedi: vi.fn(),
}));

import {
  listGuests,
  updateGuest,
  createGuest,
  addSyncLog,
  getWlcConfigBySede,
  listSedi,
} from '../repositories/index.js';

// ── Mock WLC SSH ───────────────────────────────────────────────────────────

vi.mock('../services/wlcSsh.js', () => ({
  execSsh: vi.fn(),
  parseUsernameList: vi.fn(),
  getGuestUsers: vi.fn(),
  extractGuestUsers: vi.fn(),
}));

import { execSsh, parseUsernameList, getGuestUsers, extractGuestUsers } from '../services/wlcSsh.js';

// ── Logger suppression ─────────────────────────────────────────────────────

vi.mock('../logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Subject under test ─────────────────────────────────────────────────────

import { startBackgroundServices, stopBackgroundServices } from '../services/timer.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeGuest(overrides: Partial<Guest> = {}): Guest {
  return {
    id: 'g-test1234',
    name: 'Mario Rossi',
    email: 'ospite@example.com',
    phone: null,
    company: 'ACME Corp',
    host: 'Sponsor Test',
    username: 'g.marior123',
    password: null,
    durationMinutes: 10,
    elapsedSeconds: 0,
    status: 'active',
    createdAt: '2026-01-15T10:00:00.000Z',
    enabledAt: new Date(Date.now() - 5000).toISOString(),
    remarks: null,
    sedeId: 1,
    ...overrides,
  };
}

function makeSede(id: number): Sede {
  return {
    id,
    code: `S${id}`,
    name: `Sede ${id}`,
    city: 'Milano',
    address: 'Via Roma 1',
    wlcConfigId: id,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeWlcConfig(overrides: Partial<WlcConfig> = {}): WlcConfig {
  return {
    id: 1,
    host: '172.18.106.100',
    port: 443,
    sshPort: 22,
    username: 'admin_guest',
    password: 'secret',
    wlanSsid: 'Dompe Guest',
    authenticated: true,
    sedeId: 1,
    ...overrides,
  };
}

/**
 * Set a known BASE_TIME so that `elapsed` calculations are predictable:
 * `enabledAt` expressed relative to BASE_TIME produces the desired elapsed.
 */
const BASE_TIME = 1_000_000_000_000; // 2001-09-09T01:46:40.000Z

/**
 * Compute an enabledAt ISO string so that elapsed = targetElapsed seconds
 * when measured from the given `now` time.
 */
function enabledAtForElapsed(targetElapsed: number, now: number): string {
  return new Date(now - targetElapsed * 1000).toISOString();
}

// ── ────────────────────────────────────────────────────────────────────────

describe('startBackgroundServices / stopBackgroundServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    stopBackgroundServices();
    vi.useRealTimers();
  });

  // ── Service lifecycle ──────────────────────────────────────────────────

  describe('service lifecycle', () => {
    it('starts both timer and sync intervals', () => {
      startBackgroundServices();

      // 2 active intervals: timer (1s) + sync (30s)
      expect(vi.getTimerCount()).toBe(2);
    });

    it('stops both intervals and nothing fires after stop', async () => {
      startBackgroundServices();
      stopBackgroundServices();

      expect(vi.getTimerCount()).toBe(0);

      // Advance time significantly — nothing should fire
      vi.mocked(listGuests).mockResolvedValue([]);
      await vi.advanceTimersByTimeAsync(35000);
      expect(vi.mocked(listGuests)).not.toHaveBeenCalled();
    });

    it('replaces old intervals when started twice', async () => {
      // Start once — let it tick
      startBackgroundServices();
      await vi.advanceTimersByTimeAsync(1000);

      // Start again — clears old intervals, creates new ones
      startBackgroundServices();
      vi.clearAllMocks(); // reset call counts from previous tick

      await vi.advanceTimersByTimeAsync(1000);

      // New interval should fire
      expect(vi.mocked(listGuests)).toHaveBeenCalled();
    });
  });

  // ── tickTimers ─────────────────────────────────────────────────────────

  describe('tickTimers (via 1s interval)', () => {
    beforeEach(() => {
      vi.mocked(updateGuest).mockResolvedValue(null);
    });

    it('updates elapsed_seconds for active guests each tick', async () => {
      const guest = makeGuest({
        enabledAt: new Date(BASE_TIME - 5000).toISOString(),
        elapsedSeconds: 0,
      });
      vi.mocked(listGuests).mockResolvedValue([guest]);

      startBackgroundServices();

      // Advance 1 tick — now=BASE_TIME+1000, enabledMs=BASE_TIME-5000, elapsed=6
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockDb.query).toHaveBeenCalledWith(
        'UPDATE guests SET elapsed_seconds = ? WHERE id = ?',
        [6, 'g-test1234'],
      );
    });

    it('does NOT update elapsed_seconds if unchanged from previous tick', async () => {
      // at t=1000, elapsed = ((BASE_TIME+1000) - (BASE_TIME-5000)) / 1000 = 6
      // we set elapsedSeconds=6 so 6 !== 6 is false → no update
      const guest = makeGuest({
        enabledAt: new Date(BASE_TIME - 5000).toISOString(),
        elapsedSeconds: 6,
      });
      vi.mocked(listGuests).mockResolvedValue([guest]);

      startBackgroundServices();
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockDb.query).not.toHaveBeenCalled();
      expect(vi.mocked(updateGuest)).not.toHaveBeenCalled();
    });

    it('marks guest as expired when elapsed >= duration', async () => {
      const guest = makeGuest({
        enabledAt: new Date(BASE_TIME - 11 * 60 * 1000).toISOString(),
        durationMinutes: 10,
      });
      vi.mocked(listGuests).mockResolvedValue([guest]);

      startBackgroundServices();
      await vi.advanceTimersByTimeAsync(1000);

      // elapsed = 661, total = 600 → expired
      expect(vi.mocked(updateGuest)).toHaveBeenCalledWith('g-test1234', {
        status: 'expired',
        elapsedSeconds: 600, // 10 * 60
      });
    });

    it('skips non-active guests', async () => {
      vi.mocked(listGuests).mockResolvedValue([
        makeGuest({ status: 'expired' }),
        makeGuest({ status: 'pending' }),
        makeGuest({ status: 'deactivated' }),
      ]);

      startBackgroundServices();
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockDb.query).not.toHaveBeenCalled();
      expect(vi.mocked(updateGuest)).not.toHaveBeenCalled();
    });

    it('skips guests without enabledAt', async () => {
      vi.mocked(listGuests).mockResolvedValue([
        makeGuest({ enabledAt: null }),
      ]);

      startBackgroundServices();
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockDb.query).not.toHaveBeenCalled();
      expect(vi.mocked(updateGuest)).not.toHaveBeenCalled();
    });

    it('skips guests with invalid enabledAt date', async () => {
      vi.mocked(listGuests).mockResolvedValue([
        makeGuest({ enabledAt: 'not-a-date' }),
      ]);

      startBackgroundServices();
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockDb.query).not.toHaveBeenCalled();
      expect(vi.mocked(updateGuest)).not.toHaveBeenCalled();
    });

    it('handles listGuests error gracefully (caught and logged)', async () => {
      vi.mocked(listGuests).mockRejectedValue(new Error('DB connection lost'));

      startBackgroundServices();
      await vi.advanceTimersByTimeAsync(1000);

      // No crash — error is caught and logged internally
      expect(mockDb.query).not.toHaveBeenCalled();
    });
  });

  // ── syncWithAllWlc ────────────────────────────────────────────────────

  describe('syncWithAllWlc (via 30s interval)', () => {
    beforeEach(() => {
      vi.mocked(createGuest).mockResolvedValue(makeGuest());
      vi.mocked(updateGuest).mockResolvedValue(null);
      vi.mocked(addSyncLog).mockResolvedValue();
    });

    it('syncs each sede and imports new guest users from the WLC', async () => {
      vi.mocked(listSedi).mockResolvedValue([makeSede(1)]);
      vi.mocked(getWlcConfigBySede).mockResolvedValue(makeWlcConfig());
      vi.mocked(execSsh).mockResolvedValue({
        success: true,
        output: 'username admin privilege 15\nusername g.mario1\n',
      });
      vi.mocked(parseUsernameList).mockReturnValue([
        { username: 'admin', privilege: 15 },
        { username: 'g.mario1', privilege: null },
      ]);
      vi.mocked(getGuestUsers).mockReturnValue([{ username: 'g.mario1' }]);
      vi.mocked(extractGuestUsers).mockReturnValue([
        { username: 'g.mario1', createdAt: 1700000000, durationMinutes: 480 },
      ]);
      vi.mocked(listGuests).mockResolvedValue([]); // no existing guests in DB

      startBackgroundServices();
      await vi.advanceTimersByTimeAsync(30000);

      // SSH commands sent
      expect(vi.mocked(execSsh)).toHaveBeenCalledWith(
        expect.objectContaining({
          host: '172.18.106.100',
          username: 'admin_guest',
          commands: expect.arrayContaining([
            'terminal length 0',
            'show running-config | include ^username',
            'show running-config | section user-name',
          ]),
        }),
      );

      // New guest created in local DB
      expect(vi.mocked(createGuest)).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'g.mario1',
          sedeId: 1,
          status: 'active',
        }),
      );

      // Sync log for import
      expect(vi.mocked(addSyncLog)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringContaining('import g.mario1'),
          statusCode: 201,
        }),
      );

      // Sync log for overall success
      expect(vi.mocked(addSyncLog)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sync: sede 1 ok',
          statusCode: 200,
        }),
      );
    });

    it('deactivates local guests no longer present on the WLC', async () => {
      const existingGuest = makeGuest({
        id: 'g-olduser',
        username: 'g.olduser',
        status: 'active',
      });

      vi.mocked(listSedi).mockResolvedValue([makeSede(1)]);
      vi.mocked(getWlcConfigBySede).mockResolvedValue(makeWlcConfig());
      vi.mocked(execSsh).mockResolvedValue({
        success: true,
        output: 'username admin privilege 15\n',
      });
      vi.mocked(parseUsernameList).mockReturnValue([
        { username: 'admin', privilege: 15 },
      ]);
      vi.mocked(getGuestUsers).mockReturnValue([]);
      vi.mocked(extractGuestUsers).mockReturnValue([]);
      vi.mocked(listGuests).mockResolvedValue([existingGuest]);

      startBackgroundServices();
      await vi.advanceTimersByTimeAsync(30000);

      // g.olduser is on the WLC's guest-user list → should be deactivated
      expect(vi.mocked(updateGuest)).toHaveBeenCalledWith('g-olduser', {
        status: 'deactivated',
      });

      // Sync log for deactivation
      expect(vi.mocked(addSyncLog)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringContaining('deactivate g.olduser'),
          statusCode: 200,
        }),
      );
    });

    it('skips unauthenticated (sandbox) WLCs', async () => {
      vi.mocked(listSedi).mockResolvedValue([makeSede(1)]);
      vi.mocked(getWlcConfigBySede).mockResolvedValue(
        makeWlcConfig({ authenticated: false }),
      );

      startBackgroundServices();
      await vi.advanceTimersByTimeAsync(30000);

      // No SSH for unauthenticated WLC
      expect(vi.mocked(execSsh)).not.toHaveBeenCalled();
    });

    it('logs sync failure when SSH connection fails', async () => {
      vi.mocked(listSedi).mockResolvedValue([makeSede(1)]);
      vi.mocked(getWlcConfigBySede).mockResolvedValue(makeWlcConfig());
      vi.mocked(execSsh).mockResolvedValue({
        success: false,
        output: '',
        error: 'SSH timeout',
      });

      startBackgroundServices();
      await vi.advanceTimersByTimeAsync(30000);

      // Sync log with error status
      expect(vi.mocked(addSyncLog)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sync: sede 1 failed',
          statusCode: 502,
        }),
      );
    });

    it('syncs multiple sedi in sequence', async () => {
      vi.mocked(listSedi).mockResolvedValue([makeSede(1), makeSede(2)]);
      vi.mocked(getWlcConfigBySede).mockResolvedValue(makeWlcConfig());
      vi.mocked(execSsh).mockResolvedValue({ success: true, output: '' });
      vi.mocked(parseUsernameList).mockReturnValue([]);
      vi.mocked(getGuestUsers).mockReturnValue([]);
      vi.mocked(extractGuestUsers).mockReturnValue([]);
      vi.mocked(listGuests).mockResolvedValue([]);

      startBackgroundServices();
      await vi.advanceTimersByTimeAsync(30000);

      // Both sedi synced
      expect(vi.mocked(execSsh)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(addSyncLog)).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'sync: sede 1 ok' }),
      );
      expect(vi.mocked(addSyncLog)).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'sync: sede 2 ok' }),
      );
    });

    it('handles listSedi error gracefully', async () => {
      vi.mocked(listSedi).mockRejectedValue(new Error('DB error'));

      startBackgroundServices();
      await vi.advanceTimersByTimeAsync(30000);

      // No crash — error caught and logged
      expect(vi.mocked(execSsh)).not.toHaveBeenCalled();
    });
  });
});
