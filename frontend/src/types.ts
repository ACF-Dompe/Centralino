export type GuestStatus = 'pending' | 'active' | 'expired' | 'deactivated';

export interface Sede {
  id: number;
  code: string;
  name: string;
  city: string;
  address: string | null;
  wlcConfigId: number | null;
  createdAt: string;
  wlcHost?: string;
  wlcPort?: number;
  wlcSshPort?: number;
  wlcSsid?: string;
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
  password: string;
  wlanSsid: string;
  authenticated: boolean;
  sedeId: number | null;
}

export interface EmailConfig {
  id: number;
  smtpHost: string | null;
  smtpPort: number;
  sender: string | null;
  encryption: string | null;
  requireAuth: boolean;
  username: string | null;
  password: string | null;
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
