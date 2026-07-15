/**
 * Unit tests for ConfigPanel component.
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
    (key: string, _params?: Record<string, string | number>) => {
      const dict: Record<string, string> = {
        'config.title': 'Configurazione Canali',
        'config.sensitiveHidden': 'I campi sensibili sono nascosti.',
        'config.adminEnable': 'Abilita Modalità Admin',
        'config.adminDisable': 'Disabilita Modalità Admin',
        'config.adminPrompt': 'Inserisci PIN amministratore',
        'config.adminWrongPin': 'PIN errato',
        'config.adminPinEnvHint': 'Definito da VITE_ADMIN_PIN',
        'config.smtp.title': 'Server SMTP (Email)',
        'config.smtp.host': 'Server SMTP',
        'config.smtp.port': 'Porta',
        'config.smtp.sender': 'Mittente',
        'config.smtp.encryption': 'Crittografia',
        'config.smtp.requireAuth': 'Richiedi autenticazione',
        'config.smtp.username': 'Username SMTP',
        'config.smtp.password': 'Password SMTP',
        'config.wlc.title': 'Controller WLC',
        'config.wlc.status': 'Stato connessione',
        'config.wlc.account': 'Account collegato',
        'config.wlc.ssid': 'WLAN SSID',
        'config.wlc.host': 'IP Controller',
        'config.wlc.port': 'Porta HTTPS',
        'config.wlc.password': 'Password WLC',
        'config.wlc.test': 'Test Connessione',
        'config.save': 'Salva',
        'config.saved': 'Configurazione salvata.',
        'config.enc.none': 'Nessuna',
        'config.enc.starttls': 'STARTTLS',
        'config.enc.ssl': 'SSL',
        'config.wlc.online': 'Online',
        'config.wlc.offline': 'Offline',
        'create.cancel': 'Annulla',
      };
      return dict[key] ?? key;
    },
  ],
}));

// Mock API
const mockGetEmailConfig = vi.fn();
const mockUpdateEmailConfig = vi.fn();
const mockUpdateWlcConfig = vi.fn();
const mockWlcLogin = vi.fn();

vi.mock('../../api/client', () => ({
  api: {
    getEmailConfig: (...args: unknown[]) => mockGetEmailConfig(...args),
    updateEmailConfig: (...args: unknown[]) => mockUpdateEmailConfig(...args),
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
  password: 'secret123',
  wlanSsid: 'Dompe Guest',
  authenticated: true,
  sedeId: 1,
};

describe('ConfigPanel', () => {
  const onClose = vi.fn();
  const onWlcConfigUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEmailConfig.mockResolvedValue({
      data: {
        id: 1,
        smtpHost: 'smtp.dompe.com',
        smtpPort: 587,
        sender: 'noreply@dompe.com',
        encryption: 'starttls',
        requireAuth: true,
        username: 'admin',
        password: '',
      },
    });
    mockUpdateWlcConfig.mockImplementation((patch: unknown) =>
      Promise.resolve({ data: { ...wlcConfig, ...(patch as object) } }),
    );
    mockUpdateEmailConfig.mockResolvedValue({ data: {} });
    mockWlcLogin.mockResolvedValue({ success: true });
    // Clear localStorage
    localStorage.removeItem('cgd:adminMode');
  });

  it('renders the config title', async () => {
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      expect(screen.getByText('Configurazione Canali')).toBeInTheDocument();
    });
  });

  it('renders both navigation sections (SMTP and WLC)', async () => {
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      expect(screen.getByText('Server SMTP (Email)')).toBeInTheDocument();
    });
    expect(screen.getByText('Controller WLC')).toBeInTheDocument();
  });

  it('renders the sensitive hidden banner when not in admin mode', async () => {
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      expect(screen.getByText('I campi sensibili sono nascosti.')).toBeInTheDocument();
    });
  });

  it('shows SMTP fields after loading email config', async () => {
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      expect(screen.getByTestId('smtp-host')).toHaveDisplayValue('smtp.dompe.com');
    });
    expect(screen.getByTestId('smtp-port')).toHaveDisplayValue('587');
    expect(screen.getByTestId('smtp-sender')).toHaveDisplayValue('noreply@dompe.com');
  });

  it('switches to WLC section when clicking the WLC nav button', async () => {
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      expect(screen.getByText('Controller WLC')).toBeInTheDocument();
    });

    const wlcNavBtn = screen.getByText('Controller WLC');
    await user.click(wlcNavBtn);

    // WLC fields should be visible
    expect(screen.getByTestId('wlc-host')).toHaveDisplayValue('172.18.106.100');
    expect(screen.getByTestId('wlc-username')).toHaveDisplayValue('admin_guest');
  });

  it('shows connected status when WLC is authenticated', async () => {
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    // Click WLC nav button first since default section is 'email'
    const wlcNavBtn = screen.getByText('Controller WLC');
    await user.click(wlcNavBtn);

    // Use testid to verify WLC section is active, then check status text
    expect(screen.getByTestId('wlc-host')).toHaveDisplayValue('172.18.106.100');
    expect(screen.getByText(/Online/)).toBeInTheDocument();
  });

  it('calls updateWlcConfig when save is clicked', async () => {
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      const submitBtn = screen.getByText('Salva');
      expect(submitBtn).toBeInTheDocument();
    });

    const saveBtn = screen.getByText('Salva');
    await user.click(saveBtn);

    await waitFor(() => {
      expect(mockUpdateWlcConfig).toHaveBeenCalledOnce();
    });
  });

  it('shows saved confirmation after saving', async () => {
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      expect(screen.getByText('Salva')).toBeInTheDocument();
    });

    const saveBtn = screen.getByText('Salva');
    await user.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText('Configurazione salvata.')).toBeInTheDocument();
    });
  });

  it('calls onClose when close button is clicked', async () => {
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      const closeBtn = screen.getByTestId('config-panel-close');
      expect(closeBtn).toBeInTheDocument();
    });

    const closeBtn = screen.getByTestId('config-panel-close');
    await user.click(closeBtn);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('hides password fields when admin mode is disabled', async () => {
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      // The password should show as dots (••••••••)
      const dots = document.querySelectorAll('.text-slate-400');
      const hasDots = Array.from(dots).some((el) => el.textContent?.includes('••••••••'));
      expect(hasDots).toBe(true);
    });
  });

  it('calls getEmailConfig on mount', async () => {
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      expect(mockGetEmailConfig).toHaveBeenCalledOnce();
    });
  });

  it('renders the admin mode toggle button', async () => {
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      expect(screen.getByText('Abilita Modalità Admin')).toBeInTheDocument();
    });
  });

  // ── Admin mode (dev convenience, no PIN) ───────────────────────────────

  it('toggles admin mode on/off when no PIN is configured (dev convenience)', async () => {
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      expect(screen.getByText('I campi sensibili sono nascosti.')).toBeInTheDocument();
    });

    // Enable admin mode
    const toggleBtn = screen.getByText('Abilita Modalità Admin');
    await user.click(toggleBtn);

    // Sensitive banner should disappear
    expect(screen.queryByText('I campi sensibili sono nascosti.')).not.toBeInTheDocument();
    // Button text should change to disable
    expect(screen.getByText('Disabilita Modalità Admin')).toBeInTheDocument();

    // Disable admin mode
    await user.click(screen.getByText('Disabilita Modalità Admin'));
    expect(screen.getByText('Abilita Modalità Admin')).toBeInTheDocument();
    // Banner should reappear
    expect(screen.getByText('I campi sensibili sono nascosti.')).toBeInTheDocument();
  });

  // ── Admin mode with PIN configured ─────────────────────────────────────

  describe('Admin mode with PIN (VITE_ADMIN_PIN set)', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_ADMIN_PIN', '1234');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('shows PIN prompt when clicking admin toggle', async () => {
      const user = userEvent.setup();
      render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

      await waitFor(() => {
        expect(screen.getByText('Abilita Modalità Admin')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Abilita Modalità Admin'));

      // PIN prompt modal should appear
      expect(screen.getByText('Inserisci PIN amministratore')).toBeInTheDocument();
    });

    it('shows error on wrong PIN', async () => {
      const user = userEvent.setup();
      render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

      await waitFor(() => {
        expect(screen.getByText('Abilita Modalità Admin')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Abilita Modalità Admin'));

      // Type wrong PIN using data-testid
      const pinInput = screen.getByTestId('admin-pin-input');
      await user.type(pinInput, '0000');
      await user.click(screen.getByTestId('admin-pin-submit'));

      expect(screen.getByText('PIN errato')).toBeInTheDocument();
      // Admin mode should NOT be enabled (banner still visible)
      await waitFor(() => {
        expect(screen.getByText('I campi sensibili sono nascosti.')).toBeInTheDocument();
      });
    });

    it('enables admin mode on correct PIN', async () => {
      const user = userEvent.setup();
      render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

      await waitFor(() => {
        expect(screen.getByText('I campi sensibili sono nascosti.')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Abilita Modalità Admin'));

      // Type correct PIN using data-testid
      const pinInput = screen.getByTestId('admin-pin-input');
      await user.type(pinInput, '1234');
      await user.click(screen.getByTestId('admin-pin-submit'));

      // Admin mode enabled — banner should disappear
      await waitFor(() => {
        expect(screen.queryByText('I campi sensibili sono nascosti.')).not.toBeInTheDocument();
      });
      expect(screen.getByText('Disabilita Modalità Admin')).toBeInTheDocument();
    });

    it('cancels PIN prompt without enabling admin mode', async () => {
      const user = userEvent.setup();
      render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

      await waitFor(() => {
        expect(screen.getByText('Abilita Modalità Admin')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Abilita Modalità Admin'));
      expect(screen.getByText('Inserisci PIN amministratore')).toBeInTheDocument();

      // Click cancel
      await user.click(screen.getByText('Annulla'));

      // Prompt should close, admin mode NOT enabled
      await waitFor(() => {
        expect(screen.queryByText('Inserisci PIN amministratore')).not.toBeInTheDocument();
      });
      expect(screen.getByText('I campi sensibili sono nascosti.')).toBeInTheDocument();
    });
  });

  // ── Save / API error flows ────────────────────────────────────────────

  it('calls updateEmailConfig before updateWlcConfig when saving', async () => {
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      expect(screen.getByTestId('smtp-host')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Salva'));

    await waitFor(() => {
      // With email loaded, updateEmailConfig is called first, then updateWlcConfig
      expect(mockUpdateEmailConfig).toHaveBeenCalledOnce();
      expect(mockUpdateWlcConfig).toHaveBeenCalledOnce();
      // updateEmailConfig should have been called before updateWlcConfig
      const emailCallOrder = mockUpdateEmailConfig.mock.invocationCallOrder[0];
      const wlcCallOrder = mockUpdateWlcConfig.mock.invocationCallOrder[0];
      expect(emailCallOrder).toBeLessThan(wlcCallOrder);
    });
  });

  it('shows saved confirmation only when both saves succeed', async () => {
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      expect(screen.getByTestId('smtp-host')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Salva'));

    await waitFor(() => {
      expect(screen.getByText('Configurazione salvata.')).toBeInTheDocument();
    });
    expect(onWlcConfigUpdate).toHaveBeenCalledOnce();
  });

  it('does NOT call updateWlcConfig or show saved when updateEmailConfig fails', async () => {
    mockUpdateEmailConfig.mockRejectedValue(new Error('SMTP server unreachable'));
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      expect(screen.getByTestId('smtp-host')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Salva'));

    await waitFor(() => {
      expect(mockUpdateEmailConfig).toHaveBeenCalledOnce();
    });
    // updateWlcConfig should NOT be called because updateEmailConfig threw
    expect(mockUpdateWlcConfig).not.toHaveBeenCalled();
    expect(onWlcConfigUpdate).not.toHaveBeenCalled();
    // saved confirmation should not appear
    expect(screen.queryByText('Configurazione salvata.')).not.toBeInTheDocument();
  });

  it('does NOT call onWlcConfigUpdate or show saved when updateWlcConfig fails', async () => {
    mockUpdateWlcConfig.mockRejectedValue(new Error('WLC unreachable'));
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    await waitFor(() => {
      expect(screen.getByTestId('smtp-host')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Salva'));

    await waitFor(() => {
      expect(mockUpdateEmailConfig).toHaveBeenCalledOnce();
    });

    await waitFor(() => {
      expect(mockUpdateWlcConfig).toHaveBeenCalledOnce();
    });
    // onWlcConfigUpdate and saved are NOT reached because the catch silently ignores
    expect(onWlcConfigUpdate).not.toHaveBeenCalled();
    expect(screen.queryByText('Configurazione salvata.')).not.toBeInTheDocument();
  });
});
