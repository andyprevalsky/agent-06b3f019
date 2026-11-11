"""Blackbox tests for tools/base.py domain (pure helpers + dataclasses)."""

import asyncio
import json

from _test_utils import BlackboxResult, teardown_mock


def test_format_time_elapsed_seconds():
    """format_time_elapsed formats seconds only."""
    from tools.base import format_time_elapsed

    assert format_time_elapsed(0) == "0s"
    assert format_time_elapsed(29) == "29s"
    assert format_time_elapsed(59) == "59s"


def test_format_time_elapsed_minutes():
    """format_time_elapsed formats minutes and seconds."""
    from tools.base import format_time_elapsed

    assert format_time_elapsed(60) == "1m 0s"
    assert format_time_elapsed(206) == "3m 26s"


def test_format_time_elapsed_hours():
    """format_time_elapsed formats hours, minutes, seconds."""
    from tools.base import format_time_elapsed

    assert format_time_elapsed(3808) == "1hr 3m 28s"
    assert format_time_elapsed(3600) == "1hr 0m 0s"


def test_format_params_none():
    """format_params with empty dict returns 'None'."""
    from tools.base import format_params

    assert format_params({}) == "None"


def test_format_params_skips_internal_fields():
    """format_params skips 'tool' and 'tool_call_id' keys."""
    from tools.base import format_params

    result = format_params({"tool": "web_search", "tool_call_id": "tc-1", "query": "hello"})
    # tool + tool_call_id filtered out; only 'query: hello'
    assert "tool" not in result or "web_search" not in result
    assert "tool_call_id" not in result
    assert "query" in result
    assert "hello" in result


def test_format_params_dict_value():
    """format_params formats dict values as JSON."""
    from tools.base import format_params

    result = format_params({"filters": {"region": "us", "limit": 5}})
    assert "filters" in result
    assert "region" in result
    assert "us" in result


def test_format_params_list_value():
    """format_params formats list values as JSON."""
    from tools.base import format_params

    result = format_params({"items": ["a", "b", "c"]})
    assert "items" in result
    assert "a" in result


def test_format_params_only_internal_returns_none():
    """format_params with only internal fields returns 'None'."""
    from tools.base import format_params

    result = format_params({"tool": "web_search", "tool_call_id": "tc-1"})
    assert result == "None"


def test_format_result_empty():
    """format_result with empty dict returns 'No result data'."""
    from tools.base import format_result

    assert format_result({}) == "No result data"


def test_format_result_answer():
    """format_result includes 'answer' field."""
    from tools.base import format_result

    result = format_result({"answer": "The sky is blue"})
    assert "The sky is blue" in result


def test_format_result_content_without_answer():
    """format_result uses 'content' if 'answer' missing."""
    from tools.base import format_result

    result = format_result({"content": "Some content here"})
    assert "Some content here" in result


def test_format_result_candidates():
    """format_result lists candidates."""
    from tools.base import format_result

    result = format_result({"candidates": [{"name": "Alice"}, {"name": "Bob"}]})
    assert "Found 2 candidates" in result
    assert "Alice" in result
    assert "Bob" in result


def test_format_result_sources():
    """format_result renders sources list."""
    from tools.base import format_result

    result = format_result({"answer": "x", "sources": ["http://a", "http://b"]})
    assert "Sources" in result
    assert "http://a" in result
    assert "http://b" in result


def test_format_result_images_and_links():
    """format_result renders images and links."""
    from tools.base import format_result

    result = format_result(
        {
            "answer": "ok",
            "images": ["img1.png", "img2.png"],
            "links": ["link1", "link2"],
        }
    )
    assert "Images (2)" in result
    assert "img1.png" in result
    assert "Links (2)" in result
    assert "link1" in result


def test_format_result_output_content_dict():
    """format_result renders output.content as key/value pairs."""
    from tools.base import format_result

    result = format_result({"output": {"content": {"name": "acme", "year": 2024}}})
    assert "Extracted Data" in result
    assert "name: acme" in result
    assert "year: 2024" in result


def test_format_result_message_history():
    """format_result renders message history block."""
    from tools.base import format_result

    result = format_result(
        {
            "messages": "USER: hello\nASSISTANT: hi",
            "message_count": 2,
            "person": {"firstName": "Ada", "lastName": "Lovelace", "email": "ada@x", "phoneNumber": "+1"},
        }
    )
    assert "Ada Lovelace" in result
    assert "Message Count" in result
    assert "USER: hello" in result


def test_format_result_services():
    """format_result renders x402 services list."""
    from tools.base import format_result

    services = [
        {
            "resource": "https://api.example.com/search",
            "price_display": "$0.05",
            "method": "POST",
            "network": "base",
            "input_schema": {
                "queryParams": {
                    "q": {"required": True},
                    "limit": {"required": False},
                }
            },
            "metadata": {"description": "Premium search"},
        }
    ]
    result = format_result({"services": services, "service_count": 1})
    assert "https://api.example.com/search" in result
    assert "Price: $0.05" in result
    assert "q (required)" in result
    assert "Premium search" in result


def test_format_result_services_empty():
    """format_result renders 'No services found' message when empty."""
    from tools.base import format_result

    result = format_result({"services": [], "service_count": 0})
    assert "No services found" in result


def test_format_result_fallback_json():
    """format_result falls back to full JSON when no special fields."""
    from tools.base import format_result

    result = format_result({"random": "value", "nested": {"k": 1}})
    # should be valid JSON
    parsed = json.loads(result)
    assert parsed["random"] == "value"
    assert parsed["nested"]["k"] == 1


def test_format_tool_message():
    """format_tool_message combines params, result, time, cost."""
    from tools.base import format_tool_message

    msg = format_tool_message({"query": "hello"}, {"answer": "world"}, 45.0, 123.0)
    assert "**Params Passed:**" in msg
    assert "query" in msg
    assert "**Result:**" in msg
    assert "world" in msg
    assert "45s" in msg
    assert "$1.2300" in msg


def test_extract_root_error_plain_exception():
    """extract_root_error on plain Exception returns str(exception)."""
    from tools.base import extract_root_error

    err = ValueError("oops")
    assert extract_root_error(err) == "oops"


def test_extract_root_error_application_error():
    """extract_root_error returns ApplicationError.message directly."""
    from temporalio.exceptions import ApplicationError

    from tools.base import extract_root_error

    err = ApplicationError("Real error")
    assert extract_root_error(err) == "Real error"


def test_format_error_message_with_params():
    """format_error_message formats params + error with elapsed and cost."""
    from tools.base import format_error_message

    result = format_error_message({"q": "x"}, ValueError("boom"), 12.0, cost_cents=50)
    assert "**Params Passed:**" in result
    assert "**Error:**" in result
    assert "boom" in result
    assert "12s" in result
    assert "$0.5000" in result


def test_format_error_message_parses_json_api_error():
    """format_error_message extracts API error message from Parallel-style JSON."""
    from tools.base import format_error_message

    err = Exception('HTTP error 400 {"type":"error","error":{"message":"Rate limited"}}')
    result = format_error_message({"q": "x"}, err, 5.0)
    assert "Rate limited" in result


def test_usage_item_to_dict():
    """UsageItem.to_dict serializes all fields."""
    from tools.base import UsageItem, UsageType

    item = UsageItem(
        type=UsageType.LLM,
        cost_cents=25,
        provider="Perplexity Input Tokens",
        number_of_tokens=1000,
        token_price_per_million_cents=200,
        tokens_in=800,
        tokens_out=200,
    )
    d = item.to_dict()
    assert d["type"] == "llm"
    assert d["cost_cents"] == 25
    assert d["provider"] == "Perplexity Input Tokens"
    assert d["number_of_tokens"] == 1000
    assert d["token_price_per_million_cents"] == 200
    assert d["tokens_in"] == 800
    assert d["tokens_out"] == 200


def test_tool_event_to_dict_basic():
    """ToolEvent.to_dict serializes core fields."""
    from tools.base import EventType, MessageStatus, ToolEvent

    event = ToolEvent(
        type=EventType.POST_MESSAGE,
        title="Hello",
        message="World",
        status=MessageStatus.IN_PROGRESS,
    )
    d = event.to_dict()
    assert d["type"] == "post_message"
    assert d["title"] == "Hello"
    assert d["message"] == "World"
    assert d["status"] == "IN_PROGRESS"
    assert d["usage_items"] is None


def test_tool_event_to_dict_with_usage_items():
    """ToolEvent.to_dict serializes nested usage_items."""
    from tools.base import EventType, ToolEvent, UsageItem, UsageType

    event = ToolEvent(
        type=EventType.USAGE,
        tool_name="web_search",
        usage_items=[UsageItem(type=UsageType.SERVICE, cost_cents=1, provider="Brave")],
    )
    d = event.to_dict()
    assert d["tool_name"] == "web_search"
    assert d["usage_items"] is not None
    assert len(d["usage_items"]) == 1
    assert d["usage_items"][0]["provider"] == "Brave"


def test_tool_event_to_dict_with_status_none():
    """ToolEvent.to_dict handles status=None gracefully."""
    from tools.base import EventType, ToolEvent

    event = ToolEvent(type=EventType.STREAM_MESSAGE, stream_id="s1", delta="hello")
    d = event.to_dict()
    assert d["type"] == "stream_message"
    assert d["status"] is None


def test_tool_manager_abstract_cannot_instantiate():
    """ToolManager is abstract; cannot instantiate without execute_tool + tool_name."""
    from tools.base import ToolManager

    try:
        ToolManager()  # type: ignore[abstract]
        raise AssertionError("Should have raised TypeError for abstract class")
    except TypeError:
        pass


def test_tool_manager_yield_in_progress_and_defaults():
    """Concrete subclass can yield IN_PROGRESS event and tool_name default title."""
    from tools.base import EventType, MessageStatus, ToolEvent, ToolManager

    class MyTool(ToolManager):
        @property
        def tool_name(self) -> str:
            return "my_tool"

        async def execute_tool(self, workflow_instance, tool_call, tool_call_id):
            yield self.yield_in_progress()

    tool = MyTool()
    event = tool.yield_in_progress()
    assert isinstance(event, ToolEvent)
    assert event.type == EventType.POST_MESSAGE
    assert event.status == MessageStatus.IN_PROGRESS
    assert "my_tool" in (event.title or "")

    # Explicit title/message override default
    event2 = tool.yield_in_progress(title="Custom", message="msg")
    assert event2.title == "Custom"
    assert event2.message == "msg"


def test_tool_manager_get_approval_question_not_implemented():
    """Default get_approval_question raises NotImplementedError."""
    from tools.base import ToolManager

    class NeedsApproval(ToolManager):
        requires_approval = True

        @property
        def tool_name(self) -> str:
            return "needs_approval"

        async def execute_tool(self, workflow_instance, tool_call, tool_call_id):
            yield

    t = NeedsApproval()
    try:
        t.get_approval_question({"param": "value"})
        raise AssertionError("Expected NotImplementedError")
    except NotImplementedError as e:
        assert "get_approval_question" in str(e)


def test_grep_shared_provenance_survives_transcript_formatting():
    from tools.base import format_tool_message
    result = {"matches": [
        {"source": "messages", "path": "messages/a/one", "content": "Investor sent email", "ownership": {"owner_user_id": "owner-a", "account_id": "work-a@example.test", "team_ids": ["atlas", "orbit"], "provider": "gmail", "shared": True, "owner_name": "A", "unexpected_token": "MUST_NOT_EXPOSE"}, "records": [{"message_id": "one", "owner_user_id": "owner-a", "account_id": "work-a@example.test"}]},
        {"source": "messages", "path": "messages/b/two", "content": "Investor sent email", "ownership": {"owner_user_id": "owner-b", "account_id": "work-b@example.test", "team_ids": ["orbit"], "provider": "gmail", "shared": True, "owner_name": "B"}, "records": [{"message_id": "two", "owner_user_id": "owner-b", "account_id": "work-b@example.test"}]},
    ], "total_matches": 2}
    text = format_tool_message({}, result, 0.1, 0)
    for value in ["owner_user_id", "owner-a", "owner-b", "account_id", "work-a@example.test", "work-b@example.test", "team_ids", "atlas", "orbit", "message_id", "one", "two"]:
        assert value in text, f"Grep transcript dropped {value}"
    assert "MUST_NOT_EXPOSE" not in text


async def run_all_tests():
    print("tools-base blackbox tests:")
    r = BlackboxResult()
    r.record("format_time_elapsed_seconds", test_format_time_elapsed_seconds)
    r.record("format_time_elapsed_minutes", test_format_time_elapsed_minutes)
    r.record("format_time_elapsed_hours", test_format_time_elapsed_hours)
    r.record("format_params_none", test_format_params_none)
    r.record("format_params_skips_internal_fields", test_format_params_skips_internal_fields)
    r.record("format_params_dict_value", test_format_params_dict_value)
    r.record("format_params_list_value", test_format_params_list_value)
    r.record("format_params_only_internal_returns_none", test_format_params_only_internal_returns_none)
    r.record("format_result_empty", test_format_result_empty)
    r.record("format_result_answer", test_format_result_answer)
    r.record("format_result_content_without_answer", test_format_result_content_without_answer)
    r.record("format_result_candidates", test_format_result_candidates)
    r.record("format_result_sources", test_format_result_sources)
    r.record("format_result_images_and_links", test_format_result_images_and_links)
    r.record("format_result_output_content_dict", test_format_result_output_content_dict)
    r.record("format_result_message_history", test_format_result_message_history)
    r.record("format_result_services", test_format_result_services)
    r.record("format_result_services_empty", test_format_result_services_empty)
    r.record("format_result_fallback_json", test_format_result_fallback_json)
    r.record("format_tool_message", test_format_tool_message)
    r.record("grep_shared_provenance", test_grep_shared_provenance_survives_transcript_formatting)
    r.record("extract_root_error_plain_exception", test_extract_root_error_plain_exception)
    r.record("extract_root_error_application_error", test_extract_root_error_application_error)
    r.record("format_error_message_with_params", test_format_error_message_with_params)
    r.record("format_error_message_parses_json_api_error", test_format_error_message_parses_json_api_error)
    r.record("usage_item_to_dict", test_usage_item_to_dict)
    r.record("tool_event_to_dict_basic", test_tool_event_to_dict_basic)
    r.record("tool_event_to_dict_with_usage_items", test_tool_event_to_dict_with_usage_items)
    r.record("tool_event_to_dict_with_status_none", test_tool_event_to_dict_with_status_none)
    r.record("tool_manager_abstract_cannot_instantiate", test_tool_manager_abstract_cannot_instantiate)
    r.record("tool_manager_yield_in_progress_and_defaults", test_tool_manager_yield_in_progress_and_defaults)
    r.record("tool_manager_get_approval_question_not_implemented", test_tool_manager_get_approval_question_not_implemented)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
