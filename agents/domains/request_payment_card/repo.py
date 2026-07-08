"""Backend activities for request_payment_card."""

from __future__ import annotations

from typing import Any, Dict

import httpx
import structlog
from temporalio import activity

from config import load_config
from helpers.trace_archive import archive_json
from helpers.tracing import current_root_agent_id
from helpers.world_model_runtime import WorldModelToolExecutionAdapter

logger = structlog.get_logger()


@activity.defn
async def lookup_purchase_activity(user_id: str, fingerprint: str) -> Dict[str, Any]:
    async def real_executor(_tool_name: str, _tool_args: Dict[str, Any], _tool_call_id: str) -> Dict[str, Any]:
        return await _lookup_purchase_real(user_id, fingerprint)

    return await WorldModelToolExecutionAdapter.from_env(agent_id=user_id).execute(
        "payment_lookup",
        {"user_id": user_id, "fingerprint": fingerprint},
        f"payment_lookup:{fingerprint}",
        real_executor,
    )


async def _lookup_purchase_real(user_id: str, fingerprint: str) -> Dict[str, Any]:
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
        archive_root_agent_id = current_root_agent_id() or user_id
        archive_json(
            root_agent_id=archive_root_agent_id,
            path=f"provider/payment/lookup/{fingerprint}.json.gz.enc",
            payload={"request": {"user_id": user_id, "fingerprint": fingerprint}, "response": result},
        )
        return result


@activity.defn
async def mint_purchase_card_activity(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    fingerprint = str(payload.get("fingerprint") or "")

    async def real_executor(_tool_name: str, _tool_args: Dict[str, Any], _tool_call_id: str) -> Dict[str, Any]:
        return await _mint_purchase_card_real(user_id, payload)

    return await WorldModelToolExecutionAdapter.from_env(agent_id=str(payload.get("agentId") or user_id)).execute(
        "payment_mint",
        {"user_id": user_id, "payload": payload},
        f"payment_mint:{fingerprint}",
        real_executor,
    )


async def _mint_purchase_card_real(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
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
        # 402 = the user needs an active subscription before Rose can spend real
        # money. Surface it as a signal (not an exception) so the workflow can
        # raise a subscription gate organically and retry, instead of failing.
        if response.status_code == 402:
            detail = ""
            try:
                detail = str(response.json().get("error") or "")
            except Exception:
                detail = response.text
            logger.info("Mint requires subscription (402)", detail=detail[:200])
            return {"status": "subscription_required", "error": detail}
        response.raise_for_status()
        result = response.json()
        archive_root_agent_id = current_root_agent_id() or str(payload.get("agentId") or user_id)
        archive_json(
            root_agent_id=archive_root_agent_id,
            path=f"provider/payment/mint/{body['fingerprint']}.json.gz.enc",
            payload={"request": body, "response": result},
        )
        return result
