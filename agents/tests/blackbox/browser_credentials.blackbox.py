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


def test_tool_results_never_echo_a_saved_password_or_card_number() -> None:
    """A page-script result that reads a typed password back must not put it in the model's context.

    Seen in a hosted-auth benchmark lane: the agent ran `evaluate` on the sign-in
    form, the result carried the decrypted password, and the plaintext then
    appeared in the agent's reasoning and transcript.
    """
    from domains.spawn_browser_agent_v3.service_crypto import mask_secret_values

    secret_refs = {
        "pwd:avery@example.com": "hunter2-correct#7a",
        "card_number": "4242424242424242",
        "card_cvv": "123",
        "card_name": "Avery Ross",
    }
    result = {
        "success": True,
        "result": 'email=avery@example.com password="hunter2-correct#7a"',
        "nested": [{"value": "card 4242424242424242 cvv 123 for Avery Ross"}],
        "count": 3,
    }
    masked = mask_secret_values(result, secret_refs)
    assert masked["result"] == 'email=avery@example.com password="pwd:avery@example.com"', masked
    assert masked["nested"][0]["value"] == "card card_number cvv 123 for Avery Ross", masked
    assert masked["count"] == 3 and masked["success"] is True
    assert result["result"].endswith('hunter2-correct#7a"'), "the caller's result is not mutated"
    assert mask_secret_values("nothing secret here", secret_refs) == "nothing secret here"
    assert mask_secret_values({"result": "x"}, None) == {"result": "x"}


async def test_minted_account_is_offered_a_new_password_ref_that_is_saved_when_typed() -> None:
    """A sign-up password is typed by ref and kept, so the new account can be signed into later.

    Before this the agent made up a password at sign-up and nothing saved it: the
    account it had just created was unreachable on the next run.
    """
    from _test_utils import get_captured_requests, teardown_mock
    from domains.spawn_browser_agent_v3.repo import save_minted_account_password
    from domains.spawn_browser_agent_v3.service_crypto import (
        MINTED_NEW_PASSWORD_REF,
        build_auth_options_prompt_section,
    )

    minted = {
        "id": "minted-row-1",
        "email": "rose.cedar11@mail.example",
        "phone": None,
        "disabled": False,
        "newPassword": {"ref": "pwd:new", "encryptedPassword": "envelope"},
    }
    section, encrypted_refs, _origins, credential_refs = build_auth_options_prompt_section(
        {"realm": "shop.example", "minted": minted}
    )
    assert MINTED_NEW_PASSWORD_REF == "pwd:new"
    assert (
        "- Minted account: Email -> rose.cedar11@mail.example | Sign-up password ref: pwd:new | enabled" in section
    ), section
    assert encrypted_refs == {"pwd:new": "envelope"}, "the worker decrypts the ref like any saved password"
    assert credential_refs["pwd:new"] == {"kind": "minted_account", "id": "minted-row-1"}

    older_backend, refs, _origins, _credential_refs = build_auth_options_prompt_section(
        {"realm": "shop.example", "minted": {**minted, "newPassword": None}}
    )
    assert "password ref" not in older_backend and refs == {}

    setup_mock({"/api/auth-options/minted-password": {"status": 200, "json": {"saved": True}}})
    try:
        config = SimpleNamespace(backend=SimpleNamespace(api_url="https://backend.example.com", api_key="k1"))
        saved = await save_minted_account_password(config, "user-1", "https://shop.example/signup")
        assert saved is True
        call = assert_captured_call(
            0,
            url_contains="/api/auth-options/minted-password",
            method="POST",
            body_contains={"origin": "https://shop.example/signup"},
        )
        headers = {str(key).lower(): value for key, value in (call.get("requestHeaders") or {}).items()}
        assert headers.get("x-user-id") in (None, "user-1"), headers
        assert len(get_captured_requests()) == 1
    finally:
        teardown_mock()


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
    # Hosted benchmark sign-in sites sit behind whichever dev tunnel run.sh opened.
    for tunnel_host in ("abc.trycloudflare.com", "abc.ngrok-free.app", "abc.ngrok-free.dev"):
        site_url = f"https://{tunnel_host}/api/test-sites/rose-shop/abc/login?authRealm=rose-shop-abc.test"
        assert auth_realm_from_url(site_url) == "rose-shop-abc.test"
        assert auth_realm_matches_url("rose-shop-abc.test", site_url)
    assert auth_realm_from_url("https://shop.example.com/?authRealm=amazon.com") == "shop.example.com"
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
        if method == "WebAuthn.disable":
            state.enabled.discard(target_id)
            for authenticator_id, (owner, _) in list(state.authenticators.items()):
                if owner == target_id:
                    del state.authenticators[authenticator_id]
            return {}
        if method == "Page.setInterceptFileChooserDialog":
            return {}
        if method == "WebAuthn.addVirtualAuthenticator":
            if target_id not in state.enabled:
                raise RuntimeError(
                    "The Virtual Authenticator Environment has not been enabled for this session"
                )
            # Chrome: only one internal authenticator per environment.
            for authenticator_id, (owner, _) in state.authenticators.items():
                if owner == target_id:
                    raise RuntimeError(
                        {
                            "code": -32602,
                            "message": "Chrome only supports one internal authenticator per environment",
                        }
                    )
            state.next_id += 1
            authenticator_id = f"authenticator-{state.next_id}"
            state.authenticators[authenticator_id] = (target_id, {})
            return {"authenticatorId": authenticator_id}
        if method == "WebAuthn.removeVirtualAuthenticator":
            authenticator_id = params.get("authenticatorId")
            if authenticator_id not in state.authenticators:
                raise RuntimeError(
                    {"code": -32602, "message": "Could not find a Virtual Authenticator matching the ID"}
                )
            del state.authenticators[authenticator_id]
            return {}
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
        if method == "Runtime.evaluate":
            return {"result": {"value": "https://www.amazon.com/"}}
        if method == "Page.reload":
            return {}
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


async def test_passkey_payload_validation_is_atomic() -> None:
    """One malformed credential must not retain earlier entries from the payload."""
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    dom = DOMService(cdp_url="")
    dom._session = _fake_webauthn_session(send)
    malformed = {
        "credentialId": "credential-incomplete",
        "rpId": "example.com",
    }

    try:
        await dom.inject_passkeys([AMAZON_PASSKEY, malformed])
        raise AssertionError("expected malformed passkey payload to fail")
    except RuntimeError as error:
        assert "Incomplete passkey payload" in str(error)

    assert dom._held_passkeys_by_credential_id == {}
    assert state.calls == [], "browser state changed before the full payload was validated"


async def test_passkey_readback_transport_failure_keeps_seeded_authenticator() -> None:
    """A transient verification read must not discard credentials that were added successfully."""
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    failed_readback = False

    async def flaky_send(method: str, params: dict, target_id: str):
        nonlocal failed_readback
        if method == "WebAuthn.getCredentials" and not failed_readback:
            failed_readback = True
            raise RuntimeError("transient CDP transport failure")
        return await send(method, params, target_id)

    dom = DOMService(cdp_url="")
    dom._session = _fake_webauthn_session(flaky_send)

    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    assert failed_readback
    assert dom._passkey_seeded_by_target["target-a"] == {"credential-amazon"}
    assert await dom.read_passkey_signcounts() == {"credential-amazon": 7}


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


async def test_passkey_sync_skips_rebuild_after_transient_getcredentials_failure() -> None:
    """A flaky getCredentials during an in-flight ceremony must not rebuild.

    Agent f380ca3c: rebuilding (WebAuthn.enable + new authenticator) mid-ceremony
    produced Amazon's "No passkeys available" dialog. Retry once; if credentials
    are still present, keep the live authenticator.
    """
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    fail_next_get_credentials = {"armed": False, "failures": 0}

    async def flaky_then_ok(method: str, params: dict, target_id: str):
        if method == "WebAuthn.getCredentials" and fail_next_get_credentials["armed"]:
            fail_next_get_credentials["armed"] = False
            fail_next_get_credentials["failures"] += 1
            raise RuntimeError(
                "Could not find a Virtual Authenticator matching the ID"
            )
        return await send(method, params, target_id)

    dom = DOMService(cdp_url="")
    dom._session = _fake_webauthn_session(flaky_then_ok)

    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    enable_before = sum(1 for method, _ in state.calls if method == "WebAuthn.enable")
    authenticator_before = sum(
        1 for method, _ in state.calls if method == "WebAuthn.addVirtualAuthenticator"
    )

    # Arm a single transient failure on the next health-check getCredentials.
    fail_next_get_credentials["armed"] = True
    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 0
    assert fail_next_get_credentials["failures"] == 1
    enable_after = sum(1 for method, _ in state.calls if method == "WebAuthn.enable")
    authenticator_after = sum(
        1 for method, _ in state.calls if method == "WebAuthn.addVirtualAuthenticator"
    )
    assert enable_after == enable_before, "transient failure must not re-enable WebAuthn"
    assert authenticator_after == authenticator_before, (
        "transient failure must not create a replacement authenticator"
    )
    assert await dom.read_passkey_signcounts() == {"credential-amazon": 7}


async def test_invalidate_forces_rebuild_when_health_check_would_trust_stale() -> None:
    """Post-nav false-healthy getCredentials must not skip re-seed.

    Agents f380ca3c / c3b1ca09: after start navigation, getCredentials still
    returned the pre-nav credentials (``seeded 0``) while Kernel's virtual
    authenticator environment was already dying. Amazon probed the empty
    environment seconds later and disabled the passkey CTA. Callers that know
    a navigation/target boundary just happened must invalidate so the next
    sync re-enables + re-seeds instead of trusting that health check.

    Invalidate must also remove the Chrome-side authenticator — forgetting the
    cache alone leaves the old internal authenticator in place and the next
    ``addVirtualAuthenticator`` fails with ``Chrome only supports one internal
    authenticator per environment`` (agent f203ae7b).
    """
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    dom = DOMService(cdp_url="")
    dom._session = _fake_webauthn_session(send)

    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    authenticator_before = sum(
        1 for method, _ in state.calls if method == "WebAuthn.addVirtualAuthenticator"
    )
    add_cred_before = sum(1 for method, _ in state.calls if method == "WebAuthn.addCredential")
    enable_before = sum(1 for method, _ in state.calls if method == "WebAuthn.enable")
    old_authenticator_ids = set(state.authenticators)

    # Without invalidate, a healthy health-check is a no-op reseed.
    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 0
    assert (
        sum(1 for method, _ in state.calls if method == "WebAuthn.addVirtualAuthenticator")
        == authenticator_before
    )

    # Invalidate removes the Chrome-side authenticator, then the next sync
    # creates a fresh one + re-seeds (cannot trust the dying health check).
    await dom.invalidate_passkey_state_for_live_target()
    assert any(method == "WebAuthn.removeVirtualAuthenticator" for method, _ in state.calls)
    assert not (old_authenticator_ids & set(state.authenticators)), (
        "invalidate must remove the stale Chrome-side authenticator before recreate"
    )
    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    assert (
        sum(1 for method, _ in state.calls if method == "WebAuthn.addVirtualAuthenticator")
        == authenticator_before + 1
    )
    assert (
        sum(1 for method, _ in state.calls if method == "WebAuthn.addCredential")
        == add_cred_before + 1
    )
    # Agent c1ebd389: invalidate must drop armed so the next sync re-issues
    # WebAuthn.enable (remove-only left a half-armed environment Kernel killed).
    assert sum(1 for method, _ in state.calls if method == "WebAuthn.enable") == enable_before + 1
    assert await dom.read_passkey_signcounts() == {"credential-amazon": 7}


async def test_passkey_environment_not_enabled_rebuilds_immediately() -> None:
    """Kernel's environment-not-enabled is a hard reset, not ceremony grace.

    Agent c1ebd389 (browser-amazon-return 2026-09-28): VA died ~5.6s after every
    successful seed with ``The Virtual Authenticator Environment has not been
    enabled for this session`` and never recovered on retry. Ceremony-grace
    retries delayed rebuild while Amazon disabled the passkey CTA.
    """
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    remaining_failures = {"n": 0}

    async def hard_reset(method: str, params: dict, target_id: str):
        if method == "WebAuthn.getCredentials" and remaining_failures["n"] > 0:
            remaining_failures["n"] -= 1
            raise RuntimeError(
                "The Virtual Authenticator Environment has not been enabled for this session"
            )
        return await send(method, params, target_id)

    dom = DOMService(cdp_url="")
    dom._session = _fake_webauthn_session(hard_reset)

    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    enable_before = sum(1 for method, _ in state.calls if method == "WebAuthn.enable")
    authenticator_before = sum(
        1 for method, _ in state.calls if method == "WebAuthn.addVirtualAuthenticator"
    )

    # Persistent environment loss — must rebuild on first failure (no grace burn).
    remaining_failures["n"] = 3
    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    # Immediate rebuild: at most the health-check failure (+ optional readback)
    # consumed getCredentials errors — not the full 5-attempt grace window.
    assert remaining_failures["n"] >= 1
    assert sum(1 for method, _ in state.calls if method == "WebAuthn.enable") >= enable_before + 1
    assert (
        sum(1 for method, _ in state.calls if method == "WebAuthn.addVirtualAuthenticator")
        >= authenticator_before + 1
    )
    remaining_failures["n"] = 0  # stop mocking so usage readback can observe the rebuild
    assert await dom.read_passkey_signcounts() == {"credential-amazon": 7}


async def test_passkey_ceremony_grace_retries_before_rebuild() -> None:
    """Recent seed + authenticator-id flap must stretch retries, not rebuild.

    Mid-ceremony flaps within 5s of a successful seed (Amazon Sign-in-with-
    Passkey) must not tear down the live authenticator. Environment-not-enabled
    is a hard Kernel reset (see test_passkey_environment_not_enabled_rebuilds_immediately);
    grace applies only to the authenticator-id mismatch flap.
    """
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    remaining_failures = {"n": 0}

    async def flaky_burst(method: str, params: dict, target_id: str):
        if method == "WebAuthn.getCredentials" and remaining_failures["n"] > 0:
            remaining_failures["n"] -= 1
            raise RuntimeError(
                "Could not find a Virtual Authenticator matching the ID"
            )
        return await send(method, params, target_id)

    dom = DOMService(cdp_url="")
    dom._session = _fake_webauthn_session(flaky_burst)

    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    enable_before = sum(1 for method, _ in state.calls if method == "WebAuthn.enable")
    authenticator_before = sum(
        1 for method, _ in state.calls if method == "WebAuthn.addVirtualAuthenticator"
    )

    # Three transient authenticator-id failures within ceremony grace — must recover, not rebuild.
    remaining_failures["n"] = 3
    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 0
    assert remaining_failures["n"] == 0
    assert sum(1 for method, _ in state.calls if method == "WebAuthn.enable") == enable_before
    assert (
        sum(1 for method, _ in state.calls if method == "WebAuthn.addVirtualAuthenticator")
        == authenticator_before
    )
    assert await dom.read_passkey_signcounts() == {"credential-amazon": 7}


async def test_passkey_cdp_session_change_rearms_webauthn() -> None:
    """A new CDP session_id under the same target must re-enable WebAuthn.

    Agent c1ebd389: Kernel recycled the pooled session; getCredentials then
    reported environment-not-enabled for the new session while our cache still
    thought the old authenticator was healthy.
    """
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    session = _fake_webauthn_session(send, target_id="target-a")
    session_holder = {"id": "session-target-a"}

    async def get_or_create_cdp_session(tid, focus=False):
        async def scoped_send(method, params=None, _tid=tid):
            return await send(method, params or {}, _tid)

        return SimpleNamespace(send=scoped_send, session_id=session_holder["id"])

    session.get_or_create_cdp_session = get_or_create_cdp_session
    dom = DOMService(cdp_url="")
    dom._session = session

    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    enable_before = sum(1 for method, _ in state.calls if method == "WebAuthn.enable")

    session_holder["id"] = "session-target-a-recycled"
    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    # Re-arm issues WebAuthn.enable; one_internal retry may enable once more
    # after disable — both count as correct recovery of the new CDP session.
    assert sum(1 for method, _ in state.calls if method == "WebAuthn.enable") >= enable_before + 1
    assert await dom.read_passkey_signcounts() == {"credential-amazon": 7}


async def test_passkey_rebuild_reloads_amazon_signin_page() -> None:
    """After VA environment loss on Amazon sign-in, reload so the CTA re-probes."""
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    # Host must match held passkey rpId (amazon.com.mx), not a foreign login page.
    href = {
        "value": (
            "https://www.amazon.com.mx/ap/signin?"
            "openid.return_to=https%3A%2F%2Fwww.amazon.com.mx%2F"
        )
    }

    async def send_with_reload(method: str, params: dict, target_id: str):
        if method == "Runtime.evaluate":
            return {"result": {"value": href["value"]}}
        if method == "Page.reload":
            state.calls.append((method, target_id))
            return {}
        return await send(method, params, target_id)

    dom = DOMService(cdp_url="")
    dom._session = _fake_webauthn_session(send_with_reload)

    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    state.reset_environment("target-a")
    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    assert any(method == "Page.reload" for method, _ in state.calls), (
        "VA rebuild on Amazon sign-in must reload so Conditional UI re-probes"
    )


async def test_passkey_auth_reload_skips_foreign_host_and_same_href() -> None:
    """Reload at most once per href and only when host matches a held rpId."""
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    href = {"value": "https://accounts.google.com/signin"}

    async def send_with_reload(method: str, params: dict, target_id: str):
        if method == "Runtime.evaluate":
            return {"result": {"value": href["value"]}}
        if method == "Page.reload":
            state.calls.append((method, target_id))
            return {}
        return await send(method, params, target_id)

    dom = DOMService(cdp_url="")
    dom._session = _fake_webauthn_session(send_with_reload)

    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    state.reset_environment("target-a")
    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    assert not any(method == "Page.reload" for method, _ in state.calls), (
        "Amazon passkey must not reload an unrelated Google sign-in page"
    )

    href["value"] = (
        "https://www.amazon.com.mx/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com.mx%2F"
    )
    state.reset_environment("target-a")
    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    first_reloads = sum(1 for method, _ in state.calls if method == "Page.reload")
    assert first_reloads == 1

    # Same href after another rebuild must not reload again (preserve typed fields).
    state.reset_environment("target-a")
    # Expire cooldown so only the href gate applies.
    dom._passkey_auth_reload_at_by_target.clear()
    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    assert sum(1 for method, _ in state.calls if method == "Page.reload") == first_reloads


async def test_invalidate_preserves_advanced_signcounts_for_usage() -> None:
    """Invalidate must not erase an assertion that advanced signCount before remove."""
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    dom = DOMService(cdp_url="")
    dom._session = _fake_webauthn_session(send)

    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    # Simulate relying-party assertion advancing the counter on the live VA.
    for _owner, creds in state.authenticators.values():
        if "credential-amazon" in creds:
            creds["credential-amazon"]["signCount"] = 12

    await dom.invalidate_passkey_state_for_live_target()
    assert dom._passkey_observed_max_counts.get("credential-amazon") == 12
    # After invalidate the authenticator map is empty; observed maxima must still
    # surface so disconnect/usage capture works when reinject fails.
    assert await dom.read_passkey_signcounts() == {"credential-amazon": 12}
    assert "credential-amazon" in await dom.get_used_passkey_credential_ids()

    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    # Re-seed must use max(base, observed) so RP never sees a rolled-back counter.
    seeded_counts = [
        creds["credential-amazon"]["signCount"]
        for _owner, creds in state.authenticators.values()
        if "credential-amazon" in creds
    ]
    assert seeded_counts and max(seeded_counts) == 12
    assert "credential-amazon" in await dom.get_used_passkey_credential_ids()


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


async def test_passkey_inject_without_focused_target_retains_held_keys() -> None:
    """Missing focus must not kill the browser agent during opportunistic re-seed.

    Prod a890a362 Task Failed mid-goto with:
      No focused browser target is available for passkey injection
    after a successful navigation cleared agent_focus_target_id. The next
    step's record_passkey_usage_once → inject_passkeys hard-raised and
    aborted the activity. Overlay suppression already soft-fails the same
    condition; passkey inject must retain held keys and re-arm when focus
    returns (re-init all injected state, not kill the run).
    """
    from browser_tools.dom_service import DOMService

    state, send = _webauthn_browser_double()
    dom = DOMService(cdp_url="")
    dom._session = _fake_webauthn_session(send, target_id="")
    dom._session.agent_focus_target_id = None

    seeded = await dom.inject_passkeys([AMAZON_PASSKEY])

    assert seeded == 0
    assert dom._held_passkeys_by_credential_id.get("credential-amazon") == AMAZON_PASSKEY
    assert state.calls == [], "no CDP commands without a focused target"

    # Focus returns → re-arm seeds the retained passkey onto the live target.
    dom._session.agent_focus_target_id = "target-a"
    assert await dom.inject_passkeys([AMAZON_PASSKEY]) == 1
    assert "credential-amazon" in dom._passkey_seeded_by_target.get("target-a", set())


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
        "passkey_payload_validation_is_atomic",
        test_passkey_payload_validation_is_atomic,
    )
    await runner.record_async(
        "passkey_readback_transport_failure_keeps_seeded_authenticator",
        test_passkey_readback_transport_failure_keeps_seeded_authenticator,
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
        "passkey_sync_skips_rebuild_after_transient_getcredentials_failure",
        test_passkey_sync_skips_rebuild_after_transient_getcredentials_failure,
    )
    await runner.record_async(
        "invalidate_forces_rebuild_when_health_check_would_trust_stale",
        test_invalidate_forces_rebuild_when_health_check_would_trust_stale,
    )
    await runner.record_async(
        "invalidate_preserves_advanced_signcounts_for_usage",
        test_invalidate_preserves_advanced_signcounts_for_usage,
    )
    await runner.record_async(
        "passkey_environment_not_enabled_rebuilds_immediately",
        test_passkey_environment_not_enabled_rebuilds_immediately,
    )
    await runner.record_async(
        "passkey_ceremony_grace_retries_before_rebuild",
        test_passkey_ceremony_grace_retries_before_rebuild,
    )
    await runner.record_async(
        "passkey_cdp_session_change_rearms_webauthn",
        test_passkey_cdp_session_change_rearms_webauthn,
    )
    await runner.record_async(
        "passkey_rebuild_reloads_amazon_signin_page",
        test_passkey_rebuild_reloads_amazon_signin_page,
    )
    await runner.record_async(
        "passkey_and_native_ui_suppression_follow_the_agent_to_a_new_target",
        test_passkey_and_native_ui_suppression_follow_the_agent_to_a_new_target,
    )
    await runner.record_async(
        "passkey_inject_without_focused_target_retains_held_keys",
        test_passkey_inject_without_focused_target_retains_held_keys,
    )
    await runner.record_async(
        "native_ui_suppression_is_armed_even_with_no_passkeys_for_the_site",
        test_native_ui_suppression_is_armed_even_with_no_passkeys_for_the_site,
    )
    await runner.record_async(
        "minted_account_is_offered_a_new_password_ref_that_is_saved_when_typed",
        test_minted_account_is_offered_a_new_password_ref_that_is_saved_when_typed,
    )
    runner.record(
        "tool_results_never_echo_a_saved_password_or_card_number",
        test_tool_results_never_echo_a_saved_password_or_card_number,
    )
    await runner.record_async(
        "ceremony_capable_actions_arm_the_live_target_before_running",
        test_ceremony_capable_actions_arm_the_live_target_before_running,
    )
    return runner.all_passed
