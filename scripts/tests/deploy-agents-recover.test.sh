#!/usr/bin/env bash
# Regression for RCA 2026-11-15-deploy-agents-recover-relied-on-sparse-github-schedule.
# A failed deploy must start recovery itself, not wait hours for GitHub's
# best-effort schedule. Every recovery attempt must go through
# `worker-deployment-queue.ts run --if-idle` for the FIFO head, wait out the
# queue's failed-attempt cadence, and stay bounded.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/deploy-agents-recover.sh"
WORKFLOW="$ROOT/.github/workflows/deploy-agents.yml"
fail() { echo "FAIL: $*" >&2; exit 1; }
[ -f "$SCRIPT" ] || fail "missing failure-triggered recovery entry point $SCRIPT"

python3 -I - "$WORKFLOW" <<'PY'
import sys
import yaml

config = yaml.load(open(sys.argv[1]), Loader=yaml.BaseLoader)
jobs = config["jobs"]
recover = jobs["recover"]
condition = " ".join(recover["if"].split())
assert recover.get("needs") == "deploy", "recovery must follow the deploy job it recovers"
assert condition == (
    "always() && (github.event_name == 'schedule' || needs.deploy.result == 'failure')"
), f"recovery must start on a failed deploy, not only on the sparse schedule: {condition}"
assert jobs["deploy"]["if"] == "github.event_name != 'schedule'", jobs["deploy"]["if"]
runs = [step.get("run", "") for step in recover["steps"]]
assert any("bash scripts/deploy-agents-recover.sh" in run for run in runs), runs
assert not any("worker-deployment-queue.ts run" in run for run in runs), \
    "the workflow must not bypass the recovery script's --if-idle loop"
assert recover["concurrency"]["cancel-in-progress"] == "false"
PY
grep -q 'queue run --job-id "$JOB_ID" --if-idle --' "$SCRIPT" ||
  fail "every recovery cutover must go through run --if-idle"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
# Fake `node`: only the queue CLI is invoked. Responses come from $SCENARIO.
cat > "$WORK/bin/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "$1 $2 $3" = "--import tsx scripts/worker-deployment-queue.ts" ] || { echo "unexpected node $*" >&2; exit 99; }
shift 3
echo "$*" >> "$CALLS"
runs=$(grep -c '^run ' "$CALLS" || true)
case "$SCENARIO:$1" in
  empty:head) echo null ;;
  *:head)
    if [ -e "$STATE/done" ]; then echo null; else echo '{"jobId":"job-head","failure":{"at":"x"}}'; fi ;;
  cadence:run)
    if [ "$runs" -eq 1 ]; then
      echo '{"waiting":true,"requestedJobId":"job-head","predecessorJobId":"job-head","reason":"FAILED_ATTEMPT_CADENCE","retryAt":"'"$(date -u -d '+1 second' +%Y-%m-%dT%H:%M:%S.000Z)"'"}'
    else
      echo '{"requestedJobId":"job-head","runningJobId":"job-head","recoveringPredecessor":false}'
      echo 'child cutover log line {not json'
      echo '{"jobId":"job-head","stage":"SUCCEEDED"}'
      touch "$STATE/done"
    fi ;;
  failing:run)
    echo '{"requestedJobId":"job-head","runningJobId":"job-head","recoveringPredecessor":false}'
    exit 1 ;;
  busy:run) echo '{"waiting":true,"requestedJobId":"job-head","reason":"GLOBAL_LEASE_BUSY"}' ;;
  far:run)
    echo '{"waiting":true,"requestedJobId":"job-head","reason":"FAILED_ATTEMPT_CADENCE","retryAt":"'"$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%S.000Z)"'"}' ;;
  *) echo "unexpected $SCENARIO $*" >&2; exit 98 ;;
esac
SH
chmod +x "$WORK/bin/node"

scenario() {
  local name=$1 attempts=$2
  rm -rf "$WORK/$name"; mkdir -p "$WORK/$name"
  set +e
  PATH="$WORK/bin:$PATH" SCENARIO="$name" CALLS="$WORK/$name/calls" STATE="$WORK/$name" \
    APP=test-app RECOVER_ATTEMPTS="$attempts" bash "$SCRIPT" > "$WORK/$name/out" 2>&1
  echo $? > "$WORK/$name/code"
  set -e
  touch "$WORK/$name/calls"
}
expect() {
  local name=$1 code=$2 runs=$3 text=$4
  [ "$(cat "$WORK/$name/code")" = "$code" ] || fail "$name exit $(cat "$WORK/$name/code") != $code: $(cat "$WORK/$name/out")"
  [ "$(grep -c '^run ' "$WORK/$name/calls" || true)" = "$runs" ] || fail "$name run calls: $(cat "$WORK/$name/calls")"
  grep -q -- "$text" "$WORK/$name/out" || fail "$name output lacks '$text': $(cat "$WORK/$name/out")"
  if grep '^run ' "$WORK/$name/calls" | grep -qv -- '^run --job-id job-head --if-idle -- python3 '; then
    fail "$name ran a cutover outside run --if-idle on the FIFO head: $(cat "$WORK/$name/calls")"
  fi
}

# A just-failed head: wait out the cadence, then resume it once.
start=$(date +%s)
scenario cadence 3
expect cadence 0 2 "Recovered FIFO head job-head"
grep -qE "Waiting -?[0-9]+s for the failed-attempt cadence of job-head" "$WORK/cadence/out" ||
  fail "cadence wait not reported: $(cat "$WORK/cadence/out")"
[ $(( $(date +%s) - start )) -lt 30 ] || fail "cadence wait overslept"
# A head that keeps failing: bounded attempts, loud failure.
scenario failing 2
expect failing 1 2 "still queued after 2 recovery cutover(s)"
# Another controller owns the lease: never start a second cutover.
scenario busy 3
expect busy 0 1 "Another controller holds the deployment lease"
# Nothing queued: no cutover.
scenario empty 3
expect empty 0 0 "No queued worker deployment for test-app"
# A cadence beyond the queue's 600s contract is refused, not slept on.
scenario far 3
expect far 1 1 "more than 600s away"
echo "PASS deploy-agents-recover"
