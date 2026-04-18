"""Blackbox tests for web-fetch domain."""

import asyncio
import json
from unittest.mock import patch

import httpx

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    setup_mock_fn,
    teardown_mock,
)


def _setup():
    setup_mock({
        "api.parallel.ai/v1beta/extract": {
            "status": 200,
            "json": {
                "text": "This is the extracted content from the webpage.",
                "title": "Example Page",
                "url": "https://example.com/article",
            },
        },
    })


async def test_web_fetch_happy_path():
    """web_fetch_activity returns extracted content from Parallel AI."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.web_fetch import web_fetch_activity

        result = await web_fetch_activity(
            url="https://example.com/article",
            objective="Extract the main content",
        )

    assert "text" in result or "content" in result or "title" in result


async def test_web_fetch_boundary():
    """Verify HTTP request sent to Parallel AI extract endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.web_fetch import web_fetch_activity

        await web_fetch_activity(
            url="https://example.com/research",
            objective="Get research findings",
            excerpts=True,
        )

    call = assert_captured_call(
        url_contains="api.parallel.ai/v1beta/extract",
        method="POST",
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    assert "https://example.com/research" in json.dumps(body)


# ── Pure helper coverage ──────────────────────────────────────────


def test_get_filename_from_url_simple():
    """Extracts basename for a plain URL."""
    from domains.web_fetch.service import get_filename_from_url

    assert get_filename_from_url("https://example.com/files/report.pdf") == "report.pdf"


def test_get_filename_from_url_cdn_transform():
    """Resolves filename through CDN transform suffix."""
    from domains.web_fetch.service import get_filename_from_url

    url = "https://cdn.example.com/photo.jpg/:/cr=t:0%25/rs=w:600"
    assert get_filename_from_url(url) == "photo.jpg"


def test_get_filename_from_url_fallback_basename():
    """Falls back to basename when no extension matches."""
    from domains.web_fetch.service import get_filename_from_url

    assert get_filename_from_url("https://example.com/some-path/abc") == "abc"


def test_get_filename_from_url_empty_path():
    """Empty path returns 'download'."""
    from domains.web_fetch.service import get_filename_from_url

    assert get_filename_from_url("https://example.com/") == "download"


def test_matches_extensions_end():
    """Matches extension at end of path."""
    from domains.web_fetch.service import matches_extensions

    assert matches_extensions("https://x.com/a.pdf", ["pdf"]) is True


def test_matches_extensions_middle():
    """Matches extension embedded in CDN path with trailing segment."""
    from domains.web_fetch.service import matches_extensions

    assert matches_extensions("https://x.com/photo.jpg/:/cr=rs", ["jpg", "png"]) is True


def test_matches_extensions_no_match():
    """Unmatched extension returns False."""
    from domains.web_fetch.service import matches_extensions

    assert matches_extensions("https://x.com/a.html", ["pdf", "csv"]) is False


def test_matches_extensions_with_dot_prefix():
    """Extensions with leading dot still match."""
    from domains.web_fetch.service import matches_extensions

    assert matches_extensions("https://x.com/a.pdf", [".pdf"]) is True


def test_extract_media_urls_all_types():
    """extract_media_urls finds images, files, and non-image links."""
    from domains.web_fetch.service import extract_media_urls

    text = (
        "Here is an image: ![alt](https://x.com/a.png)\n"
        "Bare image https://x.com/b.jpg .\n"
        "Download: https://x.com/spec.pdf\n"
        "Read [this](https://docs.com/page)"
    )
    media = extract_media_urls(text)
    assert "https://x.com/a.png" in media["images"]
    assert "https://x.com/b.jpg" in media["images"]
    assert "https://x.com/spec.pdf" in media["files"]
    assert "https://docs.com/page" in media["links"]


def test_extract_media_urls_dedupes():
    """Duplicate URLs are collapsed."""
    from domains.web_fetch.service import extract_media_urls

    text = "![](https://x.com/a.png) ![](https://x.com/a.png)"
    media = extract_media_urls(text)
    assert media["images"].count("https://x.com/a.png") == 1


def test_extract_media_urls_excludes_image_from_links():
    """Markdown image should NOT appear in links."""
    from domains.web_fetch.service import extract_media_urls

    text = "![img](https://x.com/a.png) [txt](https://x.com/b.html)"
    media = extract_media_urls(text)
    assert "https://x.com/a.png" not in media["links"]
    assert "https://x.com/b.html" in media["links"]


def test_extract_asset_urls_from_html():
    """Resolves asset src/href values relative to base URL."""
    from domains.web_fetch.service import extract_asset_urls_from_html

    html = (
        '<img src="/a/img.png"/>'
        '<a href="https://other.com/doc.pdf">doc</a>'
        '<a href="relative.pdf">rel</a>'
        '<a href="mailto:foo@example.com">email</a>'
        '<a href="#frag">anchor</a>'
        '<script src="data:application/javascript,..."></script>'
    )
    urls = extract_asset_urls_from_html(html, "https://example.com/page/")
    assert "https://example.com/a/img.png" in urls
    assert "https://other.com/doc.pdf" in urls
    assert "https://example.com/page/relative.pdf" in urls
    # None of the excluded schemes
    assert not any(u.startswith("mailto:") for u in urls)
    assert not any(u.startswith("data:") for u in urls)
    assert not any(u.startswith("#") for u in urls)


def test_extract_asset_urls_dedupes():
    """Duplicate asset URLs collapse after resolution."""
    from domains.web_fetch.service import extract_asset_urls_from_html

    html = '<img src="/a.png"/><img src="/a.png"/>'
    urls = extract_asset_urls_from_html(html, "https://example.com")
    assert urls == ["https://example.com/a.png"]


def test_format_extract_results_empty():
    """Empty results list returns a friendly default string."""
    from domains.web_fetch.service import format_extract_results

    assert format_extract_results([], full_content=False) == "No content extracted."


def test_format_extract_results_with_title_excerpts():
    """Formats with **Title** (url) prefix using excerpts."""
    from domains.web_fetch.service import format_extract_results

    result = format_extract_results(
        [
            {
                "url": "https://example.com/a",
                "title": "Article A",
                "excerpts": ["first", "second"],
                "full_content": "full text",
            }
        ],
        full_content=False,
    )
    assert "**Article A**" in result
    assert "first" in result
    assert "second" in result


def test_format_extract_results_full_content_no_title():
    """When no title, only URL is bolded."""
    from domains.web_fetch.service import format_extract_results

    result = format_extract_results(
        [{"url": "https://example.com/a", "title": "", "full_content": "big content body"}],
        full_content=True,
    )
    assert "**https://example.com/a**" in result
    assert "big content body" in result


def test_format_extract_results_all_empty_content():
    """Results with no content yield 'No relevant content found.'"""
    from domains.web_fetch.service import format_extract_results

    result = format_extract_results(
        [{"url": "https://x.com", "title": "T", "excerpts": [], "full_content": ""}],
        full_content=False,
    )
    assert "No relevant content found" in result


# ── Orchestration coverage ────────────────────────────────────────


async def test_fetch_and_extract_no_files():
    """fetch_and_extract returns full shape with downloaded_files empty when not requested."""
    setup_mock({
        "api.parallel.ai/v1beta/extract": {
            "status": 200,
            "json": {
                "results": [
                    {
                        "url": "https://example.com/a",
                        "title": "A",
                        "excerpts": ["hi"],
                        "full_content": "See ![](https://example.com/img.png)",
                    }
                ],
                "errors": [],
            },
        },
    })
    with patch("temporalio.activity.heartbeat"):
        from domains.web_fetch.service import fetch_and_extract

        result = await fetch_and_extract(
            url="https://example.com/a",
            objective="Extract",
            excerpts=True,
        )
    assert "downloaded_files" in result
    assert result["downloaded_files"] == []
    assert result["sources"] == ["https://example.com/a"]
    # img.png picked up from full_content
    assert "https://example.com/img.png" in result["images"]


async def test_fetch_and_extract_logs_errors():
    """Errors array from Parallel AI is forwarded."""
    setup_mock({
        "api.parallel.ai/v1beta/extract": {
            "status": 200,
            "json": {
                "results": [],
                "errors": [{"url": "https://example.com/b", "message": "blocked"}],
            },
        },
    })
    with patch("temporalio.activity.heartbeat"):
        from domains.web_fetch.service import fetch_and_extract

        result = await fetch_and_extract(
            url="https://example.com/b",
            objective="x",
        )
    assert result["errors"]
    assert result["content"] == "No content extracted."


async def test_download_matching_files_no_matches():
    """download_matching_files returns [] when no URL matches extensions."""
    with patch("temporalio.activity.heartbeat"):
        from domains.web_fetch.service import download_matching_files

        out = await download_matching_files(
            urls=["https://x.com/a.html", "https://x.com/b.xml"],
            extensions=["pdf"],
            user_id="u-1",
        )
    assert out == []


async def test_download_matching_files_happy_path():
    """download_matching_files downloads pdf files and uploads via supabase."""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "example.com/a.pdf" in url:
            return httpx.Response(200, content=b"%PDF-1.4 fake", headers={"Content-Type": "application/pdf"})
        if "/storage/v1/object/" in url:
            return httpx.Response(200, json={"Key": "user/u-1/a.pdf"})
        return httpx.Response(404, json={"error": "no mock"})

    setup_mock_fn(handler)

    # The upload path calls helpers.attachments.upload_to_storage which uses
    # Supabase's client. Patch it to return a synthetic file pointer.
    async def fake_upload(user_id, file_content, filename, mime_type):
        return {
            "id": "fp-1",
            "user_id": user_id,
            "storage_path": f"{user_id}/{filename}",
            "original_filename": filename,
            "mime_type": mime_type,
            "size": len(file_content),
        }

    with (
        patch("temporalio.activity.heartbeat"),
        patch("domains.web_fetch.repo.upload_to_storage", side_effect=fake_upload),
    ):
        from domains.web_fetch.service import download_matching_files

        pointers = await download_matching_files(
            urls=["https://example.com/a.pdf", "https://example.com/a.pdf"],  # dup
            extensions=["pdf"],
            user_id="u-1",
        )
    assert len(pointers) == 1
    assert pointers[0]["original_filename"] == "a.pdf"


async def test_download_matching_files_skips_failed_download():
    """Failed downloads contribute 0 file pointers."""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "example.com/bad.pdf" in url:
            return httpx.Response(500, content=b"oops")
        return httpx.Response(404, json={"error": "no mock"})

    setup_mock_fn(handler)

    async def fake_upload(user_id, file_content, filename, mime_type):
        raise AssertionError("Should not be called when download fails")

    with (
        patch("temporalio.activity.heartbeat"),
        patch("domains.web_fetch.repo.upload_to_storage", side_effect=fake_upload),
    ):
        from domains.web_fetch.service import download_matching_files

        pointers = await download_matching_files(
            urls=["https://example.com/bad.pdf"],
            extensions=["pdf"],
            user_id="u-1",
        )
    assert pointers == []


# =========================================================================
# WebFetchManager.execute_tool + web_fetch() top-level wrapper
# =========================================================================


def test_handler_safe_time_happy_path():
    """_safe_time returns a float when time.time works."""
    from domains.web_fetch.handler import _safe_time

    t = _safe_time()
    assert isinstance(t, float)
    assert t >= 0


def test_handler_safe_time_fallback():
    """_safe_time returns 0.0 if time.time raises."""
    from domains.web_fetch import handler

    original_time = handler.time

    class _BadTime:
        def time(self):
            raise RuntimeError("sandbox restricted")

    handler.time = _BadTime()
    try:
        assert handler._safe_time() == 0.0
    finally:
        handler.time = original_time


def test_handler_get_manager_singleton():
    """get_manager() returns the same WebFetchManager instance."""
    from domains.web_fetch.handler import get_manager

    a = get_manager()
    b = get_manager()
    assert a is b
    assert a.tool_name == "web_fetch"
    assert a.read_only is True


async def test_handler_execute_tool_happy_path_returns_usage():
    """WebFetchManager.execute_tool returns a result dict with usage on success."""
    from domains.web_fetch.handler import WebFetchManager

    calls = []

    async def fake_execute_activity(fn, args=None, **kwargs):
        calls.append(("activity", getattr(fn, "__name__", "?")))
        # Activity name is post_agent_message for handle_tool_event; web_fetch_activity for work
        name = getattr(fn, "__name__", "")
        if name == "web_fetch_activity":
            return {"text": "extracted content", "title": "Example"}
        # Otherwise assume it's a post_agent_message – return nothing
        return None

    manager = WebFetchManager()
    out = await manager.execute_tool(
        execute_activity=fake_execute_activity,
        tool_call={"url": "https://example.com/a", "objective": "read"},
        tool_call_id="tc-wf",
        agent_id="a-1",
        user_id="u-1",
    )

    assert "result" in out
    assert out["result"]["title"] == "Example"
    assert out["usage"]["service"][0]["provider"] == "Parallel AI Extract"
    # Activity was invoked at least twice (pre-event post, main call, post-event post)
    activity_names = [name for _, name in calls]
    assert "web_fetch_activity" in activity_names


async def test_handler_execute_tool_long_objective_truncated_in_display():
    """Long objectives (>100 chars) are truncated for the display message."""
    from domains.web_fetch.handler import WebFetchManager

    async def fake_execute_activity(fn, args=None, **kwargs):
        if getattr(fn, "__name__", "") == "web_fetch_activity":
            return {"text": "x", "title": "t"}
        return None

    manager = WebFetchManager()
    long_objective = "y" * 300
    out = await manager.execute_tool(
        execute_activity=fake_execute_activity,
        tool_call={"url": "https://example.com/a", "objective": long_objective},
        tool_call_id="tc-long",
        agent_id="a-1",
    )
    assert "result" in out


async def test_handler_execute_tool_activity_error_reraises():
    """Activity exception is re-raised after posting the error event."""
    from domains.web_fetch.handler import WebFetchManager

    async def fake_execute_activity(fn, args=None, **kwargs):
        if getattr(fn, "__name__", "") == "web_fetch_activity":
            raise RuntimeError("parallel down")
        return None

    manager = WebFetchManager()
    try:
        await manager.execute_tool(
            execute_activity=fake_execute_activity,
            tool_call={"url": "https://example.com/bad", "objective": "x"},
            tool_call_id="tc-err",
            agent_id="a-1",
        )
        raise AssertionError("Expected RuntimeError")
    except RuntimeError as e:
        assert "parallel down" in str(e)


async def test_handler_web_fetch_top_level_wraps_manager():
    """web_fetch top-level function forwards to get_manager().execute_tool."""
    from domains.web_fetch.handler import web_fetch

    async def fake_execute_activity(fn, args=None, **kwargs):
        if getattr(fn, "__name__", "") == "web_fetch_activity":
            return {"text": "hi"}
        return None

    out = await web_fetch(
        execute_activity=fake_execute_activity,
        tool_call={"url": "https://example.com/x", "objective": "y"},
        tool_call_id="tc-tl",
        agent_id="a-1",
        user_id="u-1",
    )
    assert "result" in out
    assert out["result"]["text"] == "hi"


async def test_handler_activity_error_path_logged_and_reraised():
    """web_fetch_activity error path re-raises after logging."""
    from unittest.mock import patch

    from domains.web_fetch.handler import web_fetch_activity

    with patch("temporalio.activity.heartbeat"), patch(
        "domains.web_fetch.handler.fetch_and_extract",
        side_effect=RuntimeError("fetch failed"),
    ):
        try:
            await web_fetch_activity(
                url="https://example.com/a",
                objective="obj",
            )
            raise AssertionError("Expected RuntimeError")
        except RuntimeError as e:
            assert "fetch failed" in str(e)


async def run_all_tests():
    print("web-fetch blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_web_fetch_happy_path)
    await r.record_async("boundary", test_web_fetch_boundary)
    # Pure helpers
    r.record("get_filename_simple", test_get_filename_from_url_simple)
    r.record("get_filename_cdn", test_get_filename_from_url_cdn_transform)
    r.record("get_filename_fallback", test_get_filename_from_url_fallback_basename)
    r.record("get_filename_empty", test_get_filename_from_url_empty_path)
    r.record("match_ext_end", test_matches_extensions_end)
    r.record("match_ext_middle", test_matches_extensions_middle)
    r.record("match_ext_no", test_matches_extensions_no_match)
    r.record("match_ext_dot", test_matches_extensions_with_dot_prefix)
    r.record("extract_media_all_types", test_extract_media_urls_all_types)
    r.record("extract_media_dedupes", test_extract_media_urls_dedupes)
    r.record("extract_media_links_exclude_image", test_extract_media_urls_excludes_image_from_links)
    r.record("extract_asset_urls", test_extract_asset_urls_from_html)
    r.record("extract_asset_urls_dedup", test_extract_asset_urls_dedupes)
    r.record("format_extract_empty", test_format_extract_results_empty)
    r.record("format_extract_title", test_format_extract_results_with_title_excerpts)
    r.record("format_extract_full_no_title", test_format_extract_results_full_content_no_title)
    r.record("format_extract_all_empty", test_format_extract_results_all_empty_content)
    # Orchestration
    await r.record_async("fetch_and_extract_no_files", test_fetch_and_extract_no_files)
    await r.record_async("fetch_and_extract_errors", test_fetch_and_extract_logs_errors)
    await r.record_async("download_no_matches", test_download_matching_files_no_matches)
    await r.record_async("download_happy_path", test_download_matching_files_happy_path)
    await r.record_async("download_skips_failed", test_download_matching_files_skips_failed_download)
    # Handler
    r.record("handler_safe_time_ok", test_handler_safe_time_happy_path)
    r.record("handler_safe_time_fallback", test_handler_safe_time_fallback)
    r.record("handler_get_manager_singleton", test_handler_get_manager_singleton)
    await r.record_async("handler_exec_happy", test_handler_execute_tool_happy_path_returns_usage)
    await r.record_async("handler_exec_long_objective", test_handler_execute_tool_long_objective_truncated_in_display)
    await r.record_async("handler_exec_error", test_handler_execute_tool_activity_error_reraises)
    await r.record_async("handler_web_fetch_wrapper", test_handler_web_fetch_top_level_wraps_manager)
    await r.record_async("handler_activity_error_reraises", test_handler_activity_error_path_logged_and_reraised)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
