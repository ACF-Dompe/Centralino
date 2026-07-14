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
 * Authentication:
 *   WebSocket upgrades are authenticated via the same Express session that
 *   protects the REST API. On upgrade, the session cookie (cgd.sid) is
 *   parsed and validated against the PostgreSQL session store. Only clients
 *   with a valid passport-authenticated session are allowed to upgrade.
 *   Unauthenticated upgrade requests receive a 401 response.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'http';
import { log } from '../logger.js';

/** Connected clients, keyed by a monotonic connection id. */
const clients = new Map<number, WebSocket>();
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
   * Verify that a request has a valid authenticated session.
   * Calls the callback with `true` if the session is valid (contains a
   * passport user), or `false` otherwise.
   */
  verifySession: (req: IncomingMessage, callback: (ok: boolean) => void) => void;
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

    sessionVerifier.verifySession(request, (ok) => {
      if (!ok) {
        log.warn({ ip: request.socket.remoteAddress }, 'WebSocket upgrade rejected — unauthenticated');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Session valid — perform the WebSocket upgrade
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const id = nextId++;
    clients.set(id, ws);
    log.debug({ clientId: id, total: clients.size, ip: req.socket.remoteAddress }, 'WebSocket connected');

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
  for (const [id, ws] of clients) {
    try { ws.close(); } catch { /* ignore */ }
    clients.delete(id);
  }
  _wss.close(() => {
    log.info('WebSocket server closed');
  });
  _wss = null;
}

/**
 * Broadcast an event to every connected WebSocket client.
 * Serialises the event as JSON with an automatic timestamp.
 */
export function broadcast(event: WsEvent): void {
  if (clients.size === 0) return;

  const message = JSON.stringify({
    ...event,
    timestamp: new Date().toISOString(),
  });

  for (const [id, ws] of clients) {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      } else {
        clients.delete(id); // clean up stale connections
      }
    } catch {
      clients.delete(id); // remove on send error
    }
  }
}
