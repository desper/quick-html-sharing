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
      // API base. In production this is the same origin as the dashboard, so
      // we use a relative path. Override for local dev via env if needed.
      'import.meta.env.PUBLIC_API_BASE': JSON.stringify(
        process.env.PUBLIC_API_BASE ?? '/api',
      ),
    },
  },
});
