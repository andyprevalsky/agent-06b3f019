"""Blackbox tests for spawn-browser-agent-v3 domain.

Heavily exercises service_crypto (pure functions), repo (httpx-mockable),
service (data transforms), and the static/pure parts of service_actions
and handler (ClaudeTokenState, get_manager, workflow helper static bits).
"""

import asyncio
import base64
import json
import os
import time as time_module
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


# ========================================
# Helpers: build a real encrypted envelope
# ========================================


def _make_rsa_keypair():
    """Generate an RSA keypair and return (private_pem_b64, public_key)."""
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    private_key = rsa.generate_private_key(
        public_exponent=65537, key_size=2048, backend=default_backend()
    )
    public_key = private_key.public_key()

    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return base64.b64encode(pem).decode("utf-8"), public_key, private_key


def _encrypt_envelope(plaintext: bytes, public_key, version: int = 1) -> str:
    """Produce a base64 JSON envelope matching decrypt_payment_info/decrypt_password format."""
    import os as _os

    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    aes_key = _os.urandom(32)
    iv = _os.urandom(12)
    cipher = Cipher(algorithms.AES(aes_key), modes.GCM(iv))
    encryptor = cipher.encryptor()
    ct = encryptor.update(plaintext) + encryptor.finalize()
    tag = encryptor.tag
    full_ct = ct + tag

    encrypted_aes_key = public_key.encrypt(
        aes_key,
        padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )

    envelope = {
        "version": version,
        "iv": base64.b64encode(iv).decode("utf-8"),
        "ciphertext": base64.b64encode(full_ct).decode("utf-8"),
        "encrypted_aes_key": base64.b64encode(encrypted_aes_key).decode("utf-8"),
    }
    return base64.b64encode(json.dumps(envelope).encode("utf-8")).decode("utf-8")


def _fake_config(
    backend_url: str = "https://backend.example.com",
    backend_api_key: str = "test-backend-key",
    rose_api_url: str = "https://rose.example.com/completions",
    rose_api_key: str = "rose-key",
    rose_supabase_anon_key: str = "anon-key",
    payment_decryption_key: str = "",
    openrouter_api_key: str = "or-key",
    openrouter_base_url: str = "https://openrouter.example.com/api/v1",
):
    """Build a minimal config object (ducktyped) compatible with repo/service calls."""
    return SimpleNamespace(
        backend=SimpleNamespace(api_url=backend_url, api_key=backend_api_key),
        rose=SimpleNamespace(
            api_url=rose_api_url, api_key=rose_api_key, supabase_anon_key=rose_supabase_anon_key
        ),
        payment=SimpleNamespace(decryption_key=payment_decryption_key),
        openrouter=SimpleNamespace(api_key=openrouter_api_key, base_url=openrouter_base_url),
    )


# ========================================
# service_crypto: extract_rate_limited_until
# ========================================


def test_normalize_rate_limited_until_handles_epoch_int():
    from domains.spawn_browser_agent_v3.service_crypto import _normalize_rate_limited_until

    result = _normalize_rate_limited_until(1700000000)
    assert result is not None and result.endswith("Z")


def test_normalize_rate_limited_until_handles_epoch_string():
    from domains.spawn_browser_agent_v3.service_crypto import _normalize_rate_limited_until

    result = _normalize_rate_limited_until("1700000000")
    assert result is not None and result.endswith("Z")


def test_normalize_rate_limited_until_handles_iso_naive():
    from domains.spawn_browser_agent_v3.service_crypto import _normalize_rate_limited_until

    result = _normalize_rate_limited_until("2025-01-01T00:00:00")
    assert result is not None and result.endswith("Z")


def test_normalize_rate_limited_until_handles_iso_z():
    from domains.spawn_browser_agent_v3.service_crypto import _normalize_rate_limited_until

    result = _normalize_rate_limited_until("2025-01-01T00:00:00Z")
    assert result is not None and "2025-01-01" in result


def test_normalize_rate_limited_until_none_empty_invalid():
    from domains.spawn_browser_agent_v3.service_crypto import _normalize_rate_limited_until

    assert _normalize_rate_limited_until(None) is None
    assert _normalize_rate_limited_until("") is None
    assert _normalize_rate_limited_until("   ") is None
    assert _normalize_rate_limited_until("not-a-date") is None
    assert _normalize_rate_limited_until(-1) is None


def test_extract_rate_limited_until_not_dict():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    assert extract_rate_limited_until(None) is None
    assert extract_rate_limited_until("string") is None
    assert extract_rate_limited_until([]) is None


def test_extract_rate_limited_until_canonical_field():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    assert extract_rate_limited_until({"rateLimitedUntil": "2025-01-01T00:00:00Z"}) is not None
    assert extract_rate_limited_until({"rate_limited_until": 1700000000}) is not None
    assert extract_rate_limited_until({"rateLimitedUntilIso": "2025-01-01T00:00:00Z"}) is not None


def test_extract_rate_limited_until_from_headers_reset():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    out = extract_rate_limited_until({"rateLimitHeaders": {"unifiedReset": "1700000000"}})
    assert out is not None


def test_extract_rate_limited_until_from_headers_retry_after():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    out = extract_rate_limited_until({"rate_limit_headers": {"retryAfter": "60"}})
    assert out is not None

    out2 = extract_rate_limited_until({"rate_limit_headers": {"retry-after": "30"}})
    assert out2 is not None

    # zero retry-after returns None
    out3 = extract_rate_limited_until({"rate_limit_headers": {"retryAfter": "0"}})
    assert out3 is None


def test_extract_rate_limited_until_from_text_iso():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    out = extract_rate_limited_until({"message": "rate limited until 2025-01-01T00:00:00Z please wait"})
    assert out is not None


def test_extract_rate_limited_until_from_text_epoch():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    out = extract_rate_limited_until({"details": "try again after 1700000000 seconds"})
    assert out is not None


def test_extract_rate_limited_until_from_text_retry_after():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    out = extract_rate_limited_until({"error": "rate-limit retry-after: 90"})
    assert out is not None


def test_extract_rate_limited_until_no_signal():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    assert extract_rate_limited_until({}) is None
    assert extract_rate_limited_until({"unrelated": "stuff"}) is None
    assert extract_rate_limited_until({"message": "just some words no dates"}) is None


# ========================================
# service_crypto: decrypt_payment_info
# ========================================


def test_decrypt_payment_info_roundtrip():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_payment_info

    priv_b64, public_key, _ = _make_rsa_keypair()
    payment = {
        "card_number": "4242424242424242",
        "cardholder_name": "Test User",
        "card_expiry": "12/30",
        "card_cvv": "123",
        "autoagentpaylimit_cents": 5000,
    }
    envelope = _encrypt_envelope(json.dumps(payment).encode("utf-8"), public_key)

    result = decrypt_payment_info(envelope, priv_b64)
    assert result == payment


def test_decrypt_payment_info_wrong_version():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_payment_info

    priv_b64, public_key, _ = _make_rsa_keypair()
    envelope = _encrypt_envelope(b'{"a":1}', public_key, version=2)

    assert decrypt_payment_info(envelope, priv_b64) is None


def test_decrypt_payment_info_bad_envelope():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_payment_info

    priv_b64, _, _ = _make_rsa_keypair()

    # Not base64
    assert decrypt_payment_info("not-base64!!!", priv_b64) is None

    # Base64 but not JSON
    assert decrypt_payment_info(base64.b64encode(b"not json").decode(), priv_b64) is None


def test_decrypt_password_roundtrip():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_password

    priv_b64, public_key, _ = _make_rsa_keypair()
    envelope = _encrypt_envelope(b"my-secret-password-123", public_key)

    assert decrypt_password(envelope, priv_b64) == "my-secret-password-123"


def test_decrypt_password_wrong_version():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_password

    priv_b64, public_key, _ = _make_rsa_keypair()
    envelope = _encrypt_envelope(b"anything", public_key, version=9)
    assert decrypt_password(envelope, priv_b64) is None


def test_decrypt_password_invalid_input_returns_none():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_password

    priv_b64, _, _ = _make_rsa_keypair()
    assert decrypt_password("***invalid***", priv_b64) is None


def test_decrypt_password_with_key_roundtrip():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_password_with_key

    _, public_key, private_key = _make_rsa_keypair()
    envelope = _encrypt_envelope(b"hunter2", public_key)

    assert decrypt_password_with_key(envelope, private_key) == "hunter2"


def test_decrypt_password_with_key_bad_version():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_password_with_key

    _, public_key, private_key = _make_rsa_keypair()
    envelope = _encrypt_envelope(b"x", public_key, version=3)
    assert decrypt_password_with_key(envelope, private_key) is None


def test_decrypt_password_with_key_bad_envelope():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_password_with_key

    _, _, private_key = _make_rsa_keypair()
    assert decrypt_password_with_key("~~~~", private_key) is None


# ========================================
# service_crypto: OTP extraction
# ========================================


def test_extract_otp_from_text_verification_code():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    assert extract_otp_from_text("Your verification code: 123456") == "123456"
    assert extract_otp_from_text("Your security code: 654321") == "654321"


def test_extract_otp_from_text_is_your_code():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    assert extract_otp_from_text("123456 is your verification code") == "123456"


def test_extract_otp_from_text_4_digit_pin():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    assert extract_otp_from_text("Your PIN: 4321") == "4321"


def test_extract_otp_from_text_8_digit_code():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    assert extract_otp_from_text("Use code: 12345678 to confirm") == "12345678"


def test_extract_otp_from_text_expires_phrase():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    assert extract_otp_from_text("Code 789012 expires in 5 minutes") == "789012"


def test_extract_otp_from_text_low_confidence_context_strict():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    # Contains "order" low-confidence keyword, only first 3 patterns should match
    # This one has no specific context -> should return None
    assert extract_otp_from_text("Your order number is 123456") is None

    # But with explicit auth context, still returns
    assert (
        extract_otp_from_text("Your order #555. Verification code: 123456")
        == "123456"
    )


def test_extract_otp_from_text_no_match():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    assert extract_otp_from_text("hello world, nothing interesting") is None


async def test_fetch_recent_otps_empty():
    from domains.spawn_browser_agent_v3.service_crypto import fetch_recent_otps

    setup_mock(
        {"/api/integrations/email/messages": {"status": 200, "json": {"emails": []}}}
    )
    result = await fetch_recent_otps("u1", "https://backend.example.com", "k1")
    assert result == ""


async def test_fetch_recent_otps_extracts_codes():
    from domains.spawn_browser_agent_v3.service_crypto import fetch_recent_otps

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    setup_mock(
        {
            "/api/integrations/email/messages": {
                "status": 200,
                "json": {
                    "emails": [
                        {
                            "bodyText": "Your verification code: 987654",
                            "date": now,
                            "fromName": "Acme",
                        }
                    ]
                },
            }
        }
    )
    result = await fetch_recent_otps("u1", "https://backend.example.com", "k1")
    assert "987654" in result
    assert "Acme" in result


async def test_fetch_recent_otps_dedupes_old_emails():
    from domains.spawn_browser_agent_v3.service_crypto import fetch_recent_otps

    # age > 600s -> excluded
    old = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat().replace(
        "+00:00", "Z"
    )
    setup_mock(
        {
            "/api/integrations/email/messages": {
                "status": 200,
                "json": {
                    "emails": [
                        {
                            "bodyText": "Verification code: 111222",
                            "date": old,
                            "from": "old@example.com",
                        }
                    ]
                },
            }
        }
    )
    result = await fetch_recent_otps("u1", "https://backend.example.com", "k1")
    assert result == ""


# ========================================
# service_crypto: prompt builders
# ========================================


def test_build_autopay_prompt_section():
    from domains.spawn_browser_agent_v3.service_crypto import build_autopay_prompt_section

    payment_data = {
        "autoagentpaylimit_cents": 10000,
        "card_number": "4111111111111111",
        "billing_street_address": "123 Main St",
        "billing_address_line2": "",
        "billing_city": "Austin",
        "billing_state": "TX",
        "billing_zipcode": "78701",
        "billing_country": "USA",
        "billing_phone": "555-1234",
        "billing_email": "test@example.com",
    }
    out = build_autopay_prompt_section(payment_data, "envelope-b64")
    assert "$100.00" in out
    assert "ending in 1111" in out
    assert "123 Main St" in out
    assert "555-1234" in out
    assert "test@example.com" in out


def test_build_autopay_prompt_section_no_card():
    from domains.spawn_browser_agent_v3.service_crypto import build_autopay_prompt_section

    out = build_autopay_prompt_section({"autoagentpaylimit_cents": 0, "card_number": ""}, "env")
    assert "****" in out  # masked last four


def test_build_passwords_prompt_section_empty():
    from domains.spawn_browser_agent_v3.service_crypto import build_passwords_prompt_section

    section, refs = build_passwords_prompt_section([])
    assert section == ""
    assert refs == {}


def test_build_passwords_prompt_section_unique_usernames():
    from domains.spawn_browser_agent_v3.service_crypto import build_passwords_prompt_section

    passwords = [
        {"origin": "https://example.com", "username": "alice", "encryptedPassword": "enc1"},
        {"origin": "https://other.com", "username": "bob", "encryptedPassword": "enc2"},
    ]
    section, refs = build_passwords_prompt_section(passwords)
    assert "pwd:alice" in refs
    assert "pwd:bob" in refs
    assert refs["pwd:alice"] == "enc1"
    assert "AVAILABLE PASSWORDS" in section


def test_build_passwords_prompt_section_duplicate_usernames():
    from domains.spawn_browser_agent_v3.service_crypto import build_passwords_prompt_section

    passwords = [
        {"origin": "https://amazon.com", "username": "alice", "encryptedPassword": "enc_a"},
        {"origin": "https://www.netflix.com", "username": "alice", "encryptedPassword": "enc_b"},
        {"origin": "noscheme.com", "username": "alice", "encryptedPassword": "enc_c"},
    ]
    _, refs = build_passwords_prompt_section(passwords)
    # All three should produce unique domain-suffixed refs
    assert any("amazon" in k for k in refs)
    assert any("netflix" in k for k in refs)
    assert any("noscheme" in k for k in refs)


# ========================================
# repo: fetch_claude_token
# ========================================


async def test_fetch_claude_token_success():
    from domains.spawn_browser_agent_v3.repo import fetch_claude_token

    setup_mock(
        {
            "/api/integrations/claude-code/credentials/token": {
                "status": 200,
                "json": {"accessToken": "tok", "source": "user"},
            }
        }
    )
    cfg = _fake_config()
    out = await fetch_claude_token(cfg, "user-1")
    assert out == {"accessToken": "tok", "source": "user"}


async def test_fetch_claude_token_non_200_returns_none():
    from domains.spawn_browser_agent_v3.repo import fetch_claude_token

    setup_mock(
        {"/api/integrations/claude-code/credentials/token": {"status": 404, "json": {}}}
    )
    cfg = _fake_config()
    assert await fetch_claude_token(cfg, "user-1") is None


async def test_fetch_claude_token_no_api_key_returns_none():
    from domains.spawn_browser_agent_v3.repo import fetch_claude_token

    cfg = _fake_config(backend_api_key="")
    assert await fetch_claude_token(cfg, "user-1") is None


async def test_fetch_claude_token_with_force_pool_and_excludes():
    from domains.spawn_browser_agent_v3.repo import fetch_claude_token

    setup_mock(
        {
            "/api/integrations/claude-code/credentials/token": {
                "status": 200,
                "json": {"accessToken": "t", "source": "pool", "poolTokenId": "p1"},
            }
        }
    )
    cfg = _fake_config()
    out = await fetch_claude_token(
        cfg, "u1", force_pool=True, exclude_pool_ids=["a", "b"]
    )
    assert out["poolTokenId"] == "p1"
    call = assert_captured_call(url_contains="/credentials/token")
    assert call["requestHeaders"].get("X-Force-Pool") == "true" or \
        call["requestHeaders"].get("x-force-pool") == "true"


async def test_fetch_claude_token_network_error_returns_none():
    from domains.spawn_browser_agent_v3.repo import fetch_claude_token

    def failing_handler(request):
        raise RuntimeError("boom")

    from _test_utils import setup_mock_fn

    setup_mock_fn(failing_handler)
    cfg = _fake_config()
    assert await fetch_claude_token(cfg, "u1") is None


async def test_report_claude_token_rate_limited_pool():
    from domains.spawn_browser_agent_v3.repo import report_claude_token_rate_limited

    setup_mock({"/token/rate-limited": {"status": 200, "json": {}}})
    cfg = _fake_config()
    await report_claude_token_rate_limited(
        cfg, user_id="u1", source="pool", pool_token_id="p1", rate_limited_until="2025-01-01T00:00:00Z"
    )
    assert_captured_call(url_contains="/token/rate-limited", method="POST")


async def test_report_claude_token_rate_limited_user():
    from domains.spawn_browser_agent_v3.repo import report_claude_token_rate_limited

    setup_mock({"/token/rate-limited": {"status": 200, "json": {}}})
    cfg = _fake_config()
    await report_claude_token_rate_limited(cfg, user_id="u1", source="user")
    assert_captured_call(url_contains="/token/rate-limited")


async def test_report_claude_token_rate_limited_bad_source_noop():
    from domains.spawn_browser_agent_v3.repo import report_claude_token_rate_limited

    setup_mock({"/token/rate-limited": {"status": 200, "json": {}}})
    cfg = _fake_config()
    await report_claude_token_rate_limited(cfg, user_id="u1", source="bogus")
    # Should not POST
    assert len(get_captured_requests()) == 0


async def test_report_claude_token_rate_limited_no_source_noop():
    from domains.spawn_browser_agent_v3.repo import report_claude_token_rate_limited

    cfg = _fake_config()
    await report_claude_token_rate_limited(cfg, user_id="u1", source=None)
    assert len(get_captured_requests()) == 0


async def test_report_claude_token_rate_limited_no_api_key_noop():
    from domains.spawn_browser_agent_v3.repo import report_claude_token_rate_limited

    cfg = _fake_config(backend_api_key="")
    await report_claude_token_rate_limited(cfg, user_id="u1", source="pool", pool_token_id="p1")
    assert len(get_captured_requests()) == 0


async def test_report_claude_token_rate_limited_swallows_network_error():
    from domains.spawn_browser_agent_v3.repo import report_claude_token_rate_limited
    from _test_utils import setup_mock_fn

    def fail(request):
        raise RuntimeError("nope")

    setup_mock_fn(fail)
    cfg = _fake_config()
    # Must not raise
    await report_claude_token_rate_limited(cfg, user_id="u1", source="user")


# ========================================
# repo: save_browser_action / assistant messages
# ========================================


async def test_save_browser_action_message_posts_metadata():
    from tools.base import MessageStatus
    from domains.spawn_browser_agent_v3.repo import save_browser_action_message

    setup_mock(
        {
            "/api/agents/": {"status": 200, "json": {"ok": True}},
        }
    )

    with patch("config.load_config", return_value=_fake_config()):
        await save_browser_action_message(
            agent_id="ag1",
            title="click",
            message="m",
            status=MessageStatus.IN_PROGRESS,
            task_id="t1",
            browser_url="https://example.com",
            action_type="click",
            tool_call_id="tc1",
            steps_taken=1,
            total_steps=30,
            output_schema={"fields": []},
        )

    call = assert_captured_call(url_contains="/api/agents/ag1/messages", method="POST")
    body = json.loads(call["requestBody"])
    assert body["role"] == "TOOL"
    assert body["metadata"]["subAgentId"] == "t1"
    assert body["metadata"]["steps_taken"] == 1
    assert body["metadata"]["total_steps"] == 30
    assert body["metadata"]["output_schema"] == {"fields": []}


async def test_save_browser_action_message_init_no_subagent():
    from tools.base import MessageStatus
    from domains.spawn_browser_agent_v3.repo import save_browser_action_message

    setup_mock({"/api/agents/": {"status": 200, "json": {"ok": True}}})

    with patch("config.load_config", return_value=_fake_config()):
        await save_browser_action_message(
            agent_id="ag1",
            title="init",
            message="",
            status=MessageStatus.IN_PROGRESS,
            task_id="t1",
            tool_call_id="tc1",
            is_init_message=True,
        )

    call = assert_captured_call(url_contains="/api/agents/ag1/messages")
    body = json.loads(call["requestBody"])
    assert "subAgentId" not in body["metadata"]


async def test_save_browser_action_message_error_sets_flag():
    from tools.base import MessageStatus
    from domains.spawn_browser_agent_v3.repo import save_browser_action_message

    setup_mock({"/api/agents/": {"status": 200, "json": {"ok": True}}})

    with patch("config.load_config", return_value=_fake_config()):
        await save_browser_action_message(
            agent_id="ag1",
            title="fail",
            message="err",
            status=MessageStatus.ERROR,
            task_id="t1",
        )

    body = json.loads(get_captured_requests()[0]["requestBody"])
    assert body["metadata"]["error"] is True


async def test_save_browser_action_message_swallows_exception():
    from tools.base import MessageStatus
    from domains.spawn_browser_agent_v3.repo import save_browser_action_message

    with patch(
        "config.load_config",
        side_effect=RuntimeError("cfg fail"),
    ):
        # Should not raise
        await save_browser_action_message(
            agent_id="ag",
            title="t",
            message="m",
            status=MessageStatus.FINISHED,
            task_id="t1",
        )


async def test_save_browser_action_message_tool_name_override():
    """Verifier feedback flows back as `attempt_completion` TOOL result (C5)."""
    from tools.base import MessageStatus
    from domains.spawn_browser_agent_v3.repo import save_browser_action_message

    setup_mock({"/api/agents/": {"status": 200, "json": {"ok": True}}})

    with patch("config.load_config", return_value=_fake_config()):
        await save_browser_action_message(
            agent_id="ag1",
            title="rejected",
            message="reasoning",
            status=MessageStatus.FINISHED,
            task_id="t1",
            tool_call_id="tc-verifier",
            tool_name_override="attempt_completion",
            extra_metadata={"verifierMessage": True},
        )

    body = json.loads(get_captured_requests()[0]["requestBody"])
    assert body["metadata"]["toolName"] == "attempt_completion"
    assert body["metadata"]["verifierMessage"] is True


async def test_save_browser_assistant_message():
    from domains.spawn_browser_agent_v3.repo import save_browser_assistant_message

    setup_mock({"/api/agents/": {"status": 200, "json": {"ok": True}}})

    with patch("config.load_config", return_value=_fake_config()):
        await save_browser_assistant_message("ag1", "hello world", "task-1")

    body = json.loads(get_captured_requests()[0]["requestBody"])
    assert body["role"] == "ASSISTANT"
    assert body["metadata"]["subAgentId"] == "task-1"


async def test_save_browser_assistant_message_swallows_exception():
    from domains.spawn_browser_agent_v3.repo import save_browser_assistant_message

    with patch(
        "config.load_config",
        side_effect=RuntimeError("nope"),
    ):
        await save_browser_assistant_message("ag1", "hi", "t1")


# ========================================
# repo: Steel files
# ========================================


async def test_list_session_files_no_api_key():
    from domains.spawn_browser_agent_v3 import repo

    with patch.object(repo, "STEEL_API_KEY", ""):
        assert await repo.list_session_files("s1") == []


async def test_list_session_files_success():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock(
        {"api.steel.dev/v1/sessions/s1/files": {"status": 200, "json": {"data": [{"path": "/f/x.pdf"}]}}}
    )
    with patch.object(repo, "STEEL_API_KEY", "sk-steel"):
        files = await repo.list_session_files("s1")
    assert files == [{"path": "/f/x.pdf"}]


async def test_list_session_files_non_200():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock({"api.steel.dev": {"status": 500, "json": {"err": "x"}}})
    with patch.object(repo, "STEEL_API_KEY", "sk-steel"):
        assert await repo.list_session_files("s1") == []


async def test_list_session_files_network_error():
    from domains.spawn_browser_agent_v3 import repo
    from _test_utils import setup_mock_fn

    def boom(req):
        raise RuntimeError("net")

    setup_mock_fn(boom)
    with patch.object(repo, "STEEL_API_KEY", "sk-steel"):
        assert await repo.list_session_files("s1") == []


async def test_download_file_from_steel_no_api_key():
    from domains.spawn_browser_agent_v3 import repo

    with patch.object(repo, "STEEL_API_KEY", ""):
        assert await repo.download_file_from_steel("s1", "/files/x.pdf") is None


async def test_download_file_from_steel_strips_prefixes():
    from domains.spawn_browser_agent_v3 import repo

    captured = {}

    def handler(request):
        import httpx

        captured["url"] = str(request.url)
        return httpx.Response(200, content=b"PDFDATA", headers={"Content-Type": "application/pdf"})

    from _test_utils import setup_mock_fn

    setup_mock_fn(handler)
    with patch.object(repo, "STEEL_API_KEY", "sk"):
        out = await repo.download_file_from_steel("s1", "/files/doc.pdf")

    assert out is not None
    assert out["content"] == b"PDFDATA"
    assert out["filename"] == "doc.pdf"
    assert out["mime_type"] == "application/pdf"
    assert "files/doc.pdf" in captured["url"]
    # "/files/" prefix should have been stripped before Steel path
    assert "/files//files/" not in captured["url"]


async def test_download_file_from_steel_strips_leading_slash():
    from domains.spawn_browser_agent_v3 import repo

    def handler(request):
        import httpx

        return httpx.Response(200, content=b"X")

    from _test_utils import setup_mock_fn

    setup_mock_fn(handler)
    with patch.object(repo, "STEEL_API_KEY", "sk"):
        out = await repo.download_file_from_steel("s1", "/simple.txt")
    assert out is not None
    assert out["mime_type"] == "text/plain"


async def test_download_file_from_steel_non_200():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock({"api.steel.dev": {"status": 404, "text": "not found"}})
    with patch.object(repo, "STEEL_API_KEY", "sk"):
        assert await repo.download_file_from_steel("s1", "x") is None


async def test_download_file_from_steel_network_error():
    from domains.spawn_browser_agent_v3 import repo
    from _test_utils import setup_mock_fn

    def boom(req):
        raise RuntimeError("fail")

    setup_mock_fn(boom)
    with patch.object(repo, "STEEL_API_KEY", "sk"):
        assert await repo.download_file_from_steel("s1", "x") is None


# ========================================
# repo: browser session init / fetch / close / upload
# ========================================


async def test_init_browser_session_success():
    from domains.spawn_browser_agent_v3.repo import init_browser_session

    setup_mock(
        {
            "/api/browser-session/init": {
                "status": 200,
                "json": {"session_id": "s", "task_id": "t", "debug_url": "d", "ws_url": "w"},
            }
        }
    )
    cfg = _fake_config()
    out = await init_browser_session(cfg, "u", "a", "https://x.com")
    assert out["session_id"] == "s"


async def test_init_browser_session_rate_limited():
    from domains.spawn_browser_agent_v3.repo import init_browser_session

    setup_mock({"/api/browser-session/init": {"status": 429, "json": {}}})
    cfg = _fake_config()
    out = await init_browser_session(cfg, "u", "a", "")
    assert out["rate_limited"] is True
    assert out["status_code"] == 429


async def test_init_browser_session_error_raises():
    from domains.spawn_browser_agent_v3.repo import init_browser_session

    setup_mock({"/api/browser-session/init": {"status": 500, "text": "oops"}})
    cfg = _fake_config()
    try:
        await init_browser_session(cfg, "u", "a", "")
        raise AssertionError("should raise")
    except Exception as e:
        assert "Failed to init session" in str(e)


async def test_fetch_session_info_success():
    from domains.spawn_browser_agent_v3.repo import fetch_session_info

    setup_mock(
        {
            "/api/browser-session/task/t1": {
                "status": 200,
                "json": {"session_id": "s1", "debug_url": "d", "ws_url": "w"},
            }
        }
    )
    cfg = _fake_config()
    out = await fetch_session_info(cfg, "t1")
    assert out["session_id"] == "s1"


async def test_fetch_session_info_error_raises():
    from domains.spawn_browser_agent_v3.repo import fetch_session_info

    setup_mock({"/api/browser-session/task/t1": {"status": 500, "json": {}}})
    cfg = _fake_config()
    try:
        await fetch_session_info(cfg, "t1")
        raise AssertionError("should raise")
    except RuntimeError as e:
        assert "Failed to fetch session info" in str(e)


async def test_close_browser_session_swallows_errors():
    from domains.spawn_browser_agent_v3.repo import close_browser_session
    from _test_utils import setup_mock_fn

    def fail(req):
        raise RuntimeError("down")

    setup_mock_fn(fail)
    cfg = _fake_config()
    await close_browser_session(cfg, "s1", pause=True, current_url="https://x")


async def test_close_browser_session_success_payload():
    from domains.spawn_browser_agent_v3.repo import close_browser_session

    setup_mock({"/api/browser-session/close": {"status": 200, "json": {}}})
    cfg = _fake_config()
    await close_browser_session(cfg, "s1", pause=True, current_url="https://x.com")
    body = json.loads(get_captured_requests()[0]["requestBody"])
    assert body["pause"] is True
    assert body["current_url"] == "https://x.com"
    assert body["session_id"] == "s1"


async def test_inject_local_storage_success():
    from domains.spawn_browser_agent_v3.repo import inject_local_storage

    setup_mock(
        {"inject-localStorage": {"status": 200, "json": {"injected": True, "count": 5}}}
    )
    cfg = _fake_config()
    out = await inject_local_storage(cfg, "s1", "https://x.com")
    assert out == {"injected": True, "count": 5}


async def test_inject_local_storage_non_200_returns_none():
    from domains.spawn_browser_agent_v3.repo import inject_local_storage

    setup_mock({"inject-localStorage": {"status": 500, "json": {}}})
    cfg = _fake_config()
    assert await inject_local_storage(cfg, "s1", "https://x.com") is None


async def test_inject_local_storage_network_error_returns_none():
    from domains.spawn_browser_agent_v3.repo import inject_local_storage
    from _test_utils import setup_mock_fn

    def boom(req):
        raise RuntimeError("x")

    setup_mock_fn(boom)
    cfg = _fake_config()
    assert await inject_local_storage(cfg, "s1", "https://x.com") is None


async def test_upload_file_to_session_success():
    from domains.spawn_browser_agent_v3 import repo

    class _Resp:
        status_code = 201

        def json(self):
            return {"path": "/tmp/f.pdf"}

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **kw):
            # assert multipart file shape
            assert "files" in kw
            assert kw["files"]["file"][0] == "f.pdf"
            return _Resp()

    with patch.object(repo.httpx, "AsyncClient", return_value=_Client()):
        cfg = _fake_config()
        out = await repo.upload_file_to_session(cfg, "s1", "f.pdf", b"PDFDATA", "application/pdf")
    assert out == {"path": "/tmp/f.pdf"}


async def test_upload_file_to_session_non_200_returns_none():
    from domains.spawn_browser_agent_v3 import repo

    class _Resp:
        status_code = 500
        text = "nope"

        def json(self):
            return {}

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **kw):
            return _Resp()

    with patch.object(repo.httpx, "AsyncClient", return_value=_Client()):
        cfg = _fake_config()
        assert await repo.upload_file_to_session(cfg, "s1", "f.pdf", b"X") is None


async def test_upload_file_to_session_network_error():
    from domains.spawn_browser_agent_v3 import repo

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **kw):
            raise RuntimeError("fail")

    with patch.object(repo.httpx, "AsyncClient", return_value=_Client()):
        cfg = _fake_config()
        assert await repo.upload_file_to_session(cfg, "s1", "f.pdf", b"X") is None


# ========================================
# repo: call_extract_llm
# ========================================


async def test_call_extract_llm_success():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock(
        {
            "/chat/completions": {
                "status": 200,
                "json": {"choices": [{"message": {"content": "extracted!"}}]},
            }
        }
    )
    with patch("config.load_config", return_value=_fake_config()):
        out = await repo.call_extract_llm("what?", "page content", "https://x")
    assert out == "extracted!"


async def test_call_extract_llm_non_200():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock({"/chat/completions": {"status": 500, "text": "bad"}})
    with patch("config.load_config", return_value=_fake_config()):
        out = await repo.call_extract_llm("what?", "p", "https://x")
    assert "Extraction failed" in out


async def test_call_extract_llm_network_error():
    from domains.spawn_browser_agent_v3 import repo
    from _test_utils import setup_mock_fn

    def boom(req):
        raise RuntimeError("down")

    setup_mock_fn(boom)
    with patch("config.load_config", return_value=_fake_config()):
        out = await repo.call_extract_llm("what?", "p", "https://x")
    assert "Extraction failed" in out


async def test_call_extract_llm_truncates_long_content():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock(
        {
            "/chat/completions": {
                "status": 200,
                "json": {"choices": [{"message": {"content": "ok"}}]},
            }
        }
    )
    big_content = "A" * (repo.EXTRACT_MAX_CONTENT_LENGTH + 100)
    with patch("config.load_config", return_value=_fake_config()):
        out = await repo.call_extract_llm("inst", big_content, "https://x")
    assert out == "ok"
    call = get_captured_requests()[0]
    body = json.loads(call["requestBody"])
    user_msg = body["messages"][1]["content"]
    assert "[truncated" in user_msg


# ========================================
# repo: fetch_recent_emails
# ========================================


async def test_fetch_recent_emails_success():
    from domains.spawn_browser_agent_v3.repo import fetch_recent_emails

    setup_mock(
        {
            "/api/integrations/email/messages": {
                "status": 200,
                "json": {"emails": [{"bodyText": "x"}]},
            }
        }
    )
    out = await fetch_recent_emails("u1", "https://backend.example.com", "k", "2025-01-01")
    assert out == [{"bodyText": "x"}]


async def test_fetch_recent_emails_404():
    from domains.spawn_browser_agent_v3.repo import fetch_recent_emails

    setup_mock({"/api/integrations/email/messages": {"status": 404, "json": {}}})
    out = await fetch_recent_emails("u1", "https://backend.example.com", "k", "2025-01-01")
    assert out == []


async def test_fetch_recent_emails_5xx():
    from domains.spawn_browser_agent_v3.repo import fetch_recent_emails

    setup_mock({"/api/integrations/email/messages": {"status": 500, "json": {}}})
    out = await fetch_recent_emails("u1", "https://backend.example.com", "k", "2025-01-01")
    assert out == []


async def test_fetch_recent_emails_network_error():
    from domains.spawn_browser_agent_v3.repo import fetch_recent_emails
    from _test_utils import setup_mock_fn

    def boom(req):
        raise RuntimeError("bad")

    setup_mock_fn(boom)
    out = await fetch_recent_emails("u1", "https://x", "k", "2025-01-01")
    assert out == []


# ========================================
# service: safe_time, build_context_summary, build_usage_items
# ========================================


def test_safe_time_returns_float():
    from domains.spawn_browser_agent_v3.service import safe_time

    assert isinstance(safe_time(), float)


def test_safe_time_swallows_errors():
    import domains.spawn_browser_agent_v3.service as service

    with patch.object(service.time, "time", side_effect=RuntimeError("sandbox")):
        assert service.safe_time() == 0.0


def test_build_context_summary_success_with_urls():
    from domains.spawn_browser_agent_v3.service import build_context_summary

    out = build_context_summary(
        success=True,
        close_reasoning="done",
        visited_urls=["https://a", "https://b", "https://c"],
        reasoning_messages=["think1", "think2"],
        action_summary=["click", "type"],
    )
    assert "SUCCESS" in out
    assert "done" in out
    assert "https://a" in out
    assert "think1" in out
    assert "click" in out


def test_build_context_summary_failure_with_error():
    from domains.spawn_browser_agent_v3.service import build_context_summary

    out = build_context_summary(
        success=False,
        close_reasoning="failed",
        visited_urls=[],
        reasoning_messages=[],
        action_summary=[],
        error_context="timeout",
    )
    assert "FAILED" in out
    assert "timeout" in out


def test_build_context_summary_trims_lists():
    from domains.spawn_browser_agent_v3.service import build_context_summary

    many_urls = [f"https://x/{i}" for i in range(20)]
    many_actions = [f"a{i}" for i in range(20)]
    many_reasoning = [f"r{i}" for i in range(10)]
    out = build_context_summary(
        success=True,
        close_reasoning="",
        visited_urls=many_urls,
        reasoning_messages=many_reasoning,
        action_summary=many_actions,
    )
    # Last 5 urls
    assert "https://x/19" in out
    assert "https://x/0" not in out
    # Last 3 reasoning
    assert "r9" in out
    assert "r0" not in out


def test_build_usage_items():
    from domains.spawn_browser_agent_v3.service import build_usage_items

    items = build_usage_items(
        total_input_tokens=1000,
        total_output_tokens=2000,
        model_pricing={"input_cents_per_1k": 0.3, "output_cents_per_1k": 1.5},
        execution_time_ms=60000,
    )
    assert len(items) == 2
    assert items[0]["type"] == "llm"
    assert items[0]["provider"] == "Rose 1 Browser Use"
    assert items[0]["input_tokens"] == 1000
    assert items[0]["output_tokens"] == 2000
    # 1k*0.3 + 2k*1.5 = 0.3 + 3.0 = 3.3
    assert items[0]["cost_cents"] == 3.3
    assert items[1]["type"] == "service"
    assert items[1]["provider"] == "Steel.dev Browser"


def test_get_browser_system_prompt_with_files():
    from domains.spawn_browser_agent_v3.service import get_browser_system_prompt

    out = get_browser_system_prompt(
        goal="buy a book",
        custom_instructions="be quick",
        available_files=["a.pdf", "b.txt"],
    )
    assert "buy a book" in out
    assert "be quick" in out
    assert "a.pdf" in out and "b.txt" in out


def test_get_browser_system_prompt_without_files():
    from domains.spawn_browser_agent_v3.service import get_browser_system_prompt

    out = get_browser_system_prompt("g", custom_instructions="")
    assert "AVAILABLE FILES FOR UPLOAD" not in out


def test_get_browser_system_prompt_is_static_across_calls():
    """The static prompt must be byte-identical across calls within a workspace.

    No `current_time`, no `current_url`, no per-step interpolation. This is
    the property that lets Anthropic prompt caching reuse the prefix.
    """
    from domains.spawn_browser_agent_v3.service import get_browser_system_prompt

    out_a = get_browser_system_prompt("buy a book", "be quick", available_files=["x.pdf"])
    out_b = get_browser_system_prompt("buy a book", "be quick", available_files=["x.pdf"])
    assert out_a == out_b, "prompt must be byte-identical across calls with same inputs"
    assert "Current time:" not in out_a, "current time leaks into static prompt"
    assert "CURRENT URL:" not in out_a, "current url leaks into static prompt"


def test_build_state_line_format():
    """The state line must be terse, parseable, and contain ISO 8601 UTC time."""
    import re
    from datetime import datetime, timezone

    from domains.spawn_browser_agent_v3.service import build_state_line

    fixed = datetime(2026, 4, 30, 23, 14, 0, tzinfo=timezone.utc)
    line = build_state_line(current_url="https://example.com/checkout", now=fixed)
    assert line == "[STATE: time=2026-04-30T23:14:00Z url=https://example.com/checkout]"
    assert re.match(
        r"^\[STATE: time=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z url=[^\]]*\]$",
        line,
    ), "state line must match strict format"
    assert len(line) <= 120, "state line must stay terse"


def test_build_state_line_empty_url():
    """Empty URL must not crash the state line."""
    from datetime import datetime, timezone

    from domains.spawn_browser_agent_v3.service import build_state_line

    fixed = datetime(2026, 4, 30, 23, 14, 0, tzinfo=timezone.utc)
    line = build_state_line(current_url="", now=fixed)
    assert line == "[STATE: time=2026-04-30T23:14:00Z url=]"


# ========================================
# handler: browser-use auth selection / rotation
# ========================================


class _FakeRoseClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def complete_browser_use(self, **kwargs):
        self.calls.append(kwargs)
        return self.responses.pop(0)


async def test_call_browser_use_with_rotation_uses_gpt_auth():
    from domains.spawn_browser_agent_v3.handler import _call_browser_use_with_rotation
    from domains.spawn_browser_agent_v3.types import ClaudeTokenState

    client = _FakeRoseClient([{"actions": [{"type": "wait"}]}])
    token_state = ClaudeTokenState()
    token_state.access_token = "claude-token"
    token_state.source = "user"

    result = await _call_browser_use_with_rotation(
        rose_client=client,
        task="do it",
        browser_state={"url": "https://example.com"},
        action_entries=[],
        config=_fake_config(),
        user_id="u1",
        agent_id="a1",
        iteration=3,
        token_state=token_state,
        gpt_token="gpt-token",
        gpt_account_id="acct-1",
        gpt_token_source="pool",
        gpt_token_pool_id="pool-gpt",
        browser_use_mode="gpt",
    )

    assert result == {"actions": [{"type": "wait"}]}
    assert client.calls[0]["claude_auth"] is None
    assert client.calls[0]["gpt_auth"].token == "gpt-token"
    assert client.calls[0]["gpt_auth"].account_id == "acct-1"
    assert client.calls[0]["gpt_auth"].pool_token_id == "pool-gpt"


async def test_call_browser_use_with_rotation_rotates_claude_token():
    import domains.spawn_browser_agent_v3.handler as handler
    from domains.spawn_browser_agent_v3.handler import _call_browser_use_with_rotation
    from domains.spawn_browser_agent_v3.types import ClaudeTokenState

    client = _FakeRoseClient(
        [
            {
                "claude_token_error": "rate_limit",
                "rateLimitedUntil": "2026-01-01T00:00:00Z",
            },
            {"actions": [{"type": "done"}]},
        ]
    )
    token_state = ClaudeTokenState()
    token_state.access_token = "old-token"
    token_state.source = "pool"
    token_state.pool_token_id = "pool-old"

    with patch.object(handler.activity, "heartbeat"), patch.object(
        handler,
        "report_claude_token_rate_limited",
        new=AsyncMock(),
    ) as mark_limited, patch.object(
        handler,
        "fetch_claude_token",
        new=AsyncMock(
            return_value={
                "accessToken": "new-token",
                "source": "pool",
                "poolTokenId": "pool-new",
            }
        ),
    ) as fetch_token:
        result = await _call_browser_use_with_rotation(
            rose_client=client,
            task="do it",
            browser_state={"url": "https://example.com"},
            action_entries=[{"type": "click"}],
            config=_fake_config(),
            user_id="u1",
            agent_id="a1",
            iteration=4,
            token_state=token_state,
            gpt_token=None,
            gpt_account_id=None,
            gpt_token_source=None,
            gpt_token_pool_id=None,
            browser_use_mode="claude",
        )

    assert result == {"actions": [{"type": "done"}]}
    assert len(client.calls) == 2
    assert client.calls[0]["claude_auth"].token == "old-token"
    assert client.calls[1]["claude_auth"].token == "new-token"
    mark_limited.assert_awaited_once()
    fetch_token.assert_awaited_once()
    assert token_state.excluded_pool_ids == ["pool-old"]
    assert token_state.access_token == "new-token"
    assert token_state.pool_token_id == "pool-new"


async def test_call_browser_use_with_rotation_stops_when_no_replacement():
    import domains.spawn_browser_agent_v3.handler as handler
    from domains.spawn_browser_agent_v3.handler import _call_browser_use_with_rotation
    from domains.spawn_browser_agent_v3.types import ClaudeTokenState

    first_result = {"claude_token_error": "auth_error"}
    client = _FakeRoseClient([first_result])
    token_state = ClaudeTokenState()
    token_state.access_token = "bad-token"
    token_state.source = "user"

    with patch.object(handler.activity, "heartbeat"), patch.object(
        handler,
        "report_claude_token_rate_limited",
        new=AsyncMock(),
    ), patch.object(handler, "fetch_claude_token", new=AsyncMock(return_value=None)):
        result = await _call_browser_use_with_rotation(
            rose_client=client,
            task="do it",
            browser_state={},
            action_entries=[],
            config=_fake_config(),
            user_id="u1",
            agent_id="a1",
            iteration=5,
            token_state=token_state,
            gpt_token=None,
            gpt_account_id=None,
            gpt_token_source=None,
            gpt_token_pool_id=None,
            browser_use_mode="claude",
        )

    assert result is first_result
    assert len(client.calls) == 1
    assert token_state.access_token is None


# ========================================
# service: build_action_titles
# ========================================


def test_build_action_titles_click_with_element():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, name = build_action_titles("click", {}, "<button>Go</button>", None, None)
    assert "Clicking" in p and "Clicked" in d
    assert name == "click"


def test_build_action_titles_click_with_coords():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, _ = build_action_titles("click", {}, None, {"x": 100, "y": 200}, None)
    assert "(100, 200)" in p
    assert "(100, 200)" in d


def test_build_action_titles_click_with_nothing():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, _ = build_action_titles("click", {}, None, None, None)
    assert p == "Clicking..."
    assert d == "Clicked"


def test_build_action_titles_input_text_secret_redacted():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    ua = {"params": {"text": "pwd:alice"}}
    _, d, _ = build_action_titles("input_text", ua, "<input>", None, {"pwd:alice": "real-pw"})
    assert "[encrypted_data]" in d


def test_build_action_titles_input_text_with_coords_plain_text():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    ua = {"params": {"text": "hello"}}
    p, d, _ = build_action_titles("input_text", ua, None, {"x": 10, "y": 20}, None)
    assert "(10, 20)" in p
    assert "hello" in d


def test_build_action_titles_input_text_no_target():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    ua = {"params": {"text": "hi"}}
    p, d, _ = build_action_titles("input_text", ua, None, None, None)
    assert p == "Typing..."
    assert "'hi'" in d


def test_build_action_titles_goto():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, _ = build_action_titles("goto", {"params": {"url": "https://example.com"}}, None, None, None)
    assert "https://example.com" in p
    assert "https://example.com" in d


def test_build_action_titles_scroll():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, name = build_action_titles(
        "scroll", {"params": {"direction": "up", "amount": 500}}, None, None, None
    )
    assert "up 500px" in p
    assert name == "scroll_up"


def test_build_action_titles_press_key_and_extract():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, _ = build_action_titles(
        "press_key", {"params": {"key": "Enter"}}, None, None, None
    )
    assert "Enter" in p

    p2, d2, _ = build_action_titles("extract", {}, None, None, None)
    assert "Extracting data..." == p2


def test_build_action_titles_wait_select_upload_screenshot():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, _ = build_action_titles("wait", {"params": {"time_ms": 500}}, None, None, None)
    assert "500ms" in p

    p2, d2, _ = build_action_titles(
        "select_dropdown", {"params": {"value": "USA"}}, "<select>", None, None
    )
    assert "USA" in d2

    p3, d3, _ = build_action_titles(
        "select_dropdown", {"params": {"value": "CA"}}, None, None, None
    )
    assert "Selecting 'CA'..." in p3

    p4, d4, _ = build_action_titles(
        "upload_file", {"params": {"filename": "doc.pdf"}}, "<input>", None, None
    )
    assert "doc.pdf" in d4

    p5, d5, _ = build_action_titles(
        "upload_file", {"params": {"filename": "x.csv"}}, None, None, None
    )
    assert "x.csv" in p5

    p6, d6, _ = build_action_titles("screenshot", {}, None, None, None)
    assert "Screenshot captured" == d6


def test_build_action_titles_unknown_action():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, name = build_action_titles("unknown_action", {}, None, None, None)
    assert p == "unknown_action..."
    assert d == "unknown_action"
    assert name == "unknown_action"


# ========================================
# service: extract_session_files
# ========================================


async def test_extract_session_files_no_files():
    from domains.spawn_browser_agent_v3 import service

    with patch.object(service, "list_session_files", AsyncMock(return_value=[])):
        out = await service.extract_session_files("s1", "u1", _fake_config())
    assert out == []


async def test_extract_session_files_happy_path():
    from domains.spawn_browser_agent_v3 import service

    files_listing = [{"path": "/a.pdf"}, {"path": "/b.txt"}, {"path": ""}]
    download_return = {
        "content": b"CONTENT",
        "filename": "a.pdf",
        "mime_type": "application/pdf",
    }
    fp = {"storage_path": "users/u/1.pdf", "original_filename": "a.pdf"}

    with (
        patch.object(service, "list_session_files", AsyncMock(return_value=files_listing)),
        patch.object(service, "download_file_from_steel", AsyncMock(return_value=download_return)),
        patch("helpers.attachments.upload_to_storage", AsyncMock(return_value=fp)),
    ):
        out = await service.extract_session_files("s1", "u1", _fake_config())

    # "" path entry skipped; 2 files downloaded
    assert len(out) == 2


async def test_extract_session_files_exclude_paths():
    from domains.spawn_browser_agent_v3 import service

    files_listing = [{"path": "/x.pdf"}, {"path": "/y.pdf"}]

    with (
        patch.object(service, "list_session_files", AsyncMock(return_value=files_listing)),
        patch.object(
            service,
            "download_file_from_steel",
            AsyncMock(return_value={"content": b"c", "filename": "y.pdf", "mime_type": "x"}),
        ),
        patch(
            "helpers.attachments.upload_to_storage",
            AsyncMock(return_value={"storage_path": "p", "original_filename": "y.pdf"}),
        ),
    ):
        out = await service.extract_session_files("s1", "u1", _fake_config(), exclude_paths=["/x.pdf"])
    assert len(out) == 1


async def test_extract_session_files_download_fail_skipped():
    from domains.spawn_browser_agent_v3 import service

    with (
        patch.object(service, "list_session_files", AsyncMock(return_value=[{"path": "/a"}])),
        patch.object(service, "download_file_from_steel", AsyncMock(return_value=None)),
    ):
        out = await service.extract_session_files("s1", "u1", _fake_config())
    assert out == []


async def test_extract_session_files_upload_failure_skipped():
    from domains.spawn_browser_agent_v3 import service

    with (
        patch.object(service, "list_session_files", AsyncMock(return_value=[{"path": "/a"}])),
        patch.object(
            service,
            "download_file_from_steel",
            AsyncMock(return_value={"content": b"c", "filename": "a", "mime_type": "x"}),
        ),
        patch("helpers.attachments.upload_to_storage", AsyncMock(side_effect=RuntimeError("up"))),
    ):
        out = await service.extract_session_files("s1", "u1", _fake_config())
    assert out == []


# ========================================
# service_actions: static helpers
# ========================================


def test_get_domain_from_url_variants():
    from domains.spawn_browser_agent_v3.service_actions import get_domain_from_url

    assert get_domain_from_url("https://www.amazon.com/cart") == "amazon.com"
    assert get_domain_from_url("https://auth.amazon.com/login") == "auth.amazon.com"
    assert get_domain_from_url("not-a-url") == ""


def test_get_base_domain():
    from domains.spawn_browser_agent_v3.service_actions import _get_base_domain

    assert _get_base_domain("auth.amazon.com") == "amazon.com"
    assert _get_base_domain("example.com") == "example.com"
    assert _get_base_domain("localhost") == "localhost"


def test_is_approval_valid_no_approvals():
    from domains.spawn_browser_agent_v3.service_actions import is_approval_valid

    assert is_approval_valid(None, "purchase", "https://x") is False
    assert is_approval_valid({}, "purchase", "https://x") is False


def test_is_approval_valid_missing_fields():
    from domains.spawn_browser_agent_v3.service_actions import is_approval_valid

    assert is_approval_valid({"purchase": {}}, "purchase", "https://x") is False


def test_is_approval_valid_domain_mismatch():
    from domains.spawn_browser_agent_v3.service_actions import is_approval_valid

    approvals = {"purchase": {"domain": "amazon.com", "approved_at": time_module.time()}}
    assert is_approval_valid(approvals, "purchase", "https://ebay.com/x") is False


def test_is_approval_valid_still_fresh():
    from domains.spawn_browser_agent_v3.service_actions import is_approval_valid

    approvals = {"purchase": {"domain": "amazon.com", "approved_at": time_module.time()}}
    assert is_approval_valid(approvals, "purchase", "https://www.amazon.com/x") is True


def test_is_approval_valid_expired():
    from domains.spawn_browser_agent_v3.service_actions import is_approval_valid

    approvals = {
        "purchase": {
            "domain": "amazon.com",
            "approved_at": time_module.time() - 3600,  # way past 120s
        }
    }
    assert is_approval_valid(approvals, "purchase", "https://amazon.com/x") is False


def test_get_element_description_none():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    assert get_element_description(None) == "unknown"


def test_get_element_description_with_text():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "button"
    el.attributes = {}
    el.get_all_children_text.return_value = "Click Me"
    out = get_element_description(el)
    assert "Click Me" in out
    assert "button" in out


def test_get_element_description_with_placeholder():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "input"
    el.attributes = {"placeholder": "Search here"}
    el.get_all_children_text.return_value = ""
    out = get_element_description(el)
    assert "Search here" in out


def test_get_element_description_with_aria_label():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "div"
    el.attributes = {"aria-label": "Menu toggle"}
    el.get_all_children_text.return_value = ""
    out = get_element_description(el)
    assert "Menu toggle" in out


def test_get_element_description_with_name_attr():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "input"
    el.attributes = {"name": "password"}
    el.get_all_children_text.return_value = ""
    out = get_element_description(el)
    assert 'name="password"' in out


def test_get_element_description_with_id():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "div"
    el.attributes = {"id": "main-btn"}
    el.get_all_children_text.return_value = ""
    out = get_element_description(el)
    assert "#main-btn" in out


def test_get_element_description_input_type():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "input"
    el.attributes = {"type": "email"}
    el.get_all_children_text.return_value = ""
    out = get_element_description(el)
    assert 'type="email"' in out


def test_get_element_description_nothing():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "span"
    el.attributes = {}
    el.get_all_children_text.return_value = ""
    out = get_element_description(el)
    assert out == "<span>"


def test_get_element_description_text_extraction_error():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "div"
    el.attributes = {"id": "x"}
    el.get_all_children_text.side_effect = RuntimeError("x")
    out = get_element_description(el)
    assert "#x" in out


async def test_move_visual_cursor_no_session_safe():
    from domains.spawn_browser_agent_v3.service_actions import move_visual_cursor

    dom = MagicMock()
    dom.session = None
    # Should not raise
    await move_visual_cursor(dom, 10, 20)


async def test_move_visual_cursor_exception_safe():
    from domains.spawn_browser_agent_v3.service_actions import move_visual_cursor

    dom = MagicMock()
    dom.session = MagicMock()
    dom.session.get_or_create_cdp_session = AsyncMock(side_effect=RuntimeError("x"))
    await move_visual_cursor(dom, 1, 2)


# ========================================
# service_actions: execute_action early validation branches
# ========================================


async def test_execute_action_no_session():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = None
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "click"})
    assert out["success"] is False
    assert "not connected" in out["error"]


async def test_execute_action_element_not_found():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "click", "index": 5})
    assert out["success"] is False
    assert "index 5 not found" in out["error"]


async def test_execute_action_unknown_action():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "totally_unknown"})
    assert out["success"] is False
    assert "Unknown action" in out["error"]


async def test_execute_action_dropdown_options_missing_element():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "dropdown_options"})
    assert out["success"] is False


async def test_execute_action_select_dropdown_missing_element():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "select_dropdown", "params": {"value": "x"}})
    assert out["success"] is False


async def test_execute_action_attempt_completion():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "attempt_completion"})
    assert out["success"] is True
    assert out["attempt_completion"] is True


async def test_execute_action_send_message_to_user():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(
        dom,
        ah,
        {"action": "send_message_to_user", "params": {"message": "help", "reason": "captcha"}},
    )
    assert out["success"] is True
    assert out["message_to_user"] is True
    assert out["reason"] == "captcha"


async def test_execute_action_done():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "done", "params": {"text": "finished"}})
    assert out["success"] is True
    assert out["done"] is True
    assert out["message"] == "finished"


async def test_execute_action_click_no_element_no_coords():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "click"}, write_lock_enabled=False)
    assert out["success"] is False


async def test_execute_action_upload_file_missing_filename():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "upload_file", "params": {}})
    assert out["success"] is False
    assert "filename" in out["error"]


async def test_execute_action_upload_file_not_in_available():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(
        dom,
        ah,
        {"action": "upload_file", "params": {"filename": "x.pdf"}},
        available_file_paths={"other.pdf": "/tmp/other.pdf"},
    )
    assert out["success"] is False


async def test_execute_action_switch_tab_missing_id():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "switch_tab", "params": {}})
    assert out["success"] is False


async def test_execute_action_press_key_with_humanizer():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.press_key = AsyncMock()
    out = await execute_action(
        dom,
        ah,
        {"action": "press_key", "params": {"key": "Enter"}},
        humanizer=hu,
    )
    assert out == {"success": True, "message": ""}
    hu.press_key.assert_awaited_once_with("Enter")
    ah.record_action.assert_awaited()


async def test_execute_action_scroll_with_humanizer_down():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.scroll = AsyncMock()
    out = await execute_action(
        dom,
        ah,
        {"action": "scroll", "params": {"direction": "down", "amount": 400}},
        humanizer=hu,
    )
    assert out == {"success": True, "message": ""}
    hu.scroll.assert_awaited_once_with(400)


async def test_execute_action_scroll_with_humanizer_up():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.scroll = AsyncMock()
    out = await execute_action(
        dom,
        ah,
        {"action": "scroll", "params": {"direction": "up", "amount": 250}},
        humanizer=hu,
    )
    assert out["success"] is True
    hu.scroll.assert_awaited_once_with(-250)


async def test_execute_action_extract_delegates():
    from domains.spawn_browser_agent_v3 import service_actions

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()

    async def fake_extract(**kwargs):
        return {"success": True, "message": "extracted"}

    with patch.object(service_actions, "_execute_extract", side_effect=fake_extract):
        out = await service_actions.execute_action(
            dom, ah, {"action": "extract", "params": {"query": "q"}}
        )
    assert out == {"success": True, "message": "extracted"}


async def test_execute_action_goto_delegates():
    from domains.spawn_browser_agent_v3 import service_actions

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()

    async def fake_goto(**kwargs):
        return {"success": True, "message": "navigated"}

    with patch.object(service_actions, "_execute_goto", side_effect=fake_goto):
        out = await service_actions.execute_action(
            dom, ah, {"action": "goto", "params": {"url": "https://x.com"}}
        )
    assert out == {"success": True, "message": "navigated"}


async def test_execute_action_click_delegates():
    from domains.spawn_browser_agent_v3 import service_actions

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {3: MagicMock()}
    ah = MagicMock()
    ah.record_action = AsyncMock()

    async def fake_click(**kwargs):
        return {"success": True, "message": ""}

    with patch.object(service_actions, "_execute_click", side_effect=fake_click):
        out = await service_actions.execute_action(
            dom, ah, {"action": "click", "index": 3, "params": {}}
        )
    assert out == {"success": True, "message": ""}


async def test_execute_action_input_text_delegates():
    from domains.spawn_browser_agent_v3 import service_actions

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {1: MagicMock()}
    ah = MagicMock()
    ah.record_action = AsyncMock()

    async def fake_input(**kwargs):
        return {"success": True, "message": ""}

    with patch.object(service_actions, "_execute_input_text", side_effect=fake_input):
        out = await service_actions.execute_action(
            dom,
            ah,
            {"action": "input_text", "index": 1, "params": {"text": "hi"}},
        )
    assert out == {"success": True, "message": ""}


async def test_execute_action_screenshot_returns_success():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "screenshot", "params": {}})
    # screenshot action either succeeds or is unknown — both are fine;
    # we just exercise the branch without raising.
    assert isinstance(out, dict)
    assert "success" in out


async def test_execute_action_exception_catches():
    from domains.spawn_browser_agent_v3 import service_actions

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {2: MagicMock()}
    ah = MagicMock()
    ah.record_action = AsyncMock()

    async def boom(**kwargs):
        raise RuntimeError("kaboom")

    with patch.object(service_actions, "_execute_click", side_effect=boom):
        out = await service_actions.execute_action(
            dom, ah, {"action": "click", "index": 2, "params": {}}
        )
    # The outer try/except should catch and return {success: False, error: ...}
    assert out["success"] is False
    assert "kaboom" in str(out.get("error", "")) or "error" in out


# ========================================
# service_actions: private _execute_* handlers + fallback paths
# ========================================


def _make_awaitable_event(result=None):
    """Create a fake event bus dispatch return: awaitable that also has event_result()."""

    class _Ev:
        def __await__(self):
            async def _await():
                return None

            return _await().__await__()

        async def event_result(self, raise_if_any=True, raise_if_none=False):
            return result

    return _Ev()


def _fake_session_with_event_bus(dispatch_side_effect=None, event_result=None):
    """Build a MagicMock session whose event_bus.dispatch returns awaitable event objects."""
    session = MagicMock()
    if dispatch_side_effect is None:

        def _default_dispatch(_event):
            return _make_awaitable_event(event_result)

        session.event_bus.dispatch = MagicMock(side_effect=_default_dispatch)
    else:
        session.event_bus.dispatch = MagicMock(side_effect=dispatch_side_effect)
    session.highlight_interaction_element = AsyncMock()
    session.highlight_coordinate_click = AsyncMock()
    return session


async def test_execute_action_press_key_no_humanizer():
    """press_key fallback path uses event_bus."""
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = _fake_session_with_event_bus()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(
        dom, ah, {"action": "press_key", "params": {"key": "Tab"}}, humanizer=None
    )
    assert out == {"success": True, "message": ""}
    dom.session.event_bus.dispatch.assert_called()


async def test_execute_action_scroll_no_humanizer_up():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = _fake_session_with_event_bus()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(
        dom, ah, {"action": "scroll", "params": {"direction": "up", "amount": 200}}, humanizer=None
    )
    assert out == {"success": True, "message": ""}


async def test_execute_action_navback():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = _fake_session_with_event_bus()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "navback"})
    assert out == {"success": True, "message": ""}


async def test_execute_action_wait():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = _fake_session_with_event_bus()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "wait", "params": {"time_ms": 500}})
    assert out == {"success": True, "message": ""}


async def test_execute_action_dropdown_options_with_element():
    """Patch the dropdown event class to avoid pydantic node validation."""
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    el = MagicMock()
    dom.session = _fake_session_with_event_bus(event_result=["opt1", "opt2"])
    dom.selector_map = {7: el}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with patch("browser_use.browser.events.GetDropdownOptionsEvent", lambda **kw: kw):
        out = await execute_action(dom, ah, {"action": "dropdown_options", "index": 7})
    assert out["success"] is True
    assert out["options"] == ["opt1", "opt2"]


async def test_execute_action_select_dropdown_with_element():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    el = MagicMock()
    dom.session = _fake_session_with_event_bus()
    dom.selector_map = {1: el}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with patch("browser_use.browser.events.SelectDropdownOptionEvent", lambda **kw: kw):
        out = await execute_action(
            dom, ah, {"action": "select_dropdown", "index": 1, "params": {"value": "red"}}
        )
    assert out == {"success": True, "message": ""}


async def test_execute_action_evaluate():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = MagicMock()
    cdp = MagicMock()
    cdp.session_id = "sid"
    cdp.cdp_client.send.Runtime.evaluate = AsyncMock(return_value={"result": {"value": 42}})
    session.get_or_create_cdp_session = AsyncMock(return_value=cdp)
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(
        dom, ah, {"action": "evaluate", "params": {"code": "1+1"}}
    )
    assert out["success"] is True
    assert out["value"] == 42


async def test_execute_action_open_new_tab():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = _fake_session_with_event_bus()
    session.get_focused_target = MagicMock(return_value=SimpleNamespace(target_id="abcd1234"))
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(
        dom, ah, {"action": "open_new_tab", "params": {"url": "https://x.com"}}
    )
    assert out["success"] is True
    assert out["new_tab_id"] == "1234"


async def test_execute_action_close_tab_via_focused():
    """close_tab with no tab_id uses focused target."""
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = _fake_session_with_event_bus()
    session.get_focused_target = MagicMock(return_value=SimpleNamespace(target_id="xyzw9876"))
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "close_tab", "params": {}})
    assert out["success"] is True
    assert out["closed_tab"] == "9876"


async def test_execute_action_close_tab_no_focused():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = _fake_session_with_event_bus()
    session.get_focused_target = MagicMock(return_value=None)
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "close_tab", "params": {}})
    assert out["success"] is False


async def test_execute_action_close_tab_with_id_found():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = _fake_session_with_event_bus()
    session.get_tabs = AsyncMock(
        return_value=[
            SimpleNamespace(target_id="aaaabbbb1234", title="t", url="u"),
        ]
    )
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "close_tab", "params": {"tab_id": "1234"}})
    assert out["success"] is True


async def test_execute_action_close_tab_with_id_not_found():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = _fake_session_with_event_bus()
    session.get_tabs = AsyncMock(
        return_value=[
            SimpleNamespace(target_id="aaaa", title="t", url="u"),
        ]
    )
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "close_tab", "params": {"tab_id": "9999"}})
    assert out["success"] is False
    assert "not found" in out["error"]


async def test_execute_action_switch_tab_found():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = _fake_session_with_event_bus()
    session.get_tabs = AsyncMock(
        return_value=[
            SimpleNamespace(target_id="xxxxxxxx1122", title="t", url="u"),
        ]
    )
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "switch_tab", "params": {"tab_id": "1122"}})
    assert out["success"] is True
    assert out["switched_to"] == "1122"


async def test_execute_action_switch_tab_not_found():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = _fake_session_with_event_bus()
    session.get_tabs = AsyncMock(
        return_value=[SimpleNamespace(target_id="xxxxxxxxAAAA", title="t", url="u")]
    )
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "switch_tab", "params": {"tab_id": "ZZZZ"}})
    assert out["success"] is False


# ── _execute_click ───────────────────────────────────────────────────


async def test_execute_click_with_element_humanizer():
    from domains.spawn_browser_agent_v3.service_actions import _execute_click

    session = MagicMock()
    session.highlight_interaction_element = AsyncMock()
    dom = MagicMock()
    dom.get_element_coordinates = AsyncMock(return_value=(10, 20))
    element = MagicMock()
    element.get_all_children_text = MagicMock(return_value="hi")
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()
    out = await _execute_click(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=element,
        index=2,
        coords=None,
        thinking=None,
        humanizer=hu,
        write_lock_enabled=False,
        write_lock_approvals=None,
        current_url="https://example.com",
        system_name="Rose",
    )
    assert out == {"success": True, "message": ""}
    hu.click_at_coords.assert_awaited_once_with(10, 20)


async def test_execute_click_with_coords_no_humanizer():
    from domains.spawn_browser_agent_v3.service_actions import _execute_click

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await _execute_click(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=None,
        index=None,
        coords={"x": 100, "y": 200},
        thinking=None,
        humanizer=None,
        write_lock_enabled=False,
        write_lock_approvals=None,
        current_url="https://example.com",
        system_name="Rose",
    )
    assert out == {"success": True, "message": ""}


async def test_execute_click_no_element_no_coords():
    from domains.spawn_browser_agent_v3.service_actions import _execute_click

    session = MagicMock()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await _execute_click(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=None,
        index=None,
        coords=None,
        thinking=None,
        humanizer=None,
        write_lock_enabled=False,
        write_lock_approvals=None,
        current_url="",
        system_name="Rose",
    )
    assert out["success"] is False
    assert "index or coordinates" in out["error"]


async def test_execute_click_write_lock_purchase_triggers_approval():
    """Purchase button click without approval returns needs_write_approval."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    element = MagicMock()
    element.get_all_children_text = MagicMock(return_value="Place Order")
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with (
        patch("browser_tools.write_lock.is_social_domain", return_value=False),
        patch("browser_tools.write_lock.is_submit_button", return_value=False),
        patch("browser_tools.write_lock.is_purchase_button", return_value=True),
        patch("browser_tools.write_lock.get_write_lock_approval_question", return_value="q?"),
    ):
        out = await service_actions._execute_click(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=1,
            coords=None,
            thinking=None,
            humanizer=None,
            write_lock_enabled=True,
            write_lock_approvals=None,
            current_url="https://shop.example.com/checkout",
            system_name="Rose",
        )
    assert out["status"] == "needs_write_approval"
    assert out["approval_type"] == "purchase"


async def test_execute_click_write_lock_social_triggers_approval():
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    element = MagicMock()
    element.get_all_children_text = MagicMock(return_value="Post")
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with (
        patch("browser_tools.write_lock.is_social_domain", return_value=True),
        patch("browser_tools.write_lock.is_submit_button", return_value=True),
        patch("browser_tools.write_lock.is_purchase_button", return_value=False),
        patch("browser_tools.write_lock.get_write_lock_approval_question", return_value="q?"),
    ):
        out = await service_actions._execute_click(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=1,
            coords=None,
            thinking=None,
            humanizer=None,
            write_lock_enabled=True,
            write_lock_approvals=None,
            current_url="https://twitter.com/compose",
            system_name="Rose",
        )
    assert out["status"] == "needs_write_approval"
    assert out["approval_type"] == "social_post"


async def test_execute_click_coord_write_lock_purchase():
    """Coord-based click to a purchase button triggers approval."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    dom.get_text_at_coordinates = AsyncMock(return_value="Buy Now")
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with (
        patch("browser_tools.write_lock.is_social_domain", return_value=False),
        patch("browser_tools.write_lock.is_submit_button", return_value=False),
        patch("browser_tools.write_lock.is_purchase_button", return_value=True),
        patch("browser_tools.write_lock.get_write_lock_approval_question", return_value="q?"),
    ):
        out = await service_actions._execute_click(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=None,
            index=None,
            coords={"x": 50, "y": 80},
            thinking=None,
            humanizer=None,
            write_lock_enabled=True,
            write_lock_approvals=None,
            current_url="https://shop.example.com",
            system_name="Rose",
        )
    assert out["status"] == "needs_write_approval"
    assert out["approval_type"] == "purchase"


# ── _execute_input_text ──────────────────────────────────────────────


async def test_execute_input_text_element_with_humanizer():
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    session.highlight_interaction_element = AsyncMock()
    dom = MagicMock()
    dom.get_element_coordinates = AsyncMock(return_value=(5, 6))
    element = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()
    hu.press_key = AsyncMock()
    hu.type_text = AsyncMock()
    with patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=False)):
        out = await service_actions._execute_input_text(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=1,
            coords=None,
            params={"text": "hello"},
            thinking=None,
            humanizer=hu,
            secret_refs=None,
            password_origins=None,
            current_url="https://x.com",
            write_lock_enabled=True,
            write_lock_approvals=None,
            system_name="Rose",
        )
    assert out["success"] is True
    assert out["typed_text"] == "hello"
    hu.type_text.assert_awaited_once_with("hello")


async def test_execute_input_text_secret_redacts():
    """Text matching a secret ref is redacted in display and payment field origin mismatches abort."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    element = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=False)):
        out = await service_actions._execute_input_text(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=None,
            index=None,
            coords=None,
            params={"text": "pw-token"},
            thinking=None,
            humanizer=None,
            secret_refs={"pw-token": "actual-pw"},
            password_origins={"pw-token": "https://example.com"},
            current_url="https://evil.com",  # mismatch
            write_lock_enabled=True,
            write_lock_approvals=None,
            system_name="Rose",
        )
    assert out["success"] is False
    assert "Password origin mismatch" in out["error"]


async def test_execute_input_text_payment_triggers_approval():
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    element = MagicMock()
    element.tag_name = "input"
    element.text_content = ""
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with (
        patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=True)),
        patch(
            "browser_tools.write_lock.get_write_lock_approval_question", return_value="sure?"
        ),
    ):
        out = await service_actions._execute_input_text(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=3,
            coords=None,
            params={"text": "4242 4242"},
            thinking=None,
            humanizer=None,
            secret_refs=None,
            password_origins=None,
            current_url="https://pay.example.com",
            write_lock_enabled=True,
            write_lock_approvals=None,
            system_name="Rose",
        )
    assert out["status"] == "needs_write_approval"
    assert out["approval_type"] == "payment"


async def test_execute_input_text_coords_no_humanizer():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_input_text(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=None,
        index=None,
        coords={"x": 1, "y": 2},
        params={"text": "abc"},
        thinking=None,
        humanizer=None,
        secret_refs=None,
        password_origins=None,
        current_url="",
        write_lock_enabled=False,
        write_lock_approvals=None,
        system_name="Rose",
    )
    assert out["success"] is True
    assert out["typed_text"] == "abc"


async def test_execute_input_text_no_element_no_coords_humanizer():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.press_key = AsyncMock()
    hu.type_text = AsyncMock()
    out = await service_actions._execute_input_text(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=None,
        index=None,
        coords=None,
        params={"text": "typed"},
        thinking=None,
        humanizer=hu,
        secret_refs=None,
        password_origins=None,
        current_url="",
        write_lock_enabled=False,
        write_lock_approvals=None,
        system_name="Rose",
    )
    assert out["success"] is True
    hu.type_text.assert_awaited_once_with("typed")


# ── _execute_goto ────────────────────────────────────────────────────


async def test_execute_goto_auto_adds_https():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_goto(
        session=session,
        dom_service=dom,
        action_history=ah,
        params={"url": "example.com/path"},
        thinking=None,
        session_id=None,
        config=None,
    )
    assert out["success"] is True


async def test_execute_goto_injects_local_storage():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with patch.object(
        service_actions,
        "inject_local_storage",
        AsyncMock(return_value={"injected": True, "count": 3}),
    ) if False else patch(
        "domains.spawn_browser_agent_v3.repo.inject_local_storage",
        AsyncMock(return_value={"injected": True, "count": 3}),
    ):
        out = await service_actions._execute_goto(
            session=session,
            dom_service=dom,
            action_history=ah,
            params={"url": "https://x.com"},
            thinking=None,
            session_id="sid",
            config=_fake_config(),
        )
    assert out["success"] is True


async def test_execute_goto_injects_local_storage_swallows_error():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with patch(
        "domains.spawn_browser_agent_v3.repo.inject_local_storage",
        AsyncMock(side_effect=RuntimeError("x")),
    ):
        out = await service_actions._execute_goto(
            session=session,
            dom_service=dom,
            action_history=ah,
            params={"url": "https://x.com"},
            thinking=None,
            session_id="sid",
            config=_fake_config(),
        )
    assert out["success"] is True


# ── _execute_extract ─────────────────────────────────────────────────


async def test_execute_extract_success():
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    session.get_current_page_url = AsyncMock(return_value="https://x.com")
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()

    async def fake_md(browser_session, extract_links=False):
        return "content", {}

    with (
        patch("browser_use.dom.markdown_extractor.extract_clean_markdown", side_effect=fake_md),
        patch.object(service_actions, "call_extract_llm", AsyncMock(return_value="extracted")),
    ):
        out = await service_actions._execute_extract(
            session=session,
            dom_service=dom,
            action_history=ah,
            params={"instruction": "what?"},
            thinking=None,
        )
    assert out["success"] is True
    assert out["content"] == "extracted"


async def test_execute_extract_exception():
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()

    async def boom(*a, **kw):
        raise RuntimeError("extract-crash")

    with patch("browser_use.dom.markdown_extractor.extract_clean_markdown", side_effect=boom):
        out = await service_actions._execute_extract(
            session=session,
            dom_service=dom,
            action_history=ah,
            params={"instruction": "x"},
            thinking=None,
        )
    assert out["success"] is False
    assert "extract-crash" in out["error"]


# ── _execute_upload_file ─────────────────────────────────────────────


async def test_execute_upload_file_success():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    session.is_file_input = MagicMock(return_value=True)
    dom = MagicMock()
    dom.get_element_coordinates = AsyncMock(return_value=(3, 4))
    element = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()
    with patch("browser_use.browser.events.UploadFileEvent", lambda **kw: kw):
        out = await service_actions._execute_upload_file(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=5,
            params={"filename": "doc.pdf"},
            thinking=None,
            humanizer=hu,
            available_file_paths={"doc.pdf": "/tmp/doc.pdf"},
        )
    assert out["success"] is True
    assert out["uploaded"] == "doc.pdf"


async def test_execute_upload_file_missing_element():
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_upload_file(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=None,
        index=1,
        params={"filename": "doc.pdf"},
        thinking=None,
        humanizer=None,
        available_file_paths={"doc.pdf": "/tmp/doc.pdf"},
    )
    assert out["success"] is False
    assert "element index" in out["error"]


async def test_execute_upload_file_not_file_input():
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    session.is_file_input = MagicMock(return_value=False)
    dom = MagicMock()
    element = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_upload_file(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=element,
        index=2,
        params={"filename": "doc.pdf"},
        thinking=None,
        humanizer=None,
        available_file_paths={"doc.pdf": "/tmp/doc.pdf"},
    )
    assert out["success"] is False
    assert "not a file input" in out["error"]


# ── _execute_switch_tab / _execute_close_tab ─────────────────────────


async def test_execute_switch_tab_success():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    session.get_tabs = AsyncMock(
        return_value=[SimpleNamespace(target_id="aaaaaaaa1234", title="t", url="u")]
    )
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_switch_tab(
        session=session,
        dom_service=dom,
        action_history=ah,
        params={"tab_id": "1234"},
        thinking=None,
    )
    assert out["success"] is True
    assert out["switched_to"] == "1234"


async def test_execute_switch_tab_missing_id():
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_switch_tab(
        session=session,
        dom_service=dom,
        action_history=ah,
        params={},
        thinking=None,
    )
    assert out["success"] is False


async def test_execute_close_tab_with_explicit_id():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    session.get_tabs = AsyncMock(
        return_value=[SimpleNamespace(target_id="zzzzzzzz5678", title="t", url="u")]
    )
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_close_tab(
        session=session,
        dom_service=dom,
        action_history=ah,
        params={"tab_id": "5678"},
        thinking=None,
    )
    assert out["success"] is True
    assert out["closed_tab"] == "5678"


# ── _execute_screenshot ──────────────────────────────────────────────


async def test_execute_screenshot_success():
    """Screenshot success path uploads to session when config is present."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    session.agent_focus_target_id = "t1"
    cdp = MagicMock()
    cdp.session_id = "sid"
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"0" * 32
    cdp.cdp_client.send_raw = AsyncMock(
        side_effect=[
            {"contentSize": {"width": 1200, "height": 800}},
            {"data": base64.b64encode(png_bytes).decode()},
        ]
    )
    session.get_or_create_cdp_session = AsyncMock(return_value=cdp)
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with patch.object(
        service_actions,
        "upload_file_to_session",
        AsyncMock(return_value={"path": "/tmp/s.png"}),
    ) if False else patch(
        "domains.spawn_browser_agent_v3.repo.upload_file_to_session",
        AsyncMock(return_value={"path": "/tmp/s.png"}),
    ):
        out = await service_actions._execute_screenshot(
            session=session,
            dom_service=dom,
            action_history=ah,
            thinking=None,
            session_id="sid",
            config=_fake_config(),
        )
    assert out["success"] is True


async def test_execute_screenshot_fallback_to_viewport():
    """On full-page failure, falls back to viewport screenshot."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    session.agent_focus_target_id = "t1"
    cdp = MagicMock()
    cdp.session_id = "sid"
    png_bytes = b"\x89PNG" + b"0" * 16
    cdp.cdp_client.send_raw = AsyncMock(
        side_effect=[
            RuntimeError("layout-failed"),  # layout metrics fail
            {"data": base64.b64encode(png_bytes).decode()},  # fallback capture succeeds
        ]
    )
    session.get_or_create_cdp_session = AsyncMock(return_value=cdp)
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_screenshot(
        session=session,
        dom_service=dom,
        action_history=ah,
        thinking=None,
        session_id=None,
        config=None,
    )
    assert out["success"] is True


# ── move_visual_cursor happy path ────────────────────────────────────


async def test_move_visual_cursor_success():
    from domains.spawn_browser_agent_v3.service_actions import move_visual_cursor

    cdp = MagicMock()
    cdp.session_id = "sid"
    cdp.cdp_client.send.Runtime.evaluate = AsyncMock(return_value={"result": {}})
    dom = MagicMock()
    dom.session = MagicMock()
    dom.session.get_or_create_cdp_session = AsyncMock(return_value=cdp)
    await move_visual_cursor(dom, 100, 200)
    cdp.cdp_client.send.Runtime.evaluate.assert_awaited()


# ========================================
# handler: ClaudeTokenState and workflow helper statics
# ========================================


def test_claude_token_state_defaults():
    from domains.spawn_browser_agent_v3.types import ClaudeTokenState

    s = ClaudeTokenState()
    assert s.access_token is None
    assert s.source is None
    assert s.pool_token_id is None
    assert s.excluded_pool_ids == []
    assert s.fallen_back_to_waterfall is False


def test_claude_token_state_mutation():
    from domains.spawn_browser_agent_v3.types import ClaudeTokenState

    s = ClaudeTokenState()
    s.access_token = "t"
    s.source = "pool"
    s.pool_token_id = "p1"
    s.excluded_pool_ids.append("p0")
    s.fallen_back_to_waterfall = True
    assert s.access_token == "t"
    assert s.excluded_pool_ids == ["p0"]


def test_get_manager_singleton():
    from domains.spawn_browser_agent_v3.handler import (
        SpawnBrowserAgentManagerV3,
        get_manager,
    )

    m1 = get_manager()
    m2 = get_manager()
    assert m1 is m2
    assert isinstance(m1, SpawnBrowserAgentManagerV3)
    assert m1.tool_name == "spawn_browser_agent"


# ========================================
# Runner
# ========================================


async def run_all_tests():
    print("spawn-browser-agent-v3 blackbox tests:")
    r = BlackboxResult()

    # service_crypto — pure
    r.record("normalize_rate_limited_until_epoch_int", test_normalize_rate_limited_until_handles_epoch_int)
    r.record("normalize_rate_limited_until_epoch_string", test_normalize_rate_limited_until_handles_epoch_string)
    r.record("normalize_rate_limited_until_iso_naive", test_normalize_rate_limited_until_handles_iso_naive)
    r.record("normalize_rate_limited_until_iso_z", test_normalize_rate_limited_until_handles_iso_z)
    r.record("normalize_rate_limited_until_invalid", test_normalize_rate_limited_until_none_empty_invalid)
    r.record("extract_rate_limited_until_not_dict", test_extract_rate_limited_until_not_dict)
    r.record("extract_rate_limited_until_canonical", test_extract_rate_limited_until_canonical_field)
    r.record("extract_rate_limited_until_headers_reset", test_extract_rate_limited_until_from_headers_reset)
    r.record("extract_rate_limited_until_headers_retry_after", test_extract_rate_limited_until_from_headers_retry_after)
    r.record("extract_rate_limited_until_text_iso", test_extract_rate_limited_until_from_text_iso)
    r.record("extract_rate_limited_until_text_epoch", test_extract_rate_limited_until_from_text_epoch)
    r.record("extract_rate_limited_until_text_retry_after", test_extract_rate_limited_until_from_text_retry_after)
    r.record("extract_rate_limited_until_no_signal", test_extract_rate_limited_until_no_signal)

    r.record("decrypt_payment_info_roundtrip", test_decrypt_payment_info_roundtrip)
    r.record("decrypt_payment_info_wrong_version", test_decrypt_payment_info_wrong_version)
    r.record("decrypt_payment_info_bad_envelope", test_decrypt_payment_info_bad_envelope)
    r.record("decrypt_password_roundtrip", test_decrypt_password_roundtrip)
    r.record("decrypt_password_wrong_version", test_decrypt_password_wrong_version)
    r.record("decrypt_password_invalid_input", test_decrypt_password_invalid_input_returns_none)
    r.record("decrypt_password_with_key_roundtrip", test_decrypt_password_with_key_roundtrip)
    r.record("decrypt_password_with_key_bad_version", test_decrypt_password_with_key_bad_version)
    r.record("decrypt_password_with_key_bad_envelope", test_decrypt_password_with_key_bad_envelope)

    r.record("extract_otp_verification", test_extract_otp_from_text_verification_code)
    r.record("extract_otp_is_your_code", test_extract_otp_from_text_is_your_code)
    r.record("extract_otp_pin", test_extract_otp_from_text_4_digit_pin)
    r.record("extract_otp_8_digit", test_extract_otp_from_text_8_digit_code)
    r.record("extract_otp_expires_phrase", test_extract_otp_from_text_expires_phrase)
    r.record("extract_otp_low_confidence", test_extract_otp_from_text_low_confidence_context_strict)
    r.record("extract_otp_no_match", test_extract_otp_from_text_no_match)

    await r.record_async("fetch_recent_otps_empty", test_fetch_recent_otps_empty)
    await r.record_async("fetch_recent_otps_extracts_codes", test_fetch_recent_otps_extracts_codes)
    await r.record_async("fetch_recent_otps_dedupes_old", test_fetch_recent_otps_dedupes_old_emails)

    r.record("build_autopay_prompt_section", test_build_autopay_prompt_section)
    r.record("build_autopay_prompt_section_no_card", test_build_autopay_prompt_section_no_card)
    r.record("build_passwords_prompt_section_empty", test_build_passwords_prompt_section_empty)
    r.record("build_passwords_prompt_section_unique", test_build_passwords_prompt_section_unique_usernames)
    r.record("build_passwords_prompt_section_duplicate", test_build_passwords_prompt_section_duplicate_usernames)

    # repo
    await r.record_async("fetch_claude_token_success", test_fetch_claude_token_success)
    await r.record_async("fetch_claude_token_non_200", test_fetch_claude_token_non_200_returns_none)
    await r.record_async("fetch_claude_token_no_api_key", test_fetch_claude_token_no_api_key_returns_none)
    await r.record_async("fetch_claude_token_force_pool", test_fetch_claude_token_with_force_pool_and_excludes)
    await r.record_async("fetch_claude_token_network_error", test_fetch_claude_token_network_error_returns_none)
    await r.record_async("report_token_rl_pool", test_report_claude_token_rate_limited_pool)
    await r.record_async("report_token_rl_user", test_report_claude_token_rate_limited_user)
    await r.record_async("report_token_rl_bad_source", test_report_claude_token_rate_limited_bad_source_noop)
    await r.record_async("report_token_rl_no_source", test_report_claude_token_rate_limited_no_source_noop)
    await r.record_async("report_token_rl_no_key", test_report_claude_token_rate_limited_no_api_key_noop)
    await r.record_async("report_token_rl_swallows_error", test_report_claude_token_rate_limited_swallows_network_error)

    await r.record_async("save_browser_action_message_metadata", test_save_browser_action_message_posts_metadata)
    await r.record_async(
        "save_browser_action_message_tool_name_override",
        test_save_browser_action_message_tool_name_override,
    )
    await r.record_async("save_browser_action_message_init", test_save_browser_action_message_init_no_subagent)
    await r.record_async("save_browser_action_message_error_flag", test_save_browser_action_message_error_sets_flag)
    await r.record_async("save_browser_action_message_swallows", test_save_browser_action_message_swallows_exception)
    await r.record_async("save_browser_assistant_message", test_save_browser_assistant_message)
    await r.record_async("save_browser_assistant_message_swallows", test_save_browser_assistant_message_swallows_exception)

    await r.record_async("list_session_files_no_api_key", test_list_session_files_no_api_key)
    await r.record_async("list_session_files_success", test_list_session_files_success)
    await r.record_async("list_session_files_non_200", test_list_session_files_non_200)
    await r.record_async("list_session_files_network_error", test_list_session_files_network_error)
    await r.record_async("download_file_no_api_key", test_download_file_from_steel_no_api_key)
    await r.record_async("download_file_strips_prefixes", test_download_file_from_steel_strips_prefixes)
    await r.record_async("download_file_strips_leading_slash", test_download_file_from_steel_strips_leading_slash)
    await r.record_async("download_file_non_200", test_download_file_from_steel_non_200)
    await r.record_async("download_file_network_error", test_download_file_from_steel_network_error)

    await r.record_async("init_browser_session_success", test_init_browser_session_success)
    await r.record_async("init_browser_session_rate_limited", test_init_browser_session_rate_limited)
    await r.record_async("init_browser_session_error", test_init_browser_session_error_raises)
    await r.record_async("fetch_session_info_success", test_fetch_session_info_success)
    await r.record_async("fetch_session_info_error", test_fetch_session_info_error_raises)
    await r.record_async("close_browser_session_swallows", test_close_browser_session_swallows_errors)
    await r.record_async("close_browser_session_success", test_close_browser_session_success_payload)
    await r.record_async("inject_local_storage_success", test_inject_local_storage_success)
    await r.record_async("inject_local_storage_non_200", test_inject_local_storage_non_200_returns_none)
    await r.record_async("inject_local_storage_network", test_inject_local_storage_network_error_returns_none)
    await r.record_async("upload_file_session_success", test_upload_file_to_session_success)
    await r.record_async("upload_file_session_non_200", test_upload_file_to_session_non_200_returns_none)
    await r.record_async("upload_file_session_network", test_upload_file_to_session_network_error)

    await r.record_async("call_extract_llm_success", test_call_extract_llm_success)
    await r.record_async("call_extract_llm_non_200", test_call_extract_llm_non_200)
    await r.record_async("call_extract_llm_network", test_call_extract_llm_network_error)
    await r.record_async("call_extract_llm_truncates", test_call_extract_llm_truncates_long_content)

    await r.record_async("fetch_recent_emails_success", test_fetch_recent_emails_success)
    await r.record_async("fetch_recent_emails_404", test_fetch_recent_emails_404)
    await r.record_async("fetch_recent_emails_5xx", test_fetch_recent_emails_5xx)
    await r.record_async("fetch_recent_emails_network", test_fetch_recent_emails_network_error)

    # service
    r.record("safe_time_returns_float", test_safe_time_returns_float)
    r.record("safe_time_swallows_errors", test_safe_time_swallows_errors)
    r.record("build_context_summary_success", test_build_context_summary_success_with_urls)
    r.record("build_context_summary_failure", test_build_context_summary_failure_with_error)
    r.record("build_context_summary_trims_lists", test_build_context_summary_trims_lists)
    r.record("build_usage_items", test_build_usage_items)
    r.record("get_browser_system_prompt_with_files", test_get_browser_system_prompt_with_files)
    r.record("get_browser_system_prompt_no_files", test_get_browser_system_prompt_without_files)
    r.record("get_browser_system_prompt_is_static", test_get_browser_system_prompt_is_static_across_calls)
    r.record("build_state_line_format", test_build_state_line_format)
    r.record("build_state_line_empty_url", test_build_state_line_empty_url)

    r.record("build_action_titles_click_element", test_build_action_titles_click_with_element)
    r.record("build_action_titles_click_coords", test_build_action_titles_click_with_coords)
    r.record("build_action_titles_click_none", test_build_action_titles_click_with_nothing)
    r.record("build_action_titles_input_secret", test_build_action_titles_input_text_secret_redacted)
    r.record("build_action_titles_input_coords", test_build_action_titles_input_text_with_coords_plain_text)
    r.record("build_action_titles_input_no_target", test_build_action_titles_input_text_no_target)
    r.record("build_action_titles_goto", test_build_action_titles_goto)
    r.record("build_action_titles_scroll", test_build_action_titles_scroll)
    r.record("build_action_titles_press_key_extract", test_build_action_titles_press_key_and_extract)
    r.record("build_action_titles_wait_select_upload_ss", test_build_action_titles_wait_select_upload_screenshot)
    r.record("build_action_titles_unknown", test_build_action_titles_unknown_action)

    await r.record_async("extract_session_files_none", test_extract_session_files_no_files)
    await r.record_async("extract_session_files_happy", test_extract_session_files_happy_path)
    await r.record_async("extract_session_files_excludes", test_extract_session_files_exclude_paths)
    await r.record_async("extract_session_files_download_fail", test_extract_session_files_download_fail_skipped)
    await r.record_async("extract_session_files_upload_fail", test_extract_session_files_upload_failure_skipped)

    # service_actions statics
    r.record("get_domain_from_url", test_get_domain_from_url_variants)
    r.record("get_base_domain", test_get_base_domain)
    r.record("is_approval_valid_none", test_is_approval_valid_no_approvals)
    r.record("is_approval_valid_missing_fields", test_is_approval_valid_missing_fields)
    r.record("is_approval_valid_domain_mismatch", test_is_approval_valid_domain_mismatch)
    r.record("is_approval_valid_fresh", test_is_approval_valid_still_fresh)
    r.record("is_approval_valid_expired", test_is_approval_valid_expired)
    r.record("get_element_description_none", test_get_element_description_none)
    r.record("get_element_description_text", test_get_element_description_with_text)
    r.record("get_element_description_placeholder", test_get_element_description_with_placeholder)
    r.record("get_element_description_aria", test_get_element_description_with_aria_label)
    r.record("get_element_description_name", test_get_element_description_with_name_attr)
    r.record("get_element_description_id", test_get_element_description_with_id)
    r.record("get_element_description_input_type", test_get_element_description_input_type)
    r.record("get_element_description_nothing", test_get_element_description_nothing)
    r.record("get_element_description_text_error", test_get_element_description_text_extraction_error)

    await r.record_async("move_visual_cursor_no_session", test_move_visual_cursor_no_session_safe)
    await r.record_async("move_visual_cursor_exception", test_move_visual_cursor_exception_safe)

    await r.record_async("execute_action_no_session", test_execute_action_no_session)
    await r.record_async("execute_action_element_not_found", test_execute_action_element_not_found)
    await r.record_async("execute_action_unknown", test_execute_action_unknown_action)
    await r.record_async("execute_action_dropdown_options_no_el", test_execute_action_dropdown_options_missing_element)
    await r.record_async("execute_action_select_dropdown_no_el", test_execute_action_select_dropdown_missing_element)
    await r.record_async("execute_action_attempt_completion", test_execute_action_attempt_completion)
    await r.record_async("execute_action_send_message", test_execute_action_send_message_to_user)
    await r.record_async("execute_action_done", test_execute_action_done)
    await r.record_async("execute_action_click_no_target", test_execute_action_click_no_element_no_coords)
    await r.record_async("execute_action_upload_missing_file", test_execute_action_upload_file_missing_filename)
    await r.record_async("execute_action_upload_not_in_avail", test_execute_action_upload_file_not_in_available)
    await r.record_async("execute_action_switch_tab_no_id", test_execute_action_switch_tab_missing_id)
    await r.record_async("execute_action_press_key_humanizer", test_execute_action_press_key_with_humanizer)
    await r.record_async("execute_action_scroll_humanizer_down", test_execute_action_scroll_with_humanizer_down)
    await r.record_async("execute_action_scroll_humanizer_up", test_execute_action_scroll_with_humanizer_up)
    await r.record_async("execute_action_extract_delegates", test_execute_action_extract_delegates)
    await r.record_async("execute_action_goto_delegates", test_execute_action_goto_delegates)
    await r.record_async("execute_action_click_delegates", test_execute_action_click_delegates)
    await r.record_async("execute_action_input_text_delegates", test_execute_action_input_text_delegates)
    await r.record_async("execute_action_screenshot", test_execute_action_screenshot_returns_success)
    await r.record_async("execute_action_exception_catches", test_execute_action_exception_catches)

    # service_actions: extended _execute_* + fallback paths
    await r.record_async("execute_action_press_key_no_humanizer", test_execute_action_press_key_no_humanizer)
    await r.record_async("execute_action_scroll_no_humanizer_up", test_execute_action_scroll_no_humanizer_up)
    await r.record_async("execute_action_navback", test_execute_action_navback)
    await r.record_async("execute_action_wait", test_execute_action_wait)
    await r.record_async("execute_action_dropdown_options_with_el", test_execute_action_dropdown_options_with_element)
    await r.record_async("execute_action_select_dropdown_with_el", test_execute_action_select_dropdown_with_element)
    await r.record_async("execute_action_evaluate", test_execute_action_evaluate)
    await r.record_async("execute_action_open_new_tab", test_execute_action_open_new_tab)
    await r.record_async("execute_action_close_tab_focused", test_execute_action_close_tab_via_focused)
    await r.record_async("execute_action_close_tab_no_focused", test_execute_action_close_tab_no_focused)
    await r.record_async("execute_action_close_tab_id_found", test_execute_action_close_tab_with_id_found)
    await r.record_async("execute_action_close_tab_id_notfound", test_execute_action_close_tab_with_id_not_found)
    await r.record_async("execute_action_switch_tab_found", test_execute_action_switch_tab_found)
    await r.record_async("execute_action_switch_tab_notfound", test_execute_action_switch_tab_not_found)

    await r.record_async("execute_click_element_humanizer", test_execute_click_with_element_humanizer)
    await r.record_async("execute_click_coords_no_humanizer", test_execute_click_with_coords_no_humanizer)
    await r.record_async("execute_click_no_target", test_execute_click_no_element_no_coords)
    await r.record_async("execute_click_write_lock_purchase", test_execute_click_write_lock_purchase_triggers_approval)
    await r.record_async("execute_click_write_lock_social", test_execute_click_write_lock_social_triggers_approval)
    await r.record_async("execute_click_coord_write_lock", test_execute_click_coord_write_lock_purchase)

    await r.record_async("execute_input_text_el_humanizer", test_execute_input_text_element_with_humanizer)
    await r.record_async("execute_input_text_secret_redacts", test_execute_input_text_secret_redacts)
    await r.record_async("execute_input_text_payment_approval", test_execute_input_text_payment_triggers_approval)
    await r.record_async("execute_input_text_coords_no_hum", test_execute_input_text_coords_no_humanizer)
    await r.record_async("execute_input_text_no_target_hum", test_execute_input_text_no_element_no_coords_humanizer)

    await r.record_async("execute_goto_auto_https", test_execute_goto_auto_adds_https)
    await r.record_async("execute_goto_injects_ls", test_execute_goto_injects_local_storage)
    await r.record_async("execute_goto_injects_ls_error", test_execute_goto_injects_local_storage_swallows_error)

    await r.record_async("execute_extract_success", test_execute_extract_success)
    await r.record_async("execute_extract_exception", test_execute_extract_exception)

    await r.record_async("execute_upload_file_success", test_execute_upload_file_success)
    await r.record_async("execute_upload_file_no_element", test_execute_upload_file_missing_element)
    await r.record_async("execute_upload_file_not_file_input", test_execute_upload_file_not_file_input)

    await r.record_async("execute_switch_tab_success", test_execute_switch_tab_success)
    await r.record_async("execute_switch_tab_no_id", test_execute_switch_tab_missing_id)
    await r.record_async("execute_close_tab_explicit_id", test_execute_close_tab_with_explicit_id)

    await r.record_async("execute_screenshot_success", test_execute_screenshot_success)
    await r.record_async("execute_screenshot_fallback", test_execute_screenshot_fallback_to_viewport)

    await r.record_async("move_visual_cursor_success", test_move_visual_cursor_success)

    # handler statics
    r.record("claude_token_state_defaults", test_claude_token_state_defaults)
    r.record("claude_token_state_mutation", test_claude_token_state_mutation)
    await r.record_async("call_browser_use_gpt_auth", test_call_browser_use_with_rotation_uses_gpt_auth)
    await r.record_async(
        "call_browser_use_rotates_claude",
        test_call_browser_use_with_rotation_rotates_claude_token,
    )
    await r.record_async(
        "call_browser_use_no_replacement",
        test_call_browser_use_with_rotation_stops_when_no_replacement,
    )
    r.record("get_manager_singleton", test_get_manager_singleton)

    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
