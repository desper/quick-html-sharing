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

Nine tools that show up in your agent's tool list:

| Tool | What it does |
|------|--------------|
| `qhs_share` | Upload an HTML document or snippet, get back a public shareable URL + private edit URL |
| `qhs_edit` | Update HTML at an existing share (slug stays the same) — keeps the old version |
| `qhs_delete` | Permanently take down a share (URL returns 404 after) |
| `qhs_stats` | Views, unique viewers, traffic sources, 7-day activity, crawler fetches |
| `qhs_list` | List your shares — this machine, plus every machine once a sync code is saved |
| `qhs_versions` | List the stored versions of a share, newest first |
| `qhs_preview_version` | Read an old version's source before restoring it |
| `qhs_restore` | Republish an older version (appended as a new version, so it's undoable) |
| `qhs_set_sync_code` | Save your sync code so version history works for shares made on your other machines |

**Editing never overwrites.** Each `qhs_edit` appends a new version and keeps the
previous one, so an agent that regenerates a page from a bad prompt is recoverable:
`qhs_versions` → `qhs_preview_version` → `qhs_restore`. Restoring appends too, so
the restore itself can be undone.

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

**Across machines.** Save your sync code once per machine with `qhs_set_sync_code` and the rest follow: `qhs_list` includes shares made elsewhere, and `qhs_versions` / `qhs_preview_version` / `qhs_restore` / `qhs_delete` work on them. Editing does not — that still needs the share's own edit token on this device, because a restore republishes bytes the server already holds while an edit supplies new ones. Deleting a share this machine did not create requires `confirm: true`, since a slug alone is otherwise enough to take a page down for good.

## Privacy & limits

- **Share URLs are unguessable but not authenticated.** ~62 bits of entropy. Treat them like Google Docs share links — anyone with the link can view.
- **Edit tokens live in the URL fragment** (`#edit=…`), so they never reach the server's HTTP logs.
- **Max 1 MB per upload, 1 share per 30s per IP** (rate limited).
- **No accounts, no email.** Your shares are tied to your local edit-token file — back it up if you care about being able to edit/delete later.
- A small `Hosted by qhs · Report` watermark is injected into every share for abuse handling.

## License

MIT
