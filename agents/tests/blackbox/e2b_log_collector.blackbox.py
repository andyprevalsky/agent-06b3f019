"""Blackbox tests for e2b_log_collector domain."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

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


async def test_start_cli_missing_returns_false():
    """If e2b CLI is not found, start() returns False."""
    from helpers.e2b_log_collector import SandboxLogCollector

    async def fake_create_subprocess_exec(*args, **kwargs):
        raise FileNotFoundError("e2b not installed")

    collector = SandboxLogCollector(sandbox_id="sb-1", agent_id="a-1", task_id="t-1")
    with patch("asyncio.create_subprocess_exec", fake_create_subprocess_exec):
        result = await collector.start()
    assert result is False


async def test_start_generic_error_returns_false():
    """If subprocess creation fails generically, start() returns False."""
    from helpers.e2b_log_collector import SandboxLogCollector

    async def fake_create_subprocess_exec(*args, **kwargs):
        raise RuntimeError("some error")

    collector = SandboxLogCollector(sandbox_id="sb-1", agent_id="a-1", task_id="t-1")
    with patch("asyncio.create_subprocess_exec", fake_create_subprocess_exec):
        result = await collector.start()
    assert result is False


async def test_start_success_and_read_logs():
    """start() returns True when subprocess launches successfully; _read_logs processes lines."""
    from helpers.e2b_log_collector import SandboxLogCollector

    # Simulate a process with stdout that yields a few lines then EOF
    lines = [b"line 1\n", b"line 2\n", b""]  # empty = EOF

    class FakeStdout:
        async def readline(self):
            return lines.pop(0) if lines else b""

    fake_process = MagicMock()
    fake_process.stdout = FakeStdout()
    fake_process.terminate = MagicMock()
    fake_process.kill = MagicMock()

    async def fake_wait():
        return 0
    fake_process.wait = fake_wait

    async def fake_create_subprocess_exec(*args, **kwargs):
        return fake_process

    collector = SandboxLogCollector(sandbox_id="sb-1", agent_id="a-1", task_id="t-1")
    with patch("asyncio.create_subprocess_exec", fake_create_subprocess_exec):
        ok = await collector.start()
    assert ok is True
    assert collector.process is fake_process

    # Let reader task run to completion
    if collector._reader_task:
        try:
            await asyncio.wait_for(collector._reader_task, timeout=1.0)
        except asyncio.TimeoutError:
            collector._reader_task.cancel()

    # Stop should cleanly terminate
    await collector.stop()
    assert collector._stopped is True


async def test_stop_times_out_and_kills():
    """If terminate() doesn't finish in time, stop() falls back to kill()."""
    from helpers.e2b_log_collector import SandboxLogCollector

    fake_process = MagicMock()
    fake_process.terminate = MagicMock()
    fake_process.kill = MagicMock()

    wait_calls = [0]

    async def fake_wait():
        # Returns immediately, we just count calls to verify kill path
        wait_calls[0] += 1
        return 0
    fake_process.wait = fake_wait

    async def fake_wait_for(coro, timeout):
        # Close the pending coroutine to avoid "never awaited" warnings
        coro.close()
        raise asyncio.TimeoutError()

    collector = SandboxLogCollector(sandbox_id="sb-1", agent_id="a-1", task_id="t-1")
    collector.process = fake_process

    with patch("asyncio.wait_for", fake_wait_for):
        await collector.stop()

    fake_process.terminate.assert_called_once()
    fake_process.kill.assert_called_once()
    assert collector._stopped is True


async def test_read_logs_returns_early_when_no_process():
    """_read_logs returns without error when self.process is None."""
    from helpers.e2b_log_collector import SandboxLogCollector
    collector = SandboxLogCollector(sandbox_id="sb", agent_id="a", task_id="t")
    # Should return immediately without raising
    await collector._read_logs()


async def test_read_logs_handles_reader_exception():
    """_read_logs logs a warning when readline raises (non-cancelled path)."""
    from helpers.e2b_log_collector import SandboxLogCollector

    class FakeStdoutRaises:
        async def readline(self):
            raise OSError("pipe broken")

    fake_process = MagicMock()
    fake_process.stdout = FakeStdoutRaises()

    collector = SandboxLogCollector(sandbox_id="sb", agent_id="a", task_id="t")
    collector.process = fake_process
    # Should not raise
    await collector._read_logs()


async def run_all_tests():
    print("e2b-log-collector blackbox tests:")
    r = BlackboxResult()
    r.record("init_state", test_init_state)
    await r.record_async("stop_before_start", test_stop_before_start)
    await r.record_async("no_outbound_http", test_no_outbound_http)
    await r.record_async("start_cli_missing_returns_false", test_start_cli_missing_returns_false)
    await r.record_async("start_generic_error_returns_false", test_start_generic_error_returns_false)
    await r.record_async("start_success_and_read_logs", test_start_success_and_read_logs)
    await r.record_async("stop_times_out_and_kills", test_stop_times_out_and_kills)
    await r.record_async("read_logs_no_process", test_read_logs_returns_early_when_no_process)
    await r.record_async("read_logs_exception", test_read_logs_handles_reader_exception)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
