"""Pure validation helpers for purchase-approval product context."""

import re
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

_PRODUCT_QUERY_KEYS = {"id", "item", "item_id", "pid", "product", "product_id", "sku"}
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


def _contains_checkout_route(value: str, *, hostname: bool = False) -> bool:
    tokens = _url_token_sequence(value)
    if set(tokens) & _CHECKOUT_ROUTE_TOKENS:
        return True
    if tokens and tokens[0] in _CHECKOUT_LEADING_TOKENS:
        return True
    if hostname and set(tokens) & _CHECKOUT_LEADING_TOKENS:
        return True
    return any(pair in _CHECKOUT_TOKEN_PAIRS for pair in zip(tokens, tokens[1:]))


def _normalized_page_route(value: str) -> tuple[str, str]:
    parsed = urlparse(value)
    hostname = (parsed.hostname or "").lower().removeprefix("www.")
    path = re.sub(r"/+", "/", _decode_url_component(parsed.path).lower()).rstrip("/") or "/"
    return hostname, path


def _looks_like_product_route(value: str) -> bool:
    parsed = urlparse(value)
    path_segments = [segment for segment in _decode_url_component(parsed.path).lower().split("/") if segment]
    if _url_tokens(parsed.path) & _PRODUCT_ROUTE_MARKERS:
        return True
    if any(segment.startswith("buy-") for segment in path_segments) and "shop" in path_segments:
        return True
    return any(
        key.lower() in _PRODUCT_QUERY_KEYS and query_value.strip() for key, query_value in parse_qsl(parsed.query)
    )


def validate_product_detail_url(value: Any) -> str:
    text = str(value or "").strip()
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("product_url must be an absolute http(s) product-detail URL")

    if _contains_checkout_route(parsed.hostname or "", hostname=True):
        raise ValueError("product_url must link to the product page, not cart or checkout")

    query_pairs = parse_qsl(parsed.query, keep_blank_values=True)
    route_values = [parsed.path]
    for key, query_value in query_pairs:
        route_values.extend((key, query_value))
    if any(_contains_checkout_route(route_value) for route_value in route_values):
        raise ValueError("product_url must link to the product page, not cart or checkout")

    path_has_detail = bool(parsed.path.strip("/"))
    query_has_product_id = any(key.lower() in _PRODUCT_QUERY_KEYS and value.strip() for key, value in query_pairs)
    if not path_has_detail and not query_has_product_id:
        raise ValueError("product_url must identify a product, not the merchant homepage")
    return text


def validate_product_url_for_page(value: Any, current_page_url: Any) -> str:
    product_url = validate_product_detail_url(value)
    current_url = str(current_page_url or "").strip()
    if (
        current_url
        and _normalized_page_route(product_url) == _normalized_page_route(current_url)
        and not _looks_like_product_route(product_url)
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
    match = re.search(r"(?<![\d.,])(\d(?:\.\d+)?)(?![\d.,])", text)
    if not match or not 0 <= float(match.group(1)) <= 5:
        raise ValueError("rating must include a numeric product score from 0 to 5")
    return text


def validate_product_review_count(value: Any) -> str:
    text = _validated_review_text(value)
    count_pattern = r"\b\d[\d,]*(?:\.\d+)?\s*[kmb]?\+?\s+(?:customer\s+)?(?:reviews?|ratings?)\b"
    if not re.search(count_pattern, text, re.IGNORECASE):
        raise ValueError("review_count must include a numeric count followed by reviews or ratings")
    return text
