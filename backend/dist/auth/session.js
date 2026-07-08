/**
 * Express session configuration.
 *
 * Uses a PostgreSQL-backed session store (`connect-pg-simple`) so that
 * sessions survive container restarts and work across multiple ACA
 * replicas.  The `session` table is created automatically.
 */
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
const PgStore = connectPgSimple(session);
/**
 * Build the Express session middleware.
 * `databaseUrl` is the PostgreSQL connection string.
 * `secret` is the session signing secret (defaults to a hard-coded fallback
 * only for local dev — in production ACA injects `SESSION_SECRET`).
 */
export function createSessionMiddleware(databaseUrl, secret) {
    return session({
        store: new PgStore({
            conString: databaseUrl,
            createTableIfMissing: true,
        }),
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
//# sourceMappingURL=session.js.map