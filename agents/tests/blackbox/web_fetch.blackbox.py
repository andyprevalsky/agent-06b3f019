"""Blackbox tests for web-fetch domain (Firecrawl + Haiku-filter flow)."""

import asyncio
import os
from datetime import timedelta
from unittest.mock import AsyncMock, patch

import httpx

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    setup_mock,
    setup_mock_fn,
    teardown_mock,
)


# =========================================================================
# Firecrawl scrape + activity
# =========================================================================


def _firecrawl_mock_body(markdown: str = "Hello world.", links: list[str] | None = None) -> dict:
    return {
        "success": True,
        "data": {
            "markdown": markdown,
            "links": links or [],
            "metadata": {"title": "Example Page", "url": "https://example.com/article"},
        },
    }


def _setup_firecrawl(markdown: str = "Page body.", links: list[str] | None = None) -> None:
    os.environ["FIRECRAWL_API_KEY"] = "test-key"
    setup_mock(
        {
            "api.firecrawl.dev/v2/scrape": {
                "status": 200,
                "json": _firecrawl_mock_body(markdown=markdown, links=links or []),
            },
        }
    )


def _parallel_mock_body(
    full_content: str | None = "Full page body.",
    excerpts: list[str] | None = None,
    errors: list[dict] | None = None,
) -> dict:
    result = {
        "url": "https://example.com/article",
        "title": "Parallel Page",
        "publish_date": "2026-06-26",
        "excerpts": excerpts if excerpts is not None else ["Focused excerpt."],
    }
    if full_content is not None:
        result["full_content"] = full_content
    return {
        "extract_id": "extract-test",
        "results": [result],
        "errors": errors or [],
        "warnings": None,
        "session_id": "session-test",
    }


async def test_scrape_url_returns_markdown_and_links():
    """fetch_firecrawl_scrape unwraps the Firecrawl `data` envelope."""
    _setup_firecrawl(markdown="**Page**", links=["https://example.com/a.pdf"])
    with patch("temporalio.activity.heartbeat"):
        from domains.web_fetch.service import scrape_url

        out = await scrape_url("https://example.com/article")
    assert out["markdown"] == "**Page**"
    assert out["links"] == ["https://example.com/a.pdf"]
    assert out["metadata"]["title"] == "Example Page"
    assert out["metadata"]["provider"] == "Firecrawl scrape"


async def test_firecrawl_boundary_request_shape():
    """The Firecrawl request uses Bearer auth and asks only for markdown+links."""
    _setup_firecrawl()
    with patch("temporalio.activity.heartbeat"):
        from tools.web_fetch import web_fetch_activity

        await web_fetch_activity(url="https://example.com/a")

    # Authorization header is redacted in capture; presence is enough.
    assert_captured_call(
        url_contains="api.firecrawl.dev/v2/scrape",
        method="POST",
        header_present="Authorization",
        body_contains={
            "url": "https://example.com/a",
            "formats": ["markdown", "links"],
            "onlyMainContent": True,
            "maxAge": 300_000,
        },
    )


async def test_firecrawl_activity_raises_on_missing_key():
    """If provider keys are unset the activity raises a clear non-retryable error."""
    from temporalio.exceptions import ApplicationError

    os.environ.pop("FIRECRAWL_API_KEY", None)
    os.environ.pop("PARRALLEL_API_KEY", None)
    os.environ.pop("PARALLEL_API_KEY", None)
    # Force config cache refresh so the empty env var takes effect
    import config as cfg_mod

    if hasattr(cfg_mod, "_config_cache"):
        cfg_mod._config_cache = None  # type: ignore[attr-defined]
    with patch("temporalio.activity.heartbeat"):
        from tools.web_fetch import web_fetch_activity

        try:
            await web_fetch_activity(url="https://example.com/a")
            error = None
        except ApplicationError as e:
            error = e
    assert error is not None
    assert error.non_retryable is True
    assert "FIRECRAWL_API_KEY" in str(error)


async def test_firecrawl_403_falls_back_to_parallel_extract():
    """A Firecrawl unsupported-site 403 falls back to Parallel Extract and normalizes shape."""
    os.environ["FIRECRAWL_API_KEY"] = "test-firecrawl-key"
    os.environ["PARRALLEL_API_KEY"] = "test-parallel-key"
    os.environ.pop("PARALLEL_API_KEY", None)
    setup_mock(
        {
            "api.firecrawl.dev/v2/scrape": {
                "status": 403,
                "json": {"success": False, "error": "unsupported site"},
            },
            "api.parallel.ai/v1/extract": {
                "status": 200,
                "json": _parallel_mock_body(
                    full_content=("# Profile\n[Deck](https://example.com/deck.pdf)\nBare https://example.com/data.csv.")
                ),
            },
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from domains.web_fetch.service import scrape_url

        out = await scrape_url("https://www.instagram.com/example")

    assert out["markdown"].startswith("# Profile")
    assert out["links"] == ["https://example.com/deck.pdf", "https://example.com/data.csv"]
    assert out["metadata"]["provider"] == "Parallel Extract"
    assert out["metadata"]["title"] == "Parallel Page"
    assert out["metadata"]["extract_id"] == "extract-test"

    assert_captured_call(index=0, url_contains="api.firecrawl.dev/v2/scrape", method="POST")
    assert_captured_call(
        index=1,
        url_contains="api.parallel.ai/v1/extract",
        method="POST",
        header_present="x-api-key",
        body_contains={
            "urls": ["https://www.instagram.com/example"],
            "advanced_settings": {"full_content": True},
        },
    )


async def test_firecrawl_timeout_falls_back_to_parallel_extract():
    """A Firecrawl transport timeout falls back to Parallel Extract."""
    os.environ["FIRECRAWL_API_KEY"] = "test-firecrawl-key"
    os.environ["PARRALLEL_API_KEY"] = "test-parallel-key"

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "api.firecrawl.dev/v2/scrape" in url:
            raise httpx.TimeoutException("firecrawl timed out", request=request)
        if "api.parallel.ai/v1/extract" in url:
            return httpx.Response(200, json=_parallel_mock_body(full_content="Recovered content."))
        return httpx.Response(404, json={"error": f"No mock for {url}"})

    setup_mock_fn(handler)

    with patch("temporalio.activity.heartbeat"):
        from domains.web_fetch.service import scrape_url

        out = await scrape_url("https://example.com/slow")

    assert out["markdown"] == "Recovered content."
    assert out["metadata"]["provider"] == "Parallel Extract"


async def test_firecrawl_empty_markdown_falls_back_to_parallel_extract():
    """A malformed Firecrawl success with no markdown falls back to Parallel Extract."""
    os.environ["FIRECRAWL_API_KEY"] = "test-firecrawl-key"
    os.environ["PARRALLEL_API_KEY"] = "test-parallel-key"
    setup_mock(
        {
            "api.firecrawl.dev/v2/scrape": {
                "status": 200,
                "json": _firecrawl_mock_body(markdown="", links=["https://example.com/firecrawl-only.pdf"]),
            },
            "api.parallel.ai/v1/extract": {
                "status": 200,
                "json": _parallel_mock_body(full_content="Parallel recovered markdown."),
            },
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from domains.web_fetch.service import scrape_url

        out = await scrape_url("https://example.com/malformed")

    assert out["markdown"] == "Parallel recovered markdown."
    assert out["metadata"]["provider"] == "Parallel Extract"


async def test_parallel_extract_prefers_full_content_over_excerpts():
    """Parallel normalization uses full_content before excerpts."""
    os.environ["FIRECRAWL_API_KEY"] = "test-firecrawl-key"
    os.environ["PARRALLEL_API_KEY"] = "test-parallel-key"
    setup_mock(
        {
            "api.firecrawl.dev/v2/scrape": {"status": 500, "json": {"error": "firecrawl down"}},
            "api.parallel.ai/v1/extract": {
                "status": 200,
                "json": _parallel_mock_body(full_content="Full content.", excerpts=["Excerpt content."]),
            },
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from domains.web_fetch.service import scrape_url

        out = await scrape_url("https://example.com/a")

    assert out["markdown"] == "Full content."


async def test_parallel_extract_uses_joined_excerpts_when_full_content_missing():
    """Parallel normalization still returns markdown when only excerpts are present."""
    os.environ["FIRECRAWL_API_KEY"] = "test-firecrawl-key"
    os.environ["PARRALLEL_API_KEY"] = "test-parallel-key"
    setup_mock(
        {
            "api.firecrawl.dev/v2/scrape": {"status": 500, "json": {"error": "firecrawl down"}},
            "api.parallel.ai/v1/extract": {
                "status": 200,
                "json": _parallel_mock_body(full_content=None, excerpts=["Excerpt one.", "Excerpt two."]),
            },
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from domains.web_fetch.service import scrape_url

        out = await scrape_url("https://example.com/a")

    assert out["markdown"] == "Excerpt one.\n\nExcerpt two."


async def test_both_fetch_providers_failing_raises_combined_error():
    """If Firecrawl and Parallel both fail, the raised error names both providers."""
    os.environ["FIRECRAWL_API_KEY"] = "test-firecrawl-key"
    os.environ["PARRALLEL_API_KEY"] = "test-parallel-key"
    setup_mock(
        {
            "api.firecrawl.dev/v2/scrape": {"status": 403, "json": {"error": "unsupported"}},
            "api.parallel.ai/v1/extract": {"status": 422, "json": {"errors": [{"content": "bad url"}]}},
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from domains.web_fetch.service import WebFetchProvidersFailed, scrape_url

        try:
            await scrape_url("https://example.com/bad")
            error = None
        except WebFetchProvidersFailed as e:
            error = e

    assert error is not None
    assert "Firecrawl" in str(error)
    assert "Parallel Extract" in str(error)
    assert error.retryable is False


async def test_retryable_provider_failure_remains_retryable():
    """If either provider failure is retryable by provider docs, Temporal may retry the activity."""
    os.environ["FIRECRAWL_API_KEY"] = "test-firecrawl-key"
    os.environ["PARRALLEL_API_KEY"] = "test-parallel-key"
    setup_mock(
        {
            "api.firecrawl.dev/v2/scrape": {"status": 403, "json": {"error": "unsupported"}},
            "api.parallel.ai/v1/extract": {"status": 500, "json": {"error": "temporary upstream failure"}},
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from domains.web_fetch.service import WebFetchProvidersFailed, scrape_url

        try:
            await scrape_url("https://example.com/temporary")
            error = None
        except WebFetchProvidersFailed as e:
            error = e

    assert error is not None
    assert error.retryable is True


async def test_web_fetch_activity_marks_deterministic_provider_failures_non_retryable():
    """The activity converts deterministic two-provider failures into a non-retryable Temporal error."""
    from temporalio.exceptions import ApplicationError

    os.environ["FIRECRAWL_API_KEY"] = "test-firecrawl-key"
    os.environ["PARRALLEL_API_KEY"] = "test-parallel-key"
    setup_mock(
        {
            "api.firecrawl.dev/v2/scrape": {"status": 403, "json": {"error": "unsupported"}},
            "api.parallel.ai/v1/extract": {"status": 422, "json": {"errors": [{"content": "bad url"}]}},
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from tools.web_fetch import web_fetch_activity

        try:
            await web_fetch_activity(url="https://example.com/bad")
            error = None
        except ApplicationError as e:
            error = e

    assert error is not None
    assert error.non_retryable is True
    assert error.type == "WebFetchProvidersFailed"


# =========================================================================
# URL validation at the tool boundary
#
# Regression: prod agent e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc (2026-08-03).
# The explore agent read grep result *paths* out of its own tool output and
# passed them to web_fetch as a "URL". `network/+19729777432.contact` is
# byte-for-byte what back-end/src/domains/data/format.ts:90 emits, and
# `https://internal/...` is a fabricated host. Nothing validated them, so each
# one burned a Firecrawl call plus a Parallel Extract fallback.
# =========================================================================

# Non-fetchable strings that must never reach a paid provider.
NON_FETCHABLE_URLS = [
    "network/+19729777432.contact",  # grep match path (format.ts:90)
    "messages/+19729777432.thread",  # grep match path (format.ts:60)
    "https://internal/messages/+19729777432.thread",  # fabricated host, no dot
    "",  # missing url arg
    "   ",  # whitespace only
    "ftp://x.com/a",  # non-http scheme
    "file:///etc/passwd",
    "javascript:alert(1)",
    "example.com/a",  # scheme-less
    "https:///no-host",  # empty host
]


async def test_scrape_url_rejects_non_fetchable_urls_before_any_provider_call():
    """Non-http / hostless URLs raise non-retryably with zero provider calls."""
    from temporalio.exceptions import ApplicationError

    from domains.web_fetch import service as web_fetch_service

    firecrawl = AsyncMock(return_value={"markdown": "should not happen", "links": [], "metadata": {}})
    parallel = AsyncMock(return_value={"markdown": "should not happen", "links": [], "metadata": {}})

    with (
        patch.object(web_fetch_service, "fetch_firecrawl_scrape", firecrawl),
        patch.object(web_fetch_service, "fetch_parallel_extract", parallel),
        patch("temporalio.activity.heartbeat"),
    ):
        for candidate in NON_FETCHABLE_URLS:
            try:
                await web_fetch_service.scrape_url(candidate)
            except ApplicationError as e:
                assert e.non_retryable is True, f"{candidate!r} must be non-retryable"
                assert e.type == "WebFetchProvidersFailed", f"{candidate!r} -> {e.type}"
            else:
                raise AssertionError(f"{candidate!r} was not rejected")

    assert firecrawl.call_count == 0, f"Firecrawl called {firecrawl.call_count}x for non-fetchable URLs"
    assert parallel.call_count == 0, f"Parallel Extract called {parallel.call_count}x for non-fetchable URLs"


async def test_scrape_url_still_reaches_provider_for_valid_https_url():
    """Validation must not over-reject: a real https URL still hits Firecrawl exactly once."""
    from domains.web_fetch import service as web_fetch_service

    firecrawl = AsyncMock(return_value={"markdown": "real page", "links": [], "metadata": {}})
    parallel = AsyncMock(return_value={"markdown": "fallback", "links": [], "metadata": {}})

    with (
        patch.object(web_fetch_service, "fetch_firecrawl_scrape", firecrawl),
        patch.object(web_fetch_service, "fetch_parallel_extract", parallel),
        patch("temporalio.activity.heartbeat"),
    ):
        out = await web_fetch_service.scrape_url("https://example.com/a")

    assert out["markdown"] == "real page"
    assert firecrawl.call_count == 1
    assert parallel.call_count == 0
    assert firecrawl.call_args.args[0] == "https://example.com/a"


async def test_scrape_url_accepts_localhost_and_http():
    """localhost (no dot) and plain http are legitimately fetchable."""
    from domains.web_fetch import service as web_fetch_service

    firecrawl = AsyncMock(return_value={"markdown": "local page", "links": [], "metadata": {}})

    with (
        patch.object(web_fetch_service, "fetch_firecrawl_scrape", firecrawl),
        patch("temporalio.activity.heartbeat"),
    ):
        await web_fetch_service.scrape_url("http://localhost:3001/health")
        await web_fetch_service.scrape_url("http://example.co.uk/a?b=1")

    assert firecrawl.call_count == 2


async def test_handler_rejects_non_fetchable_url_before_scheduling_any_activity():
    """The tool boundary fails loudly without scheduling the scrape/Haiku/download activities."""
    from temporalio.exceptions import ApplicationError

    from domains.web_fetch.handler import WebFetchManager

    scheduled: list[str] = []

    async def fake_execute_activity(fn, args=None, **kwargs):
        scheduled.append(getattr(fn, "__name__", "?"))
        return None

    manager = WebFetchManager()
    try:
        await manager.execute_tool(
            execute_activity=fake_execute_activity,
            tool_call={"url": "network/+19729777432.contact", "objective": "read the contact"},
            tool_call_id="tc-bad-url",
            agent_id="a-bad-url",
            user_id="u-1",
        )
    except ApplicationError as e:
        assert e.non_retryable is True
        assert e.type == "WebFetchProvidersFailed"
    else:
        raise AssertionError("handler accepted a non-fetchable URL")

    assert "web_fetch_activity" not in scheduled, scheduled
    assert "summarize_and_filter_links" not in scheduled, scheduled
    assert "web_fetch_download_activity" not in scheduled, scheduled


# =========================================================================
# In-activity retry shim honours non_retryable
#
# Regression: same prod agent. web_fetch_activity correctly raised
# ApplicationError(non_retryable=True), but every sub-agent tool call routes
# through loop.activity_helper.call_temporal_activity_from_activity, whose
# blanket `except Exception` retried it anyway — doubling the cost of every
# deterministic sub-agent tool failure.
# =========================================================================


async def test_non_retryable_application_error_runs_exactly_once():
    """ApplicationError(non_retryable=True) is re-raised immediately, not retried."""
    from temporalio.common import RetryPolicy
    from temporalio.exceptions import ApplicationError

    from loop.activity_helper import call_temporal_activity_from_activity

    attempts = 0

    async def deterministically_failing_activity():
        nonlocal attempts
        attempts += 1
        raise ApplicationError(
            "web_fetch failed with Firecrawl and Parallel Extract.",
            type="WebFetchProvidersFailed",
            non_retryable=True,
        )

    try:
        await call_temporal_activity_from_activity(
            deterministically_failing_activity,
            args=[],
            start_to_close_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(maximum_attempts=2, initial_interval=timedelta(seconds=0)),
        )
    except ApplicationError as e:
        assert e.type == "WebFetchProvidersFailed"
    else:
        raise AssertionError("expected the non-retryable error to propagate")

    assert attempts == 1, f"non_retryable=True was retried: ran {attempts}x"


async def test_retry_policy_non_retryable_error_types_run_exactly_once():
    """A type listed in retry_policy.non_retryable_error_types is not retried."""
    from temporalio.common import RetryPolicy
    from temporalio.exceptions import ApplicationError

    from loop.activity_helper import call_temporal_activity_from_activity

    attempts = 0

    async def failing_activity():
        nonlocal attempts
        attempts += 1
        raise ApplicationError("deterministic", type="WebFetchProvidersFailed")

    try:
        await call_temporal_activity_from_activity(
            failing_activity,
            args=[],
            start_to_close_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(
                maximum_attempts=3,
                initial_interval=timedelta(seconds=0),
                non_retryable_error_types=["WebFetchProvidersFailed"],
            ),
        )
    except ApplicationError:
        pass
    else:
        raise AssertionError("expected the non-retryable error to propagate")

    assert attempts == 1, f"non_retryable_error_types was ignored: ran {attempts}x"


async def test_retryable_error_still_retries_to_maximum_attempts():
    """Genuinely retryable failures keep the existing numeric retry behavior."""
    from temporalio.common import RetryPolicy

    from loop.activity_helper import call_temporal_activity_from_activity

    attempts = 0

    async def flaky_activity():
        nonlocal attempts
        attempts += 1
        raise RuntimeError("transient upstream 503")

    try:
        await call_temporal_activity_from_activity(
            flaky_activity,
            args=[],
            start_to_close_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=0)),
        )
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected the retryable error to propagate after exhaustion")

    assert attempts == 3, f"retryable error should run maximum_attempts times, ran {attempts}x"


async def test_retryable_application_error_still_retries():
    """An ApplicationError with non_retryable=False keeps retrying."""
    from temporalio.common import RetryPolicy
    from temporalio.exceptions import ApplicationError

    from loop.activity_helper import call_temporal_activity_from_activity

    attempts = 0

    async def flaky_activity():
        nonlocal attempts
        attempts += 1
        if attempts < 2:
            raise ApplicationError("rate limited", type="ProviderRateLimited")
        return "recovered"

    result = await call_temporal_activity_from_activity(
        flaky_activity,
        args=[],
        start_to_close_timeout=timedelta(seconds=5),
        retry_policy=RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=0)),
    )

    assert result == "recovered"
    assert attempts == 2


# =========================================================================
# get_filename_from_url (pure helper)
# =========================================================================


def test_get_filename_from_url_simple():
    from domains.web_fetch.service import get_filename_from_url

    assert get_filename_from_url("https://example.com/a.pdf") == "a.pdf"


def test_get_filename_from_url_url_encoded():
    """%20 in the filename is decoded."""
    from domains.web_fetch.service import get_filename_from_url

    assert get_filename_from_url("https://example.com/path/My%20Doc.pdf") == "My Doc.pdf"


def test_get_filename_from_url_empty_path():
    from domains.web_fetch.service import get_filename_from_url

    assert get_filename_from_url("https://example.com") == "download"


# =========================================================================
# download_and_attach (orchestration)
# =========================================================================


async def test_download_and_attach_no_user_id_returns_empty():
    from domains.web_fetch.service import download_and_attach

    out = await download_and_attach(file_urls=["https://example.com/a.pdf"], user_id=None)
    assert out == []


async def test_download_and_attach_happy_path():
    """Downloads bytes, uploads to storage, returns one file_pointer per URL."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"PDF-BYTES")

    setup_mock_fn(handler)

    uploaded: list[dict] = []

    async def fake_upload(user_id, file_content, filename, mime_type):
        pointer = {
            "id": f"fp-{len(uploaded)}",
            "original_filename": filename,
            "mime_type": mime_type,
            "size_bytes": len(file_content),
        }
        uploaded.append(pointer)
        return pointer

    with (
        patch("temporalio.activity.heartbeat"),
        patch("domains.web_fetch.repo.upload_to_storage", side_effect=fake_upload),
    ):
        from domains.web_fetch.service import download_and_attach

        pointers = await download_and_attach(
            file_urls=["https://example.com/a.pdf", "https://example.com/b.pdf"],
            user_id="u-1",
        )
    assert len(pointers) == 2
    assert pointers[0]["original_filename"] == "a.pdf"
    assert pointers[0]["mime_type"] == "application/pdf"
    assert pointers[1]["original_filename"] == "b.pdf"


async def test_download_and_attach_skips_failed_downloads():
    """A 5xx on one URL silently skips it; other URLs still upload."""

    def handler(request: httpx.Request) -> httpx.Response:
        if "bad" in str(request.url):
            return httpx.Response(500, content=b"oops")
        return httpx.Response(200, content=b"GOOD")

    setup_mock_fn(handler)

    uploaded: list[dict] = []

    async def fake_upload(user_id, file_content, filename, mime_type):
        p = {
            "id": f"fp-{len(uploaded)}",
            "original_filename": filename,
            "mime_type": mime_type,
            "size_bytes": len(file_content),
        }
        uploaded.append(p)
        return p

    with (
        patch("temporalio.activity.heartbeat"),
        patch("domains.web_fetch.repo.upload_to_storage", side_effect=fake_upload),
    ):
        from domains.web_fetch.service import download_and_attach

        pointers = await download_and_attach(
            file_urls=["https://example.com/bad.pdf", "https://example.com/good.pdf"],
            user_id="u-1",
        )
    names = [p["original_filename"] for p in pointers]
    assert "good.pdf" in names
    assert "bad.pdf" not in names


async def test_download_and_attach_demo_cache_hit_skips_external_download():
    """Fast Mode reuses cached file bytes instead of hitting the original file URL."""
    uploaded: list[dict] = []

    async def fake_upload(user_id, file_content, filename, mime_type):
        pointer = {
            "id": f"fp-{len(uploaded)}",
            "original_filename": filename,
            "mime_type": mime_type,
            "size_bytes": len(file_content),
        }
        uploaded.append(pointer)
        return pointer

    with (
        patch("temporalio.activity.heartbeat"),
        patch(
            "providers.demo_cache.client.cache_get_record",
            new=AsyncMock(return_value={"hit": True, "value": {"size_bytes": 12}, "blobPath": "cache/file"}),
        ) as get_record,
        patch("providers.demo_cache.blob_store.download_blob", new=AsyncMock(return_value=b"CACHED-BYTES")),
        patch(
            "domains.web_fetch.service.download_files_batch",
            new=AsyncMock(side_effect=AssertionError("external download should be skipped")),
        ),
        patch("domains.web_fetch.repo.upload_to_storage", side_effect=fake_upload),
    ):
        from domains.web_fetch.service import download_and_attach

        pointers = await download_and_attach(
            file_urls=["https://example.com/a.pdf"],
            user_id="u-1",
            fast_mode_cache_enabled=True,
            fast_mode_goal="root goal",
        )

    assert len(pointers) == 1
    assert pointers[0]["original_filename"] == "a.pdf"
    assert uploaded[0]["size_bytes"] == len(b"CACHED-BYTES")
    get_record.assert_awaited_once()


async def test_download_and_attach_demo_cache_miss_stores_downloaded_bytes():
    """Fast Mode stores downloaded file bytes in blob storage and writes a file cache row."""

    async def fake_download(urls):
        return {url: b"LIVE-BYTES" for url in urls}

    async def fake_upload(user_id, file_content, filename, mime_type):
        return {
            "id": "fp-live",
            "original_filename": filename,
            "mime_type": mime_type,
            "size_bytes": len(file_content),
        }

    cache_set = AsyncMock(return_value=True)

    with (
        patch("temporalio.activity.heartbeat"),
        patch(
            "providers.demo_cache.client.cache_get_record",
            new=AsyncMock(return_value={"hit": False, "value": None, "blobPath": None}),
        ),
        patch("providers.demo_cache.client.cache_set", new=cache_set),
        patch("providers.demo_cache.blob_store.upload_blob", new=AsyncMock(return_value=True)) as upload_blob,
        patch("domains.web_fetch.service.download_files_batch", new=AsyncMock(side_effect=fake_download)),
        patch("domains.web_fetch.repo.upload_to_storage", side_effect=fake_upload),
    ):
        from domains.web_fetch.service import download_and_attach

        pointers = await download_and_attach(
            file_urls=["https://example.com/a.pdf"],
            user_id="u-1",
            fast_mode_cache_enabled=True,
            fast_mode_goal="root goal",
        )

    assert pointers[0]["size_bytes"] == len(b"LIVE-BYTES")
    upload_blob.assert_awaited_once()
    cache_set.assert_awaited_once()
    assert cache_set.await_args.args[1] == "file"
    assert cache_set.await_args.kwargs["blob_path"].startswith("fast-mode-cache/")


# =========================================================================
# Handler: full happy path through the 3 activities
# =========================================================================


def test_handler_safe_time_happy_path():
    from domains.web_fetch.handler import _safe_time

    t = _safe_time()
    assert isinstance(t, float)
    assert t >= 0


def test_handler_safe_time_fallback():
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
    from domains.web_fetch.handler import get_manager

    a = get_manager()
    b = get_manager()
    assert a is b
    assert a.tool_name == "web_fetch"
    assert a.read_only is True


async def test_handler_execute_tool_happy_path():
    """Manager dispatches scrape → Haiku → download in order and returns the assembled result."""
    from domains.web_fetch.handler import WebFetchManager

    captured = []
    calls = []

    async def fake_execute_activity(fn, args=None, **kwargs):
        calls.append({"activity": getattr(fn, "__name__", "?"), "args": args, "kwargs": kwargs})
        # Activity name is post_agent_message for handle_tool_event; web_fetch_activity for work
        name = getattr(fn, "__name__", "")
        captured.append(name)
        if name == "web_fetch_activity":
            return {"markdown": "page text", "links": ["https://example.com/file.pdf"], "metadata": {}}
        if name == "summarize_and_filter_links":
            return {
                "summary": "Source: example.com\nA summary of the page.",
                "files_to_download": ["https://example.com/file.pdf"],
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 50,
                    "total_tokens": 150,
                    "cache_sequence_id": "agent:a-1:tool:tc-wf:call:summarize_web_fetch",
                },
                "summarized": True,
            }
        if name == "web_fetch_download_activity":
            return [{"id": "fp-1", "original_filename": "file.pdf", "mime_type": "application/pdf", "size_bytes": 12}]
        # post_agent_message and any other no-op activities
        return None

    manager = WebFetchManager()
    out = await manager.execute_tool(
        execute_activity=fake_execute_activity,
        tool_call={"url": "https://example.com/a", "objective": "download the PDF"},
        tool_call_id="tc-wf",
        agent_id="a-1",
        user_id="u-1",
        compute_token_lineage_key="agent:lineage-1",
        fast_mode_cache_enabled=True,
        fast_mode_goal="root goal",
    )

    # Activities fired in the right order
    assert "web_fetch_activity" in captured
    assert "summarize_and_filter_links" in captured
    assert "web_fetch_download_activity" in captured
    scrape_call = next(call for call in calls if call["activity"] == "web_fetch_activity")
    assert scrape_call["kwargs"]["retry_policy"].maximum_attempts == 2
    summary_call = next(call for call in calls if call["activity"] == "summarize_and_filter_links")
    assert summary_call["args"][-3] == "agent:a-1:tool:tc-wf:call:summarize_web_fetch"
    assert summary_call["args"][-2] == "agent:lineage-1"
    assert summary_call["args"][-1] == {}
    # The activity wrapper appends its task ID after these explicit arguments.
    # Keep the page facts bound to page_metadata, not session_id.
    import inspect
    from helpers.summarize import summarize_and_filter_links
    bound = inspect.signature(summarize_and_filter_links).bind(*summary_call["args"], "task-1")
    assert bound.arguments["page_metadata"] == {}
    assert bound.arguments["session_id"] == "task-1"
    download_call = next(call for call in calls if call["activity"] == "web_fetch_download_activity")
    assert download_call["args"] == [
        ["https://example.com/file.pdf"],
        "u-1",
        True,
        "root goal",
        False,
        None,
        None,
        "a-1",
    ]

    # Result wires the file_pointer through
    assert out["result"]["downloaded_files"][0]["original_filename"] == "file.pdf"
    assert out["result"]["links_downloaded"] == 1
    # Attachment note appended to the summary
    assert "Downloaded 1 file" in out["result"]["content"]
    # Service cost line attributed to Firecrawl
    assert out["usage"]["service"][0]["provider"] == "Firecrawl scrape"
    assert out["usage"]["llm"][0]["cache_sequence_id"] == ("agent:a-1:tool:tc-wf:call:summarize_web_fetch")

    tool_titles = [
        call["args"][3]["title"]
        for call in calls
        if call["activity"] == "post_agent_message" and call["args"][2] == "TOOL"
    ]
    assert tool_titles[0] == "Fetching https://example.com/a for download the PDF"
    assert tool_titles[-1] == "Fetched https://example.com/a for download the PDF"


async def test_handler_forwards_page_declared_metadata_to_summarizer():
    """RCA 2026-10-26 background-agent-message-smoke timeout.

    The RFC Editor page for RFC 9110 declares its publication date only in
    ``<meta name="citation_publication_date">``; its main-content markdown has
    no "June 2022". Firecrawl returns that tag in ``metadata``, but web_fetch
    dropped it before the summarizer, so the explore agent reported the month
    as unverifiable and the root spent a second explore run re-fetching it.
    """
    from domains.web_fetch.handler import WebFetchManager

    page_metadata = {
        "title": "RFC 9110: HTTP Semantics | RFC Editor",
        "citation_title": ["HTTP Semantics", "HTTP Semantics"],
        "citation_publication_date": ["2022/06/06", "2022/06/06"],
        "provider": "Firecrawl scrape",
        "scrapeId": "scrape-1",
    }
    calls = []

    async def fake_execute_activity(fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "")
        calls.append({"activity": name, "args": args})
        if name == "web_fetch_activity":
            return {"markdown": "# RFC9110: HTTP Semantics\nInternet Standard", "links": [], "metadata": page_metadata}
        if name == "summarize_and_filter_links":
            return {"summary": "RFC 9110, published June 2022.", "files_to_download": [], "usage": {}}
        return None

    out = await WebFetchManager().execute_tool(
        execute_activity=fake_execute_activity,
        tool_call={"url": "https://www.rfc-editor.org/rfc/rfc9110", "objective": "publication month and year"},
        tool_call_id="tc-meta",
        agent_id="a-1",
        user_id="u-1",
    )

    summary_call = next(call for call in calls if call["activity"] == "summarize_and_filter_links")
    # Only the allowlisted, bounded subset crosses the activity boundary.
    assert summary_call["args"][-1] == {
        "title": "RFC 9110: HTTP Semantics | RFC Editor",
        "citation_publication_date": "2022/06/06",
    }
    assert out["result"]["content"].startswith("RFC 9110, published June 2022.")


async def test_handler_passes_no_parallel_extract_ids_to_summarizer():
    """Review finding 2026-10-26: Parallel Extract fallback IDs stay out of the summarizer.

    ``extract_parallel`` returns extract_id, session_id, warnings and errors
    beside the page's title and publish_date; only those page facts may reach
    the summarize activity's arguments.
    """
    from domains.web_fetch.handler import WebFetchManager

    calls = []

    async def fake_execute_activity(fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "")
        calls.append({"activity": name, "args": args})
        if name == "web_fetch_activity":
            return {
                "markdown": "# RFC9110: HTTP Semantics\nInternet Standard",
                "links": [],
                "metadata": {
                    "provider": "Parallel Extract",
                    "title": "RFC 9110: HTTP Semantics",
                    "publish_date": "2022-06-06",
                    "url": "https://www.rfc-editor.org/rfc/rfc9110",
                    "extract_id": "extract_8c1f2b",
                    "session_id": "session_93ad7e",
                    "warnings": ["full_content truncated"],
                    "errors": [],
                },
            }
        if name == "summarize_and_filter_links":
            return {"summary": "RFC 9110, published June 2022.", "files_to_download": [], "usage": {}}
        return None

    await WebFetchManager().execute_tool(
        execute_activity=fake_execute_activity,
        tool_call={"url": "https://www.rfc-editor.org/rfc/rfc9110", "objective": "publication month and year"},
        tool_call_id="tc-parallel",
        agent_id="a-1",
        user_id="u-1",
    )

    summary_call = next(call for call in calls if call["activity"] == "summarize_and_filter_links")
    assert summary_call["args"][-1] == {"title": "RFC 9110: HTTP Semantics", "publish_date": "2022-06-06"}
    assert "extract_8c1f2b" not in repr(summary_call["args"])
    assert "session_93ad7e" not in repr(summary_call["args"])


async def test_handler_simulator_appends_mode_only_to_boundary_activities():
    """Simulated agents carry mode/identity; real agents keep world-model args empty.

    Both shapes carry the trailing cache-write agent id so the Fast Mode write
    gate can resolve the agent's tree root (a child under a frozen DEMO root
    never writes) without changing world-model routing.
    """
    from domains.web_fetch.handler import WebFetchManager

    calls = []

    async def fake_execute_activity(fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "")
        calls.append({"activity": name, "args": args})
        if name == "web_fetch_activity":
            return {"markdown": "page text", "links": ["https://example.com/file.pdf"], "metadata": {}}
        if name == "summarize_and_filter_links":
            return {
                "summary": "Summary.",
                "files_to_download": ["https://example.com/file.pdf"],
                "usage": {},
                "summarized": True,
            }
        if name == "web_fetch_download_activity":
            return []
        return None

    await WebFetchManager().execute_tool(
        execute_activity=fake_execute_activity,
        tool_call={"url": "https://example.com/a", "objective": "download"},
        tool_call_id="tc-sim",
        agent_id="a-sim",
        user_id="u-1",
        world_model_mode="simulate",
    )

    scrape_call = next(call for call in calls if call["activity"] == "web_fetch_activity")
    assert scrape_call["args"][-3:] == ["a-sim", "simulate", "a-sim"]
    download_call = next(call for call in calls if call["activity"] == "web_fetch_download_activity")
    assert download_call["args"][-3:] == ["a-sim", "simulate", "a-sim"]

    calls.clear()
    await WebFetchManager().execute_tool(
        execute_activity=fake_execute_activity,
        tool_call={"url": "https://example.com/a", "objective": "download"},
        tool_call_id="tc-real",
        agent_id="a-real",
        user_id="u-1",
    )
    scrape_call = next(call for call in calls if call["activity"] == "web_fetch_activity")
    assert scrape_call["args"][-3:] == [None, None, "a-real"]
    download_call = next(call for call in calls if call["activity"] == "web_fetch_download_activity")
    assert download_call["args"][-3:] == [None, None, "a-real"]


async def test_handler_reports_parallel_provider_when_fallback_succeeds():
    """Manager service usage follows scrape metadata when Parallel fallback succeeded."""
    from domains.web_fetch.handler import WebFetchManager

    captured = []

    async def fake_execute_activity(fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "")
        captured.append({"activity": name, "args": args})
        if name == "web_fetch_activity":
            return {
                "markdown": "page text",
                "links": ["https://example.com/a.pdf", "https://example.com/b.pdf"],
                "metadata": {"provider": "Parallel Extract"},
            }
        if name == "summarize_and_filter_links":
            return {"summary": "Summary.", "files_to_download": [], "usage": {}, "summarized": True}
        return None

    manager = WebFetchManager()
    out = await manager.execute_tool(
        execute_activity=fake_execute_activity,
        tool_call={"url": "https://example.com/a", "objective": "summarize"},
        tool_call_id="tc-wf",
        agent_id="a-1",
        user_id="u-1",
    )

    assert out["result"]["links_discovered"] == 2
    assert out["usage"]["service"][0]["provider"] == "Parallel Extract"


async def test_handler_demo_cache_scrape_hit_has_no_service_cost():
    """Fast Mode scrape cache hits should not be billed as live scrape/extract calls."""
    from domains.web_fetch.handler import DEMO_CACHE_HIT_FIELD, WebFetchManager

    calls = []

    async def fake_execute_activity(fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "")
        calls.append({"activity": name, "args": args, "kwargs": kwargs})
        if name == "web_fetch_activity":
            return {
                "markdown": "cached page text",
                "links": [],
                "metadata": {"provider": "Firecrawl scrape"},
                DEMO_CACHE_HIT_FIELD: True,
            }
        if name == "summarize_and_filter_links":
            return {"summary": "Cached summary.", "files_to_download": [], "usage": {}, "summarized": True}
        return None

    manager = WebFetchManager()
    out = await manager.execute_tool(
        execute_activity=fake_execute_activity,
        tool_call={"url": "https://example.com/a", "objective": "summarize"},
        tool_call_id="tc-wf",
        agent_id="a-1",
        user_id="u-1",
    )

    assert out["usage"]["service"] == []
    finished = [call for call in calls if call["activity"] == "post_agent_message"][-1]
    assert "**Cost:** $0.0000" in finished["args"][1]
    assert DEMO_CACHE_HIT_FIELD not in finished["args"][1]


async def test_web_fetch_activity_ignores_unavailable_demo_cache_when_fallback_enabled():
    """Benchmark fallback mode treats unavailable WMH scrape observations as cache misses."""
    from domains.web_fetch.handler import DEMO_CACHE_HIT_FIELD, web_fetch_activity

    cached = {
        "markdown": '{"result_unavailable": true}',
        "metadata": {"result_unavailable": True},
    }
    live = {
        "markdown": "live page",
        "links": [],
        "metadata": {"provider": "Firecrawl scrape"},
    }

    with patch.dict(
        "os.environ",
        {
            "BENCHMARK_WMH_FALLBACK_ON_UNAVAILABLE": "1",
            "BENCHMARK_WORLD_MODEL_MODE": "",
        },
        clear=False,
    ):
        with patch("providers.demo_cache.client.cache_get", new=AsyncMock(return_value=cached)):
            with patch("providers.demo_cache.client.cache_set", new=AsyncMock(return_value=True)) as set_cache:
                with patch("domains.web_fetch.handler.scrape_url", new=AsyncMock(return_value=live)) as scrape:
                    result = await web_fetch_activity(
                        url="https://example.com/a",
                        fast_mode_cache_enabled=True,
                        fast_mode_goal="goal",
                    )

    scrape.assert_awaited_once_with("https://example.com/a")
    assert result == live
    assert DEMO_CACHE_HIT_FIELD not in result
    assert set_cache.await_count == 1


async def test_web_fetch_activity_replays_a_cached_provider_error_without_a_live_scrape():
    """descend-full69 MA: a DEMO row can record a fetch that failed.

    test-mass-agent-run-0's Justin Welsh GP fetches a page whose scrape fails
    (Firecrawl 500 / Parallel connect_error). Failures had no cache shape, so
    every replay scraped live. A ``provider_error`` row replays the same
    non-retryable WebFetchProvidersFailed tool error with no scrape.
    """
    from temporalio.exceptions import ApplicationError

    from domains.web_fetch.handler import CACHED_PROVIDER_ERROR_FIELD, web_fetch_activity

    recorded = "web_fetch failed with Firecrawl and Parallel Extract. Firecrawl error: 500"
    cached = {CACHED_PROVIDER_ERROR_FIELD: recorded}
    with patch("providers.demo_cache.client.cache_get", new=AsyncMock(return_value=cached)):
        with patch("domains.web_fetch.handler.scrape_url", new=AsyncMock()) as scrape:
            try:
                await web_fetch_activity(
                    url="https://example.com/a",
                    fast_mode_cache_enabled=True,
                    fast_mode_goal="goal",
                )
            except ApplicationError as error:
                raised = error
            else:
                raise AssertionError("a recorded provider error must replay as a tool error")

    scrape.assert_not_awaited()
    assert raised.message == recorded
    assert raised.type == "WebFetchProvidersFailed"
    assert raised.non_retryable is True


async def test_handler_skips_download_when_haiku_returns_no_files():
    """When the Haiku filter returns an empty files_to_download list, the download activity is not invoked."""
    from domains.web_fetch.handler import WebFetchManager

    captured = []

    async def fake_execute_activity(fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "")
        captured.append(name)
        if name == "web_fetch_activity":
            return {"markdown": "page", "links": ["https://example.com/file.pdf"], "metadata": {}}
        if name == "summarize_and_filter_links":
            return {"summary": "Summary.", "files_to_download": [], "usage": {}, "summarized": True}
        if name == "web_fetch_download_activity":
            raise AssertionError("Should not be called when no files selected")
        return None

    manager = WebFetchManager()
    out = await manager.execute_tool(
        execute_activity=fake_execute_activity,
        tool_call={"url": "https://example.com/a", "objective": "just summarize"},
        tool_call_id="tc-wf",
        agent_id="a-1",
        user_id="u-1",
    )
    assert "web_fetch_download_activity" not in captured
    assert out["result"]["downloaded_files"] == []
    assert out["result"]["links_downloaded"] == 0
    # No attachment note when no files
    assert "Downloaded" not in out["result"]["content"]


async def test_handler_execute_tool_activity_error_reraises():
    """When the Firecrawl activity raises, the manager re-raises after posting the error event."""
    from domains.web_fetch.handler import WebFetchManager

    calls = []

    async def fake_execute_activity(fn, args=None, **kwargs):
        calls.append({"activity": getattr(fn, "__name__", "?"), "args": args})
        name = getattr(fn, "__name__", "")
        if name == "web_fetch_activity":
            raise RuntimeError("firecrawl 402")
        return None

    manager = WebFetchManager()
    raised = False
    try:
        await manager.execute_tool(
            execute_activity=fake_execute_activity,
            tool_call={"url": "https://example.com/bad", "objective": "x"},
            tool_call_id="tc-wf",
            agent_id="a-1",
            user_id="u-1",
        )
    except RuntimeError as e:
        raised = "firecrawl 402" in str(e)
    assert raised

    tool_titles = [
        call["args"][3]["title"]
        for call in calls
        if call["activity"] == "post_agent_message" and call["args"][2] == "TOOL"
    ]
    assert tool_titles[-1] == "\u274c Web fetch failed for https://example.com/bad for x"


# =========================================================================
# Tool prompt + schema sanity (PROMPT shape changed)
# =========================================================================


def test_web_fetch_prompt_describes_objective_driven_downloads():
    """The tool prompt must instruct the agent to state file needs in the objective."""
    from tools.prompts.web_fetch import PROMPT

    assert "objective" in PROMPT.lower()
    assert "download" in PROMPT.lower()
    # Should NOT advertise the removed parameters
    assert "download_files" not in PROMPT
    assert "excerpts" not in PROMPT.lower()
    assert "full_content" not in PROMPT


def test_web_fetch_tool_schema_has_only_url_and_objective():
    """WebFetchTool drops excerpts/full_content/download_files."""
    from utils.tool_schemas import WebFetchTool

    fields = set(WebFetchTool.model_fields.keys())
    assert fields == {"tool", "url", "objective"}, fields


# =========================================================================
# Runner
# =========================================================================


async def run_all_tests() -> bool:
    print("web-fetch blackbox tests:")
    r = BlackboxResult()

    # Firecrawl scrape
    await r.record_async("scrape_url_returns_md_and_links", test_scrape_url_returns_markdown_and_links)
    await r.record_async("firecrawl_boundary_request_shape", test_firecrawl_boundary_request_shape)
    await r.record_async("firecrawl_activity_raises_no_key", test_firecrawl_activity_raises_on_missing_key)
    await r.record_async("firecrawl_403_falls_back_parallel", test_firecrawl_403_falls_back_to_parallel_extract)
    await r.record_async("firecrawl_timeout_falls_back_parallel", test_firecrawl_timeout_falls_back_to_parallel_extract)
    await r.record_async(
        "firecrawl_empty_markdown_falls_back_parallel",
        test_firecrawl_empty_markdown_falls_back_to_parallel_extract,
    )
    await r.record_async("parallel_prefers_full_content", test_parallel_extract_prefers_full_content_over_excerpts)
    await r.record_async(
        "parallel_uses_joined_excerpts",
        test_parallel_extract_uses_joined_excerpts_when_full_content_missing,
    )
    await r.record_async(
        "both_providers_failing_combined_error", test_both_fetch_providers_failing_raises_combined_error
    )
    await r.record_async(
        "retryable_provider_failure_remains_retryable", test_retryable_provider_failure_remains_retryable
    )
    await r.record_async(
        "activity_deterministic_provider_failures_non_retryable",
        test_web_fetch_activity_marks_deterministic_provider_failures_non_retryable,
    )

    # URL validation at the tool boundary (prod agent e14d5abb regression)
    await r.record_async(
        "scrape_url_rejects_non_fetchable_before_providers",
        test_scrape_url_rejects_non_fetchable_urls_before_any_provider_call,
    )
    await r.record_async(
        "scrape_url_valid_https_still_reaches_provider",
        test_scrape_url_still_reaches_provider_for_valid_https_url,
    )
    await r.record_async("scrape_url_accepts_localhost_and_http", test_scrape_url_accepts_localhost_and_http)
    await r.record_async(
        "handler_rejects_non_fetchable_url_before_activities",
        test_handler_rejects_non_fetchable_url_before_scheduling_any_activity,
    )

    # In-activity retry shim honours non_retryable (prod agent e14d5abb regression)
    await r.record_async(
        "non_retryable_application_error_runs_once", test_non_retryable_application_error_runs_exactly_once
    )
    await r.record_async(
        "non_retryable_error_types_run_once", test_retry_policy_non_retryable_error_types_run_exactly_once
    )
    await r.record_async(
        "retryable_error_retries_to_max_attempts", test_retryable_error_still_retries_to_maximum_attempts
    )
    await r.record_async("retryable_application_error_still_retries", test_retryable_application_error_still_retries)

    # Pure helpers
    r.record("get_filename_simple", test_get_filename_from_url_simple)
    r.record("get_filename_url_encoded", test_get_filename_from_url_url_encoded)
    r.record("get_filename_empty", test_get_filename_from_url_empty_path)

    # Download/attach orchestration
    await r.record_async("download_no_user_returns_empty", test_download_and_attach_no_user_id_returns_empty)
    await r.record_async("download_happy_path", test_download_and_attach_happy_path)
    await r.record_async("download_skips_failed", test_download_and_attach_skips_failed_downloads)
    await r.record_async("download_fast_cache_hit", test_download_and_attach_demo_cache_hit_skips_external_download)
    await r.record_async(
        "download_demo_cache_miss_stores", test_download_and_attach_demo_cache_miss_stores_downloaded_bytes
    )

    # Handler
    r.record("handler_safe_time_ok", test_handler_safe_time_happy_path)
    r.record("handler_safe_time_fallback", test_handler_safe_time_fallback)
    r.record("handler_get_manager_singleton", test_handler_get_manager_singleton)
    await r.record_async("handler_exec_happy", test_handler_execute_tool_happy_path)
    await r.record_async(
        "handler_forwards_page_declared_metadata_to_summarizer",
        test_handler_forwards_page_declared_metadata_to_summarizer,
    )
    await r.record_async(
        "handler_passes_no_parallel_extract_ids_to_summarizer",
        test_handler_passes_no_parallel_extract_ids_to_summarizer,
    )
    await r.record_async(
        "handler_simulator_appends_mode_only_to_boundaries",
        test_handler_simulator_appends_mode_only_to_boundary_activities,
    )
    await r.record_async(
        "handler_reports_parallel_provider", test_handler_reports_parallel_provider_when_fallback_succeeds
    )
    await r.record_async("handler_demo_cache_scrape_no_cost", test_handler_demo_cache_scrape_hit_has_no_service_cost)
    await r.record_async(
        "activity_demo_cache_ignores_unavailable",
        test_web_fetch_activity_ignores_unavailable_demo_cache_when_fallback_enabled,
    )
    await r.record_async(
        "web_fetch_activity_replays_a_cached_provider_error_without_a_live_scrape",
        test_web_fetch_activity_replays_a_cached_provider_error_without_a_live_scrape,
    )
    await r.record_async(
        "handler_skips_download_when_no_files", test_handler_skips_download_when_haiku_returns_no_files
    )
    await r.record_async("handler_activity_error_reraises", test_handler_execute_tool_activity_error_reraises)

    # Tool surface
    r.record("prompt_objective_driven", test_web_fetch_prompt_describes_objective_driven_downloads)
    r.record("tool_schema_shrunk", test_web_fetch_tool_schema_has_only_url_and_objective)

    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
