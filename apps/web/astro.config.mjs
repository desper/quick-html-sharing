import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // Used for canonical URLs in OG tags. Replace before deploy.
  // Uses .invalid (RFC 6761 reserved) so it's a valid URL but never resolves.
  site: 'https://app.tbd-domain.invalid',
  output: 'static',
  trailingSlash: 'never',
  build: {
    format: 'file',
  },
  vite: {
    define: {
      // API base. Default `/api` works when dashboard + api are same-origin
      // (custom domain). For free CF deploy, set
      //   PUBLIC_API_BASE=https://qhs-api.<acct>.workers.dev/api
      // before running `bun run build`.
      'import.meta.env.PUBLIC_API_BASE': JSON.stringify(
        process.env.PUBLIC_API_BASE ?? '/api',
      ),
      // Share host for "Open share" buttons. Empty string means same-origin
      // (custom domain). Set to e.g.
      //   PUBLIC_SHARE_BASE=https://qhs-share.<acct>.workers.dev
      'import.meta.env.PUBLIC_SHARE_BASE': JSON.stringify(
        process.env.PUBLIC_SHARE_BASE ?? '',
      ),
    },
  },
});
