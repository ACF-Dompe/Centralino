/**
 * Unit tests for RegisterGuestModal component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RegisterGuestModal from '../RegisterGuestModal';

// Mock i18n
vi.mock('../../i18n', () => ({
  useLocale: () => [
    'it',
    vi.fn(),
    (key: string, params?: Record<string, string | number>) => {
      const dict: Record<string, string> = {
        'create.title': 'Registra Nuovo Ospite',
        'create.name': 'Nome completo',
        'create.email': 'Email',
        'create.phone': 'Telefono',
        'create.company': 'Azienda',
        'create.company.default': 'Ospite Individuale',
        'create.host': 'Referente / Sponsor',
        'create.host.placeholder': 'Dr.ssa Maria Rossi',
        'create.duration': 'Durata accesso',
        'create.remarks': 'Note',
        'create.remarks.placeholder': 'Note interne...',
        'create.submit': 'Crea Ospite',
        'create.cancel': 'Annulla',
        'create.oneTimePassword': 'Password temporanea (mostrata una sola volta)',
        'create.oneTimePasswordHelp': 'Copia questa password e comunicala all\'ospite.',
        'create.sedeAuto': 'Sede',
        'create.customDuration': 'Data personalizzata',
        'create.preset.30min': '30 min',
        'create.preset.2h': '2 ore',
        'create.preset.4h': '4 ore',
        'create.preset.8h': '8 ore',
        'create.preset.1d': '1 giorno',
        'create.preset.1w': '1 settimana',
        'create.endAt': 'Scade il',
        'create.pastDate': 'La data di scadenza deve essere nel futuro.',
        'create.tooLong': 'La durata massima è di 1 settimana.',
        'create.durationComputed': 'Durata calcolata',
        'create.emailSent': 'Email inviata a {email}',
        'table.copy': 'Copia',
        'table.copied': 'Copiato!',
        'modal.close': 'Chiudi',
        'modal.notAvailable': '(non disponibile)',
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

// Mock API
const mockCreateGuest = vi.fn();
vi.mock('../../api/client', () => ({
  api: {
    createGuest: (...args: unknown[]) => mockCreateGuest(...args),
  },
}));

const sede = {
  id: 1,
  code: 'MI',
  name: 'Milano',
  city: 'Milano',
  address: 'Via Roma 1',
  wlcSsid: 'Dompe Guest',
  wlcConfigId: 1,
  createdAt: '2025-01-01T00:00:00Z',
};

const newGuest = {
  id: 'g-new-1',
  name: 'Test Guest',
  email: 'test@example.com',
  phone: '+39 333 1234',
  company: 'TestCo',
  host: 'Dr. Rossi',
  username: 'g.testg123',
  password: 'PASS-1234',
  oneTimePassword: 'PASS-1234',
  durationMinutes: 240,
  elapsedSeconds: 0,
  status: 'pending' as const,
  createdAt: '2025-01-01T00:00:00Z',
  enabledAt: null,
  remarks: null,
  sedeId: 1,
};

describe('RegisterGuestModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateGuest.mockResolvedValue({ data: newGuest });
  });

  it('renders the form title', () => {
    render(<RegisterGuestModal sede={sede} onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByText('Registra Nuovo Ospite')).toBeInTheDocument();
  });

  it('shows the sede name and code', () => {
    render(<RegisterGuestModal sede={sede} onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByText(/Milano/)).toBeInTheDocument();
    expect(screen.getByText(/(MI)/)).toBeInTheDocument();
  });

  it('has required name and host fields', () => {
    render(<RegisterGuestModal sede={sede} onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByLabelText('Nome completo')).toBeRequired();
    expect(screen.getByLabelText('Referente / Sponsor')).toBeRequired();
  });

  it('has default company value', () => {
    render(<RegisterGuestModal sede={sede} onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByDisplayValue('Ospite Individuale')).toBeInTheDocument();
  });

  it('renders duration preset buttons', () => {
    render(<RegisterGuestModal sede={sede} onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByText('30 min')).toBeInTheDocument();
    expect(screen.getByText('2 ore')).toBeInTheDocument();
    expect(screen.getByText('4 ore')).toBeInTheDocument();
    expect(screen.getByText('1 giorno')).toBeInTheDocument();
    expect(screen.getByText('1 settimana')).toBeInTheDocument();
    expect(screen.getByText('Data personalizzata')).toBeInTheDocument();
  });

  it('submits the form and shows one-time password view', async () => {
    const user = userEvent.setup();
    render(<RegisterGuestModal sede={sede} onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText('Nome completo'), 'Test Guest');
    await user.type(screen.getByLabelText('Email'), 'test@example.com');
    await user.type(screen.getByLabelText('Telefono'), '+39 333 1234');
    await user.type(screen.getByLabelText('Referente / Sponsor'), 'Dr. Rossi');

    const submitBtn = screen.getByText('Crea Ospite');
    await user.click(submitBtn);

    await waitFor(() => {
      expect(mockCreateGuest).toHaveBeenCalledOnce();
    });

    // Should show one-time password view
    await waitFor(() => {
      expect(screen.getByText('Password temporanea (mostrata una sola volta)')).toBeInTheDocument();
    });
  });

  it('shows one-time password and username in success view', async () => {
    const user = userEvent.setup();
    render(<RegisterGuestModal sede={sede} onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText('Nome completo'), 'Test Guest');
    await user.type(screen.getByLabelText('Referente / Sponsor'), 'Dr. Rossi');

    const submitBtn = screen.getByText('Crea Ospite');
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('g.testg123')).toBeInTheDocument();
    });
    expect(screen.getByText('PASS-1234')).toBeInTheDocument();
  });

  it('calls onClose from the one-time password view', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<RegisterGuestModal sede={sede} onClose={onClose} onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText('Nome completo'), 'Test Guest');
    await user.type(screen.getByLabelText('Referente / Sponsor'), 'Dr. Rossi');

    const submitBtn = screen.getByText('Crea Ospite');
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Password temporanea (mostrata una sola volta)')).toBeInTheDocument();
    });

    // Close button in the one-time password view
    const closeBtn = document.querySelector('[type="button"]');
    if (closeBtn) {
      await user.click(closeBtn);
      expect(onClose).toHaveBeenCalledOnce();
    }
  });

  it('calls onCreated from the one-time password view', async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<RegisterGuestModal sede={sede} onClose={vi.fn()} onCreated={onCreated} />);

    await user.type(screen.getByLabelText('Nome completo'), 'Test Guest');
    await user.type(screen.getByLabelText('Referente / Sponsor'), 'Dr. Rossi');

    const submitBtn = screen.getByText('Crea Ospite');
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Chiudi')).toBeInTheDocument();
    });

    const confirmBtn = screen.getByText('Chiudi');
    await user.click(confirmBtn);

    expect(onCreated).toHaveBeenCalledOnce();
  });

  it('shows error when create fails', async () => {
    mockCreateGuest.mockRejectedValue(new Error('Errore di connessione'));
    const user = userEvent.setup();
    render(<RegisterGuestModal sede={sede} onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText('Nome completo'), 'Test Guest');
    await user.type(screen.getByLabelText('Referente / Sponsor'), 'Dr. Rossi');

    const submitBtn = screen.getByText('Crea Ospite');
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Errore di connessione')).toBeInTheDocument();
    });
  });

  it('switches to custom duration when custom button is clicked', async () => {
    const user = userEvent.setup();
    render(<RegisterGuestModal sede={sede} onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.click(screen.getByText('Data personalizzata'));

    expect(screen.getByText('Scade il')).toBeInTheDocument();
    // Should show the custom date input
    expect(screen.getByTestId('custom-date-input')).toBeInTheDocument();
  });

  it('shows computed duration for custom date', async () => {
    render(<RegisterGuestModal sede={sede} onClose={vi.fn()} onCreated={vi.fn()} />);

    await userEvent.click(screen.getByText('Data personalizzata'));

    // Set a future date within the 1-week limit (MAX_DURATION_MINUTES = 10080)
    // Use 6 days from now which equals 8640 minutes < 10080
    const futureDate = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
    const dateStr = futureDate.toISOString().slice(0, 16);
    const input = screen.getByTestId('custom-date-input') as HTMLInputElement;

    // Use fireEvent.change for datetime-local input compatibility
    fireEvent.change(input, { target: { value: dateStr } });

    // The component should show the computed duration
    expect(screen.getByTestId('custom-duration-value')).toBeInTheDocument();
    expect(screen.getByTestId('custom-duration-value').textContent).toContain('min');
  });

  it('cancels the form when cancel is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<RegisterGuestModal sede={sede} onClose={onClose} onCreated={vi.fn()} />);

    const cancelBtn = screen.getByText('Annulla');
    await user.click(cancelBtn);

    expect(onClose).toHaveBeenCalledOnce();
  });
});
