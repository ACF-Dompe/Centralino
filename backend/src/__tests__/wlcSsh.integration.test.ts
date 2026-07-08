/**
 * Integration tests for execSsh (WLC SSH service).
 *
 * Mocks the `ssh2` Client at the library level to simulate:
 *   - Connection ready / shell open / command output
 *   - Error patterns in output (invalid input, access denied, etc.)
 *   - SSH connection errors
 *   - Shell errors
 *   - Timeout
 *   - Keyboard-interactive authentication
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSsh } from '../services/wlcSsh.js';

// ── Mock ssh2 Client ───────────────────────────────────────────────────────
// We create a single mockClient instance; the factory returns it every time.

const mockClient = {
  on: vi.fn(),
  connect: vi.fn(),
  shell: vi.fn(),
  end: vi.fn(),
};

vi.mock('ssh2', () => ({
  Client: vi.fn(function () { return mockClient; }),
}));

// ── Config mock ────────────────────────────────────────────────────────────

vi.mock('../config.js', () => ({
  config: {
    wlc: {
      sshTimeoutMs: 60000,
    },
  },
}));

// ── Logger suppression ─────────────────────────────────────────────────────

vi.mock('../logger.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

interface EventHandlers {
  ready: () => void;
  error: (err: Error) => void;
  'keyboard-interactive': (
    name: string, instructions: string,
    instructionsLang: string, prompts: { prompt: string; echo: boolean }[],
    finish: (responses: string[]) => void,
  ) => void;
}

interface StreamHandlers {
  data: (data: Buffer) => void;
  close: () => void;
}

/**
 * Capture event callbacks from mockClient.on() calls.
 */
function captureClientEvents(): EventHandlers {
  const handlers: Record<string, Function> = {};
  mockClient.on.mockImplementation(
    (event: string, cb: (...args: unknown[]) => void) => {
      handlers[event] = cb;
      return mockClient;
    },
  );
  return handlers as unknown as EventHandlers;
}

/**
 * Create a mock shell stream with captured data/close handlers.
 */
function createMockStream(): { stream: Record<string, ReturnType<typeof vi.fn>>; handlers: StreamHandlers } {
  const handlers: Record<string, Function> = {};
  const stream: Record<string, ReturnType<typeof vi.fn>> = {
    on: vi.fn(),
    write: vi.fn(),
  };
  stream.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
    handlers[event] = cb;
    return stream;
  });
  return { stream, handlers: handlers as unknown as StreamHandlers };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('execSsh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Success path ───────────────────────────────────────────────────────

  describe('successful execution', () => {
    it('connects via SSH, runs commands, and returns output on success', async () => {
      const events = captureClientEvents();
      const { stream, handlers: streamEvents } = createMockStream();

      const promise = execSsh({
        host: '172.18.106.100',
        username: 'admin_guest',
        password: 'secret',
        commands: ['show clock'],
      });

      // 1. Trigger SSH ready
      events.ready();

      // 2. Shell was requested
      expect(mockClient.shell).toHaveBeenCalledWith(
        expect.objectContaining({ term: 'vt100', cols: 240, rows: 2000 }),
        expect.any(Function),
      );

      // 3. Resolve shell callback with our mock stream
      const shellCb = mockClient.shell.mock.calls[0][1];
      shellCb(null, stream);

      // 4. Advance past initial delay (1200ms) — sendNext writes first command
      await vi.advanceTimersByTimeAsync(1200);
      expect(stream.write).toHaveBeenCalledWith('show clock\n');

      // 5. Simulate command output
      streamEvents.data(Buffer.from('14:30:00 UTC Mon Jul 1 2026\r\n'));

      // 6. Advance past per-command delay (800ms) — sendNext runs again
      await vi.advanceTimersByTimeAsync(800);
      // cmdIndex >= len now — exit sequence is SCHEDULED (800ms timer set)

      // 7. Advance 800ms more — exit is written
      await vi.advanceTimersByTimeAsync(800);
      expect(stream.write).toHaveBeenCalledWith('exit\n');

      // 8. Advance past exit resolve delay (800ms) — safeResolve is called
      await vi.advanceTimersByTimeAsync(800);

      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.output).toContain('show clock');
      expect(result.output).toContain('14:30:00');
      expect(result.output).toContain('>>>'); // command prefix
      expect(mockClient.end).toHaveBeenCalled();
    });

    it('runs multiple commands in sequence', async () => {
      const events = captureClientEvents();
      const { stream, handlers: streamEvents } = createMockStream();

      const promise = execSsh({
        host: '172.18.106.100',
        username: 'admin_guest',
        password: 'secret',
        commands: ['show clock', 'show version'],
      });

      events.ready();
      const shellCb = mockClient.shell.mock.calls[0][1];
      shellCb(null, stream);

      // Initial delay → first command
      await vi.advanceTimersByTimeAsync(1200);
      expect(stream.write).toHaveBeenCalledWith('show clock\n');

      // Command delay → second command
      await vi.advanceTimersByTimeAsync(800);
      expect(stream.write).toHaveBeenCalledWith('show version\n');

      // Command delay → sendNext exits (schedules exit write)
      await vi.advanceTimersByTimeAsync(800);

      // Advance 800ms more — exit is written
      await vi.advanceTimersByTimeAsync(800);
      expect(stream.write).toHaveBeenCalledWith('exit\n');

      // Exit delay → resolve
      await vi.advanceTimersByTimeAsync(800);
      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.output).toContain('show clock');
      expect(result.output).toContain('show version');
    });

    it('resolves on stream close event', async () => {
      const events = captureClientEvents();
      const { stream, handlers: streamEvents } = createMockStream();

      const promise = execSsh({
        host: '172.18.106.100',
        username: 'admin_guest',
        password: 'secret',
        commands: ['show clock'],
      });

      events.ready();
      const shellCb = mockClient.shell.mock.calls[0][1];
      shellCb(null, stream);

      // Advance past initial delay
      await vi.advanceTimersByTimeAsync(1200);

      // Stream closes instead of normal exit sequence
      streamEvents.close();

      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.output).toContain('show clock');
    });

    it('accepts custom delays and timeout', async () => {
      const events = captureClientEvents();
      const { stream, handlers: streamEvents } = createMockStream();

      const promise = execSsh({
        host: '10.0.0.1',
        username: 'admin',
        password: 'pass',
        commands: ['who'],
        initialDelayMs: 500,
        perCommandDelayMs: 300,
        timeoutMs: 10000,
      });

      events.ready();
      const shellCb = mockClient.shell.mock.calls[0][1];
      shellCb(null, stream);

      // Advance custom initial delay
      await vi.advanceTimersByTimeAsync(500);
      expect(stream.write).toHaveBeenCalledWith('who\n');

      // Advance custom command delay → sendNext exits (schedules exit write)
      await vi.advanceTimersByTimeAsync(300);

      // Advance 300ms more — exit is written
      await vi.advanceTimersByTimeAsync(300);
      expect(stream.write).toHaveBeenCalledWith('exit\n');

      await vi.advanceTimersByTimeAsync(800);
      const result = await promise;
      expect(result.success).toBe(true);
    });
  });

  // ── Error patterns ─────────────────────────────────────────────────────

  describe('error pattern detection', () => {
    const errorPatternCommands = ['configure terminal', 'username test'];

    it.each([
      ['% Invalid input detected at', '% Invalid input detected'],
      ['% Access denied', '% Access denied'],
      ['% Incomplete command', '% Incomplete command'],
      ['% Unauthorized', '% Unauthorized'],
      ['% Error: something', '% Error'],
    ])('detects "%s" and returns error', async (outputLine, expectedPattern) => {
      const events = captureClientEvents();
      const { stream, handlers: streamEvents } = createMockStream();

      const promise = execSsh({
        host: '172.18.106.100',
        username: 'admin_guest',
        password: 'secret',
        commands: errorPatternCommands,
      });

      events.ready();
      const shellCb = mockClient.shell.mock.calls[0][1];
      shellCb(null, stream);

      await vi.advanceTimersByTimeAsync(1200); // first command

      // Send output with error pattern
      streamEvents.data(Buffer.from(`\n${outputLine} 'test'\r\n`));

      expect(mockClient.end).toHaveBeenCalled();
      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Comando respinto');
      expect(result.error).toContain(expectedPattern);
      expect(result.errorPattern).toBe(expectedPattern);
    });

    it('detects error pattern across multiple data chunks', async () => {
      const events = captureClientEvents();
      const { stream, handlers: streamEvents } = createMockStream();

      const promise = execSsh({
        host: '172.18.106.100',
        username: 'admin_guest',
        password: 'secret',
        commands: ['configure terminal'],
      });

      events.ready();
      const shellCb = mockClient.shell.mock.calls[0][1];
      shellCb(null, stream);

      await vi.advanceTimersByTimeAsync(1200);

      // Send data in chunks — the pattern spans the buffer
      streamEvents.data(Buffer.from('% Invalid input '));
      streamEvents.data(Buffer.from('detected at'));
      streamEvents.data(Buffer.from(" 'test' point\r\n"));

      const result = await promise;
      expect(result.success).toBe(false);
      // Regex matches only "% Invalid input detected" (no " at")
      expect(result.error).toContain('% Invalid input detected');
      expect(result.errorPattern).toBe('% Invalid input detected');
    });
  });

  // ── Connection / shell errors ──────────────────────────────────────────

  describe('connection and shell errors', () => {
    it('returns SSH error when connection fails', async () => {
      const events = captureClientEvents();

      const promise = execSsh({
        host: '10.0.0.1',
        username: 'admin',
        password: 'wrong',
        commands: ['show clock'],
      });

      events.error(new Error('connect ECONNREFUSED 10.0.0.1:22'));

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('returns shell error when shell() callback fails', async () => {
      const events = captureClientEvents();
      const { stream } = createMockStream();

      const promise = execSsh({
        host: '172.18.106.100',
        username: 'admin_guest',
        password: 'secret',
        commands: ['show clock'],
      });

      events.ready();
      const shellCb = mockClient.shell.mock.calls[0][1];
      shellCb(new Error('Shell failed: unable to open pty'), stream);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Shell failed');
    });
  });

  // ── Timeout ─────────────────────────────────────────────────────────────

  describe('timeout', () => {
    it('times out when SSH does not respond within timeoutMs', async () => {
      const events = captureClientEvents();

      const promise = execSsh({
        host: '172.18.106.100',
        username: 'admin_guest',
        password: 'secret',
        commands: ['show clock'],
        timeoutMs: 5000,
      });

      // Never trigger 'ready' — connection hangs
      await vi.advanceTimersByTimeAsync(5000);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('SSH timeout');
      expect(result.error).toContain('5000ms');
    });

    it('uses config.wlc.sshTimeoutMs as default timeout', async () => {
      const events = captureClientEvents();

      const promise = execSsh({
        host: '172.18.106.100',
        username: 'admin_guest',
        password: 'secret',
        commands: ['show clock'],
      });

      // Default is 60000 from config mock
      await vi.advanceTimersByTimeAsync(60000);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('60000ms');
    });
  });

  // ── Keyboard-interactive auth ──────────────────────────────────────────

  describe('keyboard-interactive authentication', () => {
    it('responds to keyboard-interactive prompts with the password', async () => {
      const events = captureClientEvents();
      const { stream } = createMockStream();

      const promise = execSsh({
        host: '172.18.106.100',
        username: 'admin_guest',
        password: 'my-secret-pass',
        commands: ['show clock'],
      });

      // Simulate keyboard-interactive auth
      const finishFn = vi.fn();
      events['keyboard-interactive'](
        '', '', '',
        [{ prompt: 'Password: ', echo: false }],
        finishFn,
      );

      expect(finishFn).toHaveBeenCalledWith(['my-secret-pass']);

      // Then trigger ready and proceed with normal flow
      events.ready();
      const shellCb = mockClient.shell.mock.calls[0][1];
      shellCb(null, stream);

      // Advance through all timer stages: init → cmd → exit → resolve
      await vi.advanceTimersByTimeAsync(1200);
      await vi.advanceTimersByTimeAsync(800);
      await vi.advanceTimersByTimeAsync(800);
      await vi.advanceTimersByTimeAsync(800);

      const result = await promise;
      expect(result.success).toBe(true);
    });

    it('responds to multiple keyboard-interactive prompts', async () => {
      const events = captureClientEvents();

      const promise = execSsh({
        host: '172.18.106.100',
        username: 'admin_guest',
        password: 'my-secret-pass',
        commands: ['show clock'],
      });

      const finishFn = vi.fn();
      events['keyboard-interactive'](
        '', '', '',
        [
          { prompt: 'Password: ', echo: false },
          { prompt: 'Domain: ', echo: true },
        ],
        finishFn,
      );

      expect(finishFn).toHaveBeenCalledWith(['my-secret-pass', 'my-secret-pass']);
    });
  });

  // ── Safe resolve (no double-settle) ─────────────────────────────────────

  describe('safeResolve (no double-settle)', () => {
    it('does not settle twice when multiple terminal events fire', async () => {
      const events = captureClientEvents();
      const { stream, handlers: streamEvents } = createMockStream();

      const promise = execSsh({
        host: '172.18.106.100',
        username: 'admin_guest',
        password: 'secret',
        commands: ['show clock'],
      });

      events.ready();
      const shellCb = mockClient.shell.mock.calls[0][1];
      shellCb(null, stream);

      await vi.advanceTimersByTimeAsync(1200);

      // Fire close event
      streamEvents.close();

      // Advance time past any pending timeouts
      await vi.advanceTimersByTimeAsync(10000);

      const result = await promise;
      // Should only settle once with success since close fired
      expect(result.success).toBe(true);
    });
  });
});
