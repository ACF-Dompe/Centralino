import { describe, it, expect, vi } from 'vitest';
import { formatRemaining, progressPercent } from '../utils/time.js';

const t = vi.fn((k: string) => {
  if (k === 'time.expired') return 'Scaduto';
  return k;
});

describe('formatRemaining', () => {
  it('formats full duration as hh:mm:ss', () => {
    const result = formatRemaining(7200, 0, t);
    expect(result).toBe('02:00:00');
  });

  it('formats partial elapsed as remaining time', () => {
    const result = formatRemaining(3600, 1800, t);
    expect(result).toBe('00:30:00');
  });

  it('adds days prefix when remaining > 24h', () => {
    const result = formatRemaining(90000, 0, t);
    expect(result).toBe('1g 01:00:00');
  });

  it('returns expired string when remaining <= 0', () => {
    const result = formatRemaining(3600, 3600, t);
    expect(result).toBe('Scaduto');
  });

  it('returns expired string when elapsed exceeds total', () => {
    const result = formatRemaining(3600, 4000, t);
    expect(result).toBe('Scaduto');
  });
});

describe('progressPercent', () => {
  it('returns 100% at start (full remaining)', () => {
    expect(progressPercent(3600, 0)).toBe(100);
  });

  it('returns 50% halfway through', () => {
    expect(progressPercent(3600, 1800)).toBe(50);
  });

  it('returns 0% when fully elapsed', () => {
    expect(progressPercent(3600, 3600)).toBe(0);
  });

  it('never goes below 0', () => {
    expect(progressPercent(3600, 4000)).toBe(0);
  });

  it('returns 0 for zero total', () => {
    expect(progressPercent(0, 0)).toBe(0);
  });
});
