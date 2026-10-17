#!/usr/bin/env python3
"""Offline public CLI, original argv and fresh capacity/binding contracts."""
import argparse
import ast
import base64
import errno
import gzip
import hashlib
import importlib.util
import io
import http.server
import json
import os
from pathlib import Path
import runpy
import signal
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import types
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('operator_cli', Path(os.environ.get('PORTABLE_OPERATOR_SOURCE', ROOT/'scripts/run-original600-controller.py')))
CLI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CLI)
RUNNER = runpy.run_path(os.environ.get('ORIGINAL600_RUNNER_SOURCE',str(ROOT/'scripts/cloudbench-original600-runner.py')))


def private(path, value):
    path.write_text(json.dumps(value) if not isinstance(value, str) else value)
    path.chmod(0o600)
    return path


class Portable(unittest.TestCase):
    def large_sidecar(self, root):
        raw='\n'.join(hashlib.sha256(str(i).encode()).hexdigest() for i in range(14000)).encode()
        item=dict(relative_path='.git/cloudbench-stream-fixture.json',sha256=CLI.digest(raw))
        remote=dict(source_ref='a'*40,epoch=time.time(),remote_files=[RUNNER['encode_remote_file'](item,raw)])
        payload,digest,command=RUNNER['launch_handoff'](root,remote)
        self.assertLess(payload.stat().st_size,256*1024)
        self.assertLess(max(map(len,command)),16000)
        descriptor=json.loads(gzip.decompress(payload.read_bytes()))['remote_files'][0]
        self.assertEqual(descriptor['encoding'],'external-gzip')
        return raw,payload,digest,descriptor

    def sidecar_api(self, guest, envelope, fail_ack=False, foreign=False, starting=False):
        (guest/'controller-launch-payload.json.gz').write_bytes(envelope.read_bytes())
        (guest/'controller-launch-payload.json.gz').chmod(0o600)
        ref=json.loads(gzip.decompress(envelope.read_bytes()))['source_ref']
        record=dict(id='1'*14,state='started',instance_id='original-instance',config=dict(env=dict(GATE_REF=ref)))
        owner=self
        class API:
            posts=0
            gets=0
            actions=[]
            max_command_bytes=0
            max_body_bytes=0
            seen=set()
            failed=False
            def api(self,method,path,body=None,timeout=None,observer=None):
                owner.assertEqual(path,'/machines/'+'1'*14+('/exec' if method=='POST' else ''))
                if method=='GET':
                    self.gets+=1
                    response=dict(record,instance_id='foreign' if foreign else record['instance_id'])
                    if starting and self.gets==1:response['state']='starting'
                    if observer:observer(method,path,200,json.dumps(response).encode())
                    return response
                self.posts+=1
                self.max_command_bytes=max(self.max_command_bytes,len(body['cmd'].encode()))
                self.max_body_bytes=max(self.max_body_bytes,len(json.dumps(body).encode()))
                if len(json.dumps(body).encode())>16384:
                    response=dict(stdout='',stderr='Unhandled rejection: PayloadTooLarge',exit_code=0)
                    if observer:observer(method,path,200,json.dumps(response).encode())
                    return response
                argv=shlex.split(body['cmd'])
                if 'gzip.decompress' in argv[2]:script,request=json.loads(gzip.decompress(base64.b64decode(argv[-1])))
                else:script,request=argv[2],json.loads(base64.b64decode(argv[-1]))
                self.actions.append(request['action'])
                # Only filesystem root/account resolution are fixture-specific.
                # The real receiver, request framing and OS file operations run.
                script=('import os,pwd,types\npwd.getpwnam=lambda name:types.SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())\n'+script.replace("root=Path('/tmp')",'root=Path('+repr(str(guest))+')'))
                if request['action'] not in self.seen:
                    self.seen.add(request['action'])
                    if 'gzip.decompress' in argv[2]:argv[-1]=base64.b64encode(gzip.compress(json.dumps([script,request]).encode(),mtime=0)).decode()
                    else:argv[2]=script
                    done=subprocess.run(argv,capture_output=True,text=True,timeout=timeout,
                        env=dict(os.environ,FLY_MACHINE_ID=record['id'],GATE_REF=ref))
                    response=dict(stdout=done.stdout,stderr=done.stderr,exit_code=done.returncode)
                else:
                    scope={'__name__':'fixture_receiver'};exec(script,scope)
                    with patch.dict(os.environ,FLY_MACHINE_ID=record['id'],GATE_REF=ref):
                        try:response=dict(stdout=json.dumps(scope['receive'](request,guest)),stderr='',exit_code=0)
                        except Exception as error:response=dict(stdout='',stderr=repr(error),exit_code=1)
                if (fail_ack is True and (self.failed or request['action']=='fragment')) or (fail_ack=='once' and not self.failed and request['action']=='fragment'):
                    self.failed=True;raise TimeoutError('lost response after receiver wrote chunk')
                if observer:observer(method,path,200,json.dumps(response).encode())
                return response
        return API(),record

    def test_large_payload_streams_exact_bytes_without_config_growth(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);host=root/'host';guest=root/'guest';host.mkdir();guest.mkdir()
            raw,envelope,digest,descriptor=self.large_sidecar(host)
            api,record=self.sidecar_api(guest,envelope)
            RUNNER['transfer_sidecars'](api,record['id'],record,host,digest,time.time()+60)
            delivered=guest/Path(descriptor['transfer_path']).name
            self.assertEqual(gzip.decompress(delivered.read_bytes()),raw)
            self.assertEqual(delivered.stat().st_mode&0o777,0o600)
            self.assertEqual(delivered.stat().st_uid,os.getuid())
            self.assertEqual(delivered.stat().st_nlink,1)
            self.assertGreater(api.posts,2)
            self.assertLessEqual(api.max_body_bytes,6200)
            self.assertTrue((host/'payload-transfer/complete.json').is_file())
            node=next(n for n in ast.parse(RUNNER['REMOTE_LAUNCH']).body if isinstance(n,ast.FunctionDef) and n.name=='decode_remote_file')
            scope=dict(base64=base64,gzip=gzip,io=io,hashlib=hashlib,os=os,stat=__import__('stat'),time=time,v={'epoch':time.time()},
                       Path=lambda value:guest/Path(value).name)
            exec(compile(ast.Module(body=[node],type_ignores=[]),'<production sidecar decoder>','exec'),scope)
            self.assertEqual(scope['decode_remote_file'](descriptor),raw)
            delivered.write_bytes(b'corrupt')
            with self.assertRaises(AssertionError):scope['decode_remote_file'](descriptor)

    def test_sidecar_unknown_ack_is_retained_without_post_retry(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);host=root/'host';guest=root/'guest';host.mkdir();guest.mkdir()
            _,envelope,digest,_=self.large_sidecar(host)
            api,record=self.sidecar_api(guest,envelope,fail_ack=True)
            with self.assertRaises(TimeoutError):
                RUNNER['transfer_sidecars'](api,record['id'],record,host,digest,time.time()+60)
            self.assertEqual(api.actions[-2:],['fragment','observe-fragment'])
            self.assertEqual(len(list((host/'payload-transfer').glob('*.pending.json'))),1)
            self.assertFalse((host/'payload-transfer/complete.json').exists())
            self.assertEqual(len(list(guest.glob('controller-sidecar-*/fragments-*/*'))),1)

    def test_sidecar_waits_for_same_instance_to_start_before_exec(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);host=root/'host';guest=root/'guest';host.mkdir();guest.mkdir()
            _,envelope,digest,_=self.large_sidecar(host)
            api,record=self.sidecar_api(guest,envelope,starting=True)
            original=api.api
            def guarded(method,*args,**kwargs):
                if method=='POST':self.assertGreaterEqual(api.gets,2)
                return original(method,*args,**kwargs)
            api.api=guarded
            RUNNER['transfer_sidecars'](api,record['id'],record,host,digest,time.time()+60)
            self.assertTrue((host/'payload-transfer/complete.json').exists())

    def test_sidecar_lost_ack_reconciles_by_read_without_replaying_write(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);host=root/'host';guest=root/'guest';host.mkdir();guest.mkdir()
            _,envelope,digest,_=self.large_sidecar(host)
            api,record=self.sidecar_api(guest,envelope,fail_ack='once')
            RUNNER['transfer_sidecars'](api,record['id'],record,host,digest,time.time()+60)
            index=api.actions.index('fragment')
            self.assertEqual(api.actions[index:index+2],['fragment','observe-fragment'])
            self.assertTrue((host/'payload-transfer/complete.json').exists())
            self.assertEqual(len(list((host/'payload-transfer').glob('*.pending.json'))),1)
            self.assertEqual(len(list((host/'payload-transfer').glob('*.reconciled.json'))),1)

    def test_sidecar_cancellation_stops_before_next_request(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);host=root/'host';guest=root/'guest';host.mkdir();guest.mkdir()
            _,envelope,digest,_=self.large_sidecar(host)
            api,record=self.sidecar_api(guest,envelope)
            with self.assertRaises(RUNNER['Deadline']):
                RUNNER['transfer_sidecars'](api,record['id'],record,host,digest,time.time()+60,lambda:'fragment' in api.actions)
            self.assertEqual(api.actions[-1],'fragment')
            self.assertFalse((host/'payload-transfer/complete.json').exists())

    def test_sidecar_raw_http_body_precedes_json_parse_failure(self):
        capture=runpy.run_path(str(ROOT/'scripts/cloudbench-original-volume-capture.py'))
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200);self.end_headers();self.wfile.write(b'{')
            def log_message(self,*args):pass
        server=http.server.HTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever);thread.start()
        try:
            api=object.__new__(capture['Fly']);api.app='fixture';api.authorization='Bearer fixture';api.loopback=True
            api.base='http://127.0.0.1:'+str(server.server_port)
            with tempfile.TemporaryDirectory() as name:
                host=Path(name);_,_,digest,_=self.large_sidecar(host)
                with self.assertRaises(json.JSONDecodeError):
                    RUNNER['transfer_sidecars'](api,'1'*14,dict(config=dict(env=dict(GATE_REF='a'*40))),host,digest,time.time()+60)
                wire=list((host/'payload-transfer').glob('*.wire.json'))
                self.assertEqual(len(wire),1)
                self.assertEqual(base64.b64decode(json.loads(wire[0].read_bytes())['body_b64']),b'{')
                self.assertFalse(list((host/'payload-transfer').glob('*.response.json')))
        finally:server.shutdown();thread.join();server.server_close()

    def test_sidecar_foreign_incarnation_and_expired_clock_refuse_before_write(self):
        for foreign in (False,True):
            with self.subTest(foreign=foreign),tempfile.TemporaryDirectory() as name:
                root=Path(name);host=root/'host';guest=root/'guest';host.mkdir();guest.mkdir()
                _,envelope,digest,_=self.large_sidecar(host)
                api,record=self.sidecar_api(guest,envelope,foreign=foreign)
                with self.assertRaises(ValueError):
                    RUNNER['transfer_sidecars'](api,record['id'],record,host,digest,time.time()+60 if foreign else time.time()-1)
                self.assertEqual(api.posts,0)

    def test_typed_payload_refusal_keeps_original_output_and_clock(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);out=root/'run';out.mkdir(mode=0o700)
            ref='efd8a396a6b6e4a65d10186c7c9a24342ad9065a'
            config=private(root/'config.private.json',dict(source_ref=ref,started_at_epoch=100))
            authority=dict(source_ref=ref,output_directory=str(out/'export'),cleanup_owner_pid=99999999,cleanup_owner_birth='gone')
            private(out/'authority.private.json',authority)
            receipt=dict(schema='original600-host-payload-failure-v1',reason='compressed launch payload too large for config transport',gate_created=False,
                         source_ref=ref,config_path=str(config),config_sha256=CLI.digest(config.read_bytes()),output_directory=str(out),
                         host_runner_sha256='f0da1304a88459677a4f5017c7c8689c73c3441357e635fe9040450637c1ab0f',owner_pid=99999999,owner_birth='gone')
            evidence=private(out/'launch-payload-failure.json',receipt)
            before={p.name:p.read_bytes() for p in out.iterdir()}
            accepted=CLI.prelaunch_failure(RUNNER,out,evidence,config,CLI.digest(config.read_bytes()))
            self.assertEqual(accepted['prior_output'],str(out))
            self.assertFalse(Path(accepted['successor_output']).exists())
            self.assertEqual({p.name:p.read_bytes() for p in out.iterdir()},before)
            private(out/'caller.json',{})
            with self.assertRaisesRegex(ValueError,'possible gate activity'):
                CLI.prelaunch_failure(RUNNER,out,evidence,config,CLI.digest(config.read_bytes()))

    def test_inner_file_compression_preserves_bytes_with_existing_outer_bound(self):
        data=json.dumps({'inputs':{f'/state/original600-123456789/archived-reuse-reservations/old-machine/wire/request-{i}.json':hashlib.sha256(str(i).encode()).hexdigest() for i in range(5500)}}).encode()
        item={'relative_path':'.git/cloudbench-fixture.json','sha256':CLI.digest(data)}
        legacy=dict(item,data=base64.b64encode(data).decode())
        with tempfile.TemporaryDirectory() as name:
            root=Path(name)
            first=root/'legacy';first.mkdir()
            first_path,_,_=RUNNER['launch_handoff'](first,{'remote_files':[legacy]})
            self.assertLess(first_path.stat().st_size,256*1024)
            self.assertTrue((first/'controller-sidecars.private.json').exists())
            encoded=RUNNER['encode_remote_file'](item,data)
            path,_,command=RUNNER['launch_handoff'](root,{'remote_files':[encoded]})
            self.assertLess(path.stat().st_size,256*1024)
            self.assertLess(max(map(len,command)),16000)
            node=next(n for n in ast.parse(RUNNER['REMOTE_LAUNCH']).body if isinstance(n,ast.FunctionDef) and n.name=='decode_remote_file')
            scope=dict(base64=base64,gzip=gzip,io=io,hashlib=hashlib)
            exec(compile(ast.Module(body=[node],type_ignores=[]),'<actual remote decoder>','exec'),scope)
            self.assertEqual(scope['decode_remote_file'](encoded),data)
            self.assertEqual(scope['decode_remote_file'](legacy),data)
            with self.assertRaises(AssertionError):scope['decode_remote_file'](dict(encoded,sha256='0'*64))

    def test_observed_payload_guard_refusal_requires_positive_bound_history(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);out=root/'run';out.mkdir(mode=0o700)
            ref='852692d8c850c6d20640103561fa02ad0cb333ed'
            config=private(root/'config',dict(source_ref=ref,started_at_epoch=100))
            auth=private(out/'authority.private.json',dict(source_ref=ref,output_directory=str(out/'export'),cleanup_owner_pid=99999999,cleanup_owner_birth='gone'))
            log=private(root/'log','\n'.join([json.dumps({'status':'ADMISSION_STARTED','source_ref':ref}),json.dumps({'status':'LAUNCHING_ORIGINAL600','source_ref':ref,'directory':str(config.parent)}),'line 236, in run','    payload,payload_sha,remote_command=launch_handoff(out,remote)','line 176, in launch_handoff','ValueError: compressed launch payload too large for config transport'])+'\n')
            evidence=private(root/'refusal',dict(schema='observed-host-prelaunch-refusal-v1',tool_reported_exit_code=1,gate_created=False,error='compressed launch payload too large for config transport',source_ref=ref,config_path=str(config),config_sha256=CLI.digest(config.read_bytes()),output_directory=str(out),log=str(log),log_sha256=CLI.digest(log.read_bytes()),output_files={'authority.private.json':{'bytes':auth.stat().st_size,'sha256':CLI.digest(auth.read_bytes())}}))
            accepted=CLI.prelaunch_failure(RUNNER,out,evidence,config,CLI.digest(config.read_bytes()))
            self.assertTrue(Path(accepted['successor_output']).name.startswith('run-after-prelaunch-'))
            self.assertFalse(Path(accepted['successor_output']).exists())
            private(out/'caller.json',{'possible_effect':True})
            with self.assertRaisesRegex(ValueError,'possible gate activity'):
                CLI.prelaunch_failure(RUNNER,out,evidence,config,CLI.digest(config.read_bytes()))

    def test_unused_reservation_paths_are_bound_without_changing_legacy_bindings(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            args = argparse.Namespace(source_ref='a'*40, org='personal', extra_destroying_count=1,
                                      archive_run=[root/'original'], reuse_exclude_machine=['a'*14])
            for field in ('facts','agents_env','backend_env','tasks','snapshot_inventory','warm_deps'):
                setattr(args, field, private(root/field, 'fixture'))
            legacy = CLI.admission_binding(args, RUNNER)
            self.assertNotIn('unused_reservation_runs', legacy)
            args.unused_reservation_run = [root/'closed-admission']
            bound = CLI.admission_binding(args, RUNNER)
            self.assertEqual(bound['unused_reservation_runs'], [str(root/'closed-admission')])
            self.assertEqual({k:v for k,v in bound.items() if k!='unused_reservation_runs'}, legacy)
            directory,_ = CLI.open_admission(root,None,bound,RUNNER,True)
            args.unused_reservation_run = [root/'different-admission']
            with self.assertRaisesRegex(ValueError, 'source/inputs/archives'):
                CLI.open_admission(root,directory,CLI.admission_binding(args,RUNNER),RUNNER,True)

    def test_large_launch_payload_uses_a_small_hash_bound_file_command(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name)
            remote={'remote_files':[{'data':'x'*400000}], 'tasks':['unchanged']}
            old_argument=__import__('base64').b64encode(json.dumps(remote).encode()).decode()
            with self.assertRaises(OSError) as old:
                subprocess.run([sys.executable,'-c','pass',old_argument],check=True)
            self.assertEqual(old.exception.errno,errno.E2BIG)
            path,digest,command=RUNNER['launch_handoff'](root,remote)
            self.assertEqual(json.loads(gzip.decompress(path.read_bytes())),remote)
            self.assertEqual(CLI.digest(path.read_bytes()),digest)
            self.assertLess(max(map(len,command)),16000)
            self.assertLess(path.stat().st_size,256*1024)
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            # Run the exact gate's pre-provider file verifier, not a copy.
            gate=(ROOT/'scripts/run-cloudbench-controller-gate').read_text()
            verifier=gate.split("<<'PY_LAUNCH_PAYLOAD'",1)[1].split('\nPY_LAUNCH_PAYLOAD',1)[0]
            result=subprocess.run([sys.executable,'-c',verifier,str(path),digest],capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr)
            for bad_path,bad_sha in [(path,'0'*64),(root/'link',digest)]:
                if bad_path.name=='link':bad_path.symlink_to(path)
                result=subprocess.run([sys.executable,'-c',verifier,str(bad_path),bad_sha],capture_output=True)
                self.assertNotEqual(result.returncode,0)
            # The new actual remote argv is executable; absent guest file fails
            # inside Python, rather than at OS exec before the child exists.
            result=subprocess.run(command,capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn(b'FileNotFoundError',result.stderr)

    def test_popen_e2big_writes_positive_no_gate_receipt(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);config=private(root/'config',{})
            authority=private(root/'authority',{})
            stream=(root/'gate.private.log').open('xb')
            try:
                with self.assertRaises(OSError) as failed:
                    RUNNER['spawn_gate']([sys.executable,'-c','pass','x'*400000],root,os.environ.copy(),stream,root,config,CLI.digest(config.read_bytes()),authority)
                self.assertEqual(failed.exception.errno,errno.E2BIG)
            finally:stream.close()
            receipt=json.loads((root/'gate-start-failure.json').read_bytes())
            self.assertEqual(receipt['errno'],7)
            self.assertIs(receipt['gate_created'],False)
            self.assertEqual(receipt['config_sha256'],CLI.digest(config.read_bytes()))
            self.assertEqual((root/'gate.private.log').stat().st_size,0)
            self.assertFalse((root/'caller.json').exists())

    def test_legacy_e2big_import_requires_positive_traceback_and_exact_output(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);out=root/'run';out.mkdir(mode=0o700)
            old_ref='57e37b5cb08f7604a63e88ee1f07ebc0b15da9f1'
            old_source=subprocess.check_output(['git','-C',str(ROOT),'show',old_ref+':scripts/cloudbench-original600-runner.py'])
            config=private(root/'config',dict(source_ref='a'*40,started_at_epoch=100))
            provenance=dict(host_operator_source_ref=old_ref,host_runner_sha256=CLI.digest(old_source),workload_source_ref='a'*40,
                original_config_path=str(config),original_config_sha256=CLI.digest(config.read_bytes()),original_started_at_epoch=100)
            private(out/'host-operator-provenance.json',provenance)
            private(out/'authority.private.json',dict(cleanup_owner_pid=99999999,cleanup_owner_birth='gone',source_ref='a'*40,output_directory=str(out/'export')))
            private(out/'gate.private.log','')
            log=private(root/'trace.log',json.dumps(dict(host_operator_source_ref=old_ref,source_ref='a'*40))+'\n'+
                '  File "scripts/cloudbench-original600-runner.py", line 204, in run\n'+
                "    stream=log.open('xb');gate=subprocess.Popen(command,cwd=root,env=env,stdout=stream,stderr=subprocess.STDOUT)\n"+
                "OSError: [Errno 7] Argument list too long: 'bash'\n")
            receipt=dict(schema='observed-tool-session-join-v1',tool_reported_exit_code=1,log_contains_synchronous_popen_errno=7,
                gate_pid='NOT_CREATED_BY_FAILED_POPEN',stderr_and_stdout_log=str(log),log_sha256=CLI.digest(log.read_bytes()),
                run_output_files_observed={str(p):dict(bytes=p.stat().st_size,sha256=CLI.digest(p.read_bytes())) for p in out.iterdir()})
            evidence=private(root/'evidence',receipt)
            accepted=CLI.prelaunch_failure(RUNNER,out,evidence,config,CLI.digest(config.read_bytes()))
            self.assertEqual(accepted['prior_output'],str(out))
            self.assertFalse(Path(accepted['successor_output']).exists())
            private(out/'caller.json',{'possible_child':True})
            with self.assertRaisesRegex(ValueError,'possible gate activity'):
                CLI.prelaunch_failure(RUNNER,out,evidence,config,CLI.digest(config.read_bytes()))
            (out/'caller.json').unlink()
            log.write_text(log.read_text().replace('Errno 7','Errno 5'))
            with self.assertRaisesRegex(ValueError,'traceback changed'):
                CLI.prelaunch_failure(RUNNER,out,evidence,config,CLI.digest(config.read_bytes()))

    def test_inventory_reader_preserves_private_bounds_and_small_reader_limit(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            path = private(root/'native.json', '["' + 'x'*(17*1024*1024) + '"]')
            with self.assertRaises(ValueError):
                RUNNER['read'](path)
            self.assertEqual(len(CLI.read_inventory(path)), path.stat().st_size)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                CLI.read_inventory(path)
            path.chmod(0o600)
            link=root/'linked.json';link.symlink_to(path)
            with self.assertRaises(ValueError):
                CLI.read_inventory(link)
            hard=root/'hard.json';os.link(path,hard)
            with self.assertRaises(ValueError):
                CLI.read_inventory(path)
            hard.unlink()
            with path.open('r+b') as stream:
                stream.truncate(256*1024*1024+1)
            with self.assertRaises(ValueError):
                CLI.read_inventory(path)

    def test_reused_image_binding_uses_immutable_repository_digest(self):
        pin='registry.fly.io/benchmark:expected@sha256:'+'a'*64
        request={'candidates':[{'machine_id':'one'}]}
        machine={'id':'one','config':{'image':'registry.fly.io/benchmark:different-label@sha256:'+'a'*64},
                 'image_ref':{'digest':'sha256:'+'a'*64}}
        CLI.verify_reuse_images(request,[machine],pin)
        for bad in ['registry.fly.io/other@sha256:'+'a'*64,'registry.fly.io/benchmark@sha256:'+'b'*64,'registry.fly.io/benchmark:latest']:
            with self.subTest(image=bad),self.assertRaises(ValueError):
                CLI.verify_reuse_images(request,[dict(machine,config={'image':bad})],pin)
        with self.assertRaises(ValueError):
            CLI.verify_reuse_images(request,[dict(machine,image_ref={'digest':'sha256:'+'c'*64})],pin)

    def test_admission_signal_unwinds_once_and_restores_handlers_after_join(self):
        previous={number:signal.getsignal(number) for number in (signal.SIGINT,signal.SIGTERM)}
        joined=[]
        with self.assertRaises(CLI.AdmissionInterrupted) as interrupted:
            with CLI.joined_admission_signals():
                try:
                    signal.getsignal(signal.SIGTERM)(signal.SIGTERM,None)
                finally:
                    # A repeated signal during native cleanup cannot interrupt joining.
                    signal.getsignal(signal.SIGINT)(signal.SIGINT,None)
                    joined.append(True)
        self.assertEqual(interrupted.exception.signum,signal.SIGTERM)
        self.assertEqual(joined,[True])
        for number,handler in previous.items():
            self.assertEqual(signal.getsignal(number),handler)

    def test_resume_keeps_original_clock_and_rejects_changed_inputs_or_launched_owner(self):
        with tempfile.TemporaryDirectory() as name:
            parent=Path(name);binding={'source_ref':'a'*40,'inputs':{'env':'digest'}}
            directory,epoch=CLI.open_admission(parent,None,binding,RUNNER,True)
            resumed,resumed_epoch=CLI.open_admission(parent,directory,binding,RUNNER,True)
            self.assertEqual((resumed,resumed_epoch),(directory,epoch))
            self.assertEqual(len(list(parent.iterdir())),1)
            with self.assertRaisesRegex(ValueError,'source/inputs/archives'):
                CLI.open_admission(parent,directory,dict(binding,source_ref='b'*40),RUNNER,True)
            with self.assertRaisesRegex(ValueError,'source/inputs/archives'):
                CLI.open_admission(parent,directory,binding,RUNNER,False)
            private(directory/'controller-launch.intent.json',{'existing_owner':True})
            with self.assertRaisesRegex(ValueError,'already bound'):
                CLI.open_admission(parent,directory,binding,RUNNER,True)
            self.assertEqual(json.loads((directory/'admission-intent.private.json').read_text())['started_at_epoch'],epoch)

    def test_archived_eligibility_is_not_reserved_capacity(self):
        with tempfile.TemporaryDirectory() as name:
            directory=Path(name)
            settings={'data':{'organization':{'slug':'personal','settings':{'machines_per_org_limit':1000},'billingStatus':'fixture'}}}
            apps=subprocess.CompletedProcess([],0,json.dumps([{'Name':'navi-whisper-lux-bench','Organization':{'Slug':'personal'}}]),'')
            request={'candidates':[{'machine_id':str(i)} for i in range(375)]}
            calls=[]
            class API:
                def __init__(self,*unused):pass
                def api(self,method,path,timeout):
                    calls.append((method,path))
                    return [{'id':str(i)} for i in range(417)]
            helper={'prepare_request':lambda *unused:request,'validate_request':lambda *unused:None,
                    'capacity_demand':lambda *unused:{'qualified_reuse_count':375}}
            with patch.object(CLI.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps(settings).encode())), \
                 patch.object(CLI.subprocess,'run',return_value=apps),patch.object(CLI,'reuse_module',return_value=helper):
                result=CLI.capacity(API,'fixture','personal',directory,1,[directory/'old-run'],'a'*40)
            baseline=directory/'without-reuse';baseline.mkdir()
            with patch.object(CLI.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps(settings).encode())), \
                 patch.object(CLI.subprocess,'run',return_value=apps),self.assertRaisesRegex(ValueError,'insufficient measured capacity'):
                CLI.capacity(API,'fixture','personal',baseline,1)
            self.assertEqual(result['available_slots_conservative'],582)
            self.assertEqual(result['eligible_reuse_count'],375)
            self.assertEqual(result['qualified_reuse_count'],0)
            self.assertEqual(result['new_machine_demand'],601)
            self.assertEqual(result['admission'],'ELIGIBLE_NOT_RESERVED')
            self.assertEqual(calls,[('GET','/machines'),('GET','/machines')])
            self.assertFalse((directory/'capacity-proof.private.json').exists())

    def test_reserved_credit_requires_fresh_native_readback_and_original_tasks(self):
        with tempfile.TemporaryDirectory() as name:
            directory=Path(name);before=directory/'before';before.mkdir()
            tasks=json.loads((ROOT/'scripts/tests/fixtures/original600-tasks.json').read_text())
            args=argparse.Namespace(source_ref='a'*40,org='personal',extra_destroying_count=1,
                  tasks=private(directory/'tasks',tasks),facts=private(directory/'facts',
                  dict(app='navi-whisper-lux-bench',image_ref='fixture@sha256:'+'b'*64,protected_machines=['p1','p2','p3','p4'],protected_volumes=['v1'])))
            candidates=[{'machine_id':'candidate-'+str(i)} for i in range(375)]
            private(before/'archived-reuse-request.private.json',{'candidates':candidates})
            machines=[{'id':row['machine_id'],'config':{'image':'fixture@sha256:'+'b'*64},'reserved':True} for row in candidates]
            machines[0]['_fixture_padding']='x'*(17*1024*1024)
            private(before/'navi-whisper-lux-bench.private.json',machines)
            events=[]
            def reserve(factory,request,journal):
                events.append('reserve')
                self.assertEqual(request['task_names'],tasks)
                self.assertIs(factory(journal/'first'),factory(journal/'second'),
                              'reservations must reuse one resolved authentication client')
                return dict(request,candidates=[dict(row,reservation={'cohort':'fixture'}) for row in candidates])
            def snapshot(*parameters):
                events.append('fresh-read')
                private(parameters[3]/'navi-whisper-lux-bench.private.json',machines)
                return dict(available_slots_conservative=582,ended_epoch=time.time())
            def demand(request,inventory,protected,*,require_reserved=False):
                events.append('verify-reserved')
                self.assertTrue(require_reserved)
                self.assertEqual(protected,{'p1','p2','p3','p4'})
                self.assertTrue(inventory[0]['reserved'])
                self.assertIn('reservation',request['candidates'][0])
                return dict(qualified_reuse_count=375,new_machine_demand=226,qualified_ids=[row['machine_id'] for row in candidates])
            helper={'validate_request':lambda *unused:None,'reserve_cohort':reserve,'capacity_demand':demand,
                    'NativeAdapter':lambda connection,journal:connection}
            with patch.object(CLI,'reuse_module',return_value=helper),patch.object(CLI,'capacity_snapshot',side_effect=snapshot):
                result=CLI.reserve_reuse_capacity(lambda *unused:object(),'fixture',args,RUNNER,directory,before,{'available_slots_conservative':582})
            self.assertEqual(events,['reserve','fresh-read','verify-reserved'])
            self.assertEqual(result['admission'],'RESERVED_NATIVE_READBACK')
            self.assertEqual(result['new_machine_demand'],226)
            saved=json.loads(Path(result['proof_path']).read_text())
            self.assertEqual(saved['qualified_reuse_count'],375)
            self.assertEqual(saved['reservation_request_sha256'],CLI.digest((directory/'archived-reuse-request.private.json').read_bytes()))
            # Restarting admission uses the original task-bound request, not a new cohort.
            saved_request=json.loads((directory/'archived-reuse-original.private.json').read_text())['request']
            self.assertEqual(saved_request['task_names'],tasks)
            private(directory/'different-tasks',tasks[:-1])
            args.tasks=directory/'different-tasks'
            with patch.object(CLI,'reuse_module',return_value=helper),self.assertRaisesRegex(ValueError,'task manifest'):
                CLI.reserve_reuse_capacity(None,'fixture',args,RUNNER,directory,before,{'available_slots_conservative':600})
            self.assertEqual(events,['reserve','fresh-read','verify-reserved'])

    def test_explicit_complete_github_sources_and_process_precedence_before_launch(self):
        with tempfile.TemporaryDirectory() as name:
            base=Path(name);root=base/'sparse';(root/'scripts/lib').mkdir(parents=True)
            (root/'scripts/lib/cloudbench-env.sh').write_bytes((ROOT/'scripts/lib/cloudbench-env.sh').read_bytes())
            backend=private(base/'backend.env','COMPLETE=fixture\nGITHUB_TOKEN=fixture_backend\n')
            agents=private(base/'agents.env','COMPLETE=fixture\nGITHUB_TOKEN=fixture_agents\n')
            binary=base/'bin';binary.mkdir()
            for command in ['git','gh']:
                file=binary/command;file.write_text('#!/bin/sh\nexit 1\n');file.chmod(0o700)
            environment=dict(os.environ,PATH=str(binary)+':'+os.environ['PATH'])
            for key in ['GITHUB_TOKEN','GH_TOKEN','CLOUDBENCH_GITHUB_TOKEN_B64']:environment.pop(key,None)
            with patch.dict(os.environ,environment,clear=True):
                self.assertEqual(CLI.github_token(root,backend,agents),'fixture_backend')
                with patch.dict(os.environ,GITHUB_TOKEN='fixture_process'):
                    self.assertEqual(CLI.github_token(root,backend,agents),'fixture_process')
                backend.write_text('COMPLETE=fixture\n')
                self.assertEqual(CLI.github_token(root,backend,agents),'fixture_agents')
                agents.write_text('COMPLETE=fixture\n')
                with self.assertRaisesRegex(ValueError,'GitHub credential unavailable'):
                    CLI.github_token(root,backend,agents)
            self.assertFalse((root/'back-end/.env').exists())
            self.assertFalse((root/'agents/.env').exists())

    def test_actual_gate_typed_preallocation_refusal_terminates_only_joined_no_effect(self):
        source=Path(os.environ.get('ORIGINAL600_GATE_SOURCE',ROOT/'scripts/run-cloudbench-controller-gate')).read_text()
        message=source.index('echo "❌ No GitHub token (gh auth, GITHUB_TOKEN, back-end/.env)"')
        # Old source used a one-line || refusal; run that exact old statement.
        start=source.rfind('\n',0,message)+1
        if source[start:message].lstrip().startswith('[ -n '):
            block=source[start:source.index('\n',message)]
        else:
            start=source.rfind('if [ -z "$GITHUB_TOKEN_VALUE" ]; then',0,message)
            block=source[start:source.index('\nfi\n',message)+3]
        with tempfile.TemporaryDirectory() as name:
            out=Path(name);out.chmod(0o700);receipt=out/'early.json';export=out/'export';ref='a'*40
            env=dict(os.environ,CLOUDBENCH_GATE_NO_EFFECT_RECEIPT=str(receipt),GATE_REF=ref)
            child=subprocess.Popen(['bash','-c','GITHUB_TOKEN_VALUE=""\n'+block],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            stdout,stderr=child.communicate(timeout=3)
            self.assertEqual(child.returncode,1)
            self.assertIn(b'No GitHub token',stderr)
            value=RUNNER['preallocation_terminal'](True,1,child.pid,ref,export,receipt)
            self.assertIsNotNone(value,'actual preallocation gate refusal must not strand cleanup owner')
            self.assertEqual(value['status'],'FAILED_BEFORE_PROVIDER_DISPATCH')
            self.assertFalse(value['allocation_attempted'])
            self.assertIsNone(RUNNER['preallocation_terminal'](False,1,child.pid,ref,export,receipt))
            self.assertIsNone(RUNNER['preallocation_terminal'](True,1,child.pid+1,ref,export,receipt))
            self.assertIsNone(RUNNER['preallocation_terminal'](True,2,child.pid,ref,export,receipt))
            export.mkdir();private(export/'workspace-volume.intent.json',dict(unknown_create=True))
            self.assertIsNone(RUNNER['preallocation_terminal'](True,1,child.pid,ref,export,receipt))
            receipt.unlink()
            self.assertIsNone(RUNNER['preallocation_terminal'](True,1,child.pid,ref,out/'absent',receipt))

    def test_literal_token_accepts_canonical_scheme_without_nested_authorization(self):
        for value in ['opaque-token', 'FlyV1 fm2_fixture+/=', 'Bearer opaque-token',
                      '"FlyV1 fm2_fixture+/="', "'Bearer opaque-token'"]:
            with self.subTest(value=value):
                token = CLI.token_from_agents(('FLY_API_TOKEN='+value+'\nCOMPLETE=fixture\n').encode())
                self.assertEqual(token, value.strip('\"\''))
                expected = token if token.startswith(('FlyV1 ', 'Bearer ')) else 'Bearer '+token
                self.assertEqual(CLI.token_header(token), expected)
        for value in ['', 'FlyV1 ', 'Unknown abc', 'Bearer  abc', 'FlyV1 abc def',
                      'FlyV1 abc\tdef', 'FlyV1 abc\x00def', '"FlyV1 abc',
                      '"FlyV1 abc\ndef"', '$(command)', 'abc\nFLY_API_TOKEN=def']:
            with self.subTest(invalid=repr(value)):
                with self.assertRaises(ValueError):
                    CLI.token_from_agents(('FLY_API_TOKEN='+value+'\n').encode())

    def test_drip_response_is_bounded_without_orphan_reader(self):
        class Drip(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Length', '100000')
                self.end_headers()
                try:
                    for _ in range(30):
                        self.wfile.write(b' ')
                        self.wfile.flush()
                        time.sleep(.03)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            def log_message(self, *unused):
                pass

        with tempfile.TemporaryDirectory() as name:
            server = http.server.HTTPServer(('127.0.0.1', 0), Drip)
            thread = threading.Thread(target=server.handle_request)
            thread.start()
            url = 'http://127.0.0.1:' + str(server.server_port)
            real_open = CLI.urllib.request.urlopen

            class API:
                def __init__(self, *unused):
                    pass
                def api(self, *unused, **kwargs):
                    with real_open(url, timeout=20) as response:
                        return json.load(response)

            settings = {'data': {'organization': {'slug': 'personal', 'settings': {'machines_per_org_limit': 1000}, 'billingStatus': 'fixture'}}}
            apps = subprocess.CompletedProcess([], 0, json.dumps([{'Name': 'navi-whisper-lux-bench', 'Organization': {'Slug': 'personal'}}]), '')
            start = time.monotonic()
            try:
                with patch.object(CLI.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(settings).encode())), \
                     patch.object(CLI.subprocess, 'run', return_value=apps):
                    with self.assertRaises(RUNNER['Deadline']):
                        with RUNNER['bounded'](.15):
                            CLI.capacity(API, 'fixture', 'personal', Path(name), 1)
                self.assertLess(time.monotonic()-start, .6)
                self.assertFalse((Path(name)/'capacity-proof.private.json').exists())
            finally:
                thread.join(timeout=2)
                server.server_close()
            self.assertFalse(thread.is_alive())

    def test_public_check_is_path_independent_and_no_provider_or_state_creation(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)/'checkout'
            (root/'scripts').mkdir(parents=True)
            for member in CLI.PINS:
                selected=Path(SPEC.origin) if member=='run-original600-controller.py' else ROOT/'scripts'/member
                target=root/'scripts'/member
                target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(selected.read_bytes())
            (root/'scripts/lib').mkdir(exist_ok=True)
            (root/'scripts/lib/cloudbench-env.sh').write_bytes((ROOT/'scripts/lib/cloudbench-env.sh').read_bytes())
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            subprocess.run(['git', '-C', str(root), 'add', 'scripts'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test',
                            '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], check=True)
            ref = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
            inputs = Path(name)/'inputs'
            inputs.mkdir(mode=0o700)
            state = inputs/'state'
            state.mkdir(mode=0o700)
            fakebin = inputs/'bin'
            fakebin.mkdir()
            marker = inputs/'provider-called'
            fly = fakebin/'flyctl'
            fly.write_text('#!/bin/sh\nif [ "$1" = version ]; then echo "flyctl v0.4.115 linux/amd64"; exit 0; fi\n: > "$PROVIDER_MARKER"\nexit 99\n')
            fly.chmod(0o700)
            args = [sys.executable, str(root/'scripts/run-original600-controller.py'), '--source-ref', ref,
                    '--state-dir', str(state)]
            tasks = json.loads((ROOT/'scripts/tests/fixtures/original600-tasks.json').read_text())
            facts = dict(app='navi-whisper-lux-bench', image_ref='registry.fly.io/fixture@sha256:'+'a'*64,
                         protected_machines=['m1', 'm2', 'm3', 'm4'], protected_volumes=['v1'])
            for flag, data in [('facts', facts), ('agents-env', 'FLY_API_TOKEN=FlyV1 fixture\n'), ('backend-env', 'COMPLETE=fixture\nGITHUB_TOKEN=fixture_github\n'),
                               ('tasks', tasks), ('snapshot-inventory', {}), ('warm-deps', 'fixture')]:
                args += ['--'+flag, str(private(inputs/flag, data))]
            gh=fakebin/'gh';gh.write_text('#!/bin/sh\nexit 1\n');gh.chmod(0o700)
            env = dict(os.environ, PATH=str(fakebin)+':'+os.environ['PATH'], PROVIDER_MARKER=str(marker),
                       GIT_CONFIG_GLOBAL='/dev/null',GIT_CONFIG_NOSYSTEM='1')
            for key in ['GITHUB_TOKEN','GH_TOKEN','CLOUDBENCH_GITHUB_TOKEN_B64']:env.pop(key,None)
            result = subprocess.run(args, cwd='/', env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['status'], 'CHECKED_NOT_LAUNCHED')
            self.assertFalse(marker.exists())
            self.assertEqual(list(state.iterdir()), [])
            (inputs/'backend-env').write_text('COMPLETE=fixture\n')
            missing=subprocess.run(args,cwd='/',env=env,capture_output=True,text=True,timeout=10)
            self.assertNotEqual(missing.returncode,0,'missing explicit launcher credential must fail during CHECK')
            self.assertIn('GitHub credential unavailable',missing.stderr)
            self.assertFalse(marker.exists())
            self.assertEqual(list(state.iterdir()),[])
            (inputs/'backend-env').write_text('COMPLETE=fixture\nGITHUB_TOKEN=fixture_github\n')
            # Same public command must refuse changed committed source before a provider call.
            with (root/'scripts/cloudbench-shared-relay.py').open('a') as f:
                f.write('\n# altered fixture\n')
            refused = subprocess.run(args, cwd='/', env=env, capture_output=True, timeout=10)
            self.assertNotEqual(refused.returncode, 0)
            self.assertFalse(marker.exists())

    def test_prepared_source_members_include_canonical_shell_pins_only(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);(root/'scripts').mkdir()
            pins={}
            for member in CLI.PINS:
                path=root/'scripts'/member;path.parent.mkdir(parents=True,exist_ok=True)
                path.write_bytes((ROOT/'scripts'/member).read_bytes());pins[member]=CLI.digest(path.read_bytes())
            def committed(command, **unused):
                return (root/command[-1].split(':',1)[1]).read_bytes()
            with patch.object(RUNNER['subprocess'],'check_output',side_effect=committed):
                RUNNER['validate_source_members'](root,'a'*40,pins)
                for bad in ['../outside.py','/absolute.py','lib/../../outside.py','lib/unknown.sh','run-anything']:
                    with self.subTest(name=bad),self.assertRaises(ValueError):
                        RUNNER['validate_source_members'](root,'a'*40,dict(pins,**{bad:'f'*64}))

    def test_bound_launch_preserves_workload_clock_and_rejects_existing_output(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);directory=root/'admission';directory.mkdir(mode=0o700)
            launch=directory/'launch-1';launch.mkdir(mode=0o700)
            tasks=private(root/'tasks',json.loads((ROOT/'scripts/tests/fixtures/original600-tasks.json').read_text()))
            args=argparse.Namespace(source_ref='b'*40,state_dir=root,resume_bound_launch=directory,tasks=tasks,
                org='personal',extra_destroying_count=1,archive_run=[root/'archive'],reuse_exclude_machine=['1'*14])
            for key in ['facts','agents_env','backend_env','snapshot_inventory','warm_deps']:
                setattr(args,key,private(root/key,'fixture'))
            facts=dict(app='navi-whisper-lux-bench',image_ref='fixture@sha256:'+'1'*64,protected_machines=['p1','p2','p3','p4'],protected_volumes=['v1'])
            private(args.facts,facts)
            private(args.agents_env,'FLY_API_TOKEN=fixture\n')
            binding=CLI.admission_binding(args,RUNNER);binding['source_ref']='a'*40
            private(directory/'admission-intent.private.json',dict(binding=binding,started_at_epoch=100))
            reserved=private(launch/'reserved.json',dict(task_names=json.loads(tasks.read_bytes()),candidates=[dict(machine_id='candidate')]))
            authority=private(launch/'authority.json',dict(source_ref='a'*40,original=True))
            config=private(launch/'config.private.json',dict(source_ref='a'*40,started_at_epoch=100,
                source_root=str(root/'old-workload'),source_files={'old.py':'f'*64},authority_template=str(authority),
                remote_files=[dict(relative_path='.git/cloudbench-archived-reuse-fixture.json',source_path=str(reserved),sha256=CLI.digest(reserved.read_bytes()))]))
            private(directory/'controller-launch.intent.json',dict(config_path=str(config),config_sha256=CLI.digest(config.read_bytes()),run_directory=str(launch/'run')))
            helper={'validate_request':lambda value,ref:value}
            with patch.object(CLI.subprocess,'check_output',return_value='a'*40),patch.object(CLI,'reuse_module',return_value=helper),patch.dict(RUNNER,validate_source_members=lambda *unused:None):
                plan=CLI.bound_launch_plan(args,RUNNER)
                self.assertEqual(plan['config']['source_ref'],'a'*40)
                self.assertEqual(plan['config']['started_at_epoch'],100)
                before=config.read_bytes()
                authority_before=authority.read_bytes()
                def snapshot(api, token, org, output, extra):
                    private(output/'navi-whisper-lux-bench.private.json',[
                        dict(id='candidate',config=dict(image=facts['image_ref']))])
                    return dict(available_slots_conservative=700,machine_limit=1000,
                                total_active_inventory_objects=299,conservative_extra_destroying_bench_objects=1,ended_epoch=110)
                helper['capacity_demand']=lambda *unused,**kwargs:dict(new_machine_demand=600,qualified_reuse_count=1)
                captured=[]
                def run_corrected(path, sha, output, **kwargs):
                    value=json.loads(path.read_bytes());captured.append(value)
                    self.assertEqual(value['source_ref'],'a'*40)
                    self.assertEqual(value['started_at_epoch'],100)
                    self.assertEqual(value['host_operator_provenance']['host_operator_source_ref'],'b'*40)
                    self.assertEqual(output,launch/'run')
                    fresh=json.loads(Path(value['authority_template']).read_bytes())
                    self.assertEqual(fresh['verified_epoch'],110)
                    self.assertEqual(fresh['source_ref'],'a'*40)
                    return 0
                with patch.object(CLI,'capacity_snapshot',side_effect=snapshot),patch.object(CLI.time,'time',return_value=110),patch.dict(RUNNER,run=run_corrected):
                    self.assertEqual(CLI.resume_bound_launch(args,ROOT,RUNNER,plan,'fixture-github'),0)
                self.assertEqual(len(captured),1)
                self.assertEqual(authority.read_bytes(),authority_before)
                self.assertEqual(config.read_bytes(),before)
                (launch/'run').mkdir()
                with self.assertRaisesRegex(ValueError,'absent run directory'):
                    CLI.bound_launch_plan(args,RUNNER)
                self.assertEqual(config.read_bytes(),before)

    def test_fresh_all_app_capacity_and_original_binding(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            facts = dict(app='navi-whisper-lux-bench', image_ref='registry.fly.io/fixture@sha256:'+'a'*64,
                         protected_machines=['m1', 'm2', 'm3', 'm4'], protected_volumes=['v1'])
            args = argparse.Namespace(source_ref='a'*40, facts=private(directory/'facts', facts),
                  agents_env=private(directory/'agents.env', 'FLY_API_TOKEN=fixture\n'),
                  backend_env=private(directory/'backend.env', 'COMPLETE=fixture\n'),
                  tasks=private(directory/'tasks', json.loads((ROOT/'scripts/tests/fixtures/original600-tasks.json').read_text())),
                  snapshot_inventory=private(directory/'snapshot', {}), warm_deps=private(directory/'warm', 'fixture'))
            settings = {'data': {'organization': {'slug': 'personal', 'settings': {'machines_per_org_limit': 1000}, 'billingStatus': 'fixture'}}}
            calls = []

            class API:
                def __init__(self, app, token):
                    self.app = app
                def api(self, method, path, timeout):
                    calls.append((self.app, method, path))
                    return [{'id': self.app+'-machine'}]

            response = subprocess.CompletedProcess([], 0, json.dumps([{'Name': 'navi-whisper-lux-bench', 'Organization': {'Slug': 'personal'}}, {'Name': 'new-app', 'Organization': {'Slug': 'personal'}}]), '')
            with patch.object(CLI.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(settings).encode())) as request_open, \
                 patch.object(CLI.subprocess, 'run', return_value=response):
                cap = CLI.capacity(API, 'FlyV1 fixture', 'personal', directory, 1)
            self.assertEqual(request_open.call_args.args[0].get_header('Authorization'), 'FlyV1 fixture')
            self.assertCountEqual(calls, [('navi-whisper-lux-bench', 'GET', '/machines'), ('new-app', 'GET', '/machines')])
            foreign = subprocess.CompletedProcess([], 0, json.dumps([{'Name': 'unrelated', 'Organization': {'Slug': 'personal'}}]), '')
            with patch.object(CLI.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(settings).encode())), \
                 patch.object(CLI.subprocess, 'run', return_value=foreign):
                with self.assertRaisesRegex(ValueError, 'does not include'):
                    CLI.capacity(API, 'fixture', 'personal', directory, 1)
            self.assertEqual(cap['available_slots_conservative'], 997)
            config = CLI.prepare(args, ROOT, {n: 'b'*64 for n in CLI.PINS}, RUNNER, directory, cap)
            value = json.loads(config.read_text())
            argv = RUNNER['campaign_argv'](json.loads(args.tasks.read_text()), value['started_at_epoch'])
            self.assertEqual(argv[argv.index('--concurrency')+1], '600')
            self.assertEqual(argv[argv.index('--timeout')+1], '1200')
            self.assertEqual(argv[argv.index('--e2e-timeout')+1], '5400')
            self.assertEqual(argv[argv.index('--ref')+1], '570830dbf17635e13d16a6f03b4d705f6b6443b1')
            cap['ended_epoch'] = time.time()-271
            with self.assertRaisesRegex(ValueError, 'expired'):
                CLI.prepare(args, ROOT, {}, RUNNER, directory, cap)


if __name__ == '__main__':
    unittest.main()
