/**
 * Thin API client for the backend.
 * Base path is `/api` in dev (Vite proxy) and prod (same origin).
 */
import type { Guest, WlcConfig, SmsConfig, SyncLog, GuestStatus, Sede } from '../types';

const BASE = '/api';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, `${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

/**
 * The authenticated operator, from either SSO or the break-glass login.
 * `authMethod` drives the emergency-access banner in the dashboard.
 */
export interface SamlUser {
  nameID: string;
  email: string;
  displayName: string;
  givenName: string;
  surname: string;
  objectId: string | null;
  authMethod?: 'saml' | 'breakglass';
}

export const api = {
  health: () => request<{ status: string }>('/health'),

  // Auth (SSO SAML via Entra ID)
  /**
   * Check if the user is authenticated via SSO.
   * Returns the user profile on 200, rejects with 401 if not authenticated,
   * rejects with 404 if SSO is not configured.
   */
  getMe: () => request<{ success: boolean; data: SamlUser }>('/auth/me'),
  /** Logout from SSO — destroys the session. */
  logout: () => request<{ success: boolean }>('/auth/logout', { method: 'POST' }),

  // Break-glass (emergency local login, used when Entra ID / SSO is down)
  /**
   * Whether the emergency login is available to this client. The backend
   * answers `false` both when the feature is switched off and when the caller
   * is outside the configured CIDR allowlist, so the link is only ever shown
   * to someone who could actually use it.
   */
  breakGlassStatus: () =>
    request<{ success: boolean; data: { enabled: boolean } }>('/auth/breakglass/status'),
  /**
   * Emergency username/password login. On failure the backend deliberately
   * returns one generic message for every reason (unknown user, wrong
   * password, locked, disabled, expired) — do not try to interpret it.
   */
  breakGlassLogin: (body: { username: string; password: string }) =>
    request<{ success: boolean; data: SamlUser & { sessionTtlMinutes: number } }>(
      '/auth/breakglass/login',
      { method: 'POST', body: JSON.stringify(body) },
    ),

  // Sedi
  listSedi: () => request<{ data: Sede[] }>('/sedi'),
  getSede: (id: number) => request<{ data: Sede }>(`/sedi/${id}`),

  // WLC
  wlcLogin: (body: { host: string; port: number; username: string; sedeId?: number }) =>
    request<{ success: boolean; status?: number; message?: string; error?: string; isUnreachable?: boolean; authMethod?: string }>(
      '/wlc/login',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  wlcCreateUser: (body: unknown) =>
    request<{ success: boolean; status?: number; method?: string; message?: string; error?: string }>(
      '/wlc/create-user',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  wlcStatusUser: (body: unknown) =>
    request<{ success: boolean; status?: number; message?: string; error?: string }>(
      '/wlc/status-user',
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  wlcDeleteUser: (body: unknown) =>
    request<{ success: boolean; status?: number; message?: string; error?: string }>(
      '/wlc/delete-user',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  wlcGetUsers: (body: unknown) =>
    request<{ success: boolean; data?: { 'webauth-local-users': { username: string }[] }; error?: string }>(
      '/wlc/get-users',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  // Guests
  listGuests: (filter?: { search?: string; status?: GuestStatus | 'all'; sedeId?: number | null }) => {
    const params = new URLSearchParams();
    if (filter?.search) params.set('search', filter.search);
    if (filter?.status && filter.status !== 'all') params.set('status', filter.status);
    if (filter?.sedeId != null) params.set('sedeId', String(filter.sedeId));
    return request<{ data: Guest[] }>(`/guests?${params.toString()}`);
  },
  createGuest: (body: Partial<Guest>) => request<{ data: Guest }>('/guests', { method: 'POST', body: JSON.stringify(body) }),
  updateGuest: (id: string, patch: Partial<Guest>) =>
    request<{ data: Guest }>(`/guests/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteGuest: (id: string) => request<{ success: boolean }>(`/guests/${id}`, { method: 'DELETE' }),
  resendCredentials: (id: string) =>
    request<{ success: boolean; oneTimePassword: string; wlcUpdated: boolean; emailSent: boolean; emailMode: 'graph' | 'demo-log' }>(
      `/guests/${id}/resend-credentials`,
      { method: 'POST' },
    ),

  // Configs
  getWlcConfig: () => request<{ data: WlcConfig }>('/config/wlc'),
  updateWlcConfig: (patch: Partial<WlcConfig>) =>
    request<{ data: WlcConfig }>('/config/wlc', { method: 'PUT', body: JSON.stringify(patch) }),
  // Email/SMTP config removed (§3): mail is Graph-only, no client config.
  getSmsConfig: () => request<{ data: SmsConfig }>('/config/sms'),
  updateSmsConfig: (patch: Partial<SmsConfig>) =>
    request<{ data: SmsConfig }>('/config/sms', { method: 'PUT', body: JSON.stringify(patch) }),

  // Logs
  listSyncLogs: () => request<{ data: SyncLog[] }>('/sync-logs'),
  clearSyncLogs: () => request<{ success: boolean }>('/sync-logs', { method: 'DELETE' }),
};
