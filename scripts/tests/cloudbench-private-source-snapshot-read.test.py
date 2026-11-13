#!/usr/bin/env python3
"""Private fleet source admission re-reads a non-authoritative empty snapshot list.

The Machines API answered HTTP 200 with `[]` for an existing snapshot under concurrent
reads (11/14 on 2026-11-11), which turned one smoke job into an INFRA stop. The real
validate_private_fleet_source() must re-read until the selected snapshot appears, and
still fail closed when it never does.
"""
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'scripts' / 'run-bench-fleet'
SNAPSHOT = 'vs_selected'

HELPER = r'''import json, sys
inventory = json.load(sys.stdin)
sys.exit(0 if any(row.get("id") == "vs_selected" for row in inventory["snapshots"]) else 1)
'''


def function(name: str) -> str:
    return re.search(r'^' + re.escape(name) + r'\(\) \{.*?^\}\n', SOURCE.read_text(), re.M | re.S).group()


class PrivateSourceSnapshotRead(unittest.TestCase):
    def run_case(self, empty_reads: int) -> tuple[subprocess.CompletedProcess, list[str]]:
        with tempfile.TemporaryDirectory() as case:
            helper = Path(case) / 'helper.py'
            helper.write_text(HELPER)
            script = function('validate_private_fleet_source') + r'''
FLY() {
  printf '%s\n' "$*" >> "$CASE/calls"
  case "$1 $2" in
    'machines list') printf '[]' ;;
    'volumes list') printf '[]' ;;
    'volume snapshots')
      n=$(grep -c '^volume snapshots' "$CASE/calls")
      if [ "$n" -le "$EMPTY_READS" ]; then printf '[]'; else printf '[{"id":"%s"}]' "$SNAPSHOT"; fi ;;
    *) return 9 ;;
  esac
}
sleep() { printf 'sleep %s\n' "$1" >> "$CASE/calls"; }
validate_private_fleet_source
'''
            env = {**os.environ, 'CASE': case, 'EMPTY_READS': str(empty_reads), 'SNAPSHOT': SNAPSHOT,
                   'PRIVATE_SOURCE_SNAPSHOT': SNAPSHOT, 'PRIVATE_SOURCE_VOLUME_ID': 'vol_source',
                   'PRIVATE_SOURCE_FILE': '/dev/null', 'PRIVATE_SOURCE_SHA256': 'x', 'APP': 'fixture',
                   'WARM_PARKED_VM_MEMORY': '2048', 'SOURCE_HELPER': str(helper)}
            result = subprocess.run(['bash', '-c', 'set -u\n' + script], env=env, capture_output=True,
                                    text=True, timeout=60)
            return result, (Path(case) / 'calls').read_text().splitlines()

    def test_transient_empty_lists_are_reread_until_the_snapshot_appears(self):
        result, calls = self.run_case(empty_reads=2)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(3, sum(c.startswith('volume snapshots') for c in calls))
        self.assertEqual(['sleep 2', 'sleep 4'], [c for c in calls if c.startswith('sleep')])

    def test_first_complete_list_is_used_without_rereading(self):
        result, calls = self.run_case(empty_reads=0)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(1, sum(c.startswith('volume snapshots') for c in calls))

    def test_a_snapshot_that_never_appears_still_fails_closed_after_bounded_reads(self):
        result, calls = self.run_case(empty_reads=99)
        self.assertNotEqual(0, result.returncode)
        self.assertEqual(6, sum(c.startswith('volume snapshots') for c in calls))


class WarmSnapshotEpochRead(unittest.TestCase):
    """warm_deps_preflight re-reads a fresh listing that omits the recorded snapshot."""

    def run_case(self, empty_reads: int, native: str = '') -> tuple[subprocess.CompletedProcess, list[str]]:
        with tempfile.TemporaryDirectory() as case:
            state = Path(case) / 'receipt'
            state.write_text(f'node python 1791903927 {SNAPSHOT}\n')
            listing = native or (
                'n=$(grep -c "^volume snapshots" "$CASE/calls")\n'
                '  if [ "$n" -le "$EMPTY_READS" ]; then printf "[]"\n'
                '  else printf \'[{"id":"%s","created_at":"2026-10-13T15:06:27Z"}]\' "$SNAPSHOT"; fi')
            script = '\n'.join([
                'set -uo pipefail', 'PRIVATE_SOURCE_FILE=""', 'APP=fixture', 'VOL_ID=vol_owned',
                f'SNAP_ID={SNAPSHOT}', 'ROOT_DIR=fixture', 'BENCH_REF=fixture', 'warm_json="[]"',
                'CLOUDBENCH_WARM_DEPS_AUTOREFRESH=0', 'CLOUDBENCH_PYTHON_MANIFESTS=(agents/requirements.txt)',
                f'WARM_DEPS_STATE_FILE={state}', 'HYDRATED_WARM_DEPS_STATE=""', 'touch "$CASE/calls"',
                'FLY() {\n  printf "%s\\n" "$*" >> "$CASE/calls"\n  ' + listing + '\n}',
                'sleep() { printf "sleep %s\\n" "$1" >> "$CASE/calls"; }',
                'cloudbench_node_dependency_fingerprint() { printf node; }',
                'cloudbench_manifest_fingerprint() { printf python; }', 'git() { return 0; }',
                function('warm_deps_recorded_state'), function('snapshot_created_epoch'),
                function('warm_deps_preflight'), 'warm_deps_preflight'])
            env = {**os.environ, 'CASE': case, 'EMPTY_READS': str(empty_reads), 'SNAPSHOT': SNAPSHOT}
            result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True, timeout=60)
            return result, (Path(case) / 'calls').read_text().splitlines()

    def test_transient_empty_listing_is_reread_until_the_snapshot_appears(self):
        result, calls = self.run_case(empty_reads=2)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual(3, sum(c.startswith('volume snapshots') for c in calls))
        self.assertEqual(['sleep 2', 'sleep 4'], [c for c in calls if c.startswith('sleep')])

    def test_snapshot_that_never_appears_fails_closed_after_six_reads(self):
        result, calls = self.run_case(empty_reads=99)
        self.assertEqual(1, result.returncode)
        self.assertIn('refusing maintenance', result.stderr)
        self.assertEqual(6, sum(c.startswith('volume snapshots') for c in calls))

    def test_failed_provider_read_refuses_without_rereading(self):
        result, calls = self.run_case(empty_reads=0, native='return 75')
        self.assertEqual(1, result.returncode)
        self.assertEqual(1, sum(c.startswith('volume snapshots') for c in calls))
        self.assertEqual([], [c for c in calls if c.startswith('sleep')])

if __name__ == '__main__':
    unittest.main()
