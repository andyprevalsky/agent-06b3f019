#!/usr/bin/env python3
"""Offline archive ownership plan + actual once-only canonical stop semantics."""
import copy
import ast
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
S=runpy.run_path(os.environ.get('CLOUDBENCH_TEST_ARCHIVED_STOP_MODULE',str(ROOT/'scripts/cloudbench-archived-owner-stop.py')))


def write(path,value):
    path.write_text(json.dumps(value));path.chmod(0o600)
    return path


class LeasedFixture:
    def __init__(self,api,journal):self.api=api;self.held=False
    @contextmanager
    def lease(self,mid):
        self.held=True
        try:yield
        finally:self.held=False
    def request(self,method,path,body=None):
        assert self.held, 'native operation outside exclusive lease'
        return self.api.api(method,path,body)


class ArchivedStop(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.run=self.root/'run';self.run.mkdir(mode=0o700)
        export=self.run/'export';export.mkdir(mode=0o700)
        self.out=self.root/'stops';self.out.mkdir(mode=0o700)
        self.mid='aaaabbbbccccdd';host='11112222333344';ref='a'*40;token='b'*32
        self.row=dict(id=self.mid,name='cloudbench-exact',instance_id='native-instance',created_at='original-created',state='started',
                      config=dict(mounts=[dict(volume='vol_owned',path='/data')],env=dict(FIXTURE='original')))
        protected=['0000000000000'+str(i) for i in range(4)]
        self.inventory=write(self.root/'inventory.json',[self.row]+[dict(id=x,state='started') for x in protected])
        authority=write(self.run/'authority.private.json',dict(app='navi-whisper-lux-bench',source_ref=ref,
                        protected_machines=protected,protected_volumes=['vol_protected']))
        record=dict(app='navi-whisper-lux-bench',host=host,machine_id=host,source_ref=ref)
        write(export/'launch.json',record);write(export/'caller.json',dict(original=True))
        prefix='git-common/cloudbench-fleet-ownership/'+token
        members={prefix+'/meta':f'host={host}\napp=navi-whisper-lux-bench\nfleet_owner_token={token}\ncleanup_policy=retain\n'.encode(),
                 prefix+'/clones/cloudbench-exact':f'name=cloudbench-exact\nid={self.mid}\nvolume_id=vol_owned\n'.encode(),
                 prefix+'/clones/unsealed':b'name=unsealed\n',
                 'context/original600-supervisor.token.terminal.json':json.dumps(dict(machine=host,source_ref=ref,supervisor_joined=True,parent_joined=True)).encode()}
        files={}
        with tarfile.open(export/'originals.tar.gz','w:gz') as t:
            for name,data in members.items():
                info=tarfile.TarInfo(name);info.size=len(data);t.addfile(info,io.BytesIO(data))
                files[name]=dict(kind='file',bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
        (export/'originals.tar.gz').chmod(0o600)
        write(export/'manifest.json',dict(version=1,resource_release_verified=False,record=record,files=files,
                                         archive_sha256=S['digest_file'](export/'originals.tar.gz')))
        write(export/'disposable-export.verified.json',dict(machine_id=host,authority_sha256=S['digest_file'](authority),
              files={name:S['digest_file'](export/name) for name in ['caller.json','launch.json','manifest.json','originals.tar.gz']}))
        write(self.run/'cleanup-call.intent.json',dict(gate_joined=True,supervisor_joined=True,machine=host,
              export_verified_file=S['digest_file'](export/'disposable-export.verified.json')))
        write(self.run/'terminal.json',dict(status='CONTROLLER_RELEASE_VERIFIED',machine=host,source_ref=ref,release=dict(machine_deleted=True)))

    def reseal(self, members):
        export = self.run / "export"
        manifest = json.loads((export / "manifest.json").read_text())
        files = {}
        with tarfile.open(export / "originals.tar.gz", "w:gz") as archive:
            for name, data in members.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
                files[name] = {
                    "kind": "file",
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
        manifest.update(
            files=files, archive_sha256=S["digest_file"](export / "originals.tar.gz")
        )
        write(export / "manifest.json", manifest)
        verified = json.loads((export / "disposable-export.verified.json").read_text())
        verified["files"] = {
            name: S["digest_file"](export / name) for name in verified["files"]
        }
        write(export / "disposable-export.verified.json", verified)
        intent = json.loads((self.run / "cleanup-call.intent.json").read_text())
        intent["export_verified_file"] = S["digest_file"](
            export / "disposable-export.verified.json"
        )
        write(self.run / "cleanup-call.intent.json", intent)

    def startup_fixture(self):
        export = self.run / "export"
        journal = self.run / "startup-finalization"
        journal.mkdir(mode=0o700)
        source = S["historical_source"](
            S["STARTUP_OPERATOR"], "cloudbench-startup-finalization.py"
        )
        step = ast.literal_eval(
            next(
                n.value
                for n in ast.parse(source).body
                if isinstance(n, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == "STEP" for t in n.targets)
            )
        )
        public = S["historical_source"](
            S["STARTUP_SOURCE"], "run-original600-controller.py"
        )
        names = ast.literal_eval(
            next(
                n.value
                for n in ast.parse(public).body
                if isinstance(n, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == "PINS" for t in n.targets)
            )
        )
        hashes = {
            name: S["sha"](S["historical_source"](S["STARTUP_SOURCE"], name))
            for name in names
        }
        config_path = self.root / "config.private.json"
        config = dict(
            source_ref=S["STARTUP_SOURCE"],
            source_root="/recorded/old",
            source_files=hashes,
            started_at_epoch=1000000000,
        )
        write(config_path, config)
        caller = dict(
            pid=10,
            birth="caller-birth",
            gate_pid=11,
            gate_birth="gate-birth",
            epoch=config["started_at_epoch"],
            deadline=config["started_at_epoch"] + 5400,
            source_ref=S["STARTUP_SOURCE"],
            identity_path="/tmp/gate/repo/.context/original600-supervisor.fixture.json",
        )
        auth = json.loads((self.run / "authority.private.json").read_text())
        auth.update(
            source_ref=S["STARTUP_SOURCE"],
            cleanup_owner_pid=10,
            cleanup_owner_birth="caller-birth",
            output_directory=str(export),
        )
        write(self.run / "authority.private.json", auth)
        caller["authority_sha256"] = S["digest_file"](
            self.run / "authority.private.json"
        )
        write(self.run / "caller.json", caller)
        owner = dict(pid=10, birth="caller-birth", argv=["original-caller"])
        write(
            self.run / "threshold-owner.identity.private.json",
            dict(
                caller=caller, owner=owner, config_sha256=S["digest_file"](config_path)
            ),
        )
        record = json.loads((export / "launch.json").read_text())
        record.update(
            source_ref=S["STARTUP_SOURCE"], caller=dict(pid=11, birth="gate-birth")
        )
        write(export / "launch.json", record)
        write(export / "caller.json", record["caller"])
        manifest = json.loads((export / "manifest.json").read_text())
        manifest["record"] = record
        write(export / "manifest.json", manifest)
        verified = json.loads((export / "disposable-export.verified.json").read_text())
        verified["authority_sha256"] = caller["authority_sha256"]
        write(export / "disposable-export.verified.json", verified)
        members = {"controller-output/step-1.log": step}
        self.reseal(members)
        manifest = json.loads((export / "manifest.json").read_text())
        write(
            export / "workspace-volume.ownership.json", dict(volume_id="vol_workspace")
        )
        release = dict(
            machine_id=record["machine_id"],
            machine_deleted=True,
            volume_id="vol_workspace",
            volume_disposition="pending_destroy",
        )
        write(export / "disposable-controller.release.json", release)
        write(self.run / "gate.private.log", dict(original="gate-output"))
        remote = write(self.root / "remote.private.log", dict(original="remote-output"))
        operator_names = {
            "cloudbench-startup-finalization.py",
            "cloudbench-controller-payload-finalization.py",
            "cloudbench-resume-controller-payload.py",
            "cloudbench-original600-runner.py",
            "cloudbench-original-volume-capture.py",
            "run-original600-controller.py",
        }
        operator = dict(
            operator_ref=S["STARTUP_OPERATOR"],
            operator_hashes={
                n: S["sha"](S["historical_source"](S["STARTUP_OPERATOR"], n))
                for n in operator_names
            },
            operator_pins={
                "/recorded/operator/scripts/cloudbench-startup-finalization.py": [
                    1,
                    2,
                    3,
                    4,
                    5,
                ]
            },
            owner=owner,
        )
        write(journal / "intent.json", operator)
        proof = dict(
            schema="expired-before-supervisor-proof-v1",
            source_ref=S["STARTUP_SOURCE"],
            config_path=str(config_path),
            config_sha256=S["digest_file"](config_path),
            source_root=config["source_root"],
            caller=caller,
            operator_ref=S["STARTUP_OPERATOR"],
            operator_pins=operator["operator_pins"],
            caller_sha256=S["digest_file"](self.run / "caller.json"),
            owner_capture_sha256=S["digest_file"](
                self.run / "threshold-owner.identity.private.json"
            ),
            authority_sha256=caller["authority_sha256"],
            started_at_epoch=caller["epoch"],
            original_deadline=caller["deadline"],
            supervisor_published=False,
            supervisor_joined=False,
            gate_reap="OBSERVED_ORIGINAL_PARENT_REAP",
            step1_sha256=S["sha"](step),
            export_marker_sha256=S["digest_file"](
                export / "disposable-export.verified.json"
            ),
            archive_sha256=manifest["archive_sha256"],
            manifest_sha256=S["digest_file"](export / "manifest.json"),
            launch_sha256=S["digest_file"](export / "launch.json"),
            gate_log_sha256=S["digest_file"](self.run / "gate.private.log"),
            remote_gate_log_path=str(remote),
            remote_gate_log_sha256=S["digest_file"](remote),
        )
        write(journal / "failure-proof.json", proof)
        proof_sha = S["digest_file"](journal / "failure-proof.json")
        closure = dict(
            action="cleanup",
            machine=record["machine_id"],
            gate_joined=True,
            supervisor_published=False,
            supervisor_joined=False,
            failure_proof_path=str(journal / "failure-proof.json"),
            failure_proof_sha256=proof_sha,
            export_verified_file=proof["export_marker_sha256"],
        )
        write(self.run / "cleanup-call.intent.json", closure)
        terminal = dict(
            status="FAILED_BEFORE_SUPERVISOR",
            source_ref=S["STARTUP_SOURCE"],
            machine=record["machine_id"],
            started_at_epoch=caller["epoch"],
            original_deadline=caller["deadline"],
            supervisor_published=False,
            supervisor_joined=False,
            gate_reap=proof["gate_reap"],
            failure_proof_path=closure["failure_proof_path"],
            failure_proof_sha256=proof_sha,
            finalizer_operator_ref=S["STARTUP_OPERATOR"],
            controller_cleanup_exit_code=0,
            release=release,
            caller_disposition="EXITED_PIDFD_OBSERVED_NOT_OWNED_JOIN",
            benchmark_success_inferred=False,
        )
        write(self.run / "terminal.json", terminal)
        write(journal / "complete.json", terminal)
        write(
            journal / "cleanup.joined.json",
            dict(exit_code=0, owned_join=True, cancelled_signals=[]),
        )
        write(journal / "release.verified.json", release)
        return members

    def startup_continuation_fixture(self):
        members = self.startup_fixture()
        old = self.run / "startup-finalization"
        new = self.run / "startup-release-observation"
        new.mkdir(mode=0o700)
        for name in ("complete.json", "release.verified.json"):
            (old / name).unlink()
        for name in ("cleanup.intent.json", "cleanup.child.json"):
            write(old / name, {"original": name})
        (old / "cleanup.log").write_bytes(b"original cleanup output")
        (old / "cleanup.log").chmod(0o600)
        terminal = json.loads((self.run / "terminal.json").read_text())
        machine = dict(
            id=terminal["machine"],
            instance_id="original-native",
            config={"unchanged": True},
            name="original-controller",
            region="iad",
        )
        write(
            self.run / "export/disposable-controller.ownership.json",
            {"machine": machine},
        )

        def wire(directory, n, path, value, status=200):
            body = json.dumps(value).encode()
            write(
                directory / f"wire-{n:06d}.request.json",
                {"method": "GET", "path": path, "body": None},
            )
            write(
                directory / f"wire-{n:06d}.raw.json",
                {
                    "method": "GET",
                    "path": path,
                    "status": status,
                    "bytes": len(body),
                    "sha256": S["sha"](body),
                    "body_b64": base64.b64encode(body).decode(),
                },
            )
            if status == 200:
                write(directory / f"wire-{n:06d}.decoded.json", value)

        path = "/machines/" + machine["id"]
        wire(old, 1, path, machine)
        wire(old, 2, path, dict(machine, state="destroyed"))
        wire(new, 1, path, dict(machine, state="destroyed"))
        wire(
            new,
            2,
            "/volumes/vol_workspace",
            {"id": "vol_workspace", "state": "pending_destroy"},
        )
        proof = json.loads((old / "failure-proof.json").read_text())
        operator = json.loads((old / "intent.json").read_text())
        prior = dict(
            files={p.name: S["sha"](p.read_bytes()) for p in old.iterdir()},
            operator_ref=S["STARTUP_OPERATOR"],
            proof=proof,
            source_root="/recorded/operator",
            operator_hashes=operator["operator_hashes"],
        )
        ref = "e3595737a0292e4b6ee494e6d120b0ecb381c3e1"
        write(
            new / "intent.json",
            dict(
                operator_ref=ref,
                operator_pins={"/recorded/new/scripts/" + name: [1, 2, 3] for name in operator["operator_hashes"]},
                prior=prior,
                no_effect_replay=True,
            ),
        )
        write(
            new / "SIGTERM.intent.json",
            dict(
                pid=proof["caller"]["pid"],
                birth=proof["caller"]["birth"],
                signal="SIGTERM",
                resources_release_verified=True,
            ),
        )
        terminal.update(
            finalizer_operator_ref=ref,
            prior_finalizer_operator_ref=S["STARTUP_OPERATOR"],
            no_effect_replay=True,
        )
        write(self.run / "terminal.json", terminal)
        write(new / "complete.json", terminal)
        return members

    def test_startup_release_continuation_preserves_failed_journal_and_checks_raw_gets(
        self,
    ):
        self.startup_continuation_fixture()
        old = self.run / "startup-finalization"
        before = {p.name: p.read_bytes() for p in old.iterdir()}
        plan = S["prepare"](self.run, self.inventory)
        self.assertEqual(plan["targets"], [])
        self.assertFalse(plan["startup_closure"]["supervisor_joined"])
        self.assertEqual(before, {p.name: p.read_bytes() for p in old.iterdir()})
        path = self.run / "startup-release-observation/wire-000001.request.json"
        write(path, dict(method="POST", path="/machines/11112222333344", body=None))
        with self.assertRaisesRegex(ValueError, "raw GET differs"):
            S["prepare"](self.run, self.inventory)

    def test_expired_before_supervisor_is_typed_closure_without_owned_jobs(self):
        self.startup_fixture()
        plan = S["prepare"](self.run, self.inventory)
        self.assertEqual(plan["targets"], [])
        self.assertEqual(plan["archived_ownership"], {})
        self.assertFalse(plan["startup_closure"]["supervisor_joined"])
        self.assertFalse(plan["startup_closure"]["reuse_credit"])
        self.assertIn(
            str(self.run / "startup-finalization/failure-proof.json"), plan["inputs"]
        )
        baseline = self.root / "old-scripts"
        baseline.mkdir()
        for path in (ROOT / "scripts").glob("*.py"):
            if path.name != "cloudbench-archived-owner-stop.py":
                (baseline / path.name).symlink_to(path)
        old = baseline / "cloudbench-archived-owner-stop.py"
        old.write_bytes(
            subprocess.check_output(
                [
                    "git",
                    "show",
                    "2a4624e8388c526b290cf9cbfe21f5f2143cf007:scripts/cloudbench-archived-owner-stop.py",
                ],
                cwd=ROOT,
            )
        )
        result = subprocess.run(
            [
                sys.executable,
                "-S",
                str(old),
                "--run-dir",
                str(self.run),
                "--inventory",
                str(self.inventory),
                "--out-dir",
                str(self.root / "old-out"),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("joined released original controller required", result.stderr)

    def test_startup_proof_tamper_and_runtime_publication_are_rejected(self):
        members = self.startup_fixture()
        proof_path = self.run / "startup-finalization/failure-proof.json"
        original = proof_path.read_bytes()
        changed = json.loads(original)
        changed["supervisor_joined"] = True
        write(proof_path, changed)
        with self.assertRaisesRegex(ValueError, "proof bytes differ"):
            S["prepare"](self.run, self.inventory)
        proof_path.write_bytes(original)
        members["context/original600-supervisor.other.json"] = b"{}"
        self.reseal(members)
        proof = json.loads(original)
        export = self.run / "export"
        proof.update(
            archive_sha256=S["digest_file"](export / "originals.tar.gz"),
            manifest_sha256=S["digest_file"](export / "manifest.json"),
            export_marker_sha256=S["digest_file"](
                export / "disposable-export.verified.json"
            ),
        )
        write(proof_path, proof)
        digest = S["digest_file"](proof_path)
        for path in (
            self.run / "terminal.json",
            self.run / "startup-finalization/complete.json",
            self.run / "cleanup-call.intent.json",
        ):
            value = json.loads(path.read_text())
            value["failure_proof_sha256"] = digest
            if "export_verified_file" in value:
                value["export_verified_file"] = proof["export_marker_sha256"]
            write(path, value)
        # Exact input hashes still cannot turn publication into a no-supervisor closure.
        with self.assertRaisesRegex(ValueError, "runtime publication"):
            S["prepare"](self.run, self.inventory)
    def acknowledged_fixture(self):
        with tarfile.open(self.run / "export/originals.tar.gz") as archive:
            members = {m.name: archive.extractfile(m).read() for m in archive}
        mid = "abcddcba112233"
        name = "cloudbench-" + "c" * 24
        owner = "d" * 32
        prefix = "git-common/cloudbench-fleet-ownership/" + owner
        audit = "git-common/cloudbench-fleet-audits/" + owner
        run_id = "20261017-083120-26239"
        source = "123456789abcde"
        meta = {
            "version": "2",
            "host": "11112222333344",
            "app": "navi-whisper-lux-bench",
            "fleet_owner_token": owner,
            "cleanup_policy": "reap",
            "run_id": run_id,
            "workspace_root": "/tmp/gate/repo",
            "runs_root": "/tmp/gate/repo/.context/fleet/runs",
            "audit_dir": "/tmp/gate/repo/.git/cloudbench-fleet-audits/" + owner,
        }
        enc = lambda value: "".join(k + "=" + v + "\n" for k, v in value.items()).encode()
        members[prefix + "/meta"] = enc(meta)
        members[prefix + "/clones/" + name] = enc({"name": name})
        members[audit + "/expected-fresh/" + name] = enc(
            {"clone_name": name, "source_machine_id": source}
        )
        members[audit + "/fresh/" + name] = enc(
            {
                "version": "1",
                "fleet_owner_token": owner,
                "run_id": run_id,
                "app": meta["app"],
                "clone_name": name,
                "source": "fresh-clone",
                "source_machine_id": source,
                "machine_id": "",
                "volume_id": "",
                "disposition": "ownership-pending",
            }
        )
        log = "context/fleet/runs/" + run_id + "/fixture/primary.log"
        image = "registry.fly.io/navi-whisper-lux-bench:fixture@sha256:" + "a" * 64
        members[log] = (
            f"clone name={name} source={source} status=0 attempt=1/5\n"
            f"Cloning Machine {source} into region iad\n"
            "Volume 'fresh' will start empty\n"
            f"Provisioning a new Machine with image {image}...\n"
            f"  Machine {mid} has been created...\n"
        ).encode()
        members[log.removesuffix(".log") + ".names"] = (name + "\n").encode()
        row = {
            "id": mid,
            "name": name,
            "instance_id": "ack-instance",
            "created_at": "2026-10-17T08:52:59Z",
            "region": "iad",
            "state": "started",
            "config": {
                "image": image,
                "init": {"cmd": ["sleep", "infinity"]},
                "mounts": [{"volume": "vol_new", "path": "/data", "name": "fresh"}],
            },
        }
        terminal = json.loads((self.run / "terminal.json").read_text())
        epoch = datetime(2026, 10, 17, 8, 26, tzinfo=timezone.utc).timestamp()
        terminal.update(started_at_epoch=epoch, original_deadline=epoch + 5400)
        write(self.run / "terminal.json", terminal)
        write(self.inventory, json.loads(self.inventory.read_text()) + [row])
        self.reseal(members)
        return mid, row, members, log, prefix, audit

    def test_acknowledged_create_is_explicit_stop_only_with_current_volume_provenance(self):
        mid, row, members, log, prefix, audit = self.acknowledged_fixture()
        before = {str(p): p.read_bytes() for p in self.run.rglob("*") if p.is_file()}
        self.assertNotIn(mid, S["prepare"](self.run, self.inventory)["archived_ownership"])
        plan = S["prepare"](self.run, self.inventory, acknowledged_creates=[mid])
        self.assertEqual([x["machine"]["id"] for x in plan["targets"]], [mid])
        self.assertNotIn(mid, plan["archived_ownership"])
        proof = plan["targets"][0]["ownership"]
        self.assertEqual(proof["kind"], "acknowledged-create-stop-only")
        self.assertEqual(proof["current_volume_id"], "vol_new")
        self.assertEqual(proof["ack_log"], log)
        self.assertFalse(proof["sealed_clone_identity"])
        cli_output = self.root / "acknowledged-cli"
        child = subprocess.run(
            [sys.executable, "-S", S["__file__"], "--run-dir", str(self.run),
             "--inventory", str(self.inventory), "--out-dir", str(cli_output),
             "--acknowledged-create", mid],
            capture_output=True, text=True, timeout=5, check=True,
        )
        self.assertEqual(json.loads(child.stdout)["targets"], 1)
        self.assertEqual(json.loads(child.stdout)["provider_calls"], 0)
        self.assertEqual(json.loads((cli_output / "plan.json").read_text()), plan)
        self.assertEqual(
            before, {str(p): p.read_bytes() for p in self.run.rglob("*") if p.is_file()}
        )
        current = copy.deepcopy(row)
        calls = []

        class API:
            def api(inner, method, path, body=None, timeout=0):
                calls.append((method, path))
                if method == "POST":
                    self.assertEqual(path, "/machines/" + mid + "/stop")
                    current["state"] = "stopped"
                    raise TimeoutError("unknown ACK")
                return copy.deepcopy(current)

        for unused in range(2):
            result = S["stop_owned"](
                API(), row, self.out, time.monotonic() + 2, adapter_factory=LeasedFixture
            )
            self.assertEqual(result["status"], "STOPPED_CONFIRMED")
        self.assertEqual(sum(method == "POST" for method, path in calls), 1)
        self.assertEqual(row["config"], current["config"])

    def test_acknowledged_create_rejects_missing_ambiguous_conflicting_or_superseded_evidence(
        self,
    ):
        mid, row, members, log, prefix, audit = self.acknowledged_fixture()
        original = copy.deepcopy(members)
        inventory = self.inventory.read_bytes()

        def deny(changed):
            self.reseal(changed)
            with self.assertRaises(ValueError):
                S["prepare"](self.run, self.inventory, acknowledged_creates=[mid])

        for old, new in [
            (b"status=0", b"status=1"),
            (mid.encode(), b"ffffffffffffff"),
            (b"source=123456789abcde", b"source=ffffffffffffff"),
        ]:
            changed = copy.deepcopy(original)
            changed[log] = changed[log].replace(old, new)
            deny(changed)
        changed = copy.deepcopy(original)
        changed[log] += changed[log]
        deny(changed)
        changed = copy.deepcopy(original)
        changed.pop(audit + "/fresh/" + row["name"])
        deny(changed)
        changed = copy.deepcopy(original)
        changed["git-common/cloudbench-archived-reuse/current/" + mid + ".json"] = b"{}"
        deny(changed)
        changed = copy.deepcopy(original)
        changed["context/fleet/runs/other/task/.cid"] = ("name " + mid + "\n").encode()
        deny(changed)
        self.reseal(original)
        native = json.loads(inventory)
        for update in [
            {"created_at": "2026-10-16T08:52:59Z"},
            {"region": "ord"},
            {"config": dict(row["config"], init={"cmd": ["sh", "task"]})},
            {
                "config": dict(
                    row["config"], metadata={"cloudbench_archived_reuse": "successor"}
                )
            },
            {
                "config": dict(
                    row["config"],
                    mounts=[{"volume": "vol_protected", "path": "/data", "name": "fresh"}],
                )
            },
        ]:
            write(self.inventory, native[:-1] + [dict(row, **update)])
            with self.assertRaises(ValueError):
                S["prepare"](self.run, self.inventory, acknowledged_creates=[mid])
        self.inventory.write_bytes(inventory)
        with self.assertRaises(ValueError):
            S["prepare"](
                self.run,
                self.inventory,
                excluded_machines=[mid],
                acknowledged_creates=[mid],
            )

    def test_archive_plan_excludes_protected_and_unsealed_and_refuses_changed_ownership(self):
        prior=[dict(id='22223333444455',name='prior-stopped',state='stopped',config=dict(mounts=[dict(volume='vol_prior_stopped')])),
               dict(id='33334444555566',name='prior-active',state='started',config=dict(mounts=[dict(volume='vol_prior_active')]))]
        original=json.loads(self.inventory.read_text())
        write(self.inventory,original+prior)
        inventory_before=self.inventory.read_bytes()
        plan=S['prepare'](self.run,self.inventory)
        self.assertEqual(plan['unrelated_native_machines_skipped'],2)
        self.assertEqual(self.inventory.read_bytes(),inventory_before,'planning modified unrelated retained resources')
        self.assertEqual([x['machine']['id'] for x in plan['targets']],[self.mid])
        self.assertEqual(plan['unsealed_intents_skipped'],1)
        self.assertFalse(plan['benchmark_success_inferred'])
        for changed in [dict(name='foreign'),dict(instance_id=None),dict(config=None),dict(config=dict(mounts=[dict(volume='vol_other')]))]:
            write(self.inventory,[dict(self.row,**changed)]+[dict(id=x,state='started') for x in plan['protected_machines']]+prior)
            with self.assertRaises(ValueError):S['prepare'](self.run,self.inventory)
        write(self.inventory,[self.row]+[dict(id=x,state='started') for x in plan['protected_machines']]+prior)
        terminal=json.loads((self.run/'terminal.json').read_text());terminal['release']['machine_deleted']=False
        write(self.run/'terminal.json',terminal)
        with self.assertRaises(ValueError):S['prepare'](self.run,self.inventory)

    def test_large_export_manifest_keeps_full_integrity_and_operational_limit(self):
        export = self.run / "export"
        path = export / "manifest.json"
        manifest = json.loads(path.read_bytes())
        manifest["fixture_padding"] = "x" * (16 * 1024 * 1024)
        write(path, manifest)
        verified_path = export / "disposable-export.verified.json"
        verified = json.loads(verified_path.read_bytes())
        verified["files"]["manifest.json"] = S["digest_file"](path)
        write(verified_path, verified)
        intent_path = self.run / "cleanup-call.intent.json"
        intent = json.loads(intent_path.read_bytes())
        intent["export_verified_file"] = S["digest_file"](verified_path)
        write(intent_path, intent)
        with self.assertRaises(ValueError):
            S["raw"](path)
        plan = S["prepare"](self.run, self.inventory)
        self.assertEqual([row["machine"]["id"] for row in plan["targets"]], [self.mid])
        unused = runpy.run_path(str(ROOT / "scripts/cloudbench-unused-reservations.py"))
        parked = runpy.run_path(str(ROOT / "scripts/cloudbench-parked-reservations.py"))
        inputs = {}
        self.assertEqual(unused["archive_manifest"](self.run, inputs), manifest)
        self.assertEqual(inputs[str(path)], verified["files"]["manifest.json"])
        self.assertEqual(parked["collect"](self.run, [], {}), {})
        manifest["fixture_padding"] = "y" + manifest["fixture_padding"][1:]
        write(path, manifest)
        with self.assertRaisesRegex(ValueError, "verified export artifact changed"):
            S["prepare"](self.run, self.inventory)
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            S["manifest_bytes"](path)
        path.chmod(0o600)
        with path.open("r+b") as stream:
            stream.truncate(64 * 1024 * 1024 + 1)
        with self.assertRaises(ValueError):
            S["manifest_bytes"](path)
        with self.assertRaisesRegex(ValueError, "export manifest required"):
            S["manifest_bytes"](self.inventory)

    def test_archive_stream_rejects_mutation_replacement_and_hard_links(self):
        archive = self.run / "export/originals.tar.gz"
        original = archive.read_bytes()
        digest = hashlib.sha256(original).hexdigest()
        self.assertEqual(S["archive_digest"](archive), digest)
        alias = archive.with_name("linked")
        os.link(archive, alias)
        with self.assertRaises(ValueError):
            S["archive_digest"](archive)
        alias.unlink()
        real_sha256 = hashlib.sha256
        for replace in (False, True):

            class ChangedArchive:
                def __init__(self):
                    self.digest = real_sha256()
                    self.changed = False

                def update(self, block):
                    if not self.changed:
                        self.changed = True
                        if replace:
                            replacement = archive.with_name("replacement")
                            replacement.write_bytes(original)
                            replacement.chmod(0o600)
                            os.replace(replacement, archive)
                        else:
                            archive.write_bytes(original + b"changed")
                    self.digest.update(block)

                def hexdigest(self):
                    return self.digest.hexdigest()

            with mock.patch.object(S["hashlib"], "sha256", ChangedArchive):
                with self.assertRaisesRegex(ValueError, "archive changed"):
                    S["archive_digest"](archive)
            archive.write_bytes(original)

    def test_exact_preget_ambiguous_stop_reconciles_and_resume_never_reposts(self):
        row=copy.deepcopy(self.row);calls=[]
        class API:
            def api(inner,method,path,body=None,timeout=0):
                calls.append((method,path))
                self.assertEqual(path,'/machines/'+self.mid+('/stop' if method=='POST' else ''))
                self.assertIn(method,['GET','POST'])
                if method=='POST':
                    row['state']='stopped';raise TimeoutError('lost response')
                return copy.deepcopy(row)
        api=API()
        first=S['stop_owned'](api,self.row,self.out,time.monotonic()+2,adapter_factory=LeasedFixture)
        self.assertEqual(first['status'],'STOPPED_CONFIRMED')
        self.assertEqual(calls,[('GET','/machines/'+self.mid),('POST','/machines/'+self.mid+'/stop'),('GET','/machines/'+self.mid)])
        self.assertTrue((self.out/self.mid/'stop-intent.json').exists())
        self.assertEqual(S['stop_owned'](api,self.row,self.out,time.monotonic()+2,adapter_factory=LeasedFixture)['status'],'STOPPED_CONFIRMED')
        self.assertEqual(sum(method=='POST' for method,path in calls),1)
        self.assertEqual(self.row['config'],row['config'])
        self.assertNotIn('claims_released',first)

    def test_changed_identity_or_unknown_resume_retains_pending_without_stop(self):
        for change in [dict(instance_id='replacement'),dict(config=dict(mounts=[]))]:
            calls=[]
            class API:
                def api(inner,method,path,body=None,timeout=0):
                    calls.append(method);return dict(self.row,**change)
            value=S['stop_owned'](API(),self.row,self.out,time.monotonic()+2,adapter_factory=LeasedFixture)
            self.assertEqual(value['status'],'PENDING');self.assertEqual(calls,['GET'])
        directory=self.out/self.mid;directory.mkdir(mode=0o700)
        write(directory/'stop-intent.json',dict(ambiguous=True))
        class Unknown:
            def api(inner,method,path,body=None,timeout=0):
                self.assertEqual(method,'GET');raise TimeoutError('unknown')
        value=S['stop_owned'](Unknown(),self.row,self.out,time.monotonic()+1)
        self.assertEqual(value['status'],'PENDING')
        self.assertFalse((directory/'terminal.json').exists())


    def test_successor_claim_between_plan_and_lease_prevents_stop(self):
        current=copy.deepcopy(self.row);effects=[]
        class API:
            def api(inner,method,path,body=None,timeout=0):
                effects.append(method)
                return copy.deepcopy(current)
        class RacedLease(LeasedFixture):
            @contextmanager
            def lease(inner,mid):
                current['config']['metadata']={'cloudbench_archived_reuse':'claimed-by-successor'}
                inner.held=True
                try:yield
                finally:inner.held=False
        result=S['stop_owned'](API(),self.row,self.out,time.monotonic()+2,adapter_factory=RacedLease)
        self.assertEqual(result['status'],'PENDING')
        self.assertEqual(effects,['GET'])
        self.assertFalse((self.out/self.mid/'stop-intent.json').exists())

    def test_final_observation_is_one_inventory_and_keeps_unknown_pending(self):
        row=copy.deepcopy(self.row);row['state']='stopped'
        trace=self.root/'api.calls'
        class API:
            def api(inner,method,path,body=None,timeout=0):
                with trace.open('a') as f:f.write(method+' '+path+'\n')
                self.assertEqual(method,'GET')
                if path=='/machines':
                    # Replacement config must not turn the old owned identity
                    # into a stopped confirmation, even when state is stopped.
                    return [dict(row,instance_id='replacement'),dict(id='22223333444455',state='started'),dict(id='33334444555566',state='stopped')]
                self.assertEqual(path,'/machines/'+self.mid)
                return copy.deepcopy(row)
        plan=dict(schema='cloudbench-archived-owner-stop-plan-v1',inputs={},
                  protected_machines=['00000000000000'],targets=[dict(machine=row)],unrelated_native_machines_skipped=2)
        result=S['execute'](API(),plan,self.out,seconds=60,workers=1)
        self.assertFalse(result['all_owned_stopped'])
        self.assertEqual(result['unrelated_native_machines_skipped'],2)
        self.assertEqual(result['results'][0]['status'],'PENDING')
        calls=trace.read_text().splitlines()
        self.assertEqual(calls.count('GET /machines'),1)
        self.assertTrue(all(line.startswith('GET ') for line in calls))
        self.assertFalse(result['claims_released'])


if __name__=='__main__':unittest.main()
