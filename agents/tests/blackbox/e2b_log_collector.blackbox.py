"""Blackbox tests for e2b_log_collector domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    setup_mock,
    teardown_mock,
    assert_captured_call,
    setup_mock_fn,
)


def test_init_state():
    """SandboxLogCollector initializes with correct attributes."""
    from helpers.e2b_log_collector import SandboxLogCollector

    collector = SandboxLogCollector(
        sandbox_id="sb-1",
        agent_id="agent-1",
        task_id="task-1",
    )

    assert collector.sandbox_id == "sb-1"
    assert collector.agent_id == "agent-1"
    assert collector.task_id == "task-1"
    assert collector.process is None
    assert collector._stopped is False


async def test_stop_before_start():
    """Calling stop() without start() does not raise."""
    from helpers.e2b_log_collector import SandboxLogCollector

    collector = SandboxLogCollector(
        sandbox_id="sb-2",
        agent_id="agent-2",
        task_id="task-2",
    )

    await collector.stop()

    # Should have set _stopped = True without error
    assert collector._stopped is True


async def test_no_outbound_http():
    """Creating and stopping the collector makes zero HTTP calls."""
    from helpers.e2b_log_collector import SandboxLogCollector

    collector = SandboxLogCollector(
        sandbox_id="sb-3",
        agent_id="agent-3",
        task_id="task-3",
    )

    await collector.stop()

    captures = get_captured_requests()
    assert len(captures) == 0, f"Expected 0 HTTP calls, got {len(captures)}"


async def run_all_tests():
    print("e2b-log-collector blackbox tests:")
    r = BlackboxResult()
    r.record("init_state", test_init_state)
    await r.record_async("stop_before_start", test_stop_before_start)
    await r.record_async("no_outbound_http", test_no_outbound_http)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
