"""Blackbox tests for context_pointers domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


def test_parse_pointers_single():
    """parse_pointers extracts a single @ref:message pointer."""
    from helpers.context_pointers import parse_pointers

    text = "Check this: @ref:message:abcdef01-2345-6789-abcd-ef0123456789"
    pointers = parse_pointers(text)

    assert len(pointers) == 1
    assert pointers[0].id == "abcdef01-2345-6789-abcd-ef0123456789"
    assert pointers[0].start is None
    assert pointers[0].end is None


def test_parse_pointers_multiple():
    """parse_pointers extracts multiple pointers from text."""
    from helpers.context_pointers import parse_pointers

    text = (
        "First: @ref:message:11111111-1111-1111-1111-111111111111 "
        "and second: @ref:message:22222222-2222-2222-2222-222222222222"
    )
    pointers = parse_pointers(text)

    assert len(pointers) == 2
    assert pointers[0].id == "11111111-1111-1111-1111-111111111111"
    assert pointers[1].id == "22222222-2222-2222-2222-222222222222"


def test_parse_pointers_none():
    """parse_pointers returns empty list when no pointers in text."""
    from helpers.context_pointers import parse_pointers

    text = "No pointers here, just regular text."
    pointers = parse_pointers(text)

    assert pointers == []


def test_parse_pointers_with_slice():
    """parse_pointers extracts pointer with start/end slice anchors."""
    from helpers.context_pointers import parse_pointers

    text = '@ref:message:abcdef01-2345-6789-abcd-ef0123456789[start="Hello"|end="World"]'
    pointers = parse_pointers(text)

    assert len(pointers) == 1
    assert pointers[0].id == "abcdef01-2345-6789-abcd-ef0123456789"
    assert pointers[0].start == "Hello"
    assert pointers[0].end == "World"


def test_annotate_with_pointer_user():
    """annotate_with_pointer adds reference annotation to USER messages."""
    from helpers.context_pointers import annotate_with_pointer

    msg = {
        "message_id": "abcdef01-2345-6789-abcd-ef0123456789",
        "role": "USER",
        "text": "Book a restaurant",
    }
    annotate_with_pointer(msg)

    assert "@ref:message:abcdef01-2345-6789-abcd-ef0123456789" in msg["text"]
    assert msg["text"].startswith("Book a restaurant")


def test_annotate_with_pointer_tool_finished():
    """annotate_with_pointer adds reference to TOOL messages with FINISHED status."""
    from helpers.context_pointers import annotate_with_pointer

    msg = {
        "message_id": "abcdef01-2345-6789-abcd-ef0123456789",
        "role": "TOOL",
        "text": "Found 3 restaurants",
        "metadata": {"toolStatus": "FINISHED"},
    }
    annotate_with_pointer(msg)

    assert "@ref:message:abcdef01-2345-6789-abcd-ef0123456789" in msg["text"]


def test_annotate_with_pointer_idempotent():
    """annotate_with_pointer does not double-annotate."""
    from helpers.context_pointers import annotate_with_pointer

    msg = {
        "message_id": "abcdef01-2345-6789-abcd-ef0123456789",
        "role": "USER",
        "text": "Already has @ref:message:abcdef01-2345-6789-abcd-ef0123456789",
    }
    annotate_with_pointer(msg)

    # Should not add a second annotation
    count = msg["text"].count("@ref:message:abcdef01-2345-6789-abcd-ef0123456789")
    assert count == 1


def test_annotate_with_pointer_skips_assistant():
    """annotate_with_pointer skips ASSISTANT messages."""
    from helpers.context_pointers import annotate_with_pointer

    msg = {
        "message_id": "abcdef01-2345-6789-abcd-ef0123456789",
        "role": "ASSISTANT",
        "text": "I will help you",
    }
    annotate_with_pointer(msg)

    assert "@ref:message:" not in msg["text"]


async def run_all_tests():
    print("context-pointers blackbox tests:")
    r = BlackboxResult()
    r.record("parse_pointers_single", test_parse_pointers_single)
    r.record("parse_pointers_multiple", test_parse_pointers_multiple)
    r.record("parse_pointers_none", test_parse_pointers_none)
    r.record("parse_pointers_with_slice", test_parse_pointers_with_slice)
    r.record("annotate_with_pointer_user", test_annotate_with_pointer_user)
    r.record("annotate_with_pointer_tool_finished", test_annotate_with_pointer_tool_finished)
    r.record("annotate_with_pointer_idempotent", test_annotate_with_pointer_idempotent)
    r.record("annotate_with_pointer_skips_assistant", test_annotate_with_pointer_skips_assistant)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
