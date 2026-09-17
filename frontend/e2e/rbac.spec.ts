/**
 * End-to-end coverage of the authorization boundary, with the backend mocked.
 *
 * Runs in the frontend-only pipeline alongside the SSO suite: no database and
 * no controller, just the screens a user actually reaches depending on what the
 * directory says about them.
 *
 * What the UI does here is a convenience. Whether a request is refused is
 * decided by the API, and that is covered by the backend tests — these check
 * that somebody blocked is told why, and that a read-only user is not shown
 * buttons that would fail.
 */
import { test, expect, type Page } from '@playwright/test';
import { mockBreakGlassStatus } from './helpers/auth';

interface Profile {
  role: 'admin' | 'operator' | 'viewer' | null;
  status: 'pending' | 'active' | 'suspended';
  sedeIds?: number[] | null;
}

const SEDE = {
  id: 1, code: 'MIL', name: 'Dompe Milano HQ', city: 'Milano', address: 'Via Roma 1',
  wlcConfigId: null, createdAt: '2026-01-01T00:00:00.000Z', wlcSsid: 'Dompe Guest',
};

const WLC = {
  id: 1, host: '172.18.106.100', port: 443, sshPort: 22, username: 'admin_guest',
  wlanSsid: 'Dompe Guest', authenticated: true, usable: true, sedeId: 1,
};

const GUEST = {
  id: 'g-1', name: 'Ospite Uno', email: 'ospite@example.com', phone: null,
  company: 'Acme', host: 'Mario Rossi', username: 'g.ospite001', password: null,
  durationMinutes: 240, elapsedSeconds: 60, status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z', enabledAt: '2026-01-01T00:00:00.000Z',
  remarks: null, sedeId: 1,
};

/** Mock the whole API for a user with the given profile. */
async function signInAs(page: Page, profile: Profile, opts?: { sedi?: unknown[] }): Promise<void> {
  await mockBreakGlassStatus(page);

  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          nameID: 'mario.rossi@dompe.com',
          email: 'mario.rossi@dompe.com',
          displayName: 'Mario Rossi',
          givenName: 'Mario',
          surname: 'Rossi',
          objectId: 'oid-1',
          authMethod: 'saml',
          role: profile.role,
          status: profile.status,
          sedeIds: profile.sedeIds ?? [1],
        },
      }),
    });
  });

  await page.route('**/api/session/context', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          user: {
            displayName: 'Mario Rossi',
            email: 'mario.rossi@dompe.com',
            role: profile.role,
            status: profile.status,
            sedeIds: profile.sedeIds ?? [1],
          },
          sede: SEDE,
          wlc: WLC,
        },
      }),
    });
  });

  await page.route('**/api/sedi**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: opts?.sedi ?? [SEDE] }),
    });
  });

  await page.route('**/api/guests**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [GUEST] }),
    });
  });

  await page.route('**/api/auth/logout', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });

  // Anything not matched above answers empty rather than failing the page.
  await page.route('**/api/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });

  await page.goto('/');
}

test.describe('authorization', () => {
  /**
   * Anybody in the tenant can complete SSO, and the directory grants nothing
   * until an admin profiles the entry. Such a user has to land on an
   * explanation — not on a console where every action fails, and not back on
   * the sign-in page they just completed.
   */
  test('an unprofiled user sees why they are blocked, not the console', async ({ page }) => {
    await signInAs(page, { role: null, status: 'pending' });

    await expect(page.getByTestId('pending-approval')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('register-guest-btn')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Seleziona la sede/i })).toHaveCount(0);
    // The address they have to quote to an administrator.
    await expect(page.getByText('mario.rossi@dompe.com')).toBeVisible();
  });

  test('a suspended user gets the suspended wording', async ({ page }) => {
    await signInAs(page, { role: 'operator', status: 'suspended' });

    await expect(page.getByTestId('pending-approval')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/sospeso/i)).toBeVisible();
  });

  test('a blocked user can sign out', async ({ page }) => {
    await signInAs(page, { role: null, status: 'pending' });

    await expect(page.getByTestId('pending-approval')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('pending-logout-btn').click();

    await expect(page.getByTestId('pending-approval')).toHaveCount(0);
  });

  test('a viewer gets the dashboard without anything that changes state', async ({ page }) => {
    await signInAs(page, { role: 'viewer', status: 'active' });

    await expect(page.getByText('Ospite Uno')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('register-guest-btn')).toHaveCount(0);
    await expect(page.getByTestId('settings-button')).toHaveCount(0);
    await expect(page.getByTitle(/Elimina|Delete/i)).toHaveCount(0);
    // Reading is what the role is for, so copying stays.
    await expect(page.getByTitle(/Copia|Copy/i).first()).toBeVisible();
  });

  test('an operator manages guests but cannot administer', async ({ page }) => {
    await signInAs(page, { role: 'operator', status: 'active' });

    await expect(page.getByTestId('register-guest-btn')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('settings-button')).toHaveCount(0);
  });

  test('an admin reaches the administration panel', async ({ page }) => {
    await signInAs(page, { role: 'admin', status: 'active' });

    await expect(page.getByTestId('settings-button')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('admin-panel')).toBeVisible({ timeout: 10_000 });
  });

  /**
   * Distinguished from "nothing is configured": an operator granted no sites
   * needs an administrator, not a network engineer.
   */
  test('an operator with no sites is told to ask an administrator', async ({ page }) => {
    await signInAs(page, { role: 'operator', status: 'active', sedeIds: [] }, { sedi: [] });

    await page.route('**/api/session/context', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            user: { displayName: 'Mario Rossi', email: 'mario.rossi@dompe.com', role: 'operator', status: 'active', sedeIds: [] },
            sede: null,
            wlc: null,
          },
        }),
      });
    });
    await page.reload();

    await expect(page.getByTestId('sede-empty')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('sede-empty')).toContainText(/abilitata|enabled/i);
  });

  /**
   * "Cambia sede" keeps the application session: it releases the controller
   * binding and nothing else. The button it replaced wrote to a shared row and
   * could stop provisioning for a site somebody else was working on.
   */
  test('changing sede returns to the selector without signing out', async ({ page }) => {
    await signInAs(page, { role: 'operator', status: 'active' });

    await expect(page.getByTestId('change-sede-btn')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('change-sede-btn').click();

    await expect(page.getByRole('heading', { name: /Seleziona la sede/i })).toBeVisible({ timeout: 10_000 });
    // Still signed in: the user tag is there and the SSO screen is not.
    await expect(page.getByText('Mario Rossi')).toBeVisible();
    await expect(page.getByRole('link', { name: /Accedi con/i })).toHaveCount(0);
  });
});
