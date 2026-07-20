/**
 * Email orchestration service for guest credentials.
 *
 * Mail is delivered ONLY via the Microsoft Graph API (platform transport).
 * SMTP/nodemailer has been removed (§3). When Graph is not configured
 * (local dev), the credential email is logged to the console (demo-log).
 */
import { log } from '../logger.js';
import { sendViaGraph, buildTextBody } from './graphMail.js';

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

export type SendMode = 'graph' | 'demo-log';

export interface SendResult {
  ok: boolean;
  messageId?: string;
  mode: SendMode;
  error?: string;
}

/**
 * Send a credential email via Microsoft Graph.
 * If Graph is not configured (dev), the email is logged to the console.
 */
export async function sendCredentialEmail(p: CredentialEmailParams): Promise<SendResult> {
  // Microsoft Graph API (the only real transport).
  const graphResult = await sendViaGraph(p);
  if (graphResult !== null) {
    return graphResult.ok
      ? { ok: true, messageId: graphResult.messageId, mode: 'graph' }
      : { ok: false, mode: 'graph', error: graphResult.error };
  }

  // Graph not configured (local dev) — demo/log mode.
  const text = buildTextBody(p);
  log.info({ to: p.to, username: p.username, ssid: p.ssid }, 'No Graph mail transport configured — credential email logged to console');
  log.info({ text }, 'credential-email.body');
  return { ok: true, mode: 'demo-log' };
}
