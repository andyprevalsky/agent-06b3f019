#!/usr/bin/env python3
"""Deploy cycle quarantine: non-blocking QUARANTINED rows, FLAKY attribution, ledger rows, release report."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import deploy_gate_progress as progress
import deploy_test_cycle as c
import deploy_test_quarantine as q

REPAIR = 'https://boxes.dev/thread/thr_repair1'
META = {'since': '2026-11-01', 'repair': REPAIR, 'error': 'AssertionError: boom', 'evidence': 'run-1/log'}
MARKED = ("from test_quarantine import quarantine\n\n"
          "class Suite:\n"
          "    @quarantine(since='2026-11-01', repair=%r, error='AssertionError: boom', evidence='run-1/log')\n"
          "    def test_flaky_unit(self):\n        pass\n" % REPAIR)


def git(root, *args):
    return subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True, text=True).stdout.strip()


def commit(root, message='fixture'):
    git(root, 'add', '.')
    git(root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', message)
    return git(root, 'rev-parse', 'HEAD')


class CycleQuarantine(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        git(self.root, 'init', '-q')
        (self.root / 'code').write_text('original')
        (self.root / 'tests').mkdir()
        (self.root / 'tests' / 'test_unit.py').write_text(MARKED)
        (self.root / '.git' / 'info' / 'exclude').write_text('.context/\n')
        commit(self.root)
        self.directory = self.root / '.context' / 'cycle'
        self.workers = tempfile.TemporaryDirectory()
        (Path(self.workers.name) / 'api').mkdir()
        self.plan = {'source': c.source(self.root), 'gates': [
            {'name': 'api', 'worker': 'api-worker', 'command': ['true'], 'checks': ['a', 'b'],
             'worker_transport': 'local-isolated', 'cwd': str(Path(self.workers.name) / 'api'),
             'env': {'CONDUCTOR_WORKSPACE_NAME': 'api', 'CONDUCTOR_PORT': '12000'}},
        ] + [{'name': name, 'category': name, 'quick': True, 'command': ['true'], 'checks': [name]}
             for name in ('static', 'format', 'typescript', 'backend-structural')]}
        self.plan['gates'][1]['category'] = 'eslint'

    def tearDown(self):
        c.CANCEL.clear()
        self.workers.cleanup()
        self.temp.cleanup()

    def run_gate(self, rows_code: str, launcher=None):
        gate = ("import os,json,sys; sys.path.insert(0,%r); import deploy_gate_progress as p\n%s\n"
                "q=json.load(open(os.environ['DEPLOY_GATE_REQUEST']))\n"
                "json.dump({**q,'complete':True,'cleanup_complete':True,'cases':{'a':'PASS','b':'PASS'}},"
                "open(os.environ['DEPLOY_GATE_RESULT'],'w'))\n") % (str(ROOT / 'scripts'), rows_code)
        self.plan['gates'][0].update(command=[sys.executable, '-c', gate], case_protocol=True)
        self.state = c.initialize(self.plan, self.root)
        self.state['phase'] = 'initial'
        out = io.StringIO()
        with patch.object(c, 'EARLY_POLL_SECONDS', 0.05), contextlib.redirect_stdout(out):
            c.run_phase(self.plan, self.state, self.directory, self.root, launcher)
        c.write(self.directory / 'cycle.json', self.state)
        return out.getvalue()

    def report_text(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = c.main(['report', '--plan', str(self.directory / 'plan.json'), '--state-dir', str(self.directory),
                           '--root', str(self.root)])
        self.assertEqual(0, code)
        return out.getvalue()

    def test_quarantined_fail_is_non_blocking_and_reported(self):
        printed = self.run_gate(
            "p.report('test_flaky_unit','QUARANTINED_FAIL',case='a',detail='AssertionError: boom',quarantine=%r)\n"
            "p.report('tests/x.py::test_other','QUARANTINED_PASS',case='b',quarantine=%r)" % (META, META))
        self.assertTrue(self.state['ready'], self.state['phase'])
        self.assertEqual([], self.state['failures'])
        self.assertNotIn('early_failures', self.state)  # a quarantined failure opens no /RCA
        result = self.state['attempts'][-1]['results'][0]
        self.assertEqual('PASS', result['status'])
        self.assertEqual(['QUARANTINED_FAIL', 'QUARANTINED_PASS'], [r['status'] for r in result['quarantined']])
        self.assertEqual(META, result['quarantined'][0]['quarantine'])
        self.assertIn('DEPLOY_GATE_QUARANTINED gate=api failed=1 passed=1 (non-blocking)', printed)
        self.assertEqual(0, c.verify_saved(self.directory, self.root))
        (self.directory / 'plan.json').write_text(json.dumps(self.plan))
        text = self.report_text()
        self.assertIn('Tests skipped (quarantined): 2 — 1 failed (non-blocking), 1 passed\n', text)
        self.assertIn(f'- api :: test_flaky_unit — QUARANTINED_FAIL · since 2026-11-01 · repair {REPAIR}', text)

    def test_flaky_opens_rca_and_merge_refuses_until_attributed(self):
        printed = self.run_gate("p.report('tests/test_unit.py::Suite::test_flaky_unit','FLAKY',case='a',attempts=2,"
                                "detail='AssertionError: first attempt')")
        self.assertTrue(self.state['ready'])  # the rerun passed: the gate itself passed
        [occurrence] = self.state['flaky']
        request = self.directory / 'rca' / (occurrence['id'] + '.json')
        self.assertTrue(request.is_file())
        self.assertIn('FLAKY', json.loads(request.read_text())['instruction'])
        self.assertEqual('api/a', occurrence['check'])
        notices = [line for line in printed.splitlines() if line.startswith('TEST_FLAKY')]
        self.assertEqual([c.flaky_notice(occurrence, request)], notices)  # one notice, not one per scan
        self.assertEqual(1, c.verify_saved(self.directory, self.root))  # merge gate refuses
        self.assertIn('lack /RCA attribution', c.pending_completion_block(self.state))
        (self.directory / 'plan.json').write_text(json.dumps(self.plan))
        self.assertIn('Flaky (passed on rerun): 1 — 0 attributed, 1 awaiting /RCA attribution (blocks merge)',
                      self.report_text())
        for bad, why in (({'attribution': 'UNKNOWN', 'evidence': 'rca'}, 'UNKNOWN'),
                         ({'attribution': 'NOT_INTRODUCED', 'evidence': 'rca', 'marker': 'code',
                           'repair_agent': REPAIR}, 'no quarantine marker'),
                         ({'attribution': 'NOT_INTRODUCED', 'evidence': 'rca', 'marker': 'tests/test_unit.py',
                           'repair_agent': 'https://boxes.dev/thread/thr_other'}, 'repair_agent'),
                         ({'attribution': 'NOT_INTRODUCED', 'evidence': 'rca', 'marker': 'tests/test_unit.py'},
                          'exactly one handoff')):
            with self.assertRaisesRegex(ValueError, why):
                c.attribute_flaky(self.state, occurrence['id'], bad, self.root)
            self.assertIsNone(occurrence['attribution'])
        c.attribute_flaky(self.state, occurrence['id'], {'attribution': 'NOT_INTRODUCED', 'evidence': 'rca receipt',
                          'marker': 'tests/test_unit.py', 'repair_agent': REPAIR}, self.root)
        c.write(self.directory / 'cycle.json', self.state)
        self.assertEqual(0, c.verify_saved(self.directory, self.root))
        self.assertIsNone(c.pending_completion_block(self.state))
        # The marker must still be in the tree the merge ships.
        (self.root / 'tests' / 'test_unit.py').write_text('def test_flaky_unit():\n    pass\n')
        self.assertIn('no quarantine marker', q.attribution_block(self.state['flaky'], self.root))

    def test_flaky_with_cycle_launcher_launches_rca_without_notice(self):
        launcher = [sys.executable, '-c', "import json; print(json.dumps({'ok': True}))"]
        printed = self.run_gate("p.report('u1','FLAKY',case='b',attempts=2)", launcher=launcher)
        self.assertNotIn('TEST_FLAKY', printed)
        self.assertEqual(1, len(list((self.directory / 'rca').glob('*.launch.json'))))

    def test_post_merge_flaky_handoff_blocks_completion_until_resolved(self):
        self.run_gate("p.report('test_flaky_unit','FLAKY',case='a',attempts=2)")
        [occurrence] = self.state['flaky']
        packet = {k: 'x' for k in ('test', 'command', 'scope', 'error', 'source', 'evidence')}
        c.attribute_flaky(self.state, occurrence['id'], {'attribution': 'NOT_INTRODUCED', 'evidence': 'rca',
                          'marker': 'tests/test_unit.py', 'post_merge': packet}, self.root)
        self.assertIn('pending post-merge', c.pending_completion_block(self.state))
        c.resolve_post_merge(self.state, occurrence['id'], REPAIR)
        self.assertIsNone(c.pending_completion_block(self.state))

    def test_introduced_flake_needs_a_fix_commit_newer_than_the_flaky_source(self):
        self.run_gate("p.report('test_flaky_unit','FLAKY',case='a',attempts=2)")
        [occurrence] = self.state['flaky']
        old = occurrence['source']['head']
        with self.assertRaisesRegex(ValueError, 'newer than the source'):
            c.attribute_flaky(self.state, occurrence['id'], {'attribution': 'INTRODUCED', 'evidence': 'rca',
                              'fix_commit': old}, self.root)
        with self.assertRaisesRegex(ValueError, 'no quarantine'):
            c.attribute_flaky(self.state, occurrence['id'], {'attribution': 'INTRODUCED', 'evidence': 'rca',
                              'fix_commit': old, 'marker': 'tests/test_unit.py'}, self.root)
        (self.root / 'code').write_text('fixed')
        fix = commit(self.root, 'fix')
        c.attribute_flaky(self.state, occurrence['id'], {'attribution': 'INTRODUCED', 'evidence': 'rca',
                          'fix_commit': fix}, self.root)
        self.assertIsNone(q.attribution_block(self.state['flaky'], self.root))


class LedgerRows(unittest.TestCase):
    def test_failed_tests_come_first_within_the_detail_limit(self):
        rows = [('api', progress.row(f'tests/test_{i:03d}.py::test_long_passing_name_{i}', 'QUARANTINED_PASS',
                                     at=100 + i, quarantine=META)) for i in range(60)]
        rows.append(('api', progress.row('tests/test_z.py::test_the_real_failure', 'FAIL', at=999)))
        rows.append(('ui', progress.row('ui > flaky "case"', 'FLAKY', at=998, attempts=2)))
        rows.append(('ui', progress.row('passing', 'PASS', at=5)))
        detail = q.test_lines(rows)
        self.assertEqual('FAIL api::tests/test_z.py::test_the_real_failure at=999', detail['lines'][0])
        self.assertEqual('FLAKY ui::ui > flaky ?case? at=998', detail['lines'][1])
        self.assertLessEqual(sum(len(line) + 1 for line in detail['lines']), q.DETAIL_LIMIT)
        self.assertGreater(detail['omitted'], 0)
        self.assertEqual({'QUARANTINED_PASS': 60, 'FAIL': 1, 'FLAKY': 1}, detail['counts'])
        self.assertNotIn('PASS ui::passing', '\n'.join(detail['lines']))
        self.assertIn('<redacted>', q.safe_line('FAIL api::t token=ab12cd34ef56ab12cd34ef56ab12 at=1'))

    def test_stage_finish_event_records_rows_since_its_stage_start(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            log = temp / 'events.jsonl'
            log.write_text(json.dumps({'workflow': 'deploy', 'event': 'stage-start', 'value': 'runtime-blackbox',
                                       'recorded_epoch': 500.0}) + '\n')
            gate = temp / 'state' / 'attempts' / '1' / 'initial' / 'api'
            gate.mkdir(parents=True)
            for row in (progress.row('old_failure', 'FAIL', at=10),
                        progress.row('test_x', 'QUARANTINED_FAIL', at=600, quarantine=META),
                        progress.row('test_y', 'FAIL', at=700)):
                with (gate / 'progress.jsonl').open('a') as stream:
                    stream.write(json.dumps(row) + '\n')
            env = {**os.environ, 'FACTORY_EVENT_LOG': str(log), q.STATE_DIR_ENV: str(temp / 'state'),
                   'DEPLOY_RUN_ROOT': str(temp / 'runs')}
            subprocess.run([sys.executable, str(ROOT / 'scripts/record_factory_event.py'), 'deploy', 'stage-finish',
                            'runtime-blackbox'], cwd=temp, env=env, check=True, capture_output=True, timeout=60)
            event = json.loads(log.read_text().splitlines()[-1])
            self.assertEqual(['FAIL api::test_y at=700', 'QUARANTINED_FAIL api::test_x at=600'],
                             event['detail']['tests']['lines'])

    def test_stage_finish_event_records_gate_verdicts_with_cancellations_separate(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            log = temp / 'events.jsonl'
            log.write_text(json.dumps({'workflow': 'deploy', 'event': 'stage-start', 'value': 'runtime-blackbox',
                                       'recorded_epoch': 500.0}) + '\n')
            receipts = {
                'old': {'status': 'FAIL', 'complete': True, 'started_at': 10, 'finished_at': 20},
                'api': {'status': 'FAIL', 'complete': True, 'native_exit': 1, 'started_at': 600, 'finished_at': 660},
                'eslint': {'status': 'FAIL', 'complete': False, 'cancelled': True, 'native_exit': -15,
                           'started_at': 600, 'finished_at': 630},
                'semantic': {'status': 'FAIL', 'complete': False, 'timed_out': True, 'started_at': 601,
                             'finished_at': 2401},
                'structural': {'status': 'FAIL', 'complete': False, 'started_at': 602, 'finished_at': 700},
                'ui': {'status': 'PASS', 'complete': True, 'native_exit': 0, 'started_at': 603, 'finished_at': 703.25},
            }
            for name, receipt in receipts.items():
                folder = temp / 'state' / 'attempts' / '2' / 'initial' / name
                folder.mkdir(parents=True)
                (folder / 'receipt.json').write_text(json.dumps({'gate': name, **receipt}))
            env = {**os.environ, 'FACTORY_EVENT_LOG': str(log), q.STATE_DIR_ENV: str(temp / 'state'),
                   'DEPLOY_RUN_ROOT': str(temp / 'runs')}
            subprocess.run([sys.executable, str(ROOT / 'scripts/record_factory_event.py'), 'deploy', 'stage-finish',
                            'runtime-blackbox'], cwd=temp, env=env, check=True, capture_output=True, timeout=60)
            gates = {g['gate']: g for g in json.loads(log.read_text().splitlines()[-1])['detail']['gates']}
            self.assertNotIn('old', gates)  # an earlier round's receipt is not this round's verdict
            self.assertEqual({'api': 'FAIL', 'eslint': 'CANCELLED', 'semantic': 'TIMEOUT',
                              'structural': 'UNVERIFIED', 'ui': 'PASS'},
                             {name: g['outcome'] for name, g in gates.items()})
            self.assertEqual({'gate': 'ui', 'phase': 'initial', 'round': '2', 'outcome': 'PASS', 'native_exit': 0,
                              'seconds': 100.2}, gates['ui'])


class ReleaseReport(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        git(self.root, 'init', '-q')
        (self.root / 'tests').mkdir()
        (self.root / 'tests' / 'test_unit.py').write_text(MARKED)
        (self.root / 'web.test.ts').write_text(
            "it('renders \"the\" chart', quarantine({ since: '2026-11-01', repair: '%s',\n"
            "  error: 'Timeout', evidence: 'run-2' }, async () => {}));\n" % REPAIR)
        (self.root / 'helper.ts').write_text(  # a usage example and a nested marker are not tests
            "/** Usage: test('name', quarantine({ since, repair, error, evidence }, fn)); */\n")
        (self.root / 'tests' / 'test_nested.py').write_text(
            "def test_marker_itself():\n"
            "    @quarantine(since='2026-11-01', repair=%r, error='x', evidence='y')\n"
            "    def case():\n        pass\n" % REPAIR)
        self.ledger = self.root / 'ledger.jsonl'
        self.epoch = q.since_epoch({'since': '2026-11-01'})

    def tearDown(self):
        self.temp.cleanup()

    def write_ledger(self, statuses, unit='tests/test_unit.py::Suite::test_flaky_unit', start=0):
        lines = [f'{s} api::{unit} at={int(self.epoch) + start + i}' for i, s in enumerate(statuses)]
        with self.ledger.open('a') as stream:
            stream.write(json.dumps({'workflow': 'deploy', 'event': 'stage-finish', 'value': 'runtime-blackbox',
                                     'detail': {'tests': {'lines': lines}}}) + '\n')

    def rows(self, attempts=()):
        return {r['name']: r for r in q.report(self.root, [self.ledger], list(attempts))}

    def test_markers_are_found_in_python_and_typescript(self):
        rows = self.rows()
        self.assertEqual({'test_flaky_unit', 'renders "the" chart'}, set(rows))
        self.assertEqual(('py', 'Suite', REPAIR, 'never observed'),
                         tuple(rows['test_flaky_unit'][k] for k in ('lang', 'owner', 'repair', 'status')))
        self.assertEqual(('ts', 'Timeout', 'run-2'),
                         tuple(rows['renders "the" chart'][k] for k in ('lang', 'error', 'evidence')))

    def test_five_consecutive_passes_are_ready_and_a_failure_resets(self):
        self.write_ledger(['QUARANTINED_PASS'] * 4)
        self.assertEqual((4, False, '1 more pass(es)'),
                         tuple(self.rows()['test_flaky_unit'][k] for k in ('streak', 'ready', 'status')))
        self.write_ledger(['QUARANTINED_PASS'], start=10)
        row = self.rows()['test_flaky_unit']
        self.assertEqual((5, True, 'ready to release'), (row['streak'], row['ready'], row['status']))
        self.assertIn('ready to release', q.render([row]))
        self.write_ledger(['QUARANTINED_FAIL', 'QUARANTINED_PASS'], start=20)
        self.assertEqual((1, False, 7), tuple(self.rows()['test_flaky_unit'][k] for k in ('streak', 'ready', 'runs')))

    def test_rows_before_since_and_duplicate_local_copies_do_not_count(self):
        self.write_ledger(['QUARANTINED_PASS'] * 3, start=-10_000)  # before the marker's since date
        self.write_ledger(['QUARANTINED_PASS'] * 2)
        attempts = self.root / 'attempts'
        gate = attempts / '1' / 'initial' / 'api'
        gate.mkdir(parents=True)
        with (gate / 'progress.jsonl').open('w') as stream:
            for i in range(2):  # the same two rows as the ledger: counted once
                stream.write(json.dumps(progress.row('tests/test_unit.py::Suite::test_flaky_unit', 'QUARANTINED_PASS',
                                                     at=self.epoch + i, quarantine=META)) + '\n')
        row = self.rows([attempts])['test_flaky_unit']
        self.assertEqual((2, 2, False), (row['runs'], row['streak'], row['ready']))
        self.write_ledger(['QUARANTINED_PASS'] * 5, unit='other::test_unrelated', start=50)
        self.assertEqual(2, self.rows([attempts])['test_flaky_unit']['streak'])

    def test_cli_prints_the_table(self):
        self.write_ledger(['QUARANTINED_PASS'] * 5)
        out = subprocess.run([sys.executable, str(ROOT / 'scripts/test_quarantine.py'), 'report', '--root',
                              str(self.root), '--ledger', str(self.ledger)], capture_output=True, text=True,
                             check=True, timeout=60).stdout
        self.assertIn('Suite.test_flaky_unit', out)
        self.assertIn('2 quarantined test(s); 1 ready to release', out)


if __name__ == '__main__':
    unittest.main()
