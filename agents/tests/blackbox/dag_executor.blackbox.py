"""Blackbox tests for loop/dag_executor.py domain."""

import asyncio
import inspect
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from _test_utils import BlackboxResult, teardown_mock


def test_extract_error_message_plain():
    """extract_error_message returns str(e) for plain exception."""
    from loop.dag_executor import extract_error_message

    assert extract_error_message(ValueError("bang")) == "bang"


def test_extract_error_message_unwraps_generic_wrapper():
    """extract_error_message skips 'Activity task failed' and returns deeper cause."""
    from loop.dag_executor import extract_error_message

    inner = ValueError("real problem")
    outer = Exception("Activity task failed")
    outer.__cause__ = inner

    assert extract_error_message(outer) == "real problem"


def test_extract_error_message_uses_cause_attr():
    """extract_error_message follows .cause attribute (Temporal-style)."""
    from loop.dag_executor import extract_error_message

    class FakeTemporalErr(Exception):
        def __init__(self, msg, cause=None):
            super().__init__(msg)
            self.cause = cause

    deepest = FakeTemporalErr("deep error")
    middle = FakeTemporalErr("Activity task failed", cause=deepest)

    assert extract_error_message(middle) == "deep error"


def test_extract_error_message_empty():
    """extract_error_message returns 'Unknown error' for empty string."""
    from loop.dag_executor import extract_error_message

    assert extract_error_message(Exception("")) == "Unknown error"


def test_task_dag_rejects_string_tasks():
    """TaskDAG requires explicit tool_name instead of defaulting string tasks to reasoning."""
    from loop.dag_executor import TaskDAG

    plan_data = {
        "tasks": ["Analyze data", "Write summary"],
        "dependencies": {"1": [0]},
        "join": "all",
    }

    try:
        TaskDAG(plan_data)
        raise AssertionError("Expected string task to fail")
    except ValueError as e:
        assert "explicit goal and tool_name" in str(e)


def test_task_dag_rejects_missing_tool_name():
    """TaskDAG rejects dict tasks without explicit tool_name."""
    from loop.dag_executor import TaskDAG

    plan_data = {
        "tasks": [{"goal": "Analyze data"}],
        "dependencies": {},
    }

    try:
        TaskDAG(plan_data)
        raise AssertionError("Expected missing tool_name to fail")
    except ValueError as e:
        assert "missing required tool_name" in str(e)


def test_task_dag_parses_dict_tasks():
    """TaskDAG handles new format dict tasks with tool_name + goal."""
    from loop.dag_executor import TaskDAG

    plan_data = {
        "tasks": [
            {"goal": "Search web", "tool_name": "web_search"},
            {"goal": "Process", "tool_name": "reasoning"},
        ],
        "dependencies": {},
    }
    dag = TaskDAG(plan_data)

    assert dag.tasks[0].tool_name == "web_search"
    assert dag.tasks[0].goal == "Search web"
    assert dag.tasks[1].tool_name == "reasoning"


def test_task_dag_get_ready_tasks_initial():
    """get_ready_tasks returns all tasks with no deps initially."""
    from loop.dag_executor import TaskDAG

    plan_data = {
        "tasks": [
            {"goal": "A", "tool_name": "reasoning"},
            {"goal": "B", "tool_name": "reasoning"},
            {"goal": "C", "tool_name": "reasoning"},
        ],
        "dependencies": {"2": [0, 1]},
    }
    dag = TaskDAG(plan_data)
    ready = dag.get_ready_tasks()

    indexes = sorted(t.index for t in ready)
    assert indexes == [0, 1]  # task 2 is blocked


def test_resume_completed_tasks_ignores_background_executor_rows():
    """A planned background spawn's executor rows share its id but are FE-only: only the
    completion notification completes the task on resume (never the hidden executor result)."""
    from loop.dag_executor import TaskDAG, TaskState

    plan_data = {"tasks": [{"goal": "scan", "tool_name": "spawn_explore_agent"}], "dependencies": {}}
    started = {
        "role": "TOOL",
        "text": "Started explore agent in background. Address: /root/scan.",
        "metadata": {
            "toolCallId": "dag-t0",
            "toolName": "spawn_agent",
            "toolStatus": "FINISHED",
            "dagTaskIndex": 0,
            "runInBackground": True,
            "hidden": True,
            "backgroundTaskId": "dag-t0",
        },
    }
    executor_result = {
        "role": "TOOL",
        "text": "4 funds",
        "metadata": {
            "toolCallId": "dag-t0",
            "toolName": "spawn_agent",
            "toolStatus": "FINISHED",
            "excludeFromModel": True,
        },
    }
    notification = {
        "role": "USER",
        "text": "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/scan\nPayload:\n4 funds",
        "metadata": {"agentNotification": True, "backgroundTaskId": "dag-t0", "status": "completed"},
    }
    dag = TaskDAG(plan_data)
    assert dag.resume_completed_tasks_from_context([started, executor_result]) == []
    assert dag.tasks[0].state == TaskState.PENDING
    dag = TaskDAG(plan_data)
    assert dag.resume_completed_tasks_from_context([started, executor_result, notification]) == [0]


def test_task_dag_state_transitions():
    """mark_in_progress/completed/failed update state correctly."""
    from loop.dag_executor import TaskDAG, TaskState

    plan_data = {"tasks": [{"goal": "x", "tool_name": "reasoning"}], "dependencies": {}}
    dag = TaskDAG(plan_data)

    dag.mark_in_progress(0, "tc-1")
    assert dag.tasks[0].state == TaskState.IN_PROGRESS
    assert dag.tasks[0].tool_call_id == "tc-1"

    dag.mark_completed(0)
    assert dag.tasks[0].state == TaskState.COMPLETED
    assert dag.is_complete() is True

    # Reset and fail
    dag.tasks[0].state = TaskState.IN_PROGRESS
    dag.mark_failed(0)
    assert dag.tasks[0].state == TaskState.FAILED
    assert dag.has_failed() is True


def test_task_dag_is_complete_join_any():
    """With join=any, at least one COMPLETED means is_complete."""
    from loop.dag_executor import TaskDAG

    plan_data = {
        "tasks": [{"goal": "a", "tool_name": "r"}, {"goal": "b", "tool_name": "r"}],
        "dependencies": {},
        "join": "any",
    }
    dag = TaskDAG(plan_data)

    assert dag.is_complete() is False
    dag.mark_completed(0)
    assert dag.is_complete() is True


def test_task_dag_get_ready_respects_deps():
    """get_ready_tasks waits for dependencies to complete."""
    from loop.dag_executor import TaskDAG

    plan_data = {
        "tasks": [
            {"goal": "A", "tool_name": "reasoning"},
            {"goal": "B", "tool_name": "reasoning"},
        ],
        "dependencies": {"1": [0]},
    }
    dag = TaskDAG(plan_data)
    ready = dag.get_ready_tasks()
    assert [t.index for t in ready] == [0]

    dag.mark_completed(0)
    ready2 = dag.get_ready_tasks()
    assert [t.index for t in ready2] == [1]


def test_extract_plan_from_context_found():
    """extract_plan_from_context returns most recent set_plan FINISHED data."""
    from loop.dag_executor import extract_plan_from_context

    context = [
        {"metadata": {"toolName": "web_search", "toolStatus": "FINISHED", "data": {"ignore": True}}},
        {
            "metadata": {
                "toolName": "set_plan",
                "toolStatus": "FINISHED",
                "data": {"tasks": [{"goal": "x", "tool_name": "reasoning"}], "dependencies": {}},
            }
        },
    ]
    plan = extract_plan_from_context(context)
    assert plan is not None
    assert plan["tasks"][0]["goal"] == "x"


def test_extract_plan_from_context_empty():
    """extract_plan_from_context returns None when no set_plan exists."""
    from loop.dag_executor import extract_plan_from_context

    assert extract_plan_from_context([]) is None
    assert extract_plan_from_context([{"metadata": {"toolName": "web_search"}}]) is None


def test_extract_plan_from_context_ignores_in_progress():
    """extract_plan_from_context ignores set_plan that is not FINISHED."""
    from loop.dag_executor import extract_plan_from_context

    context = [
        {"metadata": {"toolName": "set_plan", "toolStatus": "IN_PROGRESS", "data": {"tasks": []}}},
    ]
    assert extract_plan_from_context(context) is None


def _plan_followup_context(*, include_final_summary: bool, later_user: bool, final_summary_flag: bool = True):
    messages = [
        {"role": "USER", "text": "order me glide floss from doordash", "metadata": None},
        {
            "role": "TOOL",
            "text": "plan",
            "metadata": {
                "toolName": "set_plan",
                "toolStatus": "FINISHED",
                "data": {"tasks": [{"goal": "x", "tool_name": "spawn_explore_agent"}]},
            },
        },
    ]
    if include_final_summary:
        messages.append(
            {
                "role": "TOOL",
                "text": "done",
                "metadata": {
                    "toolName": "completion_summary",
                    "toolStatus": "FINISHED",
                    "isFinalSummary": final_summary_flag,
                },
            }
        )
    if later_user:
        messages.append(
            {
                "role": "USER",
                "text": "get a refund, the doordasher delivered to the wrong location",
                "metadata": None,
            }
        )
    return messages


def test_plan_superseded_by_user_after_final_summary():
    """USER after Task Complete makes the historical plan stale."""
    from loop.dag_executor import plan_superseded_by_new_user_instruction

    assert plan_superseded_by_new_user_instruction(_plan_followup_context(include_final_summary=True, later_user=True))


def test_plan_superseded_by_final_summary_without_later_user():
    """Task Complete alone makes the historical plan stale for a new execute."""
    from loop.dag_executor import plan_superseded_by_new_user_instruction

    assert plan_superseded_by_new_user_instruction(_plan_followup_context(include_final_summary=True, later_user=False))


def test_plan_superseded_by_user_after_set_plan_without_summary():
    """FAILED / credit-kill follow-up after set_plan stales the DAG without Task Complete."""
    from loop.dag_executor import plan_superseded_by_new_user_instruction

    assert plan_superseded_by_new_user_instruction(_plan_followup_context(include_final_summary=False, later_user=True))


def test_plan_not_superseded_by_hidden_user_after_set_plan():
    """Schema-refresh USER rows do not stale a live incomplete plan."""
    from loop.dag_executor import plan_superseded_by_new_user_instruction

    context = _plan_followup_context(include_final_summary=False, later_user=False)
    context.append(
        {
            "role": "USER",
            "text": "generated schema",
            "metadata": {"hidden": True, "isResponseSchemaUpdate": True},
        }
    )
    assert not plan_superseded_by_new_user_instruction(context)


def test_plan_not_superseded_by_non_final_summary_without_later_user():
    """A non-final completion_summary without a later USER leaves the plan live."""
    from loop.dag_executor import plan_superseded_by_new_user_instruction

    assert not plan_superseded_by_new_user_instruction(
        _plan_followup_context(include_final_summary=True, later_user=False, final_summary_flag=False)
    )


def test_latest_real_user_instruction_skips_hidden_schema_updates():
    """Hidden schema-refresh USER rows are not the latest real instruction."""
    from loop.dag_executor import latest_real_user_instruction

    context = _plan_followup_context(include_final_summary=True, later_user=True)
    context.append(
        {
            "role": "USER",
            "text": "generated schema",
            "metadata": {"hidden": True, "isResponseSchemaUpdate": True},
        }
    )
    assert latest_real_user_instruction(context) == "get a refund, the doordasher delivered to the wrong location"


def test_latest_real_user_instruction_empty():
    from loop.dag_executor import latest_real_user_instruction

    assert latest_real_user_instruction([]) is None
    assert latest_real_user_instruction([{"role": "TOOL", "text": "done", "metadata": {}}]) is None


def _raw_history_with_compaction_checkpoint(*, followup: str) -> list[dict]:
    """First-run history that compacted, then completed, then a new USER.

    The huge raw tool dump must not re-enter the next root run. Polling
    projects from the latest context_reset and keeps the post-checkpoint tail.
    """
    from helpers.context_compaction import build_context_compaction_metadata

    compressed = [
        {"role": "USER", "text": "order me glide floss from doordash", "metadata": {}},
        {
            "role": "USER",
            "text": "Compaction summary: ordered Oral-B Glide floss on DoorDash; confirmation dff187de.",
            "metadata": {"compactionSummary": True},
        },
        {
            "role": "TOOL",
            "text": "Plan created",
            "metadata": {
                "toolName": "set_plan",
                "toolStatus": "FINISHED",
                "data": {
                    "type": "plan_artifact",
                    "join": "all",
                    "tasks": [
                        {
                            "goal": "Research the public DoorDash shopping route for ordering floss.",
                            "tool_name": "spawn_explore_agent",
                        }
                    ],
                    "dependencies": {},
                },
            },
        },
    ]
    return [
        {"role": "USER", "text": "order me glide floss from doordash", "metadata": {}},
        {
            "role": "TOOL",
            "text": "Very large raw tool output from the first DoorDash order run",
            "metadata": {},
        },
        {
            "role": "TOOL",
            "text": "Context compressed — continuing with summarized history.",
            "metadata": {
                "toolName": "context_reset",
                "toolStatus": "FINISHED",
                "contextCompaction": build_context_compaction_metadata(compressed),
            },
        },
        {
            "role": "TOOL",
            "text": "Your DoorDash order is confirmed.",
            "metadata": {
                "toolName": "completion_summary",
                "toolStatus": "FINISHED",
                "isFinalSummary": True,
            },
        },
        {"role": "USER", "text": followup, "metadata": None},
    ]


def test_followup_after_compaction_projects_last_checkpoint_and_stales_plan():
    """A later root run must resume the last compression, not the raw first-run dump."""
    from helpers.context_compaction import project_model_context_after_compaction
    from loop.dag_executor import (
        extract_plan_from_context,
        latest_real_user_instruction,
        plan_superseded_by_new_user_instruction,
    )

    followup = "get a refund, the doordasher delivered to the wrong location"
    raw = _raw_history_with_compaction_checkpoint(followup=followup)
    projected = project_model_context_after_compaction(raw)

    assert all(m.get("text") != "Very large raw tool output from the first DoorDash order run" for m in projected)
    assert any((m.get("metadata") or {}).get("compactionSummary") for m in projected)
    assert any((m.get("metadata") or {}).get("contextCompactionBoundary") for m in projected)
    assert latest_real_user_instruction(projected) == followup
    assert extract_plan_from_context(projected) is not None
    assert plan_superseded_by_new_user_instruction(projected)


def test_tool_aliases_constants():
    """TOOL_ALIASES and ALIAS_TYPE_OVERRIDES are correctly defined."""
    from loop.dag_executor import ALIAS_TYPE_OVERRIDES, TOOL_ALIASES

    assert TOOL_ALIASES["spawn_explore_agent"] == "spawn_agent"
    assert TOOL_ALIASES["spawn_browser_agent"] == "spawn_agent"
    assert TOOL_ALIASES["wait_seconds"] == "wait_for"
    assert ALIAS_TYPE_OVERRIDES["spawn_explore_agent"] == {"type": "explore"}
    assert ALIAS_TYPE_OVERRIDES["spawn_browser_agent"] == {"type": "browser"}
    assert ALIAS_TYPE_OVERRIDES["spawn_code_agent"] == {"type": "code"}
    # general_purpose/for_each REQUIRE start_phase — the alias must supply it or
    # SpawnAgentTool validation rejects the DAG-resolved call.
    assert ALIAS_TYPE_OVERRIDES["spawn_general_purpose_agent"] == {
        "type": "general_purpose",
        "start_phase": "EXECUTE",
    }
    assert ALIAS_TYPE_OVERRIDES["spawn_general_purpose_agent_for_each"] == {
        "type": "for_each",
        "start_phase": "EXECUTE",
    }


def test_dag_foreach_alias_override_passes_spawn_agent_validation():
    """Regression: a DAG for_each/general_purpose task, after alias type-override,
    must produce a spawn_agent call that passes SpawnAgentTool validation.

    Repro of the prod failure: `spawn_general_purpose_agent_for_each` resolved to
    spawn_agent with only {'type': 'for_each'} → start_phase=None →
    'start_phase is required when type=...for_each'. The override must include
    start_phase so the DAG task fans out instead of failing.
    """
    from loop.dag_executor import ALIAS_TYPE_OVERRIDES, _apply_alias_override
    from utils.tool_schemas import SpawnAgentTool

    for alias, agent_type in (
        ("spawn_general_purpose_agent_for_each", "for_each"),
        ("spawn_general_purpose_agent", "general_purpose"),
    ):
        # Simulate the param-populator output + the alias override, exactly as
        # execute_dag does via params.update(type_override). The populator omits
        # start_phase (that was the prod bug); the override must supply it.
        params = {
            "tool": "spawn_agent",
            "goal": "Analyze one creator",
            "start_phase": None,
            "output_schema": {"fields": [{"name": "summary", "type": "str", "required": True}]},
        }
        if agent_type == "for_each":
            params["items"] = ["creator-a", "creator-b"]

        # Old override ({"type": ...} only) reproduces the prod failure:
        # type is set but start_phase is not → SpawnAgentTool rejects it.
        raised = False
        try:
            SpawnAgentTool(**{**params, "type": agent_type, "task_name": "creator"})
        except Exception as exc:  # pydantic ValidationError (not a ValueError subclass)
            raised = True
            assert "start_phase is required" in str(exc), str(exc)
        assert raised, "expected start_phase validation error with the old type-only override"

        # Fill-when-missing: no populator start_phase → alias default EXECUTE,
        # and the resolved call validates.
        filled = _apply_alias_override(dict(params), alias)
        tool = SpawnAgentTool(**filled)
        assert tool.type == agent_type
        assert tool.start_phase == "EXECUTE"
        # task_name (required) is filled deterministically from the goal + task number.
        assert tool.task_name == "analyze_one_creator_1"
        assert _apply_alias_override(dict(params), alias, 4)["task_name"] == "analyze_one_creator_5"
        assert _apply_alias_override({**params, "task_name": "mine"}, alias)["task_name"] == "mine"

        # Preserve: a populator-chosen start_phase must NOT be overwritten (keeps
        # already-cached fan-out children on their existing keys).
        preserved = _apply_alias_override({**params, "start_phase": "PLAN"}, alias)
        assert preserved["start_phase"] == "PLAN"
        assert SpawnAgentTool(**preserved).start_phase == "PLAN"


def test_build_param_population_message_basic():
    """Param-populator prompt anchors the call to a numbered plan task."""
    from loop.dag_executor import _build_param_population_message

    msg = _build_param_population_message(3, "Search for restaurants", "web_search")
    assert msg == (
        "Please execute task 3 of the plan: Search for restaurants\n\n"
        "You MUST call exactly one tool: `web_search`. Do not respond with text only."
    )


def test_build_param_population_message_spawn_preserves_outer_alias_contract():
    """Every spawn alias reaches the populator with its discriminator and required fields."""
    from loop.dag_executor import ALIAS_TYPE_OVERRIDES, _build_param_population_message

    required_fields = {
        "spawn_explore_agent": [],
        "spawn_browser_agent": ["start_url", "output_schema"],
        "spawn_code_agent": ["output_schema"],
        "spawn_general_purpose_agent": ["start_phase", "output_schema"],
        "spawn_general_purpose_agent_for_each": ["start_phase", "output_schema", "items"],
    }
    assert set(required_fields) == set(ALIAS_TYPE_OVERRIDES)

    for alias, override in ALIAS_TYPE_OVERRIDES.items():
        msg = _build_param_population_message(
            1,
            (
                "Find the current population of Tokyo. The general-purpose child MUST use "
                "an explore agent for web research and return only the numeric population."
            ),
            "spawn_agent",
            planned_tool_name=alias,
        )

        assert f"outer planned alias `{alias}`" in msg
        assert f'`type="{override["type"]}"`' in msg
        assert "MUST call exactly one tool: `spawn_agent`" in msg
        for field_name in required_fields[alias]:
            assert field_name in msg

        if alias == "spawn_general_purpose_agent":
            assert "inside the child goal" in msg


def test_build_param_population_message_non_spawn_no_extra():
    """Non-spawn tool does not include spawn-specific warnings."""
    from loop.dag_executor import _build_param_population_message

    msg = _build_param_population_message(4, "Wait 10s", "wait_for")
    assert "NO access to your conversation" not in msg
    assert "SPAWN TYPE" not in msg


def test_select_param_tool_call_requires_exactly_one_call():
    """Param population rejects multiple calls instead of guessing which one to execute."""
    import pytest

    from loop.dag_executor import DAGTask, _select_param_tool_call

    task = DAGTask(
        index=1,
        goal="Find the current population of New York City using explore-agent web research.",
        tool_name="spawn_general_purpose_agent",
    )
    with pytest.raises(ValueError, match="exactly one tool call"):
        _select_param_tool_call(
            [
                {"tool": "spawn_agent", "goal": "Find the current population of Tokyo."},
                {"tool": "spawn_agent", "goal": "Find the current population of New York City."},
            ],
            "spawn_agent",
            task,
        )


def test_select_param_tool_call_rejects_wrong_single_tool():
    """A single call to a different tool still fails validation."""
    import pytest

    from loop.dag_executor import DAGTask, _select_param_tool_call

    task = DAGTask(index=0, goal="Find a population figure.", tool_name="spawn_general_purpose_agent")

    with pytest.raises(ValueError, match="expected spawn_agent, got web_search"):
        _select_param_tool_call(
            [{"tool": "web_search", "query": "Find a population figure."}],
            "spawn_agent",
            task,
        )


def test_select_param_tool_call_rejects_wrong_alias_types():
    """Every spawn alias rejects a different agent variant before override."""
    import pytest

    from loop.dag_executor import ALIAS_TYPE_OVERRIDES, DAGTask, _select_param_tool_call

    wrong_types = {
        "explore": "browser",
        "browser": "code",
        "code": "general_purpose",
        "general_purpose": "explore",
        "for_each": "explore",
    }
    for alias, override in ALIAS_TYPE_OVERRIDES.items():
        expected_type = override["type"]
        wrong_type = wrong_types[expected_type]
        task = DAGTask(index=1, goal=f"Run {alias}.", tool_name=alias)
        with pytest.raises(
            ValueError,
            match=f"expected spawn_agent type {expected_type}, got {wrong_type}",
        ):
            _select_param_tool_call(
                [{"tool": "spawn_agent", "type": wrong_type, "goal": task.goal}],
                "spawn_agent",
                task,
            )


async def _run_execute_dag(
    plan_data,
    model="rose-flash",
    execute_tool_impl=None,
    reasoning_result=None,
    param_tool_calls=None,
    param_usage=None,
    execute_activity_calls=None,
    pending_context_seen=None,
    context=None,
    **execute_dag_kwargs,
):
    """Helper: run execute_dag with mocked execute_activity that returns canned data."""
    from helpers.llm import _pending_llm_context
    from loop.dag_executor import TaskDAG, execute_dag

    dag = TaskDAG(plan_data)

    events: list = []

    async def post_message(text, role, metadata):
        events.append({"type": "post_message", "text": text, "role": role, "metadata": metadata})

    async def handle_tool_event_fn(event, tool_call_id, tool_name):
        events.append(
            {
                "type": "tool_event",
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "status": event.status.value if event.status else None,
                "title": event.title,
                "message": event.message,
                "metadata": event.metadata or {},
            }
        )

    if execute_tool_impl is None:

        async def execute_tool(name, params, tool_call_id):
            return {"message": f"{name} done"}

        execute_tool_impl = execute_tool

    async def execute_activity(fn, args=None, **kwargs):
        if execute_activity_calls is not None:
            execute_activity_calls.append(
                {"fn": getattr(fn, "__name__", "") or str(fn), "args": args, "kwargs": kwargs}
            )
        fn_name = getattr(fn, "__name__", "") or str(fn)
        if "reasoning" in fn_name:
            return reasoning_result or {"content": "reasoning output", "usage": {}}
        # call_llm_activity for param population — return tool_calls format
        tool_name = args[11] if args and len(args) > 11 else "unknown"
        if param_tool_calls is not None and args and args[8] == "dag_param_populator":
            if pending_context_seen is not None:
                pending_context_seen.append(args[0] in _pending_llm_context)
                # Model call_llm_activity's successful cleanup so a local retry
                # proves the DAG restores the same-machine context snapshot.
                _pending_llm_context.pop(args[0], None)
            tool_calls = param_tool_calls(args)
        else:
            tool_calls = [{"tool": tool_name, "query": "x"}]
        usage = param_usage(args) if callable(param_usage) else (param_usage or {})
        return {
            "response": "",
            "tool_calls": tool_calls,
            "usage": usage,
            "detected_tools_ordered": [],
        }

    # Patch workflow.logger (only valid inside workflow event loop) with a stub
    fake_logger = MagicMock()
    with patch("loop.dag_executor.workflow.logger", fake_logger):
        result = await execute_dag(
            dag=dag,
            agent_id="agent-1",
            user_id="user-1",
            model=model,
            context=list(context or []),
            execute_activity=execute_activity,
            post_message=post_message,
            execute_tool=execute_tool_impl,
            handle_tool_event_fn=handle_tool_event_fn,
            system_prompt_text="test system prompt",
            tool_names=["web_search", "spawn_agent", "attempt_completion"],
            **execute_dag_kwargs,
        )

    _pending_llm_context.pop("agent-1", None)

    return result, events, dag


async def test_execute_dag_reasoning_task_succeeds():
    """execute_dag runs reasoning task and merges the result as an assistant turn."""
    plan_data = {
        "tasks": [{"goal": "Summarize findings", "tool_name": "reasoning"}],
        "dependencies": {},
    }

    result, events, dag = await _run_execute_dag(
        plan_data, reasoning_result={"content": "Summary text", "usage": {"prompt_tokens": 10, "completion_tokens": 20}}
    )

    assert result["status"] == "completed"
    assistant_posts = [e for e in events if e["type"] == "post_message" and e["role"] == "ASSISTANT"]
    assert len(assistant_posts) == 1
    assert assistant_posts[0]["text"] == "Summary text"
    metadata = assistant_posts[0]["metadata"]
    assert metadata["dagTaskIndex"] == 0
    assert metadata["plannedToolName"] == "reasoning"
    assert metadata["streamId"].startswith("dag-reasoning-0-")
    assert metadata["firstTimestamp"] == metadata["startedAt"]
    datetime.fromisoformat(metadata["firstTimestamp"])
    thought_events = [e for e in events if e["type"] == "tool_event" and e["tool_name"] == "thought"]
    reasoning_events = [e for e in events if e["type"] == "tool_event" and e["tool_name"] == "reasoning"]
    assert thought_events == []
    assert reasoning_events == []
    assert dag.tasks[0].state.value == "COMPLETED"


async def test_execute_dag_reasoning_forwards_gpt_token():
    """execute_dag forwards the selected GPT compute token into reasoning activity."""
    plan_data = {
        "tasks": [{"goal": "Summarize findings", "tool_name": "reasoning"}],
        "dependencies": {},
    }
    calls = []

    result, _events, _dag = await _run_execute_dag(
        plan_data,
        reasoning_result={"content": "Summary text", "usage": {}},
        execute_activity_calls=calls,
        gpt_token="gpt-access",
        gpt_account_id="acct-1",
        gpt_token_source="user",
        gpt_token_pool_id=None,
    )

    assert result["status"] == "completed"
    reasoning_call = next(c for c in calls if "reasoning" in c["fn"])
    args = reasoning_call["args"]
    assert args[9] == "gpt-access"
    assert args[10] == "acct-1"
    assert args[11] == "user"
    assert args[13] == "user-1"
    assert args[-1] == "test system prompt"


async def test_execute_dag_tool_task_succeeds():
    """execute_dag runs tool task via execute_tool and marks complete."""
    plan_data = {
        "tasks": [{"goal": "Do search", "tool_name": "web_search"}],
        "dependencies": {},
    }

    calls = []

    async def execute_tool(name, params, tool_call_id):
        calls.append((name, params, tool_call_id))
        return {"message": "OK"}

    result, events, dag = await _run_execute_dag(plan_data, execute_tool_impl=execute_tool)

    assert result["status"] == "completed"
    assert calls[0][0] == "web_search"
    assert dag.tasks[0].state.value == "COMPLETED"


async def test_execute_dag_tool_llm_activity_args_match_signature():
    """The productive param call uses the full execute schema and writes the reusable prefix."""
    from helpers.llm import call_llm_activity

    plan_data = {
        "tasks": [{"goal": "Do search", "tool_name": "web_search"}],
        "dependencies": {},
    }
    calls = []

    result, _events, _dag = await _run_execute_dag(
        plan_data,
        model="rose-fast",
        execute_activity_calls=calls,
        claude_token="claude-access",
        claude_token_source="user",
        claude_token_pool_id="pool-1",
        gpt_token="gpt-access",
        gpt_account_id="acct-1",
        gpt_token_source="compute",
        gpt_token_pool_id="gpt-pool-1",
    )

    assert result["status"] == "completed"

    llm_calls = [c for c in calls if c["fn"] == "call_llm_activity"]
    assert len(llm_calls) == 1

    max_positional = len(
        [
            p
            for p in inspect.signature(call_llm_activity).parameters.values()
            if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
        ]
    )
    assert all(len(c["args"]) <= max_positional for c in llm_calls)

    param_args = llm_calls[0]["args"]
    assert param_args[1] == "rose-fast"
    assert param_args[2] == ["web_search", "spawn_agent", "attempt_completion"]
    assert param_args[8] == "dag_param_populator"
    assert param_args[9] == "test system prompt"
    assert param_args[11] == "web_search"
    assert param_args[12] is True
    assert param_args[13] == ""
    assert param_args[14] == "user"
    assert param_args[15] == "pool-1"
    assert param_args[16] == "user-1"
    assert param_args[17] == "gpt-access"
    assert param_args[18] == "acct-1"
    assert param_args[19] == "compute"
    assert param_args[20] == "gpt-pool-1"
    assert param_args[21] == "user-1"
    assert param_args[22] is None
    assert param_args[23] is None
    assert param_args[24] == "user-1"
    assert param_args[28] is False
    assert param_args[29] is True
    assert param_args[30] == "agent:agent-1:task:0:call:dag_param_populator"


async def test_execute_dag_param_populator_never_adopts_a_stale_pending_context_slot():
    """DAG param population must build ITS node's conversation, never a stale same-agent slot.

    REGRESSION (2026-10-02, test-mass-agent-run-0): `_pending_llm_context` is keyed
    only by agent_id and outlives a workflow that migrates to another worker. The
    param populator wrote untagged slots and called call_llm_activity without a
    token, so a slot left on a worker by another node (or by this workflow before it
    migrated) was adopted as this node's prompt. The node's slot is now tagged with
    its replay-stable tool_call_id and the activity receives the same token.
    """
    import json
    from types import SimpleNamespace

    from helpers.llm import _pending_llm_context, call_llm_activity

    calls: list = []
    slots_at_call: list = []
    node_context = [{"role": "USER", "text": "DAG-NODE-CONTEXT", "timestamp": "2026-10-02T00:00:00Z"}]

    def param_tool_calls(args):
        slots_at_call.append(_pending_llm_context.get(args[0]))
        return [{"tool": "web_search", "query": "x"}]

    result, _events, _dag = await _run_execute_dag(
        {"tasks": [{"goal": "Search", "tool_name": "web_search"}], "dependencies": {}},
        param_tool_calls=param_tool_calls,
        execute_activity_calls=calls,
        context=node_context,
    )
    assert result["status"] == "completed"
    param_args = next(c["args"] for c in calls if c["args"] and c["args"][8] == "dag_param_populator")
    params = list(inspect.signature(call_llm_activity).parameters)
    token = param_args[params.index("pending_context_token")] if len(param_args) > 32 else None
    assert isinstance(token, str) and token.startswith("dag:"), f"param call carries no context token: {token!r}"
    assert slots_at_call and slots_at_call[0][4] == token, "the DAG slot must carry the token passed to the activity"

    sent: list = []
    backend = AsyncMock(
        return_value={
            "agent": {"id": "agent-1"},
            "messages": [{"role": "USER", "text": "BACKEND-CONTEXT", "timestamp": "2026-10-02T00:00:00Z"}],
        }
    )

    async def capture_llm(**kwargs):
        sent.append(json.dumps(kwargs["messages"]))
        return (
            SimpleNamespace(
                response="",
                tool_calls=[SimpleNamespace(model_dump=lambda: {"tool": "web_search", "query": "x"})],
            ),
            {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            [],
        )

    stale_context = [{"role": "USER", "text": "STALE-OTHER-NODE-CONTEXT", "timestamp": "2026-10-02T00:00:00Z"}]
    stale_slots = {
        "legacy untagged slot": (stale_context, "test system prompt", None),
        "another node's tagged slot": (stale_context, "test system prompt", None, "user-1", "dag:other-node"),
    }
    try:
        with (
            patch("helpers.llm.call_llm_structured_streaming", new=AsyncMock(side_effect=capture_llm)),
            patch("helpers.fetch_config._fetch_agent_data_impl", new=backend),
            patch("helpers.llm.asyncio.sleep", new=AsyncMock()),
            patch("temporalio.activity.heartbeat"),
            patch("helpers.llm.activity.in_activity", return_value=False),
        ):
            for label, stale in stale_slots.items():
                _pending_llm_context["agent-1"] = stale
                await call_llm_activity(*param_args)
                assert "STALE-OTHER-NODE-CONTEXT" not in sent[-1], f"param call adopted a {label}"
                assert "BACKEND-CONTEXT" in sent[-1], f"{label}: a token mismatch must refetch canonical context"

            # Same worker: the node's own slot is used without a backend round trip.
            fetches_before = backend.await_count
            _pending_llm_context["agent-1"] = slots_at_call[0]
            await call_llm_activity(*param_args)
            assert "DAG-NODE-CONTEXT" in sent[-1]
            assert backend.await_count == fetches_before
    finally:
        _pending_llm_context.pop("agent-1", None)


async def test_execute_dag_alias_resolution_spawn_explore():
    """execute_dag resolves spawn_explore_agent alias to spawn_agent and applies type override."""
    plan_data = {
        "tasks": [{"goal": "Explore stuff", "tool_name": "spawn_explore_agent"}],
        "dependencies": {},
    }

    recorded = []

    async def execute_tool(name, params, tool_call_id):
        recorded.append((name, dict(params)))
        return {"message": "explored"}

    result, events, dag = await _run_execute_dag(
        plan_data,
        execute_tool_impl=execute_tool,
        param_tool_calls=lambda _args: [
            {"tool": "spawn_agent", "type": "explore", "goal": "Explore stuff", "depth": "quick"}
        ],
    )

    assert result["status"] == "completed"
    assert recorded[0][0] == "spawn_agent"
    # type override applied
    assert recorded[0][1].get("type") == "explore"
    early = [e for e in events if e["type"] == "tool_event" and e["status"] == "IN_PROGRESS"][0]
    assert early["tool_name"] == "spawn_agent"
    assert early["title"] == "Exploring"
    assert early["metadata"]["agentType"] == "explore"
    assert early["metadata"]["taskId"] == early["tool_call_id"]
    assert early["metadata"]["fullGoal"] == "Explore stuff"


async def test_execute_dag_code_alias_forwards_github_repo_ref_and_explore_strips_it():
    """A planned code spawn keeps its explicit github_repo_ref; a planned explore drops it."""
    schema = {"fields": [{"name": "result", "type": "str", "required": True, "properties": []}]}
    plan_data = {
        "tasks": [
            {"goal": "Fix the bug", "tool_name": "spawn_code_agent"},
            {"goal": "Explore stuff", "tool_name": "spawn_explore_agent"},
        ],
        "dependencies": {},
    }

    recorded = []

    async def execute_tool(name, params, tool_call_id):
        recorded.append((name, dict(params)))
        return {"message": "done"}

    def param_tool_calls(args):
        common = {"tool": "spawn_agent", "github_repo_ref": "gh:rose-ai-labs/rose"}
        if "Fix the bug" in str(args[10]):
            return [{**common, "type": "code", "task_name": "fix_bug", "goal": "Fix the bug", "output_schema": schema}]
        return [{**common, "type": "explore", "goal": "Explore stuff", "depth": "quick"}]

    result, _events, _dag = await _run_execute_dag(
        plan_data, execute_tool_impl=execute_tool, param_tool_calls=param_tool_calls
    )

    assert result["status"] == "completed"
    by_type = {params["type"]: params for _name, params in recorded}
    assert by_type["code"]["github_repo_ref"] == "gh:rose-ai-labs/rose", by_type
    assert "github_repo_ref" not in by_type["explore"], by_type


async def test_execute_dag_repairs_stale_cached_explore_alias_without_live_retry():
    """A stale cached for_each slot cannot force an explore node into a live call."""
    plan_data = {
        "tasks": [{"goal": "Research platform benchmarks", "tool_name": "spawn_explore_agent"}],
        "dependencies": {},
    }
    recorded = []
    activity_calls = []

    async def execute_tool(name, params, tool_call_id):
        recorded.append((name, dict(params), tool_call_id))
        return {"message": "spawned"}

    result, _events, _dag = await _run_execute_dag(
        plan_data,
        execute_tool_impl=execute_tool,
        param_tool_calls=lambda _args: [
            {
                "tool": "spawn_agent",
                "type": "for_each",
                "goal": "analyze every creator",
                "items": ["a"],
            }
        ],
        param_usage={"from_fast_cache": True},
        execute_activity_calls=activity_calls,
    )

    assert result["status"] == "completed"
    param_calls = [call for call in activity_calls if call["args"] and call["args"][8] == "dag_param_populator"]
    assert len(param_calls) == 1
    assert [(name, params["type"], params["goal"]) for name, params, _id in recorded] == [
        ("spawn_agent", "explore", "Research platform benchmarks")
    ]


async def test_execute_dag_wait_for_emits_early_wait_chip():
    """wait_for emits a pre-param-populator IN_PROGRESS using the final tool_call_id."""
    plan_data = {
        "tasks": [{"goal": "Wait until the report is ready", "tool_name": "wait_for"}],
        "dependencies": {},
    }

    recorded = []

    async def execute_tool(name, params, tool_call_id):
        recorded.append((name, params, tool_call_id))
        return {"message": "wait done"}

    result, events, dag = await _run_execute_dag(plan_data, execute_tool_impl=execute_tool)

    assert result["status"] == "completed"
    assert recorded[0][0] == "wait_for"
    early = [e for e in events if e["type"] == "tool_event" and e["status"] == "IN_PROGRESS"][0]
    assert early["tool_name"] == "wait_for"
    assert early["title"] == "Preparing wait"
    assert early["message"] == "Wait until the report is ready"
    assert early["tool_call_id"] == recorded[0][2]
    assert dag.tasks[0].tool_call_id == recorded[0][2]


async def test_execute_dag_general_purpose_spawn_emits_subagent_placeholder():
    """general-purpose spawn emits the frontend-facing sub-agent placeholder before params."""
    plan_data = {
        "tasks": [{"goal": "Delegate the implementation", "tool_name": "spawn_general_purpose_agent"}],
        "dependencies": {},
    }

    recorded = []

    async def execute_tool(name, params, tool_call_id):
        recorded.append((name, params, tool_call_id))
        return {"message": "spawned"}

    result, events, dag = await _run_execute_dag(
        plan_data,
        execute_tool_impl=execute_tool,
        param_tool_calls=lambda _args: [
            {
                "tool": "spawn_agent",
                "type": "general_purpose",
                "goal": "Delegate the implementation",
                "start_phase": "EXECUTE",
                "output_schema": {"fields": [{"name": "result", "type": "str", "required": True, "properties": []}]},
            }
        ],
    )

    assert result["status"] == "completed"
    assert recorded[0][0] == "spawn_agent"
    assert recorded[0][1].get("type") == "general_purpose"
    early = [e for e in events if e["type"] == "tool_event" and e["status"] == "IN_PROGRESS"][0]
    assert early["tool_name"] == "spawn_general_purpose_agent"
    assert early["title"] == "Spawning sub-agent"
    assert early["message"] == ""
    assert early["tool_call_id"] == recorded[0][2]
    assert early["metadata"]["spawnGroupId"] == recorded[0][2]
    assert recorded[0][1]["_spawn_group_id"] == recorded[0][2]
    assert dag.tasks[0].tool_call_id == recorded[0][2]


async def test_execute_dag_retries_wrong_spawn_alias_type_before_execution():
    """The captured nested-explore conflict is repaired using corrective retry text."""
    captured_goal = (
        "Find the current population of New York City. The general-purpose child MUST use "
        "an explore agent for web research and return only the numeric population."
    )
    plan_data = {
        "tasks": [{"goal": captured_goal, "tool_name": "spawn_general_purpose_agent"}],
        "dependencies": {},
    }

    prompts = []
    recorded = []
    activity_calls = []

    def param_tool_calls(args):
        prompt = args[10]
        prompts.append(prompt)
        if "Previous attempt violated the planned tool contract" not in prompt:
            return [{"tool": "spawn_agent", "type": "explore", "goal": captured_goal}]
        return [
            {
                "tool": "spawn_agent",
                "type": "general_purpose",
                "goal": captured_goal,
                "start_phase": "EXECUTE",
                "output_schema": {
                    "fields": [{"name": "population", "type": "int", "required": True, "properties": []}]
                },
            }
        ]

    async def execute_tool(name, params, tool_call_id):
        recorded.append((name, dict(params), tool_call_id))
        return {"message": "spawned"}

    result, events, dag = await _run_execute_dag(
        plan_data,
        execute_tool_impl=execute_tool,
        param_tool_calls=param_tool_calls,
        param_usage={"from_fast_cache": True},
        execute_activity_calls=activity_calls,
    )

    assert result["status"] == "completed"
    assert len(prompts) == 2
    assert "outer planned alias `spawn_general_purpose_agent`" in prompts[0]
    assert "expected spawn_agent type general_purpose, got explore" in prompts[1]
    assert prompts[0] != prompts[1]
    param_calls = [call for call in activity_calls if call["args"] and call["args"][8] == "dag_param_populator"]
    assert [call["args"][27] for call in param_calls] == [0, None]
    assert len(recorded) == 1
    assert recorded[0][0] == "spawn_agent"
    assert recorded[0][1]["type"] == "general_purpose"
    assert recorded[0][1]["_spawn_group_id"] == recorded[0][2]
    assert dag.tasks[0].state.value == "COMPLETED"
    early = [e for e in events if e["type"] == "tool_event" and e["status"] == "IN_PROGRESS"]
    assert len(early) == 1


async def test_execute_dag_parallel_spawn_alias_retry_has_exactly_two_side_effects():
    """Parallel Tokyo/NYC nodes execute once each when NYC needs a contract retry."""
    plan_data = {
        "tasks": [
            {"goal": "Research Tokyo", "tool_name": "spawn_general_purpose_agent"},
            {"goal": "Research New York City", "tool_name": "spawn_general_purpose_agent"},
        ],
        "dependencies": {},
    }
    attempts = {"Tokyo": 0, "New York City": 0}
    recorded = []
    pending_context_seen = []

    def param_tool_calls(args):
        city = "Tokyo" if "Tokyo" in args[10] else "New York City"
        attempts[city] += 1
        if city == "New York City" and attempts[city] == 1:
            return [{"tool": "spawn_agent", "type": "explore", "goal": f"Research {city}"}]
        return [
            {
                "tool": "spawn_agent",
                "type": "general_purpose",
                "goal": f"Research {city}",
                "start_phase": "EXECUTE",
                "output_schema": {
                    "fields": [{"name": "population", "type": "int", "required": True, "properties": []}]
                },
            }
        ]

    async def execute_tool(name, params, tool_call_id):
        recorded.append((name, params["goal"], tool_call_id))
        return {"message": "spawned"}

    result, _events, dag = await _run_execute_dag(
        plan_data,
        execute_tool_impl=execute_tool,
        param_tool_calls=param_tool_calls,
        pending_context_seen=pending_context_seen,
    )

    assert result["status"] == "completed"
    assert attempts == {"Tokyo": 1, "New York City": 2}
    assert sorted(goal for _name, goal, _id in recorded) == ["Research New York City", "Research Tokyo"]
    assert len(recorded) == 2
    assert all(pending_context_seen)
    assert all(task.state.value == "COMPLETED" for task in dag.tasks)


async def test_execute_dag_exhausted_alias_retry_never_replays_committed_sibling():
    """An exhausted NYC contract stops after Tokyo's one committed spawn."""
    plan_data = {
        "tasks": [
            {"goal": "Research Tokyo", "tool_name": "spawn_general_purpose_agent"},
            {"goal": "Research New York City", "tool_name": "spawn_general_purpose_agent"},
        ],
        "dependencies": {},
    }
    attempts = {"Tokyo": 0, "New York City": 0}
    recorded = []
    token_calls = []
    pending_context_seen = []

    def param_tool_calls(args):
        city = "Tokyo" if "Tokyo" in args[10] else "New York City"
        attempts[city] += 1
        if city == "New York City":
            return [{"tool": "spawn_agent", "type": "explore", "goal": f"Research {city}"}]
        return [
            {
                "tool": "spawn_agent",
                "type": "general_purpose",
                "goal": f"Research {city}",
                "start_phase": "EXECUTE",
                "output_schema": {
                    "fields": [{"name": "population", "type": "int", "required": True, "properties": []}]
                },
            }
        ]

    async def execute_tool(name, params, tool_call_id):
        recorded.append((name, params["goal"], tool_call_id))
        return {"message": "spawned"}

    async def on_tokens(prompt_tokens, completion_tokens, model, **kwargs):
        token_calls.append((prompt_tokens, completion_tokens, model, kwargs["call_site"], kwargs["cache_sequence_id"]))

    result, _events, dag = await _run_execute_dag(
        plan_data,
        execute_tool_impl=execute_tool,
        param_tool_calls=param_tool_calls,
        param_usage={
            "prompt_tokens": 10,
            "completion_tokens": 2,
            "actual_model": "test-model",
            "cache_sequence_id": "agent:agent-1:task:0:call:dag_param_populator",
        },
        pending_context_seen=pending_context_seen,
        on_tokens=on_tokens,
    )

    assert result["status"] == "needs_llm"
    assert attempts == {"Tokyo": 1, "New York City": 2}
    assert [(name, goal) for name, goal, _id in recorded] == [("spawn_agent", "Research Tokyo")]
    assert len(token_calls) == 3
    assert all(
        call
        == (
            10,
            2,
            "test-model",
            "dag_param_populator",
            "agent:agent-1:task:0:call:dag_param_populator",
        )
        for call in token_calls
    )
    assert all(pending_context_seen)
    assert dag.tasks[1].state.value == "FAILED"


async def test_execute_dag_validates_overridden_spawn_payload_before_execution():
    """Canonical SpawnAgentTool constraints run after alias override and before spawn."""
    plan_data = {
        "tasks": [{"goal": "Research Tokyo", "tool_name": "spawn_general_purpose_agent"}],
        "dependencies": {},
    }
    recorded = []

    async def execute_tool(name, params, tool_call_id):
        recorded.append((name, params, tool_call_id))
        return {"message": "spawned"}

    result, _events, dag = await _run_execute_dag(
        plan_data,
        execute_tool_impl=execute_tool,
        param_tool_calls=lambda _args: [{"tool": "spawn_agent", "type": "general_purpose", "goal": "Research Tokyo"}],
    )

    assert result["status"] == "needs_llm"
    assert recorded == []
    assert dag.tasks[0].state.value == "FAILED"


async def test_execute_dag_rejects_multiple_param_tool_calls():
    """DAG execution refuses an ambiguous multi-call param-populator result."""
    plan_data = {
        "tasks": [
            {
                "goal": "Find the current population of New York City using explore-agent web research.",
                "tool_name": "spawn_general_purpose_agent",
            }
        ],
        "dependencies": {},
    }

    recorded = []

    async def execute_tool(name, params, tool_call_id):
        recorded.append((name, dict(params)))
        return {"message": "spawned"}

    def param_tool_calls(_args):
        return [
            {"tool": "spawn_agent", "goal": "Find the current population of Tokyo."},
            {"tool": "spawn_agent", "goal": "Find the current population of New York City."},
        ]

    result, _events, dag = await _run_execute_dag(
        plan_data,
        execute_tool_impl=execute_tool,
        param_tool_calls=param_tool_calls,
    )

    assert result["status"] == "needs_llm"
    assert recorded == []
    assert dag.tasks[0].state.value == "FAILED"


async def test_execute_dag_generation_handoff_does_not_start_dependents():
    """A deploy yield is not task success — dependents must not create more approvals.

    Prod agent 262669d8 handed off call_phone_number #1, then the DAG treated
    ``success: True, generation_handoff: True`` as completed and started three
    more phone-call approvals, each leaving another pending attn_id.
    """
    plan_data = {
        "tasks": [
            {"goal": "Place the initial call", "tool_name": "call_phone_number"},
            {"goal": "Conditional retry #1", "tool_name": "call_phone_number"},
        ],
        "dependencies": {"1": [0]},
    }
    started: list[str] = []

    async def execute_tool(name, params, tool_call_id):
        started.append(tool_call_id)
        return {
            "success": True,
            "generation_handoff": True,
            "handoff_task_queue": "navi-agent-tasks-live",
            "message": "new code version deployed, retry this tool",
        }

    result, _events, dag = await _run_execute_dag(plan_data, execute_tool_impl=execute_tool)

    assert result["status"] == "generation_handoff"
    assert result["handoff_task_queue"] == "navi-agent-tasks-live"
    assert len(started) == 1
    assert dag.tasks[1].state.value != "COMPLETED"


async def test_execute_dag_tool_failure_returns_needs_llm():
    """execute_dag returns status=needs_llm (recoverable) when a tool reports error."""
    plan_data = {
        "tasks": [{"goal": "bad task", "tool_name": "web_search"}],
        "dependencies": {},
    }

    async def execute_tool(name, params, tool_call_id):
        return {"error": True, "message": "tool broke"}

    result, events, dag = await _run_execute_dag(plan_data, execute_tool_impl=execute_tool)

    assert result["status"] == "needs_llm"
    assert dag.tasks[0].state.value == "FAILED"


async def test_execute_dag_exception_in_tool_yields_error_event():
    """execute_dag catches exception and emits ERROR tool event."""
    plan_data = {
        "tasks": [{"goal": "broken", "tool_name": "web_search"}],
        "dependencies": {},
    }

    async def execute_tool(name, params, tool_call_id):
        raise RuntimeError("connection refused")

    result, events, dag = await _run_execute_dag(plan_data, execute_tool_impl=execute_tool)

    assert result["status"] == "needs_llm"
    # should have an ERROR tool_event posted via handle_tool_event_fn
    error_events = [e for e in events if e["type"] == "tool_event" and e["tool_name"] == "web_search"]
    assert len(error_events) >= 1
    assert dag.tasks[0].state.value == "FAILED"


async def test_execute_dag_parallel_independent_tasks():
    """execute_dag executes independent tasks and completes all."""
    plan_data = {
        "tasks": [
            {"goal": "a", "tool_name": "web_search"},
            {"goal": "b", "tool_name": "web_search"},
        ],
        "dependencies": {},
    }

    async def execute_tool(name, params, tool_call_id):
        return {"message": "ok"}

    result, events, dag = await _run_execute_dag(plan_data, execute_tool_impl=execute_tool)

    assert result["status"] == "completed"
    assert all(t.state.value == "COMPLETED" for t in dag.tasks)


async def test_execute_dag_retries_structured_param_failure_once():
    """A non-retryable activity contract failure is retried by the DAG, not Temporal."""
    plan_data = {
        "tasks": [{"goal": "find updates", "tool_name": "web_search"}],
        "dependencies": {},
    }
    param_attempts = 0

    def param_tool_calls(_args):
        nonlocal param_attempts
        param_attempts += 1
        if param_attempts == 1:
            application_error = RuntimeError("required tool missing")
            application_error.type = "LLMStructuredOutputError"
            activity_error = RuntimeError("Activity task failed")
            activity_error.cause = application_error
            raise activity_error
        return [{"tool": "web_search", "query": "latest updates"}]

    result, _events, dag = await _run_execute_dag(plan_data, param_tool_calls=param_tool_calls)

    assert result["status"] == "completed"
    assert param_attempts == 2
    assert dag.tasks[0].state.value == "COMPLETED"


async def test_execute_dag_terminalizes_canceled_sibling_tool_event():
    """A canceled sibling terminalizes its early IN_PROGRESS tool chip.

    When one DAG task fails, execute_dag cancels the remaining task wrappers.
    asyncio.CancelledError is not an Exception, so the broad handler that posts a
    terminal event is bypassed; without an explicit CancelledError handler the
    early IN_PROGRESS chip stays live forever (phantom chip). This proves the
    canceled sibling emits a terminal event for the same tool_call_id.
    """
    plan_data = {
        "tasks": [
            {"goal": "FailFast", "tool_name": "web_search"},
            {"goal": "SlowSibling", "tool_name": "web_search"},
        ],
        "dependencies": {},
    }
    block = asyncio.Event()

    def param_tool_calls(args):
        # args[10] is the param-population message, which embeds the task goal.
        goal = "SlowSibling" if "SlowSibling" in args[10] else "FailFast"
        return [{"tool": "web_search", "query": goal}]

    async def execute_tool(name, params, tool_call_id):
        if params["query"] == "SlowSibling":
            # Blocks until execute_dag cancels this wrapper after FailFast fails.
            await block.wait()
            return {"message": "unreachable"}
        return {"error": True, "message": "fail fast"}

    result, events, dag = await _run_execute_dag(
        plan_data,
        execute_tool_impl=execute_tool,
        param_tool_calls=param_tool_calls,
    )

    assert result["status"] == "needs_llm"

    # The SlowSibling (task index 1) emitted an early IN_PROGRESS chip.
    sibling_in_progress = [
        e
        for e in events
        if e["type"] == "tool_event" and e["status"] == "IN_PROGRESS" and e["metadata"].get("dagTaskIndex") == 1
    ]
    assert len(sibling_in_progress) == 1
    sibling_id = sibling_in_progress[0]["tool_call_id"]

    # A terminal (non-IN_PROGRESS) event must close that exact chip.
    sibling_terminal = [
        e
        for e in events
        if e["type"] == "tool_event" and e["tool_call_id"] == sibling_id and e["status"] not in (None, "IN_PROGRESS")
    ]
    assert len(sibling_terminal) >= 1, f"canceled sibling chip {sibling_id} not terminalized: {events}"
    assert sibling_terminal[0]["metadata"].get("canceled") is True


# ---------------------------------------------------------------------------
# New-message interrupt: a user / agent message mid-DAG hands back to run_agent
# (RCA: root 439c77dd left a user correction unread >5 min while planned GP
# spawns ran in the foreground of execute_dag's FIRST_COMPLETED wait).
# ---------------------------------------------------------------------------

_GP_PARAMS = {
    "tool": "spawn_agent",
    "type": "general_purpose",
    "goal": "Research seed investors",
    "start_phase": "EXECUTE",
    "output_schema": {"fields": [{"name": "names", "type": "str", "required": True}]},
}


class _InterruptSource:
    """Stands in for the workflow's wake counter + wait_condition + background wait."""

    def __init__(self, background_outcome=None):
        self.value = 0
        self._changed = asyncio.Event()
        self.awaited = []
        self.background_gate = asyncio.Event()
        self._background_outcome = background_outcome

    def seq(self):
        return self.value

    async def wait(self, seq):
        while self.value == seq:
            self._changed.clear()
            await self._changed.wait()

    def bump(self):
        self.value += 1
        self._changed.set()

    async def await_background(self, bg_id):
        self.awaited.append(bg_id)
        await self.background_gate.wait()
        if self._background_outcome is not None:
            return await self._background_outcome(bg_id)
        return True

    def hooks(self):
        from loop.dag_executor import DagInterrupts

        return DagInterrupts(seq=self.seq, wait=self.wait, await_background=self.await_background)


_SECOND_TOOL_PARAMS = {
    "web_search": {"query": "seed funds"},
    "call_phone_number": {"phone_number": "+15125550100", "objective": "Confirm the meeting time"},
    "message_person": {"person": "Dana Lee", "message": "Can we meet Tuesday?"},
    "send_message_to_user_execute_phase": {"message": "Which city should I target?", "is_question": True},
}


def _interrupt_plan(second_tool="web_search"):
    return {
        "tasks": [
            {"goal": "Research seed investors", "tool_name": "spawn_general_purpose_agent"},
            {"goal": "Second planned step", "tool_name": second_tool},
            {"goal": "Draft outreach", "tool_name": "reasoning"},
        ],
        "dependencies": {"2": ["0", "1"]},
    }


def _interrupt_param_calls_for(second_tool):
    def _calls(args):
        if "spawn_agent" == args[11]:
            return [dict(_GP_PARAMS)]
        return [{"tool": second_tool, **_SECOND_TOOL_PARAMS[second_tool]}]

    return _calls


_interrupt_param_calls = _interrupt_param_calls_for("web_search")


async def _drive_interrupted_dag(row_metadata, *, expect_interrupt, second_tool="web_search"):
    """Run a DAG whose planned GP spawn runs in the background while a second
    planned step blocks; post one USER row mid-wait.

    The spawn's executor returns at once (the workflow's background start);
    its DAG dependency waits in ``await_background`` until ``spawn_gate``.
    Returns the second step's gate and its asyncio-visible outcome list.
    """
    source = _InterruptSource()
    spawn_gate = source.background_gate
    second_gate = asyncio.Event()
    spawn_started = asyncio.Event()
    second_started = asyncio.Event()
    second_outcome = []
    db_rows = []
    tool_calls = []

    async def execute_tool(name, params, tool_call_id):
        tool_calls.append((name, params.get("type"), tool_call_id))
        if name == "spawn_agent":
            spawn_started.set()
            return {"success": True, "message": "Started", "background_task_id": tool_call_id}
        second_started.set()
        try:
            await second_gate.wait()
        except asyncio.CancelledError:
            second_outcome.append("cancelled")
            raise
        second_outcome.append("finished")
        return {"success": True, "message": f"{name} done"}

    async def poll_messages(_since):
        return list(db_rows)

    dag_task = asyncio.create_task(
        _run_execute_dag(
            _interrupt_plan(second_tool),
            execute_tool_impl=execute_tool,
            param_tool_calls=_interrupt_param_calls_for(second_tool),
            poll_messages=poll_messages,
            interrupts=source.hooks(),
        )
    )
    await asyncio.wait_for(asyncio.gather(spawn_started.wait(), second_started.wait()), 2)
    db_rows.append(
        {
            "message_id": "msg-user-1",
            "role": "USER",
            "text": "Only target funds that lead pre-seed rounds.",
            "metadata": row_metadata,
            "timestamp": "2026-10-19T03:01:57+00:00",
        }
    )
    source.bump()  # receive_user_response / receive_agent_message wake
    if expect_interrupt:
        # Immediate: returns while the spawn and the second step are still blocked.
        result, events, dag = await asyncio.wait_for(dag_task, 1)
    else:
        await asyncio.sleep(0.05)
        assert not dag_task.done(), "a non-interrupting row must not end the DAG"
        second_gate.set()
        spawn_gate.set()
        result, events, dag = await asyncio.wait_for(dag_task, 2)
    return source, second_gate, second_outcome, result, events, dag, tool_calls


async def test_execute_dag_user_message_hands_back_and_leaves_background_spawn_running():
    """A real user message mid-plan returns needs_llm at once; the background child keeps running."""
    source, _gate, _outcome, result, events, dag, tool_calls = await _drive_interrupted_dag({}, expect_interrupt=True)
    assert result["status"] == "needs_llm", result
    assert result.get("interrupted_by_message") is True, result
    # The user row is in the returned context for run_agent.
    assert any(row.get("message_id") == "msg-user-1" for row in result["context"])
    # The planned GP spawn started in the background; only the DAG's wait ended.
    planned_id = dag.tasks[0].tool_call_id
    assert source.awaited == [planned_id]
    assert dag.tasks[0].background_task_id == planned_id
    assert not any(e.get("tool_call_id") == planned_id and e["status"] == "ERROR" for e in events), events
    # The dependent never started.
    assert dag.tasks[2].state.value == "PENDING"
    assert not any(e.get("metadata", {}).get("dagTaskIndex") == 2 for e in events), events
    assert [name for name, *_ in tool_calls] == ["spawn_agent", "web_search"]


async def test_execute_dag_interrupt_cancels_blocking_tool_immediately_with_paired_row():
    """A blocking non-spawn tool is cancelled at once (no grace) with an ERROR "interrupted" row."""
    _source, _gate, outcome, result, events, dag, _calls = await _drive_interrupted_dag({}, expect_interrupt=True)
    assert result["status"] == "needs_llm" and result.get("interrupted_by_message") is True, result
    assert outcome == ["cancelled"], outcome
    search_id = dag.tasks[1].tool_call_id
    search_rows = [e for e in events if e["type"] == "tool_event" and e["tool_call_id"] == search_id]
    assert [row["status"] for row in search_rows] == ["IN_PROGRESS", "ERROR"], search_rows
    terminal = search_rows[-1]
    assert terminal["tool_name"] == search_rows[0]["tool_name"] == "web_search", search_rows  # same chip
    assert terminal["metadata"].get("interrupted") is True and terminal["metadata"].get("canceled") is True
    assert terminal["metadata"].get("dagTaskIndex") == 1
    assert "Interrupted" in terminal["message"], terminal
    assert dag.tasks[2].state.value == "PENDING"


async def test_execute_dag_interrupt_never_cancels_live_call_or_pending_question():
    """A live phone call and a pending approval / user question keep running and report normally."""
    for tool in ("call_phone_number", "message_person", "send_message_to_user_execute_phase"):
        _source, gate, outcome, result, events, dag, _calls = await _drive_interrupted_dag(
            {}, expect_interrupt=True, second_tool=tool
        )
        assert result["status"] == "needs_llm" and result.get("interrupted_by_message") is True, (tool, result)
        assert outcome == [], (tool, outcome)
        assert dag.tasks[1].uninterruptible is True, tool
        assert not any(e["status"] == "ERROR" for e in events if e["type"] == "tool_event"), (tool, events)
        assert len(dag.detached_tasks) == 1, tool
        gate.set()
        assert await asyncio.wait_for(dag.detached_tasks[0], 2) is True, tool  # reports as it normally would
        assert outcome == ["finished"], (tool, outcome)
    # A plain send_message_to_user (not a question) is an ordinary blocking step.
    from loop.dag_executor import _is_uninterruptible_dag_call

    assert _is_uninterruptible_dag_call("send_message_to_user_execute_phase", {"message": "FYI"}) is False
    assert _is_uninterruptible_dag_call("web_search", {"query": "x"}) is False


async def test_execute_dag_planned_spawn_completes_with_child_and_dependent_sees_result():
    """The DAG task for a background spawn completes when the child does; dependents see its notification."""
    db_rows = []
    reasoning_contexts = []
    order = []

    async def notify(bg_id):
        order.append("child-completed")
        db_rows.append(
            {
                "message_id": "note-1",
                "role": "USER",
                "text": "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/task_1\nPayload:\n"
                "4 seed funds: Alpha, Beta, Gamma, Delta.",
                "metadata": {"agentNotification": True, "backgroundTaskId": bg_id, "status": "completed"},
                "timestamp": "2026-10-19T03:05:00+00:00",
            }
        )
        return True

    source = _InterruptSource(background_outcome=notify)

    async def execute_tool(name, params, tool_call_id):
        return {"success": True, "message": "Started", "background_task_id": tool_call_id}

    async def poll_messages(_since):
        return list(db_rows)

    calls = []

    def explore_params(args):
        return [{"tool": "spawn_agent", "type": "explore", "goal": "Find seed funds", "task_name": "funds"}]

    plan = {
        "tasks": [
            {"goal": "Find seed funds", "tool_name": "spawn_explore_agent"},
            {"goal": "Draft outreach", "tool_name": "reasoning"},
        ],
        "dependencies": {"1": ["0"]},
    }
    running = asyncio.create_task(
        _run_execute_dag(
            plan,
            execute_tool_impl=execute_tool,
            param_tool_calls=explore_params,
            execute_activity_calls=calls,
            poll_messages=poll_messages,
            interrupts=source.hooks(),
        )
    )
    for _ in range(200):
        if source.awaited:
            break
        await asyncio.sleep(0.005)
    await asyncio.sleep(0.02)
    assert source.awaited and not running.done(), "the DAG must wait for the background child"
    assert not any("reasoning" in c["fn"] for c in calls), "dependent started before the child completed"
    source.background_gate.set()
    result, events, dag = await asyncio.wait_for(running, 2)
    assert result["status"] == "completed", result
    assert [task.state.value for task in dag.tasks] == ["COMPLETED", "COMPLETED"]
    reasoning_calls = [c for c in calls if "reasoning" in c["fn"]]
    assert len(reasoning_calls) == 1
    reasoning_contexts.append(reasoning_calls[0]["args"][1])
    assert any("Alpha, Beta, Gamma, Delta" in str(row.get("text")) for row in reasoning_contexts[0]), reasoning_contexts
    assert order == ["child-completed"]


async def test_execute_dag_agent_message_interrupts_but_notifications_do_not():
    """agentMessage rows interrupt; agent notifications / hidden / attention rows do not."""
    source, _gate, _outcome, result, _events, _dag, _calls = await _drive_interrupted_dag(
        {"agentMessage": True, "fromAgentId": "sibling-1"}, expect_interrupt=True
    )
    assert result["status"] == "needs_llm" and result.get("interrupted_by_message") is True, result
    assert len(source.awaited) == 1

    for metadata in (
        {"agentNotification": True, "toolName": "agent_notification"},
        {"hidden": True},
        {"isResponseSchemaUpdate": True},
        {"source": "attention_response", "attentionRequestId": "req-1"},
    ):
        source, _gate, _outcome, result, _events, dag, _calls = await _drive_interrupted_dag(
            metadata, expect_interrupt=False
        )
        assert result["status"] == "completed", (metadata, result)
        assert len(source.awaited) == 1, metadata  # the spawn's own dependency wait only
        assert all(task.state.value == "COMPLETED" for task in dag.tasks), metadata


async def test_execute_dag_task_addressed_inbox_row_does_not_interrupt():
    """A row for one of this agent's task inboxes is not input for this agent's LLM.

    The backend stores ``{agentMessage, recipientTaskId, excludeFromModel}`` on the
    task's owner and never signals its loop; the explore/browser activity reads it.
    It must not cancel the planned work (possibly the addressed task itself) and
    hand an invisible row back to the LLM.
    """
    for metadata in (
        {
            "agentMessage": True,
            "fromAgentId": "sibling-1",
            "fromAgentPath": "/root/hotels",
            "toAgentPath": "/root/outreach",
            "recipientTaskId": "toolu_task_1",
            "excludeFromModel": True,
        },
        {"agentMessage": True, "fromAgentId": "sibling-1", "excludeFromModel": True},
    ):
        source, _gate, outcome, result, _events, dag, _calls = await _drive_interrupted_dag(
            metadata, expect_interrupt=False
        )
        assert result["status"] == "completed", (metadata, result)
        assert result.get("interrupted_by_message") is not True, (metadata, result)
        assert outcome == ["finished"], (metadata, outcome)
        assert len(source.awaited) == 1, metadata
        assert all(task.state.value == "COMPLETED" for task in dag.tasks), metadata


async def test_execute_dag_interrupts_without_messages_keep_behavior_identical():
    """No message → the same activities, tool calls and rows as a DAG without interrupts."""
    import uuid

    async def run(with_interrupts):
        counter = iter(range(1, 1000))
        calls = []
        source = _InterruptSource()

        async def poll_messages(_since):
            return []

        with patch("loop.dag_executor.workflow.uuid4", lambda: uuid.UUID(int=next(counter))):
            result, events, dag = await _run_execute_dag(
                _interrupt_plan(),
                param_tool_calls=_interrupt_param_calls,
                execute_activity_calls=calls,
                poll_messages=poll_messages,
                **({"interrupts": source.hooks()} if with_interrupts else {}),
            )
        return result["status"], events, [(c["fn"], c["args"]) for c in calls], source.awaited

    baseline = await run(False)
    interrupted = await run(True)
    assert baseline[0] == interrupted[0] == "completed"
    assert interrupted[1] == baseline[1]
    assert interrupted[2] == baseline[2]
    assert interrupted[3] == []


def test_oai_demo_reasoning_fast_mode_step_uses_july_slot():
    """Leftover GPs must not shift catalog-demo assemble-final off July p:6."""
    from utils.oai_demo import OAI_DEMO_ROOT_GOAL_PREFIX
    from loop.dag_executor import (
        DAGTask,
        OAI_DEMO_ASSEMBLE_FINAL_REASONING_STEP,
        TaskDAG,
        TaskState,
        _oai_demo_reasoning_fast_mode_step,
    )

    dag = TaskDAG(
        {
            "tasks": [
                {"goal": "Analyze 50 creators", "tool_name": "spawn_general_purpose_agent_for_each"},
                {"goal": "Final assembly and quality assurance", "tool_name": "reasoning"},
            ],
            "dependencies": {"1": [0]},
        }
    )
    dag.tasks[0].state = TaskState.COMPLETED
    reasoning = dag.tasks[1]
    demo_ctx = [{"role": "USER", "message": OAI_DEMO_ROOT_GOAL_PREFIX}]
    assert _oai_demo_reasoning_fast_mode_step(reasoning, dag, demo_ctx) == OAI_DEMO_ASSEMBLE_FINAL_REASONING_STEP
    assert _oai_demo_reasoning_fast_mode_step(reasoning, dag, [{"role": "USER", "message": "other"}]) == reasoning.index
    leftover = DAGTask(index=3, goal="calendar", tool_name="spawn_general_purpose_agent")
    assert _oai_demo_reasoning_fast_mode_step(leftover, dag, demo_ctx) == leftover.index


def test_planned_general_purpose_tool_is_not_rewritten_from_goal_text():
    """Synthesis-shaped goals stay on the planned tool. No keyword rewrite."""
    import loop.dag_executor as dag_executor
    from loop.dag_executor import DAGTask

    assert not hasattr(dag_executor, "is_fan_in_synthesis_goal")
    assert not hasattr(dag_executor, "maybe_rewrite_recursive_gp_synthesis_task")

    task = DAGTask(
        index=6,
        goal="Consolidate the complete evidence returned by tasks 0 through 4 into a final candidate universe.",
        tool_name="spawn_general_purpose_agent",
        depends_on=[0, 1, 2, 3, 4],
    )
    assert task.tool_name == "spawn_general_purpose_agent"


async def test_execute_dag_strict_readonly_populate_miss_skips_without_error():
    """A Fast Mode read-only populate miss skips the leftover node; no ERROR chip.

    Mass-agent July cache has explore + for_each populate rows. The leftover
    post-for_each GP is not in that cache. Strict read-only correctly refuses
    a live param-populator call (DemoCacheLookupError). That miss must not
    become a toolStatus=ERROR chip — t10-no-tool-failures treats ERROR as a
    failed run even when execute_loop later replays the leftover from cache.
    """
    from providers.demo_cache.rose_cache import DemoCacheLookupError

    leftover_goal = "Produce fresh tool-grounded evidence for remaining deliverables"
    plan_data = {
        "tasks": [
            {"goal": "search first", "tool_name": "web_search"},
            {"goal": leftover_goal, "tool_name": "spawn_general_purpose_agent"},
        ],
        "dependencies": {"1": [0]},
    }
    executed: list[str] = []

    def param_tool_calls(args):
        extra = args[10] if args and len(args) > 10 else ""
        if leftover_goal in extra:
            inner = DemoCacheLookupError(
                "Strict read-only benchmark cache miss for dag_param_populator; live fallback is disabled"
            )
            wrapped = RuntimeError("Activity task failed")
            wrapped.cause = inner
            raise wrapped
        return [{"tool": "web_search", "query": "ok"}]

    async def execute_tool(name, params, tool_call_id):
        executed.append(name)
        return {"message": f"{name} done"}

    result, events, dag = await _run_execute_dag(
        plan_data,
        execute_tool_impl=execute_tool,
        param_tool_calls=param_tool_calls,
    )

    assert result["status"] == "completed"
    assert all(t.state.value == "COMPLETED" for t in dag.tasks)
    assert executed == ["web_search"]
    leftover_events = [e for e in events if e["type"] == "tool_event" and e["metadata"].get("dagTaskIndex") == 1]
    assert leftover_events, f"leftover chip missing: {events}"
    assert any(e["status"] == "IN_PROGRESS" for e in leftover_events)
    terminal = [e for e in leftover_events if e["status"] not in (None, "IN_PROGRESS")]
    assert len(terminal) >= 1
    assert terminal[0]["status"] == "FINISHED"
    assert terminal[0]["metadata"].get("demoCacheSkip") is True
    assert not any(e["status"] == "ERROR" for e in leftover_events)


async def test_execute_dag_skips_oai_demo_leftover_gp_after_for_each():
    """Catalog demo leftover GPs after for_each must not spawn — they desync assemble-final cache."""
    from utils.oai_demo import OAI_DEMO_ROOT_GOAL_PREFIX

    leftover_goal = "Create a 90-day content calendar for Andy Prevalsky"
    plan_data = {
        "tasks": [
            {"goal": "Analyze 50 creators", "tool_name": "spawn_general_purpose_agent_for_each"},
            {"goal": leftover_goal, "tool_name": "spawn_general_purpose_agent"},
            {"goal": "Final assembly and quality assurance", "tool_name": "reasoning"},
        ],
        "dependencies": {"1": [0], "2": [1]},
    }
    executed: list[str] = []
    activity_calls: list[dict] = []

    schema = {"fields": [{"name": "creator_name", "type": "str", "required": True, "properties": []}]}

    def param_tool_calls(args):
        extra = args[10] if args and len(args) > 10 else ""
        if leftover_goal in extra:
            return [
                {
                    "tool": "spawn_agent",
                    "type": "general_purpose",
                    "start_phase": "EXECUTE",
                    "goal": leftover_goal,
                    "output_schema": schema,
                }
            ]
        return [
            {
                "tool": "spawn_agent",
                "type": "for_each",
                "start_phase": "EXECUTE",
                "goal": "Analyze 50 creators",
                "items": [{"name": "Huberman"}],
                "output_schema": schema,
            }
        ]

    async def execute_tool(name, params, tool_call_id):
        executed.append(params.get("type") or name)
        return {"message": f"{name} done"}

    result, events, dag = await _run_execute_dag(
        plan_data,
        execute_tool_impl=execute_tool,
        param_tool_calls=param_tool_calls,
        context=[{"role": "USER", "message": OAI_DEMO_ROOT_GOAL_PREFIX}],
        reasoning_result={"content": "# positioning_statement\n\nAndy as the founder-operator.", "usage": {}},
        execute_activity_calls=activity_calls,
    )

    assert result["status"] == "completed"
    assert executed == ["for_each"]
    leftover_events = [e for e in events if e["type"] == "tool_event" and e["metadata"].get("dagTaskIndex") == 1]
    assert leftover_events == [], f"leftover GP must not post chips (desyncs assemble-final): {leftover_events}"
    assert dag.tasks[1].state.value == "COMPLETED"
    from loop.dag_executor import OAI_DEMO_ASSEMBLE_FINAL_REASONING_STEP

    reasoning_call = next(c for c in activity_calls if "reasoning" in c["fn"])
    # Leftover GPs shift task.index to 2; July assemble-final is still p:6.
    assert dag.tasks[2].index == 2
    assert reasoning_call["args"][-2] == OAI_DEMO_ASSEMBLE_FINAL_REASONING_STEP


async def test_execute_dag_transport_lookup_error_still_fails():
    """A DemoCacheLookupError that is not a clean read-only miss stays a failure."""
    from providers.demo_cache.rose_cache import DemoCacheLookupError

    plan_data = {
        "tasks": [{"goal": "search first", "tool_name": "web_search"}],
        "dependencies": {},
    }

    def param_tool_calls(_args):
        raise DemoCacheLookupError("demo_cache.get_error: ReadTimeout after retries")

    result, events, dag = await _run_execute_dag(plan_data, param_tool_calls=param_tool_calls)

    assert result["status"] == "needs_llm"
    assert dag.tasks[0].state.value == "FAILED"
    error_events = [e for e in events if e["type"] == "tool_event" and e["status"] == "ERROR"]
    assert error_events, f"transport lookup error must still ERROR: {events}"


async def run_all_tests():
    print("dag-executor blackbox tests:")
    r = BlackboxResult()
    r.record("extract_error_message_plain", test_extract_error_message_plain)
    r.record("extract_error_message_unwraps_generic_wrapper", test_extract_error_message_unwraps_generic_wrapper)
    r.record("extract_error_message_uses_cause_attr", test_extract_error_message_uses_cause_attr)
    r.record("extract_error_message_empty", test_extract_error_message_empty)
    r.record("task_dag_rejects_string_tasks", test_task_dag_rejects_string_tasks)
    r.record("task_dag_rejects_missing_tool_name", test_task_dag_rejects_missing_tool_name)
    r.record("task_dag_parses_dict_tasks", test_task_dag_parses_dict_tasks)
    r.record("task_dag_get_ready_tasks_initial", test_task_dag_get_ready_tasks_initial)
    r.record("task_dag_state_transitions", test_task_dag_state_transitions)
    r.record(
        "resume_completed_ignores_background_executor_rows",
        test_resume_completed_tasks_ignores_background_executor_rows,
    )
    r.record("task_dag_is_complete_join_any", test_task_dag_is_complete_join_any)
    r.record("task_dag_get_ready_respects_deps", test_task_dag_get_ready_respects_deps)
    r.record("extract_plan_from_context_found", test_extract_plan_from_context_found)
    r.record("extract_plan_from_context_empty", test_extract_plan_from_context_empty)
    r.record("extract_plan_from_context_ignores_in_progress", test_extract_plan_from_context_ignores_in_progress)
    r.record("plan_superseded_by_user_after_final_summary", test_plan_superseded_by_user_after_final_summary)
    r.record(
        "plan_superseded_by_final_summary_without_later_user",
        test_plan_superseded_by_final_summary_without_later_user,
    )
    r.record(
        "plan_superseded_by_user_after_set_plan_without_summary",
        test_plan_superseded_by_user_after_set_plan_without_summary,
    )
    r.record(
        "plan_not_superseded_by_hidden_user_after_set_plan",
        test_plan_not_superseded_by_hidden_user_after_set_plan,
    )
    r.record(
        "plan_not_superseded_by_non_final_summary_without_later_user",
        test_plan_not_superseded_by_non_final_summary_without_later_user,
    )
    r.record(
        "latest_real_user_instruction_skips_hidden_schema_updates",
        test_latest_real_user_instruction_skips_hidden_schema_updates,
    )
    r.record("latest_real_user_instruction_empty", test_latest_real_user_instruction_empty)
    r.record(
        "followup_after_compaction_projects_last_checkpoint_and_stales_plan",
        test_followup_after_compaction_projects_last_checkpoint_and_stales_plan,
    )
    r.record("tool_aliases_constants", test_tool_aliases_constants)
    r.record(
        "dag_foreach_alias_override_passes_spawn_agent_validation",
        test_dag_foreach_alias_override_passes_spawn_agent_validation,
    )
    r.record(
        "oai_demo_reasoning_fast_mode_step_uses_july_slot",
        test_oai_demo_reasoning_fast_mode_step_uses_july_slot,
    )
    r.record(
        "planned_general_purpose_tool_is_not_rewritten_from_goal_text",
        test_planned_general_purpose_tool_is_not_rewritten_from_goal_text,
    )
    await r.record_async(
        "execute_dag_strict_readonly_populate_miss_skips_without_error",
        test_execute_dag_strict_readonly_populate_miss_skips_without_error,
    )
    await r.record_async(
        "execute_dag_skips_oai_demo_leftover_gp_after_for_each",
        test_execute_dag_skips_oai_demo_leftover_gp_after_for_each,
    )
    await r.record_async(
        "execute_dag_transport_lookup_error_still_fails",
        test_execute_dag_transport_lookup_error_still_fails,
    )
    r.record("build_param_population_message_basic", test_build_param_population_message_basic)
    r.record(
        "build_param_population_message_spawn",
        test_build_param_population_message_spawn_preserves_outer_alias_contract,
    )
    r.record("build_param_population_message_non_spawn", test_build_param_population_message_non_spawn_no_extra)
    r.record(
        "select_param_tool_call_requires_exactly_one_call",
        test_select_param_tool_call_requires_exactly_one_call,
    )
    r.record("select_param_tool_call_rejects_wrong_single_tool", test_select_param_tool_call_rejects_wrong_single_tool)
    r.record("select_param_tool_call_rejects_wrong_alias_types", test_select_param_tool_call_rejects_wrong_alias_types)
    await r.record_async("execute_dag_reasoning_task_succeeds", test_execute_dag_reasoning_task_succeeds)
    await r.record_async("execute_dag_reasoning_forwards_gpt_token", test_execute_dag_reasoning_forwards_gpt_token)
    await r.record_async("execute_dag_tool_task_succeeds", test_execute_dag_tool_task_succeeds)
    await r.record_async(
        "execute_dag_retries_structured_param_failure_once",
        test_execute_dag_retries_structured_param_failure_once,
    )
    await r.record_async(
        "execute_dag_tool_llm_activity_args_match_signature",
        test_execute_dag_tool_llm_activity_args_match_signature,
    )
    await r.record_async(
        "execute_dag_param_populator_ignores_stale_pending_ctx",
        test_execute_dag_param_populator_never_adopts_a_stale_pending_context_slot,
    )
    await r.record_async("execute_dag_alias_resolution_spawn_explore", test_execute_dag_alias_resolution_spawn_explore)
    await r.record_async(
        "execute_dag_repairs_stale_cached_explore_alias_without_live_retry",
        test_execute_dag_repairs_stale_cached_explore_alias_without_live_retry,
    )
    await r.record_async("execute_dag_wait_for_emits_early_wait_chip", test_execute_dag_wait_for_emits_early_wait_chip)
    await r.record_async(
        "execute_dag_general_purpose_spawn_emits_subagent_placeholder",
        test_execute_dag_general_purpose_spawn_emits_subagent_placeholder,
    )
    await r.record_async(
        "execute_dag_retries_wrong_spawn_alias_type_before_execution",
        test_execute_dag_retries_wrong_spawn_alias_type_before_execution,
    )
    await r.record_async(
        "execute_dag_parallel_spawn_alias_retry_has_exactly_two_side_effects",
        test_execute_dag_parallel_spawn_alias_retry_has_exactly_two_side_effects,
    )
    await r.record_async(
        "execute_dag_exhausted_alias_retry_never_replays_committed_sibling",
        test_execute_dag_exhausted_alias_retry_never_replays_committed_sibling,
    )
    await r.record_async(
        "execute_dag_validates_overridden_spawn_payload_before_execution",
        test_execute_dag_validates_overridden_spawn_payload_before_execution,
    )
    await r.record_async(
        "execute_dag_rejects_multiple_param_tool_calls",
        test_execute_dag_rejects_multiple_param_tool_calls,
    )
    await r.record_async(
        "execute_dag_generation_handoff_does_not_start_dependents",
        test_execute_dag_generation_handoff_does_not_start_dependents,
    )
    await r.record_async("execute_dag_tool_failure_returns_needs_llm", test_execute_dag_tool_failure_returns_needs_llm)
    await r.record_async(
        "execute_dag_exception_in_tool_yields_error_event", test_execute_dag_exception_in_tool_yields_error_event
    )
    await r.record_async("execute_dag_parallel_independent_tasks", test_execute_dag_parallel_independent_tasks)
    await r.record_async(
        "execute_dag_terminalizes_canceled_sibling_tool_event",
        test_execute_dag_terminalizes_canceled_sibling_tool_event,
    )
    await r.record_async(
        "execute_dag_user_message_hands_back_and_leaves_background_spawn_running",
        test_execute_dag_user_message_hands_back_and_leaves_background_spawn_running,
    )
    await r.record_async(
        "execute_dag_interrupt_cancels_blocking_tool_immediately",
        test_execute_dag_interrupt_cancels_blocking_tool_immediately_with_paired_row,
    )
    await r.record_async(
        "execute_dag_interrupt_never_cancels_call_or_pending_question",
        test_execute_dag_interrupt_never_cancels_live_call_or_pending_question,
    )
    await r.record_async(
        "execute_dag_planned_spawn_completes_with_child_dependent_sees_result",
        test_execute_dag_planned_spawn_completes_with_child_and_dependent_sees_result,
    )
    await r.record_async(
        "execute_dag_agent_message_interrupts_but_notifications_do_not",
        test_execute_dag_agent_message_interrupts_but_notifications_do_not,
    )
    await r.record_async(
        "execute_dag_task_addressed_inbox_row_does_not_interrupt",
        test_execute_dag_task_addressed_inbox_row_does_not_interrupt,
    )
    await r.record_async(
        "execute_dag_interrupts_without_messages_keep_behavior_identical",
        test_execute_dag_interrupts_without_messages_keep_behavior_identical,
    )
    await r.record_async(
        "execute_dag_code_alias_forwards_github_repo_ref",
        test_execute_dag_code_alias_forwards_github_repo_ref_and_explore_strips_it,
    )
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
