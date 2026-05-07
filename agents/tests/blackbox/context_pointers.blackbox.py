"""Blackbox tests for context_pointers domain."""

import asyncio

import httpx

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    setup_mock_fn,
    teardown_mock,
)


def _clear_cache():
    """Clear the module-level message cache between tests."""
    import sys
    mod = sys.modules.get("helpers.context_pointers")
    if mod is None:
        import importlib
        mod = importlib.import_module("helpers.context_pointers")
    mod._message_cache.clear()


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


def test_annotate_with_pointer_missing_id():
    """annotate_with_pointer no-ops when message_id missing."""
    from helpers.context_pointers import annotate_with_pointer

    msg = {"role": "USER", "text": "Hi"}
    annotate_with_pointer(msg)
    assert msg["text"] == "Hi"


def test_annotate_with_pointer_empty_text():
    """annotate_with_pointer no-ops when text is empty."""
    from helpers.context_pointers import annotate_with_pointer

    msg = {"message_id": "abcdef01-2345-6789-abcd-ef0123456789", "role": "USER", "text": ""}
    annotate_with_pointer(msg)
    assert msg["text"] == ""


async def test_resolve_pointers_in_text_no_pointers():
    """resolve_pointers_in_text returns text unchanged when no pointers."""
    from helpers.context_pointers import resolve_pointers_in_text

    text = "Plain text"
    result = await resolve_pointers_in_text(text)
    assert result == text


async def test_resolve_pointers_in_text_from_local_context():
    """resolve_pointers_in_text resolves from local_context first."""
    _clear_cache()
    from helpers.context_pointers import resolve_pointers_in_text

    local_context = [
        {
            "message_id": "abcdef01-2345-6789-abcd-ef0123456789",
            "role": "USER",
            "text": "Original user message",
        }
    ]
    text = "Ref: @ref:message:abcdef01-2345-6789-abcd-ef0123456789"
    result = await resolve_pointers_in_text(text, local_context)

    assert "<resolved-ref" in result
    assert "Original user message" in result
    # No network call for local context hit
    assert len(get_captured_requests()) == 0


async def test_resolve_pointers_in_text_skips_non_user_tool_role():
    """resolve_pointers_in_text doesn't resolve from assistant messages."""
    _clear_cache()

    def handler(req):
        # Batch fetch returns empty
        return httpx.Response(200, json={"messages": []})

    setup_mock_fn(handler)

    from helpers.context_pointers import resolve_pointers_in_text

    local_context = [
        {
            "message_id": "abcdef01-2345-6789-abcd-ef0123456789",
            "role": "ASSISTANT",
            "text": "Assistant text",
        }
    ]
    text = "Ref: @ref:message:abcdef01-2345-6789-abcd-ef0123456789"
    result = await resolve_pointers_in_text(text, local_context)

    # Resolution from local failed (role=ASSISTANT), tried DB, DB returned nothing → pointer stays
    assert "@ref:message:abcdef01-2345-6789-abcd-ef0123456789" in result


async def test_resolve_pointers_in_text_db_fetch():
    """resolve_pointers_in_text falls back to DB fetch when local misses."""
    _clear_cache()

    def handler(req):
        if "/api/agents/messages/batch" in str(req.url):
            return httpx.Response(200, json={
                "messages": [
                    {
                        "id": "aaaa0001-0000-0000-0000-000000000000",
                        "text": "Fetched from DB",
                        "role": "USER",
                    }
                ]
            })
        return httpx.Response(404)

    setup_mock_fn(handler)

    from helpers.context_pointers import resolve_pointers_in_text

    text = "Ref: @ref:message:aaaa0001-0000-0000-0000-000000000000"
    result = await resolve_pointers_in_text(text)

    assert "<resolved-ref" in result
    assert "Fetched from DB" in result


async def test_resolve_pointers_db_fetch_sends_user_scope():
    """DB fetch includes user scope when pointer resolution has user_id."""
    _clear_cache()
    captured = {}

    def handler(req):
        if "/api/agents/messages/batch" in str(req.url):
            import json as _json

            body = _json.loads(req.content.decode("utf-8"))
            captured["x_user_id"] = req.headers.get("x-user-id")
            captured["body_user_id"] = body.get("user_id")
            return httpx.Response(200, json={
                "messages": [
                    {
                        "id": "aaaa0003-0000-0000-0000-000000000000",
                        "text": "Fetched with user scope",
                        "role": "USER",
                    }
                ]
            })
        return httpx.Response(404)

    setup_mock_fn(handler)

    from helpers.context_pointers import resolve_pointers_in_text

    text = "Ref: @ref:message:aaaa0003-0000-0000-0000-000000000000"
    result = await resolve_pointers_in_text(text, user_id="user-123")

    assert "<resolved-ref" in result
    assert "Fetched with user scope" in result
    assert captured["x_user_id"] == "user-123"
    assert captured["body_user_id"] == "user-123"


async def test_resolve_pointers_in_text_db_missing():
    """resolve_pointers_in_text leaves pointer untouched when DB returns no match."""
    _clear_cache()

    def handler(req):
        if "/api/agents/messages/batch" in str(req.url):
            # Empty 200 response → negative cache
            return httpx.Response(200, json={"messages": []})
        return httpx.Response(404)

    setup_mock_fn(handler)

    from helpers.context_pointers import resolve_pointers_in_text

    text = "Ref: @ref:message:bbbb0001-0000-0000-0000-000000000000"
    result = await resolve_pointers_in_text(text)
    # Unresolvable pointer stays in place
    assert "@ref:message:bbbb0001-0000-0000-0000-000000000000" in result


async def test_resolve_pointers_db_failure_no_negative_cache():
    """DB 500 error should not negative-cache the miss."""
    _clear_cache()

    def handler(req):
        if "/api/agents/messages/batch" in str(req.url):
            return httpx.Response(500, json={"error": "boom"})
        return httpx.Response(404)

    setup_mock_fn(handler)

    from helpers.context_pointers import resolve_pointers_in_text, _message_cache

    text = "Ref: @ref:message:cccc0001-0000-0000-0000-000000000000"
    result = await resolve_pointers_in_text(text)
    # Pointer is left in place
    assert "@ref:message:cccc0001-0000-0000-0000-000000000000" in result
    # Not negative-cached (transient error)
    assert "cccc0001-0000-0000-0000-000000000000" not in _message_cache


async def test_resolve_pointers_db_exception_no_negative_cache():
    """DB exception should not negative-cache the miss."""
    _clear_cache()

    def handler(req):
        if "/api/agents/messages/batch" in str(req.url):
            raise RuntimeError("network err")
        return httpx.Response(404)

    setup_mock_fn(handler)

    from helpers.context_pointers import resolve_pointers_in_text, _message_cache

    text = "Ref: @ref:message:dddd0001-0000-0000-0000-000000000000"
    result = await resolve_pointers_in_text(text)
    assert "@ref:message:dddd0001-0000-0000-0000-000000000000" in result
    assert "dddd0001-0000-0000-0000-000000000000" not in _message_cache


async def test_resolve_pointers_with_slice():
    """resolve_pointers_in_text applies start/end slicing to resolved content."""
    _clear_cache()
    from helpers.context_pointers import resolve_pointers_in_text

    local_context = [
        {
            "message_id": "eeee0001-0000-0000-0000-000000000000",
            "role": "TOOL",
            "text": "prefix Hello big World suffix",
        }
    ]
    text = '@ref:message:eeee0001-0000-0000-0000-000000000000[start="Hello"|end="World"]'
    result = await resolve_pointers_in_text(text, local_context)

    assert "<resolved-ref" in result
    assert "Hello big World" in result
    assert "prefix" not in result


async def test_resolve_pointers_slice_missing_anchor():
    """resolve_pointers_in_text falls back to full text if slice anchor not found."""
    _clear_cache()
    from helpers.context_pointers import resolve_pointers_in_text

    local_context = [
        {
            "message_id": "ffff0001-0000-0000-0000-000000000000",
            "role": "TOOL",
            "text": "some body text",
        }
    ]
    text = '@ref:message:ffff0001-0000-0000-0000-000000000000[start="NOTFOUND"|end="World"]'
    result = await resolve_pointers_in_text(text, local_context)

    assert "<resolved-ref" in result
    assert "some body text" in result


async def test_resolve_pointers_slice_missing_end_anchor():
    """resolve_pointers_in_text falls back when end anchor not found."""
    _clear_cache()
    from helpers.context_pointers import resolve_pointers_in_text

    local_context = [
        {
            "message_id": "aaaa0002-0000-0000-0000-000000000000",
            "role": "TOOL",
            "text": "xxx Hello yyy",
        }
    ]
    text = '@ref:message:aaaa0002-0000-0000-0000-000000000000[start="Hello"|end="MISSING"]'
    result = await resolve_pointers_in_text(text, local_context)

    assert "<resolved-ref" in result
    # Falls back to full text because end anchor not found
    assert "xxx Hello yyy" in result


async def test_resolve_pointers_strip_existing_annotation():
    """resolve_pointers_in_text strips trailing Reference: annotation from resolved text."""
    _clear_cache()
    from helpers.context_pointers import resolve_pointers_in_text

    mid = "bbbb0002-0000-0000-0000-000000000000"
    local_context = [
        {
            "message_id": mid,
            "role": "USER",
            "text": f"Actual content\n\nReference: @ref:message:{mid}",
        }
    ]
    text = f"Ref: @ref:message:{mid}"
    result = await resolve_pointers_in_text(text, local_context)

    # Trailing annotation should be stripped in resolved content
    assert "<resolved-ref" in result
    assert "Actual content" in result
    # Resolved content should NOT contain the annotation (stripped)
    resolved_start = result.index("<resolved-ref")
    resolved_end = result.index("</resolved-ref>")
    inner = result[resolved_start:resolved_end]
    assert "Reference: @ref:message:" not in inner


async def test_resolve_pointers_in_messages_string_content():
    """resolve_pointers_in_messages resolves in string content."""
    _clear_cache()
    from helpers.context_pointers import resolve_pointers_in_messages

    mid = "cccc0002-0000-0000-0000-000000000000"
    local_context = [
        {"message_id": mid, "role": "USER", "text": "Original text"},
    ]
    messages = [
        {"role": "user", "content": f"See @ref:message:{mid}"},
        {"role": "assistant", "content": "OK"},
    ]
    resolved = await resolve_pointers_in_messages(messages, local_context)

    assert "<resolved-ref" in resolved[0]["content"]
    # Unchanged message is returned as-is
    assert resolved[1] is messages[1] or resolved[1] == messages[1]


async def test_resolve_pointers_in_messages_list_content():
    """resolve_pointers_in_messages handles list-of-blocks content."""
    _clear_cache()
    from helpers.context_pointers import resolve_pointers_in_messages

    mid = "dddd0002-0000-0000-0000-000000000000"
    local_context = [
        {"message_id": mid, "role": "TOOL", "text": "Tool result body"},
    ]
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": f"See @ref:message:{mid}"},
                {"type": "image_url", "image_url": {"url": "data:..."}},
            ],
        },
    ]
    resolved = await resolve_pointers_in_messages(messages, local_context)

    assert isinstance(resolved[0]["content"], list)
    assert "<resolved-ref" in resolved[0]["content"][0]["text"]
    # Non-text block passed through
    assert resolved[0]["content"][1]["type"] == "image_url"


async def test_resolve_pointers_in_messages_none_content():
    """resolve_pointers_in_messages passes through messages with None content."""
    from helpers.context_pointers import resolve_pointers_in_messages

    messages = [
        {"role": "tool", "content": None, "tool_call_id": "tc-1"},
    ]
    resolved = await resolve_pointers_in_messages(messages)

    assert resolved[0]["content"] is None


async def test_resolve_pointers_in_messages_unknown_content_type():
    """resolve_pointers_in_messages passes non-str/list content through."""
    from helpers.context_pointers import resolve_pointers_in_messages

    messages = [
        {"role": "user", "content": 42},  # unknown type
    ]
    resolved = await resolve_pointers_in_messages(messages)
    assert resolved[0]["content"] == 42


async def test_resolve_pointers_in_messages_no_change_returns_original():
    """If content has no pointers, message is returned unchanged."""
    from helpers.context_pointers import resolve_pointers_in_messages

    messages = [
        {"role": "user", "content": "Plain text"},
        {"role": "assistant", "content": [{"type": "text", "text": "No pointers here"}]},
    ]
    resolved = await resolve_pointers_in_messages(messages)

    assert resolved[0] == messages[0]
    assert resolved[1] == messages[1]


async def test_resolve_pointers_batch_chunking():
    """_fetch_messages_batch chunks requests at 50 per request."""
    _clear_cache()
    call_count = [0]

    def handler(req):
        url = str(req.url)
        if "/api/agents/messages/batch" in url:
            import json as _json
            body = _json.loads(req.content.decode("utf-8"))
            ids = body["ids"]
            call_count[0] += 1
            # Respond with matches for all requested IDs
            return httpx.Response(200, json={
                "messages": [{"id": mid, "text": f"msg {mid}", "role": "USER"} for mid in ids]
            })
        return httpx.Response(404)

    setup_mock_fn(handler)

    from helpers.context_pointers import _fetch_messages_batch

    # Build 75 unique message IDs (should chunk into 2 batches: 50 + 25)
    ids = [f"{i:08x}-0000-0000-0000-000000000000" for i in range(75)]
    result = await _fetch_messages_batch(ids)

    assert len(result) == 75
    assert call_count[0] == 2  # 2 batches


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
    r.record("annotate_with_pointer_missing_id", test_annotate_with_pointer_missing_id)
    r.record("annotate_with_pointer_empty_text", test_annotate_with_pointer_empty_text)
    await r.record_async("resolve_in_text_no_pointers", test_resolve_pointers_in_text_no_pointers)
    await r.record_async("resolve_in_text_from_local", test_resolve_pointers_in_text_from_local_context)
    await r.record_async("resolve_in_text_skips_assistant_local", test_resolve_pointers_in_text_skips_non_user_tool_role)
    await r.record_async("resolve_in_text_db_fetch", test_resolve_pointers_in_text_db_fetch)
    await r.record_async("resolve_in_text_db_fetch_user_scope", test_resolve_pointers_db_fetch_sends_user_scope)
    await r.record_async("resolve_in_text_db_missing", test_resolve_pointers_in_text_db_missing)
    await r.record_async("resolve_db_failure_no_neg_cache", test_resolve_pointers_db_failure_no_negative_cache)
    await r.record_async("resolve_db_exception_no_neg_cache", test_resolve_pointers_db_exception_no_negative_cache)
    await r.record_async("resolve_with_slice", test_resolve_pointers_with_slice)
    await r.record_async("resolve_slice_missing_anchor", test_resolve_pointers_slice_missing_anchor)
    await r.record_async("resolve_slice_missing_end_anchor", test_resolve_pointers_slice_missing_end_anchor)
    await r.record_async("resolve_strip_existing_annotation", test_resolve_pointers_strip_existing_annotation)
    await r.record_async("resolve_in_messages_string", test_resolve_pointers_in_messages_string_content)
    await r.record_async("resolve_in_messages_list", test_resolve_pointers_in_messages_list_content)
    await r.record_async("resolve_in_messages_none_content", test_resolve_pointers_in_messages_none_content)
    await r.record_async("resolve_in_messages_unknown_content", test_resolve_pointers_in_messages_unknown_content_type)
    await r.record_async("resolve_in_messages_no_change", test_resolve_pointers_in_messages_no_change_returns_original)
    await r.record_async("resolve_batch_chunking", test_resolve_pointers_batch_chunking)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
