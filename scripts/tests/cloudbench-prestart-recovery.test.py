#!/usr/bin/env python3
"""The prestart recovery must never infer a guest shutdown from a stopped VM."""

import importlib.util
import base64
import gzip
import hashlib
import http.server
import json
import os
import runpy
import re
import shlex
import shutil
import subprocess
import threading
import tempfile
import unittest
from unittest import mock
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "cloudbench-prestart-recovery.py"
SPEC = importlib.util.spec_from_file_location("cloudbench_prestart_recovery", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PrestartRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name).resolve()
        self.owner = "a" * 32
        self.run_id = "20260929-032004-9714"
        self.app = "navi-whisper-lux-bench"
        self.registry = root / "cloudbench-fleet-ownership" / self.owner
        self.audit_root = root / "cloudbench-fleet-audits"
        self.audit = self.audit_root / self.owner
        self.claims = root / "claims"
        self.run = root / "runs" / self.run_id
        self.inventory = root / "machines.json"
        for path in (
            self.registry / "clones",
            self.audit / "pool",
            self.audit / "fresh",
            self.audit / "expected-fresh",
            self.audit / "by-machine-id",
            self.claims,
            self.run / "_batch",
            self.run / ".boot-config-barrier" / "ready",
        ):
            path.mkdir(parents=True)
        (self.registry / "guest-cleanup-unconfirmed").write_text("")
        (self.registry / "meta").write_text(
            "version=2\n"
            f"app={self.app}\nfleet_owner_token={self.owner}\n"
            "host=3d8d023dc05d58\npid=9714\npid_start=unique-birth\n"
            f"run_id={self.run_id}\nruns_root={self.run.parent}\n"
            f"audit_dir={self.audit}\ncleanup_policy=retain\n"
        )
        (self.audit / "meta").write_text(f"fleet_owner_token={self.owner}\n")
        (self.audit / "owned-clones.ids").write_text("")
        (self.audit / "owned-clones.names").write_text("")
        self.machines = []
        self.mapping = [
            ("polar-one", "1" * 14, "vol_" + "1" * 16),
            ("polar-two", "2" * 14, "vol_" + "2" * 16),
        ]
        (self.run / "_batch" / "benches.json").write_text(
            json.dumps([{"name": name} for name, _, _ in self.mapping])
        )
        for index, (bench, machine, volume) in enumerate(self.mapping):
            output = self.run / bench
            output.mkdir()
            (output / ".cid").write_text(f"pool {machine}\n")
            (output / "worker-clones.ids").write_text("")
            runtime_owner = json.dumps(
                {"version": 1, "machine_id": machine, "run_token": f"{self.owner}-{index}"}
            )
            (output / "runtime-evidence.owner.json").write_text(runtime_owner)
            (output / "runtime-evidence.pending").write_text(runtime_owner)
            if index == 0:
                (output / "boot-config-unapplied").write_text(f"{machine}\n")
            else:
                (self.run / ".boot-config-barrier" / "ready" / machine).write_text("")
            (self.audit / "pool" / machine).write_text(
                f"fleet_owner_token={self.owner}\nrun_id={self.run_id}\n"
                f"app={self.app}\nsource=borrowed-pool\n"
                f"machine_id={machine}\nvolume_id={volume}\ndisposition=claimed\n"
            )
            (self.claims / machine).write_text(
                f"fleet_owner_token={self.owner}\nhost=3d8d023dc05d58\n"
                "pid=9714\npid_start=unique-birth\ncleanup_state=unconfirmed\n"
            )
            self.machines.append(
                {
                    "id": machine,
                    "state": "stopped",
                    "config": {"mounts": [{"volume": volume}]},
                }
            )
        self.write_inventory()

    def write_inventory(self):
        self.inventory.write_text(json.dumps(self.machines))

    def validate(self):
        return MODULE.validate(
            self.registry, self.audit_root, self.claims, self.inventory, self.app
        )

    def test_publishes_only_for_an_entire_unreleased_stopped_pool(self):
        receipts = self.validate()
        self.assertEqual(len(receipts), 2)
        MODULE.publish(receipts)
        MODULE.publish(self.validate())
        for path, payload in receipts:
            self.assertEqual(path.read_bytes(), payload)
            self.assertEqual(json.loads(payload)["kind"], "no-guest-start")

    def test_rejects_start_or_ambiguous_boot_proof(self):
        output = self.run / "polar-one"
        for path in (
            self.run / ".boot-config-barrier" / "release",
            output / "post-config-start.accepted",
            output / "status-proxy.port",
        ):
            path.write_text("1")
            with self.assertRaises(ValueError):
                self.validate()
            path.unlink()
        (output / "worker-clones.ids").write_text("worker-id\n")
        with self.assertRaises(ValueError):
            self.validate()
        (output / "worker-clones.ids").write_text("")
        (output / "boot-config-unapplied").unlink()
        with self.assertRaises(ValueError):
            self.validate()

    def test_rejects_wrong_host_state_or_volume(self):
        self.machines[0]["state"] = "started"
        self.write_inventory()
        with self.assertRaises(ValueError):
            self.validate()
        self.machines[0]["state"] = "stopped"
        self.machines[0]["config"]["mounts"][0]["volume"] = "vol_wrong"
        self.write_inventory()
        with self.assertRaises(ValueError):
            self.validate()


class FreshPrestartRecoveryTest(PrestartRecoveryTest):
    """Configured fresh allocations killed before the controller start barrier."""

    def setUp(self):
        super().setUp()
        self.scripts = SCRIPT.parent
        self.workspace = self.scripts.parent
        self.native = self.run.parent / "native"
        self.native.mkdir()
        meta = self.registry / "meta"
        meta.write_text(meta.read_text().replace("host=3d8d023dc05d58", "host=" + os.uname().nodename)
                        .replace("pid=9714", "pid=99999999")
                        .replace("pid_start=unique-birth", "pid_start=proc-start:00000000-0000-0000-0000-000000000001:1")
                        + f"workspace_root={self.workspace}\n")
        self.cancel = self.run.parent.parent / "cli.log.process.json"
        self.cancel.write_text(json.dumps({
            "supervisor_pid": 99999997, "child_pid": 99999998, "native_exit": -9,
            "cancelled": True, "timed_out": False, "quiescent": True,
            "orphaned_children": True, "remaining": [], "error": None,
            "reaped": [{"pid": 99999998, "status": 9}, {"pid": 99999999, "status": 9}],
            "term_sent": [99999998, 99999999], "kill_sent": [99999998, 99999999]}))
        (self.audit / "meta").write_text(
            f"fleet_owner_token={self.owner}\nrun_id={self.run_id}\napp={self.app}\n")
        for p in (self.audit / "pool").iterdir():
            p.unlink()
        for p in (self.run / ".boot-config-barrier/ready").iterdir():
            p.unlink()
        # Historical source protocol under test; newer protocols intentionally
        # require a separately reviewed no-start authority.
        self.sha = "2d4c45c0da9c56e7145b2f3df8114cc5b95b7bb3"
        provenance = runpy.run_path(str(self.scripts / "cloudbench_execution_provenance.py"))
        config = provenance["build_config"]("cloudbench-fleet-config-v1", ["boot_launch=1", "requested_boot_transport=config"])
        (self.run / "execution-provenance.json").write_text(json.dumps({
            "schema_version": "cloudbench-execution-provenance-v1", "base_sha": self.sha,
            "workspace_patch_sha256": "none", "controller_snapshot": {
                "schema_version": "cloudbench-controller-snapshot-v1", "sha256": "a" * 64}, "config": config}))
        for i, (bench, machine, volume) in enumerate(self.mapping):
            out = self.run / bench
            for name in ("worker-clones.ids", "runtime-evidence.pending", "runtime-evidence.owner.json", "boot-config-unapplied"):
                (out / name).unlink(missing_ok=True)
            (out / ".cid").write_text(f"clone {machine}\n")
            clone = "cloudbench-" + machine
            (self.registry / "clones" / clone).write_text(f"name={clone}\nid={machine}\nvolume_id={volume}\n")
            (self.audit / "fresh" / clone).write_text(
                f"version=1\nfleet_owner_token={self.owner}\nrun_id={self.run_id}\napp={self.app}\n"
                f"clone_name={clone}\nsource=fresh-clone\nsource_machine_id={'3' * 14}\n"
                f"machine_id={machine}\nvolume_id={volume}\ndisposition=owned\n")
            (self.audit / "expected-fresh" / clone).write_text(f"clone_name={clone}\nsource_machine_id={'3' * 14}\n")
            (self.audit / "by-machine-id" / machine).write_text(clone + "\n")
            (out / "primary.ids").write_text(machine + "\n")
            (out / "primary.names").write_text("")
            files = {"cloudbench-run.sh": base64.b64encode((self.scripts / "cloudbench-run.sh").read_bytes()).decode()}
            payload = gzip.compress(json.dumps({"version": 1, "files": files}).encode(), mtime=0)
            (out / "cloudbench-boot-payload.json.gz").write_bytes(payload)
            native = {"id": machine, "name": clone, "state": "stopped", "version": "generation-1",
                      "instance_id": "generation-1", "created_at": "2026-01-01T00:00:00Z",
                      "updated_at": "2026-01-01T00:00:03Z", "events": [
                          {"id": "event1", "type": "launch", "status": "pending", "source": "flyd", "timestamp": 1767225601000},
                          {"id": "event2", "type": "launch", "status": "created", "source": "user", "timestamp": 1767225602000},
                          {"id": "event3", "type": "update", "status": "stopped", "source": "flyd", "timestamp": 1767225603000}], "config": {
                          "init": {"cmd": ["bash", "/cloudbench-boot.sh"]}, "mounts": [{"volume": volume}],
                          "restart": {"policy": "no"}, "env": {"REF": self.sha, "CLOUDBENCH_BOOT": "1",
                              "CLOUDBENCH_RUN_TOKEN": f"{self.owner}-{i}", "CLOUDBENCH_START_BARRIER": self.run_id,
                              "CLOUDBENCH_BOOT_PAYLOAD_SHA256": hashlib.sha256(payload).hexdigest()},
                          "files": [{"guest_path": name, "raw_value": base64.b64encode(data).decode()}
                                    for name, data in [("/cloudbench-boot.sh", (self.scripts / "cloudbench-boot.sh").read_bytes()),
                                                       ("/cloudbench-boot-payload.json.gz", payload)]]}}
            for phase in ("before", "after"):
                (self.native / f"{machine}.{phase}.json").write_text(json.dumps(native))
                (self.native / f"{machine}.{phase}.events.json").write_text(json.dumps(native["events"]))

    def validate(self):
        if not hasattr(MODULE, "validate_fresh"):
            return super().validate()
        return MODULE.validate_fresh(self.registry, self.audit_root, self.native, self.scripts)

    def api_fixture(self):
        if hasattr(self, "api_server"):
            return self.api_shell
        fixture = self
        self.api_requests = []
        self.api_fault = None
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                fixture.api_requests.append((self.command, self.path))
                prefix = f"/v1/apps/{fixture.app}/machines/"
                if not self.path.startswith(prefix) or self.headers.get("Authorization") != "Bearer fixture-token":
                    self.send_error(403)
                    return
                parts = self.path[len(prefix):].split("/")
                if parts[0] not in {m for _, m, _ in fixture.mapping} or len(parts) > 2:
                    self.send_error(404)
                    return
                events = len(parts) == 2 and parts[1] == "events"
                path = fixture.native / f"{parts[0]}.before.{'events.json' if events else 'json'}"
                value = json.loads(path.read_text())
                if not events:
                    with (fixture.run / "native-reads").open("a") as stream:
                        stream.write(parts[0] + "\n")
                    if fixture.api_fault == "config-only":
                        value = value["config"]
                raw = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            def log_message(self, *args):
                pass
        self.api_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=lambda: self.api_server.serve_forever(poll_interval=0.01), daemon=True)
        thread.start()
        def close():
            self.api_server.shutdown()
            self.api_server.server_close()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
        self.addCleanup(close)
        binary_dir = self.native / "bin"
        binary_dir.mkdir()
        flyctl = binary_dir / "flyctl"
        flyctl.write_text("#!/bin/sh\nexit 99\n")
        flyctl.chmod(0o700)
        self.api_shell = (f'export FLY_API_TOKEN=fixture-token FLY_API_HOSTNAME=http://127.0.0.1:{self.api_server.server_port}\n'
                          f'export PATH={shlex.quote(str(binary_dir))}:"$PATH"\n')
        return self.api_shell

    # The inherited pool-specific tests remain with their owning fixture above.
    test_publishes_only_for_an_entire_unreleased_stopped_pool = None
    test_rejects_start_or_ambiguous_boot_proof = None
    test_rejects_wrong_host_state_or_volume = None

    def test_configured_fresh_cohort_preserves_originals_and_has_zero_credit(self):
        receipts = self.validate()
        MODULE.publish(receipts)
        self.assertEqual(MODULE.verify_fresh(self.registry, self.audit_root, self.scripts), {x[0] for x in self.mapping})
        for bench, _, _ in self.mapping:
            receipt = json.loads((self.run / bench / "guest-never-started.confirmed").read_text())
            self.assertEqual(receipt["proof_credit"], 0)
            for name in ("worker-clones.ids", "runtime-evidence.owner.json", "guest-shutdown.confirmed", "cloudbench-run.json"):
                self.assertFalse((self.run / bench / name).exists())

    def test_conflicting_native_and_cohort_evidence_refuses_without_publication(self):
        changes = [lambda: (self.run / ".boot-config-barrier/release").write_text(""),
                   lambda: (self.run / self.mapping[0][0] / "worker-clones.ids").write_text("worker"),
                   lambda: (self.run / self.mapping[0][0] / "post-config-start.accepted").write_text(self.mapping[0][1])]
        for change in changes:
            with self.subTest(change=change):
                change()
                with self.assertRaises(ValueError):
                    self.validate()
                for p in (self.run / ".boot-config-barrier/release", self.run / self.mapping[0][0] / "worker-clones.ids",
                          self.run / self.mapping[0][0] / "post-config-start.accepted"):
                    p.unlink(missing_ok=True)

    def consumer_script(self, after_producer=""):
        source = (self.scripts / "run-bench-fleet").read_text()
        def extract(name):
            start = source.index(name + "() {")
            offset, heredoc = start, None
            for line in source[start:].splitlines(keepends=True):
                if heredoc is not None:
                    if line.strip() == heredoc:
                        heredoc = None
                else:
                    match = re.search(r"(?<!<)<<-?(?!<)\s*(?:'([^']+)'|\"([^\"]+)\"|([A-Za-z_][A-Za-z0-9_]*))", line)
                    if match:
                        heredoc = next(x for x in match.groups() if x)
                    if line == "}\n":
                        return source[start:offset + len(line)]
                offset += len(line)
            raise AssertionError(name)
        names = ["fleet_registry_confirm_guest_teardown", "fleet_recovery_reconnect_guest_shutdowns",
                 "fleet_recovery_confirm_runtime_evidence"]
        if "fleet_recovery_confirm_fresh_prestart() {" in source:
            names.append("fleet_recovery_confirm_fresh_prestart")
        for name in ("fleet_prestart_machine_exact_read", "fleet_prestart_events_exact_read"):
            if name + "() {" in source:
                names.append(name)
        return f'''set -uo pipefail
{self.api_fixture()}
registry={shlex.quote(str(self.registry))}
FLEET_AUDIT_ROOT={shlex.quote(str(self.audit_root))}
CLOUDBENCH_SCRIPT_SNAPSHOT={shlex.quote(str(self.scripts))}
APP={self.app}; POOL_CLAIMS_DIR={shlex.quote(str(self.claims))}
FLEET_REGISTRY_DIR=""; FLEET_REGISTRY_PUBLISHED=0; KEEP_CLONES=0; RUN_ID=outer; CLOUDBENCH_BARRIER_TOKEN=outer
registry_meta_value() {{ sed -n "s/^$2=//p" "$1" | head -1; }}
cloudbench_fsync_directory() {{ return 0; }}
machine_config_exact_read() {{
  echo "$1" >> {shlex.quote(str(self.run / 'config-only-reads'))}
  python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["config"]))' {shlex.quote(str(self.native))}/"$1.before.json"
}}
fleet_prestart_events_exact_read() {{ cat {shlex.quote(str(self.native))}/"$1.before.events.json"; }}
fly_with_timeout() {{ echo FORBIDDEN-inventory-or-provider >&2; return 1; }}
fleet_registry_build_guest_recovery_plan() {{ return 1; }}
cleanup_stale_owner_recovery_proxies() {{ return 0; }}
{chr(10).join(extract(name) for name in names)}
fleet_recovery_reconnect_guest_shutdowns "$registry" || exit 71
{after_producer}
fleet_recovery_confirm_runtime_evidence "$registry" || exit 72
'''

    def test_canonical_caller_and_runtime_consumer_release_only_verified_latches(self):
        (self.registry / "runtime-evidence-unconfirmed").write_text("")
        result = subprocess.run(["bash", "-c", self.consumer_script()], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.registry / "guest-cleanup-unconfirmed").exists())
        self.assertFalse((self.registry / "runtime-evidence-unconfirmed").exists())
        self.assertIn("cleanup_policy=reap", (self.registry / "meta").read_text())
        self.assertEqual(sorted((self.run / "native-reads").read_text().splitlines()), sorted([m for _, m, _ in self.mapping] * 4))
        self.assertFalse((self.run / "config-only-reads").exists())
        for _, machine, _ in self.mapping:
            path = f"/v1/apps/{self.app}/machines/{machine}"
            self.assertEqual(self.api_requests.count(("GET", path)), 4)
            self.assertEqual(self.api_requests.count(("GET", path + "/events")), 4)
        for bench, _, _ in self.mapping:
            self.assertFalse((self.run / bench / "guest-shutdown.confirmed").exists())
            self.assertFalse((self.run / bench / "worker-clones.ids").exists())

    def test_config_only_wire_response_cannot_be_promoted_to_full_identity(self):
        script = self.consumer_script()
        self.api_fault = "config-only"
        (self.registry / "runtime-evidence-unconfirmed").write_text("")
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.registry / "guest-cleanup-unconfirmed").exists())
        self.assertTrue((self.registry / "runtime-evidence-unconfirmed").exists())
        self.assertFalse((self.run / "_batch/fresh-prestart-recovery.json").exists())

    def test_canonical_caller_keeps_latches_on_conflicting_native(self):
        (self.registry / "runtime-evidence-unconfirmed").write_text("")
        path = self.native / f"{self.mapping[1][1]}.before.json"
        value = json.loads(path.read_text())
        value["config"]["env"]["CLOUDBENCH_RUN_TOKEN"] = "foreign"
        path.write_text(json.dumps(value))
        result = subprocess.run(["bash", "-c", self.consumer_script()], capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.registry / "guest-cleanup-unconfirmed").exists())
        self.assertTrue((self.registry / "runtime-evidence-unconfirmed").exists())
        self.assertFalse((self.run / self.mapping[0][0] / "guest-never-started.confirmed").exists())

    def test_native_config_history_and_payload_inverses(self):
        machine = self.mapping[0][1]
        path = self.native / f"{machine}.before.json"
        original = path.read_bytes()
        for fault in ("running", "wrong-volume", "wrong-command", "foreign-token", "foreign-generation",
                      "autostart", "malformed-autostart", "prior-start", "event-source", "event-time",
                      "duplicate-event", "update-clock", "payload", "driver"):
            with self.subTest(fault=fault):
                native = json.loads(original)
                config = native["config"]
                if fault == "running": native["state"] = "started"
                if fault == "wrong-volume": config["mounts"][0]["volume"] = "vol_foreign"
                if fault == "wrong-command": config["init"]["cmd"] = ["sleep", "infinity"]
                if fault == "foreign-token": config["env"]["CLOUDBENCH_RUN_TOKEN"] = "foreign"
                if fault == "foreign-generation": native["instance_id"] = "foreign"
                if fault == "autostart": config["services"] = [{"auto_start_machines": True}]
                if fault == "malformed-autostart": config["services"] = [{"autostart": "false"}]
                if fault == "prior-start": native["events"].append({"type": "start", "status": "started"})
                if fault == "event-source": native["events"][1]["source"] = "foreign"
                if fault == "event-time": native["events"][0]["timestamp"] = float("nan")
                if fault == "duplicate-event": native["events"][1]["id"] = "event1"
                if fault == "update-clock": native["updated_at"] = "2026-01-01T00:01:00Z"
                if fault == "payload": config["files"][1]["raw_value"] = base64.b64encode(b"foreign").decode()
                if fault == "driver": config["files"][0]["raw_value"] = base64.b64encode(b"foreign").decode()
                for phase in ("before", "after"):
                    (self.native / f"{machine}.{phase}.json").write_text(json.dumps(native))
                    (self.native / f"{machine}.{phase}.events.json").write_text(json.dumps(native["events"]))
                with self.assertRaises((ValueError, KeyError)):
                    self.validate()
                self.assertFalse((self.run / "_batch" / "fresh-prestart-recovery.json").exists())
        for phase in ("before", "after"):
            (self.native / f"{machine}.{phase}.json").write_bytes(original)
            (self.native / f"{machine}.{phase}.events.json").write_text(json.dumps(json.loads(original)["events"]))

    def test_partial_publication_and_post_guest_transition_reverify(self):
        receipts = self.validate()
        MODULE.publish(receipts[:2])
        with self.assertRaises((ValueError, FileNotFoundError)):
            MODULE.verify_fresh(self.registry, self.audit_root, self.scripts)
        self.assertTrue((self.registry / "guest-cleanup-unconfirmed").exists())
        MODULE.publish(self.validate())
        meta = self.registry / "meta"
        meta.write_text(meta.read_text().replace("cleanup_policy=retain", "cleanup_policy=reap"))
        (self.registry / "guest-cleanup-unconfirmed").unlink()
        self.assertEqual(MODULE.verify_fresh(self.registry, self.audit_root, self.scripts), {x[0] for x in self.mapping})
        # A sealed receipt is not authority for changed original bytes.
        (self.run / self.mapping[0][0] / "cloudbench-boot-payload.json.gz").write_bytes(b"foreign")
        with self.assertRaises(ValueError):
            MODULE.verify_fresh(self.registry, self.audit_root, self.scripts)

    def test_live_owner_foreign_worker_and_linked_original_refuse(self):
        meta = self.registry / "meta"
        original = meta.read_bytes()
        meta.write_text(meta.read_text().replace("pid=99999999", f"pid={os.getpid()}"))
        with self.assertRaises(ValueError): self.validate()
        meta.write_bytes(original)
        extra = self.audit / "fresh" / "cloudbench-worker"
        extra.write_text("machine_id=" + "9" * 14 + "\n")
        with self.assertRaises(ValueError): self.validate()
        extra.unlink()
        payload = self.run / self.mapping[0][0] / "cloudbench-boot-payload.json.gz"
        saved = payload.with_suffix(".saved")
        payload.rename(saved)
        payload.symlink_to(saved)
        with self.assertRaises(ValueError): self.validate()

    def test_complete_history_read_is_required(self):
        path = self.native / f"{self.mapping[0][1]}.after.events.json"
        path.write_text("[]")
        with self.assertRaises(ValueError): self.validate()

    def test_source_change_outside_previous_critical_blocks_refuses(self):
        original = MODULE.subprocess.check_output
        def changed(*args, **kwargs):
            data = original(*args, **kwargs)
            if args[0][-1].endswith(":scripts/run-bench-fleet"):
                return data + b"\n# an unreviewed extra startup path outside the old matching blocks\n"
            return data
        with mock.patch.object(MODULE.subprocess, "check_output", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "full historical startup protocol"):
                self.validate()
        self.assertTrue((self.registry / "guest-cleanup-unconfirmed").exists())
        self.assertFalse((self.run / "_batch/fresh-prestart-recovery.json").exists())

    def test_runtime_consumer_keeps_latch_if_native_drifts_after_producer(self):
        (self.registry / "runtime-evidence-unconfirmed").write_text("")
        machine = self.mapping[0][1]
        before = self.native / f"{machine}.before.json"
        mutation = f'''python3 - {shlex.quote(str(before))} <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1]); value = json.loads(p.read_text()); value['state'] = 'started'; p.write_text(json.dumps(value))
PY'''
        result = subprocess.run(["bash", "-c", self.consumer_script(mutation)], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 72, result.stdout + result.stderr)
        self.assertTrue((self.registry / "runtime-evidence-unconfirmed").exists())
        self.assertFalse((self.registry / "guest-cleanup-unconfirmed").exists())

    def test_reaper_fence_rejects_started_or_reconfigured_machine_after_seal(self):
        MODULE.publish(self.validate())
        machine = self.mapping[0][1]
        MODULE.verify_fresh_machine(self.registry, machine, self.native, self.scripts)
        for field in ("state", "version"):
            path = self.native / f"{machine}.after.json"
            original = path.read_bytes()
            value = json.loads(original)
            value[field] = "changed"
            path.write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                MODULE.verify_fresh_machine(self.registry, machine, self.native, self.scripts)
            path.write_bytes(original)

    def test_canonical_reaper_refuses_changed_machine_before_provider_mutation(self):
        MODULE.publish(self.validate())
        bench, machine, volume = self.mapping[0]
        native_path = self.native / f"{machine}.before.json"
        changed = json.loads(native_path.read_text())
        changed["state"] = "started"
        native_path.write_text(json.dumps(changed))
        source = Path(os.environ.get("FRESH_PRESTART_REAPER_SOURCE", self.scripts / "run-bench-fleet")).read_text()
        def simple_function(name):
            start = source.index(name + "() {")
            return source[start:source.index("\n}\n", start) + 3]
        guard = simple_function("fleet_fresh_prestart_reap_guard") if "fleet_fresh_prestart_reap_guard() {" in source else ""
        readers = "\n".join(simple_function(name) for name in ("fleet_prestart_machine_exact_read", "fleet_prestart_events_exact_read")
                            if name + "() {" in source)
        clone = "cloudbench-" + machine
        touched = self.run / "forbidden-provider-mutation"
        script = f'''set -uo pipefail
{self.api_fixture()}
APP={self.app}
registry={shlex.quote(str(self.registry))}
CLOUDBENCH_SCRIPT_SNAPSHOT={shlex.quote(str(self.scripts))}
FLEET_AUDIT_ROOT={shlex.quote(str(self.audit_root))}
registry_meta_value() {{ sed -n "s/^$2=//p" "$1" | head -1; }}
registry_machine_details() {{ echo 'started {clone} fdaa::1'; }}
fleet_registry_reconcile_mounted_volume() {{ echo {volume}; }}
reap_machine() {{ touch {shlex.quote(str(touched))}; }}
fleet_audit_update_registry_clone() {{ return 0; }}
machine_config_exact_read() {{ cat {shlex.quote(str(native_path))}; }}
fleet_prestart_events_exact_read() {{ cat {shlex.quote(str(self.native / (machine + '.before.events.json')))}; }}
{readers}
{guard}
{simple_function('fleet_reap_registry_record_native')}
fleet_reap_registry_record_native "$registry" forced 2 0 "$registry/clones/{clone}"
'''
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=20)
        self.assertFalse(touched.exists(), result.stdout + result.stderr)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.registry / "clones" / clone).exists())

    def test_post_release_verifier_needs_real_final_audit_and_unchanged_originals(self):
        MODULE.publish(self.validate())
        with self.assertRaisesRegex(ValueError, "not been released"):
            MODULE.verify_released_fresh(self.audit, self.run, self.scripts)
        shutil.rmtree(self.registry)  # fixture simulates canonical final registry consumption
        with self.assertRaisesRegex(ValueError, "canonical final audit"):
            MODULE.verify_released_fresh(self.audit, self.run, self.scripts)
        with (self.audit / "meta").open("a") as stream:
            stream.write("status=provider-teardown-verified\n")
        (self.audit / "provider-teardown-verified.epoch").write_text("1767225604\n")
        for row in (self.audit / "fresh").iterdir():
            row.write_text(row.read_text().replace("disposition=owned", "disposition=destroyed-provider-retained"))
        # Canonical final audits retain the historical allocation ledgers.
        # Their contents are evidence, not still-live ownership.
        expected_ids = [machine for _, machine, _ in self.mapping]
        expected_names = ["cloudbench-" + machine for machine in expected_ids]
        (self.audit / "owned-clones.ids").write_text("\n".join(reversed(expected_ids)) + "\n")
        (self.audit / "owned-clones.names").write_text("\n".join(expected_names) + "\n")
        result = MODULE.verify_released_fresh(self.audit, self.run, self.scripts)
        self.assertTrue(result["provider_teardown_verified"])
        self.assertEqual(result["proof_credit"], 0)
        self.assertEqual(len(result["machine_ids"]), 2)
        for name, expected in (("owned-clones.ids", expected_ids), ("owned-clones.names", expected_names)):
            original = (self.audit / name).read_bytes()
            for broken in ([], expected[:1], expected + expected[:1], expected + ["foreign"], ["foreign", *expected[1:]]):
                with self.subTest(ledger=name, broken=broken):
                    (self.audit / name).write_text("\n".join(broken) + ("\n" if broken else ""))
                    with self.assertRaisesRegex(ValueError, "historical allocation ledger"):
                        MODULE.verify_released_fresh(self.audit, self.run, self.scripts)
            (self.audit / name).write_bytes(original)

    def test_missing_original_cancel_is_not_positive_no_execution_proof(self):
        self.cancel.unlink()
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.validate()

    def test_borrowed_worker_channel_cannot_hide_behind_missing_ledger(self):
        out = self.run / self.mapping[0][0]
        borrowed = out / "worker-borrowed"
        borrowed.mkdir()
        (borrowed / ("9" * 14 + ".json")).write_text(json.dumps({"fleet_owner_token": self.owner}))
        with self.assertRaises(ValueError):
            self.validate()

    def test_canonical_consumer_retains_both_latches_without_cancel(self):
        self.cancel.unlink()
        (self.registry / "runtime-evidence-unconfirmed").write_text("")
        result = subprocess.run(["bash", "-c", self.consumer_script()], capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.registry / "guest-cleanup-unconfirmed").exists())
        self.assertTrue((self.registry / "runtime-evidence-unconfirmed").exists())

    def test_cancellation_identity_waits_and_quiescence_refuse_mutations(self):
        original = self.cancel.read_bytes()
        for fault in ("not-cancelled", "not-quiescent", "remaining", "unjoined-owner", "unjoined-child",
                      "duplicate-wait", "unsignalled-owner", "foreign-kill", "wrong-native-exit"):
            with self.subTest(fault=fault):
                value = json.loads(original)
                if fault == "not-cancelled": value["cancelled"] = False
                if fault == "not-quiescent": value["quiescent"] = False
                if fault == "remaining": value["remaining"] = [99999999]
                if fault == "unjoined-owner": value["reaped"] = value["reaped"][:1]
                if fault == "unjoined-child": value["reaped"] = value["reaped"][1:]
                if fault == "duplicate-wait": value["reaped"].append(value["reaped"][0])
                if fault == "unsignalled-owner": value["term_sent"] = [99999998]; value["kill_sent"] = [99999998]
                if fault == "foreign-kill": value["kill_sent"].append(99999996)
                if fault == "wrong-native-exit": value["native_exit"] = 0
                self.cancel.write_text(json.dumps(value))
                with self.assertRaises(ValueError): self.validate()
                self.assertTrue((self.registry / "guest-cleanup-unconfirmed").exists())
        self.cancel.write_bytes(original)

    def test_shared_worker_claim_with_different_token_still_binds_owner_birth(self):
        claims = self.audit_root.parent / "cloudbench-pool-claims"
        claims.mkdir()
        meta = MODULE.fields(self.registry / "meta")
        (claims / ("9" * 14)).write_text(
            f"fleet_owner_token={'9' * 32}\nhost={meta['host']}\npid={meta['pid']}\npid_start={meta['pid_start']}\n")
        with self.assertRaisesRegex(ValueError, "shared worker ownership"):
            self.validate()

    def test_imported_worker_and_accepted_result_refuse_the_fresh_phase(self):
        out = self.run / self.mapping[0][0]
        result = out / "cloudbench-run.json"
        result.write_text('{"status":"PASS"}')
        with self.assertRaises(ValueError): self.validate()
        result.unlink()
        imported = self.audit_root.parent / "cloudbench-worker-reuse/imported"
        imported.mkdir(parents=True)
        (imported / ("9" * 14 + ".json")).write_text(json.dumps({"target": {"run_token": self.owner + "-0"}}))
        with self.assertRaisesRegex(ValueError, "shared worker ownership"):
            self.validate()


if __name__ == "__main__":
    unittest.main()
