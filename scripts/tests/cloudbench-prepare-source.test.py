#!/usr/bin/env python3
"""Offline owning checks for private-source preparation; never contact providers."""
import copy
from datetime import datetime, timezone
import http.server
import json
import os
from pathlib import Path
import re
import shlex
import runpy
import subprocess
import shutil
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

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

    def test_guest_environment_observation_uses_pinned_semantics_without_secret_values(self):
        namespace={};exec(self.m['SAFE_ENV_OBSERVER'],namespace)
        raw=b'export BROWSER_PROVIDER="steel"\nTEMPORAL_NAMESPACE="private-namespace"\nAPI_KEY=private-value\n'
        encoded=self.m['base64'].b64encode(raw).decode()
        blobs={key:' \n'+encoded[:12]+'\t'+encoded[12:]+'\r\n' for key in ('AGENTS_ENV_B64','BACKEND_ENV_B64')}
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{
                'CLOUDBENCH_BROWSER_PROVIDER':'steel','CLOUDBENCH_WORKER_BROWSER_PROVIDER':'steel'}):
            value=namespace['observe_guest_environment'](blobs,directory,HERE/'lib/cloudbench-env.sh')
            self.assertTrue(value['provider_contract_verified'])
            for item in value['blobs'].values():
                self.assertTrue(item['decoded_valid']);self.assertEqual(item['decoded_sha256'],self.m['sha'](raw))
                self.assertEqual(item['provider']['value'],'steel')
                self.assertEqual(item['namespace_sha256'],self.m['sha'](b'private-namespace'))
            text=json.dumps(value);self.assertNotIn('private-value',text);self.assertNotIn('private-namespace',text)
        with tempfile.TemporaryDirectory() as directory:
            invalid=namespace['observe_guest_environment']({'AGENTS_ENV_B64':'%%%','BACKEND_ENV_B64':'%%%'},directory,HERE/'lib/cloudbench-env.sh')
            self.assertFalse(invalid['provider_contract_verified'])
            self.assertTrue(all(not item['decoded_valid'] for item in invalid['blobs'].values()))


class NativeLifecycle(unittest.TestCase):
    def setUp(self):
        self.m = runpy.run_path(str(HERE / 'cloudbench-prepare-source.py'))
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.owner = getattr(self,'fixture_owner','a'*32); self.mid = '0123456789abcd'; self.vid = 'vol_owned'
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
            config_sha256=self.m['sha'](self.m['canonical'](self.config)),
            env_sha256=self.m['sha'](self.m['canonical'](self.config.get('env') or {})),
            journal=str(journal),journal_sha256=creator['authority_digest'](journal)))
        creator['save'](journal/'result.json',receipt)
        self.request.pop('predecessor')
        self.request['ownership']=self.m['descriptor'](journal/'result.json')
        self.request['native']['config_sha256']=self.m['sha'](self.m['canonical'](self.config))
        self.calls=[];self.nonce=None;self.fault=None;self.foreign_changes=0
        self.transition_reads=[]
        self.lease_version=None
        self.enforce_exec_version=False
        self.remote_parent=self.root/'guest-data/.cloudbench-private'
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
        if path=='/_test_ssh':
            args=body['args']
            if args[:3]==['ssh','sftp','put']:
                if args[3:10]!=['-a','navi-whisper-lux-bench','--machine',self.mid,'-q','-m','0600']:return 403,{}
                if self.fault=='sftp-unknown':return 503,{}
                remote=Path(args[11].replace('/data/.cloudbench-private',str(self.remote_parent)))
                shutil.copyfile(args[10],remote);remote.chmod(0o600)
                if self.fault=='capsule-inode':
                    raw=remote.read_bytes();remote.rename(remote.with_name(remote.name+'.old-inode'))
                    remote.write_bytes(raw);remote.chmod(0o600)
                return 200,dict(exit_code=0,stdout='',stderr='')
            if args[:6]!=['ssh','console','-a','navi-whisper-lux-bench','--machine',self.mid] or args[6]!='-C':return 403,{}
            argv=shlex.split(args[7])
            if argv[:3]!=['timeout','--signal=TERM','5s'] or self.lease_version!=self.machine['instance_id'] or not self.nonce:return 409,{}
            if self.fault=='ssh-failed':return 503,{}
            if 'cloudbench-capsule-stage-v1' in argv[-1] or 'cloudbench-capsule-published-v1' in argv[-1]:
                # Model guest root with the test process's UID on its real private filesystem.
                self.remote_parent.parent.mkdir(exist_ok=True)
                code=argv[-1].replace('/data/.cloudbench-private',str(self.remote_parent)).replace('s.st_uid==0','s.st_uid==os.getuid()').replace('a.st_uid==0','a.st_uid==os.getuid()')
                result=subprocess.run([sys.executable,'-c',code],capture_output=True,text=True,timeout=5)
                if result.returncode:return 200,dict(exit_code=result.returncode,stdout='',stderr='guest-staging-refused')
                value=json.loads(result.stdout)
                value['path']=value['path'].replace(str(self.remote_parent),'/data/.cloudbench-private')
                if 'uid' in value:value['uid']=0
                return 200,dict(exit_code=0,stdout=json.dumps(value),stderr='')
            status,answer=self.handle('POST',own+'/exec',dict(command=argv[3:],timeout=5),self.nonce)
            self.volume['bytes_used']=self.volume.get('bytes_used',0)+1024
            self.machine['events']=[{'type':'fixture-observation','sequence':self.foreign_changes}]
            self.machine['updated_at']=str(self.foreign_changes)
            if self.fault=='ssh-mount-drift':self.machine['config']['mounts'][0]['volume']='vol_foreign'
            return status,answer
        self.foreign_changes+=1  # Peers change on every read/write; no app-wide equality required.
        if method=='GET':
            if path==own: return 200,self.transition_reads.pop(0) if self.transition_reads else self.machine
            if path=='/machines/'+self.shared['id']: return 200,self.shared
            if path=='/volumes/'+self.vid: return 200,self.volume
            if path=='/volumes/'+self.vid+'/snapshots': return 200,self.snapshots
            return 403,{}
        if path==own+'/lease':
            if method=='POST':
                if self.nonce is not None and nonce!=self.nonce:return 409,{}
                self.nonce='lease-private';self.lease_version=self.machine['instance_id']
                version='wrong-version' if self.fault=='lease-version-wrong' and nonce else self.lease_version
                return 201,{'data':{'nonce':self.nonce,'version':version}}
            if method=='DELETE' and nonce==self.nonce:
                self.nonce=None;return 200,{}
            return 409,{}
        if nonce!=self.nonce or nonce is None:return 409,{}
        if method=='POST' and path==own:
            if body['current_version']!=self.machine['instance_id'] or self.fault=='cas':return 409,{}
            old=copy.deepcopy(self.machine)
            self.machine['config']=copy.deepcopy(body['config']);self.machine['instance_id']='NEW'+str(sum(1 for method,path,body,nonce in self.calls if method=='POST' and path==own))
            self.machine['image_ref']['digest']=body['config']['image'].rsplit('@',1)[1]
            if self.fault in ('transition','third-instance','third-config'):
                prior=dict(old,state='replacing')
                if self.fault=='third-instance':prior['instance_id']='UNKNOWN3'
                if self.fault=='third-config':prior['config']['env']['FOREIGN']='unknown'
                self.transition_reads=[prior]
            return 200,self.machine
        if method=='POST' and path in (own+'/start',own+'/stop'):
            self.machine['state']='started' if path.endswith('/start') else 'stopped';return 200,{}
        if method=='POST' and path==own+'/exec':
            if not isinstance(body.get('command'),list) or not all(isinstance(v,str) for v in body['command']):return 400,{}
            if self.enforce_exec_version and self.lease_version!=self.machine['instance_id']:
                return 409,{'error':'aborted: machine lease currently held by fixture-token'}
            if self.fault=='first-exec-409':return 409,{'error':'aborted: machine lease currently held by fixture-token'}
            job=dict(pid=42,birth='123',boot='a'*36)
            delivery=re.search(r'CLOUDBENCH-DELIVERY:[0-9]+',body['command'][-1])
            if delivery:return 200,{'exit_code':0,'stdout':delivery.group(0)+'\n'}
            if 'subprocess.Popen' in body['command'][-1]:return 200,{'exit_code':0,'stdout':json.dumps(job)}
            if self.fault=='guest-env-failure':
                failure=dict(schema='cloudbench-source-guest-v1',nonce=self.request['nonce'],guest_exit=1,
                    error='AssertionError',phase='preconditions',job=job,started_epoch=int(time.time()),finished_epoch=int(time.time()),
                    preconditions=dict(euid=0,machine_id=self.mid,data_mount=True,repo_physical='/data/repo',git_dir=True,
                        env_present={key:True for key in self.request['guest_env_sha256']},
                        guest_env_sha256={key:'7'*64 for key in self.request['guest_env_sha256']}))
                return 200,dict(exit_code=0,stdout=json.dumps(failure))
            guest=dict(schema='cloudbench-source-guest-v1',nonce=self.request['nonce'],source_ref=self.request['source_ref'],
                       machine_id=self.mid,node_fingerprint=self.request['node_fingerprint'],
                       python_fingerprint=self.request['python_fingerprint'],installed_node=self.request['node_fingerprint'],
                       image_node_fingerprint=self.request['node_fingerprint'],image_python_fingerprint=self.request['python_fingerprint'],
                       installed_python=self.request['python_fingerprint'],guest_env_sha256=self.request['guest_env_sha256'],
                       mount='/data',guest_exit=0,started_epoch=int(time.time()),finished_epoch=int(time.time()),job=job)
            if 'transport' in self.request:
                guest['transport']={key:self.request['transport'][key] for key in ('base_sha','workspace_patch_sha256','replayed_tree')}
            if self.request.get('guest_env_mode')==self.m['OWNED_MODE']:
                owned=self.m['owned_manifest'](self.request,dict(owner_token=self.owner,creation_nonce='6'*32))
                guest.update({key:owned[key] for key in self.m['OWNED_FIELDS']})
            if self.fault=='deps':guest['installed_node']='9'*64
            if self.fault=='env':guest['guest_env_sha256']=dict(guest['guest_env_sha256'],AGENTS_ENV_B64='8'*64)
            return 200,{'exit_code':0,'stdout':json.dumps(guest)}
        if method=='POST' and path=='/volumes/'+self.vid+'/snapshots':
            row=dict(id='vs_new',status='created',size=101,digest='2'*64,created_at=datetime.now(timezone.utc).isoformat())
            self.snapshots.append(row);return 201,row
        return 403,{}

    def invoke(self,request_name='request.json',output_name='output'):
        self.write(request_name,self.request)
        env=dict(os.environ,FLY_API_TOKEN='fixture-private',FLY_API_HOSTNAME=f'http://127.0.0.1:{self.server.server_port}')
        # Existing raw API resolves a flyctl binary even with a bearer credential.
        binary=self.root/'flyctl'
        binary.write_text('''#!/usr/bin/env python3
import json,os,sys,urllib.request
args=sys.argv[1:]
assert (len(args)==8 and args[:2]==['ssh','console']) or (len(args)==12 and args[:3]==['ssh','sftp','put'])
assert max(len(a.encode()) for a in args)<32768
request=urllib.request.Request(os.environ['FLY_API_HOSTNAME']+'/v1/apps/navi-whisper-lux-bench/_test_ssh',data=json.dumps({'args':args}).encode(),headers={'Content-Type':'application/json'})
try:
 with urllib.request.urlopen(request,timeout=10) as response:value=json.load(response)
except Exception:sys.exit(71)
sys.stdout.write(value.get('stdout',''));sys.stderr.write(value.get('stderr',''));sys.exit(value.get('exit_code',1))
''');binary.chmod(0o700)
        env['PATH']=str(self.root)+os.pathsep+env['PATH']
        return subprocess.run([sys.executable,str(HERE/'cloudbench-prepare-source.py'),'--request',str(self.root/request_name),
                               '--output',str(self.root/output_name)],env=env,capture_output=True,text=True,timeout=35)

    def test_request_builder_fingerprints_oversized_git_pinned_helper_with_real_bash(self):
        root=self.root/'fingerprint-source';root.mkdir()
        for member in ('package.json','back-end/package.json','back-end/package-lock.json','front-end/package.json',
                       'agents/requirements.txt','scripts/cloudbench-fetch-ref.sh','scripts/cloudbench-sync-deps.sh'):
            target=root/member;target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes((HERE.parent/member).read_bytes())
        helper=root/'scripts/lib/cloudbench-env.sh';helper.parent.mkdir()
        original=(HERE/'lib/cloudbench-env.sh').read_bytes()
        expected=subprocess.check_output(['bash','-euc',
            'source "$1"; cloudbench_node_dependency_fingerprint "$2"; cloudbench_manifest_fingerprint "$2" "${CLOUDBENCH_PYTHON_MANIFESTS[@]}"',
            'fingerprint-oracle',str(HERE/'lib/cloudbench-env.sh'),str(root)],text=True,timeout=20).splitlines()
        helper.write_bytes(original+b'\n#'+b'oversized pinned helper padding '*5000+
            b'\ntest "$(stat -c %a "${BASH_SOURCE[0]}")" = 600\n')
        self.assertGreater(helper.stat().st_size,131072)
        git=['git','-C',str(root)]
        subprocess.run(git+['init','-q'],check=True)
        subprocess.run(git+['add','.'],check=True)
        subprocess.run(git+['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','pinned oversized helper'],check=True)
        ref=subprocess.check_output(git+['rev-parse','HEAD'],text=True).strip()
        self.write('fingerprint-build.json',dict(schema='cloudbench-image-build-v1',image_ref=self.image,source_sha=ref,source_dirty=False))
        self.write('fingerprint-env.json',self.request['guest_env_sha256'])
        self.write('fingerprint-protected.json',self.request['protected_resources'])
        value=self.m['build_request'](self.request['ownership']['path'],self.root/'fingerprint-build.json',root,ref,
            self.root/'fingerprint-env.json',self.root/'fingerprint-protected.json',self.root/'fingerprint-request.json')
        self.assertEqual([value['node_fingerprint'],value['python_fingerprint']],expected)
        self.assertEqual(value['scripts']['lib/cloudbench-env.sh'],self.m['sha'](helper.read_bytes()))
        self.assertFalse(self.calls)

    def test_real_cli_bounded_transport_full_chain_with_foreign_churn(self):
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        manifest=self.m['verify_prepared_source'](self.root/'request.json',self.root/'output/result.json',self.root/'output/source-manifest.json',
            source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        self.assertEqual(manifest['machine_id'],self.mid);self.assertEqual(manifest['snapshot_id'],'vs_new')
        self.assertEqual(manifest['guest_env_sha256'],self.request['guest_env_sha256'])
        self.assertEqual(self.machine['state'],'stopped');self.assertIsNone(self.nonce)
        self.assertGreater(self.foreign_changes,10)
        self.assertTrue(all(self.m['allowed_call'](method,path,self.mid,self.vid,(self.shared['id'],))
                            for method,path,body,nonce in self.calls))

    def test_ssh_cli_full_chain_and_typed_receipts_refuse_target_nonce_or_output_tamper(self):
        self.request['guest_transport']='cloudbench-ssh-guest-v1';self.enforce_exec_version=True
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        path=self.root/'output/result.json';receipt=self.m['load'](path)
        def verify():return self.m['verify_prepared_source'](self.root/'request.json',path,self.root/'output/source-manifest.json',
            source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        verify()
        self.assertFalse(any(method=='POST' and p.endswith('/exec') for method,p,body,nonce in self.calls))
        target=next((self.root/'output/ssh').glob('*/request.json'));raw=target.read_bytes()
        answer_path=target.parent/'result.json';answer_raw=answer_path.read_bytes()
        for field in ('target','nonce','instance','mount'):
            wrong=json.loads(raw)
            if field=='target':wrong['argv'][5]='ffffffffffffff'
            elif field=='nonce':wrong['nonce']='foreign'
            elif field=='instance':wrong['instance_id']='UNKNOWN'
            else:wrong['before']['config']['mounts'][0]['volume']='vol_foreign'
            target.write_text(json.dumps(wrong))
            answer=json.loads(answer_raw);answer['request']=self.m['descriptor'](target);answer_path.write_text(json.dumps(answer))
            altered=copy.deepcopy(receipt);altered['ssh']=self.m['journal_index'](self.root/'output/ssh');path.write_text(json.dumps(altered))
            with self.assertRaises(ValueError):verify()
        target.write_bytes(raw);answer_path.write_bytes(answer_raw);path.write_text(json.dumps(receipt))
        answer=self.m['load'](target.parent/'result.json');log=Path(answer['stdout']['path']);log.write_text('forged-output')
        answer['stdout']=self.m['descriptor'](log);answer_path.write_text(json.dumps(answer))
        receipt['ssh']=self.m['journal_index'](self.root/'output/ssh');path.write_text(json.dumps(receipt))
        with self.assertRaises(ValueError):verify()

    def test_ssh_native_mount_drift_refuses_and_never_publishes(self):
        self.request['guest_transport']='cloudbench-ssh-guest-v1';self.fault='ssh-mount-drift'
        result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.root/'output/source-manifest.json').exists())

    def test_ssh_failed_command_is_not_retried_and_owned_source_is_parked(self):
        self.request['guest_transport']='cloudbench-ssh-guest-v1';self.fault='ssh-failed'
        result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertEqual(sum(path=='/_test_ssh' for method,path,body,nonce in self.calls),1)
        self.assertEqual(self.machine['state'],'stopped');self.assertIsNone(self.nonce)
        self.assertEqual(self.machine['config']['guest']['memory_mb'],2048)
        receipt=self.m['load'](self.root/'output/result.json')
        self.assertFalse(receipt['qualified']);self.assertTrue(receipt['stopped_verified'])

    def owned_capsule_request(self,variant=None):
        self.volume.update(name='cbs_'+self.owner[:26],encrypted=True)
        index=self.root/'module-index'
        env=dict(os.environ,GIT_INDEX_FILE=str(index))
        git=['git','-C',str(HERE.parent)]
        subprocess.run(git+['read-tree',self.request['source_ref']],env=env,check=True)
        blob=subprocess.check_output(git+['hash-object','-w',str(HERE/'cloudbench-source-env.py')],text=True).strip()
        subprocess.run(git+['update-index','--add','--cacheinfo','100644,'+blob+',scripts/cloudbench-source-env.py'],env=env,check=True)
        tree=subprocess.check_output(git+['write-tree'],env=env,text=True).strip()
        ref=subprocess.check_output(git+['commit-tree',tree,'-p',self.request['source_ref'],'-m','isolated capsule producer fixture'],env=env,text=True).strip()
        fixture=runpy.run_path(str(HERE/'tests/cloudbench-source-env.test.py'))['CapsuleTest']();fixture.setUp();self.addCleanup(fixture.doCleanups)
        if variant is not None:
            for key in fixture.originals:
                original=fixture.originals[key].replace(fixture.secret.encode(),(fixture.secret+variant).encode())
                projected=fixture.projected[key].replace(fixture.secret.encode(),(fixture.secret+variant).encode())
                fixture.request['approved_inputs'][key]=fixture.write(key+'.approved',original)
                fixture.request['projected_inputs'][key]=fixture.write(key+'.projected',projected)
            fixture.secret+=variant
        fixture.request['binding'].update(owner_token=self.owner,create_nonce='6'*32,source_ref=ref,image_ref=self.image,
            node_fingerprint=self.request['node_fingerprint'],python_fingerprint=self.request['python_fingerprint'])
        fixture.build();capsule=json.loads(fixture.output.read_text())
        self.request.update(source_ref=ref,guest_transport='cloudbench-ssh-guest-v1',guest_env_mode=self.m['OWNED_MODE'],
            guest_env_capsule=self.m['descriptor'](fixture.output),guest_env_sha256=capsule['guest_env_sha256'])
        self.request['scripts']['cloudbench-source-env.py']=self.m['sha']((HERE/'cloudbench-source-env.py').read_bytes())
        return fixture,capsule

    def test_owned_capsule_sftp_cli_publication_and_no_secret_transport(self):
        fixture,capsule=self.owned_capsule_request()
        with patch.dict(os.environ,{'AGENTS_ENV_B64':'ambient-rotated','BACKEND_ENV_B64':'other-ambient'}):result=self.invoke()
        self.assertEqual(result.returncode,0,result.stderr)
        manifest=self.m['verify_prepared_source'](self.root/'request.json',self.root/'output/result.json',self.root/'output/source-manifest.json',
            source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        self.assertEqual(manifest['guest_env_capsule_binding'],capsule['binding'])
        final=self.remote_parent/'env'/ (self.request['guest_env_capsule']['sha256']+'.json')
        self.assertEqual(final.read_bytes(),fixture.output.read_bytes());self.assertEqual(final.stat().st_mode&0o777,0o600)
        receipt=self.m['load'](self.root/'output/result.json');self.assertIn('capsule_sftp',receipt);self.assertIn('capsule_ssh',receipt)
        for member in (self.root/'output').rglob('*'):
            if member.is_file():
                raw=member.read_bytes()
                self.assertNotIn(fixture.secret.encode(),raw)
                for value in capsule['env'].values():self.assertNotIn(value.encode(),raw)
        self.assertNotIn(fixture.secret,json.dumps(self.calls))
        path=self.root/'output/result.json';original=path.read_bytes()
        transfer=next((self.root/'output/capsule-sftp').glob('*/request.json'));raw=transfer.read_bytes()
        answer_path=transfer.parent/'result.json';answer_raw=answer_path.read_bytes()
        for kind in ('target','nonce','stage-inode','capsule-hash'):
            sent=json.loads(raw)
            if kind=='target':sent['argv'][6]='ffffffffffffff'
            elif kind=='nonce':sent['nonce']='foreign'
            elif kind=='stage-inode':sent['stage']['inode']+=1
            else:sent['capsule']['sha256']='0'*64
            transfer.write_text(json.dumps(sent));answer=json.loads(answer_raw);answer['request']=self.m['descriptor'](transfer)
            answer_path.write_text(json.dumps(answer));changed=json.loads(original)
            changed['capsule_sftp']=self.m['journal_index'](self.root/'output/capsule-sftp');path.write_text(json.dumps(changed))
            with self.assertRaises(ValueError,msg=kind):
                self.m['verify_prepared_source'](self.root/'request.json',path,self.root/'output/source-manifest.json',
                    source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        transfer.write_bytes(raw);answer_path.write_bytes(answer_raw);path.write_bytes(original)
        # Equal before/after witnesses must prove encryption positively, rather
        # than accepting two consistently false observations in a resealed chain.
        native=self.m['verify_journal'](receipt['journal'],self.mid,self.vid,(self.shared['id'],))
        for row in native:
            if row['method']=='GET' and row['path']=='/volumes/'+self.vid:row['response']['encrypted']=False
        sent=json.loads(raw);sent['volume_before']['encrypted']=False
        transfer.write_text(json.dumps(sent));answer=json.loads(answer_raw)
        answer['request']=self.m['descriptor'](transfer);answer['volume_after']['encrypted']=False
        answer_path.write_text(json.dumps(answer))
        with self.assertRaisesRegex(ValueError,'encrypted Volume'):
            self.m['verify_ssh_journal'](self.m['journal_index'](transfer.parent.parent),native,self.request,
                self.m['described'](receipt['prestart']),sftp=True)
        transfer.write_bytes(raw);answer_path.write_bytes(answer_raw)

    def test_owned_capsule_unencrypted_volume_refuses_before_delivery(self):
        self.owned_capsule_request();self.volume['encrypted']=False
        result=self.invoke()
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(path=='/_test_ssh' or method=='POST' and path=='/machines/'+self.mid
                             for method,path,body,nonce in self.calls))
        self.assertFalse((self.root/'output/source-manifest.json').exists())

    def test_owned_capsule_wrong_binding_or_symlink_refuses_before_native(self):
        fixture,capsule=self.owned_capsule_request()
        original=copy.deepcopy(self.request)
        for kind in ('owner_token','create_nonce','source_ref','image_ref','node_fingerprint','python_fingerprint','provider','hash','mode','symlink'):
            self.request=copy.deepcopy(original);wrong=copy.deepcopy(capsule)
            changed=self.root/('wrong-capsule-'+kind)
            if kind in wrong['binding']:wrong['binding'][kind]='f'*len(wrong['binding'][kind])
            if kind=='provider':wrong['providers']['backend']='steel' if wrong['providers']['backend']!='steel' else 'kernel'
            changed.write_text(json.dumps(wrong));changed.chmod(0o600)
            self.request['guest_env_capsule']=self.m['descriptor'](changed)
            if kind=='hash':self.request['guest_env_capsule']['sha256']='0'*64
            if kind=='mode':self.request['guest_env_mode']='foreign-mode'
            if kind=='symlink':
                changed.unlink();changed.symlink_to(fixture.output)
            result=self.invoke('request-'+kind+'.json','output-'+kind);self.assertNotEqual(result.returncode,0,kind);self.assertFalse(self.calls)

    def test_owned_capsule_unknown_sftp_outcome_never_retries_and_parks(self):
        self.owned_capsule_request();self.fault='sftp-unknown'
        result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertEqual(sum(body.get('args',[])[:3]==['ssh','sftp','put'] for method,path,body,nonce in self.calls if path=='/_test_ssh'),1)
        self.assertEqual(self.machine['state'],'stopped');self.assertEqual(self.machine['config']['guest']['memory_mb'],2048)
        self.assertIsNone(self.nonce);self.assertFalse((self.root/'output/source-manifest.json').exists())
        failed=self.root/'output/result.json'
        recovered=self.invoke_ssh_recovery(failed,'recover-sftp-unknown')
        self.assertEqual(recovered.returncode,0,recovered.stderr)
        receipt=self.m['load'](self.root/'recover-sftp-unknown/result.json')
        self.assertFalse(receipt['qualified']);self.assertTrue(receipt['filesystem_untrusted'])

    def test_owned_capsule_stage_inode_tamper_refuses_publication(self):
        self.owned_capsule_request();self.fault='capsule-inode'
        result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.root/'output/source-manifest.json').exists())

    def test_two_owned_capsules_prepare_concurrently_with_different_approved_env(self):
        from concurrent.futures import ThreadPoolExecutor
        self.owned_capsule_request('A')
        peer=NativeLifecycle();peer.fixture_owner='b'*32;peer.setUp();self.addCleanup(peer.doCleanups)
        peer.owned_capsule_request('B')
        self.assertNotEqual(self.request['guest_env_sha256'],peer.request['guest_env_sha256'])
        with patch.dict(os.environ,{'AGENTS_ENV_B64':'ambient-rotated','BACKEND_ENV_B64':'ambient-also-rotated'}):
            with ThreadPoolExecutor(max_workers=2) as executor:
                answers=list(executor.map(lambda case:case.invoke(),(self,peer)))
        for case,result in zip((self,peer),answers):
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(case.m['load'](case.root/'output/source-manifest.json')['guest_env_capsule_sha256'],case.request['guest_env_capsule']['sha256'])

    def failed_ssh_guest(self):
        self.volume.update(name='cbs_'+self.owner[:26],encrypted=True)
        self.request['guest_transport']='cloudbench-ssh-guest-v1';self.fault='guest-env-failure'
        result=self.invoke();self.assertNotEqual(result.returncode,0)
        path=self.root/'output/result.json';receipt=self.m['load'](path)
        self.assertIn('ssh',receipt)
        self.assertEqual(receipt['ssh'],self.m['journal_index'](self.root/'output/ssh'))
        self.assertTrue(receipt['stopped_verified']);self.assertFalse(receipt['qualified'])
        self.fault=None
        return path

    def invoke_ssh_recovery(self,failed,output='recovery-guest'):
        env=dict(os.environ,FLY_API_TOKEN='fixture-private',FLY_API_HOSTNAME=f'http://127.0.0.1:{self.server.server_port}',
                 PATH=str(self.root)+os.pathsep+os.environ['PATH'])
        return subprocess.run([sys.executable,str(HERE/'cloudbench-prepare-source.py'),'recover-bootstrap',
            '--request',str(self.root/'request.json'),'--failed-result',str(failed),'--output',str(self.root/output)],
            env=env,capture_output=True,text=True,timeout=35)

    def test_failed_ssh_env_guest_seals_evidence_recovers_untrusted_and_fresh_contract_prepares(self):
        failed=self.failed_ssh_guest();oldraw=failed.read_bytes();oldrequest=(self.root/'request.json').read_bytes()
        result=self.invoke_ssh_recovery(failed);self.assertEqual(result.returncode,0,result.stderr)
        path=self.root/'recovery-guest/result.json';receipt=self.m['load'](path)
        self.assertFalse(receipt['qualified']);self.assertFalse(receipt['credit_granted']);self.assertTrue(receipt['filesystem_untrusted'])
        self.assertFalse(receipt.get('legacy_unsealed_ssh',False))
        raw_receipt=path.read_bytes()
        for field in ('intent','filesystem_untrusted'):
            altered=copy.deepcopy(receipt);altered.pop(field);path.write_text(json.dumps(altered))
            with self.assertRaises(ValueError):self.m['verify_recovered_bootstrap'](path)
        path.write_bytes(raw_receipt)
        authority=self.m['resolve_bootstrap_ownership'](path)
        self.assertEqual(failed.read_bytes(),oldraw);self.assertEqual((self.root/'request.json').read_bytes(),oldrequest)
        self.request=dict(self.request,nonce='e'*32,ownership=self.m['descriptor'](path),
            guest_env_sha256={key:'7'*64 for key in self.request['guest_env_sha256']},
            native=dict(self.request['native'],instance_id=authority['machine']['instance_id'],
                        config_sha256=self.m['sha'](self.m['canonical'](authority['machine']['config']))))
        self.write('fresh-request.json',self.request)
        env=dict(os.environ,FLY_API_TOKEN='fixture-private',FLY_API_HOSTNAME=f'http://127.0.0.1:{self.server.server_port}',PATH=str(self.root)+os.pathsep+os.environ['PATH'])
        prepared=subprocess.run([sys.executable,str(HERE/'cloudbench-prepare-source.py'),'--request',str(self.root/'fresh-request.json'),
            '--output',str(self.root/'fresh')],env=env,capture_output=True,text=True,timeout=35)
        self.assertEqual(prepared.returncode,0,prepared.stderr)
        self.m['verify_prepared_source'](self.root/'fresh-request.json',self.root/'fresh/result.json',self.root/'fresh/source-manifest.json',
            source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        self.assertEqual(failed.read_bytes(),oldraw)

    def test_failed_ssh_guest_unknown_epoch_refuses_recovery_before_write(self):
        failed=self.failed_ssh_guest();original=copy.deepcopy(self.machine)
        for index,kind in enumerate(('unknown-epoch','consumer-claim','mount')):
            self.machine=copy.deepcopy(original)
            if kind=='unknown-epoch':self.machine['instance_id']='UNKNOWN3'
            elif kind=='consumer-claim':self.machine['config']['metadata']['cloudbench_source_consumer_'+'f'*32]='claim'
            else:self.machine['config']['mounts'][0]['volume']='vol_foreign'
            before=len(self.calls);result=self.invoke_ssh_recovery(failed,'recovery-negative-'+str(index))
            self.assertNotEqual(result.returncode,0)
            self.assertTrue(all(method=='GET' or path.endswith('/lease') for method,path,body,nonce in self.calls[before:]))

    def test_failed_ssh_guest_altered_command_or_publication_refuses_pure_recovery(self):
        failed=self.failed_ssh_guest()
        self.write('output/source-manifest.json',{'forged':'published'})
        with self.assertRaises(ValueError):self.m['prestart_failure'](self.root/'request.json',failed)
        (self.root/'output/source-manifest.json').unlink()
        path=next((self.root/'output/ssh').glob('*/request.json'));value=self.m['load'](path)
        value['command']=['echo','foreign'];value['argv']=self.m['ssh_argv']('navi-whisper-lux-bench',self.mid,value['command'])
        path.write_text(json.dumps(value));answer_path=path.parent/'result.json';answer=self.m['load'](answer_path)
        answer['request']=self.m['descriptor'](path);answer_path.write_text(json.dumps(answer))
        result=self.m['load'](failed);result['ssh']=self.m['journal_index'](self.root/'output/ssh');failed.write_text(json.dumps(result))
        with self.assertRaises(ValueError):self.m['prestart_failure'](self.root/'request.json',failed)

    def test_real_http_known_cas_predecessor_replacing_waits_before_start(self):
        self.fault='transition'
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(self.machine['state'],'stopped')

    def test_exec_requires_supported_argv_and_lease_bound_to_current_cas_epoch(self):
        self.enforce_exec_version=True
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue(any(path.endswith('/exec') for method,path,body,nonce in self.calls))

    def test_refresh_wrong_version_refuses_before_start_or_exec(self):
        self.fault='lease-version-wrong';result=self.invoke()
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(method=='POST' and path.endswith(('/start','/exec')) for method,path,body,nonce in self.calls))

    def test_resealed_start_before_lease_version_refresh_refuses(self):
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        path=self.root/'output/result.json';receipt=self.m['load'](path)
        rows=[]
        for p in (self.root/'output/native').glob('*/request.json'):
            sent=self.m['load'](p);wire=next(p.parent.glob('*-wire.json'));record=self.m['load'](wire)
            rows.append((self.m['load'](p.parent/'transport-start.json')['monotonic_ns'],p,sent,wire,record))
        rows.sort()
        start=next(row for row in rows if row[2]['path'].endswith('/start'))
        renewal=next(row for row in rows if row[2]['method']=='POST' and row[2]['path'].endswith('/lease') and row[2]['headers'])
        self.assertLess(renewal[0],start[0])
        stamp=self.m['load'](renewal[1].parent/'transport-start.json');stamp['monotonic_ns']=start[4]['monotonic_ns']+1
        (renewal[1].parent/'transport-start.json').write_text(json.dumps(stamp))
        renewal[4]['monotonic_ns']=stamp['monotonic_ns']+1;renewal[3].write_text(json.dumps(renewal[4]))
        receipt['journal']=self.m['journal_index'](self.root/'output/native');path.write_text(json.dumps(receipt))
        with self.assertRaisesRegex(ValueError,'version'):
            self.m['verify_prepared_source'](self.root/'request.json',path,self.root/'output/source-manifest.json',
                source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)

    def test_unknown_replacement_instance_never_starts(self):
        self.fault='third-instance';result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(method=='POST' and path.endswith('/start') for method,path,body,nonce in self.calls))

    def test_unknown_replacement_config_never_starts(self):
        self.fault='third-config';result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(method=='POST' and path.endswith('/start') for method,path,body,nonce in self.calls))

    def test_known_predecessor_cannot_extend_absolute_transition_deadline(self):
        row=copy.deepcopy(self.machine);row['state']='replacing'
        calls=[]
        def request(method,path):
            calls.append((method,path))
            return row if '/machines/' in path else self.volume
        clock=iter((0,60,120))
        with patch.dict(self.m['wait_state'].__globals__,time=SimpleNamespace(monotonic=lambda:next(clock),sleep=lambda _:None)):
            with self.assertRaisesRegex(ValueError,'deadline'):
                self.m['wait_state'](SimpleNamespace(request=request),self.request,self.manifest,
                    dict(self.config,image=self.image), 'stopped','ACK2',120,prior=self.machine)
        self.assertEqual(len(calls),4)
        self.assertTrue(all(method=='GET' for method,path in calls))

    def failed_prestart(self):
        self.volume.update(name='cbs_'+self.owner[:26],encrypted=True)
        self.write('failed-request.json',self.request)
        binary=self.root/'flyctl';binary.write_text('#!/bin/sh\nexit 97\n');binary.chmod(0o700)
        env=dict(FLY_API_TOKEN='fixture-private',FLY_API_HOSTNAME=f'http://127.0.0.1:{self.server.server_port}',
                 PATH=str(self.root)+os.pathsep+os.environ['PATH'])
        def fail(*args,**kwargs):raise ValueError('injected acknowledged-CAS prestart failure')
        with patch.dict(os.environ,env),patch.dict(self.m['prepare'].__globals__,wait_state=fail):
            with self.assertRaises(ValueError):self.m['prepare'](self.root/'failed-request.json',self.root/'failed')
        return env

    def invoke_recovery(self,env,output='recovery'):
        return subprocess.run([sys.executable,str(HERE/'cloudbench-prepare-source.py'),'recover-bootstrap',
            '--request',str(self.root/'failed-request.json'),'--failed-result',str(self.root/'failed/result.json'),
            '--output',str(self.root/output)],env=dict(os.environ,**env),capture_output=True,text=True,timeout=35)

    def test_real_http_failed_cas_recovery_fresh_prepare_preserves_old_false(self):
        env=self.failed_prestart()
        originals={p:p.read_bytes() for p in (self.root/'failed').rglob('*') if p.is_file()}
        originals[self.root/'failed-request.json']=(self.root/'failed-request.json').read_bytes()
        result=self.invoke_recovery(env);self.assertEqual(result.returncode,0,result.stderr)
        path=self.root/'recovery/result.json';receipt=self.m['load'](path)
        self.assertFalse(receipt['qualified']);self.assertFalse(receipt['credit_granted'])
        authority=self.m['resolve_bootstrap_ownership'](path)
        self.assertEqual(authority['machine']['config']['guest']['memory_mb'],2048)
        self.assertEqual(authority['machine']['config']['guest']['cpus'],1)
        self.assertEqual(authority['original_creator'],self.request['ownership'])
        self.request=dict(self.request,nonce='e'*32,ownership=self.m['descriptor'](path),
            native=dict(self.request['native'],instance_id=authority['machine']['instance_id'],
                        config_sha256=self.m['sha'](self.m['canonical'](authority['machine']['config']))))
        prepared=self.invoke();self.assertEqual(prepared.returncode,0,prepared.stderr)
        self.m['verify_prepared_source'](self.root/'request.json',self.root/'output/result.json',self.root/'output/source-manifest.json',
            source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        for p,raw in originals.items():self.assertEqual(p.read_bytes(),raw)
        self.assertFalse(self.m['load'](self.root/'failed/result.json')['qualified'])

    def test_recovery_unknown_epoch_refuses_without_parking_or_guest(self):
        env=self.failed_prestart();self.machine['instance_id']='UNKNOWN3'
        start=len(self.calls);result=self.invoke_recovery(env)
        self.assertNotEqual(result.returncode,0)
        self.assertTrue(all(path.endswith('/lease') or method=='GET' for method,path,body,nonce in self.calls[start:]))

    def test_recovery_result_and_original_authority_tamper_refuse(self):
        env=self.failed_prestart();result=self.invoke_recovery(env)
        self.assertEqual(result.returncode,0,result.stderr)
        path=self.root/'recovery/result.json';raw=path.read_bytes()
        for field,value in [('qualified',True),('credit_granted',True),('nonce','d'*32)]:
            changed=json.loads(raw);changed[field]=value;path.write_text(json.dumps(changed))
            with self.assertRaises(ValueError):self.m['verify_recovered_bootstrap'](path)
        path.write_bytes(raw)
        failed=self.root/'failed/result.json';original=failed.read_bytes()
        changed=json.loads(original);changed['qualified']=True;failed.write_text(json.dumps(changed))
        with self.assertRaises(ValueError):self.m['verify_recovered_bootstrap'](path)

    def test_recovery_resealed_lease_and_cas_version_tamper_refuse(self):
        env=self.failed_prestart();result=self.invoke_recovery(env)
        self.assertEqual(result.returncode,0,result.stderr)
        path=self.root/'recovery/result.json';original=path.read_bytes()
        for member in (self.root/'recovery/native').glob('*/request.json'):
            request=self.m['load'](member)
            if request['method']=='POST' and request['path']=='/machines/'+self.mid:
                raw=member.read_bytes()
                for field in ('lease','version'):
                    wrong=copy.deepcopy(request)
                    if field=='lease':wrong['headers']['fly-machine-lease-nonce']='foreign-lease'
                    else:wrong['body']['current_version']='UNKNOWN3'
                    member.write_text(json.dumps(wrong))
                    receipt=json.loads(original);receipt['journal']=self.m['journal_index'](self.root/'recovery/native')
                    path.write_text(json.dumps(receipt))
                    with self.assertRaises(ValueError):self.m['verify_recovered_bootstrap'](path)
                member.write_bytes(raw);path.write_bytes(original)

    def test_recovery_published_claim_refuses_before_parking(self):
        env=self.failed_prestart();self.machine['config']['metadata']['cloudbench_source_consumer_'+'f'*32]='claim'
        start=len(self.calls);result=self.invoke_recovery(env)
        self.assertNotEqual(result.returncode,0)
        self.assertTrue(all(path.endswith('/lease') or method=='GET' for method,path,body,nonce in self.calls[start:]))

    def test_nested_recovery_after_first_exec_rejected_and_cleanly_parked(self):
        env=self.failed_prestart();self.assertEqual(self.invoke_recovery(env).returncode,0)
        path=self.root/'recovery/result.json';authority=self.m['resolve_bootstrap_ownership'](path)
        original_creator=authority['original_creator']
        self.request=dict(self.request,nonce='e'*32,ownership=self.m['descriptor'](path),
            native=dict(self.request['native'],instance_id=authority['machine']['instance_id'],
                        config_sha256=self.m['sha'](self.m['canonical'](authority['machine']['config']))))
        self.fault='first-exec-409';failed=self.invoke();self.assertNotEqual(failed.returncode,0)
        old=self.root/'output/result.json';oldraw=old.read_bytes()
        self.assertTrue(self.m['load'](old)['stopped_verified'])
        execs=[row for row in self.calls if row[0]=='POST' and row[1].endswith('/exec')]
        self.assertEqual(len(execs),1)
        self.fault=None
        result=subprocess.run([sys.executable,str(HERE/'cloudbench-prepare-source.py'),'recover-bootstrap',
            '--request',str(self.root/'request.json'),'--failed-result',str(old),'--output',str(self.root/'recovery52')],
            env=dict(os.environ,**env),capture_output=True,text=True,timeout=35)
        self.assertEqual(result.returncode,0,result.stderr)
        value=self.m['resolve_bootstrap_ownership'](self.root/'recovery52/result.json')
        self.assertEqual(value['original_creator'],original_creator)
        self.assertEqual(old.read_bytes(),oldraw)
        self.assertFalse(self.m['load'](self.root/'recovery52/result.json')['qualified'])

    def test_exec_rejection_recovery_refuses_nonbootstrap_command(self):
        self.fault='first-exec-409';result=self.invoke();self.assertNotEqual(result.returncode,0)
        failed=self.root/'output/result.json';receipt=self.m['load'](failed)
        for p in (self.root/'output/native').glob('*/request.json'):
            row=self.m['load'](p)
            if row['path'].endswith('/exec'):
                row['body']['command']=['echo','not-the-bootstrap'];p.write_text(json.dumps(row))
        receipt['journal']=self.m['journal_index'](self.root/'output/native');failed.write_text(json.dumps(receipt))
        with self.assertRaises(ValueError):self.m['prestart_failure'](self.root/'request.json',failed)

    def test_resealed_manifest_cannot_change_prepared_guest_environment(self):
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        path=self.root/'output/source-manifest.json'
        manifest=self.m['load'](path)
        manifest['guest_env_sha256']['AGENTS_ENV_B64']='7'*64
        self.m['save'](self.root/'changed-manifest.json',manifest)
        receipt=self.m['load'](self.root/'output/result.json')
        receipt['manifest']=self.m['descriptor'](self.root/'changed-manifest.json')
        self.m['save'](self.root/'output/resealed-result.json',receipt)
        with self.assertRaises(ValueError):
            self.m['verify_prepared_source'](self.root/'request.json',self.root/'output/resealed-result.json',
                self.root/'changed-manifest.json',source_ref=self.request['source_ref'],image_ref=self.image,
                node_fingerprint='b'*64,python_fingerprint='c'*64)

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
