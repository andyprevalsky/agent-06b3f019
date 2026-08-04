"""Backend activities for request_payment_card."""

from __future__ import annotations

from typing import Any, Dict

from temporalio import activity

from domains.request_payment_card.contracts import (
    MINT_PURCHASE_CARD_HTTP_TIMEOUT_SECONDS,
)

KYC_REQUIRED_CODES = {
    "kyc_required",
    "customer_kyc_required",
    "customers_needed_kyc",
    "customer_needs_kyc",
    "cardholder_kyc_required",
}


def _logger():
    import structlog

    return structlog.get_logger()


def _world_model_adapter():
    from helpers.world_model_runtime import WorldModelToolExecutionAdapter

    return WorldModelToolExecutionAdapter


def _load_config():
    from config import load_config

    return load_config()


def _current_root_agent_id() -> str | None:
    from helpers.tracing import current_root_agent_id

    return current_root_agent_id()


def _archive_json(*, root_agent_id: str, path: str, payload: Dict[str, Any]) -> None:
    from helpers.trace_archive import archive_json

    archive_json(root_agent_id=root_agent_id, path=path, payload=payload)


def _error_payload(response: Any) -> Dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        body = {"error": response.text}
    if not isinstance(body, dict):
        body = {"error": str(body)}
    body.setdefault("statusCode", response.status_code)
    return body


@activity.defn
async def lookup_purchase_activity(
    user_id: str,
    fingerprint: str,
    world_model_mode: str | None = None,
) -> Dict[str, Any]:
    async def real_executor(_tool_name: str, _tool_args: Dict[str, Any], _tool_call_id: str) -> Dict[str, Any]:
        return await _lookup_purchase_real(user_id, fingerprint)

    return await _world_model_adapter().from_env(
        agent_id=user_id,
        mode=world_model_mode,
    ).execute(
        "payment_lookup",
        {"user_id": user_id, "fingerprint": fingerprint},
        f"payment_lookup:{fingerprint}",
        real_executor,
        allow_real_fallback=world_model_mode is None,
    )


async def _lookup_purchase_real(user_id: str, fingerprint: str) -> Dict[str, Any]:
    import httpx

    config = _load_config()
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
        archive_root_agent_id = _current_root_agent_id() or user_id
        _archive_json(
            root_agent_id=archive_root_agent_id,
            path=f"provider/payment/lookup/{fingerprint}.json.gz.enc",
            payload={"request": {"user_id": user_id, "fingerprint": fingerprint}, "response": result},
        )
        return result


@activity.defn
async def mint_purchase_card_activity(
    user_id: str,
    payload: Dict[str, Any],
    world_model_mode: str | None = None,
) -> Dict[str, Any]:
    fingerprint = str(payload.get("fingerprint") or "")

    async def real_executor(_tool_name: str, _tool_args: Dict[str, Any], _tool_call_id: str) -> Dict[str, Any]:
        return await _mint_purchase_card_real(user_id, payload)

    return await _world_model_adapter().from_env(
        agent_id=str(payload.get("agentId") or user_id),
        mode=world_model_mode,
    ).execute(
        "payment_mint",
        {"user_id": user_id, "payload": payload},
        f"payment_mint:{fingerprint}",
        real_executor,
        allow_real_fallback=world_model_mode is None,
    )


async def _mint_purchase_card_real(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    import httpx

    config = _load_config()
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
    async with httpx.AsyncClient(timeout=MINT_PURCHASE_CARD_HTTP_TIMEOUT_SECONDS) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/purchases/mint",
            json=body,
            headers={
                "X-API-Key": config.backend.api_key,
                "X-User-Id": user_id,
                "Content-Type": "application/json",
            },
        )
        if response.status_code >= 400:
            payload = _error_payload(response)
            # Branch (MCP company-flow): AgentCard per-user setup (connect/KYC/
            # onboarding/wallet funding) surfaces as a structured setup state the
            # browser workflow resolves via its own attention request + auto-resume.
            if payload.get("code") == "agentcard_setup_required":
                return {
                    "status": "agentcard_setup_required",
                    **payload,
                }

            code = str(payload.get("code") or "").lower()
            detail = str(payload.get("error") or response.text or "")

            if code == "agentcard_company_funding_in_progress":
                return {
                    "status": "agentcard_company_funding_in_progress",
                    **payload,
                }

            # main (gate feature): org-managed KYC gate — surface as a signal so the
            # workflow raises a KYC gate and retries rather than failing.
            if code in KYC_REQUIRED_CODES or (
                response.status_code in (400, 403, 409, 422) and "kyc" in f"{code} {detail}".lower()
            ):
                _logger().info("Mint requires KYC", code=code, detail=detail[:200])
                return {"status": "kyc_required", "error": detail, "code": code or "kyc_required"}

            # 402 = the user needs an active subscription before Rose can spend real
            # money. Surface it as a signal (not an exception) so the workflow can
            # raise a subscription gate organically and retry, instead of failing.
            if response.status_code == 402:
                _logger().info("Mint requires subscription (402)", detail=detail[:200])
                return {"status": "subscription_required", "error": detail}
            response.raise_for_status()
        result = response.json()
        archive_root_agent_id = _current_root_agent_id() or str(payload.get("agentId") or user_id)
        _archive_json(
            root_agent_id=archive_root_agent_id,
            path=f"provider/payment/mint/{body['fingerprint']}.json.gz.enc",
            payload={"request": body, "response": result},
        )
        return result


@activity.defn
async def agentcard_status_activity(user_id: str) -> Dict[str, Any]:
    import httpx

    config = _load_config()
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"{config.backend.api_url}/api/agentcard/status",
            headers={
                "X-API-Key": config.backend.api_key,
                "X-User-Id": user_id,
                "Content-Type": "application/json",
            },
        )
        response.raise_for_status()
        result = response.json()
        _archive_json(
            root_agent_id=user_id,
            path="provider/agentcard/status.json.gz.enc",
            payload={"request": {"user_id": user_id}, "response": result},
        )
        return result


@activity.defn
async def record_facilitated_gmv_activity(
    user_id: str,
    payload: Dict[str, Any],
) -> Dict[str, Any]:
    """Persist merchant card-on-file GMV when a purchase write-lock is approved.

    Accepts either a pre-normalized capture payload or a raw write-lock notification
    under ``notification``. Idempotent. Skips when an AgentCard PurchaseSpend already
    covers the agent.
    """
    import httpx

    from utils.gmv_capture import extract_facilitated_gmv_capture

    capture = payload
    notification = payload.get("notification")
    if notification is not None:
        extracted = extract_facilitated_gmv_capture(
            notification,
            current_url=str(payload.get("currentUrl") or ""),
            approval_domain=str(payload.get("domain") or ""),
        )
        if extracted is None:
            return {"status": "skipped", "reason": "unparseable_purchase_total"}
        capture = {
            **extracted,
            "agentId": payload.get("agentId"),
            "approvedAt": payload.get("approvedAt"),
        }

    total_cents = capture.get("totalCents") or 0
    merchant = capture.get("merchant") or ""
    if not total_cents or not merchant:
        return {"status": "skipped", "reason": "missing_merchant_or_total"}

    config = _load_config()
    body = {
        "agentId": capture.get("agentId"),
        "merchant": merchant,
        "totalCents": total_cents,
        "currency": capture.get("currency") or "USD",
        "paymentMethod": capture.get("paymentMethod"),
        "domain": capture.get("domain"),
        "approvedAt": capture.get("approvedAt"),
        "lineItems": capture.get("lineItems") or [],
        "totals": capture.get("totals"),
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{config.backend.api_url}/api/purchases/record-facilitated-gmv",
            json=body,
            headers={
                "X-API-Key": config.backend.api_key,
                "X-User-Id": user_id,
                "Content-Type": "application/json",
            },
        )
        if response.status_code >= 400:
            detail = _error_payload(response)
            _logger().warning(
                "Facilitated GMV record failed",
                status_code=response.status_code,
                detail=str(detail.get("error") or detail)[:200],
            )
            return {"status": "error", **detail}
        result = response.json()
        archive_root = _current_root_agent_id() or str(capture.get("agentId") or user_id)
        safe_merchant = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in str(merchant))[:80]
        _archive_json(
            root_agent_id=archive_root,
            path=f"provider/payment/facilitated-gmv/{safe_merchant or 'unknown'}.json.gz.enc",
            payload={"request": body, "response": result},
        )
        return result if isinstance(result, dict) else {"status": "recorded", "raw": result}
