/**
 * Real SMTP email service for guest credentials.
 *
 * Uses nodemailer when an SMTP host is configured in the `email_config` table.
 * In demo/offline mode (no host), it logs the message to stdout so the
 * developer can verify the payload in the container logs.
 */
import nodemailer from 'nodemailer';
import { getEmailConfig } from '../repositories/index.js';
import { log } from '../logger.js';
let cachedTransporter = null;
let cachedSignature = '';
async function buildTransporter() {
    const cfg = await getEmailConfig();
    if (!cfg.smtpHost)
        return null; // demo mode
    const sig = JSON.stringify({
        h: cfg.smtpHost, p: cfg.smtpPort, e: cfg.encryption, r: cfg.requireAuth, u: cfg.username,
    });
    if (cachedTransporter && cachedSignature === sig)
        return cachedTransporter;
    if (cachedTransporter)
        cachedTransporter.close();
    const secure = cfg.encryption === 'ssl';
    const transporter = nodemailer.createTransport({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure,
        requireTLS: cfg.encryption === 'starttls',
        auth: cfg.requireAuth && cfg.username && cfg.password
            ? { user: cfg.username, pass: cfg.password }
            : undefined,
    });
    cachedTransporter = transporter;
    cachedSignature = sig;
    return transporter;
}
export async function sendCredentialEmail(p) {
    const subject = `Wi-Fi Access — ${p.ssid}`;
    const text = [
        `Gentile ${p.guestName},`,
        ``,
        `Sono state generate le Sue credenziali per accedere alla rete Wi-Fi aziendale.`,
        ``,
        `  Rete (SSID): ${p.ssid}`,
        `  Username:    ${p.username}`,
        `  Password:    ${p.password}`,
        `  Valido fino: ${p.expiresAt}`,
        `  Referente:   ${p.host}`,
        ``,
        `Per connettersi: selezionare la rete ${p.ssid} e inserire le credenziali sopra.`,
        ``,
        `— Dompe IT Security`,
    ].join('\n');
    const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a;">
      <div style="background:#003366; color:#fff; padding:16px 20px; border-radius:8px 8px 0 0;">
        <div style="font-size:11px; letter-spacing:0.2em; text-transform:uppercase; opacity:0.7;">Dompe</div>
        <div style="font-size:18px; font-weight:700;">Credenziali Wi-Fi Ospiti</div>
      </div>
      <div style="border:1px solid #e2e8f0; border-top:0; padding:20px; border-radius:0 0 8px 8px;">
        <p>Gentile <strong>${escapeHtml(p.guestName)}</strong>,</p>
        <p>sono state generate le Sue credenziali per accedere alla rete Wi-Fi aziendale.</p>
        <table style="width:100%; border-collapse:collapse; margin:16px 0;">
          <tr><td style="padding:6px 0; color:#64748b; font-size:12px; text-transform:uppercase; letter-spacing:0.1em;">Rete (SSID)</td><td style="padding:6px 0; font-family:monospace; font-weight:700;">${escapeHtml(p.ssid)}</td></tr>
          <tr><td style="padding:6px 0; color:#64748b; font-size:12px; text-transform:uppercase; letter-spacing:0.1em;">Username</td><td style="padding:6px 0; font-family:monospace; font-weight:700;">${escapeHtml(p.username)}</td></tr>
          <tr><td style="padding:6px 0; color:#64748b; font-size:12px; text-transform:uppercase; letter-spacing:0.1em;">Password</td><td style="padding:6px 0; font-family:monospace; font-weight:700; color:#dc2626;">${escapeHtml(p.password)}</td></tr>
          <tr><td style="padding:6px 0; color:#64748b; font-size:12px; text-transform:uppercase; letter-spacing:0.1em;">Valido fino</td><td style="padding:6px 0; font-family:monospace;">${escapeHtml(p.expiresAt)}</td></tr>
          <tr><td style="padding:6px 0; color:#64748b; font-size:12px; text-transform:uppercase; letter-spacing:0.1em;">Referente</td><td style="padding:6px 0;">${escapeHtml(p.host)}</td></tr>
        </table>
        <p style="color:#64748b; font-size:13px;">Per connettersi: selezionare la rete <strong>${escapeHtml(p.ssid)}</strong> e inserire le credenziali sopra.</p>
        <hr style="border:0; border-top:1px solid #e2e8f0; margin:20px 0;"/>
        <div style="font-size:11px; color:#94a3b8;">— Dompe IT Security</div>
      </div>
    </div>`;
    const cfg = await getEmailConfig();
    const transporter = await buildTransporter();
    if (!transporter) {
        log.info({ to: p.to, username: p.username, ssid: p.ssid }, 'SMTP not configured — credential email logged to console');
        log.info({ text }, 'credential-email.body');
        return { ok: true, mode: 'demo-log' };
    }
    try {
        const info = await transporter.sendMail({
            from: cfg.sender ?? 'noreply@dompe.com',
            to: p.to,
            subject,
            text,
            html,
        });
        return { ok: true, messageId: info.messageId, mode: 'smtp' };
    }
    catch (err) {
        return { ok: false, mode: 'smtp', error: err.message };
    }
}
function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
//# sourceMappingURL=email.js.map