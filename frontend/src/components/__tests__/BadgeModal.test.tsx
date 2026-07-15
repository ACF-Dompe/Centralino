/**
 * Unit tests for BadgeModal component.
 *
 * Tests rendering with guest data, email config loading, and send action.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BadgeModal from '../BadgeModal';

// Mock i18n
vi.mock('../../i18n', () => ({
  useLocale: () => [
    'it',
    vi.fn(),
    (key: string, params?: Record<string, string | number>) => {
      const dict: Record<string, string> = {
        'modal.guest': 'Ospite',
        'modal.email.defaultSubject': 'Abilitazione Password Wi-Fi Ospiti',
        'modal.email.defaultBody': 'Gentile ospite, di seguito le credenziali per accedere alla rete Wi-Fi {ssid}.',
        'modal.email.from': 'Mittente',
        'modal.email.to': 'Destinatario',
        'modal.email.subject': 'Oggetto',
        'modal.email.body': 'Messaggio',
        'modal.email.send': 'Invia Email',
        'modal.email.sending': 'Invio in corso...',
        'modal.email.sent': 'Email inviata correttamente',
        'modal.email.failed': 'Invio email fallito.',
        'modal.email.noEmail': 'Nessuna email registrata',
        'modal.notAvailable': '(non disponibile)',
        'modal.badge.durationLabel': 'Durata',
        'modal.badge.hostLabel': 'Referente',
        'time.formatMinutes': '{n} min',
        'time.formatHour': '1 ora',
        'time.formatHours': '{n} ore',
        'time.formatDay': '1 giorno',
        'time.formatDays': '{n} giorni',
        'time.formatMonths': '{n} mesi',
        'time.formatYears': '{n} anni',
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

// Mock API
const mockGetEmailConfig = vi.fn();
const mockResendCredentials = vi.fn();

vi.mock('../../api/client', () => ({
  api: {
    getEmailConfig: (...args: unknown[]) => mockGetEmailConfig(...args),
    resendCredentials: (...args: unknown[]) => mockResendCredentials(...args),
  },
}));

const guest = {
  id: 'g-001',
  name: 'Mario Rossi',
  email: 'mario@example.com',
  phone: '+39 333 1234567',
  company: 'ACME Corp',
  host: 'Dr. Smith',
  username: 'g.marior123',
  password: 'DOMPE-4321',
  durationMinutes: 240,
  elapsedSeconds: 0,
  status: 'active' as const,
  createdAt: '2025-01-01T00:00:00Z',
  enabledAt: '2025-01-01T00:00:00Z',
  remarks: null,
  sedeId: 1,
};

describe('BadgeModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEmailConfig.mockResolvedValue({
      data: { smtpHost: 'smtp.dompe.com', smtpPort: 587, sender: 'noreply@dompe.com', encryption: 'starttls', requireAuth: true, username: 'admin', password: '', id: 1 },
    });
    mockResendCredentials.mockResolvedValue({ emailSent: true });
  });

  it('renders the guest name and company', async () => {
    render(<BadgeModal guest={guest} ssid="Dompe Guest" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Mario Rossi')).toBeInTheDocument();
    });
    expect(screen.getByText(/ACME Corp/)).toBeInTheDocument();
  });

  it('displays the email config sender after loading', async () => {
    render(<BadgeModal guest={guest} ssid="Dompe Guest" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('noreply@dompe.com')).toBeInTheDocument();
    });
  });

  it('shows the guest email as recipient', async () => {
    render(<BadgeModal guest={guest} ssid="Dompe Guest" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('mario@example.com')).toBeInTheDocument();
    });
  });

  it('shows the default email subject', async () => {
    render(<BadgeModal guest={guest} ssid="Dompe Guest" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Abilitazione Password Wi-Fi Ospiti')).toBeInTheDocument();
    });
  });

  it('shows the badge body with credentials', async () => {
    render(<BadgeModal guest={guest} ssid="Dompe Guest" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Username: g\.marior123/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Password: DOMPE-4321/)).toBeInTheDocument();
  });

  it('calls resendCredentials when send button is clicked', async () => {
    const user = userEvent.setup();
    render(<BadgeModal guest={guest} ssid="Dompe Guest" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Invia Email')).toBeInTheDocument();
    });

    const sendBtn = screen.getByText('Invia Email');
    await user.click(sendBtn);

    expect(mockResendCredentials).toHaveBeenCalledWith('g-001');
  });

  it('shows success message after sending email', async () => {
    const user = userEvent.setup();
    render(<BadgeModal guest={guest} ssid="Dompe Guest" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Invia Email')).toBeInTheDocument();
    });

    const sendBtn = screen.getByText('Invia Email');
    await user.click(sendBtn);

    await waitFor(() => {
      expect(screen.getByText('Email inviata correttamente')).toBeInTheDocument();
    });
  });

  it('shows error message when send fails', async () => {
    mockResendCredentials.mockResolvedValue({ emailSent: false });

    const user = userEvent.setup();
    render(<BadgeModal guest={guest} ssid="Dompe Guest" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Invia Email')).toBeInTheDocument();
    });

    const sendBtn = screen.getByText('Invia Email');
    await user.click(sendBtn);

    await waitFor(() => {
      expect(screen.getByText('Invio email fallito.')).toBeInTheDocument();
    });
  });

  it('calls onClose when close button is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<BadgeModal guest={guest} ssid="Dompe Guest" onClose={onClose} />);

    const closeBtn = screen.getByTestId('badge-modal-close');
    await user.click(closeBtn);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('disables send button when guest has no email', async () => {
    const guestNoEmail = { ...guest, email: null };
    render(<BadgeModal guest={guestNoEmail} ssid="Dompe Guest" onClose={vi.fn()} />);

    await waitFor(() => {
      const sendBtn = screen.getByText('Invia Email');
      expect(sendBtn).toBeDisabled();
    });
  });

  it('shows noEmail warning when guest has no email', async () => {
    const guestNoEmail = { ...guest, email: null };
    render(<BadgeModal guest={guestNoEmail} ssid="Dompe Guest" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Nessuna email registrata')).toBeInTheDocument();
    });
  });

  it('calls getEmailConfig on mount', async () => {
    render(<BadgeModal guest={guest} ssid="Dompe Guest" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(mockGetEmailConfig).toHaveBeenCalledOnce();
    });
  });
});
