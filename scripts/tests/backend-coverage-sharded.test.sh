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
#      failures (non-zero exit, aborted:true in summary.json);
#   8. the unit pass runs beside the shards and the fps probe alone: every
#      blackbox shard skips units; the unit pass (BACKEND_COVERAGE_UNIT_PASS=1,
#      its own port pair, every unit file except rose-ui-cli-browser.test.ts via
#      BACKEND_UNIT_EXCLUDE_FILES) starts with the shards; the probe pass
#      (label `probe`, BACKEND_UNIT_TEST_FILES=rose-ui-cli-browser.test.ts)
#      starts only after every shard AND the unit pass ended; both hand raw
#      coverage to the merge directory and fail the gate on their own; a
#      failed-first abort stops the unit pass and skips the probe (the fps
#      probe starved beside two blackbox streams, 2026-10-30; the full unit
#      suite then waited 12.7 min after the shards on #1639).
#  10. the REAL unit runner's selection (run-unit-tests.ts --list) honours
#      BACKEND_UNIT_EXCLUDE_FILES / BACKEND_UNIT_TEST_FILES and refuses unknown
#      entries, so the probe is excluded from the concurrent pass and is the
#      only file of the serial pass.
set -euo pipefail

# This fixture owns its heap inputs: the default scenario starts without caller
# overrides; the custom-options/heap case below supplies both explicitly.
unset NODE_OPTIONS BACKEND_COVERAGE_REPORT_HEAP_MB

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
cp "$ROOT_DIR/back-end/scripts/coverage-shard-durations.mjs" "$REPO/back-end/scripts/"
cp "$ROOT_DIR/back-end/scripts/coverage-report-heap.sh" "$REPO/back-end/scripts/"

# Fake shard: records its env, hands raw coverage to the merge dir on success,
# fails when told to, and sleeps (until TERM) when told to.
cat >"$REPO/back-end/scripts/run-coverage.sh" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${BACKEND_COVERAGE_UNIT_PASS:-0}" == "1" ]]; then index="units${BACKEND_COVERAGE_UNIT_PASS_LABEL:+-$BACKEND_COVERAGE_UNIT_PASS_LABEL}"; else index="${BACKEND_COVERAGE_SHARD%%/*}"; fi
log="$FAKE_RECORD_DIR/shard-$index.env"
{
  echo "shard=${BACKEND_COVERAGE_SHARD:-}"
  echo "ports=$BACKEND_COVERAGE_START_PORT-$BACKEND_COVERAGE_END_PORT"
  echo "priority=${BLACKBOX_TEST_PRIORITY_DOMAINS:-}"
  echo "abort=${BLACKBOX_TEST_ABORT_ON_PRIORITY_FAILURE:-}"
  echo "durations=${BACKEND_COVERAGE_SHARD_DURATIONS:-}"
  echo "unit_selector=${BACKEND_UNIT_TEST_FILES-unset}"
  echo "unit_exclude=${BACKEND_UNIT_EXCLUDE_FILES-unset}"
  echo "unit_label=${BACKEND_COVERAGE_UNIT_PASS_LABEL-unset}"
  echo "skip_units=${BACKEND_COVERAGE_SKIP_UNITS:-}"
  echo "unit_pass=${BACKEND_COVERAGE_UNIT_PASS:-}"
  echo "started=$(date +%s%N)"
} >"$log"
child=""
trap 'echo terminated >>"$log"; [[ -z "$child" ]] || kill "$child" 2>/dev/null; exit 143' TERM
behaviour="$(eval echo "\${FAKE_SHARD_${index//-/_}:-pass}")"
# A shard takes a moment so a unit pass started too early would overlap it.
sleep 0.2
case "$behaviour" in
  fail) echo "ended=$(date +%s%N)" >>"$log"; exit 1 ;;
  sleep)
    sleep 60 &
    child=$!
    wait "$child"
    ;;
esac
mkdir -p "$BACKEND_COVERAGE_MERGE_DIR"
echo "{}" >"$BACKEND_COVERAGE_MERGE_DIR/coverage-shard-$index.json"
echo "ended=$(date +%s%N)" >>"$log"
# Like the real shard, publish this run's blackbox summary (seeded by the test).
if [[ -n "${FAKE_SUMMARY_DIR:-}" && -f "$FAKE_SUMMARY_DIR/shard-$index.json" ]]; then
  mkdir -p "$(dirname "$0")/../coverage/blackbox-run-shard$index"
  cp "$FAKE_SUMMARY_DIR/shard-$index.json" "$(dirname "$0")/../coverage/blackbox-run-shard$index/summary.json"
fi
FAKE
cat >"$REPO/bin/npx" <<'FAKE'
#!/usr/bin/env bash
echo "npx $*" >>"$FAKE_RECORD_DIR/npx.log"
echo "NODE_OPTIONS=${NODE_OPTIONS:-}" >>"$FAKE_RECORD_DIR/npx.log"
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
# 8. The unit pass runs beside the blackbox shards (fps probe excluded); the
#    probe runs alone after every shard and the unit pass.
PROBE="rose-ui-cli-browser.test.ts"
grep -q '^skip_units=1$' "$TMP/rec/shard-1.env" && grep -q '^skip_units=1$' "$TMP/rec/shard-2.env" ||
  fail "blackbox shards must skip the unit suite: $(cat "$TMP/rec/shard-1.env")"
[[ -f "$TMP/rec/shard-units.env" ]] || fail "the unit pass did not run"
grep -q '^unit_pass=1$' "$TMP/rec/shard-units.env" && grep -q '^shard=$' "$TMP/rec/shard-units.env" &&
  grep -q '^skip_units=$' "$TMP/rec/shard-units.env" && grep -q '^unit_selector=unset$' "$TMP/rec/shard-units.env" &&
  grep -q "^unit_exclude=$PROBE$" "$TMP/rec/shard-units.env" && grep -q '^unit_label=unset$' "$TMP/rec/shard-units.env" ||
  fail "the unit pass must run every unit file except the fps probe as an unlabelled non-shard: $(cat "$TMP/rec/shard-units.env")"
grep -q '^ports=40020-40021$' "$TMP/rec/shard-units.env" || fail "the unit pass must use the +20/+21 pair inside the declared footprint: $(cat "$TMP/rec/shard-units.env")"
units_started="$(sed -n 's/^started=//p' "$TMP/rec/shard-units.env")"
units_ended="$(sed -n 's/^ended=//p' "$TMP/rec/shard-units.env")"
for i in 1 2; do
  shard_ended="$(sed -n 's/^ended=//p' "$TMP/rec/shard-$i.env")"
  [[ -n "$shard_ended" && "$units_started" -lt "$shard_ended" ]] ||
    fail "the unit pass must run beside blackbox shard $i (shard ended $shard_ended, units started $units_started)"
done
[[ -f "$TMP/rec/shard-units-probe.env" ]] || fail "the fps probe pass did not run"
grep -q '^unit_pass=1$' "$TMP/rec/shard-units-probe.env" && grep -q '^shard=$' "$TMP/rec/shard-units-probe.env" &&
  grep -q "^unit_selector=$PROBE$" "$TMP/rec/shard-units-probe.env" && grep -q '^unit_label=probe$' "$TMP/rec/shard-units-probe.env" &&
  grep -q '^unit_exclude=unset$' "$TMP/rec/shard-units-probe.env" ||
  fail "the probe pass must select only the fps probe under the probe label: $(cat "$TMP/rec/shard-units-probe.env")"
grep -q '^ports=40020-40021$' "$TMP/rec/shard-units-probe.env" || fail "the probe pass reuses the unit pass's port pair once it is free: $(cat "$TMP/rec/shard-units-probe.env")"
probe_started="$(sed -n 's/^started=//p' "$TMP/rec/shard-units-probe.env")"
[[ -n "$units_ended" && "$probe_started" -gt "$units_ended" ]] ||
  fail "the fps probe overlapped the unit pass (units ended $units_ended, probe started $probe_started)"
for i in 1 2; do
  shard_ended="$(sed -n 's/^ended=//p' "$TMP/rec/shard-$i.env")"
  [[ -n "$shard_ended" && "$probe_started" -gt "$shard_ended" ]] ||
    fail "the fps probe overlapped blackbox shard $i (shard ended $shard_ended, probe started $probe_started)"
done
grep -q 'Started the unit pass beside the shards' "$TMP/out1" || fail "the concurrent unit pass must be announced: $(cat "$TMP/out1")"
grep -q 'running the fps probe alone' "$TMP/out1" || fail "the serial probe pass must be announced: $(cat "$TMP/out1")"
# 9. The report step raises node's heap ceiling itself (the in-memory c8 merge
#    of the full sweep died at the default heap, 2026-10-30), keeping any
#    NODE_OPTIONS the caller set; the unsharded script uses the same helper.
grep -q '^NODE_OPTIONS=--max-old-space-size=6144$' "$TMP/rec/npx.log" || fail "merged c8 report must run with the raised heap: $(cat "$TMP/rec/npx.log")"
records
NODE_OPTIONS="--trace-warnings" BACKEND_COVERAGE_REPORT_HEAP_MB=4096 bash "$RUNNER" 2 >"$TMP/out9" 2>&1 || fail "heap override run failed: $(cat "$TMP/out9")"
grep -q '^NODE_OPTIONS=--trace-warnings --max-old-space-size=4096$' "$TMP/rec/npx.log" || fail "the heap option must append to the caller's NODE_OPTIONS and honour the override: $(cat "$TMP/rec/npx.log")"
records
BACKEND_COVERAGE_REPORT_HEAP_MB=lots bash "$RUNNER" 2 >"$TMP/out9b" 2>&1 && fail "a malformed heap override must be refused"
[[ ! -e "$TMP/rec/shard-1.env" ]] || fail "a malformed heap override must be refused before any shard runs"
[[ ! -e "$REPO/back-end/coverage/tmp-merged" ]] || fail "a refused heap override must not leave the merge dir behind"
RC_UNSHARDED="$ROOT_DIR/back-end/scripts/run-coverage.sh"
[ "$(grep -c 'coverage_report_node npx c8 report' "$RC_UNSHARDED")" = 2 ] || fail "run-coverage.sh must run both c8 report invocations through coverage_report_node"
grep -q 'source "$SCRIPT_DIR/coverage-report-heap.sh"' "$RC_UNSHARDED" || fail "run-coverage.sh must source the shared heap helper"
records
FAKE_C8_EXIT=1 bash "$RUNNER" 2 >"$TMP/out1b" 2>&1 && fail "merged threshold failure did not fail the gate"
ls "$REPO"/.context/test-runs/backend-coverage-merged-report-failed-*/raw-v8/coverage-shard-1.json >/dev/null 2>&1 ||
  fail "merged report failure deleted raw coverage"
ls "$REPO"/.context/test-runs/backend-coverage-merged-report-failed-*/raw-v8/coverage-shard-units.json >/dev/null 2>&1 ||
  fail "the unit pass's raw coverage was not handed to the merge directory"
ls "$REPO"/.context/test-runs/backend-coverage-merged-report-failed-*/raw-v8/coverage-shard-units-probe.json >/dev/null 2>&1 ||
  fail "the fps probe pass's raw coverage was not handed to the merge directory"
# A failing unit pass fails the gate on its own: no merged check, raw archived, retry named.
records
FAKE_SHARD_units=fail bash "$RUNNER" 2 >"$TMP/out8" 2>&1 && fail "a failed unit pass did not fail the gate"
grep -q 'Unit pass failed' "$TMP/out8" || fail "unit pass failure not reported: $(cat "$TMP/out8")"
grep -q 'Retry: bash scripts/run-coverage-sharded.sh --failed-first 2' "$TMP/out8" || fail "retry hint missing after a unit failure"
[[ ! -e "$TMP/rec/npx.log" ]] || fail "merged check ran despite a failed unit pass"
[[ ! -e "$REPO/back-end/coverage/tmp-merged" ]] || fail "failed unit pass leaves the merge dir blocking retry"
ls "$REPO"/.context/test-runs/backend-coverage-merged-failed-*/raw-v8/coverage-shard-2.json >/dev/null 2>&1 ||
  fail "passing shards' raw coverage was not archived after a unit failure"
[[ -f "$TMP/rec/shard-units-probe.env" ]] || fail "a plain sweep must still run the fps probe after a failed unit pass so one run reports every failure"
# A failing fps probe fails the gate on its own too.
records
FAKE_SHARD_units_probe=fail bash "$RUNNER" 2 >"$TMP/out8b" 2>&1 && fail "a failed fps probe did not fail the gate"
grep -q 'fps probe pass failed' "$TMP/out8b" || fail "probe failure not reported: $(cat "$TMP/out8b")"
[[ ! -e "$TMP/rec/npx.log" ]] || fail "merged check ran despite a failed fps probe"
[[ ! -e "$REPO/back-end/coverage/tmp-merged" ]] || fail "failed probe leaves the merge dir blocking retry"
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
[[ -f "$TMP/rec/shard-units.env" ]] || fail "a plain sweep must still run the unit pass after a failed shard so one run reports every failure"
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
FAKE_SHARD_1=fail FAKE_SHARD_2=sleep FAKE_SHARD_units=sleep bash "$RUNNER" --failed-first 2 >"$TMP/out3" 2>&1 &&
  fail "failed-first repeated failure did not fail the gate"
elapsed=$((SECONDS - started))
((elapsed < 30)) || fail "failed-first waited for the sibling shard (${elapsed}s)"
grep -q 'priority=code-preview,user-ui' "$TMP/rec/shard-1.env" || fail "priority domains not exported: $(cat "$TMP/rec/shard-1.env")"
grep -q 'abort=1' "$TMP/rec/shard-2.env" || fail "abort-on-repeat not exported"
grep -q terminated "$TMP/rec/shard-2.env" || fail "sibling shard was not stopped"
grep -q terminated "$TMP/rec/shard-units.env" || fail "a failed-first abort must stop the concurrent unit pass"
[[ ! -e "$TMP/rec/shard-units-probe.env" ]] || fail "a failed-first abort must skip the fps probe"
grep -q 'the fps probe is skipped' "$TMP/out3" || fail "the skipped probe must be announced: $(cat "$TMP/out3")"

# 4. Real runner, fake domains. `writer` is an ordinary pool domain and
#    `admin-health` is a real late-exclusive (whole-DB aggregate) name; both get
#    the same fake body that records start/end order and obeys FAKE_FAIL_<domain>.
RUNNER_REPO="$TMP/runner"
mkdir -p "$RUNNER_REPO/src/tests/blackbox" "$RUNNER_REPO/src/tests/helpers"
cp "$ROOT_DIR/back-end/src/tests/blackbox/run.ts" "$RUNNER_REPO/src/tests/blackbox/run.ts"
# The runner's own module imports travel with it (its gate-progress reporter).
cp "$ROOT_DIR/back-end/src/tests/helpers/gateProgress.ts" "$RUNNER_REPO/src/tests/helpers/gateProgress.ts"
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

# 5. Timing-balanced shards: every sharded run records the shards' observed
#    domain durations into the per-worktree ledger (aborted domains are not
#    observations) and the next run hands that ledger to the shard planner,
#    unless an explicit BACKEND_COVERAGE_SHARD_DURATIONS wins.
LEDGER="$REPO/.context/deploy-durations/backend-blackbox.json"
rm -f "$LEDGER"
# A summary retained from an earlier run is not an observation of this run: the
# coordinator drops it before the shards start, so a shard that exits before
# its own preflight leaves nothing for the recorder.
mkdir -p "$REPO/back-end/coverage/blackbox-run-shard1" "$REPO/back-end/coverage/blackbox-run-shard2"
echo '{"results":[{"domain":"stale-domain","passed":true,"duration":999000}]}' \
  >"$REPO/back-end/coverage/blackbox-run-shard1/summary.json"
records
FAKE_SHARD_1=fail bash "$RUNNER" 2 >"$TMP/out5-stale" 2>&1 && fail "failed shard run exited 0"
# Raw coverage a killed shard left behind (a superseded pipeline attempt) is
# archived under .context/test-runs before the shards start; run-coverage.sh
# would otherwise refuse the new collection.
mkdir -p "$REPO/back-end/coverage/tmp-shard1" "$REPO/back-end/coverage/tmp-shard2"
echo '{"interrupted":true}' >"$REPO/back-end/coverage/tmp-shard1/raw.json"
records
bash "$RUNNER" 2 >"$TMP/out5-leftover" 2>&1 || fail "a run after an interrupted shard must proceed: $(cat "$TMP/out5-leftover")"
grep -q "Archived unrecovered raw coverage from an interrupted shard" "$TMP/out5-leftover" || fail "the archived leftover must be reported"
[ ! -e "$REPO/back-end/coverage/tmp-shard1/raw.json" ] || fail "interrupted raw coverage must be moved out of the shard's tmp dir"
[ -n "$(find "$REPO/.context/test-runs" -path '*backend-coverage-unrecovered-*/tmp-shard1/raw.json' -print -quit)" ] \
  || fail "interrupted raw coverage must be archived under .context/test-runs"
[ -d "$REPO/back-end/coverage/tmp-shard2" ] || fail "an empty leftover dir is not evidence and is left alone"
[[ ! -e "$REPO/back-end/coverage/blackbox-run-shard1/summary.json" ]] || fail "retained shard summary survived into the new run"
[[ ! -s "$LEDGER" ]] || { grep -q stale-domain "$LEDGER" && fail "stale summary was recorded as a current observation"; }
rm -f "$LEDGER"
# This run's shards publish their own summaries (seeded through the fake shard).
mkdir -p "$TMP/seed5"
echo '{"results":[{"domain":"code-preview","passed":true,"duration":250000},{"domain":"health","passed":true,"duration":900}]}' \
  >"$TMP/seed5/shard-1.json"
echo '{"results":[{"domain":"user-ui","passed":false,"duration":4000},{"domain":"skipped","passed":false,"aborted":true,"duration":0}]}' \
  >"$TMP/seed5/shard-2.json"
export FAKE_SUMMARY_DIR="$TMP/seed5"
records
bash "$RUNNER" 2 >"$TMP/out5" 2>&1 || fail "ledger run failed: $(cat "$TMP/out5")"
grep -q '^durations=$' "$TMP/rec/shard-1.env" || fail "first run must not use a ledger that did not exist yet"
[[ -s "$LEDGER" ]] || fail "shard durations were not recorded"
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).results;
  const m = new Map(r.map((x) => [x.domain, x.duration]));
  if (m.get("code-preview") !== 250000 || m.get("health") !== 900 || m.get("user-ui") !== 4000) process.exit(1);
  if (m.has("skipped")) process.exit(2);
' "$LEDGER" || fail "ledger content wrong: $(cat "$LEDGER")"
records
bash "$RUNNER" 2 >"$TMP/out5b" 2>&1 || fail "second ledger run failed: $(cat "$TMP/out5b")"
grep -q "^durations=$LEDGER$" "$TMP/rec/shard-2.env" || fail "recorded ledger not handed to the shards: $(cat "$TMP/rec/shard-2.env")"
records
BACKEND_COVERAGE_SHARD_DURATIONS=/explicit/summary.json bash "$RUNNER" 2 >"$TMP/out5c" 2>&1 || fail "explicit durations run failed"
grep -q '^durations=/explicit/summary.json$' "$TMP/rec/shard-1.env" || fail "explicit durations file must win"

# 6. The real shard planner packs by simulated shard wall: with one recorded
#    250 s domain every blackbox domain is still planned exactly once and the
#    heavy domain's shard takes fewer siblings than the other shard.
# Keep this simulation's inventory fixed: production domains and their serial
# phases can grow without changing the planner's wall-time contract. Retain the
# real runner's phase metadata and exercise the real planner against that input.
PLAN_REPO="$TMP/planner"
mkdir -p "$PLAN_REPO/scripts" "$PLAN_REPO/src/tests/blackbox"
cp "$ROOT_DIR/back-end/scripts/coverage-shard-plan.mjs" "$PLAN_REPO/scripts/"
cp "$ROOT_DIR/back-end/src/tests/blackbox/run.ts" "$PLAN_REPO/src/tests/blackbox/"
for domain in code-preview health user-ui fixture-pool-{01..12}; do
  : >"$PLAN_REPO/src/tests/blackbox/$domain.blackbox.ts"
done
PLAN="$PLAN_REPO/scripts/coverage-shard-plan.mjs"
plan() { BLACKBOX_TEST_CONCURRENCY=4 node "$PLAN" "$@"; }
(plan 1/2 "$LEDGER" >"$TMP/p1" && plan 2/2 "$LEDGER" >"$TMP/p2" &&
  plan 1/2 >"$TMP/q1" && plan 2/2 >"$TMP/q2") || fail "shard planner failed"
node -e '
  const fs = require("fs");
  const read = (p) => fs.readFileSync(p, "utf8").trim().split(",").filter(Boolean);
  const [p1, p2, q1, q2] = process.argv.slice(1).map(read);
  const all = [...q1, ...q2].sort();
  const expected = ["code-preview", "health", "user-ui",
    ...Array.from({ length: 12 }, (_, i) => `fixture-pool-${String(i + 1).padStart(2, "0")}`)].sort();
  if (JSON.stringify(all) !== JSON.stringify(expected)) { console.error("synthetic inventory differs"); process.exit(5); }
  const planned = [...p1, ...p2].sort();
  if (JSON.stringify(all) !== JSON.stringify(planned)) { console.error("planned set differs"); process.exit(1); }
  if (new Set(planned).size !== planned.length) { console.error("a domain was planned twice"); process.exit(2); }
  const [heavy, light] = p1.includes("code-preview") ? [p1, p2] : [p2, p1];
  if (heavy.length >= light.length) { console.error("heavy shard not relieved", heavy.length, light.length); process.exit(3); }
  // code-preview is serial (250 s). The other 14 domains need at most
  // 4 * 30 s on four workers, so adding any pool item to its shard makes
  // the projected wall worse. Ignoring the recorded weight must fail here.
  if (heavy.length !== 1) { console.error("heavy serial shard received parallel work", heavy); process.exit(4); }
' "$TMP/p1" "$TMP/p2" "$TMP/q1" "$TMP/q2" || fail "wall-aware shard plan is wrong"

# Keep real-inventory coverage too: every eligible production domain must be
# planned exactly once with and without duration history. Its changing mixture
# of parallel and exclusive domains implies no fixed shard-cardinality ratio.
REAL_PLAN="$ROOT_DIR/back-end/scripts/coverage-shard-plan.mjs"
(node "$REAL_PLAN" 1/2 "$LEDGER" >"$TMP/real-p1" && node "$REAL_PLAN" 2/2 "$LEDGER" >"$TMP/real-p2" &&
  node "$REAL_PLAN" 1/2 >"$TMP/real-q1" && node "$REAL_PLAN" 2/2 >"$TMP/real-q2") || fail "real-inventory shard planner failed"
node -e '
  const fs = require("fs");
  const skip = new Set((process.env.BLACKBOX_TEST_SKIP_DOMAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const expected = fs.readdirSync(process.argv[1]).filter((f) => f.endsWith(".blackbox.ts"))
    .map((f) => f.replace(/\.blackbox\.ts$/, "")).filter((d) => !skip.has(d)).sort();
  const read = (p) => fs.readFileSync(p, "utf8").trim().split(",").filter(Boolean);
  const [p1, p2, q1, q2] = process.argv.slice(2).map(read);
  for (const [label, planned] of [["weighted", [...p1, ...p2]], ["unweighted", [...q1, ...q2]]]) {
    if (new Set(planned).size !== planned.length) { console.error(`${label}: production domain planned twice`); process.exit(1); }
    if (JSON.stringify(planned.sort()) !== JSON.stringify(expected)) { console.error(`${label}: production inventory differs`); process.exit(2); }
  }
' "$ROOT_DIR/back-end/src/tests/blackbox" "$TMP/real-p1" "$TMP/real-p2" "$TMP/real-q1" "$TMP/real-q2" || fail "real-inventory shard coverage is wrong"

# 10. The real unit runner's selection: the coordinator excludes exactly the
#     fps probe from the concurrent pass and selects only it for the serial
#     pass; unknown entries on either list are refused before anything runs.
UNIT_RUNNER_LIST() { (cd "$ROOT_DIR/back-end" && BACKEND_UNIT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/unused "$@" node --import tsx scripts/run-unit-tests.ts --list); }
UNIT_RUNNER_LIST env >"$TMP/units-all" || fail "run-unit-tests.ts --list failed"
grep -qx "rose-ui-cli-browser.test.ts" "$TMP/units-all" || fail "the fps probe file must exist in the unit suite"
UNIT_RUNNER_LIST env BACKEND_UNIT_EXCLUDE_FILES=rose-ui-cli-browser.test.ts >"$TMP/units-excluded" || fail "--list with the exclusion failed"
grep -qx "rose-ui-cli-browser.test.ts" "$TMP/units-excluded" && fail "BACKEND_UNIT_EXCLUDE_FILES must drop the fps probe from the concurrent pass"
[[ "$(wc -l <"$TMP/units-excluded")" -eq $(( $(wc -l <"$TMP/units-all") - 1 )) ]] || fail "the exclusion must drop exactly one file"
[[ "$(UNIT_RUNNER_LIST env BACKEND_UNIT_TEST_FILES=rose-ui-cli-browser.test.ts)" == "rose-ui-cli-browser.test.ts" ]] || fail "the serial pass must select only the fps probe"
UNIT_RUNNER_LIST env BACKEND_UNIT_EXCLUDE_FILES=no-such-file.test.ts >/dev/null 2>&1 && fail "an unknown BACKEND_UNIT_EXCLUDE_FILES entry must be refused"
grep -q 'FPS_PROBE_FILE="rose-ui-cli-browser.test.ts"' "$ROOT_DIR/back-end/scripts/run-coverage-sharded.sh" || fail "run-coverage-sharded.sh must name the fps probe file"
grep -q 'BACKEND_UNIT_EXCLUDE_FILES="\$FPS_PROBE_FILE"' "$ROOT_DIR/back-end/scripts/run-coverage-sharded.sh" || fail "the concurrent unit pass must exclude the fps probe"
grep -q 'BACKEND_COVERAGE_UNIT_PASS_LABEL=probe' "$ROOT_DIR/back-end/scripts/run-coverage-sharded.sh" || fail "the serial probe pass must carry the probe label"

# 7. Sharding on the isolated deploy (system-PG) path: the prepared
#    BACKEND_COVERAGE_DATABASE_URL is the base; shard i/N owns `<base>_s<i>`
#    on the same server (one database per shard), the base is still validated
#    against the exact deploy marker, and run-coverage.sh derives it through
#    the helper instead of refusing shards (which forced the 2026-10-29 deploy
#    into one unsharded 1,505 s sweep).
HELPER="$ROOT_DIR/back-end/scripts/coverage-database-url.mjs"
WT="$TMP/deploy-wt"
mkdir -p "$WT/.context"
IDENT="agent-a0f677519b4ea0db3_90ed8ea3551a"
BASE_DB="victoria_deploy_agent_a0f677519b4ea0db3_90ed8ea3551a"
printf '%s\n' "$BASE_DB" >"$WT/.context/deploy-system-pg.db"
resolve() {  # <shard> [url]
  BACKEND_COVERAGE_DATABASE_URL="${2:-postgresql://postgres:postgres@localhost:5432/$BASE_DB}" \
    ROSE_DEPLOY_WORKTREE=1 ROSE_DEPLOY_WORKTREE_PATH="$WT" node "$HELPER" "$IDENT" "$WT" "$1"
}
[[ "$(resolve "" | sed -n 1p)" == "postgresql://postgres:postgres@localhost:5432/$BASE_DB" ]] || fail "unsharded prepared URL must resolve to itself"
[[ -z "$(resolve "" | sed -n 2p)" ]] || fail "unsharded run derives no database"
[[ "$(resolve 1/2 | sed -n 1p)" == "postgresql://postgres:postgres@localhost:5432/${BASE_DB}_s1" ]] || fail "shard 1/2 must own ${BASE_DB}_s1"
[[ "$(resolve 2/2 | sed -n 2p)" == "${BASE_DB}_s2" ]] || fail "shard 2/2 must own ${BASE_DB}_s2"
[[ "$(resolve 1/2)" != "$(resolve 2/2)" ]] || fail "shards must never share a database"
[[ "$(resolve units | sed -n 2p)" == "${BASE_DB}_s0" ]] || fail "the unit pass must own ${BASE_DB}_s0 (shards are numbered from 1)"
resolve 3/2 >/dev/null 2>&1 && fail "shard index above count must be refused"
resolve 1/2 "postgresql://postgres:postgres@localhost:5432/${BASE_DB}_s1" >/dev/null 2>&1 && fail "an already derived shard URL is not the prepared base"
resolve 1/2 "postgresql://postgres:postgres@localhost:5432/victoria_deploy_other" >/dev/null 2>&1 && fail "another worktree's database must be refused"
resolve 1/2 "postgresql://postgres:postgres@db.example.com:5432/$BASE_DB" >/dev/null 2>&1 && fail "a remote host must be refused"
printf 'victoria_deploy_someone_else\n' >"$WT/.context/deploy-system-pg.db"
resolve "" >/dev/null 2>&1 && fail "a marker naming another database must be refused"
printf '%s\n' "$BASE_DB" >"$WT/.context/deploy-system-pg.db"
# Shard-suffix space is reserved: a 45-character identity still yields a <= 63-byte shard database.
LONG_IDENT="agent-0123456789abcdef-0123456789ab-extra-long"
LONG_WT="$TMP/deploy-wt-long"; mkdir -p "$LONG_WT/.context"
LONG_SAFE="$(printf '%s' "$LONG_IDENT" | tr -c '[:alnum:]' '_')"
LONG_DB="victoria_deploy_${LONG_SAFE:0:30}_$(printf '%s' "$LONG_SAFE" | sha256sum | cut -c1-12)"
printf '%s\n' "$LONG_DB" >"$LONG_WT/.context/deploy-system-pg.db"
LONG_SHARD="$(BACKEND_COVERAGE_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/$LONG_DB" ROSE_DEPLOY_WORKTREE=1 ROSE_DEPLOY_WORKTREE_PATH="$LONG_WT" node "$HELPER" "$LONG_IDENT" "$LONG_WT" 2/2 | sed -n 2p)"
[[ "$LONG_SHARD" == "${LONG_DB}_s2" && "${#LONG_SHARD}" -le 63 ]] || fail "a long identity keeps its shard database within 63 bytes (got '$LONG_SHARD')"
grep -q '"${#safe}" -gt 43' "$ROOT_DIR/scripts/prepare-deploy-worktree.sh" || fail "prepare-deploy-worktree.sh must shorten long identities with a digest to reserve shard-suffix space"
# Two identities that share their first 43 characters get distinct databases (digest of the whole name).
TWIN_IDENT="${LONG_IDENT}-twin"
TWIN_SAFE="$(printf '%s' "$TWIN_IDENT" | tr -c '[:alnum:]' '_')"
TWIN_DB="victoria_deploy_${TWIN_SAFE:0:30}_$(printf '%s' "$TWIN_SAFE" | sha256sum | cut -c1-12)"
[ "$TWIN_DB" != "$LONG_DB" ] || fail "identities sharing a 43-character prefix must not share a deploy database"
TWIN_WT="$TMP/deploy-wt-twin"; mkdir -p "$TWIN_WT/.context"
printf '%s\n' "$TWIN_DB" >"$TWIN_WT/.context/deploy-system-pg.db"
[[ "$(BACKEND_COVERAGE_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/$TWIN_DB" ROSE_DEPLOY_WORKTREE=1 ROSE_DEPLOY_WORKTREE_PATH="$TWIN_WT" node "$HELPER" "$TWIN_IDENT" "$TWIN_WT" 1/2 | sed -n 2p)" == "${TWIN_DB}_s1" ]] \
  || fail "the resolver must derive the digest-shortened name for a twin identity"
BACKEND_COVERAGE_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/$LONG_DB" ROSE_DEPLOY_WORKTREE=1 ROSE_DEPLOY_WORKTREE_PATH="$TWIN_WT" node "$HELPER" "$TWIN_IDENT" "$TWIN_WT" 1/2 >/dev/null 2>&1 \
  && fail "a twin identity must not resolve to its sibling's database"
# An identity shaped like a shard name is refused on both paths (it could name another worktree's shard).
BACKEND_COVERAGE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_deploy_feature_s1 ROSE_DEPLOY_WORKTREE=1 ROSE_DEPLOY_WORKTREE_PATH="$WT" node "$HELPER" "feature-s1" "$WT" >/dev/null 2>&1 && fail "an identity ending in _s<digits> must be refused (isolated path)"
env -u ROSE_DEPLOY_WORKTREE -u ROSE_DEPLOY_WORKTREE_PATH BACKEND_COVERAGE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_ws_s1 node "$HELPER" "ws_s1" "$WT" 1/2 >/dev/null 2>&1 && fail "an identity ending in _s<digits> must be refused (generic path)"
grep -q '_s\[0-9\]' "$ROOT_DIR/scripts/prepare-deploy-worktree.sh" || fail "prepare-deploy-worktree.sh must refuse identities ending in _s<digits>"
# Generic (non-isolated) system-PG path keeps the workspace naming.
# (hermetic: a /deploy shell exports ROSE_DEPLOY_WORKTREE* for its own worktree; clear them for the generic case)
[[ "$(env -u ROSE_DEPLOY_WORKTREE -u ROSE_DEPLOY_WORKTREE_PATH BACKEND_COVERAGE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_myws node "$HELPER" myws "$WT" 2/3 | sed -n 2p)" == "victoria_myws_s2" ]] \
  || fail "generic workspace shards derive victoria_<ws>_s<i>"
[[ "$(env -u ROSE_DEPLOY_WORKTREE -u ROSE_DEPLOY_WORKTREE_PATH BACKEND_COVERAGE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_myws node "$HELPER" myws "$WT" units | sed -n 2p)" == "victoria_myws_s0" ]] \
  || fail "the generic unit pass derives victoria_<ws>_s0"
# run-coverage.sh binds to the helper and no longer refuses shards with a prepared URL.
RC="$ROOT_DIR/back-end/scripts/run-coverage.sh"
grep -q 'coverage-database-url.mjs" "\$WORKSPACE_HINT" "\$ROOT_DIR" "\$COVERAGE_DB_TOKEN"' "$RC" || fail "run-coverage.sh must resolve the prepared URL per shard (or unit pass) through the helper"
grep -q 'COVERAGE_DB_TOKEN="units"' "$RC" && grep -q 'SHARD_DB_SUFFIX="_s0"' "$RC" || fail "run-coverage.sh must give the unit pass the _s0 database on both database paths"
grep -q 'BACKEND_COVERAGE_SKIP_UNITS=1 \\' "$ROOT_DIR/back-end/scripts/run-coverage-sharded.sh" || fail "run-coverage-sharded.sh must launch blackbox-only shards"
grep -q 'BACKEND_COVERAGE_UNIT_PASS=1' "$ROOT_DIR/back-end/scripts/run-coverage-sharded.sh" || fail "run-coverage-sharded.sh must run the dedicated unit pass"
grep -q 'rm -f "\$BACKEND_DIR"/coverage/blackbox-run-shard\*/summary.json' "$ROOT_DIR/back-end/scripts/run-coverage-sharded.sh" || fail "run-coverage-sharded.sh must drop retained shard summaries before starting shards"
grep -q 'Coverage shards need one prepared database each' "$RC" && fail "run-coverage.sh must not refuse shards on the prepared-URL path"
grep -q 'ENSURE_SYSTEM_DB_NAME="\$COVERAGE_SHARD_DB_NAME"' "$RC" || fail "a derived shard database must be created through ensure_workspace_system_db"

echo "All backend coverage shard gate checks passed."
