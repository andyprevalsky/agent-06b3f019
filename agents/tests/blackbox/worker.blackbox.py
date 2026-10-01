"""Blackbox tests for Temporal worker configuration."""

import ast
import asyncio
import importlib.util
import subprocess
import sys
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
    r.record("run_then_exit_survives_a_finalization_deadlock", test_run_then_exit_survives_a_finalization_deadlock)
    r.record("exit_code_for_matches_cpython_system_exit", test_exit_code_for_matches_cpython_system_exit)
    r.record("worker_entrypoint_skips_interpreter_finalization", test_worker_entrypoint_skips_interpreter_finalization)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
