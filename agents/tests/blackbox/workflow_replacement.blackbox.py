"""Blackbox tests for workflow replacement bootstrap acknowledgement."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch

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
                "json": {
                    "acknowledged": True,
                    "already_acknowledged": False,
                    "status": "COST_LIMIT_REACHED",
                },
            }
        }
    )
    with patch(
        "temporalio.activity.info",
        return_value=SimpleNamespace(workflow_id="agent-1:replacement:candidate-2"),
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

    request = get_captured_requests()[0]
    body = json.loads(request["requestBody"])
    assert body == {
        "status": "COST_LIMIT_REACHED",
        "progress": 0.6,
        "statusMessage": "Waiting for a higher cost limit",
        "tokenCount": 123,
        "contextSize": 456,
        "messageCount": 7,
        "tokensIn": 80,
        "tokensOut": 43,
        "iterationOffset": 12,
    }
    assert result["acknowledged"] is True


async def test_finalize_never_acknowledges_when_state_persistence_fails():
    setup_mock(
        {
            "/workflow-replacement/bootstrap-ack": {
                "status": 500,
                "json": {"error": "durable finalize failed"},
            }
        }
    )
    with patch(
        "temporalio.activity.info",
        return_value=SimpleNamespace(workflow_id="agent-1:replacement:candidate-2"),
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
        except httpx.HTTPStatusError:
            pass
    assert len(get_captured_requests()) == 1


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
