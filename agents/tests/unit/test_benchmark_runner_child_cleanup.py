"""Cement: a signalled local benchmark controller never orphans its runner.

TERMing the local.py controller tore down the isolated stack but left the
run_benchmark.py child and its flyctl log stream running under launchd.
"""

from __future__ import annotations

import inspect
import os
import subprocess
import sys
import time
from pathlib import Path

AGENTS_DIR = Path(__file__).resolve().parents[2]
if str(AGENTS_DIR) not in sys.path:
    sys.path.insert(0, str(AGENTS_DIR))

from benchmarks import local


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_stop_active_child_processes_reaps_runner_and_descendants(tmp_path: Path) -> None:
    grandchild_pid_file = tmp_path / "grandchild.pid"
    runner = subprocess.Popen(
        [
            sys.executable,
            "-c",
            (
                "import pathlib, signal, subprocess, sys, time\n"
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                "child = subprocess.Popen(['sleep', '60'])\n"
                f"pathlib.Path({str(grandchild_pid_file)!r}).write_text(str(child.pid))\n"
                "time.sleep(60)\n"
            ),
        ]
    )
    local._ACTIVE_CHILD_PROCESSES.add(runner)
    try:
        deadline = time.monotonic() + 10
        while not grandchild_pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        grandchild_pid = int(grandchild_pid_file.read_text())

        # The runner ignores TERM, so this also proves the KILL escalation.
        local.stop_active_child_processes(grace_seconds=1)

        assert runner.poll() is not None
        deadline = time.monotonic() + 5
        while _alive(grandchild_pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not _alive(grandchild_pid)
        assert runner not in local._ACTIVE_CHILD_PROCESSES
    finally:
        if runner.poll() is None:
            runner.kill()
            runner.wait()
        local._ACTIVE_CHILD_PROCESSES.discard(runner)


def test_streamed_commands_are_tracked_only_while_running() -> None:
    code, _ = local.run_streamed_command([sys.executable, "-c", "print('ok')"], cwd=AGENTS_DIR)
    assert code == 0
    assert not local._ACTIVE_CHILD_PROCESSES


def test_shutdown_handler_stops_runner_before_services() -> None:
    source = inspect.getsource(local.main)
    handler = source[source.index("def handle_shutdown") :]
    assert handler.index("stop_active_child_processes()") < handler.index("stop_services(")
