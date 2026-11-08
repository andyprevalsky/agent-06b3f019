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
repair_metadata() (
  local dir="$1" url="$2" sha tmp
  # Old syncs stripped .git. Recreate only metadata at the saved revision:
  # checking out files here would overwrite local edits and change goldens.
  sha="$(cat "$dir/.ref-sha")"
  if [[ ! "$sha" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
    echo "[sync-ref] invalid saved revision for $dir: $sha" >&2
    exit 1
  fi
  tmp="$(mktemp -d "$dir/.rose-reference.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  git init -q "$tmp"
  git -C "$tmp" remote add origin "$url"
  git -C "$tmp" fetch -q --depth 1 origin "$sha"
  git -C "$tmp" update-ref --no-deref HEAD "$sha"
  # Match HEAD in remote tracking so checkpoint's incremental bundle remains
  # empty: the remote already holds these objects, even if its tip has moved.
  git -C "$tmp" update-ref refs/remotes/origin/reference "$sha"
  git -C "$tmp" read-tree "$sha"
  printf '/.ref-sha\n' >> "$tmp/.git/info/exclude"
  mv "$tmp/.git" "$dir/.git"
  echo "[sync-ref] $dir restored git metadata @ $sha (source files unchanged)"
)

clone_or_refresh() {
  local dir="$1"
  local url="$2"
  if [ "$FORCE" != "1" ] && [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null || true)" ]; then
    echo "[sync-ref] $dir already present (pass --force to refresh)"
    # Legacy clones may predate .ref-sha; recover the recorded tip when possible.
    if [ ! -f "$dir/.ref-sha" ] && [ -f prompt-review/REF_SHAS.txt ]; then
      local recorded
      recorded="$(awk -v d="$dir" '$1 == d { print $2; exit }' prompt-review/REF_SHAS.txt || true)"
      if [ -n "$recorded" ]; then
        printf '%s\n' "$recorded" > "$dir/.ref-sha"
        echo "[sync-ref] $dir recovered .ref-sha from REF_SHAS.txt ($recorded)"
      fi
    fi
    if [ ! -e "$dir/.git" ]; then
      if [ ! -f "$dir/.ref-sha" ]; then
        echo "[sync-ref] missing $dir/.ref-sha; cannot safely repair metadata" >&2
        return 1
      fi
      repair_metadata "$dir" "$url"
    fi
    return
  fi
  rm -rf "$dir"
  echo "[sync-ref] cloning $url → $dir"
  git clone --depth 1 "$url" "$dir"
  # Keep git metadata so checkpoints can omit and rebuild unchanged source.
  local sha
  sha="$(git -C "$dir" rev-parse HEAD)"
  echo "[sync-ref] $dir @ $sha"
  printf '%s\n' "$sha" > "$dir/.ref-sha"
  printf '/.ref-sha\n' >> "$dir/.git/info/exclude"
}

# The five clones are independent and network-bound (1.3 GB, ~2.5 min serially on
# an E2B sandbox), so run them concurrently: a failed clone fails the script.
clone_pids=()
clone_or_refresh openclaw https://github.com/openclaw/openclaw.git & clone_pids+=($!)
clone_or_refresh hermes-agent https://github.com/nousresearch/hermes-agent.git & clone_pids+=($!)
clone_or_refresh codex https://github.com/openai/codex.git & clone_pids+=($!)
clone_or_refresh prime-agent https://github.com/PrimeIntellect-ai/prime-agent.git & clone_pids+=($!)
clone_or_refresh kimi-code https://github.com/MoonshotAI/kimi-code.git & clone_pids+=($!)
clone_failed=0
for pid in "${clone_pids[@]}"; do wait "$pid" || clone_failed=1; done
[ "$clone_failed" = 0 ] || { echo "[sync-ref] a reference clone failed" >&2; exit 1; }

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
