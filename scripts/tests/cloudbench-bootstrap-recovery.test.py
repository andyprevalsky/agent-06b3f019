#!/usr/bin/env python3
"""Exact fresh infra bootstrap cancellation: no services or provider allocation."""

import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
OWNER, MACHINE, VOLUME = "a" * 32, "b" * 14, "vol_bootstrap123"
RUN, BENCH, APP = "20261006-bootstrap", "browser-event-ticket", "navi-whisper-lux-bench"
TOKEN, CLONE = OWNER + "-0", "cloudbench-bootstrap123"
REF = "e33e3c94e285c5665f77b198c25e7bca3f1ac9c6"
# Frozen native source attestation; fresh/shallow clones need no historical Git object.
SOURCE_HASHES = {
    "back-end/package.json": "2b466d4362ccb48ae00a7d3f043ce49f3ed423a27c7bcbe6a207b7c3da72d2d1",
    "back-end/scripts/apply-local-workflow-ddl.sh": "b349eb7350578aca283969360749e094b6f78b4b64b9707d74ac13ab47d96f36",
    "back-end/scripts/ensure-agent-network-grep-indexes.ts": "653de4f229b9ea3bb71f8f6d2cc5de113d63e37e85899efb239f559d42edd709",
    "back-end/scripts/ensure-fast-mode-cache-schema.ts": "085230371c95de56845ceb3bd4eef4948144cfab31231d4e06ac527320463f8f",
    "front-end/package.json": "ac5d4c244d39877641ed9753cb18511ba958df94d0887d574ca189207c75a3c1",
    "package.json": "fd89d0959d0217634caa3ea4757ff1bd5a040d602fd86b727574621663a2a219",
    "scripts/cloudbench-guest-recovery.py": "d5c0a36d9eb903998fa156ee0d22fa78c8cdedba73d0798d28fc6613c890905b",
    "scripts/cloudbench-run.sh": "65adbd867513b8490a000ac7de2c4609f8db19e87b248e2439a0217e5271d5de",
    "scripts/cloudbench-status-server.py": "621c4e89cb2088ebe1665c13f08b7f0c60ea88fc0c8bf421e89ed8024a75815a",
    "scripts/ensure-workspace-dependencies.sh": "c5c13af190c43ec8dc88f743ed481c8c1121ad390c68bdfa9e98b89eb3970cb1",
    "scripts/lib/fast-mode-cache-schema.sh": "c1d581f0f2682894a8999d15a79953464f0c074a407bc013319ac71a3dd0412e",
    "scripts/lib/local-pg-image.sh": "a5a3b3f57eaa4fc2fe1c2a32b65c830bd2a4d619bc2ec040608e2d02b23bb889",
    "scripts/lib/ngrok-tunnel.sh": "d53a51a4e43e956ccd36f997fcfa15ffef2bcb9d33e3533e8c1673eda11e561e",
    "scripts/lib/run-context.sh": "0be5db39d87319d11e3d2afc4ccea97581f46754021bee0f3020939788a0d22a",
    "scripts/lib/run-process-cleanup.sh": "58cf9e3bd4fc1539f7193a9297936eb8be28e37a277b9fa5855e3758321e6bac",
    "scripts/lib/run-service-readiness.sh": "3b8a264ea7a785219faea9fcd1cf2ab37a53060a37951f95d4c0a00688d819b6",
    "scripts/lib/seed-cache.sh": "87a4b83a73c58f67513b2e3402eeb27005a7c9bf7ef78dae039aa4161244e65e",
    "scripts/lib/workspace-env.sh": "ea649a1212dab724c16f3da995c796ff099caa5dabbcb106c6a359260b5bc9d2",
    "scripts/run-bench-cloud": "4cbd3fd90c267a2669d1127b1d1eef5c3e858b5851739beb43584f04990d5cdc",
    "scripts/run-bench-fleet": "a4e239d6b5b57dab87f15ef2a2aed07950f0b41115e64a75119b67eda9b2f0d6",
    "scripts/run.sh": "32bd4e5d16c94e31e89ecc39e8da0fb04cf0d1d10d924bb7d0803828b743027e",
}

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
