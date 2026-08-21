"""Blackbox regressions for the benchmark agent-link viewer boundary."""

import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

from _test_utils import BlackboxResult
from benchmarks import agent_link_server, archive_frontend


class _OccupiedPreferenceSocket:
    """Socket fixture with dense preferred ports and deterministic port-zero binds."""

    assigned_ports = iter((42000, 42000, 43000))

    def __init__(self, *_args: object, **_kwargs: object) -> None:
        self._address = ("127.0.0.1", 0)

    def bind(self, address: tuple[str, int]) -> None:
        host, port = address
        if port > 65535:
            raise OverflowError("bind(): port must be 0-65535")
        if port > 0:
            raise OSError("fixture port is occupied")
        self._address = (host, next(self.assigned_ports))

    def getsockname(self) -> tuple[str, int]:
        return self._address

    def close(self) -> None:
        return None


def _launch_fixture(root: Path, key: str = "run--bench") -> tuple[argparse.Namespace, dict]:
    args = argparse.Namespace(
        context_dir=root / "context",
        preferred_archive_port=61095,
        repo_root=root,
        frontend_dir=root / "front-end",
    )
    source = {
        "key": key,
        "run_json": root / "cloudbench-run.json",
        "upstream_url": "",
        "upstream_api_key": "",
        "upstream_user_id": "",
        "ssh_machine": "",
        "ssh_app": "",
    }
    return args, source


def _start_disposable_process_group(child_pid_path: Path) -> subprocess.Popen:
    script = (
        "import subprocess, sys, time; "
        "child=subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
        "open(sys.argv[1], 'w').write(str(child.pid)); time.sleep(60)"
    )
    process = subprocess.Popen(
        [sys.executable, "-c", script, str(child_pid_path)],
        start_new_session=True,
    )
    deadline = time.monotonic() + 3
    while not child_pid_path.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert child_pid_path.exists()
    return process


def _start_mock_viewer_supervisor(context_dir: Path) -> subprocess.Popen:
    """Real disposable process whose argv matches an archive supervisor owner."""
    return subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import time; time.sleep(60)",
            "archive_frontend.py",
            "--context-dir",
            str(context_dir),
            "--host",
            "127.0.0.1",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def test_archive_launch_uses_kernel_port_after_dense_preference_window() -> None:
    """A dense preference window must still reach the real launch boundary."""
    # The kernel may initially return the just-reserved API port for the frontend
    # request. Production must reject that collision and retry port zero.
    _OccupiedPreferenceSocket.assigned_ports = iter((42000, 42000, 43000))
    with tempfile.TemporaryDirectory() as raw_dir:
        root = Path(raw_dir)
        args, source = _launch_fixture(root)

        with (
            patch.object(agent_link_server.socket, "socket", _OccupiedPreferenceSocket),
            patch.object(agent_link_server, "_viewer_processes_by_context", return_value=({}, True)),
            patch.object(
                agent_link_server,
                "_existing_archive_in",
                side_effect=("", "", "http://localhost:43000"),
            ),
            patch.object(agent_link_server.subprocess, "Popen") as popen,
        ):
            target = agent_link_server._launch_archive_for(args, source)

    assert target == "http://localhost:43000"
    command = popen.call_args.args[0]
    assert command[command.index("--api-port") + 1] == "42000"
    assert command[command.index("--frontend-port") + 1] == "43000"


def test_free_port_clamps_preference_overflow_before_kernel_fallback() -> None:
    _OccupiedPreferenceSocket.assigned_ports = iter((44000,))
    with patch.object(agent_link_server.socket, "socket", _OccupiedPreferenceSocket):
        assert agent_link_server._free_port(65530) == 44000


def test_archive_launch_converges_overfull_cache_to_bound() -> None:
    """The production launch boundary must converge a legacy overfull cache."""
    _OccupiedPreferenceSocket.assigned_ports = iter((42000, 42000, 43000))
    with tempfile.TemporaryDirectory() as raw_dir:
        root = Path(raw_dir)
        args, source = _launch_fixture(root, "new-source")
        viewers_root = args.context_dir / "viewers"
        viewers_root.mkdir(parents=True)
        processes_by_index: list[list[subprocess.Popen]] = []
        try:
            for index in range(18):
                context_dir = viewers_root / f"source-{index:02d}"
                context_dir.mkdir()
                processes = [_start_mock_viewer_supervisor(context_dir)]
                if index == 0:
                    # Legacy duplicate: its older PID is deliberately overwritten
                    # by the newer PID in this context's sole metadata file.
                    processes.append(_start_mock_viewer_supervisor(context_dir))
                processes_by_index.append(processes)
                metadata_path = context_dir / "archive-frontend.json"
                metadata_path.write_text(
                    json.dumps({"supervisor_pid": processes[-1].pid}),
                    encoding="utf-8",
                )
                os.utime(metadata_path, (index, index))

            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                commands = [
                    subprocess.check_output(
                        ["ps", "-ww", "-p", str(process.pid), "-o", "command="],
                        text=True,
                    )
                    for processes in processes_by_index
                    for process in processes
                ]
                if all("archive_frontend.py" in command for command in commands):
                    break
                time.sleep(0.02)

            with (
                patch.object(agent_link_server.socket, "socket", _OccupiedPreferenceSocket),
                patch.object(
                    agent_link_server,
                    "_existing_archive_in",
                    side_effect=("", "", "http://localhost:43000"),
                ),
            ):
                target = agent_link_server._launch_archive_for(args, source)

            assert target == "http://localhost:43000"
            assert all(process.poll() is not None for process in processes_by_index[0])
            assert processes_by_index[1][0].poll() is not None
            assert processes_by_index[2][0].poll() is not None
            assert all(
                process.poll() is None
                for processes in processes_by_index[3:]
                for process in processes
            )
            assert sorted(path.name for path in viewers_root.iterdir()) == [
                "new-source",
                *(f"source-{index:02d}" for index in range(3, 18)),
            ]
        finally:
            for processes in processes_by_index:
                for process in processes:
                    if process.poll() is None:
                        process.terminate()
                    try:
                        process.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=1)


def test_viewer_cache_recycles_unhealthy_launching_context() -> None:
    with tempfile.TemporaryDirectory() as raw_dir:
        viewers_root = Path(raw_dir) / "viewers"
        launching_context = viewers_root / "retry-source"
        launching_context.mkdir(parents=True)
        (launching_context / "archive-frontend.json").write_text(
            json.dumps({"supervisor_pid": 9000}),
            encoding="utf-8",
        )
        with (
            patch.object(agent_link_server, "_viewer_processes_by_context", return_value=({}, True)),
            patch.object(agent_link_server, "_pid_alive", return_value=True),
            patch.object(agent_link_server, "_viewer_pid_is_owned", return_value=True),
            patch.object(agent_link_server, "_wait_for_pid_exit", return_value=True),
            patch.object(agent_link_server.os, "kill") as kill,
        ):
            terminated, slot_available = agent_link_server._reap_excess_viewers(
                viewers_root,
                launching_context,
            )

        assert terminated == [9000]
        assert slot_available
        kill.assert_called_once_with(9000, agent_link_server.signal.SIGTERM)
        assert not launching_context.exists()


def test_viewer_cache_preserves_unverifiable_live_owner() -> None:
    with tempfile.TemporaryDirectory() as raw_dir:
        viewers_root = Path(raw_dir) / "viewers"
        launching_context = viewers_root / "retry-source"
        launching_context.mkdir(parents=True)
        (launching_context / "archive-frontend.json").write_text(
            json.dumps({"supervisor_pid": 9001}),
            encoding="utf-8",
        )
        with (
            patch.object(agent_link_server, "_viewer_processes_by_context", return_value=({}, True)),
            patch.object(agent_link_server, "_pid_alive", return_value=True),
            patch.object(agent_link_server, "_viewer_pid_is_owned", return_value=False),
            patch.object(agent_link_server.os, "kill") as kill,
        ):
            terminated, slot_available = agent_link_server._reap_excess_viewers(
                viewers_root,
                launching_context,
            )

        assert terminated == []
        assert not slot_available
        kill.assert_not_called()
        assert launching_context.exists()


def test_archive_launch_quarantines_malformed_owner_metadata() -> None:
    with tempfile.TemporaryDirectory() as raw_dir:
        root = Path(raw_dir)
        args, source = _launch_fixture(root, "malformed-source")
        context = args.context_dir / "viewers" / source["key"]
        context.mkdir(parents=True)
        (context / "archive-frontend.json").write_text(
            json.dumps({"supervisor_pid": "not-a-pid"}),
            encoding="utf-8",
        )
        with (
            patch.object(agent_link_server, "_viewer_processes_by_context", return_value=({}, True)),
            patch.object(agent_link_server.subprocess, "Popen") as popen,
        ):
            target = agent_link_server._launch_archive_for(args, source)

        assert target == ""
        popen.assert_not_called()
        assert context.exists()


def test_archive_launch_blocks_on_incomplete_viewer_inventory() -> None:
    with tempfile.TemporaryDirectory() as raw_dir:
        root = Path(raw_dir)
        args, source = _launch_fixture(root, "new-source")
        old_context = args.context_dir / "viewers/old-source"
        old_context.mkdir(parents=True)
        (old_context / "archive-frontend.json").write_text(
            json.dumps({"supervisor_pid": 9002}),
            encoding="utf-8",
        )
        with (
            patch.object(
                agent_link_server,
                "_existing_archive_in",
                side_effect=("", "", "http://localhost:43000"),
            ),
            patch.object(
                agent_link_server,
                "_viewer_processes_by_context",
                return_value=({}, False),
            ),
            patch.object(agent_link_server.os, "kill") as kill,
            patch.object(agent_link_server.subprocess, "Popen") as popen,
        ):
            target = agent_link_server._launch_archive_for(args, source)

        assert target == ""
        kill.assert_not_called()
        popen.assert_not_called()
        assert old_context.exists()


def test_archive_frontend_shutdown_reaps_real_process_group() -> None:
    """The supervisor's shutdown primitive must reap its isolated child group."""
    with tempfile.TemporaryDirectory() as raw_dir:
        child_pid_path = Path(raw_dir) / "child.pid"
        frontend = _start_disposable_process_group(child_pid_path)
        try:
            assert archive_frontend._stop_frontend(frontend, grace_seconds=1.0)
            assert frontend.poll() is not None
            try:
                os.killpg(frontend.pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise AssertionError("shutdown left the frontend process group alive")
        finally:
            try:
                os.killpg(frontend.pid, archive_frontend.signal.SIGKILL)
            except OSError:
                pass
            try:
                frontend.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass


def test_archive_frontend_startup_error_reaps_real_process_group() -> None:
    """An API bind/startup error after Popen must not orphan npm or Vite."""
    with tempfile.TemporaryDirectory() as raw_dir:
        root = Path(raw_dir)
        frontend = _start_disposable_process_group(root / "child.pid")
        try:
            with (
                patch.object(archive_frontend, "configure_archive_handler"),
                patch.object(archive_frontend.subprocess, "Popen", return_value=frontend),
                # launch() fail-closes on a dead Vite before the API bind; this
                # fixture isolates the post-ready API race, so skip that gate.
                patch.object(archive_frontend, "_require_frontend_started"),
                patch.object(archive_frontend.signal, "signal"),
                patch.object(
                    archive_frontend,
                    "ThreadingHTTPServer",
                    side_effect=OSError("fixture API port race"),
                ),
            ):
                try:
                    archive_frontend.launch(
                        run_json=None,
                        frontend_dir=root,
                        context_dir=root / "context",
                        host="127.0.0.1",
                        api_port=45000,
                        frontend_port=45001,
                    )
                except OSError as error:
                    assert "fixture API port race" in str(error)
                else:
                    raise AssertionError("startup error did not propagate")

            assert frontend.poll() is not None
            try:
                os.killpg(frontend.pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise AssertionError("startup failure left the frontend process group alive")
        finally:
            try:
                os.killpg(frontend.pid, archive_frontend.signal.SIGKILL)
            except OSError:
                pass
            try:
                frontend.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass


def test_viewer_owner_check_resolves_relative_context_against_process_cwd() -> None:
    with tempfile.TemporaryDirectory() as raw_dir:
        workspace = Path(raw_dir) / "this-workspace"
        context = workspace / ".context/viewers/source"
        relative_context = ".context/viewers/source"
        command = (
            "python3 agents/benchmarks/archive_frontend.py "
            f"--context-dir {relative_context} --host 127.0.0.1"
        )
        cwd_record = f"p1234\nfcwd\nn{workspace}\n"
        with patch.object(
            agent_link_server.subprocess,
            "check_output",
            side_effect=(command, cwd_record),
        ):
            assert agent_link_server._viewer_pid_is_owned(1234, context)

        other_context = Path(raw_dir) / "other-workspace" / relative_context
        absolute_other_command = (
            "python3 agents/benchmarks/archive_frontend.py "
            f"--context-dir {other_context} --host 127.0.0.1"
        )
        with patch.object(
            agent_link_server.subprocess,
            "check_output",
            return_value=absolute_other_command,
        ):
            assert not agent_link_server._viewer_pid_is_owned(1234, context)


def test_viewer_discovery_groups_absolute_and_relative_contexts_exactly() -> None:
    with tempfile.TemporaryDirectory() as raw_dir:
        workspace = Path(raw_dir) / "this-workspace"
        viewers_root = workspace / ".context/viewers"
        absolute_context = viewers_root / "absolute-source"
        relative_context = Path(".context/viewers/relative-source")
        other_context = Path(raw_dir) / "other-workspace/.context/viewers/other-source"
        process_table = "\n".join(
            (
                "101 python3 agents/benchmarks/archive_frontend.py "
                f"--context-dir {absolute_context} --host 127.0.0.1",
                "102 python3 agents/benchmarks/archive_frontend.py "
                f"--context-dir {relative_context} --host 127.0.0.1",
                "103 python3 agents/benchmarks/archive_frontend.py "
                f"--context-dir {other_context} --host 127.0.0.1",
            )
        )

        def process_output(command: list[str], **_kwargs: object) -> str:
            if command[0] == "ps":
                return process_table
            assert command[:4] == ["lsof", "-a", "-p", "102"]
            return f"p102\nfcwd\nn{workspace}\n"

        with patch.object(
            agent_link_server.subprocess,
            "check_output",
            side_effect=process_output,
        ):
            discovered, complete = agent_link_server._viewer_processes_by_context(viewers_root)

        assert complete
        assert discovered == {
            absolute_context.resolve(): [101],
            (workspace / relative_context).resolve(): [102],
        }


def test_viewer_discovery_marks_ps_and_relative_cwd_failures_incomplete() -> None:
    with tempfile.TemporaryDirectory() as raw_dir:
        viewers_root = Path(raw_dir) / "viewers"
        with patch.object(
            agent_link_server.subprocess,
            "check_output",
            side_effect=OSError("fixture ps pressure"),
        ):
            discovered, complete = agent_link_server._viewer_processes_by_context(viewers_root)
        assert discovered == {}
        assert not complete

        relative_process = (
            "101 python3 agents/benchmarks/archive_frontend.py "
            "--context-dir .context/viewers/source --host 127.0.0.1"
        )
        with patch.object(
            agent_link_server.subprocess,
            "check_output",
            side_effect=(relative_process, OSError("fixture lsof pressure")),
        ):
            discovered, complete = agent_link_server._viewer_processes_by_context(viewers_root)
        assert discovered == {}
        assert not complete


async def run_all_tests() -> bool:
    print("agent-link-server blackbox tests:")
    result = BlackboxResult()
    result.record(
        "dense_preference_window_reaches_launch",
        test_archive_launch_uses_kernel_port_after_dense_preference_window,
    )
    result.record(
        "preference_overflow_is_clamped",
        test_free_port_clamps_preference_overflow_before_kernel_fallback,
    )
    result.record(
        "launch_converges_overfull_cache",
        test_archive_launch_converges_overfull_cache_to_bound,
    )
    result.record(
        "viewer_cache_recycles_unhealthy_target",
        test_viewer_cache_recycles_unhealthy_launching_context,
    )
    result.record(
        "viewer_cache_preserves_unverifiable_owner",
        test_viewer_cache_preserves_unverifiable_live_owner,
    )
    result.record(
        "malformed_owner_metadata_is_quarantined",
        test_archive_launch_quarantines_malformed_owner_metadata,
    )
    result.record(
        "incomplete_viewer_inventory_blocks_launch",
        test_archive_launch_blocks_on_incomplete_viewer_inventory,
    )
    result.record(
        "archive_frontend_process_group_is_reaped",
        test_archive_frontend_shutdown_reaps_real_process_group,
    )
    result.record(
        "archive_frontend_startup_error_reaps_group",
        test_archive_frontend_startup_error_reaps_real_process_group,
    )
    result.record(
        "viewer_owner_is_workspace_exact",
        test_viewer_owner_check_resolves_relative_context_against_process_cwd,
    )
    result.record(
        "viewer_discovery_is_workspace_exact",
        test_viewer_discovery_groups_absolute_and_relative_contexts_exactly,
    )
    result.record(
        "viewer_discovery_failure_is_incomplete",
        test_viewer_discovery_marks_ps_and_relative_cwd_failures_incomplete,
    )
    return result.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
