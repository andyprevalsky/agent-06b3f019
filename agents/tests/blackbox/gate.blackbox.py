"""Blackbox tests for the gate domain kill-switch.

Cements "disable all gates except purchase gates": only the explicitly
allowlisted connection gate (`source_connect`, e.g. "connect your Gmail") is
suppressed to a non-blocking no-op; purchase gates (`subscription`/`kyc`/
`approval`) and any unrecognized type always block (fail-closed). The switch is
off (suppressible gates suppressed) by default and re-enabled with
NON_PURCHASE_GATES_ENABLED=1.

The env flag is read in ACTIVITY scope (`create_gate_request_activity`), which
returns GATE_SUPPRESSED_SENTINEL; `raise_gate_direct` branches on that recorded
activity result so the workflow stays deterministic on replay.
"""

import asyncio
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from _test_utils import BlackboxResult


def _clear_flag():
    os.environ.pop("NON_PURCHASE_GATES_ENABLED", None)


async def test_suppressible_allowlist_defaults_off():
    """Only source_connect is suppressible; purchase + unknown types fail-closed."""
    from domains.gate.config import gate_is_suppressed

    _clear_flag()
    assert gate_is_suppressed("source_connect") is True
    # Purchase gates always block.
    assert gate_is_suppressed("subscription") is False
    assert gate_is_suppressed("kyc") is False
    assert gate_is_suppressed("approval") is False
    # Unknown / misspelled / missing types fail closed (block).
    assert gate_is_suppressed("sorce_conect") is False
    assert gate_is_suppressed("") is False


async def test_flag_reenables_suppressible():
    """NON_PURCHASE_GATES_ENABLED=1 restores the connection gate."""
    from domains.gate.config import gate_is_suppressed

    for truthy in ("1", "true", "YES", "on"):
        os.environ["NON_PURCHASE_GATES_ENABLED"] = truthy
        assert gate_is_suppressed("source_connect") is False, truthy
    _clear_flag()


async def test_kyc_gate_uses_canonical_detection_contract():
    """KYC gates use the public gate method; provider details stay in probeKey."""
    from domains.gate import service

    gate = service.build_kyc_gate()

    assert gate["type"] == "kyc"
    assert gate["gateKey"] == "kyc"
    assert gate["detection"] == {
        "method": "kyc_webhook",
        "probeKey": "customers_needed_kyc",
    }


async def test_activity_suppresses_source_connect_without_network():
    """The activity short-circuits a suppressed gate to the sentinel, no HTTP."""
    from domains.gate import repo
    from domains.gate.config import GATE_SUPPRESSED_SENTINEL

    _clear_flag()
    # Any HTTP attempt is a bug on the suppressed path.
    tripwire = SimpleNamespace(AsyncClient=lambda *a, **k: (_ for _ in ()).throw(AssertionError("HTTP attempted")))
    gate = {"type": "source_connect", "gateKey": "source_connect:gmail"}
    with patch.object(repo, "httpx", tripwire):
        result = await repo.create_gate_request_activity("u", "a", "wf", "Connect Gmail", gate, "source_connect:gmail")
    assert result == GATE_SUPPRESSED_SENTINEL


async def test_raise_gate_direct_noop_on_sentinel():
    """raise_gate_direct returns "" and never parks when the activity suppressed."""
    from domains.gate import service
    from domains.gate.config import GATE_SUPPRESSED_SENTINEL

    fake_wf = SimpleNamespace(
        info=lambda: SimpleNamespace(workflow_id="wf-1"),
        execute_activity=AsyncMock(return_value=GATE_SUPPRESSED_SENTINEL),
        wait_condition=AsyncMock(side_effect=AssertionError("workflow parked on suppressed gate")),
    )
    wf_instance = SimpleNamespace(
        user_id="u",
        agent_id="a",
        _signal_responses={},
        _handle_tool_event=AsyncMock(side_effect=AssertionError("close event emitted")),
    )
    gate = service.build_source_connect_gate("gmail", "t", "r", "https://x")
    with patch.object(service, "workflow", fake_wf):
        result = await service.raise_gate_direct(wf_instance, gate, gate_key="source_connect:gmail")
    assert result == ""
    fake_wf.execute_activity.assert_awaited_once()


async def test_raise_gate_direct_blocks_on_real_request():
    """A real request id (purchase gate) parks the workflow and returns the resolution."""
    from domains.gate import service

    request_id = "req-sub-1"
    fake_wf = SimpleNamespace(
        info=lambda: SimpleNamespace(workflow_id="wf-1"),
        execute_activity=AsyncMock(return_value=request_id),
        wait_condition=AsyncMock(return_value=None),  # condition already satisfiable
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
    fake_wf.execute_activity.assert_awaited_once()
    wf_instance._handle_tool_event.assert_awaited_once()  # gate card closed
    assert result == "resolved"


async def run_all_tests():
    print("gate blackbox tests:")
    r = BlackboxResult()
    await r.record_async("suppressible_allowlist_defaults_off", test_suppressible_allowlist_defaults_off)
    await r.record_async("flag_reenables_suppressible", test_flag_reenables_suppressible)
    await r.record_async("kyc_gate_uses_canonical_detection_contract", test_kyc_gate_uses_canonical_detection_contract)
    await r.record_async("activity_suppresses_source_connect", test_activity_suppresses_source_connect_without_network)
    await r.record_async("raise_gate_direct_noop_on_sentinel", test_raise_gate_direct_noop_on_sentinel)
    await r.record_async("raise_gate_direct_blocks_on_real_request", test_raise_gate_direct_blocks_on_real_request)
    _clear_flag()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
