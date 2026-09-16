/**
 * Node reports TLS failures and network failures through the same request
 * `error` event, and calling both "host unreachable" sends whoever reads it
 * looking at firewalls and routing when the host answered perfectly well and
 * only its certificate was refused. This maps the error code to something
 * actionable.
 */
function describeRequestError(err: NodeJS.ErrnoException): string {
  // Prefer err.code, but fall back to matching the message: libraries that
  // wrap a socket error sometimes carry the token only in the text, and a
  // misclassified error is exactly what cost us a detour into the network.
  const known = [
    'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
    'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
    'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  ];
  const code = err.code && known.includes(err.code)
    ? err.code
    : (known.find((k) => err.message?.includes(k)) ?? err.code ?? '');

  // Certificate refused: the WLC answered and the TLS handshake happened, but
  // verification failed. A Catalyst 9800 ships a self-signed certificate, so
  // this is the expected outcome with WLC_TLS_REJECT_UNAUTHORIZED=true.
  const tlsCodes = [
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_UNTRUSTED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ];
  if (tlsCodes.includes(code)) {
    return (
      `Certificato TLS del WLC rifiutato (${code}). Il controller risponde: ` +
      'a fallire e la verifica del certificato, non la rete. Un Catalyst 9800 ' +
      'presenta un certificato self-signed: installa un certificato attendibile ' +
      'sul controller, oppure imposta WLC_TLS_REJECT_UNAUTHORIZED=false ' +
      'accettandone il rischio.'
    );
  }
  if (code === 'CERT_HAS_EXPIRED') {
    return `Certificato TLS del WLC scaduto (${code}). Il controller risponde: rinnova il certificato.`;
  }

  // Genuinely unreachable.
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return `Host irraggiungibile (${code}): verifica egress verso la rete WLC e routing.`;
  }
  if (code === 'ECONNREFUSED') {
    return `Connessione rifiutata (${code}): l host risponde ma la porta e chiusa. Verifica host e porta.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Nome host non risolto (${code}): verifica il valore di host.`;
  }

  return `Connessione al WLC fallita${code ? ` (${code})` : ''}: ${err.message}`;
}
/**
 * WLC WebUI (HTTPS) login service.
 * Sends a Basic-auth GET to the controller's WebUI index page and inspects
 * the response body to differentiate between success, wrong credentials and
 * unreachable host.
 *
 * Implements a `responded` flag to prevent double-response on race between
 * the socket `error` event and `response.end` / timeout.
 */
import https from 'node:https';
import { config } from '../config.js';
import { log } from '../logger.js';

export interface WebUiLoginInput {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs?: number;
}

export type WebUiLoginResult =
  | { success: true; status: number; message: string; authMethod: 'webui' }
  | { success: false; status: number; error: string }
  | { success: false; isUnreachable: true; error: string };

export function loginWebUi(input: WebUiLoginInput): Promise<WebUiLoginResult> {
  return new Promise((resolve) => {
    const auth = Buffer.from(`${input.username}:${input.password}`).toString('base64');
    const timeoutMs = input.timeoutMs ?? config.wlc.httpTimeoutMs;
    const options: https.RequestOptions = {
      host: input.host,
      port: input.port,
      path: '/webui/index.html',
      method: 'GET',
      // TLS verification: controlled by WLC_TLS_REJECT_UNAUTHORIZED env var.
      // Must be true in production to prevent MITM attacks on the WLC channel.
      // Set to false only for local dev with self-signed WLC certificates.
      rejectUnauthorized: config.wlc.tlsRejectUnauthorized,
      timeout: timeoutMs,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'CiscoGuestDesk/1.0',
      },
    };

    let responded = false;
    const lib = input.port === 443 ? https : https; // WLC always terminates TLS on the WebUI port
    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if (responded) return;
        responded = true;
        const body = Buffer.concat(chunks).toString('utf8').toLowerCase();
        const status = res.statusCode ?? 0;
        if (status === 200 && !body.includes('myloginform') && !body.includes('wrong')) {
          resolve({ success: true, status: 200, message: 'Autenticazione WebUI riuscita', authMethod: 'webui' });
        } else {
          resolve({ success: false, status, error: 'Credenziali WLC errate o risposta inattesa.' });
        }
      });
    });

    req.on('error', (err: NodeJS.ErrnoException) => {
      if (responded) return;
      responded = true;
      log.warn({ err: err.message, code: err.code, host: input.host }, 'WLC WebUI request error');
      resolve({ success: false, isUnreachable: true, error: describeRequestError(err) });
    });

    req.on('timeout', () => {
      if (responded) return;
      responded = true;
      req.destroy(new Error('timeout'));
      resolve({ success: false, isUnreachable: true, error: `Timeout connessione WLC dopo ${timeoutMs}ms` });
    });

    req.end();
  });
}
