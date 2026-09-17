/**
 * Shared application types.
 */
export type GuestStatus = 'pending' | 'active' | 'expired' | 'deactivated';

export interface Sede {
  id: number;
  code: string;
  name: string;
  city: string;
  address: string | null;
  wlcConfigId: number | null;
  createdAt: string;
  /** In service. A site switched off disappears from the selector and the sync. */
  active: boolean;
  /**
   * WLC parameters, folded in from the old 1:1 `wlc_config` table.
   * Null host means the site exists but its controller is not configured yet.
   */
  wlcHost: string | null;
  wlcPort: number;
  wlcSshPort: number;
  wlcUsername: string;
  wlcSsid: string;
}

/**
 * A site as the admin panel sees it, with the diagnostics an operator never
 * needs. The WLC password is absent here as everywhere else: only whether one
 * is configured, and the names to ask the platform team for.
 */
export interface AdminSede extends Sede {
  credentialConfigured: boolean;
  /** Environment variable the password arrives in, e.g. WLC_PASSWORD_MIL. */
  credentialEnvVar: string;
  /** Key Vault secret behind it, e.g. WLC-PASSWORD-MIL. */
  credentialSecretName: string;
  wlcLastCheckAt: string | null;
  wlcLastCheckOk: boolean | null;
  wlcLastCheckError: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface Guest {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  host: string;
  username: string;
  /**
   * Plaintext password is NEVER stored in the DB. It is generated in RAM,
   * pushed to the WLC via SSH, and sent to the guest via SMTP. The
   * `?password=` query param on the create response carries it back to
   * the operator for a one-time display in the UI.
   */
  password: string | null;
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
  password: string;
  wlanSsid: string;
  /**
   * Whether THIS operator's session is bound to the controller. Session state,
   * filled in by the route — not a property of the controller and never read
   * from the database.
   *
   * It used to be a column, shared by every operator and written by a button in
   * the header, which is how pressing "Disconnetti" on one site could switch off
   * provisioning for another.
   */
  authenticated: boolean;
  /**
   * Whether the server can actually talk to this controller: the site is in
   * service, a host is configured, and a password is present in the
   * environment. This is what background jobs and guest pushes branch on.
   */
  usable: boolean;
  sedeId: number;
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
