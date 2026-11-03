#!/usr/bin/env python3
"""Agent-controlled live HTML display, with an optional StreamDiffusion adapter.

The agent writes a local state file; the public capability is read-only.
No Rose credentials, cookies, tool API or arbitrary upstream URLs enter HTML.
"""

import argparse
from contextlib import contextmanager
import fcntl
import json
import math
import os
from pathlib import Path
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

DEFAULT = {
    "revision": 0,
    "prompt": "A precision mechanical watch, brushed titanium, sapphire crystal, studio macro lighting",
    "hue": 205.0,
    "speed": 1.0,
    "mode": "webgl",
}


def validate(values):
    if set(values) - set(DEFAULT):
        raise ValueError("Unknown display setting")
    result = {**DEFAULT, **values}
    if not isinstance(result["prompt"], str) or not 1 <= len(result["prompt"]) <= 2000:
        raise ValueError("Prompt must have 1–2000 characters")
    for name, low, high in [("hue", 0, 360), ("speed", 0.1, 3)]:
        value = result[name]
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not low <= value <= high
        ):
            raise ValueError(f"{name} must be between {low} and {high}")
    if result["mode"] not in ("webgl", "diffusion"):
        raise ValueError("Mode must be webgl or diffusion")
    if type(result["revision"]) is not int or result["revision"] < 0:
        raise ValueError("Invalid revision")
    return result


def endpoint(value):
    parsed = urlsplit(value)
    if (
        parsed.scheme not in ("https", "http")
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Use an http(s) base URL without credentials, query or fragment")
    return value.rstrip("/")


@contextmanager
def locked(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(str(path) + ".lock", "a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def update(path, changes):
    with locked(path):
        state = validate(json.loads(path.read_text()) if path.exists() else {})
        state = validate({**state, **changes, "revision": state["revision"] + 1})
        temporary = path.with_name(path.name + ".tmp")
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as output:
            json.dump(state, output)
        temporary.replace(path)
    return state


class DisplayServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, state_path, public_url, upstream=None, token=None, modal_app=None):
        self.state_path = state_path
        self.capability = token or secrets.token_urlsafe(32)
        self.public_url = endpoint(public_url)
        self.upstream = endpoint(upstream) if upstream else None
        self.modal_app = modal_app
        if upstream and modal_app:
            raise ValueError("Choose one upstream provider")
        self.predict_lock = threading.Lock()
        self.last_frame = None
        self.last_revision = None
        self.last_frame_at = 0.0
        super().__init__(address, DisplayHandler)

    def state(self):
        return validate(json.loads(self.state_path.read_text()))

    def html(self):
        base = json.dumps(f"{self.public_url}/{self.capability}").replace("<", "\\u003c")
        return Path(__file__).with_name("view.html").read_text().replace("__DISPLAY_BASE__", base)


class DisplayHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log the viewer capability.

    def send(self, status, body, content_type="application/json"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self.send(405, '{"error":"Viewer is read-only"}')

    def do_GET(self):
        path = urlsplit(self.path).path
        prefix = "/" + self.server.capability
        if path not in (prefix, prefix + "/state", prefix + "/frame"):
            self.send(404, '{"error":"Not found"}')
            return
        if path == prefix:
            self.send(200, self.server.html(), "text/html; charset=utf-8")
            return
        try:
            state = self.server.state()
        except (OSError, ValueError):
            self.send(503, '{"error":"Display state unavailable"}')
            return
        if path.endswith("/state"):
            self.send(
                200, json.dumps({**state, "diffusionConfigured": bool(self.server.upstream or self.server.modal_app)})
            )
            return
        if not self.server.upstream and not self.server.modal_app:
            self.send(503, '{"error":"No StreamDiffusion service configured"}')
            return
        if not self.server.predict_lock.acquire(blocking=False):
            self.send(429, '{"error":"Frame already generating"}')
            return
        try:
            status, body = self.frame(state)
        finally:
            self.server.predict_lock.release()
        # Respond only after releasing, so the viewer's next request never
        # finds its own finished generation still holding the lock.
        self.send(status, body)

    def frame(self, state):
        try:
            # Coalesce concurrent viewers. No generation occurs without a frame
            # request; at most one upstream request is ever in flight.
            if self.server.last_revision != state["revision"] or time.monotonic() - self.server.last_frame_at > 0.5:
                if self.server.modal_app:
                    try:
                        import modal

                        worker = modal.Cls.from_name(self.server.modal_app, "StreamWorker")()
                        frame = worker.predict.remote(state["prompt"])["base64_image"]
                    except Exception as error:
                        raise RuntimeError("Private GPU service unavailable") from error
                else:
                    request = Request(
                        self.server.upstream + "/api/predict",
                        data=json.dumps({"prompt": state["prompt"]}).encode(),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urlopen(request, timeout=20) as response:
                        raw = response.read(8 * 1024 * 1024 + 1)
                    if len(raw) > 8 * 1024 * 1024:
                        raise ValueError("Oversized frame")
                    frame = json.loads(raw)["base64_image"]
                if not isinstance(frame, str) or len(frame) > 8 * 1024 * 1024:
                    raise ValueError("Invalid frame")
                import base64

                decoded = base64.b64decode(frame, validate=True)
                if not decoded.startswith(b"\xff\xd8\xff"):
                    raise ValueError("Expected upstream JPEG frame")
                if self.server.state()["revision"] != state["revision"]:
                    return 409, '{"error":"Settings changed; request the latest frame"}'
                self.server.last_frame = json.dumps({"revision": state["revision"], "base64_image": frame})
                self.server.last_revision = state["revision"]
                self.server.last_frame_at = time.monotonic()
            return 200, self.server.last_frame
        except (OSError, ValueError, KeyError, RuntimeError, HTTPError, URLError):
            return 502, '{"error":"StreamDiffusion frame unavailable"}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve")
    serve.add_argument("--state", type=Path, required=True)
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=7861)
    serve.add_argument("--public-url", required=True)
    provider = serve.add_mutually_exclusive_group()
    provider.add_argument("--upstream", help="Trusted StreamDiffusion txt2img service base URL")
    provider.add_argument("--modal-app", help="Private Modal app exposing StreamWorker.predict")
    serve.add_argument("--write-html", type=Path, required=True)
    change = commands.add_parser("set")
    change.add_argument("--state", type=Path, required=True)
    change.add_argument("--prompt")
    change.add_argument("--hue", type=float)
    change.add_argument("--speed", type=float)
    change.add_argument("--mode", choices=["webgl", "diffusion"])
    args = parser.parse_args()
    if args.command == "set":
        changes = {
            key: getattr(args, key) for key in ("prompt", "hue", "speed", "mode") if getattr(args, key) is not None
        }
        state = update(args.state, changes)
        print(json.dumps({"revision": state["revision"], "mode": state["mode"]}))
        return
    if not args.state.exists():
        update(args.state, {})
    server = DisplayServer((args.host, args.port), args.state, args.public_url, args.upstream, modal_app=args.modal_app)
    args.write_html.parent.mkdir(parents=True, exist_ok=True)
    args.write_html.write_text(server.html())
    print(
        json.dumps(
            {
                "display_file": str(args.write_html),
                "viewer_url": server.public_url + "/" + server.capability,
                "diffusion_configured": bool(server.upstream or server.modal_app),
            }
        ),
        flush=True,
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
