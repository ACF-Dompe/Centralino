import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────
// SMTP/nodemailer has been removed (§3): mail is delivered only via Microsoft
// Graph, with a demo-log fallback when Graph is not configured.

// Mock config for Graph API tests
const mockConfig = { mail: { graph: { enabled: false } } };
vi.mock('../config.js', () => ({
  config: mockConfig,
}));

const mockGraphSend = vi.fn().mockReturnValue(null); // Return null by default (Graph not configured)
vi.mock('../services/graphMail.js', async (importOriginal) => {
  const mod = await importOriginal() as Record<string, unknown>;
  return {
    // Use real implementations for shared template builders
    ...mod,
    // Only mock sendViaGraph
    sendViaGraph: (...args: any[]) => mockGraphSend(...args),
  };
});

// Suppress logger output during tests
vi.mock('../logger.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Subject under test ─────────────────────────────────────────────────────

const defaultParams = {
  to: 'ospite@example.com',
  guestName: 'Mario Rossi',
  company: 'ACME Corp',
  host: 'Sponsor Test',
  username: 'g.marior123',
  password: 'DOMPE-4321',
  ssid: 'Dompe Guest',
  durationMinutes: 240,
  expiresAt: '01/08/2026, 14:00:00',
};

describe('sendCredentialEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset config and mocks to default before each test
    mockConfig.mail.graph.enabled = false;
    mockGraphSend.mockImplementation(() => null); // Graph not configured by default
  });

  // ── Graph API path ────────────────────────────────────────────────────

  describe('when Graph API is configured (MAIL_GRAPH_ENABLED=true)', () => {
    beforeEach(() => {
      mockConfig.mail.graph.enabled = true;
    });

    it('sends via Graph API and returns graph mode on success', async () => {
      mockGraphSend.mockResolvedValue({ ok: true, messageId: 'graph-123' });

      const { sendCredentialEmail } = await import('../services/email.js');
      const result = await sendCredentialEmail(defaultParams);

      expect(result).toEqual({ ok: true, messageId: 'graph-123', mode: 'graph' });
      expect(mockGraphSend).toHaveBeenCalledOnce();
      expect(mockGraphSend).toHaveBeenCalledWith(defaultParams);
    });

    it('returns graph error when Graph API fails (no fallback)', async () => {
      mockGraphSend.mockResolvedValue({ ok: false, error: 'Unauthorized' });

      const { sendCredentialEmail } = await import('../services/email.js');
      const result = await sendCredentialEmail(defaultParams);

      // Graph failure is final — there is no SMTP fallback anymore.
      expect(result).toEqual({ ok: false, mode: 'graph', error: 'Unauthorized' });
    });
  });

  // ── Demo-log path (Graph not configured) ───────────────────────────────

  describe('when Graph is not configured', () => {
    it('returns demo-log mode', async () => {
      // mockGraphSend returns null (default) → Graph not configured
      const { sendCredentialEmail } = await import('../services/email.js');
      const result = await sendCredentialEmail(defaultParams);

      expect(result).toEqual({ ok: true, mode: 'demo-log' });
      expect(mockGraphSend).toHaveBeenCalledOnce();
    });
  });
});
