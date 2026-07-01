"""Blackbox tests for request-payment-card helpers and activities."""

import asyncio
import json

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    setup_mock,
    teardown_mock,
)


def _sample_tool_call():
    return {
        "merchant": "Example Shop",
        "currency": "usd",
        "line_items": [
            {
                "name": "Desk Lamp",
                "image_url": "https://example.com/lamp.png",
                "unit_price_cents": "1299",
                "quantity": 2,
                "line_total_cents": 2598,
            }
        ],
        "fees": [{"label": "Tax", "amount_cents": 210}],
        "subtotal_cents": 2598,
        "total_cents": 2808,
    }


def test_normalize_payload_builds_receipt_metadata_and_fingerprint():
    from domains.request_payment_card.service import normalize_payment_payload

    payload = normalize_payment_payload(_sample_tool_call(), "user-123")

    assert payload["userId"] == "user-123"
    assert payload["merchant"] == "Example Shop"
    assert payload["currency"] == "USD"
    assert payload["lineItems"] == [
        {
            "name": "Desk Lamp",
            "imageUrl": "https://example.com/lamp.png",
            "unitPriceCents": 1299,
            "quantity": 2,
            "lineTotalCents": 2598,
        }
    ]
    assert payload["fees"] == [{"label": "Tax", "amountCents": 210}]
    assert payload["subtotalCents"] == 2598
    assert payload["totalCents"] == 2808
    assert len(payload["fingerprint"]) == 64


def test_normalize_payload_accepts_serialized_browser_tool_args():
    from domains.request_payment_card.service import normalize_payment_payload

    payload = normalize_payment_payload(
        {
            "merchant": "Example Shop",
            "currency": "USD",
            "line_items": json.dumps(_sample_tool_call()["line_items"]),
            "fees": json.dumps([{"name": "Tax", "amount_cents": 210}]),
            "subtotal_cents": "2598",
            "total_cents": "2808",
        },
        "user-123",
    )

    assert payload["lineItems"][0]["name"] == "Desk Lamp"
    assert payload["fees"] == [{"label": "Tax", "amountCents": 210}]
    assert payload["subtotalCents"] == 2598
    assert payload["totalCents"] == 2808


def test_fingerprint_is_stable_and_user_scoped():
    from domains.request_payment_card.service import normalize_payment_payload

    base = normalize_payment_payload(_sample_tool_call(), "user-123")
    same = normalize_payment_payload(
        {**_sample_tool_call(), "merchant": " example shop "},
        "user-123",
    )
    other_user = normalize_payment_payload(_sample_tool_call(), "user-456")

    assert base["fingerprint"] == same["fingerprint"]
    assert base["fingerprint"] != other_user["fingerprint"]


def test_question_contains_receipt_but_no_card_secrets():
    from domains.request_payment_card.service import (
        build_payment_question,
        normalize_payment_payload,
    )

    payload = normalize_payment_payload(_sample_tool_call(), "user-123")
    question = build_payment_question(payload)

    assert "Approve a $28.08 purchase from Example Shop?" in question
    assert "Desk Lamp x2: $25.98" in question
    assert "Tax: $2.10" in question
    assert "one-time virtual card" in question
    assert "4242424242424242" not in question
    assert "cvv" not in question.lower()
    assert "pan" not in question.lower()


async def test_lookup_purchase_activity_boundary():
    setup_mock(
        {
            "/api/purchases/lookup": {
                "status": 200,
                "json": {"found": False, "reusable": False, "purchase": None},
            }
        }
    )

    from tools.request_payment_card import lookup_purchase_activity

    result = await lookup_purchase_activity("user-123", "fp-abc")

    assert result == {"found": False, "reusable": False, "purchase": None}
    call = assert_captured_call(url_contains="/api/purchases/lookup", method="GET")
    assert "fingerprint=fp-abc" in call["url"]
    assert "x-api-key" in {k.lower() for k in call["requestHeaders"]}
    assert call["requestHeaders"]["x-user-id"] == "user-123"


async def test_mint_purchase_card_activity_boundary():
    setup_mock(
        {
            "/api/purchases/mint": {
                "status": 200,
                "json": {
                    "purchaseId": "purchase-1",
                    "cardId": "card-1",
                    "pan": "4242424242424242",
                    "cvv": "123",
                    "expiry": "12/30",
                    "last4": "4242",
                    "status": "HELD",
                },
            }
        }
    )

    from domains.request_payment_card.service import normalize_payment_payload
    from tools.request_payment_card import mint_purchase_card_activity

    payload = normalize_payment_payload(_sample_tool_call(), "user-123")
    payload["agentId"] = "agent-1"
    result = await mint_purchase_card_activity("user-123", payload)

    assert result["cardId"] == "card-1"
    assert result["last4"] == "4242"
    call = assert_captured_call(url_contains="/api/purchases/mint", method="POST")
    body = json.loads(call["requestBody"])
    assert body["fingerprint"] == payload["fingerprint"]
    assert body["merchant"] == "Example Shop"
    assert body["agentId"] == "agent-1"
    assert body["lineItems"] == payload["lineItems"]
    assert body["fees"] == payload["fees"]
    assert body["subtotalCents"] == 2598
    assert body["totalCents"] == 2808
    assert call["requestHeaders"]["x-user-id"] == "user-123"


async def run_all_tests():
    print("request-payment-card blackbox tests:")
    result = BlackboxResult()
    result.record("normalize_payload", test_normalize_payload_builds_receipt_metadata_and_fingerprint)
    result.record("fingerprint_stability", test_fingerprint_is_stable_and_user_scoped)
    result.record("question_no_secrets", test_question_contains_receipt_but_no_card_secrets)
    await result.record_async("lookup_boundary", test_lookup_purchase_activity_boundary)
    await result.record_async("mint_boundary", test_mint_purchase_card_activity_boundary)
    teardown_mock()
    return result.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
