/**
 * Express session configuration.
 *
 * Uses a PostgreSQL-backed session store (`connect-pg-simple`) so that
 * sessions survive container restarts and work across multiple ACA
 * replicas.  The `session` table is created automatically.
 */
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { SamlUser } from './saml.js';

const PgStore = connectPgSimple(session);

export interface SessionData extends session.SessionData {
  passport?: {
    user?: SamlUser;
  };
}

/**
 * Create a PostgreSQL-backed session store instance.
 * Shared between the Express session middleware and WebSocket
 * upgrade authentication so both can validate sessions against
 * the same database.
 */
export function createSessionStore(databaseUrl: string): session.Store {
  return new PgStore({
    conString: databaseUrl,
    createTableIfMissing: true,
  }) as unknown as session.Store;
}

/**
 * Build the Express session middleware.
 * `databaseUrl` is the PostgreSQL connection string.
 * `secret` is the session signing secret (defaults to a hard-coded fallback
 * only for local dev — in production ACA injects `SESSION_SECRET`).
 */
export function createSessionMiddleware(databaseUrl: string, secret: string) {
  return session({
    store: createSessionStore(databaseUrl),
    secret,
    name: 'cgd.sid',
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
