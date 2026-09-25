export type GuestStatus = 'pending' | 'active' | 'expired' | 'deactivated';

/** Authorization role, assigned by an admin once a user has signed in once. */
export type Role = 'admin' | 'operator' | 'viewer';

/**
 * Directory status.
 *
 * A user is created `pending` at their first SSO login and stays unable to do
 * anything until an admin profiles them — the app opens to everyone in the
 * tenant, but grants nothing by default.
 */
export type UserStatus = 'pending' | 'active' | 'suspended';

export interface Sede {
  id: number;
  code: string;
  name: string;
  city: string;
  address: string | null;
  wlcConfigId: number | null;
  createdAt: string;
  active?: boolean;
  /**
   * Controller parameters. Only sent to admins — an operator picks a site by
   * name and has no use for its address or admin account.
   */
  wlcHost?: string;
  wlcPort?: number;
  wlcSshPort?: number;
  wlcUsername?: string;
  /** The network name the guest types. Sent to everyone: it goes on the credentials. */
  wlcSsid?: string;
}

/** A site as the admin panel sees it, with connectivity diagnostics. */
export interface AdminSede extends Sede {
  active: boolean;
  /**
   * Whether a WLC password is configured (Key Vault or environment). Never the
   * value: an admin reads it on demand, one site at a time (COMPLIANCE.md D4).
   */
  credentialConfigured: boolean;
  credentialEnvVar: string;
  credentialSecretName: string;
  wlcLastCheckAt: string | null;
  wlcLastCheckOk: boolean | null;
  wlcLastCheckError: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Outcome of reloading the WLC passwords from Key Vault. */
export interface WlcReloadResult {
  loaded: string[];
  missing: string[];
  failed: { code: string; error: string }[];
}

/**
 * A person found in Entra ID by the Referente search. Only the display name is
 * sent to the browser; the id is there as a list key.
 */
export interface DirectoryUser {
  id: string;
  displayName: string;
}

/** A directory entry as the admin panel sees it. */
export interface AdminUser {
  id: number;
  subject: string;
  email: string | null;
  displayName: string;
  entraObjectId: string | null;
  role: Role;
  status: UserStatus;
  sedeIds: number[];
  createdAt: string;
  lastLoginAt: string | null;
  profiledAt: string | null;
  profiledBy: string | null;
  /**
   * True when the role comes from the mail-address convention
   * (`admin365-…@dompe.onmicrosoft.com`) rather than from somebody's decision.
   * Role and status are not editable for such an account: a login reapplies the
   * rule, so a change would last until the next request.
   */
  autoAdmin?: boolean;
}

/**
 * A break-glass account, as shown in the admin panel.
 *
 * Read-mostly by design: the panel can enable, disable and unlock, but creating
 * an account or rotating its password stays in the CLI. These credentials bypass
 * Entra and MFA, so a compromised admin session must not be able to mint one.
 */
export interface BreakGlassAccount {
  username: string;
  displayName: string;
  role: string;
  enabled: boolean;
  expiresAt: string | null;
  lockedUntil: string | null;
  failedAttempts: number;
  lastLoginAt: string | null;
  state: 'enabled' | 'disabled' | 'expired' | 'locked';
}

/**
 * Everything the client needs on load: who is signed in, what they may do, and
 * which site they are working on.
 */
export interface SessionContext {
  user: {
    displayName: string;
    email: string;
    role: Role | null;
    status: UserStatus;
    /** null means every site (admin or break-glass). */
    sedeIds: number[] | null;
  };
  sede: Sede | null;
  wlc: WlcConfig | null;
  /** Set when the server had to change something, e.g. a retired site. */
  notice?: string;
}

export interface Guest {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  host: string;
  username: string;
  /** Plaintext password: present ONLY in the create response (one-time). Null otherwise. */
  password: string | null;
  /** One-time plaintext password returned by POST /api/guests. Never persisted. */
  oneTimePassword?: string;
  durationMinutes: number;
  elapsedSeconds: number;
  status: GuestStatus;
  createdAt: string;
  enabledAt: string | null;
  remarks: string | null;
  sedeId: number | null;
}

export interface WlcConfig {
  id: number;
  host: string;
  port: number;
  sshPort: number;
  username: string;
  // WLC password is NOT part of the client contract (§2): it lives in Key Vault
  // (env var per sede) and is resolved server-side.
  wlanSsid: string;
  /** Whether THIS session is bound to the controller. Session state, not a controller property. */
  authenticated: boolean;
  /** Whether the server can reach this controller at all: in service, configured, credentialed. */
  usable?: boolean;
  sedeId: number | null;
}

export interface SmsConfig {
  id: number;
  gatewayType: string | null;
  apiKey: string | null;
  senderId: string | null;
  webhookUrl: string | null;
}

export interface SyncLog {
  id: number;
  timestamp: string;
  action: string;
  method: string;
  url: string | null;
  payload: string | null;
  statusCode: number | null;
}
