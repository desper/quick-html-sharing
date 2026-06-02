#!/usr/bin/env bash
# Promo check — pulls the metrics that tell us whether agent-side discovery
# is yielding real users yet. Read-only.
#
# Usage: bash scripts/promo-check.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRANGLER="$ROOT/node_modules/.bin/wrangler"

bold() { printf '\n\033[1m=== %s ===\033[0m\n' "$*"; }

bold "npm downloads (last 30 days)"
curl -fsS https://api.npmjs.org/downloads/range/last-month/quick-html-share-mcp \
  | jq -r '
      "  total: \([.downloads[].downloads] | add)",
      "  non-zero days:",
      ( .downloads | map(select(.downloads > 0)) | .[]
        | "    \(.day)  \(.downloads)" )
    '

bold "awesome-mcp-servers PR #7251"
if gh auth status >/dev/null 2>&1; then
  gh pr view 7251 --repo punkpeye/awesome-mcp-servers \
    --json state,mergedAt,createdAt,reviewDecision 2>/dev/null \
    | jq -r '"  state=\(.state)  decision=\(.reviewDecision // "none")  merged=\(.mergedAt // "no")  created=\(.createdAt)"'
else
  echo "  (gh CLI not authed — skipping)"
fi

bold "MCP Registry listing"
curl -fsS "https://registry.modelcontextprotocol.io/v0/servers?search=quick-html-share" \
  | jq -r '
      if (.servers | length) == 0 then
        "  not found"
      else
        .servers[0] as $s
        | $s._meta."io.modelcontextprotocol.registry/official" as $m
        | "  name=\($s.server.name)  version=\($s.server.version)  status=\($m.status)  published=\($m.publishedAt)"
      end
    '

bold "D1: share totals + client breakdown"
"$WRANGLER" --cwd "$ROOT/apps/worker" d1 execute quick-html-sharing \
  --remote --env api --json \
  --command "SELECT client, COUNT(*) AS n, COUNT(DISTINCT sender_ip_hash) AS unique_ips
             FROM shares WHERE status = 'committed'
             GROUP BY client ORDER BY n DESC" 2>/dev/null \
  | jq -r '.[0].results[] | "  \(.client | tostring)  shares=\(.n)  unique_ips=\(.unique_ips)"' \
  || echo "  (query failed — check wrangler auth)"

bold "D1: view totals (real eyeballs on shared content)"
"$WRANGLER" --cwd "$ROOT/apps/worker" d1 execute quick-html-sharing \
  --remote --env api --json \
  --command "SELECT COUNT(*) AS total_views,
                    COUNT(DISTINCT slug) AS shares_with_views,
                    COUNT(DISTINCT ip_hash) AS unique_viewer_ips
             FROM views" 2>/dev/null \
  | jq -r '.[0].results[0] | "  total_views=\(.total_views)  shares_with_views=\(.shares_with_views)  unique_viewer_ips=\(.unique_viewer_ips)"' \
  || echo "  (query failed)"

echo
echo "(read-only — no rows written.)"
