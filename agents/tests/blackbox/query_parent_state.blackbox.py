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


async def run_all_tests():
    print("query-parent-state blackbox tests:")
    r = BlackboxResult()
    await r.record_async("set_temporal_client", test_set_temporal_client)
    await r.record_async("activity_returns_empty_without_client", test_activity_returns_empty_without_client)
    await r.record_async("no_outbound_http_calls", test_no_outbound_http_calls)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
