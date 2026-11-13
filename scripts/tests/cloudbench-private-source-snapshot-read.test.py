#!/usr/bin/env python3
"""Private fleet source admission re-reads a non-authoritative empty snapshot list.

The Machines API answered HTTP 200 with `[]` for an existing snapshot under concurrent
reads (11/14 on 2026-11-11), which turned one smoke job into an INFRA stop. The real
validate_private_fleet_source() must re-read until the selected snapshot appears, and
still fail closed when it never does.

The function now journals every original read privately and holds the source lease
across reads (PR1910); these scenarios drive it through the owning lease-fleet harness
(scripts/tests/cloudbench-source-lease-fleet.test.py) with the real bounded reader.
"""
import runpy
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HARNESS = runpy.run_path(str(ROOT / 'scripts/tests/cloudbench-source-lease-fleet.test.py'))['PrivateSourceSnapshotReads']


class PrivateSourceSnapshotRead(unittest.TestCase):
    def run_case(self, empty_reads: int):
        replies = [HARNESS.EMPTY] * empty_reads + [HARNESS.HEALTHY]
        result, calls, files, modes, sleeps = HARNESS('validation').validation(replies)
        snapshot_reads = sum(call[:3] == ['volume', 'snapshots', 'list'] for call in calls)
        return result, snapshot_reads, sleeps

    def test_transient_empty_lists_are_reread_until_the_snapshot_appears(self):
        result, snapshot_reads, sleeps = self.run_case(empty_reads=2)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(3, snapshot_reads)
        self.assertEqual(2, len(sleeps))
        self.assertTrue(all(5 * i <= v <= 5 * i + 3 for i, v in enumerate(sleeps, 1)), sleeps)

    def test_first_complete_list_is_used_without_rereading(self):
        result, snapshot_reads, sleeps = self.run_case(empty_reads=0)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(1, snapshot_reads)
        self.assertEqual([], sleeps)

    def test_a_snapshot_that_never_appears_still_fails_closed_after_bounded_reads(self):
        result, snapshot_reads, sleeps = self.run_case(empty_reads=99)
        self.assertNotEqual(0, result.returncode)
        self.assertEqual(12, snapshot_reads)
        self.assertIn('remained empty after 12 bounded reads', result.stderr)


if __name__ == '__main__':
    unittest.main()
