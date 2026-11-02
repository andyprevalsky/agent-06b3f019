#!/usr/bin/env python3
"""Run the actual worker/transport with tiny subprocesses, no services."""
from pathlib import Path
from datetime import datetime, timezone
import copy
import contextlib
import importlib.util
import io
import shlex
import shutil
import signal
import threading
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
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

    def test_failure_does_not_stop_other_cases(self):
        result=worker.execute(self.request,self.root)
        self.assertEqual({'first':'FAIL','second':'PASS'},result['cases'])
        self.assertTrue(result['complete'])
        self.assertEqual(1,result['evidence']['first']['native_exit'])

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
        cycle.focused_plan(state,plan,{'source':state['source'],'gates':{'gate':{
            'command':gate['command'],'checks':['first'],
            'worker_recipe':{'cases':{'first':{'command':[sys.executable,'-c','pass']}}}}}})
        focused=cycle.execute(cycle.records(plan,state)[0],state,
                              self.coordinator/'.context/coordinator',self.coordinator)
        self.assertEqual({'first':'PASS'},focused['cases'])
        cycle.advance(state,[focused])
        self.assertEqual('failed-gates',state['phase'])
        full=cycle.execute(cycle.records(plan,state)[0],state,
                           self.coordinator/'.context/coordinator',self.coordinator)
        self.assertEqual({'first':'FAIL','second':'PASS'},full['cases'])
        cycle.advance(state,[full])
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
        import deploy_test_cloud as cloud
        import cloudbench_execution_provenance as provenance
        self.cloud=cloud;self.provenance=provenance
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

    def test_cancelled_case_does_not_become_skipped(self):
        path=self.fleet/'failing/cloudbench-run.json';document=cycle.read(path)
        document['tasks'][0]['benchmark_status']='CANCELLED';cycle.write(path,document)
        self.assertEqual('UNVERIFIED',self.collect()[0]['failing'])

    def test_cloud_cli_gets_only_active_cases_and_frozen_ref(self):
        self.request.update(checks=['passing'],skips={'failing':{'disposition':'external / waived'}})
        with patch.object(self.cloud,'source',return_value=self.request['source']), \
             patch.object(self.cloud,'run_command',return_value=(0,False,False,False)) as launch, \
             patch.object(self.cloud,'collect',return_value=({'passing':'PASS'},{},True,'native-run')):
            result=self.cloud.execute(self.request,self.root)
        argv=launch.call_args.args[0]
        self.assertEqual(['bash','scripts/run-bench','passing','--wait','--ref','a'*40],argv)
        self.assertNotIn('failing',argv)
        self.assertEqual('1',launch.call_args.kwargs['env']['CLOUDBENCH_SKIP_LOCAL_PATCH'])
        self.assertTrue(result['complete'])


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
                          '--concurrency','16','--ref','a'*40],argv)
        self.assertNotIn('--wait',argv);self.assertTrue(result['complete'])


FAKE_CLI = """#!/usr/bin/env python3
import json, os, sys
calls = os.environ['FAKE_DVB_CALLS']; config = json.load(open(os.environ['FAKE_DVB_CONFIG']))
with open(calls, 'a') as stream: stream.write(json.dumps(sys.argv[1:]) + '\\n')
key = sys.argv[2]
if key == 'list' and '--all' not in sys.argv: key = 'list_page1'  # native CLI: one page unless --all
reply = config.get(key, {'rc': 1, 'stdout': {}, 'stderr': 'unsupported'})
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
        self.assertEqual({'first': 'PASS', 'second': 'PASS'}, result['cases'])
        listing = self.calls_of('list')
        self.assertEqual(1, len(listing)); self.assertIn('--all', listing[0])
        # the pre-fix argv sees only the first page: never resolve a host from a partial inventory, never send
        __import__('shutil').rmtree(self.coordinator / '.context'); self.calls.unlink()
        with patch.object(self.boxes, 'LIST_ARGV', ['threads', 'list', '--json']):
            result = self.run_adapter()
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()))
        self.assertEqual('thread_inventory_incomplete', result['reason']); self.assertEqual([], self.calls_of('send'))

    def test_happy_path_returns_the_exact_native_document_with_bindings(self):
        self.configure(reply=self.reply(inline=False)); self.attach(self.native_bytes)
        result = self.run_adapter()
        self.assertEqual({'first': 'PASS', 'second': 'PASS'}, result['cases'])
        receipt = result.pop('transport_receipt')
        self.assertEqual(self.native, result)  # byte-exact native document, nothing reshaped
        self.assertEqual(('boxes-thread', 'ph-worker', self.host, 'turn-1', 'peer_1', 'tok-1', 0, 4242),
                         (receipt['transport'], receipt['worker_thread'], receipt['worker_host'], receipt['turn_id'],
                          receipt['message_id'], receipt['request_token'], receipt['native_exit'], receipt['pgid']))
        self.assertEqual(self.binding['python'], receipt['remote_python'])
        self.assertEqual(__import__('hashlib').sha256(self.native_bytes.encode()).hexdigest(), receipt['native_sha256'])
        self.assertEqual(cycle.digest(self.native), receipt['canonical_sha256'])
        self.assertEqual(1, len(self.calls_of('send')))
        send = self.calls_of('send')[0]
        self.assertEqual('tok-1', send[send.index('--idempotency-key') + 1])
        prompt = Path(send[send.index('--prompt-file') + 1]).read_text()
        self.assertIn(f"{self.binding['python']} {self.root.resolve()}/scripts/deploy_test_worker.py --root {self.root.resolve()}", prompt)
        self.assertIn('DEPLOY_GATE_REQUEST="$PWD/request.json" DEPLOY_GATE_RESULT="$PWD/result.json"', prompt)
        self.assertIn('dvb-onbox threads message --to ph-control --attach "$PWD/result.json" --attach "$PWD/stderr.log"', prompt)
        self.assertIn("--idempotency-key tok-1-result", prompt)
        self.assertTrue(receipt['result_source'].startswith('attachment:')); self.assertEqual('ph-control', receipt['coordinator_thread'])
        self.assertEqual(self.native_bytes, (self.coordinator / '.context/deploy-boxes' / __import__('hashlib').sha256(b'tok-1').hexdigest() / 'native-result.json').read_text())
        self.assertLessEqual(len(prompt.encode()), self.boxes.MAX_PROMPT_BYTES)
        self.assertIn('worker diagnostic', Path(receipt['stderr_log']).read_text())
        # the coordinator's own validator accepts the relayed document with the adapter's exit
        from deploy_test_result import validate
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
                    self.assertEqual({'first': 'PASS', 'second': 'PASS'}, result['cases'])
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
        self.request['worker_recipe']['cases']['first']['env'] = {'PAD': 'x' * 40000}
        self.calls.unlink()
        result = self.run_adapter()
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()))
        self.assertIn('send bound', result['reason']); self.assertEqual([], self.calls_of('send'))

    def test_resume_rereads_the_same_turn_without_a_second_send(self):
        first = self.run_adapter(); self.assertEqual('PASS', first['cases']['first'])
        (self.coordinator / '.context/deploy-boxes').rename(self.coordinator / '.context/first')
        __import__('shutil').copytree(self.coordinator / '.context/first', self.coordinator / '.context/deploy-boxes')
        self.calls.unlink()
        again = self.run_adapter()
        self.assertEqual({'first': 'PASS', 'second': 'PASS'}, again['cases'])
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
        self.assertEqual({'first': 'PASS', 'second': 'PASS'}, result['cases'])
        self.assertEqual([], self.calls_of('send')); self.assertEqual('turn-7', result['transport_receipt']['turn_id'])
        # an indeterminate send whose assignment cannot be found is never repeated: re-read until the deadline
        state = cycle.read(directory / 'state.json'); state.update(turn_id=None, deadline_at=time.time() + 0.3)
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

    def test_timeout_or_cancel_is_unverified_and_names_the_remote_cleanup_owner(self):
        self.configure(reply=self.reply(), wait={'rc': 0, 'stdout': self.wrap({'turnId': 'turn-1'}, status='running')})
        result = self.run_adapter(deadline=0.2)
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
                result = self.run_adapter(deadline=0.3)
                self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()))
                __import__('shutil').rmtree(self.coordinator / '.context')
        self.configure(reply=self.reply())
        with patch.object(self.boxes, 'MAX_RECEIPT_BYTES', 10):
            result = self.run_adapter(deadline=0.3)
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

    def test_send_bound_is_exactly_32_kib_and_never_truncates(self):
        self.request.update(token='tok-2', worker_recipe={**self.recipe, 'cases': {**self.recipe['cases'],
                            'first': {**self.recipe['cases']['first'], 'env': {'PAD': ''}}}})
        self.assertEqual(32768, self.boxes.MAX_PROMPT_BYTES)
        for size, expected in ((32768, 'PASS'), (32769, 'UNVERIFIED')):
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
        self.assertIn('send bound', result['reason']); self.assertEqual(1, len(self.calls_of('send')))

    def test_failed_cd_in_the_worker_script_exits_nonzero_and_is_unverified(self):
        binding = {**self.binding, 'worker_root': str(self.root.resolve() / 'missing')}
        prompt = self.boxes.build_prompt(self.request, binding)
        script = prompt.split('```sh\n', 1)[1].split('\n```', 1)[0]
        self.assertTrue(script.startswith('set -eu'))
        proc = subprocess.run(['bash', '-c', script], capture_output=True, text=True)
        self.assertEqual(3, proc.returncode); self.assertIn('DEPLOY_GATE_WORKER_EXIT 3', proc.stdout)
        self.assertEqual([], self.calls_of('message'))  # nothing was attached or sent after the failed cd
        self.configure(reply=proc.stdout)
        result = self.run_adapter(deadline=0.3)
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values()))

    def big_native(self, token):
        self.request['token'] = token
        self.request['worker_recipe']['cases']['first']['command'] = [sys.executable, '-c', "print('y' * 70000)"]
        __import__('shutil').rmtree(self.root / '.context', ignore_errors=True)
        self.native_bytes = json.dumps(worker.execute(self.request, self.root), indent=2, allow_nan=False) + '\n'
        self.assertGreater(len(self.native_bytes.encode()), 64 * 1024)

    def test_large_result_passes_via_attachment_or_hash_matching_inline_only(self):
        self.big_native('tok-big')
        self.configure(reply=self.reply(inline=False)); self.attach(self.native_bytes)
        result = self.run_adapter()
        self.assertEqual({'first': 'PASS', 'second': 'PASS'}, result['cases'])
        self.assertTrue(result['transport_receipt']['result_source'].startswith('attachment:'))
        __import__('shutil').rmtree(self.coordinator / '.context'); (self.attachments / 'result--0123456789abcdef.json').unlink()
        self.configure(reply=self.reply(inline=True))  # inline-only large reply that hash-matches
        result = self.run_adapter()
        self.assertEqual({'first': 'PASS', 'second': 'PASS'}, result['cases'])
        self.assertEqual('inline-markers', result['transport_receipt']['result_source'])

    def test_wrong_hash_attachment_or_truncated_inline_without_attachment_is_unverified(self):
        self.configure(reply=self.reply(inline=False)); self.attach(self.native_bytes.replace('"PASS"', '"FAIL"', 1))
        result = self.run_adapter(deadline=0.3)
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values())); self.assertEqual('attachment_missing', result['reason'])
        __import__('shutil').rmtree(self.coordinator / '.context')
        truncated = self.reply().replace('DEPLOY_GATE_RESULT_JSON_END\n', '')
        self.configure(reply=truncated)
        result = self.run_adapter(deadline=0.3)
        self.assertTrue(all(v == 'UNVERIFIED' for v in result['cases'].values())); self.assertEqual('attachment_missing', result['reason'])

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


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


local_runner = load('controller_local', 'scripts/run-cloudbench-controller-local.py')


class LocalController(unittest.TestCase):
    def test_complete_documented_inventory_and_registration(self):
        text = (ROOT / '.claude/commands/deploy.md').read_text()
        section = text.split('## Step 4cb:', 1)[1].split('## Step 4c:', 1)[0]
        block = section.split('```bash\n')[2].split('```', 1)[0]
        commands = []
        for line in block.replace('\\\n', '').splitlines():
            line = line.strip()
            if line.startswith('if ['):
                break
            if line and not line.startswith('#'):
                commands.append(shlex.split(line))
        self.assertEqual([shlex.split(command) for _, command in local_runner.CASES], commands)
        self.assertEqual(len(commands), 12)
        self.assertEqual(len({name for name, _ in local_runner.CASES}), 12)
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



if __name__=='__main__': unittest.main()
