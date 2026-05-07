#!/usr/bin/env bash
# Bootstraps read-only reference repos at the workspace root.
# These repos are gitignored — used as research material for prompt design.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

clone_or_skip() {
  local dir="$1"
  local url="$2"
  if [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null || true)" ]; then
    echo "[sync-ref] $dir already present — skipping"
    return
  fi
  rm -rf "$dir"
  echo "[sync-ref] cloning $url → $dir"
  git clone --depth 1 "$url" "$dir"
  rm -rf "$dir/.git"
}

clone_or_skip openclaw https://github.com/openclaw/openclaw.git
clone_or_skip hermes-agent https://github.com/nousresearch/hermes-agent.git

echo "[sync-ref] done."
