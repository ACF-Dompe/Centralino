/**
 * WebSocket client that connects to the backend's `/api/ws` endpoint
 * and provides typed event callbacks with automatic reconnection.
 *
 * Usage:
 *   import { connectWs, useWsEvent } from '../api/ws';
 *
 *   // In a component:
 *   useEffect(() => {
 *     const ws = connectWs({
 *       onEvent: (event) => {
 *         if (event.type === 'guest:expired') {
 *           console.log('Guest expired:', event.data);
 *         }
 *       },
 *     });
 *     return () => ws.disconnect();
 *   }, []);
 */

export interface GuestEventData {
  id: string;
  name: string;
  username: string;
  sedeId?: number | null;
}

export interface GuestUpdatedEventData extends GuestEventData {
  status: string;
}

export type WsEvent =
  | { type: 'hello'; data: { server: string }; timestamp: string }
  | { type: 'guest:expired'; data: GuestEventData; timestamp: string }
  | { type: 'guest:created'; data: GuestEventData; timestamp: string }
  | { type: 'guest:updated'; data: GuestUpdatedEventData; timestamp: string }
  | { type: 'guest:deactivated'; data: GuestEventData; timestamp: string }
  | { type: 'guest:deleted'; data: GuestEventData; timestamp: string }
  | { type: 'guest:imported'; data: GuestEventData; timestamp: string }
  | { type: 'sync:completed'; data: { sedeId: number }; timestamp: string };

export interface WsOptions {
  /** Called for every incoming event. */
  onEvent: (event: WsEvent) => void;
  /** Called when the connection is (re-)established. */
  onConnect?: () => void;
  /** Called when the connection drops permanently. */
  onDisconnect?: () => void;
  /** Maximum reconnect attempts before giving up (default: 10). */
  maxRetries?: number;
  /** Initial reconnect delay in ms (default: 1000). Doubles each attempt. */
  baseDelayMs?: number;
}

export interface WsClient {
  disconnect: () => void;
  readyState: number;
}

/**
 * Open a WebSocket connection to the backend's `/api/ws` endpoint.
 * The URL is derived from `window.location` so it works in both dev (Vite proxy)
 * and prod (same origin).
 *
 * The endpoint is under `/api/` so the Application Gateway routing
 * `/api/* → backend` works correctly for WebSocket upgrades too.
 * Authentication is handled by the session cookie (same as REST API).
 */
export function connectWs(options: WsOptions): WsClient {
  const { onEvent, onConnect, onDisconnect, maxRetries = 10, baseDelayMs = 1000 } = options;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/api/ws`;

  let ws: WebSocket | null = null;
  let retryCount = 0;
  let retryTimer: number | null = null;
  let destroyed = false;

  function connect(): void {
    if (destroyed) return;

    ws = new WebSocket(url);

    ws.onopen = () => {
      retryCount = 0;
      onConnect?.();
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as WsEvent;
        onEvent(parsed);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      ws = null;
      if (destroyed) return;
      if (retryCount < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, retryCount);
        retryCount++;
        retryTimer = window.setTimeout(connect, delay);
      } else {
        onDisconnect?.();
      }
    };

    ws.onerror = () => {
      // The `onclose` handler will fire after this, so reconnection is handled there.
    };
  }

  connect();

  return {
    disconnect: () => {
      destroyed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (ws) {
        ws.onclose = null; // prevent reconnect
        ws.close();
        ws = null;
      }
    },
    get readyState() {
      return ws?.readyState ?? WebSocket.CLOSED;
    },
  };
}
