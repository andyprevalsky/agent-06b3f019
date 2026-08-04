"""Helpers to extract facilitated-GMV payloads from write-lock purchase notifications."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Dict, Optional

_MONEY_RE = re.compile(
    r"(?P<currency>\$|USD\s*)?(?P<amount>-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)",
    re.IGNORECASE,
)


def parse_money_to_cents(value: Any) -> Optional[int]:
    """Parse a visible money string/number into integer USD cents.

    Accepts forms like ``$12.34``, ``12.34``, ``USD 1,234.56``, or numeric 12.34.
    Returns None when no parseable positive amount is present.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float):
        if value <= 0:
            return None
        return int(round(value * 100))

    text = str(value).strip()
    if not text:
        return None
    match = _MONEY_RE.search(text.replace(" ", ""))
    if match is None:
        # Retry with spaces preserved for "USD 12.34"
        match = _MONEY_RE.search(text)
    if match is None:
        return None
    amount_text = match.group("amount").replace(",", "")
    try:
        cents = int(round(float(amount_text) * 100))
    except ValueError:
        return None
    return cents if cents > 0 else None


def extract_facilitated_gmv_capture(
    notification: Any,
    *,
    current_url: str = "",
    approval_domain: str = "",
) -> Optional[Dict[str, Any]]:
    """Build a facilitated-GMV capture payload from a purchase write-lock notification.

    Returns None when the notification is missing a parseable order total.
    """
    if not isinstance(notification, dict):
        return None
    if notification.get("trigger_type") not in (None, "purchase") and "purchase" not in notification:
        # Prefer explicit purchase payloads; allow missing trigger_type when purchase key exists.
        pass

    purchase = notification.get("purchase")
    if not isinstance(purchase, dict):
        return None

    totals = purchase.get("totals") if isinstance(purchase.get("totals"), dict) else {}
    total_cents = parse_money_to_cents(totals.get("total"))
    if total_cents is None:
        total_cents = parse_money_to_cents(purchase.get("total"))
    if total_cents is None:
        return None

    service = notification.get("service") if isinstance(notification.get("service"), dict) else {}
    merchant = (
        str(service.get("name") or "").strip()
        or str(service.get("domain") or "").strip()
        or approval_domain
        or "unknown merchant"
    )
    domain = str(service.get("domain") or approval_domain or "").strip()
    payment_method = purchase.get("payment_method")
    items = purchase.get("items") if isinstance(purchase.get("items"), list) else []

    return {
        "merchant": merchant,
        "totalCents": total_cents,
        "currency": "USD",
        "paymentMethod": str(payment_method).strip() if payment_method else None,
        "domain": domain or None,
        "currentUrl": current_url or None,
        "lineItems": items,
        "totals": totals,
    }


def facilitated_gmv_fingerprint(payload: Dict[str, Any]) -> str:
    """Stable fingerprint for idempotent facilitated-GMV recording (tests/helpers)."""
    identity = {
        "kind": "facilitated_gmv",
        "userId": payload.get("userId"),
        "agentId": payload.get("agentId"),
        "merchant": str(payload.get("merchant") or "").strip().lower(),
        "totalCents": payload.get("totalCents"),
        "domain": str(payload.get("domain") or "").strip().lower(),
        "approvedAt": payload.get("approvedAt"),
    }
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode("utf-8")).hexdigest()
