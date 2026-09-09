#!/usr/bin/env python3
"""Serve cloudbench artifacts and accept an authenticated barrier release."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import os
import re
import secrets
import signal
import socket
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


SAFE_BARRIER = re.compile(r"[A-Za-z0-9._-]+")
MAX_BENCH_LOG_CHUNK_BYTES = 262_144
BENCH_LOG_ANCHOR_BYTES = 4_096


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
        try:
            descriptor = os.open(
                log_generation_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
        except FileExistsError:
            log_generation = log_generation_path.read_text().strip()
        else:
            with os.fdopen(descriptor, "w") as generation_file:
                generation_file.write(f"{log_generation}\n")
    if re.fullmatch(r"[0-9a-f]{32}", log_generation) is None:
        raise SystemExit("invalid bench log generation")

    shutdown_request = root / f"cloudbench-shutdown-{run_token}.request"
    cleanup_ack = root / f"cloudbench-driver-clean-{run_token}.ack"

    def cleanup_acknowledged() -> bool:
        if not run_token:
            return False
        try:
            recorded = cleanup_ack.read_bytes().strip()
        except OSError:
            return False
        return hmac.compare_digest(recorded, run_token.encode())

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
            if self.path not in {"/release", "/shutdown"}:
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
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length:
                self.rfile.read(min(length, 1024))
            if self.path == "/shutdown":
                if not run_token:
                    self.send_error(409, "guest shutdown is not configured")
                    return
                shutdown_request.touch(exist_ok=True)
                if cleanup_acknowledged():
                    self.send_response(204)
                    self.end_headers()
                    return
                driver_pid = read_driver_pid()
                if driver_pid is None:
                    try:
                        driver_state = (root / "cloudbench-driver.state").read_text().strip()
                    except OSError:
                        driver_state = ""
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
            if self.path == "/shutdown-health":
                if not run_token or not token:
                    self.send_error(409, "guest shutdown is not configured")
                    return
                supplied = self.headers.get("Authorization", "")
                expected = f"Bearer {token}"
                if not hmac.compare_digest(supplied, expected):
                    self.send_error(403)
                    return
                if cleanup_acknowledged():
                    self.send_response(204)
                    self.end_headers()
                    return
                if not shutdown_request.exists():
                    self.send_error(409, "guest shutdown was not requested")
                    return
                try:
                    driver_state = (root / "cloudbench-driver.state").read_text().strip()
                except OSError:
                    driver_state = ""
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
            try:
                state = (root / "cloudbench-driver.state").read_text().strip()
            except OSError:
                state = ""
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
