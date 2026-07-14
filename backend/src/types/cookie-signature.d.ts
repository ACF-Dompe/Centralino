/**
 * Minimal type declaration for `cookie-signature`.
 * This is a transitive dependency of `express-session` and is used
 * in the WebSocket upgrade handler to unsign session cookies before
 * looking up sessions in the PostgreSQL store.
 */
declare module 'cookie-signature' {
  /**
   * Unsign a signed cookie value.
   * Returns the original (unsigned) value if the signature is valid,
   * or `false` if the signature is invalid.
   */
  export function unsign(val: string, secret: string): string | false;

  /**
   * Sign a value with the given secret.
   * Returns the signed value (format: `s:<value>.<signature>`).
   */
  export function sign(val: string, secret: string): string;
}
