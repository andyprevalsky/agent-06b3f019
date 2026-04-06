"""Blackbox tests for attachments domain."""

import asyncio
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


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


async def test_resolve_activity_no_attachments():
    """resolve_attachments_activity with empty list returns empty list."""
    setup_mock({})  # No HTTP calls expected
    with patch("temporalio.activity.heartbeat"):
        from helpers.attachments import resolve_attachments_activity

        result = await resolve_attachments_activity(file_pointers=[])

    assert result == []
    assert len(get_captured_requests()) == 0


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


async def run_all_tests():
    print("attachments blackbox tests:")
    r = BlackboxResult()
    await r.record_async("extract_attachments", test_extract_attachments_from_context)
    await r.record_async("build_metadata_text", test_build_attachment_metadata_text)
    await r.record_async("file_pointer_type_detection", test_file_pointer_type_detection)
    await r.record_async("resolve_activity_no_attachments", test_resolve_activity_no_attachments)
    await r.record_async("extract_file_pointer_dicts", test_extract_file_pointer_dicts)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
