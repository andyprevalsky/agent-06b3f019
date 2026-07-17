#!/usr/bin/env python3
"""Serve cloudbench artifacts and accept an authenticated barrier release."""

from __future__ import annotations

import argparse
import hmac
import os
import re
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
            if self.path != "/driver-health":
                super().do_GET()
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
