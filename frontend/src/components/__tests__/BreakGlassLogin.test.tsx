/**
 * Unit tests for the BreakGlassLogin form.
 *
 * The behaviour worth pinning down is what the form does NOT do: it must not
 * surface the backend's error detail (which would differentiate a 401 from a
 * 429, or leak server internals), and it must clear the password field after a
 * failure so a wrong secret is not left sitting in the DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BreakGlassLogin from '../BreakGlassLogin';

const mockApi = vi.hoisted(() => ({ breakGlassLogin: vi.fn() }));
vi.mock('../../api/client', () => ({ api: mockApi }));

vi.mock('../../i18n', () => ({
  useLocale: () => [
    'it',
    vi.fn(),
    (key: string) => {
      const dict: Record<string, string> = {
        'breakglass.heading': 'Accesso di emergenza',
        'breakglass.subtitle': 'Da usare solo quando l\'SSO non è disponibile',
        'breakglass.warning': 'Questo accesso aggira il Single Sign-On e l\'MFA',
        'breakglass.username': 'Utente di emergenza',
        'breakglass.password': 'Password',
        'breakglass.submit': 'Accedi',
        'breakglass.backToSso': 'Torna all\'accesso SSO',
        'breakglass.error': 'Credenziali non valide, account non abilitato o troppi tentativi.',
        'toast.loading': 'Caricamento...',
      };
      return dict[key] ?? key;
    },
  ],
}));

function renderForm(overrides: Partial<{ onAuthenticated: () => void; onCancel: () => void }> = {}) {
  const onAuthenticated = overrides.onAuthenticated ?? vi.fn();
  const onCancel = overrides.onCancel ?? vi.fn();
  render(<BreakGlassLogin onAuthenticated={onAuthenticated} onCancel={onCancel} />);
  return { onAuthenticated, onCancel };
}

async function fillAndSubmit(username = 'bg.operator', password = 'a-long-test-password') {
  await userEvent.type(screen.getByTestId('breakglass-username'), username);
  await userEvent.type(screen.getByTestId('breakglass-password'), password);
  await userEvent.click(screen.getByTestId('breakglass-submit'));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BreakGlassLogin', () => {
  it('renders the heading and the audit warning', () => {
    renderForm();
    expect(screen.getByText('Accesso di emergenza')).toBeInTheDocument();
    expect(screen.getByText(/aggira il Single Sign-On/)).toBeInTheDocument();
  });

  it('masks the password field', () => {
    renderForm();
    expect(screen.getByTestId('breakglass-password')).toHaveAttribute('type', 'password');
  });

  it('submits the credentials and reports success upwards', async () => {
    mockApi.breakGlassLogin.mockResolvedValue({
      success: true,
      data: { nameID: 'bg.operator', authMethod: 'breakglass' },
    });
    const { onAuthenticated } = renderForm();

    await fillAndSubmit();

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
    expect(mockApi.breakGlassLogin).toHaveBeenCalledWith({
      username: 'bg.operator',
      password: 'a-long-test-password',
    });
  });

  it('shows the generic error and does not authenticate on failure', async () => {
    mockApi.breakGlassLogin.mockRejectedValue(new Error('401 Unauthorized: whatever'));
    const { onAuthenticated } = renderForm();

    await fillAndSubmit();

    expect(await screen.findByTestId('breakglass-error')).toBeInTheDocument();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('never renders the backend error detail', async () => {
    mockApi.breakGlassLogin.mockRejectedValue(
      new Error('429 Too Many Requests: {"error":"Credenziali non valide."}'),
    );
    renderForm();

    await fillAndSubmit();

    const banner = await screen.findByTestId('breakglass-error');
    expect(banner.textContent).toBe('Credenziali non valide, account non abilitato o troppi tentativi.');
    expect(banner.textContent).not.toContain('429');
  });

  it('clears the password field after a failed attempt', async () => {
    mockApi.breakGlassLogin.mockRejectedValue(new Error('401'));
    renderForm();

    await fillAndSubmit();

    await screen.findByTestId('breakglass-error');
    expect(screen.getByTestId('breakglass-password')).toHaveValue('');
    // The username survives so the operator can just retype the password.
    expect(screen.getByTestId('breakglass-username')).toHaveValue('bg.operator');
  });

  it('re-enables the submit button after a failure', async () => {
    mockApi.breakGlassLogin.mockRejectedValue(new Error('401'));
    renderForm();

    await fillAndSubmit();

    await screen.findByTestId('breakglass-error');
    expect(screen.getByTestId('breakglass-submit')).not.toBeDisabled();
  });

  it('calls onCancel from the back link', async () => {
    const { onCancel } = renderForm();
    await userEvent.click(screen.getByTestId('breakglass-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
