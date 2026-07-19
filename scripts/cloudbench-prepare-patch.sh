#!/usr/bin/env bash
set -euo pipefail

# A persistent cloud checkout can retain an untracked file created by the prior
# run's dirty patch. `git reset --hard` leaves it behind, and the next identical
# patch then fails with "already exists in working directory". Remove only paths
# that the incoming patch itself declares as newly created, never tracked files.

repo="${1:-}"
patch_file="${2:-}"
[ -d "$repo/.git" ] && [ -s "$patch_file" ] || exit 2

repo_real="$(cd "$repo" && pwd -P)"
summary="$(git -C "$repo" -c core.quotePath=false apply --summary "$patch_file")"
while IFS= read -r path; do
    [ -n "$path" ] || continue
    case "$path" in
        /*|../*|*/../*)
            echo "FATAL: unsafe created path in benchmark patch: $path" >&2
            exit 1
            ;;
    esac
    if git -C "$repo" ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
        echo "FATAL: benchmark patch create path is already tracked: $path" >&2
        exit 1
    fi
    [ -e "$repo/$path" ] || [ -L "$repo/$path" ] || continue
    parent="$(dirname "$repo/$path")"
    parent_real="$(cd "$parent" 2>/dev/null && pwd -P)"
    case "$parent_real/" in
        "$repo_real/"*) ;;
        *)
            echo "FATAL: benchmark patch create path escapes checkout: $path" >&2
            exit 1
            ;;
    esac
    rm -f -- "$repo/$path"
done <<EOF
$(printf '%s\n' "$summary" | sed -n 's/^ create mode [0-9][0-9]* //p')
EOF
