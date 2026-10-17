#!/usr/bin/env python3
"""Signal only expired, registered fleet owners; canonical export remains authoritative."""

import argparse
import base64
import gzip
import json
import os
import runpy
import shlex
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
F = runpy.run_path(str(HERE / "cloudbench-controller-payload-finalization.py"))
B, R = F["B"], F["R"]
need, read, save, sha = (R[key] for key in ("need", "read", "save", "sha"))

GUEST = r"""
import hashlib,json,os,pwd,re,select,signal,socket,stat,subprocess,time
from pathlib import Path

def need(ok,message):
 if not ok:raise ValueError(message)
def digest(raw):return hashlib.sha256(raw).hexdigest()
def read(path,limit=16777216):
 p=Path(path);need(p.resolve(strict=True)==p,'physical evidence required')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,'rb') as f:
  a=os.fstat(f.fileno());need(stat.S_ISREG(a.st_mode) and a.st_nlink==1,'regular evidence required')
  raw=f.read(limit+1);b=os.fstat(f.fileno())
  need(len(raw)<=limit and (a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)==(b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns,b.st_ctime_ns),'evidence changed')
  return raw
def obj(path):return json.loads(read(path))
def save(path,value):
 raw=(json.dumps(value,sort_keys=True,allow_nan=False)+'\n').encode()
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
 fd=os.open(Path(path).parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
def process(pid,owner_uid=None):
 need(type(pid)is int and pid>1,'unsafe PID')
 p=Path('/proc')/str(pid);fields=(p/'stat').read_text().rsplit(') ',1)[1].split()
 birth='proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+fields[19]
 argv=(p/'cmdline').read_bytes();cwd=os.readlink(p/'cwd')
 status=dict(line.split(':',1) for line in (p/'status').read_text().splitlines() if ':' in line)
 target=os.geteuid() if owner_uid is None else owner_uid
 need([int(x) for x in status['Uid'].split()]==[target]*4 and p.stat().st_uid==target,'process UID differs')
 mask=1<<(signal.SIGTERM-1)
 need(not int(status['SigIgn'].strip(),16)&mask and int(status['SigCgt'].strip(),16)&mask,'TERM is not caught or is ignored')
 need(fields[0] not in ('Z','X'),'owner already exited')
 return dict(pid=pid,uid=target,birth=birth,cwd=cwd,argv_sha256=digest(argv),argv=argv.rstrip(b'\0').split(b'\0'))
def metadata(path):
 raw=read(path);rows=raw.decode().splitlines();value={}
 for line in rows:
  key,sep,item=line.partition('=');need(sep and key not in value,'invalid registry meta');value[key]=item
 return value,digest(raw)
def owner(path,repo,common,pending,ref):
 meta,msha=metadata(path/'meta');token=path.name
 need(re.fullmatch('[0-9a-f]{32}',token) and meta['version']=='2' and meta['fleet_owner_token']==token and meta['cleanup_policy']=='retain','invalid registry owner')
 need(meta['host']==socket.gethostname() and meta['workspace_root']==str(repo) and meta['runs_root']==str(repo/'.context/fleet/runs') and meta['app']=='navi-whisper-lux-bench','foreign registry')
 pid=int(meta['pid']);uid=(path/'meta').stat().st_uid
 need(uid==repo.stat().st_uid==ROSE_UID and os.geteuid() in (0,uid),'registry/executor UID differs')
 p=process(pid,uid)
 need(p['birth']==meta['pid_start'] and pending.get(pid)==p['birth'] and p['cwd']==str(repo),'owner identity differs')
 argv=[os.fsdecode(a) for a in p.pop('argv')]
 # Only the registered fleet controller, never its monitor/helper children.
 need(any(re.fullmatch(r'/tmp/cloudbench-fleet-self\.[A-Za-z0-9]+',a) or a==str(repo/'scripts/run-bench-fleet') for a in argv),'not fleet controller argv')
 audit=Path(meta['audit_dir']);need(audit==common/'cloudbench-fleet-audits'/token and audit.resolve(strict=True)==audit,'audit namespace differs')
 run=meta['run_id'];need(re.fullmatch('[0-9]{8}-[0-9]{6}-[0-9]+',run) and run.endswith('-'+str(pid)),'run/PID mismatch')
 need(meta['owned_ids_file']==str(audit/'owned-clones.ids') and meta['owned_names_file']==str(audit/'owned-clones.names'),'owned files differ')
 need(argv[:2]==['bash',str(repo/'scripts/run-bench-fleet')] and len(argv)>2 and '--foreground' in argv and '--strict-barrier' in argv,'unsupported fleet invocation')
 task=argv[2];taskref='570830dbf17635e13d16a6f03b4d705f6b6443b1'
 need('--ref' in argv and argv[argv.index('--ref')+1]==taskref,'task ref differs')
 need(FLEET_SHA==EXPECTED_FLEET_SHA,'fleet source differs')
 successor_path=repo/'.context/fleet/runs'/run/task/'archived-successor.json';successor_raw=read(successor_path);successor=json.loads(successor_raw)
 need(successor['controller_id']==os.environ['FLY_MACHINE_ID'] and successor['harness_ref']==ref and successor['task_ref']==taskref and successor['owner_token']==token and successor['run_id']==run and successor['task']==task and successor['ordinal']==0 and successor['campaign_total_jobs']==600 and successor['campaign_attempt']==1,'task successor differs')
 env=dict(item.split(b'=',1) for item in (Path('/proc')/str(pid)/'environ').read_bytes().split(b'\0') if b'=' in item)
 authority=json.loads(env[b'CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY']);seed=Path(os.fsdecode(env[b'CLOUDBENCH_CAMPAIGN_SEED_PROOF']))
 need(authority['source']['ref']==ref and str(seed.parent.parent.parent)==str(Path(authority['directory']).parent) and seed.name=='seed-proof.private.json' and re.fullmatch('c[0-9]{3}',seed.parent.name),'campaign source/cohort differs')
 cohort=json.loads(read(seed.parent/'manifest.json'));jobs=cohort['jobs'];need(cohort['cohort_id']==seed.parent.name and len(jobs)==600 and {int(k.split('-j')[1]) for k in jobs}==set(range(1,601)) and jobs[successor['campaign_job_id']]==pid,'campaign member differs')
 need(authority['owner']['parent_pid']==str(PARENT_PID),'campaign parent differs')
 manifest=path/'source-manifest.json';manifest_sha=None
 if 'source_manifest_sha256' in meta:
  manifest_sha=digest(read(manifest));need(manifest_sha==meta['source_manifest_sha256'],'source manifest differs')
 return dict(p,registry=str(path),meta_sha256=msha,source_manifest_sha256=manifest_sha,owner_token=token,run_id=run,source_ref=ref,successor_sha256=digest(successor_raw),fleet_source_sha256=FLEET_SHA,cohort_sha256=digest(read(seed.parent/'manifest.json')))

def prerequisites(v,repo=Path('/tmp/gate/repo'),custody=Path('/tmp/gate/controller-host-custody')):
 global PARENT_PID,FLEET_SHA,EXPECTED_FLEET_SHA,ROSE_UID
 os.chdir(repo)
 ROSE_UID=pwd.getpwnam('rose').pw_uid
 FLEET_SHA=digest(read(repo/'scripts/run-bench-fleet'));EXPECTED_FLEET_SHA=v['fleet_source_sha256'];need(FLEET_SHA==EXPECTED_FLEET_SHA,'fleet source differs')
 need(os.environ.get('FLY_MACHINE_ID')==v['machine'] and os.environ.get('GATE_REF')==v['source_ref'],'guest source/MID differs')
 need(time.time()>=v['deadline'],'original clock not expired')
 launch_raw=read(custody/'launch.json');launch=json.loads(launch_raw)
 pending=obj(custody/'pending.json')
 need(digest(launch_raw)==v['launch_sha256']==pending['record_sha256'] and pending['status']=='pending' and pending['reason']=='live controller writers','export is not pending for writers')
 need(launch['source_ref']==v['source_ref'] and launch['machine_id']==v['machine'],'launch source differs')
 driver=launch['driver_pid'];p=Path('/proc')/str(driver);fields=(p/'stat').read_text().rsplit(') ',1)[1].split()
 need('proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+fields[19]==launch['driver_birth'],'original export driver changed')
 joined=v['joined'];identity=joined['identity'];terminal=joined['terminal']
 need(identity['machine']==v['machine'] and identity['source_ref']==v['source_ref'] and identity['epoch']==v['epoch'] and terminal['parent_joined'] is True and terminal['supervisor_joined'] is True,'joined supervisor differs')
 parent=terminal['parent_pid'];PARENT_PID=parent;old=Path('/proc')/str(parent)
 if old.exists():
  fields=(old/'stat').read_text().rsplit(') ',1)[1].split()
  need(fields[0]=='Z','campaign parent remains live')
 command_raw=read(custody.parent/'controller-command.json');command=json.loads(command_raw);command_joined=obj(custody.parent/'controller-command.joined.json')
 need(command['machine_id']==v['machine'] and command['source_ref']==v['source_ref'] and command_joined['command_sha256']==digest(command_raw) and command_joined['driver_pid']==driver and command_joined['driver_birth']==launch['driver_birth'] and type(command_joined['exit_code'])is int,'command not joined by original driver')
 common=Path(launch['common_git']);need(common.resolve(strict=True)==common,'common Git alias')
 return repo,common,custody,pending

def execute(v):
 repo,common,custody,pending=prerequisites(v)
 journal=custody/'registered-orphan-drain';identity=v['identity_sha256'];action=v['action']
 if action=='observe':
  need(journal.is_dir(),'no drain invocation')
  intent=obj(journal/'intent.json');need(intent['identity_sha256']==identity,'foreign drain invocation')
  return dict(status='OBSERVED',intents=[p.name for p in journal.glob('term-*.json')],results=[obj(p) for p in journal.glob('result-*.json')],no_signal=True)
 if action=='plan':
  need(not journal.exists(),'drain invocation already exists; observe only')
  writers={r['pid']:r['birth'] for r in pending['writers']};targets=[];held=[]
  for path in sorted((common/'cloudbench-fleet-ownership').iterdir()):
   if not re.fullmatch('[0-9a-f]{32}',path.name):continue
   try:targets.append(owner(path,repo,common,writers,v['source_ref']))
   except (ValueError,KeyError,OSError) as e:held.append(dict(registry=path.name,reason=type(e).__name__))
  need(len({p['pid'] for p in targets})==len(targets),'duplicate owner PID')
  journal.mkdir(mode=0o700);save(journal/'intent.json',dict(identity_sha256=identity,guest_pid=os.getpid(),guest_birth=Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19],operator_ref=v['operator_ref']))
  plan=dict(targets=targets,held=held,launch_sha256=v['launch_sha256'],identity_sha256=identity)
  save(journal/'plan.json',plan)
  return dict(status='PLANNED',targets=len(targets),held=len(held),plan_sha256=digest(read(journal/'plan.json')))
 need(action=='signal','unknown drain action');plan=obj(journal/'plan.json')
 need(obj(journal/'intent.json')['identity_sha256']==identity==plan['identity_sha256'] and digest(read(journal/'plan.json'))==v['plan_sha256'],'drain plan differs')
 start=v['batch']*16;targets=plan['targets'][start:start+16];results=[]
 writers={r['pid']:r['birth'] for r in pending['writers']}
 for expected in targets:
  path=journal/('term-'+str(expected['pid'])+'.json')
  if path.exists():results.append(dict(pid=expected['pid'],state='INTENT_EXISTS_UNKNOWN_NO_REPLAY'));continue
  try:
   fd=os.pidfd_open(expected['pid'])
   try:
    current=owner(Path(expected['registry']),repo,common,writers,v['source_ref']);need(current==expected,'owner changed after plan')
    need(not select.select([fd],[],[],0)[0],'owner exited')
    save(path,dict(identity_sha256=identity,owner=expected,signal='SIGTERM'))
    executor_uid=os.geteuid()
    try:
     if executor_uid!=expected['uid']:os.seteuid(expected['uid'])
     need(os.geteuid()==expected['uid'],'signal executor UID differs')
     signal.pidfd_send_signal(fd,signal.SIGTERM)
    finally:
     if os.geteuid()!=executor_uid:os.seteuid(executor_uid)
    result=dict(pid=expected['pid'],state='TERM_SENT_NOT_JOINED')
   finally:os.close(fd)
  except (ValueError,KeyError,OSError) as e:result=dict(pid=expected['pid'],state='UNKNOWN_INTENT_NO_REPLAY' if path.exists() else 'HELD',reason=type(e).__name__)
  save(journal/('result-'+str(expected['pid'])+'.json'),result);results.append(result)
 return dict(status='BATCH_FINISHED',results=results,no_export_or_cleanup_claim=True)
"""


def command(payload):
    package = base64.b64encode(
        gzip.compress(json.dumps([GUEST, payload]).encode(), mtime=0)
    ).decode()
    loader = "import base64,gzip,json,sys;s,v=json.loads(gzip.decompress(base64.b64decode(sys.argv[1])));exec(s);print(json.dumps(execute(v),sort_keys=True))"
    body = {
        "cmd": shlex.join(["python3", "-S", "-c", loader, package]),
        "timeout": 18,
        "machine": True,
    }
    need(len(json.dumps(body).encode()) <= 16384, "bounded drain exec body required")
    return body


def local_state(args):
    out = args.run_directory.absolute()
    state = F["obj"](out / "payload-finalizer.identities.private.json")
    roots = {
        str(Path(p).parent.parent)
        for p in state["pins"]
        if Path(p).name == "cloudbench-controller-payload-finalization.py"
    }
    need(len(roots) == 1, "ambiguous captured source")
    F["validate"](
        state,
        args.config,
        args.config_sha256,
        out,
        state["operator_ref"],
        Path(roots.pop()),
    )
    need(time.time() >= state["deadline"], "original clock has not expired")
    names = (
        "cloudbench-controller-orphan-drain.py",
        "cloudbench-controller-payload-finalization.py",
        "cloudbench-original600-runner.py",
        "cloudbench-resume-controller-payload.py",
        "cloudbench-original-volume-capture.py",
    )
    hashes = {n: sha((HERE / n).read_bytes()) for n in names}
    pins = B["source_identity"](HERE.parent, args.operator_ref, hashes)
    journal = args.joined_journal.absolute()
    need(
        journal.parent == out and journal.resolve(strict=True) == journal,
        "exact prior joined journal required",
    )
    files = {p.name: sha(read(p)) for p in journal.iterdir()}
    requests = {}
    probe = {
        "machine": state["machine_id"],
        "source_ref": state["source_ref"],
        "epoch": state["epoch"],
        "identity_path": state["caller"]["identity_path"],
        "action": "PROBE",
    }
    expected = {
        "cmd": R["exec_command"](R["REMOTE_CONTROL"], probe),
        "timeout": 20,
        "machine": True,
    }
    for name in files:
        if name.endswith(".request.json"):
            value = F["obj"](journal / name)
            need(
                value
                == {
                    "method": "GET",
                    "path": "/machines/" + state["machine_id"],
                    "body": None,
                }
                or value
                == {
                    "method": "POST",
                    "path": "/machines/" + state["machine_id"] + "/exec",
                    "body": expected,
                },
                "prior journal contains effects",
            )
            requests[name.removesuffix(".request.json")] = value
    joined = F["prior_joined_probe"](state, journal, requests, files)
    need(joined is not None, "positive joined proof required")
    pending_raw = read(args.pending)
    pending = json.loads(pending_raw)
    need(
        pending["status"] == "pending"
        and pending["reason"] == "live controller writers",
        "pending writers proof required",
    )
    state["_drain"] = {
        "joined": joined,
        "launch_sha256": pending["record_sha256"],
        "source_hashes": hashes,
        "source_pins": pins,
        "joined_files": files,
        "joined_journal": str(journal),
        "pending_path": str(args.pending.absolute()),
        "pending_sha256": sha(pending_raw),
    }
    return state


def run(args, state):
    out = Path(state["out"]) / "registered-orphan-drain"
    payload = {
        "machine": state["machine_id"],
        "source_ref": state["source_ref"],
        "epoch": state["epoch"],
        "deadline": state["deadline"],
        "joined": state["_drain"]["joined"],
        "launch_sha256": state["_drain"]["launch_sha256"],
        "operator_ref": args.operator_ref,
    }
    payload["fleet_source_sha256"] = sha(
        subprocess.check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                state["source_root"],
                "show",
                state["source_ref"] + ":scripts/run-bench-fleet",
            ]
        )
    )
    payload["identity_sha256"] = sha(json.dumps(payload, sort_keys=True).encode())
    if args.observe:
        need(out.is_dir(), "no existing drain invocation")
        original = F["obj"](out / "intent.json")
        need(original["payload"] == payload, "observation invocation differs")
        out = out / ("observe-" + str(time.time_ns()))
        out.mkdir(mode=0o700)
    else:
        out.mkdir(mode=0o700)
        save(out / "intent.json", {"payload": payload, "operator": state["_drain"]})
    api = F["RecordedAPI"](F["api_for"](state), state, out)

    def call(action, **extra):
        checked = local_state(args)
        need(checked["_drain"] == state["_drain"], "drain local evidence changed")
        value = dict(payload, action=action, **extra)
        body = command(value)
        base = "/machines/" + state["machine_id"]
        current = api.request("GET", base, timeout=18)
        need(
            all(
                current.get(k) == state["machine"].get(k)
                for k in ("id", "instance_id", "config", "name", "region")
            ),
            "native controller changed",
        )
        response = api.request("POST", base + "/exec", body, timeout=18)
        need(
            response.get("exit_code") == 0
            and response.get("exit_signal", 0) == 0
            and response.get("stderr") in (None, ""),
            "drain exec uncertain; observe only",
        )
        result = json.loads(response["stdout"])
        save(out / ("result-" + str(time.time_ns()) + ".json"), result)
        return result

    if args.observe:
        return call("observe")
    plan = call("plan")
    for batch in range((plan["targets"] + 15) // 16):
        call("signal", batch=batch, plan_sha256=plan["plan_sha256"])
    return {
        "status": "REGISTERED_OWNER_TERMS_REQUESTED",
        "targets": plan["targets"],
        "no_release_claim": True,
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    modes = p.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--run", action="store_true")
    modes.add_argument("--observe", action="store_true")
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--config-sha256", required=True)
    p.add_argument("--run-directory", type=Path, required=True)
    p.add_argument("--operator-ref", required=True)
    p.add_argument("--joined-journal", type=Path, required=True)
    p.add_argument("--pending", type=Path, required=True)
    args = p.parse_args()
    os.umask(0o077)
    state = local_state(args)
    result = (
        {"status": "CHECKED", "provider_calls": 0} if args.check else run(args, state)
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
