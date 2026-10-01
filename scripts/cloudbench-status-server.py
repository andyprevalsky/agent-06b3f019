#!/usr/bin/env python3
"""Serve cloudbench artifacts and accept an authenticated barrier release."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import os
import re
import socket
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


SAFE_BARRIER = re.compile(r"[A-Za-z0-9._-]+")
MAX_LOG_CHUNK_BYTES = 262_144


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--port", required=True, type=int)
    # Fly machine-pinned *.internal names are 6PN IPv6 addresses. Binding only
    # IPv4 (0.0.0.0) leaves flyctl proxy connected to the VM but every HTTP
    # request resets because nothing listens on the IPv6 status port.
    parser.add_argument("--bind", default="::")
    parser.add_argument("--barrier", default="")
    parser.add_argument("--ready-file", default="")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.directory).resolve()
    barrier = args.barrier
    token = os.environ.get("CLOUDBENCH_BARRIER_TOKEN", "")
    if barrier and SAFE_BARRIER.fullmatch(barrier) is None:
        raise SystemExit("invalid barrier identifier")

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *handler_args: object, **handler_kwargs: object) -> None:
            super().__init__(*handler_args, directory=str(root), **handler_kwargs)

        def do_POST(self) -> None:
            if self.path != "/release":
                self.send_error(404)
                return
            if not barrier or not token:
                self.send_error(409, "barrier release is not configured")
                return
            supplied = self.headers.get("Authorization", "")
            expected = f"Bearer {token}"
            if not hmac.compare_digest(supplied, expected):
                self.send_error(403)
                return
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length:
                self.rfile.read(min(length, 1024))
            (root / f"cloudbench-start-{barrier}.release").touch(exist_ok=True)
            self.send_response(204)
            self.end_headers()

        def do_GET(self) -> None:
            request = urlsplit(self.path)
            log_path = root / "bench.log"
            translated = Path(self.translate_path(self.path))
            try:
                aliases_log = log_path.is_file() and translated.samefile(log_path)
            except OSError:
                aliases_log = False
            if request.path == "/bench.log":
                self._serve_log_chunk(request.query)
                return
            if aliases_log:
                self.send_error(400, "bench.log requires a bounded exact-path request")
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
            except (OSError, ValueError):
                # The boot supervisor can reap the child before sealing the
                # final log and state. A missing PID is still nonterminal.
                self.send_error(503, "driver finalization is pending")
                return
            try:
                os.kill(pid, 0)
            except OSError:
                self.send_error(410, "driver is not running")
                return
            self.send_response(204)
            self.end_headers()

        def _serve_log_chunk(self, query: str) -> None:
            params = parse_qs(query, keep_blank_values=True)
            if set(params) != {"offset", "limit"} or any(len(values) != 1 for values in params.values()):
                self.send_error(400, "offset and limit are required")
                return
            raw_offset, raw_limit = params["offset"][0], params["limit"][0]
            if not re.fullmatch(r"0|[1-9][0-9]*", raw_offset) or not re.fullmatch(r"[1-9][0-9]*", raw_limit):
                self.send_error(400, "invalid log range")
                return
            offset, limit = int(raw_offset), int(raw_limit)
            if limit > MAX_LOG_CHUNK_BYTES:
                self.send_error(400, "log range exceeds maximum chunk size")
                return
            try:
                with (root / "bench.log").open("rb") as handle:
                    stat = os.fstat(handle.fileno())
                    size = stat.st_size
                    generation = hashlib.blake2s(
                        f"{stat.st_dev}:{stat.st_ino}".encode(), digest_size=16
                    ).hexdigest()
                    supplied_generation = self.headers.get("X-Cloudbench-Log-Generation", "")
                    supplied_anchor = self.headers.get("X-Cloudbench-Log-Anchor", "")
                    reset = offset > size or bool(supplied_generation and supplied_generation != generation)
                    if supplied_anchor:
                        if not re.fullmatch(r"[0-9a-f]{64}", supplied_anchor):
                            self.send_error(400, "invalid log anchor")
                            return
                        if offset <= size:
                            handle.seek(max(0, offset - 4096))
                            anchor = hashlib.sha256(handle.read(min(offset, 4096))).hexdigest()
                            reset = reset or not hmac.compare_digest(supplied_anchor, anchor)
                    if reset:
                        self._send_log_headers(409, size, generation, 0)
                        return
                    if offset == size:
                        self._send_log_headers(204, size, generation, 0)
                        return
                    handle.seek(offset)
                    body = handle.read(min(limit, size - offset))
                    if not body:
                        self._send_log_headers(409, os.fstat(handle.fileno()).st_size, generation, 0)
                        return
            except OSError:
                self.send_error(404, "bench.log is unavailable")
                return
            self._send_log_headers(206, size, generation, len(body), offset=offset)
            self.wfile.write(body)

        def _send_log_headers(
            self, status: int, size: int, generation: str, length: int, *, offset: int = 0
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(length))
            self.send_header("X-Cloudbench-Log-Size", str(size))
            self.send_header("X-Cloudbench-Log-Generation", generation)
            self.send_header("X-Cloudbench-Log-Continuity", "1")
            if status == 206:
                self.send_header("Content-Range", f"bytes {offset}-{offset + length - 1}/{size}")
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
