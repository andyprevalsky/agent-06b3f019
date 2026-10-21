"""Owning manager regression: one GP's complete browser turn includes cleanup."""

import asyncio
from types import SimpleNamespace
from unittest.mock import patch


async def _tick_until(predicate):
    for _ in range(100):
        if predicate():
            return
        await asyncio.sleep(0)
    assert predicate(), "expected local coroutine boundary was never reached"


async def run_browser_activity_queue_case(*, patched=True, cancel=False, timedout=False):
    from temporalio import workflow
    from domains.spawn_browser_agent_v3.handler import (
        SpawnBrowserAgentManagerV3,
        _logical_browser_task_id,
        _stable_browser_task_id,
    )

    owner = SimpleNamespace(user_id="queue-user", agent_id="queue-gp", is_paused=False)
    other = SimpleNamespace(user_id="queue-user", agent_id="other-gp", is_paused=False)
    started, completed, calls = [], [], []
    work, cleanup = asyncio.Event(), asyncio.Event()
    cleaning = asyncio.Event()

    async def native(call_id):
        try:
            if call_id == "first":
                await work.wait()
        finally:
            if call_id == "first":
                cleaning.set()
                await cleanup.wait()
            completed.append(call_id)
        if timedout and call_id == "first":
            from temporalio.exceptions import ActivityError, TimeoutError

            failure = ActivityError(
                "fixture timeout",
                scheduled_event_id=1,
                started_event_id=2,
                identity="fixture",
                activity_type="browser",
                activity_id="first",
                retry_state=None,
            )
            raise failure from TimeoutError("worker cleanup unknown", type=None, last_heartbeat_details=[])
        return {"status": "completed", "success": True, "message": "done"}

    def start(_function, **kwargs):
        call_id = kwargs["args"][3]
        calls.append(kwargs)
        started.append(call_id)
        return asyncio.create_task(native(call_id))

    async def wait_condition(predicate, **_kwargs):
        while not predicate():
            await asyncio.sleep(0)

    async def consume(wf, call_id):
        return [event async for event in SpawnBrowserAgentManagerV3().execute_tool(wf, {"goal": call_id}, call_id)]

    tasks = []
    with (
        patch("domains.spawn_browser_agent_v3.handler.workflow.in_workflow", return_value=True),
        patch("domains.spawn_browser_agent_v3.handler.workflow.patched", return_value=patched),
        patch("domains.spawn_browser_agent_v3.handler.workflow.start_activity", side_effect=start),
        patch("domains.spawn_browser_agent_v3.handler.workflow.wait_condition", side_effect=wait_condition),
    ):
        try:
            first = asyncio.create_task(consume(owner, "first"))
            tasks.append(first)
            await _tick_until(lambda: "first" in started)
            second = asyncio.create_task(consume(owner, "second"))
            unrelated = asyncio.create_task(consume(other, "other"))
            tasks.extend([second, unrelated])
            await _tick_until(lambda: "other" in started)
            if patched:
                assert "second" not in started, "same-GP second browser activity started concurrently"
            else:
                await _tick_until(lambda: "second" in started)
            if cancel:
                first.cancel()
            else:
                work.set()
            await cleaning.wait()
            if patched:
                assert "second" not in started, "browser turn was released before worker cleanup"
            cleanup.set()
            results = await asyncio.gather(*tasks, return_exceptions=cancel or timedout)
            if timedout:
                assert "second" not in started
                assert isinstance(results[1], RuntimeError)
                assert "cleanup is unconfirmed" in str(results[1])
                return
            assert "second" in completed
            if patched:
                assert completed.index("first") < completed.index("second")
                assert calls[0]["args"][4] == _logical_browser_task_id(owner.agent_id)
                assert calls[0]["args"][-1] is True
                assert calls[0]["cancellation_type"] == workflow.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED
            else:
                assert calls[0]["args"][4] == _stable_browser_task_id(owner.agent_id, "first")
                assert len(calls[0]["args"]) == 22, "old replay activity payload shape changed"
                assert calls[0]["cancellation_type"] == workflow.ActivityCancellationType.TRY_CANCEL
        finally:
            work.set()
            cleanup.set()
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


async def test_browser_activity_queue_lifecycle():
    from domains.spawn_browser_agent_v3.browser_activity_queue import await_owned_browser_cleanup

    await run_browser_activity_queue_case()
    await run_browser_activity_queue_case(cancel=True)
    await run_browser_activity_queue_case(timedout=True)
    await run_browser_activity_queue_case(patched=False)

    release = asyncio.Event()
    cleanup = asyncio.create_task(release.wait())
    barrier = asyncio.create_task(await_owned_browser_cleanup(cleanup))
    await asyncio.sleep(0)
    barrier.cancel()
    await asyncio.sleep(0)
    assert not cleanup.cancelled() and not barrier.done()
    release.set()
    results = await asyncio.gather(barrier, return_exceptions=True)
    assert isinstance(results[0], asyncio.CancelledError)
    assert cleanup.done()


async def test_browser_activity_timeout_fence_survives_continuation():
    from workflows.agent_workflow import AgentWorkflow
    from domains.spawn_browser_agent_v3.handler import SpawnBrowserAgentManagerV3

    carrier = AgentWorkflow()
    carrier.max_iterations, carrier.context_gates = None, {}
    state = carrier._continuation_resume_state([])
    assert "browser_activity_cleanup_unknown" not in state["runtime_state"]
    carrier._browser_activity_cleanup_unknown = True
    state = carrier._continuation_resume_state([])
    restored = AgentWorkflow()
    restored._restore_deployment_state(state)
    assert restored._browser_activity_cleanup_unknown is True
    with patch("domains.spawn_browser_agent_v3.handler.workflow.start_activity") as start:
        try:
            async for _event in SpawnBrowserAgentManagerV3().execute_tool(restored, {}, "later"):
                pass
        except RuntimeError as exc:
            assert "cleanup is unconfirmed" in str(exc)
        else:
            raise AssertionError("continuation lost its unknown-cleanup fence")
        start.assert_not_called()
