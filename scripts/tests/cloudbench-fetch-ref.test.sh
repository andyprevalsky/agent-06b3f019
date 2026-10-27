#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FETCH_SCRIPT="$ROOT_DIR/scripts/cloudbench-fetch-ref.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
# Host url.*.insteadOf rules (for example a cloud VM's token-embedding GitHub
# rewrite) change what `git remote get-url` reports and where fetches go.
: > "$TMP_ROOT/gitconfig"
export GIT_CONFIG_GLOBAL="$TMP_ROOT/gitconfig" GIT_CONFIG_NOSYSTEM=1

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
first_commit="$(git -C "$TMP_ROOT/source" rev-parse HEAD)"
first_blob="$(git -C "$TMP_ROOT/source" rev-parse HEAD:payload.txt)"
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
for stage in git-maintenance git-fetch git-checkout git-reset; do
  grep -Eq "\\[cloudbench\\] $stage [0-9]+s" <<<"$output" || \
    fail "fresh-code timing omitted $stage"
done
assert_lock_released "$lock_path"

# The exact-SHA idempotent fast path intentionally skips maintenance because no
# fetch needs scratch space. Advance the remote so this check exercises a real
# fetch preflight rather than asking an already-current checkout to fail.
printf 'three\n' >> "$TMP_ROOT/source/payload.txt"
git -C "$TMP_ROOT/source" commit -qam three
git -C "$TMP_ROOT/source" push -q origin HEAD:main
next_target="$(git -C "$TMP_ROOT/source" rev-parse HEAD)"
failure_output="$TMP_ROOT/insufficient-space.log"
if CLOUDBENCH_GIT_COMPACT_AT_KB=999999999999 \
   CLOUDBENCH_GIT_MIN_FREE_KB=999999999999 \
   bash "$FETCH_SCRIPT" "$TMP_ROOT/checkout" "$next_target" >"$failure_output" 2>&1; then
  fail "fetch must fail closed when compaction cannot recover required space"
fi
grep -Fq '[cloudbench] FATAL: insufficient volume space for git fetch' "$failure_output" || \
  fail "insufficient-space failure did not explain the preflight rejection"
assert_lock_released "$lock_path"

# A verified dependency image plus an empty REAL-primary volume needs an exact
# checkout, not a restored donor Git pack. Keep transport local in this control.
fresh_checkout="$TMP_ROOT/fresh-checkout"
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0="url.file://$TMP_ROOT/origin.git.insteadOf" \
GIT_CONFIG_VALUE_0=https://github.com/Rose-Ai-Labs/rose.git \
GITHUB_TOKEN=local-fixture-only \
CLOUDBENCH_FRESH_VOLUME=1 CLOUDBENCH_GIT_MIN_FREE_KB=1 \
  bash "$FETCH_SCRIPT" "$fresh_checkout" "$next_target" >/dev/null 2>&1 \
  || fail "empty REAL-primary volume did not bootstrap its exact checkout"
[ "$(git -C "$fresh_checkout" rev-parse HEAD)" = "$next_target" ] \
  || fail "fresh checkout did not verify the requested commit"
# A REAL fresh volume executes this exact source tree; it does not need every
# earlier version of the benchmark checkout. Exercise the real transport and
# object store, rather than checking only the fetch argument spelling.
[ "$(git -C "$fresh_checkout" rev-parse HEAD^{tree})" = \
  "$(git -C "$TMP_ROOT/source" rev-parse "$next_target^{tree}")" ] \
  || fail "fresh checkout changed the requested source tree"
cmp "$TMP_ROOT/source/payload.txt" "$fresh_checkout/payload.txt" \
  || fail "fresh checkout changed tracked source bytes"
[ "$(git -C "$fresh_checkout" rev-parse --is-shallow-repository)" = true ] \
  || fail "fresh source checkout downloaded unrelated benchmark history"
if git -C "$fresh_checkout" cat-file -e "$first_blob" 2>/dev/null; then
  fail "fresh source checkout transferred an earlier unused source version"
fi
# Existing retained volumes continue to provide their ordinary complete history.
[ "$(git -C "$TMP_ROOT/checkout" rev-parse --is-shallow-repository)" = false ] \
  || fail "retained checkout lost its complete history"
[ "$(git -C "$TMP_ROOT/checkout" show "$first_commit:payload.txt")" = one ] \
  || fail "retained checkout cannot read its earlier source"
# Read the stored key: `remote get-url` applies the host's own insteadOf rules.
[ "$(git -C "$fresh_checkout" config --get remote.origin.url)" = https://github.com/Rose-Ai-Labs/rose.git ] \
  || fail "fresh checkout persisted a rewritten or authenticated origin"
assert_lock_released "$fresh_checkout/.git/cloudbench-fetch.lock"
if CLOUDBENCH_GIT_MIN_FREE_KB=1 bash "$FETCH_SCRIPT" "$TMP_ROOT/not-authorized" "$next_target" >/dev/null 2>&1; then
  fail "missing checkout bootstrap must require explicit fresh-volume handoff"
fi
[ ! -e "$TMP_ROOT/not-authorized" ] || fail "unrequested bootstrap wrote a checkout"
mkdir "$TMP_ROOT/non-git-data"
printf 'preserve\n' > "$TMP_ROOT/non-git-data/asset"
if CLOUDBENCH_FRESH_VOLUME=1 CLOUDBENCH_GIT_MIN_FREE_KB=1 \
  bash "$FETCH_SCRIPT" "$TMP_ROOT/non-git-data" "$next_target" >/dev/null 2>&1; then
  fail "fresh bootstrap must refuse retained non-Git data"
fi
[ "$(cat "$TMP_ROOT/non-git-data/asset")" = preserve ] || fail "retained data changed"


# An autoscaled REAL worker on fresh storage only executes the runtime source.
# Append-only benchmark history ledgers are read and written by the primary's
# benchmark runner, never by the worker, and are already excluded from the
# workspace patch. Exact-source startup must not inflate and write them: their
# growth pushed every worker past the 300s queue-readiness gate (descend
# 2026-10-23, test-mass-agent-run-0). GitHub serves partial-clone filters; the
# local bare origin is configured the same way.
git -C "$TMP_ROOT/origin.git" config uploadpack.allowFilter true
mkdir -p "$TMP_ROOT/source/agents/benchmarks/history"
printf '{"span":"ledger"}\n' > "$TMP_ROOT/source/agents/benchmarks/history/span_durations.jsonl"
: > "$TMP_ROOT/source/agents/benchmarks/history/.gitkeep"
printf 'print("worker")\n' > "$TMP_ROOT/source/agents/worker.py"
git -C "$TMP_ROOT/source" add agents
git -C "$TMP_ROOT/source" commit -qm ledger
git -C "$TMP_ROOT/source" push -q origin HEAD:main
ledger_target="$(git -C "$TMP_ROOT/source" rev-parse HEAD)"
ledger_blob="$(git -C "$TMP_ROOT/source" rev-parse HEAD:agents/benchmarks/history/span_durations.jsonl)"
worker_checkout="$TMP_ROOT/worker-checkout"
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0="url.file://$TMP_ROOT/origin.git.insteadOf" \
GIT_CONFIG_VALUE_0=https://github.com/Rose-Ai-Labs/rose.git \
CLOUDBENCH_GITHUB_TOKEN_B64="$(printf local-fixture-only | base64)" \
CLOUDBENCH_FRESH_VOLUME=1 CLOUDBENCH_SOURCE_SCOPE=worker-runtime CLOUDBENCH_GIT_MIN_FREE_KB=1 \
  bash "$FETCH_SCRIPT" "$worker_checkout" "$ledger_target" >/dev/null 2>&1 \
  || fail "fresh worker volume did not bootstrap its exact runtime checkout"
[ "$(git -C "$worker_checkout" rev-parse HEAD)" = "$ledger_target" ] \
  || fail "fresh worker checkout did not verify the requested commit"
[ "$(git -C "$worker_checkout" rev-parse HEAD^{tree})" = \
  "$(git -C "$TMP_ROOT/source" rev-parse "$ledger_target^{tree}")" ] \
  || fail "fresh worker checkout changed the requested source tree"
for path in payload.txt agents/worker.py agents/benchmarks/history/.gitkeep; do
  cmp "$TMP_ROOT/source/$path" "$worker_checkout/$path" \
    || fail "fresh worker checkout changed runtime source bytes: $path"
done
[ ! -e "$worker_checkout/agents/benchmarks/history/span_durations.jsonl" ] \
  || fail "fresh worker checkout wrote an unused benchmark history ledger"
git -C "$worker_checkout" rev-list --objects --missing=print "$ledger_target" \
  | grep -Fxq "?$ledger_blob" \
  || fail "fresh worker checkout transferred an unused benchmark history ledger"
unexpected_sparse="$(git -C "$worker_checkout" ls-files -t \
  | grep '^S ' | grep -Ev '^S agents/benchmarks/history/[^/]+\.jsonl$' || true)"
[ -z "$unexpected_sparse" ] \
  || fail "fresh worker checkout omitted runtime source: $unexpected_sparse"
# The worker's later restore/clean/verify steps run after the request-scoped
# credential is gone; they must never need the omitted ledger objects.
offline_git() {
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="url.file://$TMP_ROOT/no-such-origin.git.insteadOf" \
    GIT_CONFIG_VALUE_0=https://github.com/Rose-Ai-Labs/rose.git GIT_TERMINAL_PROMPT=0 \
    git -C "$worker_checkout" "$@"
}
offline_git restore --source "$ledger_target" --staged --worktree -- . \
  || fail "worker tracked-source restore needed omitted ledger objects"
offline_git diff --no-ext-diff --quiet "$ledger_target" -- \
  && offline_git diff --no-ext-diff --cached --quiet "$ledger_target" -- \
  && [ -z "$(offline_git status --porcelain)" ] \
  || fail "worker checkout did not verify clean against the requested base"
[ "$(git -C "$worker_checkout" config --get remote.origin.url)" = https://github.com/Rose-Ai-Labs/rose.git ] \
  || fail "worker checkout persisted a rewritten or authenticated origin"
assert_lock_released "$worker_checkout/.git/cloudbench-fetch.lock"
# The primary's benchmark runner reads and appends these ledgers: its fresh
# bootstrap keeps the complete requested tree.
primary_checkout="$TMP_ROOT/primary-checkout"
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0="url.file://$TMP_ROOT/origin.git.insteadOf" \
GIT_CONFIG_VALUE_0=https://github.com/Rose-Ai-Labs/rose.git \
CLOUDBENCH_GITHUB_TOKEN_B64="$(printf local-fixture-only | base64)" \
CLOUDBENCH_FRESH_VOLUME=1 CLOUDBENCH_GIT_MIN_FREE_KB=1 \
  bash "$FETCH_SCRIPT" "$primary_checkout" "$ledger_target" >/dev/null 2>&1 \
  || fail "fresh primary volume did not bootstrap its exact checkout"
cmp "$TMP_ROOT/source/agents/benchmarks/history/span_durations.jsonl" \
  "$primary_checkout/agents/benchmarks/history/span_durations.jsonl" \
  || fail "fresh primary checkout lost its benchmark history ledger"
if CLOUDBENCH_FRESH_VOLUME=1 CLOUDBENCH_SOURCE_SCOPE=everything CLOUDBENCH_GIT_MIN_FREE_KB=1 \
  bash "$FETCH_SCRIPT" "$TMP_ROOT/unknown-scope" "$ledger_target" >/dev/null 2>&1; then
  fail "unknown source scope must fail closed"
fi
grep -Fq 'CLOUDBENCH_SOURCE_SCOPE=worker-runtime' "$ROOT_DIR/scripts/cloudbench-worker.sh" \
  || fail "autoscaled worker does not request its runtime-only source scope"

echo "All cloud benchmark fetch checks passed."
