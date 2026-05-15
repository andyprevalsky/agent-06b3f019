"""Blackbox tests for web-fetch domain (Firecrawl + Haiku-filter flow)."""

import asyncio
import os
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
    setup_mock({
        "api.firecrawl.dev/v2/scrape": {
            "status": 200,
            "json": _firecrawl_mock_body(markdown=markdown, links=links or []),
        },
    })


async def test_scrape_url_returns_markdown_and_links():
    """fetch_firecrawl_scrape unwraps the Firecrawl `data` envelope."""
    _setup_firecrawl(markdown="**Page**", links=["https://example.com/a.pdf"])
    with patch("temporalio.activity.heartbeat"):
        from domains.web_fetch.service import scrape_url

        out = await scrape_url("https://example.com/article")
    assert out["markdown"] == "**Page**"
    assert out["links"] == ["https://example.com/a.pdf"]
    assert out["metadata"]["title"] == "Example Page"


async def test_firecrawl_boundary_request_shape():
    """The Firecrawl request uses Bearer auth and asks only for markdown+links."""
    import json as _json

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
        },
    )


async def test_firecrawl_activity_raises_on_missing_key():
    """If FIRECRAWL_API_KEY is unset the activity raises a clear RuntimeError."""
    os.environ.pop("FIRECRAWL_API_KEY", None)
    # Force config cache refresh so the empty env var takes effect
    import config as cfg_mod

    cfg_mod._config_cache = None  # type: ignore[attr-defined]
    with patch("temporalio.activity.heartbeat"):
        from tools.web_fetch import web_fetch_activity

        try:
            await web_fetch_activity(url="https://example.com/a")
            raised = False
        except RuntimeError as e:
            raised = "FIRECRAWL_API_KEY" in str(e)
    assert raised, "expected RuntimeError mentioning FIRECRAWL_API_KEY"


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
        p = {"id": f"fp-{len(uploaded)}", "original_filename": filename, "mime_type": mime_type, "size_bytes": len(file_content)}
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
        calls.append({"activity": getattr(fn, "__name__", "?"), "args": args})
        # Activity name is post_agent_message for handle_tool_event; web_fetch_activity for work
        name = getattr(fn, "__name__", "")
        captured.append(name)
        if name == "web_fetch_activity":
            return {"markdown": "page text", "links": ["https://example.com/file.pdf"], "metadata": {}}
        if name == "summarize_and_filter_links":
            return {
                "summary": "Source: example.com\nA summary of the page.",
                "files_to_download": ["https://example.com/file.pdf"],
                "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
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
    )

    # Activities fired in the right order
    assert "web_fetch_activity" in captured
    assert "summarize_and_filter_links" in captured
    assert "web_fetch_download_activity" in captured

    # Result wires the file_pointer through
    assert out["result"]["downloaded_files"][0]["original_filename"] == "file.pdf"
    assert out["result"]["links_downloaded"] == 1
    # Attachment note appended to the summary
    assert "Downloaded 1 file" in out["result"]["content"]
    # Service cost line attributed to Firecrawl
    assert out["usage"]["service"][0]["provider"] == "Firecrawl scrape"

    tool_titles = [
        call["args"][3]["title"]
        for call in calls
        if call["activity"] == "post_agent_message" and call["args"][2] == "TOOL"
    ]
    assert tool_titles[0] == "Fetching https://example.com/a for download the PDF"
    assert tool_titles[-1] == "Fetched https://example.com/a for download the PDF"


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

    # Pure helpers
    r.record("get_filename_simple", test_get_filename_from_url_simple)
    r.record("get_filename_url_encoded", test_get_filename_from_url_url_encoded)
    r.record("get_filename_empty", test_get_filename_from_url_empty_path)

    # Download/attach orchestration
    await r.record_async("download_no_user_returns_empty", test_download_and_attach_no_user_id_returns_empty)
    await r.record_async("download_happy_path", test_download_and_attach_happy_path)
    await r.record_async("download_skips_failed", test_download_and_attach_skips_failed_downloads)

    # Handler
    r.record("handler_safe_time_ok", test_handler_safe_time_happy_path)
    r.record("handler_safe_time_fallback", test_handler_safe_time_fallback)
    r.record("handler_get_manager_singleton", test_handler_get_manager_singleton)
    await r.record_async("handler_exec_happy", test_handler_execute_tool_happy_path)
    await r.record_async("handler_skips_download_when_no_files", test_handler_skips_download_when_haiku_returns_no_files)
    await r.record_async("handler_activity_error_reraises", test_handler_execute_tool_activity_error_reraises)

    # Tool surface
    r.record("prompt_objective_driven", test_web_fetch_prompt_describes_objective_driven_downloads)
    r.record("tool_schema_shrunk", test_web_fetch_tool_schema_has_only_url_and_objective)

    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
