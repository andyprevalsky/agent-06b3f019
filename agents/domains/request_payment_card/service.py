"""Payment-card request helpers for browser agents."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict

from helpers.world_model_runtime import WorldModelToolExecutionAdapter

from .repo import lookup_purchase_from_backend, mint_purchase_card_from_backend
from .types import PaymentPayload, PurchaseResult


def _to_list(value: Any) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _to_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(round(value))
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return 0


def normalize_payment_payload(tool_call: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    line_items = []
    for item in _to_list(tool_call.get("line_items") or tool_call.get("lineItems")):
        if not isinstance(item, dict):
            continue
        line_items.append(
            {
                "name": str(item.get("name") or "").strip(),
                "imageUrl": item.get("image_url") or item.get("imageUrl"),
                "unitPriceCents": _to_int(item.get("unit_price_cents") or item.get("unitPriceCents")),
                "quantity": _to_int(item.get("quantity")) or 1,
                "lineTotalCents": _to_int(item.get("line_total_cents") or item.get("lineTotalCents")),
            }
        )

    fees = []
    for fee in _to_list(tool_call.get("fees")):
        if not isinstance(fee, dict):
            continue
        fees.append(
            {
                "label": str(fee.get("label") or fee.get("name") or "").strip(),
                "amountCents": _to_int(fee.get("amount_cents") or fee.get("amountCents")),
            }
        )

    payload = {
        "userId": user_id,
        "merchant": str(tool_call.get("merchant") or "").strip(),
        "currency": str(tool_call.get("currency") or "USD").upper(),
        "lineItems": line_items,
        "fees": fees,
        "subtotalCents": _to_int(tool_call.get("subtotal_cents") or tool_call.get("subtotalCents")),
        "totalCents": _to_int(tool_call.get("total_cents") or tool_call.get("totalCents")),
    }
    payload["fingerprint"] = build_payment_fingerprint(payload)
    return payload


def build_payment_fingerprint(payload: Dict[str, Any]) -> str:
    stable = {
        "userId": payload.get("userId"),
        "merchant": str(payload.get("merchant") or "").strip().lower(),
        "currency": payload.get("currency", "USD"),
        "lineItems": payload.get("lineItems") or [],
        "fees": payload.get("fees") or [],
        "totalCents": payload.get("totalCents") or 0,
    }
    encoded = json.dumps(stable, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def build_payment_question(payload: Dict[str, Any]) -> str:
    total = (payload.get("totalCents") or 0) / 100
    merchant = payload.get("merchant") or "this merchant"
    lines = [f"Approve a ${total:.2f} purchase from {merchant}?"]
    for item in payload.get("lineItems") or []:
        name = item.get("name") or "Item"
        qty = item.get("quantity") or 1
        line_total = (item.get("lineTotalCents") or 0) / 100
        lines.append(f"- {name} x{qty}: ${line_total:.2f}")
    for fee in payload.get("fees") or []:
        label = fee.get("label") or "Fee"
        amount = (fee.get("amountCents") or 0) / 100
        lines.append(f"- {label}: ${amount:.2f}")
    lines.append("\nRose will charge your saved Stripe billing method, then issue a one-time virtual card.")
    return "\n".join(lines)


async def lookup_purchase(user_id: str, fingerprint: str) -> PurchaseResult:
    async def real_executor(
        _tool_name: str,
        _tool_args: dict[str, Any],
        _tool_call_id: str,
    ) -> PurchaseResult:
        return await lookup_purchase_from_backend(user_id, fingerprint)

    return await WorldModelToolExecutionAdapter.from_env(agent_id=user_id).execute(
        "payment_lookup",
        {"user_id": user_id, "fingerprint": fingerprint},
        f"payment_lookup:{fingerprint}",
        real_executor,
    )


async def mint_purchase_card(user_id: str, payload: PaymentPayload) -> PurchaseResult:
    fingerprint = str(payload.get("fingerprint") or "")

    async def real_executor(
        _tool_name: str,
        _tool_args: dict[str, Any],
        _tool_call_id: str,
    ) -> PurchaseResult:
        return await mint_purchase_card_from_backend(user_id, payload)

    return await WorldModelToolExecutionAdapter.from_env(agent_id=str(payload.get("agentId") or user_id)).execute(
        "payment_mint",
        {"user_id": user_id, "payload": payload},
        f"payment_mint:{fingerprint}",
        real_executor,
    )
