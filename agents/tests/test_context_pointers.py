"""Tests for context_pointers module — pointer parsing, emission, slicing, resolution."""

import asyncio
import pytest
from unittest.mock import AsyncMock, patch

from helpers.context_pointers import (
    Pointer,
    parse_pointers,
    annotate_with_pointer,
    _apply_slice,
    _resolve_from_local_context,
    resolve_pointers_in_text,
    resolve_pointers_in_messages,
)


# ============================================================
# parse_pointers
# ============================================================

class TestParsePointers:
    def test_full_pointer(self):
        text = "See @ref:message:abcdef01-2345-6789-abcd-ef0123456789 for details"
        pointers = parse_pointers(text)
        assert len(pointers) == 1
        assert pointers[0].id == "abcdef01-2345-6789-abcd-ef0123456789"
        assert pointers[0].start is None
        assert pointers[0].end is None
        assert pointers[0].raw == "@ref:message:abcdef01-2345-6789-abcd-ef0123456789"

    def test_sliced_pointer(self):
        text = '@ref:message:abcdef01-2345-6789-abcd-ef0123456789[start="John Smith"|end="555-1234"]'
        pointers = parse_pointers(text)
        assert len(pointers) == 1
        assert pointers[0].id == "abcdef01-2345-6789-abcd-ef0123456789"
        assert pointers[0].start == "John Smith"
        assert pointers[0].end == "555-1234"

    def test_multiple_pointers(self):
        text = (
            "First: @ref:message:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee "
            "Second: @ref:message:11111111-2222-3333-4444-555555555555"
        )
        pointers = parse_pointers(text)
        assert len(pointers) == 2
        assert pointers[0].id == "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        assert pointers[1].id == "11111111-2222-3333-4444-555555555555"

    def test_no_pointers(self):
        assert parse_pointers("No references here") == []
        assert parse_pointers("") == []

    def test_malformed_pointer(self):
        # ID too short
        assert parse_pointers("@ref:message:abc") == []
        # Not a valid UUID format
        assert parse_pointers("@ref:message:not-a-valid-uuid-format-here") == []


# ============================================================
# annotate_with_pointer
# ============================================================

class TestAnnotateWithPointer:
    def test_user_message_gets_annotation(self):
        msg = {"message_id": "abc-123-def-456-00000000000000000000", "role": "USER", "text": "Hello"}
        annotate_with_pointer(msg)
        assert "@ref:message:abc-123-def-456-00000000000000000000" in msg["text"]
        assert msg["text"].endswith("\n\nReference: @ref:message:abc-123-def-456-00000000000000000000")

    def test_tool_finished_gets_annotation(self):
        msg = {
            "message_id": "abc-123-def-456-00000000000000000000",
            "role": "TOOL",
            "text": "Result data",
            "metadata": {"toolStatus": "FINISHED"},
        }
        annotate_with_pointer(msg)
        assert "@ref:message:abc-123-def-456-00000000000000000000" in msg["text"]

    def test_tool_in_progress_not_annotated(self):
        msg = {
            "message_id": "abc-123-def-456-00000000000000000000",
            "role": "TOOL",
            "text": "Loading...",
            "metadata": {"toolStatus": "IN_PROGRESS"},
        }
        annotate_with_pointer(msg)
        assert "@ref:message:" not in msg["text"]

    def test_assistant_not_annotated(self):
        msg = {"message_id": "abc-123-def-456-00000000000000000000", "role": "ASSISTANT", "text": "I think..."}
        annotate_with_pointer(msg)
        assert "@ref:message:" not in msg["text"]

    def test_idempotent(self):
        msg = {"message_id": "abc-123-def-456-00000000000000000000", "role": "USER", "text": "Hello"}
        annotate_with_pointer(msg)
        text_after_first = msg["text"]
        annotate_with_pointer(msg)
        assert msg["text"] == text_after_first

    def test_no_message_id(self):
        msg = {"role": "USER", "text": "Hello"}
        annotate_with_pointer(msg)
        assert msg["text"] == "Hello"

    def test_empty_text(self):
        msg = {"message_id": "abc-123-def-456-00000000000000000000", "role": "USER", "text": ""}
        annotate_with_pointer(msg)
        assert msg["text"] == ""


# ============================================================
# _apply_slice
# ============================================================

class TestApplySlice:
    def test_start_and_end_match(self):
        text = "Please send $4,200 to John Smith at john@example.com by Friday"
        result = _apply_slice(text, "$4,200 to", "john@example.com")
        assert result == "$4,200 to John Smith at john@example.com"

    def test_no_start_returns_full(self):
        text = "Some text"
        assert _apply_slice(text, None, "end") == text

    def test_no_end_returns_full(self):
        text = "Some text"
        assert _apply_slice(text, "start", None) == text

    def test_start_not_found_returns_full(self):
        text = "Some text here"
        assert _apply_slice(text, "MISSING", "here") == text

    def test_end_not_found_returns_full(self):
        text = "Some text here"
        assert _apply_slice(text, "Some", "MISSING") == text

    def test_both_none_returns_full(self):
        text = "Some text"
        assert _apply_slice(text, None, None) == text


# ============================================================
# _resolve_from_local_context
# ============================================================

class TestResolveFromLocalContext:
    def test_found_user_message(self):
        ctx = [{"message_id": "id1", "role": "USER", "text": "Hello world"}]
        assert _resolve_from_local_context("id1", ctx) == "Hello world"

    def test_found_tool_message(self):
        ctx = [{"message_id": "id2", "role": "TOOL", "text": "Search results"}]
        assert _resolve_from_local_context("id2", ctx) == "Search results"

    def test_assistant_rejected(self):
        ctx = [{"message_id": "id3", "role": "ASSISTANT", "text": "I think..."}]
        assert _resolve_from_local_context("id3", ctx) is None

    def test_not_found(self):
        ctx = [{"message_id": "id1", "role": "USER", "text": "Hello"}]
        assert _resolve_from_local_context("id999", ctx) is None

    def test_empty_context(self):
        assert _resolve_from_local_context("id1", []) is None
        assert _resolve_from_local_context("id1", None) is None


# ============================================================
# resolve_pointers_in_text
# ============================================================

class TestResolvePointersInText:
    def test_resolves_from_local_context(self):
        local = [{"message_id": "abcdef01-2345-6789-abcd-ef0123456789", "role": "USER", "text": "Call John at 555-1234"}]
        text = "Do this: @ref:message:abcdef01-2345-6789-abcd-ef0123456789"

        result = asyncio.get_event_loop().run_until_complete(
            resolve_pointers_in_text(text, local_context=local)
        )
        assert '<resolved-ref pointer="@ref:message:abcdef01-2345-6789-abcd-ef0123456789">' in result
        assert "Call John at 555-1234" in result
        assert "</resolved-ref>" in result

    def test_strips_annotation_from_resolved_text(self):
        """Resolved text should not contain the annotation suffix."""
        msg_id = "abcdef01-2345-6789-abcd-ef0123456789"
        annotated_text = f"Hello world\n\nReference: @ref:message:{msg_id}"
        local = [{"message_id": msg_id, "role": "USER", "text": annotated_text}]
        text = f"See @ref:message:{msg_id}"

        result = asyncio.get_event_loop().run_until_complete(
            resolve_pointers_in_text(text, local_context=local)
        )
        assert "Hello world" in result
        assert f"Reference: @ref:message:{msg_id}" not in result

    def test_missing_pointer_left_in_place(self):
        text = "See @ref:message:abcdef01-2345-6789-abcd-ef0123456789"

        with patch("helpers.context_pointers._fetch_messages_batch", new_callable=AsyncMock) as mock_fetch:
            mock_fetch.return_value = {"abcdef01-2345-6789-abcd-ef0123456789": None}
            result = asyncio.get_event_loop().run_until_complete(
                resolve_pointers_in_text(text, local_context=[])
            )
        assert result == text  # Left unchanged

    def test_sliced_resolution(self):
        local = [{"message_id": "abcdef01-2345-6789-abcd-ef0123456789", "role": "USER", "text": "Send $100 to John Smith at john@example.com by Friday"}]
        text = '@ref:message:abcdef01-2345-6789-abcd-ef0123456789[start="$100 to"|end="john@example.com"]'

        result = asyncio.get_event_loop().run_until_complete(
            resolve_pointers_in_text(text, local_context=local)
        )
        assert "$100 to John Smith at john@example.com" in result
        assert "by Friday" not in result

    def test_no_pointers_unchanged(self):
        text = "Just regular text"
        result = asyncio.get_event_loop().run_until_complete(
            resolve_pointers_in_text(text)
        )
        assert result == text


# ============================================================
# resolve_pointers_in_messages
# ============================================================

class TestResolvePointersInMessages:
    def test_string_content(self):
        local = [{"message_id": "abcdef01-2345-6789-abcd-ef0123456789", "role": "USER", "text": "Original text"}]
        messages = [
            {"role": "user", "content": "Check @ref:message:abcdef01-2345-6789-abcd-ef0123456789"},
        ]
        result = asyncio.get_event_loop().run_until_complete(
            resolve_pointers_in_messages(messages, local_context=local)
        )
        assert "<resolved-ref" in result[0]["content"]

    def test_list_of_blocks_content(self):
        local = [{"message_id": "abcdef01-2345-6789-abcd-ef0123456789", "role": "USER", "text": "Original text"}]
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Check @ref:message:abcdef01-2345-6789-abcd-ef0123456789"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
                ],
            },
        ]
        result = asyncio.get_event_loop().run_until_complete(
            resolve_pointers_in_messages(messages, local_context=local)
        )
        # Text block should be resolved
        text_block = [b for b in result[0]["content"] if b.get("type") == "text"][0]
        assert "<resolved-ref" in text_block["text"]
        # Image block should be unchanged
        img_block = [b for b in result[0]["content"] if b.get("type") == "image_url"][0]
        assert img_block["image_url"]["url"] == "data:image/png;base64,abc"

    def test_no_pointers_unchanged(self):
        messages = [
            {"role": "user", "content": "No pointers here"},
            {"role": "assistant", "content": "Also no pointers"},
        ]
        result = asyncio.get_event_loop().run_until_complete(
            resolve_pointers_in_messages(messages)
        )
        # Should return original message objects (not copies) when unchanged
        assert result[0] is messages[0]
        assert result[1] is messages[1]

    def test_none_content_preserved(self):
        messages = [{"role": "assistant", "content": None}]
        result = asyncio.get_event_loop().run_until_complete(
            resolve_pointers_in_messages(messages)
        )
        assert result[0] is messages[0]
