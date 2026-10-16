#!/usr/bin/env python3
"""Actual clone retry publishes shared backoff only after a rate response."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class CloneRateResponse(unittest.TestCase):
    def test_actual_reconciled_clone_retry_publishes_bounded_rate_event(self):
        fixture = (ROOT / 'scripts/tests/cloudbench-multi-workstream.test.sh').read_text()
        start = fixture.index('fleet_production_function() {')
        loader = fixture[start:fixture.index('\n}\n', start) + 3]
        start = fixture.index('clone_source_read_rate_limit_contract() (')
        contract = fixture[start:fixture.index('\n)\n', start) + 3]
        for rate, attempts in (('resource_exhausted', 2), ('429', 2), ('429', 1)):
            with self.subTest(rate=rate, attempts=attempts), tempfile.TemporaryDirectory(prefix='clone-rate-response-') as temporary:
                root = Path(temporary)
                # Existing production clone fixture performs real shell retry,
                # definitive no-allocation audit, and successful second launch.
                injected = '''
    CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION=1
    FLEET_OWNER_PID_START=fixture
    cloudbench_mutation_admission() { printf '%s\\n' "$*" >> "$TMP_ROOT/backoff.calls"; }
'''
                case = contract.replace('    mkdir -p "$(dirname "$ledger")"', injected + '\n    mkdir -p "$(dirname "$ledger")"')
                case = case.replace('resource_exhausted: rate limit exceeded', rate + ': rate limit exceeded')
                case = case.replace('CLOUDBENCH_CLONE_MAX_ATTEMPTS=2', 'CLOUDBENCH_CLONE_MAX_ATTEMPTS=' + str(attempts))
                case = case.replace('sleep() { :; }', 'sleep() { printf sleep >> "$TMP_ROOT/sleep.calls"; }')
                result = subprocess.run(['bash', '-c', loader + case + '\nclone_source_read_rate_limit_contract\n'],
                                        env=dict(os.environ, ROOT_DIR=os.environ.get("CLOUDBENCH_TEST_CLONE_RATE_SOURCE_ROOT", str(ROOT)), TMP_ROOT=str(root), FLEET_BENCH_APP='fixture'),
                                        capture_output=True, text=True, timeout=15)
                if attempts == 2:
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual((root / 'clone-source-rate-limit.calls').read_text().splitlines(), ['1'])
                    self.assertFalse((root / 'sleep.calls').exists())
                    self.assertIn('after 1 attempt(s)', (root / 'clone-source-rate-limit.err').read_text())
                calls = (root / 'backoff.calls').read_text().splitlines()
                self.assertEqual(len(calls), 1)
                self.assertIn(' backoff ', calls[0])
                self.assertIn('--response-code ' + rate, calls[0])
                delay = int(calls[0].split('--retry-after ')[1].split()[0])
                self.assertGreaterEqual(delay, 1)
                self.assertLessEqual(delay, 90)


if __name__ == '__main__':
    unittest.main()
