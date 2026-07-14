/**
 * Unit tests for connectWs (frontend/src/api/ws.ts).
 *
 * Uses a mock WebSocket to simulate connection events (open, close, message)
 * and vi.useFakeTimers() to control setTimeout for reconnection timing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connectWs } from '../api/ws';

// ── Mock WebSocket ─────────────────────────────────────────────────────────
// We replace the global WebSocket with a controllable mock so we can
// simulate open / close / message events without a real server.

let currentMockWs: MockWebSocket | null = null;
let wsConstructCount = 0;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number = MockWebSocket.CONNECTING;
  url: string;
  onopen: ((event?: Record<string, unknown>) => void) | null = null;
  onclose: ((event?: Record<string, unknown>) => void) | null = null;
  onerror: ((event?: Record<string, unknown>) => void) | null = null;
  onmessage: ((event?: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    currentMockWs = this;
    wsConstructCount++;
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }
}

/** Simulate the WebSocket opening on the current mock instance. */
function openWs(): void {
  if (!currentMockWs) throw new Error('No WebSocket instance');
  currentMockWs.readyState = MockWebSocket.OPEN;
  currentMockWs.onopen?.();
}

/** Simulate the WebSocket closing on the current mock instance. */
function closeWs(): void {
  if (!currentMockWs) throw new Error('No WebSocket instance');
  currentMockWs.readyState = MockWebSocket.CLOSED;
  currentMockWs.onclose?.();
}

/** Simulate receiving a message on the current mock instance. */
function messageWs(data: string): void {
  if (!currentMockWs) throw new Error('No WebSocket instance');
  currentMockWs.onmessage?.({ data });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('connectWs', () => {
  beforeEach(() => {
    currentMockWs = null;
    wsConstructCount = 0;
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ── Basic connection ───────────────────────────────────────────────────

  it('creates a WebSocket connection to the correct URL', () => {
    const client = connectWs({ onEvent: vi.fn() });

    expect(wsConstructCount).toBe(1);
    expect(currentMockWs).not.toBeNull();
    expect(currentMockWs!.url).toMatch(/^wss?:\/\/.+\/api\/ws$/);

    client.disconnect();
  });

  it('calls onConnect when the connection opens', () => {
    const onConnect = vi.fn();
    connectWs({ onEvent: vi.fn(), onConnect });

    openWs();

    expect(onConnect).toHaveBeenCalledOnce();
  });

  it('delivers parsed JSON messages via onEvent', () => {
    const onEvent = vi.fn();
    connectWs({ onEvent });
    openWs();

    messageWs(JSON.stringify({ type: 'hello', data: { server: 'test' }, timestamp: '2025-01-01T00:00:00Z' }));

    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith({
      type: 'hello',
      data: { server: 'test' },
      timestamp: '2025-01-01T00:00:00Z',
    });
  });

  it('handles malformed JSON messages without throwing', () => {
    const onEvent = vi.fn();
    connectWs({ onEvent });
    openWs();

    expect(() => {
      messageWs('not valid json');
    }).not.toThrow();

    expect(onEvent).not.toHaveBeenCalled();
  });

  // ── Reconnection ───────────────────────────────────────────────────────

  it('reconnects on close with exponential backoff', () => {
    connectWs({ onEvent: vi.fn(), maxRetries: 5, baseDelayMs: 100 });

    // First close: retryCount = 0 → delay = 100ms
    closeWs();
    expect(wsConstructCount).toBe(1); // not yet reconnected

    vi.advanceTimersByTime(100);
    expect(wsConstructCount).toBe(2); // first reconnect

    // Second close (without open): retryCount = 1 → delay = 200ms
    closeWs();
    vi.advanceTimersByTime(199);
    expect(wsConstructCount).toBe(2); // not yet

    vi.advanceTimersByTime(1);
    expect(wsConstructCount).toBe(3); // second reconnect (200ms)

    // Third close: retryCount = 2 → delay = 400ms
    closeWs();
    vi.advanceTimersByTime(400);
    expect(wsConstructCount).toBe(4); // third reconnect (400ms)
  });

  it('resets retryCount on successful open after reconnect', () => {
    const onConnect = vi.fn();
    connectWs({ onEvent: vi.fn(), onConnect, maxRetries: 5, baseDelayMs: 100 });

    openWs(); // first open → retryCount = 0
    expect(onConnect).toHaveBeenCalledTimes(1);

    closeWs(); // reconnect after 100ms
    vi.advanceTimersByTime(100);

    openWs(); // second open → retryCount resets to 0
    expect(onConnect).toHaveBeenCalledTimes(2);

    // Close again — should start from 100ms, not 200ms
    closeWs();
    vi.advanceTimersByTime(100);
    expect(wsConstructCount).toBe(3); // reconnected with base delay, not exponential
  });

  it('calls onDisconnect after maxRetries and stops reconnecting', () => {
    const onDisconnect = vi.fn();
    connectWs({
      onEvent: vi.fn(),
      onDisconnect,
      maxRetries: 3,
      baseDelayMs: 10,
    });

    // Simulate 3 failed reconnection attempts (no openWs called)
    // Each close increments retryCount and schedules a reconnect

    // Initial close: retryCount 0 < 3 → schedule 10ms
    closeWs();
    vi.advanceTimersByTime(10);
    expect(wsConstructCount).toBe(2);

    // 1st retry fails: retryCount 1 < 3 → schedule 20ms
    closeWs();
    vi.advanceTimersByTime(20);
    expect(wsConstructCount).toBe(3);

    // 2nd retry fails: retryCount 2 < 3 → schedule 40ms
    closeWs();
    vi.advanceTimersByTime(40);
    expect(wsConstructCount).toBe(4);

    // 3rd retry fails: retryCount 3 is NOT < 3 → onDisconnect!
    closeWs();
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(wsConstructCount).toBe(4); // no new connection created
  });

  it('does not call onDisconnect if connection succeeds on last retry', () => {
    const onDisconnect = vi.fn();
    const onConnect = vi.fn();
    connectWs({
      onEvent: vi.fn(),
      onDisconnect,
      onConnect,
      maxRetries: 3,
      baseDelayMs: 10,
    });

    // 2 failed retries: retryCount = 0 → 1 → 2
    closeWs();
    vi.advanceTimersByTime(10); // 2nd ws created
    closeWs();
    vi.advanceTimersByTime(20); // 3rd ws created

    // 3rd attempt succeeds → retryCount reset to 0
    openWs();
    expect(onConnect).toHaveBeenCalled();

    // Close after success starts a fresh retry cycle (not onDisconnect)
    closeWs();
    vi.advanceTimersByTime(10); // 4th ws created
    expect(wsConstructCount).toBe(4);

    expect(onDisconnect).not.toHaveBeenCalled();
  });

  // ── disconnect() ───────────────────────────────────────────────────────

  it('disconnect() prevents reconnection', () => {
    const onConnect = vi.fn();
    const client = connectWs({
      onEvent: vi.fn(),
      onConnect,
      maxRetries: 10,
      baseDelayMs: 100,
    });

    openWs();
    expect(onConnect).toHaveBeenCalledOnce();

    // Disconnect — should set destroyed, clear timer, nullify handlers
    client.disconnect();

    // Simulate close after disconnect — should not reconnect
    if (currentMockWs) {
      currentMockWs.onclose = null; // disconnect sets this to null
    }

    // Advance time well past any potential reconnect
    vi.advanceTimersByTime(10000);

    expect(wsConstructCount).toBe(1); // no new connections
  });

  it('disconnect() clears the retry timer', () => {
    const client = connectWs({ onEvent: vi.fn(), maxRetries: 10, baseDelayMs: 100 });

    closeWs(); // schedule reconnect after 100ms

    // Disconnect before the timer fires
    client.disconnect();

    // Advance past the scheduled time
    vi.advanceTimersByTime(200);

    expect(wsConstructCount).toBe(1); // no reconnect
  });

  // ── Error handling ─────────────────────────────────────────────────────

  it('does not crash when onerror fires', () => {
    connectWs({ onEvent: vi.fn() });

    expect(() => {
      if (currentMockWs) currentMockWs.onerror?.();
    }).not.toThrow();
  });

  it('delivers messages received before close after disconnect', () => {
    const onEvent = vi.fn();
    const client = connectWs({ onEvent });
    openWs();

    // disconnect nullifies onclose but NOT onmessage,
    // so in-flight messages are still delivered
    client.disconnect();
    messageWs(JSON.stringify({ type: 'hello', data: { server: 'test' } }));

    expect(onEvent).toHaveBeenCalledOnce();
  });

  // ── readyState ─────────────────────────────────────────────────────────

  it('returns the connection readyState', () => {
    const client = connectWs({ onEvent: vi.fn() });

    expect(client.readyState).toBe(MockWebSocket.CONNECTING);

    openWs();
    expect(client.readyState).toBe(MockWebSocket.OPEN);

    client.disconnect();
  });
});
