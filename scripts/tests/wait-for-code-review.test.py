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


if __name__ == "__main__":
    unittest.main()
