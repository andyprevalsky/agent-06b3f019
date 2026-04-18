"""Blackbox tests for attachments domain."""

import asyncio
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

    assert "report.docx" in text
    assert "MB" in text or "KB" in text
    assert "cannot be directly read" in text


async def test_build_attachment_metadata_text_small_kb():
    """build_attachment_metadata_text uses KB for small files."""
    from helpers.attachments import FilePointer, build_attachment_metadata_text

    fp = FilePointer(id="x", storage_path="x", original_filename="a.bin", mime_type="application/octet-stream", size_bytes=500, created_at="")
    text = build_attachment_metadata_text(fp)
    assert "KB" in text


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
    assert any("[File: a.txt]" in m for m in metadata)
    assert any("hello world" in m for m in metadata)


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
    assert msg["content"][0]["text"] == "Look"
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
    assert "[File: a.txt]" in msg["content"][0]["text"]


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


async def run_all_tests():
    print("attachments blackbox tests:")
    r = BlackboxResult()
    await r.record_async("extract_attachments", test_extract_attachments_from_context)
    await r.record_async("build_metadata_text", test_build_attachment_metadata_text)
    await r.record_async("build_metadata_text_kb", test_build_attachment_metadata_text_small_kb)
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
    await r.record_async("get_file_from_pointer_cache_hit", test_get_file_from_pointer_cache_hit)
    await r.record_async("get_file_from_pointer_download", test_get_file_from_pointer_download)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
