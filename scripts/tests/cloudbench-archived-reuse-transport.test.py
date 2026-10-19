#!/usr/bin/env python3
"""Offline kernel no-follow and streamed namespace-export owning controls."""

import base64
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
MODULE = Path(
    os.environ.get(
        "CLOUDBENCH_ARCHIVED_TRANSPORT_MODULE",
        str(SCRIPTS / "cloudbench-archived-reuse-transport.py"),
    )
)
spec = importlib.util.spec_from_file_location("archived_export", MODULE)
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


def frame(data, *, digest=None, length=None):
    encoded = b"\n".join(base64.b64encode(data[i : i + 49152]) for i in range(0, len(data), 49152))
    return (
        b"Connecting to fixture\nCLOUDBENCH_FILE_BEGIN\n"
        + (encoded + b"\n" if encoded else b"")
        + b"CLOUDBENCH_FILE_END:"
        + json.dumps(
            {
                "sha256": digest or hashlib.sha256(data).hexdigest(),
                "length": len(data) if length is None else length,
            }
        ).encode()
        + b"\n"
    )


class Tests(unittest.TestCase):
    def read_payload(self, root, remote):
        # Only map the fixed mount-root open. Every descendant uses real Linux
        # dirfd/O_NOFOLLOW semantics, including adversarial symlinks and FIFOs.
        launcher = (
            "import os,sys\noriginal=os.open\ndef mapped(path,*args,**kwargs):\n return original(sys.argv[2] if path == '/data' else path,*args,**kwargs)\nos.open=mapped\n"
            + transport.READ
        )
        return subprocess.run(
            [sys.executable, "-S", "-c", launcher, remote, str(root)],
            capture_output=True,
        )

    def test_actual_read_payload_regular_bytes_and_no_follow(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data = bytes(range(256)) * 500
            (root / "directory").mkdir()
            (root / "directory/file").write_bytes(data)
            result = self.read_payload(root, "/data/directory/file")
            self.assertEqual(result.returncode, 0, result.stderr)
            lines = result.stdout.splitlines()
            self.assertEqual(lines[0], b"CLOUDBENCH_FILE_BEGIN")
            self.assertEqual(
                b"".join(base64.b64decode(line, validate=True) for line in lines[1:-1]),
                data,
            )
            self.assertEqual(
                json.loads(lines[-1].split(b":", 1)[1]),
                {"sha256": hashlib.sha256(data).hexdigest(), "length": len(data)},
            )
            (root / "leaf-link").symlink_to(root / "directory/file")
            (root / "parent-link").symlink_to(root / "directory", target_is_directory=True)
            os.mkfifo(root / "fifo")
            for remote in [
                "/data/leaf-link",
                "/data/parent-link/file",
                "/data/fifo",
                "/data/../directory/file",
                "/tmp/foreign",
                "/data/directory/missing",
            ]:
                with self.subTest(remote=remote):
                    denied = self.read_payload(root, remote)
                    self.assertNotEqual(denied.returncode, 0)
                    self.assertNotIn(b"CLOUDBENCH_FILE_BEGIN", denied.stdout)
            self.assertEqual((root / "directory/file").read_bytes(), data)

    def export_case(self, payload, *, exit_code=0, hold=False, existing=None, destination_kind=None):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            binary = root / "bin"
            binary.mkdir()
            fake = binary / "flyctl"
            fake.write_text(
                "#!/usr/bin/python3\nimport os,sys,json,time\nfrom pathlib import Path\nPath(os.environ['FAKE_PID']).write_text(str(os.getpid()))\nPath(os.environ['FAKE_ARGS']).write_text(json.dumps(sys.argv[1:]))\nsys.stdout.buffer.write(Path(os.environ['FAKE_PAYLOAD']).read_bytes());sys.stdout.buffer.flush()\nif os.environ['FAKE_HOLD']=='1':time.sleep(30)\nsys.exit(int(os.environ['FAKE_EXIT']))\n"
            )
            fake.chmod(0o755)
            wire = root / "wire"
            wire.write_bytes(payload)
            output = root / "evidence"
            output.mkdir()
            local = output / "artifact"
            if existing is not None:
                local.write_bytes(existing)
            if destination_kind == "leaf-link":
                local.symlink_to(wire)
            elif destination_kind == "parent-link":
                alias = root / "alias"
                alias.symlink_to(output, target_is_directory=True)
                local = alias / "artifact"
            builder_calls = []
            proof = {"machine_id": "a" * 14}

            def builder(actual, command):
                self.assertEqual(actual, proof)
                self.assertIn("python3 -S -c", command)
                self.assertIn("/data/repo/artifact", command)
                builder_calls.append(command)
                return "verified-namespace-command"

            environment = {
                "PATH": str(binary) + ":" + os.environ["PATH"],
                "FAKE_PAYLOAD": str(wire),
                "FAKE_PID": str(root / "pid"),
                "FAKE_ARGS": str(root / "args"),
                "FAKE_HOLD": str(int(hold)),
                "FAKE_EXIT": str(exit_code),
            }
            error = None
            with patch.dict(os.environ, environment):
                try:
                    transport.export_file(proof, "/data/repo/artifact", str(local), builder)
                except (ValueError, OSError, TimeoutError) as caught:
                    error = caught
            self.assertEqual(len(builder_calls), 1)
            self.assertEqual(list(output.glob(".cloudbench-export-*")), [], "partial export leaked")
            if (root / "pid").exists():
                pid = int((root / "pid").read_text())
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
                args = json.loads((root / "args").read_text())
                self.assertEqual(
                    args,
                    [
                        "ssh",
                        "console",
                        "-a",
                        "navi-whisper-lux-bench",
                        "--machine",
                        "a" * 14,
                        "-C",
                        "verified-namespace-command",
                    ],
                )
            if existing is not None:
                self.assertEqual((output / "artifact").read_bytes(), existing)
            if destination_kind:
                self.assertEqual(wire.read_bytes(), payload)
            return (
                error,
                local.read_bytes() if local.is_file() and not local.is_symlink() else None,
            )

    def test_streamed_export_bytes_empty_and_matching_existing(self):
        data = bytes(range(256)) * 500
        for payload in (b"", data):
            error, actual = self.export_case(frame(payload))
            self.assertIsNone(error)
            self.assertEqual(actual, payload)
        error, actual = self.export_case(frame(data), existing=data)
        self.assertIsNone(error)
        self.assertEqual(actual, data)

    def test_bad_frames_and_child_failure_leave_no_partial_evidence(self):
        data = b"original evidence"
        for payload, code, hold in [
            (frame(data, digest="0" * 64), 0, False),
            (frame(data, length=999), 0, False),
            (b"CLOUDBENCH_FILE_BEGIN\n!!!!\n", 0, True),
            (b"CLOUDBENCH_FILE_BEGIN\nCLOUDBENCH_FILE_BEGIN\n", 0, False),
            (b"CLOUDBENCH_FILE_BEGIN\n", 0, False),
            (frame(data), 7, False),
            (frame(data)[:-1], 0, False),
            (b"x" * 70001, 0, False),
        ]:
            with self.subTest(payload=payload[:40], code=code):
                error, actual = self.export_case(payload, exit_code=code, hold=hold)
                self.assertIsNotNone(error)
                self.assertIsNone(actual)
        error, _ = self.export_case(frame(data), existing=b"preserve prior evidence")
        self.assertIsNotNone(error)

    def test_local_symlinks_rejected_without_overwriting_target(self):
        for kind in ("leaf-link", "parent-link"):
            error, _ = self.export_case(frame(b"new evidence"), destination_kind=kind)
            self.assertIsNotNone(error)


if __name__ == "__main__":
    unittest.main()
