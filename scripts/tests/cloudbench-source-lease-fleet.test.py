#!/usr/bin/env python3
"""Exercise the real fleet source admission when its exact native lease is lost."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import signal
import unittest
import json
import hashlib
import http.server
import runpy
import threading
import sys
ROOT=Path(__file__).resolve().parents[2]
FLEET=Path(os.environ.get('CLOUDBENCH_FLEET_UNDER_TEST',str(ROOT/'scripts/run-bench-fleet')))

class FleetLease(unittest.TestCase):
    def run_admission(self, status, protocol='cloudbench-source-lease-v1'):
        source=FLEET.read_text()
        function=re.search(r'^private_fleet_source_admission\(\) \{.*?^\}',source,re.M|re.S).group(0)
        script='''private_source_lease_guard() { return "$LEASE_STATUS"; }
inventory_machine_field() { case "$2" in instance_id) echo native1;; state) echo stopped;; storage_ready) echo 1;; esac; }
PRIVATE_SOURCE_ID=11111111111111
PRIVATE_SOURCE_INSTANCE_ID=native1
'''+function+'\nprivate_fleet_source_admission\n'
        return subprocess.run(['bash','-c',script],env={**os.environ,'LEASE_STATUS':str(status),
            'PRIVATE_SOURCE_LEASE_PROTOCOL':protocol},capture_output=True,text=True,timeout=5)
    def test_term_resistant_owned_holder_has_bounded_join(self):
        source=FLEET.read_text()
        function=re.search(r'^private_source_holder_identity\(\) \{.*?^\}',source,re.M|re.S).group(0)+'\n'+re.search(r'^finish_private_source_lease\(\) \{.*?^\}',source,re.M|re.S).group(0)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)
            child_code="import os,signal,time,pathlib;signal.signal(signal.SIGTERM,signal.SIG_IGN);pathlib.Path(os.environ['CHILD_READY']).write_text(str(os.getpid()));time.sleep(60)"
            script='source "$HELPER"\n'+function+"\n"+"""
FLEET_DIR="$FIXTURE"
CLOUDBENCH_CHILD_TERM_SECONDS=1
python3 -c "$CHILD_CODE" &
PRIVATE_SOURCE_LEASE_PID=$!
while [ ! -f "$CHILD_READY" ]; do sleep 0.02; done
PRIVATE_SOURCE_LEASE_BIRTH="$(private_source_holder_identity)"
finish_private_source_lease
"""
            env={**os.environ,'ROOT_DIR':str(ROOT),'HELPER':str(ROOT/'scripts/lib/cloudbench-env.sh'),'FIXTURE':directory,
                 'CHILD_CODE':child_code,'CHILD_READY':str(path/'child.pid')}
            try:
                result=subprocess.run(['bash','-c',script],env=env,capture_output=True,text=True,timeout=3)
                self.assertNotEqual(result.returncode,0)
                self.assertIn('durable claim retained',result.stderr)
            finally:
                pid_file=path/'child.pid'
                if pid_file.exists():
                    pid=int(pid_file.read_text())
                    try:
                        # This exact test child was launched above; never signal a pattern.
                        observed=Path('/proc',str(pid),'cmdline').read_bytes()
                        if child_code.encode() in observed: os.kill(pid,signal.SIGKILL)
                    except (FileNotFoundError,ProcessLookupError):pass

    def test_reused_holder_pid_is_never_signaled(self):
        source=FLEET.read_text()
        function=re.search(r'^finish_private_source_lease\(\) \{.*?^\}',source,re.M|re.S).group(0)
        with tempfile.TemporaryDirectory() as directory:
            marker=Path(directory)/'signals'
            script="""
kill() { if [ "$1" = -0 ]; then return 0; fi; echo "$*" >> "$SIGNAL_MARKER"; }
ps() { echo S; }
wait() { return 0; }
PRIVATE_SOURCE_LEASE_PID=987654
PRIVATE_SOURCE_LEASE_BIRTH=original-birth
private_source_holder_identity() { echo foreign-birth; }
FLEET_DIR="$EMPTY_FLEET"
"""+function+'\nfinish_private_source_lease || true\n'
            r=subprocess.run(['bash','-c',script],env={**os.environ,'SIGNAL_MARKER':str(marker),
                'EMPTY_FLEET':directory},capture_output=True,text=True,timeout=3)
            self.assertEqual(r.returncode,0,r.stderr)
            self.assertFalse(marker.exists(),'foreign reused PID received signal')

    def test_lost_lease_refuses_new_clone_admission_despite_matching_inventory(self):
        self.assertNotEqual(self.run_admission(1).returncode,0)
    def test_held_lease_admits_exact_ready_source(self):
        r=self.run_admission(0);self.assertEqual(r.returncode,0,r.stderr)
    def test_legacy_source_does_not_require_new_protocol(self):
        r=self.run_admission(1,'none');self.assertEqual(r.returncode,0,r.stderr)


class OwnedCapsuleStorage(unittest.TestCase):
    def function(self,name):
        return re.search(r'^'+name+r'\(\) \{.*?^\}',FLEET.read_text(),re.M|re.S).group()

    def primary(self,mode,explicit=0):
        script=self.function('primary_clone_storage_mode')+'''
FRESH_VOLUMES=1
FRESH_VOLUMES_REQUESTED="$EXPLICIT"
BENCHES=(real-task)
CATALOG_MODES=(real)
is_sim_on() { return 1; }
primary_clone_storage_mode real-task
'''
        return subprocess.run(['bash','-c',script],env={**os.environ,'PRIVATE_SOURCE_GUEST_ENV_MODE':mode,'EXPLICIT':str(explicit)},
                              capture_output=True,text=True,timeout=5)

    def worker(self,mode):
        body=re.search(r'    worker_storage=snapshot\n.*?    if \[ "\$worker_storage" = fresh \]; then',FLEET.read_text(),re.S).group()
        body=body.rsplit('    if [ "$worker_storage" = fresh ]; then',1)[0]
        script='FRESH_VOLUMES=1; borrowed_worker=0; sim=0\n'+body+'\nprintf "%s" "$worker_storage"\nfi\n'
        return subprocess.run(['bash','-c',script],env={**os.environ,'PRIVATE_SOURCE_GUEST_ENV_MODE':mode},
                              capture_output=True,text=True,timeout=5)

    def test_default_real_primary_and_worker_inherit_capsule_snapshot(self):
        for result in (self.primary('owned-capsule-v1'),self.worker('owned-capsule-v1')):
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout,'snapshot')

    def test_ambient_real_primary_and_worker_remain_fresh(self):
        for result in (self.primary('none'),self.worker('none')):
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout,'fresh')

    def volume_boundary(self,mode,storage,snapshot,*,observe=None,guard=0,tamper=False,ambiguous=False,encrypted=True):
        with tempfile.TemporaryDirectory() as directory:
            marker=Path(directory)/'requests'
            body=self.function('clone_create_owned_volume')
            fixture=runpy.run_path(str(ROOT/'scripts/tests/cloudbench-source-version.test.py'))['SourceVersion']()
            fixture.setUp();manifest=fixture.owned()
            captured=Path(directory)/'source.json';captured.write_text(json.dumps(manifest))
            digest=hashlib.sha256(captured.read_bytes()).hexdigest()
            if tamper:captured.write_text(captured.read_text()+' ')
            inventory=Path(directory)/'inventory/current';inventory.mkdir(parents=True)
            source=dict(id='11111111111111',image_ref=dict(registry='registry.fly.io',repository='fixture',digest='sha256:'+'b'*64),
                config=dict(guest=dict(cpu_kind='shared',cpus=1,memory_mb=2048),
                    mounts=[dict(name='private_source',size_gb=40,encrypted=encrypted)]))
            (inventory/'admission-machines.json').write_text(json.dumps([source]))
            requests=[]
            class Native(http.server.BaseHTTPRequestHandler):
                def log_message(self,*args):pass
                def do_POST(self):
                    value=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    requests.append(value)
                    if observe:observe(value)
                    if ambiguous:
                        self.connection.shutdown(2);self.connection.close();return
                    raw=json.dumps(dict(id='vol_fixture',name=value['name'],region=value['region'])).encode()
                    self.send_response(201);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Native)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            script='''
fleet_clone_with_queue_admission() {
    printf '%s\\n' "$@" > "$REQUEST_LOG"
    python3 "$CLONE_HELPER" "${@:4}" --app fixture --timeout 2
}
private_fleet_source_admission() { return "$GUARD_STATUS"; }
clone_volume_receipt_field() { python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2],""))' "$1" "$2"; }
fleet_registry_record_volume() { return 0; }
'''+body+'''
clone_create_owned_volume "$FIXTURE/ledger" cloudbench-abc 11111111111111 iad shared-cpu-1x 2048 "$STORAGE" "$SNAPSHOT" 20 "$FIXTURE/names" "$FIXTURE/native.log"
'''
            env={**os.environ,'PRIVATE_SOURCE_GUEST_ENV_MODE':mode,'STORAGE':storage,'SNAPSHOT':snapshot,
                 'PRIVATE_SOURCE_FILE':str(captured),'PRIVATE_SOURCE_SHA256':digest,'PRIVATE_SOURCE_ID':manifest['machine_id'],
                 'PRIVATE_SOURCE_VOLUME_ID':manifest['volume_id'],'SOURCE_HELPER':str(ROOT/'scripts/cloudbench-source.py'),
                 'CLONE_HELPER':str(ROOT/'scripts/cloudbench-clone-volume.py'),'INVENTORY_INDEX':str(inventory.parent),
                 'FLY_FLAPS_BASE_URL':'http://127.0.0.1:'+str(server.server_port),'FLY_API_TOKEN':'fixture-local-token',
                 'GUARD_STATUS':str(guard),'PRIVATE_SOURCE_SNAPSHOT':'vs_owned','SNAP_ID':'vs_owned',
                 'FIXTURE':directory,'REQUEST_LOG':str(marker)}
            env.pop('CLOUDBENCH_FRESH_VOLUME_UNIQUE_ZONE',None)
            try:
                result=subprocess.run(['bash','-c',script],env=env,capture_output=True,text=True,timeout=8)
            finally:
                server.shutdown();server.server_close();thread.join(2)
            return result,requests

    def test_owned_snapshot_reaches_volume_create_with_exact_snapshot_id(self):
        result,argv=self.volume_boundary('owned-capsule-v1','snapshot','vs_owned')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(len(argv),1)
        self.assertEqual(argv[0]['snapshot_id'],'vs_owned')
        self.assertIs(argv[0]['encrypted'],True)

    def test_owned_empty_or_missing_snapshot_refuses_before_volume_boundary(self):
        for storage,snapshot in (('fresh','vs_owned'),('snapshot','')):
            result,argv=self.volume_boundary('owned-capsule-v1',storage,snapshot)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(argv,[])

    def test_ambient_fresh_volume_omits_snapshot_as_before(self):
        result,argv=self.volume_boundary('none','fresh','')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(len(argv),1)
        self.assertIsNone(argv[0]['snapshot_id'])
    def test_owned_wrong_snapshot_tamper_or_lost_consumer_guard_never_posts(self):
        for snapshot,guard,tamper in [('vs_foreign',0,False),('vs_owned',1,False),('vs_owned',0,True)]:
            result,requests=self.volume_boundary('owned-capsule-v1','snapshot',snapshot,guard=guard,tamper=tamper)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(requests,[])

    def test_owned_unencrypted_source_refuses_before_native_volume_post(self):
        result,requests=self.volume_boundary('owned-capsule-v1','snapshot','vs_owned',encrypted=False)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(requests,[])

    def test_unknown_create_outcome_never_retries(self):
        result,requests=self.volume_boundary('owned-capsule-v1','snapshot','vs_owned',ambiguous=True)
        self.assertEqual(result.returncode,4)
        self.assertEqual(len(requests),1)

    def test_explicit_empty_and_cold_policies_refuse_before_allocation(self):
        fn=self.function('owned_capsule_storage_admission')
        baseline=dict(PRIVATE_SOURCE_GUEST_ENV_MODE='owned-capsule-v1',PRIVATE_SOURCE_FILE='/captured',
            PRIVATE_SOURCE_SNAPSHOT='vs_owned',PRIVATE_SOURCE_LEASE_PROTOCOL='cloudbench-source-lease-v1')
        for extra,accepted in [({},True),({'FRESH_VOLUMES_REQUESTED':'1'},False),
                ({'CLOUDBENCH_FRESH_VOLUMES':'1'},False),
                ({'CLOUDBENCH_FRESH_VOLUMES':'1','SNAPSHOT_VOLUMES_REQUESTED':'1'},True),({'POOL_COLD_BOOTSTRAP':'1'},False),
                ({'PRIVATE_SOURCE_FILE':''},False),({'PRIVATE_SOURCE_SNAPSHOT':''},False),
                ({'PRIVATE_SOURCE_GUEST_ENV_MODE':'none','FRESH_VOLUMES_REQUESTED':'1'},True)]:
            env={k:v for k,v in os.environ.items() if not k.startswith(('CLOUDBENCH_','PRIVATE_SOURCE_','POOL_','FRESH_'))}
            result=subprocess.run(['bash','-c',fn+'\nowned_capsule_storage_admission'],env=dict(env,**(baseline|extra)),
                capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode==0,accepted,extra)

    def test_reused_worker_requires_same_captured_source_before_claim(self):
        import base64
        fn=self.function('owned_capsule_worker_source_admission')
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'proof.json'
            def prove(source,mode='owned-capsule-v1',capsule='b'*64):
                raw=json.dumps(dict(config=dict(values=dict(base_source_manifest_sha256=source,
                    base_source_guest_env_mode=mode,base_source_guest_env_capsule_sha256=capsule)))).encode()
                path.write_text(json.dumps(dict(originals={'run/execution-provenance.json':dict(
                    data=base64.b64encode(raw).decode(),bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())})))
                return subprocess.run(['bash','-c',fn+'\nowned_capsule_worker_source_admission "$PROOF"'],
                    env=dict(os.environ,ROOT_DIR=str(ROOT),PROOF=str(path),PRIVATE_SOURCE_GUEST_ENV_MODE='owned-capsule-v1',
                        PRIVATE_SOURCE_SHA256='a'*64,PRIVATE_SOURCE_GUEST_ENV_CAPSULE_SHA256='b'*64),capture_output=True,text=True,timeout=5)
            self.assertEqual(prove('a'*64).returncode,0)
            for source,mode,capsule in [('c'*64,'owned-capsule-v1','b'*64),('a'*64,'none','b'*64),('a'*64,'owned-capsule-v1','c'*64)]:
                self.assertNotEqual(prove(source,mode,capsule).returncode,0)
            text=FLEET.read_text();claim=text[text.index('claim_reusable_worker() {'):text.index('return_reusable_worker() {')]
            self.assertLess(claim.index('owned_capsule_worker_source_admission "$proof"'),claim.index('write_pool_claim'))


class PrivateSourceSnapshotReads(unittest.TestCase):
    # Original Root read-only 15-concurrency captures, not reconstructed smoke bytes.
    EMPTY = b'[]\n'
    HEALTHY = b'[\n    {\n        "id": "vs_24P7lJepAPORsxx5yblJp",\n        "size": 42359770871,\n        "volume_size": 42949672960,\n        "digest": "4cdadcfde36f13eceb1b6c0d0e57342ec736a5944d80e09fc7a271513769e06c",\n        "created_at": "2026-11-10T03:36:22Z",\n        "status": "created",\n        "retention_days": 5\n    },\n    {\n        "id": "vs_nj5w9Bley5MNfzKva4eoA",\n        "size": 944314,\n        "volume_size": 42949672960,\n        "digest": "dba247c2460226b094d393b644bfc27a35ce6cc538d3f3b87970754056eedd54",\n        "created_at": "2026-11-10T22:52:39Z",\n        "status": "created",\n        "retention_days": 5\n    }\n]\n'

    def validation(self, replies, *, provider_exit=0, expired=False, earlier_deadline=False,
                   guardian_lost=False, tamper_manifest=False, wrong_owner=False, journal=None):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);registry=root/'registry';registry.mkdir(mode=0o700)
            git=root/'.git';git.mkdir(mode=0o700);owner='1'*32;run='fixture-source-read'
            base=git/'cloudbench-source-validation'
            if journal:
                base.mkdir(mode=0o700)
                if journal=='symlink':(base/owner).symlink_to(registry,target_is_directory=True)
                else:(base/owner).mkdir(mode=0o700)
            fixture=runpy.run_path(str(ROOT/'scripts/tests/cloudbench-source-version.test.py'))['SourceVersion']()
            fixture.setUp();manifest=fixture.owned()
            manifest['snapshot_id']=json.loads(self.HEALTHY)[0]['id']
            meta=fixture.machine['config']['metadata']
            meta.update(cloudbench_source_protocol=manifest['lease_protocol'],cloudbench_source_create_nonce=manifest['creation_nonce'],
                        cloudbench_source_guest_env_mode='owned-capsule-v1',cloudbench_source_guest_env_capsule_sha256='f'*64)
            if wrong_owner:meta['cloudbench_source_owner']='b'*32
            source=root/'source.json';source.write_text(json.dumps(manifest));digest=hashlib.sha256(source.read_bytes()).hexdigest()
            for role in ('machines','volumes'):(root/(role+'.json')).write_text(json.dumps(fixture.inventory[role]))
            for index,body in enumerate(replies):(root/('reply-'+str(index))).write_bytes(body)
            fake=root/'provider.py';fake.write_text(r"""import json,os,pathlib,sys
p=pathlib.Path(os.environ['FIXTURE']);args=sys.argv[1:]
with (p/'calls').open('a') as f:f.write(json.dumps(args)+'\n')
if args[:3]==['volume','snapshots','list']:
 counter=p/'count';n=int(counter.read_text()) if counter.exists() else 0;counter.write_text(str(n+1))
 raw=(p/('reply-'+str(min(n,int(os.environ['REPLIES'])-1)))).read_bytes()
 if os.environ['TAMPER']=='1':(p/'source.json').write_text((p/'source.json').read_text()+' ')
 sys.stdout.buffer.write(raw);sys.exit(int(os.environ['PROVIDER_EXIT']))
elif args[:2] in (['machines','list'],['volumes','list']):sys.stdout.buffer.write((p/(args[0]+'.json')).read_bytes())
else:raise SystemExit('unexpected provider operation')
""")
            source_code=FLEET.read_text();function=re.search(r'^validate_private_fleet_source\(\) \{.*?^\}',source_code,re.M|re.S).group(0)
            inventory=(ROOT/'scripts/lib/cloudbench-inventory.sh').read_text()
            bounded=re.search(r'^fly_with_timeout\(\) \{.*?^\}',inventory,re.M|re.S).group(0)
            shell='set -euo pipefail\nFLY() { python3 "$FIXTURE/provider.py" "$@"; }\nprivate_source_lease_guard() {\n printf guard\\n >> "$FIXTURE/guards"\n if [ "$GUARD_LOST" = 1 ] && [ -f "$FIXTURE/count" ]; then return 1; fi\n}\nsleep() { printf \'%s\\n\' "$1" >> "$FIXTURE/sleeps"; }\n'+bounded+'\n'+function+'\nvalidate_private_fleet_source\n'
            env={**os.environ,'FIXTURE':str(root),'FLEET_REGISTRY_DIR':str(registry),'GIT_COMMON_DIR':str(git),'FLEET_OWNER_TOKEN':owner,'RUN_ID':run,'PRIVATE_SOURCE_FILE':str(source),
                 'PRIVATE_SOURCE_SHA256':digest,'PRIVATE_SOURCE_VOLUME_ID':'vol_owned','PRIVATE_SOURCE_LEASE_PROTOCOL':'cloudbench-source-lease-v1',
                 'SOURCE_HELPER':str(ROOT/'scripts/cloudbench-source.py'),'APP':'navi-whisper-lux-bench','WARM_PARKED_VM_MEMORY':'2048',
                 'FLEET_CONTROLLER_STARTED_EPOCH':str(int(__import__('time').time())-(6000 if expired else 0)),
                 'START_BARRIER_WAIT_SECONDS':'600','FLY_API_TOKEN':'snapshot-capture-secret-canary','REPLIES':str(len(replies)),
                 'PROVIDER_EXIT':str(provider_exit),'GUARD_LOST':str(int(guardian_lost)),'TAMPER':str(int(tamper_manifest))}
            env.pop('RUN_BENCH_CAMPAIGN_E2E_DEADLINE_MONOTONIC',None)
            if earlier_deadline:env['RUN_BENCH_CAMPAIGN_E2E_DEADLINE_MONOTONIC']=str(__import__('time').monotonic()-1)
            result=subprocess.run(['bash','-c',shell],env=env,capture_output=True,text=True,timeout=15)
            calls=[json.loads(line) for line in (root/'calls').read_text().splitlines()] if (root/'calls').exists() else []
            capture=git/'cloudbench-source-validation'/owner/run
            self.assertFalse(capture.is_relative_to(registry))
            __import__('shutil').rmtree(registry)  # Normal registry retirement must not remove private original reads.
            files={p.name:p.read_bytes() for p in capture.iterdir() if p.is_file()} if capture.exists() else {}
            modes={p.name:p.stat().st_mode & 0o777 for p in capture.iterdir() if p.is_file()} if capture.exists() else {}
            self.assertNotIn('snapshot-capture-secret-canary',result.stdout+result.stderr+repr(calls)+repr(files))
            sleeps=[int(v) for v in (root/'sleeps').read_text().splitlines()] if (root/'sleeps').exists() else []
            return result,calls,files,modes,sleeps

    def test_captured_empty_reconciles_to_exact_snapshot_with_private_original_reads(self):
        result,calls,files,modes,sleeps=self.validation([self.EMPTY,self.HEALTHY])
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual([v[:2] for v in calls],[['volume','snapshots'],['volume','snapshots'],['machines','list'],['volumes','list']])
        self.assertEqual(files['01-snapshots.raw'],self.EMPTY)
        self.assertEqual(files['02-snapshots.raw'],self.HEALTHY)
        self.assertEqual(json.loads(files['01-snapshots.json'])['exit_code'],0)
        self.assertEqual(json.loads(files['01-snapshots.json'])['raw_sha256'],hashlib.sha256(self.EMPTY).hexdigest())
        self.assertEqual(files['verify.status'],b'0\n')
        self.assertEqual(json.loads(files['intent.json'])['owner_token'],'1'*32)
        self.assertTrue(all(v==0o600 for v in modes.values()))
        self.assertEqual(len(sleeps),1);self.assertTrue(5<=sleeps[0]<=8)

    def test_private_empty_reobservation_has_original_bounded_attempt_and_deadline(self):
        result,calls,files,modes,sleeps=self.validation([self.EMPTY])
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(len(calls),12);self.assertTrue(all(v[:3]==['volume','snapshots','list'] for v in calls))
        self.assertEqual(len(sleeps),11)
        self.assertTrue(all(min(i*5,30)<=v<=min(i*5,30)+3 for i,v in enumerate(sleeps,1)))
        self.assertEqual(len([k for k in files if k.endswith('-snapshots.raw')]),12)
        for kwargs in ({'expired':True},{'earlier_deadline':True}):
            with self.subTest(kwargs=kwargs):
                result,calls,*_=self.validation([self.HEALTHY],**kwargs)
                self.assertNotEqual(result.returncode,0);self.assertEqual(calls,[])

    def test_private_snapshot_invalid_observation_and_source_guards_never_retry_or_allocate(self):
        rows=json.loads(self.HEALTHY)
        variants=[('wrong',json.dumps([dict(rows[0],id='vs_foreign')]).encode(),{}),
                  ('duplicate',json.dumps([rows[0],rows[0]]).encode(),{}),
                  ('malformed',b'{not-json',{}),('null',b'null',{}),
                  ('provider-exit',self.EMPTY,{'provider_exit':7}),
                  ('manifest',self.HEALTHY,{'tamper_manifest':True}),
                  ('guardian',self.EMPTY,{'guardian_lost':True})]
        for name,body,kwargs in variants:
            with self.subTest(name=name):
                result,calls,files,*_=self.validation([body,self.HEALTHY],**kwargs)
                self.assertNotEqual(result.returncode,0)
                self.assertEqual(len(calls),1)
                self.assertEqual(files['01-snapshots.raw'],body)
        for journal in ('symlink','reused'):
            with self.subTest(journal=journal):
                result,calls,*_=self.validation([self.HEALTHY],journal=journal)
                self.assertNotEqual(result.returncode,0);self.assertEqual(calls,[])
        result,calls,files,*_=self.validation([self.HEALTHY],wrong_owner=True)
        self.assertNotEqual(result.returncode,0);self.assertEqual(len(calls),3)
        self.assertEqual(files['verify.status'],b'1\n')


if __name__=='__main__':unittest.main()
