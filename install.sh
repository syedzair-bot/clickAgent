#!/bin/bash
# ClickUp Git Sync — Global Installer
# Run once per machine after cloning this repo anywhere.
# Usage: bash /path/to/clickup-agent/install.sh

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL_HOOKS_DIR="$AGENT_DIR/global-hooks"
CC_HOOK="$AGENT_DIR/cc-hook.mjs"
CC_SETTINGS="$HOME/.claude/settings.json"
CONFIG_FILE="$AGENT_DIR/config.json"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║     ClickUp Git Sync — Global Installer      ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  Agent: $AGENT_DIR"
echo ""

chmod +x "$GLOBAL_HOOKS_DIR/pre-push" "$CC_HOOK"

# ── 1. Ask which repos this developer works on ────────────────────────────────
echo "── Step 1: Configure your repos ────────────────"
echo ""
echo "  Which DegrePartner apps do you work on?"
echo "  (You can select multiple — one per line, empty line to finish)"
echo ""
echo "  Common apps: DT · DTL · AdminCMS · UniAdv · Other"
echo ""

REPO_PATHS=()

while true; do
  echo -n "  App name (or press Enter to finish): "
  read -r APP_NAME < /dev/tty
  [ -z "$APP_NAME" ] && break

  # Try to auto-detect path
  SUGGESTED=""
  LOWER_NAME=$(echo "$APP_NAME" | tr '[:upper:]' '[:lower:]')
  for candidate in \
    "$HOME/DegrePartner/$APP_NAME" \
    "$HOME/Projects/$APP_NAME" \
    "$HOME/code/$APP_NAME" \
    "$HOME/$APP_NAME"; do
    if [ -d "$candidate/.git" ]; then
      SUGGESTED="$candidate"
      break
    fi
  done

  if [ -n "$SUGGESTED" ]; then
    echo -n "  Path [$SUGGESTED]: "
  else
    echo -n "  Full path to $APP_NAME repo: "
  fi
  read -r USER_PATH < /dev/tty

  # Use suggested if user pressed enter
  FINAL_PATH="${USER_PATH:-$SUGGESTED}"

  if [ -z "$FINAL_PATH" ]; then
    echo "  ⚠️  No path provided — skipping $APP_NAME"
    continue
  fi

  # Resolve to absolute path
  FINAL_PATH="$(cd "$FINAL_PATH" 2>/dev/null && pwd || echo "$FINAL_PATH")"

  if [ ! -d "$FINAL_PATH/.git" ]; then
    echo "  ⚠️  No .git found at $FINAL_PATH — adding anyway (verify the path)"
  else
    echo "  ✓  $APP_NAME → $FINAL_PATH"
  fi

  REPO_PATHS+=("$FINAL_PATH")
done

echo ""

# ── 2. Save repo paths into config.json ──────────────────────────────────────
echo "── Step 2: Saving config ────────────────────────"

node - "$CONFIG_FILE" "${REPO_PATHS[@]}" <<'JSEOF'
const fs = require("fs");
const file = process.argv[2];
const paths = process.argv.slice(3);

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}

cfg.TRACKED_REPOS = paths;
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log("  ✓  Tracked repos saved to config.json:");
paths.forEach(p => console.log("       " + p));
JSEOF

echo ""

# ── 3. Set global git hooks path ──────────────────────────────────────────────
echo "── Step 3: Global git hook ──────────────────────"

EXISTING=$(git config --global core.hooksPath 2>/dev/null)
if [ -n "$EXISTING" ] && [ "$EXISTING" != "$GLOBAL_HOOKS_DIR" ]; then
  echo "  ⚠️  core.hooksPath already set to: $EXISTING"
  echo -n "  Overwrite with ClickUp hook? [y/N]: "
  read -r CONFIRM < /dev/tty
  [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ] && echo "  Skipped." || {
    git config --global core.hooksPath "$GLOBAL_HOOKS_DIR"
    echo "  ✓  Global hooks path set → $GLOBAL_HOOKS_DIR"
  }
else
  git config --global core.hooksPath "$GLOBAL_HOOKS_DIR"
  echo "  ✓  Global hooks path set → $GLOBAL_HOOKS_DIR"
fi

echo ""
echo "  Hook fires on push from any of your configured repos."

# ── 4. Wire Claude Code PostToolUse hook ─────────────────────────────────────
echo ""
echo "── Step 4: Claude Code global hook ─────────────"

if [ ! -f "$CC_SETTINGS" ]; then
  mkdir -p "$HOME/.claude"
  echo '{"hooks":{}}' > "$CC_SETTINGS"
fi

if grep -q "cc-hook" "$CC_SETTINGS" 2>/dev/null; then
  node - "$CC_SETTINGS" "$CC_HOOK" <<'JSEOF'
const fs = require("fs");
const file = process.argv[2];
const hookPath = process.argv[3];
const s = JSON.parse(fs.readFileSync(file, "utf8"));
s.hooks = s.hooks || {};
s.hooks.PostToolUse = (s.hooks.PostToolUse || []).map(h => {
  if (h.hooks?.some(x => x.command?.includes("cc-hook"))) {
    h.hooks = h.hooks.map(x =>
      x.command?.includes("cc-hook") ? { ...x, command: `node ${hookPath}` } : x
    );
  }
  return h;
});
fs.writeFileSync(file, JSON.stringify(s, null, 2));
console.log("  ✓  Claude Code hook updated →", hookPath);
JSEOF
else
  node - "$CC_SETTINGS" "$CC_HOOK" <<'JSEOF'
const fs = require("fs");
const file = process.argv[2];
const hookPath = process.argv[3];
const s = JSON.parse(fs.readFileSync(file, "utf8"));
s.hooks = s.hooks || {};
s.hooks.PostToolUse = s.hooks.PostToolUse || [];
s.hooks.PostToolUse.push({
  matcher: "Bash",
  hooks: [{ type: "command", command: `node ${hookPath}`, timeout: 5 }]
});
fs.writeFileSync(file, JSON.stringify(s, null, 2));
console.log("  ✓  Claude Code PostToolUse hook added →", hookPath);
JSEOF
fi

echo ""
echo "✅ Done."
echo ""
echo "   Git pushes from your configured repos will trigger ClickUp sync."
echo "   To add/change repos: re-run install.sh"
echo "   To update API key: edit $AGENT_DIR/config.json"
echo ""
