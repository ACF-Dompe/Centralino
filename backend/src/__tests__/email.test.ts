import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Transporter } from 'nodemailer';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockSendMail = vi.fn();

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: mockSendMail,
      close: vi.fn(),
    } as unknown as Transporter)),
  },
}));

const mockGetEmailConfig = vi.fn();
vi.mock('../repositories/index.js', () => ({
  getEmailConfig: () => mockGetEmailConfig(),
}));

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

    it('returns graph error when Graph API fails (no SMTP fallback)', async () => {
      mockGraphSend.mockResolvedValue({ ok: false, error: 'Unauthorized' });

      const { sendCredentialEmail } = await import('../services/email.js');
      const result = await sendCredentialEmail(defaultParams);

      // When Graph is explicitly configured, failure is final — no fallback
      expect(result).toEqual({ ok: false, mode: 'graph', error: 'Unauthorized' });
      expect(mockSendMail).not.toHaveBeenCalled();
    });
  });

  // ── SMTP path ─────────────────────────────────────────────────────────

  describe('when Graph is not configured but SMTP is', () => {
    it('sends via SMTP and returns smtp mode on success', async () => {
      mockGetEmailConfig.mockResolvedValue({
        smtpHost: 'smtp.example.com', smtpPort: 587, sender: 'noreply@dompe.com',
        encryption: 'starttls', requireAuth: true, username: 'user', password: 'pass',
      });
      mockSendMail.mockResolvedValue({ messageId: '<abc@example.com>' });

      const { sendCredentialEmail } = await import('../services/email.js');
      const result = await sendCredentialEmail(defaultParams);

      expect(result).toEqual({ ok: true, messageId: '<abc@example.com>', mode: 'smtp' });
      expect(mockSendMail).toHaveBeenCalledOnce();
      expect(mockGraphSend).toHaveBeenCalledOnce(); // tried Graph first, got null
    });

    it('returns error when SMTP send fails', async () => {
      mockGetEmailConfig.mockResolvedValue({
        smtpHost: 'smtp.example.com', smtpPort: 587, sender: 'noreply@dompe.com',
        encryption: 'tls', requireAuth: false, username: '', password: '',
      });
      mockSendMail.mockRejectedValue(new Error('Connection refused'));

      const { sendCredentialEmail } = await import('../services/email.js');
      const result = await sendCredentialEmail(defaultParams);

      expect(result).toEqual({ ok: false, mode: 'smtp', error: 'Connection refused' });
    });
  });

  // ── Demo-log path ─────────────────────────────────────────────────────

  describe('when no transport is configured', () => {
    it('returns demo-log mode when Graph is off and SMTP has no host', async () => {
      mockGetEmailConfig.mockResolvedValue({
        smtpHost: '', smtpPort: 587, sender: '', encryption: 'tls',
        requireAuth: false, username: '', password: '',
      });

      const { sendCredentialEmail } = await import('../services/email.js');
      const result = await sendCredentialEmail(defaultParams);

      expect(result).toEqual({ ok: true, mode: 'demo-log' });
      expect(mockSendMail).not.toHaveBeenCalled();
    });
  });

  // ── SMTP detail tests ─────────────────────────────────────────────────

  describe('SMTP details', () => {
    it('uses custom sender from config when provided', async () => {
      mockGetEmailConfig.mockResolvedValue({
        smtpHost: 'smtp.example.com', smtpPort: 587, sender: 'custom@dompe.com',
        encryption: 'tls', requireAuth: false, username: '', password: '',
      });
      mockSendMail.mockResolvedValue({ messageId: '<def@example.com>' });

      const { sendCredentialEmail } = await import('../services/email.js');
      const result = await sendCredentialEmail(defaultParams);

      expect(result.ok).toBe(true);
      expect(mockSendMail.mock.calls[0][0].from).toBe('custom@dompe.com');
    });

    it('falls back to noreply@dompe.com when sender is null', async () => {
      mockGetEmailConfig.mockResolvedValue({
        smtpHost: 'smtp.example.com', smtpPort: 587, sender: null,
        encryption: 'tls', requireAuth: false, username: '', password: '',
      });
      mockSendMail.mockResolvedValue({ messageId: '<ghi@example.com>' });

      const { sendCredentialEmail } = await import('../services/email.js');
      const result = await sendCredentialEmail(defaultParams);

      expect(result.ok).toBe(true);
      expect(mockSendMail.mock.calls[0][0].from).toBe('noreply@dompe.com');
    });

    it('includes guest details in the email body', async () => {
      mockGetEmailConfig.mockResolvedValue({
        smtpHost: 'smtp.example.com', smtpPort: 587, sender: 'noreply@dompe.com',
        encryption: 'tls', requireAuth: false, username: '', password: '',
      });
      mockSendMail.mockResolvedValue({ messageId: '<mno@example.com>' });

      const { sendCredentialEmail } = await import('../services/email.js');
      const result = await sendCredentialEmail(defaultParams);

      expect(result.ok).toBe(true);
      const text = mockSendMail.mock.calls[0][0].text;
      expect(text).toContain('Mario Rossi');
      expect(text).toContain('Sponsor Test');
      expect(text).toContain('DOMPE-4321');
    });
  });
});
