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
export function loginWebUi(input) {
    return new Promise((resolve) => {
        const auth = Buffer.from(`${input.username}:${input.password}`).toString('base64');
        const timeoutMs = input.timeoutMs ?? config.wlc.httpTimeoutMs;
        const options = {
            host: input.host,
            port: input.port,
            path: '/webui/index.html',
            method: 'GET',
            rejectUnauthorized: false,
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
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                if (responded)
                    return;
                responded = true;
                const body = Buffer.concat(chunks).toString('utf8').toLowerCase();
                const status = res.statusCode ?? 0;
                if (status === 200 && !body.includes('myloginform') && !body.includes('wrong')) {
                    resolve({ success: true, status: 200, message: 'Autenticazione WebUI riuscita', authMethod: 'webui' });
                }
                else {
                    resolve({ success: false, status, error: 'Credenziali WLC errate o risposta inattesa.' });
                }
            });
        });
        req.on('error', (err) => {
            if (responded)
                return;
            responded = true;
            log.warn({ err: err.message, host: input.host }, 'WLC WebUI request error');
            resolve({ success: false, isUnreachable: true, error: `Host irraggiungibile: ${err.message}` });
        });
        req.on('timeout', () => {
            if (responded)
                return;
            responded = true;
            req.destroy(new Error('timeout'));
            resolve({ success: false, isUnreachable: true, error: `Timeout connessione WLC dopo ${timeoutMs}ms` });
        });
        req.end();
    });
}
//# sourceMappingURL=wlcWebui.js.map