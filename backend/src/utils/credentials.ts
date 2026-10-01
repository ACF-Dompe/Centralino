/**
 * Credential generation for guest accounts.
 * Uses crypto.randomInt() (CSPRNG) for secure random values.
 *  - username = "g.{slug}{3 digits}"
 *  - password = 12 random characters, with at least one upper-case letter,
 *    one lower-case letter and one digit
 *
 * The password used to be "DOMPE-" followed by 8 random characters: six
 * characters every guest could predict, which made it look longer than it was.
 */
import crypto from 'node:crypto';

// No I, O, i, l, o, 0, 1: they are read back from a screen or a printout.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const DIGITS = '23456789';
const PASSWORD_CHARS = UPPER + LOWER + DIGITS;
/** ~69 bits from a 55-character alphabet, still short enough to type on a phone. */
const PASSWORD_LENGTH = 12;

export function generateCredentials(rawName: string): { username: string; password: string } {
  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .slice(0, 8);
  const safeSlug = slug.length > 0 ? slug : 'guest';
  const num = crypto.randomInt(100, 999);
  return {
    username: `g.${safeSlug}${num}`,
    password: generatePassword(),
  };
}

function pick(chars: string): string {
  return chars[crypto.randomInt(0, chars.length)];
}

function generatePassword(): string {
  // One character of each class, so a controller policy that asks for a mix is
  // always met; the rest from the whole set. The shuffle keeps the guaranteed
  // characters from sitting at fixed positions.
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS)];
  while (chars.length < PASSWORD_LENGTH) chars.push(pick(PASSWORD_CHARS));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
