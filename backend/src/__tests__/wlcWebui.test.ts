import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

interface MockResponseOpts {
  statusCode?: number;
  body?: string;
}

let mockResponse: MockResponseOpts = {};
let mockError: Error | null = null;
let mockTimeout = false;

vi.mock('node:https', () => ({
  default: {
    request: vi.fn((_options: unknown, callback: (res: any) => void) => {
      const emittedEvents: Record<string, Array<(...args: unknown[]) => void>> = {};

      const req = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (!emittedEvents[event]) emittedEvents[event] = [];
          emittedEvents[event]!.push(handler);
          return req;
        }),
        end: vi.fn(),
        destroy: vi.fn((err?: Error) => {
          // Simulate error event when destroyed with an error
          if (err && mockTimeout) {
            // During timeout, the destroy triggers the error handler in source code
            // but the `responded` flag prevents double-resolution
          }
        }),
      };

      // Schedule async response/error/timeout
      if (mockTimeout) {
        // Timeout simulation: only fire timeout, never response
        process.nextTick(() => {
          const timeoutHandlers = emittedEvents['timeout'] ?? [];
          for (const h of timeoutHandlers) h();
        });
      } else if (mockError) {
        // Error simulation: fire error, never response
        process.nextTick(() => {
          const errHandlers = emittedEvents['error'] ?? [];
          for (const h of errHandlers) h(mockError);
        });
      } else {
        // Normal response: schedule response callback
        process.nextTick(() => {
          const body = mockResponse.body ?? '';
          const res = {
            statusCode: mockResponse.statusCode ?? 200,
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
              if (event === 'data') {
                handler(Buffer.from(body));
              }
              if (event === 'end') {
                handler();
              }
              return res;
            }),
          };
          callback(res);
        });
      }

      return req;
    }),
  },
}));

vi.mock('../config.js', () => ({
  config: {
    wlc: {
      httpTimeoutMs: 10_000,
      tlsRejectUnauthorized: false,
    },
  },
}));

vi.mock('../logger.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Subject under test ─────────────────────────────────────────────────────

async function getLoginWebUi() {
  const mod = await import('../services/wlcWebui.js');
  return mod.loginWebUi;
}

const defaultInput = {
  host: '172.18.106.100',
  port: 443,
  username: 'admin_guest',
  password: 'test123',
};

describe('loginWebUi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponse = {};
    mockError = null;
    mockTimeout = false;
  });

  it('returns success when WLC responds 200 with dashboard content', async () => {
    mockResponse = { statusCode: 200, body: '<html><head><title>Dashboard</title></head></html>' };
    const loginWebUi = await getLoginWebUi();
    const result = await loginWebUi(defaultInput);
    expect(result).toMatchObject({ success: true, status: 200, authMethod: 'webui' });
  });

  it('returns failure when response contains login form (myloginform)', async () => {
    mockResponse = { statusCode: 200, body: '<html><head><title>myloginform</title></head></html>' };
    const loginWebUi = await getLoginWebUi();
    const result = await loginWebUi(defaultInput);
    expect(result).toMatchObject({ success: false, status: 200 });
  });

  it('returns failure when response contains "wrong" keyword', async () => {
    mockResponse = { statusCode: 200, body: '<html>wrong username or password</html>' };
    const loginWebUi = await getLoginWebUi();
    const result = await loginWebUi(defaultInput);
    expect(result).toMatchObject({ success: false, status: 200 });
  });

  it('returns failure on non-200 status code', async () => {
    mockResponse = { statusCode: 500, body: 'Internal Server Error' };
    const loginWebUi = await getLoginWebUi();
    const result = await loginWebUi(defaultInput);
    expect(result).toMatchObject({ success: false, status: 500 });
  });

  it('reports a refused connection as such, not as unreachable', async () => {
    // The old message called every request error "Host irraggiungibile",
    // which sent operators looking at firewalls and routing even when the
    // controller had answered. Each failure mode now names itself.
    mockError = new Error('ECONNREFUSED');
    const loginWebUi = await getLoginWebUi();
    const result = await loginWebUi(defaultInput);
    expect(result).toMatchObject({ success: false, isUnreachable: true });
    expect((result as any).error).toContain('Connessione rifiutata');
  });

  it('reports a genuinely unreachable host as unreachable', async () => {
    mockError = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const loginWebUi = await getLoginWebUi();
    const result = await loginWebUi(defaultInput);
    expect((result as any).error).toContain('irraggiungibile');
    expect((result as any).error).toContain('egress');
  });

  it('reports a rejected self-signed certificate as a TLS problem', async () => {
    // The real production case: a Catalyst 9800 presents a self-signed
    // certificate, so the controller answers and only verification fails.
    mockError = Object.assign(
      new Error('self-signed certificate in certificate chain'),
      { code: 'SELF_SIGNED_CERT_IN_CHAIN' },
    );
    const loginWebUi = await getLoginWebUi();
    const result = await loginWebUi(defaultInput);

    const error = (result as any).error as string;
    expect(error).toContain('Certificato TLS');
    expect(error).toContain('Il controller risponde');
    expect(error).toContain('WLC_TLS_REJECT_UNAUTHORIZED');
    // Must not blame the network.
    expect(error).not.toContain('irraggiungibile');
  });

  it('classifies a TLS error even when only the message carries the code', async () => {
    mockError = new Error('SELF_SIGNED_CERT_IN_CHAIN');
    const loginWebUi = await getLoginWebUi();
    const result = await loginWebUi(defaultInput);
    expect((result as any).error).toContain('Certificato TLS');
  });

  it('reports an expired certificate distinctly', async () => {
    mockError = Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' });
    const loginWebUi = await getLoginWebUi();
    const result = await loginWebUi(defaultInput);
    expect((result as any).error).toContain('scaduto');
  });

  it('reports an unresolvable hostname distinctly', async () => {
    mockError = Object.assign(new Error('getaddrinfo ENOTFOUND wlc'), { code: 'ENOTFOUND' });
    const loginWebUi = await getLoginWebUi();
    const result = await loginWebUi(defaultInput);
    expect((result as any).error).toContain('non risolto');
  });

  it('returns isUnreachable on timeout', async () => {
    mockTimeout = true;
    const loginWebUi = await getLoginWebUi();
    const result = await loginWebUi(defaultInput);
    expect(result).toMatchObject({ success: false, isUnreachable: true });
    expect((result as any).error).toContain('Timeout');
  });

  it('sends Basic auth header with base64-encoded credentials', async () => {
    mockResponse = { statusCode: 200, body: '<html>Dashboard</html>' };
    const { default: https } = await import('node:https');
    const requestMock = (https as any).request;

    const loginWebUi = await getLoginWebUi();
    await loginWebUi(defaultInput);

    const options = requestMock.mock.calls[0][0];
    expect(options.headers.Authorization).toBe('Basic YWRtaW5fZ3Vlc3Q6dGVzdDEyMw==');
  });

  it('uses default timeout from config when not specified', async () => {
    mockResponse = { statusCode: 200, body: '<html>Dashboard</html>' };
    const { default: https } = await import('node:https');
    const requestMock = (https as any).request;

    const loginWebUi = await getLoginWebUi();
    await loginWebUi(defaultInput);

    const options = requestMock.mock.calls[0][0];
    expect(options.timeout).toBe(10_000);
  });

  it('uses custom timeout when provided', async () => {
    mockResponse = { statusCode: 200, body: '<html>Dashboard</html>' };
    const { default: https } = await import('node:https');
    const requestMock = (https as any).request;

    const loginWebUi = await getLoginWebUi();
    await loginWebUi({ ...defaultInput, timeoutMs: 5_000 });

    const options = requestMock.mock.calls[0][0];
    expect(options.timeout).toBe(5_000);
  });

  it('sets rejectUnauthorized to false for self-signed WLC certs', async () => {
    mockResponse = { statusCode: 200, body: '<html>Dashboard</html>' };
    const { default: https } = await import('node:https');
    const requestMock = (https as any).request;

    const loginWebUi = await getLoginWebUi();
    await loginWebUi(defaultInput);

    const options = requestMock.mock.calls[0][0];
    expect(options.rejectUnauthorized).toBe(false);
  });

  it('hits /webui/index.html endpoint', async () => {
    mockResponse = { statusCode: 200, body: '<html>Dashboard</html>' };
    const { default: https } = await import('node:https');
    const requestMock = (https as any).request;

    const loginWebUi = await getLoginWebUi();
    await loginWebUi(defaultInput);

    const options = requestMock.mock.calls[0][0];
    expect(options.path).toBe('/webui/index.html');
    expect(options.method).toBe('GET');
  });
});
