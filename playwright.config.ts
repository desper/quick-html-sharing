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
 *
 * A THIRD server runs the same worker source with WORKER_ROLE=share, because
 * "the share URL shows the restored content" is the payoff of the whole version
 * feature and cannot be asserted against the dashboard role — that role never
 * routes /:slug to the renderer. Both wrangler processes bind the same local
 * D1 + R2 state, which is exactly the coupling under test: one process commits
 * the version, the other must serve it.
 */
export const SHARE_ORIGIN = 'http://localhost:8788';

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
      // Share role, same source and same local state as the api worker above.
      // Started after it so the schema is already applied when this one opens
      // the database.
      command: 'bun run --filter @qhs/worker dev:share',
      port: 8788,
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
