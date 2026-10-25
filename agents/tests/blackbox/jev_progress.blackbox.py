"""Offline runtime contract tests; no live JEV or backend writes."""
import asyncio
import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, patch

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
    raw = answer(); raw["model"] = "wrong"
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
    from types import SimpleNamespace
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
    from types import SimpleNamespace
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
    from types import SimpleNamespace
    client = AsyncMock()
    client.patch.return_value.status_code = 200
    client.patch.return_value.json = lambda: {"mutation_accepted": True}
    config = SimpleNamespace(backend=SimpleNamespace(api_url="http://local.test", api_key="test"))
    with patch.object(messages, "get_http_client", return_value=client), patch.object(messages, "load_config", return_value=config), patch.object(messages, "workflow_generation_headers", return_value={"X-Agent-Workflow-Generation": "new-generation"}), patch.object(messages, "_queue_realtime_record", new_callable=AsyncMock) as queue, patch.object(messages.activity, "heartbeat"):
        await messages.update_agent_tree_state("root", [], "bus", {"agentId": "root", "status": "ACTIVE"})
    assert queue.await_args.args[2]["temporalWorkflowId"] == "new-generation"
    assert client.patch.call_args.kwargs["headers"]["X-Agent-Workflow-Generation"] == "new-generation"


async def run_all_tests():
    r = BlackboxResult()
    await r.record_async("tree bus generation", test_tree_generation_broadcast)
    r.record("prefix and decoder", test_prefix_and_decode)
    r.record("task ownership", test_scope)
    r.record("browser batches", test_browser_batches)
    await r.record_async("snapshot freeze and cancellation", test_freeze_queue_and_cancel_http)
    await r.record_async("generation publication", test_generation_publication)
    await r.record_async("global HTTP concurrency bound", test_http_concurrency_bound)
    await r.record_async("nonblocking bounded lifecycle", test_background_lifecycle)
    await r.record_async("HTTP and pinned prompt", test_http_contract)
    await r.record_async("DEMO replay runs without JEV", test_demo_replay_runs_without_jev)
    return r.all_passed


if __name__ == "__main__":
    assert asyncio.run(run_all_tests())
