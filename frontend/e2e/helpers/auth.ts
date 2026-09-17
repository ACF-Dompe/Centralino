import { expect, type Page } from '@playwright/test';

/**
 * E2E helper: mock the break-glass status endpoint.
 *
 * The SSO screen asks the backend whether the emergency login is usable before
 * rendering its link. Left unmocked the call would reach the real backend and
 * make the presence of that link depend on the environment, so every helper
 * that renders the SSO screen pins it — disabled by default, which is what a
 * healthy production tenant looks like.
 */
export async function mockBreakGlassStatus(page: Page, enabled = false): Promise<void> {
  await page.route('**/api/auth/breakglass/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { enabled } }),
    });
  });
}

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

  await mockBreakGlassStatus(page);

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
  // Clicking the card connects: the controller parameters come from the site
  // record, so there is no form to fill in and nothing to override. The mocked
  // wlc/login answers `isUnreachable`, which is what raises the sandbox prompt.
  await page.getByRole('button', { name: /Dompe Milano HQ/i }).first().click();

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
 * sedi, guests, auth/logout.
 */
export async function setupSsoCommonRoutes(
  page: Page,
  options?: { wlcPostResponse?: 'success' | 'unreachable' },
): Promise<void> {
  const wlcResponse = options?.wlcPostResponse;

  await mockBreakGlassStatus(page);

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
          authMethod: 'saml',
          // Authorization travels with the profile. Without a role the UI falls
          // back to permissive, which would make the gating tests meaningless.
          role: 'admin',
          status: 'active',
          sedeIds: [1],
        },
      }),
    });
  });

  // 2. Session context — who, what they may do, and which site they are on.
  //    Replaces the old /api/config/wlc bootstrap, which inferred the current
  //    site from a configuration table and could restore the wrong one.
  await page.route('**/api/session/context', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          user: {
            displayName: 'Mario Rossi',
            email: 'mario.rossi@dompe.com',
            role: 'admin',
            status: 'active',
            sedeIds: null,
          },
          sede: null,
          wlc: null,
        },
      }),
    });
  });

  await page.route('**/api/session/sede', async (route) => {
    await route.fulfill({ status: 204, body: '' });
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

/**
 * Set up SSO logout routes: auth/me → 401 (not authenticated) and
 * auth/logout → configurable status (200 success or 500 failure).
 *
 * Register this AFTER enterSsoHappyPath so it takes LIFO priority
 * over setupSsoCommonRoutes's handlers.
 */
export async function setupSsoLogoutRoutes(
  page: Page,
  options?: { logoutStatus?: 200 | 500 },
): Promise<void> {
  // After logout the app calls auth/me → must return 401
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

  // Intercept POST /api/auth/logout with configurable HTTP status
  const logoutStatus = options?.logoutStatus ?? 200;
  await page.route('**/api/auth/logout', async (route) => {
    if (route.request().method() === 'POST') {
      if (logoutStatus === 200) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      } else {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: 'Internal server error.',
          }),
        });
      }
    } else {
      await route.fallback();
    }
  });
}

/**
 * Navigate to the site selector and connect to the first site.
 *
 * There is no form to fill in any more: the controller's address, ports, admin
 * account and SSID come from the site record, so choosing a site IS the connect
 * action. The mail address is deliberately not asserted here — the user tag
 * shows the name only, with the address in its tooltip.
 */
async function ssoSelectSede(page: Page): Promise<void> {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: /Seleziona la sede/i })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('Mario Rossi')).toBeVisible();

  await page.getByTestId('sede-card-MIL').click();
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

  await ssoSelectSede(page);

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

  await ssoSelectSede(page);

  // The click on the card IS the connect action; on success the Dashboard
  // renders directly, with no Demo Sandbox modal in between.

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
  await mockBreakGlassStatus(page);

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
