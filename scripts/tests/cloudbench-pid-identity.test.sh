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

kill "$owner_pid"
wait "$owner_pid" 2>/dev/null || true
cloudbench_pid_matches_start "$owner_pid" "$identity" &&
  fail "an exited owner must not match its old birth identity"
[ "$(snapshot_identity_state "$owner_pid" "$identity")" = absent ] ||
  fail "the script snapshot helper must report an exited owner as absent"
unstep_clock

echo "PASS: cloudbench PID birth identities survive a wall-clock step"
