/**
 * Password hashing for break-glass accounts.
 *
 * Built exclusively on Node's own `node:crypto` — no bcrypt/argon2 dependency.
 * Adding a native-binding crypto package would widen the supply-chain and
 * Trivy surface for the sake of one rarely-used login path, and scrypt is a
 * memory-hard KDF standardised in RFC 7914 that Node ships out of the box.
 *
 * Stored format (single self-describing string, so the cost parameters can be
 * raised later without invalidating existing hashes):
 *
 *   scrypt$<N>$<r>$<p>$<salt-base64>$<hash-base64>
 *
 * The plaintext password is never persisted, logged or returned anywhere.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * scrypt cost parameters.
 *
 * N=16384, r=8 needs 128 * N * r ≈ 16 MiB per hash, which stays under Node's
 * default 32 MiB `maxmem` ceiling — raising N to 32768 would hit it and throw.
 */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** Minimum length enforced when an account is created through the CLI. */
export const MIN_PASSWORD_LENGTH = 16;

/**
 * Hash a plaintext password with a fresh random salt.
 * Returns the self-describing string to store in `breakglass_users.password_hash`.
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(plain, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Returns `false` — never throws — for malformed or truncated stored values, so
 * a corrupted row cannot turn into a 500 on the login path (which would tell an
 * attacker that the account exists). The comparison itself is constant-time.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(rawSalt, 'base64');
    expected = Buffer.from(rawHash, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  let derived: Buffer;
  try {
    derived = scryptSync(plain, salt, expected.length, { N, r, p });
  } catch {
    // Cost parameters outside what this Node build will allocate.
    return false;
  }

  // Lengths always match here (we derive `expected.length` bytes), but
  // timingSafeEqual throws on a mismatch, so keep the guard.
  if (derived.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

/**
 * Hash-shaped dummy used when the requested account does not exist.
 *
 * The login route verifies the submitted password against this value so that a
 * miss costs the same ~16 MiB scrypt derivation as a hit. Without it, response
 * latency alone would let an attacker enumerate valid break-glass usernames.
 */
export const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString('hex'));

/**
 * Generate a strong random password for a new break-glass account.
 * Base64url over 24 random bytes → 32 characters, ~192 bits of entropy.
 */
export function generateStrongPassword(): string {
  return randomBytes(24).toString('base64url');
}
