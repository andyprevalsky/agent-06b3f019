"""The real worker entry point must finish native RPCs before interpreter exit."""

from concurrent.futures import ThreadPoolExecutor
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


CHILD = r"""
import asyncio
import asyncio.selector_events as selector_events
import os
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch
import worker

address, directory = sys.argv[1:]
directory = Path(directory)

# A starved SDK completion thread wakes the loop, then stays descheduled inside
# Python while the loop consumes its result and the worker returns.
main_thread_id = threading.get_ident()
write_to_self = selector_events.BaseSelectorEventLoop._write_to_self

def descheduled_after_wakeup(self):
    write_to_self(self)
    if threading.get_ident() != main_thread_id:
        time.sleep(0.5)

selector_events.BaseSelectorEventLoop._write_to_self = descheduled_after_wakeup
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

async def run_worker():
    await worker.main()
    started = {thread.ident for thread in threading.enumerate()}
    native = [ident for ident in sys._current_frames() if ident not in started]
    print(f"NATIVE_THREADS_IN_PYTHON_AT_RETURN={len(native)}", flush=True)

with (
    patch.object(worker, "load_config", return_value=config),
    patch.object(worker, "Worker", IdleWorker),
    patch.object(worker, "SDK_METRICS_PORT", 0),
    patch.object(worker, "set_worker_status", side_effect=publish_status),
):
    asyncio.run(run_worker())
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
                assert b"NATIVE_THREADS_IN_PYTHON_AT_RETURN=0" in output, (
                    "Worker entry point returned while an SDK completion thread was still running Python"
                )
                assert observations.get("worker_drained") is True
                assert rpc_finished.wait(10)
                if outcome != "deadline":
                    assert observations["entrypoint_returned_before_first_response"] is False, (
                        "Worker entry point returned while its native metrics RPC was unfinished"
                    )
                expected_calls = ["count"] if phase == "count" else ["count", "describe"]
                assert calls == expected_calls, "Shutdown started another metrics RPC after worker drain"
                assert 0 < observations["rpc_deadline_seconds"] <= 5.1
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                server.stop(0).wait()
