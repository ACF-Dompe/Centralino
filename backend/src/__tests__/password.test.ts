/**
 * Tests for break-glass password hashing (auth/password.ts).
 *
 * `verifyPassword` is on the login path, so the important property is not just
 * that it accepts the right password but that it NEVER throws: a corrupted or
 * truncated `password_hash` must degrade to "wrong password", not to a 500
 * that would tell an attacker the account exists.
 */
import { describe, it, expect } from 'vitest';
import {
  DUMMY_PASSWORD_HASH,
  generateStrongPassword,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from '../auth/password.js';

describe('hashPassword', () => {
  it('produces a self-describing scrypt string', () => {
    const hash = hashPassword('correct horse battery staple');
    const parts = hash.split('$');
    expect(parts[0]).toBe('scrypt');
    expect(parts).toHaveLength(6);
    expect(Number(parts[1])).toBe(16_384);
    expect(Number(parts[2])).toBe(8);
    expect(Number(parts[3])).toBe(1);
  });

  it('salts every hash, so the same password never hashes twice the same way', () => {
    expect(hashPassword('same-password')).not.toBe(hashPassword('same-password'));
  });
});

describe('verifyPassword', () => {
  it('accepts the correct password', () => {
    const password = 'un-very-long-break-glass-password';
    expect(verifyPassword(password, hashPassword(password))).toBe(true);
  });

  it('rejects a wrong password', () => {
    const hash = hashPassword('the-right-one');
    expect(verifyPassword('the-wrong-one', hash)).toBe(false);
  });

  it('rejects an empty password against a real hash', () => {
    expect(verifyPassword('', hashPassword('something'))).toBe(false);
  });

  it('is case sensitive', () => {
    const hash = hashPassword('CaseSensitivePassword');
    expect(verifyPassword('casesensitivepassword', hash)).toBe(false);
  });

  it('returns false instead of throwing on malformed stored values', () => {
    const cases = [
      '',
      'not-a-hash',
      'scrypt$16384$8$1$onlyfiveparts',
      'bcrypt$16384$8$1$c2FsdA==$aGFzaA==',
      'scrypt$notanumber$8$1$c2FsdA==$aGFzaA==',
      'scrypt$16384$8$1$$',
      '$$$$$',
    ];
    for (const stored of cases) {
      expect(() => verifyPassword('any', stored)).not.toThrow();
      expect(verifyPassword('any', stored)).toBe(false);
    }
  });

  it('rejects a hash whose digest has been tampered with', () => {
    const password = 'tamper-target-password';
    const parts = hashPassword(password).split('$');
    // Flip the first byte of the stored digest.
    const digest = Buffer.from(parts[5], 'base64');
    digest[0] = digest[0] ^ 0xff;
    parts[5] = digest.toString('base64');
    expect(verifyPassword(password, parts.join('$'))).toBe(false);
  });

  it('rejects a hash whose salt has been swapped', () => {
    const password = 'salt-swap-password';
    const a = hashPassword(password).split('$');
    const b = hashPassword(password).split('$');
    a[4] = b[4]; // keep digest from a, salt from b
    expect(verifyPassword(password, a.join('$'))).toBe(false);
  });

  it('rejects cost parameters this build cannot allocate', () => {
    // N far beyond Node's default 32 MiB maxmem — scryptSync throws internally
    // and the helper must swallow it rather than propagate a 500.
    const stored = `scrypt$1073741824$8$1$c2FsdHNhbHRzYWx0c2E=$${Buffer.alloc(64).toString('base64')}`;
    expect(verifyPassword('any', stored)).toBe(false);
  });
});

describe('DUMMY_PASSWORD_HASH', () => {
  it('is a valid hash that no realistic password matches', () => {
    expect(DUMMY_PASSWORD_HASH.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('', DUMMY_PASSWORD_HASH)).toBe(false);
    expect(verifyPassword('admin', DUMMY_PASSWORD_HASH)).toBe(false);
  });
});

describe('generateStrongPassword', () => {
  it('meets the minimum length and is base64url-safe', () => {
    const password = generateStrongPassword();
    expect(password.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats', () => {
    const generated = new Set(Array.from({ length: 50 }, () => generateStrongPassword()));
    expect(generated.size).toBe(50);
  });
});
