"""Blackbox tests: kill_agent (a normal failure), send_message_to_agent, waking finished agents.

Drives the real AgentWorkflow methods / signal handlers and the real tool
handlers on a bare instance (no Temporal server): only the DB-posting edge
(handle_tool_event / _post_message), backend activities and the spawned
executors are faked, so the asserted behavior is the workflow's own. The
last case runs the tool handlers through a real worker + production sandbox.
"""

import asyncio
import contextlib
import logging
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from _test_utils import BlackboxResult

_BASE = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)
EXPLORE_ARGS = {"type": "explore", "task_name": "tokyo", "goal": "Find the population of Tokyo with a cited source."}


class _Harness:
    def __init__(self) -> None:
        self.rows = []
        self.activities = []
        self.activity_results = {}
        self.signals = []
        self._tick = 0

    def add(self, role, text, metadata=None):
        self._tick += 1
        row = {
            "role": role,
            "text": text,
            "metadata": metadata or {},
            "timestamp": (_BASE + timedelta(seconds=self._tick)).isoformat(),
        }
        self.rows.append(row)
        return row

    async def handle_tool_event(self, event, agent_id, tool_call_id, tool_name, **_kwargs):
        from tools.base import AssistantEvent

        if isinstance(event, AssistantEvent):
            self.add("ASSISTANT", event.message or "")
            return
        self.add(
            "TOOL",
            event.message or "",
            {
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "toolStatus": event.status.value if event.status else "IN_PROGRESS",
                "title": event.title or tool_name,
                **(event.metadata or {}),
            },
        )

    async def post_message(self, text, role="ASSISTANT", metadata=None, **_kwargs):
        self.add(role, text, metadata)

    async def execute_activity(self, fn, args=None, **_kwargs):
        name = getattr(fn, "__name__", str(fn))
        self.activities.append((name, list(args or [])))
        result = self.activity_results.get(name)
        return result(*(args or [])) if callable(result) else result

    def external_handle(self, workflow_id):
        harness = self

        class _Handle:
            async def signal(self, name, *args):
                harness.signals.append((workflow_id, name, args))

        return _Handle()

    def tool_rows(self, tool_call_id):
        return [row for row in self.rows if row["metadata"].get("toolCallId") == tool_call_id]

    def notifications(self):
        return [row for row in self.rows if row["metadata"].get("agentNotification") is True]


@contextlib.contextmanager
def _env(harness):
    import workflows.agent_control as agent_control
    from temporalio import workflow as temporal_workflow

    counter = iter(range(1, 10_000))

    def _uuid4():
        import uuid

        return uuid.UUID(int=next(counter))

    async def _wait_condition(predicate, timeout=None, **_kwargs):
        loop = asyncio.get_running_loop()
        deadline = None if timeout is None else loop.time() + timeout.total_seconds()
        while not predicate():
            if deadline is not None and loop.time() >= deadline:
                raise asyncio.TimeoutError()
            await asyncio.sleep(0.002)

    with (
        patch.object(temporal_workflow, "logger", logging.getLogger("agent-control-test")),
        patch.object(temporal_workflow, "uuid4", _uuid4),
        patch.object(temporal_workflow, "wait_condition", _wait_condition),
        patch.object(temporal_workflow, "execute_activity", harness.execute_activity),
        patch.object(temporal_workflow, "get_external_workflow_handle", harness.external_handle),
        patch.object(temporal_workflow, "info", lambda: SimpleNamespace(workflow_id="wf-agent", run_id="run-1")),
        patch.object(agent_control, "INTERRUPT_TOOL_GRACE", timedelta(seconds=0.05)),
        patch("workflows.agent_workflow.handle_tool_event", harness.handle_tool_event),
    ):
        yield


def _workflow(harness, *, agent_id="agent-mid", depth=0, parent=None):
    from workflows.agent_workflow import AgentWorkflow

    async def _noop(*_args, **_kwargs):
        return None

    wf = AgentWorkflow()
    wf.agent_id = agent_id
    wf.user_id = "user-1"
    wf.goal = "Plan an offsite"
    wf.depth = depth
    wf.parent_agent_id = parent
    wf.parent_workflow_id = parent
    wf.current_phase = "EXECUTE"
    wf._post_message = harness.post_message
    wf._update_tree_state = _noop
    wf._background_spawns_enabled = True
    return wf


def _fake_executor(wf, *, bg_gate, fg_gate, calls):
    """Background spawns wait on bg_gate; LLM-turn tools post IN_PROGRESS and wait on fg_gate."""
    from tools.base import EventType, MessageStatus, ToolEvent

    async def _execute_tool(tool_name, tool_args, tool_call_id):
        calls.append(tool_call_id)
        await wf._handle_tool_event(
            ToolEvent(type=EventType.POST_MESSAGE, title=tool_name, message="", status=MessageStatus.IN_PROGRESS),
            tool_call_id,
            tool_name,
        )
        # The background executor runs under its spawn's own id while the record exists.
        await (bg_gate if tool_call_id in wf._background_tasks else fg_gate).wait()
        await wf._handle_tool_event(
            ToolEvent(type=EventType.POST_MESSAGE, title=tool_name, message="done", status=MessageStatus.FINISHED),
            tool_call_id,
            tool_name,
        )
        return {"success": True, "message": "done"}

    return _execute_tool


async def test_kill_cancels_inflight_tool_and_skips_undecided_calls():
    """kill: the LLM-turn tool is cancelled with a paired ERROR row; later calls of the turn are not run."""
    harness = _Harness()
    with _env(harness):
        wf = _workflow(harness, depth=1, parent="agent-root")
        bg_gate, fg_gate, calls = asyncio.Event(), asyncio.Event(), []
        wf._execute_tool = _fake_executor(wf, bg_gate=bg_gate, fg_gate=fg_gate, calls=calls)

        call = asyncio.create_task(wf._execute_interruptible_tool("web_search", {"query": "venues"}, "toolu_ws"))
        for _ in range(200):
            if "toolu_ws" in calls:
                break
            await asyncio.sleep(0.002)
        await wf.kill({"by_agent_id": "agent-root", "by_agent_path": "/root", "idempotency_key": "k0"})
        result = await asyncio.wait_for(call, 5)

        assert result.get("interrupted") is True and "killed by /root" in result["message"], result
        terminal = [r for r in harness.tool_rows("toolu_ws") if r["metadata"]["toolStatus"] == "ERROR"]
        assert len(terminal) == 1 and terminal[0]["metadata"].get("interrupted") is True, harness.tool_rows("toolu_ws")
        events = [e for e in wf._wait_wake_events if e["kind"] == "aborted"]
        assert len(events) == 1 and events[0]["from_agent_path"] == "/root", wf._wait_wake_events
        assert wf._has_new_messages is True and wf._orphaned is True

        await wf.kill({"by_agent_id": "agent-root", "idempotency_key": "k0"})
        assert len([e for e in wf._wait_wake_events if e["kind"] == "aborted"]) == 1, "a retried kill is deduped"

        # A tool call of a turn decided before the kill is not run.
        skipped = await wf._execute_interruptible_tool("web_search", {"query": "x"}, "toolu_skip")
        assert skipped.get("interrupted") and skipped["message"].startswith("Not run"), skipped
        assert "toolu_skip" not in calls
        assert [r["metadata"]["toolStatus"] for r in harness.tool_rows("toolu_skip")] == ["ERROR"]
        fg_gate.set()


def test_tool_stop_requested_marks_only_interrupted_llm_turn_calls():
    from helpers.tool_interrupts import tool_stop_requested

    wf = SimpleNamespace(is_paused=False, _interrupted_tool_calls={"toolu_1"})
    assert tool_stop_requested(wf, "toolu_1") is True
    assert tool_stop_requested(wf, "toolu_2") is False
    assert tool_stop_requested(SimpleNamespace(is_paused=True), "anything") is True
    assert tool_stop_requested(SimpleNamespace(is_paused=False), "toolu_1") is False


async def test_kill_fails_through_the_normal_failure_path_with_killed_by_reason():
    """A killed agent fails like any failure: error_reason / failure reason "Killed by <killer>"; its subtree too."""
    harness = _Harness()
    with _env(harness):
        wf = _workflow(harness, depth=1, parent="agent-root")
        wf._background_tasks["toolu_gp"] = {
            "tool_call_id": "toolu_gp",
            "agent_type": "general_purpose",
            "address": "/root/mid/kid",
            "path": "/root/mid/kid",
            "goal": "Draft the venue email",
            "status": "running",
            "child_agent_ids": ["agent-kid"],
        }
        wf.pending_children.add("agent-kid")
        wf.child_tool_ids["agent-kid"] = "toolu_gp"
        await wf.kill({"by_agent_id": "agent-sib", "by_agent_path": "/root/sib", "idempotency_key": "k1"})
        assert await wf._check_orphaned() is True
        assert wf._abort_reason() == ("Killed by /root/sib", "Killed by /root/sib")
        assert [e["kind"] for e in wf._wait_wake_events][-1] == "aborted"

        reason, message = wf._abort_reason()
        await wf._mark_failed(context=[], reason=reason, message=message, verifier_reasoning=message)
        own_path = await wf._notification_recipient()
        stops = [s for s in harness.signals if s[0] == "agent-kid" and s[1] == "parent_finished"]
        assert stops == [("agent-kid", "parent_finished", ({"killed_by": "/root/sib", "killed_parent": own_path},))]
        assert wf._background_finished["toolu_gp"]["status"] == "failed"
        parent_signals = [s for s in harness.signals if s[0] == "agent-root" and s[1] == "child_completed"]
        assert len(parent_signals) == 1, harness.signals
        result = parent_signals[0][2][0]["result"]
        assert result["status"] == "failed" and result["error_reason"] == "Killed by /root/sib", result
        # SubAgentTree's failed row shows failure_context.verifier_reasoning.
        assert result["failure_context"]["verifier_reasoning"] == "Killed by /root/sib", result

        # The stopped descendant fails with the same reason, naming its killed parent.
        child = _workflow(harness, agent_id="agent-kid", depth=2, parent=wf.agent_id)
        await child.parent_finished(stops[0][2][0])
        assert await child._check_orphaned() is True
        expected = f"Killed by /root/sib (parent {own_path} was killed)"
        assert child._abort_reason() == (expected, expected)
        assert child._reports_finish_to_parent() is False, "a stopped descendant's parent is already done"

        # A plain parent finish still stops the child as orphaned.
        orphan = _workflow(harness, agent_id="agent-orphan", depth=2, parent=wf.agent_id)
        await orphan.parent_finished()
        assert orphan._abort_reason()[0] == "orphaned"

    harness = _Harness()
    with _env(harness):
        wf = _workflow(harness, depth=1, parent="agent-root")
        await wf.kill({"by_agent_id": "agent-root", "idempotency_key": "k2"})
        assert wf._reports_finish_to_parent() is True, "a killed agent reports its failure to its parent"


async def test_kill_own_background_task_and_kill_signal_for_task():
    from domains.agent_messaging.handler import kill_agent

    harness = _Harness()
    with _env(harness):
        wf = _workflow(harness)
        own_path = await wf._notification_recipient()
        bg_gate, fg_gate, calls = asyncio.Event(), asyncio.Event(), []
        wf._execute_tool = _fake_executor(wf, bg_gate=bg_gate, fg_gate=fg_gate, calls=calls)
        await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_a")
        handle = wf._background_handles["toolu_a"]
        status, text = await kill_agent(wf, {"to": "/root/tokyo"}, "toolu_kill")
        assert status.value == "FINISHED" and text == "Killed /root/tokyo.", text
        assert handle.cancelled() or handle.done()
        assert wf._background_finished["toolu_a"]["status"] == "failed"
        notes = harness.notifications()
        assert len(notes) == 1 and notes[0]["metadata"]["messageType"] == "FAILED", notes
        assert f"Killed by {own_path}" in notes[0]["text"], notes
        assert not [a for a in harness.activities if a[0] == "kill_agent_activity"], "own tasks are killed locally"

        status, text = await kill_agent(wf, {"to": "/root/tokyo"}, "toolu_kill2")
        assert "already failed" in text, text

        await wf._execute_tool_once("spawn_agent", {**EXPLORE_ARGS, "task_name": "osaka"}, "toolu_b")
        await wf.kill(
            {
                "by_agent_id": "agent-root",
                "by_agent_path": "/root/boss",
                "task_id": "/root/osaka",
                "idempotency_key": "k3",
            }
        )
        notes = harness.notifications()
        assert len(notes) == 2 and notes[1]["metadata"]["status"] == "failed", notes
        assert notes[1]["metadata"]["messageType"] == "FAILED" and "Killed by /root/boss" in notes[1]["text"], notes
        assert wf._kill_request is None, "killing a task does not kill its owner"

        # A durable general_purpose task: its child gets kill and fails itself (child_completed finishes it).
        wf._background_tasks["toolu_gp"] = {
            "tool_call_id": "toolu_gp",
            "agent_type": "general_purpose",
            "address": "/root/kid",
            "path": "/root/kid",
            "goal": "Venue research",
            "status": "running",
            "child_agent_ids": ["agent-kid"],
        }
        wf.pending_children.add("agent-kid")
        wf.child_tool_ids["agent-kid"] = "toolu_gp"
        status, text = await kill_agent(wf, {"to": "/root/kid"}, "toolu_kill4")
        kills = [s for s in harness.signals if s[0] == "agent-kid" and s[1] == "kill"]
        assert len(kills) == 1 and kills[0][2][0]["by_agent_path"] == own_path, harness.signals
        assert wf._background_tasks["toolu_gp"]["status"] == "running", "the child's failure finishes the record"

        status, text = await kill_agent(wf, {"to": "parent"}, "toolu_kill3")
        assert status.value == "ERROR" and "cannot kill your parent" in text, text


async def test_kill_own_activity_task_keeps_kill_reason_when_executor_absorbs_cancel():
    """A killed explore task reports "Killed by <killer>" even when its executor absorbs the cancel.

    The real spawn handlers catch the activity cancellation (Temporal surfaces it
    as ActivityError) and post their own ERROR row, so ``_run_background_task``
    finishes the record before the kill path does. The one FAILED notification
    must still carry the kill reason the parent needs.
    """
    from domains.agent_messaging.handler import kill_agent
    from tools.base import EventType, MessageStatus, ToolEvent

    async def _absorbing_spawn_executor(workflow_instance, tool_call, tool_call_id):
        # Legacy-signature executor run through the real _execute_tool → _execute_tool_once.
        gate = asyncio.Event()
        try:
            await gate.wait()
        except asyncio.CancelledError:
            text = "Explore agent cancelled by user"
            await workflow_instance._handle_tool_event(
                ToolEvent(
                    type=EventType.POST_MESSAGE, title="Research cancelled", message=text, status=MessageStatus.ERROR
                ),
                tool_call_id,
                "spawn_agent",
            )
            return MessageStatus.ERROR, text
        return MessageStatus.FINISHED, "done"

    harness = _Harness()
    with (
        _env(harness),
        patch.dict("workflows.agent_workflow.TOOL_EXECUTORS", {"spawn_agent": _absorbing_spawn_executor}),
    ):
        wf = _workflow(harness)
        own_path = await wf._notification_recipient()
        await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_a")
        await asyncio.sleep(0.01)  # the executor is running inside its activity wait
        assert "toolu_a" in wf._background_handles
        status, text = await kill_agent(wf, {"to": "/root/tokyo"}, "toolu_kill")
        assert status.value == "FINISHED" and text == "Killed /root/tokyo.", text
        assert wf._background_finished["toolu_a"]["status"] == "failed"
        notes = harness.notifications()
        assert len(notes) == 1 and notes[0]["metadata"]["messageType"] == "FAILED", notes
        assert f"Killed by {own_path}" in notes[0]["text"], notes[0]["text"]


async def test_rewoken_child_completion_appends_a_new_notification():
    harness = _Harness()
    with _env(harness):
        wf = _workflow(harness)
        wf._background_finished["toolu_gp"] = {
            "tool_call_id": "toolu_gp",
            "agent_type": "general_purpose",
            "address": "/root/kid",
            "path": "/root/kid",
            "goal": "Venue research",
            "status": "completed",
        }
        wf.child_tool_ids["agent-kid"] = "toolu_gp"
        for summary in ("Parking: 40 spots", "Catering: yes"):
            await wf.child_completed(
                {"child_agent_id": "agent-kid", "result": {"status": "completed", "summary": summary}}
            )
        notes = harness.notifications()
        assert len(notes) == 2, harness.rows
        assert notes[0]["text"].startswith("Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/kid\n")
        assert "Parking: 40 spots" in notes[0]["text"]
        assert len({n["metadata"]["idempotencyKey"] for n in notes}) == 2
        assert not [r for r in harness.rows if r["role"] == "TOOL"], "the original spawn result is never rewritten"
        assert wf._wait_wake_events[-1]["kind"] == "agent_notification"
        assert wf._wait_wake_events[-1]["child_agent_ids"] == ["agent-kid"]

        # A first completion still takes the normal path.
        wf.pending_children.add("agent-new")
        wf.child_tool_ids["agent-new"] = "toolu_fg"
        assert await wf._on_rewoken_child_completed("agent-new", {"status": "completed"}) is False


async def test_carried_child_killed_by_other_agent_notifies_failed():
    harness = _Harness()
    with _env(harness):
        wf = _workflow(harness)
        wf._background_tasks["toolu_gp"] = {
            "tool_call_id": "toolu_gp",
            "agent_type": "general_purpose",
            "address": "/root/kid",
            "path": "/root/kid",
            "goal": "Venue research",
            "status": "running",
            "child_agent_ids": ["agent-kid"],
        }
        wf.pending_children.add("agent-kid")
        wf.child_tool_ids["agent-kid"] = "toolu_gp"
        await wf.child_completed(
            {
                "child_agent_id": "agent-kid",
                "result": {
                    "status": "failed",
                    "summary": "Failed: Killed by /root/x",
                    "error_reason": "Killed by /root/x",
                },
            }
        )
        notes = harness.notifications()
        assert len(notes) == 1 and notes[0]["metadata"]["status"] == "failed", notes
        assert notes[0]["text"].startswith("Message Type: FAILED\nTask name: /root\nSender: /root/kid\n"), notes
        assert "Killed by /root/x" in notes[0]["text"], notes


async def test_handlers_send_and_metadata():
    from domains.agent_messaging.handler import send_message_to_agent

    harness = _Harness()
    with _env(harness):
        wf = _workflow(harness)
        bg_gate, fg_gate, calls = asyncio.Event(), asyncio.Event(), []
        wf._execute_tool = _fake_executor(wf, bg_gate=bg_gate, fg_gate=fg_gate, calls=calls)
        await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_a")

        harness.activity_results["send_agent_message_to_address_activity"] = {
            "delivered": True,
            "woke": True,
            "to": {"agent_id": "agent-kid", "path": "/root/kid"},
        }
        status, text = await send_message_to_agent(wf, {"to": "/root/kid", "message": "Also check parking."}, "toolu_s")
        assert status.value == "FINISHED" and "had finished; this message started its next run" in text, text
        meta = harness.tool_rows("toolu_s")[-1]["metadata"]
        assert meta["message"] == "Also check parking." and meta["to"] == "/root/kid"
        assert meta["resolvedPath"] == "/root/kid" and meta["woke"] is True, meta

        # A finished task too old to keep its wake context: stored, not woken (actionable reason).
        wf._background_finished["toolu_old"] = {
            "agent_type": "explore",
            "address": "/root/booker",
            "status": "completed",
            "path": "/root/booker",
        }
        harness.activity_results["send_agent_message_activity"] = {"message_id": "m-old", "delivered": False}
        status, text = await send_message_to_agent(wf, {"to": "/root/booker", "message": "again"}, "toolu_s2")
        assert status.value == "FINISHED" and "was not woken" in text and "spawn a new one" in text, text

        bg_gate.set()
        await asyncio.gather(*wf._background_handles.values(), return_exceptions=True)


_SCHEMA = {"fields": [{"name": "result", "type": "str", "description": "d", "required": True}]}
BROWSER_ARGS = {
    "type": "browser",
    "task_name": "booker",
    "goal": "Find the member number on the shop site.",
    "start_url": "https://shop.example.com/",
    "output_schema": _SCHEMA,
}
CODE_ARGS = {"type": "code", "task_name": "coder", "goal": "Add a README badge.", "output_schema": _SCHEMA}


async def test_send_to_browser_and_code_tasks_follows_their_lifecycle():
    """W3 (Andy 2026-10-23): completed browser/code agents cannot be messaged; paused ones resume explicitly.

    Completed/failed → the send fails with the reason and nothing is stored.
    Paused (a user pause ended the run; workflow state, not result text) →
    continue_conversation is required; true keeps the conversation (browser:
    same inbox + archived transcript marker; code: the message is the next CLI
    turn), false starts fresh (code: new CLI conversation in the same session).
    """
    from domains.agent_messaging.handler import send_message_to_agent
    from helpers.agent_addressing import background_tree_entries
    from helpers.background_agents import CHILD_WORKFLOW_AGENT_TYPES

    harness = _Harness()
    with _env(harness):
        wf = _workflow(harness)
        wf.current_phase = "EXECUTE"
        gates = {}
        runs = []
        outcomes = {}

        async def _executor(tool_name, tool_args, tool_call_id):
            runs.append((tool_call_id, dict(tool_args)))
            gate = gates.setdefault(tool_call_id, asyncio.Event())
            await gate.wait()
            gate.clear()
            return outcomes.get(tool_call_id, {"success": True, "message": "done"})

        wf._execute_tool = _executor
        await wf._execute_tool_once("spawn_agent", dict(BROWSER_ARGS), "toolu_b")
        await wf._execute_tool_once("spawn_agent", dict(CODE_ARGS), "toolu_c")
        for _ in range(200):
            if len(runs) == 2:
                break
            await asyncio.sleep(0.002)

        # 1. Completed browser and code tasks: listed as completed; a send fails before storing.
        for task_id in ("toolu_b", "toolu_c"):
            gates[task_id].set()
        await asyncio.gather(*wf._background_handles.values(), return_exceptions=True)
        entries = background_tree_entries(wf._background_tasks, CHILD_WORKFLOW_AGENT_TYPES, wf._background_finished)
        assert sorted((e["path"], e["type"], e["status"]) for e in entries) == [
            ("/root/booker", "browser", "completed"),
            ("/root/coder", "code", "completed"),
        ], entries
        for path, kind in (("/root/booker", "browser"), ("/root/coder", "code")):
            stored_before = len(harness.activities)
            status, text = await send_message_to_agent(
                wf, {"to": path, "message": "One more thing."}, f"toolu_send_{kind}"
            )
            assert status.value == "ERROR", text
            assert text == (
                f"{path} is a completed {kind} agent; completed browser and code agents cannot be "
                f"messaged. Spawn a new {kind} agent for new work."
            ), text
            assert len(harness.activities) == stored_before, "a refused send stores nothing"
            assert harness.tool_rows(f"toolu_send_{kind}")[-1]["metadata"]["toolStatus"] == "ERROR"
        assert len(runs) == 2, "no run was started"

        # 2. A user pause ends a running browser/code run as "paused" (not failed).
        await wf._execute_tool_once("spawn_agent", {**BROWSER_ARGS, "task_name": "booker2"}, "toolu_pb")
        await wf._execute_tool_once("spawn_agent", {**CODE_ARGS, "task_name": "coder2"}, "toolu_pc")
        for _ in range(200):
            if len(runs) == 4:
                break
            await asyncio.sleep(0.002)
        await wf.pause()
        for task_id in ("toolu_pb", "toolu_pc"):
            outcomes[task_id] = {"error": True, "message": "Run cancelled"}
            gates[task_id].set()
        await asyncio.gather(*wf._background_handles.values(), return_exceptions=True)
        await wf.resume()
        statuses = {k: v["status"] for k, v in wf._background_finished.items()}
        assert statuses["toolu_pb"] == "paused" and statuses["toolu_pc"] == "paused", statuses
        entries = background_tree_entries(wf._background_tasks, CHILD_WORKFLOW_AGENT_TYPES, wf._background_finished)
        assert {e["path"]: e["status"] for e in entries}["/root/booker2"] == "paused", entries

        # Paused without continue_conversation: refused with the reason, nothing stored.
        stored_before = len(harness.activities)
        status, text = await send_message_to_agent(wf, {"to": "/root/booker2", "message": "Go on."}, "toolu_s0")
        assert status.value == "ERROR" and "set continue_conversation" in text, text
        assert len(harness.activities) == stored_before

        # 3. continue_conversation=true on the browser: same inbox, archived-transcript marker, goal unchanged.
        harness.activity_results["send_agent_message_activity"] = {"message_id": "m-b", "delivered": False}
        status, text = await send_message_to_agent(
            wf, {"to": "/root/booker2", "message": "Use the second login.", "continue_conversation": True}, "toolu_s1"
        )
        assert status.value == "FINISHED" and "its prior conversation continues" in text, text
        sends = [a for a in harness.activities if a[0] == "send_agent_message_activity"]
        assert sends[-1][1][4] == "toolu_pb" and sends[-1][1][6] is True, sends[-1]
        record = wf._background_tasks["toolu_pb"]
        assert (record["run"], record["inbox_address"]) == (2, "toolu_pb"), record
        for _ in range(200):
            if len(runs) == 5:
                break
            await asyncio.sleep(0.002)
        browser_args = runs[-1][1]
        assert browser_args["_resume_paused_conversation"] == {"inbox_address": "toolu_pb"}, browser_args
        assert browser_args["goal"] == BROWSER_ARGS["goal"], "the restored conversation keeps its goal"

        # 4. continue_conversation=false on the code agent: fresh CLI conversation, same session.
        harness.activity_results["send_agent_message_activity"] = {"message_id": "m-c", "delivered": False}
        status, text = await send_message_to_agent(
            wf, {"to": "/root/coder2", "message": "Also add a license.", "continue_conversation": False}, "toolu_s2"
        )
        assert status.value == "FINISHED" and "fresh conversation" in text, text
        for _ in range(200):
            if len(runs) == 6:
                break
            await asyncio.sleep(0.002)
        code_args = runs[-1][1]
        assert code_args["_fresh_conversation"] is True and "_resume_paused_conversation" not in code_args
        assert code_args["goal"].startswith("Also add a license.\n\n") and CODE_ARGS["goal"] in code_args["goal"]
        assert wf._background_tasks["toolu_pc"]["inbox_address"] == "toolu_pc.run2"

        # 5. Another agent's message reaches the owner as a signal carrying the flag.
        for task_id in ("toolu_pb", "toolu_pc"):
            gates[task_id].set()
        await asyncio.gather(*wf._background_handles.values(), return_exceptions=True)
        wf._background_finished["toolu_pc"]["status"] = "paused"
        await wf.receive_agent_message(
            {
                "message_id": "m-peer",
                "from_agent_path": "/root/peer",
                "wake_task_id": "toolu_pc.run2",
                "message": "Continue please.",
                "continue_conversation": True,
            }
        )
        for _ in range(200):
            if len(runs) == 7:
                break
            await asyncio.sleep(0.002)
        assert runs[-1][1]["goal"] == "Continue please.", "code continue: the message is the next CLI turn"
        assert "_fresh_conversation" not in runs[-1][1]
        gates["toolu_pc"].set()
        await asyncio.gather(*wf._background_handles.values(), return_exceptions=True)


async def test_send_to_finished_explore_task_wakes_its_next_run():
    """A message to a finished own explore task starts its next run at the same path (user decision 2026-10-20)."""
    from domains.agent_messaging.handler import send_message_to_agent
    from helpers.agent_addressing import background_tree_entries
    from helpers.background_agents import CHILD_WORKFLOW_AGENT_TYPES

    harness = _Harness()
    with _env(harness):
        wf = _workflow(harness)
        bg_gate, fg_gate, calls = asyncio.Event(), asyncio.Event(), []
        executor = _fake_executor(wf, bg_gate=bg_gate, fg_gate=fg_gate, calls=calls)
        goals = []

        async def _recording_executor(tool_name, tool_args, tool_call_id):
            goals.append(tool_args.get("goal"))
            return await executor(tool_name, tool_args, tool_call_id)

        wf._execute_tool = _recording_executor
        await wf._execute_tool_once("spawn_agent", dict(EXPLORE_ARGS), "toolu_a")
        bg_gate.set()
        await asyncio.gather(*wf._background_handles.values(), return_exceptions=True)
        assert wf._background_finished["toolu_a"]["status"] == "completed"
        assert len(harness.notifications()) == 1
        # The finished task stays listed (path resolvable by list_agents / grep / send).
        entries = background_tree_entries(wf._background_tasks, CHILD_WORKFLOW_AGENT_TYPES, wf._background_finished)
        assert [(e["address"], e["path"], e["status"]) for e in entries] == [("toolu_a", "/root/tokyo", "completed")]

        bg_gate.clear()
        harness.activity_results["send_agent_message_activity"] = {"message_id": "m-1", "delivered": False}
        status, text = await send_message_to_agent(
            wf, {"to": "/root/tokyo", "message": "Also give the 2020 census figure."}, "toolu_s"
        )
        assert status.value == "FINISHED" and "had finished; this message started its next run" in text, text
        sends = [a for a in harness.activities if a[0] == "send_agent_message_activity"]
        assert sends[-1][1][0] == "agent-mid" and sends[-1][1][4] == "toolu_a", "stored on the finished run's inbox"
        assert harness.tool_rows("toolu_s")[-1]["metadata"]["woke"] is True
        record = wf._background_tasks["toolu_a"]
        assert (record["status"], record["run"], record["inbox_address"]) == ("running", 2, "toolu_a.run2"), record
        assert (record["path"], record["task_name"]) == ("/root/tokyo", "tokyo")
        for _ in range(200):
            if len(goals) == 2:
                break
            await asyncio.sleep(0.002)
        assert goals[1].startswith("Also give the 2020 census figure.\n\n"), goals
        assert EXPLORE_ARGS["goal"] in goals[1] and "Its result (completed):\ndone" in goals[1], goals[1]
        assert wf._background_inbox_address("toolu_a") == "toolu_a.run2"
        run_rows = [r for r in harness.tool_rows("toolu_a") if r["metadata"].get("backgroundRun") == 2]
        assert run_rows and all(r["metadata"]["excludeFromModel"] is True for r in run_rows), harness.tool_rows(
            "toolu_a"
        )
        entries = background_tree_entries(wf._background_tasks, CHILD_WORKFLOW_AGENT_TYPES, wf._background_finished)
        assert [(e["address"], e["status"]) for e in entries] == [("toolu_a.run2", "running")]

        # The same message again (Temporal retry / duplicate signal) never starts another run.
        again = await wf._wake_background_task("toolu_a", "x", message_id="m-1", sender="/root")
        assert again["woke"] is True and len(goals) == 2

        bg_gate.set()
        await asyncio.gather(*wf._background_handles.values(), return_exceptions=True)
        notes = harness.notifications()
        assert len(notes) == 2 and notes[1]["metadata"]["backgroundRun"] == 2, notes
        assert notes[0]["metadata"]["idempotencyKey"] != notes[1]["metadata"]["idempotencyKey"]
        assert wf._background_finished["toolu_a"]["run"] == 2
        assert await wf._wake_background_task("toolu_a", "x", message_id="m-1", sender=None) == {
            "woke": True,
            "already_running": True,
        }, "a finished run remembers the message that woke it"

        # Another agent's message to the finished task arrives as a signal; retries are deduped.
        bg_gate.clear()
        signal = {
            "message_id": "m-9",
            "from_agent_path": "/root/peer",
            "wake_task_id": "toolu_a.run2",
            "message": "And Osaka.",
        }
        await wf.receive_agent_message(signal)
        await wf.receive_agent_message(signal)
        assert wf._background_tasks["toolu_a"]["run"] == 3
        for _ in range(200):
            if len(goals) == 3:
                break
            await asyncio.sleep(0.002)
        assert len(goals) == 3 and goals[2].startswith("And Osaka."), goals
        assert not [e for e in wf._wait_wake_events if e["kind"] == "agent_message"], "the owner's loop is not woken"
        bg_gate.set()
        await asyncio.gather(*wf._background_handles.values(), return_exceptions=True)

        # A paused owner (also killed / cost limit) does not start another run; the sender is told why.
        wf.is_paused = True
        harness.activity_results["send_agent_message_activity"] = {"message_id": "m-2", "delivered": False}
        status, text = await send_message_to_agent(wf, {"to": "/root/tokyo", "message": "more"}, "toolu_s3")
        assert status.value == "FINISHED" and "was not woken (its owner agent is paused)" in text, text
        assert "toolu_a" not in wf._background_tasks and len(goals) == 3
        wf.is_paused = False
        wf._cost_limit_reached = True
        assert (await wf._wake_background_task("toolu_a", "m", message_id="m-3", sender=None))["woke"] is False
        wf._cost_limit_reached = False
        wf._kill_request = {"by_agent_id": "agent-root"}
        assert (await wf._wake_background_task("toolu_a", "m", message_id="m-4", sender=None))["woke"] is False
        wf._kill_request = None

        # Guard refusal (rate / unread cap): nothing is stored, nothing wakes.
        harness.activity_results["send_agent_message_activity"] = {"error": "Message rate limit: wait a moment"}
        status, text = await send_message_to_agent(wf, {"to": "/root/tokyo", "message": "more"}, "toolu_s4")
        assert status.value == "ERROR" and "rate limit" in text and "toolu_a" not in wf._background_tasks, text

        # A wake signal refused because the owner is paused is not remembered:
        # the same message (same id), retried after the owner resumes, starts the run.
        retried = {
            "message_id": "m-7",
            "from_agent_path": "/root/peer",
            "wake_task_id": "/root/tokyo",
            "message": "And Kyoto.",
        }
        bg_gate.set()
        wf.is_paused = True
        await wf.receive_agent_message(retried)
        assert "toolu_a" not in wf._background_tasks and len(goals) == 3, "a paused owner must not wake the task"
        assert "m-7" not in wf._seen_agent_message_ids, "a refused wake must not consume its message id"
        wf.is_paused = False
        await wf.receive_agent_message(retried)
        assert wf._background_tasks["toolu_a"]["run"] == 4, "the retry after resume wakes the task"
        for _ in range(200):
            if len(goals) == 4:
                break
            await asyncio.sleep(0.002)
        assert len(goals) == 4 and goals[3].startswith("And Kyoto."), goals
        await asyncio.gather(*wf._background_handles.values(), return_exceptions=True)


def test_prompts_schemas_and_registration():
    import worker
    from domains.send_message_to_user.config import SUB_AGENT_AUTO_RESPONSE
    from tools.prompts import TOOL_PROMPTS
    from utils.prompts import WORKING_WITH_OTHER_AGENTS_PROMPT, build_system_prompt
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS, TOOL_MODELS
    from workflows.agent_workflow import TOOL_EXECUTORS

    for name in ("send_message_to_agent", "kill_agent"):
        assert name in EXECUTE_PHASE_TOOLS and name in TOOL_MODELS and name in TOOL_EXECUTORS and name in TOOL_PROMPTS
    for removed in ("interrupt_agent", "stop_agent", "get_agent"):
        assert removed not in EXECUTE_PHASE_TOOLS and removed not in TOOL_MODELS and removed not in TOOL_EXECUTORS
        assert removed not in TOOL_PROMPTS and removed not in WORKING_WITH_OTHER_AGENTS_PROMPT
        assert all(removed not in prompt for prompt in TOOL_PROMPTS.values()), removed
    # list_agents is an explore-only tool: root / execute agents look through an explore agent.
    assert "list_agents" in TOOL_MODELS and "list_agents" in TOOL_PROMPTS
    assert "list_agents" not in EXECUTE_PHASE_TOOLS and "list_agents" not in TOOL_EXECUTORS
    assert "INTERRUPT" not in WORKING_WITH_OTHER_AGENTS_PROMPT and "STOPPED" not in WORKING_WITH_OTHER_AGENTS_PROMPT
    source = open(worker.__file__).read()
    assert source.count("kill_agent_activity") >= 2, "kill_agent_activity must be registered on the worker"
    for gone in ("interrupt_agent_activity", "stop_agent_activity", "get_agent_summary_activity"):
        assert gone not in source, gone
    prompt = build_system_prompt("EXECUTE", [])
    assert WORKING_WITH_OTHER_AGENTS_PROMPT.strip() in prompt
    static = prompt.split("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__")[0]
    assert "# Working with other agents" in static, "the shared section sits in the cached static prefix"
    for phrase in (
        "FINAL_ANSWER",
        "Message Type:",
        'wait_for(agents=["parent"])',
        "kill_agent",
        "FAILED",
        "environment block",
        "spawn an explore agent",
        'trace_path="/root/...',
    ):
        assert phrase in WORKING_WITH_OTHER_AGENTS_PROMPT, phrase
    assert "end your turn" not in WORKING_WITH_OTHER_AGENTS_PROMPT.lower()
    assert (
        'send_message_to_agent(to="parent"' in SUB_AGENT_AUTO_RESPONSE
        and 'wait_for(agents=["parent"])' in SUB_AGENT_AUTO_RESPONSE
    )


async def test_control_tools_decode_results_in_real_sandbox():
    """send_message_to_agent / kill_agent through a real worker + production sandbox."""
    from temporalio import activity
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from agent_messaging_sandbox_workflow import AgentMessagingSandboxProbe
    from helpers.workflow_sandbox import production_workflow_runner

    @activity.defn(name="send_agent_message_activity")
    async def fake_send(*_args):
        return {"delivered": True, "message_id": "msg-1", "to": {"agent_id": "agent-root", "path": "/root"}}

    @activity.defn(name="kill_agent_activity")
    async def fake_kill(*_args):
        return {
            "killed": True,
            "status": "KILLING",
            "message": "Kill requested for /root/x.",
            "to": {"path": "/root/x"},
        }

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue="agent-control-sandbox",
            workflows=[AgentMessagingSandboxProbe],
            activities=[fake_send, fake_kill],
            workflow_runner=production_workflow_runner(),
        ):
            results = await asyncio.wait_for(
                env.client.execute_workflow(
                    AgentMessagingSandboxProbe.run,
                    args=[
                        "agent-kid",
                        "agent-root",
                        [
                            {"tool": "send_message_to_agent", "to": "parent", "message": "Need the budget."},
                            {"tool": "kill_agent", "to": "/root/x"},
                        ],
                    ],
                    id="agent-control-sandbox-probe",
                    task_queue="agent-control-sandbox",
                ),
                timeout=60,
            )
    assert [row["status"] for row in results] == ["FINISHED", "FINISHED"], results
    assert results[0]["text"] == "Message sent to parent.", results
    assert results[1]["text"] == "Kill requested for /root/x.", results


async def test_wait_for_parent_wakes_on_the_parents_message():
    """A sub-agent that asked its parent (send_message_to_agent + wait_for(agents=["parent"])) wakes on the reply."""
    from temporalio import workflow as temporal_workflow

    from domains.wait_for.handler import wait_for

    harness = _Harness()
    with _env(harness), patch.object(temporal_workflow, "now", lambda: _BASE):
        wf = _workflow(harness, depth=1, parent="agent-root")
        waiter = asyncio.create_task(
            wait_for(wf, {"description": "parent's answer", "agents": ["parent"], "timeout_seconds": 600}, "tc-w")
        )
        for _ in range(50):
            await asyncio.sleep(0.002)
        assert not waiter.done(), "nothing has arrived yet"
        await wf.receive_agent_message(
            {"message_id": "msg-9", "from_agent_id": "agent-sibling", "from_agent_path": "/root/sib"}
        )
        for _ in range(50):
            await asyncio.sleep(0.002)
        assert not waiter.done(), "another agent's message does not end a wait on the parent"
        await wf.receive_agent_message(
            {"message_id": "msg-10", "from_agent_id": "agent-root", "from_agent_path": "/root"}
        )
        await asyncio.wait_for(waiter, 2)


async def test_message_guard_refusals_reach_the_tool_result():
    """Backend 429s (Prime guard: rate / unread cap) come back as actionable tool errors, never raised."""
    from unittest.mock import AsyncMock, MagicMock, patch

    from domains.agent_messaging import repo
    from domains.agent_messaging.handler import send_message_to_agent

    rate = "Message rate limit: wait a moment before messaging /root/kid again."
    unread = "/root/kid has 20 unread messages; wait for it to catch up before messaging it again."
    response = MagicMock(status_code=429)
    response.json.return_value = {"error": rate}
    client = MagicMock(post=AsyncMock(return_value=response))
    with patch.object(repo, "get_http_client", return_value=client), patch.object(repo, "_headers", return_value={}):
        result = await repo.post_agent_message_to_address("agent-mid", {"to": "/root/kid"}, "user-1")
        assert result == {"delivered": False, "error": rate, "status": 429}, result
        response.json.return_value = {"error": unread}
        result = await repo.post_agent_message_to_address("agent-mid", {"to": "/root/kid"}, "user-1")
        assert result["error"] == unread and result["status"] == 429, result

    harness = _Harness()
    with _env(harness):
        wf = _workflow(harness)
        harness.activity_results["send_agent_message_to_address_activity"] = {
            "delivered": False,
            "error": rate,
            "status": 429,
        }
        status, text = await send_message_to_agent(
            wf, {"to": "/root/kid", "message": "Also check parking."}, "toolu_rl"
        )
        assert status.value == "ERROR" and text == f"Message delivery failed: {rate}", text
        harness.activity_results["send_agent_message_to_address_activity"] = {
            "delivered": False,
            "error": unread,
            "status": 429,
        }
        status, text = await send_message_to_agent(wf, {"to": "/root/kid", "message": "Stop."}, "toolu_ru")
        assert status.value == "ERROR" and text == f"Message delivery failed: {unread}", text


async def test_root_pause_ends_background_browser_paused_with_its_session_id():
    """Item 12 (Andy 2026-10-26): pausing the root pauses its running browser agent.

    Prod root 447576b9: the pause cancelled /root/order_breakfast_dd, its
    Kernel session was paused (not torn down), but the owner was told
    "User paused the browser agent" with no session id. The real pause signal
    stops the running browser task; its manager emits the real pause terminal
    row; the run ends "paused" and the notification (text + metadata) carries
    the paused provider session id for continuation.
    """
    from domains.spawn_browser_agent_v3.handler import browser_pause_terminal_event
    from helpers.agent_addressing import background_tree_entries
    from helpers.background_agents import CHILD_WORKFLOW_AGENT_TYPES
    from helpers.tool_interrupts import tool_stop_requested

    harness = _Harness()
    with _env(harness):
        wf = _workflow(harness, agent_id="agent-root")
        running, stopped = [], []

        async def _browser_manager(tool_name, tool_args, tool_call_id):
            running.append(tool_call_id)
            # The manager's wait: browser activity done, or a pause/kill stop request.
            while not tool_stop_requested(wf, tool_call_id):
                await asyncio.sleep(0.002)
            stopped.append(tool_call_id)
            # What the cancelled activity returns after pausing its provider session.
            cancelled = {"status": "cancelled", "task_id": "task-br", "session_id": "kernel-sess-1"}
            await wf._handle_tool_event(browser_pause_terminal_event(cancelled, "task-br"), tool_call_id, tool_name)
            return {"message": "User paused the browser agent"}

        wf._execute_tool = _browser_manager
        await wf._execute_tool_once("spawn_agent", {**BROWSER_ARGS, "task_name": "order_breakfast_dd"}, "toolu_br")
        assert "toolu_br" in wf._background_handles, "the browser task runs in the background"
        for _ in range(200):
            if running:
                break
            await asyncio.sleep(0.002)
        assert running == ["toolu_br"], "the browser agent is acting when the root is paused"

        await wf.pause()
        await asyncio.wait_for(asyncio.gather(*wf._background_handles.values()), 5)

        assert stopped == ["toolu_br"], "the root pause must stop the running browser agent"
        assert wf._background_finished["toolu_br"]["status"] == "paused", wf._background_finished
        entries = background_tree_entries(wf._background_tasks, CHILD_WORKFLOW_AGENT_TYPES, wf._background_finished)
        assert {e["path"]: e["status"] for e in entries}["/root/order_breakfast_dd"] == "paused", entries
        terminal = [r for r in harness.tool_rows("toolu_br") if r["metadata"].get("action_type") == "task_complete"]
        assert len(terminal) == 1 and terminal[0]["metadata"]["session_id"] == "kernel-sess-1", terminal
        notes = harness.notifications()
        assert len(notes) == 1, harness.rows
        meta = notes[0]["metadata"]
        assert meta["status"] == "paused" and meta["sessionId"] == "kernel-sess-1", meta
        assert "User paused the browser agent" in notes[0]["text"], notes[0]["text"]
        assert "Session ID: kernel-sess-1" in notes[0]["text"], notes[0]["text"]
        assert wf._wait_wake_events[-1]["status"] == "paused", wf._wait_wake_events

        # A pause handled before the launched task's first step still ends that run "paused".
        await wf.resume()
        await wf._execute_tool_once("spawn_agent", {**BROWSER_ARGS, "task_name": "order_breakfast_ic"}, "toolu_br2")
        await wf.pause()
        await asyncio.wait_for(asyncio.gather(*wf._background_handles.values()), 5)
        assert stopped == ["toolu_br", "toolu_br2"], stopped
        assert wf._background_finished["toolu_br2"]["status"] == "paused", wf._background_finished["toolu_br2"]
        assert harness.notifications()[-1]["metadata"]["status"] == "paused", harness.notifications()


async def run_all_tests():
    print("agent_control blackbox tests:")
    r = BlackboxResult()
    await r.record_async("kill_cancels_tool_skips_undecided", test_kill_cancels_inflight_tool_and_skips_undecided_calls)
    r.record("tool_stop_requested_scope", test_tool_stop_requested_marks_only_interrupted_llm_turn_calls)
    await r.record_async(
        "kill_fails_with_killed_by_reason", test_kill_fails_through_the_normal_failure_path_with_killed_by_reason
    )
    await r.record_async("kill_own_task_and_task_kill_signal", test_kill_own_background_task_and_kill_signal_for_task)
    await r.record_async(
        "kill_own_task_reason_survives_absorbed_cancel",
        test_kill_own_activity_task_keeps_kill_reason_when_executor_absorbs_cancel,
    )
    await r.record_async("rewoken_child_appends_notification", test_rewoken_child_completion_appends_a_new_notification)
    await r.record_async(
        "carried_child_killed_notifies_failed", test_carried_child_killed_by_other_agent_notifies_failed
    )
    await r.record_async("handlers_send_metadata", test_handlers_send_and_metadata)
    await r.record_async(
        "send_browser_code_lifecycle_completed_refused_paused_resumes",
        test_send_to_browser_and_code_tasks_follows_their_lifecycle,
    )
    await r.record_async(
        "root_pause_ends_background_browser_paused_with_session_id",
        test_root_pause_ends_background_browser_paused_with_its_session_id,
    )
    await r.record_async("send_wakes_finished_explore_task", test_send_to_finished_explore_task_wakes_its_next_run)
    await r.record_async("message_guard_refusals_reach_tool_result", test_message_guard_refusals_reach_the_tool_result)
    r.record("prompts_schemas_registration", test_prompts_schemas_and_registration)
    await r.record_async("wait_for_parent_wakes_on_parent_message", test_wait_for_parent_wakes_on_the_parents_message)
    await r.record_async("control_tools_decode_in_real_sandbox", test_control_tools_decode_results_in_real_sandbox)
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
