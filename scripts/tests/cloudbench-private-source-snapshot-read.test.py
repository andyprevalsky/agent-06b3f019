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


if __name__ == '__main__':
    unittest.main()
