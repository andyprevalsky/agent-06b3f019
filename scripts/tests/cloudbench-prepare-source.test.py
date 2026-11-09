#!/usr/bin/env python3
"""Offline owning checks for private-source preparation; never contact providers."""
import copy
from datetime import datetime, timezone
import http.server
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = Path(__file__).resolve().parents[1]


class Preparation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = runpy.run_path(str(HERE / 'cloudbench-prepare-source.py'))

    def test_target_scope_excludes_protected_and_app_writes(self):
        allowed = self.m['allowed_call']
        for method, path in [('POST', '/machines/owned'), ('POST', '/machines/owned/exec'),
                             ('POST', '/machines/owned/lease'), ('DELETE', '/machines/owned/lease'),
                             ('POST', '/volumes/vol_owned/snapshots')]:
            self.assertTrue(allowed(method, path, 'owned', 'vol_owned'))
        for method, path in [('POST', '/secrets'), ('POST', '/machines'),
                             ('POST', '/machines/683e47df5094d8/stop'),
                             ('POST', '/machines/811d632f2650e8'),
                             ('DELETE', '/volumes/vol_owned'),
                             ('POST', '/machines/owned/metadata/x'),
                             ('POST', '/machines/owned/exec?escape=1')]:
            self.assertFalse(allowed(method, path, 'owned', 'vol_owned'))

    def test_guest_observation_must_match_installed_dependencies(self):
        request = dict(nonce='a'*32, source_ref='b'*40, node_fingerprint='c'*64,
                       python_fingerprint='d'*64, guest_env_sha256={'AGENTS_ENV_B64':'e'*64,
                       'BACKEND_ENV_B64':'f'*64}, native={'machine_id':'0123456789abcd',
                       'volume_id':'vol_owned'})
        observed = dict(schema='cloudbench-source-guest-v1', nonce=request['nonce'],
                        source_ref=request['source_ref'], machine_id=request['native']['machine_id'],
                        node_fingerprint='c'*64, python_fingerprint='d'*64,
                        installed_node='c'*64, installed_python='d'*64,
                        image_node_fingerprint='c'*64, image_python_fingerprint='d'*64,
                        guest_env_sha256=request['guest_env_sha256'], mount='/data',
                        guest_exit=0, started_epoch=10, finished_epoch=11,
                        job={'pid':42,'birth':'123','boot':'a'*36})
        self.m['verify_guest'](request, observed)
        for key in ('nonce', 'source_ref', 'machine_id', 'installed_node', 'installed_python', 'mount'):
            wrong = copy.deepcopy(observed); wrong[key] = 'wrong'
            with self.assertRaises(ValueError, msg=key):
                self.m['verify_guest'](request, wrong)
        wrong = copy.deepcopy(observed); wrong['guest_env_sha256']['AGENTS_ENV_B64']='0'*64
        with self.assertRaises(ValueError): self.m['verify_guest'](request, wrong)

    def test_native_scope_journal_refuses_foreign_even_if_final_state_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            row=dict(method='POST',path='/machines/683e47df5094d8/stop',status=200)
            (root/'0001.json').write_text(json.dumps(row))
            with self.assertRaises(ValueError):
                self.m['verify_scope']([row], 'owned', 'vol_owned')


class NativeLifecycle(unittest.TestCase):
    def setUp(self):
        self.m = runpy.run_path(str(HERE / 'cloudbench-prepare-source.py'))
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.owner = 'a'*32; self.mid = '0123456789abcd'; self.vid = 'vol_owned'
        self.image = 'registry.fly.io/navi-whisper-lux-bench@sha256:'+'e'*64
        self.shared = dict(id='683e47df5094d8', name='cloudbench-warm',
                           config={'mounts':[{'volume':'vol_vwnym366kn7k8mmv','path':'/data'}]})
        self.config = dict(image=self.image, env={'SOURCE_ENV':'same'},
                           guest={'cpu_kind':'shared','cpus':1,'memory_mb':2048},
                           mounts=[{'volume':self.vid,'path':'/data'}], restart={'policy':'no'},
                           init={'cmd':['sleep','infinity']}, auto_destroy=False,
                           metadata={'cloudbench_source_owner':self.owner})
        self.machine = dict(id=self.mid, name='cloudbench-source-'+self.owner, state='stopped',
                            region='iad', instance_id='OLD1', config=copy.deepcopy(self.config),
                            image_ref={'digest':'sha256:'+'e'*64})
        self.volume = dict(id=self.vid,region='iad',state='created',size_gb=40,attached_machine_id=self.mid)
        now=int(time.time())
        self.snapshots=[dict(id='vs_old',status='created',size=100,digest='1'*64,
                            created_at=datetime.fromtimestamp(now,timezone.utc).isoformat())]
        self.manifest=dict(version=1,app='navi-whisper-lux-bench',owner_token=self.owner,
                           machine_id=self.mid,instance_id='OLD1',machine_name=self.machine['name'],
                           volume_id=self.vid,region='iad',image_digest='sha256:'+'e'*64,
                           snapshot_id='vs_old',node_fingerprint='b'*64,python_fingerprint='c'*64,
                           verified_at=now,shared_machine_id=self.shared['id'],shared_volume_id='vol_vwnym366kn7k8mmv')
        self.write('predecessor.json', self.manifest)
        ref=subprocess.check_output(['git','-C',str(HERE.parent),'rev-parse','HEAD'],text=True).strip()
        self.write('build.json',dict(schema='cloudbench-image-build-v1',image_ref=self.image,source_sha=ref,
                                     source_dirty=False))
        self.request=dict(schema=self.m['REQUEST'],nonce='d'*32,source_root=str(HERE.parent),source_ref=ref,
                          image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64,
                          predecessor=self.desc('predecessor.json'),build=self.desc('build.json'),
                          native=dict(machine_id=self.mid,volume_id=self.vid,instance_id='OLD1',
                                      config_sha256=self.m['sha'](self.m['canonical'](self.config)),
                                      env_sha256=self.m['sha'](self.m['canonical'](self.config['env']))),
                          guest_env_sha256={'AGENTS_ENV_B64':'f'*64,'BACKEND_ENV_B64':'0'*64},
                          protected_resources={'683e47df5094d8':'vol_vwnym366kn7k8mmv','811d632f2650e8':'vol_r1jde9donnx2mn9r'},
                          scripts={member:self.m['sha'](self.m['source_bytes'](HERE.parent,ref,member))
                                   for member in ('cloudbench-fetch-ref.sh','lib/cloudbench-env.sh','cloudbench-sync-deps.sh')})
        # Original creator authority fixture: independent from any source-manifest claim.
        creator=runpy.run_path(str(HERE/'cloudbench-prepare-source-create.py'))
        journal=self.root/'create';journal.mkdir(mode=0o700)
        donor=dict(machine_id=self.shared['id'],volume_id='vol_vwnym366kn7k8mmv',region='iad',image=self.image,
                   env=self.config['env'],size_gb=40,snapshot=self.snapshots[0],
                   dependency_proof=dict(node_fingerprint='b'*64,python_fingerprint='c'*64,verified_at=now))
        binding=dict(app='navi-whisper-lux-bench',owner_token=self.owner,donor_machine_id=donor['machine_id'],
                     donor_volume_id=donor['volume_id'],snapshot_id='vs_old',parked_memory=2048)
        volume_request=dict(name='cbs_'+self.owner[:26],region='iad',size_gb=40,snapshot_id='vs_old',
                            compute=dict(cpu_kind='shared',cpus=1,memory_mb=2048),compute_image=self.image)
        intent=dict(version=1,binding=binding,nonce='6'*32,donor=donor,volume_request=volume_request)
        self.config=creator['machine_config'](intent,self.vid)
        self.machine['config']=copy.deepcopy(self.config)
        machine_request=dict(name=self.machine['name'],region='iad',config=self.config,skip_launch=True)
        creator['save'](journal/'intent.json',intent)
        for kind,request,response in [('volume',volume_request,dict(self.volume,name=volume_request['name'],attached_machine_id=None)),
                                      ('machine',machine_request,self.machine)]:
            creator['save'](journal/(kind+'.pending.json'),creator['envelope'](intent,dict(request=request)))
            creator['save'](journal/(kind+'.created.json'),creator['envelope'](intent,dict(id=response['id'],instance_id=response.get('instance_id'),request_sha256=creator['sha'](request),response=response)))
        receipt=creator['envelope'](intent,dict(outcome='ready-for-prepare',app=binding['app'],machine_id=self.mid,
            volume_id=self.vid,instance_id=self.machine['instance_id'],machine_name=self.machine['name'],
            donor_machine_id=donor['machine_id'],donor_volume_id=donor['volume_id'],snapshot_id='vs_old',
            journal=str(journal),journal_sha256=creator['authority_digest'](journal)))
        creator['save'](journal/'result.json',receipt)
        self.request.pop('predecessor')
        self.request['ownership']=self.m['descriptor'](journal/'result.json')
        self.request['native']['config_sha256']=self.m['sha'](self.m['canonical'](self.config))
        self.calls=[];self.nonce=None;self.fault=None;self.foreign_changes=0
        outer=self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self): self.handle_request('GET')
            def do_POST(self): self.handle_request('POST')
            def do_DELETE(self): self.handle_request('DELETE')
            def handle_request(self,method):
                path=self.path.split('/v1/apps/navi-whisper-lux-bench',1)[-1]
                raw=self.rfile.read(int(self.headers.get('Content-Length',0)))
                body=json.loads(raw) if raw else None
                nonce=self.headers.get('fly-machine-lease-nonce')
                outer.calls.append((method,path,copy.deepcopy(body),nonce))
                try:
                    status,value=outer.handle(method,path,body,nonce)
                except Exception as error:
                    status,value=500,{'error':type(error).__name__}
                raw=json.dumps(value).encode()
                self.send_response(status);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        self.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever);self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown();self.thread.join();self.server.server_close()

    def write(self,name,value):
        self.m['save'](self.root/name,value)

    def desc(self,name): return self.m['descriptor'](self.root/name)

    def handle(self,method,path,body,nonce):
        own='/machines/'+self.mid
        self.foreign_changes+=1  # Peers change on every read/write; no app-wide equality required.
        if method=='GET':
            if path==own: return 200,self.machine
            if path=='/machines/'+self.shared['id']: return 200,self.shared
            if path=='/volumes/'+self.vid: return 200,self.volume
            if path=='/volumes/'+self.vid+'/snapshots': return 200,self.snapshots
            return 403,{}
        if path==own+'/lease':
            if method=='POST':
                if self.nonce is not None and nonce!=self.nonce:return 409,{}
                self.nonce='lease-private';return 201,{'data':{'nonce':self.nonce}}
            if method=='DELETE' and nonce==self.nonce:
                self.nonce=None;return 200,{}
            return 409,{}
        if nonce!=self.nonce or nonce is None:return 409,{}
        if method=='POST' and path==own:
            if body['current_version']!=self.machine['instance_id'] or self.fault=='cas':return 409,{}
            self.machine['config']=copy.deepcopy(body['config']);self.machine['instance_id']='NEW'+str(sum(1 for method,path,body,nonce in self.calls if method=='POST' and path==own))
            self.machine['image_ref']['digest']=body['config']['image'].rsplit('@',1)[1]
            return 200,self.machine
        if method=='POST' and path in (own+'/start',own+'/stop'):
            self.machine['state']='started' if path.endswith('/start') else 'stopped';return 200,{}
        if method=='POST' and path==own+'/exec':
            job=dict(pid=42,birth='123',boot='a'*36)
            delivery=re.search(r'CLOUDBENCH-DELIVERY:[0-9]+',body['command'][-1])
            if delivery:return 200,{'exit_code':0,'stdout':delivery.group(0)+'\n'}
            if 'subprocess.Popen' in body['command'][-1]:return 200,{'exit_code':0,'stdout':json.dumps(job)}
            guest=dict(schema='cloudbench-source-guest-v1',nonce=self.request['nonce'],source_ref=self.request['source_ref'],
                       machine_id=self.mid,node_fingerprint=self.request['node_fingerprint'],
                       python_fingerprint=self.request['python_fingerprint'],installed_node=self.request['node_fingerprint'],
                       image_node_fingerprint=self.request['node_fingerprint'],image_python_fingerprint=self.request['python_fingerprint'],
                       installed_python=self.request['python_fingerprint'],guest_env_sha256=self.request['guest_env_sha256'],
                       mount='/data',guest_exit=0,started_epoch=int(time.time()),finished_epoch=int(time.time()),job=job)
            if 'transport' in self.request:
                guest['transport']={key:self.request['transport'][key] for key in ('base_sha','workspace_patch_sha256','replayed_tree')}
            if self.fault=='deps':guest['installed_node']='9'*64
            if self.fault=='env':guest['guest_env_sha256']=dict(guest['guest_env_sha256'],AGENTS_ENV_B64='8'*64)
            return 200,{'exit_code':0,'stdout':json.dumps(guest)}
        if method=='POST' and path=='/volumes/'+self.vid+'/snapshots':
            row=dict(id='vs_new',status='created',size=101,digest='2'*64,created_at=datetime.now(timezone.utc).isoformat())
            self.snapshots.append(row);return 201,row
        return 403,{}

    def invoke(self):
        self.write('request.json',self.request)
        env=dict(os.environ,FLY_API_TOKEN='fixture-private',FLY_API_HOSTNAME=f'http://127.0.0.1:{self.server.server_port}')
        # Existing raw API resolves a flyctl binary even with a bearer credential.
        binary=self.root/'flyctl';binary.write_text('#!/bin/sh\nexit 97\n');binary.chmod(0o700)
        env['PATH']=str(self.root)+os.pathsep+env['PATH']
        return subprocess.run([sys.executable,str(HERE/'cloudbench-prepare-source.py'),'--request',str(self.root/'request.json'),
                               '--output',str(self.root/'output')],env=env,capture_output=True,text=True,timeout=35)

    def test_real_cli_bounded_transport_full_chain_with_foreign_churn(self):
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        manifest=self.m['verify_prepared_source'](self.root/'request.json',self.root/'output/result.json',self.root/'output/source-manifest.json',
            source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        self.assertEqual(manifest['machine_id'],self.mid);self.assertEqual(manifest['snapshot_id'],'vs_new')
        self.assertEqual(self.machine['state'],'stopped');self.assertIsNone(self.nonce)
        self.assertGreater(self.foreign_changes,10)
        self.assertTrue(all(self.m['allowed_call'](method,path,self.mid,self.vid,(self.shared['id'],))
                            for method,path,body,nonce in self.calls))

    def test_guest_dependency_failure_stops_owned_target_and_emits_failed_receipt(self):
        self.fault='deps';result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.machine['state'],'stopped');self.assertIsNone(self.nonce)
        receipt=self.m['load'](self.root/'output/result.json')
        self.assertFalse(receipt['qualified']);self.assertTrue(receipt['stopped_verified'])
        self.assertFalse((self.root/'output/source-manifest.json').exists())

    def test_independent_new_set_publishes_observed_set_instead_of_donor(self):
        self.request['node_fingerprint']='4'*64;self.request['python_fingerprint']='5'*64
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        successor=self.m['verify_prepared_source'](self.root/'request.json',self.root/'output/result.json',
            self.root/'output/source-manifest.json',source_ref=self.request['source_ref'],image_ref=self.image,
            node_fingerprint='4'*64,python_fingerprint='5'*64)
        self.assertEqual(successor['node_fingerprint'],'4'*64)
        self.assertEqual(successor['python_fingerprint'],'5'*64)

    def test_exact_source_patch_contract_reconstructs_and_attests_tree(self):
        patch=self.root/'workspace.patch'
        patch.write_text('diff --git a/scripts/private-source-probe b/scripts/private-source-probe\nnew file mode 100644\n--- /dev/null\n+++ b/scripts/private-source-probe\n@@ -0,0 +1 @@\n+owned source transport probe\n')
        patch.chmod(0o600)
        env=dict(os.environ,GIT_INDEX_FILE=str(self.root/'replay.index'))
        git=['git','-C',str(HERE.parent)]
        subprocess.run(git+['read-tree',self.request['source_ref']],env=env,check=True)
        subprocess.run(git+['apply','--cached','--binary',str(patch)],env=env,check=True)
        tree=subprocess.check_output(git+['write-tree'],env=env,text=True).strip()
        self.request['transport']=dict(sealed_at=time.time(),token=self.request['nonce'],
            source=dict(head=self.request['source_ref'],digest='8'*64),workspace_root=str(HERE.parent),
            base_sha=self.request['source_ref'],workspace_patch_sha256=self.m['sha'](patch.read_bytes()),
            patch=str(patch),replayed_tree=tree)
        self.request['scripts']['cloudbench-prepare-patch.sh']=self.m['sha'](self.m['source_bytes'](HERE.parent,tree,'cloudbench-prepare-patch.sh'))
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        self.m['verify_prepared_source'](self.root/'request.json',self.root/'output/result.json',self.root/'output/source-manifest.json',
            source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)

    def test_stale_cas_never_starts_or_snapshots(self):
        self.fault='cas';result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(path.endswith(('/start','/exec','/snapshots')) and method=='POST' for method,path,body,nonce in self.calls))

    def test_environment_mismatch_fails_closed(self):
        self.fault='env';result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.machine['state'],'stopped')

    def test_protected_volume_alias_refuses_before_any_native_io(self):
        self.request['protected_resources']['811d632f2650e8']=self.vid
        result=self.invoke();self.assertNotEqual(result.returncode,0);self.assertEqual(self.calls,[])

    def test_wrong_protected_mapping_refuses_before_native_construction(self):
        for index, identity in enumerate(self.m['PROTECTED_RESOURCES']):
            with self.subTest(machine=identity):
                request=copy.deepcopy(self.request)
                request['protected_resources'][identity]='vol_wrong'
                request_path=self.root/('wrong-protected-'+str(index)+'.json')
                self.m['save'](request_path,request)
                def factory(*args):
                    raise AssertionError('native constructed for wrong protected mapping')
                with self.assertRaisesRegex(ValueError,'exact protected Machine/Volume bindings'):
                    self.m['prepare'](request_path,self.root/('wrong-protected-output-'+str(index)),factory)
                self.assertFalse((self.root/('wrong-protected-output-'+str(index))).exists())
                self.assertEqual(self.calls,[])

    def test_real_subprocess_chunk_transport_does_not_exceed_linux_argument_limit(self):
        program=self.m['guest_program'](self.request)
        compile(program,'guest-worker','exec')
        self.assertGreater(len(program.encode()),128*1024)
        raw=('import hashlib\npayload='+repr(program)+'\nprint(hashlib.sha256(payload.encode()).hexdigest())\n').encode()
        directory=self.root/'delivery'
        for command,expected in self.m['delivery_commands'](raw,directory):
            self.assertLess(max(len(arg.encode()) for arg in command),32768)
            result=subprocess.run(command,capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout.strip(),expected)
        result=subprocess.run([sys.executable,str(directory/'worker.py')],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout.strip(),self.m['sha'](program.encode()))

    def test_resealed_semantic_journal_tampering_is_rejected(self):
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        result_path=self.root/'output/result.json'; original_result=result_path.read_bytes()
        requests=list((self.root/'output/native').glob('*/request.json'))
        controls=[]
        for path in requests:
            sent=self.m['load'](path)
            if sent['method']=='POST' and sent['path']=='/machines/'+self.mid:
                wrong=copy.deepcopy(sent);wrong['body']['current_version']='forged-version';controls.append((path,wrong))
            if sent['method']=='POST' and sent['path'].endswith('/exec') and not any(v['path'].endswith('/exec') for p,v in controls):
                wrong=copy.deepcopy(sent);wrong['headers']={};controls.append((path,wrong))
        self.assertGreaterEqual(len(controls),2)
        for path,wrong in controls:
            original=path.read_bytes()
            try:
                path.write_text(json.dumps(wrong))
                receipt=json.loads(original_result);receipt['journal']=self.m['journal_index'](self.root/'output/native')
                result_path.write_text(json.dumps(receipt))
                with self.assertRaises(ValueError):
                    self.m['verify_prepared_source'](self.root/'request.json',result_path,self.root/'output/source-manifest.json',
                        source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
            finally:
                path.write_bytes(original);result_path.write_bytes(original_result)

    def test_wrong_mount_refuses_before_image_start(self):
        self.machine['config']['mounts']=[{'volume':'vol_foreign','path':'/data'}]
        result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(method=='POST' and path=='/machines/'+self.mid for method,path,body,nonce in self.calls))

    def test_before_effects_origin_callback_precedes_api_construction(self):
        self.write('request.json',self.request)
        seen=[]
        def anchor(path):
            origin=self.m['load'](path)
            self.assertEqual(origin['producer']['pid'],os.getpid());seen.append(origin)
            raise RuntimeError('fixture anchor refusal')
        def factory(*args): raise AssertionError('native constructed before refused parent anchor')
        with self.assertRaisesRegex(RuntimeError,'anchor refusal'):
            self.m['prepare'](self.root/'request.json',self.root/'anchored',factory,before_effects=anchor)
        self.assertEqual(len(seen),1);self.assertEqual(self.calls,[])

    def test_expired_native_lease_cannot_be_renewed_or_used(self):
        api=object.__new__(self.m['ScopedNative']);api.lost=False;api.nonce='owned';api.lease_end=time.monotonic()+1
        with self.assertRaises(ValueError):api.renew()


if __name__ == '__main__': unittest.main()
