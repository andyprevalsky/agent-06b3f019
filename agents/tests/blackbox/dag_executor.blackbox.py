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


def test_task_dag_parses_string_tasks():
    """TaskDAG handles old format string tasks with default reasoning tool."""
    from loop.dag_executor import TaskDAG, TaskState

    plan_data = {
        "tasks": ["Analyze data", "Write summary"],
        "dependencies": {"1": [0]},
        "join": "all",
    }
    dag = TaskDAG(plan_data)

    assert len(dag.tasks) == 2
    assert dag.tasks[0].goal == "Analyze data"
    assert dag.tasks[0].tool_name == "reasoning"
    assert dag.tasks[1].depends_on == [0]
    assert dag.join == "all"
    assert dag.tasks[0].state == TaskState.PENDING


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
            SpawnAgentTool(**{**params, "type": agent_type})
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

        # Preserve: a populator-chosen start_phase must NOT be overwritten (keeps
        # already-cached fan-out children on their existing keys).
        preserved = _apply_alias_override({**params, "start_phase": "PLAN"}, alias)
        assert preserved["start_phase"] == "PLAN"
        assert SpawnAgentTool(**preserved).start_phase == "PLAN"


def test_build_param_population_message_basic():
    """_build_param_population_message includes tool name and goal."""
    from loop.dag_executor import _build_param_population_message

    msg = _build_param_population_message("Search for restaurants", "web_search")
    assert "web_search" in msg
    assert "Search for restaurants" in msg
    assert "MUST call exactly one tool" in msg


def test_build_param_population_message_spawn_adds_context_warning():
    """Spawn-type alias adds self-contained goal warning without schema redefinition."""
    from loop.dag_executor import _build_param_population_message

    msg = _build_param_population_message("Explore competitors", "spawn_agent", "spawn_explore_agent")
    assert "NO access to your conversation" in msg
    assert "SPAWN TYPE" not in msg
    assert 'type="explore"' not in msg


def test_build_param_population_message_non_spawn_no_extra():
    """Non-spawn tool does not include spawn-specific warnings."""
    from loop.dag_executor import _build_param_population_message

    msg = _build_param_population_message("Wait 10s", "wait_for")
    assert "NO access to your conversation" not in msg
    assert "SPAWN TYPE" not in msg


def test_select_param_tool_call_prefers_task_matching_duplicate():
    """Duplicate matching tool calls are disambiguated by DAG task text."""
    from loop.dag_executor import DAGTask, _select_param_tool_call

    task = DAGTask(
        index=1,
        goal="Find the current population of New York City using explore-agent web research.",
        tool_name="spawn_general_purpose_agent",
    )
    with patch("loop.dag_executor.workflow.logger", MagicMock()):
        selected = _select_param_tool_call(
            [
                {"tool": "spawn_agent", "goal": "Find the current population of Tokyo."},
                {"tool": "spawn_agent", "goal": "Find the current population of New York City."},
            ],
            "spawn_agent",
            task,
        )

    assert selected["goal"] == "Find the current population of New York City."


def test_select_param_tool_call_rejects_ambiguous_duplicate():
    """Ambiguous duplicate tool calls fail before the wrong tool can execute."""
    import pytest

    from loop.dag_executor import DAGTask, _select_param_tool_call

    task = DAGTask(index=0, goal="Find a population figure.", tool_name="spawn_general_purpose_agent")

    with pytest.raises(ValueError, match="multiple ambiguous spawn_agent"):
        _select_param_tool_call(
            [
                {"tool": "spawn_agent", "goal": "Find a population figure."},
                {"tool": "spawn_agent", "goal": "Find a population figure."},
            ],
            "spawn_agent",
            task,
        )


async def _run_execute_dag(
    plan_data,
    execute_tool_impl=None,
    reasoning_result=None,
    param_tool_calls=None,
    execute_activity_calls=None,
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

    async def execute_activity(fn, args=None, **_kwargs):
        if execute_activity_calls is not None:
            execute_activity_calls.append({"fn": getattr(fn, "__name__", "") or str(fn), "args": args})
        fn_name = getattr(fn, "__name__", "") or str(fn)
        if "reasoning" in fn_name:
            return reasoning_result or {"content": "reasoning output", "usage": {}}
        # call_llm_activity for param population — return tool_calls format
        tool_name = args[11] if args and len(args) > 11 else "unknown"
        if param_tool_calls is not None and args and args[8] == "dag_param_populator":
            tool_calls = param_tool_calls(args)
        else:
            tool_calls = [{"tool": tool_name, "query": "x"}]
        return {
            "response": "",
            "tool_calls": tool_calls,
            "usage": {},
            "detected_tools_ordered": [],
        }

    # Patch workflow.logger (only valid inside workflow event loop) with a stub
    fake_logger = MagicMock()
    with patch("loop.dag_executor.workflow.logger", fake_logger):
        result = await execute_dag(
            dag=dag,
            agent_id="agent-1",
            user_id="user-1",
            model="rose-lite",
            context=[],
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
    """execute_dag runs reasoning task via execute_reasoning_activity and posts ASSISTANT message."""
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
    thought_events = [e for e in events if e["type"] == "tool_event" and e["tool_name"] == "thought"]
    reasoning_events = [e for e in events if e["type"] == "tool_event" and e["tool_name"] == "reasoning"]
    assert reasoning_events == []
    assert [e["status"] for e in thought_events] == ["IN_PROGRESS", "FINISHED"]
    assert [e["title"] for e in thought_events] == ["Thinking", "Thought"]
    assert len({e["tool_call_id"] for e in thought_events}) == 1
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
    """DAG cache warm + param population pass the current call_llm_activity argument contract."""
    from helpers.llm import call_llm_activity

    plan_data = {
        "tasks": [{"goal": "Do search", "tool_name": "web_search"}],
        "dependencies": {},
    }
    calls = []

    result, _events, _dag = await _run_execute_dag(
        plan_data,
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
    assert len(llm_calls) == 2

    max_positional = len(
        [
            p
            for p in inspect.signature(call_llm_activity).parameters.values()
            if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
        ]
    )
    assert all(len(c["args"]) <= max_positional for c in llm_calls)

    cache_args = llm_calls[0]["args"]
    assert cache_args[8] == "dag_cache_warm"
    assert cache_args[13] == ""
    assert cache_args[14] == "user"
    assert cache_args[15] == "pool-1"
    assert cache_args[16] == "user-1"
    assert cache_args[17] == "gpt-access"
    assert cache_args[18] == "acct-1"
    assert cache_args[19] == "compute"
    assert cache_args[20] == "gpt-pool-1"
    assert cache_args[21] == "user-1"
    assert cache_args[22] is None
    assert cache_args[23] is None
    assert cache_args[24] == "user-1"

    param_args = llm_calls[1]["args"]
    assert param_args[8] == "dag_param_populator"
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

    result, events, dag = await _run_execute_dag(plan_data, execute_tool_impl=execute_tool)

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

    result, events, dag = await _run_execute_dag(plan_data, execute_tool_impl=execute_tool)

    assert result["status"] == "completed"
    assert recorded[0][0] == "spawn_agent"
    assert recorded[0][1].get("type") == "general_purpose"
    early = [e for e in events if e["type"] == "tool_event" and e["status"] == "IN_PROGRESS"][0]
    assert early["tool_name"] == "spawn_general_purpose_agent"
    assert early["title"] == "Spawning sub-agent"
    assert early["message"] == ""
    assert early["tool_call_id"] == recorded[0][2]
    assert dag.tasks[0].tool_call_id == recorded[0][2]


async def test_execute_dag_uses_matching_param_tool_call_for_duplicate_spawn_calls():
    """DAG execution does not run a wrong first spawn_agent call from param population."""
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

    result, _events, _dag = await _run_execute_dag(
        plan_data,
        execute_tool_impl=execute_tool,
        param_tool_calls=param_tool_calls,
    )

    assert result["status"] == "completed"
    assert recorded == [
        (
            "spawn_agent",
            {
                "goal": "Find the current population of New York City.",
                "type": "general_purpose",
                # start_phase is now supplied by the alias override so the
                # resolved spawn_agent call passes SpawnAgentTool validation.
                "start_phase": "EXECUTE",
            },
        )
    ]


async def test_execute_dag_tool_failure_returns_needs_llm():
    """execute_dag returns status=needs_llm when a tool reports error."""
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


async def run_all_tests():
    print("dag-executor blackbox tests:")
    r = BlackboxResult()
    r.record("extract_error_message_plain", test_extract_error_message_plain)
    r.record("extract_error_message_unwraps_generic_wrapper", test_extract_error_message_unwraps_generic_wrapper)
    r.record("extract_error_message_uses_cause_attr", test_extract_error_message_uses_cause_attr)
    r.record("extract_error_message_empty", test_extract_error_message_empty)
    r.record("task_dag_parses_string_tasks", test_task_dag_parses_string_tasks)
    r.record("task_dag_parses_dict_tasks", test_task_dag_parses_dict_tasks)
    r.record("task_dag_get_ready_tasks_initial", test_task_dag_get_ready_tasks_initial)
    r.record("task_dag_state_transitions", test_task_dag_state_transitions)
    r.record("task_dag_is_complete_join_any", test_task_dag_is_complete_join_any)
    r.record("task_dag_get_ready_respects_deps", test_task_dag_get_ready_respects_deps)
    r.record("extract_plan_from_context_found", test_extract_plan_from_context_found)
    r.record("extract_plan_from_context_empty", test_extract_plan_from_context_empty)
    r.record("extract_plan_from_context_ignores_in_progress", test_extract_plan_from_context_ignores_in_progress)
    r.record("tool_aliases_constants", test_tool_aliases_constants)
    r.record(
        "dag_foreach_alias_override_passes_spawn_agent_validation",
        test_dag_foreach_alias_override_passes_spawn_agent_validation,
    )
    r.record("build_param_population_message_basic", test_build_param_population_message_basic)
    r.record("build_param_population_message_spawn", test_build_param_population_message_spawn_adds_context_warning)
    r.record("build_param_population_message_non_spawn", test_build_param_population_message_non_spawn_no_extra)
    r.record("select_param_tool_call_prefers_task_matching_duplicate", test_select_param_tool_call_prefers_task_matching_duplicate)
    r.record("select_param_tool_call_rejects_ambiguous_duplicate", test_select_param_tool_call_rejects_ambiguous_duplicate)
    await r.record_async("execute_dag_reasoning_task_succeeds", test_execute_dag_reasoning_task_succeeds)
    await r.record_async("execute_dag_reasoning_forwards_gpt_token", test_execute_dag_reasoning_forwards_gpt_token)
    await r.record_async("execute_dag_tool_task_succeeds", test_execute_dag_tool_task_succeeds)
    await r.record_async(
        "execute_dag_tool_llm_activity_args_match_signature",
        test_execute_dag_tool_llm_activity_args_match_signature,
    )
    await r.record_async("execute_dag_alias_resolution_spawn_explore", test_execute_dag_alias_resolution_spawn_explore)
    await r.record_async("execute_dag_wait_for_emits_early_wait_chip", test_execute_dag_wait_for_emits_early_wait_chip)
    await r.record_async(
        "execute_dag_general_purpose_spawn_emits_subagent_placeholder",
        test_execute_dag_general_purpose_spawn_emits_subagent_placeholder,
    )
    await r.record_async(
        "execute_dag_uses_matching_param_tool_call_for_duplicate_spawn_calls",
        test_execute_dag_uses_matching_param_tool_call_for_duplicate_spawn_calls,
    )
    await r.record_async("execute_dag_tool_failure_returns_needs_llm", test_execute_dag_tool_failure_returns_needs_llm)
    await r.record_async("execute_dag_exception_in_tool_yields_error_event", test_execute_dag_exception_in_tool_yields_error_event)
    await r.record_async("execute_dag_parallel_independent_tasks", test_execute_dag_parallel_independent_tasks)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
