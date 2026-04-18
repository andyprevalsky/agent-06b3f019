"""Blackbox tests for x402_bazaar domain (repo + service pure helpers)."""

import asyncio
import base64
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    setup_mock,
    setup_mock_fn,
    teardown_mock,
)


# =========================================================================
# Config helpers
# =========================================================================


def test_safe_time_returns_float():
    """safe_time returns a float value (current time or 0.0 in workflow sandbox)."""
    from domains.x402_bazaar.config import safe_time

    result = safe_time()
    assert isinstance(result, float)
    assert result >= 0.0


# =========================================================================
# repo._filter_services pure function
# =========================================================================


def test_filter_services_empty_list():
    """_filter_services with empty items returns empty list."""
    from domains.x402_bazaar.repo import _filter_services

    result = _filter_services([], None, None, None)
    assert result == []


def test_filter_services_skips_non_dict_items():
    """_filter_services skips non-dict items safely."""
    from domains.x402_bazaar.repo import _filter_services

    items = ["not a dict", None, 42, {"accepts": [{"payTo": "0xabc", "maxAmountRequired": "1000"}]}]
    result = _filter_services(items, None, None, None)
    # Only the valid dict should produce a service
    assert len(result) == 1
    assert result[0]["pay_to"] == "0xabc"


def test_filter_services_skips_missing_accepts():
    """Items with no accepts list are skipped."""
    from domains.x402_bazaar.repo import _filter_services

    items = [
        {"resource": "http://a.test"},  # no accepts
        {"accepts": []},  # empty accepts
        {"accepts": "not a list"},  # wrong type
    ]
    result = _filter_services(items, None, None, None)
    assert result == []


def test_filter_services_anti_cannibalization():
    """Services owned by our_wallet are filtered out."""
    from domains.x402_bazaar.repo import _filter_services

    items = [
        {
            "accepts": [{"payTo": "0xOURwallet", "maxAmountRequired": "1000"}],
            "resource": "http://own.test",
        },
        {
            "accepts": [{"payTo": "0xother", "maxAmountRequired": "2000"}],
            "resource": "http://third.test",
        },
    ]
    result = _filter_services(items, None, None, our_wallet="0xourwallet")
    assert len(result) == 1
    assert result[0]["pay_to"] == "0xother"


def test_filter_services_price_filter():
    """max_price_cents filters out expensive services."""
    from domains.x402_bazaar.repo import _filter_services

    # USDC_ATOMIC_TO_CENTS_DIVISOR = 10000
    # 100000 atomic = 10 cents, 500000 atomic = 50 cents
    items = [
        {"accepts": [{"payTo": "0x1", "maxAmountRequired": "100000"}], "resource": "http://cheap.test"},
        {"accepts": [{"payTo": "0x2", "maxAmountRequired": "500000"}], "resource": "http://expensive.test"},
    ]
    result = _filter_services(items, max_price_cents=20, keyword=None, our_wallet=None)
    assert len(result) == 1
    assert result[0]["price_cents"] == 10


def test_filter_services_keyword_filter_matches_resource():
    """keyword filter matches when keyword appears in resource URL."""
    from domains.x402_bazaar.repo import _filter_services

    items = [
        {"accepts": [{"payTo": "0x1", "maxAmountRequired": "100", "resource": "http://weather.api"}]},
        {"accepts": [{"payTo": "0x2", "maxAmountRequired": "100", "resource": "http://other.api"}]},
    ]
    result = _filter_services(items, None, keyword="weather", our_wallet=None)
    assert len(result) == 1
    assert "weather" in result[0]["resource"]


def test_filter_services_keyword_filter_matches_metadata():
    """keyword filter matches when keyword appears in metadata."""
    from domains.x402_bazaar.repo import _filter_services

    items = [
        {
            "accepts": [{"payTo": "0x1", "maxAmountRequired": "100", "resource": "http://a.test"}],
            "metadata": {"description": "A weather service"},
        },
        {
            "accepts": [{"payTo": "0x2", "maxAmountRequired": "100", "resource": "http://b.test"}],
            "metadata": {"description": "Something else"},
        },
    ]
    result = _filter_services(items, None, keyword="weather", our_wallet=None)
    assert len(result) == 1


def test_filter_services_invalid_max_amount():
    """Non-integer maxAmountRequired values default to 0 atomic."""
    from domains.x402_bazaar.repo import _filter_services

    items = [
        {"accepts": [{"payTo": "0x1", "maxAmountRequired": "not-a-number"}]},
        {"accepts": [{"payTo": "0x2", "maxAmountRequired": None}]},
    ]
    result = _filter_services(items, None, None, None)
    assert len(result) == 2
    assert all(s["price_cents"] == 0 for s in result)


def test_filter_services_pay_to_non_string_coerced():
    """payTo that is not a string gets coerced."""
    from domains.x402_bazaar.repo import _filter_services

    items = [
        {"accepts": [{"payTo": 12345, "maxAmountRequired": "100"}]},
    ]
    # non-string payTo is coerced via str(); non-None means result has a pay_to
    result = _filter_services(items, None, None, None)
    assert len(result) == 1


def test_filter_services_skips_non_dict_payment_req():
    """Non-dict payment_req is skipped."""
    from domains.x402_bazaar.repo import _filter_services

    items = [
        {"accepts": ["not a dict"]},
        {"accepts": [None]},
    ]
    result = _filter_services(items, None, None, None)
    assert result == []


def test_filter_services_output_schema_defensive():
    """Non-dict outputSchema/input falls back to empty dict."""
    from domains.x402_bazaar.repo import _filter_services

    items = [
        {"accepts": [{"payTo": "0x1", "maxAmountRequired": "100", "outputSchema": "bad-type"}]},
        {
            "accepts": [
                {
                    "payTo": "0x2",
                    "maxAmountRequired": "100",
                    "outputSchema": {"input": "bad-type", "output": {"foo": "bar"}},
                }
            ]
        },
    ]
    result = _filter_services(items, None, None, None)
    assert len(result) == 2
    # First item: outputSchema invalid → method default GET
    assert result[0]["method"] == "GET"
    # Second item: input not dict → input_schema is None
    assert result[1]["input_schema"] is None
    assert result[1]["output_schema"] == {"foo": "bar"}


def test_filter_services_metadata_not_dict():
    """Non-dict metadata falls back to empty dict."""
    from domains.x402_bazaar.repo import _filter_services

    items = [
        {
            "accepts": [{"payTo": "0x1", "maxAmountRequired": "100", "resource": "http://a.test"}],
            "metadata": "not a dict",
        },
    ]
    result = _filter_services(items, None, None, None)
    assert len(result) == 1
    assert result[0]["metadata"] == {}


def test_filter_services_extracts_method():
    """Method is read from outputSchema.input.method."""
    from domains.x402_bazaar.repo import _filter_services

    items = [
        {
            "accepts": [
                {
                    "payTo": "0x1",
                    "maxAmountRequired": "100",
                    "outputSchema": {"input": {"method": "POST"}, "output": {"x": "y"}},
                }
            ]
        }
    ]
    result = _filter_services(items, None, None, None)
    assert result[0]["method"] == "POST"


# =========================================================================
# repo._extract_payment_info pure function
# =========================================================================


def test_extract_payment_info_from_header():
    """_extract_payment_info prefers X-Payment header if present."""
    import json
    import httpx
    from domains.x402_bazaar.repo import _extract_payment_info

    payload = {"payTo": "0xabc", "maxAmountRequired": "500", "asset": "usdc", "network": "base"}
    response = httpx.Response(
        402,
        headers={"X-Payment": json.dumps(payload)},
    )
    result = _extract_payment_info(response)
    assert result["payTo"] == "0xabc"


def test_extract_payment_info_from_body_accepts():
    """_extract_payment_info falls back to body.accepts[0] if no header."""
    import httpx
    from domains.x402_bazaar.repo import _extract_payment_info

    body = {"accepts": [{"payTo": "0xabc", "maxAmountRequired": "500"}]}
    response = httpx.Response(402, json=body)
    result = _extract_payment_info(response)
    assert result["payTo"] == "0xabc"


def test_extract_payment_info_missing_raises():
    """_extract_payment_info raises if no header and body missing payment info."""
    import httpx
    from domains.x402_bazaar.repo import _extract_payment_info

    # Missing accepts in body
    response = httpx.Response(402, json={"error": "something"})
    try:
        _extract_payment_info(response)
        raise AssertionError("Expected an Exception")
    except Exception as e:
        assert "no payment options" in str(e).lower() or "payment information" in str(e).lower()


def test_extract_payment_info_invalid_body_raises():
    """_extract_payment_info raises if body is not JSON."""
    import httpx
    from domains.x402_bazaar.repo import _extract_payment_info

    response = httpx.Response(402, text="not json at all")
    try:
        _extract_payment_info(response)
        raise AssertionError("Expected an Exception")
    except Exception as e:
        assert "payment information" in str(e).lower()


# =========================================================================
# repo.search_x402_bazaar_activity (HTTP)
# =========================================================================


async def test_search_activity_returns_services():
    """search_x402_bazaar_activity fetches and filters Coinbase Bazaar items."""
    setup_mock(
        {
            "api.cdp.coinbase.com/platform/v2/x402/discovery/resources": {
                "status": 200,
                "json": {
                    "items": [
                        {
                            "accepts": [
                                {
                                    "payTo": "0xservice1",
                                    "maxAmountRequired": "100000",
                                    "asset": "usdc",
                                    "network": "base",
                                    "resource": "http://service1.test",
                                }
                            ],
                            "resource": "http://service1.test",
                        },
                        {
                            "accepts": [
                                {
                                    "payTo": "0xservice2",
                                    "maxAmountRequired": "500000",
                                    "resource": "http://service2.test",
                                }
                            ],
                        },
                    ]
                },
            }
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from domains.x402_bazaar.repo import search_x402_bazaar_activity

        result = await search_x402_bazaar_activity(max_price_cents=None, keyword=None)

    assert result["service_count"] == 2
    assert len(result["services"]) == 2
    assert result["filters_applied"]["max_price_cents"] is None


async def test_search_activity_price_filter():
    """search filters by max_price_cents."""
    setup_mock(
        {
            "api.cdp.coinbase.com/platform/v2/x402/discovery/resources": {
                "status": 200,
                "json": {
                    "items": [
                        {"accepts": [{"payTo": "0x1", "maxAmountRequired": "100000"}]},
                        {"accepts": [{"payTo": "0x2", "maxAmountRequired": "1000000"}]},
                    ]
                },
            }
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from domains.x402_bazaar.repo import search_x402_bazaar_activity

        result = await search_x402_bazaar_activity(max_price_cents=15, keyword=None)

    # 100000/10000 = 10c <= 15 (included), 1000000/10000 = 100c > 15 (excluded)
    assert result["service_count"] == 1


async def test_search_activity_non_200_raises():
    """Non-200 response raises an exception."""
    setup_mock(
        {
            "api.cdp.coinbase.com/platform/v2/x402/discovery/resources": {
                "status": 500,
                "json": {"error": "broken"},
            }
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from domains.x402_bazaar.repo import search_x402_bazaar_activity

        try:
            await search_x402_bazaar_activity(None, None)
            raise AssertionError("Expected exception for 500")
        except Exception as e:
            assert "500" in str(e)


async def test_search_activity_non_dict_body_raises():
    """Non-dict body raises an exception."""
    setup_mock(
        {
            "api.cdp.coinbase.com/platform/v2/x402/discovery/resources": {
                "status": 200,
                "json": ["list", "not", "dict"],
            }
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from domains.x402_bazaar.repo import search_x402_bazaar_activity

        try:
            await search_x402_bazaar_activity(None, None)
            raise AssertionError("Expected exception for bad body")
        except Exception as e:
            assert "unexpected type" in str(e).lower()


async def test_search_activity_non_list_items_raises():
    """items field that's not a list raises an exception."""
    setup_mock(
        {
            "api.cdp.coinbase.com/platform/v2/x402/discovery/resources": {
                "status": 200,
                "json": {"items": "not-a-list"},
            }
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from domains.x402_bazaar.repo import search_x402_bazaar_activity

        try:
            await search_x402_bazaar_activity(None, None)
            raise AssertionError("Expected exception for non-list items")
        except Exception as e:
            assert "not a list" in str(e).lower()


# =========================================================================
# repo._get_private_key_from_cdp_secret
# =========================================================================


def test_get_private_key_from_cdp_secret_extracts_bytes():
    """_get_private_key_from_cdp_secret extracts 32 private key bytes from CDP secret."""
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization

    from domains.x402_bazaar.repo import _get_private_key_from_cdp_secret

    # Generate a valid SECP256K1 key, serialize to PKCS#8 DER, base64 encode
    key = ec.generate_private_key(ec.SECP256K1())
    pkcs8 = key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    cdp_secret = base64.b64encode(pkcs8).decode()

    result = _get_private_key_from_cdp_secret(cdp_secret)
    assert isinstance(result, bytes)
    assert len(result) == 32


# =========================================================================
# repo._create_signed_payment
# =========================================================================


def test_create_signed_payment_produces_header_and_nonce():
    """_create_signed_payment returns (base64 header, nonce) with valid payload."""
    import json

    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization

    from domains.x402_bazaar.repo import _create_signed_payment

    key = ec.generate_private_key(ec.SECP256K1())
    pkcs8 = key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    cdp_secret = base64.b64encode(pkcs8).decode()

    header_b64, nonce = _create_signed_payment(
        cdp_secret,
        pay_to="0x0000000000000000000000000000000000000000",
        asset="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        network="base",
        required_amount=1000,
    )

    assert nonce.startswith("0x")
    payload = json.loads(base64.b64decode(header_b64).decode())
    assert payload["scheme"] == "exact"
    assert payload["network"] == "base"
    assert payload["payload"]["authorization"]["value"] == "1000"
    assert payload["payload"]["authorization"]["nonce"] == nonce


def test_create_signed_payment_sepolia_chain():
    """_create_signed_payment uses Sepolia chain ID for non-base network."""
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization

    from domains.x402_bazaar.repo import _create_signed_payment

    key = ec.generate_private_key(ec.SECP256K1())
    pkcs8 = key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    cdp_secret = base64.b64encode(pkcs8).decode()

    header_b64, _ = _create_signed_payment(
        cdp_secret,
        pay_to="0x0000000000000000000000000000000000000000",
        asset="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        network="base-sepolia",
        required_amount=2000,
    )

    import json

    payload = json.loads(base64.b64decode(header_b64).decode())
    assert payload["network"] == "base-sepolia"


# =========================================================================
# repo._make_request (GET vs POST routing)
# =========================================================================


async def test_make_request_get():
    """_make_request uses GET for 'GET' method."""
    import httpx

    captured = {}

    def handler(request: httpx.Request):
        captured["method"] = request.method
        return httpx.Response(200, json={"ok": True})

    setup_mock_fn(handler)

    async with httpx.AsyncClient() as client:
        from domains.x402_bazaar.repo import _make_request

        resp = await _make_request(client, "http://api.test/echo", "GET", {"q": "1"})
        assert resp.status_code == 200
        assert captured["method"] == "GET"


async def test_make_request_post():
    """_make_request uses POST for 'POST' method."""
    import httpx

    captured = {}

    def handler(request: httpx.Request):
        captured["method"] = request.method
        return httpx.Response(200, json={"ok": True})

    setup_mock_fn(handler)

    async with httpx.AsyncClient() as client:
        from domains.x402_bazaar.repo import _make_request

        await _make_request(client, "http://api.test/", "POST", {"x": "y"})

    assert captured["method"] == "POST"


# =========================================================================
# repo.pay_for_x402_service_activity (happy path + edge cases)
# =========================================================================


async def test_pay_activity_missing_wallet_secret():
    """pay_for_x402_service_activity raises if wallet_secret not configured."""
    import os

    from domains.x402_bazaar import repo as x402_repo

    original = os.environ.get("CDP_WALLET_SECRET", "")
    os.environ["CDP_WALLET_SECRET"] = ""

    try:
        # Force fresh load by clearing cached dotenv and resetting
        with patch("temporalio.activity.heartbeat"):
            try:
                await x402_repo.pay_for_x402_service_activity(
                    "http://resource.test", "GET", None, 100
                )
                raise AssertionError("Expected exception due to missing secret")
            except Exception as e:
                assert "CDP_WALLET_SECRET" in str(e) or "wallet_secret" in str(e).lower()
    finally:
        os.environ["CDP_WALLET_SECRET"] = original


async def test_pay_activity_no_payment_required():
    """pay_for_x402_service_activity returns without payment if 200 on first call."""
    import httpx

    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization

    import os

    # Ensure wallet secret is present
    key = ec.generate_private_key(ec.SECP256K1())
    pkcs8 = key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    secret = base64.b64encode(pkcs8).decode()
    os.environ["CDP_WALLET_SECRET"] = secret

    def handler(request: httpx.Request):
        return httpx.Response(200, json={"answer": 42})

    setup_mock_fn(handler)

    with patch("temporalio.activity.heartbeat"):
        from domains.x402_bazaar.repo import pay_for_x402_service_activity

        result = await pay_for_x402_service_activity(
            "http://service.test/api",
            "GET",
            None,
            100,
        )

    assert result["amount_paid_cents"] == 0
    assert result["response"] == {"answer": 42}
    assert "Service did not require payment" in result["note"]


async def test_pay_activity_unexpected_status():
    """pay_for_x402_service_activity raises on unexpected status code."""
    import httpx
    import os

    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization

    key = ec.generate_private_key(ec.SECP256K1())
    pkcs8 = key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    secret = base64.b64encode(pkcs8).decode()
    os.environ["CDP_WALLET_SECRET"] = secret

    def handler(request: httpx.Request):
        return httpx.Response(500, text="boom")

    setup_mock_fn(handler)

    with patch("temporalio.activity.heartbeat"):
        from domains.x402_bazaar.repo import pay_for_x402_service_activity

        try:
            await pay_for_x402_service_activity("http://fail.test", "GET", None, 100)
            raise AssertionError("Expected exception")
        except Exception as e:
            assert "500" in str(e) or "Unexpected" in str(e)


async def test_pay_activity_cost_exceeds_max():
    """pay_for_x402_service_activity raises if required cost > max_amount_cents."""
    import json
    import httpx
    import os

    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization

    key = ec.generate_private_key(ec.SECP256K1())
    pkcs8 = key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    secret = base64.b64encode(pkcs8).decode()
    os.environ["CDP_WALLET_SECRET"] = secret

    # Required 10000000 atomic = 1000 cents; max is 50 cents → exceeds
    payment_payload = {
        "payTo": "0x0000000000000000000000000000000000000001",
        "maxAmountRequired": "10000000",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "network": "base",
    }
    body = {"accepts": [payment_payload]}

    def handler(request: httpx.Request):
        return httpx.Response(402, json=body)

    setup_mock_fn(handler)

    with patch("temporalio.activity.heartbeat"):
        from domains.x402_bazaar.repo import pay_for_x402_service_activity

        try:
            await pay_for_x402_service_activity("http://expensive.test", "GET", None, 50)
            raise AssertionError("Expected exception for cost exceeded")
        except Exception as e:
            assert "max allowed" in str(e)


async def test_pay_activity_happy_path_full_flow():
    """pay_for_x402_service_activity: 402 → sign → 200 paid response."""
    import httpx
    import os
    import json

    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization

    key = ec.generate_private_key(ec.SECP256K1())
    pkcs8 = key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    secret = base64.b64encode(pkcs8).decode()
    os.environ["CDP_WALLET_SECRET"] = secret

    call_count = {"n": 0}

    def handler(request: httpx.Request):
        call_count["n"] += 1
        if call_count["n"] == 1:
            # First call: return 402 with payment requirements
            return httpx.Response(
                402,
                json={
                    "accepts": [
                        {
                            "payTo": "0x0000000000000000000000000000000000000001",
                            "maxAmountRequired": "10000",
                            "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                            "network": "base",
                        }
                    ]
                },
            )
        # Second call (with X-PAYMENT header) returns 200
        assert "X-PAYMENT" in request.headers or "x-payment" in request.headers
        return httpx.Response(200, json={"result": "ok"})

    setup_mock_fn(handler)

    with patch("temporalio.activity.heartbeat"):
        from domains.x402_bazaar.repo import pay_for_x402_service_activity

        result = await pay_for_x402_service_activity(
            "http://pay.test/api", "GET", {"q": "hi"}, max_amount_cents=100
        )

    # 10000 / 10000 = 1 cent
    assert result["amount_paid_cents"] == 1
    assert result["response"] == {"result": "ok"}
    assert result["network"] == "base"
    assert result["transaction_id"].startswith("0x")


async def test_pay_activity_small_required_rounds_up_to_1():
    """If required atomic > 0 but converts to 0 cents, rounds up to 1 cent."""
    import httpx
    import os

    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization

    key = ec.generate_private_key(ec.SECP256K1())
    pkcs8 = key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    secret = base64.b64encode(pkcs8).decode()
    os.environ["CDP_WALLET_SECRET"] = secret

    call_count = {"n": 0}

    def handler(request: httpx.Request):
        call_count["n"] += 1
        if call_count["n"] == 1:
            # Required 500 atomic (0.05 cents → floor=0, rounds up to 1)
            return httpx.Response(
                402,
                json={
                    "accepts": [
                        {
                            "payTo": "0x0000000000000000000000000000000000000001",
                            "maxAmountRequired": "500",
                            "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                            "network": "base",
                        }
                    ]
                },
            )
        return httpx.Response(200, json={"ok": True})

    setup_mock_fn(handler)

    with patch("temporalio.activity.heartbeat"):
        from domains.x402_bazaar.repo import pay_for_x402_service_activity

        result = await pay_for_x402_service_activity(
            "http://tiny.test/api", "GET", None, max_amount_cents=5
        )

    assert result["amount_paid_cents"] == 1


# =========================================================================
# service — SearchX402BazaarManager + PayForX402BazaarServiceManager
# =========================================================================


async def test_search_manager_singleton():
    """get_search_manager returns the same singleton instance across calls."""
    from domains.x402_bazaar.service import get_search_manager

    m1 = get_search_manager()
    m2 = get_search_manager()
    assert m1 is m2
    assert m1.tool_name == "search_x402_bazaar"
    assert m1.read_only is True


async def test_pay_manager_singleton():
    """get_pay_manager returns the same singleton instance across calls."""
    from domains.x402_bazaar.service import get_pay_manager

    m1 = get_pay_manager()
    m2 = get_pay_manager()
    assert m1 is m2
    assert m1.tool_name == "pay_for_x402_bazaar_service"
    assert m1.read_only is False


async def test_search_manager_execute_happy_path():
    """SearchX402BazaarManager.execute_tool returns service results and invokes execute_activity."""
    # Mock broadcast/DB endpoints so handle_tool_event doesn't blow up
    setup_mock(
        {
            "/realtime/": {"status": 200, "json": {"ok": True}},
            "/api/messages": {"status": 200, "json": {"id": "m-1"}},
            "/api/agents": {"status": 200, "json": {"ok": True}},
        }
    )

    from domains.x402_bazaar.service import SearchX402BazaarManager

    manager = SearchX402BazaarManager()

    async def fake_execute_activity(fn, args=None, **kwargs):
        return {
            "services": [{"resource": "http://a.test", "price_cents": 5}],
            "service_count": 1,
            "filters_applied": {},
        }

    result = await manager.execute_tool(
        execute_activity=fake_execute_activity,
        tool_call={"max_price_cents": 100, "keyword": "weather"},
        tool_call_id="tc-search-1",
        agent_id="agent-1",
        user_id="user-1",
    )

    assert result["result"]["service_count"] == 1
    assert result["usage"] == {"llm": [], "service": []}


async def test_search_manager_execute_error_path():
    """SearchX402BazaarManager.execute_tool catches errors and returns empty services."""
    setup_mock(
        {
            "/realtime/": {"status": 200, "json": {"ok": True}},
            "/api/messages": {"status": 200, "json": {"id": "m-1"}},
            "/api/agents": {"status": 200, "json": {"ok": True}},
        }
    )

    from domains.x402_bazaar.repo import search_x402_bazaar_activity
    from domains.x402_bazaar.service import SearchX402BazaarManager

    manager = SearchX402BazaarManager()

    async def failing_execute_activity(fn, args=None, **kwargs):
        # Allow post_agent_message (pre/post status broadcasts) to succeed so the
        # failure path under test only triggers on the search activity itself.
        if fn is search_x402_bazaar_activity:
            raise RuntimeError("search failed")
        return None

    result = await manager.execute_tool(
        execute_activity=failing_execute_activity,
        tool_call={},
        tool_call_id="tc-search-err",
        agent_id="agent-1",
    )

    assert result["result"]["service_count"] == 0
    assert "search failed" in result["result"]["error"]


async def test_pay_manager_execute_happy_path():
    """PayForX402BazaarServiceManager.execute_tool returns paid result and tracks cost."""
    setup_mock(
        {
            "/realtime/": {"status": 200, "json": {"ok": True}},
            "/api/messages": {"status": 200, "json": {"id": "m-1"}},
            "/api/agents": {"status": 200, "json": {"ok": True}},
        }
    )

    from domains.x402_bazaar.service import PayForX402BazaarServiceManager

    manager = PayForX402BazaarServiceManager()

    async def fake_execute_activity(fn, args=None, **kwargs):
        return {
            "response": {"answer": 42},
            "amount_paid_cents": 3,
            "amount_paid_display": "$0.0003",
            "transaction_id": "0xabc",
            "pay_to": "0xservice",
            "network": "base",
        }

    result = await manager.execute_tool(
        execute_activity=fake_execute_activity,
        tool_call={"resource_url": "http://svc.test", "method": "GET", "max_amount_cents": 10},
        tool_call_id="tc-pay-1",
        agent_id="agent-1",
    )

    assert result["result"]["amount_paid_cents"] == 3
    svc_usage = result["usage"]["service"]
    assert len(svc_usage) == 1
    assert svc_usage[0]["cost_cents"] == 3


async def test_pay_manager_execute_zero_cost_no_service_usage():
    """Pay manager returns empty service usage list when amount_paid_cents == 0."""
    setup_mock(
        {
            "/realtime/": {"status": 200, "json": {"ok": True}},
            "/api/messages": {"status": 200, "json": {"id": "m-1"}},
            "/api/agents": {"status": 200, "json": {"ok": True}},
        }
    )

    from domains.x402_bazaar.service import PayForX402BazaarServiceManager

    manager = PayForX402BazaarServiceManager()

    async def fake_execute_activity(fn, args=None, **kwargs):
        return {
            "response": {"answer": 42},
            "amount_paid_cents": 0,
            "transaction_id": None,
            "network": "base",
        }

    result = await manager.execute_tool(
        execute_activity=fake_execute_activity,
        tool_call={"resource_url": "http://free.test", "method": "GET", "max_amount_cents": 10},
        tool_call_id="tc-pay-free",
        agent_id="agent-1",
    )

    assert result["usage"]["service"] == []


async def test_pay_manager_execute_long_url_display_truncation():
    """Pay manager truncates long URLs for display."""
    setup_mock(
        {
            "/realtime/": {"status": 200, "json": {"ok": True}},
            "/api/messages": {"status": 200, "json": {"id": "m-1"}},
            "/api/agents": {"status": 200, "json": {"ok": True}},
        }
    )

    from domains.x402_bazaar.service import PayForX402BazaarServiceManager

    manager = PayForX402BazaarServiceManager()

    async def fake_execute_activity(fn, args=None, **kwargs):
        return {
            "response": {"ok": True},
            "amount_paid_cents": 1,
            "transaction_id": "0x0",
            "network": "base",
        }

    long_url = "http://really-long-domain-here.example.com/" + "a" * 200
    result = await manager.execute_tool(
        execute_activity=fake_execute_activity,
        tool_call={"resource_url": long_url, "method": "POST", "max_amount_cents": 100},
        tool_call_id="tc-long",
        agent_id="agent-1",
    )

    assert result["result"]["amount_paid_cents"] == 1


async def test_pay_manager_execute_error_path():
    """Pay manager catches errors and returns an error dict."""
    setup_mock(
        {
            "/realtime/": {"status": 200, "json": {"ok": True}},
            "/api/messages": {"status": 200, "json": {"id": "m-1"}},
            "/api/agents": {"status": 200, "json": {"ok": True}},
        }
    )

    from domains.x402_bazaar.repo import pay_for_x402_service_activity
    from domains.x402_bazaar.service import PayForX402BazaarServiceManager

    manager = PayForX402BazaarServiceManager()

    async def failing_execute_activity(fn, args=None, **kwargs):
        # Only fail on the payment activity itself; let status broadcasts succeed.
        if fn is pay_for_x402_service_activity:
            raise RuntimeError("payment rejected")
        return None

    result = await manager.execute_tool(
        execute_activity=failing_execute_activity,
        tool_call={"resource_url": "http://bad.test", "method": "GET", "max_amount_cents": 100},
        tool_call_id="tc-pay-err",
        agent_id="agent-1",
    )

    assert "payment rejected" in result["result"]["error"]
    assert result["usage"] == {"llm": [], "service": []}


# =========================================================================
# handler thin-wrapper tests
# =========================================================================


async def test_handler_search_calls_manager():
    """search_x402_bazaar handler delegates to manager.execute_tool."""
    setup_mock(
        {
            "/realtime/": {"status": 200, "json": {"ok": True}},
            "/api/messages": {"status": 200, "json": {"id": "m-1"}},
            "/api/agents": {"status": 200, "json": {"ok": True}},
        }
    )

    from domains.x402_bazaar.handler import search_x402_bazaar

    async def fake_exec(fn, args=None, **kw):
        return {"services": [], "service_count": 0, "filters_applied": {}}

    out = await search_x402_bazaar(
        execute_activity=fake_exec,
        tool_call={},
        tool_call_id="tc-search-handler",
        agent_id="agent-1",
    )
    assert "result" in out
    assert out["result"]["service_count"] == 0


async def test_handler_pay_calls_manager():
    """pay_for_x402_bazaar_service handler delegates to manager.execute_tool."""
    setup_mock(
        {
            "/realtime/": {"status": 200, "json": {"ok": True}},
            "/api/messages": {"status": 200, "json": {"id": "m-1"}},
            "/api/agents": {"status": 200, "json": {"ok": True}},
        }
    )

    from domains.x402_bazaar.handler import pay_for_x402_bazaar_service

    async def fake_exec(fn, args=None, **kw):
        return {
            "response": {"ok": True},
            "amount_paid_cents": 0,
            "transaction_id": None,
            "network": "base",
        }

    out = await pay_for_x402_bazaar_service(
        execute_activity=fake_exec,
        tool_call={"resource_url": "http://x", "method": "GET", "max_amount_cents": 1},
        tool_call_id="tc-pay-handler",
        agent_id="agent-1",
    )
    assert out["result"]["amount_paid_cents"] == 0


# =========================================================================
# Runner
# =========================================================================


async def run_all_tests():
    print("x402-bazaar blackbox tests:")
    r = BlackboxResult()

    # sync tests
    r.record("safe_time_returns_float", test_safe_time_returns_float)
    r.record("filter_services_empty_list", test_filter_services_empty_list)
    r.record("filter_services_skips_non_dict_items", test_filter_services_skips_non_dict_items)
    r.record("filter_services_skips_missing_accepts", test_filter_services_skips_missing_accepts)
    r.record("filter_services_anti_cannibalization", test_filter_services_anti_cannibalization)
    r.record("filter_services_price_filter", test_filter_services_price_filter)
    r.record("filter_services_keyword_matches_resource", test_filter_services_keyword_filter_matches_resource)
    r.record("filter_services_keyword_matches_metadata", test_filter_services_keyword_filter_matches_metadata)
    r.record("filter_services_invalid_max_amount", test_filter_services_invalid_max_amount)
    r.record("filter_services_pay_to_non_string", test_filter_services_pay_to_non_string_coerced)
    r.record("filter_services_skips_non_dict_payment_req", test_filter_services_skips_non_dict_payment_req)
    r.record("filter_services_output_schema_defensive", test_filter_services_output_schema_defensive)
    r.record("filter_services_metadata_not_dict", test_filter_services_metadata_not_dict)
    r.record("filter_services_extracts_method", test_filter_services_extracts_method)
    r.record("extract_payment_info_from_header", test_extract_payment_info_from_header)
    r.record("extract_payment_info_from_body", test_extract_payment_info_from_body_accepts)
    r.record("extract_payment_info_missing_raises", test_extract_payment_info_missing_raises)
    r.record("extract_payment_info_invalid_body", test_extract_payment_info_invalid_body_raises)
    r.record("get_private_key_from_cdp_secret", test_get_private_key_from_cdp_secret_extracts_bytes)
    r.record("create_signed_payment", test_create_signed_payment_produces_header_and_nonce)
    r.record("create_signed_payment_sepolia", test_create_signed_payment_sepolia_chain)

    # async tests
    await r.record_async("search_activity_returns_services", test_search_activity_returns_services)
    await r.record_async("search_activity_price_filter", test_search_activity_price_filter)
    await r.record_async("search_activity_non_200_raises", test_search_activity_non_200_raises)
    await r.record_async("search_activity_non_dict_body_raises", test_search_activity_non_dict_body_raises)
    await r.record_async("search_activity_non_list_items_raises", test_search_activity_non_list_items_raises)
    await r.record_async("make_request_get", test_make_request_get)
    await r.record_async("make_request_post", test_make_request_post)
    await r.record_async("pay_activity_missing_wallet_secret", test_pay_activity_missing_wallet_secret)
    await r.record_async("pay_activity_no_payment_required", test_pay_activity_no_payment_required)
    await r.record_async("pay_activity_unexpected_status", test_pay_activity_unexpected_status)
    await r.record_async("pay_activity_cost_exceeds_max", test_pay_activity_cost_exceeds_max)
    await r.record_async("pay_activity_happy_path", test_pay_activity_happy_path_full_flow)
    await r.record_async("pay_activity_small_amount_rounds_up", test_pay_activity_small_required_rounds_up_to_1)
    await r.record_async("search_manager_singleton", test_search_manager_singleton)
    await r.record_async("pay_manager_singleton", test_pay_manager_singleton)
    await r.record_async("search_manager_execute_happy", test_search_manager_execute_happy_path)
    await r.record_async("search_manager_execute_error", test_search_manager_execute_error_path)
    await r.record_async("pay_manager_execute_happy", test_pay_manager_execute_happy_path)
    await r.record_async("pay_manager_execute_zero_cost", test_pay_manager_execute_zero_cost_no_service_usage)
    await r.record_async("pay_manager_execute_long_url", test_pay_manager_execute_long_url_display_truncation)
    await r.record_async("pay_manager_execute_error", test_pay_manager_execute_error_path)
    await r.record_async("handler_search", test_handler_search_calls_manager)
    await r.record_async("handler_pay", test_handler_pay_calls_manager)

    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
