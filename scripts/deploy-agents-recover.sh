#!/usr/bin/env bash
# Resume the saved worker-deployment FIFO head without rebuilding or enqueuing.
#
# deploy-agents.yml runs this right after a failed deploy (job `recover-failed`)
# and from its best-effort `schedule`. GitHub fires that schedule only every few
# hours, so it cannot be the only trigger after a failure (RCA
# 2026-11-15-deploy-agents-recover-relied-on-sparse-github-schedule).
#
# Every attempt goes through `worker-deployment-queue.ts run --if-idle`. Its
# global deployment lease, FIFO head and 600s failed-attempt cadence decide
# whether a cutover may start, so this never runs beside another controller.
# The loop waits out that cadence and stops after RECOVER_ATTEMPTS cutovers.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${APP:-$(sed -nE 's/^app = "([a-z0-9-]+)"/\1/p' "$ROOT/agents/fly.toml")}"
ATTEMPTS="${RECOVER_ATTEMPTS:-3}"
: "${APP:?APP is required}"
[[ "$ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || { echo "RECOVER_ATTEMPTS must be a positive integer" >&2; exit 2; }

cd "$ROOT/back-end"
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
queue() { node --import tsx scripts/worker-deployment-queue.ts "$@"; }
# Print one field of the last waiting record `run --if-idle` emitted. The
# child's own output shares stdout, so read the trailing JSON record.
waiting_field() {
  python3 -I - "$OUT" "$1" <<'PY'
import json, sys
for line in reversed(open(sys.argv[1], encoding="utf-8", errors="replace").read().splitlines()):
    try:
        record = json.loads(line)
    except ValueError:
        continue
    if isinstance(record, dict) and record.get("waiting") is True:
        print(record.get(sys.argv[2], ""))
    break
PY
}

cutovers=0
while :; do
  JOB_ID=$(queue head --app "$APP" | python3 -I -c '
import json, sys
job = json.load(sys.stdin)
print(job["jobId"] if job else "")')
  if [ -z "$JOB_ID" ]; then
    echo "No queued worker deployment for $APP"
    exit 0
  fi
  if [ "$cutovers" -ge "$ATTEMPTS" ]; then
    echo "FIFO head $JOB_ID still queued after $cutovers recovery cutover(s); the next deploy or schedule resumes it" >&2
    exit 1
  fi
  set +e
  queue run --job-id "$JOB_ID" --if-idle -- python3 "$ROOT/scripts/worker_pool_cutover.py" | tee "$OUT"
  code=${PIPESTATUS[0]}
  set -e
  reason=$(waiting_field reason)
  if [ "$code" -ne 0 ]; then
    cutovers=$((cutovers + 1))
    echo "Recovery cutover $cutovers/$ATTEMPTS of $JOB_ID exited $code" >&2
    continue
  fi
  case "$reason" in
    FAILED_ATTEMPT_CADENCE)
      retry_at=$(waiting_field retryAt)
      wait_seconds=$(( $(date -u -d "$retry_at" +%s) - $(date -u +%s) ))
      if [ "$wait_seconds" -gt 600 ]; then
        echo "Failed-attempt cadence retryAt $retry_at is more than 600s away" >&2
        exit 1
      fi
      echo "Waiting ${wait_seconds}s for the failed-attempt cadence of $JOB_ID (retryAt $retry_at)"
      [ "$wait_seconds" -le 0 ] || sleep "$wait_seconds"
      ;;
    GLOBAL_LEASE_BUSY)
      echo "Another controller holds the deployment lease; it owns $JOB_ID now"
      exit 0
      ;;
    "")
      echo "Recovered FIFO head $JOB_ID"
      exit 0
      ;;
    *)
      echo "Unexpected queue wait reason: $reason" >&2
      exit 1
      ;;
  esac
done
