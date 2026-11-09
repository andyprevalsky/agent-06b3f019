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
printf '{"span":"shard"}\n' > "$TMP_ROOT/source/agents/benchmarks/history/span_durations.20261106.jsonl"
printf '{"task":"attempt"}\n' > "$TMP_ROOT/source/agents/benchmarks/history/task_attempts.jsonl"
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
# The primary's benchmark runner reads the task_* ledgers and only appends span
# ledgers (their readers are the agent_latency CLI and tests). A disposable fresh
# primary therefore skips the span shards, ~86% of the real tree: a full depth-1
# fetch took 271-389 s per guest on the 2026-11-06 /deploy smoke.
primary_checkout="$TMP_ROOT/primary-checkout"
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0="url.file://$TMP_ROOT/origin.git.insteadOf" \
GIT_CONFIG_VALUE_0=https://github.com/Rose-Ai-Labs/rose.git \
CLOUDBENCH_GITHUB_TOKEN_B64="$(printf local-fixture-only | base64)" \
CLOUDBENCH_FRESH_VOLUME=1 CLOUDBENCH_GIT_MIN_FREE_KB=1 \
  bash "$FETCH_SCRIPT" "$primary_checkout" "$ledger_target" > "$TMP_ROOT/primary.log" 2>&1 \
  || fail "fresh primary volume did not bootstrap its exact checkout"
[ "$(git -C "$primary_checkout" rev-parse HEAD)" = "$ledger_target" ] \
  || fail "fresh primary checkout did not verify the requested commit"
for path in payload.txt agents/worker.py agents/benchmarks/history/.gitkeep \
    agents/benchmarks/history/task_attempts.jsonl; do
  cmp "$TMP_ROOT/source/$path" "$primary_checkout/$path" \
    || fail "fresh primary checkout changed runner source or task ledgers: $path"
done
for path in span_durations.jsonl span_durations.20261106.jsonl; do
  [ ! -e "$primary_checkout/agents/benchmarks/history/$path" ] \
    || fail "fresh primary checkout wrote an append-only span ledger: $path"
done
git -C "$primary_checkout" rev-list --objects --missing=print "$ledger_target" \
  | grep -Fxq "?$ledger_blob" \
  || fail "fresh primary checkout transferred an append-only span ledger"
unexpected_sparse="$(git -C "$primary_checkout" ls-files -t \
  | grep '^S ' | grep -Ev '^S agents/benchmarks/history/span_durations[^/]*\.jsonl$' || true)"
[ -z "$unexpected_sparse" ] \
  || fail "fresh primary checkout omitted runner source or task ledgers: $unexpected_sparse"
grep -Fq 'complete checkout omits agents/benchmarks/history/span_durations*.jsonl' "$TMP_ROOT/primary.log" \
  || fail "fresh primary checkout did not report its declared omission"
# The driver's pre-run git_sync repeats the fetch helper ("already-at"); that pass,
# its tracked-path restore and the worktree clean must not need the omitted objects.
# (No git operation runs on the disposable primary after the benchmark appends.)
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="url.file://$TMP_ROOT/no-such-origin.git.insteadOf" \
  GIT_CONFIG_VALUE_0=https://github.com/Rose-Ai-Labs/rose.git GIT_TERMINAL_PROMPT=0 \
  CLOUDBENCH_GIT_MIN_FREE_KB=1 bash "$FETCH_SCRIPT" "$primary_checkout" "$ledger_target" > "$TMP_ROOT/primary-again.log" 2>&1 \
  && grep -Fq "already-at $ledger_target" "$TMP_ROOT/primary-again.log" \
  || fail "fresh primary git_sync pass needed omitted ledger objects"
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="url.file://$TMP_ROOT/no-such-origin.git.insteadOf" \
  GIT_CONFIG_VALUE_0=https://github.com/Rose-Ai-Labs/rose.git GIT_TERMINAL_PROMPT=0 \
  git -C "$primary_checkout" clean -ffd >/dev/null \
  && [ -z "$(git -C "$primary_checkout" status --porcelain)" ] \
  || fail "fresh primary checkout did not verify clean offline"
# A retained volume generation (not a disposable physical volume) keeps the
# complete tree, including the span ledgers.
retained_checkout="$TMP_ROOT/retained-checkout"
git clone -q "$TMP_ROOT/origin.git" "$retained_checkout"
git -C "$retained_checkout" checkout -q --detach "$next_target"
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0="url.file://$TMP_ROOT/origin.git.insteadOf" \
GIT_CONFIG_VALUE_0=https://github.com/Rose-Ai-Labs/rose.git \
CLOUDBENCH_GITHUB_TOKEN_B64="$(printf local-fixture-only | base64)" \
CLOUDBENCH_GIT_MIN_FREE_KB=1 \
  bash "$FETCH_SCRIPT" "$retained_checkout" "$ledger_target" >/dev/null 2>&1 \
  || fail "retained primary volume did not fetch its exact checkout"
cmp "$TMP_ROOT/source/agents/benchmarks/history/span_durations.jsonl" \
  "$retained_checkout/agents/benchmarks/history/span_durations.jsonl" \
  || fail "retained primary checkout lost its benchmark history ledger"
if CLOUDBENCH_FRESH_VOLUME=1 CLOUDBENCH_SOURCE_SCOPE=everything CLOUDBENCH_GIT_MIN_FREE_KB=1 \
  bash "$FETCH_SCRIPT" "$TMP_ROOT/unknown-scope" "$ledger_target" >/dev/null 2>&1; then
  fail "unknown source scope must fail closed"
fi
grep -Fq 'CLOUDBENCH_SOURCE_SCOPE=worker-runtime' "$ROOT_DIR/scripts/cloudbench-worker.sh" \
  || fail "autoscaled worker does not request its runtime-only source scope"

# A fresh REAL primary with no HEAD otherwise transfers its whole tree for a
# depth-1 fetch (descend I11: ~330 MB / ~230 s per copy at b08532144). The warm
# image's read-only seed (a depth-1 bare repository of its pushed build commit)
# lets the fetch negotiate from that commit, so only newer objects transfer;
# the exact requested SHA, tree and bytes are verified as before. Transfer is
# measured from the packs the fetch itself wrote (unpackLimit=1 keeps them packed).
git -C "$TMP_ROOT/origin.git" config uploadpack.allowAnySHA1InWant true
mkdir -p "$TMP_ROOT/source/agents/benchmarks/history"
head -c 3000000 /dev/urandom | base64 > "$TMP_ROOT/source/agents/benchmarks/history/span_durations.20261013.jsonl"
git -C "$TMP_ROOT/source" add agents
git -C "$TMP_ROOT/source" commit -qm "seed-era history"
git -C "$TMP_ROOT/source" push -q origin HEAD:main
seed_base="$(git -C "$TMP_ROOT/source" rev-parse HEAD)"
printf '{"span":"after-seed"}\n' >> "$TMP_ROOT/source/agents/benchmarks/history/span_durations.jsonl"
printf 'print("new")\n' > "$TMP_ROOT/source/agents/new_runtime.py"
git -C "$TMP_ROOT/source" add agents
git -C "$TMP_ROOT/source" commit -qm "requested source"
git -C "$TMP_ROOT/source" push -q origin HEAD:main
seed_target="$(git -C "$TMP_ROOT/source" rev-parse HEAD)"
make_seed() {  # <dir> <commit>: the image builder's seed layout
  git init -q --bare "$1"
  git -C "$1" fetch -q --depth=1 "file://$TMP_ROOT/origin.git" "$2"
  git -C "$1" update-ref refs/cloudbench/seed "$2"
  printf '{"schema": "cloudbench-git-seed-v1", "commit": "%s"}\n' "$2" > "$1/cloudbench-seed.json"
  git -C "$1" repack -q -a -d
}
fetched_bytes() {  # <checkout> <seed-dir>: bytes of packs the fetch wrote (not copied from the seed)
  local total=0 pack name
  for pack in "$1"/.git/objects/pack/pack-*.pack; do
    name="${pack##*/}"
    [ -n "${2:-}" ] && [ -e "$2/objects/pack/$name" ] && continue
    total=$((total + $(wc -c < "$pack")))
  done
  echo "$total"
}
seeded_fetch() {  # <checkout> <seed-dir> <log>
  GIT_CONFIG_COUNT=2 \
  GIT_CONFIG_KEY_0="url.file://$TMP_ROOT/origin.git.insteadOf" \
  GIT_CONFIG_VALUE_0=https://github.com/Rose-Ai-Labs/rose.git \
  GIT_CONFIG_KEY_1=fetch.unpackLimit GIT_CONFIG_VALUE_1=1 \
  CLOUDBENCH_GITHUB_TOKEN_B64="$(printf local-fixture-only | base64)" \
  CLOUDBENCH_GIT_SEED_DIR="$2" \
  CLOUDBENCH_FRESH_VOLUME=1 CLOUDBENCH_GIT_MIN_FREE_KB=1 \
    bash "$FETCH_SCRIPT" "$1" "$seed_target" > "$3" 2>&1
}
assert_exact_checkout() {  # <checkout> <label>
  [ "$(git -C "$1" rev-parse HEAD)" = "$seed_target" ] \
    && [ "$(git -C "$1" rev-parse HEAD^{tree})" = "$(git -C "$TMP_ROOT/source" rev-parse "$seed_target^{tree}")" ] \
    && cmp -s "$TMP_ROOT/source/agents/benchmarks/history/span_durations.20261013.jsonl" \
              "$1/agents/benchmarks/history/span_durations.20261013.jsonl" \
    && cmp -s "$TMP_ROOT/source/agents/new_runtime.py" "$1/agents/new_runtime.py" \
    && ! git -C "$1" rev-parse --verify -q refs/cloudbench/seed >/dev/null \
    && git -C "$1" fsck --connectivity-only --no-progress "$seed_target" >/dev/null 2>&1 \
    || fail "$2: fresh checkout is not the exact requested source"
}
make_seed "$TMP_ROOT/seed" "$seed_base"
seeded_fetch "$TMP_ROOT/unseeded" "$TMP_ROOT/no-seed-here" "$TMP_ROOT/unseeded.log" \
  || fail "unseeded fresh fetch failed: $(cat "$TMP_ROOT/unseeded.log")"
assert_exact_checkout "$TMP_ROOT/unseeded" unseeded
unseeded_bytes="$(fetched_bytes "$TMP_ROOT/unseeded")"
seeded_fetch "$TMP_ROOT/seeded" "$TMP_ROOT/seed" "$TMP_ROOT/seeded.log" \
  || fail "seeded fresh fetch failed: $(cat "$TMP_ROOT/seeded.log")"
assert_exact_checkout "$TMP_ROOT/seeded" seeded
seeded_bytes="$(fetched_bytes "$TMP_ROOT/seeded" "$TMP_ROOT/seed")"
grep -Fq "[cloudbench] git-seed $seed_base" "$TMP_ROOT/seeded.log" \
  || fail "fresh fetch did not use the intact image seed"
echo "seeded fresh fetch transferred $seeded_bytes of $unseeded_bytes unseeded bytes"
[ "$unseeded_bytes" -gt 3000000 ] && [ $((seeded_bytes * 20)) -lt "$unseeded_bytes" ] \
  || fail "image seed did not cut the fresh-volume transfer ($seeded_bytes vs $unseeded_bytes bytes)"
# Fail closed to the ordinary unseeded fetch: corrupt pack bytes, a manifest
# that does not name the seed's shallow commit, or a seed commit the server
# never had. Each still yields the exact verified source and no seed residue.
cp -a "$TMP_ROOT/seed" "$TMP_ROOT/seed-corrupt"
corrupt_pack="$(ls "$TMP_ROOT"/seed-corrupt/objects/pack/pack-*.pack)"
chmod u+w "$corrupt_pack"
python3 -c 'import sys
p=sys.argv[1]; b=bytearray(open(p,"rb").read()); b[len(b)//2]^=0xff; open(p,"wb").write(bytes(b))' "$corrupt_pack"
cp -a "$TMP_ROOT/seed" "$TMP_ROOT/seed-stale"
printf '{"schema": "cloudbench-git-seed-v1", "commit": "%s"}\n' "$seed_target" > "$TMP_ROOT/seed-stale/cloudbench-seed.json"
# A damaged index with an intact pack must not name wrong content: swap the
# offsets of two blobs that the requested tree checks out (the large history
# ledger and payload.txt). The seed is imported through Git, which re-hashes.
cp -a "$TMP_ROOT/seed" "$TMP_ROOT/seed-index"
swap_a="$(git -C "$TMP_ROOT/source" rev-parse "$seed_base:agents/benchmarks/history/span_durations.20261013.jsonl")"
swap_b="$(git -C "$TMP_ROOT/source" rev-parse "$seed_base:payload.txt")"
python3 - "$(ls "$TMP_ROOT"/seed-index/objects/pack/pack-*.idx)" "$swap_a" "$swap_b" <<'PYIDX'
import os, struct, sys
path, first, second = sys.argv[1], bytes.fromhex(sys.argv[2]), bytes.fromhex(sys.argv[3])
os.chmod(path, 0o644)
data = bytearray(open(path, "rb").read())
assert data[:4] == b"\377tOc" and struct.unpack(">I", data[4:8])[0] == 2
count = struct.unpack(">I", data[8 + 255 * 4:8 + 256 * 4])[0]
names = [bytes(data[8 + 256 * 4 + i * 20:8 + 256 * 4 + (i + 1) * 20]) for i in range(count)]
offsets = 8 + 256 * 4 + count * 20 + count * 4
i, j = names.index(first), names.index(second)
a, b = offsets + 4 * i, offsets + 4 * j
data[a:a + 4], data[b:b + 4] = data[b:b + 4], data[a:a + 4]
open(path, "wb").write(bytes(data))
PYIDX
# An intact pack and index can still omit a reachable blob. Keep every other
# reachable object so the missing blob is the only invalid seed boundary.
git init -q --bare "$TMP_ROOT/seed-incomplete"
missing_blob="$(git -C "$TMP_ROOT/source" rev-parse "$seed_base:payload.txt")"
git -C "$TMP_ROOT/seed" rev-list --objects --no-object-names "$seed_base" \
  | grep -vx "$missing_blob" \
  | git -C "$TMP_ROOT/seed" pack-objects --stdout > "$TMP_ROOT/incomplete.pack"
git -C "$TMP_ROOT/seed-incomplete" index-pack --stdin < "$TMP_ROOT/incomplete.pack" >/dev/null
cp "$TMP_ROOT/seed/shallow" "$TMP_ROOT/seed/cloudbench-seed.json" "$TMP_ROOT/seed-incomplete/"
git -C "$TMP_ROOT/seed-incomplete" update-ref refs/cloudbench/seed "$seed_base"
git -C "$TMP_ROOT/seed-incomplete" cat-file -e "$seed_base^{tree}" \
  || fail "incomplete fixture must retain the commit and root tree"
if git -C "$TMP_ROOT/seed-incomplete" cat-file -e "$missing_blob" 2>/dev/null; then
  fail "incomplete fixture accidentally retained the missing reachable blob"
fi
cp -a "$TMP_ROOT/seed" "$TMP_ROOT/seed-damaged-index"
damaged_index="$(ls "$TMP_ROOT"/seed-damaged-index/objects/pack/pack-*.idx)"
chmod u+w "$damaged_index"
python3 - "$damaged_index" <<'PY_BAD_INDEX'
import pathlib,sys
path=pathlib.Path(sys.argv[1]);data=bytearray(path.read_bytes());data[-1]^=0xff;path.write_bytes(data)
PY_BAD_INDEX
for control in corrupt stale index incomplete damaged-index; do
  seeded_fetch "$TMP_ROOT/fallback-$control" "$TMP_ROOT/seed-$control" "$TMP_ROOT/fallback-$control.log" \
    || fail "$control seed broke the fresh fetch: $(cat "$TMP_ROOT/fallback-$control.log")"
  # Native transport may repair an index checksum with correct object mapping;
  # its regenerated destination must still satisfy every exact-source check.
  if [ "$control" != damaged-index ]; then
    grep -Fq 'git-seed ignored' "$TMP_ROOT/fallback-$control.log" || fail "$control seed was not ignored"
    [ "$(fetched_bytes "$TMP_ROOT/fallback-$control")" -gt 3000000 ] || fail "$control seed objects leaked into the checkout"
  fi
  assert_exact_checkout "$TMP_ROOT/fallback-$control" "$control seed"
done
# HEAD-less does not imply an empty object store: a previous attempt may have
# populated unrelated objects. Skipping an optional seed must preserve them.
preexisting_checkout="$TMP_ROOT/fallback-preexisting"
git init -q "$preexisting_checkout"
git -C "$preexisting_checkout" remote add origin https://github.com/Rose-Ai-Labs/rose.git
printf '%s\n' "$first_blob" | git -C "$TMP_ROOT/source" pack-objects --stdout > "$TMP_ROOT/unrelated.pack"
unrelated_pack_sha="$(git -C "$preexisting_checkout" index-pack --stdin < "$TMP_ROOT/unrelated.pack" | awk '{print $2}')"
unrelated_pack="$preexisting_checkout/.git/objects/pack/pack-$unrelated_pack_sha.pack"
[ -f "$unrelated_pack" ] || fail "unrelated pack control was not created"
seeded_fetch "$preexisting_checkout" "$TMP_ROOT/seed-stale" "$TMP_ROOT/preexisting.log" \
  || fail "an ignored seed broke the existing HEAD-less object store"
[ -f "$unrelated_pack" ] || fail "seed rollback deleted a preexisting unrelated pack"
assert_exact_checkout "$preexisting_checkout" "preexisting object store"

# Inject an interrupted native import after Git has written objects. Its
# rollback must make ordinary exact fetch succeed with no corrupt pack residue.
partial_checkout="$TMP_ROOT/fallback-partial-import"
mkdir "$TMP_ROOT/import-bin"
real_git="$(command -v git)"
cat > "$TMP_ROOT/import-bin/git" <<'PARTIAL_IMPORT'
#!/usr/bin/env bash
case " $* " in
  *"fallback-retry fetch "*"--negotiation-tip=refs/cloudbench/seed"*" origin "*)
    printf 'seeded\n' >> "$RETRY_OBSERVED"
    exit 55 ;;
  *"fallback-partial-import fetch "*"file://"*"+refs/cloudbench/seed:refs/cloudbench/seed"*)
    "$REAL_GIT" "$@" || exit $?
    pack="$(find "$PARTIAL_CHECKOUT/.git/objects/pack" -name '*.pack' -print -quit)"
    [ -n "$pack" ] || exit 93
    head -c 16 "$pack" > "$pack.partial"
    mv "$pack.partial" "$pack"
    : > "$PARTIAL_IMPORT_OBSERVED"
    exit 1 ;;
esac
exec "$REAL_GIT" "$@"
PARTIAL_IMPORT
chmod +x "$TMP_ROOT/import-bin/git"
PATH="$TMP_ROOT/import-bin:$PATH" REAL_GIT="$real_git" PARTIAL_CHECKOUT="$partial_checkout" \
PARTIAL_IMPORT_OBSERVED="$TMP_ROOT/partial-import-observed" \
  seeded_fetch "$partial_checkout" "$TMP_ROOT/seed" "$TMP_ROOT/partial-import.log" \
  || fail "partial seed import broke ordinary fetch: $(cat "$TMP_ROOT/partial-import.log")"
[ -f "$TMP_ROOT/partial-import-observed" ] || fail "partial import control did not execute"
assert_exact_checkout "$partial_checkout" "partial import"
PATH="$TMP_ROOT/import-bin:$PATH" REAL_GIT="$real_git" RETRY_OBSERVED="$TMP_ROOT/retry-observed" \
  seeded_fetch "$TMP_ROOT/fallback-retry" "$TMP_ROOT/seed" "$TMP_ROOT/retry.log" \
  || fail "seeded fetch failure did not retry ordinary exact fetch: $(cat "$TMP_ROOT/retry.log")"
[ "$(wc -l < "$TMP_ROOT/retry-observed" | tr -d ' ')" = 1 ] || fail "seeded fetch was retried more than once"
grep -Fq 'git-seed fetch failed; retrying without the seed' "$TMP_ROOT/retry.log" || fail "unseeded retry was not recorded"
assert_exact_checkout "$TMP_ROOT/fallback-retry" "once-only unseeded retry"

git init -q "$TMP_ROOT/foreign"
printf 'unrelated\n' > "$TMP_ROOT/foreign/x"
git -C "$TMP_ROOT/foreign" add x
git -C "$TMP_ROOT/foreign" -c user.name=t -c user.email=t@t commit -qm foreign
git init -q --bare "$TMP_ROOT/foreign.git"
git -C "$TMP_ROOT/foreign" push -q "$TMP_ROOT/foreign.git" HEAD:main
git -C "$TMP_ROOT/foreign.git" config uploadpack.allowAnySHA1InWant true
foreign_commit="$(git -C "$TMP_ROOT/foreign" rev-parse HEAD)"
git init -q --bare "$TMP_ROOT/seed-foreign"
git -C "$TMP_ROOT/seed-foreign" fetch -q --depth=1 "file://$TMP_ROOT/foreign.git" "$foreign_commit"
printf '{"schema": "cloudbench-git-seed-v1", "commit": "%s"}\n' "$foreign_commit" > "$TMP_ROOT/seed-foreign/cloudbench-seed.json"
seeded_fetch "$TMP_ROOT/fallback-foreign" "$TMP_ROOT/seed-foreign" "$TMP_ROOT/fallback-foreign.log" \
  || fail "a seed commit unknown to the server broke the fresh fetch: $(cat "$TMP_ROOT/fallback-foreign.log")"
assert_exact_checkout "$TMP_ROOT/fallback-foreign" "foreign seed"

echo "All cloud benchmark fetch checks passed."
