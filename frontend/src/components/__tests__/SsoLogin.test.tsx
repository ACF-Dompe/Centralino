/**
 * Unit tests for SsoLogin component.
 *
 * Tests rendering of the SSO login screen with i18n, plus the discreet
 * emergency-access link, which is only rendered when the backend says the
 * break-glass path is usable by this client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SsoLogin from '../SsoLogin';

const mockApi = vi.hoisted(() => ({
  breakGlassStatus: vi.fn(),
  breakGlassLogin: vi.fn(),
}));

vi.mock('../../api/client', () => ({ api: mockApi }));

// Mock i18n
vi.mock('../../i18n', () => ({
  useLocale: () => [
    'it',
    vi.fn(),
    (key: string) => {
      const dict: Record<string, string> = {
        'sso.corporateConsole': 'Single Sign-On',
        'sso.heading': 'Accesso con Single Sign-On',
        'sso.subtitle': 'Autenticati con il tuo account aziendale',
        'sso.loginButton': 'Accedi con SSO',
        'sso.description': 'Verrai reindirizzato a Microsoft Entra ID',
        'app.title': 'Dompè Guest Desk',
        'app.subtitle': 'Gestione Account Ospiti Wi-Fi',
        'login.bullet.locations': '5 sedi disponibili',
        'login.bullet.credentials': 'Credenziali temporanee',
        'login.bullet.sync': 'Sincronizzazione WLC',
        'login.or': 'oppure',
        'breakglass.link': 'Accesso di emergenza',
        'breakglass.heading': 'Accesso di emergenza',
        'breakglass.subtitle': 'Da usare solo quando l\'SSO non è disponibile',
        'breakglass.warning': 'Questo accesso aggira il Single Sign-On',
        'breakglass.username': 'Utente di emergenza',
        'breakglass.password': 'Password',
        'breakglass.submit': 'Accedi',
        'breakglass.backToSso': 'Torna all\'accesso SSO',
        'breakglass.error': 'Credenziali non valide',
      };
      return dict[key] ?? key;
    },
  ],
}));

describe('SsoLogin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: the emergency path is off, matching a healthy production tenant.
    mockApi.breakGlassStatus.mockResolvedValue({ success: true, data: { enabled: false } });
  });

  it('renders the SSO heading', () => {
    render(<SsoLogin />);
    expect(screen.getByText('Accesso con Single Sign-On')).toBeInTheDocument();
  });

  it('renders the SSO subtitle', () => {
    render(<SsoLogin />);
    expect(screen.getByText(/Autenticati con il tuo account aziendale/)).toBeInTheDocument();
  });

  it('renders the SSO login button as a link to /api/auth/login', () => {
    render(<SsoLogin />);
    const loginLink = screen.getByText('Accedi con SSO').closest('a');
    expect(loginLink).toBeInTheDocument();
    expect(loginLink).toHaveAttribute('href', '/api/auth/login');
  });

  it('renders the brand panel with the app title', () => {
    render(<SsoLogin />);
    expect(screen.getByText('Dompè Guest Desk')).toBeInTheDocument();
  });

  it('renders the building icon and corporate console badge', () => {
    render(<SsoLogin />);
    expect(screen.getByText('Single Sign-On')).toBeInTheDocument();
  });

  it('renders bullet points for features', () => {
    render(<SsoLogin />);
    expect(screen.getByText('5 sedi disponibili')).toBeInTheDocument();
    expect(screen.getByText('Credenziali temporanee')).toBeInTheDocument();
    expect(screen.getByText('Sincronizzazione WLC')).toBeInTheDocument();
  });

  it('renders version and year in the footer', () => {
    render(<SsoLogin />);
    const year = new Date().getFullYear();
    expect(screen.getByText(new RegExp(`v1\\.1\\.0.*${year}`, 's'))).toBeInTheDocument();
  });

  it('renders the SSO description paragraph', () => {
    render(<SsoLogin />);
    expect(screen.getByText(/Verrai reindirizzato a Microsoft Entra ID/)).toBeInTheDocument();
  });

  describe('emergency access link', () => {
    it('is hidden when the backend reports the break-glass path as unavailable', async () => {
      render(<SsoLogin />);
      await waitFor(() => expect(mockApi.breakGlassStatus).toHaveBeenCalled());
      expect(screen.queryByTestId('breakglass-link')).not.toBeInTheDocument();
    });

    it('is hidden when the status call fails', async () => {
      mockApi.breakGlassStatus.mockRejectedValue(new Error('network down'));
      render(<SsoLogin />);
      await waitFor(() => expect(mockApi.breakGlassStatus).toHaveBeenCalled());
      expect(screen.queryByTestId('breakglass-link')).not.toBeInTheDocument();
    });

    it('is shown when the backend reports it as available', async () => {
      mockApi.breakGlassStatus.mockResolvedValue({ success: true, data: { enabled: true } });
      render(<SsoLogin />);
      expect(await screen.findByTestId('breakglass-link')).toBeInTheDocument();
    });

    it('swaps the SSO card for the emergency form when clicked', async () => {
      mockApi.breakGlassStatus.mockResolvedValue({ success: true, data: { enabled: true } });
      render(<SsoLogin />);

      await userEvent.click(await screen.findByTestId('breakglass-link'));

      expect(screen.getByTestId('breakglass-form')).toBeInTheDocument();
      expect(screen.queryByText('Accedi con SSO')).not.toBeInTheDocument();
    });

    it('returns to the SSO card when the emergency form is cancelled', async () => {
      mockApi.breakGlassStatus.mockResolvedValue({ success: true, data: { enabled: true } });
      render(<SsoLogin />);

      await userEvent.click(await screen.findByTestId('breakglass-link'));
      await userEvent.click(screen.getByTestId('breakglass-cancel'));

      expect(screen.queryByTestId('breakglass-form')).not.toBeInTheDocument();
      expect(screen.getByText('Accedi con SSO')).toBeInTheDocument();
    });

    it('notifies the parent after a successful emergency login', async () => {
      mockApi.breakGlassStatus.mockResolvedValue({ success: true, data: { enabled: true } });
      mockApi.breakGlassLogin.mockResolvedValue({
        success: true,
        data: { nameID: 'bg.operator', authMethod: 'breakglass' },
      });
      const onBreakGlassAuthenticated = vi.fn();
      render(<SsoLogin onBreakGlassAuthenticated={onBreakGlassAuthenticated} />);

      await userEvent.click(await screen.findByTestId('breakglass-link'));
      await userEvent.type(screen.getByTestId('breakglass-username'), 'bg.operator');
      await userEvent.type(screen.getByTestId('breakglass-password'), 'a-long-test-password');
      await userEvent.click(screen.getByTestId('breakglass-submit'));

      await waitFor(() => expect(onBreakGlassAuthenticated).toHaveBeenCalled());
      expect(mockApi.breakGlassLogin).toHaveBeenCalledWith({
        username: 'bg.operator',
        password: 'a-long-test-password',
      });
    });
  });
});
