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

assert_lock_released() {
  local path="$1"
  if command -v flock >/dev/null 2>&1; then
    exec 8<> "$path"
    flock -n 8 || fail "repository lock is still owned"
    flock -u 8
    exec 8>&-
  else
    [ ! -e "$path" ] || fail "repository lock file was not released"
  fi
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
lock_path="$TMP_ROOT/checkout/.git/cloudbench-fetch.lock"

# A previous driver can leave Git maintenance children alive briefly after its
# controller exits. The fetch helper must never delete pack temporaries or start
# another fetch while that operation still owns the repository.
if command -v flock >/dev/null 2>&1; then
  exec 9<> "$lock_path"
  flock -n 9
elif command -v shlock >/dev/null 2>&1; then
  shlock -p "$$" -f "$lock_path"
else
  fail "flock or shlock is required to test fetch serialization"
fi
if CLOUDBENCH_GIT_MIN_FREE_KB=1 bash "$FETCH_SCRIPT" "$TMP_ROOT/checkout" "$target" >/dev/null 2>&1; then
  fail "a second fetch must not enter a locked object store"
fi
if command -v flock >/dev/null 2>&1; then
  flock -u 9
  exec 9>&-
fi
rm -f "$lock_path"

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
assert_lock_released "$lock_path"

failure_output="$TMP_ROOT/insufficient-space.log"
if CLOUDBENCH_GIT_COMPACT_AT_KB=999999999999 \
   CLOUDBENCH_GIT_MIN_FREE_KB=999999999999 \
   bash "$FETCH_SCRIPT" "$TMP_ROOT/checkout" "$target" >"$failure_output" 2>&1; then
  fail "fetch must fail closed when compaction cannot recover required space"
fi
grep -Fq '[cloudbench] FATAL: insufficient volume space for git fetch' "$failure_output" || \
  fail "insufficient-space failure did not explain the preflight rejection"
assert_lock_released "$lock_path"

echo "All cloud benchmark fetch checks passed."
