# qhs Claude Code plugin

Share AI-generated HTML instantly from inside Claude Code. Bundles:
- A skill that auto-triggers on share/preview/publish phrases (`skills/qhs/SKILL.md`)
- The `quick-html-share-mcp` MCP server wired through `.mcp.json`

The hosted service lives at https://qhs.fyi — paste HTML, get an unguessable URL plus view analytics. No account, no folder, no deploy pipeline.

## Install (recommended)

Inside Claude Code:

```
/plugin marketplace add gitlab.com/desper/quick-html-sharing
/plugin install qhs@quick-html-sharing
```

This wires up both the skill and the MCP server in a single step.

## Install (skill only, no plugin marketplace)

```bash
curl -fsSL https://qhs.fyi/install.sh | bash
```

## Dogfood from this repo

```bash
ln -s "$(pwd)/skills/qhs" ~/.claude/skills/qhs
```

Edits to `skills/qhs/SKILL.md` and `skills/qhs/scripts/qhs.mjs` show up in the next Claude Code session.

## What you get

| Tool / phrase | What happens |
|---|---|
| "share this HTML" | `qhs_share` uploads HTML, returns share URL + edit URL |
| "update the page I shared" | `qhs_edit` replaces HTML at the same slug |
| "delete my share" | `qhs_delete` takes the page down |
| "did anyone see my share" | `qhs_stats` returns view count + last viewed |
| "list my shares" | `qhs_list` reads `~/.qhs/shares.json` |

The Node helper at `skills/qhs/scripts/qhs.mjs` does the same job standalone (Bash-friendly) and shares the same `~/.qhs/shares.json` edit-token store with the MCP server.

## Privacy

- Share URLs are unguessable (~62 bits of entropy) but **not authenticated**. Anyone with the link can view.
- Edit tokens live in the URL fragment (`#edit=…`) and never reach the server's HTTP logs.
- Edit tokens are persisted locally at `~/.qhs/shares.json`. Back this file up if you care about being able to edit/delete shares from other machines.
- Max 1 MB per upload, 1 share per 30s per IP.
