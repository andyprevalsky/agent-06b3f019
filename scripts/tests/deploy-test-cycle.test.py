#!/usr/bin/env python3
"""Exercise the real staged coordinator; no provider, database, or app processes."""
from concurrent.futures import ThreadPoolExecutor
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import deploy_test_cycle as c

class Cycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'code').write_text('original')
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=test', '-c',
                        'user.email=test@example.com', 'commit', '-qm', 'fixture'], check=True)
        self.directory = self.root / '.context' / 'cycle'
        (self.root / '.git' / 'info' / 'exclude').write_text('.context/\n')
        self.workers = tempfile.TemporaryDirectory()
        for name in ('api', 'ui'):
            (Path(self.workers.name) / name).mkdir()
        self.plan = {'source': c.source(self.root), 'gates': [
            {'name': 'static', 'category': 'eslint', 'quick': True, 'command': ['true'], 'checks': ['lint']},
            {'name': 'api', 'worker': 'api-worker', 'command': ['true'], 'checks': ['a', 'b']},
            {'name': 'ui', 'worker': 'ui-worker', 'command': ['true'], 'checks': ['c']},
        ] + [{'name':name,'category':name,'quick':True,'command':['true'],'checks':[name]}
             for name in ('format','typescript','backend-structural')]}
        for index, gate in enumerate(self.plan['gates'][1:3]):
            gate.update(worker_transport='local-isolated',
                        cwd=str(Path(self.workers.name) / gate['name']),
                        env={'CONDUCTOR_WORKSPACE_NAME': gate['name'],
                             'CONDUCTOR_PORT': str(12000 + index * 12000)})
        self.state = c.initialize(self.plan, self.root)

    def tearDown(self):
        c.CANCEL.clear()
        self.workers.cleanup()
        self.temp.cleanup()

    def result(self, gate='api', **cases):
        return {'gate': gate, 'status': 'FAIL' if 'FAIL' in cases.values() else 'PASS',
                'cases': cases, 'complete': True, 'source': self.state['source'],
                'command': ['true'], 'log': 'original.log', 'native_exit': 1}

    def failure(self):
        self.state['phase'] = 'initial'
        c.advance(self.state, [self.result(a='FAIL', b='PASS'), self.result('ui', c='PASS')])
        return self.state['failures'][-1]

    def report(self, failure, attribution='INTRODUCED', **fields):
        return {'failures': [{'id': failure['id'], 'check': failure['check'],
                'source': failure['source'], 'description': 'real failure', 'evidence': 'RCA evidence',
                'native_result': failure['native_result'], 'command': failure.get('command'), 'attribution': attribution, **fields}]}

    def test_clean_run_finishes_without_second_full_sweep(self):
        c.run_phase(self.plan, self.state, self.directory, self.root)
        self.assertEqual('initial', self.state['phase'])
        c.run_phase(self.plan, self.state, self.directory, self.root)
        self.assertTrue(self.state['ready'])
        self.assertEqual(['quick', 'initial'], [a['phase'] for a in self.state['attempts']])

    def test_failure_parallel_rca_then_focus_full_failed_and_final(self):
        f = self.failure()
        c.adjudicate(self.state, self.report(f))
        c.focused_plan(self.state, self.plan, {'source': self.state['source'],
                       'gates': {'api': {'command': ['true'], 'checks': ['a']}}})
        self.assertEqual(['api'], [g['name'] for g in c.records(self.plan, self.state)])
        c.advance(self.state, [self.result(a='PASS')])
        self.assertEqual('failed-gates', self.state['phase'])
        self.assertEqual(['a', 'b'], c.records(self.plan, self.state)[0]['checks'])
        c.advance(self.state, [self.result(a='PASS', b='PASS')])
        self.assertEqual('quick', self.state['phase'])
        c.advance(self.state, [self.result('static', lint='PASS')])
        self.assertEqual('final', self.state['phase'])
        self.assertEqual({'api', 'ui'}, {g['name'] for g in c.records(self.plan, self.state)})
        c.advance(self.state, [self.result(a='PASS', b='PASS'), self.result('ui', c='PASS')])
        self.assertTrue(self.state['ready'])

    def test_skip_only_advances_without_rerun(self):
        f = self.failure()
        c.adjudicate(self.state, self.report(f, 'NOT_INTRODUCED',
                     external_provider={'name': 'provider', 'reason': 'outage'}))
        self.assertTrue(self.state['ready'])
        self.assertIn('api/a', self.state['skips'])
        self.assertEqual(1, len(self.state['attempts']))
        self.assertEqual('FAIL', self.state['attempts'][0]['results'][0]['cases']['a'])

    def test_delegation_is_skip_without_waiting_for_ack(self):
        f = self.failure()
        c.adjudicate(self.state, self.report(f, 'NOT_INTRODUCED',
                     repair_agent='https://boxes.dev/thread/repair'))
        self.assertTrue(self.state['ready'])

    def test_unknown_and_introduced_cannot_be_waived(self):
        f = self.failure()
        for attr, fields in [('UNKNOWN', {}), ('INTRODUCED', {'repair_agent': 'https://boxes.dev/thread/repair'}),
                             ('UNKNOWN', {'external_provider': {'name': 'provider', 'reason': 'outage'}})]:
            with self.subTest(attr=attr, fields=fields), self.assertRaises(ValueError):
                c.adjudicate(self.state, self.report(f, attr, **fields))
        self.assertEqual('triage', self.state['phase'])
        self.assertFalse(self.state['ready'])

    def test_missing_policy_helper_blocks_without_traceback(self):
        f=self.failure()
        plan=self.root/'.context/plan.json';report=self.root/'.context/rca.json'
        c.write(plan,self.plan);c.write(report,self.report(f));c.write(self.directory/'cycle.json',self.state)
        with patch.dict(sys.modules,{'deploy_failure_report':None}):
            code=c.main(['triage','--plan',str(plan),'--state-dir',str(self.directory),
                         '--root',str(self.root),'--input',str(report)])
        self.assertEqual(2,code)
        self.assertEqual('triage',c.read(self.directory/'cycle.json')['phase'])

    def test_wrong_source_or_missing_constituent_refused(self):
        f = self.failure()
        report = self.report(f); report['failures'][0]['source'] = {'head': 'wrong'}
        with self.assertRaises(ValueError): c.adjudicate(self.state, report)
        with self.assertRaises(ValueError): c.adjudicate(self.state, {'failures': []})

    def test_unexecuted_constituents_cannot_be_hidden_by_waiver(self):
        f = self.failure(); f['complete'] = False
        with self.assertRaises(ValueError):
            c.adjudicate(self.state, self.report(f, 'NOT_INTRODUCED',
                         external_provider={'name': 'provider', 'reason': 'outage'}))

    def test_handed_off_unverified_execution_requires_full_recovery_not_skip(self):
        f = self.failure()
        f['complete'] = False
        f['native_result'] = 'UNVERIFIED'
        c.adjudicate(self.state, self.report(f, 'NOT_INTRODUCED',
                     repair_agent='https://boxes.dev/thread/repair', execute_unverified=True))
        self.assertEqual('needs-focused-plan', self.state['phase'])
        self.assertFalse(self.state['ready'])
        self.assertEqual({}, self.state['skips'])
        self.assertEqual(['api'], self.state['repair_gates'])
        self.assertEqual('execution required', f['disposition'])
        self.assertEqual('NOT_INTRODUCED', f['rca']['attribution'])
        with self.assertRaises(ValueError):
            c.focused_plan(self.state, self.plan, {'source': self.state['source'],
                           'gates': {'api': {'command': ['true'], 'checks': ['b']}}})
        c.focused_plan(self.state, self.plan, {'source': self.state['source'],
                       'gates': {'api': {'command': ['true'], 'checks': ['a']}}})
        c.advance(self.state, [self.result(a='PASS')])
        self.assertEqual('failed-gates', self.state['phase'])
        self.assertEqual(['a', 'b'], c.records(self.plan, self.state)[0]['checks'])
        self.assertFalse(self.state['ready'])
        c.advance(self.state, [self.result(a='PASS', b='PASS')])
        c.advance(self.state, [self.result('static', lint='PASS')])
        self.assertEqual('final', self.state['phase'])
        self.assertEqual({'api', 'ui'}, {g['name'] for g in c.records(self.plan, self.state)})
        self.assertFalse(self.state['ready'])

    def test_execution_recovery_cannot_authorize_unknown_or_external_waivers(self):
        for attribution, fields in [('UNKNOWN', {}),
                ('NOT_INTRODUCED', {'external_provider': {'name':'provider','reason':'outage'}})]:
            with self.subTest(attribution=attribution):
                f = self.failure()
                f['complete'] = False
                with self.assertRaises(ValueError):
                    c.adjudicate(self.state, self.report(f, attribution,
                                 execute_unverified=True, **fields))
                self.assertEqual('triage', self.state['phase'])
                self.assertFalse(self.state['ready'])
                self.assertEqual({}, self.state['skips'])

    def test_focus_must_include_failed_case_not_arbitrary_green_subset(self):
        f = self.failure(); c.adjudicate(self.state, self.report(f))
        with self.assertRaises(ValueError):
            c.focused_plan(self.state, self.plan, {'source': self.state['source'],
                           'gates': {'api': {'command': ['true'], 'checks': ['b']}}})

    def test_final_failure_returns_to_rca(self):
        self.state['phase'] = 'final'
        c.advance(self.state, [self.result(a='FAIL', b='PASS')])
        self.assertEqual('triage', self.state['phase'])
        self.assertFalse(self.state['ready'])

    def test_changed_source_refuses_old_green(self):
        (self.root / 'code').write_text('new')
        with self.assertRaises(ValueError):
            c.run_phase(self.plan, self.state, self.directory, self.root)

    def test_all_independent_failures_get_rca_requests(self):
        self.state['phase'] = 'initial'
        c.advance(self.state, [self.result(a='FAIL', b='FAIL'), self.result('ui', c='FAIL')])
        paths = c.rca_requests(self.state, self.directory)
        self.assertEqual(3, len(paths))
        self.assertEqual({'api/a', 'api/b', 'ui/c'}, {c.read(p)['check'] for p in paths})

    def test_distinct_workers_required_not_silent_local_serialization(self):
        self.plan['gates'][2]['worker'] = 'api-worker'
        with self.assertRaises(ValueError): c.validate_plan(self.plan)

    def test_infrastructure_structural_is_not_quick(self):
        self.plan['gates'][0]['category'] = 'deploy-command-structural'
        with self.assertRaises(ValueError): c.validate_plan(self.plan)

    def test_mandatory_quick_checks_cannot_be_omitted(self):
        self.plan['gates']=[g for g in self.plan['gates'] if g['name']!='format']
        with self.assertRaisesRegex(ValueError,'quick checks are required'):
            c.validate_plan(self.plan)

    def test_worker_cannot_run_in_coordinator_checkout(self):
        self.plan['gates'][1]['cwd'] = str(self.root)
        with self.assertRaisesRegex(ValueError, 'outside the coordinator'):
            c.initialize(self.plan, self.root)

    def test_workers_cannot_share_checkout_database_or_port(self):
        import copy
        for field in ('cwd', 'CONDUCTOR_WORKSPACE_NAME', 'CONDUCTOR_PORT'):
            with self.subTest(field=field):
                plan = copy.deepcopy(self.plan)
                a, b = plan['gates'][1:3]
                if field == 'cwd': b[field] = a[field]
                else: b['env'][field] = a['env'][field]
                with self.assertRaisesRegex(ValueError, 'must not share'):
                    c.initialize(plan, self.root)

    def test_remote_binding_must_name_its_actual_transport(self):
        gate = self.plan['gates'][1]
        gate.update(worker_transport='ssh', worker_host='worker.example', worker_root='/repo')
        with self.assertRaisesRegex(ValueError, 'ssh transport has no remote cancel'):
            c.initialize(self.plan, self.root)

    def test_saved_ssh_binding_is_refused_on_verify_and_refresh(self):
        # a state saved before the refusal existed: same plan, gate rebound to ssh (finding 4447557475)
        self.state.update(phase='ready', ready=True)
        plan = copy.deepcopy(self.plan)
        plan['gates'][1].update(worker_transport='ssh', worker_host='worker.example', worker_root='/repo',
                                command=['ssh', 'worker.example', 'python3 scripts/deploy_test_worker.py --stdio'],
                                case_protocol=True, result_transport='stdout', timeout_seconds=10,
                                worker_recipe={'cases': {'a': {'command': ['true']}, 'b': {'command': ['true']}}})
        plan['gates'][1].pop('cwd')
        self.state.update(plan=plan, plan_digest=c.digest(plan)); c.write(self.directory / 'cycle.json', self.state)
        self.assertEqual(2, c.verify_saved(self.directory, self.root))
        stale = dict(self.state, phase='stale', ready=False)
        with self.assertRaisesRegex(ValueError, 'ssh transport has no remote cancel'):
            c.refresh(stale, plan, {**plan, 'source': c.source(self.root)}, self.root)

    def test_focused_recipe_must_be_identical_except_for_narrowed_checks(self):
        gate = self.plan['gates'][1]  # finding 4447557578 follow-up
        bound = {'cases': {'a': {'command': ['true'], 'env': {'X': '1'}}, 'b': {'command': ['true']}},
                 'cleanup': {'command': ['true']}}
        gate.update(case_protocol=True, worker_recipe=bound)
        self.state = c.initialize(self.plan, self.root)
        self.failure(); self.state.update(phase='needs-focused-plan', repair_gates=['api'])
        self.state['failures'][-1]['disposition'] = 'blocking'
        altered = {'cases': {'a': {'command': ['true'], 'env': {'X': '2'}}}, 'cleanup': {'command': ['true']}}
        with self.assertRaisesRegex(ValueError, 'identical to the bound recipe'):
            c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {'api': {
                'command': gate['command'], 'checks': ['a'], 'worker_recipe': altered}}})
        no_cleanup = {'cases': {'a': bound['cases']['a']}}
        with self.assertRaisesRegex(ValueError, 'identical to the bound recipe'):
            c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {'api': {
                'command': gate['command'], 'checks': ['a'], 'worker_recipe': no_cleanup}}})
        narrowed = {'cases': {'a': bound['cases']['a']}, 'cleanup': bound['cleanup']}
        c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {'api': {
            'command': gate['command'], 'checks': ['a'], 'worker_recipe': narrowed}}})
        self.assertEqual('focused', self.state['phase'])

    def test_nested_worker_checkout_and_overlapping_listener_ports_are_rejected(self):
        import copy
        for kind in ('nested-root', 'port-offset', 'invalid-range'):
            with self.subTest(kind=kind):
                plan=copy.deepcopy(self.plan)
                a,b=plan['gates'][1:3]
                if kind=='nested-root': b['cwd']=str(Path(a['cwd'])/'nested')
                elif kind=='port-offset': b['env']['CONDUCTOR_PORT']='12020'
                else: b['env']['CONDUCTOR_PORT']='65000'
                with self.assertRaises(ValueError): c.initialize(plan,self.root)

    def test_quick_gate_keeps_its_declared_timeout_and_defaults_to_120(self):
        self.plan['gates'][0]['timeout_seconds'] = 300  # finding 4447557550
        with patch.object(c, 'run_command', return_value=(0, False, False, False)) as runner:
            c.execute(self.plan['gates'][0], self.state, self.directory, self.root)
            self.assertEqual(300, runner.call_args.kwargs['timeout'])

    def test_focused_task_cannot_drop_the_bound_worker_recipe(self):
        gate = self.plan['gates'][1]  # finding 4447557578
        gate.update(case_protocol=True, worker_recipe={'cases': {'a': {'command': ['true']}, 'b': {'command': ['true']}}})
        self.state = c.initialize(self.plan, self.root)
        self.failure(); self.state.update(phase='needs-focused-plan', repair_gates=['api'])
        self.state['failures'][-1]['disposition'] = 'blocking'
        with self.assertRaisesRegex(ValueError, 'bound worker'):
            c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {'api': {
                'command': ['bash', '-c', 'heavy command on the coordinator checkout'], 'checks': ['a']}}})
        self.assertEqual('needs-focused-plan', self.state['phase'])

    def test_report_lists_blocking_failures(self):
        failure = self.failure()  # finding 4447557591
        c.adjudicate(self.state, self.report(failure))  # INTRODUCED -> blocking
        self.assertEqual('needs-focused-plan', self.state['phase'])
        plan = self.root / 'plan.json'; c.write(plan, self.plan); c.write(self.directory / 'cycle.json', self.state)
        import contextlib, io
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            self.assertEqual(0, c.main(['report', '--plan', str(plan), '--state-dir', str(self.directory), '--root', str(self.root)]))
        text = (self.directory / 'report.md').read_text()
        self.assertIn('BLOCKING', text); self.assertIn('real failure', text); self.assertIn('Deploy validation: needs-focused-plan', text)

    def test_pending_post_merge_qualifies_ready_but_blocks_completion_until_resolved(self):
        failure = self.failure()
        packet = {"test": "api::a", "command": ["true"], "scope": "api/a", "error": "AssertionError: boom",
                  "source": self.state["source"]["head"], "evidence": ["original.log"]}
        c.adjudicate(self.state, self.report(failure, attribution="NOT_INTRODUCED", post_merge=packet))
        self.assertTrue(self.state["ready"]); self.assertEqual("ready", self.state["phase"])
        kept = next(f for f in self.state["failures"] if f["id"] == failure["id"])
        self.assertEqual("FAIL", kept["native_result"]); self.assertEqual("pending post-merge", kept["disposition"])
        self.assertEqual([failure["id"]], [p["id"] for p in self.state["pending_post_merge"]])
        plan = self.directory / "plan.json"; c.write(plan, self.plan); c.write(self.directory / "cycle.json", self.state)
        # pre-merge readiness is NOT blocked by a pending packet (Phase 3 verify must pass so the merge can happen)
        self.assertEqual(0, c.verify_saved(self.directory, self.root))
        args = ["--plan", str(plan), "--state-dir", str(self.directory), "--root", str(self.root)]
        import contextlib, io
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(0, c.main(["verify", *args]))
        self.assertEqual(1, json.loads(out.getvalue().strip().splitlines()[-1])["pending_post_merge"])  # count reported
        # completion (post-merge) is blocked until the packet is dispatched and resolved
        self.assertEqual(1, c.main(["complete", *args]))
        self.assertEqual(2, c.main(["verify", "--require-resolved", *args]))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(0, c.main(["report", *args]))
        self.assertIn("Pending post-merge: 1", (self.directory / "report.md").read_text())
        # a plain blocking failure still fails verify exactly as before (no loosening)
        blocked = copy.deepcopy(self.state); blocked.update(phase="needs-focused-plan", ready=False)
        c.write(self.directory / "cycle.json", blocked)
        self.assertEqual(2, c.main(["verify", *args])); self.assertEqual(1, c.verify_saved(self.directory, self.root))
        c.write(self.directory / "cycle.json", self.state)
        with self.assertRaisesRegex(ValueError, "repair link"):
            c.resolve_post_merge(self.state, failure["id"], "")
        with self.assertRaisesRegex(ValueError, "repair-thread or Rose repair-agent link"):
            c.resolve_post_merge(self.state, failure["id"], "http://example.com/not-a-repair")
        self.assertEqual(0, c.main(["resolve", *args, "--occurrence", failure["id"],
                                    "--repair-agent", "https://boxes.dev/thread/thr_post_merge_repair"]))
        self.assertEqual(0, c.main(["verify", *args])); self.assertEqual(0, c.main(["complete", *args]))
        self.assertEqual(0, c.main(["verify", "--require-resolved", *args]))
        saved = c.read(self.directory / "cycle.json")
        self.assertEqual([], saved["pending_post_merge"])
        self.assertEqual("delegated / waived", next(f for f in saved["failures"] if f["id"] == failure["id"])["disposition"])
        self.assertEqual("FAIL", next(f for f in saved["failures"] if f["id"] == failure["id"])["native_result"])

    def test_pending_post_merge_is_re_executed_after_a_refresh_that_changes_its_inputs(self):
        self.plan['gates'][1]['input_paths'] = ['code']  # api's fingerprint follows only this file
        self.state = c.initialize(self.plan, self.root)
        failure = self.failure()
        packet = {"test": "api::a", "command": ["true"], "scope": "api/a", "error": "AssertionError: boom",
                  "source": self.state["source"]["head"], "evidence": ["original.log"]}
        c.adjudicate(self.state, self.report(failure, attribution="NOT_INTRODUCED", post_merge=packet))
        self.assertIn('api/a', self.state['skips']); self.assertEqual(1, len(self.state['pending_post_merge']))
        # unchanged fingerprint for api (a new unrelated file): the pending skip is carried
        unchanged = copy.deepcopy(self.state); unchanged['phase'] = 'stale'
        (self.root / 'other').write_text('unrelated')
        c.refresh(unchanged, self.plan, {**self.plan, 'source': c.source(self.root)}, self.root)
        self.assertEqual('pending post-merge', unchanged['skips']['api/a']['disposition'])
        self.assertEqual(1, len(unchanged['pending_post_merge']))
        # changed fingerprint: skip dropped, no synthetic result, history retained, case re-executes
        (self.root / 'other').unlink(); (self.root / 'code').write_text('changed inputs')
        self.state['phase'] = 'stale'
        new = {**self.plan, 'source': c.source(self.root)}
        c.refresh(self.state, self.plan, new, self.root)
        self.assertNotIn('api/a', self.state['skips']); self.assertEqual([], self.state['pending_post_merge'])
        self.assertEqual(packet, self.state['superseded_pending_post_merge'][0]['packet'])
        self.assertFalse(any(f['native_result'].startswith('prior waived') for f in self.state['failures']))
        original = next(f for f in self.state['failures'] if f['id'] == failure['id'])
        self.assertEqual(('FAIL', 'pending post-merge'), (original['native_result'], original['disposition']))
        self.assertFalse(self.state.get('pending'))
        while self.state['phase'] in {'quick', 'final'}:
            c.run_phase(new, self.state, self.directory, self.root)
        self.assertTrue(self.state['ready'])
        api = next(r for r in self.state['attempts'][-1]['results'] if r['gate'] == 'api')
        self.assertEqual({'a': 'PASS', 'b': 'PASS'}, api['cases'])  # 'a' executed again, not SKIP
        self.assertEqual([], self.state['pending_post_merge'])


    def test_observation_loss_reexecutes_the_bound_gate_without_attribution_or_credit(self):
        self.state['phase'] = 'initial'
        lost = {**self.result(a='UNVERIFIED', b='PASS'), 'complete': False,
                'case_complete': {'a': False, 'b': True}, 'reason': 'coordinator lost the outer exit'}
        c.advance(self.state, [lost, self.result('ui', c='PASS')])
        occurrence = self.state['failures'][-1]
        self.assertEqual(('UNVERIFIED', False), (occurrence['native_result'], occurrence['complete']))
        # refusals: unknown id, a FAIL occurrence, a complete occurrence, an occurrence with a handoff
        with self.assertRaisesRegex(ValueError, 'unknown occurrence|awaiting RCA'):
            c.reexecute(self.state, 'no-such-id')
        for mutation, message in (({'native_result': 'FAIL'}, 'needs /RCA attribution'),
                                  ({'complete': True}, 'needs /RCA attribution'),
                                  ({'repair_agent': 'https://boxes.dev/thread/thr_x'}, 'already carries')):
            with self.subTest(mutation=mutation):
                trial = copy.deepcopy(self.state); next(f for f in trial['failures'] if f['id'] == occurrence['id']).update(mutation)
                with self.assertRaisesRegex(ValueError, message):
                    c.reexecute(trial, occurrence['id'])
        c.reexecute(self.state, occurrence['id'])
        self.assertEqual('needs-focused-plan', self.state['phase']); self.assertEqual(['api'], self.state['repair_gates'])
        self.assertNotIn('pending', self.state); self.assertEqual({}, self.state['skips']); self.assertFalse(self.state['ready'])
        kept = next(f for f in self.state['failures'] if f['id'] == occurrence['id'])
        self.assertEqual('UNVERIFIED', kept['native_result']); self.assertNotIn('rca', kept)
        self.assertEqual('observation loss; re-executing unchanged gate', kept['reexecution']['reason'])
        # the repair sequence executes the BOUND original command; a substitute is refused
        gate = self.plan['gates'][1]
        with self.assertRaises(ValueError):
            c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {'api': {'command': ['false'], 'checks': ['b']}}})
        c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {'api': {'command': gate['command'], 'checks': ['a']}}})
        for expected in ('focused', 'failed-gates', 'quick', 'final'):
            self.assertEqual(expected, self.state['phase'])
            c.run_phase(self.plan, self.state, self.directory, self.root)
        self.assertTrue(self.state['ready'])
        self.assertEqual({'a': 'PASS', 'b': 'PASS'}, next(r for r in self.state['attempts'][-1]['results'] if r['gate'] == 'api')['cases'])

    def test_reexecuted_gate_is_not_lost_when_the_remaining_triage_is_waived(self):
        # CodeRabbit 4449029650: initial phase yields A (api/a UNVERIFIED, observation loss) and B (ui/c FAIL).
        self.state['phase'] = 'initial'
        lost = {**self.result(a='UNVERIFIED', b='PASS'), 'complete': False,
                'case_complete': {'a': False, 'b': True}, 'reason': 'coordinator lost the outer exit'}
        c.advance(self.state, [lost, self.result('ui', c='FAIL')])
        a = next(f for f in self.state['failures'] if f['check'] == 'api/a')
        b = next(f for f in self.state['failures'] if f['check'] == 'ui/c')
        c.reexecute(self.state, a['id'])
        self.assertEqual(('triage', [b['id']]), (self.state['phase'], self.state['pending']))
        # the remaining occurrence is waived by delegation: the re-executed gate must still run
        c.adjudicate(self.state, self.report(b, attribution='NOT_INTRODUCED',
                                             repair_agent='https://boxes.dev/thread/thr_repair_b'))
        self.assertEqual('needs-focused-plan', self.state['phase'])
        self.assertFalse(self.state['ready'])
        self.assertIn('api', self.state['repair_gates'])
        c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {
            'api': {'command': self.plan['gates'][1]['command'], 'checks': ['a']}}})
        self.assertEqual('focused', self.state['phase'])
        self.assertEqual(['api'], [g['name'] for g in c.records(self.plan, self.state)])

    def test_per_triage_routing_is_cleared_so_a_stale_entry_cannot_route_a_later_triage(self):
        # path 1: triage completed by adjudicate after a reexecute -> tracking cleared
        self.state['phase'] = 'initial'
        lost = {**self.result(a='UNVERIFIED', b='PASS'), 'complete': False, 'case_complete': {'a': False, 'b': True}}
        c.advance(self.state, [lost, self.result('ui', c='FAIL')])
        a = next(f for f in self.state['failures'] if f['check'] == 'api/a')
        b = next(f for f in self.state['failures'] if f['check'] == 'ui/c')
        c.reexecute(self.state, a['id'])
        self.assertEqual(['api'], self.state['triage_repair_gates'])
        c.adjudicate(self.state, self.report(b, attribution='NOT_INTRODUCED', repair_agent='https://boxes.dev/thread/thr_b'))
        self.assertNotIn('triage_repair_gates', self.state)
        # path 2: triage completed by reexecute itself (last pending) -> tracking cleared
        other = copy.deepcopy(self.state); other.update(phase='initial', repair_gates=[])
        c.advance(other, [{**self.result(a='UNVERIFIED', b='PASS'), 'complete': False}])
        c.reexecute(other, other['failures'][-1]['id'])
        self.assertEqual('needs-focused-plan', other['phase']); self.assertNotIn('triage_repair_gates', other)
        # a later waiver-only triage is not routed by the earlier round: no repair, prior phase decides
        later = copy.deepcopy(self.state); later.update(phase='final', repair_gates=[])
        c.advance(later, [self.result('ui', c='FAIL')])
        c.adjudicate(later, self.report(later['failures'][-1], attribution='NOT_INTRODUCED',
                                        repair_agent='https://boxes.dev/thread/thr_later'))
        self.assertEqual(('ready', []), (later['phase'], later['repair_gates']))

    def assigned(self, failure, **changes):
        fields = {'attribution': 'NOT_INTRODUCED', 'assigned_repair': True,
                  'assigned_reason': 'root owns the assigned cloud image prerequisite; compatible image build in progress',
                  'assigned_evidence': '.context/deploy-cloud/95262bce/cli.log', **changes}
        return self.report(failure, **fields)

    def test_assigned_repair_routes_an_owned_not_introduced_failure_without_waiver(self):
        failure = self.failure()
        c.adjudicate(self.state, self.assigned(failure))
        self.assertEqual('needs-focused-plan', self.state['phase']); self.assertFalse(self.state['ready'])
        kept = next(f for f in self.state['failures'] if f['id'] == failure['id'])
        self.assertEqual(('blocking', 'NOT_INTRODUCED', 'FAIL'), (kept['disposition'], kept['rca']['attribution'], kept['native_result']))
        self.assertEqual(['api'], self.state['repair_gates']); self.assertEqual({}, self.state['skips'])
        c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {
            'api': {'command': self.plan['gates'][1]['command'], 'checks': ['a']}}})
        self.assertEqual(['api'], [g['name'] for g in c.records(self.plan, self.state)])

    def test_assigned_repair_refusals_leave_the_state_unchanged(self):
        failure = self.failure()
        before = copy.deepcopy(self.state)
        packet = {"test": "api::a", "command": ["true"], "scope": "api/a", "error": "boom",
                  "source": self.state["source"]["head"], "evidence": ["original.log"]}
        variants = {
            'missing reason': self.assigned(failure, assigned_reason=''),
            'missing evidence': self.assigned(failure, assigned_evidence=None),
            'with link': self.assigned(failure, repair_agent='https://boxes.dev/thread/thr_x'),
            'with provider': self.assigned(failure, external_provider={'name': 'p', 'reason': 'outage'}),
            'with post-merge': self.assigned(failure, post_merge=packet),
            'with execute': self.assigned(failure, execute_unverified=True),
            'unknown attribution': self.assigned(failure, attribution='UNKNOWN'),
            'introduced attribution': self.assigned(failure, attribution='INTRODUCED'),
            'non-boolean flag': self.assigned(failure, assigned_repair='yes'),
        }
        for label, report in variants.items():
            with self.subTest(variant=label):
                with self.assertRaises(ValueError):
                    c.adjudicate(self.state, report)
                self.assertEqual(before, self.state)
        self.assertEqual('triage', self.state['phase'])

    def test_quick_timeout_bound_is_120_seconds(self):
        with patch.object(c, 'run_command', return_value=(0, False, False, False)) as runner:
            c.execute(self.plan['gates'][0], self.state, self.directory, self.root)
            self.assertEqual(120, runner.call_args.kwargs['timeout'])

    def test_false_exit_zero_missing_protocol_is_not_a_pass(self):
        self.plan['gates'][1]['case_protocol'] = True
        result = c.execute(self.plan['gates'][1], self.state, self.directory, self.root)
        self.assertEqual('FAIL', result['status'])
        self.assertEqual({'a': 'UNVERIFIED', 'b': 'UNVERIFIED'}, result['cases'])

    def test_real_case_receipt_and_skip_omission(self):
        g=self.plan['gates'][1];g['case_protocol']=True
        self.state['skips']['api/a']={'source':self.state['source'], 'disposition':'external / waived'}
        g['command']=[sys.executable,'-c',
          "import os,json; q=json.load(open(os.environ['DEPLOY_GATE_REQUEST'])); "
          "assert q['checks']==['b']; assert 'a' in q['skips']; "
          "json.dump({**q,'complete':True,'cleanup_complete':True,'cases':{'b':'PASS'}},open(os.environ['DEPLOY_GATE_RESULT'],'w'))"]
        result=c.execute(g,self.state,self.directory,self.root)
        self.assertEqual('PASS',result['status'])
        self.assertEqual({'a':'SKIP','b':'PASS'},result['cases'])

    def test_parallel_workers_are_launched_before_any_completes(self):
        barrier=self.root/'.context'/'barrier';barrier.mkdir(parents=True)
        script="""import os,pathlib,time
p=pathlib.Path(os.environ['BARRIER']); (p/os.environ['WORKER']).touch()
end=time.monotonic()+2
while len(list(p.iterdir()))<2 and time.monotonic()<end: time.sleep(.01)
assert len(list(p.iterdir()))==2
"""
        for g in self.plan['gates'][1:3]:
            g.update(command=[sys.executable,'-c',script],
                     env={**g['env'], 'BARRIER':str(barrier),'WORKER':g['name']})
        self.state=c.initialize(self.plan,self.root);self.state['phase']='initial'
        c.run_phase(self.plan,self.state,self.directory,self.root)
        self.assertTrue(self.state['ready'])

    def test_unrelated_repair_retains_skip_without_rerunning_it(self):
        self.plan['gates'][1]['input_paths'] = ['code']
        self.state = c.initialize(self.plan, self.root)
        self.state['phase'] = 'initial'
        c.advance(self.state, [self.result(a='FAIL'), self.result('ui', c='FAIL')])
        report = {'failures': []}
        for f in self.state['failures']:
            if f['gate'] == 'api':
                e = self.report(f, 'NOT_INTRODUCED', external_provider={'name':'p','reason':'outage'})
            else:
                e = self.report(f)
            report['failures'].extend(e['failures'])
        c.adjudicate(self.state, report)
        (self.root/'unrelated').write_text('changed')
        new = {**self.plan, 'source': c.source(self.root)}
        c.refresh(self.state, self.plan, new, self.root)
        self.assertEqual(new['source'], self.state['skips']['api/a']['source'])
        self.assertNotIn('pending', self.state)

    def test_changed_skip_inputs_require_new_evidence_not_test_retry(self):
        f = self.failure()
        c.adjudicate(self.state, self.report(f, 'NOT_INTRODUCED',
                     external_provider={'name':'p','reason':'outage'}))
        self.state['phase'] = 'stale'
        (self.root/'code').write_text('changed')
        new = {**self.plan, 'source': c.source(self.root)}
        c.refresh(self.state, self.plan, new, self.root)
        self.assertEqual({}, self.state['skips'])
        c.advance(self.state, [self.result('static', lint='PASS')])
        self.assertEqual('triage', self.state['phase'])
        self.assertEqual('api/a', self.state['failures'][-1]['check'])

    def test_rca_dispatch_starts_while_other_gate_is_running(self):
        signal_file=self.root/'.context'/'rca-started'
        bad="import os,json,sys; q=json.load(open(os.environ['DEPLOY_GATE_REQUEST'])); json.dump({**q,'complete':True,'cleanup_complete':True,'cases':dict.fromkeys(q['checks'],'FAIL')},open(os.environ['DEPLOY_GATE_RESULT'],'w')); sys.exit(1)"
        wait="import pathlib,time; p=pathlib.Path(%r); e=time.monotonic()+3;\nwhile not p.exists() and time.monotonic()<e: time.sleep(.01)\nassert p.exists()" % str(signal_file)
        self.plan['gates'][1].update(command=[sys.executable,'-c',bad],case_protocol=True)
        self.plan['gates'][2]['command']=[sys.executable,'-c',wait]
        launcher=[sys.executable,'-c',"import pathlib,json; pathlib.Path(%r).touch(); print(json.dumps({'ok':True,'status':'delivered'}))" % str(signal_file)]
        self.state=c.initialize(self.plan,self.root);self.state['phase']='initial'
        c.run_phase(self.plan,self.state,self.directory,self.root,launcher)
        self.assertTrue(signal_file.exists())
        rows=self.state['attempts'][-1]['results']
        self.assertEqual('PASS',next(r['status'] for r in rows if r['gate']=='ui'))
        self.assertEqual(2,len(list((self.directory/'rca').glob('*.launch.json'))))

    def test_final_phase_rejects_pass_cache_configuration(self):
        self.plan['gates'][1]['command']=['run-deploy-stage','api','--reuse-passed']
        with self.assertRaises(ValueError): c.validate_plan(self.plan)

    def test_remote_transport_cannot_run_without_its_original_deadline(self):
        self.plan['gates'][1]['result_transport']='stdout'
        with self.assertRaisesRegex(ValueError,'existing gate deadline'):
            c.validate_plan(self.plan)

    def test_plan_removal_at_repair_boundary_is_refused(self):
        self.failure();self.state['phase']='stale'
        (self.root/'code').write_text('fixed')
        new={**self.plan,'source':c.source(self.root),'gates':self.plan['gates'][:2]}
        with self.assertRaises(ValueError): c.refresh(self.state,self.plan,new,self.root)

    def test_forged_old_plan_cannot_shrink_final_selection(self):
        f=self.failure();c.adjudicate(self.state,self.report(f))
        (self.root/'code').write_text('fixed')
        forged={**self.plan,'gates':self.plan['gates'][:2]}
        new={**forged,'source':c.source(self.root)}
        with self.assertRaisesRegex(ValueError,'previous plan'):
            c.refresh(self.state,forged,new,self.root)

    def test_repair_cannot_swap_full_gate_command_for_a_green_command(self):
        f=self.failure();c.adjudicate(self.state,self.report(f))
        new=__import__('copy').deepcopy(self.plan)
        new['gates'][1]['command']=['echo','not the original tests']
        with self.assertRaisesRegex(ValueError,'full gate command'):
            c.refresh(self.state,self.plan,new,self.root)

    def test_repair_cannot_swap_the_worker_case_recipe(self):
        self.plan['gates'][1]['worker_recipe']={'cases':{'a':{'command':['true']},'b':{'command':['false']}}}
        self.plan['gates'][1]['case_protocol']=True
        self.state=c.initialize(self.plan,self.root)
        f=self.failure();c.adjudicate(self.state,self.report(f))
        new=__import__('copy').deepcopy(self.plan)
        new['gates'][1]['worker_recipe']['cases']['b']['command']=['true']
        with self.assertRaisesRegex(ValueError,'original case command'):
            c.refresh(self.state,self.plan,new,self.root)

    def test_worker_exit_zero_with_failed_case_blocks(self):
        g=self.plan['gates'][1];g['case_protocol']=True
        g['command']=[sys.executable,'-c',"import os,json; q=json.load(open(os.environ['DEPLOY_GATE_REQUEST'])); json.dump({**q,'complete':True,'cleanup_complete':True,'cases':dict.fromkeys(q['checks'],'FAIL')},open(os.environ['DEPLOY_GATE_RESULT'],'w'))"]
        result=c.execute(g,self.state,self.directory,self.root)
        self.assertFalse(result['complete'])
        self.assertEqual('FAIL',result['status'])

    def test_parallel_rca_plan_keeps_unknown_peer_blocking(self):
        self.state['phase']='initial'
        c.advance(self.state,[self.result(a='FAIL'),self.result('ui',c='FAIL')])
        a,b=self.state['failures'];report={'failures':[self.report(a)['failures'][0],self.report(b,'UNKNOWN')['failures'][0]]}
        with self.assertRaises(ValueError): c.adjudicate(self.state,report)
        self.assertEqual(2,len(self.state['pending']))
        self.assertNotIn('disposition',self.state['failures'][0])

    def test_environment_change_invalidates_run(self):
        with patch.dict(os.environ,{'TEST_NEW_AUTH_CONTEXT':'different'}):
            with self.assertRaises(ValueError): c.run_phase(self.plan,self.state,self.directory,self.root)

    def test_benchmark_output_ledger_does_not_invalidate_source(self):
        history=self.root/'agents/benchmarks/history';history.mkdir(parents=True)
        (history/'task_attempts.jsonl').write_text('{"new":"result"}\n')
        self.assertEqual(self.state['source'],c.source(self.root))
        c.run_phase(self.plan,self.state,self.directory,self.root)
        c.run_phase(self.plan,self.state,self.directory,self.root)
        self.assertTrue(self.state['ready'])

    def test_ignored_config_change_invalidates_running_and_saved_results(self):
        with (self.root/'.git/info/exclude').open('a') as stream: stream.write('.env\n')
        (self.root/'.env').write_text('TOKEN=first')
        self.state=c.initialize(self.plan,self.root)
        c.run_phase(self.plan,self.state,self.directory,self.root)
        c.run_phase(self.plan,self.state,self.directory,self.root)
        self.assertEqual(0,c.verify_saved(self.directory,self.root))
        (self.root/'.env').write_text('TOKEN=second')
        self.assertEqual(5,c.verify_saved(self.directory,self.root))
        with self.assertRaises(ValueError): c.run_phase(self.plan,self.state,self.directory,self.root)

    def test_saved_verify_rejects_tampered_plan_and_wrong_head(self):
        c.run_phase(self.plan,self.state,self.directory,self.root)
        c.run_phase(self.plan,self.state,self.directory,self.root)
        self.assertEqual(5,c.verify_saved(self.directory,self.root,'different-head'))
        saved=c.read(self.directory/'cycle.json');saved['plan']['gates'].pop()
        c.write(self.directory/'cycle.json',saved)
        self.assertEqual(5,c.verify_saved(self.directory,self.root))

    def test_ignored_frontend_env_invalidates_ready_receipt(self):
        with (self.root/'.git/info/exclude').open('a') as stream:
            stream.write('front-end/.env\n')
        config=self.root/'front-end/.env';config.parent.mkdir();config.write_text('VITE_ORIGIN=first')
        for gate in self.plan['gates']:
            gate['input_paths']=['code']
        state=c.initialize(self.plan,self.root)
        c.run_phase(self.plan,state,self.directory,self.root)
        c.run_phase(self.plan,state,self.directory,self.root)
        self.assertEqual(0,c.verify_saved(self.directory,self.root))
        config.write_text('VITE_ORIGIN=second')
        self.assertEqual(5,c.verify_saved(self.directory,self.root))

    def test_ignored_benchmark_temporal_env_invalidates_ready_receipt(self):
        with (self.root/'.git/info/exclude').open('a') as stream:
            stream.write('agents/.env.benchmark-temporal\n')
        config = self.root/'agents/.env.benchmark-temporal'
        config.parent.mkdir()
        config.write_text('CLOUDBENCH_GUEST_TEMPORAL_API_KEY=fixture-first\n')
        config.chmod(0o600)
        for gate in self.plan['gates']:
            gate['input_paths'] = ['code']
        state = c.initialize(self.plan, self.root)
        c.run_phase(self.plan, state, self.directory, self.root)
        c.run_phase(self.plan, state, self.directory, self.root)
        self.assertEqual(0, c.verify_saved(self.directory, self.root))
        original_source = c.source(self.root)
        config.write_text('CLOUDBENCH_GUEST_TEMPORAL_API_KEY=fixture-second\n')
        self.assertEqual(original_source, c.source(self.root))
        self.assertEqual(5, c.verify_saved(self.directory, self.root))
        config.unlink()
        self.assertEqual(5, c.verify_saved(self.directory, self.root))

    def test_cli_runs_real_commands_and_refuses_reinitialization(self):
        plan_path=self.root/'.context/plan.json';c.write(plan_path,self.plan)
        args=['--plan',str(plan_path),'--state-dir',str(self.directory),'--root',str(self.root)]
        self.assertEqual(0,c.main(['init',*args]))
        self.assertEqual(2,c.main(['init',*args]))
        self.assertEqual(0,c.main(['run',*args]))
        self.assertEqual(0,c.main(['verify',*args]))
        self.assertEqual(['quick','initial'],[a['phase'] for a in c.read(self.directory/'cycle.json')['attempts']])

    def test_existing_pipeline_verifies_exact_staged_evidence(self):
        import run_deploy_pipeline as pipeline
        c.run_phase(self.plan,self.state,self.directory,self.root)
        with patch.object(pipeline,'SOURCE_ROOT',self.root):
            self.assertNotEqual(0,pipeline.verify(self.directory))
            c.run_phase(self.plan,self.state,self.directory,self.root)
            self.assertEqual(0,pipeline.verify(self.directory,self.state['source']['head']))
            (self.root/'code').write_text('later source')
            self.assertEqual(5,pipeline.verify(self.directory))

    def test_required_staged_mode_refuses_a_legacy_green_receipt(self):
        import run_deploy_pipeline as pipeline
        c.write(self.directory/'receipt.json',{'status':'passed','source':self.state['source']})
        with patch.object(pipeline,'SOURCE_ROOT',self.root):
            self.assertEqual(2,pipeline.verify(self.directory,require_staged=True))

    def test_timeout_is_not_convertible_to_completed_case_skip(self):
        g=self.plan['gates'][1]
        g.update(command=[sys.executable,'-c','import time; time.sleep(3)'],timeout_seconds=.03)
        result=c.execute(g,self.state,self.directory,self.root)
        self.assertTrue(result['timed_out'])
        self.assertFalse(result['complete'])
        self.assertFalse(result['lingering_group'])

    def test_refresh_cannot_rebind_unknown_occurrences_to_a_new_source(self):
        f=self.failure()
        (self.root/'code').write_text('edit before triage')
        new={**self.plan,'source':c.source(self.root)}
        with self.assertRaises(ValueError): c.refresh(self.state,self.plan,new,self.root)
        self.assertEqual('triage',self.state['phase'])
        self.assertEqual([f['id']],self.state['pending'])

    def test_cancellation_is_interrupted_not_a_failed_gate_or_ready(self):
        timer=threading.Timer(.04,c.CANCEL.set)
        self.plan['gates'][0]['command']=[sys.executable,'-c','import time; time.sleep(3)']
        self.state=c.initialize(self.plan,self.root)
        timer.start()
        try: c.run_phase(self.plan,self.state,self.directory,self.root)
        finally: timer.join()
        self.assertEqual('interrupted',self.state['phase'])
        self.assertFalse(self.state['ready'])
        result=next(r for r in self.state['attempts'][-1]['results'] if r['gate']=='static')
        self.assertTrue(result['cancelled'])
        self.assertNotEqual(0,result['native_exit'])


    def test_ambiguous_rca_submit_is_not_automatically_repeated(self):
        f=self.failure();paths=c.rca_requests(self.state,self.directory)
        count=self.root/'.context'/'submitted'
        launcher=[sys.executable,'-c',"import pathlib,sys; p=pathlib.Path(%r); p.write_text(p.read_text()+'x' if p.exists() else 'x'); sys.exit(1)" % str(count)]
        with self.assertRaises(subprocess.CalledProcessError): c.launch_rca(paths[0],launcher)
        with self.assertRaisesRegex(ValueError,'may have succeeded'): c.launch_rca(paths[0],launcher)
        self.assertEqual('x',count.read_text())

    def test_quick_failure_cannot_drop_pending_skip_revalidation(self):
        f=self.failure();c.adjudicate(self.state,self.report(f,'NOT_INTRODUCED',
            external_provider={'name':'p','reason':'outage'}));self.state['phase']='stale'
        (self.root/'code').write_text('changed');new={**self.plan,'source':c.source(self.root)}
        c.refresh(self.state,self.plan,new,self.root)
        c.advance(self.state,[self.result('static',lint='FAIL')])
        self.assertEqual(2,len(self.state['pending']))


if __name__ == '__main__': unittest.main()
