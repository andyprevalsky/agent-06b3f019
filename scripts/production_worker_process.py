#!/usr/bin/env python3
"""Authenticate and supervise one additional worker on an unchanged Linux host.

The caller supplies an HMAC-authenticated complete source archive on stdin.
This primitive never updates a Machine or signals any pre-existing process.
It does not certify boot recovery, fleet readiness, activation, or retirement.
"""

from __future__ import annotations

import base64
import contextlib
import ctypes
import fcntl
import hashlib
import hmac
import http.client
import importlib.metadata
import io
import json
import os
import re
import resource
import select
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import time
from pathlib import Path, PurePosixPath

ROOT = Path("/tmp/rose-production-worker")
MEMORY_ROOT = Path("/sys/fs/cgroup/memory")
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_SOURCE = 128 * 1024 * 1024
MAX_FILES = 20000
MAX_REQUEST = 48 * 1024 * 1024
SHA = re.compile(r"[0-9a-f]{64}\Z")
TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}\Z")
REQUEST_KEYS = {
    "version",
    "action",
    "app",
    "peopleCredentialBrokerOrigin",
    "machineId",
    "machineVersion",
    "bootId",
    "sourceCommit",
    "buildId",
    "surfaceHash",
    "deploymentToken",
    "namespace",
    "baseTaskQueue",
    "validationTaskQueue",
    "bundleSHA256",
    "bundleBase64",
    "manifest",
    "limits",
    "healthPort",
    "sdkMetricsPort",
    "signature",
}


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def authenticate(request, key):
    require(
        isinstance(request, dict)
        and (
            set(request) == REQUEST_KEYS
            or (request.get("action") == "status" and set(request) == REQUEST_KEYS - {"bundleBase64"})
        ),
        "request fields",
    )
    require(isinstance(key, str) and bool(key), "authentication unavailable")
    signature = request["signature"]
    require(isinstance(signature, str) and SHA.fullmatch(signature), "signature format")
    expected = hmac.new(
        key.encode(), canonical({k: v for k, v in request.items() if k != "signature"}), hashlib.sha256
    ).hexdigest()
    require(hmac.compare_digest(signature, expected), "signature mismatch")
    require(type(request["version"]) is int and request["version"] == 1, "request version")
    require(request["action"] in ("ensure", "status"), "action")
    require(
        request["peopleCredentialBrokerOrigin"] == "https://navi-j9a9.onrender.com", "people credential broker origin"
    )
    require(request["action"] == "status" or isinstance(request.get("bundleBase64"), str), "ensure archive required")
    for name in (
        "app",
        "machineId",
        "machineVersion",
        "bootId",
        "deploymentToken",
        "namespace",
        "baseTaskQueue",
        "validationTaskQueue",
    ):
        require(isinstance(request[name], str) and TOKEN.fullmatch(request[name]), "invalid identity field")
    require(
        re.fullmatch(r"[0-9a-f]{40}", request["sourceCommit"]) and request["buildId"] == request["sourceCommit"],
        "source identity",
    )
    require(re.fullmatch(r"[0-9a-f]{12}", request["surfaceHash"]), "surface identity")
    require(
        request["validationTaskQueue"]
        not in (request["baseTaskQueue"], request["baseTaskQueue"] + "@" + request["surfaceHash"]),
        "validation queue isolation",
    )
    require(
        request["limits"]
        == {
            "maxAddressBytes": 1073741824,
            "minFreeAfterMaxAddressBytes": 268435456,
            "aggregateMemoryBytes": 1073741824,
            "memoryController": "v1-memory",
        },
        "resource limits",
    )
    require(
        all(
            type(request["limits"][name]) is int
            for name in ("maxAddressBytes", "aggregateMemoryBytes", "minFreeAfterMaxAddressBytes")
        ),
        "integer resource limits",
    )
    for name in ("healthPort", "sdkMetricsPort"):
        port = request[name]
        require(type(port) is int and (port == 0 or 1024 <= port <= 65535), "port")
    require(request["healthPort"] == 0 or request["healthPort"] != request["sdkMetricsPort"], "port collision")


def verify_native(request):
    require(sys.platform == "linux" and os.geteuid() == 0, "root Linux bootstrap required")
    for field, name in (
        ("app", "FLY_APP_NAME"),
        ("machineId", "FLY_MACHINE_ID"),
        ("machineVersion", "FLY_MACHINE_VERSION"),
        ("namespace", "TEMPORAL_NAMESPACE"),
    ):
        require(os.environ.get(name) == request[field], "native identity mismatch")
    require(boot_id() == request["bootId"], "native boot mismatch")


def safe_path(name):
    require(isinstance(name, str) and 0 < len(name) <= 512 and "\\" not in name and name.isascii(), "source path")
    path = PurePosixPath(name)
    require(not path.is_absolute() and str(path) == name and path.parts[0] == "agents", "source path")
    require(
        all(
            p not in ("..", ".", ".env", ".git", "venv", ".venv", "tests", "benchmarks", "vendor", "__pycache__")
            and not p.startswith(".env.")
            for p in path.parts
        ),
        "excluded source path",
    )
    require(not name.endswith((".pyc", ".pyo")), "compiled source excluded")
    return path


def verify_bundle(request):
    manifest = request["manifest"]
    require(
        isinstance(manifest, dict)
        and set(manifest)
        == {"version", "sourceCommit", "requirementsSHA256", "installedDistributionsSHA256", "pythonSHA256", "files"},
        "manifest fields",
    )
    require(
        type(manifest["version"]) is int
        and manifest["version"] == 1
        and manifest["sourceCommit"] == request["sourceCommit"],
        "manifest identity",
    )
    for name in ("requirementsSHA256", "installedDistributionsSHA256", "pythonSHA256"):
        require(isinstance(manifest[name], str) and SHA.fullmatch(manifest[name]), "manifest digest")
    require(isinstance(manifest["files"], list) and 2 <= len(manifest["files"]) <= MAX_FILES, "manifest file count")
    expected = {}
    total = 0
    for entry in manifest["files"]:
        require(isinstance(entry, dict) and set(entry) == {"path", "sha256", "size", "mode"}, "manifest entry")
        path = str(safe_path(entry["path"]))
        require(path not in expected, "duplicate manifest path")
        require(type(entry["size"]) is int and 0 <= entry["size"] <= MAX_SOURCE, "source size")
        require(type(entry["mode"]) is int and entry["mode"] in (0o644, 0o755), "source mode")
        require(isinstance(entry["sha256"], str) and SHA.fullmatch(entry["sha256"]), "source digest")
        total += entry["size"]
        require(total <= MAX_SOURCE, "source aggregate size")
        expected[path] = entry
    require("agents/worker.py" in expected and "agents/requirements.txt" in expected, "runtime entrypoints")
    require(
        isinstance(request["bundleBase64"], str) and len(request["bundleBase64"]) <= MAX_ARCHIVE * 4 // 3 + 4,
        "archive size",
    )
    data = base64.b64decode(request["bundleBase64"], validate=True)
    require(len(data) <= MAX_ARCHIVE and hashlib.sha256(data).hexdigest() == request["bundleSHA256"], "archive digest")
    files = {}
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r|gz") as archive:
        for member in archive:
            require(len(seen) <= MAX_FILES * 2, "archive entry count")
            name = member.name.rstrip("/") if member.isdir() else member.name
            safe_path(name)
            require(name not in seen, "duplicate archive path")
            seen.add(name)
            if member.isdir():
                require(any(p.startswith(name + "/") for p in expected), "unlisted archive directory")
                continue
            require(member.isfile() and name in expected, "unlisted or linked source")
            entry = expected[name]
            require(member.size == entry["size"] and member.mode == entry["mode"], "archive file metadata")
            body = archive.extractfile(member).read(entry["size"] + 1)
            require(
                len(body) == entry["size"] and hashlib.sha256(body).hexdigest() == entry["sha256"],
                "source bytes mismatch",
            )
            files[name] = body
    require(set(files) == set(expected), "incomplete source bundle")
    require(
        hashlib.sha256(files["agents/requirements.txt"]).hexdigest() == manifest["requirementsSHA256"],
        "requirements mismatch",
    )
    return files


def verify_dependencies(request):
    manifest = request["manifest"]
    interpreter = Path(sys.executable).resolve(strict=True)
    require(hashlib.sha256(interpreter.read_bytes()).hexdigest() == manifest["pythonSHA256"], "interpreter mismatch")
    dists = sorted((dist.metadata.get("Name", ""), dist.version) for dist in importlib.metadata.distributions())
    digest = hashlib.sha256(json.dumps(dists, separators=(",", ":")).encode()).hexdigest()
    require(digest == manifest["installedDistributionsSHA256"], "installed distributions mismatch")


def available_memory():
    values = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
    return int(values["MemAvailable"].split()[0]) * 1024


def require_memory(request):
    limits = request["limits"]
    require(
        available_memory() >= limits["aggregateMemoryBytes"] + limits["minFreeAfterMaxAddressBytes"],
        "memory reserve unavailable",
    )


def secure(path, directory=False):
    info = path.lstat()
    require(
        (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
        and info.st_uid == 0
        and info.st_mode & 0o022 == 0,
        "unsafe owned path",
    )
    if not directory:
        require(info.st_nlink == 1, "linked owned file")


def atomic_json(path, value):
    temporary = path.with_name(path.name + "." + str(os.getpid()) + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(canonical(value) + b"\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_json(path):
    secure(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        return json.load(stream)


def intent(request):
    return {k: v for k, v in request.items() if k not in ("action", "signature", "bundleBase64")}


def intent_digest(request):
    return hashlib.sha256(canonical(intent(request))).hexdigest()


def process_identity(pid):
    text = Path(f"/proc/{pid}/stat").read_text()
    fields = text[text.rfind(")") + 2 :].split()
    require(fields[0] != "Z", "process exited")
    return {"pid": pid, "birthTicks": fields[19], "bootId": boot_id()}


def same_process(record):
    try:
        return isinstance(record, dict) and process_identity(record["pid"]) == record
    except (OSError, ValueError, KeyError):
        return False


def prepare_slot(request, files):
    try:
        ROOT.mkdir(mode=0o755)
    except FileExistsError:
        pass
    secure(ROOT, directory=True)
    lock_fd = os.open(ROOT / "slot.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    secure(ROOT / "slot.lock")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock_fd)
        state = read_json(ROOT / "state.json")
        require(
            state["intentSHA256"] == intent_digest(request) and same_process(state.get("supervisor")),
            "occupied foreign or unknown slot",
        )
        return None, state
    state_path = ROOT / "state.json"
    if state_path.exists():
        previous = read_json(state_path)
        # A missing supervisor does not prove its worker/descendants are gone.
        require(previous.get("bootId") != boot_id(), "prior same-boot owner requires reconciliation")
    require(request["action"] == "ensure", "worker absent")
    slot = ROOT / intent_digest(request)
    slot.mkdir(mode=0o755)
    source = slot / "source"
    source.mkdir(mode=0o755)
    entries = {entry["path"]: entry for entry in request["manifest"]["files"]}
    for name, data in files.items():
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        entry = entries[name]
        path.chmod(0o555 if entry["mode"] == 0o755 else 0o444)
    for directory, _, _ in os.walk(source, topdown=False):
        Path(directory).chmod(0o555)
    runtime = slot / "runtime"
    runtime.mkdir(mode=0o700)
    for name in ("home", "tmp", "recordings", "archive", "cache"):
        path = runtime / name
        path.mkdir(mode=0o700)
        os.chown(path, 1000, 1000)
    os.chown(runtime, 1000, 1000)
    atomic_json(slot / "intent.json", intent(request))
    return (lock_fd, slot), None


def worker_environment(request, runtime, inherited):
    environment = {
        k: v
        for k, v in inherited.items()
        if k
        not in (
            "PYTHONPATH",
            "PYTHONHOME",
            "PYTHONSTARTUP",
            "VIRTUAL_ENV",
            "CONDUCTOR_WORKSPACE_NAME",
            "ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME",
        )
    }
    environment.update(
        {
            "PEOPLE_CREDENTIAL_BROKER_URL": request["peopleCredentialBrokerOrigin"],
            "TEMPORAL_NAMESPACE": request["namespace"],
            "TEMPORAL_TASK_QUEUE": request["baseTaskQueue"],
            "TEMPORAL_WORKER_SURFACE_HASH": request["surfaceHash"],
            "TEMPORAL_WORKER_BUILD_ID": request["buildId"],
            "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": request["deploymentToken"],
            "TEMPORAL_WORKER_REQUIRE_ACTIVATION": "1",
            "TEMPORAL_WORKER_VALIDATION_TASK_QUEUE": request["validationTaskQueue"],
            "AUTOSCALER_ACTUATE": "0",
            "HEALTH_CHECK_PORT": str(request["healthPort"]),
            "SDK_METRICS_PORT": str(request["sdkMetricsPort"]),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUNBUFFERED": "1",
            "PYTHONNOUSERSITE": "1",
            "PYTHON_DOTENV_DISABLED": "1",
            "HOME": str(runtime / "home"),
            "TMPDIR": str(runtime / "tmp"),
            "BROWSER_AGENT_RECORDINGS_DIR": str(runtime / "recordings"),
            "TRACE_ARCHIVE_LOCAL_ROOT": str(runtime / "archive"),
            "XDG_CACHE_HOME": str(runtime / "cache"),
            "HF_HOME": str(runtime / "cache" / "huggingface"),
            "PATH": "/usr/local/bin:/usr/bin:/bin",
        }
    )
    return environment


def memory_group(request, name):
    # Never enable controllers, remount, or move any existing process.
    require(MEMORY_ROOT == Path("/sys/fs/cgroup/memory"), "memory controller path")
    require(
        any(
            " - cgroup " in line
            and line.split()[4] == str(MEMORY_ROOT)
            and "memory" in line.split(" - ", 1)[1].split()[2].split(",")
            for line in Path("/proc/self/mountinfo").read_text().splitlines()
        ),
        "v1 memory controller unavailable",
    )
    group = MEMORY_ROOT / ("rose-worker-" + name)
    group.mkdir(mode=0o755)  # Exclusive creation; an old group is not adoptable.
    secure(group, directory=True)
    for control in ("cgroup.procs", "memory.use_hierarchy", "memory.limit_in_bytes"):
        secure(group / control)
    require(not (group / "cgroup.procs").read_text().strip(), "memory group occupied")
    (group / "memory.use_hierarchy").write_text("1")
    (group / "memory.limit_in_bytes").write_text(str(request["limits"]["aggregateMemoryBytes"]))
    require(
        (group / "memory.use_hierarchy").read_text().strip() == "1"
        and int((group / "memory.limit_in_bytes").read_text()) == request["limits"]["aggregateMemoryBytes"],
        "memory boundary readback",
    )
    memsw = group / "memory.memsw.limit_in_bytes"
    if memsw.exists():
        secure(memsw)
        memsw.write_text(str(request["limits"]["aggregateMemoryBytes"]))
        require(int(memsw.read_text()) == request["limits"]["aggregateMemoryBytes"], "swap boundary readback")
    else:
        values = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        require(int(values["SwapTotal"].split()[0]) == 0, "unbounded swap")
    return group


def child_boundary(group, request):
    require(not (group / "cgroup.procs").read_text().strip(), "prior child group not drained")
    (group / "cgroup.procs").write_text(str(os.getpid()))
    require(str(os.getpid()) in (group / "cgroup.procs").read_text().split(), "child memory membership")
    resource.setrlimit(resource.RLIMIT_AS, (request["limits"]["maxAddressBytes"],) * 2)
    Path("/proc/self/oom_score_adj").write_text("1000")
    require(Path("/proc/self/oom_score_adj").read_text().strip() == "1000", "child OOM priority boundary")
    os.setgroups([])
    os.setgid(1000)
    os.setuid(1000)
    require(ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0) == 0, "no-new-privileges boundary")
    require(os.getuid() == os.geteuid() == 1000, "worker UID boundary")
    os.umask(0o077)


def child_oom_score(pid):
    return int(Path(f"/proc/{pid}/oom_score_adj").read_text())


def owns_socket(pid, port):
    try:
        inodes = {
            os.readlink(p)[8:-1] for p in Path(f"/proc/{pid}/fd").iterdir() if os.readlink(p).startswith("socket:[")
        }
        for filename in ("/proc/net/tcp", "/proc/net/tcp6"):
            for line in Path(filename).read_text().splitlines()[1:]:
                fields = line.split()
                if fields[3] == "0A" and int(fields[1].split(":")[1], 16) == port and fields[9] in inodes:
                    return True
    except OSError:
        return False
    return False


def observe_health(child, request, log, known_ports=None):
    ports = None
    if known_ports and type(known_ports.get("healthPort")) is int and type(known_ports.get("sdkMetricsPort")) is int:
        ports = {"health_check_port": known_ports["healthPort"], "sdk_metrics_port": known_ports["sdkMetricsPort"]}
    with log.open("rb") as stream:
        for line in stream.read(131072).splitlines() if ports is None else ():
            try:
                item = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if isinstance(item, dict) and item.get("event") == "Worker observability endpoints bound":
                ports = item
    if ports is None or not same_process(child):
        return {"phase": "BOOTING", "healthPort": None, "sdkMetricsPort": None}
    health_port, sdk_port = ports.get("health_check_port"), ports.get("sdk_metrics_port")
    require(
        type(health_port) is int
        and type(sdk_port) is int
        and 1024 <= health_port <= 65535
        and 1024 <= sdk_port <= 65535
        and health_port != sdk_port,
        "bound ports",
    )
    require(
        (not request["healthPort"] or request["healthPort"] == health_port)
        and (not request["sdkMetricsPort"] or request["sdkMetricsPort"] == sdk_port),
        "unexpected bound ports",
    )
    require(
        owns_socket(child["pid"], health_port) and owns_socket(child["pid"], sdk_port), "endpoint process ownership"
    )
    connection = http.client.HTTPConnection("127.0.0.1", health_port, timeout=1)
    try:
        connection.request("GET", "/health")
        response = connection.getresponse()
        data = response.read(65537)
        require(len(data) <= 65536, "health response size")
        health = json.loads(data)
        require(same_process(child) and child_oom_score(child["pid"]) == 1000, "child OOM priority not verified")
        phase = {"standby": "STANDBY", "running": "RUNNING"}.get(health.get("phase"), "BOOTING")
        require(health.get("build_id") == request["buildId"], "health build identity")
        if response.status != 200 or health.get("healthy") is not True:
            phase = "BOOTING"
        return {
            "phase": phase,
            "healthPort": health_port,
            "sdkMetricsPort": sdk_port,
            "health": {k: health.get(k) for k in ("healthy", "phase", "build_id")},
            "oomScoreAdj": 1000,
        }
    finally:
        connection.close()


def response(request, **values):
    return {
        "version": 1,
        "hostname": socket.gethostname(),
        "aggregateMemoryBytes": request["limits"]["aggregateMemoryBytes"],
        "supervisorPid": None,
        "supervisorBirthTicks": None,
        "workerPid": None,
        "workerBirthTicks": None,
        "health": None,
        "app": request["app"],
        "machineId": request["machineId"],
        "machineVersion": request["machineVersion"],
        "bootId": request["bootId"],
        "sourceCommit": request["sourceCommit"],
        "bundleSHA256": request["bundleSHA256"],
        "buildId": request["buildId"],
        "surfaceHash": request["surfaceHash"],
        "deploymentToken": request["deploymentToken"],
        "intentSHA256": intent_digest(request),
        "namespace": request["namespace"],
        "baseTaskQueue": request["baseTaskQueue"],
        "validationTaskQueue": request["validationTaskQueue"],
        **values,
    }


def drain_output(stream, output):
    # Bound owned logs without restricting recording files. No reader thread
    # exists when Popen executes its privilege boundary.
    for _ in range(16):
        try:
            data = os.read(stream.fileno(), 65536)
        except BlockingIOError:
            break
        if not data:
            break
        if os.fstat(output.fileno()).st_size + len(data) > 32 * 1024 * 1024:
            output.truncate(0)
            output.seek(0)
        output.write(data)


def supervise(request, slot, lock_fd, ack_fd):
    child = None
    stopping = False
    group = None
    state = response(
        request,
        phase="BOOTING",
        supervisor=process_identity(os.getpid()),
        child=None,
        healthPort=None,
        sdkMetricsPort=None,
    )
    state_path = ROOT / "state.json"

    def publish(**values):
        state.update(values)
        for key, prefix in (("supervisor", "supervisor"), ("child", "worker")):
            record = state.get(key) or {}
            state[prefix + "Pid"] = record.get("pid")
            state[prefix + "BirthTicks"] = record.get("birthTicks")
        state["observedAt"] = time.time()
        atomic_json(state_path, state)

    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True
        if child is not None and child.poll() is None and not state.get("stopSent"):
            state["stopSent"] = True
            child.terminate()  # Only our retained, unreaped direct child.

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        require(ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0, "subreaper unavailable")
        group = memory_group(request, intent_digest(request)[:32])
        publish(memoryGroup=str(group), aggregateMemoryBytes=request["limits"]["aggregateMemoryBytes"])
        os.write(ack_fd, b"1")
        os.close(ack_fd)
        ack_fd = -1
        for restart in range(3):
            if stopping:
                break
            require_memory(request)
            verify_dependencies(request)
            verify_staged_source(request, slot / "source")
            log = slot / f"worker-{os.getpid()}-{restart}.log"
            output_fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(output_fd, "ab", buffering=0) as output:
                child = subprocess.Popen(
                    [sys.executable, "-B", "worker.py"],
                    cwd=slot / "source" / "agents",
                    env=worker_environment(request, slot / "runtime", os.environ),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                    preexec_fn=lambda: child_boundary(group, request),
                    close_fds=True,
                )
                os.set_blocking(child.stdout.fileno(), False)
                identity = process_identity(child.pid)
                publish(
                    child=identity,
                    phase="BOOTING",
                    restarts=restart,
                    stopSent=False,
                    healthPort=None,
                    sdkMetricsPort=None,
                    workerLog=log.name,
                )
                if stopping:
                    stop(None, None)
                while child.poll() is None:
                    drain_output(child.stdout, output)
                    try:
                        publish(**observe_health(identity, request, log, state))
                    except (OSError, ValueError, http.client.HTTPException):
                        publish(phase="UNKNOWN", reason="health not positively verified")
                    time.sleep(0.25)
                drain_output(child.stdout, output)
                child.stdout.close()
                publish(phase="UNKNOWN", childExitCode=child.returncode)
            # Descendants inherit the hard group boundary. Never restart while
            # orphan work from the preceding child remains alive.
            while True:
                try:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    break
                if pid == 0:
                    time.sleep(0.1)
            require(not (group / "cgroup.procs").read_text().strip(), "child group not drained")
            if stopping:
                break
            time.sleep(2**restart)
        publish(phase="BLOCKED", reason="supervised worker exited; reconciliation required")
    except BaseException:
        with contextlib.suppress(Exception):
            publish(phase="BLOCKED", reason="supervisor boundary failed")
        # Retain a running child if an observation/write fails. Never infer
        # absence or launch another child from a supervisor exception.
        if child is not None:
            # Even a failed control-file write cannot strand a verbose child
            # behind a full stdout pipe. Retain and drain; never signal it here.
            while child.poll() is None:
                if child.stdout is not None and not child.stdout.closed:
                    with contextlib.suppress(OSError, ValueError):
                        os.read(child.stdout.fileno(), 65536)
                time.sleep(0.1)
            child.wait()
            if child.stdout is not None:
                child.stdout.close()
            while True:
                try:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    break
                if pid == 0:
                    time.sleep(0.1)
    finally:
        if ack_fd >= 0:
            os.close(ack_fd)
        os.close(lock_fd)


def verify_staged_source(request, source):
    expected = {entry["path"]: entry for entry in request["manifest"]["files"]}
    secure(source, directory=True)
    actual = set()
    for path in source.rglob("*"):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            secure(path, directory=True)
            require(info.st_mode & 0o222 == 0, "writable source directory")
        else:
            secure(path)
            actual.add(str(path.relative_to(source)))
    require(actual == set(expected), "staged source membership")
    for name, entry in expected.items():
        path = source / name
        secure(path)
        require(
            path.stat().st_mode & 0o222 == 0 and hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"],
            "staged source changed",
        )


def status(request):
    try:
        ROOT.mkdir(mode=0o755)
    except FileExistsError:
        pass
    secure(ROOT, directory=True)
    fd = os.open(ROOT / "slot.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    secure(ROOT / "slot.lock")
    locked = False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except BlockingIOError:
            pass
        if not (ROOT / "state.json").exists():
            empty = locked and set(p.name for p in ROOT.iterdir()) <= {"slot.lock"}
            return response(
                request,
                phase="MISSING" if empty else "UNKNOWN",
                reason="no owned process" if empty else "ownership not published",
            )
        previous = read_json(ROOT / "state.json")
        if previous.get("bootId") != request["bootId"]:
            return response(
                request,
                phase="MISSING" if locked else "UNKNOWN",
                reason="prior boot process absent" if locked else "ownership inconclusive",
            )
        require(previous.get("intentSHA256") == intent_digest(request), "foreign process slot")
        if locked or not same_process(previous.get("supervisor")) or not same_process(previous.get("child")):
            return {**previous, "phase": "UNKNOWN", "reason": "process liveness not positive"}
        if previous.get("phase") == "BLOCKED":
            return previous
        observed_at = previous.get("observedAt")
        if not isinstance(observed_at, (int, float)) or not 0 <= time.time() - observed_at <= 5:
            return {**previous, "phase": "UNKNOWN", "reason": "supervisor observation stale"}
        try:
            log_name = previous.get("workerLog", "")
            require(re.fullmatch(r"worker-[0-9]+-[0-9]+\.log", log_name), "worker log identity")
            health = observe_health(previous["child"], request, ROOT / intent_digest(request) / log_name, previous)
            return {**previous, **health, "observedAt": time.time()}
        except (OSError, ValueError, http.client.HTTPException):
            return {**previous, "phase": "UNKNOWN", "reason": "health not positively verified"}
    finally:
        os.close(fd)


def dispatch(request):
    authenticate(request, os.environ.get("BACKEND_API_KEY", ""))
    verify_native(request)
    if request["action"] == "status":
        return status(request)
    files = verify_bundle(request)
    verify_dependencies(request)
    observed = status(request)
    if observed["phase"] != "MISSING":
        return observed
    require_memory(request)
    prepared, previous = prepare_slot(request, files)
    if previous is not None:
        if not same_process(previous.get("child")):
            previous = {**previous, "phase": "UNKNOWN"}
        return previous
    lock_fd, slot = prepared
    files.clear()
    request["bundleBase64"] = None  # Verified bytes are staged; do not retain the transport in the daemon.
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_fd)
        os.setsid()
        null_fd = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(null_fd, fd)
        if null_fd > 2:
            os.close(null_fd)
        # Retain only the slot lock and handshake; no SSH stdio/descriptors.
        for item in Path("/proc/self/fd").iterdir():
            fd = int(item.name)
            if fd > 2 and fd not in (lock_fd, write_fd):
                try:
                    os.close(fd)
                except OSError:
                    pass
        try:
            supervise(request, slot, lock_fd, write_fd)
        finally:
            os._exit(0)
    os.close(write_fd)
    os.close(lock_fd)
    try:
        ready, _, _ = select.select([read_fd], [], [], 10)
        require(bool(ready) and os.read(read_fd, 1) == b"1", "supervisor startup not acknowledged")
    finally:
        os.close(read_fd)
    state = read_json(ROOT / "state.json")
    require(
        state["intentSHA256"] == intent_digest(request) and same_process(state.get("supervisor")),
        "supervisor identity not verified",
    )
    return state


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def main():
    try:
        data = sys.stdin.buffer.read(MAX_REQUEST + 1)
        require(len(data) <= MAX_REQUEST, "request size")
        request = json.loads(data, object_pairs_hook=unique_object)
        del data
        result = dispatch(request)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception:
        # Never return payloads, signatures, environment, tracebacks or logs.
        print(json.dumps({"version": 1, "phase": "BLOCKED", "reason": "request or process boundary not verified"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
