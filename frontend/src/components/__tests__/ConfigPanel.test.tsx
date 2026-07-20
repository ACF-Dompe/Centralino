/**
 * Unit tests for ConfigPanel component (WLC-only).
 *
 * The SMTP/email section (§3) and the WLC password field + admin-mode gating
 * (§2) have been removed. This panel now only edits WLC connection params and
 * tests connectivity; the WLC password is resolved server-side from Key Vault.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfigPanel from '../ConfigPanel';

// Mock i18n
vi.mock('../../i18n', () => ({
  useLocale: () => [
    'it',
    vi.fn(),
    (key: string) => {
      const dict: Record<string, string> = {
        'config.title': 'Configurazione Canali',
        'config.wlc.title': 'Controller WLC',
        'config.wlc.status': 'Stato connessione',
        'config.wlc.account': 'Account collegato',
        'config.wlc.ssid': 'WLAN SSID',
        'config.wlc.host': 'IP Controller',
        'config.wlc.port': 'Porta HTTPS',
        'config.wlc.test': 'Test Connessione',
        'config.save': 'Salva',
        'config.saved': 'Configurazione salvata.',
        'config.wlc.online': 'Online',
        'config.wlc.offline': 'Offline',
      };
      return dict[key] ?? key;
    },
  ],
}));

// Mock API
const mockUpdateWlcConfig = vi.fn();
const mockWlcLogin = vi.fn();

vi.mock('../../api/client', () => ({
  api: {
    updateWlcConfig: (...args: unknown[]) => mockUpdateWlcConfig(...args),
    wlcLogin: (...args: unknown[]) => mockWlcLogin(...args),
  },
}));

const wlcConfig = {
  id: 1,
  host: '172.18.106.100',
  port: 443,
  sshPort: 22,
  username: 'admin_guest',
  wlanSsid: 'Dompe Guest',
  authenticated: true,
  sedeId: 1,
};

describe('ConfigPanel', () => {
  const onClose = vi.fn();
  const onWlcConfigUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateWlcConfig.mockImplementation((patch: unknown) =>
      Promise.resolve({ data: { ...wlcConfig, ...(patch as object) } }),
    );
    mockWlcLogin.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the config title', () => {
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);
    expect(screen.getByText('Configurazione Canali')).toBeInTheDocument();
  });

  it('renders the WLC section fields', () => {
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);
    expect(screen.getByTestId('wlc-host')).toHaveDisplayValue('172.18.106.100');
    expect(screen.getByTestId('wlc-username')).toHaveDisplayValue('admin_guest');
    expect(screen.getByTestId('wlc-ssid')).toHaveDisplayValue('Dompe Guest');
  });

  it('does NOT render a WLC password field (password is in Key Vault)', () => {
    const { container } = render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it('shows connected status when WLC is authenticated', () => {
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);
    expect(screen.getByText(/Online/)).toBeInTheDocument();
  });

  // ── WLC Test Connection ────────────────────────────────────────────────

  it('calls wlcLogin WITHOUT a password on Test Connessione', async () => {
    const alertMock = vi.fn();
    vi.stubGlobal('alert', alertMock);
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await user.click(screen.getByText('Test Connessione'));

    await waitFor(() => {
      expect(mockWlcLogin).toHaveBeenCalledOnce();
    });
    expect(mockWlcLogin).toHaveBeenCalledWith({
      host: '172.18.106.100',
      port: 443,
      username: 'admin_guest',
      sedeId: 1,
    });
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('updates WLC status on successful connection test', async () => {
    vi.stubGlobal('alert', vi.fn());
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await user.click(screen.getByText('Test Connessione'));

    await waitFor(() => {
      expect(mockUpdateWlcConfig).toHaveBeenCalledWith(
        expect.objectContaining({ authenticated: true }),
      );
    });
    expect(onWlcConfigUpdate).toHaveBeenCalledOnce();
  });

  it('shows alert when connection test fails', async () => {
    mockWlcLogin.mockResolvedValue({ success: false, error: 'WLC timeout' });
    const alertMock = vi.fn();
    vi.stubGlobal('alert', alertMock);
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await user.click(screen.getByText('Test Connessione'));

    await waitFor(() => {
      expect(alertMock).toHaveBeenCalledWith('WLC timeout');
    });
    expect(onWlcConfigUpdate).not.toHaveBeenCalled();
  });

  // ── Save ───────────────────────────────────────────────────────────────

  it('calls updateWlcConfig when save is clicked', async () => {
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await user.click(screen.getByText('Salva'));

    await waitFor(() => {
      expect(mockUpdateWlcConfig).toHaveBeenCalledOnce();
    });
  });

  it('shows saved confirmation after saving', async () => {
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await user.click(screen.getByText('Salva'));

    await waitFor(() => {
      expect(screen.getByText('Configurazione salvata.')).toBeInTheDocument();
    });
    expect(onWlcConfigUpdate).toHaveBeenCalledOnce();
  });

  it('does NOT show saved when updateWlcConfig fails', async () => {
    mockUpdateWlcConfig.mockRejectedValue(new Error('WLC unreachable'));
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await user.click(screen.getByText('Salva'));

    await waitFor(() => {
      expect(mockUpdateWlcConfig).toHaveBeenCalledOnce();
    });
    expect(onWlcConfigUpdate).not.toHaveBeenCalled();
    expect(screen.queryByText('Configurazione salvata.')).not.toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', async () => {
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await user.click(screen.getByTestId('config-panel-close'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
