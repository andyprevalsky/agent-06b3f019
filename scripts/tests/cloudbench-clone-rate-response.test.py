#!/usr/bin/env python3
"""Actual clone retry publishes shared backoff only after a rate response."""
import os
import json
import re
import shlex
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



class FreshImageHandoff(unittest.TestCase):
    """Actual shell admission, child handoff and owned skip-start update; no Fly calls."""
    def source(self, name):
        root = Path(os.environ.get('CLOUDBENCH_TEST_CLONE_RATE_SOURCE_ROOT', ROOT))
        return (root / 'scripts' / name).read_text()

    def function(self, source, name):
        match = re.search(r'^' + re.escape(name) + r'\(\).*?^}\n', source, re.M | re.S)
        self.assertIsNotNone(match, name)
        return match.group()

    def probe(self, *, fee='good', mode='fresh', supplied=None):
        fleet, cloud, lib = (self.source(n) for n in ('run-bench-fleet', 'run-bench-cloud', 'lib/cloudbench-env.sh'))
        admitted = 'registry.fly.io/fixture:admitted@sha256:' + 'a' * 64
        changed = 'registry.fly.io/fixture:changed@sha256:' + 'b' * 64
        image = admitted if fee not in ('tag', 'resolved') else 'registry.fly.io/fixture:admitted'
        row = {'id': '683e47df5094d8', 'config': {'image': image, 'metadata': {
            'rose_cloudbench_image_deps': image + ' ' + 'c' * 64 + ' ' + 'd' * 64}}}
        if fee == 'resolved': row['image_ref'] = {'digest': 'sha256:' + 'a' * 64}
        if fee == 'mismatch': row['image_ref'] = {'digest': 'sha256:' + 'b' * 64}
        if fee == 'malformed_ref': row['image_ref'] = ['not-a-provider-image-ref']
        setup = self.function(lib, 'cloudbench_warm_image_deps_match')
        setup += self.function(fleet, 'fresh_image_deps_admission')
        setup += self.function(fleet, 'primary_clone_storage_mode')
        setup += '\nWARM_ID=683e47df5094d8;SNAP_ID=vs_proven;FRESH_VOLUMES=1;FRESH_VOLUMES_REQUESTED=1\n'
        setup += 'PRIVATE_SOURCE_FILE="";CURRENT_NODE_FP=' + 'c' * 64 + ';CURRENT_PY_FP=' + 'd' * 64 + '\n'
        setup += 'CLOUDBENCH_WARM_IMAGE_DEPS_KEY=rose_cloudbench_image_deps\n'
        setup += 'warm_json=' + shlex.quote(json.dumps([row])) + '\n'
        setup += 'fresh_image_deps_admission || exit $?\n'
        setup += 'LIVE_DONOR_IMAGE=' + shlex.quote(changed) + '\n'
        setup += 'src=clone;cold_primary=0;bench=fixture;BENCHES=(fixture);CATALOG_MODES=(real)\n'
        setup += 'is_sim_on(){ return 1; };CLOUDBENCH_FRESH_VOLUME=1;CLOUDBENCH_COLD_PRIMARY_BOOTSTRAP=0\n'
        setup += 'CLOUDBENCH_SOURCE_MANIFEST="";CLOUDBENCH_ENV_VERIFIED=1;FLEET_MACHINE_ID=ownedfixture;CLOUDBENCH_FLEET_RUN_TOKEN=owner-0\n'
        if mode == 'snapshot': setup += 'FRESH_VOLUMES=0;CLOUDBENCH_FRESH_VOLUME=0\n'
        if mode == 'sim': setup += 'CATALOG_MODES=(simulate);CLOUDBENCH_FRESH_VOLUME=0\n'
        if mode == 'pool': setup += 'src=pool;CLOUDBENCH_FRESH_VOLUME=0\n'
        if mode == 'cold': setup += 'src=pool;cold_primary=1;CLOUDBENCH_COLD_PRIMARY_BOOTSTRAP=1\n'
        if mode == 'private': setup += 'PRIVATE_SOURCE_FILE=/fixture/source;CLOUDBENCH_SOURCE_MANIFEST=/fixture/source\n'
        handoff = next((line for line in fleet.splitlines() if line.startswith('    CLOUDBENCH_FLEET_BOOT_IMAGE=')), None)
        setup += handoff.strip().removesuffix('\\').rstrip() + '\n' if handoff else 'CLOUDBENCH_FLEET_BOOT_IMAGE=""\n'
        if supplied is not None: setup += 'CLOUDBENCH_FLEET_BOOT_IMAGE=' + shlex.quote(supplied) + '\n'
        if 'fleet_fresh_boot_image_args()' in cloud:
            setup += self.function(cloud, 'fleet_fresh_boot_image_args') + '\nfleet_fresh_boot_image_args || exit $?\n'
        start = cloud.index('    if BOOT_UPDATE_MACHINE_ID="$mid"')
        command = cloud[start:cloud.index('\n    fi', start) + len('\n    fi')]
        setup += '''
mid=ownedfixture;OUT_DIR=fixture;_update_log=fixture;_boot_command='sleep infinity'
_pool_shape_args=();_envargs=();_lane_args=();_boot_file_args=()
flyctl(){
 local selected="$LIVE_DONOR_IMAGE" previous='' arg skip=0
 for arg in "$@";do
  [ "$previous" != --image ] || selected="$arg"
  [ "$arg" != --skip-start ] || skip=1
  previous="$arg"
 done
 [ "$skip" = 1 ] || return 9
 printf '%s\\n' "$selected" > "$PROBE_OUTPUT"
}
boot_update_with_capacity_recovery(){ shift; "$@"; }
'''
        setup += command + '\n[ "${_upd:-0}" = 1 ]\n'
        with tempfile.TemporaryDirectory(prefix='fresh-image-handoff-') as temporary:
            output = Path(temporary) / 'image'
            proc = subprocess.run(['bash', '-c', setup], capture_output=True, text=True, timeout=10,
                                  env=dict(os.environ, PROBE_OUTPUT=str(output)))
            return proc, output.read_text().strip() if output.exists() else None, admitted, changed

    def test_raced_donor_still_boots_the_admitted_image_before_start(self):
        proc, selected, admitted, _ = self.probe()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(selected, admitted)

    def test_snapshot_sim_pool_cold_and_private_handoffs_are_unchanged(self):
        for mode in ('snapshot', 'sim', 'pool', 'cold', 'private'):
            with self.subTest(mode=mode):
                proc, selected, _, changed = self.probe(mode=mode)
                self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                self.assertEqual(selected, changed)

    def test_missing_mutable_or_conflicting_digest_refuses_before_update(self):
        for kind, supplied in (('good', ''), ('good', 'registry.fly.io/fixture:mutable'),
                               ('good', 'registry.fly.io/fixture@sha256:nope'),
                               ('tag', None), ('mismatch', None), ('malformed_ref', None)):
            with self.subTest(kind=kind, supplied=supplied):
                proc, selected, _, _ = self.probe(fee=kind, supplied=supplied)
                self.assertNotEqual(proc.returncode, 0)
                self.assertIsNone(selected)

    def test_provider_resolved_digest_is_carried_and_unexpected_pin_refused(self):
        proc, selected, admitted, _ = self.probe(fee='resolved')
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(selected, admitted)
        proc, selected, _, _ = self.probe(mode='snapshot', supplied=admitted)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIsNone(selected)


    def test_unproven_donor_inputs_are_safe_and_nounset_handoff_fails_closed(self):
        lib = self.source('lib/cloudbench-env.sh')
        helper = self.function(lib, 'cloudbench_warm_image_deps_match')
        for raw in ('{', '[]', json.dumps([{'id': 'donor'}, {'id': 'donor'}])):
            with self.subTest(raw=raw):
                proc = subprocess.run(['bash', '-c', helper + '\nCLOUDBENCH_WARM_IMAGE_DEPS_KEY=rose_cloudbench_image_deps\n' +
                    'cloudbench_warm_image_deps_match donor ' + 'c' * 64 + ' ' + 'd' * 64],
                    input=raw, capture_output=True, text=True, timeout=10)
                self.assertEqual(proc.returncode, 1)
                self.assertEqual(proc.stdout.strip(), 'unknown')
                self.assertNotIn('Traceback', proc.stderr)
        fleet = self.source('run-bench-fleet')
        default = next(line for line in fleet.splitlines() if line == 'FRESH_PRIMARY_IMAGE=""')
        proc = subprocess.run(['bash', '-uc', default + '\nprintf "<%s>" "$FRESH_PRIMARY_IMAGE"'],
                              capture_output=True, text=True, timeout=10)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, '<>')
        proc, selected, _, _ = self.probe(supplied='')
        self.assertNotEqual(proc.returncode, 0)
        self.assertIsNone(selected)


if __name__ == '__main__':
    unittest.main()
