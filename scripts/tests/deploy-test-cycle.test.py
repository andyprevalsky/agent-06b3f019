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

    def test_failed_gate_boundary_refresh_keeps_history_and_revalidates_new_source(self):
        import contextlib, io
        failure = self.failure()
        c.adjudicate(self.state, self.report(failure))
        c.focused_plan(self.state, self.plan, {'source': self.state['source'],
            'gates': {'api': {'command': ['true'], 'checks': ['a']}}})
        c.advance(self.state, [self.result(a='PASS')])
        self.assertEqual('failed-gates', self.state['phase'])
        history = copy.deepcopy({k: self.state[k] for k in ('attempts', 'failures', 'repair_gates', 'round')})
        old_source = self.state['source']
        (self.root / 'code').write_text('hourly sync changed source')
        new = copy.deepcopy(self.plan); new['source'] = c.source(self.root)
        old_path, new_path = self.root / '.context/old.json', self.root / '.context/new.json'
        c.write(old_path, self.plan); c.write(new_path, new)
        state_path = self.directory / 'cycle.json'; c.write(state_path, self.state)
        saved = state_path.read_bytes()
        argv = ['refresh', '--plan', str(new_path), '--input', str(old_path),
                '--state-dir', str(self.directory), '--root', str(self.root)]
        # A live coordinator's existing exclusive lease still forbids any refresh mutation.
        with c.exclusive(self.directory), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(2, c.main(argv))
        self.assertEqual(saved, state_path.read_bytes())
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(0, c.main(argv))
        self.state = c.read(state_path)
        self.assertEqual(('quick', False, 'needs-focused-plan'),
                         (self.state['phase'], self.state['ready'], self.state['next_after_quick']))
        self.assertEqual({}, self.state['focused'])
        self.assertEqual(new['source'], self.state['source'])
        self.assertNotEqual(old_source, self.state['source'])
        self.assertEqual(history, {k: self.state[k] for k in history})
        self.assertEqual(self.plan['gates'], self.state['plan']['gates'])
        self.assertEqual(1, c.verify_saved(self.directory, self.root))
        c.run_phase(new, self.state, self.directory, self.root)
        self.assertEqual('needs-focused-plan', self.state['phase'])
        c.focused_plan(self.state, new, {'source': self.state['source'],
            'gates': {'api': {'command': ['true'], 'checks': ['a']}}})
        for phase in ('focused', 'failed-gates', 'quick', 'final'):
            self.assertEqual(phase, self.state['phase'])
            if phase == 'failed-gates':
                self.assertEqual(['a', 'b'], c.records(new, self.state)[0]['checks'])
            c.run_phase(new, self.state, self.directory, self.root)
        self.assertEqual(('ready', True), (self.state['phase'], self.state['ready']))
        self.assertEqual({'api', 'ui'}, {r['gate'] for r in self.state['attempts'][-1]['results']})
        self.assertEqual(history['failures'], self.state['failures'])
        self.assertEqual('FAIL', self.state['failures'][0]['native_result'])
        self.assertEqual('blocking', self.state['failures'][0]['disposition'])
        for attempt in self.state['attempts'][len(history['attempts']):]:
            self.assertTrue(all(r['source'] == new['source'] for r in attempt['results']))

    def test_failed_gate_boundary_refresh_preserves_existing_refusals_atomically(self):
        self.state.update(phase='failed-gates', repair_gates=['api'])
        (self.root / 'code').write_text('hourly sync changed source')
        new = copy.deepcopy(self.plan); new['source'] = c.source(self.root)
        for invalid in ('pending', 'dropped-check', 'dropped-gate'):
            with self.subTest(invalid=invalid):
                state, plan = copy.deepcopy(self.state), copy.deepcopy(new)
                if invalid == 'pending': state['pending'] = ['unadjudicated-occurrence']
                elif invalid == 'dropped-check': plan['gates'][1]['checks'] = ['b']
                else: plan['gates'] = [g for g in plan['gates'] if g['name'] != 'api']
                original = copy.deepcopy(state)
                with self.assertRaises(ValueError): c.refresh(state, self.plan, plan, self.root)
                self.assertEqual(original, state)

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

    def test_assigned_repair_routes_a_diagnosed_unknown_failure_without_relabel(self):
        failure = self.failure()
        c.adjudicate(self.state, self.assigned(failure, attribution='UNKNOWN'))
        self.assertEqual('needs-focused-plan', self.state['phase']); self.assertFalse(self.state['ready'])
        kept = next(f for f in self.state['failures'] if f['id'] == failure['id'])
        self.assertEqual(('blocking', 'UNKNOWN', 'FAIL'), (kept['disposition'], kept['rca']['attribution'], kept['native_result']))
        self.assertEqual(['api'], self.state['repair_gates']); self.assertEqual({}, self.state['skips'])
        c.focused_plan(self.state, self.plan, {'source': self.state['source'], 'gates': {
            'api': {'command': self.plan['gates'][1]['command'], 'checks': ['a']}}})
        self.assertEqual(['api'], [g['name'] for g in c.records(self.plan, self.state)])

    def skipped_row(self, sha='c' * 64, reason='Compute token pool exhausted or cooling down', status='SKIPPED', passed=False):
        return {'native_task': {'name': 'a', 'status': status, 'benchmark_status': status, 'passed': passed,
                                'failure_reason': reason, 'agent_id': 'agent-1'}, 'path': 'native/a/cloudbench-run.json', 'sha256': sha}

    def resource_failure(self, **row):
        self.state['phase'] = 'initial'
        skipped = {**self.result(a='FAIL', b='PASS'), 'finished_at': 1000.0,
                   'worker_evidence': {'a': self.skipped_row(**row)}}
        c.advance(self.state, [skipped, self.result('ui', c='PASS')])
        return next(f for f in self.state['failures'] if f['check'] == 'api/a')

    def confirmation(self, **changes):
        proof = {'receipt_sha256': 'c' * 64, 'receipt_reason': 'Compute token pool exhausted or cooling down',
                 'resource_scope': 'third_party', 'reason_code': 'compute_quota_exhausted', 'exclusive_cause': True,
                 'provider': 'openai-compute-tokens', 'evidence': 'native/a/cloudbench-run.json#failure_reason',
                 'confirmed_at': 1001.0}
        proof.update(changes)
        return proof

    def test_confirmed_compute_token_skip_is_a_warning_not_a_pass(self):
        failure = self.resource_failure()
        c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=self.confirmation()))
        self.assertEqual('ready', self.state['phase']); self.assertTrue(self.state['ready'])
        kept = next(f for f in self.state['failures'] if f['id'] == failure['id'])
        self.assertEqual(('SKIPPED_WITH_WARNING', 'FAIL', 'SKIPPED'),
                         (kept['disposition'], kept['native_result'], kept['worker_evidence']['native_task']['benchmark_status']))
        self.assertEqual({}, self.state['skips'])  # no pass credit
        warning = self.state['resource_warnings'][0]
        self.assertEqual((failure['id'], 'api/a', 'c' * 64, self.state['source']), (warning['id'], warning['check'], warning['receipt_sha256'], warning['source']))
        plan = self.directory / 'plan.json'; c.write(plan, self.plan); c.write(self.directory / 'cycle.json', self.state)
        self.assertEqual(0, c.verify_saved(self.directory, self.root))
        import contextlib, io
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(0, c.main(['report', '--plan', str(plan), '--state-dir', str(self.directory), '--root', str(self.root)]))
        text = (self.directory / 'report.md').read_text()
        self.assertIn('Resource warnings: 1', text); self.assertIn('RESOURCE WARNINGS', text)
        self.assertIn('- api/a — openai-compute-tokens: Compute token pool exhausted or cooling down [compute_quota_exhausted]'
                      ' · Evidence: native/a/cloudbench-run.json#failure_reason · Confirmed at: 1001.0 · Receipt: ' + 'c' * 64, text)
        self.assertNotIn('PASS', text.split('RESOURCE WARNINGS', 1)[1])

    def test_resource_skip_refusals_are_atomic(self):
        failure = self.resource_failure()
        before = copy.deepcopy(self.state)
        good = self.confirmation()
        variants = {
            'mismatched sha': self.confirmation(receipt_sha256='d' * 64),
            'mismatched reason': self.confirmation(receipt_reason='Compute token pool exhausted'),
            'missing provider': self.confirmation(provider=''),
            'missing confirmed_at': {k: v for k, v in good.items() if k != 'confirmed_at'},
            'early confirmation': self.confirmation(confirmed_at=999.0),
            'wrong reason_code': self.confirmation(reason_code='billing_credit_exhausted'),
            'not exclusive': self.confirmation(exclusive_cause=False),
        }
        for label, proof in variants.items():
            with self.subTest(variant=label):
                with self.assertRaises(ValueError):
                    c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=proof))
                self.assertEqual(before, self.state)
        for label, extra in (('with link', {'repair_agent': 'https://boxes.dev/thread/thr_x'}),
                             ('with provider waiver', {'external_provider': {'name': 'p', 'reason': 'credits exhausted'}}),
                             ('with assigned_repair', {'assigned_repair': True, 'assigned_reason': 'r', 'assigned_evidence': 'e'}),
                             ('with execute', {'execute_unverified': True}),
                             ('with post-merge', {'post_merge': {'test': 't', 'command': ['x'], 'scope': 's', 'error': 'e', 'source': 's', 'evidence': ['v']}})):
            with self.subTest(variant=label):
                with self.assertRaises(ValueError):
                    c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=good, **extra))
                self.assertEqual(before, self.state)
        # an actual assertion FAIL (native FAILED row) or an unverified occurrence can never be qualified
        for row in ({'status': 'FAILED', 'reason': 'AssertionError: boom'}, {'passed': True, 'status': 'PASSED'}):
            with self.subTest(row=row):
                other = copy.deepcopy(before)
                other['failures'][0]['worker_evidence'] = {'a': self.skipped_row(**row)} if row.get('status') != 'PASSED' else {'a': self.skipped_row(**row)}
                failing = other['failures'][0]
                proof = self.confirmation(receipt_reason=failing['worker_evidence']['a']['native_task']['failure_reason'])
                with self.assertRaises(ValueError):
                    c.adjudicate(other, self.report(failing, attribution='NOT_INTRODUCED', resource_skip=proof))
        unverified = copy.deepcopy(before); unverified['failures'][0].update(native_result='UNVERIFIED', complete=False)
        with self.assertRaises(ValueError):
            c.adjudicate(unverified, self.report(unverified['failures'][0], attribution='NOT_INTRODUCED', resource_skip=good))

    def test_mixed_batch_with_a_real_failure_still_blocks(self):
        self.state['phase'] = 'initial'
        skipped = {**self.result(a='FAIL', b='PASS'), 'finished_at': 1000.0, 'worker_evidence': {'a': self.skipped_row()}}
        c.advance(self.state, [skipped, self.result('ui', c='FAIL')])
        skip_f = next(f for f in self.state['failures'] if f['check'] == 'api/a')
        real_f = next(f for f in self.state['failures'] if f['check'] == 'ui/c')
        report = {'failures': [*self.report(skip_f, attribution='NOT_INTRODUCED', resource_skip=self.confirmation())['failures'],
                               *self.report(real_f, attribution='INTRODUCED')['failures']]}
        c.adjudicate(self.state, report)
        self.assertEqual('needs-focused-plan', self.state['phase']); self.assertFalse(self.state['ready'])
        self.assertEqual(['ui'], self.state['repair_gates']); self.assertEqual(1, len(self.state['resource_warnings']))

    def test_resource_warning_needs_renewed_confirmation_after_changed_inputs(self):
        failure = self.resource_failure()
        c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=self.confirmation()))
        self.state['phase'] = 'stale'
        (self.root / 'code').write_text('changed inputs')
        new = {**self.plan, 'source': c.source(self.root)}
        c.refresh(self.state, self.plan, new, self.root)
        self.assertEqual([], self.state['resource_warnings'])
        superseded = self.state['superseded_resource_warnings'][0]
        self.assertEqual((failure['id'], 'c' * 64, failure['source']), (superseded['id'], superseded['receipt_sha256'], superseded['source']))
        self.assertFalse(any(f['native_result'].startswith('prior') for f in self.state['failures']))
        kept = next(f for f in self.state['failures'] if f['id'] == failure['id'])
        self.assertEqual(('FAIL', 'SKIPPED'), (kept['native_result'], kept['worker_evidence']['native_task']['benchmark_status']))

    def smoke_plan(self):
        plan = copy.deepcopy(self.plan)
        plan['gates'].append({'name': 'smoke', 'worker': 'smoke-worker', 'checks': ['mass', 'mail'], 'case_protocol': True, 'input_paths': ['code'],
                              'command': ['true'], 'worker_transport': 'local-isolated', 'cwd': str(Path(self.workers.name) / 'smoke'),
                              'env': {'CONDUCTOR_WORKSPACE_NAME': 'smoke', 'CONDUCTOR_PORT': '36000'}})
        (Path(self.workers.name) / 'smoke').mkdir(exist_ok=True)
        return plan

    def qualified_smoke_state(self, plan):
        state = c.initialize(plan, self.root); state['phase'] = 'initial'
        skipped = {**self.result('smoke', mass='FAIL', mail='FAIL'), 'finished_at': 1000.0,
                   'worker_evidence': {'mass': self.skipped_row()}}
        c.advance(state, [skipped])
        mass = next(f for f in state['failures'] if f['check'] == 'smoke/mass')
        mail = next(f for f in state['failures'] if f['check'] == 'smoke/mail')
        report = {'failures': [*self.report(mass, attribution='NOT_INTRODUCED', resource_skip=self.confirmation())['failures'],
                               *self.report(mail, attribution='INTRODUCED')['failures']]}
        c.adjudicate(state, report)
        self.assertEqual(('needs-focused-plan', ['smoke']), (state['phase'], state['repair_gates']))
        return state

    def test_qualified_resource_skip_is_excluded_from_the_next_request_but_kept_in_the_record(self):
        plan = self.smoke_plan(); state = self.qualified_smoke_state(plan)
        gate = next(g for g in plan['gates'] if g['name'] == 'smoke')
        state['phase'] = 'failed-gates'  # the full rerun of the repaired gate
        with patch.object(c, 'run_command', return_value=(0, False, False, False)) as runner:
            result = c.execute(gate, state, self.directory, self.root)
        request = c.read(Path(runner.call_args.kwargs['env']['DEPLOY_GATE_REQUEST']))
        self.assertEqual(['mail'], request['checks'])  # no mass invocation
        self.assertEqual('SKIPPED_WITH_WARNING', request['skips']['mass']['disposition'])
        self.assertEqual('c' * 64, request['skips']['mass']['receipt_sha256'])
        self.assertEqual('SKIP', result['cases']['mass']); self.assertIn('mail', result['cases'])
        self.assertEqual('c' * 64, result['resource_skips']['mass']['receipt_sha256'])
        mass = next(f for f in state['failures'] if f['check'] == 'smoke/mass')
        self.assertEqual(('FAIL', 'SKIPPED'), (mass['native_result'], mass['worker_evidence']['native_task']['benchmark_status']))
        # same inputs on a new head: the warning rebinds its active source, keeps the native one, and still excludes
        original_source = state['source']
        state['phase'] = 'stale'; (self.root / 'other').write_text('unrelated')
        same = {**plan, 'source': c.source(self.root)}
        c.refresh(state, plan, same, self.root)
        warning = state['resource_warnings'][0]
        self.assertEqual((same['source'], original_source), (warning['source'], warning['original_source']))
        self.assertNotEqual(same['source'], original_source)
        state.update(phase='failed-gates', round=state['round'] + 1)
        with patch.object(c, 'run_command', return_value=(0, False, False, False)) as runner:
            c.execute(gate, state, self.directory, self.root)
        self.assertEqual(['mail'], c.read(Path(runner.call_args.kwargs['env']['DEPLOY_GATE_REQUEST']))['checks'])
        # a changed input fingerprint removes the warning: mass is requested again until re-confirmed
        state['phase'] = 'stale'; (self.root / 'code').write_text('changed inputs')
        new = {**same, 'source': c.source(self.root)}
        c.refresh(state, same, new, self.root)
        self.assertEqual([], state['resource_warnings'])
        self.assertEqual(original_source, state['superseded_resource_warnings'][0]['original_source'])
        state.update(phase='failed-gates', round=state['round'] + 1)
        with patch.object(c, 'run_command', return_value=(0, False, False, False)) as runner:
            c.execute(gate, state, self.directory, self.root)
        self.assertEqual(['mass', 'mail'], c.read(Path(runner.call_args.kwargs['env']['DEPLOY_GATE_REQUEST']))['checks'])

    def test_missing_finished_at_falls_back_only_to_a_matching_sidecar_receipt(self):
        failure = self.resource_failure()
        del failure['finished_at']  # an occurrence recorded before finished_at existed
        folder = self.directory / 'attempts/9/focused/api'; folder.mkdir(parents=True)
        failure['worker_result'] = str(folder / 'result.json')
        sidecar = {'gate': 'api', 'status': 'FAIL', 'cases': {'a': 'FAIL', 'b': 'PASS'}, 'executed': True, 'complete': True,
                   'case_complete': {'a': True, 'b': True}, 'source': self.state['source'], 'finished_at': 1793667148.9725}
        before = copy.deepcopy(self.state)
        with self.assertRaises(ValueError):  # no sidecar -> refused
            c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=self.confirmation(confirmed_at=1793667149.0)))
        self.assertEqual(before, self.state)
        for label, bad in (('source', {'source': {'head': 'x' * 40, 'digest': 'y' * 64}}), ('gate', {'gate': 'ui'}),
                           ('case', {'cases': {'z': 'FAIL'}, 'case_complete': {'z': True}}), ('result', {'cases': {'a': 'PASS', 'b': 'PASS'}})):
            with self.subTest(mismatch=label):
                c.write(folder / 'receipt.json', {**sidecar, **bad})
                with self.assertRaises(ValueError):
                    c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=self.confirmation(confirmed_at=1793667149.0)))
                self.assertEqual(before, self.state)
        c.write(folder / 'receipt.json', sidecar)
        with self.assertRaises(ValueError):  # the real terminal timestamp is the bound: an earlier confirmation is refused
            c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=self.confirmation(confirmed_at=1001.0)))
        c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=self.confirmation(confirmed_at=1793667149.0)))
        self.assertEqual('SKIPPED_WITH_WARNING', next(f for f in self.state['failures'] if f['id'] == failure['id'])['disposition'])
        self.assertNotIn('finished_at', next(f for f in self.state['failures'] if f['id'] == failure['id']))  # record not backfilled

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
            'unknown missing reason': self.assigned(failure, attribution='UNKNOWN', assigned_reason=''),
            'unknown missing evidence': self.assigned(failure, attribution='UNKNOWN', assigned_evidence=None),
            'unknown with link': self.assigned(failure, attribution='UNKNOWN', repair_agent='https://boxes.dev/thread/thr_x'),
            'unknown with provider': self.assigned(failure, attribution='UNKNOWN', external_provider={'name': 'p', 'reason': 'outage'}),
            'unknown with post-merge': self.assigned(failure, attribution='UNKNOWN', post_merge=packet),
            'unknown with execute': self.assigned(failure, attribution='UNKNOWN', execute_unverified=True),
            'introduced attribution': self.assigned(failure, attribution='INTRODUCED'),
            'non-boolean flag': self.assigned(failure, assigned_repair='yes'),
        }
        for label, report in variants.items():
            with self.subTest(variant=label):
                with self.assertRaises(ValueError):
                    c.adjudicate(self.state, report)
                self.assertEqual(before, self.state)
        self.assertEqual('triage', self.state['phase'])

    def test_retained_remote_owner_blocks_reexecute_and_any_relaunch_of_that_gate(self):
        # CodeRabbit 4450239861: an owned/timeout receipt must not be relaunched via triage -> reexecute -> focus -> run.
        self.state['phase'] = 'initial'
        owner = {'request_token': 'tok-prev', 'worker_cleanup_owner': {'worker_thread': 'ph-worker', 'worker_root': '/prepared/root',
                 'turn_id': 'turn-7', 'pgid': 4242}}
        owned = {**self.result(a='UNVERIFIED', b='PASS'), 'complete': False, 'case_complete': {'a': False, 'b': True},
                 'lingering_group': True, 'cleanup_owner': owner, 'reason': 'worker reported a retained remote cleanup owner'}
        c.advance(self.state, [owned, self.result('ui', c='PASS')])
        occurrence = self.state['failures'][-1]
        self.assertEqual(('triage', 'UNVERIFIED', False), (self.state['phase'], occurrence['native_result'], occurrence['complete']))
        with self.assertRaisesRegex(ValueError, 'cleanup owner|reconcil'):
            c.reexecute(self.state, occurrence['id'])
        self.assertEqual('triage', self.state['phase'])
        # even if the state is driven to a focused run of that gate, launch is refused before any dispatch
        forced = copy.deepcopy(self.state)
        forced.update(phase='focused', repair_gates=['api'], focused={'api': {'command': ['true'], 'checks': ['a']}})
        forced.pop('pending', None)
        with patch.object(c, 'execute') as launcher, self.assertRaisesRegex(ValueError, 'api'):
            c.run_phase(self.plan, forced, self.directory, self.root)
        launcher.assert_not_called()
        self.assertEqual(0, forced['round'])
        # a gate whose latest receipt is clean still launches (ui) once the owned gate is not selected
        clean = copy.deepcopy(self.state)
        clean.update(phase='focused', repair_gates=['ui'], focused={'ui': {'command': ['true'], 'checks': ['c']}})
        clean.pop('pending', None)
        with patch.object(c, 'execute', return_value={**self.result('ui', c='PASS'), 'gate': 'ui'}) as launcher:
            c.run_phase(self.plan, clean, self.directory, self.root)
        launcher.assert_called_once()

    def recon_state(self):
        """Self-contained synthetic producer shapes (coordinator receipt, boxes-thread adapter result with
        transport_receipt + cleanup_owner, same-turn platform result, native audit, process sidecar, audit
        record) with fake identities; every hash and marker is computed from the bytes written here."""
        import hashlib
        gate_name, token = 'cloudbench-controller', 'f' * 32
        source = {'head': 'a' * 40, 'digest': 'b' * 64}
        owner = {'worker_thread': 'ph-fake-worker', 'worker_host': 'fake-devbox-uuid', 'worker_root': '/fake/worker/root',
                 'request_token': token, 'message_id': 'fake-message-id', 'turn_id': 'fake-turn-id',
                 'remote_dir': f'/fake/worker/root/.context/deploy-boxes/{token}', 'pgid': None}
        folder = self.directory / 'attempts/0/initial' / gate_name; folder.mkdir(parents=True, exist_ok=True)
        paths = {k: folder / n for k, n in (('receipt', 'receipt.json'), ('adapter', 'result.json'), ('platform', 'platform.json'),
                                             ('audit', 'native-audit.json'), ('process', 'process.json'), ('record', 'audit-record.json'))}
        audit = {'token': token, 'source': source, 'gate': gate_name, 'cases': {gate_name: 'PASS'}, 'complete': True, 'reused': False,
                 'evidence': {gate_name: {'status': 'PASS', 'native_exit': 0, 'command': ['bash', 'scripts/run-cloudbench-controller-gate'],
                                          'started_at': 1793664491.1, 'finished_at': 1793665704.5, 'timed_out': False, 'cancelled': False,
                                          'lingering_group': False, 'log': '/fake/worker/root/.context/x.log', 'sha256': 'e' * 64, 'tail': 'ok'}},
                 'recipe_digest': 'd' * 64, 'cleanup_complete': True, 'worker_root': owner['worker_root']}
        audit_text = json.dumps(audit, indent=2) + '\n'; paths['audit'].write_text(audit_text)
        audit_sha = hashlib.sha256(audit_text.encode()).hexdigest()
        platform = {'schemaVersion': 1, 'ok': True, 'data': {'completedAt': 1793665720934, 'executionInstanceId': owner['worker_host'],
                    'failure': None, 'output': {'text': 'DEPLOY_GATE_WORKER_PGID 1\nDEPLOY_GATE_WORKER_EXIT 0\n'
                    f'DEPLOY_GATE_RESULT_SHA256 {audit_sha}\nDEPLOY_GATE_RESULT_JSON_BEGIN\n{audit_text}DEPLOY_GATE_RESULT_JSON_END\n'},
                    'status': 'completed', 'turnId': owner['turn_id']}}
        c.write(paths['platform'], platform)
        c.write(paths['process'], {'supervisor_pid': 1, 'child_pid': 2, 'native_exit': 0, 'cancelled': False, 'timed_out': False,
                                   'quiescent': True, 'orphaned_children': False, 'reaped': [{'pid': 2, 'status': 0}], 'term_sent': [],
                                   'kill_sent': [], 'remaining': [], 'error': None})
        c.write(paths['adapter'], {'token': token, 'source': source, 'gate': gate_name, 'cases': {gate_name: 'UNVERIFIED'}, 'complete': False,
                                   'cleanup_complete': False, 'reused': False, 'evidence': {}, 'reason': 'threads wait exited 2', 'worker_stderr': '',
                                   'transport_receipt': {'transport': 'boxes-thread', **{k: owner[k] for k in ('worker_thread', 'worker_host', 'worker_root')},
                                                         'request_token': token, 'idempotency_key': token, 'message_id': owner['message_id'],
                                                         'turn_id': owner['turn_id'], 'native_sha256': None}, 'cleanup_owner': dict(owner)})
        receipt = {'gate': gate_name, 'status': 'FAIL', 'cases': {gate_name: 'UNVERIFIED'}, 'native_exit': 1, 'executed': True, 'complete': False,
                   'reason': 'worker result identity/inventory mismatch', 'timed_out': False, 'case_complete': {gate_name: False}, 'cancelled': False,
                   'lingering_group': False, 'source': source, 'started_at': 1793664471.6, 'finished_at': 1793664913.25,
                   'command': ['bash', 'scripts/run-cloudbench-controller-gate'], 'log': str(folder / 'output.log'),
                   'stderr_log': str(folder / 'stderr.log'), 'token': token, 'lifecycle': 'owned', 'native_cleanup_reference': None,
                   'worker_evidence': {}, 'worker_result': str(paths['adapter'])}
        c.write(paths['receipt'], receipt)  # the producer writes the exact recorded receipt to disk
        c.write(paths['record'], {'observed_at': 1793667622.4, 'original_outer_result': 'UNVERIFIED', 'original_complete': False,
                                  'credit_granted': False, 'files': {'native-audit.json': {'sha256': audit_sha}}})
        gate = {'name': gate_name, 'worker': 'cb-worker', 'checks': [gate_name], 'command': receipt['command'],
                'case_protocol': True, 'worker_transport': 'boxes-thread', 'cwd': '.'}
        plan = {**self.plan, 'gates': [*self.plan['gates'], gate]}
        state = {**copy.deepcopy(self.state), 'plan': plan, 'plan_digest': c.digest(plan), 'phase': 'initial', 'source': source,
                 'input_fingerprints': {**self.state['input_fingerprints'], gate_name: 'fp'}}
        c.advance(state, [receipt])
        occurrence = state['failures'][-1]
        self.assertEqual(('triage', 'UNVERIFIED', False), (state['phase'], occurrence['native_result'], occurrence['complete']))
        shas = {k: hashlib.sha256(v.read_bytes()).hexdigest() for k, v in paths.items()}
        proof = {'receipt_sha256': shas['receipt'], 'worker_result_sha256': shas['adapter'], 'request_token': token, 'owner': dict(owner),
                 'platform_result': {'path': str(paths['platform']), 'sha256': shas['platform']},
                 'native_audit': {'path': str(paths['audit']), 'sha256': shas['audit']},
                 'process': {'path': str(paths['process']), 'sha256': shas['process']},
                 'confirmed_at': 1793667622.0, 'observed_by': 'ph-fake-coordinator'}
        return state, plan, gate, occurrence, paths, shas, proof

    def test_legacy_adapter_owner_is_detected_identity_checked_and_blocks_launch(self):
        state, plan, gate, occurrence, paths, shas, proof = self.recon_state()
        self.assertEqual(['cloudbench-controller'], c.retained_owners(state, ['cloudbench-controller']))
        with self.assertRaisesRegex(ValueError, 'cleanup owner'):
            c.reexecute(state, occurrence['id'])
        forced = copy.deepcopy(state); forced.update(phase='focused', repair_gates=['cloudbench-controller'],
                                                    focused={'cloudbench-controller': {'command': gate['command'], 'checks': ['cloudbench-controller']}})
        forced.pop('pending', None)
        with patch.object(c, 'source', return_value=state['source']), patch.object(c, 'input_fingerprints', return_value=state['input_fingerprints']), \
             patch.object(c, 'environment_digest', return_value=state['environment']), \
             patch.object(c, 'execute') as launcher, self.assertRaisesRegex(ValueError, 'cloudbench-controller'):
            c.run_phase(plan, forced, self.directory, self.root)
        launcher.assert_not_called(); self.assertEqual(0, forced['round'])
        # identity mismatch or a missing adapter file is a loud error, never silent admission or ignoring
        mismatched = copy.deepcopy(state); bad = self.directory / 'bad-adapter.json'
        bad.write_text(json.dumps({**json.loads(paths['adapter'].read_text()), 'token': 'other-token'}))
        mismatched['attempts'][-1]['results'][0]['worker_result'] = str(bad)
        with self.assertRaisesRegex(ValueError, 'cloudbench-controller.*identity'):
            c.retained_owners(mismatched, ['cloudbench-controller'])
        missing = copy.deepcopy(state); missing['attempts'][-1]['results'][0]['worker_result'] = str(self.directory / 'nope.json')
        with self.assertRaisesRegex(ValueError, 'cloudbench-controller'):
            c.retained_owners(missing, ['cloudbench-controller'])
        # a present-but-partial owner identity is never "unowned": loud error, zero launches
        for missing_field in ('worker_thread', 'worker_host', 'worker_root', 'turn_id'):
            with self.subTest(missing_field=missing_field):
                partial = copy.deepcopy(state); doc = json.loads(paths['adapter'].read_text())
                doc['cleanup_owner'] = {k: v for k, v in doc['cleanup_owner'].items() if k != missing_field}
                path = self.directory / f'partial-{missing_field}.json'; path.write_text(json.dumps(doc))
                partial['attempts'][-1]['results'][0]['worker_result'] = str(path)
                with self.assertRaisesRegex(ValueError, 'cloudbench-controller: adapter cleanup owner identity incomplete'):
                    c.retained_owners(partial, ['cloudbench-controller'])
                partial.update(phase='focused', repair_gates=['cloudbench-controller'],
                               focused={'cloudbench-controller': {'command': gate['command'], 'checks': ['cloudbench-controller']}})
                partial.pop('pending', None)
                with patch.object(c, 'source', return_value=state['source']), patch.object(c, 'input_fingerprints', return_value=state['input_fingerprints']), \
                     patch.object(c, 'environment_digest', return_value=state['environment']), \
                     patch.object(c, 'execute') as launcher, self.assertRaisesRegex(ValueError, 'identity incomplete'):
                    c.run_phase(plan, partial, self.directory, self.root)
                launcher.assert_not_called()
        # No owner is sufficient only with explicitly complete cleanup.
        unowned = copy.deepcopy(state); doc = json.loads(paths['adapter'].read_text()); doc.pop('cleanup_owner')
        doc['cleanup_complete'] = True
        path = self.directory / 'unowned.json'; path.write_text(json.dumps(doc))
        unowned['attempts'][-1]['results'][0]['worker_result'] = str(path)
        self.assertEqual([], c.retained_owners(unowned, ['cloudbench-controller']))
        for cleanup in (False, None, 1, 'true'):
            with self.subTest(uncertain_cleanup=cleanup):
                uncertain = copy.deepcopy(unowned); bad = dict(doc)
                if cleanup is None:
                    bad.pop('cleanup_complete')
                else:
                    bad['cleanup_complete'] = cleanup
                path = self.directory / 'uncertain-cleanup.json'; path.write_text(json.dumps(bad))
                uncertain['attempts'][-1]['results'][0]['worker_result'] = str(path)
                with self.assertRaisesRegex(ValueError, 'cloudbench-controller: adapter cleanup state unknown'):
                    c.retained_owners(uncertain, ['cloudbench-controller'])

    def test_actual_reconciliation_proof_unblocks_fresh_reexecution_without_credit(self):
        state, plan, gate, occurrence, paths, shas, proof = self.recon_state()
        before_results = copy.deepcopy(state['attempts'])
        c.reconcile(state, occurrence['id'], proof)
        entry = state['reconciled_owners'][shas['receipt']]
        self.assertEqual((occurrence['id'], 'cloudbench-controller', proof['request_token'], shas['adapter'], shas['audit'], proof['owner']['turn_id']),
                         (entry['occurrence'], entry['gate'], entry['token'], entry['worker_result_sha256'], entry['native_audit_sha256'], entry['platform_turn_id']))
        self.assertEqual([], c.retained_owners(state, ['cloudbench-controller']))
        c.reexecute(state, occurrence['id'])
        self.assertEqual('needs-focused-plan', state['phase'])
        c.focused_plan(state, plan, {'source': state['source'], 'gates': {'cloudbench-controller': {'command': gate['command'], 'checks': ['cloudbench-controller']}}})
        with patch.object(c, 'source', return_value=state['source']), patch.object(c, 'input_fingerprints', return_value=state['input_fingerprints']), \
             patch.object(c, 'environment_digest', return_value=state['environment']), \
             patch.object(c, 'execute', return_value={'gate': 'cloudbench-controller', 'status': 'PASS', 'cases': {'cloudbench-controller': 'PASS'},
                                                      'complete': True, 'source': state['source'], 'command': gate['command'], 'log': 'x', 'native_exit': 0}) as launcher:
            c.run_phase(plan, state, self.directory, self.root)
        launcher.assert_called_once(); self.assertEqual(gate['command'], launcher.call_args.args[0]['command'])
        import hashlib
        self.assertEqual(shas, {k: hashlib.sha256(v.read_bytes()).hexdigest() for k, v in paths.items()})  # fixture files untouched
        self.assertEqual(before_results, state['attempts'][:1])  # the original outcome is immutable
        self.assertEqual('UNVERIFIED', state['attempts'][0]['results'][0]['cases']['cloudbench-controller'])
        # a newer receipt with a fresh owner re-blocks despite the earlier reconciliation
        state['attempts'].append({'phase': 'focused', 'results': [{'gate': 'cloudbench-controller', 'status': 'FAIL', 'complete': False,
                                  'cases': {'cloudbench-controller': 'UNVERIFIED'}, 'token': 'tok-new', 'lingering_group': True,
                                  'cleanup_owner': {'request_token': 'tok-new', 'worker_cleanup_owner': {'worker_thread': 'ph7dr8sexrfwqqprpv6m6m0byd8heees', 'turn_id': 'turn-new'}},
                                  'source': state['source'], 'log': 'y'}]})
        self.assertEqual(['cloudbench-controller'], c.retained_owners(state, ['cloudbench-controller']))

    def missing_identity_recon_state(self):
        state, plan, gate, occurrence, paths, shas, proof = self.recon_state()
        original = {**proof['owner'], 'turn_id': None, 'message_id': None}
        adapter = c.read(paths['adapter']); adapter['cleanup_owner'] = original
        adapter['transport_receipt'].update(turn_id=None, message_id=None)
        c.write(paths['adapter'], adapter)
        receipt = state['attempts'][-1]['results'][0]
        receipt.update(lingering_group=True, cleanup_owner={
            'request_token': proof['request_token'], 'worker_cleanup_owner': original})
        c.write(paths['receipt'], receipt)
        proof.update(owner=original, receipt_sha256=c.sha_file(paths['receipt']),
                     worker_result_sha256=c.sha_file(paths['adapter']))
        send = paths['receipt'].parent / 'cached-send.json'
        c.write(send, {'schemaVersion': 1, 'ok': True, 'operation': 'send',
            'threadId': original['worker_thread'], 'disposition': 'started',
            'turnId': 'fake-turn-id', 'messageId': 'fake-message-id'})
        proof['send_receipt'] = {'path': str(send), 'sha256': c.sha_file(send)}
        return state, occurrence, paths, proof

    def test_missing_owner_identity_reconciles_only_hash_bound_same_turn_without_credit(self):
        state, occurrence, paths, proof = self.missing_identity_recon_state()
        before = copy.deepcopy(state['attempts'])
        original_files = {k: p.read_bytes() for k, p in paths.items()}
        c.reconcile(state, occurrence['id'], proof)
        entry = state['reconciled_owners'][proof['receipt_sha256']]
        self.assertEqual(proof['owner'], entry['owner'])
        self.assertIsNone(entry['owner']['turn_id']); self.assertIsNone(entry['owner']['message_id'])
        self.assertEqual('fake-turn-id', entry['resolved_owner']['turn_id'])
        self.assertEqual('fake-message-id', entry['resolved_owner']['message_id'])
        self.assertEqual(proof['send_receipt'], entry['proof']['send_receipt'])
        self.assertFalse(entry['credit_granted'])
        self.assertEqual([], c.retained_owners(state, ['cloudbench-controller']))
        self.assertEqual(before, state['attempts'])
        self.assertEqual(original_files, {k: p.read_bytes() for k, p in paths.items()})
        self.assertEqual('UNVERIFIED', state['attempts'][-1]['results'][0]['cases']['cloudbench-controller'])

    def test_missing_owner_identity_send_proof_refusals_are_atomic(self):
        state, occurrence, paths, proof = self.missing_identity_recon_state()
        before = copy.deepcopy(state)
        variants = [dict(proof, send_receipt={'path': proof['send_receipt']['path'], 'sha256': '0' * 64}),
                    {k: v for k, v in proof.items() if k != 'send_receipt'}]
        native = c.read(Path(proof['send_receipt']['path']))
        for key, value in [('ok', False), ('operation', 'read'), ('threadId', 'other'),
                           ('disposition', 'rejected'), ('turnId', 'other'), ('turnId', None),
                           ('messageId', None)]:
            path = paths['receipt'].parent / f'bad-{key}-{value}.json'
            c.write(path, {**native, key: value})
            variants.append({**proof, 'send_receipt': {'path': str(path), 'sha256': c.sha_file(path)}})
        for variant in variants:
            with self.subTest(proof=variant['send_receipt'] if 'send_receipt' in variant else None):
                with self.assertRaises(ValueError):
                    c.reconcile(state, occurrence['id'], variant)
                self.assertEqual(before, state)
        # A known identity is never replaced by a new platform send receipt.
        owner = {**proof['owner'], 'message_id': 'known-other'}
        adapter = c.read(paths['adapter']); adapter['cleanup_owner'] = owner; c.write(paths['adapter'], adapter)
        receipt = state['attempts'][-1]['results'][0]
        receipt['cleanup_owner']['worker_cleanup_owner'] = owner; c.write(paths['receipt'], receipt)
        known = {**proof, 'owner': owner, 'receipt_sha256': c.sha_file(paths['receipt']),
                 'worker_result_sha256': c.sha_file(paths['adapter'])}
        before = copy.deepcopy(state)
        with self.assertRaises(ValueError):
            c.reconcile(state, occurrence['id'], known)
        self.assertEqual(before, state)

    def native_recon_state(self):
        import hashlib
        import shutil
        import time
        from cloudbench_execution_provenance import build_config, build_task_matrix
        state, plan, gate, occurrence, paths, shas, old_proof = self.recon_state()
        gate['native_cloud'] = True
        token, source = old_proof['request_token'], state['source']
        runs = self.root / '.context/deploy-cloud' / hashlib.sha256(token.encode()).hexdigest() / 'runs'
        runs.mkdir(parents=True)
        hub = runs / '_hub/agent-link-server.8770.hub.owner'; hub.parent.mkdir()
        hub_owner = dict(version='1', status='live-transfer-required', pid='1234', pgid='1234',
            pid_start='proc-start:fixture:99', owner_token='hub', argv_sha256='c' * 64,
            root=str(runs), runs_root=str(runs), repo_root=str(self.root), context_dir=str(hub.parent),
            command=str(self.root / 'agents/benchmarks/agent_link_server.py'))
        def text_fields(path, values):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(''.join(f'{k}={v}\n' for k, v in values.items()))
        text_fields(hub, hub_owner)
        def tree_hash(folder):
            h = hashlib.sha256()
            for file in sorted(folder.rglob('*'), key=lambda p: str(p.relative_to(folder))):
                if file.is_file() and file.name != 'source-audit':
                    for value in (str(file.relative_to(folder)).encode(), file.read_bytes()):
                        h.update(len(value).to_bytes(8, 'big')); h.update(value)
            return h.hexdigest()
        files = [hub]
        fleets = []
        for ordinal, role in enumerate(('parent', 'canary')):
            fleet = runs / role; fleets.append(fleet)
            names = [gate['name']] if role == 'parent' else ['infra-probe']
            owner = str(ordinal + 1) * 32
            audit = fleet / 'teardown-ownership'; audit.mkdir(parents=True)
            meta = dict(version='1', fleet_owner_token=owner, run_id=role, app='fixture',
                workspace_root=str(self.root), status='provider-teardown-verified',
                hub_disposition='retained-exact-owner-transfer-required', hub_owner_file=str(hub),
                hub_owner_token='hub', hub_pid='1234', hub_pid_start=hub_owner['pid_start'], hub_argv_sha256='c' * 64)
            text_fields(audit / 'meta', meta)
            (audit / 'provider-teardown-verified.epoch').write_text('1793665721\n')
            (audit / 'owned-clones.ids').write_text('machine1\n' if ordinal else '')
            (audit / 'owned-clones.names').write_text('clone1\n' if ordinal else '')
            if ordinal:
                text_fields(audit / 'fresh/clone1', dict(fleet_owner_token=owner, run_id=role, app='fixture',
                    source='fresh-clone', disposition='destroyed-provider-retained', machine_id='machine1',
                    volume_id='vol_fixture', clone_name='clone1'))
            for scaffold in ('pool', 'pool-handoffs', 'volume-migrations'):
                (audit / scaffold).mkdir()
            canonical = self.root / '.git/cloudbench-fleet-audits' / owner
            shutil.copytree(audit, canonical)
            seal = tree_hash(audit)
            text_fields(audit / 'source-audit', dict(path=str(canonical), sha256=seal))
            c.write(fleet / '_batch/lifecycle.json', dict(version=1, fleet_owner_token=owner, run_id=role,
                workspace_root=str(self.root), status='failed' if not ordinal else 'verified',
                controller_exit_code=1 if not ordinal else 0, audit_sha256=seal, hub_publication_failed=False))
            c.write(fleet / '_batch/run.json', dict(tasks=[], status='failed' if not ordinal else 'passed'))
            c.write(fleet / '_batch/disposable-cleanup.json', dict(schema='disposable-cleanup-v1', owner=owner,
                guest_cleanup_missing=False, runtime_evidence_missing=False, successful_runtime_inferred=False))
            matrix = build_task_matrix([name + '=real' for name in names])
            config = build_config('cloudbench-fleet-config-v1', ['task_count=1', 'task_matrix_sha256=' + matrix['sha256']])
            c.write(fleet / 'execution-task-matrix.json', matrix)
            c.write(fleet / 'execution-provenance.json', dict(schema_version='cloudbench-execution-provenance-v1',
                base_sha=source['head'], workspace_patch_sha256='none', config=config,
                controller_snapshot=dict(schema_version='cloudbench-controller-snapshot-v1', sha256='d' * 64)))
            (fleet / '_batch/benches.json').write_text(json.dumps([dict(name=name, mode='REAL') for name in names]))
            files.extend(p for p in fleet.rglob('*') if p.is_file())
            files.extend(p for p in canonical.rglob('*') if p.is_file())
        log, status = runs / 'detached-fixture.log', runs / 'detached-fixture.status'
        log.write_text(''.join(f'{self.root}/scripts/run-bench monitor {fleet} --controller-status {status}\n' for fleet in fleets))
        status.write_text('1\n')
        cli = runs.parent / 'cli.log'; cli.write_text(f'log: tail -f {log}\ncontroller exit marker: {status}\n')
        receipt = state['attempts'][-1]['results'][0]
        adapter = c.read(paths['adapter']); adapter.update(runner_log=str(cli), native_exit=1, started_at=1793664471.0)
        c.write(paths['adapter'], adapter)
        reference = dict(result=str(paths['adapter']), result_sha256=c.sha_file(paths['adapter']),
                         native_directory=None, cleanup_complete=False, native_evidence={})
        owner = dict(request_token=token, worker_root=str(self.root), native_cleanup_reference=reference)
        receipt.update(lifecycle='native-producer', native_cleanup_reference=reference, cleanup_owner=owner, lingering_group=True)
        c.write(paths['receipt'], receipt)
        request = paths['receipt'].parent / 'request.json'
        c.write(request, dict(token=token, source=source, gate=gate['name'], checks=[gate['name']]))
        files.extend([request, log, status, cli])
        proof = dict(kind='native-cloud-cleanup-v1', receipt_sha256=c.sha_file(paths['receipt']),
            worker_result_sha256=c.sha_file(paths['adapter']), owner=copy.deepcopy(owner), request_token=token,
            source=source, controller_log=str(log), confirmed_at=time.time(), observed_by='private-fixture',
            files={str(p): c.sha_file(p) for p in files})
        return state, occurrence, paths, proof, hub

    def test_native_cloud_cleanup_overlay_preserves_failed_execution_and_retained_hub(self):
        state, occurrence, paths, proof, hub = self.native_recon_state()
        before = copy.deepcopy(state['attempts'])
        original = {str(p): p.read_bytes() for p in [*paths.values(), *map(Path, proof['files'])]}
        c.reconcile(state, occurrence['id'], proof)
        entry = state['reconciled_owners'][proof['receipt_sha256']]
        self.assertFalse(entry['credit_granted']); self.assertEqual(proof['owner'], entry['owner'])
        self.assertEqual([], c.retained_owners(state, [occurrence['gate']]))
        self.assertEqual('live-transfer-required', entry['retained_services'][0]['owner']['status'])
        self.assertEqual(str(hub), entry['retained_services'][0]['path'])
        self.assertEqual('triage', state['phase']); self.assertEqual(before, state['attempts'])
        self.assertEqual(original, {str(p): p.read_bytes() for p in map(Path, original)})
        changed_owner = {**proof['owner'], 'native_cleanup_reference': {'changed': True}}
        self.assertFalse(c._reconciled(state, state['attempts'][-1]['results'][0], changed_owner))
        hub.write_text(hub.read_text().replace('pid=1234', 'pid=9999'))
        self.assertEqual([occurrence['gate']], c.retained_owners(state, [occurrence['gate']]))

    def test_native_cloud_cleanup_proof_refusals_are_atomic(self):
        state, occurrence, paths, proof, hub = self.native_recon_state()
        before = copy.deepcopy(state)
        variants = [{**proof, 'receipt_sha256': '0' * 64}, {**proof, 'worker_result_sha256': '0' * 64},
            {**proof, 'request_token': 'other'}, {**proof, 'source': {}},
            {**proof, 'owner': {**proof['owner'], 'native_cleanup_reference': {}}},
            {**proof, 'files': {k: v for k, v in proof['files'].items() if k != str(hub)}},
            {**proof, 'confirmed_at': 1}, {**proof, 'confirmed_at': float('inf')},
            {**proof, 'controller_log': str(self.root / 'foreign.log')}]
        for variant in variants:
            with self.subTest(proof=variant), self.assertRaises(ValueError):
                c.reconcile(state, occurrence['id'], variant)
            self.assertEqual(before, state)
        unsupported = copy.deepcopy(state)
        next(g for g in unsupported['plan']['gates'] if g['name'] == occurrence['gate']).pop('native_cloud')
        with self.assertRaises(ValueError): c.reconcile(unsupported, occurrence['id'], proof)
        self.assertEqual(before, state)
        runs = Path(proof['controller_log']).parent
        (runs / 'unrecorded').mkdir()
        with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before, state)

    def test_reconciliation_refusals_are_atomic(self):
        state, plan, gate, occurrence, paths, shas, proof = self.recon_state()
        before = copy.deepcopy(state)
        def altered(key, **changes):
            doc = json.loads(paths[key].read_text()); doc.update(changes)
            path = self.directory / f'altered-{key}.json'; path.write_text(json.dumps(doc)); return str(path)
        variants = {
            'wrong token': {**proof, 'request_token': 'other'},
            'owner field': {**proof, 'owner': {**proof['owner'], 'turn_id': 'turn-x'}},
            'receipt sha': {**proof, 'receipt_sha256': 'a' * 64},
            'adapter sha': {**proof, 'worker_result_sha256': 'a' * 64},
            'platform sha': {**proof, 'platform_result': {**proof['platform_result'], 'sha256': 'a' * 64}},
            'audit sha': {**proof, 'native_audit': {**proof['native_audit'], 'sha256': 'a' * 64}},
            'process sha': {**proof, 'process': {**proof['process'], 'sha256': 'a' * 64}},
            'platform host': {**proof, 'platform_result': {'path': altered('platform', data={**json.loads(paths['platform'].read_text())['data'], 'executionInstanceId': 'other'}), 'sha256': None}},
            'platform not completed': {**proof, 'platform_result': {'path': altered('platform', data={**json.loads(paths['platform'].read_text())['data'], 'status': 'running'}), 'sha256': None}},
            'audit not clean': {**proof, 'native_audit': {'path': altered('audit', cleanup_complete=False), 'sha256': None}},
            'process not quiescent': {**proof, 'process': {'path': altered('process', quiescent=False), 'sha256': None}},
            'process remaining': {**proof, 'process': {'path': altered('process', remaining=[1]), 'sha256': None}},
            'early confirmation': {**proof, 'confirmed_at': 1793664000.0},
            'non-finite confirmation': {**proof, 'confirmed_at': float('inf')},
            'missing observer': {**proof, 'observed_by': ''},
            'missing field': {k: v for k, v in proof.items() if k != 'process'},
            'missing proof file': {**proof, 'process': {'path': str(self.directory / 'nope.json'), 'sha256': shas['process']}},
            'with link': {**proof, 'repair_agent': 'https://boxes.dev/thread/thr_x'},
            'with resource flag': {**proof, 'resource_skip': {}},
            'with assigned flag': {**proof, 'assigned_repair': True},
            'wrong pgid': {**proof, 'owner': {**proof['owner'], 'pgid': 7}},
            'wrong message_id': {**proof, 'owner': {**proof['owner'], 'message_id': 'other'}},
            'wrong owner request_token': {**proof, 'owner': {**proof['owner'], 'request_token': 'other'}},
            'modified embedded evidence': {**proof, 'platform_result': {'path': altered('platform', data={**json.loads(paths['platform'].read_text())['data'],
                'output': {'text': json.loads(paths['platform'].read_text())['data']['output']['text'].replace('"tail": "ok"', '"tail": "edited"')}}), 'sha256': None}},
        }
        import hashlib
        for label, variant in variants.items():
            with self.subTest(variant=label):
                for key in ('platform_result', 'native_audit', 'process'):
                    if variant.get(key, {}).get('sha256') is None and isinstance(variant.get(key), dict):
                        variant[key]['sha256'] = hashlib.sha256(Path(variant[key]['path']).read_bytes()).hexdigest()
                with self.assertRaises(ValueError):
                    c.reconcile(state, occurrence['id'], variant)
                self.assertEqual(before, state)
        with self.assertRaises(ValueError):  # unknown occurrence
            c.reconcile(state, 'no-such-id', proof)
        self.assertEqual(before, state)
        # an unrelated same-token receipt on disk (different cases/identity) is refused; the recorded receipt is the binding
        unrelated = copy.deepcopy(json.loads(paths['receipt'].read_text())); unrelated['cases'] = {'cloudbench-controller': 'FAIL'}
        paths['receipt'].chmod(0o600); original_bytes = paths['receipt'].read_bytes(); c.write(paths['receipt'], unrelated)
        import hashlib
        with self.assertRaisesRegex(ValueError, 'differs from the recorded receipt|exact receipt'):
            c.reconcile(state, occurrence['id'], {**proof, 'receipt_sha256': hashlib.sha256(paths['receipt'].read_bytes()).hexdigest()})
        self.assertEqual(before, state); paths['receipt'].write_bytes(original_bytes)
        # malformed (non-object) or oversize adapter JSON fails closed in the legacy path
        for label, body in (('non-object', '[1, 2]'), ('oversize', '{"pad": "' + 'x' * (c.MAX_RECEIPT_BYTES + 1) + '"}')):
            with self.subTest(legacy=label):
                bad = self.directory / f'legacy-{label}.json'; bad.write_text(body)
                broken = copy.deepcopy(state); broken['attempts'][-1]['results'][0]['worker_result'] = str(bad)
                with self.assertRaisesRegex(ValueError, 'cloudbench-controller'):
                    c.retained_owners(broken, ['cloudbench-controller'])
                bad.unlink()
        # a gate with no retained owner cannot be "reconciled"
        plain = copy.deepcopy(self.state); failure = self.failure.__func__(self) if False else None
        self.state['phase'] = 'initial'; c.advance(self.state, [self.result(a='FAIL', b='PASS')])
        with self.assertRaisesRegex(ValueError, 'no retained owner|latest incomplete'):
            c.reconcile(self.state, self.state['failures'][-1]['id'], proof)

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

    def test_initialized_gitlink_hashes_index_oid_without_descending(self):
        module = self.root / 'module'; module.mkdir()
        def git(*args):
            return subprocess.check_output(['git', '-C', str(module), *args]).decode().strip()
        git('init', '-q')
        (module / 'file').write_text('first')
        git('add', '.')
        git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'first')
        first = git('rev-parse', 'HEAD')
        subprocess.run(['git', '-C', str(self.root), 'update-index', '--add', '--cacheinfo',
                        '160000,' + first + ',module'], check=True)
        source = c.source(self.root)
        inputs = c.input_fingerprints(self.plan, self.root)
        (module / 'file').write_text('second')
        git('add', '.')
        git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'second')
        self.assertEqual(source, c.source(self.root))
        self.assertEqual(inputs, c.input_fingerprints(self.plan, self.root))
        subprocess.run(['git', '-C', str(self.root), 'update-index', '--cacheinfo',
                        '160000,' + git('rev-parse', 'HEAD') + ',module'], check=True)
        self.assertNotEqual(source, c.source(self.root))
        self.assertNotEqual(inputs, c.input_fingerprints(self.plan, self.root))

    def test_unmerged_index_refuses_both_fingerprint_functions(self):
        oid = subprocess.check_output(['git', '-C', str(self.root), 'rev-parse', 'HEAD:code']).decode().strip()
        subprocess.run(['git', '-C', str(self.root), 'update-index', '--index-info'], check=True,
                       input=('0 ' + '0' * 40 + '\tcode\n100644 ' + oid + ' 2\tcode\n').encode())
        for name, invoke in [('source', lambda: c.source(self.root)),
                             ('inputs', lambda: c.input_fingerprints(self.plan, self.root))]:
            with self.subTest(function=name), self.assertRaisesRegex(ValueError, 'unambiguous merged index'):
                invoke()

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
