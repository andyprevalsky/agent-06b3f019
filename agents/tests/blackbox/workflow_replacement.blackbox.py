"""Blackbox tests for workflow replacement bootstrap acknowledgement."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx

from _test_utils import BlackboxResult, assert_captured_call, get_captured_requests, setup_mock, teardown_mock


async def test_acknowledgement_uses_candidate_generation():
    setup_mock(
        {
            "/workflow-replacement/bootstrap-ack": {
                "status": 200,
                "json": {"acknowledged": True, "already_acknowledged": False},
            }
        }
    )
    with patch(
        "temporalio.activity.info",
        return_value=SimpleNamespace(workflow_id="agent-1:replacement:candidate-2"),
    ):
        from helpers.workflow_replacement import acknowledge_workflow_replacement_bootstrap

        result = await acknowledge_workflow_replacement_bootstrap("agent-1")

    call = assert_captured_call(
        url_contains="/api/agents/agent-1/workflow-replacement/bootstrap-ack",
        method="POST",
        header_present="X-API-Key",
    )
    assert call["requestHeaders"]["x-agent-workflow-generation"] == "agent-1:replacement:candidate-2"
    assert result == {"acknowledged": True, "already_acknowledged": False}


async def test_acknowledgement_requires_temporal_generation():
    from helpers.workflow_replacement import acknowledge_workflow_replacement_bootstrap

    with patch("temporalio.activity.info", side_effect=RuntimeError("outside activity")):
        try:
            await acknowledge_workflow_replacement_bootstrap("agent-1")
            raise AssertionError("missing candidate generation must fail closed")
        except RuntimeError as exc:
            assert "requires a Temporal workflow generation" in str(exc)
    assert get_captured_requests() == []


async def test_stale_candidate_cannot_acknowledge():
    setup_mock(
        {
            "/workflow-replacement/bootstrap-ack": {
                "status": 409,
                "json": {"error": "Workflow generation is no longer current"},
            }
        }
    )
    with patch(
        "temporalio.activity.info",
        return_value=SimpleNamespace(workflow_id="agent-1:replacement:stale"),
    ):
        from helpers.workflow_replacement import acknowledge_workflow_replacement_bootstrap

        try:
            await acknowledge_workflow_replacement_bootstrap("agent-1")
            raise AssertionError("stale generation must not continue")
        except httpx.HTTPStatusError as exc:
            assert exc.response.status_code == 409


async def test_finalize_persists_restored_state_before_acknowledgement():
    setup_mock(
        {
            "/workflow-replacement/bootstrap-ack": {
                "status": 200,
                "json": {"acknowledged": True, "already_acknowledged": False},
            }
        }
    )
    persist = AsyncMock()
    with (
        patch(
            "temporalio.activity.info",
            return_value=SimpleNamespace(workflow_id="agent-1:replacement:candidate-2"),
        ),
        patch("helpers.workflow_replacement._update_agent_status_impl", persist),
    ):
        from helpers.workflow_replacement import finalize_workflow_replacement_bootstrap

        result = await finalize_workflow_replacement_bootstrap(
            "agent-1",
            "COST_LIMIT_REACHED",
            0.6,
            "Waiting for a higher cost limit",
            123,
            456,
            7,
            80,
            43,
            12,
        )

    persist.assert_awaited_once_with(
        agent_id="agent-1",
        status="COST_LIMIT_REACHED",
        progress=0.6,
        status_message="Waiting for a higher cost limit",
        token_count=123,
        context_size=456,
        message_count=7,
        tokens_in=80,
        tokens_out=43,
        iteration_offset=12,
    )
    assert len(get_captured_requests()) == 1
    assert result["acknowledged"] is True


async def test_finalize_never_acknowledges_when_state_persistence_fails():
    setup_mock({})
    persist = AsyncMock(side_effect=RuntimeError("durable status write failed"))
    with (
        patch(
            "temporalio.activity.info",
            return_value=SimpleNamespace(workflow_id="agent-1:replacement:candidate-2"),
        ),
        patch("helpers.workflow_replacement._update_agent_status_impl", persist),
    ):
        from helpers.workflow_replacement import finalize_workflow_replacement_bootstrap

        try:
            await finalize_workflow_replacement_bootstrap(
                "agent-1",
                "ACTIVE",
                0.6,
                "Resumed",
                123,
                456,
                7,
                80,
                43,
                12,
            )
            raise AssertionError("failed state persistence must fail bootstrap")
        except RuntimeError as exc:
            assert "durable status write failed" in str(exc)
    assert get_captured_requests() == []


async def run_all_tests():
    print("workflow-replacement blackbox tests:")
    r = BlackboxResult()
    await r.record_async("candidate_generation", test_acknowledgement_uses_candidate_generation)
    await r.record_async("generation_required", test_acknowledgement_requires_temporal_generation)
    await r.record_async("stale_candidate_rejected", test_stale_candidate_cannot_acknowledge)
    await r.record_async("state_before_ack", test_finalize_persists_restored_state_before_acknowledgement)
    await r.record_async("state_failure_blocks_ack", test_finalize_never_acknowledges_when_state_persistence_fails)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
