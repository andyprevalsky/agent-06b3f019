#!/usr/bin/env python3
"""Run the actual worker/transport with tiny subprocesses, no services."""
from pathlib import Path
from datetime import datetime, timezone
import copy
import builtins
import contextlib
import importlib.util
import io
import shlex
import shutil
import signal
import threading
import json
import os
import runpy
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
# The suite builds its own gate requests. A DEPLOY_GATE_REQUEST inherited from an
# outer deploy worker (the local executor runs this suite inside a gate) would
# make admission() demand that outer cycle's custody locator in-process.
os.environ.pop('DEPLOY_GATE_REQUEST', None)
sys.path.insert(0, str(ROOT / 'scripts'))
import deploy_test_cycle as cycle
import deploy_test_worker as worker


class Worker(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root/'code').write_text('fixture')
        (self.root/'.git/info/exclude').write_text('.context/\n')
        subprocess.run(['git','-C',str(self.root),'add','.'], check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=test','-c',
                        'user.email=test@example.com','commit','-qm','fixture'], check=True)
        self.recipe = {'cases': {'first': {'command': [sys.executable,'-c','raise SystemExit(1)']},
                                 'second': {'command': [sys.executable,'-c','pass']}}}
        self.request = {'token': 'unique-test-token', 'source': cycle.source(self.root), 'gate': 'gate',
                        'checks': ['first','second'], 'skips': {}, 'phase': 'initial',
                        'worker_recipe': self.recipe}
        self.coordinator_temp = tempfile.TemporaryDirectory()
        self.coordinator = Path(self.coordinator_temp.name)
        subprocess.run(['git','clone','-q','--shared',str(self.root),str(self.coordinator)],check=True)
        (self.coordinator/'.git/info/exclude').write_text('.context/\n')

    def bind_gate(self, gate):
        gate.update(worker_transport='local-isolated', cwd=str(self.root), worker_root=str(self.root),
                    env={'CONDUCTOR_WORKSPACE_NAME':'isolated-test','CONDUCTOR_PORT':'12000'})
        return gate

    def tearDown(self):
        cycle.CANCEL.clear()
        self.coordinator_temp.cleanup()
        self.temp.cleanup()

    def test_remote_cleanup_owner_in_an_otherwise_passing_result_is_unverified_and_blocks_resume(self):
        # CodeRabbit 4449994487: a boxes-thread (native-backend) gate is not a native producer; the adapter's
        # cleanup_owner must survive validate_result's rejection and mark the occurrence lingering.
        gate = {'name': 'backend-coverage-blackbox', 'checks': ['first'], 'command': ['adapter'], 'case_protocol': True, 'cwd': '.',
                'category': 'backend-coverage-blackbox', 'worker_transport': 'boxes-thread', 'native_backend': True,
                'worker_thread': 'ph-worker', 'worker_root': '/prepared/root', 'worker_recipe': {'cases': {'first': {'command': ['true']}}}}
        state = {'phase': 'initial', 'round': 0, 'skips': {}, 'source': {'head': 'a' * 40, 'digest': 'b' * 64},
                 'input_fingerprints': {'backend-coverage-blackbox': 'fp'}, 'environment':cycle.environment_digest()}
        owner = {'worker_thread': 'ph-worker', 'worker_host': 'devbox-a', 'worker_root': '/prepared/root',
                 'request_token': None, 'message_id': 'peer_1', 'turn_id': 'turn-7', 'remote_dir': '/prepared/root/.context/deploy-boxes/t', 'pgid': 4242}
        def launch(_argv, **kwargs):
            self.assertTrue(kwargs['owned_lifecycle'])
            request = cycle.read(Path(kwargs['env']['DEPLOY_GATE_REQUEST']))
            owner['request_token'] = request['token']
            result = {key: request[key] for key in ('token', 'source', 'gate')}
            # otherwise-passing case map, but the remote turn still owns the worker: cleanup not complete
            result.update(cases={'first': 'PASS'}, complete=True, cleanup_complete=False, reused=False,
                          reason='original deadline passed before a terminal turn', cleanup_owner=dict(owner))
            cycle.write(Path(kwargs['env']['DEPLOY_GATE_RESULT']), result)
            return 0, False, False, False
        with patch.object(cycle, 'run_command', side_effect=launch):
            result = cycle.execute(gate, state, self.coordinator / '.context/remote-owner', self.coordinator)
        self.assertEqual({'first': 'UNVERIFIED'}, result['cases']); self.assertFalse(result['complete'])
        self.assertTrue(result['lingering_group']); self.assertEqual('owned', result['lifecycle'])
        self.assertEqual(result['token'], result['cleanup_owner']['request_token'])
        self.assertEqual(owner, result['cleanup_owner']['worker_cleanup_owner'])
        for field in ('worker_thread', 'turn_id', 'pgid', 'worker_root'):
            self.assertEqual(owner[field], result['cleanup_owner']['worker_cleanup_owner'][field])
        # the existing resume guard refuses another token on that worker thread/root while the owner is retained
        plan = {'source': state['source'], 'gates': [gate]}
        saved = {**state, 'plan': plan, 'plan_digest': cycle.digest(plan), 'phase': 'interrupted', 'resume_phase': 'initial',
                 'ready': False, 'attempts': [{'phase': 'initial', 'results': [result], 'interrupted': True}],
                 'failures': [], 'repair_gates': [], 'environment': cycle.environment_digest()}
        directory = self.coordinator / '.context/remote-owner-state'; cycle.write(directory / 'cycle.json', saved)
        cycle.write(directory / 'plan.json', plan)
        with patch.object(cycle, 'validate_plan'), patch.object(cycle, 'run_phase') as run_phase:
            code = cycle.main(['resume', '--plan', str(directory / 'plan.json'), '--state-dir', str(directory), '--root', str(self.coordinator)])
        self.assertEqual(2, code); run_phase.assert_not_called()

    def test_clean_generic_result_without_remote_owner_still_passes(self):
        gate = {'name': 'generic', 'checks': ['first'], 'command': ['fixture'], 'case_protocol': True, 'category': 'generic'}
        state = {'phase': 'initial', 'round': 0, 'skips': {}, 'source': {'head': 'a' * 40, 'digest': 'b' * 64},
                 'input_fingerprints': {'generic': 'fp'}, 'environment':cycle.environment_digest()}
        def launch(_argv, **kwargs):
            request = cycle.read(Path(kwargs['env']['DEPLOY_GATE_REQUEST']))
            result = {key: request[key] for key in ('token', 'source', 'gate')}
            result.update(cases={'first': 'PASS'}, complete=True, cleanup_complete=True, reused=False)
            cycle.write(Path(kwargs['env']['DEPLOY_GATE_RESULT']), result)
            return 0, False, False, False
        with patch.object(cycle, 'run_command', side_effect=launch):
            result = cycle.execute(gate, state, self.coordinator / '.context/clean-generic', self.coordinator)
        self.assertEqual(('PASS', True, False, 'owned'), (result['status'], result['complete'], result['lingering_group'], result['lifecycle']))
        self.assertNotIn('cleanup_owner', result)

    def test_native_producer_and_generic_use_their_declared_cleanup_authority(self):
        # 'agentcard' is a stale plan's retired AgentCard lane: its tasks run in cloud smoke now, so the
        # category earns no native-producer cleanup authority and is owned like any generic gate.
        for kind in ('generic', 'cloud', 'agentcard'):
            native = kind == 'cloud'
            with self.subTest(kind=kind):
                gate = {'name': kind, 'checks': ['first'], 'command': ['fixture'],
                        'case_protocol': True, 'native_cloud': kind == 'cloud',
                        'category': 'agentcard-lifecycle' if 'agentcard' in kind else kind,
                        'worker_transport': 'local-isolated' if kind == 'agentcard' else None}
                state = {'phase': 'initial', 'round': 0, 'skips': {},
                         'source': {'head': 'a' * 40, 'digest': 'b' * 64}, 'environment':cycle.environment_digest(), 'input_fingerprints':{kind:'fp'}}
                def launch(_argv, **kwargs):
                    self.assertEqual(not native, kwargs['owned_lifecycle'])
                    request = cycle.read(Path(kwargs['env']['DEPLOY_GATE_REQUEST']))
                    result = {key: request[key] for key in ('token', 'source', 'gate')}
                    result.update(cases={'first': 'PASS'}, complete=True,
                                  cleanup_complete=True, reused=False, fleet_directory='/native/fleet')
                    cycle.write(Path(kwargs['env']['DEPLOY_GATE_RESULT']), result)
                    return 0, False, False, False
                with patch.object(cycle, 'run_command', side_effect=launch):
                    result = cycle.execute(gate, state, self.coordinator / '.context/routing', self.coordinator)
                self.assertEqual('PASS', result['status'])
                self.assertEqual('native-producer' if native else 'owned', result['lifecycle'])
                if native:
                    self.assertEqual('/native/fleet', result['native_cleanup_reference']['native_directory'])
                    self.assertTrue(result['native_cleanup_reference']['cleanup_complete'])
                else:
                    self.assertIsNone(result['native_cleanup_reference'])

    def test_interrupted_native_producer_records_cleanup_owner_and_blocks_credit(self):
        gate = {'name': 'native', 'checks': ['first'], 'command': ['fixture'], 'native_cloud': True}
        state = {'phase': 'initial', 'round': 0, 'skips': {},
                 'source': {'head': 'a' * 40, 'digest': 'b' * 64}, 'environment':cycle.environment_digest(), 'input_fingerprints':{'native':'fp'}}
        for index, native_result in enumerate(((-signal.SIGKILL, True, False, True),
                                                  (1, False, False, False))):
            with patch.object(cycle, 'run_command', return_value=native_result):
                result = cycle.execute(gate, state, self.coordinator / f'.context/routing-{index}', self.coordinator)
            self.assertEqual({'first': 'UNVERIFIED'}, result['cases'])
            self.assertTrue(result['lingering_group'])
            self.assertEqual(result['token'], result['cleanup_owner']['request_token'])
            self.assertFalse(result['complete'])

    def test_failure_does_not_stop_other_cases(self):
        result=worker.execute(self.request,self.root)
        self.assertEqual({'first':'FAIL','second':'PASS'},result['cases'])
        self.assertTrue(result['complete'])
        self.assertEqual(1,result['evidence']['first']['native_exit'])

    def test_each_case_reports_progress_as_it_finishes_and_runners_get_the_case(self):
        sys.path.insert(0, str(Path(worker.__file__).resolve().parent))
        import deploy_gate_progress as progress
        runner = ("import os,sys; sys.path.insert(0,%r); import deploy_gate_progress as p; "
                  "assert os.environ[p.CASE_ENV]=='first'; p.report('t1','FAIL',detail='boom'); raise SystemExit(1)"
                  % str(Path(worker.__file__).resolve().parent))
        self.recipe['cases']['first']['command'] = [sys.executable, '-c', runner]
        target = self.root / '.context' / 'progress.jsonl'
        with patch.dict(os.environ, {progress.ENV: str(target)}):
            result = worker.execute(self.request, self.root)
        self.assertEqual({'first': 'FAIL', 'second': 'PASS'}, result['cases'])  # the verdict is unchanged
        rows, _ = progress.read_new(target)
        self.assertEqual([('test', 'first', 't1', 'FAIL'), ('case', 'first', 'first', 'FAIL'),
                          ('case', 'second', 'second', 'PASS')],
                         [(r['scope'], r['case'], r['unit'], r['status']) for r in rows])
        self.assertIn('boom', rows[0]['detail'])
        self.assertEqual(result['evidence']['first']['log'], rows[1]['log'])

    def test_without_a_coordinator_progress_path_rows_land_beside_the_worker_evidence(self):
        sys.path.insert(0, str(Path(worker.__file__).resolve().parent))
        import deploy_gate_progress as progress
        environ = {k: v for k, v in os.environ.items() if k != progress.ENV}
        with patch.dict(os.environ, environ, clear=True):
            result = worker.execute(self.request, self.root)
        folder = Path(result['evidence']['first']['log']).parent
        rows, _ = progress.read_new(folder / 'progress.jsonl')
        self.assertEqual(['first', 'second'], [r['unit'] for r in rows])

    def test_aggregate_failure_cannot_prove_all_constituents_completed(self):
        self.recipe['cases']['first']['aggregate']=True
        result=worker.execute(self.request,self.root)
        self.assertEqual({'first':'UNVERIFIED','second':'PASS'},result['cases'])
        self.assertFalse(result['complete'])

    def test_prepared_snapshot_matches_source_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'worker'
            receipt=worker.prepare_checkout(self.root,target)
            self.assertEqual(cycle.source(self.root),receipt['source'])
            self.assertEqual(cycle.source(self.root),cycle.source(target))
            with self.assertRaisesRegex(ValueError,'overwrite'):
                worker.prepare_checkout(self.root,target)

    def test_copy_config_is_private_before_secret_bytes_for_new_and_existing_files(self):
        # Observe the real copyfile destination open, before its first write.
        actual_open = builtins.open
        original_umask = os.umask(0o022)
        try:
            for existing in (False, True):
                with self.subTest(existing=existing), tempfile.TemporaryDirectory() as directory:
                    rel = 'env.sh' if existing else '.env'
                    origin = self.root / rel
                    (self.root / '.gitignore').write_text('.env\n')
                    origin.write_bytes(b'DUMMY_SECRET=fixture-only\n')
                    subprocess.run(['git', '-C', str(self.root), 'add', '.gitignore'], check=True)
                    if existing:
                        # A tracked public config placeholder is already present after clone.
                        (self.root / '.env').unlink()
                        subprocess.run(['git', '-C', str(self.root), 'add', rel], check=True)
                    subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=test', '-c',
                                    'user.email=test@example.com', 'commit', '-qm', 'config fixture'], check=True)
                    original = origin.read_bytes()
                    destination = Path(directory) / 'worker' / rel
                    observed = []
                    def checked_open(file, mode='r', *args, **kwargs):
                        stream = actual_open(file, mode, *args, **kwargs)
                        if isinstance(file, (str, os.PathLike)) and Path(file) == destination and mode == 'wb':
                            permissions = os.fstat(stream.fileno()).st_mode & 0o777
                            observed.append(permissions)
                            if permissions != 0o600:
                                stream.close()
                                self.fail(f'config destination exposed before copy: {permissions:o}')
                        return stream
                    with patch('builtins.open', side_effect=checked_open):
                        worker.prepare_checkout(self.root, destination.parent, copy_config=True)
                    self.assertEqual([0o600], observed)
                    self.assertEqual(original, destination.read_bytes())
                    self.assertEqual(original, origin.read_bytes())
                    self.assertEqual(0o600, destination.stat().st_mode & 0o777)
        finally:
            os.umask(original_umask)

    def test_copy_config_preserves_benchmark_temporal_routing(self):
        (self.root/'.gitignore').write_text('.env\n.env.*\n')
        subprocess.run(['git', '-C', str(self.root), 'add', '.gitignore'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=test', '-c',
                        'user.email=test@example.com', 'commit', '-qm', 'ignore private config'], check=True)
        agents = self.root/'agents'
        agents.mkdir()
        (agents/'.env').write_text(
            'TEMPORAL_ADDRESS=cloud.fixture:7233\n'
            'TEMPORAL_NAMESPACE=rose-labs-us-east-1.tch2n\n'
            'TEMPORAL_API_KEY=fixture-prod\n')
        override = agents/'.env.benchmark-temporal'
        override.write_text(
            'CLOUDBENCH_GUEST_TEMPORAL_ADDRESS=bench.fixture:7233\n'
            'CLOUDBENCH_GUEST_TEMPORAL_NAMESPACE=rose-labs-bench.tch2n\n'
            'CLOUDBENCH_GUEST_TEMPORAL_API_KEY=fixture-bench\n')
        for config in (agents/'.env', override):
            config.chmod(0o600)
        original_override = override.read_bytes()
        original_owner = override.stat().st_uid
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(('TEMPORAL_', 'CLOUDBENCH_GUEST_TEMPORAL'))}

        def route(checkout):
            return subprocess.run(
                ['bash', '-c', '. scripts/lib/cloudbench-env.sh && stack_bench_temporal_exports "$1"',
                 '_', str(checkout/'agents/.env')],
                cwd=ROOT, env=env, text=True, capture_output=True, check=False)

        self.assertEqual(0, route(self.root).returncode)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)/'worker'
            worker.prepare_checkout(self.root, target, copy_config=True)
            result = route(target)
            self.assertEqual(0, result.returncode, result.stderr)
            copied = target/'agents/.env.benchmark-temporal'
            self.assertEqual(original_override, override.read_bytes())
            self.assertEqual(original_override, copied.read_bytes())
            self.assertEqual(0o600, copied.stat().st_mode & 0o777)
            self.assertEqual(0o600, override.stat().st_mode & 0o777)
            self.assertEqual(original_owner, override.stat().st_uid)
            self.assertEqual(os.geteuid(), copied.stat().st_uid)
            self.assertIn('TEMPORAL_NAMESPACE=rose-labs-bench.tch2n', result.stdout)

    def test_private_umask_preserves_source_but_executable_changes_do_not(self):
        (self.root/'code').chmod(0o644)
        executable = self.root/'run-fixture'
        executable.write_text('#!/bin/sh\nexit 0\n')
        executable.chmod(0o755)
        subprocess.run(['git','-C',str(self.root),'add','.'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=test','-c',
                        'user.email=test@example.com','commit','-qm','executable fixture'],check=True)
        before = cycle.source(self.root)
        plan = {'gates':[{'name':'fixture','command':['true'],'checks':['fixture']}]}
        before_inputs = cycle.input_fingerprints(plan,self.root)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)/'private-worker'
            previous = os.umask(0o077)
            try:
                worker.prepare_checkout(self.root,target)
            finally:
                os.umask(previous)
            self.assertEqual(0o600,(target/'code').stat().st_mode & 0o777)
            self.assertEqual(0o700,(target/'run-fixture').stat().st_mode & 0o777)
            self.assertEqual(before,cycle.source(target))
            self.assertEqual(before_inputs,cycle.input_fingerprints(plan,target))
            (target/'run-fixture').chmod(0o600)
            self.assertNotEqual(before,cycle.source(target))
            self.assertNotEqual(before_inputs,cycle.input_fingerprints(plan,target))

    def test_dirty_source_is_refused_before_preparation(self):
        (self.root/'code').write_text('not frozen')
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'worker'
            with self.assertRaisesRegex(ValueError,'commit the frozen source'):
                worker.prepare_checkout(self.root,target)
            self.assertFalse(target.exists())

    def test_worker_must_match_its_bound_execution_root(self):
        self.request['worker_root']='/some-other-checkout'
        with self.assertRaisesRegex(ValueError,'isolation binding'):
            worker.execute(self.request,self.root)

    def test_skipped_case_never_executes(self):
        self.request.update(checks=['second'],skips={'first':{'disposition':'external / waived'}})
        result=worker.execute(self.request,self.root)
        self.assertEqual({'second':'PASS'},result['cases'])
        self.assertNotIn('first',result['evidence'])

    def test_wrong_source_refused_before_execution(self):
        (self.root/'code').write_text('changed')
        with self.assertRaisesRegex(ValueError,'source differs'):
            worker.execute(self.request,self.root)
        self.assertFalse((self.root/'.context').exists())

    def test_setup_failure_still_cleans_up_and_is_incomplete(self):
        self.recipe['setup']={'command':[sys.executable,'-c','raise SystemExit(1)']}
        marker=self.root/'.context/cleaned'
        self.recipe['cleanup']={'command':[sys.executable,'-c',f'from pathlib import Path; Path({str(marker)!r}).touch()']}
        result=worker.execute(self.request,self.root)
        self.assertFalse(result['complete'])
        self.assertTrue(marker.exists())
        self.assertEqual({'first':'UNVERIFIED','second':'UNVERIFIED'},result['cases'])

    def test_cleanup_failure_cannot_claim_pass_or_completed_failure(self):
        self.recipe['cleanup']={'command':[sys.executable,'-c','raise SystemExit(1)']}
        result=worker.execute(self.request,self.root)
        self.assertFalse(result['cleanup_complete'])
        self.assertTrue(all(s=='UNVERIFIED' for s in result['cases'].values()))

    def test_full_gate_cannot_omit_registered_cases(self):
        self.request['checks']=['second']
        with self.assertRaisesRegex(ValueError,'omitted registered'):
            worker.execute(self.request,self.root)

    def test_services_require_teardown_before_any_command(self):
        self.recipe['services']=True
        with self.assertRaisesRegex(ValueError,'cleanup'):
            worker.execute(self.request,self.root)

    def test_real_stdio_transport_keeps_each_case_result(self):
        gate={'name':'gate','worker':'isolated-test','checks':['first','second'],
              'case_protocol':True,'worker_recipe':self.recipe,'result_transport':'stdout','timeout_seconds':10,
              'command':[sys.executable,str(ROOT/'scripts/deploy_test_worker.py'),
                         '--root',str(self.root),'--stdio']}
        plan={'source':self.request['source'],'gates':[
            *[{'name':name,'quick':True,'category':name,'checks':[name],'command':['true']}
              for name in ('format','eslint','typescript','backend-structural')],gate]}
        self.bind_gate(gate)
        state=cycle.initialize(plan,self.coordinator);state['phase']='initial'
        result=cycle.execute(gate,state,self.coordinator/'.context/coordinator',self.coordinator)
        self.assertEqual({'first':'FAIL','second':'PASS'},result['cases'])
        self.assertTrue(result['complete'])
        self.assertEqual(1,len(cycle.failed_cases(state,[result])))

    def test_partial_stdio_result_preserves_executed_peer_but_blocks_unknown(self):
        self.recipe['cases']['first']['command']=[sys.executable,'-c','raise SystemExit(7)']
        gate={'name':'gate','worker':'isolated-test','checks':['first','second'],
              'case_protocol':True,'worker_recipe':self.recipe,'result_transport':'stdout','timeout_seconds':10,
              'command':[sys.executable,str(ROOT/'scripts/deploy_test_worker.py'),
                         '--root',str(self.root),'--stdio']}
        plan={'source':self.request['source'],'gates':[
            *[{'name':name,'quick':True,'category':name,'checks':[name],'command':['true']}
              for name in ('format','eslint','typescript','backend-structural')],gate]}
        self.bind_gate(gate)
        state=cycle.initialize(plan,self.coordinator);state['phase']='initial'
        result=cycle.execute(gate,state,self.coordinator/'.context/coordinator',self.coordinator)
        self.assertEqual({'first':'UNVERIFIED','second':'PASS'},result['cases'])
        failures=cycle.failed_cases(state,[result])
        self.assertEqual(1,len(failures))
        self.assertFalse(failures[0]['complete'])

    def test_focused_worker_recipe_never_replaces_the_full_failed_gate(self):
        gate=self.bind_gate({'name':'gate','worker':'isolated-test','checks':['first','second'],
              'case_protocol':True,'worker_recipe':self.recipe,'result_transport':'stdout','timeout_seconds':10,
              'command':[sys.executable,str(ROOT/'scripts/deploy_test_worker.py'),
                         '--root',str(self.root),'--stdio']})
        plan={'source':self.request['source'],'gates':[
            *[{'name':name,'quick':True,'category':name,'checks':[name],'command':['true']}
              for name in ('format','eslint','typescript','backend-structural')],gate]}
        state=cycle.initialize(plan,self.coordinator)
        state.update(phase='needs-focused-plan',repair_gates=['gate'],failures=[
            {'gate':'gate','check':'gate/first','disposition':'blocking'}])
        with self.assertRaisesRegex(ValueError,'identical to the bound recipe'):  # a "fixed" command is not a focus
            cycle.focused_plan(state,plan,{'source':state['source'],'gates':{'gate':{
                'command':gate['command'],'checks':['first'],
                'worker_recipe':{'cases':{'first':{'command':[sys.executable,'-c','pass']}}}}}})
        cycle.focused_plan(state,plan,{'source':state['source'],'gates':{'gate':{
            'command':gate['command'],'checks':['first'],
            'worker_recipe':{'cases':{'first':self.recipe['cases']['first']}}}}})
        focused=cycle.execute(cycle.records(plan,state)[0],state,
                              self.coordinator/'.context/coordinator',self.coordinator)
        self.assertEqual({'first':'FAIL'},focused['cases'])  # the bound case command ran unchanged
        cycle.advance(state,[focused])
        self.assertEqual('triage',state['phase'])
        self.assertFalse(state['ready'])

    def test_wrong_recipe_digest_is_rejected(self):
        from deploy_test_result import validate
        result=worker.execute(self.request,self.root);result['recipe_digest']='wrong'
        with self.assertRaisesRegex(ValueError,'recipe changed'):
            validate(result,self.request,1)

    def test_stderr_diagnostics_do_not_corrupt_the_receipt_stream(self):
        self.recipe['cases']['first']['command']=[sys.executable,'-c','pass']
        script="import os,sys; sys.stderr.write('transport diagnostic\\n'); sys.stderr.flush(); os.execv(sys.executable, [sys.executable,*sys.argv[1:]])"
        gate={'name':'gate','worker':'isolated-test','checks':['first','second'],
              'case_protocol':True,'worker_recipe':self.recipe,'result_transport':'stdout','timeout_seconds':10,
              'command':[sys.executable,'-c',script,str(ROOT/'scripts/deploy_test_worker.py'),
                         '--root',str(self.root),'--stdio']}
        plan={'source':self.request['source'],'gates':[
            *[{'name':name,'quick':True,'category':name,'checks':[name],'command':['true']}
              for name in ('format','eslint','typescript','backend-structural')],gate]}
        self.bind_gate(gate)
        state=cycle.initialize(plan,self.coordinator);state['phase']='initial'
        result=cycle.execute(gate,state,self.coordinator/'.context/coordinator',self.coordinator)
        self.assertEqual('PASS',result['status'])
        self.assertIn('transport diagnostic',Path(result['stderr_log']).read_text())

    def test_remote_sender_that_never_closes_stdin_is_bounded(self):
        proc=subprocess.Popen([sys.executable,str(ROOT/'scripts/deploy_test_worker.py'),
            '--stdio','--request-timeout','.03'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            self.assertEqual(2,proc.wait(timeout=3))
            self.assertIn(b'request timed out',proc.stderr.read())
        finally:
            for stream in (proc.stdin,proc.stdout,proc.stderr): stream.close()
            if proc.poll() is None: proc.kill();proc.wait()

    def test_missing_cleanup_proof_is_not_a_complete_result(self):
        from deploy_test_result import validate
        result=worker.execute(self.request,self.root);del result['cleanup_complete']
        with self.assertRaises(ValueError): validate(result,self.request,1)


class Cloud(unittest.TestCase):
    def setUp(self):
        # These native receipt fixtures own their adapter inputs, not the deploy's fanout.
        environment = patch.dict(os.environ, {
            'CLOUDBENCH_BROWSER_PROVIDER': 'tilion',
            'CLOUDBENCH_PROVIDER_LIMITS_FILE': str(ROOT / 'scripts/cloudbench-provider-limits.json'),
        })
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop('DEPLOY_CLOUD_CONCURRENCY', None)
        # This standalone fixture owns its request, not the invoking gate's custody.
        os.environ.pop('DEPLOY_GATE_REQUEST', None)
        import deploy_test_cloud as cloud
        import cloudbench_execution_provenance as provenance
        self.cloud=cloud;self.provenance=provenance
        # Offline: these fixtures never read the shared Tilion account (see CloudSharedProviderHeadroom).
        offline=patch.object(cloud.provider_headroom,'live_probes',return_value={});offline.start();self.addCleanup(offline.stop)
        # Offline: the frozen ref counts as pushed; deploy-cloud-smoke-speed covers the unpushed refusal.
        pushed=patch.object(cloud,'origin_fetchable',return_value=True);pushed.start();self.addCleanup(pushed.stop)
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.runs=self.root/'runs';self.fleet=self.runs/'native-run'
        self.request={'token':'token','source':{'head':'a'*40,'digest':'frozen'},
                      'gate':'smoke','checks':['passing','failing'],'skips':{}}
        snap=self.root/'snapshot';snap.mkdir();(snap/'fixture.py').write_text('pass')
        self.binding=provenance.build_provenance(base_sha='a'*40,workspace_patch_sha256='none',
            snapshot_manifest=provenance.build_snapshot_manifest(snap),
            config=provenance.build_config(provenance.CONFIG_SCHEMA_VERSION,['app=test-bench']))
        cycle.write(self.fleet/'execution-provenance.json',self.binding)
        cycle.write(self.fleet/'_batch/lifecycle.json',{'version':1,'status':'verified','run_id':self.fleet.name,
            'workspace_root':str(self.root),'controller_exit_code':1,
            'fleet_owner_token':'exact-native-owner','hub_publication_failed':False,'audit_sha256':'b'*64})
        release=self.fleet/'teardown-ownership/provider-teardown-verified.epoch'
        release.parent.mkdir();release.write_text('3')
        (release.parent/'source-audit').write_text('sha256='+'b'*64+'\n')
        tasks=[]
        for name in self.request['checks']:
            passed=name=='passing'
            task={'name':name,'passed':passed,'benchmark_status':'PASSED' if passed else 'SKIPPED',
                  'status':'COMPLETED' if passed else 'SKIPPED','failure_reason':None if passed else 'Provider exhausted'}
            tasks.append(task)
            document=provenance.stamp_run_document({'timestamp':datetime.fromtimestamp(2,timezone.utc).isoformat(),
                'tasks':[task],'summary':{'total':1}},self.binding)
            cycle.write(self.fleet/name/'cloudbench-run.json',document)
            (self.fleet/name/'bench-e2e.finished-epoch').write_text('3')
        cycle.write(self.fleet/'_batch/run.json',provenance.stamp_run_document({
            'run_id':self.fleet.name,'timestamp':datetime.fromtimestamp(2,timezone.utc).isoformat(),
            'tasks':tasks,'summary':{'total':2}},self.binding))

    def tearDown(self):self.temp.cleanup()

    def collect(self):return self.cloud.collect(self.request,self.root,self.runs,1,1)

    def test_native_skip_is_failure_until_rca_and_passing_peer_survives(self):
        cases,evidence,cleaned,_=self.collect()
        self.assertEqual({'passing':'PASS','failing':'FAIL'},cases)
        self.assertTrue(cleaned)
        self.assertEqual('SKIPPED',evidence['failing']['native_task']['status'])

    def test_native_failed_case_can_be_qualified_without_rerunning_its_peer(self):
        cases,details,cleaned,_=self.collect()
        state={'phase':'initial','source':self.request['source'],'attempts':[], 'failures':[],
               'pending':[],'repair_gates':[],'skips':{},'input_fingerprints':{'smoke':'bound'}}
        cycle.advance(state,[{'gate':'smoke','cases':cases,'complete':cleaned,'command':['cloud-cli'],
                              'log':'native.log','worker_evidence':details}])
        failure=state['failures'][0]
        self.assertEqual('SKIPPED',failure['worker_evidence']['native_task']['status'])
        cycle.adjudicate(state,{'failures':[{'id':failure['id'],'check':'smoke/failing',
            'source':state['source'],'command':['cloud-cli'],'native_result':'FAIL',
            'description':'provider exhaustion','evidence':details['failing']['path'],
            'attribution':'NOT_INTRODUCED','external_provider':{'name':'provider','reason':'credits exhausted'}}]})
        self.assertTrue(state['ready'])
        self.assertEqual(1,len(state['attempts']))
        self.assertEqual({'smoke/failing'},set(state['skips']))

    def test_missing_child_is_unknown_not_a_waivable_aggregate(self):
        (self.fleet/'failing/cloudbench-run.json').unlink()
        cases,_,_,_=self.collect()
        self.assertEqual({'passing':'PASS','failing':'UNVERIFIED'},cases)

    def test_cleanup_or_wrong_native_source_blocks(self):
        path=self.fleet/'_batch/lifecycle.json';good=cycle.read(path)
        for field,value in [('status','failed'),('workspace_root','/other'),('controller_exit_code',0)]:
            with self.subTest(field=field):
                cycle.write(path,{**good,field:value})
                with self.assertRaises(ValueError):self.collect()
        cycle.write(path,good)
        self.request['source']['head']='b'*40
        with self.assertRaises(ValueError):self.collect()

    def test_duplicate_aggregate_task_is_refused(self):
        path=self.fleet/'_batch/run.json';document=cycle.read(path)
        document['tasks'][1]=copy.deepcopy(document['tasks'][0]);cycle.write(path,document)
        with self.assertRaises(ValueError):self.collect()

    def test_non_object_native_task_entry_is_unverified_not_a_crash(self):
        path=self.fleet/'failing/cloudbench-run.json'  # finding 4447557526
        for bad in (['x'], [None], []):
            with self.subTest(tasks=bad):
                document=cycle.read(path);document['tasks']=bad;cycle.write(path,document)
                cases,details,_,_=self.collect()
                self.assertEqual('UNVERIFIED',cases['failing']);self.assertIn('unverified',details['failing'])
                self.assertEqual('PASS',cases['passing'])

    def test_unexpected_adapter_error_still_writes_the_unverified_receipt(self):
        request=self.root/'request.json';result=self.root/'result.json';cycle.write(request,self.request)
        with patch.object(self.cloud,'execute',side_effect=RuntimeError('unexpected')), \
             patch.dict(os.environ,{'DEPLOY_GATE_REQUEST':str(request),'DEPLOY_GATE_RESULT':str(result)}), \
             patch.object(sys,'argv',['deploy_test_cloud','--root',str(self.root)]):
            code=self.cloud.main()
        self.assertEqual(3,code)
        receipt=cycle.read(result)
        self.assertEqual({'passing':'UNVERIFIED','failing':'UNVERIFIED'},receipt['cases'])
        self.assertFalse(receipt['complete']);self.assertFalse(receipt['cleanup_complete']);self.assertIn('unexpected',receipt['reason'])

    def test_cancelled_case_does_not_become_skipped(self):
        path=self.fleet/'failing/cloudbench-run.json';document=cycle.read(path)
        document['tasks'][0]['benchmark_status']='CANCELLED';cycle.write(path,document)
        self.assertEqual('UNVERIFIED',self.collect()[0]['failing'])

    def test_cloud_cli_gets_only_active_cases_and_frozen_ref(self):
        self.request.update(checks=['passing'],skips={'failing':{'disposition':'external / waived'}})
        with patch.object(self.cloud,'source',return_value=self.request['source']), \
             patch.object(self.cloud,'run_command',return_value=(0,False,False,False)) as launch, \
             patch.object(self.cloud,'collect_campaign',return_value=({'passing':'PASS'},{},True,'native-run')):
            result=self.cloud.execute(self.request,self.root)
        argv=launch.call_args.args[0]
        self.assertEqual(['bash','scripts/run-bench','passing','--runs','1','--concurrency','1','--retry-infra','0','--ref','a'*40],argv)
        self.assertNotIn('failing',argv)
        self.assertEqual('1',launch.call_args.kwargs['env']['CLOUDBENCH_SKIP_LOCAL_PATCH'])
        self.assertTrue(result['complete'])

    def test_cloud_admission_limit_preserves_every_selected_case(self):
        with patch.dict(os.environ, {'DEPLOY_CLOUD_CONCURRENCY': '1'}), \
             patch.object(self.cloud, 'source', return_value=self.request['source']), \
             patch.object(self.cloud, 'run_command', return_value=(0,False,False,False)) as launch, \
             patch.object(self.cloud, 'collect_campaign', return_value=({'passing':'PASS','failing':'PASS'},{},True,'native-run')):
            result=self.cloud.execute(self.request,self.root)
        argv=launch.call_args.args[0]
        self.assertEqual(['passing','failing'],argv[2:4])
        self.assertEqual('1',argv[argv.index('--concurrency')+1])
        self.assertEqual('1',argv[argv.index('--runs')+1])
        self.assertEqual('0',argv[argv.index('--retry-infra')+1])
        self.assertEqual({'passing':'PASS','failing':'PASS'},result['cases'])
        self.assertTrue(result['complete'])

    def test_cloud_admission_limit_cannot_raise_provider_capacity(self):
        checks=[str(i) for i in range(100)]
        with patch.dict(os.environ, {'DEPLOY_CLOUD_CONCURRENCY': '1000'}):
            limited=self.cloud.campaign_width(checks)
        with patch.dict(os.environ, {}, clear=True):
            provider_width=self.cloud.campaign_width(checks)
        self.assertEqual(provider_width,limited)

    def test_invalid_cloud_admission_limit_fails_before_launch(self):
        for value in ('', '0', '-1', '1.5', ' 2', 'two'):
            with self.subTest(value=value), patch.dict(os.environ, {'DEPLOY_CLOUD_CONCURRENCY':value}), \
                 patch.object(self.cloud, 'source', return_value=self.request['source']), \
                 patch.object(self.cloud, 'run_command') as launch:
                with self.assertRaisesRegex(ValueError,'DEPLOY_CLOUD_CONCURRENCY'):
                    self.cloud.execute(self.request,self.root)
                launch.assert_not_called()

    def test_cloud_launch_records_selected_standing_skip_eligibility_before_dispatch(self):
        names=['browser-auth-guest-purchase','claude-only','ordinary']
        self.request.update(checks=names,skips={'excluded-payment':{'disposition':'unchanged'}})
        catalog=self.root/'agents/benchmarks/tasks.json'
        catalog.parent.mkdir(parents=True)
        cycle.write(catalog,[
            {'name':names[0],'tags':['agentcard-lifecycle-sandbox'],
             'expected_payment_lifecycle':{'orgTransfer':{'livemode':False}}},
            {'name':names[1],'tags':[],'requires_claude_code':True},
            {'name':names[2],'tags':[]},
            {'name':'excluded-payment','tags':['agentcard-lifecycle-sandbox'],
             'expected_payment_lifecycle':{'orgTransfer':{'livemode':False}}},
        ])
        messages=io.StringIO()
        def launch(argv, **kwargs):
            # Guidance must be durable in the exact native runner log BEFORE dispatch.
            kwargs['output'].flush()
            text=(kwargs['cwd']/'.context/deploy-cloud'/hashlib.sha256(self.request['token'].encode()).hexdigest()/'cli.log').read_text()
            self.assertIn('Standing skip eligibility',text)
            self.assertIn('_agentcard_release_skip_lifecycle',text)
            self.assertIn('_check_claude_code_credentials',text)
            self.assertNotIn('excluded-payment',text)
            self.assertNotIn('ordinary:',text)
            return 0,False,False,False
        import hashlib
        with patch.object(self.cloud,'source',return_value=self.request['source']), \
             patch.object(self.cloud,'run_command',side_effect=launch) as dispatched, \
             patch.object(self.cloud,'collect_campaign',return_value=(dict.fromkeys(names,'PASS'),{},True,'native-run')), \
             contextlib.redirect_stderr(messages):
            result=self.cloud.execute(self.request,self.root)
        self.assertIn('not a SKIP verdict',messages.getvalue())
        self.assertIn('All other assertions and owned-resource cleanup remain required',messages.getvalue())
        self.assertEqual(names,dispatched.call_args.args[0][2:5])
        self.assertEqual(dict.fromkeys(names,'PASS'),result['cases'])
        self.assertTrue(result['complete'])

    # --- quarantine markers and the single same-source rerun -------------------------------------
    QMETA={'since':'2026-11-01','repair':'https://boxes.dev/thread/thr_smoke1',
           'error':'AssertionError: no receipt','evidence':'runs/smoke-1/run.json'}

    def campaign(self,verdicts,outcome='FAILED'):
        """A collect_campaign return value: verdicts per task, native outcome for the failures."""
        details={n:{'native_task':{'name':n,'passed':v=='PASS','benchmark_status':'PASSED' if v=='PASS' else outcome,
                                   'status':'COMPLETED' if v=='PASS' else outcome,
                                   'failure_reason':None if v=='PASS' else f'{n} failed'},'path':f'/runs/{n}'}
                 for n,v in verdicts.items()}
        return dict(verdicts),details,True,'campaign'

    def run_smoke(self,collected,catalog=None):
        """execute() with the native CLI and collector replaced; returns result, launches, rows, stdout."""
        if catalog is not None:
            path=self.root/'agents/benchmarks/tasks.json';path.parent.mkdir(parents=True,exist_ok=True)
            cycle.write(path,catalog)
        rows=self.root/'progress.jsonl';rows.unlink(missing_ok=True);out=io.StringIO()
        with patch.object(self.cloud,'source',return_value=self.request['source']), \
             patch.object(self.cloud,'run_command',return_value=(1,False,False,False)) as launch, \
             patch.object(self.cloud,'collect_campaign',side_effect=collected) as collect, \
             patch.dict(os.environ,{'DEPLOY_GATE_PROGRESS':str(rows)}), contextlib.redirect_stdout(out):
            self.launch=launch
            result=self.cloud.execute(self.request,self.root)
        import deploy_gate_progress as progress
        return result,launch,collect,progress.read_new(rows)[0],out.getvalue()

    def test_failed_smoke_task_passing_its_single_rerun_is_flaky_and_the_gate_passes(self):
        result,launch,collect,rows,out=self.run_smoke([self.campaign({'passing':'PASS','failing':'FAIL'}),
                                                       self.campaign({'failing':'PASS'})])
        self.assertEqual(2,launch.call_count)
        rerun=launch.call_args_list[1].args[0]
        self.assertEqual(['bash','scripts/run-bench','failing'],rerun[:3])  # that task only, same frozen ref
        self.assertEqual(['--ref','a'*40],rerun[-2:])
        self.assertNotIn('passing',rerun)
        self.assertEqual(['failing'],collect.call_args_list[1].args[0]['checks'])
        env=launch.call_args_list[1].kwargs['env']
        self.assertTrue(env['RUN_BENCH_CAMPAIGN_ID'].endswith('-rerun'))
        self.assertNotEqual(launch.call_args_list[0].kwargs['env']['CLOUDBENCH_RUNS_ROOT'],env['CLOUDBENCH_RUNS_ROOT'])
        self.assertEqual({'passing':'PASS','failing':'PASS'},result['cases'])
        self.assertTrue(result['complete'])
        self.assertEqual('FAILED',result['evidence']['failing']['native_task']['benchmark_status'])  # first attempt kept
        self.assertEqual('PASSED',result['evidence']['failing']['rerun']['native_task']['benchmark_status'])
        self.assertEqual([('failing','FLAKY',2)],[(r['unit'],r['status'],r.get('attempts')) for r in rows])
        self.assertIn('TEST_FLAKY unit=failing attempts=2 attribution=REQUIRED',out)
        from deploy_test_result import validate
        self.assertEqual((result['cases'],True),validate(result,self.request,0))  # adapter exit 0 = gate pass
        state={'source':self.request['source'],'flaky':[],'phase':'initial','round':1}
        opened=cycle.open_flaky(state,{'name':'smoke','checks':self.request['checks']},rows,self.root/'flaky')
        self.assertEqual([('failing','smoke/failing')],[(o['unit'],o['check']) for o,_ in opened])
        import deploy_test_quarantine as quarantine
        self.assertIn('lack /RCA attribution',quarantine.attribution_block(state['flaky']))  # merge refuses

    def test_failed_smoke_task_failing_its_rerun_fails_and_is_never_run_a_third_time(self):
        result,launch,_,rows,out=self.run_smoke([self.campaign({'passing':'PASS','failing':'FAIL'}),
                                                 self.campaign({'failing':'FAIL'})])
        self.assertEqual(2,launch.call_count)
        self.assertEqual({'passing':'PASS','failing':'FAIL'},result['cases'])
        self.assertEqual('FAIL',result['rerun']['cases']['failing'])
        self.assertEqual([],rows);self.assertNotIn('TEST_FLAKY',out)
        from deploy_test_result import validate
        self.assertEqual('FAIL',validate(result,self.request,1)[0]['failing'])

    def test_resource_skip_and_infra_outcomes_keep_their_rca_handling_without_a_rerun(self):
        for outcome in ('SKIPPED','INFRA_ERROR'):
            with self.subTest(outcome=outcome):
                shutil.rmtree(self.root/'.context',ignore_errors=True)
                result,launch,_,rows,_=self.run_smoke([self.campaign({'passing':'PASS','failing':'FAIL'},outcome)])
                self.assertEqual(1,launch.call_count)
                self.assertEqual('FAIL',result['cases']['failing']);self.assertNotIn('rerun',result)
                self.assertEqual([],rows)

    def test_unverified_first_campaign_is_never_rerun(self):
        verdicts,details,_,fleet=self.campaign({'passing':'PASS','failing':'FAIL'})
        result,launch,_,_,_=self.run_smoke([(verdicts,details,False,fleet)])
        self.assertEqual(1,launch.call_count);self.assertFalse(result['complete'])

    def test_quarantined_smoke_task_runs_once_and_its_failure_is_non_blocking(self):
        catalog=[{'name':'failing','quarantine':dict(self.QMETA)},{'name':'passing'}]
        result,launch,_,rows,out=self.run_smoke([self.campaign({'passing':'PASS','failing':'FAIL'})],catalog)
        self.assertEqual(1,launch.call_count)  # still runs, never rerun
        self.assertIn('failing',launch.call_args.args[0])
        self.assertEqual({'passing':'PASS','failing':'PASS'},result['cases']);self.assertTrue(result['complete'])
        self.assertEqual([('failing','QUARANTINED_FAIL',self.QMETA)],[(r['unit'],r['status'],r['quarantine']) for r in rows])
        self.assertEqual('failing failed',rows[0]['detail'])
        self.assertIn(f"TEST_QUARANTINE status=QUARANTINED_FAIL unit=failing since=2026-11-01 repair={self.QMETA['repair']}",out)
        self.assertEqual(('QUARANTINED_FAIL','FAIL'),tuple(result['evidence']['failing']['quarantine'][k] for k in ('status','native_case')))
        self.assertEqual('FAILED',result['evidence']['failing']['native_task']['benchmark_status'])  # failure preserved

    def test_quarantined_smoke_task_pass_and_unverified_outcomes(self):
        catalog=[{'name':'failing','quarantine':dict(self.QMETA)}]
        _,_,_,rows,_=self.run_smoke([self.campaign({'passing':'PASS','failing':'PASS'})],catalog)
        self.assertEqual([('failing','QUARANTINED_PASS')],[(r['unit'],r['status']) for r in rows])
        shutil.rmtree(self.root/'.context')
        verdicts,details,_,fleet=self.campaign({'passing':'PASS','failing':'UNVERIFIED'})
        result,_,_,rows,_=self.run_smoke([(verdicts,details,True,fleet)],catalog)
        self.assertEqual('UNVERIFIED',result['cases']['failing']);self.assertEqual([],rows)  # unknown still blocks

    def test_quarantined_smoke_task_skip_and_infra_outcomes_stay_blocking(self):
        catalog=[{'name':'failing','quarantine':dict(self.QMETA)}]
        for outcome in ('SKIPPED','INFRA_ERROR'):
            with self.subTest(outcome=outcome):
                shutil.rmtree(self.root/'.context',ignore_errors=True)
                result,launch,_,rows,out=self.run_smoke([self.campaign({'passing':'PASS','failing':'FAIL'},outcome)],catalog)
                self.assertEqual(1,launch.call_count)
                self.assertEqual('FAIL',result['cases']['failing']);self.assertNotIn('quarantine',result['evidence']['failing'])
                self.assertEqual([],rows);self.assertNotIn('TEST_QUARANTINE',out)

    def test_invalid_task_quarantine_marker_is_refused_before_launch(self):
        for bad in ({**self.QMETA,'repair':'https://example.com/x'},{k:v for k,v in self.QMETA.items() if k!='evidence'},
                    {**self.QMETA,'since':'2026-13-01'},{**self.QMETA,'extra':'x'},'quarantined'):
            with self.subTest(marker=bad):
                with self.assertRaises(ValueError):
                    self.run_smoke([],[{'name':'failing','quarantine':bad}])
                self.launch.assert_not_called()
                self.assertFalse((self.root/'.context/deploy-cloud').exists())  # nothing admitted


class CloudCampaign(unittest.TestCase):
    def setUp(self):
        Cloud.setUp(self)
        import shutil
        self.runs = self.root/'.context/runs'
        self.runs.mkdir(parents=True)
        shutil.rmtree(self.fleet)
        self.campaign = self.root/'.context/campaigns/request'
        self.campaign.mkdir(parents=True)
        self.request['checks'] = [f'task-{i}' for i in range(17)]
        jobs=[]
        for i,name in enumerate(self.request['checks']):
            fleet=self.runs/f'fleet-{i}'
            cycle.write(fleet/'execution-provenance.json',self.binding)
            cycle.write(fleet/'_batch/lifecycle.json',{'version':1,'status':'verified','run_id':fleet.name,
                'workspace_root':str(self.root),'controller_exit_code':0,'fleet_owner_token':f'owner-{i}',
                'hub_publication_failed':False,'audit_sha256':'b'*64})
            cycle.write(fleet/'_batch/run.json',self.provenance.stamp_run_document({
                'run_id':fleet.name,'timestamp':datetime.fromtimestamp(2,timezone.utc).isoformat(),
                'tasks':[{'name':name,'passed':True,'benchmark_status':'PASSED','status':'COMPLETED'}],
                'summary':{'total':1}},self.binding))
            cycle.write(fleet/name/'cloudbench-run.json',cycle.read(fleet/'_batch/run.json'))
            (fleet/name/'bench-e2e.finished-epoch').write_text('3')
            (fleet/'teardown-ownership').mkdir()
            (fleet/'teardown-ownership/source-audit').write_text('sha256='+'b'*64+'\n')
            (fleet/'teardown-ownership/provider-teardown-verified.epoch').write_text('3')
            log=self.campaign/f'job-{i}.log'
            log.write_text(f'{self.root}/scripts/run-bench monitor {fleet}\n')
            jobs.append({'job_id':f'job-{i}','task':name,'run':1,'attempt':1,'attempts':[],
                'status':'passed','controller_exit_code':0,'log':str(log),
                'started_at':datetime.fromtimestamp(2,timezone.utc).isoformat(),
                'finished_at':datetime.fromtimestamp(3,timezone.utc).isoformat()})
        self.summary={'campaign_id':'request','runs':1,'retry_infra':0,'concurrency':16,'peak_concurrency':16,
            'task_count':17,'total_jobs':17,'status':'passed','jobs':jobs,
            'started_at':datetime.fromtimestamp(2,timezone.utc).isoformat(),
            'finished_at':datetime.fromtimestamp(3,timezone.utc).isoformat()}
        self.seal_campaign(self.campaign)

    def seal_campaign(self, directory):
        import runpy, hashlib
        cycle.write(directory/'summary.json',self.summary)
        native=runpy.run_path(str(ROOT/'scripts/run-bench-campaign.py'))
        record=native['campaign_group_record'](self.summary)
        cycle.write(directory/'hub-group.json',record)
        cycle.write(directory/'hub-group-publication-ack.private.json',{'pid':2147483647,'token':'c'*32,
            'record_sha256':hashlib.sha256(json.dumps(record,sort_keys=True).encode()).hexdigest()})

    def tearDown(self): Cloud.tearDown(self)

    def campaign_collect(self):
        return self.cloud.collect_campaign(self.request,self.root,self.runs,self.campaign,1,0,16)

    def test_all_seventeen_native_receipts_survive_bounded_campaign(self):
        cases,details,cleaned,_=self.campaign_collect()
        self.assertEqual(dict.fromkeys(self.request['checks'],'PASS'),cases)
        self.assertEqual(17,len(details));self.assertTrue(cleaned)

    def test_queued_job_and_missing_native_receipt_remain_unknown(self):
        self.summary['status']='failed';self.summary['jobs'][-1]['status']='queued'
        cycle.write(self.campaign/'summary.json',self.summary)
        cases,_,cleaned,_=self.campaign_collect()
        self.assertEqual('UNVERIFIED',cases['task-16']);self.assertEqual('PASS',cases['task-0'])
        self.assertFalse(cleaned)

    def test_wrong_provenance_and_missing_cleanup_are_not_passed(self):
        for path in [self.runs/'fleet-16/execution-provenance.json',
                     self.runs/'fleet-15/teardown-ownership/provider-teardown-verified.epoch']:
            path.unlink()
        cases,_,cleaned,_=self.campaign_collect()
        self.assertEqual('UNVERIFIED',cases['task-16']);self.assertEqual('UNVERIFIED',cases['task-15'])
        self.assertEqual('PASS',cases['task-0']);self.assertFalse(cleaned)

    def test_duplicate_job_and_over_capacity_are_rejected(self):
        for field,value in [('jobs',self.summary['jobs'][:-1]+[self.summary['jobs'][0]]),
                            ('peak_concurrency',17)]:
            with self.subTest(field=field):
                cycle.write(self.campaign/'summary.json',{**self.summary,field:value})
                with self.assertRaises(ValueError):self.campaign_collect()

    def test_native_failure_stays_failed_and_passing_peers_remain_passed(self):
        fleet=self.runs/'fleet-16'
        for path in [fleet/'_batch/run.json',fleet/'task-16/cloudbench-run.json']:
            doc=cycle.read(path);doc['tasks'][0].update(passed=False,benchmark_status='FAILED',status='FAILED')
            cycle.write(path,doc)
        doc=cycle.read(fleet/'_batch/lifecycle.json');doc['controller_exit_code']=1
        cycle.write(fleet/'_batch/lifecycle.json',doc)
        self.summary['status']='failed';self.summary['jobs'][-1].update(status='failed',controller_exit_code=1)
        self.seal_campaign(self.campaign)
        cases,_,cleaned,_=self.cloud.collect_campaign(self.request,self.root,self.runs,self.campaign,1,1,16)
        self.assertEqual('FAIL',cases['task-16']);self.assertEqual('PASS',cases['task-0']);self.assertTrue(cleaned)

    def seal_native_lifecycle(self, fleet, *, teardown='0', benches='task-5', autoscaler='1'):
        """Run the fleet's actual lifecycle writer for a controller that exited 1."""
        text=(ROOT/'scripts/run-bench-fleet').read_text()
        start=text.index("<<'PY'\n",text.index('# Seal the lifecycle after provider audit'))
        body=text[text.index('\n',start)+1:text.index('\nPY\n',start)]
        owner=cycle.read(fleet/'_batch/lifecycle.json')['fleet_owner_token']
        (fleet/'_batch/lifecycle.json').unlink()
        subprocess.run([sys.executable,'-c',body,str(fleet),owner,fleet.name,str(self.root),'1',teardown,'0','1',
                        autoscaler,str(self.root/'registry'),'0','1'],check=True,timeout=30,
                       env={**os.environ,'CLOUDBENCH_AUTOSCALER_FAILED_BENCHES':benches})

    def mass_agent_autoscaler_capacity_failure(self, **lifecycle):
        """PR #1760 smoke: the task passed, its worker clone was capacity-denied, teardown was verified."""
        fleet=self.runs/'fleet-5'
        (fleet/'task-5/autoscaler.failed').write_text('Machine-count capacity unavailable for worker clone\n')
        self.seal_native_lifecycle(fleet,**lifecycle)
        self.summary['status']='failed';self.summary['jobs'][5].update(status='failed',controller_exit_code=1)
        self.seal_campaign(self.campaign)
        return self.cloud.collect_campaign(self.request,self.root,self.runs,self.campaign,1,1,16)

    def test_autoscaler_capacity_failure_is_one_verified_failure_not_an_unverified_gate(self):
        from deploy_test_result import validate
        cases,details,cleaned,_=self.mass_agent_autoscaler_capacity_failure()
        self.assertEqual('FAIL',cases['task-5'])
        self.assertEqual({name:'PASS' for name in self.request['checks'] if name!='task-5'},
                         {k:v for k,v in cases.items() if k!='task-5'})
        self.assertTrue(cleaned)
        self.assertEqual('Machine-count capacity unavailable for worker clone',
                         details['task-5']['mandatory_autoscaler_failure'])
        result={**{k:self.request[k] for k in ('token','source','gate')},'cases':cases,'complete':True,
                'cleanup_complete':cleaned,'reused':False}
        self.assertEqual((cases,True),validate(result,self.request,1))
        lifecycle=cycle.read(self.runs/'fleet-5/_batch/lifecycle.json')
        self.assertEqual('failed',lifecycle['status'])  # existing consumers keep the run-level verdict
        self.assertEqual((True,['task-5']),(lifecycle['cleanup_verified'],lifecycle['autoscaler_failed_benches']))

    def test_autoscaler_failure_with_unverified_teardown_still_blocks_cleanup(self):
        cases,details,cleaned,_=self.mass_agent_autoscaler_capacity_failure(teardown='1')
        self.assertEqual('UNVERIFIED',cases['task-5']);self.assertFalse(cleaned)
        self.assertIn('native cleanup was not verified',details['task-5']['unverified'])

    def test_unattributed_failed_lifecycle_still_blocks_cleanup(self):
        for benches in ('', 'task-5 not-requested'):
            with self.subTest(benches=benches):
                cases,details,cleaned,_=self.mass_agent_autoscaler_capacity_failure(benches=benches)
                self.assertEqual('failed',cycle.read(self.runs/'fleet-5/_batch/lifecycle.json')['status'])
                self.assertEqual('UNVERIFIED',cases['task-5']);self.assertFalse(cleaned)
                self.assertIn('native cleanup was not verified',details['task-5']['unverified'])

    def test_unreadable_autoscaler_reason_keeps_the_verified_failure(self):
        (self.runs/'fleet-5/task-5/autoscaler.failed').write_text('x\n')
        with patch.object(Path,'open',side_effect=PermissionError('denied')):
            reason=self.cloud.autoscaler_reason(self.runs/'fleet-5/task-5')
        self.assertEqual('mandatory autoscaler failed; autoscaler.failed unreadable',reason)

    def test_unreadable_native_record_is_unverified_not_pass(self):
        real=Path.read_bytes
        def read_bytes(path):
            if path.name=='cloudbench-run.json' and path.parent.name=='task-3':
                raise PermissionError('denied')
            return real(path)
        with patch.object(Path,'read_bytes',read_bytes):
            cases,details,_,_=self.campaign_collect()
        self.assertEqual('UNVERIFIED',cases['task-3']);self.assertIn('unverified',details['task-3'])

    def test_fleet_attributes_every_autoscaler_failure_branch_to_its_bench(self):
        text=(ROOT/'scripts/run-bench-fleet').read_text()
        start=text.index('AUTOSCALER_FAILED_BENCHES=()\n')
        loop=text[start:text.index('\ndone\n',start)]
        self.assertNotIn('AUTOSCALER_FAILURE=1\n        ',loop.split('if [ "$autoscaler_bench_failed" = 1 ]')[0])
        self.assertGreaterEqual(loop.count('autoscaler_bench_failed=1'),7)
        self.assertIn('AUTOSCALER_FAILED_BENCHES+=("${CHILD_BENCH[$j]}")',loop)

    def test_execute_seventeen_tasks_crosses_real_capacity_and_receipt_boundary(self):
        import shutil
        import runpy
        capacity=runpy.run_path(str(ROOT/'scripts/cloudbench-provider-capacity.py'))
        def launch(argv, **kwargs):
            width=int(argv[argv.index('--concurrency')+1]) if '--concurrency' in argv else 17
            admitted=capacity['check'](width,browser_provider='tilion')
            if admitted:
                return admitted,False,False,False
            target_runs=Path(kwargs['env']['CLOUDBENCH_RUNS_ROOT'])
            target_campaign=Path(kwargs['env']['RUN_BENCH_CAMPAIGN_ROOT'])/kwargs['env']['RUN_BENCH_CAMPAIGN_ID']
            target_campaign.mkdir(parents=True)
            for index,job in enumerate(self.summary['jobs']):
                destination=target_runs/f'fleet-{index}'
                shutil.copytree(self.runs/f'fleet-{index}',destination)
                log=target_campaign/f'job-{index}.log'
                log.write_text(f'{self.root}/scripts/run-bench monitor {destination}\n')
                job['log']=str(log)
            self.summary['campaign_id']=target_campaign.name
            self.seal_campaign(target_campaign)
            return 0,False,False,False
        with patch.dict(os.environ,{'CLOUDBENCH_BROWSER_PROVIDER':'tilion','CLOUDBENCH_PROVIDER_LIMITS_FILE':str(ROOT/'scripts/cloudbench-provider-limits.json')}), \
             patch.object(self.cloud,'source',return_value=self.request['source']), \
             patch.object(self.cloud,'run_command',side_effect=launch), \
             patch.object(self.cloud.time,'time',return_value=1):
            result=self.cloud.execute(self.request,self.root)
        self.assertEqual(dict.fromkeys(self.request['checks'],'PASS'),result['cases'])
        self.assertTrue(result['complete']);self.assertTrue(result['cleanup_complete'])

    def execute_below_cap_campaign(self, count):
        import runpy
        import socket
        capacity=runpy.run_path(str(ROOT/'scripts/cloudbench-provider-capacity.py'))
        self.request['checks']=self.request['checks'][:count]
        excluded=('browser-auth-member-discount-purchase','email-otp-signin')
        self.request['skips']={name:{'disposition':'external / waived'} for name in excluded}
        self.summary.update(task_count=count,total_jobs=count,concurrency=count,peak_concurrency=count,
                            jobs=self.summary['jobs'][:count])
        reservation_source=(ROOT/'scripts/run-bench-fleet').read_text()
        start=reservation_source.index('capacity_reserve_slots() {')
        body=reservation_source[reservation_source.index("<<'PY'\n",start)+len("<<'PY'\n"):].split('\nPY\n',1)[0]
        commands=[]

        def launch(argv, **kwargs):
            commands.append(argv)
            campaign='--runs' in argv
            width=int(argv[argv.index('--concurrency')+1]) if campaign else count
            self.assertEqual(0,capacity['check'](width,browser_provider='tilion'))
            self.assertFalse(set(excluded)&set(argv))
            slots=1 if campaign else count
            ledger=self.root/('capacity-'+str(slots));ledger.mkdir()
            # Execute the real admission predicate with native38/56 pressure;
            # isolate machine count (sharedCPU0) in an empty private ledger.
            admitted=subprocess.run([sys.executable,'-S','-c',body,str(ledger),'f'*32+'-test',
                'private-fixture',socket.gethostname(),str(os.getpid()),'fixture-owner-birth',
                'fixture-run','f'*32,str(ledger/'ownership'),str(slots+min(4,slots)),
                '0','56','140','38','0','private-control'],capture_output=True,text=True)
            if not campaign:
                self.assertEqual(1,admitted.returncode,admitted.stdout+admitted.stderr)
                self.assertIn('DENY_MACHINE',admitted.stdout)
                target_runs=Path(kwargs['env']['CLOUDBENCH_RUNS_ROOT'])
                for name in ('admission-stopped-parent','nested-canary'):
                    (target_runs/name/'_batch').mkdir(parents=True)
                return 1,False,False,False
            self.assertEqual(0,admitted.returncode,admitted.stdout+admitted.stderr)
            self.assertEqual('1',argv[argv.index('--runs')+1])
            self.assertEqual('0',argv[argv.index('--retry-infra')+1])
            self.assertNotIn('--wait',argv)
            self.assertNotIn('--strict-start',argv)
            self.assertEqual(str(count),argv[argv.index('--concurrency')+1])
            self.assertEqual(self.request['source']['head'],argv[argv.index('--ref')+1])
            target_runs=Path(kwargs['env']['CLOUDBENCH_RUNS_ROOT'])
            target_campaign=Path(kwargs['env']['RUN_BENCH_CAMPAIGN_ROOT'])/kwargs['env']['RUN_BENCH_CAMPAIGN_ID']
            target_campaign.mkdir(parents=True)
            for index,job in enumerate(self.summary['jobs']):
                destination=target_runs/f'fleet-{index}'
                shutil.copytree(self.runs/f'fleet-{index}',destination)
                canary=target_runs/f'canary-{index}'
                shutil.copytree(destination,canary)
                log=target_campaign/f'job-{index}.log'
                log.write_text(f'{self.root}/scripts/run-bench monitor {destination}\n'
                               f'{self.root}/scripts/run-bench monitor {canary}\n')
                job['log']=str(log)
            self.summary['campaign_id']=target_campaign.name
            self.seal_campaign(target_campaign)
            return 0,False,False,False

        with patch.dict(os.environ,{'CLOUDBENCH_BROWSER_PROVIDER':'tilion','CLOUDBENCH_PROVIDER_LIMITS_FILE':str(ROOT/'scripts/cloudbench-provider-limits.json')}), \
             patch.object(self.cloud,'source',return_value=self.request['source']), \
             patch.object(self.cloud,'run_command',side_effect=launch), \
             patch.object(self.cloud.time,'time',return_value=1):
            result=self.cloud.execute(self.request,self.root)
        self.assertEqual(dict.fromkeys(self.request['checks'],'PASS'),result['cases'])
        self.assertEqual(count,len(result['evidence']))
        self.assertTrue(result['complete']);self.assertTrue(result['cleanup_complete'])
        self.assertEqual(self.request['source'],result['source'])
        for name,detail in result['evidence'].items():
            self.assertNotIn('canary-',detail['path'])
            self.assertEqual(self.binding,cycle.read(Path(detail['path']))['execution_provenance'])
        self.assertEqual(1,len(commands))

    def test_execute_fifteen_under_cap_uses_native_campaign_receipts_with_canaries(self):
        self.execute_below_cap_campaign(15)

    def test_execute_single_check_uses_native_campaign_receipt_with_canary(self):
        self.execute_below_cap_campaign(1)

    def test_parent_cleanup_and_publication_gaps_remain_incomplete(self):
        self.test_native_failure_stays_failed_and_passing_peers_remain_passed()
        for field,value in [('shared_inventory_failed',True),
                            ('startup_cohorts',[{'cleanup_budget_retirement_pending':True}])]:
            with self.subTest(field=field):
                cycle.write(self.campaign/'summary.json',{**self.summary,field:value})
                self.assertFalse(self.cloud.collect_campaign(self.request,self.root,self.runs,self.campaign,1,1,16)[2])
        cycle.write(self.campaign/'summary.json',self.summary)
        ack=self.campaign/'hub-group-publication-ack.private.json'
        ack.unlink()
        self.assertFalse(self.cloud.collect_campaign(self.request,self.root,self.runs,self.campaign,1,1,16)[2])
        self.seal_campaign(self.campaign)
        value=cycle.read(ack);value['record_sha256']='0'*64;cycle.write(ack,value)
        self.assertFalse(self.cloud.collect_campaign(self.request,self.root,self.runs,self.campaign,1,1,16)[2])

    def test_campaign_command_preserves_inventory_and_uses_registry_capacity(self):
        with patch.dict(os.environ,{'CLOUDBENCH_BROWSER_PROVIDER':'tilion','CLOUDBENCH_PROVIDER_LIMITS_FILE':str(ROOT/'scripts/cloudbench-provider-limits.json')}), \
             patch.object(self.cloud,'source',return_value=self.request['source']), \
             patch.object(self.cloud,'run_command',return_value=(0,False,False,False)) as launch, \
             patch.object(self.cloud,'collect_campaign',return_value=(dict.fromkeys(self.request['checks'],'PASS'),{},True,'campaign')):
            result=self.cloud.execute(self.request,self.root)
        argv=launch.call_args.args[0]
        self.assertEqual(['bash','scripts/run-bench',*self.request['checks'],'--runs','1',
                          '--concurrency','16','--retry-infra','0','--ref','a'*40],argv)
        self.assertNotIn('--wait',argv);self.assertTrue(result['complete'])


FAKE_CLI = """#!/usr/bin/env python3
import json, os, signal, sys, time
calls = os.environ['FAKE_DVB_CALLS']; config = json.load(open(os.environ['FAKE_DVB_CONFIG']))
with open(calls, 'a') as stream: stream.write(json.dumps(sys.argv[1:]) + '\\n')
key = sys.argv[2]
if key == 'list' and '--all' not in sys.argv: key = 'list_page1'  # native CLI: one page unless --all
reply = config.get(key, {'rc': 1, 'stdout': {}, 'stderr': 'unsupported'})
if isinstance(reply, list):
    count = sum(json.loads(line)[1] == key for line in open(calls))
    reply = reply[min(count - 1, len(reply) - 1)]
if reply.get('ignore_term'): signal.signal(signal.SIGTERM, signal.SIG_IGN)
time.sleep(reply.get('sleep', 0))
sys.stdout.write(json.dumps(reply.get('stdout', {}))); sys.stderr.write(reply.get('stderr', ''))
raise SystemExit(reply.get('rc', 0))
"""


class Boxes(unittest.TestCase):
    """Fake dvb-onbox on PATH; nothing here contacts boxes.dev or runs services."""
    def setUp(self):
        import deploy_test_boxes as boxes
        self.boxes = boxes
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name) / 'worker'
        self.root.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'code').write_text('fixture'); (self.root / '.git/info/exclude').write_text('.context/\n')
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'f'], check=True)
        self.coordinator = Path(self.temp.name) / 'coordinator'; self.coordinator.mkdir()
        self.recipe = {'cases': {'first': {'command': [sys.executable, '-c', 'pass']},
                                 'second': {'command': [sys.executable, '-c', 'pass']}}}
        self.request = {'token': 'tok-1', 'source': cycle.source(self.root), 'gate': 'gate', 'checks': ['first', 'second'],
                        'skips': {}, 'phase': 'initial', 'worker_recipe': self.recipe, 'worker_root': str(self.root.resolve())}
        self.envelope = json.loads((ROOT / 'scripts/tests/fixtures/boxes-thread-result-envelope.json').read_text())
        self.host = self.envelope['data']['executionInstanceId']  # real platform-authored devbox id
        self.binding = {'worker_thread': 'ph-worker', 'worker_host': self.host, 'worker_root': str(self.root.resolve()),
                        'python': str(self.root.resolve() / 'agents/venv/bin/python'), 'coordinator_thread': 'ph-control'}
        self.attachments = Path(self.temp.name) / 'attachments' / 'rose-box' / 'ph-control'; self.attachments.mkdir(parents=True)
        bin_dir = Path(self.temp.name) / 'bin'; bin_dir.mkdir()
        cli = bin_dir / 'dvb-onbox'; cli.write_text(FAKE_CLI); cli.chmod(0o700)
        self.calls = Path(self.temp.name) / 'calls.jsonl'; self.config = Path(self.temp.name) / 'config.json'
        self.env = patch.dict(os.environ, {'PATH': f"{bin_dir}{os.pathsep}{os.environ['PATH']}", 'FAKE_DVB_CALLS': str(self.calls),
                                           'FAKE_DVB_CONFIG': str(self.config), 'DEPLOY_BOXES_POLL_SECONDS': '0.01',
                                           'DEPLOY_BOXES_ATTACHMENTS_ROOT': str(self.attachments.parents[1])})
        self.env.start()
        native = worker.execute(self.request, self.root)  # the real native worker document
        self.native_bytes = json.dumps(native, indent=2, allow_nan=False) + '\n'
        self.native = native
        self.configure(reply=self.reply())

    def tearDown(self):
        self.env.stop(); cycle.CANCEL.clear(); self.temp.cleanup()

    def reply(self, body=None, exit_code=0, sha=None, inline=True):
        body = self.native_bytes if body is None else body
        sha = sha or __import__('hashlib').sha256(body.encode()).hexdigest()
        block = f'DEPLOY_GATE_RESULT_JSON_BEGIN\n{body}DEPLOY_GATE_RESULT_JSON_END\n' if inline else ''
        return (f'DEPLOY_GATE_WORKER_PGID 4242\nDEPLOY_GATE_WORKER_EXIT {exit_code}\n'
                f'DEPLOY_GATE_RESULT_SHA256 {sha}\n{block}'
                'DEPLOY_GATE_STDERR_BEGIN\nworker diagnostic\nDEPLOY_GATE_STDERR_END\n')

    def attach(self, body, name='result--0123456789abcdef.json'):
        (self.attachments / name).write_text(body)  # what the platform drops for `threads message --attach`

    def wrap(self, data, host=None, status='completed', messages=None):
        # exact dvb-onbox --json envelope recorded from a real worker (fixtures/boxes-thread-result-envelope.json)
        data = {**self.envelope['data'], 'executionInstanceId': host or self.host, 'status': status, **data}
        if messages is not None:
            data['transcript'] = {**self.envelope['data']['transcript'], 'messages': messages}
        return {'schemaVersion': 1, 'ok': True, 'data': data}

    def configure(self, reply, send=None, wait=None, read=None, result=None, host=None, listed=None):
        cycle.write(self.config, {
            'list': listed or {'rc': 0, 'stdout': {'schemaVersion': 1, 'ok': True, 'data': {'threads': [
                {'clientThreadId': 'ph-newer-rca', 'executionInstanceId': 'other-devbox', 'activeTurnId': None,
                 'status': 'idle', 'notificationsMuted': True, 'agent': 'codex'},
                {'clientThreadId': 'ph-worker', 'executionInstanceId': host or self.host, 'activeTurnId': None,
                 'status': 'idle', 'notificationsMuted': True, 'agent': 'claude'}],
                'pagination': {'complete': True, 'nextCursor': None}}}},
            # first page as the native CLI returns it without --all: newer threads only, worker not listed
            'list_page1': {'rc': 0, 'stdout': {'schemaVersion': 1, 'ok': True, 'data': {'threads': [
                {'clientThreadId': 'ph-newer-rca', 'executionInstanceId': 'other-devbox', 'activeTurnId': None,
                 'status': 'idle', 'notificationsMuted': True, 'agent': 'codex'}],
                'pagination': {'complete': False, 'nextCursor': 'page-2'}}}},
            'send': send or {'rc': 0, 'stdout': {**json.loads((ROOT / 'scripts/tests/fixtures/boxes-thread-send-receipt.json').read_text()), 'threadId': self.binding['worker_thread'], 'turnId': 'turn-1', 'messageId': 'peer_1'}},
            'wait': wait or {'rc': 0, 'stdout': self.wrap({'turnId': 'turn-1'}, host)},
            'result': result or {'rc': 0, 'stdout': self.wrap({'turnId': 'turn-1', 'output': {'text': reply}}, host)},
            'read': read or {'rc': 0, 'stdout': self.wrap({}, host, status='ready', messages=[])}})

    def calls_of(self, name):
        if not self.calls.exists(): return []
        return [json.loads(l) for l in self.calls.read_text().splitlines() if json.loads(l)[1] == name]

    def run_adapter(self, deadline=30):
        return self.boxes.execute(self.request, self.coordinator, self.binding, deadline)

    def test_worker_is_resolved_from_the_complete_thread_inventory_not_the_first_page(self):
        self.configure(reply=self.reply(inline=False)); self.attach(self.native_bytes)
        result = self.run_adapter()
        self.assertEqual({'first': 'UNVERIFIED', 'second': 'UNVERIFIED'}, result['cases'])
        listing = self.calls_of('list')
        self.assertEqual(1, len(listing)); self.assertIn('--all', listing[0])
        # the pre-fix argv sees only the first page: never resolve a host from a partial inventory, never send
        __import__('shutil').rmtree(self.coordinator / '.context'); self.calls.unlink()
        with patch.object(self.boxes, 'LIST_ARGV', ['threads', 'list', '--json']):
            result = self.run_adapter()
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()))
        self.assertEqual('thread_inventory_incomplete', result['reason']); self.assertEqual([], self.calls_of('send'))

    def test_model_forged_pass_cannot_replace_actual_native_failure(self):
        self.request['token']='actual-fail-forged-model-pass'
        self.request['worker_recipe']['cases']['first']['command']=[sys.executable,'-c','raise SystemExit(1)']
        native=worker.execute(self.request,self.root)
        self.assertEqual({'first':'FAIL','second':'PASS'},native['cases'])
        forged={**native,'cases':{'first':'PASS','second':'PASS'},'evidence':{}}
        self.configure(reply=self.reply(body=json.dumps(forged)+'\n',exit_code=0))
        result=self.run_adapter()
        self.assertEqual({'first':'UNVERIFIED','second':'UNVERIFIED'},result['cases'])
        self.assertEqual('native-evidence-unavailable',result['reason'])
        self.assertFalse(result['complete']);self.assertFalse(result['cleanup_complete'])
        self.assertEqual(self.request['token'],result['cleanup_owner']['request_token'])
        self.assertEqual('ph-worker',result['cleanup_owner']['worker_thread'])
        self.assertEqual(1,len(self.calls_of('send')))

    def test_hash_matching_candidate_is_unverified_and_preserves_diagnostic_bytes_and_owner(self):
        self.configure(reply=self.reply(inline=False)); self.attach(self.native_bytes)
        result = self.run_adapter()
        self.assertEqual({'first': 'UNVERIFIED', 'second': 'UNVERIFIED'}, result['cases'])
        receipt = result.pop('transport_receipt')
        self.assertEqual('native-evidence-unavailable',result['reason'])
        self.assertFalse(result['complete']);self.assertFalse(result['cleanup_complete'])
        self.assertEqual('ph-worker',result['cleanup_owner']['worker_thread'])
        self.assertEqual(('boxes-thread', 'ph-worker', self.host, 'turn-1', 'peer_1', 'tok-1', None, None),
                         (receipt['transport'], receipt['worker_thread'], receipt['worker_host'], receipt['turn_id'],
                          receipt['message_id'], receipt['request_token'], receipt['native_exit'], receipt.get('pgid')))
        self.assertEqual(self.binding['python'], receipt['remote_python'])
        self.assertIsNone(receipt['native_sha256'])
        self.assertIsNone(receipt['canonical_sha256'])
        self.assertEqual(1, len(self.calls_of('send')))
        send = self.calls_of('send')[0]
        self.assertEqual('tok-1', send[send.index('--idempotency-key') + 1])
        prompt = Path(send[send.index('--prompt-file') + 1]).read_text()
        self.assertIn(f"{self.binding['python']} {self.root.resolve()}/scripts/deploy_test_worker.py --root {self.root.resolve()}", prompt)
        self.assertIn('DEPLOY_GATE_REQUEST="$PWD/request.json" DEPLOY_GATE_RESULT="$PWD/result.json"', prompt)
        self.assertIn('dvb-onbox threads message --to ph-control --attach "$PWD/result.json" --attach "$PWD/stderr.log"', prompt)
        self.assertIn("--idempotency-key tok-1-result", prompt)
        self.assertIsNone(receipt['result_source']); self.assertEqual('ph-control', receipt['coordinator_thread'])
        self.assertEqual(self.native_bytes, (self.coordinator / '.context/deploy-boxes' / __import__('hashlib').sha256(b'tok-1').hexdigest() / 'native-result.json').read_text())
        self.assertLessEqual(len(prompt.encode()), self.boxes.MAX_PROMPT_BYTES)
        self.assertIn('worker diagnostic', Path(receipt['stderr_log']).read_text())
        # the coordinator's own validator accepts the relayed document with the adapter's exit
        from deploy_test_result import validate
        with self.assertRaises(ValueError):
            validate({**result, 'transport_receipt': receipt}, self.request, 0)

    def test_native_send_receipt_must_name_the_bound_worker(self):
        native = json.loads((ROOT / 'scripts/tests/fixtures/boxes-thread-send-receipt.json').read_text())
        native['threadId'] = 'a-different-worker'
        self.configure(reply=self.reply(), send={'rc': 0, 'stdout': native})
        result = self.run_adapter()
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()))
        self.assertIn('bound worker thread', result['reason'])
        self.assertEqual([], self.calls_of('wait'))
        self.assertEqual('ph-worker', result['cleanup_owner']['worker_thread'])

    def test_native_started_and_queued_send_wait_but_rejected_send_cannot_pass(self):
        native = json.loads((ROOT / 'scripts/tests/fixtures/boxes-thread-send-receipt.json').read_text())
        native.update(threadId='ph-worker', turnId='turn-1', messageId='peer_1')
        for disposition in ('started', 'queued', 'rejected'):
            with self.subTest(disposition=disposition):
                self.configure(reply=self.reply(), send={'rc': 0, 'stdout': {**native, 'disposition': disposition}})
                result = self.run_adapter()
                if disposition == 'rejected':
                    self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()))
                    self.assertEqual([], self.calls_of('wait'))
                else:
                    self.assertEqual({'first': 'UNVERIFIED', 'second': 'UNVERIFIED'}, result['cases'])
                    self.assertEqual(1, len(self.calls_of('wait')))
                __import__('shutil').rmtree(self.coordinator / '.context')
                self.calls.unlink()

    def test_prose_only_reply_is_unverified(self):
        self.configure(reply='Ran the gate, everything looks fine: first PASS, second PASS.')
        result = self.run_adapter()
        self.assertEqual({'first': 'UNVERIFIED', 'second': 'UNVERIFIED'}, result['cases'])
        self.assertFalse(result['complete']); self.assertFalse(result['cleanup_complete'])
        self.assertRegex(result['reason'], 'sha256|markers')

    def test_wrong_token_root_or_host_is_unverified(self):
        wrong_token = self.native_bytes.replace('"tok-1"', '"tok-2"')
        wrong_root = self.native_bytes.replace(str(self.root.resolve()), '/elsewhere')
        for label, reply in (('token', self.reply(body=wrong_token)), ('root', self.reply(body=wrong_root))):
            with self.subTest(label=label):
                self.configure(reply=reply)
                result = self.run_adapter()
                self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()), result['reason'])
                __import__('shutil').rmtree(self.coordinator / '.context')
        # host identity is platform-authored: the result envelope's executionInstanceId must match the slot
        self.configure(reply=self.reply(), result={'rc': 0, 'stdout': self.wrap({'turnId': 'turn-1', 'output': {'text': self.reply()}}, 'other-devbox')})
        result = self.run_adapter()
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values())); self.assertIn('different devbox', result['reason'])
        __import__('shutil').rmtree(self.coordinator / '.context'); self.calls.unlink()
        # and the listed thread must already run on that devbox before anything is sent
        self.configure(reply=self.reply(), listed={'rc': 0, 'stdout': {'schemaVersion': 1, 'ok': True, 'data': {'threads': [
            {'clientThreadId': 'ph-worker', 'executionInstanceId': 'other-devbox', 'activeTurnId': None, 'status': 'idle',
             'notificationsMuted': True, 'agent': 'claude'}]}}})
        result = self.run_adapter()
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values())); self.assertEqual([], self.calls_of('send'))

    def test_cli_failure_undelivered_or_oversize_prompt_is_unverified_with_stderr_kept(self):
        for label, send in (('exit', {'rc': 3, 'stdout': {}, 'stderr': 'daemon_unavailable'}),
                            ('status', {'rc': 0, 'stdout': self.wrap({'status': 'thread_not_ready'}), 'stderr': 'not ready'})):
            with self.subTest(label=label):
                self.configure(reply=self.reply(), send=send)
                result = self.run_adapter()
                self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()))
                self.assertIn(send['stderr'], Path(result['transport_receipt']['stderr_log']).read_text())
                __import__('shutil').rmtree(self.coordinator / '.context')
        self.request['worker_recipe']['cases']['first']['env'] = {'PAD': os.urandom(40000).hex()}  # incompressible
        self.calls.unlink()
        result = self.run_adapter()
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()))
        self.assertIn('prompt_too_large', result['reason']); self.assertEqual([], self.calls_of('send'))

    def test_resume_rereads_the_same_turn_without_a_second_send(self):
        first = self.run_adapter(); self.assertEqual('UNVERIFIED', first['cases']['first'])
        (self.coordinator / '.context/deploy-boxes').rename(self.coordinator / '.context/first')
        __import__('shutil').copytree(self.coordinator / '.context/first', self.coordinator / '.context/deploy-boxes')
        self.calls.unlink()
        again = self.run_adapter()
        self.assertEqual({'first': 'UNVERIFIED', 'second': 'UNVERIFIED'}, again['cases'])
        self.assertEqual([], self.calls_of('send'))
        self.assertEqual('turn-1', self.calls_of('wait')[0][self.calls_of('wait')[0].index('--turn') + 1])

    def test_crash_between_send_and_persist_adopts_the_existing_turn(self):
        directory = self.coordinator / '.context/deploy-boxes' / __import__('hashlib').sha256(b'tok-1').hexdigest()
        prompt = self.boxes.build_prompt(self.request, self.binding)
        cycle.write(directory / 'state.json', {'token': 'tok-1', 'idempotency_key': 'tok-1', 'thread': 'ph-worker',
            'host': self.host, 'worker_root': str(self.root.resolve()), 'deadline_at': time.time() + 30,
            'prompt_sha256': __import__('hashlib').sha256(prompt.encode()).hexdigest(), 'sent_attempted_at': time.time(),
            'turn_id': None, 'message_id': None, 'cli_log': str(directory / 'cli.log'), 'stderr_log': str(directory / 'stderr.log')})
        self.configure(reply=self.reply(), read={'rc': 0, 'stdout': self.wrap({}, status='ready', messages=[
            {'role': 'user', 'state': 'ready', 'text': 'unrelated', 'turnId': 'turn-0'},
            {'role': 'user', 'state': 'ready', 'text': prompt, 'turnId': 'turn-7'}])})
        result = self.run_adapter()
        self.assertEqual({'first': 'UNVERIFIED', 'second': 'UNVERIFIED'}, result['cases'])
        self.assertEqual([], self.calls_of('send')); self.assertEqual('turn-7', result['transport_receipt']['turn_id'])
        # an indeterminate send whose assignment cannot be found is never repeated: re-read until the deadline
        state = cycle.read(directory / 'state.json'); state.update(turn_id=None, deadline_at=time.time() + 2)
        cycle.write(directory / 'state.json', state)  # the ORIGINAL deadline governs, not a later argument
        self.configure(reply=self.reply()); self.calls.unlink()
        result = self.boxes.execute(self.request, self.coordinator, self.binding, 30)
        self.assertEqual('send_indeterminate_unadopted', result['reason']); self.assertEqual([], self.calls_of('send'))
        self.assertGreater(len(self.calls_of('read')), 1); self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()))
        # a changed prompt under the same token is never resent
        state = cycle.read(directory / 'state.json'); state['prompt_sha256'] = 'f' * 64; state['turn_id'] = None
        cycle.write(directory / 'state.json', state); self.calls.unlink()
        result = self.run_adapter()
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values())); self.assertEqual([], self.calls_of('send'))

    def nested_assignment(self):
        return {'schemaVersion': 1, 'ok': True, 'data': {
            'thread': {'executionInstanceId': self.host, 'clientThreadId': 'ph-worker'},
            'transcript': {'messages': [{'role': 'user', 'turnId': 'turn-1',
                'text': self.boxes.build_prompt(self.request, self.binding)}]}}}

    def test_initial_send_slice_timeout_adopts_nested_read_without_second_send(self):
        self.configure(reply=self.reply(), send={'sleep': 3}, read=[
            {'sleep': 3}, {'rc': 0, 'stdout': self.nested_assignment()}])
        started = time.time()
        with patch.object(self.boxes, 'CLI_MAX_SECONDS', 1.5):
            result = self.run_adapter(deadline=5)
        self.assertEqual({'first': 'UNVERIFIED', 'second': 'UNVERIFIED'}, result['cases'])
        self.assertFalse(result['complete']); self.assertFalse(result['cleanup_complete'])
        self.assertEqual('native-evidence-unavailable',result['reason'])
        self.assertEqual('turn-1',result['cleanup_owner']['turn_id'])
        self.assertEqual(1, len(self.calls_of('send')))
        self.assertEqual(2, len(self.calls_of('read')))
        send = self.calls_of('send')[0]
        self.assertEqual('tok-1', send[send.index('--idempotency-key') + 1])
        self.assertEqual('turn-1', result['transport_receipt']['turn_id'])
        directory = self.coordinator / '.context/deploy-boxes' / __import__('hashlib').sha256(b'tok-1').hexdigest()
        state = cycle.read(directory / 'state.json')
        self.assertGreaterEqual(state['deadline_at'], started + 5)
        self.assertLess(state['deadline_at'], started + 6)
        self.assertEqual('turn-1', state['turn_id'])

    def test_initial_send_adoption_read_error_fails_closed_without_resending(self):
        self.configure(reply=self.reply(), send={'sleep': 3}, read={'rc': 2, 'stderr': 'denied'})
        with patch.object(self.boxes, 'CLI_MAX_SECONDS', 1.5):
            result = self.run_adapter(deadline=5)
        self.assertEqual('threads read exited 2', result['reason'])
        self.assertFalse(result['complete']); self.assertFalse(result['cleanup_complete'])
        self.assertEqual('tok-1', result['cleanup_owner']['request_token'])
        self.assertEqual(1, len(self.calls_of('send'))); self.assertEqual(1, len(self.calls_of('read')))
        self.assertEqual([], self.calls_of('wait')); self.assertEqual([], self.calls_of('result'))

    def test_nested_read_host_accepts_only_consistent_bound_identities(self):
        data = self.nested_assignment()['data']
        self.assertIs(data, self.boxes._same_host(data, self.binding))
        self.assertIsNotNone(self.boxes._same_host({'executionInstanceId': self.host}, self.binding))
        self.assertIsNotNone(self.boxes._same_host({**data, 'executionInstanceId': self.host}, self.binding))
        for changed in ({**data, 'executionInstanceId': 'other'},
                        {**data, 'thread': {**data['thread'], 'executionInstanceId': 'other'}},
                        {**data, 'thread': {**data['thread'], 'clientThreadId': 'other'}},
                        {**data, 'thread': None}, {}):
            with self.subTest(data=changed), self.assertRaises(ValueError):
                self.boxes._same_host(changed, self.binding)

    def test_initial_send_adoption_respects_original_deadline_without_resending(self):
        self.configure(reply=self.reply(), send={'sleep': 6})
        started = time.monotonic()
        with patch.object(self.boxes, 'CLI_MAX_SECONDS', 1):
            result = self.run_adapter(deadline=2)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual('send_indeterminate_unadopted', result['reason'])
        self.assertFalse(result['complete']); self.assertFalse(result['cleanup_complete'])
        self.assertEqual('tok-1', result['cleanup_owner']['request_token'])
        self.assertEqual(1, len(self.calls_of('send')))
        self.assertTrue(self.calls_of('read')); self.assertEqual([], self.calls_of('wait'))

    def test_initial_send_adoption_cancel_retains_owner_without_resending(self):
        self.configure(reply=self.reply(), send={'sleep': 6})
        timer = threading.Timer(1.5, self.boxes.CANCEL.set); timer.start()
        started = time.monotonic()
        try:
            with patch.object(self.boxes, 'CLI_MAX_SECONDS', 1):
                result = self.run_adapter(deadline=5)
        finally:
            timer.cancel(); timer.join()
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual('send_indeterminate_unadopted', result['reason'])
        self.assertFalse(result['complete']); self.assertFalse(result['cleanup_complete'])
        self.assertEqual('tok-1', result['cleanup_owner']['request_token'])
        self.assertEqual(1, len(self.calls_of('send')))
        self.assertEqual([], self.calls_of('wait')); self.assertEqual([], self.calls_of('result'))

    def test_missing_deadline_refuses_before_any_send(self):
        with self.assertRaisesRegex(ValueError, 'existing gate deadline'):
            self.boxes.execute(self.request, self.coordinator, self.binding, None)
        request = self.coordinator / 'request.json'; cycle.write(request, self.request)
        proc = subprocess.run([sys.executable, str(ROOT / 'scripts/deploy_test_boxes.py'), '--root', str(self.coordinator),
                               '--thread', 'ph-worker', '--host', self.host, '--worker-root', str(self.root.resolve()),
                               '--python', self.binding['python'], '--coordinator-thread', 'ph-control'], capture_output=True, text=True,
                              env={**os.environ, 'DEPLOY_GATE_REQUEST': str(request), 'DEPLOY_GATE_RESULT': str(self.coordinator / 'r.json')})
        self.assertEqual(2, proc.returncode); self.assertIn('DEPLOY_BOXES BLOCKED', proc.stderr)
        self.assertFalse(self.calls.exists()); self.assertFalse((self.coordinator / 'r.json').exists())

    def test_native_wait_slice_timeout_reobserves_same_turn_without_resending(self):
        self.configure(reply=self.reply(), wait=[
            {'sleep': 3, 'rc': 0, 'stdout': self.wrap({'turnId': 'turn-1'}, status='running')},
            {'rc': 0, 'stdout': self.wrap({'turnId': 'turn-1'})}])
        with patch.object(self.boxes, 'CLI_MAX_SECONDS', 1.5):
            result = self.run_adapter(deadline=5)
        self.assertEqual({'first': 'UNVERIFIED', 'second': 'UNVERIFIED'}, result['cases'])
        self.assertEqual(1, len(self.calls_of('send')))
        waits = self.calls_of('wait')
        self.assertEqual(2, len(waits))
        self.assertEqual(['turn-1', 'turn-1'], [row[row.index('--turn') + 1] for row in waits])
        self.assertEqual('turn-1', result['transport_receipt']['turn_id'])

    def test_cancellation_during_native_wait_keeps_owner_and_never_resends(self):
        self.configure(reply=self.reply(), wait={'sleep': 8, 'rc': 0,
            'stdout': self.wrap({'turnId': 'turn-1'}, status='running')})
        timer = threading.Timer(2, self.boxes.CANCEL.set)
        started = time.monotonic(); timer.start()
        try:
            result = self.run_adapter(deadline=10)
        finally:
            timer.cancel(); timer.join()
        self.assertLess(time.monotonic() - started, 4)
        self.assertFalse(result['complete']); self.assertFalse(result['cleanup_complete'])
        self.assertIn('cancelled', result['reason'])
        self.assertEqual('turn-1', result['cleanup_owner']['turn_id'])
        self.assertEqual(1, len(self.calls_of('send')))
        self.assertEqual([], self.calls_of('result'))

    def test_retryable_control_unavailable_reobserves_same_turn_without_resending(self):
        transient = {'schemaVersion': 1, 'ok': False,
                     'errorCode': 'delegated_thread_control_unavailable', 'retryable': True}
        self.configure(reply=self.reply(), wait=[{'rc': 2, 'stdout': transient},
            {'rc': 0, 'stdout': self.wrap({'turnId': 'turn-1'})}])
        result = self.run_adapter(deadline=5)
        self.assertEqual({'first': 'UNVERIFIED', 'second': 'UNVERIFIED'}, result['cases'])
        self.assertEqual(1, len(self.calls_of('send')))
        waits = self.calls_of('wait'); self.assertEqual(2, len(waits))
        self.assertEqual(['turn-1', 'turn-1'], [r[r.index('--turn') + 1] for r in waits])
        self.assertEqual('turn-1', result['transport_receipt']['turn_id'])

    def test_control_unavailable_retry_requires_exact_typed_retryable_error(self):
        for changes in ({'retryable': False}, {'retryable': 'true'},
                        {'errorCode': 'permission_denied'}, {'ok': True}):
            with self.subTest(changes=changes):
                self.request['token'] = 'tok-' + str(len(self.calls_of('send')) + 1)
                transient = {'schemaVersion': 1, 'ok': False,
                             'errorCode': 'delegated_thread_control_unavailable', 'retryable': True, **changes}
                self.configure(reply=self.reply(), wait={'rc': 2, 'stdout': transient})
                before = len(self.calls_of('wait'))
                result = self.run_adapter(deadline=5)
                self.assertEqual('threads wait exited 2', result['reason'])
                self.assertFalse(result['complete']); self.assertFalse(result['cleanup_complete'])
                self.assertEqual(1, len(self.calls_of('wait')) - before)
                self.assertEqual('turn-1', result['cleanup_owner']['turn_id'])

    def test_retryable_control_unavailable_stays_inside_original_deadline(self):
        transient = {'schemaVersion': 1, 'ok': False,
                     'errorCode': 'delegated_thread_control_unavailable', 'retryable': True}
        self.configure(reply=self.reply(), wait={'rc': 2, 'stdout': transient})
        started = time.monotonic(); result = self.run_adapter(deadline=2)
        self.assertLess(time.monotonic() - started, 3)
        self.assertIn('original deadline', result['reason'])
        self.assertFalse(result['complete']); self.assertFalse(result['cleanup_complete'])
        self.assertEqual('turn-1', result['cleanup_owner']['turn_id'])
        self.assertEqual(1, len(self.calls_of('send')))
        self.assertEqual([], self.calls_of('result'))

    def test_native_wait_cli_error_is_unverified_without_retry_or_resend(self):
        self.configure(reply=self.reply(), wait={'rc': 2, 'stderr': 'native wait failed'})
        result = self.run_adapter(deadline=5)
        self.assertFalse(result['complete']); self.assertFalse(result['cleanup_complete'])
        self.assertEqual('threads wait exited 2', result['reason'])
        self.assertEqual('turn-1', result['cleanup_owner']['turn_id'])
        self.assertEqual(1, len(self.calls_of('wait')))
        self.assertEqual(1, len(self.calls_of('send')))

    def test_short_nonwait_timeout_keeps_the_positive_original_deadline(self):
        self.configure(reply=self.reply(), result={'sleep': 6, 'rc': 0,
            'stdout': self.wrap({'turnId': 'turn-1', 'output': {'text': self.reply()}})})
        with patch.object(self.boxes, 'CLI_MAX_SECONDS', 1.5):
            result = self.run_adapter(deadline=5)
        self.assertEqual('native CLI call timed out before the original deadline', result['reason'])
        self.assertFalse(result['complete']); self.assertFalse(result['cleanup_complete'])
        self.assertEqual('turn-1', result['cleanup_owner']['turn_id'])
        self.assertEqual(1, len(self.calls_of('send')))
        self.assertEqual(1, len(self.calls_of('result')))

    def test_native_cli_wait_returns_cleanup_owner_inside_original_deadline(self):
        self.configure(reply=self.reply(), wait={'sleep': 6, 'ignore_term': True, 'rc': 0,
            'stdout': self.wrap({'turnId': 'turn-1'}, status='running')})
        started = time.monotonic()
        result = self.run_adapter(deadline=2)
        elapsed = time.monotonic() - started
        print(json.dumps({'ignores_term_deadline': 2, 'elapsed': elapsed}))
        self.assertLess(elapsed, 2)
        self.assertEqual('original deadline passed during native CLI call', result['reason'])
        self.assertFalse(result['cleanup_complete'])
        self.assertFalse(result['complete'])
        self.assertEqual(result['cleanup_owner']['request_token'], 'tok-1')
        state = cycle.read(self.coordinator / '.context/deploy-boxes' /
                           __import__('hashlib').sha256(b'tok-1').hexdigest() / 'state.json')
        self.assertIsNotNone(state['sent_attempted_at'])
        calls = self.calls_of('wait')
        self.assertTrue(calls)
        self.assertTrue(calls[0][calls[0].index('--timeout') + 1].endswith('ms'))

    def test_timeout_or_cancel_is_unverified_and_names_the_remote_cleanup_owner(self):
        self.configure(reply=self.reply(), wait={'rc': 0, 'stdout': self.wrap({'turnId': 'turn-1'}, status='running')})
        result = self.run_adapter(deadline=2)
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()))
        self.assertFalse(result['cleanup_complete']); self.assertIn('deadline', result['reason'])
        owner = result['cleanup_owner']
        self.assertEqual(('ph-worker', self.host, str(self.root.resolve()), 'tok-1', 'turn-1', 'peer_1'),
                         (owner['worker_thread'], owner['worker_host'], owner['worker_root'], owner['request_token'],
                          owner['turn_id'], owner['message_id']))
        self.assertEqual(f"{self.root.resolve()}/.context/deploy-boxes/tok-1", owner['remote_dir'])
        self.assertIsNone(owner['pgid'])

    def test_truncated_or_oversize_result_is_unverified_never_trimmed(self):
        truncated = self.reply().replace('DEPLOY_GATE_RESULT_JSON_END\n', '')
        for label, result_cfg in (('truncated-markers', {'rc': 0, 'stdout': self.wrap({'output': {'text': truncated}})}),
                                  ('payload-truncated', {'rc': 0, 'stdout': self.wrap({'output': {'text': self.reply(), 'truncated': True}})}),
                                  ('hash-mismatch', {'rc': 0, 'stdout': self.wrap({'output': {'text': self.reply(sha='a' * 64)}})})):
            with self.subTest(label=label):
                self.configure(reply=self.reply(), result=result_cfg)
                result = self.run_adapter(deadline=5)
                self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()))
                __import__('shutil').rmtree(self.coordinator / '.context')
        self.configure(reply=self.reply())
        with patch.object(self.boxes, 'MAX_RECEIPT_BYTES', 10):
            result = self.run_adapter(deadline=5)
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values())); self.assertIn('transport limit', result['reason'])

    def gate(self, name, thread, host, root, port, python=None):
        python = python or f'{root}/agents/venv/bin/python'
        return {'name': name, 'worker': name + '-worker', 'checks': [name], 'case_protocol': True, 'result_transport': 'file',
                'worker_recipe': {'cases': {name: {'command': ['true']}}}, 'timeout_seconds': 60, 'worker_transport': 'boxes-thread',
                'worker_thread': thread, 'worker_host': host, 'worker_root': root, 'remote_python': python, 'cwd': str(ROOT),
                'coordinator_thread': 'ph-control',
                'env': {'CONDUCTOR_WORKSPACE_NAME': name, 'CONDUCTOR_PORT': str(port)},
                'command': [sys.executable, str(ROOT / 'scripts/deploy_test_boxes.py'), '--thread', thread, '--host', host,
                            '--worker-root', root, '--python', python, '--coordinator-thread', 'ph-control', '--deadline-seconds', '60']}

    def plan(self, *gates):
        return {'source': self.request['source'], 'gates': [
            *[{'name': n, 'quick': True, 'category': n, 'checks': [n], 'command': ['true']}
              for n in ('format', 'eslint', 'typescript', 'backend-structural')], *gates]}

    def test_isolation_binds_thread_host_root_and_python(self):
        good = self.gate('api', 'ph-a', 'devbox-a', '/prepared/api', 12000)
        cycle.validate_plan(self.plan(good))
        from deploy_test_result import preserve_contract
        for field, value in (('worker_thread', 'ph-b'), ('worker_host', 'devbox-b'), ('worker_root', '/prepared/other'),
                             ('remote_python', '/prepared/api/other/python'), ('coordinator_thread', 'ph-other'), ('timeout_seconds', 30)):
            with self.subTest(field=field):
                swapped = {**good, field: value}
                with self.assertRaisesRegex(ValueError, 'argv must bind|deadline|inside the worker root'):
                    cycle.validate_plan(self.plan(swapped))  # gate identity and argv must agree
                if field != 'timeout_seconds':
                    with self.assertRaises(ValueError): preserve_contract(good, swapped)
        with self.assertRaisesRegex(ValueError, 'inside the worker root'):
            cycle.validate_plan(self.plan(self.gate('api', 'ph-a', 'devbox-a', '/prepared/api', 12000, python='/usr/bin/python3')))
        for field in ('worker_thread', 'worker_host', 'timeout_seconds'):
            with self.subTest(missing=field):
                with self.assertRaises(ValueError): cycle.validate_plan(self.plan({k: v for k, v in good.items() if k != field}))

    def test_same_host_threads_cannot_share_root_or_ports_but_different_hosts_may(self):
        a = self.gate('api', 'ph-a', 'devbox-a', '/prepared/api', 12000)
        for label, b in (('root', self.gate('ui', 'ph-b', 'devbox-a', '/prepared/api', 24000)),
                         ('nested-root', self.gate('ui', 'ph-b', 'devbox-a', '/prepared/api/nested', 24000)),
                         ('port', self.gate('ui', 'ph-b', 'devbox-a', '/prepared/ui', 12000)),
                         ('workspace', {**self.gate('ui', 'ph-b', 'devbox-a', '/prepared/ui', 24000),
                                        'env': {'CONDUCTOR_WORKSPACE_NAME': 'api', 'CONDUCTOR_PORT': '24000'}}),
                         ('thread', self.gate('ui', 'ph-a', 'devbox-a', '/prepared/ui', 24000))):
            with self.subTest(label=label):
                with self.assertRaisesRegex(ValueError, 'must not share'): cycle.validate_plan(self.plan(a, b))
        cycle.validate_plan(self.plan(a, self.gate('ui', 'ph-b', 'devbox-b', '/prepared/api', 12000)))

    def test_inventory_without_thread_host_or_deadline_blocks_the_plan(self):
        from deploy_test_bindings import generate
        template = {'gates': [{'name': 'be', 'category': 'backend-coverage-blackbox', 'command': ['true'], 'checks': ['be']}]}
        slot = {'id': 'be-worker', 'transport': 'boxes-thread', 'worker_thread': 'ph-a', 'worker_host': 'devbox-a', 'coordinator_thread': 'ph-control',
                'worker_root': '/prepared/be', 'timeout_seconds': 60, 'env': {'CONDUCTOR_WORKSPACE_NAME': 'be', 'CONDUCTOR_PORT': '12000'}}
        binding = generate(template, {'be': slot}, ROOT)['be']
        self.assertEqual(['--thread', 'ph-a', '--host', 'devbox-a', '--worker-root', '/prepared/be', '--python',
                          '/prepared/be/agents/venv/bin/python', '--coordinator-thread', 'ph-control', '--deadline-seconds', '60'], binding['command'][2:])
        self.assertEqual(sys.executable, binding['command'][0]); self.assertEqual('file', binding['result_transport'])
        for field in ('worker_thread', 'worker_host', 'coordinator_thread', 'timeout_seconds'):
            with self.subTest(missing=field):
                with self.assertRaises(ValueError): generate(template, {'be': {k: v for k, v in slot.items() if k != field}}, ROOT)
        inventory = self.coordinator / 'inventory.json'; cycle.write(inventory, {'be': {k: v for k, v in slot.items() if k != 'worker_thread'}})
        tpl = self.coordinator / 'template.json'; cycle.write(tpl, template)
        proc = subprocess.run([sys.executable, str(ROOT / 'scripts/deploy_test_plan.py'), '--template', str(tpl), '--inventory',
                               str(inventory), '--output', str(self.coordinator / 'plan.json'), '--base', 'HEAD'],
                              capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(2, proc.returncode); self.assertIn('DEPLOY_PLAN BLOCKED', proc.stderr)

    def real_backend_request(self):
        slot = json.loads((ROOT / 'scripts/tests/fixtures/backend-slot-aggregate.json').read_text())
        names = json.loads((ROOT / 'scripts/tests/fixtures/backend-native-domains.json').read_text())
        effective = [d for d in names['all_native_files'] if d not in names['excluded']]
        self.assertEqual((240, 239), (len(names['all_native_files']), len(effective)))
        sweep = {k: v for k, v in slot['recipe']['cases']['backend-coverage-blackbox'].items() if k != 'aggregate'}
        sweep.update(aggregate=False, sweep='backend-coverage-blackbox')
        checks = [f'blackbox:{d}' for d in effective] + ['units', 'fps', 'coverage-threshold', 'teardown']
        recipe = {'cases': {c: dict(sweep) for c in checks}, 'setup': slot['recipe']['setup'], 'cleanup': slot['recipe']['cleanup']}
        request = {'token': 'be-real', 'source': {'head': 'a' * 40, 'digest': 'b' * 64}, 'gate': 'backend-coverage-blackbox',
                   'checks': checks, 'skips': {}, 'phase': 'initial', 'worker_recipe': recipe, 'worker_root': slot['worker_root']}
        binding = {k: slot[k] for k in ('worker_thread', 'worker_host', 'worker_root', 'python')}
        binding['coordinator_thread'] = 'ph-control'
        return request, binding

    def test_real_243_case_backend_request_fits_the_send_bound_through_the_compressed_envelope(self):
        request, binding = self.real_backend_request()
        raw = self.boxes.canonical_request(request)
        prompt = self.boxes.build_prompt(request, binding)
        size = len(prompt.encode())
        print(f'\nREAL_BACKEND_PROMPT canonical_request_bytes={len(raw)} prompt_bytes={size} bound={self.boxes.MAX_PROMPT_BYTES}')
        self.assertGreater(len(raw), 100_000); self.assertLessEqual(size, self.boxes.MAX_PROMPT_BYTES)
        self.assertIn('DEPLOY_GATE_REQUEST_ZB64_BEGIN', prompt); self.assertNotIn('printf %s', prompt)
        self.assertIn(f"{binding['python']} {binding['worker_root']}/scripts/deploy_test_worker.py --root {binding['worker_root']}", prompt)
        # the decoder step reproduces the identical canonical bytes, and refuses a corrupted payload
        script = prompt.split('```sh\n', 1)[1].split('\n```', 1)[0]
        lines = script.split('\n'); start = next(i for i, l in enumerate(lines) if l.startswith('# DEPLOY_GATE_REQUEST_ZB64_BEGIN'))
        end = lines.index('DEPLOY_GATE_REQUEST_ZB64_END')
        decoder = '\n'.join(lines[start:end + 1]).replace(binding['python'], sys.executable)
        with tempfile.TemporaryDirectory() as work:
            proc = subprocess.run(['bash', '-c', decoder], cwd=work, capture_output=True, text=True)
            self.assertEqual(0, proc.returncode, proc.stderr); self.assertEqual(raw, Path(work, 'request.json').read_bytes())
            corrupted = decoder.replace(lines[start + 3][:10], lines[start + 3][:10][::-1], 1)
            proc = subprocess.run(['bash', '-c', corrupted], cwd=work, capture_output=True, text=True)
            self.assertEqual(4, proc.returncode); self.assertIn('DEPLOY_GATE_WORKER_EXIT 4', proc.stdout)
        # a collector result with all 243 rows satisfies the coordinator's validator
        from deploy_test_result import validate
        result = {'token': 'be-real', 'source': request['source'], 'gate': request['gate'], 'cases': dict.fromkeys(request['checks'], 'PASS'),
                  'complete': True, 'cleanup_complete': True, 'reused': False, 'worker_root': binding['worker_root'],
                  'recipe_digest': __import__('hashlib').sha256(json.dumps(request['worker_recipe'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()}
        self.assertEqual(243, len(validate(result, request, 0)[0]))

    def test_incompressible_oversize_request_is_refused_as_prompt_too_large(self):
        self.request['worker_recipe']['cases']['first']['env'] = {'NOISE': os.urandom(40000).hex()}
        self.configure(reply=self.reply())
        result = self.run_adapter()
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()))
        self.assertTrue(result['reason'].startswith('prompt_too_large:')); self.assertIn('compressed', result['reason'])
        self.assertEqual([], self.calls_of('send'))

    def test_send_bound_is_exactly_32_kib_and_never_truncates(self):
        self.enterContext(patch.object(self.boxes, 'INLINE_REQUEST_BYTES', 10 ** 9))  # pin the bound on the inline envelope
        self.request.update(token='tok-2', worker_recipe={**self.recipe, 'cases': {**self.recipe['cases'],
                            'first': {**self.recipe['cases']['first'], 'env': {'PAD': ''}}}})
        self.assertEqual(32768, self.boxes.MAX_PROMPT_BYTES)
        for size, expected in ((32768, 'UNVERIFIED'), (32769, 'UNVERIFIED')):
            with self.subTest(size=size):
                self.request['token'] = f'tok-{size}'
                self.request['worker_recipe']['cases']['first']['env']['PAD'] = ''
                base = len(self.boxes.build_prompt(self.request, self.binding).encode())
                self.request['worker_recipe']['cases']['first']['env']['PAD'] = 'x' * (size - base)
                __import__('shutil').rmtree(self.root / '.context', ignore_errors=True)
                self.native_bytes = json.dumps(worker.execute(self.request, self.root), indent=2, allow_nan=False) + '\n'
                self.configure(reply=self.reply())
                self.assertEqual(size, len(self.boxes.build_prompt(self.request, self.binding).encode()))
                result = self.run_adapter()
                self.assertEqual(expected, result['cases']['first'], result.get('reason'))
                self.assertEqual('native-evidence-unavailable' if size==32768 else True,
                    result.get('reason') if size==32768 else result['reason'].startswith('prompt_too_large'))
        self.assertIn('prompt_too_large', result['reason']); self.assertEqual(1, len(self.calls_of('send')))

    def test_failed_cd_in_the_worker_script_exits_nonzero_and_is_unverified(self):
        binding = {**self.binding, 'worker_root': str(self.root.resolve() / 'missing')}
        prompt = self.boxes.build_prompt(self.request, binding)
        script = prompt.split('```sh\n', 1)[1].split('\n```', 1)[0]
        self.assertTrue(script.startswith('set -eu'))
        proc = subprocess.run(['bash', '-c', script], capture_output=True, text=True)
        self.assertEqual(3, proc.returncode); self.assertIn('DEPLOY_GATE_WORKER_EXIT 3', proc.stdout)
        self.assertEqual([], self.calls_of('message'))  # nothing was attached or sent after the failed cd
        self.configure(reply=proc.stdout)
        result = self.run_adapter(deadline=5)
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()))

    def big_native(self, token):
        self.request['token'] = token
        self.request['worker_recipe']['cases']['first']['command'] = [sys.executable, '-c', "print('y' * 70000)"]
        __import__('shutil').rmtree(self.root / '.context', ignore_errors=True)
        self.native_bytes = json.dumps(worker.execute(self.request, self.root), indent=2, allow_nan=False) + '\n'
        self.assertGreater(len(self.native_bytes.encode()), 64 * 1024)

    def test_large_attachment_or_hash_matching_inline_cannot_grant_execution_credit(self):
        self.big_native('tok-big')
        self.configure(reply=self.reply(inline=False)); self.attach(self.native_bytes)
        result = self.run_adapter()
        self.assertEqual({'first': 'UNVERIFIED', 'second': 'UNVERIFIED'}, result['cases'])
        self.assertIsNone(result['transport_receipt']['result_source']);self.assertEqual('native-evidence-unavailable',result['reason'])
        __import__('shutil').rmtree(self.coordinator / '.context'); (self.attachments / 'result--0123456789abcdef.json').unlink()
        self.configure(reply=self.reply(inline=True))  # inline-only large reply that hash-matches
        result = self.run_adapter()
        self.assertEqual({'first': 'UNVERIFIED', 'second': 'UNVERIFIED'}, result['cases'])
        self.assertIsNone(result['transport_receipt']['result_source']);self.assertEqual('native-evidence-unavailable',result['reason'])

    def test_wrong_hash_attachment_or_truncated_inline_without_attachment_is_unverified(self):
        self.configure(reply=self.reply(inline=False)); self.attach(self.native_bytes.replace('"PASS"', '"FAIL"', 1))
        result = self.run_adapter(deadline=5)
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values())); self.assertEqual('attachment_missing', result['reason'])
        __import__('shutil').rmtree(self.coordinator / '.context')
        truncated = self.reply().replace('DEPLOY_GATE_RESULT_JSON_END\n', '')
        self.configure(reply=truncated)
        result = self.run_adapter(deadline=5)
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values())); self.assertEqual('attachment_missing', result['reason'])

    def test_attachment_poll_obeys_deadline_and_keeps_boundary_delivery_first(self):
        data = self.wrap({'output': {'text': self.reply(inline=False)}})['data']
        deadline = 1000.25
        for delivered in (False, True):
            with self.subTest(delivered=delivered):
                clock = [1000.0]
                sleeps = []
                directory = self.coordinator / ('delivered' if delivered else 'missing')
                directory.mkdir()
                def sleep(seconds):
                    sleeps.append(seconds)
                    clock[0] += seconds
                    if delivered:
                        self.attach(self.native_bytes)
                # Control only the clock: parse the real terminal envelope, search
                # real attachment files, and preserve the byte-exact native copy.
                with patch.object(self.boxes, 'time') as timer:
                    timer.time.side_effect = lambda: clock[0]
                    timer.sleep.side_effect = sleep
                    if delivered:
                        result = self.boxes.collect_result(data, self.binding, not_before=0,
                            deadline_at=deadline, poll=60, directory=directory)
                        self.assertEqual(self.native, result[0])
                        self.assertTrue(result[-1].startswith('attachment:'))
                        self.assertEqual(self.native_bytes.encode(), (directory / 'native-result.json').read_bytes())
                    else:
                        with self.assertRaisesRegex(ValueError, '^attachment_missing$'):
                            self.boxes.collect_result(data, self.binding, not_before=0,
                                deadline_at=deadline, poll=60, directory=directory)
                        self.assertFalse((directory / 'native-result.json').exists())
                self.assertEqual([.25], sleeps)
                self.assertEqual(deadline, clock[0])

    def test_every_nonzero_send_retains_exact_owner_without_resending(self):
        for index, code in enumerate(('temporary_transport_error','thread_control_scope_denied')):
            with self.subTest(code=code):
                self.request['token']='failed-send-'+str(index)
                error={'schemaVersion':1,'ok':False,'error':{'code':code,'message':'exact diagnostic'}}
                self.configure(reply=self.reply(),send={'rc':2,'stdout':error,'stderr':'native send stderr'})
                result=self.run_adapter()
                self.assertFalse(result['complete']);self.assertFalse(result['cleanup_complete'])
                owner=result['cleanup_owner']
                self.assertEqual(self.request['token'],owner['request_token'])
                self.assertEqual(self.binding['worker_thread'],owner['worker_thread'])
                self.assertEqual(self.binding['worker_host'],owner['worker_host'])
                self.assertEqual(self.binding['worker_root'],owner['worker_root'])
                self.assertIsNone(owner['turn_id']);self.assertIsNone(owner['message_id'])
                self.assertEqual(owner,cycle.receipt_owner('gate',{'cleanup_owner':owner}))
                self.assertEqual(code,result['transport_receipt']['cli_error']['code'])
        self.assertEqual(2,len(self.calls_of('send')));self.assertEqual([],self.calls_of('wait'))

    def test_typed_permission_denial_is_unverified_with_exact_error_kept(self):
        denial = {'schemaVersion': 1, 'ok': False, 'error': {'code': 'thread_control_scope_denied',
                  'message': 'request control-project-threads'}}
        self.configure(reply=self.reply(), send={'rc': 1, 'stdout': denial, 'stderr': ''})
        result = self.run_adapter()
        self.assertEqual({'first': 'UNVERIFIED', 'second': 'UNVERIFIED'}, result['cases'])
        self.assertEqual('transport_permission_denied', result['reason'])
        self.assertEqual('thread_control_scope_denied', result['transport_receipt']['cli_error']['code'])
        self.assertIn('request control-project-threads', result['transport_receipt']['cli_error']['text'])
        self.assertIn('request control-project-threads', Path(result['transport_receipt']['cli_log']).read_text())
        self.assertEqual(1, len(self.calls_of('send')))  # no retry loop

    @contextlib.contextmanager
    def scripted_transport(self, cancel_after=None):
        # Orchestration-only seam: preserve real envelopes, logs, absolute deadlines,
        # and collector/parser behavior without paying OS startup for each fake CLI.
        # Real run_cli deadline, signal and reap tests below remain subprocess-backed.
        clock = [time.time()]
        started = clock[0]
        elapsed = [0.0]
        events = []

        def sleep(seconds):
            elapsed[0] += seconds
            clock[0] = started + elapsed[0]
            if cancel_after is not None and elapsed[0] >= cancel_after:
                events[-1]["cancel_elapsed"] = elapsed[0]
                self.boxes.CANCEL.set()

        def invoke(argv, *, timeout, completion_deadline=None):
            config = cycle.read(self.config)
            key = argv[1]
            with self.calls.open('a') as stream:
                stream.write(json.dumps(argv) + '\n')
            if key == 'list' and '--all' not in argv:
                key = 'list_page1'
            reply = config.get(key, {'rc': 1, 'stdout': {}, 'stderr': 'unsupported'})
            if isinstance(reply, list):
                count = len(self.calls_of(key))
                reply = reply[min(count - 1, len(reply) - 1)]
            budget = min(timeout, max(0, completion_deadline - clock[0])) if completion_deadline is not None else timeout
            events.append({'op': key, 'at': clock[0], 'budget': budget, 'deadline': completion_deadline})
            duration = reply.get('sleep', 0)
            if duration >= budget:
                sleep(budget)
                raise subprocess.TimeoutExpired(argv, timeout)
            sleep(duration)
            return reply.get('rc', 0), json.dumps(reply.get('stdout', {})).encode(), reply.get('stderr', '').encode()

        with patch.object(self.boxes, 'run_cli', side_effect=invoke), patch.object(self.boxes, 'time') as timer:
            timer.time.side_effect = lambda: clock[0]
            timer.monotonic.side_effect = lambda: clock[0]
            timer.sleep.side_effect = sleep
            yield events


    def test_crash_between_send_and_persist_adopts_the_existing_turn_strict_scripted(self):
        directory = self.coordinator / '.context/deploy-boxes' / __import__('hashlib').sha256(b'tok-1').hexdigest()
        prompt = self.boxes.build_prompt(self.request, self.binding)
        cycle.write(directory / 'state.json', {'token': 'tok-1', 'idempotency_key': 'tok-1', 'thread': 'ph-worker',
            'host': self.host, 'worker_root': str(self.root.resolve()), 'deadline_at': time.time() + 30,
            'prompt_sha256': __import__('hashlib').sha256(prompt.encode()).hexdigest(), 'sent_attempted_at': time.time(),
            'turn_id': None, 'message_id': None, 'cli_log': str(directory / 'cli.log'), 'stderr_log': str(directory / 'stderr.log')})
        self.configure(reply=self.reply(), read={'rc': 0, 'stdout': self.wrap({}, status='ready', messages=[
            {'role': 'user', 'state': 'ready', 'text': 'unrelated', 'turnId': 'turn-0'},
            {'role': 'user', 'state': 'ready', 'text': prompt, 'turnId': 'turn-7'}])})
        result = self.run_adapter()
        self.assertEqual({'first': 'UNVERIFIED', 'second': 'UNVERIFIED'}, result['cases'])
        self.assertEqual([], self.calls_of('send')); self.assertEqual('turn-7', result['transport_receipt']['turn_id'])
        # an indeterminate send whose assignment cannot be found is never repeated: re-read until the deadline
        state = cycle.read(directory / 'state.json'); state.update(turn_id=None, deadline_at=time.time() + 0.3)
        cycle.write(directory / 'state.json', state)  # the ORIGINAL deadline governs, not a later argument
        self.configure(reply=self.reply()); self.calls.unlink()
        with self.scripted_transport() as events:
            result = self.boxes.execute(self.request, self.coordinator, self.binding, 30)
        self.assertEqual('list', events[0]['op'])
        self.assertTrue(all(event['op'] == 'read' for event in events[1:]))
        self.assertEqual('send_indeterminate_unadopted', result['reason']); self.assertEqual([], self.calls_of('send'))
        self.assertGreater(len(self.calls_of('read')), 1); self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()))
        # a changed prompt under the same token is never resent
        state = cycle.read(directory / 'state.json'); state['prompt_sha256'] = 'f' * 64; state['turn_id'] = None
        cycle.write(directory / 'state.json', state); self.calls.unlink()
        result = self.run_adapter()
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values())); self.assertEqual([], self.calls_of('send'))


    def test_initial_send_slice_timeout_adopts_nested_read_without_second_send_strict_scripted(self):
        self.configure(reply=self.reply(), send={'sleep': .6}, read=[
            {'sleep': .6}, {'rc': 0, 'stdout': self.nested_assignment()}])
        started = time.time()
        with self.scripted_transport() as events, patch.object(self.boxes, 'CLI_MAX_SECONDS', .3):
            result = self.run_adapter(deadline=5)
        self.assertEqual({'first': 'UNVERIFIED', 'second': 'UNVERIFIED'}, result['cases'])
        self.assertFalse(result['complete']); self.assertFalse(result['cleanup_complete'])
        self.assertEqual('native-evidence-unavailable',result['reason'])
        self.assertEqual('turn-1',result['cleanup_owner']['turn_id'])
        self.assertEqual(1, len(self.calls_of('send')))
        self.assertEqual(2, len(self.calls_of('read')))
        send = self.calls_of('send')[0]
        self.assertEqual('tok-1', send[send.index('--idempotency-key') + 1])
        self.assertEqual('turn-1', result['transport_receipt']['turn_id'])
        directory = self.coordinator / '.context/deploy-boxes' / __import__('hashlib').sha256(b'tok-1').hexdigest()
        state = cycle.read(directory / 'state.json')
        self.assertGreaterEqual(state['deadline_at'], started + 5)
        self.assertLess(state['deadline_at'], started + 5.2)
        self.assertEqual('turn-1', state['turn_id'])

        self.assertEqual(['list', 'send', 'read', 'read', 'wait', 'result'], [event['op'] for event in events])
        self.assertTrue(all(event['at'] + event['budget'] <= event['deadline'] for event in events))


    def test_initial_send_adoption_cancel_retains_owner_without_resending_strict_scripted(self):
        self.configure(reply=self.reply(), send={'sleep': 3})
        started = time.monotonic()
        with self.scripted_transport(cancel_after=.35) as events, patch.object(self.boxes, 'CLI_MAX_SECONDS', .15):
            result = self.run_adapter(deadline=5)
        self.assertLess(time.monotonic() - started, .8)
        self.assertEqual('send_indeterminate_unadopted', result['reason'])
        self.assertFalse(result['complete']); self.assertFalse(result['cleanup_complete'])
        self.assertEqual('tok-1', result['cleanup_owner']['request_token'])
        self.assertEqual(1, len(self.calls_of('send')))
        self.assertEqual([], self.calls_of('wait')); self.assertEqual([], self.calls_of('result'))

        self.assertEqual(['list', 'send'], [event['op'] for event in events[:2]])
        self.assertTrue(all(event['op'] == 'read' for event in events[2:]))
        self.assertTrue(self.boxes.CANCEL.is_set())
        elapsed = next(event["cancel_elapsed"] for event in events if "cancel_elapsed" in event)
        self.assertGreaterEqual(elapsed, .35)
        self.assertLess(elapsed, .8)


    def test_cancel_before_send_never_invokes_the_cli_strict_scripted(self):
        drive = self.boxes._drive
        def cancel_before_first_call(*args, **kwargs):
            self.boxes.CANCEL.set()  # after cancellation handlers initialize, before any CLI
            return drive(*args, **kwargs)
        with patch.object(self.boxes, '_drive', side_effect=cancel_before_first_call), \
             patch.object(self.boxes, 'run_cli') as invoke:
            result = self.run_adapter()
        invoke.assert_not_called()
        self.assertEqual([], self.calls_of('send'))
        self.assertEqual('cancelled during native CLI call', result['reason'])
        self.assertTrue(all(value == 'UNVERIFIED' for value in result['cases'].values()))


    def test_wrong_hash_attachment_or_truncated_inline_without_attachment_is_unverified_strict_scripted(self):
        self.configure(reply=self.reply(inline=False)); self.attach(self.native_bytes.replace('"PASS"', '"FAIL"', 1))
        with self.scripted_transport() as events:
            result = self.run_adapter(deadline=0.3)
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values())); self.assertEqual('attachment_missing', result['reason'])
        __import__('shutil').rmtree(self.coordinator / '.context')
        truncated = self.reply().replace('DEPLOY_GATE_RESULT_JSON_END\n', '')
        self.configure(reply=truncated)
        with self.scripted_transport() as events:
            result = self.run_adapter(deadline=0.3)
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values())); self.assertEqual('attachment_missing', result['reason'])

        self.assertEqual(['list', 'send', 'wait', 'result'], [event['op'] for event in events])




def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


local_runner = load('controller_local', 'scripts/run-cloudbench-controller-local.py')


class LocalController(unittest.TestCase):
    def test_quiescent_readonly_fixture_cleanup_preserves_symlink_target(self):
        with tempfile.TemporaryDirectory(prefix='controller-readonly-', dir='/var/tmp') as raw:
            root = Path(raw)
            outside = root / 'outside'
            outside.mkdir()
            sentinel = outside / 'sentinel'
            sentinel.write_text('outside evidence')
            sentinel.chmod(0o444)
            outside.chmod(0o555)
            before = (outside.stat().st_mode, sentinel.stat().st_mode, sentinel.read_bytes())
            body = (
                "import os; from pathlib import Path; p=Path(os.environ['TMPDIR']); "
                "d=p/'audit'; d.mkdir(); e=d/'expected-fresh'; e.mkdir(); "
                "f=d/'evidence'; f.write_text('retained'); f.chmod(0o444); "
                "e.chmod(0o500); d.chmod(0o500); "
                "(p/'outside-link').symlink_to(" + repr(str(outside)) + ", target_is_directory=True)"
            )
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    row = local_runner.run_case(root, root, 'readonly', shlex.join([sys.executable, '-c', body]))
                self.assertEqual(row['status'], 'PASS', row)
                self.assertEqual(row['native_exit'], 0)
                self.assertTrue(row['supervision']['quiescent'])
                self.assertTrue(row['fixture_tmp_removed'])
                self.assertFalse(Path(row['fixture_tmp']).exists())
                self.assertEqual((outside.stat().st_mode, sentinel.stat().st_mode, sentinel.read_bytes()), before)
            finally:
                outside.chmod(0o755)
                if 'row' in locals():
                    temporary = Path(row['fixture_tmp'])
                    if temporary.exists():
                        for path in (temporary / 'audit', temporary / 'audit/expected-fresh'):
                            if path.is_dir():
                                path.chmod(0o755)
                        shutil.rmtree(temporary)

    def test_failed_readonly_fixture_is_retained(self):
        with tempfile.TemporaryDirectory(prefix='controller-failed-readonly-', dir='/var/tmp') as raw:
            root = Path(raw)
            body = "import os; from pathlib import Path; p=Path(os.environ['TMPDIR'])/'expected-fresh'; p.mkdir(); p.chmod(0o555); raise SystemExit(1)"
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    row = local_runner.run_case(root, root, 'failed-readonly', shlex.join([sys.executable, '-c', body]))
                self.assertEqual(row['status'], 'FAIL')
                self.assertNotIn('fixture_tmp_removed', row)
                self.assertEqual((Path(row['fixture_tmp']) / 'expected-fresh').stat().st_mode & 0o777, 0o555)
            finally:
                if 'row' in locals():
                    temporary = Path(row['fixture_tmp'])
                    (temporary / 'expected-fresh').chmod(0o755)
                    shutil.rmtree(temporary)

    def test_cleanup_refuses_replaced_or_linked_root(self):
        with tempfile.TemporaryDirectory(prefix='controller-root-guard-', dir='/var/tmp') as raw:
            root = Path(raw)
            original, replacement = root / 'original', root / 'replacement'
            original.mkdir()
            expected = original.stat()
            original.rename(root / 'retained')
            replacement.mkdir()
            (replacement / 'evidence').write_text('foreign root evidence')
            replacement.chmod(0o555)
            replacement.rename(original)
            try:
                with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                    local_runner.remove_suite_temporary(original, expected)
                self.assertEqual((original / 'evidence').read_text(), 'foreign root evidence')
                self.assertEqual(original.stat().st_mode & 0o777, 0o555)
                original.rename(replacement)
                original.symlink_to(replacement, target_is_directory=True)
                with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                    local_runner.remove_suite_temporary(original, expected)
                self.assertEqual(replacement.stat().st_mode & 0o777, 0o555)
            finally:
                for path in (original, replacement):
                    if path.is_dir() and not path.is_symlink():
                        path.chmod(0o755)

    def test_cleanup_refuses_foreign_entry_without_changing_it(self):
        with tempfile.TemporaryDirectory(prefix='controller-foreign-guard-', dir='/var/tmp') as raw:
            root = Path(raw)
            foreign = root / 'foreign'
            foreign.mkdir()
            (foreign / 'evidence').write_text('preserve')
            foreign.chmod(0o555)
            real_stat = os.stat
            def observe(path, *args, **kwargs):
                result = real_stat(path, *args, **kwargs)
                if path == 'foreign' and kwargs.get('follow_symlinks') is False:
                    return __import__('types').SimpleNamespace(st_dev=result.st_dev,
                        st_ino=result.st_ino, st_mode=result.st_mode, st_uid=os.geteuid() + 1)
                return result
            try:
                with patch.object(local_runner.os, 'stat', side_effect=observe):
                    with self.assertRaisesRegex(RuntimeError, 'foreign entry'):
                        local_runner.remove_suite_temporary(root, root.stat())
                self.assertEqual(foreign.stat().st_mode & 0o777, 0o555)
                self.assertEqual((foreign / 'evidence').read_text(), 'preserve')
            finally:
                foreign.chmod(0o755)

    def test_nested_helpers_use_the_prepared_project_python(self):
        with tempfile.TemporaryDirectory(prefix='controller-python-', dir='/var/tmp') as raw:
            root = Path(raw)
            python_bin = root / 'agents' / 'venv' / 'bin'
            python_bin.mkdir(parents=True)
            project_python = python_bin / 'python3'
            project_python.symlink_to(sys.executable)
            command = shlex.join(['python3', '-c',
                'import sys; assert sys.executable == ' + repr(str(project_python))])
            try:
                with patch.dict(os.environ, {'PATH': '/usr/bin:/bin'}), contextlib.redirect_stdout(io.StringIO()):
                    row = local_runner.run_case(root, root, 'nested-python', command)
                self.assertEqual(row['status'], 'PASS', Path(row['log']).read_text())
                self.assertTrue(row['supervision']['quiescent'])
            finally:
                if 'row' in locals() and Path(row['fixture_tmp']).exists():
                    shutil.rmtree(row['fixture_tmp'])

    def test_each_case_reports_one_live_progress_row_without_changing_the_result(self):
        """DEPLOY_GATE_PROGRESS gets one suite row per case the moment it finishes:
        the passing case only finishes after it sees the failing case's FAIL row.
        Exit code and output match a run without the variable, which writes nothing."""
        progress_env, watch_env = 'DEPLOY_GATE_PROGRESS', 'CONTROLLER_PROGRESS_FIXTURE_WATCH'
        waiter = (
            "import json, os, sys, time\n"
            f"if os.environ.get({progress_env!r}):\n"
            "    sys.exit(7)\n"
            f"watch = os.environ.get({watch_env!r})\n"
            "deadline = time.monotonic() + 60\n"
            "while watch and time.monotonic() < deadline:\n"
            "    try:\n"
            "        rows = [json.loads(line) for line in open(watch).read().splitlines()]\n"
            "    except (OSError, ValueError):\n"
            "        rows = []\n"
            "    if any(row['unit'] == 'fails' and row['status'] == 'FAIL' for row in rows):\n"
            "        break\n"
            "    time.sleep(0.05)\n"
            "else:\n"
            "    if watch:\n"
            "        sys.exit(9)\n"
            "print('waiter done')\n"
        )
        cases = [
            ('fails', shlex.join([sys.executable, '-c', "print('controller-fail-marker'); raise SystemExit(1)"])),
            ('waiter', shlex.join([sys.executable, '-c', waiter])),
        ]
        with tempfile.TemporaryDirectory(prefix='controller-progress-', dir='/var/tmp') as raw:
            root = Path(raw)
            progress = root / 'gate' / 'progress.jsonl'
            progress.parent.mkdir()

            def run(extra):
                env = {key: value for key, value in os.environ.items() if key not in (progress_env, watch_env)}
                env.update(extra)
                stdout = io.StringIO()
                umask = os.umask(0o022)
                os.umask(umask)
                argv = ['run-cloudbench-controller-local.py', '--root', str(root), '--max-workers', '2']
                try:
                    with patch.dict(os.environ, env, clear=True), patch.object(local_runner, 'CASES', cases), \
                            patch.object(local_runner, 'source', lambda _root: {'head': 'fixture'}), \
                            patch.object(sys, 'argv', argv), contextlib.redirect_stdout(stdout):
                        code = local_runner.main()
                finally:
                    os.umask(umask)
                lines = ['GATE_NATIVE_ARTIFACTS' if line.startswith('GATE_NATIVE_ARTIFACTS ') else line
                         for line in stdout.getvalue().splitlines()]
                return code, sorted(lines)

            try:
                reported = run({progress_env: str(progress), 'DEPLOY_GATE_CASE': 'cloudbench-controller',
                                watch_env: str(progress)})
                unset = run({})
                self.assertEqual(reported[0], 1, reported)
                self.assertEqual(reported, unset, 'reporting changed the exit code or output')
                self.assertEqual(list(root.rglob('*.jsonl')), [progress], 'an unset variable wrote a progress file')
                rows = [json.loads(line) for line in progress.read_text().splitlines()]
                self.assertEqual([(row['unit'], row['status']) for row in rows], [('fails', 'FAIL'), ('waiter', 'PASS')])
                self.assertEqual({(row['scope'], row['case']) for row in rows}, {('suite', 'cloudbench-controller')})
                self.assertIn('controller-fail-marker', rows[0]['detail'])
                self.assertEqual(rows[1]['detail'], '')
                for row in rows:
                    self.assertTrue(row['log'].endswith('/' + row['unit'] + '.log'), row)
                    self.assertTrue(Path(row['log']).is_file(), row)
            finally:
                for result in root.glob('.context/cloudbench-local/*/result.json'):
                    for case in json.loads(result.read_text())['cases']:
                        if case.get('fixture_tmp') and Path(case['fixture_tmp']).exists():
                            shutil.rmtree(case['fixture_tmp'])

    # The twelve cloud-benchmark controller suites the staged `cloudbench-controller` gate runs (the former
    # deploy.md Step 4cb inventory, preserved in .claude/commands/DEPRECATED_deploy.md at L1408). The concise
    # deploy.md no longer lists them: scripts/run-cloudbench-controller-local.py CASES is the executing
    # inventory, so it is pinned here and a change to it must be a deliberate edit of this test.
    CONTROLLER_PYTEST_KEYWORDS = (
        'fly_with_timeout', 'test_clone_retries_transient_volume_not_found', 'test_clone_gives_up_after_max_attempts',
        'test_clone_times_out_and_retries_a_hung_clone', 'clone_creation_cannot_start_copied_primary',
        'cloudbench_codex_auth', 'autoscaler_runtime_handoff', 'prisma_client',
        'local_sync_and_stack_wire_prisma_freshness', 'cloud_patch_includes_tracked_and_untracked_changes',
        'cloud_patch_detection_and_payload_include_staged_only_changes',
        'worktree_patch_ignores_append_only_history_ledgers', 'patch_delivery_clears_stale_base64_configuration',
        'shared_patch_digest_is_pinned_and_verified', 'declared_patch_payload_cannot_be_missing_or_empty',
        'empty_local_patch_cleanup_is_nounset_safe', 'central_hub_runs_in_own_session_after_launcher_exit',
        'boot_launch_delivers_the_exact_worktree_patch_to_every_guest',
        'boot_launch_runs_the_current_driver_before_applying_the_patch', 'boot_payload',
        'boot_launch_compresses_complete_payload', 'autoscaled_worker_failure_publishes_durable_failure_marker',
        'data_plane_proxies_retry_machine_dns_and_restart_if_lost', 'status_polled_over_data_plane_proxy_not_ssh',
        'cloud_runner_avoids_live_run_port_collisions', 'fleet_barrier_reads_the_authoritative_rotated_status_port',
        'data_plane_barrier_release_at_full_fleet_width', 'storage_readiness_inventory_reads_are_bounded',
        'fleet_cleanup_releases_emergency_disk_reserve_before_provider_teardown', 'isolated_backend',
        'local_predeploy_skips_wmh', 'cloud_agentcard_payment_tasks_provide_onboarding_callback_env',
        'fleet_shared_patch_remains_authoritative_until_transport_selection',
        'fleet_patch_packages_clean_unpushed_head_from_fetchable_base', 'autoscaler_scale_down_cancels_pending_worker',
        'fleet_registry_release_id_is_idempotent_with_other_records', 'refresh_deps_tracks_exact_created_snapshot',
        'refresh_deps_applies_exact_workspace_before_rebuild', 'fetch_ref_restores_dirty_exact_sha',
        'warm_deps_preflight', 'fresh_controller_reuses_only_proven_donor_dependencies', 'verified_legacy_snapshot',
        'dependency_proof_publication', 'exact_volume_ownership_survives_delayed_visibility_and_failed_delete',
        'exact_recovery_routes_quarantined_owner_to_guest_recovery_before_reapers',
        'pre_fix_guest_runner_receipt_cannot_authorize_exact_reaper',
        'exact_recovery_seals_actual_retained_owner_remote_evidence_paths', 'hub_transport',
        'guest_shutdown_child_confirmation', 'exact_guest_recovery_archives_bound_child_token',
        'exact_recovery_consumes_runtime_receipt_completed_absent_primary',
        'exact_recovery_consumes_runtime_receipt_publishes_audited_release',
        'fleet_lifecycle_receipt_requires_final_registry_retirement',
        'watchdog_collects_cancelled_artifact_after_bounded_shutdown', 'terminal_projection_preserves_benchmark_outcome',
        'boot_driver_state_write_failure', 'driver_cleanup_persists_evidence_in_fresh_data_directory',
        'driver_cleanup_requires_current_stack_receipt_on_normal_completion',
        'autoscaled_worker_uses_authenticated_fetch_ref_helper', 'terminal_projection_empty_tasks',
        'terminal_projection_rejection_removes_all_artifacts', 'status_recovery_read_closes_descriptor',
        'cloudbench_recovery_review', 'migration', 'migrated_registry', 'owned_worker_volume',
        'composite_result_finalizes_each_exact_root', 'minted_dispatch_preserves_live_root_observer',
        'evaluated_wrapper_completion_publishes_once', 'data_plane_mirror_reads_current_owner_port',
        'fleet_publishes_evaluation_before_teardown', 'boot_terminal_runtime_evidence_collects_complete_logs',
        'cloudbench_worker_snapshot', 'quiesced_guest_writes_hashed_authoritative_zero_allocated_receipt',
    )
    CONTROLLER_INVENTORY = (
        ('environment', ['bash', 'scripts/tests/cloudbench-env.test.sh']),
        ('autoscale', ['bash', 'scripts/tests/cloudbench-acceptance-autoscale.test.sh']),
        ('status-service-shutdown', ['python3', 'scripts/tests/run-cloudbench-controller-linux.py',
                                     '--fixture', 'status-service-shutdown']),
        ('infra-canary', ['bash', 'scripts/tests/fleet-infra-canary.test.sh']),
        ('infra-stability', ['bash', 'scripts/tests/fleet-infra-stability-proof.test.sh']),
        ('rootless-sms', ['python3', 'scripts/tests/cloudbench-exact-session-rootless-sms.test.py']),
        ('multi-workstream', ['bash', 'scripts/tests/cloudbench-multi-workstream.test.sh']),
        ('linux-contract', ['python3', 'scripts/tests/cloudbench-controller-linux.test.py']),
        ('github-token', ['bash', 'scripts/tests/cloudbench-github-token.test.sh']),
        ('seed-toolchain', ['bash', 'scripts/tests/seed-dump-toolchain.test.sh']),
        ('wall-clock', ['agents/venv/bin/python', '-m', 'pytest', '-q',
                        'agents/benchmarks/wall_clock_backstop_test.py']),
        ('selected-pytest', ['agents/venv/bin/python', '-m', 'pytest', '-q',
                             'agents/benchmarks/cloudbench_dependency_sync_test.py',
                             'agents/benchmarks/cloudbench_worker_snapshot_test.py',
                             'agents/benchmarks/cloudbench_recovery_review_test.py',
                             'agents/benchmarks/cloudbench_codex_auth_test.py',
                             'agents/benchmarks/cloud_batch_cleanup_test.py',
                             '-k', ' or '.join(CONTROLLER_PYTEST_KEYWORDS)]),
    )

    def test_complete_inventory_and_registration(self):
        self.assertEqual([(name, shlex.split(command)) for name, command in local_runner.CASES],
                         [(name, argv) for name, argv in self.CONTROLLER_INVENTORY])
        self.assertEqual(len(local_runner.CASES), 12)
        self.assertEqual(len({name for name, _ in local_runner.CASES}), 12)
        self.assertEqual(len(self.CONTROLLER_PYTEST_KEYWORDS), len(set(self.CONTROLLER_PYTEST_KEYWORDS)))
        # Every pinned command names suites that exist (a renamed or deleted suite cannot hide in the gate).
        for name, argv in self.CONTROLLER_INVENTORY:
            for token in argv:
                if token.startswith(('scripts/', 'agents/benchmarks/')) and not token.startswith('agents/venv/'):
                    self.assertTrue((ROOT / token).is_file(), f'{name}: {token} is not a file')
        registry = load('local_gate_registry', 'scripts/run-deploy-structural-gates.py')
        gate = next(gate for gate in registry.GATES if gate.name == 'deploy-test-worker')
        self.assertIn('scripts/tests/deploy-test-worker.test.py', gate.command)

    def test_staged_linux_template_and_existing_remote_template(self):
        planner = load('local_gate_planner', 'scripts/deploy_test_plan.py')
        response = subprocess.CompletedProcess([], 0, '{"lanes":[]}', '')
        for platform, command in (
            ('linux', [sys.executable, 'scripts/run-cloudbench-controller-local.py']),
            ('darwin', [sys.executable, 'scripts/run-cloudbench-controller-local.py']),
        ):
            with patch.object(planner.sys, 'platform', platform), patch.object(planner.subprocess, 'run', return_value=response):
                gate = next(g for g in planner.standard_template()['gates'] if g['name'] == 'cloudbench-controller')
            self.assertEqual(gate['command'], command)
            self.assertNotIn('platform', gate)

    def run_fixture(self, commands, *, changed=False, cancelled=False):
        with tempfile.TemporaryDirectory(prefix='controller-local-test-', dir='/var/tmp') as temporary:
            root = Path(temporary)
            before = {'head': 'fixture', 'digest': 'before'}
            after = {**before, 'digest': 'after'} if changed else before
            def invoke(argv, **kwargs):
                kwargs['output'].write(b'controlled native output\n')
                receipt = Path(argv[argv.index('--receipt') + 1])
                receipt.write_text(json.dumps(dict(native_exit=0, cancelled=cancelled,
                    quiescent=True, orphaned_children=False, error=None)))
                return 0, False, cancelled, False
            real = contextlib.nullcontext() if not cancelled else patch.object(local_runner, 'run_command', side_effect=invoke)
            with patch.object(local_runner, 'CASES', commands), patch.object(local_runner, 'source', side_effect=[before, after]), patch.object(sys, 'argv', ['controller-local', '--root', str(root), '--max-workers', '12']), contextlib.redirect_stdout(io.StringIO()), real:
                result = local_runner.main()
            result_path = next(root.glob('.context/cloudbench-local/run-*/result.json'))
            rows = json.loads(result_path.read_text())
            logs = {row['name']: Path(row['log']).read_text() for row in rows['cases']}
            for row in rows['cases']:
                if 'fixture_tmp' in row and Path(row['fixture_tmp']).exists():
                    shutil.rmtree(row['fixture_tmp'])
            return result, rows, logs

    def test_twelve_native_processes_isolated_and_failure_preserved(self):
        body = "import os,time; print('start',time.time(),os.environ['TMPDIR'],flush=True); time.sleep(.2); print('end',time.time(),flush=True)"
        commands = [(f'case-{i}', shlex.join([sys.executable, '-c', body + ('; raise SystemExit(1)' if i == 4 else '; raise SystemExit(78)' if i == 5 else '')])) for i in range(12)]
        code, result, logs = self.run_fixture(commands)
        self.assertEqual(code, 1)
        self.assertFalse(result['complete'])
        self.assertEqual(len(result['cases']), 12)
        self.assertEqual(result['cases'][4]['status'], 'FAIL')
        self.assertEqual(result['cases'][4]['native_exit'], 1)
        self.assertEqual(result['cases'][5]['status'], 'UNVERIFIED')
        self.assertEqual(result['cases'][5]['native_exit'], 78)
        intervals, directories = [], []
        for log in logs.values():
            start, end = [line.split() for line in log.splitlines()]
            intervals.extend([(float(start[1]), 1), (float(end[1]), -1)])
            directories.append(start[2])
        active = peak = 0
        for _, delta in sorted(intervals):
            active += delta
            peak = max(peak, active)
        self.assertGreater(peak, 1)
        self.assertEqual(len(set(directories)), 12)

    def test_all_pass_requires_unchanged_source(self):
        command = [('success', shlex.join([sys.executable, '-c', 'print("success")']))]
        code, result, _ = self.run_fixture(command)
        self.assertEqual(code, 0)
        self.assertTrue(result['complete'])
        self.assertTrue(result['cases'][0]['fixture_tmp_removed'])
        code, result, _ = self.run_fixture(command, changed=True)
        self.assertEqual(code, 1)
        self.assertFalse(result['complete'])
        self.assertEqual(result['cases'][0]['status'], 'UNVERIFIED')
        self.assertEqual(result['cases'][0]['reason'], 'source changed')


    def test_cancelled_suite_reaps_an_escaped_term_ignoring_child(self):
        with tempfile.TemporaryDirectory(prefix='controller-escape-', dir='/var/tmp') as raw:
            folder = Path(raw)
            ready = folder / 'ready'
            child = folder / 'child.py'
            parent = folder / 'parent.py'
            child.write_text(
                "import os,signal,sys,time\nfrom pathlib import Path\n"
                "signal.signal(signal.SIGTERM,signal.SIG_IGN)\n"
                "Path(sys.argv[1]).write_text(str(os.getpid()))\ntime.sleep(30)\n")
            parent.write_text(
                "import subprocess,sys,time\n"
                "p=subprocess.Popen([sys.executable,sys.argv[1],sys.argv[2]],start_new_session=True)\n"
                "try:\n time.sleep(30)\nfinally:\n p.kill();p.wait()\n")
            owned = {}
            identity = load('local_escape_identity', 'scripts/process-identity.py')

            def cancel_when_ready():
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    if ready.exists() and ready.read_text().strip():
                        owned['pid'] = int(ready.read_text())
                        owned['birth'] = identity.current_identity(owned['pid'])
                        local_runner.CANCEL.set()
                        return
                    time.sleep(0.01)
                local_runner.CANCEL.set()

            waiter = threading.Thread(target=cancel_when_ready)
            local_runner.CANCEL.clear()
            waiter.start()
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    row = local_runner.run_case(ROOT, folder, 'escaped', shlex.join([
                        sys.executable, str(parent), str(child), str(ready)]))
                waiter.join(6)
                self.assertIn('pid', owned)
                self.assertEqual(row['status'], 'UNVERIFIED')
                self.assertTrue(row['supervision']['quiescent'])
                self.assertFalse(Path(f"/proc/{owned['pid']}").exists())
            finally:
                local_runner.CANCEL.clear()
                waiter.join(6)
                if 'birth' in owned and Path(f"/proc/{owned['pid']}").exists():
                    identity.main(['process-identity.py', '--expect', owned['birth'],
                                   '--signal', 'KILL', str(owned['pid'])])


    def test_supervisor_errors_leave_one_unverified_receipt_without_cleanup_retry(self):
        for fault in ('spawn', 'missing', 'malformed', 'cleanup'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as raw:
                folder = Path(raw)

                def launch(argv, **kwargs):
                    if fault == 'spawn':
                        raise OSError('controlled spawn refusal')
                    if fault == 'missing':
                        return 78, False, False, False
                    receipt = Path(argv[argv.index('--receipt') + 1])
                    value = [] if fault == 'malformed' else dict(
                        native_exit=0, quiescent=True, cancelled=False,
                        orphaned_children=False, error=None)
                    receipt.write_text(json.dumps(value))
                    return 0, False, False, False

                with patch.object(local_runner, 'run_command', side_effect=launch), \
                     patch.object(local_runner.shutil, 'rmtree', side_effect=OSError('controlled cleanup refusal')) as cleanup, \
                     contextlib.redirect_stdout(io.StringIO()):
                    row = local_runner.run_case(ROOT, folder, fault, 'true')
                self.assertEqual(row['status'], 'UNVERIFIED')
                self.assertIn('reason', row)
                self.assertEqual(json.loads((folder / (fault + '.json')).read_text()), row)
                self.assertEqual(cleanup.call_count, 1 if fault == 'cleanup' else 0)
                self.assertTrue(Path(row['fixture_tmp']).is_dir())
                shutil.rmtree(row['fixture_tmp'])

    def test_cancelled_native_result_is_never_a_pass(self):
        code, result, logs = self.run_fixture([('cancelled', ['unused'])], cancelled=True)
        self.assertEqual(code, 1)
        self.assertFalse(result['complete'])
        self.assertEqual(result['cases'][0]['status'], 'UNVERIFIED')
        self.assertTrue(result['cases'][0]['cancelled'])
        self.assertNotIn('fixture_tmp_removed', result['cases'][0])
        self.assertEqual(logs['cancelled'], 'controlled native output\n')



FAKE_NPM = """#!/usr/bin/env python3
import json, os, signal, sys, time
from pathlib import Path
cfg = json.load(open(os.environ['FAKE_RUNNER_CONFIG'])); be = Path.cwd()
if cfg.get('cancel_parent'): os.kill(os.getppid(), signal.SIGTERM)
time.sleep(cfg.get('sleep', 0))
(be / 'coverage/blackbox-run-shard1').mkdir(parents=True, exist_ok=True)
json.dump({'results': cfg['results']}, open(be / 'coverage/blackbox-run-shard1/summary.json', 'w'))
for shard, body in cfg.get('extra_summaries', {}).items():
    target = be / 'coverage' / shard / 'summary.json'; target.parent.mkdir(parents=True, exist_ok=True); target.write_text(body)
(be / 'coverage/units.log').write_text('units'); print(cfg['unit_line']); print(cfg['fps_line'])
if cfg['rc'] != 0 and cfg.get('archive', True):
    f = be.parent / '.context/test-runs' / ('backend-coverage-failed-%s-%d' % (time.strftime('%Y%m%d-%H%M%S'), os.getpid()))
    (f / 'raw-v8').mkdir(parents=True); (f / 'raw-v8/coverage-failed-shard.json').write_text(cfg.get('failed_body', '{"failed": 1}'))
    if cfg.get('shard_log_archive'):
        (be / 'coverage/shard-1.log').write_text('    Raw V8 coverage: %s/raw-v8\\n' % f)
        print('Started coverage shard 1/1 (pid %d, log coverage/shard-1.log)' % (os.getpid() + int(cfg.get('wrong_pid', False))))
    else:
        print('    Raw V8 coverage: %s/raw-v8' % f)
    a = be.parent / '.context/test-runs' / ('backend-coverage-merged-failed-%s-%d' % (time.strftime('%Y%m%d-%H%M%S'), os.getpid()))
    (a / 'raw-v8').mkdir(parents=True); (a / 'raw-v8/coverage-1.json').write_text('{}')
    if cfg.get('collide'): (a / 'raw-v8/coverage-failed-shard.json').write_text('{"different": true}')
    print('Passing phases\\' raw coverage archived at %s/raw-v8.' % a)
raise SystemExit(cfg['rc'])
"""
FAKE_NPX = """#!/usr/bin/env python3
import json, os, sys, time
cfg = json.load(open(os.environ['FAKE_RUNNER_CONFIG']))
open(os.environ['FAKE_NPX_CALLS'], 'a').write(json.dumps(sys.argv[1:]) + '\\n')
time.sleep(cfg.get('c8_sleep', 0))
raise SystemExit(cfg.get('c8_rc', 0))
"""


class Backend(unittest.TestCase):
    """Case-aware backend coverage adapter over a fake sharded runner; no services, no real c8."""
    def setUp(self):
        import deploy_test_backend as backend
        self.backend = backend
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name) / 'root'
        (self.root / 'back-end/scripts').mkdir(parents=True); (self.root / 'scripts/tests').mkdir(parents=True)
        (self.root / 'back-end/src/tests/blackbox').mkdir(parents=True)
        for d in ('alpha', 'beta', 'gamma'):
            (self.root / f'back-end/src/tests/blackbox/{d}.blackbox.ts').write_text('export {}\n')
        (self.root / 'back-end/src/tests/blackbox/helpers.ts').write_text('export {}\n')  # not a domain
        (self.root / 'back-end/src/tests/blackbox/integration-health.blackbox.ts').write_text('export {}\n')  # producer-excluded
        __import__('shutil').copyfile(ROOT / 'back-end/scripts/run-coverage.sh', self.root / 'back-end/scripts/run-coverage.sh')
        (self.root / 'back-end/scripts/coverage-report-heap.sh').write_text('coverage_report_node() { "$@"; }\n')
        (self.root / 'scripts/tests/blackbox-backend-teardown.test.sh').write_text('#!/bin/bash\nexit "${FAKE_TEARDOWN_RC:-0}"\n')
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / '.git/info/exclude').write_text('.context/\nback-end/coverage/\n')
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'f'], check=True)
        bin_dir = Path(self.temp.name) / 'bin'; bin_dir.mkdir()
        for name, body in (('npm', FAKE_NPM), ('npx', FAKE_NPX)):
            (bin_dir / name).write_text(body); (bin_dir / name).chmod(0o700)
        self.config = Path(self.temp.name) / 'runner.json'; self.npx_calls = Path(self.temp.name) / 'npx.jsonl'
        self.env = patch.dict(os.environ, {'PATH': f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                                           # This fake runner owns no pinned workspace Postgres fixture.
                                           'ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME': '0',
                                           'FAKE_RUNNER_CONFIG': str(self.config), 'FAKE_NPX_CALLS': str(self.npx_calls)})
        self.env.start()
        self.request = {'token': 'be-1', 'source': cycle.source(self.root), 'gate': 'backend-coverage-blackbox',
                        'checks': backend.checks_for(['alpha', 'beta', 'gamma']), 'skips': {}, 'phase': 'initial'}

    def tearDown(self):
        self.env.stop(); cycle.CANCEL.clear(); self.temp.cleanup()

    def configure(self, rc, results, c8_rc=0, unit='✅ Unit pass passed', fps='✅ fps probe pass passed', archive=True, collide=False, shard_log_archive=False):
        cycle.write(self.config, {'rc': rc, 'results': results, 'c8_rc': c8_rc, 'unit_line': unit, 'fps_line': fps, 'archive': archive, 'collide': collide, 'shard_log_archive': shard_log_archive})

    def rows(self, **passed):
        return [{'domain': d, 'passed': v, 'aborted': False} for d, v in passed.items()]

    def postgres_fixture(self, running=False):
        helper = self.root / 'back-end/scripts/local-db-container.sh'
        shutil.copyfile(ROOT / 'back-end/scripts/local-db-container.sh', helper)
        state, calls = Path(self.temp.name) / 'postgres.json', Path(self.temp.name) / 'docker.jsonl'
        row = {'id': 'e' * 64, 'name': '/victoria-db-fixture', 'owner': str(self.root),
               'image_name': 'pgvector/pgvector:pg16', 'image': 'sha256:' + 'a' * 64,
               'running': running, 'status': 'running' if running else 'exited',
               'paused': False, 'restarting': False, 'dead': False,
               'ports': {'5432/tcp': [{'HostIp': '', 'HostPort': '20005'}]},
               'mounts': [{'Type': 'volume', 'Name': 'victoria-pgdata-fixture',
                           'Destination': '/var/lib/postgresql/data', 'RW': True}]}
        cycle.write(state, {'row': row})
        docker = Path(self.temp.name) / 'bin/docker'
        docker.write_text("#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\n"
            "p=Path(os.environ['FAKE_POSTGRES']); d=json.loads(p.read_text()); a=sys.argv[1:]\n"
            "with open(os.environ['FAKE_DOCKER_CALLS'],'a') as f: f.write(json.dumps(a)+'\\n')\n"
            "r=d['row']\n"
            "if a[0]=='inspect':\n"
            " if d.get('missing') or a[-1] not in (r['id'],r['name'][1:]): sys.exit(1)\n"
            " print(json.dumps(r)); sys.exit(0)\n"
            "if a==['start',r['id']]:\n"
            " if d.get('start_fail'): sys.exit(1)\n"
            " r.update(running=True,status='running'); r.update(d.get('after_start',{})); p.write_text(json.dumps(d)); sys.exit(0)\n"
            "if a==['exec',r['id'],'pg_isready','-U','postgres','-q']: sys.exit(0 if r['running'] else 1)\n"
            "raise AssertionError(a)\n")
        docker.chmod(0o700)
        env = {'CONDUCTOR_WORKSPACE_NAME': 'fixture', 'CONDUCTOR_PORT': '20000',
               'ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME': '1', 'FAKE_POSTGRES': str(state),
               'FAKE_DOCKER_CALLS': str(calls), 'BACKEND_COVERAGE_DATABASE_URL': ''}
        # A stopped fixture genuinely prevents the original setup; no fabricated result.
        setup = [sys.executable, '-c', "import json,os; from pathlib import Path; "
                 "assert json.loads(Path(os.environ['FAKE_POSTGRES']).read_text())['row']['running']; "
                 "Path('.context/setup-ran').write_text('ready')"]
        case = {'command': ['npm', 'run', 'test:coverage:sharded'], 'cwd': 'back-end',
                'env': env, 'sweep': 'backend-coverage-blackbox', 'aggregate': False}
        self.request['worker_recipe'] = {'cases': {c: dict(case) for c in self.request['checks']},
            'setup': {'command': setup, 'env': env}, 'cleanup': {'command': ['true']},
            'execution_timeout_seconds': 10}
        self.request['source'] = cycle.source(self.root)
        return state, calls, env

    def test_qualified_treasury_exclusion_keeps_full_native_peer_outcomes(self):
        # Actual43: the unchanged full shards include an already-qualified treasury FAIL.
        (self.root / 'back-end/src/tests/blackbox/treasury-rails.blackbox.ts').write_text('export {}\n')
        self.request['source'] = cycle.source(self.root)
        qualification = {'source': self.request['source'], 'disposition': 'treasury / skipped with warning',
            'rca': {'id': 'prior-native-treasury-failure', 'check': 'backend-coverage-blackbox/blackbox:treasury-rails',
                    'source': self.request['source'], 'description': 'Recorded historical unused mint',
                    'evidence': 'saved-native-treasury.log', 'native_result': 'FAIL', 'attribution': 'UNKNOWN',
                    'standing_policy': {'name': 'treasury-failures-skip-and-warn-2026-10-29',
                        'reason': 'Original financial return remains unknown', 'affected_records': ['fixture-card / fixture-transfer'],
                        'evidence_at': 1}}}
        self.request['skips'] = {'blackbox:treasury-rails': qualification}
        before = copy.deepcopy(self.request)
        self.configure(1, self.rows(alpha=True, beta=False, **{'treasury-rails': False}),
                       unit='❌ Unit pass failed (exit 1)', c8_rc=1)
        config = cycle.read(self.config)
        config['extra_summaries'] = {'blackbox-run-shard2': json.dumps({'results': self.rows(gamma=True)})}
        cycle.write(self.config, config)
        result = self.backend.execute(self.request, self.root)
        self.assertEqual('PASS', result['cases']['blackbox:alpha'])
        self.assertEqual('FAIL', result['cases']['blackbox:beta'])
        self.assertEqual('PASS', result['cases']['blackbox:gamma'])
        self.assertEqual('FAIL', result['cases']['units'])
        self.assertEqual('UNVERIFIED', result['cases']['coverage-threshold'])
        self.assertEqual('PASS', result['cases']['teardown'])
        self.assertNotIn('blackbox:treasury-rails', result['cases'])
        self.assertEqual([], result['evidence']['unknown_domains'])
        excluded = result['evidence']['qualified_excluded_rows']['blackbox:treasury-rails']
        self.assertIs(excluded['passed'], False); self.assertIs(excluded['aborted'], False)
        self.assertEqual(__import__('hashlib').sha256(json.dumps(qualification, sort_keys=True).encode()).hexdigest(),
                         excluded['qualification_sha256'])
        self.assertEqual(2, len(result['evidence']['artifacts']['summaries']))
        self.assertEqual(1, result['native_exit']); self.assertFalse(result['complete'])
        self.assertTrue(result['cleanup_complete']); self.assertEqual(before, self.request)

    def test_qualified_domain_skips_reach_native_runner_env_without_hiding_peer_failures(self):
        (self.root / 'back-end/src/tests/blackbox/treasury-rails.blackbox.ts').write_text('export {}\n')
        self.request['source'] = cycle.source(self.root)
        qualification = {'source': self.request['source'], 'disposition': 'treasury / skipped with warning',
            'rca': {'id': 'qualified-before-native', 'check': 'backend-coverage-blackbox/blackbox:treasury-rails',
                    'source': self.request['source'], 'description': 'Recorded historical unused mint',
                    'evidence': 'saved-native-treasury.log', 'native_result': 'FAIL', 'attribution': 'UNKNOWN',
                    'standing_policy': {'name': 'treasury-failures-skip-and-warn-2026-10-29',
                        'reason': 'Original financial return remains unknown', 'affected_records': ['fixture-card / fixture-transfer'],
                        'evidence_at': 1}}}
        self.request['skips'] = {'blackbox:treasury-rails': qualification}
        before = copy.deepcopy(self.request)
        self.configure(1, self.rows(alpha=True, beta=False, gamma=True))
        observed = []
        native_run = self.backend.run_command
        def capture(argv, **kwargs):
            if argv == self.backend.RUNNER:
                observed.append({key: kwargs['env'].get(key) for key in self.backend.SKIP_ENV})
            return native_run(argv, **kwargs)
        with patch.object(self.backend, 'run_command', side_effect=capture):
            result = self.backend.execute(self.request, self.root)
        self.assertEqual([{key: 'integration-health,treasury-rails' for key in self.backend.SKIP_ENV}], observed)
        self.assertEqual('FAIL', result['cases']['blackbox:beta'])
        self.assertEqual('PASS', result['cases']['blackbox:alpha'])
        self.assertEqual('PASS', result['cases']['blackbox:gamma'])
        self.assertNotIn('blackbox:treasury-rails', result['cases'])
        self.assertEqual(1, result['native_exit'])
        self.assertTrue(result['cleanup_complete'])
        self.assertEqual(before, self.request)

    def test_qualified_request_does_not_authorize_caller_or_recipe_skip_env(self):
        # Qualifications authorize the adapter to derive native env, never callers.
        self.test_qualified_domain_skips_reach_native_runner_env_without_hiding_peer_failures()
        for env_key in self.backend.SKIP_ENV:
            for origin in ('caller', 'sweep', 'setup'):
                with self.subTest(env_key=env_key, origin=origin):
                    shutil.rmtree(self.root / '.context', ignore_errors=True)
                    request = copy.deepcopy(self.request)
                    case = {'command': list(self.backend.RUNNER), 'cwd': 'back-end',
                            'aggregate': False, 'sweep': 'backend-coverage-blackbox'}
                    request['worker_recipe'] = {'cases': {
                        check: copy.deepcopy(case) for check in self.backend.checks_for(self.backend.selection(self.root)[1])}}
                    untrusted = {env_key: 'integration-health,treasury-rails'}
                    caller = untrusted if origin == 'caller' else {}
                    if origin == 'sweep':
                        for spec in request['worker_recipe']['cases'].values(): spec['env'] = untrusted
                    if origin == 'setup': request['worker_recipe']['setup'] = {'command': ['true'], 'env': untrusted}
                    with patch.dict(os.environ, caller), patch.object(self.backend, 'run_command', side_effect=AssertionError('must refuse before native launch')):
                        with self.assertRaisesRegex(ValueError, 'skip_env_not_allowed'):
                            self.backend.execute(request, self.root)

    def test_qualified_exclusion_never_accepts_foreign_or_malformed_membership(self):
        self.test_qualified_treasury_exclusion_keeps_full_native_peer_outcomes()
        qualification = copy.deepcopy(self.request['skips'])
        variants = {'missing': {}, 'empty': {'blackbox:treasury-rails': {}},
                    'wrong-source': copy.deepcopy(qualification), 'wrong-case': copy.deepcopy(qualification),
                    'blocking': copy.deepcopy(qualification), 'unknown': {'blackbox:foreign': next(iter(qualification.values()))}}
        variants['wrong-source']['blackbox:treasury-rails']['source'] = {'head': 'foreign', 'digest': 'foreign'}
        variants['wrong-case']['blackbox:treasury-rails']['rca']['check'] = 'backend-coverage-blackbox/blackbox:beta'
        variants['blocking']['blackbox:treasury-rails']['disposition'] = 'blocking'
        for label, skipped in variants.items():
            with self.subTest(label=label):
                shutil.rmtree(self.root / '.context')
                self.request['skips'] = skipped
                with patch.object(self.backend, 'run_command', side_effect=AssertionError('must refuse before native launch')):
                    with self.assertRaises(ValueError): self.backend.execute(self.request, self.root)
        self.request['skips'] = qualification
        for label in ('unknown-row', 'mixed-row', 'malformed-excluded', 'duplicate-excluded', 'unreadable'):
            with self.subTest(label=label):
                shutil.rmtree(self.root / '.context', ignore_errors=True)
                self.configure(1, self.rows(alpha=True, beta=False, gamma=True, **{'treasury-rails': False}))
                config = cycle.read(self.config)
                if label == 'unknown-row': config['results'].append({'domain': 'foreign', 'passed': True, 'aborted': False})
                if label == 'mixed-row': config['results'].append(None)
                if label == 'malformed-excluded': config['results'][-1]['passed'] = 'false'
                if label == 'duplicate-excluded': config['results'].append(dict(config['results'][-1]))
                if label == 'unreadable': config['extra_summaries'] = {'blackbox-run-shard2': '{'}
                cycle.write(self.config, config)
                result = self.backend.execute(self.request, self.root)
                self.assertTrue(all(v == 'UNVERIFIED' for k, v in result['cases'].items() if k.startswith('blackbox:')))
                self.assertTrue(result['cleanup_complete'])
                self.assertNotIn('blackbox:treasury-rails', result['cases'])

    def test_stopped_owned_postgres_is_restored_before_the_unchanged_setup_and_sweep(self):
        state, calls, env = self.postgres_fixture()
        self.configure(0, self.rows(alpha=True, beta=True, gamma=True))
        with patch.dict(os.environ, env):
            result = self.backend.execute(self.request, self.root)
        self.assertEqual(0, result['native_exit'])
        self.assertTrue(all(v == 'PASS' for v in result['cases'].values()))
        self.assertEqual('ready', (self.root / '.context/setup-ran').read_text())
        native = [json.loads(x) for x in calls.read_text().splitlines()]
        self.assertEqual([['start', 'e' * 64]], [x for x in native if x[0] == 'start'])
        self.assertEqual(['inspect', 'start', 'inspect', 'exec'], [x[0] for x in native])
        proof = result['evidence']['postgres_fixture']
        self.assertTrue(proof['restored']); self.assertEqual('e' * 64, proof['id'])
        self.assertEqual(cycle.sha_file(Path(result['runner_log']).parent / 'postgres-before.json'), proof['before_sha256'])
        self.assertEqual(cycle.sha_file(Path(result['runner_log']).parent / 'postgres-after.json'), proof['after_sha256'])
        self.assertEqual(10, self.request['worker_recipe']['execution_timeout_seconds'])

    def test_healthy_owned_postgres_is_only_checked_never_started(self):
        state, calls, env = self.postgres_fixture(running=True)
        self.configure(0, self.rows(alpha=True, beta=True, gamma=True))
        with patch.dict(os.environ, env):
            result = self.backend.execute(self.request, self.root)
        self.assertEqual(0, result['native_exit'])
        self.assertFalse(result['evidence']['postgres_fixture']['restored'])
        self.assertEqual(['inspect', 'inspect', 'exec'], [json.loads(x)[0] for x in calls.read_text().splitlines()])

    def test_postgres_restore_refuses_missing_foreign_or_changed_fixture_without_running_setup(self):
        state, calls, env = self.postgres_fixture()
        original = cycle.read(state)
        variants = [('missing', {'missing': True}), ('owner', {'row': {**original['row'], 'owner': '/foreign'}}),
                    ('volume', {'row': {**original['row'], 'mounts': []}}),
                    ('port', {'row': {**original['row'], 'ports': {}}}),
                    ('image', {'row': {**original['row'], 'image_name': 'postgres:16-alpine'}}),
                    ('paused', {'row': {**original['row'], 'paused': True}}),
                    ('start_failed', {'start_fail': True}),
                    ('identity_changed', {'after_start': {'image': 'sha256:' + 'b' * 64}})]
        self.configure(0, self.rows(alpha=True, beta=True, gamma=True))
        for number, (label, change) in enumerate(variants):
            with self.subTest(label=label):
                cycle.write(state, {**copy.deepcopy(original), **change}); calls.unlink(missing_ok=True)
                self.request['token'] = 'fixture-refusal-' + str(number)
                with patch.dict(os.environ, env), self.assertRaises(ValueError):
                    self.backend.execute(self.request, self.root)
                self.assertFalse((self.root / '.context/setup-ran').exists())
                native = [json.loads(x) for x in calls.read_text().splitlines()]
                self.assertTrue(all(x[0] in ('inspect', 'start') for x in native))
                self.assertEqual(int(label in ('start_failed', 'identity_changed')), sum(x[0] == 'start' for x in native))

    def test_native_list_output_is_only_a_cross_check_and_is_refused_when_polluted(self):
        files = ['alpha', 'beta', 'gamma']
        good = 'Available black-box test domains:\n  alpha\n  beta\n  gamma\n\nTotal: 3 domains\n'
        self.assertEqual(files, self.backend.parse_native_list(good, files))
        polluted = ("⚠️  TRACE_ARCHIVE_BACKEND='r2' is not a local blackbox backend; forcing local.\n"
                    'Available black-box test domains:\n  alpha\n  alpha\n  beta\n  gamma\n\nTotal: 4 domains\n')
        with self.assertRaisesRegex(ValueError, 'inventory_invalid'): self.backend.parse_native_list(polluted, files)
        with self.assertRaisesRegex(ValueError, 'inventory_invalid'): self.backend.parse_native_list(good.replace('Total: 3', 'Total: 2'), files)
        with self.assertRaisesRegex(ValueError, 'inventory_invalid'): self.backend.validate_inventory(['alpha', 'bad name'])

    def test_selection_applies_only_the_producer_exclusion_and_refuses_env_skips(self):
        proof, effective = self.backend.selection(self.root)
        self.assertEqual({'inventory': 4, 'excluded': {'integration-health': 'owned by live-probes'}, 'effective': 3}, proof)
        self.assertEqual(['alpha', 'beta', 'gamma'], effective)
        self.assertEqual(['integration-health'], self.backend.producer_exclusions(ROOT))  # pinned to the real run-coverage.sh
        self.configure(0, self.rows(alpha=True, beta=True, gamma=True) + [{'domain': 'integration-health', 'passed': False, 'aborted': False}])
        result = self.backend.execute(self.request, self.root)
        self.assertNotIn('blackbox:integration-health', result['cases']); self.assertTrue(all(v == 'PASS' for v in result['cases'].values()))
        self.assertEqual(proof, result['selection']); self.assertEqual(1, len(result['evidence']['excluded_rows']))
        __import__('shutil').rmtree(self.root / '.context')
        with patch.dict(os.environ, {'BLACKBOX_TEST_SKIP_DOMAINS': 'integration-health,alpha'}):
            with self.assertRaisesRegex(ValueError, 'skip_env_not_allowed'): self.backend.execute(self.request, self.root)
        with patch.dict(os.environ, {'CONTRACT_TEST_SKIP_DOMAINS': 'integration-health'}):
            self.request['token'] = 'be-2'
            self.backend.execute(self.request, self.root)  # the producer's own exclusion is allowed

    def test_inventory_is_frozen_from_the_runner_list(self):
        self.assertEqual(['alpha', 'beta', 'gamma', 'integration-health'], self.backend.list_domains(self.root))
        self.assertEqual(['blackbox:alpha', 'blackbox:beta', 'blackbox:gamma', 'units', 'fps', 'coverage-threshold', 'teardown'],
                         self.backend.checks_for(self.backend.selection(self.root)[1]))
        self.configure(0, self.rows(alpha=True, beta=True, gamma=True))
        self.request['checks'] = ['blackbox:delta', 'units']
        with self.assertRaisesRegex(ValueError, 'frozen domain list'): self.backend.execute(self.request, self.root)

    def test_one_failed_domain_keeps_its_peers_and_threshold_runs_over_the_archive(self):
        self.configure(1, self.rows(alpha=True, beta=False, gamma=True))
        result = self.backend.execute(self.request, self.root)
        self.assertEqual({'blackbox:alpha': 'PASS', 'blackbox:beta': 'FAIL', 'blackbox:gamma': 'PASS', 'units': 'PASS',
                          'fps': 'PASS', 'coverage-threshold': 'PASS', 'teardown': 'PASS'}, result['cases'])
        self.assertTrue(result['complete']); self.assertTrue(result['cleanup_complete']); self.assertEqual(1, result['native_exit'])
        call = json.loads(self.npx_calls.read_text().splitlines()[0])
        self.assertEqual(['c8', 'report'], call[:2]); self.assertIn('--check-coverage', call)
        self.assertTrue(any(a.startswith('--temp-directory=') and a.endswith('/raw-v8-union') for a in call))

        identity = result['evidence']['coverage-threshold']['identity']
        self.assertEqual(2, len(identity['sources']))  # passing merged archive + this run's failed-shard raw-v8
        union = Path(identity['union']); self.assertEqual({'coverage-1.json', 'coverage-failed-shard.json'}, {p.name for p in union.iterdir()})
        __import__('shutil').rmtree(self.root / '.context')
        self.configure(1, self.rows(alpha=True, beta=False, gamma=True), collide=True)  # same name, different content
        result = self.backend.execute(self.request, self.root)
        self.assertEqual('UNVERIFIED', result['cases']['coverage-threshold']); self.assertIn('collision', result['evidence']['coverage-threshold']['reason'])


    def test_failed_shard_raw_archive_is_read_from_its_announced_child_log(self):
        self.configure(1, self.rows(alpha=True, beta=False, gamma=True), shard_log_archive=True)
        result = self.backend.execute(self.request, self.root)
        threshold = result['evidence']['coverage-threshold']
        self.assertEqual('PASS', result['cases']['coverage-threshold'])
        self.assertEqual(2, len(threshold['identity']['sources']))
        self.assertTrue(any('backend-coverage-failed-' in row['path'] for row in threshold['identity']['sources']))
        self.assertIn(str(self.root / 'back-end/coverage/shard-1.log'), result['evidence']['shard_logs'])
        __import__('shutil').rmtree(self.root / '.context')
        config = cycle.read(self.config); config['wrong_pid'] = True; cycle.write(self.config, config)
        result = self.backend.execute(self.request, self.root)
        self.assertEqual('UNVERIFIED', result['cases']['coverage-threshold'])
        self.assertIn('announced process', result['evidence']['coverage-threshold']['reason'])

    def test_full_request_cannot_omit_cases_or_change_the_owned_root(self):
        self.configure(0, self.rows(alpha=True, beta=True, gamma=True))
        with self.assertRaisesRegex(ValueError, 'inventory'):
            self.backend.execute({**self.request, 'checks': ['blackbox:alpha']}, self.root)
        with self.assertRaisesRegex(ValueError, 'prepared binding'):
            self.backend.execute({**self.request, 'worker_root': '/some-other-root'}, self.root)

    # This control injects the sweep deadline/cancellation; fixture admission is tested separately.
    @patch('deploy_test_backend.restore_workspace_postgres', new=lambda *args: None)
    def test_threshold_uses_the_remaining_original_request_budget(self):
        self.configure(1, self.rows(alpha=True, beta=False, gamma=True))
        config = cycle.read(self.config); config['c8_sleep'] = 6; cycle.write(self.config, config)
        slot = self.owner_slot()
        self.request['worker_recipe'] = self.backend.handoff_recipe(slot['recipe'], ['alpha', 'beta', 'gamma'], 1.5)
        before = time.monotonic()
        result = self.backend.execute(self.request, self.root)
        self.assertEqual('UNVERIFIED', result['cases']['coverage-threshold'])
        self.assertLess(time.monotonic() - before, 4.5)

    # This control injects the sweep deadline/cancellation; fixture admission is tested separately.
    @patch('deploy_test_backend.restore_workspace_postgres', new=lambda *args: None)
    def test_expired_or_cancelled_sweep_still_finishes_both_owned_cleanup_steps(self):
        slot = self.owner_slot()
        (self.root / 'scripts/kill-services.sh').write_text('#!/bin/bash\nsleep .05; touch "$PWD/.context/recipe-cleanup-ran"\n')
        (self.root / self.backend.TEARDOWN).write_text('#!/bin/bash\nsleep .05; touch "$PWD/.context/native-teardown-ran"\n')
        self.request['source'] = cycle.source(self.root)
        self.request['worker_recipe'] = self.backend.handoff_recipe(slot['recipe'], ['alpha', 'beta', 'gamma'], 1.5)
        self.request['worker_recipe']['cleanup']['timeout_seconds'] = 2
        native = self.backend.run_command
        for reason in ('deadline', 'cancel'):
            with self.subTest(reason=reason):
                shutil.rmtree(self.root / '.context', ignore_errors=True)
                self.request['token'] = 'be-cleanup-' + reason
                self.configure(0, self.rows(alpha=True, beta=True, gamma=True))
                config = cycle.read(self.config); config.update(sleep=8, cancel_parent=reason == 'cancel'); cycle.write(self.config, config)
                calls = []
                def observe(argv, **kwargs):
                    calls.append((argv, kwargs['timeout'], self.backend.CANCEL.is_set()))
                    return native(argv, **kwargs)
                before = time.monotonic()
                with patch.object(self.backend, 'run_command', side_effect=observe):
                    result = self.backend.execute(self.request, self.root)
                self.assertTrue(result['interrupted']); self.assertFalse(result['complete'])
                self.assertTrue((self.root / '.context/recipe-cleanup-ran').is_file())
                self.assertTrue((self.root / '.context/native-teardown-ran').is_file())
                self.assertEqual(result['cases']['teardown'], 'PASS'); self.assertTrue(result['cleanup_complete'])
                self.assertTrue(all(v == 'UNVERIFIED' for k, v in result['cases'].items() if k != 'teardown'))
                sweep = next(c for c in calls if c[0][-3:] == self.backend.RUNNER)
                cleanup = next(c for c in calls if 'scripts/kill-services.sh' in ' '.join(c[0]))
                teardown = next(c for c in calls if c[0] == ['bash', self.backend.TEARDOWN])
                self.assertGreater(sweep[1], 0); self.assertLessEqual(sweep[1], 1.5)
                self.assertGreater(cleanup[1], .05); self.assertLessEqual(cleanup[1], 2)
                self.assertGreater(teardown[1], .05); self.assertLessEqual(teardown[1], self.backend.CLEANUP_SECONDS)
                self.assertFalse(cleanup[2]); self.assertFalse(teardown[2])
                self.assertEqual(self.backend.CANCEL.is_set(), reason == 'cancel')
                self.assertLess(time.monotonic() - before, 6)

    # This control injects the sweep deadline/cancellation; fixture admission is tested separately.
    @patch('deploy_test_backend.restore_workspace_postgres', new=lambda *args: None)
    def test_cancel_is_restored_when_recipe_cleanup_or_native_teardown_raises(self):
        slot = self.owner_slot()
        self.request['worker_recipe'] = self.backend.handoff_recipe(slot['recipe'], ['alpha', 'beta', 'gamma'])
        native = self.backend.run_command
        for operation in ('recipe', 'native'):
            with self.subTest(operation=operation):
                shutil.rmtree(self.root / '.context', ignore_errors=True)
                self.request['token'] = 'be-cleanup-error-' + operation
                self.configure(0, self.rows(alpha=True, beta=True, gamma=True))
                config = cycle.read(self.config); config.update(sleep=2, cancel_parent=True); cycle.write(self.config, config)
                def fault(argv, **kwargs):
                    selected = ('scripts/kill-services.sh' in ' '.join(argv) if operation == 'recipe'
                                else argv == ['bash', self.backend.TEARDOWN])
                    if selected:
                        self.assertFalse(self.backend.CANCEL.is_set())
                        raise OSError('controlled cleanup launch failure')
                    return native(argv, **kwargs)
                with patch.object(self.backend, 'run_command', side_effect=fault), self.assertRaisesRegex(OSError, 'controlled cleanup launch'):
                    self.backend.execute(self.request, self.root)
                self.assertTrue(self.backend.CANCEL.is_set())

    def test_invalid_shard_summary_records_unverified_and_still_tears_down(self):
        native_read = Path.read_bytes
        variants = {'truncated': '{', 'not-object': '[]', 'null-results': '{"results":null}',
                    'bad-results': '{"results":{}}', 'bad-row': '{"results":[null]}',
                    'unreadable': '{"results":[]}'}
        for name, body in variants.items():
            with self.subTest(name=name):
                shutil.rmtree(self.root / '.context', ignore_errors=True)
                self.request['token'] = 'be-summary-' + name
                self.configure(0, self.rows(alpha=True, beta=True, gamma=True))
                config = cycle.read(self.config); config['extra_summaries'] = {'blackbox-run-shard2': body}; cycle.write(self.config, config)
                target = self.root / 'back-end/coverage/blackbox-run-shard2/summary.json'
                def read_bytes(path):
                    if name == 'unreadable' and path == target:
                        raise PermissionError('controlled unreadable shard')
                    return native_read(path)
                with patch.object(Path, 'read_bytes', read_bytes):
                    result = self.backend.execute(self.request, self.root)
                self.assertFalse(result['complete']); self.assertTrue(result['cleanup_complete'])
                self.assertTrue(all(v == 'UNVERIFIED' for k, v in result['cases'].items() if k.startswith('blackbox:')))
                self.assertEqual(result['cases']['units'], 'PASS'); self.assertEqual(result['cases']['teardown'], 'PASS')
                self.assertIn(str(target), result['evidence']['summary_errors'])
                self.assertIn('error', result['evidence']['summary_errors'][str(target)])
                first = str(self.root / 'back-end/coverage/blackbox-run-shard1/summary.json')
                self.assertIn(first, result['evidence']['artifacts']['summaries'])
                self.assertEqual(result['evidence']['blackbox:alpha']['shard'], first)
                saved = self.root / '.context/deploy-backend' / __import__('hashlib').sha256(self.request['token'].encode()).hexdigest() / 'result.json'
                self.assertEqual(cycle.read(saved), result)

    def test_threshold_failure_on_partial_coverage_is_inconclusive_not_fail(self):
        self.configure(1, self.rows(alpha=True, beta=False, gamma=True), c8_rc=1)
        result = self.backend.execute(self.request, self.root)
        self.assertEqual('UNVERIFIED', result['cases']['coverage-threshold']); self.assertEqual('FAIL', result['cases']['blackbox:beta'])
        self.assertFalse(result['complete'])
        self.configure(1, self.rows(alpha=True, beta=False, gamma=True), archive=False)
        __import__('shutil').rmtree(self.root / '.context')
        result = self.backend.execute(self.request, self.root)
        self.assertEqual('UNVERIFIED', result['cases']['coverage-threshold'])

    def test_missing_domain_and_failed_phases_are_reported_per_case(self):
        self.configure(1, self.rows(alpha=True, beta=True), unit='❌ Unit pass failed (exit 1); see coverage/units.log',
                       fps='❌ fps probe pass failed (exit 1); see coverage/units-probe.log')
        result = self.backend.execute(self.request, self.root)
        self.assertEqual('UNVERIFIED', result['cases']['blackbox:gamma']); self.assertEqual('FAIL', result['cases']['units'])
        self.assertEqual('FAIL', result['cases']['fps']); self.assertFalse(result['complete'])

    def test_runner_exit_zero_passes_threshold_without_a_second_report(self):
        self.configure(0, self.rows(alpha=True, beta=True, gamma=True))
        result = self.backend.execute(self.request, self.root)
        self.assertTrue(all(v == 'PASS' for v in result['cases'].values())); self.assertFalse(self.npx_calls.exists())
        from deploy_test_result import validate
        validate(result, self.request, 0)

    def test_teardown_failure_cannot_claim_cleanup(self):
        self.configure(0, self.rows(alpha=True, beta=True, gamma=True))
        with patch.dict(os.environ, {'FAKE_TEARDOWN_RC': '1'}):
            result = self.backend.execute(self.request, self.root)
        self.assertEqual('FAIL', result['cases']['teardown']); self.assertFalse(result['cleanup_complete'])
        self.assertEqual('PASS', result['cases']['blackbox:alpha'])

    def owner_slot(self):
        slot = json.loads((ROOT / 'scripts/tests/fixtures/backend-slot-aggregate.json').read_text())
        _, _, fixture_env = self.postgres_fixture(running=True)
        self.request.pop('worker_recipe', None)
        for spec in [*slot['recipe']['cases'].values(), slot['recipe']['setup'], slot['recipe']['cleanup']]:
            spec.setdefault('env', {}).update(fixture_env)
        stage = self.root / 'scripts/run-deploy-stage'
        stage.write_text('#!/bin/bash\nmkdir -p "$PWD/.context"\n[ "$1" = "--start" ] && { touch "$PWD/.context/setup-ran"; exit 0; }\n'
                         '[ "$1" = "--finish" ] && { touch "$PWD/.context/finish-ran"; exit 0; }\nshift 2; exec "$@"\n')
        (self.root / 'scripts/kill-services.sh').write_text('#!/bin/bash\nexit 0\n')
        slot['recipe']['cases']['backend-coverage-blackbox']['command'][1] = str(stage)
        self.request['source'] = cycle.source(self.root)  # the fake stage scripts are part of the frozen tree
        return slot

    def test_handoff_replaces_the_owner_aggregate_recipe_and_runs_it_through_the_stage_wrapper(self):
        slot = self.owner_slot()
        recipe = self.backend.handoff_recipe(slot['recipe'], ['alpha', 'beta', 'gamma'])
        self.assertEqual(set(self.request['checks']), set(recipe['cases']))
        case = recipe['cases']['blackbox:beta']
        self.assertFalse(case['aggregate']); self.assertEqual('backend-coverage-blackbox', case['sweep'])
        self.assertEqual(['npm', 'run', 'test:coverage:sharded'], case['command'][-3:]); self.assertEqual('3', case['env']['BACKEND_COVERAGE_SHARDS'])
        self.assertEqual(slot['recipe']['setup'], recipe['setup']); self.assertEqual(slot['recipe']['cleanup'], recipe['cleanup'])
        self.configure(1, self.rows(alpha=True, beta=False, gamma=True))
        self.request['worker_recipe'] = recipe
        result = self.backend.execute(self.request, self.root)
        self.assertEqual('FAIL', result['cases']['blackbox:beta']); self.assertEqual('PASS', result['cases']['blackbox:alpha'])
        self.assertEqual('PASS', result['cases']['teardown']); self.assertTrue(result['cleanup_complete'])
        self.assertTrue((self.root / '.context/setup-ran').exists()); self.assertTrue((self.root / '.context/finish-ran').exists())
        from deploy_test_result import validate
        validate(result, self.request, 1)
        # cancellation during the sweep still runs the verbatim cleanup and never claims the cases
        __import__('shutil').rmtree(self.root / '.context'); self.request['token'] = 'be-cancel'
        recipe['cases']['blackbox:alpha']['timeout_seconds'] = 0.2  # sweep deadline from the spec is preserved
        for case in recipe['cases'].values(): case['timeout_seconds'] = 0.2
        recipe['cases']['blackbox:alpha']['command'] = recipe['cases']['blackbox:alpha']['command']
        slow = dict(self.request, worker_recipe={**recipe, 'cases': {k: {**v, 'command': ['sleep', '5']} for k, v in recipe['cases'].items()}})
        slow_result = self.backend.execute(slow, self.root)
        self.assertTrue(slow_result['interrupted']); self.assertTrue(all(v == 'UNVERIFIED' for k, v in slow_result['cases'].items() if k != 'teardown'))
        self.assertTrue((self.root / '.context/finish-ran').exists()); self.assertEqual('PASS', slow_result['cases']['teardown'])
        self.assertEqual(str(self.root / 'scripts/run-deploy-stage'), result['native_command'][1])
        self.assertEqual(['npm', 'run', 'test:coverage:sharded'], result['native_command'][-3:])

    def test_old_aggregate_recipe_is_refused_never_silently_substituted(self):
        slot = self.owner_slot()
        self.configure(0, self.rows(alpha=True, beta=True, gamma=True))
        self.request['worker_recipe'] = slot['recipe']
        with self.assertRaisesRegex(ValueError, 'single-case aggregate recipe'): self.backend.execute(self.request, self.root)
        import deploy_test_plan as p
        template = {'gates': [{'name': 'backend-coverage-blackbox', 'category': 'backend-coverage-blackbox', 'checks': self.request['checks'],
                               'native_backend': True, 'case_protocol': True, 'command': ['adapter']},
                              *[{'name': n, 'category': n, 'command': ['true'], 'checks': [n]} for n in ('format', 'eslint', 'typescript', 'backend-structural')]]}
        binding = {'backend-coverage-blackbox': {**slot, 'command': ['adapter'], 'cwd': str(self.root)}}
        selection = {'all': True, 'reasons': ['x'],
                     'lanes': {lane: [] for lanes in p.GRAPH_LANES.values() for lane in lanes}}
        with patch.object(p, 'source', return_value=self.request['source']), self.assertRaisesRegex(ValueError, 'single-case aggregate recipe'):
            p.select(template, ['back-end/src/a.ts'], selection, binding)
        from deploy_test_bindings import generate
        with self.assertRaisesRegex(ValueError, 'single-case aggregate recipe'):
            generate({'gates': [{**template['gates'][0], 'command': ['npm', 'run', 'test:coverage:sharded'], 'cwd': 'back-end'}]},
                     {'backend-coverage-blackbox': slot}, ROOT)

    def test_boxes_binding_runs_one_backend_adapter_not_one_sweep_per_case(self):
        from deploy_test_bindings import generate
        from deploy_test_boxes import build_prompt
        slot = self.owner_slot()
        slot['recipe'] = self.backend.handoff_recipe(slot['recipe'], ['alpha', 'beta', 'gamma'])
        gate = {'name': 'backend-coverage-blackbox', 'checks': self.request['checks'],
                'native_backend': True, 'command': ['npm', 'run', 'test:coverage:sharded']}
        binding = generate({'gates': [gate]}, {'backend-coverage-blackbox': slot}, ROOT)[gate['name']]
        self.assertEqual('deploy_test_backend.py', binding['command'][binding['command'].index('--worker-script') + 1])
        prompt_binding = {**slot, 'worker_script': 'deploy_test_backend.py'}
        request = {**self.request, 'worker_recipe': slot['recipe']}
        prompt = build_prompt(request, prompt_binding)
        self.assertIn('/scripts/deploy_test_backend.py', prompt)
        self.assertNotIn('/scripts/deploy_test_worker.py --root', prompt)
        from deploy_test_isolation import validate as validate_isolation
        native_gate = {**gate, **binding, 'worker_transport': slot['transport'],
                       'remote_python': slot['python'], 'worker_recipe': slot['recipe'],
                       'result_transport': 'file', 'case_protocol': True, 'env': slot['env']}
        validate_isolation({'gates': [native_gate]}, ROOT)
        wrong = {**native_gate, 'command': [*native_gate['command'][:-1], 'deploy_test_worker.py']}
        with self.assertRaisesRegex(ValueError, 'argv must bind'):
            validate_isolation({'gates': [wrong]}, ROOT)
        with self.assertRaisesRegex(ValueError, 'backend entrypoint'):
            build_prompt({**request, 'gate': 'another-gate'}, prompt_binding)

    def test_rows_archive_and_source_are_bound_fail_closed(self):
        self.configure(1, [{'domain': 'alpha', 'passed': 'yes', 'aborted': False}, {'domain': 'beta', 'passed': True, 'aborted': False},
                           {'domain': 'beta', 'passed': True, 'aborted': False}, {'domain': 'gamma', 'passed': True, 'aborted': None}])
        result = self.backend.execute(self.request, self.root)
        self.assertEqual({'blackbox:alpha': 'UNVERIFIED', 'blackbox:beta': 'UNVERIFIED', 'blackbox:gamma': 'UNVERIFIED'},
                         {k: v for k, v in result['cases'].items() if k.startswith('blackbox:')})
        self.assertEqual('PASS', result['cases']['coverage-threshold'])  # announced archive, PASS on partial is sound
        self.assertTrue(result['evidence']['coverage-threshold']['identity']['union_manifest_sha256'])
        self.assertEqual(1, len(result['evidence']['artifacts']['summaries'])); self.assertTrue(result['evidence']['artifacts']['runner_log'])
        __import__('shutil').rmtree(self.root / '.context')
        self.configure(1, self.rows(alpha=True, beta=True, gamma=True) + [{'domain': 'zeta', 'passed': True, 'aborted': False}])
        result = self.backend.execute(self.request, self.root)
        self.assertTrue(all(v == 'UNVERIFIED' for k, v in result['cases'].items() if k.startswith('blackbox:')))
        self.assertEqual(['zeta'], result['evidence']['unknown_domains'])
        __import__('shutil').rmtree(self.root / '.context')
        # an archive that this run did not announce is never credited; a stray newer one is ignored
        stray = self.root / '.context/test-runs/backend-coverage-merged-failed-99999999-999999-1/raw-v8'; stray.mkdir(parents=True)
        self.configure(1, self.rows(alpha=True, beta=True, gamma=True), archive=False)
        result = self.backend.execute(self.request, self.root)
        self.assertEqual('UNVERIFIED', result['cases']['coverage-threshold'])
        self.assertNotIn('99999999', self.npx_calls.read_text())  # the unannounced stray archive was never reported
        __import__('shutil').rmtree(self.root / '.context')
        # the frozen source is re-checked after the sweep
        self.configure(0, self.rows(alpha=True, beta=True, gamma=True))
        with patch.object(self.backend, 'source', side_effect=[self.request['source'], {'head': 'x', 'digest': 'changed'}]):
            result = self.backend.execute(self.request, self.root)
        self.assertTrue(all(v == 'UNVERIFIED' for k, v in result['cases'].items() if k != 'teardown'))
        self.assertFalse(result['complete']); self.assertFalse(result['source_unchanged'])


class GenericLifecycle(unittest.TestCase):
    def setUp(self):
        import deploy_test_process
        self.process = deploy_test_process
        self.temp = tempfile.TemporaryDirectory(prefix='generic-lifecycle-')
        self.root = Path(self.temp.name)
        self.process.CANCEL.clear()

    def tearDown(self):
        self.process.CANCEL.clear()
        self.temp.cleanup()

    def test_default_forced_kill_refuses_resume_even_after_group_is_gone(self):
        # The shell ignores TERM before exec, so a slow interpreter start under
        # load cannot let TERM land before the handler exists.
        with (self.root / 'forced.log').open('wb') as output:
            code, timed_out, cancelled, lingering = self.process.run_command(
                ['/bin/sh', '-c', "trap '' TERM; exec sleep 30"], cwd=self.root, env=os.environ.copy(),
                output=output, timeout=.2)
        self.assertEqual(-signal.SIGKILL, code)
        self.assertTrue(timed_out)
        self.assertFalse(cancelled)
        self.assertTrue(lingering, 'forced kill cannot authorize resume')

    def test_wedged_supervisor_is_bounded_and_descendants_remain_unverified(self):
        helper = self.root / 'deploy_test_supervisor.py'
        helper.write_text("import signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\ntime.sleep(30)\n")
        started = time.monotonic()
        with patch.object(self.process, '__file__', str(self.root / 'deploy_test_process.py')), \
                (self.root / 'wedged.log').open('wb') as output:
            code, timed_out, cancelled, lingering = self.process.run_command(
                ['true'], cwd=self.root, env=os.environ.copy(), output=output,
                timeout=.2, owned_lifecycle=True)
        self.assertLess(time.monotonic() - started, 15)
        self.assertEqual(-signal.SIGKILL, code)
        self.assertTrue(timed_out)
        self.assertFalse(cancelled)
        self.assertTrue(lingering)
        watchdog = cycle.read(self.root / 'wedged.log.process.json.watchdog.json')
        self.assertTrue(watchdog['supervisor_reaped'])
        self.assertFalse(watchdog['descendants_quiescent'])
        self.assertIn('descendants unverified', watchdog['reason'])

    def test_watchdog_evidence_error_keeps_cleanup_unknown(self):
        from unittest.mock import MagicMock
        process = MagicMock(pid=12345, returncode=-signal.SIGKILL)
        process.poll.return_value = None
        with patch.object(self.process.subprocess, 'Popen', return_value=process), \
                patch.object(self.process.time, 'monotonic', side_effect=[0, 14, 14]), \
                patch.object(Path, 'write_text', side_effect=OSError('evidence unavailable')):
            result = self.process.run_command(['true'], cwd=self.root, env=os.environ.copy(),
                                              output=io.BytesIO(), timeout=.2, owned_lifecycle=True)
        self.assertEqual((-signal.SIGKILL, True, False, True), result)
        process.kill.assert_called_once_with()

    def test_unsupported_owned_platform_refuses_before_launch(self):
        with patch.object(self.process.sys, 'platform', 'darwin'), \
                patch.object(self.process.subprocess, 'Popen',
                             side_effect=AssertionError('worker launched without ownership')) as launch, \
                (self.root / 'refused.log').open('wb') as output:
            with self.assertRaisesRegex(OSError, 'owned worker lifecycle requires Linux'):
                self.process.run_command(['true'], cwd=self.root, env=os.environ.copy(),
                                         output=output, timeout=1, owned_lifecycle=True)
            launch.assert_not_called()

    def test_nested_case_is_reaped_and_forced_owner_blocks_resume(self):
        child = self.root / 'child.py'
        worker_path = self.root / 'worker.py'
        ready = self.root / 'ready'
        child.write_text(
            "import os,signal,sys,time\nfrom pathlib import Path\n"
            "signal.signal(signal.SIGTERM,signal.SIG_IGN)\n"
            "Path(sys.argv[1]).write_text(str(os.getpid()))\ntime.sleep(30)\n")
        worker_path.write_text(
            "import sys,os,time\nfrom pathlib import Path\n"
            f"sys.path.insert(0,{str(ROOT / 'scripts')!r})\n"
            "import deploy_test_process as p\n"
            "with p.cancellation_handlers():\n"
            " with open(sys.argv[3],'wb') as output:\n"
            "  p.run_command([sys.executable,sys.argv[1],sys.argv[2]],cwd=Path.cwd(),"
            "env=os.environ.copy(),output=output,timeout=None)\n"
            " p.CANCEL.clear()\n time.sleep(.2)\n")
        with (self.root / 'outer.log').open('wb') as output:
            result = self.process.run_command(
                [sys.executable, str(worker_path), str(child), str(ready), str(self.root / 'inner.log')],
                cwd=self.root, env=os.environ.copy(), output=output,
                # The child sleeps 30 s, so this deadline always fires; it only has to outlast the
                # worker's startup and the child's ready marker (0.2 s, then 3 s, lost that race under load).
                timeout=5, owned_lifecycle=True)
        self.assertTrue(ready.exists())
        pid = int(ready.read_text())
        if Path(f'/proc/{pid}').exists():
            spec = importlib.util.spec_from_file_location('owned_cleanup_identity', ROOT / 'scripts/process-identity.py')
            identity = importlib.util.module_from_spec(spec); spec.loader.exec_module(identity)
            command_line = Path(f'/proc/{pid}/cmdline').read_bytes()
            self.assertIn(os.fsencode(str(child)), command_line)
            self.addCleanup(identity.main, ['process-identity.py', '--expect',
                identity.current_identity(pid), '--signal', 'KILL', str(pid)])
        print(json.dumps({'native_result': result, 'nested_child_exists': Path(f'/proc/{pid}').exists()}))
        self.assertTrue(result[1])
        self.assertFalse(Path(f'/proc/{pid}').exists(), 'nested session survived owner return')
        self.assertTrue(result[3], 'forced owner cannot authorize resume')
        receipt = cycle.read(self.root / 'outer.log.process.json')
        self.assertTrue(receipt['quiescent'])
        self.assertTrue(receipt['kill_sent'])

    def test_worker_cleanup_finishes_before_owner_returns(self):
        script = self.root / 'worker.py'
        marker = self.root / 'cleanup-finished'
        script.write_text(
            "import sys,os,time\nfrom pathlib import Path\n"
            f"sys.path.insert(0,{str(ROOT / 'scripts')!r})\n"
            "import deploy_test_process as p\n"
            "with p.cancellation_handlers():\n"
            " with open(sys.argv[2],'wb') as output:\n"
            "  p.run_command([sys.executable,'-c','import time;time.sleep(30)'],"
            "cwd=Path.cwd(),env=os.environ.copy(),output=output,timeout=None)\n"
            " p.CANCEL.clear()\n time.sleep(.2)\n Path(sys.argv[1]).write_text('done')\n")
        with (self.root / 'outer.log').open('wb') as output:
            code, timed_out, cancelled, lingering = self.process.run_command(
                [sys.executable, str(script), str(marker), str(self.root / 'inner.log')],
                cwd=self.root, env=os.environ.copy(), output=output, timeout=3,
                owned_lifecycle=True)
        self.assertEqual(code, 0)
        self.assertTrue(timed_out)
        self.assertFalse(lingering)
        self.assertEqual(marker.read_text(), 'done')


class SupervisorOrphanSettle(unittest.TestCase):
    """A suite child that is merely finishing when the suite exits is not an orphan; one that stays alive still is.

    Seen on the PR #1744 deploy: a structural suite passed (exit 0) while one fixture child was still winding down, so
    the supervisor flagged it, the receipt became UNVERIFIED with a lingering owner and no recovery path remained."""

    SCRIPTS = (ROOT / 'scripts/deploy_test_supervisor.py', ROOT / 'scripts/cloudbench-local-supervisor.py')

    def supervise(self, script, grandchild_seconds):
        with tempfile.TemporaryDirectory() as tmp:
            receipt = Path(tmp) / 'receipt.json'
            code = ("import subprocess,sys;subprocess.Popen([sys.executable,'-c','import time;time.sleep(%s)'],"
                    "start_new_session=True)" % grandchild_seconds)
            result = subprocess.run([sys.executable, str(script), '--receipt', str(receipt), '--', sys.executable, '-c', code],
                                    capture_output=True, text=True, timeout=60)
            return result.returncode, json.loads(receipt.read_text())

    def test_a_child_that_exits_within_the_settle_window_is_not_orphaned(self):
        for script in self.SCRIPTS:
            with self.subTest(script=script.name):
                returncode, process = self.supervise(script, 0.4)
                self.assertEqual((returncode, process['native_exit'], process['orphaned_children'], process['quiescent']),
                                 (0, 0, False, True))
                self.assertEqual(process['term_sent'], [])

    def test_a_child_that_outlives_the_suite_is_still_orphaned_and_terminated(self):
        for script in self.SCRIPTS:
            with self.subTest(script=script.name):
                returncode, process = self.supervise(script, 30)
                self.assertEqual((returncode, process['orphaned_children'], process['quiescent']), (78, True, True))
                self.assertEqual(len(process['term_sent']), 1)
# A benchmarks/local.py stand-in that leads the case's group (run-bench execs it) and
# keeps draining its runner/stack past the worker's ten-second TERM grace until the
# test releases it. Its markers are replaced atomically (no torn reads under load).
DRAINING_CONTROLLER = r"""
import json, os, random, signal, sys, time
from pathlib import Path
root, marker, owner_record = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3] == 'owner'
release = marker.parent / (marker.name + '.release')
def publish(path, text):
    staged = path.with_name(path.name + '.tmp')
    staged.write_text(text)
    os.replace(staged, path)
stop = []
signal.signal(signal.SIGTERM, lambda *_: stop.append(1))
if owner_record:
    run = root / '.context' / 'benchmarks' / f'{int(time.time())}-{os.getpid()}-{random.randrange(10000, 99999)}'
    run.mkdir(parents=True)
    publish(run / 'local-benchmark-owner.json', json.dumps({'run_id': run.name, 'state': 'running', 'pid': os.getpid()}))
publish(marker.parent / (marker.name + '.ready'), str(os.getpid()))
end = time.monotonic() + 120  # bounded: never outlive the test if nobody stops it
while not stop and time.monotonic() < end:
    time.sleep(.05)
while not release.exists() and time.monotonic() < end:  # its own cleanup, past the grace
    time.sleep(.05)
publish(marker, 'clean')
"""


class WorkerBenchmarkControllerKill(unittest.TestCase):
    """2026-11-05: the worker's case group leader was the benchmarks/local.py controller. Its
    ten-second group KILL raced the cycle's own; a KILLed controller skips the cleanup traps that
    stop its runner and isolated stack. A token-owned benchmark owner is left to the cycle's
    token-bound teardown; any other TERM-ignoring case keeps the existing KILL."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='worker-controller-')
        self.root = Path(self.temp.name) / 'worker'
        self.root.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'code').write_text('fixture')
        (self.root / '.git/info/exclude').write_text('.context/\n')
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=test', '-c',
                        'user.email=test@example.com', 'commit', '-qm', 'fixture'], check=True)
        self.marker = Path(self.temp.name) / 'controller-cleanup'
        self.release = self.marker.parent / (self.marker.name + '.release')
        self.pid = None
        cycle.CANCEL.clear()

    def tearDown(self):
        cycle.CANCEL.clear()
        self.release.touch()
        # Only the case this test started: the worker leaves a retained case unreaped, so
        # signal its pid only while its argv still names this test's marker (no reuse).
        if self.pid is not None:
            try:
                if str(self.marker).encode() in Path(f'/proc/{self.pid}/cmdline').read_bytes().split(b'\0'):
                    os.kill(self.pid, signal.SIGKILL)
            except (FileNotFoundError, ProcessLookupError):
                pass
        self.temp.cleanup()

    @staticmethod
    def alive(pid):
        try:
            state = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()[0]
        except (OSError, IndexError):
            return False
        return state not in ('Z', 'X')

    def run_cancelled(self, owner_record):
        ready = self.marker.parent / (self.marker.name + '.ready')
        recipe = {'cases': {'card': {'command': [sys.executable, '-c', DRAINING_CONTROLLER, str(self.root),
                                                 str(self.marker), 'owner' if owner_record else 'plain'],
                                     'aggregate': True}}}
        request = {'token': 'controller-' + ('owner' if owner_record else 'plain'), 'source': cycle.source(self.root),
                   'gate': 'bench-controller', 'checks': ['card'], 'skips': {}, 'phase': 'initial',
                   'worker_recipe': recipe}

        def cancel_when_ready():
            end = time.monotonic() + 60
            while not ready.exists() and time.monotonic() < end:
                time.sleep(.02)
            if ready.exists():
                self.pid = int(ready.read_text())
            cycle.CANCEL.set()  # the cycle's TERM reached this worker (always: never hang the worker)

        timer = threading.Thread(target=cancel_when_ready)
        with patch.dict(os.environ, {'DEPLOY_PIPELINE_LANE_TOKEN': 'cycle-request-token'}):
            timer.start()
            try:
                result = worker.execute(request, self.root)
            finally:
                timer.join()
        self.assertIsNotNone(self.pid, 'case never registered')
        return result['evidence']['card']

    def test_token_owned_controller_is_left_draining_for_cycle_teardown(self):
        row = self.run_cancelled(owner_record=True)
        # Still draining (held until released below): the worker did not KILL it.
        self.assertTrue(self.alive(self.pid), 'worker KILLed the draining benchmark controller')
        self.assertFalse(self.marker.exists())
        self.assertIsNone(row['native_exit'])
        self.assertEqual('UNVERIFIED', row['status'])
        self.assertTrue(row['cancelled']); self.assertTrue(row['lingering_group'])
        self.release.touch()
        end = time.monotonic() + 30
        while not self.marker.exists() and time.monotonic() < end:
            time.sleep(.05)
        self.assertEqual('clean', self.marker.read_text(), 'controller cleanup traps did not complete')

    def test_case_without_owned_benchmark_record_keeps_group_kill(self):
        row = self.run_cancelled(owner_record=False)
        self.assertEqual(-signal.SIGKILL, row['native_exit'])
        self.assertFalse(self.alive(self.pid))
        self.assertFalse(self.marker.exists())
        self.assertEqual('UNVERIFIED', row['status']); self.assertTrue(row['lingering_group'])


class FakeTilionListing:
    """Offline stand-in for Tilion GET /v1/sessions at the urllib boundary (no provider call)."""
    def __init__(self, *live_counts, status=200, body=None):
        self.live_counts=list(live_counts);self.status=status;self.body=body;self.requests=[]

    def open(self, _director, request, data=None, timeout=None):
        self.requests.append((request.full_url,request.get_method(),dict(request.header_items()),timeout))
        count=self.live_counts.pop(0) if len(self.live_counts)>1 else self.live_counts[0]
        body=self.body if self.body is not None else json.dumps(
            [{'session_id':f'sess-{i}','state':'running','created_at':1} for i in range(count)]).encode()
        status=self.status

        class Response:
            def __enter__(self):return self
            def __exit__(self,*_exc):return False
            def read(self,_limit=-1):return body
        response=Response();response.status=status
        return response


class CloudSharedProviderHeadroom(unittest.TestCase):
    """Two deploys and production share ONE 20-browser Tilion account: size smoke from its live usage."""
    KEY='fixture-tilion-key-not-real'

    def setUp(self):
        import deploy_test_cloud as cloud
        self.cloud=cloud;self.now=[1_000.0];self.sleeps=[]
        env={'CLOUDBENCH_BROWSER_PROVIDER':'tilion','TILION_API_KEY':self.KEY,
             'TILION_BASE_URL':'https://tilion.fixture.invalid',
             'CLOUDBENCH_PROVIDER_LIMITS_FILE':str(ROOT/'scripts/cloudbench-provider-limits.json')}
        for patcher in (patch.dict(os.environ,env),patch('time.time',side_effect=lambda:self.now[0]),
                        patch('time.sleep',side_effect=self.sleep)):
            patcher.start();self.addCleanup(patcher.stop)
        # Test the account ceiling independently of the invoking deploy's width.
        os.environ.pop('DEPLOY_CLOUD_CONCURRENCY', None)

    def sleep(self, seconds):
        self.sleeps.append(seconds);self.now[0]+=seconds

    def width(self, listing, count=17):
        stderr=io.StringIO()
        with patch('urllib.request.OpenerDirector.open',new=lambda director,request,data=None,timeout=None:
                   listing.open(director,request,data,timeout)), contextlib.redirect_stderr(stderr):
            try:
                return self.cloud.campaign_width([f'task-{i}' for i in range(count)]),stderr.getvalue()
            finally:
                self.assertNotIn(self.KEY,stderr.getvalue())

    def test_live_account_sessions_narrow_the_smoke_width(self):
        listing=FakeTilionListing(5)  # production + another deploy hold five browsers right now
        width,output=self.width(listing)
        self.assertEqual(11,width)  # floor(20 * 0.8 - 5), not the solo registry cap 16
        url,method,headers,timeout=listing.requests[0]
        self.assertEqual(('https://tilion.fixture.invalid/v1/sessions','GET'),(url,method))
        self.assertEqual('Bearer '+self.KEY,headers['Authorization'])
        self.assertLessEqual(timeout,15)
        self.assertIn('5 live account-wide of 20 (20% reserved for production)',output)
        self.assertEqual([],self.sleeps)

    def test_idle_account_still_honours_the_registry_cap_and_request(self):
        self.assertEqual(16,self.width(FakeTilionListing(0))[0])
        self.assertEqual(3,self.width(FakeTilionListing(0),count=3)[0])

    def test_second_deploy_waits_while_the_first_holds_the_pool_then_starts(self):
        # Deploy A's 16 smoke browsers are live; production keeps its four-browser reserve.
        listing=FakeTilionListing(16,17,9)
        width,output=self.width(listing)
        self.assertEqual(7,width)
        self.assertEqual(3,len(listing.requests))
        self.assertEqual([30.0,30.0],self.sleeps)
        self.assertEqual(2,output.count('⏳ waiting for shared provider headroom'))
        self.assertIn('16 live of 20, 20% reserved for production',output)

    def test_full_account_until_the_deadline_refuses_before_any_launch(self):
        launched=[]
        with patch.object(self.cloud,'run_command',side_effect=lambda *a,**k:launched.append(a)):
            with self.assertRaises(ValueError) as refused:
                self.width(FakeTilionListing(16))
        self.assertIn('cannot admit one smoke task by the deadline',str(refused.exception))
        self.assertEqual([],launched)
        self.assertAlmostEqual(900.0,sum(self.sleeps))
        self.assertTrue(all(0<pause<=30 for pause in self.sleeps))

    def test_unreadable_listing_never_admits_and_refuses_at_the_deadline(self):
        for listing in (FakeTilionListing(0,status=500),FakeTilionListing(0,body=b'<html>'),
                        FakeTilionListing(0,body=b'{"sessions":[]}')):
            with self.subTest(status=listing.status,body=listing.body):
                self.now[0]=1_000.0;self.sleeps.clear()
                with self.assertRaises(ValueError) as refused:
                    self.width(listing)
                self.assertIn('live usage unreadable',str(refused.exception))

    def test_devbox_without_tilion_credential_is_unmeasured_not_silent(self):
        import cloudbench_provider_headroom as headroom
        probes=headroom.live_probes(environ={},env_file=Path(tempfile.mkdtemp(prefix='no-env-'))/'.env')
        self.assertIsNone(probes['tilion-browser-sessions']())
        capacity=runpy.run_path(str(ROOT/'scripts/cloudbench-provider-capacity.py'))
        registry=capacity['for_browser_provider'](capacity['load_registry'](),'tilion')
        stderr=io.StringIO()
        width=headroom.admitted_width(17,registry,probes=probes,deadline=0,stream=stderr)
        self.assertEqual(16,width)
        self.assertIn('live account usage UNMEASURED',stderr.getvalue())

    def test_plain_http_base_url_never_receives_the_key(self):
        import cloudbench_provider_headroom as headroom
        with self.assertRaises(headroom.HeadroomUnavailable):
            headroom.tilion_live_sessions(self.KEY,'http://tilion.fixture.invalid',
                                          opener=lambda *_a:self.fail('plain-HTTP request was sent'))


class FixtureEnvironmentIsolation(unittest.TestCase):
    def test_cloud_request_custody_is_local_and_parent_environment_is_restored(self):
        parent = '/tmp/fixture-parent/attempts/34/phase/gate/request.json'
        with patch.dict(os.environ, {'DEPLOY_GATE_REQUEST': parent, 'DEPLOY_CLOUD_CONCURRENCY': '4'}):
            result = unittest.TestResult()
            Cloud('test_cloud_cli_gets_only_active_cases_and_frozen_ref').run(result)
            self.assertTrue(result.wasSuccessful(), result.errors + result.failures)
            self.assertEqual(parent, os.environ['DEPLOY_GATE_REQUEST'])
            self.assertEqual('4', os.environ['DEPLOY_CLOUD_CONCURRENCY'])

    def test_headroom_fixture_preserves_parent_width_and_explicit_limits(self):
        with patch.dict(os.environ, {'DEPLOY_CLOUD_CONCURRENCY': '4'}):
            result = unittest.TestResult()
            CloudSharedProviderHeadroom('test_live_account_sessions_narrow_the_smoke_width').run(result)
            self.assertTrue(result.wasSuccessful(), result.errors + result.failures)
            self.assertEqual('4', os.environ['DEPLOY_CLOUD_CONCURRENCY'])
            fixture = CloudSharedProviderHeadroom()
            fixture.setUp()
            try:
                with patch.dict(os.environ, {'DEPLOY_CLOUD_CONCURRENCY': '4'}):
                    self.assertEqual(4, fixture.width(FakeTilionListing(5))[0])
            finally:
                fixture.doCleanups()
            self.assertEqual('4', os.environ['DEPLOY_CLOUD_CONCURRENCY'])


class FakeCerebrasProbe:
    """Offline stand-in for one 1-token Cerebras completion at the opener boundary."""
    def __init__(self, *answers):
        self.answers=list(answers);self.requests=[]

    def __call__(self, request, timeout):
        self.requests.append((request.full_url,request.get_method(),dict(request.header_items()),json.loads(request.data)))
        status,headers=self.answers.pop(0) if len(self.answers)>1 else self.answers[0]
        if status!=200:
            import urllib.error
            raise urllib.error.HTTPError(request.full_url,status,'limited',headers,io.BytesIO(b'{}'))

        class Response:
            def __enter__(self):return self
            def __exit__(self,*_exc):return False
            def read(self,_limit=-1):return b'{}'
        response=Response();response.status=status;response.headers=headers
        return response


class CerebrasRatchetHeadroom(unittest.TestCase):
    """The latency ratchet waits on the Cerebras org quota that every deploy and production spend."""
    KEY='fixture-cerebras-key-not-real'

    def setUp(self):
        import cloudbench_provider_headroom as headroom
        from fractions import Fraction
        self.headroom=headroom;self.reserve=Fraction(1,5);self.now=[0.0];self.sleeps=[]

    def sleep(self, seconds):
        self.sleeps.append(seconds);self.now[0]+=seconds

    def wait(self, probe, deadline=600):
        out,err=io.StringIO(),io.StringIO()
        with contextlib.redirect_stderr(err):
            ready=self.headroom.wait_for_cerebras(self.KEY,reserve=self.reserve,deadline=deadline,opener=probe,
                                                  clock=lambda:self.now[0],sleep=self.sleep,stream=out)
        self.assertNotIn(self.KEY,out.getvalue()+err.getvalue())
        return ready,out.getvalue(),err.getvalue()

    @staticmethod
    def window(remaining, limit=300, reset=17):
        return {'x-ratelimit-limit-requests-minute':str(limit),'x-ratelimit-remaining-requests-minute':str(remaining),
                'x-ratelimit-reset-requests-minute':str(reset),'x-ratelimit-remaining-requests-day':'0'}

    def test_ample_shared_quota_starts_immediately_with_one_tiny_probe(self):
        probe=FakeCerebrasProbe((200,self.window(240)))
        ready,out,_=self.wait(probe)
        self.assertTrue(ready);self.assertEqual([],self.sleeps)
        url,method,headers,body=probe.requests[0]
        self.assertEqual(('https://api.cerebras.ai/v1/chat/completions','POST'),(url,method))
        self.assertEqual('Bearer '+self.KEY,headers['Authorization'])
        self.assertEqual(1,body['max_completion_tokens']);self.assertEqual('qwen-3.8-27b',body['model'])
        self.assertIn('requests-minute 240/300',out)  # a daily window never holds a per-minute ratchet

    def test_other_deploys_draining_the_minute_window_hold_the_ratchet_until_reset(self):
        probe=FakeCerebrasProbe((200,self.window(12,reset=23)),(429,{'retry-after':'9'}),(200,self.window(290)))
        ready,out,_=self.wait(probe)
        self.assertTrue(ready);self.assertEqual([23.0,9.0],self.sleeps)
        self.assertIn('requests-minute 12 of 300 remaining',out);self.assertIn('probe answered 429',out)

    def test_quota_still_short_at_the_deadline_fails_closed(self):
        ready,_,err=self.wait(FakeCerebrasProbe((429,{})),deadline=150)
        self.assertFalse(ready);self.assertAlmostEqual(150.0,sum(self.sleeps))
        self.assertTrue(all(0<pause<=60 for pause in self.sleeps))
        self.assertIn('FAIL: Cerebras shared quota still short at the deadline',err)

    def test_unexpected_probe_status_is_not_headroom(self):
        ready,_,err=self.wait(FakeCerebrasProbe((401,{})),deadline=40)
        self.assertFalse(ready);self.assertIn('answered HTTP 401',err)

    def test_a_rejected_credential_stops_at_once_but_a_provider_error_is_retried(self):
        # 2026-11-08: the probe answered 403 for an hour while the semantic gate waited on it.
        ready,_,err=self.wait(FakeCerebrasProbe((403,{})),deadline=3600)
        self.assertFalse(ready);self.assertEqual([],self.sleeps)
        self.assertIn('cannot measure the shared Cerebras quota',err)
        ready,_,err=self.wait(FakeCerebrasProbe((503,{})),deadline=90)
        self.assertFalse(ready);self.assertTrue(self.sleeps)

    def test_cli_without_any_cerebras_key_reports_unmeasured(self):
        env={k:v for k,v in os.environ.items() if not k.startswith('CEREBRAS')}
        out=io.StringIO()
        with patch.dict(os.environ,env,clear=True), \
             patch.object(self.headroom,'BACKEND_ENV_FILE',Path(tempfile.gettempdir())/'missing-provider-headroom.env'), \
             patch.object(self.headroom,'wait_for_cerebras',side_effect=AssertionError('probed without a key')), \
             contextlib.redirect_stdout(out):
            self.assertEqual(0,self.headroom.main(['cerebras-wait','--timeout-seconds','0']))
        self.assertIn('UNMEASURED',out.getvalue())

    def test_cli_prefers_a_dedicated_ratchet_key_and_fails_closed_on_timeout(self):
        seen=[]
        with patch.dict(os.environ,{'CEREBRAS_RATCHET_API_KEY':'dedicated','CEREBRAS_API_KEY':'shared'}), \
             patch.object(self.headroom,'wait_for_cerebras',side_effect=lambda key,**kw:seen.append((key,kw['reserve'])) or False):
            self.assertEqual(1,self.headroom.main(['cerebras-wait','--timeout-seconds','5']))
        self.assertEqual([('dedicated',self.reserve)],seen)  # registry production_reserve_fraction 0.2


class StoppedPreStackIsolation(unittest.TestCase):
    """Versioned pre-stack receipts exercise the complete native admission consumer."""
    DRIVER_SHA256 = '1958de1798e8fdc46bd2081c1d530e9574c0957db80857d367802904f5ad5521'

    def setUp(self):
        import base64
        import gzip
        import hashlib
        import deploy_test_native_cleanup as native
        self.native = native
        spec = importlib.util.spec_from_file_location('native_cycle_fixtures', ROOT / 'scripts/tests/deploy-test-cycle.test.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        fixture = module.Cycle()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.addCleanup(fixture.tearDown)
        self.root = fixture.root
        # The fixture uses the actual versioned driver, not a mock of its SHA.
        # Driver changes require a newly reviewed before-stack contract.
        self.driver = (ROOT / 'scripts/cloudbench-run.sh').read_bytes()
        self.assertEqual(self.DRIVER_SHA256, hashlib.sha256(self.driver).hexdigest())
        target = self.root / 'scripts/cloudbench-run.sh'
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(self.driver)
        subprocess.run(['git', '-C', str(self.root), 'add', 'scripts/cloudbench-run.sh'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=test', '-c',
                        'user.email=test@example.com', 'commit', '-qm', 'reviewed startup driver'], check=True)
        head = subprocess.check_output(['git', '-C', str(self.root), 'rev-parse', 'HEAD'], text=True).strip()
        self.state, self.failure, self.paths, self.proof, self.gate, self.packet = fixture.isolated_campaign_state()
        def replace(value):
            if isinstance(value, dict): return {k: replace(v) for k, v in value.items()}
            if isinstance(value, list): return [replace(v) for v in value]
            return head if value == 'a' * 40 else value
        self.state, self.proof = replace(self.state), replace(self.proof)
        for path in (self.root / '.context').rglob('*.json'):
            try: value = json.loads(path.read_text())
            except ValueError: continue
            cycle.write(path, replace(value))
        self.fleet = (Path(self.proof['campaign']).parent.parent / 'runs'
                      / f'20261103-080440-{module.FIXTURE_CONTROLLER_PID_BASE + 1}')
        self.output = self.fleet / self.gate['name']
        self.output.mkdir(exist_ok=True)
        self.owner = cycle.read(self.fleet / '_batch/lifecycle.json')['fleet_owner_token']
        self.token = self.owner + '-0'
        self.machine, self.volume = 'old-machine', 'old-volume'
        (self.output / '.cid').write_text('clone ' + self.machine + '\n')
        cycle.write(self.output / 'runtime-evidence.owner.json',
                    dict(version=1, machine_id=self.machine, run_token=self.token))
        self.payload = self.output / 'cloudbench-boot-payload.json.gz'
        self.payload.write_bytes(gzip.compress(json.dumps(dict(version=1, files={
            'cloudbench-run.sh': base64.b64encode(self.driver).decode()})).encode()))
        self.log = self.output / 'remote-logs/cloudbench-driver.log'
        self.log.parent.mkdir()
        self.log.write_text(
            f'RUNSTAMP-{self.token}\n[cloudbench] verified checkout {head}\n'
            '[cloudbench 20:01:29] STEP git_sync\n[cloudbench 20:01:29] STEP env_decode\n'
            '[cloudbench 20:01:30] STEP dep_sync\n'
            '[cloudbench] FATAL: warm image/volume JavaScript dependencies do not match the checked-out ref\n'
            '[cloudbench 20:01:31] FATAL: cloudbench dependency synchronization failed\n'
            f'::CLOUDBENCH-DONE:: token={self.token} exit=1\n'
            '[boot 20:01:31] driver cleanup evidence interrupt_status=0 cleanup_ack=1\n')
        self.rows = cycle.read(self.packet)['rows']
        self.machine_row = next(r for r in self.rows if r['expected_machine'] == self.machine and r['kind'] == 'machine')
        self.volume_row = next(r for r in self.rows if r['expected_machine'] == self.machine and r['kind'] == 'volume')
        self.raw_machine = dict(id=self.machine, state='stopped', config=dict(
            env=dict(REF=head, CLOUDBENCH_RUN_TOKEN=self.token), mounts=[dict(volume=self.volume, path='/data')]))
        self.raw_volume = dict(id=self.volume, state='created', attached_machine_id=self.machine)
        self.machine_row['metadata'].update(state='stopped')
        self.volume_row['metadata'].update(state='created', attached_machine_id=self.machine)
        self.proof['execution_quiescence'][self.machine]['startup_rejection_log'] = str(self.log)
        self.reseal()

    def reseal(self):
        import hashlib
        for row, data in ((self.machine_row, self.raw_machine), (self.volume_row, self.raw_volume)):
            path = self.root / '.context' / ('raw-' + row['kind'] + '.json')
            cycle.write(path, data)
            row.update(raw_response=str(path), response_sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        cycle.write(self.packet, dict(endpoint_origin='https://api.machines.dev', app='fixture', rows=self.rows))
        receipt = cycle.read(self.paths['receipt'])
        receipt['native_cleanup_reference']['result_sha256'] = cycle.sha_file(self.paths['adapter'])
        receipt['cleanup_owner']['native_cleanup_reference'] = receipt['native_cleanup_reference']
        cycle.write(self.paths['receipt'], receipt)
        self.state['attempts'][-1]['results'][0] = receipt
        self.proof.update(owner=copy.deepcopy(receipt['cleanup_owner']),
                          receipt_sha256=cycle.sha_file(self.paths['receipt']),
                          worker_result_sha256=cycle.sha_file(self.paths['adapter']))
        self.proof['files'] = {str(p): cycle.sha_file(p) for base in (
            self.fleet.parent, Path(self.proof['campaign']), self.root / '.git/cloudbench-fleet-audits',
            self.root / '.git/cloudbench-fleet-ownership') for p in base.rglob('*') if p.is_file()}
        for path in (self.paths['receipt'].parent / 'request.json', self.fleet.parent.parent / 'cli.log',
                     self.packet, Path(self.machine_row['raw_response']), Path(self.volume_row['raw_response']),
                     self.root / 'scripts/cloudbench-run.sh'):
            self.proof['files'][str(path)] = cycle.sha_file(path)

    def validate(self):
        receipt = cycle.read(self.paths['receipt'])
        return self.native.validate(receipt, receipt['cleanup_owner'], self.proof)

    def test_stopped_pre_stack_launch_preserves_original_failures_and_cleanup_debt(self):
        before = copy.deepcopy(self.state)
        original = self.paths['receipt'].read_bytes()
        cycle.reconcile(self.state, self.failure['id'], self.proof)
        entry = next(iter(self.state['reconciled_owners'].values()))
        self.assertFalse(entry['credit_granted'])
        self.assertFalse(entry['cleanup_complete'])
        self.assertTrue(entry['obligations_preserved'])
        self.assertEqual('isolated-validation', entry['purpose'])
        self.assertEqual(before['attempts'], self.state['attempts'])
        self.assertEqual(before['failures'], self.state['failures'])
        self.assertEqual(original, self.paths['receipt'].read_bytes())
        self.assertEqual({self.machine: self.volume, 'machine1': 'vol_fixture'}, entry['excluded_resources'])
        self.assertEqual([], cycle.retained_owners(self.state, [self.gate['name']]))
        self.assertEqual({'UNVERIFIED'}, set(cycle.read(self.paths['receipt'])['cases'].values()))
        self.assertTrue((self.root / '.git/cloudbench-fleet-ownership' / self.owner).is_dir())

    def test_stopped_pre_stack_still_refuses_a_live_original_controller(self):
        # The fixture controller PID sits above every kernel pid_max, so a host process can never
        # hold it (RCA 4fda5d31). The native refusal itself must still fire when one is live.
        pid = int(self.fleet.name.rsplit('-', 1)[-1])
        self.assertGreater(pid, 4194304)  # Linux PID_MAX_LIMIT
        actual = self.native.subprocess.check_output
        def processes(args, *a, **kw):
            return f'999999 {pid} S\n' if args[:1] == ['ps'] else actual(args, *a, **kw)
        before, original = copy.deepcopy(self.state), self.paths['receipt'].read_bytes()
        with patch.object(self.native.subprocess, 'check_output', side_effect=processes):
            with self.assertRaisesRegex(ValueError, 'old controller still active'):
                cycle.reconcile(self.state, self.failure['id'], self.proof)
        self.assertEqual(before, self.state)
        self.assertEqual(original, self.paths['receipt'].read_bytes())

    def test_stopped_pre_stack_rejects_unsafe_provider_or_current_identity(self):
        cases = ('started', 'unknown', 'current-token', 'source', 'mount', 'forged-raw-state', 'raw-token',
                 'detached-volume', 'wrong-volume-state', 'quarantine-missing')
        originals = copy.deepcopy((self.rows, self.raw_machine, self.raw_volume))
        registry = self.root / '.git/cloudbench-fleet-ownership' / self.owner
        for case in cases:
            with self.subTest(case=case):
                self.rows, self.raw_machine, self.raw_volume = copy.deepcopy(originals)
                self.machine_row = next(r for r in self.rows if r['expected_machine'] == self.machine and r['kind'] == 'machine')
                self.volume_row = next(r for r in self.rows if r['expected_machine'] == self.machine and r['kind'] == 'volume')
                if case in ('started', 'unknown'): self.machine_row['metadata']['state'] = case
                if case == 'current-token': self.machine_row['metadata']['source_binding']['CLOUDBENCH_RUN_TOKEN'] = 'new-request-0'
                if case == 'source': self.machine_row['metadata']['source_binding']['REF'] = 'f' * 40
                if case == 'mount': self.raw_machine['config']['mounts'][0]['volume'] = 'foreign'
                if case == 'forged-raw-state': self.raw_machine['state'] = 'started'
                if case == 'raw-token': self.raw_machine['config']['env']['CLOUDBENCH_RUN_TOKEN'] = 'foreign'
                if case == 'detached-volume': self.volume_row['metadata']['attached_machine_id'] = None
                if case == 'wrong-volume-state': self.volume_row['metadata']['state'] = 'restoring'
                if case == 'quarantine-missing': registry.rename(registry.with_name('held'))
                self.reseal()
                try:
                    with self.assertRaises(ValueError): self.validate()
                finally:
                    if case == 'quarantine-missing': registry.with_name('held').rename(registry)

    def test_stopped_pre_stack_rejects_unknown_driver_and_incomplete_terminal_receipts(self):
        import base64
        import gzip
        original_log, original_payload = self.log.read_bytes(), self.payload.read_bytes()
        driver_path = self.root / 'scripts/cloudbench-run.sh'
        for case in ('driver-tamper', 'later-stack-step', 'missing-ack', 'missing-done', 'wrong-done-token', 'unknown-driver'):
            with self.subTest(case=case):
                self.log.write_bytes(original_log); self.payload.write_bytes(original_payload)
                driver_path.write_bytes(self.driver)
                if case in ('driver-tamper', 'unknown-driver'):
                    changed = self.driver + b'\n# unreviewed driver\n'
                    self.payload.write_bytes(gzip.compress(json.dumps(dict(version=1, files={
                        'cloudbench-run.sh': base64.b64encode(changed).decode()})).encode()))
                    if case == 'unknown-driver':
                        driver_path.write_bytes(changed)
                        subprocess.run(['git', '-C', str(self.root), 'add', 'scripts/cloudbench-run.sh'], check=True)
                        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=test', '-c',
                                        'user.email=test@example.com', 'commit', '-qm', 'unreviewed driver'], check=True)
                        head = subprocess.check_output(['git', '-C', str(self.root), 'rev-parse', 'HEAD'], text=True).strip()
                        receipt = cycle.read(self.paths['receipt'])
                        old_head = receipt['source']['head']
                        def replace(value):
                            if isinstance(value, dict): return {k: replace(v) for k, v in value.items()}
                            if isinstance(value, list): return [replace(v) for v in value]
                            return head if value == old_head else value
                        self.state, self.proof = replace(self.state), replace(self.proof)
                        for path in (self.root / '.context').rglob('*.json'):
                            try: value = json.loads(path.read_text())
                            except ValueError: continue
                            cycle.write(path, replace(value))
                        self.raw_machine['config']['env']['REF'] = head
                        self.machine_row['metadata']['source_binding']['REF'] = head
                        self.log.write_bytes(original_log.replace(old_head.encode(), head.encode()))
                if case == 'later-stack-step': self.log.write_bytes(original_log + b'[cloudbench 20:01:32] STEP stack\n')
                if case == 'missing-ack': self.log.write_bytes(original_log.replace(b'cleanup_ack=1', b'cleanup_ack=0'))
                if case == 'missing-done': self.log.write_bytes(original_log.replace(b'::CLOUDBENCH-DONE::', b'not-DONE'))
                if case == 'wrong-done-token': self.log.write_bytes(original_log.replace(b'::CLOUDBENCH-DONE:: token=', b'::CLOUDBENCH-DONE:: token=wrong'))
                self.reseal()
                expected = 'unreviewed pre-stack driver' if case == 'unknown-driver' else ('driver payload changed' if case == 'driver-tamper' else 'positive terminal boundary')
                with self.assertRaisesRegex(ValueError, expected): self.validate()


if __name__=='__main__': unittest.main()
