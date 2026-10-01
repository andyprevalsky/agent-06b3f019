"""Blackbox tests for Temporal worker configuration."""

import ast
import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from _test_utils import BlackboxResult, teardown_mock


WORKER_PATH = Path(__file__).resolve().parents[2] / "worker.py"


def test_worker_event_loop_closes_after_terminal_browser_io_times_out():
    """A cancellation-resistant CDP call cannot strand a cleaned worker."""
    script = r"""
import asyncio
from unittest.mock import patch
from domains.spawn_browser_agent_v3 import handler
from helpers.worker_event_loop import run_worker_event_loop

async def main():
    class StubbornCDP:
        async def disconnect(self):
            event = asyncio.Event()
            while True:
                try:
                    await event.wait()
                except asyncio.CancelledError:
                    continue

    async def capture():
        pass

    with patch.object(handler, "BROWSER_TERMINAL_DISCONNECT_TIMEOUT_SECONDS", 0.05):
        try:
            await capture()
            await handler._bounded_browser_terminal_io(StubbornCDP().disconnect(), "cleanup CDP disconnect")
        except TimeoutError:
            print("terminal-timeout", flush=True)
    print("cleanup-complete", flush=True)

run_worker_event_loop(main())
print("process-exited", flush=True)
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=WORKER_PATH.parent,
        capture_output=True,
        text=True,
        timeout=6,
    )
    assert result.returncode == 0, result.stderr[-500:]
    assert "terminal-timeout\ncleanup-complete\n" in result.stdout
    assert result.stdout.rstrip().endswith("process-exited")


def test_worker_optional_cdp_timeout_preserves_resource_drain_and_exits():
    """Expired CDP children cannot delay recording cleanup or strand shutdown."""
    script = r"""
import asyncio
from unittest.mock import patch
from domains.spawn_browser_agent_v3 import handler
from helpers.worker_event_loop import run_worker_event_loop

async def main():
    class StubbornCDP:
        async def disconnect(self):
            event = asyncio.Event()
            while True:
                try:
                    await event.wait()
                except asyncio.CancelledError:
                    continue

    async def capture():
        pass

    async def recording_cleanup():
        await asyncio.sleep(0.03)
        print("recording-cleanup-complete", flush=True)

    with patch.object(handler, "BROWSER_DISCONNECT_TIMEOUT_SECONDS", 0.02):
        await handler.disconnect_browser_after_passkey_capture(StubbornCDP(), capture)
    cleanup = asyncio.create_task(recording_cleanup())
    handler._background_browser_cleanup_tasks.add(cleanup)
    try:
        started = asyncio.get_running_loop().time()
        await handler.drain_background_browser_cleanups(timeout=0.4)
        elapsed = asyncio.get_running_loop().time() - started
        assert cleanup.done(), "owned recording cleanup was not drained"
        assert elapsed < 0.2, f"expired CDP cleanup consumed another drain: {elapsed}"
    finally:
        handler._background_browser_cleanup_tasks.discard(cleanup)

run_worker_event_loop(main())
print("process-exited", flush=True)
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=WORKER_PATH.parent,
        capture_output=True,
        text=True,
        timeout=8,
    )
    assert result.returncode == 0, result.stderr[-500:]
    assert "recording-cleanup-complete" in result.stdout
    assert result.stdout.rstrip().endswith("process-exited")


def test_worker_event_loop_rejects_unrelated_pending_work():
    script = r"""
import asyncio
from helpers.worker_event_loop import run_worker_event_loop

async def main():
    async def unrelated():
        event = asyncio.Event()
        while True:
            try:
                await event.wait()
            except asyncio.CancelledError:
                continue
    asyncio.create_task(unrelated(), name="unrelated-work")
    await asyncio.sleep(0)

run_worker_event_loop(main())
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=WORKER_PATH.parent,
        capture_output=True,
        text=True,
        timeout=6,
    )
    assert result.returncode != 0
    assert "Worker shutdown left unrelated tasks pending: unrelated-work" in result.stderr


def test_worker_event_loop_preserves_primary_failure_during_bad_shutdown():
    script = r"""
import asyncio
from helpers import worker_event_loop
from unittest.mock import patch
async def main():
    async def stubborn():
        while True:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                pass
    asyncio.create_task(stubborn(), name="unrelated-work")
    await asyncio.sleep(0)
    raise ValueError("original worker failure")
with patch.object(worker_event_loop, "_TASK_DRAIN_SECONDS", 0.01):
    try:
        worker_event_loop.run_worker_event_loop(main())
    except BaseException as error:
        assert isinstance(error, ValueError), "shutdown replaced the original worker error"
        assert str(error) == "original worker failure"
    else:
        raise AssertionError("worker failure was lost")
"""
    result = subprocess.run(
        [sys.executable, "-c", script], cwd=WORKER_PATH.parent, capture_output=True, text=True, timeout=6
    )
    assert result.returncode == 0, result.stderr[-500:]
    assert "Worker shutdown left unrelated tasks pending" in result.stderr


def test_worker_event_loop_stops_browser_event_buses_before_pending_check():
    """An idle browser-use bus is owned cleanup work, not an orphaned task."""
    script = r"""
from bubus import BaseEvent, EventBus
from helpers.worker_event_loop import run_worker_event_loop

async def main():
    bus = EventBus(name="worker_shutdown_bus")
    await bus.dispatch(BaseEvent())
    assert bus._is_running

run_worker_event_loop(main())
print("process-exited", flush=True)
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=WORKER_PATH.parent,
        capture_output=True,
        text=True,
        timeout=6,
    )
    assert result.returncode == 0, result.stderr[-500:]
    assert result.stdout.rstrip().endswith("process-exited")


def _worker_tree() -> ast.Module:
    return ast.parse(WORKER_PATH.read_text())


def test_worker_does_not_use_python_custom_activity_slots():
    """Activity slots must stay SDK-native to avoid Temporal Rust/Python GIL deadlocks."""
    tree = _worker_tree()

    imported_names: set[str] = set()
    custom_slot_subclasses: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "temporalio.worker":
            imported_names.update(alias.name for alias in node.names)
        if isinstance(node, ast.ClassDef):
            for base in node.bases:
                if isinstance(base, ast.Name) and base.id == "CustomSlotSupplier":
                    custom_slot_subclasses.append(node.name)

    assert "CustomSlotSupplier" not in imported_names
    assert custom_slot_subclasses == []


def test_worker_activity_supplier_is_sdk_native_fixed_size():
    """WorkerTuner activity_supplier should be FixedSizeSlotSupplier(max_concurrent_activities)."""
    tree = _worker_tree()

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if (
            isinstance(func, ast.Attribute)
            and func.attr == "create_composite"
            and isinstance(func.value, ast.Name)
            and func.value.id == "WorkerTuner"
        ):
            activity_kw = next((kw for kw in node.keywords if kw.arg == "activity_supplier"), None)
            assert activity_kw is not None
            value = activity_kw.value
            assert isinstance(value, ast.Call)
            assert isinstance(value.func, ast.Name)
            assert value.func.id == "FixedSizeSlotSupplier"
            assert len(value.args) == 1
            arg = value.args[0]
            assert isinstance(arg, ast.Attribute)
            assert arg.attr == "max_concurrent_activities"
            return

    raise AssertionError("WorkerTuner.create_composite call not found")


def test_worker_workflow_supplier_is_fixed_size_not_resource_based():
    """Workflow slots must be FixedSizeSlotSupplier(max_concurrent_workflows).

    ResourceBasedSlotSupplier throttles workflow-task slot permits whenever host
    memory sits above its target — the steady state on dev Macs (~83-85%) and on
    prod Fly machines (autoscaler runs memory up to its 75-80% thresholds).
    Pollers must reserve a slot BEFORE polling, so the lone sticky poller loses
    the permit race and every workflow task burns the full 10s
    sticky_queue_schedule_to_start_timeout, then replays on a random worker.
    Observed: a $0-LLM fast-cache smoke replay spent ~137s of 153s in
    back-to-back 10s sticky timeouts. Memory protection belongs to the activity
    admission gate + autoscaler, not workflow-task slot starvation.
    """
    tree = _worker_tree()

    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "temporalio.worker":
            resource_imports = {alias.name for alias in node.names if alias.name.startswith("ResourceBased")}
            assert resource_imports == set(), (
                f"worker.py must not import {sorted(resource_imports)}: resource-based "
                "slot suppliers starve sticky polling under steady-state memory pressure"
            )

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if (
            isinstance(func, ast.Attribute)
            and func.attr == "create_composite"
            and isinstance(func.value, ast.Name)
            and func.value.id == "WorkerTuner"
        ):
            workflow_kw = next((kw for kw in node.keywords if kw.arg == "workflow_supplier"), None)
            assert workflow_kw is not None
            value = workflow_kw.value
            assert isinstance(value, ast.Call)
            assert isinstance(value.func, ast.Name)
            assert value.func.id == "FixedSizeSlotSupplier"
            assert len(value.args) == 1
            arg = value.args[0]
            assert isinstance(arg, ast.Attribute)
            assert arg.attr == "max_concurrent_workflows"
            return

    raise AssertionError("WorkerTuner.create_composite call not found")


def test_worker_passes_sticky_queue_timeout_to_temporal():
    """Worker must pass the env-backed sticky timeout into Temporal."""
    tree = _worker_tree()

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id == "Worker":
            timeout_kw = next(
                (kw for kw in node.keywords if kw.arg == "sticky_queue_schedule_to_start_timeout"),
                None,
            )
            assert timeout_kw is not None
            value = timeout_kw.value
            assert isinstance(value, ast.Call)
            assert isinstance(value.func, ast.Name)
            assert value.func.id == "timedelta"
            seconds_kw = next((kw for kw in value.keywords if kw.arg == "seconds"), None)
            assert seconds_kw is not None
            attr = seconds_kw.value
            assert isinstance(attr, ast.Attribute)
            assert attr.attr == "sticky_queue_schedule_to_start_timeout_seconds"
            return

    raise AssertionError("Worker(...) call not found")


def test_activity_admission_closes_on_cpu_pressure():
    """Activity admission must close on CPU pressure (not just memory).

    The per-turn agent work runs inside activities on a single GIL-bound vCPU,
    so a worker pegs its core (event-loop starvation) long before memory fills.
    Closing admission on high CPU is what makes the fleet autoscaler — which
    counts admission-unavailable workers — scale out on CPU pressure.
    """
    import os
    from unittest.mock import MagicMock, patch

    os.environ.setdefault("TEMPORAL_ADDRESS", "localhost:7233")
    os.environ.setdefault("TEMPORAL_TASK_QUEUE", "test")
    import worker

    snap = worker.ActivityAdmissionSnapshot(
        maximum_slots=100,
        close_memory_percent=80,
        open_memory_percent=75,
        close_cpu_percent=85,
        open_cpu_percent=70,
    )

    def mem(p):
        return patch("worker.psutil.virtual_memory", return_value=MagicMock(percent=p))

    def cpu(p):
        return patch("worker.psutil.cpu_percent", return_value=p)

    # CPU pegged, memory fine → admission closes (the fan-out case).
    with mem(50.0), cpu(95.0):
        snap._refresh_admission()
    assert snap._admission_open is False

    # Both recovered → admission reopens.
    with mem(50.0), cpu(60.0):
        snap._refresh_admission()
    assert snap._admission_open is True

    # CPU still elevated (above open threshold), memory fine → stays open only
    # when BOTH are under the open band; here CPU is 80 > 70 so it must NOT reopen
    # after a close.
    with mem(50.0), cpu(95.0):
        snap._refresh_admission()
    assert snap._admission_open is False
    with mem(50.0), cpu(80.0):
        snap._refresh_admission()
    assert snap._admission_open is False  # CPU 80 > open 70 → still closed

    # Memory pressure alone still closes admission (original behavior preserved).
    with mem(50.0), cpu(60.0):
        snap._refresh_admission()
    assert snap._admission_open is True
    with mem(85.0), cpu(50.0):
        snap._refresh_admission()
    assert snap._admission_open is False

    # Invalid config rejected.
    try:
        worker.ActivityAdmissionSnapshot(
            maximum_slots=100,
            close_memory_percent=80,
            open_memory_percent=75,
            close_cpu_percent=70,
            open_cpu_percent=85,
        )
        raise AssertionError("expected ValueError for open_cpu >= close_cpu")
    except ValueError:
        pass


def test_local_worker_supervisor_delivers_one_cancellation_and_waits_for_cleanup():
    """Repeated wrapper signals must not force-exit a worker during replay cleanup."""
    launcher = WORKER_PATH.parent / "scripts" / "run_local_worker.sh"
    for count in (1, 3):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".env").touch()
            (root / "worker.py").write_text(
                "import os, signal, time\n"
                "from pathlib import Path\n"
                "index = os.environ['WORKER_INDEX']\n"
                "signals = 0\n"
                "def stop(*args):\n"
                " global signals\n"
                " signals += 1\n"
                " if signals > 1: raise SystemExit(9)\n"
                " time.sleep(.3)\n"
                " Path('clean-' + index).write_text(str(signals))\n"
                " raise SystemExit(0)\n"
                "signal.signal(signal.SIGTERM, stop)\n"
                "Path('ready-' + index).touch()\n"
                "while True: time.sleep(.01)\n"
            )
            process = subprocess.Popen(
                ["bash", str(launcher)],
                cwd=root,
                env={
                    **os.environ,
                    "PATH": f"{Path(sys.executable).parent}:{os.environ.get('PATH', '')}",
                    "WORKER_PROCESSES": str(count),
                    "NAVI_WORKER_LOG_STREAM": "false",
                    "NAVI_WORKER_LOG_FILE": str(root / "worker.log"),
                },
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                deadline = time.monotonic() + 10
                while not all((root / f"ready-{index}").exists() for index in range(count)):
                    assert process.poll() is None, "worker supervisor exited before readiness"
                    assert time.monotonic() < deadline, "worker fixture did not become ready"
                    time.sleep(0.02)
                process.send_signal(signal.SIGTERM)
                time.sleep(0.05)
                process.send_signal(signal.SIGTERM)
                assert process.wait(timeout=5) == 0, "repeat cancellation killed a cleanup in progress"
                assert all((root / f"clean-{index}").read_text() == "1" for index in range(count))
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                    process.wait(timeout=10)


def test_local_worker_supervisor_bounds_reaping_after_kill():
    import importlib.util
    from unittest.mock import Mock, patch

    path = WORKER_PATH.parent / "scripts/local_worker_supervisor.py"
    spec = importlib.util.spec_from_file_location("worker_supervisor_reaping_test", path)
    supervisor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(supervisor)
    child = Mock(pid=987654321)
    child.poll.return_value = None

    def wait(timeout=None):
        assert timeout is not None and 0 <= timeout <= 5, "post-kill wait was unbounded"
        raise subprocess.TimeoutExpired("owned-worker", timeout)

    child.wait.side_effect = wait
    clock = iter((0.0, 0.0, 100000.0, 100000.0, 100000.0))
    with (
        tempfile.TemporaryDirectory() as directory,
        patch.dict(
            os.environ,
            {
                "WORKER_PROCESSES": "2",
                "NAVI_WORKER_LOG_STREAM": "false",
                "NAVI_WORKER_LOG_FILE": str(Path(directory) / "worker.log"),
            },
        ),
        patch.object(supervisor.subprocess, "Popen", side_effect=[child, OSError("spawn failed")]),
        patch.object(supervisor.signal, "signal"),
        patch.object(supervisor.os, "killpg") as kill,
        patch.object(supervisor.time, "monotonic", side_effect=lambda: next(clock, 100000.0)),
        patch.object(supervisor.time, "sleep"),
    ):
        assert supervisor.main() == 1
    kill.assert_called_once_with(child.pid, signal.SIGKILL)
    child.send_signal.assert_called_once_with(signal.SIGTERM)


def _check_stack_worker_cleanup(worker_exit, bad_receipt=False):
    """Real Bash-owned children must finish a delayed HTTP cleanup before backend exit."""
    import shlex

    repository = WORKER_PATH.parent.parent
    source = (repository / "scripts/run.sh").read_text()

    def function(name):
        start = source.index(name + "() {")
        return source[start : source.index("\n}", start) + 2]

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / "expected-exit").write_text(str(worker_exit))
        (root / "backend.py").write_text(
            "from http.server import HTTPServer,BaseHTTPRequestHandler\nfrom pathlib import Path\n"
            "class Handler(BaseHTTPRequestHandler):\n"
            " def do_GET(self): self.send_response(200); self.end_headers(); self.wfile.write(b'cleanup-ok')\n"
            " def log_message(self,*args): pass\n"
            "server=HTTPServer(('127.0.0.1',0),Handler)\n"
            "Path('backend.port').write_text(str(server.server_port))\nserver.serve_forever()\n"
        )
        (root / "worker.py").write_text(
            "import signal,time,urllib.request\nfrom pathlib import Path\n"
            "def stop(*args):\n time.sleep(2)\n"
            " with urllib.request.urlopen('http://127.0.0.1:'+Path('backend.port').read_text(),timeout=1) as response:\n"
            "  assert response.read()==b'cleanup-ok'\n"
            " Path('provider-cleanup-complete').touch()\n raise SystemExit(int(Path('expected-exit').read_text()))\n"
            "signal.signal(signal.SIGTERM,stop)\nPath('worker.ready').touch()\n"
            "while True: time.sleep(.05)\n"
        )
        script = "\n".join(
            [
                "set -eo pipefail",
                f"SCRIPT_DIR={shlex.quote(str(repository / 'scripts'))}",
                'source "$SCRIPT_DIR/lib/run-process-cleanup.sh"',
                function("kill_tree"),
                function("kill_tree_hard"),
                function("cleanup"),
                f"{shlex.quote(sys.executable)} backend.py &",
                "backend_fixture_pid=$!",
                'printf "%s" "$backend_fixture_pid" > backend.pid',
                f"{shlex.quote(sys.executable)} worker.py &",
                "AGENTS_PID=$!",
                "fixture_cleanup() { local code=$?; "
                'if kill -0 "$backend_fixture_pid" 2>/dev/null; then '
                'echo "owned backend survived before fixture safety trap" >&2; code=99; fi; '
                'kill "$AGENTS_PID" "$backend_fixture_pid" 2>/dev/null || true; '
                'wait 2>/dev/null || true; exit "$code"; }',
                "trap fixture_cleanup EXIT",
                'AGENTS_BIRTH="$(ps -p "$AGENTS_PID" -o lstart= | sed \'s/^ *//;s/ *$//\')"',
                'PIDS=("$backend_fixture_pid" "$AGENTS_PID")',
                "NAMES=(back-end agents)",
                "SHUTTING_DOWN=false",
                "BENCHMARK_ISOLATED_RUN=true",
                "DB_OWNED_BY_US=false",
                "USE_SYSTEM_PG=false",
                "SYSTEM_DB_OWNED_BY_US=false",
                "NGROK_CONFIG_FILE=",
                "FAIL_DIR=",
                "RUN_STACK_CLEANUP_TOKEN=fixture",
                f"RUN_STACK_CLEANUP_STATUS_FILE={shlex.quote(str(root / ('missing/stack.status' if bad_receipt else 'stack.status')))}",
                "BACKEND_PID=",
                "write_services_manifest() { :; }",
                "for attempt in {1..100}; do [ ! -f worker.ready ] || [ ! -f backend.port ] || break; sleep .02; done",
                "cleanup" if bad_receipt else "cleanup_code=0; cleanup || cleanup_code=$?",
                'if kill -0 "$backend_fixture_pid" 2>/dev/null; then echo "owned backend survived before fixture safety trap" >&2; exit 99; fi',
                'exit "$cleanup_code"',
            ]
        )
        process = subprocess.Popen(
            ["bash", "-c", script],
            cwd=root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=12)
            assert process.returncode == (0 if worker_exit == 0 and not bad_receipt else 1), (stdout, stderr)
            if not bad_receipt:
                receipt = dict(line.split("=", 1) for line in (root / "stack.status").read_text().splitlines())
                assert receipt["state"] == ("clean" if worker_exit == 0 else "failed")
            backend_pid = (root / "backend.pid").read_text()
            alive = subprocess.run(["ps", "-p", backend_pid, "-o", "stat="], capture_output=True, text=True)
            assert not alive.stdout.strip(), "owned backend survived worker cleanup failure"
            assert (root / "provider-cleanup-complete").exists(), "backend stopped before worker HTTP cleanup"
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)


def test_stack_reaps_services_when_pending_receipt_cannot_be_written():
    for worker_exit in (0, 1):
        _check_stack_worker_cleanup(worker_exit, bad_receipt=True)


def test_stack_keeps_backend_available_until_owned_worker_cleanup_finishes():
    _check_stack_worker_cleanup(0)


def test_stack_reaps_other_services_and_preserves_failed_worker_receipt():
    _check_stack_worker_cleanup(7)


def _cleanup_worker_port_fixture(
    root, process, identity, sockets, stop_handoff, handoff, channel_path, channel_root, primary_error
):
    """Keep independent fixture retirement failures from hiding the startup error."""
    import runpy

    errors = []

    def attempt(label, operation):
        try:
            return operation()
        except BaseException as error:
            errors.append(f"{label}: {type(error).__name__}: {error}")
            return None

    def live(pid, native):
        observed = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True, check=False)
        if observed.returncode == 1 and not observed.stdout.strip():
            return False
        assert observed.returncode == 0 and observed.stdout.strip(), "fixture identity inspection failed"
        if observed.stdout.strip().startswith("Z"):
            return False
        try:
            return identity["current_identity"](pid) == native
        except (OSError, ValueError, IndexError):
            again = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True, check=False)
            assert (again.returncode == 1 and not again.stdout.strip()) or again.stdout.strip().startswith("Z")
            return False

    def stop_supervisor():
        if process is None:
            return
        if process.poll() is None:
            # An unreaped Popen owns its exact child; no process-group discovery.
            process.terminate()
        process.wait(timeout=5)

    attempt("supervisor drain", stop_supervisor)
    if process is not None and process.poll() is None:
        fixture = runpy.run_path(str(WORKER_PATH.parent.parent / "scripts/tests/fixture_process.py"))
        attempt("supervisor tree containment", lambda: fixture["terminate_fixture_tree"](process))
        if process.poll() is None:
            attempt("owned supervisor kill", process.kill)
        attempt("owned supervisor join", lambda: process.wait(timeout=5))

    def check_child(path):
        child = json.loads(path.read_text())
        if live(child["pid"], child["native"]):
            errors.append(f"worker survived supervisor join: {path.name}")
            result = identity["main"](["identity", "--expect", child["native"], "--signal", "KILL", str(child["pid"])])
            assert result == 0 or not live(child["pid"], child["native"]), "exact child containment failed"
            deadline = time.monotonic() + 2
            while live(child["pid"], child["native"]) and time.monotonic() < deadline:
                time.sleep(0.02)
            assert not live(child["pid"], child["native"]), "captured child survived containment"

    for path in root.glob("identity-*.json"):
        attempt(path.name, lambda path=path: check_child(path))
    stop_handoff.set()
    for sock in sockets:
        attempt("socket close", sock.close)
    if handoff is not None and handoff.ident is not None:
        attempt("handoff join", lambda: handoff.join(timeout=2))
        if handoff.is_alive():
            errors.append("primary descriptor handoff thread did not stop")
    attempt("channel unlink", lambda: channel_path.unlink(missing_ok=True))
    attempt("channel directory", channel_root.rmdir)
    status = {
        "state": "failed_retained" if errors else "verified",
        "supervisor_joined": process is None or process.poll() is not None,
        "cleanup_errors": errors.copy(),
    }

    def publish():
        pending = root / "fixture-cleanup.tmp"
        pending.write_text(json.dumps(status))
        pending.replace(root / "fixture-cleanup.json")

    attempt("cleanup receipt", publish)
    if errors:
        detail = f"Worker fixture cleanup failed; retained evidence: {root}: {errors}"
        if primary_error is not None:
            primary_error.add_note(detail)
        else:
            raise AssertionError(detail)


def test_local_workers_do_not_alias_an_occupied_secondary_port():
    """Fixed primary sockets stay owned while real secondary binds avoid a sibling."""
    import array
    import runpy
    import threading

    repository = WORKER_PATH.parent.parent
    identity = runpy.run_path(str(repository / "scripts/process-identity.py"))
    launcher = WORKER_PATH.parent / "scripts/run_local_worker.sh"
    artifact_root = repository / ".context/test-runs"
    artifact_root.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="worker-ports-", dir=artifact_root))
    # Darwin UNIX socket paths are short; diagnostics remain in the retained run.
    channel_root = Path(tempfile.mkdtemp(prefix="rw-"))
    channel_path = channel_root / "ports.sock"
    sockets = []
    process = None
    handoff = None
    stop_handoff = threading.Event()
    handoff_errors = []
    primary_error = None

    def listener(address):
        sock = socket.socket()
        sockets.append(sock)
        sock.bind(address)
        sock.listen()
        return sock

    try:
        (root / ".env").touch(mode=0o600)
        primary = listener(("0.0.0.0", 0))
        primary_port = primary.getsockname()[1]
        blocker = socket.socket()
        sockets.append(blocker)
        for _ in range(50):
            old_secondary = primary_port % 1000 + 19001
            try:
                blocker.bind(("0.0.0.0", old_secondary))
                break
            except OSError:
                primary.close()
                primary = listener(("0.0.0.0", 0))
                primary_port = primary.getsockname()[1]
        else:
            raise AssertionError("could not reserve an isolated collision fixture")
        blocker.listen()
        health = listener(("0.0.0.0", 0))
        health_port = health.getsockname()[1]
        channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sockets.append(channel)
        channel.bind(str(channel_path))
        channel.listen(1)
        channel.settimeout(0.1)

        def transfer_primary():
            try:
                deadline = time.monotonic() + 10
                while not stop_handoff.is_set() and time.monotonic() < deadline:
                    try:
                        connection, _ = channel.accept()
                    except socket.timeout:
                        continue
                    with connection:
                        connection.settimeout(1)
                        descriptors = array.array("i", [primary.fileno(), health.fileno()])
                        connection.sendmsg([b"P"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, descriptors)])
                    return
            except OSError as error:
                if not stop_handoff.is_set():
                    handoff_errors.append(type(error).__name__ + ": " + str(error))

        (root / "worker.py").write_text(
            "import array, json, os, runpy, signal, socket\nfrom pathlib import Path\n"
            f"identity = runpy.run_path({str(repository / 'scripts/process-identity.py')!r})\n"
            "index = os.environ['WORKER_INDEX']\n"
            "def stop(*args): raise SystemExit(0)\n"
            "signal.signal(signal.SIGTERM, stop)\n"
            "pending = Path('identity-' + index + '.tmp')\n"
            "pending.write_text(json.dumps({'pid':os.getpid(),'native':identity['current_identity'](os.getpid())}))\n"
            "pending.replace('identity-' + index + '.json')\n"
            "sockets = []\n"
            "requested = [int(os.environ[key]) for key in ('SDK_METRICS_PORT', 'HEALTH_CHECK_PORT')]\n"
            "if index == '0':\n"
            "    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:\n"
            "        channel.settimeout(2)\n"
            "        channel.connect(os.environ['WORKER_FIXTURE_PRIMARY_CHANNEL'])\n"
            "        item = array.array('i')\n"
            "        data, ancillary, flags, _ = channel.recvmsg(1, socket.CMSG_SPACE(2 * item.itemsize))\n"
            "        assert data == b'P' and not flags, 'primary descriptor transfer truncated'\n"
            "        for level, kind, payload in ancillary:\n"
            "            assert level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS\n"
            "            item.frombytes(payload)\n"
            "        assert len(item) == 2, 'primary descriptor count changed'\n"
            "        sockets = [socket.socket(fileno=fd) for fd in item]\n"
            "        assert [sock.getsockname()[1] for sock in sockets] == requested, 'fixed primary env changed'\n"
            "else:\n"
            "    assert requested == [0, 0], 'secondary ports must be assigned by actual binds'\n"
            "    for port in requested:\n"
            "        sock = socket.socket()\n"
            "        sock.bind(('0.0.0.0', port))\n"
            "        sock.listen()\n"
            "        sockets.append(sock)\n"
            "ready = 'ready-' + index\n"
            "with open(ready + '.tmp', 'w') as output:\n"
            "    json.dump([sock.getsockname()[1] for sock in sockets], output)\n"
            "os.replace(ready + '.tmp', ready)\n"
            "signal.pause()\n"
        )
        handoff = threading.Thread(target=transfer_primary, name="worker-fixture-primary-handoff")
        handoff.start()
        env = {
            **os.environ,
            "PATH": f"{Path(sys.executable).parent}:{os.environ.get('PATH', '')}",
            "WORKER_PROCESSES": "2",
            "SDK_METRICS_PORT": str(primary_port),
            "HEALTH_CHECK_PORT": str(health_port),
            "NAVI_WORKER_LOG_STREAM": "false",
            "NAVI_WORKER_LOG_FILE": str(root / "worker.log"),
            "WORKER_FIXTURE_PRIMARY_CHANNEL": str(channel_path),
        }
        with (root / "launcher.log").open("wb") as output:
            process = subprocess.Popen(
                ["bash", str(launcher)],
                cwd=root,
                env=env,
                stdout=output,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                umask=0o077,
            )
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if all((root / f"ready-{index}").exists() for index in range(2)):
                break
            if process.poll() is not None or handoff_errors:
                break
            time.sleep(0.02)
        logs = "\n".join(
            f"{name}:\n" + ((root / name).read_text() if (root / name).exists() else "<missing>")
            for name in ("launcher.log", "worker.log", "worker.1.log")
        )
        assert all((root / f"ready-{index}").exists() for index in range(2)), (
            f"Local workers did not become ready; retained evidence: {root}\n{logs}\n{handoff_errors}"
        )
        ports = [json.loads((root / f"ready-{index}").read_text()) for index in range(2)]
        assert ports[0] == [primary_port, health_port]
        assert len({port for pair in ports for port in pair}) == 4
        assert old_secondary not in ports[1]
        assert blocker.getsockname()[1] == old_secondary
    except BaseException as error:
        primary_error = error
        raise
    finally:
        _cleanup_worker_port_fixture(
            root, process, identity, sockets, stop_handoff, handoff, channel_path, channel_root, primary_error
        )


def _worker_port_regression_case(mode):
    """Drive the real launcher fixture through a stolen-port or early-exit boundary."""
    from unittest.mock import patch

    real_popen = subprocess.Popen
    captured = []
    retained = []
    blockers = []
    taken = []
    artifact_root = WORKER_PATH.parent.parent / ".context/test-runs"
    artifact_root.mkdir(parents=True, exist_ok=True)

    class RetainedDirectory:
        def __enter__(self):
            path = Path(tempfile.mkdtemp(prefix="worker-port-control-", dir=artifact_root))
            retained.append(path)
            return str(path)

        def __exit__(self, *_args):
            return False

    def launch(command, **kwargs):
        if command == ["bash", str(WORKER_PATH.parent / "scripts/run_local_worker.sh")]:
            root = Path(kwargs["cwd"])
            retained.append(root)
            if mode == "takeover":
                for key in ("SDK_METRICS_PORT", "HEALTH_CHECK_PORT"):
                    blocker = socket.socket()
                    try:
                        blocker.bind(("0.0.0.0", int(kwargs["env"][key])))
                        blocker.listen()
                    except OSError as error:
                        import errno

                        blocker.close()
                        assert error.errno == errno.EADDRINUSE
                        taken.append(False)
                    else:
                        blockers.append(blocker)
                        taken.append(True)
            else:
                worker_path = root / "worker.py"
                worker_path.write_text(
                    "import os\n"
                    "if os.environ['WORKER_INDEX'] == '0': raise RuntimeError('forced-primary-startup-failure')\n"
                    + worker_path.read_text()
                )
            child = real_popen(command, **kwargs)
            captured.append(child)
            return child
        return real_popen(command, **kwargs)

    failure = None
    try:
        with (
            patch.object(subprocess, "Popen", side_effect=launch),
            patch.object(tempfile, "TemporaryDirectory", RetainedDirectory),
        ):
            try:
                test_local_workers_do_not_alias_an_occupied_secondary_port()
            except Exception as error:
                failure = error
        assert captured and all(child.poll() is not None for child in captured), "fixture supervisor was not joined"
        if mode == "takeover":
            assert failure is None, f"primary-port handoff failed: {failure}"
            assert taken == [False, False], "fixture relinquished a primary socket before worker ownership"
        else:
            assert failure is not None and "forced-primary-startup-failure" in str(failure), (
                f"cleanup hid the primary worker failure: {failure}"
            )
            assert retained and all(path.exists() for path in retained), "failed fixture evidence was removed"
            root = retained[-1]
            assert "forced-primary-startup-failure" in (root / "worker.log").read_text()
            assert (root / "worker.1.log").is_file() and (root / "launcher.log").is_file()
            status = json.loads((root / "fixture-cleanup.json").read_text())
            assert status["state"] == "verified" and status["supervisor_joined"] is True
    finally:
        for child in captured:
            if child.poll() is None:
                child.terminate()  # Exact unreaped Popen; supervisor owns worker forwarding.
            child.wait(timeout=5)
        for blocker in blockers:
            blocker.close()


def test_local_worker_fixture_preserves_primary_socket_ownership():
    _worker_port_regression_case("takeover")


def test_local_worker_fixture_retains_primary_failure_and_joins_owner():
    _worker_port_regression_case("primary-failure")


def test_local_worker_fixture_cleanup_faults_preserve_primary_error():
    """Execute the owning finally with no signals and independently failed resources."""
    import inspect
    import types
    from unittest.mock import Mock, patch

    tree = ast.parse(inspect.getsource(test_local_workers_do_not_alias_an_occupied_secondary_port))
    final = next(node.finalbody for node in ast.walk(tree) if isinstance(node, ast.Try) and node.finalbody)
    for disk_failure in (False, True):
        root = Path(
            tempfile.mkdtemp(prefix="worker-cleanup-fault-", dir=WORKER_PATH.parent.parent / ".context/test-runs")
        )
        (root / "identity-0.json").write_text("{invalid")
        primary = RuntimeError("original worker startup error")
        process = Mock(pid=12345)
        process.poll.return_value = 1
        process.wait.return_value = 1
        bad_socket = Mock()
        bad_socket.close.side_effect = OSError("socket close failed")
        good_socket = Mock()
        thread = Mock(ident=None)
        thread.is_alive.return_value = False
        channel_path = Mock()
        channel_path.unlink.side_effect = OSError("socket unlink failed")
        channel_root = Mock()
        namespace = {
            **globals(),
            "root": root,
            "process": process,
            "owner_identity": "fixture",
            "primary_error": primary,
            "identity": {"main": Mock()},
            "live": Mock(return_value=False),
            "sockets": [bad_socket, good_socket],
            "stop_handoff": Mock(),
            "handoff": thread,
            "channel_path": channel_path,
            "channel_root": channel_root,
            "blocker": good_socket,
            "os": types.SimpleNamespace(killpg=Mock(side_effect=OSError("unverified group"))),
        }
        original_write = Path.write_text

        def write(path, *args, **kwargs):
            if disk_failure and path.name == "fixture-cleanup.tmp":
                raise OSError("fixture disk write failed")
            return original_write(path, *args, **kwargs)

        raised = None
        with patch.object(Path, "write_text", write):
            try:
                exec(compile(ast.Module(body=final, type_ignores=[]), "<actual-fixture-finally>", "exec"), namespace)
            except BaseException as error:
                raised = error
        assert raised is None, f"cleanup replaced the original error: {raised}"
        process.wait.assert_called()
        good_socket.close.assert_called_once()
        thread.join.assert_not_called()
        channel_root.rmdir.assert_called_once()
        assert getattr(primary, "__notes__", []), "cleanup failures were not attached to the original error"
        if not disk_failure:
            status = json.loads((root / "fixture-cleanup.json").read_text())
            assert status["state"] == "failed_retained" and status["supervisor_joined"] is True
        else:
            assert "fixture disk write failed" in str(primary.__notes__)


def test_dynamic_worker_metrics_are_discoverable_and_scrapable():
    """Port zero selects a live exporter and updates the port used by self-scrapes."""
    import urllib.request
    import worker

    runtime, port = worker._start_sdk_runtime(0)
    assert runtime is not None
    assert port > 0
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f"http://127.0.0.1:{port}/metrics", timeout=2) as response:
        assert response.status == 200


def test_dynamic_worker_metrics_retry_only_address_collisions():
    """An SDK bind handoff race is retried; fixed ports and other errors fail."""
    from unittest.mock import patch
    import worker

    collision = ValueError("Failed starting Prometheus exporter: Address already in use (os error 48)")
    actual_runtime = worker.Runtime
    blocker = socket.socket()
    attempts = []

    def race_exporter_bind(*, telemetry):
        address = telemetry.metrics.bind_address
        attempts.append(address)
        if len(attempts) == 1:
            blocker.bind(("0.0.0.0", int(address.rsplit(":", 1)[1])))
            blocker.listen()
        return actual_runtime(telemetry=telemetry)

    try:
        with patch.object(worker, "Runtime", side_effect=race_exporter_bind):
            runtime, port = worker._start_sdk_runtime(0)
            assert runtime is not None and port > 0
            assert len(attempts) == 2
            assert attempts[0] != attempts[1]
    finally:
        blocker.close()
    for port, error in [(9090, collision), (0, ValueError("invalid telemetry configuration"))]:
        with patch.object(worker, "Runtime", side_effect=error) as create:
            try:
                worker._start_sdk_runtime(port)
                raise AssertionError("expected startup failure")
            except ValueError as raised:
                assert raised is error
            assert create.call_count == 1
    with patch.object(worker, "Runtime", side_effect=collision) as create:
        try:
            worker._start_sdk_runtime(0)
            raise AssertionError("expected bounded startup failure")
        except ValueError as raised:
            assert raised is collision
        assert create.call_count == 10


def test_dynamic_worker_health_server_reports_the_bound_port():
    """Health port zero binds before returning and remains reachable over loopback."""
    import urllib.request
    from health_server import run_health_server

    thread = run_health_server(0)
    try:
        assert thread.port > 0
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for host in ("127.0.0.1", "[::1]"):
            with opener.open(f"http://{host}:{thread.port}/metrics", timeout=2) as response:
                assert response.status == 200
    finally:
        if hasattr(thread, "server"):
            thread.server.shutdown()
            thread.server.server_close()
            thread.join(timeout=2)


async def test_worker_startup_publishes_bound_ports_before_temporal_connect():
    """Actual startup uses the bound endpoints for metrics and peer-health reads."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    import worker

    class StopBeforeTemporal(Exception):
        pass

    threads = []
    runtimes = []
    start_health = worker.run_health_server
    start_runtime = worker._start_sdk_runtime

    def capture_health(port):
        thread = start_health(port)
        threads.append(thread)
        return thread

    def capture_runtime(port):
        result = start_runtime(port)
        runtimes.append(result)
        return result

    config = SimpleNamespace(
        environment="development",
        health_check_port=0,
        temporal=SimpleNamespace(address="localhost:7233", namespace="test", task_queue="test", api_key=""),
    )
    try:
        with (
            patch.dict(os.environ, {"WORKER_INDEX": "1"}),
            patch.object(worker, "SDK_METRICS_PORT", 0),
            patch.object(worker, "HEALTH_CHECK_PORT", 0),
            patch.object(worker, "load_config", return_value=config),
            patch.object(worker, "run_health_server", side_effect=capture_health),
            patch.object(worker, "_start_sdk_runtime", side_effect=capture_runtime),
            patch.object(worker.Client, "connect", new=AsyncMock(side_effect=StopBeforeTemporal)),
        ):
            try:
                await worker.main()
                raise AssertionError("expected test boundary before Temporal")
            except StopBeforeTemporal:
                pass
            assert worker.SDK_METRICS_PORT == runtimes[0][1] > 0
            assert worker.HEALTH_CHECK_PORT == threads[0].port > 0
            assert worker.SDK_METRICS_PORT != worker.HEALTH_CHECK_PORT
            http = SimpleNamespace(
                get=AsyncMock(return_value=SimpleNamespace(text='temporal_num_pollers{poller_type="activity_task"} 2'))
            )
            metrics = await worker._get_sdk_worker_metrics(http)
            assert metrics["activity_task_pollers"] == 2
            http.get.assert_awaited_once_with(f"http://localhost:{runtimes[0][1]}/metrics", timeout=2.0)
    finally:
        for thread in threads:
            thread.server.shutdown()
            thread.server.server_close()
            thread.join(timeout=2)


async def test_worker_health_bind_failure_stops_before_temporal_connect():
    """A fixed health-port collision must fail startup, leaving its owner intact."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    import worker

    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as blocker:
        blocker.bind(("::", 0))
        blocker.listen()
        port = blocker.getsockname()[1]
        config = SimpleNamespace(environment="development", health_check_port=port)
        connect = AsyncMock()
        with (
            patch.dict(os.environ, {"WORKER_INDEX": "0"}),
            patch.object(worker, "SDK_METRICS_PORT", 0),
            patch.object(worker, "load_config", return_value=config),
            patch.object(worker, "_start_sdk_runtime", return_value=(None, 0)),
            patch.object(worker.Client, "connect", new=connect),
        ):
            try:
                await worker.main()
                raise AssertionError("expected occupied health port to fail startup")
            except SystemExit as error:
                assert error.code == 1
            connect.assert_not_awaited()
            assert blocker.getsockname()[1] == port
            with socket.create_connection(("::1", port), timeout=2):
                pass


def test_worker_shutdown_joins_native_observability_requests():
    """Exercise actual process exit against a parent-owned gRPC fault fixture."""
    import runpy

    tests = runpy.run_path(str(WORKER_PATH.parent / "tests/unit/test_worker_observability_shutdown.py"))
    for phase in ("count", "describe"):
        for outcome in ("success", "resource_exhausted", "deadline"):
            tests["test_worker_entrypoint_joins_inflight_metrics_rpc_before_exit"](outcome, phase)


def test_worker_metrics_failure_preserves_primary_and_finishes_cleanup():
    script = r"""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
import worker

async def scenario(primary):
    original = ValueError("worker startup failed")
    metrics_error = RuntimeError("metrics poller failed")
    joined = asyncio.Event()
    async def metrics(*args):
        await args[-1].wait()
        joined.set()
        raise metrics_error
    class TestWorker:
        def __init__(self, *args, **kwargs):
            self.is_running = not primary
        async def run(self):
            if primary:
                raise original
        async def shutdown(self):
            pass
    profiler, logger = Mock(), Mock()
    with (
        patch.dict(worker.os.environ, {"PROFILE_WORKER": "1", "TEMPORAL_WORKER_REQUIRE_ACTIVATION": "0"}),
        patch("cProfile.Profile", return_value=profiler),
        patch.object(worker, "logger", logger),
        patch.object(worker, "_start_sdk_runtime", return_value=(None, 0)),
        patch.object(worker, "run_health_server", return_value=SimpleNamespace(port=0)),
        patch.object(worker.Client, "connect", AsyncMock(return_value=Mock())),
        patch.object(worker, "set_temporal_client"),
        patch.object(worker, "set_worker_status"),
        patch.object(worker, "Worker", TestWorker),
        patch.object(worker, "poll_queue_metrics", metrics),
        patch.object(worker, "drain_background_browser_cleanups", AsyncMock()),
    ):
        try:
            await worker.main()
        except Exception as error:
            assert error is (original if primary else metrics_error), "metrics replaced primary failure"
        else:
            raise AssertionError("worker failure was suppressed")
    assert joined.is_set(), "metrics task did not join"
    profiler.disable.assert_called_once()
    profiler.dump_stats.assert_called_once()
    assert any(call.args == ("Worker stopped",) for call in logger.info.call_args_list)
    assert any(call.args == ("Metrics poller failed during shutdown",) for call in logger.warning.call_args_list)

for primary in (False, True):
    asyncio.run(scenario(primary))
"""
    result = subprocess.run(
        [sys.executable, "-c", script], cwd=WORKER_PATH.parent, capture_output=True, text=True, timeout=8
    )
    assert result.returncode == 0, result.stderr[-500:]


def test_worker_cancellation_uses_application_heartbeat_cadence():
    """Run the native transport regression through the owning deploy domain."""
    import runpy

    tests = runpy.run_path(str(WORKER_PATH.parent / "tests/unit/test_worker_heartbeat_cancellation.py"))
    with tempfile.TemporaryDirectory() as temporary:
        tests["test_worker_delivers_cancellation_at_application_heartbeat_cadence"](Path(temporary))


async def test_worker_metrics_stop_prevents_later_peer_and_provider_requests():
    """A stop during an owned HTTP call must prevent the rest of its fleet loop."""
    from types import SimpleNamespace
    from unittest.mock import patch
    import worker

    for phase in ("memory", "admission", "list", "start", "stop"):
        stopped = asyncio.Event()
        calls = []

        async def get(url, **kwargs):
            calls.append(("get", url))
            if phase in ("memory", "admission", "list"):
                stopped.set()
            return SimpleNamespace(
                status_code=200,
                text="machine_memory_used_percent 30\nactivity_admission_open 1\n",
                raise_for_status=lambda: None,
                json=lambda: [
                    {"id": f"fixture-{index}", "state": "stopped" if phase == "start" else "started"}
                    for index in range(4)
                ],
            )

        async def post(url, **kwargs):
            calls.append(("post", url))
            stopped.set()
            return SimpleNamespace(status_code=200)

        http = SimpleNamespace(get=get, post=post)
        with (
            patch.dict(
                os.environ,
                {
                    "FLY_APP_NAME": "worker-stop-fixture",
                    "FLY_API_TOKEN": "fixture",
                    "FLY_MACHINE_ID": "fixture-owner",
                    "TEMPORAL_WORKER_SURFACE_HASH": "",
                },
            ),
            patch.object(worker, "_get_peer_ips", return_value=["::1", "::2", "::3", "::4"]),
        ):
            if phase == "memory":
                await worker._get_fleet_memory_used_percent(http, 20, stopped)
            elif phase == "admission":
                await worker._get_fleet_activity_admission_unavailable_count(
                    http,
                    local_activity_admission_open=True,
                    current_machines=4,
                    stop_event=stopped,
                )
            else:
                await worker._scale_fleet(4 if phase == "start" else 0, http, stopped)
        assert [method for method, _ in calls] == (["get", "post"] if phase in ("start", "stop") else ["get"]), (
            f"{phase}: another fleet request began after shutdown"
        )


async def run_all_tests():
    print("worker blackbox tests:")
    r = BlackboxResult()
    r.record("worker_does_not_use_python_custom_activity_slots", test_worker_does_not_use_python_custom_activity_slots)
    r.record(
        "worker_activity_supplier_is_sdk_native_fixed_size", test_worker_activity_supplier_is_sdk_native_fixed_size
    )
    r.record(
        "worker_workflow_supplier_is_fixed_size_not_resource_based",
        test_worker_workflow_supplier_is_fixed_size_not_resource_based,
    )
    r.record("worker_passes_sticky_queue_timeout_to_temporal", test_worker_passes_sticky_queue_timeout_to_temporal)
    r.record("activity_admission_closes_on_cpu_pressure", test_activity_admission_closes_on_cpu_pressure)
    r.record("local_workers_do_not_alias_occupied_ports", test_local_workers_do_not_alias_an_occupied_secondary_port)
    r.record(
        "local_worker_fixture_preserves_primary_socket_ownership",
        test_local_worker_fixture_preserves_primary_socket_ownership,
    )
    r.record(
        "local_worker_fixture_retains_primary_failure",
        test_local_worker_fixture_retains_primary_failure_and_joins_owner,
    )
    r.record("local_worker_fixture_cleanup_faults", test_local_worker_fixture_cleanup_faults_preserve_primary_error)
    r.record(
        "local_worker_single_cancellation_drains_cleanup",
        test_local_worker_supervisor_delivers_one_cancellation_and_waits_for_cleanup,
    )
    r.record("local_worker_bounds_post_kill_reaping", test_local_worker_supervisor_bounds_reaping_after_kill)
    r.record(
        "stack_keeps_backend_alive_for_worker_cleanup",
        test_stack_keeps_backend_available_until_owned_worker_cleanup_finishes,
    )
    r.record(
        "stack_reaps_services_after_failed_worker", test_stack_reaps_other_services_and_preserves_failed_worker_receipt
    )
    r.record(
        "stack_reaps_services_after_receipt_failure", test_stack_reaps_services_when_pending_receipt_cannot_be_written
    )
    r.record("dynamic_worker_metrics_discoverable", test_dynamic_worker_metrics_are_discoverable_and_scrapable)
    r.record("dynamic_worker_metrics_bind_race", test_dynamic_worker_metrics_retry_only_address_collisions)
    r.record("dynamic_worker_health_bound_port", test_dynamic_worker_health_server_reports_the_bound_port)
    r.record(
        "worker_shutdown_joins_native_observability_requests", test_worker_shutdown_joins_native_observability_requests
    )
    r.record(
        "worker_metrics_failure_finishes_cleanup", test_worker_metrics_failure_preserves_primary_and_finishes_cleanup
    )
    r.record(
        "worker_terminal_browser_io_cannot_strand_cleanup",
        test_worker_event_loop_closes_after_terminal_browser_io_times_out,
    )
    r.record(
        "worker_optional_cdp_timeout_preserves_resource_drain",
        test_worker_optional_cdp_timeout_preserves_resource_drain_and_exits,
    )
    r.record("worker_loop_rejects_unrelated_pending_work", test_worker_event_loop_rejects_unrelated_pending_work)
    r.record(
        "worker_loop_preserves_primary_failure", test_worker_event_loop_preserves_primary_failure_during_bad_shutdown
    )
    r.record(
        "worker_loop_stops_browser_event_buses", test_worker_event_loop_stops_browser_event_buses_before_pending_check
    )
    r.record("worker_cancellation_heartbeat_cadence", test_worker_cancellation_uses_application_heartbeat_cadence)
    await r.record_async(
        "worker_metrics_stop_prevents_later_fleet_requests",
        test_worker_metrics_stop_prevents_later_peer_and_provider_requests,
    )
    await r.record_async(
        "worker_startup_bound_ports", test_worker_startup_publishes_bound_ports_before_temporal_connect
    )
    await r.record_async("worker_health_bind_failure", test_worker_health_bind_failure_stops_before_temporal_connect)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
