"""Blackbox tests for benchmark span-duration history."""

import asyncio
import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from _test_utils import BlackboxResult, teardown_mock


def test_record_and_summarize_span_history():
    from benchmarks.span_history import load_records, record_span_observations, summary

    with tempfile.TemporaryDirectory() as tmp:
        history_file = str(Path(tmp) / "span_durations.jsonl")
        observations = [
            {
                "benchmark": "chat-mode",
                "environment": "local",
                "agent_id": "agent-a",
                "run_status": "passed",
                "span_key": "agents.helpers.llm.call_llm:execute_loop",
                "span_name": "call_llm",
                "duration_ms": duration,
            }
            for duration in [1000, 1100, 1200, 1300, 1400]
        ]

        assert record_span_observations(observations, history_file=history_file) == 5
        records = load_records(
            benchmark="chat-mode",
            environment="local",
            span_key="agents.helpers.llm.call_llm:execute_loop",
            history_file=history_file,
        )
        assert len(records) == 5

        stats = summary(
            "agents.helpers.llm.call_llm:execute_loop",
            benchmark="chat-mode",
            environment="local",
            history_file=history_file,
        )
        assert stats == {
            "count": 5,
            "recent_count": 5,
            "p50_ms": 1200.0,
            "p90_ms": 1400.0,
            "p95_ms": 1400.0,
            "max_ms": 1400.0,
        }


def test_compare_observations_marks_regression():
    from benchmarks.span_history import compare_observations, record_span_observations

    with tempfile.TemporaryDirectory() as tmp:
        history_file = str(Path(tmp) / "span_durations.jsonl")
        base = {
            "benchmark": "chat-mode",
            "environment": "local",
            "agent_id": "agent-a",
            "run_status": "passed",
            "span_key": "agents.helpers.llm.check_progress:verifier_execute",
            "span_name": "check_progress",
        }
        record_span_observations(
            [{**base, "duration_ms": duration} for duration in [1000, 1100, 1200, 1300, 1400]],
            history_file=history_file,
        )

        rows = compare_observations(
            [{**base, "duration_ms": 4000}],
            benchmark="chat-mode",
            environment="local",
            min_samples=5,
            history_file=history_file,
        )

        assert len(rows) == 1
        assert rows[0]["is_regression"] is True
        assert rows[0]["p95_ms"] == 1400.0
        assert rows[0]["delta_vs_p95_ms"] == 2600.0
        assert rows[0]["ratio_vs_p95"] == 2.86


def test_agent_latency_records_span_history_from_embedded_logs():
    from benchmarks.agent_latency import record_span_history_from_logs
    from benchmarks.span_history import load_records

    agent_id = "11111111-1111-4111-8111-111111111111"
    start = {
        "timestamp": "2026-05-09T12:00:00Z",
        "event": "span.start",
        "agent_id": agent_id,
        "span_id": "span-a",
        "span_name": "call_llm",
        "span_key": "agents.helpers.llm.call_llm:execute_loop",
        "span_source": "agents.helpers.llm.call_llm",
        "runtime_context": {
            "phase": "execute",
            "agent_type": "root",
            "call_site": "execute_loop",
            "model": "rose-labs/rose-1-lite",
        },
    }
    end = {
        **start,
        "timestamp": "2026-05-09T12:00:02Z",
        "event": "span.end",
        "duration_ms": 2000,
        "status": "ok",
    }

    with tempfile.TemporaryDirectory() as tmp:
        history_file = str(Path(tmp) / "span_durations.jsonl")
        old = os.environ.get("SPAN_HISTORY_FILE")
        os.environ["SPAN_HISTORY_FILE"] = history_file
        try:
            count = record_span_history_from_logs(
                agent_id=agent_id,
                logs={"worker_logs": [json.dumps(start), json.dumps(end)]},
                benchmark="chat-mode",
                environment="local",
                timestamp="2026-05-09T12:00:03Z",
                run_status="passed",
            )
            assert count == 1
            records = load_records(history_file=history_file)
            assert len(records) == 1
            assert records[0]["span_key"] == "agents.helpers.llm.call_llm:execute_loop"
            assert records[0]["duration_ms"] == 2000.0
            assert records[0]["phase"] == "execute"
            assert records[0]["call_site"] == "execute_loop"
        finally:
            if old is None:
                os.environ.pop("SPAN_HISTORY_FILE", None)
            else:
                os.environ["SPAN_HISTORY_FILE"] = old


def test_agent_latency_parses_nested_fly_clickhouse_json():
    from benchmarks.agent_latency import _event_agent_id, _parse_fly_line_to_raw_event

    agent_id = "11111111-1111-4111-8111-111111111111"
    inner = {
        "timestamp": "2026-06-26T03:17:48.651205Z",
        "event": "span.start",
        "agent_id": agent_id,
        "span_id": "abc123",
        "parent_span_id": "parent123",
        "span_name": "call_llm",
    }
    outer = {
        "event": {"provider": "app"},
        "fly": {"app": {"name": "navi-whisper-lux"}},
        "host": "ef14",
        "message": json.dumps(inner),
        "timestamp": "2026-06-26T03:17:48.651205221Z",
    }

    event = _parse_fly_line_to_raw_event(json.dumps(outer))

    assert event is not None
    assert event.event == "span.start"
    assert event.data["span_name"] == "call_llm"
    assert event.data["span_id"] == "abc123"
    assert event.data["fly_host"] == "ef14"
    assert _event_agent_id(event) == agent_id


def test_agent_latency_inline_baseline_requires_20_samples():
    from benchmarks.agent_latency import Span, _format_span_baseline, _span_baseline_map
    from benchmarks.span_history import record_span_observations

    span_key = "agents.helpers.llm.call_llm:execute_loop"
    observation = {
        "benchmark": "chat-mode",
        "environment": "local",
        "agent_id": "agent-a",
        "run_status": "passed",
        "span_key": span_key,
        "span_name": "call_llm",
        "duration_ms": 1000,
    }
    current = {**observation, "duration_ms": 2000}

    with tempfile.TemporaryDirectory() as tmp:
        history_file = str(Path(tmp) / "span_durations.jsonl")
        old = os.environ.get("SPAN_HISTORY_FILE")
        os.environ["SPAN_HISTORY_FILE"] = history_file
        try:
            record_span_observations([observation for _ in range(19)], history_file=history_file)
            assert _span_baseline_map([current], benchmark="chat-mode", environment="local", min_samples=20) == {}

            record_span_observations([observation], history_file=history_file)
            baselines = _span_baseline_map([current], benchmark="chat-mode", environment="local", min_samples=20)
            assert span_key in baselines

            now = datetime.now(timezone.utc)
            span = Span(
                span_id="span-a",
                parent_span_id=None,
                name="call_llm",
                source="worker",
                start=now,
                end=now,
                agent_id="agent-a",
                metadata={"span_key": span_key},
            )
            span.end = span.start + timedelta(milliseconds=2000)
            rendered = _format_span_baseline(span, baselines, color=False)
            # 2000ms vs p95 1000ms → flagged out-of-band at 2.0× p95.
            assert "OUT-OF-BAND" in rendered
            assert "2.0× p95" in rendered
            assert "hist p50=1.00s p90=1.00s p95=1.00s max=1.00s n=20" in rendered
        finally:
            if old is None:
                os.environ.pop("SPAN_HISTORY_FILE", None)
            else:
                os.environ["SPAN_HISTORY_FILE"] = old


def test_agent_latency_handles_events_without_reconstructed_spans():
    from benchmarks.agent_latency import (
        _RawEvent,
        _build_trace_from_events,
        _render_executive_summary,
        _render_tree,
        parse_ts,
    )

    event = _RawEvent(
        ts=parse_ts("2026-05-09T12:00:00Z"),
        source="worker",
        event="agent.deleted.trace.retained",
        data={
            "timestamp": "2026-05-09T12:00:00Z",
            "event": "agent.deleted.trace.retained",
            "agent_id": "11111111-1111-4111-8111-111111111111",
        },
    )

    roots, t0, t1, stats = _build_trace_from_events([event], [], [], set())

    assert roots == []
    assert t0 == event.ts
    assert t1 == event.ts
    assert stats["span_count"] == 0

    summary = _render_executive_summary(
        "11111111-1111-4111-8111-111111111111",
        roots,
        t0,
        t1,
        stats,
        {},
        300,
        False,
        {},
    )
    tree = _render_tree(roots, t0, {}, {}, False, 5.0, False)

    assert "log events found, but no span or legacy timing windows were reconstructed" in summary
    assert "(no spans reconstructed from retained log events)" in tree


async def run_all_tests():
    print("span-history blackbox tests:")
    r = BlackboxResult()
    r.record("record_and_summarize", test_record_and_summarize_span_history)
    r.record("compare_marks_regression", test_compare_observations_marks_regression)
    r.record("record_from_embedded_logs", test_agent_latency_records_span_history_from_embedded_logs)
    r.record("parse_nested_fly_clickhouse_json", test_agent_latency_parses_nested_fly_clickhouse_json)
    r.record("inline_baseline_requires_20_samples", test_agent_latency_inline_baseline_requires_20_samples)
    r.record("latency_handles_events_without_spans", test_agent_latency_handles_events_without_reconstructed_spans)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
