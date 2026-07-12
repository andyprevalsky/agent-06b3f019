#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# cloudbench-worker.sh — a WORKER-ONLY node for a bench's autoscaling pool.
#
# run-bench-cloud's per-bench autoscaler clones idle warm boxes and launches this
# on each to add worker capacity for ONE bench. Unlike cloudbench-run.sh (which
# stands up a full isolated stack + runs the benchmark), this boots ONLY the
# Temporal worker and points it at the PRIMARY box's backend + the bench's queue,
# so the extra machine pulls that bench's queue and executes its activities — the
# same shape as prod's worker pool, but isolated to this bench by queue.
#
# It never actuates the Fly fleet (AUTOSCALER_ACTUATE=0): the controller is the
# sole scaler. The machine runs the worker in the foreground until the controller
# destroys it on scale-down / teardown.
#
# Injected env (by the controller wrapper): REF, LOCAL_PATCH_FILE, WORKSPACE_NAME,
# PRIMARY_HOST, BACKEND_PORT, WMH_PORT, BENCH_SIMULATE, HEALTH_PORT, SDK_PORT.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO_DIR="/data/repo"
APP_USER="rose"
log() { echo "[cloudbench-worker] $*"; }

cd "$REPO_DIR" 2>/dev/null || { log "FATAL: no $REPO_DIR"; exit 1; }

# ── Sync the exact ref + local patch the primary box is running ─────────────
# Fail CLOSED: a worker on the wrong code would silently pull this bench's
# queue and run activities against stale sources — worse than no worker at
# all. Any checkout/patch mismatch is FATAL (the controller sees the machine's
# /data/worker.log and the pool just stays one worker short).
if [ -n "${REF:-}" ]; then
    log "git-syncing → $REF"
    REF_FETCHED=1
    if ! gosu "$APP_USER" git -C "$REPO_DIR" fetch origin "$REF" 2>&1 | sed 's/^/   /'; then
        REF_FETCHED=0
        gosu "$APP_USER" git -C "$REPO_DIR" fetch origin 2>&1 | sed 's/^/   /' || \
            log "WARN: git fetch failed — trying checkout from the existing clone"
    fi
    if ! gosu "$APP_USER" git -C "$REPO_DIR" checkout -f "$REF" 2>&1 | sed 's/^/   /'; then
        # A bare sha that was just fetched lands in FETCH_HEAD — but FETCH_HEAD
        # only points at $REF when the ref-specific fetch succeeded; otherwise
        # it would silently check out some OTHER head (= wrong code).
        if [ "$REF_FETCHED" != "1" ] || \
           ! gosu "$APP_USER" git -C "$REPO_DIR" checkout -f FETCH_HEAD 2>&1 | sed 's/^/   /'; then
            log "FATAL: could not check out $REF — refusing to run this bench's queue on wrong code"
            exit 1
        fi
    fi
    gosu "$APP_USER" git -C "$REPO_DIR" reset --hard 2>&1 | sed 's/^/   /' || true
fi
if [ -n "${LOCAL_PATCH_FILE:-}" ] && [ -s "$LOCAL_PATCH_FILE" ]; then
    log "applying local workspace patch"
    if ! gosu "$APP_USER" git -C "$REPO_DIR" apply --whitespace=nowarn "$LOCAL_PATCH_FILE" 2>&1 | sed 's/^/   /'; then
        log "FATAL: local workspace patch failed to apply — worker would run mismatched code"
        exit 1
    fi
fi

# ── Point the worker at the primary box's backend + the bench's queue ───────
PRIMARY_HOST="${PRIMARY_HOST:?PRIMARY_HOST required}"
BACKEND_PORT="${BACKEND_PORT:-3001}"
WMH_PORT="${WMH_PORT:-3007}"
WORKSPACE_NAME="${WORKSPACE_NAME:?WORKSPACE_NAME required}"
HEALTH_PORT="${HEALTH_PORT:-3103}"   # distinct from the primary's 3003
SDK_PORT="${SDK_PORT:-9190}"

# Fly 6PN: the primary is reachable at its private IPv6 (bracketed in URLs).
BACKEND_URL="http://[$PRIMARY_HOST]:$BACKEND_PORT"

export ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1
export CONDUCTOR_WORKSPACE_NAME="$WORKSPACE_NAME"
export TEMPORAL_TASK_QUEUE="navi-agent-tasks-$WORKSPACE_NAME"
export BACKEND_URL BACKEND_API_URL="$BACKEND_URL"
export AUTOSCALER_ACTUATE=0            # controller is the sole scaler
export HEALTH_CHECK_PORT="$HEALTH_PORT"
export SDK_METRICS_PORT="$SDK_PORT"
export ENABLE_BENCHMARK_MEMORY_BASELINE=1
if [ "${BENCH_SIMULATE:-0}" = "1" ]; then
    export BENCHMARK_WORLD_MODEL_MODE="simulate"
    export WMH_BASE_URL="http://[$PRIMARY_HOST]:$WMH_PORT"
else
    export BENCHMARK_WORLD_MODEL_MODE="real"
fi

log "worker-only → queue=$TEMPORAL_TASK_QUEUE backend=$BACKEND_URL sim=${BENCH_SIMULATE:-0}"
cd "$REPO_DIR/agents" || { log "FATAL: no agents dir"; exit 1; }
# Foreground: the machine lives as long as the worker does; the controller
# destroys it on scale-down / teardown.
exec gosu "$APP_USER" env \
    CONDUCTOR_WORKSPACE_NAME="$WORKSPACE_NAME" \
    TEMPORAL_TASK_QUEUE="$TEMPORAL_TASK_QUEUE" \
    BACKEND_URL="$BACKEND_URL" BACKEND_API_URL="$BACKEND_URL" \
    AUTOSCALER_ACTUATE=0 \
    HEALTH_CHECK_PORT="$HEALTH_PORT" SDK_METRICS_PORT="$SDK_PORT" \
    BENCHMARK_WORLD_MODEL_MODE="${BENCHMARK_WORLD_MODEL_MODE}" \
    ${WMH_BASE_URL:+WMH_BASE_URL="$WMH_BASE_URL"} \
    ENABLE_BENCHMARK_MEMORY_BASELINE=1 \
    bash ./scripts/run_local_worker.sh
