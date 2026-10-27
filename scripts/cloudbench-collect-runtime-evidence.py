#!/usr/bin/env python3
"""Collect a sealed, exact-owner runtime evidence bundle over the status data plane."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

destination, port, run_token, machine, deadline = sys.argv[1:6]
options = sys.argv[6:]
if options not in ([], ["--driver-log"]):
    raise SystemExit(f"unsupported runtime evidence options: {options}")
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
class RuntimeEvidenceDeadline(RuntimeError):
    """The whole capture budget expired, not one retryable socket read."""

def timed_out(_signum, _frame):
    raise RuntimeEvidenceDeadline("terminal runtime evidence deadline expired")
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
driver_url = f"http://127.0.0.1:{port}/driver-health"
ack_url = f"http://127.0.0.1:{port}/cloudbench-driver-clean-{run_token}.ack"
def request(suffix=""):
    return opener.open(urllib.request.Request(url + suffix, headers=headers), timeout=6)
def manifest():
    with request() as response:
        data = response.read(1048577)
        assert len(data) <= 1048576 and response.status == 200
        return json.loads(data)
def collect_driver_log():
    """Preserve the exact original log through the existing bounded protocol."""
    target = parent / "cloudbench-driver.log"
    stamp = ("RUNSTAMP-" + run_token + "\n").encode()
    original = None
    if target.exists() or target.is_symlink():
        assert target.is_file() and not target.is_symlink() and target.stat().st_size <= maximum
        original = target.stat()
        with target.open("rb") as source:
            assert source.readline(len(stamp) + 1) == stamp, "driver log belongs to another run"
    descriptor, temporary = tempfile.mkstemp(prefix=".cloudbench-driver-", dir=parent)
    history, published = None, False
    try:
        offset, size, generation, tail = 0, None, "", b""
        with os.fdopen(descriptor, "wb") as output:
            while True:
                query = urllib.parse.urlencode({"offset": offset, "limit": 262144})
                log_headers = {**headers, "X-Cloudbench-Log-Anchor": hashlib.sha256(tail).hexdigest(),
                               "X-Cloudbench-Log-Generation": generation}
                with opener.open(urllib.request.Request(f"http://127.0.0.1:{port}/bench.log?{query}", headers=log_headers), timeout=6) as response:
                    current_generation = response.headers.get("X-Cloudbench-Log-Generation", "")
                    assert re.fullmatch(r"[0-9a-f]{32}", current_generation)
                    assert not generation or current_generation == generation, "driver log generation changed"
                    generation = current_generation
                    assert response.headers.get("X-Cloudbench-Log-Continuity") == "1"
                    if response.status == 204:
                        assert offset > 0 and response.headers.get("X-Cloudbench-Log-Size") == str(offset) and size == offset
                        assert not response.read(1)
                        break
                    assert response.status == 206
                    span = re.fullmatch(r"bytes ([0-9]+)-([0-9]+)/([0-9]+)", response.headers.get("Content-Range", ""))
                    assert span
                    begin, end, current_size = map(int, span.groups())
                    assert begin == offset and offset <= end < current_size <= maximum
                    assert size is None or current_size == size, "sealed driver log size changed"
                    size = current_size
                    remaining = end - begin + 1
                    assert remaining <= 262144 and response.headers.get("Content-Length") == str(remaining)
                    while remaining:
                        chunk = response.read(min(65536, remaining))
                        assert chunk, "driver log response ended early"
                        if offset == 0:
                            assert chunk.startswith(stamp), "driver log belongs to another run"
                        output.write(chunk)
                        tail = (tail + chunk)[-4096:]
                        offset += len(chunk)
                        remaining -= len(chunk)
                    assert not response.read(1)
            output.flush()
            os.fsync(output.fileno())
        def identity(status):
            return status.st_dev, status.st_ino, status.st_size, status.st_mtime_ns
        if original is not None:
            with target.open("rb") as retained, open(temporary, "rb") as complete:
                assert identity(os.fstat(retained.fileno())) == identity(original), "original driver log changed"
                while chunk := retained.read(65536):
                    assert complete.read(len(chunk)) == chunk, "original driver log is not an exact prefix"
                assert identity(os.fstat(retained.fileno())) == identity(original), "original driver log changed"
                if original.st_size < offset:
                    os.fsync(retained.fileno())
            assert not target.is_symlink() and identity(target.stat()) == identity(original), "original driver log changed"
            if original.st_size == offset:
                os.unlink(temporary)  # Leave an already complete original untouched.
                return
            # Keep the interrupted original inode inside a private directory before
            # atomically publishing the complete, stable data-plane bytes.
            history = Path(tempfile.mkdtemp(prefix=".cloudbench-driver-original-", dir=parent))
            os.link(target, history / "cloudbench-driver.log")
            for directory in (history, parent):
                descriptor = os.open(directory, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            assert not target.is_symlink() and identity(target.stat()) == identity(original), "original driver log changed"
            os.replace(temporary, target)
            published = True
        else:
            os.link(temporary, target)  # An absent target must remain absent until publication.
            os.unlink(temporary)
        descriptor = os.open(parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except BaseException:
        # A failed fetch or publication must not leave partial bytes behind for
        # a later recovery that reuses this directory. The private original link
        # is kept only once publication replaced the original target.
        if os.path.lexists(temporary):
            os.unlink(temporary)
        if history is not None and not published:
            shutil.rmtree(history, ignore_errors=True)
        raise
def exited_without_ack():
    # /shutdown-health is 409 until the controller sends POST /shutdown, even
    # when a failed driver's boot supervisor has already sealed state=exited.
    # Read both exact guest facts before deciding the runtime can never seal.
    try:
        with opener.open(urllib.request.Request(driver_url, headers=headers), timeout=6):
            return False
    except urllib.error.HTTPError as error:
        if error.code != 410:
            return False
    try:
        with opener.open(urllib.request.Request(ack_url, headers=headers), timeout=6) as response:
            return response.read(256).strip() != run_token.encode()
    except urllib.error.HTTPError as error:
        return error.code == 404
unacked_exits = 0
shutdown_complete = False
# DONE precedes the guest EXIT trap. Retry only seal observation and transient
# transport reads before the first manifest, within the unchanged whole-capture
# alarm. Once sealed, transfers and the final manifest comparison fail closed.
while True:
    try:
        try:
            expected = manifest()
            break
        except urllib.error.HTTPError as error:
            if error.code != 409:
                raise
            if shutdown_complete:
                # This 409 was observed after the exact terminal ACK, unlike
                # the earlier read that may have raced the guest's seal.
                raise RuntimeError("guest shutdown without sealed runtime evidence") from error
        try:
            with opener.open(urllib.request.Request(shutdown_url, headers=headers), timeout=6) as response:
                if response.status == 204:
                    shutdown_complete = True
                    continue
                assert response.status == 202
        except urllib.error.HTTPError as shutdown_error:
            if shutdown_error.code == 500:
                raise RuntimeError("driver exited without cleanup acknowledgement") from shutdown_error
            if shutdown_error.code not in (409, 503):
                raise
        unacked_exits = unacked_exits + 1 if exited_without_ack() else 0
        if unacked_exits >= 2:
            raise RuntimeError("driver exited without cleanup acknowledgement")
    except urllib.error.HTTPError:
        # HTTPError is a URLError subclass; authentication and protocol failures
        # are not transient transport reads.
        raise
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        pass
    time.sleep(0.5)
assert expected["version"] == 1 and expected["run_token"] == run_token and expected["machine_id"] == machine
files = expected["files"]
# A guest stopped before launching anything seals only its exact bench.log.
prelaunch = expected.get("prelaunch") is True
if prelaunch:
    required = {"bench.log"}
    assert set(expected) == {"version", "run_token", "machine_id", "files", "prelaunch"}
    assert isinstance(files, dict) and set(files) == required
else:
    required = {"services.json", "run.json", "stack.log", "logs/backend.log", f"cloudbench-stack-cleanup-{run_token}.status"}
# Present only when the stack served a world model (its per-step server timing),
# or when the guest diagnostics sampler ran (CPU/load, DB pool, pg_stat_activity).
OPTIONAL = {"wmh-serve-log.txt", "guest-diagnostics.jsonl"}
assert isinstance(files, dict) and required <= files.keys() and len(files) <= 1030
total = 0
for name, metadata in files.items():
    assert name in required or name in OPTIONAL or re.fullmatch(r"logs/worker(?:\.[1-9][0-9]*)?\.log", name)
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
if prelaunch:
    with (pending / "bench.log").open("rb") as log:
        stamp = ("RUNSTAMP-" + run_token + "\n").encode()
        assert log.read(len(stamp)) == stamp, "pre-launch log belongs to another run"
else:
    services = json.loads((pending / "services.json").read_text())
    count = services["env"]["worker_processes"]
    assert services["status"] == "stopped" and type(count) is int and 1 <= count <= 1024
    assert set(files) - OPTIONAL == required | {"logs/worker.log", *(f"logs/worker.{i}.log" for i in range(1, count))}
if options:
    collect_driver_log()
assert manifest() == expected, "runtime evidence changed across collection"
with (pending / "manifest.json").open("x") as output:
    json.dump(expected, output, sort_keys=True)
    output.write("\n")
    output.flush()
    os.fsync(output.fileno())
# Persist child directory entries before acknowledging the published capture.
# File fsync alone does not make their names durable across controller failure.
for directory in ((pending,) if prelaunch else (pending / "logs", pending)):
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
if prelaunch:
    # No run result can exist to bind the latch to; the sealed pre-launch
    # bundle is the complete runtime evidence, so release the latch here.
    intent.unlink()
    descriptor = os.open(intent.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
signal.alarm(0)
