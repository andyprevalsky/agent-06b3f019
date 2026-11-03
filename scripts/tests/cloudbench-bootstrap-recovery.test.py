"""Exact fresh infra bootstrap cancellation: no services or provider allocation."""

import base64
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
import runpy
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from contextlib import contextmanager
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
    @contextmanager
    def controller_snapshot(self):
        """Exercise the real immutable-copy producer, stopping before CLI work."""
        with tempfile.TemporaryDirectory(dir=self.base) as temporary:
            directory = Path(temporary)
            ready, release = directory / "entry-ready", directory / "entry-release"
            environment = os.environ.copy()
            for key in tuple(environment):
                if key.startswith("CLOUDBENCH_SCRIPT_SNAPSHOT"):
                    environment.pop(key)
            environment.update(
                TMPDIR=str(directory),
                PYTHONDONTWRITEBYTECODE="1",
                CLOUDBENCH_FAKE_DIR=str(directory / "fake-provider"),
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
                        "controller did not enter its immutable snapshot",
                    )
                    snapshots = list(directory.glob("cloudbench-scripts.*"))
                    self.assertEqual(len(snapshots), 1)
                    yield snapshots[0]
                finally:
                    release.touch()
                    controller.wait(timeout=30)
                self.assertEqual(controller.returncode, 0)
                self.assertFalse(
                    snapshots[0].exists(), "exact snapshot owner did not retire"
                )

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
            {
                "version": "2",
                "fleet_owner_token": OWNER,
                "cleanup_policy": "retain",
                "run_id": RUN,
                "runs_root": str(self.run.parent),
                "audit_dir": str(self.audit),
                "app": APP,
            },
        )
        write(self.registry / "guest-cleanup-unconfirmed", "")
        pairs(
            self.audit / "meta", {"fleet_owner_token": OWNER, "run_id": RUN, "app": APP}
        )
        pairs(
            self.audit / "fresh" / CLONE,
            {
                "version": "1",
                "fleet_owner_token": OWNER,
                "run_id": RUN,
                "app": APP,
                "clone_name": CLONE,
                "source": "fresh-clone",
                "machine_id": MACHINE,
                "volume_id": VOLUME,
                "disposition": "owned",
            },
        )
        pairs(
            self.registry / "clones" / CLONE,
            {"name": CLONE, "id": MACHINE, "volume_id": VOLUME},
        )
        write(self.audit / "by-machine-id" / MACHINE, CLONE + "\n")
        write(
            self.run / "_batch/lifecycle.json",
            json.dumps(
                {
                    "version": 1,
                    "status": "failed",
                    "controller_exit_code": 1,
                    "fleet_owner_token": OWNER,
                    "run_id": RUN,
                }
            ),
        )
        write(self.run / "_batch/benches.json", json.dumps([{"name": BENCH}]))
        for name, value in {
            ".cid": "clone " + MACHINE + "\n",
            "primary.ids": MACHINE + "\n",
            "post-config-start.accepted": MACHINE + "\n",
            "benchmark-child.finished": "143\n",
            "desired-worker-count": "0\n",
        }.items():
            write(self.out / name, value)
        self.config = {
            "init": {"cmd": ["bash", "/cloudbench-boot.sh"]},
            "image": "registry.fly.io/test@sha256:" + "c" * 64,
            "mounts": [{"volume": VOLUME, "path": "/data"}],
            "env": {
                "CLOUDBENCH_RUN_TOKEN": TOKEN,
                "CLOUDBENCH_INFRA_PROBE": "1",
                "CLOUDBENCH_FRESH_VOLUME": "1",
                "REF": REF,
                "BENCH_TASKS_B64": base64.b64encode(BENCH.encode()).decode(),
            },
        }
        self.native = [
            {"id": MACHINE, "name": CLONE, "state": "stopped", "config": self.config}
        ]
        write(self.machines, json.dumps(self.native))
        write(
            self.volumes, json.dumps([{"id": VOLUME, "attached_machine_id": MACHINE}])
        )
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
        self.configure_reviewed_source_fixture()
        self.update_review()

    def configure_reviewed_source_fixture(self):
        """Commit one reviewed test recipe without approving the real checkout."""
        _, receipt = self.verify()
        self.reviewed_source_root = self.base / "reviewed-source"
        self.reviewed_source_root.mkdir()
        for name in (
            "cloudbench-prestack-recovery.py",
            "cloudbench_execution_provenance.py",
        ):
            write(
                self.reviewed_source_root / "scripts" / name,
                git_blob("scripts/" + name),
            )
        self.reviewed_policy = {
            "schema_version": 1,
            "reviewed_executable_sources": {
                receipt["source_review_fingerprint"]: [receipt["bootstrap_phase"]]
            },
        }
        write(
            self.reviewed_source_root
            / "scripts/cloudbench-prestack-source-reviews.json",
            json.dumps(self.reviewed_policy),
        )
        for args in (
            ["init", "-q"],
            ["add", "scripts"],
            [
                "-c", "user.name=Offline test fixture",
                "-c", "user.email=fixture@example.invalid",
                "-c", "core.hooksPath=/dev/null",
                "commit", "-qm", "Review the single bootstrap fixture recipe",
            ],
        ):
            subprocess.run(
                ["git", "-C", str(self.reviewed_source_root), *args], check=True
            )
        self.reviewed_source_ref = subprocess.check_output(
            ["git", "-C", str(self.reviewed_source_root), "rev-parse", "HEAD"],
            text=True,
        ).strip()
        self.reviewed_helper = (
            self.reviewed_source_root / "scripts/cloudbench-prestack-recovery.py"
        )
        fixture_spec = importlib.util.spec_from_file_location(
            "reviewed_bootstrap_fixture", self.reviewed_helper
        )
        assert fixture_spec and fixture_spec.loader
        fixture = importlib.util.module_from_spec(fixture_spec)
        fixture_spec.loader.exec_module(fixture)
        policy = patch.object(
            recovery, "trusted_source_review_policy", fixture.trusted_source_review_policy
        )
        policy.start()
        self.addCleanup(policy.stop)

    def test_bound_source_uses_private_snapshot_during_checkout_cache_churn(self):
        cache = (
            ROOT
            / "tests"
            / "__pycache__"
            / (self.base.name + ".cpython-311.pyc.140402480162944")
        )
        write(cache, b"transient interpreter output")
        self.addCleanup(cache.unlink, missing_ok=True)
        original_rglob = Path.rglob
        mutable_walks = []

        def disappearing_cache(path, pattern):
            paths = list(original_rglob(path, pattern))
            if path == ROOT:
                mutable_walks.append(path)
                cache.unlink(missing_ok=True)
            return iter(paths)

        with patch.object(Path, "rglob", disappearing_cache):
            try:
                self.configure_bound_source()
            except ValueError as error:
                self.fail(
                    "fixture sealed mutable checkout instead of private controller source: "
                    + str(error)
                )
        self.assertEqual(
            mutable_walks, [], "source binding enumerated the mutable checkout"
        )

    def test_private_snapshot_rejects_changed_source_and_added_bytecode(self):
        for mutation in ("changed-source", "added-bytecode", "added-unknown-source"):
            with (
                self.subTest(mutation=mutation),
                self.controller_snapshot() as snapshot,
            ):
                owner = runpy.run_path(
                    str(snapshot / "cloudbench_execution_provenance.py")
                )
                manifest = owner["build_snapshot_manifest"](snapshot)
                self.assertEqual(
                    manifest,
                    json.loads(
                        (snapshot / owner["SNAPSHOT_MANIFEST_NAME"]).read_text()
                    ),
                )
                source = snapshot / "cloudbench_catalog.py"
                original = source.read_bytes()
                added = snapshot / "__pycache__" / "cloudbench_catalog.cpython-311.pyc"
                if mutation == "changed-source":
                    source.write_bytes(original + b"\n# changed dependency\n")
                elif mutation == "added-bytecode":
                    write(added, b"unattested bytecode")
                else:
                    added = snapshot / "unlisted-source.py"
                    write(added, b"print('unattested dependency')\n")
                try:
                    with self.assertRaisesRegex(ValueError, "snapshot digest mismatch"):
                        owner["verify_snapshot"](snapshot, manifest)
                finally:
                    source.write_bytes(original)
                    added.unlink(missing_ok=True)

    def test_private_snapshot_rejects_source_disappearing_during_hash(self):
        with self.controller_snapshot() as snapshot:
            owner = runpy.run_path(str(snapshot / "cloudbench_execution_provenance.py"))
            source = snapshot / "cloudbench_catalog.py"
            original = source.read_bytes()
            original_rglob = Path.rglob

            def disappearing_source(path, pattern):
                paths = list(original_rglob(path, pattern))
                if path == snapshot:
                    source.unlink(missing_ok=True)
                return iter(paths)

            try:
                with (
                    patch.object(Path, "rglob", disappearing_source),
                    self.assertRaisesRegex(
                        ValueError, "snapshot changed while hashing"
                    ),
                ):
                    owner["build_snapshot_manifest"](snapshot)
            finally:
                source.write_bytes(original)

    def configure_bound_source(self):
        self.config["env"]["REF"] = REF
        self.source = {p: digest(git_blob(p)) for p in recovery.recipe_paths(git_blob, REPO, REF)}
        with (self.registry / "meta").open("a") as stream:
            stream.write("workspace_root=" + str(REPO) + "\n")
        # Bind the same private, complete dependency copy used by the controller.
        # The mutable scripts checkout also contains unrelated test/cache writes.
        with self.controller_snapshot() as snapshot:
            owner = runpy.run_path(str(snapshot / "cloudbench_execution_provenance.py"))
            manifest = owner["build_snapshot_manifest"](snapshot)
            self.assertEqual(
                manifest,
                json.loads((snapshot / owner["SNAPSHOT_MANIFEST_NAME"]).read_text()),
            )
            config = owner["build_config"](
                "cloudbench-fleet-config-v1", ["app=" + APP, "task_count=1"]
            )
            document = owner["build_provenance"](
                base_sha=REF,
                workspace_patch_sha256="none",
                snapshot_manifest=manifest,
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

    def test_browser_asset_preflight_is_past_the_index_source_boundary(self):
        # No browser-helper execution/output can borrow the earlier index interval.
        original = self.original["repo/.context/cloudbench/stack.log"]
        for helper_output in (
            b"",
            b"command interrupted; cleanup diagnostics\n",
            b"changed browser preflight executable output\n",
        ):
            with self.subTest(helper_output=helper_output):
                self.original["repo/.context/cloudbench/stack.log"] = (
                    original + "📦 Ensuring Playwright browser assets...\n".encode() + helper_output
                )
                self.make_capture()
                with self.assertRaisesRegex(ValueError, "final source boundary"):
                    self.verify()

    def test_public_tunnel_start_is_past_the_index_source_boundary(self):
        # Restore path with healthy dependencies and no local DEMO cache:
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

    def test_normal_controller_snapshot_includes_exact_machines_reader(self):
        """The real sealed entrypoint must carry the recovery consumer's reader."""
        snapshot_temp=self.base/'native-reader-snapshot';snapshot_temp.mkdir()
        ready,release=self.base/'reader-ready',self.base/'reader-release'
        environment=os.environ.copy()
        for key in tuple(environment):
            if key.startswith('CLOUDBENCH_SCRIPT_SNAPSHOT'):
                environment.pop(key)
        environment.update(TMPDIR=str(snapshot_temp),PYTHONDONTWRITEBYTECODE='1',
            CLOUDBENCH_FAKE_DIR=str(self.base/'fake-provider'),
            CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_ENTRY_READY=str(ready),
            CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_ENTRY_RELEASE=str(release))
        with tempfile.TemporaryFile() as output:
            controller=subprocess.Popen(['bash',str(ROOT/'run-bench-fleet'),'--recover-stale-owner','invalid-token'],env=environment,stdout=output,stderr=subprocess.STDOUT)
            try:
                deadline=time.monotonic()+30
                while not ready.exists() and controller.poll() is None and time.monotonic()<deadline:
                    time.sleep(0.02)
                self.assertTrue(ready.exists(),'real controller did not enter its sealed script snapshot')
                snapshots=list(snapshot_temp.glob('cloudbench-scripts.*'));self.assertEqual(len(snapshots),1)
                reader=snapshots[0]/'cloudbench-campaign-machines.py'
                # Execute the exact failing import boundary from the real snapshot;
                # fetch is never invoked, so this control cannot dispatch a request.
                imported=subprocess.run([sys.executable,'-I','-B','-c',
                    'import runpy,sys,json; from pathlib import Path; p=Path(sys.argv[1]); '
                    'm=runpy.run_path(str(p)); assert callable(m["fetch"]); '
                    'v=runpy.run_path(str(p.with_name("cloudbench_execution_provenance.py"))); '
                    'v["verify_snapshot"](p.parent,json.loads(p.with_name("cloudbench-controller-snapshot-manifest.json").read_text()))',str(reader)],
                    env=environment,capture_output=True,text=True,timeout=5)
                self.assertEqual(imported.returncode,0,imported.stderr)
                self.assertEqual(reader.read_bytes(),(ROOT/'cloudbench-campaign-machines.py').read_bytes())
                self.assertFalse(reader.is_symlink())
                volume_reader=snapshots[0]/'cloudbench-original-volume-capture.py'
                self.assertEqual(volume_reader.read_bytes(),(ROOT/'cloudbench-original-volume-capture.py').read_bytes())
                module=runpy.run_path(str(volume_reader))
                self.assertTrue(callable(module['Fly']))
                manifest=json.loads((snapshots[0]/'cloudbench-controller-snapshot-manifest.json').read_text())
                entry=next(row for row in manifest['files'] if row['path']==reader.name)
                self.assertEqual(entry['sha256'],digest(reader.read_bytes()))
            finally:
                release.touch();controller.wait(timeout=30)
            self.assertEqual(controller.returncode,2)
            output.seek(0);self.assertIn(b'--recover-stale-owner requires exactly 32',output.read())
        self.assertFalse(list(snapshot_temp.glob('cloudbench-scripts.*')),'exact owned snapshot must join/remove normally')

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
                self.assertEqual(
                    policy.read_bytes(),
                    (ROOT / "cloudbench-prestack-source-reviews.json").read_bytes(),
                )
                # Exercise a legitimately committed, finite fixture policy.
                # The current checkout's production policy need not approve
                # the current native recipe merely because this is a test.
                policy.write_bytes(
                    (
                        self.reviewed_source_root
                        / "scripts/cloudbench-prestack-source-reviews.json"
                    ).read_bytes()
                )
                subprocess.run(
                    [
                        sys.executable,
                        str(snapshot / "cloudbench_execution_provenance.py"),
                        "snapshot", "--snapshot-dir", str(snapshot),
                        "--output",
                        str(snapshot / "cloudbench-controller-snapshot-manifest.json"),
                    ],
                    env=environment,
                    check=True,
                    capture_output=True,
                )
                environment.update(
                    CLOUDBENCH_FLEET_ROOT=str(self.reviewed_source_root),
                    CLOUDBENCH_SCRIPT_SNAPSHOT=str(snapshot),
                    CLOUDBENCH_PRESTACK_CONTROLLER_REF=self.reviewed_source_ref,
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
                    check=False,
                )
                self.assertEqual(published.returncode, 0, published.stderr)
                self.assertEqual(json.loads(published.stdout)["proof_credit"], 0)
                validated = subprocess.run(
                    args + ["--validate-published-bootstrap"],
                    env=environment,
                    capture_output=True,
                    text=True,
                    check=False,
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
                    check=False,
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
                    check=False,
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
            recovery.trusted_source_review_policy().get(
                receipt["source_review_fingerprint"], []
            ),
        )
        original_run = subprocess.run
        for path in (
            "scripts/lib/run-process-cleanup.sh",
            "scripts/run.sh",
            "scripts/process-identity.py",
            "scripts/ensure-playwright-browsers.py",
        ):
            with self.subTest(path=path):
                config = self.config
                if path == "scripts/process-identity.py":
                    # Bind the changed helper in both packed input and source
                    # lookup, so finite policy owns the rejection.
                    config = copy.deepcopy(self.config)
                    packed_file = next(
                        item
                        for item in config["files"]
                        if item["guest_path"] == "/cloudbench-boot-payload.json.gz"
                    )
                    packed = json.loads(
                        gzip.decompress(base64.b64decode(packed_file["raw_value"]))
                    )
                    helper = base64.b64decode(packed["files"]["process-identity.py"])
                    packed["files"]["process-identity.py"] = base64.b64encode(
                        helper + b"\n# unreviewed executable-source fixture mutation\n"
                    ).decode()
                    envelope = gzip.compress(json.dumps(packed).encode())
                    packed_file["raw_value"] = base64.b64encode(envelope).decode()
                    config["env"]["CLOUDBENCH_BOOT_PAYLOAD_SHA256"] = recovery.sha(
                        envelope
                    )

                def changed_blob(argv, *args, changed_path=path, **kwargs):
                    result = original_run(argv, *args, **kwargs)
                    if argv == [
                        "git",
                        "-C",
                        str(REPO),
                        "show",
                        REF + ":" + changed_path,
                    ]:
                        self.assertEqual(result.returncode, 0)
                        result.stdout += (
                            b"\n# unreviewed executable-source fixture mutation\n"
                        )
                    return result

                with patch.object(recovery.subprocess, "run", side_effect=changed_blob):
                    ref, recipe_sha, fingerprint = recovery.native_recipe(
                        recovery.fields(self.registry / "meta"), config
                    )
                self.assertEqual(ref, REF)
                self.assertNotEqual(fingerprint, receipt["source_review_fingerprint"])
                changed = dict(
                    receipt,
                    source_recipe_sha256=recipe_sha,
                    source_review_fingerprint=fingerprint,
                )
                # A matching capture-local review marker still has no authority
                # to bless an executable recipe absent from committed policy.
                write(
                    self.captures / "source-boundary-reviewed.safe.json",
                    json.dumps(
                        {
                            "reviewed": True,
                            "reviewer": "capture writer",
                            "source_ref": ref,
                            "source_recipe_sha256": recipe_sha,
                            "pre_service_boundaries": [changed["bootstrap_phase"]],
                        }
                    ),
                )
                with self.assertRaisesRegex(ValueError, "trusted independent review"):
                    recovery.require_independent_source_review(changed)
                self.assertFalse((self.out / "guest-bootstrap.confirmed").exists())

    def test_optional_executable_capture_hash_is_mandatory(self):
        helper = "scripts/ensure-playwright-browsers.py"
        self.assertIn(helper, recovery.recipe_paths(git_blob, REPO, REF))
        self.provenance["source_file_sha256"].pop(helper)
        self.write_provenance()
        with self.assertRaisesRegex(ValueError, "captured checkout differs"):
            self.verify()
        self.provenance["source_file_sha256"][helper] = "e" * 64
        self.write_provenance()
        with self.assertRaisesRegex(ValueError, "captured checkout differs"):
            self.verify()

    def test_optional_executable_legacy_absence_and_foreign_types(self):
        original = subprocess.run
        lookup = ["git", "-C", str(REPO), "ls-tree", "-z", REF, "--", "scripts/ensure-playwright-browsers.py"]
        for output, accepted in [(b"", True), (b"120000 blob " + b"a"*40 + b"\tscripts/ensure-playwright-browsers.py\0", False)]:
            with self.subTest(output=output):
                def capture(argv, *args, **kwargs):
                    if argv == lookup:
                        return subprocess.CompletedProcess(argv, 0, output, b"")
                    return original(argv, *args, **kwargs)
                with patch.object(recovery.subprocess, "run", side_effect=capture):
                    if accepted:
                        self.assertEqual(recovery.recipe_paths(git_blob, REPO, REF), recovery.recipe_paths(git_blob))
                    else:
                        with self.assertRaisesRegex(ValueError, "regular committed blob"):
                            recovery.recipe_paths(git_blob, REPO, REF)

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
        spec = importlib.util.spec_from_file_location(
            "isolated_recovery_inverse", owner
        )
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
            self.assertNotEqual(
                path.resolve(), shared, "inverse fixture writes shared source"
            )
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
        with (
            patch.object(
                recovery.importlib.util, "spec_from_file_location", return_value=None
            ),
            self.assertRaisesRegex(ValueError, "owner module cannot be loaded"),
        ):
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
        self.provenance = {
            "version": 1,
            "machine_id": MACHINE,
            "guest_run_token": TOKEN,
            "direct_original_volume": True,
            "source_machine_id": MACHINE,
            "source_volume_id": VOLUME,
            "git_head": REF,
            "git_exit_code": 0,
            "tracked_change_exit_code": 0,
            "tracked_changed_paths": [],
            "source_file_sha256": self.source,
            "files": {
                name: {"bytes": len(data), "sha256": digest(data)}
                for name, data in self.original.items()
            },
            "missing": self.missing,
            "archive_sha256": digest(archive.read_bytes()),
            "archive_bytes": archive.stat().st_size,
            "native_original_config_sha256": digest(
                (
                    json.dumps(self.config, sort_keys=True, separators=(",", ":"))
                    + "\n"
                ).encode()
            ),
            "proof_credit": 0,
        }
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
        pairs(self.audit / "fresh" / CLONE, {"fleet_owner_token": "d" * 32})
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
PRESTACK_RECOVERY_HELPER={self.reviewed_helper}
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
            ["bash", "-c", command],
            env=env,
            capture_output=True,
            text=True,
            check=False,
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
            str(self.reviewed_helper),
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
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertNotEqual(result.returncode, 0)



class PreconfigStartupArchiveFixture:
    """Original admission intent may precede config, lifecycle and guest ACK.

    Fixture mixin (setUp + helpers, no cases) shared by PreconfigStartupArchiveTests,
    AllocatedCurrentColdTests and CrossControllerColdHandoffTests. Subclassing the
    TestCase instead made unittest collect its 12 cases again under each subclass
    with this identical setUp (SuiteShapeTests pins the mixin shape).
    """
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

    def capture(self):
        self.helper["capture_preconfig"](self.registry, self.out, MACHINE, TOKEN, self.archive)

    def verify(self, native=True):
        return self.helper["verify_preconfig"](self.registry, self.out, MACHINE, TOKEN, self.archive,
                                              self.before if native else None, self.after if native else None)


class PreconfigStartupArchiveTests(PreconfigStartupArchiveFixture, unittest.TestCase):
    def test_preconfig_startup_original_tuple_is_eligible_without_synthetic_ack(self):
        # Replay the former identity boundary when the additive phase is absent.
        identity = self.helper.get("preconfig_identity", self.helper["identity"])
        meta, original = identity(self.registry, self.out, MACHINE, TOKEN)
        self.assertEqual(meta["run_id"], RUN)
        self.assertEqual(original["volume_id"], VOLUME)
        self.assertFalse((self.run / "_batch/lifecycle.json").exists())
        self.assertFalse((self.out / "guest-shutdown.confirmed").exists())

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
        receipt = base / "consumed.json"
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
        receipt = base / "consumed.json"
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


class OriginalVolumeProcessScanTests(unittest.TestCase):
    def setUp(self):
        self.scan = runpy.run_path(
            str(REPO / "scripts/cloudbench-original-volume-capture.py")
        )["_scan_processes"]
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.proc = Path(temporary.name)
        self.entries = ["910001", "910002", "910003"]
        for pid, command in zip(self.entries, (
            b"sleep\0infinity\0", b"unreadable\0", b"cloudbench-worker\0"
        )):
            write(self.proc / pid / "cmdline", command)

    def scan_with_read_error(self, error):
        read_bytes = Path.read_bytes
        unreadable = self.proc / self.entries[1] / "cmdline"

        def read(path):
            if path == unreadable:
                raise error
            return read_bytes(path)

        with patch("pathlib.Path.read_bytes", read), patch(
            "os.listdir", return_value=self.entries
        ), patch("os.getpid", return_value=1), patch("os.getppid", return_value=2):
            return self.scan(self.proc)

    def test_process_scan_propagates_timeout_after_observing_inert_process(self):
        error = TimeoutError("original observation deadline")
        with self.assertRaises(TimeoutError) as caught:
            self.scan_with_read_error(error)
        self.assertIs(caught.exception, error)

    def test_process_scan_skips_ordinary_read_errors_and_keeps_other_evidence(self):
        for error in (OSError("read failed"), PermissionError("denied"),
                      FileNotFoundError("process exited")):
            with self.subTest(error=type(error).__name__):
                self.assertEqual(self.scan_with_read_error(error), (
                    1, [{"pid": 910003, "argv0": "cloudbench-worker"}]
                ))


class BoundedProcessOutputTests(unittest.TestCase):
    """Actual subprocess output survives interruption without being printed."""
    def setUp(self):
        self.run_bounded = runpy.run_path(
            str(REPO / "scripts/cloudbench-original-volume-capture.py")
        )["run_bounded"]

    def interrupted(self, stdout, stderr):
        import contextlib
        import signal
        with tempfile.TemporaryDirectory() as temporary:
            ready = Path(temporary) / 'ready'
            code = ('import os,pathlib,time;'
                    f'os.write(1,{stdout!r});os.write(2,{stderr!r});'
                    f'pathlib.Path({str(ready)!r}).touch();time.sleep(30)')
            created = []
            waits = []
            popen = subprocess.Popen
            alarm = TimeoutError('bounded process outer alarm')
            def start(*args, **kwargs):
                process = popen(*args, **kwargs)
                created.append(process)
                communicate = process.communicate
                def observed_communicate(*args, **kwargs):
                    waits.append(kwargs.get('timeout'))
                    if len(waits) > 1:
                        self.assertEqual(kwargs.get('timeout'), 0, 'interrupted drain must not wait')
                    return communicate(*args, **kwargs)
                process.communicate = observed_communicate
                deadline = time.monotonic() + 5
                while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(.005)
                self.assertTrue(ready.exists(), 'subprocess did not emit ready marker')
                signal.setitimer(signal.ITIMER_REAL, .05)
                return process
            def expired(*unused):
                raise alarm
            old_handler = signal.signal(signal.SIGALRM, expired)
            old_timer = signal.getitimer(signal.ITIMER_REAL)
            self.assertEqual(old_timer, (0.0, 0.0))
            printed_out, printed_err = io.StringIO(), io.StringIO()
            try:
                with patch('subprocess.Popen', side_effect=start), \
                        contextlib.redirect_stdout(printed_out), contextlib.redirect_stderr(printed_err), \
                        self.assertRaises(TimeoutError) as caught:
                    self.run_bounded([sys.executable, '-I', '-c', code], 10, dict(os.environ))
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, old_handler)
                for process in created:
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=2)
            self.assertIs(caught.exception, alarm)
            self.assertEqual(waits, [10, 0])
            self.assertIsNotNone(created[0].returncode, 'interrupted child was not reaped')
            self.assertEqual(printed_out.getvalue(), '')
            self.assertEqual(printed_err.getvalue(), '')
            self.assertEqual(caught.exception.stdout, stdout)
            self.assertEqual(caught.exception.stderr, stderr)

    def test_outer_alarm_preserves_exact_private_partial_bytes(self):
        self.interrupted(b'private stdout\x00\xff\n', b'private stderr\x00\xfe\n')

    def test_outer_alarm_preserves_empty_byte_streams(self):
        self.interrupted(b'', b'')

    def test_normal_completion_contract_unchanged(self):
        self.assertEqual(self.run_bounded(
            [sys.executable, '-I', '-c', 'import os;os.write(1,b"out");os.write(2,b"err")'],
            5, dict(os.environ)), (0, b'out', b'err'))

    def test_subprocess_deadline_contract_unchanged(self):
        self.assertEqual(self.run_bounded(
            [sys.executable, '-I', '-c', 'import os,time;os.write(1,b"out");os.write(2,b"err");time.sleep(30)'],
            .2, dict(os.environ)), (142, b'out', b'err'))


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


class ControllerExportContinuationFixture:
    """Real old-source seal and new launch/export, native-free temporary originals.

    Fixture mixin (setUp + helpers, no cases) shared by ControllerExportContinuationTests
    and RetainedControllerEndpointTests. Subclassing the TestCase instead made unittest
    collect its 12 cases again under RetainedControllerEndpointTests with this identical
    setUp, including a second EXPORT_WRITER_DRAIN_SECONDS (120 s) writer drain.
    """
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


class ControllerExportContinuationTests(ControllerExportContinuationFixture, unittest.TestCase):
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
            archive=self.base/'drift.tar.gz';manifest=self.base/'drift-manifest.json';pending=self.base/'drift-pending.json'
            args=self.types.SimpleNamespace(record=self.oldrecord,archive=archive,manifest=manifest,pending=pending,capture_tool_ref=toolref)
            # Persistent drift: no attempt is ever sealed, and the evidence names the FIFO.
            def drifting(roots,permitted):
                calls.append(1)
                if len(calls)%2==0:os.utime(fifo,ns=(len(calls),len(calls)))
                return []
            with patch.object(self.module,'writers',side_effect=drifting),patch.object(self.module,'EXPORT_SETTLE_SECONDS',0):
                self.assertEqual(self.module.export(args),75)
            self.assertFalse(archive.exists());self.assertFalse(manifest.exists());self.assertTrue(stat.S_ISFIFO(fifo.lstat().st_mode))
            self.assertIn(str(fifo),[row['path'] for attempt in json.loads(pending.read_text())['snapshot_attempts'] for row in attempt['changed']])
            pending.unlink();calls.clear()
            # One drift during capture: the drifted snapshot is discarded and a fresh
            # strict snapshot seals only the settled FIFO metadata.
            with patch.object(self.module,'writers',side_effect=writers),patch.object(self.module,'EXPORT_SETTLE_SECONDS',0):
                self.assertEqual(self.module.export(args),0)
            self.assertTrue(stat.S_ISFIFO(fifo.lstat().st_mode));self.assertFalse(pending.exists())
            row=json.loads(manifest.read_text())['files']['context/native-retirement.pipe']
            self.assertEqual((row['kind'],row['stat']['mtime_ns']),('fifo',1))

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
        # The writer persists, so export must wait out the whole bounded drain
        # before refusing; a short drain proves the same refusal without 120 s.
        # Pin the production values first so the patch below can never mask a
        # change to the real drain bound (twice the 60 s fleet destroy bound).
        self.assertEqual(self.module.EXPORT_WRITER_DRAIN_SECONDS,120)
        self.assertEqual(self.module.EXPORT_WRITER_POLL_SECONDS,1)
        self.assertRegex(Path(self.module.__file__).read_text(),r'writer_deadline = time\.monotonic\(\) \+ EXPORT_WRITER_DRAIN_SECONDS\b')
        with patch.object(self.module,'writers',return_value=[{'pid':1999,'birth':self.birth(1999)}]),\
                patch.object(self.module,'EXPORT_WRITER_DRAIN_SECONDS',0.3),patch.object(self.module,'EXPORT_WRITER_POLL_SECONDS',0.01):
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




class RetainedControllerEndpointTests(ControllerExportContinuationFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.prepare();self.module.launch(self.launch)
        self.native=dict(id='abc123',instance_id='native-original',state='started',config=dict(
            init={'cmd':['bash','/tmp/gate.sh']},image='image@sha256:fixture',restart={'policy':'no'},
            auto_destroy=False,mounts=[{'volume':'vol_fixture','path':'/data'}]))
        self.native_path=self.base/'original-native.json';write(self.native_path,json.dumps(self.native))
        self.native_sha=digest(self.native_path.read_bytes())

    def checked_endpoint(self,native=None,ref=None):
        return self.module.retained_controller_endpoint(self.record,self.repo,ref or self.newref,
            native or self.native,self.native_path,self.native_sha)

    def test_retained_endpoint_preserves_original_init_and_checks_authorized_idle_driver(self):
        with patch.object(self.module,'writers',return_value=[]),patch.object(self.module,'driver_is_ancestor',return_value=True,create=True),patch.object(self.module,'process_argv',return_value=['bash','/tmp/gate.sh'],create=True):
            result=self.checked_endpoint()
        self.assertEqual(result['source_ref'],self.newref)
        self.assertEqual(self.native['config']['init'],{'cmd':['bash','/tmp/gate.sh']})
        self.assertEqual(self.owner.read_bytes(),self.original)

    def test_retained_endpoint_rejects_wrong_init_source_roots_and_live_writers(self):
        with patch.object(self.module,'writers',return_value=[]),patch.object(self.module,'driver_is_ancestor',return_value=True,create=True),patch.object(self.module,'process_argv',return_value=['bash','/tmp/gate.sh'],create=True):
            bad=copy.deepcopy(self.native);bad['config']['init']={'cmd':['sleep','infinity']}
            with self.assertRaises(ValueError):self.checked_endpoint(bad)
            with self.assertRaises(ValueError):self.checked_endpoint(ref='f'*40)
            with patch.object(self.module,'writers',return_value=[{'pid':1999,'birth':'active'}]),self.assertRaises(ValueError):self.checked_endpoint()
            with patch.object(self.module,'driver_is_ancestor',return_value=False,create=True),self.assertRaises(ValueError):self.checked_endpoint()
            with patch.object(self.module,'process_argv',return_value=['bash','foreign.sh'],create=True),self.assertRaises(ValueError):self.checked_endpoint()
            self.common.rename(self.repo/'.git-original');self.common.mkdir()
            with self.assertRaises(ValueError):self.checked_endpoint()

    def test_native_baseline_is_hashed_and_must_be_historical_exact_identity(self):
        with patch.object(self.module,'writers',return_value=[]),patch.object(self.module,'driver_is_ancestor',return_value=True,create=True),patch.object(self.module,'process_argv',return_value=['bash','/tmp/gate.sh'],create=True):
            bad=copy.deepcopy(self.native);bad['instance_id']='replacement'
            with self.assertRaises(ValueError):self.checked_endpoint(bad)
            write(self.native_path,json.dumps(dict(self.native,id='foreign')))
            with self.assertRaises(ValueError):self.checked_endpoint()

    def test_existing_target_branch_uses_retained_verifier_without_changing_native_init(self):
        helper=runpy.run_path(os.environ.get('ROSE_RETAINED_ENDPOINT_HELPER_UNDER_TEST',str(ROOT/'cloudbench-retained-controller-endpoint.py')))
        capture=helper['capture_retained_target'];namespace=capture.__globals__
        mid='d'*14;volume='vol_fixture';native=dict(id=mid,instance_id='original',state='started',config=dict(
            init={'cmd':['bash','/tmp/gate.sh']},image='image@sha256:fixture',restart={'policy':'no'},auto_destroy=False,
            rootfs={'persist':'always','size_gb':50},mounts=[{'volume':volume,'path':'/data'}]))
        before=self.base/'endpoint-before.json';after=self.base/'endpoint-after.json';vol=self.base/'endpoint-volume.json';owner=self.base/'endpoint-owner.json'
        write(before,json.dumps(native));write(after,json.dumps(native));write(vol,json.dumps(dict(id=volume,attached_machine_id=mid,state='created')))
        write(owner,json.dumps(dict(schema='cloudbench-controller-workspace-ownership-v1',volume_id=volume,app='fixture',mount_path='/data')))
        calls=[]
        def checked(*args):calls.append(args);return {'workspace_ownership_sha256':digest(owner.read_bytes())}
        def git(command,**kwargs):return str(self.common)+'\n' if '--git-common-dir' in command else self.newref+'\n'
        with patch.dict(os.environ,FLY_MACHINE_ID=mid),patch.dict(namespace,{'verify_retained_endpoint':checked}),patch('subprocess.check_output',side_effect=git):
            result=capture(self.repo,self.common,before,after,owner,self.newref,'destination.cold.ids',
                retained={'record':str(self.record),'original_native':str(self.native_path),'original_native_sha256':self.native_sha},controller_volume=vol)
        self.assertEqual(result['machine'],mid);self.assertEqual(len(calls),1)
        self.assertEqual(json.loads(before.read_bytes())['config']['init'],{'cmd':['bash','/tmp/gate.sh']})


class SnapshotRepresentationTests(unittest.TestCase):
    """Provider placeholder and final row share one requested snapshot identity."""
    def setUp(self):
        helper=Path(os.environ.get('ROSE_SNAPSHOT_SELECTOR_UNDER_TEST',str(ROOT/'cloudbench-select-snapshot.py')))
        self.select=runpy.run_path(str(helper))['available_snapshot']
        self.sid='vs_exact123'
        self.pending=dict(id=self.sid,status='running',created_at='0001-01-01T00:00:00Z',digest='',size=0,volume_size=42949672960)
        self.complete=dict(id=self.sid,status='created',created_at='2026-10-16T02:37:41Z',digest='c9d4fcc26f23a4b789d4c3c2e389fb6e3d62a97c45d3e4784e97385258aaf678',size=692691630,volume_size=42949672960,retention_days=5)

    def test_pending_and_completed_same_id_selects_completed_in_either_order(self):
        for rows in ([self.pending,self.complete],[self.complete,self.pending]):
            self.assertEqual(self.select(rows,self.sid),self.complete)
        self.assertIsNone(self.select([self.pending],self.sid))
        self.assertIsNone(self.select([dict(self.complete,id='vs_other')],self.sid))
        self.assertIsNone(self.select([self.pending,dict(self.complete,id='vs_other')],self.sid))
        self.assertEqual(self.select([self.complete,dict(self.complete)],self.sid),self.complete)

    def test_conflicting_complete_failed_and_malformed_requested_rows_refuse(self):
        for key,value in [('digest','f'*64),('size',123),('volume_size',42),('created_at','2026-10-16T02:40:00Z')]:
            with self.subTest(key=key),self.assertRaises(ValueError):
                self.select([self.complete,dict(self.complete,**{key:value})],self.sid)
        for state in ('failed','error','cancelled'):
            with self.subTest(state=state),self.assertRaises(ValueError):
                self.select([self.complete,dict(self.pending,status=state)],self.sid)
        for key in ('digest','size','created_at','status'):
            malformed=dict(self.complete);malformed.pop(key)
            with self.subTest(missing=key),self.assertRaises(ValueError):self.select([malformed],self.sid)
        for row in (dict(self.pending,size=1),dict(self.complete,size=True),dict(self.complete,digest='not-a-digest'),dict(self.complete,state='running'),dict(self.pending,status=None)):
            with self.subTest(row=row),self.assertRaises(ValueError):self.select([row],self.sid)

    def test_actual_waiting_snapshot_responses_are_pending_not_failed(self):
        for number in (1,2):
            rows=json.loads((ROOT/'tests/fixtures'/f'snapshot-waiting-{number}.json').read_bytes())
            sid=rows[0]['id']
            with self.subTest(captured=number):
                self.assertEqual(rows[0]['status'],'waiting')
                self.assertIsNone(self.select(rows,sid))
                complete=dict(self.complete,id=sid)
                self.assertEqual(self.select(rows+[complete],sid),complete)
                self.assertEqual(self.select([complete]+rows,sid),complete)

    def test_waiting_never_waives_positive_conflicting_or_failed_evidence(self):
        waiting=dict(self.pending,status='waiting')
        for change in ({'size':1},{'digest':'a'*64},{'created_at':self.complete['created_at']},
                       {'state':'created'},{'state':'failed'},{'status':'unrecognized'}):
            with self.subTest(change=change),self.assertRaises(ValueError):
                self.select([dict(waiting,**change)],self.sid)
        for failed in ('failed','error','cancelled','canceled'):
            with self.subTest(failed=failed),self.assertRaises(ValueError):
                self.select([waiting,dict(self.pending,status=failed),self.complete],self.sid)


class AllocatedCurrentColdTests(PreconfigStartupArchiveFixture, unittest.TestCase):
    """New current-state custody never fabricates historical rejection evidence."""
    def setUp(self):
        super().setUp()
        self.source = self.base / 'source-common'; self.source.mkdir()
        self.destination = self.base / 'destination-common'; self.destination.mkdir()
        contract = runpy.run_path(str(REPO/'scripts/cloudbench_execution_provenance.py'))
        matrix = contract['build_task_matrix']([BENCH+'=real'])
        config = contract['build_config'](contract['CONFIG_SCHEMA_VERSION'], ['task_count=1',
            'task_matrix_sha256='+matrix['sha256'], 'node_dependency_fingerprint='+'b'*64,
            'python_dependency_fingerprint='+'c'*64, 'primary_vm_size=shared-cpu-2x', 'primary_vm_memory_mb=4096'])
        provenance = dict(schema_version=contract['EXECUTION_SCHEMA_VERSION'],base_sha='a'*40,
            workspace_patch_sha256='none',controller_snapshot=dict(schema_version=contract['SNAPSHOT_SCHEMA_VERSION'],sha256='d'*64),config=config)
        write(self.run/'execution-provenance.json',json.dumps(provenance))
        write(self.run/'execution-task-matrix.json',json.dumps(matrix))
        write(self.run/'_batch/run.json',json.dumps(dict(run_id=RUN,status='failed',controller_exit_code=1,execution_provenance=provenance)))
        write(self.registry/'meta',(self.registry/'meta').read_bytes()+b'pid_start=proc-start:00000000-0000-0000-0000-000000000000:123\n')
        for name in ('.cid','benchmark-child.finished','boot-config-unapplied'):
            (self.out/name).unlink()
        write(self.out/'primary.ids',MACHINE+'\n'); write(self.out/'primary.log','allocated '+MACHINE+'\n')
        write(self.registry/'guest-cleanup-unconfirmed','')
        self.native['state']='stopped'
        self.native['config']['guest']={'cpu_kind':'shared','cpus':2,'memory_mb':4096}
        write(self.before,json.dumps(self.native));write(self.after,json.dumps(self.native))
        self.volume=self.base/'volume.json'
        write(self.volume,json.dumps(dict(id=VOLUME,attached_machine_id=MACHINE,state='created')))
        self.guest=self.base/'guest.json'
        self.data=self.base/'data';self.data.mkdir()
        self.controller_log=self.base/'controller.log';write(self.controller_log,'original controller '+RUN+'\n')
        self.receipt=self.out/'allocated-current-cold/receipt.json'
        self.target=dict(machine='d'*14,volume='vol_destination',workspace='/retained/destination',common=str(self.destination),
            source_ref='e'*40,ownership_sha256='f'*64,controller_config_sha256='1'*64,preservation='rootfs-always',pool_name='destination.cold.ids')
        self.source_endpoint=dict(self.target,machine='4'*14,common=str(self.source),volume='vol_source')
        self.packet=self.base/'packet.json'

    def prepare_current(self):
        # Only the process observation boundary is mocked. Files/archive/claim FSM are real.
        with patch.dict(os.environ,FLY_MACHINE_ID=MACHINE):
            self.helper['capture_current_cold_guest'](self.data,TOKEN,self.guest,'original-instance','3'*32,
                mount=lambda data: {'device':42,'inode':10,'mount_device':'254:2'}, dependencies=lambda: {'node':'b'*64,'python':'c'*64}, observe=lambda: {'kind':'exact-inert-quiescence-v1','machine':MACHINE,'boot':'0'*36,'unknown':[],'inert_sleepers':[{'pid':1,'birth':'1'}],'idle_pinned_agents':[],'idle_platform_hallpass':[],'observed_epoch':1.0})
        self.helper['capture_current_cold'](self.registry,self.out,MACHINE,TOKEN,self.archive,
            self.before,self.after,self.volume,self.guest,self.controller_log,self.native['config']['image'],'3'*32)
        self.helper['commit_current_cold'](self.registry,self.out,MACHINE,TOKEN,self.archive,
            self.before,self.after,self.volume,self.receipt)

    def test_retained_run_fifo_is_typed_custody_without_content_open(self):
        fifo=self.run/'.native-retirement.pipe';os.mkfifo(fifo,0o644)
        original=fifo.lstat();real_open=os.open;real_fstat=os.fstat;substituted=set()
        def no_fifo_open(path,*args,**kwargs):
            if Path(path)==fifo:
                # Reproduce the old fstat refusal without ever opening the IPC.
                fd=real_open(os.devnull,*args,**kwargs);substituted.add(fd);return fd
            return real_open(path,*args,**kwargs)
        def fifo_stat(fd):return original if fd in substituted else real_fstat(fd)
        with patch.object(os,'open',no_fifo_open),patch.object(os,'fstat',fifo_stat):
            self.prepare_current()
            self.helper['verify_current_cold_receipt'](self.registry,self.out,MACHINE,TOKEN,self.receipt,self.before,self.after)
            raw,files,manifest=self.helper['read_current_cold_archive'](self.archive)
        self.assertFalse(substituted,'fixed capture must classify FIFO before any content open')
        self.assertEqual(fifo.lstat(),original)
        self.assertNotIn('run/.native-retirement.pipe',files)
        record=manifest['fifos']['run/.native-retirement.pipe']
        self.assertEqual(record['kind'],'fifo');self.assertTrue(record['metadata_only'])
        self.assertEqual(record['stat']['inode'],original.st_ino)
        with tarfile.open(self.archive) as archive:
            member=archive.getmember('run/.native-retirement.pipe')
            self.assertTrue(member.isfifo());self.assertEqual(member.size,0)
            self.assertEqual(json.loads(member.pax_headers['cloudbench.fifo-source-stat']),record['stat'])
        self.assertEqual(json.loads(self.receipt.read_bytes())['proof_credit'],0)

    def test_retained_run_fifo_metadata_drift_refuses_revalidation(self):
        fifo=self.run/'.native-retirement.pipe';os.mkfifo(fifo,0o644)
        self.prepare_current();fifo.chmod(0o600)
        with self.assertRaises(ValueError):
            self.helper['verify_current_cold_receipt'](self.registry,self.out,MACHINE,TOKEN,self.receipt,self.before,self.after)

    def test_fifo_custody_rejects_unexpected_path_type_or_hardlink(self):
        for fault in ('unexpected-path','regular-type','directory-type','hardlink','symlink'):
            with self.subTest(fault=fault):
                case=type(self)('test_retained_run_fifo_is_typed_custody_without_content_open');case.setUp()
                try:
                    fifo=case.run/'.native-retirement.pipe'
                    if fault=='regular-type':fifo.write_bytes(b'not FIFO')
                    elif fault=='directory-type':fifo.mkdir()
                    elif fault=='symlink':fifo.symlink_to(case.controller_log)
                    else:
                        os.mkfifo(fifo if fault=='hardlink' else case.run/'unexpected.pipe',0o644)
                        if fault=='hardlink':os.link(fifo,case.run/'second.pipe')
                    with self.assertRaises((ValueError,OSError)):case.prepare_current()
                finally:case.doCleanups()

    def test_fifo_archive_rejects_metadata_type_link_and_path_tamper(self):
        with self.assertRaises(ValueError):
            self.helper['current_fifo_records']({'run/.native-retirement.pipe':b''})
        fifo=self.run/'.native-retirement.pipe';os.mkfifo(fifo,0o644)
        self.prepare_current()
        for fault in ('mode','uid','gid','inode','type','regular-manifest','link','path'):
            with self.subTest(fault=fault):
                damaged=self.base/('fifo-'+fault+'.tar.gz')
                with tarfile.open(self.archive) as source,tarfile.open(damaged,'w:gz') as target:
                    for member in source:
                        data=source.extractfile(member).read() if member.isfile() else None
                        if fault=='regular-manifest' and member.name=='source-fifos.json':continue
                        if fault=='regular-manifest' and member.name=='capture-manifest.json':
                            value=json.loads(data);value.pop('fifos');value['files'].pop('source-fifos.json')
                            value['files']['run/.native-retirement.pipe']={'bytes':0,'sha256':hashlib.sha256(b'').hexdigest()}
                            data=json.dumps(value).encode();member.size=len(data)
                        if member.name=='run/.native-retirement.pipe':
                            if fault in ('mode','uid','gid'):setattr(member,fault,getattr(member,fault)+1)
                            if fault=='inode':
                                value=json.loads(member.pax_headers['cloudbench.fifo-source-stat']);value['inode']+=1
                                member.pax_headers['cloudbench.fifo-source-stat']=json.dumps(value)
                            if fault in ('type','regular-manifest'):member.type=tarfile.REGTYPE;data=b''
                            if fault=='link':member.type=tarfile.LNKTYPE;member.linkname='controller.log'
                            if fault=='path':member.name='run/other.pipe'
                        target.addfile(member,io.BytesIO(data) if data is not None else None)
                with self.assertRaises(ValueError):self.helper['read_current_cold_archive'](damaged)

    def test_fifo_source_owner_link_and_terminal_guards_are_not_waived(self):
        import types
        fifo=self.run/'.native-retirement.pipe';os.mkfifo(fifo,0o644)
        lstat=Path.lstat
        for field in ('st_uid','st_gid','st_nlink'):
            with self.subTest(field=field):
                def changed(path,*args,**kwargs):
                    value=lstat(path,*args,**kwargs)
                    if path==fifo:
                        attrs={key:getattr(value,key) for key in dir(value) if key.startswith('st_')}
                        attrs[field]+=1;return types.SimpleNamespace(**attrs)
                    return value
                with patch.object(Path,'lstat',changed),self.assertRaises(ValueError):
                    self.helper['current_cold_files'](self.registry,self.out,MACHINE,TOKEN,self.controller_log)
        batch=self.run/'_batch/run.json';value=json.loads(batch.read_bytes());value['status']='running';batch.write_text(json.dumps(value))
        with self.assertRaises(ValueError):self.prepare_current()

    def test_typed_fifo_survives_original_seal_and_destination_verification(self):
        os.mkfifo(self.run/'.native-retirement.pipe',0o644)
        self.test_current_phase_source_import_and_actual_claim_preserve_unknown_history()

    def test_current_phase_source_import_and_actual_claim_preserve_unknown_history(self):
        with self.assertRaises(OSError): self.capture()
        self.prepare_current()
        proof=json.loads(self.receipt.read_bytes())
        self.assertEqual(proof['historical_runtime'],'UNKNOWN');self.assertFalse(proof['runtime_evidence_complete'])
        self.assertTrue(proof['current_isolation_verified']);self.assertEqual(proof['proof_credit'],0)
        self.helper['export_cold_handoff'](self.source,self.registry,self.out,MACHINE,TOKEN,self.receipt,
            self.before,self.after,self.target,'2'*32,self.packet,source_endpoint=self.source_endpoint)
        self.helper['import_cold_handoff'](self.destination,self.target,self.packet,self.before,self.after)
        path=self.destination/'cloudbench-pool-reuse'/ (MACHINE+'.json')
        with patch.dict(os.environ,FLY_MACHINE_ID=self.target['machine']):
            self.helper['verify_imported_pool_proof'](path,self.destination,self.before,self.after,self.target['source_ref'],native_volume=json.loads(self.volume.read_bytes()))
        for name in ('runtime-evidence-unconfirmed','guest-cleanup-unconfirmed'):
            self.assertTrue((self.registry/name).exists())
        self.assertTrue((self.out/'runtime-evidence.pending').exists())
        for name in ('.cid','benchmark-child.finished','boot-config-unapplied'):
            self.assertFalse((self.out/name).exists())

    def test_current_phase_rejects_nonempty_or_linked_checkout_and_unknown_process(self):
        for fault in ('nonempty','symlink','unknown'):
            with self.subTest(fault=fault):
                case=type(self)('test_current_phase_source_import_and_actual_claim_preserve_unknown_history');case.setUp()
                try:
                    if fault=='nonempty':write(case.data/'repo/file','data')
                    if fault=='symlink':(case.data/'repo').symlink_to(case.base,target_is_directory=True)
                    observer=lambda:{'kind':'exact-inert-quiescence-v1','machine':MACHINE,'boot':'0'*36,'unknown':[],'inert_sleepers':[{'pid':1,'birth':'1'}],'idle_pinned_agents':[],'idle_platform_hallpass':[],'observed_epoch':1.0}
                    if fault=='unknown':observer=lambda:{'kind':'exact-inert-quiescence-v1','machine':MACHINE,'boot':'0'*36,'unknown':[{'pid':9}],'inert_sleepers':[{'pid':1,'birth':'1'}],'idle_pinned_agents':[],'idle_platform_hallpass':[],'observed_epoch':1.0}
                    with patch.dict(os.environ,FLY_MACHINE_ID=MACHINE), self.assertRaises(ValueError):
                        case.helper['capture_current_cold_guest'](case.data,TOKEN,case.guest,'original-instance','3'*32,observe=observer,dependencies=lambda: {'node':'b'*64,'python':'c'*64},mount=lambda data: {'device':42,'inode':10,'mount_device':'254:2'})
                    self.assertFalse(case.guest.exists())
                finally:case.doCleanups()

    def test_current_phase_native_drift_and_missing_custody_refuse(self):
        self.prepare_current()
        changed=copy.deepcopy(self.native);changed['instance_id']='foreign';write(self.after,json.dumps(changed))
        with self.assertRaises(ValueError):
            self.helper['export_cold_handoff'](self.source,self.registry,self.out,MACHINE,TOKEN,self.receipt,
                self.before,self.after,self.target,'2'*32,self.packet,source_endpoint=self.source_endpoint)
        self.assertFalse(self.packet.exists())
        write(self.after,json.dumps(self.native));self.archive.unlink()
        with self.assertRaises(OSError):
            self.helper['export_cold_handoff'](self.source,self.registry,self.out,MACHINE,TOKEN,self.receipt,
                self.before,self.after,self.target,'2'*32,self.packet,source_endpoint=self.source_endpoint)


    def test_current_phase_crash_replay_never_grants_dual_ownership(self):
        for stage in ('source-owner-held','source-native-held','source-sealed','destination-claimed','destination-ledger','destination-audit','destination-terminal'):
            with self.subTest(stage=stage):
                case=type(self)('test_current_phase_source_import_and_actual_claim_preserve_unknown_history');case.setUp()
                try:
                    case.prepare_current()
                    def fail(actual):
                        if actual==stage:raise RuntimeError('controlled durable interruption')
                    def export(checkpoint=lambda stage:None):
                        return case.helper['export_cold_handoff'](case.source,case.registry,case.out,MACHINE,TOKEN,case.receipt,
                            case.before,case.after,case.target,'2'*32,case.packet,checkpoint,source_endpoint=case.source_endpoint)
                    if stage.startswith('source'):
                        with self.assertRaises(RuntimeError):export(fail)
                        self.assertFalse(case.packet.exists());export()
                    else:
                        export()
                        with self.assertRaises(RuntimeError):
                            case.helper['import_cold_handoff'](case.destination,case.target,case.packet,case.before,case.after,fail)
                        self.assertTrue((case.destination/'cloudbench-pool-claims'/MACHINE).exists())
                    case.helper['import_cold_handoff'](case.destination,case.target,case.packet,case.before,case.after)
                    case.helper['import_cold_handoff'](case.destination,case.target,case.packet,case.before,case.after)
                    self.assertTrue((case.source/'cloudbench-cold-handoffs/outgoing'/MACHINE).exists())
                    self.assertFalse((case.destination/'cloudbench-pool-claims'/MACHINE).exists())
                    self.assertTrue((case.registry/'runtime-evidence-unconfirmed').exists())
                finally:case.doCleanups()

    def test_current_capture_rechecks_checkout_and_native_instance(self):
        calls=[]
        def observation():
            calls.append(1)
            if len(calls)==2:write(self.data/'repo/unrelated-new-file','changed')
            return {'kind':'exact-inert-quiescence-v1','machine':MACHINE,'boot':'0'*36,'unknown':[],
                'inert_sleepers':[{'pid':1,'birth':'1'}],'idle_pinned_agents':[],
                'idle_platform_hallpass':[],'observed_epoch':1.0}
        with patch.dict(os.environ,FLY_MACHINE_ID=MACHINE),self.assertRaisesRegex(ValueError,'checkout changed'):
            self.helper['capture_current_cold_guest'](self.data,TOKEN,self.guest,'original-instance','3'*32,
                observe=observation,dependencies=lambda:{'node':'b'*64,'python':'c'*64},
                mount=lambda data:{'device':42,'inode':10,'mount_device':'254:2'})
        self.assertFalse(self.guest.exists())
        (self.data/'repo/unrelated-new-file').unlink();(self.data/'repo').rmdir()
        self.prepare_current()
        self.archive.unlink()
        value=json.loads(self.guest.read_bytes());value['native_instance']='old-instance';write(self.guest,json.dumps(value))
        with self.assertRaisesRegex(ValueError,'another native instance'):
            self.helper['capture_current_cold'](self.registry,self.out,MACHINE,TOKEN,self.archive,self.before,self.after,
                self.volume,self.guest,self.controller_log,self.native['config']['image'],'3'*32)
        self.assertFalse(self.archive.exists())

    def test_current_source_refuses_claim_workers_or_new_originals(self):
        for fault in ('claim','worker','new-file','retain'):
            with self.subTest(fault=fault):
                case=type(self)('test_current_phase_source_import_and_actual_claim_preserve_unknown_history');case.setUp()
                try:
                    case.prepare_current()
                    if fault=='claim':write(case.source/'cloudbench-pool-claims'/MACHINE,'foreign')
                    if fault=='worker':write(case.out/'worker-clones.ids','c'*14+'\n')
                    if fault=='new-file':write(case.out/'new-original','changed')
                    if fault=='retain':write(case.registry/'meta',(case.registry/'meta').read_bytes().replace(b'cleanup_policy=reap',b'cleanup_policy=retain'))
                    with self.assertRaises(ValueError):
                        case.helper['export_cold_handoff'](case.source,case.registry,case.out,MACHINE,TOKEN,case.receipt,
                            case.before,case.after,case.target,'2'*32,case.packet,source_endpoint=case.source_endpoint)
                    self.assertFalse(case.packet.exists())
                finally:case.doCleanups()


    def test_current_export_validates_operational_lock_without_discarding_history(self):
        import fcntl
        self.prepare_current()
        def birth(pid):
            raw=Path('/proc',str(pid),'stat').read_text();parts=raw[raw.rfind(')')+2:].split()
            return 'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+parts[19]
        lock=self.registry/'recovery-lock'
        pairs(lock/'meta',dict(host=os.uname().nodename,pid=os.getpid(),pid_start=birth(os.getpid())))
        guard=self.registry.parent.parent/'cloudbench-fleet-recovery-locks'/OWNER
        guard.parent.mkdir();guard.touch(mode=0o600)
        with guard.open('r') as descriptor:
            fcntl.flock(descriptor,fcntl.LOCK_EX)
            with patch.dict(os.environ,CLOUDBENCH_RECOVERY_GUARD_FD=str(descriptor.fileno())):
                self.helper['export_cold_handoff'](self.source,self.registry,self.out,MACHINE,TOKEN,self.receipt,
                    self.before,self.after,self.target,'2'*32,self.packet,source_endpoint=self.source_endpoint)
                # A later source invocation has a new verified ancestor lock;
                # original source archive bytes never change.
                pairs(lock/'meta',dict(host=os.uname().nodename,pid=os.getppid(),pid_start=birth(os.getppid())))
                self.helper['export_cold_handoff'](self.source,self.registry,self.out,MACHINE,TOKEN,self.receipt,
                    self.before,self.after,self.target,'2'*32,self.packet,source_endpoint=self.source_endpoint)
                pairs(lock/'meta',dict(host='foreign',pid=os.getpid(),pid_start=birth(os.getpid())))
                with self.assertRaisesRegex(ValueError,'foreign current recovery lock'):
                    self.helper['verify_current_cold_receipt'](self.registry,self.out,MACHINE,TOKEN,self.receipt,self.before,self.after)


    def test_current_phase_preserves_authentic_absent_guest_latch_and_present_runtime_latch(self):
        (self.registry/'guest-cleanup-unconfirmed').unlink()
        self.prepare_current()
        phase=json.loads(self.receipt.read_bytes())
        self.assertEqual(phase['source_latches']['guest-cleanup-unconfirmed'],{'present':False})
        self.assertEqual(phase['source_latches']['runtime-evidence-unconfirmed']['present'],True)
        self.helper['export_cold_handoff'](self.source,self.registry,self.out,MACHINE,TOKEN,self.receipt,
            self.before,self.after,self.target,'2'*32,self.packet,source_endpoint=self.source_endpoint)
        self.helper['import_cold_handoff'](self.destination,self.target,self.packet,self.before,self.after)
        self.assertFalse((self.registry/'guest-cleanup-unconfirmed').exists())
        self.assertTrue((self.registry/'runtime-evidence-unconfirmed').exists())
        write(self.registry/'guest-cleanup-unconfirmed','manufactured')
        with self.assertRaises(ValueError):
            self.helper['verify_current_cold_receipt'](self.registry,self.out,MACHINE,TOKEN,self.receipt,self.before,self.after)


    def test_current_phase_verifies_original_collector_source_without_relabeling_guest(self):
        (self.registry/'guest-cleanup-unconfirmed').unlink()
        old_source=self.base/'original-guest-collector.py'
        old_source.write_bytes((ROOT/'cloudbench-startup-failure-archive.py').read_bytes())
        old_sha=digest(old_source.read_bytes());old=runpy.run_path(str(old_source))
        observer=lambda:{'kind':'exact-inert-quiescence-v1','machine':MACHINE,'boot':'0'*36,'unknown':[],
            'inert_sleepers':[{'pid':1,'birth':'1'}],'idle_pinned_agents':[],'idle_platform_hallpass':[],'observed_epoch':1.0}
        with patch.dict(os.environ,FLY_MACHINE_ID=MACHINE):
            old['capture_current_cold_guest'](self.data,TOKEN,self.guest,'original-instance','3'*32,
                observe=observer,dependencies=lambda:{'node':'b'*64,'python':'c'*64},
                mount=lambda data:{'device':42,'inode':10,'mount_device':'254:2'})
        args=(self.registry,self.out,MACHINE,TOKEN,self.archive,self.before,self.after,self.volume,
            self.guest,self.controller_log,self.native['config']['image'],'3'*32)
        with self.assertRaisesRegex(ValueError,'collector source binding'):
            self.helper['capture_current_cold'](*args,guest_collector_source=old_source,guest_collector_sha256='f'*64)
        self.assertFalse(self.archive.exists())
        self.helper['capture_current_cold'](*args,guest_collector_source=old_source,guest_collector_sha256=old_sha)
        self.helper['commit_current_cold'](self.registry,self.out,MACHINE,TOKEN,self.archive,self.before,self.after,self.volume,self.receipt)
        old_source.unlink()
        self.helper['export_cold_handoff'](self.source,self.registry,self.out,MACHINE,TOKEN,self.receipt,
            self.before,self.after,self.target,'2'*32,self.packet,source_endpoint=self.source_endpoint)
        self.helper['import_cold_handoff'](self.destination,self.target,self.packet,self.before,self.after)
        self.assertEqual(json.loads(self.guest.read_bytes())['collector_sha256'],old_sha)
        self.assertFalse((self.registry/'guest-cleanup-unconfirmed').exists())


    def test_current_phase_rejects_self_consistent_untrusted_collector_validator(self):
        source=(ROOT/'cloudbench-startup-failure-archive.py').read_text()
        start=source.index('def validate_current_cold_guest(')
        end=source.index('\ndef current_cold_mount(',start)
        malicious=(source[:start]+'def validate_current_cold_guest(*args, **kwargs):\n    pass\n\n'+source[end:]).encode()
        value={'collector_sha256':digest(malicious)}
        with self.assertRaisesRegex(ValueError,'collector.*semantics'):
            self.helper['validate_recorded_current_guest'](value,MACHINE,TOKEN,malicious,digest(malicious))


    def test_current_phase_latch_presence_is_boolean_not_integer(self):
        self.prepare_current()
        phase=json.loads(self.receipt.read_bytes())
        phase['source_latches']['guest-cleanup-unconfirmed']['present']=1
        write(self.receipt,json.dumps(phase))
        with self.assertRaisesRegex(ValueError,'presence must be boolean'):
            self.helper['verify_current_cold_receipt'](self.registry,self.out,MACHINE,TOKEN,self.receipt,self.before,self.after)


    def _outer_terminal_fixture(self):
        (self.registry/'guest-cleanup-unconfirmed').unlink()
        (self.run/'_batch/run.json').unlink();(self.out/'worker-clones.ids').unlink()
        write(self.run/'_batch/report-card.json',json.dumps({'status':'queued','per_task':[{'name':BENCH,'status':'queued'}]}))
        pairs(self.registry/'meta',{**self.helper['fields'](self.registry/'meta'),'pid':'17904'})
        pairs(self.audit/'expected-fresh'/CLONE,{'clone_name':CLONE,'source_machine_id':'c'*14})
        job_id='r001-j0046';campaign='campaign-original600';parent_birth='proc-start:00000000-0000-0000-0000-000000000000:111'
        self.controller_log=self.base/campaign/(job_id+'.log')
        write(self.controller_log,'monitor '+str(self.run)+'\nowner: '+OWNER+';\nexecution provenance: '+str(self.run/'execution-provenance.json')+'\n')
        jobs=[{'job_id':f'r001-j{i:04d}','task':'other','controller_pid':20000+i} for i in range(1,601)]
        jobs[45]=dict(job_id=job_id,task=BENCH,controller_pid=17904,log=str(self.controller_log),status='cancelled',controller_exit_code=137,
            startup_cohort='c001',attempts=[dict(attempt=1,controller_pid=17904,log=str(self.controller_log),status='cancelled',controller_exit_code=137,
            started_at='2026-10-15T16:32:01+00:00',finished_at='2026-10-15T16:51:39+00:00',run_id=None,fleet_owner_token=None,resources_released=False)])
        summary=dict(campaign_id=campaign,status='cancelled',total_jobs=600,task_count=200,runs=3,concurrency=600,peak_concurrency=600,
            e2e_started_at_epoch=1792081092.1816854,finished_at='2026-10-15T16:51:56+00:00',jobs=jobs)
        manifest=dict(cohort_id='c001',jobs={j['job_id']:j['controller_pid'] for j in jobs},e2e_deadline_monotonic=5334.5)
        threshold=dict(campaign_id=campaign,members=list(manifest['jobs']),source_ref='a'*40,parent_pid=16924,parent_birth=parent_birth,
            original_epoch=1792081092.1816854,e2e_deadline_monotonic=5334.5)
        term=dict(parent_pid=16924,parent_birth=parent_birth,signal='SIGTERM',child_or_group_signals=False,trigger_sha256='f'*64)
        result={}
        for key,value in [('summary',summary),('manifest',manifest),('threshold_parent',threshold),('parent_term',term)]:
            path=self.base/(key+'.json');write(path,json.dumps(value));result[key]={'path':str(path),'sha256':digest(path.read_bytes())}
        return result

    def test_outer_cancelled_job_preserves_absent_local_batch_and_worker_ledger(self):
        outer=self._outer_terminal_fixture()
        observation=lambda:{'kind':'exact-inert-quiescence-v1','machine':MACHINE,'boot':'0'*36,'unknown':[],
            'inert_sleepers':[{'pid':1,'birth':'1'}],'idle_pinned_agents':[],'idle_platform_hallpass':[],'observed_epoch':1.0}
        with patch.dict(os.environ,FLY_MACHINE_ID=MACHINE):
            self.helper['capture_current_cold_guest'](self.data,TOKEN,self.guest,'original-instance','3'*32,observe=observation,
                dependencies=lambda:{'node':'b'*64,'python':'c'*64},mount=lambda data:{'device':42,'inode':10,'mount_device':'254:2'})
        self.helper['capture_current_cold'](self.registry,self.out,MACHINE,TOKEN,self.archive,self.before,self.after,self.volume,self.guest,
            self.controller_log,self.native['config']['image'],'3'*32,outer_terminal=outer)
        self.helper['commit_current_cold'](self.registry,self.out,MACHINE,TOKEN,self.archive,self.before,self.after,self.volume,self.receipt)
        self.helper['export_cold_handoff'](self.source,self.registry,self.out,MACHINE,TOKEN,self.receipt,self.before,self.after,self.target,'2'*32,self.packet,source_endpoint=self.source_endpoint)
        self.helper['import_cold_handoff'](self.destination,self.target,self.packet,self.before,self.after)
        self.assertFalse((self.run/'_batch/run.json').exists());self.assertFalse((self.out/'worker-clones.ids').exists())
        self.assertEqual(json.loads((self.run/'_batch/report-card.json').read_bytes())['status'],'queued')
        raw,files,_=self.helper['read_current_cold_archive'](self.archive)
        self.assertEqual(json.loads(files['outer/summary.json'])['jobs'][45]['controller_exit_code'],137)
        self.assertEqual(json.loads(files['source-local-presence.json']),{'batch_run':False,'worker_ledger':False})


    def _capture_absent_runtime_latch(self):
        outer=self._outer_terminal_fixture()
        (self.registry/'runtime-evidence-unconfirmed').unlink()
        observation=lambda:{'kind':'exact-inert-quiescence-v1','machine':MACHINE,'boot':'0'*36,'unknown':[],
            'inert_sleepers':[{'pid':1,'birth':'1'}],'idle_pinned_agents':[],'idle_platform_hallpass':[],'observed_epoch':1.0}
        with patch.dict(os.environ,FLY_MACHINE_ID=MACHINE):
            self.helper['capture_current_cold_guest'](self.data,TOKEN,self.guest,'original-instance','3'*32,observe=observation,
                dependencies=lambda:{'node':'b'*64,'python':'c'*64},mount=lambda data:{'device':42,'inode':10,'mount_device':'254:2'})
        self.helper['capture_current_cold'](self.registry,self.out,MACHINE,TOKEN,self.archive,self.before,self.after,self.volume,self.guest,
            self.controller_log,self.native['config']['image'],'3'*32,outer_terminal=outer)
        self.helper['commit_current_cold'](self.registry,self.out,MACHINE,TOKEN,self.archive,self.before,self.after,self.volume,self.receipt)

    def test_absent_runtime_latch_round_trip_preserves_typed_absence(self):
        self._capture_absent_runtime_latch()
        phase=json.loads(self.receipt.read_bytes())
        self.assertEqual(phase['source_latches']['runtime-evidence-unconfirmed'],{'present':False})
        self.assertEqual(phase['historical_runtime'],'UNKNOWN');self.assertEqual(phase['proof_credit'],0)
        _,files,_=self.helper['read_current_cold_archive'](self.archive)
        self.assertNotIn('registry/runtime-evidence-unconfirmed',files)
        without_outer={name:raw for name,raw in files.items() if not name.startswith('outer/')}
        with self.assertRaisesRegex(ValueError,'absent runtime latch requires original outer'):
            self.helper['validate_current_cold_semantics'](without_outer,self.registry,self.out,MACHINE,TOKEN)
        self.helper['export_cold_handoff'](self.source,self.registry,self.out,MACHINE,TOKEN,self.receipt,
            self.before,self.after,self.target,'2'*32,self.packet,source_endpoint=self.source_endpoint)
        self.helper['import_cold_handoff'](self.destination,self.target,self.packet,self.before,self.after)
        self.assertFalse((self.registry/'runtime-evidence-unconfirmed').exists())

    def test_absent_runtime_latch_requires_outer_even_with_local_terminal(self):
        (self.registry/'runtime-evidence-unconfirmed').unlink()
        with self.assertRaisesRegex(ValueError,'absent runtime latch requires original outer'):
            self.helper['current_cold_files'](self.registry,self.out,MACHINE,TOKEN,self.controller_log)

    def test_absent_runtime_latch_reappearance_is_refused(self):
        self._capture_absent_runtime_latch()
        write(self.registry/'runtime-evidence-unconfirmed','new latch')
        with self.assertRaises(ValueError):
            self.helper['verify_current_cold_receipt'](self.registry,self.out,MACHINE,TOKEN,self.receipt,self.before,self.after)

    def test_present_runtime_latch_mutation_is_refused(self):
        self.prepare_current()
        write(self.registry/'runtime-evidence-unconfirmed','changed latch')
        with self.assertRaises(ValueError):
            self.helper['verify_current_cold_receipt'](self.registry,self.out,MACHINE,TOKEN,self.receipt,self.before,self.after)

    def test_outer_terminal_requires_exact_source_job_manifest_and_no_workers(self):
        for fault in ('job-pid','manifest-pid','source','log-owner','extra-worker','not-terminal'):
            with self.subTest(fault=fault):
                case=type(self)('test_outer_cancelled_job_preserves_absent_local_batch_and_worker_ledger');case.setUp()
                try:
                    outer=case._outer_terminal_fixture()
                    if fault in ('job-pid','not-terminal'):
                        path=Path(outer['summary']['path']);row=json.loads(path.read_bytes())
                        if fault=='job-pid':row['jobs'][45]['controller_pid']=9
                        else:row['status']='running'
                        write(path,json.dumps(row));outer['summary']['sha256']=digest(path.read_bytes())
                    if fault=='manifest-pid':
                        path=Path(outer['manifest']['path']);row=json.loads(path.read_bytes());row['jobs']['r001-j0046']=9
                        write(path,json.dumps(row));outer['manifest']['sha256']=digest(path.read_bytes())
                    if fault=='source':
                        path=Path(outer['threshold_parent']['path']);row=json.loads(path.read_bytes());row['source_ref']='f'*40
                        write(path,json.dumps(row));outer['threshold_parent']['sha256']=digest(path.read_bytes())
                    if fault=='log-owner':write(case.controller_log,case.controller_log.read_text().replace(OWNER,'f'*32))
                    if fault=='extra-worker':
                        pairs(case.audit/'fresh'/'other',dict(machine_id='c'*14,source_machine_id=MACHINE))
                    with self.assertRaises(ValueError):
                        case.helper['current_cold_files'](case.registry,case.out,MACHINE,TOKEN,case.controller_log,
                            outer_files=case.helper['read_outer_terminal'](outer))
                    self.assertFalse((case.run/'_batch/run.json').exists())
                    self.assertFalse((case.out/'worker-clones.ids').exists())
                finally:case.doCleanups()



class CurrentColdImportedNativeTests(unittest.TestCase):
    """Sealed source custody and fresh destination observations are separate inputs."""
    def fixture(self, legacy=False, local_target=False, configure_target=None):
        case=AllocatedCurrentColdTests('test_current_phase_source_import_and_actual_claim_preserve_unknown_history')
        case.setUp();self.addCleanup(case.doCleanups)
        verifier=case.helper
        if local_target:
            workspace=case.base/'destination-workspace';workspace.mkdir()
            case.target['workspace']=str(workspace)
        if legacy:
            # Exact approved 6189 capture source, not a rewritten sealed capsule.
            source=gzip.decompress((ROOT/'tests/fixtures/current-cold-capture-6189.py.gz').read_bytes())
            self.assertEqual(digest(source),'852abb705880ada9f5b6d931dd4285de3f49e2003e2ba5d479dab0e920d6b6c9')
            helper=case.base/'legacy/cloudbench-startup-failure-archive.py';write(helper,source)
            write(helper.with_name('cloudbench_execution_provenance.py'),(ROOT/'cloudbench_execution_provenance.py').read_bytes())
            case.helper=runpy.run_path(str(helper))
        if configure_target is not None:configure_target(case)
        case.prepare_current()
        case.helper['export_cold_handoff'](case.source,case.registry,case.out,MACHINE,TOKEN,case.receipt,
            case.before,case.after,case.target,'2'*32,case.packet,source_endpoint=case.source_endpoint)
        before=case.destination/'observations/child-before.json';after=case.destination/'observations/child-after.json'
        write(before,case.before.read_bytes());write(after,case.after.read_bytes())
        packet=json.loads(case.packet.read_bytes())
        self.assertNotIn(str(before),packet['originals']);self.assertNotIn(str(after),packet['originals'])
        return case,verifier,before,after,packet

    def test_current_capsule_import_uses_distinct_destination_native_paths(self):
        case,helper,before,after,packet=self.fixture()
        original=case.packet.read_bytes();events=[]
        helper['import_cold_handoff'](case.destination,case.target,case.packet,before,after,events.append)
        self.assertEqual(events,['destination-claimed','destination-ledger','destination-audit','destination-terminal'])
        self.assertEqual(case.packet.read_bytes(),original)
        self.assertEqual((case.destination/'cloudbench-pools'/case.target['pool_name']).read_text(),MACHINE+'\n')
        self.assertFalse((case.destination/'cloudbench-pool-claims'/MACHINE).exists())

    def test_6189_capsule_import_preserves_approved_original_helper(self):
        case,helper,before,after,packet=self.fixture(legacy=True)
        original=case.packet.read_bytes()
        helper['import_cold_handoff'](case.destination,case.target,case.packet,before,after)
        self.assertEqual(case.packet.read_bytes(),original)
        self.assertEqual(helper['sealed_original_reader'](packet['originals'])(case.receipt),case.receipt.read_bytes())
        with patch.dict(os.environ,FLY_MACHINE_ID=case.target['machine']):
            helper['verify_imported_pool_proof'](case.destination/'cloudbench-pool-reuse'/(MACHINE+'.json'),
                case.destination,before,after,case.target['source_ref'],native_volume=json.loads(case.volume.read_bytes()))

    def test_source_seal_missing_native_never_falls_back_to_local_file(self):
        case,helper,before,after,packet=self.fixture()
        del packet['originals'][str(case.before)]
        # The source file still exists locally; the seal must remain authoritative.
        self.assertTrue(case.before.exists())
        with self.assertRaises(KeyError) as error:
            helper['verify_imported_cold_handoff'](packet,case.target,before,after)
        self.assertEqual(error.exception.args,(str(case.before),))
        self.assertFalse((case.destination/'cloudbench-pool-claims').exists())

    def test_source_native_bytes_remain_bound_to_original_receipt(self):
        case,helper,before,after,packet=self.fixture()
        for path in (case.before,case.after):
            value=json.loads(base64.b64decode(packet['originals'][str(path)]['data']))
            value['unrecorded_native_field']='changed'
            raw=json.dumps(value).encode()
            packet['originals'][str(path)]={'bytes':len(raw),'sha256':digest(raw),'data':base64.b64encode(raw).decode()}
        with self.assertRaisesRegex(ValueError,'sealed current allocated config changed'):
            helper['verify_imported_cold_handoff'](packet,case.target,before,after)
        self.assertFalse((case.destination/'cloudbench-pool-claims').exists())

    def test_fresh_native_drift_refuses_before_any_destination_claim(self):
        case,helper,before,after,packet=self.fixture(legacy=True)
        for field in ('instance_id','config'):
            changed=copy.deepcopy(case.native)
            if field=='config':changed['config']['guest']['memory_mb']=8192
            else:changed[field]='different-instance'
            write(before,json.dumps(changed));write(after,json.dumps(changed))
            with self.subTest(field=field),self.assertRaises(ValueError):
                helper['import_cold_handoff'](case.destination,case.target,case.packet,before,after)
            self.assertFalse((case.destination/'cloudbench-pool-claims').exists())

    def test_fresh_hardlinked_observations_refuse_before_claim(self):
        case,helper,before,after,packet=self.fixture()
        after.unlink();os.link(before,after)
        with self.assertRaisesRegex(ValueError,'same file'):
            helper['import_cold_handoff'](case.destination,case.target,case.packet,before,after)
        self.assertFalse((case.destination/'cloudbench-pool-claims').exists())

    def test_unapproved_source_helper_still_refuses(self):
        case,helper,before,after,packet=self.fixture(legacy=True)
        # Repack a self-consistent archive with an unapproved helper, keeping the
        # packet hash references valid so rejection tests the source trust boundary.
        phase_path=str(case.receipt);archive_path=str(case.archive)
        _,files,manifest=helper['read_current_cold_archive'](case.archive)
        files['capture-helper.py']+=b'\n# unapproved source change\n'
        manifest['files']['capture-helper.py']={'bytes':len(files['capture-helper.py']),'sha256':digest(files['capture-helper.py'])}
        stream=io.BytesIO()
        with tarfile.open(fileobj=stream,mode='w:gz') as archive:
            for name,raw in {**files,'capture-manifest.json':json.dumps(manifest,sort_keys=True).encode()}.items():
                info=tarfile.TarInfo(name);info.size=len(raw);info.mode=0o600;archive.addfile(info,io.BytesIO(raw))
        raw=stream.getvalue();packet['originals'][archive_path]={'bytes':len(raw),'sha256':digest(raw),'data':base64.b64encode(raw).decode()}
        phase=json.loads(base64.b64decode(packet['originals'][phase_path]['data']));phase['archive_sha256']=digest(raw)
        raw=json.dumps(phase).encode();packet['originals'][phase_path]={'bytes':len(raw),'sha256':digest(raw),'data':base64.b64encode(raw).decode()};packet['phase_sha256']=digest(raw)
        with self.assertRaisesRegex(ValueError,'current phase custody binding differs'):
            helper['verify_imported_cold_handoff'](packet,case.target,before,after)
        self.assertFalse((case.destination/'cloudbench-pool-claims').exists())



class RetainedTargetSourceSuccessorTests(unittest.TestCase):
    """Exact old packet survives a separately verified target source successor."""
    fixture=CurrentColdImportedNativeTests.fixture

    def setup_successor(self):
        prepared={}
        def configure(case):
            native=dict(id=case.target['machine'],instance_id='controller-original',state='started',config=dict(
                init={'cmd':['bash','/tmp/gate.sh']},image='image@sha256:fixture',restart={'policy':'no'},
                auto_destroy=False,rootfs={'persist':'always','size_gb':50},mounts=[{'volume':case.target['volume'],'path':'/data'}]))
            record={'workspace_ownership_sha256':'', 'continuation':{'old_init_pid':791,'old_init_birth':'original-init','new_ref':'f'*40},
                    'root_anchors':{name:{'inode':Path(name).stat().st_ino} for name in (str(case.destination),case.target['workspace'])}}
            def document(name,value):
                path=case.base/name;write(path,json.dumps(value));return str(path)
            owner=document('controller-owner.json',dict(schema='cloudbench-controller-workspace-ownership-v1',volume_id=case.target['volume'],app=APP,mount_path='/data'))
            record['workspace_ownership_sha256']=digest(Path(owner).read_bytes())
            case.target['ownership_sha256']=record['workspace_ownership_sha256']
            case.target['controller_config_sha256']=digest(json.dumps(native['config'],sort_keys=True,separators=(',',':')).encode())
            retained={'record':document('controller-record.json',record),'original_native':document('controller-original.json',native)}
            retained['original_native_sha256']=digest(Path(retained['original_native']).read_bytes())
            prepared.update(native=native,record=record,owner=owner,retained=retained,document=document)
        case,helper,before,after,packet=self.fixture(legacy=True,local_target=True,configure_target=configure)
        endpoint=runpy.run_path(str(ROOT/'cloudbench-retained-controller-endpoint.py'))
        current=dict(case.target,source_ref='f'*40)
        native=prepared['native'];record=prepared['record'];document=prepared['document']
        request={'packet':str(case.packet),'packet_sha256':digest(case.packet.read_bytes()),'target':packet['target'],
                 'retained_controller':prepared['retained'],'controller_before':document('controller-before.json',native),
                 'controller_after':document('controller-after.json',native),'controller_volume':document('controller-volume.json',dict(id=current['volume'],attached_machine_id=current['machine'],state='created')),
                 'workspace_ownership':prepared['owner'],'target_source_successor':{'old_ref':case.target['source_ref'],'new_ref':current['source_ref'],'receipt_output':str(case.base/'successor.json')}}
        original_loader=runpy.run_path;original_run=subprocess.run;original_output=subprocess.check_output
        def load(path,*args,**kwargs):
            return endpoint if str(path).endswith('/cloudbench-retained-controller-endpoint.py') else original_loader(path,*args,**kwargs)
        def canonical(workspace,ref,observed,evidence):
            self.assertEqual(ref,current['source_ref'])
            if observed!=native or json.loads(Path(evidence['record']).read_bytes())!=record:
                raise ValueError('canonical retained continuation changed')
            if case.destination.stat().st_ino!=record['root_anchors'][str(case.destination)]['inode']:
                raise ValueError('canonical physical root changed')
            return record
        def output(cmd,*args,**kwargs):
            if cmd[0]=='git':
                if 'diff' in cmd:return ''
                return str(case.destination)+'\n' if '--git-common-dir' in cmd else current['source_ref']+'\n'
            return original_output(cmd,*args,**kwargs)
        def run(cmd,*args,**kwargs):
            if cmd[0]=='git' and 'merge-base' in cmd:
                self.assertEqual(cmd[-2:],[case.target['source_ref'],current['source_ref']]);return subprocess.CompletedProcess(cmd,0)
            return original_run(cmd,*args,**kwargs)
        from contextlib import ExitStack
        stack=ExitStack();self.addCleanup(stack.close)
        stack.enter_context(patch.dict(os.environ,FLY_APP_NAME=APP,FLY_MACHINE_ID=current['machine']))
        stack.enter_context(patch.dict(endpoint['capture_retained_target'].__globals__,verify_retained_endpoint=canonical))
        stack.enter_context(patch('runpy.run_path',side_effect=load));stack.enter_context(patch('subprocess.check_output',side_effect=output));stack.enter_context(patch('subprocess.run',side_effect=run))
        descriptor=endpoint['create_target_source_successor'](request,current)
        return case,helper,before,after,packet,current,request,descriptor,endpoint

    def test_old_packet_new_ref_import_and_pool_reuse_keep_packet_immutable(self):
        case,helper,before,after,packet,current,request,proof,endpoint=self.setup_successor()
        raw=case.packet.read_bytes()
        helper['import_cold_handoff'](case.destination,current,case.packet,before,after,target_source_successor=proof)
        imported=case.destination/'cloudbench-pool-reuse'/(MACHINE+'.json')
        with patch.dict(endpoint['capture_retained_target'].__globals__,verify_retained_endpoint=lambda *a: (_ for _ in ()).throw(ValueError('old driver exited'))):
            helper['verify_imported_pool_proof'](imported,case.destination,before,after,current['source_ref'],native_volume=json.loads(case.volume.read_bytes()))
        self.assertEqual(case.packet.read_bytes(),raw)
        row=json.loads(imported.read_bytes())['imported_cold']
        self.assertEqual(row['target'],packet['target']);self.assertEqual(row['target_source_successor'],proof)
        with self.assertRaises(ValueError):
            helper['verify_imported_pool_proof'](imported,case.destination,before,after,'1'*40,native_volume=json.loads(case.volume.read_bytes()))

    def test_retained_request_gateway_requires_explicit_successor(self):
        case,helper,before,after,packet,current,request,proof,endpoint=self.setup_successor()
        request.update(operation='import',endpoint=current,tool_ref=current['source_ref'],pool_name=current['pool_name'],
                       native_before=str(before),native_after=str(after),native_volume=str(case.volume),machine=MACHINE,volume=VOLUME)
        path=case.base/'import-request.json'
        authorization=request.pop('target_source_successor')
        write(path,json.dumps(request));path.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'target/packet differs'):
            endpoint['cold_handoff_request'](path,digest(path.read_bytes()),current['workspace'],case.destination)
        self.assertFalse((case.destination/'cloudbench-pool-claims').exists())
        request['target_source_successor']=authorization
        write(path,json.dumps(request));path.chmod(0o600)
        endpoint['cold_handoff_request'](path,digest(path.read_bytes()),current['workspace'],case.destination)
        proof_path=case.destination/'cloudbench-pool-reuse'/(MACHINE+'.json')
        helper['verify_imported_pool_proof'](proof_path,case.destination,before,after,current['source_ref'],native_volume=json.loads(case.volume.read_bytes()))

    def test_successor_wrong_hash_target_config_continuation_or_root_refuses_before_claim(self):
        for fault in ('hash','target','config','continuation','root'):
            with self.subTest(fault=fault):
                case,helper,before,after,packet,current,request,proof,endpoint=self.setup_successor()
                if fault=='hash':proof=dict(proof,sha256='0'*64)
                if fault=='target':current=dict(current,machine='9'*14)
                if fault in ('config','continuation'):
                    value=json.loads(Path(proof['path']).read_bytes())
                    if fault=='continuation':value['continuation']=dict(value['continuation'],old_init_pid=99)
                    else:
                        item=value['inputs']['controller_before'];native=json.loads(Path(item['path']).read_bytes());native['config']['init']['cmd']=['sleep','infinity'];write(Path(item['path']),json.dumps(native));item['sha256']=digest(Path(item['path']).read_bytes())
                    write(Path(proof['path']),json.dumps(value));proof=dict(proof,sha256=digest(Path(proof['path']).read_bytes()))
                if fault=='root':case.destination.rename(case.base/'old-root');case.destination.mkdir()
                with self.assertRaises(ValueError):
                    helper['import_cold_handoff'](case.destination,current,case.packet,before,after,target_source_successor=proof)
                self.assertFalse((case.destination/'cloudbench-pool-claims').exists())

    def test_completion_required_after_terminal_and_cannot_use_prepared_proof(self):
        case,helper,before,after,packet,current,request,proof,endpoint=self.setup_successor()
        def stop(stage):
            if stage=='destination-audit':raise RuntimeError('interrupted before terminal')
        with self.assertRaises(RuntimeError):
            helper['import_cold_handoff'](case.destination,current,case.packet,before,after,stop,target_source_successor=proof)
        completion=case.destination/'cloudbench-cold-handoffs/successors'/(MACHINE+'.json')
        self.assertFalse(completion.exists())
        with self.assertRaises(FileNotFoundError):
            helper['verify_imported_pool_proof'](case.destination/'cloudbench-pool-reuse'/(MACHINE+'.json'),case.destination,before,after,current['source_ref'],native_volume=json.loads(case.volume.read_bytes()))
        helper['import_cold_handoff'](case.destination,current,case.packet,before,after,target_source_successor=proof)
        self.assertTrue(completion.exists())

    def test_completion_rejects_missing_tampered_replaced_linked_or_foreign_authority(self):
        for fault in ('missing','content','terminal-inode','audit-content','linked-proof','common','source'):
            with self.subTest(fault=fault):
                case,helper,before,after,packet,current,request,proof,endpoint=self.setup_successor()
                helper['import_cold_handoff'](case.destination,current,case.packet,before,after,target_source_successor=proof)
                completion=case.destination/'cloudbench-cold-handoffs/successors'/(MACHINE+'.json')
                root=case.destination;expected=current['source_ref']
                if fault=='missing':completion.unlink()
                if fault=='content':
                    value=json.loads(completion.read_bytes());value['continuation']['old_init_pid']=99;write(completion,json.dumps(value))
                if fault=='terminal-inode':
                    path=case.destination/'cloudbench-cold-handoffs/imported'/(MACHINE+'.json');saved=path.read_bytes();path.rename(path.with_suffix('.old'));write(path,saved);path.chmod(0o600)
                if fault=='audit-content':
                    path=case.destination/'cloudbench-cold-handoffs/audit'/(MACHINE+'.json');write(path,'{}')
                if fault=='linked-proof':os.link(proof['path'],case.base/'proof-alias')
                if fault=='common':root=case.base/'foreign';root.mkdir()
                if fault=='source':expected='1'*40
                with self.assertRaises((ValueError,FileNotFoundError)):
                    helper['verify_imported_pool_proof'](case.destination/'cloudbench-pool-reuse'/(MACHINE+'.json'),root,before,after,expected,native_volume=json.loads(case.volume.read_bytes()))

    def test_completion_recovery_after_terminal_is_exact_and_idempotent(self):
        case,helper,before,after,packet,current,request,proof,endpoint=self.setup_successor()
        def stop(stage):
            if stage=='destination-terminal':raise RuntimeError('interrupted after terminal')
        with self.assertRaises(RuntimeError):
            helper['import_cold_handoff'](case.destination,current,case.packet,before,after,stop,target_source_successor=proof)
        completion=case.destination/'cloudbench-cold-handoffs/successors'/(MACHINE+'.json')
        self.assertFalse(completion.exists())
        helper['import_cold_handoff'](case.destination,current,case.packet,before,after,target_source_successor=proof)
        raw=completion.read_bytes();inode=completion.stat().st_ino
        helper['import_cold_handoff'](case.destination,current,case.packet,before,after,target_source_successor=proof)
        self.assertEqual(completion.read_bytes(),raw);self.assertEqual(completion.stat().st_ino,inode)


class CrossControllerColdHandoffTests(PreconfigStartupArchiveFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        # The archive cases run once on PreconfigStartupArchiveTests with the original,
        # unconsumed fixture; only handoff tests consume its latches before asserting.
        self.source = self.base / 'source-common'; self.source.mkdir()
        self.destination = self.base / 'destination-common'; self.destination.mkdir()
        import runpy
        contract=runpy.run_path(str(REPO/'scripts/cloudbench_execution_provenance.py'))
        matrix=contract['build_task_matrix']([BENCH+'=real'])
        config=contract['build_config'](contract['CONFIG_SCHEMA_VERSION'],['task_count=1','task_matrix_sha256='+matrix['sha256'],'node_dependency_fingerprint='+'b'*64,'python_dependency_fingerprint='+'c'*64])
        provenance=dict(schema_version=contract['EXECUTION_SCHEMA_VERSION'],base_sha='a'*40,workspace_patch_sha256='none',controller_snapshot=dict(schema_version=contract['SNAPSHOT_SCHEMA_VERSION'],sha256='d'*64),config=config)
        write(self.run/'execution-provenance.json',json.dumps(provenance))
        write(self.run/'execution-task-matrix.json',json.dumps(matrix))
        write(self.run/'_batch/run.json',json.dumps(dict(run_id=RUN,status='failed',controller_exit_code=1,execution_provenance=provenance)))
        write(self.registry/'meta',(self.registry/'meta').read_bytes()+b'pid_start=proc-start:00000000-0000-0000-0000-000000000000:123\n')
        self.native['state'] = 'stopped'
        self.native['config']['guest'] = {'cpu_kind': 'shared', 'cpus': 2, 'memory_mb': 4096}
        write(self.before, json.dumps(self.native)); write(self.after, json.dumps(self.native))
        self.capture()
        self.receipt = self.out / 'failed-preconfig-runtime-archive/consumed.json'
        self.receipt.parent.mkdir()
        self.helper['commit_preconfig'](self.registry,self.out,MACHINE,TOKEN,self.archive,self.before,self.after,self.receipt)
        (self.out/'runtime-evidence.pending').unlink()
        (self.registry/'runtime-evidence-unconfirmed').unlink()
        self.target = dict(machine='d'*14, volume='vol_destination', workspace='/retained/destination', common=str(self.destination),
                           source_ref='e'*40, ownership_sha256='f'*64, controller_config_sha256='1'*64,
                           preservation='rootfs-always', pool_name='destination.cold.ids')
        self.source_endpoint = dict(self.target,machine='4'*14,common=str(self.source),volume='vol_source')
        self.nonce = '2'*32
        self.packet = self.base / 'handoff.json'

    def test_two_real_common_stores_require_committed_source_hold_before_admission(self):
        original=(self.registry/'meta').read_bytes()
        self.helper['export_cold_handoff'](self.source,self.registry,self.out,MACHINE,TOKEN,self.receipt,
             self.before,self.after,self.target,self.nonce,self.packet,source_endpoint=self.source_endpoint)
        hold=self.source/'cloudbench-cold-handoffs/outgoing'/MACHINE
        self.assertTrue(hold.exists())
        self.assertEqual((self.registry/'meta').read_bytes(),original.replace(b'cleanup_policy=reap\n',b'cleanup_policy=retain\n'))
        self.helper['import_cold_handoff'](self.destination,self.target,self.packet,self.before,self.after)
        self.assertEqual((self.destination/'cloudbench-pools/destination.cold.ids').read_text(),MACHINE+'\n')
        self.assertTrue(hold.exists(), 'source exclusion is permanent after destination admission')
        self.assertFalse((self.destination/'cloudbench-pool-claims'/MACHINE).exists())
        # Exact replay is idempotent and cannot enroll a second destination.
        self.helper['import_cold_handoff'](self.destination,self.target,self.packet,self.before,self.after)
        foreign=dict(self.target,machine='3'*14)
        with self.assertRaises(ValueError):
            self.helper['import_cold_handoff'](self.destination,foreign,self.packet,self.before,self.after)

    def export(self, checkpoint=lambda stage: None):
        return self.helper['export_cold_handoff'](self.source,self.registry,self.out,MACHINE,TOKEN,self.receipt,
            self.before,self.after,self.target,self.nonce,self.packet,checkpoint,source_endpoint=self.source_endpoint)

    def test_six_source_destination_crash_boundaries_resume_without_dual_availability(self):
        for stage in ('source-owner-held','source-native-held','source-sealed','destination-claimed','destination-ledger','destination-terminal'):
            with self.subTest(stage=stage):
                # Each case uses its own actual source/destination common roots.
                case=type(self)('test_two_real_common_stores_require_committed_source_hold_before_admission');case.setUp()
                try:
                    def fail(actual):
                        if actual==stage: raise RuntimeError('controlled durable boundary interruption')
                    if stage.startswith('source'):
                        with self.assertRaises(RuntimeError):case.export(fail)
                        self.assertTrue((case.registry/'cold-handoff-outgoing').exists())
                        self.assertFalse(case.packet.exists())
                        case.export()
                    else:
                        case.export()
                        with self.assertRaises(RuntimeError):case.helper['import_cold_handoff'](case.destination,case.target,case.packet,case.before,case.after,fail)
                        self.assertTrue((case.destination/'cloudbench-pool-claims'/MACHINE).exists())
                    case.helper['import_cold_handoff'](case.destination,case.target,case.packet,case.before,case.after)
                    self.assertEqual((case.destination/'cloudbench-pools/destination.cold.ids').read_text(),MACHINE+'\n')
                    self.assertTrue((case.source/'cloudbench-cold-handoffs/outgoing'/MACHINE).exists())
                    self.assertFalse((case.destination/'cloudbench-pool-claims'/MACHINE).exists())
                finally:case.doCleanups()

    def test_source_negatives_preserve_originals_and_never_publish_packet(self):
        for fault in ('retain','accepted','worker','source-pool','phase','native-version','native-volume','native-running','different-target'):
            with self.subTest(fault=fault):
                case=type(self)('test_two_real_common_stores_require_committed_source_hold_before_admission');case.setUp()
                try:
                    original=(case.registry/'meta').read_bytes()
                    if fault=='retain':write(case.registry/'meta',original.replace(b'cleanup_policy=reap',b'cleanup_policy=retain'))
                    if fault=='accepted':write(case.out/'post-config-start.accepted','admitted')
                    if fault=='worker':write(case.out/'worker-clones.ids','c'*14+'\n')
                    if fault=='source-pool':write(case.source/'cloudbench-pools/old.ids',MACHINE+'\n')
                    if fault=='phase':write(case.receipt,'{}')
                    if fault.startswith('native-'):
                        changed=copy.deepcopy(case.native)
                        if fault=='native-version':changed['instance_id']='foreign'
                        if fault=='native-volume':changed['config']['mounts'][0]['volume']='vol_foreign'
                        if fault=='native-running':changed['state']='started'
                        write(case.after,json.dumps(changed))
                    if fault=='different-target':
                        case.export();case.target=dict(case.target,machine='5'*14)
                    with self.assertRaises((ValueError,KeyError)):case.export()
                    if fault!='different-target':self.assertFalse(case.packet.exists())
                    self.assertTrue((case.registry/'clones'/CLONE).exists())
                finally:case.doCleanups()

    def test_import_rejects_foreign_paths_tamper_or_native_drift_without_ledger(self):
        self.export()
        original=self.packet.read_bytes()
        for fault in ('phase-byte','missing-path','receipt-rewrite','native-instance','foreign-destination'):
            with self.subTest(fault=fault):
                packet=json.loads(original);target=dict(self.target)
                if fault=='phase-byte':next(iter(packet['originals'].values()))['sha256']='0'*64
                if fault=='missing-path':packet['originals'].pop(packet['receipt'])
                if fault=='receipt-rewrite':packet['receipt']='/foreign/consumed.json'
                if fault=='native-instance':
                    changed=copy.deepcopy(self.native);changed['instance_id']='foreign';write(self.after,json.dumps(changed))
                if fault=='foreign-destination':target['volume']='vol_foreign'
                write(self.packet,json.dumps(packet))
                with self.assertRaises((ValueError,KeyError)):
                    self.helper['import_cold_handoff'](self.destination,target,self.packet,self.before,self.after)
                self.assertFalse((self.destination/'cloudbench-pools/destination.cold.ids').exists())
                write(self.after,json.dumps(self.native))
        write(self.packet,original)
        # Source receipt/archive paths may disappear on this destination; the
        # sealed exact path resolver must not attempt a mutable local fallback.
        self.archive.unlink();self.receipt.unlink()
        self.helper['import_cold_handoff'](self.destination,self.target,self.packet,self.before,self.after)
        self.assertEqual((self.destination/'cloudbench-pools/destination.cold.ids').read_text(),MACHINE+'\n')

    def test_ledger_locked_crash_reclaims_only_same_host_dead_birth(self):
        lock = self.destination / 'pool.ids.lock'
        code = """import os,runpy,sys
from pathlib import Path
helper=runpy.run_path(sys.argv[1])
with helper['cold_handoff_ledger_lock'](Path(sys.argv[2])):
 print('LOCKED',flush=True)
 sys.stdin.buffer.read(1)
"""
        child = subprocess.Popen([sys.executable,'-c',code,str(REPO/'scripts/cloudbench-startup-failure-archive.py'),str(lock)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(),'LOCKED')
            live=(lock/'meta').read_bytes()
            with self.assertRaisesRegex(ValueError,'live pool ledger lock'):
                with self.helper['cold_handoff_ledger_lock'](lock):pass
            self.assertEqual((lock/'meta').read_bytes(),live)
            child.kill();child.wait(timeout=5)
            with self.helper['cold_handoff_ledger_lock'](lock):
                self.assertIn(('pid='+str(os.getpid())+'\n').encode(),(lock/'meta').read_bytes())
            self.assertFalse(lock.exists())
            lock.mkdir();write(lock/'meta',live.replace(('host='+os.uname().nodename).encode(),b'host=foreign-host'))
            with self.assertRaisesRegex(ValueError,'foreign or malformed'):
                with self.helper['cold_handoff_ledger_lock'](lock):pass
            self.assertTrue(lock.exists())
            (lock/'meta').unlink()
            with self.assertRaises(FileNotFoundError):
                with self.helper['cold_handoff_ledger_lock'](lock):pass
            self.assertTrue(lock.exists(), 'missing owner is UNKNOWN, never blindly reclaimed')
        finally:
            if child.poll() is None:child.kill();child.wait(timeout=5)
            child.stdin.close();child.stdout.close()

    def test_new_directory_chain_is_fsynced_before_packet_publish(self):
        root=self.destination/'new'/'sealed'/'packets'
        expected=[str(self.destination),str(self.destination/'new'),str(self.destination/'new'/'sealed'),str(root)]
        observed=[];real_fsync=os.fsync
        def record(fd):
            observed.append(os.readlink('/proc/self/fd/'+str(fd)))
            return real_fsync(fd)
        with patch('os.fsync',side_effect=record):
            self.helper['durable_handoff_json'](root/'receipt.json',{'state':'committed'})
        directories=[path for path in observed if path in expected]
        self.assertEqual(directories[:3],expected[:3])
        self.assertTrue(all(path in directories for path in expected))
        self.assertLess(observed.index(str(self.destination/'new'/'sealed')),observed.index(str(root/'receipt.json')))
        self.assertEqual(stat.S_IMODE(root.stat().st_mode),0o700)
        observed.clear()
        with patch('os.fsync',side_effect=record):
            self.helper['durable_handoff_json'](root/'receipt.json',{'state':'committed'})
        self.assertEqual(observed[-2:],[str(root/'receipt.json'),str(root)])
        self.assertTrue(all(str(path) in observed for path in root.parents))

    def test_retain_temporary_and_unflushed_directory_retry_are_exact(self):
        original=(self.registry/'meta').read_bytes()
        with patch('os.replace',side_effect=RuntimeError('after retained temp fsync, before rename')):
            with self.assertRaises(RuntimeError):self.export()
        temporary=self.registry/('.handoff-retain-'+self.nonce)
        retained=temporary.read_bytes()
        self.assertEqual((self.registry/'meta').read_bytes(),original)
        temporary.write_bytes(b'foreign policy bytes')
        with self.assertRaisesRegex(ValueError,'conflicting retained-policy'):self.export()
        self.assertEqual((self.registry/'meta').read_bytes(),original)
        temporary.write_bytes(retained)
        self.export()
        self.assertFalse(temporary.exists())
        self.assertEqual((self.registry/'meta').read_bytes(),retained)
        directory=self.destination/'unflushed'/'ancestor'
        with patch('os.fsync',side_effect=RuntimeError('after mkdir, before parent flush')):
            with self.assertRaises(RuntimeError):self.helper['handoff_directory'](directory)
        self.assertTrue((self.destination/'unflushed').exists())
        observed=[];real=os.fsync
        def record(fd):observed.append(os.readlink('/proc/self/fd/'+str(fd)));return real(fd)
        with patch('os.fsync',side_effect=record):self.helper['handoff_directory'](directory)
        self.assertIn(str(self.destination),observed,'retry must fsync the already-existing unflushed ancestor entry')
        self.assertIn(str(directory.parent),observed)

    def test_endpoint_custody_requires_rootfs_always_or_real_retained_mount(self):
        mount=self.base/'mount';mount.mkdir()
        endpoint=copy.deepcopy(self.native)
        endpoint.update(id=self.target['machine'],state='started')
        endpoint['config']['init']={'exec':['/bin/sleep','180']}
        endpoint['config']['rootfs']={'persist':'always','size_gb':50}
        endpoint['config']['mounts']=[{'path':str(mount),'volume':self.target['volume']}]
        write(self.before,json.dumps(endpoint));write(self.after,json.dumps(endpoint))
        owner=self.base/'workspace-owner.json'
        write(owner,json.dumps(dict(schema='cloudbench-controller-workspace-ownership-v1',app=APP,volume_id=self.target['volume'],mount_path=str(mount))))
        with patch.dict(os.environ,FLY_MACHINE_ID=self.target['machine'],FLY_APP_NAME=APP), patch('subprocess.check_output',side_effect=[str(self.destination)+'\n',self.target['source_ref']+'\n']):
            result=self.helper['capture_cold_handoff_target'](self.destination,self.destination,self.before,self.after,owner,self.target['source_ref'],self.target['pool_name'])
        self.assertEqual(result['preservation'],'rootfs-always')
        endpoint['config']['rootfs']={'persist':'never','size_gb':50}
        write(self.before,json.dumps(endpoint));write(self.after,json.dumps(endpoint))
        with patch.dict(os.environ,FLY_MACHINE_ID=self.target['machine'],FLY_APP_NAME=APP):
            with self.assertRaisesRegex(ValueError,'no proven durable custody'):
                self.helper['capture_cold_handoff_target'](self.destination,self.destination,self.before,self.after,owner,self.target['source_ref'],self.target['pool_name'])

    def test_request_reader_is_bounded_private_regular_and_exact_sha(self):
        request=self.base/'request.json'
        raw=b'{"operation":"target"}'
        write(request,raw);request.chmod(0o600)
        self.assertEqual(self.helper['read_cold_handoff_request'](request,hashlib.sha256(raw).hexdigest()),{'operation':'target'})
        with self.assertRaisesRegex(ValueError,'exact approved bytes'):
            self.helper['read_cold_handoff_request'](request,'0'*64)
        request.chmod(0o644)
        with self.assertRaisesRegex(ValueError,'not private'):
            self.helper['read_cold_handoff_request'](request,hashlib.sha256(raw).hexdigest())
        request.chmod(0o600)
        with request.open('r+b') as stream:stream.truncate(1048577)
        with self.assertRaisesRegex(ValueError,'unsafe original evidence file'):
            self.helper['read_cold_handoff_request'](request,'0'*64)
        request.unlink();os.mkfifo(request,0o600)
        with self.assertRaisesRegex(ValueError,'unsafe original evidence file'):
            self.helper['read_cold_handoff_request'](request,'0'*64)

    def test_real_fleet_handoff_parser_refuses_missing_operands_without_loop(self):
        source=Path(os.environ.get('CLOUDBENCH_FLEET_SCRIPT_UNDER_TEST',str(REPO/'scripts/run-bench-fleet'))).read_text()
        start=source.index('        --cold-handoff-request)')
        branch=source[start:source.index(';;',start)+2]
        script='set -uo pipefail\nwhile [ "$#" -gt 0 ]; do\ncase "$1" in\n'+branch+'\n*) exit 99 ;;\nesac\ndone\n'
        for operands,expected in (([],2),(['request'],2),(['request','a'*64],0)):
            with self.subTest(operands=len(operands)):
                result=subprocess.run(['bash','-c',script,'actual-fleet-parser','--cold-handoff-request',*operands],capture_output=True,text=True,timeout=1)
                self.assertEqual(result.returncode,expected,result.stderr)

    def test_older_cleanup_policy_consumer_keeps_source_retained(self):
        self.export()
        # Exact consumer from 9b2447b4deb33c3f15aa3d83d674eecf8c387146,
        # before handoff awareness. Keep its bytes for shallow checkouts.
        old_source = r'''fleet_registry_cleanup_state() {  # <registry-dir> <cleanup-policy>
    local registry="${1%/}" policy="$2" guest_cleanup_unconfirmed=0
    if [ -e "$registry/guest-cleanup-unconfirmed" ] \
        || [ -L "$registry/guest-cleanup-unconfirmed" ] \
        || [ -e "$registry/runtime-evidence-unconfirmed" ] \
        || [ -L "$registry/runtime-evidence-unconfirmed" ]; then
        guest_cleanup_unconfirmed=1
    fi
    case "$policy:$guest_cleanup_unconfirmed" in
        reap:0) printf 'reap\n' ;;
        retain:0) printf 'retain\n' ;;
        reap:1|retain:1) printf 'quarantined\n' ;;
        *) printf 'unsafe\n' ;;
    esac
}
'''
        self.assertEqual(hashlib.sha256(old_source.encode()).hexdigest(),
                         'f3e48015335510aef80e0e53602a93bf2cf9e6708cea63ebff620415cce7f029')
        start=old_source.index('fleet_registry_cleanup_state() {')
        end=old_source.index('\n}\n',start)+3
        function=old_source[start:end]
        # The older consumer already understands the durable RETAIN policy.
        script='set -uo pipefail\nregistry_meta_value() { sed -n "s/^$2=//p" "$1/meta" | head -1; }\n'+function+'\nfleet_registry_cleanup_state "$1" retain\n'
        result=subprocess.run(['bash','-c',script,'guard',str(self.registry)],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip(),'retain')
        self.assertEqual(self.helper['fields'](self.registry/'meta')['cleanup_policy'],'retain')
        # A handoff-aware consumer must preserve its stronger quarantine guard.
        current_source=git_blob('scripts/run-bench-fleet').decode()
        start=current_source.index('fleet_registry_cleanup_state() {')
        end=current_source.index('\n}\n',start)+3
        script='set -uo pipefail\n'+current_source[start:end]+'\nfleet_registry_cleanup_state "$1" retain\n'
        result=subprocess.run(['bash','-c',script,'guard',str(self.registry)],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip(),'quarantined')
        self.export()

    def test_actual_destination_pool_proof_rechecks_imported_originals_and_target(self):
        self.export()
        self.helper['import_cold_handoff'](self.destination,self.target,self.packet,self.before,self.after)
        proof=self.destination/'cloudbench-pool-reuse'/ (MACHINE+'.json')
        with patch.dict(os.environ,{'FLY_MACHINE_ID':self.target['machine']}):
            self.helper['verify_imported_pool_proof'](proof,self.destination,self.before,self.after,self.target['source_ref'],native_volume=dict(id=VOLUME,attached_machine_id=MACHINE,state='created'))
            with self.assertRaises(ValueError):
                self.helper['verify_imported_pool_proof'](proof,self.destination,self.before,self.after,'0'*40,native_volume=dict(id=VOLUME,attached_machine_id=MACHINE,state='created'))
        with patch.dict(os.environ,{'FLY_MACHINE_ID':'0'*14}):
            with self.assertRaises(ValueError):
                self.helper['verify_imported_pool_proof'](proof,self.destination,self.before,self.after,self.target['source_ref'],native_volume=dict(id=VOLUME,attached_machine_id=MACHINE,state='created'))
        self.assertTrue((self.source/'cloudbench-cold-handoffs/outgoing'/MACHINE).exists())

    def test_imported_primary_enters_real_claim_fsm_with_fresh_native_recheck(self):
        import ast, re
        self.export()
        def interrupt(stage):
            if stage=='destination-ledger':raise RuntimeError('ledger visible while exact migration claim is still held')
        with self.assertRaises(RuntimeError):
            self.helper['import_cold_handoff'](self.destination,self.target,self.packet,self.before,self.after,interrupt)
        source=(REPO/'scripts/run-bench-fleet').read_text()+'\n'+(REPO/'scripts/lib/cloudbench-inventory.sh').read_text()
        # Reuse the existing heredoc-aware extractor from the registered fleet
        # test family without importing its unrelated environment fixtures.
        tree=ast.parse((REPO/'agents/benchmarks/cloudbench_dependency_sync_test.py').read_text())
        extractor=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='_extract_fleet_function')
        namespace={'re':re}
        exec(compile(ast.Module(body=[extractor],type_ignores=[]),'registered-fleet-extractor','exec'),namespace)
        def function(name):
            if name=='pool_reuse_proof_file':return next(line for line in source.splitlines() if line.startswith(name+'() {'))
            return namespace['_extract_fleet_function'](source,name+'() {')
        functions='\n'.join(function(name) for name in ('registry_meta_value','pool_claim_fs_transaction',
            'write_pool_claim','claim_pool_machine','pool_reuse_proof_file','pool_verify_reuse_proof',
            'pool_claim_mark_cleanup_unconfirmed','pool_claim_cleanup_unconfirmed','pool_claim_release_exact','registry_owner_alive'))
        script='''set -uo pipefail
GIT_COMMON_DIR="$1"
POOL_IDS_FILE="$1/cloudbench-pools/destination.cold.ids"
POOL_META_FILE="$POOL_IDS_FILE.deps"
POOL_CLAIMS_DIR="$1/cloudbench-pool-claims"
FLEET_DIR="$1/run"; mkdir -p "$FLEET_DIR"
CLAIMED_POOL_FILE="$FLEET_DIR/claimed.ids"
FLEET_OWNERSHIP_ROOT="$1/cloudbench-fleet-ownership"
FLEET_OWNER_TOKEN=33333333333333333333333333333333
FLEET_OWNER_HOST="$(hostname)"
FLEET_OWNER_PID_START="proc-start:$(cat /proc/sys/kernel/random/boot_id):$(awk '{print $22}' /proc/$$/stat)"
POOL_COLD_BOOTSTRAP=1
BENCH_REF="$2"
STARTUP_FAILURE_ARCHIVE_HELPER="$3"
APP="$4"
POOL_INVENTORY_JSON='[]'
UNAVAILABLE_POOL_IDS=()
cloudbench_env_sha256() { sha256sum "$1" | cut -d' ' -f1; }
machine_volume_id_from_json() { cat >/dev/null; printf '%s' "$VOLUME"; }
fleet_audit_record_pool_machine() { printf '%s %s %s\n' "$1" "$2" "$3" >> "$AUDIT"; }
fleet_preconfig_native_read() { printf 'machine\n' >> "$READS"; cp "$NATIVE" "$2"; }
fleet_cold_handoff_volume_read() { printf 'volume\n' >> "$READS"; printf '{"id":"%s","attached_machine_id":"%s","state":"created"}' "$1" "$MACHINE" > "$2"; }
FLY() { printf FORBIDDEN >&2; return 99; }
'''+functions+'''
id="$(claim_pool_machine)" || exit 91
if [ "$EXPECT_PENDING" = 1 ]; then [ -z "$id" ] || exit 97; exit 0; fi
[ "$id" = "$MACHINE" ] || exit 92
[ "$(cat "$CLAIMED_POOL_FILE")" = "$MACHINE" ] || exit 93
[ "$(registry_meta_value "$POOL_CLAIMS_DIR/$MACHINE" fleet_owner_token)" = "$FLEET_OWNER_TOKEN" ] || exit 94
second="$(claim_pool_machine)" || exit 95
[ -z "$second" ] || exit 96
'''
        env=dict(os.environ,FLY_MACHINE_ID=self.target['machine'],VOLUME=VOLUME,MACHINE=MACHINE,
            NATIVE=str(self.before),READS=str(self.base/'native-reads'),AUDIT=str(self.base/'claim-audit'),EXPECT_PENDING='1')
        command=['bash','-c',script,'claim',str(self.destination),self.target['source_ref'],
            str(REPO/'scripts/cloudbench-startup-failure-archive.py'),APP]
        pending=subprocess.run(command,env=env,capture_output=True,text=True,timeout=10)
        self.assertEqual(pending.returncode,0,pending.stderr)
        self.assertFalse((self.base/'native-reads').exists(), 'ordinary claim cannot pass pending migration authority')
        self.helper['import_cold_handoff'](self.destination,self.target,self.packet,self.before,self.after)
        env['EXPECT_PENDING']='0'
        result=subprocess.run(command,env=env,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((self.base/'native-reads').read_text().splitlines(),['machine','machine','volume'])
        self.assertNotIn('FORBIDDEN',result.stderr)
        self.assertTrue((self.source/'cloudbench-cold-handoffs/outgoing'/MACHINE).exists())

class BillingStopRetainTests(unittest.TestCase):
    """Real helper/files/locks/timers; transport/PID mocked, deadline-only fsync isolated."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.ns = runpy.run_path(str(REPO/'scripts/cloudbench-original-volume-capture.py'))
        self.owner, self.mid, self.vol = 'a'*32, 'b'*14, 'vol_owned1'
        self.name = 'cloudbench-test-owned'
        self.registry = self.base/'common/cloudbench-fleet-ownership'/self.owner
        self.audit = self.base/'audit'/self.owner
        self.run = self.base/'runs/run-owned'
        for p in (self.registry/'clones', self.audit/'fresh', self.audit/'by-machine-id', self.run/'_batch'):
            p.mkdir(parents=True)
        self.receipts = self.run/'_batch/billing-stop-retain'
        self.meta = dict(version='2',fleet_owner_token=self.owner,cleanup_policy='reap',
            host=__import__('socket').gethostname(),pid=str(os.getppid()),pid_start='fixture-birth',
            run_id=self.run.name,app='test-app',workspace_root=str(self.base),
            runs_root=str(self.run.parent),audit_dir=str(self.audit))
        self.put(self.registry/'meta', self.meta)
        self.put(self.audit/'meta',dict(version='1',fleet_owner_token=self.owner,
            run_id=self.run.name,app='test-app',workspace_root=str(self.base),status='incomplete'))
        self.put(self.audit/'fresh'/self.name,dict(version='1',fleet_owner_token=self.owner,
            run_id=self.run.name,app='test-app',source='fresh-clone',source_machine_id='c'*14,
            clone_name=self.name,machine_id=self.mid,volume_id=self.vol,disposition='owned'))
        write(self.audit/'by-machine-id'/self.mid, self.name+'\n')
        self.put(self.registry/'clones'/self.name,dict(name=self.name,id=self.mid,volume_id=self.vol))
        write(self.registry/'runtime-evidence-unconfirmed', b'original-latch\n')
        write(self.registry/'guest-cleanup-unconfirmed', b'original-guest-latch\n')
        self.machine = dict(id=self.mid,name=self.name,instance_id='original-version',state='started',
            image_ref=dict(digest='pinned-image'),config=dict(init=dict(cmd=['sleep','infinity']),
            restart=dict(policy='no'),mounts=[dict(volume=self.vol,path='/data')],services=[dict(protocol='tcp')]))
        self.volume = dict(id=self.vol,attached_machine_id=self.mid)
        case = self
        class Provider:
            app = 'test-app'
            def __init__(self):
                self.posts=[]; self.calls=[]; self.probes=0; self.drift=None; self.unknown=False
                self.fail_stop=False; self.change_owner=False
            def api(self, method, path, body=None, timeout=60):
                self.calls.append((method,path))
                if method == 'POST':
                    self.posts.append(path)
                    if self.fail_stop:
                        raise case.ns['CaptureFailure']('ambiguous transport')
                    case.machine['state']='stopped'
                if path.startswith('/volumes/'):
                    return copy.deepcopy(case.volume)
                result=copy.deepcopy(case.machine)
                if self.probes and self.drift:
                    result[self.drift]='changed'
                return result
            def machine_exec_json(self, seconds, machine, command, **kwargs):
                import ast,shlex
                self.probes+=1
                code=shlex.split(command)[-1]
                tree=ast.parse(code)
                output=next(n for n in ast.walk(tree) if isinstance(n,ast.Dict)
                    and any(isinstance(k,ast.Constant)and k.value=='kind'for k in n.keys))
                values={k.value:v for k,v in zip(output.keys,output.values)if isinstance(k,ast.Constant)}
                nonce=ast.literal_eval(values['nonce'])
                row=dict(kind='exact-inert-quiescence-v1',machine=machine,nonce=nonce,
                    boot='0'*36,unknown=[dict(pid=99)]if self.unknown else[],inert_sleepers=[dict(pid=2,birth='3')])
                if self.change_owner:
                    case.put(case.registry/'meta',dict(case.meta,cleanup_policy='retain'))
                # Exercise the actual production ACK predicate, not a replacement.
                if not kwargs['validate_ack'](row):
                    raise case.ns['Refusal']('bad ACK')
                return row
        self.fly=Provider()
        self.original=self.files()

    def put(self,p,v):
        pairs(p,v)

    def files(self):
        return {str(p):p.read_bytes()for root in (self.registry,self.audit)
                for p in root.rglob('*')if p.is_file()}

    def call(self, **kwargs):
        with patch.dict(self.ns['billing_stop_retained_owned'].__globals__,
                        pid_birth_state=lambda *args:'live'):
            return self.ns['billing_stop_retained_owned'](self.fly,self.registry,self.audit,
                self.run,self.receipts,self.owner,os.getppid(),'fixture-birth',
                joins_verified=kwargs.get('joins_verified',True))

    def configure_owned_boot(self):
        contract = runpy.run_path(str(REPO/'scripts/cloudbench_execution_provenance.py'))
        matrix = contract['build_task_matrix'](['configured-task=real'])
        config = contract['build_config']('cloudbench-fleet-config-v1',
            ['app=test-app', 'task_count=1', 'task_matrix_sha256='+matrix['sha256']])
        snapshot = self.base/'snapshot'; snapshot.mkdir()
        write(snapshot/'fixture.py', 'pass\n')
        provenance = contract['build_provenance'](base_sha='c'*40,
            workspace_patch_sha256='none',
            snapshot_manifest=contract['build_snapshot_manifest'](snapshot), config=config)
        write(self.run/'execution-provenance.json', json.dumps(provenance))
        write(self.run/'execution-task-matrix.json', json.dumps(matrix))
        self.task = self.run/'configured-task'; self.task.mkdir()
        write(self.task/'.cid', 'clone '+self.mid+'\n')
        write(self.task/'runtime-evidence.owner.json', json.dumps(
            dict(version=1, machine_id=self.mid, run_token=self.owner+'-0')))
        self.machine['config']['init']={'cmd':['bash','/cloudbench-boot.sh']}
        self.machine['config']['env']={'REF':'c'*40, 'CLOUDBENCH_RUN_TOKEN':self.owner+'-0',
            'CLOUDBENCH_BARRIER_TOKEN':'actual-fleet-credential'}
        env_patch=patch.dict(os.environ, CLOUDBENCH_BARRIER_TOKEN='actual-fleet-credential')
        env_patch.start(); self.addCleanup(env_patch.stop)
        self.original=self.files()
        self.configured_originals={str(p):p.read_bytes() for p in self.run.rglob('*') if p.is_file()}

    def test_configured_owned_boot_stops_and_retains_failed_evidence(self):
        self.configure_owned_boot()
        result=self.call()
        self.assertEqual(result['status'],'COMPLETE',result)
        self.assertEqual(result['results'][0]['status'],'STOPPED_RETAINED')
        self.assertEqual(self.fly.posts,['/machines/'+self.mid+'/stop'])
        self.assertEqual(self.fly.probes,1)
        self.assertEqual(self.files(),self.original)
        self.assertFalse(result['native_release'])
        self.assertFalse(result['evidence_or_task_credit'])
        self.assertIn('configured_source_sha256',result['results'][0])
        self.assertEqual({str(p):p.read_bytes() for p in self.run.rglob('*')
                          if p.is_file() and '_batch' not in p.parts},
                         {p:v for p,v in self.configured_originals.items() if '_batch' not in Path(p).parts})

    def test_configured_boot_foreign_ref_tokens_and_task_refuse_before_probe(self):
        for field,value in [('REF','d'*40),('CLOUDBENCH_RUN_TOKEN','foreign-0'),
                            ('CLOUDBENCH_BARRIER_TOKEN','foreign-credential')]:
            with self.subTest(field=field):
                self.setUp(); self.configure_owned_boot()
                self.machine['config']['env'][field]=value
                self.assertEqual(self.call()['status'],'PENDING')
                self.assertEqual((self.fly.probes,self.fly.posts),(0,[]))
        self.setUp(); self.configure_owned_boot()
        write(self.task/'.cid','clone '+('d'*14)+'\n')
        self.assertEqual(self.call()['status'],'PENDING')
        self.assertEqual((self.fly.probes,self.fly.posts),(0,[]))

    def test_configured_boot_unknown_process_never_stops(self):
        self.configure_owned_boot(); self.fly.unknown=True
        self.assertEqual(self.call()['status'],'PENDING')
        self.assertEqual(self.fly.probes,1)
        self.assertEqual(self.fly.posts,[])
        self.assertEqual(self.files(),self.original)

    def test_configured_boot_source_change_after_probe_never_stops(self):
        self.configure_owned_boot()
        old=self.fly.machine_exec_json
        def changed(*args,**kwargs):
            result=old(*args,**kwargs)
            write(self.task/'.cid','clone '+('d'*14)+'\n')
            return result
        self.fly.machine_exec_json=changed
        self.assertEqual(self.call()['status'],'PENDING')
        self.assertEqual(self.fly.posts,[])

    def test_configured_boot_already_stopped_preserves_custody(self):
        self.configure_owned_boot(); self.machine['state']='stopped'
        result=self.call()
        self.assertEqual(result['results'][0]['status'],'ALREADY_STOPPED_RETAINED',result)
        self.assertEqual((self.fly.probes,self.fly.posts),(0,[]))
        self.assertEqual(self.files(),self.original)

    def test_configured_boot_missing_or_forged_provenance_refuses(self):
        for kind in ('missing-owner','changed-matrix','extra-init','unjoined','missing-barrier','foreign-owner'):
            with self.subTest(kind=kind):
                self.setUp(); self.configure_owned_boot()
                if kind=='missing-owner':(self.task/'runtime-evidence.owner.json').unlink()
                if kind=='changed-matrix':write(self.run/'execution-task-matrix.json','{}')
                if kind=='extra-init':self.machine['config']['init']['entrypoint']=['other']
                if kind=='missing-barrier':os.environ.pop('CLOUDBENCH_BARRIER_TOKEN',None)
                if kind=='foreign-owner':self.put(self.registry/'meta',dict(self.meta,fleet_owner_token='f'*32))
                self.assertEqual(self.call(joins_verified=kind!='unjoined')['status'],'PENDING')
                self.assertEqual((self.fly.probes,self.fly.posts),(0,[]))

    def configure_current_role(self, role):
        self.configure_owned_boot()
        if role == 'primary':
            write(self.task/'guest-shutdown.confirmed', self.run.name+'\n')
            write(self.task/'benchmark-child.finished', '0\n')
            write(self.task/'autoscaler.completed-after-child', '0\n')
        else:
            primary='c'*14
            write(self.task/'.cid','clone '+primary+'\n')
            write(self.task/'worker-runtime-evidence'/self.mid/'owner.json',json.dumps(
                dict(version=1,machine_id=self.mid,primary_machine_id=primary,
                     run_token=self.owner+'-0',workspace='test-workspace')))
            self.machine['config']['init']={'cmd':['sleep','infinity']}
            self.machine['config'].pop('env',None)
        self.original=self.files()

    def call_current(self, role='worker'):
        with patch.dict(self.ns['billing_stop_current_owned'].__globals__,pid_birth_state=lambda *args:'live'):
            return self.ns['billing_stop_current_owned'](self.fly,self.registry,self.audit,
                self.run,self.task,self.mid,role,self.owner,os.getppid(),'fixture-birth')

    def test_current_worker_stop_retains_owner_and_volume(self):
        self.configure_current_role('worker')
        result=self.call_current()
        self.assertEqual(result['status'],'STOPPED_RETAINED',result)
        self.assertEqual(self.fly.posts,['/machines/'+self.mid+'/stop'])
        self.assertEqual(self.files(),self.original)
        self.assertTrue(result['stopped_only']);self.assertEqual(result['pool_credit'],0)
        self.assertEqual(result['runtime_run_token'],self.owner+'-0')

    def test_current_worker_inherited_task_environment_is_exact(self):
        for changed in (None,'REF','CLOUDBENCH_RUN_TOKEN','CLOUDBENCH_BARRIER_TOKEN'):
            with self.subTest(changed=changed):
                self.setUp();self.configure_current_role('worker')
                self.machine['config']['env']={'REF':'c'*40,'CLOUDBENCH_RUN_TOKEN':self.owner+'-0',
                    'CLOUDBENCH_BARRIER_TOKEN':'actual-fleet-credential'}
                if changed:self.machine['config']['env'][changed]='foreign'
                result=self.call_current()
                if changed:
                    self.assertEqual(result['status'],'PENDING');self.assertEqual(self.fly.posts,[])
                else:
                    self.assertEqual(result['status'],'STOPPED_RETAINED',result)
                    self.assertEqual(self.files(),self.original)

    def test_current_primary_stop_defers_pool_return(self):
        self.configure_current_role('primary')
        result=self.call_current('primary')
        self.assertEqual(result['status'],'STOPPED_RETAINED',result)
        self.assertEqual(self.files(),self.original)
        self.assertFalse(result['native_release'])

    def test_current_worker_foreign_owner_token_or_source_refuses(self):
        for key in ('run_token','primary_machine_id','machine_id'):
            with self.subTest(key=key):
                self.setUp();self.configure_current_role('worker')
                path=self.task/'worker-runtime-evidence'/self.mid/'owner.json'
                row=json.loads(path.read_text());row[key]='foreign'
                write(path,json.dumps(row))
                self.assertEqual(self.call_current()['status'],'PENDING')
                self.assertEqual(self.fly.posts,[])

    def test_current_role_unknown_process_and_source_drift_refuse(self):
        for drift in (False,True):
            with self.subTest(drift=drift):
                self.setUp();self.configure_current_role('worker')
                if drift:
                    old=self.fly.machine_exec_json
                    def changed(*args,**kwargs):
                        value=old(*args,**kwargs);write(self.task/'.cid','pool '+('e'*14)+'\n');return value
                    self.fly.machine_exec_json=changed
                else:self.fly.unknown=True
                self.assertEqual(self.call_current()['status'],'PENDING')
                self.assertEqual(self.fly.posts,[])

    def test_current_role_never_repeats_stop_intent(self):
        self.configure_current_role('worker')
        self.assertEqual(self.call_current()['status'],'STOPPED_RETAINED')
        self.assertEqual(self.call_current()['status'],'PENDING')
        self.assertEqual(len(self.fly.posts),1)

    def test_current_role_requires_actual_ancestor_chain(self):
        self.assertTrue(self.ns['_billing_caller_descends_from'](os.getppid()))
        self.assertFalse(self.ns['_billing_caller_descends_from'](999999999))

    def test_exact_inert_primary_or_worker_stops_once_retains_every_record(self):
        result=self.call()
        self.assertEqual(result['status'],'COMPLETE',result)
        self.assertEqual(result['results'][0]['status'],'STOPPED_RETAINED')
        self.assertEqual(self.fly.posts,['/machines/'+self.mid+'/stop'])
        self.assertEqual(self.files(),self.original)
        self.assertFalse(result['evidence_or_task_credit'])
        second=self.call()
        self.assertEqual(second['status'],'PENDING')
        self.assertEqual(len(self.fly.posts),1)
        self.assertTrue((self.receipts/self.mid/'result.private.json').is_file())

    def test_already_stopped_has_no_probe_or_post_and_retains_latches(self):
        self.machine['state']='stopped'
        result=self.call()
        self.assertEqual(result['results'][0]['status'],'ALREADY_STOPPED_RETAINED',result)
        self.assertEqual((self.fly.probes,self.fly.posts),(0,[]))
        self.assertEqual(self.files(),self.original)

    def test_unjoined_retain_foreign_and_incomplete_have_no_native_calls(self):
        for variant in ('unjoined','retain','foreign','partial','symlink'):
            with self.subTest(variant=variant):
                self.setUp()
                if variant=='retain':self.put(self.registry/'meta',dict(self.meta,cleanup_policy='retain'))
                if variant=='foreign':self.put(self.registry/'meta',dict(self.meta,fleet_owner_token='f'*32))
                if variant=='partial':self.put(self.audit/'fresh'/self.name,dict(disposition='ownership-pending'))
                if variant=='symlink':
                    (self.registry/'clones'/self.name).unlink()
                    (self.registry/'clones'/self.name).symlink_to(self.audit/'meta')
                result=self.call(joins_verified=variant!='unjoined')
                self.assertEqual(result['status'],'PENDING',result)
                self.assertEqual(self.fly.calls,[])

    def test_config_version_image_volume_and_unknown_process_refuse_stop(self):
        for variant in ('version','image','config','volume','unknown','claim','recovery'):
            with self.subTest(variant=variant):
                self.setUp()
                if variant=='version':self.fly.drift='instance_id'
                if variant=='image':self.fly.drift='image_ref'
                if variant=='config':self.machine['config']['init']={'cmd':['task-driver']}
                if variant=='volume':self.volume['attached_machine_id']='foreign'
                if variant=='unknown':self.fly.unknown=True
                if variant=='claim':write(self.base/'common/cloudbench-pool-claims'/self.mid,'foreign claim')
                if variant=='recovery':(self.registry/'recovery-lock').mkdir()
                result=self.call()
                self.assertEqual(result['status'],'PENDING',result)
                self.assertEqual(self.fly.posts,[])

    def test_policy_changes_after_probe_refuse_and_ambiguous_stop_never_retries(self):
        self.fly.change_owner=True
        self.assertEqual(self.call()['status'],'PENDING')
        self.assertEqual(self.fly.posts,[])
        self.setUp()
        self.fly.fail_stop=True
        first=self.call()
        self.assertEqual(first['status'],'PENDING')
        self.assertTrue(first['results'][0]['stop_issued'])
        self.assertEqual(self.call()['status'],'PENDING')
        self.assertEqual(len(self.fly.posts),1)

    def test_billing_guest_is_bounded_and_pins_both_platform_hashes(self):
        code=self.ns['BILLING_GUEST'].replace('TARGET',repr(self.mid)).replace('NONCE',repr('d'*32))
        compile(code,'billing-guest','exec')
        import shlex
        self.assertLessEqual(len(('python3 -I -S -B -c '+shlex.quote(code)).encode()),7000)
        self.assertIn('7e42662dc2361058814d06b80bafbed13b7e8d6da4f477604001b54dc905ce52',code)
        self.assertIn('02f70fcb946d386f697ad7fbe16d91a2f9243f85c6db583e3778582cd23b35c0',code)


    def test_durable_final_pair_and_all_receipt_links_match_actual_bytes(self):
        synced=[]
        real_fsync=os.fsync
        def record_sync(fd):
            real_fsync(fd)
            info=os.fstat(fd)
            synced.append(('sync',info.st_dev,info.st_ino))
        real_rename=self.ns['rename_noreplace']
        def record_rename(source,target):
            info=source.stat()
            self.assertIn(('sync',info.st_dev,info.st_ino),synced,str(target))
            real_rename(source,target)
            synced.append(('rename',info.st_dev,info.st_ino))
        def require_durable(path):
            info=path.stat()
            published=synced.index(('rename',info.st_dev,info.st_ino))
            parent=path.parent.stat()
            self.assertIn(('sync',parent.st_dev,parent.st_ino),synced[published+1:],str(path.parent))
        raw_guest=self.fly.machine_exec_json
        def durable_guest(*args,**kwargs):
            for name in ('owner-snapshot.private.json','intent.private.json','native-before.private.json'):
                require_durable(self.receipts/self.mid/name)
            return raw_guest(*args,**kwargs)
        self.fly.machine_exec_json=durable_guest
        with patch.object(os,'fsync',side_effect=record_sync), patch.dict(
                self.ns['publish_bytes'].__globals__,rename_noreplace=record_rename):
            result=self.call()['results'][0]
        folder=self.receipts/self.mid
        for path in folder.iterdir():
            require_durable(path)
        saved=json.loads((folder/'result.private.json').read_bytes())
        self.assertEqual(saved,result)
        for filename,key in [('native-final.private.json','native_final_sha256'),
                             ('intent.private.json','intent_sha256'),
                             ('quiescence.private.json','quiescence_sha256')]:
            p=folder/filename
            self.assertEqual(hashlib.sha256(p.read_bytes()).hexdigest(),saved[key])
            self.assertEqual(stat.S_IMODE(p.stat().st_mode),0o600)
        pair=json.loads((folder/'native-final.private.json').read_bytes())
        self.assertEqual(pair,dict(machine=self.machine,volume=self.volume))
        self.assertEqual(pair['machine']['state'],'stopped')
        self.assertFalse(saved['native_release'])

    def test_duplicate_audit_and_busy_recovery_guard_prevent_any_native_call(self):
        self.put(self.audit/'fresh'/'cloudbench-duplicate',dict(machine_id=self.mid,volume_id=self.vol))
        self.assertEqual(self.call()['status'],'PENDING')
        self.assertEqual(self.fly.calls,[])
        self.setUp()
        import fcntl
        guard=self.base/'common/cloudbench-fleet-recovery-locks'/self.owner
        guard.parent.mkdir()
        with guard.open('w')as f:
            fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
            self.assertEqual(self.call()['status'],'PENDING')
            self.assertEqual(self.fly.calls,[])

    def test_actual_guest_scan_rejects_other_uids_permission_and_missing_exe(self):
        # Execute the unmodified deployed scan AST over private /proc fixtures;
        # only proc-root/UID observations are mapped, never the allow decisions.
        import ast,types
        tree=ast.parse(self.ns['BILLING_GUEST'])
        functions=[n for n in tree.body if isinstance(n,ast.FunctionDef)]
        start=next(i for i,n in enumerate(tree.body)if isinstance(n,ast.Assign)
                   and any(isinstance(t,ast.Name)and t.id=='entries'for t in n.targets))
        body=functions+tree.body[start:-1]
        program=compile(ast.Module(body=body,type_ignores=[]),'actual-billing-scan','exec')
        proc=self.base/'proc';process=proc/'123';process.mkdir(parents=True)
        st=['S','1','0']+['0']*17;st[19]='42'
        write(process/'stat','123 (fixture) '+' '.join(st))
        write(process/'cmdline',b'sleep\0infinity\0')
        (process/'exe').symlink_to('/bin/sleep')
        real_stat=Path.stat;real_read=Path.read_bytes
        for variant in ('inert','foreign-uid','permission','missing-exe'):
            with self.subTest(variant=variant):
                def mapped_path(value):return proc if value=='/proc'else Path(value)
                def mapped_stat(path,*a,**kw):
                    if path==process:return types.SimpleNamespace(st_uid=2000 if variant=='foreign-uid' else 1001)
                    return real_stat(path,*a,**kw)
                def mapped_read(path):
                    if variant=='permission'and path==process/'cmdline':raise PermissionError('fixture')
                    return real_read(path)
                env=dict(Path=mapped_path,os=os,stat=stat,hashlib=hashlib,ancestors=set(),
                         expected_sleep=Path('/bin/sleep').resolve(),sleep_stat=Path('/bin/sleep').stat())
                if variant=='missing-exe':(process/'exe').unlink()
                with patch.object(Path,'stat',mapped_stat),patch.object(Path,'read_bytes',mapped_read):
                    if variant=='inert':
                        exec(program,env)
                        self.assertEqual(env['unknown'],[])
                        self.assertEqual(len(env['allowed_sleep']),1)
                    else:
                        with self.assertRaises((AssertionError,PermissionError)):exec(program,env)

    def test_actual_platform_identity_requires_each_exact_field(self):
        import ast
        function=next(n for n in ast.parse(self.ns['BILLING_GUEST']).body
                      if isinstance(n,ast.FunctionDef)and n.name=='hallpass_identity')
        env={};exec(compile(ast.Module(body=[function],type_ignores=[]),'actual-platform-identity','exec'),env)
        values=[0,1,0,[b'/.fly/hallpass'],'/.fly/hallpass',
                '7e42662dc2361058814d06b80bafbed13b7e8d6da4f477604001b54dc905ce52',True,True,0]
        self.assertTrue(env['hallpass_identity'](*values))
        for index,bad in enumerate([1,2,1,[b'hallpass'],'/tmp/hallpass','f'*64,False,False,1]):
            altered=list(values);altered[index]=bad
            self.assertFalse(env['hallpass_identity'](*altered))


    def test_captured_oct13_platform_hallpass_descriptor(self):
        import ast
        descriptor=json.loads(Path(__file__).with_name('hallpass-platform-descriptor.fixture.json').read_text())
        function=next(n for n in ast.parse(self.ns['BILLING_GUEST']).body
                      if isinstance(n,ast.FunctionDef)and n.name=='hallpass_identity')
        env={};exec(compile(ast.Module(body=[function],type_ignores=[]),'captured-platform-identity','exec'),env)
        values=[descriptor['uid'],descriptor['ppid'],descriptor['pgid'],
                [b'/.fly/hallpass'] if descriptor['exact_argv'] else [], descriptor['exe'],
                descriptor['exe_sha256'],descriptor['birth_stable'],descriptor['exe_regular'],descriptor['exe_owner']]
        self.assertTrue(env['hallpass_identity'](*values))
        for index,bad in enumerate([1,2,1,[b'/.fly/hallpass',b'--unknown'],'/tmp/hallpass','f'*64,False,False,1]):
            with self.subTest(field=index):
                altered=list(values);altered[index]=bad
                self.assertFalse(env['hallpass_identity'](*altered))

    def test_whole_cohort_owns_one_clock_and_preserves_shorter_caller_budget(self):
        import signal
        second='c'*14
        row=dict(version='1',fleet_owner_token=self.owner,run_id=self.run.name,app='test-app',
            source='fresh-clone',source_machine_id='d'*14,clone_name='cloudbench-second',
            machine_id=second,volume_id='vol_second',disposition='owned')
        self.put(self.audit/'fresh'/'cloudbench-second',row)
        self.put(self.registry/'clones'/'cloudbench-second',dict(name='cloudbench-second',id=second,volume_id='vol_second'))
        write(self.audit/'by-machine-id'/second,'cloudbench-second\n')
        old_handler=signal.getsignal(signal.SIGALRM)
        self.addCleanup(signal.signal,signal.SIGALRM,old_handler)
        self.addCleanup(signal.setitimer,signal.ITIMER_REAL,0)
        seen=[]
        def bounded_target(*args):
            remaining=signal.getitimer(signal.ITIMER_REAL)[0]
            self.assertGreater(remaining,0,'whole-call clock missing before per-target work')
            seen.append(remaining)
            time.sleep(.01)
        with patch.dict(self.ns['billing_stop_retained_owned'].__globals__,_billing_stop_one=bounded_target):
            self.call()
            self.assertEqual(len(seen),2)
            self.assertLess(seen[1],seen[0])
            self.assertLessEqual(seen[0],180)
            self.assertEqual(signal.getitimer(signal.ITIMER_REAL),(0.0,0.0))
            seen.clear()
            signal.setitimer(signal.ITIMER_REAL,.5)
            self.call()
            self.assertLess(seen[0],.5)
            self.assertLess(seen[1],seen[0])
            self.assertLess(signal.getitimer(signal.ITIMER_REAL)[0],seen[0])


    def test_metadata_publication_does_not_extend_real_blocking_guest_deadline(self):
        import signal
        prior_handler=signal.getsignal(signal.SIGALRM)
        prior_timer=signal.getitimer(signal.ITIMER_REAL)
        self.addCleanup(signal.signal,signal.SIGALRM,prior_handler)
        self.addCleanup(signal.setitimer,signal.ITIMER_REAL,*prior_timer)
        raw_publish=self.ns['publish_bytes']
        def delayed_publish(path,data):
            if path.name=='owner-snapshot.private.json':time.sleep(.25)
            return raw_publish(path,data)
        guest_limits=[]
        def blocking_guest(seconds,*args,**kwargs):
            guest_limits.append(seconds)
            time.sleep(3)  # deliberately ignores socket/transport timeout
            raise AssertionError('absolute wall alarm did not stop guest tail')
        self.fly.machine_exec_json=blocking_guest
        signal.signal(signal.SIGALRM,lambda *unused:None)
        signal.setitimer(signal.ITIMER_REAL,1.5)
        started=time.monotonic()
        try:
            # Real writes, renames, locks and alarms exercise deadline accounting.
            # Disk flush latency has its own real-sync ordering test above; it
            # must not consume the subsecond dispatch margin in this fixture.
            with patch.object(os,'fsync',return_value=None), patch.dict(self.ns['billing_stop_retained_owned'].__globals__,publish_bytes=delayed_publish):
                result=self.call()
            elapsed=time.monotonic()-started
        finally:
            signal.setitimer(signal.ITIMER_REAL,0)
        self.assertEqual(result['status'],'PENDING')
        self.assertEqual(self.fly.posts,[])
        self.assertTrue(guest_limits,'actual guest dispatch must be reached')
        self.assertLess(elapsed,1.62,'metadata publication was added back to whole-call deadline')
        self.assertEqual(guest_limits,[1],'integer guest timeout must fit remaining original clock')


class ClaimedPoolRetainedEvidenceStopTests(unittest.TestCase):
    """A missing evidence copy retains custody, not a verified idle VM's CPU."""
    def branch(self, *, runtime_failed=1, guest_failed=0, joins=1, never_stopped=False, tainted=False, owned=True):
        source=(REPO/'scripts/run-bench-fleet').read_text()
        start=source.index('    # Return only machines this fleet actually claimed.')
        stop=source.index('    # Claims are independent recovery roots',start)
        # The return branch verifies staged-boot evidence through these real
        # helpers; outside the staged boot transport they are exact no-ops.
        helpers_start=source.index('fleet_verify_staged_primary_return() {')
        helpers=source[helpers_start:source.index('\n# The live-owner plan shares',helpers_start)+1]
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'claims').mkdir();(root/'claims/machine').write_text('exact claim')
            (root/'claimed').write_text('machine\n');(root/'tainted').write_text('machine\n' if tainted else '')
            script=r'''
set -u
CLAIMED_POOL_FILE="$ROOT/claimed";POOL_CLAIMS_DIR="$ROOT/claims";TAINTED_POOL_FILE="$ROOT/tainted"
FLEET_TEARDOWN_OWNERSHIP_DIR="$ROOT/audit";APP=offline;FLEET_OWNER_TOKEN=owner;FLEET_OWNER_HOST=host;FLEET_OWNER_PID_START=birth
CLOUDBENCH_POOL_STOP_REQUEST_ATTEMPTS=1;CLOUDBENCH_POOL_STOP_ATTEMPTS=3;CLOUDBENCH_BOOT_TRANSPORT=config
sleep(){ :; }
fly_with_timeout(){ echo stop >> "$ROOT/stops"; return 0; }
FLY(){
 count=0;[ ! -f "$ROOT/reads" ] || count=$(cat "$ROOT/reads");count=$((count+1));echo "$count" > "$ROOT/reads"
 state=stopping;[ "$count" -lt 2 ] || state=stopped;[ "$NEVER" = 0 ] || state=started
 printf '{"state":"%s"}\n' "$state"
}
pool_machine_state_from_json(){ python3 -c 'import json,sys;print(json.load(sys.stdin)["state"])'; }
machine_volume_id_from_json(){ cat >/dev/null; echo volume; }
registry_meta_value(){ echo volume; }
cloudbench_env_sha256(){ echo digest; }
pool_claim_owned_by_current(){ [ "$OWNED" = 1 ]; }
fleet_audit_record_pool_machine(){ echo released >> "$ROOT/audit-release"; }
pool_claim_release_exact(){ rm "$ROOT/claims/machine"; }
reap_machine(){ echo destroyed > "$ROOT/destroyed";return 0; }
pool_ledger_remove_id(){ :; }
''' + helpers + r'''
run(){
 local ec=1 teardown_failed=1 guest_shutdown_failed="$GUEST" runtime_evidence_failed="$RUNTIME" billing_owned_joins="$JOINS"
 local id i out claim_path st presence machines round stop_pid pool_volume_id claim_digest machine_reap_status
 local -a claimed_pool_ids=() pending_pool_ids=() next_pending_pool_ids=() stop_pids=() CHILD_MACHINE=() CHILD_OUT=()
''' + source[start:stop] + '\n echo "$ec" > "$ROOT/ec"\n}\nrun\n'
            result=subprocess.run(['bash','-c',script],env={**os.environ,'ROOT':str(root),'RUNTIME':str(runtime_failed),'GUEST':str(guest_failed),'JOINS':str(joins),'NEVER':str(int(never_stopped)),'OWNED':str(int(owned))},capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            return {'stops':(root/'stops').read_text().splitlines() if (root/'stops').exists() else [],'reads':int((root/'reads').read_text()) if (root/'reads').exists() else 0,'claim':(root/'claims/machine').exists(),'release':(root/'audit-release').exists(),'destroyed':(root/'destroyed').exists(),'stdout':result.stdout,'stderr':result.stderr}

    def test_missing_runtime_copy_stops_and_confirms_but_retains_claim(self):
        row=self.branch()
        self.assertTrue(row['stops'],'idle claimed VM must be stopped even when evidence copy failed')
        self.assertGreaterEqual(row['reads'],2,'STOP ACK is not a stopped-state observation')
        self.assertTrue(row['claim']);self.assertFalse(row['release'])

    def test_unconfirmed_guest_or_owned_join_never_stops(self):
        for flags in ({'guest_failed':1},{'joins':0},{'joins':0,'runtime_failed':0}):
            with self.subTest(flags=flags):self.assertFalse(self.branch(**flags)['stops'])

    def test_stop_ack_without_stopped_keeps_claim_and_reports_failure(self):
        row=self.branch(never_stopped=True)
        self.assertTrue(row['stops']);self.assertTrue(row['claim']);self.assertFalse(row['release'])
        self.assertIn('did not verify stopped',row['stderr'])

    def test_missing_evidence_tainted_claim_is_stopped_without_destroy(self):
        row=self.branch(tainted=True)
        self.assertTrue(row['stops']);self.assertFalse(row['destroyed']);self.assertTrue(row['claim'])

    def test_confirmed_normal_return_still_releases_claim(self):
        row=self.branch(runtime_failed=0)
        self.assertTrue(row['stops']);self.assertFalse(row['claim']);self.assertTrue(row['release'])

    def test_foreign_claim_never_stops(self):
        row=self.branch(owned=False)
        self.assertFalse(row['stops']);self.assertTrue(row['claim'])

class FreshPrimaryPoolReturnTests(unittest.TestCase):
    """Teardown stops exact healthy primaries before the live-owner handoff."""
    def helper(self, *, never_stopped=False, foreign=False, denied=False, already=False, warm=False):
        source=(REPO/'scripts/run-bench-fleet').read_text()
        start=source.index('stop_current_registry_primaries_for_pool() {')
        end=source.index('\ncleanup() {',start)
        with tempfile.TemporaryDirectory() as tmp:
            script=r'''
set -u
current_registry_primaries_to_pool_plan(){ [ "$DENIED" = 0 ] || return 1; printf 'baseline\nmachine\tclone\tvolume\n'; }
fleet_native_stop_call_budget(){ c=0;[ ! -f "$ROOT/reads" ] || c=$(cat "$ROOT/reads");[ "$c" -lt 5 ] || return 1;echo 1; }
registry_machine_details(){
 c=0;[ ! -f "$ROOT/reads" ] || c=$(cat "$ROOT/reads");c=$((c+1));echo "$c" > "$ROOT/reads"
 state=started;[ "$ALREADY" = 0 ] || state=stopped
 if [ -f "$ROOT/stop" ] && [ "$NEVER" = 0 ];then state=stopping;[ "$c" -lt 3 ] || state=stopped;fi
 echo "$state clone"
}
machine_volume_id(){ [ "$FOREIGN" = 0 ] && echo volume || echo other; }
fleet_native_stop_send(){ echo stop >> "$ROOT/stop"; }
sleep(){ :; }
''' + source[start:end] + '\nstop_current_registry_primaries_for_pool 1 0 0\n'
            r=subprocess.run(['bash','-c',script],env={**os.environ,'ROOT':tmp,'NEVER':str(int(never_stopped)),'FOREIGN':str(int(foreign)),'DENIED':str(int(denied)),'ALREADY':str(int(already)), 'WARM_ID':'machine' if warm else ''},capture_output=True,text=True,timeout=10)
            root=Path(tmp)
            return r.returncode,(root/'stop').exists(),int((root/'reads').read_text()) if (root/'reads').exists() else 0

    def callsite(self, stop_failure=False, return_failure=False):
        source=(REPO/'scripts/run-bench-fleet').read_text()
        start=source.index('    # Claims are independent recovery roots')
        end=source.index('    # Clone volume IDs are persisted',start)
        with tempfile.TemporaryDirectory() as tmp:
            script=r'''
set -u
reconcile_current_pool_transfer_claims(){ :; }
reconcile_current_pool_claims(){ :; }
stop_current_registry_primaries_for_pool(){ echo stop >> "$ROOT/events";return "$STOP_FAIL"; }
return_current_registry_primaries_to_pool(){ echo return >> "$ROOT/events";return "$RETURN_FAIL"; }
reap_registry_clones(){ echo reap >> "$ROOT/events"; }
run(){
 local ec=0 teardown_failed=0 KEEP_CLONES=0 FLEET_REGISTRY_PUBLISHED=1 FLEET_REGISTRY_DIR=registry
 local billing_owned_joins=1 guest_shutdown_failed=0 runtime_evidence_failed=0
''' + source[start:end] + '\n echo "$ec $KEEP_CLONES $teardown_failed" > "$ROOT/result"\n}\nrun\n'
            r=subprocess.run(['bash','-c',script],env={**os.environ,'ROOT':tmp,'STOP_FAIL':str(int(stop_failure)),'RETURN_FAIL':str(int(return_failure))},capture_output=True,text=True,timeout=10)
            self.assertEqual(r.returncode,0,r.stderr);p=Path(tmp)
            return (p/'events').read_text().splitlines(),(p/'result').read_text().strip()

    def test_native_stop_ack_requires_observed_stopped_before_success(self):
        rc,posted,reads=self.helper();self.assertEqual(rc,0);self.assertTrue(posted);self.assertGreaterEqual(reads,3)
        rc,posted,reads=self.helper(never_stopped=True);self.assertNotEqual(rc,0);self.assertTrue(posted)

    def test_foreign_or_unverified_owner_plan_never_stops(self):
        for flags in ({'foreign':True},{'denied':True},{'warm':True}):
            with self.subTest(flags=flags):self.assertFalse(self.helper(**flags)[1])

    def test_already_stopped_is_rechecked_without_stop_request(self):
        rc,posted,reads=self.helper(already=True);self.assertEqual(rc,0);self.assertFalse(posted);self.assertGreaterEqual(reads,2)

    def test_successful_teardown_stops_then_returns_before_remaining_reap(self):
        events,result=self.callsite();self.assertEqual(events,['stop','return','reap']);self.assertEqual(result,'0 0 0')

    def test_failed_stop_or_return_retains_without_reap(self):
        for stop_failure,return_failure in [(True,False),(False,True)]:
            with self.subTest(stop_failure=stop_failure):
                events,result=self.callsite(stop_failure,return_failure);self.assertNotIn('reap',events);self.assertEqual(result,'1 1 1')

class ReuseOnlyRetirementTests(unittest.TestCase):
    def worker_branch(self, *, failed=False, capture_failed=False, borrowed=False):
        source=(REPO/'scripts/run-bench-fleet').read_text()
        start=source.index('    if [ "$borrowed_worker" = 0 ] && [ "${POOL_REUSE_ONLY:-0}" = 1 ]; then',source.index('cleanup_failed_worker()')) if '    if [ "$borrowed_worker" = 0 ] && [ "${POOL_REUSE_ONLY:-0}" = 1 ]; then' in source else source.index('    if [ "$rc" = 0 ] && [ "$borrowed_worker" = 1 ]; then',source.index('cleanup_failed_worker()'))
        end=source.index('    worker_ledger_lock_acquire "$cleanup_out"',start)
        with tempfile.TemporaryDirectory() as td:
            script=r'''
set -u
rc="$CAPTURE_FAIL";borrowed_worker="$BORROWED";retained_worker=0;POOL_REUSE_ONLY=1
cleanup_out=out;cleanup_wid=machine;cleanup_log=log;volume_id=volume;machine_reap_status=-1
stop_current_owned_machine_retained(){ echo stop >> "$EVENTS";return "$STOP_FAIL"; }
return_reusable_worker(){ echo borrowed >> "$EVENTS"; }
reap_machine(){ echo destroy >> "$EVENTS"; }
fleet_audit_update_fresh_clone_by_id(){ echo audit-release >> "$EVENTS"; }
fleet_registry_release_id(){ echo registry-release >> "$EVENTS"; }
'''+source[start:end]+'\necho "$rc $retained_worker"\n'
            events=Path(td)/'events'
            r=subprocess.run(['bash','-c',script],env={**os.environ,'EVENTS':str(events),'STOP_FAIL':str(int(failed)),'CAPTURE_FAIL':str(int(capture_failed)),'BORROWED':str(int(borrowed))},capture_output=True,text=True)
            self.assertEqual(r.returncode,0,r.stderr)
            return events.read_text().splitlines() if events.exists() else [],r.stdout.strip()

    def test_fresh_worker_stops_without_releasing_registry(self):
        events,result=self.worker_branch();self.assertEqual(events,['stop']);self.assertEqual(result,'0 1')

    def test_failed_stop_or_capture_retains_failure_without_delete(self):
        for flags in ({'failed':True},{'capture_failed':True}):
            with self.subTest(flags=flags):
                events,result=self.worker_branch(**flags);self.assertEqual(events,['stop']);self.assertTrue(result.startswith('1 '))

    def test_borrowed_worker_return_unchanged(self):
        events,result=self.worker_branch(borrowed=True);self.assertEqual(events,['borrowed']);self.assertEqual(result,'0 0')

    def test_early_primary_routes_stop_and_defers_reap(self):
        source=(REPO/'scripts/run-bench-fleet').read_text();a=source.index('fleet_retire_sealed_primary()');b=source.index('\n}\n',a)+2;body=source[a:b]
        start=body.rfind('    if [ "${POOL_REUSE_ONLY:-0}" = 1 ]; then')
        if start<0:start=body.rfind('    fleet_reap_registry_record ')
        tail=body[start:body.rfind('\n}')]
        script=r'''
POOL_REUSE_ONLY=1;out=output;machine=machine;clone=clone;FLEET_REGISTRY_DIR=registry
stop_current_owned_machine_retained(){ echo stop; }
fleet_reap_registry_record(){ echo destroy; }
'''+tail
        r=subprocess.run(['bash','-c',script],capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(r.stdout.strip(),'stop')

    def test_final_cleanup_residual_worker_never_enters_reaper(self):
        source=(REPO/'scripts/run-bench-fleet').read_text()
        start=source.index('    # Claims are independent recovery roots')
        end=source.index('    # Clone volume IDs are persisted',start)
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);(root/'clones').mkdir();record=root/'clones/worker';record.write_text('owned worker')
            script=r'''
set -u
POOL_REUSE_ONLY=1;FLEET_REGISTRY_PUBLISHED=1;KEEP_CLONES=0;ec=0;teardown_failed=0
billing_owned_joins=1;guest_shutdown_failed=0;runtime_evidence_failed=0
reconcile_current_pool_transfer_claims(){ :; }
reconcile_current_pool_claims(){ :; }
stop_current_registry_primaries_for_pool(){ :; }
return_current_registry_primaries_to_pool(){ :; }
reap_registry_clones(){ echo FORBIDDEN; }
'''+source[start:end]+'\necho "$KEEP_CLONES $ec $teardown_failed"\n'
            r=subprocess.run(['bash','-c',script],env={**os.environ,'FLEET_REGISTRY_DIR':td},capture_output=True,text=True)
            self.assertEqual(r.returncode,0,r.stderr)
            self.assertNotIn('FORBIDDEN',r.stdout)
            self.assertEqual(r.stdout.strip(),'1 1 1')
            self.assertEqual(record.read_text(),'owned worker')

    def test_reuse_only_destroy_boundary_refuses_before_native(self):
        source=(REPO/'scripts/run-bench-fleet').read_text();start=source.index('reap_machine() {');end=source.index('\n}\n',start)+3
        script='POOL_REUSE_ONLY=1; FLY(){ echo FORBIDDEN; };\n'+source[start:end]+'\nreap_machine machine\n'
        r=subprocess.run(['bash','-c',script],capture_output=True,text=True)
        self.assertNotEqual(r.returncode,0);self.assertNotIn('FORBIDDEN',r.stdout)


class BootUpdatePermanentQuotaTests(unittest.TestCase):
    def run_update(self, error):
        source=(REPO/'scripts/run-bench-cloud').read_text()
        start=source.index('boot_update_with_capacity_recovery() {')
        end=source.index('\n}\n',start)+3
        with tempfile.TemporaryDirectory() as tmp:
            script=source[start:end]+"""
CLOUDBENCH_BOOT_UPDATE_ATTEMPTS=2
CLOUDBENCH_BOOT_UPDATE_CAPACITY_WAIT_SECONDS=1200
CLOUDBENCH_BOOT_UPDATE_CAPACITY_RETRY_SECONDS=8
CLOUDBENCH_BOOT_UPDATE_RETRY_SECONDS=8
calls=0; sleeps=0
_with_timeout() {
  calls=$((calls+1))
  if [ "$calls" = 1 ]; then printf '%s\n' "$TEST_ERROR"; return 1; fi
  return 0
}
sleep() { sleeps=$((sleeps+1)); }
boot_update_with_capacity_recovery "$TEST_LOG" fake update
result=$?
printf '%s %s %s\n' "$result" "$calls" "$sleeps"
"""
            p=subprocess.run(['bash','-c',script],env={**os.environ,'TEST_ERROR':error,'TEST_LOG':tmp+'/update.log'},capture_output=True,text=True,timeout=5)
            self.assertEqual(p.returncode,0,p.stderr)
            return tuple(map(int,p.stdout.split())),p.stderr,Path(tmp+'/update.log').read_text()

    def test_reached_org_machine_limit_is_one_attempt_no_wait(self):
        result,stderr,log=self.run_update('Error: organization has reached its machine limit (422)')
        self.assertEqual(result,(1,1,0));self.assertIn('no retry',stderr);self.assertIn('(422)',log)

    def test_machine_limit_reached_variant_is_one_attempt_no_wait(self):
        result,stderr,log=self.run_update('Error: machine limit: reached')
        self.assertEqual(result,(1,1,0));self.assertIn('no retry',stderr)

    def test_host_cpu_capacity_keeps_existing_retry(self):
        result,stderr,log=self.run_update('Error: insufficient CPUs available to fulfill request on the current host')
        self.assertEqual(result,(0,2,1));self.assertIn('1200s ceiling',stderr)

    def test_rate_limit_keeps_existing_regular_retry(self):
        result,stderr,log=self.run_update('Error: 429 Too Many Requests')
        self.assertEqual(result,(0,2,1));self.assertNotIn('Machine limit',stderr)

class ReuseOnlyVolumeGuardTests(unittest.TestCase):
    def run_recovery(self,reuse):
        source=(REPO/'scripts/run-bench-fleet').read_text()
        def function(name):
            start=source.index(name+'() {');end=source.index('\n}\n',start)+3
            return source[start:end]
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);claim=root/'abcdef12345678';ledger=root/'pool.ids';ledger.write_text('abcdef12345678\n');(root/'pool.ids.deps').write_text('baseline')
            claim.write_text('fleet_owner_token=owner\nhost=host\npid=123\npid_start=birth\nvolume_id=vol_retained\npool_ledger_file='+str(ledger)+'\npool_meta_sha256=baseline\n')
            script=function('reap_volume')+'\n'+function('recover_one_exact_pool_claim')+'''
registry_meta_value() { sed -n "s/^$2=//p" "$1"; }
cloudbench_env_sha256() { if [ "$1" = "$LEDGER.deps" ]; then printf baseline; else printf claimdigest; fi; }
fleet_audit_update_recovered_pool_machine() { return 0; }
pool_machine_state() { return 1; }
FLY() { printf '%s\n' "$*" >> "$CALLS"; }
volume_inventory_contains_id() { return 1; }
pool_ledger_remove_id_from() { printf removed >> "$MUTATIONS"; }
pool_claim_release_exact() { printf released >> "$MUTATIONS"; }
recover_one_exact_pool_claim "$CLAIM" owner host 123 birth
rc=$?
printf 'rc=%s\n' "$rc"
'''
            env={**os.environ,'POOL_REUSE_ONLY':str(reuse),'GIT_COMMON_DIR':td,'FLEET_AUDIT_ROOT':td,'LEDGER':str(ledger),'CLAIM':str(claim),'CALLS':str(root/'calls'),'MUTATIONS':str(root/'mutations')}
            result=subprocess.run(['bash','-c',script],env=env,capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            return result,(root/'calls').read_text() if (root/'calls').exists() else '',(root/'mutations').read_text() if (root/'mutations').exists() else '',ledger.read_text(),claim.read_text()

    def test_absent_machine_recovery_retains_volume_claim_and_ledger_in_reuse_mode(self):
        result,calls,mutations,ledger,claim=self.run_recovery(1)
        self.assertIn('rc=1',result.stdout);self.assertEqual(calls,'');self.assertEqual(mutations,'')
        self.assertEqual(ledger,'abcdef12345678\n');self.assertIn('vol_retained',claim)
        self.assertIn('refusing destroy',result.stderr)

    def test_explicit_nonreuse_recovery_retains_existing_destroy_contract(self):
        result,calls,mutations,ledger,claim=self.run_recovery(0)
        self.assertIn('rc=0',result.stdout);self.assertIn('volumes destroy vol_retained',calls)
        self.assertIn('removed',mutations);self.assertIn('released',mutations)

    def test_direct_reuse_volume_destroy_refuses_before_provider(self):
        source=(REPO/'scripts/run-bench-fleet').read_text();start=source.index('reap_volume() {');end=source.index('\n}\n',start)+3
        script='POOL_REUSE_ONLY=1; FLY(){ echo FORBIDDEN; };\n'+source[start:end]+'\nreap_volume vol_retained\n'
        result=subprocess.run(['bash','-c',script],capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0);self.assertNotIn('FORBIDDEN',result.stdout)


    def test_normal_reuse_stale_scan_preserves_all_historical_records(self):
        source=(REPO/'scripts/run-bench-fleet').read_text()
        def function(name):
            start=source.index(name+'() {');return source[start:source.index('\n}\n',start)+3]
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);old=root/'old';old.mkdir();meta=old/'meta';meta.write_text('version=2\napp=app\ncleanup_policy=reap\nhost=host\n')
            before=(meta.stat().st_ino,meta.read_bytes())
            script=function('reconcile_stale_fleet_registries_full')+function('reconcile_stale_fleet_registries')+"""
registry_meta_value() { sed -n "s/^$2=//p" "$1"; }
fleet_registry_cleanup_state() { printf reap; }
registry_owner_alive() { return 1; }
release_cleanup_disk_reserve() { echo FORBIDDEN; return 1; }
reconcile_stale_fleet_registries
rc=$?
printf 'rc=%s mutated=%s\n' "$rc" "$FLEET_STALE_RECONCILIATION_MAY_HAVE_MUTATED"
"""
            env={**os.environ,'POOL_REUSE_ONLY':'1','FLEET_OWNERSHIP_ROOT':td,'FLEET_REGISTRY_DIR':str(root/'current'),'FLEET_OWNER_HOST':'host','APP':'app'}
            result=subprocess.run(['bash','-c',script],env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr);self.assertNotIn('FORBIDDEN',result.stdout)
            self.assertIn('rc=0 mutated=0',result.stdout);self.assertEqual((meta.stat().st_ino,meta.read_bytes()),before)

    def test_retained_shared_claim_still_excludes_candidate(self):
        source=(REPO/'scripts/run-bench-fleet').read_text()
        def function(name):
            start=source.index(name+'() {');return source[start:source.index('\n}\n',start)+3]
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);claims=root/'claims';claims.mkdir();mid='abcdef12345678'
            claim=claims/mid;claim.write_text('host=other-host\nfleet_owner_token=old-owner\n');before=(claim.stat().st_ino,claim.read_bytes())
            (root/'pool.ids').write_text(mid+'\n');(root/'claimed.ids').touch();(root/'pool-shapes.tsv').write_text(mid+' shared 2 4096\n')
            script=function('reconcile_stale_fleet_registries_full')+function('reconcile_stale_fleet_registries')+'\n'+function('claim_pool_machine')+'''
registry_meta_value() { sed -n "s/^$2=//p" "$1"; }
pool_claim_cleanup_unconfirmed() { return 1; }
registry_owner_alive() { return 2; }
write_pool_claim() { echo FORBIDDEN; return 0; }
recover_one_exact_pool_claim() { echo FORBIDDEN; return 0; }
reconcile_stale_fleet_registries || exit 9
id="$(claim_pool_machine shared-cpu-2x 4096)" || exit 10
[ -z "$id" ] || exit 11
'''
            env={**os.environ,'POOL_REUSE_ONLY':'1','FLEET_DIR':td,'POOL_IDS_FILE':str(root/'pool.ids'),'POOL_CLAIMS_DIR':str(claims),'CLAIMED_POOL_FILE':str(root/'claimed.ids'),'GIT_COMMON_DIR':td,'PRIVATE_SOURCE_ID':'','FLEET_OWNER_HOST':'current-host'}
            p=subprocess.run(['bash','-c',script],env=env,capture_output=True,text=True)
            self.assertEqual(p.returncode,0,p.stderr);self.assertNotIn('FORBIDDEN',p.stdout+p.stderr)
            self.assertEqual((claim.stat().st_ino,claim.read_bytes()),before)



class ColdBootstrapSingleOwnerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.origin=self.root/'origin.git';self.source=self.root/'source';self.destination=self.root/'checkout'
        self.config=self.root/'gitconfig';self.config.write_text('')
        self.env={k:v for k,v in os.environ.items() if not k.startswith('CLOUDBENCH_')}
        self.env.update(GIT_CONFIG_GLOBAL=str(self.config),GIT_CONFIG_NOSYSTEM='1',CLOUDBENCH_GIT_MIN_FREE_KB='1',CLOUDBENCH_FRESH_VOLUME='1')
        self.git('init','--bare','-q',str(self.origin));self.git('init','-q',str(self.source))
        (self.source/'payload.txt').write_text('exact task source\n');self.git('-C',str(self.source),'add','payload.txt')
        self.git('-C',str(self.source),'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','task source')
        self.ref=self.git('-C',str(self.source),'rev-parse','HEAD').strip();self.git('-C',str(self.source),'push','-q',str(self.origin),'HEAD:main')
        self.git('config','--file',str(self.config),'url.file://'+str(self.origin)+'.insteadOf','https://github.com/Rose-Ai-Labs/rose.git')
    def git(self,*args):
        return subprocess.check_output(['git',*args],env=self.env,text=True,stderr=subprocess.DEVNULL)
    def invoke(self,cold=True):
        (self.root/'boot.log').touch() # actual boot publishes RUNSTAMP before this boundary
        boot=(ROOT/'cloudbench-boot.sh').read_text();a=boot.index('bootstrap_checkout_ref() {');b=boot.index('\n# Run the controller-injected driver',a)
        driver=(ROOT/'cloudbench-run.sh').read_text();c=driver.index('if [ "${CLOUDBENCH_COLD_PRIMARY_BOOTSTRAP:-0}" = 1 ] ||');d=driver.index('\nif [ ! -d "$REPO_DIR/.git" ]',c)
        e=driver.index('step git_sync');f=driver.index('\n# The controller credential',e)
        shell='''set -euo pipefail
log(){ printf '%s\\n' "$*"; }
finish(){ exit "$1"; }
step(){ :; }
'''+boot[a:b]+'\n'+driver[c:d]+'\n'+driver[e:f]
        env=dict(self.env,REPO=str(self.destination),REPO_DIR=str(self.destination),REF=self.ref,FETCH_REF_SCRIPT=str(ROOT/'cloudbench-fetch-ref.sh'),APP_USER='',BENCH_SIMULATE='0',LOG=str(self.root/'boot.log'),SHUTDOWN_REQUEST_FILE=str(self.root/'shutdown.request'),CLOUDBENCH_COLD_PRIMARY_BOOTSTRAP='1'if cold else'0')
        r=subprocess.run(['bash','-c',shell],env=env,text=True,capture_output=True,timeout=15)
        return r,(self.root/'boot.log').read_text()
    def test_cold_actual_boot_then_driver_has_one_empty_checkout_owner(self):
        r,log=self.invoke();self.assertEqual(r.returncode,0,r.stderr+'\n'+log+r.stdout)
        self.assertEqual(self.git('-C',str(self.destination),'rev-parse','HEAD').strip(),self.ref)
        self.assertEqual((log+r.stdout).count('[cloudbench] git-fetch '),1)
        self.assertIn('[cloudbench] already-at '+self.ref,log+r.stdout)
    def test_populated_cold_destination_still_refuses_without_rewriting(self):
        self.destination.mkdir();(self.destination/'preserve').write_text('prior data')
        r,log=self.invoke();self.assertNotEqual(r.returncode,0);self.assertIn('absent or empty unlinked destination',r.stdout+log)
        self.assertEqual((self.destination/'preserve').read_text(),'prior data');self.assertFalse((self.destination/'.git').exists())
    def test_warm_boot_prefetch_and_driver_verify_unchanged(self):
        r,log=self.invoke(cold=False);self.assertEqual(r.returncode,0,r.stderr+'\n'+log+r.stdout)
        self.assertIn('bootstrap-checkout '+self.ref,log);self.assertEqual((log+r.stdout).count('[cloudbench] git-fetch '),1)
        self.assertEqual(self.git('-C',str(self.destination),'rev-parse','HEAD').strip(),self.ref)
    def test_symlink_cold_destination_still_refuses(self):
        target=self.root/'kept';target.mkdir();(target/'preserve').write_text('prior data');self.destination.symlink_to(target,target_is_directory=True)
        r,log=self.invoke();self.assertNotEqual(r.returncode,0);self.assertIn('absent or empty unlinked destination',r.stdout+log)
        self.assertEqual((target/'preserve').read_text(),'prior data');self.assertFalse((target/'.git').exists())

@unittest.skipUnless(os.geteuid() == 0, 'root-owned overlay / UID1001 cleanup boundary')
class DependencyOverlayCleanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.root.chmod(0o755)
        self.repo = self.root / 'repo'; self.donor = self.root / 'donor'
        self.repo.mkdir(); self.donor.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        (self.repo / '.gitignore').write_text('node_modules/\nvenv/\n')
        subprocess.run(['git', '-C', str(self.repo), 'add', '.gitignore'], check=True)
        subprocess.run(['git', '-C', str(self.repo), '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], check=True)
        for path in [self.repo, *self.repo.rglob('*')]:
            os.chown(path, 1001, 1001)
        (self.repo / 'stale-task-output').write_text('remove me')
        nested = self.repo / 'unrelated' / '.cloudbench-deps-overlays'; nested.mkdir(parents=True)
        (nested / 'stale').write_text('remove nested lookalike')
        for path in [self.repo / 'unrelated', nested, nested / 'stale']:
            os.chown(path, 1001, 1001)
        (self.repo / 'node_modules').mkdir(); (self.donor / 'node_modules').mkdir()
        # Actual first-use producer; only the mount syscall is replaced locally.
        text = (ROOT / 'cloudbench-sync-deps.sh').read_text()
        import re
        functions = '\n'.join(re.search(r'^' + name + r'\(\).*?^}\n', text, re.M | re.S).group() for name in ('overlay_state_dir', 'mount_fresh_dependency_overlay'))
        shell = 'set -euo pipefail\n' + functions + '\nOVERLAY_TREES=(); REBUILD_DEPS=0\nmount(){ return 0; }\nmount_fresh_dependency_overlay "$DEPS_DIR/node_modules" "$REPO_DIR/node_modules"\n'
        result = subprocess.run(['bash', '-c', shell], env={**os.environ, 'DEPS_DIR': str(self.donor), 'REPO_DIR': str(self.repo)}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.cache = self.repo / '.cloudbench-deps-overlays'; self.state = self.cache / 'node_modules'
        (self.state / 'upper' / 'cached-package').write_text('preserve cached dependency')

    def clean(self):
        text = Path(os.environ.get('CLOUDBENCH_CLEAN_TEST_SOURCE', str(ROOT / 'cloudbench-run.sh'))).read_text()
        start = text.index('# reset --hard does not remove untracked files')
        end = text.index('log "checkout at ', start)
        shell = '''set -euo pipefail
APP_USER=1001
log(){ printf '%s\\n' "$*"; }
finish(){ exit "$1"; }
gosu(){ shift; python3 -c 'import os,sys;os.setgid(1001);os.setuid(1001);os.execvp(sys.argv[1],sys.argv[1:])' "$@"; }
''' + text[start:end]
        before = {str(p.relative_to(self.cache)): (p.read_bytes() if p.is_file() and not p.is_symlink() else None, p.lstat().st_uid, p.lstat().st_mode) for p in ([self.cache, *self.cache.rglob('*')] if self.cache.exists() else [])}
        result = subprocess.run(['bash', '-c', shell], env={**os.environ, 'REPO_DIR': str(self.repo), 'DEPS_DIR': str(self.donor), 'SYNC_DEPS_SCRIPT': str(ROOT / 'cloudbench-sync-deps.sh')}, capture_output=True, text=True)
        after = {str(p.relative_to(self.cache)): (p.read_bytes() if p.is_file() and not p.is_symlink() else None, p.lstat().st_uid, p.lstat().st_mode) for p in ([self.cache, *self.cache.rglob('*')] if self.cache.exists() else [])}
        self.assertEqual(before, after, 'cleanup must preserve cache bytes and ownership')
        return result

    def test_actual_overlay_producer_then_uid1001_clean(self):
        result = self.clean()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.repo / 'stale-task-output').exists())
        self.assertFalse((self.repo / 'unrelated').exists())
        self.assertEqual((self.state / 'upper' / 'cached-package').read_text(), 'preserve cached dependency')

    def test_wrong_owner_binding_refuses_before_clean(self):
        (self.state / 'owner').write_text(str(self.donor / 'other') + '\n' + str(self.repo / 'node_modules') + '\n')
        self.assertNotEqual(self.clean().returncode, 0)
        self.assertTrue((self.repo / 'stale-task-output').exists())

    def test_unknown_cache_entry_refuses_before_clean(self):
        (self.cache / 'arbitrary-task-files').mkdir()
        self.assertNotEqual(self.clean().returncode, 0)
        self.assertTrue((self.repo / 'stale-task-output').exists())

    def test_linked_state_refuses_before_clean(self):
        target = self.root / 'original-state'; self.state.rename(target); self.state.symlink_to(target, target_is_directory=True)
        self.assertNotEqual(self.clean().returncode, 0)
        self.assertTrue((self.repo / 'stale-task-output').exists())

    def test_cache_permissions_and_linked_owner_refuse(self):
        self.cache.chmod(0o755)
        self.assertNotEqual(self.clean().returncode, 0)
        self.cache.chmod(0o700)
        owner = self.state / 'owner'; copy = self.root / 'owner'; owner.rename(copy); owner.symlink_to(copy)
        self.assertNotEqual(self.clean().returncode, 0)
        self.assertTrue((self.repo / 'stale-task-output').exists())

    def test_no_cache_keeps_ordinary_untracked_cleanup(self):
        import shutil
        shutil.rmtree(self.cache)
        self.assertEqual(self.clean().returncode, 0)
        self.assertFalse((self.repo / 'stale-task-output').exists())
        self.assertFalse((self.repo / 'unrelated').exists())

    def test_tracked_cache_namespace_refuses(self):
        subprocess.run(['git', '-c', 'safe.directory=' + str(self.repo), '-C', str(self.repo), 'add', '-f', str(self.state / 'owner')], check=True)
        self.assertNotEqual(self.clean().returncode, 0)
        self.assertTrue((self.repo / 'stale-task-output').exists())


class SuiteShapeTests(unittest.TestCase):
    """Every case in this module runs exactly once, under the fixture that defines it.

    unittest collects inherited test_* methods again on every TestCase subclass. Before
    2026-10-28 three subclasses reused a parent fixture that way and re-ran 36 identical
    cases (a second 120 s export writer drain among them) on every /deploy. Fixtures that
    several suites share live in a plain mixin class (no test_* methods) instead.
    """
    def test_no_test_case_inherits_another_classes_cases(self):
        loader = unittest.TestLoader()
        inherited = []
        for cls in vars(sys.modules[__name__]).values():
            if not (isinstance(cls, type) and issubclass(cls, unittest.TestCase)):
                continue
            for name in loader.getTestCaseNames(cls):
                if name not in vars(cls):
                    owner = next(base.__name__ for base in cls.__mro__ if name in vars(base))
                    inherited.append(f"{cls.__name__}.{name} (defined on {owner})")
        self.assertEqual(inherited, [], "share the fixture through a mixin, not a TestCase subclass")


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from deploy_gate_shard import run_unittest_module

    run_unittest_module()
