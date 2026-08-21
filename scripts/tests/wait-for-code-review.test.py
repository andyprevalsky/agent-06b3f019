#!/usr/bin/env python3
"""Regression tests for exact-HEAD CodeRabbit waiting."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "wait_for_code_review", ROOT / "scripts/wait_for_code_review.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ReviewWaitTest(unittest.TestCase):
    def test_legacy_success_needs_no_started_at(self) -> None:
        head = "a" * 40
        payload = {
            "headRefOid": head,
            "statusCheckRollup": [
                {
                    "__typename": "StatusContext",
                    "context": "CodeRabbit",
                    "state": "SUCCESS",
                }
            ],
        }
        status = MODULE.wait_for_review(
            pr="123",
            expected_head=head,
            repo=None,
            timeout_seconds=1,
            poll_seconds=0,
            loader=lambda _pr, _repo: payload,
            sleeper=lambda _seconds: None,
        )

        self.assertTrue(status.terminal)
        self.assertTrue(status.successful)
        self.assertEqual(status.state, "SUCCESS")

    def test_waits_through_missing_and_pending_check_run(self) -> None:
        head = "b" * 40
        payloads = iter(
            [
                {"headRefOid": head, "statusCheckRollup": []},
                {
                    "headRefOid": head,
                    "statusCheckRollup": [
                        {
                            "__typename": "CheckRun",
                            "name": "CodeRabbit",
                            "status": "IN_PROGRESS",
                        }
                    ],
                },
                {
                    "headRefOid": head,
                    "statusCheckRollup": [
                        {
                            "__typename": "CheckRun",
                            "name": "CodeRabbit",
                            "status": "COMPLETED",
                            "conclusion": "SUCCESS",
                        }
                    ],
                },
            ]
        )
        status = MODULE.wait_for_review(
            pr="123",
            expected_head=head,
            repo=None,
            timeout_seconds=1,
            poll_seconds=0,
            loader=lambda _pr, _repo: next(payloads),
            sleeper=lambda _seconds: None,
        )

        self.assertEqual(status.state, "SUCCESS")

    def test_rejects_status_from_a_different_head(self) -> None:
        with self.assertRaisesRegex(MODULE.ReviewWaitError, "PR HEAD changed"):
            MODULE.wait_for_review(
                pr="123",
                expected_head="a" * 40,
                repo=None,
                timeout_seconds=1,
                poll_seconds=0,
                loader=lambda _pr, _repo: {
                    "headRefOid": "b" * 40,
                    "statusCheckRollup": [],
                },
                sleeper=lambda _seconds: None,
            )

    def test_review_skipped_success_is_not_substantive(self) -> None:
        status = MODULE.normalize_status(
            {
                "__typename": "StatusContext",
                "context": "CodeRabbit",
                "state": "SUCCESS",
                "description": "Review skipped: draft pull request",
            }
        )

        self.assertTrue(status.terminal)
        self.assertFalse(status.successful)
        self.assertEqual(status.state, "REVIEW_SKIPPED")

    def test_terminal_failure_is_not_successful(self) -> None:
        status = MODULE.normalize_status(
            {
                "__typename": "CheckRun",
                "name": "CodeRabbit",
                "status": "COMPLETED",
                "conclusion": "TIMED_OUT",
            }
        )

        self.assertTrue(status.terminal)
        self.assertFalse(status.successful)

    def test_commit_status_rollup_maps_rest_payload(self) -> None:
        calls: list[list[str]] = []

        def fake_gh_json(command: list[str], timeout=None) -> object:
            del timeout
            calls.append(command)
            if command[:2] == ["gh", "api"] and any(
                part.startswith("repos/acme/rose/commits/abc/status") for part in command
            ):
                # GitHub returns newest-first; rollup reverses so newest is last.
                return {
                    "statuses": [
                        {"context": "CodeRabbit", "state": "success"},
                        {"context": "Vercel", "state": "pending"},
                        {"context": None, "state": "success"},
                    ]
                }
            raise AssertionError(command)

        original = MODULE._gh_json
        MODULE._gh_json = fake_gh_json
        try:
            rollup = MODULE.gh_commit_status_rollup("abc", repo="acme/rose")
        finally:
            MODULE._gh_json = original

        self.assertEqual(
            rollup,
            [
                {
                    "__typename": "StatusContext",
                    "context": "Vercel",
                    "state": "PENDING",
                },
                {
                    "__typename": "StatusContext",
                    "context": "CodeRabbit",
                    "state": "SUCCESS",
                },
            ],
        )
        self.assertEqual(len(calls), 1)
        entry = MODULE.coderabbit_entry({"statusCheckRollup": rollup})
        self.assertEqual(entry and entry.get("state"), "SUCCESS")

    def test_commit_status_rollup_bounds_pages_and_shares_timeout_budget(self) -> None:
        timeouts: list[float | None] = []

        def fake_gh_json(command: list[str], timeout=None) -> object:
            timeouts.append(timeout)
            if command[:2] == ["gh", "api"] and any(
                part.startswith("repos/acme/rose/commits/abc/status") for part in command
            ):
                # Always return a full page so pagination would loop forever
                # without the max_pages bound.
                return {
                    "statuses": [
                        {"context": f"ctx-{len(timeouts)}", "state": "success"}
                        for _ in range(100)
                    ]
                }
            raise AssertionError(command)

        original = MODULE._gh_json
        MODULE._gh_json = fake_gh_json
        try:
            rollup = MODULE.gh_commit_status_rollup(
                "abc", repo="acme/rose", timeout=30.0
            )
        finally:
            MODULE._gh_json = original

        self.assertEqual(len(rollup), 20 * 100)
        self.assertEqual(len(timeouts), 20)
        self.assertTrue(all(t is not None and 0 < float(t) <= 30.0 for t in timeouts))

    def test_gh_api_json_rejects_untrusted_hostname(self) -> None:
        with self.assertRaises(MODULE.ReviewWaitError) as ctx:
            MODULE._gh_api_json(
                "repos/acme/rose/commits/abc/status",
                repo="evil.example/acme/rose",
                timeout=5.0,
            )
        self.assertIn("untrusted GitHub host", str(ctx.exception))

    def test_gh_payload_rejects_untrusted_hostname_before_gh(self) -> None:
        calls: list[object] = []

        def boom(*_args, **_kwargs):
            calls.append((_args, _kwargs))
            raise AssertionError("gh must not run for untrusted hosts")

        original = MODULE.subprocess.run
        MODULE.subprocess.run = boom
        try:
            with self.assertRaises(MODULE.ReviewWaitError) as ctx:
                MODULE.gh_payload("1", repo="evil.example/acme/rose", timeout=5.0)
        finally:
            MODULE.subprocess.run = original
        self.assertIn("untrusted GitHub host", str(ctx.exception))
        self.assertEqual(calls, [])

    def test_gh_payload_falls_back_when_status_check_rollup_forbidden(self) -> None:
        head = "c" * 40
        calls: list[list[str]] = []

        def fake_run(command, check=False, capture_output=True, text=True, timeout=None):
            del check, capture_output, text, timeout
            calls.append(list(command))
            if command[-1] == "headRefOid,statusCheckRollup":
                return MODULE.subprocess.CompletedProcess(
                    command,
                    1,
                    stdout="",
                    stderr=(
                        "GraphQL: Resource not accessible by access token "
                        "(repository.pullRequest.statusCheckRollup)"
                    ),
                )
            if command[-1] == "headRefOid":
                return MODULE.subprocess.CompletedProcess(
                    command,
                    0,
                    stdout=MODULE.json.dumps({"headRefOid": head}),
                    stderr="",
                )
            raise AssertionError(command)

        original_run = MODULE.subprocess.run
        original_rollup = MODULE.gh_commit_status_rollup

        def fake_rollup(_head, repo=None, timeout=None):
            del _head, repo, timeout
            return [
                {
                    "__typename": "StatusContext",
                    "context": "CodeRabbit",
                    "state": "SUCCESS",
                }
            ]

        MODULE.subprocess.run = fake_run
        MODULE.gh_commit_status_rollup = fake_rollup
        try:
            payload = MODULE.gh_payload("938", repo="acme/rose")
        finally:
            MODULE.subprocess.run = original_run
            MODULE.gh_commit_status_rollup = original_rollup

        self.assertEqual(payload["headRefOid"], head)
        self.assertEqual(payload["statusCheckRollup"][0]["context"], "CodeRabbit")
        self.assertGreaterEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
