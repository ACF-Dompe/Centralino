/**
 * Sanitization utilities for preventing command injection in IOS-XE SSH commands.
 *
 * The WLC SSH shell processes commands line by line. If user-supplied values
 * contain newlines (\n, \r), they would inject additional commands into the
 * IOS-XE configuration session. These utilities ensure only safe characters
 * reach the SSH stream.
 *
 * Injection surface in routes/index.ts:
 *   - cfg.targetUsername → `user-name ${...}`  /  `show ... user-name ${...}`
 *   - cfg.targetPassword → `password 0 ${...}`
 *   - targetUsername     → `no user-name ${...}` / `show ... user-name ${...}`
 *   - before.username    → `no user-name ${...}`  (from DB — trusted after write)
 *   - generated username/password → `user-name` / `password 0` (safe)
 *   - durationMinutes    → minutesToLifetime(num)  (converted to structured format)
 */

/**
 * IOS-XE username regex: alphanumeric, dots, hyphens, underscores, @.
 * This covers both simple usernames (admin_guest) and email-style (user@domain.com).
 */
const USERNAME_RE = /^[a-zA-Z0-9._@-]+$/;

/**
 * IOS-XE password: reject any value containing newlines or control characters.
 * Passwords can contain most printable ASCII including spaces.
 * We only block line breaks and null bytes.
 */
const PASSWORD_SAFE_RE = /^[\x20-\x7E]*$/;

/**
 * Sanitize a value for use as an IOS-XE command argument.
 * Throws an error if the value contains newlines or other dangerous characters.
 *
 * @param value - The raw user-supplied value
 * @param label - Human-readable label for error messages
 * @param maxLength - Maximum allowed length (default 255)
 * @returns The sanitized value (trimmed, unchanged otherwise)
 */
export function sanitizeIOSXE(value: string, label: string, maxLength = 255): string {
  if (!value || typeof value !== 'string') {
    throw new Error(`${label} non valido`);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error(`${label} non può essere vuoto`);
  }

  if (trimmed.length > maxLength) {
    throw new Error(`${label} troppo lungo (max ${maxLength} caratteri)`);
  }

  // Block newlines and carriage returns — these would inject additional commands
  if (/[\r\n]/.test(trimmed)) {
    throw new Error(`${label} contiene caratteri non validi (newline)`);
  }

  // Block null bytes
  if (/\0/.test(trimmed)) {
    throw new Error(`${label} contiene caratteri non validi`);
  }

  return trimmed;
}

/**
 * Validate and sanitize a Cisco IOS-XE username.
 *
 * IOS-XE usernames must not contain spaces or newlines.
 * This rejects any value that doesn't match the expected pattern.
 *
 * @param username - Raw username from request body
 * @returns Sanitized username
 * @throws Error if invalid
 */
export function validateUsername(username: unknown): string {
  const safe = sanitizeIOSXE(String(username ?? ''), 'Username');
  if (!USERNAME_RE.test(safe)) {
    throw new Error('Username contiene caratteri non consentiti (usa solo lettere, numeri, ., _, -, @)');
  }
  return safe;
}

/**
 * Validate and sanitize a Cisco IOS-XE password.
 *
 * Passwords can contain most printable ASCII but must not contain
 * newlines or control characters that would break the SSH command stream.
 *
 * @param password - Raw password from request body
 * @returns Sanitized password
 * @throws Error if invalid
 */
export function validatePassword(password: unknown): string {
  const safe = sanitizeIOSXE(String(password ?? ''), 'Password');
  if (!PASSWORD_SAFE_RE.test(safe)) {
    throw new Error('Password contiene caratteri non validi');
  }
  return safe;
}

/**
 * Validate and sanitize a hostname or IP address for WLC connection.
 *
 * @param host - Raw host from request body
 * @returns Sanitized host
 * @throws Error if invalid
 */
export function validateHost(host: unknown): string {
  return sanitizeIOSXE(String(host ?? ''), 'Host', 512);
}

/**
 * Validate duration minutes — must be a positive integer.
 *
 * @param value - Raw duration value
 * @returns Validated duration in minutes
 * @throws Error if invalid
 */
export function validateDurationMinutes(value: unknown, min = 1, max = 525600): number {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < min || num > max) {
    throw new Error(`Durata non valida (deve essere un numero tra ${min} e ${max})`);
  }
  return num;
}
