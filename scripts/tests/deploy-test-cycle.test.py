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
import deploy_gate_progress as progress

class EnvironmentIdentity(unittest.TestCase):
    def test_tool_call_nonce_is_not_runtime_configuration(self):
        with patch.dict(os.environ, {"CODEX_TOOL_CALL_ID": "call-a", "BACKEND_API_KEY": "test-key-a"}, clear=True):
            initial = c.environment_digest()
            os.environ["CODEX_TOOL_CALL_ID"] = "call-b"
            self.assertEqual(initial, c.environment_digest())
            os.environ["BACKEND_API_KEY"] = "test-key-b"
            self.assertNotEqual(initial, c.environment_digest())


class Cycle(unittest.TestCase):
    def test_native_cloud_rejects_unsupported_host_before_coordinator_admission(self):
        plan = copy.deepcopy(self.plan)
        plan['gates'][1].update(native_cloud=True, case_protocol=True,
                                command=[sys.executable,str(self.root/'scripts/deploy_test_cloud.py')],
                                worker_transport='benchmark-cloud-cli')
        with patch.object(sys, 'platform', 'darwin'):
            with self.assertRaisesRegex(ValueError, 'native cloud.*Linux'):
                c.validate_plan(plan, self.root)

    def test_environment_fingerprint_ignores_codex_call_identity_but_binds_launch_inputs(self):
        with patch.dict(os.environ, {'CODEX_TOOL_CALL_ID': 'call-one', 'PATH': '/fixture/bin',
                                     'SNAPSHOT_LOOP_TOKEN': 'original'}, clear=True):
            original = c.environment_digest()
            os.environ['CODEX_TOOL_CALL_ID'] = 'call-two'
            self.assertEqual(original, c.environment_digest())
            os.environ['PATH'] = '/changed/bin'
            self.assertNotEqual(original, c.environment_digest())
            os.environ['PATH'] = '/fixture/bin'
            os.environ['SNAPSHOT_LOOP_TOKEN'] = 'inherited'
            self.assertNotEqual(original, c.environment_digest())

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
                            category='generic', worker_transport='local-isolated', timeout_seconds=.05)
                result = c.execute(card, self.state, self.directory, self.root)
                self.assertEqual({'card': 'UNVERIFIED'}, result['cases'])
                self.assertFalse(result['executed']); self.assertFalse(result['complete'])
                self.assertFalse(result['timed_out']); self.assertIsNone(result['native_exit'])
                self.assertFalse(result['lingering_group']); self.assertNotIn('cleanup_owner', result)
                launch.assert_not_called()

    def test_refused_local_admission_keeps_its_reason_when_receipt_preparation_exhausts_deadline(self):
        clock = [1000.0]
        lock = self.root / '.context/native-worker-admission.lock'
        lock.parent.mkdir(parents=True, exist_ok=True)
        def prepare(_state):
            clock[0] += .08
        def gate(name, timeout):
            return dict(name=name, checks=[name], command=['must-not-launch'], case_protocol=True,
                        category='generic', worker_transport='local-isolated', timeout_seconds=timeout)
        with patch.object(c.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(c, 'revalidate_standing_skips', side_effect=prepare), \
                patch.object(c, 'run_command') as launch, lock.open('a') as held:
            c.fcntl.flock(held, c.fcntl.LOCK_EX | c.fcntl.LOCK_NB)
            refused = c.execute(gate('refused', .05), self.state, self.directory, self.root)
            c.fcntl.flock(held, c.fcntl.LOCK_UN)
            admitted = c.execute(gate('admitted', .04), self.state, self.directory, self.root)
            for name, result, timed_out in [('refused', refused, False), ('admitted', admitted, True)]:
                with self.subTest(admission=name):
                    self.assertEqual({name: 'UNVERIFIED'}, result['cases'])
                    self.assertFalse(result['executed']); self.assertFalse(result['complete'])
                    self.assertEqual(timed_out, result['timed_out']); self.assertIsNone(result['native_exit'])
                    self.assertFalse(result['lingering_group']); self.assertNotIn('cleanup_owner', result)
            self.assertEqual('isolation root already owns an active worker; refuse duplicate launch', refused['reason'])
            self.assertEqual('existing deadline exhausted before local worker launch', admitted['reason'])
            launch.assert_not_called()

    def test_local_slot_fences_queued_locals_after_unverified_cleanup_without_cancelling_cloud(self):
        # The only local native producer was the retired AgentCard lane (its tasks run in cloud smoke now);
        # an ordinary owned local gate that reports unverified cleanup still fences the queued local root.
        import time
        started = self.root / '.context/first-native-started'
        forbidden = self.root / '.context/queued-native-started'
        script = ("import json,os,time;from pathlib import Path;"
                  "r=json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text());"
                  f"Path({str(started)!r}).touch();time.sleep(.15);"
                  "r.update(cases={c:'PASS' for c in r['checks']},complete=True,cleanup_complete=False,reused=False);"
                  "Path(os.environ['DEPLOY_GATE_RESULT']).write_text(json.dumps(r))")
        first = dict(name='card', category='generic', worker_transport='local-isolated',
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
        self.assertEqual(0, a['native_exit']); self.assertFalse(a['complete'])
        self.assertEqual('owned', a['lifecycle']); self.assertTrue(failed.is_set())
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

    def test_partial_rca_preserves_unhandled_blockers_until_final_adjudication(self):
        self.state['phase'] = 'initial'
        c.advance(self.state, [self.result(a='FAIL', b='PASS'), self.result('ui', c='FAIL')])
        first, remaining = self.state['failures'][-2:]
        untouched = copy.deepcopy(remaining)
        native_first = copy.deepcopy(first)
        attempts = copy.deepcopy(self.state['attempts'])
        report = {**self.report(first), 'partial': True}
        c.adjudicate(self.state, report)
        self.assertEqual([remaining['id']], self.state['pending'])
        self.assertEqual(untouched, remaining)
        self.assertEqual(native_first, {k: first[k] for k in native_first})
        self.assertEqual(attempts, self.state['attempts'])
        self.assertEqual(('triage', False), (self.state['phase'], self.state['ready']))
        self.assertEqual({}, self.state['skips'])
        self.assertIn('api', self.state['triage_repair_gates'])
        self.assertEqual(self.plan, self.state['plan'])
        c.write(self.directory / 'cycle.json', self.state)
        self.assertEqual(1, c.verify_saved(self.directory, self.root))
        observed = []
        def full(gate, *_args, **_kwargs):
            observed.append(gate['name'])
            return {**self.result(gate['name'], **dict.fromkeys(gate['checks'], 'PASS')),
                    'native_exit': 0}
        with patch.object(c, 'execute', side_effect=full):
            c.run_phase(self.plan, self.state, self.directory, self.root, independent=True)
        self.assertEqual(['api'], observed)
        self.assertEqual([remaining['id']], self.state['pending'])
        self.assertEqual(untouched, remaining)
        self.assertEqual(('triage', False), (self.state['phase'], self.state['ready']))
        c.adjudicate(self.state, self.report(remaining))
        self.assertFalse(self.state.get('pending'))
        self.assertEqual('needs-focused-plan', self.state['phase'])
        self.assertTrue({'api', 'ui'} <= set(self.state['repair_gates']))
        self.assertFalse(self.state['ready'])

    def test_partial_rca_is_explicit_nonempty_source_bound_and_atomic(self):
        self.state['phase'] = 'initial'
        c.advance(self.state, [self.result(a='FAIL', b='FAIL'), self.result('ui', c='FAIL')])
        first, second, _ = self.state['failures'][-3:]
        entry = self.report(first)['failures'][0]
        bad_source = {**entry, 'source': {'head': 'wrong', 'digest': 'wrong'}}
        other = self.report(second)['failures'][0]
        variants = [
            {'failures': [entry]},
            {'failures': [entry], 'partial': False},
            {'failures': [entry], 'partial': 'true'},
            {'failures': [], 'partial': True},
            {'failures': [entry, entry], 'partial': True},
            {'failures': [{**entry, 'id': 'foreign'}], 'partial': True},
            {'failures': [bad_source], 'partial': True},
            {'failures': [{**entry, 'attribution': 'UNKNOWN'}], 'partial': True},
            {'failures': [entry, {**other, 'source': bad_source['source']}], 'partial': True},
        ]
        original = copy.deepcopy(self.state)
        for report in variants:
            with self.subTest(report=report):
                self.state = copy.deepcopy(original)
                with self.assertRaises(ValueError):
                    c.adjudicate(self.state, report)
                self.assertEqual(original, self.state)

    MAC_STATIC = ['bash', '-c', 'npm run format:check && npm run lint && npm run type-check']

    def triage_quick_fixture(self, mac=None):
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
        if mac is not None:  # the darwin plan's conditional fifth quick gate (deploy_test_plan.MAC_APP_STATIC)
            gate = {'name': 'mac-app-static', 'category': 'mac-app-static', 'quick': True,
                    'checks': ['mac-app-static'], 'cwd': 'mac-app', 'command': self.MAC_STATIC, **mac}
            (self.root / gate['cwd']).mkdir(exist_ok=True)
            self.plan['gates'].append(gate)
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

    def test_triage_quick_accepts_the_conditional_mac_app_static_fifth_gate(self):
        with patch.dict(os.environ, PATH=str(self.root / '.context/bin') + os.pathsep + os.environ['PATH']):
            new, plan, path, bins, call = self.triage_quick_fixture(mac={})
            before = c.read(path)
            self.assertEqual(0, call())
            after = c.read(path); observations = after['attempts'].pop()
            self.assertEqual(before, after)
            self.assertEqual({'eslint','format','typescript','backend-structural','mac-app-static'},
                             {r['gate'] for r in observations['results']})
            self.assertTrue(all(r['executed'] and r['complete'] and r['native_exit'] == 0 for r in observations['results']))
            # 2 static checks + tsc + structural npm + the three mac-app npm scripts.
            self.assertEqual(7, len((self.root / '.context/observed').read_text().splitlines()))

    def test_triage_quick_refuses_a_substituted_mac_app_static_recipe(self):
        variants = [dict(command=['bash', '-c', 'npm run lint']), dict(cwd='.'), dict(env={'X': '1'}),
                    dict(checks=['mac-app-static', 'extra']), dict(command=['npm', 'run', 'test:structural'])]
        for index, variant in enumerate(variants):
            with self.subTest(variant=variant):
                if index:
                    self.tearDown(); self.setUp()
                with patch.dict(os.environ, PATH=str(self.root / '.context/bin') + os.pathsep + os.environ['PATH']):
                    new, plan, path, bins, call = self.triage_quick_fixture(mac=variant)
                    original = path.read_bytes()
                    self.assertEqual(2, call()); self.assertEqual(original, path.read_bytes())
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

    def test_rotating_github_token_value_does_not_stale_runtime_config_but_other_changes_do(self):
        with (self.root / '.git/info/exclude').open('a') as stream:
            stream.write('.env\n')
        env = self.root / 'back-end/.env'
        env.parent.mkdir(exist_ok=True)
        env.write_text('SETTING=1\nGITHUB_TOKEN=ghu_issued_first\n')
        before = c.input_fingerprints(self.plan, self.root)
        env.write_text('SETTING=1\nGITHUB_TOKEN=ghu_refreshed_by_the_daemon\n')
        self.assertEqual(before, c.input_fingerprints(self.plan, self.root))
        for changed in ('SETTING=2\nGITHUB_TOKEN=ghu_issued_first\n', 'SETTING=1\n',
                        'SETTING=1\nGITHUB_TOKEN=ghu_issued_first\nEXTRA=1\n',
                        'SETTING=1\nXGITHUB_TOKEN=ghu_issued_first\n'):
            env.write_text(changed)
            self.assertNotEqual(before, c.input_fingerprints(self.plan, self.root), changed)

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

    def skipped_row(self, sha='c' * 64, reason='Compute token pool exhausted or cooling down', status='SKIPPED', passed=False,
                    name='a'):
        return {'native_task': {'name': name, 'status': status, 'benchmark_status': status, 'passed': passed,
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

    # The native row the 2026-11-06 cloud smoke proof recorded (agent 4f8c38c0, transfer owt_208688aafd52934f33699e9c).
    STALL_REASON = ("AgentCard never released the closed card's org transfer (consumed, releasedCents=0); skipped "
                    "under the standing user-approved warning policy, see docs/rca/cases/2026-10-02-agentcard-"
                    "abandonment-closed-card-transfer-never-released.md: Payment lifecycle did not reach the expected "
                    "terminal state before timeout: payment_lifecycle.purchase.status mismatch: expected 'VOIDED', "
                    "got 'HELD'; last observed purchase.status='HELD', walletFunding.status='RECLAIMING'")

    def stall_confirmation(self, **changes):
        return self.confirmation(**{'receipt_reason': self.STALL_REASON, 'reason_code': 'agentcard_release_stall',
                                    'provider': 'agentcard-sandbox',
                                    'evidence': 'native/agent-payment-abandonment/cloudbench-run.json#failure_reason',
                                    **changes})

    def test_standing_agentcard_release_stall_in_cloud_smoke_is_a_warning_not_a_pass(self):
        # The AgentCard lifecycle tasks are smoke tasks: their standing release stall arrives as a natively SKIPPED
        # cloud row (FAIL case) and is qualified through the same typed warning path, never PASS or pass credit.
        runtime = (ROOT / 'agents/benchmarks/run_benchmark.py').read_text()
        self.assertIn('"AgentCard never released the closed card\'s org transfer (consumed, releasedCents=0); "\n'
                      '    "skipped under the standing user-approved warning policy', runtime)
        failure = self.resource_failure(reason=self.STALL_REASON, name='agent-payment-abandonment')
        c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED', resource_skip=self.stall_confirmation()))
        self.assertEqual('ready', self.state['phase']); self.assertTrue(self.state['ready'])
        kept = next(f for f in self.state['failures'] if f['id'] == failure['id'])
        self.assertEqual(('SKIPPED_WITH_WARNING', 'FAIL', 'SKIPPED'),
                         (kept['disposition'], kept['native_result'], kept['worker_evidence']['native_task']['benchmark_status']))
        self.assertEqual({}, self.state['skips'])  # no pass credit
        self.assertEqual('agentcard_release_stall', self.state['resource_warnings'][0]['confirmation']['reason_code'])

    def stall_run_document(self, transfer):
        """The runner's own run.json shape for the 2026-11-06 sandbox proof (agent 4f8c38c0)."""
        document = {'run_id': 'flt-agent-payment-abandonment-d9a38b815c82-0', 'tasks': [
            {'name': 'agent-payment-abandonment', 'status': 'SKIPPED', 'benchmark_status': 'SKIPPED', 'passed': False,
             'failure_reason': self.STALL_REASON, 'logs': {'agentcard_release_stall_lifecycle': {
                 'agentCard': {'id': 'card_f82707f47089791fef514b3c', 'status': 'CLOSED', 'balanceCents': 0},
                 'orgTransfer': transfer}}}]}
        path = self.root / '.context/native/agent-payment-abandonment/cloudbench-run.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(document))
        return path

    def stall_report_text(self, transfer):
        import contextlib, io
        path = self.stall_run_document(transfer)
        sha = c.sha_file(path)
        failure = self.resource_failure(reason=self.STALL_REASON, name='agent-payment-abandonment', sha=sha)
        failure['worker_evidence']['path'] = str(path)
        c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED',
                                             resource_skip=self.stall_confirmation(receipt_sha256=sha)))
        plan = self.directory / 'plan.json'; c.write(plan, self.plan); c.write(self.directory / 'cycle.json', self.state)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(0, c.main(['report', '--plan', str(plan), '--state-dir', str(self.directory),
                                        '--root', str(self.root)]))
        return (self.directory / 'report.md').read_text().split('RESOURCE WARNINGS', 1)[1]

    def test_agentcard_release_stall_warning_row_states_the_unreleased_amount(self):
        # transferredCents 4396 / releasedCents 0 is $43.96 left unreleased in the sandbox; the row is still
        # a warning (native FAIL retained), never a pass, and says the funds stay a followup.
        warning = self.stall_report_text({'id': 'owt_208688aafd52934f33699e9c', 'status': 'consumed', 'livemode': False,
                                          'amountCents': 4396, 'transferredCents': 4396, 'releasedCents': 0})
        self.assertIn('- api/a — agentcard-sandbox: ' + self.STALL_REASON + ' [agentcard_release_stall]', warning)
        self.assertIn(' · Native: FAIL · Unreleased: $43.96 sandbox (transferredCents 4396 / releasedCents 0)'
                      ' (followup: unreleased funds stay open)', warning)
        self.assertNotIn('PASS', warning)

    def test_agentcard_release_stall_warning_never_invents_an_unstated_amount(self):
        for label, transfer, mode in (('no transferred amount', {'releasedCents': 0, 'livemode': False}, None),
                                      ('no released amount', {'transferredCents': 4396, 'livemode': False}, None),
                                      ('non-integer', {'transferredCents': '4396', 'releasedCents': 0}, None),
                                      ('released above transferred', {'transferredCents': 1, 'releasedCents': 5}, None),
                                      ('live mode', {'transferredCents': 100, 'releasedCents': 25, 'livemode': True}, 'live'),
                                      ('mode unstated', {'transferredCents': 100, 'releasedCents': 25}, 'mode UNRECORDED')):
            with self.subTest(label):
                self.tearDown(); self.setUp()
                warning = self.stall_report_text(transfer)
                if mode is None:
                    self.assertIn(' · Unreleased: UNRECORDED (followup: unreleased funds stay open)', warning)
                    self.assertNotIn('$', warning.split('Native:', 1)[1])
                else:
                    self.assertIn(f' · Unreleased: $0.75 {mode} (transferredCents 100 / releasedCents 25)', warning)

    def test_agentcard_release_stall_helpers_serve_the_production_lane_without_widening_smoke(self):
        # scripts/deploy_prod.py reuses these two helpers for the production lane (production=True); the staged
        # smoke qualification keeps its sandbox-only default, so a production row still blocks there.
        self.assertTrue(c.agentcard_release_stall_task('agent-payment-abandonment'))
        self.assertFalse(c.agentcard_release_stall_task('agent-payment-production-abandonment'))
        self.assertTrue(c.agentcard_release_stall_task('agent-payment-production-abandonment', production=True))
        self.assertFalse(c.agentcard_release_stall_task('agent-payment-abandonment', production=True))
        self.assertFalse(c.agentcard_release_stall_task('chat-mode', production=True))
        self.assertEqual(c.unreleased_amount_text({'transferredCents': 4396, 'releasedCents': 0, 'livemode': True}),
                         'Unreleased: $43.96 live (transferredCents 4396 / releasedCents 0)')
        self.assertEqual(c.unreleased_amount_text({'transferredCents': 4396, 'releasedCents': 0, 'livemode': False}),
                         'Unreleased: $43.96 sandbox (transferredCents 4396 / releasedCents 0)')
        for livemode in (1, 0, None, [], 'true'):  # only a real boolean names the provider mode
            self.assertIn('mode UNRECORDED', c.unreleased_amount_text(
                {'transferredCents': 100, 'releasedCents': 25, 'livemode': livemode}))
        for bad in (None, [], 'x', {}, {'transferredCents': 1}, {'releasedCents': 0}, {'transferredCents': True, 'releasedCents': 0},
                    {'transferredCents': 1, 'releasedCents': 5}, {'transferredCents': -1, 'releasedCents': 0}):
            self.assertEqual(c.unreleased_amount_text(bad), 'Unreleased: UNRECORDED', bad)

    def test_agentcard_release_stall_qualification_binds_the_exact_sandbox_row(self):
        pristine = copy.deepcopy(self.state)
        for label, row in {'production task': dict(name='agent-payment-production-abandonment'),
                           'not an AgentCard lifecycle task': dict(name='chat-mode'),
                           'other AgentCard failure': dict(name='agent-payment-abandonment',
                                                           reason='AgentCard create_card failed: Cardholder not found'),
                           'assertion FAIL with the stall text': dict(name='agent-payment-abandonment', status='FAILED')
                           }.items():
            with self.subTest(label):
                self.state = copy.deepcopy(pristine)
                row.setdefault('reason', self.STALL_REASON)
                failure = self.resource_failure(**row)
                before = copy.deepcopy(self.state)
                with self.assertRaises(ValueError):
                    c.adjudicate(self.state, self.report(failure, attribution='NOT_INTRODUCED',
                                                         resource_skip=self.stall_confirmation(receipt_reason=row['reason'])))
                self.assertEqual(before, self.state)

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

    def prelaunch_campaign_state(self, historical_inventory_mismatch=False):
        import hashlib, shutil, time, runpy
        from datetime import datetime, timezone
        state, occurrence, paths, proof, hub = self.native_recon_state()
        runs = hub.parent.parent
        for item in list(runs.iterdir()):
            shutil.rmtree(item) if item.is_dir() else item.unlink()
        producer = self.root / 'scripts/run-bench-campaign.py'
        producer.parent.mkdir(exist_ok=True)
        shutil.copyfile(ROOT / 'scripts/run-bench-campaign.py', producer)
        inventory_sources = ('scripts/cloudbench-campaign-inventory.sh', 'scripts/lib/cloudbench-inventory.sh',
            'scripts/lib/cloudbench-env.sh', 'scripts/cloudbench-machine-readiness.py', 'scripts/cloudbench-campaign-machines.py')
        for relative in inventory_sources:
            target = self.root / relative; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        historical = self.root / 'scripts/lib/cloudbench-env.sh'
        if historical_inventory_mismatch:
            historical.write_bytes(historical.read_bytes() + b'\n# different receipt-head inventory source\n')
        subprocess.run(['git','-C',str(self.root),'add','scripts'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=test','-c','user.email=t@x','commit','-qm','producer'],check=True)
        if historical_inventory_mismatch:
            shutil.copyfile(ROOT / 'scripts/lib/cloudbench-env.sh', historical)
        source = c.source(self.root)
        campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
        campaign.mkdir(parents=True)
        receipt = state['attempts'][-1]['results'][0]
        adapter = c.read(paths['adapter'])
        start,finish = receipt['started_at'],receipt['finished_at']
        job = dict(job_id='r001-j0001',task=occurrence['gate'],run=1,attempt=1,attempts=[],status='cancelled',
                   controller_exit_code=None,started_at=None,log=str(campaign/'r001-j0001.log'))
        summary = dict(campaign_id=campaign.name,runs=1,retry_infra=0,task_count=1,total_jobs=1,concurrency=1,
            peak_concurrency=0,status='failed',jobs=[job],shared_inventory_failed=True,
            started_at=datetime.fromtimestamp(start,timezone.utc).isoformat(),finished_at=datetime.fromtimestamp(finish,timezone.utc).isoformat())
        c.write(campaign/'summary.json',summary)
        native=runpy.run_path(str(ROOT/'scripts/run-bench-campaign.py'))
        group=native['campaign_group_record'](summary)
        c.write(campaign/'hub-group.json',group)
        c.write(campaign/'hub-group-publication-ack.private.json',dict(pid=2147483000,token='d'*32,record_sha256=hashlib.sha256(json.dumps(group,sort_keys=True).encode()).hexdigest()))
        relay=Path(tempfile.mkdtemp(prefix='cb-relay-')); self.addCleanup(shutil.rmtree,relay)
        c.write(campaign/'shared-relay-location.json',dict(directory=str(relay)))
        inventory=campaign/'shared-inventory';inventory.mkdir()
        scripts=inventory/'scripts';scripts.mkdir()
        for name,relative in [('cloudbench-campaign-inventory.sh','scripts/cloudbench-campaign-inventory.sh'),('cloudbench-inventory.sh','scripts/lib/cloudbench-inventory.sh'),('cloudbench-env.sh','scripts/lib/cloudbench-env.sh'),('cloudbench-machine-readiness.py','scripts/cloudbench-machine-readiness.py'),('cloudbench-campaign-machines.py','scripts/cloudbench-campaign-machines.py')]:
            shutil.copyfile(ROOT/relative,scripts/name)
        (inventory/'publisher.private.log').write_text('')
        (inventory/'stop').touch()
        (inventory/'machines-refresh.lock').write_text('host=fixture\npid=2147483001\npid_start=proc-start:fixture:123\ntoken=2147483001.fixture\n')
        cli=runs.parent/'cli.log'
        cli.write_text(f"Campaign inventory: one parent-owned native feed for all cloud controllers; capacity and resource mutation checks remain live\nCampaign inventory did not initialize; see private publisher log (FileNotFoundError: [Errno 2] No such file or directory: 'flyctl')\nsummary={campaign}/summary.json\n")
        request=paths['receipt'].parent/'request.json';req=c.read(request);req['source']=source;c.write(request,req)
        receipt['source']=source;adapter['source']=source;adapter['fleet_directory']=str(campaign)
        c.write(paths['adapter'],adapter)
        reference=receipt['native_cleanup_reference'];reference.update(native_directory=str(campaign),result_sha256=c.sha_file(paths['adapter']))
        receipt['cleanup_owner']['native_cleanup_reference']=reference;c.write(paths['receipt'],receipt)
        files=[request,cli,producer,*campaign.rglob('*')]
        files=[f for f in files if f.is_file()]
        proof.update(layout='campaign-prelaunch-v1',campaign=str(campaign),producer_source=str(producer),source=source,owner=copy.deepcopy(receipt['cleanup_owner']),
            receipt_sha256=c.sha_file(paths['receipt']),worker_result_sha256=c.sha_file(paths['adapter']),confirmed_at=time.time(),files={str(f):c.sha_file(f) for f in files})
        proof.pop('controller_log')
        return state,occurrence,paths,proof,campaign

    def write_reviewed_producer_fixture(self, name, expected):
        import hashlib
        raw = subprocess.check_output(['git', '-C', str(ROOT), 'show',
                                       'e88057acfe64e279bf50188e3938df315e94ee49:' + name])
        self.assertEqual(expected, hashlib.sha256(raw).hexdigest())
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        return raw

    def ref_preflight_campaign_state(self):
        import hashlib, shutil, time, runpy
        from datetime import datetime, timezone
        state, occurrence, paths, proof, campaign = self.prelaunch_campaign_state()
        from deploy_test_native_ref_preflight import REVIEWED_SOURCES, SOURCES
        sources = SOURCES
        for relative, expected in REVIEWED_SOURCES.items():
            self.write_reviewed_producer_fixture(relative, expected)
            target = campaign / 'shared-inventory/scripts' / Path(relative).name
            if target.exists():
                target.write_bytes((self.root / relative).read_bytes())
        subprocess.run(['git', '-C', str(self.root), 'add', 'scripts'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'ref-producer'], check=True)
        source = c.source(self.root)
        receipt = state['attempts'][-1]['results'][0]
        checks = [occurrence['gate']] + ['task-' + str(i) for i in range(1, 10)]
        cases = dict.fromkeys(checks, 'UNVERIFIED')
        start, finish = receipt['started_at'], receipt['finished_at']
        iso = lambda value: datetime.fromtimestamp(value, timezone.utc).isoformat()
        jobs = []
        marker = f"FATAL: requested benchmark commit {source['head']} is not fetchable from origin and local patch shipping is disabled"
        for index, check in enumerate(checks, 1):
            log = campaign / f'r001-j{index:04d}.log'
            log.write_text(marker + '\n')
            jobs.append(dict(job_id=f'r001-j{index:04d}', task=check, run=1, attempt=1, attempts=[], status='failed',
                             controller_exit_code=1, controller_pid=2147483100 + index,
                             started_at=iso(start + .1), finished_at=iso(finish - .1), log=str(log)))
        summary = dict(campaign_id=campaign.name, runs=1, retry_infra=0, task_count=10, total_jobs=10,
                       concurrency=10, peak_concurrency=10, status='failed', jobs=jobs,
                       started_at=iso(start), finished_at=iso(finish))
        c.write(campaign/'summary.json', summary)
        native = runpy.run_path(str(ROOT/'scripts/run-bench-campaign.py'))
        group = native['campaign_group_record'](summary)
        c.write(campaign/'hub-group.json', group)
        c.write(campaign/'hub-group-publication-ack.private.json', dict(pid=2147483000, token='d'*32,
                record_sha256=hashlib.sha256(json.dumps(group, sort_keys=True).encode()).hexdigest()))
        live = Path(c.read(campaign/'shared-relay-location.json')['directory'])
        archive = campaign/'shared-relay'; archive.mkdir()
        stamp = 'proc-start:00000000-0000-0000-0000-000000000000:123'
        owner = dict(pid='2147483003', pid_start=stamp, parent_pid='2147483002', parent_start=stamp,
                     token='synthetic-publisher', app='synthetic-app')
        authority = dict(schema='shared-relay-authority-v1', app='synthetic-app', org_slug='fixture', network='',
                         parent_pid=2147483002, parent_start=stamp,
                         source_sha256=c.sha_file(self.root/'scripts/cloudbench-shared-relay.py'),
                         agent_socket=str(live/'fly-agent.sock'), inventory_directory=str(campaign/'shared-inventory'),
                         inventory_owner=owner, allowed_remote_ports=[8000], deadline=1000.0)
        c.write(archive/'authority.private.json', authority)
        digest = c.sha_file(archive/'authority.private.json')
        ready = dict(pid=2147483005, birth=stamp, authority_sha256=digest,
                     agent=dict(pid=2147483004, birth=stamp, version='fixture', socket_identity=[1, 2]),
                     socket=str(live/'control.sock'), fd_limit=1000)
        c.write(archive/'ready.json', ready)
        c.write(archive/'serve.once.json', dict(pid=ready['pid'], birth=stamp, authority_sha256=digest))
        for name, pid in [('bootstrap-owner.json',2147483006), ('broker-owner.json',ready['pid'])]:
            c.write(archive/name, dict(pid=pid, birth=stamp, parent_pid=authority['parent_pid'], parent_start=stamp))
        (archive/'broker.private.log').write_text('{"stopped": true}\n')
        (archive/'bootstrap.private.log').write_text('synthetic isolated bootstrap\n')
        for path in archive.iterdir(): shutil.copyfile(path, live/path.name)
        (campaign/'shared-inventory/machines-refresh.lock').unlink()
        (campaign.parent.parent/'cli.log').write_text(f'summary={campaign}/summary.json\n')
        request_path = paths['receipt'].parent/'request.json'
        request = c.read(request_path); request.update(source=source, checks=checks); c.write(request_path, request)
        adapter = c.read(paths['adapter']); adapter.update(source=source, cases=cases); c.write(paths['adapter'], adapter)
        receipt.update(source=source, cases=cases)
        receipt['native_cleanup_reference']['result_sha256'] = c.sha_file(paths['adapter'])
        receipt['cleanup_owner']['native_cleanup_reference'] = receipt['native_cleanup_reference']
        c.write(paths['receipt'], receipt)
        files = [request_path, campaign.parent.parent/'cli.log', *campaign.rglob('*'), *live.rglob('*'),
                 self.root/'scripts/run-bench-campaign.py', *(self.root/p for p in sources)]
        proof.update(layout='campaign-ref-preflight-v1', source=source, owner=copy.deepcopy(receipt['cleanup_owner']),
                     receipt_sha256=c.sha_file(paths['receipt']), worker_result_sha256=c.sha_file(paths['adapter']),
                     confirmed_at=time.time(), files={str(p):c.sha_file(p) for p in files if p.is_file()})
        return state, occurrence, paths, proof, campaign, live

    def test_ref_preflight_started_controllers_have_no_native_allocation_credit(self):
        state, occurrence, paths, proof, campaign, live = self.ref_preflight_campaign_state()
        before = copy.deepcopy(state)
        c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before['attempts'], state['attempts'])
        self.assertEqual(before['failures'], state['failures'])
        entry = next(iter(state['reconciled_owners'].values()))
        self.assertFalse(entry['credit_granted'])
        self.assertEqual([], entry['participants'])
        self.assertEqual([], entry['retained_services'])
        self.assertEqual([], c.retained_owners(state, [occurrence['gate']]))

    def test_ref_preflight_rejects_forged_lifecycle_source_and_prefix_without_state_mutation(self):
        import shutil
        state, occurrence, paths, proof, campaign, live = self.ref_preflight_campaign_state()
        originals = {Path(p):Path(p).read_bytes() for p in proof['files']}
        log = campaign/'r001-j0001.log'
        for mutation in ('purpose', 'prefix', 'wrong-ref', 'native-handle', 'attempt', 'nonterminal', 'boolean-exit',
                         'source', 'no-shutdown', 'numeric-shutdown', 'live-agent', 'live-bootstrap', 'live-publisher',
                         'inventory-owner', 'no-stop', 'unacknowledged', 'foreign-hash'):
            with self.subTest(mutation=mutation):
                candidate = copy.deepcopy(proof)
                try:
                    if mutation=='purpose': candidate['purpose']='isolated-validation'
                    if mutation=='prefix': log.write_text('forged-prefix '+originals[log].decode())
                    if mutation=='wrong-ref': log.write_text(originals[log].decode().replace(proof['source']['head'],'a'*40))
                    if mutation=='native-handle': log.write_text(f'{self.root}/scripts/run-bench monitor /tmp/foreign\n'+originals[log].decode())
                    if mutation in ('attempt','nonterminal','boolean-exit'):
                        value=c.read(campaign/'summary.json')
                        if mutation=='attempt': value['jobs'][0]['attempts']=[{'run_dir':'foreign'}]
                        elif mutation=='nonterminal': value['jobs'][0]['controller_exit_code']=None
                        else: value['jobs'][0]['controller_exit_code']=True
                        c.write(campaign/'summary.json',value)
                    if mutation=='source': (self.root/'scripts/run-bench-fleet').write_text('changed producer')
                    if mutation in ('no-shutdown', 'numeric-shutdown'):
                        response='{}\n' if mutation=='no-shutdown' else '{"stopped": 1}\n'
                        (campaign/'shared-relay/broker.private.log').write_text(response)
                        (live/'broker.private.log').write_text(response)
                    if mutation.startswith('live-'):
                        from deploy_test_native_ref_preflight import process_birth
                        ready=c.read(campaign/'shared-relay/ready.json')
                        if mutation=='live-agent': ready['agent'].update(pid=os.getpid(),birth=process_birth(os.getpid()))
                        if mutation=='live-bootstrap':
                            value=c.read(campaign/'shared-relay/bootstrap-owner.json');value.update(pid=os.getpid(),birth=process_birth(os.getpid()))
                            c.write(campaign/'shared-relay/bootstrap-owner.json',value)
                        if mutation=='live-publisher':
                            authority=c.read(campaign/'shared-relay/authority.private.json')
                            authority['inventory_owner'].update(pid=str(os.getpid()),pid_start=process_birth(os.getpid()))
                            c.write(campaign/'shared-relay/authority.private.json',authority)
                            digest=c.sha_file(campaign/'shared-relay/authority.private.json')
                            ready['authority_sha256']=digest
                            once=c.read(campaign/'shared-relay/serve.once.json');once['authority_sha256']=digest
                            c.write(campaign/'shared-relay/serve.once.json',once)
                        c.write(campaign/'shared-relay/ready.json',ready)
                        for p in (campaign/'shared-relay').iterdir(): shutil.copyfile(p,live/p.name)
                    if mutation=='inventory-owner': (campaign/'shared-inventory/owner').write_text('live owner')
                    if mutation=='no-stop': (campaign/'shared-inventory/stop').unlink()
                    if mutation=='unacknowledged': (campaign/'hub-group-publication-ack.private.json').unlink()
                    candidate['files']={str(p):c.sha_file(p) for p in originals if p.exists()}
                    if mutation=='foreign-hash': candidate['files'][str(log)]='0'*64
                    snapshot=copy.deepcopy(state)
                    with self.assertRaises(ValueError): c.reconcile(state,occurrence['id'],candidate)
                    self.assertEqual(snapshot,state)
                finally:
                    (campaign/'shared-inventory/owner').unlink(missing_ok=True)
                    for path,data in originals.items(): path.write_bytes(data)

    def test_ref_preflight_rejects_unreviewed_source_order_even_with_matching_receipts(self):
        import deploy_test_native_ref_preflight as ref
        state, occurrence, paths, proof, campaign, live = self.ref_preflight_campaign_state()
        before = copy.deepcopy(state)
        with patch.dict(ref.REVIEWED_SOURCES, {'scripts/run-bench-fleet': '0'*64}):
            with self.assertRaisesRegex(ValueError, 'producer source changed'):
                c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before, state)

    def test_ref_preflight_requires_full_head_before_io(self):
        from deploy_test_native_ref_preflight import validate_ref_preflight
        for head in ('HEAD','a'*39,'--output=foreign',None):
            with self.subTest(head=head), patch('subprocess.check_output') as process:
                with self.assertRaisesRegex(ValueError,'ref preflight receipt head invalid'):
                    validate_ref_preflight({'source':{'head':head}},None,{},None,None,None,None,None,None)
                process.assert_not_called()

    def test_native_prelaunch_reconciliation_preserves_failure_and_grants_only_retry(self):
        state,occurrence,paths,proof,campaign=self.prelaunch_campaign_state()
        before=copy.deepcopy(state['attempts'])
        c.reconcile(state,occurrence['id'],proof)
        self.assertEqual(before,state['attempts'])
        entry=next(iter(state['reconciled_owners'].values()))
        self.assertFalse(entry['credit_granted'])
        self.assertEqual([],entry['participants'])
        self.assertEqual([],c.retained_owners(state,[occurrence['gate']]))

    def test_native_prelaunch_reconciliation_accepts_quiescent_stale_attempt_token(self):
        state,occurrence,paths,proof,campaign=self.prelaunch_campaign_state()
        state.update(phase='stale',failures=[])
        state.pop('pending',None)
        state['attempts'][-1].update(stale=True)
        state['attempts'][-1].pop('interrupted',None)
        receipt=state['attempts'][-1]['results'][0]
        state['source']=receipt['source']
        before=copy.deepcopy(state['attempts'])
        c.reconcile(state,receipt['token'],proof)
        self.assertEqual(before,state['attempts'])
        self.assertEqual([],state['failures'])
        self.assertFalse(next(iter(state['reconciled_owners'].values()))['credit_granted'])
        self.assertEqual([],c.retained_owners(state,[occurrence['gate']]))

        for mutation in ('not-stale', 'running', 'live-failures', 'wrong-token'):
            with self.subTest(mutation=mutation):
                bad=copy.deepcopy(state)
                bad.pop('reconciled_owners',None)
                token=receipt['token']
                if mutation=='not-stale':bad['attempts'][-1]['stale']=False
                if mutation=='running':bad['running']={'gate':occurrence['gate']}
                if mutation=='live-failures':bad['live_failures']=[]
                if mutation=='wrong-token':token='unrelated-token'
                snapshot=copy.deepcopy(bad)
                with self.assertRaises(ValueError):c.reconcile(bad,token,proof)
                self.assertEqual(snapshot,bad)

    def test_native_prelaunch_inventory_must_match_receipt_head_not_only_checkout(self):
        state,occurrence,paths,proof,campaign=self.prelaunch_campaign_state(historical_inventory_mismatch=True)
        snapshot=copy.deepcopy(state)
        with self.assertRaises(ValueError):
            c.reconcile(state,occurrence['id'],proof)
        self.assertEqual(snapshot,state)

    def test_native_prelaunch_rejects_noncleanup_purpose_without_mutation(self):
        state,occurrence,paths,proof,campaign=self.prelaunch_campaign_state()
        for purpose in ('isolated-validation', 'unexpected-purpose', {'unexpected': True}):
            with self.subTest(purpose=purpose):
                candidate=copy.deepcopy(proof); candidate['purpose']=purpose
                snapshot=copy.deepcopy(state)
                with self.assertRaises(ValueError):
                    c.reconcile(state,occurrence['id'],candidate)
                self.assertEqual(snapshot,state)

    def test_native_prelaunch_rejects_invalid_git_head_before_io(self):
        from deploy_test_native_prelaunch import validate_prelaunch
        for head in ('', 'HEAD', '--output=/tmp/untrusted', 'a' * 39, None):
            with self.subTest(head=head), patch('subprocess.check_output') as process:
                with self.assertRaisesRegex(ValueError, 'prelaunch receipt head invalid'):
                    validate_prelaunch({'source': {'head': head}}, None, {}, None,
                                       None, None, None, None, None)
                process.assert_not_called()

    def test_native_prelaunch_accepts_explicit_null_cleanup_purpose(self):
        state,occurrence,paths,proof,campaign=self.prelaunch_campaign_state()
        proof['purpose']=None
        c.reconcile(state,occurrence['id'],proof)
        entry=state['reconciled_owners'][proof['receipt_sha256']]
        self.assertIsNone(entry.get('purpose'))
        self.assertFalse(entry['credit_granted'])
        self.assertTrue(entry['prelaunch_no_allocation'])

    def test_native_prelaunch_proof_rejects_started_job_or_missing_positive_failure(self):
        state,occurrence,paths,proof,campaign=self.prelaunch_campaign_state()
        for mutation in ('started','no-failure','not-stopped','relay-created','live-publisher','changed-source','admitted-controller'):
            with self.subTest(mutation=mutation):
                summary=campaign/'summary.json';original=summary.read_bytes()
                stop=campaign/'shared-inventory/stop'
                relay=Path(c.read(campaign/'shared-relay-location.json')['directory'])
                cli=campaign.parent.parent/'cli.log';cli_original=cli.read_bytes()
                lock=campaign/'shared-inventory/machines-refresh.lock';lock_original=lock.read_bytes()
                producer=Path(proof['producer_source']);producer_original=producer.read_bytes()
                admitted=campaign.parent.parent/'runs/admitted'
                try:
                    if mutation=='started':
                        value=c.read(summary);value['jobs'][0]['controller_pid']=23456;c.write(summary,value)
                    if mutation=='no-failure': cli.write_text('generic inventory failure')
                    if mutation=='not-stopped':stop.unlink()
                    if mutation=='relay-created':(relay/'broker-owner.json').write_text('{}')
                    if mutation=='live-publisher':lock.write_text(f'host=fixture\npid={os.getpid()}\npid_start=proc-start:fixture:123\ntoken={os.getpid()}.fixture\n')
                    if mutation=='changed-source':producer.write_text('changed')
                    if mutation=='admitted-controller':admitted.mkdir()
                    bad=copy.deepcopy(proof)
                    bad['files']={path:c.sha_file(Path(path)) for path in proof['files'] if Path(path).is_file()}
                    snapshot=copy.deepcopy(state)
                    with self.assertRaises(ValueError):c.reconcile(state,occurrence['id'],bad)
                    self.assertEqual(snapshot,state)
                finally:
                    summary.write_bytes(original);cli.write_bytes(cli_original);stop.touch()
                    (relay/'broker-owner.json').unlink(missing_ok=True)
                    lock.write_bytes(lock_original);producer.write_bytes(producer_original)
                    if admitted.exists():admitted.rmdir()

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

    def test_native_cloud_cleanup_finds_fleet_audits_in_a_linked_worktrees_common_git_dir(self):
        """2026-11-07: a deploy worktree's .git is a file; the fleet keeps audits and ownership registries
        under the git common dir."""
        import deploy_test_native_cleanup as n
        main = self.root / 'main-checkout'
        main.mkdir()
        git = lambda *a: subprocess.run(['git', '-C', str(main), *a], check=True, capture_output=True)
        git('init', '-q')
        git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base')
        linked = self.root / 'linked-worktree'
        git('worktree', 'add', '-q', '--detach', str(linked))
        common = (main / '.git').resolve() / 'cloudbench-fleet-audits'
        self.assertTrue((linked / '.git').is_file())
        self.assertEqual(common, n.fleet_audit_root(linked.resolve()))
        self.assertEqual(common, n.fleet_audit_root(main.resolve()))
        # The retained-registry refusal must look where the fleet writes it, or it passes vacuously.
        registries = common.parent / 'cloudbench-fleet-ownership'
        self.assertEqual(registries, n.fleet_ownership_root(linked.resolve()))
        self.assertEqual(registries, n.fleet_ownership_root(main.resolve()))
        for module in ('deploy_test_native_cleanup.py', 'deploy_test_interrupted_cleanup.py'):
            self.assertNotIn("'.git/cloudbench-fleet-", (ROOT / 'scripts' / module).read_text(), module)

    def test_native_cloud_cleanup_refuses_a_retained_fleet_registry_in_the_common_git_dir(self):
        """Negative control: a fleet ownership registry still present where run-bench-fleet keeps it
        (GIT_COMMON_DIR/cloudbench-fleet-ownership) refuses reconciliation; it is never vacuously absent."""
        import deploy_test_native_cleanup as n
        state, occurrence, paths, proof, hub = self.native_recon_state()
        lives = [Path(p) for p in proof['files'] if p.endswith('/_batch/lifecycle.json')]
        token = json.loads(lives[0].read_text())['fleet_owner_token']
        registry = n.fleet_ownership_root(self.root) / token
        registry.mkdir(parents=True)
        (registry / 'meta').write_text('fleet_owner_token=' + token + '\n')
        with self.assertRaisesRegex(ValueError, 'registry still retained'):
            c.reconcile(copy.deepcopy(state), occurrence['id'], proof)

    def test_native_cloud_cleanup_binds_a_fleet_run_record_beyond_the_receipt_cap(self):
        """2026-11-07: a mass-agent _batch/run.json (98 MB) exceeded the 64 MiB receipt cap, so a verified
        fleet cleanup could never be reconciled and every later smoke launch was refused."""
        import hashlib
        import deploy_test_native_cleanup as n
        state, occurrence, paths, proof, hub = self.native_recon_state()
        records = [Path(p) for p in proof['files'] if p.endswith('/_batch/run.json')]
        self.assertTrue(records)
        cap = max([Path(p).stat().st_size for p in proof['files'] if not p.endswith('/_batch/run.json')]
                  + [paths['receipt'].stat().st_size, paths['adapter'].stat().st_size])
        for record in records:
            value = json.loads(record.read_text())
            value['padding'] = 'x' * (cap + 1)
            record.write_text(json.dumps(value))
            proof['files'][str(record)] = hashlib.sha256(record.read_bytes()).hexdigest()
        with patch.object(c, 'MAX_RECEIPT_BYTES', cap):
            reconciled = copy.deepcopy(state)
            c.reconcile(reconciled, occurrence['id'], proof)
            self.assertEqual([], c.retained_owners(reconciled, [occurrence['gate']]))
            with patch.object(n, 'RUN_RECORD_MAX_BYTES', cap), self.assertRaisesRegex(ValueError, 'proof file too large'):
                c.reconcile(copy.deepcopy(state), occurrence['id'], proof)

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

    def admission_campaign_state(self):
        import hashlib, shutil, time, runpy
        from datetime import datetime, timezone
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        runs = parents[0].parent
        for fleet in [*parents[10:], runs / 'canary']:
            token = c.read(fleet/'_batch/lifecycle.json')['fleet_owner_token']
            shutil.rmtree(fleet)
            shutil.rmtree(self.root/'.git/cloudbench-fleet-audits'/token)
        parents = parents[:10]
        from deploy_test_native_admission import REVIEWED_SOURCES
        sources = list(REVIEWED_SOURCES)
        for relative, expected in REVIEWED_SOURCES.items():
            self.write_reviewed_producer_fixture(relative, expected)
        subprocess.run(['git','-C',str(self.root),'add','scripts'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=t','-c','user.email=t@x','commit','-qm','admission producer'],check=True)
        source = c.source(self.root)
        receipt = state['attempts'][-1]['results'][0]
        campaign = Path(proof['campaign'])
        summary = c.read(campaign/'summary.json')
        jobs = summary['jobs'][:10]
        iso = lambda v: datetime.fromtimestamp(v, timezone.utc).isoformat()
        start, end = receipt['started_at'], receipt['finished_at']
        for index, (fleet, job) in enumerate(zip(parents, jobs)):
            code = 1 if index == 9 else 143
            job.update(status='failed' if code==1 else 'cancelled', controller_exit_code=code,
                       started_at=iso(start+.1), finished_at=iso(end-.2 if code==1 else end-.1))
            text = (f'{self.root}/scripts/run-bench monitor {fleet}\n')
            if code==1:
                text += 'cleanup reserve admission failed: [Errno 28] insufficient physical cleanup floors for pending controllers\n❌ could not allocate the emergency fleet teardown disk reserve; refusing provider mutation\n'
            else:
                text += 'Terminated\n⚰️  controller received TERM (02:28:28)\n'
            Path(job['log']).write_text(text)
            life = c.read(fleet/'_batch/lifecycle.json'); life.update(status='failed',controller_exit_code=code)
            c.write(fleet/'_batch/lifecycle.json',life)
            c.write(fleet/'_batch/run.json',dict(run_id=fleet.name,status='failed',controller_exit_code=code,
                tasks=[dict(name=job['task'],status='INFRA_ERROR',passed=False,lifecycle_stage='released',failure_reason='no current run artifact produced')]))
            for name in ('execution-provenance.json','execution-task-matrix.json'): (fleet/name).unlink()
        for path in list(campaign.glob('*.log')):
            if path not in {Path(j['log']) for j in jobs}: path.unlink()
        summary.update(jobs=jobs,task_count=10,total_jobs=10,concurrency=10,peak_concurrency=10,started_at=iso(start),finished_at=iso(end))
        c.write(campaign/'summary.json',summary)
        native=runpy.run_path(str(ROOT/'scripts/run-bench-campaign.py'))
        group=native['campaign_group_record'](summary)
        c.write(campaign/'hub-group.json',group)
        c.write(campaign/'hub-group-publication-ack.private.json',dict(pid=2147483000,token='d'*32,
            record_sha256=hashlib.sha256(json.dumps(group,sort_keys=True).encode()).hexdigest()))
        checks=[j['task'] for j in jobs]; cases=dict.fromkeys(checks,'UNVERIFIED')
        request_path=paths['receipt'].parent/'request.json'
        request=c.read(request_path); request.update(source=source,checks=checks); c.write(request_path,request)
        adapter=c.read(paths['adapter']); adapter.update(source=source,cases=cases); c.write(paths['adapter'],adapter)
        receipt.update(source=source,cases=cases,case_complete=dict.fromkeys(checks,False))
        receipt['native_cleanup_reference']['result_sha256']=c.sha_file(paths['adapter'])
        receipt['cleanup_owner']['native_cleanup_reference']=receipt['native_cleanup_reference']
        c.write(paths['receipt'],receipt)
        proof.update(layout='campaign-admission-rejected-v1',source=source,owner=copy.deepcopy(receipt['cleanup_owner']),
            receipt_sha256=c.sha_file(paths['receipt']),worker_result_sha256=c.sha_file(paths['adapter']),confirmed_at=time.time())
        files=[request_path,runs.parent/'cli.log',*campaign.rglob('*'),*runs.rglob('*'),
               *(self.root/p for p in sources),
               *(p for fleet in parents for p in (self.root/'.git/cloudbench-fleet-audits'/c.read(fleet/'_batch/lifecycle.json')['fleet_owner_token']).rglob('*'))]
        proof['files']={str(p):c.sha_file(p) for p in files if p.is_file()}
        return state,occurrence,paths,proof,parents

    def test_admission_requires_full_source_before_git_io(self):
        from deploy_test_native_admission import validate_campaign
        for head in (None, '4f219', 'a'*39, 'g'*40, True):
            with self.subTest(head=head), patch('deploy_test_native_admission.subprocess.check_output') as io:
                with self.assertRaises(ValueError):
                    validate_campaign({'source':{'head':head}}, {}, self.root, None, {}, set(), None, None)
                io.assert_not_called()

    def test_historical_admission_source_survives_current_checkout_changes(self):
        from deploy_test_native_admission import REVIEWED_SOURCES
        state, occurrence, paths, proof, parents = self.admission_campaign_state()
        for relative in REVIEWED_SOURCES:
            (self.root / relative).write_text('# newer source after the recorded run\n')
        before = copy.deepcopy(state['attempts'])
        c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before, state['attempts'])
        self.assertFalse(next(iter(state['reconciled_owners'].values()))['credit_granted'])

    def test_admission_rejection_retains_ten_parent_custody_without_credit(self):
        state, occurrence, paths, proof, parents = self.admission_campaign_state()
        before=copy.deepcopy(state)
        c.reconcile(state,occurrence['id'],proof)
        entry=next(iter(state['reconciled_owners'].values()))
        self.assertEqual(before['attempts'],state['attempts'])
        self.assertEqual(before['failures'],state['failures'])
        self.assertFalse(entry['credit_granted'])
        self.assertEqual(10,len(entry['participants']))
        self.assertTrue(entry['retained_services'])
        self.assertEqual([],c.retained_owners(state,[occurrence['gate']]))

    def test_admission_rejection_fails_closed_on_malformed_or_nonempty_closure(self):
        state, occurrence, paths, proof, parents = self.admission_campaign_state()
        original={Path(p):Path(p).read_bytes() for p in proof['files']}
        campaign=Path(proof['campaign']); summary_path=campaign/'summary.json'
        before=copy.deepcopy(state)
        for mutation in ('purpose','source','prefix','boolean-pass','boolean-exit','false-root','executed','metadata','duplicate-pid','boolean-pid',
                         'reverse-clock','early-cancel','late-start','nonterminal','live-group','nonempty','unknown-record','unknown-audit','registry','foreign-hub'):
            with self.subTest(mutation=mutation):
                candidate=copy.deepcopy(proof); added=[]
                try:
                    summary=c.read(summary_path)
                    if mutation=='purpose': candidate['purpose']='isolated-validation'
                    if mutation=='source': (self.root/'scripts/run-bench-fleet').write_text('changed producer')
                    if mutation=='prefix':
                        p=Path(summary['jobs'][-1]['log']); p.write_text(p.read_text().replace('cleanup reserve admission failed:','forged cleanup reserve admission failed:'))
                    if mutation in ('boolean-pass','executed'):
                        p=parents[0]/'_batch/run.json'; value=c.read(p); value['tasks'][0]['passed']=0 if mutation=='boolean-pass' else True; c.write(p,value)
                    if mutation in ('boolean-exit','false-root'):
                        p=parents[-1]/'_batch/run.json'; value=c.read(p)
                        if mutation=='boolean-exit': value['controller_exit_code']=True
                        else: value['tasks'][0]['owned_roots']=False
                        c.write(p,value)
                    if mutation=='unknown-record':
                        p=parents[0]/'teardown-ownership/unrecognized'; p.write_text('unknown'); added.append(p)
                    if mutation=='metadata':
                        p=parents[0]/'execution-provenance.json'; c.write(p,{}); added.append(p)
                    if mutation=='duplicate-pid': summary['jobs'][1]['controller_pid']=summary['jobs'][0]['controller_pid']
                    if mutation=='boolean-pid': summary['jobs'][0]['controller_pid']=True
                    if mutation=='reverse-clock': summary['jobs'][0]['started_at']=summary['jobs'][0]['finished_at']
                    if mutation=='early-cancel': summary['jobs'][0]['finished_at']=summary['jobs'][0]['started_at']
                    if mutation=='late-start': summary['jobs'][0]['started_at']=summary['jobs'][0]['finished_at']
                    if mutation=='nonterminal': summary['jobs'][0]['status']='running'
                    if mutation in ('duplicate-pid','boolean-pid','reverse-clock','early-cancel','late-start','nonterminal'): c.write(summary_path,summary)
                    if mutation=='nonempty':
                        p=parents[0]/'teardown-ownership/expected-fresh/x'; p.parent.mkdir(exist_ok=True); p.write_text('owned'); added.append(p)
                    if mutation=='unknown-audit':
                        p=parents[0]/'teardown-ownership/meta'; p.write_text(p.read_text().replace('provider-teardown-verified','unknown'))
                    if mutation=='registry':
                        owner=c.read(parents[0]/'_batch/lifecycle.json')['fleet_owner_token']; p=self.root/'.git/cloudbench-fleet-ownership'/owner; p.mkdir(parents=True); added.append(p)
                    if mutation=='foreign-hub':
                        p=next(p for p in original if p.name.endswith('.owner')); p.write_text(p.read_text().replace('live-transfer-required','unknown'))
                    candidate['files'].update({str(p):c.sha_file(p) for p in original if p.exists()})
                    candidate['files'].update({str(p):c.sha_file(p) for p in added if p.is_file()})
                    if mutation=='live-group':
                        from deploy_test_native_cleanup import subprocess as native_subprocess
                        actual=native_subprocess.check_output
                        def process_result(args, *a, **kw):
                            if args[:1]==['ps']: return '999999 310001 S\n'
                            return actual(args,*a,**kw)
                        with patch.object(native_subprocess,'check_output',side_effect=process_result):
                            with self.assertRaises(ValueError): c.reconcile(state,occurrence['id'],candidate)
                    else:
                        with self.assertRaises(ValueError): c.reconcile(state,occurrence['id'],candidate)
                    self.assertEqual(before,state)
                finally:
                    for p in added:
                        if p.is_dir(): p.rmdir()
                        elif p.exists(): p.unlink()
                    for p,raw in original.items(): p.write_bytes(raw)

    def independently_rejected_admission_campaign_state(self):
        import hashlib, runpy
        state, occurrence, paths, proof, parents = self.admission_campaign_state()
        campaign = Path(proof['campaign'])
        summary = c.read(campaign/'summary.json')
        for index in (0, 1):
            job = summary['jobs'][index]
            job['controller_exit_code'] = 1  # Keep original cancelled status.
            log = Path(job['log'])
            log.write_text(f'{self.root}/scripts/run-bench monitor {parents[index]}\n'
                'cleanup reserve admission failed: [Errno 28] insufficient physical cleanup floors for pending controllers\n'
                '❌ could not allocate the emergency fleet teardown disk reserve; refusing provider mutation\n')
            for name in ('lifecycle.json','run.json'):
                p=parents[index]/'_batch'/name; value=c.read(p); value['controller_exit_code']=1; c.write(p,value)
        c.write(campaign/'summary.json',summary)
        native=runpy.run_path(str(ROOT/'scripts/run-bench-campaign.py'))
        group=native['campaign_group_record'](summary)
        c.write(campaign/'hub-group.json',group)
        ack=c.read(campaign/'hub-group-publication-ack.private.json')
        ack['record_sha256']=hashlib.sha256(json.dumps(group,sort_keys=True).encode()).hexdigest()
        c.write(campaign/'hub-group-publication-ack.private.json',ack)
        proof['files']={p:c.sha_file(Path(p)) for p in proof['files']}
        return state, occurrence, paths, proof, parents

    def test_independent_admission_rejections_preserve_cancelled_outcomes_and_custody(self):
        state, occurrence, paths, proof, parents = self.independently_rejected_admission_campaign_state()
        before=copy.deepcopy(state)
        originals={p:Path(p).read_bytes() for p in proof['files']}
        c.reconcile(state,occurrence['id'],proof)
        entry=next(iter(state['reconciled_owners'].values()))
        self.assertFalse(entry['credit_granted'])
        self.assertEqual(10,len(entry['participants']))
        self.assertTrue(entry['retained_services'])
        self.assertEqual(before['attempts'],state['attempts'])
        self.assertEqual(before['failures'],state['failures'])
        self.assertEqual(originals,{p:Path(p).read_bytes() for p in proof['files']})

    def test_independent_admission_rejections_require_exact_positive_boundary(self):
        state, occurrence, paths, proof, parents = self.independently_rejected_admission_campaign_state()
        originals={Path(p):Path(p).read_bytes() for p in proof['files']}
        before=copy.deepcopy(state)
        campaign=Path(proof['campaign']); summary_path=campaign/'summary.json'
        for mutation in ('no-marker','no-refusal','prefixed-marker','duplicate-marker','duplicate-refusal','reversed-lines',
                         'wrong-exit','boolean-exit','finished-before-primary','started-after-primary','running-status'):
            with self.subTest(mutation=mutation):
                candidate=copy.deepcopy(proof)
                try:
                    summary=c.read(summary_path);job=summary['jobs'][0];log=Path(job['log']);text=log.read_text()
                    marker='cleanup reserve admission failed: [Errno 28] insufficient physical cleanup floors for pending controllers'
                    refusal='❌ could not allocate the emergency fleet teardown disk reserve; refusing provider mutation'
                    if mutation=='no-marker':text=text.replace(marker+'\n','')
                    if mutation=='no-refusal':text=text.replace(refusal+'\n','')
                    if mutation=='prefixed-marker':text=text.replace(marker,'forged '+marker)
                    if mutation=='duplicate-marker':text+=marker+'\n'
                    if mutation=='duplicate-refusal':text+=refusal+'\n'
                    if mutation=='reversed-lines':text=text.replace(marker+'\n'+refusal,refusal+'\n'+marker)
                    if mutation=='wrong-exit':job['controller_exit_code']=2
                    if mutation=='boolean-exit':job['controller_exit_code']=True
                    if mutation=='finished-before-primary':job['finished_at']=job['started_at']
                    if mutation=='started-after-primary':job['started_at']=job['finished_at']
                    if mutation=='running-status':job['status']='running'
                    log.write_text(text);c.write(summary_path,summary)
                    candidate['files']={str(p):c.sha_file(p) for p in originals}
                    with self.assertRaises(ValueError):c.reconcile(state,occurrence['id'],candidate)
                    self.assertEqual(before,state)
                finally:
                    for p,raw in originals.items():p.write_bytes(raw)

    def cancelled_parent_campaign_state(self):
        import hashlib, shutil, time, runpy
        from cloudbench_execution_provenance import build_config, build_task_matrix
        state, occurrence, paths, proof, parents = self.admission_campaign_state()
        from deploy_test_native_cancelled_parent import REVIEWED_SOURCES
        names = list(REVIEWED_SOURCES)
        for name, expected in REVIEWED_SOURCES.items():
            self.write_reviewed_producer_fixture(name, expected)
        subprocess.run(['git','-C',str(self.root),'add','scripts'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=t','-c','user.email=t@x','commit','-qm','cancel producer'],check=True)
        source=c.source(self.root);campaign=Path(proof['campaign']);summary=c.read(campaign/'summary.json');runs=parents[0].parent
        for index,fleet in enumerate(parents):
            if index in (0,1):continue
            bench=json.loads((fleet/'_batch/benches.json').read_text())[0]['name'];matrix=build_task_matrix([bench+'=real'])
            c.write(fleet/'execution-task-matrix.json',matrix)
            c.write(fleet/'execution-provenance.json',dict(schema_version='cloudbench-execution-provenance-v1',base_sha=source['head'],workspace_patch_sha256='none',config=build_config('cloudbench-fleet-config-v1',['task_count=1','task_matrix_sha256='+matrix['sha256']]),controller_snapshot=dict(schema_version='cloudbench-controller-snapshot-v1',sha256='d'*64)))
        for index in (2,8):
            fleet=runs/('20261103-080441-'+str(2147483000+index));shutil.copytree(parents[0],fleet)
            owner=('a' if index==2 else 'b')*32;life=c.read(fleet/'_batch/lifecycle.json');old=life['fleet_owner_token'];oldrun=life['run_id'];audit=fleet/'teardown-ownership';(audit/'source-audit').unlink()
            meta=(audit/'meta').read_text().replace('fleet_owner_token='+old,'fleet_owner_token='+owner).replace('run_id='+oldrun,'run_id='+fleet.name);(audit/'meta').write_text(meta)
            canonical=self.root/'.git/cloudbench-fleet-audits'/owner;shutil.copytree(audit,canonical)
            seal=hashlib.sha256()
            for p in sorted(audit.rglob('*'),key=lambda p:str(p.relative_to(audit))):
                if p.is_file():
                    for raw in(str(p.relative_to(audit)).encode(),p.read_bytes()):seal.update(len(raw).to_bytes(8,'big'));seal.update(raw)
            (audit/'source-audit').write_text(f'path={canonical}\nsha256={seal.hexdigest()}\n')
            life.update(fleet_owner_token=owner,run_id=fleet.name,audit_sha256=seal.hexdigest(),controller_exit_code=1,status='failed');c.write(fleet/'_batch/lifecycle.json',life)
            disp=c.read(fleet/'_batch/disposable-cleanup.json');disp['owner']=owner;c.write(fleet/'_batch/disposable-cleanup.json',disp)
            c.write(fleet/'_batch/run.json',dict(run_id=fleet.name,status='failed',controller_exit_code=1,tasks=[dict(name='infra-probe',status='INFRA_ERROR',passed=False,lifecycle_stage='released',failure_reason='no current run artifact produced')]))
            c.write(fleet/'_batch/benches.json',[dict(name='infra-probe',mode='REAL')])
            log=Path(summary['jobs'][index]['log']);log.write_text(log.read_text()+f'ref : {source["head"]}\nmode: --infra-probe (strict barrier, no LLM / run_benchmark)\n{self.root}/scripts/run-bench monitor {fleet}\nowner: {owner}; private controller diagnostics stay in this run directory.\n')
        request_path=paths['receipt'].parent/'request.json';request=c.read(request_path);request['source']=source;c.write(request_path,request)
        adapter=c.read(paths['adapter']);adapter.update(source=source,native_command=['bash','scripts/run-bench',*request['checks'],'--runs','1','--concurrency','10','--retry-infra','0','--ref',source['head']]);c.write(paths['adapter'],adapter)
        receipt=state['attempts'][-1]['results'][0];receipt['source']=source;receipt['native_cleanup_reference']['result_sha256']=c.sha_file(paths['adapter']);receipt['cleanup_owner']['native_cleanup_reference']=receipt['native_cleanup_reference'];c.write(paths['receipt'],receipt)
        proof.update(layout='campaign-v1',purpose='isolated-validation',validation_source=source,execution_quiescence={},cancelled_parent_admission=[str(p)for p in parents[:2]],source=source,owner=copy.deepcopy(receipt['cleanup_owner']),receipt_sha256=c.sha_file(paths['receipt']),worker_result_sha256=c.sha_file(paths['adapter']),confirmed_at=time.time())
        files=[request_path,runs.parent/'cli.log',*campaign.rglob('*'),*runs.rglob('*'),*(self.root/name for name in names),*(self.root/'.git/cloudbench-fleet-audits').rglob('*')]
        proof['files']={str(p):c.sha_file(p)for p in files if p.is_file()}
        return state,occurrence,paths,proof,parents

    def test_cancelled_parent_admission_isolated_preserves_all_twelve_and_no_credit(self):
        state,occurrence,paths,proof,parents=self.cancelled_parent_campaign_state();before=copy.deepcopy(state)
        c.reconcile(state,occurrence['id'],proof);entry=next(iter(state['reconciled_owners'].values()))
        self.assertEqual(12,len(entry['participants']));self.assertFalse(entry['credit_granted']);self.assertFalse(entry['cleanup_complete']);self.assertTrue(entry['obligations_preserved']);self.assertTrue(entry['retained_services'])
        self.assertEqual(before['attempts'],state['attempts']);self.assertEqual(before['failures'],state['failures'])

    def test_cancelled_parent_admission_strict_contract_negatives(self):
        state,occurrence,paths,proof,parents=self.cancelled_parent_campaign_state();originals={Path(p):Path(p).read_bytes()for p in proof['files']};before=copy.deepcopy(state);campaign=Path(proof['campaign']);rollback={**originals,paths['receipt']:paths['receipt'].read_bytes(),paths['adapter']:paths['adapter'].read_bytes()}
        for mutation in ('empty','malformed','duplicate','foreign','ordinary','partial','malformed-provenance','maintenance','wrong-pin','boolean-code','nonterminal','no-term','duplicate-term','nonzero-audit','foreign-owner','live-group'):
            with self.subTest(mutation=mutation):
                candidate=copy.deepcopy(proof);added=[];case_state=copy.deepcopy(state)
                try:
                    if mutation=='empty':candidate['cancelled_parent_admission']=[]
                    if mutation=='malformed':candidate['cancelled_parent_admission']=True
                    if mutation=='duplicate':candidate['cancelled_parent_admission']*=2
                    if mutation=='foreign':candidate['cancelled_parent_admission']=[str(self.root/'foreign')]
                    if mutation=='ordinary':candidate.pop('purpose')
                    if mutation in ('partial','malformed-provenance'):
                        for name in (('execution-provenance.json',)if mutation=='partial'else('execution-provenance.json','execution-task-matrix.json')):
                            p=parents[0]/name;c.write(p,{});added.append(p)
                    if mutation=='maintenance':
                        value=c.read(paths['adapter']);value['native_command']+=['--provision-pool','1'];c.write(paths['adapter'],value)
                        receipt=c.read(paths['receipt']);receipt['native_cleanup_reference']['result_sha256']=c.sha_file(paths['adapter']);receipt['cleanup_owner']['native_cleanup_reference']=receipt['native_cleanup_reference'];c.write(paths['receipt'],receipt);candidate.update(owner=receipt['cleanup_owner'],receipt_sha256=c.sha_file(paths['receipt']),worker_result_sha256=c.sha_file(paths['adapter']));case_state['attempts'][-1]['results'][0]=receipt
                    if mutation in ('boolean-code','nonterminal'):
                        value=c.read(campaign/'summary.json');value['jobs'][0]['controller_exit_code'if mutation=='boolean-code'else'status']=True if mutation=='boolean-code'else'running';c.write(campaign/'summary.json',value)
                    if mutation in ('no-term','duplicate-term'):
                        p=Path(c.read(campaign/'summary.json')['jobs'][0]['log']);text=p.read_text();line='⚰️  controller received TERM (02:28:28)\n';p.write_text(text.replace(line,'')if mutation=='no-term'else text+line)
                    if mutation=='nonzero-audit':p=parents[0]/'teardown-ownership/fresh/owned';p.parent.mkdir(exist_ok=True);p.write_text('owned');added.append(p)
                    if mutation=='foreign-owner':p=parents[0]/'_batch/lifecycle.json';value=c.read(p);value['fleet_owner_token']='f'*32;c.write(p,value)
                    candidate['files'].update({str(p):c.sha_file(p)for p in originals if p.exists()});candidate['files'].update({str(p):c.sha_file(p)for p in added})
                    case_before=copy.deepcopy(case_state)
                    if mutation=='wrong-pin':
                        import deploy_test_native_cancelled_parent as native_parent
                        with patch.dict(native_parent.REVIEWED_SOURCES,{'scripts/run-bench-fleet':'0'*64}):
                            with self.assertRaisesRegex(ValueError,'producer changed'):c.reconcile(case_state,occurrence['id'],candidate)
                    elif mutation=='live-group':
                        import deploy_test_native_cleanup as native
                        actual=native.subprocess.check_output
                        def observed(args,*a,**kw):
                            if args[:1]==['ps']:return '999999 310001 S\n'
                            return actual(args,*a,**kw)
                        with patch.object(native.subprocess,'check_output',side_effect=observed):
                            with self.assertRaises(ValueError):c.reconcile(case_state,occurrence['id'],candidate)
                    else:
                        with self.assertRaises(ValueError):c.reconcile(case_state,occurrence['id'],candidate)
                    self.assertEqual(before,state)
                    self.assertEqual(case_before,case_state)
                finally:
                    for p in added:p.unlink()
                    for p,raw in rollback.items():p.write_bytes(raw)

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

    def test_isolated_next_inventory_may_add_cases_without_releasing_original_debt(self):
        state, failure, paths, proof, gate, packet = self.isolated_campaign_state()
        c.reconcile(state, failure['id'], proof)
        state['source'] = proof['validation_source']
        before = copy.deepcopy(state)
        extended = copy.deepcopy(gate)
        extended['checks'] += ['added-payment-' + str(i) for i in range(4)]
        request = dict(token='new-extended-isolated-token', source=state['source'],
                       checks=extended['checks'], skips={})
        bindings = c.isolated_request(state, extended, request, self.root, {})
        entry = next(iter(state['reconciled_owners'].values()))
        self.assertEqual(1, len(bindings))
        self.assertEqual(entry['excluded_resources'], bindings[0]['excluded_resources'])
        self.assertEqual(entry['token'], bindings[0]['original_request_token'])
        self.assertFalse(bindings[0]['credit_granted'])
        self.assertFalse(entry['cleanup_complete'])
        self.assertEqual(before, state)
        # Every selected old and added case remains mandatory in the fresh request.
        for candidate in [dict(request, checks=gate['checks']),
                          dict(request, checks=extended['checks'][1:]),
                          dict(request, token=entry['token']),
                          dict(request, source=dict(head='e'*40, digest='f'*64))]:
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                c.isolated_request(state, extended, candidate, self.root, {})
        # A coherently narrowed gate/request cannot silently omit an old case.
        narrowed = copy.deepcopy(extended); narrowed['checks'] = extended['checks'][1:]
        with self.assertRaisesRegex(ValueError, 'next source/inventory binding'):
            c.isolated_request(state, narrowed, dict(request, checks=narrowed['checks']), self.root, {})
        with self.assertRaisesRegex(ValueError, 'fresh native adapter'):
            c.isolated_request(state, extended, request, self.root, {'CLOUDBENCH_ARCHIVED_REUSE_REQUEST':'old'})
        self.assertEqual(before, state)

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

    def test_large_native_result_binds_without_materializing_logs(self):
        state, occurrence, paths, proof, parents = self.campaign_recon_state()
        path = parents[0] / '_batch/run.json'
        with path.open('wb') as stream:
            stream.write(b'{"native_log":"')
            for _ in range(65):
                stream.write(b'x' * (1024 * 1024))
            stream.write(b'","tasks":[],"status":"failed"}')
        proof['files'][str(path)] = c.sha_file(path)
        before = copy.deepcopy(state['attempts'])
        c.reconcile(state, occurrence['id'], proof)
        self.assertEqual(before, state['attempts'])
        self.assertFalse(state['reconciled_owners'][proof['receipt_sha256']]['credit_granted'])

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

    def early_failure_fixture(self, final_case_a, launcher_exit=None):
        """api reports check a FAIL while still running, then blocks (5 s at most) until its early
        occurrence exists: the RCA request file without a launcher (the /deploy flow), or the
        cycle's own launch with one."""
        import contextlib, io
        signal_file = self.root / '.context' / 'rca-started'
        rca_dir = self.directory / 'rca'
        ready = ('any(pathlib.Path(%r).glob("*.json"))' % str(rca_dir) if launcher_exit is None
                 else 'pathlib.Path(%r).exists()' % str(signal_file))
        gate = ("import os,json,pathlib,sys,time; sys.path.insert(0,%r); import deploy_gate_progress as p\n"
                "p.report('a','FAIL',scope='test',case='a',detail='AssertionError: early')\n"
                "p.report('a','FAIL',scope='case',case='a')\n"  # a second row for the same check
                "e=time.monotonic()+5\n"
                "while not (%s) and time.monotonic()<e: time.sleep(.02)\n"
                "q=json.load(open(os.environ['DEPLOY_GATE_REQUEST']))\n"
                "json.dump({**q,'complete':True,'cleanup_complete':True,"
                "'cases':{'a':%r,'b':'PASS'},'rca_started_before_exit':bool(%s)},open(os.environ['DEPLOY_GATE_RESULT'],'w'))\n"
                "sys.exit(0 if %r=='PASS' else 1)") % (str(Path(c.__file__).resolve().parent), ready, final_case_a,
                                                       ready, final_case_a)
        self.plan['gates'][1].update(command=[sys.executable, '-c', gate], case_protocol=True)
        launcher = None if launcher_exit is None else [
            sys.executable, '-c', "import pathlib,json,sys; sys.exit(%d) if %d else None; "
            "pathlib.Path(%r).touch(); print(json.dumps({'ok':True,'status':'delivered'}))"
            % (launcher_exit, launcher_exit, str(signal_file))]
        self.state = c.initialize(self.plan, self.root); self.state['phase'] = 'initial'
        out = io.StringIO()
        with patch.object(c, 'EARLY_POLL_SECONDS', 0.05, create=True), contextlib.redirect_stdout(out):
            c.run_phase(self.plan, self.state, self.directory, self.root, launcher)
        worker = json.loads((self.directory / 'attempts' / '1' / 'initial' / 'api' / 'result.json').read_text())
        notices = [l for l in out.getvalue().splitlines() if l.startswith('DEPLOY_GATE_EARLY_FAILURE')]
        return out.getvalue(), notices, worker

    def test_failing_test_in_a_running_gate_starts_rca_before_the_gate_ends(self):
        printed, notices, worker = self.early_failure_fixture('FAIL')
        self.assertTrue(worker['rca_started_before_exit'], 'the RCA request must exist while the gate runs')
        self.assertEqual(1, len(notices), notices)  # one notice per failing check, not per row
        early = self.state['early_failures']
        request = self.directory / 'rca' / (early[0]['id'] + '.json')
        self.assertEqual('DEPLOY_GATE_EARLY_FAILURE gate=api test=a status=FAIL check=api/a '
                         f"id={early[0]['id']} rca={request} (start /RCA on this request now)", notices[0])
        # The rca= token, split on whitespace, is the request path itself (2026-11-07: a trailing ':' was not).
        self.assertTrue(Path(notices[0].split('rca=', 1)[1].split()[0]).is_file())
        self.assertTrue(request.is_file())
        self.assertEqual([('api/a', 'reused by final FAIL')], [(f['check'], f['settled']) for f in early])
        failure = next(f for f in self.state['failures'] if f['check'] == 'api/a')
        self.assertEqual(early[0]['id'], failure['id'])  # the final failure keeps the early occurrence
        self.assertEqual([], list((self.directory / 'rca').glob('*.launch.json')))  # the agent owns it
        self.assertEqual('triage', self.state['phase'])

    def test_with_a_cycle_launcher_the_early_rca_launches_without_an_agent_notice(self):
        printed, notices, worker = self.early_failure_fixture('FAIL', launcher_exit=0)
        self.assertTrue(worker['rca_started_before_exit'], 'the cycle must launch the RCA while the gate runs')
        self.assertEqual([], notices)  # the cycle owns this RCA; nothing asks the agent to start one
        self.assertEqual(1, len(list((self.directory / 'rca').glob('*.launch.json'))))  # one RCA, not two
        failure = next(f for f in self.state['failures'] if f['check'] == 'api/a')
        self.assertEqual(self.state['early_failures'][0]['id'], failure['id'])

    def test_with_a_cycle_launcher_a_passing_check_prints_no_stop_request(self):
        printed, notices, worker = self.early_failure_fixture('PASS', launcher_exit=0)
        self.assertEqual('superseded: final PASS', self.state['early_failures'][0]['settled'])
        self.assertNotIn('DEPLOY_GATE_EARLY_SUPERSEDED', printed)  # the agent started nothing to stop

    def test_early_occurrences_per_gate_are_capped_and_the_rest_wait_for_the_result(self):
        gate = {'name': 'backend', 'checks': [f'blackbox:d{i}' for i in range(15)]}
        self.state['round'] = 1
        rows = [progress.row(f'd{i}', 'FAIL', scope='domain') for i in range(12)]
        opened = c.early_failures(self.state, gate, rows, self.directory)
        self.assertEqual(c.EARLY_LIMIT, len(opened))
        self.assertEqual([f'backend/blackbox:d{i}' for i in range(c.EARLY_LIMIT)], [o['check'] for o, _p, _r in opened])
        self.assertEqual([], c.early_failures(self.state, gate, [progress.row('d14', 'FAIL', scope='domain')],
                                              self.directory))

    def test_a_failed_cycle_launch_is_kept_with_the_other_launch_errors(self):
        printed, notices, worker = self.early_failure_fixture('FAIL', launcher_exit=3)
        self.assertEqual([], notices)
        self.assertTrue(any('CalledProcessError' in e or 'exit status 3' in e
                            for e in self.state.get('rca_launch_errors', [])), self.state.get('rca_launch_errors'))

    def test_a_progress_row_naming_no_gate_check_opens_nothing(self):
        gate = {'name': 'api', 'checks': ['a', 'b']}
        self.state['round'] = 1
        row = progress.row('zzz', 'FAIL', case='zzz')
        self.assertEqual([], c.early_failures(self.state, gate, [row], self.directory))
        self.assertNotIn('early_failures', self.state)
        single = {'name': 'ui', 'checks': ['c']}
        [(occurrence, path, _row)] = c.early_failures(self.state, single, [row], self.directory)
        self.assertEqual('ui/c', occurrence['check'])  # a single-check gate owns every row
        self.assertTrue(path.is_file())

    def test_early_failure_whose_gate_then_passes_is_superseded_not_a_failure(self):
        printed, notices, worker = self.early_failure_fixture('PASS')
        self.assertEqual(1, len(notices))
        occurrence = self.state['early_failures'][0]
        self.assertEqual('superseded: final PASS', occurrence['settled'])
        self.assertIn(f"DEPLOY_GATE_EARLY_SUPERSEDED gate=api check=api/a id={occurrence['id']} "
                      'superseded: final PASS', printed)
        self.assertEqual([], [f for f in self.state['failures'] if f['gate'] == 'api'])
        self.assertTrue(self.state['ready'])

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
                  ('timed_out',True),('cancelled',True),('term_sent',[999]),
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


    def set_cases_only_recipe(self):
        self.recipe.clear()
        self.recipe['cases'] = {'deploy-command-structural': {
            'command':['python3','scripts/run-deploy-structural-gates.py','--max-workers','5'],
            'cwd':'.', 'env':{'FIXTURE':'synthetic'}, 'aggregate':True}}
        self.result['recipe_digest'] = c.digest(self.recipe)
        self.result['evidence']['deploy-command-structural']['command'] = self.recipe['cases']['deploy-command-structural']['command']
        self.receipt['execution_binding']['contract_digest'] = c.digest(self.gate)
        self.write_native()

    def test_cases_only_structural_recipe_allows_launch_only(self):
        self.set_cases_only_recipe()
        self.test_reaped_structural_orphans_allow_launch_only_and_keep_all_failure_facts()

    def test_cases_only_recipe_rejects_unknown_services_extra_keys_and_wrong_command(self):
        import copy
        self.set_cases_only_recipe()
        original = copy.deepcopy(self.recipe)
        variants = [{**original,'services':False}, {**original,'unexpected':True}]
        for field, value in [('command',['python3','other.py']), ('cwd','elsewhere'), ('aggregate',False)]:
            changed = copy.deepcopy(original)
            changed['cases']['deploy-command-structural'][field] = value
            variants.append(changed)
        for recipe in variants:
            with self.subTest(recipe=recipe):
                self.recipe.clear()
                self.recipe.update(recipe)
                self.result['recipe_digest'] = c.digest(self.recipe)
                self.receipt['execution_binding']['contract_digest'] = c.digest(self.gate)
                self.write_native()
                before = copy.deepcopy(self.state)
                with self.assertRaises(ValueError):
                    self.reconcile()
                self.assertEqual(before,self.state)

    def test_file_transport_exact_command_allows_launch_only(self):
        self.gate['result_transport'] = 'file'
        self.gate['command'] = self.gate['command'][:-1]
        self.receipt['command'] = self.gate['command']
        self.receipt['execution_binding']['contract_digest'] = c.digest(self.gate)
        self.write_native()
        self.test_reaped_structural_orphans_allow_launch_only_and_keep_all_failure_facts()

    def test_transport_command_pairs_reject_mismatches(self):
        import copy
        original_gate, original_receipt = copy.deepcopy(self.gate), copy.deepcopy(self.receipt)
        command = original_gate['command']
        for transport, args in [('file', command), ('stdout', command[:-1]),
                                ('other', command), ('file', command[:-1] + ['extra']),
                                ('stdout', command + ['extra'])]:
            with self.subTest(transport=transport, args=args):
                self.gate.clear()
                self.gate.update(copy.deepcopy(original_gate), result_transport=transport, command=args)
                self.receipt = {**copy.deepcopy(original_receipt), 'command':args}
                self.receipt['execution_binding']['contract_digest'] = c.digest(self.gate)
                self.write_native()
                before = copy.deepcopy(self.state)
                with self.assertRaises(ValueError):
                    self.reconcile()
                self.assertEqual(before, self.state)

    def test_reaped_sigkill_allows_launch_only_with_all_failure_facts_preserved(self):
        import signal
        self.process['kill_sent'] = [125]
        self.process['reaped'][1]['status'] = signal.SIGKILL
        self.write_native()
        self.test_reaped_structural_orphans_allow_launch_only_and_keep_all_failure_facts()
        self.assertEqual([125], self.process['kill_sent'])
        self.assertEqual('FAIL', self.receipt['status'])
        self.assertFalse(self.result['complete'])

    def test_kill_requires_unique_numeric_term_and_reaped_term_or_kill(self):
        import signal
        original = copy.deepcopy(self.process)
        original['kill_sent'] = [125]
        original['reaped'][1]['status'] = signal.SIGKILL
        variants = [('kill_sent', value) for value in
                    (None, [True], [125.0], ['125'], [-1], [125, 125], [999], [124])]
        variants += [('term_sent', []), ('term_sent', [126]), ('remaining', [125])]
        # Prior SIGTERM negative is explicitly promoted to the positive owning case below.
        # Other terminal signals and ordinary exits remain unsupported.
        for status in (0, signal.SIGINT, signal.SIGPIPE, 127, None, True, 9.0):
            rows = copy.deepcopy(original['reaped'])
            rows[1]['status'] = status
            variants.append(('reaped', rows))
        variants.append(('reaped', [row for row in original['reaped'] if row['pid'] != 125]))
        for key, value in variants:
            with self.subTest(key=key, value=value):
                self.process = {**original, key: value}
                self.write_native()
                before = copy.deepcopy(self.state)
                with self.assertRaises(ValueError):
                    self.reconcile()
                self.assertEqual(before, self.state)

    def test_reaped_term_after_accepted_kill_request_allows_launch_only(self):
        # Real owned child: observe TERM exit without reaping, then request KILL.
        # This proves request-success != cause-of-exit; it does not attribute round41.
        import os, select, signal, time
        read_fd, write_fd = os.pipe()
        pid = os.fork()
        if pid == 0:
            os.close(read_fd)
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            os.write(write_fd, b'R')
            os.close(write_fd)
            while True:
                signal.pause()
        os.close(write_fd)
        reaped = False
        try:
            self.assertTrue(select.select([read_fd], [], [], 2)[0], 'owned child not ready')
            self.assertEqual(b'R', os.read(read_fd, 1))
            os.kill(pid, signal.SIGTERM)
            deadline = time.monotonic() + 2
            observed = None
            while time.monotonic() < deadline:
                observed = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
                if observed is not None:
                    break
                time.sleep(.01)
            self.assertIsNotNone(observed, 'TERM exit not observed within owning bound')
            self.assertEqual((pid, os.CLD_KILLED, signal.SIGTERM),
                             (observed.si_pid, observed.si_code, observed.si_status))
            raw = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
            self.assertEqual('Z', raw[0])
            os.kill(pid, signal.SIGKILL)  # Accepted for this unreaped exact owned zombie.
            joined, status = os.waitpid(pid, 0)
            reaped = True
            self.assertEqual(pid, joined)
            self.assertTrue(os.WIFSIGNALED(status))
            self.assertEqual(signal.SIGTERM, os.WTERMSIG(status))
            self.assertEqual(15, status)
        finally:
            os.close(read_fd)
            if not reaped:
                # Still our unreaped child: this PID cannot be reused before waitpid.
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
        self.process['term_sent'] = [pid]
        self.process['kill_sent'] = [pid]
        self.process['reaped'][1] = {'pid':pid, 'status':status}
        self.write_native()
        original = {n:p.read_bytes() for n,p in self.paths.items()}
        before_attempts = copy.deepcopy(self.state['attempts'])
        before_failures = copy.deepcopy(self.state['failures'])
        self.reconcile()
        self.assertEqual(original, {n:p.read_bytes() for n,p in self.paths.items()})
        self.assertEqual(before_attempts, self.state['attempts'])
        self.assertEqual(before_failures, self.state['failures'])
        self.assertEqual('FAIL', self.receipt['status'])
        self.assertTrue(self.receipt['lingering_group'])
        self.assertTrue(self.process['orphaned_children'])
        self.assertFalse(self.result['complete'])
        self.assertIsNone(c.full_pass_binding(self.state, self.gate))
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])

    def test_valid_reaped_kill_still_refuses_a_current_live_root(self):
        import signal
        self.process['kill_sent'] = [125]
        self.process['reaped'][1]['status'] = signal.SIGKILL
        self.write_native()
        child = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(10)'], cwd=self.worker)
        try:
            before = copy.deepcopy(self.state)
            with self.assertRaises(ValueError):
                self.reconcile()
            self.assertEqual(before, self.state)
        finally:
            child.terminate()
            child.wait(timeout=2)

    def set_native_zero_inner_pass(self):
        self.receipt['native_exit'] = 0
        self.result.update(cases={self.gate['name']:'PASS'}, complete=True)
        self.result['evidence'][self.gate['name']].update(status='PASS', native_exit=0)
        self.process['native_exit'] = 0
        self.process['reaped'][0]['status'] = 0
        self.write_native()

    def test_native_zero_inner_pass_keeps_outer_failure_and_no_credit(self):
        self.set_native_zero_inner_pass()
        self.test_reaped_structural_orphans_allow_launch_only_and_keep_all_failure_facts()
        self.assertEqual('FAIL', self.receipt['status'])
        self.assertIs(self.receipt['complete'], False)
        self.assertEqual({self.gate['name']:'UNVERIFIED'}, self.receipt['cases'])
        self.assertEqual({self.gate['name']:'PASS'}, self.result['cases'])
        self.assertIs(self.result['complete'], True)

    def test_native_exit_pairs_refuse_crossed_outcomes_and_noninteger_exits(self):
        baseline = tuple(copy.deepcopy(row) for row in (self.receipt,self.result,self.process))
        for exit_code in (0, 1):
            variants = [('result_status', 'UNVERIFIED' if exit_code == 0 else 'PASS'),
                        ('result_complete', exit_code == 1),
                        ('case_status', 'UNVERIFIED' if exit_code == 0 else 'PASS'),
                        ('case_exit', 1 - exit_code), ('process_exit', 1 - exit_code),
                        ('child_status', (1 - exit_code) << 8)]
            for invalid in (True, False, 0.0, 1.0, -1, 2):
                variants.extend((field,invalid) for field in ('receipt_exit','case_exit','process_exit'))
            variants.extend([('child_status',False),('child_status',0.0),('child_status',15)])
            for field, value in variants:
                with self.subTest(native_exit=exit_code, field=field, value=value):
                    for row, original in zip((self.receipt,self.result,self.process),baseline):
                        row.clear();row.update(copy.deepcopy(original))
                    if exit_code == 0:
                        self.set_native_zero_inner_pass()
                    case = self.result['evidence'][self.gate['name']]
                    if field == 'result_status': self.result['cases'] = {self.gate['name']:value}
                    elif field == 'result_complete': self.result['complete'] = value
                    elif field == 'case_status': case['status'] = value
                    elif field == 'case_exit': case['native_exit'] = value
                    elif field == 'process_exit': self.process['native_exit'] = value
                    elif field == 'receipt_exit': self.receipt['native_exit'] = value
                    elif field == 'child_status': self.process['reaped'][0]['status'] = value
                    self.write_native()
                    before = copy.deepcopy(self.state)
                    with self.assertRaises(ValueError): self.reconcile()
                    self.assertEqual(before,self.state)


def listening_ports():
    """TCP ports in LISTEN state on this host, read the way the interrupted proof reads them."""
    ports = set()
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        for line in Path(table).read_text().splitlines()[1:]:
            row = line.split()
            if row[3] == '0A': ports.add(int(row[1].rsplit(':', 1)[1], 16))
    return ports


def interrupted_root_port():
    """A root base port no deploy-worktree claim can share, with no listener on its footprint now.

    The interrupted proof refuses while anything on the host listens on the root's
    LISTENER_OFFSETS footprint. This suite runs beside the other deploy gates, which listen on
    their claimed footprints, and every claimable footprint starts at FIRST_BASE_PORT: the
    hard-coded base 15000 shared ports with the live semantic-stack claim 15100 (RCA
    2026-11-05-interrupted-proof-fixture-port-inside-deploy-claim-range).
    """
    import socket
    from deploy_test_isolation import _ports
    listening = listening_ports()
    for base in range(1024, _ports.FIRST_BASE_PORT - _ports.FOOTPRINT_PORTS + 1, _ports.PORTS_PER_WORKTREE):
        if listening.isdisjoint(base + offset for offset in _ports.LISTENER_OFFSETS):
            with socket.socket() as probe:
                try: probe.bind(('127.0.0.1', base))
                except OSError: continue
            return base
    raise AssertionError('no listener-free root footprint lies below the deploy-worktree claim range')


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
        self.port=interrupted_root_port()
        self.gate['env']={'CONDUCTOR_WORKSPACE_NAME':'interrupted-fixture','CONDUCTOR_PORT':str(self.port)}
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

    def test_root_footprint_shares_no_port_with_any_claimable_deploy_worktree(self):
        # Concurrent deploy gates listen on their claims while this suite runs; a shared port makes every proof refuse.
        from deploy_test_isolation import _ports
        root=int(self.gate['env']['CONDUCTOR_PORT'])
        bases=range(_ports.FIRST_BASE_PORT,_ports.LAST_BASE_PORT+1,_ports.PORTS_PER_WORKTREE)
        shared=sorted(port for port in (root+o for o in _ports.LISTENER_OFFSETS)
                      if any(port-o in bases for o in _ports.LISTENER_OFFSETS))
        self.assertEqual([],shared)
        self.assertTrue(listening_ports().isdisjoint(root+o for o in _ports.LISTENER_OFFSETS))

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
            listener.bind(('127.0.0.1',self.port));listener.listen()
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

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux /proc dumpable semantics')
    def test_transiently_unreadable_same_user_process_does_not_block_reconcile(self):
        # The Blacksmith failure (PR #1751): quiet() read /proc/<pid>/cwd of a same-user process that was
        # momentarily unreadable and the PermissionError aborted the proof as "missing or unknown evidence".
        # A real child that clears PR_SET_DUMPABLE is unreadable to its parent exactly like that process.
        body = ("import ctypes,time;libc=ctypes.CDLL(None);libc.prctl(4,0,0,0,0);print('ready',flush=True);"
                "time.sleep(.4);libc.prctl(4,1,0,0,0);time.sleep(60)")
        child = subprocess.Popen([sys.executable, '-c', body], stdout=subprocess.PIPE, text=True, cwd=self.root)
        self.addCleanup(lambda: (child.kill(), child.wait(), child.stdout.close()))
        self.assertEqual('ready', child.stdout.readline().strip())
        c.reconcile(self.state, self.token, self.proof)
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])

    def test_card_admission_foreign_physical_and_unknowns_refuse(self):
        for key,value in [('source','other'),('observed_at',199),('run',str(self.root)),('listeners',[123]),('database_status','PRESENT'),('canonical_reconcile_exit',True)]:
            old=self.physical[key];self.physical[key]=value;self.seal();before=copy.deepcopy(self.state)
            with self.subTest(key=key),self.assertRaises(ValueError):c.reconcile(self.state,self.token,self.proof)
            self.assertEqual(before,self.state);self.physical[key]=old
        self.physical['physical']['unknown_live_userland']=[123];self.seal()
        with self.assertRaises(ValueError):c.reconcile(self.state,self.token,self.proof)
        self.physical['physical']['unknown_live_userland']=[];self.benchmark['state']='running';self.seal()
        with self.assertRaises(ValueError):c.reconcile(self.state,self.token,self.proof)


class NativeJsonEvidence(unittest.TestCase):
    def test_json_chunk_boundaries_and_original_scalar_forms(self):
        import hashlib
        from native_json_evidence import verify_native_object
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'native.json'
            for length in range(65526, 65538):
                for suffix in ['\\', '"', '\n', '\x00', '雪']:
                    value = {'logs': 'x' * length + suffix, 'values': [1, -2, 1.5e-9, True, False, None]}
                    raw = json.dumps(value, ensure_ascii=False).encode()
                    path.write_bytes(raw)
                    verify_native_object(path, hashlib.sha256(raw).hexdigest())

    def test_malformed_or_nonobject_native_json_refuses(self):
        import hashlib
        from native_json_evidence import verify_native_object
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'native.json'
            for raw in [b'[]', b'{', b'{"x":}', b'{}{}', b'{"x":"\\u12"}',
                        b'{"x":01}', b'{"x":true,}', b'{"x":[1,]}', b'{"x":"\xff"}']:
                path.write_bytes(raw)
                with self.subTest(raw=raw), self.assertRaises((ValueError, UnicodeError)):
                    verify_native_object(path, hashlib.sha256(raw).hexdigest())

    def test_original_hash_and_physical_path_remain_required(self):
        import hashlib
        from native_json_evidence import verify_native_object
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'native.json'
            path.write_bytes(b'{}')
            with self.assertRaises(ValueError):
                verify_native_object(path, '0' * 64)
            alias = Path(directory) / 'alias'
            alias.symlink_to(path)
            with self.assertRaises(ValueError):
                verify_native_object(alias, hashlib.sha256(b'{}').hexdigest())


class RelayStartupEvidence(unittest.TestCase):
    """Prospective startup custody; never upgrades an old unsealed attempt."""
    def setUp(self):
        import importlib.util
        self.temp = tempfile.TemporaryDirectory(prefix='relay-startup-proof-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.target = Path(os.environ.get('RELAY_SOURCE_ROOT', str(ROOT))) / 'scripts'
        spec = importlib.util.spec_from_file_location('startup_native', self.target/'deploy_test_native_cleanup.py')
        self.native = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.native)

    def test_refused_version_retains_authenticated_identity(self):
        import asyncio,runpy,socket,struct
        module=runpy.run_path(str(self.target/'cloudbench-shared-relay.py'))
        address=self.base/'fly-agent.sock'
        listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        listener.bind(str(address));address.chmod(0o600);listener.listen(1);listener.settimeout(2)
        self.addCleanup(listener.close)
        broker=module['Broker']({'parent_pid':os.getpid(),'parent_start':module['birth'](os.getpid()),
                                'agent_socket':str(address)},'a'*64,self.base)
        def respond(value):
            errors=[]
            def serve():
                try:
                    stream,_=listener.accept()
                    with stream:
                        stream.settimeout(2)
                        header=stream.recv(2);size=int.from_bytes(header,'little');request=b''
                        while len(request)<size:request+=stream.recv(size-len(request))
                        self.assertEqual(request,b'ping')
                        body=b'ok '+json.dumps(value).encode()
                        stream.sendall(struct.pack('<H',len(body))+body)
                except BaseException as error:errors.append(error)
            thread=threading.Thread(target=serve);thread.start()
            return thread,errors
        def run(value,reason=None):
            thread,errors=respond(value)
            try:
                if reason:
                    with self.assertRaisesRegex(ValueError,reason):asyncio.run(broker.start_agent())
                else:asyncio.run(broker.start_agent())
            finally:
                thread.join(3);self.assertFalse(thread.is_alive());self.assertEqual(errors,[])
        run({'Version':'v0.5.5','PID':os.getpid()},'unsupported Fly agent version')
        record=json.loads((self.base/'startup-agent.json').read_text())
        self.assertEqual(record['agent']['pid'],os.getpid())
        self.assertEqual(record['agent']['birth'],module['birth'](os.getpid()))
        self.assertEqual(record['agent']['version'],'0.5.5')
        self.assertEqual(record['agent']['socket_identity'],[address.stat().st_dev,address.stat().st_ino])
        self.assertEqual(record['authority_sha256'],'a'*64)
        self.assertEqual((self.base/'startup-agent.json').stat().st_mode&0o777,0o600)
        self.assertFalse((self.base/'ready.json').exists())
        (self.base/'startup-agent.json').unlink()
        run({'Version':'v0.5.5','PID':os.getpid()+1},'PING peer differs')
        self.assertFalse((self.base/'startup-agent.json').exists())
        run({'Version':'v0.4.115','PID':os.getpid()})
        self.assertEqual(json.loads((self.base/'startup-agent.json').read_text())['agent']['version'],'0.4.115')

    def test_owned_supervisor_retains_native_failure_and_quiescence(self):
        from deploy_test_process import run_command
        output=self.base/'native.log'
        with output.open('wb')as stream:
            result=run_command([sys.executable,'-c','raise SystemExit(1)'],cwd=self.base,
                               env=os.environ.copy(),output=stream,timeout=5,owned_lifecycle=True)
        self.assertEqual(result,(1,False,False,False))
        receipt=json.loads(Path(str(output)+'.process.json').read_text())
        self.assertIs(receipt['quiescent'],True);self.assertEqual(receipt['remaining'],[])
        self.assertFalse(Path('/proc',str(receipt['supervisor_pid'])).exists())
        self.assertFalse(Path('/proc',str(receipt['child_pid'])).exists())

    def fixture(self):
        import hashlib,time,runpy
        from datetime import datetime,timezone
        token='startup-owned-token';root=self.base;key=hashlib.sha256(token.encode()).hexdigest()
        runs=root/'.context/deploy-cloud'/key/'runs';runs.mkdir(parents=True)
        campaign=runs.parent/'campaigns'/('deploy-'+key);relay=campaign/'shared-relay';relay.mkdir(parents=True)
        def stamp(pid):
            return 'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()[19]
        rows=[]
        for _ in range(5):
            p=subprocess.run([sys.executable,'-c',"import os;from pathlib import Path;print(str(os.getpid())+' '+Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19])"],capture_output=True,text=True,check=True)
            pid,start=p.stdout.split();rows.append({'pid':int(pid),'birth':'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+start})
        parent,bootstrap,broker,agent,publisher=rows;self.live_stamp=stamp
        source={'head':'a'*40,'digest':'b'*64};now=time.time()
        request={'token':token,'source':source,'gate':'smoke','checks':['browser-smoke'],'skips':{}}
        cases={'browser-smoke':'UNVERIFIED'}
        adapter={**request,'cases':cases,'native_exit':1,'started_at':now-5,'runner_log':str(runs.parent/'cli.log'),
                 'native_command':['bash','scripts/run-bench','browser-smoke','--runs','1','--concurrency','1','--retry-infra','0','--ref',source['head']]}
        folder=root/'attempt';folder.mkdir();adapter_path=folder/'result.json'
        def save(path,v):path.write_text(json.dumps(v));path.chmod(0o600)
        save(adapter_path,adapter)
        sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
        reference={'result':str(adapter_path),'result_sha256':sha(adapter_path),'native_directory':str(campaign),'cleanup_complete':False}
        owner={'request_token':token,'worker_root':str(root),'native_cleanup_reference':reference}
        receipt={**request,'cases':cases,'lifecycle':'native-producer','complete':False,'timed_out':False,'cancelled':False,
                 'finished_at':now-1,'worker_result':str(adapter_path),'log':str(folder/'output.log'),'native_cleanup_reference':reference,
                 'cleanup_owner':owner,'lingering_group':True}
        save(folder/'receipt.json',receipt);save(folder/'request.json',request)
        (runs.parent/'cli.log').write_text(str(campaign))
        job={'job_id':'r001-j0001','task':'browser-smoke','run':1,'attempt':1,'attempts':[],'status':'cancelled','log':str(campaign/'r001-j0001.log')}
        summary={'campaign_id':campaign.name,'jobs':[job],'runs':1,'retry_infra':0,'status':'failed','peak_concurrency':0,
                 'shared_inventory_failed':True,'task_count':1,'total_jobs':1,
                 'started_at':datetime.fromtimestamp(now-4,timezone.utc).isoformat(),'finished_at':datetime.fromtimestamp(now-2,timezone.utc).isoformat()}
        save(campaign/'summary.json',summary)
        private='/tmp/cb-relay-abcdefgh'
        authority={'schema':'shared-relay-authority-v1','parent_pid':parent['pid'],'parent_start':parent['birth'],
                   'inventory_directory':str(campaign/'shared-inventory'),'agent_socket':private+'/fly-agent.sock',
                   'source_sha256':hashlib.sha256(b'original-broker').hexdigest()}
        authority['inventory_owner']={'app':'fixture','pid':str(publisher['pid']),'pid_start':publisher['birth'],
                                      'token':'b'*32,'parent_pid':str(parent['pid']),'parent_start':parent['birth']}
        inventory=campaign/'shared-inventory';inventory.mkdir()
        (inventory/'owner').write_text(''.join(k+'='+v+'\n'for k,v in authority['inventory_owner'].items()))
        save(relay/'authority.private.json',authority)
        for name,row in [('bootstrap',bootstrap),('broker',broker)]:
            save(relay/(name+'-owner.json'),{**row,'parent_pid':parent['pid'],'parent_start':parent['birth']})
        save(campaign/'shared-relay-location.json',{'directory':private})
        capture={'schema':'shared-relay-startup-agent-v1','authority_sha256':sha(relay/'authority.private.json'),
                 'parent':parent,'broker':broker,'uid':os.getuid(),'socket':authority['agent_socket'],
                 'agent':{**agent,'version':'0.5.5','socket_identity':[3,4]}}
        save(relay/'startup-agent.json',capture)
        cleanup={'schema':'shared-relay-startup-cleanup-v1','parent':parent,'bootstrap_joined':True,'broker_joined':True,
                 'bootstrap_exit':0,'broker_exit':1,'agent_identity_sha256':sha(relay/'startup-agent.json'),
                 'producer_sha256':hashlib.sha256(b'original-campaign').hexdigest(),
                 'agent_shutdown_verified':False,'agent_retirement_pending':True}
        save(relay/'startup-cleanup.json',cleanup)
        sidecar={'native_exit':1,'child_pid':parent['pid'],'supervisor_pid':999999,'quiescent':True,'orphaned_children':False,
                 'timed_out':False,'cancelled':False,'remaining':[],'term_sent':[],'kill_sent':[],'error':None,
                 'reaped':[{'pid':parent['pid'],'status':256}]}
        save(runs.parent/'cli.log.process.json',sidecar)
        save(campaign/'hub-group.json',{});save(campaign/'hub-group-publication-ack.private.json',{})
        proof={'kind':'native-cloud-cleanup-v1','owner':owner,'request_token':token,'source':source,
               'receipt_sha256':sha(folder/'receipt.json'),'worker_result_sha256':sha(adapter_path),'confirmed_at':now,
               'observed_by':'fixture','layout':'campaign-startup-v1','campaign':str(campaign)}
        self.reseal=lambda:proof.update(files={str(p):sha(p) for p in root.rglob('*')if p.is_file() and p.name not in ('receipt.json','result.json')})
        self.reseal();self.save=save;self.relay=relay;self.campaign=campaign;self.runs=runs;self.proof=proof
        return receipt,owner,proof

    def validate_fixture(self,receipt,owner,proof):
        import types,runpy
        retired_hub=runpy.run_path(str(self.target/'run-bench-campaign.py'))['native_hub_owner_retired']
        original_check_output=subprocess.check_output
        published=types.ModuleType('deploy_test_cloud');published.campaign_published=lambda *_a:True
        with patch.dict(sys.modules,deploy_test_cloud=published),patch.object(self.native.runpy,'run_path',return_value={'native_hub_owner_retired':retired_hub}),\
             patch.object(self.native.subprocess,'check_output',side_effect=lambda args,**kwargs:
                 original_check_output(args,**kwargs) if args[0]=='ps' else
                 b'original-broker' if args[-1].endswith('cloudbench-shared-relay.py') else
                 (ROOT/'scripts/cloudbench-campaign-inventory.sh').read_bytes() if args[-1].endswith('cloudbench-campaign-inventory.sh') else b'original-campaign'):
            state={'plan':{'gates':[{'name':'smoke','native_cloud':True}]},
                   'attempts':[{'results':[receipt]}],
                   'failures':[{'id':'original-failure','gate':'smoke','check':'smoke/browser-smoke',
                                'native_result':'UNVERIFIED','complete':False}]}
            occurrence='original-failure'
            if getattr(self,'stale_operation',False):
                state.update(phase='stale',source=receipt['source'],failures=[])
                state['attempts'][-1]['stale']=True
                occurrence=receipt['token']
            self.native.reconcile(state,occurrence,proof)
            return next(iter(state['reconciled_owners'].values()))

    def test_native_adapter_requests_owned_supervision(self):
        import ast,contextlib,hashlib,time
        code=(self.target/'deploy_test_cloud.py').read_text()
        function=next(n for n in ast.parse(code).body if isinstance(n,ast.FunctionDef) and n.name=='execute')
        calls=[];requested={'checks':['browser-smoke'],'skips':{},'token':'owned','source':{'head':'a'*40},'gate':'smoke'}
        namespace=dict(NAME=__import__('re').compile(r'^[A-Za-z0-9_.-]+$'),source=lambda _r:requested['source'],
                       campaign_width=lambda _c:1,hashlib=hashlib,os=os,time=time,sys=sys,
                       cancellation_handlers=contextlib.nullcontext,write=lambda *_a:None,shared_canary_env=lambda _r:{},
                       run_command=lambda *a,**k:(calls.append((a,k)) or (1,False,False,False)),
                       collect_campaign=lambda *_a:({'browser-smoke':'UNVERIFIED'},{},False,'fixture'))
        exec(compile(ast.Module(body=[function],type_ignores=[]),str(self.target/'deploy_test_cloud.py'),'exec'),namespace)
        namespace['execute'](requested,self.base)
        self.assertEqual(len(calls),1)
        self.assertIs(calls[0][1].get('owned_lifecycle'),True)
        self.assertEqual(calls[0][1]['env'].get('DEPLOY_NATIVE_HUB_JOIN'),'1')

    def test_startup_only_reconciliation_retains_unverified_bytes(self):
        receipt,owner,proof=self.fixture();before=json.dumps(receipt,sort_keys=True)
        result=self.validate_fixture(receipt,owner,proof)
        self.assertFalse(result['credit_granted']);self.assertEqual(result['participants'],[])
        self.assertEqual(json.dumps(receipt,sort_keys=True),before)
        self.assertEqual(receipt['cases'],{'browser-smoke':'UNVERIFIED'})

    def test_startup_publisher_exit_removes_owner_without_losing_captured_identity(self):
        receipt,owner,proof=self.fixture()
        inventory=self.campaign/'shared-inventory'
        original=(inventory/'owner').read_bytes()
        (inventory/'owner').unlink()
        (inventory/'stop').write_bytes(b'')
        scripts=inventory/'scripts';scripts.mkdir()
        producer=scripts/'cloudbench-campaign-inventory.sh'
        producer.write_bytes((ROOT/'scripts/cloudbench-campaign-inventory.sh').read_bytes())
        self.reseal()
        result=self.validate_fixture(receipt,owner,proof)
        self.assertFalse(result['credit_granted'])
        self.assertEqual(result['startup_processes'][-1]['pid'],int(dict(
            line.split('=',1)for line in original.decode().splitlines())['pid']))
        (inventory/'owner').write_bytes(original.replace(b'app=fixture',b'app=foreign'))
        self.reseal()
        with self.assertRaisesRegex(ValueError,'publisher binding'):
            self.validate_fixture(receipt,owner,proof)
        (inventory/'owner').unlink();(inventory/'stop').unlink();self.reseal()
        with self.assertRaisesRegex(ValueError,'noncanonical proof file'):
            self.validate_fixture(receipt,owner,proof)
        (inventory/'stop').write_bytes(b'');producer.write_bytes(b'unsupported publisher');self.reseal()
        with self.assertRaisesRegex(ValueError,'publisher removal contract'):
            self.validate_fixture(receipt,owner,proof)

    def test_stale_full_attempt_reconciles_exact_startup_operation_without_credit(self):
        receipt,owner,proof=self.fixture();self.stale_operation=True
        receipt['executed']=True
        self.save(Path(receipt['log']).parent/'receipt.json',receipt)
        import hashlib
        proof['receipt_sha256']=hashlib.sha256((Path(receipt['log']).parent/'receipt.json').read_bytes()).hexdigest()
        result=self.validate_fixture(receipt,owner,proof)
        self.assertFalse(result['credit_granted'])
        self.assertEqual(result['occurrence'],receipt['token'])
        proof['request_token']='foreign'
        with self.assertRaisesRegex(ValueError,'stale operation identity'):
            self.validate_fixture(receipt,owner,proof)

    def test_original_fly_logs_allow_only_absent_same_boot_startup_agent(self):
        import ast,datetime,hashlib
        receipt,owner,proof=self.fixture()
        capture=json.loads((self.relay/'startup-agent.json').read_text())
        (self.relay/'startup-agent.json').unlink();(self.runs.parent/'cli.log.process.json').unlink()
        self.save(self.relay/'startup-cleanup.json',dict(bootstrap_joined=True,broker_joined=True,
                                                       agent_shutdown_verified=False,agent_retirement_pending=True))
        (self.relay/'broker.private.log').write_text('unsupported Fly agent version\n')
        pid=capture['agent']['pid'];socket=capture['socket']
        native=self.base/'native';native.mkdir()
        bootstrap=native/'bootstrap.log';(native/'agent-logs').mkdir();agent=native/'agent-logs/123.log'
        bootstrap.write_text(f'DEBUG determined working directory: "{self.base}"\nDEBUG started agent process (pid: {pid}, log: {agent})\nDEBUG failed to connect to target: dial unix {socket}: operation was canceled\n')
        when=datetime.datetime.fromisoformat(json.loads((self.campaign/'summary.json').read_text())['started_at'])+datetime.timedelta(seconds=.5)
        stamp=when.strftime('%Y/%m/%d %H:%M:%S.%f')
        payload=('ok '+json.dumps({'PID':pid,'Version':'0.5.5'})+'\n').encode()
        raw=(len(payload).to_bytes(2,'little')+payload).decode('latin1')
        import json as json_module
        quoted=json_module.dumps(raw)
        agent.write_text(f'{stamp} srv OK {pid}\n{stamp} #1 -> ({len(raw)}) {quoted}\n{stamp} srv parent process exited; shutting down\n{stamp} #1 failed writing: write unix {socket}->@: write: broken pipe\n{stamp} srv QUIT\n')
        proof['fly_native_logs']={'bootstrap':str(bootstrap),'agent':str(agent),'timezone':'UTC'};self.reseal()
        result=self.validate_fixture(receipt,owner,proof)
        self.assertFalse(result['credit_granted']);self.assertTrue(result['startup_processes'][3]['native_log_identity'])
        self.assertNotIn('birth',result['startup_processes'][3])
        saved_logs=dict(proof['fly_native_logs'])
        for fields,reason in [({k:v for k,v in saved_logs.items() if k!='timezone'},'timezone required'),
                              ({**saved_logs,'timezone':'Unknown/Original'},'timezone unavailable'),
                              ({**saved_logs,'timezone':'America/New_York'},'log clock')]:
            proof['fly_native_logs']=fields
            with self.assertRaisesRegex(ValueError,reason):self.validate_fixture(receipt,owner,proof)
        foreign=native/'foreign.log';foreign.write_bytes(agent.read_bytes())
        proof['fly_native_logs']={**saved_logs,'agent':str(foreign)};self.reseal()
        with self.assertRaisesRegex(ValueError,'bootstrap binding'):self.validate_fixture(receipt,owner,proof)
        foreign.unlink();proof['fly_native_logs']=saved_logs;self.reseal()
        prior=agent.read_text()
        for mutation,reason in [(prior.replace(str(pid),str(os.getpid())),'bootstrap|PING|shutdown'),
                                (prior.replace('srv QUIT','missing shutdown'),'shutdown chain'),
                                (prior.replace(socket,'/foreign/socket'),'shutdown chain')]:
            agent.write_text(mutation);self.reseal()
            with self.assertRaisesRegex(ValueError,reason):self.validate_fixture(receipt,owner,proof)
        agent.write_text(prior);self.reseal()
        live=bootstrap.read_text().replace(str(pid),str(os.getpid()))
        bootstrap.write_text(live);agent.write_text(prior.replace(str(pid),str(os.getpid())));self.reseal()
        with self.assertRaisesRegex(ValueError,'PID present'):self.validate_fixture(receipt,owner,proof)

    def test_startup_reconciliation_rejects_missing_or_live_or_dispatched_evidence(self):
        receipt,owner,proof=self.fixture()
        paths=[self.relay/'startup-agent.json',self.runs.parent/'cli.log.process.json',self.campaign/'summary.json']
        original={p:p.read_bytes()for p in self.base.rglob('*')if p.is_file()}
        def alter(path,**kwargs):self.save(path,{**json.loads(path.read_text()),**kwargs})
        def live_agent():
            import hashlib
            alter(paths[0],agent={'pid':os.getpid(),'birth':self.live_stamp(os.getpid()),'version':'0.5.5','socket_identity':[3,4]})
            alter(self.relay/'startup-cleanup.json',agent_identity_sha256=hashlib.sha256(paths[0].read_bytes()).hexdigest())
        def started_job():
            summary=json.loads(paths[2].read_text());summary['jobs'][0]['started_at']='2026-01-01';self.save(paths[2],summary)
        mutations=[('missing-capture',lambda:paths[0].unlink(),None),
                   ('missing-sidecar',lambda:paths[1].unlink(),None),
                   ('unjoined-supervisor',lambda:alter(paths[1],quiescent=False),'process closure'),
                   ('forced-cleanup',lambda:alter(paths[1],term_sent=[123]),'process closure'),
                   ('dispatched-job',lambda:alter(paths[2],peak_concurrency=1),'startup inventory'),
                   ('started-job',started_job,'dispatched job'),
                   ('live-agent',live_agent,'exact process remains live'),
                   ('reached-ready',lambda:self.save(self.relay/'ready.json',{}),'reached relay admission'),
                   ('bad-source',lambda:proof.update(source={'head':'f'*40,'digest':'b'*64}),'request identity')]
        for name,mutate,reason in mutations:
            with self.subTest(name=name):
                for p in self.base.rglob('*'):
                    if p.is_file() and p not in original:p.unlink()
                for p,raw in original.items():p.write_bytes(raw)
                proof['source']=receipt['source'];mutate();self.reseal()
                if reason is None:
                    with self.assertRaisesRegex(ValueError,'noncanonical proof file'):self.validate_fixture(receipt,owner,proof)
                else:
                    with self.assertRaisesRegex(ValueError,reason):self.validate_fixture(receipt,owner,proof)
        for p,raw in original.items():p.write_bytes(raw)
        proof['source']=receipt['source'];self.reseal()
        proof['files'][str(paths[0])]='0'*64
        with self.assertRaisesRegex(ValueError,'hash mismatch'):
            self.validate_fixture(receipt,owner,proof)

    def test_native_campaign_joins_exact_hub_before_supervisor_exit(self):
        result=subprocess.run([sys.executable,str(ROOT/'scripts/tests/fixtures/native_campaign_hub_join.py'),
                               str(self.target/'run-bench-campaign.py')],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)

    def test_native_retired_hub_owner_refuses_foreign_paths_live_pids_and_reused_groups(self):
        import runpy
        module=runpy.run_path(str(self.target/'run-bench-campaign.py'))
        runs=self.base/'.context/deploy-cloud'/('a'*64)/'runs';hub=runs/'_hub';hub.mkdir(parents=True)
        child=subprocess.run([sys.executable,'-c',
            "import os;from pathlib import Path;print(str(os.getpid())+' '+Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19])"],
            start_new_session=True,capture_output=True,text=True,check=True)
        pid,ticks=child.stdout.split();token='b'*32;port='12345'
        owner=hub/f'agent-link-server.{port}.{token}.owner'
        boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        fields=dict(version='1',pid=pid,pgid=pid,pid_start=f'proc-start:{boot}:{ticks}',
            owner_token=token,command=str(self.base/'agents/benchmarks/agent_link_server.py'),
            argv_sha256='c'*64,root=str(runs),runs_root=str(runs),repo_root=str(self.base),
            context_dir=str(hub),host='127.0.0.1',port=port,status='starting')
        def save(values):
            owner.write_text(''.join(k+'='+v+'\n' for k,v in values.items()));owner.chmod(0o644)
        retired=module['native_hub_owner_retired'];save(fields)
        self.assertTrue(retired(owner,runs,self.base))
        with patch.object(subprocess,'check_output',return_value=pid+'\n'):
            self.assertFalse(retired(owner,runs,self.base),'a reused or remaining group must not be skipped')
        for key,value in [('repo_root',str(self.base/'foreign')),('command','/foreign/hub.py'),
                          ('root','/foreign'),('owner_token','d'*32),('port','23456'),
                          ('pgid',str(int(pid)+1)),('pid_start','unknown'),('status','unknown')]:
            with self.subTest(key=key):
                save({**fields,key:value})
                with self.assertRaises(ValueError):retired(owner,runs,self.base)
        save({**fields,'pid':str(os.getpid()),'pgid':str(os.getpid())})
        live_owner=hub/f'agent-link-server.{port}.{token}.owner'
        self.assertFalse(retired(live_owner,runs,self.base),'live/reused PID must use original live protocol')
        save(fields);owner.unlink();owner.symlink_to(self.base/'foreign-owner')
        with self.assertRaises(ValueError):retired(owner,runs,self.base)

    def test_native_hub_join_attempts_later_owners_after_each_failure(self):
        import runpy
        module=runpy.run_path(str(self.target/'run-bench-campaign.py'))
        runs=self.base/'.context/deploy-cloud'/('a'*64)/'runs'
        hub=runs/'_hub';hub.mkdir(parents=True)
        for index,content in enumerate(['missing=port\n','port=2\n','port=3\n']):
            (hub/f'agent-link-server.{index}.owner').write_text(content)
        calls=[]
        def terminate(command,**_kwargs):
            calls.append(command[-4])
            if command[-4]=='2':raise subprocess.CalledProcessError(1,command)
        with patch.dict(os.environ,{'DEPLOY_NATIVE_HUB_JOIN':'1','CLOUDBENCH_RUNS_ROOT':str(runs)}), \
             patch.object(subprocess,'run',side_effect=terminate), \
             patch.dict(module['join_native_hubs'].__globals__,native_hub_owner_retired=lambda *_:False):
            with self.assertRaisesRegex(ValueError,'native Hub join incomplete'):
                module['join_native_hubs'](self.base,runs.parent/'campaigns'/('deploy-'+runs.parent.name))
        self.assertEqual(calls,['2','3'])

    def campaign_hub_cleanup_failure(self, cancel):
        import runpy,signal
        module=runpy.run_path(str(self.target/'run-bench-campaign.py'))
        namespace=module['main'].__globals__
        scripts=self.base/'scripts';scripts.mkdir()
        (scripts/'run-bench').write_text('exit 0\n')
        fixture_module=runpy.run_path(str(self.target/'tests/fixtures/campaign_cleanup_fixture.py'))
        cleanup=fixture_module['CampaignCleanupFixture'](self.base,self.target.parent)
        self.addCleanup(cleanup.close)
        arguments=['campaign','--root',str(self.base),'--runs','1','--concurrency','2',
                   '--retry-infra','0','--task=fixture']
        published=[]
        def publish(_workspace,_directory,summary,**_kwargs):
            if _kwargs.get('live'):return True
            published.append(summary['status'])
            if cancel:
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM,None)
                return False
            return True
        def refuse_inventory(*_args,**_kwargs):
            raise RuntimeError('fixture refuses before controller admission')
        def refuse_join(*_args):raise ValueError('fixture Hub join failed')
        replacements=dict(campaign_workspace=lambda root,_forward:(root,None),provider_capacity_refusal=lambda _n:None,
            scorecard_hooks=lambda:None,start_shared_inventory=refuse_inventory,
            publish_campaign_group=publish,join_native_hubs=refuse_join,
            infra_stop_predicate=lambda:lambda *_args:False)
        handlers={number:signal.getsignal(number)for number in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP)}
        try:
            with cleanup.scope(),patch.dict(namespace,replacements),patch.object(sys,'argv',arguments),patch.dict(os.environ,{
                'RUN_BENCH_CAMPAIGN_ROOT':str(self.base/'campaigns'),'RUN_BENCH_CAMPAIGN_ID':'hub-failure',
                'CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY':'1' if cancel else '0','CLOUDBENCH_STRICT_BARRIER':'0',
                'BENCHMARK_HUB_GROUP_RUN_ID':'','BENCHMARK_HUB_PARENT_RUN_ID':''}):
                code=module['main']()
        finally:
            for number,handler in handlers.items():signal.signal(number,handler)
        summary=json.loads((self.base/'campaigns/hub-failure/summary.json').read_text())
        return code,summary,published

    def test_publication_cancellation_stays_cancelled_when_hub_join_fails(self):
        code,summary,_published=self.campaign_hub_cleanup_failure(True)
        self.assertEqual(code,143)
        self.assertEqual(summary['status'],'cancelled')
        self.assertTrue(summary['shared_transport_cleanup_pending'])
        self.assertEqual(summary['peak_concurrency'],0)
        self.assertTrue(all(job.get('controller_pid')is None for job in summary['jobs']))

    def test_successful_campaign_still_fails_when_hub_join_fails(self):
        code,summary,published=self.campaign_hub_cleanup_failure(False)
        self.assertEqual(published,['passed'])
        self.assertNotEqual(code,0)
        self.assertEqual(summary['status'],'failed')
        self.assertTrue(summary['shared_transport_cleanup_pending'])

    def test_campaign_persists_fixed_commands_before_any_controller_admission(self):
        import runpy
        module=runpy.run_path(str(self.target/'run-bench-campaign.py'))
        namespace=module['main'].__globals__
        tasks=['fixture-'+str(i)for i in range(600)]
        arguments=['campaign','--root',str(self.base),'--runs','1','--concurrency','600','--retry-infra','0',
                   '--forward-arg=--ref','--forward-arg='+'a'*40,*['--task='+name for name in tasks]]
        def refuse_inventory(*_args,**_kwargs):raise RuntimeError('fixture refuses before controller admission')
        replacements=dict(campaign_workspace=lambda root,_forward:(root,None),provider_capacity_refusal=lambda _n:None,
                          scorecard_hooks=lambda:None,start_shared_inventory=refuse_inventory,
                          publish_campaign_group=lambda *_a,**_kw:True)
        with patch.dict(namespace,replacements),patch.object(sys,'argv',arguments),             patch.dict(os.environ,{'RUN_BENCH_CAMPAIGN_ROOT':str(self.base/'campaigns'),'RUN_BENCH_CAMPAIGN_ID':'command-proof'}):
            self.assertEqual(module['main'](),1)
        summary=json.loads((self.base/'campaigns/command-proof/summary.json').read_text())
        self.assertEqual(summary['peak_concurrency'],0)
        self.assertEqual(len(summary['jobs']),600)
        for job in summary['jobs']:
            self.assertEqual(job.get('controller_command'),['bash',str(self.base/'scripts/run-bench'),job['task'],'--ref','a'*40,'--foreground'])
            self.assertIsNone(job.get('controller_pid'))

    def preallocation_fixture(self):
        import hashlib,shutil,time
        receipt,owner,proof=self.fixture()
        (self.relay/'startup-cleanup.json').unlink()
        capture=json.loads((self.relay/'startup-agent.json').read_text())
        authority=json.loads((self.relay/'authority.private.json').read_text())
        ready=dict(agent=capture['agent'],authority_sha256=capture['authority_sha256'],
                   pid=capture['broker']['pid'],birth=capture['broker']['birth'],
                   socket='/tmp/cb-relay-abcdefgh/control.sock')
        self.save(self.relay/'ready.json',ready)
        self.save(self.relay/'serve.once.json',{k:ready[k]for k in ('authority_sha256','pid','birth')})
        (self.relay/'broker.private.log').write_text('{"stopped": true}\n')
        def retired():
            r=subprocess.run([sys.executable,'-c',"import os;from pathlib import Path;print(str(os.getpid())+' '+Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19])"],text=True,capture_output=True,check=True)
            pid,start=r.stdout.split();return dict(pid=int(pid),birth='proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+start)
        controller,hub_process=retired(),retired()
        hub=self.runs/'_hub';hub.mkdir()
        hub_owner=hub/('agent-link-server.8765.'+'b'*32+'.owner')
        fields=dict(version='1',status='live-transfer-required',pid=str(hub_process['pid']),pgid=str(hub_process['pid']),
                    pid_start=hub_process['birth'],owner_token='b'*32,argv_sha256='c'*64,
                    root=str(self.runs),runs_root=str(self.runs),repo_root=str(self.base),context_dir=str(hub),
                    command=str(self.base/'agents/benchmarks/agent_link_server.py'))
        text=lambda p,v:p.write_text(''.join(k+'='+str(x)+'\n'for k,x in v.items()))
        text(hub_owner,fields)
        fleet=self.runs/('20261106-090000-'+str(controller['pid']));batch=fleet/'_batch';batch.mkdir(parents=True)
        audit=fleet/'teardown-ownership';audit.mkdir()
        token='c'*32
        text(audit/'meta',dict(version='1',fleet_owner_token=token,run_id=fleet.name,app='fixture',workspace_root=str(self.base),
            status='provider-teardown-verified',hub_disposition='retained-exact-owner-transfer-required',hub_owner_file=str(hub_owner),
            hub_owner_token='b'*32,hub_pid=fields['pid'],hub_pid_start=fields['pid_start'],hub_argv_sha256=fields['argv_sha256']))
        (audit/'provider-teardown-verified.epoch').write_text(str(time.time()-2.8))
        for name in ['owned-clones.ids','owned-clones.names']:(audit/name).write_bytes(b'')
        canonical=self.base/'.git/cloudbench-fleet-audits'/token;canonical.parent.mkdir(parents=True);shutil.copytree(audit,canonical)
        seal=hashlib.sha256()
        for path in sorted(audit.iterdir()):
            for raw in [path.name.encode(),path.read_bytes()]:seal.update(len(raw).to_bytes(8,'big'));seal.update(raw)
        text(audit/'source-audit',dict(path=str(canonical),sha256=seal.hexdigest()))
        self.save(batch/'lifecycle.json',dict(version=1,fleet_owner_token=token,run_id=fleet.name,workspace_root=str(self.base),
            status='failed',controller_exit_code=1,audit_sha256=seal.hexdigest(),hub_publication_failed=False))
        self.save(batch/'benches.json',[dict(name='browser-smoke',mode='REAL')])
        self.save(batch/'run.json',dict(run_id=fleet.name,controller_exit_code=1,status='failed',tasks=[dict(name='browser-smoke',
            status='INFRA_ERROR',passed=False,failure_reason='no current run artifact produced',lifecycle_stage='released')]))
        self.save(batch/'disposable-cleanup.json',dict(schema='disposable-cleanup-v1',owner=token,guest_cleanup_missing=False,runtime_evidence_missing=False))
        summary=json.loads((self.campaign/'summary.json').read_text())
        summary['jobs'][0].update(status='failed',controller_pid=controller['pid'],controller_exit_code=1,
            controller_command=['bash',str(self.base/'scripts/run-bench'),'browser-smoke','--ref',receipt['source']['head'],'--foreground'])
        summary['peak_concurrency']=1;summary.pop('shared_inventory_failed');self.save(self.campaign/'summary.json',summary)
        (self.campaign/'r001-j0001.log').write_text(f'{self.base}/scripts/run-bench monitor {fleet}\nowner: {token}; private controller diagnostics stay in this run directory.\n')
        sidecar=json.loads((self.runs.parent/'cli.log.process.json').read_text())
        sidecar.update(orphaned_children=True,term_sent=[hub_process['pid']],reaped=[*sidecar['reaped'],dict(pid=hub_process['pid'],status=15)])
        self.save(self.runs.parent/'cli.log.process.json',sidecar)
        adapter_path=Path(receipt['worker_result']);adapter=json.loads(adapter_path.read_text())
        receipt['started_at']=adapter['started_at']
        adapter.update(fleet_directory=None,reason='cloud command interrupted or source changed');self.save(adapter_path,adapter)
        reference=receipt['native_cleanup_reference'];reference['native_directory']=None
        reference['result_sha256']=hashlib.sha256(adapter_path.read_bytes()).hexdigest()
        proof['worker_result_sha256']=reference['result_sha256'];proof['layout']='campaign-preallocation-v1'
        self.save(Path(receipt['log']).parent/'receipt.json',receipt)
        proof['receipt_sha256']=hashlib.sha256((Path(receipt['log']).parent/'receipt.json').read_bytes()).hexdigest()
        self.reseal();return receipt,owner,proof,fleet

    def pending_hub_fixture(self):
        receipt,owner,proof,fleet=self.preallocation_fixture()
        summary=json.loads((self.campaign/'summary.json').read_text())
        summary['shared_transport_cleanup_pending']=True;self.save(self.campaign/'summary.json',summary)
        side=self.runs.parent/'cli.log.process.json';value=json.loads(side.read_text())
        value.update(orphaned_children=False,term_sent=[]);self.save(side,value)
        owners=sorted((self.runs/'_hub').glob('*.owner'))
        for path in owners:
            fields=dict(line.split('=',1)for line in path.read_text().splitlines())
            fields.update(host='127.0.0.1',port='8765')
            path.write_text(''.join(k+'='+v+'\n'for k,v in fields.items()));path.chmod(0o444)
        proof['current_hub_retirement']={'kind':'current-native-hub-retirement-v1','owners':list(map(str,owners))}
        self.reseal();return receipt,owner,proof,fleet

    def test_pending_preallocation_hubs_require_current_exact_retirement_without_rewriting_summary(self):
        receipt,owner,proof,fleet=self.pending_hub_fixture()
        before=(self.campaign/'summary.json').read_bytes()
        result=self.validate_fixture(receipt,owner,proof)
        self.assertFalse(result['credit_granted'])
        self.assertEqual(before,(self.campaign/'summary.json').read_bytes())
        self.assertEqual(result['current_hub_retirement'],proof['current_hub_retirement'])

    def test_pending_preallocation_hubs_refuse_unbound_inventory_or_unknown_supervisor_termination(self):
        receipt,owner,proof,fleet=self.pending_hub_fixture()
        original=copy.deepcopy(proof['current_hub_retirement'])
        for marker in [None,{'kind':'foreign','owners':original['owners']},
                       {**original,'owners':[]},{**original,'owners':original['owners']*2}]:
            proof['current_hub_retirement']=marker
            with self.assertRaises(ValueError):self.validate_fixture(receipt,owner,proof)
        proof['current_hub_retirement']=original
        side=self.runs.parent/'cli.log.process.json';value=json.loads(side.read_text())
        for change in [dict(orphaned_children=True),dict(term_sent=[os.getpid()]),dict(quiescent=False)]:
            self.save(side,{**value,**change});self.reseal()
            with self.assertRaises(ValueError):self.validate_fixture(receipt,owner,proof)
        self.save(side,value);self.reseal()
        path=Path(original['owners'][0]);content=path.read_text();path.chmod(0o644)
        path.write_text(content.replace('repo_root='+str(self.base),'repo_root=/foreign'));path.chmod(0o444);self.reseal()
        with self.assertRaises(ValueError):self.validate_fixture(receipt,owner,proof)

    def test_preallocation_campaign_reconciliation_keeps_original_unverified(self):
        receipt,owner,proof,fleet=self.preallocation_fixture()
        before=json.dumps(receipt,sort_keys=True)
        result=self.validate_fixture(receipt,owner,proof)
        self.assertEqual(result['participants'],[str(fleet)])
        self.assertFalse(result['credit_granted']);self.assertEqual(before,json.dumps(receipt,sort_keys=True))

    def test_preallocation_campaign_refuses_execution_live_or_changed_ownership(self):
        receipt,owner,proof,fleet=self.preallocation_fixture()
        original={p:p.read_bytes()for p in self.base.rglob('*')if p.is_file()}
        mutations=[('appended-foreign-ref',lambda:(self.campaign/'r001-j0001.log').write_text((self.campaign/'r001-j0001.log').read_text()+'ref : '+'f'*40+'\n'),'foreign log ref'),
                   ('masked-foreign-ref',lambda:(self.campaign/'r001-j0001.log').write_text('ref : '+'f'*40+'\nref : '+receipt['source']['head']+'\n'+(self.campaign/'r001-j0001.log').read_text()),'foreign log ref'),
                   ('foreign-ref',lambda:(self.campaign/'r001-j0001.log').write_text('ref : '+'f'*40+'\n'+(self.campaign/'r001-j0001.log').read_text()),'foreign log ref'),
                   ('missing-command',lambda:self.save(self.campaign/'summary.json',{**json.loads((self.campaign/'summary.json').read_text()),'jobs':[{k:v for k,v in json.loads((self.campaign/'summary.json').read_text())['jobs'][0].items()if k!='controller_command'}]}),'unsupported historical preallocation dispatch'),
                   ('execution',lambda:self.save(fleet/'execution-provenance.json',{}),'execution evidence present'),
                   ('owned-clone',lambda:(fleet/'teardown-ownership/owned-clones.ids').write_text('unknown\n'),'audit seal'),
                   ('live-relay',lambda:self.save(self.relay/'broker-owner.json',dict(pid=os.getpid(),birth=self.live_stamp(os.getpid()),parent_pid=1,parent_start='foreign')),'relay custody'),
                   ('unknown-drain',lambda:self.save(self.runs.parent/'cli.log.process.json',{**json.loads((self.runs.parent/'cli.log.process.json').read_text()),'term_sent':[os.getpid()]}),'unexpected supervised termination')]
        for name,change,reason in mutations:
            with self.subTest(name=name):
                for p in self.base.rglob('*'):
                    if p.is_file()and p not in original:p.unlink()
                for p,raw in original.items():p.write_bytes(raw)
                change();self.reseal()
                with self.assertRaisesRegex(ValueError,reason):self.validate_fixture(receipt,owner,proof)




class CleanupPrepareEvidence(unittest.TestCase):
    """Original zero-start ticket refusal keeps execution UNKNOWN and proof closure exact."""
    setUp = RelayStartupEvidence.setUp
    fixture = RelayStartupEvidence.fixture

    def prepare_fixture(self, producer_head='abd6e81ee0f0c5cbcd88a4a7f11b4a8920740077'):
        import hashlib
        receipt, owner, proof = self.fixture()
        (self.relay / 'startup-cleanup.json').unlink()
        capture = json.loads((self.relay / 'startup-agent.json').read_text())
        ready = dict(agent=capture['agent'], authority_sha256=capture['authority_sha256'],
                     pid=capture['broker']['pid'], birth=capture['broker']['birth'],
                     socket='/tmp/cb-relay-abcdefgh/control.sock')
        self.save(self.relay/'ready.json', ready)
        self.save(self.relay/'serve.once.json', {k: ready[k] for k in ('authority_sha256', 'pid', 'birth')})
        (self.relay/'broker.private.log').write_text('{"stopped": true}\n')
        folder = Path(receipt['log']).parent
        request = json.loads((folder/'request.json').read_text())
        tasks = ['fixture-task-%02d' % i for i in range(14)]
        request['checks'] = tasks
        self.save(folder/'request.json', request)
        cases = dict.fromkeys(tasks, 'UNVERIFIED')
        receipt.update(checks=tasks, cases=cases)
        adapter = json.loads(Path(receipt['worker_result']).read_text())
        adapter.update(checks=tasks, cases=cases, complete=False, cleanup_complete=False,
                       fleet_directory=str(self.campaign), native_command=['bash', 'scripts/run-bench', *tasks,
                       '--runs', '1', '--concurrency', '14', '--retry-infra', '0', '--ref', receipt['source']['head']])
        self.save(Path(receipt['worker_result']), adapter)
        reference = receipt['native_cleanup_reference']
        reference['result_sha256'] = hashlib.sha256(Path(receipt['worker_result']).read_bytes()).hexdigest()
        self.save(folder/'receipt.json', receipt)
        proof.update(receipt_sha256=hashlib.sha256((folder/'receipt.json').read_bytes()).hexdigest(),
                     worker_result_sha256=reference['result_sha256'], layout='campaign-cleanup-prepare-v1')
        summary = json.loads((self.campaign/'summary.json').read_text())
        summary.pop('shared_inventory_failed')
        summary.update(concurrency=14, task_count=14, total_jobs=14, cleanup_ticket_failure='prepare',
                       cleanup_cohorts=[dict(cohort_id='c001',status='queued',ready_count=0,expected_count=14,
                                            failed_count=0,released_count=0,released_at=None)],
                       jobs=[dict(job_id='r001-j%04d' % (i+1), task=task, run=1, attempt=1, attempts=[],
                           status='cancelled', controller_pid=None, controller_exit_code=None, started_at=None,
                           finished_at=None, wall_clock_seconds=None, log=str(self.campaign/('r001-j%04d.log' % (i+1))),
                           controller_command=['bash',str(self.base/'scripts/run-bench'),task,'--ref',receipt['source']['head'],'--foreground'])
                           for i,task in enumerate(tasks)])
        self.save(self.campaign/'summary.json',summary)
        cohort = self.campaign/'cleanup-cohorts/c001'
        (cohort/'cleanup-budget').mkdir(parents=True)
        (cohort/'ready').mkdir()
        (cohort.parent/'parent.lock').touch(); (cohort/'cleanup-budget/prepare.lock').touch()
        self.save(cohort/'manifest.json',dict(cohort_id='c001',jobs=dict.fromkeys(j['job_id'] for j in summary['jobs'])))
        (self.base/'.git/cloudbench-fleet-ownership').mkdir(parents=True,mode=0o700)
        scripts = self.base/'scripts'; scripts.mkdir()
        for name in ('run-bench-campaign.py','cloudbench-cleanup-tickets.py','run-bench','deploy_test_cloud.py'):
            data = subprocess.check_output(['git','-C',str(ROOT),'show',producer_head+':scripts/'+name])
            (scripts/name).write_bytes(data)
        self.reseal()
        return receipt,owner,proof

    def validate_prepare_fixture(self,receipt,owner,proof):
        import types
        original = subprocess.check_output
        published = types.ModuleType('deploy_test_cloud'); published.campaign_published=lambda *_a:getattr(self,'published',True)
        def source(args,**kwargs):
            if args[0]=='ps': return original(args,**kwargs)
            if args[-1].endswith('cloudbench-shared-relay.py'): return b'original-broker'
            return (self.base/'scripts'/args[-1].rsplit('/',1)[-1]).read_bytes()
        with patch.dict(sys.modules,deploy_test_cloud=published), patch.object(self.native.runpy,'run_path',return_value={}), \
             patch.object(self.native.subprocess,'check_output',side_effect=source):
            state={'plan':{'gates':[{'name':'smoke','native_cloud':True}]},'attempts':[{'results':[receipt]}],
                   'failures':[{'id':'prepare-failure','gate':'smoke','check':'smoke/'+receipt['checks'][0],
                                'native_result':'UNVERIFIED','complete':False}]}
            original_state=copy.deepcopy(state)
            self.native.reconcile(state,'prepare-failure',proof)
            self.assertEqual(original_state['attempts'],state['attempts'])
            self.assertEqual(original_state['failures'],state['failures'])
            return next(iter(state['reconciled_owners'].values()))

    def test_prepare_reconciliation_never_grants_execution_credit(self):
        receipt,owner,proof=self.prepare_fixture()
        entry=self.validate_prepare_fixture(receipt,owner,proof)
        self.assertEqual(entry['participants'],[]);self.assertEqual(entry['retained_services'],[])
        self.assertFalse(entry['credit_granted'])
        self.assertEqual(entry['native_audit_seals'],{})

    def test_prepare_rejects_started_or_partial_or_unretired_evidence(self):
        receipt,owner,proof=self.prepare_fixture()
        originals={p:p.read_bytes() for p in self.base.rglob('*')if p.is_file()}
        summary_path=self.campaign/'summary.json'
        mutations=[('pid',lambda v:v['jobs'][0].update(controller_pid=123)),
                   ('bool-exit',lambda v:v['jobs'][0].update(controller_exit_code=False)),
                   ('started-clock',lambda v:v['jobs'][0].update(started_at=v['started_at'])),
                   ('peak-bool',lambda v:v.update(peak_concurrency=False)),
                   ('wrong-reason',lambda v:v.update(cleanup_ticket_failure='assign')),
                   ('missing-job',lambda v:v['jobs'].pop()),
                   ('duplicate-task',lambda v:v['jobs'][0].update(task=v['jobs'][1]['task'])),
                   ('wrong-ref',lambda v:v['jobs'][0]['controller_command'].__setitem__(-2,'f'*40)),
                   ('bool-cohort',lambda v:v['cleanup_cohorts'][0].update(ready_count=False)),
                   ('task-ran',lambda v:v['jobs'][0].update(status='passed'))]
        for name,mutate in mutations:
            with self.subTest(name=name):
                try:
                    value=json.loads(summary_path.read_text());mutate(value);self.save(summary_path,value);self.reseal()
                    with self.assertRaises(ValueError):self.validate_prepare_fixture(receipt,owner,proof)
                finally:
                    for p,raw in originals.items():p.write_bytes(raw)
                    self.reseal()
        for path in [self.runs/'_hub/owned',self.campaign/'r001-j0001.log',
                     self.campaign/'cleanup-cohorts/c001/cleanup-budget/budget.json',
                     self.campaign/'cleanup-cohorts/c001/ready/member']:
            with self.subTest(path=path):
                path.parent.mkdir(parents=True,exist_ok=True);path.write_text('{}');self.reseal()
                try:
                    with self.assertRaises(ValueError):self.validate_prepare_fixture(receipt,owner,proof)
                finally:
                    path.unlink()
                    if path.parent==self.runs/'_hub':path.parent.rmdir()
                    self.reseal()
        broker=self.relay/'broker.private.log';broker.write_text('{"stopped": 1}');self.reseal()
        with self.assertRaises(ValueError):self.validate_prepare_fixture(receipt,owner,proof)

    def test_prepare_refuses_scope_pin_grant_live_role_and_publication(self):
        receipt,owner,proof=self.prepare_fixture()
        for key,value in [('purpose','isolated-validation'),('recovered_runtime',{'foreign':{}})]:
            with self.subTest(key=key):
                changed=copy.deepcopy(proof);changed[key]=value
                with self.assertRaises(ValueError):self.validate_prepare_fixture(receipt,owner,changed)
        import deploy_test_native_prepare as prepare
        with patch.dict(prepare.REVIEWED_SOURCES,{'run-bench-campaign.py':'0'*64}):
            with self.assertRaisesRegex(ValueError,'producer changed'):self.validate_prepare_fixture(receipt,owner,proof)
        grant=self.base/'fixture-grant.json';grant.write_text('{}')
        try:
            with patch.object(prepare,'grant_path',return_value=grant),self.assertRaisesRegex(ValueError,'grant remains'):
                self.validate_prepare_fixture(receipt,owner,proof)
        finally:grant.unlink()
        capture_path=self.relay/'startup-agent.json';ready_path=self.relay/'ready.json'
        capture=json.loads(capture_path.read_text());ready=json.loads(ready_path.read_text())
        original_capture=copy.deepcopy(capture);original_ready=copy.deepcopy(ready)
        capture['agent'].update(pid=os.getpid(),birth=self.live_stamp(os.getpid()))
        ready['agent']=capture['agent'];self.save(capture_path,capture);self.save(ready_path,ready);self.reseal()
        try:
            with self.assertRaisesRegex(ValueError,'remains live'):self.validate_prepare_fixture(receipt,owner,proof)
        finally:
            self.save(capture_path,original_capture);self.save(ready_path,original_ready);self.reseal()
        self.published=False
        with self.assertRaisesRegex(ValueError,'terminal publication'):self.validate_prepare_fixture(receipt,owner,proof)


    def test_prepare_current_reviewed_pair_never_grants_credit(self):
        receipt,owner,proof=self.prepare_fixture('436576b7b05aa7421c597733c3df4f71f6f40eb7')
        before={p:p.read_bytes() for p in self.base.rglob('*') if p.is_file()}
        entry=self.validate_prepare_fixture(receipt,owner,proof)
        self.assertEqual([],entry['participants']);self.assertEqual([],entry['retained_services'])
        self.assertEqual({},entry['native_audit_seals']);self.assertFalse(entry['credit_granted'])
        self.assertEqual(before,{p:p.read_bytes() for p in self.base.rglob('*') if p.is_file()})

    def test_prepare_refuses_mixed_reviewed_pairs_and_any_altered_producer(self):
        receipt,owner,proof=self.prepare_fixture()
        names=('run-bench-campaign.py','cloudbench-cleanup-tickets.py','run-bench','deploy_test_cloud.py')
        heads=('abd6e81ee0f0c5cbcd88a4a7f11b4a8920740077','436576b7b05aa7421c597733c3df4f71f6f40eb7')
        raw={head:{name:subprocess.check_output(['git','-C',str(ROOT),'show',head+':scripts/'+name])
                   for name in names} for head in heads}
        original={p:p.read_bytes() for p in self.base.rglob('*') if p.is_file()}
        variants=[('old-campaign-new-tickets', {**raw[heads[0]],names[1]:raw[heads[1]][names[1]]}),
                  ('new-campaign-old-tickets', {**raw[heads[0]],names[0]:raw[heads[1]][names[0]]})]
        for head in heads:
            for name in names:
                variants.append((head[:5]+'-altered-'+name,{**raw[head],name:raw[head][name]+b'\n# changed producer\n'}))
        for label,producer in variants:
            with self.subTest(label=label):
                try:
                    for name,data in producer.items():(self.base/'scripts'/name).write_bytes(data)
                    self.reseal()
                    before={p:p.read_bytes() for p in self.base.rglob('*') if p.is_file()}
                    with self.assertRaisesRegex(ValueError,'producer changed'):
                        self.validate_prepare_fixture(receipt,owner,proof)
                    self.assertEqual(before,{p:p.read_bytes() for p in self.base.rglob('*') if p.is_file()})
                finally:
                    for p,data in original.items():p.write_bytes(data)
                    self.reseal()


class RecoveredNativeReceiptGuard(unittest.TestCase):
    """Exercise actual full-pass admission on real files; never launch a worker."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        source = {'head': 'fixture', 'digest': 'fixture'}
        self.gate = {'name': 'api', 'command': ['native-fixture'], 'checks': ['case']}
        self.state = {'source': source, 'input_fingerprints': {'api': 'input'}, 'skips': {},
                      'environment': 'env', 'attempts': [], 'failures': []}
        self.request = {'token': 'original-token', 'source': source, 'gate': 'api', 'checks': ['case']}
        self.worker = {**self.request, 'cases': {'case': 'PASS'}, 'complete': True,
                       'cleanup_complete': True, 'reused': False}
        self.receipt = {**{k: self.request[k] for k in ('token', 'source', 'gate')},
            'status': 'PASS', 'complete': True, 'executed': True, 'native_exit': 0,
            'cancelled': False, 'timed_out': False, 'lingering_group': False,
            'cases': {'case': 'PASS'}, 'command': self.gate['command'],
            'log': str(self.folder / 'output.log'), 'worker_result': str(self.folder / 'result.json'),
            'execution_binding': {'input_fingerprint': 'input', 'contract_digest': c.digest(self.gate),
                                  'environment': 'env'}}
        c.write(self.folder / 'request.json', self.request)
        c.write(self.folder / 'result.json', self.worker)

    def tearDown(self): self.temp.cleanup()

    def admit(self, receipt):
        c.write(self.folder / 'receipt.json', receipt)
        self.state['attempts'] = [{'phase': 'final', 'source': self.state['source'], 'results': [receipt]}]
        return c.full_pass_binding(self.state, self.gate)

    def test_known_native_pass_is_still_admitted(self):
        self.assertIsNotNone(self.admit(self.receipt))

    def test_unknown_lifecycle_is_never_false(self):
        for field in ('cancelled', 'timed_out', 'lingering_group'):
            for value in ('MISSING', None, 0, ''):
                with self.subTest(field=field, value=value):
                    receipt = copy.deepcopy(self.receipt)
                    if value == 'MISSING': receipt.pop(field)
                    else: receipt[field] = value
                    self.assertIsNone(self.admit(receipt))

    def test_recovered_type_cannot_borrow_legacy_native_flags_for_pass(self):
        receipt = {**self.receipt, 'kind': 'recovered-native-execution-v1',
                   'original_coordinator': {'cancelled': 'UNKNOWN', 'timed_out': 'UNKNOWN'},
                   'native_evidence': {'cancelled': False, 'timed_out': False}}
        self.assertIsNone(self.admit(receipt))



class PendingSettlementJournalGuard(unittest.TestCase):
    def test_normal_coordinator_refuses_uncommitted_recovery_journal(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            c.write(root/'plan.json',{})
            c.write(root/'cycle.json',{'phase':'final','ready':False,'source':{},'round':30})
            c.write(root/'settlement-journal.json',{'kind':'native-settlement-journal-v1'})
            original=(root/'cycle.json').read_bytes()
            args=['status','--plan',str(root/'plan.json'),'--state-dir',str(root)]
            self.assertEqual(c.main(args),2)
            self.assertEqual((root/'cycle.json').read_bytes(),original)
            c.write(root/'settlement-committed.json',{'journal_sha256':'wrong'})
            self.assertEqual(c.main(args),2)
            self.assertEqual((root/'cycle.json').read_bytes(),original)
            c.write(root/'settlement-committed.json',{'journal_sha256':c.sha_file(root/'settlement-journal.json')})
            self.assertEqual(c.main(args),0)

@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux /proc dumpable semantics')
class LocalCleanupQuietScan(unittest.TestCase):
    """quiet(root) re-observes an unreadable same-user process instead of raising PermissionError."""

    def test_unreadable_same_user_process_is_reobserved_then_refused(self):
        import deploy_test_local_cleanup as local
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / '.context').mkdir()
            (root / '.context/native-worker-admission.lock').write_text('')
            # PR_SET_DUMPABLE=4: /proc/<pid> stays ours while cwd turns unreadable, as during a setuid exec.
            body = ("import ctypes,sys,time;ctypes.CDLL(None).prctl(4,0,0,0,0);print('ready',flush=True);"
                    "time.sleep(float(sys.argv[1]));ctypes.CDLL(None).prctl(4,1,0,0,0);time.sleep(30)")
            for hidden, refused in ((0.3, False), (60, True)):
                child = subprocess.Popen([sys.executable, '-c', body, str(hidden)], stdout=subprocess.PIPE, text=True)
                try:
                    self.assertEqual(child.stdout.readline().strip(), 'ready')
                    if refused:
                        with self.assertRaisesRegex(ValueError, 'unverifiable'):
                            local.quiet(root)
                    else:
                        local.quiet(root)
                finally:
                    child.kill(); child.wait(); child.stdout.close()

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux /proc credential semantics')
    def test_setuid_process_first_seen_as_ours_is_skipped_not_refused(self):
        # The Blacksmith failure (PR #1760): a sibling suite's `sudo -n` was first seen while its euid
        # was still ours (pre-exec), then its cwd turned unreadable while its real uid stayed ours, and
        # quiet() refused it after the grace window. A real sudo is the fixture; only the first look at
        # /proc/<pid> is pinned to that pre-exec owner.
        import time
        import deploy_test_local_cleanup as local
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / '.context').mkdir()
            (root / '.context/native-worker-admission.lock').write_text('')
            child = subprocess.Popen(['sudo', '-n', 'sleep', '60'], cwd=root)
            proc_dir = Path(f'/proc/{child.pid}')

            def steady():
                # sudo runs the command: its real uid is ours and its euid root, with a root child.
                uids = (proc_dir / 'status').read_text().split('Uid:')[1].split()[:2]
                children = (proc_dir / 'task' / str(child.pid) / 'children').read_text().split()
                return uids == [str(os.getuid()), '0'] and bool(children)
            try:
                deadline = time.monotonic() + 10
                while not steady():
                    self.assertLess(time.monotonic(), deadline, 'sudo never ran its command as root')
                    time.sleep(0.05)
                with self.assertRaises(PermissionError):
                    (proc_dir / 'cwd').resolve(strict=True)
                real_stat, seen = Path.stat, []

                def first_look_ours(path, *args, **kwargs):
                    result = real_stat(path, *args, **kwargs)
                    if path != proc_dir or seen:
                        return result
                    seen.append(path)
                    return os.stat_result((result.st_mode, *result[1:4], os.geteuid(), *result[5:]))
                with patch.object(Path, 'stat', first_look_ours):
                    local.quiet(root)
                self.assertEqual(seen, [proc_dir])
            finally:
                deadline = time.monotonic() + 10
                while child.poll() is None:
                    try:
                        child.terminate()  # refused only while sudo briefly holds a root real uid
                    except PermissionError:
                        self.assertLess(time.monotonic(), deadline, 'sudo fixture could not be stopped')
                    time.sleep(0.05)


class BackendPrismaPreflightCleanup(unittest.TestCase):
    """Original guard refusal closes resources without changing failed results."""
    def setUp(self):
        import hashlib
        import deploy_test_backend_preflight_cleanup as b
        LocalCleanup.setUp(self)
        self.b = b
        self.gate['env'] = {'CONDUCTOR_WORKSPACE_NAME': 'fixture', 'CONDUCTOR_PORT': '12000',
                            'ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME': '1'}
        names = ['blackbox:browser-provider', 'units', 'fps', 'coverage-threshold', 'teardown']
        self.recipe.clear()
        self.recipe.update(cases={name: {'command': ['npm', 'run', 'test:coverage:sharded'],
                           'cwd': 'back-end', 'sweep': True, 'env': self.gate['env']} for name in names},
                           execution_timeout_seconds=14400)
        self.gate['checks'] = names
        self.request['checks'] = names
        self.result['cases'] = dict.fromkeys(names, 'UNVERIFIED')
        self.result['cases'].update(units='FAIL', fps='FAIL', teardown='FAIL')
        self.result['recipe_digest'] = c.digest(self.recipe)
        self.result['native_command'] = ['npm', 'run', 'test:coverage:sharded']
        self.receipt['cases'] = dict.fromkeys(names, 'UNVERIFIED')
        self.receipt['execution_binding']['contract_digest'] = c.digest(self.gate)
        self.process['reaped'] = [{'pid': 124, 'status': 256}] + [{'pid': i, 'status': 0} for i in range(125, 135)]
        native = Path(self.result['runner_log']).parent
        coverage = self.worker / 'back-end/coverage'
        coverage.mkdir(parents=True)
        self.archive = self.root / 'archive'; self.archive.mkdir()
        self.proof.update(layout=b.LAYOUT, artifacts={})
        self.native = native
        self.evidence = self.result['evidence'] = {'artifacts': {'summaries': {}}, 'unknown_domains': []}
        def artifact(path, raw):
            path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
            archived = self.archive / ('%02d-' % len(self.proof['artifacts']) + path.name)
            archived.write_bytes(raw); archived.chmod(0o600)
            row = {'path': str(archived), 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
            self.proof['artifacts'][str(path)] = row
            return row['sha256']
        self.artifact = artifact
        prefix = 'Using local Postgres (Docker container=victoria-db-fixture) at localhost:12005, database victoria_fixture'
        for role, filename, suffix in [('units', 'units.log', '_s0'), ('fps', 'units-probe.log', '_s0')]:
            path = coverage / filename
            h = artifact(path, (b.BROWSER+b.TRACE+prefix+suffix+'\n'+b.STALE).encode())
            self.evidence[role] = {'log': str(path), 'exit': 1}
            self.evidence['artifacts'][role+'_log'] = h
        self.evidence['shard_logs'] = {}
        for i in (1, 2):
            path = coverage / ('shard-%d.log' % i)
            self.evidence['shard_logs'][str(path)] = artifact(path, (b.BROWSER+b.TRACE+prefix+'_s%d\n'%i+b.STALE).encode())
        path = native / 'teardown.log'
        h = artifact(path, (b.TRACE+prefix+'\n'+b.STALE+'FAIL: the isolated backend never became ready\n').encode())
        self.evidence['teardown'] = {'log': str(path), 'exit': 1, 'recipe_cleanup_exit': None,
              'recipe_setup_exit': None, 'command': ['bash','scripts/tests/blackbox-backend-teardown.test.sh']}
        self.evidence['artifacts']['teardown_log'] = h
        path = native / 'threshold.log'
        self.evidence['coverage-threshold'] = {'log': str(path)}
        self.evidence['artifacts']['threshold_log'] = artifact(path, b'No coverage; threshold unverified\n')
        runner_rows = ['Started coverage shard 1/2', 'Started coverage shard 2/2', 'Started the unit pass beside the shards',
            '❌ Coverage shard 1/2 failed (exit 1)', '❌ Coverage shard 2/2 failed (exit 1)',
            '❌ Unit pass failed (exit 1)', '❌ fps probe pass failed (exit 1)']
        self.evidence['artifacts']['runner_log'] = artifact(Path(self.result['runner_log']), ('\n'.join(runner_rows)+'\n').encode())
        self.pg = {'id': 'c'*64, 'name': '/victoria-db-fixture', 'image': 'sha256:'+'d'*64,
            'image_name': 'pgvector/pgvector:pg16', 'owner': str(self.worker), 'running': True, 'status': 'running',
            'paused': False, 'restarting': False, 'dead': False,
            'ports': {'5432/tcp': [{'HostIp':'127.0.0.1','HostPort':'12005'}]},
            'mounts': [{'Type':'volume','Name':'victoria-pgdata-fixture','RW':True,'Destination':'/var/lib/postgresql/data'}]}
        hashes = [artifact(native / ('postgres-'+phase+'.json'), json.dumps(self.pg).encode()) for phase in ('before','after')]
        self.evidence['postgres_fixture'] = {'id': self.pg['id'], 'name': 'victoria-db-fixture', 'image': self.pg['image'],
              'volume':'victoria-pgdata-fixture', 'port':12005, 'restored':False,
              'before_sha256':hashes[0], 'after_sha256':hashes[1]}
        self.locks = []
        for port in (12020,12022,12024):
            path = self.worker / '.context/test-runs/.port-locks' / (str(port)+'.lock')
            artifact(path, b'999999999\n'); os.utime(path, (150,150)); self.locks.append(path)
        self.sync()
        self.original_bytes = {n:p.read_bytes() for n,p in self.paths.items()}
        # Historical source bytes are real; synthetic root has no Git repository.
        blobs = {name: subprocess.check_output(['git','--no-replace-objects','-C',str(ROOT),'show',
                    'abd6e81ee0f0c5cbcd88a4a7f11b4a8920740077:'+name]) for name in b.PINS}
        self.addCleanup(patch.stopall)
        patch.object(b.subprocess, 'check_output', side_effect=lambda argv: blobs[argv[-1].split(':',1)[1]]).start()
        patch.object(b, 'docker_snapshot', side_effect=lambda machine: copy.deepcopy(self.pg)).start()
        patch.object(b, 'listeners', return_value={12005}).start()

    def sync(self):
        for name, value in zip(self.paths, [self.request,self.result,self.receipt,self.process]):
            c.write(self.paths[name], value)
        self.proof['files'] = {n:c.sha_file(p) for n,p in self.paths.items()}

    def reconcile(self):
        c.reconcile(self.state, 'occurrence', self.proof)

    def test_guard_refusal_closes_without_credit_or_rewriting(self):
        self.reconcile()
        self.assertFalse(next(iter(self.state['reconciled_owners'].values()))['credit_granted'])
        self.assertEqual(self.original_bytes, {n:p.read_bytes() for n,p in self.paths.items()})
        self.assertEqual('UNVERIFIED', self.failure['native_result'])
        self.assertFalse(self.result['cleanup_complete'])
        self.assertEqual([], c.retained_owners(self.state,[self.gate['name']]))

    def test_source_inventory_phase_and_supervisor_negatives(self):
        changes = [('process','orphaned_children',True), ('process','term_sent',[124]),
            ('process','reaped',self.process['reaped'][:-1]), ('process','reaped',[{'pid':124,'status':True}]+self.process['reaped'][1:]),
            ('result','complete',True), ('result','cleanup_complete',True), ('result','source_unchanged',False),
            ('result','native_exit',True), ('request','checks',['teardown'])]
        for owner,key,value in changes:
            with self.subTest(owner=owner,key=key):
                target = getattr(self,owner); old=target[key]; target[key]=value; self.sync()
                with self.assertRaises(ValueError): self.reconcile()
                target[key]=old; self.sync()
        old_head = self.source['head']; self.source['head'] = 'abc'; self.sync()
        with self.assertRaisesRegex(ValueError, 'full source'): self.reconcile()
        self.source['head'] = old_head; self.sync()
        with patch.object(self.b.subprocess,'check_output',return_value=b'changed historical source'):
            with self.assertRaises(ValueError): self.reconcile()
        for role in ('units', 'fps', 'teardown'):
            self.evidence[role]['exit'] = True; self.sync()
            with self.subTest(role=role), self.assertRaises(ValueError): self.reconcile()
            self.evidence[role]['exit'] = 1; self.sync()
        path = Path(self.evidence['units']['log']); row = self.proof['artifacts'][str(path)]
        raw = b'backend actually started\n'
        Path(row['path']).write_bytes(raw)
        import hashlib
        row.update(sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw))
        self.evidence['artifacts']['units_log'] = row['sha256']; self.sync()
        with self.assertRaisesRegex(ValueError, 'guarded phase boundary'): self.reconcile()

    def test_current_app_fixture_lock_and_archive_negatives(self):
        for observer, value in [('listeners',{12005,12030}), ('docker_snapshot',{})]:
            with self.subTest(observer=observer), patch.object(self.b,observer,return_value=value):
                with self.assertRaises(ValueError): self.reconcile()
        import deploy_test_process
        fakeproc = self.root / 'fake-proc'; fakeproc.mkdir()
        (fakeproc / 'cwd').symlink_to(self.worker, target_is_directory=True)
        (fakeproc / 'cmdline').write_bytes(b'fixture\0')
        with patch.object(deploy_test_process, 'scan_same_user_processes',
                          side_effect=lambda inspect, unknown: inspect(fakeproc)):
            with self.assertRaisesRegex(ValueError, 'root still live'): self.reconcile()
        import fcntl
        for path in [self.worker/'.context/native-worker-admission.lock',self.locks[0]]:
            with path.open('r') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with self.assertRaises((ValueError,OSError)): self.reconcile()
        self.locks[0].write_text(str(os.getpid())+'\n')
        with self.assertRaises(ValueError): self.reconcile()
        self.locks[0].write_bytes(b'999999999\n'); os.utime(self.locks[0],(150,150))
        row = self.proof['artifacts'].pop(str(self.locks[0]))
        with self.assertRaises(ValueError): self.reconcile()
        self.proof['artifacts'][str(self.locks[0])] = row
        Path(row['path']).chmod(0o666)
        with self.assertRaises(ValueError): self.reconcile()

if __name__ == '__main__': unittest.main()
