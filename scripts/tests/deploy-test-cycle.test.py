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

    def local_rebind_fixture(self):
        import contextlib, io
        old = copy.deepcopy(self.plan)
        gate = old['gates'][1]
        remote = '/prepared/remote-api'
        env = {'CONDUCTOR_WORKSPACE_NAME': 'remote-api', 'CONDUCTOR_PORT': '4000',
               'DEPLOY_RUN_ROOT': remote + '/.context/deploy-runs', 'DEPLOY_CYCLE_FRESH': '1'}
        recipe = {'cases': {check: {'command': ['bash', remote + '/scripts/case.sh', check],
                   'env': dict(env), 'timeout_seconds': 14400} for check in gate['checks']},
                  'setup': {'command': ['true'], 'env': dict(env)},
                  'cleanup': {'command': ['true'], 'env': dict(env)}, 'services': True}
        gate.update(worker_transport='boxes-thread', worker_host='host-api', worker_thread='thread-api',
                    coordinator_thread='parent', worker_root=remote, remote_python=remote + '/agents/venv/bin/python',
                    cwd=str(self.root), env=env, case_protocol=True, result_transport='file',
                    timeout_seconds=14400, worker_recipe=recipe,
                    command=[sys.executable, str(self.root / 'scripts/deploy_test_boxes.py'), '--thread',
                             'thread-api', '--host', 'host-api', '--worker-root', remote, '--python',
                             remote + '/agents/venv/bin/python', '--coordinator-thread', 'parent',
                             '--deadline-seconds', '14400'])
        target = Path(self.workers.name) / 'new-api'
        subprocess.run(['git', 'clone', '-q', '--local', str(self.root), str(target)], check=True)
        new = copy.deepcopy(old)
        new['gates'][1] = c.local_worker_gate(gate, self.root, str(target), 'local-api', '12000')
        state = c.initialize(old, self.root)
        state.update(phase='ready', ready=True, carried_passes={'api': {'old': 'native evidence'}},
                     reconciled_owners={'historical-owner': {'obligation': 'retained'}},
                     pending_post_merge=[{'packet': 'original immutable post-merge obligation'}])
        native = dict(gate='api', source=state['source'], cases={'a': 'PASS', 'b': 'PASS'},
                      status='PASS', complete=True, executed=True, command=gate['command'], native_exit=0)
        state['attempts'].append({'phase': 'initial', 'results': [native]})
        original = self.directory / 'original.json'; local = self.directory / 'local.json'
        c.write(original, old); c.write(local, new); c.write(self.directory / 'cycle.json', state)
        def call():
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                return c.main(['rebind-local', '--plan', str(local), '--input', str(original),
                               '--state-dir', str(self.directory), '--root', str(self.root)])
        return old, new, state, target, local, call

    def test_local_rebind_cli_preserves_native_history_and_requires_fresh_full_gate(self):
        old, new, state, target, local, call = self.local_rebind_fixture()
        with self.assertRaisesRegex(ValueError, 'execution contract'):
            c.refresh(copy.deepcopy(state), old, new, self.root)
        self.assertEqual(0, call())
        after = c.read(self.directory / 'cycle.json')
        for key in ('source', 'attempts', 'failures', 'reconciled_owners', 'pending_post_merge', 'skips', 'round'):
            self.assertEqual(state[key], after[key])
        self.assertFalse(after['ready']); self.assertEqual('quick', after['phase'])
        self.assertEqual('initial', after['next_after_quick']); self.assertNotIn('api', after['carried_passes'])
        self.assertEqual(old, after['worker_rebind_history'][0]['from_plan'])
        self.assertFalse(after['worker_rebind_history'][0]['credit_granted'])
        after['phase'] = 'initial'
        self.assertIn('api', [g['name'] for g in c.records(new, after)])
        gate = new['gates'][1]
        self.assertEqual(['a', 'b'], gate['checks'])
        self.assertEqual(14400, gate['timeout_seconds'])
        self.assertEqual(str(target / '.context/deploy-runs'), gate['worker_recipe']['cleanup']['env']['DEPLOY_RUN_ROOT'])
        self.assertEqual('local-api', gate['worker_recipe']['setup']['env']['CONDUCTOR_WORKSPACE_NAME'])

    def test_local_rebind_refuses_workload_collision_and_unprepared_source_atomically(self):
        old, new, state, target, path, call = self.local_rebind_fixture()
        changed = []
        for mutate in (
                lambda p: p['gates'][1]['checks'].pop(),
                lambda p: p['gates'][1].update(timeout_seconds=14401),
                lambda p: p['gates'][1]['worker_recipe']['cases']['a']['command'].append('--waive'),
                lambda p: p['gates'][1]['worker_recipe']['cleanup'].update(command=['false']),
                lambda p: p['gates'][1]['env'].update(DEPLOY_CYCLE_FRESH='0'),
                lambda p: p['gates'][1]['env'].update(CONDUCTOR_PORT='24000'),
                lambda p: p['gates'].pop(),
                lambda p: p.update(source={'head': 'wrong', 'digest': 'wrong'})):
            candidate = copy.deepcopy(new); mutate(candidate); changed.append(candidate)
        original = (self.directory / 'cycle.json').read_bytes()
        for candidate in changed:
            with self.subTest(candidate=candidate['gates'][1]):
                c.write(path, candidate); self.assertEqual(2, call())
                self.assertEqual(original, (self.directory / 'cycle.json').read_bytes())
        c.write(path, new); (target / 'code').write_text('not frozen')
        self.assertEqual(2, call())
        self.assertEqual(original, (self.directory / 'cycle.json').read_bytes())
        (target / 'code').write_text('original')
        with (target / '.git/info/exclude').open('a') as stream:
            stream.write('\n.env\n')
        (target / '.env').write_text('different ignored runtime configuration')
        self.assertEqual(c.source(self.root), c.source(target))
        self.assertEqual(2, call())
        self.assertEqual(original, (self.directory / 'cycle.json').read_bytes())

    def test_local_rebind_refuses_pending_running_owner_and_concurrent_coordinator(self):
        old, new, state, target, path, call = self.local_rebind_fixture()
        state_path = self.directory / 'cycle.json'
        for update in ({'pending': ['unresolved']}, {'live_failures': []}, {'resume_phase': 'initial'}, {'running': True},
                       {'phase': 'initial'}, {'attempts': [{'phase': 'initial', 'results': [
                           dict(gate='api', lingering_group=True, cleanup_owner={'request_token': 'old'})]}]}):
            candidate = {**copy.deepcopy(state), **update}; c.write(state_path, candidate)
            original = state_path.read_bytes(); self.assertEqual(2, call())
            self.assertEqual(original, state_path.read_bytes())
        c.write(state_path, state); original = state_path.read_bytes()
        with c.exclusive(self.directory):
            self.assertEqual(2, call())
        self.assertEqual(original, state_path.read_bytes())

    def test_native_local_root_refuses_duplicates_and_preserves_original_deadlines(self):
        import time
        gate = {'command': ['fixture'], 'worker_transport': 'local-isolated', 'case_protocol': True}
        active = peak = calls = 0
        guard = threading.Lock()
        admissions = [{}, {}]
        def launch(_argv, **kwargs):
            nonlocal active, peak, calls
            with guard:
                active += 1; peak = max(peak, active); calls += 1
            self.assertGreater(kwargs['timeout'], 0); self.assertLessEqual(kwargs['timeout'], 1)
            time.sleep(.08)
            with guard:
                active -= 1
            return 0, False, False, False
        with patch.object(c, 'run_command', side_effect=launch), ThreadPoolExecutor(2) as pool:
            futures = [pool.submit(c.run_with_local_slot, gate, self.root, a, timeout=1) for a in admissions]
            self.assertCountEqual([(0, False, False, False), (None, False, False, False)], [f.result() for f in futures])
        self.assertEqual((1, 1), (peak, calls))
        self.assertEqual(1, sum(a['started'] for a in admissions))
        lock = self.root / '.context/native-worker-admission.lock'
        with lock.open('a') as held:
            c.fcntl.flock(held, c.fcntl.LOCK_EX | c.fcntl.LOCK_NB)
            with patch.object(c, 'run_command') as launch:
                admission = {}; start = time.monotonic()
                self.assertEqual((None, False, False, False),
                                 c.run_with_local_slot(gate, self.root, admission, timeout=.08))
                self.assertLess(time.monotonic() - start, .3)
                self.assertFalse(admission['started']); launch.assert_not_called()
                c.CANCEL.set(); admission = {}
                self.assertEqual((None, False, True, False),
                                 c.run_with_local_slot(gate, self.root, admission, timeout=1))
                self.assertFalse(admission['started']); launch.assert_not_called()
                c.CANCEL.clear()
                card = dict(name='card', checks=['card'], command=['must-not-launch'], case_protocol=True,
                            category='agentcard-lifecycle', worker_transport='local-isolated', timeout_seconds=.05)
                result = c.execute(card, self.state, self.directory, self.root)
                self.assertEqual({'card': 'UNVERIFIED'}, result['cases'])
                self.assertFalse(result['executed']); self.assertFalse(result['complete'])
                self.assertFalse(result['timed_out']); self.assertIsNone(result['native_exit'])
                self.assertFalse(result['lingering_group']); self.assertNotIn('cleanup_owner', result)
                launch.assert_not_called()

    def test_local_slot_holds_through_native_cleanup_validation_without_cancelling_cloud(self):
        import time
        started = self.root / '.context/first-native-started'
        forbidden = self.root / '.context/queued-native-started'
        script = ("import json,os,time;from pathlib import Path;"
                  "r=json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text());"
                  f"Path({str(started)!r}).touch();time.sleep(.15);"
                  "r.update(cases={c:'PASS' for c in r['checks']},complete=True,cleanup_complete=False,reused=False);"
                  "Path(os.environ['DEPLOY_GATE_RESULT']).write_text(json.dumps(r))")
        first = dict(name='card', category='agentcard-lifecycle', worker_transport='local-isolated',
                     case_protocol=True, checks=['card'], timeout_seconds=2, command=[sys.executable, '-c', script])
        second = dict(name='queued', category='generic', worker_transport='local-isolated',
                      case_protocol=True, checks=['queued'], timeout_seconds=2,
                      command=[sys.executable, '-c', f'from pathlib import Path;Path({str(forbidden)!r}).touch()'])
        self.state['phase'] = 'initial'; failed = threading.Event()
        with ThreadPoolExecutor(2) as pool:
            one = pool.submit(c.execute, first, self.state, self.directory, self.root, local_failure=failed)
            end = time.monotonic() + 1
            while not started.exists() and time.monotonic() < end:
                time.sleep(.005)
            self.assertTrue(started.exists())
            two = pool.submit(c.execute, second, self.state, self.directory, self.root, local_failure=failed)
            a, b = one.result(), two.result()
        self.assertEqual(0, a['native_exit']); self.assertTrue(a['lingering_group'])
        self.assertIn('cleanup_owner', a); self.assertTrue(failed.is_set())
        self.assertEqual({'queued': 'UNVERIFIED'}, b['cases'])
        self.assertFalse(b['executed']); self.assertFalse(b['complete']); self.assertFalse(forbidden.exists())
        cloud_script = ("import json,os;from pathlib import Path;"
                        "r=json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text());"
                        "r.update(cases={c:'PASS' for c in r['checks']},complete=True,cleanup_complete=True,reused=False);"
                        "Path(os.environ['DEPLOY_GATE_RESULT']).write_text(json.dumps(r))")
        cloud = dict(name='cloud', native_cloud=True, case_protocol=True, checks=['cloud'], timeout_seconds=2,
                     worker_transport='benchmark-cloud-cli', command=[sys.executable, '-c', cloud_script])
        result = c.execute(cloud, self.state, self.directory, self.root, local_failure=failed)
        self.assertEqual('PASS', result['status']); self.assertTrue(result['executed'])
        self.assertFalse(result['cancelled']); self.assertFalse(c.CANCEL.is_set())
        # Preparation/receipt bookkeeping consumes the same deadline too, without a late child launch.
        delayed = dict(second, name='delayed', checks=['delayed'], timeout_seconds=.04)
        with patch.object(c, 'revalidate_standing_skips', side_effect=lambda _: time.sleep(.08)), \
                patch.object(c, 'run_command') as launch:
            late = c.execute(delayed, self.state, self.directory, self.root)
        self.assertFalse(late['executed']); self.assertTrue(late['timed_out']); launch.assert_not_called()

    def test_lingering_native_supervisor_blocks_queued_local(self):
        import time
        started = self.root / '.context/owned-native-started'
        forbidden = self.root / '.context/owned-queued-started'
        script = ("import json,os,subprocess,sys,time;from pathlib import Path;"
                  "r=json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text());"
                  f"Path({str(started)!r}).touch();time.sleep(.1);"
                  "subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True);"
                  "r.update(cases={c:'PASS' for c in r['checks']},complete=True,cleanup_complete=True,reused=False);"
                  "Path(os.environ['DEPLOY_GATE_RESULT']).write_text(json.dumps(r))")
        first = dict(name='owned', category='generic', worker_transport='local-isolated',
                     case_protocol=True, checks=['owned'], timeout_seconds=2, command=[sys.executable, '-c', script])
        second = dict(first, name='queued', checks=['queued'],
                      command=[sys.executable, '-c', f'from pathlib import Path;Path({str(forbidden)!r}).touch()'])
        self.state['phase'] = 'initial'; failed = threading.Event()
        with ThreadPoolExecutor(2) as pool:
            one = pool.submit(c.execute, first, self.state, self.directory, self.root, local_failure=failed)
            end = time.monotonic() + 1
            while not started.exists() and time.monotonic() < end:
                time.sleep(.005)
            self.assertTrue(started.exists())
            two = pool.submit(c.execute, second, self.state, self.directory, self.root, local_failure=failed)
            a, b = one.result(), two.result()
        self.assertEqual(0, a['native_exit']); self.assertTrue(a['lingering_group'])
        process = c.read(Path(a['log'] + '.process.json'))
        self.assertTrue(process['orphaned_children']); self.assertTrue(process['quiescent'])
        self.assertEqual([], process['remaining'])
        self.assertTrue(failed.is_set()); self.assertFalse(b['executed']); self.assertFalse(forbidden.exists())

    def test_native_distinct_roots_overlap_with_exact_root_admission(self):
        import time
        roots = [Path(self.workers.name) / name for name in ('api', 'ui')]
        def observe(root):
            target = root / 'native-overlap.json'
            script = ("import json,time;from pathlib import Path;start=time.monotonic();"
                      f"Path({str(target) + '.started'!r}).touch();time.sleep(.35);"
                      f"Path({str(target)!r}).write_text(json.dumps([start,time.monotonic()]))")
            gate = dict(command=[sys.executable, '-c', script], cwd=str(root), worker_root=str(root),
                        worker_transport='local-isolated', case_protocol=True)
            admission = {}
            with (root / 'output.log').open('wb') as output:
                result = c.run_with_local_slot(gate, self.root, admission, timeout=2,
                    cwd=root, env=dict(os.environ), output=output, owned_lifecycle=True)
            self.assertEqual((0, False, False, False), result)
            return json.loads(target.read_text()), admission
        with ThreadPoolExecutor(2) as pool:
            rows = list(pool.map(observe, roots))
        self.assertGreater(min(row[0][1] for row in rows), max(row[0][0] for row in rows))
        self.assertNotEqual(rows[0][1]['lock'], rows[1][1]['lock'])
        for root, (_, admission) in zip(roots, rows):
            self.assertEqual(str(root / '.context/native-worker-admission.lock'), admission['lock'])

    def independent_triage_fixture(self, failing=False):
        import contextlib, io
        plan = copy.deepcopy(self.plan)
        for name, port in [('missing', 37000), ('leased', 47000)]:
            root = Path(self.workers.name) / name; root.mkdir()
            plan['gates'].append(dict(name=name, worker=name, worker_transport='local-isolated',
                cwd=str(root), env={'CONDUCTOR_WORKSPACE_NAME': name, 'CONDUCTOR_PORT': str(port)},
                command=[sys.executable, '-c', 'import sys;sys.exit(' + ('1' if failing and name == 'missing' else '0') + ')'],
                checks=[name], timeout_seconds=2))
        state = c.initialize(plan, self.root); state['phase'] = 'initial'
        api = dict(plan['gates'][1], command=[sys.executable, '-c', 'raise SystemExit(1)'])
        # Original failure and successful full gate both come through actual native execution.
        results = [c.execute(api, state, self.directory, self.root),
                   c.execute(plan['gates'][2], state, self.directory, self.root)]
        c.advance(state, results)
        state['reconciled_owners'] = {'historical': {'debt': 'immutable financial/runtime obligation'}}
        path = self.directory / 'cycle.json'; plan_path = self.directory / 'plan.json'
        c.write(path, state); c.write(plan_path, plan)
        lease = Path(self.workers.name) / 'leased'
        def call():
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                return c.main(['triage-independent', '--plan', str(plan_path), '--state-dir', str(self.directory),
                               '--root', str(self.root), '--exclude-root', str(lease)])
        return state, plan, path, plan_path, call

    def diagnosed_independent_fixture(self, failing=False):
        state, plan, path, plan_path, call = self.independent_triage_fixture(failing)
        while len(state['failures']) < 23:
            failure = copy.deepcopy(state['failures'][0])
            failure['id'] = 'diagnosed-' + str(len(state['failures']))
            state['failures'].append(failure)
            state['pending'].append(failure['id'])
        c.adjudicate(state, {'failures': [self.report(f)['failures'][0] for f in state['failures']]})
        self.assertEqual('needs-focused-plan', state['phase'])
        self.assertEqual(23, len(state['failures']))
        api = next(g for g in plan['gates'] if g['name'] == 'api')
        receipt = c.latest_receipts(state)['api']
        receipt['cleanup_owner'] = {'request_token': receipt['token'], 'worker_root': api['cwd'],
                                    'financial_obligation': 'consumed4396/released0'}
        c.write(path, state)
        return state, plan, path, plan_path, call

    def test_diagnosed_independent_full_keeps_blocking_debt_and_excludes_retained(self):
        before, plan, path, _, call = self.diagnosed_independent_fixture()
        self.assertEqual(0, call())
        after = c.read(path)
        self.assertEqual(('needs-focused-plan', False), (after['phase'], after['ready']))
        for key in ('failures', 'repair_gates', 'reconciled_owners', 'failure_phase', 'source', 'plan_digest', 'skips'):
            self.assertEqual(before[key], after[key])
        self.assertNotIn('pending', after)
        self.assertEqual(['missing'], [r['gate'] for r in after['attempts'][-1]['results']])
        self.assertEqual('needs-focused-plan', after['attempts'][-1]['phase'])
        self.assertTrue(after['attempts'][-1]['independent_full'])
        gate = next(g for g in plan['gates'] if g['name'] == 'missing')
        self.assertTrue(c.reusable_full_pass(after, gate))
        self.assertFalse(any((self.directory / 'attempts').glob('*/needs-focused-plan/api/request.json')))
        self.assertEqual(1, c.verify_saved(self.directory, self.root))

    def test_diagnosed_independent_observes_repaired_gate_without_clearing_debt(self):
        before, plan, path, _, call = self.diagnosed_independent_fixture()
        latest = c.latest_receipts(before)
        owner = latest['api'].pop('cleanup_owner')
        owner['worker_root'] = next(g['cwd'] for g in plan['gates'] if g['name'] == 'ui')
        latest['ui']['cleanup_owner'] = owner
        c.write(path, before)
        self.assertEqual(0, call()); after = c.read(path)
        self.assertEqual({'api', 'missing'}, {r['gate'] for r in after['attempts'][-1]['results']})
        self.assertEqual(before['failures'], after['failures'])
        self.assertEqual(before['repair_gates'], after['repair_gates'])
        self.assertEqual(('needs-focused-plan', False), (after['phase'], after['ready']))
        api = next(g for g in plan['gates'] if g['name'] == 'api')
        self.assertTrue(c.reusable_full_pass(after, api))
        self.assertEqual(1, c.verify_saved(self.directory, self.root))

    def test_diagnosed_independent_requires_actual_disposition_evidence(self):
        before, _, path, _, call = self.diagnosed_independent_fixture()
        for field in ('disposition', 'rca'):
            candidate = copy.deepcopy(before)
            candidate['failures'][0].pop(field)
            c.write(path, candidate); saved = path.read_bytes()
            self.assertEqual(2, call()); self.assertEqual(saved, path.read_bytes())
        candidate = copy.deepcopy(before); candidate['failures'] = []
        c.write(path, candidate); saved = path.read_bytes()
        self.assertEqual(2, call()); self.assertEqual(saved, path.read_bytes())

    def test_diagnosed_independent_excluded_roots_cover_ancestors_and_descendants(self):
        import contextlib, io
        state, plan, path, plan_path, _ = self.diagnosed_independent_fixture()
        missing = Path(next(g['cwd'] for g in plan['gates'] if g['name'] == 'missing'))
        leased = next(g['cwd'] for g in plan['gates'] if g['name'] == 'leased')
        for excluded in (missing.parent, missing / 'active-child'):
            c.write(path, state); saved = path.read_bytes()
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = c.main(['triage-independent', '--plan', str(plan_path), '--state-dir', str(self.directory),
                               '--root', str(self.root), '--exclude-root', leased, '--exclude-root', str(excluded)])
            self.assertEqual(0, code)
            self.assertEqual(saved, path.read_bytes(), 'overlapping excluded root must not launch an observation')

    def test_diagnosed_independent_relative_cwd_uses_coordinator_root_for_retention(self):
        state, plan, path, plan_path, call = self.diagnosed_independent_fixture()
        missing = next(g for g in plan['gates'] if g['name'] == 'missing')
        absolute = Path(missing['cwd'])
        missing['cwd'] = os.path.relpath(absolute, self.root)
        c.latest_receipts(state)['api']['cleanup_owner']['worker_root'] = str(absolute)
        state.update(plan=plan, plan_digest=c.digest(plan), input_fingerprints=c.input_fingerprints(plan, self.root))
        c.write(path, state); c.write(plan_path, plan); saved = path.read_bytes()
        self.assertEqual(0, call())
        self.assertEqual(saved, path.read_bytes(), 'relative execution under a retained root must not launch')

    def test_diagnosed_independent_new_failure_returns_to_rca_with_old_repairs(self):
        before, plan, path, _, call = self.diagnosed_independent_fixture(failing=True)
        self.assertEqual(0, call())
        after = c.read(path)
        self.assertEqual(('triage', False), (after['phase'], after['ready']))
        self.assertEqual(before['failures'], after['failures'][:23])
        self.assertEqual(before['repair_gates'], after['repair_gates'])
        self.assertEqual(1, len(after['pending']))
        self.assertEqual('missing/missing', after['failures'][-1]['check'])
        c.adjudicate(after, self.report(after['failures'][-1]))
        self.assertEqual(('needs-focused-plan', False), (after['phase'], after['ready']))
        self.assertEqual({'api', 'missing'}, set(after['repair_gates']))
        self.assertEqual({}, after['skips'])

    def test_diagnosed_independent_excludes_historical_owner_root_and_does_not_invent_attempt(self):
        state, plan, path, _, call = self.diagnosed_independent_fixture()
        missing = next(g for g in plan['gates'] if g['name'] == 'missing')
        c.latest_receipts(state)['api']['cleanup_owner']['worker_root'] = missing['cwd']
        c.write(path, state); original = path.read_bytes()
        self.assertEqual(0, call())
        self.assertEqual(original, path.read_bytes())
        self.assertFalse(any((self.directory / 'attempts').glob('*/needs-focused-plan/*/request.json')))

    def test_diagnosed_independent_rejects_nonquiescence_and_stale_bindings_atomically(self):
        before, plan, path, plan_path, call = self.diagnosed_independent_fixture()
        for update in ({'running': True}, {'live_failures': []}, {'resume_phase': 'focused'},
                       {'ready': True}, {'pending': ['unresolved']}, {'repair_gates': []},
                       {'phase': 'focused'}, {'phase': 'ready'}, {'environment': 'stale'},
                       {'input_fingerprints': {}}):
            with self.subTest(update=update):
                c.write(path, {**copy.deepcopy(before), **update}); saved = path.read_bytes()
                self.assertEqual(2, call()); self.assertEqual(saved, path.read_bytes())
        c.write(path, before); original = path.read_bytes()
        with patch.dict(os.environ, {'ADMISSION_FIXTURE_ENV': 'changed'}):
            self.assertEqual(2, call())
        self.assertEqual(original, path.read_bytes())
        (self.root / 'code').write_text('stale source')
        self.assertEqual(2, call()); self.assertEqual(original, path.read_bytes())
        (self.root / 'code').write_text('original')
        changed = copy.deepcopy(plan); changed['gates'][-2]['command'].append('--changed')
        c.write(plan_path, changed)
        self.assertEqual(2, call()); self.assertEqual(original, path.read_bytes())
        c.write(plan_path, plan)
        with c.exclusive(self.directory): self.assertEqual(2, call())
        self.assertEqual(original, path.read_bytes())

    def test_diagnosed_observation_keeps_focused_plan_and_final_requirements(self):
        before, plan, path, _, call = self.diagnosed_independent_fixture()
        self.assertEqual(0, call()); after = c.read(path)
        result = after['attempts'][-1]['results'][0]
        gate = next(g for g in plan['gates'] if g['name'] == 'missing')
        self.assertEqual(gate['command'], result['command'])
        self.assertEqual({check: 'PASS' for check in gate['checks']}, result['cases'])
        self.assertTrue(result['executed']); self.assertTrue(result['complete'])
        self.assertEqual(0, result['native_exit'])
        with self.assertRaisesRegex(ValueError, 'every blocking gate'):
            c.focused_plan(after, plan, {'source': after['source'], 'gates': {}})
        api = next(g for g in plan['gates'] if g['name'] == 'api')
        c.focused_plan(after, plan, {'source': after['source'], 'gates': {
            'api': {'command': api['command'], 'checks': api['checks']}}})
        self.assertEqual('focused', after['phase']); self.assertFalse(after['ready'])
        with self.assertRaisesRegex(ValueError, 'unreconciled cleanup'):
            c.run_phase(plan, after, self.directory, self.root)
        self.assertEqual(before['failures'], after['failures'])
        self.assertEqual({}, after['skips'])

    def test_independent_triage_cli_keeps_pending_passes_and_leased_root(self):
        before, plan, path, _, call = self.independent_triage_fixture()
        self.assertEqual(0, call())
        after = c.read(path)
        self.assertEqual(('triage', False), (after['phase'], after['ready']))
        for key in ('pending', 'failures', 'reconciled_owners', 'failure_phase', 'source', 'plan_digest'):
            self.assertEqual(before[key], after[key])
        self.assertEqual(before['attempts'], after['attempts'][:-1])
        self.assertEqual(['missing'], [r['gate'] for r in after['attempts'][-1]['results']])
        self.assertTrue(after['attempts'][-1]['independent_full'])
        self.assertTrue(c.reusable_full_pass(after, next(g for g in plan['gates'] if g['name'] == 'missing')))
        focused = copy.deepcopy(after)
        focused.update(phase='focused', repair_gates=['api', 'ui', 'missing'], focused={
            g['name']: {'command': g['command'], 'checks': g['checks']} for g in plan['gates'] if not g.get('quick')})
        self.assertEqual(['api'], [g['name'] for g in c.records(plan, focused)])
        self.assertEqual(0, call())
        self.assertEqual(after['attempts'], c.read(path)['attempts'])
        self.assertFalse(any((self.directory / 'attempts').glob('*/triage/leased/request.json')))
        original = path.read_bytes()
        with c.exclusive(self.directory): self.assertEqual(2, call())
        self.assertEqual(original, path.read_bytes())

    def test_independent_triage_failure_appends_and_unsafe_inputs_refuse(self):
        before, plan, path, plan_path, call = self.independent_triage_fixture(failing=True)
        original = path.read_bytes()
        for update in ({'running': True}, {'live_failures': []}, {'resume_phase': 'triage'}):
            c.write(path, {**before, **update}); saved = path.read_bytes()
            self.assertEqual(2, call()); self.assertEqual(saved, path.read_bytes())
        path.write_bytes(original)
        changed = copy.deepcopy(plan); changed['gates'][-2]['checks'].append('dropped-contract')
        c.write(plan_path, changed); self.assertEqual(2, call()); self.assertEqual(original, path.read_bytes())
        c.write(plan_path, plan)
        (self.root / 'code').write_text('changed'); self.assertEqual(2, call())
        self.assertEqual(original, path.read_bytes()); (self.root / 'code').write_text('original')
        self.assertEqual(0, call()); after = c.read(path)
        self.assertEqual(before['pending'], after['pending'][:len(before['pending'])])
        self.assertEqual(before['failures'], after['failures'][:len(before['failures'])])
        self.assertEqual(1, len(after['pending']) - len(before['pending']))
        self.assertEqual('missing/missing', after['failures'][-1]['check'])
        self.assertEqual(('triage', False), (after['phase'], after['ready']))
        self.assertEqual(before['reconciled_owners'], after['reconciled_owners'])
        import contextlib, io
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(2, c.main(['verify', '--plan', str(plan_path), '--state-dir', str(self.directory),
                                       '--root', str(self.root)]))

    def test_pending_triage_refresh_keeps_old_debt_and_allows_new_source_independent_work(self):
        before, old, path, plan_path, call = self.independent_triage_fixture()
        state = copy.deepcopy(before)
        (self.root / 'code').write_text('actual new scheduler source')
        new = copy.deepcopy(old); new['source'] = c.source(self.root)
        c.refresh(state, old, new, self.root)
        self.assertEqual(before['pending'], state['pending'])
        self.assertEqual(before['failures'], state['failures'])
        self.assertEqual(before['reconciled_owners'], state['reconciled_owners'])
        self.assertEqual(before['attempts'], state['attempts'])
        self.assertEqual(before['source'], state['failures'][0]['source'])
        self.assertEqual(new['source'], state['source'])
        self.assertEqual('refresh', state['failure_phase']); self.assertFalse(state['ready'])
        c.run_phase(new, state, self.directory, self.root)  # only existing quick recipes
        self.assertEqual('triage', state['phase'])
        c.write(path, state); c.write(plan_path, new)
        self.assertEqual(0, call()); after = c.read(path)
        self.assertEqual({'ui', 'missing'}, {r['gate'] for r in after['attempts'][-1]['results']})
        self.assertEqual(before['pending'], after['pending'])
        self.assertEqual(before['failures'], after['failures'])
        self.assertEqual(before['reconciled_owners'], after['reconciled_owners'])
        self.assertEqual(('triage', False), (after['phase'], after['ready']))
        self.assertEqual(1, c.verify_saved(self.directory, self.root))

    def test_old_source_disposition_requires_current_renewal_without_exempting_new_inputs(self):
        failure = self.failure()
        old_native = copy.deepcopy(failure)
        old = copy.deepcopy(self.plan)
        (self.root / 'code').write_text('new source with unresolved old failure')
        new = copy.deepcopy(old); new['source'] = c.source(self.root)
        c.refresh(self.state, old, new, self.root)
        self.state['phase'] = 'triage'  # source-bound quick observation is unrelated to this guard
        report = self.report(failure, 'NOT_INTRODUCED', external_provider={'name': 'provider', 'reason': 'outage'})
        c.adjudicate(self.state, report)
        self.assertEqual({}, self.state['skips'])
        self.assertEqual(('triage', False), (self.state['phase'], self.state['ready']))
        self.assertEqual(old_native, {k: failure[k] for k in old_native})
        renewal = next(f for f in self.state['failures'] if f['id'] in self.state['pending'])
        self.assertEqual(new['source'], renewal['source'])
        self.assertEqual(old_native['source'], renewal['prior_waiver']['source'])
        self.assertEqual('prior waived failure; changed inputs', renewal['native_result'])
        explicit = self.report(renewal, 'NOT_INTRODUCED', external_provider={'name': 'provider', 'reason': 'outage'})
        c.adjudicate(self.state, explicit)
        self.assertEqual(new['source'], self.state['skips']['api/a']['source'])
        self.assertEqual(explicit['failures'][0], self.state['skips']['api/a']['rca'])
        self.assertFalse(self.state['ready'])  # final new-source coverage remains mandatory

    def test_stale_post_merge_packet_routes_current_execution_without_impossible_renewal(self):
        failure = self.failure(); native = copy.deepcopy(failure)
        old = copy.deepcopy(self.plan)
        (self.root / 'code').write_text('new inputs')
        new = copy.deepcopy(old); new['source'] = c.source(self.root)
        c.refresh(self.state, old, new, self.root); self.state['phase'] = 'triage'
        packet = {'test': 'api/a', 'command': failure['command'], 'scope': 'original failure',
                  'error': 'exact original FAIL', 'source': failure['source'], 'evidence': failure['evidence']}
        c.adjudicate(self.state, self.report(failure, 'NOT_INTRODUCED', post_merge=packet))
        self.assertEqual({}, self.state['skips']); self.assertFalse(self.state.get('pending'))
        self.assertEqual('needs-focused-plan', self.state['phase']); self.assertFalse(self.state['ready'])
        self.assertIn('api', self.state['repair_gates'])
        self.assertEqual(native, {k: failure[k] for k in native})
        self.assertEqual(packet, failure['rca']['post_merge'])
        self.assertEqual(packet, self.state['superseded_skips'][-1]['rca']['post_merge'])
        self.assertFalse(self.state.get('pending_post_merge'))

    def result(self, gate='api', **cases):
        return {'gate': gate, 'status': 'FAIL' if 'FAIL' in cases.values() else 'PASS',
                'cases': cases, 'complete': True, 'source': self.state['source'],
                'command': ['true'], 'log': 'original.log', 'native_exit': 1}

    def test_refresh_unstarted_quick_preserves_history_and_refuses_active_state(self):
        old = copy.deepcopy(self.plan)
        original = copy.deepcopy(self.state)
        (self.root / 'code').write_text('new repair before quick launch')
        new = copy.deepcopy(old)
        new['source'] = c.source(self.root)
        for update in ({'live_failures': []}, {'running': True}, {'resume_phase': 'quick'}, {'pending': ['unresolved']}):
            state = {**copy.deepcopy(original), **update}
            before = copy.deepcopy(state)
            with self.assertRaisesRegex(ValueError, 'repair boundary|adjudicate pending'):
                c.refresh(state, old, new, self.root)
            self.assertEqual(before, state)
        c.refresh(self.state, old, new, self.root)
        self.assertEqual(new['source'], self.state['source'])
        self.assertEqual('quick', self.state['phase'])
        self.assertFalse(self.state['ready'])
        for key in ('attempts', 'failures', 'round'):
            self.assertEqual(original[key], self.state[key])

    def failure(self):
        self.state['phase'] = 'initial'
        c.advance(self.state, [self.result(a='FAIL', b='PASS'), self.result('ui', c='PASS')])
        return self.state['failures'][-1]

    def report(self, failure, attribution='INTRODUCED', **fields):
        return {'failures': [{'id': failure['id'], 'check': failure['check'],
                'source': failure['source'], 'description': 'real failure', 'evidence': 'RCA evidence',
                'native_result': failure['native_result'], 'command': failure.get('command'), 'attribution': attribution, **fields}]}

    def triage_quick_fixture(self):
        import contextlib, io
        (self.root / 'back-end').mkdir()
        (self.root / 'scripts').mkdir()
        (self.root / 'scripts/check_deploy_static.py').write_text(
            "from pathlib import Path\nimport sys\np=Path('.context/observed');p.parent.mkdir(exist_ok=True)\n"
            "with p.open('a') as f:f.write(sys.argv[1]+'\\n')\n")
        bins = self.root / '.context/bin'; bins.mkdir(parents=True)
        for name in ('npm', 'npx'):
            p = bins / name
            p.write_text('#!' + sys.executable + '\nfrom pathlib import Path\nimport sys\n'
                "p=Path('../.context/observed')\nwith p.open('a') as f:f.write(Path(sys.argv[0]).name+'\\n')\n"
                "raise SystemExit(1 if Path('../.context/fail').exists() and Path(sys.argv[0]).name=='npm' else 0)\n")
            p.chmod(0o700)
        self.plan['gates'] = [g for g in self.plan['gates'] if not g.get('quick')] + [
            dict(name=n, category=n, quick=True, checks=[n], cwd='.',
                 command=[sys.executable, 'scripts/check_deploy_static.py', m])
            for n, m in [('eslint', 'lint'), ('format', 'format')]] + [
            dict(name='typescript', category='typescript', quick=True, checks=['typescript'], cwd='back-end',
                 command=['bash', '-c', 'mkdir -p ../.context/tsbuildinfo && npx tsc --noEmit --incremental '
                          '--tsBuildInfoFile ../.context/tsbuildinfo/back-end.tsbuildinfo']),
            dict(name='backend-structural', category='backend-structural', quick=True,
                 checks=['backend-structural'], cwd='back-end', command=['npm', 'run', 'test:structural'])]
        self.plan['source'] = c.source(self.root)
        self.state = c.initialize(self.plan, self.root); self.failure()
        receipt = self.state['attempts'][-1]['results'][0]
        receipt.update(complete=False, cleanup_owner=dict(request_token='old', worker_root='old-root',
            native_cleanup_reference=dict(cleanup_complete=False)))
        self.state['failures'][-1].update(native_result='UNVERIFIED', complete=False)
        self.state['resource_warnings'] = [dict(original='preserve financial/runtime obligations')]
        (self.root / 'code').write_text('new source requiring quick observation')
        new = copy.deepcopy(self.plan); new['source'] = c.source(self.root)
        plan = self.root / '.context/new-plan.json'; c.write(plan, new)
        state = self.directory / 'cycle.json'; c.write(state, self.state)
        argv = ['triage-quick', '--plan', str(plan), '--state-dir', str(self.directory), '--root', str(self.root)]
        def call():
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                return c.main(argv)
        return new, plan, state, bins, call

    def test_triage_quick_cli_preserves_pending_source_and_native_owner(self):
        with patch.dict(os.environ, PATH=str(self.root / '.context/bin') + os.pathsep + os.environ['PATH']):
            new, plan, path, bins, call = self.triage_quick_fixture()
            before = c.read(path)
            self.assertEqual(0, call())
            after = c.read(path); observations = after['attempts'].pop()
            self.assertEqual(before, after)
            self.assertEqual(new['source'], observations['source'])
            self.assertEqual({'eslint','format','typescript','backend-structural'},
                             {r['gate'] for r in observations['results']})
            self.assertTrue(all(r['executed'] and r['complete'] and r['native_exit'] == 0 for r in observations['results']))
            self.assertEqual(['api'], c.retained_owners(after, ['api']))
            self.assertEqual('triage', after['phase']); self.assertFalse(after['ready'])
            self.assertEqual(4, len((self.root / '.context/observed').read_text().splitlines()))

    def test_triage_quick_rejects_substitution_inventory_and_active_owner(self):
        with patch.dict(os.environ, PATH=str(self.root / '.context/bin') + os.pathsep + os.environ['PATH']):
            new, plan, path, bins, call = self.triage_quick_fixture(); original = path.read_bytes()
            variants = []
            for mode in ('command', 'category', 'drop'):
                value = copy.deepcopy(new)
                gate = next(g for g in value['gates'] if g['name'] == 'eslint')
                if mode == 'command': gate['command'] = ['bash', '-c', 'echo unsafe']
                elif mode == 'category': gate['category'] = 'smoke'
                else: value['gates'] = [g for g in value['gates'] if g['name'] != 'api']
                variants.append(value)
            for value in variants:
                c.write(plan, value); self.assertEqual(2, call()); self.assertEqual(original, path.read_bytes())
            c.write(plan, new)
            with c.exclusive(self.directory): self.assertEqual(2, call())
            self.assertEqual(original, path.read_bytes())
            orphan = self.directory / 'triage-quick/orphan'; orphan.mkdir(parents=True)
            self.assertEqual(2, call()); self.assertEqual(original, path.read_bytes()); orphan.rmdir()
            value = c.read(path); value['attempts'][-1]['results'].append(dict(gate='eslint', lingering_group=True))
            c.write(path, value); owned = path.read_bytes()
            self.assertEqual(2, call()); self.assertEqual(owned, path.read_bytes())
            self.assertFalse((self.root / '.context/observed').exists())

    def test_triage_quick_failure_and_changed_pending_do_not_commit(self):
        with patch.dict(os.environ, PATH=str(self.root / '.context/bin') + os.pathsep + os.environ['PATH']):
            new, plan, path, bins, call = self.triage_quick_fixture(); original = path.read_bytes()
            (self.root / '.context/fail').touch()
            self.assertEqual(2, call()); self.assertEqual(original, path.read_bytes())
            summaries = list((self.directory / 'triage-quick').glob('*/summary.json'))
            self.assertEqual(1, len(summaries)); self.assertEqual(4, len(c.read(summaries[0])['results']))
            self.assertTrue(any(r['native_exit'] == 1 for r in c.read(summaries[0])['results']))
            (self.root / '.context/fail').unlink()
            execute = c.execute
            def changed(gate, *args):
                result = execute(gate, *args)
                if gate['name'] == 'backend-structural':
                    value = c.read(path); value['pending'].append('concurrent-change'); c.write(path, value)
                return result
            with patch.object(c, 'execute', side_effect=changed): self.assertEqual(2, call())
            after = c.read(path)
            self.assertEqual(['concurrent-change'], after['pending'][len(self.state['pending']):])
            self.assertEqual(self.state['attempts'], after['attempts'])
            self.assertEqual('triage', after['phase']); self.assertFalse(after['ready'])

    def carryover_ready_fixture(self, scoped=False):
        if scoped:
            for path in ('backend.txt', 'frontend.txt'):
                (self.root / path).write_text('original')
            self.plan['gates'][1]['input_paths'] = ['backend.txt']
            self.plan['gates'][2]['input_paths'] = ['frontend.txt']
            self.plan['source'] = c.source(self.root)
            self.state = c.initialize(self.plan, self.root)
        c.run_phase(self.plan, self.state, self.directory, self.root)
        c.run_phase(self.plan, self.state, self.directory, self.root)
        self.assertTrue(self.state['ready'])
        return copy.deepcopy(self.plan), copy.deepcopy(self.state['attempts'])

    def test_history_only_sync_preserves_full_pass_native_source_and_revalidates_files(self):
        old, native = self.carryover_ready_fixture()
        native_paths = [Path(r['log']).parent / 'receipt.json' for r in native[-1]['results']]
        original = {str(p): p.read_bytes() for p in native_paths}
        for index in range(2):
            subprocess.run(['git', '-c', 'user.name=test', '-c', 'user.email=test@example.com',
                            'commit', '--allow-empty', '-qm', 'history-only sync'], cwd=self.root, check=True)
            new = copy.deepcopy(old); new['source'] = c.source(self.root)
            c.refresh(self.state, old, new, self.root)
            self.assertEqual({'api', 'ui'}, set(self.state['carried_passes']))
            c.run_phase(new, self.state, self.directory, self.root)
            self.assertEqual('final', self.state['phase'])
            self.assertEqual([], c.records(new, self.state))
            c.run_phase(new, self.state, self.directory, self.root)
            self.assertEqual(0, c.verify_saved(self.directory, self.root))
            old = new
        self.assertEqual(2, len(self.state['pass_carryover_history']))
        self.assertEqual(native, self.state['attempts'][:len(native)])
        self.assertEqual(original, {str(p): p.read_bytes() for p in native_paths})
        native_paths[0].write_bytes(native_paths[0].read_bytes()+b' ')
        self.assertEqual(5, c.verify_saved(self.directory, self.root))

    def repair_set_refresh_fixture(self):
        # Real request/receipt/result files: api is a healthy historical repair,
        # while a newer ui execution fails only c. Both gates have broad inputs.
        marker = self.root / '.context/fail-ui'
        worker = ("import json,os,sys;from pathlib import Path;"
            "r=json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text());"
            "bad=Path(" + repr(str(marker)) + ").exists();"
            "cases={k:('FAIL' if bad and k=='c' else 'PASS') for k in r['checks']};"
            "v={k:r[k] for k in ('token','source','gate')};"
            "v.update(cases=cases,complete=True,cleanup_complete=True,reused=False);"
            "Path(os.environ['DEPLOY_GATE_RESULT']).write_text(json.dumps(v));"
            "sys.exit(int('FAIL' in cases.values()))")
        ui = self.plan['gates'][2]
        ui.update(command=[sys.executable, '-c', worker], checks=['c', 'd'], case_protocol=True)
        self.state = c.initialize(self.plan, self.root)
        old, _ = self.carryover_ready_fixture()
        self.state.update(phase='final', ready=False, repair_gates=['api', 'ui'])
        self.state['round'] += 1
        marker.touch()
        failed = c.execute(ui, self.state, self.directory, self.root)
        c.advance(self.state, [failed])
        self.assertEqual({'c': 'FAIL', 'd': 'PASS'}, failed['cases'])
        self.assertTrue(failed['complete'])
        return old, marker

    def changed_fixture_plan(self, old):
        for name in ('first-fixture.test.py', 'second-fixture.test.py'):
            (self.root / name).write_text('unrelated fixture repair\n')
        new = copy.deepcopy(old)
        new['source'] = c.source(self.root)
        return new

    def test_refresh_healthy_old_full_pass_leaves_focused_but_requires_new_final_full(self):
        old, marker = self.repair_set_refresh_fixture()
        attempts = copy.deepcopy(self.state['attempts'])
        failures = copy.deepcopy(self.state['failures'])
        native = {r['gate']: (Path(r['log']).parent/'receipt.json').read_bytes()
                  for r in attempts[1]['results']}
        fingerprints = dict(self.state['input_fingerprints'])
        round_before = self.state['round']
        new = self.changed_fixture_plan(old)
        c.refresh(self.state, old, new, self.root)
        self.assertEqual(['ui'], self.state['repair_gates'])
        self.assertEqual({}, self.state['carried_passes'])
        self.assertNotEqual(fingerprints['api'], self.state['input_fingerprints']['api'])
        self.assertEqual(attempts, self.state['attempts'])
        self.assertEqual(failures, self.state['failures'])
        self.assertEqual(round_before, self.state['round'])
        self.assertEqual(old['gates'], new['gates'])
        c.run_phase(new, self.state, self.directory, self.root)  # mandatory fresh quick
        failure = next(f for f in self.state['failures'] if f['id'] in self.state['pending'])
        c.adjudicate(self.state, self.report(failure, 'INTRODUCED'))
        c.focused_plan(self.state, new, {'source': new['source'], 'gates': {
            'ui': {'command': new['gates'][2]['command'], 'checks': ['c']}}})
        self.assertEqual(['ui'], [g['name'] for g in c.records(new, self.state)])
        marker.unlink()
        c.run_phase(new, self.state, self.directory, self.root)
        self.assertEqual('failed-gates', self.state['phase'])
        self.assertEqual(['c', 'd'], c.records(new, self.state)[0]['checks'])
        c.run_phase(new, self.state, self.directory, self.root)  # full failed ui
        c.run_phase(new, self.state, self.directory, self.root)  # repeat quick
        self.assertEqual('final', self.state['phase'])
        self.assertEqual(['api'], [g['name'] for g in c.records(new, self.state)])
        c.write(self.directory/'cycle.json', self.state)
        self.assertEqual(1, c.verify_saved(self.directory, self.root))
        self.assertEqual(old['source'], c.latest_receipts(self.state)['api']['source'])
        c.run_phase(new, self.state, self.directory, self.root)  # genuine new api full
        self.assertEqual(0, c.verify_saved(self.directory, self.root))
        self.assertEqual(new['source'], c.latest_receipts(self.state)['api']['source'])
        self.assertEqual(attempts, self.state['attempts'][:len(attempts)])
        for receipt in attempts[1]['results']:
            self.assertEqual(native[receipt['gate']], (Path(receipt['log']).parent/'receipt.json').read_bytes())

    def test_refresh_repair_retirement_refuses_latest_failure_partial_pending_and_bad_bindings(self):
        old, _ = self.repair_set_refresh_fixture()
        original = copy.deepcopy(self.state)
        receipt = c.latest_receipts(self.state)['api']
        receipt_path = Path(receipt['log']).parent/'receipt.json'
        request_path = receipt_path.parent/'request.json'
        original_receipt, original_request = receipt_path.read_bytes(), request_path.read_bytes()
        new = self.changed_fixture_plan(old)
        for mode in ('failed', 'unverified', 'partial', 'pending', 'owner', 'stale',
                     'receipt', 'request', 'source', 'contract', 'environment'):
            with self.subTest(mode=mode):
                self.state = copy.deepcopy(original)
                receipt_path.write_bytes(original_receipt); request_path.write_bytes(original_request)
                latest = c.latest_receipts(self.state)['api']
                candidate = copy.deepcopy(new)
                if mode in ('failed', 'unverified', 'partial'):
                    replacement = copy.deepcopy(latest)
                    replacement.update(status='FAIL' if mode != 'partial' else 'PASS',
                        complete=mode != 'unverified', native_exit=1 if mode == 'failed' else 0,
                        cases={'a': 'FAIL', 'b': 'PASS'} if mode == 'failed' else
                              {'a': 'UNVERIFIED', 'b': 'PASS'} if mode == 'unverified' else {'a': 'PASS'})
                    self.state['attempts'].append({'phase': 'focused', 'results': [replacement]})
                elif mode == 'pending':
                    self.state['failures'].append(dict(id='pending-api', gate='api', check='api/a'))
                    self.state['pending'].append('pending-api')
                elif mode == 'owner':
                    latest.update(lingering_group=True, cleanup_owner={'request_token': latest['token']})
                    c.write(receipt_path, latest)
                elif mode == 'stale':
                    self.state['attempts'][1]['stale'] = True
                elif mode in ('receipt', 'request'):
                    path = receipt_path if mode == 'receipt' else request_path
                    value = c.read(path); value['token'] = 'wrong-native-token'; c.write(path, value)
                elif mode == 'source':
                    latest['source'] = {'head': 'foreign', 'digest': 'foreign'}
                    value = c.read(request_path); value['source'] = latest['source']
                    c.write(request_path, value); c.write(receipt_path, latest)
                elif mode == 'contract':
                    candidate['gates'][1]['checks'].append('new-check')
                environment = c.environment_digest()
                with patch.object(c, 'environment_digest', return_value='changed-environment' if mode == 'environment' else environment):
                    c.refresh(self.state, old, candidate, self.root)
                self.assertEqual(['api', 'ui'], self.state['repair_gates'])
                self.assertEqual({}, self.state['carried_passes'])
        receipt_path.write_bytes(original_receipt); request_path.write_bytes(original_request)

    def test_refresh_qualified_full_retirement_preserves_new_source_renewals_and_native_debt(self):
        gate, _, _ = self.qualified_full_fixture()
        old = copy.deepcopy(self.plan)
        attempts = copy.deepcopy(self.state['attempts'])
        native = copy.deepcopy(c.latest_receipts(self.state)['smoke'])
        new = self.changed_fixture_plan(old)
        c.refresh(self.state, old, new, self.root)
        self.assertNotIn('smoke', self.state['repair_gates'])
        self.assertEqual({}, self.state['carried_passes'])
        self.assertEqual({}, self.state['skips'])
        self.assertEqual(3, len(self.state['pending']))
        self.assertTrue(all(f['native_result'] == 'prior waived failure; changed inputs'
                            for f in self.state['failures'] if f['id'] in self.state['pending']))
        self.assertEqual(attempts, self.state['attempts'])
        self.assertEqual(native, c.latest_receipts(self.state)['smoke'])
        final = {**self.state, 'phase': 'final'}
        self.assertIn('smoke', [g['name'] for g in c.records(new, final)])

    def test_refresh_repair_retirement_refuses_bad_qualification_and_worker_result(self):
        gate, _, _ = self.qualified_full_fixture()
        old = copy.deepcopy(self.plan); original = copy.deepcopy(self.state)
        result_path = Path(c.latest_receipts(self.state)['smoke']['worker_result'])
        saved = result_path.read_bytes()
        new = self.changed_fixture_plan(old)
        for mode in ('qualification', 'worker-result', 'triage-routing'):
            with self.subTest(mode=mode):
                self.state = copy.deepcopy(original); result_path.write_bytes(saved)
                if mode == 'qualification':
                    self.state['skips']['smoke/mail-one']['rca']['external_provider']['reason'] = 'auth error'
                elif mode == 'worker-result':
                    value = c.read(result_path); value['cleanup_complete'] = False; c.write(result_path, value)
                else:
                    self.state['triage_repair_gates'] = ['smoke']
                c.refresh(self.state, old, new, self.root)
                self.assertIn('smoke', self.state['repair_gates'])
                self.assertEqual({}, self.state['carried_passes'])
        result_path.write_bytes(saved)

    def test_refresh_nonquick_retirement_does_not_invent_quick_pass_binding(self):
        old, _ = self.carryover_ready_fixture()
        self.state['repair_gates'] = ['format']
        new = self.changed_fixture_plan(old)
        c.refresh(self.state, old, new, self.root)
        self.assertEqual(['format'], self.state['repair_gates'])
        self.assertEqual('quick', self.state['phase'])
        self.assertEqual({}, self.state['carried_passes'])

    def test_scoped_change_preserves_only_unaffected_full_gate_and_never_newer_failure(self):
        old, native = self.carryover_ready_fixture(scoped=True)
        (self.root / 'backend.txt').write_text('actual backend change')
        new = copy.deepcopy(old); new['source'] = c.source(self.root)
        c.refresh(self.state, old, new, self.root)
        self.assertEqual({'ui'}, set(self.state['carried_passes']))
        self.state['phase'] = 'final'
        self.assertEqual(['api'], [g['name'] for g in c.records(new, self.state)])
        # A new failure/retained owner always supersedes the old native PASS.
        self.state['attempts'].append(dict(phase='final', results=[dict(gate='ui', status='FAIL',
            complete=False, cases={'c':'UNVERIFIED'}, cleanup_owner={'request_token':'new-owner'}, lingering_group=True)]))
        self.assertEqual({'api','ui'}, {g['name'] for g in c.records(new, self.state)})
        self.assertEqual(['ui'], c.retained_owners(self.state, ['ui']))
        self.assertEqual(native, self.state['attempts'][:len(native)])

    def test_unknown_default_scope_reruns_both_gates_after_any_source_change(self):
        old, native = self.carryover_ready_fixture()
        (self.root / 'code').write_text('unknown ownership of this change')
        new = copy.deepcopy(old); new['source'] = c.source(self.root)
        c.refresh(self.state, old, new, self.root)
        self.assertEqual({}, self.state['carried_passes'])
        self.state['phase'] = 'final'
        self.assertEqual({'api','ui'}, {g['name'] for g in c.records(new, self.state)})

    def test_same_source_full_pass_skips_duplicate_final_but_focused_subset_never_does(self):
        old, native = self.carryover_ready_fixture()
        self.state.update(phase='focused', ready=False, repair_gates=['api', 'ui'], focused={
            g['name']: {'command': g['command'], 'checks': g['checks']} for g in old['gates'] if not g.get('quick')})
        self.assertEqual([], c.records(old, self.state))  # historical repair labels cannot repeat healthy FULL gates
        self.state.update(phase='final', ready=False)
        self.assertEqual([], c.records(old, self.state))
        # An exact FULL focused recipe is eligible; a genuine narrowed case set is not.
        self.state['attempts'][-1]['phase'] = 'focused'
        self.assertEqual([], c.records(old, self.state))
        api = next(r for r in self.state['attempts'][-1]['results'] if r['gate']=='api')
        saved = copy.deepcopy(api['cases']); api['cases'] = {'a':'PASS'}
        self.assertEqual(['api'], [g['name'] for g in c.records(old, self.state)])
        api['cases'] = saved
        self.state['attempts'][-1]['phase'] = 'final'
        api['execution_binding']['contract_digest'] = 'changed recipe'
        self.assertEqual(['api'], [g['name'] for g in c.records(old, self.state)])

    def test_same_source_reuse_pins_native_receipt_and_request_for_final_verification(self):
        script = ("import json,os;from pathlib import Path;"
            "r=json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text());"
            "v={k:r[k] for k in ('token','source','gate')};"
            "v.update(cases=dict.fromkeys(r['checks'],'PASS'),complete=True,cleanup_complete=True,reused=False);"
            "Path(os.environ['DEPLOY_GATE_RESULT']).write_text(json.dumps(v))")
        self.plan['gates'][1].update(command=[sys.executable, '-c', script], case_protocol=True)
        self.state = c.initialize(self.plan, self.root)
        old, native = self.carryover_ready_fixture()
        self.state.update(phase='final', ready=False)
        c.run_phase(old, self.state, self.directory, self.root)
        self.assertEqual(0, c.verify_saved(self.directory, self.root))
        receipt = c.latest_receipts(self.state)['api']
        for path in [Path(receipt['log']).parent/'receipt.json', Path(receipt['log']).parent/'request.json',
                     Path(receipt['worker_result'])]:
            with self.subTest(path=path):
                original = path.read_bytes(); path.write_bytes(original+b' ')
                self.assertEqual(5, c.verify_saved(self.directory, self.root))
                path.write_bytes(original)
        self.assertEqual(0, c.verify_saved(self.directory, self.root))

    def qualified_full_fixture(self, resource=False):
        worker = self.root / 'scripts/deploy_test_cloud.py'; worker.parent.mkdir()
        worker.write_text("import json,os;from pathlib import Path;"
            "r=json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text());"
            "p=Path('.context/native-launches');p.write_text(p.read_text()+'run\\n' if p.exists() else 'run\\n');"
            "v={k:r[k] for k in ('token','source','gate')};"
            "v.update(cases=dict.fromkeys(r['checks'],'PASS'),complete=True,cleanup_complete=True,reused=False);"
            "Path(os.environ['DEPLOY_GATE_RESULT']).write_text(json.dumps(v))")
        self.plan['source'] = c.source(self.root)
        self.state = c.initialize(self.plan, self.root)
        proof, evidence = self.standing_claude_fixture()
        gate = self.plan['gates'][-1]
        gate['checks'] = ['passed-' + str(i) for i in range(14)] + ['mail-one', 'mail-two', 'claude-code-agent']
        self.state = c.initialize(self.plan, self.root)
        c.standing_skip(self.state, proof, self.root)
        for name in ('mail-one', 'mail-two'):
            self.state['skips']['smoke/' + name] = dict(source=self.state['source'],
                input_fingerprint=self.state['input_fingerprints']['smoke'], disposition='external / waived',
                rca=dict(id=name, native_result='FAIL', attribution='NOT_INTRODUCED', description='Exact historical mail operation',
                    evidence='original-mail-receipt', external_provider=dict(name='Primitive',reason='outage')))
        if resource:
            native = self.root / '.context/compute-skip.json'
            row = self.skipped_row()['native_task']; row['name'] = 'passed-0'
            c.write(native,dict(tasks=[row]))
            confirmation=self.confirmation(receipt_sha256=c.sha_file(native))
            failure=dict(id='native-compute-skip',gate='smoke',check='smoke/passed-0',
                source=self.state['source'],native_result='FAIL',complete=True,finished_at=1000.0,
                worker_evidence=dict(native_task=row,path=str(native),sha256=c.sha_file(native)))
            failure['rca']=dict(id=failure['id'],attribution='NOT_INTRODUCED',native_result='FAIL',
                description='Native compute quota skip',evidence=str(native),resource_skip=confirmation)
            self.state['failures'].append(failure)
            self.state['resource_warnings']=[dict(id=failure['id'],check=failure['check'],gate='smoke',
                native_result='FAIL',native_row=row,receipt_sha256=c.sha_file(native),confirmation=confirmation,
                source=self.state['source'],input_fingerprint=self.state['input_fingerprints']['smoke'])]
        self.state.update(phase='needs-focused-plan', repair_gates=['smoke'])
        c.focused_plan(self.state, self.plan, dict(source=self.state['source'], gates={
            'smoke':dict(command=gate['command'],checks=gate['checks'])}))
        c.run_phase(self.plan,self.state,self.directory,self.root)
        return gate, proof, evidence

    def test_qualified_full_coverage_runs_once_and_revalidates_after_repeated_sync(self):
        gate, proof, evidence = self.qualified_full_fixture()
        native = copy.deepcopy(c.latest_receipts(self.state)['smoke'])
        self.assertEqual((14,3), (list(native['cases'].values()).count('PASS'),list(native['cases'].values()).count('SKIP')))
        for phase in ('failed-gates', 'quick', 'final'):
            self.assertEqual(phase,self.state['phase'])
            c.run_phase(self.plan,self.state,self.directory,self.root)
        self.assertEqual(['run'], (self.root/'.context/native-launches').read_text().splitlines())
        self.assertEqual(0,c.verify_saved(self.directory,self.root))
        for index in range(2):
            subprocess.run(['git','-c','user.name=test','-c','user.email=test@example.com',
                'commit','--allow-empty','-qm','history-only sync'],cwd=self.root,check=True)
            new=copy.deepcopy(self.plan);new['source']=c.source(self.root)
            c.refresh(self.state,self.plan,new,self.root);self.plan=new
            for phase in ('quick','final'):
                self.assertEqual(phase,self.state['phase']);c.run_phase(new,self.state,self.directory,self.root)
            self.assertEqual(0,c.verify_saved(self.directory,self.root))
            self.assertEqual(native,c.latest_receipts(self.state)['smoke'])
        self.assertEqual(['run'], (self.root/'.context/native-launches').read_text().splitlines())
        (evidence/'run.json').write_bytes((evidence/'run.json').read_bytes()+b' ')
        self.assertNotEqual(0,c.verify_saved(self.directory,self.root))

    def test_qualified_full_reuse_refuses_changed_qualification_contract_owner_or_native_bytes(self):
        gate, proof, evidence = self.qualified_full_fixture()
        self.assertTrue(c.full_pass_binding(self.state,gate))
        for mode in ('removed','changed','incomplete','owner','contract','newer-failure'):
            with self.subTest(mode=mode):
                candidate=copy.deepcopy(self.state);receipt=c.latest_receipts(candidate)['smoke']
                if mode=='removed':candidate['skips'].pop('smoke/mail-one')
                elif mode=='changed':candidate['skips']['smoke/mail-one']['rca']['description']='different obligation'
                elif mode=='incomplete':receipt['complete']=False
                elif mode=='owner':receipt['cleanup_owner']={'request_token':'retained'}
                elif mode=='contract':receipt['execution_binding']['contract_digest']='different full recipe'
                else:candidate['attempts'].append(dict(phase='final',results=[dict(gate='smoke',status='FAIL')]))
                self.assertIsNone(c.full_pass_binding(candidate,gate))
        self.state.update(phase='final',ready=False)
        c.run_phase(self.plan,self.state,self.directory,self.root)
        self.assertEqual(0,c.verify_saved(self.directory,self.root))
        receipt=c.latest_receipts(self.state)['smoke'];folder=Path(receipt['log']).parent
        for path in (folder/'receipt.json',folder/'request.json',Path(receipt['worker_result'])):
            with self.subTest(path=path):
                original=path.read_bytes();path.write_bytes(original+b' ')
                self.assertNotEqual(0,c.verify_saved(self.directory,self.root));path.write_bytes(original)

    def test_qualified_resource_reuse_replays_original_row_confirmation_and_bytes(self):
        gate, proof, evidence=self.qualified_full_fixture(resource=True)
        original=copy.deepcopy(self.state['failures'])
        self.assertTrue(c.full_pass_binding(self.state,gate))
        self.state.update(phase='final',ready=False)
        c.run_phase(self.plan,self.state,self.directory,self.root)
        self.assertEqual(0,c.verify_saved(self.directory,self.root))
        self.assertEqual(original,self.state['failures'])
        warning=self.state['resource_warnings'][0]
        self.assertEqual('SKIP',c.latest_receipts(self.state)['smoke']['cases']['passed-0'])
        native=Path(self.state['failures'][0]['worker_evidence']['path'])
        native.write_bytes(native.read_bytes()+b' ')
        self.assertNotEqual(0,c.verify_saved(self.directory,self.root))

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
        self.assertEqual({'ui'}, {r['gate'] for r in self.state['attempts'][-1]['results']})
        self.assertEqual({'a':'PASS', 'b':'PASS'}, c.latest_receipts(self.state)['api']['cases'])
        self.assertTrue(c.full_pass_binding(self.state, new['gates'][1]))
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

    def test_recipe_worker_root_does_not_eagerly_require_cwd(self):
        script=("import json,os,hashlib;from pathlib import Path;"
            "r=json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text());"
            "v={k:r[k] for k in ('token','source','gate')};"
            "v.update(cases=dict.fromkeys(r['checks'],'PASS'),complete=True,cleanup_complete=True,reused=False,"
            "worker_root=r['worker_root'],recipe_digest=hashlib.sha256(json.dumps(r['worker_recipe'],sort_keys=True,separators=(',',':')).encode()).hexdigest());"
            "Path(os.environ['DEPLOY_GATE_RESULT']).write_text(json.dumps(v))")
        for index, explicit in enumerate((True,False)):
            with self.subTest(explicit=explicit):
                gate=dict(name='recipe-'+str(index),checks=['one'],command=[sys.executable,'-c',script],case_protocol=True,
                    worker_recipe={'cases':{'one':{'command':['true']}}})
                if explicit:gate['worker_root']='/private/prepared-worker'
                result=c.execute(gate,self.state,self.directory,self.root)
                request=c.read(Path(result['log']).parent/'request.json')
                self.assertEqual(gate.get('worker_root',str(self.root.resolve())),request['worker_root'])
                self.assertEqual({'one':'PASS'},result['cases']);self.assertTrue(result['complete'])

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

    def treasury_failure(self, peer='PASS'):
        self.plan['gates'][1].update(name='backend-coverage-blackbox', checks=['blackbox:treasury-rails','blackbox:independent'],case_protocol=True)
        self.state=c.initialize(self.plan,self.root)
        self.state['phase']='initial'
        c.advance(self.state,[self.result('backend-coverage-blackbox',**{'blackbox:treasury-rails':'FAIL','blackbox:independent':peer})])
        failure=next(f for f in self.state['failures'] if f['check'].endswith('/blackbox:treasury-rails'))
        failure['finished_at']=100
        policy=dict(name='treasury-failures-skip-and-warn-2026-10-29',reason='thirteen prior mint observations overdue',
                    affected_records=['card-'+str(i) for i in range(13)],evidence_at=200)
        return failure,self.report(failure,'UNKNOWN',standing_policy=policy)

    def test_standing_treasury_unknown_failure_warns_without_pass_or_provider_claim(self):
        from deploy_failure_report import render
        failure,report=self.treasury_failure();original=copy.deepcopy(self.state['attempts'])
        c.adjudicate(self.state,report)
        self.assertTrue(self.state['ready'])
        self.assertEqual(original,self.state['attempts'])
        self.assertEqual('FAIL',failure['native_result']);self.assertEqual('UNKNOWN',failure['rca']['attribution'])
        qualified=c.reuse_qualifications(self.state,self.plan['gates'][1])
        self.assertEqual({'blackbox:treasury-rails'},set(qualified))
        text=render({'failures':[{**failure['rca'],'disposition':failure['disposition']}]})
        self.assertIn('⚠️ Skipped',text);self.assertIn('native FAIL retained',text)
        for i in range(13):self.assertIn('card-'+str(i),text)
        self.assertNotIn('EXTERNAL PROVIDER',text);self.assertNotIn('PASS',text)
        failure['rca']['standing_policy']['name']='other-policy'
        with self.assertRaises(ValueError):c.reuse_qualifications(self.state,self.plan['gates'][1])

    def test_standing_treasury_refuses_unverified_malformed_or_mixed_reports_atomically(self):
        failure,report=self.treasury_failure();original=copy.deepcopy(self.state)
        changes=[('check','backend-coverage-blackbox/blackbox:independent'),('native_result','UNVERIFIED'),
                 ('external_provider',{'name':'provider','reason':'outage'}),('repair_agent','https://boxes.dev/thread/repair'),
                 ('assigned_repair',True),('resource_skip',{}),('post_merge',{}),('prior_waiver',{})]
        for key,value in changes:
            bad=copy.deepcopy(report);bad['failures'][0][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):c.adjudicate(self.state,bad)
            self.assertEqual(original,self.state)
        for policy in [None,{}, {'name':'unknown'}, {**report['failures'][0]['standing_policy'],'evidence_at':False},
                       {**report['failures'][0]['standing_policy'],'affected_records':'card'},
                       {**report['failures'][0]['standing_policy'],'evidence_at':float('nan')}]:
            bad=copy.deepcopy(report);bad['failures'][0]['standing_policy']=policy
            with self.assertRaises(ValueError):c.adjudicate(self.state,bad)
            self.assertEqual(original,self.state)
        failure['complete']=False
        with self.assertRaises(ValueError):c.adjudicate(self.state,report)
        from deploy_failure_report import decision
        for field,value in [('check','backend-coverage-blackbox/blackbox:independent'),('native_result','UNVERIFIED')]:
            bad=copy.deepcopy(report['failures'][0]);bad[field]=value
            with self.assertRaises(ValueError):decision(bad)

    def test_standing_treasury_never_hides_independent_unknown_failure(self):
        failure,report=self.treasury_failure(peer='FAIL')
        other=next(f for f in self.state['failures'] if f is not failure)
        report['failures'].append(self.report(other,'UNKNOWN')['failures'][0])
        before=copy.deepcopy(self.state)
        with self.assertRaisesRegex(ValueError,'UNKNOWN'):c.adjudicate(self.state,report)
        self.assertEqual(before,self.state)

    def test_standing_treasury_existing_source_renewal_retains_original_fail_without_rerun(self):
        from deploy_failure_report import render
        failure,report=self.treasury_failure();native=copy.deepcopy(self.state['attempts'])
        c.adjudicate(self.state,report)
        old=copy.deepcopy(self.plan)
        (self.root/'code').write_text('new source repair')
        new=copy.deepcopy(old);new['source']=c.source(self.root)
        c.refresh(self.state,old,new,self.root)
        renewal=next(f for f in self.state['failures'] if f['id'] in self.state['pending'])
        self.assertEqual('prior waived failure; changed inputs',renewal['native_result'])
        c.advance(self.state,[self.result('static',lint='PASS')])
        after_quick=copy.deepcopy(self.state['attempts'])
        renewed=self.report(renewal,'UNKNOWN',standing_policy=copy.deepcopy(report['failures'][0]['standing_policy']),
                            prior_waiver=copy.deepcopy(renewal['prior_waiver']))
        before=copy.deepcopy(self.state)
        bad=copy.deepcopy(renewed);bad['failures'][0]['prior_waiver']['rca']['source']={}
        with self.assertRaises(ValueError):c.adjudicate(self.state,bad)
        self.assertEqual(before,self.state)
        c.adjudicate(self.state,renewed)
        self.assertNotIn('pending',self.state)
        self.assertEqual(after_quick,self.state['attempts'])
        self.assertEqual(native,self.state['attempts'][:len(native)])
        self.assertEqual('FAIL',failure['native_result']);self.assertEqual(old['source'],failure['source'])
        self.assertEqual({'blackbox:treasury-rails'},set(c.reuse_qualifications(self.state,new['gates'][1])))
        self.assertIn('native FAIL retained',render({'failures':[{**renewed['failures'][0],'disposition':renewal['disposition']}]}))

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

    def test_post_merge_packet_identity_mismatch_is_atomic(self):
        failure = self.failure()
        before = copy.deepcopy(self.state)
        packet = {"test": failure["check"], "command": failure["command"],
                  "scope": "api/a", "error": "AssertionError: boom",
                  "source": copy.deepcopy(failure["source"]), "evidence": ["original.log"]}
        for field, value in [("test", "api/b"), ("command", ["false"]),
                             ("source", {**failure["source"], "head": "b" * 40}),
                             ("source", {**failure["source"], "digest": "b" * 64}),
                             ("source", "b" * 40), ("test", True),
                             ("command", "true"), ("source", True)]:
            with self.subTest(field=field, value=value):
                state = copy.deepcopy(before)
                report = self.report(failure, attribution="NOT_INTRODUCED",
                                     post_merge={**packet, field: value})
                with self.assertRaisesRegex(ValueError, "recorded failure"):
                    c.adjudicate(state, report)
                self.assertEqual(before, state)
        c.adjudicate(self.state, self.report(failure, attribution="NOT_INTRODUCED", post_merge=packet))
        self.assertEqual(packet, self.state["pending_post_merge"][0]["packet"])
        self.assertEqual("FAIL", self.state["failures"][0]["native_result"])

    def test_pending_post_merge_qualifies_ready_but_blocks_completion_until_resolved(self):
        failure = self.failure()
        packet = {"test": "api/a", "command": ["true"], "scope": "api/a", "error": "AssertionError: boom",
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
        packet = {"test": "api/a", "command": ["true"], "scope": "api/a", "error": "AssertionError: boom",
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
        self.assertEqual({'a':'PASS', 'b':'PASS'}, c.latest_receipts(self.state)['api']['cases'])
        self.assertTrue(c.full_pass_binding(self.state, gate))
        self.assertNotIn('api', {r['gate'] for r in self.state['attempts'][-1]['results']})

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

    def standing_claude_fixture(self):
        import hashlib, runpy
        template = runpy.run_path(str(ROOT / 'scripts/tests/predeploy-receipts.test.py'))
        summary, bundles, confirmations = template['standing_fixture']()
        bundle = bundles[0]; run, card = bundle['run'], bundle['card']
        summary['tasks'] = ['claude-code-agent']; summary['git_sha'] = self.state['source']['head']
        run['tasks'] = [run['tasks'][7]]; card['per_task'] = [card['per_task'][7]]
        card['source_sha'] = summary['git_sha']; card['tasks'] = dict(total=1, completed=1, running=0, queued=0)
        directory = self.root / '.context/original'; directory.mkdir(parents=True)
        for name, value in [('run.json',run),('report-card.json',card),
            ('local-benchmark-owner.json',dict(token='bench', run_id='original', state='cleanup_verified')),
            ('local-stack-owner.json',dict(token='stack',run_id='original',pid=1234,native_identity='native',birth='birth'))]:
            c.write(directory/name, value)
        (directory/'benchmark-cleanup-bench.status').write_text('version=1\ntoken=bench\nstate=clean\n')
        (directory/'local-stack-cleanup.status').write_text('version=2\nstate=clean\ntoken=stack\nstack_pid=1234\nstack_native_identity=native\nstack_birth=birth\n')
        sha = c.sha_file(directory/'run.json'); confirmations = [confirmations[0]]; confirmations[0]['receipt_sha256'] = sha
        bindings = [dict(run_id='original', plan_run_id='plan', receipt_sha256=sha,
            card_sha256=c.sha_file(directory/'report-card.json'),planned_source_sha=summary['git_sha'])]
        proof = dict(source=self.state['source'],gate='smoke',run_dir=str(directory))
        for name,value in [('summary',summary),('confirmations',confirmations),('bindings',bindings)]:
            path=self.root/'.context'/(name+'.json');c.write(path,value);proof[name]=str(path)
        self.plan['gates'].append(dict(name='smoke',category='smoke',native_cloud=True,worker='native-cloud',
            worker_transport='benchmark-cloud-cli',command=[sys.executable,str(self.root/'scripts/deploy_test_cloud.py')],
            cwd=str(self.root),checks=['claude-code-agent'],case_protocol=True))
        self.state = c.initialize(self.plan,self.root)
        proof['files'] = {str(p):c.sha_file(p) for p in [*directory.iterdir(),*[Path(proof[k]) for k in ('summary','confirmations','bindings')]]}
        return proof,directory

    def test_prelaunch_native_claude_standing_skip_is_separate_and_hash_bound(self):
        proof,directory = self.standing_claude_fixture(); original=copy.deepcopy(self.state)
        import contextlib,io
        proof_path=self.root/'.context/standing-proof.json';plan_path=self.root/'.context/plan.json'
        c.write(proof_path,proof);c.write(plan_path,self.plan);c.write(self.directory/'cycle.json',self.state)
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(0,c.main(['standing-skip','--proof',str(proof_path),'--plan',str(plan_path),
                '--state-dir',str(self.directory),'--root',str(self.root)]))
        self.state=c.read(self.directory/'cycle.json')
        self.assertEqual(original['attempts'],self.state['attempts']);self.assertEqual(original['failures'],self.state['failures'])
        self.assertFalse(self.state['ready']);self.assertEqual(['smoke/claude-code-agent'],list(self.state['skips']))
        c.revalidate_standing_skips(self.state)
        path=directory/'run.json';path.write_bytes(path.read_bytes()+b' ')
        with self.assertRaises(ValueError):c.revalidate_standing_skips(self.state)
        self.state.update(phase='ready',ready=True);c.write(self.directory/'cycle.json',self.state)
        self.assertNotEqual(0,c.verify_saved(self.directory,self.root))

    def test_prelaunch_native_claude_standing_skip_refuses_unclean_wrong_source_and_nonpolicy(self):
        proof,directory=self.standing_claude_fixture();original=copy.deepcopy(self.state)
        for mode in ('missing','source','dirty','auth-reason','nonclaude','incomplete'):
            with self.subTest(mode=mode):
                trial=copy.deepcopy(proof);saved={p:p.read_bytes() for p in directory.iterdir()}
                try:
                    if mode=='missing':trial['files'].pop(str(directory/'local-stack-owner.json'))
                    elif mode=='source':trial['source']={**trial['source'],'head':'f'*40}
                    elif mode=='dirty':(directory/'local-stack-cleanup.status').write_text('state=failed\n')
                    else:
                        run=c.read(directory/'run.json');row=run['tasks'][0]
                        if mode=='auth-reason':row['failure_reason']='Authentication rejected HTTP403'
                        elif mode=='nonclaude':row['name']='chat-mode'
                        else:row['status']='ACTIVE';row['benchmark_status']='FAILED'
                        c.write(directory/'run.json',run)
                    trial['files']={p:c.sha_file(p) for p in trial['files']}
                    with self.assertRaises(ValueError):c.standing_skip(self.state,trial,self.root)
                    self.assertEqual(original,self.state)
                finally:
                    for path,raw in saved.items():path.write_bytes(raw)

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
        packet = {"test": "api/a", "command": ["true"], "scope": "api/a", "error": "boom",
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

    def campaign_recon_state(self):
        import hashlib
        import shutil
        import time
        from datetime import datetime, timezone
        from cloudbench_execution_provenance import build_config, build_task_matrix
        state, occurrence, paths, proof, hub = self.native_recon_state()
        runs = hub.parent.parent
        request_path = paths['receipt'].parent / 'request.json'
        request = c.read(request_path)
        names = [request['gate'], *['task-' + str(i) for i in range(2, 15)]]
        template = runs / 'parent'
        campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
        campaign.mkdir(parents=True)
        parents, jobs = [], []
        for index, name in enumerate(names, 1):
            fleet = runs / ('20261103-080440-' + str(310000 + index))
            shutil.copytree(template, fleet)
            token = f'{index + 10:032x}'
            audit = fleet / 'teardown-ownership'
            (audit / 'source-audit').unlink()
            meta = (audit / 'meta').read_text().replace('run_id=parent', 'run_id=' + fleet.name)
            meta = meta.replace('fleet_owner_token=' + '1' * 32, 'fleet_owner_token=' + token)
            (audit / 'meta').write_text(meta)
            h = hashlib.sha256()
            for file in sorted(audit.rglob('*'), key=lambda q: str(q.relative_to(audit))):
                if file.is_file():
                    for value in (str(file.relative_to(audit)).encode(), file.read_bytes()):
                        h.update(len(value).to_bytes(8, 'big')); h.update(value)
            canonical = self.root / '.git/cloudbench-fleet-audits' / token
            shutil.copytree(audit, canonical)
            (audit / 'source-audit').write_text(f'path={canonical}\nsha256={h.hexdigest()}\n')
            life = c.read(fleet / '_batch/lifecycle.json')
            life.update(run_id=fleet.name, fleet_owner_token=token, audit_sha256=h.hexdigest())
            c.write(fleet / '_batch/lifecycle.json', life)
            disposable = c.read(fleet / '_batch/disposable-cleanup.json'); disposable['owner'] = token
            c.write(fleet / '_batch/disposable-cleanup.json', disposable)
            (fleet / '_batch/benches.json').write_text(json.dumps([dict(name=name, mode='REAL')]))
            matrix = build_task_matrix([name + '=real'])
            provenance = c.read(fleet / 'execution-provenance.json')
            provenance['config'] = build_config('cloudbench-fleet-config-v1',
                ['task_count=1', 'task_matrix_sha256=' + matrix['sha256']])
            c.write(fleet / 'execution-task-matrix.json', matrix)
            c.write(fleet / 'execution-provenance.json', provenance)
            log = campaign / f'r001-j{index:04d}.log'
            handles = [fleet] + ([runs / 'canary'] if index == 3 else [])
            log.write_text(''.join(f'{self.root}/scripts/run-bench monitor {f}\n' for f in handles))
            jobs.append(dict(job_id=log.stem, task=name, run=1, attempt=1, attempts=[],
                status='failed' if index == 6 else 'cancelled', controller_exit_code=1,
                controller_pid=310000 + index, log=str(log)))
            parents.append(fleet)
        shutil.rmtree(template)
        for f in runs.glob('detached-*'): f.unlink()
        summary = dict(campaign_id=campaign.name, runs=1, retry_infra=0, task_count=14,
            total_jobs=14, concurrency=14, peak_concurrency=14, status='failed', jobs=jobs, wall_clock_seconds=1,
            started_at=datetime.fromtimestamp(1793664472, timezone.utc).isoformat(),
            finished_at=datetime.fromtimestamp(1793664473, timezone.utc).isoformat())
        c.write(campaign / 'summary.json', summary)
        import runpy
        native = runpy.run_path(str(ROOT / 'scripts/run-bench-campaign.py'))
        group = native['campaign_group_record'](summary)
        c.write(campaign / 'hub-group.json', group)
        c.write(campaign / 'hub-group-publication-ack.private.json', dict(pid=2147483000, token='d' * 32,
            record_sha256=hashlib.sha256(json.dumps(group, sort_keys=True).encode()).hexdigest()))
        cli = runs.parent / 'cli.log'; cli.write_text(f'Native campaign {campaign}\n')
        request['checks'] = names; c.write(request_path, request)
        receipt = state['attempts'][-1]['results'][0]
        receipt['cases'] = dict.fromkeys(names, 'UNVERIFIED')
        receipt['case_complete'] = dict.fromkeys(names, False)
        adapter = c.read(paths['adapter']); adapter['cases'] = receipt['cases']; c.write(paths['adapter'], adapter)
        reference = receipt['native_cleanup_reference']
        reference.update(native_directory=str(campaign), result_sha256=c.sha_file(paths['adapter']))
        receipt['cleanup_owner']['native_cleanup_reference'] = reference
        c.write(paths['receipt'], receipt)
        gate = next(g for g in state['plan']['gates'] if g['name'] == occurrence['gate']); gate['checks'] = names
        proof.update(layout='campaign-v1', campaign=str(campaign), owner=copy.deepcopy(receipt['cleanup_owner']),
            receipt_sha256=c.sha_file(paths['receipt']), worker_result_sha256=c.sha_file(paths['adapter']),
            confirmed_at=time.time())
        proof.pop('controller_log')
        files = [hub, request_path, cli, *campaign.glob('*.json'), *campaign.glob('*.log')]
        for fleet in [*parents, runs / 'canary']:
            files.extend(p for p in fleet.rglob('*') if p.is_file())
            token = c.read(fleet / '_batch/lifecycle.json')['fleet_owner_token']
            files.extend(p for p in (self.root / '.git/cloudbench-fleet-audits' / token).rglob('*') if p.is_file())
        proof['files'] = {str(p): c.sha_file(p) for p in files}
        return state, occurrence, paths, proof, parents

    def isolated_campaign_state(self):
        import time
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        gate = next(g for g in state['plan']['gates'] if g['name'] == occurrence['gate'])
        gate.update(command=[sys.executable, str(self.root / 'scripts/deploy_test_cloud.py')], cwd='.')
        proof.update(purpose='isolated-validation', validation_source=dict(head='c' * 40, digest='d' * 64),
                     execution_quiescence={})
        # The original failed task and retained archive remain immutable; only execution admission differs.
        fleet = parents[0]
        life = c.read(fleet / '_batch/lifecycle.json')
        owner = life['fleet_owner_token']
        audit = self.root / '.git/cloudbench-fleet-audits' / owner
        meta = (audit / 'meta').read_text().replace('status=provider-teardown-verified', 'status=incomplete')
        (audit / 'meta').write_text(meta)
        (audit / 'fresh').mkdir(exist_ok=True)
        (audit / 'fresh/old').write_text('fleet_owner_token=' + owner + '\nrun_id=' + fleet.name
            + '\napp=fixture\nsource=fresh-clone\nmachine_id=old-machine\nvolume_id=old-volume\ndisposition=owned\n')
        registry = self.root / '.git/cloudbench-fleet-ownership' / owner
        registry.mkdir(parents=True)
        (registry / 'meta').write_text(meta + 'cleanup_policy=reap\n')
        (registry / 'runtime-evidence-unconfirmed').write_text('original archive debt\n')
        # Canary has a native provider-retired row; bind a real-shaped exact pair observation.
        runs = fleet.parent
        canary = runs / 'canary'
        replacement = runs / '20261103-080441-2147483001'
        # Rename only this synthetic canary and update its canonical native identity records/log handle.
        canary.rename(replacement)
        for base in [replacement, self.root / '.git/cloudbench-fleet-audits' / ('2' * 32)]:
            for file in base.rglob('*'):
                if file.is_file(): file.write_text(file.read_text().replace('run_id=canary', 'run_id=' + replacement.name))
        life2 = c.read(replacement / '_batch/lifecycle.json'); life2['run_id'] = replacement.name
        c.write(replacement / '_batch/lifecycle.json', life2)
        for log in Path(proof['campaign']).glob('*.log'):
            log.write_text(log.read_text().replace(str(canary), str(replacement)))
        observations = []
        for machine, volume, token in [('old-machine', 'old-volume', owner + '-0'), ('machine1', 'vol_fixture', '2' * 32 + '-0')]:
            for kind, mid in [('machine', machine), ('volume', volume)]:
                metadata = dict(id=mid, state='destroyed' if kind == 'machine' else 'pending_destroy')
                if kind == 'machine': metadata['source_binding'] = dict(REF=state['source']['head'], CLOUDBENCH_RUN_TOKEN=token)
                else: metadata['attached_machine_id'] = None
                observations.append(dict(kind=kind, id=mid, expected_machine=machine, expected_volume=volume,
                    method='GET', no_retry=True, http_status=200, response_sha256='e' * 64, metadata=metadata))
        packet = self.root / '.context/provider-pairs.json'
        c.write(packet, dict(endpoint_origin='https://api.machines.dev', app='fixture', rows=observations))
        proof['execution_quiescence'] = {m: dict(provider_pair=str(packet)) for m in ('old-machine', 'machine1')}
        proof['files'] = {str(f): c.sha_file(f) for base in [runs, Path(proof['campaign']),
            self.root / '.git/cloudbench-fleet-audits', self.root / '.git/cloudbench-fleet-ownership']
            for f in base.rglob('*') if f.is_file()}
        proof['files'][str(paths['receipt'].parent / 'request.json')] = c.sha_file(paths['receipt'].parent / 'request.json')
        proof['files'][str(runs.parent / 'cli.log')] = c.sha_file(runs.parent / 'cli.log')
        proof['files'][str(packet)] = c.sha_file(packet)
        return state, occurrence, paths, proof, gate, packet

    def test_failed_infra_canary_is_execution_only_and_requires_positive_release(self):
        import hashlib
        import shutil
        state, failure, paths, proof, gate, packet = self.isolated_campaign_state()
        runs = Path(proof['campaign']).parent.parent / 'runs'
        fleet = runs / '20261103-080441-2147483001'
        life_path = fleet / '_batch/lifecycle.json'
        life = c.read(life_path)
        life.update(status='failed', controller_exit_code=143)
        audit = fleet / 'teardown-ownership'
        (audit / 'source-audit').unlink()
        (audit / 'owned-clones.ids').write_text('')
        (audit / 'owned-clones.names').write_text('')
        shutil.rmtree(audit / 'fresh')
        canonical = self.root / '.git/cloudbench-fleet-audits' / life['fleet_owner_token']
        shutil.rmtree(canonical); shutil.copytree(audit, canonical)
        digest = hashlib.sha256()
        for path in sorted(audit.rglob('*'), key=lambda p: str(p.relative_to(audit))):
            if path.is_file():
                for raw in (str(path.relative_to(audit)).encode(), path.read_bytes()):
                    digest.update(len(raw).to_bytes(8, 'big')); digest.update(raw)
        life['audit_sha256'] = digest.hexdigest(); c.write(life_path, life)
        (audit / 'source-audit').write_text(f'path={canonical}\nsha256={digest.hexdigest()}\n')
        names = [b['name'] for b in json.loads((fleet / '_batch/benches.json').read_text())]
        c.write(fleet / '_batch/run.json', dict(run_id=fleet.name, controller_exit_code=143,
            status='failed', tasks=[dict(name=n, status='INFRA_ERROR', passed=False,
                lifecycle_stage='released', failure_reason='no current run artifact produced') for n in names]))
        for name in ('execution-provenance.json', 'execution-task-matrix.json'): (fleet / name).unlink()
        log = Path(proof['campaign']) / 'r001-j0003.log'
        text = log.read_text().replace(f'{self.root}/scripts/run-bench monitor {fleet}',
            f"ref    : {state['source']['head']}  (committed source)\n"
            'mode: --infra-probe (strict barrier, no LLM / run_benchmark)\n'
            f'{self.root}/scripts/run-bench monitor {fleet}\n'
            f"owner: {life['fleet_owner_token']}; private controller diagnostics stay in this run directory.")
        log.write_text(text)
        proof['execution_quiescence'].pop('machine1')
        def bind():
            proof['files'] = {p: c.sha_file(p) for p in proof['files'] if Path(p).is_file()}
        bind()
        original = copy.deepcopy(state)
        c.reconcile(state, failure['id'], proof)
        entry = state['reconciled_owners'][proof['receipt_sha256']]
        self.assertFalse(entry['credit_granted']); self.assertFalse(entry['cleanup_complete'])
        self.assertEqual(original['attempts'], state['attempts'])
        self.assertEqual(15, len(entry['participants']))
        mutations = [
            (life_path, lambda v: dict(v, audit_sha256='0' * 64)),
            (canonical / 'meta', lambda v: v.replace('status=provider-teardown-verified', 'status=pending')),
            (log, lambda v: v.replace(state['source']['head'], 'f' * 40)),
            (log, lambda v: v.replace(life['fleet_owner_token'], 'e' * 32)),
            (log, lambda v: v.replace('mode: --infra-probe', 'mode: task')),
        ]
        for path, mutate in mutations:
            with self.subTest(path=path):
                raw = path.read_bytes()
                if path == life_path: c.write(path, mutate(c.read(path)))
                else: path.write_text(mutate(path.read_text()))
                bind(); candidate = copy.deepcopy(original)
                with self.assertRaises(ValueError): c.reconcile(candidate, failure['id'], proof)
                self.assertEqual(original, candidate)
                path.write_bytes(raw); bind()
        import deploy_test_native_cleanup as native
        actual_ps = native.subprocess.check_output
        def live(args, **kwargs):
            if args[:2] == ['ps', '-ax']: return '2147483001 2147483001 S\n'
            return actual_ps(args, **kwargs)
        with patch.object(native.subprocess, 'check_output', side_effect=live), self.assertRaises(ValueError):
            c.reconcile(copy.deepcopy(original), failure['id'], proof)
        ordinary = copy.deepcopy(proof); ordinary.pop('purpose')
        with self.assertRaises(ValueError): c.reconcile(copy.deepcopy(original), failure['id'], ordinary)

    def test_isolated_native_validation_preserves_original_debt_and_requires_new_full_request(self):
        state, failure, paths, proof, gate, packet = self.isolated_campaign_state()
        before = copy.deepcopy(state['attempts'])
        self.assertEqual([gate['name']], c.retained_owners(state, [gate['name']]))
        c.reconcile(state, failure['id'], proof)
        self.assertEqual([], c.retained_owners(state, [gate['name']]))
        self.assertEqual(before, state['attempts'])
        state['source'] = proof['validation_source']
        request = dict(token='new-isolated-token', source=state['source'], checks=gate['checks'], skips={})
        self.assertEqual('new-isolated-token', c.isolated_request(state, gate, request, self.root, {})[0]['new_request_token'])
        self.assertIn('full coverage', c.pending_completion_block(state))
        entry = copy.deepcopy(state['reconciled_owners'])
        state['attempts'].append(dict(results=[dict(gate=gate['name'], source=state['source'], status='PASS',
            complete=True, cases=dict.fromkeys(gate['checks'], 'PASS'))]))
        self.assertIsNone(c.pending_completion_block(state))
        self.assertEqual(entry, state['reconciled_owners'])  # New PASS/source refresh never deletes old debt.
        self.assertFalse(next(iter(entry.values()))['cleanup_complete'])
        self.assertFalse(next(iter(entry.values()))['credit_granted'])
        packet.write_text(packet.read_text() + ' ')
        with self.assertRaisesRegex(ValueError, 'obligation changed'):
            c.retained_owners(state, [gate['name']])
        self.assertIsNotNone(c.pending_completion_block(state))

    def renewal_state(self):
        state, failure, paths, proof, gate, packet = self.isolated_campaign_state()
        receipt = state['attempts'][-1]['results'][0]
        state.update(phase='interrupted', resume_phase='focused')
        state['attempts'][-1]['interrupted'] = True
        state['failures'] = []
        receipt.update(executed=True)
        c.write(paths['receipt'], receipt); proof['receipt_sha256'] = c.sha_file(paths['receipt'])
        c.reconcile(state, receipt['token'], proof)
        # Ordinary source refresh + a completed quick phase leaves the original smoke latest.
        (self.root / 'new-source').write_text('next source')
        state.update(source=c.source(self.root), phase='triage', ready=False)
        state['plan']['source'] = state['source']
        state['attempts'].append(dict(phase='quick', results=[]))
        return state, paths, proof, gate, packet, receipt

    def test_existing_isolated_proof_can_renew_only_validation_source_after_refresh(self):
        state, paths, proof, gate, packet, receipt = self.renewal_state()
        key = proof['receipt_sha256']; original = copy.deepcopy(state)
        renewed = {**proof, 'validation_source': copy.deepcopy(state['source'])}
        c.reconcile(state, receipt['token'], renewed)
        self.assertEqual(state['reconciled_owner_history'], [original['reconciled_owners'][key]])
        current = state['reconciled_owners'][key]
        self.assertEqual(current['validation_source'], state['source'])
        self.assertFalse(current['credit_granted']); self.assertFalse(current['cleanup_complete'])
        self.assertEqual(original['attempts'], state['attempts']); self.assertEqual(original['failures'], state['failures'])
        self.assertEqual(original['round'], state['round']); self.assertEqual(original['phase'], state['phase'])
        request = dict(token='fresh-after-source-refresh', source=state['source'], checks=gate['checks'], skips={})
        self.assertEqual(1, len(c.isolated_request(state, gate, request, self.root, {})))
        self.assertIn('full coverage', c.pending_completion_block(state))
        before = copy.deepcopy(state); c.reconcile(state, receipt['token'], renewed)
        self.assertEqual(before, state)  # idempotent, no duplicate renewal record

    def clean_successor_renewal_state(self):
        state, paths, proof, gate, packet, original = self.renewal_state()
        prior = state['reconciled_owners'][proof['receipt_sha256']]
        folder = self.directory / 'successor'
        token, native_source = 'clean-full-successor', copy.deepcopy(prior['validation_source'])
        native_root = self.root / '.context/deploy-cloud' / __import__('hashlib').sha256(token.encode()).hexdigest()
        binding = dict(original_receipt_sha256=proof['receipt_sha256'], original_request_token=original['token'],
            new_request_token=token, source=native_source, new_native_root=str(native_root),
            excluded_resources=copy.deepcopy(prior['excluded_resources']), credit_granted=False)
        # A genuine complete failure is cleanup authority, never PASS credit. Exclusions remain SKIP.
        skip, *active = gate['checks']
        request = dict(token=token, source=native_source, gate=gate['name'], checks=active,
            skips={skip:dict(source=native_source)}, phase='focused', isolated_validation=[binding])
        worker = dict(token=token, source=native_source, gate=gate['name'],
            cases={name:('FAIL' if i == 0 else 'PASS') for i,name in enumerate(active)},
            complete=True, cleanup_complete=True, reused=False, evidence={},
            fleet_directory=str(native_root / 'campaigns' / ('deploy-' + native_root.name)),
            runner_log=str(native_root / 'cli.log'))
        leaf = folder / 'native-task.json'; c.write(leaf, dict(passed=False))
        worker['evidence'] = {name:dict(path=str(leaf), sha256=c.sha_file(leaf)) for name in active}
        c.write(folder / 'result.json', worker)
        successor = dict(gate=gate['name'], token=token, source=native_source, status='FAIL',
            executed=True, complete=True, native_exit=1, timed_out=False, cancelled=False,
            lingering_group=False, cleanup_owner=None, cases={skip:'SKIP', **worker['cases']},
            case_complete=dict.fromkeys(gate['checks'], True), command=gate['command'],
            log=str(folder/'output.log'), worker_result=str(folder/'result.json'),
            started_at=original['finished_at']+1, finished_at=original['finished_at']+2,
            execution_binding=dict(contract_digest=c.digest(gate), input_fingerprint='captured-input',
                                   environment=state['environment']), isolated_validation=[binding],
            native_cleanup_reference=dict(result=str(folder/'result.json'), native_directory=worker['fleet_directory'],
                cleanup_complete=True, result_sha256=c.sha_file(folder/'result.json'), native_evidence=worker['evidence']))
        c.write(folder/'request.json', request); c.write(folder/'receipt.json', successor)
        state['attempts'].append(dict(phase='focused', results=[successor]))
        return state, paths, proof, gate, packet, original, folder, successor

    def test_isolated_source_renewal_accepts_only_bound_clean_full_successor_without_credit(self):
        state, paths, proof, gate, packet, original, folder, successor = self.clean_successor_renewal_state()
        before = copy.deepcopy(state)
        raw = {p: c.sha_file(p) for p in [*paths.values(), *folder.glob('*.json')]}
        renewed = {**proof, 'validation_source':copy.deepcopy(state['source'])}
        c.reconcile(state, original['token'], renewed)
        entry = state['reconciled_owners'][proof['receipt_sha256']]
        self.assertEqual(state['source'], entry['validation_source'])
        self.assertFalse(entry['credit_granted']); self.assertFalse(entry['cleanup_complete'])
        self.assertEqual(before['attempts'], state['attempts']); self.assertEqual(before['failures'], state['failures'])
        self.assertEqual(before['round'], state['round']); self.assertEqual(before['phase'], state['phase'])
        self.assertEqual(raw, {p:c.sha_file(p) for p in raw})
        request = dict(token='new-full-after-successor', source=state['source'], checks=gate['checks'], skips={})
        self.assertEqual(original['token'], c.isolated_request(state, gate, request, self.root, {})[0]['original_request_token'])
        self.assertIsNone(c.full_pass_binding(state, gate))  # Native FAIL has not become coverage credit.
        same = copy.deepcopy(state); c.reconcile(state, original['token'], renewed)
        self.assertEqual(same, state)  # Historical successor binding survives repeated source renewals.

    def test_isolated_successor_renewal_rejects_bad_or_tampered_successors_atomically(self):
        state, paths, proof, gate, packet, original, folder, successor = self.clean_successor_renewal_state()
        renewed = {**proof, 'validation_source':copy.deepcopy(state['source'])}
        changes = [
            ('incomplete', lambda r:r.update(complete=False)),
            ('not-executed', lambda r:r.update(executed=False)),
            ('owned', lambda r:r.update(cleanup_owner={'new':'owner'})),
            ('lingering', lambda r:r.update(lingering_group=True)),
            ('cancelled', lambda r:r.update(cancelled=True)),
            ('deadline', lambda r:r.update(timed_out=True)),
            ('wrong-command', lambda r:r.update(command=['false'])),
            ('wrong-contract', lambda r:r['execution_binding'].update(contract_digest='0'*64)),
            ('missing-check', lambda r:r['cases'].pop(next(iter(r['cases'])))),
            ('foreign-original', lambda r:r['isolated_validation'][0].update(original_request_token='foreign')),
            ('changed-exclusions', lambda r:r['isolated_validation'][0].update(excluded_resources={})),
            ('unbound-result', lambda r:r['native_cleanup_reference'].update(result_sha256='0'*64)),
        ]
        for name, mutate in changes:
            with self.subTest(name=name):
                candidate = copy.deepcopy(state); row=candidate['attempts'][-1]['results'][0]; mutate(row)
                c.write(folder/'receipt.json',row)
                before=copy.deepcopy(candidate)
                with self.assertRaises(ValueError): c.reconcile(candidate, original['token'], renewed)
                self.assertEqual(before,candidate)
        c.write(folder/'receipt.json',successor)
        for file in ('request.json','result.json','native-task.json'):
            path=folder/file; raw=path.read_bytes(); path.write_bytes(raw+b' ')
            # Request JSON whitespace does not change its meaning; tamper the bound original locator.
            if file=='request.json':
                doc=c.read(path); doc['isolated_validation'][0]['original_receipt_sha256']='0'*64; c.write(path,doc)
            before=copy.deepcopy(state)
            with self.subTest(file=file), self.assertRaises(ValueError): c.reconcile(state, original['token'], renewed)
            self.assertEqual(before,state); path.write_bytes(raw)
        candidate=copy.deepcopy(state)
        candidate['attempts'].append(dict(phase='focused',results=[dict(successor,token='newer-unknown',complete=False)]))
        before=copy.deepcopy(candidate)
        with self.assertRaises(ValueError):c.reconcile(candidate,original['token'],renewed)
        self.assertEqual(before,candidate)

    def test_isolated_source_renewal_refusals_are_atomic(self):
        state, paths, proof, gate, packet, receipt = self.renewal_state()
        renewed = {**proof, 'validation_source': copy.deepcopy(state['source'])}
        changes = [('wrong-source', lambda s,p: p.update(validation_source=proof['validation_source'])),
            ('wrong-token', lambda s,p: p.update(request_token='foreign')),
            ('wrong-receipt', lambda s,p: p.update(receipt_sha256='0'*64)),
            ('new-confirmation', lambda s,p: p.update(confirmed_at=p['confirmed_at']+1)),
            ('running', lambda s,p: s.update(running={'gate':gate['name']})),
            ('live-failures', lambda s,p: s.update(live_failures=[])),
            ('wrong-phase', lambda s,p: s.update(phase='ready')),
            ('no-prior', lambda s,p: s.update(reconciled_owners={})),
            ('newer-receipt', lambda s,p: s['attempts'][-1]['results'].append({**receipt,'token':'new-owner'}))]
        for name, change in changes:
            with self.subTest(name=name):
                candidate, incoming = copy.deepcopy(state), copy.deepcopy(renewed)
                change(candidate, incoming); before = copy.deepcopy(candidate)
                with self.assertRaises(ValueError): c.reconcile(candidate, receipt['token'], incoming)
                self.assertEqual(before, candidate)
        before = copy.deepcopy(state); packet.write_text(packet.read_text()+' ')
        with self.assertRaises(ValueError): c.reconcile(state, receipt['token'], renewed)
        self.assertEqual(before, state)

    def test_isolated_native_validation_requires_current_os_payload_authority(self):
        state, failure, paths, proof, gate, packet = self.isolated_campaign_state()
        fleet = next(p for p in Path(proof['campaign']).parent.parent.joinpath('runs').iterdir()
                     if p.is_dir() and p.name.endswith('310001'))
        life = c.read(fleet / '_batch/lifecycle.json')
        payloads = {}
        for key in ('run', 'backend', 'services'):
            path = self.root / '.context' / (key + '.body'); path.write_text(key)
            payloads[key] = str(path); proof['files'][str(path)] = c.sha_file(path)
        from datetime import datetime, timezone
        value = dict(kind='exact-original-current-os-read-only', result='QUIESCED_CURRENT_OS', identity_guards_pass=True,
            observed_at=datetime.now(timezone.utc).isoformat(),
            machine_id='old-machine', guest_run_token=life['fleet_owner_token']+'-0', source=state['source']['head'],
            driver_current_alive=False, socket_scan_readable=True, remote_effective_uid=0,
            kernel_exclusion_flag=0x00200000, unreadable_live_userland_errno_counts={},
            **dict.fromkeys(('original_service_pid_present_count', 'original_pid_identity_unproven_or_reused_count',
                'scoped_execution_process_count','owned_listening_port_count','unreadable_proc_count','financial_calls','mutations'), 0),
            **{k+'_sha256':c.sha_file(v) for k,v in payloads.items()})
        observed = self.root / '.context/current-os.json'
        data = dict(status='TERMINAL', native_exit=0, guard_identity_status='PASS',
                    protected_original_inputs_unchanged=True, native_result=value)
        c.write(observed, data)
        import time
        proof['confirmed_at'] = time.time()
        proof['execution_quiescence']['old-machine'] = dict(current_os=str(observed), **payloads)
        proof['files'][str(observed)] = c.sha_file(observed)
        c.reconcile(state, failure['id'], proof)
        for changed in [dict(value, unreadable_proc_count=1), dict(value, unreadable_proc_count=False),
                        {k:v for k,v in value.items() if k != 'observed_at'},
                        dict(value, observed_at='invalid'), dict(value, observed_at='2100-01-01T00:00:00+00:00'),
                        dict(value, observed_at='2000-01-01T00:00:00+00:00')]:
            with self.subTest(changed=changed):
                data['native_result'] = changed; c.write(observed, data)
                proof['files'][str(observed)] = c.sha_file(observed)
                before = copy.deepcopy(state)
                with self.assertRaises(ValueError):
                    c.reconcile(state, failure['id'], proof)
                self.assertEqual(before, state)

    def test_isolated_native_validation_refuses_active_or_reused_or_narrowed_resources_atomically(self):
        state, failure, paths, proof, gate, packet = self.isolated_campaign_state()
        original = copy.deepcopy(state)
        data = c.read(packet); data['rows'][0]['metadata']['state'] = 'started'; c.write(packet, data)
        proof['files'][str(packet)] = c.sha_file(packet)
        with self.assertRaisesRegex(ValueError, 'not provider terminal'):
            c.reconcile(state, failure['id'], proof)
        self.assertEqual(original, state)
        data['rows'][0]['metadata']['state'] = 'destroyed'; c.write(packet, data)
        proof['files'][str(packet)] = c.sha_file(packet)
        c.reconcile(state, failure['id'], proof)
        state['source'] = proof['validation_source']
        request = dict(token='new', source=state['source'], checks=gate['checks'], skips={})
        for env, changed in [({'CLOUDBENCH_ARCHIVED_REUSE_REQUEST':'old'}, request),
                             ({}, dict(request, checks=gate['checks'][:-1])),
                             ({}, dict(request, source=dict(head='e'*40, digest='f'*64)))]:
            with self.subTest(env=env, changed=changed), self.assertRaises(ValueError):
                c.isolated_request(state, gate, changed, self.root, env)

    def recovered_campaign_state(self):
        import hashlib
        import shutil
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        fleet = parents[1]
        life_path = fleet / '_batch/lifecycle.json'
        life = c.read(life_path); owner = life['fleet_owner_token']
        life['audit_sha256'] = ''; c.write(life_path, life)
        disposable_path = fleet / '_batch/disposable-cleanup.json'
        disposable = c.read(disposable_path)
        disposable.update(guest_cleanup_missing=True, runtime_evidence_missing=True)
        c.write(disposable_path, disposable)
        bench = json.loads((fleet / '_batch/benches.json').read_text())[0]['name']
        out = fleet / bench; out.mkdir()
        machine, token = '48e7553f5dd4e8', owner + '-0'
        identity = 'linux:89e3de7f-53c5-4dc4-acdd-f64b80fd7bd2:44005'
        (out / '.cid').write_text('clone ' + machine + '\n')
        (out / 'guest-shutdown.confirmed').write_text(fleet.name + '\n')
        c.write(out / 'runtime-evidence.owner.json', dict(version=1, machine_id=machine, run_token=token))
        runtime = out / 'remote-logs/runtime-evidence'; (runtime / 'logs').mkdir(parents=True)
        for name in ('run.json', 'stack.log', 'logs/backend.log', 'logs/worker.log'):
            (runtime / name).write_text('{}\n')
        root = 'f7a07bad-5a1c-4e4a-83e5-5da46b0f655f'
        snapshot = dict(root_exists=True, root_deleted=False, root_user_id='1f85ff25-6e29-4c1b-8739-f917bd101a30',
            tree_agent_ids=[root], unsealed_tree_agent_ids=[root], browser_sessions=[], purchase_cleanup=[])
        final = {**snapshot, 'root_deleted': True, 'unsealed_tree_agent_ids': []}
        logs = dict(cloud_cleanup_evidence=dict(root_agent_id=root, before=snapshot, after=final, final=final,
                    payment_snapshot=final, provider_receipts=[], errors=[], warnings=[]),
                    cloud_provider_cleanup=dict(root_agent_id=root, root_deleted=True, tree_sealed=True, provider_receipts=[]),
                    cloud_payment_cleanup=dict(root_agent_id=root, purchases=[]))
        c.write(runtime / 'run.json', dict(tasks=[dict(name=bench, agent_id=root,
            graded_root_creation_outcome='allocated', logs=logs,
            owned_roots=[dict(root_agent_id=root, task_name=bench, role='graded',
                             creation=dict(source='create_agent_return', root_agent_id=root), logs=logs)])]))
        c.write(runtime / 'services.json', dict(status='stopped', run_sh_pid=2560, env=dict(worker_processes=1)))
        status = runtime / ('cloudbench-stack-cleanup-' + token + '.status')
        status.write_text('version=2\ntoken=' + token + '\nstate=clean\nstack_pid=2560\n'
                          'stack_birth=Tue Nov  3 08:23:40 2026\nstack_native_identity=' + identity + '\n')
        c.write(runtime / 'manifest.json', dict(version=1, machine_id=machine, run_token=token,
            files={str(p.relative_to(runtime)): dict(bytes=p.stat().st_size, sha256=c.sha_file(p))
                   for p in runtime.rglob('*') if p.is_file()}))
        audit = fleet / 'teardown-ownership'; (audit / 'source-audit').unlink()
        (audit / 'owned-clones.ids').write_text(machine + '\n')
        (audit / 'owned-clones.names').write_text('clone-j2\n')
        (audit / 'fresh').mkdir(exist_ok=True)
        (audit / 'fresh/clone-j2').write_text(''.join(f'{k}={v}\n' for k, v in dict(
            fleet_owner_token=owner, run_id=fleet.name, app='fixture', source='fresh-clone',
            disposition='destroyed-provider-retained', machine_id=machine, clone_name='clone-j2',
            volume_id='vol_fixture').items()))
        canonical = self.root / '.git/cloudbench-fleet-audits' / owner
        shutil.rmtree(canonical); shutil.copytree(audit, canonical)
        h = hashlib.sha256()
        for path in sorted(audit.rglob('*'), key=lambda p: str(p.relative_to(audit))):
            if path.is_file():
                for raw in (str(path.relative_to(audit)).encode(), path.read_bytes()):
                    h.update(len(raw).to_bytes(8, 'big')); h.update(raw)
        (audit / 'source-audit').write_text(f'path={canonical}\nsha256={h.hexdigest()}\n')
        proof['recovered_runtime'] = {str(fleet): {bench: identity}}
        for path in [*fleet.rglob('*'), *canonical.rglob('*')]:
            if path.is_file(): proof['files'][str(path)] = c.sha_file(path)
        return state, occurrence, paths, proof, fleet, runtime

    def test_campaign_recovered_v2_release_keeps_failed_missing_facts(self):
        state, occurrence, paths, proof, fleet, runtime = self.recovered_campaign_state()
        before = copy.deepcopy(state['attempts'])
        originals = {p: p.read_bytes() for p in (fleet / '_batch').glob('*.json')}
        c.reconcile(state, occurrence['id'], proof)
        entry = state['reconciled_owners'][proof['receipt_sha256']]
        release = entry['recovered_release_evidence'][str(fleet)]
        self.assertEqual('', release['original_lifecycle']['audit_sha256'])
        self.assertTrue(release['original_disposable_cleanup']['runtime_evidence_missing'])
        self.assertFalse(release['credit_granted']); self.assertFalse(entry['credit_granted'])
        self.assertEqual(before, state['attempts'])
        self.assertEqual(originals, {p: p.read_bytes() for p in originals})
        self.assertEqual([], c.retained_owners(state, [occurrence['gate']]))
        (runtime / 'logs/worker.log').write_text('changed')
        self.assertEqual([occurrence['gate']], c.retained_owners(state, [occurrence['gate']]))

    def test_campaign_recovered_v2_identity_and_seal_refusals_are_atomic(self):
        state, occurrence, paths, proof, fleet, runtime = self.recovered_campaign_state()
        before = copy.deepcopy(state)
        bad = copy.deepcopy(proof); bad['recovered_runtime'][str(fleet)] = {'task-2': 'linux:' + '0' * 36 + ':1'}
        for variant in (bad, {**proof, 'source': {}}, {**proof, 'owner': {}}):
            with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], variant)
            self.assertEqual(before, state)
        for path, raw in [(runtime / 'manifest.json', b'{}'),
                          (fleet / 'teardown-ownership/source-audit', b'path=/wrong\nsha256=bad\n'),
                          (fleet / 'task-2/guest-shutdown.confirmed', b'wrong\n'),
                          (runtime / 'logs/worker.log', b'changed')]:
            original = path.read_bytes(); path.write_bytes(raw)
            variant = copy.deepcopy(proof); variant['files'][str(path)] = c.sha_file(path)
            with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], variant)
            self.assertEqual(before, state); path.write_bytes(original)
        (runtime / 'unreported').write_text('extra')
        with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before, state)

    def test_campaign_shared_cleanup_and_publication_refusals_are_atomic(self):
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        before = copy.deepcopy(state)
        campaign = Path(proof['campaign']); summary = campaign / 'summary.json'
        original = summary.read_bytes()
        for flag in ('shared_transport_cleanup_pending', 'cleanup_ticket_failure', 'shared_inventory_failed', 'startup_cohorts'):
            value = c.read(summary)
            value[flag] = [{'cleanup_budget_retirement_pending': True}] if flag == 'startup_cohorts' else True
            c.write(summary, value)
            variant = copy.deepcopy(proof); variant['files'][str(summary)] = c.sha_file(summary)
            with self.subTest(flag=flag), self.assertRaisesRegex(ValueError, 'campaign .*pending'):
                c.reconcile(state, occurrence['id'], variant)
            self.assertEqual(before, state); summary.write_bytes(original)
        ack = campaign / 'hub-group-publication-ack.private.json'; raw = ack.read_bytes()
        ack.unlink()
        variant = copy.deepcopy(proof); variant['files'].pop(str(ack))
        with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], variant)
        self.assertEqual(before, state); ack.write_bytes(raw)
        value = json.loads(raw); value['record_sha256'] = '0' * 64; c.write(ack, value)
        variant = copy.deepcopy(proof); variant['files'][str(ack)] = c.sha_file(ack)
        with self.assertRaisesRegex(ValueError, 'campaign publication'):
            c.reconcile(state, occurrence['id'], variant)
        self.assertEqual(before, state); ack.write_bytes(raw)
        with patch('deploy_test_cloud.subprocess.check_output', return_value='123 2147483000 S\n'):
            with self.assertRaisesRegex(ValueError, 'publisher cleanup'):
                c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before, state)

    def test_campaign_recovered_root_provider_and_payment_refusals_are_atomic(self):
        state, occurrence, paths, proof, fleet, runtime = self.recovered_campaign_state()
        before = copy.deepcopy(state)
        path, manifest = runtime / 'run.json', runtime / 'manifest.json'
        original, original_manifest = path.read_bytes(), manifest.read_bytes()
        variants = []
        for mode in ('missing', 'unowned', 'custody_role', 'primary_fixture_role', 'missing_creation', 'custody_creation', 'missing_outcome', 'graded_mismatch',
                     'unsealed', 'provider', 'provider_status', 'payment'):
            value = json.loads(original); task = value['tasks'][0]
            if mode == 'missing': task['logs'].pop('cloud_provider_cleanup')
            elif mode == 'unowned': task['owned_roots'] = []
            elif mode == 'custody_role': task['owned_roots'][0]['role'] = 'foreign'
            elif mode == 'primary_fixture_role': task['owned_roots'][0]['role'] = 'fixture_first_run'
            elif mode == 'missing_creation': task['owned_roots'][0].pop('creation')
            elif mode == 'custody_creation': task['owned_roots'][0]['creation']['source'] = 'unconfirmed'
            elif mode == 'missing_outcome': task.pop('graded_root_creation_outcome')
            elif mode == 'graded_mismatch':
                task['owned_roots'][0]['root_agent_id'] = '80c4dd2e-388a-45c4-9daf-ded6979266c8'
                task['owned_roots'][0]['creation']['root_agent_id'] = task['owned_roots'][0]['root_agent_id']
            else:
                for logs in (task['logs'], task['owned_roots'][0]['logs']):
                    evidence = logs['cloud_cleanup_evidence']
                    if mode == 'unsealed': evidence['final']['unsealed_tree_agent_ids'] = [task['agent_id']]
                    if mode in ('provider', 'provider_status'):
                        for phase in ('before', 'after', 'final', 'payment_snapshot'):
                            evidence[phase]['browser_sessions'] = [dict(agent_id=task['agent_id'], provider='tilion',
                                                                         session_id='sess_fixture_12345')]
                    if mode == 'provider_status':
                        receipt = dict(provider='tilion', session_id='sess_fixture_12345', status=401, response_sha256='0' * 64)
                        evidence['provider_receipts'] = [receipt]
                        logs['cloud_provider_cleanup']['provider_receipts'] = [receipt]
                    if mode == 'payment':
                        purchase = dict(purchase_id='33a666aa-dd56-4a71-a014-9330397ffd61', agent_id=task['agent_id'],
                            status='HELD', funding_status='RECLAIMING', total_cents=4396, card_id='card-fixture',
                            stripe_payment_intent_id=None, provider_transfer_id='transfer', reclaim_provider_transfer_id=None)
                        evidence['payment_snapshot']['purchase_cleanup'] = [purchase]
                        logs['cloud_payment_cleanup']['purchases'] = [purchase]
            variants.append((mode, value))
        for mode, value in variants:
            c.write(path, value); seal = json.loads(original_manifest)
            seal['files']['run.json'] = dict(bytes=path.stat().st_size, sha256=c.sha_file(path)); c.write(manifest, seal)
            variant = copy.deepcopy(proof)
            for changed in (path, manifest): variant['files'][str(changed)] = c.sha_file(changed)
            with self.subTest(mode=mode), self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], variant)
            self.assertEqual(before, state)
        path.write_bytes(original); manifest.write_bytes(original_manifest)

    def test_campaign_cleanup_membership_preserves_all_native_unknowns(self):
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        original = copy.deepcopy(state['attempts'])
        c.reconcile(state, occurrence['id'], proof)
        entry = state['reconciled_owners'][proof['receipt_sha256']]
        self.assertEqual(15, len(entry['participants']))
        self.assertFalse(entry['credit_granted'])
        self.assertEqual(original, state['attempts'])
        self.assertEqual([], c.retained_owners(state, [occurrence['gate']]))
        self.assertEqual('live-transfer-required', entry['retained_services'][0]['owner']['status'])
        self.assertEqual({'UNVERIFIED'}, set(state['attempts'][-1]['results'][0]['cases'].values()))
        receipt = state['attempts'][-1]['results'][0]
        self.assertFalse(c._reconciled(state, receipt, {**proof['owner'], 'request_token': 'new'}))
        receipt['token'] = 'new'
        self.assertEqual([occurrence['gate']], c.retained_owners(state, [occurrence['gate']]))

    def test_campaign_missing_cleanup_and_mutations_refuse_atomically(self):
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        before = copy.deepcopy(state)
        for field, value in [('receipt_sha256', '0' * 64), ('worker_result_sha256', '0' * 64),
                             ('request_token', 'wrong'), ('source', {}), ('campaign', '/wrong')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                c.reconcile(state, occurrence['id'], {**proof, field: value})
            self.assertEqual(before, state)
        for path in [Path(proof['campaign']) / 'summary.json', parents[0] / '_batch/disposable-cleanup.json']:
            raw = path.read_bytes(); doc = json.loads(raw)
            if path.name == 'summary.json': doc['jobs'] = doc['jobs'][:-1]
            else: doc['runtime_evidence_missing'] = True
            c.write(path, doc)
            variant = copy.deepcopy(proof); variant['files'][str(path)] = c.sha_file(path)
            with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], variant)
            self.assertEqual(before, state)
            path.write_bytes(raw)
        summary_path = Path(proof['campaign']) / 'summary.json'
        raw = summary_path.read_bytes(); doc = json.loads(raw); doc['jobs'][0]['controller_pid'] += 1
        c.write(summary_path, doc)
        variant = copy.deepcopy(proof); variant['files'][str(summary_path)] = c.sha_file(summary_path)
        with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], variant)
        self.assertEqual(before, state); summary_path.write_bytes(raw)
        log = Path(proof['campaign']) / 'r001-j0003.log'; raw = log.read_bytes()
        log.write_bytes(b''.join(reversed(raw.splitlines(keepends=True))))
        variant = copy.deepcopy(proof); variant['files'][str(log)] = c.sha_file(log)
        with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], variant)
        self.assertEqual(before, state); log.write_bytes(raw)
        (parents[0].parent / 'unreported').mkdir()
        with self.assertRaises(ValueError): c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before, state)

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
        original=copy.deepcopy(f)
        (self.root/'code').write_text('edit before triage')
        new={**self.plan,'source':c.source(self.root)}
        c.refresh(self.state,self.plan,new,self.root)
        self.assertEqual('quick',self.state['phase'])
        self.assertEqual('triage',self.state['next_after_quick'])
        self.assertEqual([f['id']],self.state['pending'])
        self.assertEqual(original,f)
        self.assertNotEqual(f['source'],self.state['source'])
        self.assertEqual(new['source'],self.state['source'])
        self.assertFalse(self.state['ready'])
        self.assertEqual({},self.state['skips'])

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


KIND = 'local-supervisor-cleanup-v1'


class LocalCleanup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.worker = self.root / 'worker'
        self.worker.mkdir()
        (self.worker / '.context').mkdir()
        (self.worker / '.context/native-worker-admission.lock').touch()
        self.folder = self.root / 'cycle/attempts/33/triage/backend-coverage-blackbox'
        self.folder.mkdir(parents=True)
        self.token = 'captured-setup-failure'
        self.source = {'head': 'a' * 40, 'digest': 'b' * 64}
        command = [sys.executable, str(ROOT / 'scripts/deploy_test_backend.py'), '--root', str(self.worker)]
        self.recipe = {'cases': {x: {'command': ['npm', 'run', 'test:coverage:sharded'], 'cwd': 'back-end'}
                                  for x in ['blackbox:browser-provider', 'teardown']},
                       'setup': {'command': ['bash', 'scripts/run-deploy-stage', '--start']},
                       'cleanup': {'command': ['bash', '-c', 'bash scripts/kill-services.sh && bash scripts/run-deploy-stage --finish']},
                       'services': True}
        self.gate = {'name': 'backend-coverage-blackbox', 'native_backend': True,
                     'worker_transport': 'local-isolated', 'worker_root': str(self.worker),
                     'cwd': str(self.worker), 'command': command, 'checks': list(self.recipe['cases']),
                     'worker_recipe': self.recipe, 'case_protocol': True, 'result_transport': 'file'}
        self.request = {'token': self.token, 'source': self.source, 'gate': self.gate['name'],
                        'checks': self.gate['checks'], 'skips': {}, 'phase': 'triage',
                        'worker_root': str(self.worker), 'worker_recipe': self.recipe}
        runner = self.worker / '.context/deploy-backend/native/runner.log'
        runner.parent.mkdir(parents=True)
        runner.write_text('No ready Postgres container owned by this worktree.\nNo services to kill\n')
        self.result = {k: self.request[k] for k in ['token', 'source', 'gate', 'worker_root']}
        self.result.update(cases={'blackbox:browser-provider': 'UNVERIFIED', 'teardown': 'FAIL'},
                           complete=False, cleanup_complete=False, reused=False, native_exit=1,
                           recipe_digest=c.digest(self.recipe), source_unchanged=True,
                           runner_log=str(runner), interrupted=False,
                           evidence={'teardown': {'exit': 1, 'recipe_cleanup_exit': 0},
                                     'artifacts': {'runner_log': c.sha_file(runner)}})
        self.receipt = {k: self.request[k] for k in ['token', 'source', 'gate']}
        self.receipt.update(command=command, cases=dict.fromkeys(self.gate['checks'], 'UNVERIFIED'),
                            native_exit=1, executed=True, complete=False, timed_out=False, cancelled=False,
                            lingering_group=False, lifecycle='owned', started_at=100, finished_at=200,
                            log=str(self.folder / 'output.log'), worker_result=str(self.folder / 'result.json'),
                            reason='worker result identity/inventory mismatch')
        self.receipt.update(execution_binding={'contract_digest': c.digest(self.gate)},
                            host_admission={'started': True, 'lock': str(self.worker / '.context/native-worker-admission.lock')})
        self.process = dict(supervisor_pid=123, child_pid=124, native_exit=1, cancelled=False,
                            timed_out=False, quiescent=True, orphaned_children=False,
                            reaped=[{'pid': 124, 'status': 256}], term_sent=[], kill_sent=[], remaining=[], error=None)
        self.paths = {n: self.folder / n for n in ['request.json', 'result.json', 'receipt.json', 'output.log.process.json']}
        for name, value in zip(self.paths, [self.request, self.result, self.receipt, self.process]):
            c.write(self.paths[name], value)
        (self.folder / 'output.log').write_text(json.dumps(self.result))
        self.failure = dict(id='occurrence', gate=self.gate['name'],
                            check=self.gate['name'] + '/blackbox:browser-provider', native_result='UNVERIFIED', complete=False)
        self.failure.update(source=self.source, evidence=self.receipt['log'], worker_result=self.receipt['worker_result'], finished_at=200)
        self.state = dict(plan={'gates': [self.gate]}, attempts=[{'results': [self.receipt]}],
                          failures=[self.failure], phase='triage', pending=['occurrence'], repair_gates=[],
                          source=self.source, skips={}, ready=False)
        self.proof = dict(kind=KIND, files={n: c.sha_file(p) for n, p in self.paths.items()},
                          confirmed_at=201, observed_by='independent-native-review')
        self.original_bytes = {n: p.read_bytes() for n, p in self.paths.items()}

    def reconcile(self):
        c.reconcile(self.state, 'occurrence', self.proof)

    def test_quiescent_cleanup_allows_real_reexecute_without_credit_or_rewriting(self):
        with self.assertRaisesRegex(ValueError, 'cleanup state unknown'):
            c.reexecute(copy.deepcopy(self.state), 'occurrence')
        self.reconcile()
        self.assertEqual([], c.retained_owners(self.state, [self.gate['name']]))
        c.reexecute(self.state, 'occurrence')
        self.assertEqual('needs-focused-plan', self.state['phase'])
        self.assertEqual([self.gate['name']], self.state['repair_gates'])
        self.assertEqual('UNVERIFIED', self.failure['native_result'])
        self.assertEqual(self.original_bytes, {n: p.read_bytes() for n, p in self.paths.items()})
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])

    def test_process_and_cleanup_unknowns_refuse(self):
        for field, value in [('quiescent', False), ('orphaned_children', True), ('remaining', [999]),
                             ('cancelled', True), ('timed_out', True), ('term_sent', [124]),
                             ('kill_sent', [124]), ('error', 'read failed'), ('native_exit', 0),
                             ('reaped', []), ('reaped', [{'pid': 999, 'status': 256}])]:
            with self.subTest(field=field, value=value):
                c.write(self.paths['output.log.process.json'], {**self.process, field: value})
                self.proof['files']['output.log.process.json'] = c.sha_file(self.paths['output.log.process.json'])
                with self.assertRaises(ValueError): self.reconcile()
                self.assertNotIn('reconciled_owners', self.state)
        c.write(self.paths['output.log.process.json'], self.process)
        self.proof['files']['output.log.process.json'] = c.sha_file(self.paths['output.log.process.json'])
        for value in [None, 1, '0']:
            self.result['evidence']['teardown']['recipe_cleanup_exit'] = value
            c.write(self.paths['result.json'], self.result)
            self.proof['files']['result.json'] = c.sha_file(self.paths['result.json'])
            with self.assertRaises(ValueError): self.reconcile()

    def test_identity_inventory_root_and_recipe_mismatches_refuse(self):
        changes = [('token', 'other'), ('source', {}), ('gate', 'other'), ('worker_root', str(self.root)),
                   ('recipe_digest', '0' * 64), ('cases', {}), ('cleanup_owner', {'unknown': True}),
                   ('reused', True), ('interrupted', True)]
        for field, value in changes:
            with self.subTest(field=field):
                c.write(self.paths['result.json'], {**self.result, field: value})
                self.proof['files']['result.json'] = c.sha_file(self.paths['result.json'])
                with self.assertRaises(ValueError): self.reconcile()
                self.assertNotIn('reconciled_owners', self.state)

    def test_missing_corrupt_or_changed_evidence_never_allows_launch(self):
        self.reconcile()
        for name, path in self.paths.items():
            original = path.read_bytes()
            for bad in [b'not-json', original + b' ']:
                with self.subTest(name=name, bad=bad[:10]):
                    path.write_bytes(bad)
                    with self.assertRaises(ValueError): c.retained_owners(self.state, [self.gate['name']])
                    path.write_bytes(original)
            path.unlink()
            with self.assertRaises(ValueError): c.retained_owners(self.state, [self.gate['name']])
            path.write_bytes(original)
        runner = Path(self.result['runner_log'])
        runner.write_text('changed cleanup evidence')
        with self.assertRaises(ValueError): c.retained_owners(self.state, [self.gate['name']])

    def test_only_current_owned_local_backend_and_independent_proof_are_eligible(self):
        for field, value in [('worker_transport', 'boxes-thread'), ('native_backend', False),
                             ('worker_root', str(self.root)), ('command', ['other'])]:
            old = self.gate[field]
            self.gate[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): self.reconcile()
            self.gate[field] = old
        for field, value in [('confirmed_at', 99), ('observed_by', ''), ('files', {})]:
            old = self.proof[field]
            self.proof[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): self.reconcile()
            self.proof[field] = old
        self.receipt['lingering_group'] = True
        c.write(self.paths['receipt.json'], self.receipt)
        self.proof['files']['receipt.json'] = c.sha_file(self.paths['receipt.json'])
        with self.assertRaises(ValueError): self.reconcile()

    def test_current_root_process_or_admission_owner_refuses(self):
        import fcntl
        with (self.worker / '.context/native-worker-admission.lock').open('r') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(ValueError): self.reconcile()
        proc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)'], cwd=self.worker)
        try:
            with self.assertRaises(ValueError): self.reconcile()
        finally:
            proc.terminate()
            proc.wait(timeout=2)
        self.reconcile()
        c.write(self.worker / '.context/services.json', {'worktree': str(self.worker), 'status': 'running'})
        with self.assertRaises(ValueError): c.retained_owners(self.state, [self.gate['name']])



class CardPreflightCleanup(unittest.TestCase):
    def setUp(self):
        import hashlib
        LocalCleanup.setUp(self)
        name = 'agentcard-lifecycle'
        self.folder = self.root / 'cycle/attempts/35/triage' / name
        self.folder.mkdir(parents=True)
        self.recipe['cases'] = {name: {'command': ['bash', str(self.worker / 'scripts/run-deploy-stage'),
            name, '--', 'bash', 'scripts/run-bench', '--local', 'agent-payment-test-shop'], 'aggregate': True}}
        command = [sys.executable, str(self.worker / 'scripts/deploy_test_worker.py'), '--root', str(self.worker), '--stdio']
        self.gate.update(name=name, category=name, command=command, checks=[name], result_transport='stdout')
        self.gate.pop('native_backend')
        self.request.update(gate=name, checks=[name], worker_recipe=self.recipe)
        native = self.worker / '.context/deploy-worker' / hashlib.sha256(self.token.encode()).hexdigest()
        native.mkdir(parents=True)
        self.run = self.worker / '.context/benchmarks/owned-preflight'
        self.run.mkdir(parents=True)
        case_log = native / (hashlib.sha256(name.encode()).hexdigest() + '.log')
        case_log.write_text(f'RuntimeError: run.sh exited early with code 143; see {self.run}/services.log\n')
        case = dict(status='UNVERIFIED', native_exit=1, command=self.recipe['cases'][name]['command'],
                    started_at=110, finished_at=190, timed_out=False, cancelled=False, lingering_group=False,
                    log=str(case_log), sha256=c.sha_file(case_log))
        self.result = dict(token=self.token, source=self.source, gate=name, worker_root=str(self.worker),
                           cases={name: 'UNVERIFIED'}, complete=False, reused=False, cleanup_complete=True,
                           recipe_digest=c.digest(self.recipe), evidence={name: case})
        self.receipt.update(gate=name, command=command, cases={name:'UNVERIFIED'},
                            log=str(self.folder / 'output.log'), worker_result=str(self.folder / 'result.json'),
                            lifecycle='native-producer', lingering_group=True,
                            execution_binding={'contract_digest': c.digest(self.gate), 'environment': 'env', 'input_fingerprint':'fp'})
        self.benchmark = dict(version=1, run_id=self.run.name, state='not_started', pid=None, native_identity='',
                              token='', receipt=str(self.run / 'benchmark-cleanup.status'), signal=None)
        self.stack = dict(version=1, run_id=self.run.name, token='a'*32, pid=2000000000, birth='original birth',
                          native_identity='linux:' + Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':123')
        self.cleanup = dict(version='2', state='clean', token=self.stack['token'], stack_pid=str(self.stack['pid']),
                            stack_birth=self.stack['birth'], stack_native_identity=self.stack['native_identity'])
        self.services = dict(worktree=str(self.worker), status='stopped', run_sh_pid=self.stack['pid'], ports={'backend':0})
        self.paths = {n:self.folder/n for n in ['request.json','result.json','receipt.json']}
        self.paths.update({'case.log':case_log, 'native-result.json':native/'result.json',
                          **{n:self.run/n for n in ['local-benchmark-owner.json','local-stack-owner.json',
                                                   'local-stack-cleanup.status','services.json']}})
        self.failure.update(gate=name, check=name+'/'+name, evidence=self.receipt['log'], worker_result=self.receipt['worker_result'])
        self.state.update(plan={'gates':[self.gate]}, attempts=[{'results':[self.receipt]}],
                          environment='env', input_fingerprints={name:'fp'})
        self.write_native()

    def write_native(self):
        for key, value in [('request.json',self.request), ('result.json',self.result), ('native-result.json',self.result),
                           ('local-benchmark-owner.json',self.benchmark), ('local-stack-owner.json',self.stack), ('services.json',self.services)]:
            c.write(self.paths[key], value)
        self.paths['local-stack-cleanup.status'].write_text(''.join(k+'='+v+'\n' for k,v in self.cleanup.items()))
        reference=dict(result=str(self.paths['result.json']), native_directory=None, cleanup_complete=True,
                       result_sha256=c.sha_file(self.paths['result.json']), native_evidence=self.result['evidence'])
        self.receipt.update(native_cleanup_reference=reference, cleanup_owner=dict(request_token=self.token,
                            worker_root=str(self.worker), native_cleanup_reference=reference))
        c.write(self.paths['receipt.json'],self.receipt)
        self.proof=dict(kind=KIND, files={n:c.sha_file(p) for n,p in self.paths.items()}, confirmed_at=201, observed_by='native-review')

    reconcile = LocalCleanup.reconcile

    def test_never_admitted_card_releases_launch_only_preserving_native_failure(self):
        original={n:p.read_bytes() for n,p in self.paths.items()}
        with self.assertRaisesRegex(ValueError, 'cleanup owner'):
            c.reexecute(copy.deepcopy(self.state),'occurrence')
        self.reconcile()
        self.assertEqual([],c.retained_owners(self.state,[self.gate['name']]))
        c.reexecute(self.state,'occurrence')
        self.assertEqual('needs-focused-plan',self.state['phase'])
        self.assertEqual('UNVERIFIED',self.failure['native_result'])
        self.assertEqual(original,{n:p.read_bytes() for n,p in self.paths.items()})
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])
        self.state['source'] = {'head':'c'*40, 'digest':'d'*64}
        self.state['input_fingerprints'][self.gate['name']] = 'new-inputs'
        self.assertEqual([],c.retained_owners(self.state,[self.gate['name']]))
        self.assertEqual(self.source,self.failure['source'])
        self.assertIsNone(c.full_pass_binding(self.state,self.gate))

    def test_admitted_or_unknown_benchmark_and_task_artifacts_refuse(self):
        for key,value in [('state','running'),('pid',123),('native_identity','other'),('token','other'),('signal',15)]:
            with self.subTest(key=key):
                old=self.benchmark[key];self.benchmark[key]=value;self.write_native()
                with self.assertRaises(ValueError):self.reconcile()
                self.assertNotIn('reconciled_owners',self.state)
                self.benchmark[key]=old
        self.write_native()
        for name in ['run.json','report-card.json','local-benchmark-results.json','benchmark-cleanup-other.status']:
            p=self.run/name;p.write_text('{}')
            with self.assertRaises(ValueError):self.reconcile()
            p.unlink()

    def test_foreign_stack_identity_or_incomplete_cleanup_refuses(self):
        for key,value in [('state','pending'),('token','foreign'),('stack_native_identity','other'),('stack_pid','1')]:
            old=self.cleanup[key];self.cleanup[key]=value;self.write_native()
            with self.assertRaises(ValueError):self.reconcile()
            self.cleanup[key]=old
        self.stack['pid']=os.getpid();self.cleanup['stack_pid']=str(os.getpid());self.services['run_sh_pid']=os.getpid();self.write_native()
        with self.assertRaises(ValueError):self.reconcile()

    def test_changed_source_recipe_or_native_bytes_refuse(self):
        for target,key,value in [(self.result,'source',{}),(self.gate,'worker_transport','boxes-thread'),
                                 (self.result,'cleanup_complete',False),(self.services,'status','running')]:
            old=target[key];target[key]=value;self.write_native()
            with self.assertRaises(ValueError):self.reconcile()
            target[key]=old
        self.write_native();self.reconcile()
        self.paths['local-stack-owner.json'].write_text('{}')
        with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])

    def test_current_root_admission_and_listener_refuse(self):
        import fcntl,socket
        with (self.worker/'.context/native-worker-admission.lock').open('r') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(ValueError):self.reconcile()
        proc=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'],cwd=self.worker)
        try:
            with self.assertRaises(ValueError):self.reconcile()
        finally:proc.terminate();proc.wait(timeout=2)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));listener.listen()
            self.services['ports']['backend']=listener.getsockname()[1];self.write_native()
            with self.assertRaises(ValueError):self.reconcile()


class StructuralSupervisorCleanup(unittest.TestCase):
    def setUp(self):
        import hashlib
        LocalCleanup.setUp(self)
        name = 'deploy-command-structural'
        self.folder = self.root / 'cycle/attempts/35/triage' / name
        self.folder.mkdir(parents=True)
        self.recipe['cases'] = {name: {'command': ['bash', str(self.worker / 'scripts/run-deploy-stage'),
            name, '--', 'python3', 'scripts/run-deploy-structural-gates.py', '--max-workers', '4'],
            'aggregate': True}}
        command = [sys.executable, str(self.worker / 'scripts/deploy_test_worker.py'), '--root', str(self.worker), '--stdio']
        self.gate.update(name=name, category=name, command=command, checks=[name], result_transport='stdout')
        self.gate.pop('native_backend')
        self.request.update(gate=name, checks=[name], worker_recipe=self.recipe)
        native = self.worker / '.context/deploy-worker' / hashlib.sha256(self.token.encode()).hexdigest()
        native.mkdir(parents=True)
        self.case_log = native / (hashlib.sha256(name.encode()).hexdigest() + '.log')
        self.case_log.write_text('FAILED (errors=3)\n')
        case = dict(status='UNVERIFIED', native_exit=1, command=self.recipe['cases'][name]['command'],
                    started_at=110, finished_at=190, timed_out=False, cancelled=False, lingering_group=False,
                    log=str(self.case_log), sha256=c.sha_file(self.case_log))
        self.result = dict(token=self.token, source=self.source, gate=name, worker_root=str(self.worker),
                           cases={name:'UNVERIFIED'}, complete=False, reused=False, cleanup_complete=True,
                           recipe_digest=c.digest(self.recipe), evidence={name:case})
        self.receipt.update(gate=name, status='FAIL', command=command, cases={name:'UNVERIFIED'},
                            log=str(self.folder / 'output.log'), worker_result=str(self.folder / 'result.json'),
                            lingering_group=True, lifecycle='owned', native_cleanup_reference=None,
                            execution_binding={'contract_digest':c.digest(self.gate), 'environment':'env', 'input_fingerprint':'fp'})
        # Real native supervisor shape: the failed child exited1; adopted
        # descendants were TERM'd/reaped, including independent SIGPIPE exits.
        self.process.update(orphaned_children=True, term_sent=[125],
                            reaped=[{'pid':124,'status':256}, {'pid':125,'status':15}, {'pid':126,'status':13}])
        self.paths = {n:self.folder/n for n in ['request.json','result.json','receipt.json','output.log.process.json']}
        self.failure.update(gate=name, check=name+'/'+name, evidence=self.receipt['log'], worker_result=self.receipt['worker_result'])
        self.state.update(plan={'gates':[self.gate]}, attempts=[{'results':[self.receipt]}],
                          environment='env', input_fingerprints={name:'fp'})
        self.write_native()

    def write_native(self):
        for name,value in zip(self.paths, [self.request,self.result,self.receipt,self.process]):
            c.write(self.paths[name],value)
        self.proof=dict(kind=KIND, files={n:c.sha_file(p) for n,p in self.paths.items()},
                        confirmed_at=201, observed_by='native-supervisor-review')

    reconcile = LocalCleanup.reconcile

    def test_reaped_structural_orphans_allow_launch_only_and_keep_all_failure_facts(self):
        original={n:p.read_bytes() for n,p in self.paths.items()}
        pending=copy.deepcopy(self.state['pending'])
        with self.assertRaisesRegex(ValueError,'cleanup owner'): c.reexecute(copy.deepcopy(self.state),'occurrence')
        self.reconcile()
        self.assertEqual(pending,self.state['pending'])
        self.assertFalse(self.state['ready'])
        self.assertEqual([],c.retained_owners(self.state,[self.gate['name']]))
        c.reexecute(self.state,'occurrence')
        self.assertEqual('needs-focused-plan',self.state['phase'])
        self.assertEqual('UNVERIFIED',self.failure['native_result'])
        self.assertTrue(self.receipt['lingering_group'])
        self.assertTrue(self.process['orphaned_children'])
        self.assertEqual([125],self.process['term_sent'])
        self.assertEqual(original,{n:p.read_bytes() for n,p in self.paths.items()})
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])
        self.assertIsNone(c.full_pass_binding(self.state,self.gate))
        self.state['source']={'head':'c'*40,'digest':'d'*64}
        self.state['input_fingerprints'][self.gate['name']]='changed-inputs'
        self.assertEqual([],c.retained_owners(self.state,[self.gate['name']]))
        self.assertEqual(self.source,self.failure['source'])

    def test_unreaped_unknown_signalled_or_foreign_supervisor_closure_refuses_atomically(self):
        original=copy.deepcopy(self.process)
        variants=[('quiescent',False),('remaining',[125]),('orphaned_children',False),('error','read failed'),
                  ('kill_sent',[125]),('timed_out',True),('cancelled',True),('term_sent',[999]),
                  ('term_sent',[True]),('term_sent',[125,125]),('term_sent',[124]),
                  ('reaped',[]),('reaped',[{'pid':125,'status':15}]),
                  ('reaped',original['reaped']+[{'pid':125,'status':0}]),
                  ('reaped',original['reaped']+[{'pid':127,'status':127}]),
                  ('reaped',original['reaped']+[{'pid':123,'status':0}])]
        for key,value in variants:
            with self.subTest(key=key,value=value):
                self.process={**original,key:value};self.write_native()
                before=copy.deepcopy(self.state)
                with self.assertRaises(ValueError):self.reconcile()
                self.assertEqual(before,self.state)
        self.process=original;self.write_native()
        for key,value in [('cleanup_complete',False),('cases',{self.gate['name']:'FAIL'}),('worker_root',str(self.root)),('source',{})]:
            old=self.result[key];self.result[key]=value;self.write_native()
            with self.assertRaises(ValueError):self.reconcile()
            self.assertNotIn('reconciled_owners',self.state)
            self.result[key]=old

    def test_proof_mutation_new_receipt_and_live_root_reblock(self):
        import fcntl
        with (self.worker/'.context/native-worker-admission.lock').open('r') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(ValueError):self.reconcile()
        proc=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'],cwd=self.worker)
        try:
            with self.assertRaises(ValueError):self.reconcile()
        finally:
            proc.terminate();proc.wait(timeout=2)
        self.reconcile()
        for path in self.paths.values():
            original=path.read_bytes();path.write_bytes(original+b' ')
            with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])
            path.write_bytes(original)
        self.case_log.write_text('changed test evidence')
        with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])
        self.case_log.write_text('FAILED (errors=3)\n')
        old=self.gate['command'];self.gate['command']=['other']
        with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])
        self.gate['command']=old
        newer={**self.receipt,'token':'new-unreconciled-owner'}
        self.state['attempts'].append({'results':[newer]})
        self.assertEqual([self.gate['name']],c.retained_owners(self.state,[self.gate['name']]))


class InterruptedLocalRecovery(unittest.TestCase):
    write_native = StructuralSupervisorCleanup.write_native

    def setUp(self):
        StructuralSupervisorCleanup.setUp(self)
        self.coordinator = self.root / 'coordinator';self.coordinator.mkdir()
        subprocess.run(['git','init','-q',str(self.coordinator)],check=True)
        (self.coordinator/'code').write_text('old')
        subprocess.run(['git','-C',str(self.coordinator),'add','.'],check=True)
        subprocess.run(['git','-C',str(self.coordinator),'-c','user.name=test','-c','user.email=test@example.com','commit','-qm','old'],check=True)
        self.source=c.source(self.coordinator)
        self.gate.update(worker='independent-interrupted-worker',timeout_seconds=14400)
        self.gate['env']={'CONDUCTOR_WORKSPACE_NAME':'interrupted-fixture','CONDUCTOR_PORT':'15000'}
        self.request['source']=self.source
        self.receipt.update(source=self.source,native_exit=-9,cancelled=True,worker_result=None,
                            execution_binding={'contract_digest':c.digest(self.gate),'environment':'env','input_fingerprint':'fp'})
        self.process.update(native_exit=-9,cancelled=True,orphaned_children=False,
                            reaped=[{'pid':124,'status':9},{'pid':125,'status':15}],term_sent=[124,125],kill_sent=[124])
        (self.folder/'result.json').unlink()
        self.paths={n:self.folder/n for n in ['request.json','receipt.json','output.log.process.json']}
        self.state.update(source=self.source,failures=[],phase='interrupted',resume_phase='focused',round=37,
                          repair_gates=[self.gate['name']],pending_post_merge=[],
                          focused={self.gate['name']:{'command':self.gate['command'],'checks':self.gate['checks'],'worker_recipe':self.recipe}})
        self.state.pop('pending')
        self.state['attempts']=[{'phase':'focused','interrupted':True,'results':[self.receipt]}]
        quick=[dict(name=n,category=n,quick=True,command=['true'],checks=[n]) for n in ['format','eslint','typescript','backend-structural']]
        self.plan={'source':self.source,'gates':[self.gate,*quick]}
        self.state.update(plan=self.plan,plan_digest=c.digest(self.plan),environment=c.environment_digest(),input_fingerprints=c.input_fingerprints(self.plan,self.coordinator))
        self.seal()

    def seal(self):
        for n,v in [('request.json',self.request),('receipt.json',self.receipt),('output.log.process.json',self.process)]:c.write(self.paths[n],v)
        self.proof=dict(kind=KIND,files={n:c.sha_file(p) for n,p in self.paths.items()},confirmed_at=201,observed_by='native-interrupted-review')

    def reconcile(self):c.reconcile(self.state,self.token,self.proof)

    def test_token_reconcile_and_actual_resume_branch_preserve_interrupted_receipts(self):
        original=copy.deepcopy(self.state['attempts']);raw={n:p.read_bytes() for n,p in self.paths.items()}
        self.assertEqual([self.gate['name']],c.retained_owners(self.state,[self.gate['name']]))
        self.reconcile()
        c.interrupted_boundary(self.state)
        self.assertEqual([],self.state['failures'])
        self.assertEqual(original,self.state['attempts'])
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])
        directory=self.root/'saved-cycle';directory.mkdir();plan=self.root/'plan.json'
        c.write(plan,self.plan);c.write(directory/'cycle.json',self.state)
        observed=[]
        def no_worker(_plan,state,*_args,**_kwargs):
            observed.append(state['phase']);state.update(phase='triage',ready=False)
        with patch.object(c,'run_phase',side_effect=no_worker):
            rc=c.main(['resume','--plan',str(plan),'--state-dir',str(directory),'--root',str(self.coordinator)])
        self.assertEqual(1,rc);self.assertEqual(['focused'],observed)
        saved=c.read(directory/'cycle.json')
        self.assertEqual(original,saved['attempts']);self.assertFalse(saved['ready']);self.assertNotIn('resume_phase',saved)
        self.assertEqual(raw,{n:p.read_bytes() for n,p in self.paths.items()})

    def test_refresh_requires_all_closure_and_preserves_original_source_and_clock(self):
        (self.coordinator/'code').write_text('new');new={**self.plan,'source':c.source(self.coordinator)}
        before=copy.deepcopy(self.state)
        with self.assertRaises(ValueError):c.refresh(self.state,self.plan,new,self.coordinator)
        self.assertEqual(before,self.state)
        self.reconcile();original=copy.deepcopy(self.state['attempts'])
        c.refresh(self.state,self.plan,new,self.coordinator)
        self.assertEqual('quick',self.state['phase']);self.assertFalse(self.state['ready'])
        self.assertNotIn('resume_phase',self.state);self.assertEqual(37,self.state['round'])
        self.assertEqual(original,self.state['attempts']);self.assertEqual(self.source,self.receipt['source'])
        self.assertEqual(new['source'],self.state['source']);self.assertEqual(self.plan['gates'],new['gates'])

    def test_backend_inventory_growth_keeps_old_cleanup_and_new_full_request(self):
        import deploy_test_backend as backend
        for root in [self.coordinator,self.worker]:
            folder=root/'back-end/src/tests/blackbox';folder.mkdir(parents=True)
            (folder/'browser-provider.blackbox.ts').write_text('// original registered domain\n')
        checks=backend.checks_for(backend.list_domains(self.worker))
        self.recipe['cases']={check:{'command':backend.RUNNER,'cwd':'back-end'} for check in checks}
        self.gate.update(name='backend-coverage-blackbox',category='backend-coverage-blackbox',native_backend=True,
                         result_transport='file',checks=checks,
                         command=[sys.executable,str(ROOT/'scripts/deploy_test_backend.py'),'--root',str(self.worker)])
        self.source=c.source(self.coordinator)
        self.request.update(source=self.source,gate=self.gate['name'],checks=checks)
        self.receipt.update(source=self.source,gate=self.gate['name'],command=self.gate['command'],cases=dict.fromkeys(checks,'UNVERIFIED'))
        self.receipt['execution_binding']['contract_digest']=c.digest(self.gate)
        self.plan['source']=self.source
        self.state.update(source=self.source,plan_digest=c.digest(self.plan),input_fingerprints=c.input_fingerprints(self.plan,self.coordinator))
        self.seal();self.reconcile()
        original=copy.deepcopy(self.state['attempts']);raw={n:p.read_bytes() for n,p in self.paths.items()}
        for root in [self.coordinator,self.worker]:
            (root/'back-end/src/tests/blackbox/cli-login.blackbox.ts').write_text('// genuine new registered domain\n')
        new_gate=copy.deepcopy(self.gate);new_checks=backend.checks_for(backend.list_domains(self.worker))
        self.assertIn('blackbox:cli-login',new_checks)
        new_gate['checks']=new_checks
        new_gate['worker_recipe']['cases']['blackbox:cli-login']={'command':backend.RUNNER,'cwd':'back-end'}
        new={**self.plan,'source':c.source(self.coordinator),'gates':[new_gate,*self.plan['gates'][1:]]}
        c.refresh(self.state,self.plan,new,self.coordinator)
        self.assertEqual([],c.retained_owners(self.state,[self.gate['name']]))
        observed=[]
        def observe(argv,**kwargs):
            request=c.read(Path(kwargs['env']['DEPLOY_GATE_REQUEST']));observed.append(request)
            c.write(Path(kwargs['env']['DEPLOY_GATE_RESULT']),dict(token=request['token'],source=request['source'],gate=request['gate'],
                worker_root=str(self.worker),recipe_digest=c.digest(request['worker_recipe']),cases=dict.fromkeys(request['checks'],'UNVERIFIED'),
                complete=False,reused=False,cleanup_complete=True))
            return 1,False,False,False
        with patch.object(c,'run_command',side_effect=observe):
            result=c.execute(new_gate,self.state,self.root/'fresh-full-observation',self.coordinator)
        self.assertEqual(new_checks,observed[0]['checks'])
        self.assertEqual('UNVERIFIED',result['cases']['blackbox:cli-login'])
        self.assertEqual(original,self.state['attempts']);self.assertEqual(raw,{n:p.read_bytes() for n,p in self.paths.items()})
        path=self.paths['output.log.process.json'];path.write_bytes(raw['output.log.process.json']+b' ')
        with self.assertRaises(ValueError):c.retained_owners(self.state,[self.gate['name']])

    def test_original_exclusions_stay_skip_without_test_or_cleanup_credit(self):
        name='standing-original-exclusion'
        self.recipe['cases'][name]={'command':['true']}
        self.gate['checks'].append(name)
        self.request['skips']={name:{'source':self.source,'disposition':'skipped with warning'}}
        self.receipt['cases'][name]='SKIP'
        self.receipt['execution_binding']['contract_digest']=c.digest(self.gate)
        self.seal();original=copy.deepcopy(self.receipt)
        self.reconcile();c.interrupted_boundary(self.state)
        self.assertEqual(original,self.receipt);self.assertEqual('SKIP',self.receipt['cases'][name])
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])
        self.request['checks'].append(name);self.seal()
        with self.assertRaises(ValueError):c.interrupted_boundary(self.state)

    def test_incomplete_foreign_changed_or_live_evidence_refuses_atomically(self):
        original=copy.deepcopy(self.process)
        for key,value in [('quiescent',False),('remaining',[125]),('error','unknown'),('kill_sent',[999]),
                          ('reaped',[{'pid':124,'status':9}]),('reaped',original['reaped']*2),('cancelled',False)]:
            self.process={**original,key:value};self.seal();before=copy.deepcopy(self.state)
            with self.subTest(key=key),self.assertRaises(ValueError):self.reconcile()
            self.assertEqual(before,self.state)
        self.process=original;self.seal()
        for name in ['result.json','output.log.process.json.watchdog.json']:
            path=self.folder/name;c.write(path,{})
            with self.assertRaises(ValueError):self.reconcile()
            path.unlink()
        import socket,fcntl
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',15000));listener.listen()
            with self.assertRaises(ValueError):self.reconcile()
        with (self.worker/'.context/native-worker-admission.lock').open('r') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(ValueError):self.reconcile()
        self.reconcile()
        for path in self.paths.values():
            raw=path.read_bytes();path.write_bytes(raw+b' ')
            with self.assertRaises(ValueError):c.interrupted_boundary(self.state)
            path.write_bytes(raw)
        self.state['attempts'].append({'phase':'focused','interrupted':True,'results':[{**self.receipt,'token':'new-owner'}]})
        with self.assertRaises(ValueError):c.interrupted_boundary(self.state)


class InterruptedCardRecovery(unittest.TestCase):
    write_native = CardPreflightCleanup.write_native

    def setUp(self):
        CardPreflightCleanup.setUp(self)
        self.receipt.update(native_exit=-9,cancelled=True,worker_result=None,native_cleanup_reference=None,
                            cleanup_owner={'request_token':self.token,'worker_root':str(self.worker),'native_cleanup_reference':None})
        for name in ['result.json','native-result.json']:
            self.paths[name].unlink();self.paths.pop(name)
        self.paths.pop('case.log').write_text(f'RuntimeError: cleanup remains unverified; retaining its recovery authority: {self.run}/local-stack-cleanup.status\n')
        import hashlib
        self.paths['case.log']=self.worker/'.context/deploy-worker'/hashlib.sha256(self.token.encode()).hexdigest()/(hashlib.sha256(b'agentcard-lifecycle').hexdigest()+'.log')
        self.cleanup['state']='failed'
        self.physical_path=self.root/'card-physical.json'
        self.physical=dict(observed_at=201,root=str(self.worker),run=str(self.run),source=self.source['head'],
                           physical={'matched':[],'unknown_live_userland':[]},ports=self.services['ports'],
                           listeners=[],database_status='ABSENT',canonical_reconcile_exit=1)
        self.state.update(failures=[],phase='interrupted',resume_phase='focused')
        self.state.pop('pending');self.state['attempts'][-1]['interrupted']=True
        self.seal()

    def seal(self):
        for n,v in [('request.json',self.request),('receipt.json',self.receipt),('local-benchmark-owner.json',self.benchmark),('local-stack-owner.json',self.stack),('services.json',self.services)]:c.write(self.paths[n],v)
        self.paths['local-stack-cleanup.status'].write_text(''.join(k+'='+v+'\n' for k,v in self.cleanup.items()))
        c.write(self.physical_path,self.physical)
        self.proof=dict(kind=KIND,files={**{n:c.sha_file(p) for n,p in self.paths.items()},str(self.physical_path):c.sha_file(self.physical_path)},confirmed_at=202,observed_by='native-physical-review')

    def test_no_admission_failed_card_can_resume_only_with_bound_physical_closure(self):
        original={n:p.read_bytes() for n,p in self.paths.items()}
        c.reconcile(self.state,self.token,self.proof);c.interrupted_boundary(self.state)
        self.assertEqual([],self.state['failures']);self.assertEqual('failed',self.cleanup['state'])
        self.assertEqual(original,{n:p.read_bytes() for n,p in self.paths.items()})
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])
        self.physical['database_status']='UNKNOWN';self.seal()
        with self.assertRaises(ValueError):c.interrupted_boundary(self.state)

    def test_card_admission_foreign_physical_and_unknowns_refuse(self):
        for key,value in [('source','other'),('observed_at',199),('run',str(self.root)),('listeners',[123]),('database_status','PRESENT'),('canonical_reconcile_exit',True)]:
            old=self.physical[key];self.physical[key]=value;self.seal();before=copy.deepcopy(self.state)
            with self.subTest(key=key),self.assertRaises(ValueError):c.reconcile(self.state,self.token,self.proof)
            self.assertEqual(before,self.state);self.physical[key]=old
        self.physical['physical']['unknown_live_userland']=[123];self.seal()
        with self.assertRaises(ValueError):c.reconcile(self.state,self.token,self.proof)
        self.physical['physical']['unknown_live_userland']=[];self.benchmark['state']='running';self.seal()
        with self.assertRaises(ValueError):c.reconcile(self.state,self.token,self.proof)


class StartupCleanup(unittest.TestCase):
    """Real ENOENT at the native relay boundary; no Fly client/provider execution."""
    def setUp(self):
        import shutil
        import runpy
        import time
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        for name in ('run-bench-campaign.py', 'cloudbench-cleanup-tickets.py',
                     'cloudbench-shared-relay.py', 'run-bench-cloud', 'run-bench-fleet',
                     'lib/cloudbench-inventory.sh', 'lib/cloudbench-env.sh',
                     'cloudbench-campaign-inventory.sh', 'cloudbench-machine-readiness.py',
                     'cloudbench-campaign-machines.py'):
            path = self.root / 'scripts' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / 'scripts' / name, path)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        subprocess.run(['git', '-C', str(self.root), 'add', 'scripts'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=test', '-c',
                        'user.email=test@example.com', 'commit', '-qm', 'native source'], check=True)
        self.source = c.source(self.root)
        self.folder = self.root / '.context/cycle/attempts/2/initial/smoke'
        self.folder.mkdir(parents=True)
        token = '1' * 32
        native = self.root / '.context/deploy-cloud' / c.hashlib.sha256(token.encode()).hexdigest()
        self.runs = native / 'runs'; self.runs.mkdir(parents=True)
        self.campaign = native / 'campaigns' / ('deploy-' + native.name)
        self.campaign.mkdir(parents=True)
        now = time.time()
        from datetime import datetime, timezone
        stamp = datetime.fromtimestamp(now, timezone.utc).isoformat()
        self.summary = dict(campaign_id=self.campaign.name, runs=1, retry_infra=0,
            task_count=1, total_jobs=1, concurrency=1, peak_concurrency=0, status='failed',
            started_at=stamp, finished_at=stamp, wall_clock_seconds=0, shared_inventory_failed=True,
            jobs=[dict(index=1, job_id='r001-j0001', task='task', run=1, status='cancelled',
                controller_exit_code=None, started_at=None, finished_at=None, wall_clock_seconds=None,
                controller_lock='unused.lock', log=str(self.campaign / 'r001-j0001.log'), attempt=1, attempts=[])])
        c.write(self.campaign / 'summary.json', self.summary)
        inventory = self.campaign / 'shared-inventory'; inventory.mkdir()
        (inventory / 'owner').write_text('app=fixture\n')
        copies=inventory/'scripts';copies.mkdir()
        for name in ('cloudbench-campaign-inventory.sh','cloudbench-machine-readiness.py','cloudbench-campaign-machines.py'):
            shutil.copyfile(self.root/'scripts'/name,copies/name)
        for name in ('cloudbench-inventory.sh','cloudbench-env.sh'):
            shutil.copyfile(self.root/'scripts/lib'/name,copies/name)
        script = '''import runpy,sys,subprocess,os,json
from pathlib import Path
from unittest.mock import patch
root,campaign=map(Path,sys.argv[1:])
n=runpy.run_path(str(root/'scripts/run-bench-campaign.py'))
original=subprocess.check_output
def output(argv,**kw):
    if argv[:2]==['bash','-c']: return 'not-a-real-credential'
    return original(argv,**kw)
with patch.dict(os.environ,{'PATH':'/usr/bin:/bin'}),patch.object(subprocess,'check_output',side_effect=output):
    try:n['_start_shared_relay'](root,campaign,root,campaign/'shared-inventory',None,-1)
    except FileNotFoundError as e:
        assert e.errno==2 and e.filename=='flyctl'
    else:raise AssertionError('expected native missing flyctl')
p=subprocess.Popen([sys.executable,'-c','pass']);p.wait()
n['seal_startup_cleanup'](campaign,json.loads((campaign/'summary.json').read_text()),p,None)
'''
        self.producer = subprocess.run([sys.executable, '-c', script, str(self.root), str(self.campaign)],
                                      capture_output=True, text=True)
        self.assertEqual(self.producer.returncode, 0, self.producer.stderr)
        self.relay_directory=Path(c.read(self.campaign/'shared-relay-location.json')['directory'])
        cli = native / 'cli.log'
        cli.write_text(str(self.campaign) + "\nCampaign inventory did not initialize (FileNotFoundError: [Errno 2] No such file or directory: 'flyctl')\n")
        module = runpy.run_path(str(ROOT / 'scripts/run-bench-campaign.py'))
        group = module['campaign_group_record'](self.summary)
        c.write(self.campaign / 'hub-group.json', group)
        c.write(self.campaign / 'hub-group-publication-ack.private.json', dict(pid=2147483000,
            token='2' * 32, record_sha256=c.hashlib.sha256(json.dumps(group, sort_keys=True).encode()).hexdigest()))
        self.request = dict(token=token, source=self.source, gate='smoke', checks=['task'])
        c.write(self.folder / 'request.json', self.request)
        self.adapter = dict(**{k:self.request[k] for k in ('token','source','gate')},
            cases={'task':'UNVERIFIED'}, complete=False, cleanup_complete=False,
            native_exit=1, runner_log=str(cli), started_at=now-1, finished_at=time.time())
        c.write(self.folder / 'result.json', self.adapter)
        reference = dict(result=str(self.folder / 'result.json'), result_sha256=c.sha_file(self.folder / 'result.json'),
                         native_directory=str(self.campaign), cleanup_complete=False, native_evidence={})
        self.owner = dict(request_token=token, worker_root=str(self.root), native_cleanup_reference=reference)
        self.receipt = dict(**self.adapter, lifecycle='native-producer', timed_out=False, cancelled=False,
            lingering_group=True, log=str(self.folder/'output.log'), worker_result=str(self.folder/'result.json'),
            cleanup_owner=self.owner, native_cleanup_reference=reference)
        c.write(self.folder / 'receipt.json', self.receipt)
        self.proof = dict(kind='native-cloud-cleanup-v1', layout='campaign-startup-v1', owner=copy.deepcopy(self.owner),
            request_token=token, source=self.source, receipt_sha256=c.sha_file(self.folder/'receipt.json'),
            worker_result_sha256=c.sha_file(self.folder/'result.json'), confirmed_at=time.time(), observed_by='native-regression',
            campaign=str(self.campaign), files={})
        self.seal_files()

    def tearDown(self):
        import shutil
        if hasattr(self,'relay_directory'):
            shutil.rmtree(self.relay_directory)
        self.temp.cleanup()

    def seal_files(self):
        paths = [self.folder/'request.json', Path(self.adapter['runner_log']),
                 *self.campaign.glob('*.json'), self.root/'scripts/run-bench-campaign.py',
                 *(self.campaign/'shared-inventory/scripts').iterdir()]
        self.proof['files'] = {str(p):c.sha_file(p) for p in paths}

    def validate(self):
        import deploy_test_native_cleanup as n
        return n.validate(self.receipt,self.owner,self.proof)

    def test_native_startup_cleanup_preserves_null_exits_and_original_failures(self):
        originals={str(p):p.read_bytes() for p in self.folder.glob('*.json')}
        entry=self.validate()
        self.assertFalse(entry['credit_granted'])
        failure=dict(id='startup',gate='smoke',check='smoke/task',native_result='UNVERIFIED',complete=False)
        state=dict(phase='triage',plan=dict(gates=[dict(name='smoke',native_cloud=True)]),
                   failures=[failure],attempts=[dict(results=[self.receipt])])
        original_attempts=copy.deepcopy(state['attempts'])
        c.reconcile(state,'startup',self.proof)
        self.assertEqual(c.retained_owners(state,['smoke']),[])
        self.assertEqual(state['attempts'],original_attempts)
        self.assertEqual(failure['native_result'],'UNVERIFIED')
        self.assertEqual(entry['participants'],[])
        self.assertEqual(entry['retained_services'],[])
        self.assertEqual(originals,{p:Path(p).read_bytes() for p in originals})
        self.assertIsNone(c.read(self.campaign/'summary.json')['jobs'][0]['controller_exit_code'])
        self.assertTrue(c.read(self.campaign/'summary.json')['shared_inventory_failed'])

    def test_missing_native_checkpoint_cannot_reconcile_historical_attempt(self):
        (self.campaign/'startup-failure.json').unlink()
        self.seal_files()
        with self.assertRaises(ValueError):self.validate()

    def test_dispatch_resource_and_conflicting_evidence_remain_blocked(self):
        variants = [('peak_concurrency',1),('resources',['machine-1']),('shared_transport_cleanup_pending',True)]
        for field,value in variants:
            with self.subTest(field=field):
                bad=copy.deepcopy(self.summary);bad[field]=value
                c.write(self.campaign/'summary.json',bad);self.seal_files()
                with self.assertRaises(ValueError):self.validate()
        for field,value in [('attempts',[{}]),('controller_pid',123),('resource_id','machine-1'),
                            ('started_at',self.summary['started_at']),('controller_exit_code',0)]:
            with self.subTest(field=field):
                bad=copy.deepcopy(self.summary);bad['jobs'][0][field]=value
                c.write(self.campaign/'summary.json',bad);self.seal_files()
                with self.assertRaises(ValueError):self.validate()

    def test_partial_resources_source_conflicts_and_live_owner_are_rejected(self):
        failure_path=self.campaign/'startup-failure.json'
        seal_path=self.campaign/'startup-cleanup.json'
        original_failure=failure_path.read_bytes(); original_seal=seal_path.read_bytes()
        for field,value in [('errno',13),('filename','other'),('source_ref','a'*40),
                            ('producer_sha256','b'*64),('resource_id','machine-1')]:
            with self.subTest(field=field):
                bad=json.loads(original_failure);bad[field]=value;c.write(failure_path,bad)
                seal=json.loads(original_seal);seal['failure_sha256']=c.sha_file(failure_path)
                c.write(seal_path,seal);self.seal_files()
                with self.assertRaises(ValueError):self.validate()
        failure_path.write_bytes(original_failure);seal_path.write_bytes(original_seal)
        helper=self.campaign/'shared-inventory/scripts/cloudbench-campaign-inventory.sh'
        raw=helper.read_bytes();helper.write_bytes(raw+b'\n# changed execution input\n');self.seal_files()
        with self.assertRaisesRegex(ValueError,'inventory source binding'):self.validate()
        helper.write_bytes(raw)
        for name in ['fleet', '_hub']:
            with self.subTest(name=name):
                path=self.runs/name;path.mkdir();self.seal_files()
                with self.assertRaises(ValueError):self.validate()
                path.rmdir()
        bad=json.loads(original_failure);bad['parent_pid']=os.getpid();c.write(failure_path,bad)
        seal=json.loads(original_seal);seal['parent_pid']=os.getpid()
        seal['failure_sha256']=c.sha_file(failure_path);c.write(seal_path,seal);self.seal_files()
        with self.assertRaisesRegex(ValueError,'still live'):self.validate()

    def test_native_seal_and_publication_are_mandatory(self):
        for name in ['startup-cleanup.json','hub-group.json','hub-group-publication-ack.private.json']:
            with self.subTest(name=name):
                path=self.campaign/name;raw=path.read_bytes();path.unlink();self.seal_files()
                with self.assertRaises(ValueError):self.validate()
                path.write_bytes(raw)
        seal=c.read(self.campaign/'startup-cleanup.json');seal['inventory_exit']=1
        c.write(self.campaign/'startup-cleanup.json',seal);self.seal_files()
        with self.assertRaises(ValueError):self.validate()

class LegacyStartupIsolation(StartupCleanup):
    """Original producer format is admitted only for isolated execution, never cleanup credit."""
    def setUp(self):
        import time
        from deploy_test_startup_compat import observe
        super().setUp()
        failure=c.read(self.campaign/'startup-failure.json')
        seal=c.read(self.campaign/'startup-cleanup.json')
        (self.campaign/'startup-failure.json').unlink()
        (self.campaign/'startup-cleanup.json').unlink()
        original=subprocess.check_output(['git','-C',str(ROOT),'show','ce2742ae0:scripts/run-bench-campaign.py'])
        (self.root/'scripts/run-bench-campaign.py').write_bytes(original)
        subprocess.run(['git','-C',str(self.root),'add','scripts'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=test','-c','user.email=test@example.com',
                        'commit','-qm','original producer'],check=True)
        (self.root/'.git/info/exclude').write_text('.context/\n')
        # Read actual immutable historical blobs through shared Git objects. No checkout of them.
        (self.root/'.git/objects/info/alternates').write_text(str(ROOT/'.git/objects')+'\n')
        self.source=dict(head='ce2742ae023ceab86a34d39bde2754a356f1cc4e',digest='d'*64)
        self.request['source']=self.source;self.adapter['source']=self.source;self.receipt['source']=self.source
        self.adapter['native_command']=['bash','scripts/run-bench','task','--runs','1','--concurrency','1',
                                        '--retry-infra','0','--ref',self.source['head']]
        self.receipt['command']=[sys.executable,str(self.root/'scripts/deploy_test_cloud.py')]
        c.write(self.folder/'request.json',self.request);c.write(self.folder/'result.json',self.adapter)
        self.owner['native_cleanup_reference']['result_sha256']=c.sha_file(self.folder/'result.json')
        self.receipt['native_cleanup_reference']=self.owner['native_cleanup_reference']
        self.receipt['cleanup_owner']=self.owner;c.write(self.folder/'receipt.json',self.receipt)
        cli=Path(self.adapter['runner_log'])
        cli.write_text(str(self.campaign)+"\nCampaign inventory: one parent-owned native feed for all cloud controllers; capacity and resource mutation checks remain live\nCampaign inventory did not initialize; see private publisher log (FileNotFoundError: [Errno 2] No such file or directory: 'flyctl')\n")
        lock=self.campaign/'shared-inventory/machines-refresh.lock'
        lock.write_text(f"host={os.uname().nodename}\npid={seal['inventory_pid']}\npid_start={failure['parent_start']}\ntoken=fixture\n")
        self.observation=self.root/'.context/observation.json'
        self.health=self.campaign/'shared-inventory/inventory/.generation-fixture/health'
        self.health.parent.mkdir(parents=True)
        publisher_token=f"1.2.{seal['inventory_pid']}.0"
        self.health.write_text(f'publisher_token={publisher_token}\nvalid_until=1\ngeneration=.generation-fixture\n')
        scopes=[str(self.campaign),str(self.runs),c.read(self.campaign/'shared-relay-location.json')['directory'],publisher_token]
        os_record=observe({failure['parent_pid'],seal['inventory_pid']},scopes)
        c.write(self.observation,dict(schema='legacy-startup-investigation-v1',observed_at=time.time(),
            peer_record=f"pid={failure['parent_pid']} campaign={self.campaign}\n",os=os_record))
        self.proof.update(layout='campaign-startup-isolated-v1',purpose='isolated-validation',
            owner=copy.deepcopy(self.owner),source=self.source,validation_source=self.source,
            investigator_observation=str(self.observation),inventory_health=str(self.health),confirmed_at=time.time(),
            receipt_sha256=c.sha_file(self.folder/'receipt.json'),worker_result_sha256=c.sha_file(self.folder/'result.json'))
        self.seal_files()

    def seal_files(self):
        if not hasattr(self,'observation'):
            return super().seal_files()
        paths=[self.folder/'request.json',Path(self.adapter['runner_log']),*self.campaign.glob('*.json'),
               *(self.campaign/'shared-inventory/scripts').iterdir(),
               self.campaign/'shared-inventory/machines-refresh.lock',self.observation,self.health]
        self.proof['files']={str(p):c.sha_file(p) for p in paths if p.exists()}

    # Do not inherit checkpoint-specific tests; this class exercises a different, historical protocol.
    def test_native_startup_cleanup_preserves_null_exits_and_original_failures(self):
        self.test_isolation_retains_debt_and_creates_new_token_binding()

    def test_missing_native_checkpoint_cannot_reconcile_historical_attempt(self):
        self.test_missing_native_trace_or_current_observation_is_not_admitted()

    def test_native_seal_and_publication_are_mandatory(self):
        for name in ['hub-group.json','hub-group-publication-ack.private.json','shared-relay-location.json']:
            path=self.campaign/name;raw=path.read_bytes();path.unlink();self.seal_files()
            with self.assertRaises(ValueError):self.validate()
            path.write_bytes(raw)

    def test_partial_resources_source_conflicts_and_live_owner_are_rejected(self):
        old=c.read(self.observation)
        for key,value in [('matched',[123]),('unreadable',[{'pid':123}]),('boot_id','wrong')]:
            bad=copy.deepcopy(old);bad['os'][key]=value;c.write(self.observation,bad);self.seal_files()
            with self.assertRaises(ValueError):self.validate()
        c.write(self.observation,old)
        path=self.campaign/'shared-inventory/scripts/cloudbench-campaign-inventory.sh'
        path.write_text(path.read_text()+'\n# changed\n');self.seal_files()
        with self.assertRaisesRegex(ValueError,'executed source mismatch'):self.validate()

    def test_isolation_retains_debt_and_creates_new_token_binding(self):
        originals={str(p):p.read_bytes() for p in self.folder.glob('*.json')}
        state=dict(phase='triage',source=self.source,plan=dict(gates=[dict(name='smoke',native_cloud=True,
            checks=['task'],command=[sys.executable,str(self.root/'scripts/deploy_test_cloud.py')],cwd='.')]),
            failures=[dict(id='old',gate='smoke',check='smoke/task',native_result='UNVERIFIED',complete=False)],
            attempts=[dict(results=[self.receipt])])
        c.reconcile(state,'old',self.proof)
        entry=next(iter(state['reconciled_owners'].values()))
        self.assertFalse(entry['cleanup_complete']);self.assertFalse(entry['credit_granted'])
        self.assertTrue(entry['obligations_preserved']);self.assertEqual(len(entry['retained_services']),2)
        request=dict(token='3'*32,source=self.source,checks=['task'],skips={})
        binding=c.isolated_request(state,state['plan']['gates'][0],request,self.root,{})
        self.assertEqual(binding[0]['original_request_token'],self.receipt['token'])
        self.assertEqual(binding[0]['new_request_token'],'3'*32)
        self.assertNotEqual(binding[0]['new_native_root'],str(self.runs.parent))
        self.assertFalse(binding[0]['credit_granted'])
        self.assertEqual(originals,{p:Path(p).read_bytes() for p in originals})
        bad=dict(self.proof);bad.pop('purpose')
        with self.assertRaisesRegex(ValueError,'isolation binding'):
            import deploy_test_native_cleanup as n
            n.validate(self.receipt,self.owner,bad)

    def test_missing_native_trace_or_current_observation_is_not_admitted(self):
        path=Path(self.adapter['runner_log']);raw=path.read_bytes();path.write_text(str(self.campaign))
        self.seal_files()
        with self.assertRaisesRegex(ValueError,'pre-dispatch trace'):self.validate()
        path.write_bytes(raw);self.observation.unlink();self.seal_files()
        with self.assertRaises(ValueError):self.validate()

    def test_observer_does_not_hide_a_known_native_owner(self):
        from deploy_test_startup_compat import observe
        self.assertIn(os.getpid(),observe({os.getpid()},[])['matched'])

    def test_deleted_cwd_is_observed_and_still_matches_its_original_scope(self):
        from deploy_test_startup_compat import observe
        directory=self.root/'deleted-cwd';directory.mkdir()
        child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'],cwd=directory)
        try:
            directory.rmdir()
            audit=observe(set(),[str(directory)])
            self.assertIn(child.pid,audit['matched'])
            self.assertNotIn(child.pid,[row['pid'] for row in audit['unreadable']])
        finally:
            child.terminate();child.wait(timeout=2)

    def test_unknown_source_cannot_use_legacy_compatibility(self):
        path=self.root/'scripts/run-bench-campaign.py';path.write_bytes(path.read_bytes()+b'\n# unaudited\n')
        subprocess.run(['git','-C',str(self.root),'add','scripts'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=test','-c','user.email=test@example.com',
                        'commit','-qm','changed producer'],check=True)
        source=c.source(self.root)
        self.request['source']=source;self.adapter['source']=source;self.receipt['source']=source
        c.write(self.folder/'request.json',self.request);c.write(self.folder/'result.json',self.adapter)
        self.owner['native_cleanup_reference']['result_sha256']=c.sha_file(self.folder/'result.json')
        self.receipt['native_cleanup_reference']=self.owner['native_cleanup_reference'];self.receipt['cleanup_owner']=self.owner
        c.write(self.folder/'receipt.json',self.receipt)
        self.proof.update(source=source,owner=copy.deepcopy(self.owner),
            receipt_sha256=c.sha_file(self.folder/'receipt.json'),worker_result_sha256=c.sha_file(self.folder/'result.json'))
        self.seal_files()
        with self.assertRaisesRegex(ValueError,'unaudited legacy producer'):self.validate()

if __name__ == '__main__': unittest.main()
