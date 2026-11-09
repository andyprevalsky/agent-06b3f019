"""Offline runtime contract tests; no live JEV or backend writes."""
import asyncio
import json
import os
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from structlog.testing import capture_logs

from _test_utils import BlackboxResult
from helpers import jev_progress as jev

PROMPT = {"scope": "own calls", "progress": "remaining", "eta": "duration", "input_format": "timeline"}


def snapshot():
    return {"agentId": "root", "taskId": "task", "kind": "explore", "goal": "find fact",
            "output_schema": {"type": "object"}, "events": [
                {"role": "assistant", "calls": [{"tool": "search", "id": "a"}], "timestamp": "2026-10-21T00:00:00Z"},
                {"role": "tool", "call_id": "a", "text": "fact", "timestamp": "2026-10-21T00:00:03Z"}],
            "observedAt": "2026-10-21T00:00:04Z", "sequence": 1}


def answer(bucket=4):
    return {"model": jev.MODEL, "answers": {"remaining_batches": {
        "probabilities": {str(i): float(i == bucket) for i in range(10)}}, "eta": {"choice": "1m"}}}


def test_prefix_and_decode():
    snap = snapshot()
    a = jev.request(snap, PROMPT)
    snap["target"] = {"actual_progress": 1}
    snap["final_outcome"] = "future secret"
    assert jev.request(snap, PROMPT) == a
    assert a["state"]["elapsed_seconds"] == 3
    assert a["state"]["observed_tool_counts"] == {"search": 1}
    assert a["state"]["observed_batches"] == 1
    estimate = jev.decode(answer(), snap, "a" * 64)
    assert estimate["progress"] == 1 / 6
    assert estimate["etaSeconds"] == 60 and estimate["taskId"] == "task"
    assert len(a["questions"]["remaining_batches"]["criteria"]) == 10
    assert len(jev.ETA) == 123 and max(jev.ETA.values()) == 31536000
    for invalid in [float("nan"), -1, True, "0.5"]:
        raw = answer()
        raw["answers"]["remaining_batches"]["probabilities"]["0"] = invalid
        try:
            jev.decode(raw, snap, "a" * 64)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid probability accepted")
    raw = answer()
    raw["model"] = "wrong"
    try:
        jev.decode(raw, snap, "a" * 64)
    except ValueError:
        pass
    else:
        raise AssertionError("Wrong model accepted")


def test_scope():
    rows = [{"role": "ASSISTANT", "metadata": {"tool_calls": [{"tool": "spawn", "tool_call_id": "own"}]}},
            {"role": "TOOL", "text": "own result", "metadata": {"toolCallId": "own"}},
            {"role": "ASSISTANT", "metadata": {"subAgentId": "other", "tool_calls": [{"tool": "leak"}]}},
            {"role": "TOOL", "text": "foreign", "metadata": {"toolCallId": "unknown"}}]
    assert len(jev.prefix_events(rows)) == 2
    assert len(jev.prefix_events(rows, "task")) == 2
    assert "leak" not in json.dumps(jev.prefix_events(rows))


async def test_background_lifecycle():
    started = []
    release = asyncio.Event()
    async def predict(snap):
        started.append(snap)
        await release.wait()
    with patch.object(jev, "predict_jev_progress", predict):
        session = jev.JEVSession("root", "task", "browser")
        for i in range(10):
            session.schedule(str(i), {}, [])
        # Scheduling never waits for prediction, and backlog is bounded.
        await asyncio.sleep(0)
        assert len(started) == 2 and len(session.pending) == 2
        assert session.queued["goal"] == "9"
        assert started[0]["sequence"] < started[1]["sequence"]
        session.close()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert session.closed and not session.pending and session.queued is None
        assert len(started) == 2
    # All exit paths of run_agent use the decorator's finally cleanup.
    with patch.object(jev.JEVSession, "close") as close:
        @jev.with_jev_session
        async def fail(agent_id, _jev_session=None):
            raise ValueError("failure")
        try:
            await fail("root")
        except ValueError:
            pass
        close.assert_called_once()


async def test_demo_replay_runs_without_jev():
    """descend-full69 MA8: a fully demo-cached mass-agent run made a live
    api.typesafe.ai estimate and a full-history snapshot every turn of 100 agents
    on one 2-CPU guest worker; its posts starved past their activity deadlines.
    A DEMO replay (fast_mode_cache_enabled) gets no session; a live run keeps one.
    """
    seen = {}

    @jev.with_jev_session
    async def run(agent_id, fast_mode_cache_enabled=False, _jev_session=None):
        seen[fast_mode_cache_enabled] = _jev_session
        return "done"

    assert await run("gp-1", fast_mode_cache_enabled=True) == "done"
    assert await run("root-1") == "done"
    assert seen[True] is None
    assert isinstance(seen[False], jev.JEVSession) and seen[False].closed


async def test_http_contract():
    client = AsyncMock()
    response = client.post.return_value
    response.raise_for_status = lambda: None
    response.json = lambda: answer()
    with patch.dict(os.environ, {"TYPESAFE_API_KEY": "test"}), patch.object(jev, "get_http_client", return_value=client), patch.object(jev, "publish_progress_estimate", new_callable=AsyncMock) as publish:
        await jev.predict_jev_progress(snapshot())
        client.post.assert_awaited_once()
        publish.assert_awaited_once()
        estimate = publish.call_args.args[1]
        doc = json.loads((Path(__file__).parents[2] / "config/jev_progress_prompt.json").read_text())
        assert estimate["promptVersion"] == doc["promptVersion"]
        assert estimate["model"] == "jev-1.13.0"
    with patch.dict(os.environ, {}, clear=True), patch.object(jev, "get_http_client") as client:
        await jev.predict_jev_progress(snapshot())
        client.assert_not_called()


async def test_freeze_queue_and_cancel_http():
    received = []
    gate = asyncio.Event()
    async def predict(snap):
        received.append(snap)
        await gate.wait()
    with patch.object(jev, "predict_jev_progress", predict):
        session = jev.JEVSession("root")
        schema = {"type": "object"}
        session.schedule("goal", schema, snapshot()["events"])
        schema["future"] = "must not leak"
        session.schedule("goal", {}, [])  # compaction must not erase prior own batches
        session.schedule("latest", {}, [])
        await asyncio.sleep(0)
        assert "future" not in received[0]["output_schema"]
        assert len(received[1]["events"]) == 2
        gate.set()
        for _ in range(5):
            await asyncio.sleep(0)
        assert received[-1]["goal"] == "latest"
        session.close()
    client = AsyncMock()
    entered = asyncio.Event()
    async def blocking_request(*args, **kwargs):
        entered.set()
        await asyncio.Event().wait()
    client.post.side_effect = blocking_request
    with patch.dict(os.environ, {"TYPESAFE_API_KEY": "test"}), patch.object(jev, "get_http_client", return_value=client), patch.object(jev, "publish_progress_estimate", new_callable=AsyncMock) as publish:
        pending = asyncio.create_task(jev.predict_jev_progress(snapshot()))
        await entered.wait()
        pending.cancel()
        try:
            await pending
        except asyncio.CancelledError:
            pass
        publish.assert_not_awaited()


def test_browser_batches():
    entries = [{"step": 1, "action": "click", "params": {}, "result": {"success": True}, "screenshot": "secret"},
               {"step": 1, "action": "type", "result": {"success": False}},
               {"step": 2, "action": "read", "result": {}}]
    events = jev.browser_prefix_events(entries)
    assert sum(e["role"] == "assistant" for e in events) == 2
    assert len(events[0]["calls"]) == 2
    assert "secret" not in json.dumps(events)
    assert all(e.get("timestamp") is None for e in events)
    assert any(e.get("status") == "ERROR" for e in events)


async def test_generation_publication():
    from helpers import update_status
    client = AsyncMock()
    client.patch.return_value.raise_for_status = lambda: None
    config = SimpleNamespace(backend=SimpleNamespace(api_url="http://local.test", api_key="test"))
    with patch.object(update_status, "get_http_client", return_value=client), patch.object(update_status, "load_config", return_value=config), patch.object(update_status, "workflow_generation_headers", return_value={"X-Agent-Workflow-Generation": "generation"}):
        await update_status.publish_progress_estimate("root", {"taskId": "child"})
    args, kwargs = client.patch.call_args
    assert args[0] == "http://local.test/api/agents/root/progress-estimate"
    assert kwargs["headers"]["X-Agent-Workflow-Generation"] == "generation"
    assert kwargs["json"] == {"progressEstimate": {"taskId": "child"}}


async def test_http_concurrency_bound():
    client = AsyncMock()
    active = peak = 0
    four_started = asyncio.Event()
    release = asyncio.Event()
    async def post(*args, **kwargs):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        if active == 4:
            four_started.set()
        await release.wait()
        active -= 1
        return SimpleNamespace(raise_for_status=lambda: None, json=answer)
    client.post.side_effect = post
    with patch.dict(os.environ, {"TYPESAFE_API_KEY": "test"}), patch.object(jev, "get_http_client", return_value=client), patch.object(jev, "publish_progress_estimate", new_callable=AsyncMock):
        tasks = [asyncio.create_task(jev.predict_jev_progress(snapshot())) for _ in range(8)]
        await asyncio.wait_for(four_started.wait(), 2)
        await asyncio.sleep(0)
        assert peak == 4 and client.post.await_count == 4
        release.set()
        await asyncio.gather(*tasks)
        assert peak == 4 and client.post.await_count == 8


async def test_tree_generation_broadcast():
    from helpers import messages
    client = AsyncMock()
    client.patch.return_value.status_code = 200
    client.patch.return_value.json = lambda: {"mutation_accepted": True}
    config = SimpleNamespace(backend=SimpleNamespace(api_url="http://local.test", api_key="test"))
    with patch.object(messages, "get_http_client", return_value=client), patch.object(messages, "load_config", return_value=config), patch.object(messages, "workflow_generation_headers", return_value={"X-Agent-Workflow-Generation": "new-generation"}), patch.object(messages, "_queue_realtime_record", new_callable=AsyncMock) as queue, patch.object(messages.activity, "heartbeat"):
        await messages.update_agent_tree_state("root", [], "bus", {"agentId": "root", "status": "ACTIVE"})
    assert queue.await_args.args[2]["temporalWorkflowId"] == "new-generation"
    assert client.patch.call_args.kwargs["headers"]["X-Agent-Workflow-Generation"] == "new-generation"


def long_browser_snapshot(steps=190):
    """H-76 (e24 browser-doordash-food-plan-grocery-cart-reauth r2): a ~190-step
    browser prefix whose clipped state exceeds the 24k-token budget. Every string
    is longer than the final 80-character clip, as on real DoorDash pages."""
    kinds = ["click", "read_browser_state", "evaluate", "goto", "click", "click", "key_press"]
    entries = [{"step": s, "action": kinds[s % len(kinds)],
                "params": {"index": 1000 + s, "url": f"https://www.doordash.com/store/1741346/search/item-{s}?q=" + "x" * 200,
                           "script": "(() => [...document.querySelectorAll('[data-anchor-id]')].map(r => r.innerText))()" * 3},
                "result": {"success": True, "extracted_content": f"Added item {s} to cart. " * 120,
                           "title": 'Clicked <button "Add to cart"> ' * 5, "current_url": "https://www.doordash.com/cart?x=" + "y" * 300,
                           "message": "Executed JS. " * 50, "formatted_state": "[1234]<div role=button>Add</div>\n" * 400}}
               for s in range(1, steps + 1)]
    return {"agentId": "root", "taskId": "browser-task", "kind": "browser", "goal": "Build the complete weekly grocery cart. " * 20,
            "output_schema": {"type": "object"}, "events": jev.browser_prefix_events(entries),
            "observedAt": "2026-11-08T06:23:20Z", "sequence": 1}


def status_client(status, body=None):
    client = AsyncMock()
    client.post.return_value = httpx.Response(status, json=body, request=httpx.Request("POST", "https://api.typesafe.ai/v1/systemone"))
    return client


TOO_LARGE = {"detail": {"error_type": "max_tokens_exceeded"}}


async def test_prefix_build_runs_off_event_loop():
    """H-76: the json/tiktoken clip loop for a long browser prefix ran on the
    activity's event-loop thread, stalling the browser step loop ~0.27-0.37s per
    prediction (one prediction per step). It must run on a worker thread so the
    loop stays responsive while the prefix is built."""
    loop_thread = threading.get_ident()
    built = {}
    original = jev.request
    def timed_request(*args, **kwargs):
        start = time.perf_counter()
        try:
            return original(*args, **kwargs)
        finally:
            built["thread"], built["seconds"] = threading.get_ident(), time.perf_counter() - start
    jev.request(long_browser_snapshot(20), {"scope": "", "progress": "", "eta": ""})  # warm tiktoken outside the measurement
    worst = 0.0
    done = False
    async def ticker():
        nonlocal worst
        while not done:
            start = time.perf_counter()
            await asyncio.sleep(0.002)
            worst = max(worst, time.perf_counter() - start - 0.002)
    tick = asyncio.create_task(ticker())
    await asyncio.sleep(0.01)
    with patch.dict(os.environ, {"TYPESAFE_API_KEY": "test"}), patch.object(jev, "get_http_client", return_value=status_client(200)), \
            patch.object(jev, "request", timed_request), capture_logs():
        await jev.predict_jev_progress(long_browser_snapshot(130))
    done = True
    await tick
    assert built["thread"] != loop_thread, "JEV prefix build ran on the event-loop thread"
    # Relative to the build's own duration, so host speed does not matter.
    assert worst < max(0.05, built["seconds"] / 2), f"event loop stalled {worst:.3f}s during a {built['seconds']:.3f}s prefix build"


async def test_http_failure_logs_status_and_stage():
    """H-76: 18 jev_progress.failed HTTPStatusError warnings carried no status,
    and the same exception type is raised by the TypeSafe call and the backend
    publish. Log the status code, its response class and the failing stage."""
    with patch.dict(os.environ, {"TYPESAFE_API_KEY": "test"}), patch.object(jev, "get_http_client", return_value=status_client(413)), \
            capture_logs() as logs:
        await jev.predict_jev_progress(snapshot())
    failed = [entry for entry in logs if entry["event"] == "jev_progress.failed"]
    assert len(failed) == 1, logs
    assert failed[0]["error_type"] == "HTTPStatusError"
    assert failed[0].get("status_code") == 413 and failed[0].get("response_class") == "4xx", failed[0]
    assert failed[0].get("stage") == "predict", failed[0]
    assert "test" not in json.dumps(failed[0], default=str)


async def drive_session(snap, client, schedules=6):
    with patch.dict(os.environ, {"TYPESAFE_API_KEY": "test"}), patch.object(jev, "get_http_client", return_value=client), \
            capture_logs() as logs:
        session = jev.JEVSession("root", "browser-task", "browser")
        for _ in range(schedules):
            session.schedule(snap["goal"], snap["output_schema"], snap["events"])
            await asyncio.gather(*list(session.pending), return_exceptions=True)
            for _ in range(3):
                await asyncio.sleep(0)
        session.close()
    return [entry for entry in logs if entry["event"] == "jev_progress.failed"]


async def test_budget_exceeded_stops_session():
    """H-76: once the browser prefix exceeded the 24k-token budget it could only
    grow, yet every later step rebuilt it and logged another ValueError (66 in
    the run). The session stops estimating after the first deterministic budget
    failure; the prompt, input format and budget are unchanged."""
    client = status_client(200)
    failed = await drive_session(long_browser_snapshot(190), client)
    client.post.assert_not_awaited()
    assert len(failed) == 1, failed
    assert failed[0]["error_type"] == "JEVBudgetExceeded" and failed[0]["stage"] == "prepare"


async def test_provider_size_refusal_stops_session():
    """H-76: TypeSafe answers 400 {"detail": {"error_type": "max_tokens_exceeded"}}
    for a ~25.6k-token body that passed the state-only 24k check (steps 130-141,
    18 failures). That size refusal, or a 413, stops the session."""
    for client in (status_client(400, TOO_LARGE), status_client(413)):
        failed = await drive_session(snapshot(), client)
        assert client.post.await_count == 1 and len(failed) == 1, failed
        assert failed[0]["status_code"] in (400, 413) and failed[0]["stage"] == "predict"


async def test_transient_failures_do_not_stop_session():
    """A stop is recorded in Temporal history for the rest of the run, so only a
    size refusal may stop it. Auth/availability blips, other 400s, network errors
    and publish-stage 4xx keep the session estimating on every schedule."""
    request = httpx.Request("POST", "https://api.typesafe.ai/v1/systemone")
    cases = {status: status_client(status) for status in (500, 503, 408, 409, 401, 403, 404, 425, 429)}
    cases["400 other"] = status_client(400, {"detail": {"error_type": "invalid_request"}})
    cases["400 no body"] = status_client(400)
    for name, error in (("connect", httpx.ConnectError("down", request=request)), ("read timeout", httpx.ReadTimeout("slow", request=request))):
        cases[name] = AsyncMock()
        cases[name].post.side_effect = error
    for name, client in cases.items():
        failed = await drive_session(snapshot(), client, schedules=3)
        assert client.post.await_count == 3 and len(failed) == 3, (name, failed)
    ok = status_client(200)
    ok.post.return_value = SimpleNamespace(raise_for_status=lambda: None, json=answer)
    rejected = httpx.Response(404, request=httpx.Request("PATCH", "http://local.test/api/agents/root/progress-estimate"))
    publish = AsyncMock(side_effect=httpx.HTTPStatusError("not found", request=rejected.request, response=rejected))
    with patch.object(jev, "publish_progress_estimate", publish):
        failed = await drive_session(snapshot(), ok, schedules=3)
    assert ok.post.await_count == 3 and publish.await_count == 3, failed
    assert len(failed) == 3 and all(entry["stage"] == "publish" and entry["status_code"] == 404 for entry in failed)


def test_done_callback_ignores_non_dict_results():
    """CodeRabbit PR #1865: a non-dict activity result must not raise inside the done callback,
    which would leave the queued prefix unstarted; only a dict stopSession stops the session."""
    from helpers.jev_progress import JEVSession

    class finished:  # a completed future's surface; hashable like a real future
        def __init__(self, value):
            self.value = value

        def cancelled(self):
            return False

        def exception(self):
            return None

        def result(self):
            return self.value

    session = JEVSession("agent-done-callback")
    for value in ("unexpected", ["stopSession"], None, {}):
        session._done(finished(value))
        assert session.stopped is False, value
    session._done(finished({"stopSession": True}))
    assert session.stopped is True


async def run_all_tests():
    r = BlackboxResult()
    await r.record_async("tree bus generation", test_tree_generation_broadcast)
    r.record("prefix and decoder", test_prefix_and_decode)
    r.record("task ownership", test_scope)
    r.record("browser batches", test_browser_batches)
    r.record("done callback type guard", test_done_callback_ignores_non_dict_results)
    await r.record_async("snapshot freeze and cancellation", test_freeze_queue_and_cancel_http)
    await r.record_async("generation publication", test_generation_publication)
    await r.record_async("global HTTP concurrency bound", test_http_concurrency_bound)
    await r.record_async("nonblocking bounded lifecycle", test_background_lifecycle)
    await r.record_async("HTTP and pinned prompt", test_http_contract)
    await r.record_async("DEMO replay runs without JEV", test_demo_replay_runs_without_jev)
    await r.record_async("prefix build runs off the event loop", test_prefix_build_runs_off_event_loop)
    await r.record_async("HTTP failure logs status and stage", test_http_failure_logs_status_and_stage)
    await r.record_async("budget exceeded stops the session", test_budget_exceeded_stops_session)
    await r.record_async("provider size refusal stops the session", test_provider_size_refusal_stops_session)
    await r.record_async("transient failures do not stop the session", test_transient_failures_do_not_stop_session)
    return r.all_passed


if __name__ == "__main__":
    assert asyncio.run(run_all_tests())
