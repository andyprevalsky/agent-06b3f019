#!/usr/bin/env python3
"""Actual reserve entry: native owner identity and bounded process enumeration."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ.get("CLEANUP_SCAN_SOURCE", ROOT / "scripts/run-bench-fleet"))

# Instrument only process discovery and the fixture filesystem namespace. Real
# ps, flock, posix_fallocate, block verification, fsync and state writes execute.
TRANSPORT = r'''
import json, os, subprocess, sys
from pathlib import Path
real_lstat = Path.lstat
def lstat(path, *args, **kwargs):
    value = real_lstat(path, *args, **kwargs)
    if str(path) == os.environ['SCAN_PARENT']:
        fields = list(value); fields[2] = int(os.environ['SCAN_DEVICE'])
        return os.stat_result(fields)
    return value
Path.lstat = lstat
run = subprocess.run
owner = int(sys.argv[8])
birth_reads = 0
target_reads = 0
def observed(args, *a, **kw):
    global birth_reads, target_reads
    result = run(args, *a, **kw)
    if args[0] != 'ps': return result
    with open(os.environ['SCAN_LOG'], 'a') as stream:
        stream.write(json.dumps({'args': args, 'tz': kw.get('env', {}).get('TZ')}) + '\n')
    mode = os.environ.get('SCAN_FAULT', '')
    if args[-1] in ('pid=,lstart=', 'pid=,ppid=,lstart='):
        birth_reads += 1
        if mode in ('initial-absent', 'snapshot-miss') and birth_reads == 1:
            result.stdout = '\n'.join(line for line in result.stdout.splitlines()
                                      if line.split()[0] != str(owner))
        # Covers both the original whole snapshot and the new targeted check.
        final = birth_reads == 2
    else:
        if args == ['ps', '-p', str(owner), '-o', 'lstart=']:
            target_reads += 1
        final = target_reads == 2 and args == ['ps', '-p', str(owner), '-o', 'lstart=']
    if mode == 'initial-absent' and args == ['ps', '-p', str(owner), '-o', 'lstart=']:
        result.stdout = ''
    if final and mode in ('reused', 'final-absent', 'final-error', 'whitespace'):
        if mode == 'final-error':
            raise subprocess.CalledProcessError(1, args)
        stamp = '' if mode == 'final-absent' else 'Sat Jan  1 00:00:00 2000'
        if args[-1] == 'lstart=':
            result.stdout = (' \t' + result.stdout.replace(' ', '  ') + '\n') if mode == 'whitespace' else stamp
        elif mode != 'whitespace':
            rows = []
            for line in result.stdout.splitlines():
                fields = line.split(None, 1)
                if fields[0] == str(owner):
                    if stamp: rows.append(fields[0] + ' ' + stamp)
                else: rows.append(line)
            result.stdout = '\n'.join(rows)
    return result
subprocess.run = observed
'''


class CleanupAdmissionScans(unittest.TestCase):
    def entry(self, fault=""):
        script = SOURCE.read_text()
        begin = script.index("reserve_cleanup_disk_space() {")
        end = script.index("\nrelease_cleanup_disk_reserve() {", begin)
        with tempfile.TemporaryDirectory(prefix="cleanup-scan-entry-") as temporary:
            root = Path(temporary)
            transport = root / "transport"
            transport.mkdir()
            (transport / "sitecustomize.py").write_text(TRANSPORT)
            reserve = root / "cleanup-disk-reserve"
            log = root / "ps.jsonl"
            device = int(hashlib.sha256(str(root).encode()).hexdigest()[:12], 16)
            admission = Path("/tmp") / ("rose-cloudbench-cleanup-admission-" + str(os.getuid())) / str(device)
            env = dict(os.environ, PYTHONPATH=str(transport), SCAN_PARENT=str(root),
                       SCAN_DEVICE=str(device), SCAN_LOG=str(log), SCAN_FAULT=fault,
                       CLOUDBENCH_CLEANUP_DISK_RESERVE_MB="1",
                       CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB="1",
                       CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB="0")
            # Invoke the actual shell function, which supplies its own real $$.
            command = 'set -uo pipefail\nCLEANUP_DISK_RESERVE_FILE="$1"\n' + script[begin:end] + '\nreserve_cleanup_disk_space\n'
            try:
                result = subprocess.run(["bash", "-c", command, "fixture", str(reserve)],
                                        env=env, capture_output=True, text=True, timeout=20)
                calls = [json.loads(row) for row in log.read_text().splitlines()]
                state = json.loads((admission / "state.json").read_text()) if (admission / "state.json").exists() else None
                blocks = reserve.stat().st_blocks * 512 if reserve.exists() else None
                return result, calls, state, blocks
            finally:
                # This random fixture-only device namespace has no live children.
                shutil.rmtree(admission, ignore_errors=True)

    def test_actual_entry_allocates_with_one_global_and_two_targeted_birth_scans(self):
        result, calls, state, blocks = self.entry()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([row["args"][:2] for row in calls], [["ps", "-axo"], ["ps", "-p"], ["ps", "-p"]])
        self.assertEqual(calls[0]["args"][-1], "pid=,ppid=,lstart=")
        self.assertEqual(calls[1]["args"][-2:], ["-o", "lstart="])
        self.assertTrue(all(row["tz"] == "UTC" for row in calls))
        self.assertGreaterEqual(blocks, 1048576)
        self.assertEqual(sum(len(group["consumed"]) for group in state["groups"].values()), 1)

    def test_changed_owner_birth_refuses_and_removes_exact_allocation(self):
        result, _, state, blocks = self.entry("reused")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("owner identity changed", result.stderr)
        self.assertFalse(state and any(group["consumed"] for group in state["groups"].values()))
        self.assertIsNone(blocks)

    def test_initial_owner_absent_refuses_before_allocation(self):
        result, calls, state, blocks = self.entry("initial-absent")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("initial owner identity is unavailable", result.stderr)
        self.assertEqual(len(calls), 2)
        self.assertFalse(state and any(group["consumed"] for group in state["groups"].values()))
        self.assertIsNone(blocks)

    def test_missing_snapshot_owner_requires_fresh_targeted_native_lookup(self):
        result, calls, state, blocks = self.entry("snapshot-miss")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(row["args"][:2] == ["ps", "-axo"] for row in calls), 1)
        self.assertEqual(sum(row["args"][:2] == ["ps", "-p"] for row in calls), 3)
        self.assertTrue(state)
        self.assertGreaterEqual(blocks, 1048576)

    def test_final_owner_absent_refuses_and_removes_allocation(self):
        result, _, state, blocks = self.entry("final-absent")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(state and any(group["consumed"] for group in state["groups"].values()))
        self.assertIsNone(blocks)

    def test_final_ps_failure_refuses_and_removes_allocation(self):
        result, _, state, blocks = self.entry("final-error")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(state and any(group["consumed"] for group in state["groups"].values()))
        self.assertIsNone(blocks)

    def test_final_birth_whitespace_keeps_original_normalization(self):
        result, _, state, blocks = self.entry("whitespace")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNotNone(state)
        self.assertGreaterEqual(blocks, 1048576)


if __name__ == "__main__":
    unittest.main()
