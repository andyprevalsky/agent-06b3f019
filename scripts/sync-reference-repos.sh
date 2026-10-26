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

# prompt-review/REF_SHAS.txt is a tip RECORD of the last successful sync (the
# SHAs that produced the committed goldens under prompt-review/rendered/).
# It is not a checkout pin — `git clone --depth 1` always takes current tip;
# after rendering, re-commit REF_SHAS.txt + rendered/ together so they match.
clone_or_refresh() {
  local dir="$1"
  local url="$2"
  if [ "$FORCE" != "1" ] && [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null || true)" ]; then
    echo "[sync-ref] $dir already present — skipping (pass --force to refresh)"
    # Legacy clones may predate .ref-sha; recover the recorded tip when possible.
    if [ ! -f "$dir/.ref-sha" ] && [ -f prompt-review/REF_SHAS.txt ]; then
      local recorded
      recorded="$(awk -v d="$dir" '$1 == d { print $2; exit }' prompt-review/REF_SHAS.txt || true)"
      if [ -n "$recorded" ]; then
        printf '%s\n' "$recorded" > "$dir/.ref-sha"
        echo "[sync-ref] $dir recovered .ref-sha from REF_SHAS.txt ($recorded)"
      fi
    fi
    return
  fi
  rm -rf "$dir"
  echo "[sync-ref] cloning $url → $dir"
  git clone --depth 1 "$url" "$dir"
  # Capture tip SHA before stripping .git so golden-ref rebuilds are traceable.
  local sha
  sha="$(git -C "$dir" rev-parse HEAD)"
  echo "[sync-ref] $dir @ $sha"
  printf '%s\n' "$sha" > "$dir/.ref-sha"
  rm -rf "$dir/.git"
}

clone_or_refresh openclaw https://github.com/openclaw/openclaw.git
clone_or_refresh hermes-agent https://github.com/nousresearch/hermes-agent.git
clone_or_refresh codex https://github.com/openai/codex.git
clone_or_refresh prime-agent https://github.com/PrimeIntellect-ai/prime-agent.git
clone_or_refresh kimi-code https://github.com/MoonshotAI/kimi-code.git

# Refuse to rewrite the tip-record file unless every clone has .ref-sha.
for dir in openclaw hermes-agent codex prime-agent kimi-code; do
  if [ ! -f "$dir/.ref-sha" ]; then
    echo "Missing $dir/.ref-sha; refusing to rewrite prompt-review/REF_SHAS.txt" >&2
    echo "Pass --force to re-clone, or restore .ref-sha from the previous tip record." >&2
    exit 1
  fi
done

{
  echo "# Tip record of gitignored reference harness clones used for golden prompt"
  echo "# snapshots under prompt-review/rendered/{openclaw,hermes-agent,codex,prime-agent,kimi-code}/."
  echo "# This is NOT a checkout pin — --force re-clones current tip and updates"
  echo "# this file; re-run prompt-review renderers and commit rendered/ together."
  echo "# Refresh with: bash scripts/sync-reference-repos.sh --force"
  for dir in openclaw hermes-agent codex prime-agent kimi-code; do
    echo "$dir $(cat "$dir/.ref-sha")"
  done
} > prompt-review/REF_SHAS.txt

echo "[sync-ref] done."
