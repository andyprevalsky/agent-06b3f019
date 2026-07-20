"""Blackbox tests for the gate domain kill-switch.

Cements the "disable all gates except purchase gates" behavior: connection gates
(`source_connect`, e.g. "connect your Gmail") are suppressed to a non-blocking
no-op while purchase gates (`subscription`/`kyc`/`approval`) always block. The
kill-switch is off (gates suppressed) by default and re-enabled with
NON_PURCHASE_GATES_ENABLED=1.
"""

import asyncio
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from _test_utils import BlackboxResult


def _reload_service():
    """Import the gate service fresh so the env flag is read at call time."""
    from domains.gate import service

    return service


def _clear_flag():
    os.environ.pop("NON_PURCHASE_GATES_ENABLED", None)


async def test_suppress_defaults_off():
    """By default only source_connect (non-purchase) is suppressed; purchases stay."""
    service = _reload_service()
    _clear_flag()
    # Non-purchase connection gate → suppressed.
    assert service._should_suppress_gate("source_connect") is True
    # Purchase gates → always live.
    assert service._should_suppress_gate("subscription") is False
    assert service._should_suppress_gate("kyc") is False
    assert service._should_suppress_gate("approval") is False


async def test_flag_reenables_all_gates():
    """NON_PURCHASE_GATES_ENABLED=1 restores connection gates."""
    service = _reload_service()
    for truthy in ("1", "true", "YES", "on"):
        os.environ["NON_PURCHASE_GATES_ENABLED"] = truthy
        assert service._should_suppress_gate("source_connect") is False, truthy
        assert service._should_suppress_gate("subscription") is False, truthy
    _clear_flag()


async def test_source_connect_gate_is_noop():
    """raise_gate_direct on a source_connect gate returns "" and never touches Temporal."""
    service = _reload_service()
    _clear_flag()

    # A tripwire workflow module: any workflow.* call fails the test, proving the
    # suppressed path short-circuits before parking the workflow.
    tripwire = SimpleNamespace(
        info=lambda: (_ for _ in ()).throw(AssertionError("workflow.info reached")),
        execute_activity=AsyncMock(side_effect=AssertionError("execute_activity reached")),
        wait_condition=AsyncMock(side_effect=AssertionError("wait_condition reached")),
    )
    wf_instance = SimpleNamespace(user_id="u", agent_id="a", _signal_responses={})

    gate = service.build_source_connect_gate(
        "gmail", "Connect Gmail", "needs your email", "https://roselabs.ai/connect/gmail"
    )
    with patch.object(service, "workflow", tripwire):
        result = await service.raise_gate_direct(wf_instance, gate, gate_key="source_connect:gmail")
    assert result == ""
    tripwire.execute_activity.assert_not_awaited()


async def test_subscription_gate_still_blocks():
    """raise_gate_direct on a subscription gate proceeds past the guard to Temporal."""
    service = _reload_service()
    _clear_flag()

    request_id = "req-sub-1"
    fake_wf = SimpleNamespace(
        info=lambda: SimpleNamespace(workflow_id="wf-1"),
        execute_activity=AsyncMock(return_value=request_id),
        # Condition is already satisfiable — resolve immediately without looping.
        wait_condition=AsyncMock(return_value=None),
    )
    wf_instance = SimpleNamespace(
        user_id="u",
        agent_id="a",
        _signal_responses={request_id: "resolved"},
        _handle_tool_event=AsyncMock(),
    )

    gate = service.build_subscription_gate(checkout_url="https://roselabs.ai/s/x")
    with patch.object(service, "workflow", fake_wf):
        result = await service.raise_gate_direct(wf_instance, gate, gate_key="subscription")
    # The purchase gate was NOT suppressed: it created the attention request and
    # returned the user's resolution.
    fake_wf.execute_activity.assert_awaited_once()
    assert result == "resolved"


async def run_all_tests():
    print("gate blackbox tests:")
    r = BlackboxResult()
    await r.record_async("suppress_defaults_off", test_suppress_defaults_off)
    await r.record_async("flag_reenables_all_gates", test_flag_reenables_all_gates)
    await r.record_async("source_connect_gate_is_noop", test_source_connect_gate_is_noop)
    await r.record_async("subscription_gate_still_blocks", test_subscription_gate_still_blocks)
    _clear_flag()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
