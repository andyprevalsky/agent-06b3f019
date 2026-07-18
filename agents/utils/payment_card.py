"""Pure payment-card payload and approval-message helpers."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Dict

from utils.purchase_approval import (
    validate_product_detail_url,
    validate_product_rating,
    validate_product_review_count,
)


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
        product_url = validate_product_detail_url(item.get("product_url") or item.get("productUrl"))
        rating = validate_product_rating(item.get("rating"))
        review_count = validate_product_review_count(item.get("review_count") or item.get("reviewCount"))
        line_items.append(
            {
                "name": str(item.get("name") or "").strip(),
                "imageUrl": item.get("image_url") or item.get("imageUrl"),
                "productUrl": product_url,
                "rating": rating,
                "reviewCount": review_count,
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


def _hash_payment_identity(payload: Dict[str, Any]) -> str:
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


def _canonicalize_review_count(value: str) -> str:
    return re.sub(r"(?<=\d),(?=\d)", "", value)


def _payment_payload_with_review_counts(
    payload: Dict[str, Any],
    transform: Any,
) -> Dict[str, Any]:
    candidate = {**payload, "lineItems": []}
    for raw_item in payload.get("lineItems") or []:
        if not isinstance(raw_item, dict):
            continue
        item = dict(raw_item)
        review_count = item.get("reviewCount")
        if isinstance(review_count, str):
            item["reviewCount"] = transform(review_count)
        candidate["lineItems"].append(item)
    return candidate


def build_payment_fingerprint(payload: Dict[str, Any]) -> str:
    """Hash purchase identity while canonicalizing equivalent review-count punctuation."""
    # Browser extraction may preserve or omit thousands separators for the
    # same visible count. Only punctuation between digits is removed;
    # materially different review text remains distinct.
    canonical = _payment_payload_with_review_counts(payload, _canonicalize_review_count)
    return _hash_payment_identity(canonical)


def _approval_plain_text(value: Any) -> str:
    """Collapse newlines and escape Markdown controls in merchant-supplied text."""
    text = re.sub(r"\s+", " ", str(value or "").strip())
    return text.translate(str.maketrans({character: f"\\{character}" for character in r"\`*_{}[]<>()#+-.!|"}))


def build_payment_question(payload: Dict[str, Any]) -> str:
    total = (payload.get("totalCents") or 0) / 100
    merchant = _approval_plain_text(payload.get("merchant") or "this merchant")
    lines = [f"Approve a ${total:.2f} purchase from {merchant}?"]
    for item in payload.get("lineItems") or []:
        name = _approval_plain_text(item.get("name") or "Item")
        qty = item.get("quantity") or 1
        line_total = (item.get("lineTotalCents") or 0) / 100
        lines.append(f"- {name} x{qty}: ${line_total:.2f}")
        lines.append(f"  Product: <{item.get('productUrl')}>")
        lines.append(
            f"  Reviews: {_approval_plain_text(item.get('rating'))} ({_approval_plain_text(item.get('reviewCount'))})"
        )
    for fee in payload.get("fees") or []:
        label = _approval_plain_text(fee.get("label") or "Fee")
        amount = (fee.get("amountCents") or 0) / 100
        lines.append(f"- {label}: ${amount:.2f}")
    lines.append("\nRose will charge your saved Stripe billing method, then issue a one-time virtual card.")
    return "\n".join(lines)
