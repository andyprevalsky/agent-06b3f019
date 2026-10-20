#!/usr/bin/env python3
"""Namespace-bound, streamed evidence export; no host-side /data traversal."""

import base64
import hashlib
import json
import os
from pathlib import Path
import selectors
import shlex
import stat
import subprocess
import tempfile
import time

READ = r"""
import base64,hashlib,json,os,stat,sys
parts=sys.argv[1].split('/')
assert parts[:2]==['','data'] and all(p not in ('','.','..') for p in parts[2:])
fd=os.open('/data',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for part in parts[2:-1]:
  other=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  os.close(fd);fd=other
 file=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
 with os.fdopen(file,'rb') as stream:
  assert stat.S_ISREG(os.fstat(stream.fileno()).st_mode)
  digest=hashlib.sha256();length=0
  print('CLOUDBENCH_FILE_BEGIN',flush=True)
  while True:
   data=stream.read(49152)
   if not data:break
   digest.update(data);length+=len(data)
   print(base64.b64encode(data).decode(),flush=True)
  print('CLOUDBENCH_FILE_END:'+json.dumps(dict(sha256=digest.hexdigest(),length=length)),flush=True)
finally:os.close(fd)
"""


def export_file(proof, remote, local, command_builder):
    if not remote.startswith("/data/"):
        raise ValueError("archived export requires logical /data file")
    command = command_builder(proof, shlex.join(["python3", "-S", "-c", READ, remote]))
    path = Path(local)
    if path.is_symlink() or path.parent.resolve(strict=True) != path.parent.absolute():
        raise ValueError("physical local evidence parent required")
    temporary = tempfile.NamedTemporaryFile(prefix=".cloudbench-export-", dir=path.parent, delete=False)
    pending = Path(temporary.name)
    child = None
    try:
        with tempfile.TemporaryFile() as errors:
            child = subprocess.Popen(
                [
                    "flyctl",
                    "ssh",
                    "console",
                    "-a",
                    "navi-whisper-lux-bench",
                    "--machine",
                    proof["machine_id"],
                    "-C",
                    command,
                ],
                stdout=subprocess.PIPE,
                stderr=errors,
            )
            digest = hashlib.sha256()
            length = 0
            begun = ended = False
            buffer = b""
            deadline = time.monotonic() + 60
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("namespace file export deadline")
                    if not selector.select(remaining):
                        raise TimeoutError("namespace file export deadline")
                    chunk = os.read(child.stdout.fileno(), 65536)
                    if not chunk:
                        selector.unregister(child.stdout)
                        break
                    buffer += chunk
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        if line == b"CLOUDBENCH_FILE_BEGIN":
                            if begun:
                                raise ValueError("duplicate namespace export")
                            begun = True
                        elif line.startswith(b"CLOUDBENCH_FILE_END:"):
                            envelope = json.loads(line[len(b"CLOUDBENCH_FILE_END:") :])
                            if not begun or ended or envelope != dict(sha256=digest.hexdigest(), length=length):
                                raise ValueError("namespace evidence hash/length mismatch")
                            ended = True
                        elif begun and not ended:
                            raw = base64.b64decode(line, validate=True)
                            digest.update(raw)
                            length += len(raw)
                            temporary.write(raw)
                    if len(buffer) > 70000:
                        raise ValueError("malformed namespace export framing")
            if child.wait(timeout=max(0.001, deadline - time.monotonic())) != 0 or not ended or buffer:
                raise ValueError("namespace file export incomplete")
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary.close()
            if path.exists():
                if not stat.S_ISREG(path.stat().st_mode):
                    raise ValueError("existing evidence is not regular")
                existing = hashlib.sha256()
                with path.open("rb") as stream:
                    for block in iter(lambda: stream.read(65536), b""):
                        existing.update(block)
                if path.stat().st_size != length or existing.hexdigest() != digest.hexdigest():
                    raise ValueError("existing evidence differs")
            else:
                os.link(pending, path, follow_symlinks=False)
            fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        if child is not None:
            if child.poll() is None:
                child.kill()
            child.wait()
            child.stdout.close()
        temporary.close()
        pending.unlink(missing_ok=True)


def external_command(proof, command, raw):
    """Guest verifier owns live namespace/PID certificate validation before exec."""
    import shlex

    successor = proof["successor"]
    env = [
        "env",
        "CLOUDBENCH_STORAGE_MODE=" + proof["storage_mode"],
        "CLOUDBENCH_ARCHIVED_REUSE_PROOF_B64=" + base64.b64encode(raw).decode(),
        "CLOUDBENCH_ARCHIVED_REUSE_PROOF_SHA256=" + hashlib.sha256(raw).hexdigest(),
        "FLY_MACHINE_ID=" + proof["machine_id"],
        "REF=" + successor["task_ref"],
        "CLOUDBENCH_RUN_TOKEN=" + successor["owner_token"] + "-" + str(successor["ordinal"]),
    ]
    return shlex.join(
        env + ["python3", "/cloudbench-isolated-generation.py", "--external-exec", "/bin/bash", "-c", command]
    )
