#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# cloudbench-boot.sh — the on-box BOOT entrypoint for the warm cloud box.
#
# Lives on the /data VOLUME (staged once at --setup, so every snapshot clone has
# it). The controller sets it as the machine's `--command` and delivers the
# per-run parameters as machine `--env` at `flyctl machine update` time, then
# starts the box. The box then AUTO-RUNS the driver on boot with NO controller
# SSH at all — which is the whole point: the per-box launch-ssh burst
# (start + ssh-ready + clear-stale + stage + launch + confirm ≈ 7 ssh × N boxes)
# saturated Fly's Machines-API rate limit at fleet width and killed drivers at
# launch. Boot-launch replaces that entire burst with one `machine update`
# (env + command) + one `machine start` per box — no ssh — and the controller
# polls progress over the Fly DATA PLANE (flyctl proxy → the status server below).
#
# Inputs (all machine --env, set per-box by run-bench-cloud):
#   CLOUDBENCH_BOOT=1        REQUIRED to run the driver; absent → idle (warm/clone source)
#   CLOUDBENCH_RUN_TOKEN     run token the controller matches in the log
#   REF                      branch/sha to check out + run
#   CLOUDBENCH_STATUS_PORT   IPv6 status-service port serving /data (default 8011)
#   + every driver input (BENCH_TASKS_B64, BENCH_SIMULATE, WMH_MODEL_NAME,
#     CLOUDBENCH_START_BARRIER, …) — passed straight through to cloudbench-run.sh.
#
# Runs as the image's root CMD user. The driver drops to `rose` via gosu itself.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# Preserve the controller's sealed-script no-bytecode contract through the
# boot transport before any staged Python helper starts.
export PYTHONDONTWRITEBYTECODE=1

DATA_DIR="${CLOUDBENCH_DATA_DIR:-/data}"
LOG="$DATA_DIR/bench.log"
REPO="${CLOUDBENCH_REPO_DIR:-$DATA_DIR/repo}"
STATUS_PORT="${CLOUDBENCH_STATUS_PORT:-8011}"
DRIVER_PID_FILE="$DATA_DIR/cloudbench-driver.pid"
DRIVER_STATE_FILE="$DATA_DIR/cloudbench-driver.state"
SHUTDOWN_REQUEST_FILE="$DATA_DIR/cloudbench-shutdown-${CLOUDBENCH_RUN_TOKEN:-boot}.request"
CLEANUP_ACK_FILE="$DATA_DIR/cloudbench-driver-clean-${CLOUDBENCH_RUN_TOKEN:-boot}.ack"
PRELAUNCH_SEAL_FILE="$DATA_DIR/cloudbench-prelaunch-${CLOUDBENCH_RUN_TOKEN:-boot}.sealed"
INTERRUPT_CLEANUP_STATUS_FILE="$DATA_DIR/cloudbench-interrupt-cleanup-${CLOUDBENCH_RUN_TOKEN:-boot}.status"

publish_driver_state() {
    local state="$1" temporary="${DRIVER_STATE_FILE}.tmp.$$"
    printf '%s\n' "$state" > "$temporary" && mv -f "$temporary" "$DRIVER_STATE_FILE"
}
# Token-bound proof that this boot stopped before launching any driver, stack
# or browser. The status server then seals bench.log as the complete runtime
# evidence, so the fleet can retire the guest instead of retaining it forever.
publish_prelaunch_seal() {
    local temporary="${PRELAUNCH_SEAL_FILE}.tmp.$$"
    printf '%s\n' "${CLOUDBENCH_RUN_TOKEN:-boot}" > "$temporary" \
        && mv -f "$temporary" "$PRELAUNCH_SEAL_FILE"
}
publish_cleanup_ack() {
    local temporary="${CLEANUP_ACK_FILE}.tmp.$$"
    printf '%s\n' "${CLOUDBENCH_RUN_TOKEN:-boot}" > "$temporary" \
        && mv -f "$temporary" "$CLEANUP_ACK_FILE"
}
seal_missing_injected_helper() {
    local label="$1" path="$2"
    printf '[boot %s] FATAL: controller-injected %s missing or empty (%s); refusing checked-out fallback\n' \
        "$(date -u +%H:%M:%S)" "$label" "$path" >> "$LOG"
    # No benchmark or browser process was launched, so cleanup is already
    # complete. Publish that token-bound fact before the explicit lifecycle
    # seal; if either durable write fails, leave the guest fail-closed.
    if ! publish_prelaunch_seal || ! publish_cleanup_ack; then
        printf '[boot %s] FATAL: could not publish no-launch cleanup acknowledgement\n' \
            "$(date -u +%H:%M:%S)" >> "$LOG"
        return 1
    fi
    publish_driver_state exited
}
DRIVER="${CLOUDBENCH_RUN_SCRIPT:-/cloudbench-run.sh}"
FETCH_REF_SCRIPT="${CLOUDBENCH_FETCH_REF_SCRIPT:-/cloudbench-fetch-ref.sh}"
STATUS_SERVER_SCRIPT="${CLOUDBENCH_STATUS_SERVER_SCRIPT:-/cloudbench-status-server.py}"

# Not a benchmark boot (the warm clone-source machine, or a bare manual start) →
# idle exactly like the image's original `sleep infinity` CMD.
if [ "${CLOUDBENCH_BOOT:-}" != "1" ]; then
    exec sleep infinity
fi

# /data (the snapshot-forked volume) can be briefly unwritable right at boot — the
# mount lands a beat after the command starts. Writing bench.log then silently
# fails (no set -e here) and the whole run produces an empty log. Wait until /data
# is actually writable before doing anything that touches it.
for _w in $(seq 1 120); do
    if touch "$DATA_DIR/.cbwtest" 2>/dev/null; then rm -f "$DATA_DIR/.cbwtest" 2>/dev/null; break; fi
    sleep 1
done

# Publish an explicit lifecycle before the status server starts. PID absence is
# ambiguous during checkout: it means "not launched yet", not "driver died".
# Relays and fleet collectors only treat the terminal `exited` state as proof
# that waiting cannot succeed.
rm -f "$DRIVER_PID_FILE" "$SHUTDOWN_REQUEST_FILE" "$CLEANUP_ACK_FILE" "$PRELAUNCH_SEAL_FILE"
publish_driver_state booting || exit 1

# RUNSTAMP first — the controller polls the log for this token to confirm the box
# actually booted into the driver (replaces the old ssh-written RUNSTAMP).
rm -f "$DATA_DIR/bench.log.generation"
printf 'RUNSTAMP-%s\n' "${CLOUDBENCH_RUN_TOKEN:-boot}" > "$LOG"

# Data-plane status server: serve /data (which holds bench.log) over HTTP so the
# controller reads progress via `flyctl proxy` (WireGuard) — zero Machines-API
# cost, so N boxes polling can never saturate the control-plane rate limit. Bound
# to the box's private IPv6 6PN address, reachable only through the authenticated
# proxy. The custom service also implements authenticated barrier release and the
# /driver-health contract consumed by the controller.
if [ ! -s "$STATUS_SERVER_SCRIPT" ]; then
    seal_missing_injected_helper status-server "$STATUS_SERVER_SCRIPT" || exit 1
    exec sleep infinity
fi
pkill -f "cloudbench-status-server.py.*--port $STATUS_PORT" 2>/dev/null || true
setsid python3 "$STATUS_SERVER_SCRIPT" \
    --port "$STATUS_PORT" \
    --directory "$DATA_DIR" \
    --barrier "${CLOUDBENCH_START_BARRIER:-}" \
    --run-token "${CLOUDBENCH_RUN_TOKEN:-}" \
    >/dev/null 2>&1 </dev/null &

# Keep the status server outside the compressed envelope so a rejected payload
# is observable and seals the no-launch cleanup contract. Older SSH launches
# have no envelope; they retain their individually injected helper paths.
if [ -n "${CLOUDBENCH_BOOT_PAYLOAD_FILE:-}" ]; then
    if ! python3 /cloudbench-boot-payload.py unpack "$CLOUDBENCH_BOOT_PAYLOAD_FILE" \
        "${CLOUDBENCH_BOOT_PAYLOAD_SHA256:-}" / >> "$LOG" 2>&1; then
        seal_missing_injected_helper boot-payload "$CLOUDBENCH_BOOT_PAYLOAD_FILE" || exit 1
        exec sleep infinity
    fi
fi

# Nothing from the requested checkout may run until the complete bootstrap
# control pair is present. Missing staged control code means no benchmark or
# browser resource exists, so seal+ack the no-launch outcome for exact teardown.
if [ ! -s "$DRIVER" ]; then
    seal_missing_injected_helper driver "$DRIVER" || exit 1
    exec sleep infinity
fi
if [ ! -s "$FETCH_REF_SCRIPT" ]; then
    seal_missing_injected_helper fetch-ref-helper "$FETCH_REF_SCRIPT" || exit 1
    exec sleep infinity
fi

# Bootstrap-checkout the ref so its repository content is ready before the
# immutable controller-injected driver performs the full sync/patch flow. Reuse
# the battle-tested fetch-ref script, which builds a
# request-scoped http.extraheader from CLOUDBENCH_GITHUB_TOKEN_B64 (passed as a
# machine --env by the controller) — no token in the URL or the log. Its logic is
# stable across refs, so the snapshot's copy safely checks out the ref. The
# injected driver re-runs git_sync and never delegates its control flow to the
# requested ref.
export CLOUDBENCH_APP_USER="${CLOUDBENCH_APP_USER:-rose}"
# Clear stale git locks the snapshot may carry. The ssh-launch path did this in its
# "clear-stale" step; boot-launch has no ssh, so do it here — a leftover
# .git/index.lock or cloudbench-fetch.lock (from a checkout that was in flight when
# the snapshot was taken) otherwise HANGS `git checkout`/`reset` indefinitely and
# every box stalls right after the fetch. Also kill any leftover driver/http.server.
pkill -TERM -f 'cloudbench-run.sh|run_benchmark.py|scripts/run.sh --benchmark' 2>/dev/null || true
rm -f "$REPO/.git/index.lock" "$REPO/.git/"*.lock "$REPO/.git/refs/heads/"*.lock \
      "$REPO/.git/cloudbench-fetch.lock" 2>/dev/null || true
bootstrap_checkout_ref() {
    echo "[boot $(date -u +%H:%M:%S)] bootstrap-checkout ${REF:-<none>}"
    git config --global --add safe.directory "$REPO" 2>/dev/null || true
    if [ -n "${REF:-}" ]; then
        bash "$FETCH_REF_SCRIPT" "$REPO" "$REF" \
            || echo "[boot] bootstrap fetch-ref failed (driver git_sync will retry)"
    fi
}
# The injected cold driver owns the first empty-destination check and checkout.
# Prefetching here would populate that destination before its mandatory guard.
# The fetch can take minutes, far beyond the fleet's cleanup-acknowledgement
# window, so a durable /shutdown request stops it instead of waiting it out.
# Nothing from the checkout has run yet; the request is then consumed below.
interruptible_bootstrap_checkout() {
    local pid waited=0
    set -m
    bootstrap_checkout_ref >> "$LOG" 2>&1 &
    pid=$!
    set +m
    while kill -0 "$pid" 2>/dev/null; do
        if [ -e "$SHUTDOWN_REQUEST_FILE" ]; then
            printf '[boot %s] shutdown requested during bootstrap checkout; stopping it\n' \
                "$(date -u +%H:%M:%S)" >> "$LOG"
            kill -TERM -- "-$pid" 2>/dev/null || true
            while kill -0 -- "-$pid" 2>/dev/null && [ "$waited" -lt 20 ]; do
                sleep 0.5
                waited=$((waited + 1))
            done
            kill -KILL -- "-$pid" 2>/dev/null || true
            break
        fi
        sleep 0.5
    done
    wait "$pid" 2>/dev/null || true
}
if [ "${CLOUDBENCH_COLD_PRIMARY_BOOTSTRAP:-0}" != 1 ]; then
    interruptible_bootstrap_checkout
fi

# Run the controller-injected driver, not the copy in the checkout. This matters
# for dirty-worktree validation: cloudbench-run.sh is the process that applies
# the uploaded patch, so changing that file via the patch is too late to alter
# its already-running control flow. Boot launch injects an immutable current
# copy at /cloudbench-run.sh alongside this boot script.
#
# Keep the Machine alive after the driver emits DONE. The
# controller polls every 15-20 seconds; exiting PID 1 immediately after DONE can
# stop Fly's data plane before the next poll, turning a genuine verdict into
# NORESULT. The controller persists the run-scoped marker payloads first and
# then explicitly stops/returns this Machine to the pool. If the driver crashes
# before DONE, /driver-health still reports it dead while this supervisor lives.
if [ -e "$SHUTDOWN_REQUEST_FILE" ]; then
    publish_prelaunch_seal || exit 1
    publish_cleanup_ack || exit 1
    printf '[boot %s] shutdown requested before driver launch; cleanup acknowledged\n' \
        "$(date -u +%H:%M:%S)" >> "$LOG"
    publish_driver_state exited || exit 1
    exec sleep infinity
fi
# This supervisor is itself a non-interactive shell. Without monitor mode, Bash
# starts an asynchronous driver with SIGINT/SIGQUIT ignored; that inherited
# disposition cannot be reset by the driver's inner heartbeat wrapper, so the
# benchmark process silently ignores owner cancellation. Give the driver a
# normal signal disposition before it launches any descendants.
set -m
bash "$DRIVER" >> "$LOG" 2>&1 &
driver_pid=$!
set +m
driver_pid_temporary="${DRIVER_PID_FILE}.tmp.$$"
printf '%s\n' "$driver_pid" > "$driver_pid_temporary" \
    && mv -f "$driver_pid_temporary" "$DRIVER_PID_FILE"
publish_driver_state running || exit 1
wait "$driver_pid"
driver_rc=$?
rm -f "$DRIVER_PID_FILE"
interrupt_status_present=0
cleanup_ack_present=0
[ -s "$INTERRUPT_CLEANUP_STATUS_FILE" ] && interrupt_status_present=1
[ -s "$CLEANUP_ACK_FILE" ] && cleanup_ack_present=1
printf '[boot %s] driver cleanup evidence interrupt_status=%s cleanup_ack=%s\n' \
    "$(date -u +%H:%M:%S)" "$interrupt_status_present" "$cleanup_ack_present" >> "$LOG"
printf '[boot %s] driver exited rc=%s; holding for controller collection\n' \
    "$(date -u +%H:%M:%S)" "$driver_rc" >> "$LOG"
# `exited` is the terminal evidence seal consumed by the controller. Publish it
# only after the supervisor's final log byte is durable, so a 410 health response
# can never race ahead of authoritative artifact collection.
publish_driver_state exited || exit 1
exec sleep infinity
