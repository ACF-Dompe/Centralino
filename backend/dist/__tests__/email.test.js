import { describe, it, expect, vi, beforeEach } from 'vitest';
// ── Mocks ──────────────────────────────────────────────────────────────────
const mockSendMail = vi.fn();
vi.mock('nodemailer', () => ({
    default: {
        createTransport: vi.fn(() => ({
            sendMail: mockSendMail,
            close: vi.fn(),
        })),
    },
}));
const mockGetEmailConfig = vi.fn();
vi.mock('../repositories/index.js', () => ({
    getEmailConfig: () => mockGetEmailConfig(),
}));
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
    });
    it('returns demo-log mode when SMTP is not configured (no host)', async () => {
        mockGetEmailConfig.mockResolvedValue({
            smtpHost: '', smtpPort: 587, sender: '', encryption: 'tls',
            requireAuth: false, username: '', password: '',
        });
        const { sendCredentialEmail } = await import('../services/email.js');
        const result = await sendCredentialEmail(defaultParams);
        expect(result).toEqual({ ok: true, mode: 'demo-log' });
        expect(mockSendMail).not.toHaveBeenCalled();
    });
    it('sends email via SMTP and returns smtp mode on success', async () => {
        mockGetEmailConfig.mockResolvedValue({
            smtpHost: 'smtp.example.com', smtpPort: 587, sender: 'noreply@dompe.com',
            encryption: 'starttls', requireAuth: true, username: 'user', password: 'pass',
        });
        mockSendMail.mockResolvedValue({ messageId: '<abc@example.com>' });
        const { sendCredentialEmail } = await import('../services/email.js');
        const result = await sendCredentialEmail(defaultParams);
        expect(result).toEqual({ ok: true, messageId: '<abc@example.com>', mode: 'smtp' });
        expect(mockSendMail).toHaveBeenCalledOnce();
        const callArgs = mockSendMail.mock.calls[0][0];
        expect(callArgs.from).toBe('noreply@dompe.com');
        expect(callArgs.to).toBe('ospite@example.com');
        expect(callArgs.subject).toContain('Dompe Guest');
        // Verify password is in the email body (SMTP sends plaintext credentials)
        expect(callArgs.text).toContain('DOMPE-4321');
        expect(callArgs.text).toContain('g.marior123');
        // HTML version should also contain the credentials
        expect(callArgs.html).toContain('DOMPE-4321');
        expect(callArgs.html).toContain('g.marior123');
    });
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
    it('falls back to noreply@dompe.com when sender is null (?? operator)', async () => {
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
    it('returns error result when SMTP send fails', async () => {
        mockGetEmailConfig.mockResolvedValue({
            smtpHost: 'smtp.example.com', smtpPort: 587, sender: 'noreply@dompe.com',
            encryption: 'tls', requireAuth: false, username: '', password: '',
        });
        mockSendMail.mockRejectedValue(new Error('Connection refused'));
        const { sendCredentialEmail } = await import('../services/email.js');
        const result = await sendCredentialEmail(defaultParams);
        expect(result).toEqual({ ok: false, mode: 'smtp', error: 'Connection refused' });
    });
    it('escapes HTML in guest name for email body', async () => {
        mockGetEmailConfig.mockResolvedValue({
            smtpHost: 'smtp.example.com', smtpPort: 587, sender: 'noreply@dompe.com',
            encryption: 'tls', requireAuth: false, username: '', password: '',
        });
        mockSendMail.mockResolvedValue({ messageId: '<jkl@example.com>' });
        const { sendCredentialEmail } = await import('../services/email.js');
        const result = await sendCredentialEmail({
            ...defaultParams,
            guestName: '<script>alert("xss")</script>',
        });
        expect(result.ok).toBe(true);
        // The HTML version should have escaped angle brackets
        const html = mockSendMail.mock.calls[0][0].html;
        expect(html).toContain('&lt;script&gt;');
        expect(html).not.toContain('<script>');
    });
    it('builds email with all guest details in plain text', async () => {
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
        expect(text).toContain('Dompe Guest');
        expect(text).toContain('g.marior123');
        expect(text).toContain('DOMPE-4321');
        expect(text).toContain('01/08/2026');
        // Company/Azienda is not included in the email template
    });
});
//# sourceMappingURL=email.test.js.map