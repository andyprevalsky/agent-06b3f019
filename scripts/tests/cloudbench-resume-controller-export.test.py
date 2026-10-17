#!/usr/bin/env python3
"""Offline export resume ownership, canonical verification and publication ordering."""

import base64
import contextlib
import io
import json
import os
import runpy
import shlex
import signal
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(str(ROOT / "scripts/cloudbench-resume-controller-export.py"))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(value, sort_keys=True) + "\n")
    path.chmod(0o600)
    return path


class ExportResume(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.out = self.root / "run"
        self.export = self.out / "export"
        self.export.mkdir(parents=True, mode=0o700)
        self.mid = "a" * 14
        self.collector = ROOT / "scripts/cloudbench-controller-export.py"
        self.caller = {"pid": 99, "birth": "fixture-gone", "host": "fixture"}
        self.record = {
            "machine_id": self.mid,
            "source_ref": "b" * 40,
            "app": M["R"]["APP"],
            "image": "fixture-image",
            "caller": self.caller,
            "collector_sha256": M["sha"](self.collector.read_bytes()),
        }
        write(self.export / "caller.json", self.caller)
        write(self.export / "launch.json", self.record)
        self.auth = write(self.out / "authority.private.json", {"fixture": "authority"})
        self.binding = {
            "fixture": "binding",
            "launch_sha256": M["sha"]((self.export / "launch.json").read_bytes()),
        }
        self.value = {
            "state": {
                "out": str(self.out),
                "source_root": str(ROOT),
                "machine_id": self.mid,
                "source_ref": "b" * 40,
                "machine": {
                    "id": self.mid,
                    "instance_id": "exact-instance",
                    "config": {},
                    "name": "old-controller",
                    "region": "iad",
                    "state": "started",
                },
            },
            "binding": self.binding,
            "record": self.record,
            "driver_sha256": "d" * 64,
            "collector_path": str(self.collector),
            "image": "fixture-image",
        }
        self.payloads = {"launch.json": (self.export / "launch.json").read_bytes()}
        archive = self.root / "fixture.tar.gz"
        with tarfile.open(archive, "w:gz") as stream:
            data = b"actual original fixture bytes"
            entry = tarfile.TarInfo("context/original.txt")
            entry.size = len(data)
            stream.addfile(entry, io.BytesIO(data))
        self.payloads["originals.tar.gz"] = archive.read_bytes()
        self.payloads["manifest.json"] = json.dumps(
            {
                "version": 1,
                "resource_release_verified": False,
                "record": self.record,
                "archive_sha256": M["sha"](archive.read_bytes()),
                "files": {
                    "context/original.txt": {
                        "kind": "file",
                        "bytes": len(data),
                        "sha256": M["sha"](data),
                    }
                },
            }
        ).encode()

    def api(self, *, wrong=False, fail_download=False, writers=False):
        test = self

        class API:
            def __init__(self):
                self.calls = []
                self.marker = False

            def api(self, method, path, timeout, observer):
                test.assertFalse(self.marker)
                self.calls.append((method, path))
                current = dict(test.value["state"]["machine"])
                if wrong:
                    current["instance_id"] = "foreign"
                raw = json.dumps(current).encode()
                observer(method, path, 200, raw)
                return current

            def flyctl(self, seconds, *args):
                test.assertFalse(self.marker)
                self.calls.append(tuple(args[:3]))
                if args[1] == "console":
                    argv = shlex.split(args[-1])
                    payload = json.loads(base64.b64decode(argv[-1]))
                    test.assertEqual(payload["record"], test.record)
                    test.assertIn("cd / && exec", args[-1])
                    result = {
                        "machine": test.mid,
                        "launch_sha256": test.binding["launch_sha256"],
                        "non_hub_writers": [],
                    }
                    if writers and payload["action"] == "check":
                        return (
                            75,
                            json.dumps(
                                dict(
                                    result,
                                    status="PENDING_WRITERS",
                                    non_hub_writers=[
                                        {"pid": 123, "birth": "exact-writer"}
                                    ],
                                )
                            ),
                            "",
                        )
                    if payload["action"] == "export":
                        raw_custody = b"actual immutable TERM intent fixture\n"
                        result["drain_evidence"] = {
                            "root": "/tmp/gate/controller-host-custody/registered-orphan-drain",
                            "present": True,
                            "directories": ["per-pid"],
                            "files": {
                                "per-pid/intent.json": {
                                    "bytes": len(raw_custody),
                                    "sha256": M["sha"](raw_custody),
                                    "body_b64": base64.b64encode(raw_custody).decode(),
                                }
                            },
                        }
                        result.update(
                            canonical_export_exit=0,
                            remote_stage="/tmp/gate/controller-host-custody/export-resume-"
                            + payload["binding_sha256"][:24],
                        )
                    return 0, json.dumps(result), ""
                if fail_download:
                    return 75, "", "fixture download failure"
                destination = Path(args[-1])
                destination.write_bytes(test.payloads[destination.name])
                return 0, "", ""

        return API()

    def test_actual_old_verifier_accepts_new_staging_and_rejects_corruption(self):
        stage = self.root / "stage"
        stage.mkdir(mode=0o700)
        for name, raw in self.payloads.items():
            (stage / name).write_bytes(raw)
            (stage / name).chmod(0o600)
        hashes = M["verify_stage"](self.value, stage)
        self.assertEqual(hashes["launch.json"], self.binding["launch_sha256"])
        (stage / "originals.tar.gz").write_bytes(b"corrupt")
        with self.assertRaises(ValueError):
            M["verify_stage"](self.value, stage)

    def test_all_remote_children_join_before_canonical_marker_and_no_replay(self):
        api = self.api()

        def ready(argv, **kwargs):
            self.assertEqual(argv[3], "export-ready")
            self.assertEqual(kwargs["cwd"], "/")
            self.assertEqual(
                (
                    self.out
                    / "controller-export-recovery/registered-orphan-drain/per-pid/intent.json"
                ).read_bytes(),
                b"actual immutable TERM intent fixture\n",
            )
            self.assertEqual(
                len([call for call in api.calls if call[:2] == ("ssh", "sftp")]), 3
            )
            self.assertTrue(
                all((self.export / name).stat().st_nlink == 1 for name in self.payloads)
            )
            write(
                self.export / "disposable-export.verified.json",
                {
                    "authority_sha256": M["sha"](self.auth.read_bytes()),
                    "machine_id": self.mid,
                    "files": {
                        name: M["file_sha"](self.export / name)
                        for name in (*self.payloads, "caller.json")
                    },
                },
            )
            api.marker = True
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        with (
            mock.patch.dict(M["execute"].__globals__, unchanged=lambda _: None),
            mock.patch("subprocess.run", side_effect=ready),
        ):
            result = M["execute"](self.value, api)
            self.assertEqual(result["status"], "EXPORT_VERIFIED")
            self.assertTrue(api.marker)
            self.assertEqual(
                (
                    self.out
                    / "controller-export-recovery/registered-orphan-drain/per-pid/intent.json"
                ).read_bytes(),
                b"actual immutable TERM intent fixture\n",
            )
            count = len(api.calls)
            with self.assertRaises(FileExistsError):
                M["execute"](self.value, api)
            self.assertEqual(len(api.calls), count)
        self.assertTrue((self.export / "originals.tar.gz").exists())
        self.assertFalse(
            (self.out / "controller-export-recovery/download/originals.tar.gz").exists()
        )

    def test_wrong_incarnation_and_unknown_download_never_publish_or_repeat(self):
        api = self.api(wrong=True)
        with mock.patch.dict(M["execute"].__globals__, unchanged=lambda _: None):
            with self.assertRaisesRegex(ValueError, "incarnation"):
                M["execute"](self.value, api)
            self.assertEqual(len(api.calls), 1)
        self.assertFalse((self.export / "disposable-export.verified.json").exists())
        # Independent owned fixture for an unknown transfer outcome.
        self.temp.cleanup()
        self.setUp()
        api = self.api(fail_download=True)
        with mock.patch.dict(M["execute"].__globals__, unchanged=lambda _: None):
            with self.assertRaisesRegex(ValueError, "download incomplete"):
                M["execute"](self.value, api)
            count = len(api.calls)
            with self.assertRaises(FileExistsError):
                M["execute"](self.value, api)
            self.assertEqual(len(api.calls), count)
        self.assertFalse((self.export / "disposable-export.verified.json").exists())

    def test_readonly_old_hub_validator_keeps_finally_and_never_signals(self):
        scope = runpy.run_path(str(self.collector))
        fixture = self.root / "export-resume-fixture.py"
        fixture.write_text(M["REMOTE"])
        remote = runpy.run_path(str(fixture))
        repo = self.root / "repo"
        repo.mkdir()
        with mock.patch.object(
            signal,
            "pidfd_send_signal",
            side_effect=AssertionError("no signal in read-only validator"),
        ):
            self.assertEqual(
                remote["readonly_hubs"](
                    scope, self.collector.read_bytes(), repo, self.root
                ),
                [],
            )
        hub = repo / ".context/fleet/runs/_hub"
        hub.mkdir(parents=True)
        fields = {
            "pid": str(os.getpid()),
            "pid_start": scope["birth"](os.getpid()),
            "repo_root": str(repo),
            "root": str(hub.parent),
            "runs_root": str(hub.parent),
            "context_dir": str(hub),
            "command": str(repo / "agents/benchmarks/agent_link_server.py"),
            "status": "live-transfer-required",
            "host": "127.0.0.1",
            "owner_token": "e" * 32,
            "port": "5000",
            "argv_sha256": "f" * 64,
        }
        owner = hub / ("agent-link-server.5000." + "e" * 32 + ".owner")
        owner.write_text("\n".join(key + "=" + value for key, value in fields.items()))
        owner.chmod(0o400)
        real_close = os.close
        with (
            mock.patch.object(
                signal, "pidfd_send_signal", side_effect=AssertionError("no signal")
            ),
            mock.patch.object(os, "close", wraps=real_close) as closed,
        ):
            with self.assertRaisesRegex(ValueError, "command changed"):
                remote["readonly_hubs"](
                    scope, self.collector.read_bytes(), repo, self.root
                )
            self.assertEqual(closed.call_count, 1)

    def test_cancellation_during_owned_flyctl_joins_before_refusing_next_effect(self):
        api = self.api()
        original = api.flyctl
        joined = []

        def cancelled(seconds, *args):
            result = original(seconds, *args)
            signal.raise_signal(signal.SIGTERM)
            joined.append(True)
            return result

        api.flyctl = cancelled
        old_handler = signal.getsignal(signal.SIGTERM)
        with (
            mock.patch.dict(M["execute"].__globals__, unchanged=lambda _: None),
            self.assertRaises(M["ExportCancelled"]),
        ):
            M["execute"](self.value, api)
        self.assertEqual(joined, [True])
        self.assertEqual(len(api.calls), 2)  # one GET and the joined readonly SSH
        self.assertEqual(signal.getsignal(signal.SIGTERM), old_handler)
        receipt = json.loads(
            (self.out / "controller-export-recovery/cancelled.json").read_bytes()
        )
        self.assertTrue(receipt["owned_transport_joined"])
        self.assertFalse((self.export / "disposable-export.verified.json").exists())
        self.assertTrue(
            (self.out / "controller-export-recovery/check.response.json").exists()
        )

    def test_readonly_observation_retains_pending_without_spending_export_intent(self):
        api = self.api(writers=True)
        with mock.patch.dict(M["observe"].__globals__, unchanged=lambda _: None):
            result = M["observe"](self.value, api)
            self.assertFalse(result["ready"])
            self.assertEqual(result["non_hub_writer_count"], 1)
            self.assertEqual(len(api.calls), 2)
            self.assertFalse((self.out / "controller-export-recovery").exists())
            ready = M["observe"](self.value, self.api())
            self.assertTrue(ready["ready"])
            self.assertNotEqual(result["journal"], ready["journal"])
            self.assertFalse((self.out / "controller-export-recovery").exists())
        self.assertFalse((self.export / "disposable-export.verified.json").exists())

    def test_check_mode_has_zero_transport_or_export_calls(self):
        output = io.StringIO()
        with (
            mock.patch.dict(
                M["main"].__globals__,
                check=lambda *_: self.value,
                execute=lambda *_: (_ for _ in ()).throw(AssertionError("no effects")),
            ),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(
                M["main"](
                    [
                        "--config",
                        "/fixture",
                        "--config-sha256",
                        "a" * 64,
                        "--run-directory",
                        str(self.out),
                        "--operator-ref",
                        "b" * 40,
                        "--check",
                    ]
                ),
                0,
            )
        self.assertEqual(json.loads(output.getvalue())["provider_calls"], 0)


if __name__ == "__main__":
    unittest.main()
