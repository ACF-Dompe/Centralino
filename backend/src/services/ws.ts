/**
 * WebSocket server for real-time event broadcasting.
 *
 * Usage:
 *   import { initWsServer, broadcast } from './ws.js';
 *   const server = http.createServer(app);
 *   initWsServer(server, sessionMiddleware);
 *   // ... anywhere else in the app:
 *   broadcast({ type: 'guest:expired', data: { id, name } });
 *
 * The WebSocket endpoint is at `/api/ws`.
 * Messages are JSON: { type: string, data?: unknown, timestamp: string }
 *
 * Authentication and authorization:
 *   WebSocket upgrades are authenticated via the same Express session that
 *   protects the REST API. On upgrade, the session cookie (guestportal.sid) is
 *   parsed and validated against the PostgreSQL session store. Only clients
 *   with a valid passport-authenticated session are allowed to upgrade.
 *   Unauthenticated upgrade requests receive a 401 response.
 *
 *   The verifier also resolves the caller's authorization, for two reasons: a
 *   suspended user must not keep a live socket just because their session
 *   cookie is still valid, and each connection has to remember which site it
 *   may hear about. Events used to go to every client regardless, so an
 *   operator in one city saw guest names appear from another — harmless while
 *   sites were only a filter, not acceptable now that they are a boundary.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'http';
import { log } from '../logger.js';

/** What a connection is allowed to hear. */
interface ClientContext {
  ws: WebSocket;
  /** Site this connection may receive events for; null means every site. */
  sedeId: number | null;
  /** True for an admin or break-glass session: no site restriction. */
  allSedi: boolean;
}

/** Connected clients, keyed by a monotonic connection id. */
const clients = new Map<number, ClientContext>();
let nextId = 0;

export type WsEvent =
  | { type: 'guest:expired'; data: { id: string; name: string; username: string; sedeId?: number | null } }
  | { type: 'guest:created'; data: { id: string; name: string; username: string; sedeId?: number | null } }
  | { type: 'guest:updated'; data: { id: string; name: string; username: string; status: string; sedeId?: number | null } }
  | { type: 'guest:deactivated'; data: { id: string; name: string; username: string; sedeId?: number | null } }
  | { type: 'guest:deleted'; data: { id: string; name: string; username: string; sedeId?: number | null } }
  | { type: 'guest:imported'; data: { id: string; name: string; username: string; sedeId?: number | null } }
  | { type: 'sync:completed'; data: { sedeId: number } };

/**
 * Interface for the session authentication needed by the WebSocket server.
 * Abstracts away the Express session middleware so the WS module doesn't
 * need to import Express types directly.
 */
export interface SessionVerifier {
  /**
   * Verify that a request has a valid, currently-authorized session.
   *
   * Calls back with null to refuse the upgrade, or with the scope the
   * connection should be granted.
   */
  verifySession: (
    req: IncomingMessage,
    callback: (scope: { sedeId: number | null; allSedi: boolean } | null) => void,
  ) => void;
}

/**
 * Initialise the WebSocket server on top of an existing HTTP server.
 * Call once at startup.
 *
 * @param server - The HTTP server to attach the WebSocket server to.
 * @param sessionVerifier - Session authentication handler for upgrade requests.
 *                          Must be provided in production; pass a noop
 *                          verifier that always returns true for testing.
 */
let _wss: WebSocketServer | null = null;

export function initWsServer(server: Server, sessionVerifier: SessionVerifier): void {
  // Create the WebSocket server WITHOUT auto-upgrade handling.
  // We manually intercept upgrade events to authenticate first.
  const wss = new WebSocketServer({ noServer: true, path: '/api/ws' });
  _wss = wss;

  // Intercept HTTP upgrade events to validate the session before
  // allowing the WebSocket connection to be established.
  server.on('upgrade', (request, socket, head) => {
    const reqPath = request.url ?? '';
    if (!reqPath.startsWith('/api/ws')) return; // Not our path — pass through

    sessionVerifier.verifySession(request, (scope) => {
      if (!scope) {
        log.warn({ ip: request.socket.remoteAddress }, 'WebSocket upgrade rejected — unauthenticated or not authorized');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Session valid — perform the WebSocket upgrade
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, scope);
      });
    });
  });

  wss.on('connection', (
    ws: WebSocket,
    req: IncomingMessage,
    scope?: { sedeId: number | null; allSedi: boolean },
  ) => {
    const id = nextId++;
    clients.set(id, {
      ws,
      sedeId: scope?.sedeId ?? null,
      // Absent scope means the caller wired a permissive verifier (tests);
      // treat it as unrestricted rather than silently muting every event.
      allSedi: scope?.allSedi ?? true,
    });
    log.debug({ clientId: id, total: clients.size, sedeId: scope?.sedeId ?? null, ip: req.socket.remoteAddress }, 'WebSocket connected');

    ws.on('close', () => {
      clients.delete(id);
      log.debug({ clientId: id, total: clients.size }, 'WebSocket disconnected');
    });

    ws.on('error', (err) => {
      log.warn({ clientId: id, err: err.message }, 'WebSocket error');
      clients.delete(id);
    });

    // Send a brief hello so the client knows the server is WS-ready
    ws.send(JSON.stringify({ type: 'hello', data: { server: 'centralino-ws' }, timestamp: new Date().toISOString() }));
  });

  wss.on('error', (err) => {
    log.error({ err: err.message }, 'WebSocket server error');
  });

  log.info({ path: '/api/ws' }, 'WebSocket server initialised');
}

/**
 * Gracefully shut down the WebSocket server.
 * Closes all existing connections then closes the server.
 */
export function shutdownWsServer(): void {
  if (!_wss) return;
  // Close all connected clients
  for (const [id, client] of clients) {
    try { client.ws.close(); } catch { /* ignore */ }
    clients.delete(id);
  }
  _wss.close(() => {
    log.info('WebSocket server closed');
  });
  _wss = null;
}

/** Which site an event concerns, or null when it concerns no site in particular. */
function eventSedeId(event: WsEvent): number | null {
  const raw = (event.data as { sedeId?: number | null }).sedeId;
  return raw == null ? null : Number(raw);
}

/**
 * Broadcast an event to the clients entitled to see it.
 *
 * Events carry a site, and a connection only receives the ones for the site it
 * is working on — guest names are personal data, and there is no reason for an
 * operator in one location to be told who just connected in another. Events
 * with no site attached still go to everyone; only admins and break-glass
 * sessions see everything.
 */
export function broadcast(event: WsEvent): void {
  if (clients.size === 0) return;

  const message = JSON.stringify({
    ...event,
    timestamp: new Date().toISOString(),
  });
  const sedeId = eventSedeId(event);

  for (const [id, client] of clients) {
    try {
      if (client.ws.readyState !== client.ws.OPEN) {
        clients.delete(id); // clean up stale connections
        continue;
      }
      const entitled =
        client.allSedi || sedeId == null || client.sedeId === sedeId;
      if (!entitled) continue;
      client.ws.send(message);
    } catch {
      clients.delete(id); // remove on send error
    }
  }
}
