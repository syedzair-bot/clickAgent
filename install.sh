#!/bin/bash
# Installs the ClickUp post-push hook into all DegrePartner repos.
# Run once per machine, or after cloning a new repo.
# Usage: bash ~/DegrePartner/clickup-agent/install.sh

HOOK_SRC="$HOME/DegrePartner/clickup-agent/post-push"
REPOS=(
  "$HOME/DegrePartner/DT"
  "$HOME/DegrePartner/DTL"
  "$HOME/DegrePartner/AdminCMS"
)

chmod +x "$HOOK_SRC"

for REPO in "${REPOS[@]}"; do
  if [ ! -d "$REPO/.git" ]; then
    echo "⚠️  Skipping $REPO — not a git repo"
    continue
  fi

  HOOK_DEST="$REPO/.git/hooks/post-push"

  if [ -f "$HOOK_DEST" ] && [ ! -L "$HOOK_DEST" ]; then
    echo "⚠️  $REPO already has a post-push hook — backing up to post-push.bak"
    mv "$HOOK_DEST" "$HOOK_DEST.bak"
  fi

  ln -sf "$HOOK_SRC" "$HOOK_DEST"
  chmod +x "$HOOK_DEST"
  echo "✓  Installed → $REPO/.git/hooks/post-push"
done

echo ""
echo "✅ Done. ClickUp sync will run automatically on every git push."
echo "   Logs print to terminal. Errors never block the push."
