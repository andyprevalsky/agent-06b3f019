#!/usr/bin/env python3
"""Run the actual worker/transport with tiny subprocesses, no services."""
from pathlib import Path
from datetime import datetime, timezone
import copy
import json
import subprocess
import sys
import tempfile
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


if __name__=='__main__': unittest.main()
