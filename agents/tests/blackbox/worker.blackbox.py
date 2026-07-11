"""Blackbox tests for Temporal worker configuration."""

import ast
import asyncio
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


def test_worker_workflow_supplier_is_sdk_native_fixed_size():
    """Fixed workflow slots must preserve sticky pollers under memory pressure."""
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


async def run_all_tests():
    print("worker blackbox tests:")
    r = BlackboxResult()
    r.record("worker_does_not_use_python_custom_activity_slots", test_worker_does_not_use_python_custom_activity_slots)
    r.record(
        "worker_activity_supplier_is_sdk_native_fixed_size", test_worker_activity_supplier_is_sdk_native_fixed_size
    )
    r.record(
        "worker_workflow_supplier_is_sdk_native_fixed_size", test_worker_workflow_supplier_is_sdk_native_fixed_size
    )
    r.record("worker_passes_sticky_queue_timeout_to_temporal", test_worker_passes_sticky_queue_timeout_to_temporal)
    r.record("activity_admission_closes_on_cpu_pressure", test_activity_admission_closes_on_cpu_pressure)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
