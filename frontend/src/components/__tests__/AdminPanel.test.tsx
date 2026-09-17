/**
 * Tests for the administration panel.
 *
 * The break-glass tab is the part worth guarding: it must offer no way to
 * create an account or set a password. Those credentials bypass Entra and MFA
 * entirely (COMPLIANCE.md D1), and the whole reason they stay CLI-only is that a
 * compromised admin session must not be able to mint one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminPanel from '../AdminPanel';

vi.mock('../../i18n', () => ({
  useLocale: () => [
    'it',
    vi.fn(),
    (key: string, params?: Record<string, string | number>) => {
      const dict: Record<string, string> = {
        'admin.title': 'Amministrazione',
        'admin.subtitle': 'Utenti, sedi e accessi di emergenza',
        'admin.tab.users': 'Utenti',
        'admin.tab.sedi': 'Sedi e WLC',
        'admin.tab.breakglass': 'Emergenza',
        'admin.users.all': 'Tutti',
        'admin.users.save': 'Salva',
        'admin.users.pendingBadge': 'Da profilare',
        'admin.users.you': 'Tu',
        'admin.users.autoAdmin': 'Admin automatico',
        'admin.users.autoAdminHelp': 'Amministratore per convenzione.',
        'admin.bg.cliOnly': 'Creazione e cambio password solo da CLI.',
        'admin.bg.disable': 'Disabilita',
        'admin.bg.enable': 'Abilita',
        'admin.bg.unlock': 'Sblocca',
        'admin.sede.credentialMissing': 'Password del controller non configurata.',
        'toast.loading': 'Caricamento...',
      };
      const val = dict[key] ?? key;
      return params
        ? Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), val)
        : val;
    },
  ],
}));

const mockAdminApi = vi.hoisted(() => ({
  listUsers: vi.fn(),
  patchUser: vi.fn(),
  deleteUser: vi.fn(),
  listSedi: vi.fn(),
  createSede: vi.fn(),
  updateSede: vi.fn(),
  setSedeActive: vi.fn(),
  testSede: vi.fn(),
  deleteSede: vi.fn(),
  listBreakGlass: vi.fn(),
  enableBreakGlass: vi.fn(),
  disableBreakGlass: vi.fn(),
  unlockBreakGlass: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  adminApi: mockAdminApi,
  ApiError: class extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

const sedi = [
  {
    id: 1, code: 'MIL', name: 'Milano', city: 'Milano', address: null, wlcConfigId: null,
    createdAt: '2026-01-01T00:00:00Z', active: true,
    wlcHost: '172.18.106.100', wlcPort: 443, wlcSshPort: 22, wlcUsername: 'admin_guest', wlcSsid: 'Dompe Guest',
    credentialConfigured: true, credentialEnvVar: 'WLC_PASSWORD_MIL', credentialSecretName: 'WLC-PASSWORD-MIL',
    wlcLastCheckAt: null, wlcLastCheckOk: null, wlcLastCheckError: null, updatedAt: null, updatedBy: null,
  },
];

const users = [
  {
    id: 7, subject: 'oid-7', email: 'mario@dompe.com', displayName: 'Mario Rossi', entraObjectId: 'oid-7',
    role: 'viewer' as const, status: 'pending' as const, sedeIds: [],
    createdAt: '2026-01-01T00:00:00Z', lastLoginAt: null, profiledAt: null, profiledBy: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockAdminApi.listUsers.mockResolvedValue({ data: users });
  mockAdminApi.listSedi.mockResolvedValue({ data: sedi });
  mockAdminApi.listBreakGlass.mockResolvedValue({ data: [] });
  mockAdminApi.patchUser.mockResolvedValue({ data: users[0] });
});

describe('AdminPanel', () => {
  it('opens on the users tab', async () => {
    render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('admin-user-7')).toBeInTheDocument();
    });
  });

  it('flags a user awaiting approval', async () => {
    render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Da profilare')).toBeInTheDocument());
  });

  it('sends role, status and sites together', async () => {
    const u = userEvent.setup();
    render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('admin-user-7')).toBeInTheDocument());

    await u.selectOptions(screen.getByTestId('admin-user-role-7'), 'operator');
    await u.selectOptions(screen.getByTestId('admin-user-status-7'), 'active');
    await u.click(screen.getByTestId('admin-user-7-sede-MIL'));
    await u.click(screen.getByTestId('admin-user-save-7'));

    await waitFor(() => {
      expect(mockAdminApi.patchUser).toHaveBeenCalledWith(7, {
        role: 'operator',
        status: 'active',
        sedeIds: [1],
      });
    });
  });

  it('keeps Save disabled until something changes', async () => {
    render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('admin-user-7')).toBeInTheDocument());
    expect(screen.getByTestId('admin-user-save-7')).toBeDisabled();
  });

  /**
   * The server refuses this too; doing it here as well means the admin finds
   * out before they click rather than after.
   */
  it('stops an admin editing their own role or status', async () => {
    mockAdminApi.listUsers.mockResolvedValue({
      data: [{ ...users[0], id: 1, email: 'admin@dompe.com', role: 'admin', status: 'active' }],
    });
    render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('admin-user-1')).toBeInTheDocument());
    expect(screen.getByTestId('admin-user-role-1')).toBeDisabled();
    expect(screen.getByTestId('admin-user-status-1')).toBeDisabled();
    expect(screen.getByText('Tu')).toBeInTheDocument();
  });

  /**
   * A platform administrator by naming convention cannot be re-profiled: the
   * rule is reapplied on every login, so accepting an edit would be a lie that
   * lasts one request. The server refuses it too; locking the row here means
   * the admin finds out before they click.
   */
  it('locks role and status for an administrator granted by convention', async () => {
    mockAdminApi.listUsers.mockResolvedValue({
      data: [{
        ...users[0],
        email: 'admin365-x@dompe.onmicrosoft.com',
        role: 'admin' as const,
        status: 'active' as const,
        autoAdmin: true,
      }],
    });
    render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('admin-user-7')).toBeInTheDocument());
    expect(screen.getByTestId('admin-user-auto-7')).toBeInTheDocument();
    expect(screen.getByTestId('admin-user-role-7')).toBeDisabled();
    expect(screen.getByTestId('admin-user-status-7')).toBeDisabled();
  });

  it('shows no such badge for an ordinary user', async () => {
    render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('admin-user-7')).toBeInTheDocument());
    expect(screen.queryByTestId('admin-user-auto-7')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-user-role-7')).not.toBeDisabled();
  });

  /** An admin reaches every site, so a per-site list would be misleading. */
  it('hides the site checkboxes for an admin', async () => {
    mockAdminApi.listUsers.mockResolvedValue({
      data: [{ ...users[0], role: 'admin', status: 'active' }],
    });
    render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('admin-user-7')).toBeInTheDocument());
    expect(screen.queryByTestId('admin-user-7-sede-MIL')).not.toBeInTheDocument();
  });

  /**
   * api.listSedi honours the caller's own grants, which would hide sites an
   * admin still has to assign to other people.
   */
  it('lists sites from the unfiltered admin endpoint', async () => {
    render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
    await waitFor(() => expect(mockAdminApi.listSedi).toHaveBeenCalled());
  });

  it('surfaces a refusal from the server', async () => {
    const u = userEvent.setup();
    mockAdminApi.patchUser.mockRejectedValue(
      Object.assign(new Error('È l\'ultimo amministratore attivo.'), { code: 'last_admin', status: 409 }),
    );
    render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('admin-user-7')).toBeInTheDocument());

    await u.selectOptions(screen.getByTestId('admin-user-role-7'), 'operator');
    await u.click(screen.getByTestId('admin-user-save-7'));

    await waitFor(() => {
      expect(screen.getByText(/ultimo amministratore/)).toBeInTheDocument();
    });
  });

  describe('sedi tab', () => {
    it('shows the site form', async () => {
      const u = userEvent.setup();
      render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
      await u.click(screen.getByTestId('admin-tab-sedi'));

      await waitFor(() => expect(screen.getByTestId('admin-sede-MIL')).toBeInTheDocument());
      expect(screen.getByTestId('sede-save-btn')).toBeInTheDocument();
      expect(screen.getByTestId('sede-test-btn')).toBeInTheDocument();
    });

    /** Changing it would detach the site from its Key Vault secret. */
    it('locks the code on an existing site', async () => {
      const u = userEvent.setup();
      render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
      await u.click(screen.getByTestId('admin-tab-sedi'));

      await waitFor(() => expect(screen.getByLabelText('admin.sede.code')).toBeInTheDocument());
      expect(screen.getByLabelText('admin.sede.code')).toBeDisabled();
    });

    /**
     * Creating the secret is a platform-team request, so the panel names both
     * identifiers rather than leaving the admin to guess the convention.
     */
    it('names the Key Vault secret to request when it is missing', async () => {
      const u = userEvent.setup();
      mockAdminApi.listSedi.mockResolvedValue({
        data: [{ ...sedi[0], credentialConfigured: false }],
      });
      render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
      await u.click(screen.getByTestId('admin-tab-sedi'));

      await waitFor(() => expect(screen.getByTestId('sede-credential-missing')).toBeInTheDocument());
      expect(screen.getByText('WLC-PASSWORD-MIL')).toBeInTheDocument();
      expect(screen.getByText('WLC_PASSWORD_MIL')).toBeInTheDocument();
    });

    it('never offers a field for the controller password', async () => {
      const u = userEvent.setup();
      render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
      await u.click(screen.getByTestId('admin-tab-sedi'));

      await waitFor(() => expect(screen.getByTestId('sede-save-btn')).toBeInTheDocument());
      expect(document.querySelector('input[type="password"]')).toBeNull();
    });

    it('runs a connection test', async () => {
      const u = userEvent.setup();
      mockAdminApi.testSede.mockResolvedValue({ success: true, checkedAt: '2026-01-01T00:00:00Z' });
      render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
      await u.click(screen.getByTestId('admin-tab-sedi'));

      await waitFor(() => expect(screen.getByTestId('sede-test-btn')).toBeInTheDocument());
      await u.click(screen.getByTestId('sede-test-btn'));

      await waitFor(() => expect(mockAdminApi.testSede).toHaveBeenCalledWith(1));
    });
  });

  describe('break glass tab', () => {
    const account = {
      username: 'bk.guestportal',
      displayName: 'Break Glass',
      role: 'admin',
      enabled: true,
      expiresAt: null,
      lockedUntil: null,
      failedAttempts: 0,
      lastLoginAt: null,
      state: 'enabled' as const,
    };

    it('says plainly that creation stays in the CLI', async () => {
      const u = userEvent.setup();
      mockAdminApi.listBreakGlass.mockResolvedValue({ data: [account] });
      render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
      await u.click(screen.getByTestId('admin-tab-breakglass'));

      await waitFor(() => expect(screen.getByTestId('admin-bg-cli-notice')).toBeInTheDocument());
    });

    /**
     * The compliance boundary, asserted from the outside: a compromised admin
     * session must not be able to mint an account that bypasses Entra.
     */
    it('offers no way to create an account or set a password', async () => {
      const u = userEvent.setup();
      mockAdminApi.listBreakGlass.mockResolvedValue({ data: [account] });
      render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
      await u.click(screen.getByTestId('admin-tab-breakglass'));

      await waitFor(() => expect(screen.getByTestId('admin-bg-bk.guestportal')).toBeInTheDocument());
      expect(document.querySelector('input[type="password"]')).toBeNull();
      expect(screen.queryByText(/Nuovo account/i)).not.toBeInTheDocument();
      expect(mockAdminApi).not.toHaveProperty('createBreakGlass');
    });

    it('disables an account', async () => {
      const u = userEvent.setup();
      mockAdminApi.listBreakGlass.mockResolvedValue({ data: [account] });
      mockAdminApi.disableBreakGlass.mockResolvedValue({ success: true });
      render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
      await u.click(screen.getByTestId('admin-tab-breakglass'));

      await waitFor(() => expect(screen.getByTestId('admin-bg-disable-bk.guestportal')).toBeInTheDocument());
      await u.click(screen.getByTestId('admin-bg-disable-bk.guestportal'));

      await waitFor(() => expect(mockAdminApi.disableBreakGlass).toHaveBeenCalledWith('bk.guestportal'));
    });

    it('offers Unlock only for a locked account', async () => {
      const u = userEvent.setup();
      mockAdminApi.listBreakGlass.mockResolvedValue({
        data: [{ ...account, state: 'locked' as const }],
      });
      render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
      await u.click(screen.getByTestId('admin-tab-breakglass'));

      await waitFor(() => expect(screen.getByTestId('admin-bg-unlock-bk.guestportal')).toBeInTheDocument());
    });

    it('surfaces the refusal to disable the last usable account', async () => {
      const u = userEvent.setup();
      mockAdminApi.listBreakGlass.mockResolvedValue({ data: [account] });
      mockAdminApi.disableBreakGlass.mockRejectedValue(
        Object.assign(new Error('È l\'ultimo account di emergenza utilizzabile.'), { code: 'last_breakglass' }),
      );
      render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={vi.fn()} />);
      await u.click(screen.getByTestId('admin-tab-breakglass'));

      await waitFor(() => expect(screen.getByTestId('admin-bg-disable-bk.guestportal')).toBeInTheDocument());
      await u.click(screen.getByTestId('admin-bg-disable-bk.guestportal'));

      await waitFor(() => {
        expect(screen.getByText(/ultimo account di emergenza/)).toBeInTheDocument();
      });
    });
  });

  it('closes', async () => {
    const onClose = vi.fn();
    const u = userEvent.setup();
    render(<AdminPanel currentUserEmail="admin@dompe.com" onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId('admin-panel')).toBeInTheDocument());
    await u.click(screen.getByTestId('admin-panel-close'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
