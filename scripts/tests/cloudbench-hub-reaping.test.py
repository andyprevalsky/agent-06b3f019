#!/usr/bin/env python3
"""Exercise fixture teardown against live Hub children with drifting PID probes."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "scripts/tests/cloudbench-multi-workstream.test.sh"
IDENTITY = runpy.run_path(str(ROOT / "scripts/process-identity.py"))


@contextmanager
def fixture_directory():
    base = Path(tempfile.mkdtemp(prefix="rose-hub-reaping-")).resolve()
    try:
        yield base
    finally:
        if (base / "retain").exists():
            print(f"Retained unverified Hub fixture: {base}", file=sys.stderr)
        else:
            shutil.rmtree(base)


def retire_fixture_hub(base):
    """Keep the authority if a fixture's native process identity is unavailable."""
    captured = json.loads((base / "native-identity.json").read_text())
    pid = int(captured["pid"])
    if pid <= 1:
        raise AssertionError("Invalid fixture Hub PID")
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return
    for name in ("TERM", "KILL"):
        result = IDENTITY["main"](
            [
                "process-identity.py",
                "--expect",
                captured["identity"],
                "--signal",
                name,
                str(pid),
            ]
        )
        if result != 0:
            raise AssertionError(
                f"Exact Hub {name} failed or identity is unverified: {pid}"
            )
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.01)
    raise AssertionError(f"Exact Hub fixture did not terminate: {pid}")


class HubReapingContract(unittest.TestCase):
    def run_contract(self, consumer, observation):
        source = SOURCE.read_text()
        functions = source.split("\nhub_stub() {  # hub_stub", 1)[1]
        functions = (
            "hub_stub() {  # hub_stub"
            + functions.split("\nassert_test_hub_accepts_required_upload()", 1)[0]
        )
        listener = re.search(
            r"^test_tcp_listener_absent\(\) \{\n.*?^\}", source, re.M | re.S
        )
        self.assertIsNotNone(listener)
        with fixture_directory() as base:
            workspace = base / "workspace"
            command = workspace / "agents/benchmarks/agent_link_server.py"
            command.parent.mkdir(parents=True)
            shutil.copy2(ROOT / "agents/benchmarks/agent_link_server.py", command)
            (base / "functions.sh").write_text(functions + "\n" + listener[0] + "\n")
            script = r"""
set -uo pipefail
source "$1/scripts/lib/cloudbench-env.sh"
source "$2/functions.sh"
ROOT_DIR="$1"
TMP_ROOT="$2"
ws="$2/workspace"
runs_root="$ws/.context/fleet/runs"
PIDS=()
HUB_PIDS=()
HUB_LAUNCH_DEFERRED_SIGNAL=""
# The Python owner handles failure cleanup, including a hung Bash wait.
cleanup() { exit "${1:-1}"; }
port="$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    print(listener.getsockname()[1])
PY
)"
hub_stub "$port" "$runs_root" || exit 10
pending="$(find "$runs_root/_hub" -name '*.pending' -type f -print -quit)"
owner="${pending%.pending}.owner"
deadline=$((SECONDS + 5))
while [ ! -f "$owner" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep .01; done
[ -f "$owner" ] || exit 11
target_pid="$(cloudbench_tracked_owner_value "$owner" pid)"
python3 - "$ROOT_DIR" "$target_pid" "$2/native-identity.json" <<'PY'
import json,runpy,sys
from pathlib import Path
identity=runpy.run_path(str(Path(sys.argv[1])/'scripts/process-identity.py'))
pid=int(sys.argv[2])
Path(sys.argv[3]).write_text(json.dumps({'pid':pid,'identity':identity['current_identity'](pid)}))
PY
[ "$?" -eq 0 ] || exit 21
if [ "$3" = owned ]; then
    chmod u+w "$pending"
    rm "$pending"
fi
python3 - "$runs_root/_hub" "$2/before.json" <<'PY'
import hashlib,json,sys
from pathlib import Path
base=Path(sys.argv[1])
Path(sys.argv[2]).write_text(json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in base.iterdir() if p.is_file()}))
PY
observation="$4"
ps() {
    if [ "$1" = -p ] && [ "$2" = "$target_pid" ] && [ "$3" = -o ]; then
        case "$observation:$4" in
            drift:lstart=) printf '%s\n' 'Sat Sep 12 01:12:09 2026'; return 0 ;;
            unknown:lstart=|unknown:stat=) return 2 ;;
        esac
    fi
    command ps "$@"
}
printf '%s\n' "$target_pid" > "$2/call.ready"
rc=0
"terminate_test_${3}_hubs" "$ws" > "$2/cleanup.log" 2>&1 || rc=$?
printf '%s\n' "$rc" > "$2/call.result"
if [ "$observation" = normal ]; then
    [ "$rc" -eq 0 ] || exit 12
    ! kill -0 "$target_pid" 2>/dev/null || exit 13
else
    [ "$rc" -ne 0 ] || exit 14
    kill -0 "$target_pid" || exit 15
    [ "${HUB_PIDS[*]}" = "$target_pid" ] || exit 16
    python3 - "$runs_root/_hub" "$2/before.json" <<'PY'
import hashlib,json,sys
from pathlib import Path
base=Path(sys.argv[1])
assert {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in base.iterdir() if p.is_file()}==json.loads(Path(sys.argv[2]).read_text())
PY
    [ "$?" -eq 0 ] || exit 17
fi
unset -f ps
terminate_test_owned_hubs "$ws" || exit 18
[ "${#HUB_PIDS[@]}" -eq 0 ] || exit 19
test_tcp_listener_absent "$port" || exit 20
printf 'PASS: %s cleanup with %s observation\n' "$3" "$observation"
"""
            shell = os.environ.get("BASH", shutil.which("bash"))
            self.assertTrue(shell)
            with (base / "process.log").open("w+") as log:
                (base / "retain").touch()
                process = subprocess.Popen(
                    [
                        shell,
                        "-c",
                        script,
                        "hub-reaping",
                        str(ROOT),
                        str(base),
                        consumer,
                        observation,
                    ],
                    cwd=ROOT,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                try:
                    deadline = time.monotonic() + 15
                    while not (base / "call.ready").exists() and process.poll() is None:
                        self.assertLess(
                            time.monotonic(), deadline, "Hub did not become ready"
                        )
                        time.sleep(0.01)
                    self.assertTrue(
                        (base / "call.ready").exists(), "Hub startup failed"
                    )
                    deadline = time.monotonic() + 10
                    while (
                        not (base / "call.result").exists() and process.poll() is None
                    ):
                        self.assertLess(
                            time.monotonic(),
                            deadline,
                            f"{consumer} cleanup waited for its still-live {observation} Hub",
                        )
                        time.sleep(0.01)
                    self.assertTrue((base / "call.result").exists())
                    process.wait(timeout=15)
                    log.seek(0)
                    self.assertEqual(process.returncode, 0, log.read())
                finally:
                    # The one Hub escapes Bash's group. Its captured native
                    # identity survives clock drift and fixture-record cleanup.
                    cleanup_errors = []
                    try:
                        retire_fixture_hub(base)
                    except (
                        AssertionError,
                        OSError,
                        ValueError,
                        KeyError,
                        TypeError,
                    ) as error:
                        cleanup_errors.append(str(error))
                    if process.poll() is None:
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid, signal.SIGKILL)
                            process.wait(timeout=10)
                    self.assertFalse(cleanup_errors, "; ".join(cleanup_errors))
                    (base / "retain").unlink()

    def test_pending_live_birth_drift_is_not_joined(self):
        self.run_contract("pending", "drift")

    def test_owned_live_birth_drift_is_not_joined(self):
        self.run_contract("owned", "drift")

    def test_pending_unknown_identity_is_not_joined(self):
        self.run_contract("pending", "unknown")

    def test_owned_unknown_identity_is_not_joined(self):
        self.run_contract("owned", "unknown")

    def test_pending_exact_identity_still_cleans_up(self):
        self.run_contract("pending", "normal")

    def test_owned_exact_identity_still_cleans_up(self):
        self.run_contract("owned", "normal")


if __name__ == "__main__":
    unittest.main(verbosity=2)
