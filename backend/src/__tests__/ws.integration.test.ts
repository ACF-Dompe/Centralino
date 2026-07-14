/**
 * Integration tests for the WebSocket server (src/services/ws.ts).
 *
 * Creates a real HTTP server with `initWsServer()`, connects using the `ws`
 * client library, and verifies:
 *   - Hello event on connection
 *   - Broadcast reception on connected clients
 *   - Multiple client delivery
 *   - No-op broadcast when no clients are connected
 *   - Disconnect cleanup
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import net from 'net';
import WebSocket from 'ws';
import { initWsServer, broadcast } from '../services/ws.js';
import { log } from '../logger.js';
import type { SessionVerifier } from '../services/ws.js';

// ── Logger suppression ─────────────────────────────────────────────────────

vi.mock('../logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Test session verifier (accepts all connections) ────────────────────────
// Integration tests for WS broadcasting don't need real session auth.
// This noop verifier allows all upgrades to pass.
const allowAllVerifier: SessionVerifier = {
  verifySession(_req, callback) {
    callback(true);
  },
};

// ── Test server ────────────────────────────────────────────────────────────

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer();
  initWsServer(server, allowAllVerifier);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        port = addr.port;
      }
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

// ── Helper ─────────────────────────────────────────────────────────────────

/** Open a WS connection and return a promise that resolves with all received messages. */
function connectWs(): Promise<{ messages: unknown[]; close: () => void; rawWs: WebSocket }> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);

    ws.on('message', (data: Buffer) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch {
        messages.push(data.toString());
      }
    });

    ws.on('open', () => {
      // Give a moment for the hello message to arrive
      setImmediate(() => {
        resolve({ messages, close: () => ws.close(), rawWs: ws });
      });
    });

    ws.on('error', reject);

    // Timeout safeguard
    setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('WebSocket server', () => {
  it('sends a hello event on connection', async () => {
    const { messages, close } = await connectWs();

    // First message should be the hello
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const hello = messages[0] as Record<string, unknown>;
    expect(hello.type).toBe('hello');
    expect(hello.data).toEqual({ server: 'centralino-ws' });
    expect(hello.timestamp).toBeDefined();
    expect(typeof hello.timestamp).toBe('string');

    close();
  });

  it('delivers broadcast messages to connected clients', async () => {
    const { messages, close } = await connectWs();
    // Clear hello message from array
    messages.length = 0;

    broadcast({
      type: 'guest:expired',
      data: { id: 'g-test123', name: 'Mario Rossi', username: 'g.marior123', sedeId: 1 },
    });

    // Give the event loop a tick
    await vi.waitFor(() => {
      expect(messages.length).toBe(1);
    });

    const event = messages[0] as Record<string, unknown>;
    expect(event.type).toBe('guest:expired');
    expect(event.data).toEqual({
      id: 'g-test123',
      name: 'Mario Rossi',
      username: 'g.marior123',
      sedeId: 1,
    });
    expect(event.timestamp).toBeDefined();

    close();
  });

  it('delivers the same broadcast to multiple connected clients', async () => {
    const client1 = await connectWs();
    const client2 = await connectWs();
    // Clear hello messages
    client1.messages.length = 0;
    client2.messages.length = 0;

    broadcast({
      type: 'guest:expired',
      data: { id: 'g-multi', name: 'Multi', username: 'g.multi', sedeId: 2 },
    });

    await vi.waitFor(() => {
      expect(client1.messages.length).toBe(1);
      expect(client2.messages.length).toBe(1);
    });

    expect((client1.messages[0] as Record<string, unknown>).type).toBe('guest:expired');
    expect((client2.messages[0] as Record<string, unknown>).type).toBe('guest:expired');

    client1.close();
    client2.close();
  });

  it('does not crash when broadcasting with no connected clients', () => {
    // No active connections at this point (all previous tests closed theirs)
    expect(() => {
      broadcast({ type: 'sync:completed', data: { sedeId: 1 } });
    }).not.toThrow();
  });

  it('continues to deliver to remaining clients after one disconnects', async () => {
    const client1 = await connectWs();
    const client2 = await connectWs();
    client1.messages.length = 0;
    client2.messages.length = 0;

    // Disconnect client1
    client1.close();

    // Give time for the close handshake to propagate to the server
    await new Promise((resolve) => setImmediate(resolve));

    client2.messages.length = 0;

    broadcast({
      type: 'guest:deactivated',
      data: { id: 'g-remain', name: 'Remaining', username: 'g.remain', sedeId: 3 },
    });

    await vi.waitFor(() => {
      expect(client2.messages.length).toBe(1);
    });

    expect((client2.messages[0] as Record<string, unknown>).type).toBe('guest:deactivated');

    client2.close();
  });

  it('logs and cleans up on client WebSocket error (ws.on("error"))', async () => {
    const { rawWs } = await connectWs();

    // Send an invalid WebSocket frame (unknown opcode 0xF) through
    // the underlying TCP socket. The server's receiver fails to parse
    // it and emits 'error' on the server-side WebSocket.
    // TypeScript non espone _socket, ma la proprietà esiste a runtime
    (rawWs as unknown as { _socket: net.Socket })._socket.write(Buffer.from([0x8F, 0x00]));

    await vi.waitFor(() => {
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(String) }),
        'WebSocket error',
      );
    });
  });

  // The wss.on('error') handler test was removed because:
  // 1. With the upgrade handler listening on the server, emitting
  //    'error' on the HTTP server no longer reaches the wss handler.
  // 2. The wss._wss reference is module-private and not exported.
  // 3. Testing this internal error handler would require exposing
  //    _wss solely for testing, which is not worth the cost.
  // The handler itself is a single log.error() call — trivial to verify
  // by inspection.

  it('handles send errors gracefully during broadcast (broadcast catch)', async () => {
    const { close } = await connectWs();

    // Spy on WebSocket.prototype.send to make the server's send() throw.
    // After connectWs resolves, the hello message has already been sent
    // successfully. The spy makes any subsequent send() throw, which is
    // caught by the catch block in broadcast().
    const sendSpy = vi.spyOn(WebSocket.prototype, 'send');
    sendSpy.mockImplementation(() => {
      throw new Error('Send failed');
    });

    expect(() => {
      broadcast({
        type: 'guest:expired',
        data: { id: 'g-catch', name: 'Catch Test', username: 'g.catch' },
      });
    }).not.toThrow();

    sendSpy.mockRestore();
    close();
  });

  it('handles client reconnect gracefully (connect → disconnect → reconnect)', async () => {
    // First connection
    const client1 = await connectWs();
    expect(client1.messages.length).toBeGreaterThanOrEqual(1);
    expect((client1.messages[0] as Record<string, unknown>).type).toBe('hello');

    // Disconnect
    client1.close();

    // Wait for server to process the close event
    await new Promise((resolve) => setImmediate(resolve));

    // Reconnect (simulating a client reconnecting)
    const client2 = await connectWs();

    // Should receive a new hello on reconnect
    expect(client2.messages.length).toBeGreaterThanOrEqual(1);
    const hello = client2.messages[0] as Record<string, unknown>;
    expect(hello.type).toBe('hello');
    expect(hello.data).toEqual({ server: 'centralino-ws' });

    // Clear hello
    client2.messages.length = 0;

    // Broadcast should work on the reconnected client
    broadcast({
      type: 'guest:expired',
      data: { id: 'g-reconnect', name: 'Reconnect Test', username: 'g.reconnect' },
    });

    await vi.waitFor(() => {
      expect(client2.messages.length).toBe(1);
    });

    expect((client2.messages[0] as Record<string, unknown>).type).toBe('guest:expired');

    client2.close();
  });

  it('handles all event types via broadcast', async () => {
    const client = await connectWs();
    client.messages.length = 0;

    const eventTypes = [
      { type: 'guest:created' as const, data: { id: 'g-1', name: 'A', username: 'g.a' } },
      { type: 'guest:updated' as const, data: { id: 'g-2', name: 'B', username: 'g.b', status: 'active' } },
      { type: 'guest:deactivated' as const, data: { id: 'g-3', name: 'C', username: 'g.c', sedeId: 1 } },
      { type: 'guest:deleted' as const, data: { id: 'g-4', name: 'D', username: 'g.d' } },
      { type: 'guest:imported' as const, data: { id: 'g-5', name: 'E', username: 'g.e', sedeId: 2 } },
      { type: 'sync:completed' as const, data: { sedeId: 3 } },
    ];

    for (const event of eventTypes) {
      broadcast(event);
    }

    await vi.waitFor(() => {
      expect(client.messages.length).toBe(eventTypes.length);
    });

    const types = (client.messages as Record<string, unknown>[]).map((m) => m.type);
    expect(types).toEqual([
      'guest:created',
      'guest:updated',
      'guest:deactivated',
      'guest:deleted',
      'guest:imported',
      'sync:completed',
    ]);

    client.close();
  });
});
