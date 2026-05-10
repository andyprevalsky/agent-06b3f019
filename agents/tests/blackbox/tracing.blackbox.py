"""Blackbox coverage for trace source keys and runtime span context."""

import asyncio
from typing import Any, Dict, List

import structlog.contextvars

from _test_utils import BlackboxResult, teardown_mock


class CapturingLogger:
    def __init__(self) -> None:
        self.events: List[Dict[str, Any]] = []

    def info(self, event: str, **metadata: Any) -> None:
        self.events.append({"event": event, **metadata})


def _patch_logger():
    from helpers import tracing

    original = tracing.logger
    fake = CapturingLogger()
    tracing.logger = fake
    return tracing, fake, original


async def test_traced_span_has_source_key_and_runtime_context():
    tracing, fake, original = _patch_logger()
    structlog.contextvars.clear_contextvars()
    try:

        @tracing.traced("unit_activity")
        async def unit_activity(agent_id: str, call_site: str, model: str) -> str:
            async with tracing.span("child_work", tool_name="demo_tool"):
                return "done"

        assert await unit_activity("agent-123", "verifier_execute", "rose-labs/test-model") == "done"

        start_events = [event for event in fake.events if event["event"] == "span.start"]
        assert len(start_events) == 2

        activity_start = start_events[0]
        assert activity_start["span_name"] == "unit_activity"
        assert activity_start["span_source"].endswith(".unit_activity")
        assert activity_start["span_key"] == f"{activity_start['span_source']}:verifier_execute"
        assert activity_start["runtime_context"] == {
            "agent_id": "agent-123",
            "call_site": "verifier_execute",
            "model": "rose-labs/test-model",
        }

        child_start = start_events[1]
        assert child_start["span_name"] == "child_work"
        assert child_start["tool_name"] == "demo_tool"
        assert child_start["runtime_context"]["agent_id"] == "agent-123"
        assert child_start["runtime_context"]["call_site"] == "verifier_execute"
        assert child_start["runtime_context"]["model"] == "rose-labs/test-model"
    finally:
        tracing.logger = original
        structlog.contextvars.clear_contextvars()


async def test_span_context_is_scoped_and_dumped_on_start_and_end():
    tracing, fake, original = _patch_logger()
    structlog.contextvars.clear_contextvars()
    try:
        with tracing.span_context(phase="execute", agent_type="root"):
            async with tracing.span("manual_work", tool_name="spawn_general_purpose_agent"):
                pass

        start_event = next(event for event in fake.events if event["event"] == "span.start")
        end_event = next(event for event in fake.events if event["event"] == "span.end")
        for event in (start_event, end_event):
            assert event["runtime_context"] == {"phase": "execute", "agent_type": "root"}
            assert event["tool_name"] == "spawn_general_purpose_agent"
            assert event["span_key"] == event["span_source"]

        assert tracing.current_span_context() == {}
    finally:
        tracing.logger = original
        structlog.contextvars.clear_contextvars()


async def test_traced_derives_phase_and_agent_type_from_loop_args():
    tracing, fake, original = _patch_logger()
    structlog.contextvars.clear_contextvars()
    try:

        @tracing.traced("run_agent")
        async def run_agent(agent_id: str, is_plan_loop: bool, call_site_override: str | None = None) -> str:
            return "done"

        assert await run_agent("agent-123", False, "explore_agent") == "done"

        start_event = next(event for event in fake.events if event["event"] == "span.start")
        assert start_event["runtime_context"]["agent_id"] == "agent-123"
        assert start_event["runtime_context"]["phase"] == "execute"
        assert start_event["runtime_context"]["call_site"] == "explore_agent"
        assert start_event["runtime_context"]["agent_type"] == "explore"
        assert start_event["span_key"] == f"{start_event['span_source']}:explore_agent"
        assert "is_plan_loop" not in start_event["runtime_context"]
        assert "call_site_override" not in start_event["runtime_context"]
    finally:
        tracing.logger = original
        structlog.contextvars.clear_contextvars()


async def test_activity_span_records_memory_snapshots():
    tracing, fake, original = _patch_logger()
    original_temporal_metadata = tracing._temporal_activity_metadata
    original_rss_snapshot = tracing._rss_snapshot
    original_sample_memory_peak = tracing._sample_memory_peak
    structlog.contextvars.clear_contextvars()
    snapshots = iter(
        [
            {"process_rss_bytes": 100, "child_rss_bytes": 10, "tree_rss_bytes": 110},
            {"process_rss_bytes": 120, "child_rss_bytes": 30, "tree_rss_bytes": 150},
            {"process_rss_bytes": 115, "child_rss_bytes": 20, "tree_rss_bytes": 135},
        ]
    )
    try:
        tracing._temporal_activity_metadata = lambda: {
            "temporal_activity_type": "unit_activity",
            "temporal_activity_id": "activity-1",
        }
        tracing._rss_snapshot = lambda: next(
            snapshots,
            {"process_rss_bytes": 115, "child_rss_bytes": 20, "tree_rss_bytes": 135},
        )

        async def fake_sample_memory_peak(_stop, peak):
            snapshot = tracing._rss_snapshot()
            for key, value in snapshot.items():
                peak[key] = max(peak.get(key, 0), value)

        tracing._sample_memory_peak = fake_sample_memory_peak

        @tracing.traced("unit_activity")
        async def unit_activity(agent_id: str) -> str:
            return "done"

        assert await unit_activity("agent-123") == "done"

        start_event = next(event for event in fake.events if event["event"] == "span.start")
        end_event = next(event for event in fake.events if event["event"] == "span.end")
        assert start_event["memory_tree_rss_start_bytes"] == 110
        assert end_event["memory_tree_rss_end_bytes"] == 135
        assert end_event["memory_tree_rss_peak_bytes"] == 150
        assert end_event["memory_tree_rss_delta_bytes"] == 25
        assert end_event["memory_tree_rss_peak_delta_bytes"] == 40
    finally:
        tracing._temporal_activity_metadata = original_temporal_metadata
        tracing._rss_snapshot = original_rss_snapshot
        tracing._sample_memory_peak = original_sample_memory_peak
        tracing.logger = original
        structlog.contextvars.clear_contextvars()


async def run_all_tests():
    print("tracing blackbox tests:")
    r = BlackboxResult()
    await r.record_async("traced_span_source_runtime_context", test_traced_span_has_source_key_and_runtime_context)
    await r.record_async("span_context_scope", test_span_context_is_scoped_and_dumped_on_start_and_end)
    await r.record_async("traced_loop_args", test_traced_derives_phase_and_agent_type_from_loop_args)
    await r.record_async("activity_span_memory_snapshots", test_activity_span_records_memory_snapshots)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
