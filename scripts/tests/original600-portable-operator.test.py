#!/usr/bin/env python3
"""Offline public CLI, original argv and fresh capacity/binding contracts."""
import argparse
import ast
import base64
from contextlib import contextmanager
import errno
import gzip
import hashlib
import importlib.util
import io
import http.server
import json
import os
import random
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

    def test_fragment_request_retains_transport_margin(self):
        # The old receiver's unused CLI trailer made this request 6,202 bytes.
        payload={"machine": "1234567890abcd", "source_ref": "f0967aaa680b9917f62c4dc8063966e588d0aa5d",
                 "envelope_sha256": hashlib.sha256(b'envelope').hexdigest(), "sha256": hashlib.sha256(b'file').hexdigest(),
                 "action": "fragment", "index": 20, "offset": 30720, "data": base64.b64encode(random.Random(1).randbytes(2048)).decode()}
        command=RUNNER['sidecar_command'](payload)
        self.assertLessEqual(len(json.dumps({"cmd": command, "timeout": 20, "machine": True}).encode()),6144)
        argv=shlex.split(command)
        script,decoded=json.loads(gzip.decompress(base64.b64decode(argv[-1])))
        self.assertEqual(decoded,payload)
        self.assertEqual(script,RUNNER['REMOTE_SIDECAR'])

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

    def test_sidecar_identity_deadline_reobserves_without_replaying_exec(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);host=root/'host';guest=root/'guest';host.mkdir();guest.mkdir()
            _,envelope,digest,_=self.large_sidecar(host)
            api,record=self.sidecar_api(guest,envelope)
            original=api.api;attempts=[]
            def interrupted(method,*args,**kwargs):
                if method=='GET':
                    attempts.append(method)
                    if len(attempts)==1:raise RUNNER['Deadline']('external controller I/O deadline')
                return original(method,*args,**kwargs)
            api.api=interrupted
            RUNNER['transfer_sidecars'](api,record['id'],record,host,digest,time.time()+60)
            pending=list((host/'payload-transfer').glob('*-read-pending.json'))
            self.assertEqual(len(pending),1)
            self.assertTrue(json.loads(pending[0].read_bytes())['read_only'])
            self.assertTrue((host/'payload-transfer/complete.json').is_file())
            self.assertGreater(api.posts,0)
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);host=root/'host';guest=root/'guest';host.mkdir();guest.mkdir()
            _,envelope,digest,_=self.large_sidecar(host)
            api,record=self.sidecar_api(guest,envelope);stopped=[]
            def cancelled(method,*args,**kwargs):
                self.assertEqual(method,'GET');stopped.append(True)
                raise RUNNER['Deadline']('external controller I/O deadline')
            api.api=cancelled
            with self.assertRaises(RUNNER['Deadline']):
                RUNNER['transfer_sidecars'](api,record['id'],record,host,digest,time.time()+60,lambda:bool(stopped))
            self.assertEqual(len(stopped),1)
            self.assertEqual(api.posts,0)
            self.assertFalse((host/'payload-transfer/complete.json').exists())

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

    def workspace_release_fixture(self, root):
        out = root / "run"
        out.mkdir(mode=0o700)
        export = out / "export"
        export.mkdir(mode=0o700)
        workload = "49b792dcc2ea983325c6a25801da6c982f29c206"
        host = "69aa6ff584588cfaa07d0a875fb9bdf308267c5c"

        def source(ref, name):
            return CLI.digest(
                subprocess.check_output(
                    [
                        "git",
                        "--no-replace-objects",
                        "-C",
                        str(ROOT),
                        "show",
                        ref + ":scripts/" + name,
                    ]
                )
            )

        epoch = time.time() - 60
        provenance = dict(
            host_operator_source_ref=host,
            workload_source_ref=workload,
            original_started_at_epoch=epoch,
            host_runner_sha256=source(host, "cloudbench-original600-runner.py"),
            host_gate_sha256=source(host, "run-cloudbench-controller-gate"),
            incomplete_admission={"original_plan_sha256": "a" * 64},
        )
        config = private(
            root / "config.private.json",
            dict(
                source_ref=workload,
                started_at_epoch=epoch,
                host_operator_provenance=provenance,
                gate_env={"WARM_IMAGE_REF": "image@sha256:" + "1" * 64},
                source_files={
                    name: source(workload, name)
                    for name in (
                        "cloudbench-disposable-controller.py",
                        "run-cloudbench-controller-gate",
                    )
                },
            ),
        )
        private(out / "host-operator-provenance.json", provenance)
        gate_caller = dict(pid=99999998, birth="gone-gate", host="fixture")
        caller_file = private(export / "caller.json", gate_caller)
        authority = dict(
            source_ref=workload,
            app="navi-whisper-lux-bench",
            output_directory=str(export),
            cleanup_owner_pid=99999999,
            cleanup_owner_birth="gone-owner",
            protected_volumes=[],
            env_files={},
        )
        for key in ("agents", "backend"):
            path = private(
                export / ("current-" + key + ".private.env"), "FIXTURE=not-a-token\n"
            )
            authority["env_files"][key] = {"sha256": CLI.digest(path.read_bytes())}
        auth_path = private(out / "authority.private.json", authority)
        auth_sha = CLI.digest(auth_path.read_bytes())
        caller = dict(
            pid=99999999,
            birth="gone-owner",
            gate_pid=99999998,
            gate_birth="gone-gate",
            authority_sha256=auth_sha,
            source_ref=workload,
            epoch=epoch,
            deadline=epoch + 5400,
        )
        private(out / "caller.json", caller)
        private(
            out / ("authority.private.json." + auth_sha + ".once"),
            dict(
                authority_sha256=auth_sha,
                driver_pid=caller["gate_pid"],
                driver_birth=caller["gate_birth"],
            ),
        )
        intent = dict(
            caller=gate_caller, caller_sha256=CLI.digest(caller_file.read_bytes())
        )
        intent_path = private(export / "workspace-volume.intent.json", intent)
        native = dict(id="vol_fixture", attached_machine_id=None, state="created")
        native_path = private(export / "workspace-volume-create.private.json", native)
        workspace = dict(
            schema="cloudbench-controller-workspace-ownership-v1",
            source_ref=workload,
            app=authority["app"],
            size_gb=256,
            mount_path="/tmp/gate",
            volume_id=native["id"],
            native_create=native,
            native_create_sha256=CLI.digest(native_path.read_bytes()),
            intent_sha256=CLI.digest(intent_path.read_bytes()),
            **intent,
        )
        workspace_path = private(export / "workspace-volume.ownership.json", workspace)
        create = dict(
            authority_sha256=auth_sha,
            workspace_sha256=CLI.digest(workspace_path.read_bytes()),
            image="image@sha256:" + "1" * 64,
            name="cloudbench-gate-" + workload[:8] + "-fixture",
        )
        private(export / "machine-create.intent.json", create)
        private(
            export / "disposable-delete-volume.intent.json",
            dict(authority_sha256=auth_sha, identifier=native["id"], kind="volume"),
        )
        release = dict(
            machine_id=None,
            volume_id=native["id"],
            volume_disposition="pending_destroy",
            no_live_machine_observed=True,
            command_history_verified=False,
        )
        private(export / "disposable-controller.release.json", release)
        private(
            export / "workspace-backup.verified.json",
            dict(native, auto_backup_enabled=False),
        )
        private(export / "workspace-volume-create.stderr.private.log", "")
        private(
            out / "cleanup-call.intent.json",
            dict(
                action="cleanup-workspace",
                machine=None,
                gate_joined=True,
                supervisor_joined=False,
                export_verified_file=None,
            ),
        )
        private(
            out / "terminal.json",
            dict(
                status="FAILED_STARTUP_WORKSPACE_RELEASED",
                machine=None,
                release=release,
                source_ref=workload,
                started_at_epoch=epoch,
                original_deadline=epoch + 5400,
                gate_exit_code=1,
                controller_cleanup_exit_code=1,
                externally_reconciled_after_helper_failure=True,
                benchmark_success_inferred=False,
            ),
        )
        private(
            out / "gate.private.log",
            create["name"]
            + "\nfailed to forward request\nGATE_WORKSPACE_VOLUME_RETAINED id="
            + native["id"]
            + "\n",
        )
        private(out / "controller-sidecars.private.json", [])
        payload = out / "controller-launch-payload.private.json.gz"
        payload.write_bytes(gzip.compress(b"fixture", mtime=0))
        payload.chmod(0o600)
        receipt = dict(
            schema="original600-observed-closed-v1",
            run_directory=str(out),
            original_tool_exit_code=1,
            release_observer_exit_code=0,
            caller_live=False,
            supervisor_published=False,
            task_attempts=0,
            original_session=123,
            release_observer_session=124,
            observed_epoch=time.time(),
            caller_pid=caller["pid"],
        )
        evidence = private(out / "observed-closure.safe.json", receipt)
        return out, config, evidence

    def test_selected_null_config_requires_one_full_current_get_and_preserves_raw_list(
        self,
    ):
        old = runpy.run_path(
            str(ROOT / "scripts/tests/cloudbench-reconcile-reservations.test.py")
        )
        fixture = old["Reconcile"]()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        request = fixture.f.request
        expected = fixture.f.current
        incomplete = dict(
            expected, config=None, incomplete_config={"image": "not-authoritative"}
        )
        inventory = [incomplete, {"id": "unselected", "config": None}]
        original = json.dumps(inventory, sort_keys=True).encode()
        helper = CLI.reuse_module()
        calls = []
        current = json.loads(json.dumps(expected))
        clock = [None]

        class Client:
            app = "navi-whisper-lux-bench"

            def api(self, method, url, body, *, timeout, headers, observer):
                calls.append((method, url, body, timeout))
                self_test.assertEqual(method, "GET")
                self_test.assertEqual(timeout, 20)
                outcome = current.pop(0) if isinstance(current, list) else current
                if isinstance(outcome, BaseException):
                    if clock[0] is not None:
                        clock[0] += 20
                    raise outcome
                raw = json.dumps(outcome, sort_keys=True).encode()
                observer(method, url, 200, raw)
                return json.loads(raw)

        self_test = self
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            raw_path = private(root / "native.private.json", inventory)
            raw_before = raw_path.read_bytes()
            proof = {}
            bounds = []

            @contextmanager
            def bounded(seconds):
                bounds.append(seconds)
                with RUNNER["bounded"](seconds):
                    yield

            runner = dict(RUNNER, bounded=bounded)
            observed = CLI.observe_reuse_configs(
                lambda out: helper["NativeAdapter"](Client(), out / "wire"),
                request,
                inventory,
                root / "observation",
                runner,
                time.time() + 500,
                proof=proof,
            )
            self.assertEqual(observed[0], expected)
            self.assertIsNone(observed[1]["config"])
            self.assertEqual(json.dumps(inventory, sort_keys=True).encode(), original)
            self.assertEqual(raw_path.read_bytes(), raw_before)
            self.assertEqual(len(calls), 1)
            self.assertEqual(bounds, [110, 20])
            binding = proof["selected_full_config_observation"]
            self.assertEqual(
                binding["intent_sha256"],
                CLI.digest((root / "observation/intent.json").read_bytes()),
            )
            self.assertEqual(
                binding["complete_sha256"],
                CLI.digest((root / "observation/complete.json").read_bytes()),
            )
            self.assertEqual(
                binding["observed"][expected["id"]],
                CLI.digest(
                    (
                        root / "observation" / expected["id"] / "observed.json"
                    ).read_bytes()
                ),
            )
            wire = list((root / "observation" / expected["id"]).rglob("*-wire.json"))
            self.assertEqual(len(wire), 1)
            old_path = root / "old-operator.py"
            old_path.write_bytes(
                subprocess.check_output(
                    [
                        "git",
                        "--no-replace-objects",
                        "-C",
                        str(ROOT),
                        "show",
                        "1cec8c1cb20c85e66e10cd49446b44c5e85101f1:scripts/run-original600-controller.py",
                    ]
                )
            )
            old = runpy.run_path(str(old_path))
            with self.assertRaises(AttributeError):
                old["verify_reuse_images"](request, inventory, request["image_ref"])
            with self.assertRaisesRegex(ValueError, "image differs"):
                CLI.verify_reuse_images(request, inventory, request["image_ref"])
            for label, mutation in [
                ("missing-config", {"config": None}),
                ("wrong-id", {"id": "foreign"}),
                ("new-version", {"instance_id": "foreign"}),
                ("running", {"state": "started"}),
                ("wrong-config", {"config": {}}),
            ]:
                current = dict(expected, **mutation)
                before = len(calls)
                with self.assertRaises(ValueError):
                    CLI.observe_reuse_configs(
                        lambda out: helper["NativeAdapter"](Client(), out / "wire"),
                        request,
                        inventory,
                        root / label,
                        runner,
                        time.time() + 500,
                    )
                self.assertEqual(len(calls), before + 1)
                self.assertFalse((root / label / "complete.json").exists())
                self.assertTrue((root / label / "failure.json").exists())
            # A transient read gets another read under the SAME phase clock,
            # with distinct raw custody; no config/lease operation is possible.
            clock[0] = time.time()
            current = [RUNNER["Deadline"]("first20s unknown"), expected]
            before = len(calls)
            with (
                patch.object(CLI.time, "time", side_effect=lambda: clock[0]),
                patch.object(CLI.time, "monotonic", side_effect=lambda: clock[0]),
            ):
                retried = CLI.observe_reuse_configs(
                    lambda out: helper["NativeAdapter"](Client(), out / "wire"),
                    request,
                    inventory,
                    root / "transient",
                    runner,
                    clock[0] + 500,
                )
            self.assertEqual(retried[0], expected)
            self.assertEqual(len(calls), before + 2)
            self.assertEqual(
                len(list((root / "transient").rglob("read-pending.json"))), 1
            )
            current = RUNNER["Deadline"]("exact20s observation timed out")
            clock[0] = time.time()
            before = len(calls)
            backward_start = clock[0]
            with (
                patch.object(
                    CLI.time,
                    "time",
                    side_effect=lambda: backward_start - (clock[0] - backward_start),
                ),
                patch.object(CLI.time, "monotonic", side_effect=lambda: clock[0]),
                self.assertRaisesRegex(ValueError, "original phase deadline"),
            ):
                CLI.observe_reuse_configs(
                    lambda out: helper["NativeAdapter"](Client(), out / "wire"),
                    request,
                    inventory,
                    root / "timeout",
                    runner,
                    clock[0] + 500,
                )
            self.assertEqual(len(calls), before + 6)
            self.assertFalse(list((root / "timeout").rglob("*-wire.json")))
            self.assertFalse((root / "timeout/complete.json").exists())
            self.assertTrue(
                json.loads((root / "timeout/failure.json").read_bytes())[
                    "unknown_rows_not_credited"
                ]
            )
            after = len(calls)
            with self.assertRaises(FileExistsError):
                CLI.observe_reuse_configs(
                    lambda out: helper["NativeAdapter"](Client(), out / "wire"),
                    request,
                    inventory,
                    root / "timeout",
                    runner,
                    time.time() + 500,
                )
            self.assertEqual(len(calls), after)
            current = CLI.AdmissionInterrupted(signal.SIGTERM)
            clock[0] = None
            before = len(calls)
            with self.assertRaises(CLI.AdmissionInterrupted):
                CLI.observe_reuse_configs(
                    lambda out: helper["NativeAdapter"](Client(), out / "wire"),
                    request,
                    inventory,
                    root / "cancelled",
                    runner,
                    time.time() + 500,
                )
            self.assertEqual(len(calls), before + 1)
            self.assertFalse((root / "cancelled/complete.json").exists())
            before = len(calls)
            self.assertEqual(
                CLI.observe_reuse_configs(
                    None,
                    request,
                    [expected],
                    root / "unneeded",
                    runner,
                    time.time() + 500,
                ),
                [expected],
            )
            self.assertEqual(len(calls), before)
            self.assertFalse((root / "unneeded").exists())

    def test_canonical_released_workspace_continues_once_without_regrading_unknown_create(
        self,
    ):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            out, config, evidence = self.workspace_release_fixture(root)
            before = {
                str(p.relative_to(out)): p.read_bytes()
                for p in out.rglob("*")
                if p.is_file()
            }
            old_path = root / "old-operator.py"
            old_path.write_bytes(
                subprocess.check_output(
                    [
                        "git",
                        "--no-replace-objects",
                        "-C",
                        str(ROOT),
                        "show",
                        "69aa6ff584588cfaa07d0a875fb9bdf308267c5c:scripts/run-original600-controller.py",
                    ]
                )
            )
            old = runpy.run_path(str(old_path))
            with self.assertRaisesRegex(
                ValueError, "positive joined Popen failure evidence required"
            ):
                old["prelaunch_failure"](
                    RUNNER, out, evidence, config, CLI.digest(config.read_bytes())
                )
            accepted = CLI.prelaunch_failure(
                RUNNER, out, evidence, config, CLI.digest(config.read_bytes())
            )
            self.assertFalse(accepted["creation_history_verified"])
            self.assertEqual(
                accepted["stage"], "CANONICAL_WORKSPACE_RELEASED_AFTER_UNKNOWN_CREATE"
            )
            self.assertEqual(
                {
                    str(p.relative_to(out)): p.read_bytes()
                    for p in out.rglob("*")
                    if p.is_file()
                },
                before,
            )
            self.assertFalse(Path(accepted["successor_output"]).exists())

            def deny_mutation(path, mutate):
                saved = path.read_bytes()
                value = json.loads(saved)
                mutate(value)
                private(path, value)
                try:
                    with self.assertRaises(ValueError):
                        CLI.prelaunch_failure(
                            RUNNER,
                            out,
                            evidence,
                            config,
                            CLI.digest(config.read_bytes()),
                        )
                finally:
                    path.write_bytes(saved)

            deny_mutation(
                out / "export/disposable-controller.release.json",
                lambda v: v.update(volume_id="vol_foreign"),
            )
            deny_mutation(
                out / "export/machine-create.intent.json",
                lambda v: v.update(image="foreign@sha256:" + "2" * 64),
            )
            deny_mutation(
                out / "cleanup-call.intent.json", lambda v: v.update(gate_joined=False)
            )
            deny_mutation(evidence, lambda v: v.update(caller_live=True))
            deny_mutation(
                out / "host-operator-provenance.json",
                lambda v: v.update(host_runner_sha256="0" * 64),
            )
            terminal = (out / "terminal.json").read_bytes()
            (out / "terminal.json").unlink()
            with self.assertRaises(FileNotFoundError):
                CLI.prelaunch_failure(
                    RUNNER, out, evidence, config, CLI.digest(config.read_bytes())
                )
            (out / "terminal.json").write_bytes(terminal)
            (out / "terminal.json").chmod(0o600)
            for relative in (
                "export/disposable-controller.ownership.json",
                "supervisor-probe-000001.json",
                "unknown-effect.json",
                "host-launch-successor.json",
            ):
                path = private(out / relative, {})
                with self.assertRaises(ValueError):
                    CLI.prelaunch_failure(
                        RUNNER, out, evidence, config, CLI.digest(config.read_bytes())
                    )
                path.unlink()
            real_exists = Path.exists

            def live(path):
                return True if str(path) == "/proc/99999999" else real_exists(path)

            with (
                patch.object(Path, "exists", live),
                self.assertRaisesRegex(ValueError, "PID still present"),
            ):
                CLI.prelaunch_failure(
                    RUNNER, out, evidence, config, CLI.digest(config.read_bytes())
                )
            epoch = json.loads(config.read_bytes())["started_at_epoch"]
            with (
                patch.object(CLI.time, "time", return_value=epoch + 5401),
                self.assertRaisesRegex(ValueError, "clock expired"),
            ):
                CLI.prelaunch_failure(
                    RUNNER, out, evidence, config, CLI.digest(config.read_bytes())
                )
            Path(accepted["successor_output"]).mkdir()
            with self.assertRaisesRegex(ValueError, "already claimed"):
                CLI.prelaunch_failure(
                    RUNNER, out, evidence, config, CLI.digest(config.read_bytes())
                )

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
            args.unused_reservation_run = []
            args.parked_reservation_run = [root/'parked-admission']
            parked = CLI.admission_binding(args, RUNNER)
            self.assertEqual(parked['parked_reservation_runs'], [str(root/'parked-admission')])
            self.assertEqual({k:v for k,v in parked.items() if k!='parked_reservation_runs'}, legacy)
            parked_directory,_ = CLI.open_admission(root,None,parked,RUNNER,True)
            args.parked_reservation_run = [root/'foreign-parked-admission']
            with self.assertRaisesRegex(ValueError, 'source/inputs/archives'):
                CLI.open_admission(root,parked_directory,CLI.admission_binding(args,RUNNER),RUNNER,True)
            args.parked_reservation_run=[]
            args.expired_reservation_run=[root/'expired-admission']
            expired=CLI.admission_binding(args,RUNNER)
            self.assertEqual(expired['expired_reservation_runs'],[str(root/'expired-admission')])
            self.assertEqual({k:v for k,v in expired.items() if k!='expired_reservation_runs'},legacy)

    def test_sealed_disabled_policy_reaches_actual_guest_supervisor_handoff(self):
        tasks = json.loads((ROOT / 'scripts/tests/fixtures/original600-tasks.json').read_bytes())
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'scripts').mkdir()
            script = root / 'scripts/cloudbench-original600-supervisor.py'
            script.write_text("import json,os,sys\nfrom pathlib import Path\np=Path(os.environ['REVIEWED_OPERATOR_IDENTITY_PATH'])\n(p.parent/'handoff.json').write_text(json.dumps(dict(policy=os.environ['CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP'],identity=json.loads(p.read_bytes()),argv=sys.argv[1:])))\n")
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'supervisor handoff fixture'], check=True)
            ref = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
            epoch = time.time()
            argv = RUNNER['campaign_argv'](tasks, epoch)
            remote = dict(source_ref=ref, supervisor_sha256=CLI.digest(script.read_bytes()), epoch=epoch, identity_name='original600-supervisor.fixture.json', tasks=tasks, campaign_argv=argv, remote_files=[], remote_env={'CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP': 'disabled'}, infra_early_stop='disabled')
            path, digest, command = RUNNER['launch_handoff'](root, remote)
            command[2] = command[2].replace("Path('/tmp/controller-launch-payload.json.gz')", 'Path(' + repr(str(path)) + ')').replace("root=Path('/tmp/gate/repo')", 'root=Path(' + repr(str(root)) + ')')
            command[3] = str(path)
            result = subprocess.run(command, capture_output=True, text=True, timeout=10, env=dict(os.environ, FLY_MACHINE_ID='1'*14, CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP='enabled'))
            self.assertEqual(result.returncode, 0, result.stderr)
            receipt = json.loads((root / '.context/handoff.json').read_bytes())
            self.assertEqual(receipt['policy'], 'disabled')
            self.assertEqual(receipt['identity']['infra_early_stop'], 'disabled')
            self.assertEqual(receipt['argv'], [str(epoch), *argv])
            for flag, expected in (('--timeout', '1200'), ('--e2e-timeout', '5400'), ('--concurrency', '600'), ('-k', '3')):
                self.assertEqual(argv[argv.index(flag)+1], expected)
            self.assertEqual(json.loads(gzip.decompress(path.read_bytes()))['infra_early_stop'], 'disabled')

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

    def test_launch_payload_verification_allows_read_access_time_update(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            path, digest, _ = RUNNER['launch_handoff'](
                root, {'remote_files': [], 'tasks': ['unchanged']}
            )
            # A legitimate read updates an old atime without changing content.
            os.utime(path, ns=(1, path.stat().st_mtime_ns))
            gate = (ROOT/'scripts/run-cloudbench-controller-gate').read_text()
            verifier = gate.split("<<'PY_LAUNCH_PAYLOAD'", 1)[1].split('\nPY_LAUNCH_PAYLOAD', 1)[0]
            result = subprocess.run(
                [sys.executable, '-c', verifier, str(path), digest],
                capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertGreater(path.stat().st_atime_ns, 1)

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
            with self.assertRaisesRegex(ValueError, 'source/inputs/archives'):
                CLI.open_admission(parent, directory, dict(binding, infra_early_stop='disabled'), RUNNER, True)
            private(directory/'controller-launch.intent.json',{'existing_owner':True})
            with self.assertRaisesRegex(ValueError,'already bound'):
                CLI.open_admission(parent,directory,binding,RUNNER,True)
            self.assertEqual(json.loads((directory/'admission-intent.private.json').read_text())['started_at_epoch'],epoch)

    def test_expired_admission_is_sealed_to_one_new_cohort(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);root.chmod(0o700)
            old=root/'expired';old.mkdir(mode=0o700)
            proof=private(old/'closure',{'expired':True})
            request={'cohort':'a'*32,'archives':[{'archive_sha256':'b'*64,
                'inputs':{str(proof):CLI.digest(proof.read_bytes())},'expired_admission':{'directory':str(old)}}]}
            def validate(archive):
                if CLI.digest(proof.read_bytes())!=archive['inputs'][str(proof)]:
                    raise ValueError('input changed')
            with patch.object(CLI.runpy,'run_path',return_value={'validate_handoff':validate}) as load:
                CLI.seal_expired_handoffs(request,root/'new-admission',RUNNER)
                self.assertTrue(str(load.call_args.args[0]).endswith('/cloudbench-reconcile-reservations.py'))
                original=(old/'expired-reservation-handoff.json').read_bytes()
                CLI.seal_expired_handoffs(request,root/'new-admission',RUNNER)
                self.assertEqual((old/'expired-reservation-handoff.json').read_bytes(),original)
                with self.assertRaisesRegex(ValueError,'another successor'):
                    CLI.seal_expired_handoffs(dict(request,cohort='c'*32),root/'other',RUNNER)
                proof.write_text('changed')
                with self.assertRaisesRegex(ValueError,'input changed'):
                    CLI.seal_expired_handoffs(request,root/'new-admission',RUNNER)

    def test_native_capacity_window_excludes_local_proof_but_keeps_original_deadline(self):
        for phase in ("local", "native-timeout", "original-expiry"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as name:
                now = [1000.0]
                windows, saved, calls = [], [], []

                @contextmanager
                def bounded(seconds):
                    windows.append((now[0], seconds))
                    try:
                        yield
                    finally:
                        windows.pop()

                def advance(seconds):
                    now[0] += seconds
                    if any(now[0] - start >= limit for start, limit in windows):
                        raise RUNNER["Deadline"]("fixture deadline")

                def native(*unused):
                    self.assertEqual(
                        windows[-1][1], 110 if phase != "original-expiry" else 100
                    )
                    calls.append("native")
                    advance(111 if phase == "native-timeout" else 1)
                    return dict(available_slots_conservative=51)

                def local(*unused):
                    self.assertGreater(
                        windows[-1][1], 110 if phase != "original-expiry" else 0
                    )
                    calls.append("local")
                    advance(111)
                    return dict(candidates=[])

                helper = dict(
                    prepare_request=local,
                    validate_request=lambda *args: None,
                    capacity_demand=lambda *args: dict(qualified_reuse_count=553),
                )
                runner = dict(bounded=bounded, save=lambda *args: saved.append(args))
                with (
                    patch.object(CLI.time, "time", side_effect=lambda: now[0]),
                    patch.object(CLI, "capacity_snapshot", side_effect=native),
                    patch.object(CLI, "reuse_module", return_value=helper),
                    patch.object(CLI, "read_inventory", return_value=b"[]"),
                    patch.object(CLI.runpy, "run_path", return_value=runner),
                ):
                    if phase == "local":
                        result = CLI.capacity(
                            None,
                            "fixture",
                            "personal",
                            Path(name),
                            1,
                            [Path(name)],
                            "a" * 40,
                            deadline=6400,
                        )
                        self.assertEqual(result["qualified_reuse_count"], 0)
                        self.assertEqual(calls, ["native", "local"])
                        self.assertEqual(len(saved), 2)
                    else:
                        with self.assertRaises(RUNNER["Deadline"]):
                            CLI.capacity(
                                None,
                                "fixture",
                                "personal",
                                Path(name),
                                1,
                                [Path(name)],
                                "a" * 40,
                                deadline=1100 if phase == "original-expiry" else 6400,
                            )
                        self.assertEqual(saved, [])

    def test_prepare_only_publishes_original_request_after_bounded_old_proof(self):
        for expired in (False, True):
            with self.subTest(expired=expired), tempfile.TemporaryDirectory() as name:
                root = Path(name)
                oldroot = root / "old"
                directory = root / "admission"
                directory.mkdir(mode=0o700)
                original = private(
                    directory / "admission-intent.private.json", {"retained": True}
                )
                original_bytes = original.read_bytes()
                tasks = private(root / "tasks", ["unchanged-task"])
                env = private(root / "env", "FLY_API_TOKEN=fixture-token\n")
                args = argparse.Namespace(
                    source_ref="b" * 40,
                    agents_env=env,
                    facts=env,
                    tasks=tasks,
                    org="personal",
                    extra_destroying_count=1,
                    archive_run=[root / "archive"],
                    reuse_exclude_machine=[],
                    unused_reservation_run=[],
                    parked_reservation_run=[],
                    expired_reservation_run=[],
                )
                now, windows, calls = [1000.0], [], []
                plan = dict(
                    directory=str(directory),
                    source_root=str(oldroot),
                    source_ref="a" * 40,
                    started_at=900,
                    deadline=1800,
                )
                module = {"plan": lambda *unused: plan}

                @contextmanager
                def bounded(seconds):
                    windows.append(seconds)
                    try:
                        yield
                    finally:
                        windows.pop()

                def snapshot(*values):
                    self.assertEqual(windows[-1], 110)
                    calls.append("native-read")
                    return dict(available_slots_conservative=51)

                def proof(*values):
                    self.assertGreater(windows[-1], 110)
                    namespace["capacity_snapshot"](*values)
                    self.assertGreater(windows[-1], 110)
                    calls.append("old-local-proof")
                    now[0] = 1801 if expired else 1111
                    RUNNER["save"](
                        values[3] / "archived-reuse-request.private.json",
                        dict(harness_ref="a" * 40, candidates=[]),
                    )
                    return {}

                namespace = proof.__globals__
                prior = namespace.get("capacity_snapshot")
                namespace["capacity_snapshot"] = snapshot
                oldrunner = dict(RUNNER, campaign_argv=lambda *unused: [])
                old = dict(
                    capacity=proof,
                    facts_from=lambda *unused: {"image_ref": "image@sha256:fixture"},
                    reuse_module=lambda: {
                        "validate_request": lambda request, ref: self.assertEqual(
                            request["harness_ref"], ref
                        )
                    },
                )
                runner = dict(RUNNER, bounded=bounded)

                def load(path):
                    if str(path).endswith("run-original600-controller.py"):
                        return old
                    if str(path).endswith("cloudbench-original600-runner.py"):
                        return oldrunner
                    if str(path).endswith("cloudbench-original-volume-capture.py"):
                        return {"Fly": object()}
                    raise AssertionError(path)

                try:
                    with (
                        patch.object(CLI, "preparation_plan", return_value=(module, plan)),
                        patch.object(CLI.time, "time", side_effect=lambda: now[0]),
                        patch.object(CLI.runpy, "run_path", side_effect=load),
                        patch.object(CLI, "facts_from", side_effect=old["facts_from"]),
                        patch("sys.stdout", new_callable=io.StringIO),
                    ):
                        if expired:
                            with self.assertRaisesRegex(ValueError, "clock expired"):
                                CLI.prepare_admission_request(args, root, runner)
                        else:
                            self.assertEqual(
                                CLI.prepare_admission_request(args, root, runner), 0
                            )
                    published = directory / "archived-reuse-original.private.json"
                    self.assertEqual(published.exists(), not expired)
                    self.assertEqual(original.read_bytes(), original_bytes)
                    self.assertEqual(calls, ["native-read", "old-local-proof"])
                    self.assertIs(namespace["capacity_snapshot"], snapshot)
                    self.assertFalse((directory / "controller-launch.intent.json").exists())
                    self.assertFalse((directory / "archived-reuse-reservations").exists())
                    if not expired:
                        value = json.loads(published.read_bytes())
                        self.assertEqual(value["request"]["harness_ref"], "a" * 40)
                        self.assertEqual(value["request"]["task_names"], ["unchanged-task"])
                        self.assertEqual(
                            value["sha256"],
                            CLI.digest(
                                json.dumps(
                                    value["request"], sort_keys=True, allow_nan=False
                                ).encode()
                            ),
                        )
                finally:
                    if prior is None:
                        namespace.pop("capacity_snapshot", None)
                    else:
                        namespace["capacity_snapshot"] = prior

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
            prepared=[]
            helper={'prepare_request':lambda *args:prepared.append(args) or request,'validate_request':lambda *unused:None,
                    'capacity_demand':lambda *unused:{'qualified_reuse_count':375}}
            with patch.object(CLI.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps(settings).encode())), \
                 patch.object(CLI.subprocess,'run',return_value=apps),patch.object(CLI,'reuse_module',return_value=helper):
                result=CLI.capacity(API,'fixture','personal',directory,1,[directory/'old-run'],'a'*40,
                                    parked_runs=[directory/'parked-run'])
            baseline=directory/'without-reuse';baseline.mkdir()
            with patch.object(CLI.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps(settings).encode())), \
                 patch.object(CLI.subprocess,'run',return_value=apps),self.assertRaisesRegex(ValueError,'insufficient measured capacity'):
                CLI.capacity(API,'fixture','personal',baseline,1)
            self.assertEqual(result['available_slots_conservative'],582)
            self.assertEqual(prepared[0][-2],[directory/'parked-run'])
            self.assertEqual(prepared[0][-1],())
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
            private(before/'archived-reuse-request.private.json',{'candidates':candidates,'archives':[]})
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
            space=types.SimpleNamespace(f_frsize=4096,f_bsize=4096,f_bavail=10**9,f_files=10**9,f_favail=10**9)
            with patch.object(CLI,'reuse_module',return_value=helper),patch.object(CLI,'capacity_snapshot',side_effect=snapshot), \
                 patch.object(CLI.os,'statvfs',return_value=space):
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

    def test_acknowledged_hold_readback_precedes_final_capacity_without_rewriting_closed_request(self):
        with tempfile.TemporaryDirectory() as name:
            directory=Path(name);before=directory/'before';before.mkdir()
            tasks=json.loads((ROOT/'scripts/tests/fixtures/original600-tasks.json').read_text())
            image='fixture@sha256:'+'b'*64
            args=argparse.Namespace(source_ref='a'*40,org='personal',extra_destroying_count=1,
                tasks=private(directory/'tasks',tasks),facts=private(directory/'facts',{
                    'app':'navi-whisper-lux-bench','image_ref':image,
                    'protected_machines':['p1','p2','p3','p4'],'protected_volumes':['v1']}))
            candidates=[{'machine_id':'candidate-'+str(i)} for i in range(375)]
            private(before/'archived-reuse-request.private.json',{'candidates':candidates,'archives':[]})
            machines=[{'id':row['machine_id'],'config':{'image':image}} for row in candidates]
            private(before/'navi-whisper-lux-bench.private.json',machines)
            events=[];epoch=time.time();closed_bytes=[]
            def reserve(factory,request,journal):
                events.append('reserve-joined')
                journal.mkdir()
                closed=dict(request,candidates=[dict(row,reservation={'cohort':'fixture'})
                    for row in candidates[:-1]],held_native_reservations=[candidates[-1]['machine_id']])
                path=private(journal/'reserved-request.json',closed)
                closed_bytes.append(path.read_bytes())
                return closed
            def observe(factory,request,closed,journal,deadline):
                events.append('observe-held')
                self.assertEqual(journal,directory/'archived-reuse-reservations'/'acknowledged-holds-observation')
                self.assertEqual(deadline,epoch+5400)
                self.assertEqual(closed['held_native_reservations'],[candidates[-1]['machine_id']])
                self.assertEqual(request['task_names'],tasks)
                return dict(closed,candidates=closed['candidates']+[dict(candidates[-1],
                    reservation={'cohort':'fixture','observed_after_original_failure':True})],
                    held_native_reservations=[])
            def snapshot(*parameters):
                events.append('fresh-all-apps')
                private(parameters[3]/'navi-whisper-lux-bench.private.json',machines)
                return {'available_slots_conservative':582,'ended_epoch':time.time()}
            def demand(request,inventory,protected,*,require_reserved=False):
                events.append('verify-all-credited')
                self.assertTrue(require_reserved)
                self.assertEqual(len(request['candidates']),375)
                self.assertTrue(request['candidates'][-1]['reservation']['observed_after_original_failure'])
                return {'qualified_reuse_count':375,'new_machine_demand':226}
            helper={'validate_request':lambda *unused:None,'reserve_cohort':reserve,
                'capacity_demand':demand,'NativeAdapter':lambda connection,journal:connection}
            original_loader=CLI.runpy.run_path
            def load(path,*args,**kwargs):
                if Path(path).name=='cloudbench-reconcile-reservations.py':
                    return {'observe_acknowledged_holds':observe}
                return original_loader(path,*args,**kwargs)
            full=types.SimpleNamespace(f_frsize=4096,f_bsize=4096,f_bavail=0,f_files=10**9,f_favail=10**9)
            with patch.object(CLI,'reuse_module',return_value=helper), \
                 patch.object(CLI.os,'statvfs',return_value=full), \
                 self.assertRaisesRegex(ValueError,'local disk headroom'):
                CLI.reserve_reuse_capacity(lambda *unused: (_ for _ in ()).throw(AssertionError('native effect')),
                    'fixture',args,RUNNER,directory,before,{'available_slots_conservative':582},epoch)
            self.assertEqual(events,[])
            self.assertFalse((directory/'archived-reuse-reservations').exists())
            space=types.SimpleNamespace(f_frsize=4096,f_bsize=4096,f_bavail=10**9,f_files=10**9,f_favail=10**9)
            with patch.object(CLI,'reuse_module',return_value=helper), \
                 patch.object(CLI,'capacity_snapshot',side_effect=snapshot), \
                 patch.object(CLI.os,'statvfs',return_value=space), \
                 patch.object(CLI.runpy,'run_path',side_effect=load):
                result=CLI.reserve_reuse_capacity(lambda *unused:object(),'fixture',args,RUNNER,
                    directory,before,{'available_slots_conservative':582},epoch)
            self.assertEqual(events,['reserve-joined','observe-held','fresh-all-apps','verify-all-credited'])
            self.assertEqual((directory/'archived-reuse-reservations'/'reserved-request.json').read_bytes(),closed_bytes[0])
            derivative=json.loads((directory/'archived-reuse-request.private.json').read_text())
            self.assertEqual(len(derivative['candidates']),375)
            self.assertEqual(derivative['held_native_reservations'],[])
            self.assertEqual(result['reservation_request_sha256'],CLI.digest(
                (directory/'archived-reuse-request.private.json').read_bytes()))

    def test_incomplete_admission_continuation_keeps_old_workload_clock_and_lock(self):
        with tempfile.TemporaryDirectory() as name:
            directory=Path(name);original=private(directory/'original-evidence','unchanged')
            oldref='a'*40;newref='b'*40;epoch=time.time()-10;deadline=epoch+5400
            image='fixture@sha256:'+'c'*64
            facts=private(directory/'facts',{'app':'navi-whisper-lux-bench','image_ref':image,
                'protected_machines':['p1','p2','p3','p4'],'protected_volumes':['v1']})
            agents=private(directory/'agents','FLY_API_TOKEN=fixture_token\n')
            args=argparse.Namespace(source_ref=newref,agents_env=agents,facts=facts,org='personal',extra_destroying_count=1)
            request={'candidates':[{'machine_id':'first'},{'machine_id':'second'}]}
            plan={'directory':str(directory),'source_root':str(directory/'old-workload'),
                'source_ref':oldref,'started_at':epoch,'deadline':deadline,'request':request,
                'classifications':[{'machine_id':'second'}],
                'retained_request':{'candidates':[{'machine_id':'first'}]}}
            machines=[{'id':row['machine_id'],'config':{'image':image}} for row in request['candidates']]
            events=[];snapshots=[];oldpins={'old-source':'pinned'}
            def snapshot(*parameters):
                snapshots.append(parameters[3])
                events.append('before-capacity' if len(snapshots)==1 else 'after-capacity')
                private(parameters[3]/'navi-whisper-lux-bench.private.json',machines)
                return {'available_slots_conservative':599,'ended_epoch':time.time()}
            def reconcile(factory,received,journal,end):
                events.append('reconcile')
                self.assertEqual(received,plan);self.assertEqual(end,deadline)
                self.assertEqual(journal,directory/'incomplete-admission-recovery')
                return dict(request,candidates=[dict(r,reservation={'cohort':'old'}) for r in request['candidates']])
            def prepare(args,root,pins,runner,launch,cap,started_at=None,host_operator_provenance=None):
                events.append('prepare')
                self.assertEqual((args.source_ref,root,pins,started_at),(oldref,Path(plan['source_root']),oldpins,epoch))
                self.assertEqual(host_operator_provenance['host_operator_source_ref'],newref)
                self.assertEqual(host_operator_provenance['workload_source_ref'],oldref)
                self.assertNotIn('original_config_path',host_operator_provenance)
                return private(launch/'config.private.json',{'source_ref':oldref,'started_at_epoch':epoch})
            def run(config,sha,out,**kwargs):
                events.append('run')
                self.assertEqual(sha,CLI.digest(config.read_bytes()))
                self.assertEqual(json.loads(config.read_bytes())['started_at_epoch'],epoch)
                with (directory/'incomplete-admission.lock').open() as stream, self.assertRaises(BlockingIOError):
                    CLI.fcntl.flock(stream.fileno(),CLI.fcntl.LOCK_EX|CLI.fcntl.LOCK_NB)
                return 0
            runner=dict(RUNNER,run=run)
            capture={'Fly':lambda *_:object()}
            original_loader=CLI.runpy.run_path
            def load(path,*a,**kw):
                return capture if Path(path).name=='cloudbench-original-volume-capture.py' else original_loader(path,*a,**kw)
            helper={'NativeAdapter':lambda api,path:api,'capacity_demand':lambda *a,**kw:
                {'qualified_reuse_count':2,'new_machine_demand':599}}
            with patch.object(CLI,'incomplete_admission_plan',return_value=({'reconcile':reconcile},plan,oldpins)), \
                 patch.object(CLI,'capacity_snapshot',side_effect=snapshot), \
                 patch.object(CLI,'reuse_module',return_value=helper), \
                 patch.object(CLI,'prepare',side_effect=prepare),patch.object(CLI.runpy,'run_path',side_effect=load):
                self.assertEqual(CLI.resume_incomplete_admission(args,ROOT,runner,'fixture'),0)
            self.assertEqual(events,['before-capacity','reconcile','after-capacity','prepare','run'])
            self.assertEqual(original.read_text(),'unchanged')
            self.assertEqual(json.loads((directory/'controller-launch.intent.json').read_bytes())['config_path'],
                             str(next(directory.glob('launch-*'))/'config.private.json'))

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
                    # capacity() loads its own runner copy; whichever nested bound
                    # fires first raises that copy's Deadline class.
                    with self.assertRaises(BaseException) as raised:
                        with RUNNER['bounded'](.15):
                            CLI.capacity(API, 'fixture', 'personal', Path(name), 1)
                self.assertEqual(type(raised.exception).__name__, 'Deadline')
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
            self.assertEqual(json.loads(result.stdout)['infra_early_stop'], 'enabled')
            disabled = subprocess.run(args + ['--infra-early-stop', 'disabled'], cwd='/', env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(disabled.returncode, 0, disabled.stderr)
            self.assertEqual(json.loads(disabled.stdout)['infra_early_stop'], 'disabled')
            invalid = subprocess.run(args + ['--infra-early-stop', 'false'], cwd='/', env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(invalid.returncode, 0)
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

    def test_prepared_index_is_hash_bound_and_old_source_keeps_legacy_path(self):
        helper=runpy.run_path(str(ROOT/'scripts/tests/cloudbench-archived-machine-reuse.test.py'))
        request,_,_=helper['fixture'](2)
        tasks=json.loads((ROOT/'scripts/tests/fixtures/original600-tasks.json').read_bytes())
        request['task_names']=tasks
        for row in request['candidates']:row['reservation']={'cohort':request['cohort']}
        indexer=runpy.run_path(str(ROOT/'scripts/cloudbench-reuse-index.py'))
        with tempfile.TemporaryDirectory() as name:
            root=Path(name)
            args=argparse.Namespace(source_ref=request['harness_ref'],tasks=private(root/'tasks',tasks),
                facts=private(root/'facts',{'app':'navi-whisper-lux-bench','image_ref':request['image_ref'],
                    'protected_machines':['p1','p2','p3','p4'],'protected_volumes':['v1']}),
                agents_env=private(root/'agents','fixture'),backend_env=private(root/'backend','fixture'),
                snapshot_inventory=private(root/'inventory',{}),warm_deps=private(root/'deps','fixture'))
            cap={'ended_epoch':time.time(),'available_slots_conservative':601,'new_machine_demand':599,
                'machine_limit':1000,'total_active_inventory_objects':400,'conservative_extra_destroying_bench_objects':1,
                'qualified_reuse_count':2}
            for indexed in (True,False):
                directory=root/str(indexed);directory.mkdir(mode=0o700)
                RUNNER['save'](directory/'capacity-proof.private.json',cap)
                request_path=directory/'archived-reuse-request.private.json'
                RUNNER['save'](request_path,request)
                pins={'cloudbench-reuse-index.py':CLI.digest((ROOT/'scripts/cloudbench-reuse-index.py').read_bytes())} if indexed else {}
                config=json.loads(CLI.prepare(args,ROOT,pins,RUNNER,directory,cap).read_bytes())
                env=config['remote_env']
                if indexed:
                    item=next(row for row in config['remote_files'] if row['relative_path'].endswith('.index.json'))
                    self.assertEqual(env['CLOUDBENCH_ARCHIVED_REUSE_INDEX'],'/tmp/gate/repo/'+item['relative_path'])
                    self.assertEqual(env['CLOUDBENCH_ARCHIVED_REUSE_INDEX_SHA256'],item['sha256'])
                    header,row=indexer['select'](request_path,CLI.digest(request_path.read_bytes()),
                        item['source_path'],item['sha256'],1)
                    self.assertEqual(row,request['candidates'][1])
                    self.assertEqual(header['task_names'],tasks)
                else:
                    self.assertNotIn('CLOUDBENCH_ARCHIVED_REUSE_INDEX',env)
                    self.assertEqual(len(config['remote_files']),3)

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
            self.assertNotIn('infra_early_stop', value)
            args.infra_early_stop = 'disabled'
            disabled = directory / 'disabled'
            disabled.mkdir(mode=0o700)
            config2 = CLI.prepare(args, ROOT, {n: 'b'*64 for n in CLI.PINS}, RUNNER, disabled, dict(cap, proof_path=str(directory/'capacity-proof.private.json')))
            self.assertEqual(json.loads(config2.read_bytes())['infra_early_stop'], 'disabled')
            self.assertEqual(json.loads((disabled/'attempt-start.safe.json').read_bytes())['original_deadline_epoch'], json.loads(config2.read_bytes())['started_at_epoch']+5400)
            cap['ended_epoch'] = time.time()-271
            with self.assertRaisesRegex(ValueError, 'expired'):
                CLI.prepare(args, ROOT, {}, RUNNER, directory, cap)



class Sharded(unittest.TestCase):
    """Fresh runs split across controllers sized to what one controller handles easily."""

    def args(self, directory, **overrides):
        facts = dict(app='navi-whisper-lux-bench', image_ref='registry.fly.io/fixture@sha256:'+'a'*64,
                     protected_machines=['m1', 'm2', 'm3', 'm4'], protected_volumes=['v1'])
        values = dict(source_ref='a'*40, facts=private(directory/'facts', facts),
                      agents_env=private(directory/'agents.env', 'FLY_API_TOKEN=fixture\n'),
                      backend_env=private(directory/'backend.env', 'COMPLETE=fixture\n'),
                      tasks=private(directory/'tasks', json.loads((ROOT/'scripts/tests/fixtures/original600-tasks.json').read_text())),
                      snapshot_inventory=private(directory/'snapshot', {}), warm_deps=private(directory/'warm', 'fixture'),
                      task_count=None, repetitions=3, controllers='auto', tasks_per_controller=None,
                      worker_headroom=0, infra_early_stop='enabled', org='personal', extra_destroying_count=1,
                      archive_run=[], reuse_exclude_machine=[], state_dir=directory/'state',
                      hub_python=Path(sys.executable))
        values.update(overrides)
        return argparse.Namespace(**values)

    def capacity(self, directory, free=1000):
        return dict(started_epoch=time.time(), ended_epoch=time.time(), machine_limit=1000, billing_status='fixture',
                    total_active_inventory_objects=1000-free-1, conservative_extra_destroying_bench_objects=1, apps=[],
                    available_slots_conservative=free, new_controller_slots=1, requested_original_primary_slots=600,
                    proof_path=str(private(directory/'capacity-proof.private.json', {})))

    def test_selection_defaults_to_controllers_sized_by_copies(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            plan = CLI.shard_selection(self.args(directory), RUNNER)
            self.assertEqual((plan['controllers'], plan['copies']), (20, 600))
            self.assertIsNone(CLI.shard_selection(self.args(directory, controllers='1'), RUNNER))
            ladder = CLI.shard_selection(self.args(directory, task_count=100, repetitions=1), RUNNER)
            self.assertEqual((ladder['controllers'], ladder['copies']), (4, 100))
            one = CLI.shard_selection(self.args(directory, task_count=10, repetitions=3), RUNNER)
            self.assertEqual(one['controllers'], 1)  # a subset is still a shard config, not the legacy 200x3
            with self.assertRaisesRegex(ValueError, 'task-count'):
                CLI.shard_selection(self.args(directory, task_count=201), RUNNER)

    def test_shard_prepare_binds_tasks_budget_and_sibling_controllers_only_when_sharded(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            args = self.args(directory)
            legacy_dir, shard_dir = directory/'legacy', directory/'shard'
            legacy_dir.mkdir(mode=0o700); shard_dir.mkdir(mode=0o700)
            cap = self.capacity(directory)
            legacy = json.loads(CLI.prepare(args, ROOT, {n: 'b'*64 for n in CLI.PINS}, RUNNER, legacy_dir, cap).read_bytes())
            self.assertNotIn('shard', legacy)
            self.assertNotIn('sibling_controller_slots', json.loads((legacy_dir/'authority-template.private.json').read_bytes()))
            self.assertEqual(json.loads((legacy_dir/'attempt-start.safe.json').read_bytes())['scheduled_total'], 600)
            tasks = json.loads(args.tasks.read_text())[0::20]
            shard = dict(index=0, count=20, tasks=tasks, task_indexes=list(range(0, 200, 20)), runs=3, group_run_id='g', group_total=600,
                         group_started_at=1.0, tasks_sha256=CLI.digest(('\n'.join(tasks)+'\n').encode()))
            env = dict(CLOUDBENCH_APP_MACHINE_CEILING='962', CLOUDBENCH_SHARED_CPU_GOVERNOR='2428')
            value = json.loads(CLI.prepare(args, ROOT, {n: 'b'*64 for n in CLI.PINS}, RUNNER, shard_dir, cap, shard=shard,
                                           runtime_env=env, sibling_controller_slots=19, scheduled_total=600).read_bytes())
            self.assertEqual(value['shard'], shard)
            self.assertEqual(value['remote_env']['CLOUDBENCH_APP_MACHINE_CEILING'], '962')
            self.assertEqual(json.loads((shard_dir/'authority-template.private.json').read_bytes())['sibling_controller_slots'], 19)
            self.assertEqual(json.loads((shard_dir/'attempt-start.safe.json').read_bytes())['scheduled_total'], 30)
            for key in set(legacy) - {'started_at_epoch', 'authority_template', 'remote_env', 'shard'}:
                self.assertEqual(value[key], legacy[key], key)

    def test_shared_cpu_plan_reads_the_task_revision_catalog(self):
        tasks = json.loads((ROOT/'scripts/tests/fixtures/original600-tasks.json').read_text())[:5]
        baseline = [dict(id='a', state='started', config=dict(guest=dict(cpus=2, cpu_kind='shared'))),
                    dict(id='b', state='stopped', config=dict(guest=dict(cpus=4, cpu_kind='shared'))),
                    dict(id='c', state='started', config=dict(guest=dict(cpus=8, cpu_kind='performance')))]
        planned, current = CLI.shared_cpu_plan(ROOT, RUNNER, tasks, 3, baseline)
        self.assertEqual(current, 2)
        self.assertGreater(planned, 0)
        self.assertEqual(planned % 3, 0)  # every copy of each task is admitted simultaneously

    def test_sharded_run_admits_once_launches_k_runners_and_merges(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            (directory/'state').mkdir(mode=0o700)
            args = self.args(directory, task_count=12, repetitions=3, tasks_per_controller=4)
            plan = CLI.shard_selection(args, RUNNER)
            self.assertEqual(plan['controllers'], 3)
            launched = []

            class Runner:
                def __init__(self, argv, **kwargs):
                    self.out = Path(argv[argv.index('--output')+1])
                    self.config = json.loads(Path(argv[argv.index('--config')+1]).read_bytes())
                    self.env, self.pid, self.code, self.polls = kwargs['env'], 4242 + len(launched), None, 0
                    self.out.mkdir(mode=0o700)
                    launched.append(self)

                def status(self, barrier):
                    (self.out/'shard-status.json').write_text(json.dumps(dict(state='LIVE', barrier=dict(status=barrier), infra=dict(infra_true=0))))

                def poll(self):
                    self.polls += 1
                    if (self.out/'global-release.json').exists() and self.code is None:
                        shard = self.config['shard']
                        jobs = [dict(job_id=f"r{r:03d}-j{i:04d}", status='passed', task_status='PASSED',
                                     terminal_task=True, lifecycle_verified=True, resources_released=True, infra_failure=False)
                                for r in range(1, shard['runs']+1) for i in shard['task_indexes']]
                        export = self.out/'export'; export.mkdir(mode=0o700)
                        (export/'disposable-export.verified.json').write_text('{}')
                        raw = json.dumps(dict(jobs=jobs)).encode()
                        import tarfile
                        with tarfile.open(export/'originals.tar.gz', 'w:gz') as tar:
                            info = tarfile.TarInfo('originals/repo/.context/benchmarks/campaigns/campaign-x/summary.json')
                            info.size = len(raw); tar.addfile(info, io.BytesIO(raw))
                        self.code = 0
                    elif self.polls == 1:
                        self.status('ready')
                    return self.code

                def wait(self):
                    return self.code

                def send_signal(self, number):
                    raise AssertionError('no runner should be signalled')

            cap = self.capacity(directory, free=700)
            cap.pop('proof_path')  # the real native snapshot carries no proof path
            def snapshot(api, token, org, target, extra):
                private(target/'navi-whisper-lux-bench.private.json', [])
                return dict(cap)
            published = []
            def publish(root, admission, args_, runner_, group_id, started_at, shards, outcomes=None, finished=None):
                published.append(dict(group_id=group_id, members=sum(len(s['tasks']) * s['runs'] for s in shards),
                                      outcomes=outcomes, finished=finished))
                return True
            with patch.object(CLI, 'capacity_snapshot', snapshot), \
                 patch.object(CLI, 'shared_cpu_plan', lambda *a: (36, 0)), \
                 patch.object(CLI, 'publish_shard_group', publish), \
                 patch.object(CLI, 'hub_interpreter', lambda args: sys.executable), \
                 patch.object(CLI, 'missing_prompt_secrets', lambda *a: []), \
                 patch.object(CLI.subprocess, 'Popen', Runner):
                code = CLI.sharded_run(args, ROOT, {n: 'b'*64 for n in CLI.PINS}, RUNNER, 'ghs_fixture', plan)
            self.assertEqual([p['outcomes'] is None for p in published], [True, False])
            self.assertEqual({p['group_id'] for p in published}, {launched[0].config['shard']['group_run_id']})
            self.assertEqual(published[0]['members'], 36)
            self.assertEqual(len(published[1]['outcomes']), 36)
            self.assertEqual(published[1]['finished']['status'], 'completed')
            self.assertEqual(code, 0)
            self.assertEqual(len(launched), 3)
            self.assertEqual(sorted(r.env['CLOUDBENCH_GATE_NAME_SUFFIX'] for r in launched), ['s00', 's01', 's02'])
            self.assertTrue(all(r.env['GITHUB_TOKEN'] == 'ghs_fixture' for r in launched))
            self.assertEqual({r.config['shard']['group_run_id'] for r in launched}.__len__(), 1)
            admission = next((directory/'state').iterdir())
            result = json.loads((admission/'result.json').read_bytes())
            self.assertEqual((result['observed_jobs'], result['missing_jobs'], result['infra_failures']), (36, 0, 0))
            self.assertEqual(json.loads((admission/'capacity-proof.private.json').read_bytes())['new_machine_demand'], 45)

    def test_sharded_run_refuses_a_hub_interpreter_without_agents_dependencies(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            (directory/'state').mkdir(mode=0o700)
            bare = directory/'bare-python'
            bare.write_text('#!/bin/sh\nexit 1\n'); bare.chmod(0o700)
            args = self.args(directory, task_count=12, repetitions=3, tasks_per_controller=4, hub_python=bare)
            plan = CLI.shard_selection(args, RUNNER)
            with patch.object(CLI, 'capacity_snapshot', side_effect=AssertionError('no provider read before the check')):
                with self.assertRaisesRegex(ValueError, 'lacks httpx'):
                    CLI.sharded_run(args, ROOT, {n: 'b'*64 for n in CLI.PINS}, RUNNER, 'ghs_fixture', plan)
            self.assertEqual(list((directory/'state').iterdir()), [])

    def test_prompt_secret_missing_from_env_refuses_before_provider_reads(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            (directory/'state').mkdir(mode=0o700)
            manifest = json.loads((ROOT/'scripts/tests/fixtures/original600-tasks.json').read_text())
            needs = 'cuda-kernel-github-top100-code-agent'
            self.assertIn(needs, manifest)
            args = self.args(directory, task_count=manifest.index(needs)+1, repetitions=1)
            plan = CLI.shard_selection(args, RUNNER)
            with patch.object(CLI, 'hub_interpreter', lambda args: sys.executable), \
                 patch.object(CLI, 'capacity_snapshot', side_effect=AssertionError('no provider read before the check')):
                with self.assertRaisesRegex(ValueError, needs + ' needs GITHUB_DISPATCH_TOKEN'):
                    CLI.sharded_run(args, ROOT, {n: 'b'*64 for n in CLI.PINS}, RUNNER, 'ghs_fixture', plan)
            self.assertEqual(list((directory/'state').iterdir()), [])
            private(args.backend_env, 'COMPLETE=fixture\nGITHUB_DISPATCH_TOKEN=fixture-dispatch\n')
            self.assertEqual(CLI.missing_prompt_secrets(ROOT, RUNNER, [needs], (args.agents_env, args.backend_env)), [])

    def test_sharded_run_refuses_before_any_runner_when_capacity_is_short(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            (directory/'state').mkdir(mode=0o700)
            args = self.args(directory, task_count=12, repetitions=3, tasks_per_controller=4)
            plan = CLI.shard_selection(args, RUNNER)
            cap = self.capacity(directory, free=44)
            def snapshot(api, token, org, target, extra):
                private(target/'navi-whisper-lux-bench.private.json', [])
                return dict(cap)
            with patch.object(CLI, 'capacity_snapshot', snapshot), \
                 patch.object(CLI, 'hub_interpreter', lambda args: sys.executable), \
                 patch.object(CLI, 'missing_prompt_secrets', lambda *a: []), \
                 patch.object(CLI.subprocess, 'Popen', side_effect=AssertionError('no runner may start')):
                with self.assertRaisesRegex(ValueError, '44 free Machine slots < 45 required'):
                    CLI.sharded_run(args, ROOT, {n: 'b'*64 for n in CLI.PINS}, RUNNER, 'ghs_fixture', plan)


if __name__ == '__main__':
    unittest.main()
