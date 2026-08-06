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
    # urlparse treats "\" as an ordinary character, so
    # https://attacker.example\@merchant.example/item parses with hostname
    # merchant.example while a browser normalizes "\" to "/" and navigates to
    # attacker.example. That mismatch defeats the trusted-host check below, so
    # reject the character outright rather than trying to canonicalize it.
    if "\\" in text:
        raise ValueError("product_url must not contain a backslash")
    parsed = urlparse(text)
    try:
        # urlparse defers malformed-port validation until this attribute is read.
        parsed.port
    except ValueError as error:
        raise ValueError("product_url must be an absolute http(s) URL") from error
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("product_url must be an absolute http(s) URL")
    return text


def _registrable_host(url: Any) -> str:
    """Lowercased host without a leading 'www.', or '' when unparseable."""
    try:
        host = (urlparse(str(url or "")).hostname or "").lower()
    except ValueError:
        return ""
    # `urlparse` keeps the trailing DNS root label, so `merchant.example.` and
    # `merchant.example` would otherwise compare unequal and fail the trust check.
    host = host[:-1] if host.endswith(".") else host
    return host[4:] if host.startswith("www.") else host


def _host_is_trusted(candidate: str, trusted_hosts: set[str]) -> bool:
    """Accept the trusted host itself and any subdomain of it.

    Subdomains matter: a merchant routinely serves the product page from
    `menu.order.example.com` while the browser only visited
    `order.example.com`. Rejecting that was the false-negative that got
    host matching removed in the first place.
    """
    if not candidate:
        return False
    return any(
        candidate == trusted or candidate.endswith(f".{trusted}") or trusted.endswith(f".{candidate}")
        for trusted in trusted_hosts
        if trusted
    )


def validate_product_url_for_page(value: Any, current_page_url: Any) -> str:
    """Validate structure, then require the host to match the current page."""
    return validate_product_url_for_pages(value, [current_page_url])


def validate_product_url_for_pages(value: Any, trusted_page_urls: Iterable[Any]) -> str:
    """Validate structure, then require a host the browser actually visited.

    The approval renders this URL to the user as a clickable link, so an
    unconstrained absolute URL is a destination-author primitive (CWE-601): the
    agent could be steered into surfacing an attacker's link inside a purchase
    approval the user trusts.

    Only the HOST is constrained. Path and query heuristics stay removed - those
    were the unguaranteeable part that rejected receipts from working checkouts.
    """
    text = validate_product_detail_url(value)
    trusted_hosts = {_registrable_host(url) for url in (trusted_page_urls or [])}
    trusted_hosts.discard("")
    # No page context at all: nothing to check against, so keep the structural
    # result rather than failing a legitimate call site.
    if not trusted_hosts:
        return text
    if not _host_is_trusted(_registrable_host(text), trusted_hosts):
        raise ValueError(
            "product_url host must match a page the browser actually visited"
        )
    return text


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
