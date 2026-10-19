#!/usr/bin/env python3
"""Supervise and preserve one cloud worker's complete, quiescent runtime logs.

The controller supplies exact run/machine authority. Capture requests graceful
stop through an owner-bound file; it never signals a PID read from disk. Linux
subreaping keeps orphan descendants owned until they exit. A 270-second capture
failure retains both the machine and original files for recovery.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

MAX_BYTES = 512 * 1024 * 1024
MAX_FILES = 4096
CAPTURE_SECONDS = 270
SAFE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,191}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def authority(run_token, machine_id):
    require(
        isinstance(run_token, str) and SAFE.fullmatch(run_token), "invalid run token"
    )
    require(
        isinstance(machine_id, str) and re.fullmatch(r"[0-9a-f]{8,32}", machine_id),
        "invalid machine ID",
    )
    return {"version": 1, "run_token": run_token, "machine_id": machine_id}


def state_directory(data, run_token):
    """Borrowed workers retain previous launch evidence at its original path."""
    scope = os.environ.get("CLOUDBENCH_WORKER_EVIDENCE_SCOPE", "legacy")
    require(scope in ("legacy", "run"), "invalid worker evidence scope")
    require(SAFE.fullmatch(run_token), "invalid worker evidence run token")
    return data / ("cloudbench-worker-evidence-" + run_token if scope == "run"
                   else "cloudbench-worker-evidence")


def bound(value, expected):
    require(
        isinstance(value, dict) and all(value.get(k) == v for k, v in expected.items()),
        "evidence identity mismatch",
    )


def regular(path):
    info = path.lstat()
    require(
        stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
        "non-regular or linked evidence file",
    )
    return info


def no_symlink(path):
    for item in (path, *path.parents):
        require(not item.is_symlink(), "symlink in evidence path")


def read_json(path):
    no_symlink(path)
    before = regular(path)
    require(before.st_size <= 1024 * 1024, "oversized evidence JSON")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        require(
            stable_stat(os.fstat(stream.fileno())) == stable_stat(before),
            "JSON identity changed",
        )
        data = stream.read(before.st_size)
        require(
            len(data) == before.st_size
            and stable_stat(os.fstat(stream.fileno())) == stable_stat(before)
            and stable_stat(path.lstat()) == stable_stat(before),
            "JSON changed during read",
        )
    return json.loads(data)


def sync_directory(path):
    no_symlink(path)
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        require(stat.S_ISDIR(os.fstat(fd).st_mode), "not an evidence directory")
        os.fsync(fd)
    finally:
        os.close(fd)


def sync_file(path):
    no_symlink(path)
    before = regular(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(
            stable_stat(os.fstat(fd)) == stable_stat(before),
            "durability file identity changed",
        )
        os.fsync(fd)
        require(
            stable_stat(os.fstat(fd)) == stable_stat(before)
            and stable_stat(path.lstat()) == stable_stat(before),
            "durability file changed",
        )
    finally:
        os.close(fd)


def write_json(path, value):
    data = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        # Readers require one link and immutable ownership. An exclusive rename
        # publishes complete bytes without a transient second hard link or an
        # overwrite race between concurrent publishers.
        libc = ctypes.CDLL(None, use_errno=True)
        source = ctypes.c_char_p(os.fsencode(temporary))
        target = ctypes.c_char_p(os.fsencode(path))
        if sys.platform == "linux":
            result = libc.renameat2(-100, source, -100, target, 1)  # RENAME_NOREPLACE
        elif sys.platform == "darwin":
            result = libc.renamex_np(source, target, 4)  # RENAME_EXCL
        else:
            raise ValueError("atomic worker evidence publication requires Linux or Darwin")
        if result != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error), str(path))
    finally:
        Path(temporary).unlink(missing_ok=True)
    sync_directory(path.parent)
    sync_directory(path.parent.parent)


def identity(pid):
    if sys.platform == "linux":
        text = Path(f"/proc/{pid}/stat").read_text()
        fields = text[text.rfind(")") + 2 :].split()
        require(int(text.split()[0]) == pid, "process identity mismatch")
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        return f"linux:{boot}:{int(fields[19])}"
    # Verification is portable. Native Darwin support is useful to exercise the
    # retained-Popen boundary locally; production supervision requires Linux.
    import runpy

    return runpy.run_path(str(Path(__file__).with_name("process-identity.py")))[
        "current_identity"
    ](pid)


def same_process(record):
    try:
        if sys.platform == "linux":
            raw = Path(f"/proc/{record['pid']}/stat").read_text()
            if raw[raw.rfind(")") + 2 :].split()[0] == "Z":
                return False
        if sys.platform != "linux":
            os.kill(record["pid"], 0)
        return identity(record["pid"]) == record["birth"]
    except (FileNotFoundError, ProcessLookupError):
        return False


def enable_subreaper():
    require(sys.platform == "linux", "worker supervision requires Linux subreaping")
    require(
        ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0,
        "could not enable child subreaper",
    )


def log_paths(agents, primary):
    no_symlink(agents)
    require(agents.is_dir(), "missing worker log directory")
    candidates = [primary, *primary.parent.glob(f"{primary.stem}.*{primary.suffix}")]
    paths = []
    for path in candidates:
        if not path.exists() and not path.is_symlink():
            continue
        if path != primary:
            middle = path.name[
                len(primary.stem) + 1 : -len(primary.suffix) if primary.suffix else None
            ]
            if not middle.isdigit():
                continue
        no_symlink(path)
        regular(path)
        require(path.is_relative_to(agents), "worker log outside agents directory")
        paths.append(path)
    require(len(paths) <= MAX_FILES - 4, "too many worker logs")
    return sorted(set(paths))


def run(args):
    expected = authority(args.run_token, args.machine_id)
    require(
        os.environ.get("FLY_MACHINE_ID") == args.machine_id,
        "native worker identity mismatch",
    )
    data = Path(args.data_dir).absolute()
    agents = Path(args.agents_dir).absolute()
    no_symlink(data)
    no_symlink(agents)
    state = state_directory(data, args.run_token)
    state.mkdir(mode=0o700)  # Immutable single-launch admission; never replace.
    enable_subreaper()
    primary = Path(os.environ.get("NAVI_WORKER_LOG_FILE", "navi-worker-log.txt"))
    primary = primary if primary.is_absolute() else agents / primary
    require(primary.is_relative_to(agents), "worker log outside agents directory")
    no_symlink(primary)
    count = int(os.environ.get("WORKER_PROCESSES", "1"))
    require(1 <= count <= MAX_FILES - 4, "invalid worker count")
    expected_logs = [
        primary if i == 0 else primary.with_name(f"{primary.stem}.{i}{primary.suffix}")
        for i in range(count)
    ]
    supervisor = {"pid": os.getpid(), "birth": identity(os.getpid())}
    owner = {
        **expected,
        "supervisor": supervisor,
        "agents_dir": str(agents),
        "primary_log": str(primary),
        "expected_worker_logs": [str(p.relative_to(agents)) for p in expected_logs],
    }
    write_json(state / "owner.json", owner)
    stopping = False
    signalled = False
    child = None

    def stop(_sig=0, _frame=None):
        nonlocal stopping
        stopping = True

    old = {s: signal.signal(s, stop) for s in (signal.SIGTERM, signal.SIGINT)}
    exit_code = 1
    child_record = None
    adopted = []
    try:
        environment = dict(os.environ, CLOUDBENCH_WORKER_SUPERVISED="1")
        with (data / "worker.log").open("ab", buffering=0) as output:
            # The launch shell opened this path without O_APPEND. Rebind our
            # diagnostics too so a late error cannot overwrite child log bytes.
            os.dup2(output.fileno(), 1)
            os.dup2(output.fileno(), 2)
            child = subprocess.Popen(
                args.command, env=environment, stdout=output, stderr=subprocess.STDOUT
            )
            child_record = {"pid": child.pid, "birth": identity(child.pid)}
            write_json(state / "child.json", {**expected, "child": child_record})
            while child.poll() is None:
                request = state / "stop.json"
                if request.exists():
                    bound(read_json(request), {**expected, "supervisor": supervisor})
                    stopping = True
                if stopping and not signalled:
                    signalled = True
                    child.terminate()  # Retained direct child, exactly once.
                time.sleep(0.05)
            exit_code = child.wait()
            # Linux adopts descendants even when they start their own sessions.
            # Wait until ECHILD; a lingering descendant forbids a terminal seal.
            while True:
                try:
                    pid, status = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    break
                if pid:
                    adopted.append({"pid": pid, "wait_status": status})
                else:
                    time.sleep(0.05)
        ready = os.environ.get("WORKER_READY_FILE")
        terminal = {
            **expected,
            "supervisor": supervisor,
            "child": child_record,
            "exit_code": exit_code,
            "stop_requested": stopping,
            "term_sent": signalled,
            "quiescent": True,
            "children_reaped": True,
            "streams_closed": True,
            "worker_started": bool(ready and Path(ready).is_file()),
            "adopted_children": adopted,
        }
        write_json(state / "terminal.json", terminal)
        return exit_code if exit_code >= 0 else 128 - exit_code
    finally:
        # A diagnostic/write error must not abandon the process it launched.
        if child is not None and child.poll() is None:
            if not signalled:
                child.terminate()
            child.wait()
        for sig, handler in old.items():
            signal.signal(sig, handler)


def validate_records(owner, terminal, expected):
    bound(owner, expected)
    bound(terminal, expected)
    require(
        terminal.get("supervisor") == owner.get("supervisor"),
        "terminal supervisor mismatch",
    )
    for record in (owner.get("supervisor"), terminal.get("child")):
        require(
            isinstance(record, dict)
            and type(record.get("pid")) is int
            and record["pid"] > 0
            and isinstance(record.get("birth"), str)
            and re.fullmatch(
                r"(?:linux:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}:[1-9][0-9]*|darwin:[1-9][0-9]*:[0-9]{6})",
                record["birth"],
            ),
            "missing native process identity",
        )
    require(
        all(
            terminal.get(k) is True
            for k in ("quiescent", "children_reaped", "streams_closed")
        ),
        "worker is not quiescent",
    )
    require(type(terminal.get("exit_code")) is int, "missing worker exit status")
    require(
        type(terminal.get("worker_started")) is bool, "missing worker startup state"
    )
    require(
        isinstance(owner.get("expected_worker_logs"), list)
        and owner["expected_worker_logs"],
        "missing worker log inventory",
    )
    for name in owner["expected_worker_logs"]:
        safe_name("logs/agents/" + name)


def stable_stat(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def stable_copy(source, destination):
    before = regular(source)
    no_symlink(source)
    require(before.st_size <= MAX_BYTES, "oversized evidence file")
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    digest = hashlib.sha256()
    size = 0
    with os.fdopen(fd, "rb") as src, destination.open("xb") as out:
        require(
            stable_stat(os.fstat(src.fileno())) == stable_stat(before),
            "evidence changed before copy",
        )
        remaining = before.st_size
        while remaining:
            block = src.read(min(1024 * 1024, remaining))
            require(bool(block), "evidence truncated during capture")
            remaining -= len(block)
            size += len(block)
            require(size <= MAX_BYTES, "evidence grew beyond limit")
            digest.update(block)
            out.write(block)
        require(
            stable_stat(os.fstat(src.fileno())) == stable_stat(before)
            and stable_stat(source.lstat()) == stable_stat(before),
            "evidence mutated during capture",
        )
    return {"bytes": size, "sha256": digest.hexdigest()}


def capture(args):
    # Bound the entire CLI operation, including filesystem/archive verification.
    def expired(_signum, _frame):
        raise TimeoutError("worker capture exceeded 270-second deadline")

    previous = signal.signal(signal.SIGALRM, expired)
    prior_timer = signal.setitimer(signal.ITIMER_REAL, max(CAPTURE_SECONDS, 0.001))
    try:
        return capture_owned(args)
    finally:
        signal.setitimer(signal.ITIMER_REAL, *prior_timer)
        signal.signal(signal.SIGALRM, previous)


def capture_owned(args):
    expected = authority(args.run_token, args.machine_id)
    require(
        os.environ.get("FLY_MACHINE_ID") == args.machine_id,
        "native worker identity mismatch",
    )
    data = Path(args.data_dir).absolute()
    state = state_directory(data, args.run_token)
    owner = read_json(state / "owner.json")
    bound(owner, expected)
    terminal_path = state / "terminal.json"
    deadline = time.monotonic() + CAPTURE_SECONDS
    if not terminal_path.exists():
        require(
            same_process(owner["supervisor"]),
            "worker supervisor missing without terminal receipt",
        )
        request = {**expected, "supervisor": owner["supervisor"]}
        try:
            write_json(state / "stop.json", request)
        except FileExistsError:
            bound(read_json(state / "stop.json"), request)
    while not terminal_path.exists() or same_process(owner["supervisor"]):
        require(
            time.monotonic() < deadline,
            "worker drain not complete within capture deadline",
        )
        require(
            terminal_path.exists() or same_process(owner["supervisor"]),
            "supervisor disappeared without terminal receipt",
        )
        time.sleep(0.1)
    terminal = read_json(terminal_path)
    validate_records(owner, terminal, expected)
    require(not same_process(terminal["child"]), "worker child still alive")
    agents = Path(owner["agents_dir"])
    primary = Path(owner["primary_log"])
    logs = log_paths(agents, primary)
    inventory = [str(p.relative_to(agents)) for p in logs]
    if terminal["worker_started"] or terminal["exit_code"] == 0:
        require(
            set(owner["expected_worker_logs"]).issubset(inventory),
            "missing worker runtime log",
        )
    sources = {
        "receipts/owner.json": state / "owner.json",
        "receipts/terminal.json": terminal_path,
        "logs/worker.log": data / "worker.log",
    }
    sources.update({"logs/agents/" + str(p.relative_to(agents)): p for p in logs})
    output = Path(args.output).absolute()
    no_symlink(output)
    if output.exists():
        check_archive(output, expected)
        return
    with tempfile.TemporaryDirectory(prefix="worker-evidence-", dir=data) as temporary:
        stage = Path(temporary)
        files = {}
        total = 0
        for name, source in sources.items():
            require(time.monotonic() < deadline, "capture deadline exceeded")
            dest = stage / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            files[name] = stable_copy(source, dest)
            total += files[name]["bytes"]
            require(total <= MAX_BYTES, "worker evidence aggregate limit exceeded")
        require(
            log_paths(agents, primary) == logs,
            "worker log inventory changed during capture",
        )
        manifest = {
            **expected,
            "quiescent": True,
            "terminal": terminal,
            "worker_logs": inventory,
            "files": files,
        }
        write_json(stage / "manifest.json", manifest)
        # Exclusive output protects previous immutable captures. Failed partial
        # output is retained; it cannot be mistaken for a verified archive.
        fd = os.open(
            output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
        )
        with (
            os.fdopen(fd, "wb") as stream,
            tarfile.open(fileobj=stream, mode="w") as archive,
        ):
            for name in ["manifest.json", *sorted(files)]:
                require(time.monotonic() < deadline, "capture deadline exceeded")
                archive.add(stage / name, arcname=name, recursive=False)
        os.chmod(output, 0o600)
    check_archive(output, expected)


def safe_name(name):
    require(
        isinstance(name, str)
        and len(name) <= 512
        and re.fullmatch(r"[A-Za-z0-9_./-]+", name),
        "invalid archive path",
    )
    path = PurePosixPath(name)
    require(
        not path.is_absolute()
        and str(path) == name
        and all(p not in (".", "..", "") for p in path.parts),
        "unsafe archive path",
    )
    return name


def validate_manifest(manifest, expected):
    bound(manifest, expected)
    require(manifest.get("quiescent") is True, "nonquiescent manifest")
    files = manifest.get("files")
    require(
        isinstance(files, dict) and 3 <= len(files) <= MAX_FILES,
        "invalid evidence inventory",
    )
    require(
        {"receipts/owner.json", "receipts/terminal.json", "logs/worker.log"}.issubset(
            files
        ),
        "missing mandatory evidence",
    )
    total = 0
    for name, record in files.items():
        safe_name(name)
        require(
            name in ("receipts/owner.json", "receipts/terminal.json", "logs/worker.log")
            or name.startswith("logs/agents/"),
            "unexpected evidence path",
        )
        require(
            isinstance(record, dict) and set(record) == {"bytes", "sha256"},
            "invalid file record",
        )
        require(
            type(record["bytes"]) is int
            and 0 <= record["bytes"] <= MAX_BYTES
            and isinstance(record["sha256"], str)
            and SHA.fullmatch(record["sha256"]),
            "invalid file digest",
        )
        total += record["bytes"]
    require(total <= MAX_BYTES, "worker evidence aggregate limit exceeded")
    inventory = manifest.get("worker_logs")
    require(
        isinstance(inventory, list) and len(set(inventory)) == len(inventory),
        "invalid worker log inventory",
    )
    require(
        {"logs/agents/" + p for p in inventory}
        == {p for p in files if p.startswith("logs/agents/")},
        "incomplete worker log inventory",
    )
    return files


def validate_bundle(manifest, owner, terminal, expected):
    validate_manifest(manifest, expected)
    validate_records(owner, terminal, expected)
    require(manifest.get("terminal") == terminal, "manifest terminal mismatch")
    if terminal["worker_started"] or terminal["exit_code"] == 0:
        require(
            set(owner["expected_worker_logs"]).issubset(manifest["worker_logs"]),
            "missing worker runtime log",
        )


def check_archive(path, expected, output=None):
    no_symlink(path)
    require(
        regular(path).st_size <= MAX_BYTES + 8 * 1024 * 1024,
        "archive size limit exceeded",
    )
    with tarfile.open(path, "r:") as archive:
        members = []
        for member in archive:
            members.append(member)
            require(len(members) <= MAX_FILES + 1, "too many archive entries")
        names = [safe_name(m.name) for m in members]
        require(
            len(names) == len(set(names))
            and all(m.isfile() and not m.issparse() for m in members),
            "nonregular or duplicate archive entries",
        )
        require("manifest.json" in names, "missing manifest")
        require(
            archive.getmember("manifest.json").size <= 1024 * 1024, "oversized manifest"
        )
        manifest = json.load(archive.extractfile("manifest.json"))
        files = validate_manifest(manifest, expected)
        require(set(names) == {"manifest.json", *files}, "archive inventory mismatch")
        records = {}
        for member in members:
            expected_file = files.get(member.name)
            require(member.size <= MAX_BYTES, "oversized archive entry")
            digest = hashlib.sha256()
            size = 0
            chunks = (
                []
                if member.name in ("receipts/owner.json", "receipts/terminal.json")
                else None
            )
            if chunks is not None:
                require(member.size <= 1024 * 1024, "oversized receipt")
            with archive.extractfile(member) as stream:
                while block := stream.read(1024 * 1024):
                    digest.update(block)
                    size += len(block)
                    if chunks is not None:
                        chunks.append(block)
            if expected_file is not None:
                require(
                    {"bytes": size, "sha256": digest.hexdigest()} == expected_file,
                    "archive digest mismatch",
                )
            if chunks is not None:
                records[member.name] = json.loads(b"".join(chunks))
        validate_bundle(
            manifest,
            records["receipts/owner.json"],
            records["receipts/terminal.json"],
            expected,
        )
        sync_file(path)
        sync_directory(path.parent)
        if output is not None:
            output = Path(output).absolute()
            no_symlink(output)
            if output.exists():
                current = verify_directory(output, expected)
                require(current == manifest, "existing capture differs from archive")
                return manifest
            output.mkdir(mode=0o700)
            for member in members:
                target = output / member.name
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with archive.extractfile(member) as src, target.open("xb") as dest:
                    os.chmod(target, 0o600)
                    while block := src.read(1024 * 1024):
                        dest.write(block)
            verify_directory(output, expected)
    return manifest


def verify_directory(output, expected):
    output = Path(output).absolute()
    no_symlink(output)
    manifest = read_json(output / "manifest.json")
    files = validate_manifest(manifest, expected)
    actual = set()
    expected_dirs = {
        str(parent)
        for name in files
        for parent in PurePosixPath(name).parents
        if str(parent) != "."
    }
    count = 0
    for path in output.rglob("*"):
        count += 1
        require(count <= MAX_FILES * 2 + 1, "too many capture paths")
        no_symlink(path)
        if path.is_dir():
            require(
                str(path.relative_to(output)) in expected_dirs,
                "unexpected capture directory",
            )
            continue
        regular(path)
        actual.add(str(path.relative_to(output)))
    require(actual == {"manifest.json", *files}, "capture directory inventory mismatch")
    for name, record in files.items():
        path = output / name
        before = regular(path)
        require(
            before.st_size == record["bytes"] and before.st_size <= MAX_BYTES,
            "capture directory size mismatch",
        )
        digest = hashlib.sha256()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            require(
                stable_stat(os.fstat(stream.fileno())) == stable_stat(before),
                "capture directory identity changed",
            )
            remaining = before.st_size
            while remaining:
                block = stream.read(min(1024 * 1024, remaining))
                require(bool(block), "capture directory truncated")
                remaining -= len(block)
                digest.update(block)
            require(
                stable_stat(os.fstat(stream.fileno())) == stable_stat(before),
                "capture directory changed during verification",
            )
            os.fsync(stream.fileno())
        require(
            stable_stat(before) == stable_stat(path.lstat())
            and before.st_size == record["bytes"]
            and digest.hexdigest() == record["sha256"],
            "capture directory digest mismatch",
        )
    validate_bundle(
        manifest,
        read_json(output / "receipts/owner.json"),
        read_json(output / "receipts/terminal.json"),
        expected,
    )
    sync_file(output / "manifest.json")
    for directory in sorted(
        expected_dirs, key=lambda name: len(PurePosixPath(name).parts), reverse=True
    ):
        sync_directory(output / directory)
    sync_directory(output)
    sync_directory(output.parent)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    for mode in ("run", "capture", "verify", "verify-directory"):
        command = modes.add_parser(mode)
        command.add_argument("--run-token", required=True)
        command.add_argument("--machine-id", required=True)
        if mode in ("run", "capture"):
            command.add_argument("--data-dir", default="/data")
        if mode == "run":
            command.add_argument("--agents-dir", default="/data/repo/agents")
            command.add_argument("command", nargs=argparse.REMAINDER)
        if mode in ("capture", "verify", "verify-directory"):
            command.add_argument("--output", required=True)
        if mode == "verify":
            command.add_argument("archive")
    args = parser.parse_args()
    try:
        if args.mode == "run":
            if args.command and args.command[0] == "--":
                args.command.pop(0)
            require(bool(args.command), "missing worker command")
            return run(args)
        if args.mode == "capture":
            capture(args)
        elif args.mode == "verify":
            check_archive(
                Path(args.archive),
                authority(args.run_token, args.machine_id),
                args.output,
            )
        else:
            verify_directory(args.output, authority(args.run_token, args.machine_id))
        return 0
    except (OSError, ValueError, KeyError, tarfile.TarError) as exc:
        print(f"worker evidence rejected: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
