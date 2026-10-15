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
import sys

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
            paths = [os.readlink(process / "cwd")]
            for fd in (process / "fd").iterdir():
                try: paths.append(os.readlink(fd))
                except FileNotFoundError: continue
            for line in (process / "maps").read_text().splitlines():
                fields = line.split(None, 5)
                if len(fields) == 6 and "w" in fields[1]: paths.append(fields[5])
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
    if active:
        sync_json(args.pending, {"status":"pending", "reason":"live controller writers", "writers":active,
                                 "record_sha256":hashlib.sha256(args.record.read_bytes()).hexdigest()})
        return 75
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
                                    raise ValueError("original changed before export")
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
        if writers(roots, permitted) or any(file_state(path) != before for path,before in observed.items()):
            raise ValueError("controller originals changed during export")
        if args.archive.exists() or args.manifest.exists(): raise ValueError("export output already exists")
        os.link(temporary, args.archive)
        archive_sha = hashlib.sha256()
        with args.archive.open("rb") as source:
            for chunk in iter(lambda:source.read(1048576), b""): archive_sha.update(chunk)
        sync_json(args.manifest, {"version":1, "record":record, "files":files, "excluded":excluded,
                                 "archive_sha256":archive_sha.hexdigest(), "resource_release_verified":False, **({"capture_tool":capture_tool} if capture_tool else {})})
        return 0
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("caller","launch","export","verify","continue"))
    for name in ("repo","record","caller","archive","manifest","pending","continuation","old-record","old-manifest","old-archive"): parser.add_argument("--"+name,type=Path)
    parser.add_argument("--capture-tool-ref")
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
