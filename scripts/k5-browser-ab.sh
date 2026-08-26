#!/usr/bin/env bash
# k=5 pass@5 browser benchmark A/B: pre-sync (1ce6fd652) vs post-sync (HEAD)
set -eo pipefail

LABEL="${1:?usage: k5-browser-ab.sh <presync|postsync>}"
ROOT="${2:-/workspace}"
LOG_DIR="/workspace/.context/k5-ab"
mkdir -p "$LOG_DIR"
STAMP=$(date +%Y%m%d_%H%M%S)
LOG="$LOG_DIR/${LABEL}-k5-${STAMP}.log"
META="$LOG_DIR/${LABEL}-k5-${STAMP}.meta"

TASKS=(
  browser-1015-eventim-request-card
  browser-alchemy-springs-sauna
  browser-amazon-return
  browser-doordash-usb-c-cable
  browser-event-ticket
  browser-file-upload-tinypng
  browser-imax-group-tickets
)

REPEATED=()
for t in "${TASKS[@]}"; do
  for _ in 1 2 3 4 5; do
    REPEATED+=("$t")
  done
done

export ROSE_USE_SYSTEM_PG=true
export HOME=/home/ubuntu
export TEMPORAL_TASK_QUEUE="navi-agent-tasks-${LABEL}-k5-${STAMP}"

{
  echo "label=$LABEL"
  echo "root=$ROOT"
  echo "git_sha=$(git -C "$ROOT" rev-parse HEAD)"
  echo "git_branch=$(git -C "$ROOT" branch --show-current 2>/dev/null || echo detached)"
  echo "temporal_queue=$TEMPORAL_TASK_QUEUE"
  echo "task_count=${#REPEATED[@]}"
  echo "started_at=$(date -Is)"
} >"$META"

cd "$ROOT"
echo "═══ $LABEL k=5 browser suite (${#REPEATED[@]} runs, max-concurrency 5) ═══" | tee "$LOG"
echo "sha=$(git rev-parse HEAD) log=$LOG" | tee -a "$LOG"

set +e
bash scripts/run-bench --local --max-concurrency 5 "${REPEATED[@]}" 2>&1 | tee -a "$LOG"
EC=${PIPESTATUS[0]}
set -e

echo "finished_at=$(date -Is) exit_code=$EC" >>"$META"
echo "═══ DONE exit=$EC ═══" | tee -a "$LOG"
exit "$EC"
