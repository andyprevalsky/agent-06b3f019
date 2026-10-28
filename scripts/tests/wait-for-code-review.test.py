#!/usr/bin/env python3
"""Regression tests for exact-HEAD CodeRabbit waiting."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_rides_out_a_rejected_github_token(self) -> None:
        # Cloud tokens rotate and can be rejected for minutes before the
        # replacement lands; a 401 mid-wait used to end the wait with exit 2.
        head = "e" * 40
        responses = iter(
            [
                MODULE.GhCommandError("HTTP 401: Bad credentials (https://api.github.com/graphql)"),
                MODULE.GhCommandError("HTTP 401: Bad credentials (https://api.github.com/graphql)"),
                {
                    "headRefOid": head,
                    "statusCheckRollup": [
                        {"__typename": "StatusContext", "context": "CodeRabbit", "state": "SUCCESS"}
                    ],
                },
            ]
        )

        def loader(_pr: str, _repo: str | None) -> dict[str, object]:
            response = next(responses)
            if isinstance(response, Exception):
                raise response
            return response

        messages: list[str] = []
        status = MODULE.wait_for_review(
            pr="123",
            expected_head=head,
            repo=None,
            timeout_seconds=5,
            poll_seconds=0,
            loader=loader,
            sleeper=lambda _seconds: None,
            progress=messages.append,
        )

        self.assertEqual(status.state, "SUCCESS")
        self.assertEqual(
            messages,
            [
                (
                    f"gh failed while waiting on {head[:12]}; retrying: "
                    "HTTP 401: Bad credentials (https://api.github.com/graphql)"
                ),
                f"CodeRabbit SUCCESS on {head[:12]}",
            ],
        )

    def test_persistent_gh_failure_times_out_with_the_error(self) -> None:
        def loader(_pr: str, _repo: str | None) -> dict[str, object]:
            raise MODULE.GhCommandError("HTTP 401: Bad credentials")

        with self.assertRaisesRegex(TimeoutError, "last state: gh error: HTTP 401: Bad credentials"):
            MODULE.wait_for_review(
                pr="123",
                expected_head="f" * 40,
                repo=None,
                timeout_seconds=0.05,
                poll_seconds=0.01,
                loader=loader,
                sleeper=MODULE.time.sleep,
            )

    def test_gh_payload_reports_a_failed_gh_call_as_retryable(self) -> None:
        def fake_run(command, check=False, capture_output=True, text=True, timeout=None):
            del check, capture_output, text, timeout
            return MODULE.subprocess.CompletedProcess(
                command, 1, stdout="", stderr="HTTP 401: Bad credentials (https://api.github.com/graphql)"
            )

        original_run = MODULE.subprocess.run
        MODULE.subprocess.run = fake_run
        try:
            with self.assertRaises(MODULE.GhCommandError):
                MODULE.gh_payload("1354", repo="acme/rose", timeout=5.0)
        finally:
            MODULE.subprocess.run = original_run

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

    def test_rate_limited_success_is_not_substantive(self) -> None:
        status = MODULE.normalize_status(
            {
                "__typename": "StatusContext",
                "context": "CodeRabbit",
                "state": "SUCCESS",
                "description": "Review rate limited",
            }
        )

        self.assertTrue(status.terminal)
        self.assertFalse(status.successful)
        self.assertEqual(status.state, "REVIEW_RATE_LIMITED")

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

    def test_gh_payload_enriches_skipped_description_from_rest(self) -> None:
        """GraphQL SUCCESS without description must not hide a REST skip."""
        head = "d" * 40

        def fake_run(command, check=False, capture_output=True, text=True, timeout=None):
            del check, capture_output, text, timeout
            if command[-1] == "headRefOid,statusCheckRollup":
                return MODULE.subprocess.CompletedProcess(
                    command,
                    0,
                    stdout=MODULE.json.dumps(
                        {
                            "headRefOid": head,
                            "statusCheckRollup": [
                                {
                                    "__typename": "StatusContext",
                                    "context": "CodeRabbit",
                                    "state": "SUCCESS",
                                }
                            ],
                        }
                    ),
                    stderr="",
                )
            raise AssertionError(command)

        original_run = MODULE.subprocess.run
        original_rollup = MODULE.gh_commit_status_rollup

        def fake_rollup(_head, repo=None, timeout=None):
            del repo, timeout
            self.assertEqual(_head, head)
            return [
                {
                    "__typename": "StatusContext",
                    "context": "CodeRabbit",
                    "state": "SUCCESS",
                    "description": "Review skipped: incremental reviews are disabled",
                }
            ]

        MODULE.subprocess.run = fake_run
        MODULE.gh_commit_status_rollup = fake_rollup
        try:
            payload = MODULE.gh_payload("1218", repo="acme/rose")
        finally:
            MODULE.subprocess.run = original_run
            MODULE.gh_commit_status_rollup = original_rollup

        entry = MODULE.coderabbit_entry(payload)
        status = MODULE.normalize_status(entry or {})
        self.assertEqual(
            entry and entry.get("description"),
            "Review skipped: incremental reviews are disabled",
        )
        self.assertEqual(status.state, "REVIEW_SKIPPED")
        self.assertFalse(status.successful)

    def test_manual_trigger_supersedes_an_earlier_incremental_skip(self) -> None:
        """PR 1348: the push auto-skipped at 23:52:19, the trigger came at 23:54:31."""
        head = "e" * 40
        stale_skip = {
            "__typename": "StatusContext",
            "context": "CodeRabbit",
            "state": "SUCCESS",
            "startedAt": "2026-10-01T23:52:19Z",
            "description": "Review skipped: incremental reviews are disabled",
        }
        payloads = iter(
            [
                {"headRefOid": head, "statusCheckRollup": [stale_skip]},
                {
                    "headRefOid": head,
                    "statusCheckRollup": [
                        {
                            "__typename": "StatusContext",
                            "context": "CodeRabbit",
                            "state": "PENDING",
                            "startedAt": "2026-10-02T00:01:02Z",
                        }
                    ],
                },
                {
                    "headRefOid": head,
                    "statusCheckRollup": [
                        {
                            "__typename": "StatusContext",
                            "context": "CodeRabbit",
                            "state": "SUCCESS",
                            "startedAt": "2026-10-02T00:09:40Z",
                            "description": "Review completed",
                        }
                    ],
                },
            ]
        )
        progress: list[str] = []
        status = MODULE.wait_for_review(
            pr="1348",
            expected_head=head,
            repo=None,
            timeout_seconds=1,
            poll_seconds=0,
            loader=lambda _pr, _repo: next(payloads),
            sleeper=lambda _seconds: None,
            progress=progress.append,
            triggered_at=MODULE.parse_github_time("2026-10-01T23:54:31Z"),
        )

        self.assertEqual(status.state, "SUCCESS")
        self.assertTrue(status.successful)
        self.assertEqual(
            progress[0], f"CodeRabbit AWAITING_TRIGGERED_REVIEW on {head[:12]}"
        )

    def test_stale_skip_never_satisfies_the_wait_after_a_trigger(self) -> None:
        head = "f" * 40
        payload = {
            "headRefOid": head,
            "statusCheckRollup": [
                {
                    "__typename": "StatusContext",
                    "context": "CodeRabbit",
                    "state": "SUCCESS",
                    "startedAt": "2026-10-01T23:52:19Z",
                    "description": "Review skipped: incremental reviews are disabled",
                }
            ],
        }
        with self.assertRaisesRegex(TimeoutError, "AWAITING_TRIGGERED_REVIEW"):
            MODULE.wait_for_review(
                pr="1348",
                expected_head=head,
                repo=None,
                timeout_seconds=0.05,
                poll_seconds=0,
                loader=lambda _pr, _repo: payload,
                sleeper=lambda _seconds: None,
                triggered_at=MODULE.parse_github_time("2026-10-01T23:54:31Z"),
            )

    def test_budget_exhausted_inside_gh_reports_the_review_timeout(self) -> None:
        head = "3" * 40
        calls: list[float | None] = []
        clock = [0.0]

        def fake_gh_payload(_pr, _repo=None, *, timeout=None):
            calls.append(timeout)
            if len(calls) == 1:
                return {
                    "headRefOid": head,
                    "statusCheckRollup": [
                        {
                            "__typename": "StatusContext",
                            "context": "CodeRabbit",
                            "state": "PENDING",
                        }
                    ],
                }
            clock[0] += float(timeout or 0) + 0.01
            raise MODULE.ReviewWaitError(f"gh timed out after {timeout}s: gh api ...")

        original = MODULE.gh_payload
        MODULE.gh_payload = fake_gh_payload
        try:
            with patch.object(MODULE.time, "monotonic", side_effect=lambda: clock[0]), self.assertRaisesRegex(
                TimeoutError, r"last state: PENDING\)$"
            ):
                MODULE.wait_for_review(
                    pr="1348",
                    expected_head=head,
                    repo=None,
                    timeout_seconds=0.05,
                    poll_seconds=0,
                    sleeper=lambda _seconds: None,
                )
        finally:
            MODULE.gh_payload = original
        self.assertEqual(len(calls), 2)

    def test_push_auto_skip_never_ends_a_commanded_wait(self) -> None:
        """PR 1415: command 02:27:32, the push's auto-skip 02:28:06, review 02:28:43."""
        head = "2" * 40
        triggered_at = MODULE.parse_github_time("2026-10-06T02:27:32Z")
        skip = "Review skipped: incremental reviews are disabled"

        def rollup(state: str, started: str | None, description: str) -> dict[str, object]:
            entry = {
                "__typename": "StatusContext",
                "context": "CodeRabbit",
                "state": state,
                "description": description,
            }
            if started is not None:
                entry["startedAt"] = started
            return {"headRefOid": head, "statusCheckRollup": [entry]}

        payloads = iter(
            [
                rollup("SUCCESS", "2026-10-06T02:28:06Z", skip),
                rollup("PENDING", "2026-10-06T02:28:43Z", "Review in progress"),
                rollup("SUCCESS", "2026-10-06T02:33:56Z", "Review completed"),
            ]
        )
        progress: list[str] = []
        status = MODULE.wait_for_review(
            pr="1415",
            expected_head=head,
            repo=None,
            timeout_seconds=1,
            poll_seconds=0,
            loader=lambda _pr, _repo: next(payloads),
            sleeper=lambda _seconds: None,
            progress=progress.append,
            triggered_at=triggered_at,
        )

        self.assertEqual(status.state, "SUCCESS")
        self.assertTrue(status.successful)
        self.assertEqual(progress[0], f"CodeRabbit AWAITING_TRIGGERED_REVIEW on {head[:12]}")

        # Posted after the command, before it, or undated: while it is all there
        # is, the wait runs to its own timeout, which routes to the fallback. A
        # commanded review has started as late as 391s after its command.
        for started in ("2026-10-06T02:28:06Z", "2026-10-06T02:27:00Z", None):
            with self.assertRaisesRegex(TimeoutError, "AWAITING_TRIGGERED_REVIEW"):
                MODULE.wait_for_review(
                    pr="1415",
                    expected_head=head,
                    repo=None,
                    timeout_seconds=0.05,
                    poll_seconds=0,
                    loader=lambda _pr, _repo, payload=rollup("SUCCESS", started, skip): payload,
                    sleeper=lambda _seconds: None,
                    triggered_at=triggered_at,
                )

    def test_skip_posted_after_the_trigger_is_terminal(self) -> None:
        head = "1" * 40
        status = MODULE.wait_for_review(
            pr="1348",
            expected_head=head,
            repo=None,
            timeout_seconds=1,
            poll_seconds=0,
            loader=lambda _pr, _repo: {
                "headRefOid": head,
                "statusCheckRollup": [
                    {
                        "__typename": "StatusContext",
                        "context": "CodeRabbit",
                        "state": "SUCCESS",
                        "startedAt": "2026-10-01T23:55:00Z",
                        "description": "Review skipped: no new changes",
                    }
                ],
            },
            sleeper=lambda _seconds: None,
            triggered_at=MODULE.parse_github_time("2026-10-01T23:54:31Z"),
        )

        self.assertEqual(status.state, "REVIEW_SKIPPED")
        self.assertFalse(status.successful)

    def test_completed_review_before_the_trigger_still_counts(self) -> None:
        head = "2" * 40
        status = MODULE.wait_for_review(
            pr="1348",
            expected_head=head,
            repo=None,
            timeout_seconds=1,
            poll_seconds=0,
            loader=lambda _pr, _repo: {
                "headRefOid": head,
                "statusCheckRollup": [
                    {
                        "__typename": "StatusContext",
                        "context": "CodeRabbit",
                        "state": "SUCCESS",
                        "startedAt": "2026-10-01T23:50:00Z",
                        "description": "Review completed",
                    }
                ],
            },
            sleeper=lambda _seconds: None,
            triggered_at=MODULE.parse_github_time("2026-10-01T23:54:31Z"),
        )

        self.assertEqual(status.state, "SUCCESS")
        self.assertTrue(status.successful)

    def test_latest_review_trigger_at_reads_every_page(self) -> None:
        calls: list[str] = []
        first_page = [
            {"body": "@coderabbitai review", "created_at": "2026-10-01T17:59:38Z"}
        ] + [
            {"body": "deploy notes", "created_at": "2026-10-01T18:00:00Z"}
            for _ in range(99)
        ]
        second_page = [
            {"body": "@coderabbitai full review", "created_at": "2026-10-01T18:47:25Z"},
            {"body": "please @coderabbitai review", "created_at": "2026-10-01T23:59:00Z"},
            {"body": "@coderabbitai resolve", "created_at": "2026-10-01T23:59:30Z"},
            {"body": "@CodeRabbitAI review\n", "created_at": "2026-10-01T23:54:31Z"},
        ]

        def fake_gh_json(command: list[str], timeout=None) -> object:
            del timeout
            endpoint = command[-1]
            calls.append(endpoint)
            if endpoint.endswith("&page=1"):
                return first_page
            if endpoint.endswith("&page=2"):
                return second_page
            raise AssertionError(command)

        original = MODULE._gh_json
        MODULE._gh_json = fake_gh_json
        try:
            triggered_at = MODULE.latest_review_trigger_at(
                "https://github.com/acme/rose/pull/1348", repo="acme/rose", timeout=5.0
            )
        finally:
            MODULE._gh_json = original

        self.assertEqual(triggered_at, MODULE.parse_github_time("2026-10-01T23:54:31Z"))
        self.assertEqual(
            calls,
            [
                "repos/acme/rose/issues/1348/comments?per_page=100&page=1",
                "repos/acme/rose/issues/1348/comments?per_page=100&page=2",
            ],
        )

    def test_commit_status_rollup_keeps_rest_created_at_as_started_at(self) -> None:
        def fake_gh_json(command: list[str], timeout=None) -> object:
            del command, timeout
            return {
                "statuses": [
                    {
                        "context": "CodeRabbit",
                        "state": "success",
                        "description": "Review skipped: incremental reviews are disabled",
                        "created_at": "2026-10-01T23:52:19Z",
                    }
                ]
            }

        original = MODULE._gh_json
        MODULE._gh_json = fake_gh_json
        try:
            rollup = MODULE.gh_commit_status_rollup("abc", repo="acme/rose")
        finally:
            MODULE._gh_json = original

        self.assertEqual(rollup[0]["startedAt"], "2026-10-01T23:52:19Z")

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
