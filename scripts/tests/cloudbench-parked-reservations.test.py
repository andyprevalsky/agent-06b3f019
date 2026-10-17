#!/usr/bin/env python3
"""Closed-archive parked admission controls; no external effects."""

import base64
import copy
import json
import runpy
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(str(ROOT / "scripts/cloudbench-parked-reservations.py"))
OLD = runpy.run_path(str(ROOT / "scripts/tests/cloudbench-unused-reservations.test.py"))
H = M["H"]


class Parked(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.dict(
            M["qualify"].__globals__, protocol=lambda _: "fixture-source-sha"
        )
        patch.start()
        self.addCleanup(patch.stop)
        self.fixture = OLD["Unused"]()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        self.row = f.request["candidates"][0]
        task = f.request["task_names"][0]
        self.successor = {
            "controller_id": f.old.host if hasattr(f.old, "host") else "11112222333344",
            "harness_ref": f.request["harness_ref"],
            "task_ref": H["TASK_REF"],
            "owner_token": "d" * 32,
            "run_id": "20261017-120000-1234",
            "task": task,
            "ordinal": 0,
            "campaign_job_id": "r001-j0001",
            "campaign_total_jobs": 600,
            "campaign_attempt": 1,
        }
        self.root = "context/fleet/runs/" + self.successor["run_id"] + "/" + task
        self.proof = H["proof_for"](f.request, self.row, self.successor)
        self.put("archived-successor.json", self.successor)

    def put(self, path, value):
        self.fixture.members[self.root + "/" + path] = H["canonical"](value)

    def prepare(self):
        self.fixture.seal()
        return M["prepare"](self.fixture.outer, self.fixture.inventory)

    def test_recovered_reservation_context_reaches_parked_claim_validation(self):
        self.acked()
        f = self.fixture
        config_path = f.outer / "launch-1/config.private.json"
        config = json.loads(config_path.read_bytes())
        config["host_operator_provenance"] = {"incomplete_admission": {"fixture": True}}
        OLD["write"](config_path, config)
        launch_path = f.outer / "controller-launch.intent.json"
        launch = json.loads(launch_path.read_bytes())
        launch["config_sha256"] = H["sha"](config_path.read_bytes())
        OLD["write"](launch_path, launch)
        f.request_path.unlink()
        context = {
            "request": f.request,
            "original": f.original,
            "held_rows": [],
            "inherited_held_scopes": [],
        }
        calls = []

        def load(outer, closed, actual_config, closure, inputs):
            self.assertEqual(actual_config, config)
            self.assertEqual((outer, closed), (f.outer, f.closed))
            self.assertIn("archived_ownership", closure)
            calls.append("load")
            return context

        def validate(actual, original, reserved, current, inputs):
            self.assertIs(actual, context)
            calls.append("validate")
            return M["U"]["validate_candidate"](
                f.outer,
                original,
                reserved,
                current,
                f.request["cohort"],
                f.request["harness_ref"],
                inputs,
            )

        reader = {"load": load, "validate": validate}
        with mock.patch.dict(
            M["U"]["prepare"].__globals__, recovered_reader=lambda: reader
        ):
            result = self.prepare()
        self.assertEqual(calls, ["load", "load", "validate"])
        self.assertEqual([r["machine_id"] for r in result["candidates"]], [f.mid])
        self.assertEqual(result["held_machine_ids"], [])
        self.assertFalse(f.request_path.exists())

    def add_exclusion(self):
        self.put(
            "archived-reuse-journal/source-exclusion.json",
            {"proof": self.proof, "predecessor": self.row},
        )

    def add_wire(self, number, method, suffix, body, value, headers=None, status=200):
        folder = "archived-reuse-wire/" + f"{number:032x}" + "/"
        request = {
            "app": H["APP"],
            "method": method,
            "path": "/machines/" + self.fixture.mid + suffix,
            "body": body,
            "headers": headers or {},
            "timeout": 20,
        }
        raw = H["canonical"](value)
        self.put(folder + "request.json", request)
        self.put(
            folder + "0001-wire.json",
            {
                "method": method,
                "path": request["path"],
                "status": status,
                "body_b64": base64.b64encode(raw).decode(),
                "sha256": H["sha"](raw),
                "monotonic_ns": number,
            },
        )
        return folder

    def acked(self):
        f = self.fixture
        self.add_exclusion()
        before = copy.deepcopy(f.current)
        config = copy.deepcopy(before["config"])
        config.setdefault("metadata", {})[H["MARKER"]] = H["canonical"](
            self.proof["native_marker"]
        ).decode()
        config["init"] = {"cmd": ["sleep", "infinity"]}
        ack = dict(
            before, instance_id="new-claim-version", config=config, state="created"
        )
        self.put("archived-reuse-journal/original-native.json", before)
        self.put(
            "archived-reuse-journal/claim-intent.json",
            {
                "current_version": before["instance_id"],
                "config_sha256": H["config_sha"](config),
            },
        )
        self.add_wire(
            1, "POST", "/lease", {"ttl": 180}, {"data": {"nonce": "claim-lease"}}
        )
        self.add_wire(2, "GET", "", None, before)
        self.update_folder = self.add_wire(
            3,
            "POST",
            "",
            {
                "config": config,
                "current_version": before["instance_id"],
                "skip_launch": True,
            },
            ack,
            {"fly-machine-lease-nonce": "claim-lease"},
        )
        inventory = json.loads(f.inventory.read_bytes())
        inventory[0] = dict(ack, state="stopped")
        OLD["write"](f.inventory, inventory)
        return ack

    def test_archived_effect_and_publication_protocol_is_git_bound(self):
        ref = "500babc9035912cbbdede1fa63b2d67ce960c7ac"
        self.assertEqual(len(M["protocol"](ref)), 64)
        original = (ROOT / "scripts/cloudbench-archived-machine-reuse.py").read_bytes()
        changed = original.replace(
            b"with api.lease(mid):", b"with api.foreign(mid):", 1
        )
        with (
            mock.patch.object(M["subprocess"], "check_output", return_value=changed),
            self.assertRaises(ValueError),
        ):
            M["protocol"](ref)
        changed_selector = original.replace(
            b"index = campaign_candidate_index(request, successor)", b"index = 0", 1
        )
        with (
            mock.patch.object(
                M["subprocess"], "check_output", return_value=changed_selector
            ),
            self.assertRaises(ValueError),
        ):
            M["protocol"](ref)
        with (
            mock.patch.object(
                M["subprocess"],
                "check_output",
                side_effect=[original, b"foreign index"],
            ),
            self.assertRaisesRegex(ValueError, "indexed selection protocol"),
        ):
            M["protocol"](ref)
        legacy = M["subprocess"].check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                str(ROOT),
                "show",
                ref + ":scripts/cloudbench-archived-machine-reuse.py",
            ]
        )
        changed = legacy.replace(
            b'need(row.get("reservation"), "unreserved candidate cannot be allocated")',
            b"pass  # missing selected reservation validation",
        )
        self.assertNotEqual(changed, legacy)
        with (
            mock.patch.object(M["subprocess"], "check_output", return_value=changed),
            self.assertRaises(ValueError),
        ):
            M["protocol"](ref)

    def test_pre_call_and_pre_config_keep_original_reservation_proof(self):
        result = self.prepare()
        self.assertEqual(len(result["candidates"]), 1)
        candidate = result["candidates"][0]
        self.assertEqual(
            candidate["parked_claim_proof"]["stage"], "PRE_CALL_UNCHANGED_RESERVED"
        )
        self.assertIsNone(candidate["parked_claim_proof"]["claim_id"])
        self.assertNotIn("reservation", candidate)
        self.assertEqual(candidate["parked_claim_proof"]["capacity_credit"], 0)
        self.add_exclusion()
        self.assertEqual(
            self.prepare()["candidates"][0]["parked_claim_proof"]["stage"],
            "PRE_CONFIG_UNCHANGED_RESERVED",
        )
        # Untouched original reservation evidence remains mandatory in both modes.
        (self.fixture.wire / "2/0001-wire.json").unlink()
        self.assertEqual(self.prepare()["candidates"], [])

    def test_raw_acked_partial_claim_is_new_eligibility_not_old_success(self):
        ack = self.acked()
        result = self.prepare()
        self.assertEqual(len(result["candidates"]), 1)
        candidate = result["candidates"][0]
        self.assertEqual(candidate["source_instance_id"], ack["instance_id"])
        self.assertEqual(
            candidate["prior_marker"], ack["config"]["metadata"][H["MARKER"]]
        )
        self.assertEqual(candidate["predecessor"], self.row["predecessor"])
        self.assertEqual(
            candidate["parked_claim_proof"]["stage"], "CONFIG_ACKED_UNPUBLISHED"
        )
        self.assertTrue(candidate["parked_claim_proof"]["old_failure_retained"])
        self.assertEqual(result["held_machine_ids"], [])
        self.assertFalse(
            any(path.endswith("claim-ack.json") for path in self.fixture.members)
        )

    def test_unaccounted_claims_published_proof_and_other_native_methods_stay_held(
        self,
    ):
        self.acked()
        f = self.fixture
        cases = {
            self.root + "/.cid": ("archived-reuse " + f.mid).encode(),
            self.root + "/archived-reuse-proof.json": H["canonical"](self.proof),
            "git-common/cloudbench-archived-reuse/current/" + f.mid + ".json": H[
                "canonical"
            ]({"machine_id": f.mid}),
            "context/fleet/runs/foreign/task/archived-reuse-journal/source-exclusion.json": H[
                "canonical"
            ]({"proof": self.proof, "predecessor": self.row}),
        }
        for path, raw in cases.items():
            with self.subTest(path=path):
                f.members[path] = raw
                self.assertEqual(self.prepare()["candidates"], [])
                del f.members[path]
        self.put(
            "archived-reuse-wire/" + "e" * 32 + "/request.json",
            {
                "app": H["APP"],
                "method": "DELETE",
                "path": "/machines/" + f.mid,
                "body": None,
                "timeout": 20,
                "headers": {},
            },
        )
        self.assertEqual(self.prepare()["candidates"], [])
        del f.members[self.root + "/archived-reuse-wire/" + "e" * 32 + "/request.json"]
        direct = self.root + "/archived-successor.json"
        before = f.members.pop(direct)
        self.assertEqual(self.prepare()["candidates"], [])
        f.members[direct] = before
        self.assertEqual(len(self.prepare()["candidates"]), 1)

    def test_actual_empty_wire_json_holds_only_its_claim_after_hash_validation(self):
        self.acked()
        f = self.fixture
        path = self.root + "/" + self.update_folder + "0001-wire.json"
        f.members[path] = b""
        result = self.prepare()
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["held_machine_ids"], [f.mid])
        diagnostic = result["archive"]["parked_classification"]["rows"][0]
        self.assertEqual(diagnostic["reason"], "malformed archived claim JSON")
        self.assertEqual(
            diagnostic["malformed_json"],
            [{"path": path, "bytes": 0, "sha256": H["sha"](b"")}],
        )
        self.assertEqual(f.members[path], b"")
        # Integrity mismatch is still global and precedes the per-row parse hold.
        manifest_path = f.closed / "export/manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["files"][path]["sha256"] = "0" * 64
        OLD["write"](manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "claim bytes changed"):
            M["collect"](f.closed, result["held_reservations"], {})

    def test_unknown_ack_duplicate_update_foreign_owner_and_native_drift_remain_held(
        self,
    ):
        self.acked()
        key = self.root + "/" + self.update_folder + "0001-wire.json"
        raw = self.fixture.members.pop(key)
        self.assertEqual(self.prepare()["candidates"], [])
        self.fixture.members[key] = raw
        request_key = self.root + "/" + self.update_folder + "request.json"
        self.put(
            "archived-reuse-wire/" + "e" * 32 + "/request.json",
            json.loads(self.fixture.members[request_key]),
        )
        self.assertEqual(self.prepare()["candidates"], [])
        del self.fixture.members[
            self.root + "/archived-reuse-wire/" + "e" * 32 + "/request.json"
        ]
        exclusion_key = self.root + "/archived-reuse-journal/source-exclusion.json"
        prior = self.fixture.members[exclusion_key]
        value = json.loads(prior)
        value["proof"]["successor"]["owner_token"] = "f" * 32
        self.fixture.members[exclusion_key] = H["canonical"](value)
        self.assertEqual(self.prepare()["candidates"], [])
        self.fixture.members[exclusion_key] = prior
        inventory = json.loads(self.fixture.inventory.read_bytes())
        inventory[0]["instance_id"] = "foreign"
        OLD["write"](self.fixture.inventory, inventory)
        self.assertEqual(self.prepare()["candidates"], [])


if __name__ == "__main__":
    unittest.main()
