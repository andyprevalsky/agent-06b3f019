#!/usr/bin/env python3
"""Tiny stdlib HTTP server for the prompt-review UI.

Endpoints:
  GET  /                  → ui/index.html
  GET  /static/<path>     → ui/<path>
  GET  /api/data          → data.json (built by build.py)
  GET  /api/state         → checkpoints/state.json (review progress + notes)
  POST /api/state         → overwrite state.json (body: full state JSON)

Run:
    python3 prompt-review/server.py [--port 8765]

The state file is structured as:
    {
      "current_index": 0,
      "reviewed":  {"VERIFICATION_RULES": {"status": "completed", "notes": "..."}, ...}
    }
"""

from __future__ import annotations

import argparse
import json
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
UI_DIR = ROOT / "ui"
DATA_FILE = ROOT / "data.json"
STATE_FILE = ROOT / "checkpoints" / "state.json"

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}


def empty_state() -> dict:
    return {"current_index": 0, "reviewed": {}}


def migrate_phase_prompt_state(reviewed: dict) -> dict:
    build_state = reviewed.get("build_system_prompt")
    if not isinstance(build_state, dict):
        return reviewed
    text = build_state.get("edited_text")
    if not isinstance(text, str):
        return reviewed

    boundary = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"
    if boundary not in text or "# Current Phase" not in text:
        return reviewed

    before, after = text.split(boundary, 1)
    build_state["edited_text"] = before.rstrip() + "\n\n" + boundary

    phase_text = after.split("# Current Phase", 1)[1]
    if "# Tool Guidance" in phase_text:
        phase_text = phase_text.split("# Tool Guidance", 1)[0]
    phase_text = phase_text.strip()
    if phase_text.startswith("PLAN -") and not reviewed.get("PLAN_PHASE_PROMPT"):
        reviewed["PLAN_PHASE_PROMPT"] = {"edited_text": phase_text}
    elif phase_text.startswith("EXECUTE -") and not reviewed.get("EXECUTE_PHASE_PROMPT"):
        reviewed["EXECUTE_PHASE_PROMPT"] = {"edited_text": phase_text}
    return reviewed


def normalize_state(payload: object) -> dict:
    if not isinstance(payload, dict):
        return empty_state()

    current_index = payload.get("current_index", 0)
    if not isinstance(current_index, int) or current_index < 0:
        current_index = 0

    reviewed = payload.get("reviewed", {})
    if not isinstance(reviewed, dict) or isinstance(reviewed, list):
        reviewed = {}
    else:
        reviewed = {
            str(row_id): row_state
            for row_id, row_state in reviewed.items()
            if isinstance(row_state, dict)
        }
        reviewed = migrate_phase_prompt_state(reviewed)

    return {"current_index": current_index, "reviewed": reviewed}


def read_state() -> dict:
    if not STATE_FILE.exists():
        return empty_state()
    try:
        return normalize_state(json.loads(STATE_FILE.read_text()))
    except Exception:
        return empty_state()


def write_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    existing = read_state()
    existing_reviewed = existing.get("reviewed", {})
    incoming_reviewed = state.get("reviewed", {})
    if isinstance(existing_reviewed, dict) and isinstance(incoming_reviewed, dict):
        state = {
            **state,
            "reviewed": {
                **existing_reviewed,
                **incoming_reviewed,
            },
        }
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(normalize_state(state), indent=2))
    tmp.replace(STATE_FILE)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Quiet logs — only log errors.
        if args and isinstance(args[0], str) and args[0].startswith(("4", "5")):
            sys.stderr.write(f"[server] {self.address_string()} - {fmt % args}\n")

    def _send(self, status: int, body: bytes, ctype: str = "text/plain") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _send_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self._send(HTTPStatus.NOT_FOUND, b"not found")
            return
        ctype = CONTENT_TYPES.get(path.suffix, "application/octet-stream")
        self._send(HTTPStatus.OK, path.read_bytes(), ctype)

    def do_GET(self):
        url = urlparse(self.path)
        route = url.path

        if route == "/" or route == "/index.html":
            self._send_file(UI_DIR / "index.html")
            return
        if route.startswith("/static/"):
            rel = route[len("/static/"):]
            target = (UI_DIR / rel).resolve()
            if not str(target).startswith(str(UI_DIR.resolve())):
                self._send(HTTPStatus.FORBIDDEN, b"forbidden")
                return
            self._send_file(target)
            return
        if route == "/api/data":
            if not DATA_FILE.exists():
                self._send_json({"error": "data.json missing — run build.py first"}, status=500)
                return
            self._send(HTTPStatus.OK, DATA_FILE.read_bytes(), "application/json; charset=utf-8")
            return
        if route == "/api/state":
            self._send_json(read_state())
            return
        self._send(HTTPStatus.NOT_FOUND, b"not found")

    def do_POST(self):
        if self.path != "/api/state":
            self._send(HTTPStatus.NOT_FOUND, b"not found")
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except json.JSONDecodeError as e:
            self._send_json({"error": f"bad json: {e}"}, status=400)
            return
        if not isinstance(payload, dict):
            self._send_json({"error": "expected {current_index, reviewed}"}, status=400)
            return
        state = normalize_state(payload)
        write_state(state)
        self._send_json({"ok": True, "state": state})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    if not DATA_FILE.exists():
        print(f"[server] WARNING: {DATA_FILE} missing — run `python3 prompt-review/build.py` first", file=sys.stderr)

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[server] http://127.0.0.1:{args.port}/", file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("[server] shutting down", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
