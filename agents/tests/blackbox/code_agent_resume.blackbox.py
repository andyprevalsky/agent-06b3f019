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
import copy
import uuid
from datetime import timedelta
from unittest.mock import AsyncMock, patch

from _test_utils import BlackboxResult
from temporalio import workflow

POINTER = {"id": "f-1", "storage_path": "u/notes.txt", "original_filename": "notes.txt"}
ORIGINAL_SPAWN_ARGS = {
    "type": "code",
    "goal": "Remove the rose border and return the evidence.",
    "output_schema": {"fields": [{"name": "evidence", "type": "string", "required": True}]},
    "github_repo_link": "https://github.com/example/original-project",
    "target": "cloud",
    "task_name": "remove_rose_card_border",
    "attachments": ["notes.txt"],
}
ORIGINAL_SETTINGS = {"model": "original-model", "reasoning_effort": "xhigh", "speed": "fast"}


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


async def _run(
    activities,
    request,
    *,
    queues=("code-agent-resume",),
    signal_pause_after=None,
    workflow_ids=None,
    run_ids=None,
):
    """Run CodeAgentResumeWorkflow with workers on `queues`; return (result | exception).

    ``workflow_ids`` runs one execution per id in order (the same id may repeat, like a
    resend after a failed run) and returns the last result; ``run_ids`` collects each
    execution's first_execution_run_id.
    """
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
            result = None
            for workflow_id in workflow_ids or [f"code-resume:owner-1:{uuid.uuid4()}"]:
                handle = await env.client.start_workflow(
                    CodeAgentResumeWorkflow.run, request, id=workflow_id, task_queue=queues[0]
                )
                if run_ids is not None:
                    run_ids.append(handle.first_execution_run_id)
                if signal_pause_after is not None:
                    await asyncio.wait_for(signal_pause_after.wait(), timeout=30)
                    await handle.signal(CodeAgentResumeWorkflow.pause)
                try:
                    result = await asyncio.wait_for(handle.result(), timeout=60)
                except WorkflowFailureError as failure:
                    result = failure
            return result
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

    @activity.defn(name="fetch_code_agent_resume_context")
    async def fake_resume_context(agent_id, tool_call_id):
        return copy.deepcopy({
            "version": 1,
            "spawn_args": ORIGINAL_SPAWN_ARGS,
            "attachments": [POINTER],
            "cli_settings": ORIGINAL_SETTINGS,
            "model": "rose-labs/rose-1-ultra",
            "fast_mode_cache_enabled": True,
        })

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

    return [fake_provider, fake_spawn, fake_post, fake_pointer, fake_close, fake_usage, fake_resume_cost, fake_resume_context]


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


async def test_user_turn_resumes_through_the_real_code_activity():
    """A queued user turn must reach session create, not just the supervisor's activity stub."""
    import json

    from temporalio.exceptions import ApplicationError

    from domains.spawn_claude_code_agent import service

    handoff = {"evidence": "Changelog checked.", "rose_handoff": {
        "status": "complete", "summary": "Changelog updated.",
        "branch": None, "commit": None, "pr_url": None, "merged": None,
    }}
    for provider in ("claude", "codex"):
        created = AsyncMock(return_value={
            "task_id": "resumed-task", "sandbox_id": "sandbox", "ws_url": "wss://test",
            "uploaded_files": [],
        })
        closed = AsyncMock(return_value={
            "output_files": [], "usage": {},
            "handoff": {"status": "present", "content": json.dumps(handoff)},
        })
        posted = []

        async def spawn(*args):
            try:
                return await service.spawn_claude_code_activity(*args)
            except ValueError as error:
                # Bound the pre-fix deterministic error: production otherwise retries forever.
                raise ApplicationError(str(error), non_retryable=True) from error

        with (
            patch.dict("os.environ", {"ROSE_ENABLE_CODE_AGENT_VERIFIER": ""}),
            patch.object(service, "create_e2b_session", created),
            patch.object(service, "close_e2b_session", closed),
            patch.object(service, "fetch_code_credential_availability", AsyncMock(return_value=None)),
            patch.object(service, "_resolve_claude_token_for_activity", AsyncMock(return_value=None)),
            patch.object(service, "SandboxLogCollector", lambda *a, **kw: AsyncMock()),
            patch.object(service, "_run_agentic_loop", AsyncMock(return_value=(0, True, [], 0, 0, []))),
            patch.object(service, "persist_terminal_output", AsyncMock()),
            patch.object(service, "save_claude_code_message", AsyncMock()),
            patch.object(service, "save_code_transcript_batch", AsyncMock()),
            patch("helpers.model_pricing.get_model_pricing_with_fallback", AsyncMock(return_value={
                "input_cents_per_1k": 0, "output_cents_per_1k": 0,
            })),
        ):
            result = await _run(_fakes(spawn, posted), _request(code_provider=provider))
        assert not isinstance(result, Exception), f"{provider}: {result}"
        created.assert_awaited_once()
        request = created.call_args.kwargs
        assert request["code_session_id"] == _request()["code_session_id"]
        assert request["code_provider"] == provider
        assert request["goal"].startswith(_request()["message"])
        schema = json.loads(request["goal"].split("Result JSON Schema for ", 1)[1].split(":\n", 1)[1])
        assert schema == service.handoff_json_schema(ORIGINAL_SPAWN_ARGS["output_schema"])
        assert request["github_repo_url"] == ORIGINAL_SPAWN_ARGS["github_repo_link"]
        assert request["target"] == ORIGINAL_SPAWN_ARGS["target"]
        assert request["cli_settings"] == ORIGINAL_SETTINGS
        assert request["attachments"][0]["id"] == POINTER["id"]
        assert request["fast_mode_cache_enabled"] is True
        assert any(row[3].get("action_type") == "task_complete" and row[3].get("success") for row in posted)


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


async def test_saved_resume_contract_and_legacy_declarations_are_recovered_without_defaults():
    from temporalio.exceptions import ApplicationError

    from helpers import code_agent_resume_context as recovery
    from workflows.code_agent_resume import resume_tool_call

    original = {**copy.deepcopy(ORIGINAL_SPAWN_ARGS), "tool": "spawn_agent", "tool_call_id": "toolu_code_spawn"}
    rows = [
        {"role": "USER", "file_pointer": POINTER},
        {"role": "ASSISTANT", "metadata": {"tool_calls": [original]}},
        {"role": "USER", "file_pointer": {**POINTER, "id": "later", "original_filename": "later.txt"}},
    ]
    with patch.object(recovery, "_fetch_agent_data_impl", AsyncMock(return_value={"messages": rows})):
        legacy = await recovery.fetch_code_agent_resume_context("owner-1", "toolu_code_spawn")
    assert legacy["spawn_args"] == original
    assert [item["id"] for item in legacy["attachments"]] == [POINTER["id"]]
    assert legacy["historical_settings_unrecorded"] is True
    try:
        resume_tool_call(_request(), legacy)
    except ValueError as error:
        assert "no complete saved CLI settings" in str(error)
    else:
        raise AssertionError("historical CLI settings must not be silently guessed")

    explicit = resume_tool_call(_request(cli_settings=ORIGINAL_SETTINGS), legacy)
    assert explicit["output_schema"] == original["output_schema"]
    assert explicit["target"] == original["target"]
    assert explicit["github_repo_link"] == original["github_repo_link"]

    saved = {"version": 1, "spawn_args": original, "attachments": [POINTER], "cli_settings": ORIGINAL_SETTINGS}
    rows += [
        {"role": "TOOL", "metadata": {"toolCallId": "another-spawn", "codeAgentResumeConfig": saved}},
        {"role": "TOOL", "metadata": {"toolCallId": "toolu_code_spawn", "codeAgentResumeConfig": saved}},
    ]
    before = copy.deepcopy(rows)
    with patch.object(recovery, "_fetch_agent_data_impl", AsyncMock(return_value={"messages": rows})):
        recovered = await recovery.fetch_code_agent_resume_context("owner-1", "toolu_code_spawn")
    updated = resume_tool_call(_request(cli_settings={"speed": "standard"}), recovered)
    assert updated["_resume_cli_settings"] == {**ORIGINAL_SETTINGS, "speed": "standard"}
    assert updated["_resume_attachments"] == [POINTER]
    updated["output_schema"]["fields"].append({"name": "new_field", "type": "string"})
    assert rows == before, "resuming must not mutate the saved contract"

    rows.append({"role": "TOOL", "metadata": {
        "toolCallId": "toolu_code_spawn", "action_type": "user_direct_turn", "code_provider": "claude",
        "effective_settings": {"model": "last-selected-model", "effort": "high", "speed": "standard"},
    }})
    with patch.object(recovery, "_fetch_agent_data_impl", AsyncMock(return_value={"messages": rows})):
        latest = await recovery.fetch_code_agent_resume_context("owner-1", "toolu_code_spawn")
    assert latest["cli_settings"] == {"model": "last-selected-model", "reasoning_effort": "high", "speed": "standard"}
    assert resume_tool_call(_request(), latest)["_resume_code_provider"] == "claude"
    legacy_with_receipt = rows[:3] + [rows[-1]]
    with patch.object(recovery, "_fetch_agent_data_impl", AsyncMock(return_value={"messages": legacy_with_receipt})):
        known_legacy = await recovery.fetch_code_agent_resume_context("owner-1", "toolu_code_spawn")
    assert known_legacy["historical_settings_unrecorded"] is False
    assert resume_tool_call(_request(), known_legacy)["_resume_cli_settings"] == latest["cli_settings"]

    for bad in ([], [{"role": "ASSISTANT", "metadata": {"tool_calls": [original, {**original, "target": "local"}]}}]):
        with patch.object(recovery, "_fetch_agent_data_impl", AsyncMock(return_value={"messages": bad})):
            try:
                await recovery.fetch_code_agent_resume_context("owner-1", "toolu_code_spawn")
            except ApplicationError as error:
                assert error.non_retryable is True
                assert error.type == "CODE_AGENT_RESUME_CONFIG_UNAVAILABLE"
            else:
                raise AssertionError("missing or conflicting original parameters must not select defaults")


async def test_missing_saved_settings_posts_an_actionable_error_without_spawning():
    calls = []

    async def never(*args):
        calls.append(args)
        raise AssertionError("a resume without its original settings must not launch")

    posted = []
    with patch.dict(ORIGINAL_SETTINGS, {}, clear=True):
        result = await _run(_fakes(never, posted), _request())
    assert isinstance(result, Exception), result
    assert calls == []
    errors = [row for row in posted if row[3].get("codeAgentResume") == "failed"]
    assert len(errors) == 1 and errors[0][3]["toolStatus"] == "ERROR"
    assert "Choose model, effort and speed" in errors[0][1]


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


async def test_each_execution_of_a_reused_id_bills_under_its_own_key():
    """A resend reuses the workflow id (ALLOW_DUPLICATE_FAILED_ONLY): each execution gets
    its own ledger key (first_execution_run_id), kept across continue_as_new.

    One shared key would make the backend's monotonic total ignore the new run's spend
    until it passed the earlier run's total (under-billed, uncounted toward the limit).
    """
    from temporalio import activity

    BILLED.clear()
    LIMIT_REACHED[0] = False

    async def spawn(*args):
        if args[15] is None and activity.info().task_queue == "q-old":
            return {
                "status": CODE_AGENT_DRAIN_YIELD_STATUS,
                "code_session": {"task_id": "task-new", "ws_url": "ws://sandbox", "code_provider": "claude"},
            }
        return {
            "success": True,
            "message": "done",
            "task_id": "task-new",
            "code_provider": "claude",
            "usage_items": [{"type": "service", "cost_cents": 7, "provider": "E2B"}],
        }

    from domains.spawn_claude_code_agent.config import CODE_AGENT_DRAIN_YIELD_STATUS

    workflow_id = f"code-resume:owner-1:{uuid.uuid4()}"
    run_ids = []
    result = await _run(
        _fakes(spawn, [], pointer_queue="q-live"),
        _request(),
        queues=("q-old", "q-live"),
        workflow_ids=[workflow_id, workflow_id],
        run_ids=run_ids,
    )
    assert not isinstance(result, Exception), result
    assert len(run_ids) == 2 and run_ids[0] != run_ids[1], run_ids
    keys = [args[1] for kind, args in BILLED if kind == "total"]
    expected = [f"resume:{workflow_id}:{run_id}" for run_id in run_ids]
    # Each execution reports before spending (both generations) and after its usage.
    assert set(keys) == set(expected), (keys, expected)
    first = keys.index(expected[1])
    assert keys[:first] and all(key == expected[0] for key in keys[:first]), "continue_as_new keeps the key"
    totals = {key: max(args[2] for kind, args in BILLED if kind == "total" and args[1] == key) for key in expected}
    assert totals == {expected[0]: 7.0, expected[1]: 7.0}, "the second run's spend is its own total"

    # A run continued from a worker without per-execution keys (a carried total, no key)
    # keeps the legacy key its earlier spend was reported under (never billed twice).
    BILLED.clear()
    legacy_id = f"code-resume:owner-1:{uuid.uuid4()}"
    result = await _run(
        _fakes(spawn, []), _request(billing={"spend_cents": 3.0}), queues=("q-live",), workflow_ids=[legacy_id]
    )
    assert not isinstance(result, Exception), result
    legacy_keys = {args[1] for kind, args in BILLED if kind == "total"}
    assert legacy_keys == {f"resume:{legacy_id}"}, legacy_keys


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
    await r.record_async("saved_resume_contract_recovery", test_saved_resume_contract_and_legacy_declarations_are_recovered_without_defaults)
    await r.record_async("missing_settings_actionable_error", test_missing_saved_settings_posts_an_actionable_error_without_spawning)
    await r.record_async("user_turn_real_code_activity", test_user_turn_resumes_through_the_real_code_activity)
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
    await r.record_async(
        "reused_id_bills_under_its_own_key", test_each_execution_of_a_reused_id_bills_under_its_own_key
    )
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
