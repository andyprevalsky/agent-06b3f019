"""Blackbox tests: BrowserAgentResumeWorkflow (a stopped browser the person resumed).

The real workflow runs on a time-skipping Temporal test server with the
production sandbox and the real browser-spawn handler; only activities are faked:

  - continue: the paused run's archived conversation is restored on its own
    inbox (_resume_paused_conversation) — the message is read there at step one
  - fresh: a finished browser kept no conversation; the browser tool's own
    recovery starts a new one whose goal carries the message, the earlier goal
    and the earlier result
  - a run started paused (a pause carried across continue_as_new) stops at once
  - a bad request posts "Browser could not resume" and fails non-retryably
"""

import asyncio
import uuid
from datetime import timedelta

from _test_utils import BlackboxResult

RECORDED_ACTIVITIES = []
INCREMENTS = []
POINTER_QUEUE = [None]


def _request(**extra):
    return {
        "agent_id": "owner-1",
        "user_id": "user-1",
        "model": "rose-labs/rose-1-ultra",
        "tool_call_id": "tc-browser",
        "inbox_address": "tc-browser",
        "goal": "Order breakfast on DoorDash",
        "start_url": "https://www.doordash.com",
        "mode": "continue",
        "previous_status": "paused",
        "previous_result": "",
        "message": "Use the second login.",
        "message_id": "m-row",
        **extra,
    }


def _fakes(browser_impl, posted):
    from temporalio import activity

    @activity.defn(name="spawn_browser_agent_activity_v3")
    async def fake_browser(*args):
        return await browser_impl(*args)

    @activity.defn(name="post_agent_message")
    async def fake_post(*args):
        posted.append(args)
        return {"id": f"row-{len(posted)}"}

    @activity.defn(name="fetch_agent_queue_pointer")
    async def fake_pointer():
        return {"task_queue": POINTER_QUEUE[0]} if POINTER_QUEUE[0] else {}

    @activity.defn(name="apply_resume_cost_activity")
    async def fake_resume_cost(owner_id, key, total):
        INCREMENTS.append((key, total))
        return {"limit_reached": False}

    @activity.defn(name="save_tool_usage")
    async def fake_usage(*args):
        return None

    return [fake_browser, fake_post, fake_pointer, fake_resume_cost, fake_usage]


async def _run(activities, request, interceptors=()):
    from temporalio.client import WorkflowFailureError
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from helpers.workflow_sandbox import production_workflow_runner
    from workflows.browser_agent_resume import BrowserAgentResumeWorkflow

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue="browser-agent-resume",
            workflows=[BrowserAgentResumeWorkflow],
            activities=activities,
            workflow_runner=production_workflow_runner(),
            interceptors=list(interceptors),
            max_heartbeat_throttle_interval=timedelta(seconds=1),
            default_heartbeat_throttle_interval=timedelta(seconds=1),
        ):
            handle = await env.client.start_workflow(
                BrowserAgentResumeWorkflow.run,
                request,
                id=f"code-resume:owner-1:browser:{uuid.uuid4()}",
                task_queue="browser-agent-resume",
            )
            try:
                return await asyncio.wait_for(handle.result(), timeout=60)
            except WorkflowFailureError as failure:
                return failure


def _done(args):
    return {
        "status": "completed",
        "success": True,
        "message": "Added a croissant.",
        "task_id": args[4] or "bs-new",
        "session_id": "sess-1",
        "usage_items": [],
        "structured_response": None,
        "output_files": [],
    }


async def test_continue_restores_the_paused_conversation_on_its_inbox():
    calls = []

    async def browser(*args):
        calls.append(args)
        return _done(args)

    posted = []
    result = await _run(_fakes(browser, posted), _request())
    assert not isinstance(result, Exception), result
    assert len(calls) == 1, calls
    args = calls[0]
    assert args[3] == "tc-browser" and args[22] == "tc-browser", (args[3], args[22])
    assert args[12] == {"_resume_paused_conversation": {"inbox_address": "tc-browser"}}, args[12]
    assert args[2] == "Order breakfast on DoorDash", "the restored conversation keeps its goal"
    tool_rows = [row for row in posted if row[2] == "TOOL"]
    assert tool_rows and all(row[3]["excludeFromModel"] is True for row in tool_rows), tool_rows


async def test_fresh_carries_the_message_and_the_earlier_goal_and_result():
    calls = []

    async def browser(*args):
        calls.append(args)
        return _done(args)

    posted = []
    request = _request(
        mode="fresh",
        inbox_address="tc-browser.resume-abc",
        previous_status="completed",
        previous_result="Ordered the oat latte.",
        message="Now add a croissant.",
    )
    result = await _run(_fakes(browser, posted), request)
    assert not isinstance(result, Exception), result
    args = calls[0]
    goal = args[2]
    assert goal.startswith("Now add a croissant."), goal
    assert "Order breakfast on DoorDash" in goal and "Ordered the oat latte." in goal, goal
    assert not args[12], "no conversation to restore"
    assert args[22] == "tc-browser.resume-abc"


async def test_a_run_started_paused_stops_at_once():
    from temporalio import activity

    async def browser(*args):
        try:
            while True:
                activity.heartbeat()
                await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            return {"status": "cancelled", "success": False, "message": "paused", "task_id": args[4], "usage_items": []}

    posted = []
    result = await _run(_fakes(browser, posted), _request(paused=True))
    assert not isinstance(result, Exception), result


async def test_a_sign_in_answer_reaches_the_resumed_browser():
    """Auth assistance during a resumed browser: the user's answer (receive_user_response) resumes it.

    The first browser run asks for sign-in (awaiting_auth_assistance); the run waits on
    that request id; the backend's completion signal answers it and the browser goes on.
    Without the run's signal handler and response state it would wait forever.
    """
    from temporalio import activity
    from temporalio.client import WorkflowFailureError
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from helpers.workflow_sandbox import production_workflow_runner
    from workflows.browser_agent_resume import BrowserAgentResumeWorkflow

    calls = []
    asked = asyncio.Event()

    async def browser(*args):
        calls.append(args)
        if len(calls) == 1:
            asked.set()
            return {
                "status": "awaiting_auth_assistance",
                "request_id": "auth-1",
                "base_site": "DoorDash",
                "task_id": "bs-new",
                "session_id": "sess-1",
                "browser_url": "https://www.doordash.com/login",
                "usage_items": [],
            }
        return _done(args)

    posted = []
    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue="q",
            workflows=[BrowserAgentResumeWorkflow],
            activities=_fakes(browser, posted),
            workflow_runner=production_workflow_runner(),
        ):
            handle = await env.client.start_workflow(
                BrowserAgentResumeWorkflow.run,
                _request(),
                id=f"code-resume:owner-1:browser:{uuid.uuid4()}",
                task_queue="q",
            )
            await asyncio.wait_for(asked.wait(), timeout=30)
            await handle.signal(
                BrowserAgentResumeWorkflow.receive_user_response,
                '{"request_id": "auth-1", "response": "AUTH_ASSISTANCE_COMPLETED"}',
            )
            try:
                await asyncio.wait_for(handle.result(), timeout=60)
            except WorkflowFailureError as failure:
                raise AssertionError(failure) from failure
    assert len(calls) == 2, "the browser went on after the sign-in answer"


async def test_fresh_resume_carries_the_spawns_output_schema_and_files():
    calls = []

    async def browser(*args):
        calls.append(args)
        return _done(args)

    pointer = {
        "id": "f-menu",
        "storage_path": "user-1/menu.pdf",
        "original_filename": "menu.pdf",
        "mime_type": "application/pdf",
        "size_bytes": 3,
        "created_at": "2026-11-08T00:00:00Z",
    }
    schema = {"type": "object", "properties": {"total": {"type": "number"}}}
    posted = []
    request = _request(mode="fresh", inbox_address="tc-browser.resume-x", output_schema=schema, attachments=[pointer])
    result = await _run(_fakes(browser, posted), request)
    assert not isinstance(result, Exception), result
    args = calls[0]
    assert args[8] == schema, args[8]
    assert [item.get("original_filename") for item in args[9] or []] == ["menu.pdf"], args[9]


async def test_spend_billed_before_a_handoff_carries_to_the_live_queue():
    """A drain-yield bills the run's spend, then continue_as_new: the live queue continues it.

    Without the carried billing the live run would restart its increment sequence at 1
    and the owner's increment would be deduplicated away (spend lost).
    """
    from temporalio import activity
    from temporalio.client import WorkflowFailureError
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from domains.spawn_browser_agent_v3.config import BROWSER_DRAIN_YIELD_STATUS
    from helpers.workflow_sandbox import production_workflow_runner
    from workflows.browser_agent_resume import BrowserAgentResumeWorkflow

    INCREMENTS.clear()
    calls = []

    async def browser(*args):
        calls.append(activity.info().task_queue)
        if len(calls) == 1:
            return {
                "status": BROWSER_DRAIN_YIELD_STATUS,
                "task_id": "bs-new",
                "session_id": "sess-1",
                "step_count": 3,
                "usage_items": [{"type": "service", "cost_cents": 5, "provider": "Kernel"}],
            }
        done = _done(args)
        done["usage_items"] = [{"type": "service", "cost_cents": 3, "provider": "Kernel"}]
        return done

    POINTER_QUEUE[0] = "q-live"
    posted = []
    try:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            fakes = _fakes(browser, posted)
            workers = [
                Worker(
                    env.client,
                    task_queue=queue,
                    workflows=[BrowserAgentResumeWorkflow],
                    activities=fakes,
                    workflow_runner=production_workflow_runner(),
                )
                for queue in ("q-old", "q-live")
            ]
            for worker in workers:
                await worker.__aenter__()
            try:
                handle = await env.client.start_workflow(
                    BrowserAgentResumeWorkflow.run,
                    _request(),
                    id=f"code-resume:owner-1:browser:{uuid.uuid4()}",
                    task_queue="q-old",
                )
                try:
                    await asyncio.wait_for(handle.result(), timeout=60)
                except WorkflowFailureError as failure:
                    raise AssertionError(failure) from failure
            finally:
                for worker in reversed(workers):
                    await worker.__aexit__(None, None, None)
    finally:
        POINTER_QUEUE[0] = None
    assert calls == ["q-old", "q-live"], calls
    totals = [total for _key, total in INCREMENTS]
    assert totals == sorted(totals), f"the run's total never goes down: {INCREMENTS}"
    assert max(totals) == 8.0, f"spend continues across the handoff (5 + 3): {INCREMENTS}"
    assert len({key for key, _total in INCREMENTS}) == 1, "one key across the handoff"


async def test_bad_request_posts_could_not_resume_and_fails_non_retryably():
    from temporalio.exceptions import ApplicationError

    async def never(*args):
        raise AssertionError("no browser for a bad request")

    posted = []
    failure = await _run(_fakes(never, posted), _request(inbox_address=""))
    assert isinstance(failure, Exception), failure
    assert isinstance(failure.cause, ApplicationError) and failure.cause.non_retryable
    rows = [row for row in posted if row[3].get("browserResume") == "failed"]
    assert rows and rows[-1][3]["toolStatus"] == "ERROR" and "inbox_address" in rows[-1][1], posted


async def test_resumed_sub_agent_llm_records_land_in_the_root_bundle():
    """A resumed sub-agent's browser activity archives under the request's tree root.

    Without `root_agent_id` the root is unknown: no root header is guessed, the
    record falls back to the acting agent, and the fallback is counted loudly.
    """
    import os
    import tempfile
    from pathlib import Path

    import helpers.observability as observability
    import helpers.trace_archive as trace_archive
    from helpers.archive_identity import production_worker_interceptors
    from helpers.llm_archive_record import archive_counters
    from helpers.tracing import current_bound_root_agent_id, current_workflow_agent_id

    seen = []

    async def browser(*args):
        seen.append((current_bound_root_agent_id(), current_workflow_agent_id()))
        observability.dump_llm_context("verifier_browser", [{"role": "user", "content": "check"}], output={"content": "ok"})
        return _done(args)

    old_root, old_prod = trace_archive._LOCAL_ROOT, observability._IS_PRODUCTION
    old_env = {key: os.environ.get(key) for key in ("TRACE_ARCHIVE_ENABLED", "TRACE_ARCHIVE_BACKEND")}
    with tempfile.TemporaryDirectory() as tmp:
        try:
            trace_archive._LOCAL_ROOT = Path(tmp)
            observability._IS_PRODUCTION = True
            os.environ.update({"TRACE_ARCHIVE_ENABLED": "1", "TRACE_ARCHIVE_BACKEND": "local"})
            result = await _run(
                _fakes(browser, []), _request(root_agent_id="root-1"), interceptors=production_worker_interceptors()
            )
            assert not isinstance(result, Exception), result
            assert seen == [("root-1", "owner-1")], seen
            assert len(list((Path(tmp) / "root-1" / "llm").glob("*.enc"))) == 1
            assert len(list((Path(tmp) / "root-1" / "llm-updates").glob("*.enc"))) == 1
            assert not (Path(tmp) / "owner-1").exists(), "sub-agent records must not split into their own bundle"

            before = archive_counters().get("root_fallback_to_agent_id", 0)
            result = await _run(_fakes(browser, []), _request(), interceptors=production_worker_interceptors())
            assert not isinstance(result, Exception), result
            assert seen[-1] == (None, "owner-1"), "an unknown root must not be guessed in the header"
            assert archive_counters().get("root_fallback_to_agent_id", 0) == before + 1
        finally:
            trace_archive._LOCAL_ROOT, observability._IS_PRODUCTION = old_root, old_prod
            for key, value in old_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


async def run_all_tests():
    print("browser_agent_resume blackbox tests:")
    r = BlackboxResult()
    await r.record_async(
        "continue_restores_paused_conversation", test_continue_restores_the_paused_conversation_on_its_inbox
    )
    await r.record_async(
        "fresh_carries_message_goal_result", test_fresh_carries_the_message_and_the_earlier_goal_and_result
    )
    await r.record_async("started_paused_stops", test_a_run_started_paused_stops_at_once)
    await r.record_async("sign_in_answer_reaches_run", test_a_sign_in_answer_reaches_the_resumed_browser)
    await r.record_async("fresh_carries_schema_and_files", test_fresh_resume_carries_the_spawns_output_schema_and_files)
    await r.record_async("spend_carries_across_handoff", test_spend_billed_before_a_handoff_carries_to_the_live_queue)
    await r.record_async(
        "bad_request_fails_non_retryably", test_bad_request_posts_could_not_resume_and_fails_non_retryably
    )
    await r.record_async("resumed_sub_agent_records_land_in_root", test_resumed_sub_agent_llm_records_land_in_the_root_bundle)
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
