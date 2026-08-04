"""Unit tests for structured-output GMV capture helpers."""

from __future__ import annotations

from utils.gmv_capture import extract_structured_gmv, parse_money_to_cents


def test_parse_money_to_cents_common_forms():
    assert parse_money_to_cents("$18.50") == 1850
    assert parse_money_to_cents("18.50") == 1850
    assert parse_money_to_cents("USD 1,234.56") == 123456
    assert parse_money_to_cents(12.34) == 1234
    assert parse_money_to_cents(500) == 50000
    assert parse_money_to_cents(500, treat_as_cents=True) == 500
    assert parse_money_to_cents("$0.00") is None
    assert parse_money_to_cents("free") is None
    assert parse_money_to_cents(None) is None


def test_extract_structured_gmv_requires_amount_and_confirmation():
    capture = extract_structured_gmv(
        {
            "merchant": "Blue Bottle Coffee",
            "checkout_total": "$18.50",
            "order_confirmation_id": "BB-998877",
            "purchase_completed": True,
        }
    )
    assert capture is not None
    assert capture["merchant"] == "Blue Bottle Coffee"
    assert capture["totalCents"] == 1850
    assert capture["confirmationId"] == "BB-998877"


def test_extract_structured_gmv_rejects_amount_without_confirmation():
    assert (
        extract_structured_gmv(
            {
                "merchant": "Blue Bottle Coffee",
                "checkout_total": "$18.50",
                "purchase_completed": True,
            }
        )
        is None
    )


def test_extract_structured_gmv_rejects_explicit_negative_completion():
    assert (
        extract_structured_gmv(
            {
                "checkout_total": 18.5,
                "order_id": "ORD-12345",
                "order_placed": False,
            }
        )
        is None
    )


def test_extract_structured_gmv_key_agnostic_nested():
    capture = extract_structured_gmv(
        {
            "result": {
                "payment": {
                    "total_cents": 2499,
                    "confirmation_code": "tp_abcdef12",
                }
            }
        }
    )
    assert capture is not None
    assert capture["totalCents"] == 2499
    assert capture["confirmationId"] == "tp_abcdef12"
