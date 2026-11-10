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

if __name__=='__main__':unittest.main()
