#!/usr/bin/env python3
"""Saved archive/journal controls; no native transport or credentials."""

import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import tarfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(
    os.environ.get("CLOUDBENCH_UNUSED_RESERVATIONS_SOURCE", str(ROOT / "scripts/cloudbench-unused-reservations.py"))
)
H = M["H"]
OLD = runpy.run_path(str(ROOT / "scripts/tests/cloudbench-archived-owner-stop.test.py"))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(value, sort_keys=True) + "\n")
    path.chmod(0o600)
    return path


class Unused(unittest.TestCase):
    def setUp(self):
        self.old = OLD["ArchivedStop"]()
        self.old.setUp()
        self.addCleanup(self.old.doCleanups)
        self.outer = self.old.root / "admission"
        self.outer.mkdir(mode=0o700)
        self.mid = self.old.mid
        native = copy.deepcopy(self.old.row)
        native.update(state="stopped", region="iad")
        native["config"]["image"] = "registry.fly.io/navi-whisper-lux-bench:tag@sha256:" + "1" * 64
        inventory = json.loads(self.old.inventory.read_bytes())
        inventory[0] = native
        write(self.old.inventory, inventory)
        self.original = H["prepare_request"]([self.old.run], self.old.inventory, "c" * 32, "a" * 40)
        self.original["image_ref"] = native["config"]["image"]
        self.original["task_names"] = json.loads((ROOT / "scripts/tests/fixtures/original600-tasks.json").read_text())
        row = self.original["candidates"][0]
        marker = dict(
            schema=H["SCHEMA"],
            state="RESERVED",
            cohort="c" * 32,
            machine_id=self.mid,
            volume_id=row["volume_id"],
            source_excluded=True,
            archive_sha256=row["archive_sha256"],
            harness_ref="a" * 40,
        )
        current = copy.deepcopy(native)
        current["instance_id"] = "reserved-instance"
        current["config"]["metadata"] = {H["MARKER"]: H["canonical"](marker).decode()}
        current["config"]["init"] = {"cmd": ["sleep", "infinity"]}
        self.current = current
        reserved = dict(
            row,
            source_instance_id=current["instance_id"],
            source_config_sha256=H["config_sha"](current["config"]),
            prior_marker=H["canonical"](marker).decode(),
            reservation=dict(
                cohort="c" * 32,
                marker=marker,
                instance_id=current["instance_id"],
                config_sha256=H["config_sha"](current["config"]),
            ),
        )
        self.request = dict(self.original, candidates=[reserved])
        self.request_path = write(self.outer / "archived-reuse-request.private.json", self.request)
        write(
            self.outer / "archived-reuse-original.private.json",
            dict(
                schema="original600-archived-admission-request-v1",
                request=self.original,
                sha256=hashlib.sha256(json.dumps(self.original, sort_keys=True, allow_nan=False).encode()).hexdigest(),
            ),
        )
        directory = self.outer / "archived-reuse-reservations" / self.mid
        write(directory / "original-native.json", native)
        intent = dict(current_version=native["instance_id"], config_sha256=H["config_sha"](current["config"]))
        write(directory / "intent.json", intent)
        write(directory / "dispatch-entered.json", dict(intent_sha256=H["sha"](H["canonical"](intent))))
        write(directory / "source-exclusion.json", dict(predecessor=row, marker=marker))
        write(directory / "reserved.json", reserved)
        self.wire = directory / "wire"
        for ordinal, method, path, body, response, headers in [
            (0, "GET", "", None, native, {"fly-machine-lease-nonce": "lease-fixture"}),
            (1, "POST", "/lease", {"ttl": 180}, {"data": {"nonce": "lease-fixture"}}, {}),
            (
                2,
                "POST",
                "",
                dict(config=current["config"], current_version=native["instance_id"], skip_launch=True),
                current,
                {"fly-machine-lease-nonce": "lease-fixture"},
            ),
            (3, "GET", "", None, current, {"fly-machine-lease-nonce": "lease-fixture"}),
            (4, "DELETE", "/lease", None, {}, {"fly-machine-lease-nonce": "lease-fixture"}),
        ]:
            folder = self.wire / str(ordinal)
            request = dict(app=H["APP"], method=method, path="/machines/" + self.mid + path, body=body, headers=headers)
            raw = H["canonical"](response)
            write(folder / "request.json", request)
            write(
                folder / "0001-wire.json",
                dict(
                    method=method,
                    path=request["path"],
                    status=200,
                    body_b64=base64.b64encode(raw).decode(),
                    sha256=H["sha"](raw),
                    monotonic_ns=ordinal,
                ),
            )
        self.closed = self.outer / "launch-1/run"
        shutil.copytree(self.old.run, self.closed)
        self.members = {}
        with tarfile.open(self.closed / "export/originals.tar.gz") as archive:
            for member in archive:
                if "/clones/" not in member.name:
                    self.members[member.name] = archive.extractfile(member).read()
        self.imported = "git-common/cloudbench-archived-reuse-" + self.request["cohort"] + ".json"
        self.members[self.imported] = self.request_path.read_bytes()
        self.seal()
        config = dict(
            source_ref="a" * 40,
            remote_files=[
                dict(relative_path=".git/" + Path(self.imported).name, sha256=H["sha"](self.members[self.imported]))
            ],
            remote_env=dict(CLOUDBENCH_ARCHIVED_REUSE_REQUEST_SHA256=H["sha"](self.members[self.imported])),
        )
        config_path = write(self.outer / "launch-1/config.private.json", config)
        write(
            self.outer / "controller-launch.intent.json",
            dict(
                config_path=str(config_path),
                config_sha256=H["sha"](config_path.read_bytes()),
                run_directory=str(self.closed),
            ),
        )
        inventory[0] = current
        self.inventory = write(self.outer / "inventory.private.json", inventory)

    def seal(self):
        export = self.closed / "export"
        files = {}
        with tarfile.open(export / "originals.tar.gz", "w:gz") as archive:
            for name, data in self.members.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
                files[name] = dict(kind="file", bytes=len(data), sha256=H["sha"](data))
        (export / "originals.tar.gz").chmod(0o600)
        manifest = json.loads((export / "manifest.json").read_bytes())
        manifest.update(files=files, archive_sha256=H["sha"]((export / "originals.tar.gz").read_bytes()))
        write(export / "manifest.json", manifest)
        verified = json.loads((export / "disposable-export.verified.json").read_bytes())
        verified["files"] = {
            name: H["sha"]((export / name).read_bytes())
            for name in ("caller.json", "launch.json", "manifest.json", "originals.tar.gz")
        }
        verified["authority_sha256"] = H["sha"]((self.closed / "authority.private.json").read_bytes())
        write(export / "disposable-export.verified.json", verified)
        cleanup = json.loads((self.closed / "cleanup-call.intent.json").read_bytes())
        cleanup["export_verified_file"] = H["sha"]((export / "disposable-export.verified.json").read_bytes())
        write(self.closed / "cleanup-call.intent.json", cleanup)

    def test_closed_unused_reservation_preserves_lineage_without_credit(self):
        value = M["prepare"](self.outer, self.inventory)
        self.assertEqual(len(value["candidates"]), 1)
        row = value["candidates"][0]
        self.assertNotIn("reservation", row)
        self.assertEqual(row["predecessor"], self.original["candidates"][0]["predecessor"])
        self.assertEqual(row["legacy_archive_sha256"], self.original["candidates"][0]["archive_sha256"])
        self.assertEqual(row["prior_marker"], self.request["candidates"][0]["prior_marker"])
        self.assertIn("UNRESOLVED", row["prior_liabilities"])
        self.assertEqual(row["source_instance_id"], self.current["instance_id"])
        self.assertIn(str(self.wire / "2/0001-wire.json"), value["archive"]["inputs"])

    def successor_fixture(self, payload=False):
        launch_path = self.outer / "controller-launch.intent.json"
        launch = json.loads(launch_path.read_bytes())
        original_config = Path(launch["config_path"])
        failure = (
            dict(
                schema="observed-host-prelaunch-refusal-v1",
                tool_reported_exit_code=1,
                error="compressed launch payload too large for config transport",
                gate_created=False,
            )
            if payload
            else dict(
                schema="observed-tool-session-join-v1",
                tool_reported_exit_code=1,
                log_contains_synchronous_popen_errno=7,
                gate_pid="NOT_CREATED_BY_FAILED_POPEN",
            )
        )
        failure_path = write(
            self.outer / "bound-continuation-popen-failure.safe.json",
            failure,
        )
        prefix = "run-after-prelaunch-" if payload else "run-after-popen-"
        evidence = dict(
            path=str(failure_path),
            sha256=H["sha"](failure_path.read_bytes()),
            prior_output=str(self.closed),
            successor_output=str(self.closed.parent / (prefix + H["sha"](failure_path.read_bytes())[:16])),
        )
        successor = Path(evidence["successor_output"])
        self.closed.rename(successor)
        self.closed.mkdir(mode=0o700)
        provenance = dict(
            original_config_path=str(original_config),
            original_config_sha256=launch["config_sha256"],
            original_launch_intent_sha256=H["sha"](launch_path.read_bytes()),
            prelaunch_failure=evidence,
        )
        derived = dict(json.loads(original_config.read_bytes()), host_operator_provenance=provenance)
        derived_path = write(self.outer / "bound-continuation-123/config.private.json", derived)
        pointer = dict(
            schema="original600-host-launch-successor-v1",
            config_path=str(derived_path),
            config_sha256=H["sha"](derived_path.read_bytes()),
            evidence=evidence,
        )
        pointer_path = write(self.closed / "host-launch-successor.json", pointer)
        write(successor / "host-operator-provenance.json", provenance)
        self.assertFalse((self.outer / "derived-config.private.json").exists())
        return derived_path, pointer_path, pointer

    def test_successor_uses_recorded_canonical_config_without_alias(self):
        derived_path, pointer_path, pointer = self.successor_fixture()
        value = M["prepare"](self.outer, self.inventory)
        self.assertEqual([row["machine_id"] for row in value["candidates"]], [self.mid])
        self.assertIn(str(derived_path), value["archive"]["inputs"])
        pointer["config_path"] = str(self.outer.parent / "bound-continuation-123/config.private.json")
        write(pointer_path, pointer)
        with self.assertRaises(ValueError):
            M["prepare"](self.outer, self.inventory)

    def test_payload_refusal_successor_keeps_complete_unused_proof(self):
        derived_path, _, _ = self.successor_fixture(payload=True)
        value = M["prepare"](self.outer, self.inventory)
        self.assertEqual([row["machine_id"] for row in value["candidates"]], [self.mid])
        self.assertIn(str(derived_path), value["archive"]["inputs"])

    def test_allocation_or_pre_effect_claim_blocks_unused_classification(self):
        for suffix, payload in [
            ("archived-reuse-proof.json", {"machine_id": self.mid}),
            ("archived-reuse-journal/source-exclusion.json", {"proof": {"machine_id": self.mid}}),
            (".cid", "archived-reuse " + self.mid),
        ]:
            name = "context/fleet/runs/new/task/" + suffix
            self.members[name] = payload.encode() if isinstance(payload, str) else H["canonical"](payload)
            self.seal()
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                M["prepare"](self.outer, self.inventory)
            del self.members[name]

    def test_missing_or_tampered_native_receipts_fail_closed(self):
        for path in [
            self.wire / "2/0001-wire.json",
            self.wire / "3/0001-wire.json",
            self.wire / "1/0001-wire.json",
            self.outer / "archived-reuse-reservations" / self.mid / "dispatch-entered.json",
        ]:
            before = path.read_bytes()
            path.unlink()
            try:
                with self.subTest(path=path.name), self.assertRaises((ValueError, FileNotFoundError)):
                    M["prepare"](self.outer, self.inventory)
            finally:
                path.write_bytes(before)
                path.chmod(0o600)
        path = self.wire / "2/0001-wire.json"
        value = json.loads(path.read_bytes())
        value["sha256"] = "0" * 64
        write(path, value)
        with self.assertRaises(ValueError):
            M["prepare"](self.outer, self.inventory)

    def test_second_unsuccessful_post_and_global_claim_cache_are_not_hidden(self):
        folder = self.wire / "5"
        shutil.copytree(self.wire / "2", folder)
        record = json.loads((folder / "0001-wire.json").read_bytes())
        record.update(status=499, body_b64=base64.b64encode(b"unknown").decode(), sha256=H["sha"](b"unknown"))
        write(folder / "0001-wire.json", record)
        with self.assertRaises(ValueError):
            M["prepare"](self.outer, self.inventory)
        shutil.rmtree(folder)
        for name in [
            "git-common/cloudbench-archived-reuse/current/" + self.mid + ".json",
            "git-common/cloudbench-native-effect-fences/" + ("e" * 32) + "/run/" + self.mid + "/stop/intent.json",
        ]:
            self.members[name] = H["canonical"]({"machine_id": self.mid})
            self.seal()
            with self.subTest(name=name), self.assertRaises(ValueError):
                M["prepare"](self.outer, self.inventory)
            del self.members[name]

    def test_protected_changed_native_and_request_mismatch_are_denied(self):
        before = self.inventory.read_bytes()
        for field, value in [("instance_id", "foreign"), ("name", "renamed"), ("state", "started")]:
            inventory = json.loads(before)
            inventory[0][field] = value
            write(self.inventory, inventory)
            with self.subTest(field=field), self.assertRaises(ValueError):
                M["prepare"](self.outer, self.inventory)
        self.inventory.write_bytes(before)
        authority = json.loads((self.closed / "authority.private.json").read_bytes())
        authority["protected_machines"].append(self.mid)
        write(self.closed / "authority.private.json", authority)
        self.seal()
        with self.assertRaises(ValueError):
            M["prepare"](self.outer, self.inventory)

    def test_imported_request_and_full_membership_must_match(self):
        self.members[self.imported] = H["canonical"](dict(self.request, cohort="9" * 32))
        self.seal()
        with self.assertRaises(ValueError):
            M["prepare"](self.outer, self.inventory)


if __name__ == "__main__":
    unittest.main()
