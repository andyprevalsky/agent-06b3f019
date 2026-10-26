import json
import os
import pathlib
import runpy
import subprocess
import sys
import tempfile
import time
import unittest

root = pathlib.Path(sys.argv.pop(1))
source = pathlib.Path(sys.argv.pop(1))
text = source.read_text()
# The launch is a function so a lost bind race can relaunch; exercise the whole
# definition and its first call.
start = text.index("launch_backend() {")
end = text.index("\nREADY=0", start)
# Cleanup is installed before port reservation. Keep that actual owner setup
# when exercising the later launch/PID handoff with a pre-owned fixture lock.
cleanup_start = text.index('source "$ROOT_DIR/scripts/lib/cloudbench-env.sh"')
cleanup_end = text.index("\n# Sets PORT and PORT_LOCK_DIR", cleanup_start)
block = 'BACKEND_PID=""\n' + text[cleanup_start:cleanup_end] + "\n" + text[start:end]
identity = runpy.run_path(str(root / "scripts/process-identity.py"))["current_identity"]


def state(pid):
    r = subprocess.run(
        ["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True, timeout=2
    )
    if r.returncode == 1:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return "absent"
        raise AssertionError("process lookup failed for live PID")
    assert r.returncode == 0 and len(r.stdout.split()) == 1
    return r.stdout.strip()


class OwnedBackendCleanup(unittest.TestCase):
    def run_case(self, status, signal_exit=False, unknown=False):
        with tempfile.TemporaryDirectory(prefix="blackbox-owned-cleanup-") as tmp:
            p = pathlib.Path(tmp)
            binpath = p / "bin"
            binpath.mkdir()
            neighbor = None
            controller = None
            leaf_pid = None
            leaf_birth = None
            wrapper_pid = None
            wrapper_birth = None
            leaf = p / "leaf.py"
            leaf.write_text("""import json,os,pathlib,signal,socket,sys,time
p=pathlib.Path(sys.argv[1]);signal.signal(signal.SIGTERM,signal.SIG_IGN)
s=socket.socket();s.bind(('127.0.0.1',0));s.listen()
(p/'ready.tmp').write_text(json.dumps({'pid':os.getpid(),'port':s.getsockname()[1]}))
os.replace(p/'ready.tmp',p/'ready.json')
while True:
 with (p/'heartbeat').open('a') as f:f.write('x')
 time.sleep(.02)
""")
            wrapper = p / "wrapper.py"
            wrapper.write_text("""import os,pathlib,subprocess,sys
p=pathlib.Path(os.environ['FIXTURE_DIR']);child=subprocess.Popen([sys.executable,str(p/'leaf.py'),str(p)])
child.wait()
""")
            fake = binpath / "npx"
            fake.write_text('#!/bin/sh\nexec python3 "$FIXTURE_DIR/wrapper.py"\n')
            fake.chmod(0o700)
            np = p / "neighbor"
            np.mkdir()
            port_lock = p / "port-lock"
            port_lock.mkdir()
            try:
                neighbor = subprocess.Popen(
                    [sys.executable, str(leaf), str(np)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                env = {
                    **os.environ,
                    "PATH": str(binpath) + os.pathsep + os.environ["PATH"],
                    "FIXTURE_DIR": str(p),
                    "ROOT_DIR": str(root),
                    "PORT": "0",
                    "BACKEND_LOG": str(p / "backend.log"),
                    "ARTIFACT_DIR": str(p),
                    "PORT_LOCK_DIR": str(port_lock),
                    "MANIFEST_PATH": str(p / "manifest.json"),
                    "RUN_ID": "blackbox-owned-cleanup",
                    "TEST_BASE_URL": "http://localhost:0",
                    "RUNNER_LOG": str(p / "runner.log"),
                    "SCRIPT_DIR": str(root / "back-end/scripts"),
                }
                # Exercise the unchanged owning launch/trap block; no DB/provider startup.
                script = (
                    "set -euo pipefail\n"
                    + block
                    + '\nprintf "%s\\n" "$BACKEND_PID" > "$FIXTURE_DIR/root.pid"\nwhile [[ ! -e "$FIXTURE_DIR/release" ]]; do sleep .02; done\n'
                    # Linux reads the teardown process table from /proc, not
                    # ps(1), so the unavailable table must be faulted at both
                    # sources for the fail-closed path to be reached.
                    + (
                        "ps() { return 1; }; export -f ps\n"
                        "cloudbench_process_birth_table() { return 1; }\n"
                        if unknown
                        else ""
                    )
                    + ('kill -TERM "$$"\n' if signal_exit else "")
                    + f"exit {status}\n"
                )
                controller = subprocess.Popen(
                    ["/bin/bash", "-c", script],
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                deadline = time.monotonic() + 5
                while not (
                    (p / "ready.json").exists()
                    and (np / "ready.json").exists()
                    and (p / "root.pid").exists()
                    # printf creates the file before it writes the pid.
                    and (p / "root.pid").read_text().strip()
                ):
                    assert controller.poll() is None, (
                        "controller failed before fixture admission"
                    )
                    assert time.monotonic() < deadline, "fixture readiness timed out"
                    time.sleep(0.02)
                info = json.loads((p / "ready.json").read_text())
                leaf_pid = info["pid"]
                leaf_birth = identity(leaf_pid)
                wrapper_pid = int((p / "root.pid").read_text())
                wrapper_birth = identity(wrapper_pid)
                self.assertNotEqual(wrapper_pid, leaf_pid)
                (p / "release").touch()
                output, _ = controller.communicate(timeout=18)
                self.assertEqual(
                    controller.returncode, 1 if unknown else status, output
                )
                if unknown:
                    self.assertTrue(
                        port_lock.is_dir(),
                        "unverified cleanup must retain the port claim",
                    )
                    leaf_state = state(leaf_pid)
                    self.assertNotEqual(leaf_state, "absent", "unknown cleanup must not signal the server")
                    self.assertFalse(leaf_state.startswith("Z"))
                    self.assertIsNone(neighbor.poll())
                    return
                self.assertFalse(
                    port_lock.exists(), "verified cleanup must release the port claim"
                )
                self.assertEqual(
                    state(wrapper_pid), "absent", "direct child must be joined"
                )
                current = state(leaf_pid)
                self.assertTrue(
                    current == "absent" or current.startswith("Z"),
                    f"owned real server survived launcher cleanup: pid={leaf_pid} state={current}",
                )
                before = (p / "heartbeat").read_bytes()
                time.sleep(0.15)
                self.assertEqual(
                    (p / "heartbeat").read_bytes(), before, "late writes after cleanup"
                )
                self.assertIsNone(
                    neighbor.poll(), "same-command neighboring server was killed"
                )
                self.assertFalse(state(neighbor.pid).startswith("Z"))
            finally:
                if controller is not None and controller.poll() is None:
                    controller.terminate()
                    try:
                        controller.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        controller.kill()
                        controller.wait()
                if leaf_pid is None and (p / "ready.json").exists():
                    leaf_pid = json.loads((p / "ready.json").read_text())["pid"]
                    leaf_birth = identity(leaf_pid)
                if wrapper_pid is not None and wrapper_birth is not None:
                    subprocess.run(
                        [
                            sys.executable,
                            str(root / "scripts/process-identity.py"),
                            "--expect",
                            wrapper_birth,
                            "--signal",
                            "KILL",
                            str(wrapper_pid),
                        ],
                        capture_output=True,
                        timeout=2,
                    )
                if leaf_pid is not None and leaf_birth is not None:
                    subprocess.run(
                        [
                            sys.executable,
                            str(root / "scripts/process-identity.py"),
                            "--expect",
                            leaf_birth,
                            "--signal",
                            "KILL",
                            str(leaf_pid),
                        ],
                        capture_output=True,
                        timeout=2,
                    )
                if neighbor is not None and neighbor.poll() is None:
                    neighbor.kill()
                    neighbor.wait(timeout=2)

    def test_unknown_process_state_fails_closed(self):
        self.run_case(0, unknown=True)

    def test_success_retains_exit_and_retires_descendants(self):
        self.run_case(0)

    def test_failure_retains_exit_and_retires_descendants(self):
        self.run_case(7)

    def test_cancellation_retains_exit_and_retires_descendants(self):
        self.run_case(143, True)


unittest.main()
