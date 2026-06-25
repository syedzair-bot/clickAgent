#!/bin/bash
# ClickUp Git Sync — Global Installer
# Run once per machine after cloning this repo anywhere.
# Usage: bash /path/to/clickup-agent/install.sh

# Agent dir = wherever this script lives
AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SRC="$AGENT_DIR/post-push"
CC_HOOK="$AGENT_DIR/cc-hook.mjs"
CC_SETTINGS="$HOME/.claude/settings.json"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║     ClickUp Git Sync — Global Installer      ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  Agent location: $AGENT_DIR"
echo ""

chmod +x "$HOOK_SRC" "$CC_HOOK"

# ── 1. Auto-detect repos by name (DT / DTL / AdminCMS) ───────────────────────
echo "── Step 1: Finding repos ────────────────────────"

REPO_NAMES=("DT" "DTL" "AdminCMS")
FOUND_REPOS=()

for NAME in "${REPO_NAMES[@]}"; do
  # Search common locations first, then broader search
  LOCATIONS=(
    "$HOME/$NAME"
    "$HOME/Projects/$NAME"
    "$HOME/Work/$NAME"
    "$HOME/code/$NAME"
    "$HOME/dev/$NAME"
    "$HOME/DegrePartner/$NAME"
  )

  FOUND=""
  for LOC in "${LOCATIONS[@]}"; do
    if [ -d "$LOC/.git" ]; then
      FOUND="$LOC"
      break
    fi
  done

  # Fallback: search home directory (max depth 4)
  if [ -z "$FOUND" ]; then
    FOUND=$(find "$HOME" -maxdepth 4 -type d -name "$NAME" 2>/dev/null | while read d; do
      [ -d "$d/.git" ] && echo "$d" && break
    done | head -1)
  fi

  if [ -n "$FOUND" ]; then
    echo "  ✓  Found $NAME → $FOUND"
    FOUND_REPOS+=("$FOUND")
  else
    echo "  ⚠️  $NAME not found — enter path manually (or press Enter to skip):"
    read -r MANUAL_PATH
    if [ -n "$MANUAL_PATH" ] && [ -d "$MANUAL_PATH/.git" ]; then
      echo "  ✓  Using $MANUAL_PATH"
      FOUND_REPOS+=("$MANUAL_PATH")
    else
      echo "  –  Skipping $NAME"
    fi
  fi
done

# ── 2. Install git post-push hook into each found repo ───────────────────────
echo ""
echo "── Step 2: Git post-push hooks ─────────────────"

for REPO in "${FOUND_REPOS[@]}"; do
  HOOK_DEST="$REPO/.git/hooks/post-push"
  [ -f "$HOOK_DEST" ] && [ ! -L "$HOOK_DEST" ] && mv "$HOOK_DEST" "$HOOK_DEST.bak"
  ln -sf "$HOOK_SRC" "$HOOK_DEST"
  chmod +x "$HOOK_DEST"
  echo "  ✓  $REPO"
done

# ── 3. Patch post-push to use dynamic agent path ─────────────────────────────
# Write the agent path into a local config so the hook finds it regardless of location
cat > "$AGENT_DIR/.agent-path" << EOF
$AGENT_DIR
EOF

# ── 4. Wire Claude Code PostToolUse hook ─────────────────────────────────────
echo ""
echo "── Step 3: Claude Code global hook ─────────────"

if [ ! -f "$CC_SETTINGS" ]; then
  mkdir -p "$HOME/.claude"
  echo '{"hooks":{}}' > "$CC_SETTINGS"
fi

if grep -q "cc-hook" "$CC_SETTINGS" 2>/dev/null; then
  echo "  ✓  Claude Code hook already installed"
else
  node - "$CC_SETTINGS" "$CC_HOOK" <<'JSEOF'
const fs = require("fs");
const file = process.argv[2];
const hookPath = process.argv[3];
const s = JSON.parse(fs.readFileSync(file, "utf8"));
s.hooks = s.hooks || {};
s.hooks.PostToolUse = s.hooks.PostToolUse || [];
const exists = s.hooks.PostToolUse.some(h => h.hooks?.some(x => x.command?.includes("cc-hook")));
if (!exists) {
  s.hooks.PostToolUse.push({
    matcher: "Bash",
    hooks: [{ type: "command", command: `node ${hookPath}`, timeout: 5 }]
  });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
}
console.log("  ✓  PostToolUse hook added →", hookPath);
JSEOF
fi

echo ""
echo "✅ Done! ClickUp sync active on ${#FOUND_REPOS[@]} repo(s)."
echo ""
echo "   • git push (terminal)     → post-push hook"
echo "   • git push (Claude Code)  → PostToolUse hook"
echo ""
echo "   To update API key: edit $AGENT_DIR/config.json"
echo ""
