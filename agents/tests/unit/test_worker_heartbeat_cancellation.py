"""Actual worker cancellation delivery against an isolated strict gRPC service."""
from __future__ import annotations

import argparse
import ast
import inspect
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import traceback

ROOT = Path(__file__).resolve().parents[3]
SERVICE = 'temporal.api.workflowservice.v1.WorkflowService'


def run_native_worker(cancel: bool, output: Path) -> int:
    import grpc
    import temporalio
    from temporalio import activity
    from temporalio.api.common.v1 import ActivityType, WorkflowExecution, WorkflowType
    from temporalio.api.workflowservice.v1 import (
        GetSystemInfoResponse, DescribeNamespaceResponse, PollActivityTaskQueueResponse,
        RecordActivityTaskHeartbeatResponse,
    )
    from temporalio.client import Client
    from temporalio.worker import Worker
    from google.protobuf.timestamp_pb2 import Timestamp
    sys.path.insert(0, str(ROOT / 'agents'))
    from domains.spawn_browser_agent_v3.activity_heartbeat import BrowserActivityHeartbeat
    from domains.spawn_browser_agent_v3.config import HEARTBEAT_KEEPALIVE_SECONDS, HEARTBEAT_TIMEOUT_SECONDS

    options = production_heartbeat_options(HEARTBEAT_KEEPALIVE_SECONDS)
    throttle = options.get(
        "max_heartbeat_throttle_interval",
        inspect.signature(Worker).parameters["max_heartbeat_throttle_interval"].default,
    ).total_seconds()
    start = time.monotonic()
    lock = threading.Lock()
    terminal = threading.Event()
    stopping = threading.Event()
    events = []
    calls = {}
    unexpected = []
    state = {'served': False, 'heartbeats': 0}
    result = {
        'sdk_version': temporalio.__version__, 'python': sys.version.split()[0],
        'pid': os.getpid(), 'cancel': cancel, 'max_throttle_seconds': throttle,
        'baseline_uses_sdk_default': not options,
        'application_cadence_seconds': HEARTBEAT_KEEPALIVE_SECONDS,
        'heartbeat_timeout_seconds': HEARTBEAT_TIMEOUT_SECONDS,
        'scope': 'real native Temporal Worker and actual BrowserActivityHeartbeat; local fake gRPC service only; no workflow/model/provider',
        'events': events, 'rpc_counts': calls, 'unexpected_rpc': unexpected,
    }

    def record(event, **data):
        with lock:
            events.append({'event': event, 'elapsed_s': round(time.monotonic() - start, 6),
                           'utc': datetime.now(timezone.utc).isoformat(), **data})
        output.write_text(json.dumps(result, indent=2) + '\n')

    def system_info(request, context):
        return GetSystemInfoResponse(capabilities=GetSystemInfoResponse.Capabilities(activity_failure_include_heartbeat=True)).SerializeToString()

    def namespace(request, context):
        response = DescribeNamespaceResponse()
        response.namespace_info.name = 'test'
        response.namespace_info.id = 'd6ef970c-83b4-4ed0-8726-4bc7d3b3d13b'
        response.namespace_info.state = 1
        return response.SerializeToString()

    def shutdown(request, context):
        record('shutdown_worker_rpc')
        return b''

    def poll(request, context):
        with lock:
            first = not state['served']
            if first:
                state['served'] = True
        if first:
            record('activity_poll_delivered')
            stamp = Timestamp()
            stamp.GetCurrentTime()
            response = PollActivityTaskQueueResponse(
                task_token=b'owned-native-heartbeat-fixture', workflow_namespace='test',
                workflow_type=WorkflowType(name='FixtureWorkflow'),
                workflow_execution=WorkflowExecution(workflow_id='owned-heartbeat-fixture', run_id='7b5b6541-5ba0-4567-93e1-bc66a5f4a35a'),
                activity_type=ActivityType(name='heartbeat_probe'), activity_id='1',
                scheduled_time=stamp, current_attempt_scheduled_time=stamp, started_time=stamp, attempt=1,
            )
            response.schedule_to_close_timeout.seconds = 180
            response.start_to_close_timeout.seconds = 120
            response.heartbeat_timeout.seconds = HEARTBEAT_TIMEOUT_SECONDS
            return response.SerializeToString()
        # A real cancellable local long poll; no spin or external service.
        until = time.monotonic() + 1
        while context.is_active() and not stopping.is_set() and time.monotonic() < until:
            time.sleep(0.02)
        return b''

    def heartbeat(request, context):
        with lock:
            state['heartbeats'] += 1
            ordinal = state['heartbeats']
        requested = cancel and ordinal > 1
        record('wire_heartbeat_response', ordinal=ordinal, cancel_requested=requested)
        if cancel and ordinal == 1:
            # The first response is non-cancelling. Cancellation becomes pending
            # immediately afterward; only a subsequent wire response delivers it.
            record('service_cancel_armed')
        return RecordActivityTaskHeartbeatResponse(cancel_requested=requested).SerializeToString()

    def completed(request, context):
        record('activity_terminal_rpc', outcome='completed')
        terminal.set()
        return b''

    def cancelled(request, context):
        record('activity_terminal_rpc', outcome='cancelled')
        terminal.set()
        return b''

    def failed(request, context):
        record('activity_terminal_rpc', outcome='failed')
        terminal.set()
        return b''

    handlers = {
        'GetSystemInfo': system_info,
        'DescribeNamespace': namespace,
        'ShutdownWorker': shutdown,
        'PollActivityTaskQueue': poll,
        'RecordActivityTaskHeartbeat': heartbeat,
        'RespondActivityTaskCompleted': completed,
        'RespondActivityTaskCanceled': cancelled,
        'RespondActivityTaskFailed': failed,
    }

    class StrictService(grpc.GenericRpcHandler):
        def service(self, details):
            name = details.method.rsplit('/', 1)[-1]
            with lock:
                calls[name] = calls.get(name, 0) + 1
            handler = handlers.get(name) if details.method == f'/{SERVICE}/{name}' else None
            if handler is None:
                with lock:
                    unexpected.append(details.method)
                record('unexpected_rpc', method=details.method)
                def reject(request, context):
                    context.abort(grpc.StatusCode.UNIMPLEMENTED, 'unexpected fixture RPC')
                handler = reject
            return grpc.unary_unary_rpc_method_handler(handler)

    def application_heartbeat(*_details):
        activity.heartbeat('owned fixture keepalive')
        record('application_heartbeat', thread=threading.current_thread().name)

    pump = BrowserActivityHeartbeat(heartbeat_fn=application_heartbeat)

    @activity.defn(name='heartbeat_probe')
    async def heartbeat_probe():
        record('activity_started')
        token = pump.register()
        try:
            if cancel:
                await asyncio.Event().wait()
            else:
                await asyncio.sleep(0.2)
                record('normal_work_completed', cancelled_latched=activity.is_cancelled())
                return 'normal-success'
        except asyncio.CancelledError:
            record('sdk_cancel_delivered', cancelled_latched=activity.is_cancelled())
            raise
        finally:
            pump.unregister(token)
            record('cleanup_started')
            await asyncio.sleep(0.1)
            record('cleanup_completed', cancelled_latched=activity.is_cancelled())

    executor = ThreadPoolExecutor(max_workers=4)
    server = grpc.server(executor)
    server.add_generic_rpc_handlers((StrictService(),))
    port = server.add_insecure_port('127.0.0.1:0')
    assert port > 0
    server.start()
    record('local_server_started', loopback_port=port)

    async def run():
        client = await asyncio.wait_for(Client.connect(f'127.0.0.1:{port}', namespace='test'), timeout=5)
        worker = Worker(client, task_queue='owned-heartbeat-fixture', activities=[heartbeat_probe],
                        max_concurrent_activities=1, max_concurrent_activity_task_polls=1,
                        graceful_shutdown_timeout=timedelta(seconds=5), **options)
        task = asyncio.create_task(worker.run())
        try:
            deadline = time.monotonic() + 85
            while not terminal.is_set() and not unexpected and not task.done():
                if time.monotonic() >= deadline:
                    raise TimeoutError('activity terminal RPC not observed within 85s fixture bound')
                await asyncio.sleep(0.025)
            if unexpected:
                raise AssertionError(f'unexpected RPC methods: {unexpected}')
            if task.done() and not terminal.is_set():
                await task
                raise AssertionError('worker stopped before activity terminal RPC')
        finally:
            record('worker_shutdown_started')
            stopping.set()
            await asyncio.wait_for(worker.shutdown(), timeout=10)
            await asyncio.wait_for(task, timeout=10)
            record('worker_shutdown_completed')

    rc = 0
    try:
        asyncio.run(run())
        terminal_events = [e for e in events if e['event'] == 'activity_terminal_rpc']
        assert len(terminal_events) == 1, 'missing or duplicate terminal response'
        assert terminal_events[0]['outcome'] == ('cancelled' if cancel else 'completed')
        delivered = [e for e in events if e['event'] == 'sdk_cancel_delivered']
        cleanup = [e for e in events if e['event'] == 'cleanup_completed']
        assert len(cleanup) == 1 and cleanup[0]['elapsed_s'] < terminal_events[0]['elapsed_s']
        assert len(delivered) == int(cancel)
        assert not unexpected
        if cancel:
            armed = next(e for e in events if e['event'] == 'service_cancel_armed')
            latency = delivered[0]['elapsed_s'] - armed['elapsed_s']
            result['cancel_delivery_latency_s'] = latency
            result['cancel_to_cleanup_completed_s'] = cleanup[0]['elapsed_s'] - armed['elapsed_s']
            assert delivered[0]['cancelled_latched'] is True
            assert latency <= HEARTBEAT_KEEPALIVE_SECONDS + 5, (
                f'worker transport delayed user cancellation beyond the application heartbeat cadence: {latency:.3f}s'
            )
        else:
            assert cleanup[0]['cancelled_latched'] is False
            assert any(e['event'] == 'normal_work_completed' for e in events)
        result['status'] = 'passed'
    except BaseException as exc:
        result['status'] = 'failed'
        result['error'] = f'{type(exc).__name__}: {exc}'
        traceback.print_exc()
        rc = 1
    finally:
        pump.shutdown()
        stopping.set()
        server.stop(0).wait(timeout=5)
        executor.shutdown(wait=True, cancel_futures=True)
        record('local_server_stopped')
        output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'case': output.stem, 'status': result.get('status'), 'latency_s': result.get('cancel_delivery_latency_s'), 'rpc_counts': calls}), flush=True)
    return rc


def production_heartbeat_options(keepalive_seconds: int) -> dict:
    """Execute the exact production Worker heartbeat expression, or its SDK default.

    The fixture replaces task input and transport, not heartbeat configuration.
    Omitting the production option must exercise the real native SDK default.
    """
    source = ast.parse((ROOT / "agents/worker.py").read_text())
    calls = [node.value for node in ast.walk(source)
             if isinstance(node, ast.Assign)
             and any(isinstance(target, ast.Name) and target.id == "worker" for target in node.targets)
             and isinstance(node.value, ast.Call)
             and isinstance(node.value.func, ast.Name) and node.value.func.id == "Worker"]
    assert len(calls) == 1, "production worker construction is ambiguous"
    keyword = next((item for item in calls[0].keywords if item.arg == "max_heartbeat_throttle_interval"), None)
    if keyword is None:
        return {}
    expression = ast.Expression(body=keyword.value)
    value = eval(compile(expression, "agents/worker.py", "eval"), {
        "timedelta": timedelta, "HEARTBEAT_KEEPALIVE_SECONDS": keepalive_seconds,
    })
    assert isinstance(value, timedelta) and value.total_seconds() > 0
    return {"max_heartbeat_throttle_interval": value}


def test_worker_delivers_cancellation_at_application_heartbeat_cadence(tmp_path: Path) -> None:
    """The real native worker delivers cancellation and drains cleanup before exit."""
    for mode in ("normal", "cancel"):
        output = tmp_path / f"heartbeat-{mode}.json"
        log_path = tmp_path / f"heartbeat-{mode}.log"
        with log_path.open("wb") as log:
            process = subprocess.Popen(
                [sys.executable, __file__, "--mode", mode, "--output", str(output)],
                cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
            )
            try:
                code = process.wait(timeout=100)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
        assert code == 0, log_path.read_text()
        report = json.loads(output.read_text())
        assert report["status"] == "passed"
        assert not report["unexpected_rpc"]
        assert report["events"][-1]["event"] == "local_server_stopped"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["normal", "cancel"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    raise SystemExit(run_native_worker(arguments.mode == "cancel", arguments.output))
