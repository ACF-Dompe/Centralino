/**
 * Logger wrapper around pino with pretty printing in dev and
 * optional Application Insights integration for Azure.
 *
 * In production (Azure Container Apps) pino outputs JSON lines to
 * stdout which are picked up by Log Analytics. If APPLICATIONINSIGHTS_CONNECTION_STRING
 * is set AND the `applicationinsights` npm package is installed, telemetry
 * is forwarded to Application Insights as well.
 *
 * Usage:
 *   import { log } from './logger.js';
 *   log.info({ key: 'value' }, 'message');
 *   log.error({ err }, 'Something failed');
 */
import pino from 'pino';
import { config } from './config.js';
// Build the base pino logger with stdout stream always active.
// Multi-stream approach: we start with stdout only, then wire in
// the AI stream asynchronously once it's ready.
const streams = [
    { stream: process.stdout },
];
if (config.nodeEnv !== 'production') {
    streams.push({
        stream: pino.transport({
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        }),
    });
}
export const log = pino({
    level: config.logLevel,
    base: {
        service: 'cisco-guest-desk',
        env: config.nodeEnv,
        app: 'backend',
    },
}, pino.multistream(streams));
// ── Optional Application Insights integration ───────────────────────────────
// We use a WriteStream adapter that forwards pino events to App Insights.
// The AI SDK is imported lazily only when configured, to keep startup fast
// when not running in Azure.
(async () => {
    if (!config.applicationInsights.connectionString) {
        return;
    }
    try {
        // Dynamic import — the package is optional (only needed when AI is configured).
        // @ts-expect-error — optional dependency, gracefully handled via try-catch
        const appInsights = await import('applicationinsights');
        appInsights.setup(config.applicationInsights.connectionString)
            .setAutoCollectConsole(false) // we manage logging via pino
            .setSendLiveMetrics(true)
            .start();
        const client = appInsights.defaultClient;
        const SeverityLevel = appInsights.Contracts.SeverityLevel;
        // Append a new stream to the existing multi-stream logger.
        // pino.multistream supports adding streams dynamically, but for simplicity
        // we create a child logger that writes to an AI-backed stream.
        const aiStream = pino({
            level: config.logLevel,
        }, {
            write: (data) => {
                try {
                    const parsed = JSON.parse(data);
                    const level = parsed.level ?? 30;
                    const msg = parsed.msg ?? '';
                    const props = {};
                    for (const [k, v] of Object.entries(parsed)) {
                        if (!['level', 'msg', 'time', 'pid', 'hostname', 'service', 'env', 'app'].includes(k)) {
                            props[k] = typeof v === 'string' ? v : JSON.stringify(v);
                        }
                    }
                    if (level >= 50) {
                        client.trackException({ exception: new Error(msg), properties: props });
                    }
                    else if (level >= 40) {
                        client.trackTrace({ message: `[WARN] ${msg}`, severity: SeverityLevel.Warning, properties: props });
                    }
                    else if (level >= 30) {
                        client.trackTrace({ message: msg, severity: SeverityLevel.Information, properties: props });
                    }
                    else {
                        client.trackTrace({ message: msg, severity: SeverityLevel.Verbose, properties: props });
                    }
                }
                catch {
                    // Silently ignore parse errors
                }
            },
        });
        // Monkey-patch log methods to also write to the AI stream.
        // We do this by wrapping each method - the original reference is captured
        // inside the closure, so new imports get the patched version.
        const origInfo = log.info.bind(log);
        const origWarn = log.warn.bind(log);
        const origError = log.error.bind(log);
        log.info = (obj, msg, ...args) => {
            origInfo(obj, msg, ...args);
            aiStream.info(obj, msg, ...args);
        };
        log.warn = (obj, msg, ...args) => {
            origWarn(obj, msg, ...args);
            aiStream.warn(obj, msg, ...args);
        };
        log.error = (obj, msg, ...args) => {
            origError(obj, msg, ...args);
            aiStream.error(obj, msg, ...args);
        };
        log.info('Application Insights telemetry active');
    }
    catch (err) {
        console.warn('[logger] Application Insights not available (install optional dep: npm i applicationinsights)');
        console.warn('[logger] App will continue without AI telemetry.');
    }
})();
//# sourceMappingURL=logger.js.map