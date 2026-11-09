"""Owned Playwright startup: actual local drivers, no browsers or providers."""

import asyncio
import contextlib
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from playwright._impl._connection import RootChannelOwner

from browser_tools.playwright_owner import PlaywrightOwner, _OwnedPipeTransport


async def finish(owner, *gates):
    for gate in gates:
        gate.set()
    try:
        await asyncio.wait_for(owner.close(), 10)
    finally:
        process = owner.process
        if process is not None and process.returncode is None:
            process.terminate()
            await asyncio.wait_for(process.wait(), 5)


def assert_closed(owner):
    assert owner.close_confirmed is True
    assert owner.process is None or owner.process.returncode is not None
    tasks = (
        owner.startup_task,
        owner.creator_task,
        owner.connection_task,
        owner.init_task,
        owner.stop_task,
        owner.process_wait_task,
        owner.close_task,
    )
    assert all(task is None or task.done() for task in tasks), "native owner acknowledged unsettled work"
    print(
        {
            "owned_pid": getattr(owner.process, "pid", None),
            "returncode": getattr(owner.process, "returncode", None),
            "native_tasks_settled": True,
            "close_confirmed": owner.close_confirmed,
        }
    )


async def test_cancelled_handshake_retains_and_exits_real_driver():
    entered, release = asyncio.Event(), asyncio.Event()

    async def initialize(_root):
        entered.set()
        await release.wait()

    owner = PlaywrightOwner()
    task = asyncio.create_task(owner.start())
    try:
        with patch.object(RootChannelOwner, "initialize", initialize):
            await asyncio.wait_for(entered.wait(), 5)
            process = owner.process
            assert process is not None and process.returncode is None
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            assert owner.close_confirmed is False and not owner.connection_task.done()
            await asyncio.wait_for(owner.close(), 10)
            print({"pid": process.pid, "returncode": process.returncode, "confirmed": owner.close_confirmed})
            assert_closed(owner)
    finally:
        await finish(owner, release)
        await asyncio.gather(task, return_exceptions=True)


async def test_successful_start_keeps_instance_stop_owned():
    owner = PlaywrightOwner()
    try:
        instance = await asyncio.wait_for(owner.start(), 5)
        assert instance is owner.instance and owner.process.returncode is None
        assert owner.close_confirmed is False
        await asyncio.wait_for(instance.stop(), 10)
        assert_closed(owner)
        await owner.close()
    finally:
        await finish(owner)


async def test_late_native_creation_survives_cancelled_start_and_close_waiter():
    entered, release = asyncio.Event(), asyncio.Event()

    class LateTransport(_OwnedPipeTransport):
        async def _connect(self):
            entered.set()
            await release.wait()
            await super()._connect()

    owner = PlaywrightOwner(_transport_factory=LateTransport)
    start = asyncio.create_task(owner.start())
    close = None
    try:
        await asyncio.wait_for(entered.wait(), 5)
        start.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await start
        close = asyncio.create_task(owner.close())
        await asyncio.sleep(0)
        close.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await close
        assert owner.creator_task is not None and not owner.creator_task.cancelled()
        assert not owner.close_task.done() and owner.close_confirmed is False
        release.set()
        await asyncio.wait_for(owner.close(), 10)
        assert owner.process is not None, "late creator never published its actual native owner"
        assert_closed(owner)
    finally:
        await finish(owner, release)
        await asyncio.gather(start, *([close] if close else []), return_exceptions=True)


async def test_cancelled_connection_during_native_creation_still_closes_driver():
    created, release = asyncio.Event(), asyncio.Event()

    class LateTransport(_OwnedPipeTransport):
        async def _connect(self):
            await super()._connect()
            created.set()
            await release.wait()

    owner = PlaywrightOwner(_transport_factory=LateTransport)
    start = asyncio.create_task(owner.start())
    try:
        await asyncio.wait_for(created.wait(), 5)
        process = owner.process
        owner.connection_task.cancel()
        await asyncio.gather(owner.connection_task, return_exceptions=True)
        assert not owner.creator_task.done() and process.returncode is None
        close = asyncio.create_task(owner.close())
        await asyncio.sleep(0)
        assert not owner.close_confirmed
        release.set()
        await asyncio.wait_for(close, 10)
        assert_closed(owner)
    finally:
        await finish(owner, release)
        await asyncio.gather(start, return_exceptions=True)


async def test_stopped_transport_future_is_not_native_exit_or_task_settlement():
    created, release = asyncio.Event(), asyncio.Event()

    class StoppedFutureTransport(_OwnedPipeTransport):
        async def run(self):
            self._stopped_future.set_result(None)
            created.set()
            await super().run()
            await release.wait()

    owner = PlaywrightOwner(_transport_factory=StoppedFutureTransport)
    start = asyncio.create_task(owner.start())
    close = None
    try:
        await asyncio.wait_for(created.wait(), 5)
        assert owner.transport._stopped_future.done() and owner.process.returncode is None
        assert not owner.close_confirmed
        close = asyncio.create_task(owner.close())
        await asyncio.wait_for(owner.process.wait(), 5)
        assert not owner.close_confirmed, "native exit cannot acknowledge a still-running creator task"
        release.set()
        await asyncio.wait_for(close, 10)
        assert_closed(owner)
    finally:
        await finish(owner, release)
        await asyncio.gather(start, *([close] if close else []), return_exceptions=True)


async def test_initialization_error_preserved_and_real_driver_exits():
    error = RuntimeError("controlled Playwright initialization failure")

    async def initialize(_root):
        raise error

    owner = PlaywrightOwner()
    try:
        with patch.object(RootChannelOwner, "initialize", initialize):
            try:
                await asyncio.wait_for(owner.start(), 5)
            except RuntimeError as caught:
                assert caught is error
            else:
                raise AssertionError("initialization failure was swallowed")
        assert owner.process.returncode is None and not owner.close_confirmed
        await asyncio.wait_for(owner.close(), 10)
        assert_closed(owner)
    finally:
        await finish(owner)


async def test_injected_factory_preserves_instance_contract():
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    instance = SimpleNamespace(stop=AsyncMock())
    manager = SimpleNamespace(start=AsyncMock(return_value=instance))
    owner = PlaywrightOwner(factory=lambda: manager)
    assert await owner.start() is instance
    await owner.close()
    manager.start.assert_awaited_once()
    instance.stop.assert_awaited_once()
    assert_closed(owner)


async def test_native_creation_error_preserves_error_without_inventing_process():
    error = OSError("controlled native creator failed")

    class FailedTransport(_OwnedPipeTransport):
        async def _connect(self):
            self.on_error_future.set_exception(error)
            raise error

    owner = PlaywrightOwner(_transport_factory=FailedTransport)
    try:
        await owner.start()
    except OSError as caught:
        assert caught is error
    else:
        raise AssertionError("native creation error swallowed")
    await owner.close()
    assert owner.process is None
    assert_closed(owner)


async def test_failed_native_close_retains_process_and_false_confirmation():
    from playwright._impl._transport import PipeTransport

    error = RuntimeError("controlled native stop failed")

    class FailedTransport(_OwnedPipeTransport):
        fail = True

        def request_stop(self):
            if self.fail:
                raise error
            super().request_stop()

    owner = PlaywrightOwner(_transport_factory=FailedTransport)
    try:
        await owner.start()
        process = owner.process
        try:
            await owner.close()
        except RuntimeError as caught:
            assert caught is error
        else:
            raise AssertionError("native close error swallowed")
        assert owner.process is process and process.returncode is None and owner.close_confirmed is False
        failed_close = owner.close_task
        owner.transport.fail = False
        await owner.close()
        assert owner.close_task is not failed_close and owner.process is process
        assert_closed(owner)
    finally:
        # Release only this fault-injected local driver through its real SDK
        # transport; production close still retains and reports the failure.
        if owner.process.returncode is None:
            PipeTransport.request_stop(owner.transport)
            await asyncio.wait_for(owner.process.wait(), 5)
            await asyncio.gather(owner.connection_task, return_exceptions=True)
            owner.connection.cleanup()
            if owner.connection._init_task is not None:
                await asyncio.gather(owner.connection._init_task, return_exceptions=True)
        print({"failed_close_owned_pid": owner.process.pid, "returncode": owner.process.returncode})


async def test_production_cancelled_handshake_cannot_ack_live_driver():
    from unittest.mock import AsyncMock
    from playwright.async_api import async_playwright
    from domains.spawn_browser_agent_v3 import handler
    from domains.spawn_browser_agent_v3.service_activity_queue import browser_cleanup_owners

    entered, release = asyncio.Event(), asyncio.Event()
    native = connection = None

    async def initialize(root):
        nonlocal native, connection
        connection = root._connection
        native = connection._transport._proc
        entered.set()
        await release.wait()

    receipt = AsyncMock()
    task = None
    with (
        browser_cleanup_owners() as owners,
        patch.object(RootChannelOwner, "initialize", initialize),
        patch.object(handler, "acknowledge_browser_activity_cleanup", receipt),
    ):
        try:
            task = asyncio.create_task(handler._gather_browser_setup(handler._start_owned_playwright(async_playwright)))
            await asyncio.wait_for(entered.wait(), 5)
            assert native.returncode is None
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            await handler._schedule_browser_cleanup(
                agent_id="local-playwright-control",
                task_id=None,
                user_id="local-playwright-control",
                browser_url=None,
                browser_session_metadata={},
                input_page=None,
                start_url="",
                cursor_streamer=None,
                interaction_layer_task=None,
                humanizer=None,
                browser_network_recorder=None,
                network_recorder_task=None,
                browser_recorder=None,
                dom_service=None,
                playwright_browser=None,
                playwright_instance=None,
                playwright_driver_pid=None,
                emit_task_terminal=False,
            )
            observed = {
                "driver_alive": native.returncode is None,
                "setup_tasks_done": all(t.done() for t in owners.setup_tasks),
                "cleanup_receipts": receipt.await_count,
                "pid": native.pid,
                "returncode": native.returncode,
            }
            print(observed)
            assert not (observed["driver_alive"] and observed["cleanup_receipts"]), (
                "live pre-registration Playwright driver acknowledged cleanup"
            )
            assert native.returncode is not None and receipt.await_count == 1
        finally:
            release.set()
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            # Also reap the original unowned driver in the fail-before run.
            if native is not None and native.returncode is None:
                await asyncio.wait_for(connection.stop_async(), 10)
                await asyncio.wait_for(native.wait(), 10)
            if native is not None:
                print({"owned_driver_teardown": native.pid, "returncode": native.returncode})
                assert native.returncode is not None


async def run_all_tests():
    from _test_utils import BlackboxResult

    results = BlackboxResult()
    for name, test in sorted(globals().copy().items()):
        if name.startswith("test_"):
            await results.record_async(name, test)
    return results.summary()


async def test_pid_only_cdp_failure_uses_captured_instance_owner():
    from playwright.async_api import async_playwright
    from domains.spawn_browser_agent_v3 import handler
    from domains.spawn_browser_agent_v3.service_activity_queue import browser_cleanup_owners

    with browser_cleanup_owners() as owners:
        instance = await handler._start_owned_playwright(async_playwright)
        process = handler._playwright_driver_process(instance)
        handler._track_browser_playwright(None, instance, process.pid)
        try:
            try:
                await instance.chromium.connect_over_cdp("http://127.0.0.1:1")
            except Exception:
                pass
            else:
                raise AssertionError("local refused CDP connection unexpectedly succeeded")
            with patch("psutil.Process", side_effect=AssertionError("bare PID reopened")):
                confirmed = await handler._stop_playwright_resources(
                    None, None, "local-cdp-failure", driver_pid=process.pid
                )
            assert confirmed, "PID-only cleanup lost the captured instance/native owner"
            assert process.returncode is not None and not owners.playwright
        finally:
            await instance.stop()
            assert process.returncode is not None
            print({"cdp_failure_driver_pid": process.pid, "returncode": process.returncode})


async def test_final_cleanup_pid_snapshot_cannot_create_duplicate_owner():
    from unittest.mock import AsyncMock
    from playwright.async_api import async_playwright
    from domains.spawn_browser_agent_v3 import handler
    from domains.spawn_browser_agent_v3.service_activity_queue import browser_cleanup_owners

    with browser_cleanup_owners() as owners:
        instance = await handler._start_owned_playwright(async_playwright)
        process = handler._playwright_driver_process(instance)
        handler._track_browser_playwright(None, instance, process.pid)
        receipt = AsyncMock()
        try:
            with (
                patch.object(handler, "acknowledge_browser_activity_cleanup", receipt),
                patch("psutil.Process", side_effect=AssertionError("bare PID reopened")),
            ):
                await handler._schedule_browser_cleanup(
                    agent_id="local-pid-snapshot",
                    task_id=None,
                    user_id="local-pid-snapshot",
                    browser_url=None,
                    browser_session_metadata={},
                    input_page=None,
                    start_url="",
                    cursor_streamer=None,
                    interaction_layer_task=None,
                    humanizer=None,
                    browser_network_recorder=None,
                    network_recorder_task=None,
                    browser_recorder=None,
                    dom_service=None,
                    playwright_browser=None,
                    playwright_instance=None,
                    playwright_driver_pid=process.pid,
                    emit_task_terminal=False,
                )
            assert not owners.playwright and not owners.driver_owners, (
                "final PID snapshot created an unresolvable duplicate owner"
            )
            receipt.assert_awaited_once()
            assert process.returncode is not None
        finally:
            await instance.stop()
            assert process.returncode is not None
            print({"final_cleanup_driver_pid": process.pid, "returncode": process.returncode})


async def test_pid_resolution_preserves_remote_browser_close_policy():
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from domains.spawn_browser_agent_v3 import handler
    from domains.spawn_browser_agent_v3.service_activity_queue import browser_cleanup_owners

    process = SimpleNamespace(pid=123, returncode=0)
    instance = SimpleNamespace(
        stop=AsyncMock(),
        _impl_obj=SimpleNamespace(_connection=SimpleNamespace(_transport=SimpleNamespace(_proc=process))),
    )
    browser = SimpleNamespace(close=AsyncMock())
    with browser_cleanup_owners() as owners:
        owners.track_playwright(browser, instance, process.pid, close_browser=False)
        with patch("psutil.Process", side_effect=AssertionError("bare PID reopened")):
            assert await handler._stop_playwright_resources(None, None, "local-policy", driver_pid=process.pid)
        instance.stop.assert_awaited_once()
        browser.close.assert_not_awaited()
        assert not owners.playwright


async def test_registered_custom_playwright_factory_closes_once():
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from domains.spawn_browser_agent_v3 import handler
    from domains.spawn_browser_agent_v3.service_activity_queue import browser_cleanup_owners

    instance = SimpleNamespace(stop=AsyncMock())
    manager = SimpleNamespace(start=AsyncMock(return_value=instance))
    with browser_cleanup_owners() as owners:
        assert await handler._start_owned_playwright(lambda: manager) is instance
        startup = next(iter(owners.playwright_startups.values()))
        assert await handler._stop_playwright_resources(None, instance, "owned-custom") is True
        await startup.close()
        instance.stop.assert_awaited_once()
        assert startup.close_confirmed is True


async def test_registered_custom_playwright_close_failure_remains_retryable():
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from domains.spawn_browser_agent_v3 import handler
    from domains.spawn_browser_agent_v3.service_activity_queue import browser_cleanup_owners

    instance = SimpleNamespace(stop=AsyncMock(side_effect=[RuntimeError("native close refused"), None]))
    manager = SimpleNamespace(start=AsyncMock(return_value=instance))
    with browser_cleanup_owners() as owners:
        await handler._start_owned_playwright(lambda: manager)
        startup = next(iter(owners.playwright_startups.values()))
        assert await handler._stop_playwright_resources(None, instance, "owned-custom") is False
        assert startup.close_confirmed is False
        assert await handler._stop_playwright_resources(None, instance, "owned-custom") is True
        await startup.close()
        assert instance.stop.await_count == 2
        assert startup.close_confirmed is True


if __name__ == "__main__":
    result = asyncio.run(run_all_tests())
    raise SystemExit(0 if result["failed"] == 0 else 1)
