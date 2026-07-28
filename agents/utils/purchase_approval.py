"""Pure validation helpers for purchase-approval product context."""

import re
from collections.abc import Iterable
from typing import Any
from urllib.parse import parse_qsl, unquote, urlparse

_CHECKOUT_ROUTE_TOKENS = {
    "basket",
    "baskets",
    "cart",
    "carts",
    "checkout",
    "checkouts",
    "payment",
    "payments",
}

_CHECKOUT_TOKEN_PAIRS = {
    ("check", "out"),
    ("order", "confirmation"),
    ("order", "history"),
    ("order", "status"),
    ("pay", "ment"),
    ("secure", "order"),
    ("secure", "pay"),
}
_CHECKOUT_LEADING_TOKENS = {"order", "orders", "pay"}

# Stored separator-free so one entry covers every spelling of the same key.
# Merchants split roughly evenly between `item_id`, `itemId`, and `item-id`; the
# comparison below strips `_`/`-` so all three resolve to `itemid`. Matching the
# raw key rejected every camelCase spelling, which is the dominant web
# convention (DoorDash's canonical item URL uses `?itemId=`).
_PRODUCT_QUERY_KEYS = {"id", "item", "itemid", "pid", "product", "productid", "sku", "skuid"}


def _is_product_query_key(key: str) -> bool:
    """True when `key` names a product identifier in any separator convention."""
    return key.lower().replace("_", "").replace("-", "") in _PRODUCT_QUERY_KEYS
_PRODUCT_ROUTE_MARKERS = {
    "dp",
    "ip",
    "item",
    "items",
    "itm",
    "listing",
    "listings",
    "p",
    "pdp",
    "product",
    "products",
    "sku",
}
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


def _url_tokens(value: str) -> set[str]:
    return {token for token in re.split(r"[^a-z0-9]+", _decode_url_component(value).lower()) if token}


def _url_token_sequence(value: str) -> list[str]:
    return [token for token in re.split(r"[^a-z0-9]+", _decode_url_component(value).lower()) if token]


def _hostname_subdomain_token_sequence(hostname: str) -> list[str]:
    """Tokens from a hostname's SUBDOMAIN labels only.

    A checkout-ish word is a real routing signal when it names a subdomain
    (``checkout.example.com``, ``secure-checkout.shop.example.com``) but not
    when it *is* the registrable domain of a legitimate ordering platform
    (``order.online``, ``orders.com``, ``pay.com``). Without a public-suffix
    list we approximate the registrable domain as the final two labels and
    treat everything to their left as subdomain labels. Hosts with two or
    fewer labels have no subdomain and therefore contribute no checkout signal.
    """
    labels = [label for label in _decode_url_component(hostname).lower().split(".") if label]
    subdomain_labels = labels[:-2]
    return [
        token for label in subdomain_labels for token in re.split(r"[^a-z0-9]+", label) if token
    ]


def _contains_checkout_route(value: str, *, hostname: bool = False) -> bool:
    if hostname:
        # Only inspect subdomain labels: the registrable domain of an ordering
        # platform (order.online) must never be misread as a checkout page.
        tokens = _hostname_subdomain_token_sequence(value)
        if set(tokens) & (_CHECKOUT_ROUTE_TOKENS | _CHECKOUT_LEADING_TOKENS):
            return True
        return any(pair in _CHECKOUT_TOKEN_PAIRS for pair in zip(tokens, tokens[1:]))
    tokens = _url_token_sequence(value)
    if set(tokens) & _CHECKOUT_ROUTE_TOKENS:
        return True
    if tokens and tokens[0] in _CHECKOUT_LEADING_TOKENS:
        return True
    return any(pair in _CHECKOUT_TOKEN_PAIRS for pair in zip(tokens, tokens[1:]))


def _normalized_page_route(value: str) -> tuple[str, str]:
    parsed = urlparse(value)
    hostname = (parsed.hostname or "").lower().removeprefix("www.")
    path = re.sub(r"/+", "/", _decode_url_component(parsed.path).lower()).rstrip("/") or "/"
    return hostname, path


def _same_merchant_host(left: str, right: str) -> bool:
    """Match an observed merchant host, including its own subdomains."""
    if not left or not right:
        return False
    return left == right or left.endswith(f".{right}") or right.endswith(f".{left}")


def _looks_like_product_route(value: str) -> bool:
    parsed = urlparse(value)
    path_segments = [segment for segment in _decode_url_component(parsed.path).lower().split("/") if segment]
    if _url_tokens(parsed.path) & _PRODUCT_ROUTE_MARKERS:
        return True
    if any(segment.startswith("buy-") for segment in path_segments) and "shop" in path_segments:
        return True
    return any(
        _is_product_query_key(key) and query_value.strip() for key, query_value in parse_qsl(parsed.query)
    )


def validate_product_detail_url(value: Any) -> str:
    text = str(value or "").strip()
    if any(character.isspace() for character in text) or "<" in text or ">" in text:
        raise ValueError("product_url must not contain whitespace or markup")
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("product_url must be an absolute http(s) product-detail URL")

    if _contains_checkout_route(parsed.hostname or "", hostname=True):
        raise ValueError("product_url must link to the product page, not cart or checkout")

    query_pairs = parse_qsl(parsed.query, keep_blank_values=True)
    if _contains_checkout_route(parsed.path):
        raise ValueError("product_url must link to the product page, not cart or checkout")

    path_has_detail = bool(parsed.path.strip("/"))
    query_has_product_id = any(_is_product_query_key(key) and value.strip() for key, value in query_pairs)
    if not path_has_detail and not query_has_product_id:
        raise ValueError("product_url must identify a product, not the merchant homepage")
    return text


def validate_product_url_for_page(value: Any, current_page_url: Any) -> str:
    return validate_product_url_for_pages(value, [current_page_url])


def validate_product_url_for_pages(value: Any, trusted_page_urls: Iterable[Any]) -> str:
    """Require a product URL to use a merchant host observed by the browser."""
    product_url = validate_product_detail_url(value)
    product_host, product_path = _normalized_page_route(product_url)
    observed_routes = [
        _normalized_page_route(str(page_url).strip())
        for page_url in trusted_page_urls
        if str(page_url or "").strip().startswith(("http://", "https://"))
    ]
    if not any(_same_merchant_host(product_host, observed_host) for observed_host, _ in observed_routes):
        raise ValueError("product_url host was not observed in the browser trajectory")
    if any(
        (product_host, product_path) == observed_route and not _looks_like_product_route(product_url)
        for observed_route in observed_routes
    ):
        raise ValueError("product_url must identify the product, not the current checkout or session page")
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
