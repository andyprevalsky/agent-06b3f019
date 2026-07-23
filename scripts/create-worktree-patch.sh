#!/usr/bin/env bash
# Emit a git-apply-compatible patch containing tracked edits and untracked files.
set -euo pipefail

ROOT_DIR="${1:-$(git rev-parse --show-toplevel)}"
PATCH_BASE="${2:-HEAD}"
PATCH_PATHS=(
    "."
    ":(exclude)agents/benchmarks/history/*.jsonl"
)

git -C "$ROOT_DIR" rev-parse --verify "${PATCH_BASE}^{commit}" >/dev/null
git -C "$ROOT_DIR" diff --binary --no-ext-diff "$PATCH_BASE" -- "${PATCH_PATHS[@]}"

while IFS= read -r -d '' relative_path; do
    case "$relative_path" in
        agents/benchmarks/history/*.jsonl)
            continue
            ;;
    esac
    rc=0
    git -C "$ROOT_DIR" diff --binary --no-ext-diff --no-index -- /dev/null "$relative_path" || rc=$?
    # git diff --no-index returns 1 when it successfully found a difference.
    [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ] || exit "$rc"
done < <(git -C "$ROOT_DIR" ls-files --others --exclude-standard -z)
