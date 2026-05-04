# Quick HTML Sharing

Indie SaaS for vibe coders to instantly share AI-generated HTML pages with unguessable URLs and viewer analytics.

## Architecture

- `apps/web/` — Astro dashboard (will live at `<TBD-DOMAIN>`)
- `apps/worker/` — Cloudflare Worker API + share renderer (Hono)
- `packages/shared/` — types shared between web and worker

Hosted on Cloudflare: Pages (web) + Workers (api/share) + R2 (HTML files) + D1 (metadata + view events).

## Dev

```bash
bun install
bun run dev:worker    # apps/worker on :8787
bun run dev:web       # apps/web on :4321
```

## Deploy (TBD before launch)

1. Replace `<TBD-DOMAIN>` everywhere — grep the repo
2. Register domain + 2 subdomains: `app.example.com` (dashboard), `s.example.com` (share)
3. `wrangler login`
4. `wrangler d1 create quick-html-sharing` → paste `database_id` into `apps/worker/wrangler.toml`
5. `wrangler r2 bucket create quick-html-sharing`
6. `wrangler d1 execute quick-html-sharing --remote --file=apps/worker/db/schema.sql`
7. `bun run --filter @qhs/worker deploy`

## Design + plan docs

Outside the repo (per-user gstack workspace):

- Design: `~/.gstack/projects/quick-html-sharing/seanlee-main-design-*.md`
- Test plan: `~/.gstack/projects/quick-html-sharing/seanlee-main-eng-review-test-plan-*.md`
