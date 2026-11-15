"""The real worker entry point must finish native RPCs before interpreter exit."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

import grpc
import pytest


AGENTS = Path(__file__).resolve().parents[2]
NATIVE_CALLBACK = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p)
_pthread = ctypes.CDLL(None)
_pthread.pthread_create.argtypes = [ctypes.POINTER(ctypes.c_ulong), ctypes.c_void_p, NATIVE_CALLBACK, ctypes.c_void_p]
_pthread.pthread_join.argtypes = [ctypes.c_ulong, ctypes.c_void_p]


def _run_python_on_native_thread(seconds):
    """Execute Python on a thread threading did not start, as an SDK Tokio thread does."""
    entered, finished = threading.Event(), threading.Event()

    def body(_argument):
        # Logging from a native thread registers a _DummyThread like this.
        threading.current_thread()
        entered.set()
        time.sleep(seconds)
        finished.set()
        return None

    callback = NATIVE_CALLBACK(body)
    thread = ctypes.c_ulong()
    assert _pthread.pthread_create(ctypes.byref(thread), None, callback, None) == 0
    assert entered.wait(5)
    return thread, callback, finished


def test_worker_exit_waits_for_native_thread_python_callback():
    from helpers import process_exit

    thread, callback, finished = _run_python_on_native_thread(0.3)
    try:
        assert process_exit.foreign_threads_running_python()
        assert asyncio.run(process_exit.drain_native_python_callbacks(timeout=5)) is True
        assert finished.is_set(), "entry point could return while a native callback was still in Python"
        assert not process_exit.foreign_threads_running_python()
    finally:
        assert _pthread.pthread_join(thread, None) == 0
        del callback


def test_worker_exit_native_callback_wait_is_bounded():
    from helpers import process_exit

    thread, callback, finished = _run_python_on_native_thread(1.0)
    try:
        started = time.monotonic()
        assert asyncio.run(process_exit.drain_native_python_callbacks(timeout=0.05)) is False
        assert time.monotonic() - started < 0.5
        assert not finished.is_set()
    finally:
        assert _pthread.pthread_join(thread, None) == 0
        del callback


CHILD = r"""
import asyncio
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch
import worker

address, directory = sys.argv[1:]
directory = Path(directory)
config = SimpleNamespace(
    environment="development", health_check_port=0,
    temporal=SimpleNamespace(
        address=address, namespace="test", task_queue="worker-exit-test", api_key="",
        max_concurrent_activities=10, max_concurrent_workflows=10,
        activity_admission_close_memory_percent=80, activity_admission_open_memory_percent=75,
        activity_admission_close_cpu_percent=80, activity_admission_open_cpu_percent=75,
        max_cached_workflows=10, sticky_queue_schedule_to_start_timeout_seconds=10,
        max_concurrent_activity_task_polls=2, max_concurrent_workflow_task_polls=2,
        nonsticky_to_sticky_poll_ratio=0.2,
    ),
)

class IdleWorker:
    def __init__(self, *args, **kwargs):
        self.is_running = False
    async def run(self):
        self.is_running = True
        while not all((directory / name).exists() for name in ("rpc-entered", "worker-ready")):
            await asyncio.sleep(0.005)
        # The activity owner has completed. Shutdown now overlaps the real SDK
        # observability request still executing in the parent-owned gRPC server.
        (directory / "worker-drained").touch()
    async def shutdown(self):
        pass

def publish_status(active, **fields):
    if active and fields.get("phase") == "running":
        (directory / "worker-ready").touch()

with (
    patch.object(worker, "load_config", return_value=config),
    patch.object(worker, "Worker", IdleWorker),
    patch.object(worker, "SDK_METRICS_PORT", 0),
    patch.object(worker, "set_worker_status", side_effect=publish_status),
):
    asyncio.run(worker.main())
(directory / "entrypoint-returned").touch()
print("WORKER_ENTRYPOINT_RETURNED", flush=True)
"""


@pytest.mark.parametrize("phase", ["count", "describe"])
@pytest.mark.parametrize("outcome", ["success", "resource_exhausted", "deadline"])
def test_worker_entrypoint_joins_inflight_metrics_rpc_before_exit(outcome, phase):
    """No process survives completed worker cleanup, even on a native RPC error."""
    with tempfile.TemporaryDirectory(prefix="worker-native-exit-") as directory:
        root = Path(directory)
        calls = []
        rpc_finished = threading.Event()
        observations = {}

        def pending_rpc(context):
            observations["rpc_deadline_seconds"] = context.time_remaining()
            (root / "rpc-entered").touch()
            deadline = time.monotonic() + 10
            while not (root / "worker-drained").exists() and time.monotonic() < deadline:
                time.sleep(0.005)
            observations["worker_drained"] = (root / "worker-drained").exists()
            if outcome == "deadline":
                while context.is_active() and time.monotonic() < deadline:
                    time.sleep(0.005)
            else:
                time.sleep(0.3)
                observations.setdefault(
                    "entrypoint_returned_before_first_response",
                    (root / "entrypoint-returned").exists(),
                )
            rpc_finished.set()
            if outcome == "resource_exhausted":
                context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, "test namespace rate limit exceeded")
            return b""

        def count(request, context):
            calls.append("count")
            return pending_rpc(context) if phase == "count" else b""

        def describe(request, context):
            calls.append("describe")
            return pending_rpc(context)

        with ThreadPoolExecutor(max_workers=4) as executor:
            server = grpc.server(executor)
            server.add_generic_rpc_handlers(
                (
                    grpc.method_handlers_generic_handler(
                        "temporal.api.workflowservice.v1.WorkflowService",
                        {
                            "GetSystemInfo": grpc.unary_unary_rpc_method_handler(lambda request, context: b""),
                            "CountWorkflowExecutions": grpc.unary_unary_rpc_method_handler(count),
                            "DescribeTaskQueue": grpc.unary_unary_rpc_method_handler(describe),
                        },
                    ),
                )
            )
            port = server.add_insecure_port("127.0.0.1:0")
            server.start()
            environment = os.environ.copy()
            environment.update(
                BACKEND_API_KEY="worker-exit-test",
                TEMPORAL_WORKER_REQUIRE_ACTIVATION="0",
                AUTOSCALER_ACTUATE="false",
                WORKER_INDEX="0",
                PYTHONUNBUFFERED="1",
            )
            process = subprocess.Popen(
                [sys.executable, "-c", CHILD, f"127.0.0.1:{port}", directory],
                cwd=AGENTS,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            try:
                try:
                    output, _ = process.communicate(timeout=18)
                except subprocess.TimeoutExpired:
                    process.kill()
                    output, _ = process.communicate()
                    # Only allowlisted lifecycle facts can enter failure output.
                    pytest.fail(
                        json.dumps(
                            {
                                "process_hung": True,
                                "worker_drained": (root / "worker-drained").exists(),
                                "worker_stopped_logged": b"Worker stopped" in output,
                                "entrypoint_returned": b"WORKER_ENTRYPOINT_RETURNED" in output,
                                "rpc_finished": rpc_finished.is_set(),
                            }
                        )
                    )
                assert process.returncode == 0, "Worker startup/shutdown failed before process-exit assertion"
                assert b"WORKER_ENTRYPOINT_RETURNED" in output
                assert observations.get("worker_drained") is True
                assert rpc_finished.wait(10)
                if outcome != "deadline":
                    assert (
                        observations["entrypoint_returned_before_first_response"] is False
                    ), "Worker entry point returned while its native metrics RPC was unfinished"
                expected_calls = ["count"] if phase == "count" else ["count", "describe"]
                assert calls == expected_calls, "Shutdown started another metrics RPC after worker drain"
                assert 0 < observations["rpc_deadline_seconds"] <= 5.1
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                server.stop(0).wait()
