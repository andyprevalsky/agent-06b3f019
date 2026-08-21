"""Black-box coverage for JIT browser credentials across auth realms."""

from __future__ import annotations

import base64
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from _test_utils import BlackboxResult, assert_captured_call, setup_mock


def test_steel_cdp_key_is_materialized_only_at_connection_boundary() -> None:
    from domains.spawn_browser_agent_v3.cdp_urls import steel_cdp_connection_url

    previous = os.environ.get("STEEL_API_KEY")
    os.environ["STEEL_API_KEY"] = "worker-steel-secret"
    try:
        public_url = "wss://connect.steel.dev?sessionId=session-1"
        connected = steel_cdp_connection_url(public_url)
        query = parse_qs(urlsplit(connected).query)
        assert query == {"sessionId": ["session-1"], "apiKey": ["worker-steel-secret"]}
        assert "apiKey" not in public_url
        legacy = steel_cdp_connection_url(
            "wss://connect.steel.dev?sessionId=legacy-session&APIKEY=legacy-secret"
        )
        assert parse_qs(urlsplit(legacy).query) == {
            "sessionId": ["legacy-session"],
            "apiKey": ["worker-steel-secret"],
        }
        assert steel_cdp_connection_url("ws://kernel.example/session-1") == "ws://kernel.example/session-1"
    finally:
        if previous is None:
            os.environ.pop("STEEL_API_KEY", None)
        else:
            os.environ["STEEL_API_KEY"] = previous


async def test_cross_realm_goto_prepares_complete_credentials_before_navigation() -> None:
    from domains.spawn_browser_agent_v3.service_actions import _execute_goto

    events: list[str] = []

    class FakeEvent:
        def __await__(self):
            async def done():
                return None

            return done().__await__()

        async def event_result(self, **_kwargs):
            return None

    class FakeEventBus:
        def dispatch(self, _event):
            events.append("navigate")
            return FakeEvent()

    async def prepare_credentials(target_url: str):
        events.append("prepare_credentials")
        assert target_url == "https://identity.doordash.com/store/example"
        sensitive_payload = {
            "auth_realm": "doordash.com",
            "auth_options": {
                "realm": "doordash.com",
                "cookie_bundles": [{"id": "cookie-1"}],
                "passwords": [{"id": "password-1"}],
                "passkeys": [{"id": "passkey-1"}],
            },
            "passwords": [{"id": "password-1", "encryptedPassword": "encrypted-password"}],
            "passkeys": [{"id": "passkey-1", "encryptedPrivateKey": "encrypted-key"}],
            "auth_credential_ref": {"kind": "cookie_bundle", "id": "cookie-1"},
        }
        assert sensitive_payload["passwords"] and sensitive_payload["passkeys"]
        sensitive_payload.update(
            cookie_count=1,
            password_count=1,
            passkey_count=1,
        )
        return sensitive_payload

    action_history = SimpleNamespace(record_action=AsyncMock())
    result = await _execute_goto(
        session=SimpleNamespace(event_bus=FakeEventBus()),
        dom_service=SimpleNamespace(),
        action_history=action_history,
        params={"url": "https://identity.doordash.com/store/example"},
        thinking="open merchant",
        session_id="session-1",
        config=SimpleNamespace(),
        current_auth_realm="order.online",
        prepare_credentials_for_url=prepare_credentials,
        wait_for_navigation=AsyncMock(),
    )

    assert events == ["prepare_credentials", "navigate"], events
    assert result["auth_realm"] == "doordash.com"
    assert result["credentials_prepared"] == {
        "auth_realm": "doordash.com",
        "cookie_count": 1,
        "password_count": 1,
        "passkey_count": 1,
    }
    recorded_result = action_history.record_action.await_args.kwargs["result"]
    assert recorded_result == result
    serialized_result = repr(recorded_result)
    for sensitive_key in (
        "encryptedPassword",
        "encryptedPrivateKey",
        "passwords",
        "passkeys",
        "credential_payload",
    ):
        assert sensitive_key not in serialized_result


async def test_cross_realm_goto_continues_guest_navigation_when_optional_prep_fails() -> None:
    from domains.spawn_browser_agent_v3.service_actions import _execute_goto

    events: list[str] = []

    class FakeEvent:
        def __await__(self):
            async def done():
                return None

            return done().__await__()

        async def event_result(self, **_kwargs):
            return None

    class FakeEventBus:
        def dispatch(self, _event):
            events.append("navigate")
            return FakeEvent()

    async def fail_optional_credentials(_target_url: str):
        events.append("prepare_credentials")
        raise RuntimeError("realm state decode failed")

    action_history = SimpleNamespace(record_action=AsyncMock())
    result = await _execute_goto(
        session=SimpleNamespace(event_bus=FakeEventBus()),
        dom_service=SimpleNamespace(),
        action_history=action_history,
        params={"url": "https://www.google.com/search?q=movie+genre"},
        thinking="compare showtimes",
        session_id="session-1",
        config=SimpleNamespace(),
        current_auth_realm="amctheatres.com",
        prepare_credentials_for_url=fail_optional_credentials,
        wait_for_navigation=AsyncMock(),
    )

    assert events == ["prepare_credentials", "navigate"], events
    assert result == {
        "success": True,
        "message": "",
        "current_url": "https://www.google.com/search?q=movie+genre",
    }
    action_history.record_action.assert_awaited_once()


async def test_redirected_realm_failure_is_quarantined_after_any_prep_stage() -> None:
    from domains.spawn_browser_agent_v3.handler import prepare_optional_realm_credentials

    failed_realms: dict[str, str] = {}
    calls: list[str] = []

    async def fail_after_prepare_auth(target_url: str):
        calls.append(target_url)
        raise ValueError("credential realm mismatch after payload decode")

    for _attempt in range(2):
        prepared = await prepare_optional_realm_credentials(
            target_url="https://www.google.com/search?q=movie+genre",
            current_auth_realm="amctheatres.com",
            failed_realms=failed_realms,
            prepare_credentials=fail_after_prepare_auth,
        )
        assert prepared is None

    assert calls == ["https://www.google.com/search?q=movie+genre"]
    assert failed_realms == {
        "google.com": "ValueError:credential realm mismatch after payload decode"
    }


def test_worker_and_backend_use_the_same_canonical_auth_realms() -> None:
    from domains.spawn_browser_agent_v3.service_crypto import (
        auth_realm_matches_url,
        auth_realm_from_url,
    )

    assert auth_realm_from_url("https://smile.amazon.com/cart") == "amazon.com"
    assert auth_realm_from_url("https://console.aws.amazon.com/") == "aws.amazon.com"
    assert auth_realm_from_url("https://m.uber.com/go") == "uber.com"
    assert auth_realm_from_url("http://localhost:3000/?authRealm=doordash.com") == "doordash.com"
    assert auth_realm_from_url("localhost:3000") == "localhost"
    assert (
        auth_realm_from_url("https://localhost.evil.com/?authRealm=doordash.com")
        != "doordash.com"
    )
    assert auth_realm_from_url("about:blank") == ""
    assert auth_realm_from_url("file:///tmp/page.html") == ""
    assert auth_realm_matches_url("doordash.com", "https://identity.doordash.com/login")
    assert auth_realm_matches_url("example.co.uk", "https://shop.example.co.uk/checkout")
    assert not auth_realm_matches_url("example.co.uk", "https://notexample.co.uk/")
    assert not auth_realm_matches_url("amazon.com", "https://signin.aws.amazon.com/")


async def test_realm_payload_hydrates_password_and_passkey_without_exposing_plaintext() -> None:
    from domains.spawn_browser_agent_v3.credential_runtime import build_realm_credential_state

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_key_b64 = base64.b64encode(
        private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    ).decode("ascii")
    payload = {
        "auth_realm": "doordash.com",
        "auth_options": {
            "realm": "doordash.com",
            "cookie_bundles": [{"id": "cookie-1", "disabled": False}],
            "passwords": [
                {
                    "id": "password-1",
                    "origin": "https://www.doordash.com/login",
                    "username": "alice@example.com",
                    "ref": "pwd:alice@example.com",
                    "disabled": False,
                }
            ],
            "passkeys": [
                {
                    "id": "passkey-1",
                    "rpId": "doordash.com",
                    "credentialId": "credential-1",
                    "disabled": False,
                }
            ],
        },
        "passwords": [
            {
                "id": "password-1",
                "origin": "https://www.doordash.com/login",
                "username": "alice@example.com",
                "encryptedPassword": "encrypted-password",
            }
        ],
        "passkeys": [
            {
                "id": "passkey-1",
                "credentialId": "credential-1",
                "encryptedPrivateKey": "encrypted-passkey",
                "rpId": "doordash.com",
                "userHandle": "user-1",
                "signCount": 9,
            }
        ],
        "auth_credential_ref": {"kind": "cookie_bundle", "id": "cookie-1"},
    }

    plaintext = {
        "encrypted-password": "correct horse battery staple",
        "encrypted-passkey": "pkcs8-private-key",
    }
    state = await build_realm_credential_state(
        payload,
        decryption_key=private_key_b64,
        decrypt_secret=lambda encrypted, _key: plaintext.get(encrypted),
    )

    assert state.auth_realm == "doordash.com"
    assert state.password_secret_refs == {"pwd:alice@example.com": "correct horse battery staple"}
    assert "correct horse battery staple" not in state.auth_options_section
    assert state.decrypted_passkeys == [
        {
            "credentialId": "credential-1",
            "privateKey": "pkcs8-private-key",
            "rpId": "doordash.com",
            "userHandle": "user-1",
            "signCount": 9,
        }
    ]
    assert state.credential_refs_by_secret_ref["pwd:alice@example.com"] == {
        "kind": "password",
        "id": "password-1",
    }
    assert state.passkey_ref_by_credential_id["credential-1"] == {
        "kind": "passkey",
        "id": "passkey-1",
    }


async def test_initial_and_resume_hydration_fail_closed_on_unusable_secrets() -> None:
    from domains.spawn_browser_agent_v3.credential_runtime import build_realm_credential_state

    payload = {
        "auth_realm": "doordash.com",
        "auth_options": {
            "realm": "doordash.com",
            "passwords": [
                {
                    "id": "password-1",
                    "origin": "https://doordash.com/login",
                    "username": "fixture@example.com",
                    "ref": "pwd:fixture@example.com",
                    "disabled": False,
                }
            ],
            "passkeys": [],
        },
        "passwords": [
            {
                "id": "password-1",
                "origin": "https://doordash.com/login",
                "username": "fixture@example.com",
                "encryptedPassword": "unusable-ciphertext",
            }
        ],
        "passkeys": [],
    }

    for phase in ("initial", "resume"):
        try:
            await build_realm_credential_state(payload, decryption_key=None)
        except RuntimeError as error:
            assert "decryption key is unavailable" in str(error), (phase, error)
        else:
            raise AssertionError(f"{phase} hydration accepted a missing decryption key")


async def test_prepare_browser_auth_uses_unified_realm_endpoint() -> None:
    from domains.spawn_browser_agent_v3.repo import prepare_browser_auth

    setup_mock(
        {
            "/api/browser-session/session-1/prepare-auth": {
                "status": 200,
                "json": {
                    "auth_realm": "doordash.com",
                    "auth_options": {"realm": "doordash.com"},
                    "passwords": [],
                    "passkeys": [],
                },
            }
        }
    )
    config = SimpleNamespace(backend=SimpleNamespace(api_url="https://backend.example.com", api_key="internal-key"))
    result = await prepare_browser_auth(
        config,
        user_id="user-1",
        session_id="session-1",
        target_url="https://www.doordash.com/store/example",
    )

    assert result["auth_realm"] == "doordash.com"
    call = assert_captured_call(
        url_contains="/api/browser-session/session-1/prepare-auth",
        method="POST",
        body_contains={"target_url": "https://www.doordash.com/store/example"},
        header_present="x-user-id",
    )
    assert call["requestHeaders"]["x-user-id"] == "user-1"


def _fake_webauthn_session(send, target_id: str = "target-a"):
    """Minimal stand-in for browser-use's BrowserSession.

    DOMService resolves the live focus target for every browser-process
    operation, so tests must be able to move the agent between targets.
    """
    session = SimpleNamespace(agent_focus_target_id=target_id)

    async def get_or_create_cdp_session(tid, focus=False):
        async def scoped_send(method, params=None, _tid=tid):
            return await send(method, params or {}, _tid)

        return SimpleNamespace(send=scoped_send, session_id=f"session-{tid}")

    session.get_or_create_cdp_session = get_or_create_cdp_session
    return session


def _webauthn_browser_double():
    """A fake Chrome whose virtual authenticators are target-scoped, like the real one."""
    state = SimpleNamespace(calls=[], enabled=set(), authenticators={}, next_id=0)

    def reset_environment(target_id: str) -> None:
        """Mirror Chrome: losing the environment destroys that target's authenticators."""
        state.enabled.discard(target_id)
        for authenticator_id, (owner, _) in list(state.authenticators.items()):
            if owner == target_id:
                del state.authenticators[authenticator_id]

    state.reset_environment = reset_environment

    async def send(method: str, params: dict, target_id: str):
        state.calls.append((method, target_id))
        if method == "WebAuthn.enable":
            state.enabled.add(target_id)
            return {}
        if method == "Page.setInterceptFileChooserDialog":
            return {}
        if method == "WebAuthn.addVirtualAuthenticator":
            if target_id not in state.enabled:
                raise RuntimeError(
                    "The Virtual Authenticator Environment has not been enabled for this session"
                )
            state.next_id += 1
            authenticator_id = f"authenticator-{state.next_id}"
            state.authenticators[authenticator_id] = (target_id, {})
            return {"authenticatorId": authenticator_id}
        if method == "WebAuthn.addCredential":
            if params["authenticatorId"] not in state.authenticators:
                raise RuntimeError(
                    {"code": -32602, "message": "Could not find a Virtual Authenticator matching the ID"}
                )
            owner, creds = state.authenticators[params["authenticatorId"]]
            if owner not in state.enabled:
                raise RuntimeError(
                    "The Virtual Authenticator Environment has not been enabled for this session"
                )
            credential = dict(params["credential"])
            creds[credential["credentialId"]] = credential
            return {}
        if method == "WebAuthn.getCredentials":
            if params["authenticatorId"] not in state.authenticators:
                raise RuntimeError(
                    {"code": -32602, "message": "Could not find a Virtual Authenticator matching the ID"}
                )
            owner, creds = state.authenticators[params["authenticatorId"]]
            if owner not in state.enabled:
                raise RuntimeError(
                    "The Virtual Authenticator Environment has not been enabled for this session"
                )
            return {"credentials": list(creds.values())}
        raise AssertionError(method)

    return state, send


AMAZON_PASSKEY = {
    "credentialId": "credential-amazon",
    "privateKey": "private-amazon",
    "rpId": "amazon.com.mx",
    "signCount": 7,
}


async def test_passkey_injection_reenables_virtual_environment_at_use_boundary() -> None:
    """Kernel can drop WebAuthn state after connect but before credential hydration."""
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    dom = DOMService(cdp_url="")
    dom._session = _fake_webauthn_session(send)

    seeded = await dom.inject_passkeys([AMAZON_PASSKEY])

    assert seeded == 1
    methods = [method for method, _ in state.calls]
    assert methods[0] == "WebAuthn.enable"
    assert methods.index("WebAuthn.enable") < methods.index("WebAuthn.addVirtualAuthenticator")


async def test_passkeys_from_multiple_realms_share_one_live_authenticator() -> None:
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    dom = DOMService(cdp_url="")
    dom._session = _fake_webauthn_session(send)

    first = await dom.inject_passkeys(
        [
            {
                "credentialId": "credential-a",
                "privateKey": "private-a",
                "rpId": "order.online",
                "signCount": 1,
            }
        ]
    )
    second = await dom.inject_passkeys(
        [
            {
                "credentialId": "credential-b",
                "privateKey": "private-b",
                "rpId": "doordash.com",
                "signCount": 3,
            }
        ]
    )

    assert first == 1 and second == 1
    methods = [method for method, _ in state.calls]
    assert methods.count("WebAuthn.enable") == 1
    assert methods.count("WebAuthn.addVirtualAuthenticator") == 1
    assert len(state.authenticators) == 1
    _, creds = next(iter(state.authenticators.values()))
    assert sorted(creds) == ["credential-a", "credential-b"]


async def test_passkey_injection_recovers_after_virtual_environment_loss() -> None:
    """Chrome's lost-authenticator-id error must rebuild passkey state."""
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    dom = DOMService(cdp_url="")
    dom._session = _fake_webauthn_session(send)

    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1

    # Exact live boundary from benchmark agent 0a15da0a: the target's WebAuthn
    # environment was reset while DOMService retained the old authenticator id
    # and seed cache. The next enable succeeds, then getCredentials reports
    # "Could not find a Virtual Authenticator matching the ID".
    state.reset_environment("target-a")

    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    methods = [method for method, _ in state.calls]
    assert methods.count("WebAuthn.addVirtualAuthenticator") == 2
    assert methods.count("WebAuthn.addCredential") == 2
    assert await dom.read_passkey_signcounts() == {"credential-amazon": 7}


async def test_passkey_and_native_ui_suppression_follow_the_agent_to_a_new_target() -> None:
    """The wedge from agent e36c8759: Chrome scopes both per target.

    Amazon's buy-now flow moved the agent onto a new target. Arming only the
    connect-time target left the new one with no suppression and no credential,
    so Chrome raised its own "No passkeys available" modal -- a browser-process
    surface no CDP input can reach -- while our readback still reported healthy.
    """
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    dom = DOMService(cdp_url="")
    session = _fake_webauthn_session(send, target_id="target-a")
    dom._session = session

    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1

    # The agent follows Amazon's sign-in flow onto a different target.
    session.agent_focus_target_id = "target-b"
    await dom.ensure_browser_overlays_suppressed()

    assert "target-b" in state.enabled, "native WebAuthn UI was not suppressed on the new target"
    live = [
        creds
        for owner, creds in state.authenticators.values()
        if owner == "target-b"
    ]
    assert live, "no virtual authenticator was created on the new target"
    assert "credential-amazon" in live[0], "the held passkey was not seeded onto the new target"


async def test_native_ui_suppression_is_armed_even_with_no_passkeys_for_the_site() -> None:
    """Almost every site is one we hold no passkey for; it still must not wedge.

    With suppression armed a ceremony rejects immediately (NotAllowedError) and
    the site falls back to password. Without it, Chrome raises a native chooser
    that the agent can neither see in a CDP screenshot nor dismiss with CDP input.
    """
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    dom = DOMService(cdp_url="")
    dom._session = _fake_webauthn_session(send, target_id="target-a")

    assert await dom.inject_passkeys([]) == 0

    assert "target-a" in state.enabled, (
        "WebAuthn native UI was left enabled for a site we hold no passkey for"
    )
    assert any(owner == "target-a" for owner, _ in state.authenticators.values()), (
        "suppression had no empty virtual authenticator to make ceremonies fail fast"
    )


async def test_ceremony_capable_actions_arm_the_live_target_before_running() -> None:
    """Arming at step start is not enough: the target can change mid-step."""
    from domains.spawn_browser_agent_v3.service_actions import (
        _CEREMONY_CAPABLE_ACTIONS,
        execute_action,
    )

    for action_name in ("click", "input_text", "press_key", "goto"):
        assert action_name in _CEREMONY_CAPABLE_ACTIONS, action_name

    armed: list[str] = []
    dom_service = SimpleNamespace(
        session=SimpleNamespace(),
        selector_map={},
        ensure_browser_overlays_suppressed=AsyncMock(
            side_effect=lambda: armed.append("armed")
        ),
    )

    # The action itself needs a real browser to finish; all this asserts is that
    # arming is ordered BEFORE any of that work is attempted.
    try:
        await execute_action(
            dom_service=dom_service,
            action_history=SimpleNamespace(),
            action={"action": "press_key", "params": {"key": "Escape"}},
        )
    except Exception:
        pass

    assert armed == ["armed"], "press_key ran without arming the live target"


async def run_all_tests():
    print("browser-credentials blackbox tests:")
    runner = BlackboxResult()
    runner.record(
        "steel_cdp_key_is_materialized_only_at_connection_boundary",
        test_steel_cdp_key_is_materialized_only_at_connection_boundary,
    )
    await runner.record_async(
        "cross_realm_goto_prepares_complete_credentials_before_navigation",
        test_cross_realm_goto_prepares_complete_credentials_before_navigation,
    )
    await runner.record_async(
        "cross_realm_goto_continues_guest_navigation_when_optional_prep_fails",
        test_cross_realm_goto_continues_guest_navigation_when_optional_prep_fails,
    )
    await runner.record_async(
        "redirected_realm_failure_is_quarantined_after_any_prep_stage",
        test_redirected_realm_failure_is_quarantined_after_any_prep_stage,
    )
    runner.record(
        "worker_and_backend_use_the_same_canonical_auth_realms",
        test_worker_and_backend_use_the_same_canonical_auth_realms,
    )
    await runner.record_async(
        "realm_payload_hydrates_password_and_passkey_without_exposing_plaintext",
        test_realm_payload_hydrates_password_and_passkey_without_exposing_plaintext,
    )
    await runner.record_async(
        "initial_and_resume_hydration_fail_closed_on_unusable_secrets",
        test_initial_and_resume_hydration_fail_closed_on_unusable_secrets,
    )
    await runner.record_async(
        "prepare_browser_auth_uses_unified_realm_endpoint",
        test_prepare_browser_auth_uses_unified_realm_endpoint,
    )
    await runner.record_async(
        "passkey_injection_reenables_virtual_environment_at_use_boundary",
        test_passkey_injection_reenables_virtual_environment_at_use_boundary,
    )
    await runner.record_async(
        "passkeys_from_multiple_realms_share_one_live_authenticator",
        test_passkeys_from_multiple_realms_share_one_live_authenticator,
    )
    await runner.record_async(
        "passkey_injection_recovers_after_virtual_environment_loss",
        test_passkey_injection_recovers_after_virtual_environment_loss,
    )
    await runner.record_async(
        "passkey_and_native_ui_suppression_follow_the_agent_to_a_new_target",
        test_passkey_and_native_ui_suppression_follow_the_agent_to_a_new_target,
    )
    await runner.record_async(
        "native_ui_suppression_is_armed_even_with_no_passkeys_for_the_site",
        test_native_ui_suppression_is_armed_even_with_no_passkeys_for_the_site,
    )
    await runner.record_async(
        "ceremony_capable_actions_arm_the_live_target_before_running",
        test_ceremony_capable_actions_arm_the_live_target_before_running,
    )
    return runner.all_passed
