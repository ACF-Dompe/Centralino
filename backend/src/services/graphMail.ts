/**
 * Microsoft Graph API email service.
 *
 * Sends credential emails via Microsoft Graph using the Client Credentials
 * OAuth 2.0 flow (App Registration + client secret). The platform team
 * provides the App Registration with `Mail.Send` application permission.
 *
 * Prerequisites (platform-provided):
 *   - App Registration with Mail.Send (Application permission)
 *   - Admin consent granted for the permission
 *   - A licensed user/mailbox (the "from" sender)
 *
 * Env vars (injected via ACA, secrets via Key Vault references):
 *   MAIL_GRAPH_ENABLED=true
 *   MAIL_GRAPH_TENANT_ID=<tenant-id>
 *   MAIL_GRAPH_CLIENT_ID=<client-id>
 *   MAIL_GRAPH_CLIENT_SECRET=@Microsoft.KeyVault(...)
 *   MAIL_GRAPH_USER_ID=<user-object-id-or-upn>  — the mailbox that sends
 *   MAIL_GRAPH_FROM_ADDRESS=noreply@dompe.com
 */
import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import type { Message } from '@microsoft/microsoft-graph-types';
import { log } from '../logger.js';
import { config } from '../config.js';
import type { CredentialEmailParams } from './email.js';

export interface GraphMailResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Build the HTML email body for guest credentials.
 * Shared by both SMTP and Graph API paths.
 */
export function buildHtmlBody(p: CredentialEmailParams): string {
  return `
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
}

/**
 * Build the plain-text email body for guest credentials.
 */
export function buildTextBody(p: CredentialEmailParams): string {
  return [
    `Gentile ${p.guestName},`,
    '',
    `Sono state generate le Sue credenziali per accedere alla rete Wi-Fi aziendale.`,
    '',
    `  Rete (SSID): ${p.ssid}`,
    `  Username:    ${p.username}`,
    `  Password:    ${p.password}`,
    `  Valido fino: ${p.expiresAt}`,
    `  Referente:   ${p.host}`,
    '',
    `Per connettersi: selezionare la rete ${p.ssid} e inserire le credenziali sopra.`,
    '',
    '— Dompe IT Security',
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send a credential email via Microsoft Graph API.
 * Returns null if Graph API is not configured (caller should fall back).
 * Returns { ok: false, error } on failure (caller may retry or fall back).
 */
export async function sendViaGraph(p: CredentialEmailParams): Promise<GraphMailResult | null> {
  if (!config.mail.graph.enabled) {
    return null; // Graph not configured — caller falls back to SMTP/demo
  }

  const cfg = config.mail.graph;
  log.info({ to: p.to, username: p.username, ssid: p.ssid }, 'Sending credential email via Microsoft Graph API');

  try {
    const credential = new ClientSecretCredential(
      cfg.tenantId,
      cfg.clientId,
      cfg.clientSecret,
    );

    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default'],
    });

    const graphClient = Client.initWithMiddleware({ authProvider });

    const subject = `Wi-Fi Access — ${p.ssid}`;
    const htmlContent = buildHtmlBody(p);
    const textContent = buildTextBody(p);

    const mail: Message = {
      subject,
      body: {
        contentType: 'html',
        content: htmlContent,
      },
      toRecipients: [
        { emailAddress: { address: p.to } },
      ],
    };

    // The userId is the mailbox that sends the email (must have a license).
    // Email appears in their Sent Items unless saveToSentItems is false.
    await graphClient.api(`/users/${cfg.userId}/sendMail`).post({
      message: mail,
      saveToSentItems: false,
    });

    log.info({ to: p.to, username: p.username }, 'Credential email sent via Graph API');
    return { ok: true, messageId: `graph-${Date.now()}` };
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Graph API email failed');
    return { ok: false, error: (err as Error).message };
  }
}
