"""Cart completeness helpers for grocery purchase write-lock gating.

Pure detection logic for RCA c27b4f28 (2026-08-22): the browser agent reached
purchase approval with one Kodiak item while the task goal listed a full Safeway
manifest.
"""

from __future__ import annotations

import re
from typing import Optional

_MANIFEST_HEADER_RE = re.compile(r"\bMANIFEST\s*:", re.IGNORECASE)
_CART_COUNT_PATTERNS = (
    re.compile(r"order\s+summary\s*\(\s*(\d+)\s*items?\s*\)", re.IGNORECASE),
    re.compile(r"(\d+)\s+items?\s+in\s+cart", re.IGNORECASE),
    re.compile(r"(\d+)\s+in\s+cart", re.IGNORECASE),
)


def estimate_required_line_item_minimum(task_prompt: str) -> Optional[int]:
    """Estimate how many distinct grocery line items a multi-item manifest goal requires."""
    text = (task_prompt or "").strip()
    if not text:
        return None

    lowered = text.lower()
    if "manifest" not in lowered and "every available required" not in lowered:
        return None

    manifest_section = text
    match = _MANIFEST_HEADER_RE.search(text)
    if match:
        manifest_section = text[match.end():]

    parts = [part.strip() for part in re.split(r"[;\n]", manifest_section) if part.strip()]
    meaningful = [
        part
        for part in parts
        if len(part) > 8
        and not part.lower().startswith("deliver to")
        and not part.lower().startswith("use saved")
        and not part.lower().startswith("complete checkout")
    ]
    if not meaningful:
        return None
    return len(meaningful)


def extract_observed_cart_item_count(browser_text: str) -> Optional[int]:
    """Parse DoorDash-style cart counts from evaluate/checkout page text."""
    text = browser_text or ""
    for pattern in _CART_COUNT_PATTERNS:
        match = pattern.search(text)
        if match:
            return int(match.group(1))
    return None


def should_block_purchase_for_incomplete_cart(
    task_prompt: str,
    *,
    observed_cart_item_count: Optional[int] = None,
    recent_browser_text: str = "",
) -> bool:
    """Return True when a purchase write-lock should be deferred for an incomplete cart."""
    minimum_required = estimate_required_line_item_minimum(task_prompt)
    if minimum_required is None:
        return False

    observed = observed_cart_item_count
    if observed is None:
        observed = extract_observed_cart_item_count(recent_browser_text)
    if observed is None:
        return False

    # Multi-item grocery manifests need most of the list before checkout approval.
    threshold = max(3, int(minimum_required * 0.5))
    return observed < threshold
