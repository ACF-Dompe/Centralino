/**
 * WebSocket server for real-time event broadcasting.
 *
 * Usage:
 *   import { initWsServer, broadcast } from './ws.js';
 *   const server = http.createServer(app);
 *   initWsServer(server);
 *   // ... anywhere else in the app:
 *   broadcast({ type: 'guest:expired', data: { id, name } });
 *
 * The WebSocket endpoint is at `/ws`.
 * Messages are JSON: { type: string, data?: unknown, timestamp: string }
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'http';
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
 * Initialise the WebSocket server on top of an existing HTTP server.
 * Call once at startup.
 */
let _wss: WebSocketServer | null = null;

export function initWsServer(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/api/ws' });
  _wss = wss;

  wss.on('connection', (ws: WebSocket) => {
    const id = nextId++;
    clients.set(id, ws);
    log.debug({ clientId: id, total: clients.size }, 'WebSocket connected');

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
