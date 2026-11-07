#!/usr/bin/env python3
"""`scripts/run-bench --durable` keeps the controller out of the caller's cgroup.

RCA 2026-11-07-boxes-session-scope-kill-reaped-setsid-campaign-controller:
a campaign launched with `setsid ... &` stayed in the agent session's
boxes_workload.slice scope; a boxes.dev daemon restart hard-disposed that
session with a cgroup-wide SIGKILL and the controller died without traps.

The contract tests stub sudo/systemd-run/systemctl (no Fly, no real unit).
The live test runs only with passwordless sudo and systemd as PID 1: it puts
the launcher inside a throwaway scope, SIGKILLs that scope like the daemon's
hard dispose, and requires the durable controller to survive as MainPID.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUN_BENCH = ROOT / "scripts/run-bench"
TASK = "anti-bot-reddit-thread"
LAUNCH = re.compile(r"unit=(\S+) main_pid=(\d+) log=(\S+)")

STUB_CONTROLLER = r"""#!/bin/bash
# A service starts with a clean environment, so the state path is baked in.
FIXTURE_STATE=@STATE@
python3 - "$FIXTURE_STATE/controller-$$.json" "$$" "$@" <<'PY'
import json, os, sys
path, pid, *argv = sys.argv[1:]
cgroup = open("/proc/self/cgroup").read().strip() if os.path.exists("/proc/self/cgroup") else ""
json.dump({"pid": int(pid), "argv": argv, "cwd": os.getcwd(), "cgroup": cgroup,
           "knob": os.environ.get("CLOUDBENCH_FIXTURE_KNOB"),
           "secret": os.environ.get("CLOUDBENCH_FIXTURE_TOKEN"),
           "controller": os.environ.get("RUN_BENCH_DURABLE_CONTROLLER")}, open(path + ".tmp", "w"))
os.replace(path + ".tmp", path)
PY
echo "stub controller output pid=$$"
trap 'echo TERM > "$FIXTURE_STATE/controller-$$.term"; exit 143' TERM
for _ in $(seq 1 600); do
    [ ! -e "$FIXTURE_STATE/release" ] || exit 0
    sleep 0.1
done
"""

FAKE_SUDO = r"""#!/usr/bin/env python3
import os, sys
if os.environ.get("FIXTURE_SUDO_DENIED"):
    sys.exit(1)
assert sys.argv[1] == "-n", sys.argv
os.execvp(sys.argv[2], sys.argv[2:])
"""

# Emulates the systemd contract the launcher relies on: clean environment from
# --setenv only, WorkingDirectory, append-mode output, $VAR expansion in argv.
FAKE_SYSTEMD_RUN = r"""#!/usr/bin/env python3
import json, os, re, sys
state = os.environ["FIXTURE_STATE"]
args = sys.argv[1:]
json.dump(args, open(os.path.join(state, "systemd-run.json"), "w"))
unit, props, env, i = None, {}, {}, 0
while args[i] != "--":
    a = args[i]
    if a == "-p":
        k, _, v = args[i + 1].partition("="); props[k] = v; i += 2; continue
    if a.startswith("--unit="): unit = a.split("=", 1)[1]
    if a.startswith("--setenv="):
        k, _, v = a.split("=", 1)[1].partition("="); env[k] = v
    i += 1
command = args[i + 1:]
def expand(word):
    return re.sub(r"\$\$|\$\{(\w+)\}|\$(\w+)",
                  lambda m: "$" if m.group(0) == "$$" else env.get(m.group(1) or m.group(2), ""), word)
command = [expand(word) for word in command]
pid = os.fork()
if pid == 0:
    os.setsid()
    log = props["StandardOutput"].split(":", 1)[1]
    fd = os.open(log, os.O_WRONLY | os.O_APPEND)
    os.dup2(fd, 1); os.dup2(fd, 2)
    os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
    os.chdir(props["WorkingDirectory"])
    os.execve(command[0], command, env)
open(os.path.join(state, unit + ".mainpid"), "w").write(str(pid))
print(f"Running as unit: {unit}.service")
"""

FAKE_SYSTEMCTL = r"""#!/usr/bin/env python3
import os, sys
state = os.environ["FIXTURE_STATE"]
assert sys.argv[1] == "show" and sys.argv[2] == "-p" and sys.argv[4] == "--value", sys.argv
prop, unit = sys.argv[3], sys.argv[5]
try:
    pid = int(open(os.path.join(state, unit + ".mainpid")).read())
    alive = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[0] != "Z"
except (OSError, ValueError):
    pid, alive = 0, False
print({"MainPID": pid if alive else 0, "ActiveState": "active" if alive else "failed",
       "Result": "success" if alive else "exit-code"}[prop])
"""


def write_exec(path: Path, text: str) -> Path:
    path.write_text(text)
    path.chmod(0o755)
    return path


def pid_alive(pid: int) -> bool:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return False
    return stat.rsplit(")", 1)[1].split()[0] != "Z"


def wait_for(predicate, seconds: float = 30.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.1)
    return predicate()


class DurableLaunchBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="run-bench-durable-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state = self.tmp / "state"
        self.state.mkdir()
        self.addCleanup(self.release_controllers)
        self.controller = write_exec(self.tmp / "controller.sh", STUB_CONTROLLER.replace("@STATE@", json.dumps(str(self.state))))
        self.log = self.tmp / "logs" / "durable.log"
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("CLOUDBENCH_", "RUN_BENCH_"))}
        self.env.update(
            FIXTURE_STATE=str(self.state),
            RUN_BENCH_FLEET_BIN_UNDER_TEST=str(self.controller),
            CLOUDBENCH_FIXTURE_KNOB="7",
            CLOUDBENCH_FIXTURE_TOKEN="must-not-forward",
        )

    def release_controllers(self):
        (self.state / "release").touch()
        for receipt in self.state.glob("controller-*.json"):
            pid = json.loads(receipt.read_text())["pid"]
            if wait_for(lambda: not pid_alive(pid), 10):
                continue
            os.kill(pid, 9)

    def controller_receipt(self) -> dict:
        found = wait_for(lambda: list(self.state.glob("controller-*.json")))
        self.assertEqual(len(found), 1, f"controller never started; log: {self.log_text()}")
        return json.loads(found[0].read_text())

    def log_text(self) -> str:
        return self.log.read_text() if self.log.exists() else "<no log>"

    def run_bench(self, *args, env=None):
        return subprocess.run(["bash", str(RUN_BENCH), *args], env=env or self.env, cwd=self.tmp,
                              capture_output=True, text=True, timeout=120)


class DurableLaunchContract(DurableLaunchBase):
    def setUp(self):
        super().setUp()
        fake_bin = self.tmp / "bin"
        fake_bin.mkdir()
        write_exec(fake_bin / "sudo", FAKE_SUDO)
        write_exec(fake_bin / "systemd-run", FAKE_SYSTEMD_RUN)
        write_exec(fake_bin / "systemctl", FAKE_SYSTEMCTL)
        self.env["PATH"] = f"{fake_bin}{os.pathsep}{self.env['PATH']}"

    def test_controller_is_the_system_service_main_process(self):
        result = self.run_bench(TASK, "--sim-on", "a$b", "--durable-log", str(self.log), "--durable")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        match = LAUNCH.search(result.stdout)
        self.assertIsNotNone(match, result.stdout)
        unit, main_pid, log = match.group(1), int(match.group(2)), match.group(3)
        self.assertEqual(log, str(self.log.resolve()))
        argv = json.loads((self.state / "systemd-run.json").read_text())
        separator = argv.index("--")
        options, command = argv[:separator], argv[separator + 1:]
        for expected in (f"--unit={unit}", f"--uid={os.getuid()}", f"--gid={os.getgid()}",
                         f"WorkingDirectory={self.tmp}", "KillMode=process",
                         f"StandardOutput=append:{log}", f"StandardError=append:{log}",
                         f"--setenv=PATH={self.env['PATH']}", f"--setenv=HOME={self.env['HOME']}",
                         "--setenv=CLOUDBENCH_FIXTURE_KNOB=7", f"--setenv=RUN_BENCH_DURABLE_CONTROLLER={unit}"):
            self.assertIn(expected, options)
        self.assertFalse([o for o in options if "CLOUDBENCH_FIXTURE_TOKEN" in o], options)
        self.assertIn("CLOUDBENCH_FIXTURE_TOKEN", result.stderr)
        self.assertEqual(command[1:], [str(RUN_BENCH), TASK, "--sim-on", "a$$b"])
        receipt = self.controller_receipt()
        # exec semantics: the service MainPID is the controller itself.
        self.assertEqual(receipt["pid"], main_pid)
        self.assertEqual(receipt["argv"], [TASK, "--sim-on", "a$b", "--foreground"])
        self.assertEqual((receipt["knob"], receipt["secret"], receipt["controller"]), ("7", None, unit))
        self.assertTrue(wait_for(lambda: f"stub controller output pid={main_pid}" in self.log_text()))

    def test_fallback_warns_loudly_and_keeps_exec_semantics(self):
        result = self.run_bench(TASK, "--durable-log", str(self.log), env=dict(self.env, FIXTURE_SUDO_DENIED="1"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("DURABLE LAUNCH UNAVAILABLE: passwordless sudo is unavailable", result.stderr)
        self.assertIn("NOT restart-durable", result.stderr)
        self.assertFalse((self.state / "systemd-run.json").exists())
        pid = int(re.search(r"fallback controller: pid=(\d+)", result.stdout).group(1))
        receipt = self.controller_receipt()
        self.assertEqual(receipt["pid"], pid)
        self.assertEqual(receipt["argv"], [TASK, "--foreground"])
        self.assertEqual(receipt["controller"], "setsid")

    def test_detach_flags_and_sticky_logs_are_refused(self):
        for flag in ("--wait", "--detach", "--foreground"):
            result = self.run_bench(TASK, flag, "--durable")
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn(f"omit {flag}", result.stderr)
        sticky = Path(tempfile.gettempdir())
        if sticky.stat().st_mode & 0o1000:
            result = self.run_bench(TASK, "--durable-log", str(sticky / f"durable-{uuid.uuid4().hex}.log"))
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("sticky directory", result.stderr)
        self.assertFalse((self.state / "systemd-run.json").exists())


def live_systemd_available() -> bool:
    return (os.getuid() != 0 and Path("/run/systemd/system").is_dir() and shutil.which("systemd-run")
            and shutil.which("sudo")
            and subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode == 0)


@unittest.skipUnless(live_systemd_available(), "needs systemd as PID 1, systemd-run and passwordless sudo")
class DurableLaunchSurvivesSessionScopeKill(DurableLaunchBase):
    def root(self, *args, check=True):
        return subprocess.run(["sudo", "-n", *args], capture_output=True, text=True, timeout=60, check=check)

    def stop_unit(self, unit: str):
        self.root("systemctl", "stop", unit, check=False)
        self.root("systemctl", "reset-failed", unit, check=False)

    def start_in_session_scope(self, script: str) -> str:
        """Run `script` in a fresh scope, like an agent session's Bash tool."""
        scope = f"rbtest-i21-{uuid.uuid4().hex[:12]}.scope"
        self.addCleanup(self.stop_unit, scope)
        wrapper = write_exec(self.tmp / f"{scope}.sh", "#!/bin/bash\n" + "".join(
            f"export {k}={json.dumps(v)}\n" for k, v in self.env.items() if k in {
                "PATH", "HOME", "FIXTURE_STATE", "RUN_BENCH_FLEET_BIN_UNDER_TEST",
                "CLOUDBENCH_FIXTURE_KNOB", "CLOUDBENCH_FIXTURE_TOKEN"}) + f"cd {json.dumps(str(self.tmp))}\n"
            # The session's own process (the agent CLI) keeps the scope alive.
            + f"setsid sleep 600 </dev/null >/dev/null 2>&1 & echo $! > {json.dumps(str(self.state / 'anchor.pid'))}\n"
            + script)
        self.root("systemd-run", "--scope", "--quiet", f"--unit={scope}", f"--uid={os.getuid()}",
                  f"--gid={os.getgid()}", "--", "/bin/bash", str(wrapper))
        return scope

    def hard_dispose(self, scope: str):
        # The boxes.dev hard dispose SIGKILLs every process in the session cgroup.
        anchor = int((self.state / "anchor.pid").read_text())
        self.assertTrue(pid_alive(anchor))
        self.root("systemctl", "kill", "--signal=SIGKILL", scope)
        self.assertTrue(wait_for(lambda: not pid_alive(anchor), 15), "session scope kill did not happen")

    def test_setsid_control_dies_with_the_session_scope(self):
        self.log.parent.mkdir(parents=True)
        scope = self.start_in_session_scope(
            f'setsid bash {json.dumps(str(self.controller))} {TASK} >>{json.dumps(str(self.log))} 2>&1 </dev/null &\n')
        receipt = self.controller_receipt()
        self.assertTrue(receipt["cgroup"].endswith(f"/{scope}"), receipt["cgroup"])
        self.hard_dispose(scope)
        self.assertTrue(wait_for(lambda: not pid_alive(receipt["pid"]), 15), "setsid control survived the scope kill")
        self.assertFalse((self.state / f"controller-{receipt['pid']}.term").exists())

    def test_durable_controller_survives_the_session_scope_kill(self):
        out = self.tmp / "launch.out"
        scope = self.start_in_session_scope(
            f'bash {json.dumps(str(RUN_BENCH))} {TASK} --durable --durable-log {json.dumps(str(self.log))} '
            f'>{json.dumps(str(out))} 2>&1\n')
        match = LAUNCH.search(out.read_text())
        self.assertIsNotNone(match, out.read_text() + self.log_text())
        unit, main_pid = match.group(1), int(match.group(2))
        self.addCleanup(self.stop_unit, unit)
        receipt = self.controller_receipt()
        self.assertEqual(receipt["pid"], main_pid)
        self.assertEqual(receipt["cgroup"], f"0::/system.slice/{unit}.service")
        self.assertEqual((receipt["knob"], receipt["secret"]), ("7", None))
        self.hard_dispose(scope)
        time.sleep(1)
        self.assertTrue(pid_alive(main_pid), "durable controller died with the caller's session scope")
        self.root("systemctl", "stop", unit)  # TERM reaches the controller's own trap
        self.assertTrue(wait_for(lambda: (self.state / f"controller-{main_pid}.term").exists(), 15))
        self.assertTrue(wait_for(lambda: f"run-bench durable unit {unit} exited" in self.log_text(), 15),
                        self.log_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
