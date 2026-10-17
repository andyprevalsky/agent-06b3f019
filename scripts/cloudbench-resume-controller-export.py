#!/usr/bin/env python3
"""Resume one closed controller export using its unchanged collector and authority."""

import argparse
import base64
import fcntl
import json
import os
import runpy
import shlex
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
F = runpy.run_path(str(HERE / "cloudbench-controller-payload-finalization.py"))
B, R = F["B"], F["R"]
need, read, save, sha = (R[key] for key in ("need", "read", "save", "sha"))
REMOTE = r"""
import sys,time

def phase(name):
 assert name in ('REMOTE_ENTERED','GIT_START','GIT_DONE','LAUNCH_START','LAUNCH_DONE','HUB_START','HUB_DONE','WRITERS_START','WRITERS_DONE','DRAIN_START','DRAIN_DONE','EXPORT_START','EXPORT_DONE','VERIFY_START','VERIFY_DONE','RESPONSE_READY')
 print('EXPORT_PHASE '+name+' '+str(time.monotonic_ns()),file=sys.stderr,flush=True)

phase('REMOTE_ENTERED')
import ast,base64,copy,hashlib,json,os,subprocess
from pathlib import Path
from types import SimpleNamespace

def readonly_hubs(scope,source,repo,directory):
 tree=ast.parse(source)
 function=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='retire_disposable_hubs')
 function=copy.deepcopy(function);function.name='readonly_hubs'
 guard=next(n for n in function.body if isinstance(n,ast.Try))
 boundary=next(i for i,n in enumerate(guard.body)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='end'for t in n.targets))
 guard.body=guard.body[:boundary]+[ast.parse("return [{'pid':pid,'birth':owner['pid_start'],'owner_sha256':hashlib.sha256(raw).hexdigest()} for pid,fd,owner,raw,path in selected]").body[0]]
 assert not any(isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and n.func.attr in ('pidfd_send_signal','kill','killpg','unlink','write_bytes','write_text')for n in ast.walk(function))
 module=ast.fix_missing_locations(ast.Module(body=[function],type_ignores=[]));namespace=dict(scope);exec(compile(module,'<readonly-old-Hub-validator>','exec'),namespace)
 return namespace['readonly_hubs'](repo,directory)or[]

def idle_children(scope,record,repo,proc=Path('/proc')):
 driver=record['driver_pid'];parent=proc/str(driver)
 assert scope['birth'](driver)==record['driver_birth']
 children=(parent/'task'/str(driver)/'children').read_text().split();assert len(children)<=1
 result=[]
 for value in children:
  pid=int(value);path=proc/value;birth=scope['birth'](pid);assert birth
  fields=(path/'stat').read_text().rsplit(') ',1)[1].split()
  status=dict(line.split(':',1)for line in(path/'status').read_text().splitlines()if ':'in line)
  assert int(fields[1])==driver and fields[0]not in('Z','X')and [int(x)for x in status['Uid'].split()]==[0]*4
  assert [int(x)for x in(parent/'status').read_text().split('Uid:',1)[1].splitlines()[0].split()]==[0]*4
  assert scope['process_argv'](pid)==['sleep','60'] and os.readlink(path/'cwd')==os.readlink(parent/'cwd')==str(repo)
  executable=Path('/usr/bin/sleep').resolve(strict=True)
  assert Path(os.readlink(path/'exe')).resolve(strict=True)==executable and os.path.samefile(path/'exe',executable)
  assert not(path/'task'/value/'children').read_text().strip()
  descriptors={p.name:os.readlink(p)for p in(path/'fd').iterdir()}
  assert set(descriptors)=={'0','1','2'}and descriptors=={n:os.readlink(parent/'fd'/n)for n in descriptors}
  assert scope['birth'](pid)==birth
  result.append({'pid':pid,'birth':birth,'ppid':driver,'uid':0,'argv':['sleep','60'],'cwd':str(repo),'executable':str(executable),'stdio':descriptors})
 assert children==(parent/'task'/str(driver)/'children').read_text().split()and scope['birth'](driver)==record['driver_birth']
 return result

def scoped_idle_writers(scope,record,repo):
 original=scope['writers'];observations=[]
 def writers(roots,permitted):
  before=idle_children(scope,record,repo)
  active=original(roots,set(permitted)|{row['pid']for row in before})
  assert idle_children(scope,record,repo)==before,'idle driver child changed during writer scan'
  observations.append({'idle_children':before,'non_idle_writers':active})
  return active
 scope['writers']=writers
 return observations

def drain_evidence(scope):
 phase('DRAIN_START')
 root=Path('/tmp/gate/controller-host-custody/registered-orphan-drain')
 result={'root':str(root),'present':root.exists(),'directories':[],'files':{}}
 if not root.exists():phase('DRAIN_DONE');return result
 assert root.resolve(strict=True)==root and root.is_dir()
 paths=[root,*sorted(root.rglob('*'))];before={str(p):scope['file_state'](p)for p in paths};total=0
 for path in paths[1:]:
  assert not path.is_symlink()and path.resolve(strict=True)==path
  name=str(path.relative_to(root))
  if path.is_dir():result['directories'].append(name);continue
  digest,raw=scope['sealed_bytes'](path,16777216);total+=len(raw);assert total<=16777216
  result['files'][name]={'bytes':len(raw),'sha256':digest,'body_b64':base64.b64encode(raw).decode()}
 assert before=={str(p):scope['file_state'](p)for p in [root,*sorted(root.rglob('*'))]}
 phase('DRAIN_DONE')
 return result

def main(v):
 assert os.getcwd()=='/' and os.environ['FLY_MACHINE_ID']==v['machine']
 repo=Path('/tmp/gate/repo');custody=Path('/tmp/gate/controller-host-custody');record_path=custody/'launch.json'
 phase('GIT_START')
 source=subprocess.check_output(['git','-c','safe.directory='+str(repo),'--no-replace-objects','-C',str(repo),'show',v['source_ref']+':scripts/cloudbench-controller-export.py'])
 assert hashlib.sha256(source).hexdigest()==v['collector_sha256']
 phase('GIT_DONE')
 phase('LAUNCH_START')
 scope={'__name__':'bound_original_export','__file__':'/tmp/controller-host-export.py','CHECKED_COLLECTOR_SHA256':hashlib.sha256(source).hexdigest(),'CHECKED_COLLECTOR_SOURCE_BYTES':source}
 exec(compile(source,scope['__file__'],'exec'),scope)
 assert scope['sealed_bytes'](Path('/tmp/controller-host-export.py'),67108864)[1]==source
 record_sha,raw=scope['sealed_bytes'](record_path,67108864);record=json.loads(raw)
 assert record_sha==v['launch_sha256']and record==v['record']
 assert record['machine_id']==v['machine']and record['source_ref']==v['source_ref']and scope['birth'](record['driver_pid'])==record['driver_birth']
 driver=record['driver_pid'];argv=scope['process_argv'](driver)
 assert len(argv)==2 and Path(argv[0]).name=='bash'and argv[1]=='/tmp/gate.sh'
 assert scope['sealed_bytes'](Path('/tmp/gate.sh'),1048576)[0]==v['driver_sha256']
 for child in Path(f'/proc/{driver}/task/{driver}/children').read_text().split():
  child=int(child);args=scope['process_argv'](child);assert len(args)==2 and Path(args[0]).name=='sleep'and args[1]=='60'
 command_sha,command_raw=scope['sealed_bytes'](Path('/tmp/gate/controller-command.json'),1048576);command=json.loads(command_raw)
 _,joined_raw=scope['sealed_bytes'](Path('/tmp/gate/controller-command.joined.json'),1048576);joined=json.loads(joined_raw)
 assert joined['command_sha256']==command_sha and joined['driver_pid']==driver and joined['driver_birth']==record['driver_birth']and type(joined['exit_code'])is int
 assert command['machine_id']==v['machine']and command['source_ref']==v['source_ref']
 assert command.get('already_joined')or scope['birth'](command['pid'])!=command['birth']
 _,pending_raw=scope['sealed_bytes'](custody/'pending.json',1048576);pending=json.loads(pending_raw)
 assert pending['status']=='pending'and pending.get('record_sha256')==record_sha
 roots=[repo,Path(record['common_git']),*[Path(p)for p in record['temp_state_roots']if Path(p).exists()]]
 idle_observations=scoped_idle_writers(scope,record,repo)
 phase('LAUNCH_DONE')
 phase('HUB_START')
 hubs=readonly_hubs(scope,source,repo,custody);phase('HUB_DONE');permitted={os.getpid(),driver,*[h['pid']for h in hubs]}
 phase('WRITERS_START')
 active=scope['controller_active_writers'](Path(record['common_git']),roots,permitted)
 phase('WRITERS_DONE')
 if active:
  print(json.dumps({'status':'PENDING_WRITERS','non_hub_writers':active,'machine':v['machine'],'launch_sha256':record_sha,'idle_writer_observations':idle_observations}),flush=True)
  raise SystemExit(75)
 result={'machine':v['machine'],'launch_sha256':record_sha,'driver_pid':driver,'driver_birth':record['driver_birth'],'joined':joined,'hubs':hubs,'non_hub_writers':[],'idle_writer_observations':idle_observations}
 if v['action']=='check':
  encoded=json.dumps(dict(result,drain_evidence=drain_evidence(scope)));phase('RESPONSE_READY');print(encoded);return
 assert v['action']=='export'
 phase('HUB_START')
 assert readonly_hubs(scope,source,repo,custody)==hubs
 phase('HUB_DONE')
 phase('WRITERS_START')
 active=scope['controller_active_writers'](Path(record['common_git']),roots,permitted)
 phase('WRITERS_DONE')
 if active:
  print(json.dumps({'status':'PENDING_WRITERS','non_hub_writers':active,'machine':v['machine'],'launch_sha256':record_sha,'idle_writer_observations':idle_observations}),flush=True)
  raise SystemExit(75)
 intent=custody/'export-resume.intent.json'
 scope['sync_json'](intent,{'binding_sha256':v['binding_sha256'],'launch_sha256':record_sha,'source_ref':v['source_ref']})
 stage=custody/('export-resume-'+v['binding_sha256'][:24]);stage.mkdir(mode=0o700)
 fd=os.open(custody,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
 args=SimpleNamespace(record=record_path,archive=stage/'originals.tar.gz',manifest=stage/'manifest.json',pending=stage/'pending.json',capture_tool_ref=None,finalize_disposable_hubs=True)
 phase('EXPORT_START')
 code=scope['export'](args)
 assert code==0,'canonical export still pending'
 phase('EXPORT_DONE')
 phase('VERIFY_START')
 scope['verify'](SimpleNamespace(record=record_path,archive=args.archive,manifest=args.manifest,caller=Path('/tmp/controller-host-caller.json'),ref=v['source_ref'],machine=v['machine'],app=record['app'],image=record['image'],repo=repo))
 phase('VERIFY_DONE')
 encoded=json.dumps(dict(result,remote_stage=str(stage),canonical_export_exit=code,drain_evidence=drain_evidence(scope)));phase('RESPONSE_READY');print(encoded)

if __name__=='__main__':main(json.loads(base64.b64decode(sys.argv[1])))
"""


def obj(path):
    return json.loads(read(path))


def file_sha(path):
    scope = runpy.run_path(str(HERE / "cloudbench-controller-export.py"))
    return scope["sealed_bytes"](Path(path))[0]


def relay_intent_path(original, pins):
    pointer_path = original.parent / "pre-signal-successor.json"
    if not pointer_path.exists():
        return original
    names = {"intent.json"} | {
        f"wire-{index:06d}.{suffix}.json"
        for index in (1, 2)
        for suffix in ("request", "raw", "decoded")
    }
    directory = original.parent
    need(
        directory.resolve(strict=True) == directory,
        "physical prior relay journal required",
    )
    need(
        {path.name for path in directory.iterdir()} == names | {pointer_path.name},
        "prior relay journal membership differs",
    )
    files = {name: sha(read(directory / name)) for name in sorted(names)}
    digest = sha(
        json.dumps(
            files, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    )
    pointer = obj(pointer_path)
    need(
        set(pointer)
        == {
            "schema",
            "prior_journal_sha256",
            "new_journal",
            "intent_sha256",
            "identity_sha256",
            "operator_ref",
            "launch_sha256",
        },
        "relay successor pointer schema differs",
    )
    target = directory.parent / ("relay-bootstrap-pre-signal-" + digest)
    need(
        pointer["schema"] == "relay-pre-signal-successor-v1"
        and pointer["prior_journal_sha256"] == digest
        and pointer["new_journal"] == str(target)
        and target.resolve(strict=True) == target,
        "relay successor journal differs",
    )
    selected = target / "intent.json"
    raw = read(selected)
    need(sha(raw) == pointer["intent_sha256"], "relay successor intent hash differs")
    intent = json.loads(raw)
    payload = intent["payload"]
    need(
        all(
            payload[key] == pointer[key]
            for key in ("identity_sha256", "operator_ref", "launch_sha256")
        ),
        "relay successor identity differs",
    )
    prior = obj(original)
    refusal = intent["pre_signal_refusal"]
    need(
        set(refusal) == {"journal", "files", "prior_journal_sha256", "source_pins"}
        and {key: refusal[key] for key in ("journal", "files", "prior_journal_sha256")}
        == {"journal": str(directory), "files": files, "prior_journal_sha256": digest}
        and isinstance(refusal["source_pins"], dict)
        and refusal["source_pins"] == prior["relay_source_pins"],
        "relay successor prior proof differs",
    )
    need(
        payload["launch_sha256"] == obj(original)["payload"]["launch_sha256"]
        and payload["relay_directory"] == obj(original)["payload"]["relay_directory"],
        "relay successor target differs",
    )
    for path in [directory, pointer_path, target, selected] + [
        directory / name for name in names
    ]:
        pins[str(path)] = B["fingerprint"](path)
    return selected


def local_drain_binding(out, pins):
    directory = out / "registered-orphan-drain"
    if not directory.exists():
        return None
    intent_path = directory / "intent.json"
    intent = obj(intent_path)
    planned = []
    for path in sorted(directory.glob("result-*.json")):
        value = obj(path)
        if value.get("status") == "PLANNED":
            planned.append((path, value))
    need(len(planned) == 1, "one recorded orphan drain plan required")
    plan_path, plan = planned[0]
    for path in (intent_path, plan_path):
        pins[str(path)] = B["fingerprint"](path)
    binding = {
        "identity_sha256": intent["payload"]["identity_sha256"],
        "operator_ref": intent["payload"]["operator_ref"],
        "launch_sha256": intent["payload"]["launch_sha256"],
        "plan_sha256": plan["plan_sha256"],
        "host_intent_sha256": sha(read(intent_path)),
        "host_plan_receipt_sha256": sha(read(plan_path)),
    }
    relay_path = directory / "relay-bootstrap/intent.json"
    if relay_path.exists():
        relay_path = relay_intent_path(relay_path, pins)
        relay = obj(relay_path)["payload"]
        need(relay["launch_sha256"] == binding["launch_sha256"], "relay launch differs")
        binding["relay"] = {
            key: relay[key]
            for key in (
                "identity_sha256",
                "operator_ref",
                "launch_sha256",
                "relay_directory",
            )
        }
        binding["relay"]["host_intent_sha256"] = sha(read(relay_path))
        pins[str(relay_path)] = B["fingerprint"](relay_path)
    return binding


def require_recorded_drain(binding, evidence):
    if binding is None:
        return
    need(evidence.get("present") is True, "recorded orphan drain evidence missing")
    files = evidence["files"]
    decoded = {}
    names = ["intent.json", "plan.json"]
    if "relay" in binding:
        need("relay-bootstrap/intent.json" in files, "recorded relay intent missing")
        names.append("relay-bootstrap/intent.json")
    for name in names:
        item = files[name]
        raw = base64.b64decode(item["body_b64"], validate=True)
        need(
            len(raw) == item["bytes"] and sha(raw) == item["sha256"],
            "drain evidence bytes differ",
        )
        decoded[name] = json.loads(raw)
    intent, plan = decoded["intent.json"], decoded["plan.json"]
    need(
        intent["identity_sha256"]
        == plan["identity_sha256"]
        == binding["identity_sha256"]
        and intent["operator_ref"] == binding["operator_ref"]
        and plan["launch_sha256"] == binding["launch_sha256"]
        and files["plan.json"]["sha256"] == binding["plan_sha256"],
        "downloaded orphan drain differs from recorded plan",
    )
    if "relay" in binding:
        expected = binding["relay"]
        relay = decoded["relay-bootstrap/intent.json"]
        need(
            all(
                relay[key] == expected[key]
                for key in ("identity_sha256", "operator_ref", "launch_sha256")
            )
            and relay["owner"]["relay_directory"] == expected["relay_directory"],
            "downloaded relay intent differs from recorded invocation",
        )


def check(config, config_sha256, run_directory, operator_ref):
    out = Path(run_directory).absolute()
    state = obj(out / "payload-finalizer.identities.private.json")
    roots = {
        str(Path(path).parent.parent)
        for path in state["pins"]
        if Path(path).name == "cloudbench-controller-payload-finalization.py"
    }
    need(len(roots) == 1, "unique captured finalizer source required")
    capture_root = Path(roots.pop())
    need(
        F["validate"](
            state, config, config_sha256, out, state["operator_ref"], capture_root
        ),
        "original gate is not positively gone/reaped",
    )
    need(
        not (out / "export/disposable-export.verified.json").exists(),
        "export already verified",
    )
    need(
        not (out / "cleanup-call.intent.json").exists(),
        "controller cleanup already dispatched",
    )
    names = (
        "cloudbench-resume-controller-export.py",
        "cloudbench-controller-payload-finalization.py",
        "cloudbench-resume-controller-payload.py",
        "cloudbench-original600-runner.py",
        "cloudbench-original-volume-capture.py",
        "cloudbench-controller-export.py",
        "run-original600-controller.py",
    )
    hashes = {name: sha((HERE / name).read_bytes()) for name in names}
    pins = B["source_identity"](HERE.parent, operator_ref, hashes)
    source_root = Path(state["source_root"])
    collector_path = source_root / "scripts/cloudbench-controller-export.py"
    collector = subprocess.check_output(
        [
            "git",
            "--no-replace-objects",
            "-C",
            str(source_root),
            "show",
            state["source_ref"] + ":scripts/cloudbench-controller-export.py",
        ]
    )
    need(collector_path.read_bytes() == collector, "original collector source changed")
    launch_path = out / "export/launch.json"
    launch_raw = read(launch_path)
    launch = json.loads(launch_raw)
    need(
        launch["machine_id"] == state["machine_id"]
        and launch["source_ref"] == state["source_ref"]
        and launch["collector_sha256"] == sha(collector)
        and launch["caller"] == obj(out / "export/caller.json")
        and launch["caller"]["pid"] == state["caller"]["gate_pid"]
        and launch["caller"]["birth"] == state["caller"]["gate_birth"],
        "original launch/caller differs",
    )
    log_path = out / "gate.private.log"
    log = read(log_path)
    need(
        ("GATE_EXPORT_PENDING machine=" + state["machine_id"]).encode() in log
        and b"GATE_RESULT exit=" in log,
        "old gate did not positively return export pending",
    )
    drivers = [
        entry
        for entry in state["machine"]["config"]["files"]
        if entry["guest_path"] == "/tmp/gate.sh"
    ]
    need(len(drivers) == 1, "exact sealed native driver required")
    driver = base64.b64decode(drivers[0]["raw_value"], validate=True)
    need(
        b"while :; do sleep 60; done" in driver
        and b"bound_controller_export export" in driver,
        "original idle-after-export driver contract required",
    )
    pins.update(
        {
            str(path): B["fingerprint"](path)
            for path in (collector_path, launch_path, log_path)
        }
    )
    binding = {
        "machine": state["machine_id"],
        "instance": state["machine"]["instance_id"],
        "config_sha256": config_sha256,
        "capture_sha256": sha(read(out / "payload-finalizer.identities.private.json")),
        "launch_sha256": sha(launch_raw),
        "source_ref": state["source_ref"],
        "operator_ref": operator_ref,
        "operator_hashes": hashes,
        "original_epoch": state["epoch"],
        "original_deadline": state["deadline"],
    }
    binding["orphan_drain"] = local_drain_binding(out, pins)
    need(
        binding["orphan_drain"] is None
        or binding["orphan_drain"]["launch_sha256"] == binding["launch_sha256"],
        "recorded orphan drain belongs to another controller launch",
    )
    return {
        "state": state,
        "config": str(Path(config).absolute()),
        "config_sha256": config_sha256,
        "operator_ref": operator_ref,
        "pins": pins,
        "binding": binding,
        "record": launch,
        "collector_path": str(collector_path),
        "driver_sha256": sha(driver),
        "image": launch["image"],
        "capture_root": str(capture_root),
    }


def unchanged(value):
    state = value["state"]
    need(
        F["validate"](
            state,
            value["config"],
            value["config_sha256"],
            state["out"],
            state["operator_ref"],
            Path(value["capture_root"]),
        ),
        "original gate returned/live identity changed",
    )
    for path, expected in value["pins"].items():
        need(B["fingerprint"](path) == expected, "export operator/evidence changed")
    need(
        sha(read(value["config"])) == value["config_sha256"], "original config changed"
    )


def native(fly, value, journal, label):
    state = value["state"]

    def observer(method, path, status, raw):
        save(
            journal / (label + ".wire.json"),
            {
                "method": method,
                "path": path,
                "status": status,
                "body_b64": base64.b64encode(raw).decode(),
                "sha256": sha(raw),
            },
        )

    current = fly.api(
        "GET", "/machines/" + state["machine_id"], timeout=20, observer=observer
    )
    need(
        all(
            current.get(key) == state["machine"].get(key)
            for key in ("id", "instance_id", "config", "name", "region")
        )
        and current["state"] == "started",
        "native controller incarnation changed",
    )


def remote(fly, value, journal, action, *, allow_pending=False):
    binding_sha = sha(
        json.dumps(value["binding"], sort_keys=True, allow_nan=False).encode()
    )
    payload = {
        "action": action,
        "machine": value["state"]["machine_id"],
        "source_ref": value["state"]["source_ref"],
        "launch_sha256": value["binding"]["launch_sha256"],
        "collector_sha256": value["record"]["collector_sha256"],
        "record": value["record"],
        "driver_sha256": value["driver_sha256"],
        "binding_sha256": binding_sha,
    }
    command = shlex.join(
        [
            "python3",
            "-S",
            "-c",
            "import sys,time;print('EXPORT_PHASE BOOTSTRAP_ENTERED '+str(time.monotonic_ns()),file=sys.stderr,flush=True)\nimport os;os.chdir('/')\n"
            + REMOTE,
            base64.b64encode(json.dumps(payload, sort_keys=True).encode()).decode(),
        ]
    )
    save(
        journal / (action + ".intent.json"),
        {"command_sha256": sha(command.encode()), "payload": payload},
    )
    rc, stdout, stderr = fly.flyctl(
        600 if action == "export" else 30,
        "ssh",
        "console",
        "-a",
        R["APP"],
        "--machine",
        value["state"]["machine_id"],
        "-C",
        command,
    )
    save(
        journal / (action + ".response.json"),
        {
            "exit_code": rc,
            "stdout": stdout,
            "stderr": stderr,
            "local_transport_joined": True,
        },
    )
    pending_exit = rc == 75 or (
        rc == 1
        and stderr.rstrip().endswith("Error: ssh shell: Process exited with status 75")
    )
    if allow_pending and action == "check" and pending_exit:
        pending = json.loads(stdout)
        need(
            pending.get("status") == "PENDING_WRITERS"
            and pending.get("machine") == value["state"]["machine_id"]
            and pending.get("launch_sha256") == value["binding"]["launch_sha256"]
            and isinstance(pending.get("non_hub_writers"), list)
            and pending["non_hub_writers"],
            "unverified read-only pending result",
        )
        return pending
    need(rc == 0, "canonical remote export/check failed; retain unknown invocation")
    result = json.loads(stdout)
    need(
        result["machine"] == value["state"]["machine_id"]
        and result["launch_sha256"] == value["binding"]["launch_sha256"]
        and result["non_hub_writers"] == [],
        "remote export proof differs",
    )
    return result


def verify_stage(value, stage):
    raw = read(value["collector_path"])
    namespace = {
        "__name__": "original_export_verify",
        "__file__": value["collector_path"],
        "CHECKED_COLLECTOR_SOURCE_BYTES": raw,
        "CHECKED_COLLECTOR_SHA256": sha(raw),
    }
    need(
        sha(raw) == value["record"]["collector_sha256"],
        "original verify collector differs",
    )
    namespace = runpy.run_path(value["collector_path"], init_globals=namespace)
    need(
        read(value["collector_path"]) == raw,
        "collector changed during verification setup",
    )
    expected = {
        name: file_sha(stage / name)
        for name in ("launch.json", "manifest.json", "originals.tar.gz")
    }
    namespace["verify"](
        SimpleNamespace(
            archive=stage / "originals.tar.gz",
            manifest=stage / "manifest.json",
            record=stage / "launch.json",
            caller=Path(value["state"]["out"]) / "export/caller.json",
            ref=value["state"]["source_ref"],
            image=value["image"],
            machine=value["state"]["machine_id"],
            app=R["APP"],
        )
    )
    need(
        expected == {name: file_sha(stage / name) for name in expected},
        "downloaded export changed during verify",
    )
    need(
        expected["launch.json"] == value["binding"]["launch_sha256"],
        "downloaded launch differs",
    )
    return expected


def preserve_drain(journal, evidence):
    need(
        evidence["root"] == "/tmp/gate/controller-host-custody/registered-orphan-drain",
        "foreign drain evidence root",
    )
    need(
        type(evidence["present"]) is bool
        and isinstance(evidence["files"], dict)
        and isinstance(evidence["directories"], list),
        "malformed drain evidence",
    )
    need(
        evidence["present"] or not evidence["files"] and not evidence["directories"],
        "absent drain has fabricated files",
    )
    root = journal / "registered-orphan-drain"
    root.mkdir(mode=0o700)
    total = 0
    for relative in sorted(
        evidence["directories"], key=lambda name: (len(Path(name).parts), name)
    ):
        path = Path(relative)
        need(
            not path.is_absolute() and path.parts and ".." not in path.parts,
            "unsafe drain directory",
        )
        (root / path).mkdir(mode=0o700)
    for relative, item in evidence["files"].items():
        path = Path(relative)
        need(
            not path.is_absolute() and path.parts and ".." not in path.parts,
            "unsafe drain file",
        )
        raw = base64.b64decode(item["body_b64"], validate=True)
        total += len(raw)
        need(
            total <= 16777216
            and len(raw) == item["bytes"]
            and sha(raw) == item["sha256"],
            "drain evidence bytes differ",
        )
        target = root / path
        need(
            target.parent.resolve(strict=True).is_relative_to(root),
            "drain parent alias",
        )
        fd = os.open(
            target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
        )
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    for directory in sorted(
        [root, *(path for path in root.rglob("*") if path.is_dir())],
        key=lambda path: len(path.parts),
        reverse=True,
    ):
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    save(journal / "registered-orphan-drain.manifest.json", evidence)


class ExportCancelled(BaseException):
    """Cancellation after the current owned transport joined; no next effect."""


def owned_operation(operation, value, fly):
    cancelled = []
    handlers = {
        sig: signal.signal(sig, lambda sig, _: cancelled.append(sig))
        for sig in (signal.SIGINT, signal.SIGTERM)
    }
    try:
        return operation(value, fly, cancelled)
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


def execute(value, fly=None):
    return owned_operation(_execute, value, fly)


def observe(value, fly=None):
    """An independently journaled read never spends the once-only export intent."""
    return owned_operation(_observe, value, fly)


def _observe(value, fly, cancelled):
    unchanged(value)
    out = Path(value["state"]["out"])
    journal = out / ("controller-export-observation-" + str(time.time_ns()))
    journal.mkdir(mode=0o700)
    fd = os.open(out, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    save(journal / "binding.json", value["binding"])

    def active():
        if cancelled:
            save(
                journal / "cancelled.json",
                {"signals": cancelled, "owned_transport_joined": True},
            )
            raise ExportCancelled("cancelled after read-only transport joined")

    active()
    fly = fly or runpy.run_path(str(HERE / "cloudbench-original-volume-capture.py"))[
        "Fly"
    ](R["APP"], F["selected_token"](value["state"]))
    active()
    native(fly, value, journal, "before")
    active()
    result = remote(fly, value, journal, "check", allow_pending=True)
    active()
    unchanged(value)
    ready = not result["non_hub_writers"]
    if ready:
        require_recorded_drain(
            value["binding"].get("orphan_drain"), result["drain_evidence"]
        )
    receipt = {
        "status": "EXPORT_READINESS_READY" if ready else "EXPORT_READINESS_PENDING",
        "journal": str(journal),
        "ready": ready,
        "non_hub_writer_count": len(result["non_hub_writers"]),
        "no_export_dispatch": True,
        "all_transports_joined": True,
    }
    save(journal / "complete.json", receipt)
    return receipt


def _execute(value, fly, cancelled):
    out = Path(value["state"]["out"])
    journal = out / "controller-export-recovery"

    def active():
        if cancelled:
            if journal.is_dir():
                save(
                    journal / "cancelled.json",
                    {
                        "signals": cancelled,
                        "owned_transport_joined": True,
                        "no_next_effect": True,
                    },
                )
            raise ExportCancelled("cancelled after current transport joined")

    active()
    unchanged(value)
    # An incomplete prior invocation is never authority to repeat remote export.
    journal.mkdir(mode=0o700)
    fd = os.open(out, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    save(journal / "intent.json", value["binding"])
    fly = fly or runpy.run_path(str(HERE / "cloudbench-original-volume-capture.py"))[
        "Fly"
    ](R["APP"], F["selected_token"](value["state"]))
    active()
    native(fly, value, journal, "before")
    active()
    checked = remote(fly, value, journal, "check")
    require_recorded_drain(
        value["binding"].get("orphan_drain"), checked["drain_evidence"]
    )
    active()
    unchanged(value)
    native(fly, value, journal, "pre-export")
    active()
    exported = remote(fly, value, journal, "export")
    require_recorded_drain(
        value["binding"].get("orphan_drain"), exported["drain_evidence"]
    )
    preserve_drain(journal, exported["drain_evidence"])
    active()
    remote_stage = exported["remote_stage"]
    expected_stage = (
        "/tmp/gate/controller-host-custody/export-resume-"
        + sha(json.dumps(value["binding"], sort_keys=True, allow_nan=False).encode())[
            :24
        ]
    )
    need(
        remote_stage == expected_stage and exported["canonical_export_exit"] == 0,
        "foreign remote staging",
    )
    stage = journal / "download"
    stage.mkdir(mode=0o700)
    for name in ("launch.json", "manifest.json", "originals.tar.gz"):
        active()
        rc, stdout, stderr = fly.flyctl(
            600,
            "ssh",
            "sftp",
            "get",
            "-a",
            R["APP"],
            "--machine",
            value["state"]["machine_id"],
            (
                "/tmp/gate/controller-host-custody/launch.json"
                if name == "launch.json"
                else remote_stage + "/" + name
            ),
            str(stage / name),
        )
        save(
            journal / (name + ".download.json"),
            {
                "exit_code": rc,
                "stdout": stdout,
                "stderr": stderr,
                "local_transport_joined": True,
            },
        )
        need(rc == 0, "download incomplete; retain staging and unknown invocation")
        os.chmod(stage / name, 0o600)
        active()
    unchanged(value)
    native(fly, value, journal, "after-download")
    active()
    hashes = verify_stage(value, stage)
    active()
    export = out / "export"
    for name, digest in hashes.items():
        target = export / name
        if target.exists() or target.is_symlink():
            need(
                file_sha(target) == digest,
                "existing partial export differs; never overwrite",
            )
        else:
            os.link(stage / name, target)
            (
                stage / name
            ).unlink()  # transfer ownership; canonical file remains single-linked
            fd = os.open(export, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    # No remote call or child may remain when this canonical marker appears.
    ready = [
        sys.executable,
        "-S",
        str(
            Path(value["state"]["source_root"])
            / "scripts/cloudbench-disposable-controller.py"
        ),
        "export-ready",
        "--authority",
        str(out / "authority.private.json"),
        "--root",
        value["state"]["source_root"],
        "--directory",
        str(export),
        "--machine",
        value["state"]["machine_id"],
        "--image",
        value["image"],
    ]
    save(
        journal / "export-ready.intent.json",
        {"argv": ready, "all_remote_helpers_joined": True, "hashes": hashes},
    )
    active()
    result = subprocess.run(
        ready, cwd="/", capture_output=True, timeout=180, check=False
    )
    save(
        journal / "export-ready.response.json",
        {
            "exit_code": result.returncode,
            "stdout_b64": base64.b64encode(result.stdout).decode(),
            "stderr_b64": base64.b64encode(result.stderr).decode(),
            "joined": True,
        },
    )
    need(result.returncode == 0, "canonical export-ready refused; preserve authority")
    verified = F["verified_export"](value["state"])
    save(
        journal / "complete.json",
        {
            "status": "EXPORT_VERIFIED",
            "marker_sha256": verified,
            "no_remote_use_after_marker": True,
            "controller_cleanup_owned_elsewhere": True,
        },
    )
    return {
        "status": "EXPORT_VERIFIED",
        "journal": str(journal),
        "marker_sha256": verified,
        "benchmark_success_inferred": False,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--run-directory", type=Path, required=True)
    parser.add_argument("--operator-ref", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--run", action="store_true")
    mode.add_argument(
        "--observe",
        action="store_true",
        help="One read-only remote readiness observation; no export dispatch.",
    )
    args = parser.parse_args(argv)
    value = check(
        args.config, args.config_sha256, args.run_directory, args.operator_ref
    )
    if args.check:
        print(
            json.dumps(
                {
                    "status": "LOCAL_EXPORT_RESUME_CHECKED",
                    "provider_calls": 0,
                    "binding": value["binding"],
                }
            )
        )
        return 0
    lock = os.open(
        Path(value["state"]["out"]) / "controller-export-recovery.lock",
        os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW,
        0o600,
    )
    try:
        info = os.fstat(lock)
        need(
            stat.S_ISREG(info.st_mode)
            and info.st_uid == os.geteuid()
            and info.st_nlink == 1
            and not info.st_mode & 0o077,
            "private exclusive export lock required",
        )
        # A readiness reader cannot overlap marker publication by another CLI.
        fcntl.flock(
            lock, (fcntl.LOCK_SH if args.observe else fcntl.LOCK_EX) | fcntl.LOCK_NB
        )
        if args.observe:
            result = observe(value)
            print(json.dumps(result))
            return 0 if result["ready"] else 75
        print(json.dumps(execute(value)))
    finally:
        os.close(lock)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
