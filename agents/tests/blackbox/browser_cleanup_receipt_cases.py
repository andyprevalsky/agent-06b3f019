"""Timeout fences require an exact worker teardown receipt, not elapsed time."""

import asyncio
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from temporalio.testing import ActivityEnvironment

from _test_utils import BlackboxResult


async def _exercise_timeout_receipt(*, early=False, fail_cleanup=False):
    from domains.spawn_browser_agent_v3 import handler
    from temporalio.exceptions import ActivityError, TimeoutError
    from workflows.agent_workflow import AgentWorkflow

    owner = AgentWorkflow()
    owner.user_id, owner.agent_id, owner.is_paused = "receipt-user", "receipt-agent", False
    started = []
    release = asyncio.Event()
    signals = []
    run_id = "original-run"
    activity_id = "browser-cleanup:attempt-1"
    env = ActivityEnvironment()
    import dataclasses

    env.info = dataclasses.replace(
        env.info,
        workflow_id="receipt-workflow",
        workflow_run_id=run_id,
        activity_id=activity_id,
        start_to_close_timeout=timedelta(minutes=30),
    )

    async def signal(name, receipt, **_kwargs):
        signals.append((name, receipt))
        receiver = getattr(AgentWorkflow, name, None)
        if receiver:
            receiver(owner, receipt)

    client = SimpleNamespace(get_workflow_handle=lambda _id: SimpleNamespace(signal=signal))

    async def cleanup_resources(*_args, **_kwargs):
        await release.wait()
        if fail_cleanup is True:
            raise RuntimeError("fixture local teardown failed")
        return fail_cleanup != "playwright"

    async def cleanup():
        task = handler._schedule_browser_cleanup(
            agent_id=owner.agent_id,
            task_id=None,
            user_id=owner.user_id,
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
            dom_service=(
                SimpleNamespace(disconnect=AsyncMock(side_effect=RuntimeError("fixture CDP detach failed")))
                if fail_cleanup == "dom"
                else None
            ),
            playwright_browser=None,
            playwright_instance=None,
            playwright_driver_pid=None,
            emit_task_terminal=False,
            # The captured incident returned HTTP 500 on provider checkpoint.
            # Local teardown is still the owner of concurrent browser driving.
            cleanup_failure={"status": "failed", "http_status": 500},
        )
        await task

    cleanup_task = None

    async def native(call_id):
        nonlocal cleanup_task
        if call_id != "first":
            return {"status": "completed", "success": True, "message": "done"}
        cleanup_task = asyncio.create_task(env.run(cleanup))
        if early:
            release.set()
            await cleanup_task
        failure = ActivityError(
            "fixture timeout",
            scheduled_event_id=1,
            started_event_id=2,
            identity="fixture",
            activity_type="browser",
            activity_id=activity_id,
            retry_state=None,
        )
        raise failure from TimeoutError("activity StartToClose timeout", type=None, last_heartbeat_details=[])

    def start(_function, **kwargs):
        call_id = kwargs["args"][3]
        started.append(call_id)
        return asyncio.create_task(native(call_id))

    async def wait_condition(predicate, **_kwargs):
        while not predicate():
            await asyncio.sleep(0)

    async def consume(call_id):
        return [
            event
            async for event in handler.SpawnBrowserAgentManagerV3().execute_tool(owner, {"goal": call_id}, call_id)
        ]

    with (
        patch.object(handler.workflow, "in_workflow", return_value=True),
        patch.object(handler.workflow, "info", return_value=SimpleNamespace(run_id=run_id)),
        patch.object(handler.workflow, "uuid4", return_value="attempt-1"),
        patch.object(handler.workflow, "start_activity", side_effect=start),
        patch.object(handler.workflow, "wait_condition", side_effect=wait_condition),
        patch.object(handler, "_stop_playwright_resources", side_effect=cleanup_resources),
        patch.object(handler.activity, "client", return_value=client),
    ):
        try:
            await consume("first")
            if not early:
                assert owner._browser_activity_cleanup_unknown
                try:
                    await consume("blocked")
                except RuntimeError as error:
                    assert "cleanup is unconfirmed" in str(error)
                else:
                    raise AssertionError("successor started while worker still owned teardown")
                release.set()
                await cleanup_task
            if fail_cleanup:
                assert owner._browser_activity_cleanup_unknown
                assert not signals, "failed local teardown acknowledged custody release"
            else:
                assert not owner._browser_activity_cleanup_unknown, (
                    "finished worker teardown left the browser permanently fenced after HTTP 500"
                )
                assert signals == [
                    (
                        "browser_activity_cleanup_complete",
                        {
                            "run_id": run_id,
                            "activity_id": activity_id,
                        },
                    )
                ]
                await consume("after-receipt")
                assert started == ["first", "after-receipt"]
        finally:
            release.set()
            if cleanup_task is not None:
                await asyncio.gather(cleanup_task, return_exceptions=True)


async def test_timeout_fence_clears_only_after_exact_worker_teardown():
    await _exercise_timeout_receipt()
    await _exercise_timeout_receipt(early=True)
    await _exercise_timeout_receipt(fail_cleanup=True)


async def test_cleanup_receipt_is_exact_idempotent_and_survives_continuation():
    from workflows.agent_workflow import AgentWorkflow

    carrier = AgentWorkflow()
    carrier.max_iterations, carrier.context_gates = None, {}
    carrier._browser_activity_cleanup_unknown = True
    carrier._browser_activity_cleanup_receipt = {
        "run_id": "source-run",
        "activity_id": "browser-cleanup:attempt-1",
        "completed": False,
    }
    state = carrier._continuation_resume_state()
    restored = AgentWorkflow()
    restored._restore_deployment_state(state)
    receiver = getattr(restored, "browser_activity_cleanup_complete", lambda _receipt: None)
    for receipt in (
        {},
        None,
        {"run_id": "other-run", "activity_id": "browser-cleanup:attempt-1"},
        {"run_id": "source-run", "activity_id": "browser-cleanup:other"},
    ):
        receiver(receipt)
        assert restored._browser_activity_cleanup_unknown, "non-owning receipt cleared timeout fence"
    receipt = {"run_id": "source-run", "activity_id": "browser-cleanup:attempt-1"}
    receiver(receipt)
    receiver(receipt)
    assert not restored._browser_activity_cleanup_unknown, "continued workflow lost its exact cleanup owner"
    assert restored._browser_activity_cleanup_receipt == {**receipt, "completed": True}
    restored._browser_activity_cleanup_unknown = True
    restored._browser_activity_cleanup_receipt = {**receipt, "activity_id": "browser-cleanup:new", "completed": False}
    receiver(receipt)
    assert restored._browser_activity_cleanup_unknown, "stale attempt unblocked its successor"


async def test_failed_cdp_detach_cannot_acknowledge_custody_release():
    await _exercise_timeout_receipt(fail_cleanup="dom")


async def test_failed_native_disconnect_is_not_lost_when_session_is_cleared():
    from browser_tools.dom_service import DOMService
    from domains.spawn_browser_agent_v3.handler import _disconnect_browser, _stop_playwright_resources

    dom = DOMService("ws://fixture.invalid")
    dom._session = SimpleNamespace(stop=AsyncMock(side_effect=RuntimeError("fixture native detach failed")))
    assert not await _disconnect_browser(dom), "swallowed native stop failure acknowledged detach"
    assert dom.session is None
    assert not await _disconnect_browser(dom), "cleared session erased its unconfirmed detach"
    browser = SimpleNamespace(close=AsyncMock(side_effect=RuntimeError("fixture playwright detach failed")))
    assert not await _stop_playwright_resources(browser, None, "receipt-agent")
    await _exercise_timeout_receipt(fail_cleanup="playwright")


async def test_cancelled_multiplexer_close_retains_its_owner():
    from browser_tools.dom_service import DOMService

    closing = asyncio.Event()
    release = asyncio.Event()

    async def close():
        closing.set()
        await release.wait()

    multiplexer = SimpleNamespace(close=close, upstream_bytes_received=17)
    dom = DOMService("ws://fixture.invalid", cdp_multiplexer=multiplexer)
    dom._session = SimpleNamespace(stop=AsyncMock())
    task = asyncio.create_task(dom.disconnect())
    await closing.wait()
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert not dom.disconnect_confirmed, "cancelled multiplexer close acknowledged disconnect"
    assert dom.cdp_multiplexer is multiplexer, "cancelled close discarded its resource owner"
    release.set()
    await dom.disconnect()
    assert dom.disconnect_confirmed
    assert dom.cdp_multiplexer is None
    assert dom._released_cdp_bytes == 17, "a retried close billed the same bytes twice"


async def test_retained_playwright_owner_preserves_remote_browser_on_retry():
    from domains.spawn_browser_agent_v3 import handler
    from domains.spawn_browser_agent_v3.service_activity_queue import browser_cleanup_owners

    browser = SimpleNamespace(close=AsyncMock())
    instance = SimpleNamespace(stop=AsyncMock(side_effect=[RuntimeError("fixture stop failed"), None]))
    acknowledge = AsyncMock()
    with browser_cleanup_owners() as owners, patch.object(handler, "acknowledge_browser_activity_cleanup", acknowledge):
        assert not await handler._stop_playwright_resources(browser, instance, "receipt-agent", close_browser=False)
        assert owners.playwright, "failed stop discarded its owner"
        await handler._schedule_browser_cleanup(
            agent_id="receipt-agent", task_id=None, user_id="receipt-user", browser_url=None,
            browser_session_metadata={}, input_page=None, start_url="", cursor_streamer=None,
            interaction_layer_task=None, humanizer=None, browser_network_recorder=None,
            network_recorder_task=None, browser_recorder=None, dom_service=None,
            playwright_browser=None, playwright_instance=None, playwright_driver_pid=None,
            emit_task_terminal=False,
        )
        assert not owners.playwright
    assert instance.stop.await_count == 2
    browser.close.assert_not_awaited()
    acknowledge.assert_awaited_once()


async def test_reused_driver_pid_does_not_retain_or_kill_unrelated_process():
    from domains.spawn_browser_agent_v3 import handler
    from domains.spawn_browser_agent_v3.service_activity_queue import browser_cleanup_owners

    instance = SimpleNamespace(stop=AsyncMock())
    native_owner = MagicMock()
    native_owner.is_running.return_value = False  # original birth has exited
    native_owner.cmdline.return_value = ["/fixture/playwright/driver/node", "run-driver"]
    native_owner.status.return_value = "running"  # a replacement can be another driver
    with browser_cleanup_owners(), patch("psutil.Process", return_value=native_owner), patch(
        "psutil.pid_exists", return_value=True
    ):
        handler._track_browser_playwright(None, instance, 321)
        confirmed = await handler._stop_playwright_resources(None, instance, "receipt-agent", driver_pid=321)
    native_owner.terminate.assert_not_called()
    native_owner.kill.assert_not_called()
    assert confirmed, "reused PID kept an exited driver permanently fenced"


async def test_unknown_driver_identity_keeps_custody_fenced():
    import psutil
    from domains.spawn_browser_agent_v3 import handler
    from domains.spawn_browser_agent_v3.service_activity_queue import browser_cleanup_owners

    instance = SimpleNamespace(stop=AsyncMock())
    with browser_cleanup_owners(), patch("psutil.Process", side_effect=psutil.AccessDenied(321)) as process, patch(
        "psutil.pid_exists", return_value=False
    ):
        handler._track_browser_playwright(None, instance, 321)
        assert not await handler._stop_playwright_resources(None, instance, "receipt-agent", driver_pid=321)
    assert process.call_count == 1, "cleanup reopened a PID with unknown original identity"


async def test_multiplexer_start_failure_retains_the_created_transport_owner():
    from domains.spawn_browser_agent_v3.cdp_urls import open_browser_cdp_connection
    from domains.spawn_browser_agent_v3.service_activity_queue import browser_cleanup_owners

    multiplexer = SimpleNamespace(start=AsyncMock(side_effect=RuntimeError("fixture multiplexer start failed")))
    with browser_cleanup_owners() as owners, patch(
        "browser_tools.cdp_multiplexer.SingleCdpConnectionMultiplexer", return_value=multiplexer
    ):
        try:
            await open_browser_cdp_connection("wss://back.tilion.dev/v1/session/sess_" + "1" * 32 + "/cdp")
        except RuntimeError as error:
            assert str(error) == "fixture multiplexer start failed"
        else:
            raise AssertionError("original connection failure was lost")
        assert getattr(owners, "multiplexers", {}).get(id(multiplexer)) is multiplexer, "failed start lost transport custody"


async def run_all_tests():
    import importlib
    import inspect

    results = BlackboxResult()
    await results.record_async("timeout_teardown_receipt", test_timeout_fence_clears_only_after_exact_worker_teardown)
    await results.record_async(
        "receipt_continuation_identity", test_cleanup_receipt_is_exact_idempotent_and_survives_continuation
    )
    await results.record_async(
        "failed_cdp_detach_retains_custody", test_failed_cdp_detach_cannot_acknowledge_custody_release
    )
    await results.record_async(
        "native_disconnect_failure_receipt", test_failed_native_disconnect_is_not_lost_when_session_is_cleared
    )
    await results.record_async("cancelled_multiplexer_close_owner", test_cancelled_multiplexer_close_retains_its_owner)
    await results.record_async("retained_playwright_remote_browser", test_retained_playwright_owner_preserves_remote_browser_on_retry)
    await results.record_async("reused_driver_pid_identity", test_reused_driver_pid_does_not_retain_or_kill_unrelated_process)
    await results.record_async("unknown_driver_identity", test_unknown_driver_identity_keeps_custody_fenced)
    await results.record_async("multiplexer_start_failure_owner", test_multiplexer_start_failure_retains_the_created_transport_owner)
    for module_name in (
        "browser_cleanup_transport_cases",
        "browser_cleanup_session_cases",
        "browser_cleanup_playwright_cases",
        "browser_cleanup_admission_cases",
        "browser_cleanup_signal_cases",
    ):
        module = importlib.import_module(module_name)
        for name, test in sorted(vars(module).items()):
            if name.startswith("test_") and inspect.iscoroutinefunction(test):
                await results.record_async(f"{module_name}.{name}", test)
    return results.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
