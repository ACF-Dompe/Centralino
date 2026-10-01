import { describe, it, expect } from 'vitest';
import { generateCredentials } from '../utils/credentials.js';

describe('generateCredentials', () => {
  it('generates username with g. prefix and 3-digit suffix', () => {
    const result = generateCredentials('Mario');
    expect(result.username).toMatch(/^g\.mario\d{3}$/);
  });

  it('generates a 12-character password from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const { password } = generateCredentials('Mario');
      expect(password).toMatch(/^[A-Za-z2-9]{12}$/);
      expect(password).not.toMatch(/[IOilo01]/);
    }
  });

  // It used to start with "DOMPE-": six characters every guest could predict.
  it('has no fixed prefix', () => {
    const firstChars = new Set(Array.from({ length: 50 }, () => generateCredentials('Mario').password.slice(0, 3)));
    expect(firstChars.size).toBeGreaterThan(1);
    expect(generateCredentials('Mario').password).not.toMatch(/^DOMPE/i);
  });

  it('always mixes upper case, lower case and digits', () => {
    for (let i = 0; i < 200; i++) {
      const { password } = generateCredentials('Mario');
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[2-9]/);
    }
  });

  it('strips non-alpha characters from slug', () => {
    const result = generateCredentials('TEST-123!@#');
    expect(result.username).toMatch(/^g\.test\d{3}$/);
  });

  it('falls back to "guest" when name has no letters', () => {
    const result = generateCredentials('12345');
    expect(result.username).toMatch(/^g\.guest\d{3}$/);
  });

  it('truncates slug to 8 characters', () => {
    const result = generateCredentials('A very long name here');
    expect(result.username).toMatch(/^g\.averylon\d{3}$/);
  });

  it('lowercases the slug', () => {
    const result = generateCredentials('MARIO');
    expect(result.username).toMatch(/^g\.mario\d{3}$/);
  });

  it('produces different values on successive calls', () => {
    const r1 = generateCredentials('Test');
    const r2 = generateCredentials('Test');
    // Very unlikely to collide on both username and password
    expect(r1.username).not.toBe(r2.username);
    expect(r1.password).not.toBe(r2.password);
  });
});
