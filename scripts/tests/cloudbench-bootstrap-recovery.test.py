#!/usr/bin/env python3
"""Exact fresh infra bootstrap cancellation: no services or provider allocation."""

import base64
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
OWNER, MACHINE, VOLUME = "a" * 32, "b" * 14, "vol_bootstrap123"
RUN, BENCH, APP = "20261006-bootstrap", "browser-event-ticket", "navi-whisper-lux-bench"
TOKEN, CLONE = OWNER + "-0", "cloudbench-bootstrap123"
REPO = Path(os.environ.get("ROSE_BOOTSTRAP_TEST_REPO", str(ROOT.parent))).resolve()
REF = subprocess.check_output(
    ["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True
).strip()


def git_blob(path):
    return subprocess.check_output(["git", "-C", str(REPO), "show", REF + ":" + path])


SOURCE_HASHES = {}  # Populated from the immutable current execution source.

spec = importlib.util.spec_from_file_location(
    "bootstrap_recovery", ROOT / "cloudbench-prestack-recovery.py"
)
assert spec and spec.loader
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data.encode() if isinstance(data, str) else data)


def pairs(path, values):
    write(path, "".join(f"{key}={value}\n" for key, value in values.items()))


def digest(data):
    return hashlib.sha256(data).hexdigest()


class BootstrapRecoveryTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.registry, self.audit = (
            self.base / "owners" / OWNER,
            self.base / "audit" / OWNER,
        )
        self.run, self.captures = self.base / "runs" / RUN, self.base / "capture"
        self.out = self.run / BENCH
        self.machines, self.volumes = (
            self.base / "machines.json",
            self.base / "volumes.json",
        )
        pairs(
            self.registry / "meta",
            dict(
                version="2",
                fleet_owner_token=OWNER,
                cleanup_policy="retain",
                run_id=RUN,
                runs_root=str(self.run.parent),
                audit_dir=str(self.audit),
                app=APP,
            ),
        )
        write(self.registry / "guest-cleanup-unconfirmed", "")
        pairs(self.audit / "meta", dict(fleet_owner_token=OWNER, run_id=RUN, app=APP))
        pairs(
            self.audit / "fresh" / CLONE,
            dict(
                version="1",
                fleet_owner_token=OWNER,
                run_id=RUN,
                app=APP,
                clone_name=CLONE,
                source="fresh-clone",
                machine_id=MACHINE,
                volume_id=VOLUME,
                disposition="owned",
            ),
        )
        pairs(
            self.registry / "clones" / CLONE,
            dict(name=CLONE, id=MACHINE, volume_id=VOLUME),
        )
        write(self.audit / "by-machine-id" / MACHINE, CLONE + "\n")
        write(
            self.run / "_batch/lifecycle.json",
            json.dumps(
                dict(
                    version=1,
                    status="failed",
                    controller_exit_code=1,
                    fleet_owner_token=OWNER,
                    run_id=RUN,
                )
            ),
        )
        write(self.run / "_batch/benches.json", json.dumps([dict(name=BENCH)]))
        for name, value in {
            ".cid": "clone " + MACHINE + "\n",
            "primary.ids": MACHINE + "\n",
            "post-config-start.accepted": MACHINE + "\n",
            "benchmark-child.finished": "143\n",
            "desired-worker-count": "0\n",
        }.items():
            write(self.out / name, value)
        self.config = dict(
            init=dict(cmd=["bash", "/cloudbench-boot.sh"]),
            image="registry.fly.io/test@sha256:" + "c" * 64,
            mounts=[dict(volume=VOLUME, path="/data")],
            env=dict(
                CLOUDBENCH_RUN_TOKEN=TOKEN,
                CLOUDBENCH_INFRA_PROBE="1",
                CLOUDBENCH_FRESH_VOLUME="1",
                REF=REF,
                BENCH_TASKS_B64=base64.b64encode(BENCH.encode()).decode(),
            ),
        )
        self.native = [
            dict(id=MACHINE, name=CLONE, state="stopped", config=self.config)
        ]
        write(self.machines, json.dumps(self.native))
        write(self.volumes, json.dumps([dict(id=VOLUME, attached_machine_id=MACHINE)]))
        write(
            self.captures / (MACHINE + ".original-config.private.json"),
            json.dumps(self.config, sort_keys=True, separators=(",", ":")) + "\n",
        )
        self.original = {
            "bench.log": (
                f"RUNSTAMP-{TOKEN}\n"
                "[boot] launching stack (run.sh --benchmark)\n"
                "[boot] waiting for stack to become healthy (services.json + backend + worker + WMH)...\n"
                "[boot] guest shutdown requested; draining benchmark root before stack teardown\n"
                "[boot] FATAL: stack worker cleanup was not confirmed; refusing guest cleanup acknowledgement\n"
                "[boot] driver exited rc=143; holding for controller collection\n"
            ).encode(),
            "cloudbench-driver.state": b"exited\n",
            f"cloudbench-shutdown-{TOKEN}.request": b"",
            "repo/.context/cloudbench/stack.log": (
                "🐘 Created isolated system database rose_bootstrap123\n"
                "   ✅ DB restored from dump\n"
                "🔎 Ensuring agent-network grep indexes (post-restore)...\n"
            ).encode(),
        }
        self.missing = [
            "cloudbench-driver.pid",
            f"cloudbench-driver-clean-{TOKEN}.ack",
            "repo/.context/cloudbench/services.json",
            "repo/.context/cloudbench/run.json",
            "repo/.context/cloudbench/logs/backend.log",
            "repo/.context/cloudbench/logs/worker.log",
        ]
        self.source = dict(SOURCE_HASHES)
        self.make_capture()
        self.configure_bound_source()
        self.update_review()

    def configure_bound_source(self):
        self.config["env"]["REF"] = REF
        self.source = {p: digest(git_blob(p)) for p in recovery.RECIPE_PATHS}
        with (self.registry / "meta").open("a") as stream:
            stream.write("workspace_root=" + str(REPO) + "\n")
        owner_spec = importlib.util.spec_from_file_location(
            "fixture_provenance_owner", ROOT / "cloudbench_execution_provenance.py"
        )
        owner = importlib.util.module_from_spec(owner_spec)
        owner_spec.loader.exec_module(owner)
        config = owner.build_config(
            "cloudbench-fleet-config-v1", ["app=" + APP, "task_count=1"]
        )
        document = owner.build_provenance(
            base_sha=REF,
            workspace_patch_sha256="none",
            snapshot_manifest=owner.build_snapshot_manifest(ROOT),
            config=config,
        )
        write(self.run / "execution-provenance.json", json.dumps(document))
        names = (
            "cloudbench-benchmark-target.py",
            "cloudbench-codex-auth.py",
            "cloudbench-current-run-artifact.py",
            "cloudbench-env.sh",
            "cloudbench-exact-session-cleanup.py",
            "cloudbench-execution-provenance.py",
            "cloudbench-fetch-ref.sh",
            "cloudbench-guest-recovery.py",
            "cloudbench-install-ngrok.sh",
            "cloudbench-prepare-patch.sh",
            "cloudbench-run.sh",
            "cloudbench-seed-budget.sh",
            "cloudbench-sync-deps.sh",
            "cloudbench-sync-prisma-client.sh",
            "cloudbench_catalog.py",
        )
        packed = {}
        for name in names:
            path = (
                "scripts/cloudbench_execution_provenance.py"
                if name == "cloudbench-execution-provenance.py"
                else "scripts/lib/" + name
                if name in ("cloudbench-env.sh", "cloudbench-seed-budget.sh")
                else "scripts/" + name
            )
            packed[name] = base64.b64encode(git_blob(path)).decode()
        packed["cloudbench-execution-provenance.json"] = base64.b64encode(
            json.dumps(document).encode()
        ).decode()
        envelope = gzip.compress(
            json.dumps({"version": 1, "files": packed}, sort_keys=True).encode(),
            mtime=0,
        )
        self.config["env"].update(
            CLOUDBENCH_BOOT_PAYLOAD_FILE="/cloudbench-boot-payload.json.gz",
            CLOUDBENCH_BOOT_PAYLOAD_SHA256=digest(envelope),
        )
        self.config["files"] = [
            {
                "guest_path": "/" + name,
                "raw_value": base64.b64encode(git_blob("scripts/" + name)).decode(),
            }
            for name in (
                "cloudbench-boot.sh",
                "cloudbench-boot-payload.py",
                "cloudbench-status-server.py",
            )
        ]
        self.config["files"].append(
            {
                "guest_path": "/cloudbench-boot-payload.json.gz",
                "raw_value": base64.b64encode(envelope).decode(),
            }
        )
        write(self.machines, json.dumps(self.native))
        write(
            self.captures / (MACHINE + ".original-config.private.json"),
            json.dumps(self.config, sort_keys=True, separators=(",", ":")) + "\n",
        )
        self.make_capture()

    def update_review(self):
        _, receipt = self.verify()
        write(
            self.captures / "source-boundary-reviewed.safe.json",
            json.dumps(
                {
                    "reviewed": True,
                    "reviewer": "offline fixture review",
                    "source_ref": receipt["source_ref"],
                    "source_recipe_sha256": receipt["source_recipe_sha256"],
                    "pre_service_boundaries": [receipt["bootstrap_phase"]],
                }
            ),
        )

    def test_acknowledged_before_stack_has_a_separate_absence_boundary(self):
        self.original["bench.log"] = (
            f"RUNSTAMP-{TOKEN}\n[boot] guest shutdown requested\n"
            "[boot] driver exited rc=143; holding for controller collection\n"
        ).encode()
        self.original.pop("repo/.context/cloudbench/stack.log")
        self.original[f"cloudbench-driver-clean-{TOKEN}.ack"] = (TOKEN + "\n").encode()
        self.missing.remove(f"cloudbench-driver-clean-{TOKEN}.ack")
        self.missing.append("repo/.context/cloudbench/stack.log")
        self.make_capture()
        _, receipt = self.verify()
        self.assertEqual(receipt["bootstrap_phase"], "before-stack-launch")
        self.assertFalse(receipt["isolated_database_created"])
        self.assertEqual(receipt["proof_credit"], 0)
        self.original.pop(f"cloudbench-driver-clean-{TOKEN}.ack")
        self.make_capture()
        with self.assertRaises(ValueError):
            self.verify()

    def test_index_command_tail_does_not_erase_the_original_source_boundary(self):
        self.original["repo/.context/cloudbench/stack.log"] += (
            b"command interrupted; cleanup diagnostics\n"
        )
        self.make_capture()
        _, receipt = self.verify()
        self.assertEqual(receipt["bootstrap_phase"], "agent-network-index-bootstrap")
        self.original["repo/.context/cloudbench/stack.log"] += (
            "🗜️  Saving seed dump for fast future warm-starts\n".encode()
        )
        self.make_capture()
        with self.assertRaises(ValueError):
            self.verify()

    def test_public_tunnel_start_is_past_the_index_source_boundary(self):
        # Restore path with healthy dependencies and no local Fast Mode cache:
        # the next stack.log lines after the index step are the DDL hook and
        # then the public tunnel, the first provider allocation.
        index_tail = self.original["repo/.context/cloudbench/stack.log"] + (
            b"Applied local workflow and trajectory search functions and triggers.\n"
        )
        self.original["repo/.context/cloudbench/stack.log"] = index_tail
        self.make_capture()
        _, receipt = self.verify()
        self.assertEqual(receipt["bootstrap_phase"], "agent-network-index-bootstrap")
        for line in (
            "🌐 Starting run-scoped public frontend tunnel → localhost:5051 (attempt 1/3)\n",
            "🌐 Falling back to an ephemeral ngrok tunnel → localhost:5051\n",
            "🌐 BENCHMARK_SKIP_PUBLIC_TUNNEL=1 — skipping public tunnel\n",
        ):
            self.original["repo/.context/cloudbench/stack.log"] = (
                index_tail + line.encode()
            )
            self.make_capture()
            with self.assertRaises(ValueError):
                self.verify()

    def test_every_injected_executable_must_match_even_with_a_new_envelope_checksum(
        self,
    ):
        original = copy.deepcopy(self.config)
        file = next(
            f
            for f in original["files"]
            if f["guest_path"] == "/cloudbench-boot-payload.json.gz"
        )
        packed = json.loads(gzip.decompress(base64.b64decode(file["raw_value"])))
        for name in packed["files"]:
            if name.endswith(".json"):
                continue
            with self.subTest(control=name):
                mutant = copy.deepcopy(original)
                document = copy.deepcopy(packed)
                document["files"][name] = base64.b64encode(
                    base64.b64decode(document["files"][name]) + b"\n# mismatch\n"
                ).decode()
                envelope = gzip.compress(
                    json.dumps(document, sort_keys=True).encode(), mtime=0
                )
                next(
                    f
                    for f in mutant["files"]
                    if f["guest_path"] == "/cloudbench-boot-payload.json.gz"
                )["raw_value"] = base64.b64encode(envelope).decode()
                mutant["env"]["CLOUDBENCH_BOOT_PAYLOAD_SHA256"] = digest(envelope)
                with self.assertRaises(ValueError):
                    recovery.bound_recipe(
                        recovery.fields(self.registry / "meta"), mutant, self.provenance
                    )

    def test_direct_native_inputs_are_exactly_the_reviewed_boot_recipe(self):
        _, original = self.verify()
        self.assertEqual(original["proof_credit"], 0)
        self.assertEqual(
            original["source_review_fingerprint"],
            recovery.bound_recipe(
                recovery.fields(self.registry / "meta"), self.config, self.provenance
            )[2],
        )
        for path in (
            "/unreviewed-control.sh",
            "/cloudbench-run.sh",
            "/unreviewed-input.json",
        ):
            with self.subTest(path=path):
                config = copy.deepcopy(self.config)
                config["files"].append(
                    {
                        "guest_path": path,
                        "raw_value": base64.b64encode(
                            b"unreviewed fixture input\n"
                        ).decode(),
                    }
                )
                with self.assertRaisesRegex(ValueError, "direct native file set"):
                    recovery.bound_recipe(
                        recovery.fields(self.registry / "meta"), config, self.provenance
                    )

    def test_changed_recipe_never_skips_independent_review_for_a_named_ref(self):
        _, receipt = self.verify()
        (self.captures / "source-boundary-reviewed.safe.json").unlink()
        with self.assertRaises(ValueError):
            recovery.publish(self.out, receipt)
        self.update_review()
        review = json.loads(
            (self.captures / "source-boundary-reviewed.safe.json").read_text()
        )
        review["source_recipe_sha256"] = "f" * 64
        write(self.captures / "source-boundary-reviewed.safe.json", json.dumps(review))
        with self.assertRaises(ValueError):
            recovery.publish(self.out, receipt)

    def test_normal_controller_snapshot_preserves_trusted_source_policy(self):
        snapshot_temp = self.base / "native-snapshot-temp"
        snapshot_temp.mkdir()
        ready, release = self.base / "entry-ready", self.base / "entry-release"
        environment = os.environ.copy()
        for key in tuple(environment):
            if key.startswith("CLOUDBENCH_SCRIPT_SNAPSHOT"):
                environment.pop(key)
        environment.update(
            TMPDIR=str(snapshot_temp),
            PYTHONDONTWRITEBYTECODE="1",
            CLOUDBENCH_FAKE_DIR=str(self.base / "fake-provider"),
            CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_ENTRY_READY=str(ready),
            CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_ENTRY_RELEASE=str(release),
        )
        with tempfile.TemporaryFile() as output:
            controller = subprocess.Popen(
                ["bash", str(ROOT / "run-bench-fleet"), "--help"],
                env=environment,
                stdout=output,
                stderr=subprocess.STDOUT,
            )
            try:
                deadline = time.monotonic() + 30
                while (
                    not ready.exists()
                    and controller.poll() is None
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.02)
                self.assertTrue(
                    ready.exists(),
                    "normal controller did not enter its sealed snapshot",
                )
                snapshots = list(snapshot_temp.glob("cloudbench-scripts.*"))
                self.assertEqual(len(snapshots), 1)
                snapshot = snapshots[0]
                helper = snapshot / "cloudbench-prestack-recovery.py"
                policy = snapshot / "cloudbench-prestack-source-reviews.json"
                self.assertTrue(
                    policy.is_file(),
                    "normal snapshot omitted its committed source policy",
                )
                environment.update(
                    CLOUDBENCH_FLEET_ROOT=str(ROOT.parent),
                    CLOUDBENCH_SCRIPT_SNAPSHOT=str(snapshot),
                    CLOUDBENCH_PRESTACK_CONTROLLER_REF=subprocess.check_output(
                        ["git", "-C", str(ROOT.parent), "rev-parse", "HEAD"], text=True
                    ).strip(),
                )
                args = [
                    sys.executable,
                    str(helper),
                    "--registry",
                    str(self.registry),
                    "--bench",
                    BENCH,
                    "--capture-dir",
                    str(self.captures),
                    "--machines-json",
                    str(self.machines),
                    "--volumes-json",
                    str(self.volumes),
                ]
                published = subprocess.run(
                    args + ["--publish"],
                    env=environment,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(published.returncode, 0, published.stderr)
                self.assertEqual(json.loads(published.stdout)["proof_credit"], 0)
                validated = subprocess.run(
                    args + ["--validate-published-bootstrap"],
                    env=environment,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(validated.returncode, 0, validated.stderr)
                foreign_root = self.base / "foreign-source"
                subprocess.run(["git", "init", "-q", str(foreign_root)], check=True)
                foreign = {**environment, "CLOUDBENCH_FLEET_ROOT": str(foreign_root)}
                rejected = subprocess.run(
                    args + ["--validate-published-bootstrap"],
                    env=foreign,
                    capture_output=True,
                    text=True,
                )
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn("trusted committed source", rejected.stderr)
                source_policy = ROOT / "cloudbench-prestack-source-reviews.json"
                source_policy_bytes = source_policy.read_bytes()
                source_policy_mode = stat.S_IMODE(source_policy.stat().st_mode)
                self.assertEqual(
                    policy.stat().st_mode & stat.S_IWUSR,
                    source_policy_mode & stat.S_IWUSR,
                )
                # Tamper only this controller's generated fixture, after proving
                # its ordinary committed-policy path. Exercise readonly copies
                # independently of the checkout's mode and inherited umask.
                policy.chmod(stat.S_IMODE(policy.stat().st_mode) & ~0o222)
                self.assertEqual(stat.S_IMODE(policy.stat().st_mode) & 0o222, 0)
                for fixture in (
                    policy,
                    snapshot / "cloudbench-controller-snapshot-manifest.json",
                ):
                    fixture.chmod(stat.S_IMODE(fixture.stat().st_mode) | stat.S_IWUSR)
                policy.write_bytes(policy.read_bytes() + b"\n")
                subprocess.run(
                    [
                        sys.executable,
                        str(snapshot / "cloudbench_execution_provenance.py"),
                        "snapshot",
                        "--snapshot-dir",
                        str(snapshot),
                        "--output",
                        str(snapshot / "cloudbench-controller-snapshot-manifest.json"),
                    ],
                    env=environment,
                    check=True,
                    capture_output=True,
                )
                rejected = subprocess.run(
                    args + ["--validate-published-bootstrap"],
                    env=environment,
                    capture_output=True,
                    text=True,
                )
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn("trusted committed source", rejected.stderr)
                self.assertEqual(source_policy.read_bytes(), source_policy_bytes)
                self.assertEqual(
                    stat.S_IMODE(source_policy.stat().st_mode), source_policy_mode
                )
            finally:
                release.touch()
                controller.wait(timeout=30)
            self.assertEqual(controller.returncode, 0)
            self.assertFalse(
                snapshot.exists(), "normal exact snapshot owner did not retire"
            )

    def test_unreviewed_native_recipe_changes_remain_rejected(self):
        """Registering one audited recipe never authorizes changed executable blobs."""
        _, receipt = self.verify()
        self.assertIn(
            receipt["bootstrap_phase"],
            recovery.trusted_source_review_policy().get(receipt["source_review_fingerprint"], []),
        )
        original_run = subprocess.run
        for path in ("scripts/lib/run-process-cleanup.sh", "scripts/run.sh"):
            with self.subTest(path=path):
                def changed_blob(argv, *args, **kwargs):
                    result = original_run(argv, *args, **kwargs)
                    if argv == ["git", "-C", str(REPO), "show", REF + ":" + path]:
                        self.assertEqual(result.returncode, 0)
                        result.stdout += b"\n# unreviewed executable-source fixture mutation\n"
                    return result

                with patch.object(recovery.subprocess, "run", side_effect=changed_blob):
                    ref, recipe_sha, fingerprint = recovery.native_recipe(
                        recovery.fields(self.registry / "meta"), self.config
                    )
                self.assertEqual(ref, REF)
                self.assertNotEqual(fingerprint, receipt["source_review_fingerprint"])
                changed = dict(receipt, source_recipe_sha256=recipe_sha, source_review_fingerprint=fingerprint)
                # A matching capture-local review marker still has no authority
                # to bless an executable recipe absent from committed policy.
                write(self.captures / "source-boundary-reviewed.safe.json", json.dumps({
                    "reviewed": True, "reviewer": "capture writer", "source_ref": ref,
                    "source_recipe_sha256": recipe_sha,
                    "pre_service_boundaries": [changed["bootstrap_phase"]],
                }))
                with self.assertRaisesRegex(ValueError, "trusted independent review"):
                    recovery.require_independent_source_review(changed)
                self.assertFalse((self.out / "guest-bootstrap.confirmed").exists())

    def test_capture_local_review_cannot_authorize_unreviewed_executable_source(self):
        out, receipt = self.verify()
        receipt["source_recipe_sha256"] = "f" * 64
        receipt["source_review_fingerprint"] = "e" * 64
        review = {
            "reviewed": True,
            "reviewer": "capture writer",
            "source_ref": receipt["source_ref"],
            "source_recipe_sha256": receipt["source_recipe_sha256"],
            "pre_service_boundaries": [receipt["bootstrap_phase"]],
        }
        write(self.captures / "source-boundary-reviewed.safe.json", json.dumps(review))
        write(
            self.captures / "cloudbench-prestack-source-reviews.json",
            json.dumps(
                {
                    "schema_version": 1,
                    "reviewed_executable_sources": {
                        "e" * 64: [receipt["bootstrap_phase"]]
                    },
                }
            ),
        )
        with self.assertRaisesRegex(ValueError, "trusted independent review"):
            recovery.publish(out, receipt)
        self.assertFalse((out / "guest-bootstrap.confirmed").exists())

    def test_adjacent_provenance_validator_must_match_the_bound_ref(self):
        isolated = self.base / "adjacent-validator"
        isolated.mkdir()
        owner = isolated / "cloudbench-prestack-recovery.py"
        owner.write_bytes((ROOT / owner.name).read_bytes())
        helper = isolated / "cloudbench_execution_provenance.py"
        helper.write_bytes(
            (ROOT / helper.name).read_bytes() + b"\n# mismatched local validator\n"
        )
        spec = importlib.util.spec_from_file_location("isolated_recovery_inverse", owner)
        assert spec and spec.loader
        isolated_recovery = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(isolated_recovery)
        with self.assertRaisesRegex(ValueError, "local provenance validator differs"):
            isolated_recovery.bound_recipe(
                recovery.fields(self.registry / "meta"), self.config, self.provenance
            )

    def test_adjacent_provenance_inverse_preserves_shared_source(self):
        shared = (ROOT / "cloudbench_execution_provenance.py").resolve()
        original_write = Path.write_bytes

        def isolated_write(path, data):
            self.assertNotEqual(path.resolve(), shared, "inverse fixture writes shared source")
            return original_write(path, data)

        with patch.object(Path, "write_bytes", isolated_write):
            self.test_adjacent_provenance_validator_must_match_the_bound_ref()

    def test_absent_packed_provenance_document_is_explicit(self):
        mutant = copy.deepcopy(self.config)
        payload = next(
            file
            for file in mutant["files"]
            if file["guest_path"] == "/cloudbench-boot-payload.json.gz"
        )
        packed = json.loads(gzip.decompress(base64.b64decode(payload["raw_value"])))
        del packed["files"]["cloudbench-execution-provenance.json"]
        envelope = gzip.compress(json.dumps(packed, sort_keys=True).encode(), mtime=0)
        payload["raw_value"] = base64.b64encode(envelope).decode()
        mutant["env"]["CLOUDBENCH_BOOT_PAYLOAD_SHA256"] = digest(envelope)
        with self.assertRaisesRegex(ValueError, "provenance document is missing"):
            recovery.bound_recipe(
                recovery.fields(self.registry / "meta"), mutant, self.provenance
            )

    def test_missing_source_config_schema_and_module_spec_fail_clearly(self):
        for field, value in (("env", None), ("files", {})):
            mutant = copy.deepcopy(self.config)
            mutant[field] = value
            with self.assertRaisesRegex(ValueError, "source config schema"):
                recovery.bound_recipe(
                    recovery.fields(self.registry / "meta"), mutant, self.provenance
                )
        with patch.object(
            recovery.importlib.util, "spec_from_file_location", return_value=None
        ):
            with self.assertRaisesRegex(ValueError, "owner module cannot be loaded"):
                recovery.bound_recipe(
                    recovery.fields(self.registry / "meta"),
                    self.config,
                    self.provenance,
                )

    def test_native_driver_path_cannot_redirect_to_another_bound_executable(self):
        mutant = copy.deepcopy(self.config)
        mutant["env"]["CLOUDBENCH_RUN_SCRIPT"] = "/cloudbench-guest-recovery.py"
        with self.assertRaisesRegex(ValueError, "source control schema"):
            recovery.bound_recipe(
                recovery.fields(self.registry / "meta"), mutant, self.provenance
            )

    def make_capture(self):
        archive = self.captures / (MACHINE + ".originals.private.tar.gz")
        archive.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive, "w:gz") as stream:
            for name, data in self.original.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                stream.addfile(info, io.BytesIO(data))
        self.provenance = dict(
            version=1,
            machine_id=MACHINE,
            guest_run_token=TOKEN,
            direct_original_volume=True,
            source_machine_id=MACHINE,
            source_volume_id=VOLUME,
            git_head=REF,
            git_exit_code=0,
            tracked_change_exit_code=0,
            tracked_changed_paths=[],
            source_file_sha256=self.source,
            files={
                name: dict(bytes=len(data), sha256=digest(data))
                for name, data in self.original.items()
            },
            missing=self.missing,
            archive_sha256=digest(archive.read_bytes()),
            archive_bytes=archive.stat().st_size,
            native_original_config_sha256=digest(
                (
                    json.dumps(self.config, sort_keys=True, separators=(",", ":"))
                    + "\n"
                ).encode()
            ),
            proof_credit=0,
        )
        self.write_provenance()

    def write_provenance(self):
        write(
            self.captures / (MACHINE + ".provenance.safe.json"),
            json.dumps(self.provenance),
        )

    def verify(self):
        return recovery.verify(
            self.registry, BENCH, self.captures, self.machines, self.volumes
        )

    def test_exact_source_captured_bootstrap_is_zero_provider_not_zero_stack(self):
        out, receipt = self.verify()
        self.assertEqual(out, self.out)
        self.assertEqual(receipt["kind"], "fresh-infra-bootstrap-zero-provider")
        self.assertEqual(receipt["proof_credit"], 0)
        self.assertTrue(receipt["isolated_database_created"])
        self.assertEqual(receipt["provider_allocation_count"], 0)
        recovery.publish(out, receipt)
        self.assertTrue((out / "guest-bootstrap.confirmed").is_file())
        self.assertFalse((out / "guest-shutdown.confirmed").exists())
        self.assertFalse((out / "guest-cleanup.provider-manifest.json").exists())

    def test_frontend_dependency_preflight_is_still_before_service_launch(self):
        self.original["repo/.context/cloudbench/stack.log"] += (
            b"Applied local workflow and trajectory search functions and triggers.\n"
            + "📦 Installing front-end dependencies...\n".encode()
        )
        self.make_capture()
        _, receipt = self.verify()
        self.assertEqual(receipt["bootstrap_phase"], "frontend-dependency-preflight")

    def test_foreign_owner_is_rejected(self):
        pairs(self.audit / "fresh" / CLONE, dict(fleet_owner_token="d" * 32))
        with self.assertRaises(ValueError):
            self.verify()

    def test_wrong_machine_or_volume_config_is_rejected(self):
        self.native[0]["config"]["mounts"][0]["volume"] = "vol_foreign"
        write(self.machines, json.dumps(self.native))
        with self.assertRaises(ValueError):
            self.verify()

    def test_wrong_source_or_dirty_tree_is_rejected(self):
        for key, value in [
            ("git_head", "d" * 40),
            ("tracked_changed_paths", ["scripts/run.sh"]),
        ]:
            old = self.provenance[key]
            self.provenance[key] = value
            self.write_provenance()
            with self.assertRaises(ValueError):
                self.verify()
            self.provenance[key] = old
        self.provenance["source_file_sha256"] = {
            **self.source,
            "scripts/run.sh": "e" * 64,
        }
        self.write_provenance()
        with self.assertRaises(ValueError):
            self.verify()

    def test_incomplete_original_capture_is_rejected(self):
        self.original.pop("repo/.context/cloudbench/stack.log")
        self.make_capture()
        with self.assertRaises(ValueError):
            self.verify()

    def test_public_verifier_rejects_invalid_native_config_schema_clearly(self):
        original = copy.deepcopy(self.config)
        for key, value in (("env", None), ("files", {})):
            with self.subTest(key=key):
                self.config.clear()
                self.config.update(copy.deepcopy(original))
                self.config[key] = value
                write(self.machines, json.dumps(self.native))
                write(
                    self.captures / (MACHINE + ".original-config.private.json"),
                    json.dumps(self.config, sort_keys=True, separators=(",", ":"))
                    + "\n",
                )
                with self.assertRaisesRegex(ValueError, "config schema"):
                    self.verify()

    def test_missing_absence_proof_is_rejected(self):
        self.provenance["missing"] = []
        self.write_provenance()
        with self.assertRaises(ValueError):
            self.verify()

    def test_any_backend_or_service_launch_is_rejected(self):
        self.original["repo/.context/cloudbench/logs/backend.log"] = (
            b"[Server] Server started\n"
        )
        self.make_capture()
        with self.assertRaises(ValueError):
            self.verify()

    def test_driver_crossed_health_or_task_boundary_is_rejected(self):
        for marker in [b"[boot] stack healthy\n", b"[boot] running benchmark: task\n"]:
            original = self.original["bench.log"]
            self.original["bench.log"] += marker
            self.make_capture()
            with self.assertRaises(ValueError):
                self.verify()
            self.original["bench.log"] = original

    def test_live_machine_completed_child_and_noninfra_config_are_rejected(self):
        self.native[0]["state"] = "started"
        write(self.machines, json.dumps(self.native))
        with self.assertRaises(ValueError):
            self.verify()
        self.native[0]["state"] = "stopped"
        write(self.machines, json.dumps(self.native))
        write(self.out / "benchmark-child.finished", "0\n")
        with self.assertRaises(ValueError):
            self.verify()
        write(self.out / "benchmark-child.finished", "143\n")
        self.native[0]["config"]["env"]["CLOUDBENCH_INFRA_PROBE"] = "0"
        write(self.machines, json.dumps(self.native))
        with self.assertRaises(ValueError):
            self.verify()

    def test_changed_original_config_or_linked_capture_is_rejected(self):
        self.provenance["native_original_config_sha256"] = "f" * 64
        self.write_provenance()
        with self.assertRaises(ValueError):
            self.verify()
        self.make_capture()
        archive = self.captures / (MACHINE + ".originals.private.tar.gz")
        other = archive.with_suffix(".saved")
        archive.rename(other)
        archive.symlink_to(other)
        with self.assertRaises(ValueError):
            self.verify()

    def test_exact_recovery_consumes_distinct_receipt_without_forging_ack(self):
        out, receipt = self.verify()
        recovery.publish(out, receipt)
        source = (ROOT / "run-bench-fleet").read_text()
        start = (
            source.index("cloudbench_validate_bootstrap_retirement()")
            if "cloudbench_validate_bootstrap_retirement()" in source
            else source.index("cloudbench_recover_guest_cleanup_receipts()")
        )
        body = source[
            start : source.index("\nfleet_recovery_reconnect_guest_shutdowns()", start)
        ]
        command = f"""set -eu
{body}
EXACT_SESSION_CLEANUP_HELPER={ROOT / "cloudbench-exact-session-cleanup.py"}
PRESTACK_RECOVERY_HELPER={ROOT / "cloudbench-prestack-recovery.py"}
RUN_ID={RUN}
APP={APP}
CLOUDBENCH_BARRIER_TOKEN=unused
recovery_benches=({BENCH})
recovery_machine_ids=({MACHINE})
recovery_clone_names=({CLONE})
recovery_machine_states=(stopped)
recovery_guest_tokens=({TOKEN})
recovery_proxy_ports=('')
recovery_outputs=({out})
fly_with_timeout() {{
 case "$2" in
  machines) cat {self.machines} ;;
  volumes) cat {self.volumes} ;;
  *) return 91 ;;
 esac
}}
machine_status_exact_read() {{ return 92; }}
cloudbench_publish_guest_shutdown_confirmation() {{ return 93; }}
cloudbench_recover_guest_cleanup_receipts {self.registry}
"""
        env = {
            **os.environ,
            "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ["PATH"],
        }
        result = subprocess.run(
            ["bash", "-c", command], env=env, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((out / "guest-shutdown.confirmed").exists())
        self.assertFalse((out / "guest-cleanup.provider-manifest.json").exists())

    def test_exact_recovery_rejects_changed_archived_source_receipt(self):
        out, receipt = self.verify()
        recovery.publish(out, receipt)
        receipt["source_recipe_sha256"] = "f" * 64
        write(out / "guest-bootstrap.confirmed", json.dumps(receipt))
        command = [
            sys.executable,
            str(ROOT / "cloudbench-prestack-recovery.py"),
            "--registry",
            str(self.registry),
            "--bench",
            BENCH,
            "--capture-dir",
            str(self.captures),
            "--machines-json",
            str(self.machines),
            "--volumes-json",
            str(self.volumes),
            "--validate-published-bootstrap",
        ]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
