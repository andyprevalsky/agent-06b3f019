"""Blackbox tests for the purchase-approval product-URL validator.

`product_url` is validated for WELL-FORMEDNESS ONLY. Inferring what kind of page
a URL points at — product vs checkout vs storefront — was removed deliberately:
every merchant invents its own path and query conventions, so the heuristic could
only ever recognise shapes we had already been burned by, and each miss rejected
a receipt from a working checkout. These tests pin that the validator accepts any
real URL and still refuses input that is not a URL at all.
"""

import asyncio

from _test_utils import BlackboxResult

from utils.purchase_approval import (
    validate_product_detail_url,
    validate_product_url_for_page,
    validate_product_url_for_pages,
)


def test_any_well_formed_merchant_url_is_accepted():
    """No page-type inference: product, storefront, and checkout URLs all pass."""
    for url in (
        # The exact URL that was rejected mid-checkout and cost 62% of a run.
        "https://www.doordash.com/store/1111604/?itemId=abc123",
        # Conventions no allowlist would have contained.
        "https://example.com/store/9/?fooBarBaz=xyz",
        "https://example.com/store/9/?menuItemUuid=abc",
        # Shapes the old heuristic actively rejected.
        "https://example.com/checkout?itemId=1",
        "https://example.com/cart",
        "https://example.com/",
        "https://example.com/store/1111604/",
        "https://example.com/store/9/?utm_source=email",
    ):
        assert validate_product_detail_url(url) == url, url


def test_url_is_returned_unchanged():
    """The validator normalises nothing; it only accepts or rejects."""
    url = "https://Example.com/Store/9/?itemId=AbC&utm_source=x"
    assert validate_product_detail_url(url) == url


def test_non_urls_are_still_rejected():
    """The one guarantee kept: it must actually be an absolute http(s) URL."""
    for value in (
        "not a url",
        "/store/1111604/?itemId=abc",
        "example.com/p/1",
        "ftp://example.com/p/1",
        "javascript:alert(1)",
        "",
        None,
    ):
        try:
            validate_product_detail_url(value)
        except ValueError:
            continue
        raise AssertionError(f"non-URL was accepted: {value!r}")


def test_markup_and_whitespace_are_still_rejected():
    """Input hygiene survives: a URL carrying markup is not a URL."""
    for value in (
        "https://example.com/p/1?itemId=<script>",
        "https://example.com/p 1?itemId=abc",
        "https://example.com/p/1?a=b>c",
    ):
        try:
            validate_product_detail_url(value)
        except ValueError:
            continue
        raise AssertionError(f"malformed URL was accepted: {value!r}")


def test_page_context_no_longer_constrains_the_url():
    """Trajectory grounding was removed by decision; pin it so it cannot creep back silently."""
    unvisited = "https://never-visited.example/p?x=1"
    assert validate_product_url_for_pages(unvisited, ["https://other.example/a"]) == unvisited
    assert validate_product_url_for_pages(unvisited, []) == unvisited
    assert validate_product_url_for_page(unvisited, "https://other.example/a") == unvisited


def test_page_context_helpers_still_reject_non_urls():
    """The compatibility wrappers keep the well-formedness guarantee."""
    for helper, second in (
        (validate_product_url_for_pages, ["https://example.com/a"]),
        (validate_product_url_for_page, "https://example.com/a"),
    ):
        try:
            helper("not a url", second)
        except ValueError:
            continue
        raise AssertionError(f"{helper.__name__} accepted a non-URL")


async def run_all_tests():
    print("purchase-approval blackbox tests:")
    r = BlackboxResult()
    r.record("any_well_formed_url", test_any_well_formed_merchant_url_is_accepted)
    r.record("url_returned_unchanged", test_url_is_returned_unchanged)
    r.record("non_urls_rejected", test_non_urls_are_still_rejected)
    r.record("markup_rejected", test_markup_and_whitespace_are_still_rejected)
    r.record("page_context_unconstraining", test_page_context_no_longer_constrains_the_url)
    r.record("wrappers_reject_non_urls", test_page_context_helpers_still_reject_non_urls)
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
