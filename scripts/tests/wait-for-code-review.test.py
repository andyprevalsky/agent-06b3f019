#!/usr/bin/env python3
"""Regression tests for exact-HEAD CodeRabbit waiting."""

from __future__ import annotations

import importlib.util
import argparse
import json
import os
import tempfile
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
    def test_failed_wait_records_a_complete_review_window(self) -> None:
        # Match the CLI's script import path when calling main in-process.
        self.addCleanup(setattr, sys, "path", sys.path[:])
        sys.path.insert(0, str(ROOT / "scripts"))
        args = argparse.Namespace(pr="123", head="a" * 40, repo="acme/rose", timeout=600, poll=5,
                                  after_rate_limit=False, rate_limit_max_wait=0.0, receipt_dir=None)
        triggered = MODULE.parse_github_time("2026-10-01T23:54:31Z")
        for error, trigger, fails_during_trigger, reason in (
            (TimeoutError("review timed out"), triggered, False, "timeout"),
            (MODULE.ReviewWaitError("PR HEAD changed"), None, False, "error"),
            (MODULE.ReviewWaitError("trigger unavailable"), None, True, "error"),
        ):
            with self.subTest(error=str(error)), tempfile.TemporaryDirectory() as directory:
                ledger = Path(directory) / "events.jsonl"
                with patch.object(MODULE, "parse_args", return_value=args), \
                     patch.object(MODULE, "latest_review_trigger_at", return_value=trigger,
                                  side_effect=error if fails_during_trigger else None), \
                     patch.object(MODULE, "wait_for_review", side_effect=error), \
                     patch.dict(os.environ, {"FACTORY_EVENT_LOG": str(ledger)}):
                    code = MODULE.main()
                self.assertEqual(code, 2)
                self.assertTrue(ledger.exists(), "failed review wait lost both timing events")
                rows = [json.loads(line) for line in ledger.read_text().splitlines()]
                self.assertEqual([row["event"] for row in rows], ["review-request", "review-arrival"])
                self.assertEqual(rows[0]["detail"]["reason"], "manual-trigger" if trigger else "waiter-start")
                self.assertEqual(rows[1]["detail"]["reason"], reason)
                self.assertGreaterEqual(rows[1]["recorded_epoch"], rows[0]["recorded_epoch"])
                if trigger:
                    self.assertEqual(rows[0]["recorded_epoch"], trigger.timestamp())

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



class ReplyWrapperReviewTest(unittest.TestCase):
    """The waiter reads only the CodeRabbit check on the exact HEAD, never a review count.

    On PR 1656 (2026-10-31) CodeRabbit answered two ``[FIXED]`` thread replies
    with empty-body COMMENTED reviews of the new HEAD while its check was
    "Review rate limited"; a hand-rolled guard that counted reviews-by-HEAD
    treated them as a delivered review. Reviews are not an input here, so
    adding them to the payload must not end the wait; only the check does.
    """

    def test_reply_wrapper_reviews_never_end_the_wait(self) -> None:
        head = "da2dbd8b14e25c77dcd5d3b0df3fb42e27e7d9ea"
        wrappers = [
            {"id": 5722158877, "user": {"login": "coderabbitai[bot]"}, "state": "COMMENTED",
             "commit_id": head, "submitted_at": "2026-10-31T09:25:39Z", "body": ""},
            {"id": 5722158908, "user": {"login": "coderabbitai[bot]"}, "state": "COMMENTED",
             "commit_id": head, "submitted_at": "2026-10-31T09:25:40Z", "body": ""},
        ]
        pending = {"headRefOid": head, "reviews": wrappers, "statusCheckRollup": [
            {"__typename": "CheckRun", "name": "CodeRabbit", "status": "IN_PROGRESS",
             "conclusion": None, "startedAt": "2026-10-31T10:11:01Z"}]}
        finished = {"headRefOid": head, "reviews": wrappers, "statusCheckRollup": [
            {"__typename": "CheckRun", "name": "CodeRabbit", "status": "COMPLETED",
             "conclusion": "SUCCESS", "title": "Finished", "startedAt": "2026-10-31T10:11:01Z"}]}
        payloads = iter([pending, pending, pending, finished])
        polls: list[float] = []
        status = MODULE.wait_for_review(
            pr="1656", expected_head=head, repo=None, timeout_seconds=600, poll_seconds=5,
            loader=lambda _pr, _repo: next(payloads), sleeper=polls.append,
            triggered_at=MODULE.parse_github_time("2026-10-31T10:10:02Z"),
        )
        self.assertEqual(len(polls), 3, "wrapper reviews must not shortcut the check wait")
        self.assertEqual((status.state, status.successful), ("SUCCESS", True))
        self.assertIsNone(MODULE.coderabbit_entry({"statusCheckRollup": [], "reviews": wrappers}))

HEAD_C = "da2dbd8b14e25c77dcd5d3b0df3fb42e27e7d9ea"


class ConditionalPollTest(unittest.TestCase):
    """Each 5 s poll re-reads the REST commit status; an unchanged page must cost no REST quota.

    The fake reproduces gh 2.94's real ``gh api --include`` output, captured
    against a local server: status line and headers before the body, and a
    304 that exits 1 with ``gh: HTTP 304``.
    """

    OK = ("HTTP/2.0 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n"
          'Etag: W/"abc"\r\nX-Ratelimit-Remaining: 4999\r\n\r\n')
    NOT_MODIFIED = 'HTTP/2.0 304 Not Modified\r\nEtag: W/"abc"\r\n\r\n'

    def setUp(self) -> None:
        MODULE._CONDITIONAL_CACHE.clear()
        MODULE._RESOLVED_SLUG.clear()
        self.addCleanup(MODULE._CONDITIONAL_CACHE.clear)
        self.addCleanup(MODULE._RESOLVED_SLUG.clear)

    def test_repeated_status_polls_send_if_none_match_and_reuse_the_304(self) -> None:
        body = json.dumps({"statuses": [{"context": "CodeRabbit", "state": "pending",
                                         "description": "Review in progress",
                                         "created_at": "2026-10-31T10:11:01Z"}]})
        sent: list[list[str]] = []

        def fake_run(command, check=False, capture_output=True, text=True, timeout=None):
            del check, capture_output, text, timeout
            sent.append(list(command))
            if command[:3] == ["gh", "repo", "view"]:
                return MODULE.subprocess.CompletedProcess(command, 0, stdout='{"nameWithOwner":"acme/rose"}',
                                                          stderr="")
            if any(part.startswith("If-None-Match:") for part in command):
                return MODULE.subprocess.CompletedProcess(command, 1, stdout=self.NOT_MODIFIED,
                                                          stderr="gh: HTTP 304\n")
            return MODULE.subprocess.CompletedProcess(command, 0, stdout=self.OK + body, stderr="")

        with patch.object(MODULE.subprocess, "run", side_effect=fake_run):
            first = MODULE.gh_commit_status_rollup(HEAD_C, None, timeout=5.0)
            second = MODULE.gh_commit_status_rollup(HEAD_C, None, timeout=5.0)
        self.assertEqual(first, second)
        self.assertEqual(second[0]["description"], "Review in progress")
        status_calls = [command for command in sent if command[:2] == ["gh", "api"]]
        self.assertEqual(len(status_calls), 2)
        self.assertNotIn("-H", status_calls[0])
        self.assertIn("--include", status_calls[0])
        self.assertEqual(status_calls[1][-3:-1], ["-H", 'If-None-Match: W/"abc"'])
        self.assertEqual(status_calls[1][-1], status_calls[0][-1])
        self.assertEqual(sum(command[:3] == ["gh", "repo", "view"] for command in sent), 1,
                         "the repository slug is resolved once, not on every poll")

    def test_a_real_gh_failure_is_still_retryable_not_a_cache_hit(self) -> None:
        def fake_run(command, check=False, capture_output=True, text=True, timeout=None):
            del check, capture_output, text, timeout
            return MODULE.subprocess.CompletedProcess(
                command, 1, stdout="HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\n\r\n{}",
                stderr="gh: API rate limit exceeded (HTTP 403)\n")

        with patch.object(MODULE.subprocess, "run", side_effect=fake_run):
            with self.assertRaisesRegex(MODULE.GhCommandError, "rate limit exceeded"):
                MODULE.gh_commit_status_rollup(HEAD_C, "acme/rose", timeout=5.0)


# PR 1656 (2026-10-31): CodeRabbit's overview comment as it read at 09:55:12Z,
# naming the reviewed range ending at HEAD_C (deploy-review-cycle CAP_COMMENT).
HEAD_A = "33d8cfbfed95812de3534a74bee0a0caa36f10fe"
BOT = {"login": "coderabbitai[bot]"}
CAP_COMMENT = {"id": 6541489860, "user": BOT, "created_at": "2026-10-31T09:06:05Z",
               "updated_at": "2026-10-31T09:55:12Z", "body": (
                   "<!-- coderabbit-ai-generated:v1 -->\n\n## Review limit reached\n\n"
                   "Your organization has reached its usage spending cap. "
                   "**Next included review available in 9 minutes.**\n\n"
                   "<details><summary>Commits</summary>\n\nReviewing files that changed from the base of "
                   f"the PR and between {HEAD_A} and {HEAD_C}.\n\n</details>")}
# "Action not completed — Review rate limited." names no window and no HEAD.
RATE_LIMIT_TIP = {"id": 6541932795, "user": BOT, "created_at": "2026-10-31T09:55:15Z",
                  "updated_at": "2026-10-31T09:55:15Z", "body": (
                      "<!-- coderabbit-ai-generated:v1 -->\n\n> [!TIP]\n> Action not completed\n"
                      "> Review rate limited.\n")}


class RateLimitRerequestTest(unittest.TestCase):
    """CodeRabbit's quota is per account, so concurrent deploys rate-limit each other.

    The waiter reads the window from the exact-HEAD rate-limit comment, sleeps
    until it reopens, and spends exactly one ``@coderabbitai review`` on that
    HEAD; anything it cannot prove leaves today's exit-3 path untouched.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.receipts = Path(self.tmp.name) / "context"
        self.now = MODULE.parse_github_time("2026-10-31T09:56:00Z")
        self.sleeps: list[float] = []
        self.posts: list[str] = []
        self.messages: list[str] = []

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now = self.now + MODULE.timedelta(seconds=seconds)

    def rerequest(self, comments: list[dict], *, head: str = HEAD_C, max_wait: float = 3600,
                  actual_head: str = HEAD_C, poster=None):
        return MODULE.rerequest_after_rate_limit(
            pr="1656", head=head, max_wait_seconds=max_wait, receipt_dir=self.receipts,
            comments_loader=lambda: comments, head_loader=lambda: actual_head,
            poster=poster or (lambda: self.posts.append(head)), clock=lambda: self.now,
            sleeper=self.sleep, progress=self.messages.append)

    def test_window_wordings_parse(self) -> None:
        parse = MODULE.parse_window_seconds
        self.assertEqual(parse("**Next included review available in 29 minutes.**"), 29 * 60)
        self.assertEqual(parse("Next included review available in 9 minutes."), 9 * 60)
        self.assertEqual(parse("Please wait **29 minutes and 46 seconds** before requesting another review."),
                         29 * 60 + 46)
        self.assertEqual(parse("available in 1 hour and 5 minutes"), 3900)
        self.assertEqual(parse("Next included review available in 45 seconds."), 45)
        self.assertIsNone(parse("Review rate limited."))
        self.assertIsNone(parse("Next included review available in 3 fortnights."))

    def test_waits_out_the_window_then_posts_exactly_one_rerequest(self) -> None:
        triggered = self.rerequest([CAP_COMMENT, RATE_LIMIT_TIP])
        # 09:55:12 + 9 min + 60 s grace = 10:05:12; waited from 09:56:00.
        self.assertEqual(self.sleeps, [552.0])
        self.assertEqual(self.posts, [HEAD_C])
        self.assertEqual(triggered, MODULE.parse_github_time("2026-10-31T10:05:12Z"))
        self.assertTrue(any("waiting until 2026-10-31T10:05:12Z" in line for line in self.messages), self.messages)
        receipt = json.loads(MODULE.rerequest_receipt_path(self.receipts, "1656", HEAD_C).read_text())
        self.assertEqual((receipt["status"], receipt["head"], receipt["comment_id"]),
                         ("posted", HEAD_C, 6541489860))

    def test_a_restart_never_posts_twice(self) -> None:
        first = self.rerequest([CAP_COMMENT])
        again = self.rerequest([CAP_COMMENT])
        self.assertEqual(self.posts, [HEAD_C], "a restarted waiter spent a second review")
        self.assertEqual(again, first)
        # CodeRabbit rate-limiting the one re-request again ends with exit 3, never a second post.
        relimited = {**CAP_COMMENT, "updated_at": "2026-10-31T10:05:40Z"}
        with self.assertRaisesRegex(MODULE.WindowUnavailable, "rate-limited again"):
            self.rerequest([relimited])
        self.assertEqual(self.posts, [HEAD_C])

    def test_a_failed_post_is_not_retried(self) -> None:
        def refuse() -> None:
            raise MODULE.GhCommandError("HTTP 502")

        with self.assertRaisesRegex(MODULE.WindowUnavailable, "failed"):
            self.rerequest([CAP_COMMENT], poster=refuse)
        with self.assertRaisesRegex(MODULE.WindowUnavailable, "failed to post"):
            self.rerequest([CAP_COMMENT])
        self.assertEqual(self.posts, [])

    def test_no_rerequest_without_a_window_naming_this_head(self) -> None:
        other_head = "f602c1814b6f5fddbbdd71a3f22f6862807ea06c"
        human = {**CAP_COMMENT, "user": {"login": "andyprevalsky"}}
        no_window = {**CAP_COMMENT, "body": CAP_COMMENT["body"].replace(
            "**Next included review available in 9 minutes.**", "")}
        for name, comments, head in (
            ("tip names neither HEAD nor window", [RATE_LIMIT_TIP], HEAD_C),
            ("cap comment names another HEAD", [CAP_COMMENT], other_head),
            ("a human quoting the cap", [human], HEAD_C),
            ("no parseable window", [no_window], HEAD_C),
        ):
            with self.subTest(name):
                with self.assertRaisesRegex(MODULE.WindowUnavailable, "parseable review window"):
                    self.rerequest(comments, head=head)
        self.assertEqual((self.posts, self.sleeps), ([], []))

    def test_a_window_beyond_the_max_is_not_waited_for(self) -> None:
        with self.assertRaisesRegex(MODULE.WindowUnavailable,
                                    r"opens at 2026-10-31T10:05:12Z .*beyond --rate-limit-max-wait 300s"):
            self.rerequest([CAP_COMMENT], max_wait=300)
        self.assertEqual((self.posts, self.sleeps), ([], []))
        self.assertFalse(MODULE.rerequest_receipt_path(self.receipts, "1656", HEAD_C).exists())

    def test_an_existing_trigger_after_the_limit_is_waited_for_not_duplicated(self) -> None:
        manual = {"id": 1, "user": {"login": "andyprevalsky"}, "body": "@coderabbitai review",
                  "created_at": "2026-10-31T10:06:00Z"}
        triggered = self.rerequest([CAP_COMMENT, manual])
        self.assertEqual(triggered, MODULE.parse_github_time("2026-10-31T10:06:00Z"))
        self.assertEqual((self.posts, self.sleeps), ([], []))

    def test_a_moved_head_is_never_rerequested(self) -> None:
        with self.assertRaisesRegex(MODULE.ReviewWaitError, "PR HEAD changed"):
            self.rerequest([CAP_COMMENT], actual_head="f" * 40)
        self.assertEqual(self.posts, [])

    def test_main_exits_3_without_a_window_and_waits_on_the_rerequest(self) -> None:
        self.addCleanup(setattr, sys, "path", sys.path[:])
        sys.path.insert(0, str(ROOT / "scripts"))
        args = argparse.Namespace(pr="1656", head=HEAD_C, repo="acme/rose", timeout=600, poll=5,
                                  after_rate_limit=True, rate_limit_max_wait=3600.0, receipt_dir=self.receipts)
        triggered = MODULE.parse_github_time("2026-10-31T10:05:12Z")
        delivered = MODULE.ReviewStatus("SUCCESS", True, True, "CheckRun", {})
        with patch.dict(os.environ, {"FACTORY_EVENT_LOG": str(Path(self.tmp.name) / "events.jsonl")}), \
             patch.object(MODULE, "parse_args", return_value=args), \
             patch.object(MODULE, "latest_review_trigger_at") as plain:
            with patch.object(MODULE, "rerequest_after_rate_limit",
                              side_effect=MODULE.WindowUnavailable("no window")), \
                 patch.object(MODULE, "wait_for_review") as waiter:
                self.assertEqual(MODULE.main(), 3)
            waiter.assert_not_called()
            with patch.object(MODULE, "rerequest_after_rate_limit", return_value=triggered), \
                 patch.object(MODULE, "wait_for_review", return_value=delivered) as waiter:
                self.assertEqual(MODULE.main(), 0)
            self.assertEqual(waiter.call_args.kwargs["triggered_at"], triggered)
            self.assertEqual(waiter.call_args.kwargs["expected_head"], HEAD_C)
            plain.assert_not_called()


if __name__ == "__main__":
    unittest.main()
