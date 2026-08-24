import { defineConfig, devices } from '@playwright/test';

/**
 * Tablet viewport only. TABLET.md §8.
 *
 * There is no desktop project here and there should never be one. Both clinic
 * screens are 10–11" tablets on stands, landscape-locked, and a suite that
 * passes at 1440px wide tells you nothing about the device the pharmacist is
 * actually holding.
 */
/**
 * This suite requires the development seed, and requires it FRESH.
 *
 * The specs assert against seeded rows by name and by number, deliberately:
 * m3-expiry names Shelcal and Zincovit because the seed places one inside its
 * supplier's return window and one past it, and m9-offline asserts a count of
 * exactly one unbilled counter sale because "it landed once" is the property
 * under test. Both are the right assertions and neither survives a database
 * that has already been run against.
 *
 * So `pnpm test:e2e` resets before it runs, and CI does the same. Without that
 * the suite passes once and then fails on the second run with counts that have
 * drifted — 7 specs, all of them reporting a number that looks like a real
 * regression and is not. That symptom cost a debugging session once already;
 * the reset is what stops it being rediscovered.
 *
 * The consequence to know about: running the E2E suite DISCARDS whatever is in
 * the local database. That is the intended trade — a suite that only passes on
 * a virgin database, without guaranteeing one, is a suite that lies.
 */
export default defineConfig({
  testDir: './e2e',
  /**
   * `e2e/first-run/` is excluded on purpose.
   *
   * It is the one suite that needs an EMPTY database, and every other spec
   * needs the seed. `scripts/first-run-drill.sh` runs it on its own, between
   * the reset and the seed, and puts the seed back afterwards.
   */
  testIgnore: process.env.E2E_FIRST_RUN ? [] : ['first-run/**'],
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
        // Not `pnpm start`. `next start` refuses outright under
        // `output: 'export'` — there is no server build for it to run — and
        // scripts/serve-out.mjs resolves paths by wrangler.jsonc's rules, so
        // the suite exercises the export the way Cloudflare will serve it.
        command: 'pnpm build && node scripts/serve-out.mjs',
        url: 'http://127.0.0.1:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
