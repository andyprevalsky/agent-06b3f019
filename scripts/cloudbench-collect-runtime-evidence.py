#!/usr/bin/env python3
"""Collect a sealed, exact-owner runtime evidence bundle over the status data plane."""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

destination, port, run_token, machine, deadline = sys.argv[1:]
os.umask(0o077)
assert port.isascii() and port.isdigit() and 1 <= int(port) <= 65535
assert deadline.isascii() and deadline.isdigit() and int(deadline) > 0
assert re.fullmatch(r"[A-Za-z0-9._-]+", run_token) and machine
maximum = 512 * 1024 * 1024
parent = Path(destination)
intent = parent.parent / "runtime-evidence.pending"
owner = intent.with_name("runtime-evidence.owner.json")
for path in (owner, intent):
    assert not path.is_symlink() and path.is_file()
    assert json.loads(path.read_text()) == {"version": 1, "run_token": run_token, "machine_id": machine}
def timed_out(_signum, _frame):
    raise TimeoutError("terminal runtime evidence deadline expired")
signal.signal(signal.SIGALRM, timed_out)
signal.alarm(int(deadline))
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
headers = {"Authorization": "Bearer " + os.environ["CLOUDBENCH_BARRIER_TOKEN"],
           "X-Cloudbench-Run-Token": run_token, "X-Cloudbench-Machine-Id": machine}
url = f"http://127.0.0.1:{port}/runtime-evidence"
shutdown_url = f"http://127.0.0.1:{port}/shutdown-health"
def request(suffix=""):
    return opener.open(urllib.request.Request(url + suffix, headers=headers), timeout=6)
def manifest():
    with request() as response:
        data = response.read(1048577)
        assert len(data) <= 1048576 and response.status == 200
        return json.loads(data)
# DONE is emitted before the guest's EXIT trap drains the worker and seals the
# runtime. A 409 at this boundary means the exact guest is still cleaning up;
# it is not an immutable artifact failure. The alarm bounds seal wait and the
# complete transfer together. Once sealed, any changed manifest still fails.
while True:
    try:
        expected = manifest()
        break
    except urllib.error.HTTPError as error:
        if error.code != 409:
            raise
        # A 409 is normal while the guest drains, but the same authenticated
        # guest can already know that its driver exited without a cleanup ACK.
        # That terminal state can never publish runtime evidence, so fail closed
        # now instead of consuming the full recovery deadline.
        try:
            with opener.open(urllib.request.Request(shutdown_url, headers=headers), timeout=6) as response:
                assert response.status in (202, 204)
        except urllib.error.HTTPError as shutdown_error:
            if shutdown_error.code == 500:
                raise RuntimeError("driver exited without cleanup acknowledgement") from shutdown_error
            if shutdown_error.code not in (409, 503):
                raise
        time.sleep(0.5)
assert expected["version"] == 1 and expected["run_token"] == run_token and expected["machine_id"] == machine
files = expected["files"]
required = {"services.json", "run.json", "stack.log", "logs/backend.log", f"cloudbench-stack-cleanup-{run_token}.status"}
assert isinstance(files, dict) and required <= files.keys() and len(files) <= 1030
total = 0
for name, metadata in files.items():
    assert name in required or re.fullmatch(r"logs/worker(?:\.[1-9][0-9]*)?\.log", name)
    assert set(metadata) == {"bytes", "sha256"}
    assert type(metadata["bytes"]) is int and metadata["bytes"] >= 0
    assert re.fullmatch(r"[0-9a-f]{64}", metadata["sha256"])
    total += metadata["bytes"]
assert total <= maximum
final = parent / "runtime-evidence"
assert not final.exists() and not final.is_symlink()
pending = Path(tempfile.mkdtemp(prefix=".runtime-evidence-", dir=parent))
for name, metadata in files.items():
    target = pending / name
    target.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    remaining = metadata["bytes"]
    with request("?" + urllib.parse.urlencode({"file": name})) as response, target.open("xb") as output:
        assert response.status == 200 and response.headers.get("Content-Length") == str(remaining)
        while remaining:
            chunk = response.read(min(65536, remaining))
            assert chunk, "runtime evidence response ended early"
            output.write(chunk)
            digest.update(chunk)
            remaining -= len(chunk)
        assert not response.read(1), "runtime evidence response exceeded manifest"
        output.flush()
        os.fsync(output.fileno())
    assert digest.hexdigest() == metadata["sha256"], "runtime evidence hash mismatch"
services = json.loads((pending / "services.json").read_text())
count = services["env"]["worker_processes"]
assert services["status"] == "stopped" and type(count) is int and 1 <= count <= 1024
assert set(files) == required | {"logs/worker.log", *(f"logs/worker.{i}.log" for i in range(1, count))}
assert manifest() == expected, "runtime evidence changed across collection"
with (pending / "manifest.json").open("x") as output:
    json.dump(expected, output, sort_keys=True)
    output.write("\n")
    output.flush()
    os.fsync(output.fileno())
# Persist child directory entries before acknowledging the published capture.
# File fsync alone does not make their names durable across controller failure.
for directory in (pending / "logs", pending):
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
pending.rename(final)
descriptor = os.open(parent, os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
signal.alarm(0)
