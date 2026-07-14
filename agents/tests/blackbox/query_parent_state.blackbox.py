"""Blackbox tests for query-parent-state domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


async def test_set_temporal_client():
    """set_temporal_client stores the client in module state."""
    from helpers.query_parent_state import set_temporal_client, _temporal_client

    # Initially may be None or set from a previous test
    sentinel = object()
    set_temporal_client(sentinel)

    # Re-import to check updated module state
    import helpers.query_parent_state as mod
    assert mod._temporal_client is sentinel

    # Clean up - reset to None
    set_temporal_client(None)


async def test_activity_returns_empty_without_client():
    """query_parent_state_activity returns empty dict when no Temporal client is set."""
    from helpers.query_parent_state import set_temporal_client, query_parent_state_activity

    # Ensure no client is set
    set_temporal_client(None)

    # The activity should not raise, just return empty dict
    result = await query_parent_state_activity(parent_workflow_id="wf-nonexistent-123")

    assert result == {}


async def test_no_outbound_http_calls():
    """query_parent_state_activity makes zero outbound HTTP calls."""
    from helpers.query_parent_state import set_temporal_client, query_parent_state_activity

    set_temporal_client(None)

    await query_parent_state_activity(parent_workflow_id="wf-test-456")

    # This activity uses Temporal client (gRPC), not httpx
    assert len(get_captured_requests()) == 0


async def _run_activity_with_fake_handle(handle):
    """Run query_parent_state_activity against a fake Temporal handle."""
    from helpers.query_parent_state import set_temporal_client, query_parent_state_activity

    class _FakeClient:
        def get_workflow_handle(self, workflow_id):
            return handle

    set_temporal_client(_FakeClient())
    try:
        return await query_parent_state_activity(parent_workflow_id="parent-wf")
    finally:
        set_temporal_client(None)


async def test_activity_query_success_returns_state():
    """Live, queryable parent → its state is returned (no describe needed)."""

    class _Handle:
        async def query(self, name):
            return {"is_paused": True, "is_cost_limit_reached": False}

        async def describe(self):
            raise AssertionError("describe must not be called when query succeeds")

    result = await _run_activity_with_fake_handle(_Handle())
    assert result == {"is_paused": True, "is_cost_limit_reached": False}


async def test_activity_parent_terminated_returns_missing():
    """Query fails + describe shows a terminal status → parent_missing (orphan)."""
    from temporalio.client import WorkflowExecutionStatus

    class _Desc:
        status = WorkflowExecutionStatus.TERMINATED

    class _Handle:
        async def query(self, name):
            raise RuntimeError("query rejected — workflow closed")

        async def describe(self):
            return _Desc()

    result = await _run_activity_with_fake_handle(_Handle())
    assert result == {"parent_missing": True}


async def test_activity_parent_not_found_returns_missing():
    """Query fails + describe raises NOT_FOUND → parent_missing (orphan)."""
    from temporalio.service import RPCError, RPCStatusCode

    class _Handle:
        async def query(self, name):
            raise RuntimeError("query failed")

        async def describe(self):
            raise RPCError("not found", RPCStatusCode.NOT_FOUND, b"")

    result = await _run_activity_with_fake_handle(_Handle())
    assert result == {"parent_missing": True}


async def test_activity_transient_failure_returns_empty():
    """Query fails but parent is still RUNNING → transient, return {} (keep waiting)."""
    from temporalio.client import WorkflowExecutionStatus

    class _Desc:
        status = WorkflowExecutionStatus.RUNNING

    class _Handle:
        async def query(self, name):
            raise RuntimeError("connection reset")

        async def describe(self):
            return _Desc()

    result = await _run_activity_with_fake_handle(_Handle())
    assert result == {}


async def run_all_tests():
    print("query-parent-state blackbox tests:")
    r = BlackboxResult()
    await r.record_async("set_temporal_client", test_set_temporal_client)
    await r.record_async("activity_returns_empty_without_client", test_activity_returns_empty_without_client)
    await r.record_async("no_outbound_http_calls", test_no_outbound_http_calls)
    await r.record_async("activity_query_success_returns_state", test_activity_query_success_returns_state)
    await r.record_async("activity_parent_terminated_returns_missing", test_activity_parent_terminated_returns_missing)
    await r.record_async("activity_parent_not_found_returns_missing", test_activity_parent_not_found_returns_missing)
    await r.record_async("activity_transient_failure_returns_empty", test_activity_transient_failure_returns_empty)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
