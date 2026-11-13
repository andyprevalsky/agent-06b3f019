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
    """warm_deps_preflight's snapshot_created_epoch: an omitted snapshot is re-read, not refused."""

    def run_case(self, empty_reads: int, inventory: str = '') -> tuple[subprocess.CompletedProcess, list[str]]:
        with tempfile.TemporaryDirectory() as case:
            script = function('snapshot_created_epoch') + function('snapshot_epoch_from_inventory') + r'''
FLY() {
  printf '%s\n' "$*" >> "$CASE/calls"
  n=$(grep -c '^volume snapshots' "$CASE/calls")
  if [ "$n" -le "$EMPTY_READS" ]; then printf '[]'
  else printf '[{"id":"%s","created_at":"2026-11-13T02:00:00Z"}]' "$SNAPSHOT"; fi
}
sleep() { printf 'sleep %s\n' "$1" >> "$CASE/calls"; }
touch "$CASE/calls"
if [ -n "$INVENTORY" ]; then snapshot_created_epoch "$SNAPSHOT" "$INVENTORY"; else snapshot_created_epoch "$SNAPSHOT"; fi
'''
            env = {**os.environ, 'CASE': case, 'EMPTY_READS': str(empty_reads), 'SNAPSHOT': SNAPSHOT,
                   'INVENTORY': inventory, 'VOL_ID': 'vol_donor', 'APP': 'fixture'}
            result = subprocess.run(['bash', '-c', 'set -u\n' + script], env=env, capture_output=True,
                                    text=True, timeout=60)
            return result, (Path(case) / 'calls').read_text().splitlines()

    def test_transient_empty_listing_is_reread_until_the_snapshot_appears(self):
        result, calls = self.run_case(empty_reads=2)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual('1794535200', result.stdout.strip())
        self.assertEqual(['sleep 2', 'sleep 4'], [c for c in calls if c.startswith('sleep')])

    def test_snapshot_that_never_appears_fails_closed_after_six_reads(self):
        result, calls = self.run_case(empty_reads=99)
        self.assertEqual(1, result.returncode)
        self.assertIn('exact snapshot absent', result.stderr)
        self.assertEqual(6, sum(c.startswith('volume snapshots') for c in calls))

    def test_captured_inventory_is_never_reread(self):
        result, calls = self.run_case(empty_reads=0, inventory='[]')
        self.assertEqual(1, result.returncode)
        self.assertEqual([], calls)


if __name__ == '__main__':
    unittest.main()
