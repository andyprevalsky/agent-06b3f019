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
                ["bash", str(launcher)], cwd=root,
                env={**os.environ, "PATH": f"{Path(sys.executable).parent}:{os.environ.get('PATH', '')}",
                     "WORKER_PROCESSES": str(count), "NAVI_WORKER_LOG_STREAM": "false",
                     "NAVI_WORKER_LOG_FILE": str(root / "worker.log")},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            try:
                deadline = time.monotonic() + 10
                while not all((root / f"ready-{index}").exists() for index in range(count)):
                    assert process.poll() is None, "worker supervisor exited before readiness"
                    assert time.monotonic() < deadline, "worker fixture did not become ready"
                    time.sleep(.02)
                process.send_signal(signal.SIGTERM)
                time.sleep(.05)
                process.send_signal(signal.SIGTERM)
                assert process.wait(timeout=5) == 0, "repeat cancellation killed a cleanup in progress"
                assert all((root / f"clean-{index}").read_text() == "1" for index in range(count))
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                    process.wait(timeout=10)


def _check_stack_worker_cleanup(worker_exit):
    """Real Bash-owned children must finish a delayed HTTP cleanup before backend exit."""
    import shlex
    repository = WORKER_PATH.parent.parent
    source = (repository / "scripts/run.sh").read_text()
    def function(name):
        start = source.index(name + "() {")
        return source[start:source.index("\n}", start) + 2]
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
        script = "\n".join([
            "set -eo pipefail", f"SCRIPT_DIR={shlex.quote(str(repository / 'scripts'))}",
            'source "$SCRIPT_DIR/lib/run-process-cleanup.sh"',
            function("kill_tree"), function("kill_tree_hard"), function("cleanup"),
            f"{shlex.quote(sys.executable)} backend.py &", "backend_fixture_pid=$!", 'printf "%s" "$backend_fixture_pid" > backend.pid',
            f"{shlex.quote(sys.executable)} worker.py &", "AGENTS_PID=$!",
            "trap 'kill \"$AGENTS_PID\" \"$backend_fixture_pid\" 2>/dev/null || true' EXIT",
            "AGENTS_BIRTH=\"$(ps -p \"$AGENTS_PID\" -o lstart= | sed 's/^ *//;s/ *$//')\"",
            'PIDS=("$backend_fixture_pid" "$AGENTS_PID")', "NAMES=(back-end agents)",
            "SHUTTING_DOWN=false", "BENCHMARK_ISOLATED_RUN=true", "DB_OWNED_BY_US=false",
            "USE_SYSTEM_PG=false", "SYSTEM_DB_OWNED_BY_US=false", "NGROK_CONFIG_FILE=", "FAIL_DIR=",
            "RUN_STACK_CLEANUP_TOKEN=fixture", f"RUN_STACK_CLEANUP_STATUS_FILE={shlex.quote(str(root / 'stack.status'))}",
            "BACKEND_PID=", "write_services_manifest() { :; }",
            'for attempt in {1..100}; do [ ! -f worker.ready ] || [ ! -f backend.port ] || break; sleep .02; done',
            "cleanup_code=0; cleanup || cleanup_code=$?",
            'if kill -0 "$backend_fixture_pid" 2>/dev/null; then echo "owned backend survived before fixture safety trap" >&2; exit 99; fi',
            'exit "$cleanup_code"',
        ])
        process = subprocess.Popen(["bash", "-c", script], cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            stdout, stderr = process.communicate(timeout=12)
            assert process.returncode == (0 if worker_exit == 0 else 1), (stdout, stderr)
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


def test_stack_keeps_backend_available_until_owned_worker_cleanup_finishes():
    _check_stack_worker_cleanup(0)


def test_stack_reaps_other_services_and_preserves_failed_worker_receipt():
    _check_stack_worker_cleanup(7)


def test_local_workers_do_not_alias_an_occupied_secondary_port():
    """A sibling's health listener cannot remove this run's worker capacity."""
    launcher = WORKER_PATH.parent / "scripts" / "run_local_worker.sh"
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / ".env").touch()
        (root / "worker.py").write_text(
            "import json, os, signal, socket\n"
            "sockets = []\n"
            "for key in ('SDK_METRICS_PORT', 'HEALTH_CHECK_PORT'):\n"
            "    sock = socket.socket()\n"
            "    sock.bind(('0.0.0.0', int(os.environ[key])))\n"
            "    sock.listen()\n"
            "    sockets.append(sock)\n"
            "ready = 'ready-' + os.environ['WORKER_INDEX']\n"
            "with open(ready + '.tmp', 'w') as output:\n"
            "    json.dump([sock.getsockname()[1] for sock in sockets], output)\n"
            "os.replace(ready + '.tmp', ready)\n"
            "signal.pause()\n"
        )
        # Reserve a real sibling listener at the launcher's old modulo-derived
        # metrics port. Keep it bound throughout startup; never kill its owner.
        blocker = socket.socket()
        primary = socket.socket()
        primary.bind(("127.0.0.1", 0))
        primary_port = primary.getsockname()[1]
        for _ in range(50):
            old_secondary = primary_port % 1000 + 19001
            try:
                blocker.bind(("0.0.0.0", old_secondary))
                break
            except OSError:
                primary.close()
                primary = socket.socket()
                primary.bind(("127.0.0.1", 0))
                primary_port = primary.getsockname()[1]
        else:
            blocker.close()
            primary.close()
            raise AssertionError("could not reserve an isolated collision fixture")
        blocker.listen()
        health = socket.socket()
        health.bind(("127.0.0.1", 0))
        health_port = health.getsockname()[1]
        primary.close()
        health.close()
        env = {
            **os.environ,
            "PATH": f"{Path(sys.executable).parent}:{os.environ.get('PATH', '')}",
            "WORKER_PROCESSES": "2",
            "SDK_METRICS_PORT": str(primary_port),
            "HEALTH_CHECK_PORT": str(health_port),
            "NAVI_WORKER_LOG_STREAM": "false",
            "NAVI_WORKER_LOG_FILE": str(root / "worker.log"),
        }
        process = subprocess.Popen(
            ["bash", str(launcher)],
            cwd=root,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if (root / "ready-0").exists() and (root / "ready-1").exists():
                    break
                if (root / "worker.1.log").exists() and "Address already in use" in (root / "worker.1.log").read_text():
                    break
                time.sleep(0.02)
            assert (root / "ready-1").exists(), (
                "Secondary worker died on a sibling's occupied port: " + (root / "worker.1.log").read_text()
            )
            ports = [json.loads((root / f"ready-{index}").read_text()) for index in range(2)]
            assert ports[0] == [primary_port, health_port]
            assert len({port for pair in ports for port in pair}) == 4
            assert old_secondary not in ports[1]
            assert blocker.getsockname()[1] == old_secondary
        finally:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
            blocker.close()


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
    r.record("local_worker_single_cancellation_drains_cleanup", test_local_worker_supervisor_delivers_one_cancellation_and_waits_for_cleanup)
    r.record("stack_keeps_backend_alive_for_worker_cleanup", test_stack_keeps_backend_available_until_owned_worker_cleanup_finishes)
    r.record("stack_reaps_services_after_failed_worker", test_stack_reaps_other_services_and_preserves_failed_worker_receipt)
    r.record("dynamic_worker_metrics_discoverable", test_dynamic_worker_metrics_are_discoverable_and_scrapable)
    r.record("dynamic_worker_metrics_bind_race", test_dynamic_worker_metrics_retry_only_address_collisions)
    r.record("dynamic_worker_health_bound_port", test_dynamic_worker_health_server_reports_the_bound_port)
    await r.record_async(
        "worker_startup_bound_ports", test_worker_startup_publishes_bound_ports_before_temporal_connect
    )
    await r.record_async("worker_health_bind_failure", test_worker_health_bind_failure_stops_before_temporal_connect)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
