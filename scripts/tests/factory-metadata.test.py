"""End-to-end preservation and validation of factory execution metadata."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from deploy_stage import append_stage, init_run
from factory_ledger import encode_rows, event_rows, pending_rows, stage_rows
from factory_metadata import load_metadata, normalize_metadata


def sample():
    return {
        "observed_at": "2026-10-28T02:35:09Z",
        "execution": {"model": "test-model", "reasoning_effort": "medium"},
        "usage": {"input_tokens": 100, "cached_input_tokens": 40, "output_tokens": 12},
        "evidence": {
            k: "fixture receipt"
            for k in (
                "execution.model",
                "execution.reasoning_effort",
                "usage.input_tokens",
                "usage.cached_input_tokens",
                "usage.output_tokens",
            )
        },
    }


class FactoryMetadataTest(unittest.TestCase):
    def test_unknown_is_not_zero_or_guessed_configuration(self):
        with patch.dict(os.environ, {}, clear=True):
            value = load_metadata()
        self.assertIsNone(value["execution"]["model"])
        self.assertIsNone(value["usage"]["input_tokens"])
        self.assertIsNone(value["execution"]["service_tier"])

    def test_invalid_or_unsupported_metadata_fails_closed(self):
        variants = [
            {"api_key": "must not be copied"},
            {"execution": {"secret": "unsupported"}},
            {"execution": {"model": "unproven"}},
            {**sample(), "observed_at": "2026-10-28"},
            {**sample(), "usage": {"input_tokens": -1}},
            {**sample(), "usage": {"input_tokens": True}},
            {**sample(), "usage": {"input_tokens": 1.5}},
            {**sample(), "usage": {"input_tokens": 10, "cached_input_tokens": 20}},
            {**sample(), "usage": {"cost_usd": float("nan")}},
        ]
        for value in variants:
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_metadata(value)

    def test_cli_publication_preserves_metadata_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata = root / "input.json"
            metadata.write_text(json.dumps(sample()))
            env = {
                **os.environ,
                "FACTORY_EVENT_LOG": str(root / "factory-events.jsonl"),
            }
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/record_factory_event.py"),
                    "deploy",
                    "metadata",
                    "snapshot",
                    "--metadata-file",
                    str(metadata),
                ],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertIn("FACTORY_EVENT", result.stdout)
            records = list(event_rows(root))
            self.assertEqual(
                records[0]["telemetry"]["execution"]["model"], "test-model"
            )
            self.assertIsNone(records[0]["telemetry"]["execution"]["service_tier"])
            published = encode_rows(pending_rows("", [root]))
            self.assertEqual(pending_rows(published, [root]), [])
            # Historical enrichment is a new event; old outcome remains immutable.
            old = (
                json.dumps(
                    {
                        "kind": "factory-event",
                        "workflow": "deploy",
                        "event": "outcome",
                        "value": "blocked",
                        "recorded_epoch": 1,
                        "workspace": "old",
                    }
                )
                + "\n"
            )
            self.assertEqual(len(pending_rows(old, [root])), 1)

    def test_distinct_snapshots_at_same_timestamp_are_not_dropped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = {
                "workflow": "deploy",
                "event": "metadata",
                "value": "snapshot",
                "recorded_epoch": 1,
                "workspace": "fixture",
            }
            first = {**base, "telemetry": normalize_metadata(sample())}
            changed = sample()
            changed["execution"]["reasoning_effort"] = "xhigh"
            second = {**base, "telemetry": normalize_metadata(changed)}
            (root / "factory-events.jsonl").write_text(
                json.dumps(first) + "\n" + json.dumps(second) + "\n"
            )
            pending = pending_rows("", [root])
            self.assertEqual(len(pending), 2)
            self.assertEqual(pending_rows(encode_rows(pending), [root]), [])

    def test_per_stage_snapshot_beats_run_defaults_and_legacy_still_loads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = root / "deploy-runs/test"
            metadata = root / "input.json"
            metadata.write_text(json.dumps(sample()))
            with patch.dict(os.environ, {"FACTORY_METADATA_FILE": str(metadata)}):
                init_run(
                    run,
                    run_id="test",
                    started_at="a",
                    started_epoch=1,
                    git_sha="sha",
                    branch="branch",
                )
                captured = load_metadata()
                metadata.write_text("{}")
                append_stage(
                    run,
                    run_id="test",
                    stage="test",
                    started_at="a",
                    finished_at="b",
                    started_epoch=1,
                    finished_epoch=2,
                    exit_code=0,
                    log="logs/test.log",
                    telemetry=captured,
                )
            record = next(iter(stage_rows(root)))
            self.assertEqual(record["telemetry"]["execution"]["model"], "test-model")
            self.assertEqual(len(pending_rows("", [root])), 1)
            raw = json.loads((run / "stages.jsonl").read_text())
            raw.pop("telemetry")
            (run / "stages.jsonl").write_text(json.dumps(raw) + "\n")
            original = json.loads((run / "metadata.json").read_text())
            original.pop("telemetry")
            (run / "metadata.json").write_text(json.dumps(original))
            self.assertIsNone(next(iter(stage_rows(root)))["telemetry"])

    def test_real_stage_captures_before_command_and_rejects_bad_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "input.json"
            path.write_text(json.dumps(sample()))
            env = {
                **os.environ,
                "FACTORY_METADATA_FILE": str(path),
                "DEPLOY_RUN_ROOT": str(root / "deploy-runs"),
            }
            wrapper = str(ROOT / "scripts/run-deploy-stage")
            subprocess.run(
                ["bash", wrapper, "--start", "--run-id", "real"],
                env=env,
                check=True,
                capture_output=True,
            )
            subprocess.run(
                [
                    "bash",
                    wrapper,
                    "mutate",
                    "--",
                    sys.executable,
                    "-c",
                    "from pathlib import Path; import sys; Path(sys.argv[1]).write_text('{}')",
                    str(path),
                ],
                env=env,
                check=True,
                capture_output=True,
            )
            stage = next(iter(stage_rows(root)))
            self.assertEqual(stage["telemetry"]["execution"]["model"], "test-model")
            marker = root / "should-not-run"
            path.write_text('{"unknown_secret":"must-not-leak"}')
            failed = subprocess.run(
                ["bash", wrapper, "invalid", "--", "touch", str(marker)],
                env=env,
                check=False,
                capture_output=True,
            )
            self.assertNotEqual(failed.returncode, 0)
            self.assertFalse(marker.exists())
            self.assertNotIn(b"must-not-leak", failed.stderr)
            self.assertEqual(len(list(stage_rows(root))), 1)

    def test_invalid_selected_file_prevents_event_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "input.json"
            path.write_text('{"api_key":"private-value"}')
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/record_factory_event.py"),
                    "deploy",
                    "metadata",
                    "snapshot",
                    "--metadata-file",
                    str(path),
                ],
                env={**os.environ, "FACTORY_EVENT_LOG": str(root / "events.jsonl")},
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "events.jsonl").exists())
            self.assertNotIn("private-value", result.stderr)


class FactoryDetailTest(unittest.TestCase):
    """Bounded outcome/retry/reuse/timing/source detail on stage and event rows."""

    def test_log_scan_extracts_bounded_failures_and_counts(self):
        from factory_detail import MAX_NAMES, outcome_detail

        pytest_log = "".join(f"FAILED tests/test_a.py::test_{i} - boom\n" for i in range(15))
        pytest_log += "==== 15 failed, 40 passed in 3.2s ====\n"
        detail = outcome_detail(1, pytest_log)
        self.assertEqual(detail["failure_class"], "test-failure")
        self.assertEqual(len(detail["failing"]), MAX_NAMES)
        self.assertEqual(detail["failing"][0], "tests/test_a.py::test_0")
        self.assertEqual((detail["failed_count"], detail["passed_count"], detail["total_count"]), (15, 40, 55))
        gates = outcome_detail(1, "== eslint: exit=1 duration=2s ==\nfailed deploy structural gates: eslint, factory-review\n")
        self.assertEqual(gates["failing"], ["eslint", "factory-review"])
        results = outcome_detail(1, "RESULTS: 40/42 passed\nTOTAL SELECTED: 7 / 20\n")
        self.assertEqual((results["failed_count"], results["total_count"]), (2, 42))
        self.assertEqual((results["selected_count"], results["selectable_total"]), (7, 20))
        self.assertEqual(outcome_detail(1, "write: ENOSPC no space")["failure_class"], "disk-full")
        self.assertEqual(outcome_detail(127, "")["failure_class"], "missing-dependency")
        self.assertEqual(outcome_detail(143, "")["failure_class"], "signal-15")
        self.assertEqual(outcome_detail(124, "")["failure_class"], "timeout")
        passed = outcome_detail(0, "FAILED tests/x.py::flaky_then_retried\n")
        self.assertIsNone(passed["failure_class"])
        self.assertNotIn("failing", passed)

    def test_names_never_copy_secrets_or_unbounded_text(self):
        from factory_detail import MAX_TEXT, safe_text, scan_log

        token = "sk_live_" + "A1b2C3d4" * 6
        self.assertIsNone(safe_text(token))
        self.assertIsNone(safe_text("Authorization: Bearer $TOKEN"))
        self.assertIsNone(safe_text("ghp_" + "Ab1" * 12))
        long_test = "tests/test_attempt_ledger_records_run_id_and_outcome_class_for_every_retry"
        self.assertEqual(safe_text(long_test), long_test)
        self.assertEqual(safe_text("0123456789abcdef0123456789abcdef01234567"), "0123456789abcdef0123456789abcdef01234567")
        self.assertLessEqual(len(safe_text("x " * 400)), MAX_TEXT)
        scanned = scan_log(f"FAILED tests/t.py::test_k[{token}]\nFAILED tests/t.py::ok\n")
        self.assertEqual(scanned["failing"], ["tests/t.py::ok"])

    def test_event_detail_allowlist_fails_closed(self):
        from factory_detail import DetailError, parse_event_detail

        detail = parse_event_detail(["provider=coderabbit", "pr_number=12", "failing=a,b", "fix_sha=abc1234"])
        self.assertEqual(detail["schema_version"], 1)
        self.assertEqual(detail["failing"], ["a", "b"])
        self.assertEqual(parse_event_detail([]), {})
        for bad in (["api_key=x"], ["pr_number=-1"], ["pr_number=1.5"], ["fix_sha=main"],
                    ["reason=" + "Z9" * 30], ["duration_seconds=nan"], ["noequals"]):
            with self.subTest(bad=bad), self.assertRaises(DetailError):
                parse_event_detail(bad)

    def test_retry_cause_distinguishes_fix_commit_edit_and_unchanged_rerun(self):
        from factory_detail import attempt_detail

        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            self.assertEqual(attempt_detail(run_dir, "lint", {"sha": "a" * 40}), {"attempt": 1})
            prior = {"stage": "lint", "status": "failed", "started_epoch": 1, "started_at": "t1",
                     "detail": {"source": {"sha": "a" * 40, "dirty_digest": "d1"}}}
            (run_dir / "stages.jsonl").write_text(
                json.dumps(prior) + "\n" + json.dumps({**prior, "status": "reused", "started_epoch": 2}) + "\n"
            )
            fixed = attempt_detail(run_dir, "lint", {"sha": "b" * 40})
            self.assertEqual((fixed["attempt"], fixed["retry_cause"], fixed["fix_sha"]), (2, "new-commit", "b" * 40))
            self.assertEqual(fixed["prior_status"], "failed")
            edited = attempt_detail(run_dir, "lint", {"sha": "a" * 40, "dirty_digest": "d2"})
            self.assertEqual(edited["retry_cause"], "worktree-edit")
            same = attempt_detail(run_dir, "lint", {"sha": "a" * 40, "dirty_digest": "d1"})
            self.assertEqual(same["retry_cause"], "unchanged-source")

    def test_stage_runner_records_detail_reuse_and_publishes_it(self):
        wrapper = str(ROOT / "scripts/run-deploy-stage")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = {**os.environ, "DEPLOY_RUN_ROOT": str(root / "deploy-runs")}
            env.pop("FACTORY_METADATA_FILE", None)

            def stage(*command, check=True):
                return subprocess.run(["bash", wrapper, *command], env=env, cwd=ROOT,
                                      capture_output=True, text=True, check=check)

            stage("--start", "--run-id", "detail")
            failing = stage("unit", "--reuse-passed", "--", "bash", "-c",
                            "echo 'FAILED tests/t.py::test_x - assert'; echo '== 1 failed, 2 passed in 0.1s =='; exit 1",
                            check=False)
            self.assertEqual(failing.returncode, 1)
            queued = {**env, "FACTORY_STAGE_QUEUED_EPOCH": "1"}
            env = queued
            stage("unit", "--reuse-passed", "--", "true")
            reused = stage("unit", "--reuse-passed", "--", "true")
            self.assertIn("reused passed deploy stage", reused.stdout)
            stage("--finish")
            rows = [json.loads(line) for line in (root / "deploy-runs/detail/stages.jsonl").read_text().splitlines()]
            self.assertEqual([row["status"] for row in rows], ["failed", "passed", "reused"])
            failed, passed, hit = (row["detail"] for row in rows)
            self.assertEqual(failed["schema_version"], 1)
            self.assertEqual(failed["outcome"]["failure_class"], "test-failure")
            self.assertEqual(failed["outcome"]["failing"], ["tests/t.py::test_x"])
            self.assertEqual(failed["reuse"]["miss_reason"], "no-prior-pass")
            self.assertEqual(passed["attempt"]["attempt"], 2)
            self.assertIn(passed["attempt"]["retry_cause"], {"unchanged-source", "worktree-edit"})
            self.assertTrue(hit["reuse"]["hit"])
            for detail in (failed, passed):
                self.assertGreaterEqual(detail["timing"]["exec_seconds"], 0.0)
                self.assertGreaterEqual(detail["timing"]["setup_seconds"], 0.0)
                self.assertEqual(detail["timing"]["concurrent_stages"], 0)
                self.assertGreater(detail["host"]["cpu_count"], 0)
                self.assertRegex(detail["source"]["sha"], r"^[0-9a-f]{40}$")
                self.assertIn("lanes", detail["source"])
            # Queue wait is reported only when the caller exported its queue start.
            self.assertNotIn("queue_seconds", failed["timing"])
            self.assertGreater(passed["timing"]["queue_seconds"], 0)
            published = list(stage_rows(root))
            self.assertEqual([row.get("detail") is not None for row in published], [True, True, True])
            self.assertEqual(published[2]["status"], "reused")

    def test_event_cli_detail_is_published_and_old_rows_stay_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = {**os.environ, "FACTORY_EVENT_LOG": str(root / "factory-events.jsonl")}
            recorder = str(ROOT / "scripts/record_factory_event.py")
            subprocess.run([sys.executable, recorder, "deploy", "review-request", "coderabbit",
                            "--detail", "pr_number=7"], env=env, check=True, capture_output=True)
            subprocess.run([sys.executable, recorder, "rca", "repro-attempt", "reproduced",
                            "--detail", "repro_attempt=1"], env=env, check=True, capture_output=True)
            subprocess.run([sys.executable, recorder, "deploy", "outcome", "completed"],
                           env=env, check=True, capture_output=True)
            bad = subprocess.run([sys.executable, recorder, "deploy", "review-arrival", "coderabbit",
                                  "--detail", "token=abc"], env=env, check=False, capture_output=True)
            self.assertNotEqual(bad.returncode, 0)
            rows = list(event_rows(root))
            self.assertEqual(len(rows), 3)
            self.assertEqual(rows[0]["detail"], {"schema_version": 1, "pr_number": 7})
            self.assertEqual(rows[1]["detail"]["repro_attempt"], 1)
            self.assertNotIn("detail", rows[2])
            self.assertEqual(rows[0]["schema_version"], 1)


if __name__ == "__main__":
    unittest.main()
