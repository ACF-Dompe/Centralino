import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E config for the Cisco Catalyst 9800 Guest Management Desk.
 *
 * The test suite targets the running Docker container on `http://localhost:3000`.
 * To run:
 *   cd frontend
 *   npm run test:e2e         # headless
 *   npm run test:e2e:ui      # interactive UI mode
 *
 * The container must be up before running the tests:
 *   cd .. && docker compose up -d
 */
export default defineConfig({
  testDir: './e2e',
  // The calendar modal close button + polling cycles need a generous timeout.
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Fail the build on `npm run test:e2e` if any test fails.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // single worker — the app uses a single shared SQLite DB
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Video recording requires the Playwright-bundled ffmpeg, which is not
    // available for this host OS. Screenshots on failure are sufficient
    // for debugging — set E2E_VIDEO=1 once ffmpeg is installed to re-enable.
    video: process.env.E2E_VIDEO ? 'retain-on-failure' : 'off',
    // The app is Italian by default — we keep that for the calendar E2E.
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    // If the bundled Playwright Chromium is not available for this OS
    // (e.g. newer distros not yet whitelisted by Playwright), fall back to
    // the system Chrome installed at /usr/bin/google-chrome.
    channel: process.env.E2E_USE_SYSTEM_CHROME ? 'chrome' : undefined,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
