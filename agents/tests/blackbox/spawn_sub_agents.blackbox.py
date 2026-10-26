"""Blackbox tests for spawn-sub-agents domain."""

import asyncio
import json
import uuid
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
        "/api/agents": {
            "status": 200,
            "json": {
                "agent_id": "sub-agent-1",
                "temporal_workflow_id": "wf-sub-1",
                "goal": "Research competitors",
                "model": "rose-labs/rose-1-flash",
                "status": "RUNNING",
            },
        },
    })


async def test_spawn_sub_agent_happy_path():
    """spawn_sub_agent_activity creates sub-agents via backend."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.spawn_sub_agents import spawn_sub_agent_activity

        result = await spawn_sub_agent_activity(
            user_id="user-42",
            sub_agents=[{"goal": "Research competitors"}],
            parent_agent_id="agent-parent",
            parent_workflow_id="wf-parent",
            depth=0,
            parent_is_paused=False,
            parent_model="rose-labs/rose-1-flash",
        )

    assert "agents" in result
    assert result["spawned"] == 1


async def test_spawn_sub_agent_boundary():
    """Verify POST request to backend /api/agents endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.spawn_sub_agents import spawn_sub_agent_activity

        await spawn_sub_agent_activity(
            user_id="user-99",
            sub_agents=[{"goal": "Find leads"}],
            parent_agent_id="agent-parent-2",
            parent_workflow_id="wf-parent-2",
            depth=1,
            parent_is_paused=False,
        )

    call = assert_captured_call(
        index=1,
        url_contains="/api/agents",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body["goal"] == "Find leads"
    assert body["parent_agent_id"] == "agent-parent-2"


# ── extract_file_pointers_from_structured_response ─────────────────────


def test_extract_file_pointers_single_pointer():
    """Single file_pointer field is extracted when valid."""
    from domains.spawn_sub_agents.service import extract_file_pointers_from_structured_response

    schema = {"fields": [{"name": "report", "type": "file_pointer"}]}
    resp = {"report": {"id": "fp-1", "storage_path": "u/1/report.pdf"}}
    pointers = extract_file_pointers_from_structured_response(resp, schema)
    assert len(pointers) == 1
    assert pointers[0]["id"] == "fp-1"


def test_extract_file_pointers_list():
    """list[file_pointer] extracts every valid element."""
    from domains.spawn_sub_agents.service import extract_file_pointers_from_structured_response

    schema = {"fields": [{"name": "files", "type": "list[file_pointer]"}]}
    resp = {
        "files": [
            {"id": "fp-1", "storage_path": "p1"},
            {"id": "fp-2", "storage_path": "p2"},
            {"bad": True},  # skipped
            None,  # skipped
        ],
    }
    pointers = extract_file_pointers_from_structured_response(resp, schema)
    assert len(pointers) == 2


def test_extract_file_pointers_nested_object():
    """object/list[object] fields recursively extract nested file_pointer values."""
    from domains.spawn_sub_agents.service import extract_file_pointers_from_structured_response

    schema = {
        "fields": [
            {
                "name": "variant",
                "type": "object",
                "properties": [
                    {"name": "color", "type": "str"},
                    {"name": "file", "type": "file_pointer"},
                ],
            },
            {
                "name": "frames",
                "type": "list[object]",
                "properties": [
                    {"name": "index", "type": "int"},
                    {"name": "image", "type": "file_pointer"},
                ],
            },
        ]
    }
    resp = {
        "variant": {"color": "green", "file": {"id": "fp-green", "storage_path": "u/green.png"}},
        "frames": [
            {"index": 1, "image": {"id": "fp-frame", "storage_path": "u/frame.png"}},
            {"index": 2, "image": {"path": "/not/full.png"}},
        ],
    }

    pointers = extract_file_pointers_from_structured_response(resp, schema)
    assert [fp["id"] for fp in pointers] == ["fp-green", "fp-frame"]


def test_extract_file_pointers_missing_field():
    """Missing or no-name fields are skipped."""
    from domains.spawn_sub_agents.service import extract_file_pointers_from_structured_response

    schema = {"fields": [{"name": "absent", "type": "file_pointer"}, {"type": "file_pointer"}]}
    resp = {"other": {"id": "x"}}
    assert extract_file_pointers_from_structured_response(resp, schema) == []


def test_extract_file_pointers_empty_inputs():
    """Empty response or schema returns []."""
    from domains.spawn_sub_agents.service import extract_file_pointers_from_structured_response

    assert extract_file_pointers_from_structured_response({}, {"fields": []}) == []
    assert extract_file_pointers_from_structured_response({"a": 1}, {}) == []


def test_extract_file_pointers_unrecognized_type():
    """Non-pointer field types are ignored."""
    from domains.spawn_sub_agents.service import extract_file_pointers_from_structured_response

    schema = {"fields": [{"name": "summary", "type": "string"}]}
    resp = {"summary": "hello"}
    assert extract_file_pointers_from_structured_response(resp, schema) == []


# ── resolve_attachments_for_sub_agent ──────────────────────────────────


def test_resolve_attachments_explicit_by_filename():
    """Explicit filename references resolve from the map."""
    from domains.spawn_sub_agents.service import resolve_attachments_for_sub_agent

    ftp = {"a.pdf": {"id": "fp-a", "original_filename": "a.pdf"}}
    allp = {"fp-a": ftp["a.pdf"]}
    out = resolve_attachments_for_sub_agent({"attachments": ["a.pdf"]}, ftp, allp)
    assert out == [ftp["a.pdf"]]


def test_resolve_attachments_explicit_by_id():
    """File pointer resolved by ID string."""
    from domains.spawn_sub_agents.service import resolve_attachments_for_sub_agent

    ftp = {"a.pdf": {"id": "fp-a", "original_filename": "a.pdf"}}
    allp = {"fp-a": ftp["a.pdf"]}
    out = resolve_attachments_for_sub_agent({"attachments": ["fp-a"]}, ftp, allp)
    assert out == [ftp["a.pdf"]]


def test_resolve_attachments_explicit_unknown_falls_back_to_all():
    """Unknown filenames fall back to auto-forwarding all parent attachments."""
    from domains.spawn_sub_agents.service import resolve_attachments_for_sub_agent

    ftp = {"a.pdf": {"id": "fp-a", "original_filename": "a.pdf"}}
    allp = {"fp-a": ftp["a.pdf"]}
    out = resolve_attachments_for_sub_agent({"attachments": ["nonexistent"]}, ftp, allp)
    assert out == [ftp["a.pdf"]]


def test_resolve_attachments_no_explicit_auto_forwards():
    """No explicit attachments → auto-forward all from parent."""
    from domains.spawn_sub_agents.service import resolve_attachments_for_sub_agent

    ftp = {"a.pdf": {"id": "fp-a", "original_filename": "a.pdf"}}
    allp = {"fp-a": ftp["a.pdf"]}
    out = resolve_attachments_for_sub_agent({}, ftp, allp)
    assert out == [ftp["a.pdf"]]


def test_resolve_attachments_no_parent():
    """No parent attachments and no config → empty list."""
    from domains.spawn_sub_agents.service import resolve_attachments_for_sub_agent

    assert resolve_attachments_for_sub_agent({}, {}, {}) == []


# ── build_spawn_payload ────────────────────────────────────────────────


def test_build_spawn_payload_defaults():
    """Payload contains required keys and defaults."""
    from domains.spawn_sub_agents.service import build_spawn_payload

    payload = build_spawn_payload(
        user_id="u-1",
        agent_cfg={"goal": "G"},
        parent_agent_id="p-1",
        parent_workflow_id="wf-1",
        depth=2,
        parent_is_paused=False,
        parent_model="rose-labs/rose-1-flash",
        bus_id=None,
        parent_source="WEB",
        resolved_attachments=[],
    )
    assert payload["user_id"] == "u-1"
    assert payload["goal"] == "G"
    assert payload["start_phase"] == "plan"
    assert payload["depth"] == 2
    assert payload["source"] == "WEB"
    assert payload["model"] == "rose-labs/rose-1-flash"
    assert payload["max_iterations"] == 25
    assert "verifier" not in payload
    assert "attachments" not in payload  # empty list → omitted
    assert "context_gates" not in payload


def test_build_spawn_payload_bad_start_phase_defaults_to_plan():
    """Unrecognised start_phase falls back to 'plan'."""
    from domains.spawn_sub_agents.service import build_spawn_payload

    payload = build_spawn_payload(
        user_id="u-1",
        agent_cfg={"goal": "G", "start_phase": "weird"},
        parent_agent_id="p-1",
        parent_workflow_id="wf-1",
        depth=0,
        parent_is_paused=True,
        parent_model="rose-labs/rose-1-flash",
        bus_id="bus-1",
        parent_source="MAC_APP",
        resolved_attachments=[{"id": "fp-1"}],
    )
    assert payload["start_phase"] == "plan"
    assert payload["attachments"] == [{"id": "fp-1"}]
    assert payload["pause_state"] is True


def test_build_spawn_payload_execute_phase():
    """Valid 'execute' start_phase is preserved."""
    from domains.spawn_sub_agents.service import build_spawn_payload

    payload = build_spawn_payload(
        user_id="u-1",
        agent_cfg={
            "goal": "G",
            "start_phase": "execute",
            "output_schema": {"fields": []},
            "context_gates": {"network": False},
        },
        parent_agent_id="p-1",
        parent_workflow_id="wf-1",
        depth=0,
        parent_is_paused=False,
        parent_model="rose-labs/rose-1-ultra",
        bus_id="bus-1",
        parent_source="WEB",
        resolved_attachments=[],
    )
    assert payload["start_phase"] == "execute"
    assert payload["response_schema"] == {"fields": []}
    assert payload["context_gates"] == {"network": False}


def test_build_spawn_payload_does_not_forward_parent_context():
    """LLM-spawned sub-agents start from their own goal, not parent transcript."""
    from domains.spawn_sub_agents.service import build_spawn_payload

    payload = build_spawn_payload(
        user_id="u-1",
        agent_cfg={
            "goal": "Child goal",
            "context": [{"role": "USER", "text": "Parent transcript"}],
            "messages": [{"role": "USER", "text": "Parent transcript"}],
        },
        parent_agent_id="p-1",
        parent_workflow_id="wf-1",
        depth=1,
        parent_is_paused=False,
        parent_model="rose-labs/rose-1-flash",
        bus_id="bus-1",
        parent_source="WEB",
        resolved_attachments=[],
    )

    assert "context" not in payload
    assert "messages" not in payload


# ── handler._build_failure_events ──────────────────────────────────────


def test_build_failure_events_basic():
    """Minimal failure context produces a single ToolEvent with error_reason."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager

    events = SpawnSubAgentManager._build_failure_events(
        child_agent_id="c-1",
        child_result={"error_reason": "timeout", "failure_context": {}},
        bus_id="bus-1",
        child_tool_id="tc-1",
    )
    assert len(events) == 1
    ev = events[0]
    assert "Sub-agent failed" in ev.title
    assert "timeout" in ev.message
    assert ev.metadata["subAgentIds"] == ["c-1"]
    assert ev.metadata["busId"] == "bus-1"
    assert ev.metadata["spawnGroupId"] == "tc-1"


def test_build_failure_events_rich_context():
    """All failure_context keys contribute to the rendered message."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager

    events = SpawnSubAgentManager._build_failure_events(
        child_agent_id="c-2",
        child_result={
            "error_reason": "verifier_failed",
            "failure_context": {
                "progress_estimate": "70%",
                "verifier_reasoning": "missing some data",
                "last_reasoning": "Maybe retry later",
                "last_plan": ["step1", "step2", "step3"],
                "trajectory": [
                    {"tool_name": "web_search", "success": True},
                    {"tool_name": "web_fetch", "success": False, "error_message": "timeout"},
                ],
                "partial_structured_response": {
                    "short_value": "abc",
                    "long_value": "y" * 300,
                    "items": [1, 2, 3, 4, 5],
                },
            },
        },
        bus_id="bus-2",
        child_tool_id="tc-2",
    )
    msg = events[0].message
    assert "verifier_failed" in msg
    assert "Progress: 70%" in msg
    assert "missing some data" in msg
    assert "Maybe retry later" in msg
    assert "step1" in msg and "step2" in msg
    assert "web_search" in msg and "web_fetch" in msg
    assert "Partial data extracted:" in msg
    assert "Short Value" in msg  # key formatting
    # Long value truncated
    assert "y" * 200 not in msg
    # List summarized
    assert "[3 items]" in msg or "[5 items]" in msg
    assert events[0].metadata["structured_response"] == {
        "short_value": "abc",
        "long_value": "y" * 300,
        "items": [1, 2, 3, 4, 5],
    }


# ── SpawnSubAgentManager.execute_tool — validation/early-exit branches ──


class _FakeWorkflowInfo:
    workflow_id = "wf-parent"


class _FakeWorkflowModule:
    """Stand-in for temporalio.workflow with enough surface for execute_tool."""

    def __init__(self, activity_result=None, child_results=None, activity_results=None):
        self._activity_result = activity_result
        self._child_results = child_results or {}
        self._activity_results = activity_results or {}

    def info(self):
        return _FakeWorkflowInfo()

    def uuid4(self):
        return uuid.uuid4()

    async def execute_activity(self, fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "?")
        if name in self._activity_results:
            value = self._activity_results[name]
            if isinstance(value, Exception):
                raise value
            return value
        if isinstance(self._activity_result, Exception):
            raise self._activity_result
        return self._activity_result

    def now(self):
        from datetime import datetime, timezone

        return datetime.now(timezone.utc)

    async def wait_condition(self, predicate, timeout=None):
        # Predicate should return True immediately after setup
        # (test pre-populates child_results)
        return None


def _patch_spawn_sub_agents_workflow(fake):
    import domains.spawn_sub_agents.handler as h

    original = h.workflow
    h.workflow = fake

    def restore():
        h.workflow = original

    return restore


class _FakeParentWorkflow:
    """Minimal parent workflow stand-in."""

    def __init__(self, depth=0, bus_id=None):
        self.user_id = "u-1"
        self.agent_id = "parent-agent"
        self.depth = depth
        self.is_paused = False
        self.bus_id = bus_id
        self.goal = "generic parent goal"
        self.demo_cache_goal = None
        self.fast_mode_cache_enabled = False
        self.model = "rose-labs/rose-1-flash"
        self.agent_source = "WEB"
        self.child_tool_ids = {}
        self.pending_children = set()
        self.child_workflow_ids = {}
        self.child_results = {}
        self.posted = []
        self.tree_state_updates = 0

    async def _update_tree_state(self):
        self.tree_state_updates += 1

    async def _post_message(self, message, role, metadata=None):
        self.posted.append({"message": message, "role": role, "metadata": metadata or {}})


async def _collect_events(gen):
    events = []
    async for e in gen:
        events.append(e)
    return events


async def test_execute_tool_missing_sub_agent_yields_error():
    """Empty tool_call yields a single error event and returns."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import MessageStatus

    manager = SpawnSubAgentManager()
    events = await _collect_events(
        manager.execute_tool(_FakeParentWorkflow(), {}, "tc-missing")
    )

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "No sub-agent specified" in events[0].message


async def test_execute_tool_max_depth_exceeded():
    """Depth at MAX_DEPTH yields an error describing the limit."""
    from domains.spawn_sub_agents.config import MAX_DEPTH
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule()
    restore = _patch_spawn_sub_agents_workflow(fake)
    try:
        parent = _FakeParentWorkflow(depth=MAX_DEPTH)
        manager = SpawnSubAgentManager()
        events = await _collect_events(
            manager.execute_tool(
                parent,
                {"sub_agent": {"goal": "g"}},
                "tc-deep",
            )
        )
    finally:
        restore()

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "maximum nesting depth" in events[0].message
    assert str(MAX_DEPTH) in events[0].message


async def test_execute_tool_fast_mode_skips_nested_spawn():
    """Fast Mode children must not recursively spawn more general-purpose agents."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule()
    restore = _patch_spawn_sub_agents_workflow(fake)
    try:
        parent = _FakeParentWorkflow(depth=1)
        parent.fast_mode_cache_enabled = True
        parent.goal = (
            "You are analyzing ONE creator for Andy Prevalsky. "
            "Research public activity in the last 90 days "
            "(approximately 2026-04-04 through 2026-07-03)."  # pragma: allowlist secret
        )
        manager = SpawnSubAgentManager()
        events = await _collect_events(
            manager.execute_tool(
                parent,
                {"sub_agent": {"goal": "synthesize Sahil Bloom"}},
                "tc-nested-fm",
            )
        )
    finally:
        restore()

    assert len(events) == 1
    assert events[0].status == MessageStatus.FINISHED
    assert "skipping nested" in events[0].message


async def test_execute_tool_fast_mode_nested_spawn_other_tasks_still_attempt():
    """Non-demo Fast Mode trees must still attempt nested GP spawns."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(activity_result={"agents": []})
    restore = _patch_spawn_sub_agents_workflow(fake)
    try:
        parent = _FakeParentWorkflow(depth=1)
        parent.fast_mode_cache_enabled = True
        parent.goal = "Find the current population of Tokyo."
        manager = SpawnSubAgentManager()
        events = await _collect_events(
            manager.execute_tool(
                parent,
                {"sub_agent": {"goal": "Tokyo population"}},
                "tc-other-fm",
            )
        )
    finally:
        restore()

    assert events
    assert not any("skipping nested" in str(e.message or "") for e in events)
    assert any(e.status == MessageStatus.ERROR for e in events)


async def test_execute_tool_max_depth_fast_mode_finishes():
    """Fast Mode replay at MAX_DEPTH must FINISH, not ERROR."""
    from domains.spawn_sub_agents.config import MAX_DEPTH
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule()
    restore = _patch_spawn_sub_agents_workflow(fake)
    try:
        parent = _FakeParentWorkflow(depth=MAX_DEPTH)
        parent.fast_mode_cache_enabled = True
        manager = SpawnSubAgentManager()
        events = await _collect_events(
            manager.execute_tool(
                parent,
                {"sub_agent": {"goal": "g"}},
                "tc-deep-fm",
            )
        )
    finally:
        restore()

    assert len(events) == 1
    assert events[0].status == MessageStatus.FINISHED
    assert "skipping further spawn" in events[0].message.lower()
    assert "Fast Mode" not in events[0].message
    assert "fast cache" not in events[0].message.lower()


async def test_execute_tool_empty_agents_list_yields_error():
    """Activity returning {'agents': []} produces 'Failed to spawn' error."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(activity_result={"agents": []})
    restore = _patch_spawn_sub_agents_workflow(fake)
    try:
        parent = _FakeParentWorkflow()
        manager = SpawnSubAgentManager()
        events = await _collect_events(
            manager.execute_tool(
                parent,
                {"sub_agent": {"goal": "g"}},
                "tc-empty",
            )
        )
    finally:
        restore()

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "Failed to spawn" in events[0].message


async def test_execute_tool_child_info_has_error_key():
    """If spawn activity returns an agent with 'error' key, yields error event."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_result={"agents": [{"error": "backend 500"}]}
    )
    restore = _patch_spawn_sub_agents_workflow(fake)
    try:
        parent = _FakeParentWorkflow()
        manager = SpawnSubAgentManager()
        events = await _collect_events(
            manager.execute_tool(
                parent,
                {"sub_agent": {"goal": "g"}},
                "tc-err",
            )
        )
    finally:
        restore()

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "backend 500" in events[0].message


async def test_execute_tool_exception_path_yields_error():
    """Unexpected exception during activity is caught and yields an error event."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(activity_result=RuntimeError("activity boom"))
    restore = _patch_spawn_sub_agents_workflow(fake)
    try:
        parent = _FakeParentWorkflow()
        manager = SpawnSubAgentManager()
        events = await _collect_events(
            manager.execute_tool(
                parent,
                {"sub_agent": {"goal": "g"}},
                "tc-exc",
            )
        )
    finally:
        restore()

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "Error spawning sub-agent" in events[0].message
    assert "activity boom" in events[0].message


async def test_execute_tool_generation_handoff_closes_finished_and_reraises():
    """Cutover while waiting on a child must FINISH, not swallow into ERROR."""
    from helpers.generation_handoff import DEPLOY_INTERRUPTED_TOOL_MESSAGE, GenerationHandoffRequested
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_results={
            "spawn_sub_agent_activity": {
                "agents": [
                    {
                        "agent_id": "child-handoff",
                        "goal": "Wait for approval",
                        "temporal_workflow_id": "wf-child-handoff",
                    }
                ]
            },
            "fetch_child_terminal_result_activity": None,
        }
    )
    restore = _patch_spawn_sub_agents_workflow(fake)
    try:
        parent = _FakeParentWorkflow()

        async def _check_generation_handoff():
            return "navi-agent-tasks@new"

        parent._check_generation_handoff = _check_generation_handoff
        manager = SpawnSubAgentManager()
        events = []
        raised = None
        try:
            async for event in manager.execute_tool(
                parent,
                {"sub_agent": {"goal": "Wait for approval"}},
                "tc-handoff",
            ):
                events.append(event)
        except GenerationHandoffRequested as exc:
            raised = exc
    finally:
        restore()

    assert raised is not None
    assert raised.task_queue == "navi-agent-tasks@new"
    assert all(getattr(e, "status", None) != MessageStatus.ERROR for e in events)
    finished = [e for e in events if getattr(e, "status", None) == MessageStatus.FINISHED]
    assert finished
    assert finished[-1].message == DEPLOY_INTERRUPTED_TOOL_MESSAGE


async def test_execute_tool_happy_path_completes_and_tracks_child():
    """Full happy path: parent tracks child, waits, yields FINISHED with summary."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_result={
            "agents": [
                {
                    "agent_id": "child-1",
                    "goal": "Do the thing",
                    "temporal_workflow_id": "wf-child-1",
                }
            ]
        }
    )
    restore = _patch_spawn_sub_agents_workflow(fake)
    try:
        parent = _FakeParentWorkflow()
        # Pre-populate so wait_condition's predicate is already true.
        parent.child_results["child-1"] = {
            "status": "completed",
            "summary": "all done",
            "structured_response": {},
        }

        manager = SpawnSubAgentManager()
        events = await _collect_events(
            manager.execute_tool(
                parent,
                {"sub_agent": {"goal": "Do the thing"}},
                "tc-happy",
            )
        )
    finally:
        restore()

    # Expect at least IN_PROGRESS then FINISHED
    statuses = [getattr(e, "status", None) for e in events]
    assert MessageStatus.IN_PROGRESS in statuses
    assert MessageStatus.FINISHED in statuses
    # Child tracking populated
    assert "child-1" in parent.child_tool_ids
    assert "child-1" in parent.child_workflow_ids
    # _post_message was called with the child goal
    assert any(p["message"] == "Do the thing" for p in parent.posted)
    # child_results entry popped after completion
    assert "child-1" not in parent.child_results
    # FINISHED event has summary
    finished = [e for e in events if getattr(e, "status", None) == MessageStatus.FINISHED][0]
    assert finished.message == "all done"


async def test_finalize_child_keeps_result_until_finished_event_is_consumed():
    """If FINISHED handling raises, child_results must still be available for recovery."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_result={
            "agents": [
                {
                    "agent_id": "child-keep",
                    "goal": "Keep result",
                    "temporal_workflow_id": "wf-child-keep",
                }
            ]
        }
    )
    restore = _patch_spawn_sub_agents_workflow(fake)
    try:
        parent = _FakeParentWorkflow()
        parent.child_results["child-keep"] = {
            "status": "completed",
            "summary": "still here",
            "structured_response": {},
        }
        manager = SpawnSubAgentManager()
        agen = manager.finalize_child(
            parent,
            {"agent_id": "child-keep", "goal": "Keep result"},
            {"goal": "Keep result"},
            "tc-keep",
            "bus-1",
            for_each_child=True,
        )
        first = await agen.__anext__()
        assert getattr(first, "status", None) == MessageStatus.IN_PROGRESS
        finished = await agen.__anext__()
        assert getattr(finished, "status", None) == MessageStatus.FINISHED
        assert "child-keep" in parent.child_results
        await agen.aclose()
        assert finished.message == "still here"
    finally:
        restore()


async def test_execute_tool_recovers_terminal_child_from_persisted_state():
    """A missed child_completed signal is recovered from the child agent row."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_results={
            "spawn_sub_agent_activity": {
                "agents": [
                    {
                        "agent_id": "child-recovered",
                        "goal": "Do durable thing",
                        "temporal_workflow_id": "wf-child-recovered",
                    }
                ]
            },
            "fetch_child_terminal_result_activity": {
                "status": "completed",
                "summary": "recovered summary",
                "structured_response": {"answer": "42"},
                "tool_counts": {"web_search": 2},
            },
        }
    )
    restore = _patch_spawn_sub_agents_workflow(fake)
    try:
        parent = _FakeParentWorkflow()
        manager = SpawnSubAgentManager()
        events = await _collect_events(
            manager.execute_tool(
                parent,
                {"sub_agent": {"goal": "Do durable thing"}},
                "tc-recovered",
            )
        )
    finally:
        restore()

    finished = [event for event in events if getattr(event, "status", None) == MessageStatus.FINISHED]
    assert len(finished) == 1
    assert finished[0].message == "recovered summary"
    assert finished[0].metadata["structured_response"] == {"answer": "42"}
    assert finished[0].metadata["childToolCounts"] == {"web_search": 2}
    assert "child-recovered" not in parent.pending_children


async def test_execute_tool_happy_path_no_parent_bus_id_sets_it():
    """If parent has no bus_id, handler sets bus_id=parent_agent_id and updates tree state."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager

    fake = _FakeWorkflowModule(
        activity_result={
            "agents": [
                {
                    "agent_id": "child-2",
                    "goal": "x",
                    "temporal_workflow_id": "wf-child-2",
                }
            ]
        }
    )
    restore = _patch_spawn_sub_agents_workflow(fake)
    try:
        parent = _FakeParentWorkflow(bus_id=None)
        parent.child_results["child-2"] = {"status": "completed", "summary": "ok"}

        manager = SpawnSubAgentManager()
        await _collect_events(
            manager.execute_tool(
                parent,
                {"sub_agent": {"goal": "x"}},
                "tc-bus",
            )
        )
    finally:
        restore()

    assert parent.bus_id == "parent-agent"
    assert parent.tree_state_updates == 1


async def test_execute_tool_failed_child_yields_failure_events():
    """child_result.status=='failed' triggers _build_failure_events path."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_result={
            "agents": [
                {"agent_id": "child-f", "goal": "x", "temporal_workflow_id": "wf-f"}
            ]
        }
    )
    restore = _patch_spawn_sub_agents_workflow(fake)
    try:
        parent = _FakeParentWorkflow(bus_id="bus-ext")
        parent.child_results["child-f"] = {
            "status": "failed",
            "error_reason": "timeout",
            "failure_context": {},
        }

        manager = SpawnSubAgentManager()
        events = await _collect_events(
            manager.execute_tool(
                parent,
                {"sub_agent": {"goal": "x"}},
                "tc-failed",
            )
        )
    finally:
        restore()

    # Should end with an ERROR event from _build_failure_events
    error_events = [e for e in events if getattr(e, "status", None) == MessageStatus.ERROR]
    assert len(error_events) == 1
    assert "timeout" in error_events[0].message


async def test_execute_tool_max_iterations_child_is_error_with_best_effort_payload():
    """max_iterations children are failed for UI/DAG but keep partial output."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_result={
            "agents": [
                {"agent_id": "child-max", "goal": "x", "temporal_workflow_id": "wf-max"}
            ]
        }
    )
    restore = _patch_spawn_sub_agents_workflow(fake)
    try:
        parent = _FakeParentWorkflow(bus_id="bus-ext")
        parent.child_results["child-max"] = {
            "status": "max_iterations",
            "message": "Reached max iterations (5)",
            "best_effort_response": "I found partial answer A.",
            "partial_structured_response": {"answer": "partial A"},
            "verifier_reasoning": "not enough sources",
        }

        manager = SpawnSubAgentManager()
        events = await _collect_events(
            manager.execute_tool(
                parent,
                {"sub_agent": {"goal": "x"}},
                "tc-max",
            )
        )
    finally:
        restore()

    error_events = [e for e in events if getattr(e, "status", None) == MessageStatus.ERROR]
    assert len(error_events) == 1
    ev = error_events[0]
    assert "Reached max iterations" in ev.message
    assert "Best-effort result:" in ev.message
    assert "I found partial answer A." in ev.message
    assert ev.metadata["structured_response"] == {"answer": "partial A"}
    assert ev.metadata["partial_structured_response"] == {"answer": "partial A"}
    assert ev.metadata["best_effort_response"] == "I found partial answer A."


async def test_execute_tool_posts_assistant_events_for_file_pointers():
    """Structured response file pointers are posted after the FINISHED tool result."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import AssistantEvent, MessageStatus

    fake = _FakeWorkflowModule(
        activity_result={
            "agents": [
                {"agent_id": "child-fp", "goal": "x", "temporal_workflow_id": "wf-fp"}
            ]
        }
    )
    restore = _patch_spawn_sub_agents_workflow(fake)
    try:
        parent = _FakeParentWorkflow()
        parent.child_results["child-fp"] = {
            "status": "completed",
            "summary": "done",
            "structured_response": {
                "report": {"id": "fp-1", "storage_path": "u/1/r.pdf"},
            },
        }

        manager = SpawnSubAgentManager()
        events = await _collect_events(
            manager.execute_tool(
                parent,
                {
                    "sub_agent": {
                        "goal": "x",
                        "output_schema": {"fields": [{"name": "report", "type": "file_pointer"}]},
                    }
                },
                "tc-fp",
            )
        )
    finally:
        restore()

    assistant = [e for e in events if isinstance(e, AssistantEvent)]
    assert len(assistant) == 1
    assert assistant[0].file_pointer["id"] == "fp-1"
    finished_index = next(i for i, e in enumerate(events) if getattr(e, "status", None) == MessageStatus.FINISHED)
    assistant_index = next(i for i, e in enumerate(events) if isinstance(e, AssistantEvent))
    assert finished_index < assistant_index


# ── pre-fetched parent_attachments bypass ─────────────────────────────


async def test_spawn_with_prefetched_attachments():
    """When parent_attachments is provided, activity skips the GET fetch."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.spawn_sub_agents import spawn_sub_agent_activity

        prefetched = {
            "filename_to_pointer": {"report.pdf": {"id": "fp-1", "original_filename": "report.pdf", "storage_path": "u/1/report.pdf"}},
            "all_pointers_by_id": {"fp-1": {"id": "fp-1", "original_filename": "report.pdf", "storage_path": "u/1/report.pdf"}},
        }
        result = await spawn_sub_agent_activity(
            user_id="user-42",
            sub_agents=[{"goal": "Research competitors"}],
            parent_agent_id="agent-parent",
            parent_workflow_id="wf-parent",
            depth=0,
            parent_is_paused=False,
            parent_model="rose-labs/rose-1-flash",
            parent_attachments=prefetched,
        )

    assert result["spawned"] == 1
    reqs = get_captured_requests()
    get_reqs = [r for r in reqs if r["method"] == "GET"]
    assert len(get_reqs) == 0, f"Expected no GET requests but got {len(get_reqs)}"


async def test_fetch_parent_attachments_activity():
    """fetch_parent_attachments_activity returns the expected dict structure."""
    setup_mock({
        "/api/agents/parent-99": {
            "status": 200,
            "json": {
                "messages": [
                    {"role": "USER", "text": "", "file_pointer": {"id": "fp-a", "storage_path": "u/1/a.pdf", "original_filename": "a.pdf"}},
                    {"role": "ASSISTANT", "text": "done"},
                ],
            },
        },
    })
    with patch("temporalio.activity.heartbeat"):
        from helpers.attachments import fetch_parent_attachments_activity

        result = await fetch_parent_attachments_activity("parent-99")

    assert "filename_to_pointer" in result
    assert "all_pointers_by_id" in result
    assert "a.pdf" in result["filename_to_pointer"]
    assert "fp-a" in result["all_pointers_by_id"]
    teardown_mock()


# ── get_manager singleton ────────────────────────────────────────────


def test_get_manager_singleton():
    """get_manager returns the same instance and carries tool_name."""
    from domains.spawn_sub_agents.handler import get_manager

    a = get_manager()
    b = get_manager()
    assert a is b
    assert a.tool_name == "spawn_sub_agent"


# ── spawn_sub_agents_batch_activity ────────────────────────────────────


def _setup_batch_mock(results):
    """Set up the /api/agents/batch endpoint with a fixed results array."""
    setup_mock(
        {
            "/api/agents/batch": {
                "status": 201 if all(r["status"] != "FAILED" for r in results) else 207,
                "json": {"results": results},
            },
        }
    )


async def test_batch_happy_path_returns_spawn_result():
    """Batch endpoint returns N STARTING_UP results -> SpawnResult shape preserved."""
    _setup_batch_mock(
        [
            {"agent_id": "c-1", "status": "STARTING_UP", "temporal_workflow_id": "c-1", "goal": "G1"},
            {"agent_id": "c-2", "status": "STARTING_UP", "temporal_workflow_id": "c-2", "goal": "G2"},
            {"agent_id": "c-3", "status": "STARTING_UP", "temporal_workflow_id": "c-3", "goal": "G3"},
        ]
    )
    with patch("temporalio.activity.heartbeat"):
        from tools.spawn_sub_agents import spawn_sub_agents_batch_activity

        result = await spawn_sub_agents_batch_activity(
            user_id="u-1",
            sub_agents=[{"goal": f"G{i}", "verifier": {}} for i in (1, 2, 3)],
            parent_agent_id="p-1",
            parent_workflow_id="wf-p-1",
            depth=1,
            parent_is_paused=False,
            child_agent_ids=["c-1", "c-2", "c-3"],
        )
    assert result["spawned"] == 3
    assert result["completed"] == 3
    assert result["failed"] == 0
    assert {a["agent_id"] for a in result["agents"]} == {"c-1", "c-2", "c-3"}
    teardown_mock()


async def test_batch_partial_failure_marks_failed_in_result():
    """Mixed STARTING_UP + FAILED in 207 response -> proper completed/failed counts."""
    _setup_batch_mock(
        [
            {"agent_id": "c-1", "status": "STARTING_UP", "temporal_workflow_id": "c-1", "goal": "G1"},
            {"agent_id": "c-2", "status": "FAILED", "temporal_workflow_id": None, "error": "boom"},
            {"agent_id": "c-3", "status": "STARTING_UP", "temporal_workflow_id": "c-3", "goal": "G3"},
        ]
    )
    with patch("temporalio.activity.heartbeat"):
        from tools.spawn_sub_agents import spawn_sub_agents_batch_activity

        result = await spawn_sub_agents_batch_activity(
            user_id="u-1",
            sub_agents=[{"goal": "G1", "verifier": {}}, {"goal": "G2", "verifier": {}}, {"goal": "G3", "verifier": {}}],
            parent_agent_id="p-1",
            parent_workflow_id="wf-p-1",
            depth=1,
            parent_is_paused=False,
            child_agent_ids=["c-1", "c-2", "c-3"],
        )
    assert result["completed"] == 2
    assert result["failed"] == 1
    failed_entry = next(a for a in result["agents"] if a["agent_id"] == "c-2")
    assert failed_entry["status"] == "FAILED"
    assert failed_entry["error"] == "boom"
    teardown_mock()


async def test_batch_posts_caller_supplied_agent_ids():
    """Activity sends each child's agent_id verbatim to the backend."""
    _setup_batch_mock(
        [
            {"agent_id": "fixed-1", "status": "STARTING_UP", "temporal_workflow_id": "fixed-1"},
            {"agent_id": "fixed-2", "status": "STARTING_UP", "temporal_workflow_id": "fixed-2"},
        ]
    )
    with patch("temporalio.activity.heartbeat"):
        from tools.spawn_sub_agents import spawn_sub_agents_batch_activity

        await spawn_sub_agents_batch_activity(
            user_id="u-1",
            sub_agents=[{"goal": "G1", "verifier": {}}, {"goal": "G2", "verifier": {}}],
            parent_agent_id="p-1",
            parent_workflow_id="wf-p-1",
            depth=1,
            parent_is_paused=False,
            child_agent_ids=["fixed-1", "fixed-2"],
        )
    reqs = get_captured_requests()
    posted = [r for r in reqs if r["method"] == "POST" and r["url"].endswith("/api/agents/batch")]
    assert len(posted) == 1, f"Expected 1 POST to /batch, got {len(posted)}"
    body = json.loads(posted[0]["requestBody"])
    posted_ids = [a["agent_id"] for a in body["agents"]]
    assert posted_ids == ["fixed-1", "fixed-2"], f"Got {posted_ids}"
    teardown_mock()


async def test_batch_mints_ids_when_not_supplied():
    """If no child_agent_ids are passed, activity generates UUIDs and includes them."""
    _setup_batch_mock(
        [
            {"agent_id": "x", "status": "STARTING_UP", "temporal_workflow_id": "x"},
        ]
    )
    with patch("temporalio.activity.heartbeat"):
        from tools.spawn_sub_agents import spawn_sub_agents_batch_activity

        await spawn_sub_agents_batch_activity(
            user_id="u-1",
            sub_agents=[{"goal": "only", "verifier": {}}],
            parent_agent_id="p-1",
            parent_workflow_id="wf-p-1",
            depth=1,
            parent_is_paused=False,
        )
    reqs = get_captured_requests()
    posted = [r for r in reqs if r["method"] == "POST" and r["url"].endswith("/api/agents/batch")]
    body = json.loads(posted[0]["requestBody"])
    assert "agent_id" in body["agents"][0]
    # Has UUID shape (8-4-4-4-12)
    aid = body["agents"][0]["agent_id"]
    parts = aid.split("-")
    assert len(parts) == 5 and len(aid) == 36, f"Not a UUID: {aid}"
    teardown_mock()


def test_build_spawn_result_from_batch_zero_results():
    """Empty results list -> zero spawned/completed/failed."""
    from domains.spawn_sub_agents.service import _build_spawn_result_from_batch

    out = _build_spawn_result_from_batch([], [])
    assert out["spawned"] == 0 and out["completed"] == 0 and out["failed"] == 0


def test_build_spawn_result_from_batch_unknown_status_treated_as_starting_up():
    """A result without explicit status defaults to STARTING_UP (not FAILED)."""
    from domains.spawn_sub_agents.service import _build_spawn_result_from_batch

    out = _build_spawn_result_from_batch(
        [{"agent_id": "c-1", "status": "", "temporal_workflow_id": "c-1"}],
        [{"goal": "G"}],
    )
    assert out["completed"] == 1 and out["failed"] == 0
    assert out["agents"][0]["status"] == "STARTING_UP"


async def test_batch_retries_on_429():
    """A 429 from the backend causes the activity to retry. Final 201 wins."""
    # First mock returns 429, second returns 201. We cycle responses by
    # re-arming the mock between requests via teardown/setup. The simplest
    # approach: assert that retry path is exercised via the 429 status code
    # being parsed and passed to backoff (no exception thrown for ≥429 retry
    # within MAX_SPAWN_ATTEMPTS).
    setup_mock(
        {
            "/api/agents/batch": {"status": 429, "json": {"error": "Too many requests"}},
        }
    )
    raised = False
    with patch("temporalio.activity.heartbeat"), patch("asyncio.sleep") as sleep_mock:
        sleep_mock.return_value = None
        try:
            from tools.spawn_sub_agents import spawn_sub_agents_batch_activity

            await spawn_sub_agents_batch_activity(
                user_id="u-1",
                sub_agents=[{"goal": "G", "verifier": {}}],
                parent_agent_id="p-1",
                parent_workflow_id="wf-1",
                depth=1,
                parent_is_paused=False,
                child_agent_ids=["c-1"],
            )
        except RuntimeError as e:
            raised = True
            assert "429" in str(e)
    # Sleep should have been called between retries (at least once).
    assert sleep_mock.call_count >= 1, "Expected backoff sleeps between retries"
    assert raised, "Persistent 429 should ultimately raise RuntimeError"
    teardown_mock()


def test_tokyo_wait_for_llm_call_repro_reconstructs_the_bad_turn():
    """Prod Tokyo child called wait_for after explore already returned 14,303,513."""
    import json

    from benchmarks.repro.replay_tokyo_wait_for_llm_call import FIXTURE, build_messages

    fixture = json.loads(FIXTURE.read_text())
    assert fixture["repro_id"] == "spawn-sub-agents-tokyo-wait-for-after-explore"
    assert fixture["source_agent_id"] == "2f7323fb-062e-4e4a-bfe2-575b21342c62"
    bad = fixture["observed_bad_model_output"]["tool_calls"][0]
    assert bad["tool"] == "wait_for"
    assert bad["description"] == "Confirming completed official research"
    assert bad["until_timestamp"] == "2026-09-03T06:22:01+00:00"
    assert fixture["observed_bad_model_output"]["error"] == (
        "Timestamp 2026-09-03T06:22:01+00:00 is in the past."
    )
    expected = fixture["expected_correct_output"]
    assert expected["tool_calls"][0]["tool"] == "attempt_completion"
    assert expected["structured_response"]["population"] == 14303513

    messages = build_messages(fixture)
    assert messages[0]["role"] == "system"
    roles = [m["role"] for m in messages]
    assert roles[1:] == ["user", "assistant", "tool"]
    tool_text = messages[-1]["content"]
    assert "14,303,513" in tool_text
    assert "Tokyo" in tool_text
    assert messages[-1]["role"] == "tool"


def test_spawn_sub_agents_benchmark_forces_demo_cache_off():
    """spawn-sub-agents must not replay Fast Mode traces; the Tokyo wait_for stall was a live Codex call."""
    import os

    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _resolved_fast_mode_cache

    previous = os.environ.get("BENCHMARK_FAST_MODE_CACHE")
    os.environ["BENCHMARK_FAST_MODE_CACHE"] = "true"
    try:
        task = get_task_by_name("spawn-sub-agents")
        assert task.demo_cache == "off"
        assert _resolved_fast_mode_cache(task) is False
    finally:
        if previous is None:
            os.environ.pop("BENCHMARK_FAST_MODE_CACHE", None)
        else:
            os.environ["BENCHMARK_FAST_MODE_CACHE"] = previous


async def run_all_tests():
    print("spawn-sub-agents blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_spawn_sub_agent_happy_path)
    await r.record_async("boundary", test_spawn_sub_agent_boundary)
    # extract_file_pointers
    r.record("extract_fp_single", test_extract_file_pointers_single_pointer)
    r.record("extract_fp_list", test_extract_file_pointers_list)
    r.record("extract_fp_nested_object", test_extract_file_pointers_nested_object)
    r.record("extract_fp_missing_field", test_extract_file_pointers_missing_field)
    r.record("extract_fp_empty", test_extract_file_pointers_empty_inputs)
    r.record("extract_fp_bad_type", test_extract_file_pointers_unrecognized_type)
    # resolve_attachments
    r.record("resolve_by_filename", test_resolve_attachments_explicit_by_filename)
    r.record("resolve_by_id", test_resolve_attachments_explicit_by_id)
    r.record("resolve_unknown_fallback", test_resolve_attachments_explicit_unknown_falls_back_to_all)
    r.record("resolve_auto_forward", test_resolve_attachments_no_explicit_auto_forwards)
    r.record("resolve_no_parent", test_resolve_attachments_no_parent)
    # build_spawn_payload
    r.record("build_payload_defaults", test_build_spawn_payload_defaults)
    r.record("build_payload_bad_phase", test_build_spawn_payload_bad_start_phase_defaults_to_plan)
    r.record("build_payload_execute", test_build_spawn_payload_execute_phase)
    r.record("build_payload_no_parent_context", test_build_spawn_payload_does_not_forward_parent_context)
    # handler failure events
    r.record("failure_events_basic", test_build_failure_events_basic)
    r.record("failure_events_rich", test_build_failure_events_rich_context)
    # execute_tool branches
    await r.record_async("exec_missing_sub_agent", test_execute_tool_missing_sub_agent_yields_error)
    await r.record_async("exec_max_depth", test_execute_tool_max_depth_exceeded)
    await r.record_async("exec_max_depth_fast_mode_finishes", test_execute_tool_max_depth_fast_mode_finishes)
    await r.record_async("exec_fast_mode_skips_nested_spawn", test_execute_tool_fast_mode_skips_nested_spawn)
    await r.record_async(
        "exec_fast_mode_nested_spawn_other_tasks_still_attempt",
        test_execute_tool_fast_mode_nested_spawn_other_tasks_still_attempt,
    )
    await r.record_async("exec_empty_agents", test_execute_tool_empty_agents_list_yields_error)
    await r.record_async("exec_child_error_key", test_execute_tool_child_info_has_error_key)
    await r.record_async("exec_exception_path", test_execute_tool_exception_path_yields_error)
    await r.record_async(
        "exec_generation_handoff_finished",
        test_execute_tool_generation_handoff_closes_finished_and_reraises,
    )
    await r.record_async("exec_happy_path", test_execute_tool_happy_path_completes_and_tracks_child)
    await r.record_async(
        "exec_keeps_result_until_finished_consumed",
        test_finalize_child_keeps_result_until_finished_event_is_consumed,
    )
    await r.record_async("exec_recovers_terminal_child", test_execute_tool_recovers_terminal_child_from_persisted_state)
    await r.record_async("exec_no_bus_id", test_execute_tool_happy_path_no_parent_bus_id_sets_it)
    await r.record_async("exec_failed_child", test_execute_tool_failed_child_yields_failure_events)
    await r.record_async(
        "exec_max_iterations_child_error_best_effort",
        test_execute_tool_max_iterations_child_is_error_with_best_effort_payload,
    )
    await r.record_async("exec_file_pointers", test_execute_tool_posts_assistant_events_for_file_pointers)
    # pre-fetched attachments
    await r.record_async("prefetched_attachments", test_spawn_with_prefetched_attachments)
    await r.record_async("fetch_parent_attachments_activity", test_fetch_parent_attachments_activity)
    # singleton
    r.record("get_manager_singleton", test_get_manager_singleton)
    # batch activity
    await r.record_async("batch_happy_path", test_batch_happy_path_returns_spawn_result)
    await r.record_async("batch_partial_failure", test_batch_partial_failure_marks_failed_in_result)
    await r.record_async("batch_posts_supplied_ids", test_batch_posts_caller_supplied_agent_ids)
    await r.record_async("batch_mints_ids", test_batch_mints_ids_when_not_supplied)
    r.record("batch_result_zero", test_build_spawn_result_from_batch_zero_results)
    r.record("batch_result_unknown_status", test_build_spawn_result_from_batch_unknown_status_treated_as_starting_up)
    await r.record_async("batch_retries_on_429", test_batch_retries_on_429)
    r.record(
        "tokyo_wait_for_llm_call_repro",
        test_tokyo_wait_for_llm_call_repro_reconstructs_the_bad_turn,
    )
    r.record(
        "spawn_sub_agents_demo_cache_off",
        test_spawn_sub_agents_benchmark_forces_demo_cache_off,
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
