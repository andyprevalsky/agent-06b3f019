#!/usr/bin/env bash
# Materialize the worker image build context from immutable Git objects.
#
#   agents-image-context.sh SHA DEST
#
# The context is agents/ at SHA minus benchmarks/ and tests/ (also the Docker
# ignore file's exclusions). It is read from Git objects, never from working
# tree files another process could change. Each top-level entry is exported on
# its own: `git archive SHA:agents` prefetches every blob under the tree, which
# in the blob-filtered CI checkout lazily downloads the 2.8 GB benchmark
# history it then discards (measured: >6 min vs ~1 s). Shared by the cutover
# build and the pre-merge prebuild so both build byte-identical contexts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHA="${1:-}"
DEST="${2:-}"
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "usage: agents-image-context.sh <full sha> <dest>" >&2; exit 2; }
[ -n "$DEST" ] && [ -d "$DEST" ] || { echo "destination directory is required" >&2; exit 2; }

while IFS=$'\t' read -r meta name; do
  read -r mode type object <<< "$meta"
  case "$name" in benchmarks|tests) continue ;; esac
  case "$type:$mode" in
    tree:040000)
      git -C "$ROOT" archive --prefix="$name/" "$SHA:agents/$name" |
        tar -x -C "$DEST" --exclude=benchmarks --exclude=tests ;;
    blob:100644|blob:100755)
      git -C "$ROOT" cat-file blob "$object" > "$DEST/$name"
      # Same permissions tar extraction gives the subtrees: Git mode minus umask.
      chmod "$(printf '%o' $(( (${mode: -3} == 755 ? 8#755 : 8#644) & ~8#$(umask) )))" "$DEST/$name" ;;
    blob:120000)
      ln -s "$(git -C "$ROOT" cat-file blob "$object")" "$DEST/$name" ;;
    *)
      echo "unsupported agents entry $name ($type $mode)" >&2; exit 1 ;;
  esac
done < <(git -C "$ROOT" ls-tree "$SHA:agents")
