/**
 * Integration tests for sendViaGraph (Microsoft Graph API email service).
 *
 * Unlike the unit tests in email.test.ts (which mock the entire graphMail module),
 * these tests mock the actual Graph API client at the library level:
 *   - @microsoft/microsoft-graph-client (Client.initWithMiddleware → .api() → .post())
 *   - @azure/identity (ClientSecretCredential)
 *
 * This validates that sendViaGraph constructs the correct Graph API request
 * payload (subject, body, recipients, etc.) without making real HTTP calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Library-level mocks ────────────────────────────────────────────────────

const mockPost = vi.fn();
const mockApi = vi.fn().mockReturnValue({ post: mockPost });

vi.mock('@microsoft/microsoft-graph-client', () => ({
  Client: {
    initWithMiddleware: vi.fn(() => ({ api: mockApi })),
  },
}));

vi.mock('@azure/identity', () => ({
  ClientSecretCredential: vi.fn(),
}));

vi.mock('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials', () => ({
  TokenCredentialAuthenticationProvider: vi.fn(),
}));

// ── Config mock (shared mutable object for runtime overrides) ──────────────

const mockGraphConfig = {
  enabled: true,
  tenantId: 'test-tenant',
  clientId: 'test-client',
  clientSecret: 'test-secret',
  userId: 'mailbox@dompe.com',
  fromAddress: 'noreply@dompe.com',
};

vi.mock('../config.js', () => ({
  config: {
    mail: {
      graph: mockGraphConfig,
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

// ── Test data ──────────────────────────────────────────────────────────────

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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('sendViaGraph (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGraphConfig.enabled = true;
  });

  describe('when Graph API is configured (MAIL_GRAPH_ENABLED=true)', () => {
    it('sends email successfully and returns ok:true with messageId', async () => {
      mockPost.mockResolvedValue(undefined);

      const { sendViaGraph } = await import('../services/graphMail.js');
      const result = await sendViaGraph(defaultParams);

      // Result shape
      expect(result).toEqual({ ok: true, messageId: expect.any(String) });
      expect(result!.messageId).toMatch(/^graph-\d+$/);

      // Graph client was initialized
      const { ClientSecretCredential } = await import('@azure/identity');
      expect(ClientSecretCredential).toHaveBeenCalledWith(
        'test-tenant', 'test-client', 'test-secret',
      );

      // API endpoint called correctly
      expect(mockApi).toHaveBeenCalledWith('/users/mailbox@dompe.com/sendMail');
      expect(mockPost).toHaveBeenCalledOnce();
    });

    it('constructs the email payload with correct subject, body, and recipients', async () => {
      mockPost.mockResolvedValue(undefined);

      const { sendViaGraph } = await import('../services/graphMail.js');
      await sendViaGraph(defaultParams);

      const payload = mockPost.mock.calls[0][0];

      // Subject
      expect(payload.message.subject).toBe('Wi-Fi Access — Dompe Guest');

      // Body — HTML content type
      expect(payload.message.body.contentType).toBe('html');
      expect(payload.message.body.content).toContain('Mario Rossi');
      expect(payload.message.body.content).toContain('DOMPE-4321');
      expect(payload.message.body.content).toContain('Dompe Guest');
      expect(payload.message.body.content).toContain('Sponsor Test');
      expect(payload.message.body.content).toContain('01/08/2026, 14:00:00');

      // Recipients
      expect(payload.message.toRecipients).toEqual([
        { emailAddress: { address: 'ospite@example.com' } },
      ]);

      // saveToSentItems
      expect(payload.saveToSentItems).toBe(false);
    });

    it('sanitizes HTML-sensitive characters in guest details', async () => {
      mockPost.mockResolvedValue(undefined);

      const { sendViaGraph } = await import('../services/graphMail.js');
      await sendViaGraph({
        ...defaultParams,
        guestName: 'Mario <script>alert("xss")</script>',
        host: 'Test & <Host>',
        username: '<user>',
        password: 'pass"word',
      });

      const payload = mockPost.mock.calls[0][0];
      const html = payload.message.body.content;

      // Verify HTML entities are escaped for fields rendered in the body
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('&amp;lt;'); // no double-escape
      expect(html).toContain('Test &amp; &lt;Host&gt;');
      expect(html).toContain('pass&quot;word');
    });

    it('returns ok:false with error message when Graph API throws', async () => {
      mockPost.mockRejectedValue(new Error('Invalid authentication context'));

      const { sendViaGraph } = await import('../services/graphMail.js');
      const result = await sendViaGraph(defaultParams);

      expect(result).toEqual({
        ok: false,
        error: 'Invalid authentication context',
      });
    });

    it('returns ok:false with network error when Graph API is unreachable', async () => {
      mockPost.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:443'));

      const { sendViaGraph } = await import('../services/graphMail.js');
      const result = await sendViaGraph(defaultParams);

      expect(result).toEqual({
        ok: false,
        error: 'connect ECONNREFUSED 127.0.0.1:443',
      });
    });
  });

  describe('when Graph API is NOT configured (MAIL_GRAPH_ENABLED=false)', () => {
    it('returns null — caller should fall back to SMTP/demo', async () => {
      mockGraphConfig.enabled = false;

      const { sendViaGraph } = await import('../services/graphMail.js');
      const result = await sendViaGraph(defaultParams);

      expect(result).toBeNull();
      expect(mockPost).not.toHaveBeenCalled();
      expect(mockApi).not.toHaveBeenCalled();
    });
  });
});
