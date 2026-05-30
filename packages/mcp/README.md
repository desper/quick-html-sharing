# quick-html-share-mcp

MCP server for **[quick-html-sharing](https://qhs.fyi)** — paste HTML, get an unguessable shareable URL plus viewer analytics, all from inside your coding agent.

For vibe coders sharing AI-generated HTML demos with friends, clients, or coworkers without setting up a deploy pipeline.

## Install

Add to your MCP client config — no install step beyond that, `npx` fetches on demand.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) — or the equivalent path on your OS:

```json
{
  "mcpServers": {
    "qhs": { "command": "npx", "args": ["-y", "quick-html-share-mcp"] }
  }
}
```

Restart Claude Desktop.

### Cursor

Settings → MCP → Add Server, or edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "qhs": { "command": "npx", "args": ["-y", "quick-html-share-mcp"] }
  }
}
```

### Codex CLI / Continue / any other MCP client

Same pattern — point the client at `npx -y quick-html-share-mcp` as a stdio MCP server.

### Claude Code

Claude Code supports MCP too, but the companion **[`qhs` skill](https://github.com/desperli/quick-html-sharing/tree/main/packages/skill)** is a lighter-touch alternative (skill = markdown file + tiny helper, no Node process per session).

## What you get

Five tools that show up in your agent's tool list:

| Tool | What it does |
|------|--------------|
| `qhs_share` | Upload an HTML document or snippet, get back a public shareable URL + private edit URL |
| `qhs_edit` | Update HTML at an existing share (slug stays the same) |
| `qhs_delete` | Permanently take down a share (URL returns 404 after) |
| `qhs_stats` | Get view count, last viewed time, created time |
| `qhs_list` | List shares created from this machine |

## How it works

```
your agent           quick-html-share-mcp                hosted qhs worker
                  (this npm package, stdio)            (Cloudflare, free tier)
   │                          │                                  │
   ├─ qhs_share(html) ───────▶│                                  │
   │                          ├─ POST /api/upload ──────────────▶│
   │                          │◀─ {slug, shareUrl, editToken} ───┤
   │                          │                                  │
   │                          ├─ write ~/.qhs/shares.json        │
   │                          │     (local edit-token store)     │
   │                          │                                  │
   │◀─ {shareUrl, editUrl} ───┤                                  │
```

Edit tokens are persisted to `~/.qhs/shares.json` so `qhs_edit` / `qhs_delete` can find them on subsequent calls without you having to remember anything. The companion Claude Code skill writes to the same file.

## Privacy & limits

- **Share URLs are unguessable but not authenticated.** ~62 bits of entropy. Treat them like Google Docs share links — anyone with the link can view.
- **Edit tokens live in the URL fragment** (`#edit=…`), so they never reach the server's HTTP logs.
- **Max 1 MB per upload, 1 share per 30s per IP** (rate limited).
- **No accounts, no email.** Your shares are tied to your local edit-token file — back it up if you care about being able to edit/delete later.
- A small `Hosted by qhs · Report` watermark is injected into every share for abuse handling.

## License

MIT
