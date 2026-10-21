"""Sealed bridge from actual backend signal producers to the workflow and manager."""
import asyncio
import json
import socket
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "agents"), str(Path(__file__).parent)]

def forbid(*args, **kwargs):
    raise AssertionError("provider/network calls prohibited in pause provenance fixture")
socket.socket.connect = forbid
socket.socket.connect_ex = forbid
import _test_utils  # Owns the repository's offline Temporal clock and HTTP capture.
from workflows.agent_workflow import AgentWorkflow
from domains.spawn_browser_agent_v3.handler import SpawnBrowserAgentManagerV3

async def prove_signals(cases):
    for case in cases:
        wf = AgentWorkflow()
        wf.agent_id, wf.user_id, wf.goal = "pause-fixture", "user-fixture", "fixture"
        wf._update_tree_state = AsyncMock()
        wf._get_pending_child_workflow_ids = lambda: ["child-fixture"]
        child = AsyncMock()
        logger = SimpleNamespace(info=lambda *a, **k: None, warning=lambda *a, **k: None)
        with patch("workflows.agent_workflow.workflow.logger", logger), patch("workflows.agent_workflow.workflow.get_external_workflow_handle", return_value=SimpleNamespace(signal=child)):
            await wf.pause(*case["signal"][1:])
        expected = case["source"] == "user_control"
        assert wf.is_paused
        assert wf._user_pause_active is expected, f"B1: {case['source']} became user intent: {case['signal']}"
        # The exact cause accepted by the parent must reach a child as well.
        propagated = child.await_args.args
        child_wf = AgentWorkflow()
        child_wf._update_tree_state = AsyncMock()
        child_wf._get_pending_child_workflow_ids = lambda: []
        with patch("workflows.agent_workflow.workflow.logger", logger):
            await child_wf.pause(*propagated[1:])
        assert child_wf._user_pause_active is expected

        class Handle:
            def done(self): return False
            def cancel(self): pass
            def __await__(self):
                async def cancelled(): raise asyncio.CancelledError()
                return cancelled().__await__()
        with patch("domains.spawn_browser_agent_v3.handler.workflow.start_activity", return_value=Handle()), \
             patch("domains.spawn_browser_agent_v3.handler.workflow.wait_condition", AsyncMock()):
            events = [e async for e in SpawnBrowserAgentManagerV3().execute_tool(wf, {"goal": "fixture"}, "call")]
        final = events[-1]
        assert (final.metadata.get("userPauseRequested") is True) is expected
        assert ("User paused" in final.message) is expected
    return len(cases)

async def prove_pause_episode_ordering():
    """Exercise the real pause owner, child signals and cancellation consumer."""
    sequences = [
        ("user", "subscription"),
        ("user", "unknown"),
        ("subscription", "user"),
        ("unknown", "user"),
        ("user", "resume", "subscription"),
        ("subscription", "unknown"),
    ]
    logger = SimpleNamespace(info=lambda *a, **k: None, warning=lambda *a, **k: None)
    for sequence in sequences:
        parent, child = AgentWorkflow(), AgentWorkflow()
        for wf in (parent, child):
            wf.agent_id, wf.user_id, wf.goal = "episode-fixture", "user-fixture", "fixture"
            wf._update_tree_state = AsyncMock()
            wf._get_pending_child_workflow_ids = lambda: []
        parent._get_pending_child_workflow_ids = lambda: ["child-fixture"]
        forwarded = []

        async def signal(name, *args):
            forwarded.append((name, *args))
            await getattr(child, name)(*args)

        expected = False
        with patch("workflows.agent_workflow.workflow.logger", logger), patch(
            "workflows.agent_workflow.workflow.get_external_workflow_handle",
            return_value=SimpleNamespace(signal=signal),
        ):
            for cause in sequence:
                if cause == "resume":
                    expected = False
                    await parent.resume()
                else:
                    expected = expected or cause == "user"
                    await parent.pause(cause)
                assert parent._user_pause_active is expected, (
                    "Automatic pause erased an actual user request during the same unresumed episode",
                    sequence, cause,
                )
                assert child._user_pause_active is expected, ("child lost episode intent", sequence)
            # A child that missed the earlier signal must also receive current episode intent.
            if forwarded[-1][0] == "pause":
                fresh_child = AgentWorkflow()
                fresh_child._update_tree_state = AsyncMock()
                fresh_child._get_pending_child_workflow_ids = lambda: []
                await fresh_child.pause(*forwarded[-1][1:])
                assert fresh_child._user_pause_active is expected, ("late child lost episode intent", sequence)

        class Handle:
            def done(self): return False
            def cancel(self): pass
            def __await__(self):
                async def cancelled(): raise asyncio.CancelledError()
                return cancelled().__await__()

        for wf in (parent, child):
            with patch("domains.spawn_browser_agent_v3.handler.workflow.start_activity", return_value=Handle()), \
                 patch("domains.spawn_browser_agent_v3.handler.workflow.wait_condition", AsyncMock()):
                events = [e async for e in SpawnBrowserAgentManagerV3().execute_tool(wf, {"goal": "fixture"}, "call")]
            assert (events[-1].metadata.get("userPauseRequested") is True) is expected, sequence
            assert ("User paused" in events[-1].message) is expected, sequence
    print("EPISODE_ORDERING_PASS: 6 sequences, parent/child managers and late child propagation")


async def prove_pause_replay(payload):
    from datetime import datetime
    from helpers import messages
    from loop.context_utils import poll_and_update_context
    messages._send_realtime_batch = AsyncMock()
    context = payload["initial"]
    cursor = datetime.fromisoformat(context[0]["timestamp"].replace("Z", "+00:00"))
    cursor = await poll_and_update_context(AsyncMock(return_value=payload["firstPoll"]), context, cursor)
    advanced = cursor
    cursor = await poll_and_update_context(AsyncMock(return_value=payload["secondPoll"]), context, cursor)
    assert cursor == advanced
    assert len(context) == 2
    original = next(row for row in context if row["id"] == payload["initial"][0]["id"])
    assert original["metadata"]["userPause"]["reason"] == "user"
    assert original["metadata"]["errorCode"] == "ORIGINAL"
    assert original["text"].startswith(payload["originalText"])
    assert context[0]["id"] == original["id"], "original position was lost"
    await poll_and_update_context(AsyncMock(return_value=payload["secondPoll"]), context, cursor)
    assert len(context) == 2
    print("B3_CONSUMER_PASS: real late-commit rows refresh one result without cursor or ordering loss")

if __name__ == "__main__":
    payload = json.load(sys.stdin)
    if len(sys.argv) > 1 and sys.argv[1] == "replay":
        asyncio.run(prove_pause_replay(payload))
    else:
        count = asyncio.run(prove_signals(payload))
        print(f"B1_PASS: {count} actual producer signals reached workflow, child and manager")
