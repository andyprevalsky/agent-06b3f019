"""Real activity/API/Chromium driver for the backend's isolated pause E2E case."""

import argparse
import asyncio
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
from urllib.parse import urlsplit
from unittest.mock import AsyncMock, patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.env_defaults import apply_test_env_defaults

apply_test_env_defaults()

# The proof runner can load a private historical source without touching the
# shared checkout; both runs use this exact permanent E2E and backend fixture.
if os.environ.get("BROWSER_E2E_HANDLER_SOURCE"):
    import importlib.machinery

    _source = Path(os.environ["BROWSER_E2E_HANDLER_SOURCE"]).read_text()
    _original_get_code = importlib.machinery.SourceFileLoader.get_code

    def _get_code(loader, fullname):
        if fullname == "domains.spawn_browser_agent_v3.handler":
            return compile(_source, loader.path, "exec")
        return _original_get_code(loader, fullname)

    importlib.machinery.SourceFileLoader.get_code = _get_code

from browser_tools.dom_service import DOMService
from domains.spawn_browser_agent_v3 import handler, repo


class ActivityProbe:
    def __init__(self, manifest, config, *, resume_state=None, auth=False):
        self.manifest = manifest
        self.config = config
        self.merchant_url = manifest["merchant_url"]
        self.scenarios = ("auth" if auth else "write",)
        self.resume_state = resume_state
        self.calls = 0
        self.real_execute = handler.execute_action
        self.real_disconnect = handler.disconnect_browser_after_passkey_capture
        self.real_record = handler.record_used_passkey_credentials
        self.close = repo.close_browser_session
        from temporalio.testing import ActivityEnvironment
        self.activity_run = ActivityEnvironment.run

    def dom_factory(self, *args, **kwargs):
        self.dom = DOMService(*args, **kwargs)
        return self.dom

    async def model(self, **_kwargs):
        self.calls += 1
        if self.scenarios == ("auth",):
            action = {"action": "request_user_assistance_for_authentication", "params": {}}
        elif not self.resume_state:
            _, cdp = await self.dom._live_cdp_session()
            result = await cdp.cdp_client.send.Runtime.evaluate(
                params={"expression": "(() => { const r = document.getElementById('order').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()", "returnByValue": True},
                session_id=cdp.session_id,
            )
            action = {"action": "click", "coordinates": result["result"]["value"], "params": {}}
        elif self.calls == 1:
            action = {"action": "evaluate", "params": {"code": "(async () => { const response = await fetch('/order', {method: 'POST'}); if (!response.ok) throw new Error('order rejected'); return await response.json(); })()"}}
        else:
            action = {"action": "attempt_completion", "params": {"reasoning": "The fixture order was submitted once."}}
        return {"action": action, "usage": {}}

    def install(self, stack, current_handler):
        from temporalio.testing import ActivityEnvironment

        def run_activity(environment, function, *args, **kwargs):
            if function is current_handler.spawn_browser_agent_activity_v3:
                kwargs["task_id"] = self.manifest["task_id"]
            return self.activity_run(environment, function, *args, **kwargs)

        stack.enter_context(patch.object(ActivityEnvironment, "run", run_activity))
        stack.enter_context(patch.object(current_handler, "fetch_session_info", repo.fetch_session_info))
        stack.enter_context(patch.object(current_handler, "resume_browser_session", repo.resume_browser_session))
        stack.enter_context(patch.object(current_handler, "close_browser_session", repo.close_browser_session))
        stack.enter_context(patch.object(current_handler, "disconnect_browser_after_passkey_capture", self.real_disconnect))
        stack.enter_context(patch.object(current_handler, "record_used_passkey_credentials", self.real_record))
        stack.enter_context(patch.object(current_handler, "_call_browser_use_with_rotation", side_effect=self.model))
        stack.enter_context(patch.object(current_handler, "execute_action", self.real_execute))
        if self.scenarios != ("auth",):
            stack.enter_context(patch.object(current_handler, "create_user_auth_assistance_request", AsyncMock(side_effect=AssertionError("unexpected auth request"))))
        if self.resume_state:
            stack.enter_context(patch.object(current_handler, "hydrate_resume_context", AsyncMock(return_value=self.resume_state)))

    async def observe(self, result, current_handler):
        await current_handler.drain_background_browser_cleanups(timeout=10)
        self.result = result


async def drive(manifest):
    path = Path(__file__).with_name("spawn_browser_agent_v3.blackbox.py")
    spec = importlib.util.spec_from_file_location("browser_pause_activity_fixture", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    # The deterministic actor needs only the local fixture. Refuse any ambient
    # telemetry/provider HTTP inherited from a developer's environment.
    from helpers.httpx_capture import set_mock_handler

    local_transport = httpx.AsyncHTTPTransport()

    async def local_only(request):
        if request.url.host in {"localhost", "127.0.0.1", "::1"}:
            return await local_transport.handle_async_request(request)
        return httpx.Response(503, json={"error": "nonlocal HTTP disabled in browser pause E2E"})

    set_mock_handler(local_only)
    config = module._fake_config(manifest["api_url"], manifest.get("api_key", "e2e-local"))
    config.payment.decryption_key = manifest.get("fixture_decryption_key", "")
    task_id = manifest["task_id"]
    async with httpx.AsyncClient(timeout=60) as client:
        async def state():
            response = await client.post(manifest["api_url"] + "/__test/state", json={})
            response.raise_for_status()
            return response.json()

        before = await state()
        assert before["frameState"], "cross-origin frame state must be exercised"
        for frame in before["frameState"]:
            assert urlsplit(frame["origin"]).hostname == urlsplit(before["url"]).hostname
            assert urlsplit(frame["origin"]).port != urlsplit(before["url"]).port
            assert frame["localStorage"] and frame["indexedDB"] and frame["sessionStorage"], frame
        if manifest.get("mode") == "capture_failure":
            probe = ActivityProbe(manifest, config)
            try:
                await module.test_private_browser_pause_urls_use_protected_continuity(probe)
            except repo.BrowserSessionCloseError:
                pass
            else:
                raise AssertionError("Checkpoint failure was acknowledged as a successful pause")
            await handler.drain_background_browser_cleanups(timeout=10)
            retained = await state()
            assert retained["alive"] and retained["releaseCount"] == before["releaseCount"], retained
            assert retained["native_id"] == before["native_id"], retained
            assert retained["orderCount"] == before["orderCount"] == 0, retained
            assert retained["frameState"] == before["frameState"], retained
            return {"status": "passed", "mode": "capture_failure", "retained": retained}
        if manifest.get("mode") == "auth":
            probe = ActivityProbe(manifest, config, auth=True)
            await module.test_private_browser_pause_urls_use_protected_continuity(probe)
            retained = await state()
            assert probe.result["status"] == "awaiting_auth_assistance", probe.result
            assert retained["alive"] and retained["checkpointRevision"] == before["checkpointRevision"], retained
            assert retained["native_id"] == before["native_id"], retained
            assert retained["orderCount"] == before["orderCount"] == 0, retained
            assert retained["frameState"] == before["frameState"], retained
            return {"status": "passed", "mode": "auth", "retained": retained}
        first = ActivityProbe(manifest, config)
        await module.test_private_browser_pause_urls_use_protected_continuity(first)
        assert first.result["status"] == "awaiting_write_approval", first.result
        parked = await state()
        response = await client.post(manifest["api_url"] + "/__test/expire", json={})
        response.raise_for_status()
        resumed = await repo.resume_browser_session(config, task_id)
        assert resumed["task_id"] == task_id, resumed
        restored = await state()
        assert {before["task_id"], parked["task_id"], restored["task_id"]} == {task_id}
        assert restored["native_id"] != before["native_id"], restored
        for key in ("cookie", "localStorage", "indexedDB", "sessionStorage", "url", "cart", "frameState"):
            assert restored[key] == before[key], (key, {"before": before, "parked": parked, "restored": restored})
        assert parked["checkpointRevision"] > 0, parked
        assert not parked["alive"], parked
        assert restored["orderCount"] == before["orderCount"] == 0
        again = await repo.resume_browser_session(config, task_id)
        assert again["session_id"] == resumed["session_id"], again
        live = await state()
        for key in ("native_id", "cookie", "localStorage", "indexedDB", "sessionStorage", "url", "cart", "frameState"):
            assert live[key] == restored[key], (key, live, restored)

        continuation = dict(first.result)
        continuation.pop("browser_resume_context_ref", None)
        approved_at = time.time()
        continuation.update({"approval_type": "purchase", "write_lock_approved_at": approved_at,
                             "write_lock_approvals": {"purchase": {"domain": urlsplit(manifest["merchant_url"]).hostname, "approved_at": approved_at}},
                             "session_id": resumed["session_id"], "task_id": task_id})
        second = ActivityProbe(manifest, config, resume_state=continuation)
        await module.test_private_browser_pause_urls_use_protected_continuity(second)
        final = await state()
        assert second.result["success"] is True, second.result
        assert final["orderCount"] == 1, final
        return {"status": "passed", "before": before, "parked": parked,
                "restored": restored, "final": final,
                "first_activity_status": first.result["status"], "second_activity_success": second.result["success"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()
    loop = asyncio.new_event_loop()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = loop.run_until_complete(drive(json.loads(Path(args.manifest).read_text())))
    finally:
        # The fixture parent owns and tears down Chromium. Do not let browser-use
        # watchdogs which suppress cancellation strand this isolated test process.
        loop.run_until_complete(handler.drain_background_browser_cleanups(timeout=2))
        loop.close()
    print(json.dumps(result))
