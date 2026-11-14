#!/usr/bin/env bash
# Cloudbench PID birth identities must survive a wall-clock step.
#
# Linux ps(1) renders lstart from the kernel's current boot-time estimate, so a
# VM snapshot fork (or any clock step) rewrites the lstart of every live
# process. Owner records minted from lstart then read as "replaced": a fleet's
# script-snapshot cleanup fails, Hub teardown skips a live listener and blocks
# in wait(1), and a second controller may treat a live registry as dead. A ps
# shim replays that step deterministically; every producer and verifier must
# keep matching the same live processes across it.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
CHILD_PIDS=()
DETACHED_PGID=""

cleanup() {
  local pid
  if [ -n "$DETACHED_PGID" ]; then
    kill -TERM -- "-$DETACHED_PGID" 2>/dev/null || true
  fi
  for pid in "${CHILD_PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# Evaluate the actual stack imports and birth capture in a fresh shell. The
# fixture's shared library below must not supply a missing production import.
capture_probe="$TMP_ROOT/production-capture.sh"
{
  printf 'set -eo pipefail\nSCRIPT_DIR=%q\n' "$ROOT_DIR/scripts"
  sed -n '/^\. "\$SCRIPT_DIR\/lib\//p' "$ROOT_DIR/scripts/run.sh"
  cat <<'SH'
sleep 120 &
AGENTS_PID=$!
cleanup() { kill "$AGENTS_PID" 2>/dev/null || true; wait "$AGENTS_PID" 2>/dev/null || true; }
trap cleanup EXIT
SH
  sed -n '/^AGENTS_BIRTH=/p' "$ROOT_DIR/scripts/run.sh"
  cat <<'SH'
[ -n "$AGENTS_BIRTH" ]
[ "$AGENTS_BIRTH" = "$(cloudbench_pid_start_time "$AGENTS_PID")" ]
run_wait_owned_agent_shutdown "$AGENTS_PID" "$AGENTS_BIRTH" 10 || exit 1
SH
} > "$capture_probe"
if ! bash "$capture_probe" > "$TMP_ROOT/production-capture.log" 2>&1; then
  cat "$TMP_ROOT/production-capture.log" >&2
  fail "actual run.sh imports must provide the stack birth capture and drain"
fi

# shellcheck source=../lib/cloudbench-env.sh
source "$ROOT_DIR/scripts/lib/cloudbench-env.sh"

if [ ! -r /proc/self/stat ]; then
  echo "SKIP: wall-clock-step replay needs Linux /proc; macOS lstart is recorded at fork"
  exit 0
fi

export LC_ALL=C
REAL_PS="$(command -v ps)"
CLOCK_STEP_FILE="$TMP_ROOT/clock-step-seconds"
export REAL_PS CLOCK_STEP_FILE
mkdir -p "$TMP_ROOT/bin"
cat > "$TMP_ROOT/bin/ps" <<'PY'
#!/usr/bin/env python3
import datetime
import os
import re
import subprocess
import sys

result = subprocess.run(
    [os.environ["REAL_PS"], *sys.argv[1:]], capture_output=True, text=True, check=False
)
output = result.stdout
step_file = os.environ["CLOCK_STEP_FILE"]
if os.path.exists(step_file):
    offset = datetime.timedelta(seconds=int(open(step_file).read().strip()))

    def shift(match):
        moment = datetime.datetime.strptime(
            " ".join(match.group(0).split()), "%a %b %d %H:%M:%S %Y"
        ) + offset
        return moment.strftime("%a %b ") + f"{moment.day:2d}" + moment.strftime(" %H:%M:%S %Y")

    output = re.sub(
        r"[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}", shift, output
    )
sys.stdout.write(output)
sys.stderr.write(result.stderr)
raise SystemExit(result.returncode)
PY
chmod +x "$TMP_ROOT/bin/ps"
export PATH="$TMP_ROOT/bin:$PATH"

step_clock() { printf '143\n' > "$CLOCK_STEP_FILE"; }
unstep_clock() { rm -f "$CLOCK_STEP_FILE"; }

eval "$(awk '/^script_snapshot_current_pid_start\(\) \{/,/^}/' "$ROOT_DIR/scripts/run-bench-fleet")"
eval "$(awk '/^fleet_pid_start_time\(\) \{/,/^}/' "$ROOT_DIR/scripts/run-bench-fleet")"
eval "$(awk '/^fleet_pid_matches_start\(\) \{/,/^}/' "$ROOT_DIR/scripts/run-bench-fleet")"
for helper in script_snapshot_current_pid_start fleet_pid_start_time fleet_pid_matches_start; do
  declare -F "$helper" >/dev/null || fail "could not load $helper from run-bench-fleet"
done

python_identity() {  # <module-path> <function> <pid>
  python3 - "$@" <<'PY'
import importlib.util
import sys

path, function, pid = sys.argv[1:]
spec = importlib.util.spec_from_file_location("identity_under_test", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(getattr(module, function)(int(pid)))
PY
}

snapshot_identity_state() {  # <pid> <recorded-identity>
  python3 - "$ROOT_DIR/scripts/cloudbench-script-snapshot.py" "$@" <<'PY'
import importlib.util
import sys

path, pid, expected = sys.argv[1:]
spec = importlib.util.spec_from_file_location("snapshot_under_test", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(module._process_identity_state(int(pid), expected))
PY
}

port_lease() {  # <action> <owner-pid> <token>
  python3 "$ROOT_DIR/scripts/cloudbench-port-lease.py" "$1" \
    --root "$TMP_ROOT/port-leases" --owner-pid "$2" --token "$3"
}

sleep 120 &
owner_pid=$!
CHILD_PIDS+=("$owner_pid")
sleep 120 &
neighbor_pid=$!
CHILD_PIDS+=("$neighbor_pid")

# Legacy lstart records written by older controllers keep their meaning.
legacy_collapsed="$("$REAL_PS" -p "$owner_pid" -o lstart= | awk '{$1=$1; print}')"
legacy_trimmed="$("$REAL_PS" -p "$owner_pid" -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
cloudbench_pid_matches_start "$owner_pid" "$legacy_collapsed" ||
  fail "a live legacy lstart owner must still match"
fleet_pid_matches_start "$owner_pid" "$legacy_trimmed" ||
  fail "a live legacy fleet registry owner must still match"
[ "$(snapshot_identity_state "$owner_pid" "$legacy_collapsed")" = match ] ||
  fail "the script snapshot helper must still accept a live legacy owner"

identity="$(cloudbench_pid_start_time "$owner_pid")"
case "$identity" in
  proc-start:*:[0-9]*) ;;
  *) fail "Linux birth identity must come from /proc, got: ${identity:-<empty>}" ;;
esac
[ "$(fleet_pid_start_time "$owner_pid")" = "$identity" ] ||
  fail "fleet registry identity must equal the shared cloudbench identity"
[ "$(script_snapshot_current_pid_start)" = "$(cloudbench_pid_start_time $$)" ] ||
  fail "script snapshot owner identity must equal the shared cloudbench identity"
[ "$(python_identity "$ROOT_DIR/agents/benchmarks/agent_link_server.py" _pid_start_time "$owner_pid")" = "$identity" ] ||
  fail "Hub owner identity must equal the shell-side verifier identity"
[ "$(python_identity "$ROOT_DIR/scripts/cloudbench-port-lease.py" _process_start_identity "$owner_pid")" = "$identity" ] ||
  fail "port-lease identity must equal the shared cloudbench identity"
grep -qxF "$owner_pid $$ $identity" <<< "$(cloudbench_process_birth_table)" ||
  fail "teardown process table must carry the same birth identity"

detached_owner="$TMP_ROOT/detached.owner"
cloudbench_detach_reexec_tracked "$detached_owner" "$TMP_ROOT/detached.log" sleep 120 ||
  fail "tracked detach did not publish its owner record"
detached_pid="$(cloudbench_tracked_owner_value "$detached_owner" pid)"
DETACHED_PGID="$(cloudbench_tracked_owner_value "$detached_owner" pgid)"
detached_start="$(cloudbench_tracked_owner_value "$detached_owner" pid_start)"
[ "$detached_start" = "$(cloudbench_pid_start_time "$detached_pid")" ] ||
  fail "tracked detach must publish the shared birth identity"

lease_port="$(port_lease claim "$owner_pid" owner-lease)"
lease_file="$TMP_ROOT/port-leases/$lease_port"
[ -f "$lease_file" ] || fail "port lease was not published"

# The service stack must use the same identity as the fleet. Exercise its
# actual capture assignment and drain helper against one native owned child.
source "$ROOT_DIR/scripts/lib/run-process-cleanup.sh"
worker_ready="$TMP_ROOT/worker.ready"
worker_terminated="$TMP_ROOT/worker.terminated"
python3 - "$worker_ready" "$worker_terminated" <<'PY' &
import pathlib
import signal
import sys

ready, terminated = map(pathlib.Path, sys.argv[1:])

def stop(_signum, _frame):
    terminated.write_text("TERM\n")
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
ready.touch()
while True:
    signal.pause()
PY
AGENTS_PID=$!
CHILD_PIDS+=("$AGENTS_PID")
worker_ready_deadline=$((SECONDS + 10))
while [ ! -f "$worker_ready" ] && [ "$SECONDS" -lt "$worker_ready_deadline" ]; do
  kill -0 "$AGENTS_PID" 2>/dev/null || fail "owned worker fixture exited before readiness"
  sleep 0.1
done
[ -f "$worker_ready" ] || fail "owned worker fixture did not become ready"
eval "$(sed -n '/^AGENTS_BIRTH=/p' "$ROOT_DIR/scripts/run.sh")"

step_clock
[ "$(ps -p "$owner_pid" -o lstart=)" != "$("$REAL_PS" -p "$owner_pid" -o lstart=)" ] ||
  fail "ps shim did not replay the wall-clock step"

cloudbench_pid_matches_start "$owner_pid" "$identity" ||
  fail "a live owner must keep its birth identity across a wall-clock step"
fleet_pid_matches_start "$owner_pid" "$identity" ||
  fail "a live fleet registry owner must stay alive across a wall-clock step"
[ "$(script_snapshot_current_pid_start)" = "$(cloudbench_pid_start_time $$)" ] ||
  fail "script snapshot cleanup must not see owner birth drift after a wall-clock step"
[ "$(snapshot_identity_state "$owner_pid" "$identity")" = match ] ||
  fail "the script snapshot helper must keep matching its live owner after a wall-clock step"
observation="$(cloudbench_pid_observation_like "$owner_pid" "$identity")"
[ "${observation%%$'\t'*}" = "$identity" ] && [[ "${observation##*$'\t'}" != Z* ]] ||
  fail "teardown observation must report the live owner after a wall-clock step: $observation"
cloudbench_pid_matches_start "$detached_pid" "$detached_start" ||
  fail "a live detached Hub owner must stay verifiable after a wall-clock step"

port_lease claim "$neighbor_pid" neighbor-lease >/dev/null
[ -f "$lease_file" ] ||
  fail "a live port lease was reaped as stale after a wall-clock step"
port_lease release-owner "$owner_pid" owner-lease
[ ! -f "$lease_file" ] ||
  fail "the live owner must still release its own lease after a wall-clock step"

run_wait_owned_agent_shutdown "$AGENTS_PID" "$AGENTS_BIRTH" 10 ||
  fail "the owned stack worker must drain across a wall-clock step"
wait "$AGENTS_PID" || fail "the owned worker did not exit cleanly"
[ "$(cat "$worker_terminated")" = TERM ] || fail "the owned worker missed its graceful signal"
kill -0 "$neighbor_pid" 2>/dev/null || fail "worker drain signalled an unrelated sibling"

kill "$owner_pid"
wait "$owner_pid" 2>/dev/null || true
cloudbench_pid_matches_start "$owner_pid" "$identity" &&
  fail "an exited owner must not match its old birth identity"
[ "$(snapshot_identity_state "$owner_pid" "$identity")" = absent ] ||
  fail "the script snapshot helper must report an exited owner as absent"
unstep_clock

# Fleet teardown runs inside EXIT traps whose pending status is the
# controller's own exit code. Each identity helper must report its own result
# there, or every failed run orphans its snapshot/aggregator loops and a
# successful run reads dead owners as alive.
trap_probe="$TMP_ROOT/trap-probe.sh"
cat > "$trap_probe" <<'SH'
set -uo pipefail
root_dir="$1" report="$2" dead_identity="$3" pending_status="$4"
source "$root_dir/scripts/lib/cloudbench-env.sh"
eval "$(awk '/^fleet_pid_start_time\(\) \{/,/^}/' "$root_dir/scripts/run-bench-fleet")"
eval "$(awk '/^fleet_pid_matches_start\(\) \{/,/^}/' "$root_dir/scripts/run-bench-fleet")"
loop() { while :; do sleep 1; done; }
loop &
loop_pid=$!
dead_pid="${dead_identity%%|*}"
dead_identity="${dead_identity#*|}"
on_exit() {
  local live_identity
  trap - EXIT
  trap '' HUP INT TERM
  live_identity="$(fleet_pid_start_time "$loop_pid")"
  {
    cloudbench_process_birth_table >/dev/null && echo "table=ok" || echo "table=failed"
    cloudbench_pid_matches_start "$loop_pid" "$live_identity" \
      && echo "live=match" || echo "live=mismatch"
    fleet_pid_matches_start "$loop_pid" "$live_identity" \
      && echo "fleet-live=match" || echo "fleet-live=mismatch"
    fleet_pid_matches_start "$dead_pid" "$dead_identity" \
      && echo "fleet-dead=match" || echo "fleet-dead=mismatch"
    cloudbench_terminate_tree_and_wait 10 "$loop_pid" >/dev/null 2>&1 \
      && echo "teardown=ok" || echo "teardown=failed"
    kill -0 "$loop_pid" 2>/dev/null && echo "loop=alive" || echo "loop=reaped"
  } > "$report"
  kill "$loop_pid" 2>/dev/null || true
}
trap on_exit EXIT
exit "$pending_status"
SH
expected_trap_report=$'table=ok\nlive=match\nfleet-live=match\nfleet-dead=mismatch\nteardown=ok\nloop=reaped'
for pending_status in 0 3; do
  trap_report="$TMP_ROOT/trap-report.$pending_status"
  trap_status=0
  timeout 60 bash "$trap_probe" "$ROOT_DIR" "$trap_report" "$owner_pid|$identity" \
    "$pending_status" >"$trap_report.log" 2>&1 || trap_status=$?
  [ "$trap_status" = "$pending_status" ] ||
    fail "EXIT-trap probe must keep exit status $pending_status, got $trap_status"
  [ "$(cat "$trap_report" 2>/dev/null)" = "$expected_trap_report" ] ||
    fail "identity helpers misreported inside an EXIT trap pending status $pending_status: $(tr '\n' ' ' < "$trap_report" 2>/dev/null)"
done

echo "PASS: cloudbench PID birth identities survive a wall-clock step"

# The boolean proc-start matcher must not fork a classification pipeline for
# every target; its absent/unknown callers still use the unchanged richer API.
pid_match_single_observation_contract() (
    local trace="$TMP_ROOT/proc-match-depth" birth initial_depth="$BASH_SUBSHELL"
    birth="$(cloudbench_pid_start_time "$$")"
    [ -n "$birth" ] || fail "could not obtain the current native birth"
    eval "$(declare -f cloudbench_proc_pid_observation | sed '1s/cloudbench_proc_pid_observation/native_match_observation/')"
    cloudbench_proc_pid_observation() {
        printf '%s\n' "$BASH_SUBSHELL" >> "$trace"
        native_match_observation "$@"
    }
    cloudbench_pid_matches_start "$$" "$birth" || fail "live native birth did not match"
    [ "$(wc -l < "$trace" | tr -d ' ')" = 1 ] || fail "boolean match repeated native observation"
    [ "$(cat "$trace")" = "$((initial_depth + 1))" ] || fail "boolean match forked nested classification shells: observed $(cat "$trace"), expected $((initial_depth + 1))"
    ! cloudbench_pid_matches_start "$$" "${birth}-foreign" || fail "foreign birth matched"
    ! cloudbench_pid_matches_start 1 "$birth" || fail "PID1 matched"
    ! cloudbench_pid_matches_start invalid "$birth" || fail "invalid PID matched"
    ! cloudbench_pid_matches_start 999999999 "$birth" || fail "absent PID matched"
    cloudbench_proc_pid_observation() { return 1; }
    ! cloudbench_pid_matches_start "$$" "$birth" || fail "unreadable native birth matched"
    cloudbench_proc_pid_observation() { return 0; }
    ! cloudbench_pid_matches_start "$$" "$birth" || fail "empty native birth matched"
    cloudbench_proc_pid_observation() { printf '%s\tZ\n' "$birth"; }
    cloudbench_pid_matches_start "$$" "$birth" || fail "native birth predicate changed zombie classification"
    # Legacy records retain the classifier; no Linux shortcut may accept them.
    cloudbench_pid_birth_state() { printf '%s\n' "$legacy_state"; }
    local legacy_state=live
    cloudbench_pid_matches_start "$$" legacy-record || fail "legacy live dispatch changed"
    legacy_state=absent
    ! cloudbench_pid_matches_start "$$" legacy-record || fail "legacy absent matched"
    legacy_state=unknown
    ! cloudbench_pid_matches_start "$$" legacy-record || fail "legacy unknown matched"
)
pid_match_single_observation_contract
echo "PASS: boolean native birth match observes once without nested classification forks"

python3 - "$ROOT_DIR/scripts/run-deploy-structural-gates.py" <<'PID_GATE'
import ast,sys
from pathlib import Path
commands=[]
for node in ast.walk(ast.parse(Path(sys.argv[1]).read_text())):
    if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='Gate' and len(node.args)>=2 and isinstance(node.args[0],ast.Constant) and node.args[0].value=='cloudbench-pid-identity':
        commands.append(ast.literal_eval(node.args[1]))
assert commands==[('bash','scripts/tests/cloudbench-pid-identity.test.sh')],commands
PID_GATE
