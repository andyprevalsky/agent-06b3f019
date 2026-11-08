#!/usr/bin/env bash
# Every cloud benchmark must launch with per-bench worker autoscaling. Neither
# the public entrypoint nor the fleet implementation may expose an off-state,
# and the worker ceiling must leave room to scale beyond the primary machine.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

FAKE_BIN="$TMP_ROOT/bin"
FLY_JOURNAL="$TMP_ROOT/flyctl.log"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/flyctl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${CLOUDBENCH_TEST_FLY_JOURNAL:?}"
exit 99
SH
chmod +x "$FAKE_BIN/flyctl"

assert_rejected_before_fly() { # assert_rejected_before_fly <label> <expected-text> <command...>
    local label="$1" expected="$2" output="$TMP_ROOT/$1.log" status=0
    shift 2
    : > "$FLY_JOURNAL"
    PATH="$FAKE_BIN:$PATH" \
        FLY_BENCH_API_TOKEN="test-token" \
        CLOUDBENCH_RUNS_ROOT="$TMP_ROOT/runs" \
        CLOUDBENCH_TEST_FLY_JOURNAL="$FLY_JOURNAL" \
        "$@" > "$output" 2>&1 || status=$?

    [ "$status" -eq 2 ] || {
        echo "FAIL: $label must exit 2 before provisioning (exit=$status)" >&2
        cat "$output" >&2
        exit 1
    }
    grep -qF -- "$expected" "$output" || {
        echo "FAIL: $label did not report the mandatory-autoscale contract" >&2
        cat "$output" >&2
        exit 1
    }
    [ ! -s "$FLY_JOURNAL" ] || {
        echo "FAIL: $label reached Fly before rejection" >&2
        cat "$FLY_JOURNAL" >&2
        exit 1
    }
}

assert_rejected_before_fly public-no-autoscale \
    "Unknown flag: --no-autoscale" \
    bash "$ROOT_DIR/scripts/run-bench" chat-mode --no-autoscale
assert_rejected_before_fly fleet-no-autoscale \
    "Unknown flag: --no-autoscale" \
    bash "$ROOT_DIR/scripts/run-bench-fleet" acceptance-probe --no-autoscale
assert_rejected_before_fly fleet-single-machine-ceiling \
    "--autoscale-max must be an integer of at least 2" \
    bash "$ROOT_DIR/scripts/run-bench-fleet" acceptance-probe --autoscale-max 1

# Long benchmark names must never consume the controller/ordinal suffix that
# isolates each Temporal queue. These three real daily names were exactly one
# character too long and previously collapsed ordinals 6, 29, and 31 to an
# empty, 2, and 3 suffix respectively.
# shellcheck source=../lib/cloudbench-env.sh
source "$ROOT_DIR/scripts/lib/cloudbench-env.sh"
owner_a=0123456789abcdef0123456789abcdef
owner_b=fedcba9876543210fedcba9876543210
workspace_6="$(cloudbench_fleet_workspace_name plaid-transactions-dead-subscriptions "$owner_a" 6)"
workspace_29="$(cloudbench_fleet_workspace_name agent-payment-idempotent-abandonment "$owner_a" 29)"
workspace_31="$(cloudbench_fleet_workspace_name agent-payment-production-abandonment "$owner_a" 31)"
for workspace in "$workspace_6" "$workspace_29" "$workspace_31"; do
    [ "${#workspace}" -le 48 ] || {
        echo "FAIL: fleet workspace exceeds the 48-character queue namespace ceiling: $workspace" >&2
        exit 1
    }
done
[ "$workspace_6" != "$workspace_29" ] && [ "$workspace_6" != "$workspace_31" ] \
    && [ "$workspace_29" != "$workspace_31" ] || {
        echo "FAIL: long benchmark names produced colliding fleet workspaces" >&2
        exit 1
    }
guest_identity_a="$(cloudbench_fleet_guest_identity "$owner_a")" || {
    echo "FAIL: could not derive a guest identity from a valid fleet owner token" >&2
    exit 1
}
case "$guest_identity_a" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) : ;;
    *) echo "FAIL: guest identity is not a 12-hex owner digest: $guest_identity_a" >&2; exit 1 ;;
esac
case "$workspace_6:$workspace_29:$workspace_31" in
    *"-$guest_identity_a-6:"*"-$guest_identity_a-29:"*"-$guest_identity_a-31") : ;;
    *)
        echo "FAIL: fleet workspaces did not preserve the complete owner/ordinal suffix" >&2
        printf '%s\n' "$workspace_6" "$workspace_29" "$workspace_31" >&2
        exit 1
        ;;
esac
case "$workspace_6$workspace_29$workspace_31" in
    *"$owner_a"*) echo "FAIL: the raw fleet owner token leaked into a shared Temporal queue name" >&2; exit 1 ;;
esac
for bad_owner in 39148 "" 0123456789ABCDEF0123456789ABCDEF 0123456789abcdef0123456789abcde; do
    if cloudbench_fleet_workspace_name browser-event-ticket "$bad_owner" 0 >/dev/null 2>&1; then
        echo "FAIL: fleet workspace accepted a non-owner-token controller identity: '$bad_owner'" >&2
        exit 1
    fi
done

# Guest workspace names become the shared Temporal Cloud task queue
# (navi-agent-tasks-<workspace>), the guest's pre-run stale-workflow
# termination scope and its Steel ownership marker (BENCHMARK_RUN_ID). Sharded
# disposable controllers boot identically, so two hosts can run the same bench
# and ordinal under the same controller PID in the same second (run600c: eight
# canary queues collided across 2-4 shards). Execute the fleet's actual launch
# derivation twice under one shell PID ($$ is inherited by subshells), as two
# independent fleets with distinct owners; their workspaces must differ, while
# the same owner must re-derive its own exact workspace for recovery.
launch_derivation="$(awk '/# Deterministic per-bench workspace/ {p=1} p {print} p && /^    fi$/ {exit}' \
    "$ROOT_DIR/scripts/run-bench-fleet")"
grep -qF 'cloudbench_fleet_workspace_name' <<<"$launch_derivation" || {
    echo "FAIL: fleet launch path bypasses the suffix-preserving workspace helper" >&2
    exit 1
}
derive_launch_workspace() {  # <fleet-owner-token> -> workspace from the real launch block
    (
        FLEET_OWNER_TOKEN="$1"
        bench=browser-auth-code-never-arrives
        i=0
        eval "$launch_derivation" || exit 1
        printf '%s\n' "$local_ws"
    )
}
host_a_workspace="$(derive_launch_workspace "$owner_a")" \
    && host_b_workspace="$(derive_launch_workspace "$owner_b")" \
    && host_a_recovered="$(derive_launch_workspace "$owner_a")" || {
        echo "FAIL: the fleet launch block could not derive a guest workspace" >&2
        exit 1
    }
[ "$host_a_workspace" != "$host_b_workspace" ] || {
    echo "FAIL: two fleets sharing a controller PID derived the same shared Temporal queue: navi-agent-tasks-$host_a_workspace" >&2
    exit 1
}
[ "$host_a_workspace" = "$host_a_recovered" ] || {
    echo "FAIL: one fleet owner did not re-derive its exact guest workspace ($host_a_workspace != $host_a_recovered)" >&2
    exit 1
}
case "$host_a_workspace:$host_b_workspace" in
    *"-$$-0:"*|*"-$$-0") echo "FAIL: guest workspace still embeds the controller PID: $host_a_workspace" >&2; exit 1 ;;
esac
for workspace in "$host_a_workspace" "$host_b_workspace"; do
    [ "${#workspace}" -le 48 ] || {
        echo "FAIL: launch workspace exceeds the 48-character queue namespace ceiling: $workspace" >&2
        exit 1
    }
done

# A direct run-bench-cloud invocation (no fleet-supplied workspace) has the
# same shared-namespace exposure. Execute its actual fallback twice under one
# PID and second; the two guests must still get distinct workspaces.
direct_fallback="$(grep -E '^RUN_WORKSPACE_NAME="\$\{CLOUDBENCH_WORKSPACE_NAME:-' "$ROOT_DIR/scripts/run-bench-cloud")"
[ "$(printf '%s\n' "$direct_fallback" | grep -c .)" -eq 1 ] || {
    echo "FAIL: could not extract run-bench-cloud's single workspace fallback" >&2
    exit 1
}
derive_direct_workspace() {
    ( unset CLOUDBENCH_WORKSPACE_NAME; date() { printf '20261018103918\n'; }; eval "$direct_fallback"; printf '%s\n' "$RUN_WORKSPACE_NAME" )
}
direct_a="$(derive_direct_workspace)" && direct_b="$(derive_direct_workspace)" || {
    echo "FAIL: run-bench-cloud's workspace fallback did not evaluate" >&2
    exit 1
}
[ -n "$direct_a" ] && [ "$direct_a" != "$direct_b" ] || {
    echo "FAIL: direct cloud runs sharing a PID and second derived one workspace: $direct_a" >&2
    exit 1
}
[ "${#direct_a}" -le 48 ] || {
    echo "FAIL: direct cloud workspace exceeds the 48-character queue namespace ceiling: $direct_a" >&2
    exit 1
}

echo "PASS: cloud benchmarks expose no autoscale off-state"

# Finalization must wait for a live autoscaler's terminal marker even when the
# shell job table omits it (observed under heavy controller load: acceptance
# then found the autoscaler running without autoscaler.completed-after-child).
finalization_harness="$TMP_ROOT/finalization-harness.sh"
{
    printf 'set -uo pipefail\n'
    # These are fixture children, not controllers. Join them on every exit;
    # the production finalization function intentionally stops at its marker.
    cat <<'SH'
fixture_children=()
reap_fixture_children() {
    local status=$? child
    trap - EXIT
    for child in "${fixture_children[@]}"; do
        if wait "$child"; then :; else
            [ "$status" -ne 0 ] || status=5
        fi
    done
    exit "$status"
}
trap reap_fixture_children EXIT
SH
    for fn in fleet_job_running fleet_job_may_be_running wait_for_autoscaler_finalization; do
        awk -v start="^${fn}\\\\(\\\\) \\\\{" '$0 ~ start {p=1} p {print} p && /^\}/ {exit}' \
            "$ROOT_DIR/scripts/run-bench-fleet"
    done
    # Simulate the job-table omission: the shell never lists the autoscaler.
    printf 'fleet_job_running() { return 1; }\n'
    printf 'out="$1"; AUTOSCALER_FINALIZATION_WAIT_SECONDS=20\n'
    printf '( sleep 1.5; : > "$out/autoscaler.completed-after-child"; sleep 0.5 ) &\n'
    printf 'fixture_children+=("$!"); AUTOSCALER_PIDS=("$!"); CHILD_OUT=("$out")\n'
    printf 'wait_for_autoscaler_finalization\n'
    printf '[ -e "$out/autoscaler.completed-after-child" ] || exit 3\n'
    # An autoscaler that exits without a marker must not hold the wait open.
    printf 'rm -f "$out/autoscaler.completed-after-child"; ( sleep 0.3 ) &\n'
    printf 'fixture_children+=("$!"); AUTOSCALER_PIDS=("$!"); started=$SECONDS\n'
    printf 'wait_for_autoscaler_finalization\n'
    printf '[ $((SECONDS - started)) -lt 10 ] || exit 4\n'
    # Reap the fixtures (the first one is still inside its trailing sleep when the marker is seen) so no
    # child outlives the harness: the deploy supervisor reports a surviving child as UNVERIFIED.
    printf 'wait\n'
} > "$finalization_harness"
grep -q '^wait_for_autoscaler_finalization() {' "$finalization_harness" || {
    echo "FAIL: could not extract wait_for_autoscaler_finalization from run-bench-fleet" >&2
    exit 1
}
finalization_out="$TMP_ROOT/finalization-out"
mkdir -p "$finalization_out"
finalization_status=0
bash "$finalization_harness" "$finalization_out" || finalization_status=$?
case "$finalization_status" in
    0) echo "PASS: finalization waits for a live autoscaler the job table omits" ;;
    3) echo "FAIL: finalization stopped before a live autoscaler published its marker" >&2; exit 1 ;;
    4) echo "FAIL: an exited autoscaler without a marker held finalization open" >&2; exit 1 ;;
    *) echo "FAIL: finalization harness exited $finalization_status" >&2; exit 1 ;;
esac

# Fault-inject the generated fixture only: an assertion failure must join the
# child before the outer test removes its directory, preserving the exit code.
failure_harness="$TMP_ROOT/finalization-failure.sh"
awk '$0 == "wait_for_autoscaler_finalization" && !injected {print "exit 3"; injected=1; next} {print}' \
    "$finalization_harness" > "$failure_harness"
failure_out="$TMP_ROOT/finalization-failure-out"
mkdir -p "$failure_out"
failure_status=0
bash "$failure_harness" "$failure_out" || failure_status=$?
[ "$failure_status" -eq 3 ] && [ -e "$failure_out/autoscaler.completed-after-child" ] || {
    echo "FAIL: assertion-failure cleanup did not join its fixture child and preserve status" >&2
    exit 1
}
# A child failure after publication must not disappear behind successful assertions.
sed 's/; sleep 0.5 )/; sleep 0.5; exit 7 )/' "$finalization_harness" > "$failure_harness"
child_failure_out="$TMP_ROOT/finalization-child-failure-out"
mkdir -p "$child_failure_out"
child_failure_status=0
bash "$failure_harness" "$child_failure_out" || child_failure_status=$?
[ "$child_failure_status" -eq 5 ] || {
    echo "FAIL: fixture child failure was ignored (status $child_failure_status)" >&2
    exit 1
}
echo "PASS: fixture children are joined on assertion failure and child failures stay visible"
