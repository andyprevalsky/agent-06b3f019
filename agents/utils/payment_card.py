"""Pure payment-card payload and approval-message helpers."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Dict
from urllib.parse import urlsplit

from utils.purchase_approval import (
    validate_product_detail_url,
    validate_product_rating,
    validate_product_review_count,
)

# Workflow-safe payment-card timeout constants (single source of truth). Shared
# by the request_payment_card domain and the browser agent; kept in utils/ so
# cross-domain consumers import from a lower layer instead of another domain.
MINT_PURCHASE_CARD_BACKEND_RETRY_BUDGET_SECONDS = 60.0
MINT_PURCHASE_CARD_ACTIVITY_TIMEOUT_SECONDS = 90.0
MINT_PURCHASE_CARD_HTTP_TIMEOUT_SECONDS = 85.0


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


def _canonicalize_image_url(value: Any) -> Any:
    """Use the secure origin for the test checkout's placeholder image host."""
    if not isinstance(value, str):
        return value
    return re.sub(r"^http://placehold\.co(?=/|$)", "https://placehold.co", value, flags=re.I)


def normalize_payment_payload(tool_call: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    line_items = []
    for item in _to_list(tool_call.get("line_items") or tool_call.get("lineItems")):
        if not isinstance(item, dict):
            continue
        raw_product_url = item.get("product_url") or item.get("productUrl")
        product_url = validate_product_detail_url(raw_product_url) if str(raw_product_url or "").strip() else None
        rating = validate_product_rating(item.get("rating"))
        review_count = validate_product_review_count(item.get("review_count") or item.get("reviewCount"))
        line_item = {
            "name": str(item.get("name") or "").strip(),
            "imageUrl": _canonicalize_image_url(item.get("image_url") or item.get("imageUrl")),
            "productUrl": product_url,
            "rating": rating,
            "reviewCount": review_count,
            "unitPriceCents": _to_int(item.get("unit_price_cents") or item.get("unitPriceCents")),
            "quantity": _to_int(item.get("quantity")) or 1,
            "lineTotalCents": _to_int(item.get("line_total_cents") or item.get("lineTotalCents")),
        }
        # Product URL, rating and review count are optional; an absent one is omitted, never null.
        for optional_key in ("productUrl", "rating", "reviewCount"):
            if line_item[optional_key] is None:
                del line_item[optional_key]
        line_items.append(line_item)

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


_LINE_ITEM_QTY_SUFFIX_RE = re.compile(r"\s+(?:-\s*)?x([0-9]+)\s*$", re.IGNORECASE)
_LINE_ITEM_QTY_MERCHANT_SUFFIX_RE = re.compile(
    r"\s+(?:-\s*)?x([0-9]+)\s+\(([^()]*)\)\s*$", re.IGNORECASE
)
_LINE_ITEM_PRICED_SUFFIX_RE = re.compile(
    r"\s+-\s+([0-9]+)\s+x\s+\$([0-9]+)\.([0-9]{2})\s*$", re.IGNORECASE
)
_LINE_ITEM_CART_SUMMARY_SUFFIX_RE = re.compile(
    r"\s+-\s+x([0-9]+)\s+-\s+\$([0-9]+)\.([0-9]{2})"
    r"(?:\s+\(([^()]*)\))?\s*$",
    re.IGNORECASE,
)


def _canonicalize_line_item_name(
    name: Any, quantity: Any, unit_price_cents: Any, merchant: Any
) -> Any:
    """Strip matching quantity and merchant echoes from an item title.

    Browser agents often copy order-summary prose ("Aurora Notebook x1") into
    `name` while also setting `quantity: 1`. That display-only suffix must not
    mint a second card for the same cart (agent-payment-idempotent-abandonment).
    """
    if not isinstance(name, str):
        return name
    qty = quantity if isinstance(quantity, int) and not isinstance(quantity, bool) else _to_int(quantity)
    if qty <= 0:
        qty = 1
    merchant_echo = _LINE_ITEM_QTY_MERCHANT_SUFFIX_RE.search(name)
    if (
        merchant_echo is not None
        and int(merchant_echo.group(1)) == qty
        and merchant_echo.group(2).strip().lower() == str(merchant or "").strip().lower()
    ):
        return name[: merchant_echo.start()].rstrip()
    cart_summary = _LINE_ITEM_CART_SUMMARY_SUFFIX_RE.search(name)
    if cart_summary is not None:
        echoed_price = int(cart_summary.group(2)) * 100 + int(cart_summary.group(3))
        merchant_label = str(merchant or "").strip().lower()
        source_label = (cart_summary.group(4) or "").strip().lower()
        if (
            int(cart_summary.group(1)) == qty
            and echoed_price == _to_int(unit_price_cents)
            and (not source_label or source_label in {merchant_label, f"{merchant_label} checkout"})
        ):
            return name[: cart_summary.start()].rstrip()
    priced = _LINE_ITEM_PRICED_SUFFIX_RE.search(name)
    if priced is not None:
        echoed_price = int(priced.group(2)) * 100 + int(priced.group(3))
        if int(priced.group(1)) == qty and echoed_price == _to_int(unit_price_cents):
            return name[: priced.start()].rstrip()
    match = _LINE_ITEM_QTY_SUFFIX_RE.search(name)
    if match is None:
        return name
    if int(match.group(1)) != qty:
        return name
    return name[: match.start()].rstrip()


def _canonicalize_product_description(name: Any, product_url: Any) -> Any:
    """Drop a long description only when the title agrees with the product URL slug."""
    if not isinstance(name, str) or not isinstance(product_url, str):
        return name
    title, separator, description = name.partition(" - ")
    if not separator or len(description.split()) < 5:
        return name
    try:
        url = urlsplit(product_url)
    except ValueError:
        return name
    if url.scheme.lower() not in {"http", "https"} or not url.netloc:
        return name
    slug_match = re.search(
        r"/(?:p|products)/([a-z0-9]+(?:-[a-z0-9]+)*)/?$", url.path, re.IGNORECASE
    )
    if slug_match is None or re.sub(r"\s+", "-", title.strip().lower()) != slug_match.group(1).lower():
        return name
    return title.strip()


def _payment_payload_for_fingerprint(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Copy line items with display-only fields canonicalized for hashing."""
    candidate = {**payload, "lineItems": []}
    for raw_item in payload.get("lineItems") or []:
        if not isinstance(raw_item, dict):
            continue
        item = dict(raw_item)
        if "imageUrl" in item:
            item["imageUrl"] = _canonicalize_image_url(item["imageUrl"])
        review_count = item.get("reviewCount")
        if isinstance(review_count, str):
            item["reviewCount"] = _canonicalize_review_count(review_count)
        item["name"] = _canonicalize_line_item_name(
            item.get("name"), item.get("quantity"), item.get("unitPriceCents"), payload.get("merchant")
        )
        item["name"] = _canonicalize_product_description(item["name"], item.get("productUrl"))
        candidate["lineItems"].append(item)
    return candidate


def build_payment_fingerprint(payload: Dict[str, Any]) -> str:
    """Hash purchase identity while canonicalizing equivalent display-only drift."""
    # Browser extraction may preserve or omit thousands separators for the
    # same visible count, and may echo `x{qty}` onto the product name. Only
    # those display-only forms are normalized; material receipt text stays distinct.
    canonical = _payment_payload_for_fingerprint(payload)
    return _hash_payment_identity(canonical)


def _approval_plain_text(value: Any) -> str:
    """Collapse newlines and escape Markdown controls in merchant-supplied text."""
    text = re.sub(r"\s+", " ", str(value or "").strip())
    return text.translate(str.maketrans({character: f"\\{character}" for character in r"\`*_{}[]<>()#+-.!|"}))


def reuse_payment_approval(
    lookup: Dict[str, Any],
    payload: Dict[str, Any],
    agent_id: str,
    pending_approval: Any = None,
) -> Dict[str, Any] | None:
    """Bind existing consent to one held purchase; otherwise use the normal prompt."""
    purchase = lookup.get("purchase")
    if (
        pending_approval is not None
        or lookup.get("error")
        or lookup.get("found") is not True
        or lookup.get("reusable") is not True
        or not isinstance(purchase, dict)
        or purchase.get("agentId") != agent_id
        or purchase.get("status") != "HELD"
        or not purchase.get("id")
        or not purchase.get("cardId")
    ):
        return None
    payload["reusePurchaseId"] = purchase["id"]
    return {"attention_request_id": None, "reused_purchase_id": purchase["id"]}


def build_payment_question(payload: Dict[str, Any]) -> str:
    total = (payload.get("totalCents") or 0) / 100
    merchant = _approval_plain_text(payload.get("merchant") or "this merchant")
    lines = [f"Approve a ${total:.2f} purchase from {merchant}?"]
    for item in payload.get("lineItems") or []:
        name = _approval_plain_text(item.get("name") or "Item")
        qty = item.get("quantity") or 1
        line_total = (item.get("lineTotalCents") or 0) / 100
        lines.append(f"- {name} x{qty}: ${line_total:.2f}")
        if item.get("productUrl"):
            lines.append(f"  Product: <{item.get('productUrl')}>")
        rating, review_count = item.get("rating"), item.get("reviewCount")
        if rating and review_count:
            lines.append(f"  Reviews: {_approval_plain_text(rating)} ({_approval_plain_text(review_count)})")
        elif rating or review_count:
            lines.append(f"  Reviews: {_approval_plain_text(rating or review_count)}")
    for fee in payload.get("fees") or []:
        label = _approval_plain_text(fee.get("label") or "Fee")
        amount = (fee.get("amountCents") or 0) / 100
        lines.append(f"- {label}: ${amount:.2f}")
    lines.append("\nRose will charge your saved Stripe billing method, then issue a one-time virtual card.")
    return "\n".join(lines)
