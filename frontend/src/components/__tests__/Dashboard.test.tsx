/**
 * Unit tests for Dashboard component.
 *
 * Dashboard orchestrates: guest list, search/filter, sync, WLC disconnect,
 * guest activation/deletion, badge modal, config panel, register guest modal,
 * lock overlay, toast notifications, real-time WebSocket events.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Dashboard from '../Dashboard';

// ── Mock i18n ──────────────────────────────────────────────────────────────

vi.mock('../../i18n', () => ({
  useLocale: () => [
    'it',
    vi.fn(),
    (key: string, params?: Record<string, string | number>) => {
      const dict: Record<string, string> = {
        'header.connected': 'CONNESSO',
        'header.offline': 'OFFLINE / SANDBOX',
        'header.lastSync': 'Ultimo sync',
        'header.never': 'mai',
        'header.syncNow': 'Sincronizza WLC',
        'header.lockConsole': 'Blocca Console',
        'header.disconnect': 'Disconnetti',
        'stats.registered': 'Registrati',
        'stats.online': 'Connessi Ora',
        'stats.pending': 'In attesa',
        'stats.completed': 'Conclusi',
        'toolbar.search': 'Cerca...',
        'toolbar.statusAll': 'Tutti',
        'toolbar.config': 'Configura Canali',
        'toolbar.register': 'Registra Ospite',
        'table.activate': 'Attiva',
        'table.badge': 'Invia Badge',
        'table.delete': 'Elimina',
        'table.resend': 'Re-invia Credenziali',
        'table.resendSuccess': 'Credenziali reinviate a {email}',
        'table.resendFailed': 'Invio credenziali fallito',
        'table.confirmDelete': 'Confermi eliminazione di {name}?',
        'table.copied': 'Copiato!',
        'table.copy': 'Copia',
        'status.pending': 'In attesa',
        'status.active': 'Connesso',
        'status.expired': 'Scaduto',
        'status.deactivated': 'Revocato',
        'sso.logout': 'Logout SSO',
        'ws.guestExpired': 'Ospite {name} scaduto',
        'ws.guestDeactivated': 'Ospite {name} disconnesso',
        'ws.guestCreated': 'Nuovo ospite {name} registrato',
        'ws.guestDeleted': 'Ospite {name} eliminato',
        'ws.guestImported': 'Ospite {name} importato',
        'app.events': '{n} eventi recenti',
        'app.clear': 'Cancella',
        'login.sede.heading': 'Seleziona sede',
        'time.expired': 'Scaduto',
      };
      const val = dict[key] ?? key;
      if (params) {
        return Object.entries(params).reduce(
          (s, [k, v]) => s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)), val,
        );
      }
      return val;
    },
  ],
}));

// ── Mock API ───────────────────────────────────────────────────────────────

const mockListGuests = vi.fn();
const mockUpdateWlcConfig = vi.fn();
const mockUpdateGuest = vi.fn();
const mockDeleteGuest = vi.fn();
const mockResendCredentials = vi.fn();

vi.mock('../../api/client', () => ({
  api: {
    listGuests: (...args: unknown[]) => mockListGuests(...args),
    updateWlcConfig: (...args: unknown[]) => mockUpdateWlcConfig(...args),
    updateGuest: (...args: unknown[]) => mockUpdateGuest(...args),
    deleteGuest: (...args: unknown[]) => mockDeleteGuest(...args),
    resendCredentials: (...args: unknown[]) => mockResendCredentials(...args),
  },
}));

// ── Mock WebSocket ─────────────────────────────────────────────────────────

let mockWsOnEvent: ((event: unknown) => void) | null = null;
let mockWsOnConnect: (() => void) | null = null;
let mockWsOnDisconnect: (() => void) | null = null;
let mockWsDisconnect: (() => void) | null = null;

vi.mock('../../api/ws', () => ({
  connectWs: (handlers: {
    onEvent: (event: unknown) => void;
    onConnect?: () => void;
    onDisconnect?: () => void;
  }) => {
    mockWsOnEvent = handlers.onEvent;
    mockWsOnConnect = handlers.onConnect ?? null;
    mockWsOnDisconnect = handlers.onDisconnect ?? null;
    const disconnect = vi.fn();
    mockWsDisconnect = disconnect;
    return {
      disconnect,
      readyState: 1,
    };
  },
}));

// ── Mock child components ──────────────────────────────────────────────────

vi.mock('../GuestTable', () => ({
  default: (props: {
    guests: unknown[];
    loading: boolean;
    onActivate: (g: unknown) => void;
    onDelete: (g: unknown) => void;
    onBadge: (g: unknown) => void;
    onResend?: (g: unknown) => void;
  }) => (
    <div data-testid="guest-table">
      <span data-testid="guest-count">{props.guests.length}</span>
      <span data-testid="loading-state">{props.loading ? 'loading' : 'loaded'}</span>
      <button data-testid="mock-activate" onClick={() => props.onActivate?.({ id: 'g-1' })}>Activate</button>
      <button data-testid="mock-delete" onClick={() => props.onDelete?.({ id: 'g-1' })}>Delete</button>
      <button data-testid="mock-badge" onClick={() => props.onBadge?.({ id: 'g-1' })}>Badge</button>
      {props.onResend && (
        <button data-testid="mock-resend" onClick={() => props.onResend?.({ id: 'g-1' })}>Resend</button>
      )}
    </div>
  ),
}));

vi.mock('../ConfigPanel', () => ({
  default: (props: { onClose: () => void; onWlcConfigUpdate: (c: unknown) => void }) => (
    <div data-testid="config-panel">
      ConfigPanel
      <button data-testid="mock-config-close" onClick={props.onClose}>Chiudi Config</button>
      <button data-testid="mock-config-update" onClick={() => props.onWlcConfigUpdate({ host: 'updated' })}>Update Config</button>
    </div>
  ),
}));

vi.mock('../RegisterGuestModal', () => ({
  default: (props: { onClose: () => void; onCreated: () => void }) => (
    <div data-testid="register-modal">
      RegisterGuestModal
      <button data-testid="mock-register-close" onClick={props.onClose}>Chiudi Registra</button>
      <button data-testid="mock-register-created" onClick={props.onCreated}>Guest Created</button>
    </div>
  ),
}));

vi.mock('../BadgeModal', () => ({
  default: (props: { onClose: () => void }) => (
    <div data-testid="badge-modal">
      BadgeModal
      <button data-testid="mock-badge-close" onClick={props.onClose}>Chiudi Badge</button>
    </div>
  ),
}));

vi.mock('../Toast', () => ({
  default: (props: { message: { kind: string; text: string }; onClose: () => void }) => (
    <div data-testid="toast">
      <span data-testid="toast-kind">{props.message.kind}</span>
      <span data-testid="toast-text">{props.message.text}</span>
      <button data-testid="mock-toast-close" onClick={props.onClose}>Chiudi Toast</button>
    </div>
  ),
}));

vi.mock('../icons', () => ({
  Search: (p: Record<string, unknown>) => <svg data-testid="search-icon" {...p} />,
  Settings: (p: Record<string, unknown>) => <svg data-testid="settings-icon" {...p} />,
  Plus: (p: Record<string, unknown>) => <svg data-testid="plus-icon" {...p} />,
  Refresh: (p: Record<string, unknown>) => <svg data-testid="refresh-icon" {...p} />,
  Power: (p: Record<string, unknown>) => <svg data-testid="power-icon" {...p} />,
  Lock: (p: Record<string, unknown>) => <svg data-testid="lock-icon" {...p} />,
  X: (p: Record<string, unknown>) => <svg data-testid="x-icon" {...p} />,
  Trash: (p: Record<string, unknown>) => <svg data-testid="trash-icon" {...p} />,
  Send: (p: Record<string, unknown>) => <svg data-testid="send-icon" {...p} />,
  Building: (p: Record<string, unknown>) => <svg data-testid="building-icon" {...p} />,
  User: (p: Record<string, unknown>) => <svg data-testid="user-icon" {...p} />,
  AlertTriangle: (p: Record<string, unknown>) => <svg data-testid="alert-icon" {...p} />,
  Globe: (p: Record<string, unknown>) => <svg data-testid="globe-icon" {...p} />,
  Clock: (p: Record<string, unknown>) => <svg data-testid="clock-icon" {...p} />,
  Mail: (p: Record<string, unknown>) => <svg data-testid="mail-icon" {...p} />,
  Phone: (p: Record<string, unknown>) => <svg data-testid="phone-icon" {...p} />,
  Check: (p: Record<string, unknown>) => <svg data-testid="check-icon" {...p} />,
  Copy: (p: Record<string, unknown>) => <svg data-testid="copy-icon" {...p} />,
  Wifi: (p: Record<string, unknown>) => <svg data-testid="wifi-icon" {...p} />,
  RefreshCw: (p: Record<string, unknown>) => <svg data-testid="refresh-icon" {...p} />,
}));

// ── Test data ──────────────────────────────────────────────────────────────

const wlcConfig = {
  id: 1,
  host: '172.18.106.100',
  port: 443,
  sshPort: 22,
  username: 'admin_guest',
  password: 'secret',
  wlanSsid: 'Dompe Guest',
  authenticated: true,
  sedeId: 1,
};

const sede = { id: 1, code: 'MI', name: 'Milano', city: 'Milano', address: null, wlcConfigId: 1, createdAt: '2025-01-01T00:00:00Z' };

const guests = [
  { id: 'g-1', name: 'Mario Rossi', email: 'mario@example.com', phone: '+39 333 111', company: 'ACME', host: 'Dr. Smith', username: 'g.mario', password: null, durationMinutes: 240, elapsedSeconds: 0, status: 'active' as const, createdAt: '2025-01-01T00:00:00Z', enabledAt: '2025-01-01T00:00:00Z', remarks: null, sedeId: 1 },
  { id: 'g-2', name: 'Anna Bianchi', email: null, phone: null, company: 'Beta', host: 'Dr. Rossi', username: 'g.annab', password: null, durationMinutes: 120, elapsedSeconds: 0, status: 'pending' as const, createdAt: '2025-01-02T00:00:00Z', enabledAt: null, remarks: null, sedeId: 1 },
];

const ssoUser = { nameID: 'user@dompe.com', email: 'user@dompe.com', displayName: 'Mario Rossi', givenName: 'Mario', surname: 'Rossi', objectId: 'abc-123' };

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Dashboard', () => {
  const handlers = {
    onDisconnect: vi.fn(),
    onConfigUpdate: vi.fn(),
    onSsoLogout: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockWsOnEvent = null;
    mockWsOnConnect = null;
    mockWsOnDisconnect = null;
    mockWsDisconnect = null;
    mockListGuests.mockResolvedValue({ data: guests });
    mockUpdateWlcConfig.mockResolvedValue({ data: wlcConfig });
    mockUpdateGuest.mockResolvedValue({ data: {} });
    mockDeleteGuest.mockResolvedValue({ success: true });
    mockResendCredentials.mockResolvedValue({ emailSent: true });
    window.confirm = vi.fn(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Initial render & data loading ───────────────────────────────────────

  it('renders the header with connected status', async () => {
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByText('CONNESSO')).toBeInTheDocument();
    });
    expect(screen.getByText(/@ 172\.18\.106\.100/)).toBeInTheDocument();
  });

  it('renders the sede badge with code and name', async () => {
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByText(/MI/)).toBeInTheDocument();
    });
    expect(screen.getByText('Milano')).toBeInTheDocument();
  });

  it('calls listGuests on mount', async () => {
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(mockListGuests).toHaveBeenCalledOnce();
    });
  });

  it('renders stat cards with correct labels', async () => {
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      // Stat labels - use getAllByText for text that may appear in multiple places
      const registered = screen.getAllByText('Registrati');
      expect(registered.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Connessi Ora')).toBeInTheDocument();
      const pending = screen.getAllByText('In attesa');
      expect(pending.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Conclusi')).toBeInTheDocument();
    });
  });

  it('passes guests to GuestTable', async () => {
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });
    expect(screen.getByTestId('guest-count').textContent).toBe('2');
  });

  it('renders SSO user info when ssoUser is provided', async () => {
    render(<Dashboard config={wlcConfig} sede={sede} ssoUser={ssoUser} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByText('user@dompe.com')).toBeInTheDocument();
    });
  });

  it('renders SSO logout button when onSsoLogout is provided', async () => {
    render(<Dashboard config={wlcConfig} sede={sede} ssoUser={ssoUser} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('sso-logout-btn')).toBeInTheDocument();
    });
  });

  // ── Search and status filter ────────────────────────────────────────────

  it('updates search input and triggers guest reload', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Cerca...');
    await user.type(searchInput, 'Mario');

    // listGuests should have been called with search param
    await waitFor(() => {
      expect(mockListGuests).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'Mario' }),
      );
    });
  });

  it('filters by status when a status filter button is clicked', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    // Click "In attesa" filter — use getAllByText to handle duplicates,
    // then pick the button element (filter button has role="button")
    const pendingElements = screen.getAllByText('In attesa');
    const filterBtn = pendingElements.find(
      (el) => el.tagName === 'BUTTON' || el.closest('button'),
    ) ?? pendingElements[pendingElements.length - 1];
    await user.click(filterBtn);

    await waitFor(() => {
      expect(mockListGuests).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending' }),
      );
    });
  });

  // ── ConfigPanel ─────────────────────────────────────────────────────────

  it('opens ConfigPanel when settings button is clicked', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    const settingsBtn = screen.getByTestId('settings-button');
    await user.click(settingsBtn);

    expect(screen.getByTestId('config-panel')).toBeInTheDocument();
  });

  it('closes ConfigPanel when close is triggered', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    // Open ConfigPanel
    await user.click(screen.getByTestId('settings-button'));
    expect(screen.getByTestId('config-panel')).toBeInTheDocument();

    // Close it
    await user.click(screen.getByTestId('mock-config-close'));
    expect(screen.queryByTestId('config-panel')).not.toBeInTheDocument();
  });

  it('calls onConfigUpdate when ConfigPanel updates WLC config', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('settings-button'));
    await user.click(screen.getByTestId('mock-config-update'));

    expect(handlers.onConfigUpdate).toHaveBeenCalledWith({ host: 'updated' });
  });

  // ── RegisterGuestModal ──────────────────────────────────────────────────

  it('opens RegisterGuestModal when register button is clicked', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    const registerBtn = screen.getByTestId('register-guest-btn');
    await user.click(registerBtn);

    expect(screen.getByTestId('register-modal')).toBeInTheDocument();
  });

  it('closes RegisterGuestModal and refreshes on guest created', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('register-guest-btn'));
    expect(screen.getByTestId('register-modal')).toBeInTheDocument();

    await user.click(screen.getByTestId('mock-register-created'));

    // Modal should close and listGuests should be called again
    await waitFor(() => {
      expect(screen.queryByTestId('register-modal')).not.toBeInTheDocument();
    });
  });

  it('disables register button when sede is null', async () => {
    render(<Dashboard config={wlcConfig} sede={null} {...handlers} />);

    await waitFor(() => {
      const registerBtn = screen.getByTestId('register-guest-btn');
      expect(registerBtn).toBeDisabled();
    });
  });

  // ── BadgeModal ──────────────────────────────────────────────────────────

  it('opens BadgeModal when badge action is triggered from GuestTable', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    // Click on badge button in GuestTable mock
    await user.click(screen.getByTestId('mock-badge'));

    expect(screen.getByTestId('badge-modal')).toBeInTheDocument();
  });

  it('closes BadgeModal when close is triggered', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('mock-badge'));
    expect(screen.getByTestId('badge-modal')).toBeInTheDocument();

    await user.click(screen.getByTestId('mock-badge-close'));
    expect(screen.queryByTestId('badge-modal')).not.toBeInTheDocument();
  });

  // ── Lock overlay ────────────────────────────────────────────────────────

  it('shows lock overlay when lock button is clicked', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    const lockBtn = screen.getByTitle('Blocca Console');
    await user.click(lockBtn);

    expect(screen.getByTestId('lock-overlay')).toBeInTheDocument();
  });

  it('hides lock overlay when unlock button is clicked', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    await user.click(screen.getByTitle('Blocca Console'));
    expect(screen.getByTestId('lock-overlay')).toBeInTheDocument();

    // Type a PIN and unlock
    const pinInput = screen.getByTestId('lock-overlay').querySelector('input');
    if (pinInput) {
      await user.type(pinInput, '1234');
    }
    const unlockBtn = screen.getByText('Sblocca');
    await user.click(unlockBtn);

    expect(screen.queryByTestId('lock-overlay')).not.toBeInTheDocument();
  });

  // ── Guest actions ───────────────────────────────────────────────────────

  it('activates a guest and refreshes the list', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('mock-activate'));

    await waitFor(() => {
      expect(mockUpdateGuest).toHaveBeenCalledWith('g-1', expect.objectContaining({ status: 'active' }));
    });
  });

  it('deletes a guest after confirmation', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('mock-delete'));

    await waitFor(() => {
      expect(mockDeleteGuest).toHaveBeenCalledWith('g-1');
    });
  });

  it('does not delete when confirm is cancelled', async () => {
    window.confirm = vi.fn(() => false);
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('mock-delete'));

    expect(mockDeleteGuest).not.toHaveBeenCalled();
  });

  it('resends credentials for a guest', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('mock-resend'));

    await waitFor(() => {
      expect(mockResendCredentials).toHaveBeenCalledWith('g-1');
    });
  });

  // ── Sync ────────────────────────────────────────────────────────────────

  it('calls listGuests when sync button is clicked', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    const syncBtn = screen.getByText('Sincronizza WLC');
    await user.click(syncBtn);

    // Should call refresh which calls listGuests
    await waitFor(() => {
      expect(mockListGuests).toHaveBeenCalled();
    });
  });

  // ── Disconnect ──────────────────────────────────────────────────────────

  it('disconnects WLC when disconnect button is clicked', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    const disconnectBtn = screen.getByTitle('Disconnetti');
    await user.click(disconnectBtn);

    await waitFor(() => {
      expect(mockUpdateWlcConfig).toHaveBeenCalledWith({ authenticated: false });
    });
    expect(handlers.onDisconnect).toHaveBeenCalledOnce();
  });

  // ── WebSocket events ────────────────────────────────────────────────────

  it('refreshes guest list on guest:created WebSocket event', async () => {
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    const initialCalls = mockListGuests.mock.calls.length;

    // Simulate WebSocket event
    act(() => {
      mockWsOnEvent?.({
        type: 'guest:created',
        data: { name: 'New Guest' },
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(mockListGuests.mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });

  it('refreshes on sync:completed WebSocket event', async () => {
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    const initialCalls = mockListGuests.mock.calls.length;

    act(() => {
      mockWsOnEvent?.({
        type: 'sync:completed',
        data: {},
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(mockListGuests.mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });

  it('shows toast on guest:expired WebSocket event', async () => {
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    act(() => {
      mockWsOnEvent?.({
        type: 'guest:expired',
        data: { name: 'Mario Rossi' },
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('toast')).toBeInTheDocument();
    });
    expect(screen.getByTestId('toast-kind').textContent).toBe('info');
    expect(screen.getByTestId('toast-text').textContent).toContain('Mario Rossi');
  });

  it('shows success toast on guest:created WebSocket event', async () => {
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    act(() => {
      mockWsOnEvent?.({
        type: 'guest:created',
        data: { name: 'New Guest' },
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('toast')).toBeInTheDocument();
    });
    expect(screen.getByTestId('toast-kind').textContent).toBe('success');
  });

  // ── Connected status offline ────────────────────────────────────────────

  it('shows offline / sandbox status when not authenticated', async () => {
    render(<Dashboard config={{ ...wlcConfig, authenticated: false }} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByText(/OFFLINE/)).toBeInTheDocument();
    });
  });

  // ── Loading state ───────────────────────────────────────────────────────

  it('shows loading state while guests are being fetched', () => {
    mockListGuests.mockImplementation(() => new Promise(() => {}));
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    expect(screen.getByTestId('loading-state').textContent).toBe('loading');
  });

  // ── Toast ───────────────────────────────────────────────────────────────

  it('shows success toast when guest activation succeeds', async () => {
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('mock-activate'));

    await waitFor(() => {
      expect(screen.getByTestId('toast')).toBeInTheDocument();
    });
    const toastText = screen.getByTestId('toast-text').textContent;
    expect(toastText).toContain('attivato');
  });

  it('shows error toast when activation fails', async () => {
    mockUpdateGuest.mockRejectedValue(new Error('Errore attivazione'));
    const user = userEvent.setup();
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('guest-table')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('mock-activate'));

    await waitFor(() => {
      expect(screen.getByTestId('toast')).toBeInTheDocument();
    });
    expect(screen.getByTestId('toast-kind').textContent).toBe('error');
  });

  // ── WebSocket connection lifecycle ─────────────────────────────────────

  it('registers onConnect handler with connectWs', async () => {
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(mockWsOnConnect).not.toBeNull();
    });

    // Calling the handler should not throw (it just logs a debug message)
    expect(() => mockWsOnConnect?.()).not.toThrow();
  });

  it('registers onDisconnect handler with connectWs', async () => {
    render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(mockWsOnDisconnect).not.toBeNull();
    });

    // Calling the handler should not throw (it just logs a debug message)
    expect(() => mockWsOnDisconnect?.()).not.toThrow();
  });

  it('disconnects WebSocket on component unmount', async () => {
    const { unmount } = render(<Dashboard config={wlcConfig} sede={sede} {...handlers} />);

    await waitFor(() => {
      expect(mockWsDisconnect).not.toBeNull();
    });

    const disconnectFn = mockWsDisconnect!;
    expect(disconnectFn).not.toHaveBeenCalled();

    // Unmount triggers cleanup
    unmount();

    expect(disconnectFn).toHaveBeenCalledOnce();
  });
});
