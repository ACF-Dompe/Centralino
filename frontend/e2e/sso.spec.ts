/**
 * E2E tests for the SSO SAML 2.0 login screen (Entra ID / Microsoft).
 *
 * The app's auth flow has 4 phases:
 *   loading → sso-required (SAML configured, 401) → WLC login → Dashboard
 *           → sso-unavailable (SAML not configured, 404) → WLC login → Dashboard
 *           → sso-authenticated (200) → WLC login → Dashboard
 *
 * In local dev SAML_ENTRY_POINT is not set, so /api/auth/me returns 404 and
 * the app skips SSO entirely. To test the SSO screen we intercept the API
 * call and return 401, simulating a SAML-configured environment where the
 * user has not yet authenticated.
 */
import { test, expect } from '@playwright/test';
import { enterSsoDemoSandbox, enterSsoHappyPath, enterSsoUnavailable, setupSsoCommonRoutes } from './helpers/auth';

test.describe('SSO SAML login screen', () => {
  test('shows the WLC login with SSO user tag after SSO authentication', async ({
    page,
  }) => {
    await setupSsoCommonRoutes(page);
    await page.goto('/');

    // The sede selector heading should appear (WLC login phase)
    await expect(
      page.getByRole('heading', { name: /Seleziona la sede/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The SSO user tag should be visible with name and email
    await expect(page.getByText('Mario Rossi')).toBeVisible();
    await expect(page.getByText('mario.rossi@dompe.com')).toBeVisible();

    // The SSO login link should NOT be present (already authenticated)
    await expect(
      page.getByRole('link', { name: /Accedi con SSO/i }),
    ).not.toBeVisible();

    // The sede card should be visible and clickable
    await expect(
      page.getByRole('button', { name: /Dompe Milano HQ/i }),
    ).toBeVisible();
  });

  test('shows the SSO login screen when SAML is configured but user is not authenticated', async ({
    page,
  }) => {
    // Intercept /api/auth/me → 401 (SAML configured, session missing)
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: 'Not authenticated. Use /api/auth/login to authenticate.',
        }),
      });
    });

    await page.goto('/');

    // The SSO heading should appear (Italian locale by default)
    await expect(
      page.getByRole('heading', { name: /Accesso con Single Sign-On/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The SSO login button/link should be present and point to the IdP
    const loginLink = page.getByRole('link', { name: /Accedi con SSO/i });
    await expect(loginLink).toBeVisible();
    await expect(loginLink).toHaveAttribute('href', '/api/auth/login');

    // The corporate branding elements should also be visible
    await expect(page.getByText(/Dompè Guest Desk/i)).toBeVisible();
    await expect(page.getByText(/Corporate Console|Single Sign-On/i).first()).toBeVisible();
  });

  test('completes the full auth flow: SSO → select sede → WLC login → dashboard', async ({
    page,
  }) => {
    await enterSsoHappyPath(page);

    // Additional assertions after the helper resolves (Dashboard / connected)
    await expect(page.getByText('Mario Rossi')).toBeVisible();
    await expect(page.getByText('mario.rossi@dompe.com')).toBeVisible();
    await expect(page.getByText(/Dompe Milano HQ/i)).toBeVisible();

    // Connected badge shows @ host (WLC login succeeded)
    await expect(page.getByText(/@ 172\.18\.106\.100/i)).toBeVisible();

    // SSO logout button should be present
    await expect(page.getByTestId('sso-logout-btn')).toBeVisible();
  });

  test('creates a guest from the Dashboard after SSO authentication', async ({
    page,
  }) => {
    // Intercept POST /api/guests → 200 with mock guest response
    // Registered BEFORE enterSsoHappyPath for FIFO priority
    await page.route('**/api/guests*', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              id: 'e2e-sso-guest-001',
              name: 'Mario SSO E2E',
              email: 'sso.e2e@example.com',
              phone: '+393331234567',
              company: 'SSO E2E Corp',
              host: 'Test Sponsor',
              username: 'guest-sso-e2e-001',
              oneTimePassword: 'TempPass123!',
              durationMinutes: 240,
              elapsedSeconds: 0,
              status: 'pending',
              createdAt: new Date().toISOString(),
              enabledAt: null,
              remarks: null,
              sedeId: 1,
            },
          }),
        });
      } else {
        await route.fallback();
      }
    });

    await enterSsoHappyPath(page);

    // Click "Registra Ospite" to open the modal
    await page.getByTestId('register-guest-btn').click();
    await expect(
      page.getByRole('heading', { name: /Registra Nuovo Ospite/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Fill the guest form (reuse same selectors as calendar.spec.ts)
    await page.getByLabel('Nome completo', { exact: true }).fill('Mario SSO E2E');
    await page.getByLabel('Email', { exact: true }).fill('sso.e2e@example.com');
    await page.getByLabel('Telefono', { exact: true }).fill('+393331234567');
    await page.getByLabel('Azienda').fill('SSO E2E Corp');
    await page.getByLabel(/Referente.*Sponsor|Sponsor.*Host/i).fill('Test Sponsor');

    // Submit using the default 4h preset
    await page.getByRole('button', { name: /^Crea Ospite$/i }).click();

    // Verify the one-time password card appears
    await expect(page.getByText(/Password temporanea/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('TempPass123!')).toBeVisible();
    await expect(page.getByText('guest-sso-e2e-001')).toBeVisible();

    // Close the modal
    await page.getByRole('button', { name: /Chiudi/i }).click();

    // SSO user tag still visible in Dashboard
    await expect(page.getByText('Mario Rossi')).toBeVisible();
    await expect(page.getByText(/@ 172\.18\.106\.100/i)).toBeVisible();
  });

  test('changes WLC configuration from the Dashboard ConfigPanel after SSO auth', async ({
    page,
  }) => {
    // Intercept PUT /api/config/wlc → updated WLC config
    // Registered BEFORE enterSsoHappyPath for FIFO priority
    await page.route('**/api/config/wlc', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              id: 0,
              host: '10.0.0.50',
              port: 443,
              sshPort: 22,
              username: 'admin_guest',
              password: '',
              wlanSsid: 'Dompe Guest',
              authenticated: true,
              sedeId: 1,
            },
          }),
        });
      } else {
        await route.fallback(); // GET → helper's handler
      }
    });

    await enterSsoHappyPath(page);

    // Click the Settings button to open ConfigPanel
    await page.getByTestId('settings-button').click();
    await expect(page.getByRole('heading', { name: /Config|Impostazioni/i })).toBeVisible({
      timeout: 10_000,
    });

    // Switch to the WLC section — use data-testid to scope to ConfigPanel nav
    await page.getByTestId('config-panel-nav').getByRole('button', { name: /WLC|Controller/i }).click();

    // Change the WLC host — scope to inputs inside ConfigPanel via data-testid
    await page.getByTestId('config-panel').locator('input').filter({ hasValue: '172.18.106.100' }).fill('10.0.0.50');

    // Click "Save All"
    await page.getByRole('button', { name: /Salva|Save|Salva tutto/i }).click();

    // Wait for save confirmation
    await expect(page.getByText(/Salvato|Saved/i)).toBeVisible({ timeout: 5_000 });

    // Close ConfigPanel
    await page.getByTestId('config-panel-close').click();

    // Verify the updated host appears in the Dashboard header badge
    await expect(page.getByText(/@ 10\.0\.0\.50/i)).toBeVisible();

    // SSO user tag still visible
    await expect(page.getByText('Mario Rossi')).toBeVisible();
  });

  test('configures SMTP email settings from the ConfigPanel after SSO auth', async ({
    page,
  }) => {
    // Intercept GET + PUT /api/config/email and PUT /api/config/wlc
    // Registered BEFORE enterSsoHappyPath for FIFO priority
    await page.route('**/api/config/email', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              id: 0,
              smtpHost: 'smtp.example.com',
              smtpPort: 587,
              sender: 'noreply@example.com',
              encryption: 'starttls',
              requireAuth: true,
              username: 'smtp-user',
              password: 'smtp-pass',
            },
          }),
        });
      } else if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              id: 0,
              smtpHost: 'smtp.new-host.com',
              smtpPort: 465,
              sender: 'noreply@new-host.com',
              encryption: 'ssl',
              requireAuth: true,
              username: 'new-smtp-user',
              password: 'new-smtp-pass',
            },
          }),
        });
      } else {
        await route.fallback();
      }
    });

    // Also need PUT /api/config/wlc (Save All saves both email and WLC)
    await page.route('**/api/config/wlc', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              id: 0,
              host: '172.18.106.100',
              port: 443,
              sshPort: 22,
              username: 'admin_guest',
              password: '',
              wlanSsid: 'Dompe Guest',
              authenticated: true,
              sedeId: 1,
            },
          }),
        });
      } else {
        await route.fallback(); // GET → helper's handler
      }
    });

    await enterSsoHappyPath(page);

    // Open ConfigPanel — defaults to email section
    await page.getByTestId('settings-button').click();
    await expect(page.getByRole('heading', { name: /Config|Impostazioni/i })).toBeVisible({
      timeout: 10_000,
    });

    // The email section is active by default — wait for config to load
    // The email heading confirms the email section rendered
    await expect(page.getByRole('heading', { name: /SMTP|Email/i })).toBeVisible({
      timeout: 5_000,
    });

    // Change SMTP port — scope to ConfigPanel via data-testid
    await page.getByTestId('config-panel').locator('input[type="number"]').filter({ hasValue: '587' }).fill('465');

    // Click "Save All"
    await page.getByRole('button', { name: /Salva|Save|Salva tutto/i }).click();

    // Wait for save confirmation
    await expect(page.getByText(/Salvato|Saved/i)).toBeVisible({ timeout: 5_000 });

    // Close ConfigPanel
    await page.getByTestId('config-panel-close').click();

    // Dashboard still works after saving
    await expect(page.getByText('Mario Rossi')).toBeVisible();
    await expect(page.getByText(/@ 172\.18\.106\.100/i)).toBeVisible();
  });

  test('locks and unlocks the Dashboard via the LockOverlay screen', async ({
    page,
  }) => {
    await enterSsoHappyPath(page);

    // Click the lock button in the header — title is 'Blocca Console' (IT) or 'Lock Console' (EN)
    await page.getByTitle(/Blocca Console|Lock Console/i).click();

    // LockOverlay should appear — heading is 'Blocca Console' (IT) or 'Lock Console' (EN)
    await expect(
      page.getByRole('heading', { name: /Blocca Console|Lock Console/i }),
    ).toBeVisible({ timeout: 5_000 });

    // The demo PIN input should be visible (accepts any value)
    await expect(page.getByText(/Inserisci PIN/i)).toBeVisible();

    // Type a PIN and click "Sblocca"
    await page.getByTestId('lock-overlay').locator('input').fill('1234');
    await page.getByRole('button', { name: /Sblocca|Unlock/i }).click();

    // LockOverlay closes, Dashboard should be visible again
    await expect(page.getByText(/Inserisci PIN/i)).not.toBeVisible();
    await expect(page.getByText('Mario Rossi')).toBeVisible();
    await expect(page.getByText(/@ 172\.18\.106\.100/i)).toBeVisible();
  });

  test('completes the SSO→Demo Sandbox flow: WLC unreachable after SSO auth', async ({
    page,
  }) => {
    await enterSsoDemoSandbox(page);

    // Additional assertions after the helper resolves (Dashboard / offline mode)
    await expect(page.getByText('Mario Rossi')).toBeVisible();
    await expect(page.getByText('mario.rossi@dompe.com')).toBeVisible();
    await expect(page.getByText(/Dompe Milano HQ/i)).toBeVisible();

    // The connected badge should NOT show @ host (Demo mode = offline)
    await expect(page.getByText(/@ 172\.18\.106\.100/i)).not.toBeVisible();

    // SSO logout + WLC disconnect buttons should be present
    await expect(page.getByTestId('sso-logout-btn')).toBeVisible();
    await expect(page.getByTitle(/Disconnetti|Disconnect/i)).toBeVisible();
  });

  test('logs out from SSO and shows the SSO login screen again', async ({ page }) => {
    await enterSsoHappyPath(page);

    // Intercept POST /api/auth/logout → 200 (successful logout)
    await page.route('**/api/auth/logout', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      } else {
        await route.fallback();
      }
    });

    // Click the SSO logout button
    // Use force:true because the fixed language selector overlay (z-50)
    // in the top-right corner of all views may intercept pointer events
    // during the Dashboard→SsoLogin transition.
    await page.getByTestId('sso-logout-btn').click({ force: true });

    // After logout, the app transitions to sso-required → SsoLogin screen
    await expect(
      page.getByRole('heading', { name: /Accesso con Single Sign-On/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The SSO login link should point to the IdP
    const loginLink = page.getByRole('link', { name: /Accedi con SSO/i });
    await expect(loginLink).toBeVisible();
    await expect(loginLink).toHaveAttribute('href', '/api/auth/login');
  });

  test('falls back to SSO login screen even when the logout API call fails (catch path)', async ({
    page,
  }) => {
    await enterSsoHappyPath(page);

    // Intercept POST /api/auth/logout → 500 (server error triggers .catch())
    await page.route('**/api/auth/logout', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: 'Internal server error.',
          }),
        });
      } else {
        await route.fallback();
      }
    });

    // Click the SSO logout button
    // Use force:true because the fixed language selector overlay (z-50)
    // in the top-right corner of all views may intercept pointer events
    // during the transition to the SsoLogin screen.
    await page.getByTestId('sso-logout-btn').click({ force: true });

    // Even though the API call failed, the app force-logs out via .catch()
    await expect(
      page.getByRole('heading', { name: /Accesso con Single Sign-On/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The SSO login link should still point to the IdP
    const loginLink = page.getByRole('link', { name: /Accedi con SSO/i });
    await expect(loginLink).toBeVisible();
    await expect(loginLink).toHaveAttribute('href', '/api/auth/login');
  });

  test('activates a guest from the Dashboard guest table after SSO auth', async ({
    page,
  }) => {
    let activated = false;

    // Intercept guest API — static mock guests + state tracking for activate
    // Registered BEFORE enterSsoHappyPath for FIFO priority
    await page.route('**/api/guests*', async (route) => {
      const method = route.request().method();

      if (method === 'GET') {
        // Return guest list; status changes from 'pending' to 'active' after PUT
        const status = activated ? 'active' : 'pending';
        const now = new Date().toISOString();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [{
              id: 'e2e-guest-001',
              name: 'Mario Ospite Test',
              email: 'ospite@test.com',
              phone: '+393331234567',
              company: 'Test Corp',
              host: 'Host Test',
              username: 'guest-e2e-001',
              password: 'Pass123',
              durationMinutes: 240,
              elapsedSeconds: 0,
              status,
              createdAt: now,
              enabledAt: activated ? now : null,
              remarks: null,
              sedeId: 1,
            }],
          }),
        });
      } else if (method === 'PUT') {
        activated = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              id: 'e2e-guest-001',
              name: 'Mario Ospite Test',
              email: 'ospite@test.com',
              phone: '+393331234567',
              company: 'Test Corp',
              host: 'Host Test',
              username: 'guest-e2e-001',
              password: 'Pass123',
              durationMinutes: 240,
              elapsedSeconds: 0,
              status: 'active',
              createdAt: new Date().toISOString(),
              enabledAt: new Date().toISOString(),
              remarks: null,
              sedeId: 1,
            },
          }),
        });
      } else {
        await route.fallback();
      }
    });

    await enterSsoHappyPath(page);

    // Guest table should show the pending guest
    await expect(page.getByText('Mario Ospite Test')).toBeVisible({ timeout: 10_000 });

    // Click the activate button (Check icon, title attrs)
    await page.getByTitle(/Attiva|Activate/i).click();

    // Toast confirms activation
    await expect(page.getByText(/attivato/i)).toBeVisible({ timeout: 5_000 });

    // After refresh, the status badge should show 'active' (Italian translation)
    await expect(page.getByText(/Attivo|Active/i)).toBeVisible({ timeout: 10_000 });
  });

  test('deletes a guest from the Dashboard guest table after SSO auth', async ({
    page,
  }) => {
    let deleted = false;

    // Intercept guest API — return a guest initially, empty after DELETE
    await page.route('**/api/guests*', async (route) => {
      const method = route.request().method();
      const url = route.request().url();

      if (method === 'GET') {
        const data = deleted ? [] : [{
          id: 'e2e-guest-002',
          name: 'Mario Da Cancellare',
          email: 'cancella@test.com',
          phone: '+393331234567',
          company: 'Delete Corp',
          host: 'Host Delete',
          username: 'guest-e2e-002',
          password: 'Pass456',
          durationMinutes: 240,
          elapsedSeconds: 0,
          status: 'pending',
          createdAt: new Date().toISOString(),
          enabledAt: null,
          remarks: null,
          sedeId: 1,
        }];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data }),
        });
      } else if (method === 'DELETE') {
        deleted = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      } else {
        // PUT and others → fallback to helper's handler, then to network
        await route.fallback();
      }
    });

    // Handle the window.confirm dialog (accept it)
    page.on('dialog', (dialog) => dialog.accept());

    await enterSsoHappyPath(page);

    // Guest table should show the guest
    await expect(page.getByText('Mario Da Cancellare')).toBeVisible({ timeout: 10_000 });

    // Click the delete button (Trash icon, title attrs)
    await page.getByTitle(/Elimina|Delete|Cancella/i).click();

    // Toast confirms deletion (symmetric with activate test)
    await expect(page.getByText(/eliminat/i)).toBeVisible({ timeout: 5_000 });

    // After delete + refresh, guest should be gone from the table
    await expect(page.getByText('Mario Da Cancellare')).not.toBeVisible({ timeout: 10_000 });

    // The empty table message should appear
    await expect(page.getByText(/Nessun|vuota|vuoto|empty/i)).toBeVisible({ timeout: 5_000 });
  });

  test('copies guest username and password to clipboard via CopyButton in the guest table after SSO auth', async ({
    page,
  }) => {
    // Intercept clipboard writes via addInitScript to avoid headless focus issues
    // with navigator.clipboard.readText() (requires page focus and transient activation)
    await page.addInitScript(() => {
      const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text) => {
        (window as any).__clipboardValue = text;
        return origWrite(text);
      };
    });

    // Intercept guest API — return a guest with both username and password
    await page.route('**/api/guests*', async (route) => {
      const method = route.request().method();

      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [{
              id: 'e2e-guest-copy',
              name: 'Mario Copia Test',
              email: 'copia@test.com',
              phone: '+393331234567',
              company: 'Copy Corp',
              host: 'Host Copy',
              username: 'guest-e2e-copy',
              password: 'PassCopy789!',
              durationMinutes: 240,
              elapsedSeconds: 120,
              status: 'active',
              createdAt: new Date().toISOString(),
              enabledAt: new Date().toISOString(),
              remarks: null,
              sedeId: 1,
            }],
          }),
        });
      } else {
        await route.fallback();
      }
    });

    await enterSsoHappyPath(page);

    // Guest table should show the guest
    await expect(page.getByText('Mario Copia Test')).toBeVisible({ timeout: 10_000 });

    // There are two copy buttons per row: username (first) and password (last)
    const copyButtons = page.getByTitle(/Copia|Copy/i);

    // Click the username copy button (first)
    await copyButtons.first().click();

    // Verify username was written to clipboard (read via mock variable)
    const copiedUsername = await page.evaluate(() => (window as any).__clipboardValue);
    expect(copiedUsername).toBe('guest-e2e-copy');

    // Click the password copy button (last)
    await copyButtons.last().click();

    // Verify password was written to clipboard
    const copiedPassword = await page.evaluate(() => (window as any).__clipboardValue);
    expect(copiedPassword).toBe('PassCopy789!');

    // SSO user tag still visible
    await expect(page.getByText('Mario Rossi')).toBeVisible();
    await expect(page.getByText(/@ 172\.18\.106\.100/i)).toBeVisible();
  });

  test('filters guests by status (pending, active, expired, deactivated) in the Dashboard guest table after SSO auth', async ({
    page,
  }) => {
    let lastFilter: string | null = null;

    // Mock guests with different statuses
    const mockGuests = [
      {
        id: 'e2e-filter-pending',
        name: 'Mario In Attesa',
        email: 'pending@test.com',
        phone: '+393331234561',
        company: 'Pending Corp',
        host: 'Host 1',
        username: 'guest-pending',
        password: 'Pass001',
        durationMinutes: 240,
        elapsedSeconds: 0,
        status: 'pending',
        createdAt: new Date().toISOString(),
        enabledAt: null,
        remarks: null,
        sedeId: 1,
      },
      {
        id: 'e2e-filter-active',
        name: 'Mario Connesso',
        email: 'active@test.com',
        phone: '+393331234562',
        company: 'Active Corp',
        host: 'Host 2',
        username: 'guest-active',
        password: 'Pass002',
        durationMinutes: 240,
        elapsedSeconds: 60,
        status: 'active',
        createdAt: new Date().toISOString(),
        enabledAt: new Date().toISOString(),
        remarks: null,
        sedeId: 1,
      },
      {
        id: 'e2e-filter-expired',
        name: 'Mario Scaduto',
        email: 'expired@test.com',
        phone: '+393331234563',
        company: 'Expired Corp',
        host: 'Host 3',
        username: 'guest-expired',
        password: 'Pass003',
        durationMinutes: 240,
        elapsedSeconds: 999999,
        status: 'expired',
        createdAt: new Date(Date.now() - 86400000).toISOString(),
        enabledAt: new Date(Date.now() - 86400000).toISOString(),
        remarks: null,
        sedeId: 1,
      },
      {
        id: 'e2e-filter-deactivated',
        name: 'Mario Revocato',
        email: 'revoked@test.com',
        phone: '+393331234564',
        company: 'Revoked Corp',
        host: 'Host 4',
        username: 'guest-revoked',
        password: 'Pass004',
        durationMinutes: 240,
        elapsedSeconds: 600,
        status: 'deactivated',
        createdAt: new Date(Date.now() - 172800000).toISOString(),
        enabledAt: new Date(Date.now() - 172800000).toISOString(),
        remarks: null,
        sedeId: 1,
      },
    ];

    // Intercept guest API — filter by status query param
    await page.route('**/api/guests*', async (route) => {
      const method = route.request().method();

      if (method === 'GET') {
        const url = new URL(route.request().url());
        const statusFilter = url.searchParams.get('status');

        lastFilter = statusFilter;

        const filtered = statusFilter
          ? mockGuests.filter((g) => g.status === statusFilter)
          : mockGuests;

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: filtered }),
        });
      } else {
        await route.fallback();
      }
    });

    await enterSsoHappyPath(page);

    // Default filter "Tutti" — all 4 guests should be visible
    await expect(page.getByText('Mario In Attesa')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Mario Connesso')).toBeVisible();
    await expect(page.getByText('Mario Scaduto')).toBeVisible();
    await expect(page.getByText('Mario Revocato')).toBeVisible();

    // Click "In attesa" — only pending guest visible
    await page.getByRole('button', { name: /In attesa|Pending/i }).click();
    await expect(page.getByText('Mario In Attesa')).toBeVisible({ timeout: 10_000 });
    expect(lastFilter).toBe('pending');
    await expect(page.getByText('Mario Connesso')).not.toBeVisible();
    await expect(page.getByText('Mario Scaduto')).not.toBeVisible();
    await expect(page.getByText('Mario Revocato')).not.toBeVisible();

    // Click "Connesso" — only active guest visible
    await page.getByRole('button', { name: /Connesso|Connected/i }).click();
    await expect(page.getByText('Mario Connesso')).toBeVisible({ timeout: 10_000 });
    expect(lastFilter).toBe('active');
    await expect(page.getByText('Mario In Attesa')).not.toBeVisible();
    await expect(page.getByText('Mario Scaduto')).not.toBeVisible();
    await expect(page.getByText('Mario Revocato')).not.toBeVisible();

    // Click "Scaduto" — only expired guest visible
    await page.getByRole('button', { name: /Scaduto|Expired/i }).click();
    await expect(page.getByText('Mario Scaduto')).toBeVisible({ timeout: 10_000 });
    expect(lastFilter).toBe('expired');
    await expect(page.getByText('Mario In Attesa')).not.toBeVisible();
    await expect(page.getByText('Mario Connesso')).not.toBeVisible();
    await expect(page.getByText('Mario Revocato')).not.toBeVisible();

    // Click "Revocato" — only deactivated guest visible
    await page.getByRole('button', { name: /Revocato|Revoked/i }).click();
    await expect(page.getByText('Mario Revocato')).toBeVisible({ timeout: 10_000 });
    expect(lastFilter).toBe('deactivated');
    await expect(page.getByText('Mario In Attesa')).not.toBeVisible();
    await expect(page.getByText('Mario Connesso')).not.toBeVisible();
    await expect(page.getByText('Mario Scaduto')).not.toBeVisible();

    // Click "Tutti" — all 4 guests visible again
    await page.getByRole('button', { name: /Tutti|All/i }).click();
    await expect(page.getByText('Mario In Attesa')).toBeVisible({ timeout: 10_000 });
    expect(lastFilter).toBeNull();
    await expect(page.getByText('Mario Connesso')).toBeVisible();
    await expect(page.getByText('Mario Scaduto')).toBeVisible();
    await expect(page.getByText('Mario Revocato')).toBeVisible();

    // SSO user tag still visible
    await expect(page.getByText('Mario Rossi')).toBeVisible();
    await expect(page.getByText(/@ 172\.18\.106\.100/i)).toBeVisible();
  });

  test('sends a badge email from the Dashboard guest table after SSO auth', async ({
    page,
  }) => {
    let badgeSent = false;

    // Intercept guest API — return a guest with email so the badge button + send button work
    await page.route('**/api/guests*', async (route) => {
      const method = route.request().method();

      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [{
              id: 'e2e-guest-004',
              name: 'Mario Badge Test',
              email: 'badge@test.com',
              phone: '+393331234567',
              company: 'Badge Corp',
              host: 'Host Badge',
              username: 'guest-e2e-004',
              password: 'PassBadge',
              durationMinutes: 240,
              elapsedSeconds: 120,
              status: 'active',
              createdAt: new Date().toISOString(),
              enabledAt: new Date().toISOString(),
              remarks: null,
              sedeId: 1,
            }],
          }),
        });
      } else {
        await route.fallback();
      }
    });

    // Intercept email config (BadgeModal loads it on mount)
    await page.route('**/api/config/email', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              id: 0,
              smtpHost: 'smtp.example.com',
              smtpPort: 587,
              sender: 'noreply@dompe.com',
              encryption: 'starttls',
              requireAuth: true,
              username: 'smtp-user',
              password: 'smtp-pass',
            },
          }),
        });
      } else {
        await route.fallback();
      }
    });

    // Intercept the resend credentials API (BadgeModal calls this to send the email)
    await page.route('**/guests/*/resend-credentials', async (route) => {
      if (route.request().method() === 'POST') {
        badgeSent = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            oneTimePassword: 'BadgePass456!',
            wlcUpdated: true,
            emailSent: true,
            emailMode: 'smtp',
          }),
        });
      } else {
        await route.fallback();
      }
    });

    await enterSsoHappyPath(page);

    // Guest table should show the guest
    await expect(page.getByText('Mario Badge Test')).toBeVisible({ timeout: 10_000 });

    // Click the badge button (Send icon, title attrs)
    await page.getByTitle(/Invia Badge|Send Badge/i).click();

    // BadgeModal should appear with guest name in the heading
    await expect(page.getByRole('heading', { name: /Mario Badge Test/i })).toBeVisible({
      timeout: 5_000,
    });

    // The email config should have loaded — sender info visible
    await expect(page.getByText('noreply@dompe.com')).toBeVisible({ timeout: 5_000 });

    // Click the "Send Email" button
    await page.getByRole('button', { name: /Invia Email|Send Email/i }).click();

    // Resend API should have been called
    expect(badgeSent).toBe(true);

    // Success message should appear (Italian: "Email inviata correttamente")
    await expect(page.getByText(/inviata correttamente|sent successfully|inviata/i)).toBeVisible({
      timeout: 5_000,
    });

    // Close the BadgeModal
    await page.getByTestId('badge-modal-close').click();

    // BadgeModal should be closed (heading is unique to modal, not the table row)
    await expect(
      page.getByRole('heading', { name: /Mario Badge Test/i }),
    ).not.toBeVisible();

    // SSO user tag still visible in Dashboard
    await expect(page.getByText('Mario Rossi')).toBeVisible();
    await expect(page.getByText(/@ 172\.18\.106\.100/i)).toBeVisible();
  });

  test('resends guest credentials from the Dashboard guest table after SSO auth', async ({
    page,
  }) => {
    let resendCalled = false;

    // Intercept guest API — return a guest with email so the resend button shows
    // Registered BEFORE enterSsoHappyPath for FIFO priority
    await page.route('**/api/guests*', async (route) => {
      const method = route.request().method();

      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [{
              id: 'e2e-guest-003',
              name: 'Mario Reinvio Test',
              email: 'reinvio@test.com',
              phone: '+393331234567',
              company: 'Resend Corp',
              host: 'Host Reinvio',
              username: 'guest-e2e-003',
              password: 'PassResend',
              durationMinutes: 240,
              elapsedSeconds: 120,
              status: 'active',
              createdAt: new Date().toISOString(),
              enabledAt: new Date().toISOString(),
              remarks: null,
              sedeId: 1,
            }],
          }),
        });
      } else {
        await route.fallback();
      }
    });

    // Intercept the resend credentials API call
    await page.route('**/guests/*/resend-credentials', async (route) => {
      if (route.request().method() === 'POST') {
        resendCalled = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            oneTimePassword: 'ResendPass789!',
            wlcUpdated: true,
            emailSent: true,
            emailMode: 'smtp',
          }),
        });
      } else {
        await route.fallback();
      }
    });

    await enterSsoHappyPath(page);

    // Guest table should show the guest with email
    await expect(page.getByText('Mario Reinvio Test')).toBeVisible({ timeout: 10_000 });

    // Click the resend button (RefreshCw icon, title attrs)
    await page.getByTitle(/Re-invia|Re-send|Resend/i).click();

    // Resend API should have been called
    expect(resendCalled).toBe(true);

    // Toast confirms credentials were re-sent (Italian: "Credenziali reinviate a...")
    await expect(page.getByText(/reinviate|re-sent|reinvia/i)).toBeVisible({ timeout: 5_000 });

    // SSO user tag still visible in Dashboard
    await expect(page.getByText('Mario Rossi')).toBeVisible();
    await expect(page.getByText(/@ 172\.18\.106\.100/i)).toBeVisible();
  });

  test('bypasses SSO and shows the WLC login when SAML is not configured (404)', async ({
    page,
  }) => {
    await enterSsoUnavailable(page);

    // The SSO link should NOT be present (SSO not even configured)
    await expect(
      page.getByRole('link', { name: /Accedi con SSO/i }),
    ).not.toBeVisible();
  });
});
