/**
 * Credential generation for guest accounts.
 * Uses crypto.randomInt() (CSPRNG) for secure random values.
 *  - username = "g.{slug}{3 digits}"
 *  - password = "DOMPE-{8 alphanumeric chars}"
 */
import crypto from 'node:crypto';

const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // no I, O, l, 0 to avoid confusion
const PASSWORD_LENGTH = 8;

export function generateCredentials(rawName: string): { username: string; password: string } {
  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .slice(0, 8);
  const safeSlug = slug.length > 0 ? slug : 'guest';
  const num = crypto.randomInt(100, 999);
  const password = generatePassword();
  return {
    username: `g.${safeSlug}${num}`,
    password: `DOMPE-${password}`,
  };
}

function generatePassword(): string {
  let result = '';
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    const idx = crypto.randomInt(0, PASSWORD_CHARS.length);
    result += PASSWORD_CHARS[idx];
  }
  return result;
}
