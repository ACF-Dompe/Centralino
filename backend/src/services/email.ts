/**
 * Email orchestration service for guest credentials.
 *
 * Tries transports in order:
 *   1. Microsoft Graph API (if MAIL_GRAPH_ENABLED=true)
 *   2. SMTP via nodemailer (if configured in `email_config` table)
 *   3. Demo/log mode (prints to stdout)
 *
 * This allows a smooth migration path from legacy SMTP to the platform's
 * Graph API-based mail delivery while keeping local dev working without
 * any external service.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { getEmailConfig } from '../repositories/index.js';
import { log } from '../logger.js';
import { sendViaGraph } from './graphMail.js';
import { buildHtmlBody, buildTextBody } from './graphMail.js';

let cachedTransporter: Transporter | null = null;
let cachedSignature = '';

async function buildTransporter(): Promise<Transporter | null> {
  const cfg = await getEmailConfig();
  if (!cfg.smtpHost) return null; // demo mode

  const sig = JSON.stringify({
    h: cfg.smtpHost, p: cfg.smtpPort, e: cfg.encryption, r: cfg.requireAuth, u: cfg.username,
  });
  if (cachedTransporter && cachedSignature === sig) return cachedTransporter;

  if (cachedTransporter) cachedTransporter.close();

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

export interface CredentialEmailParams {
  to: string;
  guestName: string;
  company: string | null;
  host: string; // sponsor / referente
  username: string;
  password: string;
  ssid: string;
  durationMinutes: number;
  expiresAt: string;
}

export type SendMode = 'graph' | 'smtp' | 'demo-log';

export interface SendResult {
  ok: boolean;
  messageId?: string;
  mode: SendMode;
  error?: string;
}

/**
 * Send credential email trying Graph API first, then SMTP, then demo-log.
 */
export async function sendCredentialEmail(p: CredentialEmailParams): Promise<SendResult> {
  const subject = `Wi-Fi Access — ${p.ssid}`;
  const html = buildHtmlBody(p);
  const text = buildTextBody(p);

  // 1. Try Microsoft Graph API (platform-preferred transport)
  const graphResult = await sendViaGraph(p);
  if (graphResult !== null) {
    // Graph API was configured; return its result (success or failure)
    if (graphResult.ok) {
      return { ok: true, messageId: graphResult.messageId, mode: 'graph' };
    }
    // Graph failed — log the error but do NOT fall back to SMTP
    // (if Graph is explicitly configured, we respect its result)
    return { ok: false, mode: 'graph', error: graphResult.error };
  }

  // 2. Fall back to SMTP (from email_config table)
  const cfg = await getEmailConfig();
  const transporter = await buildTransporter();
  if (transporter) {
    try {
      const info = await transporter.sendMail({
        from: cfg.sender ?? 'noreply@dompe.com',
        to: p.to,
        subject,
        text,
        html,
      });
      return { ok: true, messageId: info.messageId, mode: 'smtp' };
    } catch (err) {
      return { ok: false, mode: 'smtp', error: (err as Error).message };
    }
  }

  // 3. Demo/log mode (no transport configured at all)
  log.info({ to: p.to, username: p.username, ssid: p.ssid }, 'No email transport configured — credential email logged to console');
  log.info({ text }, 'credential-email.body');
  return { ok: true, mode: 'demo-log' };
}
