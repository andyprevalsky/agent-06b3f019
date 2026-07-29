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

    invalid_product_urls = (
        "https://example.com/checkout/payment",
        "https://example.com/checkout.html",
        "https://checkout.example.com/products/desk-lamp",
        "https://secure-checkout.example.com/session/123",
        "https://pay.example.com/session/123",
        "https://secure-pay.example.com/session/123",
        "https://example.com/order/ABC123",
        "https://example.com/order-confirmation/ABC123",
        "https://example.com/check%6fut/session/123",
        "https://example.com/check-out/session/123",
        "https://example.com",
        # RCA: a checkout token in a real subdomain/path is still rejected even
        # when the registrable domain is an ordering platform (order.online).
        "https://order.online/business/156787/checkout/3ebc87b0-5761-4afc-9bfd",
        "https://checkout.order.online/products/desk-lamp",
    )
    for product_url in invalid_product_urls:
        try:
            PaymentLineItem.model_validate({**valid_item, "product_url": product_url})
        except ValidationError:
            pass
        else:
            raise AssertionError(f"PaymentLineItem accepted non-product URL {product_url}")

    apple_item = {
        **valid_item,
        "product_url": "https://www.apple.com/shop/buy-mac/macbook-air",
    }
    assert PaymentLineItem.model_validate(apple_item).product_url == apple_item["product_url"]

    tracked_item = {
        **valid_item,
        "product_url": "https://example.com/products/desk-lamp?utm_campaign=payment_reminder&route=checkout",
    }
    assert PaymentLineItem.model_validate(tracked_item).product_url == tracked_item["product_url"]

    # RCA (agent 53feac08): request_payment_card was impossible on order.online
    # (DoorDash's white-label storefront) because the registrable domain's
    # "order" label tripped the checkout-route guard. A genuine product-detail
    # URL on an ordering-platform domain must be accepted.
    ordering_platform_items = (
        "https://order.online/store/BlueBottleCoffee-218854/item/44409624976",
        "https://orders.co/products/latte",
    )
    for product_url in ordering_platform_items:
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
    from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner, SandboxRestrictions

    sandbox_restrictions = SandboxRestrictions.default.with_passthrough_modules(
        "rich",
        "rich.console",
        "structlog.dev",
        "markdown_it_py",
        "pygments",
        "httpx",
        "sniffio",
        "helpers.llm",
        "helpers.attachments",
    )

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue="payment-import-sandbox-test",
            workflows=[PaymentImportWorkflow],
            activities=[],
            workflow_runner=SandboxedWorkflowRunner(restrictions=sandbox_restrictions),
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
        "reviewless_bookings_pass_with_zero",
        test_reviewless_bookings_pass_with_zero_and_the_contract_teaches_it,
    )
    result.record("camel_case_transport", test_payment_tool_accepts_camel_case_transport_fields)
    result.record("fingerprint_stability", test_fingerprint_is_stable_and_user_scoped)
    result.record(
        "fingerprint_display_metadata_stability",
        test_fingerprint_ignores_display_only_review_formatting,
    )
    result.record(
        "fingerprint_material_changes_distinct",
        test_fingerprint_keeps_material_receipt_changes_distinct,
    )
    result.record("question_no_secrets", test_question_contains_receipt_but_no_card_secrets)
    result.record(
        "question_sanitizes_merchant_content",
        test_question_normalizes_untrusted_review_text_and_escapes_markdown,
    )
    await result.record_async("lookup_boundary", test_lookup_purchase_activity_boundary)
    await result.record_async("mint_boundary", test_mint_purchase_card_activity_boundary)
    await result.record_async("mint_maps_kyc_required", test_mint_purchase_card_activity_maps_kyc_required)
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
    return result.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
