#!/usr/bin/env bash
# Regression for back-end/scripts/run-coverage-sharded.sh (the /deploy Step 4a
# backend coverage gate). Runs the real coordinator against a fake per-shard
# run-coverage.sh so no backend, database or c8 is needed. Proves:
#   1. every shard gets a distinct BACKEND_COVERAGE_SHARD and port range, and a
#      failed shard fails the gate while archiving passing shards' raw coverage
#      (so the next run is not blocked by a leftover merge directory);
#   2. --failed-first exports the previous run's failed domains (read from the
#      shards' retained summaries) with abort-on-repeat, and a repeated failure
#      stops the sibling shards instead of waiting for them;
#   3. the merged threshold check (npx c8 report --check-coverage) runs only
#      when every shard passed, and its exit status is the gate's.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/backend-coverage-sharded.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

REPO="$TMP/repo"
mkdir -p "$REPO/back-end/scripts" "$REPO/back-end/coverage" "$REPO/bin"
cp "$ROOT_DIR/back-end/scripts/run-coverage-sharded.sh" "$REPO/back-end/scripts/"

# Fake shard: records its env, hands raw coverage to the merge dir on success,
# fails when told to, and sleeps (until TERM) when told to.
cat >"$REPO/back-end/scripts/run-coverage.sh" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
index="${BACKEND_COVERAGE_SHARD%%/*}"
log="$FAKE_RECORD_DIR/shard-$index.env"
{
  echo "shard=$BACKEND_COVERAGE_SHARD"
  echo "ports=$BACKEND_COVERAGE_START_PORT-$BACKEND_COVERAGE_END_PORT"
  echo "priority=${BLACKBOX_TEST_PRIORITY_DOMAINS:-}"
  echo "abort=${BLACKBOX_TEST_ABORT_ON_PRIORITY_FAILURE:-}"
} >"$log"
child=""
trap 'echo terminated >>"$log"; [[ -z "$child" ]] || kill "$child" 2>/dev/null; exit 143' TERM
behaviour="$(eval echo "\${FAKE_SHARD_$index:-pass}")"
case "$behaviour" in
  fail) exit 1 ;;
  sleep)
    sleep 60 &
    child=$!
    wait "$child"
    ;;
esac
mkdir -p "$BACKEND_COVERAGE_MERGE_DIR"
echo "{}" >"$BACKEND_COVERAGE_MERGE_DIR/coverage-shard-$index.json"
FAKE
cat >"$REPO/bin/npx" <<'FAKE'
#!/usr/bin/env bash
echo "npx $*" >>"$FAKE_RECORD_DIR/npx.log"
exit "${FAKE_C8_EXIT:-0}"
FAKE
chmod +x "$REPO/back-end/scripts/run-coverage.sh" "$REPO/bin/npx"

RUNNER="$REPO/back-end/scripts/run-coverage-sharded.sh"
export PATH="$REPO/bin:$PATH" CONDUCTOR_PORT=40000
records() {
  rm -rf "$TMP/rec" && mkdir -p "$TMP/rec"
  export FAKE_RECORD_DIR="$TMP/rec"
}

# 1. Two shards pass -> merged check runs once and decides the exit.
records
bash "$RUNNER" 2 >"$TMP/out1" 2>&1 || fail "all-pass run failed: $(cat "$TMP/out1")"
grep -q 'shard=1/2' "$TMP/rec/shard-1.env" && grep -q 'shard=2/2' "$TMP/rec/shard-2.env" ||
  fail "shards did not receive distinct indices"
[[ "$(sed -n 's/^ports=//p' "$TMP/rec/shard-1.env")" != "$(sed -n 's/^ports=//p' "$TMP/rec/shard-2.env")" ]] ||
  fail "shards share a port range"
grep -q -- '--check-coverage' "$TMP/rec/npx.log" || fail "merged threshold check did not run"
[[ ! -e "$REPO/back-end/coverage/tmp-merged" ]] || fail "merge dir left behind after success"
records
FAKE_C8_EXIT=1 bash "$RUNNER" 2 >"$TMP/out1b" 2>&1 && fail "merged threshold failure did not fail the gate"

# 2. One shard fails -> gate fails, no merged check, passing raw archived.
records
cd "$REPO"
FAKE_SHARD_1=fail bash "$RUNNER" 2 >"$TMP/out2" 2>&1 && fail "failed shard did not fail the gate"
[[ ! -e "$TMP/rec/npx.log" ]] || fail "merged check ran despite a failed shard"
[[ ! -e "$REPO/back-end/coverage/tmp-merged" ]] || fail "merge dir blocks the next run"
ls "$REPO"/.context/test-runs/backend-coverage-merged-failed-*/raw-v8/coverage-shard-2.json >/dev/null 2>&1 ||
  fail "passing shard's raw coverage was not archived"

# 3. Failed-first: previous failures become priority domains; a repeated
#    failure stops the sleeping sibling promptly.
mkdir -p "$REPO/back-end/coverage/blackbox-run-shard1" "$REPO/back-end/coverage/blackbox-run-shard2"
echo '{"results":[{"domain":"code-preview","passed":false},{"domain":"health","passed":true}]}' \
  >"$REPO/back-end/coverage/blackbox-run-shard1/summary.json"
echo '{"results":[{"domain":"user-ui","passed":false},{"domain":"skipped","passed":false,"aborted":true}]}' \
  >"$REPO/back-end/coverage/blackbox-run-shard2/summary.json"
records
started=$SECONDS
FAKE_SHARD_1=fail FAKE_SHARD_2=sleep bash "$RUNNER" --failed-first 2 >"$TMP/out3" 2>&1 &&
  fail "failed-first repeated failure did not fail the gate"
elapsed=$((SECONDS - started))
((elapsed < 30)) || fail "failed-first waited for the sibling shard (${elapsed}s)"
grep -q 'priority=code-preview,user-ui' "$TMP/rec/shard-1.env" || fail "priority domains not exported: $(cat "$TMP/rec/shard-1.env")"
grep -q 'abort=1' "$TMP/rec/shard-2.env" || fail "abort-on-repeat not exported"
grep -q terminated "$TMP/rec/shard-2.env" || fail "sibling shard was not stopped"

echo "All backend coverage shard gate checks passed."
