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
#      when every shard passed, and its exit status is the gate's;
#   4. the REAL blackbox runner (back-end/src/tests/blackbox/run.ts, run against
#      fake domain files) keeps failed-first retries inside their phase: a
#      previously failed late-exclusive domain still runs only after the parallel
#      fixture writers, and an aborted sweep reports unrun domains as NOT RUN
#      failures (non-zero exit, aborted:true in summary.json).
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
  echo "unit_selector=${BACKEND_UNIT_TEST_FILES-unset}"
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
BACKEND_UNIT_TEST_FILES="stale-failed-only.test.ts" bash "$RUNNER" 2 >"$TMP/out1" 2>&1 || fail "all-pass run failed: $(cat "$TMP/out1")"
grep -q 'unit_selector=unset' "$TMP/rec/shard-1.env" &&
  grep -q 'unit_selector=unset' "$TMP/rec/shard-2.env" ||
  fail "full shards inherited the failed-only unit selector"
grep -q 'shard=1/2' "$TMP/rec/shard-1.env" && grep -q 'shard=2/2' "$TMP/rec/shard-2.env" ||
  fail "shards did not receive distinct indices"
[[ "$(sed -n 's/^ports=//p' "$TMP/rec/shard-1.env")" != "$(sed -n 's/^ports=//p' "$TMP/rec/shard-2.env")" ]] ||
  fail "shards share a port range"
grep -q -- '--check-coverage' "$TMP/rec/npx.log" || fail "merged threshold check did not run"
[[ ! -e "$REPO/back-end/coverage/tmp-merged" ]] || fail "merge dir left behind after success"
records
FAKE_C8_EXIT=1 bash "$RUNNER" 2 >"$TMP/out1b" 2>&1 && fail "merged threshold failure did not fail the gate"
ls "$REPO"/.context/test-runs/backend-coverage-merged-report-failed-*/raw-v8/coverage-shard-1.json >/dev/null 2>&1 ||
  fail "merged report failure deleted raw coverage"
[[ ! -e "$REPO/back-end/coverage/tmp-merged" ]] || fail "failed report leaves merge directory blocking retry"

# Interrupt a live coordinator after one shard has handed over raw coverage.
records
FAKE_SHARD_2=sleep bash "$RUNNER" 2 >"$TMP/out-interrupted" 2>&1 &
coordinator=$!
for _ in $(seq 1 200); do
  [[ -f "$REPO/back-end/coverage/tmp-merged/coverage-shard-1.json" && -f "$TMP/rec/shard-2.env" ]] && break
  sleep 0.01
done
kill -TERM "$coordinator"
interrupted=0
wait "$coordinator" || interrupted=$?
[[ "$interrupted" -eq 130 ]] || fail "interruption status changed ($interrupted)"
ls "$REPO"/.context/test-runs/backend-coverage-merged-interrupted-*/raw-v8/coverage-shard-1.json >/dev/null 2>&1 ||
  fail "interrupted coordinator did not preserve raw coverage"
[[ ! -e "$REPO/back-end/coverage/tmp-merged" ]] || fail "interruption leaves merge directory blocking retry"


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

# 4. Real runner, fake domains. `writer` is an ordinary pool domain and
#    `admin-health` is a real late-exclusive (whole-DB aggregate) name; both get
#    the same fake body that records start/end order and obeys FAKE_FAIL_<domain>.
RUNNER_REPO="$TMP/runner"
mkdir -p "$RUNNER_REPO/src/tests/blackbox"
cp "$ROOT_DIR/back-end/src/tests/blackbox/run.ts" "$RUNNER_REPO/src/tests/blackbox/run.ts"
# Domain children are spawned with `node --import tsx` from the runner's repo root.
ln -s "$ROOT_DIR/node_modules" "$RUNNER_REPO/node_modules"
cat >"$RUNNER_REPO/fake.ts" <<'FAKE'
import { appendFileSync } from 'node:fs';
const domain = process.env.BLACKBOX_TEST_DOMAIN as string;
const key = domain.replace(/-/g, '_');
appendFileSync(process.env.FAKE_ORDER_LOG as string, `start ${domain}\n`);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
appendFileSync(process.env.FAKE_ORDER_LOG as string, `end ${domain}\n`);
process.exit(process.env[`FAKE_FAIL_${key}`] === '1' ? 1 : 0);
FAKE
for domain in writer admin-health; do
  cp "$RUNNER_REPO/fake.ts" "$RUNNER_REPO/src/tests/blackbox/$domain.blackbox.ts"
done
run_real_runner() {
  rm -f "$TMP/order.log"
  (cd "$ROOT_DIR/back-end" && FAKE_ORDER_LOG="$TMP/order.log" \
    node --import tsx "$RUNNER_REPO/src/tests/blackbox/run.ts" writer,admin-health)
}
# 4a. A previously failed late-exclusive domain must still run after the pool.
BLACKBOX_TEST_PRIORITY_DOMAINS=admin-health BLACKBOX_TEST_ARTIFACT_DIR="$TMP/art-a" \
  run_real_runner >"$TMP/out4a" 2>&1 || fail "real runner failed on passing fake domains: $(cat "$TMP/out4a")"
[[ "$(tr '\n' ' ' <"$TMP/order.log")" == "start writer end writer start admin-health end admin-health " ]] ||
  fail "failed-first moved the late-exclusive domain before the fixture writers: $(tr '\n' ' ' <"$TMP/order.log")"
grep -q '"aborted": false' "$TMP/art-a/summary.json" || fail "summary.json lacks aborted flags"
# 4b. A repeated priority failure aborts the sweep: unrun domains are NOT RUN
#     failures, the runner exits non-zero and records aborted:true.
if FAKE_FAIL_writer=1 BLACKBOX_TEST_PRIORITY_DOMAINS=writer BLACKBOX_TEST_ABORT_ON_PRIORITY_FAILURE=1 \
  BLACKBOX_TEST_ARTIFACT_DIR="$TMP/art-b" run_real_runner >"$TMP/out4b" 2>&1; then
  fail "aborted sweep exited 0"
fi
grep -q 'PRIORITY FAILURE: writer failed again' "$TMP/out4b" || fail "repeated priority failure not announced"
grep -q 'NOT RUN  admin-health' "$TMP/out4b" || fail "unscheduled domain not reported as NOT RUN: $(cat "$TMP/out4b")"
grep -q '1 failed, 1 not run, 2 total' "$TMP/out4b" || fail "NOT RUN domain not counted separately from failures"
[[ "$(tr '\n' ' ' <"$TMP/order.log")" == "start writer end writer " ]] || fail "aborted sweep still ran admin-health"
node -e '
  const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const byDomain = Object.fromEntries(s.results.map((r) => [r.domain, r]));
  if (byDomain["admin-health"].aborted !== true || byDomain["admin-health"].passed !== false) process.exit(1);
  if (byDomain.writer.aborted !== false || byDomain.writer.passed !== false) process.exit(1);
' "$TMP/art-b/summary.json" || fail "summary.json does not record the aborted domain as an unpassed NOT RUN"

echo "All backend coverage shard gate checks passed."
