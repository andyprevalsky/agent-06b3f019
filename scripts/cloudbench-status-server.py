#!/usr/bin/env python3
"""Serve cloudbench artifacts and accept an authenticated barrier release."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import signal
import socket
import stat
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


SAFE_BARRIER = re.compile(r"[A-Za-z0-9._-]+")
MAX_BENCH_LOG_CHUNK_BYTES = 262_144
BENCH_LOG_ANCHOR_BYTES = 4_096
MAX_RECOVERY_RECEIPT_BYTES = 65_536
MAX_RECOVERY_STATE_BYTES = 1_048_576
MAX_RECOVERY_RUN_BYTES = 512 * 1024 * 1024
OPTIONAL_RUNTIME_EVIDENCE = ("wmh-serve-log.txt", "guest-diagnostics.jsonl")


def read_runtime_metadata(path: Path, maximum: int) -> bytes:
    if path.resolve(strict=True) != path:
        raise ValueError("unsafe runtime metadata")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
            raise ValueError("unsafe or oversized runtime metadata")
        data = source.read(before.st_size + 1)
        after = path.stat()
        if len(data) != before.st_size or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError("runtime metadata changed")
        return data


def runtime_evidence_paths(root: Path, run_token: str, cleanup_state: str = "clean") -> dict[str, Path]:
    """Enumerate the complete stopped stack, never a capped agent-filtered view."""
    return runtime_evidence_context_paths(root / "repo/.context/cloudbench", run_token, cleanup_state)


def runtime_evidence_context_paths(context: Path, run_token: str, cleanup_state: str = "clean") -> dict[str, Path]:
    """Apply the same stopped-stack contract to original or collected contexts.

    ``cleanup_state="failed"`` is the diagnostic-only view of a stack whose
    own teardown failed (for example a worker drain that outlived its grace).
    run.sh then records services as stopped or failed; the files are still the
    only copy of the worker/stack logs that explain the failure.
    """
    if cleanup_state not in ("clean", "failed"):
        raise ValueError("unsupported cleanup state")
    service_path = context / "services.json"
    services = json.loads(read_runtime_metadata(service_path, MAX_RECOVERY_STATE_BYTES))
    count = services["env"]["worker_processes"]
    allowed = ("stopped",) if cleanup_state == "clean" else ("stopped", "failed")
    if services["status"] not in allowed or type(count) is not int or not 1 <= count <= 1024:
        raise ValueError("stack is not stopped or worker inventory is invalid")
    names = {"worker.log", *(f"worker.{i}.log" for i in range(1, count))}
    if {p.name for p in (context / "logs").glob("worker*.log")} != names:
        raise ValueError("worker log inventory is incomplete")
    cleanup_name = f"cloudbench-stack-cleanup-{run_token}.status"
    paths = {name: context / name for name in ["services.json", "run.json", "stack.log", cleanup_name, "logs/backend.log", *("logs/" + n for n in sorted(names))]}
    # The served WMH's own log (per-step server timing) exists only when the
    # stack served a world model. It is stopped with the stack like the rest.
    # The guest diagnostics samples (CPU/load, DB pool, pg_stat_activity) exist
    # only when the sampler ran.
    for optional in OPTIONAL_RUNTIME_EVIDENCE:
        if os.path.lexists(context / optional):
            paths[optional] = context / optional
    total = 0
    for path in paths.values():
        info = path.lstat()
        if path.resolve(strict=True) != path or not stat.S_ISREG(info.st_mode):
            raise ValueError("unsafe runtime evidence")
        total += info.st_size
    if total > MAX_RECOVERY_RUN_BYTES:
        raise ValueError("runtime evidence exceeds recovery byte ceiling")
    cleanup = dict(line.split("=", 1) for line in read_runtime_metadata(paths[cleanup_name], MAX_RECOVERY_RECEIPT_BYTES).decode().splitlines())
    if cleanup.get("state") != cleanup_state or cleanup.get("token") != run_token:
        raise ValueError("stack cleanup is not acknowledged" if cleanup_state == "clean"
                         else "stack cleanup did not record failure")
    return paths


def prelaunch_sealed(root: Path, run_token: str) -> bool:
    """The boot supervisor stopped before launching any driver, stack or browser.

    cloudbench-boot.sh writes this token-bound seal only on its no-launch paths,
    before the cleanup ACK, so the only runtime evidence is the exact bench.log.
    """
    seal = root / f"cloudbench-prelaunch-{run_token}.sealed"
    try:
        info = seal.lstat()
        return (stat.S_ISREG(info.st_mode)
                and read_runtime_metadata(seal, MAX_RECOVERY_RECEIPT_BYTES) == f"{run_token}\n".encode()
                and not os.path.lexists(root / "cloudbench-driver.pid"))
    except (OSError, ValueError):
        return False


def prestack_evidence_paths(root: Path, run_token: str) -> dict[str, Path]:
    """The native driver acknowledged cleanup without ever attempting run.sh."""
    seal = root / f"cloudbench-prestack-{run_token}.sealed"
    expected = f"{run_token}\n".encode()
    if (read_runtime_metadata(seal, MAX_RECOVERY_RECEIPT_BYTES) != expected
        or read_runtime_metadata(root / f"cloudbench-driver-clean-{run_token}.ack", MAX_RECOVERY_RECEIPT_BYTES) != expected
        or read_runtime_metadata(root / "cloudbench-driver.state", MAX_RECOVERY_RECEIPT_BYTES) != b"exited\n"
        or os.path.lexists(root / "cloudbench-driver.pid")):
        raise ValueError("pre-stack driver is not terminal and acknowledged")
    context = root / "repo/.context/cloudbench"
    if any(os.path.lexists(context / name) for name in
           ("services.json", "run.json", "stack.log", "logs/backend.log", "logs/worker.log")):
        raise ValueError("pre-stack seal conflicts with stack evidence")
    return {"bench.log": root / "bench.log", seal.name: seal}


def runtime_evidence_manifest(root: Path, run_token: str, machine: str, cleanup_state: str = "clean") -> dict:
    if cleanup_state == "clean" and prelaunch_sealed(root, run_token):
        manifest = runtime_evidence_files_manifest({"bench.log": root / "bench.log"}, run_token, machine)
        manifest["prelaunch"] = True
        return manifest
    if cleanup_state == "clean" and os.path.lexists(root / f"cloudbench-prestack-{run_token}.sealed"):
        manifest = runtime_evidence_files_manifest(prestack_evidence_paths(root, run_token), run_token, machine)
        manifest["prestack"] = True
        return manifest
    return runtime_evidence_context_manifest(root / "repo/.context/cloudbench", run_token, machine, cleanup_state)


def runtime_evidence_context_manifest(context: Path, run_token: str, machine: str,
                                      cleanup_state: str = "clean") -> dict:
    paths = runtime_evidence_context_paths(context, run_token, cleanup_state)
    manifest = runtime_evidence_files_manifest(paths, run_token, machine)
    if runtime_evidence_context_paths(context, run_token, cleanup_state) != paths:
        raise ValueError("runtime inventory changed")
    if cleanup_state != "clean":
        manifest["stack_cleanup_state"] = cleanup_state
    return manifest


def runtime_evidence_files_manifest(paths: dict[str, Path], run_token: str, machine: str) -> dict:
    files = {}
    for name, path in paths.items():
        before = path.stat()
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as source:
            opened = os.fstat(source.fileno())
            if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns):
                raise ValueError("runtime evidence changed before read")
            digest = hashlib.sha256()
            remaining = opened.st_size
            while remaining:
                block = source.read(min(65_536, remaining))
                if not block:
                    raise ValueError("runtime evidence ended early")
                digest.update(block)
                remaining -= len(block)
            after = path.stat()
            if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns):
                raise ValueError("runtime evidence changed during read")
        files[name] = {"bytes": opened.st_size, "sha256": digest.hexdigest()}
    return {"version": 1, "run_token": run_token, "machine_id": machine, "files": files}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--port", required=True, type=int)
    # Fly machine-pinned *.internal names are 6PN IPv6 addresses. Binding only
    # IPv4 (0.0.0.0) leaves flyctl proxy connected to the VM but every HTTP
    # request resets because nothing listens on the IPv6 status port.
    parser.add_argument("--bind", default="::")
    parser.add_argument("--barrier", default="")
    parser.add_argument("--run-token", default="")
    parser.add_argument("--ready-file", default="")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.directory).resolve()
    barrier = args.barrier
    run_token = args.run_token
    token = os.environ.get("CLOUDBENCH_BARRIER_TOKEN", "")
    if barrier and SAFE_BARRIER.fullmatch(barrier) is None:
        raise SystemExit("invalid barrier identifier")
    if run_token and SAFE_BARRIER.fullmatch(run_token) is None:
        raise SystemExit("invalid run token")

    # The generation belongs to the log, not this server process. The exact
    # writer boundary removes it before truncating bench.log; a replacement
    # status server reuses the durable value instead of forcing a full replay.
    log_generation_path = root / "bench.log.generation"
    try:
        log_generation = log_generation_path.read_text().strip()
    except FileNotFoundError:
        log_generation = secrets.token_hex(16)
        descriptor, staged_name = tempfile.mkstemp(
            dir=root, prefix=".bench.log.generation."
        )
        staged_path = Path(staged_name)
        try:
            with os.fdopen(descriptor, "w") as generation_file:
                generation_file.write(f"{log_generation}\n")
                generation_file.flush()
                os.fsync(generation_file.fileno())
            try:
                os.link(staged_path, log_generation_path)
            except FileExistsError:
                log_generation = log_generation_path.read_text().strip()
        finally:
            staged_path.unlink(missing_ok=True)
    if re.fullmatch(r"[0-9a-f]{32}", log_generation) is None:
        raise SystemExit("invalid bench log generation")

    shutdown_request = root / f"cloudbench-shutdown-{run_token}.request"
    cleanup_ack = root / f"cloudbench-driver-clean-{run_token}.ack"
    recovery_evidence_limits = {
        f"/cloudbench-interrupt-cleanup-{run_token}.status": MAX_RECOVERY_RECEIPT_BYTES,
        f"/cloudbench-guest-quiescence-{run_token}.json": MAX_RECOVERY_STATE_BYTES,
        f"/cloudbench-guest-state-{run_token}.json": MAX_RECOVERY_STATE_BYTES,
        f"/cloudbench-zero-allocation-{run_token}.json": MAX_RECOVERY_STATE_BYTES,
        "/repo/.context/cloudbench/run.json": MAX_RECOVERY_RUN_BYTES,
        "/repo/.context/cloudbench/logs/backend.log": MAX_RECOVERY_RUN_BYTES,
    }
    recovery_evidence_targets = {
        root / request_path.removeprefix("/"): maximum
        for request_path, maximum in recovery_evidence_limits.items()
    }

    def cleanup_acknowledged() -> bool:
        if not run_token:
            return False
        try:
            recorded = cleanup_ack.read_bytes().strip()
        except OSError:
            return False
        return hmac.compare_digest(recorded, run_token.encode())

    def read_driver_state() -> str:
        try:
            return (root / "cloudbench-driver.state").read_text().strip()
        except OSError:
            return ""

    def read_driver_pid() -> int | None:
        try:
            pid = int((root / "cloudbench-driver.pid").read_text().strip())
            os.kill(pid, 0)
            return pid
        except (OSError, ValueError):
            return None

    def driver_owns_run(pid: int) -> bool:
        """Reject a stale/reused PID before signalling an unrelated process."""
        try:
            environment = (Path("/proc") / str(pid) / "environ").read_bytes().split(b"\0")
        except OSError:
            return False
        expected = f"CLOUDBENCH_RUN_TOKEN={run_token}".encode()
        return any(hmac.compare_digest(entry, expected) for entry in environment)

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *handler_args: object, **handler_kwargs: object) -> None:
            super().__init__(*handler_args, directory=str(root), **handler_kwargs)

        def do_POST(self) -> None:
            if self.path not in {"/release", "/shutdown", "/outcome-published"}:
                self.send_error(404)
                return
            if not token:
                self.send_error(409, "authenticated control is not configured")
                return
            supplied = self.headers.get("Authorization", "")
            expected = f"Bearer {token}"
            if not hmac.compare_digest(supplied, expected):
                self.send_error(403)
                return
            if self.path == "/outcome-published":
                machine = os.environ.get("FLY_MACHINE_ID", "")
                if (not run_token or not machine
                    or self.headers.get("X-Cloudbench-Run-Token") != run_token
                    or self.headers.get("X-Cloudbench-Machine-Id") != machine):
                    self.send_error(409, "outcome identity does not match this guest")
                    return
                context = root / "repo/.context/cloudbench"
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= 4096:
                        raise ValueError
                    value = json.loads(self.rfile.read(length))
                    pending = json.loads(read_runtime_metadata(
                        context / f"cloudbench-outcome-{run_token}.pending.json", 4096))
                    canonical = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
                    if (canonical != json.dumps(pending, sort_keys=True, separators=(",", ":")).encode()
                        or type(value.get("version")) is not int or value.get("version") != 1
                        or value.get("run_token") != run_token or value.get("machine_id") != machine
                        or value.get("status") not in {"passed", "failed"}):
                        raise ValueError
                    signature = hashlib.sha256(canonical).hexdigest()
                    descriptor, temporary = tempfile.mkstemp(dir=context, prefix=".outcome-ack.")
                    try:
                        with os.fdopen(descriptor, "w") as output:
                            output.write(signature + "\n")
                            output.flush()
                            os.fsync(output.fileno())
                        os.chmod(temporary, 0o644)
                        os.replace(temporary, context / f"cloudbench-outcome-{run_token}.ack")
                    finally:
                        Path(temporary).unlink(missing_ok=True)
                except (OSError, ValueError, AttributeError):
                    self.send_error(409, "outcome does not match the evaluated packet")
                    return
                self.send_response(204)
                self.end_headers()
                return
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length:
                self.rfile.read(min(length, 1024))
            if self.path == "/shutdown":
                if not run_token:
                    self.send_error(409, "guest shutdown is not configured")
                    return
                shutdown_request.touch(exist_ok=True)
                if cleanup_acknowledged():
                    driver_state = read_driver_state()
                    if driver_state == "exited":
                        self.send_response(204)
                    elif driver_state in {"booting", "running"}:
                        self.send_response(202)
                    else:
                        self.send_error(503, "acknowledged driver state is invalid")
                        return
                    self.end_headers()
                    return
                driver_pid = read_driver_pid()
                if driver_pid is None:
                    driver_state = read_driver_state()
                    if driver_state == "exited":
                        self.send_error(500, "driver exited without cleanup acknowledgement")
                        return
                    # The boot entrypoint consumes the durable request before it
                    # can launch a driver, closing the booting-to-running race.
                    self.send_response(202)
                    self.end_headers()
                    return
                if not driver_owns_run(driver_pid):
                    self.send_error(409, "driver pid does not own this run")
                    return
                try:
                    os.kill(driver_pid, signal.SIGTERM)
                except OSError:
                    self.send_error(503, "driver could not be signalled")
                    return
                self.send_response(202)
                self.end_headers()
                return
            if not barrier:
                self.send_error(409, "barrier release is not configured")
                return
            (root / f"cloudbench-start-{barrier}.release").touch(exist_ok=True)
            self.send_response(204)
            self.end_headers()

        def do_GET(self) -> None:
            parsed = urlsplit(self.path)
            if parsed.path in ("/runtime-evidence", "/failed-runtime-evidence"):
                supplied = self.headers.get("Authorization", "")
                if not token or not hmac.compare_digest(supplied, f"Bearer {token}"):
                    self.send_error(403)
                    return
                machine = os.environ.get("FLY_MACHINE_ID", "")
                # The sealed view requires the driver's clean acknowledgement.
                # The failed view is diagnostic only: the driver exited and
                # refused that acknowledgement because the stack teardown
                # failed. It never makes /runtime-evidence or the ACK appear.
                cleanup_state = "clean" if parsed.path == "/runtime-evidence" else "failed"
                if (not run_token or not machine
                    or self.headers.get("X-Cloudbench-Run-Token") != run_token
                    or self.headers.get("X-Cloudbench-Machine-Id") != machine
                    or cleanup_acknowledged() != (cleanup_state == "clean")
                    or read_driver_state() != "exited"):
                    self.send_error(409, "exact runtime is not sealed")
                    return
                try:
                    parameters = parse_qs(parsed.query, keep_blank_values=True)
                    if parameters:
                        if set(parameters) != {"file"} or len(parameters["file"]) != 1:
                            raise ValueError("invalid runtime evidence request")
                        if cleanup_state == "clean" and prelaunch_sealed(root, run_token):
                            paths = {"bench.log": root / "bench.log"}
                        elif cleanup_state == "clean" and os.path.lexists(root / f"cloudbench-prestack-{run_token}.sealed"):
                            paths = prestack_evidence_paths(root, run_token)
                        else:
                            paths = runtime_evidence_paths(root, run_token, cleanup_state)
                        target = paths[parameters["file"][0]]
                        self._serve_recovery_evidence(target, MAX_RECOVERY_RUN_BYTES)
                    else:
                        data = json.dumps(runtime_evidence_manifest(root, run_token, machine, cleanup_state),
                                          sort_keys=True).encode()
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(data)))
                        self.send_header("Cache-Control", "no-store")
                        self.end_headers()
                        self.wfile.write(data)
                except (OSError, ValueError, KeyError, TypeError):
                    self.send_error(409, "runtime evidence is incomplete or changed")
                return
            # SimpleHTTPRequestHandler URL-decodes and normalizes dot segments
            # before static serving. Apply the bounded protocol to the resolved
            # target, not the spelling, so aliases (including symlinks) cannot
            # fall through to its unbounded file response.
            request_target = Path(self.translate_path(parsed.path)).resolve()
            bench_log_target = (root / "bench.log").resolve()
            try:
                targets_bench_log = request_target == bench_log_target or os.path.samefile(
                    request_target, bench_log_target
                )
            except OSError:
                targets_bench_log = request_target == bench_log_target
            if targets_bench_log:
                self._serve_bench_log_chunk(parsed.query)
                return
            recovery_target: Path | None = None
            recovery_maximum: int | None = None
            for candidate, maximum in recovery_evidence_targets.items():
                try:
                    same_target = (
                        request_target == candidate.resolve()
                        or os.path.samefile(request_target, candidate)
                    )
                except OSError:
                    same_target = request_target == candidate.resolve()
                if same_target:
                    recovery_target = candidate
                    recovery_maximum = maximum
                    break
            if recovery_target is not None and recovery_maximum is not None:
                if parsed.query:
                    self.send_error(400, "recovery evidence does not accept a query")
                    return
                if not run_token or not token:
                    self.send_error(409, "authenticated recovery is not configured")
                    return
                supplied = self.headers.get("Authorization", "")
                expected = f"Bearer {token}"
                if not hmac.compare_digest(supplied, expected):
                    self.send_error(403)
                    return
                self._serve_recovery_evidence(
                    recovery_target,
                    recovery_maximum,
                )
                return
            if self.path == "/shutdown-health":
                if not run_token or not token:
                    self.send_error(409, "guest shutdown is not configured")
                    return
                supplied = self.headers.get("Authorization", "")
                expected = f"Bearer {token}"
                if not hmac.compare_digest(supplied, expected):
                    self.send_error(403)
                    return
                # A fleet shares its barrier credential across siblings. The
                # autoscaler additionally names the exact workload and primary
                # before treating this endpoint as a runtime-completion seal.
                # Existing cleanup callers without either header are unchanged.
                expected_run = self.headers.get("X-Cloudbench-Run-Token")
                expected_machine = self.headers.get("X-Cloudbench-Machine-Id")
                if expected_run is not None or expected_machine is not None:
                    machine = os.environ.get("FLY_MACHINE_ID", "")
                    if (
                        not expected_run
                        or SAFE_BARRIER.fullmatch(expected_run) is None
                        or not expected_machine
                        or re.fullmatch(r"[0-9a-f]{14}", expected_machine) is None
                        or not hmac.compare_digest(expected_run, run_token)
                        or not hmac.compare_digest(expected_machine, machine)
                    ):
                        self.send_error(409, "runtime identity does not match this guest")
                        return
                if cleanup_acknowledged():
                    observed_state = read_driver_state()
                    if observed_state == "exited":
                        self.send_response(204)
                    elif observed_state in {"booting", "running"}:
                        self.send_response(202)
                    else:
                        self.send_error(503, "acknowledged driver state is invalid")
                        return
                    self.end_headers()
                    return
                if not shutdown_request.exists():
                    self.send_error(409, "guest shutdown was not requested")
                    return
                driver_state = read_driver_state()
                if driver_state == "exited":
                    self.send_error(500, "driver exited without cleanup acknowledgement")
                    return
                if driver_state == "running" and read_driver_pid() is None:
                    self.send_error(503, "driver exit is not sealed")
                    return
                self.send_response(202)
                self.end_headers()
                return
            if self.path != "/driver-health":
                super().do_GET()
                return
            state = read_driver_state()
            if state in {"", "booting"}:
                self.send_error(425, "driver has not launched")
                return
            if state == "exited":
                self.send_error(410, "driver has exited")
                return
            if state != "running":
                self.send_error(503, "driver lifecycle state is invalid")
                return
            try:
                pid = int((root / "cloudbench-driver.pid").read_text().strip())
                os.kill(pid, 0)
            except (OSError, ValueError):
                # The boot supervisor reaps the driver before appending its
                # final log record and atomically publishing state=exited.
                # A missing/dead PID in state=running is therefore not a
                # terminal evidence seal; only the explicit state above may
                # authorize the controller's final EOF collection.
                self.send_error(503, "driver exit is not sealed")
                return
            self.send_response(204)
            self.end_headers()

        def _serve_recovery_evidence(self, target: Path, maximum: int) -> None:
            """Serve one authenticated, regular, size-bounded exact guest file."""
            try:
                resolved = target.resolve(strict=True)
                resolved.relative_to(root)
                metadata = target.lstat()
            except (FileNotFoundError, OSError, RuntimeError, ValueError):
                self.send_error(404, "exact recovery evidence is unavailable")
                return
            if (
                resolved != target
                or target.is_symlink()
                or not stat.S_ISREG(metadata.st_mode)
            ):
                self.send_error(409, "exact recovery evidence is unsafe")
                return
            if metadata.st_size > maximum:
                self.send_error(413, "exact recovery evidence is oversized")
                return
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | os.O_NONBLOCK
            try:
                descriptor = os.open(resolved, flags)
            except OSError:
                self.send_error(404, "exact recovery evidence is unavailable")
                return
            try:
                with os.fdopen(descriptor, "rb") as source:
                    try:
                        opened = os.fstat(source.fileno())
                    except OSError:
                        self.send_error(404, "exact recovery evidence is unavailable")
                        return
                    if (
                        not stat.S_ISREG(opened.st_mode)
                        or opened.st_dev != metadata.st_dev
                        or opened.st_ino != metadata.st_ino
                        or opened.st_size != metadata.st_size
                        or opened.st_size > maximum
                    ):
                        self.send_error(409, "exact recovery evidence changed during read")
                        return
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(opened.st_size))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    remaining = opened.st_size
                    while remaining:
                        chunk = source.read(min(65_536, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                return

        def _serve_bench_log_chunk(self, query: str) -> None:
            """Serve one validated, bounded suffix of the append-only run log."""
            parameters = parse_qs(query, keep_blank_values=True)
            if set(parameters) != {"offset", "limit"} or any(
                len(values) != 1 for values in parameters.values()
            ):
                self.send_error(400, "bench log chunk requires one offset and limit")
                return
            offset_text = parameters["offset"][0]
            limit_text = parameters["limit"][0]
            anchor = self.headers.get("X-Cloudbench-Log-Anchor", "")
            requested_generation = self.headers.get(
                "X-Cloudbench-Log-Generation", ""
            )
            if not offset_text.isascii() or not offset_text.isdecimal():
                self.send_error(400, "bench log offset must be a non-negative integer")
                return
            if not limit_text.isascii() or not limit_text.isdecimal():
                self.send_error(400, "bench log limit must be a positive integer")
                return
            if anchor and re.fullmatch(r"[0-9a-f]{64}", anchor) is None:
                self.send_error(400, "bench log anchor must be a SHA-256 digest")
                return
            if requested_generation and re.fullmatch(
                r"[0-9a-f]{32}", requested_generation
            ) is None:
                self.send_error(400, "bench log generation is invalid")
                return
            offset = int(offset_text)
            limit = int(limit_text)
            if limit <= 0 or limit > MAX_BENCH_LOG_CHUNK_BYTES:
                self.send_error(
                    400,
                    f"bench log limit must be between 1 and {MAX_BENCH_LOG_CHUNK_BYTES}",
                )
                return

            try:
                handle = (root / "bench.log").open("rb")
            except OSError:
                self.send_error(404, "bench log does not exist")
                return
            with handle:
                metadata = os.fstat(handle.fileno())
                total_size = metadata.st_size

                def send_conflict() -> None:
                    self.send_response(409)
                    self.send_header("X-Cloudbench-Log-Size", str(total_size))
                    self.send_header(
                        "X-Cloudbench-Log-Generation", log_generation
                    )
                    self.send_header(
                        "X-Cloudbench-Log-Continuity", "1" if anchor else "0"
                    )
                    self.end_headers()

                if requested_generation and requested_generation != log_generation:
                    send_conflict()
                    return
                if offset > total_size:
                    send_conflict()
                    return

                # A size check alone misses truncate-and-regrow or same-size
                # replacement between polls. Verify a bounded suffix of the
                # controller's accepted prefix; this stays O(1) per request and
                # detects continuity loss without retransmitting the full log.
                if anchor:
                    anchor_start = max(0, offset - BENCH_LOG_ANCHOR_BYTES)
                    handle.seek(anchor_start)
                    anchor_bytes = handle.read(offset - anchor_start)
                    if len(anchor_bytes) != offset - anchor_start or not hmac.compare_digest(
                        hashlib.sha256(anchor_bytes).hexdigest(), anchor
                    ):
                        send_conflict()
                        return
                if offset == total_size:
                    self.send_response(204)
                    self.send_header("X-Cloudbench-Log-Size", str(total_size))
                    self.send_header(
                        "X-Cloudbench-Log-Generation", log_generation
                    )
                    self.send_header(
                        "X-Cloudbench-Log-Continuity", "1" if anchor else "0"
                    )
                    self.end_headers()
                    return

                end = min(total_size, offset + limit)
                length = end - offset
                self.send_response(206)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header(
                    "Content-Range", f"bytes {offset}-{end - 1}/{total_size}"
                )
                self.send_header("Content-Length", str(length))
                self.send_header("X-Cloudbench-Log-Generation", log_generation)
                self.send_header(
                    "X-Cloudbench-Log-Continuity", "1" if anchor else "0"
                )
                self.send_header("Last-Modified", self.date_time_string(metadata.st_mtime))
                self.end_headers()
                handle.seek(offset)
                remaining = length
                while remaining:
                    block = handle.read(min(65_536, remaining))
                    if not block:
                        break
                    try:
                        self.wfile.write(block)
                    except (BrokenPipeError, ConnectionResetError):
                        break
                    remaining -= len(block)

        def log_message(self, _format: str, *args: object) -> None:
            return

    server_class = ThreadingHTTPServer
    if ":" in args.bind:
        class IPv6ThreadingHTTPServer(ThreadingHTTPServer):
            address_family = socket.AF_INET6

            def server_bind(self) -> None:
                # Accept IPv4-mapped clients too when the host supports dual
                # stack; Fly itself connects over the machine's private IPv6.
                try:
                    self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
                except OSError:
                    pass
                super().server_bind()

        server_class = IPv6ThreadingHTTPServer
    server = server_class((args.bind, args.port), Handler)
    if args.ready_file:
        ready_file = Path(args.ready_file)
        ready_file.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", dir=ready_file.parent, prefix=f".{ready_file.name}.", delete=False
        ) as handle:
            handle.write(f"{server.server_port}\n")
            temporary = Path(handle.name)
        temporary.replace(ready_file)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
