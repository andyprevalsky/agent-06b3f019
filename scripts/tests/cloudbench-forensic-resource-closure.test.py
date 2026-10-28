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
        self.reseal(self.members)
        export=self.run/'export'
        authority_sha=OLD['S']['digest_file'](self.run/'authority.private.json')
        workspace=dict(schema='cloudbench-controller-workspace-ownership-v1',app='navi-whisper-lux-bench',source_ref='a'*40,volume_id='vol_workspace',native_create=self.workspace_identity)
        OLD['write'](export/'workspace-volume.ownership.json',workspace)
        OLD['write'](export/'disposable-controller.ownership.json',dict(schema='cloudbench-disposable-controller-ownership-v1',authority_sha256=authority_sha,workspace_sha256=OLD['S']['digest_file'](export/'workspace-volume.ownership.json'),machine={'id':'11112222333344'},volume={'id':'vol_workspace'}))
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
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                app=self.path=='/v1/apps/navi-whisper-lux-bench'
                collection=self.path in ('/v1/apps/navi-whisper-lux-bench/machines','/v1/apps/navi-whisper-lux-bench/volumes')
                terminal=self.path=='/v1/apps/navi-whisper-lux-bench/volumes/vol_owned'
                self.send_response(200 if app or collection or terminal else 404);self.end_headers();self.wfile.write(b'{"name":"navi-whisper-lux-bench"}' if app else b'[]' if collection else json.dumps(selected_terminal).encode() if terminal else b'{"error":"not found"}')
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
    names=sys.argv[1:] or ('test_exact_absence_reconciles_without_rewriting_failed_original','test_live_unknown_and_wrong_binding_refuse','test_forged_receipt_and_incomplete_cohort_refuse','test_canonical_cli_producer_and_consumer_use_loopback_only','test_fullscope_soft_deleted_workspace_is_terminal_not_absent','test_fullscope_live_other_owner_hidden_from_list_refuses','test_fullscope_incomplete_export_unjoined_writer_and_timeout_refuse','test_existing_original_epoch_is_not_replaced_with_none','test_late_publication_deadline_removes_only_uncommitted_projection','test_selected_soft_terminal_uses_same_predicate_without_absence_credit','test_alarm_at_atomic_publication_link_rolls_back_exact_inode')
    suite=unittest.TestSuite(Forensic(name) for name in names)
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
