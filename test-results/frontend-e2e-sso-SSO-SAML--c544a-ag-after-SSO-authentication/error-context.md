# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: frontend/e2e/sso.spec.ts >> SSO SAML login screen >> shows the WLC login with SSO user tag after SSO authentication
- Location: frontend/e2e/sso.spec.ts:18:3

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "load"

```

# Test source

```ts
  1   | /**
  2   |  * E2E tests for the SSO SAML 2.0 login screen (Entra ID / Microsoft).
  3   |  *
  4   |  * The app's auth flow has 4 phases:
  5   |  *   loading → sso-required (SAML configured, 401) → WLC login → Dashboard
  6   |  *           → sso-unavailable (SAML not configured, 404) → WLC login → Dashboard
  7   |  *           → sso-authenticated (200) → WLC login → Dashboard
  8   |  *
  9   |  * In local dev SAML_ENTRY_POINT is not set, so /api/auth/me returns 404 and
  10  |  * the app skips SSO entirely. To test the SSO screen we intercept the API
  11  |  * call and return 401, simulating a SAML-configured environment where the
  12  |  * user has not yet authenticated.
  13  |  */
  14  | import { test, expect } from '@playwright/test';
  15  | import { enterSsoDemoSandbox, enterSsoHappyPath, enterSsoUnavailable, setupSsoCommonRoutes } from './helpers/auth';
  16  | 
  17  | test.describe('SSO SAML login screen', () => {
  18  |   test('shows the WLC login with SSO user tag after SSO authentication', async ({
  19  |     page,
  20  |   }) => {
  21  |     await setupSsoCommonRoutes(page);
> 22  |     await page.goto('/');
      |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  23  | 
  24  |     // The sede selector heading should appear (WLC login phase)
  25  |     await expect(
  26  |       page.getByRole('heading', { name: /Seleziona la sede/i }),
  27  |     ).toBeVisible({ timeout: 15_000 });
  28  | 
  29  |     // The SSO user tag should be visible with name and email
  30  |     await expect(page.getByText('Mario Rossi')).toBeVisible();
  31  |     await expect(page.getByText('mario.rossi@dompe.com')).toBeVisible();
  32  | 
  33  |     // The SSO login link should NOT be present (already authenticated)
  34  |     await expect(
  35  |       page.getByRole('link', { name: /Accedi con SSO/i }),
  36  |     ).not.toBeVisible();
  37  | 
  38  |     // The sede card should be visible and clickable
  39  |     await expect(
  40  |       page.getByRole('button', { name: /Dompe Milano HQ/i }),
  41  |     ).toBeVisible();
  42  |   });
  43  | 
  44  |   test('shows the SSO login screen when SAML is configured but user is not authenticated', async ({
  45  |     page,
  46  |   }) => {
  47  |     // Intercept /api/auth/me → 401 (SAML configured, session missing)
  48  |     await page.route('**/api/auth/me', async (route) => {
  49  |       await route.fulfill({
  50  |         status: 401,
  51  |         contentType: 'application/json',
  52  |         body: JSON.stringify({
  53  |           success: false,
  54  |           error: 'Not authenticated. Use /api/auth/login to authenticate.',
  55  |         }),
  56  |       });
  57  |     });
  58  | 
  59  |     await page.goto('/');
  60  | 
  61  |     // The SSO heading should appear (Italian locale by default)
  62  |     await expect(
  63  |       page.getByRole('heading', { name: /Accesso con Single Sign-On/i }),
  64  |     ).toBeVisible({ timeout: 15_000 });
  65  | 
  66  |     // The SSO login button/link should be present and point to the IdP
  67  |     const loginLink = page.getByRole('link', { name: /Accedi con SSO/i });
  68  |     await expect(loginLink).toBeVisible();
  69  |     await expect(loginLink).toHaveAttribute('href', '/api/auth/login');
  70  | 
  71  |     // The corporate branding elements should also be visible
  72  |     await expect(page.getByText(/Dompè Guest Desk/i)).toBeVisible();
  73  |     await expect(page.getByText(/Corporate Console|Single Sign-On/i).first()).toBeVisible();
  74  |   });
  75  | 
  76  |   test('completes the full auth flow: SSO → select sede → WLC login → dashboard', async ({
  77  |     page,
  78  |   }) => {
  79  |     await enterSsoHappyPath(page);
  80  | 
  81  |     // Additional assertions after the helper resolves (Dashboard / connected)
  82  |     await expect(page.getByText('Mario Rossi')).toBeVisible();
  83  |     await expect(page.getByText('mario.rossi@dompe.com')).toBeVisible();
  84  |     await expect(page.getByText(/Dompe Milano HQ/i)).toBeVisible();
  85  | 
  86  |     // Connected badge shows @ host (WLC login succeeded)
  87  |     await expect(page.getByText(/@ 172\.18\.106\.100/i)).toBeVisible();
  88  | 
  89  |     // SSO logout button should be present
  90  |     await expect(
  91  |       page.getByRole('button', { name: /Esci|Logout|Disconnetti SSO/i }),
  92  |     ).toBeVisible();
  93  |   });
  94  | 
  95  |   test('creates a guest from the Dashboard after SSO authentication', async ({
  96  |     page,
  97  |   }) => {
  98  |     // Intercept POST /api/guests → 200 with mock guest response
  99  |     // Registered BEFORE enterSsoHappyPath for FIFO priority
  100 |     await page.route('**/api/guests*', async (route) => {
  101 |       if (route.request().method() === 'POST') {
  102 |         await route.fulfill({
  103 |           status: 200,
  104 |           contentType: 'application/json',
  105 |           body: JSON.stringify({
  106 |             data: {
  107 |               id: 'e2e-sso-guest-001',
  108 |               name: 'Mario SSO E2E',
  109 |               email: 'sso.e2e@example.com',
  110 |               phone: '+393331234567',
  111 |               company: 'SSO E2E Corp',
  112 |               host: 'Test Sponsor',
  113 |               username: 'guest-sso-e2e-001',
  114 |               oneTimePassword: 'TempPass123!',
  115 |               durationMinutes: 240,
  116 |               elapsedSeconds: 0,
  117 |               status: 'pending',
  118 |               createdAt: new Date().toISOString(),
  119 |               enabledAt: null,
  120 |               remarks: null,
  121 |               sedeId: 1,
  122 |             },
```