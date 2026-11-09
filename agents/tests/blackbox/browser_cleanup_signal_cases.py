"""Actual pinned Temporal signal retries against an isolated loopback gRPC service."""

import asyncio
import json
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import patch

import grpc
from temporalio import activity
from temporalio.api.workflowservice.v1 import (
    GetSystemInfoResponse,
    SignalWorkflowExecutionRequest,
    SignalWorkflowExecutionResponse,
)
from temporalio.client import Client

from _test_utils import BlackboxResult
from domains.spawn_browser_agent_v3.service_activity_queue import acknowledge_browser_activity_cleanup


@asynccontextmanager
async def signal_service(mode):
    calls = []
    entered = asyncio.Event()
    stopped = asyncio.Event()
    from workflows.agent_workflow import AgentWorkflow

    owner = AgentWorkflow()
    owner.max_iterations, owner.context_gates = None, {}
    owner._browser_activity_cleanup_unknown = True
    owner._browser_activity_cleanup_receipt = {
        "run_id": "original-run",
        "activity_id": "browser-cleanup:attempt-1",
        "completed": False,
    }

    async def system_info(request, context):
        return GetSystemInfoResponse().SerializeToString()

    async def signal(request, context):
        parsed = SignalWorkflowExecutionRequest.FromString(request)
        calls.append(
            {
                "request_id": parsed.request_id,
                "workflow_id": parsed.workflow_execution.workflow_id,
                "workflow_run_id": parsed.workflow_execution.run_id,
                "signal_name": parsed.signal_name,
                "payload": json.loads(parsed.input.payloads[0].data),
                "remaining": context.time_remaining(),
                "at": time.monotonic(),
            }
        )
        entered.set()
        try:
            if mode == "cancel":
                await asyncio.Event().wait()
            if mode == "transient" and len(calls) <= 2:
                await context.abort(grpc.StatusCode.UNAVAILABLE, "controlled transient delivery failure")
            if mode == "exhausted":
                await context.abort(grpc.StatusCode.UNAVAILABLE, "controlled exhausted delivery failure")
            if mode == "permanent":
                await context.abort(grpc.StatusCode.PERMISSION_DENIED, "controlled permanent delivery failure")
            owner.browser_activity_cleanup_complete(calls[-1]["payload"])
            return SignalWorkflowExecutionResponse().SerializeToString()
        finally:
            if mode == "cancel":
                stopped.set()

    server = grpc.aio.server()
    server.add_generic_rpc_handlers(
        (
            grpc.method_handlers_generic_handler(
                "temporal.api.workflowservice.v1.WorkflowService",
                {
                    "GetSystemInfo": grpc.unary_unary_rpc_method_handler(system_info),
                    "SignalWorkflowExecution": grpc.unary_unary_rpc_method_handler(signal),
                },
            ),
        )
    )
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    client = await Client.connect(f"127.0.0.1:{port}", namespace="local-cleanup-test", lazy=True)
    info = SimpleNamespace(
        workflow_id="cleanup-owner", workflow_run_id="original-run", activity_id="browser-cleanup:attempt-1"
    )
    try:
        with (
            patch.object(activity, "in_activity", return_value=True),
            patch.object(activity, "info", return_value=info),
            patch.object(activity, "client", return_value=client),
        ):
            yield calls, entered, stopped, owner
    finally:
        await server.stop(None)
        await server.wait_for_termination()


def assert_identity(calls):
    assert calls
    assert len({call["request_id"] for call in calls}) == 1, "retry changed the signal request identity"
    for call in calls:
        assert call["workflow_id"] == "cleanup-owner" and call["workflow_run_id"] == ""
        assert call["signal_name"] == "browser_activity_cleanup_complete"
        assert call["payload"] == {"run_id": "original-run", "activity_id": "browser-cleanup:attempt-1"}
        assert 0 < call["remaining"] <= 10, "signal RPC escaped its existing 10s budget"


def assert_fence_persists(owner):
    from workflows.agent_workflow import AgentWorkflow

    assert owner._browser_activity_cleanup_unknown
    assert owner._browser_activity_cleanup_receipt["completed"] is False
    restored = AgentWorkflow()
    restored._restore_deployment_state(owner._continuation_resume_state())
    assert restored._browser_activity_cleanup_unknown
    assert restored._browser_activity_cleanup_receipt == owner._browser_activity_cleanup_receipt


async def test_native_signal_retries_transient_delivery_with_same_identity():
    async with signal_service("transient") as (calls, _, _, owner):
        await acknowledge_browser_activity_cleanup()
        assert len(calls) == 3, "native retry did not recover two transient failures"
        assert not owner._browser_activity_cleanup_unknown
        assert owner._browser_activity_cleanup_receipt["completed"] is True
        assert_identity(calls)
        print("NATIVE_SIGNAL_TRANSIENT", len(calls), [round(call["remaining"], 3) for call in calls])


async def test_native_signal_exhaustion_preserves_original_browser_error():
    original = RuntimeError("original browser failure")
    async with signal_service("exhausted") as (calls, _, _, owner):
        started = time.monotonic()
        try:
            try:
                raise original
            finally:
                await acknowledge_browser_activity_cleanup()
        except RuntimeError as error:
            assert error is original, "signal exhaustion replaced the original browser error"
        else:
            raise AssertionError("original browser failure disappeared")
        assert len(calls) > 1 and time.monotonic() - started < 12
        assert_fence_persists(owner)
        assert_identity(calls)
        print("NATIVE_SIGNAL_EXHAUSTED", len(calls), round(time.monotonic() - started, 3))


async def test_native_signal_cancellation_keeps_cancellation():
    async with signal_service("cancel") as (calls, entered, stopped, owner):
        task = asyncio.create_task(acknowledge_browser_activity_cleanup())
        await entered.wait()
        task.cancel("original cleanup cancellation")
        try:
            await task
        except asyncio.CancelledError as error:
            assert error.args == ("original cleanup cancellation",)
        else:
            raise AssertionError("cleanup signal swallowed cancellation")
        await asyncio.wait_for(stopped.wait(), timeout=10)
        assert_identity(calls)
        assert len(calls) == 1, "cancelled delivery started a new retry"
        assert_fence_persists(owner)


async def test_native_signal_permanent_failure_preserves_browser_outcome():
    outcome = {"status": "failed", "message": "original browser timeout", "browser_cleanup": "unconfirmed"}
    async with signal_service("permanent") as (calls, _, _, owner):

        async def cleanup_then_return():
            try:
                return outcome
            finally:
                await acknowledge_browser_activity_cleanup()

        assert await cleanup_then_return() is outcome
        assert len(calls) == 1, "permanent delivery failure was retried"
        assert_fence_persists(owner)
        assert_identity(calls)


async def run_all_tests():
    results = BlackboxResult()
    for name, check in (
        ("native_signal_transient_retry", test_native_signal_retries_transient_delivery_with_same_identity),
        ("native_signal_exhaustion", test_native_signal_exhaustion_preserves_original_browser_error),
        ("native_signal_cancellation", test_native_signal_cancellation_keeps_cancellation),
        ("native_signal_permanent_failure", test_native_signal_permanent_failure_preserves_browser_outcome),
    ):
        await results.record_async(name, check)
    return results.summary()


if __name__ == "__main__":
    result = asyncio.run(run_all_tests())
    raise SystemExit(bool(result["failed"]))
