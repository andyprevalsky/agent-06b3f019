"""Unit tests for facilitated GMV capture helpers."""

from __future__ import annotations

from utils.gmv_capture import extract_facilitated_gmv_capture, parse_money_to_cents


def test_parse_money_to_cents_common_forms():
    assert parse_money_to_cents("$18.50") == 1850
    assert parse_money_to_cents("18.50") == 1850
    assert parse_money_to_cents("USD 1,234.56") == 123456
    assert parse_money_to_cents(12.34) == 1234
    assert parse_money_to_cents(500) == 500
    assert parse_money_to_cents("$0.00") is None
    assert parse_money_to_cents("free") is None
    assert parse_money_to_cents(None) is None


def test_extract_facilitated_gmv_from_purchase_notification():
    capture = extract_facilitated_gmv_capture(
        {
            "trigger_type": "purchase",
            "service": {"name": "Blue Bottle Coffee", "domain": "order.online"},
            "purchase": {
                "items": [{"title": "Cortado", "price": "$6.00"}],
                "totals": {"subtotal": "$6.00", "tax": "$0.50", "total": "$18.50"},
                "payment_method": "Visa ending in 4242",
            },
        },
        current_url="https://order.online/bluebottle/checkout",
        approval_domain="order.online",
    )
    assert capture is not None
    assert capture["merchant"] == "Blue Bottle Coffee"
    assert capture["totalCents"] == 1850
    assert capture["paymentMethod"] == "Visa ending in 4242"
    assert capture["domain"] == "order.online"
    assert len(capture["lineItems"]) == 1


def test_extract_facilitated_gmv_requires_parseable_total():
    assert (
        extract_facilitated_gmv_capture(
            {
                "trigger_type": "purchase",
                "service": {"name": "Shop"},
                "purchase": {"totals": {"total": "see cart"}},
            }
        )
        is None
    )
