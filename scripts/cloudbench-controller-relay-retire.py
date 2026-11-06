#!/usr/bin/env python3
"""Retire only a sealed, route-free orphan relay bootstrap; never its agent."""

import argparse
import ast
import base64
import gzip
import json
import os
import runpy
import shlex
import subprocess
import time
from pathlib import Path
# A uv/python-build-standalone interpreter (agents/venv) can lack the pidfd
# wrappers although the Linux kernel provides them. Bind the same syscalls so
# exact-owner signals stay pinned to a pidfd and never fall back to a raw PID.
if not hasattr(os, "pidfd_open") or not hasattr(__import__("signal"), "pidfd_send_signal"):
    import ctypes as _pidfd_ctypes
    import signal as _pidfd_signal

    def _pidfd_syscall(number, *args):
        libc = _pidfd_ctypes.CDLL(None, use_errno=True)
        result = libc.syscall(_pidfd_ctypes.c_long(number), *args)
        if result < 0:
            error = _pidfd_ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        return result

    if not hasattr(os, "pidfd_open"):
        # Syscall numbers are shared by every Linux architecture (>= 5.1).
        os.pidfd_open = lambda pid, flags=0: _pidfd_syscall(434, _pidfd_ctypes.c_int(pid), _pidfd_ctypes.c_uint(flags))
    if not hasattr(_pidfd_signal, "pidfd_send_signal"):
        def _pidfd_send_signal(fd, sig, siginfo=None, flags=0):
            _pidfd_syscall(424, _pidfd_ctypes.c_int(fd), _pidfd_ctypes.c_int(int(sig)), None, _pidfd_ctypes.c_uint(flags))

        _pidfd_signal.pidfd_send_signal = _pidfd_send_signal

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
def private(path,uid,public_metadata=False):
 before=Path(path).lstat();raw=read(path);s=Path(path).lstat()
 need((before.st_dev,before.st_ino,before.st_mode,before.st_uid,before.st_gid,before.st_nlink,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns),'relay evidence changed')
 need(s.st_uid==uid and not s.st_mode&(0o022 if public_metadata else 0o077),'foreign/public relay evidence')
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
  raw=private(root/name,uid,name in ('bootstrap-owner.json','broker-owner.json'));retain(name,raw);hashes[name]=digest(raw);records[name]=json.loads(raw)
 auth=records['authority.private.json'];bootstrap=records['bootstrap-owner.json'];broker=records['broker-owner.json'];ready=records['ready.json'];once=records['serve.once.json']
 need(auth['schema']=='shared-relay-authority-v1' and auth['app']=='navi-whisper-lux-bench' and auth['parent_pid']==PARENT_PID and auth['parent_start']==v['joined']['terminal']['parent_birth'],'relay parent differs')
 need(gone(auth['parent_pid'],auth['parent_start']),'relay parent still live')
 source=subprocess.check_output(['git','-c','safe.directory='+str(repo),'--no-replace-objects','-C',str(repo),'show',v['source_ref']+':scripts/cloudbench-shared-relay.py'])
 need(digest(source)==auth['source_sha256']==v['relay_source_sha256'],'relay source differs')
 campaign=Path(auth['inventory_directory']).parent;location=campaign/'shared-relay-location.json'
 need(campaign.parent==repo/'.context/benchmarks/campaigns' and Path(auth['inventory_directory'])==campaign/'shared-inventory','campaign relay namespace differs')
 raw=private(location,uid,True);need(json.loads(raw)=={'directory':str(root)},'relay location differs');hashes['location']=digest(raw);retain('location',raw)
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
# Relay retirement reuses only the drain's guest core; the normal-agent capture
# path is never executed here and pushed the exec body past its 16 KiB bound.
GUEST = D["CORE_GUEST"] + RELAY


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
    if args.pre_signal_refusal_journal:
        state["_pre_signal_refusal"] = validate_refusal(args, state)
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


OLD_OPERATOR = "ae21ee1646ed0b6ef0672157febd618ee247c176"
OLD_SOURCE_SHA = "b7ca03b866518377ba5e04ff0a28253ec2002cb324221dbc42cc7e4a168b346c"
REFUSAL_STDERR = (
    "Traceback (most recent call last):\n"
    '  File "<string>", line 1, in <module>\n'
    '  File "<string>", line 209, in execute\n'
    '  File "<string>", line 165, in relay_state\n'
    '  File "<string>", line 153, in private\n'
    '  File "<string>", line 6, in need\n'
    "ValueError: foreign/public relay evidence\n"
)
PRIOR_FILES = {
    "intent.json",
    *{
        f"wire-{i:06d}.{suffix}.json"
        for i in (1, 2)
        for suffix in ("request", "raw", "decoded")
    },
}


def prior_manifest(journal):
    need(
        journal.resolve(strict=True) == journal and journal.is_dir(),
        "physical prior journal required",
    )
    custody = journal.stat()
    need(
        custody.st_uid == os.getuid() and not custody.st_mode & 0o077,
        "private prior journal required",
    )
    children = {p.name for p in journal.iterdir()}
    need(
        children - {"pre-signal-successor.json"} == PRIOR_FILES,
        "unexpected prior journal membership",
    )
    files = {name: sha(read(journal / name)) for name in sorted(PRIOR_FILES)}
    need(
        children == {p.name for p in journal.iterdir()},
        "prior journal membership changed",
    )
    digest = sha(
        json.dumps(
            files, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    )
    return files, digest


def validate_refusal(args, state):
    journal = args.pre_signal_refusal_journal.absolute()
    need(
        journal == Path(state["out"]) / "registered-orphan-drain/relay-bootstrap",
        "exact failed relay journal required",
    )
    files, digest = prior_manifest(journal)
    old = F["obj"](journal / "intent.json")
    payload = old["payload"]
    expected = make_payload(args, state)
    expected["operator_ref"] = OLD_OPERATOR
    expected.pop("identity_sha256")
    expected["identity_sha256"] = sha(json.dumps(expected, sort_keys=True).encode())
    need(payload == expected, "old relay payload differs")
    for key in (
        "joined",
        "launch_sha256",
        "joined_files",
        "joined_journal",
        "pending_path",
        "pending_sha256",
    ):
        need(old["operator"][key] == state["_drain"][key], "old relay custody differs")
    roots = {
        str(Path(p).parent.parent)
        for p in old["relay_source_pins"]
        if Path(p).name == "cloudbench-controller-relay-retire.py"
    }
    need(len(roots) == 1, "ambiguous old relay operator")
    root = Path(roots.pop())
    source = subprocess.check_output(
        [
            "git",
            "--no-replace-objects",
            "-C",
            str(root),
            "show",
            OLD_OPERATOR + ":scripts/cloudbench-controller-relay-retire.py",
        ]
    )
    need(sha(source) == OLD_SOURCE_SHA, "unsupported old relay source")
    original_drain = subprocess.check_output(
        [
            "git",
            "--no-replace-objects",
            "-C",
            str(root),
            "show",
            OLD_OPERATOR + ":scripts/cloudbench-controller-orphan-drain.py",
        ]
    )
    hashes = {
        "cloudbench-controller-relay-retire.py": OLD_SOURCE_SHA,
        "cloudbench-controller-orphan-drain.py": sha(original_drain),
    }
    pins = {
        path: list(value) if value is not None else None
        for path, value in B["source_identity"](root, OLD_OPERATOR, hashes).items()
    }
    need(pins == old["relay_source_pins"], "old relay source fingerprint differs")

    def literal(raw, name):
        tree = ast.parse(raw)
        return ast.literal_eval(
            next(
                n.value
                for n in tree.body
                if isinstance(n, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == name for t in n.targets)
            )
        )

    old_guest = literal(original_drain, "GUEST") + literal(source, "RELAY")
    package = base64.b64encode(
        gzip.compress(
            json.dumps([old_guest, dict(expected, action="signal")]).encode(), mtime=0
        )
    ).decode()
    loader = "import base64,gzip,json,sys;s,v=json.loads(gzip.decompress(base64.b64decode(sys.argv[1])));exec(s);print(json.dumps(execute(v),sort_keys=True))"
    body = {
        "cmd": shlex.join(["python3", "-S", "-c", loader, package]),
        "timeout": 18,
        "machine": True,
    }
    base = "/machines/" + state["machine_id"]
    for i, method, path, request_body in (
        (1, "GET", base, None),
        (2, "POST", base + "/exec", body),
    ):
        prefix = journal / f"wire-{i:06d}"
        request = F["obj"](Path(str(prefix) + ".request.json"))
        need(
            request == {"method": method, "path": path, "body": request_body},
            "old relay request differs",
        )
        raw = F["obj"](Path(str(prefix) + ".raw.json"))
        decoded = F["obj"](Path(str(prefix) + ".decoded.json"))
        data = base64.b64decode(raw["body_b64"], validate=True)
        need(
            type(raw["status"]) is int
            and raw["status"] == 200
            and raw["method"] == method
            and raw["path"] == path
            and len(data) == raw["bytes"]
            and sha(data) == raw["sha256"]
            and json.loads(data) == decoded,
            "old relay raw response differs",
        )
        if i == 1:
            need(
                all(
                    decoded.get(k) == state["machine"].get(k)
                    for k in ("id", "instance_id", "config", "name", "region")
                ),
                "old native controller differs",
            )
        else:
            need(
                decoded
                == {
                    "exit_code": 1,
                    "exit_signal": 0,
                    "stdout": "",
                    "stderr": REFUSAL_STDERR,
                }
                and type(decoded["exit_code"]) is int
                and type(decoded["exit_signal"]) is int,
                "not the supported pre-signal refusal",
            )
    need(prior_manifest(journal) == (files, digest), "old relay journal changed")
    return {
        "journal": str(journal),
        "files": files,
        "prior_journal_sha256": digest,
        "source_pins": pins,
    }


def successor_value(old, new, payload, intent_sha):
    return {
        "schema": "relay-pre-signal-successor-v1",
        "prior_journal_sha256": old["prior_journal_sha256"],
        "new_journal": str(new),
        "intent_sha256": intent_sha,
        "identity_sha256": payload["identity_sha256"],
        "operator_ref": payload["operator_ref"],
        "launch_sha256": payload["launch_sha256"],
    }


def run(args, state):
    parent = Path(state["out"]) / "registered-orphan-drain"
    need(parent.is_dir(), "existing host drain custody required")
    out = parent / "relay-bootstrap"
    payload = make_payload(args, state)
    refusal = state.get("_pre_signal_refusal")
    if refusal:
        out = parent / ("relay-bootstrap-pre-signal-" + refusal["prior_journal_sha256"])
    if args.observe:
        out = parent / ("relay-observe-" + str(time.time_ns()))
    out.mkdir(mode=0o700)
    save(
        out / "intent.json",
        {
            "payload": payload,
            "operator": state["_drain"],
            "relay_source_pins": state["_relay_pins"],
            **({"pre_signal_refusal": refusal} if refusal else {}),
        },
    )
    if refusal and not args.observe:
        pointer = successor_value(refusal, out, payload, sha(read(out / "intent.json")))
        save(Path(refusal["journal"]) / "pre-signal-successor.json", pointer)
    checked = local_state(args)
    need(
        checked["_drain"] == state["_drain"]
        and checked["_relay_pins"] == state["_relay_pins"]
        and checked.get("_pre_signal_refusal") == refusal,
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
    p.add_argument("--pre-signal-refusal-journal", type=Path)
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
