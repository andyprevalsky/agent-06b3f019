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
        # A final rate response is the end of the bounded pre-allocation
        # throttle window (zero here), not of the ambiguous-failure attempt cap.
        for rate, attempts, window in (('resource_exhausted', 2, '600'), ('429', 2, '600'), ('429', 1, '0')):
            with self.subTest(rate=rate, attempts=attempts, window=window), tempfile.TemporaryDirectory(prefix='clone-rate-response-') as temporary:
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
                                        env=dict(os.environ, ROOT_DIR=os.environ.get("CLOUDBENCH_TEST_CLONE_RATE_SOURCE_ROOT", str(ROOT)), TMP_ROOT=str(root), FLEET_BENCH_APP='fixture',
                                                 CLOUDBENCH_CLONE_RATE_LIMIT_WINDOW_SECONDS=window),
                                        capture_output=True, text=True, timeout=15)
                if window != '0':
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

    def test_preallocation_rate_limit_outlasts_attempt_cap_within_bounded_window(self):
        """run600c: 600 clones from one donor exhausted 5 attempts on its source GET.

        `flyctl machine clone` reads the source Machine before allocating
        anything. A provider throttle on that read (or on target-volume
        creation) is proven allocation-free by the existing single-error
        classifier, so it must not spend the bounded ambiguous-failure cap:
        keep retrying with capped jittered backoff until a bounded window.
        Ambiguous and ordinary failures keep the existing attempt cap.
        """
        fixture = (ROOT / 'scripts/tests/cloudbench-multi-workstream.test.sh').read_text()
        start = fixture.index('fleet_production_function() {')
        loader = fixture[start:fixture.index('\n}\n', start) + 3]
        start = fixture.index('clone_source_read_rate_limit_contract() (')
        contract = fixture[start:fixture.index('\n)\n', start) + 3]
        captured = ('Error: could not get machine 683e47df5094d8: failed to get VM 683e47df5094d8: '
                    'resource_exhausted: rate limit exceeded (Request ID: captured-lax)')
        http_429 = ('Error: could not get machine 683e47df5094d8: failed to get VM 683e47df5094d8: '
                    'request returned non-2xx status, 429: rate limit exceeded (Request ID: 01M579N6AW6G9HD07ENBZA47E7-iad)')
        volume = 'Error: failed to create volume: resource_exhausted: rate limit exceeded'
        ordinary = ('Error: could not get machine 683e47df5094d8: failed to get VM 683e47df5094d8: '
                    'unavailable: upstream connect error (Request ID: captured-lax)')
        ambiguous = captured + '\\nError: failed to launch VM: resource_exhausted: rate limit exceeded'
        # (label, provider error, consecutive failures, expect success, expected clone calls)
        cases = (
            ('source-resource-exhausted', captured, 7, True, 8),
            ('source-http-429', http_429, 7, True, 8),
            ('target-volume-rate-limit', volume, 7, True, 8),
            ('window-exhausted', captured, 1000, False, None),
            ('ordinary-preallocation-cap', ordinary, 1000, False, 5),
            ('ambiguous-rate-limit-cap', ambiguous, 1000, False, 5),
        )
        for label, error, failures, succeeds, expected_calls in cases:
            with self.subTest(case=label), tempfile.TemporaryDirectory(prefix='clone-rate-window-') as temporary:
                root = Path(temporary)
                injected = '''
    CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION=1
    FLEET_OWNER_PID_START=fixture
    cloudbench_mutation_admission() { printf '%s\\n' "$*" >> "$TMP_ROOT/backoff.calls"; }
'''
                case = contract.replace('    mkdir -p "$(dirname "$ledger")"', injected + '\n    mkdir -p "$(dirname "$ledger")"')
                self.assertIn(captured, case)
                case = case.replace('printf \'%s\\n\' \\\n                "' + captured + '"',
                                    'printf \'%b\\n\' \\\n                "' + error + '"')
                self.assertIn(error, case)
                # Production retry policy: default attempt cap and backoff.
                for knob in ('CLOUDBENCH_CLONE_MAX_ATTEMPTS=2', 'CLOUDBENCH_CLONE_RETRY_SECONDS=0',
                             'CLOUDBENCH_CLONE_RETRY_MAX_SECONDS=0'):
                    self.assertIn(knob, case)
                    case = case.replace(knob, 'unset ' + knob.split('=')[0])
                case = case.replace('if [ "$call_count" -eq 1 ]; then', 'if [ "$call_count" -le "$FAILURES" ]; then')
                case = case.replace('[ "$call_count" -eq 2 ]', '[ "$call_count" -eq $((FAILURES + 1)) ]')
                # Simulated clock: every requested sleep advances bash SECONDS.
                case = case.replace('sleep() { :; }',
                                    'sleep() { printf \'%s\\n\' "$1" >> "$TMP_ROOT/sleep.calls"; SECONDS=$((SECONDS + ${1%.*})); }')
                env = {key: value for key, value in os.environ.items()
                       if not key.startswith('CLOUDBENCH_CLONE_')}
                env.update(ROOT_DIR=os.environ.get('CLOUDBENCH_TEST_CLONE_RATE_SOURCE_ROOT', str(ROOT)),
                           TMP_ROOT=str(root), FLEET_BENCH_APP='fixture', FAILURES=str(failures))
                result = subprocess.run(['bash', '-c', loader + case + '\nclone_source_read_rate_limit_contract\n'],
                                        env=env, capture_output=True, text=True, timeout=30)
                calls = len((root / 'clone-source-rate-limit.calls').read_text().splitlines())
                stderr = (root / 'clone-source-rate-limit.err').read_text()
                sleeps = [int(value) for value in (root / 'sleep.calls').read_text().split()] \
                    if (root / 'sleep.calls').exists() else []
                names = root / 'clone-source-rate-limit/primary.names'
                if succeeds:
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr + stderr)
                    self.assertEqual((root / 'clone-source-rate-limit.out').read_text(), 'abcdef12345678')
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn('abcdef12345678', (root / 'clone-source-rate-limit.out').read_text())
                if expected_calls is not None:
                    self.assertEqual(calls, expected_calls, stderr)
                # Allocation-free attempts never leave a durable name behind.
                self.assertEqual(names.read_text() if names.exists() else '', '', stderr)
                self.assertTrue(all(delay >= 1 for delay in sleeps), sleeps)
                backoffs = (root / 'backoff.calls').read_text().splitlines() if (root / 'backoff.calls').exists() else []
                if label == 'window-exhausted':
                    # Uncharged retries continue past the cap, but only inside
                    # the bounded window, which fits the 900 s readiness target.
                    self.assertGreater(calls, 5)
                    self.assertLessEqual(sum(sleeps), 600, sleeps)
                    self.assertIn('rate limit persisted', stderr)
                    self.assertIn('600s', stderr)
                    self.assertEqual(len(backoffs), calls)
                elif label == 'ordinary-preallocation-cap':
                    self.assertIn('after 5 attempt(s)', stderr)
                    self.assertEqual(backoffs, [])
                elif label == 'ambiguous-rate-limit-cap':
                    self.assertIn('after 5 attempt(s)', stderr)
                else:
                    self.assertEqual(len(backoffs), failures)
                    self.assertIn('not charged', stderr)


if __name__ == '__main__':
    unittest.main()
