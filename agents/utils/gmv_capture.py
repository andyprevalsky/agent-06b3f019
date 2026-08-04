"""Extract paid-order GMV from agent/browser structured outputs.

Requires BOTH a USD amount and a confirmation/order id. Write-lock approvals and
payment-boundary states without a confirmation id are rejected.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

_MONEY_RE = re.compile(
    r"(?:\$|USD\s*)?(?P<amount>-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)",
    re.IGNORECASE,
)
_CENTS_KEY_RE = re.compile(
    r"(total|amount|paid|charged|price|cost|subtotal|checkout|order|grand).*cents$|^cents$",
    re.IGNORECASE,
)
_AMOUNT_KEY_RE = re.compile(
    r"^(total|amount|price|cost|paid|charged)$|"
    r"(checkout|order|cart|grand|final|purchase).*(total|amount|price)|"
    r"(.*price.*usd)|(.*_total)$|(total_usd|amount_usd)$",
    re.IGNORECASE,
)
_CONFIRMATION_KEY_RE = re.compile(
    r"(order|payment|booking|reservation).*(id|number|confirmation)|"
    r"(confirmation).*(id|code|number)|receipt_id|transaction_id",
    re.IGNORECASE,
)
_CONFIRMATION_KEY_BLOCK_RE = re.compile(
    r"(card|pan|cvv|cvc|expiry|exp_).*number|one_time_payment|payment_card_number|"
    r"card_number|cardnumber",
    re.IGNORECASE,
)
_MERCHANT_KEY_RE = re.compile(r"^(merchant|vendor|seller|store|shop|restaurant|brand)$", re.IGNORECASE)
_NEGATIVE_KEYS = {
    "purchase_completed",
    "purchase_complete",
    "order_placed",
    "payment_completed",
    "paid",
}
_INVALID_CONFIRMATION = {
    "",
    "n/a",
    "na",
    "none",
    "null",
    "undefined",
    "unknown",
    "false",
    "true",
    "0",
    "-",
    "tbd",
    "pending",
}


def parse_money_to_cents(value: Any, *, treat_as_cents: bool = False) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        if value <= 0:
            return None
        return value if treat_as_cents else value * 100
    if isinstance(value, float):
        if value <= 0:
            return None
        return int(round(value if treat_as_cents else value * 100))
    text = str(value).strip()
    if not text:
        return None
    if treat_as_cents and re.fullmatch(r"-?\d+", text):
        cents = int(text)
        return cents if cents > 0 else None
    match = _MONEY_RE.search(text.replace(" ", "")) or _MONEY_RE.search(text)
    if match is None:
        return None
    try:
        cents = int(round(float(match.group("amount").replace(",", "")) * 100))
    except ValueError:
        return None
    return cents if cents > 0 else None


def _flatten(value: Any, prefix: str = "") -> List[Tuple[str, Any]]:
    if not isinstance(value, dict):
        return [(prefix, value)] if prefix else []
    out: List[Tuple[str, Any]] = []
    for key, child in value.items():
        path = key if not prefix else f"{prefix}.{key}"
        if isinstance(child, dict):
            out.extend(_flatten(child, path))
        else:
            out.append((path, child))
    return out


def _leaf(path: str) -> str:
    return path.rsplit(".", 1)[-1]


def _amount_score(path: str) -> int:
    leaf = _leaf(path).lower()
    if leaf in {"total_cents", "totalcents"}:
        return 100
    if "checkout" in leaf and "total" in leaf:
        return 90
    if "order" in leaf and "total" in leaf:
        return 85
    if leaf in {"total", "amount"}:
        return 80
    if _CENTS_KEY_RE.search(leaf):
        return 70
    if _AMOUNT_KEY_RE.search(leaf):
        return 60
    return 0


def _confirmation_score(path: str) -> int:
    leaf = _leaf(path).lower()
    if _CONFIRMATION_KEY_BLOCK_RE.search(leaf):
        return 0
    if leaf in {"order_confirmation_id", "orderconfirmationid"}:
        return 100
    if leaf in {"confirmation_code", "confirmationcode"}:
        return 95
    if leaf in {"order_id", "orderid"}:
        return 90
    if leaf in {"order_number", "ordernumber"}:
        return 85
    if _CONFIRMATION_KEY_RE.search(leaf):
        return 70
    return 0


def _normalize_confirmation(value: Any) -> Optional[str]:
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    if len(text) < 3 or len(text) > 80 or text.lower() in _INVALID_CONFIRMATION:
        return None
    if re.search(r"\s", text) and len(text) > 40:
        return None
    if re.search(
        r"\b(not\s+(placed|completed|evidenced|issued)|no\s+(order|purchase|confirmation)|unverified)\b",
        text,
        re.IGNORECASE,
    ):
        return None
    digits = re.sub(r"[\s-]", "", text)
    # Keep Amazon-style ###-#######-####### order ids; reject contiguous PANs.
    if re.fullmatch(r"\d{13,19}", digits) and not re.fullmatch(r"\d{3}-\d{7}-\d{7}", text):
        return None
    return text


def extract_structured_gmv(structured: Any) -> Optional[Dict[str, Any]]:
    """Return {totalCents, confirmationId, merchant, ...} or None."""
    if not isinstance(structured, dict):
        return None
    entries = _flatten(structured)
    for path, value in entries:
        if _leaf(path).lower() in _NEGATIVE_KEYS and value in (False, "false", 0, "0"):
            return None

    best_amount: Optional[Tuple[int, str, int]] = None
    best_confirmation: Optional[Tuple[str, str, int]] = None
    merchant = ""
    for path, value in entries:
        leaf = _leaf(path)
        if _MERCHANT_KEY_RE.search(leaf) and isinstance(value, str) and value.strip():
            merchant = value.strip()
        amount_score = _amount_score(path)
        if amount_score > 0:
            cents = parse_money_to_cents(value, treat_as_cents=bool(_CENTS_KEY_RE.search(leaf)))
            if cents is not None and (best_amount is None or amount_score > best_amount[2]):
                best_amount = (cents, path, amount_score)
        confirmation_score = _confirmation_score(path)
        if confirmation_score > 0:
            conf = _normalize_confirmation(value)
            if conf is not None and (
                best_confirmation is None or confirmation_score > best_confirmation[2]
            ):
                best_confirmation = (conf, path, confirmation_score)

    if best_amount is None or best_confirmation is None:
        return None
    return {
        "totalCents": best_amount[0],
        "confirmationId": best_confirmation[0],
        "merchant": merchant or "unknown merchant",
        "amountKey": best_amount[1],
        "confirmationKey": best_confirmation[1],
        "sourceFields": structured,
    }
