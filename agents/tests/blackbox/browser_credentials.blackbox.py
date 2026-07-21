"""Black-box coverage for JIT browser credentials across auth realms."""

from __future__ import annotations

import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from _test_utils import BlackboxResult, assert_captured_call, setup_mock


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


async def test_passkeys_from_multiple_realms_share_one_live_authenticator() -> None:
    from browser_tools.dom_service import DOMService

    credentials: list[dict] = []
    calls: list[str] = []

    async def send(method: str, params: dict):
        calls.append(method)
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
    assert calls.count("WebAuthn.addVirtualAuthenticator") == 1
    assert [credential["credentialId"] for credential in credentials] == [
        "credential-a",
        "credential-b",
    ]


async def run_all_tests():
    print("browser-credentials blackbox tests:")
    runner = BlackboxResult()
    await runner.record_async(
        "cross_realm_goto_prepares_complete_credentials_before_navigation",
        test_cross_realm_goto_prepares_complete_credentials_before_navigation,
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
        "passkeys_from_multiple_realms_share_one_live_authenticator",
        test_passkeys_from_multiple_realms_share_one_live_authenticator,
    )
    return runner.all_passed
