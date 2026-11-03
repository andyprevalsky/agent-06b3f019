#!/usr/bin/env python3
"""Hermetic regression tests for the skippable exact-HEAD Graphide review read."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "read_graphide_review", ROOT / "scripts/read_graphide_review.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

SLUG = "Rose-Ai-Labs/rose"
HEAD = "a" * 40
BOT = {"login": "graphide-review[bot]", "type": "Bot"}
HUMAN = {"login": "andy", "type": "User"}


class FakeGitHub:
    """Serves GitHub REST pages from a list of per-poll snapshots."""

    def __init__(self, snapshots: list[dict[str, object]]) -> None:
        self.snapshots = snapshots
        self.poll = -1
        self.calls: list[str] = []

    def __call__(self, endpoint: str) -> object:
        self.calls.append(endpoint)
        path = endpoint.split("?", 1)[0]
        if path == f"repos/{SLUG}/pulls/7":
            self.poll = min(self.poll + 1, len(self.snapshots) - 1)
        snapshot = self.snapshots[self.poll]
        if "error" in snapshot:
            raise RuntimeError(str(snapshot["error"]))
        if path == f"repos/{SLUG}/pulls/7":
            return {"head": {"sha": snapshot.get("head", HEAD)}}
        if path == f"repos/{SLUG}/commits/{HEAD}/check-runs":
            return {"check_runs": snapshot.get("check_runs", [])}
        if path.endswith("/annotations"):
            return snapshot.get("annotations", [])
        key = {
            f"repos/{SLUG}/pulls/7/reviews": "reviews",
            f"repos/{SLUG}/pulls/7/comments": "review_comments",
            f"repos/{SLUG}/issues/7/comments": "issue_comments",
        }[path]
        return snapshot.get(key, [])


def run(fake: FakeGitHub, *, timeout: float = 60, since: datetime | None = None) -> dict:
    clock = {"now": 0.0}
    return MODULE.read_review(
        pr="7",
        head=HEAD,
        slug=SLUG,
        since=since,
        timeout_seconds=timeout,
        poll_seconds=15,
        api=fake,
        sleeper=lambda seconds: clock.__setitem__("now", clock["now"] + seconds),
        clock=lambda: clock["now"],
    )


def graphide_run(status: str, conclusion: str | None = None, annotations: int = 0) -> dict:
    return {
        "id": 99,
        "name": "Graphide review",
        "status": status,
        "conclusion": conclusion,
        "app": {"slug": "graphide-review"},
        "output": {
            "title": "1 blocking",
            "summary": "rule broken",
            "annotations_count": annotations,
        },
    }


class ReadGraphideReviewTest(unittest.TestCase):
    def test_no_request_answer_times_out_as_skipped(self) -> None:
        coderabbit = dict(graphide_run("completed", "success"), app={"slug": "coderabbitai"})
        result = run(FakeGitHub([{"check_runs": [coderabbit]}]), timeout=60)
        self.assertEqual(result["status"], "skipped")
        self.assertIn("timed out", result["reason"])
        self.assertEqual(result["head"], HEAD)

    def test_waits_through_in_progress_then_reads_check_and_annotations(self) -> None:
        annotation = {
            "path": "a.py",
            "start_line": 3,
            "annotation_level": "failure",
            "message": "crash",
        }
        fake = FakeGitHub(
            [
                {"check_runs": [graphide_run("in_progress")]},
                {
                    "check_runs": [graphide_run("completed", "failure", 1)],
                    "annotations": [annotation],
                },
            ]
        )
        result = run(fake)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["finding_count"], 1)
        check = result["check_runs"][0]
        self.assertEqual(check["conclusion"], "failure")
        self.assertEqual(check["annotations"][0]["message"], "crash")
        self.assertIn(f"repos/{SLUG}/check-runs/99/annotations?per_page=100&page=1", fake.calls)

    def test_head_change_is_skipped_not_raised(self) -> None:
        result = run(FakeGitHub([{"head": "b" * 40}]))
        self.assertEqual(result["status"], "skipped")
        self.assertIn("HEAD changed", result["reason"])

    def test_github_errors_never_block(self) -> None:
        result = run(FakeGitHub([{"error": "HTTP 403 Resource not accessible"}]), timeout=30)
        self.assertEqual(result["status"], "skipped")
        self.assertIn("403", result["reason"])

    def test_cancelled_check_is_skipped(self) -> None:
        result = run(FakeGitHub([{"check_runs": [graphide_run("completed", "cancelled")]}]))
        self.assertEqual(result["status"], "skipped")
        self.assertIn("cancelled", result["reason"])

    def test_bot_comments_are_scoped_to_head_and_request_time(self) -> None:
        since = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)
        fake = FakeGitHub(
            [
                {
                    "reviews": [
                        {"id": 1, "user": BOT, "commit_id": "c" * 40, "body": "old head"},
                        {"id": 2, "user": BOT, "commit_id": HEAD, "body": "ok"},
                        {"id": 3, "user": HUMAN, "commit_id": HEAD, "body": "human"},
                    ],
                    "review_comments": [
                        {
                            "id": 4,
                            "user": BOT,
                            "commit_id": "c" * 40,
                            "original_commit_id": HEAD,
                            "body": "null deref",
                        },
                    ],
                    "issue_comments": [
                        {"id": 5, "user": BOT, "created_at": "2026-10-27T11:00Z", "body": "old"},
                        {
                            "id": 6,
                            "user": {"login": "x"},
                            "performed_via_github_app": {"slug": "graphide-review"},
                            "created_at": "2026-10-27T12:05:00Z",
                            "body": "fresh",
                        },
                    ],
                }
            ]
        )
        result = run(fake, since=since)
        self.assertEqual(result["status"], "completed")
        self.assertEqual([r["id"] for r in result["reviews"]], [2])
        self.assertEqual([c["id"] for c in result["review_comments"]], [4])
        self.assertEqual([c["id"] for c in result["issue_comments"]], [6])
        self.assertEqual(result["finding_count"], 1)

    def test_cli_unresolvable_repo_exits_zero_with_skipped_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            gh = Path(tmp) / "gh"
            gh.write_text("#!/bin/sh\necho 'gh: not authenticated' >&2\nexit 1\n")
            gh.chmod(0o755)
            env = dict(os.environ, PATH=f"{tmp}:{os.environ['PATH']}")
            completed = subprocess.run(
                [
                    "bash",
                    str(ROOT / "scripts/read-graphide-review"),
                    "--pr",
                    "7",
                    "--head",
                    HEAD,
                ],
                capture_output=True,
                text=True,
                env=env,
                timeout=60,
                check=False,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["status"], "skipped")
        self.assertEqual(payload["head"], HEAD)


if __name__ == "__main__":
    unittest.main()
