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


def test_recent_window_follows_timestamps_not_file_order():
    """Union-merged or overflow segments put older rows after newer ones on disk."""
    from benchmarks import span_history

    base = datetime(2026, 10, 1, tzinfo=timezone.utc)
    newer = [{"duration_ms": 100.0, "timestamp": (base + timedelta(hours=1, seconds=i)).isoformat()} for i in range(3)]
    older = [{"duration_ms": 9000.0, "timestamp": (base + timedelta(seconds=i)).isoformat()} for i in range(3)]
    summary = span_history.summarize_records(newer + older, window=3)
    assert summary is not None
    assert summary["count"] == 6
    assert summary["max_ms"] == 100.0, summary
    untimed_first = span_history.summarize_records([*newer, {"duration_ms": 5000.0}], window=3)
    assert untimed_first is not None and untimed_first["max_ms"] == 100.0, untimed_first


def test_default_span_history_rolls_over_before_git_blob_limit():
    import benchmarks.span_history as history

    observation = {
        "benchmark": "chat-mode",
        "environment": "local",
        "agent_id": "agent-rollover",
        "run_status": "passed",
        "span_key": "agents.helpers.llm.call_llm:execute_loop",
        "span_name": "call_llm",
        "duration_ms": 1234,
    }
    with tempfile.TemporaryDirectory() as tmp:
        original_dir = history.HISTORY_DIR
        original_file = history.HISTORY_FILE
        original_limit = history.MAX_HISTORY_FILE_BYTES
        old_env = os.environ.pop("SPAN_HISTORY_FILE", None)
        try:
            history.HISTORY_DIR = tmp
            history.HISTORY_FILE = str(Path(tmp) / "span_durations.jsonl")
            history.MAX_HISTORY_FILE_BYTES = 1
            Path(history.HISTORY_FILE).write_text("already-full\n")

            assert history.record_span_observations([observation]) == 1
            segments = sorted(Path(tmp).glob("span_durations.*.jsonl"))
            assert len(segments) == 1
            assert Path(history.HISTORY_FILE).read_text() == "already-full\n"
            assert history.load_records() == [observation]
        finally:
            history.HISTORY_DIR = original_dir
            history.HISTORY_FILE = original_file
            history.MAX_HISTORY_FILE_BYTES = original_limit
            if old_env is not None:
                os.environ["SPAN_HISTORY_FILE"] = old_env


def test_one_batch_cannot_overfill_a_span_history_segment():
    import benchmarks.span_history as history

    observations = [
        {
            "benchmark": "chat-mode",
            "environment": "local",
            "agent_id": "agent-rollover",
            "span_key": "call_llm",
            "duration_ms": 1000 + index,
        }
        for index in range(5)
    ]
    line_bytes = len((json.dumps(observations[0], sort_keys=True) + "\n").encode("utf-8"))
    with tempfile.TemporaryDirectory() as tmp:
        original_dir = history.HISTORY_DIR
        original_file = history.HISTORY_FILE
        original_limit = history.MAX_HISTORY_FILE_BYTES
        old_env = os.environ.pop("SPAN_HISTORY_FILE", None)
        try:
            history.HISTORY_DIR = tmp
            history.HISTORY_FILE = str(Path(tmp) / "span_durations.jsonl")
            history.MAX_HISTORY_FILE_BYTES = line_bytes * 2
            assert history.record_span_observations(observations) == 5
            paths = [Path(history.HISTORY_FILE), *sorted(Path(tmp).glob("span_durations.*.jsonl"))]
            assert len(paths) == 3
            assert all(path.stat().st_size <= history.MAX_HISTORY_FILE_BYTES for path in paths)
            assert history.load_records() == observations
        finally:
            history.HISTORY_DIR = original_dir
            history.HISTORY_FILE = original_file
            history.MAX_HISTORY_FILE_BYTES = original_limit
            if old_env is not None:
                os.environ["SPAN_HISTORY_FILE"] = old_env


def test_span_history_appends_to_latest_existing_segment():
    import benchmarks.span_history as history

    date_key = datetime.now(timezone.utc).strftime("%Y%m%d")
    observations = [
        {"benchmark": "chat-mode", "span_key": "call_llm", "duration_ms": 1000 + index}
        for index in range(3)
    ]
    line_bytes = len((json.dumps(observations[0], sort_keys=True) + "\n").encode("utf-8"))
    with tempfile.TemporaryDirectory() as tmp:
        original_dir = history.HISTORY_DIR
        original_file = history.HISTORY_FILE
        original_limit = history.MAX_HISTORY_FILE_BYTES
        old_env = os.environ.pop("SPAN_HISTORY_FILE", None)
        try:
            history.HISTORY_DIR = tmp
            history.HISTORY_FILE = str(Path(tmp) / "span_durations.jsonl")
            history.MAX_HISTORY_FILE_BYTES = line_bytes * 2
            Path(history.HISTORY_FILE).write_text("already-full\n" * (line_bytes * 2))
            first = Path(tmp) / f"span_durations.{date_key}.jsonl"
            second = Path(tmp) / f"span_durations.{date_key}.02.jsonl"
            first.write_text(json.dumps(observations[0], sort_keys=True) + "\n")
            second.write_text(json.dumps(observations[1], sort_keys=True) + "\n")

            assert history.record_span_observations([observations[2]]) == 1
            assert first.read_text().count("\n") == 1
            assert second.read_text().count("\n") == 2
            assert history.load_records() == observations
        finally:
            history.HISTORY_DIR = original_dir
            history.HISTORY_FILE = original_file
            history.MAX_HISTORY_FILE_BYTES = original_limit
            if old_env is not None:
                os.environ["SPAN_HISTORY_FILE"] = old_env


def _init_history_repo(path: str, branch: str) -> None:
    import subprocess

    subprocess.run(["git", "init", "-q", path], check=True)
    subprocess.run(["git", "symbolic-ref", "HEAD", f"refs/heads/{branch}"], cwd=path, check=True)


def test_concurrent_branches_roll_into_separate_segments():
    """A union merge of two branches' appends to one segment can exceed the blob cap each side respected."""
    import subprocess

    import benchmarks.span_history as history

    def observation(agent_id: str) -> dict:
        return {
            "benchmark": "chat-mode",
            "environment": "local",
            "agent_id": agent_id,
            "run_status": "passed",
            "span_key": "agents.helpers.llm.call_llm:execute_loop",
            "span_name": "call_llm",
            "duration_ms": 1234,
        }

    with tempfile.TemporaryDirectory() as tmp:
        original_dir = history.HISTORY_DIR
        original_file = history.HISTORY_FILE
        original_limit = history.MAX_HISTORY_FILE_BYTES
        old_env = os.environ.pop("SPAN_HISTORY_FILE", None)
        try:
            _init_history_repo(tmp, "feature/A_one")
            history.HISTORY_DIR = tmp
            history.HISTORY_FILE = str(Path(tmp) / "span_durations.jsonl")
            history.MAX_HISTORY_FILE_BYTES = 1
            Path(history.HISTORY_FILE).write_text("already-full\n")
            date_key = datetime.now(timezone.utc).strftime("%Y%m%d")

            assert history.record_span_observations([observation("agent-a")]) == 1
            subprocess.run(["git", "symbolic-ref", "HEAD", "refs/heads/other/b"], cwd=tmp, check=True)
            assert history.record_span_observations([observation("agent-b")]) == 1
            assert history.record_span_observations([observation("agent-b2")]) == 1

            segments = sorted(path.name for path in Path(tmp).glob("span_durations.*.jsonl"))
            assert segments == [
                f"span_durations.{date_key}.feature-a-one.jsonl",
                f"span_durations.{date_key}.other-b.02.jsonl",
                f"span_durations.{date_key}.other-b.jsonl",
            ], segments
            assert sorted(record["agent_id"] for record in history.load_records()) == [
                "agent-a",
                "agent-b",
                "agent-b2",
            ]

            Path(tmp, ".git", "HEAD").write_text("1" * 40 + "\n")
            assert Path(history._append_history_path()).name == f"span_durations.{date_key}.jsonl"
        finally:
            history.HISTORY_DIR = original_dir
            history.HISTORY_FILE = original_file
            history.MAX_HISTORY_FILE_BYTES = original_limit
            if old_env is not None:
                os.environ["SPAN_HISTORY_FILE"] = old_env


def test_every_history_ledger_fits_under_github_blob_limit():
    import benchmarks.span_history as history

    github_blob_limit = 100 * 1024 * 1024
    oversized = {
        path.name: path.stat().st_size
        for path in Path(history.HISTORY_DIR).glob("*.jsonl")
        if path.stat().st_size >= github_blob_limit
    }
    assert not oversized, f"history ledgers GitHub will reject on push: {oversized}"


def test_every_tracked_history_ledger_is_union_merged():
    """Concurrent branches append rows to the same ledger tail, so a text merge conflicts at EOF."""
    import subprocess

    import benchmarks.span_history as history
    import benchmarks.timeout_history as timeouts

    from benchmarks import history_ledger

    ledger_names = {
        Path(history.HISTORY_FILE).name,
        Path(timeouts.HISTORY_FILE).name,
        Path(timeouts.ATTEMPTS_FILE).name,
        # Per-writer shards of the attempts/durations ledgers (history_ledger.py).
        Path(history_ledger.shard_path(timeouts.HISTORY_FILE, writer="feature-a")).name,
        Path(history_ledger.shard_path(timeouts.ATTEMPTS_FILE, writer="feature-a")).name,
    }
    with tempfile.TemporaryDirectory() as tmp:
        original_dir = history.HISTORY_DIR
        original_file = history.HISTORY_FILE
        original_limit = history.MAX_HISTORY_FILE_BYTES
        old_env = os.environ.pop("SPAN_HISTORY_FILE", None)
        try:
            _init_history_repo(tmp, "feature/a")
            history.HISTORY_DIR = tmp
            history.HISTORY_FILE = str(Path(tmp) / "span_durations.jsonl")
            history.MAX_HISTORY_FILE_BYTES = 1
            Path(history.HISTORY_FILE).write_text("already-full\n")
            for _ in range(2):
                segment = Path(history._append_history_path())
                ledger_names.add(segment.name)
                segment.write_text("already-full\n")
        finally:
            history.HISTORY_DIR = original_dir
            history.HISTORY_FILE = original_file
            history.MAX_HISTORY_FILE_BYTES = original_limit
            if old_env is not None:
                os.environ["SPAN_HISTORY_FILE"] = old_env

    history_dir = Path(history.HISTORY_DIR).resolve()
    repo_root = Path(
        subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=history_dir,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    )
    relative_dir = history_dir.relative_to(repo_root)
    paths = [str(relative_dir / name) for name in sorted(ledger_names)]
    attrs = subprocess.run(
        ["git", "check-attr", "merge", "--", *paths],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()

    assert len(paths) == 7, paths
    not_union = [line for line in attrs if not line.endswith(": merge: union")]
    assert not not_union, f"history ledgers without merge=union in .gitattributes: {not_union}"


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
            "model": "rose-labs/rose-1-flash",
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


def test_agent_latency_decodes_span_history_once_for_all_baselines():
    """One latency report must scan the history ledger only once.

    The ecommerce Epoch 9 history held 241,740 rows / 77 MB. Looking up each
    unique span key with a separate full-ledger scan kept agent_latency.py
    CPU-bound beyond its 180-second diagnostic budget.
    """
    import benchmarks.span_history as history
    from benchmarks.agent_latency import _span_baseline_map

    span_keys = ["span-key-a", "span-key-b", "span-key-c"]
    observations = [
        {
            "benchmark": "browser-imax-group-tickets",
            "environment": "local",
            "agent_id": "agent-a",
            "run_status": "passed",
            "span_key": span_key,
            "span_name": span_key,
            "duration_ms": 1000,
        }
        for span_key in span_keys
    ]

    with tempfile.TemporaryDirectory() as tmp:
        history_file = str(Path(tmp) / "span_durations.jsonl")
        rows = [{**observations[index % len(observations)], "duration_ms": 1000 + index} for index in range(90)]
        history.record_span_observations(rows, history_file=history_file)

        old_history_file = os.environ.get("SPAN_HISTORY_FILE")
        original_loads = history.json.loads
        decode_count = 0

        def counted_loads(value):
            nonlocal decode_count
            decode_count += 1
            return original_loads(value)

        try:
            os.environ["SPAN_HISTORY_FILE"] = history_file
            history.json.loads = counted_loads
            baselines = _span_baseline_map(
                observations,
                benchmark="browser-imax-group-tickets",
                environment="local",
                min_samples=20,
            )
        finally:
            history.json.loads = original_loads
            if old_history_file is None:
                os.environ.pop("SPAN_HISTORY_FILE", None)
            else:
                os.environ["SPAN_HISTORY_FILE"] = old_history_file

    assert set(baselines) == set(span_keys)
    assert decode_count == len(rows), "span history was decoded once per unique span key"


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
    r.record("recent_window_follows_timestamps", test_recent_window_follows_timestamps_not_file_order)
    r.record("default_history_rollover", test_default_span_history_rolls_over_before_git_blob_limit)
    r.record("batch_history_rollover", test_one_batch_cannot_overfill_a_span_history_segment)
    r.record("latest_segment_append", test_span_history_appends_to_latest_existing_segment)
    r.record("history_ledgers_union_merged", test_every_tracked_history_ledger_is_union_merged)
    r.record("branches_roll_into_separate_segments", test_concurrent_branches_roll_into_separate_segments)
    r.record("history_ledgers_fit_github_blob_limit", test_every_history_ledger_fits_under_github_blob_limit)
    r.record("compare_marks_regression", test_compare_observations_marks_regression)
    r.record("record_from_embedded_logs", test_agent_latency_records_span_history_from_embedded_logs)
    r.record("parse_nested_fly_clickhouse_json", test_agent_latency_parses_nested_fly_clickhouse_json)
    r.record("inline_baseline_requires_20_samples", test_agent_latency_inline_baseline_requires_20_samples)
    r.record(
        "latency_decodes_span_history_once",
        test_agent_latency_decodes_span_history_once_for_all_baselines,
    )
    r.record("latency_handles_events_without_spans", test_agent_latency_handles_events_without_reconstructed_spans)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
