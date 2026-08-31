#!/usr/bin/env bash
# k=5 pass@5 browser benchmark A/B: pre-sync (1ce6fd652) vs post-sync (HEAD)
set -eo pipefail

LABEL="${1:?usage: k5-browser-ab.sh <presync|postsync>}"
case "$LABEL" in
  presync|postsync) ;;
  *)
    echo "usage: k5-browser-ab.sh <presync|postsync>" >&2
    exit 1
    ;;
esac
ROOT="${2:-/workspace}"
LOG_DIR="/workspace/.context/k5-ab"
mkdir -p "$LOG_DIR"
# Collision-resistant run id: second stamp + pid + random so concurrent
# same-LABEL invocations never share log/meta/Temporal queue names.
STAMP="$(date +%Y%m%d_%H%M%S)_$$_${RANDOM}"
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
# Preserve caller HOME (macOS Codex ~/.codex/auth.json); default only when unset
# so cloud/ngrok still resolve under /home/ubuntu.
export HOME="${HOME:-/home/ubuntu}"
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
PIPE_ECS=("${PIPESTATUS[@]}")
BENCH_EC=${PIPE_ECS[0]:-1}
TEE_EC=${PIPE_ECS[1]:-0}
if [ "$BENCH_EC" -ne 0 ]; then
  EC=$BENCH_EC
elif [ "$TEE_EC" -ne 0 ]; then
  EC=$TEE_EC
else
  EC=0
fi
set -e

echo "finished_at=$(date -Is) exit_code=$EC" >>"$META"
echo "═══ DONE exit=$EC ═══" | tee -a "$LOG"
exit "$EC"
