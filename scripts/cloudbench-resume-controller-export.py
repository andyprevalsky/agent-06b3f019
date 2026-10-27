#!/usr/bin/env python3
"""Resume one closed controller export using its unchanged collector and authority."""

import argparse
import base64
import fcntl
import gzip
import json
import math
import os
import queue
import re
import runpy
import shlex
import signal
import stat
import subprocess
import sys
import threading
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
QUIESCENCE_RACES=('controller originals changed during export','original changed before export')

def resumable_pending(pending,record_sha):
 # Writer-shaped pending binds this launch; the collector's exception-shaped pending
 # (its main()) records only a refused snapshot race and grants nothing.
 return pending.get('status')=='pending'and(pending.get('record_sha256')==record_sha or(set(pending)=={'status','reason','resource_release_verified'}and pending['reason']in QUIESCENCE_RACES and pending['resource_release_verified']is False))

def bounded_export(scope,args,attempts=3,settle=10,sync=os.sync,sleep=time.sleep):
 races=[]
 for attempt in range(attempts):
  sync() # complete delayed allocation before the run's own strict snapshot
  try:return scope['export'](args),races
  except ValueError as error:
   # A refused snapshot published nothing; only the bounded settling race repeats.
   if str(error)not in QUIESCENCE_RACES or attempt==attempts-1 or args.archive.exists()or args.manifest.exists():raise
   races.append(str(error));sleep(settle)
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
 if v['action']=='canonical':
  # The original gate export completed (no pending); only its transfer was lost.
  assert not os.path.lexists(custody/'pending.json')and not os.path.lexists(custody/'export-resume.intent.json')
 else:
  _,pending_raw=scope['sealed_bytes'](custody/'pending.json',1048576);pending=json.loads(pending_raw)
  assert resumable_pending(pending,record_sha)
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
 if v['action']=='canonical':
  phase('VERIFY_START')
  scope['verify'](SimpleNamespace(record=record_path,archive=custody/'originals.tar.gz',manifest=custody/'manifest.json',caller=Path('/tmp/controller-host-caller.json'),ref=v['source_ref'],machine=v['machine'],app=record['app'],image=record['image'],repo=repo))
  phase('VERIFY_DONE')
  encoded=json.dumps(dict(result,remote_stage=str(custody),canonical_export_exit=0,drain_evidence=drain_evidence(scope)));phase('RESPONSE_READY');print(encoded);return
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
 code,races=bounded_export(scope,args)
 assert code==0,'canonical export still pending'
 phase('EXPORT_DONE')
 phase('VERIFY_START')
 scope['verify'](SimpleNamespace(record=record_path,archive=args.archive,manifest=args.manifest,caller=Path('/tmp/controller-host-caller.json'),ref=v['source_ref'],machine=v['machine'],app=record['app'],image=record['image'],repo=repo))
 phase('VERIFY_DONE')
 encoded=json.dumps(dict(result,remote_stage=str(stage),canonical_export_exit=code,quiescence_retries=races,drain_evidence=drain_evidence(scope)));phase('RESPONSE_READY');print(encoded)

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
        f"wire-{index:06d}.{suffix}.json" for index in (1, 2) for suffix in ("request", "raw", "decoded")
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
    digest = sha(json.dumps(files, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())
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
        all(payload[key] == pointer[key] for key in ("identity_sha256", "operator_ref", "launch_sha256")),
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
    for path in [directory, pointer_path, target, selected] + [directory / name for name in names]:
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
        intent["identity_sha256"] == plan["identity_sha256"] == binding["identity_sha256"]
        and intent["operator_ref"] == binding["operator_ref"]
        and plan["launch_sha256"] == binding["launch_sha256"]
        and files["plan.json"]["sha256"] == binding["plan_sha256"],
        "downloaded orphan drain differs from recorded plan",
    )
    if "relay" in binding:
        expected = binding["relay"]
        relay = decoded["relay-bootstrap/intent.json"]
        need(
            all(relay[key] == expected[key] for key in ("identity_sha256", "operator_ref", "launch_sha256"))
            and relay["owner"]["relay_directory"] == expected["relay_directory"],
            "downloaded relay intent differs from recorded invocation",
        )


CLEANUP_HOLD_ID = "w986k6vhvhm3sftz2y0a0tambs8ghw4d"
CLEANUP_HOLD_CREATED = 1792285350.425
CLEANUP_HOLD_DEADLINE = 1792286550.425
CLEANUP_ORIGINAL_EPOCH = 1792279176.5459259


def normal_clock(epoch, deadline, cleanup_deadline_epoch=None):
    need(
        type(epoch) in (int, float) and math.isfinite(epoch) and deadline == epoch + 5400 and 0 < epoch <= time.time(),
        "normal original clock changed",
    )
    if cleanup_deadline_epoch is None:
        need(time.time() < deadline, "normal original clock expired or changed")
        return deadline
    need(
        epoch == CLEANUP_ORIGINAL_EPOCH
        and type(cleanup_deadline_epoch) in (int, float)
        and math.isfinite(cleanup_deadline_epoch)
        and CLEANUP_HOLD_CREATED <= time.time() < cleanup_deadline_epoch <= CLEANUP_HOLD_DEADLINE,
        "cleanup-only hold expired or differs",
    )
    return cleanup_deadline_epoch


WINDOW_FIELDS = {
    "schema", "run_directory", "machine_id", "original_epoch", "created_at",
    "cleanup_deadline_epoch", "authorized_by", "reason", "benchmark_credit", "cleanup_only",
}
# A dead-owner window also names the exact lost runner owner and its coordinator.
DEAD_OWNER_WINDOW_FIELDS = WINDOW_FIELDS | {"dead_owner_pid", "dead_owner_birth", "coordinator_pid"}
MAX_CLEANUP_WINDOW_SECONDS = 3600


def cleanup_window_proof(path, out, now=None, dead_owner=False):
    """One explicit private cleanup window for one exact controller; zero credit."""
    raw = read(Path(path).absolute())
    window = json.loads(raw)
    now = time.time() if now is None else now
    numbers = [window.get(key) for key in ("original_epoch", "created_at", "cleanup_deadline_epoch")]
    schema, fields = (
        ("controller-export-dead-owner-window-v1", DEAD_OWNER_WINDOW_FIELDS)
        if dead_owner
        else ("controller-export-cleanup-window-v1", WINDOW_FIELDS)
    )
    need(
        isinstance(window, dict)
        and set(window) == fields
        and window["schema"] == schema
        and (
            not dead_owner
            or type(window["dead_owner_pid"]) is int
            and window["dead_owner_pid"] > 1
            and isinstance(window["dead_owner_birth"], str)
            and window["dead_owner_birth"]
            and type(window["coordinator_pid"]) is int
            and window["coordinator_pid"] > 1
        )
        and window["run_directory"] == str(out)
        and re.fullmatch("[0-9a-f]{14}", window["machine_id"] or "")
        and window["benchmark_credit"] == 0
        and window["cleanup_only"] is True
        and isinstance(window["authorized_by"], str) and window["authorized_by"]
        and isinstance(window["reason"], str) and window["reason"]
        and all(type(x) in (int, float) and math.isfinite(x) for x in numbers)
        and window["created_at"] <= now < window["cleanup_deadline_epoch"]
        <= window["created_at"] + MAX_CLEANUP_WINDOW_SECONDS,
        "explicit cleanup window refused or expired",
    )
    return window, sha(raw)


def transfer_budget(state, now=None):
    """One owned download may use the active authorized window, never past it."""
    end = state.get("cleanup_deadline_epoch") or state.get("deadline")
    if end is None:
        return 600
    remaining = end - (time.time() if now is None else now) - 60
    need(remaining >= 60, "authorized window too short for an owned download")
    return int(min(3600, remaining))


def process_gone(pid, recorded_birth, proc=Path("/proc")):
    """ABSENT, ZOMBIE or PID_REUSED when the exact recorded process no longer runs; None while it lives."""
    need(type(pid) is int and pid > 1 and isinstance(recorded_birth, str) and recorded_birth, "exact recorded process required")
    try:
        fields = (proc / str(pid) / "stat").read_text().rsplit(") ", 1)[1].split()
        boot = (proc / "sys/kernel/random/boot_id").read_text().strip()
    except FileNotFoundError:
        return "ABSENT"
    if "proc-start:" + boot + ":" + fields[19] != recorded_birth:
        return "PID_REUSED"
    return "ZOMBIE" if fields[0] in ("Z", "X") else None


def dead_owner_proof(caller, window, proc=Path("/proc")):
    """The run's own runner, its gate and its coordinator are all provably gone."""
    need(
        window["dead_owner_pid"] == caller["pid"] and window["dead_owner_birth"] == caller["birth"],
        "dead-owner window names another runner owner",
    )
    owner = process_gone(caller["pid"], caller["birth"], proc)
    gate = process_gone(caller["gate_pid"], caller["gate_birth"], proc)
    need(owner is not None, "runner owner is live; the live runner remains the cleanup owner")
    need(gate is not None, "original gate is live")
    # The coordinator recorded no birth: only an absent PID proves it gone.
    need(not (proc / str(window["coordinator_pid"])).exists(), "coordinator PID present; cannot prove it gone")
    return dict(
        pid=caller["pid"], birth=caller["birth"], owner_state=owner, gate_pid=caller["gate_pid"],
        gate_birth=caller["gate_birth"], gate_state=gate, coordinator_pid=window["coordinator_pid"],
        coordinator_state="ABSENT", successor="dead-runner-owner-recovery",
    )


def dead_owner_authority(disposable, path, root, caller):
    """The pinned helper's own authority check; its live-owner read accepts only the gone recorded runner."""
    scope = disposable["authority"].__globals__
    live = scope["birth"]

    def birth(pid):
        if pid != caller["pid"]:
            return live(pid)
        need(process_gone(pid, caller["birth"]) is not None, "runner owner is live; the live runner remains the cleanup owner")
        return caller["birth"]

    scope["birth"] = birth
    try:
        return disposable["authority"](path, root, fresh=False)
    finally:
        scope["birth"] = live


def normal_state(config, config_sha256, out, *, cleanup_deadline_epoch=None, cleanup_window=None, dead_owner=False):
    """Current normal owner proof; never a retrospective borrower capture."""
    need(
        not (out / "payload-borrow.intent.json").exists(),
        "borrowed owner requires original finalizer capture",
    )
    config_path = Path(config).absolute()
    need(sha(read(config_path)) == config_sha256, "normal config changed")
    cfg = obj(config_path)
    need(
        cfg.get("schema") == "original600-controller-runner-v1" and cfg.get("allowed") is True,
        "explicit original normal runner config required",
    )
    need(
        out.resolve(strict=True) == out and out.is_dir() and not out.stat().st_mode & 0o077,
        "private physical normal run required",
    )
    # Bind to this run's OWN recorded workload source, never to a remembered commit.
    need(re.fullmatch("[0-9a-f]{40}", cfg.get("source_ref") or ""), "exact normal workload source required")
    source_root = Path(cfg["source_root"])
    pins = B["source_identity"](source_root, cfg["source_ref"], cfg["source_files"])
    if "host_operator_provenance" not in cfg:
        return runner_owner_state(
            cfg, config_path, config_sha256, out, source_root, pins, cleanup_deadline_epoch, cleanup_window, dead_owner
        )
    need(cleanup_window is None and not dead_owner, "explicit cleanup window requires the live runner owner")
    provenance = cfg["host_operator_provenance"]
    host_ref = provenance["host_operator_source_ref"]
    need(
        re.fullmatch("[0-9a-f]{40}", host_ref or "")
        and provenance["workload_source_ref"] == cfg["source_ref"]
        and provenance["original_started_at_epoch"] == cfg["started_at_epoch"],
        "normal host provenance differs",
    )
    host_root = Path(provenance["incomplete_admission"]["source_root"])
    host_names = (
        "run-original600-controller.py",
        "cloudbench-original600-runner.py",
        "run-cloudbench-controller-gate",
    )
    host_hashes = {
        name: sha(
            subprocess.check_output(
                [
                    "git",
                    "--no-replace-objects",
                    "-C",
                    str(host_root),
                    "show",
                    host_ref + ":scripts/" + name,
                ]
            )
        )
        for name in host_names
    }
    need(
        host_hashes["cloudbench-original600-runner.py"] == provenance["host_runner_sha256"]
        and host_hashes["run-cloudbench-controller-gate"] == provenance["host_gate_sha256"],
        "normal host driver differs",
    )
    pins.update(B["source_identity"](host_root, host_ref, host_hashes))
    script = str(host_root / "scripts/run-original600-controller.py")

    def owner_ok(argv):
        return (
            script in argv
            and argv[argv.index(script) + 1 : argv.index(script) + 3] == ["--source-ref", host_ref]
            and "--resume-incomplete-admission" in argv
        )

    return normal_tail(cfg, config_path, config_sha256, out, source_root, pins, cleanup_deadline_epoch, R, owner_ok)


def runner_owner_state(
    cfg, config_path, config_sha256, out, source_root, pins, cleanup_deadline_epoch, cleanup_window, dead_owner=False
):
    """The run's own live original600 runner is the cleanup owner (sharded launches)."""
    script = source_root / "scripts/cloudbench-original600-runner.py"
    runner = runpy.run_path(str(script))
    need(sha(script.read_bytes()) == cfg["source_files"]["cloudbench-original600-runner.py"], "normal runner source differs")
    pending_path = out / "gate.pending.json"
    # A runner killed while its gate still waited never wrote the pending receipt.
    if not dead_owner or pending_path.exists():
        pending = obj(pending_path)
        need(
            pending.get("status") == "PENDING_EXTERNAL_OWNER_LIVE"
            and pending.get("export_verified") is False
            and pending.get("no_host_destroy") is True,
            "runner did not positively retain an unverified export",
        )
    if dead_owner:
        need(
            not any(os.path.lexists(out / name) for name in ("terminal.json", "cleanup.pending.json")),
            "dead runner already recorded a terminal or cleanup outcome",
        )

    def owner_ok(argv):
        return (
            len(argv) == 8
            and Path(argv[0]).name.startswith("python")
            and argv[1:]
            == [str(script), "--config", str(config_path), "--config-sha256", config_sha256, "--output", str(out)]
        )

    return normal_tail(
        cfg, config_path, config_sha256, out, source_root, pins, cleanup_deadline_epoch, runner, owner_ok, cleanup_window,
        dead_owner,
    )


def normal_tail(
    cfg, config_path, config_sha256, out, source_root, pins, cleanup_deadline_epoch, runner, owner_ok, cleanup_window=None,
    dead_owner=False,
):
    shard = [cfg["shard"]] if "shard" in cfg else []
    caller = obj(out / "caller.json")
    identity = obj(out / "controller.identity.json")
    authority_path = out / "authority.private.json"
    disposable = runpy.run_path(str(source_root / "scripts/cloudbench-disposable-controller.py"))
    if dead_owner:
        authority, authority_sha = dead_owner_authority(disposable, authority_path, source_root, caller)
    else:
        authority, authority_sha = disposable["authority"](authority_path, source_root, fresh=False)
    need(
        caller["source_ref"] == identity["source_ref"] == cfg["source_ref"]
        and caller["epoch"] == cfg["started_at_epoch"]
        and type(caller["epoch"]) in (int, float)
        and 0 < caller["epoch"] <= time.time()
        and caller["task_ref"] == runner["shard_task_ref"](cfg.get("shard"))
        and caller["deadline"] == caller["epoch"] + 5400
        and caller["authority_sha256"] == identity["authority_sha256"] == authority_sha
        and authority["cleanup_owner_pid"] == caller["pid"]
        and authority["cleanup_owner_birth"] == caller["birth"]
        and Path(authority["output_directory"]) == out / "export",
        "normal authority/caller differs",
    )
    need(not dead_owner or cleanup_window is not None, "dead-owner recovery requires an explicit cleanup window")
    if cleanup_window is None:
        normal_clock(caller["epoch"], caller["deadline"], cleanup_deadline_epoch)
    else:
        need(cleanup_deadline_epoch is None, "one cleanup authority only")
        window, window_sha = cleanup_window_proof(cleanup_window, out, dead_owner=dead_owner)
        need(
            window["machine_id"] == identity["machine"]
            and window["original_epoch"] == caller["epoch"]
            and caller["deadline"] == caller["epoch"] + 5400,
            "cleanup window binds another controller or clock",
        )
    template_path = Path(cfg["authority_template"])
    template = obj(template_path)
    need(
        authority
        == dict(
            template,
            cleanup_owner_pid=caller["pid"],
            cleanup_owner_birth=caller["birth"],
            output_directory=str(out / "export"),
        ),
        "normal authority differs from original template",
    )
    if dead_owner:
        owner = dead_owner_proof(caller, window)
    else:
        owner = B["process_identity"](caller["pid"])
        need(
            owner["birth"] == caller["birth"] and owner_ok(owner["argv"]),
            "normal live owner source differs",
        )
    need(not (Path("/proc") / str(caller["gate_pid"])).exists(), "normal gate not reaped")
    ownership_path = out / "export/disposable-controller.ownership.json"
    ownership = obj(ownership_path)
    workspace_path = out / "export/workspace-volume.ownership.json"
    workspace = obj(workspace_path)
    machine = ownership["machine"]
    need(
        ownership["authority_sha256"] == authority_sha
        and ownership["workspace_sha256"] == sha(read(workspace_path))
        and machine["id"] == identity["machine"]
        and machine["instance_id"] == identity["instance"]
        and isinstance(machine["config"], dict)
        and machine["id"] not in authority["protected_machines"]
        and ownership["volume"]["id"] == workspace["volume_id"]
        and workspace["volume_id"] not in authority["protected_volumes"],
        "normal sealed native ownership differs",
    )
    need(
        ownership.get("schema") == "cloudbench-disposable-controller-ownership-v1"
        and workspace.get("schema") == "cloudbench-controller-workspace-ownership-v1"
        and workspace["app"] == authority["app"] == R["APP"]
        and workspace["source_ref"] == cfg["source_ref"]
        and workspace["size_gb"] == 256
        and machine["region"] == authority["region"] == "iad"
        and machine["config"]["env"]["GATE_REF"] == cfg["source_ref"]
        and machine["config"]["guest"] == {"cpu_kind": "performance", "cpus": 8, "memory_mb": 32768}
        and len(machine["config"]["mounts"]) == 1
        and machine["config"]["mounts"][0].get("volume") == workspace["volume_id"]
        and machine["config"]["mounts"][0].get("path") == "/tmp/gate"
        and "@sha256:" in machine["config"]["image"]
        and ownership["volume"].get("attached_machine_id") == machine["id"]
        and ownership["volume"].get("auto_backup_enabled") is False,
        "normal fixed native/workspace profile differs",
    )
    envelope_path = out / "controller-launch-payload.private.json.gz"
    envelope_raw = read(envelope_path)
    envelope = json.loads(gzip.decompress(envelope_raw))
    tasks_path = Path(cfg["tasks_path"])
    tasks = obj(tasks_path)
    need(
        envelope["source_ref"] == cfg["source_ref"]
        and envelope["epoch"] == caller["epoch"]
        and envelope["tasks"] == tasks
        and envelope["campaign_argv"] == runner["campaign_argv"](tasks, caller["epoch"], *shard)
        and envelope.get("shard") == cfg.get("shard")
        and envelope["supervisor_sha256"] == cfg["source_files"]["cloudbench-original600-supervisor.py"]
        and caller["identity_path"] == "/tmp/gate/repo/.context/" + envelope["identity_name"],
        "normal sealed launch semantics differ",
    )
    sealed = [
        entry for entry in machine["config"]["files"] if entry["guest_path"] == "/tmp/controller-launch-payload.json.gz"
    ]
    need(
        len(sealed) == 1 and base64.b64decode(sealed[0]["raw_value"], validate=True) == envelope_raw,
        "normal native launch envelope differs",
    )
    for key, item in cfg.get("remote_env", {}).items():
        need(envelope["remote_env"].get(key) == item, "normal remote env differs")
    descriptor_path = out / "controller-sidecars.private.json"
    # Small launches carry their bound metadata inline; large ones use sidecars.
    descriptors = obj(descriptor_path) if descriptor_path.exists() else []
    by_sha = {row["sha256"]: row for row in descriptors}
    need(len(by_sha) == len(descriptors), "duplicate normal sidecar descriptor")
    sources = {row["relative_path"]: row for row in cfg["remote_files"]}
    need(
        len(sources) == len(cfg["remote_files"])
        and set(sources) == {row["relative_path"] for row in envelope["remote_files"]},
        "normal remote file membership differs",
    )
    inputs = {
        str(path): sha(read(path))
        for path in (
            config_path,
            out / "caller.json",
            out / "controller.identity.json",
            authority_path,
            template_path,
            ownership_path,
            workspace_path,
            envelope_path,
            tasks_path,
            *([descriptor_path] if descriptor_path.exists() else []),
        )
    }
    for item in envelope["remote_files"]:
        if not descriptor_path.exists():
            source = sources[item["relative_path"]]
            original = read(source["source_path"])
            need(
                item["encoding"] == "gzip-base64"
                and gzip.decompress(base64.b64decode(item["data"], validate=True)) == original
                and sha(original) == source["sha256"] == item["sha256"],
                "normal inline remote file differs",
            )
            inputs[source["source_path"]] = sha(original)
            continue
        need(
            item["encoding"] == "external-gzip" and item["transfer_sha256"] in by_sha,
            "normal sidecar envelope differs",
        )
        descriptor = by_sha[item["transfer_sha256"]]
        path = Path(descriptor["path"])
        need(
            path.parent == out and path.name == "controller-sidecar-" + descriptor["sha256"] + ".private.gz",
            "normal sidecar path differs",
        )
        data = read(path)
        source = sources[item["relative_path"]]
        original = read(source["source_path"])
        need(
            len(data) == descriptor["bytes"] == item["transfer_bytes"]
            and sha(data) == descriptor["sha256"]
            and gzip.decompress(data) == original
            and sha(original) == source["sha256"] == item["sha256"],
            "normal sidecar source/hash differs",
        )
        inputs[str(path)] = sha(data)
        inputs[source["source_path"]] = sha(original)
    for item in authority["env_files"].values():
        need(sha(read(item["path"])) == item["sha256"], "normal authority env changed")
        inputs[item["path"]] = item["sha256"]
    pins.update({path: B["fingerprint"](path) for path in inputs})
    state = dict(
        schema="controller-normal-export-identities-v1",
        config=str(config_path),
        config_sha256=config_sha256,
        out=str(out),
        source_root=str(source_root),
        source_ref=cfg["source_ref"],
        caller=caller,
        owner=owner,
        authority=authority,
        machine=machine,
        machine_id=machine["id"],
        epoch=caller["epoch"],
        deadline=caller["deadline"],
        pins=pins,
        inputs=inputs,
    )
    if cleanup_deadline_epoch is not None:
        state.update(cleanup_deadline_epoch=cleanup_deadline_epoch, cleanup_hold_id=CLEANUP_HOLD_ID, cleanup_only=True)
    if cleanup_window is not None:
        state.update(
            cleanup_deadline_epoch=window["cleanup_deadline_epoch"],
            cleanup_hold_id="window-sha256:" + window_sha,
            cleanup_only=True,
            cleanup_window=str(Path(cleanup_window).absolute()),
        )
    if dead_owner:
        state.update(dead_owner=True, export_directory=str(out / "export"))
    return F["normalized"](state)


def validate_normal(state):
    need(
        state["schema"] == "controller-normal-export-identities-v1",
        "unknown normal export proof",
    )
    if "cleanup_window" in state:
        window, window_sha = cleanup_window_proof(
            state["cleanup_window"], Path(state["out"]), dead_owner=state.get("dead_owner") is True
        )
        need(
            state.get("cleanup_hold_id") == "window-sha256:" + window_sha
            and state.get("cleanup_deadline_epoch") == window["cleanup_deadline_epoch"]
            and state.get("cleanup_only") is True
            and window["original_epoch"] == state["epoch"]
            and window["machine_id"] == state["machine_id"],
            "normal cleanup authority differs",
        )
    else:
        normal_clock(state["epoch"], state["deadline"], state.get("cleanup_deadline_epoch"))
    if "cleanup_deadline_epoch" in state and "cleanup_window" not in state:
        need(
            state.get("cleanup_hold_id") == CLEANUP_HOLD_ID and state.get("cleanup_only") is True,
            "normal cleanup authority differs",
        )
    if state.get("dead_owner") is True:
        need("cleanup_window" in state, "dead-owner recovery requires an explicit cleanup window")
        need(
            dead_owner_proof(state["caller"], window) == state["owner"],
            "dead-owner proof changed",
        )
    else:
        need(
            B["process_identity"](state["caller"]["pid"]) == state["owner"],
            "normal owner changed",
        )
    need(
        not (Path("/proc") / str(state["caller"]["gate_pid"])).exists(),
        "normal gate not reaped",
    )
    for path, expected in state["pins"].items():
        need(
            F["normalized"](B["fingerprint"](path)) == expected,
            "normal export evidence/source changed",
        )
    for path, expected in state["inputs"].items():
        need(sha(read(path)) == expected, "normal export input changed")
    return True


def check(
    config, config_sha256, run_directory, operator_ref, *, cleanup_deadline_epoch=None, cleanup_window=None,
    dead_owner=False,
):
    out = Path(run_directory).absolute()
    borrowed = (out / "payload-finalizer.identities.private.json").exists()
    if borrowed:
        need(
            cleanup_deadline_epoch is None and cleanup_window is None and not dead_owner,
            "cleanup-only window requires normal owner",
        )
        state = obj(out / "payload-finalizer.identities.private.json")
        roots = {
            str(Path(path).parent.parent)
            for path in state["pins"]
            if Path(path).name == "cloudbench-controller-payload-finalization.py"
        }
        need(len(roots) == 1, "unique captured finalizer source required")
        capture_root = Path(roots.pop())
        need(
            F["validate"](state, config, config_sha256, out, state["operator_ref"], capture_root),
            "original gate is not positively gone/reaped",
        )
    else:
        state = normal_state(
            config, config_sha256, out, cleanup_deadline_epoch=cleanup_deadline_epoch, cleanup_window=cleanup_window,
            dead_owner=dead_owner,
        )
        capture_root = HERE.parent
        validate_normal(state)
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
    if not borrowed:
        need(
            launch["image"] == state["machine"]["config"]["image"]
            and launch["workspace_ownership_sha256"] == sha(read(out / "export/workspace-volume.ownership.json")),
            "normal launch image/workspace differs",
        )
    log_path = out / "gate.private.log"
    log = read(log_path)
    if dead_owner:
        # The killed gate never reached its export result; it verified nothing.
        need(b"GATE_EXPORT_VERIFIED" not in log, "dead gate already verified an export")
    else:
        need(
            ("GATE_EXPORT_PENDING machine=" + state["machine_id"]).encode() in log and b"GATE_RESULT exit=" in log,
            "old gate did not positively return export pending",
        )
    drivers = [entry for entry in state["machine"]["config"]["files"] if entry["guest_path"] == "/tmp/gate.sh"]
    need(len(drivers) == 1, "exact sealed native driver required")
    driver = base64.b64decode(drivers[0]["raw_value"], validate=True)
    need(
        # Gates before PR #1560 idled forever after export; later ones idle until a
        # bounded GATE_EXPORT_IDLE_UNTIL (TIMEOUT_S + launch grace, or one recovery
        # hour after the result).
        (b"while :; do sleep 60; done" in driver or b"GATE_EXPORT_IDLE_UNTIL" in driver)
        and b"bound_controller_export export" in driver,
        "original idle-after-export driver contract required",
    )
    pins.update({str(path): B["fingerprint"](path) for path in (collector_path, launch_path, log_path)})
    binding = {
        "machine": state["machine_id"],
        "instance": state["machine"]["instance_id"],
        "config_sha256": config_sha256,
        "capture_sha256": sha(read(out / "payload-finalizer.identities.private.json"))
        if borrowed
        else sha(json.dumps(state, sort_keys=True, allow_nan=False).encode()),
        "launch_sha256": sha(launch_raw),
        "source_ref": state["source_ref"],
        "operator_ref": operator_ref,
        "operator_hashes": hashes,
        "original_epoch": state["epoch"],
        "original_deadline": state["deadline"],
    }
    if not borrowed:
        binding["capture_kind"] = "dead-runner-owner" if dead_owner else "normal-current-owner"
    if dead_owner:
        binding["dead_owner"] = state["owner"]
    if cleanup_deadline_epoch is not None or cleanup_window is not None:
        binding.update(
            cleanup_deadline_epoch=state["cleanup_deadline_epoch"],
            cleanup_hold_id=state["cleanup_hold_id"],
            cleanup_only=True,
        )
    binding["orphan_drain"] = local_drain_binding(out, pins)
    need(
        binding["orphan_drain"] is None or binding["orphan_drain"]["launch_sha256"] == binding["launch_sha256"],
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
    if state.get("schema") == "controller-normal-export-identities-v1":
        validate_normal(state)
    else:
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
    need(sha(read(value["config"])) == value["config_sha256"], "original config changed")


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

    current = fly.api("GET", "/machines/" + state["machine_id"], timeout=20, observer=observer)
    need(
        all(current.get(key) == state["machine"].get(key) for key in ("id", "instance_id", "config", "name", "region"))
        and current["state"] == "started",
        "native controller incarnation changed",
    )


def remote(fly, value, journal, action, *, allow_pending=False):
    binding_sha = sha(json.dumps(value["binding"], sort_keys=True, allow_nan=False).encode())
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
        600 if action in ("export", "canonical") else 30,
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
    pending_exit = rc == 75 or (rc == 1 and stderr.rstrip().endswith("Error: ssh shell: Process exited with status 75"))
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


def read_source(path):
    """Read a checked-in source file, which keeps its normal checkout mode.

    The private-input reader (owner-only mode, single link) is for private
    receipts; a collector checked out under umask 022 is 0644 and is instead
    bound by the physical path and the launch record's collector SHA-256.
    Group- or world-writable files are refused: another writer could swap the
    bytes between the hash check and use. Callers execute the returned bytes,
    never the path.
    """
    path = Path(path).absolute()
    need(path.resolve(strict=True) == path, "physical collector source required")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as handle:
        info = os.fstat(handle.fileno())
        need(
            stat.S_ISREG(info.st_mode)
            and info.st_uid == os.geteuid()
            and not info.st_mode & 0o022
            and info.st_size < 16 * 1024 * 1024,
            "regular current-owner collector source required",
        )
        return handle.read(info.st_size + 1)


def verify_stage(value, stage):
    raw = read_source(value["collector_path"])
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
    exec(compile(raw, value["collector_path"], "exec"), namespace)  # the hashed bytes, never a re-read
    need(
        read_source(value["collector_path"]) == raw,
        "collector changed during verification setup",
    )
    expected = {name: file_sha(stage / name) for name in ("launch.json", "manifest.json", "originals.tar.gz")}
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
    for relative in sorted(evidence["directories"], key=lambda name: (len(Path(name).parts), name)):
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
            total <= 16777216 and len(raw) == item["bytes"] and sha(raw) == item["sha256"],
            "drain evidence bytes differ",
        )
        target = root / path
        need(
            target.parent.resolve(strict=True).is_relative_to(root),
            "drain parent alias",
        )
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
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
        sig: signal.signal(sig, lambda sig, _: cancelled.append(sig)) for sig in (signal.SIGINT, signal.SIGTERM)
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
    if value["state"].get("schema") == "controller-normal-export-identities-v1":
        save(journal / "normal-owner-proof.private.json", value["state"])
    save(journal / "binding.json", value["binding"])

    def active():
        if cancelled:
            save(
                journal / "cancelled.json",
                {"signals": cancelled, "owned_transport_joined": True},
            )
            raise ExportCancelled("cancelled after read-only transport joined")

    active()
    fly = fly or runpy.run_path(str(HERE / "cloudbench-original-volume-capture.py"))["Fly"](
        R["APP"], F["selected_token"](value["state"])
    )
    active()
    native(fly, value, journal, "before")
    active()
    result = remote(fly, value, journal, "check", allow_pending=True)
    active()
    unchanged(value)
    ready = not result["non_hub_writers"]
    if ready:
        require_recorded_drain(value["binding"].get("orphan_drain"), result["drain_evidence"])
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
    need(not (out / "controller-export-download").exists(), "download recovery already owns this run")
    # An incomplete prior invocation is never authority to repeat remote export.
    journal.mkdir(mode=0o700)
    fd = os.open(out, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    if value["state"].get("schema") == "controller-normal-export-identities-v1":
        save(journal / "normal-owner-proof.private.json", value["state"])
    save(journal / "intent.json", value["binding"])
    fly = fly or runpy.run_path(str(HERE / "cloudbench-original-volume-capture.py"))["Fly"](
        R["APP"], F["selected_token"](value["state"])
    )
    active()
    native(fly, value, journal, "before")
    active()
    checked = remote(fly, value, journal, "check")
    require_recorded_drain(value["binding"].get("orphan_drain"), checked["drain_evidence"])
    active()
    unchanged(value)
    native(fly, value, journal, "pre-export")
    active()
    exported = remote(fly, value, journal, "export")
    require_recorded_drain(value["binding"].get("orphan_drain"), exported["drain_evidence"])
    preserve_drain(journal, exported["drain_evidence"])
    active()
    remote_stage = exported["remote_stage"]
    expected_stage = (
        "/tmp/gate/controller-host-custody/export-resume-"
        + sha(json.dumps(value["binding"], sort_keys=True, allow_nan=False).encode())[:24]
    )
    need(
        remote_stage == expected_stage and exported["canonical_export_exit"] == 0,
        "foreign remote staging",
    )
    return publish(value, fly, journal, remote_stage, active)


DOWNLOAD_ATTEMPTS = 3


STREAM_BLOCK_BYTES = 16 * 1024 * 1024


def stream_get(fly, seconds, machine_id, remote_path, target):
    """One owned guest read streamed into a new private file with 16 MiB writes.

    `flyctl ssh sftp get` issues 32 KiB writes, which a FUSE run directory absorbed at
    under 2 MB/s (SAME60 2026-10-22: a 4.9 GB archive missed its one-hour window). A
    pty-free `cat` keeps network backpressure, needs no local staging, and fsyncs once.
    The timeout kills only this owned child."""
    need(type(seconds) is int and seconds > 0, "invalid stream budget")
    argv = [fly.binary, "ssh", "console", "-a", R["APP"], "--machine", machine_id,
            "-C", "cat -- " + shlex.quote(remote_path)]
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        process = subprocess.Popen(argv, env=fly.env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except BaseException:
        os.close(fd)
        raise
    blocks, errors, stderr, expired = queue.Queue(maxsize=2), [], [], []

    def drain_stderr():
        stderr.append(process.stderr.read(65536))
        while process.stderr.read(65536):
            pass

    def write_blocks():
        try:
            while (block := blocks.get()) is not None:
                view = memoryview(block)
                while view:
                    view = view[os.write(fd, view):]
        except BaseException as error:
            errors.append(error)
            while blocks.get() is not None:  # keep the reader unblocked; nothing more is written
                pass

    def expire():
        expired.append(True)
        process.kill()

    threads = [threading.Thread(target=drain_stderr, daemon=True), threading.Thread(target=write_blocks, daemon=True)]
    for thread in threads:
        thread.start()
    timer = threading.Timer(seconds, expire)
    timer.start()
    written = 0
    try:
        while block := process.stdout.read(STREAM_BLOCK_BYTES):
            blocks.put(block)
            written += len(block)
    finally:
        blocks.put(None)
        threads[1].join()
        rc = process.wait()
        timer.cancel()
        threads[0].join(timeout=10)
        process.stdout.close()
        process.stderr.close()
        try:
            if not errors and not expired:
                os.fsync(fd)
        finally:
            os.close(fd)
    message = (stderr[0] if stderr else b"").decode("utf-8", "replace")
    if expired:
        return 124, "stream timed out after %d bytes" % written, message
    if errors:
        return 74, "local write failed after %d bytes: %s" % (written, type(errors[0]).__name__), message
    return rc, "streamed %d bytes" % written, message


def publish(value, fly, journal, remote_stage, active):
    """Download, verify with the run's own collector and mark only via export-ready."""
    out = Path(value["state"]["out"])
    stage = journal / "download"
    stage.mkdir(mode=0o700)
    for name in ("launch.json", "manifest.json", "originals.tar.gz"):
        for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
            active()
            rc, stdout, stderr = stream_get(
                fly,
                transfer_budget(value["state"]),
                value["state"]["machine_id"],
                ("/tmp/gate/controller-host-custody/launch.json" if name == "launch.json" else remote_stage + "/" + name),
                stage / name,
            )
            save(
                journal / (name + (".download.json" if attempt == 1 else ".download-%d.json" % attempt)),
                {
                    "attempt": attempt,
                    "exit_code": rc,
                    "stdout": stdout,
                    "stderr": stderr,
                    "local_transport_joined": True,
                },
            )
            if rc == 0 and (stage / name).is_file() and not (stage / name).is_symlink():
                break
            # The private staging file did not exist before this owned attempt.
            if os.path.lexists(stage / name):
                (stage / name).unlink()
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
            (stage / name).unlink()  # transfer ownership; canonical file remains single-linked
            fd = os.open(export, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    # No remote call or child may remain when this canonical marker appears.
    ready = [
        sys.executable,
        "-S",
        str(Path(value["state"]["source_root"]) / "scripts/cloudbench-disposable-controller.py"),
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
    if value["state"].get("dead_owner") is True:
        ready = dead_owner_helper_argv(value["state"], ready[2:])
    save(
        journal / "export-ready.intent.json",
        {"argv": ready, "all_remote_helpers_joined": True, "hashes": hashes},
    )
    active()
    result = subprocess.run(ready, cwd="/", capture_output=True, timeout=180, check=False)
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
            "controller_cleanup_owned_elsewhere": value["state"].get("dead_owner") is not True,
        },
    )
    return {
        "status": "EXPORT_VERIFIED",
        "journal": str(journal),
        "marker_sha256": verified,
        "benchmark_success_inferred": False,
    }


# The run's own pinned disposable helper, unchanged, with exactly one substitution:
# its live-owner check accepts the bound cleanup owner only after re-proving that
# exact PID/birth is gone. Every other authority, source and native check runs.
DEAD_OWNER_HELPER = r"""
import base64,hashlib,json,subprocess,sys
from pathlib import Path
spec=json.loads(base64.b64decode(sys.argv[1]));argv=sys.argv[2:]
root=Path(spec['root']);helper=root/'scripts/cloudbench-disposable-controller.py'
assert argv[0]==str(helper) and argv[1] in ('export-ready','cleanup'),'dead-owner helper action refused'
expected=subprocess.check_output(['git','--no-replace-objects','-C',str(root),'show',spec['source_ref']+':scripts/cloudbench-disposable-controller.py'])
assert helper.read_bytes()==expected and hashlib.sha256(expected).hexdigest()==spec['helper_sha256'],'pinned helper differs'
scope={'__name__':'dead_owner_disposable_controller','__file__':str(helper)}
exec(compile(expected,str(helper),'exec'),scope)
live=scope['birth']
def gone(pid,recorded):
 try:
  fields=Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()
  boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
 except FileNotFoundError:return True
 return 'proc-start:'+boot+':'+fields[19]!=recorded or fields[0] in ('Z','X')
def birth(pid):
 if pid!=spec['owner_pid']:return live(pid)
 if not gone(pid,spec['owner_birth']):raise ValueError('cleanup owner is live; dead-owner recovery refused')
 return spec['owner_birth']
scope['birth']=birth
sys.argv=argv
scope['main']()
"""


def dead_owner_helper_argv(state, argv):
    """The exact argv the runner would run, executed through the pinned dead-owner shim."""
    root = Path(state["source_root"])
    helper = root / "scripts/cloudbench-disposable-controller.py"
    need(Path(argv[0]) == helper and argv[1] in ("export-ready", "cleanup"), "dead-owner helper action refused")
    owner = state["owner"]
    need(
        state["authority"]["cleanup_owner_pid"] == owner["pid"]
        and state["authority"]["cleanup_owner_birth"] == owner["birth"],
        "dead owner differs from authority",
    )
    spec = {
        "root": str(root),
        "source_ref": state["source_ref"],
        "helper_sha256": sha(
            subprocess.check_output(
                [
                    "git",
                    "--no-replace-objects",
                    "-C",
                    str(root),
                    "show",
                    state["source_ref"] + ":scripts/cloudbench-disposable-controller.py",
                ]
            )
        ),
        "owner_pid": owner["pid"],
        "owner_birth": owner["birth"],
    }
    encoded = base64.b64encode(json.dumps(spec, sort_keys=True).encode()).decode()
    return [sys.executable, "-S", "-c", DEAD_OWNER_HELPER, encoded, *map(str, argv)]


def fetch_launch(state, fly=None):
    """One owned read of the remote launch record into export/, as the gate's first download.

    A dead gate never reached its downloads. A live runner's joined gate can also return
    export-pending without the record, e.g. when its watchdog expired across a host suspend."""
    dead = state.get("dead_owner") is True
    validate_normal(state)
    out = Path(state["out"])
    export = out / "export"
    if not dead:
        log = read(out / "gate.private.log")
        need(
            ("GATE_EXPORT_PENDING machine=" + state["machine_id"]).encode() in log and b"GATE_RESULT exit=" in log,
            "live gate did not positively return export pending",
        )
    target = export / "launch.json"
    need(not os.path.lexists(target), "export launch record already present")
    need(not (export / "disposable-export.verified.json").exists(), "export already verified")
    journal = out / ("dead-owner-launch-fetch" if dead else "live-owner-launch-fetch")
    journal.mkdir(mode=0o700)  # once only
    save(journal / "intent.json", {"machine": state["machine_id"], "source_ref": state["source_ref"]})
    fly = fly or runpy.run_path(str(HERE / "cloudbench-original-volume-capture.py"))["Fly"](
        R["APP"], F["selected_token"](state)
    )
    native(fly, {"state": state}, journal, "before")
    staged = journal / "launch.json"
    rc, stdout, stderr = fly.flyctl(
        transfer_budget(state),
        "ssh",
        "sftp",
        "get",
        "-a",
        R["APP"],
        "--machine",
        state["machine_id"],
        "/tmp/gate/controller-host-custody/launch.json",
        str(staged),
    )
    save(
        journal / "launch.json.download.json",
        {"exit_code": rc, "stdout": stdout, "stderr": stderr, "local_transport_joined": True},
    )
    need(rc == 0 and staged.is_file() and not staged.is_symlink(), "launch download incomplete")
    os.chmod(staged, 0o600)
    raw = read(staged)
    launch = json.loads(raw)
    root = Path(state["source_root"])
    collector = subprocess.check_output(
        [
            "git",
            "--no-replace-objects",
            "-C",
            str(root),
            "show",
            state["source_ref"] + ":scripts/cloudbench-controller-export.py",
        ]
    )
    need(
        launch["machine_id"] == state["machine_id"]
        and launch["source_ref"] == state["source_ref"]
        and launch["collector_sha256"] == sha(collector)
        and launch["image"] == state["machine"]["config"]["image"]
        and launch["caller"] == obj(export / "caller.json")
        and launch["caller"]["pid"] == state["caller"]["gate_pid"]
        and launch["caller"]["birth"] == state["caller"]["gate_birth"]
        and launch["workspace_ownership_sha256"] == sha(read(export / "workspace-volume.ownership.json")),
        "remote launch record differs from this run",
    )
    validate_normal(state)
    os.link(staged, target)
    staged.unlink()  # canonical file remains single-linked
    for directory in (export, journal):
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    receipt = {"status": "LAUNCH_RECORD_FETCHED", "launch_sha256": sha(raw), "benchmark_credit": 0}
    save(journal / "complete.json", receipt)
    return receipt


def native_release(fly, machine_id, volume_id):
    """Independent post-cleanup native reads: no controller Machine or live workspace remains."""
    not_found = runpy.run_path(str(HERE / "cloudbench-original-volume-capture.py"))["NotFound"]

    def current(path):
        try:
            return fly.api("GET", path, timeout=20)
        except not_found:
            return None

    machine = current("/machines/" + machine_id)
    volume = current("/volumes/" + volume_id)
    need(
        (machine is None or machine.get("id") == machine_id and machine.get("state") == "destroyed")
        and (volume is None or volume.get("id") == volume_id and volume.get("state") in ("pending_destroy", "destroyed")),
        "native release not verified",
    )
    return {
        "machine_id": machine_id,
        "machine_state": "ABSENT" if machine is None else machine["state"],
        "volume_id": volume_id,
        "volume_state": "ABSENT" if volume is None else volume["state"],
        "observed_at": time.time(),
    }


def release_dead_owner(state, fly=None):
    """After the verified export: the runner's own cleanup call, then its reconciliation."""
    need(state.get("dead_owner") is True, "release is dead-owner recovery only")
    validate_normal(state)
    out = Path(state["out"])
    export = out / "export"
    root = Path(state["source_root"])
    need(
        not any(os.path.lexists(out / name) for name in ("cleanup-call.intent.json", "terminal.json")),
        "controller cleanup already dispatched",
    )
    marker = F["verified_export"](state)
    journal = out / "dead-owner-release"
    journal.mkdir(mode=0o700)  # once only; the helper's own intents latch deletion
    save(journal / "dead-owner-proof.private.json", state["owner"])
    runner = runpy.run_path(str(root / "scripts/cloudbench-original600-runner.py"))
    fly = fly or runpy.run_path(str(HERE / "cloudbench-original-volume-capture.py"))["Fly"](
        R["APP"], F["selected_token"](state)
    )
    native(fly, {"state": state}, journal, "before")
    caller = state["caller"]
    payload = dict(
        machine=state["machine_id"],
        source_ref=state["source_ref"],
        epoch=caller["epoch"],
        identity_path=caller["identity_path"],
        action="PROBE",
    )
    probe = runner["machine_control"](fly, state["machine_id"], payload)
    save(journal / "supervisor-probe.json", probe)
    need(probe.get("state") == "JOINED", "supervisor not joined; no controller cleanup")
    validate_normal(state)
    verified = export / "disposable-export.verified.json"
    save(
        out / "cleanup-call.intent.json",
        dict(
            machine=state["machine_id"],
            action="cleanup",
            gate_joined=True,
            supervisor_joined=True,
            export_verified_file=sha(read(verified)),
            dead_owner_recovery=str(journal),
        ),
    )
    argv = dead_owner_helper_argv(
        state,
        [
            str(root / "scripts/cloudbench-disposable-controller.py"),
            "cleanup",
            "--authority",
            str(out / "authority.private.json"),
            "--root",
            str(root),
            "--directory",
            str(export),
            "--workspace",
            str(export / "workspace-volume.ownership.json"),
        ],
    )
    save(journal / "cleanup.intent.json", {"argv": argv})
    env = dict(os.environ, FLY_API_TOKEN=F["selected_token"](state))
    result = subprocess.run(argv, cwd=str(root), env=env, capture_output=True, timeout=240, check=False)
    save(
        journal / "cleanup.response.json",
        {
            "exit_code": result.returncode,
            "stdout_b64": base64.b64encode(result.stdout).decode(),
            "stderr_b64": base64.b64encode(result.stderr).decode(),
            "joined": True,
        },
    )
    if not (export / "disposable-controller.release.json").exists():
        save(out / "cleanup.pending.json", dict(status="PENDING_DEAD_OWNER_RECOVERY", helper_exit_code=result.returncode, no_cleanup_retry=True))
        raise ValueError("controller cleanup produced no release; GET-only reconciliation required")
    release = runner["reconciled_release"](
        out, export, out / "authority.private.json", state["machine_id"], "cleanup", True, probe
    )
    after = native_release(fly, state["machine_id"], release["volume_id"])
    save(journal / "native-after.json", after)
    terminal = dict(
        status="DEAD_OWNER_CONTROLLER_RELEASE_VERIFIED",
        gate_exit_code=None,
        controller_cleanup_exit_code=result.returncode,
        externally_reconciled_after_helper_failure=result.returncode != 0,
        machine=state["machine_id"],
        source_ref=state["source_ref"],
        started_at_epoch=state["epoch"],
        original_deadline=state["deadline"],
        release=release,
        export_marker_sha256=marker,
        dead_owner=state["owner"],
        recovery_journal=str(journal),
        benchmark_credit=0,
        benchmark_success_inferred=False,
    )
    save(out / "terminal.json", terminal)
    return terminal


def download_verified(value, fly=None):
    """The original gate export completed remotely; only its transfer is recovered."""
    return owned_operation(_download_verified, value, fly)


def _download_verified(value, fly, cancelled):
    out = Path(value["state"]["out"])
    journal = out / "controller-export-download"

    def active():
        if cancelled:
            if journal.is_dir():
                save(journal / "cancelled.json", {"signals": cancelled, "owned_transport_joined": True, "no_next_effect": True})
            raise ExportCancelled("cancelled after current transport joined")

    active()
    unchanged(value)
    need(not (out / "controller-export-recovery").exists(), "export recovery already owns this run")
    log = read(out / "gate.private.log")
    if value["state"].get("dead_owner") is True:
        # check() proved the killed gate verified nothing; the remote canonical check binds the export.
        need(b"GATE_EXPORT_VERIFIED" not in log, "dead gate already verified an export")
    else:
        need(b"GATE_EXPORT_PENDING machine=" + value["state"]["machine_id"].encode() in log, "gate did not retain the export")
    journal.mkdir(mode=0o700)  # one owned download recovery; never replayed
    fd = os.open(out, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    if value["state"].get("schema") == "controller-normal-export-identities-v1":
        save(journal / "normal-owner-proof.private.json", value["state"])
    save(journal / "intent.json", value["binding"])
    fly = fly or runpy.run_path(str(HERE / "cloudbench-original-volume-capture.py"))["Fly"](
        R["APP"], F["selected_token"](value["state"])
    )
    active()
    native(fly, value, journal, "before")
    active()
    checked = remote(fly, value, journal, "canonical")
    require_recorded_drain(value["binding"].get("orphan_drain"), checked["drain_evidence"])
    need(
        checked["remote_stage"] == "/tmp/gate/controller-host-custody" and checked["canonical_export_exit"] == 0,
        "foreign canonical custody",
    )
    active()
    return publish(value, fly, journal, checked["remote_stage"], active)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--run-directory", type=Path, required=True)
    parser.add_argument("--operator-ref", required=True)
    parser.add_argument("--cleanup-deadline-epoch", type=float)
    parser.add_argument("--cleanup-window", type=Path, help="Explicit private post-deadline cleanup window.")
    parser.add_argument(
        "--dead-owner",
        action="store_true",
        help="The run's runner, gate and coordinator are provably gone; requires a dead-owner --cleanup-window.",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--run", action="store_true")
    mode.add_argument(
        "--download-verified",
        action="store_true",
        help="Recover only the transfer of an export the original gate completed.",
    )
    mode.add_argument(
        "--observe",
        action="store_true",
        help="One read-only remote readiness observation; no export dispatch.",
    )
    mode.add_argument(
        "--fetch-launch",
        action="store_true",
        help="Fetch the remote launch record a dead gate, or a live owner's export-pending gate, never downloaded.",
    )
    mode.add_argument(
        "--release",
        action="store_true",
        help="Dead owner only: after the verified export, run the runner's own controller cleanup.",
    )
    args = parser.parse_args(argv)
    need(not args.release or args.dead_owner, "--release requires --dead-owner")
    if args.fetch_launch or args.release:
        if args.dead_owner:
            need(args.cleanup_window is not None and args.cleanup_deadline_epoch is None, "dead-owner window required")
        state = normal_state(
            args.config, args.config_sha256, Path(args.run_directory).absolute(),
            cleanup_window=args.cleanup_window, dead_owner=args.dead_owner,
            **({"cleanup_deadline_epoch": args.cleanup_deadline_epoch} if args.cleanup_deadline_epoch is not None else {}),
        )
        lock = os.open(
            Path(state["out"]) / "controller-export-recovery.lock",
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
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print(json.dumps(fetch_launch(state) if args.fetch_launch else release_dead_owner(state)))
        finally:
            os.close(lock)
        return 0
    value = check(
        args.config,
        args.config_sha256,
        args.run_directory,
        args.operator_ref,
        **({"cleanup_deadline_epoch": args.cleanup_deadline_epoch} if args.cleanup_deadline_epoch is not None else {}),
        **({"cleanup_window": args.cleanup_window} if args.cleanup_window is not None else {}),
        **({"dead_owner": True} if args.dead_owner else {}),
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
        fcntl.flock(lock, (fcntl.LOCK_SH if args.observe else fcntl.LOCK_EX) | fcntl.LOCK_NB)
        if args.observe:
            result = observe(value)
            print(json.dumps(result))
            return 0 if result["ready"] else 75
        print(json.dumps(download_verified(value) if args.download_verified else execute(value)))
    finally:
        os.close(lock)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
