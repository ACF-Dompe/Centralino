/**
 * Centralized configuration loaded from environment variables.
 * No secrets are ever hard-coded; defaults are only used to make
 * the demo experience smooth out of the box.
 */
import 'dotenv/config';

function readString(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function readNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Azure-specific configuration for the Container Apps deployment.
 * These variables are injected via ACA environment variables (Key Vault references).
 */
const azure = {
  // Application Insights — optional. Set the connection string to enable.
  appInsightsConnectionString: readString('APPLICATIONINSIGHTS_CONNECTION_STRING', ''),
  // Azure Container Registry info (for logging/telemetry tagging)
  acrName: readString('ACR_NAME', ''),
  acrImageTag: readString('ACR_IMAGE_TAG', ''),
  // Azure region (used for telemetry tags)
  region: readString('AZURE_REGION', ''),
};

export const config = {
  nodeEnv: readString('NODE_ENV', 'production'),
  port: readNumber('PORT', 3000),
  logLevel: readString('LOG_LEVEL', 'info'),

  databaseUrl: readString('DATABASE_URL', ''),

  /**
   * Internal ACA FQDN for the backend container app.
   * Used for server-side frontend-to-backend calls within the ACA environment.
   * Format: http://ca-<appname>-backend-<env>.<aca-environment-default-domain>
   * Example: http://ca-cgd-backend-dev.icydune-01234567.westeurope.azurecontainerapps.io
   */
  backendBaseUrl: readString('BACKEND_BASE_URL', ''),

  wlc: {
    defaultHost: readString('WLC_DEFAULT_HOST', '172.18.106.100'),
    defaultPort: readNumber('WLC_DEFAULT_PORT', 443),
    defaultSshPort: readNumber('WLC_DEFAULT_SSH_PORT', 22),
    defaultUsername: readString('WLC_DEFAULT_USERNAME', 'admin_guest'),
    defaultPassword: readString('WLC_DEFAULT_PASSWORD', ''),
    defaultSsid: readString('WLC_DEFAULT_SSID', 'Dompe Guest'),
    httpTimeoutMs: readNumber('WLC_HTTP_TIMEOUT_MS', 10_000),
    sshTimeoutMs: readNumber('WLC_SSH_TIMEOUT_MS', 10_000),
    /**
     * Expected SSH host key fingerprint for WLC connections.
     * When set, the SSH client verifies the host key against this value
     * (e.g. "ssh-rsa 2048 xx:xx:xx:..."). If empty, host key verification
     * is skipped (local dev / demo mode). In production, always set this.
     */
    sshHostKey: readString('WLC_SSH_HOST_KEY', ''),
    /**
     * Whether to reject unauthorized TLS certificates for WLC WebUI connections.
     * Must be true in production; set to false only for local dev with self-signed certs.
     */
    tlsRejectUnauthorized: readString('WLC_TLS_REJECT_UNAUTHORIZED', 'false').toLowerCase() === 'true',
  },

  /**
   * SAML 2.0 SSO via Microsoft Entra ID.
   * All fields are optional — when `entryPoint` is empty SSO is disabled
   * and the app falls back to WLC-only authentication (useful for local dev
   * without an Azure AD tenant).
   */
  saml: {
    enabled: readString('SAML_ENTRY_POINT', '').length > 0,
    entryPoint: readString('SAML_ENTRY_POINT', ''),
    issuer: readString('SAML_ISSUER', ''),
    callbackUrl: readString('SAML_CALLBACK_URL', ''),
    cert: readString('SAML_CERT', ''),
    decryptionKey: readString('SAML_DECRYPTION_KEY', ''),
    identifierFormat: readString('SAML_IDENTIFIER_FORMAT', 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'),
    /** IdP Single Logout endpoint (defaults to entryPoint if not set). */
    logoutUrl: readString('SAML_LOGOUT_URL', ''),
    /**
     * Where the IdP should send the SAML LogoutResponse after SLO.
     * Defaults to the callbackUrl with /callback replaced by /slo/callback.
     */
    logoutCallbackUrl: readString('SAML_LOGOUT_CALLBACK_URL', ''),
  },

  /**
   * Session secret for signing cookies.
   * WARNING: The fallback value is INSECURE and must never be used in
   * production. In ACA, set SESSION_SECRET as a Key Vault reference:
   *   @Microsoft.KeyVault(SecretUri=https://kv-cgd-{env}.vault.azure.net/secrets/SESSION_SECRET/)
   * The fallback exists only to let the app boot in local dev without
   * requiring every developer to generate a random secret.
   */
  sessionSecret: readString('SESSION_SECRET', '__INSECURE_DEV_ONLY__DO_NOT_USE_IN_PRODUCTION__'),

  /**
   * Microsoft Graph API email configuration.
   * Platform-provided App Registration with Mail.Send permission.
   * Falls back to SMTP (from email_config table) when Graph is not configured.
   */
  mail: {
    graph: {
      enabled: readString('MAIL_GRAPH_ENABLED', '').toLowerCase() === 'true',
      tenantId: readString('MAIL_GRAPH_TENANT_ID', ''),
      clientId: readString('MAIL_GRAPH_CLIENT_ID', ''),
      clientSecret: readString('MAIL_GRAPH_CLIENT_SECRET', ''),
      userId: readString('MAIL_GRAPH_USER_ID', ''),
      fromAddress: readString('MAIL_GRAPH_FROM_ADDRESS', 'noreply@dompe.com'),
    },
  },

  /**
   * Database migration and seed controls.
   * Guidelines §6/§8: migrations are a CI step, not run at app startup.
   * Seed is Development-only (idempotent).
   */
  db: {
    /** Skip migrations at startup (handled by CI pipeline). */
    skipMigrations: readString('SKIP_MIGRATIONS', 'false').toLowerCase() === 'true',
    /** Enable seed data at startup. Default: only in non-production. */
    seedEnabled: readString('SEED_ENABLED', process.env['NODE_ENV'] !== 'production' ? 'true' : 'false').toLowerCase() === 'true',
  },

  // Azure-specific settings
  applicationInsights: {
    connectionString: azure.appInsightsConnectionString,
  },
  azure: {
    acrName: azure.acrName,
    acrImageTag: azure.acrImageTag,
    region: azure.region,
  },
};
