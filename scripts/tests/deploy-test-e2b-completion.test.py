#!/usr/bin/env python3
"""Negative-only completion collection; no providers, sandboxes or acceptance changes."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import itertools
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import deploy_test_worker as worker

NATIVE = json.loads((ROOT / 'scripts/tests/fixtures/e2b-completion/native-summary.json').read_text())
COMMAND = ['bash', 'scripts/run-deploy-semantic-stack.sh', '--e2b-smoke-only']


class CompletedE2bFailure(unittest.TestCase):
    def run_case(self, mutate=None, *, code=1, timeout=False, cancelled=False, lingering=False,
                 command=None, old=False, missing=False, duplicate=False, bad_progress=False,
                 metadata_change=None):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / 'worker'
            folder.mkdir()
            artifact = root / '.context/deploy-e2b-smoke/native-run'
            progress = root / 'progress.jsonl'
            progress.write_text('')
            def capture():
                artifact.mkdir(parents=True, exist_ok=True)
                summary = copy.deepcopy(NATIVE)
                summary['results'][0]['logPath'] = str(artifact / 'claude-code.log')
                summary['results'][0]['terminations'] = [dict(kind='exited', code=1, signal=None)] * 2
                completion = dict(runId=summary['runId'], domain='claude-code', results=[
                    dict(name='actual failed case', passed=False, error='original failure', duration=43103)],
                    summary=dict(passed=0, failed=1, skipped=0, exitCode=1))
                for number in (1, 2):
                    completion['completedAt'] = time.time() * 1000
                    (artifact / f'claude-code-completion-{number}.json').write_text(json.dumps(completion))
                cleanup = dict(runId=summary['runId'], backendTreeCleaned=True, sandbox=dict(
                    roseStack='blackbox:' + summary['runId'], verified=True, remaining=[]))
                (artifact / 'cleanup.json').write_text(json.dumps(cleanup))
                if metadata_change:
                    metadata_change(artifact)
                if mutate:
                    mutate(summary)
                (artifact / 'claude-code.log').write_text('Original native failed domain output retained separately.\n')
                if not missing:
                    (artifact / 'summary.json').write_text(json.dumps(summary))
                if duplicate:
                    other = artifact.with_name('second-run')
                    other.mkdir()
                    (other / 'summary.json').write_text(json.dumps(summary))
                row = dict(v=1, scope='domain', case='e2b-smoke', unit='claude-code',
                           status='PASS' if bad_progress else 'FAIL', at=0, log='', detail='native failure')
                progress.write_text(json.dumps(row) + '\n')
            if old:
                capture()
            def replay(*args, **kwargs):
                if not old:
                    capture()
                kwargs['output'].write(b'Native command output\n')
                return code, timeout, cancelled, lingering
            spec = dict(command=command or COMMAND, cwd='.', env={}, aggregate=True)
            clock = itertools.count(10, 0.001)
            with patch.object(worker, 'run_command', side_effect=replay), \
                    patch.object(worker, 'progress_path', return_value=str(progress)), \
                    patch.object(worker.time, 'time', side_effect=lambda: next(clock)):
                return worker.run_step('e2b-smoke', spec, root, folder)

    def test_completed_native_failure_is_fail_without_pass_credit(self):
        row = self.run_case()
        self.assertEqual('FAIL', row['status'])
        self.assertEqual(1, row['native_exit'])
        self.assertEqual(False, row['aggregate_completion']['positive_credit'])
        self.assertEqual(2, row['aggregate_completion']['summary']['results'][0]['attempts'])
        self.assertEqual('FAIL', row['aggregate_completion']['domain_event']['status'])

    def test_unknown_or_incomplete_execution_stays_unverified(self):
        controls = [dict(code=2), dict(code=-15), dict(timeout=True), dict(cancelled=True),
                    dict(lingering=True), dict(old=True), dict(missing=True), dict(duplicate=True),
                    dict(bad_progress=True), dict(command=['bash', 'other-aggregate.sh'])]
        for control in controls:
            with self.subTest(control=control):
                self.assertEqual('UNVERIFIED', self.run_case(**control)['status'])

    def test_incomplete_or_conflicting_native_inventory_stays_unverified(self):
        changes = [lambda s: s.update(requested=['other']),
                   lambda s: s.update(passed=1), lambda s: s.update(results=[]),
                   lambda s: s['results'].append(copy.deepcopy(s['results'][0])),
                   lambda s: s['results'][0].update(aborted=True),
                   lambda s: s['results'][0].update(passed=True),
                   lambda s: s['results'][0].update(flaky=True),
                   lambda s: s['results'][0].update(attempts=0),
                   lambda s: s['results'][0].update(attempts=3),
                   lambda s: s['results'][0].update(duration=float('nan')),
                   lambda s: s['results'][0].update(duration=True),
                   lambda s: s['results'][0].update(terminations=[dict(kind='exited', code=None, signal='SIGKILL')] * 2),
                   lambda s: s['results'][0].update(terminations=[dict(kind='timeout', code=None, signal=None)] * 2),
                   lambda s: s['results'][0].update(logPath='/tmp/foreign.log')]
        for change in changes:
            with self.subTest(change=change):
                self.assertEqual('UNVERIFIED', self.run_case(mutate=change)['status'])

    def test_missing_terminal_attempt_or_owned_cleanup_stays_unverified(self):
        for filename in ['claude-code-completion-1.json', 'cleanup.json']:
            with self.subTest(filename=filename):
                self.assertEqual('UNVERIFIED', self.run_case(
                    metadata_change=lambda directory: (directory / filename).unlink())['status'])
        for filename, change in [
            ('cleanup.json', lambda data: data.update(backendTreeCleaned=False)),
            ('cleanup.json', lambda data: data['sandbox'].update(verified=False)),
            ('cleanup.json', lambda data: data['sandbox'].update(remaining=['owned-sandbox'])),
            ('claude-code-completion-1.json', lambda data: data.update(runId='other')),
            ('claude-code-completion-1.json', lambda data: data['results'][0].update(name='substituted')),
            ('claude-code-completion-1.json', lambda data: data['results'][0].update(passed=True)),
            ('claude-code-completion-1.json', lambda data: data.pop('completedAt')),
            ('claude-code-completion-1.json', lambda data: data.update(completedAt=float('nan'))),
            ('claude-code-completion-1.json', lambda data: data.update(completedAt=1)),
            ('claude-code-completion-1.json', lambda data: data['results'][0].pop('error')),
        ]:
            def mutate(directory):
                path = directory / filename
                data = json.loads(path.read_text())
                change(data)
                path.write_text(json.dumps(data))
            with self.subTest(filename=filename, change=change):
                self.assertEqual('UNVERIFIED', self.run_case(metadata_change=mutate)['status'])


if __name__ == '__main__':
    unittest.main()
