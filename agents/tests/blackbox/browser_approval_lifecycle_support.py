"""Real installed BrowserSession stop/event and DOM detach; only remote transport is fake."""
import asyncio
from types import MethodType, SimpleNamespace
from unittest.mock import AsyncMock, patch

from browser_tools.dom_service import DOMService
from browser_use.browser.events import BrowserStopEvent
from browser_use.browser.session import BrowserSession
from domains.spawn_browser_agent_v3.repo import BrowserSessionCloseError


class ApprovalLifecycleProbe:
    def __init__(self, provider, mode, scenario):
        from domains.spawn_browser_agent_v3 import handler

        self.provider, self.mode = provider, mode
        self.scenarios = (scenario,)
        self.alive = True
        self.parking = False
        self.events = []
        self.disconnect_callback = handler.disconnect_browser_after_passkey_capture

    async def connect(self, _url):
        probe = self
        remote = SimpleNamespace(
            cdp_url=("wss://11111111-1111-4111-8111-111111111111.cdp0.browser-use.com" if self.provider == "browser-use" else "wss://kernel.example/cdp"),
            is_local=False,
            logger=SimpleNamespace(debug=lambda *a: None, info=lambda *a: None, warning=lambda *a: None),
            start=AsyncMock(),
            reset=AsyncMock(side_effect=lambda: self.events.append("reset_cdp")),
            _register_session_event_handlers=lambda: None,
        )

        async def stop_provider(_id):
            probe.events.append("sdk_provider_stop")
            probe.alive = False

        remote._cloud_browser_client = SimpleNamespace(current_session_id=None, stop_browser=stop_provider, close=AsyncMock())
        remote._cloud_session_id_from_cdp_url = MethodType(BrowserSession._cloud_session_id_from_cdp_url, remote)
        remote.on_BrowserStopEvent = MethodType(BrowserSession.on_BrowserStopEvent, remote)
        remote.stop = MethodType(BrowserSession.stop, remote)

        class Bus:
            def dispatch(self, event):
                async def delivered():
                    if isinstance(event, BrowserStopEvent):
                        await remote.on_BrowserStopEvent(event)
                return asyncio.create_task(delivered())

            async def stop(self, **_kwargs):
                probe.events.append("event_bus_stop")

        remote.event_bus = Bus()
        dom = DOMService(remote.cdp_url)
        with patch("browser_use.browser.session.BrowserSession", side_effect=lambda **kw: self._bind(remote, kw)), patch.object(dom, "_inject_scrollbar_css", AsyncMock()), patch.object(dom, "_inject_captcha_solve_indicator", AsyncMock()), patch.object(dom, "ensure_browser_overlays_suppressed", AsyncMock()), patch.object(dom, "_inject_anti_detection", AsyncMock()):
            await dom.connect()
        return dom

    def _bind(self, remote, options):
        remote.browser_profile = options["browser_profile"]
        return remote

    async def close(self, _config, _id, **options):
        assert options["pause"] is True
        self.events.append("checkpoint")
        assert self.alive, "provider was released before checkpoint capture"
        if self.mode == "checkpoint_failure":
            raise BrowserSessionCloseError(_id, True, 500)
        self.events.append("backend_release")
        self.alive = False

    def install(self, stack, handler):
        async def capture(**_kwargs):
            if self.parking:
                self.events.append("passkey_capture")
                if self.mode == "passkey_failure":
                    raise RuntimeError("passkey capture unavailable")
            return 0

        async def replay(_recorder):
            self.events.append("replay_stop")
            assert self.alive, ("recorder stopped after provider release", self.events)
            if self.mode == "recorder_failure" and self.events.count("replay_stop") == 1:
                raise RuntimeError("replay stop unavailable")

        async def finalize(**_kwargs):
            self.events.append("recording_finalized")

        schedule = handler._schedule_browser_cleanup

        def cleanup(**kwargs):
            kwargs["browser_recorder"] = SimpleNamespace()
            return schedule(**kwargs)

        stack.enter_context(patch.object(handler, "record_used_passkey_credentials", side_effect=capture))
        stack.enter_context(patch.object(handler, "disconnect_browser_after_passkey_capture", wraps=self.disconnect_callback))
        stack.enter_context(patch.object(handler, "_stop_kernel_replay_before_session_close", side_effect=replay))
        stack.enter_context(patch.object(handler, "_finalize_browser_recording_for_fe_resilient", side_effect=finalize))
        stack.enter_context(patch.object(handler, "_schedule_browser_cleanup", side_effect=cleanup))

    async def observe(self, result, handler):
        await handler.drain_background_browser_cleanups(timeout=2)
        assert "recording_finalized" in self.events, self.events
        if self.scenarios == ("auth",):
            assert result["status"] == "awaiting_auth_assistance"
            assert self.alive and "checkpoint" not in self.events, self.events
        else:
            assert self.events.index("passkey_capture") < self.events.index("reset_cdp") < self.events.index("replay_stop") < self.events.index("checkpoint") < self.events.index("backend_release"), self.events
        assert "sdk_provider_stop" not in self.events, self.events


class RealPasskeyCaptureProbe(ApprovalLifecycleProbe):
    """Exercise actual injection, readback and usage recording below transport edges."""

    capture_real_passkeys = True

    def __init__(self, provider, mode, scenario):
        super().__init__(provider, mode, scenario)
        from domains.spawn_browser_agent_v3 import handler

        self.record_usage = handler.record_used_passkey_credentials
        self.build_realm = handler.build_realm_credential_state
        self.credentials = {}
        self.saved = []

    async def connect(self, url):
        dom = await super().connect(url)
        remote = dom._session
        remote.agent_focus_target_id = "target-a"
        enabled = False
        authenticator = None

        async def send(method, params):
            nonlocal enabled, authenticator
            active = getattr(self, "ready", False) and (self.parking or self.scenarios == ("auth",))
            if method == "WebAuthn.enable":
                enabled = True
            elif method == "WebAuthn.addVirtualAuthenticator":
                assert enabled and authenticator is None
                authenticator = "authenticator-a"
                return {"authenticatorId": authenticator}
            elif method == "WebAuthn.addCredential":
                assert params["authenticatorId"] == authenticator
                credential = dict(params["credential"])
                self.credentials[credential["credentialId"]] = credential
            elif method == "WebAuthn.removeVirtualAuthenticator":
                authenticator = None
                self.credentials.clear()
            elif method == "WebAuthn.getCredentials":
                assert enabled and params["authenticatorId"] == authenticator
                if active:
                    self.events.append("readback")
                    if self.mode == "command_failure":
                        raise RuntimeError("fixture CDP read unavailable")
                    if self.mode == "cancel_read":
                        raise asyncio.CancelledError()
                    if self.mode == "missing_credential":
                        return {"credentials": []}
                values = [dict(value) for value in self.credentials.values()]
                if active and self.mode != "unused":
                    for value in values:
                        value["signCount"] += 1
                return {"credentials": values}
            elif method != "Page.setInterceptFileChooserDialog":
                raise AssertionError(method)
            return {}

        async def acquire(target_id, focus=False):
            assert target_id == "target-a" and not focus
            if getattr(self, "ready", False) and (self.parking or self.scenarios == ("auth",)) and self.mode == "acquire_failure":
                self.events.append("read_acquire_failure")
                raise RuntimeError("fixture CDP target unavailable")
            return SimpleNamespace(session_id="cdp-a", send=send)

        remote.get_or_create_cdp_session = acquire
        if self.mode not in {"no_passkeys", "unseeded"}:
            assert await dom.inject_passkeys([{
                "credentialId": "fixture-passkey", "privateKey": "fixture-key",
                "rpId": "fixture.test", "signCount": 7,
            }]) == 1
        if self.mode == "invalidated_used":
            self.ready = True
            self.parking = True
            await dom.invalidate_passkey_state_for_live_target()
            self.parking = False
            assert dom._passkey_observed_max_counts == {"fixture-passkey": 8}
            assert not dom._passkey_authenticator_by_target
        self.dom = dom
        self.ready = True
        return dom

    def install(self, stack, handler):
        super().install(stack, handler)

        async def realm(*args, **kwargs):
            state = await self.build_realm(*args, **kwargs)
            if self.mode != "no_passkeys":
                state.passkey_ref_by_credential_id["fixture-passkey"] = {
                    "kind": "passkey", "id": "fixture-ref",
                }
            return state

        async def save(**kwargs):
            self.events.append("save_reference")
            self.saved.append(kwargs["credential_ref"])
            if self.mode == "save_exception":
                raise RuntimeError("fixture persistence unavailable")
            return self.mode != "save_failure"

        stack.enter_context(patch.object(handler, "record_used_passkey_credentials", self.record_usage))
        stack.enter_context(patch.object(handler, "build_realm_credential_state", side_effect=realm))
        stack.enter_context(patch.object(handler, "save_browser_credential_ref_message", side_effect=save))

    async def observe(self, result, handler):
        await handler.drain_background_browser_cleanups(timeout=2)
        assert "recording_finalized" in self.events, self.events
        assert "sdk_provider_stop" not in self.events, self.events
        if self.scenarios == ("auth",):
            assert result["status"] == "awaiting_auth_assistance"
            assert self.alive and "checkpoint" not in self.events, self.events
        else:
            assert not self.alive and "backend_release" in self.events, self.events
            if self.mode in {"used", "invalidated_used"}:
                assert self.saved == [{"kind": "passkey", "id": "fixture-ref"}]
                assert self.events.index("save_reference") < self.events.index("backend_release")
            else:
                assert not self.saved, self.events


class TerminalPasskeyCaptureProbe(RealPasskeyCaptureProbe):
    """Use real passkey readback while contrasting terminal and approval custody."""

    def __init__(self, provider, mode, scenario):
        self.terminal_scenario = scenario
        super().__init__(provider, mode, "completed" if scenario in {"cancelled", "error"} else scenario)
        self.warnings = []
        self.result = None

    def install(self, stack, handler):
        super().install(stack, handler)
        from helpers import activity_generation_drain
        from temporalio import activity

        async def queue_pointer(**_kwargs):
            return {"task_queue": activity.info().task_queue, "surface_hash": None}

        stack.enter_context(patch.object(activity_generation_drain, "_cached_at", None))
        stack.enter_context(patch.object(activity_generation_drain, "_cached_queue", None))
        stack.enter_context(patch.object(activity_generation_drain, "read_agent_queue_pointer", queue_pointer))
        model = handler._call_browser_use_with_rotation

        async def step(**kwargs):
            self.parking = True
            return await model(**kwargs)

        stack.enter_context(patch.object(handler, "_call_browser_use_with_rotation", side_effect=step))
        user_control = handler._wait_for_browser_user_control

        async def wait_for_control(*args, **kwargs):
            if self.parking:
                if self.terminal_scenario == "cancelled":
                    raise asyncio.CancelledError()
                if self.terminal_scenario == "error":
                    raise RuntimeError("fixture terminal model failure")
            return await user_control(*args, **kwargs)

        stack.enter_context(patch.object(handler, "_wait_for_browser_user_control", side_effect=wait_for_control))
        warning = handler.logger.warning

        def warn(message, **kwargs):
            self.warnings.append(message)
            return warning(message, **kwargs)

        stack.enter_context(patch.object(handler.logger, "warning", side_effect=warn))

    async def observe(self, result, handler):
        self.result = result
        await handler.drain_background_browser_cleanups(timeout=2)

    async def assert_terminal_cleanup(self, handler):
        await handler.drain_background_browser_cleanups(timeout=2)
        assert not self.alive, self.events
        assert self.events.count("checkpoint") == self.events.count("backend_release") == 1, self.events
        assert "recording_finalized" in self.events and "reset_cdp" in self.events, self.events
        assert "sdk_provider_stop" not in self.events, self.events
        assert "Passkey usage capture incomplete; continuing terminal browser pause" in self.warnings, self.warnings
        assert self.events.index("reset_cdp") < self.events.index("backend_release"), self.events
        if self.result is not None:
            assert self.result["status"] == {
                "completed": "completed", "max_steps": "max_iterations", "cancelled": "cancelled",
                "auth": "cancelled",
            }[self.terminal_scenario], self.result
            assert "browser_cleanup" not in self.result, self.result
