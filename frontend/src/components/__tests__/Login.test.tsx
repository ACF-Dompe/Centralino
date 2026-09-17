/**
 * Unit tests for the Login component.
 *
 * The component used to be two screens: a site picker followed by a form for
 * the controller's address, ports, admin account and SSID. Those parameters
 * live on the site record now and are edited in the admin panel, so this is a
 * single screen with one job — pick a site and connect to it — and the tests
 * follow that shape.
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
        'login.sede.heading': 'Seleziona la sede',
        'login.sede.subtitle': 'Scegli la sede operativa.',
        'login.sede.empty': 'Nessuna sede configurata.',
        'login.sede.noneAssigned': 'Nessuna sede abilitata per il tuo utente.',
        'login.retry': 'Riprova',
        'login.error.creds': 'Credenziali WLC errate.',
        'login.error.unreachable': 'WLC non raggiungibile.',
        'login.error.unreachableSede': 'WLC di {sede} non raggiungibile.',
        'login.error.credentialMissing': 'Sede {sede} non ancora abilitata: manca la password.',
        'login.error.sedeInactive': 'La sede {sede} è disattivata.',
        'login.error.notConfigured': 'Controller non configurato per la sede {sede}.',
        'login.error.forbidden': 'Non sei abilitato alla sede {sede}.',
        'login.demo.title': 'WLC NON RAGGIUNGIBILE',
        'login.demo.detail': 'Il controller non ha risposto.',
        'login.demo.edit': 'Modifica Parametri',
        'login.demo.enable': 'Abilita Demo Sandbox',
        'login.corporateConsole': 'Corporate Console',
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

class MockApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

vi.mock('../../api/client', () => ({
  api: {
    listSedi: (...args: unknown[]) => mockListSedi(...args),
    wlcLogin: (...args: unknown[]) => mockWlcLogin(...args),
  },
  ApiError: MockApiError,
}));

// ── Test data ──────────────────────────────────────────────────────────────

const sedi = [
  { id: 1, code: 'MI', name: 'Milano', city: 'Milano', address: 'Via Roma 1', wlcConfigId: 1, createdAt: '2025-01-01T00:00:00Z', wlcSsid: 'Dompe Guest' },
  { id: 2, code: 'AQ', name: "L'Aquila", city: "L'Aquila", address: null, wlcConfigId: null, createdAt: '2025-01-01T00:00:00Z', wlcSsid: 'Dompe Guest AQ' },
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

  describe('sede selector', () => {
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
        expect(screen.getAllByText('Milano').length).toBeGreaterThanOrEqual(1);
      });
      expect(screen.getAllByText(/L'Aquila/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByTestId('sede-card-MI')).toBeInTheDocument();
      expect(screen.getByTestId('sede-card-AQ')).toBeInTheDocument();
    });

    /**
     * The controller address used to be printed on every card. An operator has
     * no use for it, and not sending it lets the API withhold it from
     * non-admins entirely.
     */
    it('does not expose the controller address on the cards', async () => {
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => {
        expect(screen.getByTestId('sede-card-MI')).toBeInTheDocument();
      });
      expect(screen.queryByText(/172\.18\.106/)).not.toBeInTheDocument();
      expect(screen.queryByText(/WLC:/)).not.toBeInTheDocument();
    });

    it('shows the empty message when no sedi are configured', async () => {
      mockListSedi.mockResolvedValue({ data: [] });
      render(<Login ssoUser={{ ...ssoUser, role: 'admin' }} onAuthenticated={onAuthenticated} />);
      await waitFor(() => {
        expect(screen.getByText('Nessuna sede configurata.')).toBeInTheDocument();
      });
    });

    /**
     * Distinguished from a configuration problem: an operator granted nothing
     * needs an administrator, not a network engineer. An admin sees every site,
     * so for them an empty list really does mean nothing is configured.
     */
    it('tells a non-admin that no sites are assigned to them', async () => {
      mockListSedi.mockResolvedValue({ data: [] });
      render(<Login ssoUser={{ ...ssoUser, role: 'operator' }} onAuthenticated={onAuthenticated} />);
      await waitFor(() => {
        expect(screen.getByText('Nessuna sede abilitata per il tuo utente.')).toBeInTheDocument();
      });
    });

    it('shows empty message when listSedi fails', async () => {
      mockListSedi.mockRejectedValue(new Error('Network error'));
      render(<Login ssoUser={{ ...ssoUser, role: 'admin' }} onAuthenticated={onAuthenticated} />);
      await waitFor(() => {
        expect(screen.getByText('Nessuna sede configurata.')).toBeInTheDocument();
      });
    });

    it('shows the brand panel', async () => {
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => {
        expect(screen.getByText('Dompè Guest Desk')).toBeInTheDocument();
      });
      expect(screen.getByText('Corporate Console')).toBeInTheDocument();
      expect(screen.getByText('5 sedi disponibili')).toBeInTheDocument();
    });

    /**
     * The tag shows the name only. Entra releases the UPN as the name claim for
     * this tenant, so printing the mail beside it showed the address twice.
     */
    it('shows the user name without repeating the mail address', async () => {
      render(<Login ssoUser={ssoUser} onAuthenticated={onAuthenticated} />);
      await waitFor(() => {
        expect(screen.getByText('Mario Rossi')).toBeInTheDocument();
      });
      expect(screen.queryByText('user@dompe.com')).not.toBeInTheDocument();
      expect(screen.getByTestId('sso-user-tag')).toHaveAttribute('title', 'user@dompe.com');
    });
  });

  describe('connecting to a sede', () => {
    it('connects with the sede id alone, sending no controller parameters', async () => {
      const user = userEvent.setup();
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => expect(screen.getByTestId('sede-card-MI')).toBeInTheDocument());

      await user.click(screen.getByTestId('sede-card-MI'));

      await waitFor(() => {
        expect(mockWlcLogin).toHaveBeenCalledWith({ sedeId: 1 });
      });
    });

    it('calls onAuthenticated with the chosen sede on success', async () => {
      const user = userEvent.setup();
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => expect(screen.getByTestId('sede-card-AQ')).toBeInTheDocument());

      await user.click(screen.getByTestId('sede-card-AQ'));

      await waitFor(() => {
        expect(onAuthenticated).toHaveBeenCalledWith(
          expect.objectContaining({ sedeId: 2, authenticated: true, wlanSsid: 'Dompe Guest AQ' }),
          expect.objectContaining({ code: 'AQ' }),
        );
      });
    });

    it('disables the other cards while a connection is in flight', async () => {
      const user = userEvent.setup();
      mockWlcLogin.mockImplementation(() => new Promise(() => {}));
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => expect(screen.getByTestId('sede-card-MI')).toBeInTheDocument());

      await user.click(screen.getByTestId('sede-card-MI'));

      await waitFor(() => {
        expect(screen.getByTestId('sede-card-AQ')).toBeDisabled();
      });
      expect(screen.getByTestId('sede-card-MI')).toHaveAttribute('aria-busy', 'true');
    });

    it('does not fire a second request on a double click', async () => {
      const user = userEvent.setup();
      mockWlcLogin.mockImplementation(() => new Promise(() => {}));
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => expect(screen.getByTestId('sede-card-MI')).toBeInTheDocument());

      const card = screen.getByTestId('sede-card-MI');
      await user.click(card);
      await user.click(card);

      expect(mockWlcLogin).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Each refusal is somebody different's problem to fix, so each gets its own
   * message rather than a single "connection failed" that leads everywhere and
   * nowhere.
   */
  describe('failure messages', () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['unreachable', { success: false, isUnreachable: true }, /non raggiungibile/],
      ['wrong credentials', { success: false, error: 'invalid', message: 'Credenziali WLC errate.' }, /Credenziali WLC errate/],
      ['missing Key Vault secret', { success: false, error: 'CREDENTIAL_MISSING' }, /manca la password/],
      ['deactivated site', { success: false, error: 'SEDE_INACTIVE' }, /disattivata/],
      ['controller not configured', { success: false, error: 'WLC_NOT_CONFIGURED' }, /non configurato/],
      ['site not granted', { success: false, error: 'sede_forbidden' }, /Non sei abilitato/],
    ];

    for (const [label, response, expected] of cases) {
      it(`reports ${label} on the card`, async () => {
        const user = userEvent.setup();
        mockWlcLogin.mockResolvedValue(response);
        render(<Login onAuthenticated={onAuthenticated} />);
        await waitFor(() => expect(screen.getByTestId('sede-card-MI')).toBeInTheDocument());

        await user.click(screen.getByTestId('sede-card-MI'));

        await waitFor(() => {
          expect(screen.getByTestId('sede-error-MI')).toHaveTextContent(expected);
        });
        expect(onAuthenticated).not.toHaveBeenCalled();
      });
    }

    it('keeps the error on the card that failed', async () => {
      const user = userEvent.setup();
      mockWlcLogin.mockResolvedValue({ success: false, error: 'SEDE_INACTIVE' });
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => expect(screen.getByTestId('sede-card-MI')).toBeInTheDocument());

      await user.click(screen.getByTestId('sede-card-MI'));

      await waitFor(() => expect(screen.getByTestId('sede-error-MI')).toBeInTheDocument());
      expect(screen.queryByTestId('sede-error-AQ')).not.toBeInTheDocument();
    });

    it('offers a retry that reissues the request', async () => {
      const user = userEvent.setup();
      mockWlcLogin.mockResolvedValue({ success: false, isUnreachable: false, error: 'boom' });
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => expect(screen.getByTestId('sede-card-MI')).toBeInTheDocument());

      await user.click(screen.getByTestId('sede-card-MI'));
      await waitFor(() => expect(screen.getByTestId('sede-error-MI')).toBeInTheDocument());

      await user.click(screen.getByText('Riprova'));
      await waitFor(() => expect(mockWlcLogin).toHaveBeenCalledTimes(2));
    });
  });

  /**
   * The sandbox lets a developer work against a controller that is not there.
   * It is gated on import.meta.env.DEV, which vitest sets — in production it
   * would hand an operator a console that looks like it works and provisions
   * nobody.
   */
  describe('demo sandbox (development only)', () => {
    beforeEach(() => {
      mockWlcLogin.mockResolvedValue({ success: false, isUnreachable: true, error: 'timeout' });
    });

    it('offers the sandbox when the controller is unreachable', async () => {
      const user = userEvent.setup();
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => expect(screen.getByTestId('sede-card-MI')).toBeInTheDocument());

      await user.click(screen.getByTestId('sede-card-MI'));

      await waitFor(() => {
        expect(screen.getByText('WLC NON RAGGIUNGIBILE')).toBeInTheDocument();
      });
    });

    it('enters the sandbox unauthenticated, so nothing is pushed to a controller', async () => {
      const user = userEvent.setup();
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => expect(screen.getByTestId('sede-card-MI')).toBeInTheDocument());

      await user.click(screen.getByTestId('sede-card-MI'));
      await waitFor(() => expect(screen.getByText('Abilita Demo Sandbox')).toBeInTheDocument());
      await user.click(screen.getByText('Abilita Demo Sandbox'));

      expect(onAuthenticated).toHaveBeenCalledWith(
        expect.objectContaining({ authenticated: false, sedeId: 1 }),
        expect.objectContaining({ code: 'MI' }),
      );
    });

    it('closes the sandbox prompt without connecting', async () => {
      const user = userEvent.setup();
      render(<Login onAuthenticated={onAuthenticated} />);
      await waitFor(() => expect(screen.getByTestId('sede-card-MI')).toBeInTheDocument());

      await user.click(screen.getByTestId('sede-card-MI'));
      await waitFor(() => expect(screen.getByText('Modifica Parametri')).toBeInTheDocument());
      await user.click(screen.getByText('Modifica Parametri'));

      await waitFor(() => {
        expect(screen.queryByText('WLC NON RAGGIUNGIBILE')).not.toBeInTheDocument();
      });
      expect(onAuthenticated).not.toHaveBeenCalled();
    });
  });
});
