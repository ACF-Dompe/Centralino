/**
 * Tests for WLC SSH host key verification (`services/wlcSsh.ts`).
 *
 * Verification is opt-in via `WLC_SSH_VERIFY_HOST_KEY` and **off by default**:
 * a deliberate operational decision, recorded in COMPLIANCE.md. The five
 * controllers have five different host keys while the expected value is a
 * single one, so enabling it today would let at most one sede connect and fail
 * the other four closed.
 *
 * What these tests pin down is that the choice stays explicit and visible:
 *   - off by default, and announced in the logs (once, not per connection)
 *   - no `hostVerifier` installed when off, so ssh2 does not verify anything
 *   - fail-closed when verification is asked for but no key is configured
 *   - a mismatching key rejected when it is configured
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = vi.hoisted(() => ({
  on: vi.fn(),
  connect: vi.fn(),
  shell: vi.fn(),
  end: vi.fn(),
}));

vi.mock('ssh2', () => ({
  Client: vi.fn(function () { return mockClient; }),
}));

const mockConfig = vi.hoisted(() => ({
  config: {
    nodeEnv: 'production',
    wlc: {
      sshTimeoutMs: 1000,
      sshVerifyHostKey: false,
      sshHostKey: '',
    },
  },
}));
vi.mock('../config.js', () => mockConfig);

const mockLog = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));
vi.mock('../logger.js', () => ({ log: mockLog }));

const INPUT = {
  host: '172.18.106.100',
  username: 'admin_guest',
  password: 'secret',
  commands: ['show version'],
};

/** Fresh module registry, so the once-only warning flag is reset per test. */
async function loadExecSsh() {
  vi.resetModules();
  return (await import('../services/wlcSsh.js')).execSsh;
}

/** The ConnectConfig handed to ssh2. */
function connectConfig(): Record<string, unknown> {
  return mockClient.connect.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.config.nodeEnv = 'production';
  mockConfig.config.wlc.sshVerifyHostKey = false;
  mockConfig.config.wlc.sshHostKey = '';
  // Never reach 'ready': these tests only care about the pre-connect decision.
  mockClient.on.mockImplementation(() => mockClient);
});

describe('verification disabled (the default)', () => {
  it('connects without installing a hostVerifier', async () => {
    const execSsh = await loadExecSsh();
    void execSsh(INPUT);

    expect(mockClient.connect).toHaveBeenCalled();
    expect(connectConfig().hostVerifier).toBeUndefined();
  });

  it('connects even in production, where it used to fail closed', async () => {
    const execSsh = await loadExecSsh();
    void execSsh(INPUT);
    expect(mockClient.connect).toHaveBeenCalled();
  });

  it('announces the unverified state in the logs', async () => {
    const execSsh = await loadExecSsh();
    void execSsh(INPUT);

    const warned = mockLog.warn.mock.calls.some(([, msg]) =>
      String(msg).includes('host key verification is DISABLED'),
    );
    expect(warned).toBe(true);
  });

  it('logs that warning only once, not on every connection', async () => {
    // The background sync runs every 30s per sede; a per-connection warning
    // would bury the logs.
    const execSsh = await loadExecSsh();
    void execSsh(INPUT);
    void execSsh(INPUT);
    void execSsh(INPUT);

    const warnings = mockLog.warn.mock.calls.filter(([, msg]) =>
      String(msg).includes('host key verification is DISABLED'),
    );
    expect(warnings).toHaveLength(1);
  });

  it('ignores a stale WLC_SSH_HOST_KEY while disabled', async () => {
    mockConfig.config.wlc.sshHostKey = 'AAAAB3NzaC1yc2EAAAA-stale';
    const execSsh = await loadExecSsh();
    void execSsh(INPUT);

    expect(connectConfig().hostVerifier).toBeUndefined();
  });
});

describe('verification enabled', () => {
  it('refuses to connect when no expected key is configured', async () => {
    mockConfig.config.wlc.sshVerifyHostKey = true;
    mockConfig.config.wlc.sshHostKey = '';

    const execSsh = await loadExecSsh();
    const res = await execSsh(INPUT);

    expect(res.success).toBe(false);
    expect(res.error).toContain('no expected key is configured');
    expect(mockClient.connect).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('installs a hostVerifier when a key is configured', async () => {
    mockConfig.config.wlc.sshVerifyHostKey = true;
    mockConfig.config.wlc.sshHostKey = Buffer.from('expected-key').toString('base64');

    const execSsh = await loadExecSsh();
    void execSsh(INPUT);

    expect(typeof connectConfig().hostVerifier).toBe('function');
  });

  it('accepts the matching key and rejects any other', async () => {
    const expected = Buffer.from('expected-key');
    mockConfig.config.wlc.sshVerifyHostKey = true;
    mockConfig.config.wlc.sshHostKey = expected.toString('base64');

    const execSsh = await loadExecSsh();
    void execSsh(INPUT);

    const verifier = connectConfig().hostVerifier as
      (key: Buffer, cb: (ok: boolean) => void) => void;

    const results: boolean[] = [];
    verifier(expected, (ok) => results.push(ok));
    verifier(Buffer.from('a-different-controller'), (ok) => results.push(ok));

    expect(results).toEqual([true, false]);
  });

  it('accepts the expected key given in hex as well as base64', async () => {
    const expected = Buffer.from('expected-key');
    mockConfig.config.wlc.sshVerifyHostKey = true;
    mockConfig.config.wlc.sshHostKey = expected.toString('hex');

    const execSsh = await loadExecSsh();
    void execSsh(INPUT);

    const verifier = connectConfig().hostVerifier as
      (key: Buffer, cb: (ok: boolean) => void) => void;

    let ok = false;
    verifier(expected, (r) => { ok = r; });
    expect(ok).toBe(true);
  });

  it('does not log the disabled-state warning', async () => {
    mockConfig.config.wlc.sshVerifyHostKey = true;
    mockConfig.config.wlc.sshHostKey = 'AAAA';

    const execSsh = await loadExecSsh();
    void execSsh(INPUT);

    const warned = mockLog.warn.mock.calls.some(([, msg]) =>
      String(msg).includes('host key verification is DISABLED'),
    );
    expect(warned).toBe(false);
  });
});
