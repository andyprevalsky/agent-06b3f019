"""Blackbox tests for the purchase-approval product-URL validator.

This module had no coverage, which is how a validator that rejected every
camelCase product-identifier query key reached production. A DoorDash checkout
was abandoned mid-flow because `?itemId=` was not recognised as a product route,
so these tests pin both the separator-insensitive matching AND the checkout /
homepage rejections that must NOT be loosened to achieve it.
"""

import asyncio

from _test_utils import BlackboxResult

from utils.purchase_approval import (
    _looks_like_product_route,
    validate_product_detail_url,
)


def test_camel_case_product_keys_are_product_routes():
    """camelCase identifiers are product routes (regression: DoorDash `?itemId=`)."""
    # The exact URL shape the DoorDash agent submitted and had rejected.
    assert _looks_like_product_route("https://www.doordash.com/store/1111604/?itemId=abc123")
    assert _looks_like_product_route("https://example.com/store/9/?productId=xyz")
    assert _looks_like_product_route("https://example.com/store/9/?skuId=xyz")


def test_separator_conventions_are_equivalent():
    """snake_case, camelCase, and kebab-case spellings resolve identically."""
    for query in ("item_id=abc", "itemId=abc", "item-id=abc", "ITEM_ID=abc"):
        assert _looks_like_product_route(f"https://example.com/store/9/?{query}"), query


def test_non_product_query_keys_are_not_product_routes():
    """Normalisation must not turn unrelated keys into product identifiers."""
    assert not _looks_like_product_route("https://example.com/store/9/?ref=homepage")
    assert not _looks_like_product_route("https://example.com/store/9/?utm_source=email")


def test_blank_product_id_value_is_not_a_product_route():
    """A product key with no value identifies nothing."""
    assert not _looks_like_product_route("https://example.com/store/9/?itemId=")
    assert not _looks_like_product_route("https://example.com/store/9/?itemId=%20")


def test_camel_case_product_url_validates():
    """The validator accepts the previously rejected canonical URL unchanged."""
    url = "https://www.doordash.com/store/1111604/?itemId=abc123"
    assert validate_product_detail_url(url) == url


def test_checkout_urls_are_still_rejected():
    """Guard: widening key matching must not let checkout pages through."""
    for url in (
        "https://example.com/checkout?itemId=1",
        "https://example.com/cart?itemId=1",
    ):
        try:
            validate_product_detail_url(url)
        except ValueError:
            continue
        raise AssertionError(f"checkout URL was accepted: {url}")


def test_merchant_homepage_is_still_rejected():
    """Guard: a bare homepage still identifies no product."""
    try:
        validate_product_detail_url("https://example.com/?ref=x")
    except ValueError:
        return
    raise AssertionError("merchant homepage was accepted")


def test_markup_and_relative_urls_are_still_rejected():
    """Guard: input hygiene is unchanged by the key normalisation."""
    for url in (
        "https://example.com/p/1?itemId=<script>",
        "/store/1111604/?itemId=abc",
        "https://example.com/p 1?itemId=abc",
    ):
        try:
            validate_product_detail_url(url)
        except ValueError:
            continue
        raise AssertionError(f"invalid URL was accepted: {url}")


async def run_all_tests():
    print("purchase-approval blackbox tests:")
    r = BlackboxResult()
    r.record("camel_case_product_keys", test_camel_case_product_keys_are_product_routes)
    r.record("separator_conventions", test_separator_conventions_are_equivalent)
    r.record("non_product_keys", test_non_product_query_keys_are_not_product_routes)
    r.record("blank_product_id", test_blank_product_id_value_is_not_a_product_route)
    r.record("camel_case_validates", test_camel_case_product_url_validates)
    r.record("checkout_rejected", test_checkout_urls_are_still_rejected)
    r.record("homepage_rejected", test_merchant_homepage_is_still_rejected)
    r.record("markup_rejected", test_markup_and_relative_urls_are_still_rejected)
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
