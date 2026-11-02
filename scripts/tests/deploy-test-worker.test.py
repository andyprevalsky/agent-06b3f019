#!/usr/bin/env python3
"""Run the actual worker/transport with tiny subprocesses, no services."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

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

    def tearDown(self):
        cycle.CANCEL.clear()
        self.temp.cleanup()

    def test_failure_does_not_stop_other_cases(self):
        result=worker.execute(self.request,self.root)
        self.assertEqual({'first':'FAIL','second':'PASS'},result['cases'])
        self.assertTrue(result['complete'])
        self.assertEqual(1,result['evidence']['first']['native_exit'])

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
              'case_protocol':True,'worker_recipe':self.recipe,'result_transport':'stdout',
              'command':[sys.executable,str(ROOT/'scripts/deploy_test_worker.py'),
                         '--root',str(self.root),'--stdio']}
        plan={'source':self.request['source'],'gates':[
            {'name':'quick','quick':True,'category':'eslint','checks':['lint'],'command':['true']},gate]}
        state=cycle.initialize(plan,self.root);state['phase']='initial'
        result=cycle.execute(gate,state,self.root/'.context/coordinator',self.root)
        self.assertEqual({'first':'FAIL','second':'PASS'},result['cases'])
        self.assertTrue(result['complete'])
        self.assertEqual(1,len(cycle.failed_cases(state,[result])))

    def test_partial_stdio_result_preserves_executed_peer_but_blocks_unknown(self):
        self.recipe['cases']['first']['command']=[sys.executable,'-c','raise SystemExit(7)']
        gate={'name':'gate','worker':'isolated-test','checks':['first','second'],
              'case_protocol':True,'worker_recipe':self.recipe,'result_transport':'stdout',
              'command':[sys.executable,str(ROOT/'scripts/deploy_test_worker.py'),
                         '--root',str(self.root),'--stdio']}
        plan={'source':self.request['source'],'gates':[
            {'name':'quick','quick':True,'category':'eslint','checks':['lint'],'command':['true']},gate]}
        state=cycle.initialize(plan,self.root);state['phase']='initial'
        result=cycle.execute(gate,state,self.root/'.context/coordinator',self.root)
        self.assertEqual({'first':'UNVERIFIED','second':'PASS'},result['cases'])
        failures=cycle.failed_cases(state,[result])
        self.assertEqual(1,len(failures))
        self.assertFalse(failures[0]['complete'])

    def test_wrong_recipe_digest_is_rejected(self):
        from deploy_test_result import validate
        result=worker.execute(self.request,self.root);result['recipe_digest']='wrong'
        with self.assertRaisesRegex(ValueError,'recipe changed'):
            validate(result,self.request,1)


if __name__=='__main__': unittest.main()
