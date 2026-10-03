"""Keep independently owned benchmark occurrences in distinct result records."""

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from benchmarks import results


def test_independent_runs_keep_distinct_records():
    """Same task, same second: writing another run must preserve the first bytes."""
    instant = datetime(2026, 9, 12, 6, 0, 0, tzinfo=timezone.utc)
    suites = (
        "agent-payment-setup-resume",
        ",".join(f"browser-repeated-long-task-name-{i:02d}" for i in range(14)),
        "browser-" + "世界" * 80,
    )
    for suite in suites:
        runs = [
            results.BenchmarkRun(
                suite=suite,
                task_results=[
                    results.TaskResult(
                        name="agent-payment-setup-resume",
                        passed=passed,
                        agent_id=f"fixture-root-{ordinal}",
                        status="PASSED" if passed else "FAILED",
                        progress_score=100 if passed else 0,
                        duration_seconds=1,
                        cost_cents=0,
                        message_count=0,
                    )
                ],
            )
            for ordinal, passed in enumerate((True, False))
        ]
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(results, "datetime") as clock,
            patch.object(results.BenchmarkRun, "_record_history") as history,
            patch.object(results.BenchmarkRun, "_upload_to_hub") as hub,
        ):
            clock.now.return_value = instant
            first = Path(runs[0].save(directory))
            original = first.read_bytes()
            second = Path(runs[1].save(directory))
            assert first != second, "independent same-task runs share a result record"
            assert first.read_bytes() == original, "later save overwrote the first run's evidence"
            for path, run in zip((first, second), runs):
                payload = json.loads(path.read_bytes())
                assert payload["run_id"] == run.run_id
                assert payload["suite"] == suite
                assert payload["tasks"][0]["agent_id"] == run.task_results[0].agent_id
                assert payload["tasks"][0]["passed"] == run.task_results[0].passed
                assert len(path.name.encode()) <= results.MAX_RUN_RECORD_BASENAME_BYTES
            assert history.call_count == hub.call_count == 2
