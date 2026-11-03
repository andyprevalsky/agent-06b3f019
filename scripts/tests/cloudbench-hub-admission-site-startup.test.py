#!/usr/bin/env python3
"""Actual Hub admission helpers preserve identity/socket rules without site startup."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
SOURCE=Path(os.environ.get('CLOUDBENCH_HUB_ADMISSION_SOURCE',str(ROOT/'scripts/lib/cloudbench-env.sh')))
SERVER=r'''
import http.server,json,sys
from pathlib import Path
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path!='/hub-meta.json':self.send_error(404);return
  body=Path(sys.argv[1]).read_bytes();self.send_response(200);self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
server=http.server.HTTPServer(('127.0.0.1',0),Handler)
print(server.server_port,flush=True);server.serve_forever()
'''


class HubAdmission(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.runs=self.root/'runs';self.context=self.runs/'_hub';self.context.mkdir(parents=True)
        self.repo=self.root/'repo';(self.repo/'agents/benchmarks').mkdir(parents=True)
        self.command=self.repo/'agents/benchmarks/agent_link_server.py';self.command.touch()
        venv=self.root/'venv';(venv/'bin').mkdir(parents=True)
        binary=Path(sys.executable).resolve();(venv/'bin/python3').symlink_to(binary)
        (venv/'pyvenv.cfg').write_text('home = '+str(binary.parent)+'\ninclude-system-site-packages = false\n')
        packages=venv/f'lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages';packages.mkdir(parents=True)
        self.marker=self.root/'site-started'
        (packages/'owning-control.pth').write_text('import os,time; os.close(os.open('+repr(str(self.marker))+',os.O_CREAT|os.O_WRONLY,0o600)); time.sleep(0.05)\n')
        self.env=dict(os.environ,PATH=str(venv/'bin')+':'+os.environ['PATH'])
        self.meta=self.root/'metadata.json';self.meta.write_text('{}')
        self.server=subprocess.Popen([str(binary),'-S','-u','-c',SERVER,str(self.meta)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        self.addCleanup(self.close_server)
        self.port=int(self.server.stdout.readline())
        self.birth=self.call('cloudbench_pid_start_time',self.server.pid).stdout.strip()
        self.assertTrue(self.birth,'fixture server needs an actual process birth')
        self.token='b'*32;self.owner=self.context/f'agent-link-server.{self.port}.{self.token}.owner'
        self.fields=dict(version='1',pid=str(self.server.pid),pid_start=self.birth,pgid=str(self.server.pid),owner_token=self.token,
                         command=str(self.command),argv_sha256='a'*64,root=str(self.runs),runs_root=str(self.runs),repo_root=str(self.repo),
                         context_dir=str(self.context),host='127.0.0.1',port=str(self.port),status='live-transfer-required')
        self.metadata=dict(pid=self.server.pid,pid_start=self.birth,port=self.port,owner_token=self.token,argv_sha256='a'*64,
                           root=str(self.runs),hub_runs_dir=str(self.runs),repo_root=str(self.repo),context_dir=str(self.context),command=str(self.command))
        self.write_owner(self.fields);self.meta.write_text(json.dumps(self.metadata))

    def close_server(self):
        if self.server.poll() is None:self.server.terminate()
        self.server.communicate(timeout=3)

    def write_owner(self,value,mode=0o444):
        if self.owner.exists():self.owner.chmod(0o600)
        self.owner.write_text(''.join(k+'='+v+'\n' for k,v in value.items()));self.owner.chmod(mode)

    def call(self,function,*args):
        # Source the actual complete production library, never reimplement the helper.
        return subprocess.run(['bash','-c','source "$1"; shift; "$@"','fixture',str(SOURCE),function,*map(str,args)],
                              env=self.env,capture_output=True,text=True,timeout=5)

    def test_socket_and_foreign_listener_selection(self):
        self.assertEqual(self.call('cloudbench_tcp_listener_present',self.port).returncode,0)
        with socket.socket() as probe:probe.bind(('127.0.0.1',0));unused=probe.getsockname()[1]
        self.assertEqual(self.call('cloudbench_tcp_listener_present',unused).returncode,1)
        self.assertEqual(self.call('cloudbench_tcp_listener_present','bad-port').returncode,2)
        result=self.call('cloudbench_select_central_hub_port',self.port,self.runs)
        self.assertEqual((result.returncode,result.stdout.strip()),(0,str(self.port)),result.stderr)
        result=self.call('cloudbench_select_central_hub_port',self.port,self.root/'foreign')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertNotEqual(result.stdout.strip(),str(self.port),'foreign occupied listener was reused')
        self.assertIsNone(self.server.poll(),'foreign owner was stopped')
        self.assertFalse(self.marker.exists(),'Hub socket admission initialized venv site packages')

    def test_metadata_json_and_canonical_root_refusals(self):
        value=self.call('cloudbench_central_hub_runs_root',self.port)
        self.assertEqual((value.returncode,value.stdout.strip()),(0,str(self.runs)),value.stderr)
        self.assertEqual(self.call('cloudbench_central_hub_matches',self.port,self.runs/'..'/'runs').returncode,0)
        self.assertNotEqual(self.call('cloudbench_central_hub_matches',self.port,self.root/'foreign').returncode,0)
        self.meta.write_text('{invalid')
        self.assertNotEqual(self.call('cloudbench_central_hub_runs_root',self.port).returncode,0)
        self.assertNotEqual(self.call('cloudbench_central_hub_matches',self.port,self.runs).returncode,0)
        self.assertFalse(self.marker.exists(),'Hub metadata parsers initialized venv site packages')

    def test_exact_owner_birth_and_foreign_metadata_rules(self):
        args=(self.port,self.runs,self.repo,self.owner)
        result=self.call('cloudbench_central_hub_owner_matches',*args)
        self.assertEqual(result.returncode,0,result.stderr)
        found=self.call('cloudbench_central_hub_owner_for',self.port,self.runs,self.repo)
        self.assertEqual((found.returncode,found.stdout.strip()),(0,str(self.owner)),found.stderr)
        for key,value in [('owner_token','c'*32),('argv_sha256','c'*64),('repo_root',str(self.root/'foreign'))]:
            self.meta.write_text(json.dumps(dict(self.metadata,**{key:value})))
            self.assertNotEqual(self.call('cloudbench_central_hub_owner_matches',*args).returncode,0,key)
        self.meta.write_text(json.dumps(self.metadata))
        self.write_owner(self.fields,0o644)
        self.assertNotEqual(self.call('cloudbench_central_hub_owner_matches',*args).returncode,0,'writable owner accepted')
        self.write_owner(dict(self.fields,pid_start='proc-start:'+('wrong-boot')+':1'))
        self.meta.write_text(json.dumps(dict(self.metadata,pid_start='proc-start:wrong-boot:1')))
        self.assertNotEqual(self.call('cloudbench_central_hub_owner_matches',*args).returncode,0,'wrong process birth accepted')
        self.assertIsNone(self.server.poll(),'owner validation signalled server')
        self.assertFalse(self.marker.exists(),'Hub owner admission initialized venv site packages')


if __name__=='__main__':unittest.main()
