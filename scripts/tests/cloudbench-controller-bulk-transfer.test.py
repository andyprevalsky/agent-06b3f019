#!/usr/bin/env python3
"""Real local SSH/SFTP argv fixtures, owned children and immutable bulk receipts."""

import base64
import gzip
import io
import json
import os
import random
import runpy
import shlex
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(str(ROOT / "scripts/cloudbench-controller-bulk-transfer.py"))
R = runpy.run_path(str(ROOT / "scripts/cloudbench-original600-runner.py"))
C = runpy.run_path(str(ROOT / "scripts/cloudbench-original-volume-capture.py"))

FAKE_FLY = r"""
import base64,gzip,json,os,runpy,shlex,sys,time
from pathlib import Path
from types import SimpleNamespace
root=Path(os.environ['BULK_GUEST']);args=sys.argv[1:]
assert os.environ['FLY_API_TOKEN']=='fixture-authenticated-token'
assert args[:2]in(['ssh','console'],['ssh','sftp']) and args[args.index('--machine')+1]=='1234567890abcd'
if args[:3]==['ssh','sftp','put']:
 source=Path(args[-2]);target=root/Path(args[-1]).relative_to('/tmp')
 assert args[args.index('-m')+1]=='0600' and not target.exists()
 raw=source.read_bytes();mode=os.environ.get('BULK_MODE','')
 if mode=='partial':raw=raw[:len(raw)//2]
 with target.open('xb')as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
 target.chmod(0o600)
 if mode=='cancel-signal':time.sleep(.3)
 if mode=='timeout':
  (root/'transport.pid').write_text(str(os.getpid()));time.sleep(60)
 if mode in ('partial','lost-upload','lost-both'):raise SystemExit(142)
 raise SystemExit(0)
assert args[:2]==['ssh','console']
cmd=shlex.split(args[args.index('-C')+1]);assert cmd[:3]==['python3','-S','-c']
script,payload=json.loads(gzip.decompress(base64.b64decode(cmd[-1])))
program=root/'exact-guest-code.py';program.write_text(script)
scope=runpy.run_path(str(program));scope['execute'].__globals__['pwd']=SimpleNamespace(getpwnam=lambda _:SimpleNamespace(pw_uid=os.geteuid(),pw_gid=os.getegid()))
value=scope['execute'](payload,root=root)
if payload['action']=='commit' and os.environ.get('BULK_MODE')in('lost-commit','lost-both'):raise SystemExit(142)
print(json.dumps(value,sort_keys=True))
"""


class Bulk(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.host = self.root / "host"
        self.guest = self.root / "guest"
        self.host.mkdir()
        self.guest.mkdir()
        self.fly = self.root / "fly-fixture.py"
        self.fly.write_text(FAKE_FLY)
        self.raw = random.Random(17).randbytes(300000)
        item = {
            "relative_path": ".git/cloudbench-bulk-fixture.json",
            "sha256": R["sha"](self.raw),
        }
        epoch = time.time()
        remote = {
            "source_ref": "a" * 40,
            "epoch": epoch,
            "remote_files": [R["encode_remote_file"](item, self.raw)],
        }
        self.envelope, self.envelope_sha, _ = R["launch_handoff"](self.host, remote)
        installed = self.guest / "controller-launch-payload.json.gz"
        installed.write_bytes(self.envelope.read_bytes())
        installed.chmod(0o600)
        self.deadline = epoch + 5400
        self.record = {
            "id": "1234567890abcd",
            "instance_id": "original-instance",
            "name": "owned",
            "region": "iad",
            "state": "started",
            "config": {"env": {"GATE_REF": "a" * 40}},
        }
        self.calls = []
        self.cancelled = []
        self.mode = ""
        self.native_count = 0
        self.fail_native_at = None
        self.fail_native_key = None
        self.source_sha = R["sha"](
            (ROOT / "scripts/cloudbench-controller-bulk-transfer.py").read_bytes()
        )
        fixture = self

        class API:
            def api(self, method, path, body=None, timeout=20, observer=None):
                fixture.calls.append((method, path))
                if fixture.mode == "read-timeout" and len(fixture.calls) == 1:
                    raise R["Deadline"]("read-only fixture interruption")
                fixture.native_count += 1
                current = json.loads(json.dumps(fixture.record))
                if (
                    fixture.fail_native_at is not None
                    and fixture.native_count >= fixture.fail_native_at
                ):
                    current[fixture.fail_native_key] = "foreign"
                observer(method, path, 200, json.dumps(current).encode())
                return current

            def flyctl(self, seconds, *argv):
                fixture.calls.append(tuple(argv))
                fixture.assertLessEqual(seconds, 20)
                env = dict(
                    os.environ,
                    BULK_GUEST=str(fixture.guest),
                    BULK_MODE=fixture.mode,
                    FLY_API_TOKEN="fixture-authenticated-token",
                    FLY_MACHINE_ID=fixture.record["id"],
                    GATE_REF="a" * 40,
                )
                # Accelerate only the timeout fixture; the production argv/budget remains recorded.
                budget = (
                    0.3
                    if fixture.mode == "timeout" and argv[:3] == ("ssh", "sftp", "put")
                    else seconds
                )
                if fixture.mode == "cancel-signal" and argv[:3] == (
                    "ssh",
                    "sftp",
                    "put",
                ):
                    timer = threading.Timer(
                        0.1, lambda: os.kill(os.getpid(), signal.SIGTERM)
                    )
                    timer.start()
                rc, stdout, stderr = C["run_bounded"](
                    [sys.executable, "-S", str(fixture.fly), *argv], budget, env
                )
                if fixture.mode == "cancel" and argv[:3] == ("ssh", "sftp", "put"):
                    fixture.cancelled.append(True)
                return rc, stdout.decode(), stderr.decode()

        self.api = API()

    def tearDown(self):
        self.tmp.cleanup()

    def transfer(self):
        return M["transfer"](
            self.api,
            self.record["id"],
            self.record,
            self.host,
            self.envelope_sha,
            self.deadline,
            lambda: bool(self.cancelled),
            runtime=R,
            source_sha256=self.source_sha,
        )

    def uploads(self):
        return [row for row in self.calls if row[:3] == ("ssh", "sftp", "put")]

    def actions(self):
        return [
            json.loads(gzip.decompress(base64.b64decode(shlex.split(row[-1])[-1])))[1][
                "action"
            ]
            for row in self.calls
            if row[:2] == ("ssh", "console")
        ]

    def test_one_authenticated_upload_replaces_many_fragment_writes(self):
        self.transfer()
        self.assertEqual(len(self.uploads()), 1)
        self.assertEqual(self.actions(), ["init", "commit"])
        sidecar = json.loads(
            (self.host / "controller-sidecars.private.json").read_bytes()
        )[0]
        destination = self.guest / ("controller-sidecar-" + sidecar["sha256"] + ".gz")
        self.assertEqual(gzip.decompress(destination.read_bytes()), self.raw)
        self.assertEqual(destination.stat().st_nlink, 1)
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        self.assertGreater(len(destination.read_bytes()) // 2048, 100)
        self.assertTrue((self.host / "payload-bulk-transfer/complete.json").is_file())

    def test_same_artifact_old_fragment_receiver_versus_one_bulk_stream(self):
        portable = runpy.run_path(
            str(ROOT / "scripts/tests/original600-portable-operator.test.py")
        )
        legacy = portable["Portable"]()
        guest = self.root / "old-guest"
        guest.mkdir()
        api, record = legacy.sidecar_api(guest, self.envelope)
        R["transfer_sidecars"](
            api, record["id"], record, self.host, self.envelope_sha, self.deadline
        )
        old_posts = api.posts
        sidecar = json.loads(
            (self.host / "controller-sidecars.private.json").read_bytes()
        )[0]
        old_bytes = (
            guest / ("controller-sidecar-" + sidecar["sha256"] + ".gz")
        ).read_bytes()
        self.transfer()
        new_bytes = (
            self.guest / ("controller-sidecar-" + sidecar["sha256"] + ".gz")
        ).read_bytes()
        self.assertEqual(old_bytes, new_bytes)
        self.assertGreater(old_posts, 100)
        self.assertEqual(len(self.uploads()), 1)
        self.assertEqual(self.actions(), ["init", "commit"])
        self.causal_counts = {
            "old_actual_posts": old_posts,
            "old_actual_gets": api.gets,
            "bulk_uploads": len(self.uploads()),
            "bulk_control_calls": len(self.actions()),
        }
        print(json.dumps(self.causal_counts, sort_keys=True))

    def test_unknown_upload_and_commit_only_observe_never_repeat_writes(self):
        self.mode = "lost-upload"
        self.transfer()
        self.assertEqual(len(self.uploads()), 1)
        self.assertEqual(self.actions(), ["init", "observe", "commit"])

    def test_commit_unknown_is_reconciled_by_ready_files_only(self):
        self.mode = "lost-commit"
        self.transfer()
        self.assertEqual(len(self.uploads()), 1)
        self.assertEqual(self.actions(), ["init", "commit", "observe"])

    def test_both_unknowns_have_distinct_read_only_receipts(self):
        self.mode = "lost-both"
        self.transfer()
        self.assertEqual(len(self.uploads()), 1)
        self.assertEqual(self.actions(), ["init", "observe", "commit", "observe"])
        for label in ("observe-upload", "observe-commit"):
            self.assertTrue(
                (
                    self.host / "payload-bulk-transfer" / (label + ".result.json")
                ).is_file()
            )

    def test_partial_upload_remains_unknown_without_commit_or_retry(self):
        self.mode = "partial"
        with self.assertRaisesRegex(ValueError, "upload remains unknown"):
            self.transfer()
        self.assertEqual(len(self.uploads()), 1)
        self.assertEqual(self.actions(), ["init", "observe"])
        with self.assertRaises(FileExistsError):
            self.transfer()

    def test_cancel_joins_upload_and_never_dispatches_commit(self):
        self.mode = "cancel"
        with self.assertRaisesRegex(ValueError, "cancelled"):
            self.transfer()
        self.assertEqual(len(self.uploads()), 1)
        self.assertEqual(self.actions(), ["init"])
        result = json.loads(
            (self.host / "payload-bulk-transfer/upload.result.json").read_bytes()
        )
        self.assertTrue(result["owned_transport_joined"])

    def test_real_transport_timeout_joins_child_then_observes_exact_bytes(self):
        self.mode = "timeout"
        self.transfer()
        pid = int((self.guest / "transport.pid").read_text())
        self.assertFalse(Path("/proc", str(pid)).exists())
        self.assertEqual(len(self.uploads()), 1)
        self.assertEqual(self.actions(), ["init", "observe", "commit"])

    def test_native_read_deadline_is_reobserved_without_replaying_transfer(self):
        self.mode = "read-timeout"
        self.transfer()
        self.assertEqual(len(self.uploads()), 1)
        self.assertEqual(
            len(
                list((self.host / "payload-bulk-transfer").glob("*-read-pending.json"))
            ),
            1,
        )

    def test_existing_destination_mismatch_is_not_overwritten(self):
        descriptor = json.loads(
            (self.host / "controller-sidecars.private.json").read_bytes()
        )[0]
        destination = self.guest / (
            "controller-sidecar-" + descriptor["sha256"] + ".gz"
        )
        destination.write_bytes(b"foreign bytes")
        destination.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "commit remains unknown"):
            self.transfer()
        self.assertEqual(destination.read_bytes(), b"foreign bytes")
        self.assertEqual(self.actions().count("commit"), 1)
        self.assertEqual(len(self.uploads()), 1)

    def test_signal_during_owned_upload_joins_then_stops(self):
        self.mode = "cancel-signal"
        old = signal.signal(signal.SIGTERM, lambda *_: self.cancelled.append(True))
        try:
            with self.assertRaisesRegex(ValueError, "cancelled"):
                self.transfer()
        finally:
            signal.signal(signal.SIGTERM, old)
        self.assertEqual(self.actions(), ["init"])
        result = json.loads(
            (self.host / "payload-bulk-transfer/upload.result.json").read_bytes()
        )
        self.assertTrue(result["owned_transport_joined"])
        self.assertEqual(result["exit_code"], 0)

    def reject_native_change(self, at, key, upload_count):
        self.fail_native_at = at
        self.fail_native_key = key
        with self.assertRaisesRegex(ValueError, "incarnation changed"):
            self.transfer()
        self.assertEqual(len(self.uploads()), upload_count)
        self.assertNotIn("commit", self.actions())

    def test_instance_change_before_upload_blocks_it(self):
        self.reject_native_change(4, "instance_id", 0)

    def test_config_change_before_upload_blocks_it(self):
        self.reject_native_change(4, "config", 0)

    def test_instance_change_before_commit_blocks_it(self):
        self.reject_native_change(6, "instance_id", 1)

    def test_config_change_before_commit_blocks_it(self):
        self.reject_native_change(6, "config", 1)

    def test_guest_rejects_unsafe_member_even_with_bound_archive_hash(self):
        program = self.root / "guest-source.py"
        program.write_text(M["REMOTE"])
        scope = runpy.run_path(str(program))
        scope["execute"].__globals__["pwd"] = SimpleNamespace(
            getpwnam=lambda _: SimpleNamespace(pw_uid=os.geteuid(), pw_gid=os.getegid())
        )
        descriptor = json.loads(
            (self.host / "controller-sidecars.private.json").read_bytes()
        )[0]
        content = Path(descriptor["path"]).read_bytes()
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:") as archive:
            member = tarfile.TarInfo("../escape")
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
        raw = output.getvalue()
        binding = {
            "machine": self.record["id"],
            "instance_id": self.record["instance_id"],
            "source_ref": "a" * 40,
            "envelope_sha256": self.envelope_sha,
            "epoch": self.deadline - 5400,
            "deadline": self.deadline,
            "files": {descriptor["sha256"]: descriptor["bytes"]},
            "archive_sha256": R["sha"](raw),
            "archive_bytes": len(raw),
        }
        identity = R["sha"](
            json.dumps(binding, sort_keys=True, allow_nan=False).encode()
        )
        payload = {"binding": binding, "identity_sha256": identity, "action": "init"}
        with patch.dict(
            os.environ, FLY_MACHINE_ID=self.record["id"], GATE_REF="a" * 40
        ):
            scope["execute"](payload, root=self.guest)
            uploaded = self.guest / ("controller-bulk-" + identity) / "payload.tar"
            uploaded.write_bytes(raw)
            uploaded.chmod(0o600)
            with self.assertRaisesRegex(ValueError, "foreign bulk archive member"):
                scope["execute"](dict(payload, action="commit"), root=self.guest)
        self.assertFalse((self.guest / "escape").exists())

    def test_real_control_argv_executes_and_rejects_foreign_machine(self):
        binding = {"machine": "foreign"}
        identity = R["sha"](
            json.dumps(binding, sort_keys=True, allow_nan=False).encode()
        )
        cmd = shlex.split(M["command"](binding, identity, "init"))
        result = subprocess.run(
            [sys.executable, *cmd[1:]],
            env=dict(os.environ, FLY_MACHINE_ID="actual", GATE_REF="a" * 40),
            capture_output=True,
            timeout=5,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"foreign bulk target", result.stderr)


if __name__ == "__main__":
    unittest.main()
