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
  authenticated: boolean;
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
