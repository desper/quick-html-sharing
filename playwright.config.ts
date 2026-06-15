import { defineConfig, devices } from '@playwright/test';

/**
 * E2E harness (eng-review Issue 7A / PR2). Boots the real worker (local D1 + R2
 * via miniflare) and the Astro dev server, then drives Chromium through the My
 * Shares flows that unit tests can't reach: localStorage sync-key lifecycle,
 * cross-context import, and the upload→enroll→list round trip.
 *
 * The web dev server proxies /api → the worker (astro.config.mjs), so the
 * browser is same-origin in dev. Production is cross-origin; its CORS/preflight
 * behavior is pinned separately by apps/worker/test/security.test.ts.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4321',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Applies the schema to the local D1 first, then serves the worker.
      command: 'bun run --filter @qhs/worker dev:e2e',
      port: 8787,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'bun run --filter @qhs/web dev',
      port: 4321,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
