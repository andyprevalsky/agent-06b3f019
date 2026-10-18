#!/usr/bin/env python3
"""One owned SFTP stream for hash-bound controller sidecars; unknown writes never replay."""

import base64
import gzip
import io
import json
import os
import secrets
import shlex
import tarfile
import time
from pathlib import Path

LIMIT = 16 * 1024 * 1024

REMOTE = r"""
import base64,ctypes,errno,gzip,hashlib,io,json,os,pwd,stat,sys,tarfile,time
from pathlib import Path
def execute(v,root=Path('/tmp')):
 def need(ok,message):
  if not ok:raise ValueError(message)
 def sha(raw):return hashlib.sha256(raw).hexdigest()
 def stable(s):return(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
 def read(path,limit,owners,private=True):
  need(path.resolve(strict=True)==path,'aliased bulk input')
  with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb')as stream:
   before=os.fstat(stream.fileno());need(stat.S_ISREG(before.st_mode)and before.st_nlink==1 and before.st_uid in owners and not before.st_mode&(0o077 if private else 0o022)and 0<=before.st_size<=limit,'unsafe bulk input')
   raw=stream.read(before.st_size+1);need(stable(before)==stable(os.fstat(stream.fileno()))==stable(path.lstat())and len(raw)==before.st_size,'bulk input changed')
  return raw
 def sync(path):
  fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
 def save(path,value):
  raw=(json.dumps(value,sort_keys=True,allow_nan=False)+'\n').encode()
  fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb')as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
  sync(path.parent)
 binding=v['binding'];identity=sha(json.dumps(binding,sort_keys=True,allow_nan=False).encode())
 need(identity==v['identity_sha256']and os.environ['FLY_MACHINE_ID']==binding['machine']and os.environ['GATE_REF']==binding['source_ref'],'foreign bulk target')
 need(time.time()<binding['deadline']and binding['deadline']==binding['epoch']+5400,'original bulk deadline expired')
 user=pwd.getpwnam('rose');need(os.geteuid()in(0,user.pw_uid),'foreign bulk executor');stage=root/('controller-bulk-'+identity)
 envelope=read(root/'controller-launch-payload.json.gz',256*1024,{0,user.pw_uid},False)
 need(sha(envelope)==binding['envelope_sha256'],'bulk envelope changed')
 with gzip.GzipFile(fileobj=io.BytesIO(envelope))as stream:raw=stream.read(16*1024*1024)
 need(len(raw)<16*1024*1024,'bulk envelope too large');manifest=json.loads(raw)
 need(manifest['source_ref']==binding['source_ref']and manifest['epoch']==binding['epoch'],'bulk source/clock changed')
 files={entry['transfer_sha256']:entry['transfer_bytes']for entry in manifest['remote_files']if entry.get('encoding')=='external-gzip'}
 need(files==binding['files']and all(entry['transfer_path']=='/tmp/controller-sidecar-'+entry['transfer_sha256']+'.gz'for entry in manifest['remote_files']if entry.get('encoding')=='external-gzip'),'bulk descriptor changed')
 need(files and sum(files.values())<16*1024*1024 and all(0<n<16*1024*1024 for n in files.values()),'bounded bulk files required')
 boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
 libc=ctypes.CDLL(None,use_errno=True);rename=getattr(libc,'renameat2',None)
 need(rename is not None,'atomic exclusive rename unavailable')
 if v['action']=='init':
  stage.mkdir(mode=0o700);sync(root)
  probe=stage/'rename-probe';fd=os.open(probe,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.close(fd)
  need(rename(-100,os.fsencode(probe),-100,os.fsencode(stage/'renamed-probe'),1)==0,'atomic exclusive rename unsupported')
  (stage/'renamed-probe').unlink();sync(stage)
  save(stage/'intent.json',dict(binding=binding,identity_sha256=identity,boot_id=boot))
  return dict(state='INITIALIZED',identity_sha256=identity)
 need(stage.resolve(strict=True)==stage,'aliased bulk stage');info=stage.lstat()
 need(stat.S_ISDIR(info.st_mode)and info.st_uid==os.geteuid()and not info.st_mode&0o077,'foreign bulk stage')
 intent=json.loads(read(stage/'intent.json',1024*1024,{os.geteuid()}))
 need(intent==dict(binding=binding,identity_sha256=identity,boot_id=boot),'bulk incarnation/intent changed')
 def published():
  for digest,size in files.items():
   try:data=read(root/('controller-sidecar-'+digest+'.gz'),size,{user.pw_uid})
   except FileNotFoundError:return False
   need(len(data)==size and sha(data)==digest,'published bulk bytes differ')
  return True
 def uploaded():
  try:data=read(stage/'payload.tar',17*1024*1024,{os.geteuid()})
  except FileNotFoundError:return False
  return len(data)==binding['archive_bytes']and sha(data)==binding['archive_sha256']
 if v['action']=='observe':
  ready=stage/'ready.json';done=False
  if ready.exists():
   need(json.loads(read(ready,1024*1024,{os.geteuid()}))==dict(state='READY',identity_sha256=identity,files=files),'bulk ready differs');done=published()
  return dict(state='OBSERVED',identity_sha256=identity,uploaded=uploaded(),ready=done)
 need(v['action']=='commit','unknown bulk action');save(stage/'commit.intent.json',dict(identity_sha256=identity,no_replay=True))
 need(uploaded(),'bulk archive incomplete');data=read(stage/'payload.tar',17*1024*1024,{os.geteuid()})
 selected={}
 with tarfile.open(fileobj=io.BytesIO(data),mode='r:')as archive:
  for member in archive:
   need(member.name in files and member.name not in selected and member.isfile()and member.size==files[member.name],'foreign bulk archive member')
   content=archive.extractfile(member).read(member.size+1);need(len(content)==member.size and sha(content)==member.name,'bulk member hash differs');selected[member.name]=content
 need(set(selected)==set(files),'incomplete bulk archive')
 for digest,content in selected.items():
  temporary=stage/('publish-'+digest);fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb')as stream:stream.write(content);stream.flush();os.fchown(stream.fileno(),user.pw_uid,user.pw_gid);os.fchmod(stream.fileno(),0o600);os.fsync(stream.fileno())
  sync(stage);need(time.time()<binding['deadline'],'bulk publish deadline expired')
  destination=root/('controller-sidecar-'+digest+'.gz')
  if rename(-100,os.fsencode(temporary),-100,os.fsencode(destination),1)!=0:
   code=ctypes.get_errno();need(code==errno.EEXIST,'exclusive bulk rename failed')
   existing=read(destination,len(content),{user.pw_uid});need(existing==content,'existing bulk destination differs');temporary.unlink()
  sync(root);sync(stage)
 need(published(),'bulk publication incomplete');need(time.time()<binding['deadline'],'bulk ready deadline expired')
 result=dict(state='READY',identity_sha256=identity,files=files);save(stage/'ready.json',result);return result
"""


def command(binding, identity, action):
    packed = gzip.compress(
        json.dumps(
            [
                REMOTE,
                {"binding": binding, "identity_sha256": identity, "action": action},
            ],
            sort_keys=True,
        ).encode(),
        mtime=0,
    )
    loader = "import base64,gzip,json,sys;s,v=json.loads(gzip.decompress(base64.b64decode(sys.argv[1])));exec(s);print(json.dumps(execute(v),sort_keys=True))"
    cmd = shlex.join(["python3", "-S", "-c", loader, base64.b64encode(packed).decode()])
    if len(json.dumps({"cmd": cmd, "timeout": 20, "machine": True}).encode()) > 6200:
        raise ValueError("bounded bulk control command required")
    return cmd


def transfer(
    api, mid, record, out, envelope_sha, deadline, cancelled, *, runtime, source_sha256
):
    """Use one exact-MID authenticated SFTP connection; never repeat put or commit."""
    need, read, save, sha = (runtime[key] for key in ("need", "read", "save", "sha"))
    need(
        sha(Path(__file__).read_bytes()) == source_sha256, "bulk helper source changed"
    )
    descriptor_path = out / "controller-sidecars.private.json"
    if not descriptor_path.exists():
        return
    descriptor_raw = read(descriptor_path)
    descriptors = json.loads(descriptor_raw)
    journal = out / "payload-bulk-transfer"
    journal.mkdir(mode=0o700)
    sequence = 0

    def active():
        need(
            sha(Path(__file__).read_bytes()) == source_sha256,
            "bulk helper source changed",
        )
        need(not cancelled(), "bulk transfer cancelled")
        need(time.time() < deadline, "original bulk deadline expired")

    def native_once(label):
        nonlocal sequence
        active()
        sequence += 1
        prefix = journal / f"{sequence:04d}-{label}"
        save(
            Path(str(prefix) + ".request.json"),
            {"method": "GET", "path": "/machines/" + mid},
        )

        def observer(method, path, status, raw):
            need(
                method == "GET" and path == "/machines/" + mid,
                "foreign bulk native response",
            )
            save(
                Path(str(prefix) + ".raw.json"),
                {
                    "method": method,
                    "path": path,
                    "status": status,
                    "body_b64": base64.b64encode(raw).decode(),
                    "sha256": sha(raw),
                },
            )

        with runtime["bounded"](min(20, deadline - time.time())):
            current = api.api(
                "GET",
                "/machines/" + mid,
                timeout=max(1, int(min(20, deadline - time.time()))),
                observer=observer,
            )
        save(Path(str(prefix) + ".decoded.json"), current)
        active()
        need(
            all(
                current.get(key) == record.get(key)
                for key in ("id", "instance_id", "config", "name", "region")
            ),
            "bulk target incarnation changed",
        )
        need(
            current.get("state") in ("started", "created", "starting"),
            "bulk target inactive",
        )
        need(current.get("state") == "started", "bulk target not started")

    def native(label):
        while True:
            try:
                return native_once(label)
            except runtime["Deadline"]:
                active()
                save(
                    journal / f"{sequence:04d}-read-pending.json",
                    {
                        "read_only": True,
                        "error": "Deadline",
                        "original_deadline": deadline,
                    },
                )
                time.sleep(min(0.2, max(0, deadline - time.time())))

    files = {}
    contents = {}
    for entry in descriptors:
        data = read(entry["path"])
        need(
            0 < len(data) < LIMIT
            and len(data) == entry["bytes"]
            and sha(data) == entry["sha256"],
            "bulk source bytes changed",
        )
        need(entry["sha256"] not in files, "duplicate bulk sidecar")
        files[entry["sha256"]] = len(data)
        contents[entry["sha256"]] = data
    need(files and sum(files.values()) < LIMIT, "bounded bulk archive required")
    archive = journal / "payload.tar"
    with archive.open("xb") as stream:
        os.chmod(archive, 0o600)
        with tarfile.open(fileobj=stream, mode="w:") as tar:
            for digest, data in sorted(contents.items()):
                member = tarfile.TarInfo(digest)
                member.size = len(data)
                member.mode = 0o600
                tar.addfile(member, io.BytesIO(data))
        stream.flush()
        os.fsync(stream.fileno())
    need(archive.stat().st_size < LIMIT, "bulk tar too large")
    archive_raw = read(archive)
    need(len(archive_raw) <= LIMIT + 1024 * 1024, "bulk tar too large")
    binding = {
        "machine": mid,
        "instance_id": record["instance_id"],
        "source_ref": record["config"]["env"]["GATE_REF"],
        "envelope_sha256": envelope_sha,
        "epoch": deadline - 5400,
        "deadline": deadline,
        "files": files,
        "archive_sha256": sha(archive_raw),
        "archive_bytes": len(archive_raw),
        "descriptor_sha256": sha(descriptor_raw),
        "invocation": secrets.token_hex(16),
    }
    identity = sha(json.dumps(binding, sort_keys=True, allow_nan=False).encode())
    for action in ("init", "commit", "observe"):
        command(binding, identity, action)
    remote = "/tmp/controller-bulk-" + identity
    save(
        journal / "intent.json",
        {"binding": binding, "identity_sha256": identity, "original_machine": record},
    )

    def transport(label, *argv):
        active()
        native(label + "-before")
        active()
        save(
            journal / (label + ".intent.json"),
            {"argv": argv, "identity_sha256": identity, "once": True},
        )
        try:
            rc, stdout, stderr = api.flyctl(min(20, deadline - time.time()), *argv)
        except BaseException as error:
            save(
                journal / (label + ".unknown.json"),
                {
                    "error": type(error).__name__,
                    "stdout": getattr(error, "stdout", b"").decode("utf-8", "replace"),
                    "stderr": getattr(error, "stderr", b"").decode("utf-8", "replace"),
                    "owned_transport_joined": True,
                    "no_blind_retry": True,
                },
            )
            raise
        save(
            journal / (label + ".result.json"),
            {
                "exit_code": rc,
                "stdout": stdout,
                "stderr": stderr,
                "owned_transport_joined": True,
            },
        )
        active()
        native(label + "-after")
        active()
        return rc, stdout, stderr

    def control(action, label=None):
        cmd = command(binding, identity, action)
        rc, stdout, _stderr = transport(
            label or action,
            "ssh",
            "console",
            "-a",
            runtime["APP"],
            "--machine",
            mid,
            "-C",
            cmd,
        )
        need(rc == 0, "bulk control uncertain: " + action)
        result = json.loads(stdout)
        need(
            result["identity_sha256"] == identity,
            "bulk acknowledgement identity differs",
        )
        return result

    while True:
        active()
        try:
            native("starting")
            break
        except ValueError as error:
            if str(error) != "bulk target not started":
                raise
            active()
            time.sleep(min(0.2, max(0, deadline - time.time())))
    need(
        control("init") == {"state": "INITIALIZED", "identity_sha256": identity},
        "bulk initialization differs",
    )
    upload_error = None
    try:
        rc, _, _ = transport(
            "upload",
            "ssh",
            "sftp",
            "put",
            "-a",
            runtime["APP"],
            "--machine",
            mid,
            "-q",
            "-m",
            "0600",
            str(archive),
            remote + "/payload.tar",
        )
        if rc != 0:
            upload_error = "exit " + str(rc)
    except (OSError, ValueError) as error:
        upload_error = type(error).__name__
    if upload_error:
        active()
        save(
            journal / "upload.pending.json",
            {"error": upload_error, "no_blind_retry": True},
        )
        observation = control("observe", "observe-upload")
        need(observation.get("uploaded") is True, "bulk upload remains unknown")
    active()
    try:
        result = control("commit")
        need(
            result == {"state": "READY", "identity_sha256": identity, "files": files},
            "bulk publication acknowledgement differs",
        )
    except (OSError, ValueError) as error:
        active()
        save(
            journal / "commit.pending.json",
            {"error": type(error).__name__, "no_blind_retry": True},
        )
        result = control("observe", "observe-commit")
        need(result.get("ready") is True, "bulk commit remains unknown")
    active()
    need(
        read(descriptor_path) == descriptor_raw and read(archive) == archive_raw,
        "bulk local input changed",
    )
    native("complete")
    save(
        journal / "complete.json",
        {
            "identity_sha256": identity,
            "binding": binding,
            "one_upload": True,
            "no_write_retry": True,
            "owned_transports_joined": True,
        },
    )
