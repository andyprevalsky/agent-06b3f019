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


def test_sanitize_runtime_value_truncates_and_caps_depth():
    from helpers import tracing

    # Long strings are truncated with a suffix noting the dropped count.
    long_str = "x" * (tracing._MAX_RUNTIME_STRING + 25)
    sanitized = tracing._sanitize_runtime_value(long_str)
    assert sanitized.startswith("x" * tracing._MAX_RUNTIME_STRING)
    assert sanitized.endswith("...[truncated 25 chars]")

    # Scalars pass through untouched.
    assert tracing._sanitize_runtime_value(None) is None
    assert tracing._sanitize_runtime_value(True) is True
    assert tracing._sanitize_runtime_value(3.5) == 3.5

    # Lists/tuples are truncated to _MAX_RUNTIME_ITEMS with a marker item.
    big_list = list(range(tracing._MAX_RUNTIME_ITEMS + 5))
    out_list = tracing._sanitize_runtime_value(big_list)
    assert len(out_list) == tracing._MAX_RUNTIME_ITEMS + 1
    assert out_list[-1] == "...[truncated 5 items]"

    # Dicts are truncated to _MAX_RUNTIME_ITEMS keys with a marker key.
    big_dict = {str(i): i for i in range(tracing._MAX_RUNTIME_ITEMS + 3)}
    out_dict = tracing._sanitize_runtime_value(big_dict)
    assert out_dict["..."] == "truncated 3 keys"

    # Depth cap collapses deeply nested structures to a type marker.
    nested = {"a": {"b": {"c": "deep"}}}
    out_nested = tracing._sanitize_runtime_value(nested)
    assert out_nested["a"]["b"] == "<dict>"

    # Arbitrary objects fall back to a truncated repr.
    class Weird:
        def __repr__(self) -> str:
            return "W" * (tracing._MAX_RUNTIME_STRING + 50)

    weird_out = tracing._sanitize_runtime_value(Weird())
    assert len(weird_out) == tracing._MAX_RUNTIME_STRING


def test_sync_span_logs_start_end_and_marks_error_status():
    tracing, fake, original = _patch_logger()
    structlog.contextvars.clear_contextvars()
    try:
        with tracing.sync_span("sync_work", tool_name="demo") as span_id:
            assert isinstance(span_id, str) and span_id

        # Error path sets status=error and re-raises.
        raised = False
        try:
            with tracing.sync_span("sync_boom"):
                raise ValueError("boom")
        except ValueError:
            raised = True
        assert raised

        ends = [e for e in fake.events if e["event"] == "span.end"]
        ok_end = next(e for e in ends if e["span_name"] == "sync_work")
        err_end = next(e for e in ends if e["span_name"] == "sync_boom")
        assert ok_end["status"] == "ok"
        assert ok_end["tool_name"] == "demo"
        assert err_end["status"] == "error"
    finally:
        tracing.logger = original
        structlog.contextvars.clear_contextvars()


def test_trace_and_rose_headers_use_context_then_fallbacks():
    from helpers import tracing

    structlog.contextvars.clear_contextvars()
    try:
        # No bound context: fallbacks are used for request/agent ids.
        headers = tracing.rose_api_headers(
            api_key="key-1",
            anon_key="anon-1",
            call_site="verifier",
            fallback_request_id="req-fallback",
            fallback_agent_id="agent-fallback",
        )
        assert headers["Authorization"] == "Bearer anon-1"
        assert headers["x-api-key"] == "key-1"
        assert headers["x-call-site"] == "verifier"
        assert headers["X-Request-Id"] == "req-fallback"
        assert headers["X-Agent-Id"] == "agent-fallback"

        assert tracing.tracing_headers() == {}
        backend = tracing.backend_api_headers("bk-key")
        assert backend["X-API-Key"] == "bk-key"
        assert backend["Content-Type"] == "application/json"

        # Bound context takes precedence over the fallbacks.
        token = tracing.bind_request_id("req-bound")
        try:
            ctx_headers = tracing.rose_api_headers(
                api_key="key-2",
                anon_key="anon-2",
                call_site="planner",
                fallback_request_id="req-fallback",
            )
            assert ctx_headers["X-Request-Id"] == "req-bound"
            assert tracing.tracing_headers()["X-Request-Id"] == "req-bound"
        finally:
            structlog.contextvars.reset_contextvars(**token)
    finally:
        structlog.contextvars.clear_contextvars()


def test_rss_snapshot_reads_process_memory_and_caches():
    from helpers import tracing

    # Reset the TTL cache so the psutil branch executes.
    tracing._rss_cache = {}
    tracing._rss_cache_at = -1e9
    snapshot = tracing._rss_snapshot()
    assert snapshot["process_rss_bytes"] > 0
    assert snapshot["tree_rss_bytes"] >= snapshot["process_rss_bytes"]

    # Second call within the TTL returns the cached object identity.
    assert tracing._rss_snapshot() is snapshot

    metadata = tracing._memory_metadata("start", snapshot)
    assert metadata["memory_process_rss_start_bytes"] == snapshot["process_rss_bytes"]


def test_temporal_activity_metadata_empty_outside_activity():
    from helpers import tracing

    # No active Temporal activity → activity.info() raises → returns {}.
    assert tracing._temporal_activity_metadata() == {}


def test_temporal_activity_metadata_collects_queue_dimensions():
    import types
    from datetime import datetime, timedelta, timezone

    import health_server
    from temporalio import activity

    from helpers import tracing

    scheduled = datetime(2026, 7, 4, 12, 0, 0, tzinfo=timezone.utc)
    started = scheduled + timedelta(milliseconds=150)
    fake_info = types.SimpleNamespace(
        current_attempt_scheduled_time=scheduled,
        scheduled_time=scheduled,
        started_time=started,
        activity_id="act-1",
        activity_type="call_llm_activity",
        attempt=2,
        task_queue="navi-agent-tasks-x",
        workflow_id="wf-1",
        workflow_run_id="run-1",
    )
    old_info = activity.info
    old_snapshot = health_server.get_queue_metrics_snapshot
    try:
        activity.info = lambda: fake_info
        health_server.get_queue_metrics_snapshot = lambda: {"active_slots": 3}
        md = tracing._temporal_activity_metadata()
        assert md["temporal_activity_id"] == "act-1"
        assert md["temporal_activity_type"] == "call_llm_activity"
        assert md["temporal_activity_attempt"] == 2
        assert md["temporal_task_queue"] == "navi-agent-tasks-x"
        assert md["temporal_workflow_run_id"] == "run-1"
        assert md["temporal_schedule_to_start_ms"] == 150
        # Queue metrics snapshot is folded in with a worker_ prefix.
        assert md["worker_active_slots_at_activity_start"] == 3
    finally:
        activity.info = old_info
        health_server.get_queue_metrics_snapshot = old_snapshot


async def run_all_tests():
    print("tracing blackbox tests:")
    r = BlackboxResult()
    await r.record_async("traced_span_source_runtime_context", test_traced_span_has_source_key_and_runtime_context)
    await r.record_async("span_context_scope", test_span_context_is_scoped_and_dumped_on_start_and_end)
    await r.record_async("traced_loop_args", test_traced_derives_phase_and_agent_type_from_loop_args)
    await r.record_async("activity_span_memory_snapshots", test_activity_span_records_memory_snapshots)
    r.record("sanitize_runtime_value_truncation", test_sanitize_runtime_value_truncates_and_caps_depth)
    r.record("sync_span_start_end_error", test_sync_span_logs_start_end_and_marks_error_status)
    r.record("trace_and_rose_headers", test_trace_and_rose_headers_use_context_then_fallbacks)
    r.record("rss_snapshot_reads_and_caches", test_rss_snapshot_reads_process_memory_and_caches)
    r.record("temporal_activity_metadata_empty", test_temporal_activity_metadata_empty_outside_activity)
    r.record("temporal_activity_metadata_queue_dims", test_temporal_activity_metadata_collects_queue_dimensions)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
