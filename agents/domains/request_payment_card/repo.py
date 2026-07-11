"""Backend data access for request-payment-card."""

from __future__ import annotations

import httpx

from config import load_config
from helpers.trace_archive import archive_json
from helpers.tracing import current_root_agent_id

from .config import LOOKUP_TIMEOUT_SECONDS, MINT_TIMEOUT_SECONDS
from .types import PaymentPayload, PurchaseResult


async def lookup_purchase_from_backend(user_id: str, fingerprint: str) -> PurchaseResult:
    config = load_config()
    async with httpx.AsyncClient(timeout=LOOKUP_TIMEOUT_SECONDS) as client:
        response = await client.get(
            f"{config.backend.api_url}/api/purchases/lookup",
            params={"fingerprint": fingerprint},
            headers={
                "X-API-Key": config.backend.api_key,
                "X-User-Id": user_id,
                "Content-Type": "application/json",
            },
        )
        response.raise_for_status()
        result = response.json()
        archive_root_agent_id = current_root_agent_id() or user_id
        archive_json(
            root_agent_id=archive_root_agent_id,
            path=f"provider/payment/lookup/{fingerprint}.json.gz.enc",
            payload={"request": {"user_id": user_id, "fingerprint": fingerprint}, "response": result},
        )
        return result


async def mint_purchase_card_from_backend(user_id: str, payload: PaymentPayload) -> PurchaseResult:
    config = load_config()
    body = {
        "fingerprint": payload["fingerprint"],
        "merchant": payload["merchant"],
        "agentId": payload.get("agentId"),
        "currency": payload.get("currency", "USD"),
        "lineItems": payload.get("lineItems") or [],
        "fees": payload.get("fees") or [],
        "subtotalCents": payload.get("subtotalCents") or 0,
        "totalCents": payload.get("totalCents") or 0,
    }
    async with httpx.AsyncClient(timeout=MINT_TIMEOUT_SECONDS) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/purchases/mint",
            json=body,
            headers={
                "X-API-Key": config.backend.api_key,
                "X-User-Id": user_id,
                "Content-Type": "application/json",
            },
        )
        response.raise_for_status()
        result = response.json()
        archive_root_agent_id = current_root_agent_id() or str(payload.get("agentId") or user_id)
        archive_json(
            root_agent_id=archive_root_agent_id,
            path=f"provider/payment/mint/{body['fingerprint']}.json.gz.enc",
            payload={"request": body, "response": result},
        )
        return result
