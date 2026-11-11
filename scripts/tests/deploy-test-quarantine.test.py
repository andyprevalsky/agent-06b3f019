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

    def test_cli_prints_the_table(self):
        self.write_ledger(['QUARANTINED_PASS'] * 5)
        out = subprocess.run([sys.executable, str(ROOT / 'scripts/test_quarantine.py'), 'report', '--root',
                              str(self.root), '--ledger', str(self.ledger)], capture_output=True, text=True,
                             check=True, timeout=60).stdout
        self.assertIn('Suite.test_flaky_unit', out)
        self.assertIn('2 quarantined test(s); 1 ready to release', out)


class StructuralSuiteAttribution(unittest.TestCase):
    def setUp(self):
        import hashlib
        self.hash = lambda raw: hashlib.sha256(raw).hexdigest()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        git(self.root, 'init', '-q')
        registry = self.root / 'scripts/run-deploy-structural-gates.py'
        registry.parent.mkdir(parents=True)
        registry.write_text("GATES = (Gate('deploy-test-cycle', ('python3', 'scripts/tests/deploy-test-cycle.test.py')), )\n")
        head = commit(self.root)
        self.path = 'scripts/tests/deploy-test-cycle.test.py'
        self.target = self.root / self.path
        self.target.parent.mkdir()
        self.occurrence = {'id': 'a' * 32, 'gate': 'deploy-command-structural', 'unit': 'deploy-test-cycle',
                           'native_result': 'FLAKY', 'attempts': 2, 'round': 12, 'phase': 'focused',
                           'source': {'head': head, 'digest': 'd' * 64}, 'evidence': '/tmp/native/suite.log',
                           'unit_finished_at': 123.0}
        self.markers_for(('test_one', 'test_two'))
        folder = self.root / '.context/test/attempts/12/focused/deploy-command-structural'
        (folder / 'remote-artifact').mkdir(parents=True)
        self.log = folder / 'remote-artifact/worker.log'
        self.text = ("== deploy-test-cycle: exit=0 duration=1.0s ==\n"
                     "ERROR: test_one (__main__.Cycle.test_one)\ntrace one\n"
                     "ERROR: test_two (__main__.Cycle.test_two)\ntrace two\n"
                     "Ran 499 tests in 1.0s\n\nFAILED (errors=2)\n"
                     "--- rerun of deploy-test-cycle (attempt 2 of 2: Cycle.test_one Cycle.test_two) ---\n"
                     "..\n----------------------------------------------------------------------\nRan 2 tests in 0.1s\n\nOK\n")
        row = {'unit': 'deploy-test-cycle', 'status': 'FLAKY', 'attempts': 2, 'scope': 'suite',
               'log': self.occurrence['evidence'], 'at': 123.0}
        self.receipt = {'gate': 'deploy-command-structural', 'source': self.occurrence['source'],
                        'executed': True, 'complete': True, 'native_exit': 0, 'flaky': [row],
                        'timed_out': False, 'cancelled': False, 'lingering_group': False,
                        'worker_evidence': {'deploy-command-structural': {
                            'command': ['python3', 'scripts/run-deploy-structural-gates.py', '--max-workers', '4'],
                            'native_exit': 0, 'status': 'PASS', 'flaky': [row], 'log': str(self.log),
                            'timed_out': False, 'cancelled': False, 'lingering_group': False}}}
        self.receipt_path = folder / 'receipt.json'
        self.entry = {'attribution': 'NOT_INTRODUCED', 'evidence': 'docs/rca/case.md', 'marker': self.path,
                      'post_merge': {k: 'original evidence' for k in ('test', 'command', 'scope', 'error', 'source', 'evidence')}}
        self.seal()

    def markers_for(self, names, repair=None):
        repair = repair or 'pending-handoff:' + self.occurrence['id']
        self.target.write_text('from test_quarantine import quarantine\nclass Cycle:\n' + ''.join(
            "    @quarantine(since='2026-11-11', repair=%r, error='ValueError: old controller still active', evidence='docs/rca/case.md')\n"
            "    def %s(self):\n        raise ValueError('original assertion remains')\n" % (repair, name)
            for name in names))

    def seal(self):
        self.log.write_text(self.text)
        worker = self.receipt['worker_evidence']['deploy-command-structural']
        worker['sha256'] = self.hash(self.log.read_bytes())
        self.receipt_path.write_text(json.dumps(self.receipt))
        self.entry['suite_binding'] = {'receipt': str(self.receipt_path.relative_to(self.root)),
                                      'receipt_sha256': self.hash(self.receipt_path.read_bytes()),
                                      'log_sha256': worker['sha256']}

    def validate(self):
        return q.validate_attribution(self.occurrence, self.entry, self.root)

    def test_all_original_cases_bound_and_suite_pass_cannot_count_for_release(self):
        result = self.validate()
        self.assertEqual(['Cycle.test_one', 'Cycle.test_two'], result['suite_binding']['cases'])
        self.assertEqual(result['suite_binding'], result['post_merge']['suite_binding'])
        for marker in q.markers(self.root, [self.path]):
            self.assertFalse(q.unit_matches(marker, 'deploy-test-cycle'))
            self.assertTrue(q.unit_matches(marker, 'Cycle.' + marker['name']))

    def test_missing_or_wrong_owner_marker_and_wrong_handoff_refuse(self):
        for body in ('one', 'owner', 'handoff'):
            with self.subTest(body=body):
                self.markers_for(('test_one',) if body == 'one' else ('test_one', 'test_two'),
                                 'pending-handoff:' + 'b' * 32 if body == 'handoff' else None)
                if body == 'owner':
                    self.target.write_text(self.target.read_text().replace('class Cycle:', 'class Other:'))
                with self.assertRaises(ValueError):
                    self.validate()

    def test_original_receipt_and_log_hash_changes_refuse(self):
        self.receipt_path.write_text(self.receipt_path.read_text() + ' ')
        with self.assertRaisesRegex(ValueError, 'hash changed'):
            self.validate()
        self.seal()
        self.log.write_text(self.text + 'tampered')
        with self.assertRaisesRegex(ValueError, 'hash changed'):
            self.validate()

    def test_wrong_source_native_flags_and_occurrence_binding_refuse(self):
        import copy
        original = copy.deepcopy(self.receipt)
        for change in ('source', 'bool_exit', 'incomplete', 'timeout', 'row_time'):
            with self.subTest(change=change):
                self.receipt = copy.deepcopy(original)
                if change == 'source':
                    self.receipt['source'] = {'head': 'b' * 40}
                elif change == 'bool_exit':
                    self.receipt['native_exit'] = False
                elif change == 'incomplete':
                    self.receipt['complete'] = False
                elif change == 'timeout':
                    self.receipt['timed_out'] = True
                else:
                    self.receipt['flaky'][0]['at'] = 124.0
                self.seal()
                with self.assertRaises(ValueError):
                    self.validate()

    def test_ambiguous_or_uncovered_original_failures_and_rerun_refuse(self):
        original = self.text
        for text in (original.replace('errors=2', 'errors=3'),
                     original.replace('Cycle.test_one Cycle.test_two', 'Cycle.test_one'),
                     original.replace('ERROR: test_two', 'ERROR: setUpClass'),
                     original.replace('Ran 2 tests', 'Ran 3 tests'),
                     original.replace('\nOK\n', '\nOK (skipped=1)\n'),
                     original + original):
            with self.subTest(text=text):
                self.text = text
                self.seal()
                with self.assertRaises(ValueError):
                    self.validate()

    def test_wrong_canonical_registration_and_path_refuse(self):
        registry = self.root / 'scripts/run-deploy-structural-gates.py'
        registry.write_text("GATES = (Gate('deploy-test-cycle', ('python3', 'scripts/tests/other.test.py')), )\n")
        self.occurrence['source'] = {'head': commit(self.root), 'digest': 'e' * 64}
        self.receipt['source'] = self.occurrence['source']
        self.seal()
        with self.assertRaisesRegex(ValueError, 'command mismatch'):
            self.validate()
        self.entry['marker'] = '../scripts/tests/deploy-test-cycle.test.py'
        with self.assertRaises(ValueError):
            self.validate()

    def test_missing_direct_marker_keeps_original_error_without_explicit_binding(self):
        self.entry.pop('suite_binding')
        self.occurrence['unit'] = 'Cycle.test_unmarked'
        with self.assertRaisesRegex(ValueError, 'no quarantine marker for Cycle.test_unmarked'):
            self.validate()

    def test_every_marker_evidence_must_match_attribution(self):
        self.target.write_text(self.target.read_text().replace("evidence='docs/rca/case.md'",
                                                              "evidence='docs/rca/other.md'", 1))
        with self.assertRaisesRegex(ValueError, 'marker evidence differs'):
            self.validate()

    def test_missing_unknown_and_nonboolean_native_flags_refuse(self):
        import copy
        original = copy.deepcopy(self.receipt)
        for target in ('receipt', 'worker'):
            for key in ('timed_out', 'cancelled', 'lingering_group'):
                for value in ('missing', None, 0, '', True):
                    with self.subTest(target=target, key=key, value=value):
                        self.receipt = copy.deepcopy(original)
                        row = (self.receipt if target == 'receipt' else
                               self.receipt['worker_evidence']['deploy-command-structural'])
                        if value == 'missing':
                            row.pop(key)
                        else:
                            row[key] = value
                        self.seal()
                        with self.assertRaises(ValueError):
                            self.validate()

    def test_log_symlink_outside_original_artifact_refuses(self):
        outside = self.root / 'outside.log'
        outside.write_text(self.text)
        self.log.unlink()
        self.log.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'resolved worker log outside'):
            self.validate()

    def test_registry_read_disables_git_replace_objects(self):
        original = subprocess.run
        with patch.object(q.subprocess, 'run', wraps=original) as run:
            self.validate()
        self.assertTrue(any(call.args[0][:3] == ['git', '--no-replace-objects', 'show']
                            for call in run.call_args_list))

    def test_direct_case_path_remains_valid_without_native_binding(self):
        self.entry.pop('suite_binding')
        self.occurrence['unit'] = 'Cycle.test_one'
        result = self.validate()
        self.assertNotIn('suite_binding', result)
        self.assertNotIn('suite_binding', result['post_merge'])


if __name__ == '__main__':
    unittest.main()
