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
        public_url = "wss://connect.steelbrowser.com?sessionId=session-1"
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


async def test_passkey_injection_reenables_virtual_environment_at_use_boundary() -> None:
    """Kernel can drop WebAuthn state after connect but before credential hydration."""
    from browser_tools.dom_service import DOMService

    calls: list[str] = []
    webauthn_enabled = False

    async def send(method: str, params: dict):
        nonlocal webauthn_enabled
        calls.append(method)
        if method == "WebAuthn.enable":
            webauthn_enabled = True
            return {}
        if method == "WebAuthn.addVirtualAuthenticator":
            if not webauthn_enabled:
                raise RuntimeError(
                    {
                        "code": -32000,
                        "message": "The Virtual Authenticator Environment has not been enabled for this session",
                    }
                )
            return {"authenticatorId": "authenticator-1"}
        if method == "WebAuthn.addCredential":
            return {}
        if method == "WebAuthn.getCredentials":
            return {"credentials": [{"credentialId": "credential-google", "signCount": 0}]}
        raise AssertionError(method)

    dom = DOMService(cdp_url="")
    dom._webauthn_cdp = SimpleNamespace(send=send)
    seeded = await dom.inject_passkeys(
        [
            {
                "credentialId": "credential-google",
                "privateKey": "private-google",
                "rpId": "google.com",
                "signCount": 0,
            }
        ]
    )

    assert seeded == 1
    assert calls[:2] == ["WebAuthn.enable", "WebAuthn.addVirtualAuthenticator"]


async def test_passkeys_from_multiple_realms_share_one_live_authenticator() -> None:
    from browser_tools.dom_service import DOMService

    credentials: list[dict] = []
    calls: list[str] = []

    async def send(method: str, params: dict):
        calls.append(method)
        if method == "WebAuthn.enable":
            return {}
        if method == "WebAuthn.addVirtualAuthenticator":
            return {"authenticatorId": "authenticator-1"}
        if method == "WebAuthn.addCredential":
            credentials.append(dict(params["credential"]))
            return {}
        if method == "WebAuthn.getCredentials":
            return {"credentials": list(credentials)}
        raise AssertionError(method)

    dom = DOMService(cdp_url="")
    dom._webauthn_cdp = SimpleNamespace(send=send)
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
    assert calls.count("WebAuthn.enable") == 1
    assert calls.count("WebAuthn.addVirtualAuthenticator") == 1
    assert [credential["credentialId"] for credential in credentials] == [
        "credential-a",
        "credential-b",
    ]


async def test_passkey_injection_recovers_after_virtual_environment_loss() -> None:
    """A navigation-reset WebAuthn environment must be rebuilt before passkey use."""
    from browser_tools.dom_service import DOMService

    calls: list[str] = []
    credentials: list[dict] = []
    webauthn_enabled = False
    authenticator_number = 0

    async def send(method: str, params: dict):
        nonlocal authenticator_number, webauthn_enabled
        calls.append(method)
        if method == "WebAuthn.enable":
            webauthn_enabled = True
            return {}
        if method == "WebAuthn.addVirtualAuthenticator":
            if not webauthn_enabled:
                raise AssertionError("authenticator created before WebAuthn.enable")
            authenticator_number += 1
            return {"authenticatorId": f"authenticator-{authenticator_number}"}
        if method == "WebAuthn.addCredential":
            if not webauthn_enabled:
                raise AssertionError("credential added before WebAuthn.enable")
            credentials.append(dict(params["credential"]))
            return {}
        if method == "WebAuthn.getCredentials":
            if not webauthn_enabled:
                raise RuntimeError(
                    {
                        "code": -32000,
                        "message": "The Virtual Authenticator Environment has not been enabled for this session",
                    }
                )
            return {"credentials": list(credentials)}
        raise AssertionError(method)

    dom = DOMService(cdp_url="")
    dom._webauthn_cdp = SimpleNamespace(send=send)
    passkeys = [
        {
            "credentialId": "credential-amazon",
            "privateKey": "private-amazon",
            "rpId": "amazon.com",
            "signCount": 7,
        }
    ]

    assert await dom.inject_passkeys(passkeys) == 1

    # Reproduce the live boundary: the target navigation invalidated WebAuthn,
    # while DOMService retained the old authenticator id and seed cache.
    webauthn_enabled = False
    credentials.clear()

    assert await dom.inject_passkeys(passkeys) == 1
    assert calls.count("WebAuthn.enable") == 2
    assert calls.count("WebAuthn.addVirtualAuthenticator") == 2
    assert calls.count("WebAuthn.addCredential") == 2
    assert await dom.read_passkey_signcounts() == {"credential-amazon": 7}


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
    return runner.all_passed
