#!/usr/bin/env python3
"""Retire only a sealed, route-free orphan relay bootstrap; never its agent."""

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
D = runpy.run_path(str(HERE / "cloudbench-controller-orphan-drain.py"))
F, B, R = D["F"], D["B"], D["R"]
need, read, save, sha = (R[k] for k in ("need", "read", "save", "sha"))

RELAY = r"""
import base64
def stamp(pid):
 p=Path('/proc')/str(pid)
 try:
  fields=(p/'stat').read_text().rsplit(') ',1)[1].split()
 except FileNotFoundError:return None
 return ('proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+fields[19],fields[0])
def gone(pid,birth):
 current=stamp(pid)
 return current is None or current[0]!=birth or current[1]in('Z','X')
def private(path,uid):
 before=Path(path).lstat();raw=read(path);s=Path(path).lstat()
 need((before.st_dev,before.st_ino,before.st_mode,before.st_uid,before.st_gid,before.st_nlink,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns),'relay evidence changed')
 need(s.st_uid==uid and not s.st_mode&0o077,'foreign/public relay evidence')
 return raw
def relay_state(v,repo,custody):
 uid=ROSE_UID;root=Path(v['relay_directory'])
 need(re.fullmatch('/tmp/cb-relay-[A-Za-z0-9_]{8}',str(root)) and root.resolve(strict=True)==root,'relay namespace differs')
 need(root.is_dir() and root.stat().st_uid==uid and not root.stat().st_mode&0o077,'relay directory custody differs')
 hashes={};records={};evidence={};total=0
 def retain(name,raw):
  nonlocal total
  total+=len(raw);need(total<=8388608,'relay raw custody exceeds bound')
  evidence[name]={'bytes':len(raw),'sha256':digest(raw),'body_b64':base64.b64encode(raw).decode()}
 for name in ('authority.private.json','bootstrap-owner.json','broker-owner.json','ready.json','serve.once.json'):
  raw=private(root/name,uid);retain(name,raw);hashes[name]=digest(raw);records[name]=json.loads(raw)
 auth=records['authority.private.json'];bootstrap=records['bootstrap-owner.json'];broker=records['broker-owner.json'];ready=records['ready.json'];once=records['serve.once.json']
 need(auth['schema']=='shared-relay-authority-v1' and auth['app']=='navi-whisper-lux-bench' and auth['parent_pid']==PARENT_PID and auth['parent_start']==v['joined']['terminal']['parent_birth'],'relay parent differs')
 need(gone(auth['parent_pid'],auth['parent_start']),'relay parent still live')
 source=subprocess.check_output(['git','-c','safe.directory='+str(repo),'--no-replace-objects','-C',str(repo),'show',v['source_ref']+':scripts/cloudbench-shared-relay.py'])
 need(digest(source)==auth['source_sha256']==v['relay_source_sha256'],'relay source differs')
 campaign=Path(auth['inventory_directory']).parent;location=campaign/'shared-relay-location.json'
 need(campaign.parent==repo/'.context/benchmarks/campaigns' and Path(auth['inventory_directory'])==campaign/'shared-inventory','campaign relay namespace differs')
 raw=private(location,uid);need(json.loads(raw)=={'directory':str(root)},'relay location differs');hashes['location']=digest(raw);retain('location',raw)
 for item in (bootstrap,broker):need(item['parent_pid']==auth['parent_pid'] and item['parent_start']==auth['parent_start'],'relay child parent differs')
 need(ready['authority_sha256']==once['authority_sha256']==hashes['authority.private.json'] and ready['pid']==once['pid']==broker['pid'] and ready['birth']==once['birth']==broker['birth'],'broker custody differs')
 need(gone(broker['pid'],broker['birth']),'relay broker still live')
 leases=root/'leases';need(leases.resolve(strict=True)==leases and leases.is_dir() and leases.stat().st_uid==uid,'lease directory differs')
 paths=sorted(leases.iterdir());need(len(paths)<=1200,'too many relay leases')
 for path in paths:
  need(re.fullmatch('[0-9a-f]{32}'+r'\.(json|live)',path.name),'unknown relay lease artifact')
  raw=private(path,uid);retain('leases/'+path.name,raw);hashes['leases/'+path.name]=digest(raw)
  if path.suffix=='.json':
   row=json.loads(raw);need(path.stem==row['lease'] and row['authority_sha256']==hashes['authority.private.json'] and type(row['owner_pid'])is int and row['owner_pid']>1 and isinstance(row['owner_start'],str),'invalid relay route owner')
   need(gone(row['owner_pid'],row['owner_start']),'relay route owner remains live')
  else:need((leases/(path.stem+'.json')).is_file(),'orphan live route record')
 need(paths==sorted(leases.iterdir()),'relay lease membership changed')
 agent=ready['agent'];need(auth['agent_socket']==str(root/'fly-agent.sock') and ready['socket']==str(root/'control.sock'),'relay socket scope differs')
 if not gone(agent['pid'],agent['birth']):
  p=Path('/proc')/str(agent['pid']);status=dict(x.split(':',1)for x in(p/'status').read_text().splitlines()if ':'in x)
  need([int(x)for x in status['Uid'].split()]==[uid]*4 and p.stat().st_uid==uid,'isolated agent UID differs')
  sock=root/'fly-agent.sock';s=sock.lstat();need(stat.S_ISSOCK(s.st_mode) and s.st_uid==uid and [s.st_dev,s.st_ino]==agent['socket_identity'],'isolated agent socket differs')
 expected=dict(pid=bootstrap['pid'],birth=bootstrap['birth'],uid=uid,relay_directory=str(root),records=hashes,evidence=evidence,agent=agent)
 if not gone(bootstrap['pid'],bootstrap['birth']):
  p=process(bootstrap['pid'],uid);argv=[os.fsdecode(x)for x in p.pop('argv')]
  need(os.readlink(Path('/proc')/str(p['pid'])/'exe')=='/tmp/gate/bin/flyctl' and not(Path('/proc')/str(p['pid'])/'task'/str(p['pid'])/'children').read_text().strip(),'bootstrap executable/children differ')
  need(p['birth']==bootstrap['birth'] and p['cwd']==str(repo) and argv==['flyctl','proxy','0:1','::1','-a',auth['app'],'--bind-addr','127.0.0.1','-q'],'bootstrap process differs')
  need(all(os.readlink(Path('/proc')/str(p['pid'])/'fd'/str(n))==str(root/'bootstrap.private.log')for n in(1,2)),'bootstrap log descriptors differ')
  expected['process']=p
 return expected

def execute(v):
 repo,common,custody,pending=prerequisites(v)
 parent=custody/'registered-orphan-drain';need(parent.resolve(strict=True)==parent and parent.is_dir(),'existing drain custody required')
 journal=parent/'relay-bootstrap'
 if v['action']=='observe' and journal.exists():
  intent=obj(journal/'intent.json');need(intent['identity_sha256']==v['identity_sha256'],'foreign relay retirement')
  expected=intent['owner'];state='BOOTSTRAP_EXIT_OBSERVED' if gone(expected['pid'],expected['birth']) else 'INTENT_PRESENT_NO_REPLAY'
  return dict(status=state,no_signal=True,agent_exit_observed=gone(expected['agent']['pid'],expected['agent']['birth']),result=obj(journal/'result.json')if(journal/'result.json').exists()else None)
 expected=relay_state(v,repo,custody)
 if v['action']=='observe':return dict(status='RELAY_VALIDATED_NO_SIGNAL',owner=expected)
 need(v['action']=='signal' and not journal.exists(),'relay retirement already attempted; observe only')
 need('process'in expected,'bootstrap already exited; observe only')
 fd=os.pidfd_open(expected['pid'])
 try:
  need(relay_state(v,repo,custody)==expected and not select.select([fd],[],[],0)[0],'relay custody changed')
  journal.mkdir(mode=0o700)
  save(journal/'intent.json',dict(identity_sha256=v['identity_sha256'],operator_ref=v['operator_ref'],launch_sha256=v['launch_sha256'],owner=expected,signal='SIGTERM'))
  # The exact bootstrap is the only target. Its isolated agent receives no signal.
  executor_uid=os.geteuid()
  try:
   if executor_uid!=expected['uid']:os.seteuid(expected['uid'])
   need(os.geteuid()==expected['uid'],'signal executor UID differs')
   signal.pidfd_send_signal(fd,signal.SIGTERM)
  finally:
   if os.geteuid()!=executor_uid:os.seteuid(executor_uid)
  exited=bool(select.select([fd],[],[],2)[0])
  result=dict(status='BOOTSTRAP_EXIT_OBSERVED'if exited else'TERM_SENT_NOT_JOINED',pid=expected['pid'],birth=expected['birth'],agent_exit_observed=gone(expected['agent']['pid'],expected['agent']['birth']),no_release_claim=True)
  save(journal/'result.json',result);return result
 finally:os.close(fd)
"""
GUEST = D["GUEST"] + RELAY


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
    need(
        len(json.dumps(body).encode()) <= 16384,
        "bounded relay retirement body required",
    )
    return body


def local_state(args):
    state = D["local_state"](args)
    hashes = {
        n: sha((HERE / n).read_bytes())
        for n in (
            "cloudbench-controller-relay-retire.py",
            "cloudbench-controller-orphan-drain.py",
        )
    }
    state["_relay_pins"] = B["source_identity"](HERE.parent, args.operator_ref, hashes)
    command(dict(make_payload(args, state), action="observe"))
    return state


def make_payload(args, state):
    source = subprocess.check_output(
        [
            "git",
            "--no-replace-objects",
            "-C",
            state["source_root"],
            "show",
            state["source_ref"] + ":scripts/cloudbench-shared-relay.py",
        ]
    )
    fleet = subprocess.check_output(
        [
            "git",
            "--no-replace-objects",
            "-C",
            state["source_root"],
            "show",
            state["source_ref"] + ":scripts/run-bench-fleet",
        ]
    )
    payload = {
        "machine": state["machine_id"],
        "source_ref": state["source_ref"],
        "epoch": state["epoch"],
        "deadline": state["deadline"],
        "joined": state["_drain"]["joined"],
        "launch_sha256": state["_drain"]["launch_sha256"],
        "operator_ref": args.operator_ref,
        "relay_directory": str(args.relay_directory),
        "relay_source_sha256": sha(source),
        "fleet_source_sha256": sha(fleet),
    }
    payload["identity_sha256"] = sha(json.dumps(payload, sort_keys=True).encode())
    return payload


def run(args, state):
    parent = Path(state["out"]) / "registered-orphan-drain"
    need(parent.is_dir(), "existing host drain custody required")
    out = parent / "relay-bootstrap"
    payload = make_payload(args, state)
    if args.observe:
        out = parent / ("relay-observe-" + str(time.time_ns()))
    out.mkdir(mode=0o700)
    save(
        out / "intent.json",
        {
            "payload": payload,
            "operator": state["_drain"],
            "relay_source_pins": state["_relay_pins"],
        },
    )
    checked = local_state(args)
    need(
        checked["_drain"] == state["_drain"]
        and checked["_relay_pins"] == state["_relay_pins"],
        "relay local evidence changed",
    )
    api = F["RecordedAPI"](F["api_for"](state), state, out)
    base = "/machines/" + state["machine_id"]
    current = api.request("GET", base, timeout=18)
    need(
        all(
            current.get(k) == state["machine"].get(k)
            for k in ("id", "instance_id", "config", "name", "region")
        ),
        "native controller changed",
    )
    response = api.request(
        "POST",
        base + "/exec",
        command(dict(payload, action="observe" if args.observe else "signal")),
        timeout=18,
    )
    need(
        response.get("exit_code") == 0
        and response.get("exit_signal", 0) == 0
        and response.get("stderr") in (None, ""),
        "relay retirement uncertain; observe only",
    )
    result = json.loads(response["stdout"])
    save(out / "result.json", result)
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    modes = p.add_mutually_exclusive_group(required=True)
    for name in ("check", "run", "observe"):
        modes.add_argument("--" + name, action="store_true")
    for name in (
        "config",
        "run-directory",
        "joined-journal",
        "pending",
        "relay-directory",
    ):
        p.add_argument("--" + name, type=Path, required=True)
    p.add_argument("--config-sha256", required=True)
    p.add_argument("--operator-ref", required=True)
    args = p.parse_args()
    os.umask(0o077)
    state = local_state(args)
    print(
        json.dumps(
            {"status": "CHECKED", "provider_calls": 0}
            if args.check
            else run(args, state),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
