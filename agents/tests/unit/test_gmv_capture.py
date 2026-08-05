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
    assert parse_money_to_cents("1,250", treat_as_cents=True) == 1250
    assert parse_money_to_cents("$1250", treat_as_cents=True) == 1250
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


def test_extract_structured_gmv_beanie_amazon_shape():
    capture = extract_structured_gmv(
        {
            "purchase_completed": True,
            "order_confirmation_id": "106-8124526-2047424",
            "selected_beanie_price_usd": 19.99,
        }
    )
    assert capture is not None
    assert capture["totalCents"] == 1999
    assert capture["confirmationId"] == "106-8124526-2047424"


def test_extract_structured_gmv_rejects_card_pan_as_confirmation():
    assert (
        extract_structured_gmv(
            {
                "checkout_total": 43.96,
                "one_time_payment_card_number": "4242424242426755",
            }
        )
        is None
    )


def test_extract_structured_gmv_rejects_prose_confirmation():
    assert (
        extract_structured_gmv(
            {
                "item_subtotal_usd": 42.44,
                "order_confirmation_id": "No confirmation ID—order was not placed.",
            }
        )
        is None
    )


def test_extract_structured_gmv_treat_as_cents_formatted_string():
    capture = extract_structured_gmv(
        {
            "total_cents": "1,250",
            "order_id": "ORD-CENTS-FMT",
        }
    )
    assert capture is not None
    assert capture["totalCents"] == 1250


def test_extract_structured_gmv_list_nested():
    capture = extract_structured_gmv(
        {
            "result": [{"order_id": "ORD-A1", "total": 42.0}],
        }
    )
    assert capture is not None
    assert capture["totalCents"] == 4200
    assert capture["confirmationId"] == "ORD-A1"


def test_extract_structured_gmv_prefers_total_amount_paid_over_line_item_price():
    """setup-resume shape: total_amount_paid must beat purchased_products[].price."""
    capture = extract_structured_gmv(
        {
            "total_amount_paid": 43.96,
            "purchased_products": [
                {"name": "Aurora Notebook", "price": 12},
                {"name": "Ceramic Mug", "price": 9},
                {"name": "Canvas Tote", "price": 15},
            ],
            "order_confirmation_id": "tp_60b2f90f",
        }
    )
    assert capture is not None
    assert capture["totalCents"] == 4396
    assert capture["confirmationId"] == "tp_60b2f90f"
    assert capture["amountKey"] == "total_amount_paid"


def test_extract_structured_gmv_recognizes_total_paid():
    capture = extract_structured_gmv(
        {
            "total_paid": "$43.96",
            "purchased_products": ["Aurora Notebook", "Ceramic Mug", "Canvas Tote"],
            "order_confirmation_id": "tp_66930a77",
        }
    )
    assert capture is not None
    assert capture["totalCents"] == 4396
    assert capture["amountKey"] == "total_paid"
