"""Blackbox tests for run_agent assistant/tool persistence invariants."""

import asyncio
from contextlib import asynccontextmanager
import inspect
from types import SimpleNamespace
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from _test_utils import (
    BlackboxResult,
    teardown_mock,
    retained_tool_output_fixture,
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


@asynccontextmanager
async def _owned_realtime_fixture():
    from helpers.messages import flush_realtime_broadcasts_for_tests

    client = MagicMock()
    client.post = AsyncMock(return_value=MagicMock(status_code=200))
    with patch("helpers.messages._get_broadcast_client", return_value=client):
        try:
            yield
        finally:
            await flush_realtime_broadcasts_for_tests()


@_owned_realtime_fixture()
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
    verifier_override=None,
    post_message_override=None,
    get_requirement_revision=None,
    get_response_schema_override=None,
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
    check_paused_before_turn_override=None,
    on_unaccepted_turn_retry_override=None,
    check_generation_handoff_override=None,
    on_context_overflow_override=None,
    check_aborted_override=None,
    gpt_token=None,
    gpt_account_id=None,
    iteration_offset=0,
    system_prompt_override=None,
    verifier_prompt_override=None,
    poll_inbox_override=None,
    build_messages_override=None,
    get_pending_background_status_override=None,
    completion_handoff_override=None,
    llm_response_text="",
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
        if post_message_override is not None:
            await post_message_override(text, role, metadata)

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
            _DummyLLMResult(llm_response_text, selected_tool_calls),
            selected_usage,
            detected_tools_ordered,
        )

    async def mock_check_progress(*args, **kwargs):
        if verifier_override is not None:
            return await verifier_override(*args, **kwargs)
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
            system_prompt=system_prompt_override or mock_system_prompt,
            verifier_prompt_generator=verifier_prompt_override or mock_verifier_prompt,
            model="rose-labs/rose-1-flash",
            tools=["web_search", "web_fetch", "attempt_completion", "set_plan"],
            initial_context=ctx,
            is_inside_temporal_activity=is_inside_temporal_activity,
            post_message=mock_post_message,
            poll_messages=poll_messages_override,
            execute_tool=default_execute_tool,
            **({"completion_handoff": completion_handoff_override} if "completion_handoff" in inspect.signature(run_agent).parameters else {}),
            build_messages=build_messages_override or (lambda context, prompt: [{"role": "system", "content": prompt}]),
            **({"poll_inbox": poll_inbox_override} if poll_inbox_override is not None else {}),
            **(
                {"get_pending_background_status": get_pending_background_status_override}
                if get_pending_background_status_override is not None
                else {}
            ),
            max_iterations=max_iterations,
            iteration_offset=iteration_offset,
            **(
                {"get_requirement_revision": get_requirement_revision}
                if "get_requirement_revision" in inspect.signature(run_agent).parameters
                else {}
            ),
            winddown_window=winddown_window,
            skip_verification=skip_verification,
            skip_status_updates=True,
            is_plan_loop=is_plan_loop,
            response_schema=response_schema,
            get_response_schema=get_response_schema_override,
            response_model=response_model,
            fast_mode_cache_enabled=fast_mode_cache_enabled,
            goal_text=goal_text,
            on_tokens=on_tokens_override,
            check_paused=check_paused_override,
            check_paused_before_turn=check_paused_before_turn_override,
            on_unaccepted_turn_retry=on_unaccepted_turn_retry_override,
            check_generation_handoff=check_generation_handoff_override,
            on_context_overflow=on_context_overflow_override,
            check_aborted=check_aborted_override,
            gpt_token=gpt_token,
            gpt_account_id=gpt_account_id,
        )

    return result, posted_messages, executed_tools


async def test_jev_schedules_every_turn_without_changing_decisions():
    from helpers.jev_progress import JEVSession
    snapshots = []
    def record(session, goal, schema, events):
        snapshots.append({"goal": goal, "schema": schema, "events": events})
    with patch.object(JEVSession, "schedule", record), patch.object(JEVSession, "close") as close:
        result, _, executed = await _run_single_iteration(
            [{"tool": "web_search", "query": "facts"}],
            [("web_search", "tc-jev", 1.0)], max_iterations=2,
            response_schema={"type": "object"},
        )
    assert len(snapshots) == 2
    assert snapshots[0]["events"] == []
    assert sum(e["role"] == "assistant" for e in snapshots[1]["events"]) == 1
    assert snapshots[0]["schema"] == {"type": "object"}
    assert len(executed) == 2 and result["status"] == "max_iterations"
    close.assert_called_once()


async def test_iteration_fixture_retires_its_realtime_sender():
    from helpers import messages

    await _run_single_iteration(
        [{"tool": "web_search", "query": "latest updates"}],
        [("web_search", "tc-realtime-owner", 1.0)],
    )
    assert not messages._broadcast_queue, "iteration fixture left queued realtime work"
    assert not messages._broadcast_draining, "iteration fixture left an active realtime sender"
    assert messages._broadcast_flush_task is None, "iteration fixture left a realtime task"


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


async def test_browser_budget_wrapup_admits_one_complete_stream_and_normal_verification():
    from workflows.agent_workflow import AgentWorkflow

    wf = AgentWorkflow()
    wf._cost_limit_reached = wf._cost_limit_wrapup_pending = True
    with patch("loop.run_agent.activity.heartbeat"):
        result, posted, executed = await _run_single_iteration(
            [{"tool": "attempt_completion"}],
            [("attempt_completion", "budget-complete", 1.0)],
            max_iterations=2,
            skip_verification=False,
            response_schema={"fields": [{"name": "answer", "type": "str"}]},
            llm_chunk_texts_sequence=["Returned browser evidence"],
            check_paused_override=wf._check_paused,
            check_paused_before_turn_override=wf._check_paused_before_turn,
            verifier_structured_response={"answer": "Observed browser result"},
        )
    assert result["status"] == "completed", result
    assert result["structured_response"] == {"answer": "Observed browser result"}
    assert wf._cost_limit_wrapup_consumed
    assert [call["tool_name"] for call in executed] == ["attempt_completion"]
    assert any((row.get("metadata") or {}).get("toolStatus") == "FINISHED" for row in posted)


async def test_browser_budget_handoff_before_llm_preserves_unused_allowance():
    from workflows.agent_workflow import AgentWorkflow

    wf = AgentWorkflow()
    wf._cost_limit_reached = wf._cost_limit_wrapup_pending = True
    wf.max_iterations = None
    wf.context_gates = {}
    handoff = AsyncMock(return_value="next-generation")
    result, posted, executed = await _run_single_iteration(
        [{"tool": "attempt_completion"}],
        [("attempt_completion", "unused-before-handoff", 1.0)],
        check_paused_override=wf._check_paused,
        check_paused_before_turn_override=wf._check_paused_before_turn,
        check_generation_handoff_override=handoff,
    )
    assert result["status"] == "generation_handoff", result
    assert not posted and not executed
    assert not wf._cost_limit_wrapup_consumed, "handoff spent an allowance without a model call"
    state = wf._continuation_resume_state(result["context"])
    restored = AgentWorkflow()
    restored._restore_deployment_state(state)
    with patch("loop.run_agent.activity.heartbeat"):
        completed, _, resumed_tools = await _run_single_iteration(
            [{"tool": "attempt_completion"}],
            [("attempt_completion", "after-handoff", 1.0)],
            max_iterations=2,
            skip_verification=False,
            check_paused_override=restored._check_paused,
            check_paused_before_turn_override=restored._check_paused_before_turn,
            verifier_structured_response={"answer": "Observed browser result"},
        )
    assert completed["status"] == "completed", completed
    assert restored._cost_limit_wrapup_consumed
    assert [call["tool_name"] for call in resumed_tools] == ["attempt_completion"]


async def test_browser_budget_compaction_before_llm_preserves_unused_allowance():
    from workflows.agent_workflow import AgentWorkflow

    class ContinuedAsNew(BaseException):
        pass

    wf = AgentWorkflow()
    wf._cost_limit_reached = wf._cost_limit_wrapup_pending = True

    async def continue_after_compaction(context):
        raise ContinuedAsNew()

    with (
        patch("loop.run_agent._estimate_tokens", side_effect=[200000, 10]),
        patch(
            "loop.run_agent._compress_context",
            new=AsyncMock(return_value=([{"role": "USER", "text": "summary"}], True)),
        ),
    ):
        try:
            await _run_single_iteration(
                [{"tool": "attempt_completion"}],
                [("attempt_completion", "unused-before-compaction", 1.0)],
                check_paused_override=wf._check_paused,
                check_paused_before_turn_override=wf._check_paused_before_turn,
                on_context_overflow_override=continue_after_compaction,
            )
        except ContinuedAsNew:
            pass
        else:
            raise AssertionError("fixture did not reach continue-as-new boundary")
    assert not wf._cost_limit_wrapup_consumed, "compaction spent an allowance without a model call"
    assert not await wf._check_paused_before_turn()
    assert wf._cost_limit_wrapup_consumed


async def test_browser_budget_preparation_retry_does_not_spend_unused_allowance():
    from workflows.agent_workflow import AgentWorkflow
    import loop.run_agent as run_agent_module

    wf = AgentWorkflow()
    wf._cost_limit_reached = wf._cost_limit_wrapup_pending = True
    schema_attempts = 0
    llm_calls = []

    async def current_schema():
        nonlocal schema_attempts
        schema_attempts += 1
        if schema_attempts == 1:
            raise RuntimeError("transient schema lookup failure")
        return {"fields": [{"name": "answer", "type": "str"}]}

    async def stop_at_original_cap():
        wf._cost_limit_reached = wf.is_paused = True

    wf._check_cost_limit = stop_at_original_cap
    with (
        patch("loop.run_agent.activity.heartbeat"),
        patch.object(run_agent_module, "PAUSED_WAIT_FLOOR_SECONDS", 0.0),
        patch.object(run_agent_module, "MAX_CONSECUTIVE_PAUSED_ITERATIONS", 1),
    ):
        result, _, executed = await _run_single_iteration(
            [{"tool": "attempt_completion"}],
            [("attempt_completion", "after-preparation-retry", 1.0)],
            max_iterations=2,
            skip_verification=False,
            llm_auth_calls=llm_calls,
            get_response_schema_override=current_schema,
            on_unaccepted_turn_retry_override=wf._refund_unaccepted_browser_wrapup_turn,
            check_paused_override=wf._check_paused,
            check_paused_before_turn_override=wf._check_paused_before_turn,
            verifier_structured_response={"answer": "Observed browser result"},
        )
    assert result["status"] == "completed", result
    assert schema_attempts >= 2
    assert len(llm_calls) == 1
    assert wf._cost_limit_wrapup_consumed
    assert [call["tool_name"] for call in executed] == ["attempt_completion"]


async def test_browser_budget_accepted_response_failure_does_not_refund_allowance():
    from workflows.agent_workflow import AgentWorkflow
    import loop.run_agent as run_agent_module

    wf = AgentWorkflow()
    wf._cost_limit_reached = wf._cost_limit_wrapup_pending = True
    refund = MagicMock(wraps=wf._refund_unaccepted_browser_wrapup_turn)

    async def stop_at_original_cap():
        wf._cost_limit_reached = wf.is_paused = True

    wf._check_cost_limit = stop_at_original_cap
    with (
        patch("loop.run_agent.activity.heartbeat"),
        patch.object(_DummyToolCall, "model_dump", side_effect=RuntimeError("post-response normalization unavailable")),
        patch.object(run_agent_module, "PAUSED_WAIT_FLOOR_SECONDS", 0.0),
        patch.object(run_agent_module, "MAX_CONSECUTIVE_PAUSED_ITERATIONS", 1),
    ):
        result, _, executed = await _run_single_iteration(
            [{"tool": "attempt_completion"}],
            [("attempt_completion", "accepted-before-bookkeeping-failure", 1.0)],
            max_iterations=5,
            skip_verification=False,
            on_unaccepted_turn_retry_override=refund,
            check_paused_override=wf._check_paused,
            check_paused_before_turn_override=wf._check_paused_before_turn,
        )
    assert result["status"] == "paused", result
    assert wf._cost_limit_wrapup_consumed
    assert not executed
    refund.assert_not_called()


async def test_browser_budget_precall_pause_does_not_spend_iteration():
    admission_checks = 0
    llm_calls = []

    async def admit_after_pause():
        nonlocal admission_checks
        admission_checks += 1
        return admission_checks == 1

    result, _, executed = await _run_single_iteration(
        [{"tool": "attempt_completion"}],
        [("attempt_completion", "after-precall-pause", 1.0)],
        max_iterations=1,
        check_paused_override=AsyncMock(return_value=False),
        check_paused_before_turn_override=admit_after_pause,
        llm_auth_calls=llm_calls,
    )
    assert result["status"] == "completed", result
    assert len(llm_calls) == 1 and admission_checks == 2
    assert [call["tool_name"] for call in executed] == ["attempt_completion"]


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


_MEASURED_USAGE = {
    "prompt_tokens": 10,
    "completion_tokens": 596,
    "total_tokens": 606,
    "request_started_at_ms": 1_793_939_000_000,
    "response_ended_at_ms": 1_793_939_002_400,
}


async def _posted_thought(usage):
    _result, posted, _executed = await _run_single_iteration(
        [{"tool": "web_search", "query": "rose repo"}],
        [("web_search", "tc-web-search-1", 1.0)],
        llm_usages_sequence=[dict(usage)],
        llm_response_text="Searching for the repo first.",
    )
    return [m for m in posted if m["role"] == "ASSISTANT"][0]


async def test_assistant_thought_records_measured_generation():
    """C6 (Andy 2026-11-06): the root thought row's tok/s comes from the call's
    measured output tokens over its request -> stream-end window, never an estimate."""
    assistant = await _posted_thought(_MEASURED_USAGE)
    assert assistant["metadata"]["generation"] == {
        "output_tokens": 596,
        "started_at": "2026-11-06T04:23:20.000Z",
        "ended_at": "2026-11-06T04:23:22.400Z",
    }
    assert assistant["metadata"]["tool_calls"][0]["tool_call_id"] == "tc-web-search-1"
    estimated = {"prompt_tokens": 10, "completion_tokens": 596, "total_tokens": 606}
    for usage in (estimated, {**_MEASURED_USAGE, "from_fast_cache": True}):
        assert "generation" not in ((await _posted_thought(usage))["metadata"] or {})


async def test_thought_generation_metadata_is_invisible_to_every_llm_builder():
    """metadata.generation is UI-only: the main loop, verifier/summary and planner
    message builders produce identical requests with or without it."""
    from domains.set_plan.service import build_planner_messages
    from helpers.llm import build_llm_messages, convert_context_to_messages, llm_generation_metadata

    def context(metadata):
        return [
            {"role": "USER", "text": "Whats our rose repo looking like?", "timestamp": "2026-11-06T04:23:00Z"},
            {
                "role": "ASSISTANT",
                "text": "Searching for the repo first.",
                "timestamp": "2026-11-06T04:23:22Z",
                "metadata": metadata,
            },
            {
                "role": "TOOL",
                "text": "Rose-Ai-Labs/rose",
                "timestamp": "2026-11-06T04:23:24Z",
                "metadata": {"toolCallId": "tc-1", "toolName": "web_search", "toolStatus": "FINISHED"},
            },
        ]

    plain = {"tool_calls": [{"tool": "web_search", "tool_call_id": "tc-1", "query": "rose repo"}]}
    recorded = {**plain, "generation": llm_generation_metadata(_MEASURED_USAGE)}
    assert recorded["generation"]
    assert await build_llm_messages(context(plain), "system") == await build_llm_messages(context(recorded), "system")
    for include_assistant in (False, True):
        assert convert_context_to_messages(
            context(plain), include_assistant=include_assistant
        ) == convert_context_to_messages(context(recorded), include_assistant=include_assistant)
    assert build_planner_messages(context(plain)) == build_planner_messages(context(recorded))


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
            model="rose-labs/rose-1-flash",
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
    async def mock_activity(fn, args=None, **_kwargs):
        from tools.read_tool_output import preview_tool_output_activity
        if fn is preview_tool_output_activity:
            return await fn(*(args or []))
        return workflow_llm_result

    with patch("loop.run_agent.workflow.execute_activity", new=AsyncMock(side_effect=mock_activity)):
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


async def test_no_tool_turn_with_background_agents_gets_normal_no_tool_handling():
    """Running background agents never change a tool-less turn: it is nudged like any other.

    Waiting is the model's choice through wait_for(agents=[...]); run_agent has
    no background-wait hook at all.
    """
    from loop import run_agent as run_agent_module

    assert "wait_for_background_agents" not in inspect.signature(run_agent_module.run_agent).parameters
    result, posted, _ = await _run_single_iteration(
        [],
        [],
        skip_verification=True,
        max_iterations=5,
        get_pending_background_status_override=lambda: "- /root/a (type: explore, status: running): x",
    )

    assert result["status"] == "error", result
    assert "no tool calls" in result["message"].lower()
    nudges = [m for m in result["context"] if "You MUST call tools" in str(m.get("text"))]
    assert len(nudges) == 2, nudges


async def test_completion_with_background_agents_reaches_verifier_with_their_status():
    """attempt_completion is never rejected for running background agents.

    It reaches the normal verifier, whose evidence ends with the factual
    status block; a rejection is ordinary verifier feedback (no wait), and an
    accept completes the run.
    """
    status_block = (
        "Background agents still running when completion was attempted:\n"
        "- bg_x (type: explore, status: running): Find the population of Tokyo."
    )
    verifier_args = []

    for score, expected_status in ((0.4, "max_iterations"), (1.0, "completed")):
        verifier_args.clear()

        async def verifier(*args, _score=score, **_kwargs):
            verifier_args.append(args)
            return {"score": _score, "reasoning": "judged", "usage": {}}

        result, posted, executed = await _run_single_iteration(
            [{"tool": "attempt_completion"}],
            [("attempt_completion", f"tc-ac-bg-{score}", 1.0)],
            skip_verification=False,
            max_iterations=1,
            verifier_override=verifier,
            get_pending_background_status_override=lambda: status_block,
        )

        assert result["status"] == expected_status, result
        assert [tool["tool_name"] for tool in executed] == ["attempt_completion"], executed
        # The completion verifier (first call) ends its evidence with the status.
        assert verifier_args and verifier_args[0][-1] == status_block, verifier_args
        assert not [m for m in posted if (m.get("metadata") or {}).get("toolStatus") == "ERROR"], posted

    # Nothing pending: the verifier receives its unchanged argument list.
    verifier_args.clear()

    async def verifier_no_bg(*args, **_kwargs):
        verifier_args.append(args)
        return {"score": 1.0, "reasoning": "judged", "usage": {}}

    await _run_single_iteration(
        [{"tool": "attempt_completion"}],
        [("attempt_completion", "tc-ac-no-bg", 1.0)],
        skip_verification=False,
        max_iterations=1,
        verifier_override=verifier_no_bg,
        get_pending_background_status_override=lambda: None,
    )
    assert verifier_args and len(verifier_args[0]) == 21, [len(a) for a in verifier_args]


async def test_tool_exception_continues_loop_without_posting_a_duplicate_chip():
    """Exception in execute_tool → loop continues; the TOOL owns the error chip.

    This test previously asserted run_agent posts the ERROR chip itself. That
    was the defect: every tool already posts a formatted terminal chip and then
    re-raises, so run_agent's row landed second at the same toolCallId and the
    frontend (last write wins) dropped the formatted one.
    docs/rca/cases/2026-08-19-explore-fe-posts-race-into-last-write-wins-chip-id.md
    """
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

    # The loop still survives the exception and runs to its iteration budget.
    assert result["status"] == "max_iterations"
    error_posts = [m for m in posted if m["role"] == "TOOL" and (m.get("metadata") or {}).get("toolStatus") == "ERROR"]
    assert not error_posts, f"run_agent must not post a tool's ERROR chip: {error_posts}"


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


async def test_generation_handoff_from_tool_result_returns_immediately():
    """An in-tool cutover must yield generation_handoff this turn, not wait for 1.6."""
    from helpers.generation_handoff import DEPLOY_INTERRUPTED_TOOL_MESSAGE

    tool_calls = [{"tool": "web_fetch", "url": "x"}]
    detected_tools = [("web_fetch", "tc-handoff-1", 1.0)]

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {
            "success": True,
            "message": DEPLOY_INTERRUPTED_TOOL_MESSAGE,
            "generation_handoff": True,
            "handoff_task_queue": "navi-agent-tasks@new",
        }

    result, _, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=True,
        execute_tool_override=mock_execute_tool,
        max_iterations=3,
    )

    assert result["status"] == "generation_handoff"
    assert result["handoff_task_queue"] == "navi-agent-tasks@new"
    assert any(
        row.get("role") == "TOOL" and DEPLOY_INTERRUPTED_TOOL_MESSAGE in str(row.get("text", ""))
        for row in result.get("context", [])
    )


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


def _with_native_schema_test_transport(test):
    from functools import wraps

    @wraps(test)
    async def run():
        from helpers.messages import flush_realtime_broadcasts_for_tests

        client = SimpleNamespace(post=AsyncMock(return_value=SimpleNamespace(status_code=200)))
        with (
            patch("helpers.messages._get_broadcast_client", return_value=client),
            patch(
                "providers.demo_cache.client.resolve_agent_fast_mode",
                new=AsyncMock(return_value=(False, None, False, None, None, True)),
            ),
        ):
            try:
                return await test()
            finally:
                await flush_realtime_broadcasts_for_tests()

    return run


async def _exercise_native_schema_preparation_retry(*, persistent=False, prompt_failure=False):
    import json

    previous = {"fields": [{"name": "venues", "type": "list[str]", "required": True}]}
    current = {"fields": [{"name": "venue_prices", "type": "list[int]", "required": True}]}
    observed = {"schema": previous, "calls": 0, "prompts": []}
    failure = RuntimeError("current schema temporarily unavailable")

    async def schema():
        if not prompt_failure:
            observed["calls"] += 1
            if persistent or observed["calls"] < 3:
                raise failure
        observed["schema"] = current
        return current

    async def prompt():
        if prompt_failure:
            observed["calls"] += 1
            if persistent or observed["calls"] < 3:
                raise failure
        observed["prompts"].append(observed["schema"])
        return json.dumps(observed["schema"])

    async def productive_tool(*_args):
        return {"status": "completed", "result": "Current work completed"}

    with patch("loop.run_agent.asyncio.sleep", new=AsyncMock()) as sleep:
        result, posted, _ = await _run_single_iteration(
            [{"tool": "web_search", "query": "Current venue prices"}],
            [("web_search", "productive-call", 1.0)],
            max_iterations=1,
            response_schema=previous,
            get_response_schema_override=schema,
            system_prompt_override=prompt,
            execute_tool_override=productive_tool,
        )
    assert observed["calls"] == 3, "schema preparation bypassed the existing three-attempt pre-acceptance boundary"
    assert [call.args[0] for call in sleep.await_args_list if call.args[0] >= 1] == [2, 4], (
        "schema preparation changed the existing retry backoff"
    )
    if persistent:
        assert result["status"] == "error" and str(failure) in result["message"]
        assert observed["prompts"] == []
        assert not any(message.get("role") == "ASSISTANT" for message in posted), (
            "failed preparation accepted a provider turn"
        )
    else:
        assert result["status"] == "completed", "preparation retries consumed the productive iteration"
        assert observed["prompts"] == [current], "provider prompt used the previous schema after preparation recovered"


@_with_native_schema_test_transport
async def test_schema_getter_failures_use_existing_native_preacceptance_retry():
    await _exercise_native_schema_preparation_retry()


@_with_native_schema_test_transport
async def test_schema_getter_persistent_failure_uses_existing_three_attempt_bound():
    await _exercise_native_schema_preparation_retry(persistent=True)


@_with_native_schema_test_transport
async def test_system_prompt_schema_failures_use_existing_native_retry():
    await _exercise_native_schema_preparation_retry(prompt_failure=True)
    await _exercise_native_schema_preparation_retry(prompt_failure=True, persistent=True)


@_with_native_schema_test_transport
async def test_schema_preparation_lifecycle_errors_propagate_without_retry():
    from temporalio.exceptions import ActivityError, ApplicationError, CancelledError, RetryState
    from helpers.generation_handoff import GenerationHandoffRequested
    from helpers.workflow_generation import WorkflowGenerationSealed

    failures = [
        CancelledError("schema read cancelled"),
        WorkflowGenerationSealed("generation replaced"),
        GenerationHandoffRequested("replacement-queue"),
    ]
    for kind in ("CancelledError", "WorkflowGenerationSealed", "GenerationHandoffRequested"):
        error = ActivityError(
            "schema read failed",
            scheduled_event_id=1,
            started_event_id=2,
            identity="test",
            activity_type="schema",
            activity_id="schema-read",
            retry_state=RetryState.NON_RETRYABLE_FAILURE,
        )
        error.__cause__ = ApplicationError("lifecycle boundary", type=kind)
        failures.append(error)
    for failure in failures:
        getter = AsyncMock(side_effect=failure)
        with patch("loop.run_agent.asyncio.sleep", new=AsyncMock()) as sleep:
            try:
                await _run_single_iteration(
                    [{"tool": "web_search", "query": "unused"}],
                    [("web_search", "unused", 1.0)],
                    get_response_schema_override=getter,
                )
            except BaseException as observed:
                assert observed is failure, "schema preparation replaced the native lifecycle error"
            else:
                raise AssertionError("schema preparation swallowed a native lifecycle error")
        getter.assert_awaited_once()
        sleep.assert_not_awaited()
    getter = AsyncMock(side_effect=asyncio.CancelledError())
    with patch("loop.run_agent.asyncio.sleep", new=AsyncMock()) as sleep:
        result, _, _ = await _run_single_iteration([], [], get_response_schema_override=getter)
    assert result["status"] == "paused", "asyncio cancellation lost the existing paused outcome"
    getter.assert_awaited_once()
    sleep.assert_not_awaited()


@_with_native_schema_test_transport
async def test_completed_child_optimization_uses_current_native_schema():
    previous = {"fields": [{"name": "venues", "type": "list[str]", "required": True}]}
    current = {"fields": [*previous["fields"], {"name": "venue_prices", "type": "list[int]", "required": True}]}
    context = [
        {"role": "USER", "text": "Read venues", "timestamp": "2026-10-15T00:00:00Z"},
        {
            "role": "TOOL",
            "text": "Browser finished",
            "timestamp": "2026-10-15T00:00:01Z",
            "metadata": {
                "toolCallId": "browser-result",
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "action_type": "task_complete",
                "success": True,
                "structured_response": {"venues": ["Old child field"]},
            },
        },
    ]
    executed = []

    async def tool(name, *_args):
        executed.append(name)
        return {"status": "completed", "result": "Current venue prices obtained"}

    result, _, _ = await _run_single_iteration(
        [{"tool": "web_search", "query": "Get missing venue prices"}],
        [("web_search", "current-field-work", 1.0)],
        initial_context=context,
        skip_verification=False,
        response_schema=previous,
        get_response_schema_override=AsyncMock(return_value=current),
        execute_tool_override=tool,
        verifier_structured_response={"venues": ["Old child field"]},
    )
    assert executed == ["web_search"], "completed-child optimization accepted coverage of the stale local schema"
    assert result["status"] == "completed"


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


async def test_verifier_uses_authored_attention_event_identity_across_row_retries():
    from loop.run_agent import _run_verifier, _verifier_superseded_by_user_feedback

    context = [
        {
            "id": "authored-row-1",
            "role": "USER",
            "text": "Use the shared calendar.",
            "metadata": {"source": "attention_response", "attentionRequestId": "request-a"},
        }
    ]
    duplicate = {**context[0], "id": "authored-row-retry"}
    provider_result = {
        "score": 1.0,
        "reasoning": "Shared calendar inspected",
        "structured_response": {"events": []},
        "usage": {"prompt_tokens": 5},
    }

    result = await _run_verifier(
        execute_activity=AsyncMock(return_value=provider_result),
        context=context,
        verifier_prompt_generator=AsyncMock(return_value="Verify the calendar"),
        model="model",
        agent_id="agent",
        task_id="task",
        post_message=None,
        poll_messages=AsyncMock(return_value=[duplicate]),
    )
    assert result.get("superseded_by_user_feedback") is not True, (
        "retry of the same authored event invalidated its verdict"
    )
    assert result["score"] == 1.0 and result["structured_response"] == {"events": []}
    context.append(
        {
            **duplicate,
            "id": "new-authored-row",
            "metadata": {"source": "attention_response", "attentionRequestId": "request-b"},
        }
    )
    assert _verifier_superseded_by_user_feedback(result, context), (
        "distinct authored event with identical text was dropped"
    )


async def test_verifier_rechecks_real_user_requirements_at_completion_boundaries():
    """Provider, post and cost awaits cannot accept an older requirement verdict."""
    for stage in ("provider", "post", "tokens"):
        for hidden in (False, True):
            published, verdicts = [], []

            def publish():
                if not published:
                    published.append(
                        {
                            "id": "correction",
                            "role": "USER",
                            "text": "Use my shared calendar access instead",
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "metadata": {"hidden": hidden},
                        }
                    )

            async def poll_messages(_since):
                return list(published)

            async def verifier(*args, **_kwargs):
                verdicts.append(list(args[0]))
                if stage == "provider":
                    publish()
                return {
                    "score": 1.0,
                    "reasoning": "Calendar inspected",
                    "structured_response": {"events": ["old account" if len(verdicts) == 1 else "shared calendar"]},
                    "usage": {"prompt_tokens": 5, "completion_tokens": 6, "total_tokens": 11},
                }

            async def post(_text, _role, metadata):
                if stage == "post" and (metadata or {}).get("verifierMessage"):
                    publish()

            async def tokens(_in, _out, _model, **metadata):
                if stage == "tokens" and metadata.get("call_site") == "verifier_execute":
                    publish()

            result, posted, _ = await _run_single_iteration(
                [{"tool": "attempt_completion"}],
                [("attempt_completion", "tc-late-user", 1.0)],
                skip_verification=False,
                max_iterations=3,
                poll_messages_override=poll_messages,
                verifier_override=verifier,
                post_message_override=post,
                on_tokens_override=tokens,
            )
            expected_calls = 1 if hidden else 2
            assert result["status"] == "completed", result
            assert len(verdicts) == expected_calls, f"root accepted a superseded USER verdict after {stage} await"
            assert result["structured_response"] == {"events": ["old account" if hidden else "shared calendar"]}
            assert isinstance(result.get("_verified_user_requirement_keys"), list), (
                "caller lost the verified requirement version"
            )
            assert result["token_count"] == 11 * expected_calls, "discarding a verdict lost its actual usage"
            finished = [message for message in posted if (message.get("metadata") or {}).get("verifierMessage")]
            assert all("Calendar inspected" in message["text"] for message in finished)
            assert not any("Verifier score: 0%" in message["text"] for message in finished), (
                "supersession fabricated a rejected verdict"
            )


async def test_final_verifier_does_not_publish_stale_completion_data():
    for stage in ("provider", "post", "tokens"):
        published = []

        def publish():
            if not published:
                published.append(
                    {
                        "id": "final-correction",
                        "role": "USER",
                        "text": "Use shared calendar access",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                )

        async def poll_messages(_since):
            return list(published)

        async def verifier(*_args, **_kwargs):
            if stage == "provider":
                publish()
            return {
                "score": 1.0,
                "reasoning": "Calendar inspected",
                "structured_response": {"events": ["old account"]},
                "usage": {"prompt_tokens": 5, "completion_tokens": 6, "total_tokens": 11},
            }

        async def post(_text, _role, metadata):
            if stage == "post" and (metadata or {}).get("verifierMessage"):
                publish()

        async def tokens(_in, _out, _model, **metadata):
            if stage == "tokens" and metadata.get("call_site") == "verifier_execute":
                publish()

        result, posted, _ = await _run_single_iteration(
            [{"tool": "web_search", "query": "calendar access"}],
            [("web_search", "tc-search", 1.0)],
            skip_verification=False,
            max_iterations=1,
            poll_messages_override=poll_messages,
            verifier_override=verifier,
            post_message_override=post,
            on_tokens_override=tokens,
        )
        assert result["status"] == "max_iterations"
        assert result["verifier_progress"] is None, (
            f"final verifier retained stale completion progress after {stage} await"
        )
        assert result.get("verifier_superseded_by_user_feedback") is True
        assert isinstance(result.get("_verified_user_requirement_keys"), list)
        assert result["partial_structured_response"] is None
        assert result["token_count"] == 11
        assert all(
            "Calendar inspected" in message["text"]
            for message in posted
            if (message.get("metadata") or {}).get("verifierMessage")
        )


async def test_superseded_verifier_keeps_actual_provider_result():
    from loop.run_agent import _run_verifier

    context = [{"id": "goal", "role": "USER", "text": "List calendar events"}]
    posted = []

    async def execute(_activity, **_kwargs):
        context.append({"id": "update", "role": "USER", "text": "Use shared calendar access"})
        return {
            "score": 1.0,
            "reasoning": "Actual provider verdict",
            "structured_response": {"events": ["old account"]},
            "usage": {"prompt_tokens": 5, "completion_tokens": 6, "total_tokens": 11},
        }

    async def post(text, role, metadata):
        posted.append({"text": text, "metadata": metadata})

    result = await _run_verifier(
        execute_activity=execute,
        context=context,
        verifier_prompt_generator=AsyncMock(return_value="Verify calendar"),
        model="test-model",
        agent_id="agent-1",
        task_id=None,
        post_message=post,
    )
    assert result.get("superseded_by_user_feedback") is True, "verifier did not mark new real USER requirements"
    assert result["score"] == 1.0 and result["reasoning"] == "Actual provider verdict"
    assert result["structured_response"] == {"events": ["old account"]} and result["usage"]["total_tokens"] == 11
    assert posted[-1]["metadata"].get("supersededByUserFeedback") is True
    assert "Actual provider verdict" in posted[-1]["text"] and "Verifier score: 0%" not in posted[-1]["text"]


async def test_parent_agent_task_update_supersedes_verdict_but_other_agent_rows_do_not():
    """A parent's TASK_UPDATE_FROM_PARENT_AGENT during check_progress outdates the verdict.

    The verifier treats an ancestor's agentMessage as a later requirement. One
    that lands while check_progress runs was not judged, so the verdict must be
    superseded. Sibling chatter, child notifications and task-addressed inbox rows
    are not requirements for this agent; they keep the verdict. The same rows are
    response-schema feedback (_requirement_keys); user-only keys exclude them.
    """
    from loop.run_agent import _real_user_requirement_keys, _requirement_keys, _run_verifier

    def agent_row(row_id, metadata):
        return {
            "id": row_id,
            "role": "USER",
            "text": "Use the Shinjuku hotel instead.",
            "timestamp": "2026-10-22T10:00:05Z",
            "metadata": metadata,
        }

    parent_update = agent_row(
        "parent-update",
        {"agentMessage": True, "fromAgentId": "agent-root", "fromAgentPath": "/root", "toAgentPath": "/root/hotels"},
    )
    cases = [
        ("parent_update", parent_update, True),
        (
            "sibling_message",
            agent_row(
                "sibling",
                {
                    "agentMessage": True,
                    "fromAgentId": "agent-flights",
                    "fromAgentPath": "/root/flights",
                    "toAgentPath": "/root/hotels",
                },
            ),
            False,
        ),
        (
            "child_notification",
            agent_row("notification", {"agentNotification": True, "toolName": "agent_notification"}),
            False,
        ),
        (
            "task_addressed_inbox_row",
            agent_row(
                "task-inbox",
                {
                    "agentMessage": True,
                    "fromAgentId": "agent-root",
                    "fromAgentPath": "/root",
                    "toAgentPath": "/root/hotels/search",
                    "recipientTaskId": "toolu_search",
                    "excludeFromModel": True,
                },
            ),
            False,
        ),
    ]
    for name, arriving, expect_superseded in cases:
        context = [{"id": "goal", "role": "USER", "text": "Book a Tokyo hotel", "timestamp": "2026-10-22T10:00:00Z"}]

        async def execute(_activity, _arriving=arriving, _context=context, **_kwargs):
            _context.append(_arriving)
            return {"score": 1.0, "reasoning": "Hotel booked", "usage": {"prompt_tokens": 5}}

        result = await _run_verifier(
            execute_activity=execute,
            context=context,
            verifier_prompt_generator=AsyncMock(return_value="Verify the booking"),
            model="test-model",
            agent_id="agent-hotels",
            task_id=None,
            post_message=None,
        )
        assert (result.get("superseded_by_user_feedback") is True) is expect_superseded, (name, result)
        assert result["score"] == 1.0 and result["reasoning"] == "Hotel booked", (name, result)

    # A parent update already in context when the verifier ran was judged.
    judged = await _run_verifier(
        execute_activity=AsyncMock(return_value={"score": 1.0, "reasoning": "ok", "usage": {}}),
        context=[parent_update],
        verifier_prompt_generator=AsyncMock(return_value="Verify"),
        model="test-model",
        agent_id="agent-hotels",
        task_id=None,
        post_message=None,
        poll_messages=AsyncMock(return_value=[dict(parent_update)]),
    )
    assert judged.get("superseded_by_user_feedback") is not True, judged
    assert _real_user_requirement_keys([parent_update]) == set(), "user-only keys exclude agent rows"
    assert _requirement_keys([parent_update]) == {("id", "parent-update")}, "a parent's task update is a requirement"
    for name, arriving, expect_requirement in cases:
        assert bool(_requirement_keys([arriving])) is expect_requirement, name


class _FakeInterrupts:
    """The workflow's DAG interrupt hook: wake counter + user/agent-message filter."""

    def __init__(self):
        self._seq = 0
        self._changed = asyncio.Event()
        self.pending = False

    def seq(self):
        return self._seq

    async def wait(self, seq):
        while self._seq == seq:
            self._changed.clear()
            await self._changed.wait()

    def message_pending(self):
        return self.pending

    def wake(self, *, message: bool):
        self.pending = self.pending or message
        self._seq += 1
        self._changed.set()


async def test_verifier_is_interrupted_by_a_new_user_or_agent_message():
    """A user/agent message cancels the running check; other wakes (child completions) do not."""
    from loop.run_agent import VERIFIER_INTERRUPTED_MESSAGE, _run_verifier

    def verifier_kwargs(execute, posts, interrupts):
        async def post(text, role, metadata):
            posts.append((text, role, metadata))

        return dict(
            execute_activity=execute,
            context=[{"id": "goal", "role": "USER", "text": "Book a Tokyo hotel", "timestamp": "2026-10-22T10:00:00Z"}],
            verifier_prompt_generator=AsyncMock(return_value="Verify the booking"),
            model="test-model",
            agent_id="agent-hotels",
            task_id=None,
            post_message=post,
            tool_call_id="toolu_done",
            interrupts=interrupts,
        )

    # A message mid-check: the activity is cancelled and the attempt closes as superseded.
    interrupts, posts, started, cancelled = _FakeInterrupts(), [], asyncio.Event(), []

    async def slow_check(_activity, **_kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    running = asyncio.create_task(_run_verifier(**verifier_kwargs(slow_check, posts, interrupts)))
    await asyncio.wait_for(started.wait(), 1)
    interrupts.wake(message=False)  # a child completed: not new input, keep verifying
    await asyncio.sleep(0.01)
    assert not running.done() and not cancelled
    interrupts.wake(message=True)
    result = await asyncio.wait_for(running, 1)
    assert cancelled == [True], "the verifier activity is cancelled"
    assert result["superseded_by_user_feedback"] is True and result["interrupted_by_message"] is True, result
    assert result["score"] == 0.0 and result["usage"] == {}, result
    finished = [m for _t, _r, m in posts if m["toolStatus"] == "FINISHED"]
    assert len(finished) == 1 and finished[0]["toolCallId"] == "toolu_done", posts
    assert finished[0]["interrupted"] is True and finished[0]["supersededByUserFeedback"] is True
    assert posts[-1][0] == VERIFIER_INTERRUPTED_MESSAGE

    # A message already pending: the check never starts.
    interrupts, posts = _FakeInterrupts(), []
    interrupts.pending = True
    never = AsyncMock(side_effect=AssertionError("verifier must not start"))
    result = await _run_verifier(**verifier_kwargs(never, posts, interrupts))
    assert result["interrupted_by_message"] is True and never.await_count == 0

    # No new input: the verdict is returned unchanged.
    interrupts, posts = _FakeInterrupts(), []
    done = AsyncMock(return_value={"score": 1.0, "reasoning": "Hotel booked", "usage": {}})
    result = await _run_verifier(**verifier_kwargs(done, posts, interrupts))
    assert result["score"] == 1.0 and not result.get("interrupted_by_message"), result


async def test_keyed_feedback_revision_supersedes_verdict_without_user_row():
    """Attention responses can change requirements without creating USER rows."""
    for final in (False, True):
        for stage in ("provider", "post", "tokens"):
            revision, calls = 0, []
            old_schema = {"fields": [{"name": "venue_name", "type": "str", "required": True}]}
            new_schema = {"fields": [{"name": "venue_prices", "type": "list[str]", "required": True}]}

            async def schema():
                return new_schema if revision else old_schema

            def revise():
                nonlocal revision
                revision = 1

            async def verifier(*args, **_kwargs):
                calls.append(args[3])
                if stage == "provider":
                    revise()
                return {
                    "score": 1.0,
                    "reasoning": "Verified actual schema",
                    "structured_response": {"venue_name": "Original venue"}
                    if len(calls) == 1
                    else {"venue_prices": ["$40"]},
                    "usage": {"prompt_tokens": 5, "completion_tokens": 6, "total_tokens": 11},
                }

            async def post(_text, _role, metadata):
                if stage == "post" and (metadata or {}).get("verifierMessage"):
                    revise()

            async def tokens(_in, _out, _model, **metadata):
                if stage == "tokens" and metadata.get("call_site") == "verifier_execute":
                    revise()

            result, posted, _ = await _run_single_iteration(
                [{"tool": "web_search", "query": "venue prices"}] if final else [{"tool": "attempt_completion"}],
                [("web_search", "tc-search", 1.0)] if final else [("attempt_completion", "tc-keyed", 1.0)],
                skip_verification=False,
                max_iterations=1 if final else 3,
                get_requirement_revision=lambda: revision,
                get_response_schema_override=schema,
                verifier_override=verifier,
                post_message_override=post,
                on_tokens_override=tokens,
            )
            assert len([row for row in result["context"] if row.get("role") == "USER"]) == 1, (
                "keyed response fabricated a USER row"
            )
            if final:
                assert result["verifier_progress"] is None, (
                    f"final keyed correction accepted stale verdict after {stage}"
                )
                assert result.get("verifier_superseded_by_user_feedback") is True
                assert result["partial_structured_response"] is None
            else:
                assert len(calls) == 2, f"keyed correction without durable USER row accepted old schema after {stage}"
                assert calls == [old_schema, new_schema]
                assert result["structured_response"] == {"venue_prices": ["$40"]}
                assert result.get("_verified_requirement_revision") == 1
            assert result["token_count"] == 11 * len(calls)
            assert not any("Verifier score: 0%" in row["text"] for row in posted), (
                "keyed supersession fabricated rejection"
            )


async def test_verifier_reloads_prompt_and_schema_until_requirement_revision_matches():
    from loop.run_agent import _run_verifier

    revision, prompts, inputs = 0, [], []

    async def prompt():
        nonlocal revision
        observed = revision
        prompts.append(observed)
        revision = 1
        return f"Verify requirement {observed}"

    async def schema():
        return {"fields": [{"name": f"requirement_{revision}", "type": "str", "required": True}]}

    async def execute(_activity, **kwargs):
        inputs.append(kwargs["args"][:4])
        return {"score": 1.0, "reasoning": "Actual verdict", "usage": {}}

    result = await _run_verifier(
        execute_activity=execute,
        context=[{"role": "USER", "text": "Find a venue"}],
        verifier_prompt_generator=prompt,
        get_response_schema=schema,
        model="test-model",
        agent_id="agent-1",
        task_id=None,
        post_message=None,
        **(
            {"get_requirement_revision": lambda: revision}
            if "get_requirement_revision" in inspect.signature(_run_verifier).parameters
            else {}
        ),
    )
    assert inputs[0][1] == "Verify requirement 1", "verifier mixed the previous prompt with a newer native schema"
    assert inputs[0][3]["fields"][0]["name"] == "requirement_1"
    assert prompts == [0, 1] and result.get("_verified_requirement_revision") == 1


async def test_verifier_infra_soft_fail_does_not_accept_attempt_completion():
    """A schema-shaped response cannot turn a verifier outage into success."""
    tool_calls = [{"tool": "attempt_completion"}]
    detected_tools = [("attempt_completion", "tc-ac-infra-1", 1.0)]
    schema = {
        "fields": [
            {
                "name": "repos",
                "type": "list[object]",
                "properties": [
                    {"name": "rank", "type": "int"},
                    {"name": "repo_name", "type": "str"},
                    {"name": "repo_url", "type": "str"},
                    {"name": "stars", "type": "int"},
                    {"name": "description", "type": "str"},
                ],
            }
        ]
    }
    structured = {
        "repos": [
            {
                "rank": 1,
                "repo_name": "a/b",
                "repo_url": "https://github.com/a/b",
                "stars": 10,
                "description": "cuda kernels",
            }
        ]
    }

    completion_calls = []

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        completion_calls.append((tool_name, tool_args, tool_call_id))
        return {"message": "ok"}

    result, _, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=False,
        max_iterations=1,
        execute_tool_override=mock_execute_tool,
        verifier_score=0.5,
        verifier_reasoning=("Progress check failed: Verifier exceeded 420s total deadline"),
        verifier_structured_response=structured,
        response_schema=schema,
    )

    assert result["status"] == "max_iterations"
    assert result.get("score") != 1.0
    assert result.get("verifier_progress") == 0.5
    assert completion_calls == [("attempt_completion", {"_verification_pending": True}, "tc-ac-infra-1")]


async def test_verifier_infra_soft_fail_rejects_malformed_structured_response():
    """Infra soft-fail must not COMPLETE when repos is truncated markdown.

    Repro: cuda-kernel-github-top100-code-agent k=3 r30 a1 — verifier hit the
    420s fence, soft-accept flipped score to 1.0, and structured_output.repos
    was a markdown string. Harness declared evaluator scored progress=0.
    """
    tool_calls = [{"tool": "attempt_completion"}]
    detected_tools = [("attempt_completion", "tc-ac-infra-bad-1", 1.0)]
    schema = {"fields": [{"name": "repos", "type": "list[object]"}]}

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {"message": "ok"}

    result, _, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=False,
        max_iterations=1,
        execute_tool_override=mock_execute_tool,
        verifier_score=0.5,
        verifier_reasoning=("Progress check failed: Verifier exceeded 420s total deadline"),
        verifier_structured_response={"repos": "- [cupy/cupy](https://github.com/cupy/cupy): NumPy for GPU\n..."},
        response_schema=schema,
    )

    assert result["status"] == "max_iterations"
    assert result.get("score") != 1.0
    assert result.get("verifier_progress") == 0.5


async def test_verifier_infra_soft_fail_trips_circuit_breaker_without_schema():
    """Execute-loop infra soft-fails without schema-ready output must error at 3.

    CodeRabbit #1260: an `elif not is_plan_loop` branch used to consume every
    execute path and skip the consecutive>=3 circuit breaker, letting agents
    spin until the task budget died.
    """
    tool_calls = [{"tool": "attempt_completion"}]
    detected_tools = [("attempt_completion", "tc-ac-infra-cb-1", 1.0)]
    schema = {"fields": [{"name": "repos", "type": "list[object]"}]}

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {"message": "ok"}

    result, _, _ = await _run_single_iteration(
        tool_calls,
        detected_tools,
        skip_verification=False,
        max_iterations=5,
        execute_tool_override=mock_execute_tool,
        verifier_score=0.5,
        verifier_reasoning=("Progress check failed: Verifier exceeded 420s total deadline"),
        verifier_structured_response={"repos": ""},
        response_schema=schema,
    )

    assert result["status"] == "error"
    assert "verifier unavailable after 3 consecutive failures" in (result.get("message") or "").lower()


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

    result_ctx, success = await _compress_context(mock_execute_activity, context, "rose-flash")

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
        "rose-flash",
        on_tokens=on_tokens,
    )

    assert success is True
    assert result_ctx == new_context
    assert captured_args[0][1] == [
        context,
        len(context),
        "rose-flash",
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
        "rose-flash",
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
        "rose-flash",
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
                        "source": "pool",
                        "poolTokenId": "pool-1",
                        "lineageKey": "agent:agent-test",
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

    lease_fetches = []

    async def mock_fetch_compute_token(user_id, **kwargs):
        lease_fetches.append((user_id, kwargs))
        return {
            "type": "claude",
            "accessToken": "rotated-claude-token",
            "source": "pool",
            "poolTokenId": "pool-1",
            "lineageKey": "agent:agent-test",
        }

    with (
        patch(
            "loop.run_agent.call_llm_structured_streaming",
            new=AsyncMock(side_effect=mock_call_llm_structured_streaming),
        ),
        patch("loop.run_agent.fetch_compute_token_activity", new=mock_fetch_compute_token),
    ):
        await run_agent(
            agent_id="agent-test",
            user_id="user-test",
            system_prompt=system_prompt,
            verifier_prompt_generator=verifier_prompt,
            model="rose-labs/rose-1-flash",
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
    assert lease_fetches == [
        (
            "user-test",
            {
                "lineage_key": "agent:agent-test",
                "agent_id": "agent-test",
                "demo_cache_affinity_key": None,
                "token_type": "claude",
            },
        )
    ]


async def test_run_agent_drops_rotated_out_credential_when_lease_reread_fails():
    """If the rotated lease cannot be re-read, never reuse the credential RoseClient rotated away from."""
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
                        "source": "pool",
                        "poolTokenId": "pool-1",
                        "lineageKey": "agent:agent-test",
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

    lease_fetches = []

    async def mock_fetch_compute_token(user_id, **kwargs):
        lease_fetches.append((user_id, kwargs))
        return None

    with (
        patch(
            "loop.run_agent.call_llm_structured_streaming",
            new=AsyncMock(side_effect=mock_call_llm_structured_streaming),
        ),
        patch("loop.run_agent.fetch_compute_token_activity", new=mock_fetch_compute_token),
    ):
        await run_agent(
            agent_id="agent-test",
            user_id="user-test",
            system_prompt=system_prompt,
            verifier_prompt_generator=verifier_prompt,
            model="rose-labs/rose-1-flash",
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
    assert llm_kwargs[1]["claude_token"] is None
    assert llm_kwargs[1]["gpt_token"] is None
    assert len(lease_fetches) == 1


async def test_run_agent_records_served_lease_identity_without_rotation():
    """An unrotated call keeps its credential and records the served lease identity."""
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
                    "actual_model": "gpt-6-sol-gpt",
                    "compute_token_used": {
                        "type": "gpt",
                        "source": "pool",
                        "poolTokenId": "pool-gpt-1",
                        "lineageKey": "agent:agent-test",
                    },
                    "compute_token_rotated": False,
                },
                [("web_search", "tc-web-search-1", 1.0)],
            )
        return (
            _DummyLLMResult("", []),
            {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            [],
        )

    lease_fetches = []

    async def mock_fetch_compute_token(user_id, **kwargs):
        lease_fetches.append((user_id, kwargs))
        return {
            "type": "claude",
            "accessToken": "rotated-claude-token",
            "source": "pool",
            "poolTokenId": "pool-1",
            "lineageKey": "agent:agent-test",
        }

    with (
        patch(
            "loop.run_agent.call_llm_structured_streaming",
            new=AsyncMock(side_effect=mock_call_llm_structured_streaming),
        ),
        patch("loop.run_agent.fetch_compute_token_activity", new=mock_fetch_compute_token),
    ):
        await run_agent(
            agent_id="agent-test",
            user_id="user-test",
            system_prompt=system_prompt,
            verifier_prompt_generator=verifier_prompt,
            model="rose-labs/rose-1-flash",
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
        )

    assert len(llm_kwargs) == 2
    assert llm_kwargs[1]["gpt_token"] == "stale-gpt-token"
    assert llm_kwargs[1]["gpt_token_source"] == "pool"
    assert llm_kwargs[1]["gpt_token_pool_id"] == "pool-gpt-1"
    assert lease_fetches == []


async def test_demo_cache_position_retries_same_step_after_llm_failure():
    """A failed LLM attempt must not consume the next demo-cache position."""
    from loop.run_agent import run_agent
    import providers.demo_cache.context as demo_cache_context

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
        patch.object(demo_cache_context, "set_context", side_effect=mock_set_context),
        patch.object(demo_cache_context, "write_through_enabled_for_user", return_value=False),
    ):
        result = await run_agent(
            agent_id="agent-test",
            user_id="user-test",
            system_prompt=system_prompt,
            verifier_prompt_generator=verifier_prompt,
            model="rose-labs/rose-1-flash",
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
    # The invariant under test: the retry reuses the SAME demo-cache step.
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
            model="rose-labs/rose-1-flash",
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


async def test_run_agent_refusal_reroute_crosses_the_temporal_activity_boundary():
    """A refusal reroute must survive the workflow -> activity hop.

    REGRESSION (2026-08-22): the reroute only ever worked in-process. Workflow context
    dispatches through `call_llm_activity`, whose signature had no exclusion parameter, so
    the flag was silently dropped at the boundary and every retry went back to the model
    that had just refused. One transient refusal therefore became a guaranteed
    3-consecutive-failure kill. The sibling test above passes `is_inside_temporal_activity=True`
    and so covered only the path that already worked; this one covers the production path.

    Asserted on the ACTIVITY ARGS rather than on a provider mock, because the defect was the
    argument never being sent -- an assertion further downstream would have stayed green.
    """
    from loop.run_agent import run_agent
    from providers.rose.errors import RoseRefusalError

    activity_calls: list[list] = []

    async def system_prompt():
        return "System prompt"

    async def verifier_prompt():
        return "Verifier prompt"

    async def mock_execute_activity(activity, **kwargs):
        args = kwargs.get("args") or []
        name = getattr(activity, "__name__", str(activity))
        if "call_llm" not in name:
            return {}
        activity_calls.append(args)
        if len(activity_calls) == 1:
            raise RoseRefusalError("Anthropic stream ended with refusal (request_id=r-boundary)")
        return {"response": "", "tool_calls": [], "usage": {}, "detected_tools_ordered": []}

    with (
        patch("loop.run_agent.workflow.execute_activity", new=AsyncMock(side_effect=mock_execute_activity)),
        patch("loop.run_agent.asyncio.sleep", new=AsyncMock()),
    ):
        await run_agent(
            agent_id="agent-boundary",
            user_id="user-boundary",
            system_prompt=system_prompt,
            verifier_prompt_generator=verifier_prompt,
            model="rose-labs/rose-1-lite",
            tools=["attempt_completion"],
            initial_context=[{"role": "USER", "text": "Go", "timestamp": "2024-01-01T00:00:00Z"}],
            is_inside_temporal_activity=False,
            post_message=AsyncMock(),
            execute_tool=AsyncMock(),
            build_messages=lambda context, prompt: [{"role": "system", "content": prompt}],
            max_iterations=2,
            skip_verification=True,
            skip_status_updates=True,
        )

    assert len(activity_calls) >= 2, "expected the refused call to be retried through the activity"
    # Activity args are positional (new ones are appended so an older replayed Temporal history
    # still resolves to the default), so read the flag at its signature position. Check the slot
    # actually holds the flag before reading it, so the original defect (the argument never being
    # sent at all) reports as itself rather than as a confusing value mismatch.
    import inspect

    from helpers.llm import call_llm_activity

    exclude_index = list(inspect.signature(call_llm_activity).parameters).index("exclude_anthropic_family")
    assert len(activity_calls[0]) > exclude_index and isinstance(activity_calls[0][exclude_index], bool), (
        "call_llm_activity is not receiving the anthropic-exclusion flag at all; positional args were "
        f"{activity_calls[0][exclude_index:]!r}. The reroute dies at the workflow->activity boundary."
    )
    assert activity_calls[0][exclude_index] is False, "first attempt must not pre-emptively exclude Anthropic"
    assert activity_calls[1][exclude_index] is True, "the retry after a refusal must reroute off Anthropic"


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
    result_ctx, success = await _compress_context(mock_execute_activity, original, "rose-flash")
    assert success is False
    assert result_ctx is original


async def test_compress_context_activity_exception_preserves_original():
    """When the activity itself raises, _compress_context returns (original, False)."""
    from loop.run_agent import _compress_context

    async def mock_execute_activity(*args, **kwargs):
        raise RuntimeError("temporal exploded")

    original = [{"role": "USER", "text": "x"}]
    result_ctx, success = await _compress_context(mock_execute_activity, original, "rose-flash")
    assert success is False
    assert result_ctx is original


async def test_activity_tool_results_are_hard_capped_before_context_append():
    """Explore/activity agents must not append unbounded tool dumps into context.

    Prod a890a362 explore children failed with:
      Context compression ineffective: compressed context estimate 210745
      tokens still exceeds trigger 167000 (original estimate 228460)
    after a single grep result ballooned tokens_in to ~140k. web_fetch already
    routes through summarize_tool_result; grep did not. Cap at the shared
    append boundary so every activity-mode tool shares the same floor.
    """
    from helpers.summarize import TOOL_RESULT_HARD_CAP_CHARS

    huge = "AMAZON_ORDER_CONFIRMATION " * 20_000 + "EXACT_TAIL_SENTINEL"  # well above the hard cap
    assert len(huge) > TOOL_RESULT_HARD_CAP_CHARS

    tool_calls = [{"tool": "grep", "pattern": "amazon"}]
    detected_tools = [("grep", "tc-huge-grep", 1.0)]

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {"success": True, "message": huge}

    with retained_tool_output_fixture():
        result, _, _ = await _run_single_iteration(
            tool_calls,
            detected_tools,
            skip_verification=True,
            execute_tool_override=mock_execute_tool,
            max_iterations=1,
            is_inside_temporal_activity=True,
            poll_messages_override=None,
        )
        import re
        from tools.read_tool_output import read_tool_output_activity
        text = [m for m in result["context"] if m["role"] == "TOOL"][-1]["text"]
        output_id = re.search(r'output_id="([a-f0-9]{32})"', text)[1]
        page = await read_tool_output_activity("user-test", "agent-test", "", {"output_id": output_id, "query": "EXACT_TAIL_SENTINEL"})
        assert page["content"] == "EXACT_TAIL_SENTINEL"
        assert [m for m in result["context"] if m["role"] == "TOOL"][-1]["metadata"]["toolStatus"] == "FINISHED"

        async def failed_tool(*args):
            return {"success": False, "error": True, "message": huge}

        failed, _, _ = await _run_single_iteration(
            tool_calls, detected_tools, execute_tool_override=failed_tool,
            max_iterations=1, is_inside_temporal_activity=True, poll_messages_override=None,
        )
        error_row = [m for m in failed["context"] if m["role"] == "TOOL"][-1]
        assert error_row["metadata"]["toolStatus"] == "ERROR"
        assert error_row["metadata"]["error"] is True
        error_id = re.search(r'output_id="([a-f0-9]{32})"', error_row["text"])[1]
        assert (await read_tool_output_activity("user-test", "agent-test", "", {"output_id": error_id, "query": "EXACT_TAIL_SENTINEL"}))["content"] == "EXACT_TAIL_SENTINEL"

    tool_msgs = [m for m in result.get("context") or [] if m.get("role") == "TOOL"]
    assert tool_msgs, "expected the grep tool result in context"
    text = tool_msgs[-1].get("text") or ""
    assert len(text) <= TOOL_RESULT_HARD_CAP_CHARS + 80, (
        f"uncapped tool result entered context ({len(text)} chars); hard cap is {TOOL_RESULT_HARD_CAP_CHARS}"
    )
    assert "Retained tool output:" in text


async def test_workflow_output_retention_uses_activity():
    """Large workflow receipts perform storage I/O inside a registered activity."""
    import re
    import loop.run_agent as loop
    from tools.read_tool_output import preview_tool_output_activity, read_tool_output_activity

    calls = []
    async def execute_activity(fn, *, args, **kwargs):
        calls.append(fn.__name__)
        if fn is loop.call_llm_activity:
            return {"response": "", "tool_calls": [{"tool": "web_search", "query": "x"}],
                    "detected_tools_ordered": [("web_search", "tc", 1.0)], "usage": {}}
        assert fn is preview_tool_output_activity, fn
        return await fn(*args)

    async def failed_tool(*args):
        raise RuntimeError("failure " * 10000 + "WORKFLOW_TAIL")

    with retained_tool_output_fixture(), patch.object(loop.workflow, "execute_activity", execute_activity), patch.object(loop, "preview_tool_text", side_effect=AssertionError("I/O entered workflow")):
        result, _, _ = await _run_single_iteration(
            [{"tool": "web_search", "query": "x"}], [("web_search", "tc", 1.0)],
            execute_tool_override=failed_tool, is_inside_temporal_activity=False,
        )
        text = [m["text"] for m in result["context"] if m["role"] == "TOOL"][-1]
        output_id = re.search(r'output_id="([a-f0-9]{32})"', text)[1]
        page = await read_tool_output_activity("user-test", "agent-test", "", {"output_id": output_id, "query": "WORKFLOW_TAIL"})
        assert page["content"] == "WORKFLOW_TAIL"
        assert "preview_tool_output_activity" in calls

        calls.clear()
        async def short_failed_tool(*args):
            raise RuntimeError("short result")
        await _run_single_iteration(
            [{"tool": "web_search", "query": "x"}], [("web_search", "tc-short", 1.0)],
            execute_tool_override=short_failed_tool, is_inside_temporal_activity=False,
        )
        assert "preview_tool_output_activity" in calls


async def test_activity_preview_retention_failure_keeps_stated_cut():
    """A retained-output storage failure must leave a bounded tool result in
    context instead of failing the loop iteration."""
    from helpers.summarize import TOOL_RESULT_HARD_CAP_CHARS

    huge = "STORAGE_DOWN_RESULT " * 20_000 + "EXACT_TAIL_SENTINEL"

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {"success": True, "message": huge}

    async def disk_full(*args, **kwargs):
        raise OSError("fixture disk full")

    with retained_tool_output_fixture(), patch("helpers.attachments.upload_to_storage", side_effect=disk_full):
        result, _, _ = await _run_single_iteration(
            [{"tool": "grep", "pattern": "x"}], [("grep", "tc-storage-down", 1.0)],
            skip_verification=True, execute_tool_override=mock_execute_tool, max_iterations=1,
            is_inside_temporal_activity=True, poll_messages_override=None,
        )
    assert result.get("status") != "error", result.get("status")
    text = [m for m in result["context"] if m["role"] == "TOOL"][-1]["text"]
    assert len(text) <= TOOL_RESULT_HARD_CAP_CHARS + 80
    assert "storage failure" in text and "EXACT_TAIL_SENTINEL" not in text


async def test_workflow_marker_verification_uses_activity():
    """A short receipt carrying a retained marker is verified against storage;
    that download must run in an activity, never in workflow code."""
    import loop.run_agent as loop
    from tools.read_tool_output import preview_tool_output_activity

    marker = ('\n[Retained tool output: read_tool_output output_id="' + "a" * 32 + '" offset=600 '
              "limit=20000; total_chars=900; Unicode characters; originating agent/session only; expires after 24h.]")
    calls = []
    async def execute_activity(fn, *, args, **kwargs):
        calls.append(fn.__name__)
        if fn is loop.call_llm_activity:
            return {"response": "", "tool_calls": [{"tool": "web_search", "query": "x"}],
                    "detected_tools_ordered": [("web_search", "tc", 1.0)], "usage": {}}
        assert fn is preview_tool_output_activity, fn
        return await fn(*args)

    async def failed_tool(*args):
        raise RuntimeError("short failure " + "p" * 600 + marker)

    with retained_tool_output_fixture(), patch.object(loop.workflow, "execute_activity", execute_activity), patch.object(loop, "preview_tool_text", side_effect=AssertionError("I/O entered workflow")):
        await _run_single_iteration(
            [{"tool": "web_search", "query": "x"}], [("web_search", "tc", 1.0)],
            execute_tool_override=failed_tool, is_inside_temporal_activity=False,
        )
    assert "preview_tool_output_activity" in calls, calls


async def test_workflow_preview_timeout_keeps_stated_cut():
    import loop.run_agent as loop
    from helpers.summarize import TOOL_RESULT_HARD_CAP_CHARS
    from temporalio.exceptions import ActivityError, RetryState, TimeoutError as TemporalTimeoutError, TimeoutType
    from tools.read_tool_output import preview_tool_output_activity

    async def execute_activity(fn, *, args, **kwargs):
        if fn is loop.call_llm_activity:
            return {"response": "", "tool_calls": [{"tool": "grep", "pattern": "x"}],
                    "detected_tools_ordered": [("grep", "tc-timeout", 1.0)], "usage": {}}
        assert fn is preview_tool_output_activity
        error = ActivityError("preview timed out", scheduled_event_id=1, started_event_id=2,
                              identity="test", activity_type="preview", activity_id="preview",
                              retry_state=RetryState.TIMEOUT)
        error.__cause__ = TemporalTimeoutError("start-to-close", type=TimeoutType.START_TO_CLOSE,
                                               last_heartbeat_details=[])
        raise error

    async def long_tool(*args):
        return {"success": True, "message": "TIMED_OUT_OUTPUT " * 10_000 + "EXACT_TAIL_SENTINEL"}

    with retained_tool_output_fixture(), patch.object(loop.workflow, "execute_activity", execute_activity):
        result, _, _ = await _run_single_iteration(
            [{"tool": "grep", "pattern": "x"}], [("grep", "tc-timeout", 1.0)],
            execute_tool_override=long_tool, is_inside_temporal_activity=False,
            skip_verification=True, max_iterations=1,
        )
    text = [m["text"] for m in result["context"] if m["role"] == "TOOL"][-1]
    assert len(text) <= TOOL_RESULT_HARD_CAP_CHARS + 80
    assert "preview timeout" in text and "EXACT_TAIL_SENTINEL" not in text


async def test_activity_tool_result_cap_prevents_protected_tail_overflow():
    """A batch of grep results must not trip the explore compaction check.

    Prod a890a362 appended four grep results, then head/tail compaction
    retained 182858 tokens against the 167k trigger. Model that protected
    head and four-result tail at the loop boundary. The check still rejects
    genuine overflows in the test below.
    """
    import loop.run_agent as run_mod

    huge = "AMAZON_ORDER_CONFIRMATION " * 4_000
    initial = [{"role": "USER", "text": "U" * 100_000, "timestamp": "2024-01-01T00:00:00Z"}]
    initial.extend({"role": "ASSISTANT", "text": "M" * 400, "timestamp": "2024-01-01T00:00:00Z"} for _ in range(4))
    tool_calls = [{"tool": "grep", "pattern": f"amazon-{i}"} for i in range(4)]
    detected_tools = [("grep", f"tc-huge-grep-{i}", 1.0) for i in range(4)]

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        return {"success": True, "message": huge}

    async def protected_head_tail(**kwargs):
        context = kwargs["context"]
        return [context[0], *context[-4:]], True

    with retained_tool_output_fixture(), patch.object(run_mod, "_compress_context", side_effect=protected_head_tail) as compressor:
        result, _, _ = await _run_single_iteration(
            tool_calls,
            detected_tools,
            initial_context=initial,
            skip_verification=True,
            execute_tool_override=mock_execute_tool,
            max_iterations=2,
            is_inside_temporal_activity=True,
            poll_messages_override=None,
        )

    assert result["status"] == "max_iterations", result.get("message")
    compressor.assert_not_called()


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
            model="rose-labs/rose-1-flash",
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
            model="rose-labs/rose-1-flash",
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
        model="rose-flash",
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


async def _capture_verifier_prerequisite_failure(stage, failure, *, supplied_id=True, closure_failure=None):
    from loop.run_agent import _run_verifier

    posted = []
    provider = AsyncMock(side_effect=AssertionError("prerequisite failure reached the verifier provider"))

    async def post(text, role, metadata=None):
        posted.append({"text": text, "role": role, "metadata": dict(metadata or {})})
        if metadata.get("toolStatus") == "ERROR" and closure_failure is not None:
            raise closure_failure

    prompt = AsyncMock(side_effect=failure) if stage == "prompt" else AsyncMock(return_value="Verify current task")
    schema = AsyncMock(side_effect=failure) if stage == "schema" else AsyncMock(return_value={"fields": []})
    observed = None
    with patch("loop.run_agent._safe_uuid4", return_value="generated-verifier-call"):
        try:
            await _run_verifier(
                execute_activity=provider,
                context=[],
                verifier_prompt_generator=prompt,
                model="test-model",
                agent_id="agent",
                task_id=None,
                post_message=post,
                get_response_schema=schema,
                tool_call_id="supplied-verifier-call" if supplied_id else None,
            )
        except BaseException as error:
            observed = error
    provider.assert_not_awaited()
    return posted, observed


async def _assert_verifier_prerequisite_error_closure(stage, *, supplied_id):
    from helpers.llm import build_llm_messages

    failure = RuntimeError(f"native {stage} prerequisite failed: exact detail")
    posted, observed = await _capture_verifier_prerequisite_failure(stage, failure, supplied_id=supplied_id)
    assert observed is failure, "verifier replaced the original prerequisite error"
    assert len(posted) == 2, "verifier prerequisite failure left its IN_PROGRESS row open"
    progress, closure = posted
    call_id = "supplied-verifier-call" if supplied_id else "generated-verifier-call"
    assert progress["metadata"]["toolStatus"] == "IN_PROGRESS"
    assert progress["metadata"]["toolCallId"] == closure["metadata"]["toolCallId"] == call_id
    assert closure["role"] == "TOOL" and closure["text"] == str(failure)
    metadata = closure["metadata"]
    assert metadata["toolName"] == "attempt_completion" and metadata["toolStatus"] == "ERROR"
    assert metadata["subAgentId"] is None
    assert metadata["error"] is True and metadata["excludeFromModel"] is True
    assert not {"verifierMessage", "score", "reasoning", "structured_response"}.intersection(metadata)
    assert "Take a NEW action" not in closure["text"] and "Verifier score" not in closure["text"]
    context = [{"role": "USER", "text": "Current task", "timestamp": "2026-10-15T00:00:00Z"}]
    if supplied_id:
        context.append(
            {
                "role": "ASSISTANT",
                "text": "",
                "timestamp": "2026-10-15T00:00:01Z",
                "metadata": {"tool_calls": [{"tool": "attempt_completion", "tool_call_id": call_id}]},
            }
        )
    expected = await build_llm_messages(context, "System")
    actual = await build_llm_messages(context + posted, "System")
    assert actual == expected, "UI error closure entered model context"
    assert not any(message.get("tool_call_id") == call_id for message in actual), (
        "UI closure invented a model tool result"
    )
    assert not any(call.get("id") == call_id for message in actual for call in message.get("tool_calls", [])), (
        "UI closure left an unpaired model tool use"
    )


async def test_verifier_prompt_prerequisite_error_closes_supplied_call():
    await _assert_verifier_prerequisite_error_closure("prompt", supplied_id=True)


async def test_verifier_schema_prerequisite_error_closes_generated_call():
    await _assert_verifier_prerequisite_error_closure("schema", supplied_id=False)


def _verifier_prerequisite_lifecycle_failures():
    from temporalio.exceptions import ActivityError, ApplicationError, CancelledError, RetryState
    from helpers.generation_handoff import GenerationHandoffRequested
    from helpers.workflow_generation import WorkflowGenerationSealed

    failures = [
        asyncio.CancelledError(),
        CancelledError("cancelled"),
        WorkflowGenerationSealed("generation replaced"),
        GenerationHandoffRequested("replacement-queue"),
    ]
    for kind in ("CancelledError", "WorkflowGenerationSealed", "GenerationHandoffRequested"):
        error = ActivityError(
            "prerequisite activity failed",
            scheduled_event_id=1,
            started_event_id=2,
            identity="test",
            activity_type="schema",
            activity_id="schema-read",
            retry_state=RetryState.NON_RETRYABLE_FAILURE,
        )
        error.__cause__ = ApplicationError("native lifecycle", type=kind)
        failures.append(error)
    return failures


async def test_verifier_prerequisite_lifecycle_errors_bypass_error_closure():
    for stage in ("prompt", "schema"):
        for failure in _verifier_prerequisite_lifecycle_failures():
            posted, observed = await _capture_verifier_prerequisite_failure(stage, failure)
            assert observed is failure, "verifier replaced a native lifecycle error"
            assert len(posted) == 1 and posted[0]["metadata"]["toolStatus"] == "IN_PROGRESS"


async def test_verifier_error_closure_failure_preserves_native_error_semantics():
    failure = RuntimeError("original schema read failure")
    posted, observed = await _capture_verifier_prerequisite_failure(
        "schema", failure, closure_failure=RuntimeError("write failed")
    )
    assert len(posted) == 2, "verifier never attempted to close its failed prerequisite row"
    assert observed is failure, "ordinary error-closure write failure replaced the prerequisite error"
    for lifecycle in _verifier_prerequisite_lifecycle_failures():
        posted, observed = await _capture_verifier_prerequisite_failure("schema", failure, closure_failure=lifecycle)
        assert len(posted) == 2
        assert observed is lifecycle, "error closure swallowed a native lifecycle boundary"


@_with_native_schema_test_transport
async def test_attempt_completion_prerequisite_errors_recover_on_next_native_iteration():
    for stage in ("prompt", "schema"):
        await _exercise_native_verifier_prerequisite_recovery(stage)


async def _exercise_native_verifier_prerequisite_recovery(stage, *, persistent=False, max_iterations=5):
    failure = RuntimeError(f"actual verifier {stage} prerequisite unavailable")
    old_schema = {"fields": [{"name": "old", "type": "str"}]}
    current_schema = {"fields": [{"name": "current", "type": "str"}]}
    state = {"attempts": 0, "revision": 0, "verifier_schema": False}
    prompts, schemas, models, posted = [], [], [], []
    detected = []

    async def system_prompt():
        prompts.append(state["revision"])
        return f"Current contract {state['revision']}"

    async def verifier_prompt():
        state["attempts"] += 1
        if stage == "prompt" and (persistent or state["attempts"] == 1):
            state["revision"] = 1
            raise failure
        state["verifier_schema"] = True
        return f"Verify contract {state['revision']}"

    async def schema():
        verifier_read = state.pop("verifier_schema", False)
        if verifier_read and stage == "schema" and (persistent or state["attempts"] == 1):
            state["revision"] = 1
            raise failure
        value = current_schema if state["revision"] else old_schema
        schemas.append((verifier_read, value))
        return value

    def next_completion():
        detected[:] = [("attempt_completion", f"native-verifier-{len(models)}", 1.0)]
        return [{"tool": "attempt_completion"}]

    async def post(text, role, metadata=None):
        posted.append({"text": text, "role": role, "metadata": dict(metadata or {})})

    provider = AsyncMock(
        return_value={
            "score": 1.0,
            "reasoning": "Actual completed verdict",
            "structured_response": {"current": "done"},
            "usage": {},
        }
    )
    with patch("loop.run_agent.asyncio.sleep", new=AsyncMock()) as sleep:
        result, _, _ = await _run_single_iteration(
            [],
            detected,
            skip_verification=False,
            max_iterations=max_iterations,
            llm_tool_calls_factory=next_completion,
            llm_response_models=models,
            system_prompt_override=system_prompt,
            verifier_prompt_override=verifier_prompt,
            get_response_schema_override=schema,
            verifier_override=provider,
            post_message_override=post,
        )
    assert not any(call.args[0] >= 1 for call in sleep.await_args_list), "verifier errors used preparation backoff"
    errors = [row for row in posted if row["metadata"].get("toolStatus") == "ERROR"]
    assert all(row["text"] == str(failure) and row["metadata"].get("excludeFromModel") is True for row in errors)
    assert not any(row["metadata"].get("verifierMessage") for row in errors)
    if persistent:
        expected_turns = min(max_iterations, 3)
        assert len(models) == expected_turns, "verifier errors refunded or exceeded accepted-turn budget"
        assert len(errors) == state["attempts"]
        provider.assert_not_awaited()
        if max_iterations >= 3:
            assert state["attempts"] == 3 and result["status"] == "error"
            assert "Verifier unavailable after 3 consecutive failures" in result["message"]
            assert str(failure) in result["message"]
        else:
            assert result["status"] == "max_iterations" and result.get("score") != 1.0
    else:
        assert result["status"] == "completed" and result["score"] == 1.0
        assert len(models) == state["attempts"] == 2 and len(errors) == 1
        assert errors[0]["metadata"]["toolCallId"] == "native-verifier-1"
        assert prompts == [0, 1] and schemas[-1] == (True, current_schema)
        provider.assert_awaited_once()
        assert provider.await_args.args[1] == "Verify contract 1" and provider.await_args.args[3] == current_schema
        assert result["message"] == "Actual completed verdict"


@_with_native_schema_test_transport
async def test_attempt_completion_prerequisite_errors_use_existing_three_error_bound():
    for stage in ("prompt", "schema"):
        await _exercise_native_verifier_prerequisite_recovery(stage, persistent=True)


@_with_native_schema_test_transport
async def test_attempt_completion_prerequisite_errors_preserve_iteration_budget():
    await _exercise_native_verifier_prerequisite_recovery("prompt", persistent=True, max_iterations=1)


@_with_native_schema_test_transport
async def test_native_verifier_callers_propagate_lifecycle_errors_without_extra_turns():
    for final_caller in (False, True):
        for failure in _verifier_prerequisite_lifecycle_failures():
            models = []
            prompt = AsyncMock(side_effect=failure)
            provider = AsyncMock(side_effect=AssertionError("lifecycle error reached provider"))
            tool = "web_search" if final_caller else "attempt_completion"
            try:
                await _run_single_iteration(
                    [{"tool": tool}],
                    [(tool, "native-lifecycle", 1.0)],
                    skip_verification=False,
                    max_iterations=1 if final_caller else 5,
                    verifier_prompt_override=prompt,
                    verifier_override=provider,
                    llm_response_models=models,
                )
            except BaseException as observed:
                assert observed is failure, "native verifier caller replaced lifecycle error"
            else:
                raise AssertionError("native verifier caller swallowed lifecycle error")
            assert len(models) == 1, "native lifecycle error started an extra accepted LLM turn"
            prompt.assert_awaited_once()
            provider.assert_not_awaited()


@_with_native_schema_test_transport
async def test_native_verifier_returned_and_raised_errors_share_counter_and_reset():
    for sequence in (
        ("returned", "raised", "returned"),
        ("returned", "raised", "healthy_rejection", "raised", "returned", "returned"),
    ):
        models, attempts = [], []
        state = {}
        failure = RuntimeError("actual mixed prerequisite failure")

        async def prompt():
            event = sequence[len(attempts)]
            attempts.append(event)
            state["event"] = event
            if event == "raised":
                raise failure
            return "Verify current task"

        async def verdict(*_args, **_kwargs):
            if state["event"] == "healthy_rejection":
                return {"score": 0.4, "reasoning": "Actual work remains", "structured_response": None, "usage": {}}
            return {
                "score": 0.5,
                "reasoning": "Progress check failed: actual provider outage",
                "structured_response": None,
                "usage": {},
            }

        provider = AsyncMock(side_effect=verdict)
        result, posted, _ = await _run_single_iteration(
            [{"tool": "attempt_completion"}],
            [("attempt_completion", "shared-error-counter", 1.0)],
            skip_verification=False,
            max_iterations=len(sequence) + 1,
            verifier_prompt_override=prompt,
            verifier_override=provider,
            llm_response_models=models,
            response_schema={"fields": [{"name": "answer", "type": "str", "required": True}]},
        )
        assert result["status"] == "error" and len(models) == len(attempts) == len(sequence)
        assert "Verifier unavailable after 3 consecutive failures" in result["message"]
        assert attempts == list(sequence), "returned and raised errors did not share/reset the existing counter"
        assert provider.await_count == len(sequence) - sequence.count("raised")
        closures = [row for row in posted if (row.get("metadata") or {}).get("toolStatus") == "ERROR"]
        assert len(closures) == sequence.count("raised")
        assert all(row["text"] == str(failure) for row in closures)


@_with_native_schema_test_transport
async def test_raised_verifier_error_preserves_successful_tool_no_tool_reset():
    failure = RuntimeError("single verifier prerequisite failure")
    prompt = AsyncMock(side_effect=[failure, "Verify after recovery"])
    models = []
    result, posted, _ = await _run_single_iteration(
        [],
        [("attempt_completion", "no-tool-reset", 1.0)],
        skip_verification=False,
        max_iterations=5,
        llm_tool_calls_sequence=[[], [], [{"tool": "attempt_completion"}], [], [{"tool": "attempt_completion"}]],
        verifier_prompt_override=prompt,
        llm_response_models=models,
    )
    assert result["status"] == "completed", "intervening attempt_completion failed to reset consecutive no-tool count"
    assert len(models) == 5 and prompt.await_count == 2
    assert len([row for row in posted if (row.get("metadata") or {}).get("toolStatus") == "ERROR"]) == 1


async def test_verifier_healthy_prerequisites_preserve_provider_verdict():
    from loop.run_agent import _run_verifier

    schema = {"fields": [{"name": "answer", "type": "str", "required": True}]}
    verdict = {
        "score": 0.63,
        "reasoning": "Actual provider finding",
        "structured_response": {"answer": "42"},
        "usage": {"prompt_tokens": 17},
    }
    provider = AsyncMock(return_value=verdict)
    posted = []

    async def post(text, role, metadata=None):
        posted.append({"text": text, "role": role, "metadata": metadata})

    result = await _run_verifier(
        execute_activity=provider,
        context=[],
        verifier_prompt_generator=AsyncMock(return_value="Actual prompt"),
        model="test-model",
        agent_id="agent",
        task_id="task",
        post_message=post,
        get_response_schema=AsyncMock(return_value=schema),
        tool_call_id="healthy-call",
    )
    assert result is verdict and result["score"] == 0.63 and result["reasoning"] == "Actual provider finding"
    assert result["structured_response"] == {"answer": "42"} and result["resolved_response_schema"] == schema
    provider.assert_awaited_once()
    assert provider.await_args.kwargs["args"][1] == "Actual prompt"
    assert provider.await_args.kwargs["args"][3] == schema
    assert [row["metadata"]["toolStatus"] for row in posted] == ["IN_PROGRESS", "FINISHED"]
    assert posted[1]["metadata"]["verifierMessage"] is True and "Verifier score: 63%" in posted[1]["text"]
    assert not any(row["metadata"].get("error") or row["metadata"].get("excludeFromModel") for row in posted)


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
        model="rose-flash",
        agent_id="a",
        task_id="t",
        post_message=None,
        get_response_schema=get_response_schema,
    )

    assert len(schema_calls) == 1


async def test_completed_browser_output_forces_parent_completion_instead_of_second_browser():
    """A verified browser result must complete without another model turn.

    Regression: the simulated Amazon checkout browser returned a terminal,
    schema-complete result, but the unrestricted next root turn spawned a second
    browser session instead of calling attempt_completion. The parent verifier
    already accepts this exact child output, so the runtime deterministically
    dispatches the completion boundary instead of asking a model to repeat it.
    """
    from helpers.llm import call_llm_activity, check_progress
    from loop import run_agent as run_mod

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
                "action_type": "task_complete",
                "success": True,
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
            raise AssertionError("schema-complete child handoff must not call the LLM")
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
            model="rose-labs/rose-1-flash",
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
    assert llm_calls == []


async def test_completed_code_child_dispatches_parent_completion_without_llm():
    """A terminal Claude Code result reaches the verifier without a model roundtrip."""
    response_schema = {
        "fields": [
            {"name": "program_output", "type": "str", "required": True},
            {"name": "step_count", "type": "int", "required": True},
        ]
    }
    child_result = {"program_output": "27 82 41 ... 1", "step_count": 111}
    context = [
        {"role": "USER", "text": "Run the program", "timestamp": "2026-09-10T00:00:00Z"},
        {
            "role": "TOOL",
            "text": "Claude Code completed successfully",
            "timestamp": "2026-09-10T00:00:01Z",
            "metadata": {
                "toolCallId": "claude-one",
                "toolName": "spawn_claude_code_agent",
                "toolStatus": "FINISHED",
                "action_type": "task_complete",
                "success": True,
                "structured_response": {"output": child_result},
            },
        },
    ]

    def fail_if_llm_called():
        raise AssertionError("terminal code-child handoff must not call the LLM")

    result, _, executed = await _run_single_iteration(
        [],
        [],
        skip_verification=False,
        initial_context=context,
        response_schema=response_schema,
        verifier_structured_response=child_result,
        llm_tool_calls_factory=fail_if_llm_called,
        max_iterations=2,
    )

    assert result["status"] == "completed"
    assert result["structured_response"] == child_result
    assert [item["tool_name"] for item in executed] == ["attempt_completion"]


async def test_rejected_completed_child_handoff_returns_control_to_llm():
    """A rejected synthetic completion is not replayed forever."""
    cache_steps = []

    async def record_cache_step(_agent_id, step):
        cache_steps.append(step)

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
        {"role": "USER", "text": "Buy the item", "timestamp": "2026-09-10T00:00:00Z"},
        {
            "role": "TOOL",
            "text": "Browser automation complete",
            "timestamp": "2026-09-10T00:00:01Z",
            "metadata": {
                "toolCallId": "browser-one",
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "action_type": "task_complete",
                "success": True,
                "structured_response": child_result,
            },
        },
    ]
    llm_calls = 0

    def corrective_llm_turn():
        nonlocal llm_calls
        llm_calls += 1
        return [{"tool": "web_search", "query": "correct the rejected handoff"}]

    with patch(
        "providers.demo_cache.client.ensure_position_context",
        new=AsyncMock(side_effect=record_cache_step),
    ):
        result, _, executed = await _run_single_iteration(
            [],
            [],
            skip_verification=False,
            initial_context=context,
            response_schema=response_schema,
            verifier_score=0.4,
            verifier_reasoning="The parent still needs corrective work.",
            verifier_structured_response=child_result,
            llm_tool_calls_factory=corrective_llm_turn,
            max_iterations=2,
        )

    assert result["status"] == "max_iterations"
    assert llm_calls == 1
    assert [item["tool_name"] for item in executed] == ["attempt_completion", "web_search"]
    assert cache_steps == [1], "the synthetic completion must not consume a provider-cache position"


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


async def test_verifier_usage_does_not_invent_cache_sequence_identity():
    """One-shot verifier usage must not pollute the execute cache group."""
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
        },
        on_tokens_override=capture_usage,
    )

    verifier_calls = [call for call in usage_calls if call["call_site"].startswith("verifier_")]
    assert verifier_calls
    assert all(call["cache_sequence_id"] is None for call in verifier_calls)


async def test_completed_child_required_tool_is_enforced_inside_direct_activity():
    """A schema-complete child dispatches completion without another LLM call."""
    import providers.demo_cache.context as demo_cache_context

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
                "action_type": "task_complete",
                "success": True,
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
    original_set_context = demo_cache_context.set_context

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
        cache_context = demo_cache_context.current_context()
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
        patch.object(demo_cache_context, "set_context", side_effect=capture_cache_context),
        patch.object(demo_cache_context, "write_through_enabled_for_user", return_value=False),
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
                        "source": "pool",
                        "poolTokenId": "pool-token-2",
                        "lineageKey": "agent:agent-test",
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
    assert llm_call_count == 0
    assert cache_contexts == []
    assert stream_sequences == []
    assert stream_final_sequences == []
    assert response_models == []
    assert auth_calls == []
    assert len(usage_reports) == 1
    assert usage_reports[0][:3] == (5, 6, None)
    assert usage_reports[0][3]["call_site"] == "verifier_execute"
    assert result["tokens_in"] >= 5
    assert result["tokens_out"] >= 6


async def test_pause_after_forced_completion_llm_still_dispatches_attempt_completion():
    """Verifier accounting must not discard deterministic attempt_completion.

    Regression: gate-subscription-card-mint-admin-bypass pass@5 agent
    b7b53dfb-20b4-4b8e-b019-432a315cee83 — browser child returned schema-complete
    structured_response; parent logged run_agent.completed_child_forces_completion.
    Completion is now synthesized before any LLM call, then its verifier result
    remains terminal even if accounting observes a concurrent pause.
    """
    response_schema = {
        "fields": [
            {"name": "payment_card_last4", "type": "str", "required": True},
            {"name": "purchased_products", "type": "list", "required": True},
            {"name": "order_confirmation_id", "type": "str", "required": True},
        ]
    }
    child_result = {
        "payment_card_last4": "6168",
        "purchased_products": ["Aurora Notebook", "Ceramic Mug", "Canvas Tote"],
        "order_confirmation_id": "tp_81fcdf56",
    }
    context = [
        {"role": "USER", "text": "Buy the three products", "timestamp": "2026-08-21T18:22:41Z"},
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2026-08-21T18:23:01Z",
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
            "timestamp": "2026-08-21T18:28:52Z",
            "metadata": {
                "toolCallId": "browser-one",
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "action_type": "task_complete",
                "success": True,
                "structured_response": child_result,
            },
        },
    ]
    pause_after_usage = False

    async def on_tokens(*_args, **_kwargs):
        nonlocal pause_after_usage
        pause_after_usage = True

    async def check_paused():
        return pause_after_usage

    result, _, executed = await _run_single_iteration(
        [{"tool": "attempt_completion"}],
        [("attempt_completion", "tc-forced-ac", 1.0)],
        skip_verification=False,
        initial_context=context,
        response_schema=response_schema,
        verifier_structured_response=child_result,
        on_tokens_override=on_tokens,
        check_paused_override=check_paused,
        max_iterations=2,
    )

    assert result["status"] == "completed", (
        f"forced attempt_completion must finish even when PAUSE arrives after the LLM "
        f"return; got status={result.get('status')!r} executed={[e['tool_name'] for e in executed]}"
    )
    assert [item["tool_name"] for item in executed] == ["attempt_completion"]


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


async def test_poll_inbox_rows_reach_next_llm_call_once_and_failures_continue():
    """In-activity agents append agent-message rows before the next LLM call.

    A raising inbox hook must not end the loop; each delivered row is visible
    to every later LLM call exactly once.
    """
    row = {
        "role": "USER",
        "text": "Use Denver.",
        "timestamp": "2024-01-01T00:00:01Z",
        "metadata": {"agentMessage": True, "agentMessageId": "m1", "fromAgentPath": "/root"},
    }
    responses = [[], [row], RuntimeError("inbox down")]
    seen_contexts = []

    async def poll_inbox():
        item = responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return [dict(r) for r in item]

    def build_messages(context, prompt):
        seen_contexts.append([dict(m) for m in context])
        return [{"role": "system", "content": prompt}]

    result, _, _ = await _run_single_iteration(
        [{"tool": "web_search", "query": "x"}],
        [("web_search", "tc-1", 1.0)],
        max_iterations=3,
        poll_inbox_override=poll_inbox,
        build_messages_override=build_messages,
    )
    agent_rows = [[m for m in ctx if (m.get("metadata") or {}).get("agentMessage")] for ctx in seen_contexts]
    assert len(seen_contexts) == 3, "inbox failure stopped the loop"
    assert [len(rows) for rows in agent_rows] == [0, 1, 1]
    assert agent_rows[1][0]["role"] == "USER" and agent_rows[1][0]["text"] == row["text"]
    assert result["status"] == "max_iterations"


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
                model="rose-labs/rose-1-flash",
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


async def test_failed_tool_posts_no_duplicate_chip_but_still_reaches_context():
    """The tool layer owns a failed tool's chip; run_agent must not post a second.

    Every tool posts its own formatted terminal ERROR chip (params, elapsed,
    cost) and then re-raises — domains/web_fetch/handler.py:319,
    domains/grep/service.py:317, tools/web_search/handler.py:180,
    tools/people_search/handler.py:177. run_agent posting another row at the SAME
    toolCallId is not extra visibility: the FE resolves a chip by toolCallId with
    last write wins, so the second row DELETED the formatted chip and left the
    user a bare exception string attributed to the sub-agent.
    docs/rca/cases/2026-08-19-explore-fe-posts-race-into-last-write-wins-chip-id.md

    The agent's own error feedback is the local context.append, which is
    independent of the FE post — asserted here so this can never be "fixed"
    by silencing the model's error feedback as well.
    """

    async def failing_execute_tool(tool_name, tool_args, tool_call_id):
        raise RuntimeError("WebFetchProvidersFailed: web_fetch cannot fetch 'documents/generic/x'")

    tool_calls = [{"tool": "web_fetch", "url": "documents/generic/x", "objective": "y"}]
    detected = [("web_fetch", "10a6cbd0-346e-437f-af57-14c0a2c8b0d6", 1.0)]

    _, posted, _ = await _run_single_iteration(
        tool_calls,
        detected,
        execute_tool_override=failing_execute_tool,
        is_inside_temporal_activity=True,
    )

    duplicate_chips = [
        p for p in posted if p["role"] == "TOOL" and (p.get("metadata") or {}).get("toolStatus") == "ERROR"
    ]
    assert not duplicate_chips, (
        "run_agent posted a duplicate ERROR chip for a failed tool; it collides "
        f"with the tool's own chip at the same toolCallId: {duplicate_chips}"
    )


@_owned_realtime_fixture()
async def test_attempt_completion_result_reaches_the_verifier_as_authored_work():
    """attempt_completion(result=...) is the agent's own writing; the verifier must see it.

    tree-feedback-routing b056f571: a drafter had no tool that could show its
    draft to the verifier, so it spawned a code agent just to archive the text.
    """
    seen = []

    async def verifier(*args, **kwargs):
        seen.append([dict(m) for m in args[0]])
        return {"score": 1.0, "reasoning": "ok", "structured_response": None, "usage": {}}

    for args, expected in (
        ({"tool": "attempt_completion", "result": "Hi Garry,\n...\nAndy Prevalskii, Founder, Rose Labs"}, True),
        ({"tool": "attempt_completion"}, False),
    ):
        seen.clear()
        await _run_single_iteration(
            [args],
            [("attempt_completion", "tc-1", 1.0)],
            skip_verification=False,
            max_iterations=1,
            verifier_override=verifier,
        )
        assert seen, "verifier did not run"
        authored = [
            m
            for m in seen[-1]
            if (m.get("metadata") or {}).get("toolName") == "attempt_completion"
            and (m.get("metadata") or {}).get("title") == "Authored result"
        ]
        if expected:
            assert len(authored) == 1, seen[-1]
            assert authored[0]["role"] == "TOOL" and authored[0]["metadata"]["toolStatus"] == "FINISHED"
            # End to end through the verifier's own context builder (b056f571 rerun
            # 46ce6f37: the row's text was empty there).
            from helpers.llm import build_verifier_context_messages

            rendered = "\n".join(str(m["content"]) for m in build_verifier_context_messages(seen[-1], "V"))
            assert '"tool_name": "attempt_completion"' in rendered
            assert "Andy Prevalskii, Founder, Rose Labs" in rendered, rendered
        else:
            assert authored == [], seen[-1]


async def _exercise_explore_terminal_handoff(kind):
    import helpers.agent_inbox as inbox_module

    inbox = inbox_module.AgentInbox("owner", "same-task")
    stored, seen, calls = [], [], []
    waits = []
    original_wait = asyncio.wait
    release_stale = asyncio.Event()
    fetch_count = 0
    row = {
        "id": "marker",
        "text": "Forwarded marker: HTTP core document",
        "created_at": "2026-10-29T17:47:49.682Z",
    }

    async def count_wait(*args, **kwargs):
        waits.append(kwargs.get("timeout"))
        return await original_wait(*args, **kwargs)

    async def fetch(*args):
        nonlocal fetch_count
        fetch_count += 1
        snapshot = list(stored)
        if kind == "stale-read" and fetch_count == 1:
            await release_stale.wait()
        if kind == "failed-read":
            raise RuntimeError("controlled read failure")
        return snapshot

    async def poll():
        rows = await inbox.next_step_messages()
        seen.extend(item["id"] for item in rows)
        await asyncio.sleep(0)
        await asyncio.sleep(0)  # Let the model turn's nonblocking read finish empty.
        return [{"role": "USER", "text": item["text"], "metadata": {"agentMessage": True}} for item in rows]

    async def execute(*args):
        calls.append(args[0])
        if len(calls) == 1 and kind not in ("no-message", "failed-read", "cancel"):
            stored.extend([row, row] if kind == "duplicate" else [row])
        deferred = await inbox.unread_before_finish()
        release_stale.set()
        if deferred:
            return {"error": True, "message": "existing deferred message"}
        return {"success": True}

    async def handoff():
        if kind == "cancel":
            raise asyncio.CancelledError()
        if await inbox.settle_for_handoff():
            return "existing deferred message"
        return None

    kwargs = dict(
        tool_calls=[{"tool": "attempt_completion", "result": "done"}],
        detected_tools_ordered=[("attempt_completion", "tc", 1.0)],
        max_iterations=1 if kind == "last-budget" else 2,
        execute_tool_override=execute,
        poll_inbox_override=poll,
        completion_handoff_override=handoff,
    )
    with (
        patch.object(inbox_module, "fetch_agent_inbox", fetch),
        patch.object(asyncio, "wait", count_wait),
        patch("providers.demo_cache.client.resolve_agent_fast_mode", new=AsyncMock(return_value=(False, None, False, None, None, True))),
        patch("providers.demo_cache.client.ensure_position_context", new=AsyncMock()),
    ):
        if kind == "cancel":
            try:
                await _run_single_iteration(**kwargs)
            except asyncio.CancelledError:
                return
            raise AssertionError("cancellation swallowed")
        result, _, _ = await _run_single_iteration(**kwargs)
        waits_before_finish = len(waits)
        late = await inbox.finish()
        assert len(waits) == waits_before_finish, "finish spent the terminal read wait twice"
        assert not inbox._reads, "finish left an unsettled read"
        assert not inbox._fetched, "finish left a message without custody"

    if kind in ("no-message", "failed-read"):
        assert result["status"] == "completed" and len(calls) == 1 and seen == []
    elif kind == "last-budget":
        assert result["status"] == "max_iterations" and len(calls) == 1
        assert [item["id"] for item in late] == ["marker"], "iteration cap must retain parent handoff"
    else:
        assert seen == ["marker"], (kind, "same task must consume once", seen, [item["id"] for item in late])
        assert result["status"] == "completed" and len(calls) == 2
        assert not late, late
    assert len(waits) == len(calls), "each completion attempt settles its existing read once"


async def test_explore_consumes_final_call_message_before_terminal_handoff():
    await _exercise_explore_terminal_handoff("final-call")


async def test_explore_terminal_handoff_deduplicates_message_id():
    await _exercise_explore_terminal_handoff("duplicate")


async def test_explore_terminal_handoff_no_message_finishes():
    await _exercise_explore_terminal_handoff("no-message")


async def test_explore_terminal_handoff_failed_read_preserves_completion():
    await _exercise_explore_terminal_handoff("failed-read")


async def test_explore_terminal_handoff_does_not_refund_last_iteration():
    await _exercise_explore_terminal_handoff("last-budget")


async def test_explore_terminal_handoff_propagates_cancellation():
    await _exercise_explore_terminal_handoff("cancel")


async def test_explore_terminal_handoff_refreshes_stale_pending_snapshot():
    await _exercise_explore_terminal_handoff("stale-read")


async def run_all_tests():
    from helpers.messages import flush_realtime_broadcasts_for_tests

    print("run-agent blackbox tests:")
    r = BlackboxResult()
    await r.record_async("browser_budget_wrapup_stream_and_verification", test_browser_budget_wrapup_admits_one_complete_stream_and_normal_verification)
    await r.record_async("browser_budget_handoff_preserves_unused_allowance", test_browser_budget_handoff_before_llm_preserves_unused_allowance)
    await r.record_async("browser_budget_compaction_preserves_unused_allowance", test_browser_budget_compaction_before_llm_preserves_unused_allowance)
    await r.record_async("browser_budget_preparation_retry_preserves_allowance", test_browser_budget_preparation_retry_does_not_spend_unused_allowance)
    await r.record_async("browser_budget_accepted_failure_keeps_allowance_consumed", test_browser_budget_accepted_response_failure_does_not_refund_allowance)
    await r.record_async("browser_budget_precall_pause_keeps_iteration", test_browser_budget_precall_pause_does_not_spend_iteration)
    await r.record_async(
        "explore_terminal_handoff_refreshes_stale_pending_snapshot",
        test_explore_terminal_handoff_refreshes_stale_pending_snapshot,
    )
    await r.record_async(
        "explore_consumes_final_call_message_before_terminal_handoff",
        test_explore_consumes_final_call_message_before_terminal_handoff,
    )
    await r.record_async(
        "explore_terminal_handoff_deduplicates_message_id",
        test_explore_terminal_handoff_deduplicates_message_id,
    )
    await r.record_async(
        "explore_terminal_handoff_no_message_finishes",
        test_explore_terminal_handoff_no_message_finishes,
    )
    await r.record_async(
        "explore_terminal_handoff_failed_read_preserves_completion",
        test_explore_terminal_handoff_failed_read_preserves_completion,
    )
    await r.record_async(
        "explore_terminal_handoff_does_not_refund_last_iteration",
        test_explore_terminal_handoff_does_not_refund_last_iteration,
    )
    await r.record_async(
        "explore_terminal_handoff_propagates_cancellation",
        test_explore_terminal_handoff_propagates_cancellation,
    )
    await r.record_async("jev_schedules_every_turn", test_jev_schedules_every_turn_without_changing_decisions)
    await r.record_async("workflow_output_retention_activity", test_workflow_output_retention_uses_activity)
    await r.record_async("workflow_marker_verification_activity", test_workflow_marker_verification_uses_activity)
    await r.record_async("workflow_preview_timeout_stated_cut", test_workflow_preview_timeout_keeps_stated_cut)
    await r.record_async("activity_preview_retention_failure_stated_cut", test_activity_preview_retention_failure_keeps_stated_cut)
    await r.record_async("iteration_fixture_retires_realtime", test_iteration_fixture_retires_its_realtime_sender)
    await r.record_async(
        "poll_inbox_rows_reach_next_llm_call_once",
        test_poll_inbox_rows_reach_next_llm_call_once_and_failures_continue,
    )
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
        "no_tool_turn_with_background_agents_normal_handling",
        test_no_tool_turn_with_background_agents_gets_normal_no_tool_handling,
    )
    await r.record_async(
        "completion_with_background_agents_reaches_verifier",
        test_completion_with_background_agents_reaches_verifier_with_their_status,
    )
    await r.record_async(
        "tool_exception_continues_loop_no_duplicate_chip",
        test_tool_exception_continues_loop_without_posting_a_duplicate_chip,
    )
    await r.record_async(
        "failed_llm_call_does_not_consume_iteration_budget",
        test_failed_llm_call_does_not_consume_iteration_budget,
    )
    await r.record_async("status_needs_user_help_returned_from_tool", test_status_needs_user_help_returned_from_tool)
    await r.record_async(
        "generation_handoff_from_tool_result",
        test_generation_handoff_from_tool_result_returns_immediately,
    )
    await r.record_async("status_completed_from_tool", test_status_completed_from_tool)
    await r.record_async(
        "verifier_below_threshold_adds_feedback_and_loops", test_verifier_below_threshold_adds_feedback_and_loops
    )
    await r.record_async("verifier_score_1_returns_completed", test_verifier_score_1_returns_completed)
    await r.record_async(
        "verifier_infra_soft_fail_does_not_accept_attempt_completion",
        test_verifier_infra_soft_fail_does_not_accept_attempt_completion,
    )
    await r.record_async(
        "verifier_infra_soft_fail_rejects_malformed_structured_response",
        test_verifier_infra_soft_fail_rejects_malformed_structured_response,
    )
    await r.record_async(
        "verifier_infra_soft_fail_trips_circuit_breaker_without_schema",
        test_verifier_infra_soft_fail_trips_circuit_breaker_without_schema,
    )
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
        "run_agent_drops_rotated_out_credential_when_lease_reread_fails",
        test_run_agent_drops_rotated_out_credential_when_lease_reread_fails,
    )
    await r.record_async(
        "run_agent_records_served_lease_identity_without_rotation",
        test_run_agent_records_served_lease_identity_without_rotation,
    )
    await r.record_async(
        "demo_cache_position_retries_same_step_after_llm_failure",
        test_demo_cache_position_retries_same_step_after_llm_failure,
    )
    await r.record_async(
        "run_agent_refusal_retry_excludes_anthropic_without_backoff",
        test_run_agent_refusal_retry_excludes_anthropic_without_backoff,
    )
    await r.record_async(
        "schema_getter_native_retry", test_schema_getter_failures_use_existing_native_preacceptance_retry
    )
    await r.record_async(
        "schema_getter_native_bound", test_schema_getter_persistent_failure_uses_existing_three_attempt_bound
    )
    await r.record_async(
        "system_prompt_schema_native_retry", test_system_prompt_schema_failures_use_existing_native_retry
    )
    await r.record_async(
        "schema_preparation_lifecycle", test_schema_preparation_lifecycle_errors_propagate_without_retry
    )
    await r.record_async("completed_child_current_schema", test_completed_child_optimization_uses_current_native_schema)
    await r.record_async(
        "run_agent_refusal_reroute_crosses_the_temporal_activity_boundary",
        test_run_agent_refusal_reroute_crosses_the_temporal_activity_boundary,
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
        "activity_tool_results_are_hard_capped_before_context_append",
        test_activity_tool_results_are_hard_capped_before_context_append,
    )
    await r.record_async(
        "activity_tool_result_cap_prevents_protected_tail_overflow",
        test_activity_tool_result_cap_prevents_protected_tail_overflow,
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
        "verifier_prompt_prerequisite_error_closure", test_verifier_prompt_prerequisite_error_closes_supplied_call
    )
    await r.record_async(
        "verifier_schema_prerequisite_error_closure", test_verifier_schema_prerequisite_error_closes_generated_call
    )
    await r.record_async(
        "verifier_prerequisite_lifecycle", test_verifier_prerequisite_lifecycle_errors_bypass_error_closure
    )
    await r.record_async(
        "verifier_error_closure_failure_semantics", test_verifier_error_closure_failure_preserves_native_error_semantics
    )
    await r.record_async(
        "verifier_healthy_prerequisite_verdict", test_verifier_healthy_prerequisites_preserve_provider_verdict
    )
    await r.record_async(
        "attempt_completion_prerequisite_native_recovery",
        test_attempt_completion_prerequisite_errors_recover_on_next_native_iteration,
    )
    await r.record_async(
        "attempt_completion_prerequisite_existing_bound",
        test_attempt_completion_prerequisite_errors_use_existing_three_error_bound,
    )
    await r.record_async(
        "attempt_completion_prerequisite_iteration_budget",
        test_attempt_completion_prerequisite_errors_preserve_iteration_budget,
    )
    await r.record_async(
        "native_verifier_caller_lifecycle", test_native_verifier_callers_propagate_lifecycle_errors_without_extra_turns
    )
    await r.record_async(
        "native_verifier_shared_counter_reset", test_native_verifier_returned_and_raised_errors_share_counter_and_reset
    )
    await r.record_async(
        "native_verifier_error_no_tool_reset", test_raised_verifier_error_preserves_successful_tool_no_tool_reset
    )
    await r.record_async(
        "verifier_authored_attention_event_identity",
        test_verifier_uses_authored_attention_event_identity_across_row_retries,
    )
    await r.record_async(
        "verifier_requirement_completion_boundaries",
        test_verifier_rechecks_real_user_requirements_at_completion_boundaries,
    )
    await r.record_async(
        "final_verifier_suppresses_stale_completion_data", test_final_verifier_does_not_publish_stale_completion_data
    )
    await r.record_async(
        "superseded_verifier_preserves_provider_result", test_superseded_verifier_keeps_actual_provider_result
    )
    await r.record_async(
        "parent_agent_task_update_supersedes_verdict",
        test_parent_agent_task_update_supersedes_verdict_but_other_agent_rows_do_not,
    )
    await r.record_async(
        "verifier_interrupted_by_new_message",
        test_verifier_is_interrupted_by_a_new_user_or_agent_message,
    )
    await r.record_async(
        "keyed_feedback_revision_versions_verdict", test_keyed_feedback_revision_supersedes_verdict_without_user_row
    )
    await r.record_async(
        "verifier_prompt_schema_same_requirement_revision",
        test_verifier_reloads_prompt_and_schema_until_requirement_revision_matches,
    )
    await r.record_async(
        "completed_browser_output_forces_parent_completion",
        test_completed_browser_output_forces_parent_completion_instead_of_second_browser,
    )
    await r.record_async(
        "completed_child_bypasses_llm_and_demo_cache",
        test_completed_child_required_tool_is_enforced_inside_direct_activity,
    )
    await r.record_async(
        "completed_code_child_dispatches_parent_completion_without_llm",
        test_completed_code_child_dispatches_parent_completion_without_llm,
    )
    await r.record_async(
        "rejected_completed_child_handoff_returns_control_to_llm",
        test_rejected_completed_child_handoff_returns_control_to_llm,
    )
    await r.record_async(
        "pause_after_forced_completion_llm_still_dispatches_attempt_completion",
        test_pause_after_forced_completion_llm_still_dispatches_attempt_completion,
    )
    await r.record_async("max_iterations_runs_final_verifier", test_max_iterations_runs_final_verifier)
    await r.record_async(
        "verifier_usage_preserves_cache_sequence_identity",
        test_verifier_usage_preserves_cache_sequence_identity,
    )
    await r.record_async(
        "verifier_usage_does_not_invent_cache_sequence_identity",
        test_verifier_usage_does_not_invent_cache_sequence_identity,
    )
    await r.record_async("winddown_injects_one_message_near_cap", test_winddown_injects_one_message_near_cap)
    await r.record_async("winddown_disabled_by_default", test_winddown_disabled_by_default)
    await r.record_async(
        "paused_agent_does_not_busy_spin_and_yields_to_cold_handler",
        test_paused_agent_does_not_busy_spin_and_yields_to_cold_handler,
    )
    await r.record_async(
        "failed_tool_posts_no_duplicate_chip",
        test_failed_tool_posts_no_duplicate_chip_but_still_reaches_context,
    )
    await r.record_async(
        "attempt_completion_result_reaches_the_verifier_as_authored_work",
        test_attempt_completion_result_reaches_the_verifier_as_authored_work,
    )
    await r.record_async(
        "assistant_thought_records_measured_generation",
        test_assistant_thought_records_measured_generation,
    )
    await r.record_async(
        "thought_generation_metadata_is_invisible_to_every_llm_builder",
        test_thought_generation_metadata_is_invisible_to_every_llm_builder,
    )
    await flush_realtime_broadcasts_for_tests()
    teardown_mock()

    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
