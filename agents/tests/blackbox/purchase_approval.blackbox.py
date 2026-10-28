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
    validate_image_url_for_page,
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
        # Non-empty netloc and a VALID port, but no hostname. A netloc-only
        # check accepts these, and the approval then carries a product link
        # the user cannot navigate to.
        "https://:443/item",
        "http://:80/item",
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


def test_page_context_constrains_the_host_only():
    """Page context constrains the HOST; path/query inference stays removed.

    Replaces test_page_context_no_longer_constrains_the_url, which pinned that an
    unvisited host was accepted. The approval renders this URL as a clickable
    link, so an unconstrained host is an open-redirect primitive (CWE-601).
    """
    unvisited = "https://never-visited.example/p?x=1"
    visited = ["https://other.example/a"]

    for call in (
        lambda: validate_product_url_for_pages(unvisited, visited),
        lambda: validate_product_url_for_page(unvisited, "https://other.example/a"),
    ):
        try:
            call()
        except ValueError:
            continue
        raise AssertionError("an unvisited product host must be rejected")

    # No page context at all leaves the structural result intact: there is
    # nothing to compare against, and failing here would break legitimate
    # call sites that never captured a trajectory.
    assert validate_product_url_for_pages(unvisited, []) == unvisited

    # A visited host still passes regardless of path/query shape.
    assert (
        validate_product_url_for_pages("https://other.example/cart?itemId=1", visited)
        == "https://other.example/cart?itemId=1"
    )


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


def test_image_url_must_be_an_image_the_page_renders():
    """A receipt image is shown to the user as the item they pay for, so it must be
    an asset the page actually renders, not a transcription with one digit drifted."""
    page = "https://shop.example/checkout"
    rendered = [
        "https://placehold.co/320x220/png?text=Canvas+Tote",
        "https://shop.example/img/mug.jpg",
        "https://cdn.shop.example:8443/lamp.png",
    ]

    assert (
        validate_image_url_for_page("https://placehold.co/320x220/png?text=Canvas+Tote", rendered, page)
        == "https://placehold.co/320x220/png?text=Canvas+Tote"
    )
    # Same asset over the other scheme, a relative reference, and host case are equivalent.
    assert validate_image_url_for_page("http://placehold.co/320x220/png?text=Canvas+Tote", rendered, page)
    assert validate_image_url_for_page("/img/mug.jpg", rendered, page) == "/img/mug.jpg"
    assert validate_image_url_for_page("https://SHOP.example/img/mug.jpg", rendered, page)
    assert validate_image_url_for_page("https://cdn.shop.example:8443/lamp.png", rendered, page)

    for drifted in (
        "https://cdn.shop.example/lamp.png",
        "ftp://placehold.co/320x220/png?text=Canvas+Tote",
        "https://placehold.co/220x220/png?text=Canvas+Tote",
        "https://placehold.co/320x220/png?text=Canvas+Bag",
        "https://shop.example/img/mug.jpeg",
        "https://placehold.co:abc/320x220/png?text=Canvas+Tote",
        "not a url",
    ):
        try:
            validate_image_url_for_page(drifted, rendered, page)
        except ValueError:
            continue
        raise AssertionError(f"unrendered image_url was accepted: {drifted!r}")

    # The field is optional, and a page with no rendered images leaves nothing to compare.
    assert validate_image_url_for_page(None, rendered, page) is None
    assert validate_image_url_for_page("", rendered, page) == ""
    assert validate_image_url_for_page("https://cdn.example/x.jpg", [], page) == "https://cdn.example/x.jpg"


def test_resized_cdn_derivative_is_the_same_image_as_its_origin():
    """Blue Bottle (agent 5516e75c): the store renders an item image as
    /cdn-cgi/image/<options>/<S3 origin> derivatives; the model submitted
    another size of the same origin. A resizing derivative is the same image as
    its exact embedded origin; anything else is still rejected."""
    page = "https://order.online/store/blue-bottle"
    origin = "https://doordash-static.s3.amazonaws.com/media/photosV2/09f09e4f-shakerato.png"
    rendered = [
        f"https://img.cdn4dd.com/cdn-cgi/image/fit=contain,width=1920,format=auto,anim=false/{origin}",
        "https://img.cdn4dd.com/p/fit=cover,width=150,height=150,format=auto/logo.png",
    ]
    requested = f"https://img.cdn4dd.com/cdn-cgi/image/fit=contain,width=1200,height=672,format=auto/{origin}"
    assert validate_image_url_for_page(requested, rendered, page) == requested
    # The origin itself, and a path normalizer's collapsed "https:/" form, are the same image.
    assert validate_image_url_for_page(origin, rendered, page) == origin
    collapsed = requested.replace("/https://", "/https:/")
    assert validate_image_url_for_page(collapsed, rendered, page) == collapsed

    for not_rendered in (
        requested.replace("09f09e4f", "09f09e4e"),  # a drifted origin
        "https://img.cdn4dd.com/cdn-cgi/image/fit=contain,width=1200/https://doordash-static.s3.amazonaws.com/other.png",
        "https://img.cdn4dd.com/cdn-cgi/image/noequals/" + origin,  # malformed options: not a wrapper
        "https://img.cdn4dd.com/cdn-cgi/image/fit=contain/relative/path.png",
    ):
        try:
            validate_image_url_for_page(not_rendered, rendered, page)
        except ValueError:
            continue
        raise AssertionError(f"never-rendered image accepted: {not_rendered!r}")


def test_foreign_host_cdn_derivative_does_not_inherit_a_rendered_asset():
    """PR #1604 review: the approval loads image_url as submitted, so another host's
    /cdn-cgi/image/ wrapper around a rendered origin must not pass as that image (the
    foreign host serves whatever it likes). Only the resizer the page used, or the
    origin's own host, may serve a derivative of a rendered asset."""
    page = "https://shop.example/checkout"
    origin = "https://shop.example/img/p1.jpg"
    s3_origin = "https://doordash-static.s3.amazonaws.com/media/photosV2/09f09e4f-shakerato.png"
    resized_s3 = f"https://img.cdn4dd.com/cdn-cgi/image/fit=contain,width=1920/{s3_origin}"
    rendered = [origin, resized_s3]

    for foreign in (
        f"https://attacker.example/cdn-cgi/image/w=1/{origin}",
        f"https://attacker.example/cdn-cgi/image/fit=contain,width=1920/{s3_origin}",
        f"https://attacker.example/cdn-cgi/image/w=1/{s3_origin.replace('https://', 'https:/')}",
        f"https://img.cdn4dd.com/cdn-cgi/image/w=1/{origin}",  # the page's resizer never served this origin
    ):
        try:
            validate_image_url_for_page(foreign, rendered, page)
        except ValueError:
            continue
        raise AssertionError(f"foreign-host derivative accepted as a rendered image: {foreign!r}")

    # The origin's own host resizing its rendered asset is still that image, and so is
    # the page's resizer at another size or the bare origin it embeds.
    same_host = f"https://shop.example/cdn-cgi/image/width=600/{origin}"
    assert validate_image_url_for_page(same_host, rendered, page) == same_host
    resized_again = f"https://img.cdn4dd.com/cdn-cgi/image/fit=contain,width=600/{s3_origin}"
    assert validate_image_url_for_page(resized_again, rendered, page) == resized_again
    assert validate_image_url_for_page(s3_origin, rendered, page) == s3_origin
    s3_self = f"https://doordash-static.s3.amazonaws.com/cdn-cgi/image/width=600/{s3_origin}"
    assert validate_image_url_for_page(s3_self, rendered, page) == s3_self


async def run_all_tests():
    print("purchase-approval blackbox tests:")
    r = BlackboxResult()
    r.record("any_well_formed_url", test_any_well_formed_merchant_url_is_accepted)
    r.record("url_returned_unchanged", test_url_is_returned_unchanged)
    r.record("non_urls_rejected", test_non_urls_are_still_rejected)
    r.record("markup_rejected", test_markup_and_whitespace_are_still_rejected)
    r.record("page_context_constrains_host", test_page_context_constrains_the_host_only)
    r.record("wrappers_reject_non_urls", test_page_context_helpers_still_reject_non_urls)
    r.record("image_url_must_be_rendered_on_page", test_image_url_must_be_an_image_the_page_renders)
    r.record("resized_cdn_derivative_is_same_image", test_resized_cdn_derivative_is_the_same_image_as_its_origin)
    r.record(
        "foreign_host_cdn_derivative_rejected",
        test_foreign_host_cdn_derivative_does_not_inherit_a_rendered_asset,
    )
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
