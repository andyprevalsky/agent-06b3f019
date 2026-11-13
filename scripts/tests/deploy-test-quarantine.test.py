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


def _refusal(root, occurrence_id):
    try:
        q.link_repair(root, occurrence_id, REPAIR)
    except ValueError as error:
        return str(error)
    return ''


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
        packet = {k: 'x' for k in ('test', 'command', 'scope', 'error', 'source', 'evidence')}
        for bad, why in (({'attribution': 'UNKNOWN', 'evidence': 'rca'}, 'UNKNOWN'),
                         ({'attribution': 'NOT_INTRODUCED', 'evidence': 'rca', 'marker': 'code',
                           'post_merge': packet}, 'no quarantine marker'),
                         # Repairs dispatch only after merge: a pre-merge repair thread is refused.
                         ({'attribution': 'NOT_INTRODUCED', 'evidence': 'rca', 'marker': 'tests/test_unit.py',
                           'repair_agent': REPAIR, 'post_merge': packet}, 'dispatch after merge'),
                         ({'attribution': 'NOT_INTRODUCED', 'evidence': 'rca', 'marker': 'tests/test_unit.py'},
                          'post-merge packet'),
                         # The marker still names a thread instead of this occurrence's pending handoff.
                         ({'attribution': 'NOT_INTRODUCED', 'evidence': 'rca', 'marker': 'tests/test_unit.py',
                           'post_merge': packet}, "marker's repair must be pending-handoff")):
            with self.assertRaisesRegex(ValueError, why):
                c.attribute_flaky(self.state, occurrence['id'], bad, self.root)
            self.assertIsNone(occurrence['attribution'])
        pending = f"pending-handoff:{occurrence['id']}"
        (self.root / 'tests' / 'test_unit.py').write_text(MARKED.replace(REPAIR, pending))
        c.attribute_flaky(self.state, occurrence['id'], {'attribution': 'NOT_INTRODUCED', 'evidence': 'rca receipt',
                          'marker': 'tests/test_unit.py', 'post_merge': packet}, self.root)
        c.write(self.directory / 'cycle.json', self.state)
        # Attributed: the FLAKY unit no longer blocks merge (adding the marker changed the source, which a
        # real deploy re-gates; this fixture checks only the attribution).
        self.assertIsNone(q.attribution_block(self.state['flaky'], self.root))
        # ...but the repair is dispatched only after merge, and the packet carries the attribution.
        self.assertIn('pending post-merge', c.pending_completion_block(self.state))
        [queued] = self.state['pending_post_merge']
        self.assertEqual(('NOT_INTRODUCED', 'rca receipt', occurrence['id'], 'tests/test_unit.py'),
                         tuple(queued['packet'][k] for k in ('attribution', 'rca', 'occurrence', 'marker')))
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
        pending = f"pending-handoff:{occurrence['id']}"
        (self.root / 'tests' / 'test_unit.py').write_text(MARKED.replace(REPAIR, pending))
        c.attribute_flaky(self.state, occurrence['id'], {'attribution': 'NOT_INTRODUCED', 'evidence': 'rca',
                          'marker': 'tests/test_unit.py', 'post_merge': packet}, self.root)
        self.assertIn('pending post-merge', c.pending_completion_block(self.state))
        c.resolve_post_merge(self.state, occurrence['id'], REPAIR)
        self.assertIsNone(c.pending_completion_block(self.state))
        # The post-merge records PR swaps the pending reference for the dispatched thread.
        out = subprocess.run([sys.executable, str(ROOT / 'scripts/test_quarantine.py'), 'link-repair', '--root',
                              str(self.root), '--occurrence', occurrence['id'], '--repair', REPAIR],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(0, out.returncode, out.stderr)
        self.assertEqual(MARKED, (self.root / 'tests' / 'test_unit.py').read_text())
        self.assertIn('no marker names', _refusal(self.root, occurrence['id']))  # already linked

    def test_flaky_reattribution_reconciles_the_pending_packet_and_stops_once_resolved(self):
        self.run_gate("p.report('test_flaky_unit','FLAKY',case='a',attempts=2)")
        [occurrence] = self.state['flaky']
        packet = {k: 'x' for k in ('test', 'command', 'scope', 'error', 'source', 'evidence')}
        (self.root / 'tests' / 'test_unit.py').write_text(MARKED.replace(REPAIR, f"pending-handoff:{occurrence['id']}"))
        not_introduced = {'attribution': 'NOT_INTRODUCED', 'evidence': 'rca', 'marker': 'tests/test_unit.py',
                          'post_merge': packet}
        c.attribute_flaky(self.state, occurrence['id'], not_introduced, self.root)
        self.assertEqual([occurrence['id']], [p['id'] for p in self.state['pending_post_merge']])
        # A refused re-attribution leaves the recorded attribution and its packet untouched.
        with self.assertRaisesRegex(ValueError, 'UNKNOWN'):
            c.attribute_flaky(self.state, occurrence['id'], {'attribution': 'UNKNOWN', 'evidence': 'rca'}, self.root)
        self.assertEqual('NOT_INTRODUCED', occurrence['attribution']['attribution'])
        self.assertEqual(1, len(self.state['pending_post_merge']))
        # Re-attributed as INTRODUCED (fixed before merge): the stale post-merge packet is withdrawn.
        (self.root / 'tests' / 'test_unit.py').write_text('def test_flaky_unit():\n    pass\n')
        (self.root / 'code').write_text('fixed')
        fix = commit(self.root, 'fix')
        c.attribute_flaky(self.state, occurrence['id'], {'attribution': 'INTRODUCED', 'evidence': 'rca',
                          'fix_commit': fix}, self.root)
        self.assertEqual([], self.state['pending_post_merge'])
        self.assertIsNone(c.pending_completion_block(self.state))
        # Back to NOT_INTRODUCED: exactly one packet, then resolved — no further re-attribution.
        (self.root / 'tests' / 'test_unit.py').write_text(MARKED.replace(REPAIR, f"pending-handoff:{occurrence['id']}"))
        c.attribute_flaky(self.state, occurrence['id'], not_introduced, self.root)
        c.attribute_flaky(self.state, occurrence['id'], not_introduced, self.root)
        self.assertEqual(1, len(self.state['pending_post_merge']))
        c.resolve_post_merge(self.state, occurrence['id'], REPAIR)
        with self.assertRaisesRegex(ValueError, 'already resolved'):
            c.attribute_flaky(self.state, occurrence['id'], not_introduced, self.root)
        self.assertEqual(REPAIR, occurrence['attribution']['resolved_post_merge'])
        self.assertEqual([], self.state['pending_post_merge'])

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

    def test_a_long_unit_keeps_its_test_name_and_timestamp_and_counts_once(self):
        unit = 'tests/test_unit.py::Suite::' + 'p' * 200 + '::test_flaky_unit'
        rows = [('api', progress.row(unit, 'QUARANTINED_PASS', at=self.epoch + i, quarantine=META)) for i in range(5)]
        lines = q.test_lines(rows)['lines']
        self.assertEqual(5, len(lines))
        for i, line in enumerate(lines):
            self.assertLessEqual(len(line), q.LINE_LIMIT)
            self.assertTrue(line.endswith(f'::test_flaky_unit at={int(self.epoch) + i}'), line)
        with self.ledger.open('a') as stream:
            stream.write(json.dumps({'workflow': 'deploy', 'event': 'stage-finish', 'value': 'runtime-blackbox',
                                     'detail': {'tests': {'lines': lines}}}) + '\n')
        attempts = self.root / 'attempts'
        gate = attempts / '1' / 'initial' / 'api'
        gate.mkdir(parents=True)
        with (gate / 'progress.jsonl').open('w') as stream:  # the full-unit local copies of the same rows
            stream.writelines(json.dumps(row) + '\n' for _, row in rows)
        row = self.rows([attempts])['test_flaky_unit']
        self.assertEqual((5, 5, True), (row['runs'], row['streak'], row['ready']))

    def write_catalog(self, marker=None):
        catalog = self.root / 'agents' / 'benchmarks' / 'tasks.json'
        catalog.parent.mkdir(parents=True, exist_ok=True)
        catalog.write_text(json.dumps([{'name': 'plain-smoke', 'prompt': 'p'},
                                       {'name': 'cloud-smoke', 'prompt': 'p', 'quarantine': marker or dict(META)}],
                                      indent=2))
        return catalog

    def test_smoke_task_markers_in_the_catalog_are_reported_with_their_streak(self):
        self.write_catalog()
        row = self.rows()['cloud-smoke']
        self.assertEqual(('benchmark', 'agents/benchmarks/tasks.json', 7, REPAIR, 'never observed'),
                         tuple(row[k] for k in ('lang', 'path', 'line', 'repair', 'status')))
        self.assertNotIn('plain-smoke', self.rows())
        # Smoke progress rows (unit = task name) land in the ledger like every other gate's.
        lines = q.test_lines([('smoke', progress.row('cloud-smoke', 'QUARANTINED_PASS', at=self.epoch + i,
                                                     quarantine=META)) for i in range(5)])['lines']
        with self.ledger.open('a') as stream:
            stream.write(json.dumps({'workflow': 'deploy', 'event': 'stage-finish', 'value': 'smoke',
                                     'detail': {'tests': {'lines': lines}}}) + '\n')
        self.assertEqual((5, True, 'ready to release'),
                         tuple(self.rows()['cloud-smoke'][k] for k in ('streak', 'ready', 'status')))
        self.write_ledger(['QUARANTINED_FAIL'], unit='cloud-smoke', start=100)
        self.assertEqual((0, False), tuple(self.rows()['cloud-smoke'][k] for k in ('streak', 'ready')))

    def test_blackbox_domain_flake_binds_the_marker_of_its_single_failed_recorded_case(self):
        occurrence_id = 'c' * 32
        domain = ("from test_quarantine import quarantine\n\n"
                  "@quarantine(since='2026-11-11', repair='pending-handoff:%s', error='AssertionError: boom', "
                  "evidence='rca-2')\n"
                  "async def test_real_model_controls():\n    pass\n\n"
                  "async def test_other():\n    pass\n\n"
                  "async def main(r):\n"
                  "    await r.record_async(\"real_model_controls\", test_real_model_controls)\n"
                  "    await r.record_async(\"other\", test_other)\n" % occurrence_id)
        (self.root / 'tests' / 'domain.blackbox.py').write_text(domain)
        detail = ("\u274c dom FAIL (121 passed, 1 failed; 1 failed case(s): real_model_controls; "
                  "first error: real_model_controls: AssertionError: boom)")
        occurrence = {'id': occurrence_id, 'gate': 'agents', 'unit': 'dom', 'detail': detail,
                      'source': {'head': 'a' * 40}}
        packet = {k: 'x' for k in ('test', 'command', 'scope', 'error', 'source', 'evidence')}
        entry = {'attribution': 'NOT_INTRODUCED', 'evidence': 'rca-2', 'marker': 'tests/domain.blackbox.py',
                 'post_merge': packet}
        # Without the case label a domain unit names no marked function.
        with self.assertRaisesRegex(ValueError, 'no quarantine marker'):
            q.validate_attribution(occurrence, entry, self.root)
        recorded = q.validate_attribution(occurrence, {**entry, 'case': 'real_model_controls'}, self.root)
        self.assertEqual(('NOT_INTRODUCED', 'dom', occurrence_id),
                         tuple(recorded['post_merge'][k] for k in ('attribution', 'unit', 'occurrence')))
        # Merge revalidates the recorded attribution itself (attribution_block), so it must keep the case.
        self.assertIsNone(q.attribution_block([{**occurrence, 'attribution': recorded}], self.root))
        # An unmarked case, a case that did not fail, or several failed cases never bind.
        with self.assertRaisesRegex(ValueError, 'no quarantine marker'):
            q.validate_attribution({**occurrence, 'detail': detail.replace('real_model_controls', 'other')},
                                   {**entry, 'case': 'other'}, self.root)
        with self.assertRaisesRegex(ValueError, 'single failed case'):
            q.validate_attribution(occurrence, {**entry, 'case': 'other'}, self.root)
        several = detail.replace('1 failed; 1 failed case(s): real_model_controls',
                                 '2 failed; 2 failed case(s): real_model_controls, other')
        with self.assertRaisesRegex(ValueError, 'single failed case'):
            q.validate_attribution({**occurrence, 'detail': several}, {**entry, 'case': 'real_model_controls'},
                                   self.root)
        # PR #1865 2026-11-13: a domain returning a bare bool reports no counts prefix
        # ("FAIL (1 failed case(s): X; first error: ..."); the single failed case still binds.
        bare = detail.replace('121 passed, 1 failed; ', '')
        recorded = q.validate_attribution({**occurrence, 'detail': bare}, {**entry, 'case': 'real_model_controls'},
                                          self.root)
        self.assertEqual('dom', recorded['post_merge']['unit'])
        with self.assertRaisesRegex(ValueError, 'single failed case'):
            q.validate_attribution({**occurrence, 'detail': bare.replace('1 failed case(s): real_model_controls',
                                                                         '2 failed case(s): real_model_controls, other')},
                                   {**entry, 'case': 'real_model_controls'}, self.root)

    def test_catalog_marker_backs_a_not_introduced_smoke_flake_and_bad_markers_are_refused(self):
        self.write_catalog()
        self.assertEqual({'cloud-smoke': META}, q.catalog_quarantines(self.root))
        self.assertEqual({}, q.catalog_quarantines(self.root, ['plain-smoke']))
        occurrence = {'id': 'b' * 32, 'gate': 'smoke', 'unit': 'cloud-smoke', 'source': {'head': 'a' * 40}}
        packet = {k: 'x' for k in ('test', 'command', 'scope', 'error', 'source', 'evidence')}
        # An existing repair owner named in the marker receives the goal after merge.
        recorded = q.validate_attribution(occurrence, {'attribution': 'NOT_INTRODUCED', 'evidence': 'rca-1',
                                                       'marker': 'agents/benchmarks/tasks.json',
                                                       'post_merge': {**packet, 'repair_owner': REPAIR}}, self.root)
        self.assertEqual('agents/benchmarks/tasks.json', recorded['marker'])
        self.assertEqual(('NOT_INTRODUCED', 'rca-1', REPAIR),
                         tuple(recorded['post_merge'][k] for k in ('attribution', 'rca', 'repair_owner')))
        for bad in ({**META, 'repair': 'https://boxes.dev/x'}, {**META, 'since': 'yesterday'},
                    {k: v for k, v in META.items() if k != 'error'}, {**META, 'error': 'a\nb'}, ['x']):
            with self.subTest(marker=bad):
                self.write_catalog(bad)
                with self.assertRaises(ValueError):
                    q.catalog_quarantines(self.root)

    def test_suite_level_flaky_unit_matches_the_marker_named_by_its_own_failure_output(self):
        # The structural runner reports a FLAKY unit as the suite job ("deploy-test-plan"); the marker
        # sits on the one method unittest named in that job's failed first attempt (PR #1928).
        packet = {k: 'x' for k in ('test', 'command', 'scope', 'error', 'source', 'evidence')}
        entry = {'attribution': 'NOT_INTRODUCED', 'evidence': 'rca-1', 'marker': 'tests/test_unit.py',
                 'post_merge': {**packet, 'repair_owner': REPAIR}}
        base = {'id': 'c' * 32, 'gate': 'structural', 'unit': 'suite-job', 'source': {'head': 'a' * 40}}
        failure = ('FAIL: test_flaky_unit (__main__.Suite.test_flaky_unit)\nTraceback (most recent call last):\n'
                   '  File "/w/tests/test_unit.py", line 4, in test_flaky_unit\n')
        recorded = q.validate_attribution({**base, 'detail': 'passed on rerun\n' + failure}, entry, self.root)
        self.assertEqual('tests/test_unit.py', recorded['marker'])
        dotted = 'FAIL: test_flaky_unit (tests.test_unit.Suite.test_flaky_unit)\n'
        self.assertEqual('tests/test_unit.py',
                         q.validate_attribution({**base, 'detail': dotted}, entry, self.root)['marker'])
        # Same class + method in ANOTHER module, or a __main__ id with no tie to the marker file, is refused.
        unmarked = 'FAIL: test_other (tests.test_unit.Suite.test_other)\n'  # a second failure with no marker
        for detail in (None, 'no unittest header', failure.replace('Suite.', 'Other.'),
                       dotted.replace('tests.test_unit.', 'tests.test_other.'), failure.split('Traceback')[0],
                       dotted + unmarked):
            with self.subTest(detail=detail), self.assertRaisesRegex(ValueError, 'no quarantine marker'):
                q.validate_attribution({**base, 'detail': detail}, entry, self.root)

    def test_suite_level_flake_with_truncated_header_binds_the_packet_test_by_its_traceback_frame(self):
        # The recorded detail keeps only its tail; deploy-test-worker lost unittest's header (PR #1925).
        entry = {'attribution': 'NOT_INTRODUCED', 'evidence': 'rca-1', 'marker': 'tests/test_unit.py',
                 'post_merge': {**{k: 'x' for k in ('command', 'scope', 'error', 'source', 'evidence')},
                                'test': 'Suite.test_flaky_unit', 'repair_owner': REPAIR}}
        frame = '  File "/w/tests/test_unit.py", line 4, in test_flaky_unit\n    boom()\nValueError: boom\n'
        base = {'id': 'c' * 32, 'gate': 'structural', 'unit': 'suite-job', 'source': {'head': 'a' * 40}}
        self.assertEqual('tests/test_unit.py',
                         q.validate_attribution({**base, 'detail': frame}, entry, self.root)['marker'])
        refused = {'no frame': 'FAILED (errors=1)\n', 'frame in another file': frame.replace('tests/test_unit', 'tests/x'),
                   'frame names another method': frame.replace('test_flaky_unit', 'test_other')}
        for label, detail in refused.items():
            with self.subTest(label), self.assertRaisesRegex(ValueError, 'no quarantine marker'):
                q.validate_attribution({**base, 'detail': detail}, entry, self.root)
        with self.assertRaisesRegex(ValueError, 'no quarantine marker'):  # the packet must name the marked test
            q.validate_attribution({**base, 'detail': frame},
                                   {**entry, 'post_merge': {**entry['post_merge'], 'test': 'Suite.test_other'}},
                                   self.root)

    def test_cli_prints_the_table(self):
        self.write_ledger(['QUARANTINED_PASS'] * 5)
        out = subprocess.run([sys.executable, str(ROOT / 'scripts/test_quarantine.py'), 'report', '--root',
                              str(self.root), '--ledger', str(self.ledger)], capture_output=True, text=True,
                             check=True, timeout=60).stdout
        self.assertIn('Suite.test_flaky_unit', out)
        self.assertIn('2 quarantined test(s); 1 ready to release', out)



class NativeDefinitionBinding(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.node = 'agents/benchmarks/code_bench_test.py::test_commit_fixture_rewritten_history_fails'
        self.error = 'FileNotFoundError: missing maintenance.lock'
        self.source = {'head': 'a' * 40, 'digest': 'b' * 64}
        self.folder = self.root / '.context/deploy-pipeline/attempts/6/triage/agents-coverage-blackbox'
        self.folder.mkdir(parents=True)
        self.worker_root = '/home/runner/_work/rose/rose'
        self.relative = '.context/test-runs/native/benchmark.log'
        self.output_relative = '.context/deploy-worker/native/output.log'
        self.log = self.folder / 'remote-artifact/files' / self.relative
        self.output = self.folder / 'remote-artifact/files' / self.output_relative
        self.log.parent.mkdir(parents=True)
        self.output.parent.mkdir(parents=True)
        self.marker = self.root / 'agents/benchmarks/code_bench_test.py'
        self.marker.parent.mkdir(parents=True)
        self.build()

    def tearDown(self):
        self.temp.cleanup()

    def save(self, name, value):
        (self.folder / name).write_text(json.dumps(value))

    def build(self):
        import hashlib, copy
        self.marker.write_text("@quarantine(since='2026-11-10', repair='pending-handoff:" + 'c' * 32 +
            "', error='FileNotFoundError: missing maintenance.lock', evidence='rca')\n"
            "def test_commit_fixture_rewritten_history_fails():\n    pass\n")
        raw = ('FAILED ' + self.node + ' - ' + self.error + '\n1 failed, 87 passed in 5.93s\n').encode()
        self.log.write_bytes(raw)
        self.output.write_bytes(b'original output\n' + raw + b'automatic rerun PASS\n')
        self.row = {'unit':'benchmark','status':'FLAKY','scope':'domain','attempts':2,'at':100,
                    'log':self.worker_root + '/' + self.relative}
        self.receipt = {'gate':'agents-coverage-blackbox','source':self.source,'token':'native-token',
            'complete':True,'executed':True,'native_exit':0,'status':'PASS','flaky':[self.row],
            'log':str(self.folder/'output.log'),'worker_result':str(self.folder/'result.json')}
        self.request = {'gate':self.receipt['gate'],'source':self.source,'token':'native-token',
                        'worker_root':self.worker_root,'phase':'triage'}
        self.worker = {'gate':self.receipt['gate'],'source':self.source,'token':'native-token',
            'complete':True,'worker_root':self.worker_root,'remote':{'transport':'github-actions','event_sha':self.source['head']},
            'evidence':{self.receipt['gate']:{'status':'PASS','native_exit':0,'log':str(self.output),
                'remote_log':self.worker_root+'/'+self.output_relative,
                'sha256':hashlib.sha256(self.output.read_bytes()).hexdigest()}}}
        for name, value in [('receipt.json',self.receipt),('request.json',self.request),('result.json',self.worker)]:
            self.save(name,value)
        self.occ = {'id':'c'*32,'source':self.source,'gate':self.receipt['gate'],'phase':'triage','round':6,
                    'unit':'benchmark','check':'agents-coverage-blackbox/agents-coverage-blackbox','native_result':'FLAKY','attempts':2,'unit_finished_at':100,'evidence':self.row['log']}
        self.state = {'source':self.source,'plan':{'gates':[{'name':self.receipt['gate'],'worker_root':self.worker_root}]},
            'attempts':[{'source':self.source,'phase':'triage','results':[copy.deepcopy(self.receipt)]}], 'flaky':[self.occ]}
        self.entry = {'attribution':'NOT_INTRODUCED','evidence':'rca','marker':'agents/benchmarks/code_bench_test.py',
            'native_case':{'definition':self.node,'error':self.error,'log_sha256':hashlib.sha256(raw).hexdigest()},
            'post_merge':{'test':self.node,'command':['python','-m','pytest','agents/benchmarks/code_bench_test.py'],
                          'scope':'archive grader','error':self.error,'source':self.source,'evidence':'original native log'}}

    def test_original_single_native_definition_binds_without_rewriting_unit(self):
        import copy
        original = copy.deepcopy(self.occ)
        c.attribute_flaky(self.state,self.occ['id'],self.entry,self.root)
        for key,value in original.items():
            self.assertEqual(self.occ[key],value)
        proof=self.occ['attribution']['native_binding']
        self.assertEqual(proof['definition'],self.node)
        self.assertEqual(proof['unit'],'benchmark')
        self.assertEqual(self.state['pending_post_merge'][0]['packet']['test'],self.node)
        self.assertIsNone(q.attribution_block(self.state['flaky'],self.root,state=self.state))
        self.request['retained_document_drift'] = True
        self.save('request.json', self.request)
        self.assertIn('retained binding changed', q.attribution_block(self.state['flaky'], self.root))

    def test_wrong_or_missing_original_native_binding_remains_blocked(self):
        import copy, hashlib
        for defect in ('source','token','gate','round','hash','path','traversal','multiple','missing','marker',
                       'error','worker_root','recorded_receipt','output_hash','unbound_log','packet_source','malformed_rows','malformed_evidence','native_traversal'):
            with self.subTest(defect=defect):
                self.build()
                if defect=='source': self.receipt['source']={'head':'d'*40,'digest':'e'*64};self.save('receipt.json',self.receipt)
                if defect=='token': self.request['token']='foreign';self.save('request.json',self.request)
                if defect=='gate': self.worker['gate']='foreign';self.save('result.json',self.worker)
                if defect=='round': self.occ['round']=7
                if defect=='hash': self.entry['native_case']['log_sha256']='0'*64
                if defect=='path': self.entry['native_case']['definition']='agents/benchmarks/other.py::test_other'
                if defect=='traversal': self.entry['marker']='../outside.py'
                if defect=='multiple':
                    raw=self.log.read_bytes()+b'FAILED agents/benchmarks/other.py::test_other - AssertionError: other\n'
                    self.log.write_bytes(raw);self.output.write_bytes(raw)
                    self.entry['native_case']['log_sha256']=hashlib.sha256(raw).hexdigest()
                    self.worker['evidence'][self.receipt['gate']]['sha256']=hashlib.sha256(raw).hexdigest();self.save('result.json',self.worker)
                if defect=='missing': self.log.unlink()
                if defect=='marker': self.marker.write_text(self.marker.read_text().replace('def test_commit_fixture_rewritten_history_fails','def test_other'))
                if defect=='error': self.entry['native_case']['error']='AssertionError: foreign'
                if defect=='worker_root': self.request['worker_root']='/foreign';self.save('request.json',self.request)
                if defect=='recorded_receipt': self.state['attempts'][0]['results'][0]['token']='foreign'
                if defect=='output_hash': self.output.write_bytes(self.output.read_bytes()+b'drift')
                if defect=='unbound_log':
                    self.output.write_bytes(b'unrelated output');self.worker['evidence'][self.receipt['gate']]['sha256']=hashlib.sha256(self.output.read_bytes()).hexdigest();self.save('result.json',self.worker)
                if defect=='malformed_rows': self.receipt['flaky']=[None];self.save('receipt.json',self.receipt)
                if defect=='malformed_evidence': self.worker['evidence']=[];self.save('result.json',self.worker)
                if defect=='native_traversal': self.receipt['flaky'][0]['log']=self.worker_root+'/../outside';self.occ['evidence']=self.receipt['flaky'][0]['log'];self.save('receipt.json',self.receipt)
                if defect=='packet_source': self.entry['post_merge']['source']={'head':'f'*40,'digest':'e'*64}
                with self.assertRaises(ValueError):
                    c.attribute_flaky(self.state,self.occ['id'],self.entry,self.root)
                self.assertNotIn('attribution',self.occ)


    def test_reviewed_contradictions_and_malformed_lineage_block(self):
        import hashlib
        for defect in ('pytest_error', 'source_changed', 'interrupted', 'native_exit',
                       'attempt_shape', 'result_shape', 'plan_shape'):
            with self.subTest(defect=defect):
                self.build()
                if defect == 'pytest_error':
                    raw = self.log.read_bytes().replace(b'1 failed, 87 passed', b'1 failed, 86 passed, 1 error')
                    raw += b'ERROR agents/benchmarks/code_bench_test.py::test_other - RuntimeError: setup broke\n'
                    self.log.write_bytes(raw)
                    self.output.write_bytes(raw)
                    self.entry['native_case']['log_sha256'] = hashlib.sha256(raw).hexdigest()
                    self.worker['evidence'][self.receipt['gate']]['sha256'] = hashlib.sha256(raw).hexdigest()
                if defect == 'source_changed': self.worker['source_unchanged'] = False
                if defect == 'interrupted': self.worker['interrupted'] = True
                if defect == 'native_exit': self.worker['native_exit'] = 1
                if defect == 'attempt_shape': self.state['attempts'] = [None]
                if defect == 'result_shape': self.state['attempts'][0]['results'] = [None]
                if defect == 'plan_shape': self.state['plan'] = None
                self.save('result.json', self.worker)
                with self.assertRaises(ValueError):
                    c.attribute_flaky(self.state, self.occ['id'], self.entry, self.root)
                self.assertNotIn('attribution', self.occ)

    def test_retained_binding_revalidates_original_state_and_plan(self):
        for defect in ('receipt_token', 'captured_request', 'current_plan'):
            with self.subTest(defect=defect):
                self.build()
                c.attribute_flaky(self.state, self.occ['id'], self.entry, self.root)
                if defect == 'receipt_token':
                    self.state['attempts'][0]['results'][0]['token'] = 'foreign'
                elif defect == 'captured_request':
                    self.request['worker_root'] = '/foreign'
                    self.save('request.json', self.request)
                else:
                    self.state['plan']['gates'][0]['worker_root'] = '/new-current-worker'
                block = q.attribution_block(self.state['flaky'], self.root, state=self.state)
                if defect == 'current_plan':
                    self.assertIsNone(block)
                else:
                    self.assertIsNotNone(block)


if __name__ == '__main__':
    unittest.main()
