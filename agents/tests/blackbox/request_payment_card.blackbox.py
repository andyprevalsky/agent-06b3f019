"""Blackbox tests for request-payment-card helpers and activities."""

import asyncio
import json
import os
import tempfile
from datetime import timedelta
from pathlib import Path

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
                "product_url": "https://example.com/products/desk-lamp",
                "rating": "4.8 stars",
                "review_count": "312 reviews",
                "unit_price_cents": "1299",
                "quantity": 2,
                "line_total_cents": 2598,
            }
        ],
        "fees": [{"label": "Tax", "amount_cents": 210}],
        "subtotal_cents": 2598,
        "total_cents": 2808,
    }


def test_reused_approval_requires_own_available_purchase_and_no_pending_prompt():
    from utils.payment_card import reuse_payment_approval

    purchase = {"id": "approved-1", "agentId": "agent-1", "status": "HELD", "cardId": "card-1"}
    lookup = {"found": True, "reusable": True, "purchase": purchase}
    payload = {}
    assert reuse_payment_approval(lookup, payload, "agent-1") == {
        "attention_request_id": None, "reused_purchase_id": "approved-1"
    }
    assert payload == {"reusePurchaseId": "approved-1"}
    rejected = [
        {**lookup, "found": False},
        {**lookup, "reusable": "true"},
        {**lookup, "error": "comparison failed"},
        {**lookup, "purchase": []},
        *({**lookup, "purchase": {**purchase, **change}} for change in [
            {"agentId": "another-agent"}, {"status": "CLEARED"}, {"id": ""}, {"cardId": None}
        ]),
    ]
    for result in rejected:
        payload = {}
        assert reuse_payment_approval(result, payload, "agent-1") is None
        assert payload == {}, "failed checks must not bind mint to any purchase"
    payload = {}
    assert reuse_payment_approval(lookup, payload, "agent-1", {"requestId": "pending"}) is None
    assert payload == {}, "an existing approval wait must resume through the original flow"


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
            "productUrl": "https://example.com/products/desk-lamp",
            "rating": "4.8 stars",
            "reviewCount": "312 reviews",
            "unitPriceCents": 1299,
            "quantity": 2,
            "lineTotalCents": 2598,
        }
    ]
    assert payload["fees"] == [{"label": "Tax", "amountCents": 210}]
    assert payload["subtotalCents"] == 2598
    assert payload["totalCents"] == 2808
    assert len(payload["fingerprint"]) == 64


def test_product_url_host_must_match_a_visited_page():
    """The approval renders product_url as a clickable link, so the host is constrained.

    Replaces test_product_url_does_not_match_browser_trajectory, which asserted
    that any well-formed absolute URL - including https://evil.com/products/x -
    was accepted. That was an open-redirect primitive (CWE-601).

    Only the HOST is checked. The path/query heuristics stay removed: those were
    the unguaranteeable part that rejected receipts from working checkouts, and
    the cases below pin that they remain accepted.
    """
    from utils.purchase_approval import validate_product_url_for_pages

    visited = [
        "https://order.toasttab.com/online/lunette-cambodia-ferry-building-1-ferry-building-suite-33-47",
        "https://order.toasttab.com/online/lunette-cambodia-ferry-building-1-ferry-building-suite-33-47/checkout",
    ]

    # The real URL from agent 90ac106a, on a host the browser actually loaded.
    product_url = (
        "https://order.toasttab.com/online/lunette-cambodia-ferry-building-1-ferry-building"
        "-suite-33-47/item-lok-lak_cc741e03-afbe-4713-9a47-488bfbe0036b"
    )
    assert validate_product_url_for_pages(product_url, visited) == product_url

    # No "product"/"item"/"p" marker in the path must still pass: the old
    # _looks_like_product_route word list rejected these and cost a benchmark run.
    assert (
        validate_product_url_for_pages("https://order.toasttab.com/lok-lak", visited)
        == "https://order.toasttab.com/lok-lak"
    )

    # A subdomain of a visited host is legitimate - merchants serve the product
    # page from menu.* while checkout lives on order.*.
    assert validate_product_url_for_pages("https://menu.order.toasttab.com/lok-lak", visited)

    # A parent host of the visited host is still the same merchant.
    assert validate_product_url_for_pages("https://toasttab.com/local/lunette", visited)

    # An unrelated host must be rejected: this is the open-redirect case.
    for untrusted in (
        "https://evil.com/products/x",
        "https://toasttab.com.attacker.example/products/x",
    ):
        try:
            validate_product_url_for_pages(untrusted, visited)
        except ValueError:
            continue
        raise AssertionError(f"expected {untrusted} to be rejected as an untrusted host")



def test_payment_line_item_requires_reviews_and_a_product_detail_url():
    from pydantic import ValidationError

    from browser_tools.schemas import PaymentLineItem

    valid_item = _sample_tool_call()["line_items"][0]
    parsed = PaymentLineItem.model_validate(valid_item)
    assert parsed.product_url == "https://example.com/products/desk-lamp"
    assert parsed.rating == "4.8 stars"
    assert parsed.review_count == "312 reviews"

    for field_name in ("unit_price_cents", "quantity", "line_total_cents"):
        try:
            PaymentLineItem.model_validate({**valid_item, field_name: 0})
        except ValidationError:
            pass
        else:
            raise AssertionError(f"PaymentLineItem accepted non-positive {field_name}")

    for required_field in ("product_url", "rating", "review_count"):
        invalid_item = {**valid_item}
        invalid_item.pop(required_field)
        try:
            PaymentLineItem.model_validate(invalid_item)
        except ValidationError:
            pass
        else:
            raise AssertionError(f"PaymentLineItem accepted missing {required_field}")

    # product_url is validated for WELL-FORMEDNESS ONLY. Page-type inference
    # (product vs checkout vs storefront) was removed by decision: every merchant
    # invents its own conventions, so the heuristic only ever recognised shapes we
    # had already been burned by, and each miss rejected a receipt from a WORKING
    # checkout. These URLs are now accepted deliberately.
    formerly_rejected_urls = (
        "https://example.com/checkout/payment",
        "https://checkout.example.com/products/desk-lamp",
        "https://pay.example.com/session/123",
        "https://example.com/order/ABC123",
        "https://example.com",
        "https://order.online/business/156787/checkout/3ebc87b0-5761-4afc-9bfd",
    )
    for product_url in formerly_rejected_urls:
        PaymentLineItem.model_validate({**valid_item, "product_url": product_url})

    # The one guarantee retained: it must actually be an absolute http(s) URL.
    for product_url in (
        "not a url",
        "/checkout/session/123",
        "example.com/products/desk-lamp",
        "ftp://example.com/products/desk-lamp",
        "https://example.com/p/1?a=<script>",
        "https://example.com:99999/products/desk-lamp",
        "https://example.com:abc/products/desk-lamp",
    ):
        try:
            PaymentLineItem.model_validate({**valid_item, "product_url": product_url})
        except ValidationError:
            pass
        else:
            raise AssertionError(f"PaymentLineItem accepted non-URL {product_url}")

    # NO VOCABULARY FILTERING. The validator must never guess a page's purpose
    # from the words in its URL. Two prod incidents came from exactly that:
    #   - agent 53feac08: order.online (DoorDash white-label) blocked because the
    #     registrable domain is the word "order".
    #   - agent 90ac106a: order.toasttab.com blocked because the SUBDOMAIN is the
    #     word "order" — making a purchase categorically impossible on Toast, the
    #     largest US restaurant ordering platform, where every product page lives
    #     on that host. The agent burned 5 rejected calls / ~4.7 min, then escaped
    #     by inventing a www.toasttab.com URL it had never loaded, so a human was
    #     shown a fabricated link for a real charge. The filter made the trust
    #     surface worse than no filter.
    # Merchant slugs legitimately contain every one of these words, so a
    # blocklist can never be completed. These MUST all be accepted.
    urls_that_only_a_word_filter_would_reject = (
        "https://order.toasttab.com/online/lunette-cambodia-ferry-building-1-ferry-building-suite-33-47/item-lok-lak_cc741e03-afbe-4713-9a47-488bfbe0036b",
        "https://order.online/store/BlueBottleCoffee-218854/item/44409624976",
        "https://order.doordash.com/store/blue-bottle-218854/item/44409624976",
        "https://orders.grubhub.com/menu/item-42",
        "https://orders.co/products/latte",
        "https://www.apple.com/shop/buy-mac/macbook-air",
        "https://example.com/products/desk-lamp?utm_campaign=payment_reminder&route=checkout",
        # Real merchant slugs that happen to contain checkout vocabulary.
        "https://shop.example.com/p/cart-organizer-basket",
        "https://example.com/products/payment-processing-for-dummies",
        "https://example.com/menu/check-out-our-specials-combo",
        "https://checkout-supply-co.example.com/products/desk-lamp",
        # A path with no product-ish marker at all is still a product page.
        "https://lunettecambodia.com/lok-lak",
        # Hash-routed SPA storefronts carry the whole route in the fragment, so
        # the path is empty. Rejecting these as "bare homepage" was a false
        # reject on every client-side-routed merchant.
        "https://shop.example.com/#/product/123",
        "https://shop.example.com/#/item/abc",
    )
    for product_url in urls_that_only_a_word_filter_would_reject:
        parsed_item = PaymentLineItem.model_validate({**valid_item, "product_url": product_url})
        assert parsed_item.product_url == product_url, product_url

    invalid_reviews = (
        ("rating", "N/A"),
        ("rating", "N/A 0"),
        ("rating", "312 reviews"),
        ("review_count", "unknown"),
        ("review_count", "unknown 1"),
        ("review_count", "4.8 stars"),
    )
    for field_name, placeholder in invalid_reviews:
        try:
            PaymentLineItem.model_validate({**valid_item, field_name: placeholder})
        except ValidationError:
            pass
        else:
            raise AssertionError(f"PaymentLineItem accepted placeholder {field_name}")


def test_reviewless_bookings_pass_with_zero_and_the_contract_teaches_it():
    """H-01: a review-less service/ticket page must be satisfiable with '0'.

    The validators already accept '0 stars'/'0 reviews' — the failure mode was the
    agent emitting 'N/A' (rejected) because nothing told it the canonical zero
    value. This cements the zero case AND that every LLM-facing surface (tool
    schema + Pydantic descriptions + retry error) teaches it, so the model stops
    hallucinating or hunting a rating that a booking page never shows. Placeholder
    rejection stays intact (asserted above), so this is guidance, not relaxation.
    """
    from browser_tools.schemas import PaymentLineItem

    valid_item = _sample_tool_call()["line_items"][0]
    # The exact values the guidance tells the agent to use on a review-less page.
    zeroed = PaymentLineItem.model_validate(
        {**valid_item, "rating": "0 stars", "review_count": "0 reviews"}
    )
    assert zeroed.rating == "0 stars"
    assert zeroed.review_count == "0 reviews"

    # 1) Rose browser-use tool schema teaches the zero case for both fields.
    from providers.rose.browser_use import BROWSER_USE_TOOLS

    props = BROWSER_USE_TOOLS["request_payment_card"]["params"]["line_items"]["items"][
        "properties"
    ]
    for field in ("rating", "review_count"):
        desc = props[field]["description"].lower()
        assert "0 stars" in desc or "0 reviews" in desc
        assert "made-up" in desc  # forbids hallucinated / placeholder values

    # 2) Pydantic field descriptions carry the same guidance.
    fields = PaymentLineItem.model_fields
    assert "0 stars" in (fields["rating"].description or "")
    assert "0 reviews" in (fields["review_count"].description or "")

    # 3) The retry error tells the agent to pass 0 (self-correction), not to keep hunting.
    import inspect

    from domains.spawn_browser_agent_v3 import service_actions

    action_src = inspect.getsource(service_actions)
    assert "0 stars" in action_src and "0 reviews" in action_src
    assert "do not keep searching" in action_src


# Captured from browser-blue-bottle-challenge-recovery r001-j0002 (agent 7d569891,
# 2026-11-06). On sf-classic.order.online the shakerato opens as a modal over the
# store menu: the item has no page of its own, only the store URL (and an
# `?item=<id>` deep link that re-opens the modal on that same store page).
_BLUE_BOTTLE_STORE_URL = "https://sf-classic.order.online/en-US/store/BlueBottleCoffee-2188540"


def test_modal_menu_item_without_its_own_page_is_satisfiable_and_the_contract_teaches_it():
    """H-38: an item that only exists as a modal on a menu page must be representable.

    Enforcement already accepts the page the item was selected on (path/page-kind
    heuristics were removed on 2026-07-28; only well-formedness and a visited host
    are checked). The failure was every LLM-visible surface still demanding a
    "canonical product-detail" page, so the browser agent spent ~19 minutes
    reverse-engineering script modules for a URL the site does not have and never
    added the item to the cart. This cements the truthful value AND that every
    LLM-facing statement of the product_url contract teaches it, mirroring H-01's
    '0 stars' guidance. Host grounding and non-URL rejection stay intact.
    """
    from browser_tools.schemas import (
        PaymentLineItem,
        RequestPaymentCardBrowserTool,
        WriteLockPurchaseItem,
    )
    from domains.spawn_browser_agent_v3 import handler
    from providers.rose.browser_use import BROWSER_USE_TOOLS
    from utils.purchase_approval import validate_product_url_for_pages

    valid_item = _sample_tool_call()["line_items"][0]
    item = PaymentLineItem.model_validate({**valid_item, "product_url": _BLUE_BOTTLE_STORE_URL})
    assert item.product_url == _BLUE_BOTTLE_STORE_URL
    assert validate_product_url_for_pages(_BLUE_BOTTLE_STORE_URL, [_BLUE_BOTTLE_STORE_URL]) == (
        _BLUE_BOTTLE_STORE_URL
    )
    write_lock_item = WriteLockPurchaseItem.model_validate(
        {"title": "Iced Vanilla Bean Shakerato", "rating": "0 stars", "review_count": "0 reviews",
         "product_url": _BLUE_BOTTLE_STORE_URL}
    )
    assert write_lock_item.product_url == _BLUE_BOTTLE_STORE_URL

    payment_tool = BROWSER_USE_TOOLS["request_payment_card"]
    write_lock_tool = BROWSER_USE_TOOLS["generate_write_lock_notification"]["params"]["purchase"]
    surfaces = {
        "PaymentLineItem.product_url": PaymentLineItem.model_fields["product_url"].description,
        "RequestPaymentCardBrowserTool.line_items": (
            RequestPaymentCardBrowserTool.model_fields["line_items"].description
        ),
        "WriteLockPurchaseItem.product_url": WriteLockPurchaseItem.model_fields["product_url"].description,
        "browser_use request_payment_card": payment_tool["description"],
        "browser_use request_payment_card line_items": payment_tool["params"]["line_items"]["description"],
        "browser_use request_payment_card product_url": (
            payment_tool["params"]["line_items"]["items"]["properties"]["product_url"]["description"]
        ),
        "browser_use write-lock purchase": write_lock_tool["description"],
        "browser_use write-lock product_url": (
            write_lock_tool["properties"]["items"]["items"]["properties"]["product_url"]["description"]
        ),
        "write-lock purchase example notes": next(
            notes for title, _payload, notes in handler._WRITE_LOCK_NOTIFICATION_EXAMPLES
            if title.startswith("Purchases")
        ),
        "browser system Purchase Approval Context": getattr(handler, "PURCHASE_APPROVAL_CONTEXT", ""),
    }
    for name, text in surfaces.items():
        text = (text or "").lower()
        # No surface may demand a page kind that modal/single-page merchants lack...
        for stale in ("product-detail", "canonical product"):
            assert stale not in text, f"{name} still demands a {stale} page: {text!r}"
        # ...and each one must teach the truthful value the validator accepts.
        assert "page where you selected it" in text, f"{name} does not teach the no-own-page case: {text!r}"


# Captured verbatim from browser-hotel-booking r001-j0020 (agent 3e9daf89, step 63).
# hotels.com shows "9.2 out of 10" for Hotel Kabuki; the validator only accepted 0-5,
# so the truthful receipt was rejected and no payment approval was ever requested.
_HOTELS_COM_KABUKI_REQUEST = {
    "merchant": (
        "Hotels.com — Hotel Kabuki, part of JdV by Hyatt (guest checkout; payment-boundary "
        "benchmark only; USD 358.85 payable today and USD 40.69 due at property; no booking "
        "or payment will be submitted)"
    ),
    "currency": "USD",
    "line_items": [
        {
            "name": (
                "Hotel Kabuki, part of JdV by Hyatt — Room, 1 King Bed, non-refundable, no extras; "
                "1 adult; check-in Saturday November 7, 2026, check-out Sunday November 8, 2026 (1 night)"
            ),
            "image_url": (
                "https://images.trvl-media.com/lodging/1000000/10000/1100/1003/26001c4e.jpg"
                "?impolicy=fcrop&w=1200&h=800"
            ),
            "product_url": (
                "https://www.hotels.com/ho129640/"
                "hotel-kabuki-part-of-jdv-by-hyatt-san-francisco-united-states-of-america/"
            ),
            "rating": "9.2 out of 10",
            "review_count": "1,000 reviews",
            "unit_price_cents": 30800,
            "quantity": 1,
            "line_total_cents": 30800,
        }
    ],
    "fees": [
        {"label": "Taxes & fees", "amount_cents": 5085},
        {"label": "Destination fee — due at property", "amount_cents": 3492},
        {"label": "Tax on fees — due at property", "amount_cents": 577},
    ],
    "subtotal_cents": 30800,
    "total_cents": 39954,
}


def test_rating_keeps_the_merchant_scale_shown_on_the_page():
    """H-22: a truthful rating on a non-5-point scale must be representable.

    hotels.com shows "9.2 out of 10". The approval renders the rating string to the
    user as written, so a first score above 5 is kept exactly as the page shows it
    instead of being rejected or rescaled. Every 5-point input keeps its existing
    "<score> stars" output, byte for byte, so receipt fingerprints are unchanged.
    """
    from browser_tools.schemas import (
        PaymentLineItem,
        WriteLockPurchaseItem,
        validate_browser_tool_args,
    )
    from domains.request_payment_card.service import (
        build_payment_question,
        normalize_payment_payload,
    )

    # 1) The exact captured hotels.com call passes the production browser-tool boundary.
    parsed = validate_browser_tool_args("request_payment_card", _HOTELS_COM_KABUKI_REQUEST)
    assert parsed["line_items"][0]["rating"] == "9.2 out of 10", parsed["line_items"][0]["rating"]

    # 2) The approval the user sees carries the page's own rating, not invented stars.
    payload = normalize_payment_payload(_HOTELS_COM_KABUKI_REQUEST, "user-123")
    assert payload["lineItems"][0]["rating"] == "9.2 out of 10"
    question = build_payment_question(payload)
    assert "9.2 out of 10" in question.replace("\\", ""), question

    valid_item = _sample_tool_call()["line_items"][0]
    unchanged_five_point = {
        "4.8 stars": "4.8 stars",
        "4.8 out of 5 stars": "4.8 stars",
        "4.5/5": "4.5 stars",
        "0 stars": "0 stars",
        "5.0 stars": "5.0 stars",
        "4.8 (2,345)": "4.8 stars",
        "Rated 4.7 of 5": "4.7 stars",
        "4.5 of 5": "4.5 stars",
        "4.6 stars out of 5": "4.6 stars",
        "4.5 (1.2K)": "4.5 stars",
        "4.7 (2k+)": "4.7 stars",
        "4.9 ⭐ (2.1k)": "4.9 stars",
        "4.5 stars, 98% recommend": "4.5 stars",
        "4.5 stars · 20% off": "4.5 stars",
        "4.7★ · Top 5%": "4.7 stars",
        "4.8 stars · 1 of 3 left": "4.8 stars",
        "4.5 – #1 of 25": "4.5 stars",
        "#12 in Hotels · 4.5 stars": "4.5 stars",
        "Top 10 · 4.6 stars": "4.6 stars",
        "250 guests · 4.5 stars": "4.5 stars",
        "#1 of 25": "1 stars",
    }
    other_scales_kept_as_written = ("9.2 out of 10", "9.2/10 Wonderful", "Rated 8.7 of 10")
    still_rejected = ("250 guests", "N/A", "312 reviews")
    for model in (PaymentLineItem, WriteLockPurchaseItem):
        # 3) 5-point outputs are identical to the pre-fix validator.
        for submitted, normalized in unchanged_five_point.items():
            item = {**valid_item, "title": valid_item["name"], "rating": submitted}
            assert model.model_validate(item).rating == normalized, (model.__name__, submitted)
        # 4) A first score above 5 is kept exactly as the page shows it.
        for submitted in other_scales_kept_as_written:
            item = {**valid_item, "title": valid_item["name"], "rating": submitted}
            assert model.model_validate(item).rating == submitted, (model.__name__, submitted)
        # 5) No score, placeholders and review counts are still rejected.
        for submitted in still_rejected:
            item = {**valid_item, "title": valid_item["name"], "rating": submitted}
            try:
                parsed_item = model.model_validate(item)
            except ValueError:
                continue
            raise AssertionError(f"{model.__name__} accepted {submitted!r} as {parsed_item.rating!r}")


def test_payment_tool_accepts_flexible_merchant_labels():
    """Merchant is a free-form label — no Eventim-shaped format gate at schema time."""
    from browser_tools.schemas import RequestPaymentCardBrowserTool
    from providers.rose.browser_use import BROWSER_USE_TOOLS

    item = _sample_tool_call()["line_items"][0]
    base = {
        "tool": "request_payment_card",
        "currency": "USD",
        "line_items": [item],
        "subtotal_cents": item["line_total_cents"],
        "total_cents": item["line_total_cents"],
    }
    for merchant in (
        "Blick Art Materials",
        "1015 Folsom (Eventim - eventim.us)",
        "1015 Folsom via Eventim",
        "Eventim US (1015 Folsom)",
    ):
        parsed = RequestPaymentCardBrowserTool.model_validate({**base, "merchant": merchant})
        assert parsed.merchant == merchant

    merchant_desc = BROWSER_USE_TOOLS["request_payment_card"]["params"]["merchant"]["description"]
    assert merchant_desc == "Merchant or site name for the purchase"
    schema_desc = RequestPaymentCardBrowserTool.model_fields["merchant"].description or ""
    assert schema_desc == "Merchant or site name for the purchase"


def test_payment_tool_accepts_camel_case_transport_fields():
    from pydantic import ValidationError

    from browser_tools.schemas import RequestPaymentCardBrowserTool

    item = _sample_tool_call()["line_items"][0]
    parsed = RequestPaymentCardBrowserTool.model_validate(
        {
            "tool": "request_payment_card",
            "merchant": "Example Shop",
            "currency": "usd",
            "lineItems": [
                {
                    "name": item["name"],
                    "productUrl": item["product_url"],
                    "rating": item["rating"],
                    "reviewCount": item["review_count"],
                    "unitPriceCents": item["unit_price_cents"],
                    "quantity": item["quantity"],
                    "lineTotalCents": item["line_total_cents"],
                }
            ],
            "subtotalCents": 2598,
            "totalCents": 2808,
        }
    )

    assert parsed.currency == "USD"
    assert parsed.line_items[0].product_url == item["product_url"]
    assert parsed.total_cents == 2808

    for field_name in ("subtotalCents", "totalCents"):
        invalid_payload = {
            "tool": "request_payment_card",
            "merchant": "Example Shop",
            "currency": "USD",
            "lineItems": [
                {
                    "name": item["name"],
                    "productUrl": item["product_url"],
                    "rating": item["rating"],
                    "reviewCount": item["review_count"],
                    "unitPriceCents": item["unit_price_cents"],
                    "quantity": item["quantity"],
                    "lineTotalCents": item["line_total_cents"],
                }
            ],
            "subtotalCents": 2598,
            "totalCents": 2808,
            field_name: 0,
        }
        try:
            RequestPaymentCardBrowserTool.model_validate(invalid_payload)
        except ValidationError:
            pass
        else:
            raise AssertionError(f"RequestPaymentCardBrowserTool accepted non-positive {field_name}")


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


def test_fingerprint_ignores_display_only_review_formatting():
    """The same priced order must reuse its card when browser prose formatting drifts."""
    from domains.request_payment_card.service import normalize_payment_payload

    first_call = _sample_tool_call()
    first_call["line_items"][0]["review_count"] = "1,284 reviews"
    second_call = _sample_tool_call()
    second_call["line_items"][0]["review_count"] = "1284 reviews"

    first = normalize_payment_payload(first_call, "user-123")
    second = normalize_payment_payload(second_call, "user-123")

    assert first["lineItems"][0]["reviewCount"] == "1,284 reviews"
    assert second["lineItems"][0]["reviewCount"] == "1284 reviews"
    assert first["fingerprint"] == second["fingerprint"]

    localized_first = _sample_tool_call()
    localized_first["line_items"][0]["review_count"] = "١,٢٨٤ reviews"
    localized_second = _sample_tool_call()
    localized_second["line_items"][0]["review_count"] = "١٢٨٤ reviews"
    assert (
        normalize_payment_payload(localized_first, "user-123")["fingerprint"]
        == normalize_payment_payload(localized_second, "user-123")["fingerprint"]
    )


def test_placeholder_image_scheme_is_canonical_for_receipt_and_fingerprint():
    """An agent's HTTP spelling of the same placeholder image stays one cart."""
    from domains.request_payment_card.service import normalize_payment_payload

    secure = _sample_tool_call()
    secure["line_items"][0]["image_url"] = "https://placehold.co/320x220/png?text=Desk+Lamp"
    insecure = _sample_tool_call()
    insecure["line_items"][0]["image_url"] = "http://placehold.co/320x220/png?text=Desk+Lamp"
    secure_payload = normalize_payment_payload(secure, "user-123")
    insecure_payload = normalize_payment_payload(insecure, "user-123")
    assert insecure_payload["lineItems"][0]["imageUrl"] == secure_payload["lineItems"][0]["imageUrl"]
    assert insecure_payload["fingerprint"] == secure_payload["fingerprint"]

    other_host = _sample_tool_call()
    other_host["line_items"][0]["image_url"] = "http://other.example/320x220/png?text=Desk+Lamp"
    assert normalize_payment_payload(other_host, "user-123")["fingerprint"] != secure_payload[
        "fingerprint"
    ]


def test_fingerprint_ignores_trailing_quantity_echo_on_item_name():
    """Order-summary names like 'Aurora Notebook x1' must reuse the bare-title card."""
    from domains.request_payment_card.service import normalize_payment_payload

    bare = _sample_tool_call()
    bare["line_items"][0]["name"] = "Aurora Notebook"
    bare["line_items"][0]["quantity"] = 1
    echoed = _sample_tool_call()
    echoed["line_items"][0]["name"] = "Aurora Notebook x1"
    echoed["line_items"][0]["quantity"] = 1

    bare_payload = normalize_payment_payload(bare, "user-123")
    echoed_payload = normalize_payment_payload(echoed, "user-123")

    assert bare_payload["lineItems"][0]["name"] == "Aurora Notebook"
    assert echoed_payload["lineItems"][0]["name"] == "Aurora Notebook x1"
    assert bare_payload["fingerprint"] == echoed_payload["fingerprint"]

    hyphen_echo = _sample_tool_call()
    hyphen_echo["line_items"][0]["name"] = "Aurora Notebook - x1"
    hyphen_echo["line_items"][0]["quantity"] = 1
    assert (
        normalize_payment_payload(hyphen_echo, "user-123")["fingerprint"]
        == bare_payload["fingerprint"]
    )

    merchant_echo = _sample_tool_call()
    merchant_echo["line_items"][0]["name"] = "Aurora Notebook x1 (Example Shop)"
    merchant_echo["line_items"][0]["quantity"] = 1
    assert (
        normalize_payment_payload(merchant_echo, "user-123")["fingerprint"]
        == bare_payload["fingerprint"]
    )

    other_merchant_echo = _sample_tool_call()
    other_merchant_echo["line_items"][0]["name"] = "Aurora Notebook x1 (Different Shop)"
    other_merchant_echo["line_items"][0]["quantity"] = 1
    assert (
        normalize_payment_payload(other_merchant_echo, "user-123")["fingerprint"]
        != bare_payload["fingerprint"]
    )

    mismatched = _sample_tool_call()
    mismatched["line_items"][0]["name"] = "Aurora Notebook x2"
    mismatched["line_items"][0]["quantity"] = 1
    assert (
        normalize_payment_payload(mismatched, "user-123")["fingerprint"]
        != bare_payload["fingerprint"]
    )

    mismatched_hyphen = _sample_tool_call()
    mismatched_hyphen["line_items"][0]["name"] = "Aurora Notebook - x2"
    mismatched_hyphen["line_items"][0]["quantity"] = 1
    assert (
        normalize_payment_payload(mismatched_hyphen, "user-123")["fingerprint"]
        != bare_payload["fingerprint"]
    )

    priced_echo = _sample_tool_call()
    priced_echo["line_items"][0]["name"] = "Aurora Notebook - 1 x $12.00"
    priced_echo["line_items"][0]["unit_price_cents"] = 1200
    priced_echo["line_items"][0]["quantity"] = 1
    priced_echo["line_items"][0]["line_total_cents"] = 1200
    bare_priced = _sample_tool_call()
    bare_priced["line_items"][0]["name"] = "Aurora Notebook"
    bare_priced["line_items"][0]["unit_price_cents"] = 1200
    bare_priced["line_items"][0]["quantity"] = 1
    bare_priced["line_items"][0]["line_total_cents"] = 1200
    assert (
        normalize_payment_payload(priced_echo, "user-123")["fingerprint"]
        == normalize_payment_payload(bare_priced, "user-123")["fingerprint"]
    )

    wrong_price = _sample_tool_call()
    wrong_price["line_items"][0]["name"] = "Aurora Notebook - 1 x $13.00"
    wrong_price["line_items"][0]["unit_price_cents"] = 1200
    wrong_price["line_items"][0]["quantity"] = 1
    wrong_price["line_items"][0]["line_total_cents"] = 1200
    assert (
        normalize_payment_payload(wrong_price, "user-123")["fingerprint"]
        != normalize_payment_payload(bare_priced, "user-123")["fingerprint"]
    )


def test_fingerprint_ignores_verified_checkout_summary_annotations():
    """Two browser runs of the same cart may copy different visible title prose."""
    from domains.request_payment_card.service import normalize_payment_payload

    bare = _sample_tool_call()
    bare["merchant"] = "Rose Labs Test Payment"
    bare["line_items"][0]["name"] = "Aurora Notebook"
    bare["line_items"][0]["unit_price_cents"] = 1200
    bare["line_items"][0]["quantity"] = 1
    bare["line_items"][0]["line_total_cents"] = 1200
    first_browser = _sample_tool_call()
    first_browser["merchant"] = bare["merchant"]
    first_browser["line_items"][0].update(bare["line_items"][0])
    first_browser["line_items"][0]["name"] = (
        "Aurora Notebook - x1 - $12.00 (Rose Labs Test Payment checkout)"
    )

    first = normalize_payment_payload(first_browser, "user-123")
    second = normalize_payment_payload(bare, "user-123")
    assert first["fingerprint"] == second["fingerprint"], (
        "the same product URL, quantity, price, and merchant must reuse its card"
    )

    mismatched = _sample_tool_call()
    mismatched["merchant"] = bare["merchant"]
    mismatched["line_items"][0].update(bare["line_items"][0])
    mismatched["line_items"][0]["name"] = (
        "Aurora Notebook - x2 - $12.00 (Rose Labs Test Payment checkout)"
    )
    assert normalize_payment_payload(mismatched, "user-123")["fingerprint"] != second[
        "fingerprint"
    ]
    mismatched["line_items"][0]["name"] = (
        "Aurora Notebook - x1 - $13.00 (Rose Labs Test Payment checkout)"
    )
    assert normalize_payment_payload(mismatched, "user-123")["fingerprint"] != second[
        "fingerprint"
    ]
    mismatched["line_items"][0]["name"] = (
        "Aurora Notebook - x1 - $12.00 (Different Merchant checkout)"
    )
    assert normalize_payment_payload(mismatched, "user-123")["fingerprint"] != second[
        "fingerprint"
    ]


def test_fingerprint_ignores_verified_product_card_descriptions():
    """A long card description must not make the next browser run mint another card."""
    from domains.request_payment_card.service import normalize_payment_payload

    for title, description, slug in (
        ("Aurora Notebook", "Hardcover planning notebook with dotted pages", "aurora-notebook"),
        ("Ceramic Mug", "Matte white mug for long checkout tests", "ceramic-mug"),
        ("Canvas Tote", "Heavy canvas tote with reinforced handles", "canvas-tote"),
    ):
        bare = _sample_tool_call()
        bare["merchant"] = "Rose Labs Test Payment"
        bare["line_items"][0]["name"] = title
        bare["line_items"][0]["product_url"] = f"https://shop.example/p/{slug}"
        described = _sample_tool_call()
        described["merchant"] = bare["merchant"]
        described["line_items"][0].update(bare["line_items"][0])
        described["line_items"][0]["name"] = f"{title} - {description}"
        base_fingerprint = normalize_payment_payload(bare, "user-123")["fingerprint"]
        assert normalize_payment_payload(described, "user-123")["fingerprint"] == base_fingerprint
        described["line_items"][0]["name"] = f"{title} - Red"
        assert normalize_payment_payload(described, "user-123")["fingerprint"] != base_fingerprint

    described["line_items"][0]["name"] = (
        "Different Tote - Heavy canvas tote with reinforced handles"
    )
    bare["line_items"][0]["name"] = "Different Tote"
    assert normalize_payment_payload(described, "user-123")["fingerprint"] != normalize_payment_payload(
        bare, "user-123"
    )["fingerprint"]


def test_fingerprint_preserves_non_ascii_suffixes_and_distinct_merchant_echo():
    """Only the ASCII suffixes the backend recognizes may be removed."""
    from domains.request_payment_card.service import normalize_payment_payload

    bare = _sample_tool_call()
    bare["line_items"][0]["name"] = "Aurora Notebook"

    for suffix in (" x١", " x١ (Example Shop)", " - ١ x $12.00"):
        echoed = _sample_tool_call()
        echoed["line_items"][0]["name"] = f"Aurora Notebook{suffix}"
        assert (
            normalize_payment_payload(echoed, "user-123")["fingerprint"]
            != normalize_payment_payload(bare, "user-123")["fingerprint"]
        )

    bare["merchant"] = "Straße"
    echoed = _sample_tool_call()
    echoed["merchant"] = "Straße"
    echoed["line_items"][0]["name"] = "Aurora Notebook x1 (STRASSE)"
    assert (
        normalize_payment_payload(echoed, "user-123")["fingerprint"]
        != normalize_payment_payload(bare, "user-123")["fingerprint"]
    )


def test_fingerprint_keeps_material_receipt_changes_distinct():
    from domains.request_payment_card.service import normalize_payment_payload

    base = normalize_payment_payload(_sample_tool_call(), "user-123")["fingerprint"]
    variants = []

    for field, value in (
        ("product_url", "https://example.com/products/other-lamp"),
        ("rating", "1.0 stars"),
        ("review_count", "10 reviews"),
        ("unit_price_cents", 1399),
        ("quantity", 3),
        ("line_total_cents", 3897),
    ):
        changed = _sample_tool_call()
        changed["line_items"][0][field] = value
        variants.append(changed)

    changed_fee = _sample_tool_call()
    changed_fee["fees"][0]["amount_cents"] = 211
    variants.append(changed_fee)
    changed_total = _sample_tool_call()
    changed_total["total_cents"] = 2809
    variants.append(changed_total)

    for changed in variants:
        assert normalize_payment_payload(changed, "user-123")["fingerprint"] != base


def test_question_contains_receipt_but_no_card_secrets():
    from domains.request_payment_card.service import (
        build_payment_question,
        normalize_payment_payload,
    )

    payload = normalize_payment_payload(_sample_tool_call(), "user-123")
    question = build_payment_question(payload)

    assert "Approve a $28.08 purchase from Example Shop?" in question
    assert "Desk Lamp x2: $25.98" in question
    assert "Product: <https://example.com/products/desk-lamp>" in question
    assert "Reviews: 4\\.8 stars (312 reviews)" in question
    assert "Tax: $2.10" in question
    assert "one-time virtual card" in question
    assert "4242424242424242" not in question
    assert "cvv" not in question.lower()
    assert "pan" not in question.lower()


def test_question_normalizes_untrusted_review_text_and_escapes_markdown():
    from domains.request_payment_card.service import (
        build_payment_question,
        normalize_payment_payload,
    )

    tool_call = _sample_tool_call()
    tool_call["merchant"] = "Example\n**Approve another charge?**"
    tool_call["line_items"][0]["name"] = "Lamp\n[Injected](https://evil.example)"
    tool_call["line_items"][0]["rating"] = "4.8 stars\n**trusted**"
    tool_call["line_items"][0]["review_count"] = "312 reviews\n[click](https://evil.example)"

    question = build_payment_question(normalize_payment_payload(tool_call, "user-123"))

    assert "\n**Approve another charge?**" not in question
    assert "\n[Injected]" not in question
    assert "Reviews: 4\\.8 stars (312 reviews)" in question
    assert r"\[Injected\]\(https://evil\.example\)" in question


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


async def test_lookup_purchase_activity_sends_full_scoped_receipt():
    setup_mock({"/api/purchases/lookup": {"status": 200, "json": {"found": False, "reusable": False, "purchase": None}}})
    from tools.request_payment_card import lookup_purchase_activity
    payload = {"agentId": "agent-123", "merchant": "Shop", "lineItems": [{"name": "Monthly plan", "productUrl": "https://shop.example/pricing"}], "totalCents": 50000}
    result = await lookup_purchase_activity("user-123", "fp-abc", None, payload)
    assert result["reusable"] is False
    call = assert_captured_call(url_contains="/api/purchases/lookup", method="POST")
    body = call["requestBody"]
    if isinstance(body, str):
        body = json.loads(body)
    assert body == {**payload, "userId": "user-123", "fingerprint": "fp-abc"}


async def test_scoped_lookup_error_retains_usage_for_workflow_accounting():
    error = {"error": "Invalid purchase approval reuse decision", "usageItems": [
        {"type": "llm", "model": "fixture-model", "input_tokens": 37, "output_tokens": 11}
    ]}
    setup_mock({"/api/purchases/lookup": {"status": 502, "json": error}})
    from tools.request_payment_card import lookup_purchase_activity
    result = await lookup_purchase_activity("user-123", "fp-abc", None, {"agentId": "agent-123"})
    assert result["error"] == error["error"] and result["usageItems"] == error["usageItems"]
    assert result["statusCode"] == 502


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

    import helpers.trace_archive as trace_archive
    from domains.request_payment_card.service import normalize_payment_payload
    from tools.request_payment_card import mint_purchase_card_activity

    old_root = trace_archive._LOCAL_ROOT
    old_enabled = os.environ.get("TRACE_ARCHIVE_ENABLED")
    old_backend = os.environ.get("TRACE_ARCHIVE_BACKEND")
    with tempfile.TemporaryDirectory() as tmp:
        try:
            trace_archive._LOCAL_ROOT = Path(tmp)
            os.environ["TRACE_ARCHIVE_ENABLED"] = "1"
            os.environ["TRACE_ARCHIVE_BACKEND"] = "local"
            payload = normalize_payment_payload(_sample_tool_call(), "user-123")
            payload["agentId"] = "agent-1"
            result = await mint_purchase_card_activity("user-123", payload)
            archived = Path(tmp) / "agent-1" / "provider" / "payment" / "mint" / f"{payload['fingerprint']}.json.gz.enc"
            assert archived.exists()
        finally:
            trace_archive._LOCAL_ROOT = old_root
            if old_enabled is None:
                os.environ.pop("TRACE_ARCHIVE_ENABLED", None)
            else:
                os.environ["TRACE_ARCHIVE_ENABLED"] = old_enabled
            if old_backend is None:
                os.environ.pop("TRACE_ARCHIVE_BACKEND", None)
            else:
                os.environ["TRACE_ARCHIVE_BACKEND"] = old_backend

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


async def test_mint_purchase_card_activity_maps_kyc_required():
    setup_mock(
        {
            "/api/purchases/mint": {
                "status": 422,
                "json": {
                    "error": "Customer requires KYC before Rose can issue a payment card",
                    "code": "customers_needed_kyc",
                },
            }
        }
    )

    from domains.request_payment_card.service import normalize_payment_payload
    from tools.request_payment_card import mint_purchase_card_activity

    payload = normalize_payment_payload(_sample_tool_call(), "user-123")
    payload["agentId"] = "agent-1"

    result = await mint_purchase_card_activity("user-123", payload)

    assert result["status"] == "kyc_required"
    assert result["code"] == "customers_needed_kyc"
    assert "KYC" in result["error"]


async def test_mint_purchase_card_activity_maps_purchase_above_max_limit():
    setup_mock(
        {
            "/api/purchases/mint": {
                "status": 400,
                "json": {
                    "error": "Purchase is above max limit of 63288",
                    "code": "purchase_above_max_limit",
                    "maxPurchaseCents": 63288,
                },
            }
        }
    )

    from domains.request_payment_card.service import normalize_payment_payload
    from tools.request_payment_card import mint_purchase_card_activity

    payload = normalize_payment_payload(_sample_tool_call(), "user-123")
    payload["agentId"] = "agent-1"

    result = await mint_purchase_card_activity("user-123", payload)

    assert result["status"] == "purchase_above_max_limit"
    assert result["code"] == "purchase_above_max_limit"
    assert result["maxPurchaseCents"] == 63288
    assert "above max limit of 63288" in result["error"]


async def test_mint_purchase_card_activity_maps_402_to_subscription_required():
    """Plain 402 without purchase_above_max_limit code still means subscribe."""
    setup_mock(
        {
            "/api/purchases/mint": {
                "status": 402,
                "json": {"error": "User does not have a Stripe billing customer"},
            }
        }
    )

    from domains.request_payment_card.service import normalize_payment_payload
    from tools.request_payment_card import mint_purchase_card_activity

    payload = normalize_payment_payload(_sample_tool_call(), "user-123")
    result = await mint_purchase_card_activity("user-123", payload)

    assert result["status"] == "subscription_required"
    assert "Stripe billing customer" in result["error"]


async def test_mint_purchase_card_activity_maps_company_funding_in_progress():
    setup_mock(
        {
            "/api/purchases/mint": {
                "status": 409,
                "json": {
                    "error": "AgentCard company funding is still in progress",
                    "code": "agentcard_company_funding_in_progress",
                    "retryAfterSeconds": 10,
                },
            }
        }
    )

    from domains.request_payment_card.service import normalize_payment_payload
    from tools.request_payment_card import mint_purchase_card_activity

    payload = normalize_payment_payload(_sample_tool_call(), "user-123")
    result = await mint_purchase_card_activity("user-123", payload)

    assert result["status"] == "agentcard_company_funding_in_progress"
    assert result["code"] == "agentcard_company_funding_in_progress"
    assert result["retryAfterSeconds"] == 10


async def test_payment_helper_import_is_workflow_sandbox_safe():
    from payment_import_workflow_fixture import PaymentImportWorkflow
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from helpers.workflow_sandbox import production_workflow_runner

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue="payment-import-sandbox-test",
            workflows=[PaymentImportWorkflow],
            activities=[],
            workflow_runner=production_workflow_runner(),
        ):
            result = await env.client.execute_workflow(
                PaymentImportWorkflow.run,
                id="payment-import-sandbox-test-1",
                task_queue="payment-import-sandbox-test",
                execution_timeout=timedelta(seconds=30),
            )

    assert "Approve a $6.36 purchase from Blick Art Materials?" in result["tool_question"]
    assert "Brush x1: $6.36" in result["tool_question"]
    assert result["domain_question"] == result["tool_question"]
    assert result["same_fingerprint"] is True
    assert result["mint_activity_timeout_seconds"] == 90.0
    assert result["mint_activity_imported"] is True
    assert result["mint_activity_timeout_seconds"] == 90.0


async def test_mint_purchase_card_activity_returns_agentcard_setup_state():
    setup_mock(
        {
            "/api/purchases/mint": {
                "status": 409,
                "json": {
                    "error": "User has not connected AgentCard",
                    "code": "agentcard_setup_required",
                    "agentcardStatus": "connect_required",
                    "setupAction": "connect_agentcard",
                    "connectUrl": "https://rose.test/api/agentcard/connect?user=user-123",
                    "setupUrl": "https://agentcard.test/setup",
                    "setupTool": "start_kyc",
                },
            }
        }
    )

    from domains.request_payment_card.service import normalize_payment_payload
    from tools.request_payment_card import mint_purchase_card_activity

    payload = normalize_payment_payload(_sample_tool_call(), "user-123")
    result = await mint_purchase_card_activity("user-123", payload)

    assert result["status"] == "agentcard_setup_required"
    assert result["code"] == "agentcard_setup_required"
    assert result["setupAction"] == "connect_agentcard"
    assert result["connectUrl"].endswith("/api/agentcard/connect?user=user-123")
    assert result["setupUrl"] == "https://agentcard.test/setup"
    assert result["setupTool"] == "start_kyc"


def test_mint_purchase_card_timeout_budget_exceeds_backend_retry_window():
    """The activity HTTP client must outwait backend AgentCard funding retries."""
    from domains.request_payment_card.contracts import (
        MINT_PURCHASE_CARD_ACTIVITY_TIMEOUT_SECONDS,
        MINT_PURCHASE_CARD_BACKEND_RETRY_BUDGET_SECONDS,
        MINT_PURCHASE_CARD_HTTP_TIMEOUT_SECONDS,
    )

    assert MINT_PURCHASE_CARD_BACKEND_RETRY_BUDGET_SECONDS >= 60
    assert (
        MINT_PURCHASE_CARD_BACKEND_RETRY_BUDGET_SECONDS
        < MINT_PURCHASE_CARD_HTTP_TIMEOUT_SECONDS
        < MINT_PURCHASE_CARD_ACTIVITY_TIMEOUT_SECONDS
    )


async def test_agentcard_status_activity_boundary():
    setup_mock(
        {
            "/api/agentcard/status": {
                "status": 200,
                "json": {
                    "connected": True,
                    "expiresAt": "2026-07-04T06:46:35.925Z",
                    "expired": False,
                },
            }
        }
    )

    from tools.request_payment_card import agentcard_status_activity

    result = await agentcard_status_activity("user-123")

    assert result["connected"] is True
    assert result["expired"] is False
    call = assert_captured_call(url_contains="/api/agentcard/status", method="GET")
    assert "x-api-key" in {k.lower() for k in call["requestHeaders"]}
    assert call["requestHeaders"]["x-user-id"] == "user-123"


def test_domain_config_and_types_module_constants():
    from domains.request_payment_card import config, types

    assert config.DEFAULT_CURRENCY == "USD"
    assert config.LOOKUP_TIMEOUT_SECONDS == 30.0
    assert config.MINT_TIMEOUT_SECONDS == 60.0
    assert set(config.__all__) == {
        "DEFAULT_CURRENCY",
        "LOOKUP_TIMEOUT_SECONDS",
        "MINT_TIMEOUT_SECONDS",
        "MINT_PURCHASE_CARD_BACKEND_RETRY_BUDGET_SECONDS",
        "MINT_PURCHASE_CARD_ACTIVITY_TIMEOUT_SECONDS",
        "MINT_PURCHASE_CARD_HTTP_TIMEOUT_SECONDS",
    }

    # TypeAliases are concrete Dict aliases and exported.
    assert types.PaymentPayload is not None
    assert types.PaymentToolCall is not None
    assert set(types.__all__) == {"PaymentPayload", "PaymentToolCall"}


def test_domain_package_eager_and_lazy_exports():
    import domains.request_payment_card as pkg

    # Eager helper exports resolve directly.
    assert callable(pkg.normalize_payment_payload)
    assert callable(pkg.build_payment_question)
    assert callable(pkg.build_payment_fingerprint)

    # Lazy __getattr__ resolves the repo activities on demand.
    assert callable(pkg.lookup_purchase_activity)
    assert callable(pkg.mint_purchase_card_activity)

    # Unknown attributes still raise AttributeError.
    raised = False
    try:
        _ = pkg.definitely_not_an_export
    except AttributeError:
        raised = True
    assert raised


async def run_all_tests():
    print("request-payment-card blackbox tests:")
    result = BlackboxResult()
    result.record("domain_config_and_types", test_domain_config_and_types_module_constants)
    result.record("domain_package_exports", test_domain_package_eager_and_lazy_exports)
    result.record("normalize_payload", test_normalize_payload_builds_receipt_metadata_and_fingerprint)
    result.record("required_product_reviews", test_payment_line_item_requires_reviews_and_a_product_detail_url)
    result.record(
        "product_url_host_must_match_a_visited_page",
        test_product_url_host_must_match_a_visited_page,
    )
    result.record(
        "reviewless_bookings_pass_with_zero",
        test_reviewless_bookings_pass_with_zero_and_the_contract_teaches_it,
    )
    result.record(
        "modal_menu_item_without_its_own_page",
        test_modal_menu_item_without_its_own_page_is_satisfiable_and_the_contract_teaches_it,
    )
    result.record(
        "rating_keeps_merchant_scale",
        test_rating_keeps_the_merchant_scale_shown_on_the_page,
    )
    result.record(
        "flexible_merchant_labels",
        test_payment_tool_accepts_flexible_merchant_labels,
    )
    result.record("camel_case_transport", test_payment_tool_accepts_camel_case_transport_fields)
    result.record("fingerprint_stability", test_fingerprint_is_stable_and_user_scoped)
    result.record(
        "fingerprint_display_metadata_stability",
        test_fingerprint_ignores_display_only_review_formatting,
    )
    result.record(
        "placeholder_image_scheme_stability",
        test_placeholder_image_scheme_is_canonical_for_receipt_and_fingerprint,
    )
    result.record(
        "fingerprint_quantity_echo_stability",
        test_fingerprint_ignores_trailing_quantity_echo_on_item_name,
    )
    result.record(
        "fingerprint_checkout_summary_stability",
        test_fingerprint_ignores_verified_checkout_summary_annotations,
    )
    result.record(
        "fingerprint_product_description_stability",
        test_fingerprint_ignores_verified_product_card_descriptions,
    )
    result.record(
        "fingerprint_non_ascii_suffix_distinct",
        test_fingerprint_preserves_non_ascii_suffixes_and_distinct_merchant_echo,
    )
    result.record(
        "fingerprint_material_changes_distinct",
        test_fingerprint_keeps_material_receipt_changes_distinct,
    )
    result.record("reused_approval_scope", test_reused_approval_requires_own_available_purchase_and_no_pending_prompt)
    result.record("question_no_secrets", test_question_contains_receipt_but_no_card_secrets)
    result.record(
        "question_sanitizes_merchant_content",
        test_question_normalizes_untrusted_review_text_and_escapes_markdown,
    )
    await result.record_async("lookup_boundary", test_lookup_purchase_activity_boundary)
    await result.record_async("lookup_scoped_receipt", test_lookup_purchase_activity_sends_full_scoped_receipt)
    await result.record_async("lookup_error_usage", test_scoped_lookup_error_retains_usage_for_workflow_accounting)
    await result.record_async("mint_boundary", test_mint_purchase_card_activity_boundary)
    await result.record_async("mint_maps_kyc_required", test_mint_purchase_card_activity_maps_kyc_required)
    await result.record_async(
        "mint_maps_purchase_above_max_limit",
        test_mint_purchase_card_activity_maps_purchase_above_max_limit,
    )
    await result.record_async(
        "mint_maps_402_subscription_required",
        test_mint_purchase_card_activity_maps_402_to_subscription_required,
    )
    await result.record_async(
        "mint_maps_company_funding_in_progress",
        test_mint_purchase_card_activity_maps_company_funding_in_progress,
    )
    await result.record_async("workflow_sandbox_import", test_payment_helper_import_is_workflow_sandbox_safe)
    await result.record_async(
        "mint_agentcard_setup_state",
        test_mint_purchase_card_activity_returns_agentcard_setup_state,
    )
    result.record(
        "mint_timeout_budget_exceeds_backend_retry_window",
        test_mint_purchase_card_timeout_budget_exceeds_backend_retry_window,
    )
    await result.record_async("agentcard_status_boundary", test_agentcard_status_activity_boundary)
    teardown_mock()
    result.record(
        "normalize_payload_accepts_serialized_browser_tool_args",
        test_normalize_payload_accepts_serialized_browser_tool_args,
    )
    return result.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
