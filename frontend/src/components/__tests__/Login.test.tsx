/**
 * Unit tests for Login component (SedeSelector + SedeWlcForm + demo sandbox).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Login from '../Login';

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('../../i18n', () => ({
  useLocale: () => [
    'it',
    vi.fn(),
    (key: string, params?: Record<string, string | number>) => {
      const dict: Record<string, string> = {
        'login.heading': 'Accesso al Wireless LAN Controller',
        'login.subtitle': 'Autenticati al WLC',
        'login.host': 'Host / IP Controller',
        'login.port': 'Porta HTTPS',
        'login.sshPort': 'Porta SSH',
        'login.username': 'Username amministratore',
        'login.password': 'Password amministratore',
        'login.ssid': 'WLAN SSID',
        'login.submit': 'Connetti al WLC',
        'login.error.creds': 'Credenziali WLC errate.',
        'login.error.unreachable': 'WLC non raggiungibile.',
        'login.sede.heading': 'Seleziona la sede',
        'login.sede.subtitle': 'Scegli la sede operativa.',
        'login.sede.empty': 'Nessuna sede configurata.',
        'login.sede.changeSede': 'Cambia sede',
        'login.demo.title': 'WLC NON RAGGIUNGIBILE',
        'login.demo.detail': 'Il controller non ha risposto.',
        'login.demo.edit': 'Modifica Parametri',
        'login.demo.enable': 'Abilita Demo Sandbox',
        'login.corporateConsole': 'Corporate Console',
        'login.or': 'oppure',
        'login.demo.enter': 'Entra in Demo Sandbox',
        'login.demo.description': 'Salta il login WLC.',
        'login.bullet.locations': '5 sedi disponibili',
        'login.bullet.credentials': 'Credenziali temporanee',
        'login.bullet.sync': 'Sincronizzazione WLC',
        'app.title': 'Dompè Guest Desk',
        'app.subtitle': 'Gestione Account Ospiti Wi-Fi',
        'toast.loading': 'Caricamento...',
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

const mockListSedi = vi.fn();
const mockWlcLogin = vi.fn();

vi.mock('../../api/client', () => ({
  api: {
    listSedi: (...args: unknown[]) => mockListSedi(...args),
    wlcLogin: (...args: unknown[]) => mockWlcLogin(...args),
  },
}));

// ── Test data ──────────────────────────────────────────────────────────────

const sedi = [
  { id: 1, code: 'MI', name: 'Milano', city: 'Milano', address: 'Via Roma 1', wlcConfigId: 1, createdAt: '2025-01-01T00:00:00Z', wlcHost: '172.18.106.100', wlcPort: 443, wlcSshPort: 22, wlcSsid: 'Dompe Guest' },
  { id: 2, code: 'AQ', name: 'L\'Aquila', city: 'L\'Aquila', address: null, wlcConfigId: null, createdAt: '2025-01-01T00:00:00Z', wlcHost: '172.18.106.101', wlcPort: 443, wlcSshPort: 22, wlcSsid: 'Dompe Guest AQ' },
];

const ssoUser = {
  nameID: 'user@dompe.com',
  email: 'user@dompe.com',
  displayName: 'Mario Rossi',
  givenName: 'Mario',
  surname: 'Rossi',
  objectId: 'abc-123',
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Login', () => {
  const onAuthenticated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockListSedi.mockResolvedValue({ data: sedi });
    mockWlcLogin.mockResolvedValue({ success: true });
  });

  // ── SedeSelector ─────────────────────────────────────────────────────────

  describe('SedeSelector (initial screen)', () => {
    it('renders the sede heading', async () => {
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => {
        expect(screen.getByText('Seleziona la sede')).toBeInTheDocument();
      });
    });

    it('shows loading state while sedi are loading', () => {
      mockListSedi.mockImplementation(() => new Promise(() => {}));
      render(<Login onAuthenticated={onAuthenticated} />);
      expect(screen.getByText('Caricamento...')).toBeInTheDocument();
    });

    it('renders the sede codes and cities', async () => {
      render(<Login onAuthenticated={onAuthenticated} />);

      await waitFor(() => {
        // Use getAllByText for 'Milano' which appears in multiple elements
        const milanoElements = screen.getAllByText('Milano');
        expect(milanoElements.length).toBeGreaterThanOrEqual(1);
      });
      // L'Aquila only appears once (header badge)
      const aqElements = screen.getAllByText(/L'Aquila/);
      expect(aqElements.length).toBeGreaterThanOrEqual(1);
      // Codes should be unique
      expect(screen.getByText(/MI/)).toBeInTheDocument();
      expect(screen.getByText(/AQ/)).toBeInTheDocument();
    });

    it('shows empty message when no sedi are available', async () => {
      mockListSedi.mockResolvedValue({ data: [] });
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => {
        expect(screen.getByText('Nessuna sede configurata.')).toBeInTheDocument();
      });
    });

    it('shows empty message when listSedi fails', async () => {
      mockListSedi.mockRejectedValue(new Error('Network error'));
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => {
        expect(screen.getByText('Nessuna sede configurata.')).toBeInTheDocument();
      });
    });

    it('shows the brand panel with app title', async () => {
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => {
        expect(screen.getByText('Dompè Guest Desk')).toBeInTheDocument();
      });
    });

    it('shows the corporate console badge', async () => {
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => {
        expect(screen.getByText('Corporate Console')).toBeInTheDocument();
      });
    });

    it('shows the bullet points for features', async () => {
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => {
        expect(screen.getByText('5 sedi disponibili')).toBeInTheDocument();
      });
      expect(screen.getByText('Credenziali temporanee')).toBeInTheDocument();
      expect(screen.getByText('Sincronizzazione WLC')).toBeInTheDocument();
    });

    it('shows the SSO user tag when ssoUser is provided', async () => {
      render(<Login ssoUser={ssoUser} onAuthenticated={onAuthenticated} />);
      await waitFor(() => {
        expect(screen.getByText('Mario Rossi')).toBeInTheDocument();
      });
      expect(screen.getByText('user@dompe.com')).toBeInTheDocument();
    });

    it('navigates to SedeWlcForm when clicking a sede card', async () => {
      const user = userEvent.setup();
      render(<Login onAuthenticated={onAuthenticated} />);

      await waitFor(() => {
        expect(screen.getByText(/MI/)).toBeInTheDocument();
      });

      // Click the first button containing MI code
      const sedeBtns = screen.getAllByRole('button').filter((btn) => btn.textContent?.includes('MI'));
      expect(sedeBtns.length).toBeGreaterThanOrEqual(1);
      await user.click(sedeBtns[0]);

      await waitFor(() => {
        expect(screen.getByText('Accesso al Wireless LAN Controller')).toBeInTheDocument();
      });
    });
  });

  // ── SedeWlcForm ─────────────────────────────────────────────────────────

  describe('SedeWlcForm (WLC credentials)', () => {
    beforeEach(async () => {
      const user = userEvent.setup();
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => {
        // Wait for sedi to render using a unique selector
        expect(screen.getByText(/MI/)).toBeInTheDocument();
      });
      // Click first sede button
      const sedeBtns = screen.getAllByRole('button').filter((btn) => btn.textContent?.includes('MI'));
      if (sedeBtns.length > 0) {
        await user.click(sedeBtns[0]);
      }
      await waitFor(() => {
        expect(screen.getByText('Accesso al Wireless LAN Controller')).toBeInTheDocument();
      });
    });

    it('renders the WLC form with pre-filled host from sede', () => {
      expect(screen.getByDisplayValue('172.18.106.100')).toBeInTheDocument();
    });

    it('has pre-filled default values for username and SSID', () => {
      expect(screen.getByDisplayValue('admin_guest')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Dompe Guest')).toBeInTheDocument();
    });

    it('shows the back button to return to sede selection', async () => {
      const user = userEvent.setup();
      // The button has '← Cambia sede' — use regex to ignore the arrow
      const backBtn = screen.getByText(/Cambia sede/);
      expect(backBtn).toBeInTheDocument();

      await user.click(backBtn);
      await waitFor(() => {
        expect(screen.getByText('Seleziona la sede')).toBeInTheDocument();
      });
    });

    it('calls wlcLogin with correct params on submit', async () => {
      const user = userEvent.setup();

      // The WLC password is no longer entered in the UI (§2) — it is resolved
      // server-side from Key Vault by sede. The form submits connection params only.
      await user.click(screen.getByText('Connetti al WLC'));

      await waitFor(() => {
        expect(mockWlcLogin).toHaveBeenCalledWith({
          host: '172.18.106.100',
          port: 443,
          username: 'admin_guest',
          sedeId: 1,
        });
      });
    });

    it('calls onAuthenticated on successful login', async () => {
      const user = userEvent.setup();
      await user.click(screen.getByText('Connetti al WLC'));

      await waitFor(() => {
        expect(onAuthenticated).toHaveBeenCalledOnce();
      });
    });

    it('shows credential error when login returns failure', async () => {
      mockWlcLogin.mockResolvedValue({ success: false, error: 'Credenziali WLC errate.', isUnreachable: false });

      const user = userEvent.setup();
      await user.click(screen.getByText('Connetti al WLC'));

      await waitFor(() => {
        expect(screen.getByText('Credenziali WLC errate.')).toBeInTheDocument();
      });
    });

    it('shows demo sandbox prompt when WLC is unreachable', async () => {
      mockWlcLogin.mockResolvedValue({ success: false, error: 'WLC non raggiungibile.', isUnreachable: true });

      const user = userEvent.setup();
      await user.click(screen.getByText('Connetti al WLC'));

      await waitFor(() => {
        expect(screen.getByText('WLC NON RAGGIUNGIBILE')).toBeInTheDocument();
      });
    });
  });

  // ── Demo Sandbox Modal ──────────────────────────────────────────────────

  describe('Demo Sandbox Modal', () => {
    async function setupAndTriggerUnreachable() {
      mockWlcLogin.mockResolvedValue({ success: false, error: 'WLC non raggiungibile.', isUnreachable: true });
      const user = userEvent.setup();
      render(<Login onAuthenticated={onAuthenticated} />);

      await waitFor(() => expect(screen.getByText(/MI/)).toBeInTheDocument());
      const sedeBtns = screen.getAllByRole('button').filter((btn) => btn.textContent?.includes('MI'));
      if (sedeBtns.length > 0) await user.click(sedeBtns[0]);
      await waitFor(() => expect(screen.getByText('Accesso al Wireless LAN Controller')).toBeInTheDocument());

      await user.click(screen.getByText('Connetti al WLC'));
      await waitFor(() => expect(screen.getByText('WLC NON RAGGIUNGIBILE')).toBeInTheDocument());
      return user;
    }

    it('renders the demo sandbox modal with enable and edit buttons', async () => {
      await setupAndTriggerUnreachable();
      expect(screen.getByText('Abilita Demo Sandbox')).toBeInTheDocument();
      expect(screen.getByText('Modifica Parametri')).toBeInTheDocument();
    });

    it('calls onAuthenticated when demo is enabled', async () => {
      const user = await setupAndTriggerUnreachable();
      await user.click(screen.getByText('Abilita Demo Sandbox'));

      expect(onAuthenticated).toHaveBeenCalledOnce();
      expect(onAuthenticated).toHaveBeenCalledWith(
        expect.objectContaining({ authenticated: false }),
        expect.objectContaining({ id: 1 }),
      );
    });

    it('closes the demo modal when edit is clicked', async () => {
      const user = await setupAndTriggerUnreachable();
      await user.click(screen.getByText('Modifica Parametri'));

      await waitFor(() => {
        expect(screen.queryByText('WLC NON RAGGIUNGIBILE')).not.toBeInTheDocument();
      });
    });
  });

  // ── Demo Sandbox via dev link ───────────────────────────────────────────
  // Note: import.meta.env.DEV is automatically true in vitest, so the
  // dev-only demo shortcut link is visible in tests without any stubbing.

  describe('Demo Sandbox (dev mode shortcut)', () => {
    it('shows the demo sandbox link after selecting a sede', async () => {
      const user = userEvent.setup();
      render(<Login onAuthenticated={onAuthenticated} />);

      await waitFor(() => expect(screen.getByText(/MI/)).toBeInTheDocument());
      const sedeBtns = screen.getAllByRole('button').filter((btn) => btn.textContent?.includes('MI'));
      if (sedeBtns.length > 0) await user.click(sedeBtns[0]);

      await waitFor(() => {
        expect(screen.getByText('Entra in Demo Sandbox')).toBeInTheDocument();
      });
    });

    it('enters demo sandbox when dev link is clicked', async () => {
      const user = userEvent.setup();
      render(<Login onAuthenticated={onAuthenticated} />);

      await waitFor(() => expect(screen.getByText(/MI/)).toBeInTheDocument());
      const sedeBtns = screen.getAllByRole('button').filter((btn) => btn.textContent?.includes('MI'));
      if (sedeBtns.length > 0) await user.click(sedeBtns[0]);

      await waitFor(() => {
        expect(screen.getByText('Entra in Demo Sandbox')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Entra in Demo Sandbox'));
      expect(onAuthenticated).toHaveBeenCalledOnce();
      expect(onAuthenticated).toHaveBeenCalledWith(
        expect.objectContaining({ authenticated: false }),
        expect.objectContaining({ id: 1 }),
      );
    });
  });
});
