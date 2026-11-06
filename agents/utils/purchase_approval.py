"""Pure validation helpers for purchase-approval product context."""

import re
from collections.abc import Iterable
from typing import Any
from urllib.parse import urljoin, urlparse

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
    # `netloc` alone is not enough: "https://:443/item" has a non-empty netloc
    # and a valid port but no hostname, so it would pass as a "trusted page" and
    # put a non-navigable link in the approval. Require an actual host.
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or not parsed.hostname:
        raise ValueError("product_url must be an absolute http(s) URL")
    return text


# The LLM-visible product_url contract. Every tool schema and prompt states this
# one text so the model is never told a stricter rule than the validators here
# enforce: items that open in a modal over a menu, and single-page merchants,
# have no product page of their own to link to.
PRODUCT_URL_GUIDANCE = (
    "Link to this item's own product page when it has one. If it has no page of its own "
    "(for example it opens in a modal on a menu or store page, or the whole site is one page), "
    "use the URL of the page where you selected it; do not keep searching for a product URL "
    "the site does not have. Do not substitute a cart or checkout URL when the item is shown "
    "on another page."
)


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
        # A single-label host ("com", "localhost") is never a usable trust
        # anchor: expanding subdomains from it would authorize the entire TLD.
        if trusted and "." in trusted
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


_IMAGE_TRANSFORM_PREFIX = "/cdn-cgi/image/"


def _transformed_image_origin(parsed: Any) -> str:
    """The exact origin URL inside an image-resizing path ``/cdn-cgi/image/<options>/<origin>``.

    The options segment only resizes/re-encodes; the embedded absolute URL names the
    image. Returns '' for any other path shape.
    """
    if not parsed.path.startswith(_IMAGE_TRANSFORM_PREFIX):
        return ""
    rest = parsed.path[len(_IMAGE_TRANSFORM_PREFIX) :]
    options, _, origin = rest.partition("/")
    if not options or "=" not in options or not origin:
        return ""
    # A path normalizer may have collapsed the scheme's double slash ("https:/host").
    for scheme in ("https:/", "http:/"):
        if origin.startswith(scheme) and not origin.startswith(scheme + "/"):
            origin = scheme + "/" + origin[len(scheme) :]
    if not origin.startswith(("https://", "http://")):
        return ""
    return origin + (f"?{parsed.query}" if parsed.query else "")


def _image_identity(value: Any, page_url: Any) -> tuple[str, str, str] | None:
    """``(serving host, asset host, asset key)`` of an http(s) image URL, scheme-insensitive.

    A resized derivative (``/cdn-cgi/image/<options>/<origin>``) is the same image
    as its exact embedded origin, so its asset is that origin, but it is still
    served by its own host. None when not an http(s) URL.
    """
    try:
        parsed = urlparse(urljoin(str(page_url or ""), str(value or "").strip()))
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not hostname:
        return None
    host = f"{hostname}:{port}" if port else hostname
    origin = _transformed_image_origin(parsed)
    if origin:
        embedded = _image_identity(origin, "")
        return (host, embedded[1], embedded[2]) if embedded else None
    query = f"?{parsed.query}" if parsed.query else ""
    return host, host, f"{host}{parsed.path}{query}"


def validate_image_url_for_page(value: Any, page_image_urls: Iterable[Any], page_url: Any = "") -> Any:
    """Require a receipt image to be an asset the current page actually renders.

    The approval shows this image as the item being paid for, and the browser
    model transcribes it character by character, so near-miss URLs (one digit
    of a size segment drifted) are rejected rather than repaired. Scheme is
    ignored because pages reference the same asset over http and https.
    """
    if value is None or not str(value).strip():
        return value
    # Each rendered asset may be served by the host the page loaded it from, or by
    # the asset's own origin host. Another host's derivative of a rendered origin is
    # not that image: the approval loads the URL as submitted, from that host.
    rendered: set[tuple[str, str]] = set()
    for url in page_image_urls or []:
        identity = _image_identity(url, page_url)
        if identity is not None:
            serving_host, asset_host, asset_key = identity
            rendered.update({(serving_host, asset_key), (asset_host, asset_key)})
    # A page that renders no images leaves nothing to compare against.
    if not rendered:
        return value
    requested = _image_identity(value, page_url)
    if requested is None or (requested[0], requested[2]) not in rendered:
        raise ValueError("image_url must be copied exactly from an image rendered on the current page, or omitted")
    return value


def validate_product_rating(value: Any) -> str:
    text = _validated_review_text(value)
    if re.search(r"\breviews?\b|\bratings\b", text, re.IGNORECASE):
        raise ValueError("rating must be a product score, not a review count")
    match = _RATING_RE.search(text)
    if not match:
        raise ValueError("rating must include a numeric product score from 0 to 5")
    if float(match.group(1)) > 5:
        # Not a 5-star score: merchants rate on other scales (hotels.com shows
        # "9.2 out of 10"). Keep the page's text rather than rescale or reject it.
        return text
    return f"{match.group(1)} stars"


def validate_product_review_count(value: Any) -> str:
    text = _validated_review_text(value)
    match = _REVIEW_COUNT_RE.search(text)
    if not match:
        raise ValueError("review_count must include a numeric count followed by reviews or ratings")
    return " ".join(match.group(0).split())

