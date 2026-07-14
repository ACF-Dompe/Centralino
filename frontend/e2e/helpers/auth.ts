import { expect, type Page } from '@playwright/test';

/**
 * E2E helper: navigate to the app, pick the first sede card, submit the WLC
 * form, and accept the "WLC NON RAGGIUNGIBILE" modal to enter Demo Sandbox.
 *
 * The Docker container is expected to be running on http://localhost:3000.
 * If the WLC happens to be reachable in some CI environment, the modal will
 * not appear and the dashboard renders directly — handled by waiting for the
 * "Registra Ospite" button which exists in both states.
 */
export async function enterDemoSandbox(page: Page): Promise<void> {
  // Mock ALL API routes. Uses a single catch-all for everything except auth/me
  // (which needs a 404) and wlc/login (which needs a specific POST response).
  //
  // Individual glob-based mocks for specific paths are deliberately avoided
  // because Playwright's glob matching against full URLs (protocol + host + path)
  // can be unreliable in some environments. The catch-all pattern `**/api/**`
  // is the most reliable way to intercept all API requests.

  // 1. SAML not configured → 404, app skips SSO and shows WLC login directly
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: 'SSO is not configured.',
      }),
    });
  });

  // 2. Catch-all for ALL remaining API requests (registered AFTER auth/me).
  //    Routes are dispatched by path + method inside the handler.
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    // WLC login POST → unreachable (triggers Demo Sandbox modal)
    if (path === '/api/wlc/login' && method === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          isUnreachable: true,
          error: 'WLC non raggiungibile. Verifica che il controller sia online e raggiungibile dalla rete.',
        }),
      });
      return;
    }

    // Sedi list → Dompe Milano HQ
    if (path === '/api/sedi') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 1,
              code: 'MIL',
              name: 'Dompe Milano HQ',
              city: 'Milano',
              address: 'Via Tomada 12',
              wlcConfigId: 1,
              createdAt: '2025-01-01T00:00:00.000Z',
            },
          ],
        }),
      });
      return;
    }

    // WLC config GET → unauthenticated (used during init)
    if (path === '/api/config/wlc') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 0, host: '172.18.106.100', port: 443, sshPort: 22,
            username: 'admin_guest', password: '', wlanSsid: 'Dompe Guest',
            authenticated: false, sedeId: null,
          },
        }),
      });
      return;
    }

    // Guest list GET → empty array
    if (path.startsWith('/api/guests') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
      return;
    }

    // Default fallback: empty data
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Seleziona la sede/i })).toBeVisible({
    timeout: 15_000,
  });
  // First card = Milano HQ (or any — order is stable in the seed).
  await expect(page.getByRole('button', { name: /Dompe Milano HQ/i }).first()).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: /Dompe Milano HQ/i }).first().click();
  // Replace the pre-filled WLC host with a TEST-NET IP so the connection
  // fails fast and the "WLC NON RAGGIUNGIBILE" modal appears.
  await page.getByLabel('Host / IP Controller', { exact: true }).fill('198.51.100.1');
  // The password field is required and pre-filled empty — give it a value.
  await page.getByLabel('Password amministratore', { exact: true }).fill('demo');  await page.getByTestId('wlc-connect-btn').click();

  // The WLC is unreachable in the test env → fallback modal appears.
  const sandboxBtn = page.getByRole('button', { name: /Abilita Demo Sandbox/i });
  await expect(sandboxBtn).toBeVisible({ timeout: 20_000 });
  await sandboxBtn.click();
  // Dashboard renders.
  // Use a shorter per-assertion timeout to help the overall test fit within the
  // 30s test timeout. If this assertion fails, the previous steps consumed too
  // much time and the Dashboard simply hasn't rendered yet.
  await expect(page.getByTestId('register-guest-btn')).toBeVisible({
    timeout: 5_000,
  });
}

/**
 * Shared: set up SSO route intercepts as individual glob-based handlers
 * to preserve FIFO priority with any test-specific handlers registered
 * before calling this helper.
 *
 * Handles: auth/me (SSO authenticated), config/wlc, wlc/login (configurable),
 * sedi, guests, config/email, auth/logout.
 */
export async function setupSsoCommonRoutes(
  page: Page,
  options?: { wlcPostResponse?: 'success' | 'unreachable' },
): Promise<void> {
  const wlcResponse = options?.wlcPostResponse;

  // 1. SSO authenticated (Mario Rossi)
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          nameID: 'mario.rossi@dompe.com',
          nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
          email: 'mario.rossi@dompe.com',
          displayName: 'Mario Rossi',
          givenName: 'Mario',
          surname: 'Rossi',
          objectId: 'a1b2c3d4-...',
        },
      }),
    });
  });

  // 2. WLC config (exists, not authenticated)
  await page.route('**/api/config/wlc', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: 0, host: '172.18.106.100', port: 443, sshPort: 22,
          username: 'admin_guest', password: '', wlanSsid: 'Dompe Guest',
          authenticated: false, sedeId: null,
        },
      }),
    });
  });

  // 3. Sedi list (Dompe Milano HQ)
  await page.route('**/api/sedi', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: 1, code: 'MIL', name: 'Dompe Milano HQ',
            city: 'Milano', address: 'Via Tomada 12',
            wlcConfigId: 1, createdAt: '2025-01-01T00:00:00.000Z',
          },
        ],
      }),
    });
  });


  // 5. Email config (GET + PUT for ConfigPanel and BadgeModal)
  await page.route('**/api/config/email', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 0, smtpHost: 'smtp.example.com', smtpPort: 587,
            sender: 'noreply@example.com', encryption: 'starttls',
            requireAuth: true, username: 'smtp-user', password: 'smtp-pass',
          },
        }),
      });
    } else if (route.request().method() === 'PUT') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 0, smtpHost: 'smtp.example.com', smtpPort: 587,
            sender: 'noreply@example.com', encryption: 'starttls',
            requireAuth: true, username: 'smtp-user', password: 'smtp-pass',
          },
        }),
      });
    } else {
      await route.fallback();
    }
  });

  // 6. Logout (POST → success)
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

  // 7. WLC login POST (behavior controlled by caller)
  await page.route('**/api/wlc/login', async (route) => {
    if (route.request().method() === 'POST') {
      if (wlcResponse === 'success') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false, isUnreachable: true,
            error: 'WLC non raggiungibile. Verifica che il controller sia online e raggiungibile dalla rete.',
          }),
        });
      }
    } else {
      await route.fallback();
    }
  });
}

/** Shared: navigate, select sede, and fill WLC form (before clicking Connect). */
async function ssoSelectSedeAndFillForm(page: Page): Promise<void> {
  await page.goto('/');

  // ── Phase 1: Sede selector ──
  await expect(page.getByRole('heading', { name: /Seleziona la sede/i })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('Mario Rossi')).toBeVisible();
  await expect(page.getByText('mario.rossi@dompe.com')).toBeVisible();

  // Click the first sede card
  await page.getByRole('button', { name: /Dompe Milano HQ/i }).first().click();

  // ── Phase 2: WLC form (not yet submitted) ──
  await expect(page.getByText(/Milano · WLC 172\.18\.106\.100/i)).toBeVisible();
  await page.getByLabel('Password amministratore', { exact: true }).fill('admin123');
}

/**
 * E2E helper: mock SSO routes and enter Demo Sandbox with an SSO-authenticated
 * user (Mario Rossi). WLC login fails with isUnreachable → Demo Sandbox modal
 * → Dashboard in offline mode.
 *
 * After the helper resolves, the caller is on the Dashboard with the
 * "Registra Ospite" button visible.
 */
export async function enterSsoDemoSandbox(page: Page): Promise<void> {
  await setupSsoCommonRoutes(page, { wlcPostResponse: 'unreachable' });

  await ssoSelectSedeAndFillForm(page);

  await page.getByTestId('wlc-connect-btn').click();

  // Demo Sandbox modal
  const sandboxBtn = page.getByRole('button', { name: /Abilita Demo Sandbox/i });
  await expect(sandboxBtn).toBeVisible({ timeout: 15_000 });
  await sandboxBtn.click();

  // Dashboard
  await expect(page.getByTestId('register-guest-btn')).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * E2E helper: mock SSO routes and perform a successful WLC login with an
 * SSO-authenticated user (Mario Rossi). WLC login succeeds → Dashboard in
 * connected mode.
 *
 * After the helper resolves, the caller is on the Dashboard with the
 * "Registra Ospite" button visible and the connected badge showing @ host.
 */
export async function enterSsoHappyPath(page: Page): Promise<void> {
  await setupSsoCommonRoutes(page, { wlcPostResponse: 'success' });

  await ssoSelectSedeAndFillForm(page);

  // WLC login succeeds → Dashboard renders directly (no Demo Sandbox modal)
  await page.getByTestId('wlc-connect-btn').click();

  // Dashboard
  await expect(page.getByTestId('register-guest-btn')).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * E2E helper: mock SAML as not configured and verify the WLC login screen
 * appears without SSO elements.
 *
 * Intercepts /api/auth/me → 404, simulating a deployment where SAML_ENTRY_POINT
 * is not set. The app bypasses SSO entirely and shows the WLC login / sede
 * selector directly, without any SSO user tag or SSO login link.
 *
 * After the helper resolves, the caller is on the WLC login screen with the
 * "Seleziona la sede" heading visible.
 */
export async function enterSsoUnavailable(page: Page): Promise<void> {
  // Intercept /api/auth/me → 404 (SAML not configured)
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: 'SSO is not configured.',
      }),
    });
  });

  await page.goto('/');

  await expect(page.getByRole('heading', { name: /Seleziona la sede/i })).toBeVisible({
    timeout: 15_000,
  });
}

/** Open the "Register Guest" modal and wait for its title. */
export async function openRegisterGuestModal(page: Page): Promise<void> {
  await page.getByTestId('register-guest-btn').click();
  await expect(page.getByRole('heading', { name: /Registra Nuovo Ospite/i })).toBeVisible();
}
