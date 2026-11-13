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
