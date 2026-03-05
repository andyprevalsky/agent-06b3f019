"""Test attachment resolution for LLM context.

Tests that:
- resolve_attachments_activity downloads files and populates cache
- Subsequent calls get cache hits (no re-download)
- build_llm_messages uses pre_resolved_ids to inject file content from cache
- Large/binary files stay as metadata-only
"""

import asyncio
import base64
import traceback
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from helpers.attachments import (
    FilePointer,
    resolve_attachments_activity,
    extract_file_pointer_dicts,
    get_cached_file,
    _file_cache,
    clear_file_cache,
    get_file_from_pointer,
    INLINE_THRESHOLD,
)
from helpers.llm import build_llm_messages, _pending_llm_context, call_llm_activity


def _make_file_pointer_dict(
    file_id="file-123",
    filename="photo.png",
    mime_type="image/png",
    size_bytes=1024,
    storage_path="user-1/file-123_photo.png",
):
    return {
        "id": file_id,
        "storage_path": storage_path,
        "original_filename": filename,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "created_at": "2024-01-15T10:30:00Z",
    }


def _make_context_with_file(fp_dict, text="Check this file"):
    return [
        {
            "role": "USER",
            "text": text,
            "file_pointer": fp_dict,
            "timestamp": "2024-01-15T10:30:00Z",
        }
    ]


FAKE_IMAGE_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
FAKE_TEXT_BYTES = b"Hello, this is a CSV file\ncol1,col2\nval1,val2"
FAKE_PDF_BYTES = b"%PDF-1.4 fake pdf content"


async def test_resolve_attachments_downloads_and_caches():
    """Verify resolve_attachments_activity downloads files and populates _file_cache."""
    clear_file_cache()

    fp_dict = _make_file_pointer_dict()
    context = _make_context_with_file(fp_dict)
    file_pointers = extract_file_pointer_dicts(context)

    download_call_count = 0

    async def mock_download(storage_path):
        nonlocal download_call_count
        download_call_count += 1
        return FAKE_IMAGE_BYTES

    with patch("helpers.attachments.download_from_storage", side_effect=mock_download):
        with patch("temporalio.activity.heartbeat"):
            result = await resolve_attachments_activity(file_pointers)

    assert result == ["file-123"], f"Expected ['file-123'], got {result}"
    assert download_call_count == 1, f"Expected 1 download, got {download_call_count}"
    assert get_cached_file("file-123") is not None, "File should be in cache"
    assert get_cached_file("file-123")[0] == FAKE_IMAGE_BYTES
    print("✅ test_resolve_attachments_downloads_and_caches passed")


async def test_resolve_attachments_cache_hit_no_redownload():
    """Second call with same file pointers should NOT re-download (cache hit)."""
    clear_file_cache()

    fp_dict = _make_file_pointer_dict()
    context = _make_context_with_file(fp_dict)
    file_pointers = extract_file_pointer_dicts(context)

    download_call_count = 0

    async def mock_download(storage_path):
        nonlocal download_call_count
        download_call_count += 1
        return FAKE_IMAGE_BYTES

    with patch("helpers.attachments.download_from_storage", side_effect=mock_download):
        with patch("temporalio.activity.heartbeat"):
            # First call
            result1 = await resolve_attachments_activity(file_pointers)
            # Second call (simulating next iteration)
            result2 = await resolve_attachments_activity(file_pointers)

    assert result1 == ["file-123"]
    assert result2 == ["file-123"]
    assert download_call_count == 1, f"Expected 1 download (cache hit on 2nd), got {download_call_count}"
    print("✅ test_resolve_attachments_cache_hit_no_redownload passed")


async def test_resolve_attachments_skips_large_files():
    """Files over INLINE_THRESHOLD should NOT be extracted or downloaded."""
    clear_file_cache()

    fp_dict = _make_file_pointer_dict(size_bytes=INLINE_THRESHOLD + 1)
    context = _make_context_with_file(fp_dict)
    file_pointers = extract_file_pointer_dicts(context)

    # extract_file_pointer_dicts filters out ineligible files
    assert file_pointers == [], f"Large file should not be extracted, got {file_pointers}"
    print("✅ test_resolve_attachments_skips_large_files passed")


async def test_resolve_attachments_skips_binary_files():
    """Binary files (e.g., zip) should NOT be extracted or downloaded."""
    clear_file_cache()

    fp_dict = _make_file_pointer_dict(mime_type="application/zip", filename="archive.zip")
    context = _make_context_with_file(fp_dict)
    file_pointers = extract_file_pointer_dicts(context)

    assert file_pointers == [], f"Binary file should not be extracted, got {file_pointers}"
    print("✅ test_resolve_attachments_skips_binary_files passed")


async def test_build_llm_messages_image_from_cache():
    """With pre_resolved_ids and cached image, build_llm_messages should produce image_url block."""
    clear_file_cache()

    fp_dict = _make_file_pointer_dict()
    context = _make_context_with_file(fp_dict, text="Analyze this image")

    # Pre-populate cache (simulating what resolve_attachments_activity does)
    fp = FilePointer.from_dict(fp_dict)
    _file_cache[fp.id] = (FAKE_IMAGE_BYTES, {"file_name": fp.original_filename})

    # Call build_llm_messages with pre_resolved_ids, NOT in activity context
    with patch("helpers.llm.activity.in_activity", return_value=False):
        messages = await build_llm_messages(
            context, "System prompt", pre_resolved_ids={"file-123"}
        )

    # Find the user message
    user_msgs = [m for m in messages if m["role"] == "user"]
    assert len(user_msgs) == 1, f"Expected 1 user message, got {len(user_msgs)}"

    user_msg = user_msgs[0]
    assert isinstance(user_msg["content"], list), "Content should be multimodal array"

    image_blocks = [b for b in user_msg["content"] if b.get("type") == "image_url"]
    assert len(image_blocks) == 1, f"Expected 1 image_url block, got {len(image_blocks)}"

    expected_b64 = base64.b64encode(FAKE_IMAGE_BYTES).decode("utf-8")
    assert expected_b64 in image_blocks[0]["image_url"]["url"]

    # Verify NO metadata fallback text
    text_blocks = [b for b in user_msg["content"] if b.get("type") == "text"]
    for tb in text_blocks:
        assert "cannot be directly read" not in tb["text"], "Should not contain metadata fallback"

    print("✅ test_build_llm_messages_image_from_cache passed")


async def test_build_llm_messages_text_file_from_cache():
    """Text files should be inlined as code blocks."""
    clear_file_cache()

    fp_dict = _make_file_pointer_dict(
        file_id="text-1", filename="data.csv", mime_type="text/csv",
        storage_path="user-1/text-1_data.csv",
    )
    context = _make_context_with_file(fp_dict, text="Process this data")

    _file_cache["text-1"] = (FAKE_TEXT_BYTES, {"file_name": "data.csv"})

    with patch("helpers.llm.activity.in_activity", return_value=False):
        messages = await build_llm_messages(
            context, "System prompt", pre_resolved_ids={"text-1"}
        )

    user_msgs = [m for m in messages if m["role"] == "user"]
    user_msg = user_msgs[0]

    # Text files are inlined in the text, not as multimodal blocks
    if isinstance(user_msg["content"], list):
        text_content = " ".join(b.get("text", "") for b in user_msg["content"] if b.get("type") == "text")
    else:
        text_content = user_msg["content"]

    assert "[File: data.csv]" in text_content, "Should contain inline file header"
    assert "col1,col2" in text_content, "Should contain file content"
    assert "cannot be directly read" not in text_content, "Should not contain metadata fallback"
    print("✅ test_build_llm_messages_text_file_from_cache passed")


async def test_build_llm_messages_pdf_from_cache():
    """PDFs should produce a file content block."""
    clear_file_cache()

    fp_dict = _make_file_pointer_dict(
        file_id="pdf-1", filename="doc.pdf", mime_type="application/pdf",
        storage_path="user-1/pdf-1_doc.pdf",
    )
    context = _make_context_with_file(fp_dict, text="Read this PDF")

    _file_cache["pdf-1"] = (FAKE_PDF_BYTES, {"file_name": "doc.pdf"})

    with patch("helpers.llm.activity.in_activity", return_value=False):
        messages = await build_llm_messages(
            context, "System prompt", pre_resolved_ids={"pdf-1"}
        )

    user_msgs = [m for m in messages if m["role"] == "user"]
    user_msg = user_msgs[0]
    assert isinstance(user_msg["content"], list), "Content should be multimodal array"

    file_blocks = [b for b in user_msg["content"] if b.get("type") == "file"]
    assert len(file_blocks) == 1, f"Expected 1 file block, got {len(file_blocks)}"
    assert file_blocks[0]["file"]["filename"] == "doc.pdf"
    print("✅ test_build_llm_messages_pdf_from_cache passed")


async def test_build_llm_messages_large_file_metadata_only():
    """Large files should always produce metadata text, never content blocks."""
    clear_file_cache()

    fp_dict = _make_file_pointer_dict(
        file_id="big-1", filename="huge.png", mime_type="image/png",
        size_bytes=INLINE_THRESHOLD + 1,
        storage_path="user-1/big-1_huge.png",
    )
    context = _make_context_with_file(fp_dict, text="Look at this")

    with patch("helpers.llm.activity.in_activity", return_value=False):
        messages = await build_llm_messages(
            context, "System prompt", pre_resolved_ids={"big-1"}
        )

    user_msgs = [m for m in messages if m["role"] == "user"]
    user_msg = user_msgs[0]

    if isinstance(user_msg["content"], list):
        text_content = " ".join(b.get("text", "") for b in user_msg["content"] if b.get("type") == "text")
        image_blocks = [b for b in user_msg["content"] if b.get("type") == "image_url"]
    else:
        text_content = user_msg["content"]
        image_blocks = []

    assert "cannot be directly read" in text_content, "Large file should show metadata text"
    assert len(image_blocks) == 0, "Large file should NOT produce image block"
    print("✅ test_build_llm_messages_large_file_metadata_only passed")


async def test_build_llm_messages_no_pre_resolved_workflow_fallback():
    """Without pre_resolved_ids and NOT in activity, files should be metadata-only."""
    clear_file_cache()

    fp_dict = _make_file_pointer_dict()
    context = _make_context_with_file(fp_dict)

    with patch("helpers.llm.activity.in_activity", return_value=False):
        messages = await build_llm_messages(
            context, "System prompt", pre_resolved_ids=None
        )

    user_msgs = [m for m in messages if m["role"] == "user"]
    user_msg = user_msgs[0]

    if isinstance(user_msg["content"], list):
        text_content = " ".join(b.get("text", "") for b in user_msg["content"] if b.get("type") == "text")
    else:
        text_content = user_msg["content"]

    assert "cannot be directly read" in text_content, "Without pre_resolved, should fall back to metadata"
    print("✅ test_build_llm_messages_no_pre_resolved_workflow_fallback passed")


async def test_build_llm_messages_assistant_file_pointer():
    """ASSISTANT messages with file_pointers should also resolve file content (not just USER)."""
    clear_file_cache()

    fp_dict = _make_file_pointer_dict(
        file_id="assistant-text-1", filename="result.json", mime_type="application/json",
        size_bytes=500, storage_path="user/assistant-text-1_result.json",
    )

    # Simulate sub-agent output: ASSISTANT message with file_pointer, empty text
    context = [
        {"role": "USER", "text": "Process the CSV", "timestamp": "2024-01-15T10:30:00Z"},
        {"role": "ASSISTANT", "text": "", "file_pointer": fp_dict, "timestamp": "2024-01-15T10:30:01Z"},
    ]

    # Pre-cache the file
    json_content = b'{"contacts": [{"name": "Alice"}]}'
    _file_cache["assistant-text-1"] = (json_content, {})
    pre_resolved = {"assistant-text-1"}

    with patch("helpers.llm.activity.in_activity", return_value=False):
        messages = await build_llm_messages(
            context, "System prompt", pre_resolved_ids=pre_resolved
        )

    assistant_msgs = [m for m in messages if m["role"] == "assistant"]
    assert len(assistant_msgs) == 1, f"Expected 1 assistant msg, got {len(assistant_msgs)}"

    assistant_msg = assistant_msgs[0]
    if isinstance(assistant_msg["content"], list):
        text_content = " ".join(b.get("text", "") for b in assistant_msg["content"] if b.get("type") == "text")
    else:
        text_content = assistant_msg["content"]

    assert "result.json" in text_content, "Should contain filename"
    assert "Alice" in text_content, "Should contain actual file content, not just metadata"
    assert "cannot be directly read" not in text_content, "Should NOT fall back to metadata for small readable file"
    print("✅ test_build_llm_messages_assistant_file_pointer passed")


async def test_no_files_returns_empty_list():
    """Context with no file_pointers should produce empty extraction."""
    clear_file_cache()

    context = [
        {"role": "USER", "text": "Hello", "timestamp": "2024-01-15T10:30:00Z"},
        {"role": "ASSISTANT", "text": "Hi there!", "timestamp": "2024-01-15T10:30:01Z"},
    ]

    file_pointers = extract_file_pointer_dicts(context)
    assert file_pointers == [], f"Expected empty list, got {file_pointers}"
    print("✅ test_no_files_returns_empty_list passed")


async def test_call_llm_activity_builds_messages_from_shared_state():
    """call_llm_activity should build messages from _pending_llm_context when given an agent_id string."""
    clear_file_cache()

    fp_dict = _make_file_pointer_dict()
    context = _make_context_with_file(fp_dict, text="Analyze this image")

    # Populate cache (simulating resolve_attachments_activity)
    _file_cache["file-123"] = (FAKE_IMAGE_BYTES, {"file_name": "photo.png"})

    # Store context in shared state (simulating what run_agent does)
    _pending_llm_context["test-agent-123"] = (context, "System prompt", {"file-123"})

    # Mock the LLM call itself — we just want to verify messages are built correctly
    captured_messages = []

    async def mock_call_llm(*args, **kwargs):
        captured_messages.append(kwargs.get("messages") or args[0])
        # Return a minimal valid result
        result = MagicMock()
        result.response = "Test response"
        result.tool_calls = []
        return result, {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}, []

    with patch("helpers.llm.call_llm_structured_streaming", side_effect=mock_call_llm):
        with patch("helpers.llm.create_agent_action_model", return_value=MagicMock):
            with patch("helpers.llm.stream_assistant_chunk", new_callable=AsyncMock):
                result = await call_llm_activity(
                    "test-agent-123",  # agent_id string triggers shared state path
                    "test-model",
                    ["web_search"],
                    256,
                    "test-agent-123",
                    "stream-1",
                    None,
                    None,
                )

    assert result["response"] == "Test response"
    assert len(captured_messages) == 1

    # Verify the messages contain actual image content (not metadata fallback)
    msgs = captured_messages[0]
    user_msgs = [m for m in msgs if m["role"] == "user"]
    assert len(user_msgs) == 1
    user_content = user_msgs[0]["content"]
    assert isinstance(user_content, list), "Should be multimodal array"

    image_blocks = [b for b in user_content if b.get("type") == "image_url"]
    assert len(image_blocks) == 1, "Should have image content from cache"

    # Verify shared state was cleaned up
    assert "test-agent-123" not in _pending_llm_context, "Should clean up after success"
    print("✅ test_call_llm_activity_builds_messages_from_shared_state passed")


async def run_all_tests():
    """Run all attachment tests."""
    try:
        await test_resolve_attachments_downloads_and_caches()
        await test_resolve_attachments_cache_hit_no_redownload()
        await test_resolve_attachments_skips_large_files()
        await test_resolve_attachments_skips_binary_files()
        await test_build_llm_messages_image_from_cache()
        await test_build_llm_messages_text_file_from_cache()
        await test_build_llm_messages_pdf_from_cache()
        await test_build_llm_messages_large_file_metadata_only()
        await test_build_llm_messages_no_pre_resolved_workflow_fallback()
        await test_build_llm_messages_assistant_file_pointer()
        await test_no_files_returns_empty_list()
        await test_call_llm_activity_builds_messages_from_shared_state()

        print("\n✅ All attachment tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Attachment test failed: {e}")
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)
