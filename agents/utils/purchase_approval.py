"""Pure validation helpers for purchase-approval product context."""

import re
from collections.abc import Iterable
from typing import Any
from urllib.parse import urlparse

_PLACEHOLDER_RE = re.compile(
    r"\b(?:n\s*/?\s*a|none|not\s+available|unavailable|unknown)\b",
    re.IGNORECASE,
)
_RATING_RE = re.compile(r"(?<![\d.,])(\d(?:\.\d+)?)(?![\d.,])")
_REVIEW_COUNT_RE = re.compile(
    r"\b\d[\d,]*(?:\.\d+)?\s*[kmb]?\+?\s+(?:customer\s+)?(?:reviews?|ratings?)\b",
    re.IGNORECASE,
)


def _validated_review_text(value: Any) -> str:
    text = str(value or "").strip()
    if not text or _PLACEHOLDER_RE.search(text):
        raise ValueError("purchase approvals require real product review information")
    return text


def validate_product_detail_url(value: Any) -> str:
    """Require a well-formed absolute http(s) URL. Nothing more.

    This deliberately does NOT infer what KIND of page the URL points at.
    Guessing "is this a product page?" from path tokens and query-key names is
    unguaranteeable across merchants: every store invents its own conventions,
    so the heuristic could only ever recognise the shapes we had already been
    burned by. Each miss rejected a receipt from a WORKING checkout and sent the
    agent hunting for another URL -- one such miss (DoorDash's `?itemId=`) cost
    62% of a benchmark run before this validation was removed.
    """
    text = str(value or "").strip()
    if any(character.isspace() for character in text) or "<" in text or ">" in text:
        raise ValueError("product_url must not contain whitespace or markup")
    parsed = urlparse(text)
    try:
        # urlparse defers malformed-port validation until this attribute is read.
        parsed.port
    except ValueError as error:
        raise ValueError("product_url must be an absolute http(s) URL") from error
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("product_url must be an absolute http(s) URL")
    return text


def validate_product_url_for_page(value: Any, current_page_url: Any) -> str:
    """Retained for call-site compatibility; page context no longer constrains the URL."""
    del current_page_url
    return validate_product_detail_url(value)


def validate_product_url_for_pages(value: Any, trusted_page_urls: Iterable[Any]) -> str:
    """Retained for call-site compatibility; trajectory no longer constrains the URL."""
    del trusted_page_urls
    return validate_product_detail_url(value)


def validate_product_rating(value: Any) -> str:
    text = _validated_review_text(value)
    if re.search(r"\breviews?\b|\bratings\b", text, re.IGNORECASE):
        raise ValueError("rating must be a product score, not a review count")
    match = _RATING_RE.search(text)
    if not match or not 0 <= float(match.group(1)) <= 5:
        raise ValueError("rating must include a numeric product score from 0 to 5")
    return f"{match.group(1)} stars"


def validate_product_review_count(value: Any) -> str:
    text = _validated_review_text(value)
    match = _REVIEW_COUNT_RE.search(text)
    if not match:
        raise ValueError("review_count must include a numeric count followed by reviews or ratings")
    return " ".join(match.group(0).split())
