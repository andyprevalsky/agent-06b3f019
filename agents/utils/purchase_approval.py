"""Pure validation helpers for purchase-approval product context."""

import re
from collections.abc import Iterable
from typing import Any
from urllib.parse import parse_qsl, unquote, urlparse

# NO VOCABULARY-BASED URL FILTERING.
#
# This module used to guess whether a URL "was a checkout page" by tokenizing it
# and matching word lists (cart/basket/checkout/payment/order/pay...). Every
# incident it ever produced was a FALSE REJECT of a real product page, because a
# URL's words do not tell you what the page is:
#   - agent 53feac08: order.online (DoorDash white-label) — the registrable
#     domain is the word "order".
#   - agent 90ac106a: order.toasttab.com — Toast is the largest US restaurant
#     ordering platform and EVERY product page lives on that host, so a purchase
#     was categorically impossible. The agent burned 5 rejected calls, then
#     escaped by inventing a www.toasttab.com URL it had never loaded — putting
#     a fabricated link in front of a human approving a real charge. The filter
#     made the trust surface WORSE than having no filter at all.
# A blocklist cannot be completed: merchant slugs legitimately contain these
# words ("/shop/cart-organizer", "/p/payment-processing-book"). What the URL is
# for is decided by evidence — whether the browser actually observed the host —
# not by its spelling. See validate_product_url_for_pages.
_PRODUCT_QUERY_KEYS = {"id", "item", "item_id", "pid", "product", "product_id", "sku"}
_PLACEHOLDER_RE = re.compile(r"\b(?:n\s*/?\s*a|none|not\s+available|unavailable|unknown)\b", re.IGNORECASE)
_RATING_RE = re.compile(r"(?<![\d.,])(\d(?:\.\d+)?)(?![\d.,])")
_REVIEW_COUNT_RE = re.compile(
    r"\b\d[\d,]*(?:\.\d+)?\s*[kmb]?\+?\s+(?:customer\s+)?(?:reviews?|ratings?)\b",
    re.IGNORECASE,
)


def _decode_url_component(value: str) -> str:
    decoded = value
    for _ in range(2):
        next_value = unquote(decoded)
        if next_value == decoded:
            break
        decoded = next_value
    return decoded


def _normalized_page_route(value: str) -> tuple[str, str, str]:
    """Host, path, and query — query included so routes stay distinguishable.

    Dropping the query collapsed `/catalog?id=123` and `/catalog?view=cart` to
    the same route, so a query-addressed product page was rejected as "the
    current checkout page" it merely shared a path with. Storefronts that
    address items purely by query string are common, and that false reject is
    the failure class this module exists to avoid.
    """
    parsed = urlparse(value)
    hostname = (parsed.hostname or "").lower().removeprefix("www.")
    path = re.sub(r"/+", "/", _decode_url_component(parsed.path).lower()).rstrip("/") or "/"
    query = "&".join(sorted(f"{k.lower()}={v}" for k, v in parse_qsl(parsed.query, keep_blank_values=True)))
    return hostname, path, query


def _product_host_is_covered(product_host: str, observed_host: str) -> bool:
    """Whether an observed host authorizes this product host.

    Directional on purpose. Observing ``shop.example.com`` must NOT authorize
    ``example.com``: the browser never loaded the parent, and a symmetric match
    let an agent mint a product link on a host it had not visited — the exact
    fabrication that put an unverified www.toasttab.com URL in front of a human
    approving a real charge. A product page may only live on the observed host
    or beneath it.
    """
    if not product_host or not observed_host:
        return False
    return product_host == observed_host or product_host.endswith(f".{observed_host}")


def validate_product_detail_url(value: Any) -> str:
    """Structural checks only — never guess intent from the URL's wording."""
    text = str(value or "").strip()
    if any(character.isspace() for character in text) or "<" in text or ">" in text:
        raise ValueError("product_url must not contain whitespace or markup")
    parsed = urlparse(text)
    try:
        # urlparse defers port validation until the attribute is read, so a
        # malformed authority (":99999", ":abc") parses clean and only explodes
        # later at the HTTP layer. Force it here so a bad URL is rejected at the
        # boundary that owns URL shape.
        parsed.port
    except ValueError as error:
        raise ValueError("product_url must be an absolute http(s) product-detail URL") from error
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("product_url must be an absolute http(s) product-detail URL")

    # The only remaining rejection: a bare origin identifies no item at all. Any
    # real product page has a path, so this can never false-reject one.
    query_pairs = parse_qsl(parsed.query, keep_blank_values=True)
    path_has_detail = bool(parsed.path.strip("/"))
    query_has_product_id = any(key.lower() in _PRODUCT_QUERY_KEYS and value.strip() for key, value in query_pairs)
    # A hash-routed SPA storefront carries its whole route in the fragment, so
    # `https://shop.example/#/product/123` has an EMPTY path and was rejected as
    # a bare homepage -- a false reject on every client-side-routed merchant.
    # The fragment identifies the item just as a path does.
    fragment_has_detail = bool(parsed.fragment.strip("/"))
    if not path_has_detail and not query_has_product_id and not fragment_has_detail:
        raise ValueError("product_url must identify a product, not the merchant homepage")
    return text


def validate_product_url_for_page(value: Any, observed_page_url: Any) -> str:
    """Host-only check against the single page this caller has observed.

    The argument is deliberately forwarded as a TRUSTED page URL and NOT as
    ``current_page_url=``. Passing it as the current page would enable the
    "don't echo the page you're standing on" rule on a caller that has no
    trajectory — and the write-lock purchase path legitimately raises its
    approval while sitting ON the product page, so that rule would reject a
    correct link. The parameter is named ``observed_page_url`` to stop a future
    refactor from "fixing" this into a false-reject; see
    validate_product_url_for_pages and browser_tools/schemas.py's write-lock
    branch.
    """
    return validate_product_url_for_pages(value, [observed_page_url])


def validate_product_url_for_pages(
    value: Any,
    trusted_page_urls: Iterable[Any],
    *,
    current_page_url: Any = None,
) -> str:
    """The only two semantic gates, both evidence-based rather than lexical.

    1. The host must be one the browser actually loaded. A URL invented from
       thin air on an unrelated domain cannot reach a human approving a charge.
    2. The product link must not simply be the page the agent is standing on.
       When request_payment_card fires the agent is on the checkout/session
       page, so echoing it back is never a product link.

    Neither rule reads the URL's wording, so neither can false-reject a real
    product page over its slug — the failure mode that made the old word-list
    gate unsatisfiable on whole ordering platforms.
    """
    product_url = validate_product_detail_url(value)
    product_route = _normalized_page_route(product_url)
    observed_hosts = [
        _normalized_page_route(str(page_url).strip())[0]
        for page_url in trusted_page_urls
        if str(page_url or "").strip().startswith(("http://", "https://"))
    ]
    if not any(_product_host_is_covered(product_route[0], observed_host) for observed_host in observed_hosts):
        raise ValueError(
            f"product_url host '{product_route[0]}' was not observed in the browser trajectory. "
            "Link to a page on a site this browser session actually loaded."
        )

    current = str(current_page_url or "").strip()
    if current.startswith(("http://", "https://")) and product_route == _normalized_page_route(current):
        raise ValueError(
            "product_url must identify the product, not the current checkout or session page "
            f"('{current}'). Link to the item's own page."
        )
    return product_url


def _validated_review_text(value: Any) -> str:
    text = str(value or "").strip()
    if not text or _PLACEHOLDER_RE.search(text):
        raise ValueError("purchase approvals require real product review information")
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


# Merchant identity for platform checkouts. Mirrors the benchmark evaluator's
# structured / connector forms so a confused parenthetical like
# "Eventim US (1015 Folsom)" is rejected before it becomes a human-facing
# payment_approval (bench12 agent 88b8d4a4-… failed only on merchant mismatch
# after reaching Eventim checkout).
_STRUCTURED_MERCHANT_IDENTITY = re.compile(
    r"^\s*(?P<business>.+?)\s*\(\s*(?P<platform>.+?)\s+-\s+"
    r"(?P<host>(?:[a-z0-9-]+\.)+[a-z0-9-]+)\s*\)\s*$",
    re.IGNORECASE,
)
_CONNECTED_MERCHANT_IDENTITY = re.compile(
    r"^\s*(?P<business>.+?)\s+(?:via|on|through|by|/)\s+(?P<platform>.+?)\s*$",
    re.IGNORECASE,
)
_CONFUSED_PARENTHETICAL_MERCHANT = re.compile(r"^.+\([^)]+\)\s*$")

_MERCHANT_IDENTITY_HINT = (
    "merchant must identify the business and platform as "
    "'Business (Platform - checkout.host)' "
    "(e.g. '1015 Folsom (Eventim - eventim.us)') or 'Business via Platform' "
    "(e.g. '1015 Folsom via Eventim'). Use the short platform name (Eventim), "
    "not a swapped venue-only parenthetical like 'Eventim US (1015 Folsom)'."
)


def validate_payment_merchant_name(value: Any) -> str:
    """Reject confused parenthetical merchants; allow bare first-party names."""
    text = str(value or "").strip()
    if not text:
        raise ValueError("merchant is required")
    if _STRUCTURED_MERCHANT_IDENTITY.fullmatch(text) or _CONNECTED_MERCHANT_IDENTITY.fullmatch(text):
        return text
    # Bare first-party names ("Blick Art Materials") remain valid. A trailing
    # parenthetical that is not `Platform - host` is almost always a venue/
    # platform swap and must be corrected before creating payment_approval.
    if _CONFUSED_PARENTHETICAL_MERCHANT.fullmatch(text):
        raise ValueError(_MERCHANT_IDENTITY_HINT)
    return text
