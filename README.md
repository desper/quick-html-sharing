# Quick HTML Sharing

Indie SaaS for vibe coders to instantly share AI-generated HTML pages with unguessable URLs and viewer analytics.

**Live (free tier, since 2026-05-28):**

| Surface | URL |
|---------|-----|
| Dashboard (paste HTML, get URL) | https://qhs.fyi |
| API worker | https://api.qhs.fyi |
| Share worker | https://s.qhs.fyi/`<slug>` |

> ⚠️ Pages got the `-6ft` suffix because `qhs.pages.dev` is held by an unrelated company. It goes away after we buy a real domain (then we collapse to `s.<domain>` / `app.<domain>`).

## Architecture

- `apps/web/` — Astro dashboard (Cloudflare Pages)
- `apps/worker/` — Cloudflare Worker API + share renderer (Hono)
- `packages/shared/` — types shared between web and worker
- `packages/mcp/` — **`quick-html-share-mcp` npm package**: stdio MCP server for Claude Desktop / Cursor / Codex CLI / any MCP client
- `packages/skill/` — **Claude Code skill**: standalone, no MCP setup needed

Hosted on Cloudflare: Pages (web) + Workers (api/share) + R2 (HTML files) + D1 (metadata + view events).

## Install in your coding agent

Three paths depending on which client you use. All hit the same hosted API and share a local edit-token store (`~/.qhs/shares.json`).

### 1. Claude Code — one command, bundles MCP + skill (recommended)

This repo is a Claude Code plugin marketplace. Inside Claude Code:

```
/plugin marketplace add gitlab.com/desper/quick-html-sharing
/plugin install qhs@quick-html-sharing
```

You now have the qhs skill (auto-triggers on "share this HTML" / "give me a link" / "publish this page") **and** the `quick-html-share-mcp` MCP server (5 tools: `qhs_share`, `qhs_edit`, `qhs_delete`, `qhs_stats`, `qhs_list`) wired together.

### 2. Claude Code — skill only, no plugin marketplace

```bash
curl -fsSL https://qhs.fyi/install.sh | bash
```

Drops SKILL.md + helper script into `~/.claude/skills/qhs/`. Use this if you skip the plugin marketplace or want to keep MCP separate.

### 3. Cursor / Claude Desktop / Codex CLI / Continue / any MCP client

Add to your client's MCP config:

```json
{
  "mcpServers": {
    "qhs": { "command": "npx", "args": ["-y", "quick-html-share-mcp"] }
  }
}
```

Common config paths:
- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
- **Cursor**: `~/.cursor/mcp.json` or Settings → MCP
- **Codex CLI / Continue**: same shape, see your client's MCP docs

Restart the client and you get the 5 `qhs_*` tools.

### Local dev / dogfood from this repo

```bash
ln -s "$(pwd)/packages/skill/skills/qhs" ~/.claude/skills/qhs
```

Edits to `packages/skill/skills/qhs/` show up in your next Claude Code session immediately.

## Dev

```bash
bun install
bun run dev:worker    # apps/worker on :8787
bun run dev:web       # apps/web on :4321

# MCP server
cd packages/mcp && bun run build && node dist/index.js

# Skill helper (standalone)
node packages/skill/scripts/qhs.mjs share path/to/file.html
```

## Re-deploy (existing project)

```bash
# Workers
cd apps/worker
bun run deploy:api && bun run deploy:share

# Pages
cd apps/web
PUBLIC_API_BASE=https://api.qhs.fyi/api \
PUBLIC_SHARE_BASE=https://s.qhs.fyi \
  bun run build
../../node_modules/.bin/wrangler pages deploy dist --project-name=qhs --branch=main
```

## Fresh-account deploy (only if rebuilding from scratch)

```bash
wrangler login

cd apps/worker
wrangler d1 create quick-html-sharing            # → paste id into wrangler.toml (both envs)
wrangler r2 bucket create quick-html-sharing
bun run db:apply:remote

# Same salt for both envs — IP-hash dedupe must match across workers.
SALT=$(openssl rand -hex 32)
echo "$SALT" | wrangler secret put IP_HASH_SALT --env api
echo "$SALT" | wrangler secret put IP_HASH_SALT --env share

bun run deploy:api && bun run deploy:share        # capture workers.dev URLs

cd ../web
wrangler pages project create qhs --production-branch=main
PUBLIC_API_BASE=https://qhs-api.<your-subdomain>.workers.dev/api \
PUBLIC_SHARE_BASE=https://qhs-share.<your-subdomain>.workers.dev \
  bun run build
wrangler pages deploy dist --project-name=qhs --branch=main

# Then patch DASHBOARD_HOST in apps/worker/wrangler.toml to your real
# qhs-XXX.pages.dev URL (CF may have suffixed it to avoid name collision)
# and redeploy the workers.
```

## Cost control

Free tier limits we sit comfortably under:

| Service | Free limit | Notes |
|---------|------------|-------|
| Workers | 100K requests/day, 10ms CPU/req | Hard 429 over the limit — never charges silently |
| D1 | 5GB storage, 25M reads/day, 100K writes/day | View tracking is fail-open (see `share-page.ts`) |
| R2 | 10GB storage, **egress free always** | Avg HTML < 100KB ≈ 100K shares fills it |
| Pages | Unlimited bandwidth, 500 builds/month | — |

Set CF dashboard notifications at billing > $1 + Workers/R2/D1 80% usage. CF has no hard spending cap, so this is the only spend alarm.

## Design + plan docs

Outside the repo (per-user gstack workspace):

- Design: `~/.gstack/projects/quick-html-sharing/seanlee-main-design-*.md`
- Test plan: `~/.gstack/projects/quick-html-sharing/seanlee-main-eng-review-test-plan-*.md`
