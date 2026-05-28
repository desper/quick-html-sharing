# qhs — Claude Code Skill

Share HTML instantly from your Claude Code conversation. Companion to the [`quick-html-share-mcp`](../mcp) MCP server.

## Install

Symlink the package into your user-scope skills directory:

```bash
ln -s /absolute/path/to/quick-html-sharing/packages/skill ~/.claude/skills/qhs
```

(Or copy if you prefer not to symlink.)

That's it. The skill auto-triggers on phrases like "share this HTML", "give me a link to send", "publish this page".

## Requirements

- Node ≥ 18 (for built-in `fetch`)
- Claude Code

## What gets stored where

- **Server side** (qhs hosted): your HTML, plus a SHA-256 hash of the edit token. Never your IP in plaintext (salted hash only).
- **Local** (`~/.qhs/shares.json`): edit tokens + slugs + URLs for shares you created from this machine. Lets the skill auto-fill the token for `edit` / `delete`. Shared with the MCP server if you have that installed too.

## See also

- [`quick-html-share-mcp`](../mcp) — same functionality as an MCP server, for Cursor / Claude Desktop / Codex CLI users.
