#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# cloudbench-run.sh — the on-box, DETACHED per-run driver for the warm cloud box.
#
# Runs ON the persistent Fly machine (app: navi-whisper-lux-bench). It is NOT the
# image CMD and is NOT held open by an SSH session: run-bench-cloud writes this
# script to /tmp/rb.sh and launches it DETACHED
#     setsid bash /tmp/rb.sh > /data/bench.log 2>&1 < /dev/null &
# then polls /data/bench.log for the DONE marker over SEPARATE short ssh -C reads.
# (flyctl ssh console -C BUFFERS stdout until the session ends AND returns exit
# 4294967295 whenever the remote command backgrounds a process — so a foreground,
# session-held run is unusable here. Detach + poll-a-logfile is the only pattern
# that survives.)
#
# Everything is HANDS-OFF + WARM:
#   - /data persists across machine stop/start (the container's baked /app does NOT).
#   - /data/repo is a pre-authenticated git checkout (remote URL already carries a
#     working repo token — no token handling needed here).
#   - /data/world-model is a PRE-BUILT WMH model. We SERVE it (never build from R2:
#     R2→Fly is throttled to ~14 KB/s = hours). run.sh serves a pre-built model with
#     no R2 access when WMH_BUILD_DIR=/data/world-model AND BENCHMARK_SKIP_WMH_DELTA=1.
#   - Deps (agents venv + node_modules) are baked into /app; manifest fingerprints
#     refresh the volume trees when the donor image changes and reject stale images.
#
# Per-run flow:
#   1. cd /data/repo → git fetch/checkout/reset --hard "$REF" (pre-authed remote).
#   2. Decode AGENTS_ENV_B64 / BACKEND_ENV_B64 → repo .env files.
#   3. Fingerprint + sync baked venv/node_modules from /app → /data/repo.
#   4. Ensure the system Postgres cluster is up + the victoria DB exists (:5432).
#   5. Stage the live dashboard (copy dashboard.html into the context dir + start a
#      static http server rooted there on DASHPORT) so run-bench-cloud can proxy it.
#   6. Launch scripts/run.sh --benchmark (from /data/repo) in the BACKGROUND with the
#      isolated + simulate + serve-cached-WMH env.
#   7. Wait for services.json status=running AND curl localhost:3007/healthz.
#   8. Run run_benchmark.py for the requested tasks (--parallel/--max-concurrency
#      when >1) against the catalog-mandated production or isolated target.
#   9. Print the DONE marker + the report card between BEGIN/END markers.
#
# Inputs (all from env, exported by run-bench-cloud's on-box invocation):
#   REF                 branch/sha to sync + run (required; defaults to HEAD if empty)
#   WMH_ENGINE          experiential (default, native) | legacy
#   WMH_MODEL_NAME      cached WMH model artifact name (default rose-archive;
#                       legacy engine: rose-r2-archive-anthropic)
#   WMH_ROSE_POOL / WMH_EXECUTION_POLICY / WMH_CONTEXT_TOKENS  native serving config
#   BENCH_TASKS         comma- OR space-separated task list (required)
#   BENCH_MAX_CONCURRENCY  max concurrent tasks when >1 task (default 5)
#   BENCH_SIMULATE      "1" simulate (default) | "0" real mode (no WMH)
#   BENCH_DASHPORT      port for the on-box static dashboard server (default 8009)
#
# Runs as root (needs to start the Postgres cluster); drops to `rose` via gosu for
# the stack + benchmark. This script does NOT stop the machine — run-bench-cloud
# stops it after retrieving results.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# The provenance helper and result tooling are controller-staged code. Never
# create sibling bytecode while consuming that immutable bundle on the guest.
export PYTHONDONTWRITEBYTECODE=1

DATA_DIR="${CLOUDBENCH_DATA_DIR:-/data}"
REPO_DIR="${CLOUDBENCH_REPO_DIR:-$DATA_DIR/repo}"
DEPS_DIR="${CLOUDBENCH_DEPS_DIR:-/app}"           # baked dependency donor image.
WMH_DIR="${CLOUDBENCH_WMH_DIR:-$DATA_DIR/world-model}"
APP_USER=rose
CONTEXT_DIR="$REPO_DIR/.context/cloudbench"
RUN_OUTPUT_MARKER="/tmp/cloudbench-run-start.$$"
# The driver is controller-owned control-plane code. Resolve every helper beside
# that immutable driver by default, never from the requested ref's checkout. A
# direct repo invocation still resolves to scripts/, while boot and legacy cloud
# launches resolve to their staged / or /data bundles respectively.
CONTROL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
[ -d "$CONTROL_DIR/lib" ] && CONTROL_LIB_DIR="$CONTROL_DIR/lib" || CONTROL_LIB_DIR="$CONTROL_DIR"
FETCH_REF_SCRIPT="${CLOUDBENCH_FETCH_REF_SCRIPT:-$CONTROL_DIR/cloudbench-fetch-ref.sh}"
SYNC_DEPS_SCRIPT="${CLOUDBENCH_SYNC_DEPS_SCRIPT:-$CONTROL_DIR/cloudbench-sync-deps.sh}"
SYNC_PRISMA_SCRIPT="${CLOUDBENCH_SYNC_PRISMA_SCRIPT:-$CONTROL_DIR/cloudbench-sync-prisma-client.sh}"
NGROK_INSTALL_SCRIPT="${CLOUDBENCH_NGROK_INSTALL_SCRIPT:-$CONTROL_DIR/cloudbench-install-ngrok.sh}"
CURRENT_RUN_ARTIFACT_SCRIPT="${CLOUDBENCH_CURRENT_RUN_ARTIFACT_SCRIPT:-$CONTROL_DIR/cloudbench-current-run-artifact.py}"
PREPARE_PATCH_SCRIPT="${CLOUDBENCH_PREPARE_PATCH_SCRIPT:-$CONTROL_DIR/cloudbench-prepare-patch.sh}"
STATUS_SERVER_SCRIPT="${CLOUDBENCH_STATUS_SERVER_SCRIPT:-$CONTROL_DIR/cloudbench-status-server.py}"
BENCHMARK_TARGET_SCRIPT="${CLOUDBENCH_BENCHMARK_TARGET_SCRIPT:-$CONTROL_DIR/cloudbench-benchmark-target.py}"
CATALOG_SCRIPT="${CLOUDBENCH_CATALOG_SCRIPT:-$CONTROL_DIR/cloudbench_catalog.py}"
ENV_HELPER="${CLOUDBENCH_ENV_HELPER:-$CONTROL_LIB_DIR/cloudbench-env.sh}"
EXECUTION_PROVENANCE_SCRIPT="${CLOUDBENCH_EXECUTION_PROVENANCE_SCRIPT:-$CONTROL_DIR/cloudbench_execution_provenance.py}"

# ── Inputs (env) ────────────────────────────────────────────────────────────
REF="${REF:-}"
# Begin WMH selection.
# World-model selection: the controller (run-bench-cloud) always passes these;
# the defaults mirror its native experiential defaults for direct invocations.
WMH_ENGINE="${WMH_ENGINE:-experiential}"
if [ "$WMH_ENGINE" = experiential ]; then
    WMH_MODEL_NAME="${WMH_MODEL_NAME:-rose-archive}"
    WMH_ROSE_POOL="${WMH_ROSE_POOL:-rose-wmh-gpt61}"
    WMH_EXECUTION_POLICY="${WMH_EXECUTION_POLICY:-rose-outcome-distribution-v4}"
else
    WMH_MODEL_NAME="${WMH_MODEL_NAME:-rose-r2-archive-anthropic}"
    WMH_ROSE_POOL="${WMH_ROSE_POOL:-rose-1-ultra}"
    WMH_EXECUTION_POLICY="${WMH_EXECUTION_POLICY:-upstream}"
fi
WMH_CONTEXT_TOKENS="${WMH_CONTEXT_TOKENS:-}"
case "$WMH_ENGINE" in legacy|experiential) ;; *) echo "Invalid WMH_ENGINE: $WMH_ENGINE" >&2; exit 2 ;; esac
for _wmh_value in "$WMH_MODEL_NAME" "$WMH_ROSE_POOL" "$WMH_EXECUTION_POLICY"; do
    [[ "$_wmh_value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "Invalid WMH setting: $_wmh_value" >&2; exit 2; }
done
# Each engine serves its own donor directory: the native model is restored to
# world-model-native so it never replaces the legacy model other workspaces serve.
if [ -z "${CLOUDBENCH_WMH_DIR:-}" ] && [ "$WMH_ENGINE" = experiential ]; then
    WMH_DIR="$DATA_DIR/world-model-native"
fi
# The native venv (and its uv-managed Python under /data/uv-python) is created on
# the donor volume by `run-bench-cloud --refresh-wmh`; guests never install it.
WMH_NATIVE_VENV="${CLOUDBENCH_WMH_NATIVE_VENV:-$REPO_DIR/.context/experiential-venv}"
# End WMH selection.
BENCH_TASKS="${BENCH_TASKS:-}"
# The controller passes the task list base64-encoded (BENCH_TASKS_B64) so commas
# survive the base64/exec layers verbatim; fall back to a raw BENCH_TASKS.
if [ -n "${BENCH_TASKS_B64:-}" ]; then
    BENCH_TASKS="$(printf '%s' "$BENCH_TASKS_B64" | base64 -d 2>/dev/null || printf '%s' "$BENCH_TASKS")"
fi
BENCH_MAX_CONCURRENCY="${BENCH_MAX_CONCURRENCY:-5}"
BENCH_SIMULATE="${BENCH_SIMULATE:-1}"
BENCH_DASHPORT="${BENCH_DASHPORT:-8009}"
BENCHMARK_FAST_MODE_CACHE="${BENCHMARK_FAST_MODE_CACHE:-}"
if [ "${CLOUDBENCH_FAST_CACHE_READ_ONLY:-}" = 1 ]; then
    export FAST_MODE_CACHE_DISABLE_WRITE_THROUGH=1
    export BENCHMARK_DEMO_CACHE_READ_ONLY=1
fi
BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS="${BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS-7200}"
case "$BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS" in
    ''|*[!0-9]*|0) echo "FATAL: BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS must be a positive integer" >&2; exit 2 ;;
esac
[ "$BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS" -gt 0 ] || exit 2
BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY="${BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY:-}"
BENCHMARK_PEAK_FLY_MACHINES="${BENCHMARK_PEAK_FLY_MACHINES:-}"
BENCHMARK_VM_USD_PER_HOUR="${BENCHMARK_VM_USD_PER_HOUR:-}"
BENCHMARK_FRONTEND_URL="${BENCHMARK_FRONTEND_URL:-}"
BENCHMARK_REPORT_FRONTEND_URL="${BENCHMARK_REPORT_FRONTEND_URL:-}"
AGENTCARD_BENCHMARK_ONBOARDING_RETURN_URL="${AGENTCARD_ONBOARDING_RETURN_URL:-https://navi-j9a9.onrender.com/api/agentcard/onboarding/callback}"
CLOUDBENCH_START_BARRIER="${CLOUDBENCH_START_BARRIER:-}"
CLOUDBENCH_BARRIER_TOKEN="${CLOUDBENCH_BARRIER_TOKEN:-}"
CLOUDBENCH_STATUS_PORT="${CLOUDBENCH_STATUS_PORT:-8011}"
CLOUDBENCH_RUN_TOKEN="${CLOUDBENCH_RUN_TOKEN:-}"
STACK_SEED_DUMP="${CLOUDBENCH_SEED_DUMP_PATH:-$DATA_DIR/cloudbench-cache/victoria-seed.dump}"

if [ "${CLOUDBENCH_REQUIRE_EXECUTION_PROVENANCE:-0}" = "1" ]; then
    [ -s "$EXECUTION_PROVENANCE_SCRIPT" ] \
        && [ -s "${CLOUDBENCH_EXECUTION_PROVENANCE_FILE:-}" ] || {
        echo "[cloudbench] FATAL: trusted execution provenance bundle is missing"
        exit 2
    }
    python3 "$EXECUTION_PROVENANCE_SCRIPT" verify-code \
        --provenance "$CLOUDBENCH_EXECUTION_PROVENANCE_FILE" \
        --base-sha "$REF" \
        --workspace-patch-sha256 "${LOCAL_PATCH_SHA256:-none}" || exit 2
fi

if [ -n "$CLOUDBENCH_RUN_TOKEN" ]; then
    case "$CLOUDBENCH_RUN_TOKEN" in
        *[!a-zA-Z0-9._-]*)
            echo "[cloudbench] FATAL: invalid run token"
            exit 2
            ;;
    esac
fi
MARKER_SUFFIX=""
[ -n "$CLOUDBENCH_RUN_TOKEN" ] && MARKER_SUFFIX=" token=$CLOUDBENCH_RUN_TOKEN"

# Report/marker delimiters run-bench-cloud greps for in /data/bench.log.
REPORT_BEGIN="::CLOUDBENCH-REPORT-CARD-BEGIN::$MARKER_SUFFIX"
REPORT_END="::CLOUDBENCH-REPORT-CARD-END::$MARKER_SUFFIX"
RESULT_BEGIN="::CLOUDBENCH-RESULT-BEGIN::$MARKER_SUFFIX"
RESULT_END="::CLOUDBENCH-RESULT-END::$MARKER_SUFFIX"
DONE_MARKER="::CLOUDBENCH-DONE::$MARKER_SUFFIX"

log() { echo "[cloudbench $(date -u +%H:%M:%S)] $*"; }
# Step markers: STEP <name> lines are machine-parseable timing boundaries for
# scripts/cloudbench-bring-up-report.py — isolate each bring-up step's cost.
step() { log "STEP $*"; }

CLEANUP_ACK_FILE="$DATA_DIR/cloudbench-driver-clean-${CLOUDBENCH_RUN_TOKEN:-boot}.ack"
SHUTDOWN_REQUEST_FILE="$DATA_DIR/cloudbench-shutdown-${CLOUDBENCH_RUN_TOKEN:-boot}.request"
INTERRUPT_CLEANUP_STATUS_FILE="$DATA_DIR/cloudbench-interrupt-cleanup-${CLOUDBENCH_RUN_TOKEN:-boot}.status"
RUNNER_INTERRUPT_CLEANUP_STATUS_FILE="$CONTEXT_DIR/cloudbench-interrupt-cleanup-${CLOUDBENCH_RUN_TOKEN:-boot}.status"
STACK_CLEANUP_STATUS_FILE="$CONTEXT_DIR/cloudbench-stack-cleanup-${CLOUDBENCH_RUN_TOKEN:-boot}.status"
ACTIVE_COMMAND_PID=""
ACTIVE_COMMAND_SIGNALLED=0
ACTIVE_COMMAND_STARTING=0
ACTIVE_COMMAND_SHUTDOWN_PENDING=0
CODEX_AUTH_ADMISSION_TOKEN=""
CODEX_AUTH_HELPER="${CLOUDBENCH_CODEX_AUTH_HELPER:-$CONTROL_DIR/cloudbench-codex-auth.py}"
HEARTBEAT_SLEEP_PID=""
STACK_PID=""
STACK_NATIVE_IDENTITY=""
TAIL_PID=""
GUEST_DIAGNOSTICS_PID=""

publish_cleanup_ack() {
    local temporary="${CLEANUP_ACK_FILE}.tmp.$$" cleanup_state cleanup_token cleanup_status_temporary cleanup_stack_pid cleanup_stack_birth cleanup_stack_native_identity cleanup_native_count cleanup_identity_matches=0 cleanup_version cleanup_version_count token_matches=0
    # Library/contract probes intentionally invoke the driver without a guest
    # run token and without /data. They do not own a status service to ack.
    [ -n "$CLOUDBENCH_RUN_TOKEN" ] || return 0
    mkdir -p "${CLEANUP_ACK_FILE%/*}" "${INTERRUPT_CLEANUP_STATUS_FILE%/*}" || return 1
    if [ "$ACTIVE_COMMAND_SIGNALLED" = "1" ] || [ -f "$RUNNER_INTERRUPT_CLEANUP_STATUS_FILE" ]; then
        if ! awk -F= '
            { if (index($0, "=") == 0 || seen[$1]++) { invalid=1; exit } }
            END { if (invalid || seen["state"] != 1 || seen["token"] != 1) exit 1 }
        ' "$RUNNER_INTERRUPT_CLEANUP_STATUS_FILE"; then
            log "FATAL: benchmark root cleanup evidence is malformed; refusing guest cleanup acknowledgement"
            return 1
        fi
        cleanup_version_count="$(awk -F= '$1 == "version" { count++ } END { print count+0 }' "$RUNNER_INTERRUPT_CLEANUP_STATUS_FILE")"
        cleanup_version="$(awk -F= '$1 == "version" { sub(/^[^=]*=/, ""); print; exit }' "$RUNNER_INTERRUPT_CLEANUP_STATUS_FILE")"
        # Older root receipts omit version. A declared interrupt schema is v1;
        # stack schema v2 never authorizes root/financial cleanup.
        if [ "$cleanup_version_count" != 0 ] && [ "$cleanup_version" != 1 ]; then
            log "FATAL: benchmark root cleanup evidence schema is unsupported; refusing guest cleanup acknowledgement"
            return 1
        fi
        cleanup_state="$(awk -F= '$1 == "state" { sub(/^[^=]*=/, ""); print; exit }' \
            "$RUNNER_INTERRUPT_CLEANUP_STATUS_FILE" 2>/dev/null || true)"
        cleanup_token="$(awk -F= '$1 == "token" { sub(/^[^=]*=/, ""); print; exit }' \
            "$RUNNER_INTERRUPT_CLEANUP_STATUS_FILE" 2>/dev/null || true)"
        [ "$cleanup_token" = "$CLOUDBENCH_RUN_TOKEN" ] && token_matches=1
        log "benchmark root cleanup evidence: state=${cleanup_state:-missing} token_match=$token_matches"
        case "$cleanup_state:$token_matches" in
            pending:1|clean:1|failed:1)
                cleanup_status_temporary="${INTERRUPT_CLEANUP_STATUS_FILE}.tmp.$$"
                if ! cp "$RUNNER_INTERRUPT_CLEANUP_STATUS_FILE" "$cleanup_status_temporary" \
                    || ! mv -f "$cleanup_status_temporary" "$INTERRUPT_CLEANUP_STATUS_FILE"; then
                    rm -f "$cleanup_status_temporary"
                    log "FATAL: could not persist benchmark root cleanup evidence"
                    return 1
                fi
                ;;
        esac
        if [ "$cleanup_state" != "clean" ] || [ "$cleanup_token" != "$CLOUDBENCH_RUN_TOKEN" ]; then
            log "FATAL: benchmark root cleanup was not confirmed; refusing guest cleanup acknowledgement"
            return 1
        fi
    fi
    if [ -n "${STACK_PID:-}" ]; then
        # Match the local reader: every line is a key=value and every key is
        # unique. Unknown optional keys remain valid; required guards exist once.
        if ! awk -F= '
            { if (index($0, "=") == 0 || seen[$1]++) { invalid=1; exit } }
            END { if (invalid || seen["version"] != 1 || seen["state"] != 1 || seen["token"] != 1 || seen["stack_pid"] != 1) exit 1 }
        ' "$STACK_CLEANUP_STATUS_FILE"; then
            log "FATAL: stack cleanup receipt is malformed; refusing guest cleanup acknowledgement"
            return 1
        fi
        cleanup_state="$(awk -F= '$1 == "state" { sub(/^[^=]*=/, ""); print; exit }' "$STACK_CLEANUP_STATUS_FILE" 2>/dev/null || true)"
        cleanup_token="$(awk -F= '$1 == "token" { sub(/^[^=]*=/, ""); print; exit }' "$STACK_CLEANUP_STATUS_FILE" 2>/dev/null || true)"
        cleanup_stack_pid="$(awk -F= '$1 == "stack_pid" { sub(/^[^=]*=/, ""); print; exit }' "$STACK_CLEANUP_STATUS_FILE" 2>/dev/null || true)"
        cleanup_stack_birth="$(awk -F= '$1 == "stack_birth" { sub(/^[^=]*=/, ""); print; exit }' "$STACK_CLEANUP_STATUS_FILE" 2>/dev/null || true)"
        cleanup_stack_native_identity="$(awk -F= '$1 == "stack_native_identity" { sub(/^[^=]*=/, ""); print; exit }' "$STACK_CLEANUP_STATUS_FILE" 2>/dev/null || true)"
        cleanup_native_count="$(awk -F= '$1 == "stack_native_identity" { count++ } END { print count+0 }' "$STACK_CLEANUP_STATUS_FILE" 2>/dev/null || true)"
        cleanup_version="$(awk -F= '$1 == "version" { sub(/^[^=]*=/, ""); print; exit }' "$STACK_CLEANUP_STATUS_FILE" 2>/dev/null || true)"
        cleanup_version_count="$(awk -F= '$1 == "version" { count++ } END { print count+0 }' "$STACK_CLEANUP_STATUS_FILE" 2>/dev/null || true)"
        if [ "$cleanup_version_count" = 1 ]; then
            if [ "$cleanup_version" = 1 ] && [ "$cleanup_native_count" = 0 ]; then
                # Genuine legacy receipts retain the original exact birth guard.
                [ -n "${STACK_BIRTH:-}" ] && [ "$cleanup_stack_birth" = "$STACK_BIRTH" ] && cleanup_identity_matches=1
            elif { [ "$cleanup_version" = 1 ] || [ "$cleanup_version" = 2 ]; } && [ "$cleanup_native_count" = 1 ]; then
                # Version 2 requires native identity; a present native field in
                # either schema never falls back to a cosmetic birth match.
                [ -n "${STACK_NATIVE_IDENTITY:-}" ] && [ -n "$cleanup_stack_native_identity" ] \
                    && [ "$cleanup_stack_native_identity" = "$STACK_NATIVE_IDENTITY" ] && cleanup_identity_matches=1
            fi
        fi
        if [ "$cleanup_identity_matches" != 1 ] || [ "$cleanup_state" != clean ] || [ "$cleanup_token" != "$CLOUDBENCH_RUN_TOKEN" ] || [ "$cleanup_stack_pid" != "$STACK_PID" ]; then
            log "FATAL: stack worker cleanup was not confirmed; refusing guest cleanup acknowledgement"
            return 1
        fi
    fi
    printf '%s\n' "${CLOUDBENCH_RUN_TOKEN:-boot}" > "$temporary" \
        && mv -f "$temporary" "$CLEANUP_ACK_FILE"
}

cleanup_stack() {
    local original_rc=$?
    trap - EXIT
    trap '' HUP INT TERM
    [ -z "$HEARTBEAT_SLEEP_PID" ] || kill "$HEARTBEAT_SLEEP_PID" 2>/dev/null || true
    [ -z "$TAIL_PID" ] || kill "$TAIL_PID" 2>/dev/null || true
    # Stop the sampler before the stack so its evidence file is final when the
    # stopped stack is sealed into the runtime evidence manifest.
    if [ -n "$GUEST_DIAGNOSTICS_PID" ]; then
        kill -TERM "$GUEST_DIAGNOSTICS_PID" 2>/dev/null || true
        wait "$GUEST_DIAGNOSTICS_PID" 2>/dev/null || true
    fi
    declare -F stop_dashboard >/dev/null 2>&1 && stop_dashboard
    if [ -n "$STACK_PID" ] && kill -0 "$STACK_PID" 2>/dev/null; then
        # Signal only run.sh. It owns its worker/backend descendants and waits
        # for their graceful shutdown; group-signalling here can double-signal
        # those descendants and bypass their session/replay cleanup.
        kill -TERM "$STACK_PID" 2>/dev/null || true
        wait "$STACK_PID" 2>/dev/null || true
    elif [ -n "$STACK_PID" ]; then
        wait "$STACK_PID" 2>/dev/null || true
    fi
    if [ -n "${CODEX_AUTH_ADMISSION_TOKEN:-}" ]; then
        if ! python3 "$CODEX_AUTH_HELPER" retire --run-token "$CLOUDBENCH_RUN_TOKEN" \
            --machine-id "${CLOUDBENCH_CODEX_AUTH_MACHINE_ID:-}" --sha256 "$CLOUDBENCH_CODEX_AUTH_SHA256" --user "$APP_USER" \
            --admission-token "$CODEX_AUTH_ADMISSION_TOKEN"; then
            log "FATAL: exact credential retirement was not confirmed"
            [ "$original_rc" -ne 0 ] || original_rc=1
            exit "$original_rc"
        fi
    fi
    if ! publish_cleanup_ack; then
        log "FATAL: could not publish guest cleanup acknowledgement"
        [ "$original_rc" -ne 0 ] || original_rc=1
    fi
    exit "$original_rc"
}
trap cleanup_stack EXIT

request_graceful_shutdown() {
    local signal_rc=0 signal_ignored_mask="unreadable" signal_caught_mask="unreadable" signal_process_group="unreadable"
    ACTIVE_COMMAND_SHUTDOWN_PENDING=1
    log "guest shutdown requested; draining benchmark root before stack teardown"
    # An already-cancelled command may exit (and be reaped) before a repeated
    # request; run_with_heartbeat still owns its wait and exit status.
    if [ -n "$ACTIVE_COMMAND_PID" ] && { [ "$ACTIVE_COMMAND_SIGNALLED" = "1" ] || kill -0 "$ACTIVE_COMMAND_PID" 2>/dev/null; }; then
        if [ "$ACTIVE_COMMAND_SIGNALLED" != "1" ]; then
            ACTIVE_COMMAND_SIGNALLED=1
            # Bash defers traps while a foreground `sleep` is running. The
            # heartbeat wait is interruptible instead, and killing its child
            # lets this handler reach benchmark cancellation immediately.
            [ -z "$HEARTBEAT_SLEEP_PID" ] || kill "$HEARTBEAT_SLEEP_PID" 2>/dev/null || true
            trap '' HUP INT TERM
            # asyncio.run translates SIGINT into task cancellation. The benchmark
            # cancellation path can then archive and DELETE the exact root agent,
            # which closes browser sessions and finalizes replays canonically.
            if [ -r "/proc/$ACTIVE_COMMAND_PID/status" ]; then
                signal_ignored_mask="$(awk '$1 == "SigIgn:" { print $2; exit }' "/proc/$ACTIVE_COMMAND_PID/status")"
                signal_caught_mask="$(awk '$1 == "SigCgt:" { print $2; exit }' "/proc/$ACTIVE_COMMAND_PID/status")"
                signal_process_group="$(awk '$1 == "NSpgid:" { print $2; exit }' "/proc/$ACTIVE_COMMAND_PID/status")"
            fi
            log "benchmark signal target evidence: pid=$ACTIVE_COMMAND_PID pgid=$signal_process_group ignored=$signal_ignored_mask caught=$signal_caught_mask"
            kill -INT "$ACTIVE_COMMAND_PID" 2>/dev/null || signal_rc=$?
            log "benchmark cancellation signal dispatched: pid=$ACTIVE_COMMAND_PID signal=INT status=$signal_rc"
        fi
        return
    fi
    # run_with_heartbeat checks the durable request immediately after publishing
    # its child PID. Do not exit in the few instructions between launch and that
    # check or the newly spawned benchmark could outlive this driver un-cancelled.
    [ "$ACTIVE_COMMAND_STARTING" = "1" ] && return
    # Before/after the benchmark subprocess there is no root agent to cancel.
    # EXIT cleanup still drains run.sh (if started) before publishing the ack.
    exit 143
}
trap request_graceful_shutdown HUP INT TERM

# The status service persists a request before signalling, so a request racing
# driver launch is consumed here rather than starting a benchmark after teardown.
if [ -e "$SHUTDOWN_REQUEST_FILE" ]; then
    log "shutdown request preceded driver startup; honoring it without launching a benchmark"
    exit 143
fi

# stack_wait_budget_seconds: the box's fallback-safe stack-health ceiling. A
# pre-launch dump check cannot prove run.sh will restore instead of cold-syncing,
# so matching dumps retain the larger ceiling without delaying healthy startup.
# See scripts/tests/cloudbench-seed-budget.test.sh.
# run-bench-cloud sftp's this lib to /data/ and overrides CLOUDBENCH_SEED_BUDGET_LIB,
# exactly like cloudbench-fetch-ref.sh / cloudbench-sync-deps.sh: at driver start the
# /data/repo checkout is still at the OLD ref (the driver git-fetches the ref later),
# so the lib must come from the controller-staged /data copy, not /data/repo.
SEED_BUDGET_LIB="${CLOUDBENCH_SEED_BUDGET_LIB:-$CONTROL_LIB_DIR/cloudbench-seed-budget.sh}"
if [ ! -f "$SEED_BUDGET_LIB" ]; then
    echo "[cloudbench] FATAL: seed-budget lib missing: $SEED_BUDGET_LIB" >&2
    exit 1
fi
# shellcheck source=lib/cloudbench-seed-budget.sh
source "$SEED_BUDGET_LIB"

run_with_heartbeat() {
    local label="$1" command_pid interval command_rc=0 command_collected=0
    shift
    interval="${CLOUDBENCH_HEARTBEAT_SECONDS:-30}"
    # A background job launched with job control disabled inherits SIGINT as
    # ignored, and that disposition survives exec into Python. Briefly enabling
    # monitor mode gives the benchmark the normal asyncio SIGINT cancellation
    # path while keeping heartbeat supervision in this shell.
    ACTIVE_COMMAND_SIGNALLED=0
    ACTIVE_COMMAND_STARTING=1
    set -m
    "$@" &
    command_pid=$!
    set +m
    ACTIVE_COMMAND_PID="$command_pid"
    ACTIVE_COMMAND_STARTING=0
    if [ -e "$SHUTDOWN_REQUEST_FILE" ] || [ "$ACTIVE_COMMAND_SHUTDOWN_PENDING" = 1 ]; then
        request_graceful_shutdown
    fi
    while kill -0 "$command_pid" 2>/dev/null; do
        sleep "$interval" &
        HEARTBEAT_SLEEP_PID=$!
        wait "$HEARTBEAT_SLEEP_PID" 2>/dev/null || true
        HEARTBEAT_SLEEP_PID=""
        if [ "$ACTIVE_COMMAND_SIGNALLED" = "1" ]; then
            # Signals are ignored after the one canonical cancellation above,
            # so this wait cannot be shortened into premature stack teardown.
            wait "$command_pid" 2>/dev/null || command_rc=$?
            command_collected=1
            break
        fi
        if kill -0 "$command_pid" 2>/dev/null; then
            log "$label heartbeat (pid=$command_pid)"
        fi
    done
    # A signalled child reaped before the loop still has a saved status.
    [ "$command_collected" = 1 ] || wait "$command_pid" 2>/dev/null || command_rc=$?
    if [ "$label" = benchmark ]; then
        ACTIVE_COMMAND_PID=""
    else
        ACTIVE_COMMAND_PID="" ACTIVE_COMMAND_SIGNALLED=0
        [ "$ACTIVE_COMMAND_SHUTDOWN_PENDING" != 1 ] || command_rc=143
    fi
    return "$command_rc"
}

manifest_public_frontend_url() {
    python3 - "$MANIFEST" <<'PY'
import json
import sys
from urllib.parse import urlparse

try:
    with open(sys.argv[1]) as f:
        manifest = json.load(f)
except Exception:
    sys.exit(0)

url = (((manifest.get("urls") or {}).get("public")) or "").strip().rstrip("/")
parsed = urlparse(url)
if parsed.scheme != "https":
    sys.exit(0)
host = (parsed.hostname or "").lower()
if host in {"localhost", "127.0.0.1"}:
    sys.exit(0)
print(url)
PY
}

wait_for_benchmark_frontend_url() {
    if [ "$BENCH_NEEDS_BUNDLED_FRONTEND" != "1" ]; then
        return 0
    fi
    if [ "$BENCH_SIMULATE" = "1" ]; then
        return 0
    fi

    local public_url probe_dir
    local -a probe_args=(
        --fail --silent --show-error --location --max-time 5
        --user-agent 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    )
    probe_dir="$(mktemp -d "$CONTEXT_DIR/frontend-probe.XXXXXXXX")" || return 1
    public_url=""
    log "waiting for public frontend URL required by bundled browser/payment benchmark prompts..."
    for _ in $(seq 1 180); do
        public_url="$(manifest_public_frontend_url || true)"
        # A successful status can still be a tunnel interstitial or redirect.
        # Compare the browser-visible bytes to this stack's own frontend.
        # Both requests share the existing five-second request ceiling.
        if [ -n "$public_url" ] \
            && curl --parallel --parallel-immediate --fail-early \
                "${probe_args[@]}" --output "$probe_dir/origin" \
                "http://127.0.0.1:$((BASE_PORT + 1))/test_payment" \
                --next "${probe_args[@]}" --output "$probe_dir/public" \
                "$public_url/test_payment" >/dev/null 2>&1 \
            && [ -s "$probe_dir/origin" ] \
            && cmp -s "$probe_dir/origin" "$probe_dir/public"; then
            rm -rf "$probe_dir"
            BENCHMARK_FRONTEND_URL="$public_url"
            export BENCHMARK_FRONTEND_URL
            log "public benchmark frontend ready: $BENCHMARK_FRONTEND_URL"
            return 0
        fi
        sleep 1
    done

    rm -rf "$probe_dir"
    log "FATAL: bundled browser/payment benchmark requires a public frontend URL serving this stack's frontend, but $MANIFEST did not publish a verified https urls.public"
    return 1
}

# ── Normalize the task list (comma OR space separated) into an array ────────
# The controller may pass "a,b,c" or "a b c"; accept both.
read -r -a BENCH_TASK_LIST <<< "$(printf '%s' "$BENCH_TASKS" | tr ',' ' ')"
TASK_WORKER_ENV=()
BENCH_NEEDS_BUNDLED_FRONTEND=0
BENCH_NEEDS_AGENTCARD_ONBOARDING=0
BENCH_NEEDS_PAYMENT_FIXTURE=0
BENCH_NEEDS_NEW_USER_CHECKOUT=0
resolve_task_gate() {
    local task_gate_python task_gate_status
    task_gate_python="${CLOUDBENCH_TASK_GATE_PYTHON:-$(command -v python3 || true)}"
    if [ -z "$task_gate_python" ]; then
        echo "[cloudbench] FATAL: no Python interpreter is available for task gate resolution" >&2
        return 1
    fi
    # One per-task worker environment for local and cloud runs: local.py
    # configure_task_environment applies this same catalog policy. An empty
    # value is exported as-is so an inherited setting is cleared.
    local task_env_output entry
    task_env_output="$("$task_gate_python" "$CATALOG_SCRIPT" task-env \
        "$REPO_DIR/agents/benchmarks/tasks.json" "${BENCH_TASK_LIST[@]}")"
    task_gate_status=$?
    if [ "$task_gate_status" -ne 0 ]; then
        echo "[cloudbench] FATAL: task gate resolution failed (exit $task_gate_status)" >&2
        return "$task_gate_status"
    fi
    while IFS= read -r entry; do
        [ -n "$entry" ] && TASK_WORKER_ENV+=("$entry")
    done <<< "$task_env_output"
    return 0
}
# DEMO cache route. Only demo_cache:on tasks replay the frozen shared
# cache through the production pooler; every other guest keeps the cache in its
# isolated local DB (as local isolated stacks already do), so a LIVE fleet holds
# no production pooler client slots for the cache. Infra probes never run their
# sampled task and always stay local. The local route also blanks any inherited
# FAST_MODE_CACHE_DATABASE_URL, which run.sh would otherwise prefer.
STACK_CACHE_ENV=()
resolve_demo_cache_route() {
    local cache_python cache_status
    STACK_CACHE_ENV=()
    if [ "${CLOUDBENCH_INFRA_PROBE:-0}" = "1" ]; then
        STACK_CACHE_ENV+=("FAST_MODE_CACHE_USE_LOCAL=1" "FAST_MODE_CACHE_DATABASE_URL=")
        return 0
    fi
    cache_python="${CLOUDBENCH_TASK_GATE_PYTHON:-$(command -v python3 || true)}"
    if [ -z "$cache_python" ]; then
        echo "[cloudbench] FATAL: no Python interpreter is available for DEMO cache routing" >&2
        return 1
    fi
    "$cache_python" "$CATALOG_SCRIPT" needs-shared-demo-cache \
        "$REPO_DIR/agents/benchmarks/tasks.json" "${BENCH_TASK_LIST[@]}"
    cache_status=$?
    case "$cache_status" in
        0)
            # A shared-cache (DEMO) guest still reads the production pooler. A
            # small pool keeps a 50-guest fleet at 200 of its 1,000 clients; Fly's
            # ~12 ms round trip serves the replay's ~40 reads/s through 4. Clear
            # an inherited local route so run.sh keeps the shared cache.
            STACK_CACHE_ENV+=("FAST_MODE_CACHE_USE_LOCAL=0" "FAST_CACHE_DB_POOL=${CLOUDBENCH_SHARED_CACHE_DB_POOL:-4}")
            # Same write policy as local isolated stacks: a shared-cache miss
            # fails loudly instead of calling a live model.
            "$cache_python" "$CATALOG_SCRIPT" shared-demo-cache-read-only \
                "$REPO_DIR/agents/benchmarks/tasks.json" "${BENCH_TASK_LIST[@]}"
            cache_status=$?
            case "$cache_status" in
                0) STACK_CACHE_ENV+=("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH=1") ;;
                10) ;;
                *)
                    echo "[cloudbench] FATAL: DEMO cache write policy failed (exit $cache_status)" >&2
                    return "$cache_status"
                    ;;
            esac
            ;;
        10)
            STACK_CACHE_ENV+=("FAST_MODE_CACHE_USE_LOCAL=1" "FAST_MODE_CACHE_DATABASE_URL=")
            ;;
        *)
            echo "[cloudbench] FATAL: DEMO cache routing failed (exit $cache_status)" >&2
            return "$cache_status"
            ;;
    esac
}
for task_name in "${BENCH_TASK_LIST[@]}"; do
    case "$task_name" in
        agent-payment-test-shop|agent-payment-idempotent-abandonment|agent-payment-abandonment|agent-payment-setup-resume)
            BENCH_NEEDS_BUNDLED_FRONTEND=1
            BENCH_NEEDS_AGENTCARD_ONBOARDING=1
            BENCH_NEEDS_PAYMENT_FIXTURE=1
            ;;
        browser-auth-guest-purchase|browser-auth-member-discount-purchase|browser-auth-member-discount-signup-fails-purchase|browser-auth-paid-membership-purchase|browser-auth-signup-purchase|browser-auth-session-expires-at-checkout)
            # Rose Shop is served by the backend, so no bundled frontend; the
            # checkout settles through the same sandbox payment fixture.
            BENCH_NEEDS_AGENTCARD_ONBOARDING=1
            BENCH_NEEDS_PAYMENT_FIXTURE=1
            ;;
        agent-payment-new-user-journey)
            BENCH_NEEDS_BUNDLED_FRONTEND=1
            BENCH_NEEDS_AGENTCARD_ONBOARDING=1
            BENCH_NEEDS_NEW_USER_CHECKOUT=1
            ;;
        browser-auth-signup-purchase-no-subscription)
            BENCH_NEEDS_AGENTCARD_ONBOARDING=1
            BENCH_NEEDS_NEW_USER_CHECKOUT=1
            ;;
        gate-subscription-card-mint|gate-kyc-card-mint)
            BENCH_NEEDS_BUNDLED_FRONTEND=1
            BENCH_NEEDS_AGENTCARD_ONBOARDING=1
            ;;
    esac
done
if [ "$BENCH_NEEDS_NEW_USER_CHECKOUT" = "1" ] && [ "$BENCH_SIMULATE" = "1" ]; then
    log "FATAL: new-user payment journey requires real mode for Stripe Checkout and settlement"
    exit 2
fi

# An infra probe boots the isolated stack but never runs its sampled task.
# Payment task names otherwise request a production frontend build that needs
# the real task's 8 GB primary; the probe deliberately borrows a 4 GB pool
# primary. Keep bundled frontend builds for real payment runs only.
if [ "${CLOUDBENCH_INFRA_PROBE:-0}" = "1" ]; then
    BENCH_NEEDS_BUNDLED_FRONTEND=0
fi

render_task_worker_exports() {
    local entry
    if [ "${#TASK_WORKER_ENV[@]}" -eq 0 ]; then
        return
    fi
    for entry in "${TASK_WORKER_ENV[@]}"; do
        printf 'export %q\n' "$entry"
    done
}
TASK_WORKER_EXPORTS=""

if [ "${CLOUDBENCH_PRINT_TASK_ENV:-0}" = "1" ]; then
    resolve_task_gate || exit $?
    resolve_demo_cache_route || exit $?
    TASK_WORKER_EXPORTS="$(render_task_worker_exports)"
    if [ "${#TASK_WORKER_ENV[@]}" -gt 0 ]; then
        for entry in "${TASK_WORKER_ENV[@]}"; do
            printf 'stack:%s\n' "$entry"
        done
    fi
    if [ "${#STACK_CACHE_ENV[@]}" -gt 0 ]; then
        for entry in "${STACK_CACHE_ENV[@]}"; do
            printf 'stack:%s\n' "$entry"
        done
    fi
    if [ -n "$TASK_WORKER_EXPORTS" ]; then
        while IFS= read -r entry; do
            printf 'benchmark:%s\n' "$entry"
        done <<< "$TASK_WORKER_EXPORTS"
    fi
    exit 0
fi

emit_report_and_result() {
    # Always surface whatever report card / run results exist, even on failure,
    # so the controller can retrieve output from /data/bench.log as a fallback
    # even when the direct-fetch ssh reads race the machine stop.
    local card="$CONTEXT_DIR/report-card.json"
    local latest_run emitted_run=""
    latest_run="$(python3 "$CURRENT_RUN_ARTIFACT_SCRIPT" "$REPO_DIR/agents/benchmarks/runs" "$RUN_OUTPUT_MARKER" 2>/dev/null || true)"
    if [ -n "$latest_run" ] && [ -f "$latest_run" ]; then
        if [ "${CLOUDBENCH_REQUIRE_EXECUTION_PROVENANCE:-0}" = "1" ]; then
            if python3 "$EXECUTION_PROVENANCE_SCRIPT" stamp \
                --run-json "$latest_run" \
                --provenance "$CLOUDBENCH_EXECUTION_PROVENANCE_FILE" \
                --output "$CONTEXT_DIR/run.json"; then
                emitted_run="$CONTEXT_DIR/run.json"
            else
                echo "[cloudbench] FATAL: could not stamp execution provenance"
                rm -f "$CONTEXT_DIR/run.json" 2>/dev/null || true
            fi
        elif cp -f "$latest_run" "$CONTEXT_DIR/run.json" 2>/dev/null; then
            emitted_run="$CONTEXT_DIR/run.json"
        fi
        [ -z "$emitted_run" ] \
            || chown "$APP_USER:$APP_USER" "$emitted_run" 2>/dev/null || true
    fi
    echo "$REPORT_BEGIN"
    if [ -f "$card" ] && [ "$card" -nt "$RUN_OUTPUT_MARKER" ]; then
        cat "$card"
    else
        echo '{"error":"no report-card.json produced"}'
    fi
    echo ""
    echo "$REPORT_END"

    echo "$RESULT_BEGIN"
    if [ -n "$emitted_run" ] && [ -f "$emitted_run" ]; then
        echo "run_file: $emitted_run"
        cat "$CONTEXT_DIR/run.json"
    else
        echo '{"error":"no fresh matching benchmark run produced"}'
    fi
    echo ""
    echo "$RESULT_END"
}

# Best-effort teardown of the static dashboard server started in step 5.
DASH_PID=""
STATUS_PID=""
stop_dashboard() {
    [ -n "$DASH_PID" ] || return 0
    kill "$DASH_PID" 2>/dev/null || true
    DASH_PID=""
}

stop_status_server() {
    [ -n "$STATUS_PID" ] || return 0
    kill "$STATUS_PID" 2>/dev/null || true
    STATUS_PID=""
}

finish() {
    local code="${1:-0}"
    emit_report_and_result || true
    stop_dashboard
    echo "$DONE_MARKER exit=$code"
    exit "$code"
}

if [ -n "$CLOUDBENCH_START_BARRIER" ]; then
    case "$CLOUDBENCH_START_BARRIER" in
        *[!a-zA-Z0-9._-]*)
            log "FATAL: invalid synchronized start barrier token"
            finish 1
            ;;
    esac
fi

# A configured controller authority is installed atomically over exact-machine
# SFTP. No envelope enters provider config, script payloads or runtime artifacts.
unset CODEX_AUTH_PATH
if [ -n "${CLOUDBENCH_CODEX_AUTH_SHA256:-}" ]; then
    CODEX_AUTH_ADMISSION_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')" || finish 1
    if CLOUDBENCH_HEARTBEAT_SECONDS=1 run_with_heartbeat credential-handoff \
        python3 "$CODEX_AUTH_HELPER" wait --run-token "$CLOUDBENCH_RUN_TOKEN" \
        --machine-id "${CLOUDBENCH_CODEX_AUTH_MACHINE_ID:-}" \
        --sha256 "$CLOUDBENCH_CODEX_AUTH_SHA256" --user "$APP_USER" \
        --admission-token "$CODEX_AUTH_ADMISSION_TOKEN"; then
        :
    else
        codex_auth_rc=$?
        log "FATAL: explicit Codex auth handoff failed before benchmark setup"
        finish "$codex_auth_rc"
    fi
    export CODEX_AUTH_PATH="/tmp/rose-cloudbench-codex/$CLOUDBENCH_RUN_TOKEN-$CLOUDBENCH_CODEX_AUTH_MACHINE_ID/auth.json"
fi

# ── 0. Sanity: the volume + repo checkout must exist (created at box setup) ──
if [ "${CLOUDBENCH_COLD_PRIMARY_BOOTSTRAP:-0}" = 1 ] || { [ "${CLOUDBENCH_FRESH_VOLUME:-0}" = 1 ] && [ ! -d "$REPO_DIR/.git" ]; }; then
    [ "$BENCH_SIMULATE" = 0 ] && [ -n "$REF" ] || { log "FATAL: fresh checkout requires an exact REAL task ref"; finish 1; }
    if ! CLOUDBENCH_REQUIRE_EMPTY_CHECKOUT="${CLOUDBENCH_COLD_PRIMARY_BOOTSTRAP:-0}" CLOUDBENCH_APP_USER="$APP_USER" bash "$FETCH_REF_SCRIPT" "$REPO_DIR" "$REF" 2>&1 | sed 's/^/   /'; then
        log "FATAL: could not bootstrap requested ref on fresh storage"
        finish 1
    fi
fi
if [ ! -d "$REPO_DIR/.git" ]; then
    log "FATAL: $REPO_DIR is not a git checkout (expected a pre-authed volume checkout)"
    finish 1
fi
cd "$REPO_DIR" || { log "FATAL: cannot cd $REPO_DIR"; finish 1; }

# Snapshot clones retain the source machine's ignored .context tree. Clear it
# before any setup step that can fail so an infrastructure error can never be
# presented as a benchmark result from the snapshot's previous run.
rm -rf "$CONTEXT_DIR"
mkdir -p "$CONTEXT_DIR"
chown -R "$APP_USER:$APP_USER" "$REPO_DIR/.context"
touch "$RUN_OUTPUT_MARKER"
printf '%s\n' "$$" > "$DATA_DIR/cloudbench-driver.pid"
if [ -n "$CLOUDBENCH_START_BARRIER" ]; then
    rm -f "$DATA_DIR/cloudbench-start-$CLOUDBENCH_START_BARRIER.ready" \
        "$DATA_DIR/cloudbench-start-$CLOUDBENCH_START_BARRIER.release"
fi

# ── 1. git-sync the branch/sha under test ───────────────────────────────────
step git_sync
# The volume checkout's origin URL already embeds a working repo token (set at
# box provisioning), so a plain fetch/checkout/reset needs NO token handling here.
if [ -n "$REF" ]; then
    log "git-syncing + verifying $REPO_DIR → $REF"
    if ! CLOUDBENCH_REQUIRE_EMPTY_CHECKOUT=0 CLOUDBENCH_APP_USER="$APP_USER" bash "$FETCH_REF_SCRIPT" "$REPO_DIR" "$REF" 2>&1 | sed 's/^/   /'; then
        log "FATAL: could not verify requested ref $REF"
        finish 1
    fi
fi
# The controller credential is needed only for this exact fetch. Do not let it
# flow into the benchmark stack, workers, or agent subprocess environments.
unset CLOUDBENCH_GITHUB_TOKEN_B64
# reset --hard does not remove untracked files created by an earlier uploaded
# worktree patch. Remove only non-ignored untracked files; dependency/cache trees
# are ignored and remain warm.
clean_exclusions=()
if [ -e "$REPO_DIR/.cloudbench-deps-overlays" ] || [ -L "$REPO_DIR/.cloudbench-deps-overlays" ]; then
    if ! bash "$SYNC_DEPS_SCRIPT" --verify-overlay-cache "$DEPS_DIR" "$REPO_DIR"; then
        log "FATAL: invalid dependency overlay cache before worktree cleanup"
        finish 1
    fi
    clean_exclusions=(-e '/.cloudbench-deps-overlays/')
fi
if ! gosu "$APP_USER" git -C "$REPO_DIR" clean -ffd "${clean_exclusions[@]}" 2>&1 | sed 's/^/   /'; then
    log "FATAL: could not remove stale untracked worktree files"
    finish 1
fi
log "checkout at $(gosu "$APP_USER" git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ -n "${LOCAL_PATCH_FILE:-}" ]; then
    [ -s "$LOCAL_PATCH_FILE" ] || {
        log "FATAL: declared local patch payload is missing or empty"
        finish 1
    }
    [ -n "${LOCAL_PATCH_SHA256:-}" ] || {
        log "FATAL: local patch payload has no checksum"
        finish 1
    }
    # The controller may compress the patch, because flyctl embeds it
    # base64-encoded in the machine-config body and Fly caps that body. Verify
    # the bytes that actually arrived, then the decompressed patch against the
    # plaintext digest that execution provenance is bound to.
    _patch_payload="$LOCAL_PATCH_FILE"
    case "${LOCAL_PATCH_COMPRESSION:-none}" in
        ""|none) ;;
        gzip)
            [ -n "${LOCAL_PATCH_TRANSPORT_SHA256:-}" ] || {
                log "FATAL: compressed patch payload has no transport checksum"
                finish 1
            }
            _transport_sha="$(sha256sum "$LOCAL_PATCH_FILE" | awk '{print $1}')"
            [ "$_transport_sha" = "$LOCAL_PATCH_TRANSPORT_SHA256" ] || {
                log "FATAL: compressed patch transport checksum mismatch"
                finish 1
            }
            _patch_payload="$CONTROL_DIR/cloudbench-local.patch"
            if ! gzip -dc "$LOCAL_PATCH_FILE" > "$_patch_payload"; then
                log "FATAL: could not decompress uploaded local workspace patch"
                finish 1
            fi
            ;;
        *)
            log "FATAL: unknown local patch compression '${LOCAL_PATCH_COMPRESSION}'"
            finish 1
            ;;
    esac
    [ -s "$_patch_payload" ] || {
        log "FATAL: local patch payload is empty after transport"
        finish 1
    }
    _actual_patch_sha="$(sha256sum "$_patch_payload" | awk '{print $1}')"
    [ "$_actual_patch_sha" = "$LOCAL_PATCH_SHA256" ] || {
        log "FATAL: patch payload checksum mismatch"
        finish 1
    }
    log "applying uploaded local workspace patch on top of checkout"
    if ! bash "$PREPARE_PATCH_SCRIPT" "$REPO_DIR" "$_patch_payload"; then
        log "FATAL: could not prepare uploaded local workspace patch"
        finish 1
    fi
    if ! gosu "$APP_USER" git -C "$REPO_DIR" apply --whitespace=nowarn - \
        < "$_patch_payload" 2>&1 | sed 's/^/   /'; then
        log "FATAL: could not apply uploaded local workspace patch"
        finish 1
    fi
    log "verified local workspace patch $_actual_patch_sha"
fi

# Gate metadata belongs to the exact requested+patched catalog, but its parser
# is immutable controller code. Never import Python from a stale warm checkout
# before git-sync, and never let arbitrary ref code replace this decision.
resolve_task_gate
task_gate_status=$?
if [ "$task_gate_status" -ne 0 ]; then
    finish "$task_gate_status"
fi
resolve_demo_cache_route
demo_cache_route_status=$?
if [ "$demo_cache_route_status" -ne 0 ]; then
    finish "$demo_cache_route_status"
fi
TASK_WORKER_EXPORTS="$(render_task_worker_exports)"

# Replace the bootstrap read-only http.server with the ref's authenticated
# data-plane server. The same WireGuard proxy keeps serving bench.log, while the
# controller can now release the synchronized barrier without an SSH/API burst.
pkill -f "http.server $CLOUDBENCH_STATUS_PORT" 2>/dev/null || true
pkill -f "cloudbench-status-server.py.*--port $CLOUDBENCH_STATUS_PORT" 2>/dev/null || true
if [ ! -f "$STATUS_SERVER_SCRIPT" ]; then
    log "FATAL: missing $STATUS_SERVER_SCRIPT"
    finish 1
fi
setsid python3 "$STATUS_SERVER_SCRIPT" \
    --directory "$DATA_DIR" \
    --port "$CLOUDBENCH_STATUS_PORT" \
    --barrier "$CLOUDBENCH_START_BARRIER" \
    --run-token "${CLOUDBENCH_RUN_TOKEN:-}" \
    >/dev/null 2>&1 </dev/null &
STATUS_PID=$!

# ── 2. Decode injected secrets into the repo .env files the stack reads ─────
step env_decode
# Fly secrets are exposed as env vars in the machine init AND in ssh sessions.
[ -f "$ENV_HELPER" ] || { log "FATAL: missing $ENV_HELPER"; finish 1; }
# shellcheck source=lib/cloudbench-env.sh
source "$ENV_HELPER"
umask 077
if [ -n "${AGENTS_ENV_B64:-}" ]; then
    echo "$AGENTS_ENV_B64" | base64 -d > "$REPO_DIR/agents/.env" || { log "FATAL: failed to decode AGENTS_ENV_B64"; finish 1; }
    log "wrote agents/.env ($(wc -l < "$REPO_DIR/agents/.env") lines)"
else
    log "FATAL: AGENTS_ENV_B64 secret is not set"; finish 1
fi
if [ -n "${BACKEND_ENV_B64:-}" ]; then
    echo "$BACKEND_ENV_B64" | base64 -d > "$REPO_DIR/back-end/.env" || { log "FATAL: failed to decode BACKEND_ENV_B64"; finish 1; }
    log "wrote back-end/.env ($(wc -l < "$REPO_DIR/back-end/.env") lines)"
else
    log "FATAL: BACKEND_ENV_B64 secret is not set"; finish 1
fi
chown "$APP_USER:$APP_USER" "$REPO_DIR/agents/.env" "$REPO_DIR/back-end/.env"
chmod 600 "$REPO_DIR/agents/.env" "$REPO_DIR/back-end/.env"
cloudbench_verify_env_file "$REPO_DIR/agents/.env" "${AGENTS_ENV_SHA256:-}" agents || finish 1
cloudbench_verify_env_file "$REPO_DIR/back-end/.env" "${BACKEND_ENV_SHA256:-}" backend || finish 1
cloudbench_require_guest_temporal_namespace "$REPO_DIR/agents/.env" "$REPO_DIR/back-end/.env" \
    "${CLOUDBENCH_EXPECTED_GUEST_TEMPORAL_NAMESPACE:-}" || finish 1
cloudbench_require_agentcard_org_oauth "$REPO_DIR/back-end/.env" || finish 1
cloudbench_apply_compute_token_authority "$REPO_DIR/back-end/.env" || finish 1
cloudbench_validate_browser_provider_contract \
    "$REPO_DIR/agents/.env" "$REPO_DIR/back-end/.env" \
    "${CLOUDBENCH_BROWSER_PROVIDER:-}" "${CLOUDBENCH_BROWSER_PROVIDER:-}" || finish 1
FRONTEND_SUPABASE_URL="$(cloudbench_env_value "$REPO_DIR/back-end/.env" VITE_SUPABASE_URL)"
[ -n "$FRONTEND_SUPABASE_URL" ] || FRONTEND_SUPABASE_URL="$(cloudbench_env_value "$REPO_DIR/back-end/.env" SUPABASE_URL)"
FRONTEND_SUPABASE_ANON_KEY="$(cloudbench_env_value "$REPO_DIR/back-end/.env" VITE_SUPABASE_ANON_KEY)"
[ -n "$FRONTEND_SUPABASE_ANON_KEY" ] || FRONTEND_SUPABASE_ANON_KEY="$(cloudbench_env_value "$REPO_DIR/agents/.env" SUPABASE_ANON_KEY)"
if [ "$BENCH_NEEDS_BUNDLED_FRONTEND" = "1" ]; then
    [ -n "$FRONTEND_SUPABASE_URL" ] || { log "FATAL: bundled frontend benchmark is missing VITE_SUPABASE_URL/SUPABASE_URL"; finish 1; }
    [ -n "$FRONTEND_SUPABASE_ANON_KEY" ] || { log "FATAL: bundled frontend benchmark is missing VITE_SUPABASE_ANON_KEY/SUPABASE_ANON_KEY"; finish 1; }
fi

# ── 3. Sync baked deps from the image into the volume checkout ──────────────
step dep_sync
# A persistent volume can outlive many donor images. Missing-only checks leave
# old package trees behind after package-lock/requirements changes, so compare
# fingerprints and refresh atomically from the image. A donor/ref mismatch is a
# hard infrastructure error: the image must be rebuilt before this ref can run.
if ! bash "$SYNC_DEPS_SCRIPT" "$DEPS_DIR" "$REPO_DIR"; then
    log "FATAL: cloudbench dependency synchronization failed"
    finish 1
fi

# Prisma's generated client is compiled from schema.prisma, not just the npm
# manifests. A warm dependency tree can therefore be package-current but
# schema-stale when a benchmark checks out another ref or applies a local patch.
chown -R "$APP_USER:$APP_USER" "$REPO_DIR/node_modules" "$REPO_DIR/back-end/node_modules" "$REPO_DIR/agents/venv" 2>/dev/null || true
if ! bash "$SYNC_PRISMA_SCRIPT" "$REPO_DIR" "$APP_USER"; then
    log "FATAL: Prisma client synchronization failed"
    finish 1
fi

# The DB warm-start dump lives on the /data volume (persists across stop/start +
# fork) but must be writable by $APP_USER — /data itself is root-owned and
# /data/repo gets `git reset --hard`'d, so use a dedicated cache dir we chown.
mkdir -p "$DATA_DIR/cloudbench-cache" && chown "$APP_USER:$APP_USER" "$DATA_DIR/cloudbench-cache" 2>/dev/null || true

# The warm image omits local Chromium because ordinary simulated benches use
# remote/browser-model boundaries. Hosted Stripe Checkout in this daily task
# needs a real browser on the box; keep its binary cache on the persistent volume.
if [ "$BENCH_NEEDS_NEW_USER_CHECKOUT" = "1" ]; then
    step checkout_browser
    export PLAYWRIGHT_BROWSERS_PATH=/data/cloudbench-cache/playwright-browsers
    mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
    chown -R "$APP_USER:$APP_USER" "$PLAYWRIGHT_BROWSERS_PATH"
    if [ ! -f /var/lib/rose-playwright-chromium-deps ]; then
        if ! "$REPO_DIR/agents/venv/bin/python" -m playwright install-deps chromium; then
            log "FATAL: could not install Chromium system dependencies"
            finish 1
        fi
        touch /var/lib/rose-playwright-chromium-deps
    fi
    if ! gosu "$APP_USER" env -u PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD HOME="/home/$APP_USER" PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
            "$REPO_DIR/agents/venv/bin/python" -m playwright install chromium; then
        log "FATAL: could not install Playwright Chromium for subscription Checkout"
        finish 1
    fi
fi

# ── 4. Pin a stable single-tenant workspace + base port for this box ────────
BASE_PORT="${CONDUCTOR_PORT:-3001}"
WORKSPACE_NAME="${CONDUCTOR_WORKSPACE_NAME:-cloudbench}"
WORKSPACE_NAME_SHELL=$(printf '%q' "$WORKSPACE_NAME")
cat > "$REPO_DIR/.cloud-env" <<EOF
# Generated by cloudbench-run.sh — single-tenant warm cloud bench box.
export CONDUCTOR_PORT=${BASE_PORT}
export CONDUCTOR_WORKSPACE_NAME=${WORKSPACE_NAME_SHELL}
export CONDUCTOR_ROOT_PATH=${REPO_DIR}
EOF
chown "$APP_USER:$APP_USER" "$REPO_DIR/.cloud-env"
WMH_PORT=$((BASE_PORT + 6))   # run.sh: WMH_PORT = base + 6 (3001 → 3007).

# ── 5. System Postgres (no Docker on Fly) ──────────────────────────────────
step postgres
log "ensuring system Postgres cluster (victoria on :5432)..."
PG_VER="$(pg_lsclusters -h 2>/dev/null | head -1 | awk '{print $1}')"
if [ -z "$PG_VER" ]; then
    PG_VER="$(ls /usr/lib/postgresql 2>/dev/null | sort -V | tail -1)"
    if [ -n "$PG_VER" ]; then
        pg_createcluster "$PG_VER" main 2>/dev/null || true
    fi
fi
pg_ctlcluster "$PG_VER" main start 2>/dev/null || service postgresql start 2>/dev/null || true

PG_READY=false
for _ in $(seq 1 30); do
    if pg_isready -h localhost -p 5432 -U postgres -q 2>/dev/null || pg_isready -q 2>/dev/null; then
        PG_READY=true
        break
    fi
    sleep 1
done
if ! $PG_READY; then
    log "FATAL: system Postgres did not become ready"
    pg_lsclusters || true
    finish 1
fi
su - postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\"" 2>/dev/null || true
su - postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='victoria'\" | grep -q 1 || createdb victoria" 2>/dev/null || true
PG_HBA="$(find /etc/postgresql -name pg_hba.conf 2>/dev/null | head -1)"
if [ -n "$PG_HBA" ]; then
    sed -i 's/^local\s\+all\s\+all\s\+peer/local   all             all                                     md5/' "$PG_HBA"
    sed -i 's/^\(host\s\+all\s\+all\s\+127\.0\.0\.1\/32\s\+\)\(scram-sha-256\|ident\)/\1md5/' "$PG_HBA"
    sed -i 's/^\(host\s\+all\s\+all\s\+::1\/128\s\+\)\(scram-sha-256\|ident\)/\1md5/' "$PG_HBA"
    pg_ctlcluster "$PG_VER" main reload 2>/dev/null || service postgresql reload 2>/dev/null || true
fi
log "system Postgres ready (victoria on :5432)"

# ── 6. Guard the cached WMH model (simulate serves it verbatim — no R2 read) ─
# Begin cached WMH guard.
# Prints the reason and returns 1 when the volume cannot serve WMH_ENGINE's
# model without building or installing anything at run time.
cloudbench_cached_wmh_problem() {
    if [ ! -f "$WMH_DIR/build.manifest.json" ] || [ ! -d "$WMH_DIR/models/$WMH_MODEL_NAME" ]; then
        echo "no cached WMH model at $WMH_DIR/models/$WMH_MODEL_NAME"
        return 1
    fi
    [ "$WMH_ENGINE" = experiential ] || return 0
    if [ ! -f "$WMH_DIR/models/$WMH_MODEL_NAME/experiential.json" ]; then
        echo "cached WMH model $WMH_MODEL_NAME has no native pointer models/$WMH_MODEL_NAME/experiential.json"
        return 1
    fi
    if [ ! -x "$WMH_NATIVE_VENV/bin/python" ]; then
        echo "native WMH venv is absent at $WMH_NATIVE_VENV"
        return 1
    fi
    local wanted recorded
    wanted="$(sha256sum "$REPO_DIR/agents/requirements-world-model.txt" 2>/dev/null | cut -d ' ' -f 1)"
    recorded="$(cat "$WMH_NATIVE_VENV/requirements.sha256" 2>/dev/null || true)"
    if [ -z "$wanted" ] || [ "$wanted" != "$recorded" ]; then
        echo "native WMH venv at $WMH_NATIVE_VENV does not match agents/requirements-world-model.txt at this ref"
        return 1
    fi
    return 0
}
# End cached WMH guard.
if [ "$BENCH_SIMULATE" = "1" ]; then
    if ! WMH_GUARD_PROBLEM="$(cloudbench_cached_wmh_problem)"; then
        log "FATAL: $WMH_GUARD_PROBLEM (engine=$WMH_ENGINE)"
        log "       (expected a PRE-BUILT volume model + native venv — never build or install at run time;"
        log "        publish them with: bash scripts/run-bench-cloud --refresh-wmh)"
        finish 1
    fi
fi

chown -R "$APP_USER:$APP_USER" "$WMH_DIR" 2>/dev/null || true

# ── 7. Stage + serve the live dashboard (proxied to the Mac by run-bench-cloud) ─
# Copy dashboard.html into the context dir (same logic as
# benchmarks/dashboard.py:write_dashboard_asset — the page fetch()es
# report-card.json from its own directory, so the asset must sit alongside it),
# then serve that dir over HTTP on DASHPORT. run-bench-cloud `flyctl proxy`es this
# port to the Mac and opens http://localhost:<localport>/dashboard.html in Chrome.
DASH_SRC="$REPO_DIR/agents/benchmarks/dashboard.html"
if [ -f "$DASH_SRC" ]; then
    cp -f "$DASH_SRC" "$CONTEXT_DIR/dashboard.html" 2>/dev/null || true
    chown "$APP_USER:$APP_USER" "$CONTEXT_DIR/dashboard.html" 2>/dev/null || true
    log "staged dashboard asset → $CONTEXT_DIR/dashboard.html"
else
    log "WARN: dashboard.html not found at $DASH_SRC — dashboard page will 404 (run continues)"
fi
# Serve the context dir. python3 http.server binds all interfaces so the Fly
# proxy (which connects to the machine's private IP) can reach it.
gosu "$APP_USER" env HOME=/home/$APP_USER \
    python3 -m http.server "$BENCH_DASHPORT" --directory "$CONTEXT_DIR" \
    > "$CONTEXT_DIR/dashboard-server.log" 2>&1 &
DASH_PID=$!
log "dashboard static server pid=$DASH_PID on :$BENCH_DASHPORT (root $CONTEXT_DIR)"

# ── 8. Launch the stack (run.sh --benchmark) — SERVE the cached WMH ─────────
step stack_launch
# WMH_BUILD_DIR points run.sh at the cached model on the volume;
# BENCHMARK_SKIP_WMH_DELTA=1 makes run.sh SERVE it verbatim with NO R2 read / delta
# refresh / rebuild. FLY_APP_NAME="" disables the worker's prod-style fleet
# autoscaler (the Fly runtime injects the app name; _scale_fleet() would otherwise
# hammer the Fly API with the prod-scoped token → 403 log spam).
ensure_cloudflared_agent() {
    command -v cloudflared >/dev/null 2>&1 && return 0
    log "cloudflared missing from warm image — installing official release"
    local attempt
    for attempt in 1 2 3; do
        rm -f /tmp/cloudflared.deb
        if curl -fsSL --connect-timeout 10 --max-time 120 \
                "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb" \
                -o /tmp/cloudflared.deb \
            && apt-get install -y -qq --no-install-recommends /tmp/cloudflared.deb; then
            rm -f /tmp/cloudflared.deb
            command -v cloudflared >/dev/null 2>&1 && return 0
        fi
        log "cloudflared install attempt $attempt/3 failed"
        sleep 2
    done
    rm -f /tmp/cloudflared.deb
    return 1
}

if [ "$BENCH_SIMULATE" != "1" ]; then
    if ! ensure_cloudflared_agent; then
        log "FATAL: could not install cloudflared for isolated benchmark webhooks"
        finish 1
    fi
fi

STACK_LOG="$CONTEXT_DIR/stack.log"
STACK_ENV=(
    "HOME=/home/$APP_USER"
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    "BENCHMARK_ISOLATED_RUN=true"
    # Every warm machine restores the same canonical DB fixture. Its seeded
    # BrowserProviderProfile names one external Kernel profile, so database
    # isolation alone cannot prevent concurrent machines from sharing browser
    # state. Allocate a run-local provider profile; server shutdown deletes it.
    "BENCHMARK_ISOLATED_BROWSER_PROFILES=true"
    "BENCHMARK_CONTEXT_DIR=$CONTEXT_DIR"
    "RUN_STACK_CLEANUP_STATUS_FILE=$STACK_CLEANUP_STATUS_FILE"
    "RUN_STACK_CLEANUP_TOKEN=$CLOUDBENCH_RUN_TOKEN"
    "BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE=$CONTEXT_DIR/sms-web-search-fixture.json"
    "CONDUCTOR_PORT=$BASE_PORT"
    "CONDUCTOR_WORKSPACE_NAME=$WORKSPACE_NAME"
    "BENCHMARK_RUN_ID=$WORKSPACE_NAME"
    "ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1"
    "DISABLE_GMAIL_SYNC=1"
    "FLY_APP_NAME="
    # Compute-only autoscaler: the box worker still computes desired_machine_count
    # (exposed on HEALTH_CHECK_PORT/metrics with prod's params) but NEVER actuates
    # the shared bench app. run-bench-cloud's per-bench autoscaler is the sole
    # scaler, cloning bench-queue-scoped worker machines. FLY_APP_NAME="" already
    # short-circuits _scale_fleet; this makes the intent explicit + defends the
    # worker-only pool nodes too.
    "AUTOSCALER_ACTUATE=0"
    # A bench starts at ONE machine (the box itself). The worker then computes
    # desired off its own queue with prod's scale params; the controller adds
    # workers from there. Prod's default MIN=2 would make an idle bench look like
    # it wants a 2nd machine, so pin the per-bench floor to 1.
    "MIN_MACHINES=1"
    # Canonical base fixture: run.sh restores this /data dump (persists across
    # stop/start + fork), but validates it against the immutable shared artifact
    # identity before use. A miss must not silently substitute a prod cold-sync.
    "BENCHMARK_SEED_DUMP=$STACK_SEED_DUMP"
    "BENCHMARK_REQUIRE_SEED_DUMP=1"
    "WMH_MODEL_NAME=$WMH_MODEL_NAME"
    "WMH_BUILD_DIR=$WMH_DIR"
    "BENCHMARK_SKIP_WMH_DELTA=1"
    # serve_world_model selects its engine/pool/policy from these.
    "WMH_ENGINE=$WMH_ENGINE"
    "WMH_ROSE_POOL=$WMH_ROSE_POOL"
    "WMH_EXECUTION_POLICY=$WMH_EXECUTION_POLICY"
    # One isolated guest runs one benchmark. A single worker still supports many
    # workflow/activity slots; eight workers per guest at fleet width exhaust
    # the shared Temporal namespace poll budget and delay stack health by minutes.
    "BENCHMARK_AGENT_WORKERS=${BENCHMARK_AGENT_WORKERS:-1}"
    # The isolated stack is launched through `env` with this allow-list. Keep the
    # controller's provider exclusion inside that environment so the WMH Rose
    # provider cannot lease/use Claude after the outer runner explicitly disabled
    # the Anthropic family.
    "ROSE_EXCLUDE_ANTHROPIC_FAMILY=${ROSE_EXCLUDE_ANTHROPIC_FAMILY:-}"
)
if [ -n "$WMH_CONTEXT_TOKENS" ]; then
    STACK_ENV+=("WMH_CONTEXT_TOKENS=$WMH_CONTEXT_TOKENS")
fi
if [ "$WMH_ENGINE" = experiential ]; then
    # Pin the guarded, pre-created interpreter: setup-world-model.sh then only
    # validates it and never runs uv on the guest.
    STACK_ENV+=("WMH_NATIVE_PYTHON=$WMH_NATIVE_VENV/bin/python")
    # Native inference settings validated by the local instantiate-whm runs
    # (.claude/skills/instantiate-whm/scripts/run-trajectory.sh).
    STACK_ENV+=(
        "WMH_INFERENCE_POOL=${WMH_INFERENCE_POOL:-rose-1-flash}"
        "WMH_AZURE_FIRST=${WMH_AZURE_FIRST:-1}"
        "WMH_EXCLUDE_FAILED_TOOL_EXAMPLES=${WMH_EXCLUDE_FAILED_TOOL_EXAMPLES:-1}"
        "WMH_JSON_MODE=${WMH_JSON_MODE:-1}"
    )
fi
if [ -n "$BENCHMARK_FAST_MODE_CACHE" ]; then
    STACK_ENV+=("BENCHMARK_FAST_MODE_CACHE=$BENCHMARK_FAST_MODE_CACHE")
fi
if [ -n "${FAST_MODE_CACHE_DISABLE_WRITE_THROUGH:-}" ]; then
    STACK_ENV+=("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH=$FAST_MODE_CACHE_DISABLE_WRITE_THROUGH")
fi
if [ "${BENCHMARK_DEMO_CACHE_READ_ONLY:-}" = 1 ]; then
    STACK_ENV+=("BENCHMARK_DEMO_CACHE_READ_ONLY=1")
fi
if [ -n "$BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY" ]; then
    STACK_ENV+=("BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY=$BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY")
fi
if [ -n "$BENCHMARK_PEAK_FLY_MACHINES" ]; then
    STACK_ENV+=("BENCHMARK_PEAK_FLY_MACHINES=$BENCHMARK_PEAK_FLY_MACHINES")
fi
if [ -n "$BENCHMARK_VM_USD_PER_HOUR" ]; then
    STACK_ENV+=("BENCHMARK_VM_USD_PER_HOUR=$BENCHMARK_VM_USD_PER_HOUR")
fi
if [ "${#STACK_CACHE_ENV[@]}" -gt 0 ]; then
    STACK_ENV+=("${STACK_CACHE_ENV[@]}")
fi
if [ "${#TASK_WORKER_ENV[@]}" -gt 0 ]; then
    STACK_ENV+=("${TASK_WORKER_ENV[@]}")
fi
case "${CLOUDBENCH_GUEST_AUTOSCALER_POLL_SECONDS:-}" in
    ''|*[!0-9]*|0) ;;
    # Controller-budgeted queue observation: N guests share the Temporal
    # namespace's Visibility API budget with production workers.
    *) STACK_ENV+=("AUTOSCALER_POLL_INTERVAL_SECONDS=$CLOUDBENCH_GUEST_AUTOSCALER_POLL_SECONDS") ;;
esac
if [ "${CLOUDBENCH_INFRA_PROBE:-0}" = "1" ]; then
    # The probe executes no benchmark task. One Temporal worker proves stack
    # readiness without starting eight idle Python processes on a 4 GB guest
    # or spending the namespace's poll budget before the real fleet starts.
    STACK_ENV+=("BENCHMARK_AGENT_WORKERS=1")
fi
if [ "$BENCH_NEEDS_BUNDLED_FRONTEND" = "1" ]; then
    STACK_ENV+=("BENCHMARK_BUNDLED_FRONTEND=true")
fi
if [ "$BENCH_NEEDS_AGENTCARD_ONBOARDING" = "1" ]; then
    STACK_ENV+=("AGENTCARD_ONBOARDING_RETURN_URL=$AGENTCARD_BENCHMARK_ONBOARDING_RETURN_URL")
fi
if [ "$BENCH_NEEDS_PAYMENT_FIXTURE" = "1" ]; then
    STACK_ENV+=(
        "BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH=1"
        "BENCHMARK_AGENT_PAYMENT_USER_ID=1f85ff25-6e29-4c1b-8739-f917bd101a30"
    )
fi
# Browser tasks without an explicit live fixture must disable saved cookies,
# provider profiles, and origin state on the backend/worker stack. Setting the
# flag only in run_benchmark's process leaves the prod-synced base auth graph on.
GUEST_AUTH_PYTHON="$REPO_DIR/agents/venv/bin/python"
if [ ! -x "$GUEST_AUTH_PYTHON" ]; then
    log "FATAL: hydrated agents Python is unavailable for saved-browser-auth fixture resolution: $GUEST_AUTH_PYTHON"
    finish 1
fi
(
    cd "$REPO_DIR/agents" || exit 1
    "$GUEST_AUTH_PYTHON" -c '
import sys
from benchmarks.spawn_contract import tasks_require_disabled_saved_browser_auth
sys.exit(0 if tasks_require_disabled_saved_browser_auth(sys.argv[1:]) else 10)
' "${BENCH_TASK_LIST[@]}"
)
guest_auth_status=$?
case "$guest_auth_status" in
    0)
        log "no-live-fixture browser task(s) detected — disabling saved browser auth on stack"
        STACK_ENV+=("BENCHMARK_DISABLE_SAVED_BROWSER_AUTH=true")
        ;;
    10)
        ;;
    *)
        log "FATAL: saved-browser-auth fixture resolution failed (exit $guest_auth_status)"
        finish "$guest_auth_status"
        ;;
esac
if [ -n "$FRONTEND_SUPABASE_URL" ]; then
    STACK_ENV+=("VITE_SUPABASE_URL=$FRONTEND_SUPABASE_URL")
fi
if [ -n "$FRONTEND_SUPABASE_ANON_KEY" ]; then
    STACK_ENV+=("VITE_SUPABASE_ANON_KEY=$FRONTEND_SUPABASE_ANON_KEY")
fi
# Resolve catalog target before stack launch. Production-only tasks run with
# --prod against roselabs.ai — they must not depend on trycloudflare/ngrok for
# stack health (NXDOMAIN / missing ngrok on clones was killing fleets before
# the start barrier even though the public tunnel was never used as {frontend_url}).
BENCH_TARGET_MODE_FOR_STACK=""
if BENCH_TARGET_PLAN_FOR_STACK="$(python3 "$BENCHMARK_TARGET_SCRIPT" \
    "$REPO_DIR/agents/benchmarks/tasks.json" "$BASE_PORT" "${BENCH_TASK_LIST[@]}" 2>/dev/null)"; then
    BENCH_TARGET_MODE_FOR_STACK="${BENCH_TARGET_PLAN_FOR_STACK%%$'\n'*}"
fi
if [ "$BENCH_SIMULATE" = "1" ]; then
    STACK_ENV+=(
        "BENCHMARK_WORLD_MODEL_MODE=simulate"
        "BENCHMARK_SKIP_PUBLIC_TUNNEL=1"
        "BENCHMARK_SKIP_BROWSER_AUTH_SYNC=1"
        "BENCHMARK_WMH_FALLBACK_ON_UNAVAILABLE=1"
        "WMH_BASE_URL=http://localhost:$WMH_PORT"
    )
elif [ "$BENCH_TARGET_MODE_FOR_STACK" = "prod" ]; then
    log "production-only target — skipping public tunnel (frontend is production)"
    STACK_ENV+=(
        "BENCHMARK_SKIP_WMH_BUILD=1"
        "BENCHMARK_SKIP_PUBLIC_TUNNEL=1"
    )
else
    # Older warm images baked cloudflared without its documented ngrok fallback.
    # Materialize the same prerequisite as cloud-init before selecting a tunnel.
    if ! bash "$NGROK_INSTALL_SCRIPT"; then
        log "FATAL: could not install ngrok for isolated benchmark webhooks"
        finish 1
    fi
    STACK_ENV+=(
        "BENCHMARK_SKIP_WMH_BUILD=1"
        # Each isolated VM gets a random Quick Tunnel URL for this run. The URL
        # is process-scoped, so concurrent benchmark stacks cannot share traffic.
        "BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL=1"
    )
fi

log "launching stack (run.sh --benchmark) — base_port=$BASE_PORT wmh_port=$WMH_PORT workspace=$WORKSPACE_NAME simulate=$BENCH_SIMULATE"
rm -f "$STACK_CLEANUP_STATUS_FILE"
gosu "$APP_USER" env "${STACK_ENV[@]}" bash "$REPO_DIR/scripts/run.sh" --benchmark > "$STACK_LOG" 2>&1 &
STACK_PID=$!
if ! STACK_NATIVE_IDENTITY="$(python3 "$CONTROL_DIR/process-identity.py" "$STACK_PID")" \
    || [ -z "$STACK_NATIVE_IDENTITY" ]; then
    log "FATAL: could not capture launched stack native identity"
    finish 1
fi
STACK_BIRTH="$(ps -p "$STACK_PID" -o lstart= | sed 's/^ *//;s/ *$//')"
log "stack pid=$STACK_PID (logs → $STACK_LOG)"

tail -n +1 -F "$STACK_LOG" &
TAIL_PID=$!

# ── 9. Wait for services.json (status=running) + WMH health ────────────────
step services_wait
MANIFEST="$CONTEXT_DIR/services.json"
BACKEND_PORT="$BASE_PORT"
HEALTH_PORT=$((BASE_PORT + 2))

log "waiting for stack to become healthy (services.json + backend + worker + WMH)..."
STACK_READY=false
STATUS="none"
# No WMH build happens on this path (the cached model is served verbatim). The
# larger configured first-run ceiling covers production sync + DB dump + service
# startup even if run.sh rejects a dump that looked restorable at preflight. A
# successful warm restore still exits this loop as soon as health is ready.
STACK_WAIT_SECONDS="$(stack_wait_budget_seconds)"
# Isolated run.sh writes each service to $CONTEXT_DIR/logs. The driver log is
# the one file the controller always pulls back, even when sealed runtime
# evidence is unavailable, so a stack that dies before health must leave each
# service's exit cause here (a worker rc=1 at 873s was otherwise unexplained).
log_file_tail() {
    [ -f "$1" ] || return 0
    log "───── last $2 lines of $3 log ($1) ─────"
    tail -"$2" "$1" 2>/dev/null | while IFS= read -r _line; do log "  | $_line"; done
}
log_stack_service_tails() {
    log_file_tail "$STACK_LOG" 40 stack
    log_file_tail "$CONTEXT_DIR/logs/worker.log" 120 worker
    log_file_tail "$CONTEXT_DIR/logs/backend.log" 60 backend
    log_file_tail "$CONTEXT_DIR/logs/frontend.log" 80 frontend
    log_file_tail "$REPO_DIR/front-end/frontend-logs.log" 80 frontend
}
if [ ! -s "$STACK_SEED_DUMP" ]; then
    log "first-run seed dump absent — using cold stack health budget ${STACK_WAIT_SECONDS}s"
fi
for i in $(seq 1 "$STACK_WAIT_SECONDS"); do
    if ! kill -0 "$STACK_PID" 2>/dev/null; then
        # Capture the ACTUAL death cause. "see stack log above" was a dead end at
        # fleet width: the stack log truncated mid-startup with no error, leaving
        # the failure unclassifiable (OOM? sync error? signal?). Record the exit
        # code (rc=137 ⇒ SIGKILL/OOM), the stack-log tail, and a dmesg OOM probe
        # so a sporadic bring-up death is diagnosable from the pulled-back logs.
        wait "$STACK_PID" 2>/dev/null; stack_rc=$?
        log "FATAL: stack process exited (rc=$stack_rc) before becoming healthy after ${i}s"
        log_stack_service_tails
        if [ "$stack_rc" = 137 ] || dmesg 2>/dev/null | grep -qiE 'out of memory|oom-kill'; then
            log "  ⚠️ rc=137/OOM signature — stack was SIGKILLed (likely out-of-memory); check machine RAM vs concurrent service footprint"
        fi
        finish 1
    fi
    if [ -f "$MANIFEST" ]; then
        STATUS="$(python3 -c "import json; print(json.load(open('$MANIFEST')).get('status',''))" 2>/dev/null || echo "")"
        if [ "$STATUS" = "running" ] \
            && curl -fsS "http://localhost:$BACKEND_PORT/health" >/dev/null 2>&1 \
            && curl -fsS "http://localhost:$HEALTH_PORT/health" >/dev/null 2>&1; then
            if [ "$BENCH_SIMULATE" = "1" ]; then
                if curl -fsS "http://localhost:$WMH_PORT/healthz" >/dev/null 2>&1; then
                    STACK_READY=true
                    break
                fi
            else
                STACK_READY=true
                break
            fi
        fi
    fi
    if [ $((i % 30)) -eq 0 ]; then
        WMH_TAIL="$(tail -1 "$CONTEXT_DIR/wmh-serve-log.txt" 2>/dev/null || true)"
        log "…still waiting (${i}s): status=${STATUS:-none} wmh=[${WMH_TAIL}]"
    fi
    sleep 1
done

if ! $STACK_READY; then
    log "FATAL: stack did not become healthy within the timeout"
    log_stack_service_tails
    finish 1
fi
log "stack healthy — backend :$BACKEND_PORT, WMH :$WMH_PORT, dashboard :$BENCH_DASHPORT"
STACK_DB_URL="$(python3 - "$MANIFEST" <<'PY'
import json, sys
from pathlib import Path
manifest = json.loads(Path(sys.argv[1]).read_text())
database = manifest.get("database") or {}
url = (database.get("url") or "").strip()
if not url:
    port = database.get("port") or (manifest.get("ports") or {}).get("local_db") or 5432
    name = database.get("name") or "victoria"
    url = f"postgresql://postgres:postgres@localhost:{port}/{name}"
print(url)
PY
)"
# Bounded guest diagnostics (one JSON line per 15 s, at most 12 h): CPU/load,
# backend client connections vs. its Prisma connection_limit, pg_stat_activity
# states/wait events/longest query. Exported as guest-diagnostics.jsonl with
# the runtime evidence so a slow stack can be classified as pool queueing, CPU
# saturation or Postgres contention. 30 is back-end/src/providers/database.ts
# LOCAL_POOL_SIZE, the pool a localhost DATABASE_URL gets without an override.
python3 "$REPO_DIR/scripts/cloudbench-guest-diagnostics.py" "$CONTEXT_DIR/guest-diagnostics.jsonl" \
    "$STACK_DB_URL" "${DB_CONNECTION_LIMIT:-30}" 15 2880 >/dev/null 2>&1 &
GUEST_DIAGNOSTICS_PID=$!
if [ "$BENCH_NEEDS_PAYMENT_FIXTURE" = "1" ]; then
    PAYMENT_USER_ID="${BENCHMARK_AGENT_PAYMENT_USER_ID:-1f85ff25-6e29-4c1b-8739-f917bd101a30}"
    log "seeding isolated payment fixture for $PAYMENT_USER_ID"
    if ! gosu "$APP_USER" env \
        DATABASE_URL="$STACK_DB_URL" \
        DIRECT_URL="$STACK_DB_URL" \
        BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH=1 \
        sh -c 'cd "$1" && exec npx tsx scripts/setup-benchmark-payment.ts --user-id "$2"' \
          sh "$REPO_DIR/back-end" "$PAYMENT_USER_ID"; then
        log "FATAL: setup-benchmark-payment.ts failed for $PAYMENT_USER_ID"
        finish 1
    fi
fi
wait_for_benchmark_frontend_url || finish 1

# Fleet batches hold every task here until every isolated stack is healthy.
# The controller releases all machines together, so slow database/bootstrap
# work cannot turn a nominally parallel batch into serial benchmark execution.
if [ -n "$CLOUDBENCH_START_BARRIER" ]; then
    BARRIER_READY="$DATA_DIR/cloudbench-start-$CLOUDBENCH_START_BARRIER.ready"
    BARRIER_RELEASE="$DATA_DIR/cloudbench-start-$CLOUDBENCH_START_BARRIER.release"
    touch "$BARRIER_READY"
    log "synchronized start barrier ready: $CLOUDBENCH_START_BARRIER"
    BARRIER_RELEASED=false
    for _ in $(seq 1 "${CLOUDBENCH_START_BARRIER_WAIT_SECONDS:-900}"); do
        if [ -f "$BARRIER_RELEASE" ]; then
            BARRIER_RELEASED=true
            break
        fi
        sleep 1
    done
    if ! $BARRIER_RELEASED; then
        log "FATAL: synchronized start barrier timed out"
        finish 1
    fi
    rm -f "$BARRIER_READY" "$BARRIER_RELEASE"
    log "synchronized start barrier released: $CLOUDBENCH_START_BARRIER"
fi

# ── 10. Run the benchmark (or emit infra-probe DONE) ───────────────────────
step benchmark
if [ "${#BENCH_TASK_LIST[@]}" -eq 0 ]; then
    log "FATAL: BENCH_TASKS is empty"
    finish 1
fi

# Fleet infra canary: prove clone → stack healthy → barrier → release → DONE
# without spending LLM / agent wall-clock. Synthetic artifacts must still pass
# cloudbench_result identity checks so the controller does not treat a green
# probe as INFRA_ERROR (missing cloudbench-run.json).
#
# world_model_mode MUST match the catalog/fleet expected mode (real|simulate).
# Emitting a literal "infra-probe" mode fails cloudbench_result /
# execution-task-matrix checks after #1285 provenance wiring
# ("expected 'real' … got 'infra-probe'"), which surfaced as NORESULT with a
# green barrier. Keep top-level infra_probe=true as the probe marker.
if [ "${CLOUDBENCH_INFRA_PROBE:-0}" = "1" ]; then
    log "infra probe: skipping run_benchmark.py; emitting synthetic pass artifacts"
    PROBE_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    PROBE_WMM="$(printf '%s' "${BENCHMARK_WORLD_MODEL_MODE:-real}" | tr '[:upper:]' '[:lower:]')"
    case "$PROBE_WMM" in
        simulate) ;;
        *) PROBE_WMM="real" ;;
    esac
    PROBE_TASKS_JSON="$(printf '%s\n' "${BENCH_TASK_LIST[@]}" | PROBE_WMM="$PROBE_WMM" PROBE_TS="$PROBE_TS" python3 -c '
import json, os, sys
names = [line.strip() for line in sys.stdin if line.strip()]
mode = os.environ["PROBE_WMM"]
tasks = [
    {
        "name": name,
        "passed": True,
        "status": "PASSED",
        "duration_seconds": 0,
        "world_model_mode": mode,
        "agent_id": None,
        "failure_reason": None,
    }
    for name in names
]
doc = {
    "timestamp": os.environ["PROBE_TS"],
    "infra_probe": True,
    "summary": {
        "total": len(names),
        "passed": len(names),
        "failed": 0,
        "skipped": 0,
        "pass_rate": 1.0,
        "total_duration_seconds": 0,
        "total_cost_cents": 0,
    },
    "tasks": tasks,
}
print(json.dumps(doc))
')"
    PROBE_CARD_JSON="$(printf '%s\n' "${BENCH_TASK_LIST[@]}" | python3 -c '
import json, sys
names = [line.strip() for line in sys.stdin if line.strip()]
print(json.dumps({
    "infra_probe": True,
    "tasks": {name: {"passed": True, "status": "PASSED"} for name in names},
    "summary": {"total": len(names), "passed": len(names), "failed": 0, "pass_rate": 1.0},
}))
')"
    printf '%s\n' "$PROBE_TASKS_JSON" > "$CONTEXT_DIR/run.json"
    printf '%s\n' "$PROBE_CARD_JSON" > "$CONTEXT_DIR/report-card.json"
    chown "$APP_USER:$APP_USER" "$CONTEXT_DIR/run.json" "$CONTEXT_DIR/report-card.json" 2>/dev/null || true
    # Point CURRENT_RUN_ARTIFACT_SCRIPT at a fresh file under runs/ so emit_report
    # copies a non-stale artifact (it requires mtime newer than RUN_OUTPUT_MARKER).
    mkdir -p "$REPO_DIR/agents/benchmarks/runs"
    PROBE_RUN_FILE="$REPO_DIR/agents/benchmarks/runs/infra-probe-$(date -u +%Y%m%d%H%M%S)-$$.json"
    cp -f "$CONTEXT_DIR/run.json" "$PROBE_RUN_FILE"
    chown "$APP_USER:$APP_USER" "$PROBE_RUN_FILE" 2>/dev/null || true
    touch "$PROBE_RUN_FILE"
    log "infra probe: synthetic artifacts written (world_model_mode=$PROBE_WMM)"
    finish 0
fi

# Task selector: pass the exact requested task names. `run_benchmark.py`
# accepts repeated `--task` values, so the cloud runner does not need to encode
# multi-task selection as "suite all minus exclusions".
BENCH_ARGS=()
for task_name in "${BENCH_TASK_LIST[@]}"; do
    BENCH_ARGS+=(--task "$task_name")
done

if ! BENCH_TARGET_PLAN="$(python3 "$BENCHMARK_TARGET_SCRIPT" \
    "$REPO_DIR/agents/benchmarks/tasks.json" "$BACKEND_PORT" "${BENCH_TASK_LIST[@]}")"; then
    log "FATAL: could not resolve the catalog-mandated benchmark target"
    finish 1
fi
# A pipe into `head -1` dies with SIGPIPE under pipefail when head exits first.
BENCH_TARGET_MODE="${BENCH_TARGET_PLAN%%$'\n'*}"
BENCH_TARGET_ARGS=()
while IFS= read -r target_arg; do
    [ -n "$target_arg" ] && BENCH_TARGET_ARGS+=("$target_arg")
done < <(printf '%s\n' "$BENCH_TARGET_PLAN" | tail -n +2)
if [ "${#BENCH_TARGET_ARGS[@]}" -eq 0 ]; then
    log "FATAL: benchmark target resolver returned no CLI arguments"
    finish 1
fi
BENCH_ARGS+=("${BENCH_TARGET_ARGS[@]}" --ci --keep-failed-agents)
if [ "${#BENCH_TASK_LIST[@]}" -gt 1 ]; then
    BENCH_ARGS+=(--parallel --max-concurrency "$BENCH_MAX_CONCURRENCY")
fi
if [ "$BENCH_SIMULATE" = "1" ]; then
    BENCH_ARGS+=(--simulate --world-model-url "http://localhost:$WMH_PORT" --world-model-name "$WMH_MODEL_NAME")
fi

BENCH_HARNESS_ENV=()
if [ "${BENCHMARK_DEMO_CACHE_READ_ONLY:-}" = 1 ]; then
    # The temporary replay guard belongs to task agents in STACK_ENV and the
    # worker wrappers. Leave the harness's declared judges on their ordinary
    # evaluation path, including real provider calls when its cache misses.
    BENCH_HARNESS_ENV+=(
        -u FAST_MODE_CACHE_DISABLE_WRITE_THROUGH
        -u DEMO_CACHE_DISABLE_WRITE_THROUGH
        -u BENCHMARK_DEMO_CACHE_READ_ONLY
        -u CLOUDBENCH_FAST_CACHE_READ_ONLY
    )
fi

log "running benchmark: target=$BENCH_TARGET_MODE run_benchmark.py ${BENCH_ARGS[*]}"
# Retouch after checkout/setup so files merely restored or rewritten during
# clone initialization cannot qualify as output from this benchmark process.
touch "$RUN_OUTPUT_MARKER"
rm -f "$INTERRUPT_CLEANUP_STATUS_FILE" "$RUNNER_INTERRUPT_CLEANUP_STATUS_FILE"
set +e
# Pass workspace identity as environment arguments so shell metacharacters in
# the name cannot break the inner command. The inner shell forwards these values
# to run_benchmark.py and logs them below.
run_with_heartbeat "benchmark" gosu "$APP_USER" env "${BENCH_HARNESS_ENV[@]}" \
    "CONDUCTOR_WORKSPACE_NAME=$WORKSPACE_NAME" \
    "BENCHMARK_RUN_ID=$WORKSPACE_NAME" \
    "TEMPORAL_TASK_QUEUE=navi-agent-tasks-$WORKSPACE_NAME" bash -c "
export HOME='/home/$APP_USER'
export BENCHMARK_CONTEXT_DIR='$CONTEXT_DIR'
export BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS='$BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS'
export BENCHMARK_ISOLATED_RUN=true
export BENCHMARK_ISOLATED_BROWSER_PROFILES=true
export BENCHMARK_DELETE_CANCELLED_AGENTS_ON_INTERRUPT=true
export BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE='$RUNNER_INTERRUPT_CLEANUP_STATUS_FILE'
export BENCHMARK_INTERRUPT_CLEANUP_TOKEN='$CLOUDBENCH_RUN_TOKEN'
if [ '$BENCH_TARGET_MODE' = local ]; then export BENCHMARK_CLOUD_BATCH_CLEANUP=true; fi
export ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1
export CONDUCTOR_PORT='$BASE_PORT'
export BENCHMARK_SEED_DUMP='$STACK_SEED_DUMP'
# run.sh exports this path to the backend, but the benchmark runner is a
# sibling process launched by this driver and cannot inherit that export.
# Give both processes the same run-scoped fixture file so SMS tasks stay
# deterministic in cloud runs instead of failing closed (or using live search).
export BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE='$CONTEXT_DIR/sms-web-search-fixture.json'
export BENCHMARK_REQUIRE_SEED_DUMP=1
# The runner records which engine owns each seeded WMH session.
export WMH_ENGINE='$WMH_ENGINE'
export WMH_MODEL_NAME='$WMH_MODEL_NAME'
if [ -n '$BENCHMARK_FAST_MODE_CACHE' ]; then
  export BENCHMARK_FAST_MODE_CACHE='$BENCHMARK_FAST_MODE_CACHE'
fi
if [ -n '$BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY' ]; then
  export BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY='$BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY'
fi
if [ -n '$BENCHMARK_PEAK_FLY_MACHINES' ]; then
  export BENCHMARK_PEAK_FLY_MACHINES='$BENCHMARK_PEAK_FLY_MACHINES'
fi
if [ -n '$BENCHMARK_VM_USD_PER_HOUR' ]; then
  export BENCHMARK_VM_USD_PER_HOUR='$BENCHMARK_VM_USD_PER_HOUR'
fi
if [ '$BENCH_TARGET_MODE' = 'prod' ]; then
  unset BENCHMARK_FRONTEND_URL
elif [ -n '$BENCHMARK_FRONTEND_URL' ]; then
  export BENCHMARK_FRONTEND_URL='$BENCHMARK_FRONTEND_URL'
else
  unset BENCHMARK_FRONTEND_URL
fi
if [ -n '$BENCHMARK_REPORT_FRONTEND_URL' ]; then
  export BENCHMARK_REPORT_FRONTEND_URL='$BENCHMARK_REPORT_FRONTEND_URL'
else
  unset BENCHMARK_REPORT_FRONTEND_URL
fi
if [ '$BENCH_NEEDS_AGENTCARD_ONBOARDING' = '1' ]; then
  export AGENTCARD_ONBOARDING_RETURN_URL='$AGENTCARD_BENCHMARK_ONBOARDING_RETURN_URL'
else
  unset AGENTCARD_ONBOARDING_RETURN_URL
fi
if [ '$BENCH_NEEDS_PAYMENT_FIXTURE' = '1' ]; then
  export BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH=1
  export BENCHMARK_AGENT_PAYMENT_USER_ID=1f85ff25-6e29-4c1b-8739-f917bd101a30
fi
$TASK_WORKER_EXPORTS
if [ '$BENCH_SIMULATE' = '1' ]; then
  export BENCHMARK_WORLD_MODEL_MODE='simulate'
  export WMH_BASE_URL='http://localhost:$WMH_PORT'
else
  export BENCHMARK_WORLD_MODEL_MODE='real'
fi
echo \"[cloudbench] run_benchmark env: CONDUCTOR_WORKSPACE_NAME=\$CONDUCTOR_WORKSPACE_NAME TEMPORAL_TASK_QUEUE=\$TEMPORAL_TASK_QUEUE\"
cd '$REPO_DIR/agents' && exec venv/bin/python -u benchmarks/run_benchmark.py \"\$@\"" _ "${BENCH_ARGS[@]}"
BENCH_RC=$?
set -e 2>/dev/null || true

log "benchmark finished rc=$BENCH_RC"
finish "$BENCH_RC"
