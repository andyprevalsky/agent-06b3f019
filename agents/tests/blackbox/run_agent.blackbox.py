"""Blackbox tests for run_agent assistant/tool persistence invariants."""

import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from _test_utils import (
    BlackboxResult,
    teardown_mock,
)


class _DummyToolCall:
    def __init__(self, payload):
        self._payload = payload

    def model_dump(self):
        return self._payload


class _DummyLLMResult:
    def __init__(self, response, tool_calls):
        self.response = response
        self.tool_calls = [_DummyToolCall(tc) for tc in tool_calls]


async def _run_single_iteration(
    tool_calls,
    detected_tools_ordered,
    *,
    skip_verification=True,
    initial_context=None,
    is_plan_loop=False,
    max_iterations=1,
    execute_tool_override=None,
    verifier_score=1.0,
    verifier_reasoning="done",
):
    from loop.run_agent import run_agent

    posted_messages = []
    executed_tools = []

    async def mock_system_prompt():
        return "System prompt"

    async def mock_verifier_prompt():
        return "Verifier prompt"

    async def mock_post_message(text, role, metadata=None):
        posted_messages.append({
            "text": text,
            "role": role,
            "metadata": metadata,
        })

    default_execute_tool = execute_tool_override

    async def default_mock_execute_tool(tool_name, tool_args, tool_call_id):
        executed_tools.append({
            "tool_name": tool_name,
            "tool_args": tool_args,
            "tool_call_id": tool_call_id,
        })
        # Simulate production tool handlers which persist a FINISHED TOOL row to DB.
        posted_messages.append({
            "text": f"{tool_name} complete",
            "role": "TOOL",
            "metadata": {
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "toolStatus": "FINISHED",
            },
        })
        return {"message": f"{tool_name} complete"}

    if default_execute_tool is None:
        default_execute_tool = default_mock_execute_tool

    async def mock_call_llm_structured_streaming(**kwargs):
        return (
            _DummyLLMResult("", tool_calls),
            {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            detected_tools_ordered,
        )

    async def mock_check_progress(*args, **kwargs):
        return {
            "score": verifier_score,
            "reasoning": verifier_reasoning,
            "structured_response": None,
            "usage": {"prompt_tokens": 5, "completion_tokens": 6, "total_tokens": 11},
        }

    ctx = initial_context if initial_context is not None else [
        {"role": "USER", "text": "Find updates", "timestamp": "2024-01-01T00:00:00Z"}
    ]

    with (
        patch(
            "loop.run_agent.call_llm_structured_streaming",
            new=AsyncMock(side_effect=mock_call_llm_structured_streaming),
        ),
        patch("loop.run_agent.check_progress", new=AsyncMock(side_effect=mock_check_progress)),
    ):
        result = await run_agent(
            agent_id="agent-test",
            user_id="user-test",
            system_prompt=mock_system_prompt,
            verifier_prompt_generator=mock_verifier_prompt,
            model="rose-labs/rose-1-lite",
            tools=["web_search", "web_fetch", "attempt_completion", "set_plan"],
            initial_context=ctx,
            is_inside_temporal_activity=True,
            post_message=mock_post_message,
            execute_tool=default_execute_tool,
            build_messages=lambda context, prompt: [{"role": "system", "content": prompt}],
            max_iterations=max_iterations,
            skip_verification=skip_verification,
            skip_status_updates=True,
            is_plan_loop=is_plan_loop,
        )

    return result, posted_messages, executed_tools


async def test_tool_only_assistant_turn_persists_tool_calls():
    """Tool-only assistant declaration should persist as ASSISTANT with metadata.tool_calls."""
    tool_calls = [{"tool": "web_search", "query": "latest updates"}]
    detected_tools = [("web_search", "tc-web-search-1", 1.0)]

    result, posted, executed = await _run_single_iteration(tool_calls, detected_tools)

    assert result["status"] == "max_iterations"
    assert len(posted) >= 1
    assistant_posts = [m for m in posted if m["role"] == "ASSISTANT"]
    assert len(assistant_posts) == 1

    assistant = assistant_posts[0]
    assert assistant["text"] == ""
    assert assistant["metadata"] is not None
    assert "tool_calls" in assistant["metadata"]
    assert len(assistant["metadata"]["tool_calls"]) == 1

    persisted_call = assistant["metadata"]["tool_calls"][0]
    assert persisted_call["tool"] == "web_search"
    assert persisted_call["query"] == "latest updates"
    assert persisted_call["tool_call_id"] == "tc-web-search-1"

    assert len(executed) == 1
    assert executed[0]["tool_call_id"] == "tc-web-search-1"


async def test_assistant_tool_call_ids_match_execution_and_context_results():
    """Persisted assistant tool_call_id values should match execution and TOOL context metadata."""
    tool_calls = [
        {"tool": "web_search", "query": "alpha"},
        {"tool": "web_search", "query": "beta"},
    ]
    detected_tools = [
        ("web_search", "tc-web-search-1", 1.0),
        ("web_search", "tc-web-search-2", 2.0),
    ]

    result, posted, executed = await _run_single_iteration(tool_calls, detected_tools)

    assistant = [m for m in posted if m["role"] == "ASSISTANT"][0]
    persisted_ids = [tc["tool_call_id"] for tc in assistant["metadata"]["tool_calls"]]
    executed_ids = [t["tool_call_id"] for t in executed]

    assert persisted_ids == ["tc-web-search-1", "tc-web-search-2"]
    assert executed_ids == ["tc-web-search-1", "tc-web-search-2"]

    # Tool handlers persist TOOL rows to DB in production; mock_execute_tool
    # simulates that. Persisted TOOL IDs must match executed and declared IDs.
    tool_posts = [m for m in posted if m["role"] == "TOOL"]
    tool_post_ids = [m["metadata"]["toolCallId"] for m in tool_posts]
    assert set(tool_post_ids) == set(executed_ids) == set(persisted_ids)


async def test_attempt_completion_skip_verification_returns_completed():
    """When attempt_completion fires with skip_verification, status is 'completed'.
    Without an explicit result, final_response falls back to assistant narration.
    Helper sends "" so final_response is "".
    """
    tool_calls = [
        {"tool": "attempt_completion"},
    ]
    detected_tools = [("attempt_completion", "tc-ac-1", 1.0)]

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {"message": "ac done"}

    result, posted, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=True,
        execute_tool_override=mock_execute_tool,
    )

    assert result["status"] == "completed"
    assert result["final_response"] == ""


async def test_attempt_completion_result_used_when_skip_verification():
    """skip_verification returns attempt_completion.result as final_response."""
    tool_calls = [
        {"tool": "attempt_completion", "result": "final handoff payload"},
    ]
    detected_tools = [("attempt_completion", "tc-ac-1", 1.0)]

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {"message": "ac done"}

    result, posted, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=True,
        execute_tool_override=mock_execute_tool,
    )

    assert result["status"] == "completed"
    assert result["final_response"] == "final handoff payload"


async def test_attempt_completion_plan_loop_requires_set_plan():
    """In PLAN phase, attempt_completion before set_plan should emit error and NOT complete."""
    tool_calls = [{"tool": "attempt_completion"}]
    detected_tools = [("attempt_completion", "tc-ac-1", 1.0)]

    # Record tool event to verify an ERROR was emitted
    handle_events = []

    async def fake_handle_tool_event(**kwargs):
        handle_events.append({"event": kwargs["event"], "tool_name": kwargs["tool_name"]})

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {"message": "done"}

    with patch("loop.run_agent.handle_tool_event", new=AsyncMock(side_effect=fake_handle_tool_event)):
        result, posted, _ = await _run_single_iteration(
            tool_calls,
            detected_tools,
            skip_verification=True,
            is_plan_loop=True,
            execute_tool_override=mock_execute_tool,
        )

    assert result["status"] == "max_iterations"  # not completed
    # Verify an error event was emitted for the attempt_completion
    assert any(ev["tool_name"] == "attempt_completion" for ev in handle_events)


async def test_plan_loop_completes_when_set_plan_then_attempt_completion():
    """In PLAN phase: set_plan + attempt_completion within same iteration → completed."""
    tool_calls = [
        {"tool": "set_plan", "plan": {"tasks": []}},
        {"tool": "attempt_completion"},
    ]
    detected_tools = [("set_plan", "tc-sp-1", 1.0), ("attempt_completion", "tc-ac-1", 2.0)]

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {"message": f"{tool_name} done"}

    result, posted, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=True,
        is_plan_loop=True,
        execute_tool_override=mock_execute_tool,
    )

    # set_plan_succeeded is True → attempt_completion proceeds → PLAN loop completes
    assert result["status"] == "completed"


async def test_no_tool_calls_nudges_then_errors_after_3_consecutive():
    """If LLM returns no tool calls 3 times in a row, run_agent returns status='error'."""
    tool_calls = []
    detected_tools = []

    result, posted, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=True,
        max_iterations=5,
    )

    assert result["status"] == "error"
    assert "no tool calls" in result["message"].lower()


async def test_tool_exception_continues_loop_and_posts_error():
    """Exception in execute_tool → error message posted, loop continues, max_iterations reached."""
    tool_calls = [{"tool": "web_search", "query": "fail"}]
    detected_tools = [("web_search", "tc-1", 1.0)]

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        raise RuntimeError("oops")

    result, posted, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=True,
        execute_tool_override=mock_execute_tool,
    )

    assert result["status"] == "max_iterations"
    error_posts = [m for m in posted if m["role"] == "TOOL" and (m.get("metadata") or {}).get("toolStatus") == "ERROR"]
    assert len(error_posts) == 1
    assert "oops" in error_posts[0]["text"]


async def test_status_needs_user_help_returned_from_tool():
    """Tool result with status='needs_user_help' should surface as run_agent status."""
    tool_calls = [{"tool": "web_fetch", "url": "x"}]
    detected_tools = [("web_fetch", "tc-uh-1", 1.0)]

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {"status": "needs_user_help", "message": "Please log in"}

    result, _, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=True,
        execute_tool_override=mock_execute_tool,
    )

    assert result["status"] == "needs_user_help"
    assert result["message"] == "Please log in"


async def test_status_completed_from_tool():
    """Tool result with status='completed' should short-circuit with status='completed'."""
    tool_calls = [{"tool": "web_fetch", "url": "x"}]
    detected_tools = [("web_fetch", "tc-1", 1.0)]

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {"status": "completed", "result": "DONE"}

    result, _, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=True,
        execute_tool_override=mock_execute_tool,
    )

    assert result["status"] == "completed"
    assert result["result"] == "DONE"


async def test_verifier_below_threshold_adds_feedback_and_loops():
    """Verifier score < 1.0 appends feedback message; loop continues until max_iterations."""
    tool_calls = [{"tool": "attempt_completion"}]
    detected_tools = [("attempt_completion", "tc-ac-1", 1.0)]

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {"message": "ac done"}

    result, _, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=False,  # run the verifier
        max_iterations=1,  # only one iteration, will exit with max_iterations
        execute_tool_override=mock_execute_tool,
        verifier_score=0.5,
        verifier_reasoning="not quite",
    )

    assert result["status"] == "max_iterations"
    # Final verifier ran and recorded progress
    assert result.get("verifier_progress") == 0.5
    assert "not quite" in (result.get("verifier_reasoning") or "")


async def test_verifier_score_1_returns_completed():
    """Verifier score==1.0 after attempt_completion returns status='completed' with score."""
    tool_calls = [{"tool": "attempt_completion"}]
    detected_tools = [("attempt_completion", "tc-ac-1", 1.0)]

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {"message": "ok"}

    result, _, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=False,
        max_iterations=3,
        execute_tool_override=mock_execute_tool,
        verifier_score=1.0,
        verifier_reasoning="perfect",
    )

    assert result["status"] == "completed"
    assert result["score"] == 1.0
    assert result["message"] == "perfect"


async def test_estimate_tokens():
    """_estimate_tokens counts roughly len(text) // 4."""
    from loop.run_agent import _estimate_tokens

    context = [
        {"text": "Hello world this is a test message", "metadata": {}},
        {"text": "Another message here with more content", "metadata": {}},
    ]

    result = _estimate_tokens(context)

    total_text = "\n".join([m["text"] for m in context])
    expected = len(total_text) // 4
    assert result == expected


async def test_compress_context_calls_execute_activity_and_returns_single_system_message():
    """_compress_context calls execute_activity with compress_context activity, returns [SYSTEM msg]."""
    from loop.run_agent import _compress_context

    captured_args = []

    async def mock_execute_activity(fn, args=None, **kwargs):
        captured_args.append((fn, args, kwargs))
        return {"learnings": "key insights", "usage": {"prompt_tokens": 3, "completion_tokens": 2}}

    tokens_recorded = []

    async def on_tokens(in_, out_, model, **kwargs):
        tokens_recorded.append((in_, out_, model, kwargs))

    context = [{"role": "USER", "text": "hi"}]
    result = await _compress_context(
        mock_execute_activity,
        context,
        "rose-lite",
        on_tokens=on_tokens,
    )

    assert len(result) == 1
    assert result[0]["role"] == "SYSTEM"
    assert result[0]["text"] == "key insights"
    assert captured_args[0][1] == [context, len(context), "rose-lite"]
    assert len(tokens_recorded) == 1
    assert tokens_recorded[0][0] == 3
    assert tokens_recorded[0][1] == 2


async def test_compress_context_handles_string_return():
    """_compress_context handles legacy string return (no usage)."""
    from loop.run_agent import _compress_context

    async def mock_execute_activity(*args, **kwargs):
        return "plain string learnings"

    result = await _compress_context(mock_execute_activity, [{"role": "USER", "text": "x"}], "rose-lite")
    assert len(result) == 1
    assert result[0]["text"] == "plain string learnings"


async def test_run_verifier_posts_in_progress_and_finished():
    """_run_verifier posts IN_PROGRESS + FINISHED TOOL messages with correct metadata."""
    from loop.run_agent import _run_verifier

    captured = []

    async def execute_activity(fn, args=None, **_kwargs):
        return {
            "score": 0.75,
            "reasoning": "good",
            "structured_response": {"answer": "42"},
            "usage": {},
        }

    async def post_message(text, role, metadata=None):
        captured.append({"text": text, "role": role, "metadata": metadata})

    async def verifier_prompt():
        return "You are a verifier."

    result = await _run_verifier(
        execute_activity=execute_activity,
        context=[],
        verifier_prompt_generator=verifier_prompt,
        model="rose-lite",
        agent_id="agent-1",
        task_id=None,
        post_message=post_message,
    )

    assert result["score"] == 0.75
    assert len(captured) == 2
    in_progress = captured[0]
    finished = captured[1]
    assert in_progress["metadata"]["toolStatus"] == "IN_PROGRESS"
    assert finished["metadata"]["toolStatus"] == "FINISHED"
    # Structured output rendered as Extracted Output
    assert "Extracted Output" in finished["text"]
    assert "42" in finished["text"]


async def test_run_verifier_dynamic_schema_getter():
    """_run_verifier calls get_response_schema() when provided."""
    from loop.run_agent import _run_verifier

    schema_calls = []

    async def get_response_schema():
        schema_calls.append(1)
        return {"fields": [{"name": "x", "type": "str"}]}

    async def execute_activity(fn, args=None, **_kwargs):
        # The 5th arg is response_schema
        return {"score": 1.0, "reasoning": "ok", "structured_response": None, "usage": {}}

    async def verifier_prompt():
        return "V"

    await _run_verifier(
        execute_activity=execute_activity,
        context=[],
        verifier_prompt_generator=verifier_prompt,
        model="rose-lite",
        agent_id="a",
        task_id="t",
        post_message=None,
        get_response_schema=get_response_schema,
    )

    assert len(schema_calls) == 1


async def test_max_iterations_runs_final_verifier():
    """When max_iterations reached, final verifier runs and result includes verifier_progress."""
    tool_calls = [{"tool": "web_search", "query": "x"}]
    detected_tools = [("web_search", "tc-1", 1.0)]

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {"message": "done"}

    result, _, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=False,
        max_iterations=1,
        execute_tool_override=mock_execute_tool,
        verifier_score=0.3,
        verifier_reasoning="partial progress",
    )

    assert result["status"] == "max_iterations"
    assert result["verifier_progress"] == 0.3
    assert "partial progress" in result["verifier_reasoning"]


async def run_all_tests():
    print("run-agent blackbox tests:")
    r = BlackboxResult()
    await r.record_async("tool_only_assistant_turn_persists_tool_calls", test_tool_only_assistant_turn_persists_tool_calls)
    await r.record_async("assistant_tool_call_ids_match_execution_and_context_results", test_assistant_tool_call_ids_match_execution_and_context_results)
    await r.record_async("attempt_completion_skip_verification_returns_completed", test_attempt_completion_skip_verification_returns_completed)
    await r.record_async("attempt_completion_result_used_when_skip_verification", test_attempt_completion_result_used_when_skip_verification)
    await r.record_async("attempt_completion_plan_loop_requires_set_plan", test_attempt_completion_plan_loop_requires_set_plan)
    await r.record_async("plan_loop_completes_when_set_plan_then_attempt_completion", test_plan_loop_completes_when_set_plan_then_attempt_completion)
    await r.record_async("no_tool_calls_nudges_then_errors_after_3_consecutive", test_no_tool_calls_nudges_then_errors_after_3_consecutive)
    await r.record_async("tool_exception_continues_loop_and_posts_error", test_tool_exception_continues_loop_and_posts_error)
    await r.record_async("status_needs_user_help_returned_from_tool", test_status_needs_user_help_returned_from_tool)
    await r.record_async("status_completed_from_tool", test_status_completed_from_tool)
    await r.record_async("verifier_below_threshold_adds_feedback_and_loops", test_verifier_below_threshold_adds_feedback_and_loops)
    await r.record_async("verifier_score_1_returns_completed", test_verifier_score_1_returns_completed)
    await r.record_async("estimate_tokens", test_estimate_tokens)
    await r.record_async("compress_context_calls_execute_activity_and_returns_single_system_message", test_compress_context_calls_execute_activity_and_returns_single_system_message)
    await r.record_async("compress_context_handles_string_return", test_compress_context_handles_string_return)
    await r.record_async("run_verifier_posts_in_progress_and_finished", test_run_verifier_posts_in_progress_and_finished)
    await r.record_async("run_verifier_dynamic_schema_getter", test_run_verifier_dynamic_schema_getter)
    await r.record_async("max_iterations_runs_final_verifier", test_max_iterations_runs_final_verifier)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
