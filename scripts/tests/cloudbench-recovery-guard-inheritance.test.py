"""The exact-owner recovery guard must not outlive its recoverer in a flyctl daemon.

PR #1972 (2026-11-12): `run-bench --recover-stale-owner` held the flock'd
recovery guard on a Bash fd. A `flyctl` call inside recovery forked a
long-lived `flyctl agent` daemon that inherited that fd, so the flock stayed
held after recovery exited and the original-volume capture helper refused with
"exact-owner recovery guard is held". This drives the controller's real
acquire/release functions and its real `flyctl` spawn path with a fake flyctl
that daemonizes, then proves the guard is free once recovery releases it.
"""

from __future__ import annotations

import fcntl
import importlib.util
import os
import re
import signal
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FLEET = ROOT / "scripts" / "run-bench-fleet"
_SPEC = importlib.util.spec_from_file_location("condition_wait", ROOT / "scripts" / "lib" / "condition_wait.py")
condition_wait = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(condition_wait)

FAKE_FLYCTL = """#!/usr/bin/env bash
if [ "${1:-}" = proxy ]; then exec sleep 30; fi
# Daemonize like `flyctl agent run`: a detached child keeps every inherited fd.
setsid bash -c 'echo $$ > "$FAKE_DAEMON_PID"; exec sleep 60' </dev/null >/dev/null 2>&1 &
for _ in $(seq 1 50); do [ -s "$FAKE_DAEMON_PID" ] && break; sleep 0.1; done
echo "fake-flyctl $*"
"""


def _function(source: str, name: str) -> str:
    match = re.search(r"^" + re.escape(name) + r"\(\) \{.*?^\}\n", source, re.M | re.S)
    if match is None:
        raise AssertionError(f"run-bench-fleet no longer defines {name}()")
    return match.group()


class RecoveryGuardInheritance(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.common = root / "common"
        self.registry = self.common / "cloudbench-fleet-ownership" / ("a" * 32)
        self.registry.mkdir(parents=True)
        self.guard = self.common / "cloudbench-fleet-recovery-locks" / ("a" * 32)
        bindir = root / "bin"
        bindir.mkdir()
        fake = bindir / "flyctl"
        fake.write_text(FAKE_FLYCTL)
        fake.chmod(0o755)
        self.daemon_pid = root / "daemon.pid"
        (root / "tmp").mkdir()
        self.env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", TMPDIR=str(root / "tmp"),
                        FAKE_DAEMON_PID=str(self.daemon_pid), REGISTRY=str(self.registry),
                        FLEET_OWNER_HOST="fixture-host", FLEET_OWNER_PID_START="fixture-start")
        self.addCleanup(self._reap_daemon)

    def _reap_daemon(self) -> None:
        try:
            os.kill(int(self.daemon_pid.read_text().strip()), signal.SIGKILL)
        except (FileNotFoundError, ValueError, ProcessLookupError):
            pass

    def _script(self, body: str) -> str:
        source = FLEET.read_text()
        names = ["acquire_registry_recovery_lock", "release_registry_recovery_guard",
                 "release_registry_recovery_lock"]
        return "\n".join([
            "set -u",
            'registry_meta_value(){ sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1; }',
            "registry_owner_alive(){ return 1; }",
            *[_function(source, name) for name in names],
            body,
        ])

    def _guard_free(self) -> bool:
        fd = os.open(self.guard, os.O_RDWR | os.O_CLOEXEC)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        finally:
            os.close(fd)
        return True

    def test_flyctl_daemon_spawned_during_recovery_does_not_hold_guard(self) -> None:
        body = """
acquire_registry_recovery_lock "$REGISTRY" || exit 7
flyctl machine stop 0123456789abcd -a fixture-app >/dev/null || exit 8
out="$(flyctl status -a fixture-app)" || exit 9
[ "$out" = "fake-flyctl status -a fixture-app" ] || exit 10
release_registry_recovery_lock "$REGISTRY"
"""
        result = subprocess.run(["bash", "-c", self._script(body)], env=self.env,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        condition_wait.wait_until(lambda: self.daemon_pid.is_file() and self.daemon_pid.read_text().strip(),
                                  timeout=5, description="fake flyctl daemon pid")
        daemon = int(self.daemon_pid.read_text().strip())
        os.kill(daemon, 0)  # the daemon really outlived the recoverer
        self.assertTrue(self._guard_free(),
                        "a flyctl daemon spawned during recovery inherited and holds the recovery guard")

    def test_guard_still_fences_while_recovery_holds_it(self) -> None:
        """Closing the fd for flyctl must not release the recoverer's own lock."""
        body = """
acquire_registry_recovery_lock "$REGISTRY" || exit 7
flyctl machine status 0123456789abcd -a fixture-app >/dev/null || exit 8
python3 - "$GUARD" <<'PY' || exit 11
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(0)
raise SystemExit(1)
PY
release_registry_recovery_lock "$REGISTRY"
"""
        env = dict(self.env, GUARD=str(self.guard))
        result = subprocess.run(["bash", "-c", self._script(body)], env=env,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_python_helpers_with_guard_fd_still_inherit_it(self) -> None:
        """Helpers given --guard-fd keep receiving the fd; only flyctl drops it."""
        body = """
acquire_registry_recovery_lock "$REGISTRY" || exit 7
flyctl machine status 0123456789abcd -a fixture-app >/dev/null || exit 8
python3 -c 'import os, sys; os.fstat(int(sys.argv[1]))' "$REGISTRY_RECOVERY_GUARD_FD" || exit 12
release_registry_recovery_lock "$REGISTRY"
"""
        result = subprocess.run(["bash", "-c", self._script(body)], env=self.env,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_background_flyctl_pid_is_flyctl_itself(self) -> None:
        """`flyctl proxy ... &; pid=$!` must address flyctl, not a wrapper shell.

        The controller TERMs `$!` to stop its data-plane proxies; an extra
        parent shell would orphan the proxy inside the fleet process group.
        """
        body = r"""
acquire_registry_recovery_lock "$REGISTRY" || exit 7
flyctl proxy 1:2 fdaa::1 -a fixture-app &
pid=$!
for _ in $(seq 1 100); do
    args="$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null)"
    case "$args" in sleep\ 30*) break ;; esac
    sleep 0.05
done
case "$args" in sleep\ 30*) ;; *) echo "pid $pid is '$args'" >&2; exit 13 ;; esac
kill -TERM "$pid"; wait "$pid" 2>/dev/null
release_registry_recovery_lock "$REGISTRY"
"""
        result = subprocess.run(["bash", "-c", self._script(body)], env=self.env,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_release_restores_path_and_removes_shim(self) -> None:
        body = """
before="$PATH"
acquire_registry_recovery_lock "$REGISTRY" || exit 7
[ "$(type -P flyctl)" != "$FAKE_BIN/flyctl" ] || exit 15
release_registry_recovery_lock "$REGISTRY"
[ "$PATH" = "$before" ] || exit 16
[ "$(type -P flyctl)" = "$FAKE_BIN/flyctl" ] || exit 17
[ -z "${CLOUDBENCH_FLYCTL_CLOSE_FD:-}" ] || exit 18
"""
        env = dict(self.env, FAKE_BIN=str(Path(self.env["PATH"].split(":", 1)[0])))
        result = subprocess.run(["bash", "-c", self._script(body)], env=env,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        shims = list(Path(self.tmp.name).glob("tmp/cloudbench-guard-flyctl.*"))
        self.assertEqual(shims, [])


if __name__ == "__main__":
    unittest.main()
