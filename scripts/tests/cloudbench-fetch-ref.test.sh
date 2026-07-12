#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FETCH_SCRIPT="$ROOT_DIR/scripts/cloudbench-fetch-ref.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

git init -q --bare "$TMP_ROOT/origin.git"
git init -q "$TMP_ROOT/source"
git -C "$TMP_ROOT/source" config user.email cloudbench-test@example.com
git -C "$TMP_ROOT/source" config user.name cloudbench-test
printf 'one\n' > "$TMP_ROOT/source/payload.txt"
git -C "$TMP_ROOT/source" add payload.txt
git -C "$TMP_ROOT/source" commit -qm one
git -C "$TMP_ROOT/source" remote add origin "$TMP_ROOT/origin.git"
git -C "$TMP_ROOT/source" push -q origin HEAD:main

git clone -q --branch main "$TMP_ROOT/origin.git" "$TMP_ROOT/checkout"
printf 'two\n' >> "$TMP_ROOT/source/payload.txt"
git -C "$TMP_ROOT/source" commit -qam two
git -C "$TMP_ROOT/source" push -q origin HEAD:main
target="$(git -C "$TMP_ROOT/source" rev-parse HEAD)"

# Reproduce the owned boundary: persistent pack data plus an incomplete pack
# exists before a ref fetch. A one-KB threshold deterministically exercises the
# same pre-fetch reclamation path without filling the developer's filesystem.
git -C "$TMP_ROOT/checkout" gc --prune=now
mkdir -p "$TMP_ROOT/checkout/.git/objects/pack"
dd if=/dev/zero of="$TMP_ROOT/checkout/.git/objects/pack/tmp_pack_interrupted" bs=1024 count=2 status=none

output="$(
  CLOUDBENCH_GIT_COMPACT_AT_KB=1 \
  CLOUDBENCH_GIT_MIN_FREE_KB=1 \
    bash "$FETCH_SCRIPT" "$TMP_ROOT/checkout" "$target"
)"

[ ! -e "$TMP_ROOT/checkout/.git/objects/pack/tmp_pack_interrupted" ] || \
  fail "incomplete pack was not removed before fetch"
[ "$(git -C "$TMP_ROOT/checkout" rev-parse HEAD)" = "$target" ] || \
  fail "requested ref was not checked out"
grep -Fq '[cloudbench] compacting persistent Git object store' <<<"$output" || \
  fail "oversized persistent object store did not trigger compaction"

echo "All cloud benchmark fetch checks passed."
