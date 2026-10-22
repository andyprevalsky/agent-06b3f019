"""Blackbox tests for set-plan domain."""

import asyncio
import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


# ── validate_dependencies ────────────────────────────────────────────────


def test_validate_dependencies_valid():
    """validate_dependencies returns None for a valid DAG."""
    from tools.set_plan import validate_dependencies

    tasks = ["Research", "Write report", "Send email"]
    deps = {"1": ["0"], "2": ["1"]}
    result = validate_dependencies(tasks, deps)
    assert result is None


def test_validate_dependencies_empty_deps_is_valid():
    """validate_dependencies returns None for empty deps (all parallel)."""
    from tools.set_plan import validate_dependencies

    assert validate_dependencies(["A", "B", "C"], {}) is None


def test_validate_dependencies_cycle():
    """validate_dependencies catches a dependency cycle."""
    from tools.set_plan import validate_dependencies

    tasks = ["A", "B", "C"]
    deps = {"0": ["2"], "1": ["0"], "2": ["1"]}
    result = validate_dependencies(tasks, deps)
    assert result is not None and "cycle" in result.lower()


def test_validate_dependencies_self_dependency():
    """Task cannot depend on itself."""
    from tools.set_plan import validate_dependencies

    err = validate_dependencies(["A", "B"], {"1": ["1"]})
    assert err is not None and "itself" in err


def test_validate_dependencies_non_numeric_task_idx():
    """Task index must be a digit string."""
    from tools.set_plan import validate_dependencies

    err = validate_dependencies(["A", "B"], {"foo": ["0"]})
    assert err is not None and "numeric" in err.lower()


def test_validate_dependencies_out_of_range_task():
    """Task index must be in range."""
    from tools.set_plan import validate_dependencies

    err = validate_dependencies(["A", "B"], {"5": ["0"]})
    assert err is not None and "out of range" in err.lower()


def test_validate_dependencies_preds_not_list():
    """Predecessors must be a list."""
    from tools.set_plan import validate_dependencies

    err = validate_dependencies(["A", "B"], {"1": "0"})  # type: ignore[dict-item]
    assert err is not None and "list" in err.lower()


def test_validate_dependencies_non_numeric_predecessor():
    """Predecessor must be a digit string."""
    from tools.set_plan import validate_dependencies

    err = validate_dependencies(["A", "B"], {"1": ["abc"]})
    assert err is not None and "numeric" in err.lower()


def test_validate_dependencies_out_of_range_predecessor():
    """Predecessor index must be in range."""
    from tools.set_plan import validate_dependencies

    err = validate_dependencies(["A", "B"], {"1": ["99"]})
    assert err is not None and "non-existent" in err.lower()


# ── validate_planner_result ──────────────────────────────────────────────


def test_validate_planner_result_valid():
    """validate_planner_result returns None for a well-formed plan."""
    from tools.set_plan import _validate_planner_result

    result = _validate_planner_result(
        {
            "tasks": [
                {"task_idx": "0", "goal": "Research", "tool_name": "spawn_explore_agent", "depends_on": []},
                {"task_idx": "1", "goal": "Write", "tool_name": "reasoning", "depends_on": ["0"]},
            ],
            "join": "all",
            "title": "Test Plan",
        }
    )
    assert result is None


def test_validate_planner_result_no_tasks():
    """validate_planner_result errors on empty tasks."""
    from tools.set_plan import _validate_planner_result

    err = _validate_planner_result({"tasks": [], "join": "all"})
    assert err is not None and "No tasks" in err


def test_validate_planner_result_invalid_join():
    """validate_planner_result errors on invalid join value."""
    from tools.set_plan import _validate_planner_result

    err = _validate_planner_result(
        {
            "tasks": [{"goal": "A", "tool_name": "reasoning", "depends_on": []}],
            "join": "invalid",
        }
    )
    assert err is not None and "join" in err.lower()


def test_validate_planner_result_requires_string_task_idx():
    """Each task must include its own 0-based string index."""
    from tools.set_plan import _validate_planner_result

    err = _validate_planner_result(
        {
            "tasks": [{"goal": "A", "tool_name": "reasoning", "depends_on": []}],
            "join": "all",
        }
    )
    assert err is not None
    assert "task_idx" in err
    assert "string" in err


def test_validate_planner_result_rejects_mismatched_task_idx():
    """tasks[].task_idx is advisory only, but it must match the array position."""
    from tools.set_plan import _validate_planner_result

    err = _validate_planner_result(
        {
            "tasks": [
                {"task_idx": "1", "goal": "A", "tool_name": "reasoning", "depends_on": []},
            ],
            "join": "all",
        }
    )
    assert err is not None
    assert "0-based array position" in err


def test_validate_planner_result_uses_task_depends_on():
    """task.depends_on is the single source of truth for dependencies."""
    from tools.set_plan import _validate_planner_result

    err = _validate_planner_result(
        {
            "tasks": [
                {"task_idx": "0", "goal": "A", "tool_name": "reasoning", "depends_on": []},
                {"task_idx": "1", "goal": "B", "tool_name": "reasoning", "depends_on": ["0"]},
            ],
            "join": "all",
        }
    )
    assert err is None


def test_validate_planner_result_propagates_dep_error():
    """validate_planner_result returns dependency-validation error."""
    from tools.set_plan import _validate_planner_result

    err = _validate_planner_result(
        {
            "tasks": [
                {"task_idx": "0", "goal": "A", "tool_name": "reasoning", "depends_on": ["1"]},
                {"task_idx": "1", "goal": "B", "tool_name": "reasoning", "depends_on": ["0"]},
            ],
            "join": "all",
        }
    )
    # cycle detected
    assert err is not None and "cycle" in err.lower()


# ── convert_dependencies_list_to_dict ────────────────────────────────────


def test_convert_deps_list_to_dict():
    """Conversion from list format to dict format."""
    from domains.set_plan.service import convert_dependencies_list_to_dict

    result = convert_dependencies_list_to_dict(
        [
            {"task_idx": "0", "depends_on": []},
            {"task_idx": "1", "depends_on": ["0"]},
        ]
    )
    assert result == {"0": [], "1": ["0"]}


def test_convert_deps_empty_list():
    """Empty list returns empty dict."""
    from domains.set_plan.service import convert_dependencies_list_to_dict

    assert convert_dependencies_list_to_dict([]) == {}


def test_convert_deps_skips_missing_task_idx():
    """Entries without task_idx are skipped."""
    from domains.set_plan.service import convert_dependencies_list_to_dict

    result = convert_dependencies_list_to_dict(
        [
            {"task_idx": "", "depends_on": []},
            {"task_idx": "0", "depends_on": []},
        ]
    )
    assert result == {"0": []}


# ── build_plan_data & build_plan_message ─────────────────────────────────


def test_build_plan_data_maps_fields():
    """build_plan_data returns PlanData TypedDict with all fields."""
    from domains.set_plan.service import build_plan_data

    plan_data = build_plan_data(
        {
            "tasks": [
                {"goal": "Research", "tool_name": "spawn_explore_agent", "depends_on": []},
                {"goal": "Synthesize", "tool_name": "reasoning", "depends_on": ["0"]},
            ],
            "title": "Plan A",
            "join": "all",
        }
    )
    assert plan_data["type"] == "plan_artifact"
    assert plan_data["title"] == "Plan A"
    assert plan_data["content"] == ""
    assert plan_data["status"] == "planning"
    assert plan_data["join"] == "all"
    assert len(plan_data["tasks"]) == 2
    assert plan_data["tasks"][0]["goal"] == "Research"
    assert plan_data["tasks"][0]["tool_name"] == "spawn_explore_agent"
    assert plan_data["dependencies"] == {"0": [], "1": ["0"]}


def test_build_plan_message_join_any():
    """join='any' yields hypothesis message."""
    from domains.set_plan.service import build_plan_message

    msg = build_plan_message(
        {
            "type": "plan_artifact",
            "title": "Explore",
            "content": "",
            "tasks": [
                {"goal": "A", "tool_name": "reasoning"},
                {"goal": "B", "tool_name": "reasoning"},
            ],
            "dependencies": {},
            "join": "any",
            "status": "planning",
        }
    )
    assert "hypotheses" in msg
    assert "2" in msg


def test_build_plan_message_parallel_no_deps():
    """With no dependencies, tasks execute in parallel."""
    from domains.set_plan.service import build_plan_message

    msg = build_plan_message(
        {
            "type": "plan_artifact",
            "title": "Parallel",
            "content": "",
            "tasks": [
                {"goal": "A", "tool_name": "reasoning"},
                {"goal": "B", "tool_name": "reasoning"},
                {"goal": "C", "tool_name": "reasoning"},
            ],
            "dependencies": {},
            "join": "all",
            "status": "planning",
        }
    )
    assert "parallel" in msg.lower()


def test_build_plan_message_sequential():
    """Linear chain is labelled sequential."""
    from domains.set_plan.service import build_plan_message

    msg = build_plan_message(
        {
            "type": "plan_artifact",
            "title": "Sequential Plan",
            "content": "",
            "tasks": [
                {"goal": "A", "tool_name": "reasoning"},
                {"goal": "B", "tool_name": "reasoning"},
                {"goal": "C", "tool_name": "reasoning"},
            ],
            "dependencies": {"1": ["0"], "2": ["1"]},
            "join": "all",
            "status": "planning",
        }
    )
    assert "sequential" in msg.lower()


def test_build_plan_message_dag():
    """Non-linear graph is labelled staged/DAG."""
    from domains.set_plan.service import build_plan_message

    msg = build_plan_message(
        {
            "type": "plan_artifact",
            "title": "Staged Plan",
            "content": "",
            "tasks": [
                {"goal": "A", "tool_name": "reasoning"},
                {"goal": "B", "tool_name": "reasoning"},
                {"goal": "C", "tool_name": "reasoning"},
            ],
            "dependencies": {"2": ["0", "1"]},
            "join": "all",
            "status": "planning",
        }
    )
    assert "staged" in msg.lower() or "dependencies" in msg.lower()
    assert "1. A" in msg
    assert "2. B" in msg
    assert "3. C" in msg
    assert "Dependency Graph" in msg
    assert "Task 3 depends on: 1, 2" in msg


# ── get_planner_tools_description ───────────────────────────────────────


def test_get_planner_tools_description_non_empty():
    """Planner tool description includes compact LLM-facing schemas."""
    from domains.set_plan.service import get_planner_tools_description

    desc = get_planner_tools_description()
    assert isinstance(desc, str)
    assert len(desc) > 0
    # Should mention at least one well-known execute-phase tool
    assert "spawn_agent" in desc
    assert "### spawn_agent" in desc
    assert "Purpose:" in desc
    assert "LLM-facing Pydantic arguments" in desc
    assert '"arguments"' in desc
    assert '"description"' in desc
    assert '"required"' in desc
    assert '"properties"' not in desc
    assert "$defs" not in desc


def test_planner_tools_description_lists_only_assignable_tools():
    """The planner sees only execute tools a DAG task can be assigned (via TOOL_ALIASES)."""
    from domains.set_plan.service import get_planner_tools_description
    from utils.tool_schemas import PLANNER_ASSIGNABLE_TOOLS, PLANNER_EXECUTE_TOOLS, TOOL_ALIASES

    desc = get_planner_tools_description()
    headers = {line[4:] for line in desc.splitlines() if line.startswith("### ")}
    assert headers == set(PLANNER_EXECUTE_TOOLS), headers
    assert headers == {
        "spawn_agent",
        "wait_for",
        "call_phone_number",
        "message_person",
        "send_message_to_user_execute_phase",
    }, headers
    assert all(TOOL_ALIASES.get(name, name) in headers or name == "reasoning" for name in PLANNER_ASSIGNABLE_TOOLS)
    for hidden in ("kill_agent", "send_message_to_agent", "attempt_completion"):
        assert hidden not in desc, hidden
    wait_for_section = desc.split("### wait_for\n", 1)[1].split("\n### ", 1)[0]
    assert '"agents"' in wait_for_section and '"timeout_seconds"' in wait_for_section, wait_for_section


# ── build_planner_messages ──────────────────────────────────────────────


def test_build_planner_messages_basic():
    """build_planner_messages converts context into LLM messages + user_messages list."""
    from domains.set_plan.service import build_planner_messages

    context = [
        {"role": "USER", "text": "Find me a flight to Paris"},
        {"role": "ASSISTANT", "text": "Sure, I'll help."},
        {"role": "USER", "text": "Under $500"},
    ]
    base_messages, user_messages = build_planner_messages(context)

    # GOAL line prepended + 3 context messages
    assert len(base_messages) == 4
    assert base_messages[0]["content"].startswith("GOAL: Find me a flight to Paris")
    assert user_messages == ["Find me a flight to Paris", "Under $500"]


def test_build_planner_messages_agent_rows_are_assistant_and_never_the_goal():
    """Agent messages / notifications: assistant-role Codex bodies, never user_messages / GOAL;
    FE-only (excludeFromModel) rows never reach the planner; a trailing one is settled to user."""
    from domains.set_plan.service import build_planner_messages

    agent_message = {
        "role": "USER",
        "text": "Only pre-seed funds.",
        "metadata": {
            "agentMessage": True,
            "fromAgentPath": "/root",
            "toAgentPath": "/root/funds",
            "messageType": "NEW_TASK",
        },
    }
    notification = {
        "role": "USER",
        "text": "Message Type: FINAL_ANSWER\nTask name: /root/funds\nSender: /root/funds/scan\nPayload:\n4 funds",
        "metadata": {"agentNotification": True, "status": "completed"},
    }
    context = [
        agent_message,
        {"role": "USER", "text": "Find Austin seed funds"},
        {
            "role": "TOOL",
            "text": "bg progress",
            "metadata": {"toolCallId": "t1", "toolStatus": "FINISHED", "excludeFromModel": True},
        },
        notification,
    ]
    base_messages, user_messages = build_planner_messages(context)
    assert user_messages == ["Find Austin seed funds"], user_messages
    assert base_messages[0]["content"].startswith("GOAL: Find Austin seed funds")
    assert not any("bg progress" in str(m["content"]) for m in base_messages)
    assert base_messages[1] == {
        "role": "assistant",
        "content": "Message Type: NEW_TASK\nTask name: /root/funds\nSender: /root\nPayload:\nOnly pre-seed funds.",
    }, base_messages
    # The last message would be stripped as assistant prefill: it is sent as user.
    assert base_messages[-1] == {"role": "user", "content": notification["text"]}, base_messages


def test_build_planner_messages_empty_context():
    """Empty context uses DEFAULT_GOAL."""
    from domains.set_plan.config import DEFAULT_GOAL
    from domains.set_plan.service import build_planner_messages

    base_messages, user_messages = build_planner_messages([])

    assert len(base_messages) == 1
    assert DEFAULT_GOAL in base_messages[0]["content"]
    assert user_messages == []


def test_build_planner_messages_tool_and_system_roles():
    """Declared tool calls keep native roles; system rows remain user notices."""
    from domains.set_plan.service import build_planner_messages

    context = [
        {"role": "USER", "text": "Goal"},
        {
            "role": "ASSISTANT",
            "text": "Delegating research",
            "metadata": {
                "tool_calls": [
                    {
                        "tool": "spawn_agent",
                        "tool_call_id": "call-1",
                        "type": "explore",
                        "goal": "Research example",
                    },
                ]
            },
        },
        {"role": "TOOL", "text": "Result", "metadata": {"toolCallId": "call-1", "title": "Research"}},
        {"role": "SYSTEM", "text": "Note"},
    ]
    base_messages, _ = build_planner_messages(context)
    # goal + user + assistant call + tool result + system notice
    assert len(base_messages) == 5
    assistant_msg = next(m for m in base_messages if m["role"] == "assistant")
    assert assistant_msg["tool_calls"][0]["function"]["name"] == "spawn_agent"
    tool_msg = next(m for m in base_messages if m["role"] == "tool")
    assert tool_msg["tool_call_id"] == "call-1"
    assert tool_msg["name"] == "spawn_agent"
    assert tool_msg["content"] == "Research: Result"
    system_msg = next(m for m in base_messages if "[SYSTEM]" in m["content"])
    assert system_msg["role"] == "user"


def test_build_planner_messages_skips_subagent_work_messages():
    """Planner context excludes spawned-agent work and fanout tree rows."""
    from domains.set_plan.service import build_planner_messages

    context = [
        {"role": "USER", "text": "Goal"},
        {
            "role": "TOOL",
            "text": "Child internal web_search result",
            "metadata": {"toolName": "web_search", "subAgentId": "child-1"},
        },
        {
            "role": "TOOL",
            "text": "Child fanout tree summary",
            "metadata": {
                "toolName": "spawn_general_purpose_agent",
                "toolCallId": "tc:0",
                "subAgentIds": ["child-1"],
                "forEachChild": True,
            },
        },
        {
            "role": "TOOL",
            "text": "Aggregate for_each result",
            "metadata": {"toolName": "spawn_general_purpose_agent_for_each", "toolCallId": "tc"},
        },
    ]

    base_messages, user_messages = build_planner_messages(context)
    serialized = "\n".join(m["content"] for m in base_messages)

    assert user_messages == ["Goal"]
    assert "Child internal web_search result" not in serialized
    assert "Child fanout tree summary" not in serialized
    assert "Aggregate for_each result" in serialized


def test_build_planner_messages_compacts_long_tool_context():
    """Long raw tool outputs are bounded before planner LLM input."""
    from domains.set_plan.service import (
        PLANNER_CONTEXT_FULL_TEXT_LIMIT,
        build_planner_messages,
    )

    message_id = "abcdef01-2345-6789-abcd-ef0123456789"
    long_text = "A" * 7000 + " important middle " + "Z" * 7000
    context = [
        {"role": "USER", "text": "Goal"},
        {
            "role": "TOOL",
            "message_id": message_id,
            "text": f"{long_text}\n\nReference: @ref:message:{message_id}",
        },
    ]

    base_messages, _ = build_planner_messages(context)
    tool_msg = next(m for m in base_messages if "[SYSTEM]" in m["content"])

    assert len(tool_msg["content"]) < len(long_text)
    assert len(tool_msg["content"]) < PLANNER_CONTEXT_FULL_TEXT_LIMIT
    assert "Planner context shortened" in tool_msg["content"]
    assert "@ref:message:" not in tool_msg["content"]
    assert "important middle" not in tool_msg["content"]
    assert "A" * 100 in tool_msg["content"]
    assert "Z" * 100 in tool_msg["content"]


def test_build_planner_messages_compacts_large_tool_outputs():
    """Raw tool output must not blow up planner context on replans."""
    from domains.set_plan.service import PLANNER_CONTEXT_CHAR_BUDGET, build_planner_messages

    large_result = "alpha " + ("tool-output " * 20_000) + " omega"
    context = [{"role": "USER", "text": "Compare cities"}]
    for i in range(80):
        context.append({"role": "TOOL", "text": f"Result {i}: {large_result}"})

    base_messages, user_messages = build_planner_messages(context)

    total_chars = sum(len(m["content"]) for m in base_messages)
    assert total_chars <= PLANNER_CONTEXT_CHAR_BUDGET
    assert base_messages[0]["content"].startswith("GOAL: Compare cities")
    assert user_messages == ["Compare cities"]
    assert any("planner context compacted" in m["content"].lower() for m in base_messages)
    assert any("omega" in m["content"] for m in base_messages)


def test_build_planner_messages_keeps_large_tool_arguments_valid_json():
    """Persisted native arguments stay parseable after planner compaction."""
    from domains.set_plan.service import PLANNER_CONTEXT_FULL_TEXT_LIMIT, build_planner_messages

    context = [
        {"role": "USER", "text": "Delegate a research task"},
        {
            "role": "ASSISTANT",
            "text": "",
            "metadata": {
                "tool_calls": [
                    {
                        "tool": "spawn_agent",
                        "tool_call_id": "large-args",
                        "type": "explore",
                        "goal": 'Research "quoted" material\n' * 2_000,
                    }
                ]
            },
        },
        {
            "role": "TOOL",
            "text": "Research completed",
            "metadata": {"toolCallId": "large-args", "toolName": "spawn_agent"},
        },
    ]

    messages, _ = build_planner_messages(context)
    declaration = next(message for message in messages if message.get("tool_calls"))
    arguments = declaration["tool_calls"][0]["function"]["arguments"]
    decoded = json.loads(arguments)
    assert len(arguments) <= PLANNER_CONTEXT_FULL_TEXT_LIMIT
    assert "_rose_compacted_arguments" in decoded


def test_build_planner_messages_filters_non_planner_tools_and_repairs_pairs():
    """Execute-only and duplicate calls never reach native planner history."""
    from domains.set_plan.service import build_planner_messages

    context = [
        {"role": "USER", "text": "Plan this"},
        {
            "role": "ASSISTANT",
            "text": "",
            "metadata": {
                "tool_calls": [
                    {"tool": "wait_for", "tool_call_id": "execute-only", "seconds": 1},
                    {
                        "tool": "spawn_agent",
                        "tool_call_id": "valid-call",
                        "type": "explore",
                        "goal": "research",
                    },
                ]
            },
        },
        {
            "role": "ASSISTANT",
            "text": "duplicate replay",
            "metadata": {
                "tool_calls": [
                    {
                        "tool": "spawn_agent",
                        "tool_call_id": "valid-call",
                        "type": "explore",
                        "goal": "again",
                    }
                ]
            },
        },
        {
            "role": "TOOL",
            "text": "research complete",
            "metadata": {"toolCallId": "valid-call", "toolName": "spawn_agent"},
        },
        {
            "role": "TOOL",
            "text": "wait complete",
            "metadata": {"toolCallId": "execute-only", "toolName": "wait_for"},
        },
    ]

    messages, _ = build_planner_messages(context)
    calls = [call for message in messages for call in message.get("tool_calls", [])]
    assert [call["id"] for call in calls] == ["valid-call"]
    assert all(call["function"]["name"] != "wait_for" for call in calls)
    tool_rows = [message for message in messages if message.get("role") == "tool"]
    assert [message["tool_call_id"] for message in tool_rows] == ["valid-call"]
    assert any("wait complete" in str(message.get("content")) for message in messages)


def test_build_planner_messages_skips_empty_text():
    """Messages with empty text are skipped."""
    from domains.set_plan.service import build_planner_messages

    context = [
        {"role": "USER", "text": "Goal"},
        {"role": "ASSISTANT", "text": ""},
        {"role": "USER", "text": ""},
    ]
    base_messages, user_messages = build_planner_messages(context)
    # GOAL line + one USER message
    assert len(base_messages) == 2
    # Empty user text is not included in user_messages
    assert user_messages == ["Goal"]


def test_build_planner_messages_no_outbound_http():
    """Helper is pure — no outbound HTTP calls."""
    from domains.set_plan.service import build_planner_messages

    build_planner_messages([{"role": "USER", "text": "hi"}])
    assert len(get_captured_requests()) == 0


def test_no_outbound_http_calls():
    """set_plan validation helpers make zero outbound HTTP calls."""
    from tools.set_plan import validate_dependencies

    validate_dependencies(["A", "B"], {"1": ["0"]})
    assert len(get_captured_requests()) == 0


# =========================================================================
# SetPlanManager tests - patch workflow module and run_planner_attempt
# =========================================================================


class _FakeWorkflowModule:
    """Minimal stand-in for temporalio.workflow used by handler."""

    def __init__(self):
        self.logger = type("L", (), {"info": lambda *a, **kw: None, "error": lambda *a, **kw: None})()

    def now(self):
        return datetime.now(timezone.utc)


def _patch_handler_workflow(fake_workflow):
    import domains.set_plan.handler as h

    original = h.workflow
    h.workflow = fake_workflow

    def restore():
        h.workflow = original

    return restore


async def _collect_events(gen):
    events = []
    async for e in gen:
        events.append(e)
    return events


class _FakeWFInstance:
    def __init__(self, context=None, *, output_schema=None):
        self.context = context or [{"role": "USER", "text": "Find flights"}]
        self.output_schema = output_schema
        self.user_context_section = "Name: Test User"
        self.user_id = "user-1"
        self.agent_id = "agent-1"
        self.claude_max_token = None
        self.gpt_code_token = "gpt-token-1"
        self.gpt_code_account_id = "acct-1"
        self.gpt_code_token_source = "pool"
        self.gpt_code_token_pool_id = "pool-token-1"
        self.refreshes = 0

    async def _refresh_claude_token(self, user_id):
        self.refreshes += 1

    def _active_claude_token(self):
        return None

    def _active_gpt_token(self):
        return self.gpt_code_token

    def _active_gpt_account_id(self):
        return self.gpt_code_account_id

    def _active_gpt_source(self):
        return self.gpt_code_token_source

    def _active_gpt_pool_id(self):
        return self.gpt_code_token_pool_id

    async def _track_usage(self, *a, **kw):
        pass


async def test_handler_happy_path_first_try():
    """Planner returns valid plan on first attempt -> FINISHED event."""
    from domains.set_plan.handler import SetPlanManager
    from tools.base import MessageStatus

    valid_plan = {
        "tasks": [
            {"task_idx": "0", "goal": "A", "tool_name": "reasoning", "depends_on": []},
            {"task_idx": "1", "goal": "B", "tool_name": "reasoning", "depends_on": ["0"]},
        ],
        "title": "Test Plan",
        "join": "all",
    }

    fake_wf = _FakeWorkflowModule()
    restore = _patch_handler_workflow(fake_wf)

    # Also patch run_planner_attempt to return the plan directly.
    import domains.set_plan.handler as h

    original_runner = h.run_planner_attempt
    runner_mock = AsyncMock(return_value=valid_plan)
    h.run_planner_attempt = runner_mock
    try:
        wf = _FakeWFInstance()
        events = await _collect_events(
            SetPlanManager().execute_tool(workflow_instance=wf, tool_call={}, tool_call_id="tc-1")
        )
    finally:
        h.run_planner_attempt = original_runner
        restore()

    statuses = [e.status for e in events]
    assert MessageStatus.FINISHED in statuses
    runner_mock.assert_awaited_once()
    planner_kwargs = runner_mock.await_args.kwargs
    assert planner_kwargs["claude_max_token"] is None
    assert planner_kwargs["gpt_token"] == "gpt-token-1"
    assert planner_kwargs["gpt_account_id"] == "acct-1"
    assert planner_kwargs["gpt_token_source"] == "pool"
    assert planner_kwargs["gpt_token_pool_id"] == "pool-token-1"
    finished = next(e for e in events if e.status == MessageStatus.FINISHED)
    assert finished.title == "Test Plan"
    assert finished.data["type"] == "plan_artifact"


async def test_handler_retries_emit_retry_event():
    """Invalid first attempt triggers retry yielding IN_PROGRESS retry event."""
    from domains.set_plan.handler import SetPlanManager
    from tools.base import MessageStatus

    bad_plan = {"tasks": [], "dependencies_graph": [], "join": "all"}

    fake_wf = _FakeWorkflowModule()
    restore = _patch_handler_workflow(fake_wf)

    import domains.set_plan.handler as h

    original_runner = h.run_planner_attempt
    h.run_planner_attempt = AsyncMock(return_value=bad_plan)
    try:
        wf = _FakeWFInstance()
        events = await _collect_events(
            SetPlanManager().execute_tool(workflow_instance=wf, tool_call={}, tool_call_id="tc-r")
        )
    finally:
        h.run_planner_attempt = original_runner
        restore()

    # Expect an IN_PROGRESS retry event (emitted between attempts)
    titles = [e.title for e in events]
    assert any("Retrying" in (t or "") for t in titles)
    # Final status is an ERROR since plan never validated
    assert any(e.status == MessageStatus.ERROR for e in events)


async def test_handler_fails_after_all_retries():
    """Persistently invalid plan leads to Plan Validation Failed error."""
    from domains.set_plan.handler import SetPlanManager
    from tools.base import MessageStatus

    bad_plan = {"tasks": [], "dependencies_graph": [], "join": "all"}
    fake_wf = _FakeWorkflowModule()
    restore = _patch_handler_workflow(fake_wf)

    import domains.set_plan.handler as h

    original_runner = h.run_planner_attempt
    h.run_planner_attempt = AsyncMock(return_value=bad_plan)
    try:
        wf = _FakeWFInstance()
        events = await _collect_events(
            SetPlanManager().execute_tool(workflow_instance=wf, tool_call={}, tool_call_id="tc-f")
        )
    finally:
        h.run_planner_attempt = original_runner
        restore()

    error = next((e for e in events if e.status == MessageStatus.ERROR), None)
    assert error is not None
    assert "Validation" in error.title


async def test_handler_planner_exception_yields_error():
    """Planner raising exception yields a Planner Error event."""
    from domains.set_plan.handler import SetPlanManager
    from tools.base import MessageStatus

    fake_wf = _FakeWorkflowModule()
    restore = _patch_handler_workflow(fake_wf)

    import domains.set_plan.handler as h

    original_runner = h.run_planner_attempt

    async def boom(**kwargs):
        raise RuntimeError("planner exploded")

    h.run_planner_attempt = boom
    try:
        wf = _FakeWFInstance()
        events = await _collect_events(
            SetPlanManager().execute_tool(workflow_instance=wf, tool_call={}, tool_call_id="tc-x")
        )
    finally:
        h.run_planner_attempt = original_runner
        restore()

    error = next(e for e in events if e.status == MessageStatus.ERROR)
    assert "Planner Error" in error.title
    assert "planner exploded" in error.message


# =========================================================================
# service.run_planner_attempt tests
# =========================================================================
# Note: _apply_generated_schema was removed when schema generation moved to
# the workflow startup path (set_response_schema_activity in
# agents/workflows/agent_workflow.py). Tests for it were deleted alongside
# the production code.


def _patch_service_workflow(fake_workflow):
    import domains.set_plan.service as svc

    original = svc.workflow
    svc.workflow = fake_workflow

    def restore():
        svc.workflow = original

    return restore


async def test_run_planner_attempt_passes_the_world_cursor_only_in_simulate_mode():
    """The planner gets the last world-time cursor in simulate mode; real-mode args are unchanged."""
    from domains.set_plan.service import run_planner_attempt

    captured: list = []

    class _CaptureWorkflow(_FakeWorkflowModule):
        async def execute_activity(self, fn, *args, **kwargs):
            captured.append(list(kwargs["args"]))
            return {"result": {"title": "t", "join": "all", "tasks": []}, "usage": {}}

    cursor = 1_791_000_000_000
    real = _FakeWFInstance()
    real.world_model_mode = "real"
    real.simulated_world_time_ms = cursor  # ignored outside simulate
    simulated = _FakeWFInstance()
    simulated.world_model_mode = "simulate"
    simulated.simulated_world_time_ms = cursor
    restore = _patch_service_workflow(_CaptureWorkflow())
    try:
        for instance in (_FakeWFInstance(), real, simulated):
            await run_planner_attempt(
                workflow_instance=instance,
                messages=[{"role": "user", "content": "goal"}],
                tools_description="tools",
                user_context="",
                response_schema=None,
                claude_max_token=None,
                gpt_token=None,
                gpt_account_id=None,
                gpt_token_source=None,
                gpt_token_pool_id=None,
                user_messages=["goal"],
                tool_call_id="tc-1",
                attempt=0,
            )
    finally:
        restore()
    assert len(captured[0]) == len(captured[1]) == 22 and captured[0] == captured[1]
    assert captured[2] == captured[0] + [cursor]


async def test_run_planner_attempt_redelivers_after_dead_worker():
    """Planner activity must be stealable if the assigned worker dies.

    Production agent 292022e4 sat on Generating Plan for 241s because
    call_planner_llm_activity was scheduled with only start_to_close=240s
    and heartbeat_timeout=0. Temporal recorded attempt 1 as
    `activity StartToClose timeout` with no STARTED event, then attempt 2
    completed the same plan in 22s on a different worker. The 240s budget
    is for LLM work, not worker liveness.
    """
    from datetime import timedelta

    from domains.set_plan.config import (
        PLANNER_ACTIVITY_HEARTBEAT_TIMEOUT_SECONDS,
        PLANNER_ACTIVITY_TIMEOUT_SECONDS,
    )
    from domains.set_plan.service import run_planner_attempt

    captured: dict = {}

    class _CaptureWorkflow(_FakeWorkflowModule):
        async def execute_activity(self, fn, *args, **kwargs):
            captured["fn"] = getattr(fn, "__name__", str(fn))
            captured.update(kwargs)
            return {
                "result": {
                    "title": "t",
                    "join": "all",
                    "tasks": [{"task_idx": "0", "goal": "A", "tool_name": "reasoning", "depends_on": []}],
                },
                "usage": {},
            }

    fake_wf = _CaptureWorkflow()
    restore = _patch_service_workflow(fake_wf)
    try:
        await run_planner_attempt(
            workflow_instance=_FakeWFInstance(),
            messages=[{"role": "user", "content": "goal"}],
            tools_description="tools",
            user_context="",
            response_schema=None,
            claude_max_token=None,
            gpt_token=None,
            gpt_account_id=None,
            gpt_token_source=None,
            gpt_token_pool_id=None,
            user_messages=["goal"],
            tool_call_id="tc-1",
            attempt=0,
        )
    finally:
        restore()

    assert captured.get("fn") == "call_planner_llm_activity"
    start_to_close = captured.get("start_to_close_timeout")
    heartbeat = captured.get("heartbeat_timeout")
    assert start_to_close == timedelta(seconds=PLANNER_ACTIVITY_TIMEOUT_SECONDS)
    assert heartbeat == timedelta(seconds=PLANNER_ACTIVITY_HEARTBEAT_TIMEOUT_SECONDS), (
        "heartbeat_timeout must be 30s so a StartToClose-started assignment that "
        "never heartbeats is redelivered instead of burning the 240s LLM budget"
    )
    assert heartbeat < start_to_close

    local_instance = _FakeWFInstance()
    local_instance.model = "rose-labs/rose-local"
    restore = _patch_service_workflow(fake_wf)
    try:
        await run_planner_attempt(
            workflow_instance=local_instance,
            messages=[{"role": "user", "content": "goal"}],
            tools_description="tools",
            user_context="",
            response_schema=None,
            claude_max_token=None,
            gpt_token=None,
            gpt_account_id=None,
            gpt_token_source=None,
            gpt_token_pool_id=None,
            user_messages=["goal"],
            tool_call_id="tc-local",
            attempt=0,
        )
    finally:
        restore()
    assert captured["args"][1] == "rose-labs/rose-local", "Local planner must stay on local inference"
    assert captured.get("schedule_to_start_timeout") is None, (
        "A short schedule_to_start with max_attempts=2 can fail a healthy pickup "
        "that would have succeeded inside the 240s StartToClose budget"
    )
    retry = captured.get("retry_policy")
    assert retry is not None
    assert retry.maximum_attempts == 2

    import inspect

    from helpers.llm import PLANNER_ACTIVITY_HEARTBEAT_INTERVAL_SECONDS, call_planner_llm_activity

    source = inspect.getsource(call_planner_llm_activity)
    assert "_planner_liveness_heartbeat" in source
    assert "planner liveness" in source
    assert PLANNER_ACTIVITY_HEARTBEAT_INTERVAL_SECONDS * 2 < PLANNER_ACTIVITY_HEARTBEAT_TIMEOUT_SECONDS, (
        "the activity's liveness beat must fit at least twice inside the scheduled heartbeat_timeout"
    )


async def run_all_tests():
    print("set-plan blackbox tests:")
    r = BlackboxResult()
    # validate_dependencies
    r.record("validate_deps_valid", test_validate_dependencies_valid)
    r.record("validate_deps_empty", test_validate_dependencies_empty_deps_is_valid)
    r.record("validate_deps_cycle", test_validate_dependencies_cycle)
    r.record("validate_deps_self", test_validate_dependencies_self_dependency)
    r.record("validate_deps_non_numeric_task", test_validate_dependencies_non_numeric_task_idx)
    r.record("validate_deps_task_out_of_range", test_validate_dependencies_out_of_range_task)
    r.record("validate_deps_preds_not_list", test_validate_dependencies_preds_not_list)
    r.record("validate_deps_non_numeric_pred", test_validate_dependencies_non_numeric_predecessor)
    r.record("validate_deps_pred_out_of_range", test_validate_dependencies_out_of_range_predecessor)
    # validate_planner_result
    r.record("validate_planner_result", test_validate_planner_result_valid)
    r.record("validate_planner_result_no_tasks", test_validate_planner_result_no_tasks)
    r.record("validate_planner_result_invalid_join", test_validate_planner_result_invalid_join)
    r.record("validate_planner_result_requires_task_idx", test_validate_planner_result_requires_string_task_idx)
    r.record("validate_planner_result_task_idx_mismatch", test_validate_planner_result_rejects_mismatched_task_idx)
    r.record("validate_planner_result_task_deps_source", test_validate_planner_result_uses_task_depends_on)
    r.record("validate_planner_result_dep_err", test_validate_planner_result_propagates_dep_error)
    # convert_deps
    r.record("convert_deps_list_to_dict", test_convert_deps_list_to_dict)
    r.record("convert_deps_empty", test_convert_deps_empty_list)
    r.record("convert_deps_skips_missing", test_convert_deps_skips_missing_task_idx)
    # build_plan_data / build_plan_message
    r.record("build_plan_data", test_build_plan_data_maps_fields)
    r.record("build_plan_message_any", test_build_plan_message_join_any)
    r.record("build_plan_message_parallel", test_build_plan_message_parallel_no_deps)
    r.record("build_plan_message_sequential", test_build_plan_message_sequential)
    r.record("build_plan_message_dag", test_build_plan_message_dag)
    # tools description
    r.record("planner_tools_description", test_get_planner_tools_description_non_empty)
    r.record("planner_tools_description_assignable_only", test_planner_tools_description_lists_only_assignable_tools)
    # build_planner_messages
    r.record("build_planner_messages_basic", test_build_planner_messages_basic)
    r.record(
        "build_planner_messages_agent_rows_assistant",
        test_build_planner_messages_agent_rows_are_assistant_and_never_the_goal,
    )
    r.record("build_planner_messages_empty", test_build_planner_messages_empty_context)
    r.record("build_planner_messages_tool_system", test_build_planner_messages_tool_and_system_roles)
    r.record(
        "build_planner_messages_skips_subagent_work",
        test_build_planner_messages_skips_subagent_work_messages,
    )
    r.record(
        "build_planner_messages_compacts_long_tool_context", test_build_planner_messages_compacts_long_tool_context
    )
    r.record("build_planner_messages_compacts_tool_outputs", test_build_planner_messages_compacts_large_tool_outputs)
    r.record(
        "build_planner_messages_valid_large_arguments",
        test_build_planner_messages_keeps_large_tool_arguments_valid_json,
    )
    r.record(
        "build_planner_messages_filters_and_pairs_tools",
        test_build_planner_messages_filters_non_planner_tools_and_repairs_pairs,
    )
    r.record("build_planner_messages_empty_text", test_build_planner_messages_skips_empty_text)
    r.record("build_planner_messages_no_http", test_build_planner_messages_no_outbound_http)
    r.record("no_outbound_http_calls", test_no_outbound_http_calls)
    # SetPlanManager.execute_tool paths
    await r.record_async("handler_happy_path", test_handler_happy_path_first_try)
    await r.record_async("handler_retries_emit_event", test_handler_retries_emit_retry_event)
    await r.record_async("handler_fails_after_retries", test_handler_fails_after_all_retries)
    await r.record_async("handler_planner_exception", test_handler_planner_exception_yields_error)
    await r.record_async(
        "run_planner_attempt_passes_world_cursor_only_in_simulate",
        test_run_planner_attempt_passes_the_world_cursor_only_in_simulate_mode,
    )
    await r.record_async(
        "planner_activity_redelivers_after_dead_worker",
        test_run_planner_attempt_redelivers_after_dead_worker,
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
