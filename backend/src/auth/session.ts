/**
 * Express session configuration.
 *
 * Uses a PostgreSQL-backed session store (`connect-pg-simple`) so that
 * sessions survive container restarts and work across multiple ACA
 * replicas.  The `session` table is created automatically.
 *
 * The store is given a pool built by `createDbPool()`, NOT a connection string.
 * Handing `conString` to connect-pg-simple makes it build its own pg.Pool with
 * no TLS and no password, which cannot reach Azure PostgreSQL: the server
 * rejects the unencrypted connection with
 *   no pg_hba.conf entry for host "...", user "...", database "...", no encryption
 * and, once encrypted, there is still no password because Entra authentication
 * keeps it out of DATABASE_URL — the token comes from the `password` callback
 * that only `createDbPool()` installs.
 */
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { createDbPool } from '../db/index.js';
import type { AppUser } from './user.js';

const PgStore = connectPgSimple(session);

export interface SessionData extends session.SessionData {
  passport?: {
    /** Either a SAML SSO user or a break-glass one — see auth/user.ts. */
    user?: AppUser;
  };
}

/**
 * Create a PostgreSQL-backed session store instance.
 *
 * Create it ONCE and share it between the Express session middleware and the
 * WebSocket upgrade verifier: both must read the same sessions, and a second
 * store would mean a second connection pool against the same database for no
 * benefit.
 */
export function createSessionStore(): session.Store {
  return new PgStore({
    // A dedicated, deliberately small pool: session reads are short and
    // frequent, and they must not be able to starve the application pool.
    pool: createDbPool({ max: 5 }),
    createTableIfMissing: true,
  }) as unknown as session.Store;
}

/**
 * Build the Express session middleware around an existing store.
 * `secret` is the session signing secret (defaults to a hard-coded fallback
 * only for local dev — in production ACA injects `SESSION_SECRET`).
 */
export function createSessionMiddleware(store: session.Store, secret: string) {
  return session({
    store,
    secret,
    name: 'guestportal.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 h
    },
  });
}
