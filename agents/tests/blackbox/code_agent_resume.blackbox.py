"""Blackbox tests: CodeAgentResumeWorkflow and the person's resume through spawn_agent.

The real workflow runs on a time-skipping Temporal test server with the
production sandbox; only its activities (the code-spawn activity, the message
post, the queue pointer) are faked, so the lifecycle asserted is the workflow's
and the real code-spawn handler's:

  - pause: the owner's pause signal stops the run through the spawn's own pause
    path (the activity is cancelled, the "Code session paused" row is posted)
  - generation handoff: a deploy that drains the code activity continues the run
    on the live queue, which reattaches the drained session
  - failures: a bad request or a fenced write posts a UI-only "could not resume"
    row and fails non-retryably (never an endless workflow-task retry)
  - the owner-wake path: spawn_agent forwards the person's files, CLI and
    settings to the code-spawn handler (the real SpawnAgentManager)
"""

import asyncio
import uuid
from datetime import timedelta
from unittest.mock import patch

from _test_utils import BlackboxResult
from temporalio import workflow

POINTER = {"id": "f-1", "storage_path": "u/notes.txt", "original_filename": "notes.txt"}


@workflow.defn(name="OwnerProbe")
class OwnerProbe:
    """A stand-in owner workflow: records child_cost_update by key (AgentWorkflow's semantics)."""

    def __init__(self) -> None:
        self.costs = {}
        self.done = False

    @workflow.signal
    async def child_cost_update(self, data: dict) -> None:
        self.costs[data["child_agent_id"]] = data["subtree_cost_cents"]

    @workflow.signal
    async def finish(self) -> None:
        self.done = True

    @workflow.run
    async def run(self) -> dict:
        await workflow.wait_condition(lambda: self.done)
        return self.costs


BILLED = []
LIMIT_REACHED = [False]


def _request(**extra):
    return {
        "agent_id": "owner-1",
        "user_id": "user-1",
        "model": "rose-labs/rose-1-ultra",
        "tool_call_id": "toolu_code_spawn",
        "task_name": "remove_rose_card_border",
        "code_session_id": "6f8f8f4d-c670-4bc8-b5df-e2c785c4a908",
        "code_provider": "claude",
        "message": "Also update the changelog.",
        "message_id": "m-row",
        "attachments": [],
        **extra,
    }


async def _run(activities, request, *, queues=("code-agent-resume",), signal_pause_after=None):
    """Run CodeAgentResumeWorkflow with workers on `queues`; return (result | exception)."""
    from temporalio.client import WorkflowFailureError
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from helpers.workflow_sandbox import production_workflow_runner
    from workflows.code_agent_resume import CodeAgentResumeWorkflow

    async with await WorkflowEnvironment.start_time_skipping() as env:
        workers = [
            Worker(
                env.client,
                task_queue=queue,
                workflows=[CodeAgentResumeWorkflow],
                activities=activities,
                workflow_runner=production_workflow_runner(),
                # Cancellation reaches activities in heartbeat responses: flush like worker.py.
                max_heartbeat_throttle_interval=timedelta(seconds=1),
                default_heartbeat_throttle_interval=timedelta(seconds=1),
            )
            for queue in queues
        ]
        for worker in workers:
            await worker.__aenter__()
        try:
            handle = await env.client.start_workflow(
                CodeAgentResumeWorkflow.run,
                request,
                id=f"code-resume:owner-1:{uuid.uuid4()}",
                task_queue=queues[0],
            )
            if signal_pause_after is not None:
                await asyncio.wait_for(signal_pause_after.wait(), timeout=30)
                await handle.signal(CodeAgentResumeWorkflow.pause)
            try:
                return await asyncio.wait_for(handle.result(), timeout=60)
            except WorkflowFailureError as failure:
                return failure
        finally:
            for worker in reversed(workers):
                await worker.__aexit__(None, None, None)


def _fakes(spawn_impl, posted, pointer_queue=None):
    from temporalio import activity

    @activity.defn(name="resolve_code_agent_provider_activity")
    async def fake_provider(default_provider):
        return default_provider

    @activity.defn(name="spawn_claude_code_activity")
    async def fake_spawn(*args):
        return await spawn_impl(*args)

    @activity.defn(name="post_agent_message")
    async def fake_post(*args):
        posted.append(args)
        return {"id": f"row-{len(posted)}"}

    @activity.defn(name="fetch_agent_queue_pointer")
    async def fake_pointer():
        return {"task_queue": pointer_queue} if pointer_queue else {}

    @activity.defn(name="close_detached_code_session_activity")
    async def fake_close(*args):
        return None

    @activity.defn(name="save_tool_usage")
    async def fake_usage(*args):
        BILLED.append(("usage", args))

    @activity.defn(name="apply_resume_cost_activity")
    async def fake_resume_cost(owner_id, key, total):
        BILLED.append(("total", (owner_id, key, total)))
        return {"limit_reached": LIMIT_REACHED[0]}

    return [fake_provider, fake_spawn, fake_post, fake_pointer, fake_close, fake_usage, fake_resume_cost]


async def test_pause_signal_stops_a_supervised_run_through_the_spawn_pause_path():
    """The owner's pause (backend pauseAgent → signal pause) cancels the code activity."""
    from temporalio import activity

    started = asyncio.Event()
    cancelled = []

    async def spawn(*args):
        started.set()
        try:
            while True:
                activity.heartbeat()
                await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            cancelled.append(args[3])
            return {"status": "cancelled", "task_id": "task-new", "code_provider": "claude", "message": "paused"}

    posted = []
    result = await _run(_fakes(spawn, posted), _request(), signal_pause_after=started)
    assert not isinstance(result, Exception), result
    assert cancelled == ["toolu_code_spawn"], "the pause cancelled the code activity"
    tool_rows = [row for row in posted if row[2] == "TOOL"]
    paused = [row for row in tool_rows if row[3].get("title") == "Code session paused"]
    assert paused, [row[3].get("title") for row in tool_rows]
    assert paused[-1][3]["excludeFromModel"] is True and paused[-1][3]["toolCallId"] == "toolu_code_spawn"


async def test_generation_handoff_continues_on_the_live_queue_and_reattaches():
    """A deploy drains the code activity: the run moves to the live queue, which reattaches."""
    from temporalio import activity

    from domains.spawn_claude_code_agent.config import CODE_AGENT_DRAIN_YIELD_STATUS

    calls = []

    async def spawn(*args):
        calls.append((activity.info().task_queue, args[15]))
        if args[15] is None:
            return {
                "status": CODE_AGENT_DRAIN_YIELD_STATUS,
                "code_session": {"task_id": "task-new", "ws_url": "ws://sandbox", "code_provider": "claude"},
            }
        return {"success": True, "message": "Changelog updated.", "task_id": "task-new", "code_provider": "claude"}

    posted = []
    result = await _run(_fakes(spawn, posted, pointer_queue="q-live"), _request(), queues=("q-old", "q-live"))
    assert not isinstance(result, Exception), result
    assert [queue for queue, _ in calls] == ["q-old", "q-live"], calls
    assert calls[1][1]["task_id"] == "task-new", "the live generation reattached the drained session"
    assert any(row[3].get("action_type") == "task_complete" and row[3].get("success") for row in posted)


async def test_failures_post_could_not_resume_and_fail_non_retryably():
    """A bad request, or a write the backend fences, never retries forever."""
    from temporalio.exceptions import ApplicationError

    async def never(*args):
        raise AssertionError("no spawn for a bad request")

    posted = []
    bad = await _run(_fakes(never, posted), _request(message=""))
    assert isinstance(bad, Exception), bad
    assert isinstance(bad.cause, ApplicationError) and bad.cause.non_retryable, repr(bad.cause)
    failure = [row for row in posted if row[3].get("codeAgentResume") == "failed"]
    assert failure and failure[-1][3]["toolStatus"] == "ERROR", posted
    assert "missing message" in failure[-1][1]

    from temporalio import activity

    async def spawn(*args):
        return {"success": True, "message": "done", "task_id": "task-new", "code_provider": "claude"}

    fenced_posts = []
    fakes = _fakes(spawn, fenced_posts)

    @activity.defn(name="post_agent_message")
    async def fenced_post(*args):
        fenced_posts.append(args)
        raise ApplicationError("Workflow generation is no longer current", non_retryable=True)

    fakes[2] = fenced_post
    sealed = await _run(fakes, _request())
    assert isinstance(sealed, Exception), sealed
    assert isinstance(sealed.cause, ApplicationError) and sealed.cause.non_retryable, repr(sealed.cause)


async def test_a_pause_carried_across_continue_as_new_holds_on_the_live_queue():
    """A run started with paused=True (its pause arrived before a handoff) stops at once."""
    from temporalio import activity

    cancelled = []

    async def spawn(*args):
        try:
            while True:
                activity.heartbeat()
                await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            cancelled.append(args[3])
            return {"status": "cancelled", "task_id": "task-new", "code_provider": "claude", "message": "paused"}

    posted = []
    result = await _run(_fakes(spawn, posted), _request(paused=True))
    assert not isinstance(result, Exception), result
    assert cancelled == ["toolu_code_spawn"] or not any(row[2] == "TOOL" and row[3].get("success") for row in posted)
    assert any(row[3].get("title") == "Code session paused" for row in posted if row[2] == "TOOL"), posted


async def test_usage_bills_the_owner_and_its_limit_stops_the_run():
    """The run reports its ABSOLUTE total under resume:<id>; the root limit stops it.

    ToolUsage rows carry the run's usage (no owner checkpoint); the backend keeps the
    monotonic total and adds only its growth to the tree (never an overwrite).
    """
    from temporalio import activity

    BILLED.clear()
    LIMIT_REACHED[0] = False

    async def spawn(*args):
        return {
            "success": True,
            "message": "done",
            "task_id": "task-new",
            "code_provider": "claude",
            "usage_items": [{"type": "service", "cost_cents": 7, "provider": "E2B"}],
        }

    posted = []
    result = await _run(_fakes(spawn, posted), _request())
    assert not isinstance(result, Exception), result
    usage = [args for kind, args in BILLED if kind == "usage"]
    totals = [args for kind, args in BILLED if kind == "total"]
    assert usage and usage[-1][0] == "owner-1" and usage[-1][3][0]["cost_cents"] == 7, usage
    assert len(usage[-1]) < 5 or usage[-1][4] is None, "no owner checkpoint from a resume run"
    assert [args[2] for args in totals] == sorted(args[2] for args in totals), "totals never go down"
    assert totals[-1][2] == 7.0 and totals[-1][0] == "owner-1", totals
    assert totals[-1][1].startswith("resume:code-resume:owner-1:"), totals[-1][1]

    BILLED.clear()
    LIMIT_REACHED[0] = True
    started = []

    async def blocked(*args):
        started.append(args[3])
        return {"success": True, "message": "spent anyway", "task_id": "t", "code_provider": "claude"}

    try:
        result = await _run(_fakes(blocked, posted), _request())
    finally:
        LIMIT_REACHED[0] = False
    assert not isinstance(result, Exception), result
    assert started == [], "the owner's root is at its limit: nothing runs"


async def test_owner_wake_forwards_the_persons_files_cli_and_settings_through_spawn_agent():
    """The woken run's spawn args reach the code handler through the real SpawnAgentManager."""
    from types import SimpleNamespace

    from domains.spawn_agent.handler import get_manager

    seen = []

    class _CodeManager:
        async def execute_tool(self, workflow_instance, tool_call, tool_call_id):
            seen.append(dict(tool_call))
            if False:
                yield None

    woken_args = {
        "type": "code",
        "task_name": "coder",
        "goal": "Also update the changelog.",
        "_user_attachments": [POINTER],
        "_resume_code_provider": "codex",
        "_resume_cli_settings": {"model": "gpt-6.1-sol", "speed": "priority"},
    }
    instance = SimpleNamespace(agent_id="owner-1", user_id="user-1", current_phase="EXECUTE", world_model_mode="real")
    with patch("domains.spawn_agent.handler.get_code_manager", lambda: _CodeManager()):
        async for _event in get_manager()._spawn_code(instance, woken_args, "toolu_c"):
            pass
    assert len(seen) == 1, seen
    forwarded = seen[0]
    assert forwarded["_user_attachments"] == [POINTER]
    assert forwarded["_resume_code_provider"] == "codex"
    assert forwarded["_resume_cli_settings"] == {"model": "gpt-6.1-sol", "speed": "priority"}
    assert forwarded["goal"] == "Also update the changelog."


async def test_worker_records_the_workflow_types_its_queue_serves():
    """At start a worker PUTs its queue's types (incl. both resume runs), retrying until recorded."""
    from helpers import worker_queue_capabilities as capabilities
    from workflows.agent_workflow import COMPANION_WORKFLOWS, AgentWorkflow

    calls = []
    slept = []

    class FakeResponse:
        def __init__(self, ok):
            self.ok = ok

        def raise_for_status(self):
            if not self.ok:
                raise RuntimeError("404: the backend does not serve the route yet")

    class FakeClient:
        async def put(self, url, json=None, headers=None, timeout=None):
            calls.append((url, json))
            return FakeResponse(len(calls) > 7)  # the new backend lands after 7 attempts

    async def no_sleep(seconds):
        slept.append(seconds)

    with (
        patch.object(capabilities, "get_http_client", lambda: FakeClient()),
        patch.object(capabilities, "_sleep", no_sleep),
    ):
        recorded = await capabilities.record_worker_queue_capabilities(
            "navi-agent-tasks@abc123", [AgentWorkflow, *COMPANION_WORKFLOWS]
        )
    assert recorded is True
    assert len(calls) == 8 and calls[-1][0].endswith("/api/agent-queue-pointer/capabilities"), calls
    assert slept == [2.0, 5.0, 15.0, 30.0, 60.0, 60.0, 60.0], "capped backoff, past the old 4-attempt limit"
    assert calls[-1][1] == {
        "task_queue": "navi-agent-tasks@abc123",
        "workflow_types": ["AgentWorkflow", "BrowserAgentResumeWorkflow", "CodeAgentResumeWorkflow"],
    }, calls[-1][1]


def _root_for_cap(subtree: float, limit: int):
    """A root AgentWorkflow's cost state with its REAL cost-limit methods bound."""
    from types import MethodType, SimpleNamespace

    from workflows.agent_workflow import AgentWorkflow

    root = SimpleNamespace(
        agent_id="root-1",
        user_id="user-1",
        agent_source="WEB",
        world_model_mode="real",
        parent_workflow_id=None,
        _is_finished=False,
        _cost_limit_reached=False,
        is_paused=False,
        subtree_cost_cents=subtree,
        own_cost_cents=subtree,
        children_cost_cents={},
        _persisted_tree_cents=0.0,
        price_limit_cents=limit,
        token_count=0,
        context_size=0,
        message_count=0,
        tokens_in=0,
        tokens_out=0,
        iteration_offset=0,
    )
    root._get_pending_child_workflow_ids = lambda: []
    for name in ("_check_cost_limit", "_persist_tree_cost", "_resume_spend_note"):
        setattr(root, name, MethodType(getattr(AgentWorkflow, name), root))
    return root


async def test_a_root_whose_stored_tree_reached_its_cap_stops():
    """The REAL _check_cost_limit: a running root learns resume spend (never in any workflow's
    memory) from its write's stored tree and stops at max(in-memory, stored) >= its limit."""
    import logging
    from types import SimpleNamespace

    from helpers.update_tokens import update_agent_tree_cost_activity
    from workflows import agent_workflow

    statuses = []

    def api_returning(stored):
        async def execute_activity(fn, args=None, **_kwargs):
            if fn is update_agent_tree_cost_activity:
                return stored
            statuses.append(list(args or []))
            return None

        return SimpleNamespace(execute_activity=execute_activity, logger=logging.getLogger("root-cap"))

    root = _root_for_cap(subtree=30.0, limit=50)
    with patch.object(agent_workflow, "workflow", api_returning(55)):
        await root._persist_tree_cost()
    assert root._persisted_tree_cents == 55.0
    assert root._cost_limit_reached is True and root.is_paused is True, "stopped at the stored tree"
    assert statuses and statuses[0][1] == "COST_LIMIT_REACHED", statuses
    assert "+ resumed agents 25.0c" in statuses[0][3], statuses[0][3]

    statuses.clear()
    root = _root_for_cap(subtree=30.0, limit=50)
    with patch.object(agent_workflow, "workflow", api_returning(40)):
        await root._persist_tree_cost()
    assert root._persisted_tree_cents == 40.0 and root._cost_limit_reached is False and statuses == []

    # An old history's activity result (None) is tolerated: the in-memory total decides.
    root = _root_for_cap(subtree=30.0, limit=50)
    with patch.object(agent_workflow, "workflow", api_returning(None)):
        await root._persist_tree_cost()
    assert root._persisted_tree_cents == 0.0 and root._cost_limit_reached is False

async def run_all_tests():
    print("code_agent_resume blackbox tests:")
    r = BlackboxResult()
    await r.record_async(
        "pause_stops_supervised_run", test_pause_signal_stops_a_supervised_run_through_the_spawn_pause_path
    )
    await r.record_async(
        "generation_handoff_reattaches", test_generation_handoff_continues_on_the_live_queue_and_reattaches
    )
    await r.record_async(
        "failures_post_and_fail_non_retryably", test_failures_post_could_not_resume_and_fail_non_retryably
    )
    await r.record_async(
        "pause_carried_across_continue_as_new", test_a_pause_carried_across_continue_as_new_holds_on_the_live_queue
    )
    await r.record_async("usage_bills_owner_limit_stops", test_usage_bills_the_owner_and_its_limit_stops_the_run)
    await r.record_async("root_stops_at_stored_tree_cap", test_a_root_whose_stored_tree_reached_its_cap_stops)
    await r.record_async(
        "worker_records_queue_workflow_types", test_worker_records_the_workflow_types_its_queue_serves
    )
    await r.record_async(
        "owner_wake_forwards_files_cli_settings",
        test_owner_wake_forwards_the_persons_files_cli_and_settings_through_spawn_agent,
    )
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
