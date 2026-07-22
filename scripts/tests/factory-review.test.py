#!/usr/bin/env python3
"""Blackbox regression tests for factory-review history correlation."""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "factory_review", ROOT / "scripts/factory_review.py"
)
assert SPEC and SPEC.loader
FACTORY_REVIEW = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = FACTORY_REVIEW
SPEC.loader.exec_module(FACTORY_REVIEW)


def assistant_text(text: str) -> str:
    return json.dumps(
        {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": text}]},
        }
    )


def tool_message(block: dict[str, object], payload_type: str = "assistant") -> str:
    return json.dumps({"type": payload_type, "message": {"content": [block]}})


def factory_event_output(workflow: str, event: str, value: str) -> str:
    return "FACTORY_EVENT " + json.dumps(
        {"workflow": workflow, "event": event, "value": value},
        separators=(",", ":"),
    )


class ApprovalLifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "conductor.db"
        conn = sqlite3.connect(self.db_path)
        conn.executescript(
            """
            CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE workspaces (
                id TEXT PRIMARY KEY,
                repository_id TEXT NOT NULL,
                directory_name TEXT NOT NULL
            );
            CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
            CREATE TABLE session_messages (
                session_id TEXT NOT NULL,
                turn_id TEXT,
                created_at TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL
            );
            INSERT INTO repos VALUES ('repo', 'fixture-repo');
            INSERT INTO workspaces VALUES ('workspace', 'repo', 'fixture-workspace');
            INSERT INTO sessions VALUES ('session', 'workspace');
            """
        )
        rows = [
            ("blocked", "2026-07-12T00:00:00Z", "user", "/deploy"),
            (
                "blocked",
                "2026-07-12T00:01:00Z",
                "assistant",
                assistant_text(
                    "Deployment is paused at the mandatory prompt guard. "
                    "Please explicitly approve these prompt changes or reject them."
                ),
            ),
            (
                "question",
                "2026-07-12T00:10:00Z",
                "user",
                "what exactly changed?",
            ),
            (
                "decision",
                "2026-07-12T00:34:00Z",
                "user",
                "ok now retest and show cache hit increase",
            ),
            (
                "decision",
                "2026-07-12T00:34:05Z",
                "assistant",
                assistant_text(
                    "I'm treating your 'ok' as approval of the snapshot above."
                ),
            ),
            ("completed", "2026-07-12T01:00:00Z", "user", "/deploy"),
            (
                "completed",
                "2026-07-12T01:00:01Z",
                "assistant",
                tool_message(
                    {
                        "type": "tool_use",
                        "id": "guard",
                        "name": "Bash",
                        "input": {
                            "command": "bash scripts/check-prompt-human-approval.sh mandatory-human-approval-retrieved=true"
                        },
                    }
                ),
            ),
            (
                "completed",
                "2026-07-12T01:00:01.100000Z",
                "assistant",
                tool_message(
                    {
                        "type": "tool_result",
                        "tool_use_id": "guard",
                        "content": "approved",
                    },
                    "user",
                ),
            ),
            (
                "completed",
                "2026-07-12T01:00:10Z",
                "assistant",
                tool_message(
                    {
                        "type": "tool_use",
                        "id": "merge",
                        "name": "Bash",
                        "input": {"command": "gh pr merge 123 --squash"},
                    }
                ),
            ),
            (
                "completed",
                "2026-07-12T01:00:20Z",
                "assistant",
                tool_message(
                    {
                        "type": "tool_result",
                        "tool_use_id": "merge",
                        "content": "merged pull request",
                    },
                    "user",
                ),
            ),
            (
                "completed",
                "2026-07-12T01:20:00Z",
                "assistant",
                assistant_text(
                    "Deployment complete; the PR has been merged and is live."
                ),
            ),
            ("blocked-two", "2026-07-12T02:00:00Z", "user", "/deploy"),
            (
                "blocked-two",
                "2026-07-12T02:01:00Z",
                "assistant",
                assistant_text(
                    "Deployment is paused at the mandatory prompt guard. "
                    "Please explicitly approve the new prompt snapshot or reject it."
                ),
            ),
            (
                "decision-two",
                "2026-07-12T02:05:00Z",
                "user",
                "I approve the new prompt snapshot",
            ),
        ]
        conn.executemany(
            "INSERT INTO session_messages VALUES ('session', ?, ?, ?, ?)", rows
        )
        conn.commit()
        conn.close()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_human_approval_wait_crosses_turns(self) -> None:
        turns = FACTORY_REVIEW.load_turns(self.db_path, "fixture-repo")
        completed = next(turn for turn in turns if turn.status == "completed")
        values = FACTORY_REVIEW.deploy_turn_values(completed)

        self.assertEqual(values["Approval guards"].runs, 1)
        self.assertEqual(values["Approval guards"].durations, (1980.0,))
        self.assertEqual(values["Approval guards"].wall_seconds, 1980.0)
        self.assertEqual(values["Total"].wall_seconds, 4800.0)

    def test_report_uses_resolved_approvals_from_incomplete_attempts(self) -> None:
        turns = FACTORY_REVIEW.load_turns(self.db_path, "fixture-repo")
        payload = FACTORY_REVIEW.analyze(turns, "2026-07-11", 20)
        approval = next(
            row
            for row in payload["deploy"]["steps"]
            if row["step"] == "Approval guards"
        )

        self.assertEqual(approval["samples"], 2)
        self.assertEqual(approval["commands"], 3)
        self.assertAlmostEqual(approval["runs"], 2 / 3)
        self.assertEqual(approval["avg_minutes"], 18.5)
        self.assertAlmostEqual(approval["total_minutes"], 2220 / 3 / 60)
        self.assertEqual(
            approval["description"],
            "Request → decision · 2 observed across 3 deploy attempts.",
        )
        weekly = payload["deploy"]["trends"]["Approval guards"]["weekly"][-1]
        self.assertEqual(weekly["commands"], 3)
        self.assertEqual(weekly["command_kind"], "attempt")
        self.assertEqual(weekly["duration_samples"], 2)

    def test_approval_report_survives_when_no_deploy_completed(self) -> None:
        attempt = FACTORY_REVIEW.Turn(
            "deploy",
            "fixture-workspace",
            "session",
            "blocked-only",
            "2026-07-12T00:00:00Z",
            60.0,
            "blocked",
            "awaiting approval",
            (),
            approval_durations=(300.0,),
        )

        payload = FACTORY_REVIEW.analyze([attempt], "2026-07-11", 20)
        approval = next(
            row
            for row in payload["deploy"]["steps"]
            if row["step"] == "Approval guards"
        )

        self.assertEqual(payload["deploy"]["completed"], 0)
        self.assertEqual(approval["samples"], 1)
        self.assertEqual(approval["avg_minutes"], 5.0)

    def test_requested_parallel_groups_and_runtime_blackbox_family(self) -> None:
        self.assertNotIn("Mac app blackbox", FACTORY_REVIEW.DEPLOY_REPORT_LABELS)
        self.assertEqual(
            FACTORY_REVIEW.STAGE_BADGES["deploy"]["Runtime blackbox"][0], "3"
        )
        for step in (
            "Code review",
            "Smoke benchmarks",
            "AgentCard lifecycle",
            "Semantic tests",
        ):
            self.assertEqual(FACTORY_REVIEW.STAGE_BADGES["deploy"][step][0], "4", step)
        self.assertEqual(
            FACTORY_REVIEW.STAGE_BADGES["deploy"]["Production verify"][0], "5"
        )
        mac = FACTORY_REVIEW.Invocation(
            "mac",
            "Bash",
            "bash scripts/run-deploy-stage mac-blackbox -- "
            "bash scripts/run-blackbox-tests.sh",
            "",
            0.0,
            10.0,
            False,
        )
        self.assertEqual(
            FACTORY_REVIEW.deploy_invocation_label(mac), "Runtime blackbox"
        )
        amplitude = FACTORY_REVIEW.Invocation(
            "amplitude",
            "Bash",
            "bash scripts/run-deploy-stage amplitude-live -- "
            "env ADMIN_HEALTH_LIVE_ONLY=1 bash scripts/run-blackbox-tests.sh admin-health",
            "",
            0.0,
            6.0,
            False,
        )
        self.assertEqual(
            set(FACTORY_REVIEW.deploy_invocation_labels(amplitude)),
            {"Static verify", "Runtime blackbox"},
        )

    def test_combined_coverage_blackbox_gates_are_attributed_to_both_rows(self) -> None:
        for repository in ("backend", "frontend", "agents", "mac"):
            invocation = FACTORY_REVIEW.Invocation(
                repository,
                "Bash",
                f"bash scripts/run-deploy-stage {repository}-coverage-blackbox -- test",
                "",
                0.0,
                10.0,
                False,
            )
            self.assertEqual(
                set(FACTORY_REVIEW.deploy_invocation_labels(invocation)),
                {"Coverage", "Runtime blackbox"},
                repository,
            )

        combined = FACTORY_REVIEW.Invocation(
            "combined",
            "Bash",
            "bash scripts/run-deploy-stage backend-coverage-blackbox -- test",
            "",
            0.0,
            10.0,
            False,
        )
        turn = FACTORY_REVIEW.Turn(
            "deploy",
            "fixture-workspace",
            "session",
            "combined-turn",
            "2026-07-12T00:00:00Z",
            10.0,
            "completed",
            "completed",
            (combined,),
        )
        values = FACTORY_REVIEW.deploy_turn_values(turn)
        self.assertEqual(values["Coverage"].runs, 1)
        self.assertEqual(values["Runtime blackbox"].runs, 1)
        self.assertEqual(values["Total"].runs, 1)

        mixed_review = FACTORY_REVIEW.Invocation(
            "mixed-review",
            "Bash",
            "git push; bash scripts/run-deploy-stage backend-coverage-blackbox -- test",
            "",
            0.0,
            10.0,
            False,
        )
        mixed_values = FACTORY_REVIEW.deploy_cycle_timings((mixed_review,))
        self.assertEqual(mixed_values["Code review"].runs, 0)
        self.assertEqual(
            mixed_values[FACTORY_REVIEW.HISTORICAL_UNSPLIT_LABEL].runs, 1
        )

    def test_parallel_group_wall_clock_unions_member_envelopes(self) -> None:
        aligned = {
            "Static verify": FACTORY_REVIEW.StepTiming(
                1, (10.0,), 10.0, intervals=((0.0, 10.0),)
            ),
            "Coverage": FACTORY_REVIEW.StepTiming(
                1, (20.0,), 20.0, intervals=((0.0, 20.0),)
            ),
            "Runtime blackbox": FACTORY_REVIEW.StepTiming(
                1, (10.0,), 10.0, intervals=((5.0, 15.0),)
            ),
        }
        aligned_group = FACTORY_REVIEW.deploy_group_wall_clock(
            aligned, FACTORY_REVIEW.DEPLOY_GROUP_SUMMARIES["Group 3 wall clock"]
        )

        self.assertEqual(aligned_group.wall_seconds, 20.0)
        self.assertEqual(aligned_group.runs, 0)
        self.assertEqual(aligned_group.durations, ())

        staggered = {
            **aligned,
            "Coverage": FACTORY_REVIEW.StepTiming(
                1, (20.0,), 20.0, intervals=((5.0, 25.0),)
            ),
        }
        staggered_group = FACTORY_REVIEW.deploy_group_wall_clock(
            staggered, FACTORY_REVIEW.DEPLOY_GROUP_SUMMARIES["Group 3 wall clock"]
        )

        self.assertEqual(staggered_group.wall_seconds, 25.0)
        self.assertGreater(
            staggered_group.wall_seconds,
            max(timing.wall_seconds for timing in staggered.values()),
        )

    def test_report_keeps_group_subtotals_compact_and_shows_real_deltas(self) -> None:
        first = FACTORY_REVIEW.Turn(
            "deploy",
            "fixture-workspace",
            "session",
            "first",
            "2026-07-06T00:00:00Z",
            60.0,
            "completed",
            "completed",
            (),
            consumed_approval_durations=(60.0,),
        )
        second = FACTORY_REVIEW.Turn(
            "deploy",
            "fixture-workspace",
            "session",
            "second",
            "2026-07-13T00:00:00Z",
            120.0,
            "completed",
            "completed",
            (),
            consumed_approval_durations=(120.0,),
        )
        payload = FACTORY_REVIEW.analyze([first, second], "2026-07-01", 20)
        page = FACTORY_REVIEW.render_html(payload)

        self.assertIn('<span class="sr-only">Group 3 wall clock</span>', page)
        self.assertNotIn('<span class="step-title">Group 3 wall clock</span>', page)
        self.assertNotIn("n<2", page)

    def test_decision_after_completed_deploy_is_not_backfilled(self) -> None:
        approval_guard = FACTORY_REVIEW.Invocation(
            "guard",
            "Bash",
            "bash scripts/check-prompt-human-approval.sh "
            "mandatory-human-approval-retrieved=true",
            "approved",
            1.0,
            2.0,
            False,
        )
        completed = FACTORY_REVIEW.Turn(
            "deploy",
            "fixture-workspace",
            "session",
            "already-done",
            "2026-07-12T00:00:00Z",
            600.0,
            "completed",
            "Deployment complete",
            (approval_guard,),
        )
        much_later = FACTORY_REVIEW.Turn(
            "deploy",
            "fixture-workspace",
            "session",
            "unrelated-later-deploy",
            "2026-07-31T00:00:00Z",
            600.0,
            "completed",
            "Deployment complete",
            (approval_guard,),
        )
        later_decision = FACTORY_REVIEW.ApprovalLifecycle(
            workspace="fixture-workspace",
            session_id="session",
            request_turn_id="already-done",
            deploy_started_at="2026-07-12T00:00:00Z",
            requested_at="2026-07-12T00:05:00Z",
            decided_at="2026-07-12T01:00:00Z",
            decision="approved",
        )

        attached = FACTORY_REVIEW.attach_approval_lifecycles(
            [completed, much_later], [later_decision]
        )

        self.assertTrue(
            all(turn.consumed_approval_durations == () for turn in attached)
        )
        self.assertTrue(all(turn.lifecycle_duration is None for turn in attached))

    def test_resume_requires_approval_consumption_evidence(self) -> None:
        resumed_without_guard = FACTORY_REVIEW.Turn(
            "deploy",
            "fixture-workspace",
            "session",
            "unrelated",
            "2026-07-12T02:00:00Z",
            600.0,
            "completed",
            "Deployment complete",
            (),
        )
        decision = FACTORY_REVIEW.ApprovalLifecycle(
            workspace="fixture-workspace",
            session_id="session",
            request_turn_id="blocked",
            deploy_started_at="2026-07-12T00:00:00Z",
            requested_at="2026-07-12T00:05:00Z",
            decided_at="2026-07-12T01:00:00Z",
            decision="approved",
        )

        attached = FACTORY_REVIEW.attach_approval_lifecycles(
            [resumed_without_guard], [decision]
        )[0]

        self.assertEqual(attached.approval_durations, ())
        self.assertIsNone(attached.lifecycle_duration)

    def test_explicit_rejection_is_a_decision(self) -> None:
        self.assertEqual(
            FACTORY_REVIEW.user_approval_decision("I do not approve this change"),
            "rejected",
        )

    def test_conditionals_and_negations_are_not_decisions(self) -> None:
        for text in (
            "If I approve, what happens?",
            "I haven't approved this",
            "I have not approved this",
            "Do you need me to approve?",
        ):
            with self.subTest(text=text):
                self.assertIsNone(FACTORY_REVIEW.user_approval_decision(text))
        for text in (
            "Approval has not been received yet.",
            "No approval has been received.",
            "Approval hasn't been received.",
            "Approval is still outstanding; nothing has been received.",
        ):
            with self.subTest(text=text):
                self.assertIsNone(FACTORY_REVIEW.assistant_approval_decision(text))

    def test_explicit_approval_variants_are_decisions(self) -> None:
        for text in (
            "approved",
            "I approve the prompt changes",
            "ok actually approved fine",
        ):
            with self.subTest(text=text):
                self.assertEqual(
                    FACTORY_REVIEW.user_approval_decision(text), "approved"
                )

    def test_new_snapshot_request_resets_the_wait_start(self) -> None:
        rows = [
            {
                "session_id": "session",
                "turn_id": "deploy",
                "created_at": "2026-07-12T00:00:00Z",
                "role": "user",
                "content": "/deploy",
                "directory_name": "fixture-workspace",
            },
            {
                "session_id": "session",
                "turn_id": "deploy",
                "created_at": "2026-07-12T00:01:00Z",
                "role": "assistant",
                "content": assistant_text(
                    "Deployment is paused at the mandatory prompt guard. "
                    "Please explicitly approve this prompt snapshot."
                ),
                "directory_name": "fixture-workspace",
            },
            {
                "session_id": "session",
                "turn_id": "follow-up",
                "created_at": "2026-07-12T00:10:00Z",
                "role": "assistant",
                "content": assistant_text(
                    "The prompt snapshot changed. Please explicitly approve the "
                    "new prompt diff before /deploy continues."
                ),
                "directory_name": "fixture-workspace",
            },
            {
                "session_id": "session",
                "turn_id": "decision",
                "created_at": "2026-07-12T00:12:00Z",
                "role": "user",
                "content": "approved",
                "directory_name": "fixture-workspace",
            },
        ]
        lifecycles = FACTORY_REVIEW.find_approval_lifecycles(
            rows,
            {("session", "deploy"): ("deploy", "2026-07-12T00:00:00Z")},
        )

        self.assertEqual(len(lifecycles), 1)
        self.assertEqual(lifecycles[0].duration, 120.0)
        self.assertEqual(lifecycles[0].request_turn_id, "deploy")

    def test_optional_approval_that_does_not_block_deploy_is_excluded(self) -> None:
        rows = [
            {
                "session_id": "session",
                "turn_id": "deploy",
                "created_at": "2026-07-12T00:00:00Z",
                "role": "user",
                "content": "/deploy",
                "directory_name": "fixture-workspace",
            },
            {
                "session_id": "session",
                "turn_id": "deploy",
                "created_at": "2026-07-12T00:01:00Z",
                "role": "assistant",
                "content": assistant_text(
                    "The prompt guard requires explicit human approval. Please "
                    "approve that optional patch if you want it included; I'll "
                    "continue this deploy using the existing path meanwhile."
                ),
                "directory_name": "fixture-workspace",
            },
            {
                "session_id": "session",
                "turn_id": "decision",
                "created_at": "2026-07-12T05:01:00Z",
                "role": "user",
                "content": "approved",
                "directory_name": "fixture-workspace",
            },
        ]

        lifecycles = FACTORY_REVIEW.find_approval_lifecycles(
            rows,
            {("session", "deploy"): ("deploy", "2026-07-12T00:00:00Z")},
        )

        self.assertEqual(lifecycles, [])

    def test_separately_optional_approval_is_not_a_deploy_wait(self) -> None:
        rows = [
            {
                "session_id": "session",
                "turn_id": "deploy",
                "created_at": "2026-07-12T00:00:00Z",
                "role": "user",
                "content": "/deploy",
                "directory_name": "fixture-workspace",
            },
            {
                "session_id": "session",
                "turn_id": "deploy",
                "created_at": "2026-07-12T00:01:00Z",
                "role": "assistant",
                "content": assistant_text(
                    "Please approve this optional follow-up separately. "
                    "This /deploy is not blocked and will continue now."
                ),
                "directory_name": "fixture-workspace",
            },
            {
                "session_id": "session",
                "turn_id": "decision",
                "created_at": "2026-07-12T05:01:00Z",
                "role": "user",
                "content": "approved",
                "directory_name": "fixture-workspace",
            },
        ]

        lifecycles = FACTORY_REVIEW.find_approval_lifecycles(
            rows,
            {("session", "deploy"): ("deploy", "2026-07-12T00:00:00Z")},
        )

        self.assertEqual(lifecycles, [])

    def test_structured_approval_event_is_primary_collection_hook(self) -> None:
        rows = [
            {
                "session_id": "session",
                "turn_id": "deploy",
                "created_at": "2026-07-12T00:00:00Z",
                "role": "user",
                "content": "/deploy",
                "directory_name": "fixture-workspace",
            },
            {
                "session_id": "session",
                "turn_id": "deploy",
                "created_at": "2026-07-12T00:01:00Z",
                "role": "assistant",
                "content": tool_message(
                    {
                        "type": "tool_use",
                        "id": "approval-request",
                        "name": "Bash",
                        "input": {
                            "command": "python3 scripts/record_factory_event.py "
                            "deploy approval-request prompt-approval"
                        },
                    }
                ),
                "directory_name": "fixture-workspace",
            },
            {
                "session_id": "session",
                "turn_id": "deploy",
                "created_at": "2026-07-12T00:01:01Z",
                "role": "assistant",
                "content": tool_message(
                    {
                        "type": "tool_result",
                        "tool_use_id": "approval-request",
                        "content": factory_event_output(
                            "deploy", "approval-request", "prompt-approval"
                        ),
                    },
                    "user",
                ),
                "directory_name": "fixture-workspace",
            },
            {
                "session_id": "session",
                "turn_id": "decision",
                "created_at": "2026-07-12T00:11:00Z",
                "role": "user",
                "content": "sg",
                "directory_name": "fixture-workspace",
            },
            {
                "session_id": "session",
                "turn_id": "decision",
                "created_at": "2026-07-12T00:11:01Z",
                "role": "assistant",
                "content": tool_message(
                    {
                        "type": "tool_use",
                        "id": "approval-decision",
                        "name": "Bash",
                        "input": {
                            "command": "python3 scripts/record_factory_event.py "
                            "deploy approval-decision approved"
                        },
                    }
                ),
                "directory_name": "fixture-workspace",
            },
            {
                "session_id": "session",
                "turn_id": "decision",
                "created_at": "2026-07-12T00:11:02Z",
                "role": "assistant",
                "content": tool_message(
                    {
                        "type": "tool_result",
                        "tool_use_id": "approval-decision",
                        "content": factory_event_output(
                            "deploy", "approval-decision", "approved"
                        ),
                    },
                    "user",
                ),
                "directory_name": "fixture-workspace",
            },
        ]
        lifecycles = FACTORY_REVIEW.find_approval_lifecycles(
            rows,
            {("session", "deploy"): ("deploy", "2026-07-12T00:00:00Z")},
        )

        self.assertEqual(len(lifecycles), 1)
        self.assertEqual(lifecycles[0].duration, 600.0)
        self.assertEqual(lifecycles[0].request_source, "event")
        self.assertEqual(lifecycles[0].decision_source, "event")

    def test_failed_structured_approval_request_does_not_create_wait(self) -> None:
        rows = [
            {
                "session_id": "session",
                "turn_id": "deploy",
                "created_at": "2026-07-12T00:00:00Z",
                "role": "user",
                "content": "/deploy",
                "directory_name": "fixture-workspace",
            },
            {
                "session_id": "session",
                "turn_id": "deploy",
                "created_at": "2026-07-12T00:01:00Z",
                "role": "assistant",
                "content": tool_message(
                    {
                        "type": "tool_use",
                        "id": "failed-request",
                        "name": "Bash",
                        "input": {
                            "command": "python3 scripts/record_factory_event.py "
                            "deploy approval-request prompt-approval"
                        },
                    }
                ),
                "directory_name": "fixture-workspace",
            },
            {
                "session_id": "session",
                "turn_id": "deploy",
                "created_at": "2026-07-12T00:01:01Z",
                "role": "user",
                "content": tool_message(
                    {
                        "type": "tool_result",
                        "tool_use_id": "failed-request",
                        "is_error": True,
                        "content": "writer failed",
                    },
                    "user",
                ),
                "directory_name": "fixture-workspace",
            },
            {
                "session_id": "session",
                "turn_id": "decision",
                "created_at": "2026-07-12T00:11:00Z",
                "role": "user",
                "content": "approved",
                "directory_name": "fixture-workspace",
            },
        ]

        lifecycles = FACTORY_REVIEW.find_approval_lifecycles(
            rows,
            {("session", "deploy"): ("deploy", "2026-07-12T00:00:00Z")},
        )

        self.assertEqual(lifecycles, [])

    def test_explicit_rca_stage_events_measure_boundaries_and_retries(self) -> None:
        def invocation(identifier: str, value: str, started: float) -> object:
            return FACTORY_REVIEW.Invocation(
                identifier,
                "Bash",
                "python3 scripts/record_factory_event.py rca stage " + value,
                factory_event_output("rca", "stage", value),
                started,
                started + 0.1,
                False,
            )

        turn = FACTORY_REVIEW.Turn(
            "rca",
            "fixture-workspace",
            "session",
            "rca-turn",
            "2026-07-12T00:00:00Z",
            600.0,
            "completed",
            "fixed",
            (
                invocation("evidence-1", "evidence-trace", 0.0),
                invocation("diagnose-1", "reproduce-diagnose", 120.0),
                invocation("evidence-2", "evidence-trace", 300.0),
                invocation("diagnose-2", "reproduce-diagnose", 360.0),
                invocation("verify", "verify-handoff", 540.0),
                FACTORY_REVIEW.Invocation(
                    "outcome",
                    "Bash",
                    "python3 scripts/record_factory_event.py rca outcome fixed",
                    factory_event_output("rca", "outcome", "fixed"),
                    599.0,
                    599.1,
                    False,
                ),
            ),
        )

        values = FACTORY_REVIEW.rca_turn_values(turn)

        self.assertEqual(values["Evidence + trace"].runs, 2)
        self.assertEqual(values["Evidence + trace"].durations, (120.0, 60.0))
        self.assertEqual(values["Reproduce + diagnose"].runs, 2)
        self.assertEqual(values["Reproduce + diagnose"].durations, (180.0, 180.0))
        self.assertEqual(values["Verify + handoff"].durations, (60.0,))
        self.assertEqual(FACTORY_REVIEW.rca_measurement_mode(turn), "instrumented")

    def test_explicit_deploy_boundaries_measure_review_and_production(self) -> None:
        def invocation(
            identifier: str, event: str, value: str, started: float
        ) -> object:
            return FACTORY_REVIEW.Invocation(
                identifier,
                "Bash",
                "python3 scripts/record_factory_event.py deploy " f"{event} {value}",
                factory_event_output("deploy", event, value),
                started,
                started + 0.1,
                False,
            )

        invocations = (
            invocation("review-start-1", "stage-start", "code-review", 60.0),
            invocation("review-finish-1", "stage-finish", "code-review", 180.0),
            invocation("review-start-2", "stage-start", "code-review", 240.0),
            invocation("review-finish-2", "stage-finish", "code-review", 300.0),
            invocation("production-start", "stage-start", "production-verify", 360.0),
            invocation("production-finish", "stage-finish", "production-verify", 600.0),
            invocation("runtime-start", "stage-start", "runtime-blackbox", 20.0),
            invocation("runtime-finish", "stage-finish", "runtime-blackbox", 50.0),
            invocation("outcome", "outcome", "completed", 700.0),
        )
        values = FACTORY_REVIEW.deploy_cycle_timings(invocations)
        turn = FACTORY_REVIEW.Turn(
            "deploy",
            "fixture-workspace",
            "session",
            "instrumented-deploy",
            "2026-07-12T00:00:00Z",
            701.0,
            "completed",
            "completed",
            invocations,
        )

        self.assertEqual(values["Code review"].runs, 2)
        self.assertEqual(values["Code review"].durations, (120.0, 60.0))
        self.assertEqual(values["Code review"].wall_seconds, 180.0)
        self.assertEqual(values["Production verify"].durations, (240.0,))
        self.assertEqual(values["Runtime blackbox"].durations, (30.0,))
        self.assertEqual(FACTORY_REVIEW.deploy_measurement_mode(turn), "instrumented")

    def test_factory_event_parser_rejects_searches_and_failed_writers(self) -> None:
        self.assertIsNone(
            FACTORY_REVIEW.parse_factory_event_command(
                'rg "record_factory_event.py deploy outcome completed" .'
            )
        )
        failed = FACTORY_REVIEW.Invocation(
            "failed-event",
            "Bash",
            "python3 scripts/record_factory_event.py deploy outcome completed",
            "writer failed",
            0.0,
            1.0,
            True,
        )
        missing_confirmation = FACTORY_REVIEW.Invocation(
            "missing-confirmation",
            "Bash",
            "python3 scripts/record_factory_event.py deploy outcome completed",
            "",
            0.0,
            1.0,
            False,
        )
        mismatched_confirmation = FACTORY_REVIEW.Invocation(
            "wrong-event",
            "Bash",
            "python3 scripts/record_factory_event.py deploy outcome completed",
            factory_event_output("deploy", "outcome", "blocked"),
            0.0,
            1.0,
            False,
        )
        self.assertIsNone(FACTORY_REVIEW.factory_event(failed))
        self.assertIsNone(FACTORY_REVIEW.factory_event(missing_confirmation))
        self.assertIsNone(FACTORY_REVIEW.factory_event(mismatched_confirmation))

    def test_partial_structured_telemetry_is_marked_incomplete(self) -> None:
        partial_deploy = FACTORY_REVIEW.Invocation(
            "review-start",
            "Bash",
            "python3 scripts/record_factory_event.py deploy stage-start code-review",
            factory_event_output("deploy", "stage-start", "code-review"),
            10.0,
            10.1,
            False,
        )
        partial_rca = FACTORY_REVIEW.Invocation(
            "evidence",
            "Bash",
            "python3 scripts/record_factory_event.py rca stage evidence-trace",
            factory_event_output("rca", "stage", "evidence-trace"),
            0.0,
            0.1,
            False,
        )
        deploy_values = FACTORY_REVIEW.deploy_cycle_timings((partial_deploy,))
        rca_turn = FACTORY_REVIEW.Turn(
            "rca",
            "fixture-workspace",
            "session",
            "partial-rca",
            "2026-07-12T00:00:00Z",
            60.0,
            "completed",
            "completed",
            (partial_rca,),
        )
        deploy_turn = FACTORY_REVIEW.Turn(
            "deploy",
            "fixture-workspace",
            "session",
            "partial-deploy",
            "2026-07-12T00:00:00Z",
            60.0,
            "completed",
            "completed",
            (partial_deploy,),
        )

        self.assertEqual(deploy_values["Code review"].runs, 0)
        self.assertTrue(deploy_values["Code review"].incomplete)
        self.assertEqual(
            FACTORY_REVIEW.deploy_measurement_mode(deploy_turn), "incomplete"
        )
        self.assertEqual(FACTORY_REVIEW.rca_measurement_mode(rca_turn), "incomplete")

    def test_out_of_order_structured_telemetry_is_incomplete(self) -> None:
        def event(
            identifier: str,
            workflow: str,
            event_name: str,
            value: str,
            started: float,
        ) -> object:
            return FACTORY_REVIEW.Invocation(
                identifier,
                "Bash",
                f"python3 scripts/record_factory_event.py {workflow} "
                f"{event_name} {value}",
                factory_event_output(workflow, event_name, value),
                started,
                started + 0.1,
                False,
            )

        deploy_events = (
            event("prod-start", "deploy", "stage-start", "production-verify", 1),
            event("prod-finish", "deploy", "stage-finish", "production-verify", 2),
            event("review-start", "deploy", "stage-start", "code-review", 3),
            event("review-finish", "deploy", "stage-finish", "code-review", 4),
            event("deploy-outcome", "deploy", "outcome", "completed", 5),
        )
        rca_events = (
            event("evidence", "rca", "stage", "evidence-trace", 1),
            event("verify", "rca", "stage", "verify-handoff", 2),
            event("diagnose", "rca", "stage", "reproduce-diagnose", 3),
            event("rca-outcome", "rca", "outcome", "fixed", 4),
        )
        deploy_turn = FACTORY_REVIEW.Turn(
            "deploy",
            "fixture-workspace",
            "session",
            "bad-order-deploy",
            "2026-07-12T00:00:00Z",
            6.0,
            "completed",
            "completed",
            deploy_events,
        )
        rca_turn = FACTORY_REVIEW.Turn(
            "rca",
            "fixture-workspace",
            "session",
            "bad-order-rca",
            "2026-07-12T00:00:00Z",
            5.0,
            "completed",
            "completed",
            rca_events,
        )

        self.assertEqual(
            FACTORY_REVIEW.deploy_measurement_mode(deploy_turn), "incomplete"
        )
        self.assertEqual(FACTORY_REVIEW.rca_measurement_mode(rca_turn), "incomplete")

    def test_factory_event_writer_persists_validated_events(self) -> None:
        event_log = Path(self.temp_dir.name) / "events.jsonl"
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/record_factory_event.py"),
                "rca",
                "stage",
                "evidence-trace",
            ],
            cwd=ROOT,
            env={"FACTORY_EVENT_LOG": str(event_log)},
            text=True,
            capture_output=True,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        event = json.loads(event_log.read_text().strip())
        self.assertEqual(event["workflow"], "rca")
        self.assertEqual(event["event"], "stage")
        self.assertEqual(event["value"], "evidence-trace")
        self.assertIn("recorded_at", event)

    def test_workflow_commands_require_structured_collection_hooks(self) -> None:
        deploy_command = (ROOT / ".claude/commands/deploy.md").read_text()
        rca_command = (ROOT / ".claude/commands/rca.md").read_text()

        for marker in (
            "deploy approval-request prompt-approval",
            "deploy approval-request agent-behavior-approval",
            "deploy approval-decision approved",
            "deploy stage-start runtime-blackbox",
            "deploy stage-finish runtime-blackbox",
            "deploy stage-start code-review",
            "deploy stage-finish code-review",
            "deploy stage-start production-verify",
            "deploy stage-finish production-verify",
            "deploy outcome completed",
        ):
            self.assertIn(marker, deploy_command)
        for marker in (
            "rca stage evidence-trace",
            "rca stage reproduce-diagnose",
            "rca stage verify-handoff",
            "rca outcome fixed",
            "rca outcome diagnosis-ready",
            "rca outcome blocked",
        ):
            self.assertIn(marker, rca_command)


if __name__ == "__main__":
    unittest.main()
