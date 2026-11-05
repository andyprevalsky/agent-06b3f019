#!/usr/bin/env python3
"""Real disposable /proc and socket custody; no provider or protected process mutation."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts'))
import deploy_test_foreign_listener as f

@unittest.skipUnless(Path('/proc/self/stat').exists(),'Linux native cleanup protocol')
class ForeignListener(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name)
        self.foreign=self.base/'foreign';self.foreign.mkdir();self.worker=self.base/'worker';self.worker.mkdir()
        self.run=self.foreign/'.context/benchmarks/fixture';self.run.mkdir(parents=True)
        self.cwd=Path.cwd();os.chdir(self.foreign)
        self.log=(self.run/'cloudflared.log').open('w')
        # Python executes a disposable script named tunnel with the real native
        # argv shape. Its only effect is a loopback socket, closed on stdin EOF.
        (self.foreign/'tunnel').write_text("import socket,json,sys\nfrom pathlib import Path\ns=socket.socket();s.bind(('127.0.0.1',0));s.listen();Path('ready.json').write_text(json.dumps({'port':s.getsockname()[1]}));sys.stdin.read();s.close()\n")
        # Fake argv[0] hides the relocated interpreter path; bind its real stdlib.
        self.child=subprocess.Popen(['cloudflared','tunnel','--no-autoupdate','--url','http://127.0.0.1:3802'],executable=sys.executable,env={**os.environ,'PYTHONHOME':sys.base_prefix},cwd=self.foreign,stdin=subprocess.PIPE,stdout=self.log,stderr=self.log)
        end=time.monotonic()+5
        while not(self.foreign/'ready.json').exists() and time.monotonic()<end:time.sleep(.01)
        self.port=json.loads((self.foreign/'ready.json').read_text())['port'];parent=f.process(os.getpid())
        self.owner=self.run/'local-stack-owner.json'
        self.owner.write_text(json.dumps(dict(version=1,run_id='fixture',token='native-token',pid=os.getpid(),native_identity=parent['identity'])))
        (self.run/'local-benchmark-owner.json').write_text(json.dumps(dict(version=1,run_id='fixture',state='failed_retained')))
        (self.run/'services.json').write_text(json.dumps(dict(run_sh_pid=os.getpid(),worktree=str(self.foreign),status='running',ports=dict(frontend=3802))))
        self.row=f.snapshot(self.port,self.child.pid,self.owner)
        self.receipt=dict(token='original',source={'head':'a'*40,'digest':'frozen'},finished_at=time.time()-1)
        self.gate=dict(worker_root=str(self.worker),env=dict(CONDUCTOR_PORT=str(self.port-5764)))
        self.proof=dict(files={'receipt.json':'receipt-hash'},confirmed_at=time.time(),foreign_listeners=dict(schema='protected-foreign-listener-v1',token='original',source=self.receipt['source'],worker_root=str(self.worker),receipt_sha256='receipt-hash',observed_at=time.time(),listeners=[self.row]))
        self.proof['confirmed_at']=time.time()
    def tearDown(self):
        self.child.stdin.close();self.child.wait(timeout=5);self.log.close();os.chdir(self.cwd);self.tmp.cleanup()
    def verify(self):f.validate(self.gate,self.receipt,self.proof,{self.port})
    def test_positive_native_socket_and_owner(self):self.verify()
    def test_wrong_pid(self):
        self.proof['foreign_listeners']['listeners'][0]['listener']['pid']=os.getpid()
        with self.assertRaises(ValueError):self.verify()
    def test_wrong_birth(self):
        self.row['listener']['identity']='wrong'
        with self.assertRaises(ValueError):self.verify()
    def test_wrong_socket(self):
        self.row['sockets'][0]['inode']='0'
        with self.assertRaises(ValueError):self.verify()
    def test_wrong_root(self):
        self.row['foreign_root']=str(self.worker)
        with self.assertRaises(ValueError):self.verify()
    def test_wrong_owner_hash(self):
        self.row['evidence'][str(self.owner)]='0'*64
        with self.assertRaises(ValueError):self.verify()
    def test_changed_native_owner(self):
        value=json.loads(self.owner.read_text());value['native_identity']='reused';self.owner.write_text(json.dumps(value))
        with self.assertRaises(ValueError):self.verify()
    def test_missing_proof(self):
        self.proof.pop('foreign_listeners')
        with self.assertRaises(ValueError):self.verify()
    def test_wrong_original_token(self):
        self.proof['foreign_listeners']['token']='other'
        with self.assertRaises(ValueError):self.verify()
    def test_primary_port_never_excluded(self):
        self.gate['env']['CONDUCTOR_PORT']=str(self.port)
        with self.assertRaises(ValueError):self.verify()
    def test_existing_hub_allocator_skips_occupied_foreign_socket(self):
        script='source "$1"; cloudbench_central_hub_matches(){ return 1; }; cloudbench_select_central_hub_port "$2" "$3"'
        result=subprocess.run(['bash','-c',script,'allocator',str(ROOT/'scripts/lib/cloudbench-env.sh'),str(self.port),str(self.worker/'runs')],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertNotEqual(int(result.stdout),self.port)
        self.verify()  # The protected socket is still live and unchanged.

    def test_missing_native_owner(self):
        self.owner.unlink()
        with self.assertRaises(OSError):self.verify()

if __name__=='__main__':unittest.main()
