"""Blackbox tests for spawn-sub-agents domain."""

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
        "/api/agents": {
            "status": 200,
            "json": {
                "agent_id": "sub-agent-1",
                "temporal_workflow_id": "wf-sub-1",
                "goal": "Research competitors",
                "model": "rose-labs/rose-1-lite",
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
            sub_agents=[{
                "goal": "Research competitors",
                "verifier": {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "Did they research?"},
            }],
            parent_agent_id="agent-parent",
            parent_workflow_id="wf-parent",
            depth=0,
            parent_is_paused=False,
            parent_model="rose-labs/rose-1-lite",
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
            sub_agents=[{
                "goal": "Find leads",
                "verifier": {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "Were leads found?"},
            }],
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
        agent_cfg={"goal": "G", "verifier": {"type": "FLOAT_LLM_JUDGE"}},
        parent_agent_id="p-1",
        parent_workflow_id="wf-1",
        depth=2,
        parent_is_paused=False,
        parent_model="rose-labs/rose-1-lite",
        bus_id=None,
        parent_source="WEB",
        resolved_attachments=[],
    )
    assert payload["user_id"] == "u-1"
    assert payload["goal"] == "G"
    assert payload["start_phase"] == "plan"
    assert payload["depth"] == 2
    assert payload["source"] == "WEB"
    assert payload["model"] == "rose-labs/rose-1-lite"
    assert payload["max_iterations"] == 25
    assert "attachments" not in payload  # empty list → omitted
    assert "context_gates" not in payload


def test_build_spawn_payload_bad_start_phase_defaults_to_plan():
    """Unrecognised start_phase falls back to 'plan'."""
    from domains.spawn_sub_agents.service import build_spawn_payload

    payload = build_spawn_payload(
        user_id="u-1",
        agent_cfg={"goal": "G", "verifier": {}, "start_phase": "weird"},
        parent_agent_id="p-1",
        parent_workflow_id="wf-1",
        depth=0,
        parent_is_paused=True,
        parent_model="rose-labs/rose-1-lite",
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
            "verifier": {},
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


# ── handler._build_failure_events ──────────────────────────────────────


def test_build_failure_events_basic():
    """Minimal failure context produces a single ToolEvent with error_reason."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager

    events = SpawnSubAgentManager._build_failure_events(
        child_agent_id="c-1",
        child_result={"error_reason": "timeout", "failure_context": {}},
        bus_id="bus-1",
    )
    assert len(events) == 1
    ev = events[0]
    assert "Sub-agent failed" in ev.title
    assert "timeout" in ev.message
    assert ev.metadata["subAgentIds"] == ["c-1"]
    assert ev.metadata["busId"] == "bus-1"


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


# ── SpawnSubAgentManager.execute_tool — validation/early-exit branches ──


class _FakeWorkflowInfo:
    workflow_id = "wf-parent"


class _FakeWorkflowModule:
    """Stand-in for temporalio.workflow with enough surface for execute_tool."""

    def __init__(self, activity_result=None, child_results=None):
        self._activity_result = activity_result
        self._child_results = child_results or {}

    def info(self):
        return _FakeWorkflowInfo()

    async def execute_activity(self, fn, args=None, **kwargs):
        if isinstance(self._activity_result, Exception):
            raise self._activity_result
        return self._activity_result

    async def wait_condition(self, predicate):
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
        self.model = "rose-labs/rose-1-lite"
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
                {"sub_agent": {"goal": "g", "verifier": {}}},
                "tc-deep",
            )
        )
    finally:
        restore()

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "maximum nesting depth" in events[0].message
    assert str(MAX_DEPTH) in events[0].message


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
                {"sub_agent": {"goal": "g", "verifier": {}}},
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
                {"sub_agent": {"goal": "g", "verifier": {}}},
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
                {"sub_agent": {"goal": "g", "verifier": {}}},
                "tc-exc",
            )
        )
    finally:
        restore()

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "Error spawning sub-agent" in events[0].message
    assert "activity boom" in events[0].message


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
                {"sub_agent": {"goal": "Do the thing", "verifier": {}}},
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
                {"sub_agent": {"goal": "x", "verifier": {}}},
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
                {"sub_agent": {"goal": "x", "verifier": {}}},
                "tc-failed",
            )
        )
    finally:
        restore()

    # Should end with an ERROR event from _build_failure_events
    error_events = [e for e in events if getattr(e, "status", None) == MessageStatus.ERROR]
    assert len(error_events) == 1
    assert "timeout" in error_events[0].message


async def test_execute_tool_posts_assistant_events_for_file_pointers():
    """Structured response with file_pointer field yields AssistantEvent per pointer."""
    from domains.spawn_sub_agents.handler import SpawnSubAgentManager
    from tools.base import AssistantEvent

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
                        "verifier": {},
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
            sub_agents=[{
                "goal": "Research competitors",
                "verifier": {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "Did they research?"},
            }],
            parent_agent_id="agent-parent",
            parent_workflow_id="wf-parent",
            depth=0,
            parent_is_paused=False,
            parent_model="rose-labs/rose-1-lite",
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


async def run_all_tests():
    print("spawn-sub-agents blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_spawn_sub_agent_happy_path)
    await r.record_async("boundary", test_spawn_sub_agent_boundary)
    # extract_file_pointers
    r.record("extract_fp_single", test_extract_file_pointers_single_pointer)
    r.record("extract_fp_list", test_extract_file_pointers_list)
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
    # handler failure events
    r.record("failure_events_basic", test_build_failure_events_basic)
    r.record("failure_events_rich", test_build_failure_events_rich_context)
    # execute_tool branches
    await r.record_async("exec_missing_sub_agent", test_execute_tool_missing_sub_agent_yields_error)
    await r.record_async("exec_max_depth", test_execute_tool_max_depth_exceeded)
    await r.record_async("exec_empty_agents", test_execute_tool_empty_agents_list_yields_error)
    await r.record_async("exec_child_error_key", test_execute_tool_child_info_has_error_key)
    await r.record_async("exec_exception_path", test_execute_tool_exception_path_yields_error)
    await r.record_async("exec_happy_path", test_execute_tool_happy_path_completes_and_tracks_child)
    await r.record_async("exec_no_bus_id", test_execute_tool_happy_path_no_parent_bus_id_sets_it)
    await r.record_async("exec_failed_child", test_execute_tool_failed_child_yields_failure_events)
    await r.record_async("exec_file_pointers", test_execute_tool_posts_assistant_events_for_file_pointers)
    # pre-fetched attachments
    await r.record_async("prefetched_attachments", test_spawn_with_prefetched_attachments)
    await r.record_async("fetch_parent_attachments_activity", test_fetch_parent_attachments_activity)
    # singleton
    r.record("get_manager_singleton", test_get_manager_singleton)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
