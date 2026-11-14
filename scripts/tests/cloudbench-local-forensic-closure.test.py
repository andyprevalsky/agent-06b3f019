#!/usr/bin/env python3
"""Actual local custody -> shared native validator -> zero-credit receipt."""
import base64
import hashlib
import json
import os
from pathlib import Path
import runpy
import socket
import subprocess
import tempfile
import unittest

ROOT=Path(os.environ.get('R64_SOURCE_ROOT',Path(__file__).resolve().parents[2]))
class LocalClosure(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.out=self.root/'receipts';self.out.mkdir(mode=0o700)
        subprocess.run(['git','init','-q',str(self.root)],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','fixture'],check=True)
        self.source=subprocess.check_output(['git','-C',str(self.root),'rev-parse','HEAD'],text=True).strip()
        self.owner='a'*32;self.runid='20261029-055405-950305';self.mid='8577919c4eee78';self.vid='vol_original';self.name='cloudbench-original';self.app='navi-whisper-lux-bench'
        self.registry=self.root/'.git/cloudbench-fleet-ownership'/self.owner
        self.audit=self.root/'.git/cloudbench-fleet-audits'/self.owner
        self.run=self.root/'.context/fleet/runs'/self.runid
        self.M=runpy.run_path(str(ROOT/'scripts/cloudbench-local-forensic-closure.py'))
        self.M['C']['pid_birth_state']=lambda *a:'absent'
        self.write(self.registry/'meta',f'version=2\napp={self.app}\nfleet_owner_token={self.owner}\nhost={socket.gethostname()}\npid=99999999\npid_start=original-birth\nrun_id={self.runid}\nworkspace_root={self.root}\nruns_root={self.root}/.context/fleet/runs\naudit_dir={self.audit}\ncleanup_policy=retain\n')
        (self.registry/'clones').mkdir()
        self.write(self.registry/'guest-cleanup-unconfirmed','')
        self.write(self.registry/'disposable-resources-v1',self.owner+'\n'+self.app+'\n')
        self.write(self.audit/'meta',f'fleet_owner_token={self.owner}\nrun_id={self.runid}\napp={self.app}\nstatus=incomplete\n')
        self.write(self.audit/'expected-fresh'/self.name,f'clone_name={self.name}\nsource_machine_id=683e47df5094d8\n')
        self.write(self.audit/'fresh'/self.name,f'version=1\nfleet_owner_token={self.owner}\nrun_id={self.runid}\napp={self.app}\nclone_name={self.name}\nsource=fresh-clone\nsource_machine_id=683e47df5094d8\nmachine_id={self.mid}\nvolume_id={self.vid}\ndisposition=destroyed-provider-retained\n')
        self.write(self.audit/'by-machine-id'/self.mid,self.name+'\n')
        for n in ('owned-clones.ids','owned-clones.names'):self.write(self.audit/n,'')
        for kind,ident in [('machine',self.mid),('volume',self.vid)]:self.write(self.registry/f'disposable-delete-{kind}-{ident}.json',dict(app=self.app,identifier=ident,kind=kind,owner=self.owner))
        self.machine=dict(id=self.mid,name=self.name,instance_id='original-instance',region='iad',created_at='2026-10-29T05:54:35Z',config={'image':'image@sha256:original'},state='destroyed')
        self.volume=dict(id=self.vid,name='cloudbench_data',region='iad',created_at='2026-10-29T05:54:34Z',size_gb=40,encrypted=True,state='pending_destroy',attached_machine_id=None)
        h=hashlib.sha256(json.dumps([self.mid,self.machine['instance_id'],self.machine['config']],sort_keys=True,separators=(',',':')).encode()).hexdigest()
        self.fence=self.root/'.git/cloudbench-native-effect-fences'/self.owner/self.runid/self.mid/'destroy'/h
        self.write(self.fence/'intent.json',dict(operation='destroy',machine=self.machine));self.write(self.fence/'ack.json',{'ok':True})
        self.write(self.audit/'volume-backups'/self.vid/'verified.json',dict(owner=self.owner,run_id=self.runid,app=self.app,machine=self.mid,volume=self.vid,native=self.volume))
        self.write(self.run/'_batch/lifecycle.json',dict(status='failed',fleet_owner_token=self.owner,run_id=self.runid,controller_exit_code=1,audit_sha256=''))
        self.write(self.run/'execution-provenance.json',dict(base_sha=self.source,workspace_patch_sha256='none',config={'values':{'inventory_max_stale_seconds':'600'}}))
        self.write(self.run/'_batch/benches.json',[{'name':'task'}]);self.write(self.run/'execution-task-matrix.json',{'tasks':[{'name':'task'}]});self.write(self.run/'task/.cid','clone '+self.mid+'\n')
        self.cleanup=self.run/'_batch/disposable-cleanup.json';self.write(self.cleanup,dict(schema='disposable-cleanup-v1',owner=self.owner,guest_cleanup_missing=True,runtime_evidence_missing=False,successful_runtime_inferred=False))
    def write(self,p,value):
        p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value) if not isinstance(value,str) else value)
    def api(self,mutate=None):
        test=self
        class API:
            app=test.app;base='https://api.machines.dev'
            calls=[]
            def api(self,method,path,timeout,observer):
                self.calls.append((method,path));test.assertEqual(method,'GET')
                v={'name':test.app} if path=='' else test.machine if path=='/machines/'+test.mid else test.volume
                if mutate:v=mutate(path,dict(v))
                observer(method,path,200,json.dumps(v).encode());return v
        return API()
    def test_actual_observer_preserves_failed_latches_and_terminal_retention(self):
        before={str(p):p.read_bytes() for p in self.registry.rglob('*') if p.is_file()}
        api=self.api();path=self.M['observe'](self.registry,self.source,api,self.out);value=json.loads(path.read_text())
        self.assertEqual(self.M['verify'](path)['status'],'HISTORICAL_NATIVE_OWNERSHIP_PHYSICALLY_TERMINAL');self.assertEqual(len(api.calls),3);self.assertTrue(value['physical_resources_terminal']);self.assertFalse(value['physical_resources_absent'])
        for key in ['claims_released','guest_cleanup_confirmed','runtime_sealed','benchmark_success_inferred']:self.assertIs(value[key],False)
        self.assertEqual(before,{str(p):p.read_bytes() for p in self.registry.rglob('*') if p.is_file()})
    def test_unknown_live_or_reincarnated_resources_refuse_publication(self):
        for field,value in [('state','started'),('instance_id','replacement'),('state','unknown')]:
            with self.subTest(field=field):
                with self.assertRaises(ValueError):self.M['observe'](self.registry,self.source,self.api(lambda p,v:dict(v,**{field:value}) if p.startswith('/machines/') else v),self.out)
                self.assertEqual(list(self.out.glob('local-forensic-observation-*')),[])
    def test_large_observation_verifies_without_relaxing_other_reads(self):
        self.machine['config']['padding']='x'*850000
        digest=hashlib.sha256(json.dumps([self.mid,self.machine['instance_id'],self.machine['config']],sort_keys=True,separators=(',',':')).encode()).hexdigest()
        replacement=self.fence.parent/digest
        self.fence.rename(replacement);self.fence=replacement
        self.write(self.fence/'intent.json',dict(operation='destroy',machine=self.machine))
        receipt=self.M['observe'](self.registry,self.source,self.api(),self.out)
        self.assertGreater(receipt.stat().st_size,1048576)
        self.assertEqual(self.M['verify'](receipt)['status'],'HISTORICAL_NATIVE_OWNERSHIP_PHYSICALLY_TERMINAL')
        with self.assertRaises(ValueError):self.M['read'](receipt)

    def test_missing_forged_incomplete_and_nonboolean_custody_refuse(self):
        paths=[self.fence/'ack.json',self.audit/'by-machine-id'/self.mid,self.cleanup]
        for path in paths:
            old=path.read_bytes()
            for bad in [b'{}',b'{"runtime_evidence_missing":0}']:
                path.write_bytes(bad)
                with self.assertRaises((ValueError,KeyError)):self.M['prepare'](self.registry,self.source)
            path.write_bytes(old)
        oldmeta=(self.registry/'meta').read_bytes()
        (self.registry/'meta').write_bytes(oldmeta.replace(socket.gethostname().encode(),b'foreign-host'))
        with self.assertRaises(ValueError):self.M['prepare'](self.registry,self.source)
        (self.registry/'meta').write_bytes(oldmeta)
        self.M['C']['pid_birth_state']=lambda *a:'live'
        with self.assertRaises(ValueError):self.M['prepare'](self.registry,self.source)
    def test_actual_operator_preflight_consumes_valid_receipt_and_rejects_stale(self):
        path=self.M['observe'](self.registry,self.source,self.api(),self.out)
        command=[__import__('sys').executable,str(ROOT/'scripts/cloudbench-operator-preflight.py'),'--historical-local-closure',str(path)]
        result=subprocess.run(command,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'],'HISTORICAL_NATIVE_OWNERSHIP_PHYSICALLY_TERMINAL')
        value=json.loads(path.read_text());value['observed_at']-=601
        data=json.dumps(value,sort_keys=True,separators=(',',':')).encode()
        stale=self.out/('local-forensic-observation-'+hashlib.sha256(data).hexdigest()+'.json');stale.write_bytes(data);stale.chmod(0o600)
        bad=subprocess.run(command[:-1]+[str(stale)],capture_output=True,text=True)
        self.assertEqual(bad.returncode,78);self.assertIn('stale/future',bad.stderr)

    def test_actual_stale_reconciler_preserves_quarantine_without_blocking_new_admission(self):
        import shlex
        fleet=(ROOT/'scripts/run-bench-fleet').read_text()
        inventory=(ROOT/'scripts/lib/cloudbench-inventory.sh').read_text()
        def function(text,name):
            start=text.index(name+'() {');end=text.index('\n}\n',start)+3
            return text[start:end]
        script='\n'.join((function(inventory,'registry_meta_value'),function(fleet,'fleet_registry_cleanup_state'),function(fleet,'reconcile_stale_fleet_registries_full')))
        script+='\nFLEET_OWNERSHIP_ROOT='+shlex.quote(str(self.registry.parent))+'\nFLEET_REGISTRY_DIR=/new-owner\nAPP='+shlex.quote(self.app)+'\n'
        script+='FLY() { exit 91; }\nreconcile_stale_fleet_registries_full\n'
        before=(self.registry/'meta').read_bytes()
        result=subprocess.run(['bash','-c',script],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(before,(self.registry/'meta').read_bytes())
        self.assertTrue((self.registry/'guest-cleanup-unconfirmed').exists())

    def test_expired_early_response_refuses_before_publication(self):
        import time
        from unittest.mock import patch
        provenance=self.run/'execution-provenance.json'
        value=json.loads(provenance.read_bytes())
        value['config']['values']['inventory_max_stale_seconds']='1'
        self.write(provenance,value)
        api=self.api();original=api.api;now=[time.time()];captured=[]
        def call(method,path,timeout,observer):
            captured.append((path,now[0]))
            result=original(method,path,timeout,observer)
            if path=='/machines/'+self.mid:now[0]+=2
            return result
        api.api=call
        with patch('time.time',side_effect=lambda:now[0]):
            with self.assertRaisesRegex(ValueError,'collection exceeded original freshness bound'):
                self.M['observe'](self.registry,self.source,api,self.out)
        self.assertEqual(now[0]-captured[1][1],2)
        self.assertEqual(list(self.out.glob('local-forensic-observation-*')),[])

    def test_stale_or_forged_projection_cannot_classify(self):
        from unittest.mock import patch
        p=self.M['observe'](self.registry,self.source,self.api(),self.out)
        with patch('time.time',return_value=__import__('time').time()+601):
            with self.assertRaises(ValueError):self.M['verify'](p)
        row=json.loads(p.read_text());row['claims_released']=True
        data=json.dumps(row,sort_keys=True,separators=(',',':')).encode()
        forged=self.out/('local-forensic-observation-'+hashlib.sha256(data).hexdigest()+'.json');forged.write_bytes(data)
        with self.assertRaises(ValueError):self.M['verify'](forged)

    def test_custody_change_or_busy_recovery_refuses(self):
        def change(path,v):
            if path.startswith('/volumes/'):self.write(self.registry/'unexpected','changed')
            return v
        with self.assertRaises(ValueError):self.M['observe'](self.registry,self.source,self.api(change),self.out)
        self.assertEqual(list(self.out.glob('local-forensic-observation-*')),[])
        guard=self.root/'.git/cloudbench-fleet-recovery-locks'/self.owner
        import fcntl
        with guard.open('r') as f:
            fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):self.M['observe'](self.registry,self.source,self.api(),self.out)
if __name__=='__main__':unittest.main()
