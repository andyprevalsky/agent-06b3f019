"""Blackbox tests for Temporal worker configuration."""

import ast
import asyncio
import importlib.util
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
        if elapsed >= 0.2:
            import warnings
            warnings.warn(f"optional CDP cleanup timing: {elapsed:.3f}s", RuntimeWarning)
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
    Observed: a $0-LLM demo-cache smoke replay spent ~137s of 153s in
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


async def test_late_activity_body_start_is_logged_with_its_dispatch_lag():
    """2026-11-07 mass-agent recurrence: post_agent_message attempts timed out on
    the server without their body ever issuing a request. The worker must record
    how long after Temporal started an attempt its body actually began."""
    from dataclasses import replace
    from datetime import datetime, timedelta, timezone
    from unittest.mock import patch

    import structlog
    from temporalio import activity
    from temporalio.testing import ActivityEnvironment

    from helpers.activity_dispatch import ActivityDispatchLagInterceptor

    executed = []

    class _Next:
        async def execute_activity(self, input):
            executed.append(input)
            return "ok"

    inbound = ActivityDispatchLagInterceptor().intercept_activity(_Next())
    template = ActivityEnvironment().info

    async def run(lag_seconds):
        info = replace(
            template,
            activity_type="post_agent_message",
            activity_id="50",
            attempt=3,
            workflow_id="4ec67f04",
            start_to_close_timeout=timedelta(seconds=30),
            started_time=datetime.now(timezone.utc) - timedelta(seconds=lag_seconds),
        )
        with patch.object(activity, "info", return_value=info), structlog.testing.capture_logs() as logs:
            assert await inbound.execute_activity("input") == "ok"
        return [entry for entry in logs if entry["event"] == "activity.dispatch_lag"]

    late = await run(40)
    assert len(late) == 1, late
    assert late[0]["activity_type"] == "post_agent_message" and late[0]["attempt"] == 3
    assert late[0]["lag_s"] >= 40 and late[0]["start_to_close_s"] == 30.0
    assert await run(0.5) == [], "ordinary scheduling jitter must not be logged"
    assert executed == ["input", "input"], "the activity body must still run"


def test_worker_registers_activity_dispatch_lag_interceptor():
    """The production Worker(...) installs the dispatch-lag interceptor."""
    tree = _worker_tree()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "Worker":
            kw = next((k for k in node.keywords if k.arg == "interceptors"), None)
            assert kw is not None, "Worker(...) must pass interceptors="
            names = {n.func.id for n in ast.walk(kw.value) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
            assert "ActivityDispatchLagInterceptor" in names, names
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


async def test_loop_lag_attributes_stall_to_cpu_starvation_window():
    """A loop.lag warning must say whether the stall was our work or a starved guest.

    H-60 (epoch-18 Instacart r1/r2): a shared-cpu-4x bench guest exhausted its
    CPU burst and was throttled (guest-diagnostics steal 57-77%), stretching
    1.5-2 s DOM steps into 5-17.5 s loop stalls. loop.lag only carried process
    cpu_pct (23% at the 17.5 s stall), so triage read it as an unknown blocker.
    The warning now reports, for the exact tick window, the process's own CPU
    seconds, the guest's hypervisor-steal share and cgroup throttled seconds.
    """
    import os
    import time as _time
    from collections import namedtuple
    from unittest.mock import patch

    os.environ.setdefault("TEMPORAL_ADDRESS", "localhost:7233")
    os.environ.setdefault("TEMPORAL_TASK_QUEUE", "test")
    import worker

    fields = ("user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal", "guest", "guest_nice")
    SysTimes = namedtuple("scputimes", fields)
    calls = {"n": 0}

    def fake_cpu_times(percpu=False):
        # Every sample advances 1 s user + 3 s steal (+ guest time psutil already
        # folds into user): a 75% hypervisor-steal share of all guest vCPU time.
        n = calls["n"] = calls["n"] + 1
        return SysTimes(float(n), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 3.0 * n, 5.0 * n, 0.0)

    events: list[dict] = []

    class _Recorder:
        def warning(self, **kw):
            events.append(kw)

        def info(self, **kw):
            events.append(kw)

    with patch.object(worker, "logger", _Recorder()), patch("worker.psutil.cpu_times", fake_cpu_times):
        monitor = asyncio.create_task(worker.monitor_event_loop_lag(interval_s=0.05, warn_threshold_s=0.25))
        await asyncio.sleep(0.2)
        _time.sleep(0.6)  # blocks the loop without using CPU, like a descheduled guest
        await asyncio.sleep(0.2)
        monitor.cancel()
        try:
            await monitor
        except asyncio.CancelledError:
            pass

    stalls = [e for e in events if e.get("event") == "loop.lag" and e["lag_s"] >= 0.5]
    assert stalls, f"the 0.6 s stall must emit loop.lag: {events}"
    stall = stalls[0]
    for key in ("window_s", "process_cpu_s", "steal_pct", "cgroup_throttled_s"):
        assert key in stall, f"loop.lag must carry {key} for the stalled window: {stall}"
    assert stall["window_s"] >= stall["lag_s"], stall
    assert stall["process_cpu_s"] < 0.3, f"a sleeping stall used no process CPU: {stall}"
    assert stall["steal_pct"] == 75.0, f"steal share of guest CPU time over the window: {stall}"
    assert stall["cgroup_throttled_s"] is None or stall["cgroup_throttled_s"] >= 0, stall
    # Existing consumers keep their fields.
    for key in ("lag_s", "cpu_pct", "num_cpus", "asyncio_tasks", "worker_index"):
        assert key in stall, stall


def test_cgroup_throttle_stat_prefers_cpu_stat_local_for_ancestor_quotas():
    """cpu.stat.local includes ancestor-imposed throttling; cpu.stat alone reads zero under a parent quota."""
    import os
    import tempfile

    os.environ.setdefault("TEMPORAL_ADDRESS", "localhost:7233")
    os.environ.setdefault("TEMPORAL_TASK_QUEUE", "test")
    import worker

    with tempfile.TemporaryDirectory() as tmp:
        proc = os.path.join(tmp, "cgroup")
        root = os.path.join(tmp, "fs")
        base = os.path.join(root, "a", "b")
        os.makedirs(base)
        with open(proc, "w", encoding="ascii") as fh:
            fh.write("0::/a/b\n")
        assert worker._own_cgroup_cpu_stat_path(proc, root) is None
        with open(os.path.join(base, "cpu.stat"), "w", encoding="ascii") as fh:
            fh.write("usage_usec 10\nthrottled_usec 0\n")
        assert worker._own_cgroup_cpu_stat_path(proc, root) == os.path.join(base, "cpu.stat")
        # Without cpu.stat.local, a limited ancestor makes the child's zero meaningless: unknown.
        with open(os.path.join(root, "a", "cpu.max"), "w", encoding="ascii") as fh:
            fh.write("50000 100000\n")
        assert worker._own_cgroup_cpu_stat_path(proc, root) is None
        with open(os.path.join(root, "a", "cpu.max"), "w", encoding="ascii") as fh:
            fh.write("max 100000\n")
        assert worker._own_cgroup_cpu_stat_path(proc, root) == os.path.join(base, "cpu.stat")
        with open(os.path.join(root, "a", "cpu.max"), "w", encoding="ascii") as fh:
            fh.write("50000 100000\n")
        with open(os.path.join(base, "cpu.stat.local"), "w", encoding="ascii") as fh:
            fh.write("throttled_usec 2500000\n")
        chosen = worker._own_cgroup_cpu_stat_path(proc, root)
        assert chosen == os.path.join(base, "cpu.stat.local")
        assert worker._cgroup_throttled_usec(chosen) == 2500000
        with open(proc, "w", encoding="ascii") as fh:
            fh.write("12:cpu,cpuacct:/a/b\n")
        assert worker._own_cgroup_cpu_stat_path(proc, root) is None


def test_cgroup_throttled_usec_reads_cpu_stat_and_reports_unknown_when_absent():
    """Container quotas show as cgroup v2 throttled_usec, not hypervisor steal."""
    import os
    import tempfile as _tempfile

    os.environ.setdefault("TEMPORAL_ADDRESS", "localhost:7233")
    os.environ.setdefault("TEMPORAL_TASK_QUEUE", "test")
    import worker

    with _tempfile.TemporaryDirectory() as tmp:
        stat = os.path.join(tmp, "cpu.stat")
        with open(stat, "w", encoding="ascii") as fh:
            fh.write("usage_usec 900\nnr_periods 40\nnr_throttled 30\nthrottled_usec 4512000\n")
        assert worker._cgroup_throttled_usec(stat) == 4512000
        with open(stat, "w", encoding="ascii") as fh:
            fh.write("usage_usec 900\nuser_usec 700\nsystem_usec 200\n")  # no cpu.max: no bandwidth stats
        assert worker._cgroup_throttled_usec(stat) is None
        assert worker._cgroup_throttled_usec(os.path.join(tmp, "missing")) is None
    assert worker._cgroup_throttled_usec(None) is None


_FINALIZATION_BLOCKER_CHILD = """
import asyncio, importlib.util, sys, threading
spec = importlib.util.spec_from_file_location("process_exit", {module_path!r})
process_exit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(process_exit)

async def main():
    # Stands in for the Temporal bridge thread pyo3 parks during finalization.
    threading.Thread(target=threading.Event().wait).start()
    sys.stdout.write("Worker stopped\\n")
    {tail}

{entry}
"""


def _run_finalization_blocker(*, entry: str, tail: str = "pass", timeout_s: float) -> tuple[int | None, str]:
    module_path = str(WORKER_PATH.parent / "helpers" / "process_exit.py")
    child = _FINALIZATION_BLOCKER_CHILD.format(module_path=module_path, entry=entry, tail=tail)
    proc = subprocess.Popen([sys.executable, "-c", child], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        out, _ = proc.communicate(timeout=timeout_s)
        return proc.returncode, out.decode()
    except subprocess.TimeoutExpired:
        proc.kill()
        out, _ = proc.communicate()
        return None, out.decode()


def test_run_then_exit_survives_a_finalization_deadlock():
    """A thread that never finishes hangs plain asyncio.run exit; run_then_exit must not."""
    control_code, _ = _run_finalization_blocker(entry="asyncio.run(main())", timeout_s=3)
    assert control_code is None, "control must hang, or this test no longer models the deadlock"

    started = time.monotonic()
    code, out = _run_finalization_blocker(entry="process_exit.run_then_exit(main)", timeout_s=15)
    assert code == 0, f"run_then_exit must exit cleanly despite the blocked thread, got {code}: {out}"
    assert time.monotonic() - started < 10
    assert "Worker stopped" in out, f"buffered stdout must be flushed before os._exit: {out!r}"

    code, out = _run_finalization_blocker(
        entry="process_exit.run_then_exit(main)", tail="raise SystemExit(3)", timeout_s=15
    )
    assert code == 3, f"SystemExit status must be preserved, got {code}: {out}"
    code, out = _run_finalization_blocker(
        entry="process_exit.run_then_exit(main)", tail="raise RuntimeError('boom')", timeout_s=15
    )
    assert code == 1 and "RuntimeError: boom" in out, f"crash must exit 1 with traceback: {code} {out}"


def test_exit_code_for_matches_cpython_system_exit():
    spec = importlib.util.spec_from_file_location("process_exit", WORKER_PATH.parent / "helpers" / "process_exit.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.exit_code_for(None) == 0
    assert module.exit_code_for(4) == 4
    assert module.exit_code_for(True) == 1
    assert module.exit_code_for("fatal: missing BACKEND_API_KEY") == 1


def test_worker_entrypoint_skips_interpreter_finalization():
    """worker.py must exit through run_then_exit so the Temporal bridge cannot orphan it."""
    tree = _worker_tree()
    main_guards = [
        node
        for node in tree.body
        if isinstance(node, ast.If)
        and isinstance(node.test, ast.Compare)
        and isinstance(node.test.left, ast.Name)
        and node.test.left.id == "__name__"
    ]
    assert len(main_guards) == 1
    body = main_guards[0].body
    assert len(body) == 1 and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Call)
    call = body[0].value
    assert isinstance(call.func, ast.Name) and call.func.id == "run_then_exit"
    assert [arg.id for arg in call.args if isinstance(arg, ast.Name)] == ["main"]


def test_worker_event_loop_shutdown_does_not_wait_forever_on_executor_threads():
    """T112 (local antibot run, 17 Tilion sessions): the worker logged 'Worker stopped' at 23:27:22
    and then stayed alive 6.5 min. Recording archives run through asyncio.to_thread (the loop's
    default executor) as blocking ~55 s POSTs to /api/archive/artifacts, and loop.shutdown_default_
    executor() joins every running and queued job with no deadline, so the stack's drain waited on
    uploads for a stack that was being thrown away. The loop closes within its bound (queued jobs are
    dropped, running ones are left to the process exit) and the process exits."""
    script = r"""
import asyncio, os, time
from helpers import worker_event_loop
from helpers.worker_event_loop import run_worker_event_loop

worker_event_loop._EXECUTOR_SHUTDOWN_SECONDS = 1.0

async def main():
    # Running jobs (one per default-executor thread) and a queued backlog, all slow and blocking.
    jobs = [asyncio.create_task(asyncio.to_thread(time.sleep, 30)) for _ in range(40)]
    await asyncio.sleep(0.3)
    print("worker-stopped", flush=True)

started = time.monotonic()
run_worker_event_loop(main())
elapsed = time.monotonic() - started
print(f"loop-closed {elapsed:.1f}", flush=True)
os._exit(0)
"""
    started = time.monotonic()
    local_env = {key: value for key, value in os.environ.items() if key not in ("FLY_APP_NAME", "ENVIRONMENT")}
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=WORKER_PATH.parent,
        env=local_env,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr[-500:]
    assert "worker-stopped\nloop-closed" in result.stdout, result.stdout
    elapsed = float(result.stdout.split("loop-closed")[1].split()[0])
    assert elapsed < 8, f"loop shutdown took {elapsed:.1f}s with blocked executor threads"
    assert time.monotonic() - started < 15
    # Production keeps the unbounded join (Fly's kill_timeout caps it): same input, no bound.
    from unittest.mock import patch

    from helpers import worker_event_loop

    with patch.dict(os.environ, {"ENVIRONMENT": "production"}):
        assert worker_event_loop._executor_shutdown_seconds() is None
    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("FLY_APP_NAME", None)
        os.environ.pop("ENVIRONMENT", None)
        assert worker_event_loop._executor_shutdown_seconds() == worker_event_loop._EXECUTOR_SHUTDOWN_SECONDS


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
            " with urllib.request.urlopen('http://127.0.0.1:'+Path('backend.port').read_text(),timeout=10) as response:\n"
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
                function("descendant_pids"),
                function("kill_tree_hard"),
                function("remove_isolated_frontend_build"),
                function("stop_stack_owner_watch"),
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
            deadline = time.monotonic() + 10
            while live(child["pid"], child["native"]) and time.monotonic() < deadline:
                time.sleep(0.02)
            assert not live(child["pid"], child["native"]), "captured child survived containment"

    for path in root.glob("identity-*.json"):
        attempt(path.name, lambda path=path: check_child(path))
    stop_handoff.set()
    for sock in sockets:
        attempt("socket close", sock.close)
    if handoff is not None and handoff.ident is not None:
        attempt("handoff join", lambda: handoff.join(timeout=10))
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
                        connection.settimeout(10)
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
            "        channel.settimeout(10)\n"
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
    with opener.open(f"http://127.0.0.1:{port}/metrics", timeout=10) as response:
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
            with opener.open(f"http://{host}:{thread.port}/metrics", timeout=10) as response:
                assert response.status == 200
    finally:
        if hasattr(thread, "server"):
            thread.server.shutdown()
            thread.server.server_close()
            thread.join(timeout=10)


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
            thread.join(timeout=10)


async def test_worker_health_bind_failure_stops_before_temporal_connect():
    """A fixed health-port collision must fail startup, leaving its owner intact."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    import worker

    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as blocker:
        blocker.bind(("::", 0))
        blocker.listen()
        port = blocker.getsockname()[1]
        config = SimpleNamespace(
            environment="development",
            health_check_port=port,
            temporal=SimpleNamespace(namespace="blackbox", task_queue="navi-agent-tasks-blackbox"),
        )
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
            with socket.create_connection(("::1", port), timeout=10):
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
        patch.dict(
            worker.os.environ,
            {"PROFILE_WORKER": "1", "TEMPORAL_WORKER_REQUIRE_ACTIVATION": "0", "TEMPORAL_NAMESPACE": "blackbox"},
        ),
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

    for phase in ("fleet", "leadership", "list", "start", "stop"):
        stopped = asyncio.Event()
        calls = []

        async def get(url, **kwargs):
            calls.append(("get", url))
            if phase in ("fleet", "leadership", "list"):
                stopped.set()
            return SimpleNamespace(
                status_code=200,
                text="machine_memory_used_percent 30\nactivity_admission_open 1\nactivity_slots_used 0\n",
                raise_for_status=lambda: None,
                json=lambda: [
                    {
                        "id": f"fixture-{index}",
                        "state": "stopped" if phase == "start" else "started",
                        "private_ip": f"fdaa::{index + 1}",
                    }
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
                    "FLY_PRIVATE_IP": "::5",
                },
            ),
            patch.object(worker, "_get_peer_ips", return_value=["::1", "::2", "::3", "::4"]),
        ):
            if phase == "fleet":
                await worker._scrape_fleet_peer_views(http, ["::1", "::2", "::3", "::4"], stopped)
            elif phase == "leadership":
                await worker._resolve_autoscaler_role(http, stopped)
            else:
                await worker._scale_fleet(4 if phase == "start" else 0, http, stopped)
        expected = ["get"] * 5 + ["post"] if phase == "stop" else (["get", "post"] if phase == "start" else ["get"])
        assert [method for method, _ in calls] == expected, f"{phase}: another fleet request began after shutdown"


def _queue_metrics_fixture(
    worker,
    *,
    rate_limited_counts: int,
    workflow_count: int = 0,
    backlog: int = 0,
    describe_rate_limited: int = 0,
    patch_publication: bool = True,
):
    """Patch everything except the Temporal visibility calls under test."""
    from contextlib import ExitStack
    from types import SimpleNamespace
    from unittest.mock import patch

    from temporalio.service import RPCError, RPCStatusCode

    calls = []
    scaled = []

    async def count_workflow_executions(request, **kwargs):
        calls.append("count")
        if calls.count("count") <= rate_limited_counts:
            raise RPCError("namespace rate limit exceeded", RPCStatusCode.RESOURCE_EXHAUSTED, b"")
        return SimpleNamespace(count=workflow_count)

    async def describe_task_queue(request, **kwargs):
        calls.append("describe")
        if calls.count("describe") <= describe_rate_limited:
            raise RPCError("namespace rate limit exceeded", RPCStatusCode.RESOURCE_EXHAUSTED, b"")
        if not backlog:
            return SimpleNamespace(task_queue_status=None)
        return SimpleNamespace(task_queue_status=SimpleNamespace(backlog_count_hint=backlog))

    async def sdk_metrics(http):
        return {}

    async def scale_fleet(desired, http, stop_event=None):
        scaled.append(desired)

    client = SimpleNamespace(
        workflow_service=SimpleNamespace(
            count_workflow_executions=count_workflow_executions,
            describe_task_queue=describe_task_queue,
        )
    )
    stack = ExitStack()
    patches = [
        ("_get_sdk_worker_metrics", sdk_metrics),
        ("_get_machine_memory_used_percent", lambda: 10.0),
        ("_scale_fleet", scale_fleet),
    ]
    if patch_publication:
        for name in ("set_queue_observation", "set_local_autoscaler_metrics", "set_autoscaler_role"):
            patches.append((name, lambda *args, **kwargs: None))
    try:
        for name, value in patches:
            stack.enter_context(patch.object(worker, name, value))
        # Deterministic full jitter: always take the upper edge of each window.
        stack.enter_context(
            patch.object(worker, "_AUTOSCALER_RANDOM", SimpleNamespace(uniform=lambda low, high: high), create=True)
        )
    except BaseException:
        stack.close()  # never leak a partial patch set into later tests
        raise
    admission = SimpleNamespace(
        snapshot=lambda: {
            "activity_admission_open": True,
            "activity_admission_memory_percent": 10.0,
            "activity_admission_close_memory_percent": 80.0,
            "activity_admission_open_memory_percent": 75.0,
        }
    )
    return SimpleNamespace(client=client, admission=admission, calls=calls, scaled=scaled, stack=stack)


def _peer_view(*, surface="gen-a", eligible=True, age=0.5, queue=None, memory=30.0, admission=True, slots=0):
    """One peer's /autoscaler/peer answer."""
    return {
        "surface_hash": surface,
        "leader_eligible": eligible,
        "heartbeat_age_seconds": age,
        "role": "leader",
        "machine_memory_used_percent": memory,
        "activity_admission_open": admission,
        "activity_slots_used": slots,
        "queue": queue,
    }


def _peer_transport(views, requests):
    """Serve each peer's view over the 6PN; a None view is an unreachable peer."""
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.url.host, request.url.path))
        view = views.get(request.url.host)
        if view is None:
            raise httpx.ConnectError("peer unreachable", request=request)
        if view == "legacy" or request.url.path != "/autoscaler/peer":
            return httpx.Response(404)
        return httpx.Response(200, json=view)

    return httpx.MockTransport(handler)


def _fleet_fixture(worker, *, me, peers, views, surface="gen-a"):
    """Simulate this worker on a Fly app: DNS peers plus their autoscaler views."""
    from contextlib import ExitStack
    from unittest.mock import patch

    import httpx

    requests = []
    real_client = httpx.AsyncClient
    transport = _peer_transport(views, requests)
    stack = ExitStack()
    try:
        stack.enter_context(patch.object(worker, "_get_peer_ips", lambda app: list(peers)))
        stack.enter_context(
            patch.object(worker.httpx, "AsyncClient", lambda **kwargs: real_client(transport=transport, **kwargs))
        )
        stack.enter_context(
            patch_env(FLY_APP_NAME="fixture-app", FLY_PRIVATE_IP=me, TEMPORAL_WORKER_SURFACE_HASH=surface)
        )
    except BaseException:
        stack.close()
        raise
    return requests, stack


async def _run_queue_metrics_until_waits(worker, client, admission, wait_count: int) -> list[float]:
    """Drive poll_queue_metrics, recording each requested wait without sleeping."""
    from unittest.mock import patch

    stop = asyncio.Event()
    waits: list[float] = []
    original_wait_for = asyncio.wait_for

    async def recording_wait_for(awaitable, timeout=None):
        if getattr(awaitable, "cr_code", None) is not stop.wait.__func__.__code__:
            return await original_wait_for(awaitable, timeout)
        awaitable.close()
        waits.append(timeout)
        if len(waits) >= wait_count:
            stop.set()
        raise asyncio.TimeoutError

    with patch.object(worker.asyncio, "wait_for", recording_wait_for):
        await original_wait_for(
            worker.poll_queue_metrics(client, "fixture-ns", "fixture-queue", admission, 10, stop),
            timeout=10,
        )
    return waits


async def test_autoscaler_backs_off_on_namespace_rate_limit_and_recovers():
    """ResourceExhausted must back off exponentially, then return to the base cadence.

    run600c: 600 guests plus 25 prod workers retried CountWorkflowExecutions every
    second against the shared Visibility API budget; ~90% of cycles were rejected
    for 35 minutes because each rejection was retried at full cadence.
    """
    import worker

    fx = _queue_metrics_fixture(worker, rate_limited_counts=4)
    with fx.stack, patch_env(AUTOSCALER_POLL_INTERVAL_SECONDS=None, AUTOSCALER_QUEUE_METRICS=None, FLY_APP_NAME=None):
        waits = await _run_queue_metrics_until_waits(worker, fx.client, fx.admission, 6)
    assert waits == [2.0, 4.0, 8.0, 16.0, 1.0, 1.0], waits
    # A rejected count ends the cycle; it must not also spend two describe calls.
    calls = fx.calls
    assert calls == ["count"] * 5 + ["describe", "describe", "count", "describe", "describe"], calls
    assert all(delay <= worker.AUTOSCALER_RATE_LIMIT_BACKOFF_MAX_SECS for delay in waits)


async def test_autoscaler_queue_observation_honors_budgeted_cadence_and_opt_out():
    """Benchmark guests poll at the controller budget; unread clones never poll."""
    import worker

    fx = _queue_metrics_fixture(worker, rate_limited_counts=0)
    with fx.stack, patch_env(AUTOSCALER_POLL_INTERVAL_SECONDS="90", AUTOSCALER_QUEUE_METRICS=None, FLY_APP_NAME=None):
        waits = await _run_queue_metrics_until_waits(worker, fx.client, fx.admission, 3)
    # One random start phase within the interval, then the budgeted interval.
    assert waits == [90.0, 90.0, 90.0], waits
    assert fx.calls.count("count") == 2, fx.calls

    for invalid in ("0", "-5", "abc", "inf", "nan"):
        with patch_env(AUTOSCALER_POLL_INTERVAL_SECONDS=invalid):
            assert worker._autoscaler_poll_interval_seconds() == 1.0, invalid
    with patch_env(AUTOSCALER_POLL_INTERVAL_SECONDS=None):
        assert worker._autoscaler_poll_interval_seconds() == 1.0

    fx = _queue_metrics_fixture(worker, rate_limited_counts=0)
    client, admission, calls = fx.client, fx.admission, fx.calls
    stop = asyncio.Event()
    with fx.stack, patch_env(AUTOSCALER_QUEUE_METRICS="0"):
        task = asyncio.create_task(
            worker.poll_queue_metrics(client, "fixture-ns", "fixture-queue", admission, 10, stop)
        )
        await asyncio.sleep(0.05)
        assert not task.done(), "an opted-out worker must still own its metrics task until shutdown"
        stop.set()
        await asyncio.wait_for(task, timeout=2)
    assert calls == [], f"an opted-out worker spent namespace visibility calls: {calls}"


async def test_autoscaler_followers_spend_no_visibility_calls_and_mirror_the_leader():
    """Only the leader's desired count drives scaling, so only the leader observes Temporal.

    Every prod worker spent CountWorkflowExecutions + 2 DescribeTaskQueue per
    second on the namespace's shared Visibility API budget (~75 calls/s at 25
    machines, ~120/s at 40). A follower publishes its own readings and mirrors
    the leader's observation instead.
    """
    import health_server
    import worker

    leader_queue = {
        "backlog": 7,
        "workflow_count": 11,
        "desired_machines": 9,
        "current_machines": 3,
        "age_seconds": 0.5,
        "source": "self",
    }
    views = {"fdaa::1": _peer_view(queue=leader_queue), "fdaa::3": _peer_view()}
    fx = _queue_metrics_fixture(worker, rate_limited_counts=0, patch_publication=False)
    requests, fleet = _fleet_fixture(worker, me="fdaa::2", peers=["fdaa::3", "fdaa::1", "fdaa::2"], views=views)
    with fx.stack, fleet, patch_env(AUTOSCALER_POLL_INTERVAL_SECONDS=None, AUTOSCALER_QUEUE_METRICS=None):
        waits = await _run_queue_metrics_until_waits(worker, fx.client, fx.admission, 3)
    snapshot = health_server.get_queue_metrics_snapshot()
    view = health_server.autoscaler_peer_view()
    assert fx.calls == [], f"a follower spent namespace visibility calls: {fx.calls}"
    assert fx.scaled == [], fx.scaled
    assert waits == [1.0, 1.0, 1.0], waits
    assert snapshot["autoscaler_role"] == "follower" and snapshot["autoscaler_is_leader"] is False, snapshot
    assert snapshot["task_queue_backlog"] == 7 and snapshot["running_workflow_count"] == 11, snapshot
    assert snapshot["task_queue_metrics_source"] == "leader" and snapshot["desired_machine_count"] == 9, snapshot
    # The follower's own readings stay published for the leader's fleet view.
    assert view["machine_memory_used_percent"] == 10.0 and view["activity_admission_open"] is True, view
    # A stopped observer must never remain the peer others defer to.
    assert view["leader_eligible"] is False, view
    # Only lower peers decide leadership; the higher peer is the leader's to scrape.
    assert {host for host, _ in requests} == {"fdaa::1"}, requests

    # Compute-only workers (benchmark guests) keep observing: their consumer is
    # an external controller reading that exact machine's desired count.
    fx = _queue_metrics_fixture(worker, rate_limited_counts=0, patch_publication=False)
    requests, fleet = _fleet_fixture(worker, me="fdaa::2", peers=["fdaa::1", "fdaa::2"], views=views)
    from unittest.mock import patch

    with (
        fx.stack,
        fleet,
        patch.object(worker, "AUTOSCALER_ACTUATE", False),
        patch_env(AUTOSCALER_POLL_INTERVAL_SECONDS=None, AUTOSCALER_QUEUE_METRICS=None),
    ):
        await _run_queue_metrics_until_waits(worker, fx.client, fx.admission, 2)
    assert fx.calls == ["count", "describe", "describe"] * 2, fx.calls
    assert fx.scaled == [], fx.scaled
    health_server.set_queue_metrics(0, 0, 2, 1)


async def test_autoscaler_leader_observes_and_counts_only_its_own_generation():
    """The leader observes every cycle and aggregates only its generation's peers."""
    import health_server
    import worker

    views = {
        "fdaa::2": _peer_view(memory=91.0),
        "fdaa::3": _peer_view(surface="gen-old", memory=99.0, admission=False),
        "fdaa::4": None,
    }
    fx = _queue_metrics_fixture(worker, rate_limited_counts=0, workflow_count=5, patch_publication=False)
    requests, fleet = _fleet_fixture(
        worker, me="fdaa::1", peers=["fdaa::1", "fdaa::2", "fdaa::3", "fdaa::4"], views=views
    )
    with fx.stack, fleet, patch_env(AUTOSCALER_POLL_INTERVAL_SECONDS=None, AUTOSCALER_QUEUE_METRICS=None):
        waits = await _run_queue_metrics_until_waits(worker, fx.client, fx.admission, 2)
    snapshot = health_server.get_queue_metrics_snapshot()
    assert fx.calls == ["count", "describe", "describe"] * 2, fx.calls
    assert waits == [1.0, 1.0], waits
    assert snapshot["autoscaler_role"] == "leader" and snapshot["autoscaler_is_leader"] is True, snapshot
    assert snapshot["task_queue_backlog"] == 0 and snapshot["task_queue_metrics_source"] == "self", snapshot
    # Self + same-generation + unverified peers; the draining old generation is not this fleet.
    assert snapshot["current_machine_count"] == 3, snapshot
    # Same-generation peer pressure counts; another generation's does not.
    assert snapshot["autoscaler_memory_signal_percent"] == 91.0, snapshot
    assert fx.scaled == [], f"memory pressure with running workflows must hold, not scale: {fx.scaled}"
    assert {host for host, _ in requests} == {"fdaa::2", "fdaa::3", "fdaa::4"}, requests
    health_server.set_queue_metrics(0, 0, 2, 1)


async def test_autoscaler_unknown_leadership_observes_at_reduced_cadence_without_actuating():
    """Unverifiable leadership must keep a budgeted observer, never zero and never two actuators.

    An unreachable lower peer may be a live leader behind a GIL-starved health
    thread, so this worker must not actuate; but it may also be dead, so it must
    still observe at a reduced cadence.
    """
    import health_server
    import worker

    from unittest.mock import patch

    fx = _queue_metrics_fixture(worker, rate_limited_counts=0, workflow_count=40, backlog=500, patch_publication=False)
    _, fleet = _fleet_fixture(worker, me="fdaa::5", peers=["fdaa::2", "fdaa::5"], views={"fdaa::2": None})
    with (
        fx.stack,
        fleet,
        patch.object(worker, "_last_scale_up_time", 0.0),
        patch_env(AUTOSCALER_POLL_INTERVAL_SECONDS=None, AUTOSCALER_QUEUE_METRICS=None),
    ):
        waits = await _run_queue_metrics_until_waits(worker, fx.client, fx.admission, 2)
    snapshot = health_server.get_queue_metrics_snapshot()
    assert fx.calls == ["count", "describe", "describe"] * 2, fx.calls
    assert waits == [2 * worker.AUTOSCALER_UNKNOWN_LEADER_POLL_SECS] * 2, waits
    assert fx.scaled == [], f"an unverified leader actuated the fleet: {fx.scaled}"
    # 500 per describe (activity + workflow); the scale-up is computed and published, not applied.
    assert snapshot["autoscaler_role"] == "unknown" and snapshot["task_queue_backlog"] == 1000, snapshot
    assert snapshot["desired_machine_count"] == worker.MAX_MACHINES, snapshot
    health_server.set_queue_metrics(0, 0, 2, 1)


async def test_autoscaler_leadership_never_leaves_a_generation_without_an_observer():
    """Exhaustively: every live generation keeps >=1 observer and at most one leader."""
    import itertools

    import httpx
    import worker
    from unittest.mock import patch

    ips = ["fdaa::1", "fdaa::2", "fdaa::3", "fdaa::4"]
    for generations in (("a", "a", "a", "a"), ("b", "a", "b", "a"), ("a", "b", "b", "a")):
        for dead in itertools.product([False, True], repeat=len(ips)):
            views = {
                ip: _peer_view(surface=gen) for ip, gen, gone in zip(ips, generations, dead, strict=True) if not gone
            }
            roles: dict[str, list[str]] = {}
            for ip, gen in zip(ips, generations, strict=True):
                if ip not in views:
                    continue
                with (
                    patch.object(worker, "_get_peer_ips", lambda app: list(ips)),
                    patch_env(FLY_APP_NAME="fixture-app", FLY_PRIVATE_IP=ip, TEMPORAL_WORKER_SURFACE_HASH=gen),
                ):
                    async with httpx.AsyncClient(transport=_peer_transport(views, [])) as http:
                        role = await worker._resolve_autoscaler_role(http, asyncio.Event())
                roles.setdefault(gen, []).append(role.role)
            for gen, members in roles.items():
                case = f"generations={generations} dead={dead} gen={gen} roles={members}"
                assert any(role in ("leader", "unknown") for role in members), f"zero observers: {case}"
                assert members.count("leader") <= 1, f"two actuators: {case}"
                if not any(dead):
                    assert members.count("leader") == 1 and "unknown" not in members, case

    async def role_for(me, peers, views, **env):
        with (
            patch.object(worker, "_get_peer_ips", lambda app: list(peers)),
            patch_env(
                FLY_APP_NAME=env.get("app", "fixture-app"),
                FLY_PRIVATE_IP=me,
                TEMPORAL_WORKER_SURFACE_HASH=env.get("surface", "gen-a"),
            ),
        ):
            async with httpx.AsyncClient(transport=_peer_transport(views, [])) as http:
                return await worker._resolve_autoscaler_role(http, asyncio.Event())

    # A lower peer whose loop stopped publishing is not provably dead: never actuate over it.
    stale = await role_for("fdaa::2", ["fdaa::1", "fdaa::2"], {"fdaa::1": _peer_view(age=600.0)})
    assert stale.role == "unknown", stale
    # Standby, opted-out and compute-only peers are not candidates.
    standby = await role_for("fdaa::2", ["fdaa::1", "fdaa::2"], {"fdaa::1": _peer_view(eligible=False)})
    assert standby.role == "leader", standby
    # Pre-upgrade peers expose no view: unverified, not absent.
    legacy = await role_for("fdaa::2", ["fdaa::1", "fdaa::2"], {"fdaa::1": "legacy"})
    assert legacy.role == "unknown", legacy
    # DNS failure used to make every worker a leader at once (split-brain actuation).
    assert (await role_for("fdaa::2", [], {})).role == "unknown"
    assert (await role_for("", ["fdaa::1"], {})).role == "unknown"
    # Off Fly (local dev, isolated benchmark guests) the worker is the only observer.
    assert (await role_for("fdaa::2", ["fdaa::1"], {}, app="")).role == "leader"
    # A non-canonical private IP still orders and matches its canonical DNS record.
    upper = await role_for("FDAA:0:0:0:0:0:0:1", ["fdaa::1", "fdaa::2"], {"fdaa::2": _peer_view()})
    assert upper.role == "leader", upper


async def test_autoscaler_publishes_fresh_local_readings_while_temporal_is_throttled():
    """Memory/admission readings must not freeze behind failing Temporal calls.

    They used to be published only after all three visibility calls succeeded,
    so under namespace throttling every worker's readings froze and the leader
    scaled (and chose stop candidates) on stale peer data.
    """
    import itertools
    from unittest.mock import patch

    import health_server
    import worker

    fx = _queue_metrics_fixture(worker, rate_limited_counts=10**6, patch_publication=False)
    readings = itertools.count(1)
    stop = asyncio.Event()
    with (
        fx.stack,
        patch.object(worker, "_get_machine_memory_used_percent", lambda: float(next(readings))),
        patch.object(worker, "LOCAL_TELEMETRY_INTERVAL_SECS", 0.01),
        patch_env(AUTOSCALER_POLL_INTERVAL_SECONDS="0.05", AUTOSCALER_QUEUE_METRICS=None, FLY_APP_NAME=None),
    ):
        health_server.set_queue_metrics(0, 0, 2, 1)
        task = asyncio.create_task(
            worker.poll_queue_metrics(fx.client, "fixture-ns", "fixture-queue", fx.admission, 10, stop)
        )
        await asyncio.sleep(0.4)
        published = health_server.autoscaler_peer_view()
        text = health_server.app.test_client().get("/metrics").get_data(as_text=True)
        stop.set()
        await asyncio.wait_for(task, timeout=5)
    assert fx.calls and set(fx.calls) == {"count"}, fx.calls
    assert published["machine_memory_used_percent"] >= 5, published
    assert published["heartbeat_age_seconds"] < 1, published
    # Never observed successfully: unknown, not an idle queue.
    assert "task_queue_backlog NaN" in text and "task_queue_metrics_present 0" in text, text
    health_server.set_queue_metrics(0, 0, 2, 1)


async def test_autoscaler_missing_backlog_is_unknown_and_never_drives_scale_down():
    """A rejected DescribeTaskQueue used to count as backlog 0 and could start a scale-down."""
    import time
    from unittest.mock import patch

    import health_server
    import worker

    views = {"fdaa::2": _peer_view(memory=20.0), "fdaa::3": _peer_view(memory=20.0)}
    fx = _queue_metrics_fixture(
        worker, rate_limited_counts=0, workflow_count=5, describe_rate_limited=10**6, patch_publication=False
    )
    _, fleet = _fleet_fixture(worker, me="fdaa::1", peers=["fdaa::1", "fdaa::2", "fdaa::3"], views=views)
    with (
        fx.stack,
        fleet,
        patch.object(worker, "MIN_MACHINES", 1),
        # As if the queue had looked idle for an hour before throttling began.
        patch.object(worker, "_backlog_zero_since", time.monotonic() - 3600),
        patch_env(AUTOSCALER_POLL_INTERVAL_SECONDS=None, AUTOSCALER_QUEUE_METRICS=None),
    ):
        waits = await _run_queue_metrics_until_waits(worker, fx.client, fx.admission, 2)
        zero_since = worker._backlog_zero_since
    snapshot = health_server.get_queue_metrics_snapshot()
    # A rejected describe ends the cycle instead of spending the second one.
    assert fx.calls == ["count", "describe"] * 2, fx.calls
    assert waits == [2.0, 4.0], waits
    assert fx.scaled == [], f"an unobserved backlog drove scaling: {fx.scaled}"
    assert zero_since is None, "an unknown backlog must not extend the zero-backlog window"
    assert "task_queue_backlog" not in snapshot and snapshot["autoscaler_role"] == "leader", snapshot
    health_server.set_queue_metrics(0, 0, 2, 1)


def patch_env(**values):
    """patch.dict for os.environ where None removes the variable."""
    from contextlib import contextmanager

    @contextmanager
    def manager():
        saved = {key: os.environ.get(key) for key in values}
        try:
            for key, value in values.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
            yield
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    return manager()


async def test_autoscaler_scale_down_never_stops_machines_with_in_flight_activities():
    """Scale-down must only stop idle peers.

    Fly `machines stop` SIGTERMs the worker; anything still running after the 5m
    shutdown grace is os._exit'd and surfaces as an activity heartbeat timeout
    (agent 3efa7cae: a 30m browser activity died ~10m after a cutover while the
    new generation scaled down). Busy and unscrapeable peers must be kept.
    """
    import os
    from unittest.mock import patch

    import httpx

    os.environ.setdefault("TEMPORAL_ADDRESS", "localhost:7233")
    os.environ.setdefault("TEMPORAL_TASK_QUEUE", "test")
    import worker

    machines = [
        {"id": "leader", "state": "started", "private_ip": "fdaa::1", "config": {"env": {}}},
        {"id": "busy-browser", "state": "started", "private_ip": "fdaa::2", "config": {"env": {}}},
        {"id": "unknown", "state": "started", "private_ip": "fdaa::3", "config": {"env": {}}},
        {"id": "idle", "state": "started", "private_ip": "fdaa::4", "config": {"env": {}}},
        {"id": "nan-slots", "state": "started", "private_ip": "fdaa::5", "config": {"env": {}}},
    ]
    slots_by_ip = {"fdaa::2": "1", "fdaa::4": "0", "fdaa::5": "NaN"}
    stopped: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.machines.dev":
            if request.method == "GET":
                return httpx.Response(200, json=machines)
            if request.url.path.endswith("/stop"):
                stopped.append(request.url.path.split("/")[-2])
                return httpx.Response(200, json={"ok": True})
        slots = slots_by_ip.get(request.url.host)
        if slots is None:
            raise httpx.ConnectError("peer unreachable", request=request)
        return httpx.Response(200, text=f"machine_memory_used_percent 40\nactivity_slots_used {slots}\n")

    env = {"FLY_APP_NAME": "app", "FLY_API_TOKEN": "tok", "FLY_MACHINE_ID": "leader"}
    with patch.dict(os.environ, env):
        os.environ.pop("TEMPORAL_WORKER_SURFACE_HASH", None)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            await worker._scale_fleet(desired=2, http=http)

    assert stopped == ["idle"], f"scale-down stopped {stopped}; only the idle peer may be stopped"


async def test_autoscaler_retained_generation_cannot_start_by_matching_rollback_hash():
    """Only actual active pool custody may participate after a surface returns."""
    import copy
    from unittest.mock import patch
    import httpx
    import worker

    def row(mid, state="stopped"):
        return {
            "id": mid,
            "state": state,
            "private_ip": "fdaa::1",
            "config": {
                "env": {
                    "TEMPORAL_WORKER_SURFACE_HASH": "A",
                    "TEMPORAL_WORKER_BUILD_ID": "build",
                    "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": "attempt",
                },
                "metadata": {},
            },
        }

    def marker(mid):
        return dict(version=1, phase="active", app="app", id=mid, hash="A", build="build", token="attempt")

    for phase in ("start", "stop"):
        machines = [row("leader", "started")]
        for mode in (
            "idle",
            "malformed",
            "foreign",
            "stale",
            "protected",
            "valid",
            "rolling",
            "wrong-intent",
            "legacy",
        ):
            value = row(mode, "stopped" if phase == "start" else "started")
            pool = marker(mode)
            if mode == "idle":
                pool["phase"] = "idle"
            if mode == "foreign":
                pool["app"] = "foreign"
            if mode == "stale":
                pool["token"] = "earlier"
            if mode in ("rolling", "wrong-intent"):
                pool["token"] = "earlier"
                pool["rolling"] = {"build": "build", "token": "attempt" if mode == "rolling" else "other"}
            if mode == "protected":
                value["config"]["metadata"]["rose_worker_reuse_protected"] = "true"
            if mode != "legacy":
                value["config"]["metadata"]["rose_cooperative_worker_pool"] = (
                    "[]" if mode == "malformed" else json.dumps(pool)
                )
            machines.append(value)
        original = copy.deepcopy(machines)
        calls = []

        def handler(request):
            if request.url.host == "api.machines.dev":
                if request.method == "GET":
                    return httpx.Response(200, json=machines)
                calls.append(request.url.path)
                return httpx.Response(200, json={})
            return httpx.Response(200, text="activity_slots_used 0\n")

        with patch.dict(
            os.environ,
            {
                "FLY_APP_NAME": "app",
                "FLY_API_TOKEN": "fixture",
                "FLY_MACHINE_ID": "leader",
                "TEMPORAL_WORKER_SURFACE_HASH": "A",
                "TEMPORAL_WORKER_BUILD_ID": "build",
                "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": "attempt",
            },
        ):
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
                await worker._scale_fleet(20 if phase == "start" else 1, http)
        assert calls == [f"/v1/apps/app/machines/{mid}/{phase}" for mid in ("valid", "rolling", "legacy")], calls
        assert machines == original


async def test_autoscaler_stopped_workers_require_current_build_and_deployment_attempt():
    """A matching replay hash and self-consistent old marker cannot revive an old image."""
    import copy
    from unittest.mock import patch
    import httpx
    import worker

    rows = []
    for index in range(8):
        rows.append(
            {
                "id": f"live-{index}",
                "state": "started",
                "config": {
                    "env": {
                        "TEMPORAL_WORKER_SURFACE_HASH": "A",
                        "TEMPORAL_WORKER_BUILD_ID": "current-build",
                        "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": "current-attempt",
                    }
                },
            }
        )
    for mode in (
        "old",
        "old-legacy",
        "old-build",
        "old-attempt",
        "current",
        "current-legacy",
        "rolling",
        "idle",
        "protected",
        "foreign",
        "foreign-generation",
    ):
        build = "old-build" if mode in ("old", "old-legacy", "old-build") else "current-build"
        token = "old-attempt" if mode in ("old", "old-legacy", "old-attempt") else "current-attempt"
        marker = {
            "version": 1,
            "phase": "active",
            "app": "app",
            "id": mode,
            "hash": "A",
            "build": build,
            "token": token,
        }
        if mode == "rolling":
            marker.update(build="old-build", token="old-attempt", rolling={"build": build, "token": token})
        if mode == "idle":
            marker["phase"] = "idle"
        if mode == "foreign":
            marker["app"] = "foreign"
        if mode == "foreign-generation":
            marker["hash"] = "B"
        metadata = {} if mode.endswith("legacy") else {"rose_cooperative_worker_pool": json.dumps(marker)}
        if mode == "protected":
            metadata["rose_worker_reuse_protected"] = "true"
        rows.append(
            {
                "id": mode,
                "state": "stopped",
                "config": {
                    "image": f"registry/app:{build}",
                    "metadata": metadata,
                    "env": {
                        "TEMPORAL_WORKER_SURFACE_HASH": "B" if mode == "foreign-generation" else "A",
                        "TEMPORAL_WORKER_BUILD_ID": build,
                        "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": token,
                    },
                },
            }
        )
    original = copy.deepcopy(rows)
    posts = []

    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json=rows)
        posts.append(request.url.path)
        return httpx.Response(200, json={})

    with patch.dict(
        os.environ,
        {
            "FLY_APP_NAME": "app",
            "FLY_API_TOKEN": "fixture",
            "FLY_MACHINE_ID": "live-0",
            "TEMPORAL_WORKER_SURFACE_HASH": "A",
            "TEMPORAL_WORKER_BUILD_ID": "current-build",
            "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": "current-attempt",
        },
    ):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            await worker._scale_fleet(20, http)
    assert posts == [f"/v1/apps/app/machines/{mid}/start" for mid in ("current", "current-legacy", "rolling")], posts
    assert rows == original, "start eligibility must not update/relabel old worker data"


async def test_autoscaler_missing_current_provenance_does_not_start_surface_workers():
    from unittest.mock import patch
    import httpx
    import worker

    for build, token in (("", "current-attempt"), ("current-build", ""), ("", "")):
        posts = []
        rows = [
            {
                "id": "stopped",
                "state": "stopped",
                "config": {
                    "env": {
                        "TEMPORAL_WORKER_SURFACE_HASH": "A",
                        "TEMPORAL_WORKER_BUILD_ID": "current-build",
                        "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": "current-attempt",
                    }
                },
            }
        ]

        def handler(request):
            if request.method == "GET":
                return httpx.Response(200, json=rows)
            posts.append(request.url.path)
            return httpx.Response(200, json={})

        with patch.dict(
            os.environ,
            {
                "FLY_APP_NAME": "app",
                "FLY_API_TOKEN": "fixture",
                "TEMPORAL_WORKER_SURFACE_HASH": "A",
                "TEMPORAL_WORKER_BUILD_ID": build,
                "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": token,
            },
        ):
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
                await worker._scale_fleet(8, http)
        assert not posts, (build, token, posts)


async def test_autoscaler_build_start_filter_preserves_busy_live_worker_scale_down():
    from unittest.mock import patch
    import httpx
    import worker

    rows = []
    for index, mid in enumerate(("leader", "old-busy", "old-idle", "current-idle")):
        old = mid.startswith("old-")
        rows.append(
            {
                "id": mid,
                "state": "started",
                "private_ip": f"fdaa::{index + 1}",
                "config": {
                    "env": {
                        "TEMPORAL_WORKER_SURFACE_HASH": "A",
                        "TEMPORAL_WORKER_BUILD_ID": "old" if old else "current",
                        "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": "old-attempt" if old else "current-attempt",
                    }
                },
            }
        )
    posts = []

    def handler(request):
        if request.url.host == "api.machines.dev":
            if request.method == "GET":
                return httpx.Response(200, json=rows)
            posts.append(request.url.path)
            return httpx.Response(200, json={})
        return httpx.Response(200, text=f"activity_slots_used {1 if request.url.host == 'fdaa::2' else 0}\n")

    with patch.dict(
        os.environ,
        {
            "FLY_APP_NAME": "app",
            "FLY_API_TOKEN": "fixture",
            "FLY_MACHINE_ID": "leader",
            "TEMPORAL_WORKER_SURFACE_HASH": "A",
            "TEMPORAL_WORKER_BUILD_ID": "current",
            "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": "current-attempt",
        },
    ):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            await worker._scale_fleet(1, http)
    assert posts == [f"/v1/apps/app/machines/{mid}/stop" for mid in ("old-idle", "current-idle")], posts


def _production_process_module():
    spec = importlib.util.spec_from_file_location(
        "production_worker_process", WORKER_PATH.parent.parent / "scripts/production_worker_process.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _production_process_request():
    import base64
    import gzip
    import hashlib
    import hmac
    import io
    import tarfile

    files = {"agents/worker.py": b"print('fixture only')\n", "agents/requirements.txt": b"fixture==1\n"}
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as output:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), 0o644
            output.addfile(info, io.BytesIO(data))
    data = gzip.compress(archive.getvalue())
    request = {
        "version": 1,
        "action": "ensure",
        "app": "fixture-app",
        "machineId": "0123456789abcd",
        "machineVersion": "version-1",
        "bootId": "fixture-boot",
        "sourceCommit": "a" * 40,
        "buildId": "a" * 40,
        "surfaceHash": "b" * 12,
        "deploymentToken": "fixture-attempt",
        "namespace": "fixture.namespace",
        "baseTaskQueue": "navi-agent-tasks",
        "validationTaskQueue": "fixture-validation",
        "peopleCredentialBrokerOrigin": "https://navi-j9a9.onrender.com",
        "bundleSHA256": hashlib.sha256(data).hexdigest(),
        "bundleBase64": base64.b64encode(data).decode(),
        "healthPort": 0,
        "sdkMetricsPort": 0,
        "limits": {
            "maxAddressBytes": 1073741824,
            "minFreeAfterMaxAddressBytes": 268435456,
            "aggregateMemoryBytes": 1073741824,
            "memoryController": "v1-memory",
        },
        "manifest": {
            "version": 1,
            "sourceCommit": "a" * 40,
            "requirementsSHA256": hashlib.sha256(files["agents/requirements.txt"]).hexdigest(),
            "installedDistributionsSHA256": "d" * 64,
            "pythonSHA256": "e" * 64,
            "files": [
                {"path": name, "sha256": hashlib.sha256(body).hexdigest(), "size": len(body), "mode": 0o644}
                for name, body in files.items()
            ],
        },
    }
    key = "fixture-key-do-not-use"
    request["signature"] = hmac.new(
        key.encode(), json.dumps(request, sort_keys=True, separators=(",", ":")).encode(), hashlib.sha256
    ).hexdigest()
    return request, key


def test_production_process_authenticates_complete_bundle_before_effects():
    import copy
    from unittest.mock import patch

    module = _production_process_module()
    request, key = _production_process_request()
    assert set(module.verify_bundle(request)) == {"agents/worker.py", "agents/requirements.txt"}
    module.authenticate(request, key)
    for field, value in (("machineId", "foreign"), ("bootId", "other-boot"), ("buildId", "f" * 40)):
        bad = copy.deepcopy(request)
        bad[field] = value
        try:
            module.authenticate(bad, key)
        except ValueError:
            pass
        else:
            raise AssertionError(f"unsigned {field} mutation accepted")
    bad = copy.deepcopy(request)
    bad["manifest"]["files"][0]["sha256"] = "0" * 64
    try:
        module.verify_bundle(bad)
    except ValueError:
        pass
    else:
        raise AssertionError("tampered complete source accepted")
    with (
        patch.object(module, "authenticate", side_effect=ValueError("invalid signature")),
        patch.object(module, "prepare_slot") as stage,
    ):
        try:
            module.dispatch(request)
        except ValueError:
            pass
        stage.assert_not_called()


def test_production_process_environment_preserves_old_owner_and_activation():
    module = _production_process_module()
    request, _ = _production_process_request()
    original = {
        "BACKEND_API_KEY": "fixture",
        "PEOPLE_CREDENTIAL_BROKER_URL": "https://foreign.example",
        "TEMPORAL_TASK_QUEUE": "old",
        "TEMPORAL_NAMESPACE": "fixture.namespace",
        "PYTHONPATH": "/old/app",
        "VIRTUAL_ENV": "/old/venv",
        "HOME": "/old/home",
        "FLY_MACHINE_ID": request["machineId"],
    }
    before = dict(original)
    environment = module.worker_environment(request, Path("/owned/runtime"), original)
    assert original == before
    assert environment.get("PEOPLE_CREDENTIAL_BROKER_URL") == request["peopleCredentialBrokerOrigin"]
    assert environment["AUTOSCALER_ACTUATE"] == "0"
    assert environment["TEMPORAL_WORKER_REQUIRE_ACTIVATION"] == "1"
    assert environment["TEMPORAL_TASK_QUEUE"] == "navi-agent-tasks"
    assert environment["TEMPORAL_WORKER_SURFACE_HASH"] == "b" * 12
    assert environment["TEMPORAL_WORKER_BUILD_ID"] == "a" * 40
    assert environment["TEMPORAL_WORKER_VALIDATION_TASK_QUEUE"] == "fixture-validation"
    assert environment["HEALTH_CHECK_PORT"] == environment["SDK_METRICS_PORT"] == "0"
    assert "PYTHONPATH" not in environment and "VIRTUAL_ENV" not in environment
    for key in ("HOME", "TMPDIR", "BROWSER_AGENT_RECORDINGS_DIR", "TRACE_ARCHIVE_LOCAL_ROOT", "XDG_CACHE_HOME"):
        assert environment[key].startswith("/owned/runtime/"), (key, environment[key])


def test_production_process_unknown_memory_or_native_identity_starts_nothing():
    from unittest.mock import patch

    module = _production_process_module()
    request, key = _production_process_request()
    native = {
        "FLY_APP_NAME": request["app"],
        "FLY_MACHINE_ID": request["machineId"],
        "FLY_MACHINE_VERSION": request["machineVersion"],
        "TEMPORAL_NAMESPACE": request["namespace"],
    }
    with patch.dict(os.environ, native, clear=True), patch.object(module, "boot_id", return_value="other-boot"):
        try:
            module.verify_native(request)
        except ValueError:
            pass
        else:
            raise AssertionError("foreign boot accepted")
    with (
        patch.object(module, "available_memory", return_value=128 * 1024 * 1024),
        patch.object(module.subprocess, "Popen") as spawn,
    ):
        try:
            module.require_memory(request)
        except ValueError:
            pass
        else:
            raise AssertionError("insufficient reserve accepted")
        spawn.assert_not_called()


def test_production_process_rejects_unlisted_linked_duplicate_or_missing_sources():
    import base64
    import copy
    import gzip
    import hashlib
    import io
    import tarfile

    module = _production_process_module()
    request, _ = _production_process_request()
    original = base64.b64decode(request["bundleBase64"])
    for kind in ("extra", "symlink", "duplicate", "missing", "traversal"):
        output = io.BytesIO()
        with (
            tarfile.open(fileobj=io.BytesIO(original), mode="r:gz") as source,
            tarfile.open(fileobj=output, mode="w") as archive,
        ):
            for index, item in enumerate(source):
                if kind == "missing" and index == 0:
                    continue
                data = source.extractfile(item).read()
                archive.addfile(item, io.BytesIO(data))
                if kind == "duplicate" and index == 0:
                    archive.addfile(item, io.BytesIO(data))
            if kind in ("extra", "symlink", "traversal"):
                item = tarfile.TarInfo("agents/extra.py" if kind != "traversal" else "agents/../../old.py")
                if kind == "symlink":
                    item.type, item.linkname = tarfile.SYMTYPE, "/app/worker.py"
                archive.addfile(item, io.BytesIO())
        archive_bytes = gzip.compress(output.getvalue())
        bad = copy.deepcopy(request)
        bad["bundleBase64"] = base64.b64encode(archive_bytes).decode()
        bad["bundleSHA256"] = hashlib.sha256(archive_bytes).hexdigest()
        try:
            module.verify_bundle(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"{kind} source accepted")


def test_production_process_memory_membership_and_uid_precede_exec():
    from unittest.mock import patch

    module = _production_process_module()
    request, _ = _production_process_request()
    events = []
    group = Path("/sys/fs/cgroup/memory/rose-worker-fixture")
    contents = {str(group / "cgroup.procs"): "", "/proc/self/oom_score_adj": "0"}

    def write(path, data):
        contents[str(path)] = data
        events.append(("write", str(path), data))

    class Libc:
        def prctl(self, *args):
            events.append(("prctl", args))
            return 0

    with (
        patch.object(module.Path, "read_text", lambda p: contents[str(p)]),
        patch.object(module.Path, "write_text", write),
        patch.object(module.os, "getpid", return_value=777),
        patch.object(module.os, "setgroups", side_effect=lambda value: events.append(("groups", value))),
        patch.object(module.os, "setgid", side_effect=lambda value: events.append(("gid", value))),
        patch.object(module.os, "setuid", side_effect=lambda value: events.append(("uid", value))),
        patch.object(module.os, "getuid", return_value=1000),
        patch.object(module.os, "geteuid", return_value=1000),
        patch.object(module.os, "umask"),
        patch.object(module.resource, "setrlimit", side_effect=lambda *args: events.append(("limit", args))),
        patch.object(module.ctypes, "CDLL", return_value=Libc()),
    ):
        module.child_boundary(group, request)
    assert events[0] == ("write", str(group / "cgroup.procs"), "777"), events
    assert [event[0] for event in events] == ["write", "limit", "write", "groups", "gid", "uid", "prctl"], events
    assert events[1][1][1] == (1073741824, 1073741824)
    assert events[2] == ("write", "/proc/self/oom_score_adj", "1000")
    assert ("uid", 1000) in events and ("gid", 1000) in events
    with (
        patch.object(module.Path, "read_text", return_value="an existing process"),
        patch.object(module.os, "setuid") as drop,
    ):
        try:
            module.child_boundary(group, request)
        except ValueError:
            pass
        else:
            raise AssertionError("occupied memory group accepted")
        drop.assert_not_called()


def test_production_process_memory_controller_missing_starts_nothing():
    from unittest.mock import patch

    module = _production_process_module()
    request, _ = _production_process_request()
    with (
        patch.object(module.Path, "read_text", return_value="no memory controller"),
        patch.object(module.Path, "mkdir") as create,
        patch.object(module.subprocess, "Popen") as spawn,
    ):
        try:
            module.memory_group(request, "fixture")
        except ValueError:
            pass
        else:
            raise AssertionError("missing aggregate controller accepted")
        create.assert_not_called()
        spawn.assert_not_called()


def test_production_process_status_requires_exact_owned_live_slot():
    import fcntl
    from unittest.mock import patch

    module = _production_process_module()
    request, key = _production_process_request()
    with (
        tempfile.TemporaryDirectory() as directory,
        patch.object(module, "ROOT", Path(directory)),
        patch.object(module, "secure"),
    ):
        missing = module.status(request)
        assert missing["phase"] == "MISSING"
        held = os.open(Path(directory) / "slot.lock", os.O_RDWR)
        try:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            assert module.status(request)["phase"] == "UNKNOWN", "in-flight launch certified absent"
            child = {"pid": 111, "birthTicks": "20", "bootId": request["bootId"]}
            state = module.response(
                request,
                phase="STANDBY",
                supervisor=child,
                child=child,
                workerLog="worker-111-0.log",
                observedAt=time.time(),
            )
            module.atomic_json(Path(directory) / "state.json", state)
            with patch.object(module, "same_process", return_value=False):
                assert module.status(request)["phase"] == "UNKNOWN", "reused/dead PID certified live"
            with (
                patch.object(module, "same_process", return_value=True),
                patch.object(
                    module,
                    "observe_health",
                    return_value={"phase": "RUNNING", "healthPort": 1234, "sdkMetricsPort": 1235},
                ),
            ):
                assert module.status(request)["phase"] == "RUNNING"
            foreign = dict(request, deploymentToken="foreign-attempt")
            try:
                module.status(foreign)
            except ValueError:
                pass
            else:
                raise AssertionError("foreign attempt adopted")
        finally:
            os.close(held)
        assert module.status(request)["phase"] == "UNKNOWN", "lost supervisor lock certified absence"
    # Compact signed status has precisely the same semantic intent.
    import hashlib
    import hmac

    compact = {k: v for k, v in request.items() if k not in ("signature", "bundleBase64")}
    compact["action"] = "status"
    compact["signature"] = hmac.new(key.encode(), module.canonical(compact), hashlib.sha256).hexdigest()
    module.authenticate(compact, key)
    assert module.intent_digest(compact) == module.intent_digest(request)


def test_production_process_detaches_restarts_and_does_not_touch_old_worker():
    """Real local fork/Popen/socket lifecycle; only privileged host effects mocked."""
    import base64
    import gzip
    import hashlib
    import hmac
    import io
    import tarfile

    module = _production_process_module()
    request, key = _production_process_request()
    worker = r"""
import http.server,json,os,pathlib,resource,socket,threading,time
home=pathlib.Path(os.environ['HOME'])
countfile=home/'launches'
count=int(countfile.read_text())+1 if countfile.exists() else 1
countfile.write_text(str(count))
with (home/'observations').open('a') as output:
    output.write(json.dumps({'pid':os.getpid(),'cwd':os.getcwd(),'limit':resource.getrlimit(resource.RLIMIT_AS),'broker':os.environ['PEOPLE_CREDENTIAL_BROKER_URL'],'activation':os.environ['TEMPORAL_WORKER_REQUIRE_ACTIVATION'],'autoscale':os.environ['AUTOSCALER_ACTUATE'],'count':count,'oom':pathlib.Path('/proc/self/oom_score_adj').read_text().strip()})+'\n')
if count==1:
    raise SystemExit(17)
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body=json.dumps({'healthy':True,'phase':'standby','build_id':os.environ['TEMPORAL_WORKER_BUILD_ID']}).encode()
        self.send_response(200);self.end_headers();self.wfile.write(body)
    def log_message(self,*args): pass
server=http.server.HTTPServer(('127.0.0.1',0),Handler)
sdk=socket.socket();sdk.bind(('127.0.0.1',0));sdk.listen()
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
print(json.dumps({'event':'Worker observability endpoints bound','health_check_port':server.server_port,'sdk_metrics_port':sdk.getsockname()[1]}),flush=True)
time.sleep(0.7)
server.shutdown();thread.join();server.server_close();sdk.close()
""".encode()
    files = {"agents/worker.py": worker, "agents/requirements.txt": b"fixture==1\n"}
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, body in files.items():
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(body), 0o644
            archive.addfile(info, io.BytesIO(body))
    compressed = gzip.compress(output.getvalue())
    request["bundleBase64"] = base64.b64encode(compressed).decode()
    request["bundleSHA256"] = hashlib.sha256(compressed).hexdigest()
    request["manifest"]["files"] = [
        {"path": name, "sha256": hashlib.sha256(body).hexdigest(), "size": len(body), "mode": 0o644}
        for name, body in files.items()
    ]
    request.pop("signature")
    request["signature"] = hmac.new(key.encode(), module.canonical(request), hashlib.sha256).hexdigest()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        old_source = root / "old-source"
        old_source.write_text("preserve original source")
        old = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # This managed test host assigns OOM scores asynchronously. Establish
        # its actual settled parent/old-process baseline; never write either.
        oom_deadline = time.monotonic() + 2
        previous_oom = None
        stable_samples = 0
        while time.monotonic() < oom_deadline:
            current = (Path("/proc/self/oom_score_adj").read_text(), Path(f"/proc/{old.pid}/oom_score_adj").read_text())
            stable_samples = stable_samples + 1 if current == previous_oom else 0
            previous_oom = current
            if stable_samples >= 5 and current[0] == current[1]:
                break
            time.sleep(0.05)
        parent_oom, old_oom = previous_oom
        launcher = root / "launch.py"
        launcher.write_text(r"""
import importlib.util,json,os,pathlib,resource,sys
path,root,requestfile,key=sys.argv[1:]
spec=importlib.util.spec_from_file_location('production_worker_process',path)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.ROOT=pathlib.Path(root)/'slot'
request=json.loads(pathlib.Path(requestfile).read_text())
os.environ.update(BACKEND_API_KEY=key,FLY_APP_NAME=request['app'],FLY_MACHINE_ID=request['machineId'],FLY_MACHINE_VERSION=request['machineVersion'],TEMPORAL_NAMESPACE=request['namespace'])
m.boot_id=lambda:request['bootId']
m.os.geteuid=lambda:0
m.secure=lambda *args,**kwargs:None # UID ownership is an external privilege boundary.
m.os.chown=lambda *args:None
m.verify_dependencies=lambda request:None # No deployed runtime attestation inferred.
def memory_group(request,name):
    group=pathlib.Path(root)/'mock-kernel-group';group.mkdir()
    (group/'cgroup.procs').write_text('')
    return group
m.memory_group=memory_group
def boundary(group,request):
    (group/'cgroup.procs').write_text(str(os.getpid()))
    resource.setrlimit(resource.RLIMIT_AS,(request['limits']['maxAddressBytes'],)*2)
    pathlib.Path('/proc/self/oom_score_adj').write_text('1000')
m.child_boundary=boundary
# The devbox externally rewrites live OOM scores; native kernel proof is separate.
m.child_oom_score=lambda pid:1000
observe=m.observe_health
def diagnostic(*args,**kwargs):
    try: return observe(*args,**kwargs)
    except Exception as error:
        with (pathlib.Path(root)/'health-errors').open('a') as output: output.write(repr(error)+' score='+str(m.child_oom_score(args[0]['pid']))+'\n')
        raise
m.observe_health=diagnostic
real=m.subprocess.Popen
def launch(*args,**kwargs):
    child=real(*args,**kwargs)
    poll=child.poll
    def observed():
        code=poll()
        if code is not None:
            (pathlib.Path(root)/'mock-kernel-group'/'cgroup.procs').write_text('')
        return code
    child.poll=observed
    return child
m.subprocess.Popen=launch
print(json.dumps(m.dispatch(request)),flush=True)
""")
        request_file = root / "request.json"
        request_file.write_text(json.dumps(request))
        argv = [
            sys.executable,
            str(launcher),
            str(WORKER_PATH.parent.parent / "scripts/production_worker_process.py"),
            str(root),
            str(request_file),
            key,
        ]
        daemon = None
        try:
            started = time.monotonic()
            first = subprocess.run(argv, capture_output=True, text=True, timeout=5)
            assert first.returncode == 0, first.stderr
            assert time.monotonic() - started < 4, "SSH parent/stdout remained attached to worker"
            receipt = json.loads(first.stdout)
            daemon = receipt["supervisor"]
            assert os.getsid(daemon["pid"]) == daemon["pid"], "supervisor retained SSH session ownership"
            repeated_live = subprocess.run(argv, capture_output=True, text=True, timeout=5)
            assert repeated_live.returncode == 0, repeated_live.stderr
            assert json.loads(repeated_live.stdout)["supervisorPid"] == daemon["pid"], (
                "lost-ACK ensure spawned another supervisor"
            )
            assert module.same_process({**daemon, "bootId": module.boot_id()}), (
                "detached supervisor exited with launcher"
            )
            deadline = time.monotonic() + 16
            seen_standby = False
            while time.monotonic() < deadline:
                state = json.loads((root / "slot" / "state.json").read_text())
                seen_standby |= state.get("phase") == "STANDBY"
                if state.get("phase") == "BLOCKED":
                    break
                assert old.poll() is None, "pre-existing worker was signaled"
                time.sleep(0.05)
            else:
                raise AssertionError("bounded local supervisor did not finish")
            assert seen_standby, (
                state,
                (root / "health-errors").read_text() if (root / "health-errors").exists() else "no errors",
                (root / "slot" / module.intent_digest(request) / "runtime/home/observations").read_text(),
                parent_oom,
                Path("/proc/self/oom_score_adj").read_text(),
            )
            assert state["restarts"] == 2, state
            runtime = root / "slot" / module.intent_digest(request) / "runtime" / "home"
            observations = [json.loads(line) for line in (runtime / "observations").read_text().splitlines()]
            assert len(observations) == 3 and len({item["pid"] for item in observations}) == 3, observations
            assert all(item["limit"] == [1073741824, 1073741824] for item in observations), observations
            assert all(item["oom"] == "1000" for item in observations), observations
            assert all(item["broker"] == request["peopleCredentialBrokerOrigin"] for item in observations)
            assert all(item["activation"] == "1" and item["autoscale"] == "0" for item in observations)
            assert all(item["cwd"].endswith("/source/agents") for item in observations)
            assert old_source.read_text() == "preserve original source" and old.poll() is None
            assert Path("/proc/self/oom_score_adj").read_text() == parent_oom, (
                parent_oom,
                Path("/proc/self/oom_score_adj").read_text(),
            )
            assert Path(f"/proc/{old.pid}/oom_score_adj").read_text() == old_oom, (
                old_oom,
                Path(f"/proc/{old.pid}/oom_score_adj").read_text(),
            )
            # After an unreconciled same-boot exit, never spawn by treating it absent.
            repeated = subprocess.run(argv, capture_output=True, text=True, timeout=5)
            assert repeated.returncode == 0, repeated.stderr
            assert json.loads(repeated.stdout)["phase"] == "UNKNOWN"
            assert len((runtime / "observations").read_text().splitlines()) == 3
        finally:
            old.terminate()  # Exact retained fixture process only.
            old.wait(timeout=5)
            if daemon is not None:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and module.same_process({**daemon, "bootId": module.boot_id()}):
                    time.sleep(0.05)
                assert not module.same_process({**daemon, "bootId": module.boot_id()}), "fixture daemon still live"


def test_production_process_memory_limit_readback_and_swap_deny():
    from unittest.mock import patch

    module = _production_process_module()
    request, _ = _production_process_request()
    group = Path("/sys/fs/cgroup/memory/rose-worker-fixture")
    for mode in ("valid", "readback", "readonly", "swap", "occupied"):
        writes = []
        contents = {
            "/proc/self/mountinfo": "42 20 0:31 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory",
            "/proc/meminfo": "SwapTotal: 1 kB\n",
            str(group / "cgroup.procs"): "123" if mode == "occupied" else "",
            str(group / "memory.use_hierarchy"): "0",
            str(group / "memory.limit_in_bytes"): "0",
            str(group / "memory.memsw.limit_in_bytes"): "0",
        }

        def write(path, value):
            writes.append((str(path), value))
            assert path.parent == group, "controller wrote outside its exclusive leaf"
            if mode == "readonly":
                raise PermissionError("fixture controller readonly")
            if not (mode == "readback" and path.name == "memory.limit_in_bytes"):
                contents[str(path)] = value

        with (
            patch.object(module.Path, "read_text", lambda p: contents[str(p)]),
            patch.object(module.Path, "write_text", write),
            patch.object(module.Path, "mkdir"),
            patch.object(module.Path, "exists", return_value=mode != "swap"),
            patch.object(module, "secure"),
        ):
            try:
                result = module.memory_group(request, "fixture")
            except (ValueError, PermissionError):
                assert mode != "valid", mode
            else:
                assert mode == "valid", f"{mode} memory boundary accepted"
                assert result == group
                assert contents[str(group / "memory.limit_in_bytes")] == "1073741824"
                assert contents[str(group / "memory.memsw.limit_in_bytes")] == "1073741824"
        if mode == "occupied":
            assert not writes, "occupied controller changed"


def test_production_process_health_requires_child_socket_and_expected_build():
    from unittest.mock import patch

    module = _production_process_module()
    request, _ = _production_process_request()
    child = {"pid": 123, "birthTicks": "1", "bootId": "fixture-boot"}
    with tempfile.TemporaryDirectory() as directory:
        log = Path(directory) / "worker.log"
        log.write_text(
            json.dumps(
                {"event": "Worker observability endpoints bound", "health_check_port": 12345, "sdk_metrics_port": 12346}
            )
            + "\n[]\n"
        )
        with (
            patch.object(module, "same_process", return_value=True),
            patch.object(module, "owns_socket", return_value=False),
            patch.object(module.http.client, "HTTPConnection") as connection,
        ):
            try:
                module.observe_health(child, request, log)
            except ValueError:
                pass
            else:
                raise AssertionError("foreign process health accepted")
            connection.assert_not_called()
        with (
            patch.object(module, "same_process", return_value=True),
            patch.object(module, "owns_socket", return_value=True),
            patch.object(module, "child_oom_score", return_value=1000),
            patch.object(module.http.client, "HTTPConnection") as connection,
        ):
            reply = connection.return_value.getresponse.return_value
            reply.status = 200
            reply.read.return_value = json.dumps(
                {"healthy": True, "phase": "standby", "build_id": request["buildId"]}
            ).encode()
            state = module.observe_health(child, request, log)
            assert state["phase"] == "STANDBY" and state["health"]["build_id"] == request["buildId"]
            with patch.object(module, "child_oom_score", return_value=500):
                try:
                    module.observe_health(child, request, log)
                except ValueError:
                    pass
                else:
                    raise AssertionError("altered child OOM priority accepted")
            # Long logs/rotation must not erase an already bound endpoint.
            log.write_text("x" * 200000)
            assert module.observe_health(child, request, log, state)["phase"] == "STANDBY"
            reply.read.return_value = json.dumps({"healthy": True, "phase": "standby", "build_id": "foreign"}).encode()
            try:
                module.observe_health(child, request, log, state)
            except ValueError:
                pass
            else:
                raise AssertionError("wrong-build health accepted")


def test_production_process_bounds_owned_log_after_rotation():
    module = _production_process_module()
    read_fd, write_fd = os.pipe()
    try:
        os.set_blocking(read_fd, False)
        os.write(write_fd, b"new owned log bytes")
        with os.fdopen(read_fd, "rb", closefd=False) as stream, tempfile.TemporaryFile("w+b", buffering=0) as output:
            output.truncate(32 * 1024 * 1024)
            output.seek(0, os.SEEK_END)
            module.drain_output(stream, output)
            assert os.fstat(output.fileno()).st_size <= 32 * 1024 * 1024, "owned log grew past cap after rotation"
            output.seek(0)
            assert output.read() == b"new owned log bytes"
    finally:
        os.close(read_fd)
        os.close(write_fd)


async def run_all_tests():
    print("worker blackbox tests:")
    r = BlackboxResult()
    r.record("production_process_owned_log_bounded_rotation", test_production_process_bounds_owned_log_after_rotation)
    await r.record_async("late_activity_body_start_logged", test_late_activity_body_start_is_logged_with_its_dispatch_lag)
    r.record("worker_registers_dispatch_lag_interceptor", test_worker_registers_activity_dispatch_lag_interceptor)
    r.record(
        "production_process_memory_readback_swap_denied", test_production_process_memory_limit_readback_and_swap_deny
    )
    r.record(
        "production_process_exact_child_health", test_production_process_health_requires_child_socket_and_expected_build
    )
    r.record(
        "production_process_detached_restart_old_worker_preserved",
        test_production_process_detaches_restarts_and_does_not_touch_old_worker,
    )
    r.record(
        "production_process_archive_rejects_unlisted_links_duplicates",
        test_production_process_rejects_unlisted_linked_duplicate_or_missing_sources,
    )
    r.record("production_process_group_uid_before_exec", test_production_process_memory_membership_and_uid_precede_exec)
    r.record(
        "production_process_missing_controller_denies_spawn",
        test_production_process_memory_controller_missing_starts_nothing,
    )
    r.record("production_process_exact_live_slot_status", test_production_process_status_requires_exact_owned_live_slot)
    r.record(
        "production_process_complete_authenticated_bundle",
        test_production_process_authenticates_complete_bundle_before_effects,
    )
    r.record(
        "production_process_isolated_environment_activation",
        test_production_process_environment_preserves_old_owner_and_activation,
    )
    r.record(
        "production_process_unknown_memory_native_denied",
        test_production_process_unknown_memory_or_native_identity_starts_nothing,
    )
    await r.record_async(
        "autoscaler_stopped_current_build_attempt",
        test_autoscaler_stopped_workers_require_current_build_and_deployment_attempt,
    )
    await r.record_async(
        "autoscaler_missing_current_provenance",
        test_autoscaler_missing_current_provenance_does_not_start_surface_workers,
    )
    await r.record_async(
        "autoscaler_build_filter_preserves_live_drain",
        test_autoscaler_build_start_filter_preserves_busy_live_worker_scale_down,
    )
    await r.record_async(
        "autoscaler_retained_pool_rollback_custody",
        test_autoscaler_retained_generation_cannot_start_by_matching_rollback_hash,
    )
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
    await r.record_async("loop_lag_attributes_cpu_starvation", test_loop_lag_attributes_stall_to_cpu_starvation_window)
    r.record("cgroup_throttled_usec_parser", test_cgroup_throttled_usec_reads_cpu_stat_and_reports_unknown_when_absent)
    r.record("cgroup_throttle_stat_prefers_local", test_cgroup_throttle_stat_prefers_cpu_stat_local_for_ancestor_quotas)
    r.record("run_then_exit_survives_a_finalization_deadlock", test_run_then_exit_survives_a_finalization_deadlock)
    r.record("exit_code_for_matches_cpython_system_exit", test_exit_code_for_matches_cpython_system_exit)
    r.record("worker_entrypoint_skips_interpreter_finalization", test_worker_entrypoint_skips_interpreter_finalization)
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
        "worker_loop_shutdown_bounded_on_blocked_executor_threads",
        test_worker_event_loop_shutdown_does_not_wait_forever_on_executor_threads,
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
    await r.record_async(
        "autoscaler_backs_off_on_namespace_rate_limit",
        test_autoscaler_backs_off_on_namespace_rate_limit_and_recovers,
    )
    await r.record_async(
        "autoscaler_budgeted_cadence_and_opt_out",
        test_autoscaler_queue_observation_honors_budgeted_cadence_and_opt_out,
    )
    await r.record_async(
        "autoscaler_scale_down_never_stops_machines_with_in_flight_activities",
        test_autoscaler_scale_down_never_stops_machines_with_in_flight_activities,
    )
    await r.record_async(
        "autoscaler_followers_spend_no_visibility_calls",
        test_autoscaler_followers_spend_no_visibility_calls_and_mirror_the_leader,
    )
    await r.record_async(
        "autoscaler_leader_observes_its_generation",
        test_autoscaler_leader_observes_and_counts_only_its_own_generation,
    )
    await r.record_async(
        "autoscaler_unknown_leadership_reduced_cadence",
        test_autoscaler_unknown_leadership_observes_at_reduced_cadence_without_actuating,
    )
    await r.record_async(
        "autoscaler_leadership_never_zero_observers",
        test_autoscaler_leadership_never_leaves_a_generation_without_an_observer,
    )
    await r.record_async(
        "autoscaler_local_readings_fresh_while_throttled",
        test_autoscaler_publishes_fresh_local_readings_while_temporal_is_throttled,
    )
    await r.record_async(
        "autoscaler_missing_backlog_is_unknown",
        test_autoscaler_missing_backlog_is_unknown_and_never_drives_scale_down,
    )
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
