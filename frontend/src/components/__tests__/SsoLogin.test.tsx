/**
 * Unit tests for SsoLogin component.
 *
 * Tests rendering of SSO login screen with i18n.
 * The component is pure presentational — no API calls, no state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import SsoLogin from '../SsoLogin';

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
      };
      return dict[key] ?? key;
    },
  ],
}));

describe('SsoLogin', () => {
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
});
