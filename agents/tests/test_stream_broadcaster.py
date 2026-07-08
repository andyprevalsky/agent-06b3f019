"""Unit tests for CoalescingStreamBroadcaster.

Guards the fix for the high-fan-out streaming throughput collapse (root-caused
on agent da938195): per-chunk inline Supabase broadcasts blocked token reading.
The broadcaster must (1) never block the caller (update() returns immediately
even when the broadcast is slow), (2) coalesce many deltas into far fewer
broadcasts, losing no text, and (3) flush a final done marker on close.
"""
import asyncio
import sys
import time
from types import SimpleNamespace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import helpers.messages as messages
from helpers.messages import CoalescingStreamBroadcaster


class _Recorder:
    """Stand-in for stream_assistant_chunk that records calls and is SLOW,
    so an inline-await pattern would visibly block but the broadcaster won't."""

    def __init__(self, latency_s: float = 0.05):
        self.calls = []
        self.latency_s = latency_s

    async def __call__(self, **kwargs):
        await asyncio.sleep(self.latency_s)
        self.calls.append(kwargs)

    @property
    def text(self) -> str:
        return "".join(c["delta"] for c in self.calls)

    @property
    def done_calls(self):
        return [c for c in self.calls if c.get("done")]


def _patch(monkeypatch_target: _Recorder):
    messages.stream_assistant_chunk = monkeypatch_target  # type: ignore[assignment]


def _reset_realtime_queue():
    messages._broadcast_queue.clear()
    messages._broadcast_coalesce_items.clear()
    messages._broadcast_idle_waiters.clear()
    messages._broadcast_draining = False
    messages._broadcast_flush_task = None


def test_update_is_non_blocking():
    """200 updates against a 50ms-per-broadcast sink must return near-instantly."""
    rec = _Recorder(latency_s=0.05)
    orig = messages.stream_assistant_chunk
    _patch(rec)
    try:
        async def run():
            b = CoalescingStreamBroadcaster(agent_id="a", stream_id="s", interval_s=0.02)
            start = time.monotonic()
            for i in range(200):
                b.update(f"tok{i} ", sequence=i)
            elapsed = time.monotonic() - start
            # 200 inline 50ms broadcasts would be ~10s; non-blocking must be tiny.
            assert elapsed < 0.5, f"update() blocked: {elapsed:.3f}s for 200 updates"
            await b.aclose()
            return elapsed
        asyncio.run(run())
    finally:
        messages.stream_assistant_chunk = orig


def test_stream_assistant_chunk_enqueues_without_waiting_for_supabase():
    class _SlowClient:
        def __init__(self):
            self.posts = []

        async def post(self, *args, **kwargs):
            await asyncio.sleep(0.1)
            self.posts.append((args, kwargs))
            return SimpleNamespace(status_code=200, text="")

    orig_client = messages._get_broadcast_client
    orig_config = messages.load_config
    slow_client = _SlowClient()
    _reset_realtime_queue()
    messages._get_broadcast_client = lambda: slow_client  # type: ignore[assignment]
    messages.load_config = lambda: SimpleNamespace(  # type: ignore[assignment]
        supabase=SimpleNamespace(url="https://supabase.test", service_role_key="service", anon_key="anon")
    )
    try:
        async def run():
            start = time.monotonic()
            await messages.stream_assistant_chunk(
                agent_id="a",
                stream_id="s",
                delta="hello ",
                sequence=1,
            )
            elapsed = time.monotonic() - start
            assert elapsed < 0.05, f"stream_assistant_chunk waited for Supabase: {elapsed:.3f}s"
            assert slow_client.posts == []

            await messages.stream_assistant_chunk(
                agent_id="a",
                stream_id="s",
                delta="world",
                sequence=2,
            )
            await messages.flush_realtime_broadcasts_for_tests()
            assert len(slow_client.posts) == 1
            body = slow_client.posts[0][1]["json"]
            assert body["messages"][0]["payload"]["record"]["delta"] == "hello world"
        asyncio.run(run())
    finally:
        messages._get_broadcast_client = orig_client  # type: ignore[assignment]
        messages.load_config = orig_config  # type: ignore[assignment]
        _reset_realtime_queue()


def test_coalesces_without_losing_text():
    """Many fast deltas should collapse into far fewer broadcasts, same text."""
    rec = _Recorder(latency_s=0.001)
    orig = messages.stream_assistant_chunk
    _patch(rec)
    try:
        async def run():
            b = CoalescingStreamBroadcaster(agent_id="a", stream_id="s", interval_s=0.05)
            sent = []
            for i in range(100):
                d = f"w{i} "
                sent.append(d)
                b.update(d, sequence=i)
                await asyncio.sleep(0.002)  # 100 deltas over ~0.2s
            await b.aclose(final_delta="END", final_sequence=999)
            full_sent = "".join(sent) + "END"
            # Far fewer broadcasts than updates (proves coalescing).
            assert len(rec.calls) < 30, f"expected coalescing, got {len(rec.calls)} broadcasts"
            # No text lost: concatenated broadcast deltas equal everything sent.
            assert rec.text == full_sent, f"text mismatch:\n{rec.text!r}\n{full_sent!r}"
        asyncio.run(run())
    finally:
        messages.stream_assistant_chunk = orig


def test_aclose_sends_done_marker():
    rec = _Recorder(latency_s=0.001)
    orig = messages.stream_assistant_chunk
    _patch(rec)
    try:
        async def run():
            b = CoalescingStreamBroadcaster(agent_id="a", stream_id="s", interval_s=0.05)
            b.update("hello ", sequence=1)
            await b.aclose(final_delta="bye", final_sequence=42)
            assert len(rec.done_calls) == 1, "exactly one done marker expected"
            assert rec.done_calls[0]["delta"] == "bye"
            assert rec.done_calls[0]["sequence"] == 42
        asyncio.run(run())
    finally:
        messages.stream_assistant_chunk = orig


def test_aclose_can_background_done_marker():
    rec = _Recorder(latency_s=0.1)
    orig = messages.stream_assistant_chunk
    _patch(rec)
    try:
        async def run():
            b = CoalescingStreamBroadcaster(agent_id="a", stream_id="s", interval_s=0.05)
            b.update("hello ", sequence=6)
            start = time.monotonic()
            await b.aclose(final_delta="done", final_sequence=7, await_done_broadcast=False)
            elapsed = time.monotonic() - start
            assert elapsed < 0.05, f"aclose awaited done broadcast: {elapsed:.3f}s"
            assert rec.done_calls == []
            for _ in range(20):
                if rec.done_calls:
                    break
                await asyncio.sleep(0.01)
            assert len(rec.done_calls) == 1, "background done marker was not sent"
            assert rec.text == "hello done"
            assert rec.done_calls[0]["delta"] == "done"
            assert rec.done_calls[0]["sequence"] == 7
        asyncio.run(run())
    finally:
        messages.stream_assistant_chunk = orig


def test_reset_drops_buffered_deltas():
    rec = _Recorder(latency_s=0.001)
    orig = messages.stream_assistant_chunk
    _patch(rec)
    try:
        async def run():
            b = CoalescingStreamBroadcaster(agent_id="a", stream_id="s", interval_s=0.05)
            b.update("stale", sequence=1)
            b.reset()  # parse-retry: discard partial stream
            b.update("fresh ", sequence=1)
            await b.aclose()
            assert "stale" not in rec.text, f"reset did not drop buffered delta: {rec.text!r}"
            assert "fresh " in rec.text
        asyncio.run(run())
    finally:
        messages.stream_assistant_chunk = orig


if __name__ == "__main__":
    test_update_is_non_blocking()
    test_stream_assistant_chunk_enqueues_without_waiting_for_supabase()
    test_coalesces_without_losing_text()
    test_aclose_sends_done_marker()
    test_aclose_can_background_done_marker()
    test_reset_drops_buffered_deltas()
    print("all stream-broadcaster tests passed")
