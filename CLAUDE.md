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

### Free deploy mapping (LIVE since 2026-05-28)

- Dashboard: **https://qhs.fyi** (Cloudflare Pages, static Astro build)
  - The `-6ft` suffix is CF's automatic disambiguator because `qhs.pages.dev` is
    held by an unrelated company. The suffix goes away after we buy a domain.
- API worker: **https://api.qhs.fyi** (`wrangler deploy --env api`)
- Share worker: **https://s.qhs.fyi** (`wrangler deploy --env share`)
- D1: `quick-html-sharing` (`abc8df6d-3fd3-4331-84a1-5974299d6666`, APAC region)
- R2 bucket: `quick-html-sharing`
- CF account subdomain: `desperli` (account id `47972744b4002d07fc66280dc5181478`)

The api and share workers run the **same source** but separate deploys give them
distinct origins, which is what the dispatch logic in `src/index.ts` keys on.

### Production mapping (after buying a domain)

Collapse to one worker behind two routes:
- `app.<domain>/api/*` → dashboard host
- `s.<domain>/*` → share host

## Distribution surfaces (agent integrations)

The hosted API is wrapped by two consumer-facing packages so vibe coders can share
HTML directly from inside their coding agent:

- **`packages/mcp/`** — `quick-html-share-mcp` npm package. Stdio MCP server with 9
  tools: `qhs_share`, `qhs_edit`, `qhs_delete`, `qhs_stats`, `qhs_list`,
  `qhs_versions`, `qhs_preview_version`, `qhs_restore`, `qhs_set_sync_code`. Works
  with Claude Desktop, Cursor, Codex CLI, Continue, or any MCP client.
  The runtime version lives in **one** place, `src/client.ts`'s exported `VERSION`
  — it used to be duplicated into the `McpServer` handshake, which then reported a
  two-releases-stale number to every client that asked.
- **`packages/skill/`** — Claude Code skill (`SKILL.md` + standalone Node helper at
  `scripts/qhs.mjs`). User-scope install: `ln -s $(pwd)/packages/skill ~/.claude/skills/qhs`.

Both share the same local edit-token store at `~/.qhs/shares.json` (mirrors the
web "Recent on this device" pattern). **Endpoint is hardcoded** to the hosted
worker — `QHS_ENDPOINT` env var exists only for internal dev/test and must NOT be
documented for end users (it would let them self-host and undercut monetization).

## Architecture decisions (DO NOT change without re-running /plan-eng-review)

1. **Edit auth via URL fragment (`#edit=token`)**, NEVER URL path or query string. Fragments don't go to server logs.
2. **Upload uses D1-first transactional pattern**: insert `pending` row → write R2 → update to `committed`. A cleanup job sweeps stale `pending` rows older than 5 min. This avoids R2 orphans on partial failures.
3. **Report endpoint dedupes** via D1 unique constraint `(slug, reporter_ip_hash)`. Without this the abuse endpoint is itself abusable.
4. **No JS injection into user HTML.** v1 only counts page views server-side. View duration tracking is a v2 opt-in feature.
5. **Workers Paid plan ($5/mo) recommended** — free tier 10ms CPU/req is too tight given R2 read + D1 INSERT on every share view.
6. **Version writes are R2-first, the reverse of upload** (decision 2). `writeNewVersion` does a conditional put (`etagDoesNotMatch: '*'`) to claim a version number, then a D1 CAS to commit it. The order is forced: the moment `latest_version` advances, the share renderer starts asking R2 for that key, so the object has to already exist. The conditional put is what makes the claim exclusive — a plain put would let two writers land on the same key and leave `content_size` describing one writer's HTML while the object holds the other's. A writer that loses the CAS deletes its own object immediately; that is only safe *because* the put was a create.
7. **Restore appends a new version, never moves a pointer.** `latest_version` is a pure monotonic counter, so there is no "current version" state machine to corrupt, and restore is itself reversible. The cost is that version numbers have gaps under contention, which is fine — they are identifiers, not a count.
8. **v1 keeps the pre-versioning flat key** (`shares/{slug}.html`); v2+ live under `shares/{slug}/`. Zero data migration and no fallback on the read path. The price is that v1 sits outside the prefix, so anything enumerating a share's versions must handle it separately — version list, retention sweep, and delete. `htmlObjectKey` takes no default `version` so forgetting the argument is a compile error, not a silent overwrite of v1.
9. **R2's own object versioning is unusable here.** It is GA, but the Workers binding exposes no `versionId` on get/put/head/list/delete, and its retention is a bucket-wide lifecycle rule rather than per-share "keep the last N". Both blockers must disappear before dropping `lib/objectKey.ts`.
10. **Bot views are recorded but excluded from `views`**, and surfaced separately as `botViews`. Link unfurlers (Slack, Discord, iMessage…) hit the page the moment the URL is pasted, so unfiltered counts show views before any human opened it. Matching is deliberately conservative — explicit UA self-identification only, and a *missing* UA counts as human, because a false positive silently eats a real view.
11. **Referrer is normalized to a bare hostname at write time**, not at read time. `Referer` is attacker-controlled and unbounded, so storing it verbatim let anyone holding a share URL mint unlimited `GROUP BY` groups and turn public stats into an unbounded D1 read. Storing the final bucket is what makes `ORDER BY count DESC LIMIT N` correct. `referrerSource` must keep handling all three stored shapes (bare host / legacy full URL / legacy junk) — feeding a bare host back through `normalizeReferrer` throws and silently labels every modern row `other`.
12. **View PII (`ua`, `referrer`, `country`, `city`) is nulled after 90 days by a bounded-batch sweep**; the row itself survives so historical counts never change. Both the referrer and location breakdowns are scoped to the same window, so on an old share they legitimately sum to less than `views`. Batches are bounded because one oversized open-ended UPDATE fails D1's execution limit, and the next run rebuilds the identical statement — PII that should expire would then never expire, silently. **Adding a viewer field means adding it to three places**: the sweep's UPDATE, the sweep's candidate predicate, *and* `idx_views_retention`. Miss the last two and a row carrying only that field sits outside the partial index and is never swept — which is exactly what migration 0006 had to repair.
13. **Viewer location comes from `request.cf`, and cannot be backfilled.** Cloudflare resolves `country` and `city` on every request, so there is no GeoIP lookup, no added latency and no third party. It also has to be captured at write time or never: the only other field that could infer location is the IP, and that is stored as a salted one-way hash. Migration 0006 is therefore a hard line — every view before it has no location, permanently. Both columns stay nullable because CF often resolves a country but not a city (VPN, corporate egress, mobile carrier); a missing value must read as unknown, never as a guess, and an empty string is treated the same as null rather than rendered as `Taipei, ` or a bare comma.
14. **Aggregations over viewer fields are always bounded, for two different reasons.** `referrers` and `locations` share one shape — `GROUP BY … ORDER BY count DESC LIMIT N`, tail derived from a window total rather than listed — but not one rationale. For referrers the bound is a security control (decision 11). For locations it is editorial: CF supplies the value so cardinality is not attackable, but a link that genuinely travels lands in more cities than anyone wants listed, and the tail is not information. Worth knowing before relaxing either: loosening the location limit is a product call, loosening the referrer limit reopens a DoS.
15. **Write endpoints (edit, restore) are IP-rate-limited, and the limiter fails open.** Restore is the asymmetric one: a few dozen request bytes make the server copy up to 1 MB, so a loop inflates storage far faster than uploading could. Retention bounds steady-state size, not a burst — it is not an abuse control. Fail-open is intentional: authorization already ran, this is a filter, and a missing binding (local dev, tests, share env) must not become an outage.

Tunable policy constants (retention depth, rate limits, size caps, PII window) live in
`packages/shared/src/index.ts` and are the single source of truth — read the values there
rather than copying numbers into docs.

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
