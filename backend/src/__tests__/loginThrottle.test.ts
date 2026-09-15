/**
 * Tests for the per-IP break-glass login throttle (utils/loginThrottle.ts).
 * Time is faked so the sliding window can be exercised without waiting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLoginThrottle } from '../utils/loginThrottle.js';

const WINDOW_MS = 15 * 60_000;

describe('createLoginThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows attempts up to the limit', () => {
    const throttle = createLoginThrottle(3, WINDOW_MS);
    for (let i = 0; i < 3; i += 1) {
      expect(throttle.check('10.0.0.1')).toBe(true);
      throttle.recordFailure('10.0.0.1');
    }
    expect(throttle.check('10.0.0.1')).toBe(false);
  });

  it('tracks each source IP separately', () => {
    const throttle = createLoginThrottle(2, WINDOW_MS);
    throttle.recordFailure('10.0.0.1');
    throttle.recordFailure('10.0.0.1');
    expect(throttle.check('10.0.0.1')).toBe(false);
    expect(throttle.check('10.0.0.2')).toBe(true);
  });

  it('lets attempts age out of the window', () => {
    const throttle = createLoginThrottle(2, WINDOW_MS);
    throttle.recordFailure('10.0.0.1');
    throttle.recordFailure('10.0.0.1');
    expect(throttle.check('10.0.0.1')).toBe(false);

    vi.advanceTimersByTime(WINDOW_MS - 1);
    expect(throttle.check('10.0.0.1')).toBe(false);

    vi.advanceTimersByTime(2);
    expect(throttle.check('10.0.0.1')).toBe(true);
  });

  it('slides rather than resetting wholesale', () => {
    const throttle = createLoginThrottle(2, WINDOW_MS);
    throttle.recordFailure('10.0.0.1');
    vi.advanceTimersByTime(WINDOW_MS / 2);
    throttle.recordFailure('10.0.0.1');
    expect(throttle.check('10.0.0.1')).toBe(false);

    // Only the first failure has aged out — one slot is free again.
    vi.advanceTimersByTime(WINDOW_MS / 2 + 1);
    expect(throttle.check('10.0.0.1')).toBe(true);
    throttle.recordFailure('10.0.0.1');
    expect(throttle.check('10.0.0.1')).toBe(false);
  });

  it('clears the counter on reset (successful login)', () => {
    const throttle = createLoginThrottle(2, WINDOW_MS);
    throttle.recordFailure('10.0.0.1');
    throttle.recordFailure('10.0.0.1');
    expect(throttle.check('10.0.0.1')).toBe(false);
    throttle.reset('10.0.0.1');
    expect(throttle.check('10.0.0.1')).toBe(true);
  });

  it('refuses a request with no resolvable source IP', () => {
    const throttle = createLoginThrottle(5, WINDOW_MS);
    expect(throttle.check(undefined)).toBe(false);
    // These must not throw, and must not create a shared unlimited bucket.
    expect(() => throttle.recordFailure(undefined)).not.toThrow();
    expect(() => throttle.reset(undefined)).not.toThrow();
  });

  it('does not grow unbounded as IPs age out', () => {
    const throttle = createLoginThrottle(1, WINDOW_MS);
    for (let i = 0; i < 100; i += 1) {
      throttle.recordFailure(`10.0.0.${i}`);
    }
    expect(throttle.check('10.0.0.5')).toBe(false);

    // Past the window, one further failure sweeps the aged entries.
    vi.advanceTimersByTime(WINDOW_MS + 1);
    throttle.recordFailure('192.168.0.1');
    expect(throttle.check('10.0.0.5')).toBe(true);
  });
});
