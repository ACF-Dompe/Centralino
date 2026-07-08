import { describe, it, expect } from 'vitest';
import {
  sanitizeIOSXE,
  validateUsername,
  validatePassword,
  validateHost,
  validateDurationMinutes,
} from '../utils/sanitize.js';

describe('sanitizeIOSXE', () => {
  it('passes safe values through', () => {
    expect(sanitizeIOSXE('admin_guest', 'Test')).toBe('admin_guest');
    expect(sanitizeIOSXE('user@domain.com', 'Test')).toBe('user@domain.com');
    expect(sanitizeIOSXE('test-user', 'Test')).toBe('test-user');
  });

  it('trims whitespace', () => {
    expect(sanitizeIOSXE('  hello  ', 'Test')).toBe('hello');
  });

  it('rejects newlines', () => {
    expect(() => sanitizeIOSXE('admin\nconfigure terminal', 'Test')).toThrow('newline');
    expect(() => sanitizeIOSXE('admin\r\nend', 'Test')).toThrow('newline');
    expect(() => sanitizeIOSXE('admin\rend', 'Test')).toThrow('newline');
  });

  it('rejects null bytes', () => {
    expect(() => sanitizeIOSXE('admin\0evil', 'Test')).toThrow('non validi');
  });

  it('rejects empty values', () => {
    expect(() => sanitizeIOSXE('', 'Test')).toThrow('non valido');
    expect(() => sanitizeIOSXE('   ', 'Test')).toThrow('vuoto');
  });

  it('rejects values exceeding max length', () => {
    expect(() => sanitizeIOSXE('a'.repeat(256), 'Test', 255)).toThrow('troppo lungo');
  });

  it('accepts values within max length', () => {
    expect(sanitizeIOSXE('a'.repeat(255), 'Test', 255)).toBe('a'.repeat(255));
  });
});

describe('validateUsername', () => {
  it('accepts valid usernames', () => {
    expect(validateUsername('admin_guest')).toBe('admin_guest');
    expect(validateUsername('mario.rossi')).toBe('mario.rossi');
    expect(validateUsername('user@dompe.com')).toBe('user@dompe.com');
    expect(validateUsername('test-user')).toBe('test-user');
    expect(validateUsername('Guest123')).toBe('Guest123');
  });

  it('rejects usernames with spaces', () => {
    expect(() => validateUsername('admin user')).toThrow('caratteri non consentiti');
  });

  it('rejects usernames with newlines', () => {
    expect(() => validateUsername('admin\nconfigure')).toThrow('newline');
  });

  it('rejects usernames with special characters', () => {
    expect(() => validateUsername('admin;evil')).toThrow('caratteri non consentiti');
    expect(() => validateUsername('admin|grep')).toThrow('caratteri non consentiti');
    expect(() => validateUsername('`whoami`')).toThrow('caratteri non consentiti');
    expect(() => validateUsername('$(id)')).toThrow('caratteri non consentiti');
  });

  it('rejects empty usernames', () => {
    expect(() => validateUsername('')).toThrow();
    expect(() => validateUsername(null)).toThrow();
    expect(() => validateUsername(undefined)).toThrow();
  });
});

describe('validatePassword', () => {
  it('accepts valid passwords', () => {
    expect(validatePassword('Pass123!@#')).toBe('Pass123!@#');
    expect(validatePassword('DOMPE-4321')).toBe('DOMPE-4321');
    expect(validatePassword('a b c')).toBe('a b c');
  });

  it('rejects passwords with newlines', () => {
    expect(() => validatePassword('pass\nword')).toThrow('newline');
    expect(() => validatePassword('pass\rd')).toThrow('newline');
  });

  it('rejects passwords with null bytes', () => {
    expect(() => validatePassword('pass\0word')).toThrow('non validi');
  });

  it('rejects empty passwords', () => {
    expect(() => validatePassword('')).toThrow();
  });
});

describe('validateHost', () => {
  it('accepts valid hosts', () => {
    expect(validateHost('172.18.106.100')).toBe('172.18.106.100');
    expect(validateHost('wlc.dompe.com')).toBe('wlc.dompe.com');
    expect(validateHost('localhost')).toBe('localhost');
  });

  it('rejects hosts with newlines', () => {
    expect(() => validateHost('host\n-evil')).toThrow('newline');
  });
});

describe('validateDurationMinutes', () => {
  it('accepts valid durations', () => {
    expect(validateDurationMinutes(240)).toBe(240);
    expect(validateDurationMinutes(60)).toBe(60);
    expect(validateDurationMinutes(1)).toBe(1);
    expect(validateDurationMinutes(525600)).toBe(525600);
  });

  it('accepts string numbers', () => {
    expect(validateDurationMinutes('240')).toBe(240);
  });

  it('rejects zero', () => {
    expect(() => validateDurationMinutes(0)).toThrow('non valida');
  });

  it('rejects negative numbers', () => {
    expect(() => validateDurationMinutes(-1)).toThrow('non valida');
  });

  it('rejects non-integers', () => {
    expect(() => validateDurationMinutes(1.5)).toThrow('non valida');
  });

  it('rejects NaN', () => {
    expect(() => validateDurationMinutes(NaN)).toThrow('non valida');
  });

  it('rejects values exceeding max', () => {
    expect(() => validateDurationMinutes(999999)).toThrow('non valida');
  });
});
