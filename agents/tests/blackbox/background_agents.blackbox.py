"""Blackbox tests: background spawn_agent, agent notifications, agent-to-agent rows.

Drives the real AgentWorkflow methods on a bare instance (no Temporal server):
only the DB-posting edge (handle_tool_event / _post_message) and the spawned
executor are faked, so the asserted behavior is the workflow's own.
"""

import asyncio
import contextlib
import logging
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from _test_utils import BlackboxResult

_BASE = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)


class _Harness:
    """Records every row the workflow posts, with monotonically increasing timestamps."""

    def __init__(self) -> None:
        self.rows = []
        self._tick = 0
        # Seconds a notification post takes (a slow DB write widens finish races).
        self.notification_delay = 0.0

    def _ts(self) -> str:
        self._tick += 1
        return (_BASE + timedelta(seconds=self._tick)).isoformat()

    def add(self, role, text, metadata=None):
        row = {"role": role, "text": text, "metadata": metadata or {}, "timestamp": self._ts()}
        self.rows.append(row)
        return row

    async def handle_tool_event(self, event, agent_id, tool_call_id, tool_name, **_kwargs):
        from tools.base import AssistantEvent

        if isinstance(event, AssistantEvent):
            self.add("ASSISTANT", event.message or "", None)
            return
        metadata = {
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "toolStatus": event.status.value if event.status else "IN_PROGRESS",
            "title": event.title or tool_name,
            **(event.metadata or {}),
        }
        self.add("TOOL", event.message or "", metadata)

    async def post_message(self, text, role="ASSISTANT", metadata=None, **_kwargs):
        if self.notification_delay and (metadata or {}).get("agentNotification"):
            await asyncio.sleep(self.notification_delay)
        self.add(role, text, metadata)


@contextlib.contextmanager
def _workflow_env(harness):
    from temporalio import workflow as temporal_workflow

    counter = iter(range(1, 10_000))

    def _uuid4():
        import uuid

        return uuid.UUID(int=next(counter))

    with (
        patch.object(temporal_workflow, "logger", logging.getLogger("background-agents-test")),
        patch.object(temporal_workflow, "uuid4", _uuid4),
        patch("workflows.agent_workflow.handle_tool_event", harness.handle_tool_event),
    ):
        yield


def _workflow(harness):
    from workflows.agent_workflow import AgentWorkflow

    wf = AgentWorkflow()
    wf.agent_id = "agent-parent"
    wf.user_id = "user-1"
    wf.goal = "Plan a trip"
    wf._post_message = harness.post_message
    wf._background_spawns_enabled = True
    return wf


def _gated_executor(wf, harness, gate, *, result_text="Tokyo has 14,303,513 residents.", calls=None):
    """Stand-in for the real spawn executor: IN_PROGRESS, wait, FINISHED under its id."""
    from tools.base import EventType, MessageStatus, ToolEvent

    async def _execute_tool(tool_name, tool_args, tool_call_id):
        if calls is not None:
            calls.append((tool_name, dict(tool_args), tool_call_id, wf._take_tool_resume(tool_call_id)))
        await wf._handle_tool_event(
            ToolEvent(type=EventType.POST_MESSAGE, title="Explore", message="", status=MessageStatus.IN_PROGRESS),
            tool_call_id,
            "spawn_agent",
        )
        await gate.wait()
        await wf._handle_tool_event(
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Explore complete",
                message=result_text,
                status=MessageStatus.FINISHED,
                data={"result": result_text},
                metadata={"agentType": "explore"},
            ),
            tool_call_id,
            "spawn_agent",
        )
        return {"success": True, "message": result_text}

    return _execute_tool


def _notifications(harness):
    return [row for row in harness.rows if (row["metadata"] or {}).get("agentNotification") is True]


def started_rows_have_path(harness, path):
    """The "Started … in background" row carries backgroundPath/backgroundGoal for the FE chip."""
    rows = [
        r for r in harness.rows if r["metadata"].get("runInBackground") and r["metadata"].get("backgroundPath") == path
    ]
    return bool(rows) and all(len(r["metadata"].get("backgroundGoal") or "") <= 200 for r in rows)


EXPLORE_ARGS = {"type": "explore", "task_name": "tokyo", "goal": "Find the population of Tokyo with a cited source."}


async def test_background_spawn_returns_immediately_and_notifies_once():
    harness = _Harness()
    with _workflow_env(harness):
        wf = _workflow(harness)
        gate = asyncio.Event()
        wf._execute_tool = _gated_executor(wf, harness, gate)

        started = await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_1")
        assert started.get("success") is True, started
        assert "Address: /root/tokyo" in started["message"], started
        original = [row for row in harness.rows if row["metadata"].get("toolCallId") == "toolu_1"]
        # The started row comes first, before the executor's first row under the same id.
        assert original[0]["metadata"]["toolStatus"] == "FINISHED", original
        assert original[0]["metadata"]["runInBackground"] is True and original[0]["metadata"]["hidden"] is True
        assert "excludeFromModel" not in original[0]["metadata"], original
        assert original[0]["metadata"]["toolName"].startswith("spawn_"), original
        assert wf._pending_background_addresses() == ["/root/tokyo"]

        # Completion is not blocked; the verifier gets this factual status.
        assert wf._pending_background_status_text() == (
            "Background agents still running when completion was attempted:\n"
            "- /root/tokyo (type: explore, status: running): Find the population of Tokyo with a cited source."
        )
        assert not _notifications(harness)

        gate.set()
        await wf._background_handles["toolu_1"]
        notes = _notifications(harness)
        assert len(notes) == 1, notes
        note = notes[0]
        assert note["role"] == "USER"
        assert note["metadata"]["toolName"] == "agent_notification"
        assert note["metadata"]["fromAgentAddress"] == "/root/tokyo"
        assert note["metadata"]["status"] == "completed"
        assert note["metadata"]["messageType"] == "FINAL_ANSWER"
        assert note["text"] == (
            "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/tokyo\nPayload:\n"
            "Tokyo has 14,303,513 residents."
        ), note["text"]
        assert wf._has_new_messages is True
        assert wf._pending_background_status_text() is None

        # Idempotent: a second completion path for the same task posts nothing.
        wf._background_tasks["toolu_1"] = {**wf._background_finished["toolu_1"], "status": "running"}
        wf._background_notified.add("agent-parent:toolu_1:notification")
        await wf._finish_background_task("toolu_1", {"success": True})
        assert len(_notifications(harness)) == 1


async def test_background_completion_notification_keeps_its_run_when_woken_during_tree_update():
    """A wake during the first completion's await must not steal its notification key."""
    harness = _Harness()
    with _workflow_env(harness):
        wf = _workflow(harness)
        gate = asyncio.Event()
        wf._execute_tool = _gated_executor(wf, harness, gate)
        await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_1")
        first_handle = wf._background_handles["toolu_1"]
        wf._launch_background_task = lambda _task_id: None
        woke = False

        async def update_tree_and_wake():
            nonlocal woke
            if not woke:
                woke = True
                result = await wf._wake_background_task(
                    "toolu_1", "Add the exact marker", message_id="message-1", sender="/root"
                )
                assert result == {"woke": True, "run": 2}

        wf._update_tree_state = update_tree_and_wake
        gate.set()
        await first_handle
        assert "toolu_1" in wf._background_tasks, "the second run was not retained"
        await wf._finish_background_task("toolu_1", {"success": True}, summary="Marker included")
        notes = _notifications(harness)
        assert len(notes) == 2, notes
        assert [row["metadata"].get("backgroundRun", 1) for row in notes] == [1, 2], notes
        assert "Tokyo has" in notes[0]["text"] and "Marker included" in notes[1]["text"]


async def test_background_rows_hidden_and_model_prefix_is_stable():
    from helpers.llm import build_llm_messages, convert_context_to_messages

    harness = _Harness()
    with _workflow_env(harness):
        wf = _workflow(harness)
        harness.add("USER", "Plan a trip to Tokyo")
        harness.add(
            "ASSISTANT",
            "Researching.",
            {"tool_calls": [{"tool": "spawn_agent", "tool_call_id": "toolu_1", **EXPLORE_ARGS}]},
        )
        gate = asyncio.Event()
        wf._execute_tool = _gated_executor(wf, harness, gate)
        await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_1")
        await asyncio.sleep(0)  # the background IN_PROGRESS row lands
        before_rows = list(harness.rows)
        before = convert_context_to_messages(before_rows, include_assistant=True)
        before_llm = await build_llm_messages(before_rows, "SYSTEM")

        gate.set()
        await wf._background_handles["toolu_1"]
        after = convert_context_to_messages(list(harness.rows), include_assistant=True)
        after_llm = await build_llm_messages(list(harness.rows), "SYSTEM")

    executor_rows = [
        row
        for row in harness.rows
        if row["metadata"].get("toolCallId") == "toolu_1" and not row["metadata"].get("runInBackground")
    ]
    assert [row["metadata"]["toolStatus"] for row in executor_rows] == ["IN_PROGRESS", "FINISHED"], executor_rows
    assert all(row["metadata"].get("excludeFromModel") is True for row in executor_rows), executor_rows
    for messages in (after, after_llm):
        assert not any("14,303,513 residents." == str(m.get("content")) for m in messages)
    assert after[: len(before)] == before, (before, after)
    assert after_llm[: len(before_llm)] == before_llm, (before_llm, after_llm)
    # The notification is ONE appended assistant-role inter-agent message (Codex).
    assert len(after) == len(before) + 1 and after[-1]["role"] == "assistant", after
    assert after[-1]["content"].startswith("Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/tokyo\n")
    assert after_llm[-1]["role"] == "assistant" and "Message Type: FINAL_ANSWER" in after_llm[-1]["content"]
    tool_results = [m for m in after if m.get("role") == "tool"]
    assert len(tool_results) == 1 and "Started explore agent in background" in tool_results[0]["content"]


async def test_background_spawn_fe_rows_match_a_foreground_spawn():
    """FE-neutral: hidden rows aside, a background spawn's rows equal a foreground spawn's.

    Same toolCallId (the LLM's own id), same statuses, titles, text and metadata
    keys; the only additions are the model-only "started" row (hidden) and the
    excludeFromModel stamp the FE ignores.
    """
    harness = _Harness()
    with _workflow_env(harness):
        wf = _workflow(harness)
        gate = asyncio.Event()
        gate.set()
        wf._execute_tool = _gated_executor(wf, harness, gate)
        # Foreground (main): the unchanged executor runs under the LLM's id.
        await wf._execute_tool("spawn_agent", dict(EXPLORE_ARGS), "toolu_fg")
        # Background: started row, then the same executor under the LLM's id.
        await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_bg")
        await wf._background_handles["toolu_bg"]

    def fe_rows(tool_call_id):
        return [
            row
            for row in harness.rows
            if row["metadata"].get("toolCallId") == tool_call_id and not row["metadata"].get("hidden")
        ]

    def shape(row):
        metadata = {
            key: value for key, value in row["metadata"].items() if key not in ("toolCallId", "excludeFromModel")
        }
        return row["role"], row["text"], metadata

    foreground, background = fe_rows("toolu_fg"), fe_rows("toolu_bg")
    assert [shape(row) for row in background] == [shape(row) for row in foreground], (foreground, background)
    assert [row["metadata"]["toolStatus"] for row in background] == ["IN_PROGRESS", "FINISHED"]
    assert all(row["metadata"]["excludeFromModel"] is True for row in background)
    assert not any("excludeFromModel" in row["metadata"] for row in foreground)
    hidden = [
        row for row in harness.rows if row["metadata"].get("toolCallId") == "toolu_bg" and row["metadata"].get("hidden")
    ]
    assert len(hidden) == 1 and hidden[0]["metadata"]["runInBackground"] is True, hidden
    assert harness.rows.index(hidden[0]) < harness.rows.index(background[0]), "started row lands first"
    assert not any(str(row["metadata"].get("toolCallId") or "").startswith("bg_") for row in harness.rows)


def test_notification_bodies_follow_codex_and_cap_only_errors():
    from helpers.background_agents import build_agent_notification_text, truncate_middle_tokens

    long_error = "E" * 2000 + "MIDDLE" + "Z" * 6000
    failed = build_agent_notification_text(
        recipient="/root", sender="/root/scan", agent_type="explore", status="failed", summary=long_error
    )
    header, payload = failed.split("Payload:\n", 1)
    assert header == "Message Type: FAILED\nTask name: /root\nSender: /root/scan\n", header
    # Codex: 900 tokens (~3600 bytes) head + tail around a "…N tokens truncated…" marker.
    assert payload.startswith("E" * 1800) and payload.endswith("Z" * 1800), payload[:40]
    assert "…1102 tokens truncated…" in payload and "MIDDLE" not in payload, payload[1790:1830]
    killed = build_agent_notification_text(
        recipient="/root", sender="/root/scan", agent_type="explore", status="failed", summary="Killed by /root"
    )
    assert killed == "Message Type: FAILED\nTask name: /root\nSender: /root/scan\nPayload:\nKilled by /root"
    from helpers.background_agents import NOTIFICATION_MESSAGE_TYPES

    assert set(NOTIFICATION_MESSAGE_TYPES.values()) == {"FINAL_ANSWER", "FAILED"}, "kill is a failure, not a type"
    big_answer = "A" * 50_000
    done = build_agent_notification_text(
        recipient="/root",
        sender="/root/scan",
        agent_type="explore",
        status="completed",
        summary=big_answer,
        structured_response={"funds": 4},
        file_pointers=[{"id": "f1", "original_filename": "funds.csv"}],
    )
    assert done == (
        "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/scan\nPayload:\n"
        + big_answer
        + '\n\nStructured Response: {"funds": 4}\n\nFile: {"id": "f1", "original_filename": "funds.csv"}'
    ), "a successful payload is never capped here"
    assert truncate_middle_tokens("short", 900) == "short"
    assert truncate_middle_tokens("ééé" * 2000, 10).count("…") == 2  # UTF-8 safe


async def test_wait_for_agents_is_how_a_background_notification_is_awaited():
    """No idle wait exists; wait_for(agents=[address]) ends on the task's notification."""
    from temporalio import workflow as temporal_workflow

    from domains.wait_for.handler import wait_for

    async def _wait_condition(predicate, timeout=None):
        while not predicate():
            await asyncio.sleep(0)

    harness = _Harness()
    with (
        _workflow_env(harness),
        patch.object(temporal_workflow, "now", lambda: _BASE),
        patch.object(temporal_workflow, "wait_condition", _wait_condition),
    ):
        wf = _workflow(harness)
        assert not hasattr(wf, "_wait_for_background_agents")
        gate = asyncio.Event()
        wf._execute_tool = _gated_executor(wf, harness, gate)
        started = await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_1")
        address = started["address"]
        waiter = asyncio.create_task(
            wait_for(wf, {"description": "explore result", "agents": [address], "timeout_seconds": 600}, "tc-wait")
        )
        for _ in range(50):
            await asyncio.sleep(0)
        assert not waiter.done()
        gate.set()
        await wf._background_handles["toolu_1"]
        _status, result = await asyncio.wait_for(waiter, 2)
    assert address in result, result
    assert len(_notifications(harness)) == 1


async def test_verifier_evidence_ends_with_pending_background_status():
    """check_progress appends the status block LAST, only when non-empty (prefix unchanged)."""
    from helpers import llm

    captured = []

    async def _fake_verifier(messages, *_args, **_kwargs):
        captured.append([dict(m) for m in messages])
        return {"reasoning": "judged", "score": 0.5}, {}

    context = [
        {"role": "USER", "text": "Plan a trip to Tokyo", "timestamp": _BASE.isoformat()},
        {
            "role": "TOOL",
            "text": "Started explore agent in background. Address: toolu_1.",
            "metadata": {"toolCallId": "toolu_1", "toolName": "spawn_agent", "toolStatus": "FINISHED"},
            "timestamp": (_BASE + timedelta(seconds=1)).isoformat(),
        },
    ]
    status = (
        "Background agents still running when completion was attempted:\n"
        "- toolu_1 (type: explore, status: running): Find the population of Tokyo."
    )
    with patch.object(llm, "_call_llm_verifier", _fake_verifier):
        await llm.check_progress(list(context), "VERIFIER SYSTEM", call_site="verifier_execute")
        await llm.check_progress(
            list(context), "VERIFIER SYSTEM", call_site="verifier_execute", pending_background_status=status
        )
        await llm.check_progress(
            list(context), "VERIFIER SYSTEM", call_site="verifier_execute", pending_background_status=""
        )
    without, with_status, empty = captured
    assert with_status[:-1] == without, (without, with_status)
    assert with_status[-1] == {"role": "user", "content": status}, with_status[-1]
    assert empty == without
    assert not any("still running" in str(m.get("content")) for m in without)


async def test_parent_finish_stops_pending_background_agents():
    """Verifier accept with agents pending: _mark_complete stops every one of them.

    Activity-backed task -> asyncio task cancelled; general_purpose child ->
    parent_finished signal; each recorded "failed"; no notification row; a
    late child_completed posts nothing.
    """
    from temporalio import workflow as temporal_workflow

    harness = _Harness()
    signals = []
    activities = []

    class _Handle:
        def __init__(self, wf_id):
            self.wf_id = wf_id

        async def signal(self, name, *args):
            signals.append((self.wf_id, name))

    async def _execute_activity(fn, args=None, **_kwargs):
        name = getattr(fn, "__name__", str(fn))
        activities.append(name)
        if name == "generate_completion_summary":
            return {"summary": "Trip planned", "tool_counts": {}, "usage": {}}
        if name == "fetch_agent_config":
            return {}  # completion re-reads the agent row's output schema; this task has none
        return None

    with (
        _workflow_env(harness),
        patch.object(temporal_workflow, "get_external_workflow_handle", lambda wf_id: _Handle(wf_id)),
        patch.object(temporal_workflow, "execute_activity", _execute_activity),
        patch.object(temporal_workflow, "now", lambda: _BASE),
    ):
        wf = _workflow(harness)
        wf.model = "rose-labs/rose-1-ultra"
        wf.start_time = _BASE
        gate = asyncio.Event()  # never set: both agents are still running
        wf._execute_tool = _gated_executor(wf, harness, gate)
        await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_1")
        gp_args = {
            "type": "general_purpose",
            "task_name": "drafts",
            "goal": "Draft outreach emails to three venues.",
            "start_phase": "EXECUTE",
            "output_schema": {"fields": [{"name": "emails", "type": "str", "description": "d", "required": True}]},
        }
        wf.current_phase = "EXECUTE"
        await wf._execute_tool_once("spawn_agent", gp_args, "toolu_gp")
        gp_address = wf._background_tasks["toolu_gp"]["address"]
        gp_child = wf._background_tasks["toolu_gp"]["child_agent_ids"][0]
        assert gp_address == "/root/drafts" and gp_child != gp_address
        # The spawn executor registered its durable child.
        wf.pending_children.add(gp_child)
        wf.child_workflow_ids[gp_child] = gp_child
        wf.child_tool_ids[gp_child] = "toolu_gp"
        await asyncio.sleep(0)
        handles = dict(wf._background_handles)
        assert set(handles) == {"toolu_1", "toolu_gp"}
        status = wf._pending_background_status_text()
        assert "/root/tokyo (type: explore" in status and f"{gp_address} (type: general_purpose" in status

        await wf._mark_complete([{"role": "USER", "text": "Plan a trip"}], None)

        assert all(handle.cancelled() for handle in handles.values()), handles
        assert wf._background_handles == {} and wf._pending_background_ids() == []
        assert {key: wf._background_finished[key]["status"] for key in handles} == {
            "toolu_1": "failed",
            "toolu_gp": "failed",
        }
        assert (gp_child, "parent_finished") in signals, signals
        assert gp_child not in wf.pending_children
        assert "mark_finished" in activities, activities
        assert not _notifications(harness)

        rows_before = len(harness.rows)
        await wf.child_completed({"child_agent_id": gp_child, "result": {"status": "completed", "summary": "late"}})
        assert len(harness.rows) == rows_before and not _notifications(harness)

        # Child side: parent_finished (or a finished parent's state query) stops it as orphaned.
        child = _workflow(harness)
        child.is_paused = True
        child._paused_by_parent = True
        await child.parent_finished()
        assert child._orphaned is True and child.is_paused is False
        assert await child._check_orphaned() is True
        raced = _workflow(harness)
        raced.parent_workflow_id = "agent-parent"

        async def _finished_parent_state():
            return {"is_paused": False, "is_cost_limit_reached": False, "is_finished": True}

        raced._query_parent_state = _finished_parent_state
        await raced._check_parent_state()
        assert raced._orphaned is True
        assert wf.parent_state_query()["is_finished"] is True


async def test_handoff_parks_and_resumes_background_tasks_in_background():

    harness = _Harness()
    with _workflow_env(harness):
        wf = _workflow(harness)

        async def _parking_executor(tool_name, tool_args, tool_call_id):
            assert wf._park_pending_tool(tool_call_id, {"step": 3}) is True
            return {"success": True, "generation_handoff": True, "pending_tool_resume": True}

        wf._execute_tool = _parking_executor
        await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_1")
        await wf._background_handles["toolu_1"]
        assert wf._pending_background_ids() == ["toolu_1"] and not _notifications(harness)
        # A general_purpose child carried by its durable child workflow.
        gp_args = {
            "type": "general_purpose",
            "task_name": "drafts",
            "goal": "Draft outreach emails to three venues.",
            "start_phase": "EXECUTE",
            "output_schema": {"fields": [{"name": "emails", "type": "str", "description": "drafts", "required": True}]},
        }
        gp_gate = asyncio.Event()
        wf._execute_tool = _gated_executor(wf, harness, gp_gate)
        started = await wf._execute_tool_once("spawn_agent", dict(gp_args), "toolu_gp")
        gp_address = wf._background_tasks["toolu_gp"]["address"]
        gp_child = wf._background_tasks["toolu_gp"]["child_agent_ids"][0]
        assert gp_address == "/root/drafts" and f"Address: {gp_address}" in started["message"]
        assert started_rows_have_path(harness, "/root/drafts")
        assert wf._preassigned_child_agent_id("toolu_gp") == gp_child
        assert wf._pending_tool_resumes == []  # background records travel separately

        wf.model = "rose-labs/rose-1-ultra"
        wf.reasoning_max_tokens = 512
        wf.verifier = {"type": "FLOAT_LLM_JUDGE"}
        wf.parent_workflow_id = None
        wf.parent_agent_id = None
        wf.depth = 0
        wf.bus_id = "agent-parent"
        wf.max_iterations = None
        wf.price_limit_cents = 500
        wf.context_gates = {}
        wf.start_time = _BASE
        args = wf._continuation_args([])
        restored = _workflow(harness)
        restored._restore_deployment_state(args[16])
        assert set(restored._pending_background_ids()) == {"toolu_1", "toolu_gp"}

        calls = []
        gate = asyncio.Event()
        restored._execute_tool = _gated_executor(restored, harness, gate, calls=calls)
        restored._relaunch_background_tasks()
        assert set(restored._background_handles) == {"toolu_1"}  # GP is not re-spawned
        await asyncio.sleep(0)
        assert calls and calls[0][2] == "toolu_1" and calls[0][3] == {"step": 3}, calls
        assert calls[0][1]["run_in_background"] is False
        gate.set()
        await restored._background_handles["toolu_1"]
        assert [n["metadata"]["fromAgentAddress"] for n in _notifications(harness)] == ["/root/tokyo"]

        # The durable child reports through child_completed → one notification.
        await restored.child_completed(
            {
                "child_agent_id": gp_child,
                "result": {"status": "completed", "summary": "3 drafts ready", "structured_response": {"emails": "x"}},
            }
        )
        notes = _notifications(harness)
        assert [n["metadata"]["fromAgentAddress"] for n in notes] == ["/root/tokyo", gp_address], notes
        assert notes[-1]["metadata"]["agentType"] == "general_purpose"
        assert '"emails": "x"' in notes[-1]["text"]
        assert restored._pending_background_ids() == []
        # Clean up the live GP task of the first generation.
        gp_gate.set()
        await wf._background_handles["toolu_gp"]


BROWSER_ARGS = {
    "type": "browser",
    "task_name": "checkout",
    "goal": "Add the blue mug to the cart.",
    "start_url": "https://shop.example.com",
    "output_schema": {"fields": [{"name": "cart", "type": "str", "description": "cart state", "required": True}]},
}


async def test_context_overflow_keeps_in_flight_background_browser_running_and_notifies_once():
    """Overflow mid browser task: no continue_as_new, no relaunch from step 0, one notification.

    Before the fix, overflow continued as new immediately: the next run relaunched the
    browser executor from scratch (calls == 2, no resume) and the first run's task was
    abandoned mid-step.
    """
    from temporalio import workflow as temporal_workflow

    class _Info:
        task_queue = "navi-agent-tasks@gen-1"

        def get_current_history_length(self):
            return 2_000

        def get_current_history_size(self):
            return 1_000_000

    continued = []
    harness = _Harness()
    with (
        _workflow_env(harness),
        patch.object(temporal_workflow, "info", lambda: _Info()),
        patch.object(temporal_workflow, "continue_as_new", lambda **kwargs: continued.append(kwargs)),
    ):
        wf = _workflow(harness)
        calls = []
        gate = asyncio.Event()
        wf._execute_tool = _gated_executor(wf, harness, gate, result_text="Mug in cart.", calls=calls)
        await wf._execute_tool_once("spawn_agent", dict(BROWSER_ARGS), "toolu_b")
        await asyncio.sleep(0)
        assert wf._in_flight_background_ids() == ["toolu_b"], (
            wf._background_tasks,
            list(wf._background_handles),
            harness.rows,
        )

        compressed = [{"role": "SYSTEM", "text": "compressed"}]
        await wf._handle_context_overflow(compressed)
        assert continued == [], "overflow abandoned the in-flight browser task"
        assert wf.context == compressed
        assert not wf._background_handles["toolu_b"].done()

        gate.set()
        await wf._background_handles["toolu_b"]
        assert len(calls) == 1 and calls[0][3] is None, calls  # never relaunched / restarted
        notes = _notifications(harness)
        assert [n["metadata"]["fromAgentAddress"] for n in notes] == ["/root/checkout"], notes
        # The task is done: the next overflow continues as new carrying no background work.
        wf.model = "rose-labs/rose-1-ultra"
        wf.reasoning_max_tokens = 512
        wf.verifier = {"type": "FLOAT_LLM_JUDGE"}
        wf.parent_workflow_id = None
        wf.parent_agent_id = None
        wf.depth = 0
        wf.bus_id = "agent-parent"
        wf.max_iterations = None
        wf.price_limit_cents = 500
        wf.context_gates = {}
        wf.start_time = _BASE
        await wf._handle_context_overflow(compressed)
        assert len(continued) == 1
        assert wf._pending_background_ids() == []
        assert len(_notifications(harness)) == 1


async def test_agent_rows_are_user_feedback_only_from_ancestors():
    """Agent rows are never user instructions; a parent's task update still refreshes the output schema."""
    from helpers.background_agents import model_agent_row_text
    from helpers.llm import convert_context_to_messages
    from loop.dag_executor import latest_real_user_instruction
    from loop.run_agent import _real_user_requirement_keys, _requirement_keys

    agent_message = {
        "role": "USER",
        "message_id": "m-1",
        "text": "Use the Shinjuku hotel instead.",
        "metadata": {
            "agentMessage": True,
            "fromAgentId": "agent-root",
            "fromAgentPath": "/root",
            "toAgentPath": "/root/hotels",
            "messageType": "MESSAGE",
            "fromGoal": "Plan a trip",
        },
        "timestamp": _BASE.isoformat(),
    }
    notification = {
        "role": "USER",
        "message_id": "m-2",
        "text": "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/x\nPayload:\ndone",
        "metadata": {"agentNotification": True, "toolName": "agent_notification"},
        "timestamp": (_BASE + timedelta(seconds=1)).isoformat(),
    }
    assert _real_user_requirement_keys([agent_message, notification]) == set()
    assert _requirement_keys([agent_message, notification]) == {("id", "m-1")}, "only the parent's update"
    assert latest_real_user_instruction([agent_message, notification]) is None
    rendered = convert_context_to_messages([agent_message])
    assert rendered[-1] == {
        "role": "assistant",
        "content": "Message Type: MESSAGE\nTask name: /root/hotels\nSender: /root\nPayload:\nUse the Shinjuku hotel instead.",
    }, rendered
    assert model_agent_row_text(agent_message) == rendered[-1]["content"]
    assert model_agent_row_text(notification) == notification["text"]
    # Rows without a stored (or with an unknown) type render as MESSAGE.
    legacy = {
        **agent_message,
        "metadata": {"agentMessage": True, "fromAgentId": "agent-root", "messageType": "INTERRUPT"},
    }
    assert model_agent_row_text(legacy).startswith("Message Type: MESSAGE\nTask name: unknown\nSender: agent-root\n")

    harness = _Harness()
    with _workflow_env(harness):
        wf = _workflow(harness)
        revision = wf._response_schema_revision
        await wf.receive_agent_message({"message_id": "m-1"})
        assert wf._has_new_messages is True and wf._background_wake_seq == 1
        wf._has_new_messages = False
        await wf.receive_agent_message({"message_id": "m-1"})  # retried send re-signals
        assert wf._has_new_messages is False and wf._background_wake_seq == 1
        assert wf._response_schema_revision == revision
        assert wf._response_schema_feedback == []
        wf.context = [agent_message, notification]
        wf._admit_durable_response_schema_feedback()
        assert wf._response_schema_feedback == ["Use the Shinjuku hotel instead."], wf._response_schema_feedback
        assert wf._response_schema_revision == revision + 1
        wf._admit_durable_response_schema_feedback()  # admitted once
        assert wf._response_schema_revision == revision + 1


async def test_foreground_paths_never_background():
    harness = _Harness()
    with _workflow_env(harness):
        wf = _workflow(harness)
        assert wf._spawn_runs_in_background("spawn_agent", dict(EXPLORE_ARGS)) is True
        assert wf._spawn_runs_in_background("spawn_agent", {**EXPLORE_ARGS, "run_in_background": False}) is False
        assert wf._spawn_runs_in_background("spawn_agent", {"type": "browser", "goal": "x"}) is False  # invalid
        wf.current_phase = "PLAN"  # PLAN rejects non-explore spawns in the foreground path
        gp_args = {
            "type": "general_purpose",
            "task_name": "drafts",
            "goal": "Draft outreach emails.",
            "start_phase": "EXECUTE",
            "output_schema": {"fields": [{"name": "emails", "type": "str", "description": "d", "required": True}]},
        }
        assert wf._spawn_runs_in_background("spawn_agent", gp_args) is False
        wf.current_phase = "EXECUTE"
        assert wf._spawn_runs_in_background("spawn_agent", gp_args) is True
        wf._background_spawns_enabled = False  # DAG / resumed parks
        assert wf._spawn_runs_in_background("spawn_agent", dict(EXPLORE_ARGS)) is False
        wf._background_spawns_enabled = True
        wf.fast_mode_cache_enabled = True
        assert wf._spawn_runs_in_background("spawn_agent", dict(EXPLORE_ARGS)) is False


def test_tool_schemas_and_prompts_register_agent_messaging():
    from tools.prompts import TOOL_PROMPTS
    from utils.tool_schemas import (
        EXECUTE_PHASE_TOOLS,
        EXPLORE_AGENT_TOOLS,
        TOOL_MODELS,
        SpawnAgentTool,
        get_tool_models,
    )
    from workflows.agent_workflow import TOOL_EXECUTORS

    assert all(
        n in c
        for n in ("send_message_to_agent",)
        for c in (EXECUTE_PHASE_TOOLS, TOOL_MODELS, TOOL_EXECUTORS, TOOL_PROMPTS)
    )
    # list_agents is explore-only (it runs inside the explore activity, not the workflow).
    assert "list_agents" in EXPLORE_AGENT_TOOLS and "list_agents" in TOOL_MODELS and "list_agents" in TOOL_PROMPTS
    assert "list_agents" not in EXECUTE_PHASE_TOOLS and "list_agents" not in TOOL_EXECUTORS
    field = get_tool_models()["spawn_agent"].model_fields["run_in_background"]
    assert field.default is True and "returns immediately" in (field.description or "")
    # Result delivery is cross-tool semantics: it lives once, in the shared section.
    from utils.prompts import WORKING_WITH_OTHER_AGENTS_PROMPT

    assert "FINAL_ANSWER" not in field.description and "FINAL_ANSWER" in WORKING_WITH_OTHER_AGENTS_PROMPT
    # PLAN-phase spawns always run in the foreground: no run_in_background there.
    assert "run_in_background" not in get_tool_models(phase="plan")["spawn_agent"].model_fields
    assert SpawnAgentTool(tool="spawn_agent", **EXPLORE_ARGS).run_in_background is True


def test_send_message_resolves_addresses():
    from domains.agent_messaging.handler import resolve_message_target

    harness = _Harness()
    wf = _workflow(harness)
    wf.parent_agent_id = "agent-root"
    wf._own_task_path = "/root/outreach"
    wf._background_tasks["t1"] = {
        "agent_type": "explore",
        "address": "/root/outreach/scan",
        "task_name": "scan",
        "path": "/root/outreach/scan",
        "status": "running",
        "goal": "g",
    }
    wf._background_tasks["t2"] = {
        "agent_type": "general_purpose",
        "address": "/root/outreach/draft_a",
        "status": "running",
        "child_agent_ids": ["child-9"],
    }
    assert resolve_message_target(wf, "parent") == ("agent-root", None, None)
    # Own in-activity task: by path or by task id → our own inbox for that task.
    assert resolve_message_target(wf, "/root/outreach/scan") == ("agent-parent", "t1", None)
    assert resolve_message_target(wf, "t1") == ("agent-parent", "t1", None)
    # Own general_purpose child: its agent id.
    assert resolve_message_target(wf, "/root/outreach/draft_a") == ("child-9", None, None)
    # Everything else goes to the backend resolver.
    assert resolve_message_target(wf, "/root/research/scan") == (None, None, None)
    assert resolve_message_target(wf, "/root") == (None, None, None)
    for self_address in ("agent-parent", "/root/outreach"):
        assert "yourself" in (resolve_message_target(wf, self_address)[2] or "")
    wf.parent_agent_id = None
    assert resolve_message_target(wf, "parent")[2]


def _view_node(agent_id, path, parent, depth, goal, status="ACTIVE", children=0, active=0, kind="agent"):
    return {
        "agent_id": agent_id,
        "path": path,
        "parent_agent_id": parent,
        "depth": depth,
        "goal": goal,
        "status": status,
        "type": kind,
        "child_count": children,
        "active_child_count": active,
    }


def _three_level_view():
    """Backend GET /tree default view for caller /root/outreach (depth 1)."""
    root = _view_node("id-root", "/root", None, 0, "Raise a $5M seed round for Rose Labs", children=3, active=2)
    outreach = _view_node("id-out", "/root/outreach", "id-root", 1, "Investor outreach", children=3, active=2)
    return {
        "root_agent_id": "id-root",
        "caller_path": [root, outreach],
        "node_path": [root, outreach],
        "nodes": [
            root,
            _view_node("id-res", "/root/research", "id-root", 1, "Market research", children=4, active=1),
            outreach,
            _view_node("id-bud", "/root/budget", "id-root", 1, "Build the budget", status="FAILED"),
            _view_node("id-a", "/root/outreach/draft_a", "id-out", 2, "Draft email to Sequoia", children=1, active=1),
            _view_node("id-b", "/root/outreach/draft_b", "id-out", 2, "Draft email to a16z", status="COMPLETED"),
            # Persisted background tasks (Agent.backgroundTasks), listed under their owner.
            _view_node(
                "/root/research/scan",
                "/root/research/scan",
                "id-res",
                2,
                "Scan market news",
                status="running",
                kind="explore",
            ),
            _view_node(
                "/root/outreach/news",
                "/root/outreach/news",
                "id-out",
                2,
                "Scan investor news",
                status="running",
                kind="explore",
            ),
        ],
        "next_cursor": "cur2",
        "sibling_next_cursor": None,
    }


def test_list_agents_renders_default_view_as_table_of_contents():
    from domains.agent_messaging.service import render_agent_view

    text = render_agent_view(_three_level_view(), self_agent_id="id-out")
    assert text.splitlines() == [
        'You are /root/outreach (depth 1). Path: /root "Raise a $5M seed round for Rose Labs" › YOU /root/outreach',
        'Address = first column (or "parent"). Drill in: list_agents(node="<address>"). '
        'Read an agent\'s messages: grep(sources=["agent_network"], trace_path="<address>").',
        "- /root [your parent (root)] agent ACTIVE: Raise a $5M seed round for Rose Labs",
        '  - /root/research [your sibling] agent ACTIVE: Market research (4 children, 1 active) → list_agents(node="/root/research")',
        "    - /root/research/scan [task of your sibling] explore running: Scan market news",
        "  ▶ /root/outreach [YOU ARE HERE] agent ACTIVE: Investor outreach",
        '    - /root/outreach/draft_a [your child] agent ACTIVE: Draft email to Sequoia (1 child, 1 active) → list_agents(node="/root/outreach/draft_a")',
        "    - /root/outreach/draft_b [your child] agent COMPLETED: Draft email to a16z",
        "    - /root/outreach/news [your task] explore running: Scan investor news",
        '    … 1 children not shown → list_agents(node="/root/outreach", cursor="cur2")',
        "  - /root/budget [your sibling] agent FAILED: Build the budget",
    ]
    # Deterministic: the same view renders byte-identically.
    assert text == render_agent_view(_three_level_view(), self_agent_id="id-out")


def test_list_agents_renders_drill_down_and_pagination_hints():
    from domains.agent_messaging.service import render_agent_view

    root = _view_node("id-root", "/root", None, 0, "Raise a seed round", children=3, active=2)
    outreach = _view_node("id-out", "/root/outreach", "id-root", 1, "Investor outreach")
    research = _view_node("id-res", "/root/research", "id-root", 1, "Market research", children=4, active=1)
    drill = {
        "root_agent_id": "id-root",
        "caller_path": [root, outreach],
        "node_path": [root, research],
        "nodes": [
            research,
            _view_node("id-r1", "/root/research/comps", "id-res", 2, "Comparable rounds", children=2, active=0),
            _view_node("id-r2", "/root/research/funds", "id-res", 2, "Active funds", status="COMPLETED"),
            _view_node("id-r1a", "/root/research/comps/ai", "id-r1", 3, "AI infra rounds", status="COMPLETED"),
        ],
        "next_cursor": "res-2",
    }
    lines = render_agent_view(
        drill, self_agent_id="id-out", query={"node": "/root/research", "depth": "2"}
    ).splitlines()
    assert lines[2:] == [
        "Viewing /root/research: /root › /root/research",
        "- /root/research [your sibling] agent ACTIVE: Market research",
        "  - /root/research/comps [other branch] agent ACTIVE: Comparable rounds",
        "    - /root/research/comps/ai [other branch] agent COMPLETED: AI infra rounds",
        '    … 1 children not shown → list_agents(node="/root/research/comps")',
        "  - /root/research/funds [other branch] agent COMPLETED: Active funds",
        '  … 2 children not shown → list_agents(node="/root/research", cursor="res-2")',
    ], lines
    assert not any("YOU ARE HERE" in line for line in lines[2:]), "a view that does not list the caller"

    drill["nodes"] = drill["nodes"][:1] + [
        _view_node("id-r3", "/root/research/press", "id-res", 2, "Press coverage"),
    ]
    drill["next_cursor"] = None
    paged = render_agent_view(
        drill, self_agent_id="id-out", query={"node": "/root/research", "cursor": "res-2"}
    ).splitlines()
    assert paged[2] == "Viewing /root/research (next page): /root › /root/research"
    assert paged[-1] == "  - /root/research/press [other branch] agent ACTIVE: Press coverage", paged
    drill["next_cursor"] = "res-3"
    more = render_agent_view(drill, self_agent_id="id-out", query={"cursor": "res-2"})
    assert more.splitlines()[-1] == '  … more children not shown → list_agents(node="/root/research", cursor="res-3")'


def test_list_agents_marks_deep_caller_and_renders_search_breadcrumbs():
    from domains.agent_messaging.service import render_agent_view, tree_query_params

    chain = [
        _view_node("id-root", "/root", None, 0, "Raise a $5M seed round for Rose Labs, closing by December"),
        _view_node("id-out", "/root/outreach", "id-root", 1, "Investor outreach"),
        _view_node("id-a", "/root/outreach/draft_a", "id-out", 2, "Draft email to Sequoia"),
        _view_node("id-k", "/root/outreach/draft_a/lookup", "id-a", 3, "Look up the Sequoia partner"),
    ]
    view = {"root_agent_id": "id-root", "caller_path": chain, "node_path": chain, "nodes": chain, "next_cursor": None}
    lines = render_agent_view(view, self_agent_id="id-k").splitlines()
    assert lines[0] == (
        'You are /root/outreach/draft_a/lookup (depth 3). Path: /root "Raise a $5M seed round for Rose Labs, c…" '
        '› /root/outreach "Investor outreach" › /root/outreach/draft_a "Draft email to Sequoia" '
        "› YOU /root/outreach/draft_a/lookup"
    ), lines[0]
    assert lines[-1] == "      ▶ /root/outreach/draft_a/lookup [YOU ARE HERE] agent ACTIVE: Look up the Sequoia partner"
    assert lines[-2].startswith("    - /root/outreach/draft_a [your parent]")
    assert lines[-3].startswith("  - /root/outreach [your ancestor]")
    assert sum("YOU ARE HERE" in line for line in lines) == 1

    search = {
        "root_agent_id": "id-root",
        "caller_path": chain[:2],
        "node_path": chain[:2],
        "nodes": [],
        "next_cursor": None,
        "matches": [
            {**chain[2], "ancestor_ids": ["id-root", "id-out"], "child_count": 1, "active_child_count": 1},
            {**_view_node("id-legacy", None, "id-x", 2, "Sequoia follow-up"), "ancestor_ids": ["id-root", "id-x"]},
            # A background task matches as itself, not as an agent (backend search covers tasks).
            {
                **_view_node("/root/outreach/scan", "/root/outreach/scan", "id-out", 2, "Scan Sequoia news", "completed"),
                "type": "browser",
                "ancestor_ids": ["id-root", "id-out"],
            },
        ],
    }
    lines = render_agent_view(search, self_agent_id="id-out", query={"q": "sequoia"}).splitlines()
    assert lines[2:] == [
        'Matches for "sequoia" (shallowest first):',
        '- /root/outreach/draft_a [your child] agent ACTIVE: Draft email to Sequoia (1 child, 1 active) → list_agents(node="/root/outreach/draft_a")',
        "- id-legacy [other branch] agent ACTIVE: Sequoia follow-up (under id-root › id-x)",
        "- /root/outreach/scan [your task] browser completed: Scan Sequoia news",
    ], lines
    empty = render_agent_view({**search, "matches": []}, self_agent_id="id-out", query={"path_prefix": "/root/budget"})
    assert empty.splitlines()[-1] == "No agents in this tree match under /root/budget."

    assert tree_query_params({"node": "/root/x", "depth": 2, "query": "seed", "cursor": "c"}) == (
        {"node": "/root/x", "cursor": "c", "q": "seed", "depth": "2"},
        None,
    )
    assert tree_query_params({"depth": "deep"})[1]


def test_explore_list_agents_on_finished_browser_task_lists_it_completed():
    """list_agents(node=<browser task>) from an explore shows the task's truthful status (no error)."""
    from domains.agent_messaging.service import explore_tree_view, render_agent_view

    root = _view_node("id-root", "/root", None, 0, "Decline the member-number request")
    task = {
        **_view_node(
            "/root/member_number", "/root/member_number", "id-root", 1, "Read the member number", "completed"
        ),
        "type": "browser",
        "task_id": "bg_member",
    }
    # GET /:id/tree?node=/root/member_number (owner's view of one of its finished tasks).
    view = {
        "root_agent_id": "id-root",
        "caller_path": [root],
        "node_path": [root, {k: task[k] for k in ("agent_id", "path", "goal", "status", "depth")}],
        "nodes": [task],
        "next_cursor": None,
        "sibling_next_cursor": None,
    }
    view = explore_tree_view(
        view,
        owner_agent_id="id-root",
        explore_address="/root/read_trace",
        explore_path="/root/read_trace",
        explore_goal="Read the member_number trace",
        default_view=False,
    )
    lines = render_agent_view(view, self_agent_id="/root/read_trace", query={"node": "/root/member_number"})
    assert lines.splitlines()[2:] == [
        "Viewing /root/member_number: /root › /root/member_number",
        "- /root/member_number [task of your parent] browser completed: Read the member number",
    ], lines


def test_task_paths_and_names():
    from helpers.agent_addressing import (
        TASK_NAME_PATTERN,
        background_tree_entries,
        child_task_path,
        ensure_planned_task_name,
        task_name_error,
    )
    from domains.spawn_agent.service import validate_spawn_params
    from utils.tool_schemas import SPAWN_TASK_NAME_PATTERN, SpawnAgentTool, SpawnExploreAgentTool

    assert TASK_NAME_PATTERN == SPAWN_TASK_NAME_PATTERN
    for model in (SpawnAgentTool, SpawnExploreAgentTool):
        assert "task_name" in model.model_json_schema()["required"]
    assert task_name_error("draft_a") is None
    assert "requires 'task_name'" in task_name_error(None)
    assert "invalid" in task_name_error("Draft A")
    try:
        validate_spawn_params({"type": "explore", "goal": "g", "task_name": "Bad Name"})
    except ValueError as exc:
        assert "task_name" in str(exc) and "a-z" in str(exc)
    else:
        raise AssertionError("an invalid task_name must be rejected with an actionable error")
    validate_spawn_params({"type": "explore", "goal": "g", "task_name": "scan"})
    # The model-facing schema requires it (validated before dispatch in _execute_tool).
    try:
        SpawnAgentTool(tool="spawn_agent", type="explore", goal="g")
    except Exception as exc:
        assert "task_name" in str(exc)
    else:
        raise AssertionError("SpawnAgentTool must require task_name")
    assert child_task_path("/root/outreach", "scan") == "/root/outreach/scan"
    assert child_task_path(None, "scan") is None
    assert ensure_planned_task_name({}, 2) == {"task_name": "task_3"}
    assert ensure_planned_task_name({"task_name": "keep_me"}, 2) == {"task_name": "keep_me"}
    entries = background_tree_entries(
        {
            "t_1": {
                "agent_type": "explore",
                "status": "running",
                "goal": "x" * 300,
                "task_name": "scan",
                "path": "/root/scan",
                "started_at": "2026-10-19T12:00:00+00:00",
            },
            "t_2": {"agent_type": "general_purpose", "status": "running", "goal": "child row"},
            "t_3": {"agent_type": "browser", "status": "completed", "goal": "done"},
        },
        ("general_purpose", "for_each"),
    )
    assert entries == [
        {
            "address": "t_1",
            "type": "explore",
            "goal": "x" * 200,
            "status": "running",
            "started_at": "2026-10-19T12:00:00+00:00",
            "task_name": "scan",
            "path": "/root/scan",
        }
    ]


# ---------------------------------------------------------------------------
# Planned (DAG) spawns run in the background like LLM spawns; a user message
# mid-plan ends only the DAG's waits (RCA: root 439c77dd's correction sat
# unread >5 min behind foreground planned GP spawns).
# ---------------------------------------------------------------------------

_DAG_EXPLORE_PARAMS = {"tool": "spawn_agent", "type": "explore", "goal": "Find seed funds in Austin."}


def _dag_param_activity(populate_gate=None, calls=None, params=None):
    async def execute_activity(fn, args=None, **_kwargs):
        name = getattr(fn, "__name__", "")
        if calls is not None:
            calls.append((name, args))
        if "reasoning" in name:
            return {"content": "Outreach drafted.", "usage": {}}
        if populate_gate is not None:
            await populate_gate.wait()
        tool_call = dict(params or _DAG_EXPLORE_PARAMS)
        return {"response": "", "tool_calls": [tool_call], "usage": {}, "detected_tools_ordered": []}

    return execute_activity


@contextlib.contextmanager
def _dag_env(harness, wf, gate, *, park=None):
    """Real _execute_tool_once with only the spawn executor + clocks faked."""
    from temporalio import workflow as temporal_workflow
    from tools.base import EventType, MessageStatus, ToolEvent

    async def _spawn_executor(instance, tool_call, tool_call_id):
        await instance._handle_tool_event(
            ToolEvent(type=EventType.POST_MESSAGE, title="Exploring", message="", status=MessageStatus.IN_PROGRESS),
            tool_call_id,
            "spawn_agent",
        )
        await gate.wait()
        if park is not None and instance._park_pending_tool(tool_call_id, park):
            from helpers.generation_handoff import GenerationHandoffRequested

            raise GenerationHandoffRequested("queue-next", parked=True)
        await instance._handle_tool_event(
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Explore complete",
                message="Found 4 seed funds.",
                status=MessageStatus.FINISHED,
                data={"result": "Found 4 seed funds."},
                metadata={"agentType": "explore"},
            ),
            tool_call_id,
            "spawn_agent",
        )
        return MessageStatus.FINISHED, "Found 4 seed funds."

    async def _wait_condition(predicate, **_kwargs):
        while not predicate():
            await asyncio.sleep(0.002)

    async def _noop(*_args, **_kwargs):
        return None

    import workflows.agent_workflow as workflow_module

    wf._update_tree_state = _noop
    wf.current_phase = "EXECUTE"
    wf._background_spawns_enabled = False  # _planned_dag_background turns it on for the DAG
    with (
        patch.dict(workflow_module.TOOL_EXECUTORS, {"spawn_agent": _spawn_executor}),
        patch.object(temporal_workflow, "wait_condition", _wait_condition),
    ):
        yield


async def _until(predicate, turns=1000):
    for _ in range(turns):
        if predicate():
            return
        await asyncio.sleep(0.002)
    raise AssertionError("condition not reached")


async def _start_planned_dag(harness, wf, populate_gate=None, calls=None, params=None):
    """Run execute_dag inside the workflow's planned-DAG scope (as AgentWorkflow.run does)."""
    from loop.dag_executor import TaskDAG, execute_dag

    dag = TaskDAG(
        {
            "tasks": [
                {"goal": "Find seed funds in Austin.", "tool_name": "spawn_explore_agent"},
                {"goal": "Draft outreach", "tool_name": "reasoning"},
            ],
            "dependencies": {"1": ["0"]},
        }
    )

    async def poll_messages(since):
        return [row for row in harness.rows if row["timestamp"] > since.isoformat()]

    async def _run():
        with wf._planned_dag_background() as hooks:
            assert hooks is not None
            return await execute_dag(
                dag=dag,
                agent_id=wf.agent_id,
                user_id=wf.user_id,
                model="rose-labs/rose-1-flash",
                context=list(harness.rows),
                execute_activity=_dag_param_activity(populate_gate, calls, params),
                post_message=wf._post_message,
                execute_tool=wf._execute_tool,
                handle_tool_event_fn=wf._handle_tool_event,
                poll_messages=poll_messages,
                system_prompt_text="SYSTEM",
                tool_names=["spawn_agent", "attempt_completion"],
                interrupts=hooks,
            )

    running = asyncio.create_task(_run())
    await _until(lambda: any(row["metadata"].get("dagTaskIndex") == 0 for row in harness.rows))  # the DAG's early chip
    return dag, running


def _started_row(harness, planned_id):
    rows = [
        row
        for row in harness.rows
        if row["metadata"].get("toolCallId") == planned_id and row["metadata"].get("runInBackground")
    ]
    return rows[-1] if rows else None


async def test_dag_planned_spawn_runs_in_background_and_dependent_sees_child_result():
    from helpers.llm import convert_context_to_messages

    harness = _Harness()
    with _workflow_env(harness):
        wf = _workflow(harness)
        gate = asyncio.Event()
        calls = []
        harness.notification_delay = 0.05  # dependents must wait for the posted notification
        with _dag_env(harness, wf, gate):
            harness.add("USER", "Find Austin seed funds and draft outreach.")
            dag, running = await _start_planned_dag(harness, wf, calls=calls)
            planned_id = dag.tasks[0].tool_call_id
            task_id = planned_id
            await _until(lambda: _started_row(harness, planned_id) is not None)
            started = _started_row(harness, planned_id)
            # Same immediate result as an LLM background spawn.
            assert started["metadata"]["toolStatus"] == "FINISHED", started
            address = started["metadata"]["backgroundAddress"]
            assert address.startswith("/root/") and address == started["metadata"]["backgroundPath"], started
            assert f"Started explore agent in background. Address: {address}." in started["text"], started
            assert wf._pending_background_ids() == [task_id]
            await asyncio.sleep(0.02)
            assert not running.done(), "the DAG task completes with the child, not at start"
            assert dag.tasks[1].state.value == "PENDING"
            assert not any("reasoning" in name for name, _ in calls)

            gate.set()
            result = await asyncio.wait_for(running, 2)
        assert result["status"] == "completed", result
        assert wf._background_spawns_enabled is False, "the DAG scope must restore foreground-only"
        notes = _notifications(harness)
        assert len(notes) == 1 and notes[0]["metadata"]["fromAgentAddress"] == address, notes
        assert "Found 4 seed funds." in notes[0]["text"]
        # The dependent populated after the notification and read it from context.
        reasoning = [args for name, args in calls if "reasoning" in name]
        assert len(reasoning) == 1
        assert any("Found 4 seed funds." in str(row.get("text")) for row in reasoning[0][1]), reasoning[0][1]
        # bg rows are FE-only; the model sees the started row, then the notification.
        messages = convert_context_to_messages(list(harness.rows), include_assistant=True)
        result_mentions = [m for m in messages if "Found 4 seed funds." in str(m.get("content"))]
        assert len(result_mentions) == 1 and result_mentions[0]["role"] == "assistant", messages
        assert result_mentions[0]["content"].startswith("Message Type: FINAL_ANSWER\n"), messages
        assert not any(row["metadata"].get("canceled") for row in harness.rows)


async def test_dag_user_message_leaves_planned_background_spawn_running_and_notifies_once():
    from helpers.llm import convert_context_to_messages

    harness = _Harness()
    with _workflow_env(harness):
        wf = _workflow(harness)
        gate = asyncio.Event()
        with _dag_env(harness, wf, gate):
            harness.add("USER", "Find Austin seed funds and draft outreach.")
            dag, running = await _start_planned_dag(harness, wf)
            planned_id = dag.tasks[0].tool_call_id
            task_id = planned_id
            await _until(lambda: _started_row(harness, planned_id) is not None)
            address = _started_row(harness, planned_id)["metadata"]["backgroundAddress"]

            harness.add("USER", "Only funds that lead pre-seed rounds.")
            await wf.receive_user_response("Only funds that lead pre-seed rounds.")
            # Prompt hand-back: one wake, no waiting for the planned child.
            result = await asyncio.wait_for(running, 1)
            assert result["status"] == "needs_llm" and result.get("interrupted_by_message") is True, result
            assert dag.tasks[1].state.value == "PENDING"  # never started
            assert wf._pending_background_ids() == [task_id]
            planned_rows = [
                row
                for row in harness.rows
                if row["metadata"].get("toolCallId") == planned_id and not row["metadata"].get("excludeFromModel")
            ]
            assert planned_rows[-1] is _started_row(harness, planned_id), planned_rows  # no interrupted row
            before = convert_context_to_messages(list(harness.rows), include_assistant=True)
            assert before[-1]["role"] == "user" and "pre-seed" in before[-1]["content"], before

            gate.set()
            await wf._background_handles[task_id]
            await asyncio.sleep(0)

        notes = _notifications(harness)
        assert len(notes) == 1 and notes[0]["metadata"]["fromAgentAddress"] == address, notes
        assert wf._pending_background_ids() == []
        after = convert_context_to_messages(list(harness.rows), include_assistant=True)
        assert after[: len(before)] == before, (before, after)  # cached prefix unchanged
        assert len(after) == len(before) + 1 and after[-1]["role"] == "assistant", after
        assert after[-1]["content"].startswith("Message Type: FINAL_ANSWER\n"), after


async def test_dag_planned_spawn_ignores_populated_run_in_background_false():
    """Repro (bench run 2, /root/market_research): the param populator set run_in_background=false.

    The planned spawn then ran in the foreground; a mid-plan message cancelled
    the DAG's call but not its child, which kept its task path while missing
    from the background records, so the model's re-spawn of the same
    task_name failed with HTTP 409. A planned spawn is always a background
    record: the interrupt ends only the DAG's wait, the child stays listed,
    and a duplicate task_name is refused locally.
    """
    harness = _Harness()
    with _workflow_env(harness):
        wf = _workflow(harness)
        gate = asyncio.Event()
        params = {**_DAG_EXPLORE_PARAMS, "task_name": "austin_funds", "run_in_background": False}
        with _dag_env(harness, wf, gate):
            harness.add("USER", "Find Austin seed funds and draft outreach.")
            dag, running = await _start_planned_dag(harness, wf, params=params)
            planned_id = dag.tasks[0].tool_call_id
            await _until(lambda: _started_row(harness, planned_id) is not None)
            assert _started_row(harness, planned_id)["metadata"]["backgroundAddress"] == "/root/austin_funds"

            harness.add("USER", "Only funds that lead pre-seed rounds.")
            await wf.receive_user_response("Only funds that lead pre-seed rounds.")
            result = await asyncio.wait_for(running, 1)
            assert result["status"] == "needs_llm" and result.get("interrupted_by_message") is True, result
            assert wf._pending_background_ids() == [planned_id]
            assert not any(
                row["metadata"].get("toolCallId") == planned_id and row["metadata"].get("interrupted")
                for row in harness.rows
            ), harness.rows
            # The model's next turn polled the message, then re-spawns the same task_name.
            from helpers.wait_wake import note_context_snapshot, wake_mark

            note_context_snapshot(wf, wake_mark(wf))
            wf._background_spawns_enabled = True  # run_agent's scope
            retry = await asyncio.wait_for(
                wf._execute_tool_once(
                    "spawn_agent", {"type": "explore", "task_name": "austin_funds", "goal": "Again."}, "toolu_dup"
                ),
                2,
            )
            assert retry.get("error") is True and "already used" in retry["message"], retry
            gate.set()
            await asyncio.wait_for(wf._background_handles[planned_id], 2)
            await asyncio.sleep(0)
        assert len(_notifications(harness)) == 1


async def test_dag_user_message_while_spawn_populates_cancels_it_immediately():
    """Not started yet (param population in flight): cancelled at once with a paired ERROR "interrupted" row."""
    harness = _Harness()
    with _workflow_env(harness):
        wf = _workflow(harness)
        gate = asyncio.Event()
        populate_gate = asyncio.Event()
        with _dag_env(harness, wf, gate):
            dag, running = await _start_planned_dag(harness, wf, populate_gate)
            planned_id = dag.tasks[0].tool_call_id
            harness.add("USER", "Skip Austin, use Dallas.")
            await wf.receive_user_response("Skip Austin, use Dallas.")
            result = await asyncio.wait_for(running, 1)
            assert result.get("interrupted_by_message") is True, result
            populate_gate.set()
            await asyncio.sleep(0.02)
        planned_rows = [row for row in harness.rows if row["metadata"].get("toolCallId") == planned_id]
        assert [row["metadata"]["toolStatus"] for row in planned_rows] == ["IN_PROGRESS", "ERROR"], planned_rows
        assert planned_rows[-1]["metadata"].get("interrupted") is True
        assert planned_rows[-1]["metadata"]["toolName"] == planned_rows[0]["metadata"]["toolName"]
        assert wf._background_tasks == {} and not _notifications(harness)


async def test_dag_planned_spawn_handoff_carries_record_across_continue_as_new():
    """Cutover while a dependent waits on a planned background spawn: the DAG hands off,
    the record travels in the continuation state, and the next generation notifies once."""
    import json

    harness = _Harness()
    with _workflow_env(harness):
        wf = _workflow(harness)
        gate = asyncio.Event()
        with _dag_env(harness, wf, gate, park={"step": 2}):
            dag, running = await _start_planned_dag(harness, wf)
            planned_id = dag.tasks[0].tool_call_id
            task_id = planned_id
            await _until(lambda: _started_row(harness, planned_id) is not None)
            gate.set()  # the executor now observes a handoff and parks
            result = await asyncio.wait_for(running, 1)
        assert result["status"] == "generation_handoff" and result["handoff_task_queue"] == "queue-next", result
        assert dag.tasks[1].state.value == "PENDING"  # dependent never started
        assert wf._pending_background_ids() == [task_id] and not _notifications(harness)
        assert wf._background_tasks[task_id]["resume"] == {"step": 2}

        wf.max_iterations, wf.price_limit_cents, wf.context_gates = None, 100, {}
        state = json.loads(json.dumps(wf._continuation_resume_state(list(harness.rows))))
        restored = _workflow(harness)
        restored._restore_deployment_state(state)
        assert restored._pending_background_ids() == [task_id]
        calls = []
        gate2 = asyncio.Event()
        restored._execute_tool = _gated_executor(restored, harness, gate2, calls=calls, result_text="Dallas funds.")
        restored._relaunch_background_tasks()
        await asyncio.sleep(0)
        assert calls and calls[0][2] == task_id and calls[0][3] == {"step": 2}, calls
        gate2.set()
        await restored._background_handles[task_id]
        notes = _notifications(harness)
        assert len(notes) == 1 and "Dallas funds." in notes[0]["text"], notes


async def test_carried_general_purpose_record_child_rows_are_fe_only_and_notify_once():
    """A GP background record carried across continue_as_new: the durable child's
    rows under the spawn's id are FE-only and its completion posts one notification."""
    harness = _Harness()
    with _workflow_env(harness):
        restored = _workflow(harness)
        restored.child_tool_ids = {"child-gp-1": "dag-tc-gp"}
        restored.pending_children = {"child-gp-1"}
        restored._own_task_path = "/root"
        restored._restore_background_state(
            {
                "tasks": {
                    "dag-tc-gp": {
                        "tool_call_id": "dag-tc-gp",
                        "tool_args": {},
                        "agent_type": "general_purpose",
                        "address": "/root/drafts",
                        "path": "/root/drafts",
                        "goal": "Draft outreach emails.",
                        "status": "running",
                        "child_agent_ids": ["child-gp-1"],
                    }
                },
            }
        )
        # The real _post_message; only its DB activity is faked.
        del restored._post_message

        async def _noop(*_args, **_kwargs):
            return None

        async def _execute_activity(_fn, args=None, **_kwargs):
            agent_id, text, role, metadata = args[:4]
            harness.add(role, text, metadata)

        from temporalio import workflow as temporal_workflow

        restored._update_tree_state = _noop
        with patch.object(temporal_workflow, "execute_activity", _execute_activity):
            await restored.child_progress({"child_agent_id": "child-gp-1", "progress": 0.5, "goal": "Draft"})
            await restored.child_completed(
                {"child_agent_id": "child-gp-1", "result": {"status": "completed", "summary": "3 drafts ready"}}
            )
        child_rows = [row for row in harness.rows if row["metadata"].get("subAgentId") == "child-gp-1"]
        assert [row["metadata"]["toolStatus"] for row in child_rows] == ["IN_PROGRESS", "FINISHED"], child_rows
        assert all(row["metadata"]["toolCallId"] == "dag-tc-gp" for row in child_rows), child_rows
        assert all(row["metadata"].get("excludeFromModel") is True for row in child_rows), child_rows
        notes = _notifications(harness)
        assert [n["metadata"]["fromAgentAddress"] for n in notes] == ["/root/drafts"], notes
        assert notes[0]["text"] == (
            "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/drafts\nPayload:\n3 drafts ready"
        ), notes[0]["text"]
        assert restored._pending_background_ids() == []


async def test_agent_messaging_tools_decode_results_in_real_sandbox():
    """send_message_to_agent through a real worker + production sandbox.

    Regression: an activity annotated with a stringified TypedDict return type
    failed result decoding inside the sandbox ("Failed decoding arguments",
    NameError on Optional) and retried the workflow task forever.
    """
    from temporalio import activity
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from agent_messaging_sandbox_workflow import AgentMessagingSandboxProbe
    from helpers.workflow_sandbox import production_workflow_runner

    sent = []

    @activity.defn(name="send_agent_message_activity")
    async def fake_send(*args):
        sent.append(args)
        return {"delivered": True, "message_id": "msg-1"}

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue="agent-messaging-sandbox",
            workflows=[AgentMessagingSandboxProbe],
            activities=[fake_send],
            workflow_runner=production_workflow_runner(),
        ):
            results = await asyncio.wait_for(
                env.client.execute_workflow(
                    AgentMessagingSandboxProbe.run,
                    args=[
                        "agent-kid",
                        "agent-root",
                        [
                            {"tool": "send_message_to_agent", "to": "parent", "message": "Draft is ready."},
                        ],
                    ],
                    id="agent-messaging-sandbox-probe",
                    task_queue="agent-messaging-sandbox",
                ),
                timeout=60,
            )
    assert [row["status"] for row in results] == ["FINISHED"], results
    assert results[0]["text"] == "Message sent to parent.", results
    assert len(sent) == 1


async def test_background_tasks_persist_in_tree_state_and_names_stay_unique():
    """Running and finished tasks reach Agent.backgroundTasks (list_agents / grep / send); task_name collisions error."""
    from temporalio import workflow as temporal_workflow

    harness = _Harness()
    patches = []

    async def fake_execute_activity(fn, args=None, **_kwargs):
        if getattr(fn, "__name__", "") == "update_agent_tree_state":
            patches.append(args[3].get("backgroundTasks"))
        return None

    with _workflow_env(harness), patch.object(temporal_workflow, "execute_activity", fake_execute_activity):
        wf = _workflow(harness)
        gate = asyncio.Event()
        wf._execute_tool = _gated_executor(wf, harness, gate)
        await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_1")
        assert patches and patches[-1] == [
            {
                "address": "toolu_1",
                "type": "explore",
                "goal": EXPLORE_ARGS["goal"],
                "status": "running",
                "started_at": wf._background_tasks["toolu_1"]["started_at"],
                "task_name": "tokyo",
                "path": "/root/tokyo",
            }
        ], patches
        assert started_rows_have_path(harness, "/root/tokyo")

        clash = await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_2")
        assert clash.get("error") and "task_name 'tokyo' is already used" in clash["message"], clash
        assert "toolu_2" not in wf._background_tasks

        gate.set()
        await wf._background_handles["toolu_1"]
        assert [(e["address"], e["path"], e["status"]) for e in patches[-1]] == [
            ("toolu_1", "/root/tokyo", "completed")
        ], "the finished task stays in the persisted tree state (its path keeps resolving)"
        again = await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_3")
        assert again.get("error"), "a finished sibling still owns its task_name"


async def test_background_task_snapshots_persist_in_order():
    """A slow write of an older backgroundTasks snapshot never lands after a newer one.

    The spawn's start persists "running" while the task (already able to finish)
    persists "completed"; the backend applies writes in arrival order, so the
    stored Agent.backgroundTasks must end as the newest snapshot, with or
    without a tree bus.
    """
    from temporalio import workflow as temporal_workflow

    for bus_id in (None, "bus-1"):
        harness = _Harness()
        stored = {"backgroundTasks": None, "writes": []}

        async def fake_execute_activity(fn, args=None, **_kwargs):
            if getattr(fn, "__name__", "") != "update_agent_tree_state":
                return None
            tasks = (args[3] or {}).get("backgroundTasks")
            if isinstance(tasks, list) and any(task.get("status") == "running" for task in tasks):
                await asyncio.sleep(0.03)  # the older snapshot's request is slow to reach the backend
            if isinstance(tasks, list):
                stored["backgroundTasks"] = tasks
                stored["writes"].append([task.get("status") for task in tasks])
            return None

        with _workflow_env(harness), patch.object(temporal_workflow, "execute_activity", fake_execute_activity):
            wf = _workflow(harness)
            wf.bus_id = bus_id
            gate = asyncio.Event()
            gate.set()  # the task finishes while the start's persistence is in flight
            wf._execute_tool = _gated_executor(wf, harness, gate)
            await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_1")
            handle = wf._background_handles.get("toolu_1")
            if handle is not None:
                await handle
            for _ in range(20):  # let any in-flight write land
                await asyncio.sleep(0.01)
            assert wf._background_finished["toolu_1"]["status"] == "completed"
            final = [task.get("status") for task in stored["backgroundTasks"] or []]
            assert final == ["completed"], (bus_id, stored["writes"])


async def test_concurrent_same_turn_spawns_cannot_share_a_task_name():
    """Two same-turn spawns with one task_name: the own-path lookup suspends, yet only one gets the name."""
    from temporalio import workflow as temporal_workflow

    harness = _Harness()
    lookups = []

    async def fake_execute_activity(fn, args=None, **_kwargs):
        if getattr(fn, "__name__", "") == "resolve_agent_address_activity":
            lookups.append(args)
            await asyncio.sleep(0.01)  # an uncached non-root agent's own-path read is a real activity
            return {"path": "/root/mid"}
        return None

    with _workflow_env(harness), patch.object(temporal_workflow, "execute_activity", fake_execute_activity):
        wf = _workflow(harness)
        wf.depth = 1
        gate = asyncio.Event()
        wf._execute_tool = _gated_executor(wf, harness, gate)
        first, second = await asyncio.gather(
            wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_a"),
            wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_b"),
        )
        assert lookups, "the own task path was resolved through the activity"
        named = [key for key, record in wf._background_tasks.items() if record.get("task_name") == "tokyo"]
        assert named == ["toolu_a"], wf._background_tasks
        assert first.get("success") is True, first
        assert second.get("error") and "task_name 'tokyo' is already used" in second["message"], second
        assert wf._background_task_for_address("/root/mid/tokyo")["background_task_id"] == "toolu_a"
        gate.set()
        await wf._background_handles["toolu_a"]


async def test_evicted_finished_task_name_stays_reserved():
    """A name from a finished record evicted from the bounded registry still cannot be reused (or after continue_as_new)."""
    from temporalio import workflow as temporal_workflow
    from workflows.background_agents import MAX_FINISHED_BACKGROUND_TASKS

    harness = _Harness()

    async def fake_execute_activity(fn, args=None, **_kwargs):
        if getattr(fn, "__name__", "") == "resolve_agent_address_activity":
            return {"path": "/root"}
        return None

    with _workflow_env(harness), patch.object(temporal_workflow, "execute_activity", fake_execute_activity):
        wf = _workflow(harness)
        for index in range(MAX_FINISHED_BACKGROUND_TASKS + 1):
            wf._remember_finished_background_task(
                f"toolu_old_{index}",
                {"task_name": f"child_{index}", "agent_type": "general_purpose", "status": "completed"},
            )
        assert "toolu_old_0" not in wf._background_finished, "the oldest finished record is evicted"
        restored = _workflow(harness)
        restored._restore_background_state(wf._background_state_snapshot())
        for owner in (wf, restored):
            result = await owner._execute_tool_once(
                "spawn_agent", dict(EXPLORE_ARGS, task_name="child_0"), "toolu_reuse"
            )
            assert result.get("error") and "task_name 'child_0' is already used" in result["message"], result
            assert "toolu_reuse" not in owner._background_tasks


# ------------------------------------------------------------ environment context


def _environment_rows(rows):
    return [row for row in rows if (row.get("metadata") or {}).get("environmentContext") is True]


ROOT_ENVIRONMENT_NONE = (
    "<environment>\nCurrent date: 2026-10-19 (UTC)\nYou are /root, the root agent.\n"
    "Running agents you started: none\n</environment>"
)


async def test_environment_block_is_emitted_only_when_it_changes_and_after_compaction():
    """First turn emits; unchanged (even minutes later) does not; child start/finish,
    a date change and a compaction that dropped the row each emit the full block."""
    from temporalio import workflow as temporal_workflow

    harness = _Harness()
    clock = {"now": _BASE}
    with _workflow_env(harness), patch.object(temporal_workflow, "now", lambda: clock["now"]):
        wf = _workflow(harness)
        wf.depth = 0
        context = harness.rows  # run_agent's poll loads every posted row
        await wf._sync_environment_context(context)
        rows = _environment_rows(harness.rows)
        assert [row["text"] for row in rows] == [ROOT_ENVIRONMENT_NONE], rows
        assert rows[0]["role"] == "USER" and rows[0]["metadata"]["hidden"] is True
        assert rows[0]["metadata"]["idempotencyKey"].startswith("environment:")

        clock["now"] = _BASE + timedelta(minutes=37)  # time alone never changes the block
        await wf._sync_environment_context(context)
        assert len(_environment_rows(harness.rows)) == 1

        gate = asyncio.Event()
        wf._execute_tool = _gated_executor(wf, harness, gate)
        await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_1")
        await wf._sync_environment_context(context)
        await wf._sync_environment_context(context)
        rows = _environment_rows(harness.rows)
        assert len(rows) == 2 and rows[-1]["text"] == (
            "<environment>\nCurrent date: 2026-10-19 (UTC)\nYou are /root, the root agent.\n"
            "Running agents you started:\n- /root/tokyo (explore)\n</environment>"
        ), rows[-1]

        gate.set()
        await wf._background_handles["toolu_1"]
        await wf._sync_environment_context(context)
        assert [row["text"] for row in _environment_rows(harness.rows)][-1] == ROOT_ENVIRONMENT_NONE

        clock["now"] = _BASE + timedelta(days=1)
        await wf._sync_environment_context(context)
        assert "Current date: 2026-10-20 (UTC)" in _environment_rows(harness.rows)[-1]["text"]
        assert len(_environment_rows(harness.rows)) == 4

        # Compaction (continue_as_new / context reset) dropped every environment row:
        # the full block is re-emitted once, then stable again.
        compacted = [row for row in harness.rows if not _environment_rows([row])]
        await wf._sync_environment_context(compacted)
        assert len(_environment_rows(harness.rows)) == 5
        assert _environment_rows(harness.rows)[-1]["text"] == _environment_rows(harness.rows)[-2]["text"]
        keys = {row["metadata"]["idempotencyKey"] for row in _environment_rows(harness.rows)}
        assert len(keys) == 5, "every emission has its own idempotency key"

        # Fast Mode replays never get environment rows or a tail.
        wf.fast_mode_cache_enabled = True
        await wf._sync_environment_context([])
        assert len(_environment_rows(harness.rows)) == 5 and wf._environment_tail_seed() is None


async def test_environment_rows_are_never_user_instructions_or_verifier_evidence():
    from helpers.environment_context import environment_context_metadata
    from helpers.llm import build_verifier_context_messages
    from loop.dag_executor import plan_superseded_by_new_user_instruction
    from loop.run_agent import _real_user_requirement_keys
    from providers.planner_memory.transcript import trim_rows

    env = {
        "role": "USER",
        "text": ROOT_ENVIRONMENT_NONE,
        "metadata": environment_context_metadata("environment:x"),
        "timestamp": (_BASE + timedelta(seconds=5)).isoformat(),
        "message_id": "env-1",
    }
    goal = {"role": "USER", "text": "Plan a trip", "timestamp": _BASE.isoformat(), "message_id": "goal-1"}
    assert _real_user_requirement_keys([goal, env]) == _real_user_requirement_keys([goal])
    plan = {
        "role": "TOOL",
        "text": "plan",
        "metadata": {"toolName": "set_plan", "toolStatus": "FINISHED", "toolCallId": "p1"},
        "timestamp": (_BASE + timedelta(seconds=2)).isoformat(),
    }
    assert plan_superseded_by_new_user_instruction([goal, plan, env]) is False
    verifier = build_verifier_context_messages([goal, env], "VERIFY")
    assert not any("<environment>" in str(message.get("content")) for message in verifier), verifier
    rows, _dropped = trim_rows([{**goal, "createdAt": "1"}, {**env, "createdAt": "2"}])
    assert not any("<environment>" in (row.text or "") for row in rows), rows


def test_environment_tail_renders_status_and_caps_agents():
    from helpers.environment_context import merge_tree_status, render_environment_tail

    now = datetime(2026, 10, 19, 11, 12, 40, tzinfo=timezone.utc)
    agents = [
        {
            "path": "/root/outreach",
            "type": "general_purpose",
            "status": "running",
            "started_at": "2026-10-19T10:59:00+00:00",
            "agent_id": "child-1",
        },
        {
            "path": "/root/venues",
            "type": "explore",
            "status": "running",
            "started_at": "2026-10-19T11:11:55+00:00",
            "activity": "Searching the web for Napa venue capacity",
        },
    ]
    nodes = [
        {
            "agent_id": "child-1",
            "status": "ACTIVE",
            "tools_in_use": ["web_search"],
            "child_count": 3,
            "active_child_count": 1,
        }
    ]
    tail = render_environment_tail(now=now, tz_name=None, agents=merge_tree_status(agents, nodes))
    assert tail == (
        "<environment-status>\nCurrent time: 2026-10-19 11:12 UTC\nRunning agents you started:\n"
        "- /root/outreach (general_purpose, running 13m): web_search; 3 sub-agents, 1 active\n"
        "- /root/venues (explore, running 45s): Searching the web for Napa venue capacity\n"
        "</environment-status>"
    ), tail
    assert render_environment_tail(now=now, tz_name=None, agents=[]) == (
        "<environment-status>\nCurrent time: 2026-10-19 11:12 UTC\n</environment-status>"
    )
    many = [dict(agents[1], path=f"/root/venue_{i}") for i in range(11)]
    capped = render_environment_tail(now=now, tz_name=None, agents=many)
    assert capped.count("\n- /root/venue_") == 8 and "+3 more (an explore agent can list_agents)" in capped
    assert len(tail) <= 600 and len(capped) <= 900, (len(tail), len(capped))


async def test_run_agent_syncs_environment_before_each_poll_and_sends_the_tail_seed():
    from unittest.mock import AsyncMock
    import inspect

    from helpers.llm import call_llm_activity
    from loop.run_agent import run_agent

    order = []
    seeds = iter(
        [{"now": "2026-10-19T11:00:00+00:00", "agents": []}, {"now": "2026-10-19T11:03:00+00:00", "agents": []}]
    )
    tail_index = list(inspect.signature(call_llm_activity).parameters).index("environment_tail")
    activity_calls = []

    async def sync(context):
        order.append(("sync", len(context)))

    async def poll(_last_checked):
        order.append(("poll",))
        return []

    async def system_prompt():
        return "SYSTEM"

    async def execute_activity(fn, *args, **kwargs):
        if getattr(fn, "__name__", "") != "call_llm_activity":
            return {}
        activity_calls.append(kwargs.get("args") or args[0])
        return {
            "response": "",
            "tool_calls": [{"tool": "web_search", "query": "x"}],
            "usage": {},
            "detected_tools_ordered": [],
        }

    posted = []

    async def post_message(text, role, metadata=None):
        posted.append(text)

    with (
        patch("loop.run_agent.workflow.execute_activity", new=AsyncMock(side_effect=execute_activity)),
        patch("loop.run_agent.asyncio.sleep", new=AsyncMock()),
    ):
        await run_agent(
            agent_id="agent-env",
            user_id="user-env",
            system_prompt=system_prompt,
            verifier_prompt_generator=system_prompt,
            model="rose-labs/rose-1-lite",
            tools=["web_search", "attempt_completion"],
            initial_context=[{"role": "USER", "text": "Go", "timestamp": "2024-01-01T00:00:00Z"}],
            is_inside_temporal_activity=False,
            post_message=post_message,
            poll_messages=poll,
            execute_tool=AsyncMock(return_value={"message": "ok"}),
            sync_environment_context=sync,
            get_environment_tail=lambda: next(seeds),
            max_iterations=2,
            skip_verification=True,
            skip_status_updates=True,
        )
    assert [step[0] for step in order[:4]] == ["sync", "poll", "sync", "poll"], order
    assert [call[tail_index]["now"] for call in activity_calls] == [
        "2026-10-19T11:00:00+00:00",
        "2026-10-19T11:03:00+00:00",
    ], activity_calls
    assert not any("environment-status" in text for text in posted), "the tail is never persisted"


async def test_call_llm_activity_appends_tail_after_a_byte_identical_cached_prefix():
    """Two calls minutes apart with changing agent state: everything before the
    tail is identical, the tail is last and uncached, and claudeAuth's message
    breakpoint stays on the conversation (not the tail)."""
    import copy
    import json
    from unittest.mock import AsyncMock

    from helpers import llm
    from providers.rose.claude_auth import build_anthropic_body
    from providers.rose.pools import get_pool
    from providers.rose.uncached_context import is_uncached_context

    conversation = [
        {"role": "system", "content": "SYSTEM"},
        {"role": "user", "content": "Plan a team offsite in Napa"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "spawn_agent", "arguments": "{}"}}],
        },
        {
            "role": "tool",
            "tool_call_id": "t1",
            "content": "Started explore agent in background. Address: /root/venues.",
        },
    ]
    seeds = [
        {
            "now": "2026-10-19T11:00:10+00:00",
            "agents": [
                {
                    "path": "/root/venues",
                    "type": "explore",
                    "status": "running",
                    "started_at": "2026-10-19T10:59:00+00:00",
                }
            ],
        },
        {
            "now": "2026-10-19T11:04:50+00:00",
            "agents": [
                {
                    "path": "/root/venues",
                    "type": "explore",
                    "status": "running",
                    "started_at": "2026-10-19T10:59:00+00:00",
                    "activity": "Reading napa-venues.com",
                },
                {
                    "path": "/root/outreach",
                    "type": "general_purpose",
                    "status": "running",
                    "started_at": "2026-10-19T11:04:00+00:00",
                    "agent_id": "child-2",
                },
            ],
        },
    ]
    captured = []

    async def fake_structured(**kwargs):
        captured.append(kwargs["messages"])
        raise RuntimeError("stop after capture")

    async def fake_tree(agent_id, _user_id):
        return {
            "nodes": [
                {
                    "agent_id": "child-2",
                    "parent_agent_id": agent_id,
                    "status": "ACTIVE",
                    "tools_in_use": ["send_email"],
                    "child_count": 2,
                    "active_child_count": 2,
                }
            ]
        }

    with (
        patch("temporalio.activity.heartbeat"),
        patch.object(llm, "call_llm_structured_streaming", new=fake_structured),
        patch.object(llm, "stream_assistant_chunk", new=AsyncMock()),
        patch("helpers.environment_tail._fetch_tree", new=fake_tree),
    ):
        for seed in seeds:
            with contextlib.suppress(Exception):
                await llm.call_llm_activity(
                    copy.deepcopy(conversation),
                    "rose-labs/rose-1-flash",
                    [],
                    0,
                    "agent-env",
                    call_site="test_env_tail",
                    environment_tail=seed,
                )
        with contextlib.suppress(Exception):
            await llm.call_llm_activity(
                copy.deepcopy(conversation), "rose-labs/rose-1-flash", [], 0, "agent-env", call_site="test_env_tail"
            )

    assert len(captured) == 3, captured
    with_tail_a, with_tail_b, without = captured
    assert json.dumps(with_tail_a[:-1]) == json.dumps(with_tail_b[:-1]) == json.dumps(without), "prefix changed"
    assert with_tail_a[-1]["role"] == "user" and is_uncached_context(with_tail_a[-1]["content"])
    assert with_tail_a[-1]["content"] == (
        "<environment-status>\nCurrent time: 2026-10-19 11:00 UTC\nRunning agents you started:\n"
        "- /root/venues (explore, running 1m)\n</environment-status>"
    )
    assert with_tail_b[-1]["content"] == (
        "<environment-status>\nCurrent time: 2026-10-19 11:04 UTC\nRunning agents you started:\n"
        "- /root/venues (explore, running 5m): Reading napa-venues.com\n"
        "- /root/outreach (general_purpose, running 50s): send_email; 2 sub-agents, 2 active\n"
        "</environment-status>"
    )

    spec = get_pool("rose-1-flash")
    bodies = [
        build_anthropic_body(
            pool_spec=spec,
            messages=copy.deepcopy(messages),
            tools=None,
            tool_choice=None,
            response_format=None,
            max_tokens=64,
        )["messages"]
        for messages in (with_tail_a, with_tail_b, without)
    ]
    assert json.dumps(bodies[0][:-1]) == json.dumps(bodies[1][:-1]) == json.dumps(bodies[2]), bodies
    assert bodies[2][-1]["content"][-1]["cache_control"] == {"type": "ephemeral"}  # breakpoint on the conversation
    assert "cache_control" not in json.dumps(bodies[0][-1]), "the tail must never carry the breakpoint"

    # Fast Mode / write-through calls never get the tail (position keys include user turns).
    captured.clear()
    with (
        patch("temporalio.activity.heartbeat"),
        patch.object(llm, "call_llm_structured_streaming", new=fake_structured),
        patch.object(llm, "stream_assistant_chunk", new=AsyncMock()),
        patch.object(llm, "write_through_enabled_for_user", lambda _user: True),
    ):
        with contextlib.suppress(Exception):
            await llm.call_llm_activity(
                copy.deepcopy(conversation),
                "rose-labs/rose-1-flash",
                [],
                0,
                "agent-env",
                call_site="test_env_tail",
                environment_tail=seeds[0],
            )
    assert json.dumps(captured[0]) == json.dumps(without)


# ---------------------------------------------------- PLAN foreground / pause / cost limit


class _CancellableActivity:
    """A started activity that runs until it is cancelled (Temporal TRY_CANCEL handle stand-in)."""

    def __init__(self, name, kwargs):
        self.name = name
        self.kwargs = kwargs
        self.cancelled = False
        self._future = asyncio.get_running_loop().create_future()

    def done(self):
        return self._future.done()

    def cancel(self):
        self.cancelled = True
        if not self._future.done():
            self._future.set_exception(asyncio.CancelledError())

    def finish(self, result):
        self._future.set_result(result)

    def __await__(self):
        return self._future.__await__()


@contextlib.contextmanager
def _real_spawn_env(harness, started):
    """Real AgentWorkflow + real spawn_agent explore handler; only Temporal primitives are faked."""
    from types import SimpleNamespace

    from temporalio import workflow as temporal_workflow

    def _start_activity(fn, args=None, **kwargs):
        handle = _CancellableActivity(getattr(fn, "__name__", "?"), kwargs)
        started.append(handle)
        return handle

    async def _execute_activity(fn, args=None, **_kwargs):
        return ""

    async def _wait_condition(predicate, timeout=None, **_kwargs):
        while not predicate():
            await asyncio.sleep(0.002)

    with (
        _workflow_env(harness),
        patch.object(temporal_workflow, "start_activity", _start_activity),
        patch.object(temporal_workflow, "execute_activity", _execute_activity),
        patch.object(temporal_workflow, "wait_condition", _wait_condition),
        patch.object(temporal_workflow, "now", lambda: _BASE),
        patch.object(temporal_workflow, "info", lambda: SimpleNamespace(workflow_id="wf-parent", run_id="run-1")),
    ):
        yield


def _real_spawn_workflow(harness):
    wf = _workflow(harness)
    wf.current_phase = "EXECUTE"

    async def _noop(*_args, **_kwargs):
        return None

    wf._update_tree_state = _noop
    return wf


async def _spin(predicate, turns=500):
    for _ in range(turns):
        if predicate():
            return True
        await asyncio.sleep(0.002)
    return predicate()


async def test_plan_phase_spawn_stays_foreground_until_its_result_is_in_context():
    """PLAN research must finish before set_plan: a PLAN spawn blocks and posts its result row first."""
    harness = _Harness()
    started = []
    answer = "Tokyo: 14,303,513 residents (2025 census)."
    with _real_spawn_env(harness, started):
        wf = _real_spawn_workflow(harness)
        wf.current_phase = "PLAN"
        assert wf._spawn_runs_in_background("spawn_agent", dict(EXPLORE_ARGS)) is False
        call = asyncio.create_task(wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_plan"))
        assert await _spin(lambda: bool(started)), harness.rows
        await _spin(lambda: call.done(), turns=20)
        assert not call.done(), f"a PLAN-phase spawn returned before its research finished: {harness.rows}"
        assert wf._background_tasks == {} and not any(r["metadata"].get("runInBackground") for r in harness.rows)
        started[0].finish(
            {
                "status": "completed",
                "result": answer,
                "tool_call_results": [],
                "accumulated_usage": [],
                "llm_iteration_usage": [],
            }
        )
        await asyncio.wait_for(call, 2)
        finished = [r for r in harness.rows if r["metadata"].get("toolStatus") == "FINISHED"]
        # The model-visible tool result exists before the planner's next turn (set_plan).
        assert finished and answer in finished[-1]["text"], harness.rows
        assert finished[-1]["metadata"].get("toolCallId") == "toolu_plan"
        assert not finished[-1]["metadata"].get("excludeFromModel")
        assert not _notifications(harness)

        wf.current_phase = "EXECUTE"  # unchanged: EXECUTE spawns return at once
        result = await wf._execute_tool_once("spawn_agent", {**EXPLORE_ARGS, "task_name": "osaka"}, "toolu_exec")
        assert result.get("address") == "/root/osaka" and wf._pending_background_ids(), result
        await _spin(lambda: len(started) == 2)
        for handle in wf._background_handles.values():
            handle.cancel()
        await asyncio.gather(*wf._background_handles.values(), return_exceptions=True)

    from utils.tool_schemas import PLAN_TOOL_MODELS

    assert "run_in_background" not in PLAN_TOOL_MODELS["spawn_agent"].model_fields


async def _pause_like_stop(trigger, after=None):
    """Start a real background explore, apply ``trigger(wf)`` (then ``after``), return (wf, harness, activity)."""
    harness = _Harness()
    started = []
    with _real_spawn_env(harness, started):
        wf = _real_spawn_workflow(harness)
        result = await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_1")
        assert result.get("address") == "/root/tokyo", result
        assert await _spin(lambda: bool(started)), "background explore never started its activity"
        activity = started[0]
        assert activity.name == "spawn_explore_agent_activity" and not activity.done()
        await trigger(wf)
        assert await _spin(lambda: not wf._pending_background_ids()), wf._background_tasks
        await asyncio.gather(*wf._background_handles.values())
        if after is not None:
            await after(wf, harness, activity)
        return wf, harness, activity


def _assert_stopped_like_foreground(wf, harness, activity):
    from temporalio import workflow as temporal_workflow

    assert activity.cancelled, "the background explore activity was not cancelled"
    # Same activity options as a foreground spawn: a deleted (terminated) workflow's
    # activity is cancelled at its next heartbeat, background or not.
    assert activity.kwargs.get("heartbeat_timeout") is not None
    assert activity.kwargs.get("cancellation_type") == temporal_workflow.ActivityCancellationType.TRY_CANCEL
    errors = [r for r in harness.rows if r["metadata"].get("toolStatus") == "ERROR"]
    assert [r["text"] for r in errors] == ["Explore agent cancelled by user"], harness.rows
    notes = _notifications(harness)
    # Same report as the foreground pause path: the cancelled explore failed.
    assert len(notes) == 1 and notes[0]["metadata"]["status"] == "failed", notes
    assert notes[0]["metadata"]["messageType"] == "FAILED" and "Explore agent cancelled by user" in notes[0]["text"]
    assert [record["status"] for record in wf._background_finished.values()] == ["failed"], wf._background_finished


async def test_pause_cancels_background_explore_like_a_foreground_spawn():
    """User pause cancels in-flight background explore/browser/code activities (tool_stop_requested)."""

    async def _pause(wf):
        await wf.pause()

    async def _resume(wf, harness, activity):
        _assert_stopped_like_foreground(wf, harness, activity)
        rows = len(harness.rows)
        await wf.resume()  # like a foreground spawn: reported once, not relaunched
        await _spin(lambda: False, turns=20)
        assert len(harness.rows) == rows and wf._background_handles == {} and not wf._pending_background_ids()

    await _pause_like_stop(_pause, after=_resume)


async def test_cost_limit_cascade_stops_background_explore():
    async def _cost_limit(wf):
        await wf.cost_limit_reached()

    async def _check(wf, harness, activity):
        _assert_stopped_like_foreground(wf, harness, activity)

    await _pause_like_stop(_cost_limit, after=_check)


async def test_pause_and_cost_limit_cascade_to_background_children():
    """Background general_purpose / for_each children get pause, resume and cost_limit_reached."""
    from temporalio import workflow as temporal_workflow

    harness = _Harness()
    signals = []

    class _Handle:
        def __init__(self, wf_id):
            self.wf_id = wf_id

        async def signal(self, name, *args):
            signals.append((self.wf_id, name))

    with (
        _workflow_env(harness),
        patch.object(temporal_workflow, "get_external_workflow_handle", lambda wf_id: _Handle(wf_id)),
    ):
        wf = _workflow(harness)
        wf.current_phase = "EXECUTE"

        async def _noop(*_args, **_kwargs):
            return None

        wf._update_tree_state = _noop
        wf._execute_tool = _gated_executor(wf, harness, asyncio.Event())
        gp_args = {
            "type": "general_purpose",
            "task_name": "drafts",
            "goal": "Draft outreach emails to three venues.",
            "start_phase": "EXECUTE",
            "output_schema": {"fields": [{"name": "emails", "type": "str", "description": "d", "required": True}]},
        }
        await wf._execute_tool_once("spawn_agent", gp_args, "toolu_gp")
        record = next(iter(wf._background_tasks.values()))
        child = record["child_agent_ids"][0]
        # The spawn executor registers its durable child (as in the real handler).
        wf.pending_children.add(child)
        wf.child_workflow_ids[child] = f"wf-{child}"
        await wf.pause()
        await wf.resume()
        await wf.cost_limit_reached()
        assert signals == [(f"wf-{child}", "pause"), (f"wf-{child}", "resume"), (f"wf-{child}", "cost_limit_reached")]
        for handle in wf._background_handles.values():
            handle.cancel()
        await asyncio.gather(*wf._background_handles.values(), return_exceptions=True)


def test_browser_and_code_background_waits_use_the_pause_check():
    """Browser and code spawns wait on the same tool_stop_requested predicate as explore."""
    import inspect

    import domains.spawn_agent.handler as explore_handler
    import domains.spawn_browser_agent_v3.handler as browser_handler
    import domains.spawn_claude_code_agent.handler as code_handler

    for module in (explore_handler, browser_handler, code_handler):
        source = inspect.getsource(module)
        assert "or tool_stop_requested(workflow_instance, tool_call_id)" in source, module.__name__


async def test_browser_composer_message_reaches_its_browser_not_the_root():
    """A Browser-composer row (browserTaskId + excludeFromModel) is that browser's next-step input only."""
    from unittest.mock import AsyncMock

    from _test_utils import native_browser_start_source
    from domains.spawn_browser_agent_v3 import handler as h
    from helpers.context_compaction import is_excluded_from_model
    from loop.dag_executor import is_dag_interrupt_message
    from loop.run_agent import _real_user_requirement_keys

    start = await native_browser_start_source("2026-10-26T15:59:09+00:00")
    direct = {
        "id": "direct",
        "timestamp": "2026-10-26T15:59:40Z",
        "role": "USER",
        "text": "go to instacart instead",
        "metadata": {"browserTaskId": "task-1", "excludeFromModel": True},
    }
    executor_row = {
        "id": "executor",
        "timestamp": "2026-10-26T15:59:41Z",
        "role": "USER",
        "text": "UI-only background executor row",
        "metadata": {"excludeFromModel": True},
    }
    task = {"tool_call_id": "tool-1"}
    poll = AsyncMock(return_value=[start, direct, executor_row])
    with patch.object(h, "poll_new_messages", poll):
        state = await h._load_browser_resume_user_instructions("agent-1", {**task, "task_id": "task-1"})
    assert poll.await_args.kwargs == {"browser_tool_call_id": "tool-1", "browser_task_id": "task-1"}
    assert state["user_instruction_messages"] == [{"role": "user", "content": "go to instacart instead"}], state
    assert state["user_instruction_message_ids"] == ["direct"]
    # Race: a message lands after the browser's last step read, before its pause-close.
    # The final post-close read finds it and the owner gets it in the browser result.
    state["delivered_user_instruction_count"] = len(state["user_instruction_messages"])
    late = {**direct, "id": "late", "timestamp": "2026-10-26T16:01:00Z", "text": "use the oat milk instead"}
    with patch.object(h, "poll_new_messages", AsyncMock(return_value=[start, direct, late])):
        latest = await h._load_browser_resume_user_instructions("agent-1", state)
    unread = h._unread_user_instructions(state, latest)
    assert unread == ["use the oat milk instead"], unread
    owner_text = h._with_unread_user_messages("Order placed.", unread)
    assert owner_text.startswith("Order placed.") and "- use the oat milk instead" in owner_text, owner_text
    assert h._with_unread_user_messages("Order placed.", []) == "Order placed."
    # A verifier-time sync (completion / max steps) delivers input with no browser-model
    # decision after it: only the step-start count says what the browser acted on.
    verifier_synced = {**latest, "delivered_user_instruction_count": 2, "acted_user_instruction_count": 1}
    assert h._unread_user_instructions(verifier_synced, latest) == ["use the oat milk instead"]
    # The owner: hidden from its model, no DAG interrupt (no new root turn), no new requirement.
    assert is_excluded_from_model(direct)
    assert is_dag_interrupt_message(direct) is False
    assert _real_user_requirement_keys([direct]) == set()


def test_browser_acted_input_is_counted_only_at_the_model_request():
    """CodeRabbit PR #1592: a step that exits before its browser-model decision
    (observe failure, realm reload, write-lock replay) must not mark synced input
    as acted on, or the post-close read never hands it to the owner.

    The real activity sets ``acted_user_instruction_count`` exactly once, as the
    statement right before the decision's ``BrowserThinkingStream`` request.
    """
    import ast
    import inspect
    import textwrap

    from domains.spawn_browser_agent_v3 import handler as h

    tree = ast.parse(textwrap.dedent(inspect.getsource(h._spawn_browser_agent_activity_v3_real)))

    def sets_acted(node):
        return isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Subscript)
            and isinstance(t.slice, ast.Constant)
            and t.slice.value == "acted_user_instruction_count"
            for t in node.targets
        )

    def builds_stream(node):
        return (
            isinstance(node, ast.Assign)
            and isinstance(node.value, ast.Call)
            and getattr(node.value.func, "id", None) == "BrowserThinkingStream"
        )

    sites = []
    for block in ast.walk(tree):
        body = getattr(block, "body", None)
        if not isinstance(body, list):
            continue
        for index, node in enumerate(body):
            if sets_acted(node):
                following = body[index + 1] if index + 1 < len(body) else None
                sites.append(bool(following is not None and builds_stream(following)))
    assert sites == [True], f"acted count must be set once, right before the model request: {sites}"


async def run_all_tests():
    print("background_agents blackbox tests:")
    r = BlackboxResult()
    await r.record_async(
        "bg_spawn_returns_immediately_notifies_once", test_background_spawn_returns_immediately_and_notifies_once
    )
    await r.record_async(
        "browser_composer_message_reaches_browser_not_root",
        test_browser_composer_message_reaches_its_browser_not_the_root,
    )
    r.record(
        "browser_acted_input_counted_only_at_model_request",
        test_browser_acted_input_is_counted_only_at_the_model_request,
    )
    await r.record_async(
        "bg_notification_keeps_run_during_wake",
        test_background_completion_notification_keeps_its_run_when_woken_during_tree_update,
    )
    await r.record_async("bg_rows_hidden_prefix_stable", test_background_rows_hidden_and_model_prefix_is_stable)
    await r.record_async(
        "bg_spawn_fe_rows_match_foreground_spawn", test_background_spawn_fe_rows_match_a_foreground_spawn
    )
    r.record("notification_bodies_codex_cap_only_errors", test_notification_bodies_follow_codex_and_cap_only_errors)
    await r.record_async(
        "wait_for_agents_awaits_background_notification",
        test_wait_for_agents_is_how_a_background_notification_is_awaited,
    )
    await r.record_async(
        "verifier_evidence_ends_with_pending_status", test_verifier_evidence_ends_with_pending_background_status
    )
    await r.record_async("parent_finish_stops_pending_agents", test_parent_finish_stops_pending_background_agents)
    await r.record_async(
        "handoff_parks_and_resumes_in_background", test_handoff_parks_and_resumes_background_tasks_in_background
    )
    await r.record_async(
        "context_overflow_keeps_background_browser_running",
        test_context_overflow_keeps_in_flight_background_browser_running_and_notifies_once,
    )
    await r.record_async(
        "agent_rows_feedback_only_from_ancestors", test_agent_rows_are_user_feedback_only_from_ancestors
    )
    await r.record_async("foreground_paths_never_background", test_foreground_paths_never_background)
    await r.record_async(
        "dag_planned_spawn_background_dependent_sees_result",
        test_dag_planned_spawn_runs_in_background_and_dependent_sees_child_result,
    )
    await r.record_async(
        "dag_interrupt_leaves_bg_spawn_running_notifies_once",
        test_dag_user_message_leaves_planned_background_spawn_running_and_notifies_once,
    )
    await r.record_async(
        "dag_interrupt_while_populating_cancels_immediately",
        test_dag_user_message_while_spawn_populates_cancels_it_immediately,
    )
    await r.record_async(
        "dag_planned_spawn_ignores_run_in_background_false",
        test_dag_planned_spawn_ignores_populated_run_in_background_false,
    )
    await r.record_async(
        "dag_planned_spawn_handoff_continue_as_new",
        test_dag_planned_spawn_handoff_carries_record_across_continue_as_new,
    )
    await r.record_async(
        "carried_gp_child_rows_fe_only_notify_once",
        test_carried_general_purpose_record_child_rows_are_fe_only_and_notify_once,
    )
    r.record("schemas_prompts_register_agent_messaging", test_tool_schemas_and_prompts_register_agent_messaging)
    r.record("send_message_resolves_addresses", test_send_message_resolves_addresses)
    r.record("list_agents_default_view_toc", test_list_agents_renders_default_view_as_table_of_contents)
    r.record("list_agents_drill_down_pagination", test_list_agents_renders_drill_down_and_pagination_hints)
    r.record("list_agents_you_marker_search", test_list_agents_marks_deep_caller_and_renders_search_breadcrumbs)
    r.record(
        "explore_list_agents_finished_browser_task",
        test_explore_list_agents_on_finished_browser_task_lists_it_completed,
    )
    r.record("task_paths_and_names", test_task_paths_and_names)
    await r.record_async(
        "bg_tasks_persist_and_names_unique", test_background_tasks_persist_in_tree_state_and_names_stay_unique
    )
    await r.record_async("bg_task_snapshots_persist_in_order", test_background_task_snapshots_persist_in_order)
    await r.record_async(
        "concurrent_spawns_cannot_share_task_name", test_concurrent_same_turn_spawns_cannot_share_a_task_name
    )
    await r.record_async("evicted_finished_task_name_stays_reserved", test_evicted_finished_task_name_stays_reserved)
    await r.record_async(
        "agent_messaging_tools_decode_in_real_sandbox", test_agent_messaging_tools_decode_results_in_real_sandbox
    )
    await r.record_async(
        "environment_block_emitted_on_change_and_after_compaction",
        test_environment_block_is_emitted_only_when_it_changes_and_after_compaction,
    )
    await r.record_async(
        "environment_rows_never_user_instructions",
        test_environment_rows_are_never_user_instructions_or_verifier_evidence,
    )
    r.record("environment_tail_status_and_cap", test_environment_tail_renders_status_and_caps_agents)
    await r.record_async(
        "run_agent_environment_sync_and_tail_seed",
        test_run_agent_syncs_environment_before_each_poll_and_sends_the_tail_seed,
    )
    await r.record_async(
        "environment_tail_prefix_byte_identical",
        test_call_llm_activity_appends_tail_after_a_byte_identical_cached_prefix,
    )
    await r.record_async(
        "plan_phase_spawn_stays_foreground", test_plan_phase_spawn_stays_foreground_until_its_result_is_in_context
    )
    await r.record_async(
        "pause_cancels_background_explore", test_pause_cancels_background_explore_like_a_foreground_spawn
    )
    await r.record_async("cost_limit_stops_background_explore", test_cost_limit_cascade_stops_background_explore)
    await r.record_async(
        "pause_cost_limit_cascade_to_bg_children", test_pause_and_cost_limit_cascade_to_background_children
    )
    r.record("browser_code_waits_use_pause_check", test_browser_and_code_background_waits_use_the_pause_check)
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
