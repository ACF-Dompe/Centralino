/**
 * Tests for the break-glass CIDR allowlist (utils/ipAllowlist.ts).
 *
 * The fail-closed behaviour is the point worth guarding: a non-empty but
 * entirely malformed allowlist must deny everything rather than quietly
 * behaving like "no restriction configured".
 */
import { describe, it, expect, vi } from 'vitest';

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../logger.js', () => ({ log: mockLog }));

import { createIpAllowlist } from '../utils/ipAllowlist.js';

describe('createIpAllowlist', () => {
  it('is unrestricted when empty', () => {
    for (const raw of ['', '   ', ',,', ' , ']) {
      const allowlist = createIpAllowlist(raw);
      expect(allowlist.unrestricted).toBe(true);
      expect(allowlist.allows('8.8.8.8')).toBe(true);
    }
  });

  it('matches an IPv4 subnet', () => {
    const allowlist = createIpAllowlist('10.0.0.0/8');
    expect(allowlist.unrestricted).toBe(false);
    expect(allowlist.allows('10.1.2.3')).toBe(true);
    expect(allowlist.allows('10.255.255.255')).toBe(true);
    expect(allowlist.allows('11.0.0.1')).toBe(false);
    expect(allowlist.allows('192.168.1.1')).toBe(false);
  });

  it('treats a bare address as a single host', () => {
    const allowlist = createIpAllowlist('203.0.113.7');
    expect(allowlist.allows('203.0.113.7')).toBe(true);
    expect(allowlist.allows('203.0.113.8')).toBe(false);
  });

  it('accepts several comma-separated entries with surrounding whitespace', () => {
    const allowlist = createIpAllowlist(' 10.0.0.0/8 , 192.168.10.0/24 ');
    expect(allowlist.allows('10.9.9.9')).toBe(true);
    expect(allowlist.allows('192.168.10.42')).toBe(true);
    expect(allowlist.allows('192.168.11.42')).toBe(false);
  });

  it('matches IPv4-mapped IPv6 sources against IPv4 rules', () => {
    // A dual-stack socket reports 10.1.2.3 as ::ffff:10.1.2.3; an operator
    // should not have to know that when writing the allowlist.
    const allowlist = createIpAllowlist('10.0.0.0/8');
    expect(allowlist.allows('::ffff:10.1.2.3')).toBe(true);
    expect(allowlist.allows('::ffff:11.1.2.3')).toBe(false);
  });

  it('matches an IPv6 subnet', () => {
    const allowlist = createIpAllowlist('2001:db8::/32');
    expect(allowlist.allows('2001:db8::1')).toBe(true);
    expect(allowlist.allows('2001:db8:dead:beef::5')).toBe(true);
    expect(allowlist.allows('2001:db9::1')).toBe(false);
  });

  it('denies a request with no resolvable source IP', () => {
    const allowlist = createIpAllowlist('10.0.0.0/8');
    expect(allowlist.allows(undefined)).toBe(false);
    expect(allowlist.allows('')).toBe(false);
  });

  it('denies a garbage source IP', () => {
    const allowlist = createIpAllowlist('10.0.0.0/8');
    expect(allowlist.allows('not-an-ip')).toBe(false);
    expect(allowlist.allows('10.0.0.999')).toBe(false);
  });

  it('ignores an invalid entry but keeps the valid ones', () => {
    const allowlist = createIpAllowlist('10.0.0.0/8, nonsense/24, 172.16.0.0/12');
    expect(allowlist.allows('10.0.0.1')).toBe(true);
    expect(allowlist.allows('172.16.5.5')).toBe(true);
    expect(allowlist.allows('8.8.8.8')).toBe(false);
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('fails closed when every entry is invalid', () => {
    const allowlist = createIpAllowlist('nonsense, 10.0.0.0/99, ::/500');
    expect(allowlist.unrestricted).toBe(false);
    expect(allowlist.allows('10.0.0.1')).toBe(false);
    expect(allowlist.allows('8.8.8.8')).toBe(false);
  });

  it('rejects an out-of-range prefix length', () => {
    expect(createIpAllowlist('10.0.0.0/33').allows('10.0.0.1')).toBe(false);
    expect(createIpAllowlist('2001:db8::/129').allows('2001:db8::1')).toBe(false);
  });
});
