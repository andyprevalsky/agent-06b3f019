"""Backend activities for request_payment_card."""

from __future__ import annotations

from typing import Any, Dict

import httpx
from temporalio import activity

from config import load_config
from helpers.trace_archive import archive_json


@activity.defn
async def lookup_purchase_activity(user_id: str, fingerprint: str) -> Dict[str, Any]:
    config = load_config()
    async with httpx.AsyncClient(timeout=30.0) as client:
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
        archive_json(
            root_agent_id=user_id,
            path=f"provider/payment/lookup/{fingerprint}.json.gz.enc",
            payload={"request": {"user_id": user_id, "fingerprint": fingerprint}, "response": result},
        )
        return result


@activity.defn
async def mint_purchase_card_activity(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
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
    async with httpx.AsyncClient(timeout=60.0) as client:
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
        archive_json(
            root_agent_id=str(payload.get("agentId") or user_id),
            path=f"provider/payment/mint/{body['fingerprint']}.json.gz.enc",
            payload={"request": body, "response": result},
        )
        return result
