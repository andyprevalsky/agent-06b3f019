#!/usr/bin/env python3
"""Blackbox tests for scripts/check_stale_versions.py, the /deploy scorecard stale-version warning.

Each case runs the CLI against a temporary checkout holding the two pinned Dockerfiles and a
local HTTP npm registry serving recorded-shape documents (dist-tags + per-version release
times), at a fixed --now instant. The real checkout's pins are read offline with --list-pins.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/check_stale_versions.py"
NOW = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)
CLAUDE = "@anthropic-ai/claude-code"
CODEX = "@openai/codex"
# The fake registry is local: a proxy must not intercept it, and the ⚠️ lines must print
# under any host locale.
CHILD_ENV = {**os.environ, "NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1", "PYTHONIOENCODING": "utf-8"}


def iso(days_ago: float) -> str:
    return (NOW - timedelta(days=days_ago)).isoformat().replace("+00:00", "Z")


def document(dist_tags: dict[str, str], released_days_ago: dict[str, float]) -> dict:
    return {"dist-tags": dist_tags, "time": {v: iso(d) for v, d in released_days_ago.items()}}


class Registry:
    """A local npm registry: GET /<url-encoded package> returns its document, else 404."""

    def __init__(self, documents: dict[str, dict], truncated: tuple[str, ...] = ()) -> None:
        documents = dict(documents)

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                package = urllib.parse.unquote(self.path.lstrip("/"))
                body = documents.get(package)
                data = json.dumps(body if body is not None else {"error": "Not found"}).encode()
                self.send_response(200 if body is not None else 404)
                self.send_header("Content-Type", "application/json")
                if package in truncated:
                    # Promise more bytes than are sent, then close: the client sees IncompleteRead.
                    self.send_header("Content-Length", str(len(data) + 100))
                    self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args: object) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "Registry":
        self.thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.server.server_close()


class CheckStaleVersionsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.pin("2.1.305", "0.159.0")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def pin(self, claude: str | None, codex: str | None) -> None:
        for source, arg, version in (("claude-code", "CLAUDE_CODE_VERSION", claude),
                                     ("codex-code", "CODEX_VERSION", codex)):
            path = self.root / "e2b-templates" / source / "e2b.Dockerfile"
            path.parent.mkdir(parents=True, exist_ok=True)
            lines = ["FROM ubuntu:22.04", *([f"ARG {arg}={version}"] if version else []),
                     "ARG NODE_VERSION=22.23.4"]
            path.write_text("\n".join(lines) + "\n")

    def run_cli(self, registry: str, *extra: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(self.root), "--registry", registry,
             "--now", NOW.isoformat(), *extra],
            capture_output=True, text=True, encoding="utf-8", env=CHILD_ENV, timeout=60, check=False,
        )

    def rows(self, documents: dict[str, dict]) -> dict[str, dict]:
        with Registry(documents) as registry:
            result = self.run_cli(registry.url, "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        return {row["name"]: row for row in json.loads(result.stdout)}

    def test_pins_behind_for_over_a_month_print_stale_warnings(self) -> None:
        documents = {
            CLAUDE: document({"stable": "2.1.311", "latest": "2.1.325"},
                             {"2.1.305": 35, "2.1.311": 19, "2.1.325": 1}),
            CODEX: document({"latest": "0.169.0", "alpha": "0.170.0-alpha.1"},
                            {"0.159.0": 46, "0.169.0": 1, "0.170.0-alpha.1": 0.5}),
        }
        with Registry(documents) as registry:
            result = self.run_cli(registry.url)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            "⚠️ STALE VERSION — Claude Code CLI 2.1.305 (released 2026-10-10, 35 days old); newest stable "
            "2.1.311 (released 2026-10-26). Bump ARG CLAUDE_CODE_VERSION in "
            "e2b-templates/claude-code/e2b.Dockerfile and build its new templates.",
            "⚠️ STALE VERSION — Codex CLI 0.159.0 (released 2026-09-29, 46 days old); newest stable "
            "0.169.0 (released 2026-11-13). Bump ARG CODEX_VERSION in "
            "e2b-templates/codex-code/e2b.Dockerfile and build its new templates.",
        ])

    def test_pin_behind_by_a_month_or_less_is_not_stale(self) -> None:
        rows = self.rows({
            CLAUDE: document({"stable": "2.1.311"}, {"2.1.305": 30, "2.1.311": 2}),
            CODEX: document({"latest": "0.169.0"}, {"0.159.0": 12, "0.169.0": 1}),
        })
        self.assertEqual(rows["Claude Code CLI"]["status"], "behind")
        self.assertEqual(rows["Claude Code CLI"]["message"],
                         "OK — Claude Code CLI 2.1.305 is behind stable 2.1.311 but only 30 days old")
        self.assertEqual(rows["Codex CLI"]["status"], "behind")

    def test_claude_reads_its_stable_channel_not_latest(self) -> None:
        self.pin("2.1.311", "0.169.0")
        rows = self.rows({
            CLAUDE: document({"stable": "2.1.311", "latest": "2.1.325"}, {"2.1.311": 40, "2.1.325": 1}),
            CODEX: document({"latest": "0.169.0"}, {"0.169.0": 40}),
        })
        self.assertEqual({name: row["status"] for name, row in rows.items()},
                         {"Claude Code CLI": "current", "Codex CLI": "current"})
        self.assertEqual(rows["Claude Code CLI"]["message"], "OK — Claude Code CLI 2.1.311 is the newest stable release")

    def test_pin_ahead_of_the_channel_is_current(self) -> None:
        self.pin("2.1.325", "0.169.0")
        rows = self.rows({
            CLAUDE: document({"stable": "2.1.311"}, {"2.1.311": 60, "2.1.325": 45}),
            CODEX: document({"latest": "0.169.0"}, {"0.169.0": 1}),
        })
        self.assertEqual(rows["Claude Code CLI"]["status"], "current")

    def test_versions_compare_numerically(self) -> None:
        self.pin("2.1.99", "0.9.0")
        rows = self.rows({
            CLAUDE: document({"stable": "2.1.100"}, {"2.1.99": 31, "2.1.100": 3}),
            CODEX: document({"latest": "0.10.0"}, {"0.9.0": 31, "0.10.0": 3}),
        })
        self.assertEqual({name: row["status"] for name, row in rows.items()},
                         {"Claude Code CLI": "stale", "Codex CLI": "stale"})

    def test_unreadable_registry_is_an_unmeasured_warning_not_ok(self) -> None:
        with Registry({CLAUDE: document({"stable": "2.1.311"}, {"2.1.311": 1})}) as registry:
            result = self.run_cli(registry.url)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 2)
        # The pinned release is missing from the document's release times.
        self.assertTrue(lines[0].startswith("⚠️ UNMEASURED VERSION — Claude Code CLI 2.1.305: "), lines[0])
        self.assertIn("KeyError", lines[0])
        self.assertTrue(lines[1].startswith("⚠️ UNMEASURED VERSION — Codex CLI 0.159.0: "), lines[1])
        self.assertIn("HTTP Error 404", lines[1])

    def test_truncated_registry_answer_is_unmeasured_and_keeps_the_other_line(self) -> None:
        documents = {
            CLAUDE: document({"stable": "2.1.311"}, {"2.1.305": 35, "2.1.311": 19}),
            CODEX: document({"latest": "0.169.0"}, {"0.159.0": 46, "0.169.0": 1}),
        }
        with Registry(documents, truncated=(CLAUDE,)) as registry:
            result = self.run_cli(registry.url)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 2, result.stdout + result.stderr)
        self.assertTrue(lines[0].startswith("⚠️ UNMEASURED VERSION — Claude Code CLI 2.1.305: "), lines[0])
        self.assertIn("IncompleteRead", lines[0])
        self.assertTrue(lines[1].startswith("⚠️ STALE VERSION — Codex CLI 0.159.0 "), lines[1])

    def test_missing_pin_exits_nonzero_and_names_the_file(self) -> None:
        self.pin("2.1.311", None)
        result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root), "--list-pins"],
                                capture_output=True, text=True, encoding="utf-8", env=CHILD_ENV, timeout=60, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("no `ARG CODEX_VERSION=<version>` in e2b-templates/codex-code/e2b.Dockerfile", result.stderr)
        self.assertEqual(result.stdout.splitlines(), ["Claude Code CLI 2.1.311 (@anthropic-ai/claude-code, stable)"])

    def test_missing_pin_still_prints_a_followup_line_for_the_scorecard(self) -> None:
        self.pin("2.1.311", None)
        with Registry({CLAUDE: document({"stable": "2.1.311"}, {"2.1.311": 3})}) as registry:
            result = self.run_cli(registry.url)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.splitlines(), [
            "OK — Claude Code CLI 2.1.311 is the newest stable release",
            "⚠️ UNMEASURED VERSION — Codex CLI: no `ARG CODEX_VERSION=<version>` in "
            "e2b-templates/codex-code/e2b.Dockerfile",
        ])

    def test_this_checkout_ships_readable_pins_for_every_critical_dependency(self) -> None:
        result = subprocess.run([sys.executable, str(SCRIPT), "--list-pins"],
                                capture_output=True, text=True, encoding="utf-8", env=CHILD_ENV, timeout=60, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        names = [line.split(" (", 1)[0].rsplit(" ", 1)[0] for line in result.stdout.splitlines()]
        self.assertEqual(names, ["Claude Code CLI", "Codex CLI"])


if __name__ == "__main__":
    unittest.main()
