#!/usr/bin/env bash
# Sync ~/ai-pilot into Giant-Panda-AI-Tools monorepo and push both remotes.
set -e

AIPILOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GP_DIR="$HOME/Project/Giant-Panda-AI-Tools-main"
GP_TARGET="$GP_DIR/mcp/ai-pilot"

echo "→ syncing to $GP_TARGET"
rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  "$AIPILOT_DIR/" "$GP_TARGET/"

echo "→ committing in Giant-Panda-AI-Tools"
cd "$GP_DIR"
git add mcp/ai-pilot
if git diff --cached --quiet; then
  echo "  nothing to commit in GP repo"
else
  LATEST_MSG=$(git -C "$AIPILOT_DIR" log -1 --pretty="%s")
  git commit -m "sync: ai-pilot — $LATEST_MSG"
  git push
  echo "  pushed to Giant-Panda-AI-Tools"
fi

echo "✓ done"
