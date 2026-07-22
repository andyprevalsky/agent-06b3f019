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
    bash "$ROOT_DIR/scripts/run-bench" acceptance-probe --no-autoscale
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
workspace_6="$(cloudbench_fleet_workspace_name plaid-transactions-dead-subscriptions 39148 6)"
workspace_29="$(cloudbench_fleet_workspace_name agent-payment-idempotent-abandonment 39148 29)"
workspace_31="$(cloudbench_fleet_workspace_name agent-payment-production-abandonment 39148 31)"
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
case "$workspace_6:$workspace_29:$workspace_31" in
    *-39148-6:*-39148-29:*-39148-31) : ;;
    *)
        echo "FAIL: fleet workspaces did not preserve the complete controller/ordinal suffix" >&2
        printf '%s\n' "$workspace_6" "$workspace_29" "$workspace_31" >&2
        exit 1
        ;;
esac
grep -qF 'cloudbench_fleet_workspace_name "$bench" "$$" "$i"' \
    "$ROOT_DIR/scripts/run-bench-fleet" || {
        echo "FAIL: fleet launch path bypasses the suffix-preserving workspace helper" >&2
        exit 1
    }

echo "PASS: cloud benchmarks expose no autoscale off-state"
