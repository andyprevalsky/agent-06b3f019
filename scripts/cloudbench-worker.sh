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

# Own bootstrap as well as the final worker, so failed starts retain their logs.
if [ "${CLOUDBENCH_WORKER_SUPERVISED:-}" != "1" ]; then
    exec python3 "${CLOUDBENCH_WORKER_EVIDENCE_HELPER:?worker evidence helper required}" \
        run --run-token "${CLOUDBENCH_WORKER_RUN_TOKEN:?worker run token required}" \
        --machine-id "${CLOUDBENCH_WORKER_MACHINE_ID:?worker machine identity required}" \
        -- bash "${BASH_SOURCE[0]}" "$@"
fi

REPO_DIR="/data/repo"
APP_USER="rose"
CONTROL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
[ -d "$CONTROL_DIR/lib" ] && CONTROL_LIB_DIR="$CONTROL_DIR/lib" || CONTROL_LIB_DIR="$CONTROL_DIR"
FETCH_REF_SCRIPT="${CLOUDBENCH_FETCH_REF_SCRIPT:-$CONTROL_DIR/cloudbench-fetch-ref.sh}"
ENV_HELPER="${CLOUDBENCH_ENV_HELPER:-$CONTROL_LIB_DIR/cloudbench-env.sh}"
log() { echo "[cloudbench-worker] $*"; }

# ── Sync the exact ref + local patch the primary box is running ─────────────
# Fail CLOSED: a worker on the wrong code would silently pull this bench's
# queue and run activities against stale sources — worse than no worker at
# all. Any checkout/patch mismatch is FATAL (the controller sees the machine's
# /data/worker.log and the pool just stays one worker short).
if [ -n "${REF:-}" ]; then
    log "git-syncing → $REF"
    if [ ! -x "$FETCH_REF_SCRIPT" ]; then
        log "FATAL: missing controller-owned executable cloudbench-fetch-ref helper"
        exit 1
    fi
    if ! CLOUDBENCH_APP_USER="$APP_USER" bash "$FETCH_REF_SCRIPT" "$REPO_DIR" "$REF" 2>&1 | sed 's/^/   /'; then
        log "FATAL: could not verify requested ref $REF"
        exit 1
    fi
fi
cd "$REPO_DIR" 2>/dev/null || { log "FATAL: no $REPO_DIR"; exit 1; }
# The controller credential is needed only for the exact ref fetch. Do not let
# it flow into the benchmark worker or agent subprocess environments.
unset CLOUDBENCH_GITHUB_TOKEN_B64
rm -f /tmp/rbw.env 2>/dev/null || true
# Autoscaled capacity is cloned from the active primary, whose tracked checkout
# already contains the uploaded worktree patch.  The exact-ref fetch helper has
# an intentional same-HEAD fast path, so it does not discard those tracked
# changes.  Restore only tracked files to the pinned commit before cleaning and
# applying the authoritative patch payload; otherwise a worker starts from a
# half-clean checkout and the second git-apply fails across every changed file.
if [ -n "${REF:-}" ]; then
    if ! gosu "$APP_USER" git -C "$REPO_DIR" restore \
        --source "$REF" --staged --worktree -- . 2>&1 | sed 's/^/   /'; then
        log "FATAL: could not restore tracked worker checkout to $REF"
        exit 1
    fi
fi
if ! gosu "$APP_USER" git -C "$REPO_DIR" clean -fd 2>&1 | sed 's/^/   /'; then
    log "FATAL: could not remove stale untracked worktree files"
    exit 1
fi
if [ -n "${LOCAL_PATCH_FILE:-}" ]; then
    [ -s "$LOCAL_PATCH_FILE" ] || {
        log "FATAL: declared local patch payload is missing or empty"
        exit 1
    }
    [ -n "${LOCAL_PATCH_SHA256:-}" ] || {
        log "FATAL: local patch payload has no checksum"
        exit 1
    }
    _actual_patch_sha="$(sha256sum "$LOCAL_PATCH_FILE" | awk '{print $1}')"
    [ "$_actual_patch_sha" = "$LOCAL_PATCH_SHA256" ] || {
        log "FATAL: patch payload checksum mismatch"
        exit 1
    }
    log "applying local workspace patch"
    if ! gosu "$APP_USER" git -C "$REPO_DIR" apply --whitespace=nowarn - \
        < "$LOCAL_PATCH_FILE" 2>&1 | sed 's/^/   /'; then
        log "FATAL: local workspace patch failed to apply — worker would run mismatched code"
        exit 1
    fi
    log "verified local workspace patch $_actual_patch_sha"
fi

# REAL workers on fresh storage reuse the same verified image dependency donor
# as the primary. Ref/patch verification precedes these manifest-bound helpers.
if [ "${CLOUDBENCH_FRESH_VOLUME:-0}" = 1 ]; then
    [ "${BENCH_SIMULATE:-0}" = 0 ] || { log "FATAL: fresh worker requires REAL mode"; exit 1; }
    SYNC_DEPS_SCRIPT="${CLOUDBENCH_SYNC_DEPS_SCRIPT:?fresh worker dependency helper required}"
    SYNC_PRISMA_SCRIPT="${CLOUDBENCH_SYNC_PRISMA_SCRIPT:?fresh worker Prisma helper required}"
    if ! bash "$SYNC_DEPS_SCRIPT" /app "$REPO_DIR"; then
        log "FATAL: could not synchronize verified image dependencies"
        exit 1
    fi
    chown -R "$APP_USER:$APP_USER" "$REPO_DIR/node_modules" "$REPO_DIR/back-end/node_modules" "$REPO_DIR/agents/venv" || exit 1
    if ! bash "$SYNC_PRISMA_SCRIPT" "$REPO_DIR" "$APP_USER"; then
        log "FATAL: could not synchronize verified Prisma client"
        exit 1
    fi
fi

# Every autoscaled worker clone starts from a volume snapshot that may predate
# the current run. Refresh from the app-level blobs and verify exact bytes before
# joining the benchmark queue.
[ -f "$ENV_HELPER" ] || { log "FATAL: missing $ENV_HELPER"; exit 1; }
# shellcheck source=lib/cloudbench-env.sh
source "$ENV_HELPER"
[ -n "${AGENTS_ENV_B64:-}" ] || { log "FATAL: AGENTS_ENV_B64 is not set"; exit 1; }
[ -n "${BACKEND_ENV_B64:-}" ] || { log "FATAL: BACKEND_ENV_B64 is not set"; exit 1; }
umask 077
printf '%s' "$AGENTS_ENV_B64" | base64 -d > "$REPO_DIR/agents/.env" || exit 1
printf '%s' "$BACKEND_ENV_B64" | base64 -d > "$REPO_DIR/back-end/.env" || exit 1
chown "$APP_USER:$APP_USER" "$REPO_DIR/agents/.env" "$REPO_DIR/back-end/.env"
chmod 600 "$REPO_DIR/agents/.env" "$REPO_DIR/back-end/.env"
cloudbench_verify_env_file "$REPO_DIR/agents/.env" "${AGENTS_ENV_SHA256:-}" agents || exit 1
cloudbench_verify_env_file "$REPO_DIR/back-end/.env" "${BACKEND_ENV_SHA256:-}" backend || exit 1
cloudbench_validate_browser_provider_contract \
    "$REPO_DIR/agents/.env" "$REPO_DIR/back-end/.env" \
    "${CLOUDBENCH_BROWSER_PROVIDER:-}" "${CLOUDBENCH_BROWSER_PROVIDER:-}" || exit 1

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
# The controller reads desired capacity only from the primary. A clone's queue
# observation would spend 3 shared Temporal Visibility API calls/s for nothing.
export AUTOSCALER_QUEUE_METRICS=0
export HEALTH_CHECK_PORT="$HEALTH_PORT"
export SDK_METRICS_PORT="$SDK_PORT"
export ENABLE_BENCHMARK_MEMORY_BASELINE=1
if [ "${BENCH_SIMULATE:-0}" = "1" ]; then
    export BENCHMARK_WORLD_MODEL_MODE="simulate"
    export WMH_BASE_URL="http://[$PRIMARY_HOST]:$WMH_PORT"
else
    export BENCHMARK_WORLD_MODEL_MODE="real"
fi

cd "$REPO_DIR/agents" || { log "FATAL: no agents dir"; exit 1; }
# Readiness is a post-patch, post-environment contract. The controller does not
# count this worker ready until this marker exists, and clears it before launch.
if [ -n "${WORKER_READY_FILE:-}" ]; then
    printf '%s\n' "$$" > "$WORKER_READY_FILE" || {
        log "FATAL: could not publish worker readiness"
        exit 1
    }
fi
log "worker-only → queue=$TEMPORAL_TASK_QUEUE backend=$BACKEND_URL sim=${BENCH_SIMULATE:-0}"
# Foreground: the machine lives as long as the worker does; the controller
# destroys it on scale-down / teardown.
exec gosu "$APP_USER" env \
    CONDUCTOR_WORKSPACE_NAME="$WORKSPACE_NAME" \
    TEMPORAL_TASK_QUEUE="$TEMPORAL_TASK_QUEUE" \
    BACKEND_URL="$BACKEND_URL" BACKEND_API_URL="$BACKEND_URL" \
    AUTOSCALER_ACTUATE=0 \
    AUTOSCALER_QUEUE_METRICS=0 \
    HEALTH_CHECK_PORT="$HEALTH_PORT" SDK_METRICS_PORT="$SDK_PORT" \
    BENCHMARK_WORLD_MODEL_MODE="${BENCHMARK_WORLD_MODEL_MODE}" \
    ${WMH_BASE_URL:+WMH_BASE_URL="$WMH_BASE_URL"} \
    ENABLE_BENCHMARK_MEMORY_BASELINE=1 \
    bash ./scripts/run_local_worker.sh
