"""Activity cleanup seals admission and drains owners registered by teardown tails."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from _test_utils import BlackboxResult
from domains.spawn_browser_agent_v3 import handler
from domains.spawn_browser_agent_v3.service_activity_queue import browser_cleanup_owners


def cleanup():
    return handler._schedule_browser_cleanup(
        agent_id="admission-control",
        task_id=None,
        user_id="admission-control",
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


async def test_production_bound_late_owner_cannot_acknowledge_live_custody():
    # Exact reviewer cancellation tail and Playwright stop yield. Keep the
    # production wait: the owner arrives after the first DOM enumeration.
    assert handler.BROWSER_TERMINAL_DISCONNECT_TIMEOUT_SECONDS == 10.0
    started, resume = asyncio.Event(), asyncio.Event()
    late = SimpleNamespace(disconnect_confirmed=False, disconnect=AsyncMock())
    receipt = AsyncMock()
    with browser_cleanup_owners() as owners:

        async def setup():
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await resume.wait()
                owners.track_dom(late)

        task = asyncio.create_task(setup())
        owners.setup_tasks.add(task)
        await started.wait()

        async def stop(*args, **kwargs):
            resume.set()
            await task
            return True

        try:
            with (
                patch.object(handler, "_stop_playwright_resources", side_effect=stop),
                patch.object(handler, "acknowledge_browser_activity_cleanup", receipt),
            ):
                await cleanup()
            assert not (late.disconnect_confirmed is False and receipt.await_count), (
                "late unconfirmed DOM owner acknowledged cleanup without any disconnect"
            )
            assert task.done() and owners.dom_services[id(late)] is late
            late.disconnect.assert_awaited_once()
            receipt.assert_not_awaited()
        finally:
            resume.set()
            await asyncio.gather(task, return_exceptions=True)


async def test_admission_closes_synchronously_before_cleanup_task_runs():
    entered = []

    async def setup():
        entered.append(True)

    with browser_cleanup_owners() as owners, patch.object(handler, "acknowledge_browser_activity_cleanup", AsyncMock()):
        task = cleanup()
        assert owners.admission_closed
        try:
            await handler._gather_browser_setup(setup())
        except RuntimeError as error:
            assert str(error) == "Browser resource acquisition is closed"
        else:
            raise AssertionError("cleanup admitted a new acquisition")
        await task
        assert not entered and not owners.setup_tasks


async def test_sealed_cdp_acquisition_creates_no_transport():
    from domains.spawn_browser_agent_v3.cdp_urls import open_browser_cdp_connection

    with (
        browser_cleanup_owners() as owners,
        patch("browser_tools.cdp_multiplexer.SingleCdpConnectionMultiplexer") as factory,
    ):
        owners.close_admission()
        for url in ("ws://local-unused.invalid", "wss://back.tilion.dev/v1/session/sess_" + "1" * 32 + "/cdp"):
            try:
                await open_browser_cdp_connection(url)
            except RuntimeError as error:
                assert str(error) == "Browser resource acquisition is closed"
            else:
                raise AssertionError("sealed acquisition succeeded")
        factory.assert_not_called()
        assert not owners.multiplexers


async def test_drain_reselects_descendant_registered_during_disconnect():
    receipt = AsyncMock()
    first = SimpleNamespace(disconnect_confirmed=False)
    second = SimpleNamespace(disconnect_confirmed=False)
    with browser_cleanup_owners() as owners, patch.object(handler, "acknowledge_browser_activity_cleanup", receipt):

        async def disconnect_first():
            owners.track_dom(second)
            await asyncio.sleep(0)
            first.disconnect_confirmed = True

        async def disconnect_second():
            await asyncio.sleep(0)
            second.disconnect_confirmed = True

        first.disconnect = AsyncMock(side_effect=disconnect_first)
        second.disconnect = AsyncMock(side_effect=disconnect_second)
        owners.track_dom(first)
        await cleanup()
        first.disconnect.assert_awaited_once()
        second.disconnect.assert_awaited_once()
        assert not owners.dom_services
        receipt.assert_awaited_once()


async def test_disconnect_return_without_literal_confirmation_keeps_fence():
    receipt = AsyncMock()
    service = SimpleNamespace(disconnect=AsyncMock())
    with browser_cleanup_owners() as owners, patch.object(handler, "acknowledge_browser_activity_cleanup", receipt):
        owners.track_dom(service)
        await cleanup()
        assert owners.dom_services[id(service)] is service
        receipt.assert_not_awaited()


async def run_all_tests():
    results = BlackboxResult()
    for name, test in sorted(globals().copy().items()):
        if name.startswith("test_"):
            await results.record_async(name, test)
    return results.summary()


if __name__ == "__main__":
    result = asyncio.run(run_all_tests())
    raise SystemExit(0 if result.get("failed", 0) == 0 else 1)
