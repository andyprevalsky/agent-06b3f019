#!/usr/bin/env python3
"""Offline closed recovery reader controls using real encrypted-free native wire fixtures."""

import base64
import copy
import json
import runpy
import shutil
import tracemalloc
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(str(ROOT / "scripts/cloudbench-recovered-reservations.py"))
OLD = runpy.run_path(
    str(ROOT / "scripts/tests/cloudbench-reconcile-reservations.test.py")
)
write = OLD["OLD"]["write"]


class Recovered(unittest.TestCase):
    def setUp(self):
        self.old = OLD["Reconcile"]()
        self.old.setUp()
        self.addCleanup(self.old.doCleanups)
        self.f = self.old.f
        self.inputs = {}
        self.original = self.old.row
        self.reserved = self.f.request["candidates"][0]
        self.journal = self.f.outer / "incomplete-admission-recovery"
        self.directory = self.journal / self.f.mid
        self.directory.mkdir(parents=True, mode=0o700)
        self.proof = self.old.proof
        self.observation(self.directory)

    def observation(self, directory):
        write(directory / "observed.json", self.f.current)
        for index, (method, suffix, response, headers) in enumerate(
            [
                ("POST", "/lease", {"data": {"nonce": "fresh"}}, {}),
                ("GET", "", self.f.current, {"fly-machine-lease-nonce": "fresh"}),
                ("DELETE", "/lease", {}, {"fly-machine-lease-nonce": "fresh"}),
            ]
        ):
            folder = directory / "wire" / f"{15 - index:032x}"
            path = "/machines/" + self.f.mid + suffix
            write(
                folder / "request.json",
                {
                    "app": M["H"]["APP"],
                    "method": method,
                    "path": path,
                    "headers": headers,
                    "body": None,
                },
            )
            raw = M["canonical"](response)
            write(
                folder / "0001-wire.json",
                {
                    "method": method,
                    "path": path,
                    "status": 200,
                    "monotonic_ns": 100 + index,
                    "sha256": M["sha"](raw),
                    "body_b64": base64.b64encode(raw).decode(),
                },
            )

    def context(self, lane="ACK", proof=None):
        return {
            "journal": str(self.journal),
            "original": self.f.original,
            "request": self.f.request,
            "classifications": {
                self.f.mid: {"lane": lane, "proof": proof or self.proof}
            },
            "membership": M["membership"](self.journal, {}),
        }

    def test_ack_and_pending_read_require_positive_fresh_release_without_new_write(
        self,
    ):
        context = self.context()
        row = M["validate"](
            context, self.original, self.reserved, self.f.current, self.inputs
        )
        self.assertEqual(row, self.reserved)
        changed = copy.deepcopy(self.f.current)
        changed["config"]["init"] = {"cmd": ["foreign"]}
        with self.assertRaises(ValueError):
            M["validate"](context, self.original, self.reserved, changed, {})
        # Parked reader validates recorded custody without blessing later config.
        self.assertEqual(
            M["validate_proof"](context, self.original, self.reserved, {}), row
        )
        pending = dict(
            self.proof,
            expected_native=self.f.current,
            old_response_unknown=True,
            original_instance="old-version",
        )
        self.assertEqual(
            M["validate_proof"](
                self.context("PENDING_READ", pending), self.original, self.reserved, {}
            ),
            row,
        )
        acquire_path = self.directory / "wire" / f"{15:032x}" / "0001-wire.json"
        saved_acquire = acquire_path.read_bytes()
        acquire = json.loads(saved_acquire)
        raw = M["canonical"]({"data": {"nonce": None}})
        acquire.update(body_b64=base64.b64encode(raw).decode(), sha256=M["sha"](raw))
        write(acquire_path, acquire)
        with self.assertRaises(ValueError):
            M["validate_proof"](self.context(), self.original, self.reserved, {})
        acquire_path.write_bytes(saved_acquire)
        release = self.directory / "wire" / f"{13:032x}" / "0001-wire.json"
        value = json.loads(release.read_bytes())
        value["status"] = 499
        write(release, value)
        with self.assertRaises(ValueError):
            M["validate_proof"](self.context(), self.original, self.reserved, {})

    def test_preconfig_real_raw_proof_and_positive_ack_rescue(self):
        shutil.rmtree(self.directory)
        base = self.directory / "new-reservation"
        shutil.copytree(self.old.directory, base / self.f.mid)
        for index in range(5):
            folder = base / self.f.mid / "wire" / str(index)
            folder.rename(folder.with_name(f"{index:032x}"))
        # A normal successful one-row reserve writes this completion only after
        # releasing its lease. The per-row raw proof still carries that release.
        write(base / "reserved-request.json", self.f.request)
        context = self.context("PRE_CONFIG")
        self.assertEqual(
            M["validate_proof"](context, self.original, self.reserved, {}),
            self.reserved,
        )
        foreign = write(base / "foreign-effect.json", {"unknown": True})
        with self.assertRaises(ValueError):
            M["validate_proof"](
                self.context("PRE_CONFIG"), self.original, self.reserved, {}
            )
        foreign.unlink()
        self.observation(self.directory / "ack-rescue")
        context = self.context("PRE_CONFIG")
        self.assertEqual(
            M["validate_proof"](context, self.original, self.reserved, {}),
            self.reserved,
        )
        write(self.directory / "foreign-effect.json", {"unknown": True})
        with self.assertRaises(ValueError):
            M["validate_proof"](
                self.context("PRE_CONFIG"), self.original, self.reserved, {}
            )

    def test_typed_host_pins_effectful_sources_and_observation_dependencies(self):
        import subprocess

        oldref = M["I"]["CLOSED_SOURCE"]
        newref = "b" * 40
        read = subprocess.check_output
        altered = {}

        def git(command):
            revision, name = command[-1].split(":scripts/", 1)
            if revision == newref:
                return altered.get(name, (ROOT / "scripts" / name).read_bytes())
            return read(command)

        expected = {
            name: M["sha"]((ROOT / "scripts" / name).read_bytes())
            for name in (
                "cloudbench-incomplete-reservations.py",
                "run-original600-controller.py",
            )
        }
        with (
            mock.patch.dict(M["closed_host"].__globals__, CLOSED_HOST_HASHES=expected),
            mock.patch.object(M["subprocess"], "check_output", side_effect=git),
        ):
            self.assertEqual(M["closed_host"](newref), newref)
            for name in (
                "cloudbench-incomplete-reservations.py",
                "cloudbench-archived-reuse-effects.py",
                "cloudbench-recovered-reservations.py",
            ):
                if name.endswith("recovered-reservations.py"):
                    altered[name] = (
                        (ROOT / "scripts" / name)
                        .read_bytes()
                        .replace(
                            b"def obj(path, inputs):",
                            b"def obj(path, inputs):\n    raise ValueError('foreign')",
                        )
                    )
                else:
                    altered[name] = b"foreign source"
                with self.assertRaises(ValueError):
                    M["closed_host"](newref)
                altered.clear()
        self.assertEqual(len(oldref), 40)

    def test_typed_closed_admission_reconstructs_retained_rows_after_full_closure(self):
        self.load_fixture(typed=True)

    def test_load_binds_both_plan_serializations_request_partition_and_closed_config(
        self,
    ):
        self.load_fixture(typed=False)

    def load_fixture(self, typed):
        plan = {
            "request": self.f.original,
            "classifications": [
                {"machine_id": self.f.mid, "lane": "ACK", "proof": self.proof}
            ],
            "inputs": {},
            "deadline": 5401,
            "started_at": 1,
        }
        if typed:
            plan.update(
                schema="closed-admission-continuation-v1",
                classifications=[],
                retained_request=self.f.request,
                retained_lanes={self.f.mid: "ORIGINAL_CLOSED"},
            )
        request = dict(self.f.request, held_native_reservations=[])
        raw = M["canonical"](request) + b"\n"
        path = self.journal / "request.json"
        path.write_bytes(raw)
        path.chmod(0o600)
        identity = M["sha"](M["canonical"](plan))
        write(
            self.journal / "intent.json",
            {
                "identity_sha256": identity,
                "original_deadline": 5401,
                "old_journal_immutable": True,
            },
        )
        complete = {
            "identity_sha256": identity,
            "original_deadline": 5401,
            "cancelled_signals": [],
            "old_failures_retained": True,
            "task_credit": 0,
            "request_sha256": M["sha"](raw),
            "held": [],
            "results": [
                {
                    "machine_id": self.f.mid,
                    "lane": "RETAINED" if typed else "ACK",
                    "old_failure_retained": True,
                }
            ],
        }
        write(self.journal / "complete.json", complete)
        closed = self.f.closed
        launch_request = closed.parent / "archived-reuse-request.private.json"
        launch_request.write_bytes(raw)
        launch_request.chmod(0o600)
        config = {
            "source_ref": "a" * 40,
            "started_at_epoch": 1,
            "host_operator_provenance": {
                "host_operator_source_ref": M["HOST"],
                "workload_source_ref": "a" * 40,
                "original_started_at_epoch": 1,
                "incomplete_admission": {
                    "source_ref": M["HOST"],
                    "original_plan_sha256": M["sha"](
                        json.dumps(plan, sort_keys=True, allow_nan=False).encode()
                    ),
                },
            },
            "remote_files": [
                {
                    "relative_path": ".git/cloudbench-archived-reuse-"
                    + request["cohort"]
                    + ".json",
                    "source_path": str(launch_request),
                    "sha256": M["sha"](raw),
                }
            ],
            "remote_env": {"CLOUDBENCH_ARCHIVED_REUSE_REQUEST_SHA256": M["sha"](raw)},
        }
        config_path = write(closed.parent / "config.private.json", config)
        write(
            self.f.outer / "controller-launch.intent.json",
            {
                "config_path": str(config_path),
                "config_sha256": M["sha"](config_path.read_bytes()),
                "run_directory": str(closed),
            },
        )
        closure = M["C"]["U"]["CLOSED"]["prepare"](closed, self.f.inventory)
        # A valid gzip archive can have trailing zero padding. Keep the real
        # archive and full closure checks while exceeding the former read cap.
        archive = closed / "export/originals.tar.gz"
        with archive.open("r+b") as stream:
            stream.truncate(256 * 1024 * 1024 + 1)
        manifest_path = closed / "export/manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        closed_reader = M["C"]["U"]["CLOSED"]
        manifest["archive_sha256"] = closed_reader["digest_file"](archive)
        write(manifest_path, manifest)
        verified_path = closed / "export/disposable-export.verified.json"
        verified = json.loads(verified_path.read_bytes())
        for name in ("manifest.json", "originals.tar.gz"):
            verified["files"][name] = closed_reader["digest_file"](
                closed / "export" / name
            )
        write(verified_path, verified)
        cleanup_path = closed / "cleanup-call.intent.json"
        cleanup = json.loads(cleanup_path.read_bytes())
        cleanup["export_verified_file"] = closed_reader["digest_file"](verified_path)
        write(cleanup_path, cleanup)
        closure = closed_reader["prepare"](closed, self.f.inventory)
        if typed:
            shutil.rmtree(self.directory)
        with (
            mock.patch.dict(
                M["I"],
                SOURCE="a" * 40,
                CLOSED_SOURCE="a" * 40 if typed else M["I"]["CLOSED_SOURCE"],
                historical_plan=lambda *_args: plan,
            ),
            mock.patch.dict(M["load"].__globals__, closed_host=lambda ref: ref),
        ):
            tracemalloc.start()
            try:
                context = M["load"](self.f.outer, closed, config, closure, {})
                _, peak = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()
            self.assertLess(peak, 64 * 1024 * 1024)
            self.assertEqual(context["request"], request)
            self.assertNotEqual(
                identity,
                config["host_operator_provenance"]["incomplete_admission"][
                    "original_plan_sha256"
                ],
            )
            if typed:
                with mock.patch.dict(
                    M["I"]["retained_native"].__globals__, CLOSED_SOURCE="a" * 40
                ):
                    self.assertEqual(
                        M["validate_proof"](context, self.original, self.reserved, {}),
                        self.reserved,
                    )
            complete["results"][0]["lane"] = "PRE_CONFIG"
            write(self.journal / "complete.json", complete)
            with self.assertRaises(ValueError):
                M["load"](self.f.outer, closed, config, closure, {})
        archive.chmod(0o644)
        with self.assertRaises(ValueError):
            closed_reader["archive_digest"](archive)
        archive.chmod(0o600)
        alias = archive.with_name("alias.tar.gz")
        alias.symlink_to(archive)
        with self.assertRaises(ValueError):
            closed_reader["archive_digest"](alias)


if __name__ == "__main__":
    unittest.main()
