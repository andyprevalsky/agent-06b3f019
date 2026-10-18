#!/usr/bin/env python3
"""Closed-archive parked admission controls; no external effects."""

import base64
import copy
import json
import os
import re
import runpy
import subprocess
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(os.environ.get("CLOUDBENCH_PARKED_SOURCE", str(ROOT / "scripts/cloudbench-parked-reservations.py")))
OLD = runpy.run_path(str(ROOT / "scripts/tests/cloudbench-unused-reservations.test.py"))
H = M["H"]


class Parked(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.dict(M["qualify"].__globals__, protocol=lambda _: "fixture-source-sha")
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
        with mock.patch.dict(M["U"]["prepare"].__globals__, recovered_reader=lambda: reader):
            result = self.prepare()
        self.assertEqual(calls, ["load", "load", "validate"])
        self.assertEqual([r["machine_id"] for r in result["candidates"]], [f.mid])
        self.assertEqual(result["held_machine_ids"], [])
        self.assertFalse(f.request_path.exists())

        omitted = copy.deepcopy(f.original["candidates"][0])
        omitted.update(machine_id="bbbbccccddddee", volume_id="vol_held")
        omitted["predecessor"].update(id=omitted["machine_id"], volume_id=omitted["volume_id"])
        f.original["candidates"].append(omitted)
        OLD["write"](
            f.outer / "archived-reuse-original.private.json",
            {
                "schema": "original600-archived-admission-request-v1",
                "request": f.original,
                "sha256": H["sha"](json.dumps(f.original, sort_keys=True, allow_nan=False).encode()),
            },
        )
        context["held_rows"] = [
            {
                "machine_id": omitted["machine_id"],
                "volume_id": omitted["volume_id"],
                "reason": "original_recovery_unknown",
                "capacity_credit": 0,
                "reuse_credit": False,
            }
        ]
        with mock.patch.dict(M["U"]["prepare"].__globals__, recovered_reader=lambda: reader):
            result = self.prepare()
        self.assertEqual([row["machine_id"] for row in result["candidates"]], [f.mid])
        self.assertEqual(result["held_machine_ids"], [omitted["machine_id"]])
        held = result["held_reservations"][0]
        self.assertEqual(held["capacity_credit"], 0)
        self.assertFalse(held["reuse_credit"])
        self.assertEqual(held["reason"], "original_recovery_unknown")
        self.assertNotIn("claim_evidence", held)
        original_prepare = M["U"]["prepare"]

        def missing_selected_evidence(*args):
            value = original_prepare(*args)
            for row in value["held_reservations"]:
                if row["machine_id"] == f.mid:
                    row.pop("claim_evidence")
            return value

        with (
            mock.patch.dict(M["U"]["prepare"].__globals__, recovered_reader=lambda: reader),
            mock.patch.dict(M["U"], prepare=missing_selected_evidence),
        ):
            with self.assertRaises(KeyError):
                self.prepare()

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
        config.setdefault("metadata", {})[H["MARKER"]] = H["canonical"](self.proof["native_marker"]).decode()
        config["init"] = {"cmd": ["sleep", "infinity"]}
        ack = dict(before, instance_id="new-claim-version", config=config, state="created")
        self.put("archived-reuse-journal/original-native.json", before)
        self.put(
            "archived-reuse-journal/claim-intent.json",
            {
                "current_version": before["instance_id"],
                "config_sha256": H["config_sha"](config),
            },
        )
        self.add_wire(1, "POST", "/lease", {"ttl": 180}, {"data": {"nonce": "claim-lease"}})
        self.add_wire(
            2,
            "GET",
            "",
            None,
            before,
            {"fly-machine-lease-nonce": "claim-lease"},
        )
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

    def partial_proof_fixture(self, current_source=False):
        f = self.fixture
        old_source = subprocess.check_output(
            ["git", "show", "c9d4817832720cc2b1bc6a212383973a77baf004:scripts/cloudbench-archived-machine-reuse.py"]
        )
        if current_source:
            old_source = (ROOT / "scripts/cloudbench-archived-machine-reuse.py").read_bytes()
        with tempfile.NamedTemporaryFile(dir=ROOT / "scripts", suffix=".py") as source:
            source.write(old_source)
            source.flush()
            old = runpy.run_path(source.name)
        destination = f.old.root / "actual-allocate"
        destination.mkdir(mode=0o700)
        current = copy.deepcopy(f.current)
        calls = []
        owner = self

        class Adapter:
            @contextmanager
            def lease(inner, mid):
                owner.add_wire(
                    1,
                    "POST",
                    "/lease",
                    {"description": "archived same-volume successor", "ttl": 180},
                    {"data": {"nonce": "lease"}},
                    status=201,
                )
                yield
                owner.add_wire(5, "DELETE", "/lease", None, {}, {"fly-machine-lease-nonce": "lease"})

            def request(inner, method, url, body=None, timeout=20):
                calls.append(method)
                if method == "POST":
                    current.update(instance_id="actual-claim-version", config=body["config"], state="created")
                    owner.add_wire(3, "POST", "", body, copy.deepcopy(current), {"fly-machine-lease-nonce": "lease"})
                else:
                    number = 2 if len(calls) == 1 else 4
                    if number == 4:
                        current["state"] = "stopped"
                    owner.add_wire(
                        number, "GET", "", None, copy.deepcopy(current), {"fly-machine-lease-nonce": "lease"}
                    )
                return copy.deepcopy(current)

        with mock.patch.dict(
            old["allocate"].__globals__,
            # The reviewed old allocator ran at its admission's own task pin,
            # which this fixture's request and successor share.
            TASK_REF=H["TASK_REF"],
            selected_request=lambda *_: (f.request, self.row),
            NativeAdapter=lambda *_: Adapter(),
            module=lambda _: {"Fly": lambda *_: None},
        ):
            proof = old["allocate"](f.request_path, "unused", 0, self.successor, destination, "no-token")
        self.assertEqual(proof, self.proof)
        self.fixture.members[self.root] = None
        self.fixture.members[self.root + "/archived-reuse-journal"] = None
        self.fixture.members[self.root + "/archived-reuse-wire"] = None
        for number in range(1, 6):
            prefix = "archived-reuse-wire/" + f"{number:032x}" + "/"
            self.fixture.members[self.root + "/" + prefix.rstrip("/")] = None
            self.put(
                prefix + "result.json",
                json.loads(
                    base64.b64decode(
                        json.loads(self.fixture.members[self.root + "/" + prefix + "0001-wire.json"])["body_b64"]
                    )
                ),
            )
            self.put(prefix + "http-start.json", {"monotonic_ns": number})
            self.put(prefix + "transport-start.json", {"monotonic_ns": number, "direct": False})
            self.fixture.members[self.root + "/" + prefix + "stderr.private.log"] = b""

        for path in destination.rglob("*.json"):
            self.put(str(path.relative_to(destination)), json.loads(path.read_bytes()))
        shell = subprocess.check_output(
            ["git", "show", "c9d4817832720cc2b1bc6a212383973a77baf004:scripts/lib/cloudbench-archived-reuse.sh"]
        )
        registration = (
            shell.decode()
            .split("import runpy,sys\nfrom pathlib import Path\nh=runpy.run_path(sys.argv[1]);proof=")[1]
            .split("\nPY")[0]
        )
        registration = "import runpy,sys\nfrom pathlib import Path\nh=runpy.run_path(sys.argv[1]);proof=" + registration
        blocked = f.old.root / "blocked-registry"
        blocked.write_text("not a directory")
        with tempfile.NamedTemporaryFile(dir=ROOT / "scripts", suffix=".py") as source:
            source.write(old_source)
            source.flush()
            result = subprocess.run(
                [
                    "python3",
                    "-S",
                    "-c",
                    registration,
                    source.name,
                    str(destination / "archived-reuse-proof.json"),
                    str(blocked),
                    str(f.old.root / "audit"),
                    str(f.old.root / "common"),
                ],
                capture_output=True,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((destination / ".cid").exists())
        self.fixture.members["source/scripts/lib/cloudbench-archived-reuse.sh"] = shell
        token = self.successor["owner_token"]
        for kind, version in (("ownership", "2"), ("audits", "1")):
            meta = dict(
                version=version,
                app=H["APP"],
                fleet_owner_token=token,
                run_id=self.successor["run_id"],
                host=self.successor["controller_id"],
            )
            self.fixture.members["git-common/cloudbench-fleet-" + kind + "/" + token + "/meta"] = (
                "\n".join(k + "=" + v for k, v in meta.items()) + "\n"
            ).encode()
        inventory = json.loads(f.inventory.read_bytes())
        inventory[0] = current
        OLD["write"](f.inventory, inventory)
        return current

    def unknown_intended_fixture(self, current_source=False):
        f = self.fixture
        source = subprocess.check_output(
            ["git", "show", "c9d4817832720cc2b1bc6a212383973a77baf004:scripts/cloudbench-archived-machine-reuse.py"]
        )
        if current_source:
            source = (ROOT / "scripts/cloudbench-archived-machine-reuse.py").read_bytes()
        with tempfile.NamedTemporaryFile(dir=ROOT / "scripts", suffix=".py") as path:
            path.write(source)
            path.flush()
            old = runpy.run_path(path.name)
        destination = f.old.root / "unknown-allocate"
        destination.mkdir(mode=0o700)
        current = copy.deepcopy(f.current)
        owner = self
        calls = []

        class Adapter:
            @contextmanager
            def lease(inner, mid):
                owner.add_wire(
                    1,
                    "POST",
                    "/lease",
                    {"description": "archived same-volume successor", "ttl": 180},
                    {"data": {"nonce": "lease"}},
                    status=201,
                )
                try:
                    yield
                finally:
                    owner.add_wire(4, "DELETE", "/lease", None, {}, {"fly-machine-lease-nonce": "lease"})

            def request(inner, method, url, body=None, timeout=20):
                calls.append(method)
                if method == "GET":
                    owner.add_wire(2, "GET", "", None, current, {"fly-machine-lease-nonce": "lease"})
                    return copy.deepcopy(current)
                current.update(instance_id="committed-claim-V1", config=copy.deepcopy(body["config"]), state="stopped")
                folder = owner.add_wire(3, "POST", "", body, None, {"fly-machine-lease-nonce": "lease"})
                del f.members[owner.root + "/" + folder + "0001-wire.json"]
                raise TimeoutError("committed native update response lost")

        with mock.patch.dict(
            old["allocate"].__globals__,
            # The reviewed old allocator ran at its admission's own task pin,
            # which this fixture's request and successor share.
            TASK_REF=H["TASK_REF"],
            selected_request=lambda *_: (f.request, self.row),
            NativeAdapter=lambda *_: Adapter(),
            module=lambda _: {"Fly": lambda *_: None},
        ):
            with self.assertRaisesRegex(TimeoutError, "response lost"):
                old["allocate"](f.request_path, "unused", 0, self.successor, destination, "no-token")
        self.assertEqual(calls, ["GET", "POST"])
        for path in destination.rglob("*.json"):
            self.put(str(path.relative_to(destination)), json.loads(path.read_bytes()))
        f.members[self.root] = None
        for directory in ("archived-reuse-journal", "archived-reuse-wire"):
            f.members[self.root + "/" + directory] = None
        for number in range(1, 5):
            folder = "archived-reuse-wire/" + f"{number:032x}"
            f.members[self.root + "/" + folder] = None
            self.put(folder + "/transport-start.json", {"monotonic_ns": number, "direct": False})
            self.put(folder + "/http-start.json", {"monotonic_ns": number})
            f.members[self.root + "/" + folder + "/stderr.private.log"] = b""
            if number != 3:
                raw = json.loads(f.members[self.root + "/" + folder + "/0001-wire.json"])
                self.put(folder + "/result.json", json.loads(base64.b64decode(raw["body_b64"])))
        f.members["source/scripts/lib/cloudbench-archived-reuse.sh"] = subprocess.check_output(
            ["git", "show", "c9d4817832720cc2b1bc6a212383973a77baf004:scripts/lib/cloudbench-archived-reuse.sh"]
        )
        f.members[self.root + "/bench-e2e.started-epoch"] = b"1792280000.0\n"
        f.members[self.root + "/bench-e2e.finished-epoch"] = b"1792281000.0\n"
        self.put(".startup-state.json", {"seen": {"cloning": 1792280000.0}})
        inventory = json.loads(f.inventory.read_bytes())
        inventory[0] = current
        OLD["write"](f.inventory, inventory)
        return current

    def set_intended_current(self, current):
        inventory = json.loads(self.fixture.inventory.read_bytes())
        inventory[0] = current
        OLD["write"](self.fixture.inventory, inventory)

    def test_current_allocate_lost_response_uses_same_typed_contract(self):
        self.unknown_intended_fixture(current_source=True)
        with mock.patch.dict(
            M["qualify"].__globals__,
            protocol=lambda _: "829cd14575c5e0d74ac0e969c7354719e03e311a79b97abcec8490474d53e8a1",
        ):
            result = self.prepare()
        self.assertEqual(len(result["candidates"]), 1)
        self.assertFalse(
            result["candidates"][0]["closed_transition_proof"]["prior_effect"]["native_claim_acknowledged"]
        )

    def intended_prepare(self):
        with mock.patch.dict(
            M["qualify"].__globals__,
            protocol=lambda _: "24c948d99fd2ed3dff7ce5f0cf01010e7f139342b99ad4f1ef6f5a3a43b4d7c7",
        ):
            return self.prepare()

    def test_real_lost_claim_response_current_intended_is_new_eligibility(self):
        current = self.unknown_intended_fixture()
        result = self.intended_prepare()
        self.assertEqual(len(result["candidates"]), 1)
        candidate = result["candidates"][0]
        self.assertEqual(candidate["source_instance_id"], current["instance_id"])
        self.assertEqual(candidate["source_config_sha256"], H["config_sha"](current["config"]))
        transition = candidate["closed_transition_proof"]["prior_effect"]
        self.assertEqual(transition["stage"], "CURRENT_INTENDED_CLAIM_WITH_UNKNOWN_OLD_RESPONSE")
        self.assertEqual(transition["old_outcome"], "UNKNOWN_RETAINED")
        self.assertFalse(transition["native_claim_acknowledged"])
        self.assertEqual(transition["capacity_credit"], 0)
        self.assertFalse(
            any(path.endswith(("claim-ack.json", "archived-reuse-proof.json", ".cid")) for path in self.fixture.members)
        )
        old_source = subprocess.check_output(
            ["git", "show", "0c6ca2b073254acd33c7e2a747a5ba747f99a537:scripts/cloudbench-parked-reservations.py"]
        )
        with tempfile.NamedTemporaryFile(dir=ROOT / "scripts", suffix=".py") as path:
            path.write(old_source)
            path.flush()
            old = runpy.run_path(path.name)
        with mock.patch.dict(
            old["qualify"].__globals__,
            protocol=lambda _: "24c948d99fd2ed3dff7ce5f0cf01010e7f139342b99ad4f1ef6f5a3a43b4d7c7",
        ):
            previous = old["prepare"](self.fixture.outer, self.fixture.inventory)
        self.assertEqual(previous["candidates"], [])
        self.assertIn("prior native state changed", previous["archive"]["parked_classification"]["reason_counts"])

    def test_unknown_intended_drift_publication_and_extra_wire_stay_held(self):
        current = self.unknown_intended_fixture()
        original = copy.deepcopy(self.fixture.members)
        for field, value in (
            ("instance_id", self.row["source_instance_id"]),
            ("state", "started"),
            ("name", "foreign"),
            ("config", {}),
        ):
            with self.subTest(field=field):
                changed = copy.deepcopy(current)
                changed[field] = value
                self.set_intended_current(changed)
                self.assertEqual(self.intended_prepare()["candidates"], [])
        self.set_intended_current(current)
        for artifact in (
            ".cid",
            "boot.json",
            "archived-reuse-proof.json",
            "archived-reuse-journal/claim-ack.json",
            "archived-reuse-wire/" + "f" * 32 + "/request.json",
        ):
            with self.subTest(artifact=artifact):
                self.fixture.members = copy.deepcopy(original)
                self.put(artifact, {"foreign": True})
                try:
                    result = self.intended_prepare()
                except ValueError:
                    continue  # An invalid allocation identity is rejected before eligibility.
                self.assertEqual(result["candidates"], [])
        self.fixture.members = original
        with mock.patch.dict(M["qualify"].__globals__, protocol=lambda _: "foreign-source"):
            self.assertEqual(self.prepare()["candidates"], [])
        self.fixture.members[self.root + "/bench-e2e.finished-epoch"] = b"nan\n"
        self.assertEqual(self.intended_prepare()["candidates"], [])

    def test_new_reservation_uses_current_V1_and_late_V0_cannot_overwrite(self):
        current = self.unknown_intended_fixture()
        candidate = self.intended_prepare()["candidates"][0]
        request = copy.deepcopy(self.fixture.original)
        request["cohort"] = "new-intended-cohort"
        request["candidates"] = [candidate]
        effects = H["reserve_cohort"].__globals__
        owner = self
        for late in (False, True):
            calls = []
            native = copy.deepcopy(current)

            class API:
                @contextmanager
                def lease(inner, mid):
                    calls.append("lease")
                    try:
                        yield
                    finally:
                        calls.append("release")

                def request(inner, method, url, body=None, **kw):
                    calls.append(method)
                    if method == "GET":
                        return copy.deepcopy(native)
                    owner.assertEqual(body["current_version"], current["instance_id"])
                    owner.assertNotEqual(body["current_version"], owner.row["source_instance_id"])
                    if late:
                        raise ValueError("409 current version changed")
                    # A delayed old V0 CAS must fail after the already committed V1.
                    old_intent = json.loads(
                        owner.fixture.members[owner.root + "/archived-reuse-journal/claim-intent.json"]
                    )
                    owner.assertNotEqual(old_intent["current_version"], native["instance_id"])
                    native.update(
                        instance_id="new-reservation-V2", config=copy.deepcopy(body["config"]), state="stopped"
                    )
                    return copy.deepcopy(native)

            journal = self.fixture.old.root / ("new-reserve-" + str(late))
            with mock.patch.dict(effects, validate_request=lambda value: value):
                if late:
                    with self.assertRaisesRegex(ValueError, "409 current version"):
                        H["reserve_cohort"](lambda _: API(), request, journal)
                    self.assertFalse((journal / "reserved-request.json").exists())
                    held = list(journal.glob("*/held-*.json"))
                    self.assertEqual(len(held), 1)
                    self.assertTrue(json.loads(held[0].read_bytes())["not_credited"])
                else:
                    reserved = H["reserve_cohort"](lambda _: API(), request, journal)
                    self.assertEqual(len(reserved["candidates"]), 1)
            self.assertEqual(calls.count("POST"), 1)
            self.assertEqual(calls[-1], "release")

    def test_actual_allocate_proof_before_assignment_is_typed_new_eligibility(self):
        current = self.partial_proof_fixture()
        with mock.patch.dict(
            M["qualify"].__globals__,
            protocol=lambda _: "24c948d99fd2ed3dff7ce5f0cf01010e7f139342b99ad4f1ef6f5a3a43b4d7c7",
        ):
            result = self.prepare()
            self.assertEqual(len(result["candidates"]), 1, result.get("parked_claim_diagnostics"))
            self.assertEqual(
                result["candidates"][0]["parked_claim_proof"]["stage"], "PARTIAL_PROOF_PUBLICATION_BEFORE_ASSIGNMENT"
            )
            for path, data in [
                (".cid", ("archived-reuse " + self.fixture.mid + "\n").encode()),
                ("boot.intent.json", b"{}"),
                ("archived-reuse-wire/" + "f" * 32 + "/transport-start.json", b"{}"),
                ("archived-reuse-proof.json", b"{}"),
                ("archived-reuse-journal/claim-ack.json", b"{}"),
            ]:
                key = self.root + "/" + path
                previous = self.fixture.members.get(key)
                self.fixture.members[key] = data
                self.assertEqual(self.prepare()["candidates"], [])
                if previous is None:
                    del self.fixture.members[key]
                else:
                    self.fixture.members[key] = previous
            changed = copy.deepcopy(current)
            changed["instance_id"] = "foreign"
            inventory = json.loads(self.fixture.inventory.read_bytes())
            inventory[0] = changed
            OLD["write"](self.fixture.inventory, inventory)
            self.assertEqual(self.prepare()["candidates"], [])

    def test_current_reviewed_allocate_has_same_proof_before_assignment_boundary(self):
        self.partial_proof_fixture(current_source=True)
        with mock.patch.dict(
            M["qualify"].__globals__,
            protocol=lambda _: "829cd14575c5e0d74ac0e969c7354719e03e311a79b97abcec8490474d53e8a1",
        ):
            value = self.prepare()
            self.assertEqual(len(value["candidates"]), 1)
            self.assertEqual(
                value["candidates"][0]["parked_claim_proof"]["stage"], "PARTIAL_PROOF_PUBLICATION_BEFORE_ASSIGNMENT"
            )

    def test_archived_effect_and_publication_protocol_is_git_bound(self):
        ref = "500babc9035912cbbdede1fa63b2d67ce960c7ac"
        self.assertEqual(len(M["protocol"](ref)), 64)
        original = (ROOT / "scripts/cloudbench-archived-machine-reuse.py").read_bytes()
        changed = original.replace(b"with api.lease(mid):", b"with api.foreign(mid):", 1)
        with (
            mock.patch.object(M["subprocess"], "check_output", return_value=changed),
            self.assertRaises(ValueError),
        ):
            M["protocol"](ref)
        changed_selector = original.replace(b"index = campaign_candidate_index(request, successor)", b"index = 0", 1)
        with (
            mock.patch.object(M["subprocess"], "check_output", return_value=changed_selector),
            self.assertRaises(ValueError),
        ):
            M["protocol"](ref)
        real_git = M["subprocess"].check_output
        new_ref = "a" * 40

        def changed_index(command, **kwargs):
            if command[-1] == new_ref + ":scripts/cloudbench-archived-machine-reuse.py":
                return original
            if command[-1] == new_ref + ":scripts/cloudbench-reuse-index.py":
                return b"foreign index"
            return real_git(command, **kwargs)

        with (
            mock.patch.object(M["subprocess"], "check_output", side_effect=changed_index),
            self.assertRaisesRegex(ValueError, "indexed selection protocol"),
        ):
            M["protocol"](new_ref)
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

    def test_reconciliation_protocol_preserves_exact_old_source_and_binds_helpers(self):
        old_ref = "c9d4817832720cc2b1bc6a212383973a77baf004"
        target = ROOT / "scripts/cloudbench-archived-machine-reuse.py"
        old = M["subprocess"].check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                str(ROOT),
                "show",
                old_ref + ":scripts/cloudbench-archived-machine-reuse.py",
            ]
        )
        # A real new helper/class closure, independent of the active B checkout.
        new = old.replace(
            b"def claim_native(api, request, row, successor, journal):",
            b"def claim_native(api, request, row, successor, journal, *, read_only=False):",
            1,
        )
        new += b"\nclass ClaimReadCancelled(BaseException):\n    pass\ndef claim_read_evidence():\n    return 'bound'\ndef same_claim_evidence():\n    return 'same'\ndef reconcile_claim_read():\n    return claim_read_evidence()\n"
        real_read, real_git = Path.read_bytes, M["subprocess"].check_output
        index = ":scripts/cloudbench-reuse-index.py"
        historical_index = real_git(["git", "--no-replace-objects", "-C", str(ROOT), "show", old_ref + index])
        pin = rb'TASK_REF = "[0-9a-f]{40}"'
        self.assertEqual(len(re.findall(pin, historical_index)), 1)
        # Model the reviewed admission at this checkout's guest task pin.
        same_pin_index = re.sub(pin, b'TASK_REF = "' + H["TASK_REF"].encode() + b'"', historical_index)

        def read(path):
            return new if path == target else real_read(path)

        new_ref = "a" * 40

        def git(command, **kwargs):
            if command[-1] == new_ref + ":scripts/cloudbench-archived-machine-reuse.py":
                return new
            if command[-1] == old_ref + index:
                return same_pin_index
            return real_git(command, **kwargs)

        if same_pin_index != historical_index:
            # An admission indexed at another guest task pin never carries forward.
            with (
                mock.patch.object(Path, "read_bytes", read),
                mock.patch.object(M["subprocess"], "check_output", side_effect=real_git),
                self.assertRaisesRegex(ValueError, "archived indexed selection protocol differs"),
            ):
                M["protocol"](old_ref)

        with (
            mock.patch.object(Path, "read_bytes", read),
            mock.patch.object(M["subprocess"], "check_output", side_effect=git),
        ):
            self.assertEqual(M["protocol"](old_ref), M["U"]["digest"](old))

            # Supply unchanged index bytes for the synthetic source reference.
            def new_git(command, **kwargs):
                if command[-1] == new_ref + ":scripts/cloudbench-reuse-index.py":
                    return (ROOT / "scripts/cloudbench-reuse-index.py").read_bytes()
                return git(command, **kwargs)

            with mock.patch.object(M["subprocess"], "check_output", side_effect=new_git):
                self.assertEqual(M["protocol"](new_ref), M["U"]["digest"](new))
                changed = new.replace(b"return 'bound'", b"return 'foreign'")

                def changed_git(command, **kwargs):
                    if command[-1] == new_ref + ":scripts/cloudbench-archived-machine-reuse.py":
                        return changed
                    return new_git(command, **kwargs)

                with (
                    mock.patch.object(M["subprocess"], "check_output", side_effect=changed_git),
                    self.assertRaises(ValueError),
                ):
                    M["protocol"](new_ref)
                altered = old.replace(b"with api.lease(mid):", b"with api.foreign(mid):", 1)

                def old_git(command, **kwargs):
                    if command[-1] == new_ref + ":scripts/cloudbench-archived-machine-reuse.py":
                        return altered
                    return new_git(command, **kwargs)

                with (
                    mock.patch.object(M["subprocess"], "check_output", side_effect=old_git),
                    self.assertRaises(ValueError),
                ):
                    M["protocol"](new_ref)

    def test_pre_call_and_pre_config_keep_original_reservation_proof(self):
        result = self.prepare()
        self.assertEqual(len(result["candidates"]), 1)
        candidate = result["candidates"][0]
        self.assertEqual(candidate["parked_claim_proof"]["stage"], "PRE_CALL_UNCHANGED_RESERVED")
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
        self.assertEqual(candidate["prior_marker"], ack["config"]["metadata"][H["MARKER"]])
        self.assertEqual(candidate["predecessor"], self.row["predecessor"])
        self.assertEqual(candidate["parked_claim_proof"]["stage"], "CONFIG_ACKED_UNPUBLISHED")
        self.assertTrue(candidate["parked_claim_proof"]["old_failure_retained"])
        self.assertEqual(result["held_machine_ids"], [])
        self.assertFalse(any(path.endswith("claim-ack.json") for path in self.fixture.members))

    def test_empty_post_ack_get_preserves_failure_and_new_eligibility(self):
        ack = self.acked()
        folder = self.add_wire(
            4,
            "GET",
            "",
            None,
            ack,
            {"fly-machine-lease-nonce": "claim-lease"},
        )
        path = self.root + "/" + folder + "0001-wire.json"
        self.fixture.members[path] = b""
        result = self.prepare()
        self.assertEqual(len(result["candidates"]), 1)
        candidate = result["candidates"][0]
        self.assertEqual(candidate["parked_claim_proof"]["capacity_credit"], 0)
        self.assertEqual(
            candidate["closed_transition_proof"]["unknown_read_responses"],
            [{"path": path, "bytes": 0, "sha256": H["sha"](b"")}],
        )
        self.assertEqual(self.fixture.members[path], b"")

    def test_unknown_versioned_update_requires_unchanged_leased_prior_state(self):
        self.acked()
        f = self.fixture
        before = json.loads(f.members[self.root + "/archived-reuse-journal/original-native.json"])
        wire_path = self.root + "/" + self.update_folder + "0001-wire.json"
        del f.members[wire_path]
        self.put(
            self.update_folder + "transport-start.json",
            {"monotonic_ns": 3, "direct": False},
        )
        inventory = json.loads(f.inventory.read_bytes())
        inventory[0] = dict(before, state="stopped")
        OLD["write"](f.inventory, inventory)
        result = self.prepare()
        self.assertEqual(len(result["candidates"]), 1)
        candidate = result["candidates"][0]
        proof = candidate["closed_transition_proof"]["prior_effect"]
        self.assertEqual(proof["old_outcome"], "UNKNOWN_OR_ERROR_RETAINED")
        self.assertEqual(proof["capacity_credit"], 0)
        self.assertNotIn(wire_path, f.members)
        # A different leased pre-read cannot certify this old transition.
        request_path = self.root + "/archived-reuse-wire/" + format(2, "032x") + "/request.json"
        request = json.loads(f.members[request_path])
        request["headers"]["fly-machine-lease-nonce"] = "other-lease"
        f.members[request_path] = H["canonical"](request)
        self.assertEqual(self.prepare()["candidates"], [])

    def test_unaccounted_claims_published_proof_and_other_native_methods_stay_held(
        self,
    ):
        self.acked()
        f = self.fixture
        cases = {
            self.root + "/.cid": ("archived-reuse " + f.mid).encode(),
            self.root + "/archived-reuse-proof.json": H["canonical"](self.proof),
            "git-common/cloudbench-archived-reuse/current/" + f.mid + ".json": H["canonical"]({"machine_id": f.mid}),
            "context/fleet/runs/foreign/task/archived-reuse-journal/source-exclusion.json": H["canonical"](
                {"proof": self.proof, "predecessor": self.row}
            ),
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
        self.assertEqual(diagnostic["reason"], "malformed response is not an isolated read")
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
        del self.fixture.members[self.root + "/archived-reuse-wire/" + "e" * 32 + "/request.json"]
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
