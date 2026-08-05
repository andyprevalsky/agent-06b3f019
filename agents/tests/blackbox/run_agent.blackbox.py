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
    verifier_structured_response=None,
    verifier_usage=None,
    winddown_window=0,
    response_schema=None,
    llm_tool_calls_sequence=None,
    llm_tool_calls_factory=None,
    llm_chunk_texts_sequence=None,
    llm_usages_sequence=None,
    llm_response_models=None,
    llm_auth_calls=None,
    fast_mode_cache_enabled=False,
    goal_text=None,
    poll_messages_override=None,
    is_inside_temporal_activity=True,
    response_model=None,
    on_tokens_override=None,
    check_paused_override=None,
    check_aborted_override=None,
    gpt_token=None,
    gpt_account_id=None,
    iteration_offset=0,
):
    from loop.run_agent import run_agent

    posted_messages = []
    executed_tools = []

    async def mock_system_prompt():
        return "System prompt"

    async def mock_verifier_prompt():
        return "Verifier prompt"

    async def mock_post_message(text, role, metadata=None):
        posted_messages.append(
            {
                "text": text,
                "role": role,
                "metadata": metadata,
            }
        )

    default_execute_tool = execute_tool_override

    async def default_mock_execute_tool(tool_name, tool_args, tool_call_id):
        executed_tools.append(
            {
                "tool_name": tool_name,
                "tool_args": tool_args,
                "tool_call_id": tool_call_id,
            }
        )
        # Simulate production tool handlers which persist a FINISHED TOOL row to DB.
        posted_messages.append(
            {
                "text": f"{tool_name} complete",
                "role": "TOOL",
                "metadata": {
                    "toolCallId": tool_call_id,
                    "toolName": tool_name,
                    "toolStatus": "FINISHED",
                },
            }
        )
        return {"message": f"{tool_name} complete"}

    if default_execute_tool is None:
        default_execute_tool = default_mock_execute_tool

    async def mock_call_llm_structured_streaming(**kwargs):
        if llm_response_models is not None:
            llm_response_models.append(kwargs["response_model"])
        if llm_auth_calls is not None:
            llm_auth_calls.append(
                {
                    "claude_token": kwargs["claude_token"],
                    "claude_token_source": kwargs["claude_token_source"],
                    "claude_token_pool_id": kwargs["claude_token_pool_id"],
                    "gpt_token": kwargs["gpt_token"],
                    "gpt_account_id": kwargs["gpt_account_id"],
                    "gpt_token_source": kwargs["gpt_token_source"],
                    "gpt_token_pool_id": kwargs["gpt_token_pool_id"],
                }
            )
        selected_tool_calls = tool_calls
        if llm_tool_calls_factory is not None:
            selected_tool_calls = llm_tool_calls_factory()
        elif llm_tool_calls_sequence is not None:
            selected_tool_calls = llm_tool_calls_sequence.pop(0)
        if llm_chunk_texts_sequence is not None:
            chunk_text = llm_chunk_texts_sequence.pop(0)
            await kwargs["on_chunk"](chunk_text, len(chunk_text))
        selected_usage = (
            llm_usages_sequence.pop(0)
            if llm_usages_sequence is not None
            else {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        )
        return (
            _DummyLLMResult("", selected_tool_calls),
            selected_usage,
            detected_tools_ordered,
        )

    async def mock_check_progress(*args, **kwargs):
        return {
            "score": verifier_score,
            "reasoning": verifier_reasoning,
            "structured_response": verifier_structured_response,
            "usage": verifier_usage
            if verifier_usage is not None
            else {"prompt_tokens": 5, "completion_tokens": 6, "total_tokens": 11},
        }

    ctx = (
        initial_context
        if initial_context is not None
        else [{"role": "USER", "text": "Find updates", "timestamp": "2024-01-01T00:00:00Z"}]
    )

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
            is_inside_temporal_activity=is_inside_temporal_activity,
            post_message=mock_post_message,
            poll_messages=poll_messages_override,
            execute_tool=default_execute_tool,
            build_messages=lambda context, prompt: [{"role": "system", "content": prompt}],
            max_iterations=max_iterations,
            iteration_offset=iteration_offset,
            winddown_window=winddown_window,
            skip_verification=skip_verification,
            skip_status_updates=True,
            is_plan_loop=is_plan_loop,
            response_schema=response_schema,
            response_model=response_model,
            fast_mode_cache_enabled=fast_mode_cache_enabled,
            goal_text=goal_text,
            on_tokens=on_tokens_override,
            check_paused=check_paused_override,
            check_aborted=check_aborted_override,
            gpt_token=gpt_token,
            gpt_account_id=gpt_account_id,
        )

    return result, posted_messages, executed_tools


async def test_iteration_offset_is_reported_with_each_billed_llm_turn():
    reports = []

    async def capture_usage(_tokens_in, _tokens_out, _model, **metadata):
        reports.append(metadata)

    result, _, _ = await _run_single_iteration(
        [{"tool": "web_search", "query": "latest updates"}],
        [("web_search", "tc-position", 1.0)],
        max_iterations=7,
        iteration_offset=6,
        on_tokens_override=capture_usage,
    )

    assert result["status"] == "max_iterations"
    assert reports[0]["iteration"] == 7


async def test_terminal_abort_stops_before_any_llm_or_tool_work():
    """A missing parent discovered by the pause check terminates the loop immediately."""
    checks = []

    async def refresh_parent_state():
        checks.append("parent_state")
        return False

    async def check_aborted():
        checks.append("aborted")
        return True

    result, posted, executed = await _run_single_iteration(
        [{"tool": "web_search", "query": "must not run"}],
        [("web_search", "tc-must-not-run", 1.0)],
        max_iterations=100,
        check_paused_override=refresh_parent_state,
        check_aborted_override=check_aborted,
    )

    assert result["status"] == "aborted"
    assert result["token_count"] == 0
    assert checks == ["parent_state", "aborted"]
    assert posted == []
    assert executed == []


async def test_out_of_credits_state_does_no_llm_or_tool_work():
    """A deployment-restored credit pause remains cold until an explicit resume."""
    from loop import run_agent as run_agent_module
    from workflows.agent_workflow import AgentWorkflow

    wf = AgentWorkflow()
    wf._restore_deployment_state(
        {
            "version": 1,
            "kind": "deployment",
            "prior_status": "OUT_OF_CREDITS",
        }
    )

    with (
        patch.object(run_agent_module, "PAUSED_WAIT_FLOOR_SECONDS", 0.0),
        patch.object(run_agent_module, "MAX_CONSECUTIVE_PAUSED_ITERATIONS", 1),
        patch.object(run_agent_module.asyncio, "sleep", new=AsyncMock()),
    ):
        result, posted, executed = await _run_single_iteration(
            [{"tool": "web_search", "query": "must remain cold"}],
            [("web_search", "tc-credit-cold", 1.0)],
            max_iterations=100,
            check_paused_override=wf._check_paused,
        )

    assert result["status"] == "paused"
    assert wf._has_credits is False
    assert posted == []
    assert executed == []


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


async def test_rejected_completion_continues_with_stable_schema():
    """A rejected completion returns to the same loop without changing its schema."""
    from loop.run_agent import run_agent

    schemas = []
    executed = []
    has_evidence = False
    turns = [
        _DummyLLMResult("", [{"tool": "attempt_completion_with_result", "result": "unsupported"}]),
        _DummyLLMResult("", [{"tool": "web_search", "query": "official population"}]),
        _DummyLLMResult("", [{"tool": "attempt_completion_with_result", "result": "123"}]),
    ]

    async def mock_call_llm_structured_streaming(**kwargs):
        schemas.append(kwargs["response_model"].model_json_schema())
        result = turns.pop(0)
        tool_name = result.tool_calls[0].model_dump()["tool"]
        return (
            result,
            {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            [(tool_name, f"tc-{len(schemas)}", float(len(schemas)))],
        )

    async def execute_tool(tool_name, _tool_args, _tool_call_id):
        nonlocal has_evidence
        executed.append(tool_name)
        if tool_name == "web_search":
            has_evidence = True
            return {"message": "grounded evidence"}
        if not has_evidence:
            return {
                "error": True,
                "message": "Completion rejected: no evidence tool has succeeded yet.",
            }
        return {"message": "grounded evidence"}

    async def prompt():
        return "System prompt"

    with patch(
        "loop.run_agent.call_llm_structured_streaming",
        new=AsyncMock(side_effect=mock_call_llm_structured_streaming),
    ):
        result = await run_agent(
            agent_id="explore-leaf",
            user_id="user-test",
            system_prompt=prompt,
            verifier_prompt_generator=prompt,
            model="rose-labs/rose-1-lite",
            tools=["web_search", "attempt_completion_with_result"],
            initial_context=[{"role": "USER", "text": "Research it", "timestamp": "2024-01-01T00:00:00Z"}],
            is_inside_temporal_activity=True,
            post_message=AsyncMock(),
            execute_tool=execute_tool,
            build_messages=lambda context, system: [{"role": "system", "content": system}],
            max_iterations=3,
            skip_verification=True,
            skip_status_updates=True,
        )

    assert result["status"] == "completed"
    assert executed == [
        "attempt_completion_with_result",
        "web_search",
        "attempt_completion_with_result",
    ]
    assert schemas[0] == schemas[1] == schemas[2]
    assert "attempt_completion_with_result" in str(schemas[0])
    assert "minItems" not in schemas[0]["properties"]["tool_calls"]
    rejected = [message for message in result["context"] if message.get("metadata", {}).get("toolStatus") == "ERROR"]
    assert len(rejected) == 1
    assert "no evidence tool has succeeded" in rejected[0]["text"]


async def test_rejected_completion_posts_error_in_workflow_polling_mode():
    async def reject_completion(_tool_name, _tool_args, _tool_call_id):
        return {
            "error": True,
            "message": "Completion rejected: no evidence tool has succeeded yet.",
        }

    async def poll_messages(_last_checked):
        return []

    workflow_llm_result = {
        "response": "",
        "tool_calls": [{"tool": "attempt_completion_with_result", "result": "unsupported"}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        "detected_tools_ordered": [("attempt_completion_with_result", "tc-rejected", 1.0)],
    }
    with patch(
        "loop.run_agent.workflow.execute_activity",
        new=AsyncMock(return_value=workflow_llm_result),
    ):
        _, posted, _ = await _run_single_iteration(
            workflow_llm_result["tool_calls"],
            workflow_llm_result["detected_tools_ordered"],
            execute_tool_override=reject_completion,
            poll_messages_override=poll_messages,
            is_inside_temporal_activity=False,
        )

    rejected = [
        message
        for message in posted
        if message["role"] == "TOOL" and message.get("metadata", {}).get("toolStatus") == "ERROR"
    ]
    assert len(rejected) == 1
    assert rejected[0]["metadata"]["toolCallId"] == "tc-rejected"
    assert "no evidence tool has succeeded" in rejected[0]["text"]


async def test_same_llm_turn_spawn_agents_share_spawn_group_id_without_persisting_arg():
    """Multiple general-purpose spawns from one LLM turn render as one tree."""
    tool_calls = [
        {
            "tool": "spawn_agent",
            "type": "general_purpose",
            "goal": "Research alpha",
            "output_schema": {"fields": []},
        },
        {
            "tool": "spawn_agent",
            "type": "general_purpose",
            "goal": "Research beta",
            "output_schema": {"fields": []},
        },
    ]
    detected_tools = [
        ("spawn_agent", "tc-spawn-a", 1.0),
        ("spawn_agent", "tc-spawn-b", 2.0),
    ]

    _result, posted, executed = await _run_single_iteration(tool_calls, detected_tools)

    assert len(executed) == 2
    group_ids = [call["tool_args"].get("_spawn_group_id") for call in executed]
    assert group_ids == ["llm-turn:execute:1:tc-spawn-a", "llm-turn:execute:1:tc-spawn-a"]

    assistant_posts = [m for m in posted if m["role"] == "ASSISTANT"]
    assert len(assistant_posts) == 1
    persisted_calls = assistant_posts[0]["metadata"]["tool_calls"]
    assert all("_spawn_group_id" not in call for call in persisted_calls)


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


async def test_general_purpose_agent_executes_after_explore_results():
    """Completed explore children should not block later general-purpose work."""
    initial_context = [
        {"role": "USER", "text": "Compare three cities", "timestamp": "2024-01-01T00:00:00Z"},
    ]
    for idx, city in enumerate(("Austin", "Denver", "Lisbon"), start=1):
        tool_call_id = f"explore-{idx}"
        initial_context.append(
            {
                "role": "ASSISTANT",
                "text": "",
                "timestamp": f"2024-01-01T00:00:0{idx}Z",
                "metadata": {
                    "tool_calls": [
                        {
                            "tool": "spawn_agent",
                            "tool_call_id": tool_call_id,
                            "type": "explore",
                            "goal": f"Research {city}",
                        }
                    ]
                },
            }
        )
        initial_context.append(
            {
                "role": "TOOL",
                "text": f"{city} research complete",
                "timestamp": f"2024-01-01T00:00:1{idx}Z",
                "metadata": {
                    "toolCallId": tool_call_id,
                    "toolName": "spawn_agent",
                    "toolStatus": "FINISHED",
                },
            }
        )

    tool_calls = [
        {
            "tool": "spawn_agent",
            "type": "general_purpose",
            "goal": "Analyze Dave Asprey using the newly discovered creator list",
            "start_phase": "execute",
            "output_schema": {"fields": [{"name": "summary", "type": "str", "required": True}]},
        }
    ]
    detected_tools = [("spawn_agent", "tc-general-synthesis", 1.0)]

    result, posted, executed = await _run_single_iteration(
        tool_calls,
        detected_tools,
        initial_context=initial_context,
        max_iterations=1,
    )

    assert result["status"] == "max_iterations"
    assert len(executed) == 1
    assert executed[0]["tool_name"] == "spawn_agent"
    assert executed[0]["tool_call_id"] == "tc-general-synthesis"
    tool_errors = [m for m in posted if m["role"] == "TOOL" and (m["metadata"] or {}).get("toolStatus") == "ERROR"]
    assert tool_errors == []


async def test_attempt_completion_skip_verification_returns_completed():
    """When attempt_completion fires with skip_verification, status is 'completed'.
    Without an explicit result, final_response falls back to assistant narration.
    Helper sends "" so final_response is "".
    """
    tool_calls = [
        {"tool": "attempt_completion"},
    ]
    detected_tools = [("attempt_completion", "tc-ac-1", 1.0)]

    completion_calls = []

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        completion_calls.append((tool_name, tool_args, tool_call_id))
        return {"message": "ac done"}

    result, posted, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=True,
        execute_tool_override=mock_execute_tool,
    )

    assert result["status"] == "completed"
    assert result["final_response"] == ""
    assert completion_calls == [("attempt_completion", {}, "tc-ac-1")]


async def test_attempt_completion_result_used_when_skip_verification():
    """skip_verification returns attempt_completion.result as final_response."""
    tool_calls = [
        {"tool": "attempt_completion", "result": "final handoff payload"},
    ]
    detected_tools = [("attempt_completion", "tc-ac-1", 1.0)]

    completion_calls = []

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        completion_calls.append((tool_name, tool_args, tool_call_id))
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
    # Verify an error event was emitted for the attempt_completion, not the
    # normal PLAN-complete transition message.
    attempt_events = [ev for ev in handle_events if ev["tool_name"] == "attempt_completion"]
    assert attempt_events
    event = attempt_events[0]["event"]
    assert event.title == "❌ Plan required"
    assert event.message == "You must call set_plan before attempt_completion in PLAN phase"


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


async def test_failed_llm_call_does_not_consume_iteration_budget():
    """A failed LLM call is a retry of the turn, not a turn.

    Regression for agent 16ae3e8f-1e0f-4004-9c58-b74fe34c8a1e: its explore
    sub-agent completed 18 turns of real work, then two failed structured-output
    parses consumed iterations 19 and 20 and it died on "Reached max iterations
    (20)" without ever acting again. `iteration += 1` runs before the LLM call,
    so a call that produced no assistant turn, no tool call and no context
    growth still spent a turn.

    With max_iterations=2 and two transient failures ahead of a good response,
    the agent must still get to execute its tool. Counting the failures leaves
    zero turns for work.
    """
    calls = {"n": 0}

    def factory():
        calls["n"] += 1
        if calls["n"] <= 2:
            raise RuntimeError("transient provider failure")
        return [{"tool": "web_search", "query": "real work"}]

    with patch("loop.run_agent.asyncio.sleep", new=AsyncMock(return_value=None)):
        result, _posted, executed = await _run_single_iteration(
            [{"tool": "web_search", "query": "real work"}],
            [("web_search", "tc-budget-1", 1.0)],
            skip_verification=True,
            max_iterations=2,
            llm_tool_calls_factory=factory,
        )

    assert calls["n"] > 2, (
        f"agent never got past the 2 transient failures — only {calls['n']} LLM "
        "calls made, so the failures consumed the whole iteration budget"
    )
    assert executed, (
        "agent never executed a tool: both iterations were consumed by failed "
        "LLM calls, leaving no budget for real work"
    )
    assert executed[0]["tool_name"] == "web_search"
    assert result["status"] != "error"


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

    completion_calls = []

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        completion_calls.append((tool_name, tool_args, tool_call_id))
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
    assert completion_calls == [("attempt_completion", {"_verification_pending": True}, "tc-ac-1")]


async def test_verifier_score_1_returns_completed():
    """Verifier score==1.0 after attempt_completion returns status='completed' with score."""
    tool_calls = [{"tool": "attempt_completion"}]
    detected_tools = [("attempt_completion", "tc-ac-1", 1.0)]

    completion_calls = []

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        completion_calls.append((tool_name, tool_args, tool_call_id))
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
    assert completion_calls == [("attempt_completion", {"_verification_pending": True}, "tc-ac-1")]

    # Orphan-tool guard: the returned context must contain a FINISHED tool_result
    # row for the attempt_completion tool_call_id. Without this, downstream LLM
    # calls (e.g. completion_summary) serialize the assistant's function_call
    # without a paired function_call_output and 400 on the Codex Responses API.
    returned_ctx = result["context"]
    finished_for_tc = [
        msg
        for msg in returned_ctx
        if msg.get("role") == "TOOL"
        and (msg.get("metadata") or {}).get("toolCallId") == "tc-ac-1"
        and (msg.get("metadata") or {}).get("toolStatus") == "FINISHED"
    ]
    assert finished_for_tc, "Expected FINISHED tool_result for attempt_completion in returned context"


async def test_estimate_tokens():
    """_estimate_tokens counts everything rendered, not just m["text"].

    It is the SAME function the compactor uses (helpers.summarize.
    estimate_context_tokens). Prod agent e14d5abb (2026-08-03) hard-failed
    because the two disagreed: this counted only text, so text-empty ASSISTANT
    rows carrying their whole payload in metadata.tool_calls scored ~0 and
    dropping them "saved" nothing while the added summary was fully counted —
    compaction grew the context by 1698 tokens.
    """
    from helpers.summarize import estimate_context_tokens
    from loop.run_agent import _estimate_tokens

    text_only = [
        {"text": "Hello world this is a test message", "metadata": {}},
        {"text": "Another message here with more content", "metadata": {}},
    ]
    assert _estimate_tokens(text_only) == estimate_context_tokens(text_only) > 0

    # Production-shaped rows: empty text, payload entirely in metadata. These
    # must carry real weight, not ~0.
    metadata_only = [
        {
            "role": "ASSISTANT",
            "text": "",
            "metadata": {
                "tool_calls": [{"tool": "spawn_agent", "tool_call_id": "tc-1", "goal": "find a phone number " * 50}]
            },
        },
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolName": "grep",
                "structured_response": {"matches": [{"path": "network/contact.contact"}] * 20},
            },
        },
    ]
    assert _estimate_tokens(metadata_only) > 100
    assert _estimate_tokens(metadata_only) == estimate_context_tokens(metadata_only)


async def test_compress_context_rejects_non_shrinking_result():
    """A "compaction" that returns a LARGER context is a failure, not a success.

    Adopting it guarantees the overflow trigger fires again on the next check —
    the loop that killed prod agent e14d5abb. The activity runs out-of-process
    (possibly on an older build), so the caller re-checks rather than trusting
    success=True.
    """
    from loop.run_agent import _compress_context

    context = [{"role": "USER", "text": "original body " * 100}]
    grown = [{"role": "USER", "text": "summary that is somehow even longer " * 100}]

    async def mock_execute_activity(fn, args=None, **kwargs):
        return {"context": grown, "usage": {}, "success": True}

    result_ctx, success = await _compress_context(mock_execute_activity, context, "rose-lite")

    assert success is False
    assert result_ctx is context


async def test_compress_context_returns_new_context_on_success():
    """_compress_context returns (new_context, True) when activity succeeds."""
    from loop.run_agent import _compress_context

    captured_args = []
    new_context = [{"role": "USER", "text": "summarized"}]

    async def mock_execute_activity(fn, args=None, **kwargs):
        captured_args.append((fn, args, kwargs))
        return {
            "context": new_context,
            "usage": {"prompt_tokens": 3, "completion_tokens": 2},
            "success": True,
        }

    tokens_recorded = []

    async def on_tokens(in_, out_, model, **kwargs):
        tokens_recorded.append((in_, out_, model, kwargs))

    # Input must genuinely exceed the compacted output: _compress_context
    # rejects a result that does not shrink the context.
    context = [{"role": "USER", "text": "hi there, this is the pre-compaction body. " * 20}]
    result_ctx, success = await _compress_context(
        mock_execute_activity,
        context,
        "rose-lite",
        on_tokens=on_tokens,
    )

    assert success is True
    assert result_ctx == new_context
    assert captured_args[0][1] == [
        context,
        len(context),
        "rose-lite",
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    ]
    assert len(tokens_recorded) == 1
    assert tokens_recorded[0][0] == 3
    assert tokens_recorded[0][1] == 2


async def test_compress_context_forwards_compute_token_context():
    """_compress_context forwards cached direct auth into the compression activity."""
    from loop.run_agent import _compress_context

    captured_args = []

    async def mock_execute_activity(fn, args=None, **kwargs):
        captured_args.append((fn, args, kwargs))
        return {"context": [{"role": "USER", "text": "ok"}], "usage": {}, "success": True}

    await _compress_context(
        mock_execute_activity,
        [{"role": "USER", "text": "x"}],
        "rose-lite",
        agent_id="agent-1",
        user_id="user-1",
        gpt_token="gpt-token",
        gpt_account_id="acct-1",
        gpt_token_source="user",
        gpt_token_pool_id="pool-1",
    )

    assert captured_args[0][1] == [
        [{"role": "USER", "text": "x"}],
        1,
        "rose-lite",
        None,
        None,
        None,
        "user-1",
        "gpt-token",
        "acct-1",
        "user",
        "pool-1",
        "user-1",
        "agent-1",
        None,
        None,
    ]


async def test_run_agent_reuses_rotated_compute_token_next_iteration():
    """A successful in-call provider rotation should become the next iteration's direct token."""
    from loop.run_agent import run_agent

    llm_kwargs = []
    posted_messages = []

    async def system_prompt():
        return "System prompt"

    async def verifier_prompt():
        return "Verifier prompt"

    async def post_message(text, role, metadata=None):
        posted_messages.append({"text": text, "role": role, "metadata": metadata})

    async def execute_tool(tool_name, tool_args, tool_call_id):
        posted_messages.append(
            {
                "text": f"{tool_name} complete",
                "role": "TOOL",
                "metadata": {
                    "toolCallId": tool_call_id,
                    "toolName": tool_name,
                    "toolStatus": "FINISHED",
                },
            }
        )
        return {"message": f"{tool_name} complete"}

    async def mock_call_llm_structured_streaming(**kwargs):
        llm_kwargs.append(kwargs)
        if len(llm_kwargs) == 1:
            return (
                _DummyLLMResult("", [{"tool": "web_search", "query": "first"}]),
                {
                    "prompt_tokens": 1,
                    "completion_tokens": 1,
                    "total_tokens": 2,
                    "actual_model": "claude-sonnet-4-6-claude",
                    "gpt_token_error": "stall",
                    "compute_token_used": {
                        "type": "claude",
                        "accessToken": "rotated-claude-token",
                        "source": "pool",
                        "poolTokenId": "pool-1",
                    },
                    "compute_token_rotated": True,
                },
                [("web_search", "tc-web-search-1", 1.0)],
            )
        return (
            _DummyLLMResult("", []),
            {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            [],
        )

    with patch(
        "loop.run_agent.call_llm_structured_streaming",
        new=AsyncMock(side_effect=mock_call_llm_structured_streaming),
    ):
        await run_agent(
            agent_id="agent-test",
            user_id="user-test",
            system_prompt=system_prompt,
            verifier_prompt_generator=verifier_prompt,
            model="rose-labs/rose-1-lite",
            tools=["web_search", "attempt_completion"],
            initial_context=[{"role": "USER", "text": "Find updates", "timestamp": "2024-01-01T00:00:00Z"}],
            is_inside_temporal_activity=True,
            post_message=post_message,
            execute_tool=execute_tool,
            build_messages=lambda context, prompt: [{"role": "system", "content": prompt}],
            max_iterations=2,
            skip_verification=True,
            skip_status_updates=True,
            gpt_token="stale-gpt-token",
            gpt_account_id="acct-1",
            get_gpt_token_source=lambda: "user",
        )

    assert len(llm_kwargs) == 2
    assert llm_kwargs[0]["gpt_token"] == "stale-gpt-token"
    assert llm_kwargs[0]["claude_token"] is None
    assert llm_kwargs[1]["claude_token"] == "rotated-claude-token"
    assert llm_kwargs[1]["claude_token_source"] == "pool"
    assert llm_kwargs[1]["claude_token_pool_id"] == "pool-1"
    assert llm_kwargs[1]["gpt_token"] is None


async def test_fast_cache_position_retries_same_step_after_llm_failure():
    """A failed LLM attempt must not consume the next fast-cache position."""
    from loop.run_agent import run_agent
    import providers.fast_cache.context as fast_cache_context

    cache_steps = []
    llm_calls = []
    posted_messages = []

    async def system_prompt():
        return "System prompt"

    async def verifier_prompt():
        return "Verifier prompt"

    async def post_message(text, role, metadata=None):
        posted_messages.append({"text": text, "role": role, "metadata": metadata})

    async def mock_call_llm_structured_streaming(**kwargs):
        llm_calls.append(kwargs)
        if len(llm_calls) == 1:
            raise RuntimeError("[SSL: SSLV3_ALERT_BAD_RECORD_MAC] bad record mac")
        return (
            _DummyLLMResult("", []),
            {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            [],
        )

    def mock_set_context(ctx):
        cache_steps.append(ctx.base_step)

    with (
        patch(
            "loop.run_agent.call_llm_structured_streaming",
            new=AsyncMock(side_effect=mock_call_llm_structured_streaming),
        ),
        patch("loop.run_agent.asyncio.sleep", new=AsyncMock()),
        patch.object(fast_cache_context, "set_context", side_effect=mock_set_context),
        patch.object(fast_cache_context, "write_through_enabled_for_user", return_value=False),
    ):
        result = await run_agent(
            agent_id="agent-test",
            user_id="user-test",
            system_prompt=system_prompt,
            verifier_prompt_generator=verifier_prompt,
            model="rose-labs/rose-1-lite",
            tools=["attempt_completion"],
            initial_context=[{"role": "USER", "text": "Find updates", "timestamp": "2024-01-01T00:00:00Z"}],
            is_inside_temporal_activity=True,
            post_message=post_message,
            execute_tool=AsyncMock(),
            build_messages=lambda context, prompt: [{"role": "system", "content": prompt}],
            max_iterations=2,
            skip_verification=True,
            skip_status_updates=True,
            fast_mode_cache_enabled=True,
            goal_text="stable fast cache goal",
        )

    # 3 calls: the failed attempt is retried without spending an iteration
    # (see failed_llm_call_does_not_consume_iteration_budget), so both of
    # max_iterations=2's turns remain available for real work.
    assert len(llm_calls) == 3
    # The invariant under test: the retry reuses the SAME fast-cache step.
    assert cache_steps[:2] == [1, 1]
    assert result["status"] in {"max_iterations", "error"}


async def test_run_agent_refusal_retry_excludes_anthropic_without_backoff():
    from loop.run_agent import run_agent
    from providers.rose.errors import RoseRefusalError

    llm_calls = []

    async def system_prompt():
        return "System prompt"

    async def verifier_prompt():
        return "Verifier prompt"

    async def post_message(text, role, metadata=None):
        return None

    async def mock_call_llm_structured_streaming(**kwargs):
        llm_calls.append(kwargs)
        if len(llm_calls) == 1:
            raise RoseRefusalError("Anthropic stream ended with refusal (request_id=r-test)")
        return (
            _DummyLLMResult("", []),
            {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            [],
        )

    sleep_mock = AsyncMock()
    with (
        patch(
            "loop.run_agent.call_llm_structured_streaming",
            new=AsyncMock(side_effect=mock_call_llm_structured_streaming),
        ),
        patch("loop.run_agent.asyncio.sleep", new=sleep_mock),
    ):
        result = await run_agent(
            agent_id="agent-test",
            user_id="user-test",
            system_prompt=system_prompt,
            verifier_prompt_generator=verifier_prompt,
            model="rose-labs/rose-1-lite",
            tools=["attempt_completion"],
            initial_context=[{"role": "USER", "text": "Find updates", "timestamp": "2024-01-01T00:00:00Z"}],
            is_inside_temporal_activity=True,
            post_message=post_message,
            execute_tool=AsyncMock(),
            build_messages=lambda context, prompt: [{"role": "system", "content": prompt}],
            max_iterations=2,
            skip_verification=True,
            skip_status_updates=True,
        )

    # 3 calls: the refused attempt is retried without spending an iteration.
    assert len(llm_calls) == 3
    assert llm_calls[0]["_exclude_anthropic_family"] is False
    assert llm_calls[1]["_exclude_anthropic_family"] is True
    assert not any(call.args == (2,) for call in sleep_mock.await_args_list)
    assert result["status"] in {"max_iterations", "error"}


def test_is_refusal_error_detects_type_message_and_cause_chain():
    """_is_refusal_error matches by type, by message, and through the cause chain."""
    from loop.run_agent import _is_refusal_error
    from providers.rose.errors import RoseRefusalError

    # Direct type match.
    assert _is_refusal_error(RoseRefusalError("refused")) is True

    # String-based match on a non-RoseRefusalError exception.
    assert _is_refusal_error(RuntimeError("Anthropic stream ended with refusal")) is True

    # Match reached by walking the __cause__ chain.
    inner = RuntimeError("stream ended with refusal")
    outer = ValueError("wrapper")
    outer.__cause__ = inner
    assert _is_refusal_error(outer) is True

    # Non-refusal errors are not misclassified; a self-cycle must not loop forever.
    benign = ValueError("deadline exceeded")
    benign.__context__ = benign
    assert _is_refusal_error(benign) is False


def test_error_chain_has_type_detects_temporal_application_error():
    """Workflow boundaries can identify a typed ApplicationError through its wrapper."""
    from utils.error_utils import error_chain_has_type

    application_error = RuntimeError("structured output invalid")
    application_error.type = "LLMStructuredOutputError"
    activity_error = RuntimeError("Activity task failed")
    activity_error.cause = application_error

    assert error_chain_has_type(activity_error, "LLMStructuredOutputError") is True
    assert error_chain_has_type(activity_error, "RoseRefusalError") is False


async def test_compress_context_failure_preserves_original():
    """On activity failure (success=False), return (original_context, False) — no clobber."""
    from loop.run_agent import _compress_context

    async def mock_execute_activity(*args, **kwargs):
        return {"context": None, "usage": {}, "success": False, "error": "boom"}

    original = [{"role": "USER", "text": "x"}]
    result_ctx, success = await _compress_context(mock_execute_activity, original, "rose-lite")
    assert success is False
    assert result_ctx is original


async def test_compress_context_activity_exception_preserves_original():
    """When the activity itself raises, _compress_context returns (original, False)."""
    from loop.run_agent import _compress_context

    async def mock_execute_activity(*args, **kwargs):
        raise RuntimeError("temporal exploded")

    original = [{"role": "USER", "text": "x"}]
    result_ctx, success = await _compress_context(mock_execute_activity, original, "rose-lite")
    assert success is False
    assert result_ctx is original


async def test_run_agent_errors_when_compaction_still_over_trigger():
    """Successful but ineffective compaction should not continue_as_new or call the LLM.

    ``_compress_context`` is patched out here, so this covers the loop-level
    contract only: a compaction that lands at or above the trigger returns
    status=error. The producer-side guard (reject a compaction that does not
    shrink the context at all) is covered by
    ``test_compress_context_rejects_non_shrinking_result``.
    """
    import loop.run_agent as run_mod

    async def system_prompt():
        return "System prompt"

    async def verifier_prompt():
        return "Verifier prompt"

    async def fake_compress_context(**kwargs):
        compressed = [{"role": "USER", "text": "y" * 400, "timestamp": "2024-01-01T00:00:00Z"}]
        return compressed, True

    async def fail_llm(**kwargs):
        raise AssertionError("LLM should not be called after ineffective compaction")

    initial_context = [{"role": "USER", "text": "x" * 400, "timestamp": "2024-01-01T00:00:00Z"}]

    with (
        patch.object(run_mod, "EFFECTIVE_OUTPUT_RESERVATION", 0),
        patch.object(run_mod, "AUTOCOMPACT_BUFFER_TOKENS", 10),
        patch.object(run_mod, "_compress_context", new=AsyncMock(side_effect=fake_compress_context)),
        patch.object(run_mod, "call_llm_structured_streaming", new=AsyncMock(side_effect=fail_llm)),
    ):
        result = await run_mod.run_agent(
            agent_id="agent-test",
            user_id="user-test",
            system_prompt=system_prompt,
            verifier_prompt_generator=verifier_prompt,
            model="rose-labs/rose-1-lite",
            tools=["attempt_completion"],
            initial_context=initial_context,
            is_inside_temporal_activity=True,
            build_messages=lambda context, prompt: [{"role": "system", "content": prompt}],
            max_iterations=1,
            max_context_tokens=100,
            skip_verification=True,
            skip_status_updates=True,
        )

    assert result["status"] == "error"
    assert "Context compression ineffective" in result["message"]
    assert result["context"] == initial_context


async def test_run_agent_errors_when_compactor_breaker_open_over_trigger():
    """An open compactor circuit breaker must fail loudly, not send an oversized context.

    The breaker guard at the top of the loop used to only *skip* compaction, so
    after MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES the loop fell through and shipped
    an over-window context to the provider on every remaining iteration — a
    length error that says nothing about compaction.
    """
    import loop.run_agent as run_mod

    async def system_prompt():
        return "System prompt"

    async def verifier_prompt():
        return "Verifier prompt"

    async def fail_llm(**kwargs):
        raise AssertionError("LLM must not be called with an un-compactable oversized context")

    async def fail_compress(**kwargs):
        raise AssertionError("compaction must not be attempted while the breaker is open")

    initial_context = [{"role": "USER", "text": "x" * 400, "timestamp": "2024-01-01T00:00:00Z"}]

    with (
        patch.object(run_mod, "EFFECTIVE_OUTPUT_RESERVATION", 0),
        patch.object(run_mod, "AUTOCOMPACT_BUFFER_TOKENS", 10),
        patch.object(run_mod, "MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES", 0),  # breaker already open
        patch.object(run_mod, "_compress_context", new=AsyncMock(side_effect=fail_compress)),
        patch.object(run_mod, "call_llm_structured_streaming", new=AsyncMock(side_effect=fail_llm)),
    ):
        result = await run_mod.run_agent(
            agent_id="agent-test",
            user_id="user-test",
            system_prompt=system_prompt,
            verifier_prompt_generator=verifier_prompt,
            model="rose-labs/rose-1-lite",
            tools=["attempt_completion"],
            initial_context=initial_context,
            is_inside_temporal_activity=True,
            build_messages=lambda context, prompt: [{"role": "system", "content": prompt}],
            max_iterations=1,
            max_context_tokens=100,
            skip_verification=True,
            skip_status_updates=True,
        )

    assert result["status"] == "error"
    assert "Context compression unavailable" in result["message"]
    assert result["context"] == initial_context


async def test_run_verifier_posts_in_progress_and_finished():
    """_run_verifier posts actionable feedback as the attempt_completion result."""
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
        tool_call_id="tc-attempt",
    )

    assert result["score"] == 0.75
    assert len(captured) == 2
    in_progress = captured[0]
    finished = captured[1]
    assert in_progress["metadata"]["toolStatus"] == "IN_PROGRESS"
    assert finished["metadata"]["toolStatus"] == "FINISHED"
    assert in_progress["metadata"]["toolCallId"] == "tc-attempt"
    assert finished["metadata"]["toolCallId"] == "tc-attempt"
    assert "verifierMessage" not in in_progress["metadata"]
    assert finished["metadata"]["verifierMessage"] is True
    assert finished["metadata"]["title"] == "⚖️ Verifier rejected (75%) — continue task"
    assert "Verifier score: 75%" in finished["text"]
    assert "Take a NEW action" in finished["text"]
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


async def test_completed_browser_output_forces_parent_completion_instead_of_second_browser():
    """A verified browser result must complete without replacing the tool schema.

    Regression: the simulated Amazon checkout browser returned a terminal,
    schema-complete result, but the unrestricted next root turn spawned a second
    browser session instead of calling attempt_completion. The parent verifier
    already accepts this exact child output, so the only legal next tool is the
    completion boundary. The completion instruction + required-tool validation
    enforce that boundary while preserving the original tool schema; narrowing
    the schema here invalidates the provider prompt-cache prefix on the handoff
    turn (captured in browser-smoke agent e8e0e86a-1f16).
    """
    from helpers.llm import call_llm_activity, check_progress
    from loop import run_agent as run_mod
    from temporalio.exceptions import ApplicationError

    response_schema = {
        "fields": [
            {"name": "purchase_completed", "type": "bool", "required": True},
            {"name": "order_confirmation_id", "type": "str", "required": True},
        ]
    }
    context = [
        {"role": "USER", "text": "Buy the item", "timestamp": "2026-07-21T00:00:00Z"},
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2026-07-21T00:00:01Z",
            "metadata": {
                "tool_calls": [
                    {
                        "tool": "spawn_agent",
                        "tool_call_id": "browser-one",
                        "type": "browser",
                        "goal": "Complete checkout",
                        "output_schema": response_schema,
                    }
                ]
            },
        },
        {
            "role": "TOOL",
            "text": "Browser automation complete",
            "timestamp": "2026-07-21T00:00:02Z",
            "metadata": {
                "toolCallId": "browser-one",
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "title": "Browser automation complete",
                "structured_response": {
                    "purchase_completed": True,
                    "order_confirmation_id": "111-2222222-3333333",
                },
            },
        },
    ]
    llm_calls = []
    executed_tools = []

    async def mock_execute_activity(fn, args=None, **_kwargs):
        if fn is call_llm_activity:
            llm_calls.append(args)
            required_tool = args[11]
            # The real activity rejects a wrong required tool non-retryably;
            # run_agent, not Temporal, owns the next semantic turn.
            if len(llm_calls) == 1:
                raise ApplicationError(
                    "LLM must call exactly one tool, 'attempt_completion'. Got: ['spawn_agent']",
                    type="LLMStructuredOutputError",
                    non_retryable=True,
                )
            tool_name = "attempt_completion" if required_tool == "attempt_completion" else "spawn_agent"
            tool_call = {"tool": tool_name}
            if tool_name == "spawn_agent":
                tool_call.update(
                    {
                        "type": "browser",
                        "goal": "Complete checkout again",
                        "start_url": "https://www.amazon.com",
                        "output_schema": response_schema,
                    }
                )
            return {
                "response": "",
                "tool_calls": [tool_call],
                "detected_tools_ordered": [(tool_name, "next-tool", 1.0)],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
        if fn is check_progress:
            return {
                "score": 1.0,
                "reasoning": "The completed browser child supplied every required field.",
                "structured_response": context[-1]["metadata"]["structured_response"],
                "usage": {},
            }
        raise AssertionError(f"Unexpected activity: {fn}")

    async def execute_tool(tool_name, _tool_args, _tool_call_id):
        executed_tools.append(tool_name)
        return {"message": f"{tool_name} complete"}

    async def prompt():
        return "System prompt"

    with (
        patch.object(run_mod.workflow, "execute_activity", new=AsyncMock(side_effect=mock_execute_activity)),
        patch.object(run_mod.asyncio, "sleep", new=AsyncMock()),
    ):
        result = await run_mod.run_agent(
            agent_id="amazon-parent",
            user_id="user-test",
            system_prompt=prompt,
            verifier_prompt_generator=prompt,
            model="rose-labs/rose-1-lite",
            tools=["spawn_agent", "attempt_completion"],
            initial_context=context,
            is_inside_temporal_activity=False,
            post_message=AsyncMock(),
            execute_tool=execute_tool,
            max_iterations=2,
            skip_status_updates=True,
            response_schema=response_schema,
            fast_mode_cache_enabled=True,
        )

    assert result["status"] == "completed"
    assert executed_tools == ["attempt_completion"]
    assert len(llm_calls) == 2
    assert llm_calls[0][25] is True
    assert llm_calls[1][25] is False
    for call in llm_calls:
        assert call[2] == ["spawn_agent", "attempt_completion"]
        assert call[11] == "attempt_completion"
        assert "already completed" in call[10]
        assert call[30] == "agent:amazon-parent:call:execute_loop"


async def test_verifier_usage_preserves_cache_sequence_identity():
    usage_calls = []

    async def capture_usage(_tokens_in, _tokens_out, _model, **metadata):
        usage_calls.append(metadata)

    await _run_single_iteration(
        [{"tool": "web_search", "query": "x"}],
        [("web_search", "tc-1", 1.0)],
        skip_verification=False,
        max_iterations=1,
        verifier_score=0.3,
        verifier_usage={
            "prompt_tokens": 5,
            "completion_tokens": 6,
            "total_tokens": 11,
            "cache_sequence_id": "verifier-sequence",
        },
        on_tokens_override=capture_usage,
    )

    verifier_calls = [call for call in usage_calls if call["call_site"].startswith("verifier_")]
    assert verifier_calls
    assert all(call["cache_sequence_id"] == "verifier-sequence" for call in verifier_calls)


async def test_completed_child_required_tool_is_enforced_inside_direct_activity():
    """The inline activity path retries instead of dispatching a non-completion tool."""
    import providers.fast_cache.context as fast_cache_context

    response_schema = {
        "fields": [
            {"name": "purchase_completed", "type": "bool", "required": True},
            {"name": "order_confirmation_id", "type": "str", "required": True},
        ]
    }
    child_result = {
        "purchase_completed": True,
        "order_confirmation_id": "111-2222222-3333333",
    }
    context = [
        {"role": "USER", "text": "Buy the item", "timestamp": "2026-07-21T00:00:00Z"},
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2026-07-21T00:00:01Z",
            "metadata": {
                "tool_calls": [
                    {
                        "tool": "spawn_agent",
                        "tool_call_id": "browser-one",
                        "type": "browser",
                        "goal": "Complete checkout",
                        "output_schema": response_schema,
                    }
                ]
            },
        },
        {
            "role": "TOOL",
            "text": "Browser automation complete",
            "timestamp": "2026-07-21T00:00:02Z",
            "metadata": {
                "toolCallId": "browser-one",
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "structured_response": child_result,
            },
        },
    ]
    cache_contexts = []
    stream_sequences = []
    stream_final_sequences = []
    response_models = []
    auth_calls = []
    usage_reports = []
    event_order = []
    llm_call_count = 0
    original_set_context = fast_cache_context.set_context

    class CapturingBroadcaster:
        def __init__(self, **_kwargs):
            pass

        def update(self, _delta, sequence):
            stream_sequences.append(sequence)

        def reset(self):
            pass

        async def aclose(self, *, final_delta, final_sequence, await_done_broadcast):
            del final_delta, await_done_broadcast
            stream_final_sequences.append(final_sequence)

        async def adispose(self):
            pass

    def capture_cache_context(cache_context):
        cache_contexts.append((cache_context.read_enabled, cache_context.should_write, cache_context.base_step))
        return original_set_context(cache_context)

    def replay_while_cache_is_active():
        nonlocal llm_call_count
        llm_call_count += 1
        event_order.append(f"llm_{llm_call_count}")
        cache_context = fast_cache_context.current_context()
        if cache_context is not None and cache_context.active:
            return [{"tool": "web_search", "query": "replayed rejected response"}]
        return [{"tool": "attempt_completion"}]

    async def capture_usage(tokens_in, tokens_out, actual_model, **metadata):
        usage_reports.append((tokens_in, tokens_out, actual_model, metadata))
        event_order.append(f"usage_{actual_model}")

    async def capture_pause_check():
        if event_order and event_order[-1].startswith("usage_"):
            event_order.append("pause_check_after_usage")
        return False

    from pydantic import BaseModel, Field

    class CustomBrowserAction(BaseModel):
        response: str = ""
        tool_calls: list = Field(default_factory=list)

    with (
        patch.object(fast_cache_context, "set_context", side_effect=capture_cache_context),
        patch.object(fast_cache_context, "write_through_enabled_for_user", return_value=False),
        patch("loop.run_agent.CoalescingStreamBroadcaster", CapturingBroadcaster),
        patch("loop.run_agent.activity.heartbeat"),
    ):
        result, _, executed = await _run_single_iteration(
            [],
            [("attempt_completion", "completion-tool", 1.0)],
            skip_verification=False,
            initial_context=context,
            response_schema=response_schema,
            verifier_structured_response=child_result,
            llm_tool_calls_factory=replay_while_cache_is_active,
            llm_chunk_texts_sequence=["wrong tool", "required tool"],
            llm_usages_sequence=[
                {
                    "prompt_tokens": 11,
                    "completion_tokens": 2,
                    "total_tokens": 13,
                    "cache_read_input_tokens": 3,
                    "actual_model": "rejected-model",
                    "gpt_token_rotated": True,
                    "compute_token_used": {
                        "type": "gpt",
                        "accessToken": "rotated-gpt-token",
                        "accountId": "rotated-gpt-account",
                        "source": "pool",
                        "poolTokenId": "pool-token-2",
                    },
                },
                {
                    "prompt_tokens": 7,
                    "completion_tokens": 5,
                    "total_tokens": 12,
                    "actual_model": "accepted-model",
                },
            ],
            llm_response_models=response_models,
            llm_auth_calls=auth_calls,
            fast_mode_cache_enabled=True,
            goal_text="complete from verified child",
            response_model=CustomBrowserAction,
            on_tokens_override=capture_usage,
            check_paused_override=capture_pause_check,
            gpt_token="stale-gpt-token",
            gpt_account_id="stale-gpt-account",
        )
    original_set_context(None)

    assert result["status"] == "completed"
    assert [item["tool_name"] for item in executed] == ["attempt_completion"]
    assert llm_call_count == 2
    assert cache_contexts == [(True, True, 1), (False, False, 1)]
    assert stream_sequences == [1, 2]
    assert stream_final_sequences == [3]
    assert response_models == [CustomBrowserAction, CustomBrowserAction]
    assert [call["gpt_token"] for call in auth_calls] == ["stale-gpt-token", "rotated-gpt-token"]
    assert [call["gpt_account_id"] for call in auth_calls] == [
        "stale-gpt-account",
        "rotated-gpt-account",
    ]
    assert auth_calls[1]["gpt_token_source"] == "pool"
    assert auth_calls[1]["gpt_token_pool_id"] == "pool-token-2"
    assert usage_reports[0][:3] == (11, 2, "rejected-model")
    assert usage_reports[0][3]["cache_read_input_tokens"] == 3
    assert usage_reports[0][3]["gpt_token_rotated"] is True
    assert usage_reports[1][:3] == (7, 5, "accepted-model")
    assert event_order.index("llm_1") < event_order.index("usage_rejected-model")
    assert event_order.index("usage_rejected-model") < event_order.index("pause_check_after_usage")
    assert event_order.index("pause_check_after_usage") < event_order.index("llm_2")
    assert result["tokens_in"] >= 18
    assert result["tokens_out"] >= 7


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


def _count_winddown_msgs(context):
    return sum(1 for m in context if m.get("role") == "SYSTEM" and "final turn" in (m.get("text") or ""))


async def test_winddown_injects_one_message_near_cap():
    """With winddown_window>0, exactly one 'final turn' SYSTEM message is appended
    to the conversation tail (not the system prompt), and best-effort is returned."""
    tool_calls = [{"tool": "web_search", "query": "x"}]  # never completes -> loops to cap
    detected_tools = [("web_search", "tc-1", 1.0)]

    result, _, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=True,  # explore-like
        max_iterations=3,
        winddown_window=1,
    )

    assert result["status"] == "max_iterations"
    assert _count_winddown_msgs(result["context"]) == 1, "wind-down must inject exactly once"
    assert "best_effort_response" in result
    assert "final_response" in result


async def test_winddown_disabled_by_default():
    """winddown_window=0 (default) injects no wind-down message — keeps it explore-only."""
    tool_calls = [{"tool": "web_search", "query": "x"}]
    detected_tools = [("web_search", "tc-1", 1.0)]

    result, _, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=True,
        max_iterations=3,
        winddown_window=0,
    )

    assert result["status"] == "max_iterations"
    assert _count_winddown_msgs(result["context"]) == 0


async def test_paused_agent_does_not_busy_spin_and_yields_to_cold_handler():
    """Regression for the 2026-07-05 prod worker-starvation incident.

    An orphaned sub-agent (parent workflow terminated) stays paused while its
    wait_for_messages() resolves *instantly* instead of blocking. The old
    top-of-loop pause branch had no floor and no escape, so it `continue`d
    forever without incrementing `iteration` — an infinite busy-loop that
    saturated the Temporal worker. The fix must:
      1. never busy-spin (hard floor between paused iterations), and
      2. yield to the cold pause handler by returning "paused" after a bounded
         number of consecutive paused iterations — never calling the LLM.
    """
    from loop import run_agent as ra

    wait_calls = 0
    llm_called = False

    async def always_paused():
        return True

    async def instant_wait():
        # Orphaned sub-agent: parent gone → the wait returns immediately.
        nonlocal wait_calls
        wait_calls += 1
        return False

    async def mock_system_prompt():
        return "System prompt"

    async def mock_post_message(text, role, metadata=None):
        return None

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {"message": "ok"}

    async def mock_call_llm(**kwargs):
        nonlocal llm_called
        llm_called = True
        return (_DummyLLMResult("", []), {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}, [])

    with (
        # Zero the floor so the test runs instantly; a small escape threshold
        # keeps the assertion tight. max_iterations is huge so the escape
        # hatch — not max_iterations — is what stops the loop.
        patch.object(ra, "PAUSED_WAIT_FLOOR_SECONDS", 0.0),
        patch.object(ra, "MAX_CONSECUTIVE_PAUSED_ITERATIONS", 5),
        patch(
            "loop.run_agent.call_llm_structured_streaming",
            new=AsyncMock(side_effect=mock_call_llm),
        ),
    ):
        # wait_for guards against a genuine infinite loop (the pre-fix bug):
        # the old code never returns here, so this would raise TimeoutError.
        result = await asyncio.wait_for(
            ra.run_agent(
                agent_id="agent-orphan",
                user_id="user-test",
                system_prompt=mock_system_prompt,
                verifier_prompt_generator=mock_system_prompt,
                model="rose-labs/rose-1-lite",
                tools=["attempt_completion"],
                initial_context=[{"role": "USER", "text": "hi", "timestamp": "2024-01-01T00:00:00Z"}],
                is_inside_temporal_activity=True,
                check_paused=always_paused,
                wait_for_messages=instant_wait,
                post_message=mock_post_message,
                execute_tool=mock_execute_tool,
                build_messages=lambda context, prompt: [{"role": "system", "content": prompt}],
                max_iterations=10_000,
                skip_verification=True,
                skip_status_updates=True,
            ),
            timeout=10,
        )

    assert result["status"] == "paused", f"expected paused, got {result['status']}"
    # Escape hatch fires at MAX_CONSECUTIVE_PAUSED_ITERATIONS (5), not at
    # max_iterations (10000). A couple extra calls of slack for the +1 counting.
    assert wait_calls <= 6, f"busy-spin not bounded: wait_for_messages called {wait_calls} times"
    assert not llm_called, "LLM must never run while the agent is paused"


async def run_all_tests():
    print("run-agent blackbox tests:")
    r = BlackboxResult()
    await r.record_async(
        "iteration_offset_reported_with_usage",
        test_iteration_offset_is_reported_with_each_billed_llm_turn,
    )
    await r.record_async(
        "terminal_abort_stops_before_llm_or_tool_work",
        test_terminal_abort_stops_before_any_llm_or_tool_work,
    )
    await r.record_async(
        "out_of_credits_does_no_llm_or_tool_work",
        test_out_of_credits_state_does_no_llm_or_tool_work,
    )
    await r.record_async(
        "tool_only_assistant_turn_persists_tool_calls", test_tool_only_assistant_turn_persists_tool_calls
    )
    await r.record_async(
        "rejected_completion_continues_with_stable_schema",
        test_rejected_completion_continues_with_stable_schema,
    )
    await r.record_async(
        "rejected_completion_posts_error_in_workflow_polling_mode",
        test_rejected_completion_posts_error_in_workflow_polling_mode,
    )
    await r.record_async(
        "same_llm_turn_spawn_agents_share_spawn_group_id",
        test_same_llm_turn_spawn_agents_share_spawn_group_id_without_persisting_arg,
    )
    await r.record_async(
        "assistant_tool_call_ids_match_execution_and_context_results",
        test_assistant_tool_call_ids_match_execution_and_context_results,
    )
    await r.record_async(
        "general_purpose_agent_executes_after_explore_results",
        test_general_purpose_agent_executes_after_explore_results,
    )
    await r.record_async(
        "attempt_completion_skip_verification_returns_completed",
        test_attempt_completion_skip_verification_returns_completed,
    )
    await r.record_async(
        "attempt_completion_result_used_when_skip_verification",
        test_attempt_completion_result_used_when_skip_verification,
    )
    await r.record_async(
        "attempt_completion_plan_loop_requires_set_plan", test_attempt_completion_plan_loop_requires_set_plan
    )
    await r.record_async(
        "plan_loop_completes_when_set_plan_then_attempt_completion",
        test_plan_loop_completes_when_set_plan_then_attempt_completion,
    )
    await r.record_async(
        "no_tool_calls_nudges_then_errors_after_3_consecutive",
        test_no_tool_calls_nudges_then_errors_after_3_consecutive,
    )
    await r.record_async(
        "tool_exception_continues_loop_and_posts_error", test_tool_exception_continues_loop_and_posts_error
    )
    await r.record_async(
        "failed_llm_call_does_not_consume_iteration_budget",
        test_failed_llm_call_does_not_consume_iteration_budget,
    )
    await r.record_async("status_needs_user_help_returned_from_tool", test_status_needs_user_help_returned_from_tool)
    await r.record_async("status_completed_from_tool", test_status_completed_from_tool)
    await r.record_async(
        "verifier_below_threshold_adds_feedback_and_loops", test_verifier_below_threshold_adds_feedback_and_loops
    )
    await r.record_async("verifier_score_1_returns_completed", test_verifier_score_1_returns_completed)
    await r.record_async("estimate_tokens", test_estimate_tokens)
    await r.record_async(
        "compress_context_returns_new_context_on_success", test_compress_context_returns_new_context_on_success
    )
    await r.record_async(
        "compress_context_rejects_non_shrinking_result", test_compress_context_rejects_non_shrinking_result
    )
    await r.record_async(
        "compress_context_forwards_compute_token_context", test_compress_context_forwards_compute_token_context
    )
    await r.record_async(
        "run_agent_reuses_rotated_compute_token_next_iteration",
        test_run_agent_reuses_rotated_compute_token_next_iteration,
    )
    await r.record_async(
        "fast_cache_position_retries_same_step_after_llm_failure",
        test_fast_cache_position_retries_same_step_after_llm_failure,
    )
    await r.record_async(
        "run_agent_refusal_retry_excludes_anthropic_without_backoff",
        test_run_agent_refusal_retry_excludes_anthropic_without_backoff,
    )
    r.record("is_refusal_error_type_message_cause_chain", test_is_refusal_error_detects_type_message_and_cause_chain)
    r.record(
        "error_chain_has_type_temporal_application_error",
        test_error_chain_has_type_detects_temporal_application_error,
    )
    await r.record_async(
        "compress_context_failure_preserves_original", test_compress_context_failure_preserves_original
    )
    await r.record_async(
        "compress_context_activity_exception_preserves_original",
        test_compress_context_activity_exception_preserves_original,
    )
    await r.record_async(
        "run_agent_errors_when_compaction_still_over_trigger",
        test_run_agent_errors_when_compaction_still_over_trigger,
    )
    await r.record_async(
        "run_agent_errors_when_compactor_breaker_open_over_trigger",
        test_run_agent_errors_when_compactor_breaker_open_over_trigger,
    )
    await r.record_async(
        "run_verifier_posts_in_progress_and_finished", test_run_verifier_posts_in_progress_and_finished
    )
    await r.record_async("run_verifier_dynamic_schema_getter", test_run_verifier_dynamic_schema_getter)
    await r.record_async(
        "completed_browser_output_forces_parent_completion",
        test_completed_browser_output_forces_parent_completion_instead_of_second_browser,
    )
    await r.record_async(
        "completed_child_required_tool_bypasses_rejected_fast_cache",
        test_completed_child_required_tool_is_enforced_inside_direct_activity,
    )
    await r.record_async("max_iterations_runs_final_verifier", test_max_iterations_runs_final_verifier)
    await r.record_async(
        "verifier_usage_preserves_cache_sequence_identity",
        test_verifier_usage_preserves_cache_sequence_identity,
    )
    await r.record_async("winddown_injects_one_message_near_cap", test_winddown_injects_one_message_near_cap)
    await r.record_async("winddown_disabled_by_default", test_winddown_disabled_by_default)
    await r.record_async(
        "paused_agent_does_not_busy_spin_and_yields_to_cold_handler",
        test_paused_agent_does_not_busy_spin_and_yields_to_cold_handler,
    )
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
