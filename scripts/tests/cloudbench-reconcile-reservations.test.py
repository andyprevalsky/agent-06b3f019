#!/usr/bin/env python3
"""Positive raw reservation proof and expired next-admission eligibility, offline."""

import copy
import json
import runpy
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(str(ROOT / "scripts/cloudbench-reconcile-reservations.py"))
OLD = runpy.run_path(str(ROOT / "scripts/tests/cloudbench-unused-reservations.test.py"))
H = M["H"]


class Reconcile(unittest.TestCase):
    def setUp(self):
        self.f = OLD["Unused"]()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        f = self.f
        self.row = f.original["candidates"][0]
        self.directory = f.outer / "archived-reuse-reservations" / f.mid
        self.inputs = {}
        # Native raw fixture owner already carries all five original lease,
        # preGET/configPOST/postGET/leaseDELETE records and exact ACK.
        self.proof = M["positive"](self.directory, self.row, f.request, self.inputs)

    def test_positive_raw_ack_requires_dispatch_lease_version_and_no_unknown_post(self):
        self.assertEqual(self.proof["machine_id"], self.f.mid)
        self.assertEqual(self.proof["ack"]["config"], self.f.current["config"])
        path = self.f.wire / "2/0001-wire.json"
        original = path.read_bytes()
        path.unlink()
        with self.assertRaises(ValueError):
            M["positive"](self.directory, self.row, self.f.request, {})
        path.write_bytes(original)
        raw = json.loads(original)
        raw["sha256"] = "0" * 64
        OLD["write"](path, raw)
        with self.assertRaises(ValueError):
            M["positive"](self.directory, self.row, self.f.request, {})

    def expired_fixture(self):
        f = self.f
        # This is a new admission closure fixture, not the closed controller
        # fixture's launch path; remove only the test's own launch artifacts.
        import tempfile

        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        outer = Path(temporary.name)
        outer.chmod(0o700)
        now = time.time()
        epoch, deadline = now - 6000, now - 600
        intent = OLD["write"](
            outer / "admission-intent.private.json", {"fixture": True}
        )
        closed = OLD["write"](
            outer / "archived-reuse-reservations/reserved-request.json",
            {"fixture": "closed"},
        )
        inputs = {
            str(intent): H["sha"](intent.read_bytes()),
            str(closed): H["sha"](closed.read_bytes()),
        }
        log = outer / "observed-tool-98591.stdout-stderr.txt"
        log.write_text(
            json.dumps(
                {
                    "status": "ADMISSION_STARTED",
                    "source_ref": M["SOURCE"],
                    "directory": str(outer),
                }
            )
            + "\n"
            + json.dumps(
                {
                    "status": "ADMISSION_PENDING",
                    "directory": str(outer),
                    "controller_started": False,
                }
            )
            + "\nTraceback (most recent call last):\n  File 'fixture', line 330, in reserve_reuse_capacity\nValueError: fresh capacity after reserved native readback is insufficient\n"
        )
        log.chmod(0o600)
        failure = {
            "schema": "original600-observed-admission-failure-v1",
            "source_ref": M["SOURCE"],
            "admission_directory": str(outer),
            "admission_intent_sha256": inputs[str(intent)],
            "closed_request_sha256": inputs[str(closed)],
            "tool_reported_exit_code": 1,
            "joined_observed": True,
            "controller_created": False,
            "tool_session_id": 98591,
            "capture_kind": "verbatim text from two observed exec tool output chunks; not a separately captured original process stream",
            "log_path": str(log),
            "log_sha256": H["sha"](log.read_bytes()),
        }
        OLD["write"](outer / "observed-admission-failure.safe.json", failure)
        expiry = {
            "schema": "original600-observed-expired-admission-v1",
            "admission_intent_sha256": inputs[str(intent)],
            "started_at_epoch": epoch,
            "original_deadline_epoch": deadline,
            "observed_at_epoch": now,
            "config_present": False,
            "controller_launch_intent_present": False,
            "prior_failure_receipt": "observed-admission-failure.safe.json",
        }
        OLD["write"](outer / "observed-expired-admission.safe.json", expiry)
        value = {
            "directory": str(outer),
            "inputs": inputs,
            "original_epoch": epoch,
            "deadline": deadline,
            "original_request": f.original,
            "closed_request": {"candidates": []},
            "accepted": [self.proof],
            "rejected": [{"machine_id": "bbbbccccddddee", "reason": "unknown"}],
        }
        inventory = OLD["write"](outer / "inventory.json", [f.current])
        return outer, value, inventory, expiry

    def test_expired_prepare_retains_failure_lineage_and_never_grants_reservation_credit(
        self,
    ):
        outer, value, inventory, _ = self.expired_fixture()
        with mock.patch.dict(
            M["prepare"].__globals__, plan=lambda _: copy.deepcopy(value)
        ):
            result = M["prepare"](outer, inventory)
            self.assertEqual(len(result["candidates"]), 1)
            row = result["candidates"][0]
            self.assertNotIn("reservation", row)
            self.assertEqual(row["predecessor"], self.row["predecessor"])
            self.assertEqual(row["source_instance_id"], self.f.current["instance_id"])
            self.assertEqual(row["expired_reservation_proof"]["capacity_credit"], 0)
            self.assertEqual(result["held_machine_ids"], ["bbbbccccddddee"])
            self.assertEqual(
                result["archive"]["expired_admission"]["directory"], str(outer)
            )
            self.assertTrue(M["validate_handoff"](result["archive"]))
            OLD["write"](
                outer / "expired-reservation-handoff.json", {"new_cohort": "a" * 32}
            )
            self.assertTrue(M["validate_handoff"](result["archive"]))
            OLD["write"](
                outer / "archived-reuse-reservations/unexpected.json", {"unknown": True}
            )
            with self.assertRaises(ValueError):
                M["validate_handoff"](result["archive"])

    def test_unexpired_launch_drift_or_unjoined_refusal_denies_next_admission(self):
        outer, value, inventory, expiry = self.expired_fixture()
        with mock.patch.dict(
            M["prepare"].__globals__, plan=lambda _: copy.deepcopy(value)
        ):
            expiry["observed_at_epoch"] = value["deadline"] - 1
            OLD["write"](outer / "observed-expired-admission.safe.json", expiry)
            with self.assertRaises(ValueError):
                M["prepare"](outer, inventory)
            expiry["observed_at_epoch"] = time.time()
            OLD["write"](outer / "observed-expired-admission.safe.json", expiry)
            (outer / "launch-123").mkdir()
            with self.assertRaises(ValueError):
                M["prepare"](outer, inventory)
            (outer / "launch-123").rmdir()
            native = json.loads(inventory.read_bytes())
            native[0]["instance_id"] = "changed"
            OLD["write"](inventory, native)
            with self.assertRaises(ValueError):
                M["prepare"](outer, inventory)
            failure = json.loads(
                (outer / "observed-admission-failure.safe.json").read_bytes()
            )
            failure["joined_observed"] = False
            OLD["write"](outer / "observed-admission-failure.safe.json", failure)
            with self.assertRaises(ValueError):
                M["prepare"](outer, inventory)


if __name__ == "__main__":
    unittest.main()
