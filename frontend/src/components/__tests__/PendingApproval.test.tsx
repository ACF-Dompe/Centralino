/**
 * Tests for the screen shown to a user who signed in but cannot act yet.
 *
 * It exists because authentication and authorization are separate here: anyone
 * in the tenant can complete SSO, and the directory grants nothing until an
 * admin profiles the new entry. Without this screen such a user would be sent
 * back to the sign-in page they had just completed, over and over.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PendingApproval from '../PendingApproval';

vi.mock('../../i18n', () => ({
  useLocale: () => [
    'it',
    vi.fn(),
    (key: string) => {
      const dict: Record<string, string> = {
        'pending.title': 'Accesso in attesa di abilitazione',
        'pending.description': 'Un amministratore deve assegnarti un ruolo.',
        'pending.yourAccount': 'Il tuo account',
        'pending.contactAdmin': 'Comunica l\'indirizzo qui sopra.',
        'pending.logout': 'Esci',
        'suspended.title': 'Accesso sospeso',
        'suspended.description': 'Il tuo accesso è stato sospeso.',
        'login.corporateConsole': 'Corporate Console',
        'app.title': 'Dompè Guest Desk',
        'app.subtitle': 'Gestione Account Ospiti Wi-Fi',
      };
      return dict[key] ?? key;
    },
  ],
}));

const user = {
  nameID: 'mario.rossi@dompe.com',
  email: 'mario.rossi@dompe.com',
  displayName: 'Mario Rossi',
  givenName: 'Mario',
  surname: 'Rossi',
  objectId: 'oid-1',
  status: 'pending' as const,
};

describe('PendingApproval', () => {
  it('explains that the account is awaiting approval', () => {
    render(<PendingApproval user={user} onLogout={vi.fn()} />);
    expect(screen.getByTestId('pending-approval')).toBeInTheDocument();
    expect(screen.getByText('Accesso in attesa di abilitazione')).toBeInTheDocument();
  });

  /**
   * The address is on screen because it is what the user has to quote when
   * asking an administrator to enable them.
   */
  it('shows the name and the mail address to quote', () => {
    render(<PendingApproval user={user} onLogout={vi.fn()} />);
    expect(screen.getByText('Mario Rossi')).toBeInTheDocument();
    expect(screen.getByText('mario.rossi@dompe.com')).toBeInTheDocument();
  });

  it('uses different wording for a suspended account', () => {
    render(<PendingApproval user={{ ...user, status: 'suspended' }} onLogout={vi.fn()} />);
    expect(screen.getByText('Accesso sospeso')).toBeInTheDocument();
    expect(screen.queryByText('Accesso in attesa di abilitazione')).not.toBeInTheDocument();
  });

  it('offers a way out', async () => {
    const onLogout = vi.fn();
    const u = userEvent.setup();
    render(<PendingApproval user={user} onLogout={onLogout} />);

    await u.click(screen.getByTestId('pending-logout-btn'));
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('falls back to the nameID when no display name was released', () => {
    render(<PendingApproval user={{ ...user, displayName: '' }} onLogout={vi.fn()} />);
    expect(screen.getAllByText('mario.rossi@dompe.com').length).toBeGreaterThanOrEqual(1);
  });
});
