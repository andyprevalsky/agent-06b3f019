"""Blackbox tests for knowledge-base domain."""

import asyncio
import json
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


def _setup():
    setup_mock({
        "/api/blueprints/search": {
            "status": 200,
            "json": [
                {"id": "bp-1", "title": "Book a flight", "blueprint": "STATUS: SUCCESS\nTRAJECTORY:\n  t:0  web_search"},
                {"id": "bp-2", "title": "Send an email", "blueprint": "STATUS: SUCCESS\nTRAJECTORY:\n  t:0  message_person"},
            ],
        },
        "/api/blueprints": {
            "status": 200,
            "json": {"id": "bp-new-1", "title": "Test goal", "created": True},
        },
    })


def test_types_contracts_are_importable():
    """Public TypedDict contracts stay importable for tool callers."""
    from domains.knowledge_base.types import (
        BlueprintSearchResult,
        ContextMessage,
        SaveBlueprintResult,
        SavedBlueprintResponse,
        ToolCallMetadata,
    )

    assert BlueprintSearchResult.__annotations__ == {
        "id": str,
        "title": str,
        "blueprint": str,
    }
    assert SavedBlueprintResponse.__annotations__ == {
        "id": str,
        "title": str,
        "created": bool,
    }
    assert "saved_blueprint" in SaveBlueprintResult.__annotations__
    assert "toolName" in ToolCallMetadata.__annotations__
    assert "metadata" in ContextMessage.__annotations__


async def test_query_blueprints_happy_path():
    """query_blueprints_activity returns matching blueprints."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.knowledge_base import query_blueprints_activity

        result = await query_blueprints_activity(
            context=[{"role": "USER", "text": "Book a flight to Paris"}],
            user_id="user-42",
            limit=3,
        )

    assert len(result) == 2
    assert result[0]["id"] == "bp-1"
    assert result[0]["title"] == "Book a flight"


async def test_query_blueprints_boundary():
    """Verify exact HTTP request sent to blueprints search endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.knowledge_base import query_blueprints_activity

        await query_blueprints_activity(
            context=[{"role": "USER", "text": "Research competitor pricing"}],
            user_id="user-99",
            limit=5,
        )

    call = assert_captured_call(
        url_contains="/api/blueprints/search",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["goal"] == "Research competitor pricing"
    assert body["user_id"] == "user-99"
    assert body["limit"] == 5


async def test_save_blueprint_happy_path():
    """save_blueprint_activity saves compressed blueprint via backend."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.knowledge_base import save_blueprint_activity

        messages = [
            {"role": "USER", "text": "Test goal for saving"},
            {"role": "TOOL", "text": "Search done", "metadata": {"toolName": "web_search", "toolStatus": "FINISHED", "toolCallId": "tc-1"}},
        ]
        result = await save_blueprint_activity(
            user_id="user-42",
            blueprint=messages,
        )

    assert result["saved_blueprint"]["id"] == "bp-new-1"
    assert result["saved_blueprint"]["created"] is True


async def test_save_blueprint_boundary():
    """Verify exact HTTP request sent to blueprints save endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.knowledge_base import save_blueprint_activity

        messages = [
            {"role": "USER", "text": "Send a welcome email"},
            {"role": "TOOL", "text": "Email sent", "metadata": {"toolName": "message_person", "toolStatus": "FINISHED", "toolCallId": "tc-2"}},
        ]
        await save_blueprint_activity(user_id="user-77", blueprint=messages)

    call = assert_captured_call(
        url_contains="/api/blueprints",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["user_id"] == "user-77"
    assert body["title"] == "Send a welcome email"
    assert "blueprint" in body
    # Blueprint should be a compressed text string, not JSON
    assert isinstance(body["blueprint"], str)
    assert "TRAJECTORY:" in body["blueprint"]


async def test_trajectory_compression():
    """_build_trajectory_blueprint produces compact deterministic output."""
    from tools.knowledge_base import _build_trajectory_blueprint

    context = [
        {"role": "USER", "text": "Find AI companies"},
        {"role": "TOOL", "text": "3 results", "metadata": {
            "toolName": "web_search", "toolStatus": "FINISHED", "toolCallId": "tc-1",
            "data": {"query": "AI companies"},
        }},
        {"role": "TOOL", "text": "fetched", "metadata": {
            "toolName": "web_fetch", "toolStatus": "FINISHED", "toolCallId": "tc-2",
            "data": {"url": "https://example.com/ai"},
        }},
        {"role": "TOOL", "text": "done", "metadata": {
            "toolName": "attempt_completion", "toolStatus": "FINISHED", "toolCallId": "tc-3",
        }},
    ]
    result = _build_trajectory_blueprint(context, "Find AI companies")

    assert "STATUS: SUCCESS" in result
    assert "TRAJECTORY:" in result
    assert "web_search" in result
    assert "web_fetch" in result
    assert "attempt_completion" in result
    assert "USER MESSAGES:" in result
    assert "Find AI companies" in result


async def test_query_blueprints_empty_context():
    """query_blueprints_activity handles empty context gracefully."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.knowledge_base import query_blueprints_activity

        # Empty context should still make the request (extract_goal_from_context handles it)
        result = await query_blueprints_activity(
            context=[],
            user_id="user-1",
            limit=1,
        )

    # Should return results (mock always returns 2 results)
    assert isinstance(result, list)


# ── build_trajectory_blueprint edge cases ─────────────────────────────


def test_trajectory_reasoning_and_user_messages():
    """ASSISTANT reasoning lines appear and USER messages are collected verbatim."""
    from tools.knowledge_base import _build_trajectory_blueprint

    context = [
        {"role": "USER", "text": "Do the thing"},
        {"role": "ASSISTANT", "text": "Let me think...", "metadata": {}},
        {
            "role": "TOOL",
            "text": "result set",
            "metadata": {"toolName": "web_search", "toolStatus": "FINISHED", "toolCallId": "tc-1"},
        },
    ]
    result = _build_trajectory_blueprint(context, "Do the thing")
    assert "reasoning" in result
    assert "Do the thing" in result
    assert "web_search" in result


def test_trajectory_skips_hidden_and_custom_system_user():
    """Hidden user messages / custom system prompts are not listed as USER MESSAGES."""
    from tools.knowledge_base import _build_trajectory_blueprint

    context = [
        {"role": "USER", "text": "visible", "metadata": {}},
        {"role": "USER", "text": "hidden", "metadata": {"hidden": True}},
        {"role": "USER", "text": "sys", "metadata": {"isCustomSystemPrompt": True}},
    ]
    result = _build_trajectory_blueprint(context, "x")
    assert "visible" in result
    assert "hidden" not in result
    assert "sys" not in result


def test_trajectory_tool_error_path():
    """TOOL with status=ERROR formats as FAILED(...) in the line."""
    from tools.knowledge_base import _build_trajectory_blueprint

    context = [
        {"role": "USER", "text": "Do X"},
        {
            "role": "TOOL",
            "text": "timeout fetching remote",
            "metadata": {"toolName": "web_fetch", "toolStatus": "ERROR", "toolCallId": "tc-err", "data": {"url": "https://foo.com/a"}},
        },
    ]
    result = _build_trajectory_blueprint(context, "Do X")
    assert "FAILED" in result
    assert "web_fetch" in result


def test_trajectory_dedupes_tool_call_id():
    """Same tool_call_id appearing twice produces only one trajectory line."""
    from tools.knowledge_base import _build_trajectory_blueprint

    md = {"toolName": "web_search", "toolStatus": "FINISHED", "toolCallId": "dup", "data": {"query": "q"}}
    context = [
        {"role": "USER", "text": "ask"},
        {"role": "TOOL", "text": "r1", "metadata": md},
        {"role": "TOOL", "text": "r2", "metadata": md},
    ]
    result = _build_trajectory_blueprint(context, "ask")
    assert result.count("web_search") == 1


def test_trajectory_skips_in_progress():
    """IN_PROGRESS tool messages are not included in the trajectory."""
    from tools.knowledge_base import _build_trajectory_blueprint

    context = [
        {"role": "USER", "text": "ask"},
        {
            "role": "TOOL",
            "text": "",
            "metadata": {"toolName": "web_search", "toolStatus": "IN_PROGRESS", "toolCallId": "tc-ip"},
        },
    ]
    result = _build_trajectory_blueprint(context, "ask")
    assert "web_search" not in result
    assert "(no tool calls)" in result


def test_trajectory_set_plan_switches_phase_to_execute():
    """After set_plan, subsequent tools are reported under [EXECUTE] phase."""
    from tools.knowledge_base import _build_trajectory_blueprint

    context = [
        {"role": "USER", "text": "plan"},
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolName": "set_plan",
                "toolStatus": "FINISHED",
                "toolCallId": "tc-sp",
                "data": {"tasks": [{"goal": "A"}, {"goal": "B"}]},
            },
        },
        {
            "role": "TOOL",
            "text": "ok",
            "metadata": {
                "toolName": "web_search",
                "toolStatus": "FINISHED",
                "toolCallId": "tc-ws",
                "data": {"query": "hi"},
            },
        },
    ]
    result = _build_trajectory_blueprint(context, "plan")
    assert "set_plan" in result
    assert "[EXECUTE]" in result
    assert "2 tasks" in result
    assert "PLAN:" in result


def test_trajectory_completion_summary_cost_and_failed():
    """completion_summary ERROR sets STATUS=FAILED and extracts duration."""
    from tools.knowledge_base import _build_trajectory_blueprint

    context = [
        {"role": "USER", "text": "x"},
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolName": "completion_summary",
                "toolStatus": "FINISHED",
                "toolCallId": "tc-cs",
                "completionSummary": {"costDollars": 0.12, "durationSeconds": 75},
            },
        },
    ]
    result = _build_trajectory_blueprint(context, "x")
    assert "COST: $0.12" in result
    assert "DURATION: 1m 15s" in result


def test_trajectory_completion_summary_error_sets_failed():
    """completion_summary with ERROR status marks STATUS: FAILED."""
    from tools.knowledge_base import _build_trajectory_blueprint

    context = [
        {"role": "USER", "text": "x"},
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolName": "completion_summary",
                "toolStatus": "ERROR",
                "toolCallId": "tc-cs",
                "completionSummary": {"durationSeconds": 30},
            },
        },
    ]
    result = _build_trajectory_blueprint(context, "x")
    assert "STATUS: FAILED" in result


def test_trajectory_truncates_long_user_messages():
    """User messages longer than USER_MESSAGE_TRUNCATE_LENGTH are truncated."""
    from domains.knowledge_base.config import USER_MESSAGE_TRUNCATE_LENGTH
    from tools.knowledge_base import _build_trajectory_blueprint

    long_msg = "x" * (USER_MESSAGE_TRUNCATE_LENGTH + 100)
    context = [{"role": "USER", "text": long_msg}]
    result = _build_trajectory_blueprint(context, "x")
    assert "..." in result
    assert ("x" * (USER_MESSAGE_TRUNCATE_LENGTH + 100)) not in result


def test_trajectory_various_tool_params_extracted():
    """Covers all _extract_key_param branches for various tools."""
    from tools.knowledge_base import _build_trajectory_blueprint

    tools = [
        ("web_search", {"query": "apples"}, ""),
        ("web_fetch", {"url": "https://sub.example.com/a"}, ""),
        ("spawn_browser_agent", {"goal": "book ticket"}, ""),
        ("spawn_sub_agent", {"goal": "research"}, ""),
        ("spawn_claude_code_agent", {"goal": "refactor"}, ""),
        ("send_message_to_user", {}, ""),
    ]
    context: list[dict] = [{"role": "USER", "text": "go"}]
    for i, (name, data, text) in enumerate(tools):
        context.append({
            "role": "TOOL",
            "text": text,
            "metadata": {
                "toolName": name,
                "toolStatus": "FINISHED",
                "toolCallId": f"tc-{i}",
                "data": data,
            },
        })
    result = _build_trajectory_blueprint(context, "go")
    # Every tool name present
    for name, _, _ in tools:
        assert name in result


def test_trajectory_web_fetch_url_parse_netloc():
    """web_fetch URL with empty path falls back to netloc."""
    from tools.knowledge_base import _build_trajectory_blueprint

    context = [
        {"role": "USER", "text": "go"},
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolName": "web_fetch",
                "toolStatus": "FINISHED",
                "toolCallId": "tc-1",
                "data": {"url": "https://example.com"},
            },
        },
    ]
    result = _build_trajectory_blueprint(context, "go")
    assert "example.com" in result


# ── QueryBlueprintsManager.execute_tool ────────────────────────────────


async def _collect_events(gen):
    events = []
    async for e in gen:
        events.append(e)
    return events


async def test_query_manager_empty_results_yields_finished_event():
    """No blueprints returned → FINISHED event without the 'Found N' title."""
    from domains.knowledge_base.handler import QueryBlueprintsManager
    from tools.base import MessageStatus

    async def fake_execute_activity(fn, args=None, **kwargs):
        return []

    manager = QueryBlueprintsManager()
    events = await _collect_events(
        manager.execute_tool(
            fake_execute_activity,
            {"context": [{"role": "USER", "text": "x"}], "user_id": "u", "limit": 3},
            "tc-1",
        )
    )

    assert len(events) == 2
    assert events[0].status == MessageStatus.IN_PROGRESS
    assert events[1].status == MessageStatus.FINISHED
    assert manager._last_result == []


async def test_query_manager_happy_path_builds_message():
    """Multiple blueprints are rendered with titles in the final message."""
    from domains.knowledge_base.handler import QueryBlueprintsManager
    from tools.base import MessageStatus

    fake_blueprints = [
        {"id": "bp-1", "title": "Plan a trip"},
        {"id": "bp-2", "title": "Book a flight"},
    ]

    async def fake_execute_activity(fn, args=None, **kwargs):
        return fake_blueprints

    manager = QueryBlueprintsManager()
    events = await _collect_events(
        manager.execute_tool(
            fake_execute_activity,
            {"context": [{"role": "USER", "text": "travel"}], "user_id": "u"},
            "tc-2",
        )
    )

    final = [e for e in events if e.status == MessageStatus.FINISHED][0]
    assert "2 similar goals" in final.title
    assert "Plan a trip" in final.message
    assert "Book a flight" in final.message
    assert manager._last_result == fake_blueprints


async def test_query_manager_single_blueprint_uses_singular_grammar():
    """Exactly one blueprint uses singular 'similar goal' and 'blueprint'."""
    from domains.knowledge_base.handler import QueryBlueprintsManager
    from tools.base import MessageStatus

    async def fake_execute_activity(fn, args=None, **kwargs):
        return [{"id": "bp-1", "title": "Alone"}]

    manager = QueryBlueprintsManager()
    events = await _collect_events(
        manager.execute_tool(
            fake_execute_activity,
            {"context": [{"role": "USER", "text": "x"}], "user_id": "u"},
            "tc-sg",
        )
    )

    final = [e for e in events if e.status == MessageStatus.FINISHED][0]
    assert "1 similar goal" in final.title
    assert "goals" not in final.title  # singular
    assert "blueprint from" in final.message


async def test_query_manager_activity_error_yields_error_event():
    """Exception in execute_activity yields an ERROR event and empty _last_result."""
    from domains.knowledge_base.handler import QueryBlueprintsManager
    from tools.base import MessageStatus

    async def fake_execute_activity(fn, args=None, **kwargs):
        raise RuntimeError("backend down")

    manager = QueryBlueprintsManager()
    events = await _collect_events(
        manager.execute_tool(
            fake_execute_activity,
            {"context": [{"role": "USER", "text": "x"}], "user_id": "u"},
            "tc-err",
        )
    )

    assert any(e.status == MessageStatus.ERROR and "backend down" in e.message for e in events)
    assert manager._last_result == []


# ── SaveBlueprintManager.execute_tool ────────────────────────────────


def _patch_save_blueprint_workflow(fake):
    """Replace the workflow module used by SaveBlueprintManager.execute_tool."""
    import domains.knowledge_base.handler as h

    original = h.workflow
    h.workflow = fake

    def restore():
        h.workflow = original

    return restore


class _FakeWorkflowModule:
    def __init__(self, result=None, raise_exc=None):
        self._result = result
        self._exc = raise_exc

    async def execute_activity(self, fn, args=None, **kwargs):
        if self._exc is not None:
            raise self._exc
        return self._result


async def test_save_manager_happy_path():
    """Successful save yields IN_PROGRESS then FINISHED; _last_result populated."""
    from domains.knowledge_base.handler import SaveBlueprintManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(result={"saved_blueprint": {"id": "bp-99"}})
    restore = _patch_save_blueprint_workflow(fake)
    try:
        manager = SaveBlueprintManager()
        events = await _collect_events(
            manager.execute_tool(
                workflow_instance=None,
                tool_call={"user_id": "u", "steps": [{"role": "USER", "text": "x"}]},
                tool_call_id="tc-save",
            )
        )
    finally:
        restore()

    statuses = [e.status for e in events]
    assert MessageStatus.IN_PROGRESS in statuses
    assert MessageStatus.FINISHED in statuses
    assert MessageStatus.ERROR not in statuses
    assert manager._last_result == {"saved_blueprint": {"id": "bp-99"}}


async def test_save_manager_activity_error_yields_error_event():
    """Activity raising still reaches FINISHED but emits ERROR event first."""
    from domains.knowledge_base.handler import SaveBlueprintManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(raise_exc=RuntimeError("save broke"))
    restore = _patch_save_blueprint_workflow(fake)
    try:
        manager = SaveBlueprintManager()
        events = await _collect_events(
            manager.execute_tool(
                workflow_instance=None,
                tool_call={"user_id": "u", "steps": []},
                tool_call_id="tc-save-err",
            )
        )
    finally:
        restore()

    error_event = next(e for e in events if e.status == MessageStatus.ERROR)
    assert "save broke" in error_event.message
    # Still emits final FINISHED event after the error (per handler design)
    assert any(e.status == MessageStatus.FINISHED for e in events)
    assert manager._last_result is None


# ── Singletons ────────────────────────────────────────────────────────


def test_get_query_manager_singleton():
    """get_query_manager returns the same instance across calls."""
    from domains.knowledge_base.handler import get_query_manager

    a = get_query_manager()
    b = get_query_manager()
    assert a is b
    assert a.tool_name == "query_blueprints"


def test_get_save_manager_singleton():
    """get_save_manager returns the same instance across calls."""
    from domains.knowledge_base.handler import get_save_manager

    a = get_save_manager()
    b = get_save_manager()
    assert a is b
    assert a.tool_name == "save_blueprint"


# ── Workflow-helper top-level functions ──────────────────────────────


async def test_query_blueprints_helper_forwards_events_and_returns_results():
    """query_blueprints top-level helper invokes callback and returns manager._last_result."""
    from domains.knowledge_base.handler import query_blueprints

    collected = []

    async def on_event(event, tool_call_id, tool_name):
        collected.append((event, tool_call_id, tool_name))

    async def fake_execute_activity(fn, args=None, **kwargs):
        return [{"id": "bp-x", "title": "X"}]

    result = await query_blueprints(
        on_event,
        fake_execute_activity,
        context=[{"role": "USER", "text": "hi"}],
        user_id="u",
        limit=2,
    )

    assert result == [{"id": "bp-x", "title": "X"}]
    assert len(collected) >= 2  # IN_PROGRESS + FINISHED
    assert all(tn == "query_blueprints" for _, _, tn in collected)


def test_trajectory_result_summary_fallbacks():
    """_extract_result_summary fallback paths: title present, title absent.

    Uses an unknown tool to exercise the title-fallback branch; spawn_*
    short-circuits to "SUCCESS" before hitting the title path, so we use a
    tool name with no special-case to land in the fallback.
    """
    from tools.knowledge_base import _build_trajectory_blueprint

    context = [
        {"role": "USER", "text": "go"},
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolName": "some_tool_with_title",
                "toolStatus": "FINISHED",
                "toolCallId": "tc-t",
                "title": "Found 5 items",
                "data": {},
            },
        },
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolName": "unknown_tool",
                "toolStatus": "FINISHED",
                "toolCallId": "tc-u",
                "data": {},
            },
        },
    ]
    result = _build_trajectory_blueprint(context, "go")
    assert "Found 5 items" in result
    # unknown tool without title falls back to 'completed'
    assert "completed" in result


async def run_all_tests():
    print("knowledge-base blackbox tests:")
    r = BlackboxResult()
    r.record("types_contracts", test_types_contracts_are_importable)
    await r.record_async("query_happy_path", test_query_blueprints_happy_path)
    await r.record_async("query_boundary", test_query_blueprints_boundary)
    await r.record_async("save_happy_path", test_save_blueprint_happy_path)
    await r.record_async("save_boundary", test_save_blueprint_boundary)
    await r.record_async("trajectory_compression", test_trajectory_compression)
    await r.record_async("query_empty_context", test_query_blueprints_empty_context)
    r.record("trajectory_reasoning", test_trajectory_reasoning_and_user_messages)
    r.record("trajectory_skips_hidden", test_trajectory_skips_hidden_and_custom_system_user)
    r.record("trajectory_tool_error", test_trajectory_tool_error_path)
    r.record("trajectory_dedupe", test_trajectory_dedupes_tool_call_id)
    r.record("trajectory_in_progress_skipped", test_trajectory_skips_in_progress)
    r.record("trajectory_set_plan_phase", test_trajectory_set_plan_switches_phase_to_execute)
    r.record("trajectory_completion_summary", test_trajectory_completion_summary_cost_and_failed)
    r.record("trajectory_completion_error", test_trajectory_completion_summary_error_sets_failed)
    r.record("trajectory_long_user_truncate", test_trajectory_truncates_long_user_messages)
    r.record("trajectory_all_tool_params", test_trajectory_various_tool_params_extracted)
    r.record("trajectory_web_fetch_netloc", test_trajectory_web_fetch_url_parse_netloc)
    r.record("trajectory_result_fallbacks", test_trajectory_result_summary_fallbacks)
    # QueryBlueprintsManager.execute_tool
    await r.record_async("query_manager_empty", test_query_manager_empty_results_yields_finished_event)
    await r.record_async("query_manager_happy", test_query_manager_happy_path_builds_message)
    await r.record_async("query_manager_singular", test_query_manager_single_blueprint_uses_singular_grammar)
    await r.record_async("query_manager_error", test_query_manager_activity_error_yields_error_event)
    # SaveBlueprintManager.execute_tool
    await r.record_async("save_manager_happy", test_save_manager_happy_path)
    await r.record_async("save_manager_error", test_save_manager_activity_error_yields_error_event)
    # singletons
    r.record("get_query_manager_singleton", test_get_query_manager_singleton)
    r.record("get_save_manager_singleton", test_get_save_manager_singleton)
    # helpers
    await r.record_async("query_blueprints_helper", test_query_blueprints_helper_forwards_events_and_returns_results)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
