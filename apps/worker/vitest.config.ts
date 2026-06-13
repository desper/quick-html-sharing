import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * We deliberately do NOT load wrangler.toml via `wrangler.configPath` here.
 * Wrangler vars contain `<TBD-DOMAIN>` placeholders that would override the
 * test bindings below and break host-based routing in the Worker.
 *
 * Instead, every binding the Worker needs is specified explicitly in
 * miniflare config — D1, R2, and the host vars.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      miniflare: {
        bindings: {
          DASHBOARD_HOST: 'app.example.com',
          SHARE_HOST: 's.example.com',
          IP_HASH_SALT: 'test-salt',
        },
        d1Databases: ['DB'],
        r2Buckets: ['HTML_BUCKET'],
        compatibilityDate: '2024-12-30',
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
