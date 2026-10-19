#!/usr/bin/env python3
"""Preserve controller originals; this receipt never authorizes resource release."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import pwd
import math
import re
import types
from decimal import Decimal
import stat
import subprocess
import tarfile
import tempfile
import time
import sys
import shutil

os.umask(0o077)


def birth(pid):
    try:
        value = Path(f"/proc/{pid}/stat").read_text()
        fields = value[value.rfind(")") + 2:].split()
        return "proc-start:" + Path("/proc/sys/kernel/random/boot_id").read_text().strip() + ":" + fields[19]
    except FileNotFoundError:
        return None


def sync_json(path, value):
    path = Path(path)
    with path.open("x", encoding="utf-8") as out:
        json.dump(value, out, sort_keys=True, indent=2)
        out.write("\n"); out.flush(); os.fsync(out.fileno())
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def git(repo, *args):
    return subprocess.check_output(["git", "-c", "safe.directory="+str(repo), "-C", str(repo), *args]).decode().strip()


def writers(roots, permitted):
    found = []
    for process in Path("/proc").iterdir():
        if not process.name.isdecimal() or int(process.name) in permitted:
            continue
        try:
            # A zombie leader keeps no cwd/fd/maps while its other threads can still
            # write; read every live thread of the group, not only the leader.
            paths = []
            for task in (process / "task").iterdir():
                try:
                    paths.append(os.readlink(task / "cwd"))
                    for fd in (task / "fd").iterdir():
                        try: paths.append(os.readlink(fd))
                        except FileNotFoundError: continue
                    for line in (task / "maps").read_text().splitlines():
                        fields = line.split(None, 5)
                        if len(fields) == 6 and "w" in fields[1]: paths.append(fields[5])
                except FileNotFoundError:
                    continue
            if any(any(path == str(root) or path.startswith(str(root) + "/") for root in roots) for path in paths):
                found.append({"pid": int(process.name), "birth": birth(int(process.name))})
        except FileNotFoundError:
            continue
        except PermissionError:
            raise ValueError("cannot observe controller writer ownership")
    return found


def file_state(path):
    value = path.lstat()
    return {"device": value.st_dev, "inode": value.st_ino, "bytes": value.st_size,
            "mtime_ns": value.st_mtime_ns, "mode": value.st_mode, "uid": value.st_uid,
            "allocated_bytes": value.st_blocks * 512, "gid": value.st_gid, "nlink": value.st_nlink}


def sources(repo, common, temp_roots):
    selected = [("context", repo / ".context"), ("source/scripts", repo / "scripts")]
    for name in ("AGENTS.md", "CLAUDE.md", "package.json", "pnpm-lock.yaml", "yarn.lock",
                 "agents/.env", "back-end/.env", "agents/pyproject.toml", "agents/requirements.txt",
                 "back-end/package.json", "front-end/package.json"):
        path = repo / name
        if path.exists() or path.is_symlink(): selected.append(("source/" + name, path))
    for path in common.iterdir():
        if path.name.startswith("cloudbench-") or path.name in ("HEAD", "config", "index", "packed-refs", "refs", "worktrees"):
            selected.append(("git-common/" + path.name, path))
    for path in sorted(repo.parent.glob("step-*.log")):
        selected.append(("controller-output/" + path.name, path))
    for ordinal, path in enumerate(Path(value) for value in temp_roots):
        if path.exists() or path.is_symlink(): selected.append(("host-state/" + str(ordinal) + "/" + path.name, path))
    return selected


def record_temp_roots(repo, common):
    # Existing source-owned namespaces only: no broad /tmp traversal.
    tmp = Path(os.environ.get("TMPDIR", "/tmp"))
    app = os.environ.get("FLY_APP_NAME", os.environ.get("CLOUDBENCH_APP", "navi-whisper-lux-bench"))
    uids = {os.getuid()}
    try: uids.add(pwd.getpwnam("rose").pw_uid)
    except KeyError: pass
    paths = [str(Path("/tmp") / ("rose-cloudbench-cleanup-admission-" + str(uid))) for uid in sorted(uids)]
    paths.extend(str(Path(os.environ.get(key, str(tmp / default)))) for key,default in (
        ("CLOUDBENCH_CAPACITY_RESERVATION_ROOT", "rose-cloudbench-capacity-" + app),
        ("CLOUDBENCH_RECOVERY_PORT_LEASE_ROOT", "rose-cloudbench-recovery-port-leases"),
        ("AUTOSCALER_PORT_LEASE_ROOT", "rose-cloudbench-autoscaler-port-leases")))
    return paths


def entries(prefix, path):
    if path.is_dir() and not path.is_symlink():
        yield prefix, path
        for child in sorted(path.iterdir()):
            yield from entries(prefix + "/" + child.name, child)
    else: yield prefix, path


def sealed_bytes(path, limit=None):
    path = Path(path)
    if path.resolve(strict=True) != path:
        raise ValueError("continuation source path is redirected")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or (limit is not None and before.st_size > limit):
            raise ValueError("unsafe continuation source")
        digest = hashlib.sha256()
        raw = bytearray() if limit is not None else None
        for chunk in iter(lambda: source.read(1048576), b""):
            digest.update(chunk)
            if raw is not None:
                raw.extend(chunk)
                if len(raw) > limit: raise ValueError("continuation source exceeds bound")
        after = os.fstat(source.fileno())
    def identity(value):
        return (value.st_dev,value.st_ino,value.st_mode,value.st_uid,value.st_gid,value.st_nlink,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
    if identity(before) != identity(after) or identity(after) != identity(path.lstat()):
        raise ValueError("continuation source changed")
    return digest.hexdigest(), bytes(raw) if raw is not None else None


def source_collector(repo, ref):
    if not isinstance(ref,str) or re.fullmatch('[0-9a-f]{40}',ref) is None:
        raise ValueError('capture tool source ref missing')
    return subprocess.check_output(['git','-c','safe.directory='+str(repo),'-C',str(repo),'--no-replace-objects','show',ref+':scripts/cloudbench-controller-export.py'])


def checked_collector_bytes():
    return globals().get('CHECKED_COLLECTOR_SOURCE_BYTES') or Path(__file__).read_bytes()


def capture_tool_binding(repo, record, record_sha, tool_ref):
    tool=source_collector(repo,tool_ref); actual=checked_collector_bytes()
    if tool != actual: raise ValueError('capture tool executable source differs')
    original=source_collector(repo,record['source_ref'])
    if hashlib.sha256(original).hexdigest() != record['collector_sha256']:
        raise ValueError('original launch collector source differs')
    return {'schema':'controller-original-capture-tool-v1','source_ref':tool_ref,
            'sha256':hashlib.sha256(tool).hexdigest(),'original_run_source_ref':record['source_ref'],
            'original_collector_sha256':record['collector_sha256'],'original_launch_sha256':record_sha}


def continuation_binding(value, repo, ref, driver_pid, caller, image, epoch):
    """Verify the original seal with its original collector, never with new bytes."""
    if value.get('resource_release_verified') is not False:
        raise ValueError('continuation cannot authorize release')
    if value.get("schema") != "controller-export-continuation-v1":
        raise ValueError("unknown continuation schema")
    if type(epoch) not in (int,float) or not math.isfinite(epoch) or epoch <= 0 or value["epoch"] != epoch:
        raise ValueError("continuation epoch differs")
    if not re.fullmatch('[0-9a-f]{40}', ref) or value["new_ref"] != ref:
        raise ValueError("continuation source differs")
    if value["new_driver_pid"] != driver_pid or value["new_driver_birth"] != birth(driver_pid):
        raise ValueError("continuation driver differs")
    caller_sha, _ = sealed_bytes(caller, 1048576)
    if value['new_caller_path'] != str(Path(caller).resolve(strict=True)): raise ValueError('continuation caller path differs')
    if value["new_caller_sha256"] != caller_sha: raise ValueError("continuation caller differs")
    paths = {key:Path(value[key]) for key in ('old_record','old_manifest','old_archive')}
    raws = {}
    for key,path in paths.items():
        digest, raw = sealed_bytes(path, None if key == 'old_archive' else 67108864)
        if digest != value[key + '_sha256']: raise ValueError("original seal changed")
        raws[key] = raw
    record = json.loads(raws['old_record'])
    old_ref = record['source_ref']
    if not re.fullmatch('[0-9a-f]{40}', old_ref): raise ValueError("invalid original source")
    common = Path(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    if record['repo'] != str(repo) or record['common_git'] != str(common): raise ValueError("continuation roots differ")
    if record['host'] != socket.gethostname() or record['machine_id'] != os.environ.get('FLY_MACHINE_ID') or record['app'] != os.environ.get('FLY_APP_NAME') or record['image'] != image:
        raise ValueError("continuation native identity differs")
    if record['driver_pid'] == driver_pid or birth(record['driver_pid']) != record['driver_birth']:
        raise ValueError("original idle init identity differs")
    if value['old_init_pid'] != record['driver_pid'] or value['old_init_birth'] != record['driver_birth']:
        raise ValueError("continuation idle init differs")
    if set(record['root_anchors']) != {str(repo),str(common)}: raise ValueError("original root set differs")
    for name,expected in record['root_anchors'].items():
        path=Path(name); actual=file_state(path)
        if path.is_symlink() or any(actual[k] != v for k,v in expected.items()): raise ValueError("original roots changed")
    owner = repo/'.context/controller-workspace-volume/ownership.json'
    owner_sha, owner_raw = sealed_bytes(owner, 1048576)
    ownership = json.loads(owner_raw)
    if owner_sha != record.get('workspace_ownership_sha256') or owner_sha != value['old_ownership_sha256'] or owner_sha != os.environ.get('GATE_WORKSPACE_VOLUME_SHA256'):
        raise ValueError("original workspace ownership changed")
    if ownership['source_ref'] != old_ref or ownership['volume_id'] != os.environ.get('GATE_WORKSPACE_VOLUME_ID') or ownership['app'] != record['app']:
        raise ValueError("original workspace identity differs")
    original_collector = source_collector(repo,old_ref)
    if hashlib.sha256(original_collector).hexdigest() != record['collector_sha256']:
        raise ValueError("original collector differs")
    manifest=json.loads(raws['old_manifest'])
    capture=manifest.get('capture_tool')
    collector=source_collector(repo,capture['source_ref']) if capture else original_collector
    expected_collector=capture['sha256'] if capture else record['collector_sha256']
    if hashlib.sha256(collector).hexdigest()!=expected_collector:
        raise ValueError('declared original capture tool differs')
    namespace={'__name__':'original_controller_seal_verifier','__file__':str(repo/'scripts/cloudbench-controller-export.py'),'CHECKED_COLLECTOR_SHA256':expected_collector,'CHECKED_COLLECTOR_SOURCE_BYTES':collector}
    exec(compile(collector, 'original-source-bound-controller-export', 'exec'), namespace)
    namespace['verify'](types.SimpleNamespace(archive=paths['old_archive'],manifest=paths['old_manifest'],record=paths['old_record'],ref=old_ref,machine=record['machine_id'],app=record['app'],image=image,caller=None,repo=repo))
    manifest=json.loads(raws['old_manifest'])
    for member,expected in (('context/controller-workspace-volume/ownership.json',owner_sha),('controller-output/launch.json',value['old_record_sha256'])):
        if manifest['files'].get(member,{}).get('sha256') != expected: raise ValueError("original archive lacks ownership binding")
    # The full verification must not race replacements of its inputs.
    for key,path in paths.items():
        if sealed_bytes(path)[0] != value[key+'_sha256']: raise ValueError("original seal changed during verification")
    return record


def continue_launch(args):
    repo=args.repo.resolve(strict=True)
    if git(repo,'rev-parse','HEAD') != args.ref: raise ValueError("continuation checkout differs")
    old=json.loads(sealed_bytes(args.old_record, 67108864)[1])
    value={'schema':'controller-export-continuation-v1','new_ref':args.ref,'epoch':args.epoch,
           'new_driver_pid':args.driver_pid,'new_driver_birth':birth(args.driver_pid),
           'new_caller_sha256':sealed_bytes(args.caller,1048576)[0],'new_caller_path':str(args.caller.resolve(strict=True)),
           'old_ownership_sha256':old.get('workspace_ownership_sha256'),
           'old_init_pid':old['driver_pid'],'old_init_birth':old['driver_birth'],
           'resource_release_verified':False}
    for key in ('old_record','old_manifest','old_archive'):
        path=getattr(args,key).resolve(strict=True); value[key]=str(path);value[key+'_sha256']=sealed_bytes(path)[0]
    continuation_binding(value,repo,args.ref,args.driver_pid,args.caller,args.image,args.epoch)
    sync_json(args.record,value)


def launch(args):
    repo = args.repo.resolve(strict=True)
    if git(repo, "rev-parse", "HEAD") != args.ref:
        raise ValueError("controller checkout is not the pinned source")
    common = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    identity = birth(args.driver_pid)
    if not identity: raise ValueError("original controller driver birth unavailable")
    caller = json.loads(args.caller.read_text())
    anchors = {str(path):{key:file_state(path)[key] for key in ("device","inode","mode","uid")} for path in (repo,common)}
    value = {"version": 1, "host": socket.gethostname(), "root_anchors":anchors, "driver_pid": args.driver_pid,
             "driver_birth": identity, "repo": str(repo), "common_git": str(common),
             "source_ref": args.ref, "image": args.image, "caller": caller,
             "machine_id":os.environ.get("FLY_MACHINE_ID"), "app":os.environ.get("FLY_APP_NAME"),
             "temp_state_roots": record_temp_roots(repo, common),
             "toolchain": {"python":sys.version, "executable":sys.executable},
             "env_sha256": {str(path.relative_to(repo)):hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() and not path.is_symlink() else None
                            for path in (repo/"agents/.env",repo/"back-end/.env")},
             "dependency_layout": {str(path.relative_to(repo)):os.readlink(path) if path.is_symlink() else "directory" if path.is_dir() else "absent"
                                   for path in (repo/"node_modules",repo/"back-end/node_modules",repo/"front-end/node_modules",repo/"agents/venv")},
             "collector_sha256": globals().get("CHECKED_COLLECTOR_SHA256") or hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    continuation_path = getattr(args, 'continuation', None)
    if continuation_path:
        continuation_sha, continuation_raw = sealed_bytes(continuation_path, 1048576)
        continuation = json.loads(continuation_raw)
        continuation_binding(continuation, repo, args.ref, args.driver_pid, args.caller, args.image, args.epoch)
        value['continuation'] = continuation
        value['continuation_sha256'] = continuation_sha
        value['continuation_path'] = str(continuation_path)
        value['epoch'] = args.epoch
    if os.environ.get("GATE_WORKSPACE_VOLUME_ID"):
        owner=repo/".context/controller-workspace-volume/ownership.json"
        if owner.is_symlink() or not owner.is_file(): raise ValueError("workspace ownership missing")
        raw=owner.read_bytes();volume=json.loads(raw)
        if hashlib.sha256(raw).hexdigest()!=os.environ.get("GATE_WORKSPACE_VOLUME_SHA256") or volume["volume_id"]!=os.environ["GATE_WORKSPACE_VOLUME_ID"] or (volume["source_ref"]!=args.ref and not continuation_path) or volume["app"]!=value["app"]:
            raise ValueError("workspace ownership changed before launch")
        value["workspace_ownership_sha256"]=hashlib.sha256(raw).hexdigest()
    sync_json(args.record, value)


def writer_identity(row):
    """Secret-free evidence for one writer row: state, parent and program name only."""
    value = dict(row)
    try:
        stat_line = Path("/proc", str(row["pid"]), "stat").read_text()
        comm = stat_line[stat_line.index("(") + 1:stat_line.rindex(")")]
        fields = stat_line[stat_line.rindex(")") + 2:].split()
        if birth(row["pid"]) == row["birth"]:
            value.update(state=fields[0], ppid=int(fields[1]), comm=comm[:32],
                         threads=len(os.listdir(Path("/proc", str(row["pid"]), "task"))))
    except (OSError, ValueError):
        value.update(state="gone")
    return value


def controller_active_writers(common, roots, permitted):
    active = writers(roots, permitted)
    ownership = common / "cloudbench-fleet-ownership"
    if ownership.exists():
        for meta in ownership.glob("*/meta"):
            fields = dict(line.split("=", 1) for line in meta.read_text().splitlines())
            pid, expected = int(fields["pid"]), fields["pid_start"]
            if not expected.startswith("proc-start:"):
                raise ValueError("unsupported native owner birth; retain host")
            if birth(pid) == expected and pid not in permitted:
                active.append({"pid":pid,"birth":expected,"registry":str(meta.parent)})
    return active



def process_argv(pid):
    before=birth(pid)
    raw=Path('/proc',str(pid),'cmdline').read_bytes()
    if not before or birth(pid)!=before: raise ValueError('controller process changed during observation')
    return [value.decode('utf-8','strict') for value in raw.split(b'\0') if value]


def driver_is_ancestor(driver):
    pid=os.getpid();seen=set()
    while pid>0 and pid not in seen:
        if pid==driver:return True
        seen.add(pid)
        raw=Path('/proc',str(pid),'stat').read_text()
        pid=int(raw[raw.rfind(')')+2:].split()[1])
    return False


def retained_controller_endpoint(record_path, repo, ref, native, original_native, original_native_sha256):
    """Read-only retained endpoint proof, using the original export and writer rules."""
    repo=Path(repo).resolve(strict=True)
    raw=sealed_bytes(record_path,67108864)[1];record=json.loads(raw)
    if (record.get('version')!=1 or record.get('source_ref')!=ref or record.get('repo')!=str(repo)
            or record.get('collector_sha256')!=hashlib.sha256(checked_collector_bytes()).hexdigest()
            or record.get('machine_id')!=os.environ.get('FLY_MACHINE_ID')
            or record.get('app')!=os.environ.get('FLY_APP_NAME') or record.get('host')!=socket.gethostname()
            or birth(record['driver_pid'])!=record['driver_birth'] or not driver_is_ancestor(record['driver_pid'])):
        raise ValueError('retained endpoint does not belong to authorized current driver')
    if git(repo,'rev-parse','HEAD')!=ref or git(repo,'diff','--name-only','HEAD','--','scripts'):
        raise ValueError('retained endpoint source differs')
    common=Path(git(repo,'rev-parse','--path-format=absolute','--git-common-dir'))
    if record['common_git']!=str(common) or set(record['root_anchors'])!={str(repo),str(common)}:
        raise ValueError('retained endpoint physical roots differ')
    for name,expected in record['root_anchors'].items():
        actual=file_state(Path(name))
        if Path(name).is_symlink() or any(actual[key]!=value for key,value in expected.items()):
            raise ValueError('retained endpoint root identity changed')
    continuation=record.get('continuation')
    if not isinstance(continuation,dict):raise ValueError('retained endpoint requires verified continuation')
    continuation_sha,continuation_raw=sealed_bytes(record['continuation_path'],1048576)
    if continuation_sha!=record['continuation_sha256'] or json.loads(continuation_raw)!=continuation:
        raise ValueError('retained endpoint continuation changed')
    caller=Path(continuation['new_caller_path'])
    if json.loads(sealed_bytes(caller,1048576)[1])!=record['caller']:
        raise ValueError('retained endpoint caller changed')
    old=continuation_binding(continuation,repo,ref,record['driver_pid'],caller,record['image'],record['epoch'])
    baseline_sha,baseline_raw=sealed_bytes(original_native,1048576)
    baseline=json.loads(baseline_raw)
    if (baseline_sha!=original_native_sha256 or baseline.get('id')!=record['machine_id']
            or native.get('id')!=baseline['id'] or native.get('instance_id')!=baseline.get('instance_id')
            or not native.get('instance_id') or native.get('state')!='started'
            or native.get('config')!=baseline.get('config')
            or native['config'].get('image')!=record['image']):
        raise ValueError('retained endpoint native config differs from original baseline')
    init=native['config'].get('init',{})
    if not isinstance(init,dict) or set(init)-{'cmd','entrypoint','exec'}:
        raise ValueError('retained endpoint init shape differs')
    if init.get('exec'):
        if init.get('cmd') or init.get('entrypoint'): raise ValueError('retained endpoint init is ambiguous')
        argv=init['exec']
    else:
        argv=init.get('entrypoint',[])+init.get('cmd',[])
    if not argv or process_argv(old['driver_pid'])!=argv:
        raise ValueError('retained endpoint original init process differs')
    roots=[repo,common,*[Path(value) for value in record['temp_state_roots'] if Path(value).exists()]]
    permitted={os.getpid(),record['driver_pid'],old['driver_pid']}
    if controller_active_writers(common,roots,permitted):
        raise ValueError('retained endpoint has active controller writers')
    return record


def retire_disposable_hubs(repo, directory, *, timeout=10):
    """Retire only immutable exact local Hub owners on an exiting disposable host."""
    import signal
    import time
    runs = repo / '.context/fleet/runs'
    hub = runs / '_hub'
    if not hub.exists(): return
    if hub.is_symlink() or hub.resolve() != hub: raise ValueError('unsafe local Hub root')
    selected = []
    try:
        for path in hub.glob('agent-link-server.*.owner'):
            _, raw = sealed_bytes(path, 1048576)
            pairs = [line.split('=', 1) for line in raw.decode().splitlines()]
            owner = dict(pairs)
            if len(pairs) != len(owner): raise ValueError('duplicate Hub ownership fields')
            pid = int(owner['pid'])
            if pid <= 1: raise ValueError('unsafe Hub PID')
            stamp = owner['pid_start']
            if not isinstance(stamp, str) or not stamp.strip(): raise ValueError('invalid Hub birth')
            current = birth(pid)
            if current is None or current != stamp: continue
            if Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()[0] == 'Z': continue
            if path.stat().st_mode & 0o222: raise ValueError('mutable Hub owner receipt')
            expected = repo / 'agents/benchmarks/agent_link_server.py'
            if (owner['repo_root'] != str(repo) or owner['root'] != str(runs)
                    or owner['runs_root'] != str(runs) or owner['context_dir'] != str(hub)
                    or owner['command'] != str(expected) or owner['status'] != 'live-transfer-required'
                    or owner['host'] != '127.0.0.1'
                    or not re.fullmatch('[0-9a-f]{32}', owner['owner_token'])
                    or path.name != f"agent-link-server.{owner['port']}.{owner['owner_token']}.owner"):
                raise ValueError('foreign local Hub ownership')
            if path.stat().st_uid != Path(f'/proc/{pid}').stat().st_uid:
                raise ValueError('Hub receipt owner differs')
            fd = os.pidfd_open(pid)
            selected.append((pid, fd, owner, raw, path))
            if birth(pid) != current: raise ValueError('Hub birth changed')
            argv = process_argv(pid)
            if str(expected) not in argv: raise ValueError('Hub command changed')
            argv = argv[argv.index(str(expected)):]
            if hashlib.sha256(b'\0'.join(os.fsencode(x) for x in argv)).hexdigest() != owner['argv_sha256']:
                raise ValueError('Hub argv changed')
            if Path(f'/proc/{pid}/task/{pid}/children').read_text().strip():
                raise ValueError('Hub descendants require exact disposition')
        end = time.monotonic() + timeout
        for pid, fd, owner, raw, path in selected:
            if birth(pid) != owner['pid_start'] or path.read_bytes() != raw:
                raise ValueError('Hub ownership changed before retirement')
            intent = directory / f'disposable-hub-{pid}.term.intent.json'
            if not intent.exists():
                sync_json(intent, dict(pid=pid, birth=owner['pid_start'], owner_sha256=hashlib.sha256(raw).hexdigest()))
                signal.pidfd_send_signal(fd, signal.SIGTERM)
        for pid, fd, owner, raw, path in selected:
            while birth(pid) == owner['pid_start']:
                try:
                    if Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()[0] == 'Z': break
                except FileNotFoundError: break
                if time.monotonic() >= end: raise ValueError('exact owned Hub retirement pending')
                time.sleep(.02)
    finally:
        for _, fd, _, _, _ in selected: os.close(fd)


def export(args):
    record_raw = sealed_bytes(args.record,67108864)[1]
    record = json.loads(record_raw)
    tool_ref = getattr(args,'capture_tool_ref',None)
    capture_tool = capture_tool_binding(Path(record['repo']),record,hashlib.sha256(record_raw).hexdigest(),tool_ref) if tool_ref else None
    if capture_tool is None and record['collector_sha256'] != hashlib.sha256(checked_collector_bytes()).hexdigest():
        raise ValueError('changed capture tool requires explicit source binding')
    if record["version"] != 1 or birth(record["driver_pid"]) != record["driver_birth"] or record["host"] != socket.gethostname():
        raise ValueError("original controller driver identity changed")
    repo, common = Path(record["repo"]), Path(record["common_git"])
    for name,expected in record["root_anchors"].items():
        path=Path(name)
        actual=file_state(path)
        if path.is_symlink() or any(actual[key]!=value for key,value in expected.items()):
            raise ValueError("original controller root identity changed")
    if git(repo, "diff", "--name-only", "HEAD", "--", "scripts"):
        raise ValueError("controller authority bytes changed")
    if git(repo, "rev-parse", "HEAD") != record["source_ref"]:
        raise ValueError("controller source ref changed")
    if record.get("workspace_ownership_sha256"):
        owner=repo/".context/controller-workspace-volume/ownership.json"
        if owner.is_symlink() or not owner.is_file() or hashlib.sha256(owner.read_bytes()).hexdigest()!=record["workspace_ownership_sha256"]:
            raise ValueError("original workspace ownership changed; retain host")
    roots = [repo, common, *[Path(value) for value in record["temp_state_roots"] if Path(value).exists()]]
    permitted = {os.getpid(), record["driver_pid"]}
    if 'continuation' in record:
        digest, raw = sealed_bytes(record['continuation_path'],1048576)
        if digest != record['continuation_sha256'] or json.loads(raw) != record['continuation']:
            raise ValueError("continuation receipt changed")
        binding=record['continuation']
        old = continuation_binding(binding,repo,record['source_ref'],record['driver_pid'],
                                   Path(binding['new_caller_path']),record['image'],record['epoch'])
        permitted.add(old['driver_pid'])  # exact verified init only; descendants remain ordinary writers
    if getattr(args, 'finalize_disposable_hubs', False):
        if not record.get('workspace_ownership_sha256'):
            raise ValueError('Hub finalization requires sealed disposable workspace')
        command_path = args.record.parent.parent / 'controller-command.json'
        joined_path = args.record.parent.parent / 'controller-command.joined.json'
        command_sha, command_raw = sealed_bytes(command_path, 1048576)
        _, joined_raw = sealed_bytes(joined_path, 1048576)
        command, joined = json.loads(command_raw), json.loads(joined_raw)
        if (command['machine_id'] != record['machine_id'] or command['source_ref'] != record['source_ref']
                or joined['command_sha256'] != command_sha or joined['driver_pid'] != record['driver_pid']
                or joined['driver_birth'] != record['driver_birth'] or type(joined['exit_code']) is not int):
            raise ValueError('disposable command join differs')
        if not command.get('already_joined') and birth(command['pid']) == command['birth']:
            raise ValueError('disposable command remains live')
        retire_disposable_hubs(repo, args.record.parent)
    record_sha256 = hashlib.sha256(args.record.read_bytes()).hexdigest()
    attempts = []
    writer_deadline = time.monotonic() + EXPORT_WRITER_DRAIN_SECONDS
    observed_writers = []
    for attempt in range(1, EXPORT_SNAPSHOT_ATTEMPTS + 1):
        # Campaign teardown processes can still be exiting when the step returns.
        # Wait for them within one bounded drain; a writer that outlives it fails closed.
        while True:
            active = controller_active_writers(common, roots, permitted)
            if not active:
                break
            identities = [writer_identity(row) for row in active]
            if not observed_writers or observed_writers[-1]["writers"] != identities:
                observed_writers.append({"elapsed_s":round(EXPORT_WRITER_DRAIN_SECONDS - (writer_deadline - time.monotonic()), 1),
                                         "writers":identities})
            if time.monotonic() >= writer_deadline:
                sync_json(args.pending, {"status":"pending", "reason":"live controller writers", "writers":active,
                                         "record_sha256":record_sha256, "writer_observations":observed_writers[-32:],
                                         **({"snapshot_attempts":attempts} if attempts else {})})
                return 75
            time.sleep(EXPORT_WRITER_POLL_SECONDS)
        # Complete delayed allocation first: ext4 writeback of the campaign's last
        # appends can add an extent block (st_blocks) without touching mtime/ctime.
        os.sync()
        changed = export_snapshot(args, record, repo, common, roots, permitted, capture_tool)
        if changed is None:
            return 0
        attempts.append(changed)
        if attempt < EXPORT_SNAPSHOT_ATTEMPTS:
            time.sleep(EXPORT_SETTLE_SECONDS)
    # Every attempt still observed a change: fail closed with the exact evidence.
    sync_json(args.pending, {"status":"pending", "reason":"controller originals changed during export",
                             "record_sha256":record_sha256, "snapshot_attempts":attempts,
                             **({"writer_observations":observed_writers[-32:]} if observed_writers else {}),
                             "resource_release_verified":False})
    return 75


EXPORT_SNAPSHOT_ATTEMPTS = 3
EXPORT_SETTLE_SECONDS = 10
# Teardown orphans exited 5-10 s after the step in the original600 shards; a fleet
# machine destroy is bounded at 60 s. Twice that bounds the whole writer drain.
EXPORT_WRITER_DRAIN_SECONDS = 120
EXPORT_WRITER_POLL_SECONDS = 1


def export_snapshot(args, record, repo, common, roots, permitted, capture_tool):
    """One complete strict snapshot; returns None when published, else what changed."""
    files, excluded, observed = {}, {}, {}
    fd, temporary = tempfile.mkstemp(prefix=".controller-export-", dir=args.archive.parent)
    try:
        with os.fdopen(fd, "wb") as out:
            with tarfile.open(fileobj=out, mode="w:gz", dereference=False) as archive:
                selected = sources(repo, common, record["temp_state_roots"])
                selected.append(("controller-output/launch.json", args.record))
                if 'continuation' in record:
                    selected.append(('controller-output/continuation.json',Path(record['continuation_path'])))
                for prefix, root in selected:
                    for name, path in entries(prefix, root):
                        before = file_state(path)
                        canonical_reserve = path.parent.parent == common / "cloudbench-fleet-ownership" and path.name == "cleanup-disk-reserve"
                        if canonical_reserve:
                            observed[path] = before
                            excluded[name] = {"source_path":str(path), "stat":before, "reason":"physical cleanup reserve; payload never read"}
                            continue
                        observed[path] = before
                        info = archive.gettarinfo(str(path), arcname=name)
                        if stat.S_ISREG(before["mode"]):
                            info.type = tarfile.REGTYPE; info.linkname = ""
                            digest = hashlib.sha256()
                            class Reader:
                                def __init__(self, source): self.source = source
                                def read(self, size=-1):
                                    data = self.source.read(size); digest.update(data); return data
                            with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as source:
                                if file_state(path) != before or os.fstat(source.fileno()).st_ino != before["inode"]:
                                    return {"writers":[], "changed_count":1, "changed":[{"path":str(path), "fields":["changed-before-read"]}]}
                                archive.addfile(info, Reader(source))
                            files[name] = {"kind":"file", "bytes":before["bytes"], "sha256":digest.hexdigest()}
                        elif stat.S_ISFIFO(before["mode"]):
                            if before['nlink'] != 1 or before['bytes'] != 0:
                                raise ValueError('unsafe FIFO metadata')
                            info.type=tarfile.FIFOTYPE;info.size=0;info.linkname=''
                            seconds,nanos=divmod(before['mtime_ns'],1000000000)
                            info.pax_headers['mtime']=str(seconds)+'.'+str(nanos).zfill(9)
                            info.pax_headers['cloudbench.fifo-source-stat']=json.dumps(before,sort_keys=True,separators=(',',':'))
                            archive.addfile(info)
                            files[name]={'kind':'fifo','metadata_only':True,'stat':before}
                        elif stat.S_ISDIR(before["mode"]):
                            archive.addfile(info); files[name] = {"kind":"directory"}
                        elif stat.S_ISLNK(before["mode"]):
                            archive.addfile(info); files[name] = {"kind":"symlink", "target":os.readlink(path)}
                        else: raise ValueError("unsupported original file type; retain host")
            out.flush(); os.fsync(out.fileno())
        late = writers(roots, permitted)
        drift = []
        for path, before in observed.items():
            try: after = file_state(path)
            except FileNotFoundError: after = None
            if after != before:
                drift.append({"path":str(path), "fields":sorted(k for k in before if after is None or after[k] != before[k]) if after is not None else ["missing"]})
        if late or drift:
            return {"writers":late, "changed_count":len(drift), "changed":drift[:32]}
        if args.archive.exists() or args.manifest.exists(): raise ValueError("export output already exists")
        os.link(temporary, args.archive)
        archive_sha = hashlib.sha256()
        with args.archive.open("rb") as source:
            for chunk in iter(lambda:source.read(1048576), b""): archive_sha.update(chunk)
        sync_json(args.manifest, {"version":1, "record":record, "files":files, "excluded":excluded,
                                 "archive_sha256":archive_sha.hexdigest(), "resource_release_verified":False, **({"capture_tool":capture_tool} if capture_tool else {})})
        return None
    finally:
        Path(temporary).unlink(missing_ok=True)


def verify(args):
    manifest = json.loads(args.manifest.read_text())
    if args.record and manifest.get("record") != json.loads(args.record.read_text()):
        raise ValueError("original launch record differs")
    record = manifest.get("record", {})
    if args.ref and record.get("source_ref") != args.ref: raise ValueError("source binding differs")
    if args.machine and record.get("machine_id") != args.machine: raise ValueError("native machine identity differs")
    if args.app and record.get("app") != args.app: raise ValueError("native app identity differs")
    if args.image and record.get("image") != args.image: raise ValueError("image binding differs")
    if args.caller and record.get("caller") != json.loads(args.caller.read_text()): raise ValueError("caller binding differs")
    if manifest.get('capture_tool'):
        capture=manifest['capture_tool']
        repo=getattr(args,'repo',None) or Path(git(Path(__file__).parent,'rev-parse','--show-toplevel'))
        expected_capture=capture_tool_binding(Path(repo),record,hashlib.sha256(args.record.read_bytes()).hexdigest() if args.record else capture['original_launch_sha256'],capture['source_ref'])
        if capture != expected_capture: raise ValueError('capture tool provenance differs')
    elif record.get("collector_sha256") != (globals().get("CHECKED_COLLECTOR_SHA256") or hashlib.sha256(checked_collector_bytes()).hexdigest()):
        raise ValueError("collector bytes differ")
    if manifest.get("version") != 1 or manifest.get("resource_release_verified") is not False:
        raise ValueError("export receipt does not permit resource release")
    digest = hashlib.sha256()
    with args.archive.open("rb") as source:
        for chunk in iter(lambda:source.read(1048576), b""): digest.update(chunk)
    if digest.hexdigest() != manifest["archive_sha256"]: raise ValueError("archive bytes differ")
    expected = manifest["files"]
    if 'continuation' in record:
        continuation=record['continuation']
        if continuation.get('new_ref') != record['source_ref'] or continuation.get('new_driver_pid') != record['driver_pid'] or continuation.get('new_driver_birth') != record['driver_birth'] or continuation.get('epoch') != record.get('epoch') or continuation.get('resource_release_verified') is not False:
            raise ValueError('continuation launch binding differs')
        if expected.get('controller-output/continuation.json',{}).get('sha256') != record['continuation_sha256']:
            raise ValueError('continuation original missing from archive')
    with tarfile.open(args.archive, "r:gz") as archive:
        members = archive.getmembers()
        if len(members) != len(expected) or {m.name for m in members} != set(expected): raise ValueError("archive membership differs")
        if manifest.get('capture_tool'):
            member=archive.getmember('controller-output/launch.json')
            if not member.isfile() or member.size > 67108864:
                raise ValueError('unsafe original launch member')
            source=archive.extractfile(member)
            if source is None: raise ValueError('original launch member missing')
            raw=source.read(67108865)
            if len(raw)>67108864 or hashlib.sha256(raw).hexdigest()!=manifest['capture_tool']['original_launch_sha256'] or json.loads(raw)!=record:
                raise ValueError('archived original launch differs from capture binding')
        if 'continuation' in record:
            member = archive.getmember('controller-output/continuation.json')
            if not member.isfile() or member.size > 1048576:
                raise ValueError('unsafe archived continuation original')
            source = archive.extractfile(member)
            if source is None: raise ValueError('missing archived continuation original')
            raw = source.read(1048577)
            if len(raw) > 1048576 or hashlib.sha256(raw).hexdigest() != record['continuation_sha256'] or json.loads(raw) != record['continuation']:
                raise ValueError('archived continuation differs from embedded receipt')
        for member in members:
            if member.name.startswith("/") or ".." in Path(member.name).parts: raise ValueError("unsafe archive name")
            row = expected[member.name]
            if row["kind"] == "file":
                source = archive.extractfile(member)
                if not member.isfile() or member.size != row["bytes"] or source is None: raise ValueError("archive type/size differs")
                value = hashlib.sha256()
                for chunk in iter(lambda:source.read(1048576), b""): value.update(chunk)
                if value.hexdigest() != row["sha256"]: raise ValueError("archive member bytes differ")
            elif row['kind'] == 'fifo':
                metadata=row['stat']
                if json.loads(member.pax_headers.get('cloudbench.fifo-source-stat','null')) != metadata or row.get('metadata_only') is not True or not member.isfifo() or member.size != 0 or member.linkname or not stat.S_ISFIFO(metadata['mode']) or metadata['bytes'] != 0 or metadata['nlink'] != 1 or member.mode != stat.S_IMODE(metadata['mode']) or member.uid != metadata['uid'] or member.gid != metadata['gid'] or Decimal(member.pax_headers.get('mtime','NaN'))*1000000000 != metadata['mtime_ns']:
                    raise ValueError('archive FIFO metadata differs')
            elif row["kind"] == "directory":
                if not member.isdir(): raise ValueError("archive directory differs")
            elif row["kind"] == "symlink":
                if not member.issym() or member.linkname != row["target"]: raise ValueError("archive link differs")
            else: raise ValueError("unsupported archive member kind")
    return 0


def maintenance_observe_runtime(repo, output, child_identity):
    """Canonical retained V39 runtime validation, lifted without weakening probes."""
    R, P = Path(repo), Path(output)
    fly = R / '.context/stress200-host/toolchain/flyctl'
    git_identity = child_identity
    runtime={}
    def info(path):
     path=Path(path);value={'path':str(path),'exists':path.exists(),'symlink':path.is_symlink()}
     try:
      st=path.lstat();value.update(mode=st.st_mode,uid=st.st_uid,gid=st.st_gid,inode=st.st_ino,link=os.readlink(path)if path.is_symlink()else None,resolved=str(path.resolve(strict=True)))
     except OSError as error:value['error']=type(error).__name__
     return value
    def sha_regular(path):
     path=Path(path);assert path.resolve(strict=True)==path and not path.is_symlink()
     fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
     try:
      st=os.fstat(fd);assert stat.S_ISREG(st.st_mode);h=hashlib.sha256()
      while True:
       chunk=os.read(fd,1048576)
       if not chunk:break
       h.update(chunk)
      after=os.fstat(fd);assert (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)==(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns)
      return h.hexdigest()
     finally:os.close(fd)
    venv=R/'agents/venv';runtime['venv']=info(venv);runtime['python']=info(venv/'bin/python3')
    try:
     bindings_path=R/'.context/stress200-host/controller-venv-bindings.private.json';runtime['bindings']=info(bindings_path)
     bindings=json.loads(bindings_path.read_bytes());runtime['bindings_sha256']=sha_regular(bindings_path)
     actual_venv=maintenance_runtime_directory(venv,bindings,R/'.context/stress200-host/toolchain')
     python=(venv/'bin/python3').resolve(strict=True);python_entry=(venv/'bin/python').resolve(strict=True)
     assert python_entry==python and os.access(python,os.X_OK)
     runtime['python_sha256']=sha_regular(python)
     assert runtime['python_sha256']=='d1483a82342508f2ec2b172b788d5b676a59eaf70ed01ae846a0f84f63a3a82a','retained Python binary differs from original native gate pin'
     lib=R/'.context/stress200-host/toolchain/python-runtime/python/lib/libpython3.11.so.1.0'
     runtime['libpython_sha256']=sha_regular(lib)
     assert runtime['libpython_sha256']=='2f252bc01e97da2248a5b9ce063c0b9bf02b216f84c2c1bbebb5673d29e3197b'
     private_site=actual_venv/'lib/python3.11/site-packages';bridge=private_site/'image-packages.pth'
     bridge_raw=bridge.read_bytes();assert bridge_raw==b"import site; site.addsitedir('/app/agents/venv/lib/python3.11/site-packages')\n"
     assert sha_regular(bridge)==bindings['package_bridge_sha256']
     assert set(private_site.glob('*.pth'))=={bridge}
     assert not (private_site/'sitecustomize.py').exists() and not (private_site/'usercustomize.py').exists()
     maintenance_path=str(fly.parent)+':'+str(venv/'bin')+':/usr/local/bin:/usr/bin:/bin'
     env=dict(os.environ,PATH=maintenance_path,HOME='/home/rose')
     probe="import hashlib,importlib.metadata,json,sys,sysconfig;from pathlib import Path;p=Path('/app/agents/venv/lib/python3.11/site-packages');rows=[]\nfor d in importlib.metadata.distributions(path=[str(p)]) if sys.argv[1]=='image' else importlib.metadata.distributions():\n rows.append({'name':d.metadata['Name'],'version':d.version,'metadata':{n:hashlib.sha256((Path(d._path)/n).read_bytes()).hexdigest() for n in ('METADATA','RECORD','entry_points.txt','top_level.txt','direct_url.json') if (Path(d._path)/n).is_file()}})\nprint(json.dumps({'soabi':sysconfig.get_config_var('SOABI'),'distributions':sorted(rows,key=lambda x:(x['name'],x['version']))}))"
     observed=[]
     for mode in ('image','effective'):
      result=subprocess.run([str(venv/'bin/python'),'-I','-B','-c',probe,mode],env=env,preexec_fn=git_identity,capture_output=True,timeout=8)
      runtime[mode+'_probe_returncode']=result.returncode;assert result.returncode==0
      observed.append(json.loads(result.stdout));runtime[mode+'_inventory_sha256']=hashlib.sha256(result.stdout).hexdigest()
     assert observed[0]==observed[1]==bindings['image_package_inventory'],'retained runtime package/ABI inventory differs from original binding'
     result=subprocess.run([str(venv/'bin/python'),'-I','-B','-c','import sys,ssl,json,hashlib,tarfile,fcntl,subprocess,base64,zlib;import dotenv,httpx,temporalio,pydantic,pydantic_core,numpy;assert sys.version_info[:3]==(3,11,9);print("runtime-ok")'],env=env,preexec_fn=git_identity,capture_output=True,timeout=8)
     runtime['stdlib_and_compiled_probe_returncode']=result.returncode;assert result.returncode==0 and result.stdout==b'runtime-ok\n'
     for name in ['bash','git','flock','sha256sum','tar','python3','flyctl']:
      path=shutil.which(name,path=maintenance_path);assert path and os.access(path,os.X_OK),'required existing runtime missing: '+name
     version=subprocess.run([str(fly),'version'],env=env,preexec_fn=git_identity,capture_output=True,timeout=5);runtime['flyctl_version_returncode']=version.returncode
     assert version.returncode==0,'pinned existing flyctl is not runnable as rose'
    except BaseException as error:
     runtime['failure']=type(error).__name__;raise
    finally:
     with (P/'runtime-observed.private.json').open('x')as out:json.dump(runtime,out,sort_keys=True);out.flush();os.fsync(out.fileno())
    return dict(runtime=runtime, maintenance_path=maintenance_path, python=python)


def maintenance_runtime_directory(venv, binding, toolchain_root):
    """Select only the directory in the original runtime receipt; no ABI credit."""
    venv, toolchain_root = Path(venv), Path(toolchain_root)
    expected = Path(binding['private_venv_target'])
    actual = venv.resolve(strict=True)
    if (not expected.is_absolute() or expected.resolve(strict=True) != actual
            or toolchain_root.resolve(strict=True) != toolchain_root
            or not actual.is_relative_to(toolchain_root) or not actual.is_dir()):
        raise ValueError('retained runtime directory differs from original binding')
    return actual


def maintenance_process_identity(observed, expected, *, states=('R', 'S', 'T')):
    """Process ownership is independent of the workspace owner's UID."""
    keys = ('pid', 'birth', 'ppid', 'uid', 'argv')
    if (any(observed.get(k) != expected.get(k) for k in keys)
            or observed.get('state') not in states
            or (observed.get('uids') is not None and observed['uids'] != [expected['uid']] * 4)):
        raise ValueError('maintenance process identity/state differs: ' + json.dumps(observed, sort_keys=True))
    return observed


def maintenance_inventory(required, optional, trees):
    """Capture exact presence and typed entries without following links or FIFOs."""
    entries, presence = {}, {}
    def entry(path):
        path = Path(path)
        if not path.is_absolute() or path.parent.resolve(strict=True) != path.parent:
            raise ValueError('redirected preservation parent')
        before = path.lstat()
        value = dict(mode=before.st_mode, uid=before.st_uid, gid=before.st_gid,
                     device=before.st_dev, inode=before.st_ino, size=before.st_size,
                     mtime_ns=before.st_mtime_ns)
        if stat.S_ISREG(before.st_mode):
            value.update(kind='regular', sha256=sealed_bytes(path)[0])
        elif stat.S_ISLNK(before.st_mode):
            value.update(kind='symlink', link=os.readlink(path))
        elif stat.S_ISDIR(before.st_mode): value['kind'] = 'directory'
        elif stat.S_ISFIFO(before.st_mode): value['kind'] = 'fifo'
        elif stat.S_ISSOCK(before.st_mode): value['kind'] = 'socket'
        else: raise ValueError('unsupported preservation entry')
        after = path.lstat()
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('preservation entry changed while read')
        entries[str(path)] = value
    for path in map(Path, required):
        if path.is_symlink() or not path.is_file(): raise ValueError('required original missing or redirected')
        entry(path)
    for path in map(Path, optional):
        if path.is_symlink(): raise ValueError('optional original redirected')
        presence[str(path)] = path.exists()
        if path.exists(): entry(path)
    def walk(path):
        entry(path)
        if stat.S_ISDIR(path.lstat().st_mode):
            for child in sorted(path.iterdir()): walk(child)
    for path in map(Path, trees):
        if str(path) in presence and not presence[str(path)]: continue
        if path.is_symlink() or not path.is_dir(): raise ValueError('preservation root missing or redirected')
        walk(path)
    return dict(entries=entries, presence=presence)


def maintenance_run_child(argv, uid, gid, **kwargs):
    """Only the forked Git/token child drops privilege; coordinator keeps seals."""
    if type(uid) is not int or type(gid) is not int or min(uid, gid) < 0 or 'preexec_fn' in kwargs:
        raise ValueError('explicit child identity required')
    return subprocess.run(argv, preexec_fn=maintenance_child_identity(uid, gid), **kwargs)


def maintenance_child_identity(uid, gid):
    if type(uid) is not int or type(gid) is not int or min(uid, gid) < 0:
        raise ValueError('explicit child identity required')
    def identity():
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)
    return identity


def maintenance_operation_directory(parent, child):
    parent, child = Path(parent), Path(child)
    if (not parent.is_absolute() or child.parent != parent or child.name in ('', '.', '..')
            or parent.parent.resolve(strict=True) != parent.parent):
        raise ValueError('operation must be a direct child of the physical fixed parent')
    try: parent.mkdir(mode=0o700)
    except FileExistsError: pass
    info = parent.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700 or parent.resolve(strict=True) != parent):
        raise ValueError('operation parent must be private, owned and unlinked')
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError('operation parent changed')
        os.mkdir(child.name, mode=0o700, dir_fd=fd)
        os.fsync(fd)
    finally: os.close(fd)
    return child


def maintenance_wait_stopped(expected, observe, children, stop, clock, sleep, *, timeout=2):
    """Request STOP only for exact idle init; scheduler states may precede T."""
    if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError('positive finite stop deadline required')
    observed = maintenance_process_identity(observe(expected['pid']), expected)
    for child in children():
        if (child.get('ppid') != expected['pid'] or child.get('uid') != expected['uid']
                or child.get('argv') not in (['sleep','60'],['/bin/sleep','60'],['/usr/bin/sleep','60'])):
            raise ValueError('unexpected idle-init child')
    observed = maintenance_process_identity(observe(expected['pid']), expected)
    if observed['state'] != 'T': stop(expected['pid'])
    deadline = clock() + timeout
    while True:
        observed = maintenance_process_identity(observe(expected['pid']), expected, states=('R','S','D','T'))
        if observed['state'] == 'T': return observed
        if clock() >= deadline: raise TimeoutError('init did not stop: ' + json.dumps(observed, sort_keys=True))
        sleep(0.05)


def maintenance_tool_environment(binary, digest, size, environment):
    """Verify the retained tool and prepend only the child environment PATH."""
    binary = Path(binary)
    if binary.resolve(strict=True) != binary: raise ValueError('retained tool redirected')
    before = binary.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size != size or not os.access(binary, os.X_OK):
        raise ValueError('retained tool is not the recorded executable regular file')
    actual, _ = sealed_bytes(binary)
    after = binary.lstat()
    if actual != digest or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns) != (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):
        raise ValueError('retained tool digest or identity differs')
    env = dict(environment)
    env['PATH'] = str(binary.parent) + os.pathsep + env.get('PATH', os.defpath)
    return env


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("caller","launch","export","verify","continue"))
    for name in ("repo","record","caller","archive","manifest","pending","continuation","old-record","old-manifest","old-archive"): parser.add_argument("--"+name,type=Path)
    parser.add_argument("--capture-tool-ref")
    parser.add_argument("--finalize-disposable-hubs", action="store_true")
    parser.add_argument("--epoch", type=float)
    parser.add_argument("--driver-pid", type=int); parser.add_argument("--ref"); parser.add_argument("--image")
    parser.add_argument("--machine"); parser.add_argument("--app")
    args = parser.parse_args()
    if args.action == "caller":
        identity = birth(args.driver_pid)
        if not identity: raise ValueError("original caller birth unavailable")
        sync_json(args.record, {"host":socket.gethostname(),"pid":args.driver_pid,"birth":identity})
        return 0
    if args.action == "continue": continue_launch(args); return 0
    if args.action == "launch": launch(args); return 0
    if args.action == "export":
        try: return export(args)
        except (OSError,ValueError,KeyError,tarfile.TarError) as exc:
            if args.pending and not args.pending.exists():
                sync_json(args.pending, {"status":"pending","reason":str(exc),"resource_release_verified":False})
            raise
    return verify(args)

if __name__ == "__main__":
    try: raise SystemExit(main())
    except (OSError,ValueError,KeyError,tarfile.TarError) as exc:
        print("controller export pending: " + type(exc).__name__, file=__import__('sys').stderr)
        raise SystemExit(75)
