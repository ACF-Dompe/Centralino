/**
 * Tests for guest-account provisioning on the WLC (src/services/wlcGuest.ts).
 *
 * execSsh is mocked; the parsers (extractGuestUsers, minutesToLifetime) are the
 * real ones, because the read-back is only as good as what they make of the
 * controller's output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/wlcSsh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/wlcSsh.js')>();
  return { ...actual, execSsh: vi.fn() };
});

vi.mock('../logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { execSsh } from '../services/wlcSsh.js';
import {
  guestAccountCommands,
  checkGuestAccount,
  redactTranscript,
  provisionGuestAccount,
  provisionLogPayload,
} from '../services/wlcGuest.js';

const NOW = 1_790_000_000; // seconds

/** A running-config block as `show running-config | section user-name` prints it. */
function block(username: string, createdAt: number, lifetime: string): string {
  return [
    `>>> show running-config | section user-name ${username}`,
    `WLC#show running-config | section user-name ${username}`,
    `user-name ${username}`,
    ` creation-time ${createdAt}`,
    ' description Guest-User',
    ' password 0 Xk7mPq2RtW9s',
    ` type network-user description Guest-User guest-user lifetime ${lifetime}`,
    'WLC#',
  ].join('\r\n');
}

const FOUR_HOURS = 'year 0 month 0 day 0 hour 4 minute 0 second 0';
const target = { host: '10.0.0.1', port: 22, username: 'admin_guest', password: 'wlc-admin-secret' };

// ── guestAccountCommands ───────────────────────────────────────────────────

describe('guestAccountCommands', () => {
  it('sets the lifetime before the password, then reads the account back', () => {
    const cmds = guestAccountCommands({ username: 'g.mario123', password: 'Rf6tYb9cMn2E', durationMinutes: 240 });
    expect(cmds).toEqual([
      'terminal length 0',
      'configure terminal',
      'user-name g.mario123',
      `type network-user description Guest-User guest-user lifetime ${FOUR_HOURS}`,
      'password 0 Rf6tYb9cMn2E',
      'do write memory',
      'end',
      'show running-config | section user-name g.mario123',
    ]);
  });

  it('deletes the account first when asked to restart its lifetime', () => {
    const cmds = guestAccountCommands({ username: 'g.mario123', password: 'p', durationMinutes: 240, replace: true });
    expect(cmds.indexOf('no user-name g.mario123')).toBe(cmds.indexOf('user-name g.mario123') - 1);
  });

  it('carries no exit of its own: execSsh closes the session', () => {
    const cmds = guestAccountCommands({ username: 'g.a', password: 'p', durationMinutes: 30 });
    expect(cmds).not.toContain('exit');
  });
});

// ── checkGuestAccount ──────────────────────────────────────────────────────

describe('checkGuestAccount', () => {
  it('finds nothing wrong with a fresh account', () => {
    expect(checkGuestAccount(block('g.mario123', NOW + 3, FOUR_HOURS), 'g.mario123', 240, NOW, NOW + 5)).toEqual([]);
  });

  it('reports an account the controller does not have', () => {
    const issues = checkGuestAccount('>>> show running-config | section user-name g.mario123\r\nWLC#', 'g.mario123', 240, NOW, NOW);
    expect(issues).toEqual([expect.stringContaining('non trovato')]);
  });

  // execSsh's ">>> cmd" marker pushes the controller's echo of `user-name g.x`
  // to the start of a line, where it looks like the block header. Found by
  // running the sequence against a simulated shell.
  it('does not take the echo of the config commands for the account', () => {
    const output = [
      '>>> user-name g.x',
      'user-name g.x',
      'WLC(config-user-name)#',
      `>>> type network-user description Guest-User guest-user lifetime ${FOUR_HOURS}`,
      `type network-user description Guest-User guest-user lifetime ${FOUR_HOURS}`,
      'WLC(config-user-name)#',
      '>>> show running-config | section user-name g.x',
      'WLC#show running-config | section user-name g.x',
      'WLC#',
    ].join('\r\n');
    expect(checkGuestAccount(output, 'g.x', 240, NOW, NOW)).toEqual([expect.stringContaining('non trovato')]);
  });

  it('reads the block that follows the read-back, not the echo before it', () => {
    const output = [
      '>>> user-name g.mario123',
      'user-name g.mario123',
      `>>> type network-user description Guest-User guest-user lifetime ${FOUR_HOURS}`,
      `type network-user description Guest-User guest-user lifetime ${FOUR_HOURS}`,
      block('g.mario123', NOW, FOUR_HOURS),
    ].join('\r\n');
    expect(checkGuestAccount(output, 'g.mario123', 240, NOW, NOW)).toEqual([]);
  });

  it('reports an account left without a guest lifetime', () => {
    const output = [
      '>>> show running-config | section user-name g.mario123',
      'user-name g.mario123', ' creation-time 1', ' password 0 x', 'WLC#',
    ].join('\r\n');
    expect(checkGuestAccount(output, 'g.mario123', 240, NOW, NOW)).toEqual([
      expect.stringContaining('senza "type network-user'),
    ]);
  });

  it('reports a lifetime other than the one asked for', () => {
    const issues = checkGuestAccount(block('g.mario123', NOW, 'year 0 month 0 day 0 hour 1 minute 0 second 0'), 'g.mario123', 240, NOW, NOW);
    expect(issues).toEqual([expect.stringContaining('60 min invece di 240')]);
  });

  // The symptom that started this: an account written over an old one keeps
  // the old creation-time, and the controller answers "expired".
  it('reports a stale creation-time and the account being already expired', () => {
    const issues = checkGuestAccount(block('g.mario123', NOW - 2 * 86_400, FOUR_HOURS), 'g.mario123', 240, NOW, NOW);
    expect(issues).toEqual([
      expect.stringContaining('indietro di 2880 min'),
      expect.stringContaining('già scaduto'),
    ]);
  });

  it('reports a controller clock running ahead', () => {
    const issues = checkGuestAccount(block('g.mario123', NOW + 7200, FOUR_HOURS), 'g.mario123', 240, NOW, NOW);
    expect(issues).toEqual([expect.stringContaining('avanti di 120 min')]);
  });
});

// ── redactTranscript ───────────────────────────────────────────────────────

describe('redactTranscript', () => {
  it('masks password lines and every known secret', () => {
    const out = redactTranscript(
      '>>> password 0 Hq4nWz8vKp3T\r\n password 0 Hq4nWz8vKp3T\r\nsomething Hq4nWz8vKp3T wlc-admin-secret',
      ['Hq4nWz8vKp3T', 'wlc-admin-secret'],
    );
    expect(out).not.toContain('Hq4nWz8vKp3T');
    expect(out).not.toContain('wlc-admin-secret');
    expect(out).toContain('password 0 ***');
  });
});

// ── provisionGuestAccount ──────────────────────────────────────────────────

describe('provisionGuestAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('runs the sequence, waits for the read-back, and reports a clean account', async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.mocked(execSsh).mockResolvedValue({ success: true, output: block('g.mario123', now, FOUR_HOURS) });

    const r = await provisionGuestAccount(target, { username: 'g.mario123', password: 'Xk7mPq2RtW9s', durationMinutes: 240 });

    expect(r).toMatchObject({ ok: true, issues: [] });
    const input = vi.mocked(execSsh).mock.calls[0][0];
    expect(input.commands).toEqual(guestAccountCommands({ username: 'g.mario123', password: 'Xk7mPq2RtW9s', durationMinutes: 240 }));
    expect(input.waitFor?.pattern.test(block('g.mario123', now, FOUR_HOURS))).toBe(true);
    expect(provisionLogPayload(r)).toBeNull();
  });

  it('never puts a password in the transcript', async () => {
    vi.mocked(execSsh).mockResolvedValue({ success: true, output: block('g.mario123', 1, FOUR_HOURS) });

    const r = await provisionGuestAccount(target, { username: 'g.mario123', password: 'Xk7mPq2RtW9s', durationMinutes: 240 });

    expect(r.issues.length).toBeGreaterThan(0);
    expect(provisionLogPayload(r)).not.toContain('Xk7mPq2RtW9s');
  });

  it('retries without the delete when the controller refuses it', async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.mocked(execSsh)
      .mockResolvedValueOnce({ success: false, output: '', error: 'Comando respinto: % Error', errorPattern: '% Error' })
      .mockResolvedValueOnce({ success: true, output: block('g.mario123', now, FOUR_HOURS) });

    const r = await provisionGuestAccount(target, { username: 'g.mario123', password: 'p', durationMinutes: 240, replace: true });

    expect(r.ok).toBe(true);
    expect(vi.mocked(execSsh)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execSsh).mock.calls[0][0].commands).toContain('no user-name g.mario123');
    expect(vi.mocked(execSsh).mock.calls[1][0].commands).not.toContain('no user-name g.mario123');
  });

  it('does not retry a connection failure', async () => {
    vi.mocked(execSsh).mockResolvedValue({ success: false, output: '', error: 'SSH error: ECONNREFUSED' });

    const r = await provisionGuestAccount(target, { username: 'g.a', password: 'p', durationMinutes: 30, replace: true });

    expect(r).toMatchObject({ ok: false, error: 'SSH error: ECONNREFUSED' });
    expect(vi.mocked(execSsh)).toHaveBeenCalledOnce();
  });

  it('never throws', async () => {
    vi.mocked(execSsh).mockRejectedValue(new Error('boom'));

    const r = await provisionGuestAccount(target, { username: 'g.a', password: 'p', durationMinutes: 30 });

    expect(r).toMatchObject({ ok: false, error: 'boom' });
  });
});
