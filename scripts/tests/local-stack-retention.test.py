#!/usr/bin/env python3
"""Native owner-watch boundary with disposable processes and stub DB teardown."""
import ast
import copy
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]

class Retention(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.context = Path(self.temp.name)
        self.owner = subprocess.Popen(['sleep', '60'])
        self.start = Path(f'/proc/{self.owner.pid}/stat').read_text().rsplit(') ', 1)[1].split()[19]
        self.stack = None

    def tearDown(self):
        if self.stack and self.stack.poll() is None:
            self.stack.terminate()
            self.stack.wait(timeout=5)
        if self.owner.poll() is None:
            self.owner.kill()
        self.owner.wait(timeout=5)
        self.temp.cleanup()

    def write(self, name, value):
        path = self.context / name
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(value))
        temporary.replace(path)

    def launch(self, mutate=None, owner_start=None):
        # Source-only stops before any service/DB startup. Only the real watcher runs.
        script = '''source "$ROOT/scripts/run.sh" >/dev/null
            finish() { stop_stack_owner_watch; dropdb fixture_db; exit 0; }
            trap finish TERM
            start_stack_owner_watch
            echo $$ > "$BENCHMARK_CONTEXT_DIR/ready"
            while :; do sleep 0.1; done'''
        binary = self.context / 'bin'
        binary.mkdir()
        drop = binary / 'dropdb'
        drop.write_text('#!/bin/sh\necho "$*" >> "$BENCHMARK_CONTEXT_DIR/dropped"\n')
        drop.chmod(0o755)
        env = {**os.environ, 'ROOT': str(ROOT), 'PATH':str(binary)+':'+os.environ['PATH'],
               'CONDUCTOR_PORT':'61920', 'CONDUCTOR_WORKSPACE_NAME':'retention-fixture',
               'RUN_SH_SOURCE_ONLY':'true', 'BENCHMARK_ISOLATED_RUN':'true',
               'BENCHMARK_RUN_ID':'fixture-run', 'BENCHMARK_CONTEXT_DIR':str(self.context),
               'RUN_SH_OWNER_PID':str(self.owner.pid), 'RUN_SH_OWNER_START':self.start if owner_start is None else owner_start,
               'RUN_STACK_CLEANUP_TOKEN':'stack-token'}
        self.output = (self.context/'stack.log').open('w')
        self.addCleanup(self.output.close)
        self.stack = subprocess.Popen(['bash','-c',script],cwd=ROOT,env=env,
                                      stdout=self.output,stderr=subprocess.STDOUT)
        self.wait_for(lambda:(self.context/'ready').exists())
        self.write('local-stack-owner.json', dict(version=1,run_id='fixture-run',pid=self.stack.pid,token='stack-token'))
        self.record = dict(version=1,run_id='fixture-run',state='failed_retained',pid=123,
                           token='bench-token',receipt=str(self.context/'benchmark-cleanup-bench-token.status'),
                           controller_pid=self.owner.pid,controller_start=self.start)
        (self.context/'benchmark-cleanup-bench-token.status').write_text('version=1\ntoken=bench-token\nstate=failed\n')
        if mutate:
            mutate()
        if self.record is not None:
            self.write('local-benchmark-owner.json',self.record)
        self.owner.kill();self.owner.wait(timeout=5)

    def wait_for(self, predicate):
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            if predicate():return
            time.sleep(.05)
        self.fail('fixture did not reach expected boundary')

    def test_explicit_retention_survives_owner_exit_then_revocation_tears_down(self):
        self.launch()
        time.sleep(1.5)  # At least one native one-second watch iteration after owner exit.
        self.assertIsNone(self.stack.poll(),'watcher destroyed explicitly retained recovery stack')
        self.assertFalse((self.context/'dropped').exists(),'watcher dropped retained DB')
        self.record['state']='cleanup_verified'
        self.write('local-benchmark-owner.json',self.record)
        self.wait_for(lambda:self.stack.poll() is not None)
        self.assertEqual((self.context/'dropped').read_text().strip(),'fixture_db')

    def test_ordinary_orphan_still_tears_down(self):
        self.launch(lambda:setattr(self,'record',None))
        self.wait_for(lambda:self.stack.poll() is not None)
        self.assertTrue((self.context/'dropped').exists())

    def test_conflicting_retention_cannot_protect_an_orphan(self):
        self.launch(lambda:self.record.update(controller_start='wrong'))
        self.wait_for(lambda:self.stack.poll() is not None)
        self.assertTrue((self.context/'dropped').exists())

    def assert_invalid_owner_tears_down(self, mutate):
        self.launch(mutate)
        self.wait_for(lambda:self.stack.poll() is not None)
        self.assertTrue((self.context/'dropped').exists())

    def test_empty_incarnation_cannot_grant_retention(self):
        # Off Linux the current producer cannot capture /proc ticks. Absence
        # must not invent exact-incarnation authority on those platforms.
        self.launch(lambda:self.record.update(controller_start=''),owner_start='')
        self.wait_for(lambda:self.stack.poll() is not None)
        self.assertTrue((self.context/'dropped').exists())

    def test_missing_controller_incarnation_cannot_grant_retention(self):
        self.assert_invalid_owner_tears_down(lambda:self.record.pop('controller_start'))

    def test_wrong_controller_pid_does_not_retain(self):
        self.assert_invalid_owner_tears_down(lambda:self.record.update(controller_pid=os.getpid()))

    def test_wrong_run_does_not_retain(self):
        self.assert_invalid_owner_tears_down(lambda:self.record.update(run_id='other-run'))

    def test_wrong_stack_token_does_not_retain(self):
        self.assert_invalid_owner_tears_down(lambda:self.write('local-stack-owner.json',
             dict(version=1,run_id='fixture-run',pid=self.stack.pid,token='stale-token')))

    def test_wrong_stack_pid_does_not_retain(self):
        self.assert_invalid_owner_tears_down(lambda:self.write('local-stack-owner.json',
             dict(version=1,run_id='fixture-run',pid=self.owner.pid,token='stack-token')))

    def test_wrong_receipt_scope_does_not_retain(self):
        self.assert_invalid_owner_tears_down(lambda:self.record.update(receipt=str(self.context/'unrelated')))

    def test_missing_cleanup_receipt_does_not_revoke_explicit_authority(self):
        self.launch(lambda:(self.context/'benchmark-cleanup-bench-token.status').unlink())
        time.sleep(1.5)
        self.assertIsNone(self.stack.poll())
        self.assertFalse((self.context/'dropped').exists())

    def test_only_native_owner_check_requires_absent_retention(self):
        source=(ROOT/'scripts/run.sh').read_text()
        self.assertEqual(source.count('if stack_owner_process_gone'),1)
        self.assertIn('if stack_owner_process_gone && ! stack_has_retained_recovery_authority; then',source)

    def test_producer_records_exact_controller_identity(self):
        tree=ast.parse((ROOT/'agents/benchmarks/local.py').read_text())
        cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='LocalBenchmarkOwner')
        method=copy.deepcopy(next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='record'))
        method.decorator_list=[]
        captured={}
        namespace=dict(os=os,_own_process_start_ticks=lambda:'actual-start',
                       _write_owner_record=lambda path,value:captured.update(value))
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),str(ROOT/'agents/benchmarks/local.py'),'exec'),namespace)
        instance=types.SimpleNamespace(stack=types.SimpleNamespace(context_dir=self.context,run_id='fixture-run'),
             process=self.owner,native_identity='child-start',token='bench-token',receipt=self.context/'receipt',signum=None)
        namespace['record'](instance,'failed_retained')
        self.assertEqual(captured.get('controller_pid'),os.getpid())
        self.assertEqual(captured.get('controller_start'),'actual-start')

if __name__=='__main__':unittest.main()
