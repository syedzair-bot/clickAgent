#!/bin/bash
# ClickUp Git Sync — Global Installer
# Run once per machine after cloning this repo.
# Usage: bash ~/DegrePartner/clickup-agent/install.sh

AGENT_DIR="$HOME/DegrePartner/clickup-agent"
HOOK_SRC="$AGENT_DIR/post-push"
CC_SETTINGS="$HOME/.claude/settings.json"

REPOS=(
  "$HOME/DegrePartner/DT"
  "$HOME/DegrePartner/DTL"
  "$HOME/DegrePartner/AdminCMS"
)

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║     ClickUp Git Sync — Global Installer      ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

chmod +x "$HOOK_SRC" "$AGENT_DIR/cc-hook.mjs"

# ── 1. Install git post-push hooks into each repo ────────────────────────────
echo "── Step 1: Git post-push hooks ─────────────────"
for REPO in "${REPOS[@]}"; do
  if [ ! -d "$REPO/.git" ]; then
    echo "  ⚠️  Skipping $REPO — not a git repo"
    continue
  fi
  HOOK_DEST="$REPO/.git/hooks/post-push"
  [ -f "$HOOK_DEST" ] && [ ! -L "$HOOK_DEST" ] && mv "$HOOK_DEST" "$HOOK_DEST.bak"
  ln -sf "$HOOK_SRC" "$HOOK_DEST"
  chmod +x "$HOOK_DEST"
  echo "  ✓  $REPO"
done

# ── 2. Wire Claude Code PostToolUse hook into ~/.claude/settings.json ────────
echo ""
echo "── Step 2: Claude Code global hook ─────────────"

if [ ! -f "$CC_SETTINGS" ]; then
  echo "  ⚠️  $CC_SETTINGS not found — creating minimal settings"
  mkdir -p "$HOME/.claude"
  echo '{"hooks":{}}' > "$CC_SETTINGS"
fi

# Check if hook already registered
if grep -q "clickup-agent/cc-hook" "$CC_SETTINGS" 2>/dev/null; then
  echo "  ✓  Claude Code hook already installed"
else
  # Use node to safely merge the hook into existing JSON
  node - "$CC_SETTINGS" <<'JSEOF'
const fs = require("fs");
const file = process.argv[2];
const s = JSON.parse(fs.readFileSync(file, "utf8"));

s.hooks = s.hooks || {};
s.hooks.PostToolUse = s.hooks.PostToolUse || [];

const alreadySet = s.hooks.PostToolUse.some(h =>
  h.hooks?.some(x => x.command?.includes("cc-hook"))
);

if (!alreadySet) {
  s.hooks.PostToolUse.push({
    matcher: "Bash",
    hooks: [{
      type: "command",
      command: "node $HOME/DegrePartner/clickup-agent/cc-hook.mjs",
      timeout: 5
    }]
  });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  console.log("  ✓  Claude Code PostToolUse hook added");
} else {
  console.log("  ✓  Claude Code hook already installed");
}
JSEOF
fi

echo ""
echo "✅ Done! ClickUp sync is now active globally."
echo ""
echo "   • Every git push (terminal)     → triggers via post-push hook"
echo "   • Every git push (Claude Code)  → triggers via PostToolUse hook"
echo "   • Prompts from Claude sessions  → auto-included in ClickUp comments"
echo ""
echo "   To update config: edit $AGENT_DIR/config.json"
echo ""
