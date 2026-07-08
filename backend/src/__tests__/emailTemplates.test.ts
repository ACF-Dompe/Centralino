/**
 * Tests for email template builders (buildHtmlBody / buildTextBody).
 *
 * These are pure functions — no mocking needed. They render guest credential
 * details into HTML and plain-text email bodies, shared by both SMTP and
 * Graph API transport paths.
 */
import { describe, it, expect } from 'vitest';
import { buildHtmlBody, buildTextBody } from '../services/graphMail.js';
import type { CredentialEmailParams } from '../services/email.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const defaultParams: CredentialEmailParams = {
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

// ── Tests: buildHtmlBody ───────────────────────────────────────────────────

describe('buildHtmlBody', () => {
  it('contains all guest fields in the rendered output', () => {
    const html = buildHtmlBody(defaultParams);

    // Greeting
    expect(html).toContain('Mario Rossi');

    // Table fields
    expect(html).toContain('Dompe Guest');
    expect(html).toContain('g.marior123');
    expect(html).toContain('DOMPE-4321');
    expect(html).toContain('01/08/2026, 14:00:00');
    expect(html).toContain('Sponsor Test');

    // SSID also appears in the footer call-to-action
    expect(html).toContain('selezionare la rete <strong>Dompe Guest</strong>');

    // Label translations
    expect(html).toContain('Rete (SSID)');
    expect(html).toContain('Username');
    expect(html).toContain('Password');
    expect(html).toContain('Valido fino');
    expect(html).toContain('Referente');
  });

  it('produces valid HTML structure with opening and closing tags', () => {
    const html = buildHtmlBody(defaultParams);

    // Root wrapper
    expect(html).toContain('<div style=');
    expect(html).toContain('</div>');

    // Header
    expect(html).toContain('Dompe</div>');
    expect(html).toContain('Credenziali Wi-Fi Ospiti</div>');

    // Table
    expect(html).toContain('<table');
    expect(html).toContain('</table>');

    // Horizontal rule
    expect(html).toContain('<hr');
    expect(html).toContain('/>');

    // Footer signature
    expect(html).toContain('Dompe IT Security');
  });

  it('applies correct CSS classes and inline styles', () => {
    const html = buildHtmlBody(defaultParams);

    // Background colors
    expect(html).toContain('background:#003366');
    expect(html).toContain('background:');

    // Font styling
    expect(html).toContain('font-family:');
    expect(html).toContain('font-weight:700');
    expect(html).toContain('font-size:');

    // Monospace font for credentials
    expect(html).toContain('font-family:monospace');

    // Password in red
    expect(html).toContain('color:#dc2626');

    // Rounded corners
    expect(html).toContain('border-radius:8px');

    // Table styling
    expect(html).toContain('border-collapse:collapse');
  });

  it('sanitizes HTML-sensitive characters in all guest fields', () => {
    const malicious: CredentialEmailParams = {
      ...defaultParams,
      guestName: '<script>alert("xss")</script>',
      host: 'Test & <Host>',
      username: '<user>',
      password: 'pass"word',
      ssid: 'SSID & <More>',
    };

    const html = buildHtmlBody(malicious);

    // Raw HTML/JS dangerous patterns must NOT appear
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<user>');
    expect(html).not.toContain('<Host>');
    expect(html).not.toContain('<More>');

    // Properly escaped equivalents
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;user&gt;');
    expect(html).toContain('Test &amp; &lt;Host&gt;');
    expect(html).toContain('pass&quot;word');
    expect(html).toContain('SSID &amp; &lt;More&gt;');

    // No double-encoding: &amp; should never become &amp;amp;
    expect(html).not.toContain('&amp;amp;');
  });

  it('handles empty string fields without crashing', () => {
    const empty: CredentialEmailParams = {
      ...defaultParams,
      guestName: '',
      host: '',
      username: '',
      password: '',
      ssid: '',
      expiresAt: '',
    };

    // Must not throw
    const html = buildHtmlBody(empty);

    // Should still produce valid structure
    expect(html).toContain('Gentile');
    expect(html).toContain('Credenziali Wi-Fi Ospiti');
    expect(html).toContain('Dompe IT Security');
    expect(html).toContain('<hr');
  });

  it('handles Unicode and accented characters', () => {
    const unicode: CredentialEmailParams = {
      ...defaultParams,
      guestName: 'José María Müller-Straße',
      host: 'François à Paris',
      ssid: 'WiFi Café ☕',
      expiresAt: '01/02/2026, 14:00:00',
    };

    const html = buildHtmlBody(unicode);

    expect(html).toContain('José María Müller-Straße');
    expect(html).toContain('François à Paris');
    expect(html).toContain('WiFi Café ☕');
  });

  it('does not contain the company field (not rendered in template)', () => {
    const html = buildHtmlBody(defaultParams);

    // company is in the input params but not rendered in the email body
    expect(html).not.toContain('ACME Corp');
  });

  it('does not contain the recipient email (only used for addressing)', () => {
    const html = buildHtmlBody(defaultParams);

    expect(html).not.toContain('ospite@example.com');
  });

  it('does not contain durationMinutes (only expiresAt is rendered)', () => {
    const html = buildHtmlBody(defaultParams);

    expect(html).not.toContain('240');
    expect(html).not.toContain('minuti');
  });
});

// ── Tests: buildTextBody ───────────────────────────────────────────────────

describe('buildTextBody', () => {
  it('contains all guest fields in the plain-text output', () => {
    const text = buildTextBody(defaultParams);

    expect(text).toContain('Mario Rossi');
    expect(text).toContain('Dompe Guest');
    expect(text).toContain('g.marior123');
    expect(text).toContain('DOMPE-4321');
    expect(text).toContain('01/08/2026, 14:00:00');
    expect(text).toContain('Sponsor Test');
    expect(text).toContain('Dompe IT Security');
  });

  it('has correct plain-text structure (no HTML tags)', () => {
    const text = buildTextBody(defaultParams);

    expect(text).not.toContain('<div');
    expect(text).not.toContain('<table');
    expect(text).not.toContain('<strong');
    expect(text).not.toContain('<hr');
    expect(text).not.toContain('</div>');

    // Newlines for readability
    expect(text).toContain('\n');
  });

  it('includes column-aligned credential table with spaces', () => {
    const text = buildTextBody(defaultParams);

    // Field labels
    expect(text).toContain('Rete (SSID):');
    expect(text).toContain('Username:');
    expect(text).toContain('Password:');
    expect(text).toContain('Valido fino:');
    expect(text).toContain('Referente:');

    // Aligned with spaces
    expect(text).toContain('  Rete (SSID): Dompe Guest');
    expect(text).toContain('  Username:    g.marior123');
    expect(text).toContain('  Password:    DOMPE-4321');
  });

  it('handles empty string fields without crashing', () => {
    const empty: CredentialEmailParams = {
      ...defaultParams,
      guestName: '',
      host: '',
      username: '',
      password: '',
      ssid: '',
      expiresAt: '',
    };

    const text = buildTextBody(empty);
    expect(text).toContain('Gentile ,'); // empty name
    expect(text).toContain('Dompe IT Security');
  });

  it('does not contain fields not rendered in the text template', () => {
    const text = buildTextBody(defaultParams);

    expect(text).not.toContain('ACME Corp');
    expect(text).not.toContain('ospite@example.com');
    expect(text).not.toContain('240');
  });
});
