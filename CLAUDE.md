# Project: quick-html-sharing

Indie SaaS — instant HTML sharing for vibe coders. Unguessable URLs + viewer analytics.

## Stack (locked by /plan-eng-review)

- Frontend: Astro + minimal islands, deployed to Cloudflare Pages
- API + share renderer: Cloudflare Workers + Hono router
- HTML storage: Cloudflare R2 (egress free)
- Metadata + view events: Cloudflare D1 (SQL)
- Lint/format: Biome (single tool replaces ESLint+Prettier)
- Tests: Vitest + `@cloudflare/vitest-pool-workers` for Worker, Playwright for E2E
- Package manager: bun (workspaces)

## Subdomain layout (security-critical)

Two distinct origins, regardless of how they're hosted:

- **Dashboard origin** — Astro static site (sender uses URL-fragment edit tokens)
- **Share origin** — uploaded HTML rendered here, isolated from dashboard cookies

User-uploaded HTML must NEVER be served from the same origin as the dashboard. This is the core security property — if you change it, phishing pages can attack dashboard cookies.

### Free deploy mapping (current)

- Dashboard: `qhs.pages.dev` (Cloudflare Pages, static Astro build)
- API worker: `qhs-api.<acct>.workers.dev` (`wrangler deploy --env api`)
- Share worker: `qhs-share.<acct>.workers.dev` (`wrangler deploy --env share`)

The api and share workers run the **same source** but separate deploys give them
distinct origins, which is what the dispatch logic in `src/index.ts` keys on.

### Production mapping (after buying a domain)

Collapse to one worker behind two routes:
- `app.<domain>/api/*` → dashboard host
- `s.<domain>/*` → share host

## Placeholders to replace before deploy

- `<TBD-CF-ACCOUNT>` — your Cloudflare workers.dev subdomain. Files:
  - `apps/worker/wrangler.toml` (vars in env.api + env.share)
  - `apps/web/.env.example` → copy to `.env.production`
- `<TBD-D1-DATABASE-ID>` — output of `wrangler d1 create`. Files:
  - `apps/worker/wrangler.toml` (both env blocks)
- `<TBD-DOMAIN>` (only when you buy a real domain): grep all repo files

## Architecture decisions (DO NOT change without re-running /plan-eng-review)

1. **Edit auth via URL fragment (`#edit=token`)**, NEVER URL path or query string. Fragments don't go to server logs.
2. **Upload uses D1-first transactional pattern**: insert `pending` row → write R2 → update to `committed`. A cleanup job sweeps stale `pending` rows older than 5 min. This avoids R2 orphans on partial failures.
3. **Report endpoint dedupes** via D1 unique constraint `(slug, reporter_ip_hash)`. Without this the abuse endpoint is itself abusable.
4. **No JS injection into user HTML.** v1 only counts page views server-side. View duration tracking is a v2 opt-in feature.
5. **Workers Paid plan ($5/mo) recommended** — free tier 10ms CPU/req is too tight given R2 read + D1 INSERT on every share view.

## Routing rules

- Bugs / errors / "why is this broken" → invoke /investigate
- Code review / pre-PR → invoke /review
- Ship / deploy / push → invoke /ship
- Test the site / find bugs → invoke /qa
- Visual polish on live UI → invoke /design-review
- Design review on plan stage → invoke /plan-design-review
- Architecture review → invoke /plan-eng-review
- Save progress → invoke /context-save

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill tool as the FIRST action.

## Testing

```bash
bun run test                          # run all tests
bun run --filter @qhs/worker test     # worker tests only
```

## Prompt/LLM changes

This project does not use LLMs in production code. If we add LLM integration later, document eval suites here.
