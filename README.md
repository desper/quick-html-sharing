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

## Deploy — free Cloudflare tier (no domain needed)

Two workers + one Pages site, all on `*.workers.dev` / `*.pages.dev`. Zero cost.

```bash
# 1. CF account + CLI auth (one-time)
wrangler login                                   # opens browser

# 2. Create the data plane (one-time)
cd apps/worker
wrangler d1 create quick-html-sharing            # → copy database_id
# paste the id into BOTH [[env.api.d1_databases]] and [[env.share.d1_databases]] in wrangler.toml
wrangler r2 bucket create quick-html-sharing
bun run db:apply:remote                          # apply schema.sql to remote D1

# 3. Set IP_HASH_SALT secret (one-time, both envs)
echo -n "$(openssl rand -hex 32)" | wrangler secret put IP_HASH_SALT --env api
echo -n "$(openssl rand -hex 32)" | wrangler secret put IP_HASH_SALT --env share
# (use the SAME value for both — IP-hash dedupe must match across workers)

# 4. Deploy both workers
bun run deploy:api                               # → qhs-api.<acct>.workers.dev
bun run deploy:share                             # → qhs-share.<acct>.workers.dev

# 5. Now grep wrangler.toml + apps/web/.env.example, replace <TBD-CF-ACCOUNT>
#    with your real account subdomain (shown in step 4 output), then redeploy:
bun run deploy

# 6. Build + deploy frontend to Pages
cd ../web
cp .env.example .env.production                  # then edit it
bun run build
# Push to GitLab → connect repo to Cloudflare Pages → it autodeploys
# Or one-shot: wrangler pages deploy dist --project-name=qhs
```

After step 6 you have:

- `https://qhs.pages.dev` — paste HTML, get URLs
- `https://qhs-api.<acct>.workers.dev` — API
- `https://qhs-share.<acct>.workers.dev/<slug>` — share rendering

When you later buy a domain, replace `[env.api]` + `[env.share]` blocks with a
single production block + `routes`.

## Design + plan docs

Outside the repo (per-user gstack workspace):

- Design: `~/.gstack/projects/quick-html-sharing/seanlee-main-design-*.md`
- Test plan: `~/.gstack/projects/quick-html-sharing/seanlee-main-eng-review-test-plan-*.md`
