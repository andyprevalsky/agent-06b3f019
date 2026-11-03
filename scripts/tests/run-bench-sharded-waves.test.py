#!/usr/bin/env python3
"""Owning regression for run-bench bounded sharded waves (one logical batch, fixed infra denominator).

A scripted fake operator stands in for run-original600-controller.py: it records every
call and writes the admission result.json and native-release-audit.json the real
operator writes, so no provider, Machine or credential is touched.
"""
from pathlib import Path
import json, os, subprocess, sys, tempfile, unittest

ROOT = Path(__file__).resolve().parents[2]
DRIVER = ROOT / 'scripts/run-bench-sharded-waves.py'
TASKS70 = [f'polar-bu-{i:03d}' for i in range(70)]

FAKE = r'''
import json, os, sys, time
from pathlib import Path
argv = sys.argv[1:]
def value(name):
    return argv[argv.index(name) + 1] if name in argv else None
calls = Path(os.environ['FAKE_CALLS'])
plan = json.loads(os.environ['FAKE_PLAN'])
tasks = json.loads(Path(value('--tasks')).read_text())
runs = int(value('--repetitions'))
mode = 'run' if '--run' in argv else 'check'
with calls.open('a') as stream:
    stream.write(json.dumps(dict(mode=mode, tasks=tasks, scheduled_total=int(value('--scheduled-total')),
                                 prior_infra=int(value('--prior-infra')), task_timeout=value('--task-timeout'),
                                 source_ref=value('--source-ref'), session=os.getsid(0),
                                 parent_session=os.getsid(os.getppid()))) + '\n')
index = sum(1 for line in calls.read_text().splitlines() if json.loads(line)['mode'] == mode) - 1
step = plan[index] if index < len(plan) else {}
if mode == 'check':
    if step.get('check_rc'):
        sys.exit(step['check_rc'])
    print(json.dumps(dict(status='CHECKED_NOT_LAUNCHED', source_ref=value('--source-ref'), task_ref=value('--source-ref'),
                          manifest=dict(tasks=len(tasks), task_timeout=int(value('--task-timeout'))),
                          wave=dict(scheduled_total=int(value('--scheduled-total')), prior_infra=int(value('--prior-infra'))),
                          controllers=1, copies=len(tasks) * runs)))
    sys.exit(0)
admission = Path(value('--state-dir')) / ('admission-%02d-%d' % (index, os.getpid()))
admission.mkdir()
print(json.dumps(dict(directory=str(admission), status='SHARDED_ADMISSION_STARTED', copies=len(tasks) * runs)), flush=True)
if step.get('no_result'):
    sys.exit(1)
copies = len(tasks) * runs
missing = step.get('missing', 0)
(admission / 'result.json').write_text(json.dumps(dict(
    scheduled_total=copies, observed_jobs=copies - missing, missing_jobs=missing, infra_failures=step.get('infra', 0),
    task_status={'PASS': copies - missing}, shards_without_summary=step.get('no_summary', []),
    coordination=dict(abort_reason=step.get('abort'), terminate_reason=step.get('terminate'), infra_true=step.get('infra_true', 0)))))
if step.get('released', True):
    (admission / 'native-release-audit.json').write_text(json.dumps(dict(released=True, observed_at=time.time())))
sys.exit(step.get('rc', 0))
'''


class Waves(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o700)
        self.fake = self.root / 'fake-operator.py'
        self.fake.write_text(FAKE)
        self.calls = self.root / 'calls.jsonl'

    def run_driver(self, tasks, plan=(), runs=3, concurrency=70, check=False, extra=()):
        manifest = self.root / 'manifest.json'
        manifest.write_text(json.dumps(tasks))
        argv = [sys.executable, str(DRIVER), '--state-dir', str(self.state), '--tasks', str(manifest),
                '--runs', str(runs), '--concurrency', str(concurrency), *(['--check'] if check else []),
                '--', sys.executable, str(self.fake), '--',
                '--source-ref', 'a' * 40, '--state-dir', str(self.state), '--repetitions', str(runs),
                '--task-timeout', '7200', *extra]
        env = dict(os.environ, FAKE_CALLS=str(self.calls), FAKE_PLAN=json.dumps(list(plan)))
        done = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=60)
        batches = sorted(self.state.glob('waves-*/batch.json'))
        batch = json.loads(batches[-1].read_text()) if batches else None
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []
        return done, batch, calls

    def test_full_70_task_k3_dry_run_checks_every_wave_against_the_original_total(self):
        done, batch, calls = self.run_driver(TASKS70, check=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([len(w['tasks']) for w in batch['waves']], [23, 23, 23, 1])
        self.assertTrue(all(w['copies'] <= 70 for w in batch['waves']))
        self.assertEqual([t for w in batch['waves'] for t in w['tasks']], TASKS70)  # ordered, every task once
        self.assertEqual(batch['scheduled_total'], 210)
        self.assertEqual([c['mode'] for c in calls], ['check'] * 4)
        self.assertTrue(all(c['scheduled_total'] == 210 and c['prior_infra'] == 0 and c['task_timeout'] == '7200'
                            and c['source_ref'] == 'a' * 40 for c in calls))
        self.assertEqual({w['state'] for w in batch['waves']}, {'CHECKED'})
        self.assertEqual(batch['unlaunched_copies'], 210)
        self.assertFalse(batch['batch_complete'])
        self.assertFalse(batch['acceptance_credit'])

    def test_30_task_batch_runs_waves_in_order_and_carries_confirmed_infra(self):
        tasks = TASKS70[:30]
        done, batch, calls = self.run_driver(tasks, plan=[dict(infra=2), dict(infra=1)])
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([c['mode'] for c in calls], ['check', 'run', 'check', 'run'])
        self.assertEqual([len(c['tasks']) for c in calls], [23, 23, 7, 7])
        self.assertEqual([c['prior_infra'] for c in calls], [0, 0, 2, 2])
        self.assertTrue(all(c['scheduled_total'] == 90 for c in calls))
        self.assertEqual(batch['infra_confirmed'], 3)
        self.assertEqual([w['state'] for w in batch['waves']], ['RELEASED', 'RELEASED'])
        self.assertTrue(batch['batch_complete'])
        self.assertEqual(batch['unlaunched_copies'], 0)
        self.assertFalse(batch['acceptance_credit'])  # verdicts belong to the batch scorecard

    def test_original_denominator_threshold_leaves_the_remainder_explicitly_unlaunched(self):
        # 210 scheduled: 20 * 11 >= 210. 6 + 5 confirmed infra after wave 1 stops waves 2 and 3.
        done, batch, calls = self.run_driver(TASKS70, plan=[dict(infra=6), dict(infra=5)])
        self.assertEqual(done.returncode, 1)
        self.assertEqual([w['state'] for w in batch['waves']], ['RELEASED', 'RELEASED', 'NOT_LAUNCHED', 'NOT_LAUNCHED'])
        self.assertIn('11/210', batch['stop_reason'])
        self.assertTrue(batch['infra_stop_reached'])
        self.assertEqual(batch['unlaunched_copies'], 69 + 3)
        self.assertEqual(len([c for c in calls if c['mode'] == 'run']), 2)
        self.assertFalse(batch['batch_complete'])

    def test_unverified_release_blocks_the_next_wave(self):
        done, batch, calls = self.run_driver(TASKS70[:30], plan=[dict(released=False)])
        self.assertEqual(done.returncode, 1)
        self.assertEqual([w['state'] for w in batch['waves']], ['JOINED', 'NOT_LAUNCHED'])
        self.assertIn('release not verified', batch['stop_reason'])
        self.assertEqual(len([c for c in calls if c['mode'] == 'run']), 1)

    def test_incomplete_wave_stops_the_batch_and_keeps_live_confirmed_infra(self):
        # A released wave that lost jobs or a shard export stops the batch; the coordinator's
        # live confirmed infra count (4) outranks the exported count (1) for the next denominator.
        done, batch, calls = self.run_driver(TASKS70, plan=[dict(missing=3, rc=1, infra=1, infra_true=4)])
        self.assertEqual(done.returncode, 1)
        self.assertEqual([w['state'] for w in batch['waves']], ['RELEASED'] + ['NOT_LAUNCHED'] * 3)
        self.assertIn('wave 0 incomplete: 3 missing jobs', batch['stop_reason'])
        self.assertEqual(batch['infra_confirmed'], 4)
        self.assertEqual(len([c for c in calls if c['mode'] == 'run']), 1)
        self.calls.unlink()
        done, batch, _ = self.run_driver(TASKS70, plan=[dict(no_summary=[1])])
        self.assertEqual(done.returncode, 1)
        self.assertIn('shards without summary [1]', batch['stop_reason'])
        self.assertEqual(batch['unlaunched_copies'], 69 * 2 + 3)
        # A live count below the exported one never lowers it.
        self.calls.unlink()
        done, batch, calls = self.run_driver(TASKS70[:30], plan=[dict(infra=2, infra_true=1), dict()])
        self.assertEqual((done.returncode, batch['infra_confirmed']), (0, 2))
        self.assertEqual([c['prior_infra'] for c in calls if c['mode'] == 'run'], [0, 2])

    def test_wave_pass_never_makes_an_incomplete_batch_green(self):
        # Wave 0 passes everything; wave 1 loses jobs. The batch stays incomplete and exits 1.
        done, batch, _ = self.run_driver(TASKS70[:30], plan=[dict(), dict(missing=2, rc=1)])
        self.assertEqual(done.returncode, 1)
        self.assertEqual([w['state'] for w in batch['waves']], ['RELEASED', 'RELEASED'])
        self.assertFalse(batch['batch_complete'])

    def test_aborted_wave_or_missing_result_stops_later_waves(self):
        done, batch, _ = self.run_driver(TASKS70, plan=[dict(abort='shard [0] failed before global release')])
        self.assertEqual(done.returncode, 1)
        self.assertEqual([w['state'] for w in batch['waves']][1:], ['NOT_LAUNCHED'] * 3)
        self.assertIn('failed before global release', batch['stop_reason'])
        self.calls.unlink()
        done, batch, _ = self.run_driver(TASKS70, plan=[dict(no_result=True)])
        self.assertEqual(done.returncode, 1)
        self.assertEqual(batch['waves'][0]['state'], 'FAILED_NO_RESULT')
        self.assertEqual(batch['unlaunched_copies'], 69 * 2 + 3)  # wave 0 launched; its copies are not unlaunched

    def test_batch_scorecard_counts_every_wave_and_the_unlaunched_remainder(self):
        done, batch, _ = self.run_driver(TASKS70, plan=[dict(infra=6), dict(infra=5)])
        self.assertEqual(done.returncode, 1)
        self.assertIn('scripts/run-bench scorecard', done.stdout)
        directory = next(self.state.glob('waves-*'))
        for wave in batch['waves'][:2]:  # the fake admissions carry only result.json; add the coordinator record
            Path(wave['admission_dir'], 'coordination.json').write_text(json.dumps(dict(
                scheduled_total=wave['copies'], controllers=0, shards={}, finished_at=batch['ended_at'])))
        card = subprocess.run([sys.executable, str(ROOT / 'scripts/cloudbench-scorecard.py'), str(directory), '--json',
                               '--ledger', str(self.root / 'ledger.jsonl')], capture_output=True, text=True, timeout=60)
        self.assertEqual(card.returncode, 0, card.stderr)
        exp = json.loads(card.stdout)['experiment']
        self.assertEqual(exp['scheduled_total'], 210)  # the original batch denominator, not a wave's
        self.assertEqual(exp['infra_jobs'], 11)
        self.assertTrue(exp['infra_breached'])
        self.assertEqual(exp['progress']['queued'], 72)  # waves 3-4 never launched: 69 + 3 copies
        self.assertEqual(exp['state'], 'ABORTED')
        self.assertTrue(any('not launched: 24 tasks' in i['detail'] for i in exp['lifecycle']))

    def test_refused_check_launches_nothing(self):
        done, batch, calls = self.run_driver(TASKS70, plan=[dict(check_rc=2)])
        self.assertEqual(done.returncode, 1)
        self.assertEqual([c['mode'] for c in calls], ['check'])
        self.assertEqual(batch['waves'][0]['state'], 'CHECK_REFUSED')
        self.assertEqual(batch['unlaunched_copies'], 210)

    def test_operator_failure_stops_after_release_without_launching_another_wave(self):
        done, batch, calls = self.run_driver(TASKS70, plan=[dict(rc=7)])
        self.assertEqual(done.returncode, 1)
        self.assertEqual([c['mode'] for c in calls], ['check', 'run'])
        self.assertEqual(batch['waves'][0]['exit_code'], 7)
        self.assertEqual([w['state'] for w in batch['waves']][1:], ['NOT_LAUNCHED'] * 3)

    def test_operator_session_is_separate_from_terminal_signal_group(self):
        done, _, calls = self.run_driver(TASKS70, check=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue(calls)
        self.assertTrue(all(c['session'] != c['parent_session'] for c in calls), calls)

    def test_fails_closed_on_invalid_shape_or_driver_owned_options(self):
        for kwargs, message in [(dict(concurrency=2), 'repetitions <= --concurrency'),
                                (dict(concurrency=210), '--concurrency < tasks x repetitions'),
                                (dict(extra=('--scheduled-total', '9')), 'wave driver owns'),
                                (dict(extra=('--run',)), 'wave driver owns')]:
            with self.subTest(message=message):
                done, batch, calls = self.run_driver(TASKS70, **kwargs)
                self.assertEqual(done.returncode, 2)
                self.assertIn(message, done.stderr)
                self.assertEqual(calls, [])
        done, _, calls = self.run_driver(TASKS70[:2] + TASKS70[:1], concurrency=4)
        self.assertEqual(done.returncode, 2)
        self.assertIn('distinct task names', done.stderr)


if __name__ == '__main__':
    unittest.main()
