"""End-to-end preservation and validation of factory execution metadata."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from deploy_stage import append_stage, init_run
from factory_ledger import encode_rows, event_rows, pending_rows, stage_rows
from factory_metadata import load_metadata, normalize_metadata, refresh_snapshot


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


def launch_snapshot():
    """A launcher's snapshot: the sample plus the head it was first written for."""
    data = sample()
    data["validation"] = {"source_sha": "deadbeef0"}
    data["evidence"]["validation.source_sha"] = "stale launch"
    return data


def git_checkout(root: Path) -> Path:
    """A private checkout running the real --start wrapper and its lifecycle
    scripts, so refreshing never touches this repository's own snapshot."""
    checkout = root / "checkout"
    (checkout / "scripts").mkdir(parents=True)
    for name in ("run-deploy-stage", "deploy_stage.py", "factory_metadata.py"):
        shutil.copyfile(ROOT / "scripts" / name, checkout / "scripts" / name)
    (checkout / ".gitignore").write_text(".context/\n__pycache__/\n")
    git = ["git", "-C", str(checkout), "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"]
    subprocess.run(["git", "init", "-q", str(checkout)], check=True)
    subprocess.run([*git, "add", "."], check=True, capture_output=True)
    subprocess.run([*git, "commit", "-qm", "fixture"], check=True, capture_output=True)
    return checkout


class FactoryMetadataTest(unittest.TestCase):
    def test_start_refreshes_snapshot_for_launched_head(self):
        """`run-deploy-stage --start` re-stamps the selected snapshot with the
        head it launches (observed_at, validation.source_sha and that field's
        evidence) and nothing else, so the run defaults carry the launched
        head; a later head is re-stamped again. A snapshot outside the checkout
        is reported and left alone; non-allowlisted keys refuse the run with
        the file untouched. Until now a launcher patched the file by hand."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout = git_checkout(root)
            snapshot = checkout / ".context" / "factory-metadata.json"
            snapshot.parent.mkdir()
            original = launch_snapshot()
            snapshot.write_text(json.dumps(original))
            env = {**os.environ, "FACTORY_METADATA_FILE": str(snapshot), "DEPLOY_RUN_ROOT": str(root / "deploy-runs")}
            wrapper = str(checkout / "scripts/run-deploy-stage")
            git = ["git", "-C", str(checkout), "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"]

            def head() -> str:
                return subprocess.run([*git, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()

            def start(run_id: str, check: bool = True, **overrides: str) -> subprocess.CompletedProcess:
                return subprocess.run(["bash", wrapper, "--start", "--run-id", run_id], env={**env, **overrides},
                                      cwd=checkout, capture_output=True, text=True, check=check)

            def finish() -> None:
                subprocess.run(["bash", wrapper, "--finish"], env=env, cwd=checkout, check=True, capture_output=True)

            first_head = head()
            first = start("first")
            self.assertIn(f"factory metadata: refreshed {snapshot}", first.stdout)
            self.assertIn(f"source_sha={first_head}", first.stdout)
            refreshed = json.loads(snapshot.read_text())
            self.assertEqual(refreshed["validation"]["source_sha"], first_head)
            self.assertIn(first_head, refreshed["evidence"]["validation.source_sha"])
            self.assertIn("run-deploy-stage --start", refreshed["evidence"]["validation.source_sha"])
            observed = datetime.fromisoformat(refreshed["observed_at"])
            self.assertIsNotNone(observed.tzinfo)
            self.assertGreater(observed, datetime.fromisoformat("2026-10-28T02:35:09+00:00"))
            self.assertEqual(refreshed["execution"], original["execution"])
            self.assertEqual(refreshed["usage"], original["usage"])
            kept = {k: v for k, v in refreshed["evidence"].items() if k != "validation.source_sha"}
            self.assertEqual(kept, {k: v for k, v in original["evidence"].items() if k != "validation.source_sha"})
            self.assertEqual(set(refreshed), set(original) | {"schema_version", "record_type"} & set(refreshed))
            self.assertEqual(load_metadata(snapshot)["validation"]["source_sha"], first_head)
            run_metadata = json.loads((root / "deploy-runs/first/metadata.json").read_text())
            self.assertEqual(run_metadata["telemetry"]["validation"]["source_sha"], first_head)
            finish()
            (checkout / "tracked").write_text("v2\n")
            subprocess.run([*git, "add", "."], check=True, capture_output=True)
            subprocess.run([*git, "commit", "-qm", "second"], check=True, capture_output=True)
            second_head = head()
            self.assertNotEqual(second_head, first_head)
            start("second")
            self.assertEqual(json.loads(snapshot.read_text())["validation"]["source_sha"], second_head)
            finish()
            elsewhere = root / "elsewhere-factory-metadata.json"
            elsewhere.write_text(json.dumps(original))
            before = elsewhere.read_bytes()
            outside = start("third", FACTORY_METADATA_FILE=str(elsewhere))
            self.assertIn("factory metadata: not refreshed", outside.stdout)
            self.assertIn("outside", outside.stdout)
            self.assertEqual(elsewhere.read_bytes(), before)
            finish()
            snapshot.write_text(json.dumps({**original, "api_key": "must-not-leak"}))
            before = snapshot.read_bytes()
            failed = start("fourth", check=False)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("factory metadata snapshot rejected", failed.stderr)
            self.assertNotIn("must-not-leak", failed.stdout + failed.stderr)
            self.assertEqual(snapshot.read_bytes(), before)
            self.assertFalse((root / "deploy-runs/fourth").exists())

    def test_refresh_rejects_retrospectives_bad_heads_and_naive_clocks(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            path.write_text(json.dumps({**sample(), "record_type": "retrospective"}))
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                refresh_snapshot(path, head="a" * 40, producer="test")
            self.assertEqual(path.read_bytes(), before)
            path.write_text(json.dumps(sample()))
            before = path.read_bytes()
            for head in ("", "53dcec300", "G" * 40, "A" * 40):
                with self.subTest(head=head), self.assertRaises(ValueError):
                    refresh_snapshot(path, head=head, producer="test")
            with self.assertRaises(ValueError):
                refresh_snapshot(path, head="a" * 40, producer="test", now=datetime(2026, 10, 31, 12, 0))
            self.assertEqual(path.read_bytes(), before)
            fixed = datetime(2026, 10, 31, 12, 0, tzinfo=timezone.utc)
            normalized = refresh_snapshot(path, head="a" * 40, producer="test", now=fixed)
            self.assertEqual(normalized["observed_at"], fixed.isoformat())
            self.assertEqual(normalized["validation"]["source_sha"], "a" * 40)
            self.assertEqual(normalized["execution"]["model"], "test-model")
            self.assertEqual(json.loads(path.read_text())["evidence"]["execution.model"], "fixture receipt")

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

    def test_explicit_domain_failure_wins_over_expected_network_logs(self):
        from factory_detail import outcome_detail

        # A real coverage run contained expected connection failures before
        # its terminal 121-pass/2-fail domain inventory.
        log = 'trace_archive.backend_store_error error="Connection refused"\n'
        log += 'Agents blackbox: 121 passed, 2 failed, 123 total\n'
        report = {"runner": "agents-blackbox-domains", "passed": 121,
                  "failed": 2, "total": 123,
                  "failing": ["benchmark", "rose-browser-use"]}
        marked = log + "FACTORY_TEST_FAILURE " + json.dumps(report) + "\n"
        detail = outcome_detail(1, marked)
        self.assertEqual(detail["failure_class"], "test-failure")
        self.assertEqual(detail["failure_class_source"], "runner-summary")
        self.assertEqual(detail["unverified_log_failure_hint"], "network")
        self.assertEqual(detail["failing"], ["benchmark", "rose-browser-use"])
        self.assertEqual((detail["passed_count"], detail["failed_count"], detail["total_count"]), (121, 2, 123))
        self.assertEqual(detail["count_source"], "agents-blackbox-domains")
        self.assertIsNone(outcome_detail(0, marked)["failure_class"])
        self.assertEqual(outcome_detail(143, marked)["exit_code"], 143)
        for bad in ({**report, "total": 999}, {**report, "failed": True},
                    {**report, "failing": ["benchmark", "Authorization: Bearer secret"]}):
            invalid = outcome_detail(1, log + "FACTORY_TEST_FAILURE " + json.dumps(bad))
            self.assertNotIn("failure_class_source", invalid)

    def test_domain_runner_publishes_failure_inventory_without_changing_exit(self):
        import asyncio
        import contextlib
        import importlib.util
        import io
        from factory_detail import outcome_detail

        path = ROOT / "agents/scripts/run_coverage_blackbox_parallel.py"
        spec = importlib.util.spec_from_file_location("test_failure_inventory_runner", path)
        runner = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = runner
        spec.loader.exec_module(runner)
        try:
            with tempfile.TemporaryDirectory() as directory:
                output = io.StringIO()
                root = Path(directory)

                async def fake_domain(domain, semaphore, coverage, artifacts):
                    log = artifacts / (domain + ".log")
                    log.write_text("expected Connection refused negative control\n")
                    return runner.DomainResult(domain, domain == "healthy", 0.1,
                                               str(log.relative_to(root)),
                                               0 if domain == "healthy" else 1)

                with patch.object(runner, "ROOT_DIR", root), patch.object(
                    runner, "discover_domains", return_value=["healthy", "broken"]
                ), patch.object(runner, "run_domain", side_effect=fake_domain), patch.dict(
                    os.environ, {"COVERAGE_BIN": sys.executable}
                ), contextlib.redirect_stdout(output):
                    status = asyncio.run(runner.async_main())
                self.assertEqual(status, 1)
                records = list((root / ".context/test-runs").glob("*/results.json"))
                self.assertEqual(len(records), 1)
                inventory = json.loads(records[0].read_text())
                self.assertEqual((inventory["passed"], inventory["failed"]), (1, 1))
                result = outcome_detail(status, output.getvalue())
                self.assertEqual(result["failing"], ["broken"])
                self.assertEqual(result["failure_class_source"], "runner-summary")
                self.assertEqual(result["unverified_log_failure_hint"], "network")
        finally:
            sys.modules.pop(spec.name, None)

    def test_failure_inventory_must_be_terminal(self):
        from factory_detail import outcome_detail

        report = {"runner": "agents-blackbox-domains", "passed": 121,
                  "failed": 2, "total": 123,
                  "failing": ["benchmark", "rose-browser-use"]}
        marker = "FACTORY_TEST_FAILURE " + json.dumps(report) + "\n"
        for suffix in ("later command failed\n", "FACTORY_TEST_FAILURE malformed\n"):
            result = outcome_detail(1, marker + suffix)
            self.assertNotIn("failure_class_source", result)
            self.assertNotIn("count_source", result)
            self.assertNotIn("failing", result)
        terminal = outcome_detail(1, marker + "\n  \n")
        self.assertEqual(terminal["failure_class_source"], "runner-summary")

    def test_names_never_copy_secrets_or_unbounded_text(self):
        from factory_detail import MAX_TEXT, safe_text, scan_log

        token = "sk_live_" + "A1b2C3d4" * 6
        self.assertIsNone(safe_text(token))
        self.assertIsNone(safe_text("Authorization: Bearer $TOKEN"))
        self.assertIsNone(safe_text("ghp_" + "Ab1" * 12))
        long_test = "tests/test_attempt_ledger_records_run_id_and_outcome_class_for_every_retry"
        self.assertEqual(safe_text(long_test), long_test)
        self.assertIsNone(safe_text("0123456789abcdef0123456789abcdef01234567"))
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
