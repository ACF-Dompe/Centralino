/**
 * Tests for the per-site connection state (src/services/wlcPresence.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { recordPresence, guestConnected, clearPresence } from '../services/wlcPresence.js';

const scan = (...tokens: string[]) => ({ readable: true, runTokens: new Set(tokens) });

describe('wlcPresence', () => {
  beforeEach(() => {
    clearPresence();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is unknown for a site that has never been read', () => {
    expect(guestConnected(1, 'g.mario123')).toBeNull();
    expect(guestConnected(null, 'g.mario123')).toBeNull();
  });

  it('answers from the last reading, case-insensitively', () => {
    recordPresence(1, scan('g.mario123'));
    expect(guestConnected(1, 'G.Mario123')).toBe(true);
    expect(guestConnected(1, 'g.anna456')).toBe(false);
    // Another site's table says nothing about this one.
    expect(guestConnected(2, 'g.mario123')).toBeNull();
  });

  it('forgets a site on an unreadable table or a failed sync', () => {
    recordPresence(1, scan('g.mario123'));
    recordPresence(1, { readable: false, runTokens: new Set() });
    expect(guestConnected(1, 'g.mario123')).toBeNull();

    recordPresence(1, scan('g.mario123'));
    recordPresence(1, null);
    expect(guestConnected(1, 'g.mario123')).toBeNull();
  });

  it('turns unknown once the reading is too old to describe now', () => {
    recordPresence(1, scan('g.mario123'));
    vi.advanceTimersByTime(90_001);
    expect(guestConnected(1, 'g.mario123')).toBeNull();
  });
});
