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
                if name in altered:
                    return altered[name]
                if name in expected or name == "cloudbench-recovered-reservations.py":
                    return (ROOT / "scripts" / name).read_bytes()
                fixed = list(command)
                fixed[-1] = oldref + ":scripts/" + name
                return read(fixed)
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
            oldref = M["I"]["CLOSED75_SOURCE"]
            with mock.patch.dict(
                M["closed_host"].__globals__, CONFIG75_HOST_HASHES=expected
            ):
                self.assertEqual(M["closed_host"](newref, workload=oldref), newref)
            oldref = M["I"]["CLOSED77_SOURCE"]
            with mock.patch.dict(
                M["closed_host"].__globals__, CONFIG77_HOST_HASHES=expected
            ):
                self.assertEqual(M["closed_host"](newref, workload=oldref), newref)
            oldref = M["I"]["CLOSED_SOURCE"]
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

    def test_full_archive_entrypoint_still_rejects_unstarted_closure(self):
        closure = dict(
            schema="cloudbench-archived-owner-stop-plan-v1",
            source_ref="a" * 40,
            no_delete=True,
            inputs={},
        )
        with mock.patch.dict(M["I"], SOURCE="a" * 40):
            with self.assertRaisesRegex(ValueError, "incomplete closed context"):
                M["load"](
                    self.f.outer, self.f.closed, {"source_ref": "a" * 40}, closure, {}
                )

    def test_typed_closed_admission_reconstructs_retained_rows_after_full_closure(self):
        self.load_fixture(typed=True)

    def test_typed75_closed_family_reconstructs_retained_native_rows(self):
        self.load_fixture(typed=True, typed75=True)

    def test_typed77_closed_family_reconstructs_retained_rows_after_full_closure(self):
        self.load_fixture(typed=True, typed77=True)

    def test_load_binds_both_plan_serializations_request_partition_and_closed_config(
        self,
    ):
        self.load_fixture(typed=False)

    def test_successor_host_requires_frozen_cli_and_unchanged_effect_sources(self):
        self.assertEqual(
            M["closed_host"](
                "dbc3cbad0f3324cf0ec8a77a6950a22c270d828b", M["SUCCESSOR_CLI_SHA256"]
            ),
            "dbc3cbad0f3324cf0ec8a77a6950a22c270d828b",
        )
        with self.assertRaisesRegex(
            ValueError, "unknown closed admission host protocol"
        ):
            M["closed_host"](
                "69aa6ff584588cfaa07d0a875fb9bdf308267c5c", M["SUCCESSOR_CLI_SHA256"]
            )

    def test_released_workspace_successor_preserves_full_recovery(self):
        self.load_fixture(typed=True, successor=True)

    def load_fixture(self, typed, successor=False, typed75=False, typed77=False):
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
                "host_operator_source_ref": "69aa6ff584588cfaa07d0a875fb9bdf308267c5c"
                if successor
                else M["HOST"],
                "workload_source_ref": "a" * 40,
                "original_started_at_epoch": 1,
                "incomplete_admission": {
                    "source_ref": "69aa6ff584588cfaa07d0a875fb9bdf308267c5c"
                    if successor
                    else M["HOST"],
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
        pointer_path = None
        if successor:
            original_config = copy.deepcopy(config)
            original_raw = config_path.read_bytes()
            original_launch = self.f.outer / "controller-launch.intent.json"
            old_run = closed
            proof_raw = (
                M["canonical"](
                    {
                        "schema": "original600-observed-closed-v1",
                        "run_directory": str(old_run),
                        "original_tool_exit_code": 1,
                        "release_observer_exit_code": 0,
                        "caller_live": False,
                        "supervisor_published": False,
                        "task_attempts": 0,
                    }
                )
                + b"\n"
            )
            proof_sha = M["sha"](proof_raw)
            closed = old_run.parent / ("run-after-workspace-release-" + proof_sha[:16])
            shutil.move(old_run, closed)
            old_run.mkdir(mode=0o700)
            (old_run / "export").mkdir(mode=0o700)
            evidence = old_run / "observed-closure.safe.json"
            evidence.write_bytes(proof_raw)
            evidence.chmod(0o600)
            release = dict(
                machine_id=None,
                volume_id="vol_old",
                volume_disposition="pending_destroy",
                no_live_machine_observed=True,
                command_history_verified=False,
            )
            write(old_run / "export/disposable-controller.release.json", release)
            write(
                old_run / "terminal.json",
                dict(
                    status="FAILED_STARTUP_WORKSPACE_RELEASED",
                    release=release,
                    source_ref=config["source_ref"],
                    started_at_epoch=1,
                    original_deadline=5401,
                    benchmark_success_inferred=False,
                ),
            )
            write(
                old_run / "host-operator-provenance.json",
                original_config["host_operator_provenance"],
            )
            authority = dict(
                source_ref=original_config["source_ref"],
                output_directory=str(old_run / "export"),
                cleanup_owner_pid=123,
                cleanup_owner_birth="old-birth",
            )
            authority_path = write(old_run / "authority.private.json", authority)
            authority_sha = M["sha"](authority_path.read_bytes())
            write(
                old_run / "caller.json",
                dict(
                    authority_sha256=authority_sha,
                    source_ref=original_config["source_ref"],
                    epoch=1,
                    deadline=5401,
                    pid=123,
                    birth="old-birth",
                ),
            )
            workspace_path = write(
                old_run / "export/workspace-volume.ownership.json",
                dict(volume_id="vol_old"),
            )
            write(
                old_run / "export/machine-create.intent.json",
                dict(
                    authority_sha256=authority_sha,
                    workspace_sha256=M["sha"](workspace_path.read_bytes()),
                ),
            )
            write(
                old_run / "export/disposable-delete-volume.intent.json",
                dict(
                    authority_sha256=authority_sha, identifier="vol_old", kind="volume"
                ),
            )
            write(
                old_run / "cleanup-call.intent.json",
                dict(
                    action="cleanup-workspace",
                    machine=None,
                    gate_joined=True,
                    supervisor_joined=False,
                    export_verified_file=None,
                ),
            )
            sources = {}
            for ref, names in (
                (
                    "69aa6ff584588cfaa07d0a875fb9bdf308267c5c",
                    (
                        "cloudbench-original600-runner.py",
                        "run-cloudbench-controller-gate",
                    ),
                ),
                (
                    "49b792dcc2ea983325c6a25801da6c982f29c206",
                    (
                        "cloudbench-disposable-controller.py",
                        "run-cloudbench-controller-gate",
                    ),
                ),
            ):
                for name in names:
                    sources[ref + ":" + name] = M["sha"](
                        M["subprocess"].check_output(
                            [
                                "git",
                                "--no-replace-objects",
                                "-C",
                                str(ROOT),
                                "show",
                                ref + ":scripts/" + name,
                            ]
                        )
                    )
            members = {
                str(path.relative_to(old_run)): "directory"
                if path.is_dir()
                else M["sha"](path.read_bytes())
                for path in old_run.rglob("*")
            }
            proof_inputs = {
                str(old_run / name): digest
                for name, digest in members.items()
                if digest != "directory"
            }
            proof_inputs[str(config_path)] = M["sha"](original_raw)
            proof = dict(
                path=str(evidence),
                sha256=proof_sha,
                prior_output=str(old_run),
                successor_output=str(closed),
                stage="CANONICAL_WORKSPACE_RELEASED_AFTER_UNKNOWN_CREATE",
                creation_history_verified=False,
                inputs=proof_inputs,
                membership=members,
                producer_sources=sources,
            )
            current_dir = self.f.outer / "bound-continuation-123"
            current_dir.mkdir(mode=0o700)
            current_path = current_dir / "config.private.json"
            config = dict(
                original_config,
                authority_template=str(current_dir / "authority-template.private.json"),
                host_operator_provenance=dict(
                    host_operator_source_ref="dbc3cbad0f3324cf0ec8a77a6950a22c270d828b",
                    workload_source_ref=original_config["source_ref"],
                    original_config_path=str(config_path),
                    original_config_sha256=M["sha"](original_raw),
                    original_launch_intent_sha256=M["sha"](
                        original_launch.read_bytes()
                    ),
                    original_started_at_epoch=1,
                    prelaunch_failure=proof,
                ),
            )
            for field, name in (
                ("host_runner_sha256", "cloudbench-original600-runner.py"),
                ("host_gate_sha256", "run-cloudbench-controller-gate"),
            ):
                config["host_operator_provenance"][field] = M["sha"](
                    M["subprocess"].check_output(
                        [
                            "git",
                            "--no-replace-objects",
                            "-C",
                            str(ROOT),
                            "show",
                            "dbc3cbad0f3324cf0ec8a77a6950a22c270d828b:scripts/" + name,
                        ]
                    )
                )
            write(
                current_dir / "authority-template.private.json",
                {"capacity_proof": "fixture"},
            )
            write(current_path, config)
            pointer_path = old_run / "host-launch-successor.json"
            pointer = dict(
                schema="original600-host-launch-successor-v1",
                evidence=proof,
                config_path=str(current_path),
                config_sha256=M["sha"](current_path.read_bytes()),
                original_started_at_epoch=1,
                host_operator_source_ref="dbc3cbad0f3324cf0ec8a77a6950a22c270d828b",
            )
            write(pointer_path, pointer)
            closure = closed_reader["prepare"](closed, self.f.inventory)
            archive = closed / "export/originals.tar.gz"
        with (
            mock.patch.dict(
                M["I"],
                SOURCE="a" * 40,
                CLOSED_SOURCE="a" * 40
                if typed and not typed75 and not typed77
                else M["I"]["CLOSED_SOURCE"],
                CLOSED75_SOURCE="a" * 40 if typed75 else M["I"]["CLOSED75_SOURCE"],
                CLOSED77_SOURCE="a" * 40 if typed77 else M["I"]["CLOSED77_SOURCE"],
                historical_plan=lambda *_args: plan,
            ),
            mock.patch.dict(
                M["load"].__globals__, closed_host=lambda ref, *_args, **_kwargs: ref
            ),
        ):
            tracemalloc.start()
            try:
                context = M["load"](self.f.outer, closed, config, closure, {})
                _, peak = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()
            self.assertLess(peak, 64 * 1024 * 1024)
            self.assertEqual(context["request"], request)
            historical_config = original_config if successor else config
            self.assertNotEqual(
                identity,
                historical_config["host_operator_provenance"]["incomplete_admission"][
                    "original_plan_sha256"
                ],
            )
            if successor:
                for field, value in (
                    ("original_started_at_epoch", 2),
                    ("host_operator_source_ref", "c" * 40),
                    ("config_sha256", "0" * 64),
                ):
                    changed = dict(pointer, **{field: value})
                    write(pointer_path, changed)
                    with self.assertRaises(ValueError):
                        M["load"](self.f.outer, closed, config, closure, {})
                write(pointer_path, pointer)
                bad_proof = copy.deepcopy(proof)
                bad_proof["inputs"][str(evidence)] = "0" * 64
                bad_config = copy.deepcopy(config)
                bad_config["host_operator_provenance"]["prelaunch_failure"] = bad_proof
                write(current_path, bad_config)
                write(
                    pointer_path,
                    dict(
                        pointer,
                        evidence=bad_proof,
                        config_sha256=M["sha"](current_path.read_bytes()),
                    ),
                )
                with self.assertRaisesRegex(
                    ValueError, "successor input namespace differs"
                ):
                    M["load"](self.f.outer, closed, bad_config, closure, {})
                write(current_path, config)
                write(pointer_path, pointer)
                changed_old = dict(original_config, started_at_epoch=2)
                write(config_path, changed_old)
                with self.assertRaises(ValueError):
                    M["load"](self.f.outer, closed, config, closure, {})
                config_path.write_bytes(original_raw)

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
