#!/usr/bin/env python3
"""Actual archive producer -> exact native reads -> separate operator projection."""
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import tarfile
import unittest

ROOT=Path(os.environ.get('I30_SOURCE_ROOT',Path(__file__).resolve().parents[2]))
BASE=Path(os.environ.get('I30_BASE_ROOT',Path(__file__).resolve().parents[2]))
OLD=runpy.run_path(str(BASE/'scripts/tests/cloudbench-archived-owner-stop.test.py'))
A=runpy.run_path(str(BASE/'scripts/cloudbench-native-release-audit.py'))
PATH=ROOT/'scripts/cloudbench-forensic-resource-closure.py'
F=runpy.run_path(str(PATH)) if PATH.exists() else None


class Forensic(OLD['ArchivedStop']):
    def setUp(self):
        super().setUp()
        token='b'*32;prefix='git-common/cloudbench-fleet-ownership/'+token;audit='git-common/cloudbench-fleet-audits/'+token
        run_id='20261028-021139-15597';name='cloudbench-exact'
        with tarfile.open(self.run/'export/originals.tar.gz') as stream:
            self.members={m.name:stream.extractfile(m).read() for m in stream if m.isfile() and '/clones/' not in m.name}
        self.members[prefix+'/meta']=(f'version=2\nhost=11112222333344\napp=navi-whisper-lux-bench\nfleet_owner_token={token}\ncleanup_policy=reap\nrun_id={run_id}\n').encode()
        self.members[prefix+'/disposable-resources-v1']=(token+'\nnavi-whisper-lux-bench\n').encode()
        self.members[prefix+'/runtime-evidence-unconfirmed']=b''
        self.members[audit+'/meta']=(f'run_id={run_id}\nfleet_owner_token={token}\napp=navi-whisper-lux-bench\nstatus=incomplete\n').encode()
        self.members[audit+'/expected-fresh/'+name]=b'clone_name=cloudbench-exact\nsource_machine_id=683e47df5094d8\n'
        self.members[audit+'/fresh/'+name]=(f'version=1\nfleet_owner_token={token}\nrun_id={run_id}\napp=navi-whisper-lux-bench\nclone_name={name}\nsource=fresh-clone\nsource_machine_id=683e47df5094d8\nmachine_id={self.mid}\nvolume_id=vol_owned\ndisposition=destroyed-provider-retained\n').encode()
        self.members[audit+'/by-machine-id/'+self.mid]=(name+'\n').encode()
        self.members[audit+'/owned-clones.ids']=self.members[audit+'/owned-clones.names']=b''
        for kind,identifier in [('machine',self.mid),('volume','vol_owned')]:self.members[prefix+'/disposable-delete-'+kind+'-'+identifier+'.json']=json.dumps(dict(app='navi-whisper-lux-bench',identifier=identifier,kind=kind,owner=token)).encode()
        self.members['context/fleet/runs/'+run_id+'/_batch/disposable-cleanup.json']=json.dumps(dict(schema='disposable-cleanup-v1',owner=token,guest_cleanup_missing=False,runtime_evidence_missing=True,successful_runtime_inferred=False)).encode()
        self.members['context/fleet/runs/'+run_id+'/polar-bu-027/primary.ids']=(self.mid+'\n').encode()
        self.volume_identity=dict(id='vol_owned',name='cbv_exact',region='iad',created_at='original-volume-created',size_gb=40,encrypted=True)
        self.workspace_identity=dict(self.volume_identity,id='vol_workspace',name='cbgate_exact',size_gb=256)
        self.members[audit+'/volume-backups/vol_owned/verified.json']=json.dumps(dict(owner=token,app='navi-whisper-lux-bench',run_id=run_id,machine=self.mid,volume='vol_owned',native=self.volume_identity)).encode()
        self.members['context/fleet/runs/'+run_id+'/execution-provenance.json']=json.dumps(dict(base_sha='a'*40,workspace_patch_sha256='none')).encode()
        other='c'*32;other_prefix='git-common/cloudbench-fleet-audits/'+other;other_run='20261028-021140-15598'
        self.other_mid='ddddeeeeffff00'
        self.members[other_prefix+'/meta']=(f'run_id={other_run}\nfleet_owner_token={other}\napp=navi-whisper-lux-bench\nstatus=provider-teardown-verified\n').encode()
        self.members[other_prefix+'/provider-teardown-verified.epoch']=b'1793154216\n'
        self.members[other_prefix+'/expected-fresh/cloudbench-other']=b'clone_name=cloudbench-other\nsource_machine_id=683e47df5094d8\n'
        self.members[other_prefix+'/fresh/cloudbench-other']=(f'version=1\nfleet_owner_token={other}\nrun_id={other_run}\napp=navi-whisper-lux-bench\nclone_name=cloudbench-other\nsource=fresh-clone\nsource_machine_id=683e47df5094d8\nmachine_id={self.other_mid}\nvolume_id=vol_other\ndisposition=destroyed-verified-absent\n').encode()
        self.members[other_prefix+'/by-machine-id/'+self.other_mid]=b'cloudbench-other\n'
        self.members[other_prefix+'/owned-clones.ids']=(self.other_mid+'\n').encode()
        self.members[other_prefix+'/owned-clones.names']=b'cloudbench-other\n'
        self.members['context/fleet/runs/'+other_run+'/execution-provenance.json']=json.dumps(dict(base_sha='a'*40,workspace_patch_sha256='none')).encode()
        self.machine_identity=dict(id=self.mid,name=name,region='iad',created_at='2026-10-28T02:11:59Z',instance_id='01M604F2RQVW0PYF2GQ9EYVVT5',config={'image':'image@sha256:exact','env':{'PRIVATE_TEST_VALUE':'private-config-value'}})
        self.controller_identity=dict(self.machine_identity,id='11112222333344',name='cloudbench-gate-exact',created_at='2026-10-28T02:02:29Z',instance_id='01M603X6VBMGAKD6W8TNYMQ4CV')
        self.other_identity=dict(self.machine_identity,id=self.other_mid,name='cloudbench-other',instance_id='other-original-instance')
        for own,rid,machine in ((token,run_id,self.machine_identity),(other,other_run,self.other_identity)):
            incarnation=hashlib.sha256(json.dumps([machine['id'],machine['instance_id'],machine['config']],sort_keys=True,separators=(',',':')).encode()).hexdigest()
            fence='git-common/cloudbench-native-effect-fences/'+own+'/'+rid+'/'+machine['id']+'/destroy/'+incarnation
            self.members[fence+'/intent.json']=json.dumps(dict(machine=machine,operation='destroy')).encode()
            self.members[fence+'/ack.json']=b'{"ok":true}'
        self.reseal(self.members)
        export=self.run/'export'
        authority_sha=OLD['S']['digest_file'](self.run/'authority.private.json')
        workspace=dict(schema='cloudbench-controller-workspace-ownership-v1',app='navi-whisper-lux-bench',source_ref='a'*40,volume_id='vol_workspace',native_create=self.workspace_identity)
        OLD['write'](export/'workspace-volume.ownership.json',workspace)
        OLD['write'](export/'disposable-controller.ownership.json',dict(schema='cloudbench-disposable-controller-ownership-v1',authority_sha256=authority_sha,workspace_sha256=OLD['S']['digest_file'](export/'workspace-volume.ownership.json'),machine=self.controller_identity,volume={'id':'vol_workspace'}))
        release=dict(machine_id='11112222333344',machine_deleted=True,volume_id='vol_workspace',volume_disposition='pending_destroy')
        OLD['write'](export/'disposable-controller.release.json',release)
        OLD['write'](export/'disposable-delete-volume.intent.json',dict(authority_sha256=authority_sha,kind='volume',identifier='vol_workspace'))
        terminal=json.loads((self.run/'terminal.json').read_text());terminal['release']=release;OLD['write'](self.run/'terminal.json',terminal)
        self.admission=self.root/'admission';export=self.admission/'shard-00/run/export';export.parent.mkdir(parents=True)
        shutil.copytree(self.run,export.parent,dirs_exist_ok=True)
        (self.admission/'coordination.json').write_text(json.dumps(dict(controllers=1)))
        class Empty:
            def api(self,*args,**kwargs):return []
        self.original=A['run'](self.admission,Empty())
        self.original_bytes=(self.admission/'native-release-audit.json').read_bytes()
        info=(self.admission/'native-release-audit.json').stat();self.original_stat=(info.st_ino,info.st_mtime_ns,info.st_size)

    def exact_api(self, overrides=None, delay_path=None):
        import time
        calls=[];overrides=overrides or {}
        class API:
            app='navi-whisper-lux-bench';base='https://api.machines.dev'
            def api(self,method,path,timeout,observer=None):
                calls.append((method,path))
                if path==delay_path:time.sleep(.2)
                status,value=overrides.get(path,(200,{'name':self.app}) if path=='' else (200,[]) if path in ('/machines','/volumes') else (404,{'error':'not found'}))
                if observer:observer(method,path,status,json.dumps(value).encode())
                if status>=400:raise RuntimeError('HTTP '+str(status))
                return value
        return API(),calls

    def closure_receipt(self):
        plan=F['prepare'](self.run,self.inventory,'b'*32)
        api,_=self.exact_api()
        return F['observe'](api,plan,self.out)

    def retained_missing_guest(self):
        prefix='git-common/cloudbench-fleet-ownership/'+'b'*32
        self.members[prefix+'/meta']=self.members[prefix+'/meta'].replace(b'cleanup_policy=reap',b'cleanup_policy=retain')
        self.members[prefix+'/guest-cleanup-unconfirmed']=b''
        path='context/fleet/runs/20261028-021139-15597/_batch/disposable-cleanup.json'
        cleanup=json.loads(self.members[path]);cleanup['guest_cleanup_missing']=True
        self.members[path]=json.dumps(cleanup).encode()
        self.reseal(self.members)
        shutil.copytree(self.run,self.admission/'shard-00/run',dirs_exist_ok=True)

    def _recorded_it10_runtime_fact(self):
        # Exact original cleanup JSON from owner efed9c0b (SHA4a959091...).
        # Only owner is rebound to this existing synthetic archive's identity.
        original = b'{"guest_cleanup_missing": true, "owner": "efed9c0b519c46ac9b61a56c0ed4b843", "runtime_evidence_missing": false, "schema": "disposable-cleanup-v1", "successful_runtime_inferred": false}'
        self.assertEqual(hashlib.sha256(original).hexdigest(), '4a959091f2949a4594fe91523e4ada5a4ee787b92cd27e0753d8ad9d1a88a6be')
        self.retained_missing_guest()
        cleanup = json.loads(original); cleanup['owner'] = 'b'*32
        path='context/fleet/runs/20261028-021139-15597/_batch/disposable-cleanup.json'
        self.members[path]=json.dumps(cleanup).encode()
        # The observed original has no runtime marker. Its absence grants no seal.
        self.members.pop('git-common/cloudbench-fleet-ownership/'+'b'*32+'/runtime-evidence-unconfirmed')
        self.reseal(self.members)
        shutil.copytree(self.run,self.admission/'shard-00/run',dirs_exist_ok=True)
        return path

    def test_runtime_capture_present_keeps_original_fact_through_full_consumer(self):
        self._recorded_it10_runtime_fact()
        original = dict(self.members)
        plan=F['prepare'](self.run,self.inventory,'b'*32)
        self.assertIs(plan['historical_runtime_evidence_missing'],False)
        self.assertIs(plan['historical_guest_cleanup_missing'],True)
        api,calls=self.exact_api()
        receipt=F['observe'](api,plan,self.out)
        checked=F['verify'](receipt)
        self.assertIs(checked['plan']['historical_runtime_evidence_missing'],False)
        result=F['reconcile'](self.admission,receipt,api)
        self.assertTrue(result['current_physical_resource_release_verified'])
        self.assertFalse(result['claims_released'])
        self.assertFalse(result['runtime_sealed'])
        self.assertTrue(result['old_infra_retained'])
        self.assertIsNone(result['original_release_epoch'])
        self.assertTrue(all(method=='GET' for method,path in calls))
        self.assertEqual(self.members,original)
        self.assertEqual((self.admission/'native-release-audit.json').read_bytes(),self.original_bytes)

    def test_runtime_capture_present_canonical_cli_remains_get_only(self):
        self._recorded_it10_runtime_fact()
        self.test_canonical_cli_producer_and_consumer_use_loopback_only()

    def test_runtime_capture_fact_requires_strict_boolean_and_exact_plan(self):
        path=self._recorded_it10_runtime_fact();original=dict(self.members)
        for value in (0,1,'false','true',None):
            with self.subTest(value=value):
                cleanup=json.loads(original[path]);cleanup['runtime_evidence_missing']=value
                self.members=dict(original);self.members[path]=json.dumps(cleanup).encode();self.reseal(self.members)
                with self.assertRaisesRegex(ValueError,'runtime evidence fact must be boolean'):
                    F['prepare'](self.run,self.inventory,'b'*32)
        self.members=dict(original);cleanup=json.loads(original[path]);cleanup.pop('runtime_evidence_missing')
        self.members[path]=json.dumps(cleanup).encode();self.reseal(self.members)
        with self.assertRaisesRegex(ValueError,'runtime evidence fact must be boolean'):
            F['prepare'](self.run,self.inventory,'b'*32)
        for changed in ({'owner':'c'*32}, {'successful_runtime_inferred':True}, {'guest_cleanup_missing':False}, {'extra':False}):
            with self.subTest(forged=changed):
                cleanup=json.loads(original[path]);cleanup.update(changed)
                self.members=dict(original);self.members[path]=json.dumps(cleanup).encode();self.reseal(self.members)
                with self.assertRaisesRegex(ValueError,'forensic failure facts differ'):
                    F['prepare'](self.run,self.inventory,'b'*32)
        self.members=original;self.reseal(original)
        plan=F['prepare'](self.run,self.inventory,'b'*32)
        api,_=self.exact_api();receipt=F['observe'](api,plan,self.out)
        data=json.loads(receipt.read_bytes());data['plan']['historical_runtime_evidence_missing']=True
        encoded=json.dumps(data,sort_keys=True,separators=(',',':')).encode()
        forged=self.out/('forensic-resource-closure-'+hashlib.sha256(encoded).hexdigest()+'.json');forged.write_bytes(encoded);forged.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'forensic plan no longer exact'):F['verify'](forged)

    def test_true_runtime_capture_fact_keeps_legacy_plan_shape(self):
        plan=F['prepare'](self.run,self.inventory,'b'*32)
        self.assertNotIn('historical_runtime_evidence_missing',plan)
        api,_=self.exact_api();receipt=F['observe'](api,plan,self.out)
        self.assertEqual(F['verify'](receipt)['plan'],plan)

    def test_retained_missing_guest_ack_only_observes_current_physical_state(self):
        self.retained_missing_guest()
        original_members=dict(self.members)
        plan=F['prepare'](self.run,self.inventory,'b'*32)
        self.assertEqual(plan['historical_cleanup_policy'],'retain')
        self.assertIs(plan['historical_guest_cleanup_missing'],True)
        api,calls=self.exact_api({ '/machines/'+m['id']:(200,dict(m,state='destroyed'))
                                 for m in (self.machine_identity,self.controller_identity,self.other_identity) })
        receipt=F['observe'](api,plan,self.out)
        verified=F['verify'](receipt)
        self.assertIs(verified['claims_released'],False)
        self.assertIs(verified['runtime_sealed'],False)
        result=F['reconcile'](self.admission,receipt,api)
        self.assertIs(result['current_physical_resource_release_verified'],True)
        self.assertIs(result['claims_released'],False)
        self.assertIs(result['old_infra_retained'],True)
        self.assertIsNone(result['original_release_epoch'])
        self.assertTrue(all(method=='GET' for method,path in calls))
        exp,issues=self.reporting_card()
        self.assertTrue(exp.get('physical_closure_asof'))
        self.assertEqual(exp['released'],{'yes':39,'of':40})
        self.assertEqual(exp['lifecycle_verified'],{'yes':38,'of':40})
        self.assertFalse(any('exact-owner' in x['action'] for x in issues))
        self.assertEqual(self.members,original_members)
        audit=self.admission/'native-release-audit.json';info=audit.stat()
        self.assertEqual((info.st_ino,info.st_mtime_ns,info.st_size),self.original_stat)
        self.assertEqual(audit.read_bytes(),self.original_bytes)

    def test_retained_canonical_cli_stays_get_only_and_preserves_late_deadline(self):
        self.retained_missing_guest()
        self.test_canonical_cli_producer_and_consumer_use_loopback_only()

    def test_retained_observation_requires_original_terminal_delete_and_matching_failure_facts(self):
        self.retained_missing_guest();original=dict(self.members)
        prefix='git-common/cloudbench-fleet-ownership/'+'b'*32
        cleanup_path='context/fleet/runs/20261028-021139-15597/_batch/disposable-cleanup.json'
        cases=[]
        changed=dict(original);value=json.loads(changed[cleanup_path]);value['guest_cleanup_missing']=False
        changed[cleanup_path]=json.dumps(value).encode();cases.append(changed)
        changed=dict(original);value=json.loads(changed[cleanup_path]);value['guest_cleanup_missing']=1
        changed[cleanup_path]=json.dumps(value).encode();cases.append(changed)
        changed=dict(original);del changed[prefix+'/guest-cleanup-unconfirmed'];cases.append(changed)
        changed=dict(original);changed[prefix+'/meta']=changed[prefix+'/meta'].replace(b'cleanup_policy=retain',b'cleanup_policy=foreign');cases.append(changed)
        changed=dict(original);del changed[prefix+'/disposable-delete-machine-'+self.mid+'.json'];cases.append(changed)
        changed=dict(original);path=next(k for k in changed if '/destroy/' in k and k.endswith('/ack.json'));del changed[path];cases.append(changed)
        changed=dict(original);path=next(k for k in changed if '/fresh/' in k);changed[path]=changed[path].replace(b'destroyed-provider-retained',b'retained');cases.append(changed)
        for changed in cases:
            with self.subTest(changed=set(changed)^set(original)):
                self.members=changed;self.reseal(changed)
                with self.assertRaises((ValueError,KeyError)):F['prepare'](self.run,self.inventory,'b'*32)
        self.members=original;self.reseal(original)
        plan=F['prepare'](self.run,self.inventory,'b'*32)
        api,_=self.exact_api({'/machines/'+self.mid:(200,dict(self.machine_identity,state='started'))})
        with self.assertRaisesRegex(ValueError,'state=started'):
            F['observe'](api,plan,self.out)
        self.assertEqual(list(self.out.glob('forensic-resource-closure-*.json')),[])

    def test_actual_destroyed_machine_shape_preserves_terminal_not_absent(self):
        plan=F['prepare'](self.run,self.inventory,'b'*32)
        overrides={ '/machines/'+m['id']:(200,dict(m,state='destroyed')) for m in
                   (self.controller_identity,self.machine_identity,self.other_identity)}
        overrides['/volumes/vol_owned']=(200,dict(self.volume_identity,state='pending_destroy',attached_machine_id=None))
        api,calls=self.exact_api(overrides)
        receipt=F['observe'](api,plan,self.out)
        self.assertFalse(F['verify'](receipt)['native_resources_absent'])
        result=F['reconcile'](self.admission,receipt,api)
        self.assertTrue(result['current_physical_resource_release_verified'])
        self.assertFalse(result['all_resources_absent'])
        self.assertEqual((self.admission/'native-release-audit.json').read_bytes(),self.original_bytes)
        self.assertIn(('GET','/machines/'+self.other_mid),calls)

    def test_destroyed_machine_wrong_incarnation_no_delete_and_live_refuse_with_private_wire(self):
        plan=F['prepare'](self.run,self.inventory,'b'*32)
        good=dict(self.machine_identity,state='destroyed')
        for field,value in [('id','eeeeffff000011'),('instance_id','foreign'),('created_at','foreign'),
                            ('name','foreign'),('region','ord'),('config',{}),('state','stopped'),
                            ('state','destroying'),('state','pending_destroy')]:
            with self.subTest(field=field,value=value):
                api,_=self.exact_api({'/machines/'+self.mid:(200,dict(good,**{field:value}))})
                with self.assertRaisesRegex(ValueError,'subject=/machines/'+self.mid+' status=200 state=') as error:
                    F['observe'](api,plan,self.out)
                self.assertNotIn('private-config-value',str(error.exception))
        diagnostics=list(self.out.glob('forensic-native-refusal-*.json'))
        self.assertEqual(len(diagnostics),9)
        for path in diagnostics:
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            value=json.loads(path.read_bytes())
            self.assertFalse(value['claims_released']);self.assertEqual(value['subject'],'/machines/'+self.mid)
            self.assertEqual(value['wire']['status'],200)
        self.assertEqual(list(self.out.glob('forensic-resource-closure-*.json')),[])
        # Same check must guard the full consumer's other, ordinarily finalized guest.
        receipt=self.closure_receipt()
        api,_=self.exact_api({'/machines/'+self.other_mid:(200,dict(self.other_identity,state='destroyed',instance_id='foreign'))})
        with self.assertRaisesRegex(ValueError,'subject=/machines/'+self.other_mid):
            F['reconcile'](self.admission,receipt,api)
        self.assertEqual(list(self.admission.glob('forensic-release-projection-*.json')),[])
        original=dict(self.members)
        delete=next(k for k in self.members if k.endswith('/disposable-delete-machine-'+self.mid+'.json'))
        del self.members[delete];self.reseal(self.members)
        with self.assertRaises((ValueError,KeyError)):F['prepare'](self.run,self.inventory,'b'*32)
        self.members=dict(original)
        intent=next(k for k in self.members if k.startswith('git-common/cloudbench-native-effect-fences/'+'b'*32) and k.endswith('/intent.json'))
        encoded=json.loads(self.members[intent]);encoded['machine']['created_at']='forged-original'
        self.members[intent]=json.dumps(encoded).encode();self.reseal(self.members)
        forged=F['prepare'](self.run,self.inventory,'b'*32)
        api,_=self.exact_api({'/machines/'+self.mid:(200,good)})
        with self.assertRaises(ValueError):F['observe'](api,forged,self.out)
        self.members=dict(original)
        ack=next(k for k in self.members if k.startswith('git-common/cloudbench-native-effect-fences/'+'b'*32) and k.endswith('/ack.json'))
        del self.members[ack];self.reseal(self.members)
        with self.assertRaises((ValueError,KeyError)):F['prepare'](self.run,self.inventory,'b'*32)

    def reporting_card(self):
        card=runpy.run_path(str(ROOT/'scripts/cloudbench-scorecard.py'))
        audit=json.loads((self.admission/'native-release-audit.json').read_bytes())
        report_path=ROOT/'scripts/cloudbench-resource-closure-report.py'
        closure=runpy.run_path(str(report_path))['load'](self.admission,audit) if report_path.exists() else None
        row=dict(task='BU027',status='failed',task_status='INFRA_ERROR',infra_failure=True,released=False,lifecycle=False)
        (self.admission/'coordination.json').write_text(json.dumps(dict(controllers=1,finished_at=1,released_at=1,scheduled_total=40,shards={'0':{'out':str(self.admission/'shard-00/run')}})))
        (self.admission/'result.json').write_text(json.dumps(dict(jobs=[dict(task='other-'+str(i),status='passed',task_status='PASSED',infra_failure=False,released=True,lifecycle=i<38) for i in range(39)]+[row],hub_group_final_published=True)))
        exp=card['load_sharded'](self.admission,deep=False)
        return exp,card['_issues'](exp)

    def test_reporting_asof_closure_removes_only_obsolete_recovery_action(self):
        receipt=self.closure_receipt();api,_=self.exact_api()
        F['reconcile'](self.admission,receipt,api)
        exp,issues=self.reporting_card()
        self.assertTrue(exp.get('physical_closure_asof'), 'Canonical physical closure is lost before card action selection')
        self.assertEqual(exp['released'],{'yes':39,'of':40})
        self.assertEqual(exp['lifecycle_verified'],{'yes':38,'of':40})
        self.assertEqual(exp['state'],'INCOMPLETE')
        self.assertEqual(exp['outcomes']['INFRA'],1)
        self.assertFalse(any('exact-owner' in x['action'] for x in issues),'Card still instructs redundant physical recovery')
        self.assertTrue(any('historical' in x['action'].lower() for x in issues))
        self.assertTrue(any(x['label']=='Physical resources terminal (as of)' for x in exp['lifecycle']))
        self.assertEqual((self.admission/'native-release-audit.json').read_bytes(),self.original_bytes)

    def test_reporting_missing_tampered_foreign_partial_future_proofs_keep_original_action(self):
        exp,issues=self.reporting_card()
        self.assertFalse(exp.get('physical_closure_asof'))
        self.assertTrue(any('exact-owner' in x['action'] for x in issues))
        receipt=self.closure_receipt();api,_=self.exact_api();F['reconcile'](self.admission,receipt,api)
        projection=next(self.admission.glob('forensic-release-projection-*.json'))
        original=json.loads(projection.read_bytes());projection.unlink()
        for key,value in [('original_audit_sha256','f'*64),('scope','foreign-admission'),
                          ('checked_subjects',original['checked_subjects'][:-1]),('observed_at',float('inf')),('observed_at',__import__('time').time()+3600),
                          ('claims_released',True),('verified_exports',2),('observation','/missing/foreign.json')]:
            with self.subTest(key=key):
                changed=dict(original,**{key:value});encoded=json.dumps(changed,sort_keys=True,separators=(',',':')).encode()
                wrong=self.admission/('forensic-release-projection-'+hashlib.sha256(encoded).hexdigest()+'.json')
                wrong.write_bytes(encoded);wrong.chmod(0o600)
                exp,issues=self.reporting_card()
                self.assertFalse(exp.get('physical_closure_asof'))
                self.assertTrue(any('exact-owner' in x['action'] for x in issues))
                wrong.unlink()
        observation_path=Path(original['observation']);observed=json.loads(observation_path.read_bytes())
        for changed in [dict(observed,terminal=observed['terminal'][:-1]),dict(observed,app='foreign-app'),
                        dict(observed,source_ref='f'*40),dict(observed,current_native_audit=dict(observed['current_native_audit'],retained_owners=['f'*32]))]:
            encoded=json.dumps(changed,sort_keys=True,separators=(',',':')).encode()
            changed_path=self.admission/('current-resource-observation-'+hashlib.sha256(encoded).hexdigest()+'.json')
            changed_path.write_bytes(encoded);changed_path.chmod(0o600)
            value=dict(original,observation=str(changed_path),observation_sha256=hashlib.sha256(encoded).hexdigest())
            encoded=json.dumps(value,sort_keys=True,separators=(',',':')).encode()
            changed_projection=self.admission/('forensic-release-projection-'+hashlib.sha256(encoded).hexdigest()+'.json')
            changed_projection.write_bytes(encoded);changed_projection.chmod(0o600)
            exp,issues=self.reporting_card();self.assertFalse(exp.get('physical_closure_asof'))
            self.assertTrue(any('exact-owner' in x['action'] for x in issues))
            changed_projection.unlink();changed_path.unlink()
        # An unchanged receipt cannot conceal mutation of an original pinned input.
        canonical=json.dumps(original,sort_keys=True,separators=(',',':')).encode()
        projection.write_bytes(canonical);projection.chmod(0o600)
        inventory_bytes=self.inventory.read_bytes();self.inventory.write_bytes(inventory_bytes+b' ')
        exp,_=self.reporting_card();self.assertFalse(exp.get('physical_closure_asof'))
        self.inventory.write_bytes(inventory_bytes);projection.unlink()
        projection.write_text(json.dumps(original));projection.chmod(0o600)
        exp,_=self.reporting_card();self.assertFalse(exp.get('physical_closure_asof'),'Replaced bytes retained filename-only trust')

    def test_reporting_omitted_changed_writer_authority_terminal_inventory_refuse(self):
        receipt=self.closure_receipt();api,_=self.exact_api();F['reconcile'](self.admission,receipt,api)
        projection=next(self.admission.glob('forensic-release-projection-*.json'))
        original=json.loads(projection.read_bytes());projection.unlink()
        observation_path=Path(original['observation']);original_observation=json.loads(observation_path.read_bytes())
        inputs=original_observation['export_inputs']
        for suffix in ('cleanup-call.intent.json','authority.private.json','terminal.json','inventory.json','cleanup-kept.json'):
            with self.subTest(suffix=suffix):
                filename=next(name for name in inputs if name.endswith('cleanup-call.intent.json' if suffix=='cleanup-kept.json' else suffix)) if suffix!='inventory.json' else str(self.inventory)
                path=Path(filename);saved=path.read_bytes()
                if suffix in ('cleanup-call.intent.json','cleanup-kept.json'):
                    changed=json.loads(saved);changed['supervisor_joined']=False;path.write_text(json.dumps(changed))
                else:path.write_bytes(b'{}')
                changed_inputs={k:v for k,v in inputs.items() if k!=filename}
                if suffix=='cleanup-kept.json':changed_inputs[filename]=hashlib.sha256(path.read_bytes()).hexdigest()
                changed=dict(original_observation,export_inputs=changed_inputs)
                encoded=json.dumps(changed,sort_keys=True,separators=(',',':')).encode()
                observation=self.admission/('current-resource-observation-'+hashlib.sha256(encoded).hexdigest()+'.json')
                observation.write_bytes(encoded);observation.chmod(0o600)
                changed=dict(original,observation=str(observation),observation_sha256=hashlib.sha256(encoded).hexdigest())
                encoded=json.dumps(changed,sort_keys=True,separators=(',',':')).encode()
                bad=self.admission/('forensic-release-projection-'+hashlib.sha256(encoded).hexdigest()+'.json')
                bad.write_bytes(encoded);bad.chmod(0o600)
                try:
                    exp,issues=self.reporting_card()
                    self.assertFalse(exp.get('physical_closure_asof'),'Omitted altered original authority still suppresses recovery action')
                    self.assertTrue(any('exact-owner' in x['action'] for x in issues))
                finally:path.write_bytes(saved);bad.unlink();observation.unlink()

    # Do not inherit the unrelated previous stop suite's cases in this extension.
    def test_exact_absence_reconciles_without_rewriting_failed_original(self):
        if F is None:
            self.assertTrue(self.original.get('native_resources_absent',self.original['released']), 'No canonical forensic resource closure exists after original controller deletion')
            return
        plan=F['prepare'](self.run,self.inventory,'b'*32)
        calls=[]
        class Absent:
            app="navi-whisper-lux-bench";base="https://api.machines.dev"
            def api(self,method,path,timeout,observer=None):
                calls.append((method,path))
                if path in ('/machines','/volumes'):return []
                if path=='':
                    value={'name':self.app};observer(method,path,200,json.dumps(value).encode());return value
                observer(method,path,404,b'{"error":"not found"}');raise RuntimeError('404')
        receipt=F['observe'](Absent(),plan,self.out)
        result=F['reconcile'](self.admission,receipt,Absent())
        self.assertTrue(result['current_physical_resource_release_verified'])
        self.assertTrue(result['all_resources_terminal'])
        self.assertFalse(result['runtime_sealed']);self.assertFalse(result['claims_released'])
        self.assertTrue(result['old_infra_retained']);self.assertIsNone(result['original_release_epoch'])
        self.assertEqual((self.admission/'native-release-audit.json').read_bytes(),self.original_bytes)
        info=(self.admission/'native-release-audit.json').stat();self.assertEqual((info.st_ino,info.st_mtime_ns,info.st_size),self.original_stat)
        self.assertEqual(len(calls),13)
        self.assertEqual(set(result['checked_subjects']),{'machines/11112222333344','machines/'+self.mid,'machines/'+self.other_mid,'volumes/vol_owned','volumes/vol_other','volumes/vol_workspace'})
        self.assertFalse(self.original['released'])

    def test_live_unknown_and_wrong_binding_refuse(self):
        if F is None:self.skipTest('capability absent baseline; positive control records the causal refusal')
        plan=F['prepare'](self.run,self.inventory,'b'*32)
        for status in (200,401,403,404,500):
            api,_=self.exact_api({'':(status,{})} if status==404 else {'/machines/11112222333344':(status,{})})
            with self.assertRaises((ValueError,RuntimeError)):F['observe'](api,plan,self.out)
        class Alternate:
            app='navi-whisper-lux-bench';base='https://untrusted.invalid'
        with self.assertRaises(ValueError):F['observe'](Alternate(),plan,self.out)
        self.assertEqual(list(self.out.glob('forensic-resource-closure-*.json')),[])
        changed=json.loads((self.run/'terminal.json').read_text());changed['source_ref']='c'*40
        OLD['write'](self.run/'terminal.json',changed)
        with self.assertRaises(ValueError):F['prepare'](self.run,self.inventory,'b'*32)

    def test_forged_receipt_and_incomplete_cohort_refuse(self):
        if F is None:self.skipTest('capability absent baseline')
        plan=F['prepare'](self.run,self.inventory,'b'*32)
        class Absent:
            app="navi-whisper-lux-bench";base="https://api.machines.dev"
            def api(self,method,path,timeout,observer=None):
                if path in ('/machines','/volumes'):return []
                if path=='':
                    value={'name':self.app};observer(method,path,200,json.dumps(value).encode());return value
                observer(method,path,404,b'{}');raise RuntimeError('404')
        receipt=F['observe'](Absent(),plan,self.out)
        class Live:
            app='navi-whisper-lux-bench';base='https://api.machines.dev'
            def api(self,method,path,timeout,observer=None):observer(method,path,200,b'{}');return {}
        with self.assertRaises(ValueError):F['reconcile'](self.admission,receipt,Live())
        self.assertEqual(list(self.admission.glob('forensic-release-projection-*.json')),[])
        value=json.loads(receipt.read_bytes());value['runtime_sealed']=True
        encoded=json.dumps(value,sort_keys=True,separators=(',',':')).encode();forged=self.out/('forensic-resource-closure-'+hashlib.sha256(encoded).hexdigest()+'.json');forged.write_bytes(encoded);forged.chmod(0o600)
        with self.assertRaises(ValueError):F['verify'](forged)
        del self.members['git-common/cloudbench-fleet-audits/'+'b'*32+'/by-machine-id/'+self.mid]
        self.reseal(self.members)
        with self.assertRaises((ValueError,KeyError)):F['prepare'](self.run,self.inventory,'b'*32)

    def test_fullscope_soft_deleted_workspace_is_terminal_not_absent(self):
        if F is None:self.skipTest('capability absent baseline')
        receipt=self.closure_receipt()
        for state in ('waiting_for_detach','created','unknown',None):
            body=dict(self.workspace_identity,state=state,attached_machine_id=None)
            api,_=self.exact_api({'/volumes/vol_workspace':(200,body)})
            with self.assertRaises(ValueError):F['reconcile'](self.admission,receipt,api)
        for change in ({'id':'vol_foreign'},{'created_at':'other-created'},{'attached_machine_id':self.mid}):
            body=dict(self.workspace_identity,state='pending_destroy',attached_machine_id=None);body.update(change)
            api,_=self.exact_api({'/volumes/vol_workspace':(200,body)})
            with self.assertRaises(ValueError):F['reconcile'](self.admission,receipt,api)
        body=dict(self.workspace_identity,state='pending_destroy',attached_machine_id=None)
        api,_=self.exact_api({'/volumes/vol_workspace':(200,body)})
        result=F['reconcile'](self.admission,receipt,api)
        self.assertTrue(result['current_physical_resource_release_verified'])
        self.assertTrue(result['all_resources_terminal']);self.assertFalse(result['all_resources_absent'])
        observation=json.loads(Path(result['observation']).read_bytes())
        self.assertTrue(any(row.get('state')=='pending_destroy' and row['disposition']=='PROVIDER_TERMINAL_RETAINED' for row in observation['terminal']))
        self.assertEqual((self.admission/'native-release-audit.json').read_bytes(),self.original_bytes)

    def test_fullscope_live_other_owner_hidden_from_list_refuses(self):
        if F is None:self.skipTest('capability absent baseline')
        receipt=self.closure_receipt()
        api,calls=self.exact_api({'/machines/'+self.other_mid:(200,{'id':self.other_mid,'state':'started'})})
        with self.assertRaises(ValueError):F['reconcile'](self.admission,receipt,api)
        self.assertIn(('GET','/machines/'+self.other_mid),calls)
        self.assertEqual(list(self.admission.glob('forensic-release-projection-*.json')),[])
        api,_=self.exact_api({'/machines':(200,[{'id':'99998888777766','name':'cloudbench-new','state':'started','config':{'env':{'CLOUDBENCH_RUN_TOKEN':'b'*32+'-99'}}}])})
        with self.assertRaises(ValueError):F['reconcile'](self.admission,receipt,api)

    def test_fullscope_incomplete_export_unjoined_writer_and_timeout_refuse(self):
        if F is None:self.skipTest('capability absent baseline')
        receipt=self.closure_receipt()
        (self.admission/'coordination.json').write_text(json.dumps(dict(controllers=2)))
        api,calls=self.exact_api()
        with self.assertRaises(ValueError):F['reconcile'](self.admission,receipt,api)
        self.assertEqual(calls,[])
        (self.admission/'coordination.json').write_text(json.dumps(dict(controllers=1)))
        intent=self.admission/'shard-00/run/cleanup-call.intent.json';original=intent.read_bytes()
        value=json.loads(original);value['supervisor_joined']=False;OLD['write'](intent,value)
        with self.assertRaises(ValueError):F['reconcile'](self.admission,receipt,api)
        intent.write_bytes(original)
        api,calls=self.exact_api(delay_path='/machines/'+self.other_mid)
        with self.assertRaises(F['S']['BASE']['Deadline']):F['reconcile'](self.admission,receipt,api,seconds=.05)
        self.assertEqual(list(self.admission.glob('forensic-release-projection-*.json')),[])
        self.assertEqual(list(self.admission.glob('current-resource-observation-*.json')),[])

    def test_existing_original_epoch_is_not_replaced_with_none(self):
        if F is None:self.skipTest('capability absent baseline')
        self.members['git-common/cloudbench-fleet-audits/'+'b'*32+'/provider-teardown-verified.epoch']=b'1793154216\n'
        self.reseal(self.members)
        with self.assertRaisesRegex(ValueError,'historical provider epoch already exists'):F['prepare'](self.run,self.inventory,'b'*32)

    def test_selected_soft_terminal_uses_same_predicate_without_absence_credit(self):
        if F is None:self.skipTest('capability absent baseline')
        plan=F['prepare'](self.run,self.inventory,'b'*32)
        body=dict(self.volume_identity,state='pending_destroy',attached_machine_id=self.mid)
        api,_=self.exact_api({'/volumes/vol_owned':(200,body)})
        try:receipt=F['observe'](api,plan,self.out)
        except ValueError as error:self.fail('Legitimate once-owned terminal Volume was refused: '+str(error))
        recorded=F['verify'](receipt)
        self.assertTrue(recorded['native_resources_terminal']);self.assertFalse(recorded['native_resources_absent'])
        result=F['reconcile'](self.admission,receipt,api)
        self.assertTrue(result['all_resources_terminal']);self.assertFalse(result['all_resources_absent'])
        for change in ({'id':'vol_foreign'},{'state':'waiting_for_detach'},{'created_at':'foreign-created'}):
            wrong=dict(body);wrong.update(change)
            api,_=self.exact_api({'/volumes/vol_owned':(200,wrong)})
            with self.assertRaises(ValueError):F['observe'](api,plan,self.out)

    def test_late_publication_deadline_removes_only_uncommitted_projection(self):
        if F is None:self.skipTest('capability absent baseline')
        from unittest import mock
        receipt=self.closure_receipt();api,_=self.exact_api()
        globals_=F['_reconcile'].__globals__;original_append=globals_['_append']
        def late(*args,**kwargs):
            path=original_append(*args,**kwargs)
            if args[1]=='forensic-release-projection-':raise F['S']['BASE']['Deadline']('late publication alarm')
            return path
        with mock.patch.dict(globals_,{'_append':late}):
            with self.assertRaisesRegex(F['S']['BASE']['Deadline'],'late publication alarm'):
                F['reconcile'](self.admission,receipt,api)
        self.assertEqual(list(self.admission.glob('forensic-release-projection-*.json')),[],
                         'Timed-out recovery left a discoverable success projection')
        self.assertTrue(list(self.admission.glob('current-resource-observation-*.json')))
        self.assertEqual((self.admission/'native-release-audit.json').read_bytes(),self.original_bytes)

    def test_alarm_at_atomic_publication_link_rolls_back_exact_inode(self):
        if F is None:self.skipTest('capability absent baseline')
        import signal
        from unittest import mock
        receipt=self.closure_receipt();api,_=self.exact_api()
        os_module=F['_append'].__globals__.get('os',os);original_link=os_module.link
        def pending_alarm(source,target,*args,**kwargs):
            original_link(source,target,*args,**kwargs)
            if Path(target).name.startswith('forensic-release-projection-'):
                signal.raise_signal(signal.SIGALRM)
        with mock.patch.object(os_module,'link',side_effect=pending_alarm):
            with self.assertRaises(F['S']['BASE']['Deadline']):F['reconcile'](self.admission,receipt,api)
        self.assertEqual(list(self.admission.glob('forensic-release-projection-*.json')),[],
                         'Alarm at atomic publication escaped provisional inode custody')

    def test_canonical_cli_producer_and_consumer_use_loopback_only(self):
        if F is None:self.skipTest('capability absent baseline')
        import http.server, threading, subprocess, sys
        scripts=self.root/'cli-scripts';scripts.mkdir()
        for dependency in (BASE/'scripts').iterdir():
            if dependency.is_file():(scripts/dependency.name).symlink_to(dependency)
        for name in ('cloudbench-archived-owner-stop.py','cloudbench-forensic-resource-closure.py','cloudbench-native-release-audit.py'):
            path=scripts/name
            if path.exists():path.unlink()
            shutil.copy2(ROOT/'scripts'/name,path)
        requests=[];late_outer=[False]
        selected_terminal=dict(self.volume_identity,state='pending_destroy',attached_machine_id=self.mid)
        native_machines={'/v1/apps/navi-whisper-lux-bench/machines/'+m['id']:dict(m,state='destroyed') for m in (self.controller_identity,self.machine_identity,self.other_identity)}
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                app=self.path=='/v1/apps/navi-whisper-lux-bench'
                collection=self.path in ('/v1/apps/navi-whisper-lux-bench/machines','/v1/apps/navi-whisper-lux-bench/volumes')
                terminal=self.path=='/v1/apps/navi-whisper-lux-bench/volumes/vol_owned'
                value={'name':'navi-whisper-lux-bench'} if app else [] if collection else selected_terminal if terminal else native_machines.get(self.path,{'error':'not found'})
                self.send_response(200 if app or collection or terminal or self.path in native_machines else 404);self.end_headers();self.wfile.write(json.dumps(value).encode())
            def log_message(self,*args):pass
        server=http.server.HTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            import urllib.request, urllib.error, sys, io
            from contextlib import redirect_stdout
            from unittest import mock
            real_run_path=runpy.run_path
            class LoopbackAPI:
                def __init__(self,app,token):self.app=app;self.base='https://api.machines.dev'
                def api(self,method,path,body=None,timeout=20,observer=None):
                    # Test-only transport injection, no runtime alternate-provider bypass.
                    url='http://127.0.0.1:'+str(server.server_port)+'/v1/apps/'+self.app+path
                    try:
                        with urllib.request.urlopen(urllib.request.Request(url,method=method),timeout=timeout) as response:
                            payload=response.read()
                            if observer:observer(method,path,response.status,payload)
                            return json.loads(payload)
                    except urllib.error.HTTPError as error:
                        payload=error.read();observer(method,path,error.code,payload);raise
            def load(path,*args,**kwargs):
                module=real_run_path(path,*args,**kwargs)
                if str(path).endswith('cloudbench-original-volume-capture.py'):module['Fly']=LoopbackAPI
                if str(path).endswith('cloudbench-forensic-resource-closure.py') and late_outer[0]:
                    from contextlib import contextmanager
                    original_until=module['S']['until'];depth=[0]
                    @contextmanager
                    def late_guard(end):
                        depth[0]+=1
                        try:
                            with original_until(end):
                                yield
                                if depth[0]==1:raise module['S']['BASE']['Deadline']('late outer CLI alarm')
                        finally:depth[0]-=1
                    module['S']['until']=late_guard
                return module
            def invoke(argv):
                output=io.StringIO()
                with mock.patch.object(sys,'argv',argv),mock.patch('runpy.run_path',side_effect=load),redirect_stdout(output):
                    try:real_run_path(argv[0],run_name='__main__')
                    except SystemExit as error:self.assertEqual(error.code,0)
                return output.getvalue()
            agents=self.root/'agents.env';agents.write_text('FLY_API_TOKEN=offline-not-secret\n');agents.chmod(0o600)
            output=self.root/'cli-output'
            args=[str(scripts/'cloudbench-archived-owner-stop.py'),'--run-dir',str(self.run),'--inventory',str(self.inventory),'--out-dir',str(output),'--forensic-resource-closure','b'*32,'--agents-env',str(agents)]
            invoke(args);self.assertEqual(requests,[])
            invoke(args+['--execute'])
            receipt=next(output.glob('forensic-resource-closure-*.json'))
            consumed=invoke([str(scripts/'cloudbench-native-release-audit.py'),str(self.admission),'--forensic-closure',str(receipt),'--agents-env',str(agents)])
            self.assertTrue(json.loads(consumed)['current_physical_resource_release_verified'])
            self.assertFalse(json.loads(consumed)['all_resources_absent'])
            self.assertEqual(len(requests),13)
            committed=set(self.admission.glob('forensic-release-projection-*.json'))
            late_outer[0]=True
            with self.assertRaisesRegex(Exception,'late outer CLI alarm'):
                invoke([str(scripts/'cloudbench-native-release-audit.py'),str(self.admission),'--forensic-closure',str(receipt),'--agents-env',str(agents)])
            self.assertEqual(set(self.admission.glob('forensic-release-projection-*.json')),committed)
            late_outer[0]=False
            again=invoke([str(scripts/'cloudbench-native-release-audit.py'),str(self.admission),'--forensic-closure',str(receipt),'--agents-env',str(agents)])
            self.assertTrue(json.loads(again)['current_physical_resource_release_verified'])
            self.assertEqual(len(set(self.admission.glob('forensic-release-projection-*.json'))),2)
            self.assertEqual(len(requests),31)
            self.assertTrue(all(p.startswith('/v1/apps/navi-whisper-lux-bench') for p in requests))
            self.assertEqual((self.admission/'native-release-audit.json').read_bytes(),self.original_bytes)
        finally:server.shutdown();server.server_close();thread.join()


# Select only this extension's controls rather than inherited stop controls.
if __name__=='__main__':
    import sys
    names=sys.argv[1:] or ('test_runtime_capture_present_keeps_original_fact_through_full_consumer','test_runtime_capture_present_canonical_cli_remains_get_only','test_runtime_capture_fact_requires_strict_boolean_and_exact_plan','test_true_runtime_capture_fact_keeps_legacy_plan_shape','test_retained_canonical_cli_stays_get_only_and_preserves_late_deadline','test_retained_missing_guest_ack_only_observes_current_physical_state','test_retained_observation_requires_original_terminal_delete_and_matching_failure_facts','test_reporting_omitted_changed_writer_authority_terminal_inventory_refuse','test_reporting_asof_closure_removes_only_obsolete_recovery_action','test_reporting_missing_tampered_foreign_partial_future_proofs_keep_original_action','test_actual_destroyed_machine_shape_preserves_terminal_not_absent','test_destroyed_machine_wrong_incarnation_no_delete_and_live_refuse_with_private_wire','test_exact_absence_reconciles_without_rewriting_failed_original','test_live_unknown_and_wrong_binding_refuse','test_forged_receipt_and_incomplete_cohort_refuse','test_canonical_cli_producer_and_consumer_use_loopback_only','test_fullscope_soft_deleted_workspace_is_terminal_not_absent','test_fullscope_live_other_owner_hidden_from_list_refuses','test_fullscope_incomplete_export_unjoined_writer_and_timeout_refuse','test_existing_original_epoch_is_not_replaced_with_none','test_late_publication_deadline_removes_only_uncommitted_projection','test_selected_soft_terminal_uses_same_predicate_without_absence_credit','test_alarm_at_atomic_publication_link_rolls_back_exact_inode')
    suite=unittest.TestSuite(Forensic(name) for name in names)
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
