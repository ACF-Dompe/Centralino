/**
 * Thin API client for the backend.
 * Base path is `/api` in dev (Vite proxy) and prod (same origin).
 */
import type {
  Guest,
  WlcConfig,
  SmsConfig,
  SyncLog,
  GuestStatus,
  Sede,
  AdminSede,
  Role,
  UserStatus,
  AdminUser,
  BreakGlassAccount,
  SessionContext,
} from '../types';

const BASE = '/api';

export class ApiError extends Error {
  status: number;
  /**
   * Application error code from the response body, when the backend sent one
   * (`sede_forbidden`, `CREDENTIAL_MISSING`, …). Without it the only way to
   * tell one refusal from another would be to pattern-match the message text.
   */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    let code: string | undefined;
    let message = `${res.status} ${res.statusText}: ${text}`;
    try {
      const body = JSON.parse(text) as { error?: string; message?: string };
      if (typeof body.error === 'string') code = body.error;
      if (typeof body.message === 'string' && body.message) message = body.message;
    } catch {
      // Not JSON — keep the raw text, which is the most informative thing left.
    }
    throw new ApiError(res.status, message, code);
  }
  // 204 has no body; asking for JSON would throw.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * The authenticated operator, from either SSO or the break-glass login.
 * `authMethod` drives the emergency-access banner in the dashboard.
 */
export interface SamlUser {
  nameID: string;
  /**
   * User principal name — the address an administrator recognises, and the
   * only one an account without a mailbox has. Empty for break-glass.
   */
  upn?: string;
  email: string;
  displayName: string;
  givenName: string;
  surname: string;
  objectId: string | null;
  authMethod?: 'saml' | 'breakglass';
  /**
   * Authorization, resolved server-side per request.
   *
   * Optional because an older backend — or a test mock — will not send it. The
   * UI treats an absent value as "no restriction": hiding buttons is a courtesy
   * to the operator, and the API is what actually enforces anything.
   */
  role?: Role | null;
  status?: UserStatus;
  /** Sites this user may connect to. Always a concrete list, never a wildcard. */
  sedeIds?: number[];
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

  // Session
  /**
   * Everything needed to render the app: the user, their permissions, and the
   * site they are on. Replaces the old three-call bootstrap, which inferred the
   * current site from the WLC config table and could restore the wrong one.
   */
  getSessionContext: () => request<{ data: SessionContext }>('/session/context'),
  /** Release the current site, keeping the session. Backs "Cambia sede". */
  clearSessionSede: () => request<void>('/session/sede', { method: 'DELETE' }),

  // Sedi
  listSedi: () => request<{ data: Sede[] }>('/sedi'),
  getSede: (id: number) => request<{ data: Sede }>(`/sedi/${id}`),

  // WLC
  /**
   * Connect this session to a site's controller.
   *
   * Only the site id travels. Host, port and username used to be sent from
   * here and written straight to the database, which made the login screen a
   * way to reconfigure any controller; they now come from the site record.
   */
  wlcLogin: (body: { sedeId: number }) =>
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
  /** @deprecated Use getSessionContext(). */
  getWlcConfig: () => request<{ data: WlcConfig }>('/config/wlc'),
  // The WLC config PUT is gone: it always wrote to the first row whatever site
  // the operator was on. Site settings are edited through adminApi now.
  // Email/SMTP config removed (§3): mail is Graph-only, no client config.
  getSmsConfig: () => request<{ data: SmsConfig }>('/config/sms'),
  updateSmsConfig: (patch: Partial<SmsConfig>) =>
    request<{ data: SmsConfig }>('/config/sms', { method: 'PUT', body: JSON.stringify(patch) }),

  // Logs
  listSyncLogs: () => request<{ data: SyncLog[] }>('/sync-logs'),
  clearSyncLogs: () => request<{ success: boolean }>('/sync-logs', { method: 'DELETE' }),
};

/**
 * Administrative API. Every call requires the admin role and will answer 403
 * otherwise, so the panel that uses it is only rendered for admins.
 */
export const adminApi = {
  // Users
  listUsers: (filter?: { status?: UserStatus; search?: string }) => {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    if (filter?.search) params.set('search', filter.search);
    const qs = params.toString();
    return request<{ data: AdminUser[] }>(`/admin/users${qs ? `?${qs}` : ''}`);
  },
  patchUser: (id: number, patch: { role?: Role; status?: UserStatus; sedeIds?: number[] }) =>
    request<{ data: AdminUser }>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteUser: (id: number) =>
    request<{ success: boolean }>(`/admin/users/${id}`, { method: 'DELETE' }),

  // Sedi — the unfiltered list, unlike api.listSedi which honours the caller's grants
  listSedi: () => request<{ data: AdminSede[] }>('/admin/sedi'),
  createSede: (body: Partial<AdminSede> & { code: string; name: string; city: string }) =>
    request<{ data: AdminSede }>('/admin/sedi', { method: 'POST', body: JSON.stringify(body) }),
  updateSede: (id: number, body: Partial<AdminSede>) =>
    request<{ data: AdminSede }>(`/admin/sedi/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  setSedeActive: (id: number, active: boolean, force = false) =>
    request<{ data: AdminSede }>(`/admin/sedi/${id}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ active, force }),
    }),
  testSede: (id: number) =>
    request<{ success: boolean; error?: string; isUnreachable?: boolean; checkedAt: string }>(
      `/admin/sedi/${id}/test`,
      { method: 'POST' },
    ),
  deleteSede: (id: number) => request<void>(`/admin/sedi/${id}`, { method: 'DELETE' }),

  // Break glass — read, enable, disable, unlock. Creating an account and
  // rotating its password stay in the CLI (COMPLIANCE.md D1).
  listBreakGlass: () => request<{ data: BreakGlassAccount[] }>('/admin/breakglass'),
  enableBreakGlass: (username: string) =>
    request<{ success: boolean }>(`/admin/breakglass/${encodeURIComponent(username)}/enable`, { method: 'POST' }),
  disableBreakGlass: (username: string) =>
    request<{ success: boolean }>(`/admin/breakglass/${encodeURIComponent(username)}/disable`, { method: 'POST' }),
  unlockBreakGlass: (username: string) =>
    request<{ success: boolean }>(`/admin/breakglass/${encodeURIComponent(username)}/unlock`, { method: 'POST' }),
};
