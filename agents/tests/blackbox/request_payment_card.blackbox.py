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


def test_fingerprint_is_stable_and_agent_scoped():
    from domains.request_payment_card.service import normalize_payment_payload

    base = normalize_payment_payload(_sample_tool_call(), "user-123", "agent-123")
    same = normalize_payment_payload(
        {**_sample_tool_call(), "merchant": " example shop "},
        "user-123",
        "agent-123",
    )
    other_agent = normalize_payment_payload(_sample_tool_call(), "user-123", "agent-456")
    other_user = normalize_payment_payload(_sample_tool_call(), "user-456", "agent-123")

    assert base["fingerprint"] == same["fingerprint"]
    assert base["fingerprint"] != other_agent["fingerprint"]
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


async def run_all_tests():
    print("request-payment-card blackbox tests:")
    result = BlackboxResult()
    result.record("normalize_payload", test_normalize_payload_builds_receipt_metadata_and_fingerprint)
    result.record(
        "normalize_payload_serialized_args",
        test_normalize_payload_accepts_serialized_browser_tool_args,
    )
    result.record("fingerprint_stability", test_fingerprint_is_stable_and_agent_scoped)
    result.record("question_no_secrets", test_question_contains_receipt_but_no_card_secrets)
    await result.record_async("lookup_boundary", test_lookup_purchase_activity_boundary)
    await result.record_async("mint_boundary", test_mint_purchase_card_activity_boundary)
    await result.record_async("workflow_sandbox_import", test_payment_helper_import_is_workflow_sandbox_safe)
    await result.record_async(
        "mint_agentcard_setup_state",
        test_mint_purchase_card_activity_returns_agentcard_setup_state,
    )
    await result.record_async("agentcard_status_boundary", test_agentcard_status_activity_boundary)
    teardown_mock()
    return result.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
