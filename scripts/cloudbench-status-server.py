#!/usr/bin/env python3
"""Serve cloudbench artifacts and accept an authenticated barrier release."""

from __future__ import annotations

import argparse
import hmac
import os
import re
import signal
import socket
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


SAFE_BARRIER = re.compile(r"[A-Za-z0-9._-]+")


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

    shutdown_request = root / f"cloudbench-shutdown-{run_token}.request"
    cleanup_ack = root / f"cloudbench-driver-clean-{run_token}.ack"

    def cleanup_acknowledged() -> bool:
        if not run_token:
            return False
        try:
            return hmac.compare_digest(cleanup_ack.read_text().strip(), run_token)
        except OSError:
            return False

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
            if self.path == "/shutdown-health":
                if not run_token or not token:
                    self.send_error(409, "guest shutdown is not configured")
                    return
                supplied = self.headers.get("Authorization", "")
                expected = f"Bearer {token}"
                if not hmac.compare_digest(supplied, expected):
                    self.send_error(403)
                    return
                acknowledged = cleanup_acknowledged()
                requested = shutdown_request.exists()
                if acknowledged:
                    self.send_response(204)
                    self.end_headers()
                    return
                if not requested:
                    self.send_error(409, "guest shutdown was not requested")
                    return
                try:
                    driver_state = (root / "cloudbench-driver.state").read_text().strip()
                except OSError:
                    driver_state = ""
                if driver_state == "exited" or (
                    driver_state == "running" and read_driver_pid() is None
                ):
                    self.send_error(500, "driver exited without cleanup acknowledgement")
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
                self.send_error(410, "driver is not running")
                return
            self.send_response(204)
            self.end_headers()

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
