#!/usr/bin/env bash
# quick-html-sharing skill installer.
#
# Installs the qhs Claude Code skill into ~/.claude/skills/qhs/. Skip this
# script and use `/plugin marketplace add` if you want the official Claude
# Code plugin install path with the MCP server bundled.
#
# Usage:
#   curl -fsSL https://qhs.fyi/install.sh | bash
#
# Footprint:
#   ~/.claude/skills/qhs/SKILL.md
#   ~/.claude/skills/qhs/scripts/qhs.mjs
#
# Edit tokens for shares you create end up at ~/.qhs/shares.json (created
# lazily on first share).

set -euo pipefail

BASE="https://gitlab.com/desper/quick-html-sharing/-/raw/main/packages/skill/skills/qhs"
DEST="${HOME}/.claude/skills/qhs"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# ---- Node check -------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  red "Error: Node.js is required (>= 18). Install from https://nodejs.org/ and re-run."
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  red "Error: Node $NODE_MAJOR detected. qhs needs Node 18+ for built-in fetch."
  exit 1
fi

# ---- Don't clobber existing install without consent -------------------------
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
  yellow "Found existing $DEST (not a symlink)."
  yellow "Re-running this script will overwrite SKILL.md and scripts/qhs.mjs."
  if [ -t 0 ]; then
    printf 'Continue? [y/N] '
    read -r answer
    case "$answer" in
      y|Y|yes) ;;
      *) echo "Aborted."; exit 1 ;;
    esac
  else
    yellow "Non-interactive shell — continuing. Set QHS_FORCE=0 to skip."
  fi
fi

# ---- Fetch ------------------------------------------------------------------
bold "Installing qhs skill into $DEST ..."
mkdir -p "$DEST/scripts"

curl -fsSL "$BASE/SKILL.md" -o "$DEST/SKILL.md"
curl -fsSL "$BASE/scripts/qhs.mjs" -o "$DEST/scripts/qhs.mjs"
chmod +x "$DEST/scripts/qhs.mjs"

# ---- Sanity check the helper boots -----------------------------------------
if ! node "$DEST/scripts/qhs.mjs" 2>&1 | grep -q 'Usage:'; then
  red "Helper at $DEST/scripts/qhs.mjs did not respond as expected."
  exit 1
fi

green "✓ Installed."
echo
bold "Next steps"
echo "  - New Claude Code session: try 'share this HTML' and the skill should auto-trigger."
echo "  - Manual test: node $DEST/scripts/qhs.mjs share path/to/file.html"
echo
bold "MCP server (optional, for Cursor / Claude Desktop / Codex CLI / Continue)"
echo "  Add to your client's MCP config:"
echo
echo '    {'
echo '      "mcpServers": {'
echo '        "qhs": { "command": "npx", "args": ["-y", "quick-html-share-mcp"] }'
echo '      }'
echo '    }'
echo
echo "Docs: https://qhs.fyi  ·  Source: https://gitlab.com/desper/quick-html-sharing"
