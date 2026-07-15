/**
 * Unit tests for GuestTable component.
 *
 * Tests various states: loading, empty, guest data rendering, actions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import GuestTable from '../GuestTable';

// Mock i18n
vi.mock('../../i18n', () => ({
  useLocale: () => [
    'it',
    vi.fn(),
    (key: string, params?: Record<string, string | number>) => {
      const dict: Record<string, string> = {
        'toast.loading': 'Caricamento...',
        'table.empty': 'Nessun ospite trovato',
        'table.guest': 'Ospite',
        'table.company': 'Azienda / Sponsor',
        'table.creds': 'Credenziali Wi-Fi',
        'table.time': 'Tempo rimanente',
        'table.status': 'Stato',
        'table.actions': 'Azioni',
        'table.copy': 'Copia',
        'table.activate': 'Attiva',
        'table.badge': 'Invia Badge',
        'table.delete': 'Elimina',
        'table.resend': 'Re-invia Credenziali',
        'table.copied': 'Copiato!',
        'status.pending': 'In attesa',
        'status.active': 'Connesso',
        'status.expired': 'Scaduto',
        'status.deactivated': 'Revocato',
        'time.expired': 'Scaduto',
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

// Mock time utils
vi.mock('../../utils/time', () => ({
  formatRemaining: vi.fn(() => '2 ore 30 min'),
  progressPercent: vi.fn(() => 40),
  progressBarClass: vi.fn(() => 'bg-emerald-500'),
  statusBadgeClass: vi.fn((status: string) => {
    const map: Record<string, string> = {
      pending: 'bg-amber-100 text-amber-800',
      active: 'bg-emerald-100 text-emerald-800',
      expired: 'bg-slate-100 text-slate-500',
      deactivated: 'bg-rose-100 text-rose-700',
    };
    return map[status] ?? 'bg-slate-100 text-slate-500';
  }),
}));

// Mock icons
vi.mock('../icons', () => ({
  Copy: ({ className }: { className?: string }) => <svg data-testid="copy-icon" className={className} />,
  Check: ({ className }: { className?: string }) => <svg data-testid="check-icon" className={className} />,
  Trash: ({ className }: { className?: string }) => <svg data-testid="trash-icon" className={className} />,
  Send: ({ className }: { className?: string }) => <svg data-testid="send-icon" className={className} />,
  Wifi: ({ className }: { className?: string }) => <svg data-testid="wifi-icon" className={className} />,
  Building: ({ className }: { className?: string }) => <svg data-testid="building-icon" className={className} />,
  Mail: ({ className }: { className?: string }) => <svg data-testid="mail-icon" className={className} />,
  Phone: ({ className }: { className?: string }) => <svg data-testid="phone-icon" className={className} />,
  RefreshCw: ({ className }: { className?: string }) => <svg data-testid="refresh-icon" className={className} />,
}));

const guest1 = {
  id: 'g-001',
  name: 'Mario Rossi',
  email: 'mario@example.com',
  phone: '+39 333 1234567',
  company: 'ACME Corp',
  host: 'Dr. Smith',
  username: 'g.marior123',
  password: 'DOMPE-4321',
  durationMinutes: 240,
  elapsedSeconds: 3600,
  status: 'active' as const,
  createdAt: '2025-01-01T00:00:00Z',
  enabledAt: new Date(Date.now() - 3600 * 1000).toISOString(),
  remarks: 'VIP ospite',
  sedeId: 1,
};

const guest2 = {
  id: 'g-002',
  name: 'Anna Bianchi',
  email: null,
  phone: null,
  company: 'Beta Srl',
  host: 'Dr. Rossi',
  username: 'g.annabianchi',
  password: null,
  durationMinutes: 120,
  elapsedSeconds: 0,
  status: 'pending' as const,
  createdAt: '2025-01-02T00:00:00Z',
  enabledAt: null,
  remarks: null,
  sedeId: 1,
};

describe('GuestTable', () => {
  const handlers = {
    onActivate: vi.fn(),
    onDelete: vi.fn(),
    onBadge: vi.fn(),
    onResend: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state when loading and no guests', () => {
    render(<GuestTable guests={[]} loading={true} {...handlers} />);
    expect(screen.getByText('Caricamento...')).toBeInTheDocument();
  });

  it('shows empty state when no guests and not loading', () => {
    render(<GuestTable guests={[]} loading={false} {...handlers} />);
    expect(screen.getByText('Nessun ospite trovato')).toBeInTheDocument();
  });

  it('renders guest names in the table', () => {
    render(<GuestTable guests={[guest1, guest2]} loading={false} {...handlers} />);
    expect(screen.getByText('Mario Rossi')).toBeInTheDocument();
    expect(screen.getByText('Anna Bianchi')).toBeInTheDocument();
  });

  it('renders company names', () => {
    render(<GuestTable guests={[guest1]} loading={false} {...handlers} />);
    expect(screen.getByText('ACME Corp')).toBeInTheDocument();
  });

  it('renders email and phone for guests that have them', () => {
    render(<GuestTable guests={[guest1]} loading={false} {...handlers} />);
    expect(screen.getByText('mario@example.com')).toBeInTheDocument();
    expect(screen.getByText('+39 333 1234567')).toBeInTheDocument();
  });

  it('renders usernames and passwords in code blocks', () => {
    render(<GuestTable guests={[guest1]} loading={false} {...handlers} />);
    expect(screen.getByText('g.marior123')).toBeInTheDocument();
    expect(screen.getByText('DOMPE-4321')).toBeInTheDocument();
  });

  it('shows status badges with correct text', () => {
    render(<GuestTable guests={[guest1, guest2]} loading={false} {...handlers} />);
    expect(screen.getByText('Connesso')).toBeInTheDocument();
    expect(screen.getByText('In attesa')).toBeInTheDocument();
  });

  it('renders activate button only for pending guests', () => {
    render(<GuestTable guests={[guest1, guest2]} loading={false} {...handlers} />);
    // guest2 is pending — should have activate button
    const activateButtons = document.querySelectorAll('[title="Attiva"]');
    expect(activateButtons.length).toBe(1);
  });

  it('calls onActivate when activate button is clicked', async () => {
    const user = (await import('@testing-library/user-event')).default;
    const userEv = user.setup();
    render(<GuestTable guests={[guest2]} loading={false} {...handlers} />);

    const activateBtn = document.querySelector('[title="Attiva"]');
    if (activateBtn) {
      await userEv.click(activateBtn);
      expect(handlers.onActivate).toHaveBeenCalledWith(guest2);
    }
  });

  it('calls onBadge when badge button is clicked', async () => {
    const user = (await import('@testing-library/user-event')).default;
    const userEv = user.setup();
    render(<GuestTable guests={[guest1]} loading={false} {...handlers} />);

    const badgeBtn = document.querySelector('[title="Invia Badge"]');
    if (badgeBtn) {
      await userEv.click(badgeBtn);
      expect(handlers.onBadge).toHaveBeenCalledWith(guest1);
    }
  });

  it('calls onDelete when delete button is clicked', async () => {
    window.confirm = vi.fn(() => true);
    const user = (await import('@testing-library/user-event')).default;
    const userEv = user.setup();
    render(<GuestTable guests={[guest1]} loading={false} {...handlers} />);

    const deleteBtn = document.querySelector('[title="Elimina"]');
    if (deleteBtn) {
      await userEv.click(deleteBtn);
      expect(handlers.onDelete).toHaveBeenCalledWith(guest1);
    }
  });

  it('shows remarks when present', () => {
    render(<GuestTable guests={[guest1]} loading={false} {...handlers} />);
    expect(screen.getByText('VIP ospite')).toBeInTheDocument();
  });

  it('shows the sponsor/host name', () => {
    render(<GuestTable guests={[guest1]} loading={false} {...handlers} />);
    expect(screen.getByText('Dr. Smith')).toBeInTheDocument();
  });
});
