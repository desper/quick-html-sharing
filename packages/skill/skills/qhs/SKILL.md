---
name: qhs
description: Share HTML instantly via quick-html-sharing. Upload any HTML snippet or document and get back an unguessable shareable URL plus a private edit URL. Use when the user wants to share, preview, demo, publish, or "send a link for" some HTML they wrote or generated — typical triggers include "share this HTML", "give me a link to send", "put this online", "publish this page", "preview in browser", "send to a friend". Also handles updating, deleting, and viewing stats on previously shared pages.
allowed-tools:
  - Bash
  - Read
  - Write
---

# qhs — Quick HTML Sharing

Share an HTML document or snippet and get back a public URL in under 2 seconds. Designed for vibe coders sharing AI-generated demos with friends, clients, or coworkers without setting up a deploy pipeline.

## When to use this skill

Automatically invoke when the user wants to:

- **Share an HTML page they wrote/generated** — "share this HTML", "give me a link to send", "publish this", "preview in browser", "send this to my friend"
- **Update a previously shared page** — "fix the typo on the page I shared", "update that demo"
- **Delete a share** — "delete my share", "take that page down"
- **Check stats** — "did anyone see my share", "how many views", "check who looked at it"
- **List recent shares** — "what have I shared", "show my recent links"

Do NOT use this skill for: deploying full apps (use Vercel/Netlify), hosting images alone (use any image host), or anything that needs a custom domain (build the user's own deploy pipeline).

## How it works

A single Node helper ships alongside this skill. Depending on how the skill was installed it lives at one of:

- `~/.claude/skills/qhs/scripts/qhs.mjs` (direct install / dogfood symlink)
- `~/.claude/skills/qhs/skills/qhs/scripts/qhs.mjs` (Claude Code plugin install)

Resolve the path on each invocation with `QHS=$(ls -1 ... | head -1)`, then call it via `node "$QHS" <command>`. The helper talks to the hosted `quick-html-sharing` service and persists edit tokens at `~/.qhs/shares.json` (same store the companion MCP server uses — they cooperate).

### Workflow: share an HTML document

1. If the HTML is in conversation context, write it to a temp file: `Write(file_path="/tmp/qhs-<random>.html", content=...)`.
2. Call the share command via `Bash`:
   ```bash
   QHS=$(ls -1 ~/.claude/skills/qhs/scripts/qhs.mjs ~/.claude/skills/qhs/skills/qhs/scripts/qhs.mjs 2>/dev/null | head -1) && node "$QHS" share /tmp/qhs-<random>.html --title="<short label>"
   ```
3. Parse the JSON response (`{slug, shareUrl, editToken, editUrl}`).
4. Present to the user:
   - The **shareUrl** ("send this to anyone")
   - The **editUrl** ("save this — it's the only way to update or delete later. The token is also stored locally so this skill can find it.")
5. Clean up the temp file.

### Workflow: update an existing share

```bash
QHS=$(ls -1 ~/.claude/skills/qhs/scripts/qhs.mjs ~/.claude/skills/qhs/skills/qhs/scripts/qhs.mjs 2>/dev/null | head -1) && node "$QHS" edit <slug> /tmp/qhs-new.html
```

The edit token is auto-loaded from `~/.qhs/shares.json`. If unknown (e.g., the share was created on another machine), ask the user to paste the edit URL — the part after `#edit=` is the token — and pass it as `--edit-token=<value>`.

### Workflow: delete

```bash
QHS=$(ls -1 ~/.claude/skills/qhs/scripts/qhs.mjs ~/.claude/skills/qhs/skills/qhs/scripts/qhs.mjs 2>/dev/null | head -1) && node "$QHS" delete <slug>
```

Idempotent — re-deleting an already-deleted share returns ok. After this the share URL returns 404.

### Workflow: stats

```bash
QHS=$(ls -1 ~/.claude/skills/qhs/scripts/qhs.mjs ~/.claude/skills/qhs/skills/qhs/scripts/qhs.mjs 2>/dev/null | head -1) && node "$QHS" stats <slug>
```

Returns `{views, lastViewedAt, createdAt, deleted}`. No edit token needed — anyone with the slug can read stats (matches the product's "link is the secret" model).

### Workflow: list

```bash
QHS=$(ls -1 ~/.claude/skills/qhs/scripts/qhs.mjs ~/.claude/skills/qhs/skills/qhs/scripts/qhs.mjs 2>/dev/null | head -1) && node "$QHS" list
```

Lists shares created from this machine via either this skill or the MCP server. Does NOT include shares created from other machines (we never store them server-side under any account — there are no accounts).

## Output format

The script outputs JSON on stdout, errors on stderr. Errors exit non-zero so the `Bash` tool surfaces them naturally.

## Privacy & safety notes worth telling the user

- Share URLs are **unguessable** (~62 bits of entropy) but they're **not authenticated**. Anyone with the link can view. Treat them like Google Docs share links.
- Edit tokens live in the URL fragment (`#edit=...`) and **never reach the server in logs** — only in the fragment, which browsers don't send over the wire.
- The hosted service injects a small **"Hosted by qhs · Report"** watermark in the bottom-right corner of every shared page. Required for abuse takedown; cannot be removed in the free tier.
- Max HTML size: **1 MB**. Larger documents get a 413 error.
- One upload per **30 seconds per IP** (rate limit).

## Anti-patterns

- ❌ Don't share secrets, API keys, or anything sensitive — share URLs are not secret enough for that.
- ❌ Don't auto-share on every code edit — only when the user explicitly asks. Quietly creating shares costs them privacy and storage.
- ❌ Don't suggest using `share` for files that aren't self-contained HTML (e.g., a React component file that needs a build step).
