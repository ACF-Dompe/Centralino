/**
 * Centralized configuration loaded from environment variables.
 * No secrets are ever hard-coded; defaults are only used to make
 * the demo experience smooth out of the box.
 */
import 'dotenv/config';
import { getCachedWlcPassword } from './utils/wlcPasswordCache.js';

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
 * Entra ID token scope (audience) for Azure Database for PostgreSQL.
 * Single source of truth — used by both the runtime pool (`db/index.ts`) and
 * the migration CLI (`db/migrate.ts`). It lives here (rather than in
 * `db/index.ts`) because `db/index.ts` imports `db/migrate.ts` at runtime:
 * exporting it from there would create a circular import in the migration job.
 */
export const AZURE_DB_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

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
   * Example: http://ca-guestportal-backend-dev.icydune-01234567.westeurope.azurecontainerapps.io
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
     * Whether to verify the WLC SSH host key at all. Default: FALSE.
     *
     * Deliberate operational choice, recorded in COMPLIANCE.md: the five
     * controllers have five different host keys while the expected value
     * below is a single one, so enabling verification would let at most one
     * sede connect and fail the rest closed.
     *
     * SECURITY: with this off the SSH session is not authenticated, so it is
     * exposed to MITM on the path to the controller — and that session carries
     * the WLC admin password and the guest credentials. It is acceptable only
     * because the path is an internal managed network. The app logs a warning
     * the first time it opens an unverified connection, so the state is
     * visible rather than silent.
     *
     * When turning it on, set WLC_SSH_HOST_KEY as well — verification then
     * fails closed if it is missing.
     */
    sshVerifyHostKey: readString('WLC_SSH_VERIFY_HOST_KEY', 'false').toLowerCase() === 'true',
    /**
     * Expected SSH host key (base64 fingerprint or hex), used only when
     * WLC_SSH_VERIFY_HOST_KEY is true. Single-valued today; per-sede keys
     * (WLC_SSH_HOST_KEY_<CODE>) are the follow-up needed before verification
     * can be enabled across all five controllers.
     */
    sshHostKey: readString('WLC_SSH_HOST_KEY', ''),
    /**
     * Whether to reject unauthorized TLS certificates for WLC WebUI connections.
     * Must be true in production; set to false only for local dev with self-signed certs.
     *
     * Fail-closed: defaults to true in production, false in development.
     */
    tlsRejectUnauthorized: readString('WLC_TLS_REJECT_UNAUTHORIZED',
      process.env['NODE_ENV'] === 'production' ? 'true' : 'false').toLowerCase() === 'true',
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
    /**
     * Omit RequestedAuthnContext from the AuthnRequest. Default: true.
     *
     * Must stay true against Entra ID: requesting PasswordProtectedTransport
     * (node-saml's own default) breaks every passwordless sign-in with
     * AADSTS75011. Set to false only for an IdP that requires an explicit
     * authentication context.
     */
    disableRequestedAuthnContext:
      readString('SAML_DISABLE_REQUESTED_AUTHN_CONTEXT', 'true').toLowerCase() === 'true',
    /**
     * Require the <Response> element itself to be signed, not only the
     * <Assertion> inside it. Default: true.
     *
     * Entra IDs default "Signing Option" is **Sign SAML assertion**, which
     * signs the assertion only — and then this requirement makes every login
     * fail with "Invalid document signature". The preferred fix is on the IdP:
     * set the Enterprise Application to "Sign SAML response and assertion",
     * which keeps signature coverage over the whole document. Set this to
     * false only when that setting cannot be changed; the identity claims stay
     * protected either way, because wantAssertionsSigned remains true.
     */
    wantAuthnResponseSigned:
      readString('SAML_WANT_AUTHN_RESPONSE_SIGNED', 'true').toLowerCase() === 'true',
    /** IdP Single Logout endpoint (defaults to entryPoint if not set). */
    logoutUrl: readString('SAML_LOGOUT_URL', ''),
    /**
     * Where the IdP should send the SAML LogoutResponse after SLO.
     * Defaults to the callbackUrl with /callback replaced by /slo/callback.
     */
    logoutCallbackUrl: readString('SAML_LOGOUT_CALLBACK_URL', ''),
  },

  /**
   * Break-glass authentication — a local username/password login that works
   * when Entra ID / SAML SSO is unavailable.
   *
   * SECURITY: this path deliberately bypasses Entra Conditional Access and
   * MFA, and by design carries no second factor. It is a documented, accepted
   * deviation (COMPLIANCE.md) guarded by compensating controls only:
   *   - `enabled` defaults to FALSE — the feature ships dark
   *   - scrypt password hashes in `breakglass_users` (never plaintext)
   *   - per-account lockout in the database (global across ACA replicas)
   *   - per-IP throttling in memory (per replica)
   *   - optional CIDR allowlist — the strongest control available here
   *   - short session TTL, per-account expiry, and audit logging of every
   *     attempt at warn level so Log Analytics can alert on it
   * Accounts are created ONLY through the `breakglass` CLI, never over HTTP.
   */
  breakGlass: {
    /** Master kill switch. Fail-closed: the feature is off unless enabled. */
    enabled: readString('BREAKGLASS_ENABLED', 'false').toLowerCase() === 'true',
    /** Session lifetime for a break-glass login (shorter than the SSO one). */
    sessionTtlMinutes: readNumber('BREAKGLASS_SESSION_TTL_MINUTES', 120),
    /** Consecutive failures before the account is locked. */
    maxFailedAttempts: readNumber('BREAKGLASS_MAX_FAILED_ATTEMPTS', 5),
    /** How long an account stays locked after hitting the threshold. */
    lockoutMinutes: readNumber('BREAKGLASS_LOCKOUT_MINUTES', 15),
    /** Failed attempts allowed per source IP inside the throttle window. */
    maxAttemptsPerIp: readNumber('BREAKGLASS_MAX_ATTEMPTS_PER_IP', 10),
    /** Sliding window for the per-IP throttle. */
    ipWindowMinutes: readNumber('BREAKGLASS_IP_WINDOW_MINUTES', 15),
    /**
     * Comma-separated CIDRs (IPv4/IPv6) allowed to reach the break-glass
     * endpoint. Empty = no network restriction. Strongly recommended: set it
     * to the corporate / VPN egress ranges — with no second factor in play
     * this is the most effective compensating control available.
     */
    ipAllowlist: readString('BREAKGLASS_IP_ALLOWLIST', ''),

    /**
     * Bootstrap account, created by the migration when it does not yet exist.
     *
     * It is what makes the user directory usable at all: every SSO user is
     * created blocked, so somebody has to be able to profile the first admins,
     * and this account is that somebody.
     *
     * SECRET. There is deliberately no default password: an empty value means
     * the account is simply not created (create it with the CLI instead). A
     * built-in default would be a published backdoor, and a generated one would
     * be a password nobody knows.
     */
    seedUsername: readString('BREAKGLASS_SEED_USERNAME', 'bk.guestportal'),
    seedDisplayName: readString('BREAKGLASS_SEED_DISPLAY_NAME', 'Break Glass Guest Portal'),
    seedPassword: readString('BREAKGLASS_SEED_PASSWORD', ''),
  },

  /**
   * Role-based access control.
   *
   * `cacheTtlSeconds` bounds how stale an authorization decision can be. It is
   * kept below the dashboard's 30s poll on purpose: a suspended user loses
   * access at their next automatic refresh, without having to click anything.
   * Lower it to react faster, at the cost of a lookup per request per user.
   *
   * `enforcement` set to 'log-only' records what would have been denied and
   * lets it through — a way to watch a rollout before it can lock anybody out.
   * It is not a default: the code ships enforcing.
   */
  rbac: {
    cacheTtlSeconds: readNumber('RBAC_CACHE_TTL_SECONDS', 15),
    enforcement: readString('RBAC_ENFORCEMENT', 'enforce').toLowerCase() === 'log-only'
      ? ('log-only' as const)
      : ('enforce' as const),

    /**
     * Platform administrators named by convention: `admin365-<anything>` on the
     * tenant's own Microsoft domain. They hold full privileges without anybody
     * profiling them, which is what lets an administrator reach a fresh
     * deployment without going through the break-glass account.
     *
     * SECURITY: this ties full privileges to a string in an address, so the
     * domain restriction is doing real work rather than being belt-and-braces.
     * Without it an Entra guest (B2B) account would match — their UPN belongs to
     * another tenant, so an invited `admin365-x@attacker.com` would arrive as a
     * platform administrator. Pinning the domain to `dompe.onmicrosoft.com`
     * confines the rule to addresses only the tenant itself can create.
     *
     * Both lists are comma-separated and matched case-insensitively. An empty
     * domain list disables the rule outright rather than opening it to every
     * domain: this is the one place where a blank value must not mean "no
     * restriction".
     */
    autoAdminPrefixes: readString('RBAC_AUTO_ADMIN_PREFIXES', 'admin365-'),
    autoAdminDomains: readString('RBAC_AUTO_ADMIN_DOMAINS', 'dompe.onmicrosoft.com'),
  },

  /**
   * Session secret for signing cookies.
   * WARNING: The fallback value is INSECURE and must never be used in
   * production. In ACA, set SESSION_SECRET as a Key Vault reference:
   *   @Microsoft.KeyVault(SecretUri=https://kv-guestportal-{env}.vault.azure.net/secrets/SESSION_SECRET/)
   * The fallback exists only to let the app boot in local dev without
   * requiring every developer to generate a random secret.
   */
  sessionSecret: readString('SESSION_SECRET', '__INSECURE_DEV_ONLY__DO_NOT_USE_IN_PRODUCTION__'),

  /**
   * Microsoft Graph API email configuration.
   * Platform-provided App Registration with Mail.Send permission.
   * Mail is delivered ONLY via Graph (§3); when Graph is not configured
   * (local dev) the credential email is logged to the console (demo-log).
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
   * Live search of the Entra ID directory, used by the "Referente" field.
   *
   * Authenticates as the backend's managed identity (`DefaultAzureCredential`),
   * which needs the Microsoft Graph application permission `User.Read.All`.
   * Off by default: without the permission every search would fail, and the
   * field works as plain text either way.
   *
   * `upnDomains` is matched against the user principal name (comma-separated,
   * case-insensitive), both in the Graph filter and again on the results.
   */
  directory: {
    enabled: readString('DIRECTORY_SEARCH_ENABLED', '').toLowerCase() === 'true',
    upnDomains: readString('DIRECTORY_UPN_DOMAINS', 'dompe.com,ext.dompe.com')
      .split(',')
      .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
      .filter((d) => d.length > 0),
    maxResults: readNumber('DIRECTORY_MAX_RESULTS', 15),
  },

  /**
   * Key Vault holding the per-site WLC passwords (`WLC-PASSWORD-<CODE>`).
   *
   * When set, the backend reads those secrets directly at startup and on
   * "reload", and the admin panel can show and change them (COMPLIANCE.md D4).
   * Reading needs "Key Vault Secrets User" on the backend identity; changing a
   * password needs "Key Vault Secrets Officer" (it can be scoped to the
   * individual secrets). Empty = Key Vault not used; passwords come from the
   * `WLC_PASSWORD_<CODE>` environment variables only.
   */
  keyVault: {
    url: readString('KEY_VAULT_URL', ''),
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
    /** Enable TLS/SSL for database connections. Required by ACA (Azure) but
     *  not supported by bare PostgreSQL Docker containers (e2e CI).
     *  Default: true in production, false in development. */
    sslEnabled: readString('DB_SSL_ENABLED', process.env['NODE_ENV'] === 'production' ? 'true' : 'false').toLowerCase() === 'true',
    /** Validate the server's TLS certificate chain when SSL is enabled.
     *  Azure PostgreSQL presents a certificate chained to a public CA that is
     *  in Node's trust store, so this should stay true in production to prevent
     *  MITM. Set DB_SSL_REJECT_UNAUTHORIZED=false only for a local server with
     *  a self-signed certificate. Fail-closed: defaults to true. */
    sslRejectUnauthorized: readString('DB_SSL_REJECT_UNAUTHORIZED', 'true').toLowerCase() === 'true',
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

/**
 * True for a value that is still a Key Vault reference rather than a secret.
 *
 * Container Apps does not expand the App Service syntax
 * `@Microsoft.KeyVault(...)`, and an unresolved `secretref:` reaches the
 * container as literal text. Either would otherwise be sent to the controller
 * as the password.
 */
function isUnresolvedSecretReference(value: string): boolean {
  const v = value.trim();
  return v.startsWith('@Microsoft.KeyVault') || v.startsWith('secretref:');
}

/**
 * Resolve the WLC admin password for a sede.
 *
 * Per-sede model (§2): one Key Vault secret per site (`WLC-PASSWORD-<CODE>`,
 * environment-agnostic). The password is NEVER read from or written to the DB.
 * Resolution order:
 *   1. the value read from Key Vault (`KEY_VAULT_URL`) at startup, on "reload"
 *      or when an admin changed it — see `services/wlcCredentials.ts`;
 *   2. the env var `WLC_PASSWORD_<CODE>` (Container Apps secret reference),
 *      ignored while it still holds an unresolved reference;
 *   3. `WLC_DEFAULT_PASSWORD` (local dev only).
 * Returns '' when nothing is configured.
 */
export function wlcPasswordForSede(sedeCode: string | null | undefined): string {
  if (sedeCode) {
    const fromVault = getCachedWlcPassword(sedeCode);
    if (fromVault && fromVault.length > 0) return fromVault;

    const key = 'WLC_PASSWORD_' + sedeCode.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const v = process.env[key];
    if (v && v.length > 0 && !isUnresolvedSecretReference(v)) return v;
  }
  return config.wlc.defaultPassword;
}
