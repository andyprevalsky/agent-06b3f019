"""Native HTTP409 controls for first generation sealing during browser teardown."""
import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import httpx
from otp_retry_behavior import _offline_activity_edges


async def assert_first_native_seal_during_background_cleanup(stage="diagnostics", status=409):
    from domains.spawn_browser_agent_v3 import handler, repo
    first_signal, post_signal = [], []
    sealed = False
    output = Path(".context/cleanup-seal-fixture.html")
    output.parent.mkdir(exist_ok=True)
    output.write_text("<html>fixture</html>")

    async def post(url, **kwargs):
        nonlocal sealed
        action = kwargs["json"]["metadata"]["action_type"]
        if sealed:
            post_signal.append(action)
        selected = action == stage or stage in {"terminal", "fallback_terminal"} and action == "task_complete"
        response_status = status if selected else 200
        if response_status == 409:
            first_signal.append(action)
            sealed = True
        return httpx.Response(response_status, request=httpx.Request("POST", url))

    async def upload(**kwargs):
        if sealed:
            post_signal.append("storage upload")
        return {"id": "fixture-pointer"}

    async def remote_close():
        if sealed:
            post_signal.append("remote browser close")

    abort_network, abort_recording = AsyncMock(return_value=True), AsyncMock(return_value=True)
    network = SimpleNamespace(close=AsyncMock(return_value=output), console_index_path=None,
                              archive_diagnostics_artifacts=AsyncMock(return_value={}),
                              export_diagnostics_bundle_bytes=lambda: None, abort_local=abort_network)
    recorder = SimpleNamespace(close=AsyncMock(return_value=output), uses_kernel_replay=False,
                               export_inline_html_bytes=lambda: b"<html>fixture</html>",
                               archive_recording_artifacts_in_background=lambda **kw: True,
                               cleanup_local_artifacts=lambda **kw: None, abort_local=abort_recording)
    browser, driver, dom = SimpleNamespace(close=AsyncMock(side_effect=remote_close)), SimpleNamespace(stop=AsyncMock()), SimpleNamespace(disconnect=AsyncMock())
    if stage != "diagnostics":
        network = None
    if stage == "terminal":
        recorder = None
    config = SimpleNamespace(backend=SimpleNamespace(api_url="https://fixture.invalid", api_key="fixture"))
    loop, callback_errors = asyncio.get_running_loop(), []
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, context: callback_errors.append(context))
    try:
        if stage == "fallback_terminal":
            fallback_patch = patch.object(handler, "_finalize_browser_recording_for_fe_resilient", AsyncMock(side_effect=RuntimeError("ordinary recording teardown failure")))
        else:
            from contextlib import nullcontext
            fallback_patch = nullcontext()
        with fallback_patch, _offline_activity_edges(), patch("config.load_config", return_value=config), patch.object(repo, "get_http_client", return_value=SimpleNamespace(post=post)), patch.object(handler, "save_browser_action_message", repo.save_browser_action_message), patch.object(handler, "upload_to_storage", upload):
            await handler._schedule_browser_cleanup(
                agent_id="fixture", task_id="fixture", user_id="fixture", browser_url=None,
                browser_session_metadata={"provider": "steel"}, input_page=None, start_url="https://fixture.invalid",
                cursor_streamer=None, interaction_layer_task=None, humanizer=None,
                browser_network_recorder=network, network_recorder_task=None, browser_recorder=recorder,
                dom_service=dom, playwright_browser=browser, playwright_instance=driver,
                playwright_driver_pid=None,
            )
            await handler.drain_background_browser_cleanups()
            await asyncio.sleep(0)
        driver.stop.assert_awaited_once()
        dom.disconnect.assert_awaited_once()
        if status == 409:
            assert first_signal, "genuine native writer409 was not reached"
            assert post_signal == [], f"new work after first cleanup seal: {post_signal}"
            browser.close.assert_not_awaited()
            if recorder is not None:
                abort_recording.assert_awaited_once()
            if network is not None:
                abort_network.assert_awaited_once()
        else:
            assert not sealed and post_signal == []
            browser.close.assert_awaited_once()
    finally:
        loop.set_exception_handler(previous)
    assert not callback_errors, callback_errors


async def assert_first_native_seal_during_activity_finally(owning_fixture, resolution=False):
    with _offline_activity_edges():
        await owning_fixture("finally_resolution_first_seal" if resolution else "finally_diagnostics_first_seal")
