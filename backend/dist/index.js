/**
 * Entry point: starts the Express server, opens the DB connection,
 * runs migrations/seed, and starts the background services.
 */
import express from 'express';
import compression from 'compression';
import passport from 'passport';
import { config } from './config.js';
import { router } from './routes/index.js';
import { createAuthRouter } from './routes/auth.js';
import { createSamlStrategy } from './auth/saml.js';
import { createSessionMiddleware } from './auth/session.js';
import { startBackgroundServices } from './services/timer.js';
import { getDb } from './db/index.js';
import { log } from './logger.js';
async function main() {
    await getDb();
    log.info({ url: redactUrl(config.databaseUrl) }, 'DB ready');
    const app = express();
    app.set('trust proxy', 1);
    // CORS is NOT needed — the Application Gateway handles path-based routing
    // (/api/* → backend, /* → frontend) so requests to different origins are
    // never made by the browser. CORS would only weaken security.
    // See: Azure Container Platform – AI Development Guidelines §Ingress
    app.use(compression());
    app.use(express.json({ limit: '1mb' }));
    // ── Session & Passport (SSO SAML) ───────────────────────────────────────
    const sessionMiddleware = createSessionMiddleware(config.databaseUrl, config.sessionSecret);
    app.use(sessionMiddleware);
    app.use(passport.initialize());
    app.use(passport.session());
    // Serialize / deserialize the full user object into/from the session.
    // Storing the entire SamlUser is safe because it only contains identity
    // attributes (no secrets), and it avoids a database lookup on every request.
    passport.serializeUser((user, done) => {
        done(null, user);
    });
    passport.deserializeUser((obj, done) => {
        done(null, obj);
    });
    // Initialise the SAML strategy (or no-op if env vars are missing).
    const samlStrategy = createSamlStrategy({
        entryPoint: config.saml.entryPoint,
        issuer: config.saml.issuer,
        callbackUrl: config.saml.callbackUrl,
        cert: config.saml.cert,
        decryptionKey: config.saml.decryptionKey || undefined,
        identifierFormat: config.saml.identifierFormat,
        logoutUrl: config.saml.logoutUrl || undefined,
        logoutCallbackUrl: config.saml.logoutCallbackUrl || undefined,
    });
    if (samlStrategy) {
        passport.use(samlStrategy);
        log.info('SSO SAML strategy initialised (Entra ID)');
        if (config.saml.logoutUrl) {
            log.info('SAML Single Logout (SLO) enabled');
        }
    }
    else {
        log.info('SSO disabled — SAML env vars not set (local/dev mode)');
    }
    // Mount auth routes BEFORE the main API router so they can bypass
    // the ensureAuthenticated middleware.
    app.use('/api/auth', createAuthRouter({
        samlEnabled: config.saml.enabled,
        samlStrategy: samlStrategy ?? undefined,
    }));
    // Pino-based HTTP request logging (structured JSON for Log Analytics)
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            log.info({
                method: req.method,
                path: req.path,
                status: res.statusCode,
                duration: `${Date.now() - start}ms`,
                userAgent: req.headers['user-agent'] ?? '',
                ip: req.ip,
            }, 'HTTP request');
        });
        next();
    });
    app.use('/api', router);
    // JSON error handler — returns structured JSON for API errors (body-parser
    // failures, route errors, etc.) instead of Express's default HTML error page.
    // This makes the API contract consistent (clients always get
    // `{ success, error }`) and surfaces the real error message in both logs
    // and response body. Non-API errors (e.g. missing SPA `index.html`) are
    // passed through to Express's default handler to preserve the HTML page.
    // MUST be registered AFTER all routes (Express identifies error handlers
    // by their 4-argument signature).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err, req, res, next) => {
        const status = err.status || err.statusCode || 500;
        log.warn({ err: err.message, type: err.type, status, method: req.method, path: req.path }, 'Request error');
        // For non-API routes, pass through to Express's default error handler
        // (which returns an HTML page), so SPA routing errors are not silently
        // swallowed as JSON.
        if (!req.path.startsWith('/api/')) {
            return next(err);
        }
        res.status(status).json({
            success: false,
            error: err.message || 'Internal Server Error',
            type: err.type,
        });
    });
    // Frontend is served by a separate Container App through the Application
    // Gateway. The backend only serves API routes.
    // In dev mode, the Vite dev server (port 5173) proxies /api/* to this backend.
    log.info('API-only mode: frontend is served by a separate ACA container');
    // Bind to 0.0.0.0 for ACA compatibility (ACA routes traffic to the
    // container's port regardless of the host interface).
    app.listen(config.port, '0.0.0.0', () => {
        log.info(`Server listening on http://0.0.0.0:${config.port}`);
    });
    startBackgroundServices();
}
function redactUrl(url) {
    return url.replace(/:[^:@/]+@/, ':***@');
}
main().catch((err) => {
    log.error({ err: err.message, stack: err.stack }, 'Fatal error during startup');
    process.exit(1);
});
//# sourceMappingURL=index.js.map