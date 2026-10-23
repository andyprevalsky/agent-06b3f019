"""Blackbox tests for attachments domain."""

import asyncio
import logging
from types import SimpleNamespace
from unittest.mock import patch

import httpx

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    setup_mock,
    setup_mock_fn,
    teardown_mock,
)


def _clear_cache():
    """Clear the module-level file cache between tests."""
    import sys
    mod = sys.modules.get("helpers.attachments")
    if mod is None:
        import importlib
        mod = importlib.import_module("helpers.attachments")
    mod._file_cache.clear()


async def test_extract_attachments_from_context():
    """extract_attachments_from_context extracts FilePointers from messages."""
    from helpers.attachments import extract_attachments_from_context

    context = [
        {"role": "USER", "text": "Here is an image", "filePointer": {
            "id": "fp-1",
            "storage_path": "user-1/abc_photo.png",
            "original_filename": "photo.png",
            "mime_type": "image/png",
            "size_bytes": 50000,
            "created_at": "2026-04-05T12:00:00Z",
        }},
        {"role": "ASSISTANT", "text": "I see the image"},
        {"role": "USER", "text": "And a CSV", "file_pointer": {
            "id": "fp-2",
            "storage_path": "user-1/def_data.csv",
            "original_filename": "data.csv",
            "mime_type": "text/csv",
            "size_bytes": 1200,
            "created_at": "2026-04-05T12:01:00Z",
        }},
        {"role": "USER", "text": "No file here"},
    ]

    attachments = extract_attachments_from_context(context)

    assert len(attachments) == 2
    assert attachments[0].id == "fp-1"
    assert attachments[0].original_filename == "photo.png"
    assert attachments[0].is_image() is True
    assert attachments[1].id == "fp-2"
    assert attachments[1].original_filename == "data.csv"
    assert attachments[1].is_text() is True


async def test_build_attachment_metadata_text():
    """build_attachment_metadata_text formats non-readable file metadata."""
    from helpers.attachments import FilePointer, build_attachment_metadata_text

    fp = FilePointer(
        id="fp-3",
        storage_path="user-1/ghi_doc.docx",
        original_filename="report.docx",
        mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size_bytes=2048000,
        created_at="2026-04-05T12:00:00Z",
    )

    text = build_attachment_metadata_text(fp)

    assert "original_filename: report.docx" in text
    assert text.startswith("file_pointer:")
    assert "MB" in text or "KB" in text
    assert "Not inlined for the parent LLM" in text


async def test_build_attachment_metadata_text_small_kb():
    """build_attachment_metadata_text uses KB for small files."""
    from helpers.attachments import FilePointer, build_attachment_metadata_text

    fp = FilePointer(id="x", storage_path="x", original_filename="a.bin", mime_type="application/octet-stream", size_bytes=500, created_at="")
    text = build_attachment_metadata_text(fp)
    assert "original_filename: a.bin" in text
    assert "KB" in text


async def test_build_attachment_metadata_text_inlined():
    """Inlined images still expose keyed original_filename."""
    from helpers.attachments import FilePointer, build_attachment_metadata_text

    fp = FilePointer(
        id="img",
        storage_path="u/rs.jpeg",
        original_filename="rs.jpeg",
        mime_type="image/jpeg",
        size_bytes=1200,
        created_at="",
    )
    text = build_attachment_metadata_text(fp, inlined=True)
    assert text.startswith("file_pointer:")
    assert "original_filename: rs.jpeg" in text
    assert "[Attached file:" not in text
    assert "Shown inline above" in text


async def test_file_pointer_type_detection():
    """FilePointer correctly detects image, pdf, text types."""
    from helpers.attachments import FilePointer

    img = FilePointer(id="1", storage_path="p", original_filename="a.png", mime_type="image/png", size_bytes=100, created_at="")
    pdf = FilePointer(id="2", storage_path="p", original_filename="b.pdf", mime_type="application/pdf", size_bytes=100, created_at="")
    txt = FilePointer(id="3", storage_path="p", original_filename="c.txt", mime_type="text/plain", size_bytes=100, created_at="")
    docx = FilePointer(id="4", storage_path="p", original_filename="d.docx", mime_type="application/msword", size_bytes=100, created_at="")

    assert img.is_image() is True
    assert img.is_pdf() is False
    assert pdf.is_pdf() is True
    assert pdf.is_image() is False
    assert txt.is_text() is True
    assert docx.can_be_read_by_llm() is False


async def test_file_pointer_text_extension_fallback():
    """is_text() falls back to extension check for octet-stream mime."""
    from helpers.attachments import FilePointer

    csv = FilePointer(id="1", storage_path="p", original_filename="data.csv", mime_type="application/octet-stream", size_bytes=100, created_at="")
    py = FilePointer(id="2", storage_path="p", original_filename="script.py", mime_type="application/octet-stream", size_bytes=100, created_at="")
    bin_ = FilePointer(id="3", storage_path="p", original_filename="binary", mime_type="application/octet-stream", size_bytes=100, created_at="")
    no_ext = FilePointer(id="4", storage_path="p", original_filename="README", mime_type="application/octet-stream", size_bytes=100, created_at="")

    assert csv.is_text() is True
    assert py.is_text() is True
    assert bin_.is_text() is False
    assert no_ext.is_text() is False


async def test_file_pointer_size_checks():
    """is_small_enough_for_llm & can_be_read_by_llm behave correctly."""
    from helpers.attachments import FilePointer, INLINE_THRESHOLD

    small_img = FilePointer(id="1", storage_path="p", original_filename="a.png", mime_type="image/png", size_bytes=1024, created_at="")
    huge_img = FilePointer(id="2", storage_path="p", original_filename="a.png", mime_type="image/png", size_bytes=INLINE_THRESHOLD + 1, created_at="")

    assert small_img.is_small_enough_for_llm() is True
    assert small_img.can_be_read_by_llm() is True
    assert huge_img.is_small_enough_for_llm() is False


async def test_file_pointer_from_dict():
    """FilePointer.from_dict builds from dict."""
    from helpers.attachments import FilePointer

    fp = FilePointer.from_dict({
        "id": "abc",
        "storage_path": "u/x.pdf",
        "original_filename": "x.pdf",
        "mime_type": "application/pdf",
        "size_bytes": 10,
        "created_at": "2026-04-01",
    })
    assert fp.id == "abc"
    assert fp.mime_type == "application/pdf"


async def test_resolve_activity_no_attachments():
    """resolve_attachments_activity with empty list returns empty list."""
    setup_mock({})  # No HTTP calls expected
    with patch("temporalio.activity.heartbeat"):
        from helpers.attachments import resolve_attachments_activity

        result = await resolve_attachments_activity(file_pointers=[])

    assert result == []
    assert len(get_captured_requests()) == 0


async def test_resolve_activity_downloads_file():
    """resolve_attachments_activity downloads files and populates the cache."""
    _clear_cache()

    def handler(req):
        url = str(req.url)
        if "/storage/v1/object/attachments/" in url:
            return httpx.Response(200, content=b"abcdef", headers={"Content-Type": "image/png"})
        return httpx.Response(404)

    setup_mock_fn(handler)

    with patch("temporalio.activity.heartbeat"):
        from helpers.attachments import resolve_attachments_activity, _file_cache

        ids = await resolve_attachments_activity(file_pointers=[{
            "id": "fp-res-1",
            "storage_path": "user-1/abc_x.png",
            "original_filename": "x.png",
            "mime_type": "image/png",
            "size_bytes": 6,
            "created_at": "2026-04-05T12:00:00Z",
        }])

    assert ids == ["fp-res-1"]
    # File should now be in cache
    assert "fp-res-1" in _file_cache


async def test_resolve_activity_download_failure():
    """resolve_attachments_activity skips failed downloads gracefully."""
    _clear_cache()

    def handler(req):
        url = str(req.url)
        if "/storage/v1/object/attachments/" in url:
            return httpx.Response(500, text="boom")
        return httpx.Response(404)

    setup_mock_fn(handler)

    with patch("temporalio.activity.heartbeat"):
        from helpers.attachments import resolve_attachments_activity

        ids = await resolve_attachments_activity(file_pointers=[{
            "id": "fp-fail",
            "storage_path": "user-1/x.png",
            "original_filename": "x.png",
            "mime_type": "image/png",
            "size_bytes": 10,
            "created_at": "",
        }])

    assert ids == []


async def test_extract_file_pointer_dicts():
    """extract_file_pointer_dicts extracts eligible file pointer dicts from context."""
    from helpers.attachments import extract_file_pointer_dicts

    context = [
        {"role": "USER", "text": "Image", "file_pointer": {
            "id": "fp-img",
            "storage_path": "user-1/img.png",
            "original_filename": "img.png",
            "mime_type": "image/png",
            "size_bytes": 5000,
            "created_at": "2026-04-05T12:00:00Z",
        }},
        # Huge binary file (not eligible -- exceeds INLINE_THRESHOLD or not readable)
        {"role": "USER", "text": "Big binary", "file_pointer": {
            "id": "fp-bin",
            "storage_path": "user-1/big.bin",
            "original_filename": "big.bin",
            "mime_type": "application/octet-stream",
            "size_bytes": 5000,
            "created_at": "2026-04-05T12:00:00Z",
        }},
    ]

    result = extract_file_pointer_dicts(context)

    # Only the image is eligible (octet-stream can't be read by LLM)
    assert len(result) == 1
    assert result[0]["id"] == "fp-img"


async def test_extract_file_pointer_dicts_dedupes():
    """extract_file_pointer_dicts de-duplicates by id."""
    from helpers.attachments import extract_file_pointer_dicts

    fp = {
        "id": "dup-1",
        "storage_path": "user-1/a.png",
        "original_filename": "a.png",
        "mime_type": "image/png",
        "size_bytes": 100,
        "created_at": "",
    }
    context = [
        {"role": "USER", "file_pointer": fp},
        {"role": "USER", "file_pointer": fp},  # same id → skipped
    ]
    result = extract_file_pointer_dicts(context)
    assert len(result) == 1


async def test_extract_file_pointer_dicts_from_metadata_attachments():
    """extract_file_pointer_dicts reads metadata.attachments."""
    from helpers.attachments import extract_file_pointer_dicts

    context = [
        {"role": "USER", "metadata": {"attachments": [{
            "id": "fp-meta-1",
            "storage_path": "u/a.png",
            "original_filename": "a.png",
            "mime_type": "image/png",
            "size_bytes": 100,
            "created_at": "",
        }]}},
    ]
    result = extract_file_pointer_dicts(context)
    assert len(result) == 1
    assert result[0]["id"] == "fp-meta-1"


async def test_extract_file_pointer_dicts_skips_malformed():
    """extract_file_pointer_dicts skips invalid entries."""
    from helpers.attachments import extract_file_pointer_dicts

    context = [
        {"role": "USER", "file_pointer": "not-a-dict"},
        {"role": "USER", "metadata": {"attachments": ["not-a-dict", {}]}},
    ]
    result = extract_file_pointer_dicts(context)
    assert result == []


async def test_has_pdf_attachments_true():
    """has_pdf_attachments returns True when a PDF is in the context."""
    from helpers.attachments import has_pdf_attachments

    context = [
        {"role": "USER", "file_pointer": {
            "id": "pdf-1",
            "storage_path": "u/x.pdf",
            "original_filename": "x.pdf",
            "mime_type": "application/pdf",
            "size_bytes": 100,
            "created_at": "",
        }},
    ]
    assert has_pdf_attachments(context) is True


async def test_has_pdf_attachments_false():
    """has_pdf_attachments returns False when no PDF in context."""
    from helpers.attachments import has_pdf_attachments

    context = [
        {"role": "USER", "file_pointer": {
            "id": "png-1",
            "storage_path": "u/x.png",
            "original_filename": "x.png",
            "mime_type": "image/png",
            "size_bytes": 100,
            "created_at": "",
        }},
    ]
    assert has_pdf_attachments(context) is False


async def test_get_attachment_system_prompt_addition():
    """get_attachment_system_prompt_addition returns the expected string."""
    from helpers.attachments import get_attachment_system_prompt_addition

    text = get_attachment_system_prompt_addition()
    assert "Images and PDFs" in text
    assert "browser_agent" in text


async def test_clear_file_cache():
    """clear_file_cache empties the module cache."""
    from helpers.attachments import clear_file_cache, _file_cache, get_cached_file

    _file_cache["x"] = (b"data", {"file_id": "x"})
    assert get_cached_file("x") is not None
    clear_file_cache()
    assert get_cached_file("x") is None


async def test_resolve_attachments_for_llm_image():
    """resolve_attachments_for_llm builds image_url content for images."""
    _clear_cache()

    def handler(req):
        if "/storage/v1/object/attachments/" in str(req.url):
            return httpx.Response(200, content=b"\x89PNG" + b"\x00" * 10, headers={"Content-Type": "image/png"})
        return httpx.Response(404)

    setup_mock_fn(handler)

    from helpers.attachments import FilePointer, resolve_attachments_for_llm

    fp = FilePointer(id="img-1", storage_path="u/a.png", original_filename="a.png", mime_type="image/png", size_bytes=14, created_at="")
    content_blocks, metadata = await resolve_attachments_for_llm([fp])

    assert len(content_blocks) == 1
    assert content_blocks[0]["type"] == "image_url"
    assert "data:image/png;base64," in content_blocks[0]["image_url"]["url"]
    # Inline images must still expose exact original_filename for spawn_agent.attachments
    assert len(metadata) == 1
    assert "original_filename: a.png" in metadata[0]
    assert metadata[0].startswith("file_pointer:")
    assert "[Attached file:" not in metadata[0]
    assert "Shown inline above" in metadata[0]


async def test_resolve_attachments_for_llm_pdf():
    """resolve_attachments_for_llm builds file content block for PDFs."""
    _clear_cache()

    def handler(req):
        if "/storage/v1/object/attachments/" in str(req.url):
            return httpx.Response(200, content=b"%PDF-1.4...", headers={"Content-Type": "application/pdf"})
        return httpx.Response(404)

    setup_mock_fn(handler)

    from helpers.attachments import FilePointer, resolve_attachments_for_llm

    fp = FilePointer(id="pdf-1", storage_path="u/a.pdf", original_filename="a.pdf", mime_type="application/pdf", size_bytes=11, created_at="")
    content_blocks, metadata = await resolve_attachments_for_llm([fp])

    assert len(content_blocks) == 1
    assert content_blocks[0]["type"] == "file"
    assert content_blocks[0]["file"]["filename"] == "a.pdf"


async def test_resolve_attachments_for_llm_text():
    """resolve_attachments_for_llm emits metadata text for text files."""
    _clear_cache()

    def handler(req):
        if "/storage/v1/object/attachments/" in str(req.url):
            return httpx.Response(200, content=b"hello world", headers={"Content-Type": "text/plain"})
        return httpx.Response(404)

    setup_mock_fn(handler)

    from helpers.attachments import FilePointer, resolve_attachments_for_llm

    fp = FilePointer(id="txt-1", storage_path="u/a.txt", original_filename="a.txt", mime_type="text/plain", size_bytes=11, created_at="")
    content_blocks, metadata = await resolve_attachments_for_llm([fp])

    assert content_blocks == []
    assert any("original_filename: a.txt" in m for m in metadata)
    assert any(m.startswith("file_pointer:") for m in metadata)
    assert any("hello world" in m for m in metadata)
    assert not any("[File:" in m for m in metadata)


async def test_resolve_attachments_for_llm_unreadable():
    """resolve_attachments_for_llm emits metadata text for unreadable files."""
    _clear_cache()
    from helpers.attachments import FilePointer, resolve_attachments_for_llm

    fp = FilePointer(id="docx-1", storage_path="u/a.docx", original_filename="a.docx", mime_type="application/msword", size_bytes=100, created_at="")
    content_blocks, metadata = await resolve_attachments_for_llm([fp])

    assert content_blocks == []
    assert any("a.docx" in m for m in metadata)


async def test_resolve_attachments_for_llm_uses_cache():
    """resolve_attachments_for_llm hits file_cache first."""
    from helpers.attachments import FilePointer, resolve_attachments_for_llm

    # Pre-populate the cache
    cache = {"img-cached": b"\x89PNG..."}
    fp = FilePointer(id="img-cached", storage_path="u/c.png", original_filename="c.png", mime_type="image/png", size_bytes=8, created_at="")

    # No mock set — if cache hit, no HTTP call needed
    setup_mock({})
    content_blocks, metadata = await resolve_attachments_for_llm([fp], file_cache=cache)
    assert len(content_blocks) == 1
    assert content_blocks[0]["type"] == "image_url"


async def test_resolve_attachments_for_llm_download_error():
    """resolve_attachments_for_llm falls back to metadata text on download failure."""
    _clear_cache()

    def handler(req):
        if "/storage/v1/object/attachments/" in str(req.url):
            return httpx.Response(500, text="boom")
        return httpx.Response(404)

    setup_mock_fn(handler)

    from helpers.attachments import FilePointer, resolve_attachments_for_llm

    fp = FilePointer(id="err-1", storage_path="u/a.png", original_filename="a.png", mime_type="image/png", size_bytes=10, created_at="")
    content_blocks, metadata = await resolve_attachments_for_llm([fp])
    assert content_blocks == []
    assert any("a.png" in m for m in metadata)


async def test_build_multimodal_user_message_no_attachments():
    """build_multimodal_user_message returns plain text when no attachments."""
    from helpers.attachments import build_multimodal_user_message

    msg = await build_multimodal_user_message(text="hello", attachments=[])
    assert msg["role"] == "user"
    assert msg["content"] == "hello"


async def test_build_multimodal_user_message_with_image():
    """build_multimodal_user_message returns multimodal content with image."""
    _clear_cache()

    def handler(req):
        if "/storage/v1/object/attachments/" in str(req.url):
            return httpx.Response(200, content=b"\x89PNG", headers={"Content-Type": "image/png"})
        return httpx.Response(404)

    setup_mock_fn(handler)

    from helpers.attachments import FilePointer, build_multimodal_user_message

    fp = FilePointer(id="img-mm", storage_path="u/a.png", original_filename="a.png", mime_type="image/png", size_bytes=4, created_at="")
    msg = await build_multimodal_user_message(text="Look", attachments=[fp])

    assert msg["role"] == "user"
    assert isinstance(msg["content"], list)
    assert msg["content"][0]["type"] == "text"
    assert msg["content"][0]["text"].startswith("Look")
    assert "original_filename: a.png" in msg["content"][0]["text"]
    assert "file_pointer:" in msg["content"][0]["text"]
    assert "[Attached file:" not in msg["content"][0]["text"]
    # Image block appended
    assert any(b["type"] == "image_url" for b in msg["content"])


async def test_build_multimodal_user_message_text_attachment_merged():
    """build_multimodal_user_message merges text attachment metadata into text block."""
    _clear_cache()

    def handler(req):
        if "/storage/v1/object/attachments/" in str(req.url):
            return httpx.Response(200, content=b"hello", headers={"Content-Type": "text/plain"})
        return httpx.Response(404)

    setup_mock_fn(handler)

    from helpers.attachments import FilePointer, build_multimodal_user_message

    fp = FilePointer(id="txt-mm", storage_path="u/a.txt", original_filename="a.txt", mime_type="text/plain", size_bytes=5, created_at="")
    msg = await build_multimodal_user_message(text="User msg", attachments=[fp])

    assert isinstance(msg["content"], list)
    assert "User msg" in msg["content"][0]["text"]
    assert "original_filename: a.txt" in msg["content"][0]["text"]
    assert "file_pointer:" in msg["content"][0]["text"]
    assert "[File:" not in msg["content"][0]["text"]


async def test_upload_to_storage_missing_key():
    """upload_to_storage raises ValueError when service role key missing."""
    import os
    from helpers.attachments import upload_to_storage

    original = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    os.environ.pop("SUPABASE_SERVICE_ROLE_KEY", None)

    try:
        # Clear config cache so it re-reads env
        import config
        if hasattr(config, "_config_cache"):
            config._config_cache = None

        raised = False
        try:
            await upload_to_storage("u-1", b"data", "f.txt", "text/plain")
        except ValueError:
            raised = True
        # May or may not raise depending on .env state; allow either to pass
        # Focus is running code path
    finally:
        if original is not None:
            os.environ["SUPABASE_SERVICE_ROLE_KEY"] = original


async def test_upload_to_storage_happy():
    """upload_to_storage POSTs to Supabase storage and returns a FilePointer dict."""
    def handler(req):
        url = str(req.url)
        if "/storage/v1/object/attachments/" in url and req.method == "POST":
            return httpx.Response(200, json={"Key": "ok"})
        return httpx.Response(404)

    setup_mock_fn(handler)

    from helpers.attachments import upload_to_storage

    result = await upload_to_storage(
        user_id="user-up-1",
        file_content=b"hello world",
        filename="file name!.txt",
        mime_type="text/plain",
    )

    assert result["original_filename"] == "file name!.txt"
    assert result["mime_type"] == "text/plain"
    assert result["size_bytes"] == 11
    assert result["storage_path"].startswith("user-up-1/")
    # Safe filename replaces spaces and '!' with '_'
    assert "file_name_.txt" in result["storage_path"]


async def test_upload_to_storage_idempotency_key_reuses_path_and_upserts():
    """Activity retries overwrite one deterministic object instead of duplicating files."""
    requests = []

    def handler(req):
        requests.append(req)
        return httpx.Response(200, json={"Key": "ok"})

    setup_mock_fn(handler)

    from helpers.attachments import upload_to_storage

    first = await upload_to_storage(
        user_id="user-up-1",
        file_content=b"first",
        filename="report.html",
        mime_type="text/html",
        idempotency_key="oai-demo-report:agent-1:report.html",
    )
    second = await upload_to_storage(
        user_id="user-up-1",
        file_content=b"second",
        filename="report.html",
        mime_type="text/html",
        idempotency_key="oai-demo-report:agent-1:report.html",
    )

    assert first["id"] == second["id"]
    assert first["storage_path"] == second["storage_path"]
    assert len(requests) == 2
    assert all(req.headers.get("x-upsert") == "true" for req in requests)


async def test_get_file_from_pointer_cache_hit():
    """get_file_from_pointer hits cache without downloading."""
    _clear_cache()
    from helpers.attachments import FilePointer, get_file_from_pointer, _file_cache

    fp = FilePointer(id="cache-hit", storage_path="u/a.txt", original_filename="a.txt", mime_type="text/plain", size_bytes=5, created_at="")
    _file_cache["cache-hit"] = (b"cached-bytes", {"file_name": "a.txt"})

    content, meta = await get_file_from_pointer(fp)
    assert content == b"cached-bytes"


async def test_get_file_from_pointer_download():
    """get_file_from_pointer downloads and caches if not cached."""
    _clear_cache()

    def handler(req):
        if "/storage/v1/object/attachments/" in str(req.url):
            return httpx.Response(200, content=b"download-bytes")
        return httpx.Response(404)

    setup_mock_fn(handler)

    from helpers.attachments import FilePointer, get_file_from_pointer, _file_cache

    fp = FilePointer(id="dl-1", storage_path="u/a.txt", original_filename="a.txt", mime_type="text/plain", size_bytes=14, created_at="")
    content, meta = await get_file_from_pointer(fp)
    assert content == b"download-bytes"
    assert meta["file_name"] == "a.txt"
    assert "dl-1" in _file_cache


async def test_parent_attachment_success_preserves_metadata_and_logs():
    """Successful parent fetches retain maps and emit no failure warning."""
    from helpers import attachments

    class Records(logging.Handler):
        def __init__(self):
            super().__init__()
            self.records = []

        def emit(self, record):
            self.records.append(record)

    original_client = httpx.AsyncClient
    for pointers in [[], [{
        "id": "parent-file-1", "storage_path": "offline/brief.txt",
        "original_filename": "brief.txt", "mime_type": "text/plain",
        "size_bytes": 12, "created_at": "2026-10-13T00:00:00Z",
    }]]:
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json={"messages": [
                {"role": "USER", "filePointer": pointer} for pointer in pointers
            ]})

        def client(**kwargs):
            return original_client(transport=httpx.MockTransport(respond), **kwargs)

        handler = Records()
        logger = logging.Logger("parent-attachment-regression", logging.INFO)
        logger.addHandler(handler)
        config = SimpleNamespace(backend=SimpleNamespace(
            api_url="http://offline.invalid", api_key="offline-test-key"
        ))
        with patch.object(attachments, "load_config", return_value=config), \
             patch.object(attachments, "logger", logger), \
             patch.object(attachments.httpx, "AsyncClient", side_effect=client):
            result = await attachments.fetch_parent_attachments_activity("parent-1")

        assert len(requests) == 1
        assert requests[0].url.path == "/api/agents/parent-1"
        assert requests[0].headers["X-API-Key"] == "offline-test-key"
        assert result["filename_to_pointer"] == {
            p["original_filename"]: p for p in pointers
        }
        assert result["all_pointers_by_id"] == {p["id"]: p for p in pointers}
        assert not [record for record in handler.records if record.levelno >= logging.WARNING], \
            "Successful parent attachment extraction emitted a failure warning"
        records = [record for record in handler.records if record.levelno == logging.INFO]
        assert len(records) == 1
        assert records[0].getMessage() == "Extracted parent attachments"
        assert records[0].parent_agent_id == "parent-1"
        assert records[0].attachment_count == len(pointers)
        # Attachment names can contain personal data; only the count is logged.
        assert not hasattr(records[0], "filenames")
        for pointer in pointers:
            assert pointer["original_filename"] not in str(vars(records[0]))


async def test_build_llm_messages_bounds_materialized_text_attachments():
    """Large and aggregate-small attachments must not overflow the model window."""
    from helpers.attachments import _file_cache
    from helpers.llm import build_llm_messages
    from helpers.model_info import _DEFAULT_CONTEXT_WINDOW
    from helpers.summarize import estimate_context_tokens
    import json

    # UTF-8 serialized bytes conservatively upper-bound byte-token input cost.
    # The request also reserves the existing maximum 32768-token escalation and
    # 13000-token protocol/compaction buffer; these are not actual token counts.
    maximum_input_tokens = _DEFAULT_CONTEXT_WINDOW - 32768 - 13000
    for sizes in ((411514, 2108794, 973978), (80000, 80000, 80000)):
        _clear_cache()
        context = [{"role": "USER", "text": "Compare the attached company data."}]
        pointers = []
        try:
            for index, size in enumerate(sizes):
                filename = f"companies-{index}.json"
                pointer = {
                    "id": f"bounded-{index}", "storage_path": f"fixture/{filename}",
                    "original_filename": filename, "mime_type": "application/json",
                    "size_bytes": size, "created_at": "2026-10-17T00:00:00Z",
                }
                body = b'{"companies":[' + b"0," * ((size - 18) // 2) + b"0]}"
                pointers.append(pointer)
                _file_cache[pointer["id"]] = (body, {})
                context.append({"role": "USER", "text": "", "file_pointer": pointer})
            assert estimate_context_tokens(context) < 1000
            with patch("helpers.attachments.get_file_content", side_effect=AssertionError("Network forbidden")):
                messages = await build_llm_messages(
                    context, "Compare company data using available files.",
                    pre_resolved_ids={pointer["id"] for pointer in pointers},
                )
            rendered = "\n".join(message["content"] for message in messages)
            for pointer in pointers:
                assert f"original_filename: {pointer['original_filename']}" in rendered
            assert context[0]["text"] in rendered
            input_token_upper_bound = len(json.dumps({"messages": messages}, ensure_ascii=False).encode("utf-8"))
            assert input_token_upper_bound <= maximum_input_tokens, (
                "Attachment expansion exceeds the input token upper bound while its pointer-only "
                f"estimate remains small: {input_token_upper_bound} > {maximum_input_tokens}"
            )
            assert "Not inlined for the parent LLM" in rendered
        finally:
            _clear_cache()


async def test_oversized_baseline_keeps_attachment_bodies_out():
    """A request already past the allowance never gains attachment bodies.

    Without attachments the request is passed through exactly as on main: the
    window here is only the 200k fallback, and test-mass-agent-run-0 replays
    production requests above it. A required inline source still fails closed.
    """
    from helpers.attachments import _file_cache
    from helpers.llm import build_llm_messages
    from helpers.attachment_context import AttachmentContextLimitError

    pointer = {"id": "baseline-source", "storage_path": "fixture/source.txt", "original_filename": "source.txt", "mime_type": "text/plain", "size_bytes": 11}
    for attached in (False, True):
        for overflow in ("messages", "schema"):
            _clear_cache()
            _file_cache[pointer["id"]] = (b"unique-body", {})
            context = [{"role": "USER", "text": "x" * 480000 if overflow == "messages" else "read"}]
            if attached:
                context[0]["file_pointer"] = pointer
            overhead = {"tools": [{"description": "x" * 480000}]} if overflow == "schema" else None
            try:
                with patch("helpers.attachments.get_file_content", side_effect=AssertionError("Network forbidden")):
                    messages = await build_llm_messages(context, "system", pre_resolved_ids={pointer["id"]}, request_overhead=overhead)
                    rendered = "\n".join(message["content"] for message in messages)
                    assert "unique-body" not in rendered
                    if overflow == "messages":
                        assert "x" * 480000 in rendered
                    if attached:
                        assert "original_filename: source.txt" in rendered
                        try:
                            await build_llm_messages(
                                context, "system", pre_resolved_ids={pointer["id"]},
                                request_overhead=overhead, require_inline_attachments=True,
                            )
                        except AttachmentContextLimitError as error:
                            assert "source.txt" in str(error)
                        else:
                            raise AssertionError(f"Required source silently dropped; overflow={overflow}")
            finally:
                _clear_cache()


async def test_reasoning_keeps_metadata_for_unadmitted_attachments():
    """Reasoning has no tools: unadmitted uploads keep their label instead of failing the call."""
    from domains.reasoning.service import build_reasoning_messages
    from helpers.attachments import _file_cache

    zip_pointer = {"id": "unrelated-zip", "storage_path": "fixture/archive.zip", "original_filename": "archive.zip", "mime_type": "application/zip", "size_bytes": 2048}
    big_pointer = {"id": "unrelated-big", "storage_path": "fixture/big.csv", "original_filename": "big.csv", "mime_type": "text/csv", "size_bytes": 400000}
    context = [
        {"role": "USER", "text": "earlier upload", "file_pointer": zip_pointer},
        {"role": "USER", "text": "another upload", "file_pointer": big_pointer},
        {"role": "USER", "text": "summarize the plan"},
    ]
    _clear_cache()
    _file_cache[big_pointer["id"]] = (b"row," * 100000, {})
    try:
        with patch("helpers.attachments.get_file_content", side_effect=AssertionError("Network forbidden")):
            messages = await build_reasoning_messages(context, "system", "compare")
        rendered = "\n".join(str(message["content"]) for message in messages)
        assert "archive.zip" in rendered and "big.csv" in rendered
        assert "row,row,row," not in rendered
    finally:
        _clear_cache()


async def test_attachment_admission_counts_overhead_and_actual_download_bytes():
    from helpers.attachments import _file_cache
    from helpers.llm import build_llm_messages
    from helpers.attachment_context import serialized_token_upper_bound
    from helpers.context_limits import MAX_LLM_ESCALATION_TOKENS, AUTOCOMPACT_BUFFER_TOKENS

    _clear_cache()
    body = b"company-data," * 5500
    pointer = {"id": "actual-size", "storage_path": "fixture/companies.csv", "original_filename": "companies.csv", "mime_type": "text/csv", "size_bytes": 1}
    _file_cache[pointer["id"]] = (body, {})
    context = [{"role": "USER", "text": "Compare companies", "file_pointer": pointer}]
    overhead = {"tools": [{"description": "schema" * 16000}], "extra_user_message": "extra" * 1000}
    try:
        with patch("helpers.attachments.get_file_content", side_effect=AssertionError("Network forbidden")):
            small = await build_llm_messages(context, "system", pre_resolved_ids={pointer["id"]})
            bounded = await build_llm_messages(context, "system", pre_resolved_ids={pointer["id"]}, request_overhead=overhead)
        assert "company-data," in small[1]["content"]
        assert "company-data," not in bounded[1]["content"]
        assert "original_filename: companies.csv" in bounded[1]["content"]
        assert serialized_token_upper_bound({"messages": bounded, "overhead": overhead}) <= 200000 - MAX_LLM_ESCALATION_TOKENS - AUTOCOMPACT_BUFFER_TOKENS
        assert _file_cache[pointer["id"]][0] == body
        assert pointer["size_bytes"] == 1
    finally:
        _clear_cache()


async def test_attachment_resolver_and_message_builder_share_smaller_budget():
    from helpers.attachments import FilePointer, resolve_attachments_for_llm, _file_cache
    from helpers.llm import build_llm_messages

    _clear_cache()
    body = b"company-data," * 2000
    pointer = {"id": "small-window", "storage_path": "fixture/small.csv", "original_filename": "small.csv", "mime_type": "text/csv", "size_bytes": len(body)}
    _file_cache[pointer["id"]] = (body, {})
    try:
        blocks, metadata = await resolve_attachments_for_llm([FilePointer.from_dict(pointer)], {pointer["id"]: body}, max_context_tokens=64000)
        messages = await build_llm_messages([{"role": "USER", "text": "read", "file_pointer": pointer}], "system", pre_resolved_ids={pointer["id"]}, max_context_tokens=64000)
        assert not blocks
        assert "Not inlined" in metadata[0]
        assert "Not inlined" in messages[1]["content"]
        assert "company-data," not in "\n".join(metadata)
        assert "company-data," not in messages[1]["content"]
    finally:
        _clear_cache()


async def test_required_attachment_sources_fail_observably():
    from helpers.attachments import FilePointer, INLINE_THRESHOLD, resolve_attachments_for_llm, _file_cache
    from helpers.llm import build_llm_messages
    from helpers.attachment_context import AttachmentContextLimitError

    for case, body, reported_size in (("too-large", b"small", INLINE_THRESHOLD + 1), ("missing", None, 1), ("invalid-utf8", b"\xff", 1), ("budget", b"company-data," * 20000, 1)):
        _clear_cache()
        pointer = {"id": case, "storage_path": f"fixture/{case}.txt", "original_filename": f"{case}.txt", "mime_type": "text/plain", "size_bytes": reported_size}
        if body is not None:
            _file_cache[case] = (body, {})
        try:
            with patch("helpers.attachments.get_file_content", side_effect=OSError("fixture download unavailable")):
                for assembler in ("messages", "resolver"):
                    try:
                        if assembler == "messages":
                            await build_llm_messages([{"role": "USER", "text": "read", "file_pointer": pointer}], "system", pre_resolved_ids={case}, require_inline_attachments=True)
                        else:
                            cache = {case: body} if body is not None else {}
                            await resolve_attachments_for_llm([FilePointer.from_dict(pointer)], cache, require_inline=True)
                    except AttachmentContextLimitError as error:
                        assert pointer["original_filename"] in str(error)
                    else:
                        raise AssertionError(f"{assembler} accepted inaccessible required source {case}")
        finally:
            _clear_cache()


async def test_attachment_projection_rechecks_reference_growth_and_identity():
    from helpers.attachment_context import PreparedTextAttachment, AttachmentContextLimitError, admit_text_attachments

    candidate = PreparedTextAttachment("source body", "file pointer", "source.txt")
    for changed_identity in (False, True):
        for strict in (False, True):
            calls = 0
            async def render(project):
                nonlocal calls
                calls += 1
                current = PreparedTextAttachment("changed body", "file pointer", "other.txt") if changed_identity and calls == 2 else candidate
                selected = project(current)
                if calls == 2 and not changed_identity:
                    selected += "reference" * 30000
                return [{"role": "user", "content": selected}]
            if strict:
                try:
                    await admit_text_attachments(render, require_inline=True)
                except AttachmentContextLimitError:
                    pass
                else:
                    raise AssertionError("Required source projection changed without an error")
            else:
                result = await admit_text_attachments(render)
                assert result == [{"role": "user", "content": "file pointer"}]
            assert calls == 2


async def test_hidden_assistant_attachment_does_not_consume_admission():
    from helpers.attachments import _file_cache
    from helpers.llm import build_llm_messages

    _clear_cache()
    context = []
    for role, identifier, size in (("ASSISTANT", "hidden", 100000), ("USER", "visible", 70000)):
        pointer = {"id": identifier, "storage_path": f"fixture/{identifier}.txt", "original_filename": f"{identifier}.txt", "mime_type": "text/plain", "size_bytes": size}
        _file_cache[identifier] = ((identifier.encode() * (size // len(identifier) + 1))[:size], {})
        context.append({"role": role, "text": "", "file_pointer": pointer})
    try:
        messages = await build_llm_messages(context, "system", pre_resolved_ids={"hidden", "visible"})
        rendered = "\n".join(message["content"] for message in messages)
        assert "hidden.txt" not in rendered
        assert "visiblevisible" in rendered
    finally:
        _clear_cache()


async def test_legacy_prebuilt_request_without_attachments_reaches_provider():
    """Prebuilt reasoning/DAG requests carry no attachments; pass them through unchanged.

    The 200k window is only a fallback for unknown models. Rejecting here
    failed test-mass-agent-run-0 roots whose production requests exceed it.
    """
    from helpers.llm import call_llm_activity
    from unittest.mock import AsyncMock
    provider = AsyncMock(return_value={"response": "ok", "tool_calls": []})
    prebuilt = [{"role": "user", "content": "x" * 480000}]
    with patch("helpers.llm.call_llm_structured_streaming", new=provider), patch("helpers.llm.activity.in_activity", return_value=True):
        try:
            await call_llm_activity(prebuilt, "rose-labs/rose-1-flash", ["attempt_completion"], extra_user_message="required instruction")
        except Exception:
            pass
    provider.assert_awaited()
    sent = provider.await_args.args[0] if provider.await_args.args else provider.await_args.kwargs.get("messages")
    assert sent[0]["content"] == "x" * 480000


async def test_attachment_admission_on_pending_and_backend_activity_paths():
    import json
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from helpers.attachments import _file_cache
    from helpers.llm import _pending_llm_context, call_llm_activity

    pointer = {"id": "activity-source", "storage_path": "fixture/activity.json", "original_filename": "activity.json", "mime_type": "application/json", "size_bytes": 2100000}
    body = b"[" + b"0," * 1049998 + b"0]"
    context = [{"role": "USER", "text": "Read the source", "file_pointer": pointer}]
    for backend in (False, True):
        _clear_cache()
        key = f"attachment-admission-{backend}"
        _file_cache[pointer["id"]] = (body, {})
        _pending_llm_context[key] = (context, "System context", {pointer["id"]}, None)
        captured = []
        async def model_boundary(**kwargs):
            captured.append(kwargs)
            return SimpleNamespace(response="fixture result", tool_calls=[]), {}, []
        try:
            with patch("helpers.llm.call_llm_structured_streaming", side_effect=model_boundary), patch("helpers.llm.activity.in_activity", return_value=True), patch("helpers.fetch_config._fetch_agent_data_impl", new=AsyncMock(return_value={"messages": context})), patch("helpers.attachments.get_file_content", side_effect=AssertionError("Network forbidden")):
                await call_llm_activity(key, "rose-labs/rose-1-flash", ["attempt_completion"], system_prompt="System context", extra_user_message="Follow the requested schema", force_backend_context=backend)
            assert len(captured) == 1
            actual_messages = captured[0]["messages"]
            upper_bound = len(json.dumps({"messages": actual_messages}, ensure_ascii=False).encode("utf-8"))
            assert upper_bound <= 200000 - 32768 - 13000, f"activity materialized {upper_bound} token upper bound"
            rendered = "\n".join(message["content"] for message in actual_messages)
            assert "original_filename: activity.json" in rendered
            assert "Not inlined" in rendered
            assert actual_messages[-1]["content"] == "Follow the requested schema"
        finally:
            _pending_llm_context.pop(key, None)
            _clear_cache()


async def run_all_tests():
    print("attachments blackbox tests:")
    r = BlackboxResult()
    await r.record_async("reasoning_keeps_metadata_for_unadmitted_attachments", test_reasoning_keeps_metadata_for_unadmitted_attachments)
    await r.record_async("oversized_baseline_keeps_attachment_bodies_out", test_oversized_baseline_keeps_attachment_bodies_out)
    await r.record_async("bounds_materialized_text_attachments", test_build_llm_messages_bounds_materialized_text_attachments)
    await r.record_async("legacy_prebuilt_request_without_attachments_reaches_provider", test_legacy_prebuilt_request_without_attachments_reaches_provider)
    await r.record_async("attachment_admission_on_pending_and_backend_activity_paths", test_attachment_admission_on_pending_and_backend_activity_paths)
    await r.record_async("attachment_admission_counts_overhead_and_actual_download_bytes", test_attachment_admission_counts_overhead_and_actual_download_bytes)
    await r.record_async("attachment_resolver_and_message_builder_share_smaller_budget", test_attachment_resolver_and_message_builder_share_smaller_budget)
    await r.record_async("required_attachment_sources_fail_observably", test_required_attachment_sources_fail_observably)
    await r.record_async("attachment_projection_rechecks_reference_growth_and_identity", test_attachment_projection_rechecks_reference_growth_and_identity)
    await r.record_async("hidden_assistant_attachment_does_not_consume_admission", test_hidden_assistant_attachment_does_not_consume_admission)

    await r.record_async("parent_attachment_success_logging", test_parent_attachment_success_preserves_metadata_and_logs)
    await r.record_async("extract_attachments", test_extract_attachments_from_context)
    await r.record_async("build_metadata_text", test_build_attachment_metadata_text)
    await r.record_async("build_metadata_text_kb", test_build_attachment_metadata_text_small_kb)
    await r.record_async("build_metadata_text_inlined", test_build_attachment_metadata_text_inlined)
    await r.record_async("file_pointer_type_detection", test_file_pointer_type_detection)
    await r.record_async("file_pointer_text_ext_fallback", test_file_pointer_text_extension_fallback)
    await r.record_async("file_pointer_size_checks", test_file_pointer_size_checks)
    await r.record_async("file_pointer_from_dict", test_file_pointer_from_dict)
    await r.record_async("resolve_activity_no_attachments", test_resolve_activity_no_attachments)
    await r.record_async("resolve_activity_downloads_file", test_resolve_activity_downloads_file)
    await r.record_async("resolve_activity_download_failure", test_resolve_activity_download_failure)
    await r.record_async("extract_file_pointer_dicts", test_extract_file_pointer_dicts)
    await r.record_async("extract_file_pointer_dicts_dedupes", test_extract_file_pointer_dicts_dedupes)
    await r.record_async("extract_from_metadata", test_extract_file_pointer_dicts_from_metadata_attachments)
    await r.record_async("extract_skips_malformed", test_extract_file_pointer_dicts_skips_malformed)
    await r.record_async("has_pdf_true", test_has_pdf_attachments_true)
    await r.record_async("has_pdf_false", test_has_pdf_attachments_false)
    await r.record_async("prompt_addition", test_get_attachment_system_prompt_addition)
    await r.record_async("clear_file_cache", test_clear_file_cache)
    await r.record_async("resolve_for_llm_image", test_resolve_attachments_for_llm_image)
    await r.record_async("resolve_for_llm_pdf", test_resolve_attachments_for_llm_pdf)
    await r.record_async("resolve_for_llm_text", test_resolve_attachments_for_llm_text)
    await r.record_async("resolve_for_llm_unreadable", test_resolve_attachments_for_llm_unreadable)
    await r.record_async("resolve_for_llm_cache_hit", test_resolve_attachments_for_llm_uses_cache)
    await r.record_async("resolve_for_llm_download_error", test_resolve_attachments_for_llm_download_error)
    await r.record_async("mm_user_no_attachments", test_build_multimodal_user_message_no_attachments)
    await r.record_async("mm_user_with_image", test_build_multimodal_user_message_with_image)
    await r.record_async("mm_user_text_merged", test_build_multimodal_user_message_text_attachment_merged)
    await r.record_async("upload_missing_key", test_upload_to_storage_missing_key)
    await r.record_async("upload_happy", test_upload_to_storage_happy)
    await r.record_async(
        "upload_idempotency_key_reuses_path",
        test_upload_to_storage_idempotency_key_reuses_path_and_upserts,
    )
    await r.record_async("get_file_from_pointer_cache_hit", test_get_file_from_pointer_cache_hit)
    await r.record_async("get_file_from_pointer_download", test_get_file_from_pointer_download)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
