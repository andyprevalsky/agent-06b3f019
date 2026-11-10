#!/usr/bin/env bash
# Two workstreams (git worktrees sharing one git common dir, like Conductor
# workspaces) must be able to run cloud benchmarks CONCURRENTLY — and both runs
# must FINISH WITH SUCCESS, each on its own code snapshot.
#
# Scenario 1 drives two real `run-bench-fleet --provision-pool` controllers at
# the same time. Scenario 2 drives two real `run-bench-fleet <bench>` runs all
# the way through the pipeline: clone → ssh staging → detached driver →
# synchronized start barrier → DONE-marker polling → report-card/run.json
# retrieval → PASS aggregation → teardown. Both fleets must exit 0 with 1/1
# passed and each machine must have received ITS workstream's git ref.
# Scenario 3 replays the 54-machine production capacity shape and proves stopped
# inventory cannot block seven active primaries. Scenario 4 proves the same
# guard still rejects a real active burst and treats unknown states fail-closed.
# Scenario 5 SIGKILLs a controller after Fly has accepted its clone, removes the
# workspace-local run ledger, and proves the pre-ack quarantine survives both
# controller and workspace death. Scenario 6 independently proves that an
# already-confirmed/reapable stale owner still cannot be reaped while its runner
# is active.
#
# The fake flyctl journals every call, keeps shared machine/volume state, and
# EXECUTES ssh payloads in a per-machine sandbox (with /data//tmp rewritten),
# so the real controller logic runs unmodified. Its `machine clone` blocks
# until BOTH controllers' clones are in flight — a serialized (locked) run
# deadlocks the barrier and fails. The fake driver only completes after the
# fleet releases the synchronized start barrier over ssh, so a PASS requires
# the full controller loop, not a canned response. The run path must also stay
# read-only against shared app state: no `secrets set`, no lease tokens.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "$(uname -s)" != "Linux" ]; then
    exec python3 "$ROOT_DIR/scripts/tests/run-cloudbench-controller-linux.py" "$@"
fi
# shellcheck source=../lib/cloudbench-env.sh
source "$ROOT_DIR/scripts/lib/cloudbench-env.sh"

# This synthetic suite starts many independent controllers. Exercise reserve
# ownership and release with the minimum real allocation; the focused reserve
# tests cover sizing and low-space behavior separately.
export CLOUDBENCH_CLEANUP_DISK_RESERVE_MB="${CLOUDBENCH_CLEANUP_DISK_RESERVE_MB:-32}"
python3 "$ROOT_DIR/scripts/tests/cloudbench-worker-readiness-publication.test.py" || exit 1
python3 "$ROOT_DIR/scripts/tests/cloudbench-fixture-port-allocation.test.py" || exit 1
python3 "$ROOT_DIR/scripts/tests/cloudbench-fixture-process-cleanup.test.py" || exit 1
python3 "$ROOT_DIR/scripts/tests/cloudbench-fixture-catalog.test.py" || exit 1
python3 "$ROOT_DIR/scripts/tests/cloudbench-hub-reaping.test.py" || exit 1
python3 "$ROOT_DIR/scripts/tests/cloudbench-fake-volume-contract.test.py" || exit 1
# A quarantined owner whose natively stopped guest never received its shutdown
# is recoverable only through the exact undelivered native-stop capture (K12).
python3 "$ROOT_DIR/scripts/tests/cloudbench-undelivered-native-stop-capture.test.py" || exit 1
python3 "$ROOT_DIR/scripts/tests/cloudbench-runtime-evidence-collector.test.py" || exit 1
# A failed stack teardown keeps its worker/stack logs as diagnostic-only evidence (P8).
python3 "$ROOT_DIR/scripts/tests/cloudbench-failed-runtime-evidence.test.py" || exit 1
# Terminal bench.log bursts drain by bytes; runaway and stuck backlogs fail closed (P8).
python3 "$ROOT_DIR/scripts/tests/cloudbench-bench-log-backlog.test.py" || exit 1

# Resolve the fleet APP from run-bench-fleet at runtime so fixtures stay in
# sync without hardcoding the bench app name (secret-scanner sensitive).
fleet_bench_app() {
    local app
    app="$(sed -n 's/^APP="\(.*\)"$/\1/p' "$ROOT_DIR/scripts/run-bench-fleet" | head -1)"
    [ -n "$app" ] || return 1
    printf '%s' "$app"
}

# macOS maps /var to /private/var. The recovery contract correctly requires a
# canonical runs root, so create the fixture under its physical path.
TMP_ROOT="$(cd "$(mktemp -d)" && pwd -P)"
SCRIPT_SNAPSHOT_TMP="$TMP_ROOT/script-snapshots"
mkdir -p "$SCRIPT_SNAPSHOT_TMP"
PIDS=()
HUB_PIDS=()
# Session-leader controllers (exact PID and birth). A controller started in
# its own session is not a descendant of any PID in PIDS, so cleanup reaps it
# explicitly, including after a failed or timed-out case.
SESSION_CONTROLLERS=()
HUB_LAUNCH_DEFERRED_SIGNAL=""
TEST_FAILED=0
PORT_CLAIM_DIR=""

# PIDs of fixture processes started by this run: real controllers and runners
# from its private sandbox, and the fake provider's guests and proxies. Only
# this run's unique TMP_ROOT is matched, never another session's processes.
fixture_process_pids() {
    # The suite-lifetime fake Machines API is owned by cleanup(), not by a case.
    python3 - "$TMP_ROOT/" "$$" "${FAKE_MACHINES_API_PID:-}" <<'PY'
import os
import sys

root, shell, api = sys.argv[1], sys.argv[2], sys.argv[3]
own = {shell, str(os.getpid()), str(os.getppid()), api}
for name in os.listdir("/proc"):
    if not name.isdigit() or name in own:
        continue
    try:
        with open(f"/proc/{name}/cmdline", "rb") as handle:
            argv = handle.read().replace(b"\0", b" ").decode(errors="replace")
    except OSError:
        continue
    if root in argv and any(
        marker in argv for marker in ("run-bench-fleet", "run-bench-cloud", "flyctl.py", "/fake-bin/")
    ):
        print(name)
PY
}

reap_fixture_processes() {  # TERM, then KILL, this run's own fixture processes
    local entry pid birth attempt
    local -a survivors=()
    for entry in "${SESSION_CONTROLLERS[@]:-}"; do
        [ -n "$entry" ] || continue
        pid="${entry%% *}"
        birth="${entry#* }"
        if cloudbench_pid_matches_start "$pid" "$birth"; then
            kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        fi
    done
    for attempt in 1 2; do
        mapfile -t survivors < <(fixture_process_pids)
        [ "${#survivors[@]}" -gt 0 ] || break
        for pid in "${survivors[@]}"; do
            if [ "$attempt" -lt 2 ]; then
                kill -TERM "$pid" 2>/dev/null || true
            else
                kill -KILL "$pid" 2>/dev/null || true
            fi
        done
        for _ in $(seq 1 25); do
            mapfile -t survivors < <(fixture_process_pids)
            [ "${#survivors[@]}" -gt 0 ] || break
            sleep 0.2
        done
    done
    for entry in "${SESSION_CONTROLLERS[@]:-}"; do
        [ -n "$entry" ] || continue
        pid="${entry%% *}"
        birth="${entry#* }"
        if cloudbench_pid_matches_start "$pid" "$birth"; then
            kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
        fi
    done
    SESSION_CONTROLLERS=()
}

# Wait briefly for this run's fixture processes to exit; report survivors.
assert_no_fixture_processes() {  # <label>
    local -a survivors=()
    for _ in $(seq 1 75); do
        mapfile -t survivors < <(fixture_process_pids)
        [ "${#survivors[@]}" -gt 0 ] || return 0
        sleep 0.2
    done
    ps -o pid=,pgid=,etime=,args= -p "$(IFS=,; echo "${survivors[*]}")" >&2 2>/dev/null || true
    fail "$1: fixture process(es) survived the case: ${survivors[*]}"
}

track_session_controller() {  # <pid-file>; records the exact session leader
    local file="$1" pid="" birth=""
    for _ in $(seq 1 100); do
        pid="$(cat "$file" 2>/dev/null || true)"
        [ -n "$pid" ] && break
        sleep 0.1
    done
    case "$pid" in ''|*[!0-9]*) fail "a session controller never published its PID" ;; esac
    birth="$(cloudbench_pid_start_time "$pid")"
    [ -n "$birth" ] || return 0
    SESSION_CONTROLLERS+=("$pid $birth")
}

cleanup() {
    local trapped_status=$? original_status pid ws hub_cleanup_failed=0
    original_status="${1:-$trapped_status}"
    trap - EXIT HUP INT TERM
    for pid in "${PIDS[@]:-}"; do
        kill "$pid" 2>/dev/null || true
    done
    if [ -n "${FAKE_MACHINES_API_PID:-}" ] && [ "$BASHPID" = "$$" ]; then
        kill "$FAKE_MACHINES_API_PID" 2>/dev/null || true
        wait "$FAKE_MACHINES_API_PID" 2>/dev/null || true
    fi
    # Controllers in their own sessions and the fake guests they started are
    # not descendants of PIDS; a failed case must not leave them running.
    reap_fixture_processes
    for pid in "${PIDS[@]:-}"; do
        wait "$pid" 2>/dev/null || true
    done
    if declare -F terminate_test_owned_hubs >/dev/null 2>&1; then
        for ws in "${WS_A:-}" "${WS_B:-}"; do
            [ -n "$ws" ] || continue
            if ! terminate_test_owned_hubs "$ws"; then
                hub_cleanup_failed=1
                TEST_FAILED=1
            fi
        done
        if [ "${#HUB_PIDS[@]}" -ne 0 ]; then
            echo "❌ test Hub PID(s) lacked a reconciled pending/owner record: ${HUB_PIDS[*]}" >&2
            hub_cleanup_failed=1
            TEST_FAILED=1
        fi
    fi
    if [ "$hub_cleanup_failed" = "0" ] && [ -n "$PORT_CLAIM_DIR" ]; then
        rm -f "$PORT_CLAIM_DIR/owner" 2>/dev/null || true
        # Keep the lock inode stable: unlinking it lets another process lock
        # a replacement inode while an earlier descriptor is still live.
        [ -z "${PORT_CLAIM_FD:-}" ] || exec {PORT_CLAIM_FD}>&-
    fi
    if [ "$hub_cleanup_failed" = "1" ]; then
        echo "ℹ️  retained cloudbench fixture because exact Hub teardown did not verify: $TMP_ROOT" >&2
        exit 1
    elif { [ "$TEST_FAILED" = "1" ] || [ "$original_status" -ne 0 ]; } \
        && [ "${CLOUDBENCH_TEST_KEEP_TMP_ON_FAILURE:-0}" = "1" ]; then
        echo "ℹ️  retained failed cloudbench fixture: $TMP_ROOT" >&2
    else
        # Immutable audit/owner ledgers are chmod a-w; regain write before rm
        # so a green run never leaves /tmp fixtures behind (observed after
        # scenario 16 when teardown-ownership/* blocked rm -rf).
        if [ -n "${FIXTURE_STORAGE_DEVICE:-}" ] && [ -z "$(fixture_process_pids)" ]; then
            python3 - "$FIXTURE_STORAGE_DEVICE" <<'PY'
import os,shutil,sys
from pathlib import Path
value=sys.argv[1]
assert value.isdigit() and int(value)>2**48
shutil.rmtree(Path('/tmp')/('rose-cloudbench-cleanup-admission-'+str(os.getuid()))/value,ignore_errors=True)
PY
        fi
        chmod -R u+w "$TMP_ROOT" 2>/dev/null || true
        rm -rf "$TMP_ROOT"
    fi
    exit "$original_status"
}
trap cleanup EXIT
trap 'cleanup 129' HUP
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

fail() {
    TEST_FAILED=1
    echo "FAIL: $1" >&2
    # Controller logs report only the autoscaler's verdict; its own log and
    # terminal markers live in the per-bench run dir and explain intermittent
    # finalization failures. Dump the three newest so they outlive TMP_ROOT.
    local autoscaler_logs
    local -a task_bench_logs=()
    # -r: with no autoscaler log, a bare `ls -t` would list (and dump) the cwd.
    autoscaler_logs="$(find "$TMP_ROOT" -name autoscaler.log -type f -print 2>/dev/null |
        xargs -r ls -t 2>/dev/null | head -3)"
    while IFS= read -r log; do
        task_bench_logs+=("$log")
    done < <(find "$TMP_ROOT" -name bench.log -type f -print0 2>/dev/null |
        xargs -0 -r ls -t -- 2>/dev/null | head -3)
    for log in "$TMP_ROOT"/controller-*.log $autoscaler_logs "${task_bench_logs[@]}"; do
        [ -f "$log" ] || continue
        if [ "$(basename "$log")" = "autoscaler.log" ]; then
            echo "── $(dirname "$log") autoscaler markers: $(cd "$(dirname "$log")" &&
                ls -1 autoscaler.* 2>/dev/null | tr '\n' ' ') ──" >&2
        fi
        echo "── $log (tail) ──" >&2
        # Bound each dump: a wedged filesystem or special file must not
        # prevent EXIT cleanup from reaping hubs and releasing ports.
        python3 - "$log" <<'PY' >&2 || true
import subprocess
import sys

try:
    subprocess.run(["tail", "-30", sys.argv[1]], timeout=5, check=False)
except subprocess.TimeoutExpired:
    print("(log tail timed out)", file=sys.stderr)
PY
    done
    exit 1
}

test_tcp_listener_absent() {
    local probe_status=0
    cloudbench_tcp_listener_present "$1" || probe_status=$?
    [ "$probe_status" -eq 1 ] && return 0
    if [ "$probe_status" -ne 0 ]; then
        echo "❌ test listener probe inconclusive on :$1 (rc=$probe_status)" >&2
    fi
    return 1
}

# Exercise the actual allocation and cleanup consumers without controllers,
# sockets or signals. A probe error must neither claim a port nor erase evidence.
listener_probe_status_contract() (
    local function_name function_source allocation_source injected_probe_status status
    local ws record failures=0 expected_busy expected_status expected_record expected_untracks
    local untrack_calls="$TMP_ROOT/listener-status-untrack.calls"
    for function_name in test_tcp_listener_absent reap_test_terminal_hub terminate_test_pending_hubs terminate_test_owned_hubs; do
        function_source="$(awk -v name="$function_name" '
            $0 ~ "^" name "\\(\\)" { capture = 1 }
            capture { print }
            capture && /^}$/ { exit }
        ' "$ROOT_DIR/scripts/tests/cloudbench-multi-workstream.test.sh")"
        [ -n "$function_source" ] && eval "$function_source"
    done
    allocation_source="$(awk '
        /^    for candidate_port in / { capture = 1 }
        capture { print }
        capture && /^    done$/ { exit }
    ' "$ROOT_DIR/scripts/tests/cloudbench-multi-workstream.test.sh")"
    [ -n "$allocation_source" ] || return 1
    cloudbench_tcp_listener_present() { return "$injected_probe_status"; }
    cloudbench_tracked_owner_value() {
        case "$2" in
            pid|pgid) printf '999999\n' ;;
            pid_start) printf 'fixture-birth\n' ;;
            port)
                case "$1" in *.second.owner) printf '42001\n' ;; *) printf '42000\n' ;; esac
                ;;
        esac
    }
    validate_test_hub_pending_record() { return 0; }
    validate_test_hub_owner_record() { return 0; }
    cloudbench_pid_matches_start() { return 1; }
    cloudbench_process_group_state() { printf 'absent\n'; }
    cloudbench_central_hub_owner_for() { return 1; }
    untrack_test_hub_pid() { printf '%s\n' "$1" >> "$untrack_calls"; }
    ps() { return 1; }
    wait() { return 127; }
    # Any unexpected entry into a signalling path is a fixture failure.
    cloudbench_signal_tracked_group() { return 1; }
    cloudbench_terminate_central_hub_owner() { return 1; }

    for injected_probe_status in 3 1 0 2 127; do
        local port_base=42000 candidate_port port_window_busy=0
        expected_busy=1
        expected_status=1
        expected_record=present
        expected_untracks=0
        if [ "$injected_probe_status" -eq 1 ]; then
            expected_busy=0
            expected_status=0
            expected_record=absent
            expected_untracks=1
        fi
        eval "$allocation_source"
        if [ "$port_window_busy" -ne "$expected_busy" ]; then
            echo "FAIL: allocation accepted inconclusive probe rc=$injected_probe_status" >&2
            failures=$((failures + 1))
        fi
        for function_name in terminate_test_pending_hubs terminate_test_owned_hubs; do
            ws="$TMP_ROOT/listener-status-$injected_probe_status-$function_name"
            mkdir -p "$ws/.context/fleet/runs/_hub" || return 1
            record="$ws/.context/fleet/runs/_hub/agent-link-server.42000.fixture"
            case "$function_name" in
                terminate_test_pending_hubs) record="$record.pending" ;;
                *) record="$record.owner" ;;
            esac
            printf 'fixture record\n' > "$record"
            : > "$untrack_calls"
            status=0
            "$function_name" "$ws" >/dev/null 2>&1 || status=$?
            if [ "$status" -ne "$expected_status" ]; then
                echo "FAIL: $function_name accepted probe rc=$injected_probe_status (cleanup rc=$status)" >&2
                failures=$((failures + 1))
            fi
            if [ "$(wc -l < "$untrack_calls" | tr -d ' ')" -ne "$expected_untracks" ]; then
                echo "FAIL: $function_name changed PID tracking before conclusive probe rc=$injected_probe_status" >&2
                failures=$((failures + 1))
            fi
            if { [ "$expected_record" = present ] && [ ! -f "$record" ]; } \
                || { [ "$expected_record" = absent ] && [ -e "$record" ]; }; then
                echo "FAIL: $function_name did not keep record $expected_record for probe rc=$injected_probe_status" >&2
                failures=$((failures + 1))
            fi
        done
    done
    # A present listener with a verified different owner is deliberately left
    # to that owner's pass; tightening errors must preserve that distinction.
    injected_probe_status=0
    cloudbench_central_hub_owner_for() { printf '/fixture/distinct.owner\n'; }
    ws="$TMP_ROOT/listener-status-distinct-owner"
    mkdir -p "$ws/.context/fleet/runs/_hub" || return 1
    record="$ws/.context/fleet/runs/_hub/agent-link-server.42000.fixture.pending"
    printf 'fixture record\n' > "$record"
    : > "$untrack_calls"
    if ! terminate_test_pending_hubs "$ws" || [ -e "$record" ] \
        || [ "$(wc -l < "$untrack_calls" | tr -d ' ')" -ne 1 ]; then
        echo 'FAIL: verified distinct listener owner blocked pending-record finalization' >&2
        failures=$((failures + 1))
    fi
    # No owner's evidence may be cleared when a later port remains uncertain.
    ws="$TMP_ROOT/listener-status-mixed-owners"
    mkdir -p "$ws/.context/fleet/runs/_hub" || return 1
    record="$ws/.context/fleet/runs/_hub/agent-link-server.42000"
    printf 'fixture record\n' > "$record.first.owner"
    printf 'fixture record\n' > "$record.second.owner"
    local probe_calls="$TMP_ROOT/listener-status-mixed.calls"
    : > "$probe_calls"
    : > "$untrack_calls"
    cloudbench_tcp_listener_present() {
        printf 'probe\n' >> "$probe_calls"
        [ "$(wc -l < "$probe_calls" | tr -d ' ')" -eq 1 ] && return 1
        return 3
    }
    if terminate_test_owned_hubs "$ws" >/dev/null 2>&1 \
        || [ ! -f "$record.first.owner" ] || [ ! -f "$record.second.owner" ] \
        || [ -s "$untrack_calls" ]; then
        echo 'FAIL: mixed conclusive/inconclusive ports partially finalized owned Hub evidence' >&2
        failures=$((failures + 1))
    fi
    [ "$failures" -eq 0 ]
)

if [ "${CLOUDBENCH_TEST_LISTENER_STATUS_SELF_TEST:-0}" = "1" ]; then
    listener_probe_status_contract || fail "listener probe consumers must require conclusive state"
    echo "PASS: only rc=1 proves absence; inconclusive probes retain cleanup records"
    exit 0
fi
listener_probe_status_contract || fail "listener probe consumers must require conclusive state"
echo "PASS: only rc=1 proves absence; inconclusive probes retain cleanup records"

FLEET_BENCH_APP="$(fleet_bench_app)" \
    || fail "could not resolve APP from scripts/run-bench-fleet"

# Exercise the EXIT-trap contract without paying for the full fake-provider
# suite. An otherwise-successful child with a forced exact-Hub cleanup failure
# must exit nonzero; preserving exit 0 would let teardown regressions pass CI.
if [ "${CLOUDBENCH_TEST_CLEANUP_EXIT_SELF_TEST:-0}" = "1" ]; then
    WS_A="$TMP_ROOT/forced-hub-cleanup-failure"
    WS_B=""
    terminate_test_owned_hubs() { return 1; }
    exit 0
fi
cleanup_exit_status=0
TMPDIR="$TMP_ROOT" CLOUDBENCH_TEST_CLEANUP_EXIT_SELF_TEST=1 \
    bash "$ROOT_DIR/scripts/tests/cloudbench-multi-workstream.test.sh" \
    >/dev/null 2>&1 || cleanup_exit_status=$?
[ "$cleanup_exit_status" = "1" ] \
    || fail "an exact Hub cleanup failure must make an otherwise-green harness exit nonzero"
echo "PASS: exact Hub cleanup failure is a hard harness failure"

fleet_production_function() {
    awk -v function_name="$1" '
      $0 ~ "^" function_name "\\(\\)" { capture = 1 }
      capture { print }
      capture && /^}$/ { exit }
    ' "$ROOT_DIR/scripts/run-bench-fleet" "$ROOT_DIR/scripts/lib/cloudbench-inventory.sh"
}

clone_source_read_rate_limit_contract() (
    local function_name function_source call_count refresh_count status=0
    local clone_output="$TMP_ROOT/clone-source-rate-limit.out"
    local clone_error="$TMP_ROOT/clone-source-rate-limit.err"
    local clone_calls="$TMP_ROOT/clone-source-rate-limit.calls"
    local refresh_calls="$TMP_ROOT/clone-source-rate-limit-refresh.calls"
    local ledger="$TMP_ROOT/clone-source-rate-limit/primary.ids"

    DISPOSABLE_LIFECYCLE=1; POOL_REUSE_ONLY=0; PROVISION_POOL=""
    for function_name in machine_creation_admission fleet_clone_with_queue_admission clone_failure_definitively_unallocated \
        clone_failure_owned_volume_id machine_id_for_clone_name clone_volume_receipt_field clone_attach_failure_prelaunch \
        clone_retire_owned_volume clone_create_owned_volume clone_storage_ready_seconds clone_machine_target; do
        function_source="$(fleet_production_function "$function_name")"
        [ -n "$function_source" ] \
            || { echo "FAIL: could not load production $function_name" >&2; return 1; }
        eval "$function_source"
    done

    : > "$clone_calls"
    : > "$refresh_calls"
    APP="$FLEET_BENCH_APP"
    WARM_ID="683e47df5094d8"
    SNAP_ID="vs_captured"
    REGION="iad"
    CLOUDBENCH_CLONE_MAX_ATTEMPTS=2
    CLOUDBENCH_CLONE_RETRY_SECONDS=0
    CLOUDBENCH_CLONE_RETRY_MAX_SECONDS=0
    CLOUDBENCH_CLONE_LOOKUP_SECONDS=0
    RANDOM=0

    fleet_registry_record_name() { return 0; }
    fleet_registry_record_id() { return 0; }
    fleet_disable_disposable_volume_snapshots() {
        [ -f "$TMP_ROOT/storage-ready-completed" ] || return 1
        printf 'backup-disabled-after-ready\n' >> "$TMP_ROOT/backup-order"
    }
    fleet_registry_release_name() { return 0; }
    fleet_audit_update_fresh_clone() { return 0; }
    registry_resolve_name() { return 1; }
    worker_ledger_lock_acquire() { return 0; }
    worker_ledger_lock_release() { return 0; }
    machine_volume_id() { printf 'vol_captured'; }
    # Fake Machines API: the clone's exact Volume is created and owned first.
    fleet_clone_volume_request() {
        printf '%s\n' "$*" >> "$TMP_ROOT/clone-source-rate-limit.volume-requests"
        printf '{"outcome":"created","id":"vol_captured"}\n'
    }
    fleet_registry_record_volume() { return 0; }
    reap_volume() { return 0; }
    machine_storage_ready() {
        if [ ! -e "$TMP_ROOT/storage-restoring-observed" ]; then
            : > "$TMP_ROOT/storage-restoring-observed"
            return 1
        fi
        : > "$TMP_ROOT/storage-ready-completed"
        return 0
    }
    machine_storage_failed() { return 1; }
    inventory_machine_field() { printf '1'; }
    inventory_machine_id_for_name() { return 1; }
    machines_snapshot_identity() {
        printf 'generation-%s' "$(wc -l < "$refresh_calls" | tr -d ' ')"
    }
    refresh_machines_snapshot_after() {
        printf 'refresh\n' >> "$refresh_calls"
        return 0
    }
    sleep() { :; }
    fly_with_timeout() {
        call_count="$(wc -l < "$clone_calls" | tr -d ' ')"
        call_count=$((call_count + 1))
        printf '%s\n' "$call_count" >> "$clone_calls"
        if [ "$call_count" -eq 1 ]; then
            printf '%s\n' \
                "Error: could not get machine 683e47df5094d8: failed to get VM 683e47df5094d8: resource_exhausted: rate limit exceeded (Request ID: captured-lax)" >&2
            return 1
        fi
        printf '%s\n' "Machine abcdef12345678 has been created..."
    }

    mkdir -p "$(dirname "$ledger")"
    clone_machine_target "$ledger" > "$clone_output" 2> "$clone_error" || status=$?
    [ -s "$TMP_ROOT/backup-order" ] || { echo "FAIL: backup configuration did not follow storage readiness" >&2; return 1; }
    [ "$status" -eq 0 ] \
        || { echo "FAIL: captured source-read rejection did not reach the successful retry" >&2; return 1; }
    [ "$(cat "$clone_output")" = "abcdef12345678" ] \
        || { echo "FAIL: successful retry returned the wrong clone id" >&2; return 1; }
    call_count="$(wc -l < "$clone_calls" | tr -d ' ')"
    [ "$call_count" -eq 2 ] \
        || { echo "FAIL: captured source-read rejection used $call_count clone attempts, expected 2" >&2; return 1; }
    # A source read rejected before Launch keeps the same owned Volume.
    [ "$(wc -l < "$TMP_ROOT/clone-source-rate-limit.volume-requests" | tr -d ' ')" -eq 1 ] \
        || { echo "FAIL: allocation-free source-read retry created a duplicate Volume" >&2; return 1; }
    refresh_count="$(wc -l < "$refresh_calls" | tr -d ' ')"
    if [ "$refresh_count" -ne 0 ]; then
        echo "FAIL: source-machine rate-limit rejection crossed into post-mutation clone-name resolution ($refresh_count forced inventory refreshes)" >&2
        cat "$clone_error" >&2
        return 1
    fi
    if grep -qF "unresolved clone name" "$clone_error"; then
        echo "FAIL: pre-allocation source-machine rejection was misreported as an unresolved allocated clone" >&2
        return 1
    fi
)

if [ "${CLOUDBENCH_TEST_CLONE_SOURCE_RATE_LIMIT_REPRO:-0}" = "1" ]; then
    clone_source_read_rate_limit_contract
    exit $?
fi

clone_source_read_rate_limit_contract \
    || fail "source-machine read rejection crossed into target reconciliation"
echo "PASS: source-machine read failures remain pre-allocation clone failures"

restoring_volume_reappearance_contract() (
    local function_name function_source list_count settle_count status=0
    local contract_root="$TMP_ROOT/restoring-volume-reappearance"
    local calls="$contract_root/provider.calls"
    local list_step="$contract_root/list-step"
    local audit="$contract_root/fresh-clone.audit"
    local registry_record="$contract_root/registry/clones/cloudbench-restoring"
    local settled_inventory

    for function_name in volume_inventory_contains_id reap_volume; do
        function_source="$(fleet_production_function "$function_name")"
        [ -n "$function_source" ] \
            || { echo "FAIL: could not load production $function_name" >&2; return 1; }
        eval "$function_source"
    done

    mkdir -p "${registry_record%/*}"
    : > "$calls"
    printf '0\n' > "$list_step"
    {
        printf 'machine_id=deadbeef000001\n'
        printf 'volume_id=vol_restoring\n'
        printf 'disposition=owned\n'
    } > "$audit"
    printf 'name=cloudbench-restoring\nid=deadbeef000001\nvolume_id=vol_restoring\n' \
        > "$registry_record"
    APP="$FLEET_BENCH_APP"
    WARM_VOLUME_ID=vol_warm

    FLY() {
        printf '%s\n' "$*" >> "$calls"
        case "$1 $2" in
            "volumes destroy")
                return 0
                ;;
            "volumes list")
                list_count="$(cat "$list_step")"
                list_count=$((list_count + 1))
                printf '%s\n' "$list_count" > "$list_step"
                if [ "$list_count" -le 2 ]; then
                    printf '[]\n'
                else
                    printf '[{"id":"vol_restoring","name":"cloudbench_data","state":"created","attached_machine_id":null}]\n'
                fi
                return 0
                ;;
        esac
        return 99
    }
    sleep() { :; }

    reap_volume vol_restoring || status=$?
    if [ "$status" -ne 0 ]; then
        for settle_count in 1 2 3; do
            settled_inventory="$(FLY volumes list -a "$APP" --json)" || return 1
            printf '%s' "$settled_inventory" | grep -q '"id":"vol_restoring"' && break
        done
        printf '%s' "$settled_inventory" | grep -q '"id":"vol_restoring"' \
            || { echo "FAIL: restoring volume did not reappear after retained teardown authority" >&2; return 1; }
        grep -Fxq 'disposition=owned' "$audit" \
            || { echo "FAIL: nonterminal restoring volume lost its owned audit disposition" >&2; return 1; }
        [ -f "$registry_record" ] \
            || { echo "FAIL: nonterminal restoring volume lost its exact registry authority" >&2; return 1; }
        return 0
    fi

    sed 's/^disposition=owned$/disposition=destroyed-verified-absent/' \
        "$audit" > "$audit.tmp"
    mv "$audit.tmp" "$audit"
    rm -f "$registry_record"

    settled_inventory="$(FLY volumes list -a "$APP" --json)" || return 1
    if printf '%s' "$settled_inventory" | grep -q '"id":"vol_restoring"'; then
        echo "FAIL: teardown sealed destroyed-verified-absent after two transient absences; vol_restoring reappeared provider-visible as detached created" >&2
        return 1
    fi
)

if [ "${CLOUDBENCH_TEST_RESTORING_VOLUME_REAP_REPRO:-0}" = "1" ]; then
    restoring_volume_reappearance_contract
    exit $?
fi

restoring_volume_reappearance_contract \
    || fail "restoring volume reappeared after exact teardown authority was retired"
echo "PASS: volume teardown survives transient restore-time provider absence"

registry_retirement_during_scan_contract() (
    local root registry meta signal owner_pid owner_start
    local registry_meta_source cleanup_state_source registry_alive_source
    local reconcile_source reconcile_full_source race_error malformed_error
    root="$TMP_ROOT/registry-retirement-race"
    registry="$root/retiring-owner"
    meta="$registry/meta"
    signal="$root/remove-owner"
    mkdir -p "$registry/clones"

    registry_meta_source="$(fleet_production_function registry_meta_value)"
    cleanup_state_source="$(fleet_production_function fleet_registry_cleanup_state)"
    registry_alive_source="$(fleet_production_function registry_owner_alive)"
    reconcile_source="$(fleet_production_function reconcile_stale_fleet_registries)"
    # The cohort-aware entrypoint delegates an ordinary scan to the full
    # reconciler; load both so the contract exercises the real scan.
    reconcile_full_source="$(fleet_production_function reconcile_stale_fleet_registries_full)"
    [ -n "$registry_meta_source" ] && [ -n "$cleanup_state_source" ] \
        && [ -n "$registry_alive_source" ] \
        && [ -n "$reconcile_source" ] && [ -n "$reconcile_full_source" ] \
        || fail "could not load the production fleet-registry reconciliation boundary"
    registry_meta_source="${registry_meta_source/registry_meta_value()/production_registry_meta_value()}"
    eval "$registry_meta_source"
    eval "$cleanup_state_source"
    eval "$registry_alive_source"
    eval "$reconcile_source"
    eval "$reconcile_full_source"

    (
        # Bounded: a scan that never reads the owner's host must fail this
        # contract, not leave the suite waiting on an unsignalled owner.
        owner_deadline=$((SECONDS + 60))
        while [ ! -e "$signal" ] && [ "$SECONDS" -lt "$owner_deadline" ]; do sleep 0.01; done
        rm -rf "$registry"
    ) &
    owner_pid=$!
    owner_start="$(ps -p "$owner_pid" -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    {
        printf 'version=2\n'
        printf 'app=%s\n' "$FLEET_BENCH_APP"
        printf 'cleanup_policy=reap\n'
        printf 'host=%s\n' "$(hostname 2>/dev/null || uname -n)"
        printf 'pid=%s\n' "$owner_pid"
        printf 'pid_start=%s\n' "$owner_start"
    } > "$meta"

    RETIRING_META_PATH="$meta"
    RETIRING_REGISTRY_PATH="$registry"
    RETIRING_SIGNAL_PATH="$signal"
    registry_meta_value() {
        local target_meta="$1" key="$2" value
        value="$(production_registry_meta_value "$target_meta" "$key")"
        if [ "$target_meta" = "$RETIRING_META_PATH" ] \
            && [ "$key" = "host" ] && [ -e "$target_meta" ]; then
            : > "$RETIRING_SIGNAL_PATH"
            while [ -e "$RETIRING_REGISTRY_PATH" ]; do sleep 0.01; done
        fi
        printf '%s' "$value"
    }

    FLEET_OWNERSHIP_ROOT="$root"
    FLEET_REGISTRY_DIR="$root/current-owner"
    FLEET_OWNER_HOST="$(hostname 2>/dev/null || uname -n)"
    APP="$FLEET_BENCH_APP"
    if ! reconcile_stale_fleet_registries 2> "$root/race.err"; then
        race_error="$(cat "$root/race.err")"
        wait "$owner_pid" 2>/dev/null || true
        fail "a registry retired by its live owner during startup scan was rejected: $race_error"
    fi
    wait "$owner_pid" || fail "retiring registry owner did not exit cleanly"
    if grep -qF "invalid controller identity" "$root/race.err"; then
        fail "a vanished owner registry was misclassified as malformed identity"
    fi

    mkdir -p "$root/malformed-owner/clones"
    {
        printf 'version=2\n'
        printf 'app=%s\n' "$APP"
        printf 'cleanup_policy=reap\n'
        printf 'host=%s\n' "$FLEET_OWNER_HOST"
        printf 'pid=not-a-pid\n'
        printf 'pid_start=still-present\n'
    } > "$root/malformed-owner/meta"
    if reconcile_stale_fleet_registries 2> "$root/malformed.err"; then
        fail "a still-present malformed owner registry did not fail closed"
    fi
    malformed_error="$(cat "$root/malformed.err")"
    case "$malformed_error" in
        *"invalid controller identity in $root/malformed-owner"*) ;;
        *) fail "malformed owner registry failed at the wrong boundary: $malformed_error" ;;
    esac
)

registry_retirement_during_scan_contract \
    || fail "fleet-registry retirement concurrency contract failed"
echo "PASS: a concurrently retired registry is benign while present malformed ownership fails closed"
if [ "${CLOUDBENCH_TEST_REGISTRY_RETIRE_RACE_SELF_TEST:-0}" = "1" ]; then
    exit 0
fi

assert_no_controller_script_snapshots() {
    local phase="$1" leaked
    leaked="$(find "$SCRIPT_SNAPSHOT_TMP" -mindepth 1 -maxdepth 1 \
        -type d -name 'cloudbench-scripts.*' -print 2>/dev/null || true)"
    [ -z "$leaked" ] || fail "$phase leaked invocation-owned script snapshots: $leaked"
}

# ── A scratch repo + two worktrees = two workstreams on one machine ─────────
SANDBOX="$TMP_ROOT/repo"
mkdir -p "$SANDBOX"
cp -R "$ROOT_DIR/scripts" "$SANDBOX/scripts"
mkdir -p "$SANDBOX/.claude/shared"
cp "$ROOT_DIR/.claude/shared/benchmark-report-format.txt" "$SANDBOX/.claude/shared/"
cp -R "$ROOT_DIR/agents/benchmarks/fleet_startup_phase.py" "$SANDBOX/scripts/" 2>/dev/null || true
# Keep the synthetic worktrees dependency-fingerprintable. Pool compatibility is
# now a fail-closed production contract, so an intentionally minimal fake repo
# still needs real (minimal) manifests rather than relying on an absent proof.
mkdir -p "$SANDBOX/back-end/scripts" "$SANDBOX/back-end/prisma" \
  "$SANDBOX/front-end" "$SANDBOX/agents/benchmarks" "$SANDBOX/agents/providers/rose"
# The real controller resolves WMH_ROSE_POOL through this authoritative registry.
cp "$ROOT_DIR/agents/providers/rose/pools.py" "$SANDBOX/agents/providers/rose/pools.py"
printf '.context/\n**/.env\n' > "$SANDBOX/.gitignore"
cp "$ROOT_DIR/agents/benchmarks/hub_upload.py" "$SANDBOX/agents/benchmarks/hub_upload.py"
cp "$ROOT_DIR/agents/benchmarks/outcome_publication.py" \
    "$SANDBOX/agents/benchmarks/outcome_publication.py"
cp "$ROOT_DIR/agents/benchmarks/agent_link_server.py" \
    "$SANDBOX/agents/benchmarks/agent_link_server.py"
# Cloud routing resolves the same two-shard task namespace as the real runner.
# Keep the synthetic Fleet tasks explicit so an unknown name or absent shard
# remains a hard failure instead of being silently coerced to real mode.
# Match the existing --timeout 240 fixture calls; shorter explicit caps still
# govern cancellation cases, and the 9000s default-detach case stays distinct.
cat > "$SANDBOX/agents/benchmarks/tasks.json" <<'TASKCATALOG'
[
  {"name":"bench-alpha","timeout_seconds":240},
  {"name":"bench-beta","timeout_seconds":240},
  {"name":"bench-default-detach","timeout_seconds":9000},
  {"name":"bench-detached-wait","timeout_seconds":240},
  {"name":"bench-invalid-recovery","timeout_seconds":240},
  {"name":"bench-detached-cancel","timeout_seconds":240},
  {"name":"bench-group-term","timeout_seconds":240},
  {"name":"bench-group-term-undeliverable","timeout_seconds":240},
  {"name":"bench-group-term-slowdrain","timeout_seconds":240},
  {"name":"private-ip-proxy","timeout_seconds":240},
  {"name":"autoscaler-must-start","timeout_seconds":240},
  {"name":"autoscaler-waits-for-boot-release","timeout_seconds":240},
  {"name":"autoscaler-metrics-required","timeout_seconds":240},
  {"name":"autoscaler-worker-required","timeout_seconds":240},
  {"name":"autoscaler-worker-never-ready","timeout_seconds":240},
  {"name":"autoscaler-worker-clone-pending","timeout_seconds":240},
  {"name":"autoscaler-worker-oscillation","timeout_seconds":240},
  {"name":"autoscaler-worker-destroy-failure","timeout_seconds":240},
  {"name":"autoscaler-concurrent-ready-scale-down","timeout_seconds":240},
  {"name":"autoscaler-post-child-ready","timeout_seconds":240},
  {"name":"autoscaler-missing-terminal","timeout_seconds":240},
  {"name":"capacity-a","timeout_seconds":240},
  {"name":"capacity-b","timeout_seconds":240},
  {"name":"capacity-c","timeout_seconds":240},
  {"name":"capacity-d","timeout_seconds":240},
  {"name":"capacity-e","timeout_seconds":240},
  {"name":"capacity-f","timeout_seconds":240},
  {"name":"capacity-g","timeout_seconds":240},
  {"name":"capacity-h","timeout_seconds":240},
  {"name":"capacity-i","timeout_seconds":240},
  {"name":"orphan-source","timeout_seconds":240},
  {"name":"orphan-recovery","timeout_seconds":240},
  {"name":"busy-source","timeout_seconds":240},
  {"name":"must-not-launch","timeout_seconds":240},
  {"name":"must-wait-for-provider","timeout_seconds":240},
  {"name":"delayed-visible","timeout_seconds":240},
  {"name":"cross-pool-recovery","timeout_seconds":240},
  {"name":"pool-stop-failure","timeout_seconds":240},
  {"name":"safe-skips","timeout_seconds":240},
  {"name":"malformed-registry","timeout_seconds":240},
  {"name":"probe-error","timeout_seconds":240}
]
TASKCATALOG
printf '[{"name":"polar-fixture"}]\n' > "$SANDBOX/agents/benchmarks/polar_tasks.json"
# Sibling of hub_upload.py: script-mode upload loads this via file path
# (`_load_tree_helpers`), not `from benchmarks.logs` (a colliding
# `benchmarks` package wins on sys.path). Keep the synthetic worktree
# hermetic: only the two pure helpers, not the full httpx/asyncio logs module.
cat > "$SANDBOX/agents/benchmarks/logs.py" <<'LOGSSTUB'
"""Minimal stubs for hub_upload tree canonicalization in fleet fixtures."""


def canonicalize_agent_tree(raw):
    return raw if isinstance(raw, dict) else {}


def tree_child_transcript_count(tree, root_id):
    if not isinstance(tree, dict):
        return 0
    return sum(
        1
        for agent_id, info in tree.items()
        if agent_id != root_id
        and isinstance(info, dict)
        and isinstance(info.get("messages"), list)
        and info["messages"]
    )
LOGSSTUB
# run-bench-fleet preflights the guest-pg canonical seed dump before clone.
# Keep the synthetic worktrees hermetic: real token helper + stub R2 get.
cp "$ROOT_DIR/agents/benchmarks/seed_cache_path.py" "$SANDBOX/agents/benchmarks/seed_cache_path.py"
printf '// cloudbench-multi seed-token fixture\n' > "$SANDBOX/back-end/prisma/schema.prisma"
cat > "$SANDBOX/back-end/scripts/seed-dump-cache.ts" <<'SEEDSTUB'
import { writeFileSync } from "node:fs";

const [, , cmd, , file] = process.argv;
if (cmd === "get" && typeof file === "string" && file.length > 0) {
  writeFileSync(file, "cloudbench-multi-stub-seed-dump\n");
  process.exit(0);
}
console.error("usage: seed-dump-cache.ts <get|put> <token> <file>");
process.exit(2);
SEEDSTUB
printf '{}\n' > "$SANDBOX/package.json"
mkdir -p "$SANDBOX/node_modules/.bin"
cat > "$SANDBOX/node_modules/.bin/tsx" <<'TSXSHIM'
#!/bin/bash
# Hermetic worktrees have no npm cache. Node 22 can load the stub .ts directly.
exec node --experimental-strip-types "$@"
TSXSHIM
chmod +x "$SANDBOX/node_modules/.bin/tsx"
printf '{}\n' > "$SANDBOX/back-end/package.json"
printf '{}\n' > "$SANDBOX/front-end/package.json"
printf '{}\n' > "$SANDBOX/back-end/package-lock.json"
: > "$SANDBOX/agents/requirements.txt"
git -C "$SANDBOX" init -q
git -C "$SANDBOX" -c user.email=test@test -c user.name=test add -A
git -C "$SANDBOX" -c user.email=test@test -c user.name=test commit -qm "snapshot" >/dev/null
# Model the real transport boundary: origin/main advertises the shared base,
# while each Conductor worktree's snapshot commit remains local/unpushed and
# must travel in the complete workspace patch.
ORIGIN="$TMP_ROOT/origin.git"
git init -q --bare "$ORIGIN"
git -C "$SANDBOX" branch -M main
git -C "$SANDBOX" remote add origin "$ORIGIN"
git -C "$SANDBOX" push -q -u origin main
BASE_REF="$(git -C "$SANDBOX" rev-parse HEAD)"
# The fake provider exposes snap_0001 as the warm snapshot. Tie the manifest
# proof to that exact ID, mirroring --refresh-deps without a live donor image.
(
    source "$SANDBOX/scripts/lib/cloudbench-env.sh"
    node_fp="$(cloudbench_node_dependency_fingerprint "$SANDBOX")"
    py_fp="$(cloudbench_manifest_fingerprint "$SANDBOX" "${CLOUDBENCH_PYTHON_MANIFESTS[@]}")"
    printf '%s %s 0 snap_0001\n' "$node_fp" "$py_fp" > "$SANDBOX/.git/cloudbench-warm-deps.fp"
    # This fake donor models a published image as well as its volume snapshot.
    # Keep its proof pinned to the original manifests so later drift still fails.
    python3 - "$TMP_ROOT/image-build.fixture.json" "$node_fp" "$py_fp" <<'PY_IMAGE_PROOF'
import json, sys
from pathlib import Path
image = "registry.fly.io/navi-whisper-lux-bench@sha256:" + "a" * 64
Path(sys.argv[1]).write_text(json.dumps({
    "schema": "cloudbench-image-build-v1", "publication_verified": True,
    "published_image_ref": image, "image_ref": image,
    "published_digest": "sha256:" + "a" * 64,
    "node_dependency_fingerprint": sys.argv[2],
    "python_dependency_fingerprint": sys.argv[3],
}) + "\n")
PY_IMAGE_PROOF
)
FIXTURE_IMAGE_BUILD_RECEIPT="$TMP_ROOT/image-build.fixture.json"
FIXTURE_IMAGE_BUILD_RECEIPT_SHA256="$(python3 - "$FIXTURE_IMAGE_BUILD_RECEIPT" <<'PY_IMAGE_HASH'
import hashlib, sys
from pathlib import Path
print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY_IMAGE_HASH
)"
WS_A="$TMP_ROOT/ws-a"
WS_B="$TMP_ROOT/ws-b"
git -C "$SANDBOX" worktree add -q -b ws-a "$WS_A" >/dev/null
git -C "$SANDBOX" worktree add -q -b ws-b "$WS_B" >/dev/null
# Distinct code snapshots per workstream: the run must carry each worktree's
# own HEAD sha through to its machines.
echo "workstream-a" > "$WS_A/SNAPSHOT.txt"
git -C "$WS_A" -c user.email=test@test -c user.name=test add SNAPSHOT.txt
git -C "$WS_A" -c user.email=test@test -c user.name=test commit -qm "ws-a snapshot" >/dev/null
echo "workstream-b" > "$WS_B/SNAPSHOT.txt"
git -C "$WS_B" -c user.email=test@test -c user.name=test add SNAPSHOT.txt
git -C "$WS_B" -c user.email=test@test -c user.name=test commit -qm "ws-b snapshot" >/dev/null
REF_A="$(git -C "$WS_A" rev-parse HEAD)"
REF_B="$(git -C "$WS_B" rev-parse HEAD)"
POOL_A="$SANDBOX/.git/cloudbench-pools/ws-a.ids"
POOL_B="$SANDBOX/.git/cloudbench-pools/ws-b.ids"
# The child controller resolves the API key + GitHub token from local .env files.
for ws in "$WS_A" "$WS_B"; do
    mkdir -p "$ws/back-end" "$ws/agents"
    printf 'BACKEND_API_KEY=test-key\nGITHUB_TOKEN=test-token\n' > "$ws/back-end/.env"
    printf 'BACKEND_API_KEY=test-key\n' > "$ws/agents/.env"
done

# ── Fake flyctl: shared journaled state + a cross-controller clone barrier ──
FAKE_DIR="$TMP_ROOT/fake-fly"
FAKE_BIN="$TMP_ROOT/fake-bin"
mkdir -p "$FAKE_DIR/markers" "$FAKE_BIN"

# The provider is simulated, so its controllers share one bounded simulated
# disk, not the host filesystem's live cleanup-admission ledger or blocks.
prepare_fixture_storage_transport() {
    FIXTURE_STORAGE="$TMP_ROOT/reserve-transport"
    mkdir -p "$FIXTURE_STORAGE"
    FIXTURE_STORAGE_DEVICE="$(python3 - "$TMP_ROOT" <<'PY'
import hashlib,os,sys,time
print(2**48+int(hashlib.sha256(f'{sys.argv[1]}:{os.getpid()}:{time.time_ns()}'.encode()).hexdigest()[:12],16)+1)
PY
)" || return 1
    printf '%s\n' '{"capacity_mb":18000,"allocations":{}}' > "$FIXTURE_STORAGE/state.json"
    cat > "$FIXTURE_STORAGE/sitecustomize.py" <<'PY'
import fcntl,json,os,stat
from pathlib import Path
scope=Path(os.environ['CLOUDBENCH_TEST_STORAGE_SCOPE'])
state=Path(os.environ['CLOUDBENCH_TEST_STORAGE_STATE'])
real_lstat,real_fstat=Path.lstat,os.fstat

def private(path):
    return Path(path).is_relative_to(scope)

def observed_path(self,*args,**kwargs):
    value=real_lstat(self,*args,**kwargs)
    if private(self) and stat.S_ISDIR(value.st_mode):
        fields=list(value);fields[2]=int(os.environ['CLOUDBENCH_TEST_STORAGE_DEVICE'])
        return os.stat_result(fields)
    if private(self) and self.name=='cleanup-disk-reserve':
        return os.stat_result(tuple(value),{'st_blocks':value.st_size//512})
    return value

def allocate(fd,offset,size):
    path=Path(os.readlink(f'/proc/self/fd/{fd}'))
    if not private(path) or path.name!='cleanup-disk-reserve' or offset!=0:
        raise OSError('fixture allocation escaped its private reserve')
    with (state.parent/'storage.lock').open('a+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        data=json.loads(state.read_text())
        data['allocations']={p:n for p,n in data['allocations'].items() if Path(p).exists()}
        old=data['allocations'].get(str(path),0)
        if sum(data['allocations'].values())-old+size>data['capacity_mb']*1048576:
            raise OSError(28,'bounded fixture disk exhausted')
        os.ftruncate(fd,size)
        data['allocations'][str(path)]=size;state.write_text(json.dumps(data))

def observed_fd(fd):
    value=real_fstat(fd)
    try:path=Path(os.readlink(f'/proc/self/fd/{fd}'))
    except OSError:return value
    if private(path) and path.name=='cleanup-disk-reserve':
        return os.stat_result(tuple(value),{'st_blocks':value.st_size//512})
    return value
Path.lstat=observed_path
os.posix_fallocate=allocate
os.fstat=observed_fd
PY
    cat > "$FIXTURE_STORAGE/df" <<'PY'
#!/usr/bin/env python3
import fcntl,json,os,sys
from pathlib import Path
scope=Path(os.environ['CLOUDBENCH_TEST_STORAGE_SCOPE'])
if not Path(sys.argv[-1]).is_relative_to(scope):raise SystemExit('fixture df escaped private scope')
p=Path(os.environ['CLOUDBENCH_TEST_STORAGE_STATE'])
with (p.parent/'storage.lock').open('a+') as lock:
 fcntl.flock(lock,fcntl.LOCK_SH);data=json.loads(p.read_text())
 allocated=sum(n for name,n in data['allocations'].items() if Path(name).exists())
 free=data['capacity_mb']*1048576-allocated
 print('Filesystem 1024-blocks Used Available Capacity Mounted on')
 print('fixture 20000000 0',free//1024,'0% /fixture')
PY
    chmod 700 "$FIXTURE_STORAGE/df"
}

prepare_fixture_storage_transport || exit 1

reset_fake_state() {
    rm -rf "$FAKE_DIR/markers" "$FAKE_DIR/machines"
    mkdir -p "$FAKE_DIR/markers" "$FAKE_DIR/machines"
    cat > "$FAKE_DIR/state.json" <<'JSON'
{
  "secrets": ["AGENTS_ENV_B64", "BACKEND_ENV_B64", "AGENTS_ENV_SHA256",
              "BACKEND_ENV_SHA256", "CLOUDBENCH_BROWSER_PROVIDER", "CLOUDBENCH_WORKER_BROWSER_PROVIDER", "GITHUB_TOKEN"],
  "machines": [
    {"id": "aaaa0000000001", "name": "cloudbench-warm", "state": "stopped",
     "region": "iad", "private_ip": "",
     "config": {"image": "registry.fly.io/navi-whisper-lux-bench@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "mounts": [{"volume": "vol_aaaa0001", "path": "/data", "size_gb": 40}]}}
  ],
  "volumes": [
    {"id": "vol_aaaa0001", "name": "cloudbench_data", "state": "created", "size_gb": 40,
     "attached_machine_id": "aaaa0000000001"}
  ],
  "snapshots": [
    {"id": "snap_0001", "status": "created",
     "created_at": "2026-07-13T00:00:00Z", "size": 1000000}
  ]
}
JSON
}

reset_fake_state

cat > "$FAKE_DIR/flyctl.py" <<'PY'
import base64
import fcntl
import glob
import hashlib
import importlib.util
import ipaddress
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

FAKE_DIR = os.environ["CLOUDBENCH_FAKE_DIR"]
STATE = os.path.join(FAKE_DIR, "state.json")
LOCK = os.path.join(FAKE_DIR, "state.lock")
JOURNAL = os.path.join(FAKE_DIR, "journal.log")
MARKERS = os.path.join(FAKE_DIR, "markers")
MACHINES_DIR = os.path.join(FAKE_DIR, "machines")
BENCH_APP = "navi-whisper-lux-bench"
PROD_APP = "navi-whisper-lux"

args = sys.argv[1:]


def flag_value(name):
    return args[args.index(name) + 1] if name in args else None


def machine_dir(machine_id):
    mdir = os.path.join(MACHINES_DIR, machine_id)
    os.makedirs(os.path.join(mdir, "data"), exist_ok=True)
    os.makedirs(os.path.join(mdir, "tmp"), exist_ok=True)
    os.makedirs(os.path.join(mdir, "home"), exist_ok=True)
    return mdir


def rewrite_paths(mdir, command):
    # Rewrite only guest text, never a /data prefix just inserted for the host.
    prefixes = ("/tmp/rb.sh", "/tmp/rbw.sh", "/tmp/rbw.env", "/tmp/cloudbench-local.patch", "/data")
    return re.sub("|".join(map(re.escape, prefixes)), lambda match: mdir + match.group(0), command)


class locked_state:
    def __enter__(self):
        self.handle = open(LOCK, "a+")
        fcntl.flock(self.handle, fcntl.LOCK_EX)
        with open(STATE) as fh:
            self.state = json.load(fh)
        return self.state

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            with open(STATE + ".tmp", "w") as fh:
                json.dump(self.state, fh)
            os.replace(STATE + ".tmp", STATE)
        fcntl.flock(self.handle, fcntl.LOCK_UN)
        self.handle.close()
        return False


def find_machine(state, machine_id):
    return next((m for m in state["machines"] if m["id"] == machine_id), None)


def find_volume(state, volume_id):
    return next((v for v in state["volumes"] if v["id"] == volume_id), None)


def rb_export(rb_text, key):
    match = re.search(rf"^export {key}=(.*)$", rb_text, re.MULTILINE)
    if not match:
        return ""
    value = match.group(1).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return value


def run_fake_worker(mdir, machine_id):
    """Run the real staged supervisor around a finite fake worker workload."""
    data = Path(mdir, "data")
    agents = data / "repo" / "agents"
    agents.mkdir(parents=True, exist_ok=True)
    wrapper = Path(mdir, "tmp", "rbw.sh").read_text()
    token = rb_export(wrapper, "CLOUDBENCH_WORKER_RUN_TOKEN")
    assert rb_export(wrapper, "CLOUDBENCH_WORKER_MACHINE_ID") == machine_id
    assert rb_export(wrapper, "CLOUDBENCH_WORKER_EVIDENCE_HELPER") == "/data/cloudbench-worker-evidence.py"
    helper = data / "cloudbench-worker-evidence.py"
    assert helper.is_file() and not helper.is_symlink()
    state = data / "cloudbench-worker-evidence"
    failed = os.path.exists(os.path.join(FAKE_DIR, "fail-worker-after-start"))
    if state.exists():
        # Staging retries reupload scripts, but may never replace an admitted
        # supervisor, terminal receipt, or its logs. Preserve the real result.
        owner = json.loads((state / "owner.json").read_bytes())
        terminal = json.loads((state / "terminal.json").read_bytes())
        for row in (owner, terminal):
            assert row["run_token"] == token and row["machine_id"] == machine_id
        assert terminal["supervisor"] == owner["supervisor"]
        assert terminal["quiescent"] and terminal["children_reaped"] and terminal["streams_closed"]
        return terminal["exit_code"]
    workload = (
        "import os,pathlib,sys,time\n"
        "agents=pathlib.Path(sys.argv[1]);token=sys.argv[2];machine=sys.argv[3]\n"
        "for name in ('navi-worker-log.txt','navi-worker-log.1.txt'):\n"
        " (agents/name).write_text('fake complete worker '+name+' token='+token+' machine='+machine+'\\n')\n"
        "print('fake worker bootstrap token='+token+' machine='+machine,flush=True)\n"
        "print('fake worker terminal exit='+sys.argv[4],flush=True)\n"
        "time.sleep(0.1)\n"
        "raise SystemExit(int(sys.argv[4]))\n"
    )
    environment = dict(os.environ, FLY_MACHINE_ID=machine_id,
        CLOUDBENCH_WORKER_RUN_TOKEN=token, CLOUDBENCH_WORKER_MACHINE_ID=machine_id,
        WORKER_PROCESSES="2", NAVI_WORKER_LOG_FILE="navi-worker-log.txt")
    environment.pop("WORKER_READY_FILE", None)
    environment.pop("CLOUDBENCH_WORKER_SUPERVISED", None)
    command = [sys.executable, str(helper), "run", "--run-token", token,
        "--machine-id", machine_id, "--data-dir", str(data), "--agents-dir", str(agents),
        "--", sys.executable, "-c", workload, str(agents), token, machine_id, "1" if failed else "0"]
    process = subprocess.Popen(command, env=environment, stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        _, error = process.communicate(timeout=10)
    except BaseException:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        raise
    if error:
        sys.stderr.write(error)
    assert process.returncode == (1 if failed else 0), "real fake-worker supervisor failed"
    terminal = json.loads((state / "terminal.json").read_bytes())
    assert terminal["exit_code"] == process.returncode
    assert terminal["quiescent"] and terminal["children_reaped"] and terminal["streams_closed"]
    return process.returncode


def run_fake_driver(mdir):
    """Emulate the on-box driver contract: barrier-ready → wait for the fleet's
    data-plane release POST → write report-card.json/run.json → DONE marker. The PASS
    therefore requires the real controller loop to complete every leg."""
    rb_text = open(os.path.join(mdir, "tmp", "rb.sh")).read()
    token = rb_export(rb_text, "CLOUDBENCH_RUN_TOKEN")
    barrier = rb_export(rb_text, "CLOUDBENCH_START_BARRIER")
    ref = rb_export(rb_text, "REF")
    # Execute the staged decoder, matching the real boot supervisor before any
    # driver work. The provider mock must consume the actual wire format, not
    # assume helpers still arrive as individual --file-local entries.
    payload_file = rb_export(rb_text, "CLOUDBENCH_BOOT_PAYLOAD_FILE")
    if payload_file:
        subprocess.run([
            sys.executable, os.path.join(mdir, "cloudbench-boot-payload.py"),
            "unpack", os.path.join(mdir, PurePosixPath(payload_file).name),
            rb_export(rb_text, "CLOUDBENCH_BOOT_PAYLOAD_SHA256"), mdir,
        ], check=True)
    patch_file = rb_export(rb_text, "LOCAL_PATCH_FILE")
    patch_text = ""
    if patch_file:
        import gzip
        import hashlib
        patch_path = os.path.join(mdir, PurePosixPath(patch_file).name)
        with open(patch_path, "rb") as source:
            patch_bytes = source.read()
        assert hashlib.sha256(patch_bytes).hexdigest() == rb_export(rb_text, "LOCAL_PATCH_TRANSPORT_SHA256")
        if rb_export(rb_text, "LOCAL_PATCH_COMPRESSION") == "gzip":
            patch_bytes = gzip.decompress(patch_bytes)
        assert hashlib.sha256(patch_bytes).hexdigest() == rb_export(rb_text, "LOCAL_PATCH_SHA256")
        patch_text = patch_bytes.decode()
    workspace_marker = next(
        (marker for marker in ("workstream-a", "workstream-b") if f"+{marker}" in patch_text),
        "",
    )
    import base64
    tasks_csv = base64.b64decode(rb_export(rb_text, "BENCH_TASKS_B64")).decode()
    bench = tasks_csv.split(",")[0].strip()
    log_path = os.path.join(mdir, "data", "bench.log")

    def log(line):
        with open(log_path, "a") as fh:
            fh.write(line + "\n")

    log(f"[cloudbench] fake driver started (bench={bench} ref={ref})")
    exit_code = 0
    if barrier:
        log(f"synchronized start barrier ready: {barrier}")
        release = os.path.join(mdir, "data", f"cloudbench-start-{barrier}.release")
        deadline = time.time() + 120
        while not os.path.exists(release):
            if os.path.exists(os.path.join(mdir, "guest-cleanup.ack")):
                log("fake driver canceled before synchronized release")
                exit_code = 1
                break
            if time.time() > deadline:
                log("FATAL: synchronized start barrier timed out")
                exit_code = 1
                break
            time.sleep(0.5)
        if exit_code == 0:
            log(f"synchronized start barrier released: {barrier}")
    benchmark_started = exit_code == 0
    result_stamped = False
    if exit_code == 0 and bench.startswith("bench-group-term"):
        # A long admitted benchmark keeps executing on its isolated guest, and
        # holding its shared production connections, until the guest receives
        # the authenticated /shutdown or its exact Machine is stopped natively.
        # The bounded deadline stands in for the 7,200 s execution backstop.
        machine_id = os.path.basename(mdir)
        executing_since = time.time()
        Path(MARKERS, "benchmark-executing-" + machine_id).write_text(
            json.dumps({"pid": os.getpid(), "run_token": token, "bench": bench}))
        stop_reason = "execution-backstop"
        while time.time() - executing_since < 240:
            if os.path.exists(os.path.join(mdir, "guest-cleanup.ack")):
                stop_reason = "guest-shutdown"
                break
            if bench == "bench-group-term-slowdrain" and os.path.exists(
                os.path.join(mdir, "shutdown-requested")
            ):
                # The authenticated stop was delivered. Browser close,
                # recording/archive finalization and the delete-seal wait run
                # here, for longer than every bounded acknowledgement window;
                # a native stop would power the Machine off mid-drain.
                try:
                    drain_seconds = float(Path(FAKE_DIR, "slow-drain-seconds").read_text())
                except (OSError, ValueError):
                    drain_seconds = 60.0
                requested_at = float(Path(mdir, "shutdown-requested").read_text())
                stop_reason = "drain-backstop"
                while time.time() - executing_since < 240:
                    if time.time() - requested_at >= drain_seconds:
                        open(os.path.join(mdir, "guest-cleanup.ack"), "w").close()
                        stop_reason = "drain-completed"
                        break
                    try:
                        with open(STATE) as fh:
                            native = find_machine(json.load(fh), machine_id)
                    except (OSError, ValueError):
                        native = {"state": "started"}
                    if native is None or native.get("state") != "started":
                        stop_reason = "drain-interrupted-by-native-stop"
                        break
                    time.sleep(0.2)
                break
            try:
                with open(STATE) as fh:
                    native = find_machine(json.load(fh), machine_id)
            except (OSError, ValueError):
                native = {"state": "started"}
            if native is None or native.get("state") != "started":
                stop_reason = "native-stop" if native is not None else "machine-removed"
                break
            time.sleep(0.2)
        Path(mdir, "benchmark.stopped").write_text(json.dumps({
            "reason": stop_reason, "pid": os.getpid(),
            "executing_seconds": round(time.time() - executing_since, 3),
            "stopped_epoch": time.time(),
        }))
        if stop_reason != "guest-shutdown":
            # A natively stopped Machine powers off: no DONE line, no seal. A
            # slow drain that outlived its runner's acknowledgement window ends
            # without a terminal record for that runner to collect.
            return
        # Graceful cancellation drains the benchmark before any terminal result.
        exit_code = 143
        benchmark_started = False
    def current_task_output():
        # Shared workstream ledgers retain earlier runs. Bind every barrier to
        # this staged driver's exact token, never a previous task's marker.
        workspace = Path(os.environ["CLOUDBENCH_FAKE_CONTROLLER_WS"])
        for candidate in (workspace / ".context/fleet/runs").glob("*/" + bench):
            try:
                owner = json.loads((candidate / "runtime-evidence.owner.json").read_text())
            except (OSError, ValueError):
                continue
            if owner.get("run_token") == token:
                return candidate
        return None

    # Keep the launched-but-unready regression on the boundary it intends to
    # exercise. Without this handshake the intentionally tiny fake benchmark
    # can finish before the asynchronous provisioner has issued its launch
    # command, turning the scenario nondeterministically into the distinct
    # outstanding-capacity case covered below. Wait for the fake launch
    # handler's success marker, not its pre-dispatch journal entry, so an
    # unreachable machine or rejected command cannot satisfy this handshake.
    if exit_code == 0 and (
        os.path.exists(os.path.join(FAKE_DIR, "worker-never-ready"))
        or os.path.exists(os.path.join(FAKE_DIR, "worker-ready-after-child"))
        or os.path.exists(os.path.join(FAKE_DIR, "fail-worker-launch"))
    ):
        launch_boundary = (
            "worker-launch-rejected-"
            if os.path.exists(os.path.join(FAKE_DIR, "fail-worker-launch"))
            else "worker-launch-succeeded-"
        )
        deadline = time.time() + 30
        launched = False
        while time.time() < deadline:
            try:
                launched = any(
                    entry.startswith(launch_boundary)
                    for entry in os.listdir(MARKERS)
                )
            except OSError:
                launched = False
            if launched:
                break
            time.sleep(0.1)
        if not launched:
            log("FATAL: autoscaled worker never crossed launch boundary")
            exit_code = 1
    if exit_code == 0 and os.path.exists(os.path.join(FAKE_DIR, "worker-readiness-retry")):
        # A readiness failure is replaceable only after the real supervisor's
        # terminal evidence is captured and its exact provider machine is gone.
        # Keep queued work active through that boundary, then permit a healthy
        # retry. No transient failure marker or fixture deadline is the fault.
        deadline = time.time() + 30
        failed_worker = None
        ready = []
        while time.time() < deadline:
            output = current_task_output()
            if output:
                for capture in output.glob("worker-runtime-evidence/*/capture"):
                    try:
                        terminal = json.loads((capture / "receipts/terminal.json").read_text())
                        worker = capture.parent.name
                        stage = (output / ("worker-" + worker + ".stage.log")).read_text()
                    except (OSError, ValueError):
                        continue
                    if (terminal.get("run_token") == token
                        and terminal.get("machine_id") == worker
                        and all(terminal.get(key) is True for key in ("quiescent", "children_reaped", "streams_closed"))
                        and "worker did not reach queue readiness" in stage):
                        with locked_state() as state:
                            absent = find_machine(state, worker) is None
                        if absent:
                            failed_worker = worker
                            break
            if failed_worker:
                break
            time.sleep(0.1)
        if failed_worker:
            Path(FAKE_DIR, "worker-never-ready").unlink()
            while time.time() < deadline:
                output = current_task_output()
                try:
                    ready = (output / "worker-ready.ids").read_text().splitlines() if output else []
                except OSError:
                    ready = []
                if ready and failed_worker not in ready:
                    Path(MARKERS, "worker-readiness-retry-proven").write_text(json.dumps({"run_token": token, "failed_worker": failed_worker, "ready_workers": ready}))
                    break
                time.sleep(0.1)
        if not Path(MARKERS, "worker-readiness-retry-proven").is_file():
            observed = time.time()
            log("FATAL: readiness failure never crossed captured cleanup and healthy retry " + json.dumps({
                "phase": "healthy-retry" if failed_worker else "captured-retirement",
                "failed_worker": failed_worker, "ready_workers": ready,
                "elapsed_seconds": observed - (deadline - 30),
                "deadline_remaining_seconds": deadline - observed,
            }, sort_keys=True))
            exit_code = 1
    # Keep the lower-target regression alive after the in-flight worker reaches
    # its own terminal cleanup boundary. Staging remains committed while it is
    # pending; its provisioner, rather than scale-down, owns any staging-failure
    # cleanup and must not inherit the parent autoscaler's EXIT trap.
    if exit_code == 0 and (
        (os.path.exists(os.path.join(FAKE_DIR, "oscillate-worker-desired"))
         and not os.path.exists(os.path.join(FAKE_DIR, "fail-worker-launch")))
        or os.path.exists(os.path.join(FAKE_DIR, "concurrent-ready-scale-down"))
    ):
        # These fixtures wait for real fake-provider launch and teardown work.
        # The oscillation case retries a failed stage twice; concurrent-ready
        # launches two workers before scaling one down. Both can finish after
        # 30 seconds on a loaded host despite correct fleet behavior.
        deadline = time.time() + (
            90 if os.path.exists(os.path.join(FAKE_DIR, "oscillate-worker-desired")) else 120
        )
        scaled_down = os.path.join(MARKERS, "worker-scale-down-complete")
        while not os.path.exists(scaled_down):
            if time.time() >= deadline:
                log("FATAL: autoscaled worker never crossed scale-down boundary")
                exit_code = 1
                break
            time.sleep(0.1)
        if exit_code == 0:
            # The autoscaler polls metrics every ten seconds. A fixed eight
            # second grace period can end the child before the lower target is
            # durably observed, especially after a slow staging cleanup.
            controller_ws = os.environ["CLOUDBENCH_FAKE_CONTROLLER_WS"]
            oscillating = os.path.exists(os.path.join(FAKE_DIR, "oscillate-worker-desired"))
            expected_workers = "0" if oscillating else "1"
            # Resolve this driver's current token; an older zero-worker target
            # from the preceding fault variant cannot satisfy this barrier.
            deadline = time.time() + 30
            observed = False
            while time.time() < deadline:
                output = current_task_output()
                try:
                    observed = output is not None and (output / "desired-worker-count").read_text().strip() == expected_workers
                except OSError:
                    observed = False
                if observed:
                    break
                time.sleep(0.1)
            if not observed:
                log("FATAL: autoscaler never persisted its lower worker target")
                exit_code = 1
    if exit_code == 0 and os.path.exists(os.path.join(FAKE_DIR, "fail-worker-destroy-once")):
        deadline = time.time() + 30
        controller_ws = os.environ["CLOUDBENCH_FAKE_CONTROLLER_WS"]
        fatal_pattern = os.path.join(
            controller_ws,
            ".context",
            "fleet",
            "runs",
            "*",
            "autoscaler-worker-destroy-failure",
            "autoscaler.failed",
        )
        while not glob.glob(fatal_pattern):
            if time.time() >= deadline:
                log("FATAL: worker scale-down never published its fail-closed result")
                exit_code = 1
                break
            time.sleep(0.1)
    # Prove that capacity counts alone cannot substitute for the autoscaler's
    # causal terminal marker. Finish only after the fake-only hold proves the
    # autoscaler has observed ready capacity but cannot yet observe child
    # completion. This is an owned barrier, not a scheduler-window assumption.
    if exit_code == 0 and os.path.exists(
        os.path.join(FAKE_DIR, "worker-ready-before-child-no-terminal")
    ):
        controller_ws = os.environ["CLOUDBENCH_FAKE_CONTROLLER_WS"]
        # Worker cloning and staging precede this readiness marker. Allow the
        # fixture to observe that work within the controller's 240s bound.
        deadline = time.time() + 120
        held = False
        while time.time() < deadline:
            hold_files = glob.glob(
                os.path.join(
                    controller_ws,
                    ".context",
                    "fleet",
                    "runs",
                    "*",
                    bench,
                    "autoscaler.test-held-after-ready",
                )
            )
            held = any(os.path.exists(path) for path in hold_files)
            if held:
                break
            time.sleep(0.1)
        if not held:
            log("FATAL: autoscaler never reached the ready-capacity hold boundary")
            exit_code = 1
    # A failed admitted benchmark still owns a terminal result and raw logs.
    # Pre-admission cancellation and invalid provenance remain unsealed.
    if benchmark_started:
        context = os.path.join(mdir, "data", "repo", ".context", "cloudbench")
        os.makedirs(context, exist_ok=True)
        agent_id = "fake-agent-" + os.path.basename(mdir)
        task = {
            "name": bench, "passed": exit_code == 0, "agent_id": agent_id,
            "duration_seconds": 1.0, "cost_cents": 0,
            "world_model_mode": "real", "code_ref": ref,
        }
        if exit_code != 0:
            task.update(benchmark_status="ERROR", error="fake driver failed after benchmark admission")
        card = {
            "run_id": "fake", "elapsed_s": 1.0, "world_model_mode": "real",
            "cost": {"agents_llm_usd": 0, "wmh_grounding_usd": 0,
                     "infra_usd": 0, "total_usd": 0},
            "metadata": {"tokens_in": 0, "tokens_out": 0},
            "per_task": [{"name": bench, "status": "passed" if exit_code == 0 else "failed",
                          "duration_s": 1.0, "cost_usd": 0,
                          "tokens_in": 0, "tokens_out": 0,
                          "world_model_mode": "real", "agent_url": None}],
        }
        run = {
            "summary": {"total": 1, "passed": int(exit_code == 0), "failed": int(exit_code != 0), "skipped": 0,
                        "pass_rate": float(exit_code == 0), "total_duration_seconds": 1.0,
                        "total_cost_cents": 0},
            "tasks": [task],
            "code_ref": ref,
            "workspace_marker": workspace_marker,
        }
        raw_run = os.path.join(mdir, "tmp", "fake-cloudbench-run.json")
        stamped_run = os.path.join(context, "run.json")
        provenance_script = os.path.join(mdir, "cloudbench-execution-provenance.py")
        provenance = os.path.join(mdir, "cloudbench-execution-provenance.json")
        with open(os.path.join(context, "report-card.json"), "w") as fh:
            json.dump(card, fh)
        with open(raw_run, "w") as fh:
            json.dump(run, fh)
        stamped = subprocess.run(
            [
                sys.executable,
                provenance_script,
                "stamp",
                "--run-json",
                raw_run,
                "--provenance",
                provenance,
                "--output",
                stamped_run,
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        os.remove(raw_run)
        if stamped.returncode != 0:
            detail = stamped.stderr.splitlines()[0] if stamped.stderr.splitlines() else ""
            log(
                "FATAL: fake driver could not stamp staged execution provenance"
                + (f": {detail}" if detail else "")
            )
            exit_code = 1
        else:
            with open(stamped_run) as fh:
                run = json.load(fh)
            log(f"::CLOUDBENCH-REPORT-CARD-BEGIN:: token={token}")
            log(json.dumps(card, separators=(",", ":")))
            log(f"::CLOUDBENCH-REPORT-CARD-END:: token={token}")
            log(f"::CLOUDBENCH-RESULT-BEGIN:: token={token}")
            log(json.dumps(run, separators=(",", ":")))
            log(f"::CLOUDBENCH-RESULT-END:: token={token}")
            log("benchmark complete")
            result_stamped = True
    if result_stamped:
        # Model the same stopped-stack filesystem that the real status server
        # seals. Keep two worker files so the fixture proves complete inventory
        # collection, not just a primary-worker shortcut.
        logs = os.path.join(context, "logs")
        os.makedirs(logs, exist_ok=True)
        for name in ("backend.log", "worker.log", "worker.1.log"):
            Path(logs, name).write_text(f"fake runtime {name} token={token} machine={os.path.basename(mdir)}\n")
        Path(context, "services.json").write_text(json.dumps({"status": "stopped", "env": {"worker_processes": 2}}))
        Path(context, "stack.log").write_text(f"fake stack stopped token={token}\n")
        Path(context, f"cloudbench-stack-cleanup-{token}.status").write_text(f"state=clean\ntoken={token}\n")
        Path(mdir, "data", f"cloudbench-driver-clean-{token}.ack").write_text(token + "\n")
    log(f"::CLOUDBENCH-DONE:: token={token} exit={exit_code}")
    Path(mdir, "data", "cloudbench-driver.state").write_text("exited\n")
    # The production boot supervisor publishes terminal log bytes before it
    # seals driver state as exited. Mirror that ordering so /driver-health
    # becomes 410 only after the complete DONE record is durable.
    try:
        os.remove(os.path.join(mdir, "driver.started"))
    except FileNotFoundError:
        pass


def release_worker_after_child(mdir, worker_id):
    """Make a launched worker healthy only after its controller child is done."""
    controller_ws = os.environ["CLOUDBENCH_FAKE_CONTROLLER_WS"]
    deadline = time.time() + 30
    while time.time() < deadline:
        ledgers = glob.glob(
            os.path.join(
                controller_ws,
                ".context",
                "fleet",
                "runs",
                "*",
                "*",
                "worker-clones.ids",
            )
        )
        for ledger in ledgers:
            try:
                tracked = open(ledger).read().splitlines()
            except OSError:
                continue
            if worker_id not in tracked:
                continue
            child_finished = os.path.join(os.path.dirname(ledger), "benchmark-child.finished")
            if os.path.exists(child_finished):
                time.sleep(2)
                open(os.path.join(mdir, "worker.ready"), "w").close()
                open(os.path.join(MARKERS, "worker-ready-released-after-child"), "w").close()
                return
        time.sleep(0.1)


def machines_listing():
    with locked_state() as state:
        machines = json.loads(json.dumps(state["machines"]))
    if os.path.exists(os.path.join(FAKE_DIR, "stale-started-inventory")):
        for machine in machines:
            if machine.get("name") != "cloudbench-warm" and machine.get("state") == "stopped":
                machine["state"] = "started"
    return machines


def native_stop(machine_id):
    """One provider stop request, shared by flyctl and the Machines API: error or None."""
    throttled = os.path.join(MARKERS, f"stop-throttled-{machine_id}")
    if (
        os.path.exists(os.path.join(FAKE_DIR, "throttle-first-machine-stop"))
        and not os.path.exists(throttled)
    ):
        open(throttled, "w").close()
        return 429, (
            f"Error: failed to stop machine {machine_id}: request returned non-2xx "
            "status, 429: rate limit exceeded (Request ID: fixture)"
        )
    with locked_state() as state:
        found = find_machine(state, machine_id)
        if found and not found.get("ignore_stop"):
            found["state"] = "stopped"
    return None


def native_destroy(target):
    """One provider force-destroy request, shared by flyctl and the Machines API."""
    worker_marker = os.path.join(MARKERS, f"worker-clone-id-{target}")
    destroy_failed = os.path.join(MARKERS, "worker-destroy-failed")
    if os.path.exists(worker_marker) and os.path.exists(os.path.join(FAKE_DIR, "fail-worker-destroy-always")):
        open(destroy_failed, "w").close()
        return 429, "injected persistent worker destroy refusal"
    if (
        os.path.exists(worker_marker)
        and os.path.exists(os.path.join(FAKE_DIR, "fail-worker-destroy-once"))
    ):
        count_path = os.path.join(MARKERS, "worker-destroy-failure-count")
        try:
            destroy_failure_count = int(open(count_path).read().strip()) + 1
        except (OSError, ValueError):
            destroy_failure_count = 1
        with open(count_path, "w") as fh:
            fh.write(str(destroy_failure_count))
        open(destroy_failed, "w").close()
        # Exhaust reap_machine's five-attempt scale-down budget. Controller
        # cleanup owns the same durable ID and its next (sixth) request succeeds.
        # A transient refusal is definitive (rate limit), so the fenced effect
        # may retry it; an ambiguous outcome is never replayed.
        if destroy_failure_count <= 5:
            return 429, "injected worker scale-down destroy failure"
    with locked_state() as state:
        state["machines"] = [m for m in state["machines"] if m["id"] != target]
    if os.path.exists(worker_marker):
        open(os.path.join(MARKERS, "worker-scale-down-complete"), "w").close()
    return None


def machine_api_row(machine):
    """Native Machines API row; each config generation is a new instance."""
    row = json.loads(json.dumps(machine))
    if not row.get("instance_id"):
        digest = hashlib.sha256(
            json.dumps([row["id"], row.get("config") or {}], sort_keys=True).encode()
        ).hexdigest()
        row["instance_id"] = "01" + digest[:24].upper()
    return row


def serve_machines_api(port_file):
    """Loopback Machines API over the same journaled state as fake flyctl.

    Controllers select it through the supported FLY_API_HOSTNAME and
    FLY_FLAPS_BASE_URL overrides, so no fixture request reaches Fly.
    """
    import http.server
    import threading

    expected = "Bearer " + os.environ["CLOUDBENCH_FAKE_MACHINES_API_TOKEN"]
    api_log = os.path.join(FAKE_DIR, "machines-api.log")
    leases = {}
    lease_lock = threading.Lock()

    class MachinesApi(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def reply(self, status, value):
            raw = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            with open(api_log, "a") as fh:
                fh.write(f"{self.command} {self.path} {status}\n")

        def route(self):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            if self.headers.get("Authorization") != expected:
                return self.reply(401, {"error": "fixture credential required"})
            parts = urlsplit(self.path)
            query = parse_qs(parts.query)
            segments = parts.path.strip("/").split("/")
            if (segments[:2] == ["v1", "apps"] and len(segments) == 4 and segments[3] == "volumes"
                    and segments[2] == BENCH_APP and self.command in ("GET", "POST")):
                # The clone's exact owned Volume is created before its Machine.
                with locked_state() as state:
                    if self.command == "GET":
                        return self.reply(200, json.loads(json.dumps(state["volumes"])))
                    request = json.loads(raw)
                    volume = {"id": "vol_" + uuid.uuid4().hex[:8], "name": request["name"],
                              "region": request["region"], "state": "created",
                              "size_gb": request["size_gb"], "auto_backup_enabled": True,
                              "snapshot_retention": 5, "attached_machine_id": None}
                    state["volumes"].append(volume)
                with open(os.path.join(FAKE_DIR, "volume-creates.log"), "a") as fh:
                    fh.write(json.dumps(request, sort_keys=True) + "\n")
                return self.reply(200, volume)
            if segments[:2] != ["v1", "apps"] or len(segments) < 4 or segments[3] != "machines":
                return self.reply(501, {"error": "route not modeled by fixture"})
            app, rest = segments[2], segments[4:]
            if app == PROD_APP:
                with open(JOURNAL, "a") as journal:
                    journal.write(f"FATAL machines API {self.command} {parts.path}\n")
                return self.reply(403, {"error": "fake Machines API was pointed at the PRODUCTION app"})
            if app != BENCH_APP:
                return self.reply(404, {"error": "app not found"})
            if not rest:
                if self.command == "GET":
                    return self.reply(200, [machine_api_row(m) for m in machines_listing()])
                return self.reply(501, {"error": "route not modeled by fixture"})
            machine_id, action = rest[0], rest[1:]
            nonce = self.headers.get("fly-machine-lease-nonce")
            if action == ["lease"] and self.command == "DELETE":
                # The exact holder may release its lease after destroying the
                # Machine under it (the existing reuse fakes model the same).
                with lease_lock:
                    held = leases.get(machine_id)
                    if held is None or held["nonce"] != nonce:
                        return self.reply(409, {"error": "lease nonce mismatch"})
                    leases.pop(machine_id)
                return self.reply(200, {"status": "success"})
            found = next((m for m in machines_listing() if m["id"] == machine_id), None)
            if found is None:
                return self.reply(404, {"error": "machine not found"})
            if action == ["lease"] and self.command == "POST":
                with lease_lock:
                    held = leases.get(machine_id)
                    if held is not None and held["expires"] > time.time():
                        return self.reply(409, {"error": "machine has an active lease"})
                    ttl = int((json.loads(raw) if raw else {}).get("ttl") or 30)
                    held = {"nonce": uuid.uuid4().hex, "expires": time.time() + ttl}
                    leases[machine_id] = held
                return self.reply(200, {"status": "success", "data": {
                    "nonce": held["nonce"], "expires_at": int(held["expires"])}})
            if self.command == "GET" and not action:
                return self.reply(200, machine_api_row(found))
            mutation = (
                (self.command == "POST" and action == ["stop"])
                or (self.command == "DELETE" and not action)
            )
            if not mutation:
                return self.reply(501, {"error": "route not modeled by fixture"})
            with lease_lock:
                held = leases.get(machine_id)
                if held is not None and held["expires"] > time.time() and held["nonce"] != nonce:
                    return self.reply(409, {"error": "machine is leased by another owner"})
            if self.command == "POST":
                command, effect = f"machine stop {machine_id} -a {app}", native_stop
            else:
                if query.get("force") != ["true"] and found.get("state") not in ("stopped", "created"):
                    return self.reply(412, {"error": "machine is active; force required"})
                command, effect = f"machine destroy --force {machine_id} -a {app}", native_destroy
            # The provider-effect journal keeps flyctl's vocabulary, so every
            # existing native-effect assertion sees both transports.
            with open(JOURNAL, "a") as journal:
                journal.write(command + "\n")
            error = effect(machine_id)
            if error is not None:
                return self.reply(error[0], {"error": error[1]})
            return self.reply(200, {"ok": True})

        do_GET = route
        do_POST = route
        do_DELETE = route

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MachinesApi)
    owner = int(os.environ["CLOUDBENCH_FAKE_MACHINES_API_OWNER"])

    def retire_with_owner():
        # Scenarios reset PIDS; never outlive the suite shell that started us.
        while os.getppid() == owner:
            time.sleep(0.5)
        server.shutdown()

    threading.Thread(target=retire_with_owner, daemon=True).start()
    with open(port_file + ".tmp", "w") as fh:
        fh.write(str(server.server_port))
    os.replace(port_file + ".tmp", port_file)
    server.serve_forever()


if args[:1] == ["__machines_api__"]:
    serve_machines_api(args[1])
    sys.exit(0)
if args[:1] == ["__fake_driver__"]:
    run_fake_driver(args[1])
    sys.exit(0)
if args[:1] == ["__release_worker_after_child__"]:
    release_worker_after_child(args[1], args[2])
    sys.exit(0)

with open(JOURNAL, "a") as journal:
    journal.write(" ".join(args) + "\n")

if "-a" in args and args[args.index("-a") + 1] == PROD_APP:
    print("FATAL: fake flyctl was pointed at the PRODUCTION app", file=sys.stderr)
    sys.exit(2)

if args[:2] == ["secrets", "list"]:
    with locked_state() as state:
        print(json.dumps([{"Name": name} for name in state["secrets"]]))
elif args[:2] == ["secrets", "set"]:
    with locked_state() as state:
        for pair in args[2:]:
            if "=" in pair:
                key = pair.split("=", 1)[0]
                if key not in state["secrets"]:
                    state["secrets"].append(key)
elif args[:2] == ["apps", "list"]:
    print(json.dumps([{"Name": BENCH_APP}]))
elif args[:2] == ["machines", "list"]:
    print(json.dumps(machines_listing()))
elif args[:2] == ["volumes", "list"]:
    # Fault injection for the pre-allocation durability boundary: registry init
    # has completed, but persisting the target name must now fail.
    ownership_root = os.environ.get("CLOUDBENCH_FAKE_BREAK_REGISTRY_ROOT")
    if ownership_root:
        marker = os.path.join(FAKE_DIR, "broke-registry-name-write")
        if not os.path.exists(marker) and os.path.isdir(ownership_root):
            for entry in os.listdir(ownership_root):
                if entry.startswith("."):
                    continue
                clones = os.path.join(ownership_root, entry, "clones")
                if os.path.isdir(clones):
                    shutil.rmtree(clones)
                    with open(clones, "w") as fh:
                        fh.write("injected write failure\n")
                    with open(marker, "w") as fh:
                        fh.write(entry)
                    break
    with locked_state() as state:
        print(json.dumps(state["volumes"]))
elif args[:2] == ["volumes", "show"]:
    volume_id = args[2]
    with locked_state() as state:
        found = find_volume(state, volume_id)
        if found is None:
            print(
                "Error: failed retrieving volume: failed to get volume "
                f"{volume_id}: volume not found (Request ID: fixture)",
                file=sys.stderr,
            )
            sys.exit(1)
        print(json.dumps(found))
        if found.get("state") in {"pending_destroy", "destroyed"}:
            state["volumes"] = [
                volume for volume in state["volumes"]
                if volume.get("id") != volume_id
            ]
elif args[:2] == ["volumes", "update"]:
    assert "--scheduled-snapshots=false" in args, args
    with locked_state() as state:
        found = find_volume(state, args[2])
        assert found is not None and args[2] != "vol_aaaa0001", args
        found["auto_backup_enabled"] = False
        print(json.dumps(found))
elif args[:2] == ["volumes", "destroy"]:
    volume_id = args[2]
    with locked_state() as state:
        found = find_volume(state, volume_id)
        if found is None:
            print(f"volume {volume_id} not found", file=sys.stderr)
            sys.exit(1)
        found["state"] = "pending_destroy"
elif args[:3] == ["volume", "snapshots", "list"]:
    with locked_state() as state:
        print(json.dumps(state["snapshots"]))
elif args[:2] == ["machine", "clone"]:
    name = flag_value("--name")
    source_id = args[2]
    # Fault injection (RCA #6): make the FIRST clone attempt fail AMBIGUOUSLY —
    # non-zero exit, NO Machine allocated, and an error that is NOT a recognized
    # "definitively unallocated" string — so the controller's provision loop must
    # reconcile the already-reserved name AUTHORITATIVELY (resolve -> absent ->
    # release) rather than leaving a name-only orphan that later aborts teardown
    # and leaks its id'd siblings. Later attempts proceed normally.
    if os.environ.get("CLOUDBENCH_FAKE_CLONE_FAIL_ONCE") == "1":
        fail_once_marker = os.path.join(FAKE_DIR, "clone-failed-once")
        if not os.path.exists(fail_once_marker):
            with open(fail_once_marker, "w") as fh:
                fh.write(name or "")
            print("Error: an unexpected error occurred (request timed out)",
                  file=sys.stderr)
            sys.exit(1)
    if (
        source_id != "aaaa0000000001"
        and os.path.exists(os.path.join(FAKE_DIR, "block-worker-clone"))
    ):
        open(os.path.join(FAKE_DIR, "worker-clone-blocked"), "w").close()
        deadline = time.time() + 30
        while not os.path.exists(os.path.join(FAKE_DIR, "release-worker-clone")):
            if time.time() >= deadline:
                print("injected worker clone remained blocked", file=sys.stderr)
                sys.exit(1)
            time.sleep(0.1)
    machine_id = uuid.uuid4().hex[:14]
    vm_size = flag_value("--vm-size") or "shared-cpu-4x"
    vm_memory = int(flag_value("--vm-memory") or "8192")
    cpu_match = re.search(r"(\d+)x$", vm_size)
    vm_cpus = int(cpu_match.group(1)) if cpu_match else 1
    cpu_kind = "performance" if vm_size.startswith("performance-") else "shared"
    override_cmd = flag_value("--override-cmd")
    attach_volume = flag_value("--attach-volume")
    with locked_state() as state:
        volume_id = attach_volume or "vol_" + uuid.uuid4().hex[:8]
        if attach_volume is not None:
            attached = [v for v in state["volumes"] if v["id"] == attach_volume]
            if len(attached) != 1 or attached[0].get("attached_machine_id"):
                print(f"Error: could not get existing volume: {attach_volume}", file=sys.stderr)
                sys.exit(1)
        clone_config = {"mounts": [{"volume": volume_id, "size_gb": 40}],
                        "guest": {"cpu_kind": cpu_kind, "cpus": vm_cpus,
                                  "memory_mb": vm_memory}}
        # Fly stores --override-cmd as init.cmd; worker staging gates on that
        # native row, so the fake must not drop it.
        if override_cmd is not None:
            clone_config["init"] = {"cmd": shlex.split(override_cmd)}
        state["machines"].append({
            "id": machine_id, "name": name, "state": "stopped",
            "region": flag_value("--region") or "iad",
            # Preserve the full machine identity in a fixture-owned IPv6
            # namespace; a four-digit UUID prefix can alias another guest.
            "private_ip": str(ipaddress.IPv6Address(
                (0xFDAA << 112) | (0xC10D << 64) | int(machine_id, 16)
            )),
            "config": clone_config,
        })
        if attach_volume is not None:
            attached[0]["attached_machine_id"] = machine_id
        else:
            state["volumes"].append(
                {"id": volume_id, "name": "cloudbench_data_fork", "state": "created", "size_gb": 40, "auto_backup_enabled": True, "snapshot_retention": 5, "attached_machine_id": machine_id})
        provider_machine = state["machines"][-1]
    # Retain the actual indexed row for assertions after normal teardown removes it.
    with open(os.path.join(machine_dir(machine_id), "provider-machine.json"), "w") as fh:
        json.dump(provider_machine, fh)
    if source_id != "aaaa0000000001":
        with open(os.path.join(MARKERS, "worker-clone-id"), "w") as fh:
            fh.write(machine_id)
        open(os.path.join(MARKERS, f"worker-clone-id-{machine_id}"), "w").close()
    with open(os.path.join(MARKERS, name), "w") as fh:
        fh.write(machine_id)
    # Barrier: only release once BOTH workstreams have a clone in flight. A
    # serialized (locked) second controller never reaches here → timeout → fail.
    barrier_min = int(os.environ.get("CLOUDBENCH_TEST_BARRIER_MIN", "2"))
    deadline = time.time() + float(os.environ.get("CLOUDBENCH_TEST_BARRIER_TIMEOUT", "45"))
    while len(os.listdir(MARKERS)) < barrier_min:
        if time.time() > deadline:
            print("FATAL: clone barrier timed out — controllers did not overlap",
                  file=sys.stderr)
            sys.exit(1)
        time.sleep(0.2)
    # Break the transfer destination only after Fly has allocated the clone.
    # The controller must retain fleet ownership and reap instead of handing
    # an unrecorded machine to the stopped pool.
    pool_ledger = os.environ.get("CLOUDBENCH_FAKE_BREAK_POOL_LEDGER")
    if pool_ledger:
        if os.path.isdir(pool_ledger):
            shutil.rmtree(pool_ledger)
        elif os.path.lexists(pool_ledger):
            os.unlink(pool_ledger)
        os.mkdir(pool_ledger)
    print(f"cloned machine {machine_id}")
elif args[:2] == ["machine", "status"]:
    with locked_state() as state:
        found = find_machine(state, args[2])
    if found is None:
        print(f"failed to get VM {args[2]}: machine not found", file=sys.stderr)
        sys.exit(1)
    if "-d" in args:
        print(json.dumps(found.get("config") or {}))
    else:
        mounts = (found.get("config") or {}).get("mounts") or []
        volume = mounts[0].get("volume", "") if mounts else ""
        print(
            f"""Machine ID: {found['id']}
State: {found['state']}

VM
 ID            │ {found['id']}
 State         │ {found['state']}
 Name          │ {found['name']}
 Private IP    │ {found.get('private_ip', '')}
 Region        │ {found.get('region', '')}
 Volume        │ {volume}"""
        )
elif args[:2] == ["machine", "update"]:
    machine_id = args[2]
    if os.path.exists(os.path.join(FAKE_DIR, "delay-machine-update")):
        time.sleep(4)
    boot_env = {}
    for index, value in enumerate(args):
        if value == "--env" and index + 1 < len(args) and "=" in args[index + 1]:
            key, env_value = args[index + 1].split("=", 1)
            boot_env[key] = env_value
    with locked_state() as state:
        found = find_machine(state, machine_id)
        if found is None:
            sys.exit(1)
        found["boot_env"] = boot_env
        found.setdefault("config", {})["env"] = boot_env
        if flag_value("--command") is not None:
            found["config"].setdefault("init", {})["cmd"] = shlex.split(flag_value("--command"))
        found["state"] = "stopped"
        if flag_value("--vm-size"):
            vm_size = flag_value("--vm-size")
            cpu_match = re.search(r"(\d+)x$", vm_size)
            found.setdefault("config", {}).setdefault("guest", {})["cpus"] = (
                int(cpu_match.group(1)) if cpu_match else 1
            )
            found["config"]["guest"]["cpu_kind"] = (
                "performance" if vm_size.startswith("performance-") else "shared"
            )
        if flag_value("--vm-memory"):
            found.setdefault("config", {}).setdefault("guest", {})["memory_mb"] = int(
                flag_value("--vm-memory")
            )
    mdir = machine_dir(machine_id)
    for index, value in enumerate(args):
        if value != "--file-local" or index + 1 >= len(args):
            continue
        guest_path, local_path = args[index + 1].split("=", 1)
        guest = PurePosixPath(guest_path)
        if not guest.is_absolute() or guest.parent != PurePosixPath("/") or not guest.name:
            print(f"FATAL: unsafe fake guest file path: {guest_path}", file=sys.stderr)
            sys.exit(2)
        # The real machine update stages this complete controller-owned bundle
        # at the guest root. Mirror every safe root-level file, not a hand-picked
        # subset that silently drifts when the production bundle gains a member.
        shutil.copyfile(local_path, os.path.join(mdir, guest.name))
    rb_path = os.path.join(mdir, "tmp", "rb.sh")
    os.makedirs(os.path.dirname(rb_path), exist_ok=True)
    with open(rb_path, "w") as fh:
        for key, value in boot_env.items():
            fh.write(f"export {key}={shlex.quote(value)}\n")
elif args[:2] == ["machine", "start"]:
    machine_id = args[2]
    failed_start_marker = os.path.join(FAKE_DIR, f"failed-first-start-{machine_id}")
    if (
        os.path.exists(os.path.join(FAKE_DIR, "fail-first-primary-start"))
        and not os.path.exists(failed_start_marker)
    ):
        open(failed_start_marker, "w").close()
        print("injected first primary start failure", file=sys.stderr)
        sys.exit(1)
    with locked_state() as state:
        found = find_machine(state, machine_id)
        if found:
            found["state"] = "started"
            boot_env = found.get("boot_env") or {}
        else:
            boot_env = {}
    mdir = machine_dir(machine_id)
    if (
        boot_env.get("CLOUDBENCH_RUN_TOKEN")
        and not os.path.exists(os.path.join(mdir, "driver.started"))
    ):
        # Emulate the immutable boot entrypoint's exact log-generation boundary:
        # RUNSTAMP is durable before the status proxy can expose driver bytes.
        with open(os.path.join(mdir, "data", "bench.log"), "w") as log_file:
            log_file.write(f"RUNSTAMP-{boot_env['CLOUDBENCH_RUN_TOKEN']}\n")
        # Publish liveness before spawning so an intentionally tiny driver
        # cannot exit and clear the marker before the launcher writes it.
        open(os.path.join(mdir, "driver.started"), "w").close()
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "__fake_driver__", mdir],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
elif args[:2] == ["machine", "stop"]:
    error = native_stop(args[2])
    if error is not None:
        print(error[1], file=sys.stderr)
        sys.exit(1)
elif args[:2] == ["machine", "destroy"]:
    error = native_destroy(args[3] if args[2] == "--force" else args[2])
    if error is not None:
        print(error[1], file=sys.stderr)
        sys.exit(1)
elif args[:3] == ["ssh", "sftp", "put"]:
    mdir = machine_dir(flag_value("--machine"))
    # positional tail after dropping flag values: [-a APP, --machine ID, -m MODE]
    positional = []
    skip = False
    for i, a in enumerate(args[3:]):
        if skip:
            skip = False
            continue
        if a in ("-a", "--machine", "-m"):
            skip = True
            continue
        if a.startswith("-"):
            continue
        positional.append(a)
    local, remote = positional[0], positional[1]
    dest = rewrite_paths(mdir, remote)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(local, "rb") as src, open(dest, "wb") as dst:
        dst.write(src.read())
    if flag_value("-m") == "0755":
        os.chmod(dest, 0o755)
elif args[:3] == ["ssh", "sftp", "get"]:
    machine_id = flag_value("--machine")
    mdir = machine_dir(machine_id)
    with locked_state() as state:
        found = find_machine(state, machine_id)
    if found is None or found["state"] != "started":
        print("machine not reachable", file=sys.stderr)
        sys.exit(1)
    positional = []
    skip = False
    for item in args[3:]:
        if skip:
            skip = False
            continue
        if item in ("-a", "--app", "--machine"):
            skip = True
            continue
        if not item.startswith("-"):
            positional.append(item)
    assert len(positional) == 2
    remote, local = positional
    assert remote == "/data/cloudbench-worker-evidence-" + machine_id + ".tar"
    source = Path(rewrite_paths(mdir, remote))
    assert source.is_file() and not source.is_symlink()
    with source.open("rb") as src, open(local, "wb") as dst:
        shutil.copyfileobj(src, dst)
    os.chmod(local, 0o600)
elif args[:2] == ["ssh", "console"]:
    machine_id = flag_value("--machine")
    command = flag_value("-C") or ""
    mdir = machine_dir(machine_id)
    # run-bench-cloud ssh_exec base64-wraps the remote payload so quoting
    # survives flyctl -C. Unwrap before /data rewrite and marker matching;
    # otherwise bash looks for the literal guest path on the host and
    # concurrent --refresh-deps fails with "No such file or directory".
    b64_match = re.search(
        r"printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| bash",
        command,
    )
    if b64_match:
        try:
            command = base64.b64decode(b64_match.group(1)).decode()
        except Exception:
            pass
    with locked_state() as state:
        found = find_machine(state, machine_id)
    if found is None or found["state"] != "started":
        print("machine not reachable", file=sys.stderr)
        sys.exit(1)
    if "CLOUDBENCH_OWNER_PROBE" in command:
        if found.get("probe_error"):
            print("ownership probe failed", file=sys.stderr)
            sys.exit(1)
        print(f"CLOUDBENCH_RUNNER_COUNT={found.get('runner_count', 0)}")
    elif "setsid bash /tmp/rbw.sh" in command:
        if os.path.exists(os.path.join(FAKE_DIR, "fail-worker-launch")):
            with open(os.path.join(MARKERS, f"worker-launch-rejected-{machine_id}"), "w") as marker:
                marker.write("1\n")
            print("injected autoscaled-worker launch failure", file=sys.stderr)
            open(os.path.join(MARKERS, f"worker-launch-rejected-{machine_id}"), "w").close()
            sys.exit(1)
        worker_exit = run_fake_worker(mdir, machine_id)
        # Production SSH backgrounds the supervisor with `setsid ... &`.
        # Admission succeeds independently of the child's later exit status;
        # that status remains in the real terminal receipt and captured log.
        if worker_exit == 0 and os.path.exists(os.path.join(FAKE_DIR, "worker-ready-after-child")):
            subprocess.Popen(
                [
                    sys.executable,
                    os.path.abspath(__file__),
                    "__release_worker_after_child__",
                    mdir,
                    machine_id,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        elif worker_exit == 0 and not os.path.exists(os.path.join(FAKE_DIR, "worker-never-ready")):
            open(os.path.join(mdir, "worker.ready"), "w").close()
        open(os.path.join(MARKERS, f"worker-launch-succeeded-{machine_id}"), "w").close()
    elif command.startswith("python3 /data/cloudbench-worker-evidence.py capture "):
        # Exercise the actual staged capture CLI. Its only path adaptation is
        # the fake machine filesystem root; run/machine args remain unchanged.
        argv = shlex.split(rewrite_paths(mdir, command))
        argv[0] = sys.executable
        argv += ["--data-dir", os.path.join(mdir, "data")]
        result = subprocess.run(argv, env=dict(os.environ, FLY_MACHINE_ID=machine_id),
            capture_output=True, text=True, timeout=285)
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        sys.exit(result.returncode)
    elif "http://127.0.0.1:3103/health" in command:
        if not os.path.exists(os.path.join(mdir, "worker.ready")):
            # The real probe's remote shell reports its own negative verdict.
            print("cloudbench-worker-health=unhealthy")
            sys.exit(1)
    elif "setsid bash" in command and "rb.sh" in command:
        # Detached driver launch: run the fake driver contract in the background.
        open(os.path.join(mdir, "driver.started"), "w").close()
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "__fake_driver__", mdir],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    elif "pgrep -f cloudbench-run.sh" in command:
        if os.path.exists(os.path.join(mdir, "driver.started")):
            print("RUNNING")
    elif command.strip().startswith('stale_pat=') or "stale_pat='" in command:
        pass  # stale-driver cleanup: nothing to kill inside the sandbox
    else:
        env = dict(os.environ)
        env["HOME"] = os.path.join(mdir, "home")
        env["GIT_CONFIG_GLOBAL"] = os.path.join(mdir, "home", ".gitconfig")
        result = subprocess.run(
            ["bash", "-c", rewrite_paths(mdir, command)],
            capture_output=True, text=True, env=env,
        )
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        sys.exit(result.returncode)
elif args[:2] == ["tokens", "create"]:
    print(json.dumps({"token": "fake-deploy-token"}))
elif args[:1] == ["proxy"]:
    import http.server
    local_port = int(args[1].split(":", 1)[0])
    remote_port = int(args[1].split(":", 1)[1])
    fail_metrics = os.path.exists(os.path.join(FAKE_DIR, "fail-metrics-proxy"))
    if fail_metrics and remote_port == 3003:
        print("injected metrics data-plane failure", file=sys.stderr)
        sys.exit(1)
    if remote_port == 8011 and os.path.exists(os.path.join(FAKE_DIR, "delay-status-proxy")):
        # A metrics-negative fixture must not spend its short target budget on
        # the independently healthy status channel before autoscaler admission.
        with locked_state() as state:
            status_not_before = state.setdefault("status_proxy_not_before", time.monotonic() + 6)
        time.sleep(max(0, status_not_before - time.monotonic()))
    remote_host = args[2]
    if os.path.exists(os.path.join(FAKE_DIR, "require-private-ip-proxy")) and ".vm." in remote_host:
        print(f"{remote_host}: host was not found in DNS", file=sys.stderr)
        sys.exit(1)
    with locked_state() as state:
        targets = [
            machine
            for machine in state["machines"]
            if machine.get("private_ip") == remote_host
            or machine.get("id") == remote_host.split(".vm.", 1)[0]
        ]
    if not targets:
        print(f"unknown proxy target: {remote_host}", file=sys.stderr)
        sys.exit(1)
    if len(targets) != 1:
        # A real 6PN address names exactly one Machine; never guess a guest.
        print(f"ambiguous proxy target: {remote_host}", file=sys.stderr)
        sys.exit(1)
    target = targets[0]
    if (
        os.path.exists(os.path.join(FAKE_DIR, "stale-started-inventory"))
        and target.get("state") != "started"
    ):
        print(f"proxy target is not started: {remote_host}", file=sys.stderr)
        sys.exit(1)
    machine_id = target["id"]
    mdir = machine_dir(machine_id)
    if (
        remote_port == 3003
        and os.path.exists(os.path.join(FAKE_DIR, "metrics-require-started"))
    ):
        with locked_state() as state:
            target = find_machine(state, machine_id)
        if target is None or target.get("state") != "started":
            print("metrics target is not started", file=sys.stderr)
            sys.exit(1)

    # Reuse the production endpoint/manifest/file-serving implementation. The
    # fake provider supplies guest state; it must not invent a second evidence
    # validator or create a local collector receipt after the transport.
    status_path = os.path.join(os.environ["CLOUDBENCH_FAKE_CONTROLLER_WS"], "scripts", "cloudbench-status-server.py")
    spec = importlib.util.spec_from_file_location("fixture_status_server", status_path)
    status_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(status_module)
    rb_path = os.path.join(mdir, "tmp", "rb.sh")
    rb_text = Path(rb_path).read_text() if os.path.exists(rb_path) else ""
    os.environ["FLY_MACHINE_ID"] = machine_id
    os.environ["CLOUDBENCH_BARRIER_TOKEN"] = rb_export(rb_text, "CLOUDBENCH_BARRIER_TOKEN")
    captured_handlers = []

    class CaptureServer:
        def __init__(self, address, handler):
            captured_handlers.append(handler)
        def serve_forever(self):
            pass

    status_module.ThreadingHTTPServer = CaptureServer
    status_module.parse_args = lambda: SimpleNamespace(
        directory=os.path.join(mdir, "data"), barrier="", bind="127.0.0.1",
        port=0, ready_file="", run_token=rb_export(rb_text, "CLOUDBENCH_RUN_TOKEN"),
    )
    status_module.main()

    class ProxyHandler(captured_handlers[0]):
        def do_GET(self):
            if urlsplit(self.path).path == "/runtime-evidence":
                return super().do_GET()
            if self.path == "/metrics":
                if os.path.exists(os.path.join(FAKE_DIR, "invalid-metrics")):
                    self.send_error(404)
                    return
                worker_clone_count = len(
                    [entry for entry in os.listdir(MARKERS) if entry.startswith("worker-clone-id-")]
                )
                if os.path.exists(os.path.join(FAKE_DIR, "concurrent-ready-scale-down")):
                    worker_launch_count = sum(entry.startswith("worker-launch-succeeded-") for entry in os.listdir(MARKERS))
                    desired = 2 if worker_launch_count >= 2 else 3
                elif os.path.exists(os.path.join(FAKE_DIR, "fail-worker-destroy-once")):
                    if not any(entry.startswith("worker-launch-succeeded-") for entry in os.listdir(MARKERS)):
                        desired = 2
                    elif os.path.exists(os.path.join(MARKERS, "worker-destroy-failed")):
                        desired = 2
                    else:
                        desired = 1
                elif os.path.exists(os.path.join(FAKE_DIR, "oscillate-worker-desired")):
                    boundary = (
                        "worker-launch-rejected-"
                        if os.path.exists(os.path.join(FAKE_DIR, "fail-worker-launch"))
                        else "worker-launch-succeeded-"
                    )
                    crossed = any(entry.startswith(boundary) for entry in os.listdir(MARKERS))
                    desired = 1 if crossed else 2
                else:
                    desired = 2 if os.path.exists(os.path.join(FAKE_DIR, "desired-two")) else 1
                body = f"desired_machine_count {desired}\n".encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path == "/driver-health":
                code = 204 if os.path.exists(os.path.join(mdir, "driver.started")) else 410
                self.send_response(code)
                self.end_headers()
                return
            if self.path == "/shutdown-health":
                code = 204 if os.path.exists(os.path.join(mdir, "guest-cleanup.ack")) and not os.path.exists(os.path.join(mdir, "driver.started")) else 202
                self.send_response(code)
                self.end_headers()
                return
            parsed = urlsplit(self.path)
            if parsed.path != "/bench.log":
                self.send_error(404)
                return
            path = os.path.join(mdir, "data", "bench.log")
            try:
                body = open(path, "rb").read()
            except OSError:
                self.send_error(404)
                return
            parameters = parse_qs(parsed.query)
            try:
                offset = int(parameters["offset"][0])
                limit = int(parameters["limit"][0])
            except (KeyError, IndexError, ValueError):
                self.send_error(400)
                return
            generation = "a" * 32
            anchor_start = max(0, offset - 4096)
            expected_anchor = hashlib.sha256(body[anchor_start:offset]).hexdigest()
            supplied_anchor = self.headers.get("X-Cloudbench-Log-Anchor", "")
            supplied_generation = self.headers.get("X-Cloudbench-Log-Generation", "")
            if (
                offset > len(body)
                or supplied_anchor != expected_anchor
                or supplied_generation not in ("", generation)
            ):
                self.send_response(409)
                self.send_header("X-Cloudbench-Log-Size", str(len(body)))
                self.send_header("X-Cloudbench-Log-Generation", generation)
                self.send_header("X-Cloudbench-Log-Continuity", "1")
                self.end_headers()
                return
            if offset == len(body):
                self.send_response(204)
                self.send_header("X-Cloudbench-Log-Size", str(len(body)))
                self.send_header("X-Cloudbench-Log-Generation", generation)
                self.send_header("X-Cloudbench-Log-Continuity", "1")
                self.end_headers()
                return
            chunk = body[offset : offset + min(limit, 262144)]
            self.send_response(206)
            self.send_header(
                "Content-Range",
                f"bytes {offset}-{offset + len(chunk) - 1}/{len(body)}",
            )
            self.send_header("Content-Length", str(len(chunk)))
            self.send_header("X-Cloudbench-Log-Generation", generation)
            self.send_header("X-Cloudbench-Log-Continuity", "1")
            self.end_headers()
            self.wfile.write(chunk)

        def do_POST(self):
            if self.path == "/shutdown":
                staged_bench = base64.b64decode(
                    rb_export(rb_text, "BENCH_TASKS_B64") or ""
                ).decode().split(",")[0].strip()
                if staged_bench == "bench-group-term-undeliverable":
                    # The guest rejects its authenticated stop. Its runner sees
                    # this 503 first, fails fast and retires the proxy, so the
                    # controller's own request then observes HTTP 000: neither
                    # party ever delivered the stop.
                    with open(os.path.join(mdir, "shutdown-rejected"), "a") as fh:
                        fh.write("503\n")
                    self.send_error(503, "guest shutdown endpoint unavailable")
                    return
                if staged_bench == "bench-group-term-slowdrain":
                    # Delivered: persist the request for the guest driver and
                    # answer 202. The driver drains on the guest itself, so
                    # retiring this local proxy cannot end or shorten it.
                    requested = os.path.join(mdir, "shutdown-requested")
                    if not os.path.exists(requested):
                        with open(requested + ".tmp", "w") as fh:
                            fh.write(str(time.time()))
                        os.replace(requested + ".tmp", requested)
                    self.send_response(202)
                    self.end_headers()
                    return
                # Model the guest's durable completion boundary. Fleet teardown
                # may not reap this fake Machine until this exact ack is visible.
                open(os.path.join(mdir, "guest-cleanup.ack"), "w").close()
                self.send_response(202)
                self.end_headers()
                return
            if self.path != "/release":
                self.send_error(404)
                return
            rb_path = os.path.join(mdir, "tmp", "rb.sh")
            barrier = rb_export(open(rb_path).read(), "CLOUDBENCH_START_BARRIER")
            open(os.path.join(mdir, "data", f"cloudbench-start-{barrier}.release"), "w").close()
            self.send_response(204)
            self.end_headers()

        def log_message(self, *unused):
            pass

    http.server.ThreadingHTTPServer(("127.0.0.1", local_port), ProxyHandler).serve_forever()
else:
    print(f"FATAL: fake flyctl has no handler for: {' '.join(args)}", file=sys.stderr)
    sys.exit(1)
PY

python3 - "$FAKE_DIR/flyctl.py" <<'PY_PATH_CONTRACT'
import ast
import re
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text()
module = ast.parse(source)
function = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "rewrite_paths")
namespace = {"re": re}
exec(compile(ast.Module(body=[function], type_ignores=[]), sys.argv[1], "exec"), namespace)
rewrite = namespace["rewrite_paths"]
for host_root in ("/var/tmp/fake-machine", "/data/controller-tmp/fake-machine", "/data/data/fake-machine"):
    for guest in ("/tmp/rb.sh", "/tmp/rbw.sh", "/tmp/rbw.env", "/tmp/cloudbench-local.patch", "/data/worker.log"):
        assert rewrite(host_root, guest) == host_root + guest, (host_root, guest)
    command = "bash /tmp/rbw.sh >/data/worker.log"
    assert rewrite(host_root, command) == "bash " + host_root + "/tmp/rbw.sh >" + host_root + "/data/worker.log"
    assert rewrite(host_root, "printf unchanged") == "printf unchanged"
PY_PATH_CONTRACT
[ "$?" -eq 0 ] || fail "fake guest paths must be translated exactly once"
echo "PASS: guest path translation preserves host paths containing /data"

python3 - "$FAKE_DIR/flyctl.py" "$ROOT_DIR" <<'PY_TERMINAL_CONTRACT'
import ast
import base64
import glob
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace

fake_source, root = Path(sys.argv[1]), Path(sys.argv[2]).resolve()
module = ast.parse(fake_source.read_text())
functions = [node for node in module.body if isinstance(node, ast.FunctionDef)
             and node.name in {"rb_export", "run_fake_driver"}]
assert len(functions) == 2
provenance = runpy.run_path(str(root / "scripts/cloudbench_execution_provenance.py"))
status = runpy.run_path(str(root / "scripts/cloudbench-status-server.py"))
previous_workspace = os.environ.get("CLOUDBENCH_FAKE_CONTROLLER_WS")
failures = []
try:
    with tempfile.TemporaryDirectory(prefix="fake-terminal-contract-") as temporary:
        temporary = Path(temporary).resolve()
        snapshot = temporary / "snapshot"
        snapshot.mkdir()
        (snapshot / "fixture").write_text("owned terminal fixture\n")
        expected = provenance["build_provenance"](
            base_sha="a" * 40, workspace_patch_sha256="none",
            snapshot_manifest=provenance["build_snapshot_manifest"](snapshot),
            config=provenance["build_config"](provenance["CONFIG_SCHEMA_VERSION"], ["app=fixture"]),
        )
        for mode in ("successful", "post-admission-error", "pre-admission-cancel", "invalid-provenance"):
            try:
                case = temporary / mode
                machine = case / "machine"
                data = machine / "data"
                tmp = machine / "tmp"
                tmp.mkdir(parents=True)
                data.mkdir()
                token = "terminal-fixture-" + mode
                barrier = "fixture-barrier"
                (tmp / "rb.sh").write_text(
                    f"export CLOUDBENCH_RUN_TOKEN={token}\n"
                    f"export CLOUDBENCH_START_BARRIER={barrier}\n"
                    f"export REF={'a' * 40}\n"
                    f"export BENCH_TASKS_B64={base64.b64encode(b'terminal-fixture').decode()}\n"
                )
                (machine / "driver.started").touch()
                if mode == "pre-admission-cancel":
                    (machine / "guest-cleanup.ack").touch()
                else:
                    (data / f"cloudbench-start-{barrier}.release").touch()
                if mode == "post-admission-error":
                    (case / "fail-worker-destroy-once").touch()
                shutil.copyfile(root / "scripts/cloudbench_execution_provenance.py",
                                machine / "cloudbench-execution-provenance.py")
                (machine / "cloudbench-execution-provenance.json").write_text(
                    "{}" if mode == "invalid-provenance" else json.dumps(expected)
                )
                os.environ["CLOUDBENCH_FAKE_CONTROLLER_WS"] = str(case / "controller")
                ticks = iter((0, 0, 31))
                # Enter the actual fixture's unchanged 30s error branch without
                # waiting. Only this fixture clock is replaced; its producer,
                # provenance stamper and evidence manifest are the real code.
                clock = SimpleNamespace(time=lambda: next(ticks), sleep=lambda _: None)
                namespace = dict(globals(), FAKE_DIR=str(case), MARKERS=str(case / "markers"), time=clock)
                exec(compile(ast.Module(body=functions, type_ignores=[]), str(fake_source), "exec"), namespace)
                namespace["run_fake_driver"](str(machine))
                log = (data / "bench.log").read_text()
                assert (data / "cloudbench-driver.state").read_text() == "exited\n"
                assert not (machine / "driver.started").exists()
                if mode in {"pre-admission-cancel", "invalid-provenance"}:
                    assert f"::CLOUDBENCH-DONE:: token={token} exit=1" in log
                    assert not (data / f"cloudbench-driver-clean-{token}.ack").exists()
                    try:
                        status["runtime_evidence_manifest"](data, token, machine.name)
                    except (FileNotFoundError, ValueError):
                        pass
                    else:
                        raise AssertionError("unadmitted or invalid-provenance work must remain unsealed")
                else:
                    context = data / "repo/.context/cloudbench"
                    run = json.loads((context / "run.json").read_text())
                    assert provenance["validate_run_provenance"](run, expected) == []
                    passed = mode == "successful"
                    assert run["tasks"][0]["passed"] is passed
                    assert run["summary"]["passed"] == int(passed)
                    assert run["summary"]["failed"] == int(not passed)
                    assert f"::CLOUDBENCH-DONE:: token={token} exit={int(not passed)}" in log
                    assert (data / f"cloudbench-driver-clean-{token}.ack").read_text() == token + "\n"
                    marker = f"::CLOUDBENCH-RESULT-BEGIN:: token={token}\n"
                    assert json.loads(log.split(marker, 1)[1].splitlines()[0]) == run
                    if not passed:
                        assert run["tasks"][0]["benchmark_status"] == "ERROR"
                        assert "FATAL: worker scale-down never published its fail-closed result" in log
                    manifest = status["runtime_evidence_manifest"](data, token, machine.name)
                    assert set(manifest["files"]) == {
                        "services.json", "run.json", "stack.log",
                        f"cloudbench-stack-cleanup-{token}.status",
                        "logs/backend.log", "logs/worker.log", "logs/worker.1.log",
                    }
                    for name, row in manifest["files"].items():
                        contents = (context / name).read_bytes()
                        assert row == {"bytes": len(contents), "sha256": hashlib.sha256(contents).hexdigest()}
                print("PASS: fake terminal contract", mode)
            except Exception as error:
                failures.append((mode, type(error).__name__))
                print("FAIL: fake terminal contract", mode, type(error).__name__)
finally:
    if previous_workspace is None:
        os.environ.pop("CLOUDBENCH_FAKE_CONTROLLER_WS", None)
    else:
        os.environ["CLOUDBENCH_FAKE_CONTROLLER_WS"] = previous_workspace
assert not failures, failures
PY_TERMINAL_CONTRACT
[ "$?" -eq 0 ] || fail "fake admitted outcomes must preserve terminal evidence independently of success"

cat > "$FAKE_BIN/flyctl" <<SH
#!/usr/bin/env bash
exec python3 "$FAKE_DIR/flyctl.py" "\$@"
SH
chmod +x "$FAKE_BIN/flyctl"

# Controllers also reach Fly through raw Machines API helpers (fenced
# stop/destroy, start accounting). Serve those from the same fake state on
# loopback through their supported endpoint overrides; unmodeled routes such as
# optional dependency-proof metadata are refused. A fixture must never send even
# its fake credential to the real provider.
FAKE_FLY_TOKEN="fake-offline-fleet-token"
rm -f "$FAKE_DIR/machines-api.port"
CLOUDBENCH_FAKE_DIR="$FAKE_DIR" CLOUDBENCH_FAKE_MACHINES_API_TOKEN="$FAKE_FLY_TOKEN" \
    CLOUDBENCH_FAKE_MACHINES_API_OWNER="$$" \
    python3 "$FAKE_DIR/flyctl.py" __machines_api__ "$FAKE_DIR/machines-api.port" \
    >"$FAKE_DIR/machines-api.stderr" 2>&1 &
FAKE_MACHINES_API_PID=$!
for _ in $(seq 1 100); do
    [ -s "$FAKE_DIR/machines-api.port" ] && break
    kill -0 "$FAKE_MACHINES_API_PID" 2>/dev/null || break
    sleep 0.1
done
FAKE_MACHINES_API_PORT="$(cat "$FAKE_DIR/machines-api.port" 2>/dev/null || true)"
case "$FAKE_MACHINES_API_PORT" in
    ''|*[!0-9]*) cat "$FAKE_DIR/machines-api.stderr" >&2; fail "fake Machines API did not start" ;;
esac
export FLY_API_HOSTNAME="http://127.0.0.1:$FAKE_MACHINES_API_PORT"
export FLY_FLAPS_BASE_URL="$FLY_API_HOSTNAME"

fake_machines_api_contract() (
    local mid journal rc
    mid="$(python3 -c 'import uuid; print(uuid.uuid4().hex[:14])')"
    add_fake_machine "$mid" cloudbench-api-contract started 0
    journal="$TMP_ROOT/fenced-effect-contract"
    : > "$FAKE_DIR/machines-api.log"
    # The production helper fails closed without a credential: no request.
    for token_case in unset empty; do
        rc=0
        if [ "$token_case" = unset ]; then
            env -u FLY_API_TOKEN python3 -S "$ROOT_DIR/scripts/cloudbench-archived-machine-reuse.py" \
                fenced-effect --machine "$mid" --operation destroy --journal "$journal-$token_case" \
                >/dev/null 2>&1 || rc=$?
        else
            FLY_API_TOKEN="" python3 -S "$ROOT_DIR/scripts/cloudbench-archived-machine-reuse.py" \
                fenced-effect --machine "$mid" --operation destroy --journal "$journal-$token_case" \
                >/dev/null 2>&1 || rc=$?
        fi
        [ "$rc" -ne 0 ] || { echo "FAIL: fenced effect ran with a $token_case credential" >&2; return 1; }
    done
    [ ! -s "$FAKE_DIR/machines-api.log" ] \
        || { echo "FAIL: a credential-less fenced effect sent a Machines request" >&2; return 1; }
    # A foreign credential is refused by the fake, and nothing changes.
    rc=0
    FLY_API_TOKEN="not-the-fixture-token-at-all" python3 -S \
        "$ROOT_DIR/scripts/cloudbench-archived-machine-reuse.py" fenced-effect --machine "$mid" \
        --operation destroy --journal "$journal-foreign" >/dev/null 2>&1 || rc=$?
    [ "$rc" -ne 0 ] && fake_machine_exists "$mid" \
        || { echo "FAIL: the fake Machines API accepted a foreign credential" >&2; return 1; }
    # The exact fixture credential performs one leased, journaled destroy.
    FLY_API_TOKEN="$FAKE_FLY_TOKEN" python3 -S "$ROOT_DIR/scripts/cloudbench-archived-machine-reuse.py" \
        fenced-effect --machine "$mid" --operation destroy --journal "$journal-fixture" \
        || { echo "FAIL: the fixture fenced destroy failed" >&2; return 1; }
    if fake_machine_exists "$mid"; then echo "FAIL: fenced destroy left the Machine" >&2; return 1; fi
    grep -qxF "machine destroy --force $mid -a $FLEET_BENCH_APP" "$FAKE_DIR/journal.log" \
        || { echo "FAIL: fenced destroy was not journaled as a native effect" >&2; return 1; }
    python3 - "$FAKE_DIR/machines-api.log" "$mid" "$FLEET_BENCH_APP" <<'PY'
import sys
rows = [line.split() for line in open(sys.argv[1])]
mid, app = sys.argv[2:]
base = f"/v1/apps/{app}/machines/{mid}"
assert [r for r in rows if r[2] == "401"] == [["POST", base + "/lease", "401"]], rows
assert [r for r in rows if r[2] != "401"] == [
    ["POST", base + "/lease", "200"], ["GET", base, "200"],
    ["DELETE", base + "?force=true", "200"], ["DELETE", base + "/lease", "200"],
], rows
PY
)

journal_must_be_read_only() {  # journal_must_be_read_only <phase>
    if grep -qE '^secrets set' "$FAKE_DIR/journal.log"; then
        fail "$1: the benchmark run path must never stage app-level secrets (refresh is an explicit maintenance op)"
    fi
    if grep -qE '^tokens create' "$FAKE_DIR/journal.log"; then
        fail "$1: the benchmark run path must not mint Machines API tokens (sentinel lease is gone from the run path)"
    fi
    grep -qE '^secrets list' "$FAKE_DIR/journal.log" ||
        fail "$1: the run path must verify the shared app environment (read-only secrets list)"
}

run_controller() {  # run_controller <worktree> <conductor_port> <log> <fleet-args...>
    local ws="$1" port="$2" log="$3"
    local launch_args=() session_leader=() controller_entry=run-bench-fleet
    [ "${CLOUDBENCH_TEST_DISPOSABLE_ONLY:-0}" != 1 ] || controller_entry=run-bench
    shift 3
    launch_args=("$@")
    # Most scenarios need direct exit-status control. The default-detach
    # scenario intentionally omits this opt-out and lets the launcher shell
    # disappear while the fleet continues in its own session.
    [ "${CLOUDBENCH_TEST_DEFAULT_DETACH:-0}" = "1" ] ||
        launch_args+=(--foreground)
    # run-bench-campaign.py starts each foreground fleet as its own session
    # leader (start_new_session=True) and cancels it with os.killpg. Reproduce
    # that exact process-group boundary when a scenario signals the group.
    # A terminal Ctrl-C reaches a foreground fleet whose SIGINT is not ignored;
    # this script's asynchronous launch would otherwise inherit SIG_IGN.
    # The exec'd controller keeps this PID; publish it so the harness can reap
    # the exact session even when a case fails before the owner record exists.
    if [ "${CLOUDBENCH_TEST_NEW_SESSION:-0}" = "1" ]; then
        session_leader=(python3 -c 'import os, signal, sys
path = os.environ.get("CLOUDBENCH_TEST_SESSION_PID_FILE", "")
if path:
    with open(path + ".tmp", "w") as handle:
        handle.write(str(os.getpid()))
    os.replace(path + ".tmp", path)
signal.signal(signal.SIGINT, signal.SIG_DFL)
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])')
    fi
    # Cloud/agent hosts often inject CLOUDBENCH_SNAPSHOT_ID for live fleets.
    # That pin must not leak into this hermetic fixture: the fake inventory only
    # has snap_0001, and a foreign pin marks warm-deps stale → --refresh-deps
    # (which needs a real /data/repo volume the fake does not simulate).
    # Leaked GIT_* / CLOUDBENCH_FLEET_ROOT from a parent agent shell must not
    # redirect this worktree's ownership roots into a foreign sandbox.
    # Real provider credentials must not reach the fixture's children either.
    # A young ambiguous name-only record at joined final teardown is re-resolved
    # by exact name for the rest of its 900s phantom window (0c4374c32). The
    # fake's ambiguous attempts never age out within a scenario, so bound that
    # wait: the real exact-name re-resolution still runs, then ownership is
    # retained and teardown fails closed exactly as each scenario asserts.
    env -u CLOUDBENCH_SNAPSHOT_ID -u CLOUDBENCH_FLEET_ROOT \
        -u GIT_DIR -u GIT_COMMON_DIR -u GIT_WORK_TREE \
        -u BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS \
        -u FLY_API_TOKEN -u FLY_ACCESS_TOKEN \
        PATH="$FIXTURE_STORAGE:$FAKE_BIN:$PATH" \
        PYTHONPATH="$FIXTURE_STORAGE${PYTHONPATH:+:$PYTHONPATH}" \
        CLOUDBENCH_TEST_STORAGE_SCOPE="$TMP_ROOT" \
        CLOUDBENCH_TEST_STORAGE_STATE="$FIXTURE_STORAGE/state.json" \
        CLOUDBENCH_TEST_STORAGE_DEVICE="$FIXTURE_STORAGE_DEVICE" \
        TMPDIR="$SCRIPT_SNAPSHOT_TMP" \
        FLY_BENCH_API_TOKEN="$FAKE_FLY_TOKEN" \
        CONDUCTOR_PORT="$port" \
        BENCHMARK_HUB_UPLOAD_URL="http://127.0.0.1:$((port + 5764))" \
        BENCHMARK_HUB_API_KEY="test-key" \
        CI=1 \
        CLOUDBENCH_FAKE_DIR="$FAKE_DIR" \
        CLOUDBENCH_FAKE_CONTROLLER_WS="$ws" \
        CLOUDBENCH_IMAGE_BUILD_RECEIPT="$FIXTURE_IMAGE_BUILD_RECEIPT" \
        CLOUDBENCH_IMAGE_BUILD_RECEIPT_SHA256="$FIXTURE_IMAGE_BUILD_RECEIPT_SHA256" \
        CLOUDBENCH_FAKE_BREAK_REGISTRY_ROOT="${CLOUDBENCH_FAKE_BREAK_REGISTRY_ROOT:-}" \
        CLOUDBENCH_FAKE_BREAK_POOL_LEDGER="${CLOUDBENCH_FAKE_BREAK_POOL_LEDGER:-}" \
        CLOUDBENCH_FAKE_FAIL_METRICS_PROXY="${CLOUDBENCH_FAKE_FAIL_METRICS_PROXY:-0}" \
        CLOUDBENCH_FAKE_INVALID_METRICS="${CLOUDBENCH_FAKE_INVALID_METRICS:-0}" \
        CLOUDBENCH_TEST_IGNORE_CONTROLLER_TERM="${CLOUDBENCH_TEST_IGNORE_CONTROLLER_TERM:-0}" \
        CLOUDBENCH_TEST_HOLD_AUTOSCALER_AFTER_READY="${CLOUDBENCH_TEST_HOLD_AUTOSCALER_AFTER_READY:-0}" \
        CLOUDBENCH_DETACHED_RECOVERY_SECONDS="${CLOUDBENCH_DETACHED_RECOVERY_SECONDS:-120}" \
        CLOUDBENCH_CAPACITY_RESERVATION_ROOT="$TMP_ROOT/capacity-reservations" \
        CLOUDBENCH_CLONE_LOOKUP_SECONDS="${CLOUDBENCH_CLONE_LOOKUP_SECONDS:-20}" \
        CLOUDBENCH_PHANTOM_TEARDOWN_WAIT_SECONDS="${CLOUDBENCH_PHANTOM_TEARDOWN_WAIT_SECONDS:-2}" \
        CLOUDBENCH_PHANTOM_TEARDOWN_POLL_SECONDS="${CLOUDBENCH_PHANTOM_TEARDOWN_POLL_SECONDS:-1}" \
        CLOUDBENCH_POOL_STOP_ATTEMPTS="${CLOUDBENCH_POOL_STOP_ATTEMPTS:-3}" \
        CLOUDBENCH_POOL_STOP_REQUEST_TIMEOUT="${CLOUDBENCH_POOL_STOP_REQUEST_TIMEOUT:-3}" \
        CLOUDBENCH_DATA_PROXY_READY_TIMEOUT="${CLOUDBENCH_DATA_PROXY_READY_TIMEOUT:-180}" \
        CLOUDBENCH_AUTOSCALER_STARTUP_WAIT_SECONDS="${CLOUDBENCH_AUTOSCALER_STARTUP_WAIT_SECONDS:-600}" \
        CLOUDBENCH_AUTOSCALER_FINALIZATION_WAIT_SECONDS="${CLOUDBENCH_AUTOSCALER_FINALIZATION_WAIT_SECONDS:-300}" \
        CLOUDBENCH_AUTOSCALE_SCALE_DOWN_CONFIRM_SECONDS="${CLOUDBENCH_AUTOSCALE_SCALE_DOWN_CONFIRM_SECONDS:-1}" \
        CLOUDBENCH_PROXY_POST_PROBE_SETTLE_SECONDS=0.1 \
        CLOUDBENCH_POLL_INTERVAL=2 \
        CLOUDBENCH_LAUNCH_SETTLE_SECONDS=1 \
        "${session_leader[@]}" bash "$ws/scripts/$controller_entry" "${launch_args[@]}" > "$log" 2>&1
}

write_dead_registry() {  # write_dead_registry <label> <policy> <host> <name> [id] [role]
    local label="$1" policy="$2" host="$3" name="$4" id="${5:-}" role="${6:-primary}"
    local registry="$SANDBOX/.git/cloudbench-fleet-ownership/$label"
    mkdir -p "$registry/clones"
    cat > "$registry/meta" <<EOF
version=1
app=${FLEET_BENCH_APP}
host=$host
pid=999999
pid_start=Mon Jan  1 00:00:00 2001
run_id=$label
cleanup_policy=$policy
EOF
    {
        printf 'name=%s\n' "$name"
        if [ -n "$id" ]; then
            printf 'id=%s\n' "$id"
            printf 'volume_id=vol_%s\n' "$id"
        fi
        # Production clone records are name[/id/volume_id] only. A synthetic
        # role= field fails registry_record_machine_identity when a name-only
        # record is later bound to a visible machine id + volume.
        :
    } > "$registry/clones/$name"
}

add_fake_machine() {  # add_fake_machine <id> <name> <state> <runner-count> [probe-error] [ignore-stop]
    FAKE_STATE="$FAKE_DIR/state.json" MACHINE_ID="$1" MACHINE_NAME="$2" \
        MACHINE_STATE="$3" RUNNER_COUNT="$4" PROBE_ERROR="${5:-0}" IGNORE_STOP="${6:-0}" python3 - <<'PY'
import hashlib
import ipaddress
import json
import os

path = os.environ["FAKE_STATE"]
with open(path) as fh:
    state = json.load(fh)
volume_id = "vol_" + os.environ["MACHINE_ID"]
# Fly gives every Machine its own 6PN address, and the data-plane proxy selects
# a guest by that address. A shared seeded value routed a claimed pool member's
# status proxy to another seeded Machine that was never booted.
private_ip = str(ipaddress.IPv6Address(
    (0xFDAA << 112) | (0x5EED << 64)
    | int(hashlib.sha256(os.environ["MACHINE_ID"].encode()).hexdigest()[:16], 16)
))
state["machines"].append({
    "id": os.environ["MACHINE_ID"],
    "name": os.environ["MACHINE_NAME"],
    "state": os.environ["MACHINE_STATE"],
    "runner_count": int(os.environ["RUNNER_COUNT"]),
    "probe_error": os.environ["PROBE_ERROR"] == "1",
    "ignore_stop": os.environ["IGNORE_STOP"] == "1",
    "region": "iad",
    "private_ip": private_ip,
    "config": {"mounts": [{"volume": volume_id, "size_gb": 40}]},
})
state["volumes"].append(
    {"id": volume_id, "name": "cloudbench_data_fork", "state": "created", "size_gb": 40, "auto_backup_enabled": True, "snapshot_retention": 5, "attached_machine_id": os.environ["MACHINE_ID"]}
)
with open(path, "w") as fh:
    json.dump(state, fh)
PY
}

fake_machine_exists() {  # fake_machine_exists <id>
    FAKE_STATE="$FAKE_DIR/state.json" MACHINE_ID="$1" python3 - <<'PY'
import json
import os

with open(os.environ["FAKE_STATE"]) as fh:
    machines = json.load(fh)["machines"]
raise SystemExit(0 if any(machine["id"] == os.environ["MACHINE_ID"] for machine in machines) else 1)
PY
}

cp "$FAKE_DIR/state.json" "$FAKE_DIR/state.before-api-contract"
cp "$FAKE_DIR/journal.log" "$FAKE_DIR/journal.before-api-contract" 2>/dev/null || : > "$FAKE_DIR/journal.before-api-contract"
fake_machines_api_contract || fail "raw Machines API effects must use the hermetic fixture provider"
mv "$FAKE_DIR/state.before-api-contract" "$FAKE_DIR/state.json"
mv "$FAKE_DIR/journal.before-api-contract" "$FAKE_DIR/journal.log"
: > "$FAKE_DIR/machines-api.log"
echo "PASS: raw Machines API effects use the fixture provider and fail closed without a credential"

remove_fake_machine_and_volume_exact() {  # <machine-id> <volume-id>
    FAKE_STATE="$FAKE_DIR/state.json" MACHINE_ID="$1" VOLUME_ID="$2" python3 - <<'PY'
import json
import os

path = os.environ["FAKE_STATE"]
with open(path) as handle:
    state = json.load(handle)
machine_id = os.environ["MACHINE_ID"]
volume_id = os.environ["VOLUME_ID"]
machines = [item for item in state["machines"] if item.get("id") == machine_id]
volumes = [item for item in state["volumes"] if item.get("id") == volume_id]
if len(machines) != 1 or len(volumes) != 1:
    raise SystemExit(1)
state["machines"] = [item for item in state["machines"] if item.get("id") != machine_id]
state["volumes"] = [item for item in state["volumes"] if item.get("id") != volume_id]
with open(path, "w") as handle:
    json.dump(state, handle)
PY
}

# Test-only isolation after a scenario deliberately proves evidence retention.
# Verify and preserve the exact fake ledger/state before resetting those fake
# records; never call a runtime destroy helper or relax its evidence requirement.
assert_and_reset_retained_fake_owner() {
    python3 - "$1" "$SANDBOX/.git/cloudbench-fleet-ownership" "$FAKE_DIR" "$TMP_ROOT" <<'PY_RESET'
import json
from pathlib import Path
import re
import shlex
import shutil
import sys
registry, ownership, fake, temporary = map(Path, sys.argv[1:])
assert registry.parent == ownership and re.fullmatch(r"[0-9a-f]{32}", registry.name)
assert registry.resolve() == registry and (registry / "runtime-evidence-unconfirmed").is_file()
def fields(path):
    return dict(line.split("=", 1) for line in path.read_text().splitlines())
meta = fields(registry / "meta")
assert meta["fleet_owner_token"] == registry.name
state_path = fake / "state.json"
state = json.loads(state_path.read_text())
records = [fields(p) for p in (registry / "clones").iterdir()]
assert records
# The immutable audit is independent of cleanup's mutable registry. Losing a
# worker and its registry row must not make the remaining primary look complete.
audit = ownership.parent / "cloudbench-fleet-audits" / registry.name
assert Path(meta["audit_dir"]) == audit and audit.resolve() == audit
assert fields(audit / "meta")["fleet_owner_token"] == registry.name
allocated = [row for path in (audit / "fresh").iterdir() if (row := fields(path)).get("machine_id")]
expected = {row["machine_id"]: (row["clone_name"], row["volume_id"]) for row in allocated}
assert len(expected) == len(allocated) and expected
assert len(records) == len(expected) and {row["id"] for row in records} == set(expected)
for record in records:
    assert (record["name"], record["volume_id"]) == expected[record["id"]]
machines, volumes = set(), set()
for record in records:
    machine, volume = record["id"], record["volume_id"]
    matches = [row for row in state["machines"] if row["id"] == machine]
    assert len(matches) == 1 and matches[0]["name"] == record["name"]
    assert matches[0]["name"] != "cloudbench-warm" and machine != "aaaa0000000001"
    assert matches[0]["config"]["mounts"][0]["volume"] == volume
    assert volume != "vol_aaaa0001" and any(row["id"] == volume for row in state["volumes"])
    machines.add(machine); volumes.add(volume)
for line in (fake / "journal.log").read_text().splitlines():
    argv = shlex.split(line)
    if argv[:2] == ["machine", "destroy"]:
        assert not machines.intersection(argv[2:])
    if argv[:2] == ["volumes", "destroy"]:
        assert not volumes.intersection(argv[2:])
archive = temporary / "retained-fixture-ownership" / registry.name
archive.parent.mkdir(exist_ok=True)
shutil.copytree(registry, archive)
(archive / "fake-state-before-reset.json").write_bytes(state_path.read_bytes())
state["machines"] = [row for row in state["machines"] if row["id"] not in machines]
state["volumes"] = [row for row in state["volumes"] if row["id"] not in volumes]
state_path.write_text(json.dumps(state))
shutil.rmtree(registry)
for reservation in (temporary / "capacity-reservations/reservations").glob(registry.name + "-*"):
    assert reservation.is_file() and not reservation.is_symlink()
    reservation.unlink()
PY_RESET
}

# Disposable lifecycle (60e18e354): a failed run whose runtime evidence is
# incomplete keeps its failed result, owner and evidence-gap latch, while its
# disposable Machines and Volumes are destroyed and verified absent.
assert_and_reset_disposable_failed_owner() {  # <registry> <controller-log> [failed|passed task verdict]
    grep -qxF "❌ runtime evidence is incomplete; failed result retained while disposable resources are retired" "$2" ||
        { echo "missing disposable runtime-evidence gap record in $2" >&2; return 1; }
    python3 - "$1" "$SANDBOX/.git/cloudbench-fleet-ownership" "$FAKE_DIR" "$TMP_ROOT" "${3:-failed}" <<'PY_DISPOSED'
import json
from pathlib import Path
import re
import shlex
import shutil
import sys
registry, ownership, fake, temporary = map(Path, sys.argv[1:5])
verdict = sys.argv[5]
assert registry.parent == ownership and re.fullmatch(r"[0-9a-f]{32}", registry.name)
assert registry.resolve() == registry and (registry / "runtime-evidence-unconfirmed").is_file()
def fields(path):
    return dict(line.split("=", 1) for line in path.read_text().splitlines())
meta = fields(registry / "meta")
assert meta["fleet_owner_token"] == registry.name
assert (registry / "disposable-resources-v1").read_text().strip() == registry.name + "\n" + meta["app"]
run = Path(meta["runs_root"]) / meta["run_id"]
# The evaluated task verdict stays exactly as published; the run is failed.
result = json.loads((run / "_batch/run.json").read_text())["summary"]
if verdict == "failed":
    assert result["failed"] >= 1 and result["passed"] == 0, result
else:
    assert verdict == "passed" and result["passed"] >= 1 and result["failed"] == 0, result
lifecycle = json.loads((run / "_batch/lifecycle.json").read_text())
assert lifecycle["status"] == "failed" and lifecycle["controller_exit_code"] != 0, lifecycle
assert lifecycle["fleet_owner_token"] == registry.name, lifecycle
audit = ownership.parent / "cloudbench-fleet-audits" / registry.name
assert Path(meta["audit_dir"]) == audit and audit.resolve() == audit
allocated = [row for path in (audit / "fresh").iterdir() if (row := fields(path)).get("machine_id")]
assert allocated
state_path = fake / "state.json"
state = json.loads(state_path.read_text())
calls = [shlex.split(line) for line in (fake / "journal.log").read_text().splitlines()]
for row in allocated:
    machine, volume = row["machine_id"], row["volume_id"]
    assert row["disposition"] in ("destroyed-verified-absent", "destroyed-provider-retained"), row
    assert machine != "aaaa0000000001" and volume != "vol_aaaa0001", row
    assert not any(item["id"] == machine for item in state["machines"]), row
    assert all(item["state"] in ("pending_destroy", "destroyed") for item in state["volumes"] if item["id"] == volume), row
    assert any(call[:2] == ["machine", "destroy"] and machine in call[2:] for call in calls), row
    assert any(call[:2] == ["volumes", "destroy"] and volume in call[2:] for call in calls), row
assert any(item["id"] == "aaaa0000000001" for item in state["machines"])
assert any(item["id"] == "vol_aaaa0001" for item in state["volumes"])
archive = temporary / "retained-fixture-ownership" / registry.name
archive.parent.mkdir(exist_ok=True)
shutil.copytree(registry, archive)
shutil.rmtree(registry)
for reservation in (temporary / "capacity-reservations/reservations").glob(registry.name + "-*"):
    assert reservation.is_file() and not reservation.is_symlink()
    reservation.unlink()
PY_DISPOSED
}

assert_and_reset_disposable_failed_benchmark() {  # <bench> <controller-log> [task-verdict]
    local bench="$1" registry selected=""
    for registry in "$SANDBOX/.git/cloudbench-fleet-ownership"/*; do
        [ -f "$registry/meta" ] || continue
        local run_id runs_root
        run_id="$(sed -n 's/^run_id=//p' "$registry/meta")"
        runs_root="$(sed -n 's/^runs_root=//p' "$registry/meta")"
        [ -d "$runs_root/$run_id/$bench" ] || continue
        [ -z "$selected" ] || return 1
        selected="$registry"
    done
    [ -n "$selected" ] || return 1
    assert_and_reset_disposable_failed_owner "$selected" "$2" "${3:-failed}"
}

assert_and_reset_retained_fake_benchmark() {
    local bench="$1" registry selected=""
    for registry in "$SANDBOX/.git/cloudbench-fleet-ownership"/*; do
        [ -f "$registry/meta" ] || continue
        local run_id runs_root
        run_id="$(sed -n 's/^run_id=//p' "$registry/meta")"
        runs_root="$(sed -n 's/^runs_root=//p' "$registry/meta")"
        [ -d "$runs_root/$run_id/$bench" ] || continue
        [ -z "$selected" ] || return 1
        selected="$registry"
    done
    [ -n "$selected" ] || return 1
    assert_and_reset_retained_fake_owner "$selected"
}

# The fleet derives its hub port as CONDUCTOR_PORT+5764 and (by design) frees a
# non-hub listener sitting on it. The test must therefore only ever point the
# fleets at ports it PROBED free and then occupied with its own hub stubs —
# never at a well-known port that could carry a real process on a dev machine.
# Every copy, including nested suites with private TMPDIRs, shares UID-owned
# locks. Keep each flock descriptor through exact Hub teardown. Kernel client
# allocation ignores filesystem locks, so exclude its ephemeral range too.
PORT_WINDOW_SLOT="$(TMP_ROOT="$TMP_ROOT" python3 - <<'PY'
import hashlib
import os

digest = hashlib.sha256(os.environ["TMP_ROOT"].encode()).digest()
print(int.from_bytes(digest[:4], "big") % 200)
PY
)"
command -v flock >/dev/null || fail "flock is required for fixture port ownership"
PORT_CLAIM_ROOT="/tmp/cloudbench-multi-workstream-port-claims-$(id -u)"
# Refuse links, foreign ownership and group/world-writable namespaces. Never
# chmod or remove a pre-existing namespace to make a refusal pass.
python3 - "$PORT_CLAIM_ROOT" <<'PY_CLAIM_ROOT' || fail "unsafe cross-workspace port claim directory"
import os, stat, sys
path = sys.argv[1]
try:
    os.mkdir(path, 0o700)
except FileExistsError:
    pass
info = os.lstat(path)
if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o700):
    raise SystemExit("refusing unsafe port claim namespace")
PY_CLAIM_ROOT
PORT_EPHEMERAL_RANGE="$(cat /proc/sys/net/ipv4/ip_local_port_range)" \
    || fail "could not read kernel ephemeral port range"
read -r PORT_EPHEMERAL_LOW PORT_EPHEMERAL_HIGH PORT_EPHEMERAL_EXTRA <<< "$PORT_EPHEMERAL_RANGE"
[[ "$PORT_EPHEMERAL_LOW" =~ ^[0-9]+$ && "$PORT_EPHEMERAL_HIGH" =~ ^[0-9]+$ ]] \
    && [ -z "$PORT_EPHEMERAL_EXTRA" ] \
    && [ "$PORT_EPHEMERAL_LOW" -ge 1 ] \
    && [ "$PORT_EPHEMERAL_HIGH" -le 65535 ] \
    && [ "$PORT_EPHEMERAL_LOW" -le "$PORT_EPHEMERAL_HIGH" ] \
    || fail "invalid kernel ephemeral port range"
for port_attempt in $(seq 0 199); do
    port_slot=$(((PORT_WINDOW_SLOT + port_attempt) % 200))
    port_base=$((10000 + port_slot * 64))
    # Cover the entire Hub window and both derived conductor ports.
    if { [ "$port_base" -le "$PORT_EPHEMERAL_HIGH" ] \
        && [ "$((port_base + 21))" -ge "$PORT_EPHEMERAL_LOW" ]; } \
        || { [ "$((port_base - 5764))" -le "$PORT_EPHEMERAL_HIGH" ] \
        && [ "$((port_base - 5763))" -ge "$PORT_EPHEMERAL_LOW" ]; }; then
        continue
    fi
    candidate_claim="$PORT_CLAIM_ROOT/$port_base"
    mkdir -m 700 "$candidate_claim" 2>/dev/null || true
    [ ! -L "$candidate_claim" ] && [ -d "$candidate_claim" ] \
        && [ "$(stat -c '%u:%a' "$candidate_claim")" = "$(id -u):700" ] \
        || fail "unsafe port claim: $candidate_claim"
    [ ! -L "$candidate_claim/lock" ] \
        && { [ ! -e "$candidate_claim/lock" ] || [ -f "$candidate_claim/lock" ]; } \
        || fail "unsafe port lock: $candidate_claim"
    exec {PORT_CLAIM_FD}>>"$candidate_claim/lock" || fail "could not open port lock"
    if ! flock -n "$PORT_CLAIM_FD"; then
        exec {PORT_CLAIM_FD}>&-
        continue
    fi
    printf '%s\n%s\n' "$$" "$TMP_ROOT" > "$candidate_claim/owner" || fail "could not publish port claim"
    port_window_busy=0
    for candidate_port in "$port_base" "$((port_base + 1))" \
        "$((port_base + 20))" "$((port_base + 21))"; do
        if ! test_tcp_listener_absent "$candidate_port"; then
            port_window_busy=1
            break
        fi
    done
    if [ "$port_window_busy" = "1" ]; then
        rm -f "$candidate_claim/owner" 2>/dev/null || true
        exec {PORT_CLAIM_FD}>&-
        continue
    fi
    PORT_CLAIM_DIR="$candidate_claim"
    HUB_PORT_A="$port_base"
    HUB_PORT_B=$((port_base + 1))
    break
done
[ -n "$PORT_CLAIM_DIR" ] || fail "could not atomically reserve a free cloudbench test port window"
CONDUCTOR_PORT_A=$((HUB_PORT_A - 5764))
CONDUCTOR_PORT_B=$((HUB_PORT_B - 5764))

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 1 — concurrent provisioning: two controllers, isolated pool machines
# ═════════════════════════════════════════════════════════════════════════════
if [ "${CLOUDBENCH_TEST_DISPOSABLE_ONLY:-0}" != "1" ] \
    && [ "${CLOUDBENCH_TEST_EXACT_RECOVERY_ORDER_ONLY:-0}" != "1" ] \
    && [ "${CLOUDBENCH_TEST_STARTUP_FAILURE_ONLY:-0}" != "1" ] \
    && [ "${CLOUDBENCH_TEST_GROUP_TERM_ONLY:-0}" != "1" ] \
    && [ "${CLOUDBENCH_TEST_READINESS_RETRY_ONLY:-0}" != "1" ] \
    && [ "${CLOUDBENCH_TEST_MANDATORY_METRICS_ONLY:-0}" != "1" ]; then
# --provision-pool is a legacy new-pool request (043659fa8): without measured
# new-Machine admission both concurrent workstreams must refuse before any
# provider mutation and leave no pool ID, claim or fleet ownership behind.
# Concurrent per-workstream isolation is proven on the supported disposable
# path by scenario 2, whose clone barrier requires both clones in flight.
# Model the normally parked donor so even an idempotent park is not needed.
FAKE_STATE="$FAKE_DIR/state.json" python3 - <<'PY'
import json, os
path = os.environ["FAKE_STATE"]
state = json.load(open(path))
warm = next(m for m in state["machines"] if m["name"] == "cloudbench-warm")
warm["config"]["guest"] = {"cpu_kind": "shared", "cpus": 1, "memory_mb": 2048}
json.dump(state, open(path, "w"))
PY
cp "$FAKE_DIR/state.json" "$TMP_ROOT/scenario-1-state.before"
run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-a.log" --provision-pool 1 &
PID_A=$!
PIDS+=("$PID_A")
run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-b.log" --provision-pool 1 &
PID_B=$!
PIDS+=("$PID_B")

status_a=0; wait "$PID_A" || status_a=$?
status_b=0; wait "$PID_B" || status_b=$?
PIDS=()

assert_pool_provisioning_refused() {  # <label> <status> <log> <pool-ledger>
    local label="$1" status="$2" log="$3" ledger="$4"
    [ "$status" -ne 0 ] || fail "$label: a legacy --provision-pool request fabricated success"
    grep -qxF "❌ existing-Machine capacity gap (pool-provision-1.ids): new Machine allocation withheld; authenticated measured admission is not available" "$log" ||
        fail "$label: the pool request was not refused by measured new-Machine admission"
    if grep -qE "cloned |pool ready: [1-9]" "$log"; then
        fail "$label: a refused pool request reported an allocation"
    fi
    [ ! -s "$ledger" ] || fail "$label: a refused pool request recorded pool IDs: $(cat "$ledger")"
}
assert_pool_provisioning_refused "workstream A" "$status_a" "$TMP_ROOT/controller-a.log" "$POOL_A"
assert_pool_provisioning_refused "workstream B" "$status_b" "$TMP_ROOT/controller-b.log" "$POOL_B"
assert_no_controller_script_snapshots "refused provisioning cleanup"
if grep -qE '^(machine (clone|update|start|stop|destroy)|machines? (create|run)|volumes? (create|update|destroy|extend))( |$)' "$FAKE_DIR/journal.log"; then
    fail "scenario 1: a refused pool request mutated the provider: $(grep -E '^(machine|volumes?) ' "$FAKE_DIR/journal.log" | head -3)"
fi
# Only reads and the optional, metadata-only dependency-proof publication.
if grep -vE '^GET |^POST /v1/apps/[^/ ]+/machines/[0-9a-f]+/metadata/' "$FAKE_DIR/machines-api.log" 2>/dev/null | grep -q .; then
    fail "scenario 1: a refused pool request sent a Machines API effect: $(grep -vE '^GET ' "$FAKE_DIR/machines-api.log" | head -3)"
fi
cmp -s "$TMP_ROOT/scenario-1-state.before" "$FAKE_DIR/state.json" ||
    fail "scenario 1: a refused pool request changed provider inventory"
if find "$SANDBOX/.git/cloudbench-pool-claims" -mindepth 1 -print -quit 2>/dev/null | grep -q .; then
    fail "scenario 1: a refused pool request left a pool claim"
fi
if find "$SANDBOX/.git/cloudbench-fleet-ownership" -path '*/clones/*' -print -quit 2>/dev/null | grep -q .; then
    fail "scenario 1: a refused pool request left fleet clone ownership"
fi
journal_must_be_read_only "scenario 1"
echo "PASS: scenario 1 — concurrent legacy pool requests are refused without provider mutation or claims"
fi

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 2 — concurrent RUNS that must FINISH WITH SUCCESS (1/1 passed each)
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -f "$POOL_A" "$POOL_B"
: > "$FAKE_DIR/journal.log"

# Pre-serve each workspace's central hub on its DERIVED port (CONDUCTOR_PORT +
# 5764) so the fleet adopts it — and so the test proves two workspaces get
# NON-COLLIDING hub ports.
hub_stub() {  # hub_stub <port> <runs-root> [test-owner-token]
    local port="$1" runs_root="$2" requested_token="${3:-}" context token pending_file pid
    local deadline pending_ready=0 deferred_signal launch_failed=0
    context="$runs_root/_hub"
    if [ -n "$requested_token" ]; then
        case "$requested_token" in *[!0-9a-f]*) return 1 ;; esac
        [ "${#requested_token}" -eq 32 ] || return 1
        token="$requested_token"
    else
        token="$(python3 -c 'import secrets; print(secrets.token_hex(16))')" || return 1
    fi
    pending_file="$context/agent-link-server.$port.$token.pending"
    mkdir -p "$context" || return 1

    # Bash dispatches trapped signals between simple commands. Defer the three
    # catchable termination signals across spawn -> pending-identity publish so
    # EXIT cleanup can never run in the one interval with a live, unowned PID.
    HUB_LAUNCH_DEFERRED_SIGNAL=""
    trap '[ -n "$HUB_LAUNCH_DEFERRED_SIGNAL" ] || HUB_LAUNCH_DEFERRED_SIGNAL=HUP' HUP
    trap '[ -n "$HUB_LAUNCH_DEFERRED_SIGNAL" ] || HUB_LAUNCH_DEFERRED_SIGNAL=INT' INT
    trap '[ -n "$HUB_LAUNCH_DEFERRED_SIGNAL" ] || HUB_LAUNCH_DEFERRED_SIGNAL=TERM' TERM
    python3 - "$port" "$runs_root" "$token" "$pending_file" <<'PY' &
import gzip, hashlib, http.server, json, os, pathlib, subprocess, sys
import time
from urllib.parse import urlparse

runs_port = int(sys.argv[1])
runs_root = pathlib.Path(sys.argv[2])
owner_token = sys.argv[3]
pending_file = pathlib.Path(sys.argv[4])
repo_root = runs_root.parents[2]
context_dir = runs_root / "_hub"
command = repo_root / "agents/benchmarks/agent_link_server.py"
if os.getpgrp() != os.getpid():
    os.setsid()
import importlib.util
# The workstream's untracked files are its shipped patch; a stray .pyc here
# changes the patch the guest receives.
sys.dont_write_bytecode = True
_link_spec = importlib.util.spec_from_file_location("agent_link_server_identity", command)
_link_module = importlib.util.module_from_spec(_link_spec)
_link_spec.loader.exec_module(_link_module)
pid_start = _link_module._pid_start_time(os.getpid())
argv_sha256 = hashlib.sha256(
    b"\0".join(os.fsencode(argument) for argument in sys.argv)
).hexdigest()
registered = {}

context_dir.mkdir(parents=True, exist_ok=True)
owner_file = context_dir / f"agent-link-server.{runs_port}.{owner_token}.owner"
before_pending_ready = os.environ.get("CLOUDBENCH_TEST_HUB_BEFORE_PENDING_READY")
before_pending_release = os.environ.get("CLOUDBENCH_TEST_HUB_BEFORE_PENDING_RELEASE")
if before_pending_ready:
    pathlib.Path(before_pending_ready).write_text(
        f"{os.getpid()}\n{pid_start}\n{os.getpgrp()}\n"
    )
    while before_pending_release and not pathlib.Path(before_pending_release).exists():
        time.sleep(0.01)
    if os.environ.get("CLOUDBENCH_TEST_HUB_ABORT_BEFORE_PENDING") == "1":
        raise SystemExit(24)
pending_fields = {
    "version": "1", "pid": str(os.getpid()), "pid_start": pid_start,
    "pgid": str(os.getpgrp()), "owner_token": owner_token,
    "command": str(command.resolve()), "argv_sha256": argv_sha256,
    "runs_root": str(runs_root.resolve()), "repo_root": str(repo_root.resolve()),
    "context_dir": str(context_dir.resolve()), "host": "127.0.0.1",
    "port": str(runs_port), "owner_file": str(owner_file.resolve()),
    "status": "pending-owner-publication",
}
pending_temporary = pending_file.with_name(f"{pending_file.name}.tmp.{os.getpid()}")
with pending_temporary.open("x") as handle:
    for key, value in pending_fields.items():
        handle.write(f"{key}={value}\n")
    handle.flush()
    os.fsync(handle.fileno())
pending_temporary.chmod(0o444)
os.replace(pending_temporary, pending_file)
directory_fd = os.open(context_dir, os.O_RDONLY)
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)

before_owner_ready = os.environ.get("CLOUDBENCH_TEST_HUB_BEFORE_OWNER_READY")
before_owner_release = os.environ.get("CLOUDBENCH_TEST_HUB_BEFORE_OWNER_RELEASE")
if before_owner_ready:
    pathlib.Path(before_owner_ready).write_text(f"{os.getpid()}\n{pid_start}\n")
    while before_owner_release and not pathlib.Path(before_owner_release).exists():
        time.sleep(0.01)

class Hub(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        parts = path.split("/")
        if len(parts) == 4 and parts[1] == "run" and parts[3] == "report-card.json":
            run_id = parts[2]
            card = runs_root / run_id / "_batch" / "report-card.json"
            if run_id in ("", ".", "..") or not card.is_file():
                self.send_error(404)
                return
            body = card.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/hub-meta.json":
            body = json.dumps({
                "root": str(runs_root.resolve()),
                "hub_runs_dir": str(runs_root.resolve()),
                "repo_root": str(repo_root.resolve()),
                "context_dir": str(context_dir.resolve()),
                "command": str(command.resolve()),
                "pid": os.getpid(),
                "pid_start": pid_start,
                "owner_token": owner_token,
                "port": runs_port,
                "argv_sha256": argv_sha256,
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/api/benchmarks/runs/"):
            run_id = path.rsplit("/", 1)[-1]
            if run_id not in registered:
                self.send_error(404)
                return
            body = json.dumps({"run": registered[run_id]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        run_ids = " ".join(
            path.name for path in runs_root.iterdir()
            if path.is_dir() and not path.name.startswith("_")
        ) if runs_root.is_dir() else ""
        body = f"Benchmark runs (test hub stub) {run_ids}".encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if urlparse(self.path).path != "/api/benchmarks/runs":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        wire = self.rfile.read(length)
        encoding = self.headers.get("Content-Encoding", "identity").strip().lower()
        if encoding not in {"identity", "gzip"}:
            self.send_error(415)
            return
        try:
            if encoding == "gzip":
                wire = gzip.decompress(wire)
            payload = json.loads(wire or b"{}")
        except (OSError, EOFError, UnicodeDecodeError, json.JSONDecodeError):
            self.send_error(400)
            return
        run_id = payload.get("run_id")
        if not run_id:
            self.send_error(400)
            return
        registered[run_id] = payload
        body = json.dumps({"run": payload}).encode()
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass
server = http.server.ThreadingHTTPServer(("127.0.0.1", runs_port), Hub)
owner_fields = {
    "version": "1", "pid": str(os.getpid()), "pid_start": pid_start,
    "pgid": str(os.getpgrp()), "owner_token": owner_token,
    "command": str(command.resolve()), "argv_sha256": argv_sha256,
    "root": str(runs_root.resolve()), "runs_root": str(runs_root.resolve()),
    "repo_root": str(repo_root.resolve()), "context_dir": str(context_dir.resolve()),
    "host": "127.0.0.1", "port": str(runs_port),
    "status": "live-transfer-required",
}
temporary = owner_file.with_name(f"{owner_file.name}.tmp.{os.getpid()}")
with temporary.open("w") as handle:
    for key, value in owner_fields.items():
        handle.write(f"{key}={value}\n")
    handle.flush()
    os.fsync(handle.fileno())
temporary.chmod(0o444)
os.replace(temporary, owner_file)
server.serve_forever()
PY
    pid=$!
    HUB_PIDS+=("$pid")
    deadline=$((SECONDS + 10))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if [ -f "$pending_file" ] \
            && validate_test_hub_pending_record "$pending_file" "$port" \
                "$runs_root" "${runs_root%/.context/fleet/runs}"; then
            pending_ready=1
            break
        fi
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.05
    done
    deferred_signal="$HUB_LAUNCH_DEFERRED_SIGNAL"
    trap 'cleanup 129' HUP
    trap 'cleanup 130' INT
    trap 'cleanup 143' TERM
    HUB_LAUNCH_DEFERRED_SIGNAL=""
    if [ "$pending_ready" != "1" ]; then
        cloudbench_terminate_tree_and_wait 2 "$pid"
        wait "$pid" 2>/dev/null || true
        untrack_test_hub_pid "$pid"
        launch_failed=1
    fi
    if [ -n "$deferred_signal" ]; then
        case "$deferred_signal" in
            HUP) cleanup 129 ;;
            INT) cleanup 130 ;;
            TERM) cleanup 143 ;;
            *) return 1 ;;
        esac
    fi
    [ "$launch_failed" = "0" ]
}

untrack_test_hub_pid() {  # untrack_test_hub_pid <pid>
    local target="$1" pid
    local remaining=()
    if [ "${#HUB_PIDS[@]}" -gt 0 ]; then
        for pid in "${HUB_PIDS[@]}"; do
            [ "$pid" = "$target" ] || remaining+=("$pid")
        done
    fi
    HUB_PIDS=()
    if [ "${#remaining[@]}" -gt 0 ]; then
        HUB_PIDS=("${remaining[@]}")
    fi
}

reap_test_terminal_hub() {  # <pid>; never join a live or unverified child
    local pid="$1" process_state ps_status
    case "$pid" in ''|*[!0-9]*) return 1 ;; esac
    [ "$pid" -gt 1 ] || return 1
    if process_state="$(ps -p "$pid" -o stat= 2>/dev/null)"; then
        process_state="${process_state//[[:space:]]/}"
        case "$process_state" in
            Z*) ;;
            *)
                echo "❌ refusing to wait for nonterminal test Hub PID: $pid" >&2
                return 1
                ;;
        esac
    else
        ps_status=$?
        if [ "$ps_status" -ne 1 ] || kill -0 "$pid" 2>/dev/null; then
            echo "❌ test Hub terminal PID probe inconclusive: $pid" >&2
            return 1
        fi
    fi
    # A different/unknown birth is insufficient: the numeric PID itself must
    # be terminal before Bash wait can consume its completed child status.
    wait "$pid" 2>/dev/null || true
}

validate_test_hub_owner_record() {  # <owner-file> <port> <runs-root> <workspace>
    python3 - "$1" "$2" "$3" "$4" <<'PY'
import os
import re
import stat
import sys
from pathlib import Path

owner_file = Path(sys.argv[1])
port = int(sys.argv[2])
runs_root = Path(sys.argv[3]).resolve()
workspace = Path(sys.argv[4]).resolve()
context = (runs_root / "_hub").resolve()
command = (workspace / "agents/benchmarks/agent_link_server.py").resolve()
fields = {}
for raw in owner_file.read_text().splitlines():
    key, separator, value = raw.partition("=")
    if not separator or key in fields:
        raise SystemExit(1)
    fields[key] = value
required = {
    "version", "pid", "pid_start", "pgid", "owner_token", "command",
    "argv_sha256", "root", "runs_root", "repo_root", "context_dir",
    "host", "port", "status",
}
if set(fields) != required:
    raise SystemExit(1)
try:
    pid = int(fields["pid"])
    pgid = int(fields["pgid"])
    recorded_port = int(fields["port"])
except ValueError:
    raise SystemExit(1)
token = fields["owner_token"]
digest = fields["argv_sha256"]
if (
    fields["version"] != "1"
    or pid <= 1
    or pgid != pid
    or recorded_port != port
    or not fields["pid_start"]
    or not re.fullmatch(r"[0-9a-f]{32}", token)
    or not re.fullmatch(r"[0-9a-f]{64}", digest)
    or Path(fields["command"]).resolve() != command
    or Path(fields["root"]).resolve() != runs_root
    or Path(fields["runs_root"]).resolve() != runs_root
    or Path(fields["repo_root"]).resolve() != workspace
    or Path(fields["context_dir"]).resolve() != context
    or fields["host"] != "127.0.0.1"
    or fields["status"] != "live-transfer-required"
    or owner_file.is_symlink()
    or owner_file.resolve().parent != context
    or owner_file.name != f"agent-link-server.{port}.{token}.owner"
    or stat.S_IMODE(owner_file.stat().st_mode) & 0o222
):
    raise SystemExit(1)
PY
}

validate_test_hub_pending_record() {  # <pending-file> <port> <runs-root> <workspace>
    python3 - "$1" "$2" "$3" "$4" <<'PY'
import hashlib
import os
import re
import stat
import sys
from pathlib import Path

pending_file = Path(sys.argv[1])
port_text = sys.argv[2]
runs_argument = sys.argv[3]
workspace_argument = sys.argv[4]
try:
    port = int(port_text)
except ValueError:
    raise SystemExit(1)
runs_root = Path(runs_argument).resolve()
workspace = Path(workspace_argument).resolve()
context = (runs_root / "_hub").resolve()
command = (workspace / "agents/benchmarks/agent_link_server.py").resolve()
fields = {}
for raw in pending_file.read_text().splitlines():
    key, separator, value = raw.partition("=")
    if not separator or key in fields:
        raise SystemExit(1)
    fields[key] = value
required = {
    "version", "pid", "pid_start", "pgid", "owner_token", "command",
    "argv_sha256", "runs_root", "repo_root", "context_dir", "host", "port",
    "owner_file", "status",
}
if set(fields) != required:
    raise SystemExit(1)
try:
    pid = int(fields["pid"])
    pgid = int(fields["pgid"])
    recorded_port = int(fields["port"])
except ValueError:
    raise SystemExit(1)
token = fields["owner_token"]
digest = fields["argv_sha256"]
owner_file = context / f"agent-link-server.{port}.{token}.owner"
expected_digest = hashlib.sha256(
    b"\0".join(
        os.fsencode(argument)
        for argument in ["-", port_text, runs_argument, token, str(pending_file)]
    )
).hexdigest()
if (
    fields["version"] != "1"
    or pid <= 1
    or pgid != pid
    or recorded_port != port
    or not fields["pid_start"]
    or not re.fullmatch(r"[0-9a-f]{32}", token)
    or digest != expected_digest
    or Path(fields["command"]).resolve() != command
    or Path(fields["runs_root"]).resolve() != runs_root
    or Path(fields["repo_root"]).resolve() != workspace
    or Path(fields["context_dir"]).resolve() != context
    or fields["host"] != "127.0.0.1"
    or fields["status"] != "pending-owner-publication"
    or Path(fields["owner_file"]).resolve() != owner_file.resolve()
    or pending_file.is_symlink()
    or pending_file.resolve().parent != context
    or pending_file.name != f"agent-link-server.{port}.{token}.pending"
    or stat.S_IMODE(pending_file.stat().st_mode) & 0o222
):
    raise SystemExit(1)
PY
}

terminate_test_pending_hubs() {  # terminate_test_pending_hubs <workspace>
    local ws="$1" runs_root="$1/.context/fleet/runs"
    local hub_context="$runs_root/_hub" pending_file pid pid_start pgid port
    local process_state actual_pgid deadline group_state listener_owner probe_status
    [ -d "$hub_context" ] || return 0
    for pending_file in "$hub_context"/agent-link-server.*.*.pending; do
        [ -f "$pending_file" ] || continue
        pid="$(cloudbench_tracked_owner_value "$pending_file" pid)"
        pid_start="$(cloudbench_tracked_owner_value "$pending_file" pid_start)"
        pgid="$(cloudbench_tracked_owner_value "$pending_file" pgid)"
        port="$(cloudbench_tracked_owner_value "$pending_file" port)"
        case "$pid" in ''|*[!0-9]*) echo "❌ malformed pending test Hub PID: $pending_file" >&2; return 1 ;; esac
        case "$pgid" in ''|*[!0-9]*) echo "❌ malformed pending test Hub PGID: $pending_file" >&2; return 1 ;; esac
        case "$port" in ''|*[!0-9]*) echo "❌ malformed pending test Hub port: $pending_file" >&2; return 1 ;; esac
        [ -n "$pid_start" ] || {
            echo "❌ pending test Hub omitted PID birth identity: $pending_file" >&2
            return 1
        }
        validate_test_hub_pending_record "$pending_file" "$port" "$runs_root" "$ws" || {
            echo "❌ refusing malformed or foreign pending test Hub record: $pending_file" >&2
            return 1
        }
        process_state="$(ps -p "$pid" -o stat= 2>/dev/null | awk '{$1=$1; print}' || true)"
        case "$process_state" in
            Z*) wait "$pid" 2>/dev/null || true ;;
        esac
        if cloudbench_pid_matches_start "$pid" "$pid_start"; then
            actual_pgid="$(ps -p "$pid" -o pgid= 2>/dev/null | awk '{$1=$1; print}')"
            [ "$pgid" = "$pid" ] && [ "$actual_pgid" = "$pgid" ] || {
                echo "❌ refusing pending test Hub with changed process group: $pending_file" >&2
                return 1
            }
            cloudbench_signal_tracked_group "$pid" "$pid_start" TERM || {
                echo "❌ exact pending test Hub TERM failed: $pending_file" >&2
                return 1
            }
            deadline=$((SECONDS + 5))
            while cloudbench_pid_matches_start "$pid" "$pid_start" \
                && [ "$SECONDS" -lt "$deadline" ]; do
                sleep 0.05
            done
            if cloudbench_pid_matches_start "$pid" "$pid_start"; then
                cloudbench_signal_tracked_group "$pid" "$pid_start" KILL || {
                    echo "❌ exact pending test Hub KILL failed: $pending_file" >&2
                    return 1
                }
            fi
        fi
        reap_test_terminal_hub "$pid" || return 1
        if cloudbench_pid_matches_start "$pid" "$pid_start"; then
            echo "❌ exact pending test Hub PID survived teardown: $pid" >&2
            return 1
        fi
        group_state="$(cloudbench_process_group_state "$pgid")"
        [ "$group_state" = absent ] || {
            echo "❌ exact pending test Hub process group remains $group_state: $pgid" >&2
            return 1
        }
        probe_status=0
        cloudbench_tcp_listener_present "$port" || probe_status=$?
        if [ "$probe_status" -eq 0 ]; then
            listener_owner="$(cloudbench_central_hub_owner_for \
                "$port" "$runs_root" "$ws" || true)"
            # A shared port is not process identity. Defer a verified distinct
            # owner to the owner-record pass below; every other listener means
            # this exact pending teardown failed and the reset must stop.
            if [ -z "$listener_owner" ] \
                || [ "$listener_owner" = "${pending_file%.pending}.owner" ]; then
                echo "❌ pending test Hub listener survived exact teardown on :$port" >&2
                return 1
            fi
        elif [ "$probe_status" -ne 1 ]; then
            echo "❌ pending test Hub listener probe inconclusive on :$port (rc=$probe_status)" >&2
            return 1
        fi
        untrack_test_hub_pid "$pid"
        chmod u+w "$pending_file" 2>/dev/null || true
        rm -f "$pending_file" || return 1
    done
}

terminate_test_owned_hubs() {  # terminate_test_owned_hubs <workspace>
    local ws="$1" runs_root="$1/.context/fleet/runs"
    local hub_context="$runs_root/_hub" owner_file pid pid_start pgid port group_state process_state
    local owner_ports=() completed_owners=() completed_pids=() index
    [ -d "$hub_context" ] || return 0
    terminate_test_pending_hubs "$ws" || return 1
    for owner_file in "$hub_context"/agent-link-server.*.*.owner; do
        [ -f "$owner_file" ] || continue
        pid="$(cloudbench_tracked_owner_value "$owner_file" pid)"
        pid_start="$(cloudbench_tracked_owner_value "$owner_file" pid_start)"
        pgid="$(cloudbench_tracked_owner_value "$owner_file" pgid)"
        port="$(cloudbench_tracked_owner_value "$owner_file" port)"
        case "$pid" in ''|*[!0-9]*) echo "❌ malformed test Hub PID: $owner_file" >&2; return 1 ;; esac
        case "$pgid" in ''|*[!0-9]*) echo "❌ malformed test Hub PGID: $owner_file" >&2; return 1 ;; esac
        case "$port" in ''|*[!0-9]*) echo "❌ malformed test Hub port: $owner_file" >&2; return 1 ;; esac
        [ -n "$pid_start" ] || {
            echo "❌ test Hub owner omitted PID birth identity: $owner_file" >&2
            return 1
        }
        validate_test_hub_owner_record "$owner_file" "$port" "$runs_root" "$ws" || {
            echo "❌ refusing malformed or foreign test Hub owner record: $owner_file" >&2
            return 1
        }
        owner_ports+=("$port")
        process_state="$(ps -p "$pid" -o stat= 2>/dev/null | awk '{$1=$1; print}' || true)"
        case "$process_state" in
            Z*) wait "$pid" 2>/dev/null || true ;;
        esac
        if cloudbench_pid_matches_start "$pid" "$pid_start"; then
            cloudbench_central_hub_owner_matches "$port" "$runs_root" \
                "$ws" "$owner_file" || {
                echo "❌ refusing to erase a live Hub without exact test ownership: $owner_file" >&2
                return 1
            }
            cloudbench_terminate_central_hub_owner "$port" "$runs_root" \
                "$ws" "$owner_file" 5 || {
                echo "❌ exact test Hub teardown failed: $owner_file" >&2
                return 1
            }
        fi
        # Direct hub stubs are children of this test shell. Reap their exited
        # process records before checking birth identity so a zombie cannot be
        # mistaken for a still-live listener.
        reap_test_terminal_hub "$pid" || return 1
        if cloudbench_pid_matches_start "$pid" "$pid_start"; then
            echo "❌ exact test Hub PID survived teardown: $pid" >&2
            return 1
        fi
        group_state="$(cloudbench_process_group_state "$pgid")"
        [ "$group_state" = absent ] || {
            echo "❌ exact test Hub process group remains $group_state: $pgid" >&2
            return 1
        }
        completed_owners+=("$owner_file")
        completed_pids+=("$pid")
    done
    for port in "${owner_ports[@]}"; do
        if ! test_tcp_listener_absent "$port"; then
            echo "❌ test Hub listener absence not verified after exact teardown on :$port" >&2
            return 1
        fi
    done
    # Keep ownership evidence until every stopped Hub's port is conclusively
    # absent. A failed probe must leave the exact records available for retry.
    for index in "${!completed_owners[@]}"; do
        owner_file="${completed_owners[$index]}"
        untrack_test_hub_pid "${completed_pids[$index]}"
        chmod u+w "$owner_file" 2>/dev/null || true
        rm -f "$owner_file" "$owner_file.terminal" || return 1
    done
}

reset_test_workspace_fleet_roots() {  # reset_test_workspace_fleet_roots <workspace>...
    local ws port runs_root owner_file candidate deadline replacement_pid
    for ws in "$@"; do
        terminate_test_owned_hubs "$ws" \
            || fail "refusing to reset $ws before exact Hub teardown"
    done
    for ws in "$@"; do
        # Owner records and some ledger files are chmod a-w; rm -rf must regain
        # write bits or the Fleet root can survive and poison later scenarios.
        if [ -e "$ws/.context/fleet" ]; then
            chmod -R u+w "$ws/.context/fleet" 2>/dev/null || true
            rm -rf "$ws/.context/fleet"
        fi
        [ ! -e "$ws/.context/fleet" ] \
            || fail "workspace Fleet root survived reset: $ws/.context/fleet"
    done
    # BENCHMARK_HUB_UPLOAD_URL deliberately points at the same local test double
    # as the diagnostic Hub. The production diagnostic server is GET-only; after
    # a ledger reset, letting run-bench-fleet start that real server would make
    # required in-app registration fail with POST 501 before fake Fly is reached.
    # Recreate only _hub with a new exact-owned POST-capable stub after the old
    # PID/group/listener have been proven gone by terminate_test_owned_hubs.
    for ws in "$@"; do
        case "$ws" in
            "$WS_A") port="$HUB_PORT_A" ;;
            "$WS_B") port="$HUB_PORT_B" ;;
            *) fail "refusing to launch a reset Hub for unknown workspace: $ws" ;;
        esac
        runs_root="$ws/.context/fleet/runs"
        hub_stub "$port" "$runs_root" \
            || fail "workspace reset could not launch its replacement test Hub"
        owner_file=""
        deadline=$((SECONDS + 10))
        while [ "$SECONDS" -lt "$deadline" ]; do
            candidate="$(find "$runs_root/_hub" -maxdepth 1 \
                -name "agent-link-server.$port.*.owner" -type f -print -quit 2>/dev/null)"
            if [ -n "$candidate" ] \
                && validate_test_hub_owner_record "$candidate" "$port" "$runs_root" "$ws" \
                && cloudbench_central_hub_owner_matches \
                    "$port" "$runs_root" "$ws" "$candidate"; then
                owner_file="$candidate"
                break
            fi
            sleep 0.05
        done
        [ -n "$owner_file" ] \
            || fail "workspace reset replacement Hub never published exact live ownership"
        replacement_pid="$(cloudbench_tracked_owner_value "$owner_file" pid)"
        case " ${HUB_PIDS[*]} " in
            *" $replacement_pid "*) ;;
            *) fail "workspace reset replacement Hub escaped exact PID tracking" ;;
        esac
    done
}

assert_test_hub_accepts_required_upload() {  # <workspace> <port> <label>
    local ws="$1" port="$2" label="$3" runs_root owner_file owner_pid
    local owner_token card
    runs_root="$ws/.context/fleet/runs"
    owner_file="$(find "$runs_root/_hub" -maxdepth 1 \
        -name "agent-link-server.$port.*.owner" -type f -print -quit 2>/dev/null)"
    [ -n "$owner_file" ] \
        || fail "$label did not publish an exact replacement Hub owner"
    validate_test_hub_owner_record "$owner_file" "$port" "$runs_root" "$ws" \
        || fail "$label published an invalid replacement Hub owner"
    cloudbench_central_hub_owner_matches "$port" "$runs_root" "$ws" "$owner_file" \
        || fail "$label replacement Hub owner does not match its live endpoint"
    owner_pid="$(cloudbench_tracked_owner_value "$owner_file" pid)"
    owner_token="$(cloudbench_tracked_owner_value "$owner_file" owner_token)"
    case " ${HUB_PIDS[*]} " in
        *" $owner_pid "*) ;;
        *) fail "$label replacement Hub PID is absent from exact cleanup tracking" ;;
    esac
    card="$TMP_ROOT/$label-upload.json"
    printf '{"run_id":"%s","status":"starting","tasks":[]}\n' "$label" > "$card"
    BENCHMARK_HUB_UPLOAD_URL="http://127.0.0.1:$port" \
        BENCHMARK_HUB_API_KEY=test-key \
        python3 "$ws/agents/benchmarks/hub_upload.py" \
            --require-visible "$card" --run-id "$label" --source fake-fleet-reset \
            > "$TMP_ROOT/$label-upload.log" 2>&1 \
        || fail "$label replacement Hub rejected the required POST/readback contract"
    curl --noproxy '*' -fsS "http://127.0.0.1:$port/hub-meta.json" \
        | OWNER_PID="$owner_pid" OWNER_TOKEN="$owner_token" python3 -c '
import json, os, sys
payload = json.load(sys.stdin)
if payload.get("pid") != int(os.environ["OWNER_PID"]):
    raise SystemExit("replacement endpoint PID did not match its owner record")
if payload.get("owner_token") != os.environ["OWNER_TOKEN"]:
    raise SystemExit("replacement endpoint token did not match its owner record")
' \
        || fail "$label POST reached an endpoint without replacement ownership identity"
}

write_reconciled_provider_audit() {  # <audit> <owner-file> <owner-token> <run-id>
    local audit="$1" owner_file="$2" owner_token="$3" run_id="$4"
    local name machine_id source_id
    local names=(cloudbench-retired-hub-a cloudbench-retired-hub-b)
    local machine_ids=(a11ce000000001 a11ce000000002)
    local source_ids=(aaaa0000000001 aaaa0000000001)
    mkdir -p "$audit/expected-fresh" "$audit/fresh" "$audit/by-machine-id" \
        "$audit/pool-handoffs" "$audit/claims" \
        "$WS_A/.context/fleet/runs/$run_id" || return 1
    : > "$audit/owned-clones.ids"
    : > "$audit/owned-clones.names"
    for index in "${!names[@]}"; do
        name="${names[$index]}"
        machine_id="${machine_ids[$index]}"
        source_id="${source_ids[$index]}"
        cat > "$audit/expected-fresh/$name" <<EOF
clone_name=$name
source_machine_id=$source_id
EOF
        cat > "$audit/fresh/$name" <<EOF
version=1
fleet_owner_token=$owner_token
run_id=$run_id
app=${FLEET_BENCH_APP}
clone_name=$name
source=fresh-clone
source_machine_id=$source_id
machine_id=$machine_id
volume_id=vol_$machine_id
disposition=destroyed-verified-absent
EOF
        printf '%s\n' "$name" > "$audit/by-machine-id/$machine_id"
    done
    cat > "$audit/meta" <<EOF
version=1
fleet_owner_token=$owner_token
run_id=$run_id
app=${FLEET_BENCH_APP}
workspace_root=$WS_A
status=incomplete
hub_disposition=retained-exact-owner-transfer-required
hub_owner_file=$owner_file
hub_owner_token=$(cloudbench_tracked_owner_value "$owner_file" owner_token)
hub_pid=$(cloudbench_tracked_owner_value "$owner_file" pid)
hub_pid_start=$(cloudbench_tracked_owner_value "$owner_file" pid_start)
hub_argv_sha256=$(cloudbench_tracked_owner_value "$owner_file" argv_sha256)
EOF
}

finalize_reconciled_provider_audit() {  # <audit> <owner-file> <run-id>
    local audit="$1" owner_file="$2" run_id="$3"
    (
        registry_meta_value() {
            sed -n "s/^${2}=//p" "$1" 2>/dev/null | head -1
        }
        eval "$(FLEET_SRC="$WS_A/scripts/run-bench-fleet" python3 - <<'PY'
from pathlib import Path
import os

text = Path(os.environ["FLEET_SRC"]).read_text()
start = text.index("fleet_audit_finalize_provider_teardown() {")
end = text.index("\nfleet_audit_finalize_recovered_registry() {", start)
print(text[start:end])
PY
)"
        FLEET_TEARDOWN_OWNERSHIP_DIR="$audit"
        OWNED_CLONES_FILE="$audit/owned-clones.ids"
        OWNED_CLONE_NAMES_FILE="$audit/owned-clones.names"
        FLEET_OWNER_TOKEN="$(sed -n 's/^fleet_owner_token=//p' "$audit/meta")"
        RUN_ID="$run_id"
        APP="$FLEET_BENCH_APP"
        POOL_CLAIMS_DIR="$audit/claims"
        GIT_COMMON_DIR="$SANDBOX/.git"
        ROOT_DIR="$WS_A"
        RUNS_ROOT="$WS_A/.context/fleet/runs"
        FLEET_DIR="$RUNS_ROOT/$run_id"
        CENTRAL_HUB_OWNER_FILE="$owner_file"
        DASH_BASE="$HUB_PORT_A"
        PROVISION_POOL=""
        FLEET_AUDIT_SHARED_ONLY=0
        FLEET_AUDIT_SHARED_ONLY_REASON=""
        fleet_audit_finalize_provider_teardown
    )
}

stale_hub_replacement_finalize_contract() {  # <original-owner-file>
    local original_owner="$1" original_pid original_start replacement_owner
    local replacement_pid replacement_start deadline audit owner_token
    local reused_owner reused_token reused_birth reused_audit
    original_pid="$(cloudbench_tracked_owner_value "$original_owner" pid)"
    original_start="$(cloudbench_tracked_owner_value "$original_owner" pid_start)"
    cloudbench_terminate_central_hub_owner "$HUB_PORT_A" \
        "$WS_A/.context/fleet/runs" "$WS_A" "$original_owner" 5 \
        || fail "could not retire the original exact Hub fixture"
    wait "$original_pid" 2>/dev/null || true
    untrack_test_hub_pid "$original_pid"
    ! cloudbench_pid_matches_start "$original_pid" "$original_start" \
        || fail "retired Hub fixture still has its original PID birth"

    hub_stub "$HUB_PORT_A" "$WS_A/.context/fleet/runs" \
        "${CLOUDBENCH_TEST_REPLACEMENT_HUB_TOKEN:-ffffffffffffffffffffffffffffffff}" \
        || fail "could not launch the replacement Hub fixture"
    replacement_owner=""
    deadline=$((SECONDS + 10))
    while [ "$SECONDS" -lt "$deadline" ]; do
        for candidate in "$WS_A/.context/fleet/runs/_hub"/agent-link-server."$HUB_PORT_A".*.owner; do
            [ -f "$candidate" ] && [ "$candidate" != "$original_owner" ] || continue
            if cloudbench_central_hub_owner_matches "$HUB_PORT_A" \
                "$WS_A/.context/fleet/runs" "$WS_A" "$candidate"; then
                replacement_owner="$candidate"
                break 2
            fi
        done
        sleep 0.05
    done
    [ -n "$replacement_owner" ] \
        || fail "replacement Hub never published exact live ownership"
    replacement_pid="$(cloudbench_tracked_owner_value "$replacement_owner" pid)"
    replacement_start="$(cloudbench_tracked_owner_value "$replacement_owner" pid_start)"
    [ "$replacement_pid:$replacement_start" != "$original_pid:$original_start" ] \
        || fail "replacement Hub did not establish a distinct PID birth"

    owner_token=11111111111111111111111111111111
    audit="$TMP_ROOT/stale-hub-replacement-audit"
    write_reconciled_provider_audit "$audit" "$original_owner" "$owner_token" \
        stale-hub-replacement || fail "could not seed reconciled provider audit"
    finalize_reconciled_provider_audit "$audit" "$original_owner" \
        stale-hub-replacement \
        || fail "provider teardown must finalize after its exact Hub birth retires"
    [ "$(sed -n 's/^hub_disposition=//p' "$audit/meta")" \
        = "retired-exact-owner-verified-absent" ] \
        || fail "retired Hub birth was not terminalized in the provider audit"
    [ -z "$(find "$audit/claims" -mindepth 1 -print -quit)" ] \
        || fail "retired-Hub provider audit unexpectedly retained a pool claim"
    cloudbench_central_hub_owner_matches "$HUB_PORT_A" \
        "$WS_A/.context/fleet/runs" "$WS_A" "$replacement_owner" \
        || fail "provider finalization disturbed the replacement Hub"

    # Simulate numeric PID reuse explicitly: the stale authority names the
    # replacement PID/PGID but an earlier birth. The birth mismatch must retire
    # only that historical authority and must never signal the live process.
    reused_token=22222222222222222222222222222222
    reused_birth="Mon Jan 1 00:00:00 2001"
    reused_owner="$WS_A/.context/fleet/runs/_hub/agent-link-server.$HUB_PORT_A.$reused_token.owner"
    sed \
        -e "s/^owner_token=.*/owner_token=$reused_token/" \
        -e "s/^pid_start=.*/pid_start=$reused_birth/" \
        "$replacement_owner" > "$reused_owner"
    chmod a-w "$reused_owner"
    ! cloudbench_pid_matches_start "$replacement_pid" "$reused_birth" \
        || fail "numeric PID-reuse fixture did not establish a birth mismatch"
    reused_audit="$TMP_ROOT/reused-hub-pid-audit"
    write_reconciled_provider_audit "$reused_audit" "$reused_owner" "$reused_token" \
        reused-hub-pid || fail "could not seed reused-PID provider audit"
    finalize_reconciled_provider_audit "$reused_audit" "$reused_owner" reused-hub-pid \
        || fail "provider teardown must retire a reused numeric PID by birth identity"
    [ "$(sed -n 's/^hub_disposition=//p' "$reused_audit/meta")" \
        = "retired-exact-owner-verified-absent" ] \
        || fail "reused numeric PID authority was not terminalized by birth"
    cloudbench_pid_matches_start "$replacement_pid" "$replacement_start" \
        || fail "reused-PID finalization signaled the live replacement process"
    cloudbench_central_hub_owner_matches "$HUB_PORT_A" \
        "$WS_A/.context/fleet/runs" "$WS_A" "$replacement_owner" \
        || fail "reused-PID finalization changed the live replacement endpoint"
    chmod u+w "$reused_owner"
    rm -f "$reused_owner"
    echo "PASS: retired exact Hub births do not block provider teardown or disturb replacements"
}

pending_hub_cleanup_contract() {
    local contract_root="$TMP_ROOT/pending-hub-contract"
    local ws="$contract_root/pending-hub-workspace"
    local runs_root="$ws/.context/fleet/runs" ready="$TMP_ROOT/pending-hub.ready"
    local release="$TMP_ROOT/pending-hub.release" proof="$TMP_ROOT/pending-hub.proof"
    local port pending_file pid pid_start pgid owner_file deadline rc=0
    mkdir -p "$ws/agents/benchmarks" "$runs_root/_hub" || return 1
    cp "$ROOT_DIR/agents/benchmarks/agent_link_server.py" \
        "$ws/agents/benchmarks/agent_link_server.py" || return 1
    port="$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
)" || return 1
    (
        export CLOUDBENCH_TEST_KEEP_TMP_ON_FAILURE=0
        TMP_ROOT="$contract_root"
        SCRIPT_SNAPSHOT_TMP="$TMP_ROOT/script-snapshots"
        PIDS=()
        HUB_PIDS=()
        TEST_FAILED=0
        PORT_CLAIM_DIR=""
        WS_A="$ws"
        WS_B=""
        trap cleanup EXIT
        trap 'cleanup 129' HUP
        trap 'cleanup 130' INT
        trap 'cleanup 143' TERM
        export CLOUDBENCH_TEST_HUB_BEFORE_OWNER_READY="$ready"
        export CLOUDBENCH_TEST_HUB_BEFORE_OWNER_RELEASE="$release"
        hub_stub "$port" "$runs_root" || exit 1
        unset CLOUDBENCH_TEST_HUB_BEFORE_OWNER_READY CLOUDBENCH_TEST_HUB_BEFORE_OWNER_RELEASE
        deadline=$((SECONDS + 5))
        while [ ! -f "$ready" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.05; done
        [ -f "$ready" ] || exit 1
        pending_file="$(find "$runs_root/_hub" -maxdepth 1 \
            -name "agent-link-server.$port.*.pending" -type f -print -quit)"
        [ -n "$pending_file" ] \
            && validate_test_hub_pending_record "$pending_file" "$port" "$runs_root" "$ws" \
            || exit 1
        pid="$(cloudbench_tracked_owner_value "$pending_file" pid)"
        pid_start="$(cloudbench_tracked_owner_value "$pending_file" pid_start)"
        pgid="$(cloudbench_tracked_owner_value "$pending_file" pgid)"
        printf '%s\n%s\n%s\n%s\n' "$pid" "$pid_start" "$pgid" "$pending_file" > "$proof"
        kill -TERM "$BASHPID"
        exit 99
    ) || rc=$?
    [ -f "$proof" ] || return 1
    pid="$(sed -n '1p' "$proof")"
    pid_start="$(sed -n '2p' "$proof")"
    pgid="$(sed -n '3p' "$proof")"
    pending_file="$(sed -n '4p' "$proof")"
    if [ "$rc" -eq 143 ] \
        && ! cloudbench_pid_matches_start "$pid" "$pid_start" \
        && [ "$(cloudbench_process_group_state "$pgid")" = absent ] \
        && test_tcp_listener_absent "$port" \
        && [ ! -e "$pending_file" ] \
        && [ ! -e "$contract_root" ]; then
        return 0
    fi

    # Pre-fix failure hygiene: let the exact stub finish publishing its immutable
    # owner, then use the already-hardened exact-owner cleanup path. The contract
    # still returns red; it never leaves its deliberate failure process behind.
    : > "$release"
    owner_file="${pending_file%.pending}.owner"
    deadline=$((SECONDS + 5))
    while [ "$SECONDS" -lt "$deadline" ]; do
        cloudbench_central_hub_owner_matches "$port" "$runs_root" "$ws" "$owner_file" \
            && break
        sleep 0.05
    done
    if cloudbench_central_hub_owner_matches "$port" "$runs_root" "$ws" "$owner_file"; then
        terminate_test_owned_hubs "$ws" || return 1
    elif cloudbench_pid_matches_start "$pid" "$pid_start"; then
        [ "$(ps -p "$pid" -o pgid= 2>/dev/null | awk '{$1=$1; print}')" = "$pgid" ] \
            && cloudbench_signal_tracked_group "$pid" "$pid_start" KILL \
            || return 1
        wait "$pid" 2>/dev/null || true
    fi
    chmod u+w "$pending_file" 2>/dev/null || true
    rm -f "$pending_file" 2>/dev/null || return 1
    chmod -R u+w "$contract_root" 2>/dev/null || true
    rm -rf "$contract_root"
    ! cloudbench_pid_matches_start "$pid" "$pid_start" \
        && [ "$(cloudbench_process_group_state "$pgid")" = absent ] \
        && test_tcp_listener_absent "$port" \
        || return 1
    return 1
}

prepublication_signal_contract() {
    local contract_root="$TMP_ROOT/prepublication-signal-contract"
    local ws="$contract_root/workspace" runs_root="$ws/.context/fleet/runs"
    local ready="$TMP_ROOT/prepublication-signal.ready"
    local release="$TMP_ROOT/prepublication-signal.release"
    local port pid pid_start pgid deadline rc=0
    mkdir -p "$ws/agents/benchmarks" "$runs_root/_hub" || return 1
    cp "$ROOT_DIR/agents/benchmarks/agent_link_server.py" \
        "$ws/agents/benchmarks/agent_link_server.py" || return 1
    port="$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
)" || return 1
    (
        local contract_shell_pid notifier_pid
        export CLOUDBENCH_TEST_KEEP_TMP_ON_FAILURE=0
        TMP_ROOT="$contract_root"
        SCRIPT_SNAPSHOT_TMP="$TMP_ROOT/script-snapshots"
        PIDS=()
        HUB_PIDS=()
        TEST_FAILED=0
        PORT_CLAIM_DIR=""
        WS_A="$ws"
        WS_B=""
        trap cleanup EXIT
        trap 'cleanup 129' HUP
        trap 'cleanup 130' INT
        trap 'cleanup 143' TERM
        contract_shell_pid="$BASHPID"
        export CLOUDBENCH_TEST_HUB_BEFORE_PENDING_READY="$ready"
        export CLOUDBENCH_TEST_HUB_BEFORE_PENDING_RELEASE="$release"
        export CLOUDBENCH_TEST_HUB_ABORT_BEFORE_PENDING=1
        (
            deadline=$((SECONDS + 5))
            while [ ! -f "$ready" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.01; done
            [ -f "$ready" ] || exit 1
            kill -TERM "$contract_shell_pid" || exit 1
            : > "$release"
        ) &
        notifier_pid=$!
        PIDS+=("$notifier_pid")
        hub_stub "$port" "$runs_root"
        exit 98
    ) || rc=$?
    [ -f "$ready" ] || return 1
    pid="$(sed -n '1p' "$ready")"
    pid_start="$(sed -n '2p' "$ready")"
    pgid="$(sed -n '3p' "$ready")"
    if [ "$rc" -eq 143 ] \
        && ! cloudbench_pid_matches_start "$pid" "$pid_start" \
        && [ "$(cloudbench_process_group_state "$pgid")" = absent ] \
        && test_tcp_listener_absent "$port" \
        && [ ! -e "$contract_root" ]; then
        return 0
    fi

    # Exact failure hygiene for the deliberate red side of this contract.
    : > "$release"
    if cloudbench_pid_matches_start "$pid" "$pid_start"; then
        [ "$(ps -p "$pid" -o pgid= 2>/dev/null | awk '{$1=$1; print}')" = "$pgid" ] \
            && cloudbench_signal_tracked_group "$pid" "$pid_start" KILL \
            || return 1
        deadline=$((SECONDS + 5))
        while cloudbench_pid_matches_start "$pid" "$pid_start" \
            && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.05; done
    fi
    chmod -R u+w "$contract_root" 2>/dev/null || true
    rm -rf "$contract_root"
    ! cloudbench_pid_matches_start "$pid" "$pid_start" \
        && [ "$(cloudbench_process_group_state "$pgid")" = absent ] \
        && test_tcp_listener_absent "$port" \
        || return 1
    return 1
}

if ! pending_hub_cleanup_contract; then
    fail "pending Hub identity escaped exact cleanup before owner publication"
fi
echo "PASS: TERM before Hub owner publication exact-cleans pending identity"
prepublication_signal_contract \
    || fail "TERM before pending Hub identity publication was swallowed or leaked its process"
echo "PASS: TERM before pending Hub identity publication is honored after exact child cleanup"
[ "${#HUB_PIDS[@]}" -eq 0 ] || fail "Hub PID tracking was nonempty before idempotence check"
untrack_test_hub_pid 999999
[ "${#HUB_PIDS[@]}" -eq 0 ] \
    || fail "untracking an absent Hub PID fabricated an empty array member"
echo "PASS: Hub PID untracking is idempotent for an empty exact-owner set"
if [ "${CLOUDBENCH_TEST_PENDING_HUB_SELF_TEST:-0}" = "1" ]; then
    exit 0
fi

if [ "${CLOUDBENCH_TEST_DISPOSABLE_ONLY:-0}" = 1 ]; then
    assert_disposable_only_warm() {
        python3 - "$FAKE_DIR" <<'PYDISPOSABLE'
import json,sys
from pathlib import Path
root=Path(sys.argv[1]);state=json.loads((root/'state.json').read_text())
assert len(state['machines'])==1 and state['machines'][0]['id']=='aaaa0000000001',state['machines']
assert len(state['volumes'])==1 and state['volumes'][0]['id']=='vol_aaaa0001',state['volumes']
journal=(root/'journal.log').read_text()
assert 'machine clone ' in journal and 'machine destroy ' in journal and 'volumes destroy ' in journal,journal
assert 'machine destroy --force aaaa0000000001' not in journal and 'volumes destroy vol_aaaa0001' not in journal,journal
lines=journal.splitlines()
updates=[line for line in lines if line.startswith('volumes update ')]
assert updates and all('--scheduled-snapshots=false' in line and 'vol_aaaa0001' not in line for line in updates),updates
for line in lines:
    if line.startswith('machine update '):
        # Each clone disables scheduled backups before its first BOOT update.
        mid=line.split()[2]
        if mid=='aaaa0000000001':continue
        machine=json.loads((root/'machines'/mid/'provider-machine.json').read_text())
        vid=machine['config']['mounts'][0]['volume']
        assert any(x.startswith('volumes update '+vid+' ') for x in lines[:lines.index(line)]),(mid,vid,lines)
assert len(state['snapshots'])==1,state['snapshots']
PYDISPOSABLE
    }
    hub_stub "$HUB_PORT_A" "$WS_A/.context/fleet/runs" || fail "disposable Hub A"
    hub_stub "$HUB_PORT_B" "$WS_B/.context/fleet/runs" || fail "disposable Hub B"
    for ws in "$WS_A" "$WS_B"; do
        reset_fake_state
        : > "$FAKE_DIR/journal.log"; : > "$FAKE_DIR/desired-two"
        port="$CONDUCTOR_PORT_A";[ "$ws" != "$WS_B" ] || port="$CONDUCTOR_PORT_B"
        status=0
        CLOUDBENCH_TEST_BARRIER_MIN=1 run_controller "$ws" "$port" "$TMP_ROOT/disposable-success-$(basename "$ws").log" autoscaler-worker-required --timeout 240 || status=$?
        [ "$status" = 0 ] || fail "disposable outer lifecycle failed:$status"
        assert_disposable_only_warm || fail "disposable primary/worker exact deletion"
        [ "$(grep -c '^machine clone ' "$FAKE_DIR/journal.log")" -ge 2 ] || fail "operational worker missing"
    done
    [ "$(git -C "$WS_A" rev-parse HEAD)" != "$(git -C "$WS_B" rev-parse HEAD)" ] || fail "two revision fixture not distinct"
    echo "PASS: two code revisions create/run/destroy primary+worker without retained fleets"
    reset_fake_state
    : > "$FAKE_DIR/journal.log"; : > "$FAKE_DIR/desired-two"; : > "$FAKE_DIR/fail-worker-launch"
    status=0
    CLOUDBENCH_TEST_BARRIER_MIN=1 CLOUDBENCH_WORKER_STAGE_ATTEMPTS=1 CLOUDBENCH_WORKER_READY_TIMEOUT=5 CLOUDBENCH_AUTOSCALER_FINALIZATION_WAIT_SECONDS=30 \
        run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/disposable-worker-failed.log" autoscaler-worker-required --timeout 240 || status=$?
    [ "$status" != 0 ] || fail "worker startup failure fabricated success"
    assert_disposable_only_warm || fail "failed startup resources retained"
    rm -f "$FAKE_DIR/fail-worker-launch"
    echo "PASS: worker startup failure retains failed outcome and deletes owned storage"
    reset_fake_state
    : > "$FAKE_DIR/journal.log"
    pid_file="$TMP_ROOT/disposable-cancel.pid"
    CLOUDBENCH_TEST_NEW_SESSION=1 CLOUDBENCH_TEST_BARRIER_MIN=1 CLOUDBENCH_TEST_SESSION_PID_FILE="$pid_file" \
        run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/disposable-cancel.log" bench-group-term --timeout 240 &
    launcher_pid=$!;PIDS+=("$launcher_pid");track_session_controller "$pid_file"
    deadline=$((SECONDS+180));marker=""
    while [ "$SECONDS" -lt "$deadline" ]; do
        marker="$(find "$FAKE_DIR/markers" -maxdepth 1 -name 'benchmark-executing-*' -type f -print -quit)"
        [ -z "$marker" ] || break
        kill -0 "$launcher_pid" 2>/dev/null || break
        sleep .2
    done
    [ -n "$marker" ] || fail "cancellation did not reach running task"
    fleet_pid="$(cat "$pid_file")";fleet_birth="$(cloudbench_pid_start_time "$fleet_pid")"
    cloudbench_pid_matches_start "$fleet_pid" "$fleet_birth" && [ "$(ps -o pgid= -p "$fleet_pid" | tr -d ' ')" = "$fleet_pid" ] || fail "cancel identity"
    kill -TERM -- "-$fleet_pid"
    status=0;wait "$launcher_pid" || status=$?;PIDS=();SESSION_CONTROLLERS=()
    [ "$status" != 0 ] || fail "cancel fabricated success"
    assert_disposable_only_warm || fail "cancelled resources retained"
    echo "PASS: actual outerCLI cancelled task disposes exact run Machines and Volumes"
    exit 0
fi

mandatory_metrics_failure_contract() {
reset_fake_state
: > "$FAKE_DIR/journal.log"
: > "$FAKE_DIR/fail-metrics-proxy"
: > "$FAKE_DIR/delay-status-proxy"
autoscale_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 CLOUDBENCH_AUTOSCALER_STARTUP_WAIT_SECONDS=4 \
    CLOUDBENCH_FAKE_FAIL_METRICS_PROXY=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-autoscaler-required.log" \
    autoscaler-must-start --timeout 240 || autoscale_status=$?
[ "$autoscale_status" -ne 0 ] ||
    fail "a fleet must fail when its mandatory autoscaler cannot attach"
grep -Eq "mandatory autoscaler (failed to start|startup timed out)" \
    "$TMP_ROOT/controller-autoscaler-required.log" ||
    fail "mandatory autoscaler startup failure must be explicit"
grep -Fq "1/1 isolated stacks reached the barrier (0 excluded as infra failures)" \
    "$TMP_ROOT/controller-autoscaler-required.log" ||
    fail "metrics failure fixture must first admit its healthy primary status channel"
autoscaler_out="$(find "$WS_A/.context/fleet/runs" -mindepth 2 -maxdepth 2 \
    -type d -name autoscaler-must-start)"
[ -f "$autoscaler_out/barrier.ready.observed" ] ||
    fail "metrics failure fixture must observe the genuine primary readiness marker"
grep -Fq "injected metrics data-plane failure" "$autoscaler_out/autoscaler-metrics-proxy.log" ||
    fail "mandatory autoscaler rejection must follow the intended metrics fault"
if grep -Fq "status data-plane proxy did not become ready" "$autoscaler_out/fleet-child.log"; then
    fail "metrics failure fixture may not fail at primary status admission"
fi
assert_and_reset_disposable_failed_benchmark autoscaler-must-start "$TMP_ROOT/controller-autoscaler-required.log" ||
    fail "autoscaler-must-start: missing runtime evidence must retain the failed result while retiring disposable resources"
rm -f "$FAKE_DIR/fail-metrics-proxy" "$FAKE_DIR/delay-status-proxy"
echo "PASS: scenario 2b — a fleet fails closed when mandatory autoscaling cannot attach"
}

readiness_retry_contract() {
# Allocation and launch do not prove queue readiness. While genuine work is
# pending, a replaceable failure must capture/reap its exact worker, then retry
# healthy capacity. A genuinely finished task cannot consume unused capacity.
for readiness_boundary in active-retry finished-unused; do
    reset_fake_state
    : > "$FAKE_DIR/journal.log"
    : > "$FAKE_DIR/desired-two"
    : > "$FAKE_DIR/worker-never-ready"
    if [ "$readiness_boundary" = active-retry ]; then
        : > "$FAKE_DIR/worker-readiness-retry"
    fi
    python3 - "$WS_A/.context/fleet/runs" > "$TMP_ROOT/readiness-outputs-$readiness_boundary.json" <<'PY_UNREADY_BEFORE'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
print(json.dumps(sorted(str(p.relative_to(root)) for p in root.glob("*/autoscaler-worker-never-ready"))))
PY_UNREADY_BEFORE
    autoscale_status=0
    CLOUDBENCH_TEST_BARRIER_MIN=1 CLOUDBENCH_WORKER_STAGE_ATTEMPTS=2 \
        CLOUDBENCH_WORKER_READY_TIMEOUT=5 \
        CLOUDBENCH_AUTOSCALER_FINALIZATION_WAIT_SECONDS=30 \
        run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-autoscaler-worker-never-ready-$readiness_boundary.log" \
        autoscaler-worker-never-ready --timeout 240 || autoscale_status=$?
    [ "$autoscale_status" -eq 0 ] ||
        fail "readiness $readiness_boundary must preserve completed task and exact worker retirement"
    grep -qF "1/1 passed" "$TMP_ROOT/controller-autoscaler-worker-never-ready-$readiness_boundary.log" ||
        fail "readiness $readiness_boundary did not preserve real task PASS"
    find "$FAKE_DIR/markers" -maxdepth 1 -name 'worker-launch-succeeded-*' -print -quit |
        grep -q . || fail "readiness $readiness_boundary never crossed the actual worker launch boundary"
    if [ "$readiness_boundary" = active-retry ]; then
        [ -f "$FAKE_DIR/markers/worker-readiness-retry-proven" ] ||
            fail "active readiness failure was not captured/reaped before healthy retry"
    else
        grep -qF "task finished before future worker demand was needed: 0/1 queue-ready" \
            "$TMP_ROOT/controller-autoscaler-worker-never-ready-$readiness_boundary.log" ||
            fail "a launched-but-unready worker must be reported as zero queue-ready capacity"
        if grep -qF "joined queue navi-agent-tasks-" "$TMP_ROOT/controller-autoscaler-worker-never-ready-$readiness_boundary.log"; then
            fail "a launched-but-unready worker was counted as queue-ready capacity"
        fi
    fi
    python3 - "$WS_A/.context/fleet/runs" "$readiness_boundary" "$TMP_ROOT/readiness-outputs-$readiness_boundary.json" <<'PY_UNREADY_CAPTURE' || fail "readiness worker was released without its captured runtime evidence"
import json, sys
from pathlib import Path
boundary = sys.argv[2]
root = Path(sys.argv[1])
before = set(json.loads(Path(sys.argv[3]).read_text()))
outputs = [p for p in root.glob("*/autoscaler-worker-never-ready") if str(p.relative_to(root)) not in before]
assert len(outputs) == 1
output = outputs[0]
if boundary == "finished-unused":
    assert not (output / "worker-ready.ids").exists() or not (output / "worker-ready.ids").read_text().strip()
launched = [p.name[len("worker-"):-len(".launch-attempted")] for p in output.glob("worker-*.launch-attempted")]
assert launched
for machine_id in launched:
    capture = output / "worker-runtime-evidence" / machine_id / "capture"
    terminal = json.loads((capture / "receipts/terminal.json").read_text())
    assert terminal["machine_id"] == machine_id
    if boundary == "finished-unused":
        assert terminal["worker_started"] is False
    assert terminal["quiescent"] and terminal["children_reaped"] and terminal["streams_closed"]
PY_UNREADY_CAPTURE
    remaining="$(python3 -c '
import json, sys
machines = json.load(open(sys.argv[1]))["machines"]
print(" ".join(sorted(m["name"] for m in machines)))
' "$FAKE_DIR/state.json")"
    [ "$remaining" = "cloudbench-warm" ] ||
        fail "readiness $readiness_boundary teardown leaked machines: $remaining"
    if find "$SANDBOX/.git/cloudbench-fleet-ownership" -path '*/clones/*' -type f -print -quit 2>/dev/null | grep -q .; then
        fail "readiness $readiness_boundary teardown retained a durable clone record"
    fi
    rm -f "$FAKE_DIR/desired-two" "$FAKE_DIR/worker-never-ready" "$FAKE_DIR/worker-readiness-retry"
done
echo "PASS: scenario 2e — active readiness failure retries healthy capacity; finished tasks retire unused capacity"

}

if [ "${CLOUDBENCH_TEST_EXACT_RECOVERY_ORDER_ONLY:-0}" != "1" ] \
    && [ "${CLOUDBENCH_TEST_GROUP_TERM_ONLY:-0}" != "1" ]; then
hub_stub "$HUB_PORT_A" "$WS_A/.context/fleet/runs" \
    "${CLOUDBENCH_TEST_ORIGINAL_HUB_TOKEN:-00000000000000000000000000000001}" \
    || fail "workstream A test Hub failed its pending-owner launch handshake"
hub_stub "$HUB_PORT_B" "$WS_B/.context/fleet/runs" \
    || fail "workstream B test Hub failed its pending-owner launch handshake"
for port in "$HUB_PORT_A" "$HUB_PORT_B"; do
    for _ in $(seq 1 50); do
        curl -fsS "http://127.0.0.1:$port/" 2>/dev/null | grep -q "Benchmark runs" && break
        sleep 0.1
    done
done

if [ "${CLOUDBENCH_TEST_MANDATORY_METRICS_ONLY:-0}" = "1" ]; then
    mandatory_metrics_failure_contract
    exit 0
fi

if [ "${CLOUDBENCH_TEST_READINESS_RETRY_ONLY:-0}" = "1" ]; then
    readiness_retry_contract
    exit 0
fi

# A numeric PID is never hub ownership. Both a reused PID (birth mismatch) and
# an exact live hub belonging to another workspace must be refused without
# signaling the process.
hub_owner_a="$(find "$WS_A/.context/fleet/runs/_hub" -maxdepth 1 \
    -name "agent-link-server.$HUB_PORT_A.*.owner" -type f -print | head -1)"
[ -n "$hub_owner_a" ] || fail "hub stub must publish an exact owner record"
cloudbench_central_hub_owner_matches "$HUB_PORT_A" \
    "$WS_A/.context/fleet/runs" "$WS_A" "$hub_owner_a" \
    || fail "exact hub owner record must validate"
hub_a_pid="$(cloudbench_tracked_owner_value "$hub_owner_a" pid)"
if cloudbench_terminate_central_hub_owner "$HUB_PORT_A" \
    "$WS_B/.context/fleet/runs" "$WS_B" "$hub_owner_a" 1 >/dev/null 2>&1; then
    fail "hub termination must refuse a foreign workspace root"
fi
kill -0 "$hub_a_pid" 2>/dev/null \
    || fail "foreign-root hub refusal must leave the live owner untouched"
cp "$hub_owner_a" "$hub_owner_a.saved"
chmod u+w "$hub_owner_a"
python3 - "$hub_owner_a" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text(path.read_text().replace(
    next(line for line in path.read_text().splitlines() if line.startswith("pid_start=")),
    "pid_start=Mon Jan 1 00:00:00 2001",
))
PY
chmod a-w "$hub_owner_a"
if cloudbench_terminate_central_hub_owner "$HUB_PORT_A" \
    "$WS_A/.context/fleet/runs" "$WS_A" "$hub_owner_a" 1 >/dev/null 2>&1; then
    fail "hub termination must refuse a reused numeric PID with the wrong birth"
fi
kill -0 "$hub_a_pid" 2>/dev/null \
    || fail "PID-reuse hub refusal must leave the live owner untouched"
mv -f "$hub_owner_a.saved" "$hub_owner_a"
chmod a-w "$hub_owner_a"

stale_hub_replacement_finalize_contract "$hub_owner_a"
if [ "${CLOUDBENCH_TEST_STALE_HUB_REPLACEMENT_SELF_TEST:-0}" = "1" ]; then
    exit 0
fi

if [ "${CLOUDBENCH_TEST_RESET_HUB_SELF_TEST:-0}" = "1" ]; then
    old_hub_pid="$hub_a_pid"
    old_hub_pid_start="$(cloudbench_tracked_owner_value "$hub_owner_a" pid_start)"
    old_hub_token="$(cloudbench_tracked_owner_value "$hub_owner_a" owner_token)"
    reset_test_workspace_fleet_roots "$WS_A"
    ! cloudbench_pid_matches_start "$old_hub_pid" "$old_hub_pid_start" \
        || fail "workspace reset left the old exact Hub PID alive"
    [ ! -e "$hub_owner_a" ] || fail "workspace reset retained the old Hub owner record"
    assert_test_hub_accepts_required_upload \
        "$WS_A" "$HUB_PORT_A" reset-hub-contract
    replacement_hub_owner="$(find "$WS_A/.context/fleet/runs/_hub" -maxdepth 1 \
        -name "agent-link-server.$HUB_PORT_A.*.owner" -type f -print -quit)"
    [ "$(cloudbench_tracked_owner_value "$replacement_hub_owner" owner_token)" \
        != "$old_hub_token" ] \
        || fail "workspace reset reused the retired Hub owner token"
    echo "PASS: workspace reset exact-cleans the old Hub and tracks a POST-capable replacement"
    exit 0
fi

# The uploader imports dependency-bearing helpers before its first HTTP call.
# Its failure must still run the controller's exact-owner finalizer, and the
# uploader must use the project's interpreter even when PATH selects another.
startup_visibility_failure_contract() {
    local token log status=0 audit run_id failed=0 real_python marker sentinel hub_owner
    token="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
    log="$TMP_ROOT/controller-startup-visibility.log"
    marker="$TMP_ROOT/project-python-hub-upload"
    sentinel="$SANDBOX/.git/cloudbench-fleet-ownership/startup-unrelated-owner"
    mkdir -p "$sentinel"
    printf 'unrelated-owner-must-survive\n' > "$sentinel/sentinel"
    real_python="$(command -v python3)"
    mkdir -p "$WS_A/agents/venv/bin"
    cat > "$WS_A/agents/venv/bin/python3" <<SH
#!/usr/bin/env bash
case "\${1:-}" in */hub_upload.py) : > "$marker" ;; esac
exec "$real_python" "\$@"
SH
    chmod +x "$WS_A/agents/venv/bin/python3"
    ln -s python3 "$WS_A/agents/venv/bin/python"
    cp "$WS_A/agents/benchmarks/logs.py" "$TMP_ROOT/startup-logs.py.saved"
    printf 'import missing_startup_visibility_dependency\n' > "$WS_A/agents/benchmarks/logs.py"
    : > "$FAKE_DIR/journal.log"
    CLOUDBENCH_TEST_FLEET_OWNER_TOKEN="$token" \
        run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$log" \
        bench-alpha --timeout 240 || status=$?
    mv "$TMP_ROOT/startup-logs.py.saved" "$WS_A/agents/benchmarks/logs.py"
    rm -rf "$WS_A/agents/venv"
    [ "$status" -ne 0 ] || fail "startup visibility failure was reported successful"
    grep -Fq "No module named 'missing_startup_visibility_dependency'" "$log" \
        || fail "startup visibility repro did not reach the captured import boundary"
    if [ ! -f "$marker" ]; then
        echo "FAIL: Hub upload bypassed the project Python interpreter" >&2
        failed=1
    fi
    if grep -qE '^(machine (clone|start|stop|destroy|update)|volumes? (create|fork|destroy))' \
        "$FAKE_DIR/journal.log"; then
        fail "startup visibility failure allowed provider mutation"
    fi
    [ "$(cat "$sentinel/sentinel")" = unrelated-owner-must-survive ] \
        || fail "startup failure disturbed an unrelated ownership record"
    rm -rf "$sentinel"
    audit="$SANDBOX/.git/cloudbench-fleet-audits/$token"
    run_id="$(cloudbench_tracked_owner_value "$audit/meta" run_id)"
    if [ "$(cloudbench_tracked_owner_value "$audit/meta" status)" != provider-teardown-verified ] \
        || [ ! -s "$WS_A/.context/fleet/runs/$run_id/teardown-ownership/source-audit" ] \
        || [ -e "$SANDBOX/.git/cloudbench-fleet-ownership/$token" ] \
        || [ -L "$SANDBOX/.git/cloudbench-fleet-ownership/$token" ]; then
        echo "FAIL: startup visibility failure stranded incomplete ownership" >&2
        failed=1
    fi
    [ "$failed" -eq 0 ] || fail "startup visibility failure contract failed"
    [ "$(cloudbench_tracked_owner_value "$audit/meta" hub_disposition)" \
        = retained-exact-owner-transfer-required ] \
        || fail "startup cleanup lost the intentional retained Hub disposition"
    hub_owner="$(cloudbench_tracked_owner_value "$audit/meta" hub_owner_file)"
    cloudbench_central_hub_owner_matches "$HUB_PORT_A" \
        "$WS_A/.context/fleet/runs" "$WS_A" "$hub_owner" \
        || fail "startup cleanup did not preserve the exact live Hub owner"
    python3 - "$WS_A/.context/fleet/runs/$run_id/_batch/lifecycle.json" <<'PY'
import json
import sys
from pathlib import Path
payload = json.loads(Path(sys.argv[1]).read_text())
assert payload["status"] == "failed", payload
assert payload["controller_exit_code"] != 0, payload
PY
    [ "$?" -eq 0 ] || fail "startup failure lifecycle was not preserved"
    # --retry-infra admits a fresh attempt only for a released INFRA row. A
    # startup exit before provisioning must still close the frozen bench's
    # E2E clock at the verified audit release, without inventing execution.
    python3 - "$WS_A/.context/fleet/runs/$run_id" "$audit" <<'PY'
import json
import sys
from pathlib import Path
run, audit = map(Path, sys.argv[1:3])
task = run / "bench-alpha"
release = (audit / "provider-teardown-verified.epoch").read_text()
assert (task / "bench-e2e.finished-epoch").read_text() == release, "startup INFRA never released"
assert 0 < int((task / "bench-e2e.started-epoch").read_text()) <= int(release)
assert not (task / ".cid").exists() and not (task / "cloudbench-run.json").exists()
rows = json.loads((run / "_batch/run.json").read_text())["tasks"]
assert [(row["name"], row["status"], row["passed"], row["lifecycle_stage"]) for row in rows] == [
    ("bench-alpha", "INFRA_ERROR", False, "released")
], rows
PY
    [ "$?" -eq 0 ] || fail "pre-provisioning startup INFRA was not released for a fresh attempt"
    assert_no_controller_script_snapshots "startup visibility failure"
    echo "PASS: project Python and exact teardown survive pre-allocation Hub import failure"
}
startup_visibility_failure_contract
if [ "${CLOUDBENCH_TEST_STARTUP_FAILURE_ONLY:-0}" = "1" ]; then
    exit 0
fi

run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-run-a.log" bench-alpha --timeout 240 &
PID_A=$!
PIDS+=("$PID_A")
run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-run-b.log" bench-beta --timeout 240 &
PID_B=$!
PIDS+=("$PID_B")

status_a=0; wait "$PID_A" || status_a=$?
status_b=0; wait "$PID_B" || status_b=$?
# The controllers are reaped. Hubs have a separate exact-owner cleanup path, so
# a rapidly reused raw Hub PID can never be signaled.
PIDS=()

[ "$status_a" -eq 0 ] || fail "workstream A's benchmark run must FINISH WITH SUCCESS alongside a concurrent run (exit=$status_a)"
[ "$status_b" -eq 0 ] || fail "workstream B's benchmark run must FINISH WITH SUCCESS alongside a concurrent run (exit=$status_b)"
assert_no_controller_script_snapshots "foreground terminal cleanup"
grep -qF "1/1 passed" "$TMP_ROOT/controller-run-a.log" ||
    fail "workstream A's fleet summary must report 1/1 passed"
grep -qF "1/1 passed" "$TMP_ROOT/controller-run-b.log" ||
    fail "workstream B's fleet summary must report 1/1 passed"
grep -qF "per-bench autoscaler ON (mandatory prod params" "$TMP_ROOT/controller-run-a.log" ||
    fail "workstream A must launch its mandatory per-bench autoscaler"
grep -qF "per-bench autoscaler ON (mandatory prod params" "$TMP_ROOT/controller-run-b.log" ||
    fail "workstream B must launch its mandatory per-bench autoscaler"

# Each workstream's run record must exist, be PASSED, fetch the advertised base,
# and carry ITS OWN unpushed content in the injected patch.
check_run_record() {  # check_run_record <ws> <bench> <expected-ref> <workspace-marker>
    local ws="$1" bench="$2" expected_ref="$3" workspace_marker="$4" record
    record="$(find "$ws/.context/fleet/runs" -path "*/$bench/cloudbench-run.json" -type f -print 2>/dev/null | head -1)"
    [ -n "$record" ] || fail "$bench: run record was not retrieved"
    RECORD="$record" BENCH="$bench" EXPECTED_REF="$expected_ref" WORKSPACE_MARKER="$workspace_marker" python3 - <<'PY'
import json, os, sys
from pathlib import Path
record = json.load(open(os.environ["RECORD"]))
task = (record.get("tasks") or [{}])[0]
expected = json.loads((Path(os.environ["RECORD"]).parents[1] / "execution-provenance.json").read_text())
if task.get("name") != os.environ["BENCH"]:
    sys.exit(f"run record task name mismatch: {task.get('name')!r}")
if not task.get("passed"):
    sys.exit("run record task did not pass")
if record.get("code_ref") != os.environ["EXPECTED_REF"]:
    sys.exit(
        f"run executed the wrong code snapshot: {record.get('code_ref')!r} "
        f"!= {os.environ['EXPECTED_REF']!r}"
    )
if record.get("workspace_marker") != os.environ["WORKSPACE_MARKER"]:
    sys.exit(
        f"run omitted the unpushed workspace patch: {record.get('workspace_marker')!r} "
        f"!= {os.environ['WORKSPACE_MARKER']!r}"
    )
if record.get("execution_provenance") != expected:
    sys.exit("run record omitted or changed the exact staged execution provenance")
if task.get("execution_provenance") != expected:
    sys.exit("run task omitted or changed the exact staged execution provenance")
PY
}
check_run_record "$WS_A" bench-alpha "$BASE_REF" workstream-a || fail "workstream A's run record is wrong"
check_run_record "$WS_B" bench-beta "$BASE_REF" workstream-b || fail "workstream B's run record is wrong"

# Normal cleanup removes the live recovery registry only after Fly proves every
# exact machine and volume absent.  The lane still needs an immutable audit
# record of what it owned and the postcondition that retired that recovery
# authority; otherwise a successful run cannot later prove exact teardown.
check_terminal_fresh_ownership_manifest() {  # <workspace> <bench>
    local ws="$1" bench="$2" run_dir fleet_run_dir owned_file records_dir
    local owned_count record_count manifest_hub_owner
    run_dir="$(find "$ws/.context/fleet/runs" -path "*/$bench/.cid" -type f -print 2>/dev/null \
        | head -1 | xargs dirname)"
    [ -n "$run_dir" ] || fail "$bench: no durable fleet run directory"
    fleet_run_dir="${run_dir%/$bench}"
    owned_file="$fleet_run_dir/teardown-ownership/owned-clones.ids"
    records_dir="$fleet_run_dir/teardown-ownership/fresh"
    [ -s "$owned_file" ] || fail "$bench: normal cleanup discarded owned-clones.ids"
    owned_count="$(sort -u "$owned_file" | grep -Ec '^[0-9a-f]+$' || true)"
    record_count="$(find "$records_dir" -type f -maxdepth 1 -print 2>/dev/null | wc -l | tr -d ' ')"
    [ "$owned_count" -ge 1 ] || fail "$bench: durable owned-clones ledger has no exact machine ID"
    [ "$record_count" -ge "$owned_count" ] || fail "$bench: durable teardown manifest omitted a fresh clone"
    python3 - "$records_dir" "$owned_file" <<'PY' || fail "$bench: durable teardown manifest is incomplete"
from pathlib import Path
import sys

root = Path(sys.argv[1])
owned = {line.strip() for line in Path(sys.argv[2]).read_text().splitlines() if line.strip()}
seen = set()
for path in root.iterdir():
    fields = {}
    for raw in path.read_text().splitlines():
        key, sep, value = raw.partition("=")
        if sep:
            fields[key] = value
    required = {
        "version", "fleet_owner_token", "run_id", "app", "clone_name",
        "source", "machine_id", "volume_id", "disposition",
    }
    if not required.issubset(fields):
        raise SystemExit(f"missing fields in {path}: {sorted(required - fields.keys())}")
    if fields["source"] != "fresh-clone" or not fields["volume_id"].startswith("vol_"):
        raise SystemExit(f"bad source/volume semantics in {path}")
    if fields["disposition"] not in {
        "destroyed-verified-absent", "destroyed-provider-retained",
    }:
        raise SystemExit(f"unterminated final disposition in {path}: {fields['disposition']}")
    seen.add(fields["machine_id"])
if not owned.issubset(seen):
    raise SystemExit(f"owned IDs omitted from manifest: {sorted(owned - seen)}")
PY
    [ "$(sed -n 's/^status=//p' "$fleet_run_dir/teardown-ownership/meta")" \
        = "provider-teardown-verified" ] \
        || fail "$bench: provider teardown did not finalize independently of result"
    [ "$(sed -n 's/^hub_disposition=//p' "$fleet_run_dir/teardown-ownership/meta")" \
        = "retained-exact-owner-transfer-required" ] \
        || fail "$bench: final manifest omitted exact hub transfer"
    [ -f "$fleet_run_dir/teardown-ownership/source-audit" ] \
        || fail "$bench: terminal teardown evidence is not bound to its recovery audit"
    manifest_hub_owner="$(sed -n 's/^hub_owner_file=//p' \
        "$fleet_run_dir/teardown-ownership/meta")"
    cloudbench_central_hub_owner_matches \
        "$(sed -n 's/^port=//p' "$manifest_hub_owner")" \
        "$ws/.context/fleet/runs" "$ws" "$manifest_hub_owner" \
        || fail "$bench: final manifest points at an invalid hub owner"
}
check_terminal_fresh_ownership_manifest "$WS_A" bench-alpha
check_terminal_fresh_ownership_manifest "$WS_B" bench-beta

# Both real collectors must retain the exact complete guest filesystem and bind
# it to their separate canonical run records before their fleet volumes retire.
python3 - "$WS_A" bench-alpha "$WS_B" bench-beta <<'PY_RUNTIME' || fail "concurrent runtime capture is incomplete or borrowed"
import hashlib
import json
from pathlib import Path
import sys
owners = []
for workspace, bench in zip(sys.argv[1::2], sys.argv[2::2]):
    outputs = list((Path(workspace) / ".context/fleet/runs").glob(f"*/{bench}/cloudbench-run.json"))
    assert len(outputs) == 1
    output = outputs[0].parent
    owner = json.loads((output / "runtime-evidence.owner.json").read_text())
    capture = output / "remote-logs/runtime-evidence"
    manifest = json.loads((capture / "manifest.json").read_text())
    assert owner == {key: manifest[key] for key in ("version", "run_token", "machine_id")}
    assert not (output / "runtime-evidence.pending").exists()
    assert json.loads((capture / "run.json").read_text()) == json.loads(outputs[0].read_text())
    token, machine = owner["run_token"], owner["machine_id"]
    assert set(manifest["files"]) == {"services.json", "run.json", "stack.log", f"cloudbench-stack-cleanup-{token}.status", "logs/backend.log", "logs/worker.log", "logs/worker.1.log"}
    for name, record in manifest["files"].items():
        data = (capture / name).read_bytes()
        assert len(data) == record["bytes"] and hashlib.sha256(data).hexdigest() == record["sha256"]
    for name in ("backend.log", "worker.log", "worker.1.log"):
        assert (capture / "logs" / name).read_text() == f"fake runtime {name} token={token} machine={machine}\n"
    owners.append(owner)
assert owners[0]["run_token"] != owners[1]["run_token"] and owners[0]["machine_id"] != owners[1]["machine_id"]
PY_RUNTIME

# Per-workspace hubs must not collide: each fleet adopted its own derived port.
grep -qF "already open on :$HUB_PORT_A" "$TMP_ROOT/controller-run-a.log" ||
    fail "workstream A must use its CONDUCTOR_PORT-derived hub port ($HUB_PORT_A)"
grep -qF "already open on :$HUB_PORT_B" "$TMP_ROOT/controller-run-b.log" ||
    fail "workstream B must use its CONDUCTOR_PORT-derived hub port ($HUB_PORT_B)"

# Teardown isolation: each fleet reaped ONLY its own clone — the shared warm
# source is all that survives.
remaining="$(python3 -c '
import json, sys
machines = json.load(open(sys.argv[1]))["machines"]
print(" ".join(sorted(m["name"] for m in machines)))
' "$FAKE_DIR/state.json")"
[ "$remaining" = "cloudbench-warm" ] ||
    fail "concurrent fleets must tear down exactly their own machines (left: $remaining)"

journal_must_be_read_only "scenario 2"
[ ! -e "$SANDBOX/.git/cloudbench-app-env.lock" ] ||
    fail "no shared app-environment lock file may survive a concurrent run"

echo "PASS: scenario 2 — two concurrent workstream runs FINISHED WITH SUCCESS on distinct code snapshots"
if [ "${CLOUDBENCH_TEST_CONCURRENT_RUN_SELF_TEST:-0}" = "1" ]; then
    exit 0
fi

# Default fleet invocation must survive the disposable launcher that started it,
# reach terminal aggregation, and clean every exact paid resource. This drives
# run-bench-fleet itself (not only cloudbench_detach_reexec) through the fake
# provider while the launching shell returns immediately.
reset_fake_state
rm -f "$POOL_A" "$POOL_B"
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
detached_launcher_log="$TMP_ROOT/controller-default-detach-launcher.log"
detached_launcher_status=0
CLOUDBENCH_TEST_DEFAULT_DETACH=1 CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$detached_launcher_log" \
    bench-default-detach --timeout 240 || detached_launcher_status=$?
[ "$detached_launcher_status" -eq 0 ] ||
    fail "default-detach launcher must return successfully (exit=$detached_launcher_status)"
grep -qF "fleet controller detached" "$detached_launcher_log" ||
    fail "default fleet invocation did not detach from its launcher"
detached_log="$(sed -n 's/^    log: tail -f //p' "$detached_launcher_log" | tail -1)"
[ -n "$detached_log" ] ||
    fail "default-detach launcher did not publish its controller log"
detached_status_marker="$(sed -n 's/^    controller exit marker: \(.*\) (check on every poll, even if logs stop growing)$/\1/p' "$detached_launcher_log" | tail -1)"
[ "$detached_status_marker" = "${detached_log%.log}.status" ] ||
    fail "default-detach launcher did not publish its exact status marker"

# Capture the exact controller while it is still live so EXIT cleanup can stop
# it if this regression itself aborts early.
detached_pid=""
for _ in $(seq 1 100); do
    detached_meta="$(find "$SANDBOX/.git/cloudbench-fleet-ownership" -name meta -type f -print -quit 2>/dev/null || true)"
    if [ -n "$detached_meta" ]; then
        detached_pid="$(sed -n 's/^pid=//p' "$detached_meta" | head -1)"
        [ -n "$detached_pid" ] && break
    fi
    sleep 0.1
done
[ -n "$detached_pid" ] || fail "detached fleet never published durable controller ownership"
PIDS+=("$detached_pid")

for _ in $(seq 1 600); do
    if grep -qF "1/1 passed" "$detached_log" 2>/dev/null \
        && ! kill -0 "$detached_pid" 2>/dev/null; then
        break
    fi
    # A terminal failure can never publish the success marker. Surface its log
    # immediately instead of spending the whole 300-second success budget.
    if ! kill -0 "$detached_pid" 2>/dev/null; then
        break
    fi
    sleep 0.5
done
grep -qF "1/1 passed" "$detached_log" ||
    fail "detached fleet did not reach terminal aggregation"
if kill -0 "$detached_pid" 2>/dev/null; then
    fail "detached fleet controller did not exit after terminal cleanup"
fi
# fe66798fe: the operator's --timeout 240 is the task execution window, so it
# also bounds the guest backstop across the detach re-exec; the task's 9000s
# catalog timeout may extend neither.
if grep -qF "[bench-default-detach] catalog timeout 9000s" "$detached_log"; then
    fail "detached fleet let the catalog timeout extend an explicit --timeout"
fi
grep -qF "BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=240" "$FAKE_DIR/journal.log" ||
    fail "detached fleet did not hand the explicit --timeout to the guest backstop"
if grep -qE "BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=(9000|7200)( |$)" "$FAKE_DIR/journal.log"; then
    fail "detached fleet handed the guest a backstop beyond the explicit --timeout"
fi
# The same production budget functions: without --timeout the catalog task's
# 9000s extends both default budgets; an explicit backstop stays separate.
fleet_budget_contract() (
    eval "$(fleet_production_function apply_operator_timeout_backstop)"
    eval "$(fleet_production_function bench_execution_budget)"
    budgets() {  # <run-timeout> <run-set> <backstop> <backstop-set>
        RUN_TIMEOUT="$1" RUN_TIMEOUT_OPERATOR_SET="$2"
        BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS="$3" BACKSTOP_OPERATOR_SET="$4"
        apply_operator_timeout_backstop
        printf '%s %s\n' "$(bench_execution_budget 9000 "$RUN_TIMEOUT" "$RUN_TIMEOUT_OPERATOR_SET")" \
            "$(bench_execution_budget 9000 "$BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS" "$BACKSTOP_OPERATOR_SET")"
    }
    [ "$(budgets 7200 0 7200 0)" = "9000 9000" ] || { echo "no --timeout: $(budgets 7200 0 7200 0)" >&2; exit 1; }
    [ "$(budgets 240 1 7200 0)" = "240 240" ] || { echo "--timeout 240: $(budgets 240 1 7200 0)" >&2; exit 1; }
    [ "$(budgets 240 1 600 1)" = "240 600" ] || { echo "explicit backstop: $(budgets 240 1 600 1)" >&2; exit 1; }
)
fleet_budget_contract || fail "fleet execution budgets must follow the catalog and operator timeout contract"
# The detached PID has been reaped. Hubs remain isolated behind immutable
# owner records and never enter the raw controller-PID cleanup list.
PIDS=()
check_run_record "$WS_A" bench-default-detach "$BASE_REF" workstream-a ||
    fail "default-detached fleet's run record is wrong"

read -r detached_machines detached_volumes < <(
    python3 - "$FAKE_DIR/state.json" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
machines = ",".join(sorted(item["name"] for item in state["machines"]))
volumes = ",".join(sorted(item["id"] for item in state["volumes"]))
print(machines, volumes)
PY
)
[ "$detached_machines" = "cloudbench-warm" ] ||
    fail "default-detached fleet leaked machines: $detached_machines"
[ "$detached_volumes" = "vol_aaaa0001" ] ||
    fail "default-detached fleet leaked volumes: $detached_volumes"
if find "$SANDBOX/.git/cloudbench-fleet-ownership" -type f -print -quit 2>/dev/null | grep -q .; then
    fail "default-detached fleet left durable ownership records after cleanup"
fi
# The exit marker remains as the controller's exact exit status for
# `run-bench monitor --controller-status`, independently of launcher waiting.
for _ in $(seq 1 50); do
    [ -s "$detached_status_marker" ] && break
    sleep 0.1
done
[ "$(head -1 "$detached_status_marker" 2>/dev/null)" = "0" ] ||
    fail "default-detached controller exit marker did not record exit 0: $detached_status_marker"
assert_no_controller_script_snapshots "default-detached terminal cleanup"
[ "$(cat "$detached_status_marker" 2>/dev/null)" = "0" ] ||
    fail "default-detached fleet did not retain its successful terminal monitor status"
echo "PASS: scenario 2-detach — disposable launcher returned; detached fleet completed and cleaned every owned resource"

# Hub/predeploy supervisors need the same session durability without giving up
# synchronous snapshots, final upload, or exact exit status. --wait must block
# the caller on the detached controller's atomic status marker, not move the
# paid fleet back into the vulnerable launcher session.
reset_fake_state
rm -f "$POOL_A" "$POOL_B"
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
wait_launcher_log="$TMP_ROOT/controller-detached-wait-launcher.log"
wait_status=0
CLOUDBENCH_TEST_DEFAULT_DETACH=1 CLOUDBENCH_TEST_BARRIER_MIN=1 \
    CLOUDBENCH_SNAPSHOT_POLL_SECONDS=30 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$wait_launcher_log" \
    bench-detached-wait --timeout 240 --wait || wait_status=$?
[ "$wait_status" -eq 0 ] ||
    fail "detached wait rendezvous must return the fleet's success (exit=$wait_status)"
grep -qF "waiting for detached fleet completion" "$wait_launcher_log" ||
    fail "--wait did not retain synchronous supervision"
grep -qF "detached fleet completed (exit=0)" "$wait_launcher_log" ||
    fail "--wait did not return the detached controller's exact exit status"
wait_detached_log="$(sed -n 's/^    log: tail -f //p' "$wait_launcher_log" | tail -1)"
[ -n "$wait_detached_log" ] && grep -qF "1/1 passed" "$wait_detached_log" ||
    fail "detached wait controller did not reach terminal aggregation"
wait_status_marker="$(sed -n 's/^    controller exit marker: \(.*\) (check on every poll, even if logs stop growing)$/\1/p' "$wait_launcher_log" | tail -1)"
[ "$wait_status_marker" = "${wait_detached_log%.log}.status" ] ||
    fail "detached wait launcher did not publish its exact status marker"
check_run_record "$WS_A" bench-detached-wait "$BASE_REF" workstream-a ||
    fail "detached wait fleet's run record is wrong"
read -r wait_machines wait_volumes < <(
    python3 - "$FAKE_DIR/state.json" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
machines = ",".join(sorted(item["name"] for item in state["machines"]))
volumes = ",".join(sorted(item["id"] for item in state["volumes"]))
print(machines, volumes)
PY
)
[ "$wait_machines" = "cloudbench-warm" ] ||
    fail "detached wait fleet leaked machines: $wait_machines"
[ "$wait_volumes" = "vol_aaaa0001" ] ||
    fail "detached wait fleet leaked volumes: $wait_volumes"
if find "$SANDBOX/.git/cloudbench-fleet-ownership" -type f -print -quit 2>/dev/null | grep -q .; then
    fail "detached wait fleet left durable ownership records after cleanup"
fi
[ "$wait_status_marker" != "$detached_status_marker" ] ||
    fail "detached wait launch reused the earlier controller exit marker"
[ "$(cat "$wait_status_marker" 2>/dev/null)" = "0" ] ||
    fail "detached wait fleet did not retain its exact successful terminal monitor status"
[ ! -e "${wait_status_marker%.status}.owner" ] ||
    fail "detached wait fleet left its live ownership rendezvous"
[ "$(cat "$detached_status_marker" 2>/dev/null)" = "0" ] ||
    fail "detached wait cleanup consumed an earlier fleet's terminal monitor status"
assert_no_controller_script_snapshots "detached-wait terminal cleanup"
echo "PASS: scenario 2-wait — detached controller preserved synchronous status and cleaned every owned resource"

# Invalid recovery configuration must fail before the detached controller is
# spawned. Otherwise the launcher returns while a paid fleet continues with no
# valid bounded recovery contract.
invalid_recovery_log="$TMP_ROOT/controller-invalid-detached-recovery.log"
invalid_recovery_status=0
CLOUDBENCH_TEST_DEFAULT_DETACH=1 CLOUDBENCH_DETACHED_RECOVERY_SECONDS=invalid \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$invalid_recovery_log" \
    bench-invalid-recovery --timeout 240 --wait || invalid_recovery_status=$?
[ "$invalid_recovery_status" -eq 2 ] ||
    fail "invalid detached recovery configuration must fail with usage status 2"
grep -qF "CLOUDBENCH_DETACHED_RECOVERY_SECONDS must be a positive integer" \
    "$invalid_recovery_log" ||
    fail "invalid detached recovery configuration did not report its pre-spawn rejection"
read -r invalid_machines invalid_volumes < <(
    python3 - "$FAKE_DIR/state.json" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
print(
    ",".join(sorted(item["name"] for item in state["machines"])),
    ",".join(sorted(item["id"] for item in state["volumes"])),
)
PY
)
[ "$invalid_machines" = "cloudbench-warm" ] \
    && [ "$invalid_volumes" = "vol_aaaa0001" ] ||
    fail "invalid recovery configuration crossed the paid provider boundary"
if find "$SANDBOX/.git/cloudbench-fleet-ownership" -type f -print -quit 2>/dev/null | grep -q .; then
    fail "invalid recovery configuration spawned a durable fleet owner"
fi
assert_no_controller_script_snapshots "pre-detach configuration rejection"
echo "PASS: scenario 2-wait-config — invalid recovery timeout fails before detach or allocation"
fi

if [ "${CLOUDBENCH_TEST_EXACT_RECOVERY_ORDER_ONLY:-0}" = "1" ] \
    || [ "${CLOUDBENCH_TEST_GROUP_TERM_ONLY:-0}" = "1" ]; then
    hub_stub "$HUB_PORT_A" "$WS_A/.context/fleet/runs" \
        "${CLOUDBENCH_TEST_ORIGINAL_HUB_TOKEN:-00000000000000000000000000000001}" \
        || fail "focused exact-recovery test Hub failed its pending-owner launch handshake"
fi

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 2-group-term — cancelling a fleet's whole process group must stop
# its executing guest
# ═════════════════════════════════════════════════════════════════════════════
# run-bench-campaign.py cancels each fleet with os.killpg(SIGTERM). A terminal
# Ctrl-C (INT) and the detached --wait forwarder signal the whole controller
# group the same way, so every per-bench supervisor receives the signal
# alongside the controller. The runner itself starts with SIGINT ignored, so
# its supervisor must deliver every cancellation as TERM for the runner's own
# EXIT cleanup to deliver the stop. Each guest below is mid-benchmark and stops
# only after its authenticated /shutdown arrives over a live data-plane proxy,
# or after its exact Machine is stopped natively when that stop was never
# delivered (here through a throttled first stop request). The owner, the
# original volume and the evidence latches must be retained, and nothing may be
# destroyed on the unconfirmed path.
group_term_cancellation_contract() {  # <bench> <expected-stop-reason> [TERM|INT]
    local bench="$1" expected_reason="$2" signal_name="${3:-TERM}" log launcher_pid registry="" candidate
    local machine="" volume="" marker="" deadline fleet_pid fleet_pid_start fleet_pgid
    local term_epoch stop_file driver_pid launcher_status=0 output pid machine_state
    local budget=$(( ${CLOUDBENCH_CHILD_TERM_SECONDS:-30} + 15 ))
    local -a remaining_pids=()
    log="$TMP_ROOT/controller-$bench-$signal_name.log"
    reset_fake_state
    rm -f "$POOL_A" "$POOL_B"
    rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$FAKE_DIR/markers"
    rm -f "$FAKE_DIR/throttle-first-machine-stop"
    mkdir -p "$FAKE_DIR/markers"
    : > "$FAKE_DIR/journal.log"
    # A rate-limited or failing control plane rejects the first stop request;
    # the bounded native stop must retry it while the guest still executes.
    [ "$expected_reason" != native-stop ] || : > "$FAKE_DIR/throttle-first-machine-stop"
    rm -f "$TMP_ROOT/session-$bench-$signal_name.pid"
    CLOUDBENCH_TEST_NEW_SESSION=1 CLOUDBENCH_TEST_BARRIER_MIN=1 \
        CLOUDBENCH_TEST_SESSION_PID_FILE="$TMP_ROOT/session-$bench-$signal_name.pid" \
        run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$log" "$bench" --timeout 240 &
    launcher_pid=$!
    PIDS+=("$launcher_pid")
    track_session_controller "$TMP_ROOT/session-$bench-$signal_name.pid"
    deadline=$((SECONDS + 180))
    while [ "$SECONDS" -lt "$deadline" ]; do
        marker="$(find "$FAKE_DIR/markers" -maxdepth 1 -name 'benchmark-executing-*' \
            -type f -print -quit 2>/dev/null)"
        [ -z "$marker" ] || break
        kill -0 "$launcher_pid" 2>/dev/null || break
        sleep 0.5
    done
    [ -n "$marker" ] || fail "$bench: the guest never started executing its benchmark"
    machine="${marker##*/benchmark-executing-}"
    driver_pid="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["pid"])' "$marker")"
    for candidate in "$SANDBOX/.git/cloudbench-fleet-ownership"/*; do
        [ -f "$candidate/meta" ] || continue
        if grep -rqx "id=$machine" "$candidate/clones" 2>/dev/null; then
            registry="$candidate"
            volume="$(grep -rh '^volume_id=' "$candidate/clones" | head -1)"
            volume="${volume#volume_id=}"
        fi
    done
    [ -n "$registry" ] && [ -n "$volume" ] ||
        fail "$bench: the executing guest has no exact durable owner record"
    fleet_pid="$(sed -n 's/^pid=//p' "$registry/meta" | head -1)"
    fleet_pid_start="$(sed -n 's/^pid_start=//p' "$registry/meta" | head -1)"
    fleet_pgid="$(ps -o pgid= -p "$fleet_pid" 2>/dev/null | tr -d ' ')"
    cloudbench_pid_matches_start "$fleet_pid" "$fleet_pid_start" \
        && [ "$fleet_pgid" = "$fleet_pid" ] ||
        fail "$bench: the exact controller is not the leader of its own session"
    # Exactly run-bench-campaign.py terminate_owned_children: os.killpg(SIGTERM),
    # or a terminal Ctrl-C to the foreground fleet's process group.
    term_epoch="$(date +%s)"
    kill -s "$signal_name" -- "-$fleet_pgid"
    stop_file="$FAKE_DIR/machines/$machine/benchmark.stopped"
    deadline=$((term_epoch + budget))
    while [ ! -s "$stop_file" ] && [ "$(date +%s)" -lt "$deadline" ]; do
        sleep 0.5
    done
    if [ ! -s "$stop_file" ]; then
        # Stop only the test-owned fake benchmark before reporting the defect.
        kill "$driver_pid" 2>/dev/null || true
        grep -E 'guest cleanup|controller received|retaining|status proxy' "$log" >&2 || true
        fail "$bench: the guest kept executing its benchmark ${budget}s after the controller group received $signal_name"
    fi
    deadline=$((SECONDS + 300))
    while kill -0 "$launcher_pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do
        sleep 1
    done
    ! kill -0 "$launcher_pid" 2>/dev/null ||
        fail "$bench: the cancelled controller did not finish its bounded cleanup"
    wait "$launcher_pid" || launcher_status=$?
    for pid in "${PIDS[@]}"; do
        [ "$pid" = "$launcher_pid" ] || remaining_pids+=("$pid")
    done
    PIDS=("${remaining_pids[@]}")
    [ "$launcher_status" -ne 0 ] ||
        fail "$bench: a cancelled controller reported success"
    grep -qF "controller received $signal_name" "$log" ||
        fail "$bench: the controller did not observe the group $signal_name"
    # Auxiliary loops die from the same group signal; their teardown must
    # still account for every owned local process.
    if grep -E 'survived local teardown|Could not capture the process table' "$log" >&2; then
        fail "$bench: controller teardown left owned local processes unaccounted after the group $signal_name"
    fi
    python3 - "$stop_file" "$expected_reason" "$term_epoch" "$budget" <<'PY' ||
import json
import sys

stop = json.load(open(sys.argv[1]))
expected, term_epoch, budget = sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
assert stop["reason"] == expected, (stop["reason"], expected)
assert stop["stopped_epoch"] - term_epoch <= budget, stop
PY
        fail "$bench: the guest did not stop through $expected_reason within ${budget}s ($(cat "$stop_file"))"
    deadline=$((SECONDS + 10))
    while kill -0 "$driver_pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do
        sleep 0.2
    done
    ! kill -0 "$driver_pid" 2>/dev/null ||
        fail "$bench: the guest benchmark process survived its stop"
    [ -f "$registry/meta" ] && [ -e "$registry/runtime-evidence-unconfirmed" ] ||
        fail "$bench: cancellation released the exact owner before its evidence gap was recorded"
    grep -qF "❌ primary runtime evidence remains incomplete: " "$log" ||
        fail "$bench: the cancelled run did not record its runtime-evidence gap"
    output="$(sed -n 's/^runs_root=//p' "$registry/meta" | head -1)/$(sed -n 's/^run_id=//p' "$registry/meta" | head -1)/$bench"
    [ -d "$output" ] || fail "$bench: the retained owner does not name its run output"
    if [ "$expected_reason" = native-stop ]; then
        # The guest itself answered the authenticated stop with HTTP 503 and
        # the runner then retired its proxy, so no party delivered the stop and
        # no delivery receipt exists.
        if [ ! -s "$FAKE_DIR/machines/$machine/shutdown-rejected" ]; then
            grep -nE "guest cleanup|status proxy|Original exit code" \
                "$output/fleet-child.log" >&2 || true
            fail "$bench: the guest never rejected an authenticated stop"
        fi
        [ ! -e "$output/guest-shutdown.requested" ] ||
            fail "$bench: a rejected stop published a delivery receipt"
        JOURNAL="$FAKE_DIR/journal.log" MACHINE="$machine" python3 - <<'PY' ||
import os
import shlex

stops = [shlex.split(line)[2] for line in open(os.environ["JOURNAL"]) if line.startswith("machine stop ")]
# One throttled request plus exactly one bounded retry of the same Machine.
assert stops == [os.environ["MACHINE"]] * 2, stops
PY
            fail "$bench: the throttled native stop was not retried exactly once on the owned guest Machine"
        python3 - "$output/guest-native-stop.json" "$machine" "$volume" <<'PY' ||
import json
import sys

receipt = json.load(open(sys.argv[1]))
assert receipt["machine_id"] == sys.argv[2], receipt
assert receipt["volume_id"] == sys.argv[3], receipt
assert receipt["verified_state"] == "stopped", receipt
assert receipt["verified"] is True, receipt
assert receipt["stop_requests"] == 2, receipt
assert receipt["delivery_receipt"] == "absent", receipt
assert receipt["destroyed"] is False, receipt
PY
            fail "$bench: the native guest stop has no exact durable receipt"
        [ -e "$registry/guest-cleanup-unconfirmed" ] ||
            fail "$bench: a natively stopped guest must keep its unconfirmed-cleanup quarantine"
    else
        [ -s "$output/guest-shutdown.confirmed" ] ||
            fail "$bench: the delivered guest shutdown was not acknowledged"
        if grep -qE "^machine stop " "$FAKE_DIR/journal.log"; then
            fail "$bench: a guest that acknowledged its delivered shutdown was also stopped natively"
        fi
        # The runner's own EXIT cleanup delivered the stop: its run-scoped
        # delivery receipt exists. A runner that ignored the forwarded signal
        # leaves delivery entirely to the controller and never writes one.
        python3 - "$output/guest-shutdown.requested" "$machine" "$bench" \
            "$(sed -n 's/^run_id=//p' "$registry/meta" | head -1)" "${registry##*/}" <<'PY' ||
import json
import sys

receipt = json.load(open(sys.argv[1]))
machine, bench, run_id, owner = sys.argv[2:]
assert receipt["kind"] == "guest-shutdown-requested", receipt
assert receipt["machine_id"] == machine and receipt["bench"] == bench, receipt
assert receipt["run_id"] == run_id, receipt
assert receipt["run_token"].startswith(owner + "-"), receipt
assert receipt["http_status"] in (202, 204, 409), receipt
PY
            fail "$bench: the runner did not deliver the guest stop itself after the group $signal_name"
    fi
    grep -E "guest cleanup|guest shutdown|natively" "$log" || true
    [ -s "$output/fleet-child.log" ] || fail "$bench: the original guest log was not preserved"
    assert_and_reset_disposable_failed_owner "$registry" "$log" ||
        fail "$bench: the failed group-$signal_name run did not retain its result while retiring disposable resources"
    rm -f "$FAKE_DIR/throttle-first-machine-stop"
    assert_no_fixture_processes "$bench ($signal_name)"
    SESSION_CONTROLLERS=()
    echo "PASS: scenario 2-group-term ($bench, $signal_name) — guest stopped via $expected_reason $(python3 -c 'import json, sys; print(round(json.load(open(sys.argv[1]))["stopped_epoch"] - int(sys.argv[2]), 1))' "$stop_file" "$term_epoch")s after process-group $signal_name (budget ${budget}s); failed result and evidence gap retained, disposable resources destroyed"
}

# A guest whose stop WAS delivered must drain undisturbed even when every
# local party has already given up waiting for its acknowledgement. Its
# execution window expires; the runner delivers /shutdown (202), waits its
# bounded acknowledgement window, exits and retires the proxy; then the
# controller's group is cancelled. The controller's own request now fails with
# HTTP 000, but the runner's run-scoped delivery receipt proves the stop
# arrived: no native stop may cut off browser cleanup and evidence sealing.
group_term_delivered_slow_drain_contract() {
    local bench=bench-group-term-slowdrain log launcher_pid launcher_status=0 deadline
    local marker="" machine="" registry="" candidate output="" fleet_pid fleet_pgid
    local requested_at stop_file driver_pid drained=0 pid runner_exited_at cleanup_seconds
    local -a remaining_pids=()
    log="$TMP_ROOT/controller-$bench.log"
    reset_fake_state
    rm -f "$POOL_A" "$POOL_B" "$FAKE_DIR/throttle-first-machine-stop"
    rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$FAKE_DIR/markers"
    mkdir -p "$FAKE_DIR/markers"
    : > "$FAKE_DIR/journal.log"
    printf '90\n' > "$FAKE_DIR/slow-drain-seconds"
    # A 12 s execution window after a 20 s per-box barrier allowance.
    rm -f "$TMP_ROOT/session-$bench.pid"
    CLOUDBENCH_TEST_NEW_SESSION=1 CLOUDBENCH_TEST_BARRIER_MIN=1 \
        CLOUDBENCH_PER_BOX_BARRIER_WAIT_SECONDS=20 \
        CLOUDBENCH_TEST_SESSION_PID_FILE="$TMP_ROOT/session-$bench.pid" \
        run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$log" "$bench" --timeout 12 &
    launcher_pid=$!
    PIDS+=("$launcher_pid")
    track_session_controller "$TMP_ROOT/session-$bench.pid"
    deadline=$((SECONDS + 180))
    while [ "$SECONDS" -lt "$deadline" ]; do
        marker="$(find "$FAKE_DIR/markers" -maxdepth 1 -name 'benchmark-executing-*' \
            -type f -print -quit 2>/dev/null)"
        [ -z "$marker" ] || break
        kill -0 "$launcher_pid" 2>/dev/null || break
        sleep 0.5
    done
    [ -n "$marker" ] || fail "$bench: the guest never started executing its benchmark"
    machine="${marker##*/benchmark-executing-}"
    driver_pid="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["pid"])' "$marker")"
    for candidate in "$SANDBOX/.git/cloudbench-fleet-ownership"/*; do
        [ -f "$candidate/meta" ] || continue
        if grep -rqx "id=$machine" "$candidate/clones" 2>/dev/null; then
            registry="$candidate"
        fi
    done
    [ -n "$registry" ] || fail "$bench: the executing guest has no exact durable owner record"
    output="$(sed -n 's/^runs_root=//p' "$registry/meta" | head -1)/$(sed -n 's/^run_id=//p' "$registry/meta" | head -1)/$bench"
    fleet_pid="$(sed -n 's/^pid=//p' "$registry/meta" | head -1)"
    fleet_pgid="$(ps -o pgid= -p "$fleet_pid" 2>/dev/null | tr -d ' ')"
    [ "$fleet_pgid" = "$fleet_pid" ] ||
        fail "$bench: the exact controller is not the leader of its own session"
    # Wait until the runner has delivered the stop, given up on its bounded
    # acknowledgement and exited with its proxy retired.
    deadline=$((SECONDS + 120))
    while [ ! -s "$output/benchmark-child.finished" ] && [ "$SECONDS" -lt "$deadline" ]; do
        kill -0 "$launcher_pid" 2>/dev/null || break
        sleep 0.5
    done
    runner_exited_at="$(date +%s.%N)"
    [ -s "$FAKE_DIR/machines/$machine/shutdown-requested" ] ||
        fail "$bench: the runner never delivered the authenticated stop"
    grep -qF "timed-out guest shutdown unconfirmed" "$output/fleet-child.log" ||
        fail "$bench: the runner did not exhaust its bounded acknowledgement window"
    # Cancel the controller group exactly as the campaign does. Controller
    # cleanup may already be running; it ignores the duplicate signal.
    kill -TERM -- "-$fleet_pgid" 2>/dev/null || true
    deadline=$((SECONDS + 180))
    while kill -0 "$launcher_pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do
        sleep 1
    done
    ! kill -0 "$launcher_pid" 2>/dev/null ||
        fail "$bench: the cancelled controller did not finish its bounded cleanup"
    # The runner already retired the delivered guest's proxy: nothing can
    # acknowledge it any more, so controller cleanup must hand it to retention
    # promptly (main took about 6 s) instead of polling a dead port until the
    # 30 s confirmation deadline.
    cleanup_seconds="$(python3 -c 'import sys, time; print(f"{time.time() - float(sys.argv[1]):.1f}")' "$runner_exited_at")"
    python3 -c 'import sys; raise SystemExit(0 if float(sys.argv[1]) < 20 else 1)' "$cleanup_seconds" ||
        fail "$bench: controller cleanup took ${cleanup_seconds}s after the runner exited (limit 20s)"
    wait "$launcher_pid" || launcher_status=$?
    for pid in "${PIDS[@]}"; do
        [ "$pid" = "$launcher_pid" ] || remaining_pids+=("$pid")
    done
    PIDS=("${remaining_pids[@]}")
    [ "$launcher_status" -ne 0 ] ||
        fail "$bench: an unacknowledged guest cleanup reported success"
    if grep -E 'survived local teardown|Could not capture the process table' "$log" >&2; then
        fail "$bench: controller teardown left owned local processes unaccounted after the group TERM"
    fi
    requested_at="$(cat "$FAKE_DIR/machines/$machine/shutdown-requested")"
    stop_file="$FAKE_DIR/machines/$machine/benchmark.stopped"
    # The controller finished while the delivered drain was still running.
    python3 - "$requested_at" <<'PY' ||
import sys
import time

assert time.time() - float(sys.argv[1]) < 90, "controller cleanup outlived the drain"
PY
        fail "$bench: the fixture drain did not outlast controller cleanup"
    if grep -qE "^machine stop " "$FAKE_DIR/journal.log"; then
        grep -E "guest cleanup|guest shutdown|natively|delivered" "$log" >&2 || true
        fail "$bench: a guest whose stop was delivered and still draining was stopped natively"
    fi
    [ ! -e "$output/guest-native-stop.json" ] ||
        fail "$bench: a delivered draining guest received a native-stop receipt"
    grep -qF "after its runner delivered the authenticated shutdown" "$log" ||
        fail "$bench: controller cleanup did not recognize the runner's delivery receipt"
    grep -qF "status proxy is retired" "$log" ||
        fail "$bench: controller cleanup kept polling a delivered guest's retired proxy"
    deadline=$((SECONDS + 120))
    while [ ! -s "$stop_file" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.5; done
    if python3 - "$stop_file" <<'PY'
import json
import sys

assert json.load(open(sys.argv[1]))["reason"] == "drain-completed"
PY
    then
        drained=1
    fi
    if [ "$drained" != 1 ]; then
        kill "$driver_pid" 2>/dev/null || true
        fail "$bench: the delivered guest did not drain to completion ($(cat "$stop_file" 2>/dev/null || echo absent))"
    fi
    [ -f "$registry/meta" ] && [ -e "$registry/guest-cleanup-unconfirmed" ] ||
        fail "$bench: an unacknowledged drain must retain its exact owner and quarantine"
    fake_machine_exists "$machine" ||
        fail "$bench: the draining guest Machine was destroyed"
    if grep -qE "^machine destroy |^volumes destroy " "$FAKE_DIR/journal.log"; then
        fail "$bench: provider deletion ran on an unconfirmed cancellation path"
    fi
    assert_and_reset_retained_fake_owner "$registry" ||
        fail "$bench: retained slow-drain owner could not be safely reset"
    rm -f "$FAKE_DIR/slow-drain-seconds"
    assert_no_fixture_processes "$bench"
    SESSION_CONTROLLERS=()
    echo "PASS: scenario 2-group-term ($bench) — delivered stop drained to completion with no native stop; controller cleanup ${cleanup_seconds}s after the runner exited; exact owner retained for recovery"
}
# The fixture reaper must find and stop a leaked session-leader controller, so
# a failed or timed-out case can never leave one running after TMP_ROOT is gone.
leak_pid_file="$TMP_ROOT/session-leak.pid"
python3 -c 'import os, sys, time
with open(sys.argv[1] + ".tmp", "w") as handle:
    handle.write(str(os.getpid()))
os.replace(sys.argv[1] + ".tmp", sys.argv[1])
os.setsid()
os.execvp("bash", ["bash", "-c", "trap \"\" HUP INT TERM; while :; do sleep 1; done", sys.argv[2]])' \
    "$leak_pid_file" "$TMP_ROOT/ws-a/scripts/run-bench-fleet" &
leak_launcher=$!
track_session_controller "$leak_pid_file"
mapfile -t leaked < <(fixture_process_pids)
[ "${#leaked[@]}" -ge 1 ] ||
    fail "fixture survivor scan did not see a leaked session-leader controller"
reap_fixture_processes
mapfile -t leaked < <(fixture_process_pids)
[ "${#leaked[@]}" -eq 0 ] ||
    fail "fixture reaper left a leaked session-leader controller running: ${leaked[*]}"
wait "$leak_launcher" 2>/dev/null || true
echo "PASS: fixture reaper stops a leaked TERM-ignoring session-leader controller"

# CLOUDBENCH_TEST_GROUP_TERM_CASES selects a subset for a focused rerun.
group_term_case_selected() {
    case " ${CLOUDBENCH_TEST_GROUP_TERM_CASES:-term int undeliverable slowdrain} " in
        *" $1 "*) return 0 ;;
    esac
    return 1
}
! group_term_case_selected term ||
    group_term_cancellation_contract bench-group-term guest-shutdown TERM
! group_term_case_selected int ||
    group_term_cancellation_contract bench-group-term guest-shutdown INT
! group_term_case_selected undeliverable ||
    group_term_cancellation_contract bench-group-term-undeliverable native-stop TERM
! group_term_case_selected slowdrain ||
    group_term_delivered_slow_drain_contract
assert_no_controller_script_snapshots "process-group TERM cancellation"
if [ "${CLOUDBENCH_TEST_GROUP_TERM_ONLY:-0}" = "1" ]; then
    echo "All process-group TERM cancellation checks passed."
    exit 0
fi

# Cooperative predeploy cancellation walks only the poller/waiter descendant
# tree; the paid controller has already been reparented into its own session.
# Drive a controller that ignores TERM after crossing provider allocation. The
# identity-fenced waiter must escalate to KILL. No in-process guest cleanup can
# run after that boundary, so the out-of-process recovery entrypoint must execute
# from the real script in source order, reconnect the exact guest, prove its
# shutdown acknowledgement, and retain exact durable ownership until complete
# runtime evidence exists (guest cleanup alone is insufficient).
reset_fake_state
rm -f "$POOL_A" "$POOL_B"
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
neighbor_token="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
neighbor_registry="$SANDBOX/.git/cloudbench-fleet-ownership/$neighbor_token"
neighbor_volume="vol_neighbor_unattached"
neighbor_host="$(hostname 2>/dev/null || uname -n)"
if [ -r /proc/self/stat ]; then
    neighbor_pid_start="$(cloudbench_pid_start_time $$)"
else
    neighbor_pid_start="$(ps -p $$ -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
fi
mkdir -p "$neighbor_registry/clones"
cat > "$neighbor_registry/meta" <<EOF
version=1
app=${FLEET_BENCH_APP}
host=$neighbor_host
pid=$$
pid_start=$neighbor_pid_start
run_id=live-neighbor
cleanup_policy=reap
EOF
cat > "$neighbor_registry/clones/cloudbench-live-neighbor" <<EOF
name=cloudbench-live-neighbor
volume_id=$neighbor_volume
EOF
cancel_launcher_log="$TMP_ROOT/controller-detached-wait-cancel.log"
CLOUDBENCH_TEST_DEFAULT_DETACH=1 CLOUDBENCH_TEST_BARRIER_MIN=1 \
    CLOUDBENCH_TEST_IGNORE_CONTROLLER_TERM=1 \
    CLOUDBENCH_DETACHED_RECOVERY_SECONDS=2 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$cancel_launcher_log" \
    bench-detached-cancel --timeout 240 --wait &
cancel_launcher_pid=$!
PIDS+=("$cancel_launcher_pid")

cancel_target_registry=""
cancel_recovery_ready=0
# Startup includes real host-side packaging and readiness publication even in
# this offline provider fixture. Bound that whole infrastructure phase by time
# while preserving the exact identity checks required before cancellation.
cancel_ready_deadline=$((SECONDS + 120))
while [ "$SECONDS" -lt "$cancel_ready_deadline" ]; do
    for registry in "$SANDBOX/.git/cloudbench-fleet-ownership"/*; do
        [ -d "$registry" ] || continue
        [ "$registry" = "$neighbor_registry" ] && continue
        recovery_record="$(find "$registry/clones" -maxdepth 1 -type f -print -quit 2>/dev/null)"
        recovery_audit="$SANDBOX/.git/cloudbench-fleet-audits/${registry##*/}"
        recovery_output="$(find "$WS_A/.context/fleet/runs" -path '*/bench-detached-cancel' \
            -type d -print -quit 2>/dev/null)"
        [ -n "$recovery_record" ] && [ -n "$recovery_output" ] || continue
        grep -qE '^id=[0-9a-f]+$' "$recovery_record" || continue
        grep -qE '^volume_id=[a-zA-Z0-9_-]+$' "$recovery_record" || continue
        grep -qF 'disposition=owned' "$recovery_audit/fresh/${recovery_record##*/}" \
            2>/dev/null || continue
        [ -s "$recovery_output/.cid" ] && [ -s "$recovery_output/status-proxy.port" ] \
            || continue
        cancel_target_registry="$registry"
        cancel_recovery_ready=1
        break
    done
    [ "$cancel_recovery_ready" -eq 0 ] || break
    sleep 0.05
done
[ "$cancel_recovery_ready" -eq 1 ] ||
    fail "detached cancellation fixture never published its exact recoverable guest identity"
FAKE_STATE="$FAKE_DIR/state.json" NEIGHBOR_VOLUME="$neighbor_volume" python3 - <<'PY'
import json
import os

path = os.environ["FAKE_STATE"]
with open(path) as handle:
    state = json.load(handle)
state["volumes"].append(
    {
        "id": os.environ["NEIGHBOR_VOLUME"],
        "name": "cloudbench_data",
        "state": "created",
        "attached_machine_id": None,
    }
)
with open(path, "w") as handle:
    json.dump(state, handle)
PY
[ -n "$cancel_target_registry" ] ||
    fail "detached cancellation did not publish its exact target registry"
cancel_owner_token="${cancel_target_registry##*/}"
cancel_owned_name=""
for record in "$cancel_target_registry"/clones/*; do
    [ -f "$record" ] || continue
    cancel_owned_name="$(sed -n 's/^name=//p' "$record" | head -1)"
    [ -n "$cancel_owned_name" ] && break
done
[ -n "$cancel_owned_name" ] ||
    fail "detached cancellation fixture never durably reserved its exact clone name"
read -r cancel_owned_id cancel_owned_volume <<EOF
$(FAKE_STATE="$FAKE_DIR/state.json" OWNED_NAME="$cancel_owned_name" python3 - <<'PY'
import json
import os

with open(os.environ["FAKE_STATE"]) as handle:
    machines = json.load(handle)["machines"]
matches = [item for item in machines if item.get("name") == os.environ["OWNED_NAME"]]
if len(matches) != 1:
    raise SystemExit(1)
mounts = (matches[0].get("config") or {}).get("mounts") or []
volume = mounts[0].get("volume") if mounts and isinstance(mounts[0], dict) else ""
if not volume:
    raise SystemExit(1)
print(matches[0]["id"], volume)
PY
)
EOF
[ -n "$cancel_owned_id" ] && [ -n "$cancel_owned_volume" ] ||
    fail "detached cancellation fixture could not resolve its reserved name to one exact machine and volume"

cancel_owner_file="$(find "$WS_A/.context/fleet/runs" -name 'detached-*.owner' \
    -type f -print -quit 2>/dev/null)"
[ -n "$cancel_owner_file" ] || fail "detached cancellation did not publish its tracked process-group owner"
cancel_owner_pid="$(sed -n 's/^pid=//p' "$cancel_owner_file" | head -1)"
cancel_owner_pgid="$(sed -n 's/^pgid=//p' "$cancel_owner_file" | head -1)"
case "$cancel_owner_pid:$cancel_owner_pgid" in
    ''|*[!0-9:]*|:*|*:) fail "detached cancellation published malformed process-group ownership" ;;
esac
[ "$cancel_owner_pid" -gt 1 ] && [ "$cancel_owner_pid" = "$cancel_owner_pgid" ] ||
    fail "detached cancellation process-group ownership is unsafe"
# Model the exact crash boundary: no controller trap or guest-confirmation loop
# can run after an uncatchable signal to the exact tracked session group.
kill -KILL -- "-$cancel_owner_pgid"
cancel_wait_status=0
wait "$cancel_launcher_pid" 2>/dev/null || cancel_wait_status=$?
PIDS=()
[ "$cancel_wait_status" -ne 0 ] ||
    fail "canceled detached wait unexpectedly returned success"

[ -d "$cancel_target_registry" ] && [ -f "$cancel_target_registry/runtime-evidence-unconfirmed" ] ||
    fail "early cancellation without runtime evidence must retain its exact owner"
fake_machine_exists "$cancel_owned_id" ||
    fail "early cancellation destroyed its guest before runtime evidence was preserved"
FAKE_STATE="$FAKE_DIR/state.json" OWNED_VOLUME="$cancel_owned_volume" python3 - <<'PY_VOLUME' ||
import json, os
state = json.load(open(os.environ["FAKE_STATE"]))
assert any(item.get("id") == os.environ["OWNED_VOLUME"] for item in state["volumes"])
PY_VOLUME
    fail "early cancellation destroyed its original evidence volume"
if grep -qE "^machine destroy (.* )?${cancel_owned_id}( |$)|^volumes destroy ${cancel_owned_volume}( |$)" "$FAKE_DIR/journal.log"; then
    fail "early cancellation issued provider deletion before preserving evidence"
fi
FAKE_STATE="$FAKE_DIR/state.json" NEIGHBOR_VOLUME="$neighbor_volume" python3 - <<'PY' ||
import json
import os

with open(os.environ["FAKE_STATE"]) as handle:
    volumes = json.load(handle)["volumes"]
raise SystemExit(
    0 if any(item.get("id") == os.environ["NEIGHBOR_VOLUME"] for item in volumes) else 1
)
PY
    fail "exact cancellation recovery destroyed a live neighbor's unattached volume"
[ ! -e "$WS_A/.context/cloudbench-controller.lock" ] ||
    fail "exact cancellation recovery left the workspace controller lock"
assert_no_controller_script_snapshots "detached cancellation recovery"
cancel_detached_log="$(sed -n 's/^    log: tail -f //p' "$cancel_launcher_log" | tail -1)"
[ -n "$cancel_detached_log" ] ||
    fail "TERM-resistant cancellation did not publish its detached controller log"
grep -qF "reconnecting exact owned guests for authenticated cleanup acknowledgement" \
    "$cancel_launcher_log" ||
    fail "real exact-owner entrypoint did not enter guest shutdown recovery"
grep -qF "every guest acknowledged browser/session cleanup before fleet machine teardown" \
    "$cancel_launcher_log" ||
    fail "real exact-owner entrypoint did not prove guest shutdown acknowledgement"
grep -qF "sealed runtime evidence could not be recaptured" "$cancel_launcher_log" ||
    fail "out-of-process recovery did not explain its evidence retention boundary"
if grep -qF "command not found" "$cancel_launcher_log"; then
    fail "real exact-owner entrypoint failed its source ordering"
fi
# This reset affects only asserted fake provider records. The owning retention
# suite separately proves canonical recovery after complete forensic copies.
assert_and_reset_retained_fake_owner "$cancel_target_registry" ||
    fail "early-cancellation retained fake fixture could not be safely reset"
rm -rf "$neighbor_registry"
rm -f "$TMP_ROOT/capacity-reservations/reservations/${cancel_owner_token}-"* \
    "$WS_A/.context/fleet/runs"/detached-*.owner \
    "$WS_A/.context/fleet/runs"/detached-*.status 2>/dev/null || true
echo "PASS: scenario 2-cancel — exact recovery acknowledged cleanup and retained missing runtime evidence"

if [ "${CLOUDBENCH_TEST_EXACT_RECOVERY_ORDER_ONLY:-0}" = "1" ]; then
    echo "All exact stale-owner recovery ordering checks passed."
    exit 0
fi

# A freshly cloned Machine can already have its provider-authoritative 6PN
# address while its derived .internal hostname is absent from Fly DNS. The
# status and mandatory-autoscaler tunnels must use the indexed private address,
# otherwise a healthy primary is excluded before the synchronized start barrier.
reset_fake_state
: > "$FAKE_DIR/journal.log"
: > "$FAKE_DIR/require-private-ip-proxy"
: > "$FAKE_DIR/stale-started-inventory"
: > "$FAKE_DIR/fail-first-primary-start"
private_ip_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 CLOUDBENCH_DATA_PROXY_READY_TIMEOUT=4 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-private-ip-proxy.log" \
    private-ip-proxy --timeout 240 || private_ip_status=$?
rm -f "$FAKE_DIR/require-private-ip-proxy" "$FAKE_DIR/stale-started-inventory" \
    "$FAKE_DIR/fail-first-primary-start"
[ "$private_ip_status" -eq 0 ] || {
    cat "$TMP_ROOT/controller-private-ip-proxy.log" >&2
    fail "data-plane tunnels must not depend on eventually consistent machine-name DNS"
}
python3 "$ROOT_DIR/scripts/tests/cloudbench-fake-volume-contract.test.py" \
    --assert-private-ip-proxies "$FAKE_DIR" ||
    fail "both data-plane tunnels must target the indexed primary private IP"
grep -Eq '^machine start [0-9a-f]+' "$FAKE_DIR/journal.log" ||
    fail "every post-config primary must receive an explicit idempotent start request"
JOURNAL="$FAKE_DIR/journal.log" python3 - <<'PY' ||
import os

calls = open(os.environ["JOURNAL"]).read().splitlines()
starts = [index for index, call in enumerate(calls) if call.startswith("machine start ")]
metrics = [
    index
    for index, call in enumerate(calls)
    if call.startswith("proxy ") and ":3003 " in call
]
if len(starts) < 2:
    raise SystemExit(f"the injected first start failure did not produce a retry: {starts}")
if not metrics or min(metrics) <= starts[1]:
    raise SystemExit(
        "mandatory autoscaler spent its metrics attach budget before the successful "
        f"post-config start retry: starts={starts}, metrics={metrics}"
    )
PY
    fail "mandatory autoscaling must wait for the accepted post-config primary start"
echo "PASS: scenario 2a — post-config starts and data-plane tunnels ignore stale derived identity"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 2b — mandatory autoscaling fails closed when its data plane cannot
# attach. A successful benchmark running on one primary is not acceptance: the
# fleet contract requires the per-bench autoscaler to be operational.
# ═════════════════════════════════════════════════════════════════════════════
mandatory_metrics_failure_contract

# The synchronized boot-config barrier deliberately keeps every primary
# stopped until the whole fleet is configured. A mandatory metrics proxy must
# begin its finite attach budget only after that release AND provider-confirmed
# start; otherwise it can exhaust the budget while configs or its own start are
# still in flight.
reset_fake_state
: > "$FAKE_DIR/journal.log"
: > "$FAKE_DIR/delay-machine-update"
: > "$FAKE_DIR/metrics-require-started"
boot_wait_status=0
# This positive startup case uses the ordinary infrastructure readiness budget.
# Its usable stage handoff is the assertion, rather than a two-second substep.
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-autoscaler-boot-wait.log" \
    autoscaler-waits-for-boot-release --timeout 240 || boot_wait_status=$?
rm -f "$FAKE_DIR/delay-machine-update" "$FAKE_DIR/metrics-require-started"
[ "$boot_wait_status" -eq 0 ] || {
    cat "$TMP_ROOT/controller-autoscaler-boot-wait.log" >&2
    fail "mandatory autoscaler attach budget must not run while its primary is intentionally stopped behind the boot-config barrier"
}
echo "PASS: scenario 2b2 — autoscaler attachment begins after synchronized primary start"

# A live WireGuard process is not enough: the worker's metrics contract must be
# readable before task release, otherwise scaling is still effectively off.
reset_fake_state
: > "$FAKE_DIR/journal.log"
: > "$FAKE_DIR/invalid-metrics"
autoscale_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 CLOUDBENCH_FAKE_INVALID_METRICS=1 \
    CLOUDBENCH_AUTOSCALER_STARTUP_WAIT_SECONDS=5 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-autoscaler-metrics-required.log" \
    autoscaler-metrics-required --timeout 240 || autoscale_status=$?
[ "$autoscale_status" -ne 0 ] ||
    fail "a fleet must fail when mandatory autoscaler metrics stay invalid"
grep -qF "mandatory autoscaler startup timed out" "$TMP_ROOT/controller-autoscaler-metrics-required.log" ||
    fail "invalid mandatory-autoscaler metrics must produce an explicit startup failure"
assert_and_reset_disposable_failed_benchmark autoscaler-metrics-required "$TMP_ROOT/controller-autoscaler-metrics-required.log" ||
    fail "autoscaler-metrics-required: missing runtime evidence must retain the failed result while retiring disposable resources"
rm -f "$FAKE_DIR/invalid-metrics"
echo "PASS: scenario 2c — a live proxy without valid metrics fails closed"

# A metrics target of two is not satisfied merely because Fly allocated a
# worker clone. The clone must actually launch the queue worker and reach its
# operational marker; otherwise the fleet would run at primary-only capacity
# while reporting autoscaling as healthy.
reset_fake_state
: > "$FAKE_DIR/journal.log"
: > "$FAKE_DIR/desired-two"
: > "$FAKE_DIR/fail-worker-launch"
autoscale_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 CLOUDBENCH_WORKER_STAGE_ATTEMPTS=2 \
    CLOUDBENCH_WORKER_READY_TIMEOUT=5 \
    CLOUDBENCH_AUTOSCALER_FINALIZATION_WAIT_SECONDS=30 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-autoscaler-worker-required.log" \
    autoscaler-worker-required --timeout 240 || autoscale_status=$?
[ "$autoscale_status" -ne 0 ] ||
    fail "a fleet must fail when an autoscaled worker clone cannot launch"
grep -Eq 'mandatory autoscaler.*(worker capacity (incomplete|below desired)|worker .* could not be staged and launched|worker [0-9a-f]+ cancellation cleanup failed; exact ownership retained)' \
    "$TMP_ROOT/controller-autoscaler-worker-required.log" ||
    fail "an unready autoscaled worker must produce a stable explicit failure"
python3 - "$FAKE_DIR" <<'PY_INERT_CLONE' || fail "worker clones must carry the controller's inert init.cmd override"
import json, sys
from pathlib import Path
fake = Path(sys.argv[1])
ids = [p.name.removeprefix("worker-clone-id-") for p in (fake / "markers").glob("worker-clone-id-*")]
assert ids
for machine_id in ids:
    row = json.loads((fake / "machines" / machine_id / "provider-machine.json").read_text())
    assert row["config"]["init"]["cmd"] == ["sleep", "infinity"], row["config"]
PY_INERT_CLONE
stage_log="$(find "$WS_A/.context/fleet/runs" -path '*/autoscaler-worker-required/worker-*.stage.log' -type f -print -quit 2>/dev/null || true)"
[ -n "$stage_log" ] ||
    fail "failed autoscaled-worker launch must preserve a per-worker stage log"
grep -qF "launch worker wrapper failed rc=1" "$stage_log" ||
    fail "autoscaled-worker stage log must identify the failing launch command"
grep -qF "injected autoscaled-worker launch failure" "$stage_log" ||
    fail "autoscaled-worker stage log must preserve the provider command stderr"
if grep -Eq 'mandatory autoscaler.*worker [0-9a-f]+ cancellation cleanup failed; exact ownership retained' \
    "$TMP_ROOT/controller-autoscaler-worker-required.log"; then
    cleanup_marker="${stage_log%.stage.log}.cleanup-failed"
    failed_worker="${cleanup_marker##*/worker-}"; failed_worker="${failed_worker%.cleanup-failed}"
    [ -f "${cleanup_marker%.cleanup-failed}.pending" ] && \
        grep -Fxq "$failed_worker" "$(dirname "$cleanup_marker")/worker-clones.ids" && \
        grep -Fxq "worker $failed_worker cancellation cleanup failed; exact ownership retained" "$cleanup_marker" ||
        fail "worker cleanup failure must retain its exact tracked pending owner and positive failure marker"
fi
clone_count="$(grep -c '^machine clone ' "$FAKE_DIR/journal.log" 2>/dev/null || true)"
[ "$clone_count" -ge 2 ] ||
    fail "the scale-up regression must allocate both a primary and an autoscaled worker"
# The injected SSH error remains before the supervisor launch. No terminal
# guest evidence exists, so exact ownership must remain quarantined even when
# shutdown is acknowledged. Preserve this boundary rather than shifting the
# failure after a child just to recover the old deletion expectation.
if find "$FAKE_DIR/machines" -path '*/cloudbench-worker-evidence/owner.json' -type f -print -quit | grep -q .; then
    fail "pre-supervisor launch failure unexpectedly admitted a worker supervisor"
fi
# The task itself finished (PASS stays published); the launched worker's
# missing evidence fails the run while disposable resources are retired.
assert_and_reset_disposable_failed_benchmark autoscaler-worker-required \
    "$TMP_ROOT/controller-autoscaler-worker-required.log" passed ||
    fail "pre-supervisor failure did not retain its failed run while retiring disposable resources"
rm -f "$FAKE_DIR/desired-two" "$FAKE_DIR/fail-worker-launch"
echo "PASS: scenario 2d — failed autoscaled-worker launch fails the fleet closed"

readiness_retry_contract

# Pending provider work still requires causal autoscaler terminal completion.
# The completed task remains PASS, but the existing two-second terminal budget
# cannot accept a blocked provisioner; retain its recoverable name-only owner.
reset_fake_state
: > "$FAKE_DIR/journal.log"
: > "$FAKE_DIR/desired-two"
: > "$FAKE_DIR/block-worker-clone"
autoscale_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 CLOUDBENCH_AUTOSCALER_FINALIZATION_WAIT_SECONDS=2 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-autoscaler-worker-clone-pending.log" \
    autoscaler-worker-clone-pending --timeout 240 || autoscale_status=$?
[ "$autoscale_status" -ne 0 ] ||
    fail "a fleet must fail without causal completion of its blocked provisioner"
[ -f "$FAKE_DIR/worker-clone-blocked" ] ||
    fail "the in-progress allocation regression never blocked inside the worker clone boundary"
grep -qF "mandatory autoscaler did not confirm terminal completion" \
    "$TMP_ROOT/controller-autoscaler-worker-clone-pending.log" ||
    fail "blocked provisioning did not preserve mandatory causal terminal failure"
grep -qF "stayed unresolved through its bounded visibility wait; retaining ownership" \
    "$TMP_ROOT/controller-autoscaler-worker-clone-pending.log" ||
    fail "blocked provisioning must re-resolve its exact name and then retain ownership"
remaining="$(python3 -c '
import json, sys
machines = json.load(open(sys.argv[1]))["machines"]
print(" ".join(sorted(m["name"] for m in machines)))
' "$FAKE_DIR/state.json")"
[ "$remaining" = "cloudbench-warm" ] ||
    fail "blocked worker allocation leaked a provider machine: $remaining"
pending_record="$(find "$SANDBOX/.git/cloudbench-fleet-ownership" -path '*/clones/*' -type f -print -quit 2>/dev/null || true)"
[ -n "$pending_record" ] ||
    fail "blocked worker allocation lost its recoverable name-only ownership record"
[ -z "$(sed -n 's/^id=//p' "$pending_record")" ] ||
    fail "blocked pre-allocation ownership unexpectedly claimed a provider ID"
# The fake provider was killed before allocation and can never become visible;
# remove only this asserted test-owned phantom so later scenarios are isolated.
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership"
rm -f "$FAKE_DIR/desired-two" "$FAKE_DIR/block-worker-clone" "$FAKE_DIR/worker-clone-blocked"
echo "PASS: scenario 2f — blocked provisioning requires causal terminal proof and recoverable ownership"

# Preserve both failure boundaries under falling demand. Missing guest evidence
# is infrastructure failure; a separately captured post-supervisor startup
# failure can be retired once the original committed staging outcome drains.
for failure_boundary in before-supervisor after-supervisor; do
    reset_fake_state
    : > "$FAKE_DIR/journal.log"
    : > "$FAKE_DIR/oscillate-worker-desired"
    if [ "$failure_boundary" = before-supervisor ]; then
        : > "$FAKE_DIR/fail-worker-launch"
    else
        : > "$FAKE_DIR/fail-worker-after-start"
    fi
    oscillation_status=0
    CLOUDBENCH_TEST_BARRIER_MIN=1 CLOUDBENCH_WORKER_STAGE_ATTEMPTS=2 \
        CLOUDBENCH_WORKER_READY_TIMEOUT=5 \
        run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-autoscaler-worker-oscillation-$failure_boundary.log" \
        autoscaler-worker-oscillation --timeout 240 || oscillation_status=$?
    if grep -qF 'metrics_lease_owner_pid: unbound variable' \
        "$TMP_ROOT/controller-autoscaler-worker-oscillation-$failure_boundary.log"; then
        fail "worker provisioner inherited the parent autoscaler cleanup trap"
    fi
    if [ "$failure_boundary" = before-supervisor ]; then
        [ "$oscillation_status" -ne 0 ] ||
            fail "lower demand must not accept missing worker runtime evidence"
        assert_and_reset_disposable_failed_benchmark autoscaler-worker-oscillation \
            "$TMP_ROOT/controller-autoscaler-worker-oscillation-$failure_boundary.log" passed ||
            fail "lower demand did not retain the failed run of uncaptured pre-supervisor evidence"
    else
        [ "$oscillation_status" -eq 0 ] || {
            cat "$TMP_ROOT/controller-autoscaler-worker-oscillation-$failure_boundary.log" >&2
            fail "a lower target must drain captured in-flight staging without failing the fleet"
        }
        [ -f "$FAKE_DIR/markers/worker-scale-down-complete" ] ||
            fail "the lower-target regression never completed worker cleanup"
        python3 - "$WS_A/.context/fleet/runs" "$TMP_ROOT/controller-autoscaler-worker-oscillation-$failure_boundary.log" <<'PY_FAILED_START' || fail "lower-target positive control did not capture a real failed startup"
import json
from pathlib import Path
import sys
root = Path(sys.argv[1]).resolve(strict=True)
paths = [line.split("execution provenance: ", 1)[1] for line in Path(sys.argv[2]).read_text().splitlines() if "execution provenance: " in line]
assert len(paths) == 1
run = Path(paths[0]).resolve(strict=True).parent
assert run.parent == root
output = run / "autoscaler-worker-oscillation"
assert (output / "cloudbench-run.json").is_file()
captures = list(output.glob("worker-runtime-evidence/*/capture"))
assert captures
for capture in captures:
    terminal = json.loads((capture / "receipts/terminal.json").read_text())
    assert terminal["exit_code"] == 1 and terminal["worker_started"] is False
    assert terminal["quiescent"] and terminal["children_reaped"] and terminal["streams_closed"]
    assert "fake worker terminal exit=1" in (capture / "logs/worker.log").read_text()
PY_FAILED_START
        remaining="$(python3 -c '
import json, sys
machines = json.load(open(sys.argv[1]))["machines"]
print(" ".join(sorted(m["name"] for m in machines)))
' "$FAKE_DIR/state.json")"
        [ "$remaining" = "cloudbench-warm" ] ||
            fail "captured lower-target teardown leaked machines: $remaining"
    fi
    rm -f "$FAKE_DIR/oscillate-worker-desired" "$FAKE_DIR/fail-worker-launch" "$FAKE_DIR/fail-worker-after-start"
done
echo "PASS: scenario 2g — lower demand retains missing evidence and drains captured staging"

# The sealed lifecycle keeps the run verdict (status) separate from proven cleanup and
# names the failed autoscaler's bench, so a deploy can keep its peers' verdicts.
assert_autoscaler_lifecycle() {  # <since-marker> <bench|-> <cleanup_verified: True|False>
    local lifecycle
    lifecycle="$(find "$WS_A/.context/fleet/runs" -path '*/_batch/lifecycle.json' -newer "$1" -print 2>/dev/null)"
    [ "$(printf '%s\n' "$lifecycle" | grep -c .)" = 1 ] ||
        fail "expected exactly one new fleet lifecycle, got: $lifecycle"
    python3 - "$lifecycle" "$2" "$3" <<'PY' || fail "autoscaler failure lifecycle evidence is wrong"
import json, sys
payload = json.loads(open(sys.argv[1]).read())
assert payload["status"] == "failed" and payload["controller_exit_code"] == 1, payload
# Retained resources keep the lifecycle unverified whether or not aggregation named the bench.
assert sys.argv[2] == "-" or payload["autoscaler_failed_benches"] == [sys.argv[2]], payload
assert payload["cleanup_verified"] is (sys.argv[3] == "True"), payload
PY
}

# A provider destroy failure after cancellation cannot leave a tracked worker
# permanently canceled if demand rebounds. The autoscaler must fail closed and
# retain durable ownership for controller cleanup, which is allowed to retry.
reset_fake_state
: > "$FAKE_DIR/journal.log"
: > "$FAKE_DIR/fail-worker-destroy-once"
: > "$TMP_ROOT/destroy-failure.since"
destroy_failure_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-autoscaler-worker-destroy-failure.log" \
    autoscaler-worker-destroy-failure --timeout 240 || destroy_failure_status=$?
[ "$destroy_failure_status" -ne 0 ] ||
    fail "failed worker scale-down destroy must fail the fleet closed"
[ -f "$FAKE_DIR/markers/worker-destroy-failed" ] ||
    fail "the worker destroy-failure regression never crossed its provider boundary"
grep -qF 'could not be destroyed during scale-down' \
    "$TMP_ROOT/controller-autoscaler-worker-destroy-failure.log" ||
    fail "failed worker scale-down destroy did not produce a stable fatal reason"
remaining="$(python3 -c '
import json, sys
machines = json.load(open(sys.argv[1]))["machines"]
print(" ".join(sorted(m["name"] for m in machines)))
' "$FAKE_DIR/state.json")"
[ "$remaining" = "cloudbench-warm" ] ||
    fail "destroy-failure cleanup leaked machines: $remaining"
assert_autoscaler_lifecycle "$TMP_ROOT/destroy-failure.since" autoscaler-worker-destroy-failure True
rm -f "$FAKE_DIR/fail-worker-destroy-once"
echo "PASS: scenario 2h — scale-down destroy failure fails closed and remains recoverable"

# A DELETE refused on every bounded retry must not be forgiven: the fleet fails
# closed and the exact worker, its Volume and durable ownership stay retained.
reset_fake_state
: > "$FAKE_DIR/journal.log"
# The destroy-once demand profile drives the same scale-down; the persistent
# refusal takes precedence over its single transient budget.
: > "$FAKE_DIR/fail-worker-destroy-once"
: > "$FAKE_DIR/fail-worker-destroy-always"
: > "$TMP_ROOT/destroy-persistent.since"
persistent_destroy_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-autoscaler-worker-destroy-persistent.log" \
    autoscaler-worker-destroy-failure --timeout 240 || persistent_destroy_status=$?
rm -f "$FAKE_DIR/fail-worker-destroy-always" "$FAKE_DIR/fail-worker-destroy-once"
[ "$persistent_destroy_status" -ne 0 ] ||
    fail "a persistently refused worker destroy must fail the fleet closed"
persistent_worker="$(sed -n 1p "$FAKE_DIR/markers/worker-clone-id" 2>/dev/null)"
[ -n "$persistent_worker" ] && fake_machine_exists "$persistent_worker" ||
    fail "a persistently refused worker destroy did not retain the exact worker Machine"
[ "$(grep -c "^machine destroy --force $persistent_worker " "$FAKE_DIR/journal.log")" -ge 2 ] ||
    fail "a refused worker destroy was not retried within the bounded cleanup budget"
persistent_registry="$(grep -rlx "id=$persistent_worker" "$SANDBOX/.git/cloudbench-fleet-ownership"/*/clones 2>/dev/null | head -1)"
[ -n "$persistent_registry" ] ||
    fail "a persistently refused worker destroy released its exact durable ownership"
assert_autoscaler_lifecycle "$TMP_ROOT/destroy-persistent.since" - False
# Remove only this asserted, test-owned retained fixture before later cases.
persistent_token="$(basename "$(dirname "$(dirname "$persistent_registry")")")"
rm -f "$TMP_ROOT/capacity-reservations/reservations/$persistent_token"-*
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership"
reset_fake_state
echo "PASS: scenario 2h2 — persistent destroy refusal retains the exact worker owner after bounded retries"

# Two provisioners may publish readiness while the autoscaler scales one worker
# down. Per-worker outcomes plus a sole aggregate writer must preserve the
# surviving worker's readiness proof without append-vs-rewrite loss.
reset_fake_state
: > "$FAKE_DIR/journal.log"
: > "$FAKE_DIR/concurrent-ready-scale-down"
concurrent_ready_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-autoscaler-concurrent-ready-scale-down.log" \
    autoscaler-concurrent-ready-scale-down --timeout 240 || concurrent_ready_status=$?
[ "$concurrent_ready_status" -eq 0 ] || {
    cat "$TMP_ROOT/controller-autoscaler-concurrent-ready-scale-down.log" >&2
    fail "concurrent worker readiness publication and scale-down must preserve surviving capacity"
}
[ -f "$FAKE_DIR/markers/worker-scale-down-complete" ] ||
    fail "the concurrent readiness regression never scaled one worker down"
worker_launches="$(grep -c 'setsid bash /tmp/rbw.sh' "$FAKE_DIR/journal.log" 2>/dev/null || true)"
[ "$worker_launches" -ge 2 ] ||
    fail "the concurrent readiness regression did not launch two workers"
remaining="$(python3 -c '
import json, sys
machines = json.load(open(sys.argv[1]))["machines"]
print(" ".join(sorted(m["name"] for m in machines)))
' "$FAKE_DIR/state.json")"
[ "$remaining" = "cloudbench-warm" ] ||
    fail "concurrent readiness teardown leaked machines: $remaining"
rm -f "$FAKE_DIR/concurrent-ready-scale-down"
echo "PASS: scenario 2i — concurrent ready publication and scale-down preserve surviving capacity"

# A benchmark may finish after a worker allocation and launch have committed but
# before that worker crosses the queue-readiness boundary. Child completion
# stops future capacity demand: the still-pending worker is retired with its
# captured runtime evidence instead of waiting for late readiness, and the
# autoscaler then proves its final invariant.
reset_fake_state
: > "$FAKE_DIR/journal.log"
: > "$FAKE_DIR/desired-two"
: > "$FAKE_DIR/worker-ready-after-child"
post_child_ready_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 CLOUDBENCH_WORKER_READY_TIMEOUT=30 \
    CLOUDBENCH_AUTOSCALER_FINALIZATION_WAIT_SECONDS=25 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-autoscaler-post-child-ready.log" \
    autoscaler-post-child-ready --timeout 240 || post_child_ready_status=$?
[ "$post_child_ready_status" -eq 0 ] || {
    cat "$TMP_ROOT/controller-autoscaler-post-child-ready.log" >&2
    fail "child completion must settle already-committed worker staging"
}
[ -f "$FAKE_DIR/markers/worker-ready-released-after-child" ] ||
    fail "the post-child readiness regression never crossed its delayed boundary"
grep -qF "1/1 passed" "$TMP_ROOT/controller-autoscaler-post-child-ready.log" ||
    fail "post-child worker readiness must preserve a passing fleet result"
python3 - "$WS_A/.context/fleet/runs" <<'PY_POST_CHILD_CAPTURE' || fail "a launched post-child worker was released without its captured runtime evidence"
import json, sys
from pathlib import Path
outputs = list(Path(sys.argv[1]).glob("*/autoscaler-post-child-ready"))
assert len(outputs) == 1
launched = [p.name[len("worker-"):-len(".launch-attempted")] for p in outputs[0].glob("worker-*.launch-attempted")]
assert launched
for machine_id in launched:
    capture = outputs[0] / "worker-runtime-evidence" / machine_id / "capture"
    terminal = json.loads((capture / "receipts/terminal.json").read_text())
    assert terminal["machine_id"] == machine_id
    assert terminal["quiescent"] and terminal["children_reaped"] and terminal["streams_closed"]
PY_POST_CHILD_CAPTURE
remaining="$(python3 -c '
import json, sys
machines = json.load(open(sys.argv[1]))["machines"]
print(" ".join(sorted(m["name"] for m in machines)))
' "$FAKE_DIR/state.json")"
[ "$remaining" = "cloudbench-warm" ] ||
    fail "post-child readiness teardown leaked machines: $remaining"
rm -f "$FAKE_DIR/desired-two" "$FAKE_DIR/worker-ready-after-child"
echo "PASS: scenario 2j — committed worker staging settles with evidence after benchmark child completion"

# Even fully satisfied capacity is only a mutable snapshot until the autoscaler
# publishes that it observed child completion after draining committed work.
# With a zero finalization budget the controller must fail this missing causal
# marker rather than accept a still-live autoscaler on counts alone.
reset_fake_state
: > "$FAKE_DIR/journal.log"
: > "$FAKE_DIR/desired-two"
: > "$FAKE_DIR/worker-ready-before-child-no-terminal"
missing_terminal_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 CLOUDBENCH_AUTOSCALER_FINALIZATION_WAIT_SECONDS=0 \
    CLOUDBENCH_TEST_HOLD_AUTOSCALER_AFTER_READY=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-autoscaler-missing-terminal.log" \
    autoscaler-missing-terminal --timeout 240 || missing_terminal_status=$?
[ "$missing_terminal_status" -ne 0 ] ||
    fail "satisfied capacity must not pass without causal autoscaler completion"
grep -qF "mandatory autoscaler did not confirm terminal completion" \
    "$TMP_ROOT/controller-autoscaler-missing-terminal.log" ||
    fail "missing autoscaler terminal proof did not produce a stable explicit failure"
remaining="$(python3 -c '
import json, sys
machines = json.load(open(sys.argv[1]))["machines"]
print(" ".join(sorted(m["name"] for m in machines)))
' "$FAKE_DIR/state.json")"
[ "$remaining" = "cloudbench-warm" ] ||
    fail "missing-terminal teardown leaked machines: $remaining"
rm -f "$FAKE_DIR/desired-two" "$FAKE_DIR/worker-ready-before-child-no-terminal"
echo "PASS: scenario 2k — capacity cannot pass without causal autoscaler completion"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 3 — stopped inventory cannot consume the active-compute ceiling
#
# Replay the production failure shape exactly: 54 app machines (23 started,
# 31 stopped) followed by one seven-benchmark smoke fleet. Stopped warm/pool
# inventory costs no compute and must not make the active burst look like 61.
# The real controller must admit the seven primaries, complete them, and reap
# exactly those seven without mutating any pre-existing machine.
# ════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
# Exact-clean prior hubs so the capacity governor replay does not inherit a
# foreign listener on the derived CONDUCTOR hub port from earlier scenarios.
reset_test_workspace_fleet_roots "$WS_A" "$WS_B"
FAKE_STATE="$FAKE_DIR/state.json" python3 - <<'PY'
import json
import os

path = os.environ["FAKE_STATE"]
with open(path) as fh:
    state = json.load(fh)

for index in range(23):
    state["machines"].append({
        "id": f"active{index:08d}",
        "name": f"existing-active-{index}",
        "state": "started",
        "region": "iad",
        "private_ip": f"fdaa::{index + 1}",
        "config": {"mounts": []},
    })
for index in range(30):
    state["machines"].append({
        "id": f"stopped{index:07d}",
        "name": f"existing-stopped-{index}",
        "state": "stopped",
        "region": "iad",
        "private_ip": "",
        "config": {"mounts": []},
    })

with open(path, "w") as fh:
    json.dump(state, fh)
PY

capacity_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 \
CLOUDBENCH_APP_MACHINE_CEILING=1000 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-capacity.log" \
    capacity-a capacity-b capacity-c capacity-d capacity-e capacity-f capacity-g \
    --timeout 240 || capacity_status=$?
[ "$capacity_status" -eq 0 ] ||
    fail "stopped inventory must not consume shared-compute capacity in the isolated CPU replay (exit=$capacity_status)"
grep -qF "7/7 passed" "$TMP_ROOT/controller-capacity.log" ||
    fail "capacity replay fleet summary must report 7/7 passed"
JOURNAL="$FAKE_DIR/journal.log" python3 - <<'PY' ||
import os

calls = open(os.environ["JOURNAL"]).read().splitlines()
updates = [index for index, call in enumerate(calls) if call.startswith("machine update ")]
starts = [index for index, call in enumerate(calls) if call.startswith("machine start ")]
if len(updates) < 7 or len(starts) < 7:
    raise SystemExit(f"expected seven update/start calls, got updates={len(updates)} starts={len(starts)}")
if max(updates[:7]) >= min(starts[:7]):
    raise SystemExit("a fleet machine started before every boot config update completed")
if any("--skip-start" not in calls[index] for index in updates[:7]):
    raise SystemExit("boot config updates must explicitly keep every machine stopped")
# Every primary's boot-config update publishes its admission lane so other workstreams'
# controllers can count it; these fixture tasks are not DEMO-cache tasks, so they are
# delegating. Warm-source sizing updates are not primaries and carry no lane.
boot_updates = [index for index in updates if "CLOUDBENCH_BOOT=1" in calls[index]]
if len(boot_updates) < 7:
    raise SystemExit(f"expected seven boot-config updates, got {len(boot_updates)}")
unlabelled = [calls[index][:240] for index in boot_updates if "rose_cloudbench_lane=delegating" not in calls[index]]
if unlabelled:
    raise SystemExit("boot config updates must label each primary with its admission lane: " + unlabelled[0])

# Once every boot config is applied, all readiness pollers must consume the
# controller-owned Machines/Volumes snapshots.  Direct provider inventory reads
# in this window must therefore remain bounded by the one snapshot loop instead
# of growing with the seven run-bench-cloud children.  The loop can refresh a
# few times while the fake fleet starts, but one Machines + one Volumes request
# per child would exceed this controller-level ceiling deterministically.
startup_window = calls[max(updates[:7]) + 1:max(starts[:7]) + 1]
inventory_reads = [
    call for call in startup_window
    if call.startswith("machines list ") or call.startswith("volumes list ")
]
if len(inventory_reads) > 8:
    raise SystemExit(
        "fleet startup issued child-scaled provider inventory reads "
        f"({len(inventory_reads)} > 8): {inventory_reads}"
    )
PY
    fail "capacity replay must configure the entire stopped fleet before any machine starts"

capacity_counts="$(FAKE_STATE="$FAKE_DIR/state.json" python3 - <<'PY'
import json
import os
from collections import Counter

with open(os.environ["FAKE_STATE"]) as fh:
    machines = json.load(fh)["machines"]
counts = Counter(machine["state"] for machine in machines)
print(f"{len(machines)} {counts['started']} {counts['stopped']}")
PY
)"
[ "$capacity_counts" = "54 23 31" ] ||
    fail "capacity replay must reap only its seven machines (got: $capacity_counts)"
echo "PASS: scenario 3 — stopped inventory does not consume active-compute capacity (Machine governor isolated)"

# ════════════════════════════════════════════════════════════════════════════
# Scenario 4 — the shared-CPU governor blocks an over-ceiling burst, while
# stopped + performance + unknown-state inventory are classified correctly.
# This scenario isolates the shared-CPU half of the dual capacity guard by
# explicitly lifting the independent Machine-count governor. Only ACTIVE shared
# units count toward the CPU governor; stopped inventory is compute-free,
# performance machines draw a SEPARATE reservation, and a non-stopped UNKNOWN
# state still consumes its shared units. A focused owner test separately proves
# that stopped inventory still counts toward Fly's physical Machine ceiling.
#
# #815 added the ELASTIC shared-CPU-unit governor (ceiling = governor − headroom
# = 160 − 20 = 140 units). The fixture reaches
# 144 active shared units (including one provider-unknown state), so two new
# primaries project to 148 and must be rejected before any clone.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
FAKE_STATE="$FAKE_DIR/state.json" python3 - <<'PY'
import json
import os

path = os.environ["FAKE_STATE"]
with open(path) as fh:
    state = json.load(fh)
def machine(mid, name, st, kind, cpus):
    return {
        "id": mid,
        "name": name,
        "state": st,
        "region": "iad",
        "private_ip": "fdaa::1",
        "config": {"mounts": [], "guest": {"cpu_kind": kind, "cpus": cpus}},
    }


# 71 STARTED shared-cpu-2x → 142 active shared units.
for index in range(71):
    state["machines"].append(machine(f"sh{index:09d}", f"active-shared-{index}", "started", "shared", 2))
# 1 non-stopped UNKNOWN state with a shared guest → still capacity-consuming (+2 = 144).
state["machines"].append(machine("unknown0000001", "active-unknown-shared", "provider-new-state", "shared", 2))
# 15 STOPPED shared machines → EXCLUDED (stopped inventory costs no compute).
for index in range(15):
    state["machines"].append(machine(f"st{index:09d}", f"stopped-shared-{index}", "stopped", "shared", 2))
# 5 STARTED performance machines → SEPARATE reservation, never block the shared governor.
for index in range(5):
    state["machines"].append(machine(f"pf{index:09d}", f"active-perf-{index}", "started", "performance", 2))
with open(path, "w") as fh:
    json.dump(state, fh)
PY

# Default primary shape shared-cpu-2x (2 units/bench); 2 benches = 4 requested units.
# active_shared = 71*2 + 1*2 = 144; projected = 148 > ceiling 140 → hard block. The
# 15 stopped + 5 performance machines must NOT contribute (else active_shared > 144).
# The fixture's live work never releases, so a bounded admission wait only
# delays the same rejection while still exercising the retry loop.
capacity_status=0
CLOUDBENCH_SHARED_CPU_GOVERNOR=160 CLOUDBENCH_SHARED_CPU_HEADROOM=20 \
CLOUDBENCH_APP_MACHINE_CEILING=1000 CLOUDBENCH_DELEGATING_PRIMARY_CEILING=1000 \
CLOUDBENCH_FLEET_PRIMARY_VM_SIZE=shared-cpu-2x \
CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS=10 \
CLOUDBENCH_CAPACITY_ADMISSION_RETRY_SECONDS=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-active-capacity.log" \
    capacity-h capacity-i --timeout 240 || capacity_status=$?
[ "$capacity_status" -eq 1 ] ||
    fail "over-ceiling shared-CPU burst must be blocked (exit=$capacity_status)"
grep -qF "Shared-CPU capacity governor reached: 144 active shared units" "$TMP_ROOT/controller-active-capacity.log" ||
    fail "governor rejection must report the active shared-unit count (stopped + perf excluded, unknown counted)"
grep -qF "this run's 2 primaries (4 units) = 148" "$TMP_ROOT/controller-active-capacity.log" ||
    fail "active capacity rejection must report the projected shared-unit total"
grep -qF "ceiling 140 (governor 160" "$TMP_ROOT/controller-active-capacity.log" ||
    fail "active capacity rejection must report the governor ceiling"
grep -qF "capacity admission remained blocked for 10s" "$TMP_ROOT/controller-active-capacity.log" ||
    fail "a governor denial is retryable and must exhaust the admission wait before failing"
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then
    fail "an over-governor burst must be rejected BEFORE cloning"
fi
echo "PASS: scenario 4 — shared-CPU governor blocks an over-ceiling burst; stopped + perf excluded"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 4b — cross-workstream lane ceilings (the downstream capacity the old
# 56-Machine ceiling used to imply). Every devbox's live primaries are counted from
# the native app inventory: DEMO guests against the production-pooler budget, and
# REAL/SIM ("delegating") guests against the widest proven-safe width. Stopped and
# suspended Machines and performance-1x autoscaler workers never count; unlabelled
# live primaries count as delegating. A denial happens before any clone.
# ═════════════════════════════════════════════════════════════════════════════
lane_fixture() {  # lane_fixture <demo-live> <delegating-labelled> <delegating-unlabelled>
    reset_fake_state
    rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
        "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
    mkdir -p "$FAKE_DIR/markers"
    : > "$FAKE_DIR/journal.log"
    reset_test_workspace_fleet_roots "$WS_A" "$WS_B"
    FAKE_STATE="$FAKE_DIR/state.json" LANE_FIXTURE="$1 $2 $3" python3 - <<'PY'
import json
import os

path = os.environ["FAKE_STATE"]
demo, labelled, unlabelled = (int(v) for v in os.environ["LANE_FIXTURE"].split())
with open(path) as fh:
    state = json.load(fh)
def machine(mid, st, kind, cpus, lane=None):
    config = {"mounts": [], "guest": {"cpu_kind": kind, "cpus": cpus}}
    if lane:
        config["metadata"] = {"rose_cloudbench_lane": lane}
    return {"id": mid, "name": f"lane-{mid}", "state": st, "region": "iad",
            "private_ip": "fdaa::1", "config": config}
rows = []
rows += [machine(f"dm{i:010d}", "started", "shared", 4, "demo") for i in range(demo)]
rows += [machine(f"dl{i:010d}", "started", "shared", 4, "delegating") for i in range(labelled)]
rows += [machine(f"un{i:010d}", "started", "shared", 4) for i in range(unlabelled)]
# Never counted: stopped/suspended DEMO guests, performance-1x workers, infra probes.
rows += [machine(f"ds{i:010d}", "stopped", "shared", 4, "demo") for i in range(5)]
rows += [machine(f"dz{i:010d}", "suspended", "shared", 4, "demo") for i in range(3)]
rows += [machine(f"wk{i:010d}", "started", "performance", 1) for i in range(12)]
rows += [machine(f"ip{i:010d}", "started", "shared", 4, "infra") for i in range(2)]
state["machines"].extend(rows)
with open(path, "w") as fh:
    json.dump(state, fh)
PY
}

lane_fixture 49 0 0
lane_status=0
CLOUDBENCH_SHARED_CPU_GOVERNOR=100000 CLOUDBENCH_APP_MACHINE_CEILING=100000 \
CLOUDBENCH_LANE=demo CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS=3 CLOUDBENCH_CAPACITY_ADMISSION_RETRY_SECONDS=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-lane-demo.log" \
    capacity-a capacity-b --timeout 120 || lane_status=$?
[ "$lane_status" -eq 1 ] || fail "a DEMO burst past the pooler budget must be refused (exit=$lane_status)"
grep -qF "DEMO guest ceiling reached: 49 live + 2 requested > 50" "$TMP_ROOT/controller-lane-demo.log" ||
    fail "DEMO refusal must count live DEMO guests only (stopped/suspended/workers/infra excluded)"
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then
    fail "a DEMO lane refusal must happen before cloning"
fi

lane_fixture 0 60 6
lane_status=0
CLOUDBENCH_SHARED_CPU_GOVERNOR=100000 CLOUDBENCH_APP_MACHINE_CEILING=100000 \
CLOUDBENCH_LANE=delegating CLOUDBENCH_DELEGATING_PRIMARY_CEILING=67 \
CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS=3 CLOUDBENCH_CAPACITY_ADMISSION_RETRY_SECONDS=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-lane-delegating.log" \
    capacity-a capacity-b --timeout 120 || lane_status=$?
[ "$lane_status" -eq 1 ] || fail "a delegating burst past its ceiling must be refused (exit=$lane_status)"
grep -qF "Delegating-guest ceiling reached: 66 live REAL/SIM primaries + 2 requested > 67" \
    "$TMP_ROOT/controller-lane-delegating.log" ||
    fail "delegating refusal must count labelled and unlabelled live primaries, not workers or infra"
grep -qF "capacity admission remained blocked for 3s" "$TMP_ROOT/controller-lane-delegating.log" ||
    fail "a lane refusal is retryable and must exhaust the admission wait before failing"
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then
    fail "a delegating lane refusal must happen before cloning"
fi
echo "PASS: scenario 4b — DEMO and delegating lane ceilings count every workstream's live primaries"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 5 — pre-ack quarantine survives deletion of the workspace-local ledger
#
# Clone acceptance is the irreversible boundary: Fly has allocated a billable
# machine, but the controller can still die before its EXIT trap. Reproduce that
# exact window by holding fake flyctl after allocation, SIGKILLing the whole
# controller tree, and deleting .context/fleet. A successor worktree must honor
# the durable unconfirmed sentinel outside that disposable workspace and leave
# the exact machine untouched.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
reset_test_workspace_fleet_roots "$WS_A" "$WS_B"
rm -f "$POOL_A" "$POOL_B"
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership"
: > "$FAKE_DIR/journal.log"

CLOUDBENCH_TEST_BARRIER_MIN=2 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-orphan-source.log" \
    orphan-source --timeout 240 &
ORPHAN_CONTROLLER_PID=$!
PIDS+=("$ORPHAN_CONTROLLER_PID")

orphan_id=""
orphan_name=""
for _ in $(seq 1 100); do
    orphan_pair="$(FAKE_STATE="$FAKE_DIR/state.json" python3 - <<'PY'
import json
import os

with open(os.environ["FAKE_STATE"]) as fh:
    machines = json.load(fh)["machines"]
clone = next((machine for machine in machines if machine["name"] != "cloudbench-warm"), None)
if clone:
    print(clone["id"], clone["name"])
PY
)"
    orphan_id="$(printf '%s' "$orphan_pair" | awk '{print $1}')"
    orphan_name="$(printf '%s' "$orphan_pair" | awk '{print $2}')"
    [ -n "$orphan_id" ] && break
    sleep 0.1
done
[ -n "$orphan_id" ] || fail "orphan source controller never crossed Fly clone acceptance"

# Kill every descendant first so the blocked flyctl clone cannot finish and let
# a shell descendant run teardown after its parent is gone. SIGKILL intentionally
# cannot execute EXIT traps, matching a crashed app/host or forcibly deleted run.
ORPHAN_ROOT_PID="$ORPHAN_CONTROLLER_PID" python3 - <<'PY'
import os
import signal
import subprocess

root = int(os.environ["ORPHAN_ROOT_PID"])
rows = subprocess.check_output(["ps", "-axo", "pid=,ppid="], text=True).splitlines()
children = {}
for row in rows:
    pid, ppid = map(int, row.split())
    children.setdefault(ppid, []).append(pid)
order = []
stack = list(children.get(root, []))
while stack:
    pid = stack.pop()
    order.append(pid)
    stack.extend(children.get(pid, []))
for pid in reversed(order):
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
try:
    os.kill(root, signal.SIGKILL)
except ProcessLookupError:
    pass
PY
wait "$ORPHAN_CONTROLLER_PID" 2>/dev/null || true
PIDS=()

# Fly reports this accepted clone as started while no driver exists. Then remove
# the only ownership artifact the buggy controller used to have.
FAKE_STATE="$FAKE_DIR/state.json" ORPHAN_ID="$orphan_id" python3 - <<'PY'
import json
import os

path = os.environ["FAKE_STATE"]
with open(path) as fh:
    state = json.load(fh)
machine = next(item for item in state["machines"] if item["id"] == os.environ["ORPHAN_ID"])
machine["state"] = "started"
machine["runner_count"] = 0
with open(path, "w") as fh:
    json.dump(state, fh)
PY
reset_test_workspace_fleet_roots "$WS_A"
rm -rf "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"

recovery_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-orphan-recovery.log" \
    orphan-recovery --timeout 240 || recovery_status=$?
[ "$recovery_status" -eq 0 ] ||
    fail "successor controller must account for a retained pre-ack owner (exit=$recovery_status)"

orphan_registry=""
for registry in "$SANDBOX/.git/cloudbench-fleet-ownership"/*; do
    [ -d "$registry" ] || continue
    if grep -RqxF "name=$orphan_name" "$registry/clones" 2>/dev/null; then
        orphan_registry="$registry"
        break
    fi
done
[ -n "$orphan_registry" ] || fail "SIGKILL orphan lost its durable owner registry"
[ "$(sed -n 's/^cleanup_policy=//p' "$orphan_registry/meta")" = retain ] ||
    fail "SIGKILL orphan became reapable without a guest acknowledgement"
[ -e "$orphan_registry/guest-cleanup-unconfirmed" ] ||
    fail "SIGKILL orphan lost its durable guest-cleanup quarantine"
fake_machine_exists "$orphan_id" ||
    fail "successor destroyed pre-ack SIGKILL orphan $orphan_id ($orphan_name)"
if grep -qE "^machine destroy ${orphan_id}( |$)" "$FAKE_DIR/journal.log"; then
    fail "pre-ack SIGKILL orphan crossed the successor provider-reap boundary"
fi
orphan_owner_token="${orphan_registry##*/}"
orphan_volume="$(FAKE_STATE="$FAKE_DIR/state.json" ORPHAN_ID="$orphan_id" python3 - <<'PY'
import json
import os

with open(os.environ["FAKE_STATE"]) as handle:
    machines = json.load(handle)["machines"]
machine = next(item for item in machines if item.get("id") == os.environ["ORPHAN_ID"])
mounts = (machine.get("config") or {}).get("mounts") or []
print(mounts[0].get("volume", "") if mounts else "")
PY
)"
[ -n "$orphan_volume" ] || fail "retained SIGKILL orphan lost its exact volume identity"
remove_fake_machine_and_volume_exact "$orphan_id" "$orphan_volume" ||
    fail "could not exact-clean the retained SIGKILL orphan fixture"
rm -rf "$orphan_registry"
rm -f "$TMP_ROOT/capacity-reservations/reservations/${orphan_owner_token}-"* 2>/dev/null || true
echo "PASS: scenario 5 — pre-ack quarantine survived SIGKILL and workspace-ledger deletion"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 6 — stale ownership with an active runner fails closed
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
reset_test_workspace_fleet_roots "$WS_A" "$WS_B"
rm -f "$POOL_A" "$POOL_B"
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"

CLOUDBENCH_TEST_BARRIER_MIN=2 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-busy-source.log" \
    busy-source --timeout 240 &
BUSY_CONTROLLER_PID=$!
PIDS+=("$BUSY_CONTROLLER_PID")
busy_id=""
for _ in $(seq 1 100); do
    busy_id="$(FAKE_STATE="$FAKE_DIR/state.json" python3 - <<'PY'
import json
import os

with open(os.environ["FAKE_STATE"]) as fh:
    machines = json.load(fh)["machines"]
clone = next((machine for machine in machines if machine["name"] != "cloudbench-warm"), None)
if clone:
    print(clone["id"])
PY
)"
    [ -n "$busy_id" ] && break
    sleep 0.1
done
[ -n "$busy_id" ] || fail "busy orphan source never crossed Fly clone acceptance"
ORPHAN_ROOT_PID="$BUSY_CONTROLLER_PID" python3 - <<'PY'
import os
import signal
import subprocess

root = int(os.environ["ORPHAN_ROOT_PID"])
rows = subprocess.check_output(["ps", "-axo", "pid=,ppid="], text=True).splitlines()
children = {}
for row in rows:
    pid, ppid = map(int, row.split())
    children.setdefault(ppid, []).append(pid)
stack = list(children.get(root, []))
order = []
while stack:
    pid = stack.pop()
    order.append(pid)
    stack.extend(children.get(pid, []))
for pid in reversed(order):
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
try:
    os.kill(root, signal.SIGKILL)
except ProcessLookupError:
    pass
PY
wait "$BUSY_CONTROLLER_PID" 2>/dev/null || true
PIDS=()
FAKE_STATE="$FAKE_DIR/state.json" BUSY_ID="$busy_id" python3 - <<'PY'
import json
import os

path = os.environ["FAKE_STATE"]
with open(path) as fh:
    state = json.load(fh)
machine = next(item for item in state["machines"] if item["id"] == os.environ["BUSY_ID"])
machine["state"] = "started"
machine["runner_count"] = 1
with open(path, "w") as fh:
    json.dump(state, fh)
PY
busy_registry="$(find "$SANDBOX/.git/cloudbench-fleet-ownership" -mindepth 1 -maxdepth 1 \
    -type d -print -quit 2>/dev/null)"
[ -n "$busy_registry" ] || fail "busy orphan lost its durable owner registry"
# Scenario 2-cancel and scenario 5 cover the pre-ack sentinel. This scenario
# targets the next independent safety gate, so model an owner whose guest
# cleanup and complete runtime evidence were already confirmed, making this
# exact owner eligible for stale recovery. Unconfirmed evidence is exercised
# separately by the cancellation and pre-ack quarantine scenarios.
awk '
    /^cleanup_policy=/ { print "cleanup_policy=reap"; next }
    { print }
' "$busy_registry/meta" > "$busy_registry/meta.tmp" \
    && mv "$busy_registry/meta.tmp" "$busy_registry/meta" \
    || fail "could not establish post-confirmation stale-owner fixture"
rm -f "$busy_registry/guest-cleanup-unconfirmed" \
    "$busy_registry/runtime-evidence-unconfirmed"
reset_test_workspace_fleet_roots "$WS_A"
rm -rf "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
# Assertions below concern the successor's fail-closed behavior only; the
# source controller necessarily cloned once to create the stale-owned fixture.
: > "$FAKE_DIR/journal.log"

busy_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-busy-recovery.log" \
    must-not-launch --timeout 240 || busy_status=$?
[ "$busy_status" -eq 1 ] || fail "active-runner stale ownership must fail closed (exit=$busy_status)"
busy_record="$(find "$busy_registry/clones" -mindepth 1 -maxdepth 1 -type f -print -quit)"
busy_name="$(sed -n 's/^name=//p' "$busy_record")"
busy_audit="$(sed -n 's/^audit_dir=//p' "$busy_registry/meta")/fresh/$busy_name"
BUSY_RECORD="$busy_record" BUSY_AUDIT="$busy_audit" BUSY_ID="$busy_id" \
    python3 - <<'PY' || fail "stale recovery did not bind exact identity in both registry and original audit"
import os
from pathlib import Path

def fields(path):
    result = {}
    for raw in Path(path).read_text().splitlines():
        key, separator, value = raw.partition("=")
        if not separator or key in result:
            raise SystemExit(1)
        result[key] = value
    return result

registry = fields(os.environ["BUSY_RECORD"])
audit = fields(os.environ["BUSY_AUDIT"])
machine_id = os.environ["BUSY_ID"]
if (
    registry.get("id") != machine_id
    or not registry.get("volume_id")
    or audit.get("machine_id") != machine_id
    or audit.get("volume_id") != registry["volume_id"]
    or audit.get("disposition") != "owned"
):
    raise SystemExit(1)
PY
grep -qF "refusing to reap stale fleet machine $busy_id: runner count=1" "$TMP_ROOT/controller-busy-recovery.log" ||
    fail "fail-closed recovery must report the exact active-runner reason"
if grep -qE '^machine destroy .*'"$busy_id" "$FAKE_DIR/journal.log"; then
    fail "fail-closed recovery must never destroy a stale machine with an active runner"
fi
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then
    fail "fail-closed recovery must not provision after an uncertain/active stale owner"
fi
echo "PASS: scenario 6 — active-runner stale ownership blocks destroy and provisioning"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 7 — name-only ownership survives a provider visibility gap; the same
# role-agnostic registry also recovers an autoscaler worker clone.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
owner_host="$(hostname 2>/dev/null || uname -n)"
delayed_name="cloudbench-aaa-delayed-provider"
same_registry_worker_name="cloudbench-aab-same-registry-worker"
same_registry_worker_id="a5705ca1e00000"
worker_name="cloudbench-zzz-autoscaler-worker"
worker_id="a5705ca1e00001"
write_dead_registry aaa-delayed-name reap "$owner_host" "$delayed_name"
{
    printf 'name=%s\n' "$same_registry_worker_name"
    printf 'id=%s\n' "$same_registry_worker_id"
    printf 'volume_id=vol_%s\n' "$same_registry_worker_id"
} > "$SANDBOX/.git/cloudbench-fleet-ownership/aaa-delayed-name/clones/$same_registry_worker_name"
write_dead_registry zzz-autoscaler-worker reap "$owner_host" "$worker_name" "$worker_id" autoscaler-worker
add_fake_machine "$same_registry_worker_id" "$same_registry_worker_name" started 0
add_fake_machine "$worker_id" "$worker_name" started 0

delayed_status=0
CLOUDBENCH_CLONE_LOOKUP_SECONDS=1 CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-delayed-name.log" \
    must-wait-for-provider --timeout 240 || delayed_status=$?
[ "$delayed_status" -eq 1 ] || fail "name-only provider gap must fail closed (exit=$delayed_status)"
grep -qF "retaining ownership and refusing to provision" "$TMP_ROOT/controller-delayed-name.log" ||
    fail "name-only provider gap must retain its durable ownership record"
[ -f "$SANDBOX/.git/cloudbench-fleet-ownership/aaa-delayed-name/clones/$delayed_name" ] ||
    fail "name-only durable record was discarded before provider visibility"
fake_machine_exists "$same_registry_worker_id" &&
    fail "one unresolved record must not prevent reaping a later known ID in the same registry"
fake_machine_exists "$worker_id" &&
    fail "one unresolved registry must not prevent reaping a later known-ID registry"
grep -qF "reaping stale fleet machine $same_registry_worker_id" "$TMP_ROOT/controller-delayed-name.log" ||
    fail "same-registry known-ID cleanup did not continue after the unresolved record"
grep -qF "reaping stale fleet machine $worker_id" "$TMP_ROOT/controller-delayed-name.log" ||
    fail "cross-registry known-ID cleanup did not continue after the unresolved registry"
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then
    fail "name-only uncertainty must block new provisioning"
fi

delayed_id="de1a9ed0000001"
add_fake_machine "$delayed_id" "$delayed_name" started 0
rm -rf "$FAKE_DIR/markers"; mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
CLOUDBENCH_CLONE_LOOKUP_SECONDS=1 CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-delayed-visible.log" \
    delayed-visible --timeout 240 || fail "late-visible owned clone recovery failed"
fake_machine_exists "$delayed_id" && fail "late-visible name-only clone was not reaped"
fake_machine_exists "$same_registry_worker_id" && fail "same-registry worker was not reaped"
fake_machine_exists "$worker_id" && fail "durably owned autoscaler worker was not reaped"
echo "PASS: scenario 7 — delayed name and autoscaler ownership recover without orphaning"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 8 — durable pool handoff + cross-workspace dead-claim recovery.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
# Legacy --provision-pool is refused (043659fa8). Seed the existing stopped
# pool member exactly as a completed handoff leaves it: one stopped Machine and
# Volume, the git-common ledger and its production dependency baseline.
pool_id="$(python3 -c 'import uuid; print(uuid.uuid4().hex[:14])')"
pool_b_id="$(python3 -c 'import uuid; print(uuid.uuid4().hex[:14])')"
add_fake_machine "$pool_id" "cloudbench-pool-$pool_id" stopped 0
add_fake_machine "$pool_b_id" "cloudbench-pool-$pool_b_id" stopped 0
# Give the donor and members the native identity a real stopped pool carries.
FAKE_STATE="$FAKE_DIR/state.json" POOL_IDS="$pool_id $pool_b_id" python3 - <<'PY'
import json, os
path = os.environ["FAKE_STATE"]
state = json.load(open(path))
image = "registry.fly.io/navi-whisper-lux-bench@sha256:" + "a" * 64
members = os.environ["POOL_IDS"].split()
for machine in state["machines"]:
    if machine["id"] in ["aaaa0000000001", *members]:
        machine["config"]["image"] = image
for machine in state["machines"]:
    if machine["id"] in members:
        machine["config"].update({"restart": {"policy": "no"}, "init": {"cmd": ["bash", "/cloudbench-boot.sh"]},
                                  "env": {}, "guest": {"cpu_kind": "shared", "cpus": 2, "memory_mb": 4096}})
        machine["config"]["mounts"][0]["path"] = "/data"
json.dump(state, open(path, "w"))
PY
mkdir -p "$(dirname "$POOL_A")"
printf '%s\n' "$pool_id" > "$POOL_A"
printf '%s %s %s\n' "$(cloudbench_node_dependency_fingerprint "$WS_A")" \
    "$(cloudbench_manifest_fingerprint "$WS_A" "${CLOUDBENCH_PYTHON_MANIFESTS[@]}")" snap_0001 \
    > "$POOL_A.deps"
[ -s "$POOL_A.deps" ] && ! grep -q '^ \| $' "$POOL_A.deps" ||
    fail "scenario 8 could not seed the pool dependency baseline"

# Simulate WS_A disappearing after its claimed pool machine starts. WS_B scans
# every durable pool ledger, proves the dead same-host claim and zero runners,
# and stops it even though WS_B has a different pool basename.
# Claims must match production write_pool_claim shape (rich audit-linked form);
# a legacy host/pid/pid_start-only claim takes the unaudited stop-and-release
# path and never writes borrowed-pool teardown semantics.
mkdir -p "$SANDBOX/.git/cloudbench-pool-claims" \
    "$SANDBOX/.git/cloudbench-fleet-audits"
dead_pool_token="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
pool_volume_id="$(FAKE_STATE="$FAKE_DIR/state.json" POOL_ID="$pool_id" python3 - <<'PY'
import json, os
with open(os.environ["FAKE_STATE"]) as fh:
    machine = next(item for item in json.load(fh)["machines"] if item["id"] == os.environ["POOL_ID"])
print(((machine.get("config") or {}).get("mounts") or [{}])[0].get("volume") or "")
PY
)"
[ -n "$pool_volume_id" ] || fail "provisioned pool machine has no durable volume attribution"
pool_meta_sha256="$(python3 -c 'import hashlib, pathlib, sys; print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())' "$POOL_A.deps")"
mkdir -p "$SANDBOX/.git/cloudbench-fleet-audits/$dead_pool_token/pool"
cat > "$SANDBOX/.git/cloudbench-fleet-audits/$dead_pool_token/meta" <<EOF
version=1
app=${FLEET_BENCH_APP}
fleet_owner_token=$dead_pool_token
host=$owner_host
pid=999999
pid_start=Mon Jan  1 00:00:00 2001
run_id=dead-ws-a-pool-claim
workspace_root=$WS_A
runs_root=$WS_A/.context/fleet/runs
audit_dir=$SANDBOX/.git/cloudbench-fleet-audits/$dead_pool_token
owned_ids_file=$SANDBOX/.git/cloudbench-fleet-audits/$dead_pool_token/owned-clones.ids
owned_names_file=$SANDBOX/.git/cloudbench-fleet-audits/$dead_pool_token/owned-clones.names
cleanup_policy=reap
EOF
: > "$SANDBOX/.git/cloudbench-fleet-audits/$dead_pool_token/owned-clones.ids"
: > "$SANDBOX/.git/cloudbench-fleet-audits/$dead_pool_token/owned-clones.names"
# Production write_pool_claim also seals an exact borrowed-pool audit row before
# the controller can crash; recover validates against that record.
cat > "$SANDBOX/.git/cloudbench-fleet-audits/$dead_pool_token/pool/$pool_id" <<EOF
version=1
fleet_owner_token=$dead_pool_token
run_id=dead-ws-a-pool-claim
app=${FLEET_BENCH_APP}
source=borrowed-pool
machine_id=$pool_id
volume_id=$pool_volume_id
pool_ledger_file=$POOL_A
pool_meta_file=$POOL_A.deps
pool_meta_sha256=$pool_meta_sha256
disposition=claimed
EOF
cat > "$SANDBOX/.git/cloudbench-pool-claims/$pool_id" <<EOF
host=$owner_host
pid=999999
pid_start=Mon Jan  1 00:00:00 2001
fleet_owner_token=$dead_pool_token
cleanup_state=owned
machine_id=$pool_id
volume_id=$pool_volume_id
pool_ledger_file=$POOL_A
pool_meta_file=$POOL_A.deps
pool_meta_sha256=$pool_meta_sha256
EOF
FAKE_STATE="$FAKE_DIR/state.json" POOL_ID="$pool_id" python3 - <<'PY'
import json
import os

path = os.environ["FAKE_STATE"]
with open(path) as fh:
    state = json.load(fh)
machine = next(item for item in state["machines"] if item["id"] == os.environ["POOL_ID"])
machine["state"] = "started"
machine["runner_count"] = 0
with open(path, "w") as fh:
    json.dump(state, fh)
PY
# Preflight the exact production validate against the seeded claim before WS_B
# starts. A fixture that only fails inside the controller is an env-leak bug;
# a fixture that fails here is a seed-shape bug.
(
    set -euo pipefail
    GIT_COMMON_DIR="$SANDBOX/.git"
    FLEET_AUDIT_ROOT="$GIT_COMMON_DIR/cloudbench-fleet-audits"
    APP="$FLEET_BENCH_APP"
    registry_meta_value() { sed -n "s/^${2}=//p" "$1" 2>/dev/null | head -1; }
    fleet_src="$WS_B/scripts/run-bench-fleet"
    [ -f "$fleet_src" ] || fleet_src="$ROOT_DIR/scripts/run-bench-fleet"
    eval "$(FLEET_SRC="$fleet_src" python3 - <<'PY'
from pathlib import Path
import os
text = Path(os.environ["FLEET_SRC"]).read_text()
start = text.index("fleet_audit_update_recovered_pool_machine() {")
end = text.index("\nfleet_audit_update_recovered_transfer() {", start)
print(text[start:end])
PY
)"
    fleet_audit_update_recovered_pool_machine \
        "$SANDBOX/.git/cloudbench-pool-claims/$pool_id" validate-only
) || fail "scenario 8 seeded dead pool claim failed production audit validate before WS_B"
# Exact-clean both workspaces so WS_B recovery does not inherit scenario-7 hub
# ownership races while scanning the durable dead claim.
reset_test_workspace_fleet_roots "$WS_A" "$WS_B"
rm -rf "$FAKE_DIR/markers"; mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
# Ordinary runs are disposable and never touch pools; the supported existing-
# pool path is explicit reuse. WS_B borrows its own stopped member while its
# pool reconciliation recovers WS_A's dead claim.
printf '%s\n' "$pool_b_id" > "$POOL_B"
cp "$POOL_A.deps" "$POOL_B.deps"
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-cross-pool-recovery.log" \
    cross-pool-recovery --reuse-pool-only --timeout 240 || fail "WS_B could not recover deleted WS_A pool claim"
grep -qF "recovering dead-claimed idle pool machine $pool_id" "$TMP_ROOT/controller-cross-pool-recovery.log" ||
    fail "cross-workspace dead pool claim recovery was not reported"
[ ! -f "$SANDBOX/.git/cloudbench-pool-claims/$pool_id" ] ||
    fail "verified stopped dead pool claim was not released"
pool_state="$(FAKE_STATE="$FAKE_DIR/state.json" POOL_ID="$pool_id" python3 - <<'PY'
import json
import os
with open(os.environ["FAKE_STATE"]) as fh:
    machine = next(item for item in json.load(fh)["machines"] if item["id"] == os.environ["POOL_ID"])
print(machine["state"])
PY
)"
[ "$pool_state" = "stopped" ] || fail "cross-workspace recovered pool machine must remain stopped"
pool_success_bench_dir="$(find "$WS_B/.context/fleet/runs" \
    -path '*/cross-pool-recovery/.cid' -type f -print | head -1 | xargs dirname)"
pool_success_fleet_dir="${pool_success_bench_dir%/cross-pool-recovery}"
pool_success_audit="$(cat "$pool_success_fleet_dir/teardown-ownership.path")"
# Durable borrowed-pool semantics live on the dead claim's exact audit (token),
# not on the successor run's fresh-clone teardown staging directory.
pool_success_record="$SANDBOX/.git/cloudbench-fleet-audits/$dead_pool_token/pool/$pool_id"
[ -f "$pool_success_record" ] \
    || pool_success_record="$pool_success_audit/pool/$pool_id"
[ "$(sed -n 's/^source=//p' "$pool_success_record")" = "borrowed-pool" ] \
    || fail "borrowed pool ownership must retain its source semantics"
[ "$(sed -n 's/^disposition=//p' "$pool_success_record")" \
    = "returned-stopped-claim-released" ] \
    || fail "returned pool ownership must record its verified terminal disposition"
echo "PASS: scenario 8 — pool handoff and deleted-workspace claim recover durably"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 9 — cleanup stop failure retains its exact pool claim.
# ═════════════════════════════════════════════════════════════════════════════
# Make WS_B own the existing stopped pool, then force Fly's cleanup stop to be a
# no-op. The controller may fail, but it must leave an auditable claim behind.
# Ordinary runs are disposable; explicit --reuse-pool-only claims the pool.
cp "$POOL_A" "$POOL_B"
cp "$POOL_A.deps" "$POOL_B.deps"
FAKE_STATE="$FAKE_DIR/state.json" POOL_ID="$pool_id" python3 - <<'PY'
import json
import os
path = os.environ["FAKE_STATE"]
with open(path) as fh:
    state = json.load(fh)
machine = next(item for item in state["machines"] if item["id"] == os.environ["POOL_ID"])
machine["ignore_stop"] = True
with open(path, "w") as fh:
    json.dump(state, fh)
PY
rm -rf "$FAKE_DIR/markers"; mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
stop_fail_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 CLOUDBENCH_POOL_STOP_ATTEMPTS=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-pool-stop-failure.log" \
    pool-stop-failure --reuse-pool-only --timeout 240 || stop_fail_status=$?
[ "$stop_fail_status" -eq 1 ] || fail "unverified pool stop must fail cleanup (exit=$stop_fail_status)"
[ -f "$SANDBOX/.git/cloudbench-pool-claims/$pool_id" ] ||
    fail "cleanup discarded the claim even though stop never verified"
grep -qF "retaining ownership claim" "$TMP_ROOT/controller-pool-stop-failure.log" ||
    fail "cleanup stop failure must report retained ownership"
pool_failure_bench_dir="$(find "$WS_B/.context/fleet/runs" \
    -path '*/pool-stop-failure/.cid' -type f -print | head -1 | xargs dirname)"
pool_failure_fleet_dir="${pool_failure_bench_dir%/pool-stop-failure}"
pool_failure_audit="$(cat "$pool_failure_fleet_dir/teardown-ownership.path")"
pool_failure_record="$pool_failure_audit/pool/$pool_id"
[ "$(sed -n 's/^source=//p' "$pool_failure_record")" = "borrowed-pool" ] \
    || fail "failed pool cleanup omitted its exact borrowed-pool ownership"
[ -n "$(sed -n 's/^volume_id=//p' "$pool_failure_record")" ] \
    || fail "failed pool cleanup omitted its exact volume ownership"
[ "$(sed -n 's/^disposition=//p' "$pool_failure_record")" = "claimed" ] \
    || fail "failed pool cleanup falsely recorded a terminal disposition"
[ "$(sed -n 's/^status=//p' \
    "$pool_failure_audit/meta")" = "incomplete" ] \
    || fail "failed pool cleanup must retain an incomplete manifest"
echo "PASS: scenario 9 — failed pool stop retains ownership and exits nonzero"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 10 — retain/other-host safety and malformed/probe-error fail closed.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
retain_id="e7a10000000001"; remote_id="07e20000000001"
retain_name="cloudbench-retain-debug"; remote_name="cloudbench-remote-owner"
write_dead_registry retain-debug retain "$owner_host" "$retain_name" "$retain_id"
write_dead_registry remote-owner reap other-host.example "$remote_name" "$remote_id"
add_fake_machine "$retain_id" "$retain_name" started 0
add_fake_machine "$remote_id" "$remote_name" started 0
: > "$FAKE_DIR/journal.log"
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-safe-skips.log" \
    safe-skips --timeout 240 || fail "retain/other-host safety run failed"
fake_machine_exists "$retain_id" || fail "retain-policy machine was destroyed"
fake_machine_exists "$remote_id" || fail "other-host machine was destroyed"

reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" "$FAKE_DIR/markers"
mkdir -p "$SANDBOX/.git/cloudbench-fleet-ownership/malformed/clones" "$FAKE_DIR/markers"
printf 'version=1\nhost=%s\npid=999999\npid_start=x\ncleanup_policy=reap\n' "$owner_host" \
    > "$SANDBOX/.git/cloudbench-fleet-ownership/malformed/meta"
: > "$FAKE_DIR/journal.log"
malformed_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-malformed-registry.log" \
    malformed-registry --timeout 240 || malformed_status=$?
[ "$malformed_status" -eq 1 ] || fail "malformed ownership must fail closed"
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then fail "malformed ownership allowed provisioning"; fi

reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
probe_id="f70be000000001"; probe_name="cloudbench-probe-error"
write_dead_registry probe-error reap "$owner_host" "$probe_name" "$probe_id"
add_fake_machine "$probe_id" "$probe_name" started 0 1
: > "$FAKE_DIR/journal.log"
probe_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-probe-error.log" \
    probe-error --timeout 240 || probe_status=$?
[ "$probe_status" -eq 1 ] || fail "unreadable runner probe must fail closed"
fake_machine_exists "$probe_id" || fail "unreadable-probe machine was destroyed"
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then fail "unreadable probe allowed provisioning"; fi
echo "PASS: scenario 10 — retain/other-host untouched; malformed/probe-error fail closed"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 11 — ownership persistence failures occur before provider mutation.
# ═════════════════════════════════════════════════════════════════════════════
# 11a — invalid/empty owner tokens fail closed before touching the shared
# ownership root. Hex validation rejects them early so an empty token can no
# longer resolve FLEET_REGISTRY_DIR to the ownership root itself and risk
# wiping sibling registries (including the sentinel below).
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
sentinel_registry="$SANDBOX/.git/cloudbench-fleet-ownership/sentinel-existing-owner"
mkdir -p "$FAKE_DIR/markers" "$sentinel_registry/clones"
printf 'must-survive-invalid-current-token\n' > "$sentinel_registry/sentinel"
: > "$FAKE_DIR/journal.log"
invalid_token_status=0
CLOUDBENCH_TEST_FLEET_OWNER_TOKEN='' CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-registry-invalid-token.log" \
    --provision-pool 1 || invalid_token_status=$?
[ "$invalid_token_status" -eq 1 ] || fail "invalid fleet owner token must exit nonzero"
[ -f "$sentinel_registry/sentinel" ] ||
    fail "invalid current token cleanup removed the shared ownership root/sentinel registry"
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then
    fail "provider clone occurred without a valid durable owner token"
fi
grep -qF "invalid fleet owner token" "$TMP_ROOT/controller-registry-invalid-token.log" ||
    fail "invalid owner token did not report its fail-closed boundary"

# 11b — a valid hex token whose registry path is already occupied must still
# refuse provider mutation at fleet_registry_init (atomic publish fails closed).
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
sentinel_registry="$SANDBOX/.git/cloudbench-fleet-ownership/sentinel-existing-owner"
mkdir -p "$FAKE_DIR/markers" "$sentinel_registry/clones"
printf 'must-survive-blocked-registry-publish\n' > "$sentinel_registry/sentinel"
init_token="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
# Occupy the exact publish target as a file so mv(staging → registry) fails
# closed without deleting sibling registries under the shared ownership root.
printf 'blocking-atomic-publish\n' > \
    "$SANDBOX/.git/cloudbench-fleet-ownership/$init_token"
: > "$FAKE_DIR/journal.log"
init_write_status=0
CLOUDBENCH_TEST_FLEET_OWNER_TOKEN="$init_token" CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-registry-init-failure.log" \
    --provision-pool 1 || init_write_status=$?
[ "$init_write_status" -eq 1 ] || fail "registry init write failure must exit nonzero"
[ -f "$sentinel_registry/sentinel" ] ||
    fail "blocked registry publish removed the shared ownership root/sentinel registry"
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then
    fail "provider clone occurred without an initialized durable registry"
fi
grep -qF "refusing provider mutation" "$TMP_ROOT/controller-registry-init-failure.log" ||
    fail "registry init failure did not report its fail-closed boundary"

reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
name_write_status=0
# Legacy --provision-pool now refuses before naming a clone; drive the same
# pre-allocation boundary through the supported disposable run path.
CLOUDBENCH_FAKE_BREAK_REGISTRY_ROOT="$SANDBOX/.git/cloudbench-fleet-ownership" \
    CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-registry-name-failure.log" \
    bench-alpha --timeout 240 || name_write_status=$?
[ "$name_write_status" -eq 1 ] || fail "clone-name ownership write failure must exit nonzero"
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then
    fail "provider clone occurred after durable clone-name persistence failed"
fi
grep -qF "refusing provider allocation" "$TMP_ROOT/controller-registry-name-failure.log" ||
    fail "clone-name write failure did not report its pre-allocation boundary"
echo "PASS: scenario 11 — registry init/name write failures cause zero provider clones"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 12 — a failed durable pool handoff retains fleet ownership and EXIT
# teardown reaps the already allocated, verified-stopped clone.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
pool_write_status=0
# A legacy pool request is refused before any clone exists to hand off, even
# with a broken pool-ledger destination (043659fa8).
CLOUDBENCH_FAKE_BREAK_POOL_LEDGER="$POOL_A" CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-pool-ledger-failure.log" \
    --provision-pool 1 || pool_write_status=$?
assert_pool_provisioning_refused "scenario 12" "$pool_write_status" \
    "$TMP_ROOT/controller-pool-ledger-failure.log" "$POOL_A"
if grep -qE '^machine (clone|destroy) ' "$FAKE_DIR/journal.log"; then
    fail "scenario 12: a refused pool request allocated or destroyed a Machine"
fi
if FAKE_STATE="$FAKE_DIR/state.json" python3 - <<'PY'
import json
import os
with open(os.environ["FAKE_STATE"]) as fh:
    machines = json.load(fh)["machines"]
raise SystemExit(0 if any(machine["name"] != "cloudbench-warm" for machine in machines) else 1)
PY
then
    fail "pool-ledger transfer failure left an allocated clone alive"
fi
echo "PASS: scenario 12 — a legacy pool request is refused before any handoff can fail"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 13 — repeated provisioning extends, rather than truncates, ownership.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
# Repeated legacy requests are each refused by measured new-Machine admission;
# neither may record a pool ID nor mutate the provider (043659fa8).
for attempt in first second; do
    repeat_status=0
    CLOUDBENCH_TEST_BARRIER_MIN=1 \
        run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-pool-$attempt.log" \
        --provision-pool 1 || repeat_status=$?
    assert_pool_provisioning_refused "scenario 13 ($attempt)" "$repeat_status" \
        "$TMP_ROOT/controller-pool-$attempt.log" "$POOL_A"
done
if grep -qE '^machine (clone|update|start|stop|destroy) ' "$FAKE_DIR/journal.log"; then
    fail "scenario 13: a refused pool request mutated a Machine"
fi
echo "PASS: scenario 13 — repeated legacy pool requests are each refused without allocation"

# ═══════════════════════════════════════════════════════════════════════════
# Scenario 14 — the shared-warm-box RUN footgun is closed
#
# A bare `run-bench-cloud <task>` (no --machine) would execute on the ONE shared
# warm box — NOT parallel-safe: two worktrees collide on the same machine and
# whichever stops it clobbers the other's in-flight run (a real cross-workspace
# incident: the 683e47df clobber). The guard must REJECT that run (and the
# `run-bench --single-box` dispatcher alias) at arg-parse time, BEFORE any Fly
# call. The fleet path (--machine) and the maintainer env escape hatch
# (CLOUDBENCH_ALLOW_SHARED_WARM_RUN=1) are exempt by the same guard condition —
# and the fleet path's full end-to-end success is already proven by scenario 2.
# Only the fast, Fly-free rejection paths are exercised here (a pass-through run
# would proceed into real machine provisioning).
# ═══════════════════════════════════════════════════════════════════════════
: > "$FAKE_DIR/journal.log"
guard_cloud="$TMP_ROOT/guard-cloud.log"
if env PATH="$FAKE_BIN:$PATH" CLOUDBENCH_FAKE_DIR="$FAKE_DIR" \
    bash "$WS_A/scripts/run-bench-cloud" some-bench > "$guard_cloud" 2>&1; then
    fail "scenario 14: run-bench-cloud <task> on the shared warm box must be rejected"
fi
grep -qiF "parallel-safe" "$guard_cloud" ||
    fail "scenario 14: rejection must explain the shared-warm-box parallel-safety hazard"
if grep -qE '^machine (clone|start|update|stop)' "$FAKE_DIR/journal.log"; then
    fail "scenario 14: the guard must reject BEFORE any Fly machine operation"
fi

guard_single="$TMP_ROOT/guard-single-box.log"
if env PATH="$FAKE_BIN:$PATH" bash "$WS_A/scripts/run-bench" --single-box some-bench > "$guard_single" 2>&1; then
    fail "scenario 14: run-bench --single-box must be rejected"
fi
grep -qiF "parallel-safe" "$guard_single" ||
    fail "scenario 14: --single-box rejection must explain the parallel-safety hazard"
echo "PASS: scenario 14 — the shared-warm-box run footgun is closed (fleet + escape-hatch exempt by guard condition)"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 15 — an AGED-OUT phantom name-only record must be discarded so a dead
# owner's never-materialized clone cannot block provisioning forever.
#
# Scenario 7 proves a FRESH name-only record fails closed (a real clone may still
# be lagging provider visibility — don't orphan it). But a clone REQUEST that
# never materialized leaves a name-only record that stays absent forever; failing
# closed on it permanently, deterministically aborts EVERY future run on the host
# (the real incident: a finished neighbor fleet's dead-owner registry with a
# ~45-min-old phantom blocked the ecommerce slice run after run). Once the record
# has been absent far longer than any visibility gap it is a confirmed phantom and
# recovery must discard it and keep provisioning.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
owner_host="$(hostname 2>/dev/null || uname -n)"
phantom_name="cloudbench-phantom-never-materialized"
write_dead_registry phantom-aged reap "$owner_host" "$phantom_name"
phantom_record="$SANDBOX/.git/cloudbench-fleet-ownership/phantom-aged/clones/$phantom_name"
# Age the record far beyond the phantom TTL; the machine is intentionally NEVER
# added to the fake fly state, so it stays confirmed-absent (resolve == 1).
touch -t 200001010000 "$phantom_record" 2>/dev/null || fail "scenario 15: could not backdate phantom record"
phantom_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-phantom-aged.log" \
    bench-alpha --timeout 240 || phantom_status=$?
[ "$phantom_status" -eq 0 ] ||
    fail "scenario 15: aged-out phantom must not block provisioning (exit=$phantom_status)"
grep -qF "discarding aged-out phantom name-only clone '$phantom_name'" "$TMP_ROOT/controller-phantom-aged.log" ||
    fail "scenario 15: aged-out phantom discard was not reported"
[ -f "$phantom_record" ] && fail "scenario 15: aged-out phantom record was not removed"
grep -qE '^machine clone ' "$FAKE_DIR/journal.log" && grep -qF "1/1 passed" "$TMP_ROOT/controller-phantom-aged.log" ||
    fail "scenario 15: provisioning did not proceed after the phantom was discarded"
# A FRESH name-only phantom (default TTL) must still fail closed — the age gate,
# not blanket discard, is what protects a real lagging clone (Scenario 7).
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
fresh_name="cloudbench-fresh-visibility-gap"
write_dead_registry phantom-fresh reap "$owner_host" "$fresh_name"
fresh_status=0
CLOUDBENCH_CLONE_LOOKUP_SECONDS=1 CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-phantom-fresh.log" \
    bench-alpha --timeout 240 || fresh_status=$?
[ "$fresh_status" -eq 1 ] ||
    fail "scenario 15: a FRESH name-only record must still fail closed (exit=$fresh_status)"
[ -f "$SANDBOX/.git/cloudbench-fleet-ownership/phantom-fresh/clones/$fresh_name" ] ||
    fail "scenario 15: a fresh name-only record must be retained, not discarded"
echo "PASS: scenario 15 — aged-out phantom is discarded (provisioning proceeds); fresh gap still fails closed"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 16 — an AMBIGUOUS clone failure must not leave a name-only orphan.
#
# RCA #6 (real incident: 7 leaked paid machines). The provision loop reserves the
# clone name durably BEFORE asking Fly to allocate (so a SIGKILL mid-clone can't
# orphan a late-appearing machine). If that attempt then fails AMBIGUOUSLY — a
# non-zero/timed-out clone that yields no id and is NOT a recognized "definitively
# unallocated" error — the original code retained the name record forever. That
# id-less orphan later hit the `*) return 1` reap arm on a single transient
# Fly-list read and aborted the whole teardown, leaking every already-id'd sibling
# (glob order put the orphan first → 0 siblings destroyed). The fix resolves the
# reserved name AUTHORITATIVELY after a failed attempt: bind the id if a machine
# materialized; 2a0108af7 keeps an absent name owned until teardown can prove an
# aged absence. This drives the real controller through that ambiguous failure.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers" "$FAKE_DIR/clone-failed-once"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
amb_status=0
CLOUDBENCH_FAKE_CLONE_FAIL_ONCE=1 CLOUDBENCH_CLONE_LOOKUP_SECONDS=1 CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-amb-clone.log" \
    bench-alpha --timeout 240 || amb_status=$?
# 2a0108af7: an ambiguous failure may still commit a Machine later, so its
# exact name stays owned for teardown reconciliation while the retry runs the
# task. Teardown destroys every allocated sibling and fails closed on the
# still-fresh name instead of forgetting it (the run600c 408 leak).
amb_name="$(cat "$FAKE_DIR/clone-failed-once" 2>/dev/null)"
[ -n "$amb_name" ] && [ "$(grep -c '^machine clone ' "$FAKE_DIR/journal.log")" -ge 2 ] \
    && grep -qF "1/1 passed" "$TMP_ROOT/controller-amb-clone.log" ||
    fail "scenario 16: the retry did not run the task after the ambiguous clone failure"
grep -qxF "⚠️  ambiguous clone '$amb_name' is not provider-visible; retaining exact name ownership for teardown reconciliation" \
    "$TMP_ROOT/controller-amb-clone.log" ||
    fail "scenario 16: the ambiguous clone name was not retained for teardown reconciliation"
[ "$amb_status" -ne 0 ] ||
    fail "scenario 16: a still-unreconciled ambiguous clone name was forgiven at teardown"
amb_records=()
for reg in "$SANDBOX"/.git/cloudbench-fleet-ownership/*/clones/*; do
    [ -f "$reg" ] || continue
    grep -q '^id=' "$reg" && fail "scenario 16: an allocated sibling kept fleet ownership: $reg"
    amb_records+=("${reg##*/}")
done
[ "${#amb_records[@]}" -eq 1 ] && [ "${amb_records[0]}" = "$amb_name" ] ||
    fail "scenario 16: expected exactly the ambiguous name-only record, got: ${amb_records[*]:-none}"
# 1a88cde8c owns each clone Volume by exact ID before its Machine launch, so
# the ambiguous attempt's record carries only its never-attached owned Volume.
# The Machine may still appear attached to it, so that Volume stays owned with
# the unresolved name (reaped only once the name retires); every other
# allocated Machine and Volume is destroyed.
amb_volume="$(sed -n 's/^volume_id=//p' \
    "$SANDBOX"/.git/cloudbench-fleet-ownership/*/clones/"$amb_name" 2>/dev/null)"
if FAKE_STATE="$FAKE_DIR/state.json" AMB_VOLUME="$amb_volume" python3 - <<'PY'
import json, os
state = json.load(open(os.environ["FAKE_STATE"]))
owned = os.environ["AMB_VOLUME"]
live = [v for v in state["volumes"] if v["state"] not in ("pending_destroy", "destroyed")]
raise SystemExit(0 if [m["id"] for m in state["machines"]] == ["aaaa0000000001"]
                 and owned.startswith("vol_")
                 and sorted(v["id"] for v in live) == sorted(["vol_aaaa0001", owned])
                 and all(v["attached_machine_id"] is None for v in live if v["id"] == owned)
                 else 1)
PY
then :; else
    fail "scenario 16: teardown left an allocated Machine or unowned Volume behind the retained name"
fi
# Remove only this asserted, test-owned retained name-only record.
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership"
echo "PASS: scenario 16 — ambiguous clone name stays owned for reconciliation; retry runs and siblings are reaped"

# Fail-closed scenarios exit nonzero by design, but every controller must still
# reap its own snapshot/aggregator loops instead of orphaning them to init.
teardown_survivor_logs="$(grep -lE 'survived local teardown|Could not capture the process table' \
    "$TMP_ROOT"/controller-*.log 2>/dev/null || true)"
[ -z "$teardown_survivor_logs" ] ||
    fail "controller teardown left owned local processes alive: $teardown_survivor_logs"
orphaned_controllers="$(ps -axo pid=,args= 2>/dev/null |
    awk -v root="$TMP_ROOT/" 'index($0, root) && $2 == "bash" && $3 ~ /\/run-bench-(fleet|cloud)$/')"
if [ -n "$orphaned_controllers" ]; then
    while read -r orphan_pid _; do
        kill "$orphan_pid" 2>/dev/null || true
    done <<< "$orphaned_controllers"
    fail "controller processes outlived their runs: $orphaned_controllers"
fi
echo "PASS: every controller, including fail-closed runs, reaped its own local processes"

echo "PASS: two workstreams ran cloud benchmarks concurrently, isolated end to end"
