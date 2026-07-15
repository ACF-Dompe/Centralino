/**
 * Unit tests for ConfigPanel component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
      expect(screen.getByDisplayValue('smtp.dompe.com')).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('587')).toBeInTheDocument();
    expect(screen.getByDisplayValue('noreply@dompe.com')).toBeInTheDocument();
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
    expect(screen.getByDisplayValue('172.18.106.100')).toBeInTheDocument();
    expect(screen.getByDisplayValue('admin_guest')).toBeInTheDocument();
  });

  it('shows connected status when WLC is authenticated', async () => {
    const user = userEvent.setup();
    render(<ConfigPanel wlcConfig={wlcConfig} onClose={onClose} onWlcConfigUpdate={onWlcConfigUpdate} />);

    // Click WLC nav button first since default section is 'email'
    const wlcNavBtn = screen.getByText('Controller WLC');
    await user.click(wlcNavBtn);

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
});
