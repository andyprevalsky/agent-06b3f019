#!/usr/bin/env python3
"""Saved archive/journal controls; no native transport or credentials."""

import base64
import copy
import hashlib
import io
import json
import os
import socket
from types import SimpleNamespace
from pathlib import Path
import runpy
import shutil
import subprocess
import tarfile
import unittest
from unittest import mock

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
                if data is None:
                    member.type = tarfile.DIRTYPE
                    archive.addfile(member)
                    files[name] = dict(kind="directory")
                elif isinstance(data, tuple):
                    kind, target = data
                    member.type = tarfile.SYMTYPE if kind == "symlink" else tarfile.LNKTYPE
                    member.linkname = target
                    archive.addfile(member)
                    files[name] = dict(kind=kind, target=target)
                else:
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
                    files[name] = dict(kind="file", bytes=len(data), sha256=H["sha"](data))
        (export / "originals.tar.gz").chmod(0o600)
        manifest = json.loads((export / "manifest.json").read_bytes())
        manifest.update(
            files=files,
            archive_sha256=H["sha"]((export / "originals.tar.gz").read_bytes()),
        )
        write(export / "manifest.json", manifest)
        verified = json.loads((export / "disposable-export.verified.json").read_bytes())
        verified["files"] = {
            name: H["sha"]((export / name).read_bytes())
            for name in (
                "caller.json",
                "launch.json",
                "manifest.json",
                "originals.tar.gz",
            )
        }
        verified["authority_sha256"] = H["sha"]((self.closed / "authority.private.json").read_bytes())
        write(export / "disposable-export.verified.json", verified)
        cleanup = json.loads((self.closed / "cleanup-call.intent.json").read_bytes())
        cleanup["export_verified_file"] = H["sha"]((export / "disposable-export.verified.json").read_bytes())
        write(self.closed / "cleanup-call.intent.json", cleanup)

    def cleanup_reserve_fixture(self):
        collector = runpy.run_path(str(ROOT / "scripts/cloudbench-controller-export.py"))
        physical = self.old.root / "producer"
        common, context, source = physical / "common", physical / ".context", physical / "scripts"
        for path in (common, context, source):
            path.mkdir(parents=True, mode=0o700)
        for name, data in self.members.items():
            prefix, tail = name.split("/", 1)
            target = (common if prefix == "git-common" else context) / tail
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o600)
        producer_bytes = (ROOT / "scripts/cloudbench-controller-export.py").read_bytes()
        (source / "cloudbench-controller-export.py").write_bytes(producer_bytes)
        reserve = common / "cloudbench-fleet-ownership" / ("e" * 32) / "cleanup-disk-reserve"
        reserve.parent.mkdir(parents=True, exist_ok=True)
        reserve.write_bytes(b"")  # Released reserve is a valid zero-byte original.
        reserve.chmod(0o600)
        export = self.closed / "export"
        record = json.loads((export / "launch.json").read_bytes())
        record.update(
            version=1,
            driver_pid=os.getpid(),
            driver_birth=collector["birth"](os.getpid()),
            host=record["host"],
            repo=str(physical),
            common_git=str(common),
            root_anchors={
                str(common): {key: collector["file_state"](common)[key] for key in ("device", "inode", "mode", "uid")}
            },
            temp_state_roots=[],
            collector_sha256=H["sha"](producer_bytes),
        )
        write(export / "launch.json", record)
        for name in ("manifest.json", "originals.tar.gz"):
            (export / name).unlink()
        args = SimpleNamespace(
            record=export / "launch.json",
            archive=export / "originals.tar.gz",
            manifest=export / "manifest.json",
            pending=export / "pending.json",
        )
        with (
            mock.patch.dict(
                collector["export"].__globals__,
                git=lambda _repo, *args: "" if args[0] == "diff" else record["source_ref"],
                controller_active_writers=lambda *_: [],
                writers=lambda *_: [],
            ),
            mock.patch.object(socket, "gethostname", return_value=record["host"]),
        ):
            self.assertEqual(collector["export"](args), 0)
        config_path = self.outer / "launch-1/config.private.json"
        config = json.loads(config_path.read_bytes())
        config["source_files"] = {"cloudbench-controller-export.py": H["sha"](producer_bytes)}
        write(config_path, config)
        launch_path = self.outer / "controller-launch.intent.json"
        launch = json.loads(launch_path.read_bytes())
        launch["config_sha256"] = H["sha"](config_path.read_bytes())
        write(launch_path, launch)
        self.rebind_reserve_export()
        return next(iter(json.loads((export / "manifest.json").read_bytes())["excluded"]))

    def rebind_reserve_export(self):
        export = self.closed / "export"
        verified = json.loads((export / "disposable-export.verified.json").read_bytes())
        verified["files"] = {name: H["sha"]((export / name).read_bytes()) for name in verified["files"]}
        write(export / "disposable-export.verified.json", verified)
        intent = json.loads((self.closed / "cleanup-call.intent.json").read_bytes())
        intent["export_verified_file"] = H["sha"]((export / "disposable-export.verified.json").read_bytes())
        write(self.closed / "cleanup-call.intent.json", intent)

    def test_canonical_export_cleanup_reserve_is_zero_credit_metadata(self):
        name = self.cleanup_reserve_fixture()
        value = M["prepare"](self.outer, self.inventory)
        self.assertEqual([row["machine_id"] for row in value["candidates"]], [self.mid])
        proof = value["archive"]["cleanup_reserve_exclusions"]
        self.assertEqual(proof["claim_credit"], 0)
        self.assertFalse(proof["payload_read"])
        self.assertEqual(proof["excluded"][name]["stat"]["bytes"], 0)
        path = self.closed / "export/manifest.json"
        original = json.loads(path.read_bytes())
        for mutation in ("reason", "escape", "claim", "mode", "alias", "source", "uid", "tamper"):
            manifest = copy.deepcopy(original)
            entry = manifest["excluded"][name]
            if mutation == "reason":
                entry["reason"] = "foreign"
            elif mutation == "escape":
                entry["source_path"] += "/../claim"
            elif mutation == "claim":
                manifest["excluded"][name.replace("cleanup-disk-reserve", "claim.json")] = manifest["excluded"].pop(
                    name
                )
            elif mutation == "mode":
                entry["stat"]["mode"] = 0o100644
            elif mutation == "alias":
                manifest["files"][str(Path(name).parent)] = dict(kind="symlink", target="foreign")
            elif mutation == "source":
                manifest["record"]["collector_sha256"] = "0" * 64
            elif mutation == "uid":
                entry["stat"]["uid"] += 1
            else:
                entry["stat"]["nlink"] = 2
            write(path, manifest)
            self.rebind_reserve_export()
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                M["prepare"](self.outer, self.inventory)
        write(path, original)
        self.rebind_reserve_export()

    def inventory_pointer_fixture(self):
        parent = "context/fleet/runs/20261017-225357-1706/inventory"
        target = ".generation-fixture"
        generation = parent + "/" + target
        self.members[parent] = None
        self.members[parent + "/current"] = ("symlink", target)
        for name in (generation, generation + "/machines", generation + "/names"):
            self.members[name] = None
        self.members[generation + "/health"] = (
            b"publisher_token=fixture\nvalid_until=123\ngeneration=.generation-fixture\n"
        )
        self.members[generation + "/published_at"] = b"1\n"
        self.members[generation + "/admission-machines.json"] = b"[]\n"
        self.members[generation + "/machines/" + self.mid] = b"state=stopped\n"
        self.members[generation + "/names/cloudbench-fixture"] = (self.mid + "\n").encode()
        source = (ROOT / "scripts/cloudbench-machine-readiness.py").read_bytes()
        self.members["source/scripts/cloudbench-machine-readiness.py"] = source
        config_path = self.outer / "launch-1/config.private.json"
        config = json.loads(config_path.read_bytes())
        config["source_files"] = {"cloudbench-machine-readiness.py": H["sha"](source)}
        write(config_path, config)
        launch_path = self.outer / "controller-launch.intent.json"
        launch = json.loads(launch_path.read_bytes())
        launch["config_sha256"] = H["sha"](config_path.read_bytes())
        write(launch_path, launch)
        self.seal()
        return parent, generation

    def test_inventory_current_pointer_is_cache_not_claim_authority(self):
        self.inventory_pointer_fixture()
        result = M["prepare"](self.outer, self.inventory)
        self.assertEqual([row["machine_id"] for row in result["candidates"]], [self.mid])
        proof = result["archive"]["inventory_pointer_proof"]
        self.assertFalse(proof["followed"])
        self.assertEqual(proof["claim_credit"], 0)
        self.assertEqual(proof["capacity_credit"], 0)

    def test_inventory_pointer_rejects_unsafe_foreign_and_missing_targets(self):
        parent, generation = self.inventory_pointer_fixture()
        for target in (
            "/tmp/foreign",
            "../../claim",
            ".generation-fixture/../foreign",
            ".generation-missing",
        ):
            self.members[parent + "/current"] = ("symlink", target)
            self.seal()
            with self.subTest(target=target), self.assertRaises(ValueError):
                M["prepare"](self.outer, self.inventory)
        self.members[parent + "/current"] = ("symlink", Path(generation).name)
        self.members[generation + "/machines/" + self.mid] = ("symlink", "../../claim")
        self.seal()
        with self.assertRaises(ValueError):
            M["prepare"](self.outer, self.inventory)
        self.members[generation + "/machines/" + self.mid] = (
            "hardlink",
            generation + "/health",
        )
        self.seal()
        with self.assertRaises(ValueError):
            M["prepare"](self.outer, self.inventory)
        self.members[generation + "/machines/" + self.mid] = b"state=stopped\n"
        foreign = "context/fleet/runs/foreign/inventory/current"
        self.members[foreign] = ("symlink", Path(generation).name)
        self.seal()
        with self.assertRaisesRegex(ValueError, "claim namespace contains an alias"):
            M["prepare"](self.outer, self.inventory)
        del self.members[foreign]
        self.members["context/fleet/runs/20261017-225357-1706/task/archived-reuse-journal/current"] = (
            "symlink",
            ".generation-fixture",
        )
        self.seal()
        with self.assertRaisesRegex(ValueError, "claim namespace contains an alias"):
            M["prepare"](self.outer, self.inventory)

    def test_inventory_pointer_tar_and_manifest_must_match(self):
        parent, _ = self.inventory_pointer_fixture()
        manifest_path = self.closed / "export/manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["files"][parent + "/current"]["target"] = ".generation-other"
        write(manifest_path, manifest)
        verified_path = self.closed / "export/disposable-export.verified.json"
        verified = json.loads(verified_path.read_bytes())
        verified["files"]["manifest.json"] = H["sha"](manifest_path.read_bytes())
        write(verified_path, verified)
        cleanup_path = self.closed / "cleanup-call.intent.json"
        cleanup = json.loads(cleanup_path.read_bytes())
        cleanup["export_verified_file"] = H["sha"](verified_path.read_bytes())
        write(cleanup_path, cleanup)
        with self.assertRaises(ValueError):
            M["prepare"](self.outer, self.inventory)

    def test_closed_startup_binds_real_host_request_without_claiming_import(self):
        config = json.loads((self.outer / "launch-1/config.private.json").read_bytes())
        self.old.root = self.outer / "launch-1"
        self.old.run = self.closed
        self.old.startup_fixture()
        closure = M["CLOSED"]["prepare"](self.closed, self.inventory)
        source = self.closed.parent / "archived-reuse-request.private.json"
        source.write_bytes(self.request_path.read_bytes())
        source.chmod(0o600)
        config["remote_files"][0]["source_path"] = str(source)
        config["remote_env"]["CLOUDBENCH_ARCHIVED_REUSE_REQUEST"] = "/tmp/gate/repo/.git/" + Path(self.imported).name
        inputs = {}
        claimed, digest, custody = M["archive_members"](self.closed, closure, self.request, config, inputs)
        self.assertEqual(claimed, {})
        self.assertEqual(custody, "HOST_BOUND_NOT_IMPORTED")
        self.assertEqual(digest, H["sha"](self.request_path.read_bytes()))
        self.assertIn(str(source), inputs)
        self.assertNotIn(
            self.imported,
            json.loads((self.closed / "export/manifest.json").read_bytes())["files"],
        )
        baseline = self.outer / "baseline"
        baseline.mkdir(mode=0o700)
        for path in (ROOT / "scripts").glob("*.py"):
            if path.name != "cloudbench-unused-reservations.py":
                (baseline / path.name).symlink_to(path)
        old = baseline / "cloudbench-unused-reservations.py"
        old.write_bytes(
            subprocess.check_output(
                [
                    "git",
                    "show",
                    "0ec5672c3f98f8c553f1430dd2ce8d0f427ea255:scripts/cloudbench-unused-reservations.py",
                ],
                cwd=ROOT,
            )
        )
        previous = runpy.run_path(str(old))
        with self.assertRaisesRegex(ValueError, "imported another reservation"):
            previous["archive_members"](self.closed, closure, self.request, config, {})
        ordinary = dict(closure)
        ordinary.pop("startup_closure")
        with self.assertRaisesRegex(ValueError, "imported another reservation"):
            M["archive_members"](self.closed, ordinary, self.request, config, {})
        altered = copy.deepcopy(config)
        altered["remote_files"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "input hash differs"):
            M["archive_members"](self.closed, closure, self.request, altered, {})
        source.write_bytes(self.request_path.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "copies differ"):
            M["archive_members"](self.closed, closure, self.request, config, {})

    def test_normal_omissions_and_inherited_scopes_remain_zero_credit_holds(self):
        omitted = "bbbbccccddddee"
        row = copy.deepcopy(self.original["candidates"][0])
        row.update(machine_id=omitted, volume_id="vol_failed")
        row["predecessor"].update(id=omitted, volume_id="vol_failed")
        self.original["candidates"].append(row)
        origin = self.original["archives"][0]["archive_sha256"]
        scopes = [
            dict(
                archive_sha256=origin,
                machine_ids=[self.mid, omitted],
                reuse_credit=False,
            )
        ]
        historical = dict(
            archive_sha256="f6bf27e51320b26578339dc57e687a617509dcab5b666cfddb8008d29ebf6a2f",
            machine_ids=[
                "2862594a567538",
                "80e90dec34e118",
                "845037f2d321e8",
                "876d20f01e46e8",
                "8911000c6397d8",
                "897915b66010d8",
                "8d2020fe1d5648",
            ],
            reuse_credit=False,
        )
        self.assertNotIn(historical["archive_sha256"], {a["archive_sha256"] for a in self.original["archives"]})
        scopes.append(historical)
        self.original["held_prior_reservations"] = copy.deepcopy(scopes)
        self.request["held_prior_reservations"] = copy.deepcopy(scopes)
        failure = dict(
            machine_id=omitted,
            not_credited=True,
            error_type="TimeoutExpired",
            error="old outcome UNKNOWN",
        )
        self.request["held_native_reservations"] = [failure]
        journal = self.outer / "archived-reuse-reservations" / omitted
        evidence = write(journal / "held-original.json", failure)
        partial = journal / "wire/request.json"
        partial.parent.mkdir(mode=0o700)
        partial.write_bytes(b"")
        partial.chmod(0o600)
        write(self.request_path, self.request)
        write(
            self.outer / "archived-reuse-original.private.json",
            dict(
                schema="original600-archived-admission-request-v1",
                request=self.original,
                sha256=H["sha"](json.dumps(self.original, sort_keys=True, allow_nan=False).encode()),
            ),
        )
        self.members[self.imported] = self.request_path.read_bytes()
        self.seal()
        config_path = self.outer / "launch-1/config.private.json"
        config = json.loads(config_path.read_bytes())
        digest = H["sha"](self.request_path.read_bytes())
        config["remote_files"][0]["sha256"] = digest
        config["remote_env"]["CLOUDBENCH_ARCHIVED_REUSE_REQUEST_SHA256"] = digest
        write(config_path, config)
        launch_path = self.outer / "controller-launch.intent.json"
        launch = json.loads(launch_path.read_bytes())
        launch["config_sha256"] = H["sha"](config_path.read_bytes())
        write(launch_path, launch)
        value = M["prepare"](self.outer, self.inventory)
        self.assertEqual([r["machine_id"] for r in value["candidates"]], [self.mid])
        self.assertEqual(value["held_machine_ids"], [omitted])
        self.assertEqual(value["inherited_held_scopes"], scopes)
        held = value["held_reservations"][0]
        self.assertEqual(held["volume_id"], "vol_failed")
        self.assertEqual(held["error"], failure["error"])
        self.assertEqual(held["capacity_credit"], 0)
        self.assertFalse(held["reuse_credit"])
        self.assertIn(str(evidence), value["archive"]["inputs"])
        self.assertEqual(value["archive"]["inputs"][str(partial)], H["sha"](b""))
        baseline = self.outer / "baseline-normal"
        baseline.mkdir(mode=0o700)
        for path in (ROOT / "scripts").glob("*.py"):
            if path.name != "cloudbench-unused-reservations.py":
                (baseline / path.name).symlink_to(path)
        old = baseline / "cloudbench-unused-reservations.py"
        old.write_bytes(
            subprocess.check_output(
                [
                    "git",
                    "show",
                    "55de5e0b9ee5f0bf89b52b3c9c2445fd65f8aac3:scripts/cloudbench-unused-reservations.py",
                ],
                cwd=ROOT,
            )
        )
        previous = runpy.run_path(str(old))["prepare"](self.outer, self.inventory)
        self.assertEqual(previous["held_machine_ids"], [])
        self.assertNotIn("inherited_held_scopes", previous)
        old.write_bytes(
            subprocess.check_output(
                ["git", "show", "52ce8fb026e92075cf8fd1a2fb95a769e8e5b07f:scripts/cloudbench-unused-reservations.py"],
                cwd=ROOT,
            )
        )
        with self.assertRaisesRegex(ValueError, "inherited normal hold"):
            runpy.run_path(str(old))["prepare"](self.outer, self.inventory)
        malformed = copy.deepcopy(self.original)
        malformed["held_prior_reservations"][-1]["archive_sha256"] = "not-a-hash"
        with self.assertRaisesRegex(ValueError, "inherited normal hold"):
            M["normal_hold_partition"](self.outer, malformed, self.request, {})
        bad = copy.deepcopy(self.request)
        bad["held_native_reservations"] = []
        with self.assertRaisesRegex(ValueError, "partition differs"):
            M["normal_hold_partition"](self.outer, self.original, bad, {})
        bad = copy.deepcopy(self.original)
        bad["held_prior_reservations"][0]["reuse_credit"] = True
        with self.assertRaisesRegex(ValueError, "inherited normal hold"):
            M["normal_hold_partition"](self.outer, bad, self.request, {})

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

    def test_closed_recovery_routes_bound_launch_request_without_outer_alias(self):
        config_path = self.outer / "launch-1/config.private.json"
        config = json.loads(config_path.read_bytes())
        config["host_operator_provenance"] = {"incomplete_admission": {"fixture": True}}
        write(config_path, config)
        launch_path = self.outer / "controller-launch.intent.json"
        launch = json.loads(launch_path.read_bytes())
        launch["config_sha256"] = H["sha"](config_path.read_bytes())
        write(launch_path, launch)
        bound = write(config_path.parent / "archived-reuse-request.private.json", self.request)
        self.request_path.unlink()
        context = {"request": self.request, "original": self.original, "held_rows": [], "inherited_held_scopes": []}
        calls = []

        def load(outer, closed, actual_config, closure, inputs):
            self.assertEqual((outer, closed), (self.outer, self.closed))
            self.assertEqual(actual_config, config)
            self.assertIn("archived_ownership", closure)
            M["read"](bound, inputs)
            calls.append("load")
            return context

        def validate(actual, original, reserved, current, inputs):
            self.assertIs(actual, context)
            calls.append("validate")
            return M["validate_candidate"](
                self.outer,
                original,
                reserved,
                current,
                self.request["cohort"],
                self.request["harness_ref"],
                inputs,
            )

        with mock.patch.dict(M["prepare"].__globals__, recovered_reader=lambda: {"load": load, "validate": validate}):
            result = M["prepare"](self.outer, self.inventory)
        self.assertEqual(calls, ["load", "validate"])
        self.assertEqual([r["machine_id"] for r in result["candidates"]], [self.mid])
        self.assertNotIn("reservation", result["candidates"][0])
        self.assertFalse(self.request_path.exists())
        omitted = copy.deepcopy(self.original["candidates"][0])
        omitted.update(machine_id="bbbbccccddddee", volume_id="vol_held")
        omitted["predecessor"].update(id=omitted["machine_id"], volume_id=omitted["volume_id"])
        self.original["candidates"].append(omitted)
        write(
            self.outer / "archived-reuse-original.private.json",
            {
                "schema": "original600-archived-admission-request-v1",
                "request": self.original,
                "sha256": H["sha"](json.dumps(self.original, sort_keys=True, allow_nan=False).encode()),
            },
        )
        context["held_rows"] = [{"machine_id": omitted["machine_id"], "volume_id": omitted["volume_id"]}]
        context["inherited_held_scopes"] = [
            {
                "archive_sha256": self.original["archives"][0]["archive_sha256"],
                "machine_ids": [self.mid],
                "reuse_credit": False,
            }
        ]
        with mock.patch.dict(M["prepare"].__globals__, recovered_reader=lambda: {"load": load, "validate": validate}):
            result = M["prepare"](self.outer, self.inventory)
        self.assertEqual(result["held_machine_ids"], [omitted["machine_id"]])
        self.assertEqual(result["held_reservations"][0]["capacity_credit"], 0)
        self.assertEqual(result["inherited_held_scopes"], context["inherited_held_scopes"])

    def test_repeated_unused_succession_preserves_original_archive_lineage(self):
        legacy = "e" * 64
        self.original["candidates"][0]["legacy_archive_sha256"] = legacy
        self.request["candidates"][0]["legacy_archive_sha256"] = legacy
        write(self.request_path, self.request)
        write(
            self.outer / "archived-reuse-original.private.json",
            dict(
                schema="original600-archived-admission-request-v1",
                request=self.original,
                sha256=hashlib.sha256(json.dumps(self.original, sort_keys=True, allow_nan=False).encode()).hexdigest(),
            ),
        )
        directory = self.outer / "archived-reuse-reservations" / self.mid
        exclusion = json.loads((directory / "source-exclusion.json").read_bytes())
        exclusion["predecessor"] = self.original["candidates"][0]
        write(directory / "source-exclusion.json", exclusion)
        write(directory / "reserved.json", self.request["candidates"][0])
        self.members[self.imported] = self.request_path.read_bytes()
        self.seal()
        config_path = self.outer / "launch-1/config.private.json"
        config = json.loads(config_path.read_bytes())
        request_sha = H["sha"](self.request_path.read_bytes())
        config["remote_files"][0]["sha256"] = request_sha
        config["remote_env"]["CLOUDBENCH_ARCHIVED_REUSE_REQUEST_SHA256"] = request_sha
        write(config_path, config)
        launch_path = self.outer / "controller-launch.intent.json"
        launch = json.loads(launch_path.read_bytes())
        launch["config_sha256"] = H["sha"](config_path.read_bytes())
        write(launch_path, launch)
        value = M["prepare"](self.outer, self.inventory)
        self.assertEqual(value["candidates"][0]["legacy_archive_sha256"], legacy)
        self.assertEqual(value["candidates"][0]["predecessor"], self.original["candidates"][0]["predecessor"])

    def successor_fixture(self, payload=False, typed=False):
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
        if typed:
            payload = True
            failure = dict(
                schema="original600-host-payload-failure-v1",
                gate_created=False,
                reason="compressed launch payload too large for config transport",
                config_path=str(original_config),
                config_sha256=launch["config_sha256"],
                source_ref=json.loads(original_config.read_bytes())["source_ref"],
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
        if typed:
            failure_path.unlink()
            failure_path = write(self.closed / "launch-payload-failure.json", failure)
            evidence["path"] = str(failure_path)
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

    def unstarted_fixture(self, protected=False):
        reader = M["recovered_reader"]()
        config_path = self.outer / "launch-1/config.private.json"
        request = dict(self.request, held_native_reservations=[])
        raw_request = H["canonical"](request) + b"\n"
        plan = dict(
            schema="closed-admission-continuation-v1",
            request=self.original,
            classifications=[],
            inputs={},
            deadline=5401,
            started_at=1,
            retained_request=self.request,
            retained_lanes={self.mid: "ORIGINAL_CLOSED"},
        )
        journal = self.outer / "incomplete-admission-recovery"
        journal.mkdir(mode=0o700)
        identity = H["sha"](H["canonical"](plan))
        write(
            journal / "intent.json",
            dict(
                identity_sha256=identity,
                original_deadline=5401,
                old_journal_immutable=True,
            ),
        )
        write(
            journal / "complete.json",
            dict(
                identity_sha256=identity,
                original_deadline=5401,
                cancelled_signals=[],
                old_failures_retained=True,
                task_credit=0,
                request_sha256=H["sha"](raw_request),
                held=[],
                results=[dict(machine_id=self.mid, lane="RETAINED", old_failure_retained=True)],
            ),
        )
        (journal / "request.json").write_bytes(raw_request)
        (journal / "request.json").chmod(0o600)
        launch_request = config_path.parent / "archived-reuse-request.private.json"
        launch_request.write_bytes(raw_request)
        launch_request.chmod(0o600)
        provenance = dict(
            host_operator_source_ref="fc005c2075f349b6380f9627c908ac329c6c2be8",
            workload_source_ref="a" * 40,
            original_started_at_epoch=1,
            incomplete_admission=dict(
                source_ref="fc005c2075f349b6380f9627c908ac329c6c2be8",
                original_plan_sha256=H["sha"](json.dumps(plan, sort_keys=True, allow_nan=False).encode()),
            ),
        )
        config = dict(
            source_ref="a" * 40,
            started_at_epoch=1,
            host_operator_provenance=provenance,
            remote_files=[
                dict(
                    relative_path=".git/cloudbench-archived-reuse-" + request["cohort"] + ".json",
                    source_path=str(launch_request),
                    sha256=H["sha"](raw_request),
                )
            ],
            remote_env=dict(CLOUDBENCH_ARCHIVED_REUSE_REQUEST_SHA256=H["sha"](raw_request)),
        )
        write(config_path, config)
        write(
            self.outer / "controller-launch.intent.json",
            dict(
                config_path=str(config_path),
                config_sha256=H["sha"](config_path.read_bytes()),
                run_directory=str(self.closed),
            ),
        )
        shutil.rmtree(self.closed)
        self.closed.mkdir(mode=0o700)
        export = self.closed / "export"
        export.mkdir(mode=0o700)
        env = {"agents": b"AGENT=fixture\n", "backend": b"BACKEND=fixture\n"}
        for key, raw in env.items():
            path = export / ("current-" + key + ".private.env")
            path.write_bytes(raw)
            path.chmod(0o600)
        authority = dict(
            source_ref="a" * 40,
            app="navi-whisper-lux-bench",
            region="iad",
            output_directory=str(export),
            cleanup_owner_pid=123,
            cleanup_owner_birth="caller-birth",
            protected_volumes=[],
            protected_machines=[self.mid] if protected else [],
            env_files={k: dict(sha256=H["sha"](v)) for k, v in env.items()},
        )
        authpath = write(self.closed / "authority.private.json", authority)
        authsha = H["sha"](authpath.read_bytes())
        caller = dict(
            source_ref="a" * 40,
            epoch=1,
            deadline=5401,
            pid=123,
            birth="caller-birth",
            gate_pid=124,
            gate_birth="gate-birth",
            authority_sha256=authsha,
        )
        write(self.closed / "caller.json", caller)
        gate_caller = dict(pid=124, birth="gate-birth", host="fixture")
        gp = write(export / "caller.json", gate_caller)
        vp = write(
            export / "workspace-volume.intent.json",
            dict(caller=gate_caller, caller_sha256=H["sha"](gp.read_bytes())),
        )
        native = dict(
            id="vol_workspace",
            name="cbgate_fixture",
            region="iad",
            size_gb=256,
            encrypted=True,
            state="created",
            attached_machine_id=None,
        )
        np = write(export / "workspace-volume-create.private.json", native)
        workspace = dict(
            schema="cloudbench-controller-workspace-ownership-v1",
            source_ref="a" * 40,
            app=authority["app"],
            size_gb=256,
            mount_path="/tmp/gate",
            volume_id=native["id"],
            name=native["name"],
            native_create=native,
            native_create_sha256=H["sha"](np.read_bytes()),
            intent_sha256=H["sha"](vp.read_bytes()),
            caller=gate_caller,
            caller_sha256=H["sha"](gp.read_bytes()),
        )
        write(export / "workspace-volume.ownership.json", workspace)
        empty = export / "workspace-volume-create.stderr.private.log"
        empty.write_bytes(b"")
        empty.chmod(0o600)
        write(
            export / "disposable-delete-volume.intent.json",
            dict(authority_sha256=authsha, kind="volume", identifier=native["id"]),
        )
        release = dict(
            machine_id=None,
            volume_id=native["id"],
            volume_disposition="pending_destroy",
            no_live_machine_observed=True,
            command_history_verified=False,
        )
        release_path = write(export / "disposable-controller.release.json", release)
        write(
            self.closed / "terminal.json",
            dict(
                status="FAILED_STARTUP_WORKSPACE_RELEASED",
                machine=None,
                gate_exit_code=1,
                controller_cleanup_exit_code=1,
                externally_reconciled_after_helper_failure=True,
                release=release,
                source_ref="a" * 40,
                started_at_epoch=1,
                original_deadline=5401,
                benchmark_success_inferred=False,
            ),
        )
        write(
            self.closed / "cleanup-call.intent.json",
            dict(
                action="cleanup-workspace",
                machine=None,
                gate_joined=True,
                supervisor_joined=False,
                export_verified_file=None,
            ),
        )
        write(self.closed / "cleanup.pending.json", dict(helper_exit_code=1))
        write(self.closed / "gate.pending.json", dict(gate_exit_code=1))
        log = self.closed / "gate.private.log"
        log.write_bytes(
            b"in backup_off\nnative.get(key)\nAttributeError: 'NoneType' object has no attribute 'get'\nGATE_WORKSPACE_VOLUME_RETAINED id=vol_workspace\n"
        )
        log.chmod(0o600)
        write(self.closed / "host-operator-provenance.json", provenance)
        write(
            self.closed / "observed-closure.safe.json",
            dict(
                schema="original600-observed-closed-v1",
                run_directory=str(self.closed),
                original_tool_exit_code=1,
                release_observer_exit_code=0,
                caller_live=False,
                supervisor_published=False,
                task_attempts=0,
                caller_pid=123,
                gate_live=False,
                gate_pid=124,
                source_ref="a" * 40,
                started_at_epoch=1,
                original_deadline=5401,
                terminal_sha256=H["sha"]((self.closed / "terminal.json").read_bytes()),
                release_sha256=H["sha"](release_path.read_bytes()),
                observed_epoch=2,
                original_session=93834,
                release_observer_handle_kind="synchronous-terminal-chunk",
                release_observer_session="exec:b66c27",
            ),
        )
        write(
            self.closed / ("authority.private.json." + authsha + ".once"),
            dict(authority_sha256=authsha, driver_pid=124, driver_birth="gate-birth"),
        )
        write(self.closed / "controller-sidecars.private.json", [])
        payload = self.closed / "controller-launch-payload.private.json.gz"
        payload.write_bytes(b"fixture")
        payload.chmod(0o600)
        observation = self.closed / "workspace-release-observation"
        observation.mkdir(mode=0o700)
        binding_names = [
            "authority.private.json",
            "caller.json",
            "cleanup-call.intent.json",
            "cleanup.pending.json",
            "gate.pending.json",
            "gate.private.log",
            "export/disposable-delete-volume.intent.json",
            "export/workspace-volume.ownership.json",
        ]
        source_names = [
            "cloudbench-controller-export.py",
            "cloudbench-controller-payload-finalization.py",
            "cloudbench-disposable-controller.py",
            "cloudbench-original-volume-capture.py",
            "cloudbench-original600-runner.py",
            "cloudbench-resume-controller-payload.py",
            "run-cloudbench-controller-gate",
            "run-original600-controller.py",
        ]
        source_bytes = {
            name: subprocess.check_output(
                [
                    "git",
                    "-C",
                    str(ROOT),
                    "show",
                    "1cec8c1cb20c85e66e10cd49446b44c5e85101f1:scripts/" + name,
                ]
            )
            for name in source_names
        }
        check = dict(
            allowed_method="GET",
            allowed_path="/volumes/vol_workspace",
            bindings={n: H["sha"]((self.closed / n).read_bytes()) for n in binding_names},
            caller_pid=123,
            caller_birth="caller-birth",
            operator_sha256="4a16af376f7cb613c194f3e6baf4aaeb9e18da020f445658cb61f25fc6bd0f7f",
            source_pins={n: H["sha"](v) for n, v in source_bytes.items()},
            source_ref="a" * 40,
            volume_id="vol_workspace",
        )
        write(observation / "check.json", check)
        write(observation / "intent.json", dict(check, observed_epoch=2))
        released = dict(native, state="pending_destroy")
        for number in (1, 2):
            prefix = "wire-%06d" % number
            body = H["canonical"](released)
            write(
                observation / (prefix + ".request.json"),
                dict(method="GET", path=check["allowed_path"], body=None),
            )
            write(
                observation / (prefix + ".raw.json"),
                dict(
                    method="GET",
                    path=check["allowed_path"],
                    status=200,
                    body_b64=base64.b64encode(body).decode(),
                    bytes=len(body),
                    sha256=H["sha"](body),
                ),
            )
            write(observation / (prefix + ".decoded.json"), released)
        write(
            observation / "complete.json",
            dict(
                status="CANONICAL_RELEASE_WRITTEN",
                release_sha256=H["sha"](release_path.read_bytes()),
                provider_writes=0,
            ),
        )
        return reader, plan, source_bytes

    def test_closed_unstarted_admission_carries_only_proven_reservations_to_new_cohort(
        self,
    ):
        reader, plan, source_bytes = self.unstarted_fixture()
        real_git = reader["subprocess"].check_output

        def git(command, *args, **kwargs):
            if command[-1].startswith("a" * 40 + ":scripts/"):
                return source_bytes[command[-1].split(":scripts/", 1)[1]]
            return real_git(command, *args, **kwargs)

        module = H["module"]
        with (
            mock.patch.dict(M["prepare"].__globals__, recovered_reader=lambda: reader),
            mock.patch.dict(reader, closed_host=lambda ref, **_kwargs: ref),
            mock.patch.dict(
                reader["I"],
                CLOSED75_SOURCE="a" * 40,
                historical_plan=lambda *_args: plan,
            ),
            mock.patch.dict(
                reader["recovery_history"].__globals__,
                closed_host=lambda ref, **_kwargs: ref,
            ),
            mock.patch.object(reader["subprocess"], "check_output", side_effect=git),
            mock.patch.dict(
                H["prepare_request"].__globals__,
                module=lambda name: M if name == "cloudbench-unused-reservations.py" else module(name),
            ),
        ):
            result = M["prepare"](self.outer, self.inventory)
            self.assertEqual([r["machine_id"] for r in result["candidates"]], [self.mid])
            self.assertNotIn("reservation", result["candidates"][0])
            self.assertTrue(result["archive"]["closed_unstarted_admission"]["no_archive_claimed"])
            self.assertFalse((self.closed / "export/originals.tar.gz").exists())
            merged = H["prepare_request"](
                [self.old.run],
                self.inventory,
                "e" * 32,
                "a" * 40,
                unused_runs=[self.outer],
            )
            self.assertEqual([r["machine_id"] for r in merged["candidates"]], [self.mid])
            self.assertNotIn("reservation", merged["candidates"][0])
            extra = write(self.closed / "export/machine-create.intent.json", {})
            with self.assertRaises(ValueError):
                M["prepare"](self.outer, self.inventory)
            extra.unlink()
            current = json.loads(self.inventory.read_bytes())
            current[0]["config"] = None
            write(self.inventory, current)
            with self.assertRaises(ValueError):
                M["prepare"](self.outer, self.inventory)

    def test_closed_unstarted_admission_preserves_protected_machine_exclusion(self):
        reader, plan, source_bytes = self.unstarted_fixture(protected=True)
        real_git = reader["subprocess"].check_output

        def git(command, *args, **kwargs):
            if command[-1].startswith("a" * 40 + ":scripts/"):
                return source_bytes[command[-1].split(":scripts/", 1)[1]]
            return real_git(command, *args, **kwargs)

        with (
            mock.patch.dict(M["prepare"].__globals__, recovered_reader=lambda: reader),
            mock.patch.dict(reader, closed_host=lambda ref, **_kwargs: ref),
            mock.patch.dict(
                reader["I"],
                CLOSED75_SOURCE="a" * 40,
                historical_plan=lambda *_args: plan,
            ),
            mock.patch.dict(
                reader["recovery_history"].__globals__,
                closed_host=lambda ref, **_kwargs: ref,
            ),
            mock.patch.object(reader["subprocess"], "check_output", side_effect=git),
        ):
            with self.assertRaisesRegex(ValueError, "protected reservation"):
                M["prepare"](self.outer, self.inventory)

    def test_normal_bound_launch_with_null_failure_keeps_original_request_route(self):
        request, context = M["request_for_closed"](
            self.outer,
            self.closed,
            {"host_operator_provenance": {"prelaunch_failure": None}},
            {},
            {},
        )
        self.assertEqual(request, self.request)
        self.assertIsNone(context)

    def test_workspace_successor_routes_full_closed_recovery_without_outer_fallback(
        self,
    ):
        recovered_owner = runpy.run_path(str(ROOT / "scripts/tests/cloudbench-recovered-reservations.test.py"))
        fixture = recovered_owner["Recovered"]()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        reader = recovered_owner["M"]
        original_load = reader["load"]
        called = []

        def through_unused(outer, closed, config, closure, inputs):
            # The real successor writes its current provenance and imports the
            # selected recovery request, not the original partial request.
            write(
                closed / "host-operator-provenance.json",
                config["host_operator_provenance"],
            )
            if not called:
                fixture.f.closed = closed
                fixture.f.members[fixture.f.imported] = (fixture.journal / "request.json").read_bytes()
                fixture.f.seal()
            closure = M["CLOSED"]["prepare"](closed, fixture.f.inventory)
            # The reused reader fixture measures only R's large-archive hash.
            # U's existing inventory read is outside that memory assertion.
            tracing = recovered_owner["tracemalloc"]
            tracing.stop()
            result = M["prepare"](outer, fixture.f.inventory)
            if not called:
                old_run = Path(config["host_operator_provenance"]["prelaunch_failure"]["prior_output"])
                unexpected = write(old_run / "unrecorded.json", {"unknown": True})
                try:
                    with self.assertRaises(ValueError):
                        M["prepare"](outer, fixture.f.inventory)
                finally:
                    unexpected.unlink()
                pointer_path = old_run / "host-launch-successor.json"
                pointer = json.loads(pointer_path.read_bytes())
                write(
                    pointer_path,
                    dict(pointer, config_path=str(outer / "foreign/config.private.json")),
                )
                try:
                    with self.assertRaises(ValueError):
                        M["prepare"](outer, fixture.f.inventory)
                finally:
                    write(pointer_path, pointer)
            called.append(result)
            self.assertEqual([row["machine_id"] for row in result["candidates"]], [fixture.f.mid])
            tracing.start()
            return original_load(outer, closed, config, closure, inputs)

        dispatch = dict(reader, load=original_load)
        with (
            mock.patch.dict(M["prepare"].__globals__, recovered_reader=lambda: dispatch),
            mock.patch.dict(original_load.__globals__, closed_host=lambda ref, *_args, **_kwargs: ref),
            mock.patch.dict(reader["I"]["retained_native"].__globals__, CLOSED_SOURCE="a" * 40),
            mock.patch.dict(reader, load=through_unused),
        ):
            fixture.load_fixture(typed=True, successor=True)
        self.assertTrue(called)

    def test_typed_refusal_reads_exact_nested_receipt_without_alias(self):
        self.successor_fixture(typed=True)
        value = M["prepare"](self.outer, self.inventory)
        self.assertEqual([row["machine_id"] for row in value["candidates"]], [self.mid])
        self.assertIn(str(self.closed / "launch-payload-failure.json"), value["archive"]["inputs"])
        self.assertFalse((self.outer / "launch-payload-failure.json").exists())

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
            with self.subTest(suffix=suffix):
                result = M["prepare"](self.outer, self.inventory)
                self.assertEqual(result["candidates"], [])
                self.assertEqual(result["held_machine_ids"], [self.mid])
                self.assertEqual(result["held_reservations"][0]["capacity_credit"], 0)
            del self.members[name]

    def test_mixed_claimed_and_untouched_reservations_partition_without_credit(self):
        held = "bbbbccccddddee"
        original = copy.deepcopy(self.original["candidates"][0])
        original.update(machine_id=held, volume_id="vol_held")
        original["predecessor"].update(id=held, volume_id="vol_held")
        reserved = copy.deepcopy(self.request["candidates"][0])
        reserved.update(machine_id=held, volume_id="vol_held", predecessor=original["predecessor"])
        self.original["candidates"].append(original)
        self.request["candidates"].append(reserved)
        write(self.request_path, self.request)
        write(
            self.outer / "archived-reuse-original.private.json",
            {
                "schema": "original600-archived-admission-request-v1",
                "request": self.original,
                "sha256": hashlib.sha256(
                    json.dumps(self.original, sort_keys=True, allow_nan=False).encode()
                ).hexdigest(),
            },
        )
        self.members[self.imported] = self.request_path.read_bytes()
        claim_path = "context/fleet/runs/claimed/task/archived-reuse-journal/source-exclusion.json"
        self.members[claim_path] = H["canonical"]({"proof": {"machine_id": held}})
        self.seal()
        config_path = self.outer / "launch-1/config.private.json"
        config = json.loads(config_path.read_bytes())
        digest = H["sha"](self.request_path.read_bytes())
        config["remote_files"][0]["sha256"] = digest
        config["remote_env"]["CLOUDBENCH_ARCHIVED_REUSE_REQUEST_SHA256"] = digest
        write(config_path, config)
        launch_path = self.outer / "controller-launch.intent.json"
        launch = json.loads(launch_path.read_bytes())
        launch["config_sha256"] = H["sha"](config_path.read_bytes())
        write(launch_path, launch)
        # No current native row or unused journal for the claimed member: it
        # remains held, never eligibility or capacity credit.
        result = M["prepare"](self.outer, self.inventory)
        self.assertEqual([r["machine_id"] for r in result["candidates"]], [self.mid])
        self.assertEqual(result["held_machine_ids"], [held])
        self.assertEqual(result["held_reservations"][0]["machine_id"], held)
        self.assertEqual(result["held_reservations"][0]["capacity_credit"], 0)
        self.assertEqual(result["held_reservations"][0]["claim_evidence"][0]["path"], claim_path)
        self.assertNotIn("reservation", result["candidates"][0])
        # A malformed untouched row still denies the request rather than being
        # hidden by the held partition.
        path = self.wire / "2/0001-wire.json"
        before = path.read_bytes()
        path.unlink()
        with self.assertRaises((ValueError, FileNotFoundError)):
            M["prepare"](self.outer, self.inventory)
        path.write_bytes(before)
        # Unknown archive aliases still prevent the closed-world proof.
        self.members["context/fleet/runs/unknown/task/.cid"] = b"malformed"
        self.seal()
        with self.assertRaises(ValueError):
            M["prepare"](self.outer, self.inventory)

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
            with self.subTest(name=name):
                result = M["prepare"](self.outer, self.inventory)
                self.assertEqual(result["candidates"], [])
                self.assertEqual(result["held_machine_ids"], [self.mid])
                self.assertEqual(result["held_reservations"][0]["capacity_credit"], 0)
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
