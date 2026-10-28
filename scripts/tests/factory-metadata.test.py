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


if __name__ == "__main__":
    unittest.main()
