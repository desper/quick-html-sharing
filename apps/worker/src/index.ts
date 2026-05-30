import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv, Bindings } from './types';
import { dashboardSecurityHeaders } from './middleware/security-headers';
import { uploadRoute } from './routes/upload';
import { editRoute } from './routes/edit';
import { reportRoute } from './routes/report';
import { statsRoute } from './routes/stats';
import { sharePageRoute } from './routes/share-page';
import { cleanupStalePending } from './routes/cleanup';

/**
 * Worker entrypoint.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ Hostname-based dispatch                                          │
 *   │                                                                  │
 *   │   app.<DOMAIN>/api/*   → dashboardApp (JSON API, strict CSP)     │
 *   │   s.<DOMAIN>/*         → shareApp    (renders user HTML)         │
 *   │                                                                  │
 *   │ Splitting by hostname is what isolates uploaded HTML from        │
 *   │ dashboard cookies. A single combined origin would let phishing   │
 *   │ pages attack dashboard auth — see CLAUDE.md.                     │
 *   └──────────────────────────────────────────────────────────────────┘
 */
const app = new Hono<AppEnv>();

// ---- dashboard / API surface ----
const dashboardApp = new Hono<AppEnv>();
dashboardApp.use('*', dashboardSecurityHeaders);
dashboardApp.use(
  '/api/*',
  cors({
    origin: (origin, c) => {
      // Allow only the dashboard host. Browsers block cross-site fetches from
      // share subdomain to /api/* without this; we explicitly close it.
      const allowed = `https://${c.env.DASHBOARD_HOST}`;
      return origin === allowed ? origin : '';
    },
    credentials: false,
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  }),
);

dashboardApp.route('/api', uploadRoute);
dashboardApp.route('/api', editRoute);
dashboardApp.route('/api', reportRoute);
dashboardApp.route('/api', statsRoute);

dashboardApp.get('/api/health', (c) => c.json({ ok: true, host: 'dashboard' }));
dashboardApp.notFound((c) => c.json({ error: 'not_found' }, 404));

// ---- share rendering surface ----
const shareApp = new Hono<AppEnv>();
shareApp.route('/', sharePageRoute);
shareApp.notFound((c) =>
  c.html(
    `<!doctype html><meta charset=utf-8><title>404</title>` +
      `<style>body{font:14px/1.4 system-ui;padding:40px;color:#333}</style>` +
      `<h1>Not found</h1><p>This share doesn't exist or was deleted.</p>`,
    404,
  ),
);

// ---- top-level dispatch ----
//
// Production deploys hardcode WORKER_ROLE in wrangler.toml so a worker bound
// to multiple hostnames (custom domain + *.workers.dev fallback) still routes
// correctly. Tests that don't set WORKER_ROLE fall back to the original
// host-based check so a single deploy can simulate both roles from the same
// vitest worker.
app.all('*', async (c) => {
  const role = c.env.WORKER_ROLE;
  const host = new URL(c.req.url).host.toLowerCase();
  const isShare =
    role === 'share' || (!role && host === c.env.SHARE_HOST.toLowerCase());
  if (isShare) {
    return shareApp.fetch(c.req.raw, c.env, c.executionCtx);
  }
  return dashboardApp.fetch(c.req.raw, c.env, c.executionCtx);
});

export default {
  fetch: app.fetch,
  /**
   * Cron entry — wired in wrangler.toml after first deploy via
   *   [triggers]
   *   crons = ["*\/10 * * * *"]
   */
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(cleanupStalePending(env).then(() => undefined));
  },
} satisfies ExportedHandler<Bindings>;
