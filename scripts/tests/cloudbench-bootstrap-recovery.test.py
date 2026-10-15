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
from unittest.mock import Mock, patch

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
        self.source = {p: digest(git_blob(p)) for p in recovery.recipe_paths(git_blob)}
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
            "process-identity.py",
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
        if b"process-identity.py" not in git_blob("scripts/run-bench-cloud"):
            names = tuple(name for name in names if name != "process-identity.py")
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


    def test_native_recipe_binds_only_mutation_helper_change_into_source_fingerprint(self):
        meta = recovery.fields(self.registry / "meta")
        original = recovery.native_recipe(meta, self.config)[2]
        actual_run = recovery.subprocess.run

        def altered_helper(arguments, *args, **kwargs):
            result = actual_run(arguments, *args, **kwargs)
            if arguments[:2] == ["git", "-C"] and arguments[-1] == REF + ":scripts/cloudbench-campaign-mutation.py":
                return subprocess.CompletedProcess(arguments, 0, result.stdout + b"\n# independently changed mutation authority\n", result.stderr)
            return result

        with patch.object(recovery.subprocess, "run", side_effect=altered_helper):
            changed = recovery.native_recipe(meta, self.config)[2]
        self.assertNotEqual(original, changed, "helper-only change escaped immutable source approval fingerprint")


    def test_historical_recipe_retains_exact_original_control_set_and_fingerprint(self):
        with patch.dict(globals(), {"REF": "2819fe4f62f04fe8ace829da79c1b72e6fdd7a35"}):
            self.assertEqual(recovery.recipe_paths(git_blob), recovery.RECIPE_PATHS)
            meta_path = self.registry / "meta"
            write(meta_path, "\n".join(line for line in meta_path.read_text().splitlines() if not line.startswith("workspace_root=")) + "\n")
            self.configure_bound_source()
            # native_recipe correctly requires its local provenance validator
            # to equal the bound historical blob. Supply that actual old blob,
            # rather than weakening the validator's source equality check.
            historical = self.base / "historical-validator"
            historical.mkdir()
            shutil_source = (ROOT / "cloudbench-prestack-recovery.py").read_bytes()
            write(historical / "cloudbench-prestack-recovery.py", shutil_source)
            write(historical / "cloudbench_execution_provenance.py", git_blob("scripts/cloudbench_execution_provenance.py"))
            spec = importlib.util.spec_from_file_location("historical_recipe_subject", historical / "cloudbench-prestack-recovery.py")
            subject = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(subject)
            fingerprint = subject.native_recipe(subject.fields(self.registry / "meta"), self.config)[2]
        self.assertEqual(fingerprint, "481f3dc3a58354c2a70c4f0e10f9bf76e845348c44210fc0d63126ef9ba64e5d")


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
        for path in ("scripts/lib/run-process-cleanup.sh", "scripts/run.sh", "scripts/process-identity.py"):
            with self.subTest(path=path):
                config = self.config
                if path == "scripts/process-identity.py":
                    # Bind the changed helper in both packed input and source
                    # lookup, so finite policy owns the rejection.
                    config = copy.deepcopy(self.config)
                    packed_file = next(item for item in config["files"] if item["guest_path"] == "/cloudbench-boot-payload.json.gz")
                    packed = json.loads(gzip.decompress(base64.b64decode(packed_file["raw_value"])))
                    helper = base64.b64decode(packed["files"]["process-identity.py"])
                    packed["files"]["process-identity.py"] = base64.b64encode(helper + b"\n# unreviewed executable-source fixture mutation\n").decode()
                    envelope = gzip.compress(json.dumps(packed).encode())
                    packed_file["raw_value"] = base64.b64encode(envelope).decode()
                    config["env"]["CLOUDBENCH_BOOT_PAYLOAD_SHA256"] = recovery.sha(envelope)
                def changed_blob(argv, *args, **kwargs):
                    result = original_run(argv, *args, **kwargs)
                    if argv == ["git", "-C", str(REPO), "show", REF + ":" + path]:
                        self.assertEqual(result.returncode, 0)
                        result.stdout += b"\n# unreviewed executable-source fixture mutation\n"
                    return result

                with patch.object(recovery.subprocess, "run", side_effect=changed_blob):
                    ref, recipe_sha, fingerprint = recovery.native_recipe(
                        recovery.fields(self.registry / "meta"), config
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



class PreconfigStartupArchiveTests(unittest.TestCase):
    """Original admission intent may precede config, lifecycle and guest ACK."""
    def setUp(self):
        import runpy
        self.helper = runpy.run_path(os.environ.get("ROSE_STARTUP_ARCHIVE_HELPER_UNDER_TEST",
                                    str(REPO / "scripts/cloudbench-startup-failure-archive.py")))
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.registry, self.audit = self.base / "owners" / OWNER, self.base / "audits" / OWNER
        self.run = self.base / "runs" / RUN
        self.out = self.run / BENCH
        for p in (self.registry / "clones", self.audit / "fresh", self.out, self.run / "_batch"):
            p.mkdir(parents=True)
        pairs(self.registry / "meta", dict(version="2", fleet_owner_token=OWNER, run_id=RUN,
              runs_root=str(self.run.parent), audit_dir=str(self.audit), app=APP, cleanup_policy="reap"))
        write(self.registry / "runtime-evidence-unconfirmed", "")
        pairs(self.audit / "meta", dict(fleet_owner_token=OWNER, run_id=RUN, app=APP))
        pairs(self.audit / "fresh" / CLONE, dict(version="1", fleet_owner_token=OWNER,
              run_id=RUN, app=APP, clone_name=CLONE, source="fresh-clone", machine_id=MACHINE,
              volume_id=VOLUME, source_machine_id="c" * 14, disposition="owned"))
        pairs(self.registry / "clones" / CLONE, dict(name=CLONE, id=MACHINE, volume_id=VOLUME))
        write(self.run / "_batch/benches.json", json.dumps([{"name": BENCH, "mode": "REAL"}]))
        provenance = {"base_sha": "a" * 40, "workspace_patch_sha256": "none"}
        write(self.run / "execution-provenance.json", json.dumps(provenance))
        write(self.run / "_batch/run.json", json.dumps({"run_id": RUN, "status": "failed",
              "controller_exit_code": 1, "execution_provenance": provenance}))
        for name, body in {".cid": f"clone {MACHINE}\n", "benchmark-child.finished": "125\n",
                           "boot-config-unapplied": MACHINE + "\n", "worker-clones.ids": ""}.items():
            write(self.out / name, body)
        self.owner = {"version": 1, "machine_id": MACHINE, "run_token": TOKEN}
        for name in ("runtime-evidence.owner.json", "runtime-evidence.pending"):
            write(self.out / name, json.dumps(self.owner))
        self.native = {"id": MACHINE, "name": CLONE, "state": "started", "instance_id": "original-instance",
                       "config": {"init": {"cmd": ["sleep", "infinity"]}, "restart": {"policy": "no"},
                                  "image": "registry.example/image@sha256:" + "d" * 64,
                                  "mounts": [{"volume": VOLUME, "path": "/data"}]}}
        self.before, self.after = self.base / "before.json", self.base / "after.json"
        write(self.before, json.dumps(self.native))
        write(self.after, json.dumps(self.native))
        self.archive = self.base / "originals.tar.gz"

    def test_preconfig_startup_original_tuple_is_eligible_without_synthetic_ack(self):
        # Replay the former identity boundary when the additive phase is absent.
        identity = self.helper.get("preconfig_identity", self.helper["identity"])
        meta, original = identity(self.registry, self.out, MACHINE, TOKEN)
        self.assertEqual(meta["run_id"], RUN)
        self.assertEqual(original["volume_id"], VOLUME)
        self.assertFalse((self.run / "_batch/lifecycle.json").exists())
        self.assertFalse((self.out / "guest-shutdown.confirmed").exists())

    def capture(self):
        self.helper["capture_preconfig"](self.registry, self.out, MACHINE, TOKEN, self.archive)

    def verify(self, native=True):
        return self.helper["verify_preconfig"](self.registry, self.out, MACHINE, TOKEN, self.archive,
                                              self.before if native else None, self.after if native else None)

    def test_preconfig_full_original_archive_is_zero_credit_and_preserves_pending(self):
        original = {str(p): p.read_bytes() for p in self.run.rglob("*") if p.is_file()}
        self.capture()
        receipt = self.verify()
        self.assertTrue(receipt["preconfig_evidence_verified"])
        self.assertTrue(receipt["no_guest_admission_verified"])
        self.assertFalse(receipt["runtime_evidence_complete"])
        self.assertFalse(receipt["native_release_verified"])
        self.assertEqual(receipt["proof_credit"], 0)
        self.assertEqual({str(p): p.read_bytes() for p in self.run.rglob("*") if p.is_file()}, original)
        self.assertTrue((self.out / "runtime-evidence.pending").exists())

    def test_preconfig_archive_without_native_proof_is_evidence_only(self):
        self.capture()
        receipt = self.verify(native=False)
        self.assertTrue(receipt["evidence_only"])
        self.assertFalse(receipt["preconfig_evidence_verified"])
        self.assertFalse(receipt["no_guest_admission_verified"])

    def test_preconfig_missing_marker_and_stale_original_lifecycle_refuse(self):
        marker = self.out / "boot-config-unapplied"
        marker.unlink()
        with self.assertRaises((ValueError, OSError)):
            self.capture()
        write(marker, MACHINE + "\n")
        write(self.run / "_batch/lifecycle.json", json.dumps({"status": "passed", "controller_exit_code": 0}))
        with self.assertRaises(ValueError):
            self.capture()

    def test_existing_postconfig_identity_still_requires_real_cleanup_ack(self):
        (self.out / "boot-config-unapplied").unlink()
        write(self.run / "_batch/lifecycle.json", json.dumps({"status": "failed", "controller_exit_code": 1}))
        with self.assertRaises(OSError):
            self.helper["identity"](self.registry, self.out, MACHINE, TOKEN)
        write(self.out / "guest-shutdown.confirmed", RUN + "\n")
        self.helper["identity"](self.registry, self.out, MACHINE, TOKEN)

    def test_preconfig_missing_foreign_and_accepted_local_proof_refuse(self):
        for name, body in (("boot-config-unapplied", "foreign\n"),
                           ("benchmark-child.finished", "0\n"),
                           ("runtime-evidence.pending", "{}"),
                           ("worker-clones.ids", "foreign-worker\n"),
                           ("post-config-start.accepted", MACHINE),
                           ("cloudbench-boot-start.log", "original native start attempted"),
                           ("guest-shutdown.confirmed", RUN)):
            with self.subTest(name=name):
                path = self.out / name
                before = path.read_bytes() if path.exists() else None
                write(path, body)
                with self.assertRaises((ValueError, KeyError)):
                    self.capture()
                self.assertFalse(self.archive.exists())
                if before is None:
                    path.unlink()
                else:
                    path.write_bytes(before)

    def test_preconfig_changed_archive_or_original_refuse(self):
        self.capture()
        write(self.out / "new-original.log", "actual new bytes")
        with self.assertRaises(ValueError):
            self.verify()

    def test_preconfig_linked_original_and_unsafe_archive_refuse(self):
        original = self.out / "original.log"
        write(original, "original private bytes")
        os.link(original, self.out / "alias.log")
        with self.assertRaises(ValueError):
            self.capture()
        (self.out / "alias.log").unlink()
        self.capture()
        with tarfile.open(self.archive, "w:gz") as archive:
            member = tarfile.TarInfo("../foreign")
            member.size = 1
            archive.addfile(member, io.BytesIO(b"x"))
        with self.assertRaises(ValueError):
            self.verify()

    def test_preconfig_consumption_receipt_survives_normal_partial_recovery(self):
        self.capture()
        base = self.out / "failed-preconfig-runtime-archive"
        base.mkdir(mode=0o700)
        receipt = base / "verified.json"
        commit = self.helper.get("commit_preconfig")
        if commit is None:
            self.verify()  # Prior component verifies, but cannot retain this proof across consumption.
        else:
            commit(self.registry, self.out, MACHINE, TOKEN, self.archive, self.before, self.after, receipt)
        (self.out / "runtime-evidence.pending").unlink()
        (self.registry / "clones" / CLONE).unlink()
        write(self.audit / "fresh" / CLONE, "disposition=destroyed-verified-absent\n")
        write(self.run / "_batch/run.json", "{\"status\":\"failed\",\"release_verified\":true}")
        retry = self.helper.get("verify_preconfig_receipt")
        result = self.verify() if retry is None else retry(self.registry, self.out, MACHINE, TOKEN, receipt)
        self.assertTrue(result["preconfig_evidence_verified"])
        self.assertFalse(result["native_release_verified"])
        self.assertFalse((self.out / "guest-shutdown.confirmed").exists())
        self.assertFalse((self.run / "_batch/lifecycle.json").exists())

    def test_preconfig_aggregate_bound_refuses_before_reading_overflow_file(self):
        collector = self.helper["preconfig_files"]
        files = collector(self.registry, self.out, MACHINE, TOKEN)[2]
        reader = Mock(wraps=collector.__globals__["read"])
        with patch.dict(collector.__globals__, {"MAXIMUM": sum(map(len, files.values())) - 1, "read": reader}):
            with self.assertRaises(ValueError):
                self.capture()
        self.assertFalse(any(Path(call.args[0]) == self.run / "execution-provenance.json"
                             for call in reader.call_args_list))
        self.assertFalse(self.archive.exists())

    def test_preconfig_consumption_rejects_evidence_only_and_tampered_receipts(self):
        self.capture()
        base = self.out / "failed-preconfig-runtime-archive"
        base.mkdir(mode=0o700)
        receipt = base / "verified.json"
        commit = self.helper["commit_preconfig"]
        with self.assertRaises(ValueError):
            commit(self.registry, self.out, MACHINE, TOKEN, self.archive, None, None, receipt)
        self.assertFalse(receipt.exists())
        commit(self.registry, self.out, MACHINE, TOKEN, self.archive, self.before, self.after, receipt)
        original = receipt.read_bytes()
        proof = json.loads(original)
        for key, value in (("owner", "f" * 32), ("proof_credit", 1), ("consumption_ready", False),
                           ("archive_sha256", "0" * 64), ("native_before_sha256", "0" * 64)):
            with self.subTest(key=key):
                write(receipt, json.dumps({**proof, key: value}))
                with self.assertRaises(ValueError):
                    self.helper["verify_preconfig_receipt"](self.registry, self.out, MACHINE, TOKEN, receipt)
        receipt.write_bytes(original)
        self.assertEqual(commit(self.registry, self.out, MACHINE, TOKEN, self.archive,
                                self.before, self.after, receipt), proof)
        later_before, later_after = self.base / "later-before.json", self.base / "later-after.json"
        write(later_before, json.dumps({**self.native, "instance_id": "foreign-new-instance"}))
        write(later_after, later_before.read_bytes())
        with self.assertRaises(ValueError):
            self.helper["verify_preconfig_receipt"](self.registry, self.out, MACHINE, TOKEN,
                                                    receipt, later_before, later_after)

    def test_preconfig_foreign_accepted_or_changed_native_refuse(self):
        self.capture()
        with self.assertRaises(ValueError):
            self.helper["verify_preconfig"](self.registry, self.out, MACHINE, TOKEN, self.archive,
                                            self.before, self.before)
        for field, value in (("id", "e" * 14), ("instance_id", "changed-instance"),
                             ("state", "destroyed")):
            with self.subTest(field=field):
                changed = copy.deepcopy(self.native)
                changed[field] = value
                write(self.after, json.dumps(changed))
                with self.assertRaises(ValueError):
                    self.verify()
        for config in ({**self.native["config"], "env": {"CLOUDBENCH_RUN_TOKEN": TOKEN}},
                       {**self.native["config"], "init": {"cmd": ["bash", "/cloudbench-boot.sh"]}},
                       {**self.native["config"], "init": {"cmd": ["sleep", "infinity"], "exec": ["other"]}},
                       {**self.native["config"], "mounts": [{"volume": "vol_foreign", "path": "/data"}]}):
            changed = {**self.native, "config": config}
            write(self.before, json.dumps(changed))
            write(self.after, json.dumps(changed))
            with self.assertRaises(ValueError):
                self.verify()


class MachineExecDeliveryTests(unittest.TestCase):
    """Recorded machine-exec bodies are distinct from the CLI transport status."""
    def setUp(self):
        import runpy
        self.capture = runpy.run_path(str(REPO / "scripts/cloudbench-original-volume-capture.py"))
        self.client = object.__new__(self.capture["Fly"])
        self.client.app = APP
        self.calls = []
        self.response = (0, json.dumps({"stdout": json.dumps({"stage": 0, "inert": True, "bytes": 4000, "sha256": "a" * 64})}), "")
        def raw(seconds, *args):
            self.calls.append((seconds, args))
            return self.response
        self.client.flyctl = raw

    def execute(self, command="python3 inert-stage.py", budget=7000, seconds=30):
        return self.client.machine_exec_json(seconds, MACHINE, command,
            max_command_bytes=budget,
            validate_ack=lambda value: (type(value.get("stage")) is int
                and type(value.get("inert")) is bool and type(value.get("bytes")) is int
                and value == {"stage": 0, "inert": True, "bytes": 4000, "sha256": "a" * 64}))

    def test_machine_exec_recorded_payload_rejection_is_not_guest_success(self):
        # Exact captured stderr-only envelope; a real CLI returned transport zero.
        self.response = (0, json.dumps({"stderr": "Unhandled rejection: Rejection([PayloadTooLarge, MethodNotAllowed, MethodNotAllowed, MethodNotAllowed, MethodNotAllowed, MethodNotAllowed, MethodNotAllowed, MethodNotAllowed])"}), "")
        with self.assertRaises(self.capture["CaptureFailure"]):
            self.execute()
        self.assertEqual(len(self.calls), 1)  # No automatic retry/staging.

    def test_machine_exec_oversize_is_refused_before_transport(self):
        with self.assertRaises(self.capture["Refusal"]):
            self.execute("x" * 15045)
        self.assertEqual(self.calls, [])

    def test_machine_exec_provider_timeout_limit_is_pretransport_refusal(self):
        # Captured native refusal: "timeout must not exceed 600 seconds".
        for seconds in (601, 660):
            with self.subTest(seconds=seconds):
                with self.assertRaises(self.capture["Refusal"]):
                    self.execute(seconds=seconds)
                self.assertEqual(self.calls, [])

    def test_machine_exec_provider_timeout_limit_accepts_600(self):
        self.assertTrue(self.execute(seconds=600)["inert"])
        self.assertEqual(self.calls, [(600, ("machine", "exec", MACHINE,
            "python3 inert-stage.py", "--timeout", "600", "-a", APP, "--json"))])

    def test_machine_exec_timeout_limit_preserves_raw_flyctl_contract(self):
        self.client.binary, self.client.env = "pinned-flyctl", {"SAFE": "fixture"}
        raw = self.capture["Fly"].flyctl
        bounded = Mock(return_value=(0, b"raw-output", b"raw-error"))
        with patch.dict(raw.__globals__, {"run_bounded": bounded}):
            self.assertEqual(raw(self.client, 660, "version"),
                             (0, "raw-output", "raw-error"))
        bounded.assert_called_once_with(
            ["pinned-flyctl", "version"], 660, {"SAFE": "fixture"})

    def test_machine_exec_utf8_budget_counts_bytes(self):
        with self.assertRaises(self.capture["Refusal"]):
            self.execute("é" * 4000)
        self.assertEqual(self.calls, [])

    def test_machine_exec_typed_ack_and_transport_binding(self):
        self.assertTrue(self.execute()["inert"])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][0], 30)
        self.assertEqual(self.calls[0][1], ("machine", "exec", MACHINE,
            "python3 inert-stage.py", "--timeout", "30", "-a", APP, "--json"))

    def test_machine_exec_invalid_responses_fail_closed_without_retry(self):
        for body in ({}, {"stdout": "not JSON"}, {"stdout": "[]"},
                     {"stdout": json.dumps({"stage": 1})},
                     {"stdout": "{}", "stderr": "failure"},
                     {"stdout": "{}", "exit_code": True},
                     {"stdout": "{}", "error": "unexpected envelope error"},
                     {"stdout": json.dumps({"stage": 0, "inert": 1, "bytes": 4000, "sha256": "a" * 64})}):
            with self.subTest(body=body):
                self.response = (0, json.dumps(body), "")
                before = len(self.calls)
                with self.assertRaises(self.capture["CaptureFailure"]):
                    self.execute()
                self.assertEqual(len(self.calls), before + 1)

    def test_machine_exec_nonzero_and_response_bound(self):
        for response in ((1, "", "private-error"), (0, "x" * 1048577, "")):
            self.response = response
            with self.assertRaises(self.capture["CaptureFailure"]):
                self.execute()

    def test_machine_exec_missing_ack_validator_is_preflight_refusal(self):
        with self.assertRaises(self.capture["Refusal"]):
            self.client.machine_exec_json(30, MACHINE, "noop", max_command_bytes=7000, validate_ack=None)
        self.assertEqual(self.calls, [])


class ControllerExportContinuationTests(unittest.TestCase):
    """Real old-source seal and new launch/export, native-free temporary originals."""
    def setUp(self):
        import types
        self.types = types
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve(); self.repo=self.base/'repo';self.repo.mkdir()
        self.common=self.repo/'.git';self.common.mkdir()
        (self.repo/'scripts').mkdir(); (self.repo/'.context/controller-workspace-volume').mkdir(parents=True)
        self.oldref='1'*40;self.newref='2'*40
        self.collector = subprocess.check_output(['git','-C',str(REPO),'show','659e3d6964f7b88d14a20f66d2fc8f14251beaf9:scripts/cloudbench-controller-export.py'])
        self.old = {'__name__':'original_fixture_export','__file__':str(self.repo/'scripts/cloudbench-controller-export.py'),'CHECKED_COLLECTOR_SHA256':digest(self.collector)}
        exec(compile(self.collector,'original-fixture-collector','exec'),self.old)
        source=Path(os.environ.get('ROSE_CONTROLLER_EXPORT_TEST_SOURCE', str(ROOT/'cloudbench-controller-export.py')))
        spec=importlib.util.spec_from_file_location('candidate_controller_export',source);self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
        self.env=patch.dict(os.environ,{'FLY_MACHINE_ID':'abc123','FLY_APP_NAME':'fixture','GATE_WORKSPACE_VOLUME_ID':'vol_fixture'},clear=False);self.env.start();self.addCleanup(self.env.stop)
        self.owner=self.repo/'.context/controller-workspace-volume/ownership.json'
        self.owner.write_text(json.dumps({'source_ref':self.oldref,'app':'fixture','volume_id':'vol_fixture'}));self.original=self.owner.read_bytes()
        os.environ['GATE_WORKSPACE_VOLUME_SHA256']=digest(self.original)
        def git(repo,*args):
            return str(self.common) if '--git-common-dir' in args else (self.oldref if self.phase=='old' else self.newref) if args==('rev-parse','HEAD') else ''
        self.phase='old';self.birth=lambda pid:'proc-start:fixture-boot:'+str(pid)
        self.old['git']=git;self.old['birth']=self.birth;self.old['writers']=lambda roots,permitted:[];self.old['record_temp_roots']=lambda repo,common:[]
        self.oldcaller=self.base/'old-caller.json';self.oldcaller.write_text('{}')
        self.oldrecord=self.base/'old-launch.json';self.oldarchive=self.base/'old.tar.gz';self.oldmanifest=self.base/'old-manifest.json'
        self.old['launch'](types.SimpleNamespace(repo=self.repo,ref=self.oldref,driver_pid=791,caller=self.oldcaller,image='image@sha256:fixture',record=self.oldrecord))
        rc=self.old['export'](types.SimpleNamespace(record=self.oldrecord,archive=self.oldarchive,manifest=self.oldmanifest,pending=self.base/'old-pending.json'));self.assertEqual(rc,0)
        self.phase='new'
        self.patches=[patch.object(self.module,'git',git),patch.object(self.module,'birth',self.birth),patch.object(self.module.subprocess,'check_output',return_value=self.collector),patch.object(self.module,'record_temp_roots',return_value=[])]
        for item in self.patches:item.start();self.addCleanup(item.stop)
        self.caller=self.base/'new-caller.json';self.caller.write_text('{"epoch":1234}')
        self.cont=self.base/'continuation.json';self.record=self.base/'new-launch.json'
        self.args=types.SimpleNamespace(repo=self.repo,ref=self.newref,driver_pid=900,caller=self.caller,image='image@sha256:fixture',epoch=1234.,record=self.cont,old_record=self.oldrecord,old_archive=self.oldarchive,old_manifest=self.oldmanifest)
        self.launch=types.SimpleNamespace(**{**vars(self.args),'record':self.record,'continuation':self.cont})

    def prepare(self):
        if not hasattr(self.module,'continue_launch'):
            # Owning baseline: actual old launch refuses changed-source retained ownership.
            self.module.launch(self.launch)
            self.fail('old exporter unexpectedly accepted unsealed continuation')
        self.module.continue_launch(self.args)

    def fifo_capture(self):
        fifo=self.repo/'.context/native-retirement.pipe';os.mkfifo(fifo,0o600)
        self.phase='old';self.toolref='3'*40
        source=Path(self.module.__file__).read_bytes()
        def blob(command,*args,**kwargs):
            return source if command[-1]==self.toolref+':scripts/cloudbench-controller-export.py' else self.collector
        self.patches[-2].stop()  # replace only the check_output boundary with distinct old/tool source
        self.toolpatch=patch.object(self.module.subprocess,'check_output',side_effect=blob);self.toolpatch.start();self.addCleanup(self.toolpatch.stop)
        args=self.types.SimpleNamespace(record=self.oldrecord,archive=self.base/'fifo.tar.gz',manifest=self.base/'fifo-manifest.json',pending=self.base/'fifo-pending.json',capture_tool_ref=self.toolref)
        original_open=os.open
        def no_ipc(path,*args,**kwargs):
            self.assertNotEqual(str(path),str(fifo),'export must never open FIFO IPC')
            return original_open(path,*args,**kwargs)
        before=fifo.lstat()
        with patch.object(self.module,'writers',return_value=[]),patch.object(self.module.os,'open',side_effect=no_ipc):
            self.assertEqual(self.module.export(args),0)
        self.assertEqual((fifo.lstat().st_dev,fifo.lstat().st_ino,fifo.lstat().st_mtime_ns),(before.st_dev,before.st_ino,before.st_mtime_ns))
        self.assertEqual(self.owner.read_bytes(),self.original)
        verify=self.types.SimpleNamespace(**{**vars(args),'ref':self.oldref,'machine':'abc123','app':'fixture','image':'image@sha256:fixture','caller':self.oldcaller,'repo':self.repo})
        self.module.verify(verify)
        return fifo,args,verify

    def test_original_run_fifo_capture_is_metadata_only_and_truthful_tool(self):
        fifo,args,verify=self.fifo_capture()
        manifest=json.loads(args.manifest.read_bytes());row=manifest['files']['context/native-retirement.pipe']
        self.assertEqual(row['kind'],'fifo');self.assertTrue(row['metadata_only'])
        self.assertEqual(manifest['record']['collector_sha256'],digest(self.collector))
        self.assertEqual(manifest['capture_tool']['source_ref'],self.toolref)
        self.assertNotEqual(manifest['capture_tool']['sha256'],manifest['record']['collector_sha256'])
        self.phase='new';self.args.old_archive=args.archive;self.args.old_manifest=args.manifest
        self.module.continue_launch(self.args);self.module.launch(self.launch)
        self.assertEqual(json.loads(self.record.read_bytes())['continuation']['old_archive_sha256'],digest(args.archive.read_bytes()))

    def test_fifo_capture_rejects_changed_tool_and_original_launch(self):
        _,args,verify=self.fifo_capture();original=args.manifest.read_bytes()
        for key in ('sha256','original_launch_sha256','original_collector_sha256'):
            with self.subTest(key=key):
                row=json.loads(original);row['capture_tool'][key]='f'*64;args.manifest.write_text(json.dumps(row))
                with self.assertRaises(ValueError):self.module.verify(verify)
        args.manifest.write_bytes(original)
        old=self.oldrecord.read_bytes();record=json.loads(old);record['image']='foreign';self.oldrecord.write_text(json.dumps(record))
        with self.assertRaises(ValueError):self.module.verify(verify)
        self.oldrecord.write_bytes(old)
        with patch.object(self.module.subprocess,'check_output',return_value=b'wrong-tool'):
            with self.assertRaises(ValueError):self.module.verify(verify)

    def test_fifo_capture_cannot_rebind_original_record_outside_archive(self):
        _,args,verify=self.fifo_capture()
        record=json.loads(self.oldrecord.read_bytes());record['foreign_added_receipt']='forged'
        raw=json.dumps(record).encode();self.oldrecord.write_bytes(raw)
        metadata=json.loads(args.manifest.read_bytes());metadata['record']=record
        metadata['capture_tool']['original_launch_sha256']=digest(raw)
        args.manifest.write_text(json.dumps(metadata))
        with self.assertRaisesRegex(ValueError,'archived original launch'):
            self.module.verify(verify)

    def test_fifo_archive_rejects_wrong_type_and_metadata_drift(self):
        _,args,verify=self.fifo_capture();original=args.manifest.read_bytes()
        for key,value in (('mode',stat.S_IFSOCK|0o600),('mtime_ns',1),('gid',99999),('nlink',2),('inode',0),('device',0)):
            with self.subTest(key=key):
                row=json.loads(original);row['files']['context/native-retirement.pipe']['stat'][key]=value;args.manifest.write_text(json.dumps(row))
                with self.assertRaisesRegex(ValueError,'FIFO metadata'):self.module.verify(verify)
        args.manifest.write_bytes(original)

    def test_fifo_drift_during_capture_preserves_ipc_and_refuses_seal(self):
        fifo=self.repo/'.context/native-retirement.pipe';os.mkfifo(fifo,0o600)
        self.phase='old';source=Path(self.module.__file__).read_bytes();toolref='3'*40
        with patch.object(self.module.subprocess,'check_output',side_effect=lambda cmd,*a,**k:source if cmd[-1]==toolref+':scripts/cloudbench-controller-export.py' else self.collector):
            calls=[]
            def writers(roots,permitted):
                calls.append(1)
                if len(calls)==2:os.utime(fifo,ns=(1,1))
                return []
            archive=self.base/'drift.tar.gz'
            with patch.object(self.module,'writers',side_effect=writers):
                with self.assertRaisesRegex(ValueError,'originals changed'):
                    self.module.export(self.types.SimpleNamespace(record=self.oldrecord,archive=archive,manifest=self.base/'drift-manifest.json',pending=self.base/'drift-pending.json',capture_tool_ref=toolref))
            self.assertFalse(archive.exists());self.assertTrue(stat.S_ISFIFO(fifo.lstat().st_mode))

    def test_changed_source_continuation_preserves_original_seal_and_ownership(self):
        self.prepare();self.module.launch(self.launch)
        self.assertEqual(self.owner.read_bytes(),self.original)
        row=json.loads(self.record.read_bytes());self.assertEqual(row['workspace_ownership_sha256'],digest(self.original));self.assertEqual(row['continuation']['old_init_pid'],791)
        self.assertEqual(json.loads(self.oldrecord.read_bytes())['source_ref'],self.oldref)
        calls=[]
        def writers(roots,permitted):calls.append(set(permitted));return []
        with patch.object(self.module,'writers',side_effect=writers):
            self.assertEqual(self.module.export(self.types.SimpleNamespace(record=self.record,archive=self.base/'new.tar.gz',manifest=self.base/'new-manifest.json',pending=self.base/'new-pending.json')),0)
        self.assertTrue(calls);self.assertTrue(all(791 in allowed and 900 in allowed and 1999 not in allowed for allowed in calls))
        self.module.verify(self.types.SimpleNamespace(record=self.record,archive=self.base/'new.tar.gz',manifest=self.base/'new-manifest.json',ref=self.newref,machine='abc123',app='fixture',image='image@sha256:fixture',caller=self.caller))

    def test_archived_continuation_must_equal_embedded_receipt(self):
        self.prepare();self.module.launch(self.launch)
        archive=self.base/'new.tar.gz';manifest=self.base/'new-manifest.json'
        with patch.object(self.module,'writers',return_value=[]):
            self.assertEqual(self.module.export(self.types.SimpleNamespace(record=self.record,archive=archive,manifest=manifest,pending=self.base/'pending.json')),0)
        original_record=self.record.read_bytes();original_manifest=manifest.read_bytes()
        for key,value in (('old_archive_sha256','f'*64),('unbound_receipt_field','different from archived original')):
            with self.subTest(key=key):
                record=json.loads(original_record);record['continuation'][key]=value
                metadata=json.loads(original_manifest);metadata['record']=record
                self.record.write_text(json.dumps(record));manifest.write_text(json.dumps(metadata))
                with self.assertRaisesRegex(ValueError,'archived continuation'):
                    self.module.verify(self.types.SimpleNamespace(record=self.record,archive=archive,manifest=manifest,ref=self.newref,machine='abc123',app='fixture',image='image@sha256:fixture',caller=self.caller))
        self.record.write_bytes(original_record);manifest.write_bytes(original_manifest)

    def test_exact_idle_init_permission_does_not_hide_sleep_child(self):
        self.prepare();self.module.launch(self.launch)
        with patch.object(self.module,'writers',return_value=[{'pid':1999,'birth':self.birth(1999)}]):
            self.assertEqual(self.module.export(self.types.SimpleNamespace(record=self.record,archive=self.base/'refused.tar.gz',manifest=self.base/'refused-manifest.json',pending=self.base/'pending.json')),75)
        self.assertFalse((self.base/'refused.tar.gz').exists())

    def test_mismatched_continuation_bindings_refuse_before_launch(self):
        self.prepare();original=self.cont.read_bytes()
        faults={'old_ownership_sha256':'f'*64,'new_ref':'f'*40,'new_driver_birth':'wrong','old_init_birth':'wrong','epoch':1235.,'old_record_sha256':'f'*64,'old_manifest_sha256':'f'*64,'old_archive_sha256':'f'*64,'resource_release_verified':True}
        for key,value in faults.items():
            with self.subTest(key=key):
                row=json.loads(original);row[key]=value;self.cont.write_text(json.dumps(row))
                with self.assertRaises(ValueError):self.module.launch(self.launch)
                self.assertFalse(self.record.exists())
        self.cont.write_bytes(original)

    def test_replaced_original_root_or_live_init_refuses(self):
        self.prepare()
        with patch.object(self.module,'birth',side_effect=lambda pid:'foreign' if pid==791 else self.birth(pid)):
            with self.assertRaises(ValueError):self.module.launch(self.launch)
        self.common.rename(self.repo/'.git-original');self.common.mkdir()
        with self.assertRaises(ValueError):self.module.launch(self.launch)

    def test_original_collector_and_volume_remain_mandatory(self):
        self.prepare()
        with patch.object(self.module.subprocess,'check_output',return_value=self.collector+b'\n# changed'):
            with self.assertRaises(ValueError):self.module.launch(self.launch)
        with patch.dict(os.environ,{'GATE_WORKSPACE_VOLUME_ID':'vol_foreign'}):
            with self.assertRaises(ValueError):self.module.launch(self.launch)
        with patch.dict(os.environ,{},clear=True):
            with self.assertRaises(ValueError):self.module.launch(self.launch)

    def test_default_launch_keeps_original_source_guard(self):
        self.launch.continuation=None
        with self.assertRaisesRegex(ValueError,'workspace ownership changed'):self.module.launch(self.launch)


if __name__ == "__main__":
    unittest.main()
