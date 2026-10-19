#!/usr/bin/env python3
"""Owning local controls for full-validation build and bounded selected-row read."""

import copy
import hashlib
import json
import os
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
H = runpy.run_path(str(ROOT / "scripts/cloudbench-reuse-index.py"))
V = runpy.run_path(str(ROOT / "scripts/cloudbench-archived-machine-reuse.py"))[
    "validate_request"
]
REF = "a" * 40
SHA = lambda raw: hashlib.sha256(raw).hexdigest()
ENC = H["encoded"]


def request(width=600):
    image = "registry.fly.io/test@sha256:" + "1" * 64
    rows = [
        {
            "machine_id": f"{i + 1:014x}",
            "volume_id": f"vol_{i + 1:x}",
            "source_instance_id": f"instance{i}",
            "source_config_sha256": "2" * 64,
            "image_ref": image,
            "archive_sha256": "3" * 64,
            "padding": "x" * 20000,
            "special": '[candidate] " \\ \u2603',
        }
        for i in range(width)
    ]
    return {
        "schema": "cloudbench-archived-reuse-v1",
        "storage_mode": "retained-volume-fresh-generation",
        "app": "navi-whisper-lux-bench",
        "harness_ref": REF,
        "task_ref": H["TASK_REF"],
        "cohort": "4" * 32,
        "task_names": json.loads(
            (ROOT / "scripts/tests/fixtures/original600-tasks.json").read_text()
        ),
        "image_ref": image,
        "archives": [{"archive_sha256": "3" * 64}],
        "candidates": rows,
    }


class ReuseIndexTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="reuse-index-owning-")
        cls.directory = Path(cls.temp.name)
        cls.golden = request()
        cls.raw = ENC(cls.golden)
        cls.index = H["build"](cls.raw, SHA(cls.raw), REF, V)
        cls.req = cls.directory / "request.json"
        cls.idx = cls.directory / "index.json"
        for p, b in [(cls.req, cls.raw), (cls.idx, cls.index)]:
            p.write_bytes(b)
            p.chmod(0o600)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def select(self, index, req=None, idx=None, request_sha=None, index_sha=None):
        return H["select"](
            req or self.req,
            request_sha or SHA(self.raw),
            idx or self.idx,
            index_sha or SHA(self.index),
            index,
        )

    def private(self, name, raw):
        p = self.directory / name
        p.write_bytes(raw)
        p.chmod(0o600)
        return p

    def test_selected_golden_and_unassigned_no_full_request_parse(self):
        calls = []
        original = H["DECODER"]

        class Decoder:
            def decode(self, text):
                calls.append(len(text))
                return original.decode(text)

            def raw_decode(self, text, pos=0):
                return original.raw_decode(text, pos)

        with mock.patch.dict(H["select"].__globals__, DECODER=Decoder()):
            for i in [0, 299, 599]:
                header, row = self.select(i)
                self.assertEqual(row, self.golden["candidates"][i])
                self.assertEqual(header["task_names"], self.golden["task_names"])
            small = request(2)
            raw = ENC(small)
            idx = H["build"](raw, SHA(raw), REF, V)
            header, row = self.select(
                4,
                self.private("small.json", raw),
                self.private("small-index.json", idx),
                SHA(raw),
                SHA(idx),
            )
            self.assertIsNone(row)
        self.assertLess(max(calls), len(self.raw) // 10)

    def test_entire_huge_nonselected_invalid_row_refuses_before_index(self):
        bad = copy.deepcopy(self.golden)
        bad["candidates"][-1]["source_config_sha256"] = "invalid"
        raw = ENC(bad)
        with self.assertRaisesRegex(ValueError, "native version/config"):
            H["build"](raw, SHA(raw), REF, V)
        bad["candidates"][-1]["source_config_sha256"] = "2" * 64
        bad["candidates"][-1]["machine_id"] = bad["candidates"][0]["machine_id"]
        raw = ENC(bad)
        with self.assertRaisesRegex(ValueError, "duplicate Machine/Volume"):
            H["build"](raw, SHA(raw), REF, V)

    def test_changed_raw_index_offsets_hash_and_source_ref_refuse(self):
        raw = self.raw[:-2] + b" \n"
        with self.assertRaises(ValueError):
            self.select(0, req=self.private("changed.json", raw))
        altered = self.index.replace(
            b"cloudbench-reuse-index-v1", b"cloudbench-reuse-index-v0"
        )
        with self.assertRaises(ValueError):
            self.select(0, idx=self.private("changed-index.json", altered))
        for key, change in [("offset", 1), ("length", -1), ("sha256", "0" * 64)]:
            with self.subTest(key=key):
                value = json.loads(self.index)
                entry = value["entries"][0]
                entry[key] = entry[key] + change if isinstance(change, int) else change
                altered = ENC(value)
                with self.assertRaises(ValueError):
                    self.select(
                        0,
                        idx=self.private("range-" + key + ".json", altered),
                        index_sha=SHA(altered),
                    )
        with self.assertRaises(ValueError):
            H["build"](self.raw, SHA(self.raw), "b" * 40, V)

    def test_duplicate_noncanonical_and_unsafe_private_inputs_refuse(self):
        for raw in [
            self.raw.replace(b"{", b'{"schema": "duplicate", ', 1),
            json.dumps(self.golden, sort_keys=True, separators=(",", ":")).encode(),
            self.raw.replace(b'"schema":', b'"schema" :', 1),
        ]:
            with self.subTest(size=len(raw)), self.assertRaises(ValueError):
                H["build"](raw, SHA(raw), REF, V)
        link = self.directory / "symlink.json"
        link.symlink_to(self.req)
        with self.assertRaises(ValueError):
            self.select(0, req=link)
        unsafe = self.private("unsafe.json", self.raw)
        unsafe.chmod(0o644)
        with self.assertRaises(ValueError):
            self.select(0, req=unsafe)
        for i in [-1, 600, True]:
            with self.assertRaises(ValueError):
                self.select(i)

    def test_private_fd_replacement_during_stream_hash_refuses(self):
        target = self.private("replaced.json", self.raw)
        original = H["hashlib"].sha256
        count = [0]

        class Hash:
            def __init__(self, *args):
                self.inner = original(*args)

            def update(self, chunk):
                self.inner.update(chunk)
                count[0] += 1
                if count[0] == 1:
                    replacement = self.private_replacement()
                    os.replace(replacement, target)

            def private_replacement(self):
                p = target.with_suffix(".replacement")
                p.write_bytes(ReuseIndexTests.raw)
                p.chmod(0o600)
                return p

            def hexdigest(self):
                return self.inner.hexdigest()

        with (
            mock.patch.object(H["hashlib"], "sha256", Hash),
            self.assertRaisesRegex(ValueError, "changed during read"),
        ):
            self.select(0, req=target)

    def test_selected_process_peak_is_small_against_full_parse_operand(self):
        code = r"""
import json,runpy,sys,tracemalloc,resource
from pathlib import Path
h=runpy.run_path(sys.argv[1]);tracemalloc.start()
if sys.argv[2]=='index':
 header,row=h['select'](sys.argv[3],sys.argv[4],sys.argv[5],sys.argv[6],0)
 assert row['machine_id']=='00000000000001'
else:
 raw=Path(sys.argv[3]).read_bytes();tree=json.loads(raw)
 assert tree['candidates'][0]['machine_id']=='00000000000001'
status=dict(line.split(':',1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
print(json.dumps(dict(peak_python_bytes=tracemalloc.get_traced_memory()[1],vm_hwm_kib=int(status['VmHWM'].split()[0]),maxrss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)))
"""
        result = {}
        for mode in ["full", "index"]:
            p = subprocess.run(
                [
                    sys.executable,
                    "-S",
                    "-c",
                    code,
                    str(ROOT / "scripts/cloudbench-reuse-index.py"),
                    mode,
                    str(self.req),
                    SHA(self.raw),
                    str(self.idx),
                    SHA(self.index),
                ],
                capture_output=True,
                text=True,
                timeout=30,
                check=True,
            )
            result[mode] = json.loads(p.stdout)
        print(
            "MEMORY_OBSERVATION "
            + json.dumps(
                {
                    "operand_bytes": len(self.raw),
                    "index_bytes": len(self.index),
                    "results": result,
                }
            ),
            flush=True,
        )
        self.assertLess(
            result["index"]["peak_python_bytes"],
            result["full"]["peak_python_bytes"] // 4,
        )
        # ru_maxrss can inherit the fixture parent's pre-exec high-water mark.
        self.assertLess(result["index"]["vm_hwm_kib"], result["full"]["vm_hwm_kib"])


if __name__ == "__main__":
    unittest.main()
