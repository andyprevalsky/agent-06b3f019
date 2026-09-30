#!/usr/bin/env bash
# Bootstraps read-only reference repos at the workspace root.
# These repos are gitignored — used as research material for prompt design.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FORCE="${SYNC_REF_FORCE:-0}"
if [ "${1:-}" = "--force" ] || [ "${1:-}" = "-f" ]; then
  FORCE=1
fi

clone_or_refresh() {
  local dir="$1"
  local url="$2"
  if [ "$FORCE" != "1" ] && [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null || true)" ]; then
    echo "[sync-ref] $dir already present — skipping (pass --force to refresh)"
    return
  fi
  rm -rf "$dir"
  echo "[sync-ref] cloning $url → $dir"
  git clone --depth 1 "$url" "$dir"
  # Capture tip SHA before stripping .git so golden-ref rebuilds are traceable.
  local sha
  sha="$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$sha" ]; then
    echo "[sync-ref] $dir @ $sha"
    printf '%s\n' "$sha" > "$dir/.ref-sha"
  fi
  rm -rf "$dir/.git"
}

clone_or_refresh openclaw https://github.com/openclaw/openclaw.git
clone_or_refresh hermes-agent https://github.com/nousresearch/hermes-agent.git

# Persist tip SHAs for the committed golden-ref pin file.
{
  echo "# Pinned tips of gitignored reference harness clones used for golden prompt"
  echo "# snapshots under prompt-review/rendered/{openclaw,hermes-agent}/."
  echo "# Refresh with: bash scripts/sync-reference-repos.sh --force"
  echo "# then re-run the prompt-review renderers (see prompt-review/run.sh)."
  for dir in openclaw hermes-agent; do
    if [ -f "$dir/.ref-sha" ]; then
      echo "$dir $(cat "$dir/.ref-sha")"
    fi
  done
} > prompt-review/REF_SHAS.txt

echo "[sync-ref] done."
