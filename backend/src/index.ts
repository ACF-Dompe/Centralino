/**
 * Entry point: starts the Express server, opens the DB connection,
 * runs migrations/seed (unless SKIP_MIGRATIONS/SEED_ENABLED control them),
 * and starts the background services.
 *
 * Guidelines §10: graceful shutdown via SIGTERM — drain in-flight requests,
 * close DB pool, stop WebSocket server and background timers.
 * Guidelines §9: correlation ID on every HTTP request for structured logging.
 */
import http from 'http';
import express from 'express';
import compression from 'compression';
import passport from 'passport';
import { v4 as uuid } from 'uuid';

import { config } from './config.js';
import { router } from './routes/index.js';
import { createAuthRouter } from './routes/auth.js';
import { createSamlStrategy } from './auth/saml.js';
import { createSessionMiddleware, createSessionStore } from './auth/session.js';
import cookieSignature from 'cookie-signature';
import type { SessionData } from './auth/session.js';
import { startBackgroundServices, stopBackgroundServices } from './services/timer.js';
import { initWsServer, shutdownWsServer } from './services/ws.js';
import { getDb } from './db/index.js';
import { log } from './logger.js';

let server: http.Server;

async function main(): Promise<void> {
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

  // ── Correlation ID middleware ───────────────────────────────────────────
  // Generates a unique identifier for every HTTP request and attaches it to
  // the structured log output so that all log lines for the same request can
  // be correlated in Log Analytics. The ID is also sent as a response header
  // (X-Request-Id) for debugging.
  app.use((req, res, next) => {
    const correlationId = uuid().slice(0, 12);
    req.correlationId = correlationId;
    res.setHeader('X-Request-Id', correlationId);
    next();
  });

  // ── Session & Passport (SSO SAML) ───────────────────────────────────────
  const sessionMiddleware = createSessionMiddleware(
    config.databaseUrl,
    config.sessionSecret,
  );
  app.use(sessionMiddleware);

  // ── WebSocket session verifier ───────────────────────────────────────────
  // Uses the same PostgreSQL session store as the Express middleware to
  // authenticate WebSocket upgrade requests. The verifier reads the session
  // cookie, unsigns it (express-session signs all cookies with 's:' prefix),
  // looks up the session in PostgreSQL via store.get(), and checks for a
  // passport-authenticated user in the session data.
  const wsSessionStore = createSessionStore(config.databaseUrl);
  app.use(passport.initialize());
  app.use(passport.session());

  // Serialize / deserialize the full user object into/from the session.
  // Storing the entire SamlUser is safe because it only contains identity
  // attributes (no secrets), and it avoids a database lookup on every request.
  passport.serializeUser((user: any, done) => {
    done(null, user);
  });
  passport.deserializeUser((obj: any, done) => {
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
  } else {
    log.info('SSO disabled — SAML env vars not set (local/dev mode)');
  }

  // Mount auth routes BEFORE the main API router so they can bypass
  // the ensureAuthenticated middleware.
  app.use('/api/auth', createAuthRouter({
    samlEnabled: config.saml.enabled,
    samlStrategy: samlStrategy ?? undefined,
  }));

  // Pino-based HTTP request logging (structured JSON for Log Analytics)
  // Includes correlation ID for request tracing across log lines.
  app.use((req, res, next) => {
    const start = Date.now();
    const correlationId = req.correlationId ?? '';
    res.on('finish', () => {
      log.info({
        correlationId,
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
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    const status = err.status || err.statusCode || 500;
    log.warn(
      { err: err.message, type: err.type, status, method: req.method, path: req.path, correlationId: req.correlationId },
      'Request error',
    );
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
  server = http.createServer(app);
  initWsServer(server, {
    verifySession(req, callback) {
      // Parse the session cookie from the Cookie header
      const rawCookie = req.headers.cookie ?? '';
      const match = rawCookie.match(/(?:^|;\s*)guestportal\.sid=([^;]+)/);
      if (!match) {
        callback(false);
        return;
      }

      // Express-session signs session cookies with the format:
      //   s:<session-id>.<signature>
      // We must unsign to get the raw session ID before calling store.get(),
      // because connect-pg-simple stores sessions keyed by the unsigned ID.
      const signedValue = match[1];
      const sid = signedValue.startsWith('s:')
        ? cookieSignature.unsign(signedValue.slice(2), config.sessionSecret)
        : signedValue;

      if (!sid) {
        callback(false); // Invalid cookie signature
        return;
      }

      wsSessionStore.get(sid, (err: Error | null, session?: SessionData | null) => {
        if (err || !session) {
          callback(false);
          return;
        }
        // Verify the session contains a passport-authenticated user
        callback(!!session.passport?.user);
      });
    },
  });
  server.listen(config.port, '0.0.0.0', () => {
    log.info(`Server listening on http://0.0.0.0:${config.port}`);
  });

  startBackgroundServices();

  // ── Graceful shutdown (SIGTERM) ─────────────────────────────────────────
  // Guidelines §10: on SIGTERM, stop accepting new connections, drain
  // in-flight requests (with a 30s timeout), close DB pool, stop WebSocket
  // server, and stop background timers. Then exit.
  let shuttingDown = false;
  process.on('SIGTERM', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('SIGTERM received — starting graceful shutdown...');

    // Stop background services immediately (no new sync cycles)
    stopBackgroundServices();

    // Close the WebSocket server (existing connections are drained)
    shutdownWsServer();

    // Stop accepting new HTTP connections
    server.close(() => {
      log.info('HTTP server closed');
    });

    // Force exit after 30s regardless of remaining connections
    const forceExit = setTimeout(() => {
      log.warn('Graceful shutdown timeout (30s) — forcing exit');
      process.exit(1);
    }, 30_000);
    forceExit.unref();

    // Once the server closes, clean up DB pool and exit
    server.on('close', async () => {
      try {
        const db = await getDb();
        await db.close();
        log.info('DB pool closed');
      } catch (err) {
        log.error({ err: (err as Error).message }, 'Error closing DB pool during shutdown');
      }
      clearTimeout(forceExit);
      process.exit(0);
    });
  });
}

function redactUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ':***@');
}

main().catch((err) => {
  log.error({ err: err.message, stack: err.stack }, 'Fatal error during startup');
  process.exit(1);
});
