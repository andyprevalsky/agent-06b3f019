#!/usr/bin/env python3
"""Offline bound status inputs and actual exact-path guest status projection."""
import copy
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
M=runpy.run_path(str(ROOT/'scripts/original600-status.py'))


def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value));path.chmod(0o600)
    return path


class Status(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.root.chmod(0o700)
        self.run=self.root/'operator/run';self.run.mkdir(parents=True,mode=0o700)
        self.ref='a'*40;self.mid='1234567890abcd';self.epoch=100.5
        self.env=self.root/'complete-agents.env';self.env.write_text('COMPLETE=fixture\nFLY_API_TOKEN=FlyV1 fixture\n');self.env.chmod(0o600)
        self.cfg=write(self.run.parent/'config.private.json',dict(schema='original600-controller-runner-v1',allowed=True,
            source_ref=self.ref,source_root=str(self.root),started_at_epoch=self.epoch,source_files={}))
        self.auth=write(self.run/'authority.private.json',dict(source_ref=self.ref,app='navi-whisper-lux-bench',
            output_directory=str(self.run/'export'),protected_machines=['00000000000000'],
            env_files=dict(agents=dict(path=str(self.env),sha256=M['digest'](self.env.read_bytes())))))
        write(self.run/'controller.identity.json',dict(machine=self.mid,instance='instance-fixture',source_ref=self.ref,
              authority_sha256=M['digest'](self.auth.read_bytes())))
        write(self.run/'export/disposable-controller.ownership.json',dict(schema='cloudbench-disposable-controller-ownership-v1',
              authority_sha256=M['digest'](self.auth.read_bytes()),machine=dict(id=self.mid,instance_id='instance-fixture')))
        self.caller=write(self.run/'caller.json',dict(source_ref=self.ref,authority_sha256=M['digest'](self.auth.read_bytes()),
            epoch=self.epoch,identity_path='/tmp/gate/repo/.context/original600-supervisor.fixture.json'))

    def test_bound_explicit_complete_env_works_without_checkout_dotenv_and_refuses_drift(self):
        value=M['binding'](self.run)
        self.assertEqual(value['agents_env'],self.env)
        self.assertFalse((self.root/'agents/.env').exists())
        identity_path=self.run/'controller.identity.json';identity=json.loads(identity_path.read_text())
        write(identity_path,dict(identity,machine='ffffffffffffff'))
        with self.assertRaisesRegex(ValueError,'sealed controller'):M['binding'](self.run)
        write(identity_path,dict(identity,authority_sha256='0'*64))
        with self.assertRaisesRegex(ValueError,'sealed authority changed'):M['binding'](self.run)
        write(identity_path,identity)
        self.assertEqual(M['binding'](self.run,agents_env=self.env)['credential_sha256'],M['digest'](self.env.read_bytes()))
        wrong=self.root/'other.env';wrong.write_text('FLY_API_TOKEN=other\n');wrong.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'complete agents input changed'):M['binding'](self.run,agents_env=wrong)
        caller=json.loads(self.caller.read_text());caller['epoch']+=1;write(self.caller,caller)
        with self.assertRaisesRegex(ValueError,'epoch mismatch'):M['binding'](self.run)
        # The reader uses target-ref Git bytes, not whatever helper happens to
        # be on the monitor checkout's PATH or in a different source tree.
        (self.root/'scripts').mkdir()
        for name in ['run-original600-controller.py','cloudbench-original-volume-capture.py']:
            (self.root/'scripts'/name).write_bytes((ROOT/'scripts'/name).read_bytes())
        subprocess.run(['git','init','-q',str(self.root)],check=True)
        subprocess.run(['git','-C',str(self.root),'add','scripts'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=fixture','-c','user.email=fixture@example.test',
                        '-c','commit.gpgsign=false','commit','-qm','source fixture'],check=True)
        ref=subprocess.check_output(['git','-C',str(self.root),'rev-parse','HEAD'],text=True).strip()
        source=self.root/'scripts/run-original600-controller.py';expected=M['digest'](source.read_bytes())
        parser=M['bound_source'](self.root,ref,source.name,expected)
        self.assertEqual(parser['token_from_agents'](self.env.read_bytes()),'FlyV1 fixture')
        native=self.root/'scripts/cloudbench-original-volume-capture.py'
        self.assertIn('Fly',M['bound_source'](self.root,ref,native.name,M['digest'](native.read_bytes())))
        source.write_bytes(source.read_bytes()+b'\n# changed after binding\n')
        with self.assertRaisesRegex(ValueError,'source bytes changed'):
            M['bound_source'](self.root,ref,source.name,expected)


    def test_continuation_status_verifies_original_config_and_successor_chain(self):
        original=json.loads(self.cfg.read_bytes())
        original['authority_template']=str(self.root/'old-authority')
        write(self.cfg,original)
        original_sha=M['digest'](self.cfg.read_bytes())
        write(self.run.parent/'attempt-start.safe.json',dict(source_ref=self.ref,config_sha256=original_sha))
        previous=self.run.parent/'previous-run';previous.mkdir(mode=0o700)
        failure=dict(path=str(self.root/'positive-failure'),sha256='e'*64,
                     prior_output=str(previous),successor_output=str(self.run))
        provenance=dict(original_config_path=str(self.cfg),original_config_sha256=original_sha,
                        original_started_at_epoch=self.epoch,workload_source_ref=self.ref,
                        host_operator_source_ref='b'*40,host_runner_sha256='c'*64,prelaunch_failure=failure)
        config=write(self.root/'continuation/config.private.json',dict(original,
                     authority_template=str(self.root/'new-authority'),host_operator_provenance=provenance))
        write(self.run/'host-operator-provenance.json',provenance)
        pointer=write(previous/'host-launch-successor.json',dict(schema='original600-host-launch-successor-v1',
                     evidence=failure,config_path=str(config),config_sha256=M['digest'](config.read_bytes()),
                     original_started_at_epoch=self.epoch,host_operator_source_ref='b'*40))
        value=M['binding'](self.run,config)
        self.assertEqual(value['mode'],'REMOTE')
        self.assertEqual(value['payload']['epoch'],self.epoch)
        self.assertEqual(value['source_ref'],self.ref)
        before=config.read_bytes()
        write(config,dict(json.loads(before),remote_env={'changed':'task-input'}))
        with self.assertRaises(ValueError):M['binding'](self.run,config)
        config.write_bytes(before)
        saved=pointer.read_bytes();write(pointer,dict(json.loads(saved),config_sha256='0'*64))
        with self.assertRaises(ValueError):M['binding'](self.run,config)
        pointer.write_bytes(saved)
        write(self.run/'host-operator-provenance.json',dict(provenance,original_started_at_epoch=self.epoch+1))
        with self.assertRaises(ValueError):M['binding'](self.run,config)

    def test_actual_guest_exact_path_projection_preserves_unknown_and_unique_infra(self):
        repo=self.root/'guest';repo.mkdir()
        subprocess.run(['git','init','-q',str(repo)],check=True)
        (repo/'source').write_text('fixture')
        subprocess.run(['git','-C',str(repo),'add','source'],check=True)
        subprocess.run(['git','-C',str(repo),'-c','user.name=fixture','-c','user.email=fixture@example.test',
                        '-c','commit.gpgsign=false','commit','-qm','fixture'],check=True)
        ref=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()
        scope={'__name__':'offline_status_payload'};exec(M['REMOTE'],scope)
        payload=dict(machine=self.mid,source_ref=ref,epoch=self.epoch,
                     identity_path='/tmp/gate/repo/.context/original600-supervisor.fixture.json')
        with patch.dict(os.environ,FLY_MACHINE_ID=self.mid):
            self.assertEqual(scope['guest_status'](payload,repo,'boot-fixture')['status'],'SUPERVISOR_NOT_PUBLISHED')
            write(repo/'.context/original600-supervisor.fixture.json',dict(schema='original600-supervisor-identity-v1',
                  machine=self.mid,source_ref=ref,epoch=self.epoch,pid=812))
            self.assertEqual(scope['guest_status'](payload,repo,'boot-fixture')['status'],'SUMMARY_NOT_PUBLISHED')
            ns=hashlib.sha256((float(self.epoch).hex()+':boot-fixture').encode()).hexdigest()[:24]
            path=repo/'.context/benchmarks/campaigns'/('campaign-qualified600-'+ns+'-812')/'summary.json'
            summary=dict(total_jobs=600,campaign_id=path.parent.name,e2e_started_at_epoch=self.epoch,jobs=[dict(job_id='one',status='failed',attempts=[
                dict(status='failed',finished_at='original-time',infra_failure=True),
                dict(status='failed',finished_at='retry-time',infra_failure=True)]),
                dict(job_id='two',status='failed',attempts=[]),dict(job_id='three',status='running',attempts=[]),
                dict(job_id='four',status='failed',attempts=[dict(status='failed',finished_at='original-time',infra_failure=None)])]
                +[dict(job_id='queued-'+str(i),status='queued',attempts=[]) for i in range(596)])
            write(path,summary)
            # A nearby unrelated campaign must never be scanned/read.
            write(repo/'.context/benchmarks/campaigns/campaign-unrelated/summary.json',dict(jobs=[dict(secret='unrelated')]))
            result=scope['guest_status'](payload,repo,'boot-fixture')
            self.assertEqual(result['status'],'SUMMARY')
            counts=result['summary'];self.assertEqual(counts['canonical_infra_affected_jobs'],1)
            self.assertEqual(counts['failed_jobs_without_terminal_attempt'],1)
            self.assertEqual(counts['attempt_records'],3);self.assertEqual(counts['terminal_attempts'],3)
            self.assertEqual(counts['jobs_with_unknown_terminal_infra'],1)
            self.assertEqual(counts['terminal_attempt_records_with_unknown_infra'],1)
            self.assertFalse(counts['benchmark_success_inferred'])
            for changed in [dict(campaign_id='unrelated'),dict(e2e_started_at_epoch=self.epoch+1),dict(total_jobs=599)]:
                write(path,dict(summary,**changed))
                with self.assertRaises(ValueError):scope['guest_status'](payload,repo,'boot-fixture')
            write(path,summary)
            with self.assertRaises(ValueError):scope['guest_status'](dict(payload,identity_path='/private/arbitrary.json'),repo,'boot-fixture')
            with self.assertRaises(ValueError):scope['guest_status'](dict(payload,epoch=self.epoch+1),repo,'boot-fixture')

    def test_cancelled_and_unfinished_exact_true_infra_count_without_terminal_credit(self):
        scope={'__name__':'offline_status_payload'};exec(M['REMOTE'],scope)
        jobs=[dict(job_id='cancelled',status='cancelled',attempts=[
            dict(status='cancelled',finished_at=None,infra_failure=True),
            dict(status='cancelled',finished_at='cancel-time',infra_failure=True)]),
            dict(job_id='unfinished',status='running',attempts=[dict(status='running',infra_failure=True)]),
            dict(job_id='not-bool',status='cancelled',attempts=[
                dict(status='cancelled',infra_failure=1),dict(status='cancelled',infra_failure='true')])]
        jobs += [dict(job_id='queued-'+str(i),status='queued',attempts=[]) for i in range(597)]
        result=scope['project'](dict(total_jobs=600,jobs=jobs))
        self.assertEqual(result['canonical_infra_affected_jobs'],2)
        self.assertEqual(result['attempt_records'],5)
        self.assertEqual(result['terminal_attempts'],0)
        self.assertEqual(result['terminal_attempt_records_with_unknown_infra'],0)
        self.assertEqual(result['jobs_with_unknown_terminal_infra'],0)
        self.assertEqual(result['job_statuses'],dict(cancelled=2,running=1,queued=597))
        self.assertFalse(result['benchmark_success_inferred'])

    def test_actual_remote_entrypoint_decodes_payload_and_reports_guest_mismatch(self):
        import base64
        payload=dict(machine=self.mid,source_ref=self.ref,epoch=self.epoch,
                     identity_path='/tmp/gate/repo/.context/original600-supervisor.fixture.json')
        # Execute the exact production -S/-c body, including __main__. A wrong
        # guest identity returns UNKNOWN before Git or any other external call.
        result=subprocess.run(['python3','-S','-c',M['REMOTE'],
                               base64.b64encode(json.dumps(payload).encode()).decode()],
                              env=dict(os.environ,FLY_MACHINE_ID='ffffffffffffff'),
                              capture_output=True,text=True,timeout=3)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stderr,'')
        value=json.loads(result.stdout)
        self.assertEqual(value['status'],'UNKNOWN')
        self.assertEqual(value['error'],'ValueError')
        self.assertEqual(value['machine'],self.mid)
        self.assertEqual(value['source_ref'],self.ref)
        self.assertEqual(value['original_epoch'],self.epoch)

    def test_one_native_exec_is_readonly_and_unknown_envelopes_do_not_fake_summary(self):
        value=M['binding'](self.run);calls=[]
        result=dict(status='SUPERVISOR_NOT_PUBLISHED',machine=self.mid,source_ref=self.ref,original_epoch=self.epoch)
        class API:
            def api(inner,method,path,body,timeout):
                calls.append((method,path,body,timeout))
                return dict(stdout=json.dumps(result),stderr='',exit_code=0)
        actual=M['observe'](API(),value)
        self.assertEqual(actual['status'],'SUPERVISOR_NOT_PUBLISHED');self.assertEqual(len(calls),1)
        self.assertEqual(calls[0][:2],('POST','/machines/'+self.mid+'/exec'))
        import shlex
        argv=shlex.split(calls[0][2]['cmd']);self.assertEqual(argv[:3],['python3','-S','-c'])
        self.assertEqual(argv[3],M['REMOTE'])
        result['machine']='ffffffffffffff'
        with self.assertRaises(ValueError):M['observe'](API(),value)
        class Failed:
            def api(inner,*args,**kwargs):return dict(exit_code=1,stderr='fixture failure')
        self.assertEqual(M['observe'](Failed(),value)['status'],'TRANSPORT_UNKNOWN')

    def test_local_terminal_or_unpublished_controller_requires_no_credential_or_provider(self):
        (self.run/'controller.identity.json').unlink()
        self.assertEqual(M['binding'](self.run)['mode'],'CONTROLLER_NOT_PUBLISHED')
        write(self.run/'terminal.json',dict(source_ref=self.ref,status='FAILED_BEFORE_PROVIDER_DISPATCH'))
        value=M['binding'](self.run)
        self.assertEqual(value['mode'],'LOCAL_TERMINAL')
        self.assertEqual(value['terminal']['status'],'FAILED_BEFORE_PROVIDER_DISPATCH')
        result=subprocess.run(['python3',str(ROOT/'scripts/run-original600-controller.py'),'--status','--run-dir',str(self.run)],cwd='/',capture_output=True,text=True,timeout=3)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)['provider_calls'],0)
        self.assertEqual(json.loads(result.stdout)['mode'],'LOCAL_TERMINAL')


if __name__=='__main__':unittest.main()
