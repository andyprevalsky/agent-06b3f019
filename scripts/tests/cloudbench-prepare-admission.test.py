#!/usr/bin/env python3
"""Offline pre-reservation closure, immutable membership and original-clock proof."""

import copy
import json
import os
import runpy
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(str(ROOT / "scripts/cloudbench-prepare-admission.py"))


class Prepare(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / "original600-fixture"
        self.directory.mkdir(mode=0o700)
        self.oldroot = self.root / "old-source"
        self.oldroot.mkdir()
        (self.oldroot / "scripts").mkdir()
        self.program = self.oldroot / "scripts/run-original600-controller.py"
        self.program.write_text("exact-old-source")
        self.pins = {
            "run-original600-controller.py": M["sha"](self.program.read_bytes())
        }
        self.started = time.time() - 120
        self.binding = dict(
            source_ref=M["SOURCE"],
            inputs={},
            archive_runs=["/exact/archive"],
            excluded_machines=["a" * 14],
        )
        self.args = SimpleNamespace(
            prepare_admission_request=self.directory,
            source_ref="e" * 40,
            state_dir=self.root,
        )
        for name in (
            "facts",
            "agents_env",
            "backend_env",
            "tasks",
            "snapshot_inventory",
            "warm_deps",
        ):
            path = self.root / (name + ".private")
            path.write_text(name)
            path.chmod(0o600)
            setattr(self.args, name, path)
            self.binding["inputs"][name] = dict(
                path=str(path), sha256=M["sha"](path.read_bytes())
            )
        self.write(
            self.directory / "admission-intent.private.json",
            dict(
                binding=self.binding,
                started_at_epoch=self.started,
                deadline_epoch=self.started + 5400,
            ),
        )
        snapshot = self.directory / "capacity-before-reservation-123"
        snapshot.mkdir(mode=0o700)
        self.write(snapshot / "navi-whisper-lux-bench.private.json", [])
        self.log = self.root / "execution.log"
        self.log.write_text(
            json.dumps(
                dict(
                    status="ADMISSION_STARTED",
                    directory=str(self.directory),
                    source_ref=M["SOURCE"],
                )
            )
            + "\n"
            + json.dumps(
                dict(
                    status="ADMISSION_PENDING",
                    directory=str(self.directory),
                    controller_started=False,
                )
            )
            + "\ncloudbench-recovered-reservations.py in membership\n<run_path>.Deadline: external controller I/O deadline\n"
        )
        self.log.chmod(0o600)
        self.failure = self.root / "failure.private.json"
        self.args.pre_reservation_failure = self.failure
        self.receipt = dict(
            schema="original600-observed-prereservation-failure-v1",
            source_ref=M["SOURCE"],
            source_root=str(self.oldroot),
            admission_directory=str(self.directory),
            admission_intent_sha256=M["sha"](
                (self.directory / "admission-intent.private.json").read_bytes()
            ),
            joined_observed=True,
            tool_reported_exit_code=1,
            tool_session_id=66023,
            controller_created=False,
            capture_kind="original-process-stream",
            launch_directories=[],
            started_at_epoch=self.started,
            deadline_epoch=self.started + 5400,
            recorded_observation_epoch=self.started + 110,
            absent_paths=sorted(M["ABSENT"]),
            files={
                str(p.relative_to(self.directory)): M["file_hash"](p)
                for p in self.directory.rglob("*")
                if p.is_file()
            },
            log_path=str(self.log),
            log_sha256=M["sha"](self.log.read_bytes()),
        )
        self.write(self.failure, self.receipt)

        def source(root, ref):
            if (
                ref != M["SOURCE"]
                or M["sha"](self.program.read_bytes())
                != self.pins["run-original600-controller.py"]
            ):
                raise ValueError("source changed")
            return self.pins

        def binding(args, _):
            result = copy.deepcopy(self.binding)
            result["source_ref"] = args.source_ref
            for name in result["inputs"]:
                path = getattr(args, name)
                result["inputs"][name] = dict(
                    path=str(path), sha256=M["sha"](path.read_bytes())
                )
            return result

        self.operator = dict(source=source, admission_binding=binding)
        self.runner = dict(
            read=lambda path: Path(path).read_bytes(),
            validate_source_members=lambda *_: None,
        )
        self.patch = mock.patch.dict(
            M["plan"].__globals__, old_operator=lambda _: self.operator
        )
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def write(self, path, value):
        path.write_text(json.dumps(value, sort_keys=True) + "\n")
        path.chmod(0o600)

    def test_plan_revalidates_original_epoch_and_only_fixed_new_journal_is_exempt(self):
        value = M["plan"](self.args, self.runner)
        self.assertEqual(value["started_at"], self.started)
        self.assertEqual(value["deadline"], self.started + 5400)
        self.assertEqual(value["source_ref"], M["SOURCE"])
        self.assertEqual(value["binding"], self.binding)
        (self.directory / M["JOURNAL"]).mkdir(mode=0o700)
        self.write(
            self.directory / M["JOURNAL"] / "intent.json", dict(new_operator="e" * 40)
        )
        self.assertTrue(M["revalidate"](value, self.runner))
        self.write(self.directory / "other.json", {})
        with self.assertRaisesRegex(ValueError, "membership changed"):
            M["revalidate"](value, self.runner)

    def test_effect_paths_changed_inputs_and_source_are_not_resume_authority(self):
        for name in (
            "archived-reuse-original.private.json",
            "controller-launch.intent.json",
        ):
            self.write(self.directory / name, {})
            with self.assertRaises(ValueError):
                M["plan"](self.args, self.runner)
            (self.directory / name).unlink()
        value = M["plan"](self.args, self.runner)
        self.args.tasks.write_text("changed")
        with self.assertRaisesRegex(ValueError, "inputs/archives/exclusions changed"):
            M["plan"](self.args, self.runner)
        with self.assertRaisesRegex(ValueError, "evidence changed"):
            M["revalidate"](value, self.runner)

    def test_join_receipt_deadline_and_source_remain_required(self):
        self.receipt["joined_observed"] = False
        self.write(self.failure, self.receipt)
        with self.assertRaisesRegex(ValueError, "joined"):
            M["plan"](self.args, self.runner)
        self.receipt["joined_observed"] = True
        self.write(self.failure, self.receipt)
        value = M["plan"](self.args, self.runner)
        with mock.patch.object(M["time"], "time", return_value=value["deadline"]):
            with self.assertRaisesRegex(ValueError, "clock expired"):
                M["revalidate"](value, self.runner)
        self.program.write_text("changed")
        with self.assertRaisesRegex(ValueError, "source changed"):
            M["revalidate"](value, self.runner)

    def test_private_stream_hash_has_no_small_json_limit_and_denies_alias(self):
        path = self.root / "large.private"
        with path.open("wb") as stream:
            stream.truncate(17 * 1024 * 1024)
        path.chmod(0o600)
        self.assertEqual(M["file_hash"](path)["bytes"], 17 * 1024 * 1024)
        alias = self.root / "alias"
        alias.symlink_to(path)
        with self.assertRaisesRegex(ValueError, "physical"):
            M["file_hash"](alias)
        os.link(path, self.root / "second")
        with self.assertRaisesRegex(ValueError, "private"):
            M["file_hash"](path)


if __name__ == "__main__":
    unittest.main()
