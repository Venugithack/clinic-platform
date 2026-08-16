import { defineConfig, devices } from '@playwright/test';

/**
 * Tablet viewport only. TABLET.md §8.
 *
 * There is no desktop project here and there should never be one. Both clinic
 * screens are 10–11" tablets on stands, landscape-locked, and a suite that
 * passes at 1440px wide tells you nothing about the device the pharmacist is
 * actually holding.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'clinic-tablet',
      use: {
        ...devices['Galaxy Tab S4 landscape'],
        viewport: { width: 1280, height: 800 },
        hasTouch: true,
        isMobile: false,
        // The clinic's own tablets are Chromium. CI installs the build that
        // matches the pinned @playwright/test; PLAYWRIGHT_CHROMIUM_PATH lets a
        // sandbox with a pre-baked browser point at that one instead of
        // downloading a second copy.
        browserName: 'chromium',
        ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
          : {}),
      },
    },
  ],

  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm build && pnpm start',
        url: 'http://127.0.0.1:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
