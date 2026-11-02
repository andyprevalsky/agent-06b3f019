#!/usr/bin/env python3
"""Blackbox regression tests for factory-review history correlation."""

from __future__ import annotations

import importlib.util
import json
import re
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch


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
        structural_bundle = FACTORY_REVIEW.Invocation(
            "structural-bundle",
            "Bash",
            "bash scripts/run-deploy-stage deploy-command-structural -- "
            "python3 scripts/run-deploy-structural-gates.py",
            "",
            0.0,
            3.0,
            False,
        )
        self.assertEqual(
            FACTORY_REVIEW.deploy_invocation_label(structural_bundle),
            "Static verify",
        )
        live_probe_bundle = FACTORY_REVIEW.Invocation(
            "live-probes",
            "Bash",
            "python3 scripts/run_deploy_live_probes.py",
            "",
            0.0,
            9.0,
            False,
        )
        self.assertEqual(
            set(FACTORY_REVIEW.deploy_invocation_labels(live_probe_bundle)),
            {"Static verify", "Runtime blackbox"},
        )
        reused = FACTORY_REVIEW.Invocation(
            "reused",
            "Bash",
            "bash scripts/run-deploy-stage backend-coverage-blackbox --reuse-passed -- test",
            "== reused passed deploy stage: backend-coverage-blackbox (exact worktree + command) ==",
            0.0,
            0.4,
            False,
        )
        self.assertEqual(FACTORY_REVIEW.deploy_invocation_labels(reused), ())

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
        self.assertEqual(mixed_values["Coverage"].runs, 1)
        self.assertEqual(mixed_values["Runtime blackbox"].runs, 1)
        self.assertEqual(
            mixed_values[FACTORY_REVIEW.HISTORICAL_UNSPLIT_LABEL].runs, 0
        )

    def test_uninstrumented_pr_activity_is_not_invented_as_review_time(self) -> None:
        invocations = tuple(
            FACTORY_REVIEW.Invocation(
                identifier,
                "Bash",
                command,
                "",
                started,
                started + 1.0,
                False,
            )
            for identifier, command, started in (
                ("push", "git push origin HEAD", 0.0),
                ("view", "gh pr view 123 --json statusCheckRollup", 600.0),
                ("checks", "gh pr checks 123 --watch", 1200.0),
                (
                    "comments",
                    "gh api repos/example/repo/pulls/123/comments",
                    1800.0,
                ),
            )
        )

        values = FACTORY_REVIEW.deploy_cycle_timings(invocations)

        self.assertEqual(values["Code review"].runs, 0)
        self.assertEqual(values["Code review"].wall_seconds, 0.0)
        self.assertTrue(values["Code review"].incomplete)
        turn = FACTORY_REVIEW.Turn(
            "deploy",
            "fixture-workspace",
            "session",
            "uninstrumented-review",
            "2026-07-12T00:00:00Z",
            1801.0,
            "completed",
            "completed",
            invocations,
        )
        review_row = next(
            row
            for row in FACTORY_REVIEW.deploy_metrics((turn,))["steps"]
            if row["step"] == "Code review"
        )
        self.assertTrue(review_row["unavailable"])

    def test_historical_production_time_is_anchored_to_merge_and_verified_signals(
        self,
    ) -> None:
        def invocation(
            identifier: str,
            command: str,
            started: float,
            ended: float,
            result: str = "",
        ) -> object:
            return FACTORY_REVIEW.Invocation(
                identifier,
                "Bash",
                command,
                result,
                started,
                ended,
                False,
            )

        invocations = (
            invocation(
                "premerge-static-read",
                "sed -n '1,120p' back-end/scripts/prod-endpoint-smoke.ts",
                0.0,
                1.0,
            ),
            invocation(
                "premerge-review-watch",
                "gh run watch 100",
                600.0,
                900.0,
                "Claude Code Review Fallback",
            ),
            invocation("merge", "gh pr merge 123 --merge", 1200.0, 1202.0),
            invocation(
                "vercel",
                "gh api 'repos/example/repo/deployments?sha=abc'",
                1210.0,
                1211.0,
            ),
            invocation(
                "fly-watch",
                "gh run watch 200 --exit-status",
                1220.0,
                1280.0,
                "Deploy Agents to Fly.io",
            ),
            invocation(
                "rollover",
                "git switch --create next origin/main",
                1290.0,
                1291.0,
            ),
            invocation(
                "semantic-finish",
                "gh run view 300 --json conclusion",
                1300.0,
                1301.0,
                "Production Semantic Frontend Gate success",
            ),
            invocation(
                "late-review-watch",
                "gh run watch 400",
                2000.0,
                2600.0,
                "Claude Code Review Fallback",
            ),
            invocation("rename", "/rename next task", 3000.0, 3001.0),
        )

        timing = FACTORY_REVIEW.historical_production_timing(invocations)

        self.assertEqual(timing.runs, 1)
        self.assertEqual(timing.durations, (101.0,))
        self.assertEqual(timing.wall_seconds, 101.0)
        self.assertFalse(timing.incomplete)

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

    def test_nested_cooperative_cutover_stage_keeps_deploy_instrumented(
        self,
    ) -> None:
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
            invocation("review-start", "stage-start", "code-review", 10.0),
            invocation("review-finish", "stage-finish", "code-review", 20.0),
            invocation("production-start", "stage-start", "production-verify", 30.0),
            invocation("cutover-start", "stage-start", "cooperative-cutover", 40.0),
            invocation("cutover-finish", "stage-finish", "cooperative-cutover", 90.0),
            invocation("production-finish", "stage-finish", "production-verify", 120.0),
            invocation("outcome", "outcome", "completed", 130.0),
        )
        turn = FACTORY_REVIEW.Turn(
            "deploy",
            "fixture-workspace",
            "session",
            "instrumented-deploy-with-cutover",
            "2026-10-02T00:00:00Z",
            131.0,
            "completed",
            "completed",
            invocations,
        )

        values = FACTORY_REVIEW.deploy_cycle_timings(invocations)
        self.assertEqual(values["Production verify"].durations, (90.0,))
        self.assertEqual(FACTORY_REVIEW.deploy_measurement_mode(turn), "instrumented")

    def test_workflow_command_factory_events_are_accepted_by_recorder(self) -> None:
        spec = importlib.util.spec_from_file_location(
            "record_factory_event", ROOT / "scripts/record_factory_event.py"
        )
        assert spec and spec.loader
        recorder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(recorder)
        invocation_re = re.compile(
            r"record_factory_event\.py\s+([a-z][a-z-]*)\s+([a-z][a-z-]*)\s+"
            r"([A-Za-z][A-Za-z0-9_-]*)"
        )
        checked = 0
        for command_file in sorted((ROOT / ".claude").rglob("*.md")):
            for workflow, event, value in invocation_re.findall(
                command_file.read_text()
            ):
                checked += 1
                with self.subTest(
                    file=str(command_file.relative_to(ROOT)),
                    invocation=f"{workflow} {event} {value}",
                ):
                    self.assertIn(workflow, recorder.VALID_EVENTS)
                    recorder.validate_event(workflow, event, value)
        self.assertGreater(checked, 30)

    def test_instrumented_deploy_does_not_require_historical_review_duration(
        self,
    ) -> None:
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
            invocation("review-start", "stage-start", "code-review", 1.0),
            invocation("review-finish", "stage-finish", "code-review", 2.0),
            invocation("production-start", "stage-start", "production-verify", 3.0),
            invocation("production-finish", "stage-finish", "production-verify", 4.0),
            invocation("outcome", "outcome", "completed", 5.0),
        )
        turn = FACTORY_REVIEW.Turn(
            "deploy",
            "fixture-workspace",
            "session",
            "instrumented-deploy-without-review-duration",
            "2026-07-12T00:00:00Z",
            6.0,
            "completed",
            "completed",
            invocations,
        )
        values = FACTORY_REVIEW.deploy_cycle_timings(invocations)
        values["Code review"] = FACTORY_REVIEW.StepTiming(
            0, (), 0.0, incomplete=True
        )

        with patch.object(FACTORY_REVIEW, "deploy_cycle_timings", return_value=values):
            self.assertEqual(
                FACTORY_REVIEW.deploy_measurement_mode(turn), "instrumented"
            )

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

        production_result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/record_factory_event.py"),
                "deploy",
                "production-start",
                "semantic",
            ],
            cwd=ROOT,
            env={"FACTORY_EVENT_LOG": str(event_log)},
            text=True,
            capture_output=True,
        )
        self.assertEqual(production_result.returncode, 0, production_result.stderr)
        production_event = json.loads(event_log.read_text().splitlines()[-1])
        self.assertEqual(production_event["event"], "production-start")
        self.assertEqual(production_event["value"], "semantic")

        descend_log = Path(self.temp_dir.name) / "descend-events.jsonl"
        descend = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/record_factory_event.py"),
                "descend",
                "stage-start",
                "RESOLVE_SLICE",
            ],
            cwd=ROOT,
            env={"FACTORY_EVENT_LOG": str(descend_log)},
            text=True,
            capture_output=True,
        )
        self.assertEqual(descend.returncode, 0, descend.stderr)
        descend_event = json.loads(descend_log.read_text().strip())
        self.assertEqual(descend_event["workflow"], "descend")
        self.assertEqual(descend_event["event"], "stage-start")
        self.assertEqual(descend_event["value"], "RESOLVE_SLICE")
        self.assertIn("FACTORY_EVENT ", descend.stdout)
        for field in (
            "recorded_at",
            "recorded_epoch",
            "workspace",
            "git_sha",
            "branch",
        ):
            self.assertIn(field, descend_event)

    def test_factory_review_consumes_checked_in_descend_events(self) -> None:
        records = [
            {
                "schema_version": 1,
                "record_type": "factory_event",
                "record_id": "start-a",
                "workflow": "descend",
                "event": "stage-start",
                "value": "RUN_SLICE",
                "recorded_at": "2026-07-21T00:00:00Z",
                "recorded_epoch": 1753056000.0,
                "run_id": "run-a",
                "slice": "daily",
                "task_count": 42,
                "lane": "main",
                "step": "RUN_SLICE",
                "epoch": "1",
                "status": "running",
            },
            {
                "schema_version": 1,
                "record_type": "factory_event",
                "record_id": "finish-a",
                "workflow": "descend",
                "event": "stage-finish",
                "value": "RUN_SLICE",
                "recorded_at": "2026-07-21T00:00:40Z",
                "recorded_epoch": 1753056040.0,
                "run_id": "run-a",
                "slice": "daily",
                "task_count": 42,
                "lane": "main",
                "step": "RUN_SLICE",
                "epoch": "1",
                "status": "completed",
                "started_at": "2026-07-21T00:00:00Z",
                "finished_at": "2026-07-21T00:00:40Z",
                "duration_seconds": 40.0,
                "run_terminal": True,
            },
            {
                "schema_version": 1,
                "record_type": "factory_event",
                "record_id": "outcome-a",
                "workflow": "descend",
                "event": "outcome",
                "value": "completed",
                "recorded_at": "2026-07-21T00:00:40Z",
                "recorded_epoch": 1753056040.0,
                "run_id": "run-a",
                "slice": "daily",
                "task_count": 42,
                "lane": "main",
                "step": "RUN_SLICE",
                "epoch": "1",
                "status": "completed",
            },
        ]

        history = Path(self.temp_dir.name) / "descend-steps.jsonl"
        history.write_text(
            "\n".join(
                json.dumps(record)
                for record in [
                    {
                        "record_type": "factory_event_schema",
                        "schema_version": 1,
                        "workflow": "descend",
                    },
                    *records,
                    records[-1],
                ]
            )
            + "\n"
        )
        loaded = FACTORY_REVIEW.load_descend_factory_events(history)
        self.assertEqual(len(loaded), 3)
        payload = FACTORY_REVIEW.analyze([], "2026-07-01", 20, descend_records=loaded)
        self.assertEqual(payload["descend"]["run_wall_clock"]["completed_runs"], 1)
        self.assertEqual(payload["descend"]["steps"][0]["step"], "RUN_SLICE")
        self.assertIn("/descend", FACTORY_REVIEW.render_html(payload))

    def test_descend_compares_completed_main_lane_windows(self) -> None:
        records: list[dict[str, object]] = []
        base_epoch = 1_753_056_000.0
        step_durations = (10.0, 12.0, 8.0, 6.0)
        run_durations = (100.0, 120.0, 90.0, 60.0)
        # zip(strict=True) needs Python 3.10+, but this gate runs under the
        # system `python3`, which is 3.9 on some Linux hosts. Assert the pairing
        # invariant explicitly so the check survives either interpreter.
        self.assertEqual(len(step_durations), len(run_durations))
        for index, (step_duration, run_duration) in enumerate(
            zip(step_durations, run_durations)
        ):
            run_id = f"run-{index}"
            started = base_epoch + index * 1_000
            records.extend(
                [
                    {
                        "record_type": "factory_event",
                        "record_id": f"start-{index}",
                        "workflow": "descend",
                        "event": "stage-start",
                        "value": "RUN_SLICE",
                        "recorded_at": f"2026-07-{index + 1:02d}T00:00:00Z",
                        "recorded_epoch": started,
                        "run_id": run_id,
                        "slice": "daily",
                        "lane": "main",
                    },
                    {
                        "record_type": "factory_event",
                        "record_id": f"finish-{index}",
                        "workflow": "descend",
                        "event": "stage-finish",
                        "value": "RUN_SLICE",
                        "recorded_at": f"2026-07-{index + 1:02d}T00:00:10Z",
                        "recorded_epoch": started + step_duration,
                        "duration_seconds": step_duration,
                        "run_id": run_id,
                        "slice": "daily",
                        "lane": "main",
                        "status": "completed",
                    },
                    {
                        "record_type": "factory_event",
                        "record_id": f"outcome-{index}",
                        "workflow": "descend",
                        "event": "outcome",
                        "value": "completed",
                        "recorded_at": f"2026-07-{index + 1:02d}T00:02:00Z",
                        "recorded_epoch": started + run_duration,
                        "run_id": run_id,
                        "slice": "daily",
                        "lane": "main",
                    },
                ]
            )
        records.extend(
            [
                {
                    "record_type": "factory_event",
                    "record_id": "failed-main",
                    "workflow": "descend",
                    "event": "stage-finish",
                    "value": "RUN_SLICE",
                    "recorded_epoch": base_epoch + 10_000,
                    "duration_seconds": 1.0,
                    "run_id": "failed",
                    "lane": "main",
                    "status": "failed",
                },
                {
                    "record_type": "factory_event",
                    "record_id": "completed-worker",
                    "workflow": "descend",
                    "event": "stage-finish",
                    "value": "RCA_INFRA_FIX",
                    "recorded_epoch": base_epoch + 11_000,
                    "duration_seconds": 1.0,
                    "run_id": "worker",
                    "lane": "rca-I-01",
                    "status": "completed",
                },
            ]
        )

        metrics = FACTORY_REVIEW.descend_metrics(records, window=2)

        self.assertEqual(metrics["step_records"], 4)
        self.assertEqual(metrics["run_wall_clock"]["completed_runs"], 4)
        self.assertEqual(metrics["run_wall_clock"]["previous_median_seconds"], 110.0)
        self.assertEqual(metrics["run_wall_clock"]["recent_median_seconds"], 75.0)
        self.assertEqual(metrics["run_wall_clock"]["change_percent"], -31.8)
        self.assertEqual(len(metrics["steps"]), 1)
        run_slice = metrics["steps"][0]
        self.assertEqual(run_slice["step"], "RUN_SLICE")
        self.assertEqual(run_slice["previous_median_seconds"], 11.0)
        self.assertEqual(run_slice["recent_median_seconds"], 7.0)
        self.assertEqual(run_slice["change_percent"], -36.4)
        rendered = FACTORY_REVIEW.render_descend_table(metrics)
        self.assertIn("Negative change is faster", rendered)
        self.assertIn("Previous median", rendered)
        self.assertIn("-36.4%", rendered)

    def test_factory_step_copy_matches_current_optimized_workflows(self) -> None:
        descriptions = FACTORY_REVIEW.STEP_DESCRIPTIONS

        self.assertIn("Amplitude", descriptions["deploy"]["Runtime blackbox"])
        self.assertIn("three cycles", descriptions["deploy"]["Code review"])
        self.assertIn("first-bad boundary", descriptions["rca"]["Evidence + trace"])
        self.assertIn("cement", descriptions["rca"]["Verify + handoff"])
        factory_instructions = (ROOT / "CLAUDE.md").read_text()
        for workflow in ("/deploy", "/RCA", "/descend"):
            self.assertIn(workflow, factory_instructions)

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
            "deploy production-start vercel",
            "deploy production-finish vercel",
            "deploy production-start render",
            "deploy production-finish render",
            "deploy production-start fly",
            "deploy production-finish fly",
            "deploy production-start mac-release",
            "deploy production-finish mac-release",
            "deploy production-start backend-probes",
            "deploy production-finish backend-probes",
            "deploy production-start semantic",
            "deploy production-finish semantic",
            "deploy production-start agentcard",
            "deploy production-finish agentcard",
            "deploy outcome completed",
            "agents/benchmarks/history/factory_events.jsonl",
            "Every `/deploy` publishes these timestamps to the repo, whatever its outcome.",
        ):
            self.assertIn(marker, deploy_command)
        # The publication rule, the review-cap block and Step 15 each publish.
        self.assertGreaterEqual(
            deploy_command.count("python3 scripts/factory_ledger.py publish"), 3
        )
        self.assertNotIn("factory_ledger.py sync", deploy_command)
        blocked = deploy_command.index("deploy outcome blocked")
        self.assertLess(
            deploy_command.index("factory_ledger.py publish", blocked) - blocked, 120
        )
        self.assertIn(
            "agents/benchmarks/history/factory_events.jsonl merge=union",
            (ROOT / ".gitattributes").read_text(),
        )
        for marker in (
            "rca stage evidence-trace",
            "rca stage reproduce-diagnose",
            "rca stage verify-handoff",
            "rca outcome fixed",
            "rca outcome diagnosis-ready",
            "rca outcome blocked",
        ):
            self.assertIn(marker, rca_command)


LEDGER = FACTORY_REVIEW._factory_ledger_module()
T0 = 1_800_000_000.0


def stage(run_id: str, name: str, start: float, end: float, status: str = "passed") -> dict:
    return {
        "schema_version": 1,
        "kind": "deploy-stage",
        "run_id": run_id,
        "stage": name,
        "started_epoch": T0 + start,
        "finished_epoch": T0 + end,
        "status": status,
        "branch": "feat/x",
        "git_sha": "abc",
    }


def event(workflow: str, name: str, value: str, at: float, branch: str = "feat/x") -> dict:
    return {
        "schema_version": 1,
        "kind": "factory-event",
        "workflow": workflow,
        "event": name,
        "value": value,
        "recorded_epoch": T0 + at,
        "workspace": "rose",
        "branch": branch,
    }


class LedgerSourceTest(unittest.TestCase):
    """/deploy and /RCA rebuilt from repo-tracked telemetry without Conductor."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_local_telemetry(self, root: Path) -> None:
        run_dir = root / "deploy-runs" / "run-1"
        run_dir.mkdir(parents=True)
        (run_dir / "metadata.json").write_text(
            json.dumps({"run_id": "run-1", "branch": "feat/x", "git_sha": "abc"})
        )
        (run_dir / "stages.jsonl").write_text(
            json.dumps(
                {
                    "run_id": "run-1",
                    "stage": "prettier",
                    "started_epoch": T0,
                    "finished_epoch": T0 + 5,
                    "status": "passed",
                    "exit_code": 0,
                    "log": "logs/prettier.log",
                }
            )
            + "\n"
        )
        (root / "factory-events.jsonl").write_text(
            "\n".join(
                json.dumps({k: v for k, v in row.items() if k not in {"kind", "schema_version"}})
                for row in (
                    event("deploy", "outcome", "completed", 60),
                    event("descend", "outcome", "completed", 61),
                )
            )
            + "\nnot-json\n"
        )

    def test_sync_is_idempotent_and_keeps_machine_paths_out_of_git(self) -> None:
        local = self.root / "context"
        self.write_local_telemetry(local)
        ledger = self.root / "factory_events.jsonl"

        self.assertEqual(LEDGER.sync(ledger, [local]), 2)
        self.assertEqual(LEDGER.sync(ledger, [local, local]), 0)

        rows = [json.loads(line) for line in ledger.read_text().splitlines()]
        self.assertEqual([row["kind"] for row in rows], ["deploy-stage", "factory-event"])
        self.assertNotIn("log", rows[0])
        self.assertEqual(rows[0]["branch"], "feat/x")
        self.assertEqual(rows[1]["workflow"], "deploy")

    def git(self, repo: Path, *args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=repo, check=True, capture_output=True, text=True
        ).stdout.strip()

    def clone_with_origin(self) -> tuple[Path, Path]:
        origin = self.root / "origin.git"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
        work = self.root / "work"
        subprocess.run(["git", "clone", "-q", str(origin), str(work)], check=True, capture_output=True)
        self.git(work, "config", "user.name", "Fixture")
        self.git(work, "config", "user.email", "fixture@example.com")
        history = work / "agents/benchmarks/history"
        history.mkdir(parents=True)
        (history / "descend_steps.jsonl").write_text('{"record_id":"r1","workflow":"descend"}\n')
        (work / "README").write_text("fixture\n")
        self.git(work, "add", ".")
        self.git(work, "commit", "-q", "-m", "base")
        self.git(work, "push", "-q", "origin", "HEAD:main")
        return origin, work

    def test_publish_appends_every_skill_to_main_without_touching_the_branch(self) -> None:
        origin, work = self.clone_with_origin()
        self.git(work, "checkout", "-q", "-b", "feat/deploying")
        descend = work / "agents/benchmarks/history/descend_steps.jsonl"
        descend.write_text(descend.read_text() + '{"record_id":"r2","workflow":"descend"}\n')
        local = self.root / "context"
        self.write_local_telemetry(local)
        (local / "factory-events.jsonl").write_text(
            (local / "factory-events.jsonl").read_text()
            + json.dumps({k: v for k, v in event("rca", "outcome", "fixed", 90).items() if k != "kind"})
            + "\n"
        )
        branch_head = self.git(work, "rev-parse", "HEAD")
        status_before = self.git(work, "status", "--porcelain")

        self.assertEqual(LEDGER.publish(work, [local]), 4)

        self.assertEqual(self.git(work, "rev-parse", "HEAD"), branch_head)
        self.assertEqual(self.git(work, "status", "--porcelain"), status_before)
        main_events = self.git(origin, "show", "main:agents/benchmarks/history/factory_events.jsonl")
        workflows = [json.loads(line).get("workflow") for line in main_events.splitlines()]
        self.assertEqual(sorted(filter(None, workflows)), ["deploy", "rca"])
        self.assertIn('"stage":"prettier"', main_events)
        main_descend = self.git(origin, "show", "main:agents/benchmarks/history/descend_steps.jsonl")
        self.assertEqual([json.loads(l)["record_id"] for l in main_descend.splitlines()], ["r1", "r2"])
        self.assertEqual(LEDGER.publish(work, [local]), 0)

    def test_publish_retries_when_main_moves_and_keeps_the_other_commit(self) -> None:
        origin, work = self.clone_with_origin()
        other = self.root / "other"
        subprocess.run(["git", "clone", "-q", str(origin), str(other)], check=True, capture_output=True)
        self.git(other, "config", "user.name", "Other")
        self.git(other, "config", "user.email", "other@example.com")
        local = self.root / "context"
        self.write_local_telemetry(local)

        def race(attempt: int) -> None:
            if attempt == 0:
                (other / "MERGED").write_text("another deploy\n")
                self.git(other, "add", "MERGED")
                self.git(other, "commit", "-q", "-m", "concurrent merge")
                self.git(other, "push", "-q", "origin", "HEAD:main")

        self.assertEqual(LEDGER.publish(work, [local], before_push=race), 2)
        self.assertEqual(self.git(origin, "show", "main:MERGED"), "another deploy")
        self.assertEqual(
            len(self.git(origin, "show", "main:agents/benchmarks/history/factory_events.jsonl").splitlines()),
            2,
        )

    def test_report_reads_rows_published_to_main_once(self) -> None:
        published = LEDGER.encode_rows([stage("run-1", "prettier", 0, 5), event("deploy", "outcome", "completed", 60)])
        ledger = self.root / "factory_events.jsonl"
        ledger.write_text(published.splitlines()[0] + "\n")

        rows = FACTORY_REVIEW.load_ledger_rows(ledger, [], [published])
        self.assertEqual([row["kind"] for row in rows], ["deploy-stage", "factory-event"])

        descend = self.root / "descend_steps.jsonl"
        record = {"workflow": "descend", "record_type": "factory_event", "record_id": "r1", "recorded_epoch": 1}
        descend.write_text(json.dumps(record) + "\n")
        both = FACTORY_REVIEW.load_descend_factory_events(
            descend, [json.dumps(record) + "\n" + json.dumps({**record, "record_id": "r2"}) + "\n"]
        )
        self.assertEqual([item["record_id"] for item in both], ["r1", "r2"])

    def test_ledger_rebuilds_instrumented_deploy_gates_and_approvals(self) -> None:
        rows = [
            stage("run-1", "prompt-approval", 0, 1, status="failed"),
            event("deploy", "approval-request", "prompt-approval", 2),
            event("deploy", "approval-decision", "approved", 602),
            stage("run-1", "prettier", 610, 620),
            event("deploy", "stage-start", "runtime-blackbox", 630),
            stage("run-1", "backend-coverage-blackbox", 630, 930),
            event("deploy", "stage-finish", "runtime-blackbox", 930),
            stage("run-1", "smoke", 940, 1540),
            stage("run-1", "semantic", 940, 1240),
            event("deploy", "stage-start", "code-review", 1600),
            event("deploy", "stage-finish", "code-review", 1900),
            event("deploy", "stage-start", "production-verify", 1960),
            event("deploy", "stage-finish", "production-verify", 2260),
            event("deploy", "outcome", "completed", 2300),
        ]
        turns = FACTORY_REVIEW.ledger_deploy_turns(sorted(rows, key=LEDGER.row_epoch))

        self.assertEqual(len(turns), 1)
        turn = turns[0]
        self.assertEqual(turn.status, "completed")
        self.assertEqual(turn.duration, 2300.0)
        self.assertEqual(turn.consumed_approval_durations, (600.0,))
        self.assertEqual(FACTORY_REVIEW.deploy_measurement_mode(turn), "instrumented")
        values = FACTORY_REVIEW.deploy_turn_values(turn)
        self.assertEqual(values["Smoke benchmarks"].durations, (600.0,))
        self.assertEqual(values["Semantic tests"].durations, (300.0,))
        self.assertEqual(values["Code review"].durations, (300.0,))
        self.assertEqual(values["Production verify"].durations, (300.0,))
        self.assertEqual(values["Group 4 wall clock"].wall_seconds, 900.0)

    def test_blocked_then_resumed_deploy_is_one_logical_deploy(self) -> None:
        rows = [
            stage("run-1", "prettier", 0, 10),
            event("deploy", "approval-request", "combined", 20),
            event("deploy", "outcome", "blocked", 30),
            event("deploy", "approval-decision", "approved", 3620),
            stage("run-2", "prettier", 4000, 4010),
            event("deploy", "outcome", "completed", 5000),
        ]
        turns = FACTORY_REVIEW.ledger_deploy_turns(sorted(rows, key=LEDGER.row_epoch))

        self.assertEqual([turn.status for turn in turns], ["blocked", "completed"])
        blocked, completed = turns
        self.assertEqual(blocked.approval_durations, (3600.0,))
        self.assertEqual(completed.consumed_approval_durations, (3600.0,))
        self.assertEqual(FACTORY_REVIEW.deploy_duration(completed), 5000.0)

    def test_explicit_run_identity_keeps_post_merge_events_with_original_stages(self) -> None:
        rows = [
            stage("run-1", "prettier", 0, 10),
            stage("run-1", "smoke", 10, 40, status="failed"),
            stage("other-run", "prettier", 45, 50),
        ]
        for name, value, at, branch in (
            ("stage-start", "production-verify", 60, "feat/x"),
            ("stage-finish", "production-verify", 120, "main"),
            ("outcome", "completed", 130, "feat/x-2"),
        ):
            rows.append({**event("deploy", name, value, at, branch), "run_id": "run-1"})
        turns = FACTORY_REVIEW.ledger_deploy_turns(sorted(rows, key=LEDGER.row_epoch))
        completed = [turn for turn in turns if turn.status == "completed"]
        self.assertEqual(len(completed), 1)
        self.assertEqual(completed[0].turn_id, "run-1")
        self.assertEqual(completed[0].duration, 130)
        self.assertEqual(
            FACTORY_REVIEW.deploy_turn_values(completed[0])["Production verify"].durations,
            (60,),
        )
        self.assertEqual(next(turn for turn in turns if turn.turn_id == "other-run").status, "incomplete")

    def test_unknown_explicit_run_never_falls_back_to_a_matching_branch(self) -> None:
        rows = [stage("run-1", "prettier", 0, 10),
                {**event("deploy", "outcome", "completed", 20), "run_id": "not-collected"}]
        turns = FACTORY_REVIEW.ledger_deploy_turns(rows)
        self.assertEqual(next(turn for turn in turns if turn.turn_id == "run-1").status, "incomplete")
        self.assertFalse(any(turn.status == "completed" for turn in turns))

    def test_reporting_only_coverage_is_not_a_runtime_test_execution(self) -> None:
        turns = FACTORY_REVIEW.ledger_deploy_turns([
            stage("run-1", "backend-coverage-report", 0, 36),
            {**event("deploy", "outcome", "completed", 40), "run_id": "run-1"},
        ])
        values = FACTORY_REVIEW.deploy_turn_values(turns[0])
        self.assertEqual(values["Coverage"].wall_seconds, 36)
        self.assertEqual(values["Runtime blackbox"].wall_seconds, 0)

    def test_event_writer_binds_only_active_deploy_run(self) -> None:
        run_root = self.root / "runs"
        run_dir = run_root / "run-1"
        run_dir.mkdir(parents=True)
        (run_root / "current").write_text("run-1\n")
        metadata_path = run_dir / "metadata.json"
        metadata_path.write_text(json.dumps({"run_id": "run-1", "status": "active"}))
        log = self.root / "events.jsonl"
        def emit(workflow: str, name: str, value: str) -> dict:
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts/record_factory_event.py"), workflow, name, value],
                cwd=ROOT,
                env={"FACTORY_EVENT_LOG": str(log), "DEPLOY_RUN_ROOT": str(run_root)},
                text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(log.read_text().splitlines()[-1])
        self.assertEqual(emit("deploy", "outcome", "completed").get("run_id"), "run-1")
        self.assertIsNone(emit("rca", "outcome", "fixed").get("run_id"))
        metadata_path.write_text(json.dumps({"run_id": "run-1", "status": "completed"}))
        self.assertIsNone(emit("deploy", "outcome", "completed").get("run_id"))
        (run_root / "current").write_text("../foreign\n")
        self.assertIsNone(emit("deploy", "outcome", "completed").get("run_id"))

    def test_append_only_identity_enrichment_is_published_once_and_read_once(self) -> None:
        original = event("deploy", "outcome", "completed", 130, "feat/x-2")
        enriched = {**original, "run_id": "run-1"}
        local = self.root / "context"
        local.mkdir()
        (local / "factory-events.jsonl").write_text(json.dumps(enriched) + "\n")
        old = json.dumps(original) + "\n"
        self.assertEqual(LEDGER.pending_rows(old, [local])[0]["run_id"], "run-1")
        combined = old + json.dumps(enriched) + "\n"
        self.assertEqual(LEDGER.pending_rows(combined, [local]), [])
        (local / "factory-events.jsonl").write_text(combined)
        self.assertEqual(LEDGER.pending_rows("", [local])[0]["run_id"], "run-1")
        original_metadata = {**original, "telemetry": {"usage": {"cost_usd": 3.0}}}
        changed_metadata = {**enriched, "telemetry": {"usage": {"cost_usd": 0.0}}}
        self.assertFalse(LEDGER.is_identity_enrichment(original_metadata, changed_metadata))
        ledger = self.root / "factory.jsonl"
        ledger.write_text(json.dumps(stage("run-1", "prettier", 0, 10)) + "\n" + combined)
        rows = FACTORY_REVIEW.load_ledger_rows(ledger, [])
        self.assertEqual(len(rows), 2)
        turns = FACTORY_REVIEW.ledger_deploy_turns(rows)
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0].duration, 130)

    def test_finished_stage_admission_retains_identity_until_deploy_outcome(self) -> None:
        run_root = self.root / "runs"
        log = self.root / "events.jsonl"
        environment = {"DEPLOY_RUN_ROOT": str(run_root), "FACTORY_EVENT_LOG": str(log)}
        for args in (("--start", "--run-id", "run-1"), ("--finish",)):
            result = subprocess.run(["bash", str(ROOT / "scripts/run-deploy-stage"), *args],
                                    cwd=ROOT, env=environment, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            if args[0] == "--start":
                blocked = subprocess.run([sys.executable, str(ROOT / "scripts/record_factory_event.py"),
                                          "deploy", "outcome", "blocked"], cwd=ROOT,
                                         env=environment, text=True, capture_output=True)
                self.assertEqual(blocked.returncode, 0, blocked.stderr)
                self.assertEqual((run_root / "factory-current").read_text().strip(), "run-1")
        self.assertFalse((run_root / "current").exists())
        self.assertEqual((run_root / "factory-current").read_text().strip(), "run-1")
        for name, value in (("stage-start", "production-verify"), ("outcome", "completed")):
            result = subprocess.run([sys.executable, str(ROOT / "scripts/record_factory_event.py"),
                                     "deploy", name, value], cwd=ROOT, env=environment,
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(log.read_text().splitlines()[-1])["run_id"], "run-1")
        self.assertFalse((run_root / "factory-current").exists())

    def test_run_without_outcome_is_excluded_not_zero(self) -> None:
        turns = FACTORY_REVIEW.ledger_deploy_turns([stage("run-1", "prettier", 0, 10)])
        self.assertEqual(turns[0].status, "incomplete")

        payload = FACTORY_REVIEW.analyze(turns, "2000-01-01", 20)
        rows = {row["step"]: row for row in payload["deploy"]["steps"]}
        self.assertTrue(rows["Static verify"]["unavailable"])
        self.assertTrue(rows["Total"]["unavailable"])
        page = FACTORY_REVIEW.render_html(payload)
        self.assertIn("No completed runs in this data source", page)
        self.assertNotIn("0.0m end-to-end", page)

    def test_ledger_rca_events_build_instrumented_rca(self) -> None:
        rows = [
            event("rca", "stage", "evidence-trace", 0, branch="main"),
            event("rca", "stage", "reproduce-diagnose", 120, branch="main"),
            event("rca", "stage", "verify-handoff", 600, branch="main"),
            event("rca", "outcome", "fixed", 900, branch="main"),
            event("rca", "stage", "evidence-trace", 1000, branch="main"),
        ]
        turns = FACTORY_REVIEW.ledger_rca_turns(rows)

        self.assertEqual([turn.status for turn in turns], ["completed", "incomplete"])
        self.assertEqual(FACTORY_REVIEW.rca_measurement_mode(turns[0]), "instrumented")
        states = FACTORY_REVIEW.rca_state_rows(turns[0])
        self.assertEqual([timing.durations for timing in states], [(120.0,), (480.0,), (300.0,)])

    def test_partial_ledger_rca_times_recorded_stages_not_inferred_ones(self) -> None:
        rows = [
            event("rca", "stage", "evidence-trace", 0, branch="main"),
            event("rca", "stage", "reproduce-diagnose", 210, branch="main"),
            event("rca", "outcome", "diagnosis-ready", 2360, branch="main"),
        ]
        (turn,) = FACTORY_REVIEW.ledger_rca_turns(rows)

        self.assertEqual(turn.status, "diagnosis-ready")
        self.assertEqual(FACTORY_REVIEW.rca_measurement_mode(turn), "incomplete")
        states = FACTORY_REVIEW.rca_state_rows(turn)
        self.assertEqual([timing.durations for timing in states], [(210.0,), (2150.0,), ()])
        self.assertTrue(all(timing.incomplete for timing in states))

    def test_predeploy_consumption_groups_trajectories_by_deploy_branch(self) -> None:
        history = self.root / "history"
        history.mkdir()
        attempts = []
        for deploy, (branch_start, agent_prefix) in enumerate(((0, "a"), (86_400, "b"))):
            for index, (task, passed) in enumerate((("alpha", True), ("beta", deploy == 0))):
                for copy in range(2):
                    attempts.append(
                        {
                            "task": task,
                            "passed": passed,
                            "duration_seconds": 100.0,
                            "cost_cents": 5.0,
                            "timestamp": FACTORY_REVIEW._epoch_iso(
                                T0 + branch_start + 200 * index + 100 + copy
                            ),
                            "agent_id": f"{agent_prefix}{index}{copy}".ljust(36, "0"),
                            "suite": "predeploy",
                        }
                    )
        attempts.append({**attempts[0], "suite": None, "task": "ignored"})
        (history / "task_attempts.jsonl").write_text(
            "\n".join(json.dumps(row) for row in attempts) + "\n"
        )
        (history / "span_durations.20270115.feat-x.jsonl").write_text(
            "".join(
                '{"agent_id": "' + row["agent_id"] + '", "benchmark": "x"}\n'
                for row in attempts[:4]
            )
        )
        catalog = self.root / "tasks.json"
        catalog.write_text(
            json.dumps(
                [
                    {"name": "alpha", "deploy_category": "payment", "tags": ["smoke"]},
                    {"name": "beta", "deploy_category": "payment", "tags": []},
                ]
            )
        )

        metrics = FACTORY_REVIEW.predeploy_consumption(
            history, catalog, now=datetime(2027, 1, 20, tzinfo=timezone.utc)
        )

        self.assertEqual(metrics["attempts"], 8)
        self.assertEqual(metrics["deploys"], 2)
        self.assertEqual(metrics["attributed_deploys"], 1)
        tasks = {row["task"]: row for row in metrics["tasks"]}
        self.assertEqual(tasks["alpha"]["attempts_per_deploy"], 2.0)
        self.assertEqual(tasks["alpha"]["cents_per_deploy"], 10.0)
        self.assertTrue(tasks["alpha"]["smoke"])
        self.assertEqual(tasks["beta"]["failed_deploys"], 1)
        self.assertAlmostEqual(tasks["beta"]["agent_share"], 0.5)
        (category,) = metrics["categories"]
        self.assertEqual(category["joint_pass_rate"], 0.5)
        self.assertEqual(metrics["windows"][0]["deploys"], 2)
        page = FACTORY_REVIEW.render_predeploy_section(metrics)
        self.assertIn("Joint pass", page)

    def test_cli_uses_ledger_when_conductor_database_is_absent(self) -> None:
        local = self.root / "context"
        self.write_local_telemetry(local)
        history = self.root / "history"
        history.mkdir()
        output = self.root / "out"
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/factory_review.py"),
                "--db",
                str(self.root / "missing.db"),
                "--ledger",
                str(self.root / "factory_events.jsonl"),
                "--telemetry-root",
                str(local),
                "--history-dir",
                str(history),
                "--catalog",
                str(self.root / "missing-tasks.json"),
                "--descend-history",
                str(history / "descend_steps.jsonl"),
                "--output-dir",
                str(output),
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads((output / "factory-review.json").read_text())
        self.assertEqual(payload["sources"]["mode"], "ledger")
        self.assertEqual(payload["deploy"]["completed"], 1)
        self.assertIn("Data source:", (output / "factory-review.html").read_text())
        self.assertEqual(payload["diagnostics"]["coverage"]["stage_rows"], 1)
        self.assertIn("Failures, reruns and gaps", (output / "factory-review.html").read_text())


DIAGNOSTICS = FACTORY_REVIEW._factory_ledger_module("factory_diagnostics")


def detailed(row: dict, **detail: object) -> dict:
    return {**row, "detail": {"schema_version": 1, **detail}}


class DiagnosticsTest(unittest.TestCase):

    def test_invalid_nested_measurements_remain_unmeasured(self):
        row=detailed(stage("run", "gate", 0, 10, "failed"), timing=[1], host="unknown")
        result=DIAGNOSTICS.analyze_ledger([row])["gates"][0]
        for field in ("median_setup_seconds", "median_queue_seconds", "median_exec_seconds", "max_load1", "min_mem_available_mb"):
            self.assertIsNone(result[field])

    def test_nested_detail_shapes_are_unknown_without_losing_valid_metrics(self):
        base = detailed(stage("run-1", "gate", 0, 10, "failed"),
                        outcome={"failure_class": "assertion", "failing": ["kept"]},
                        timing={"exec_seconds": 10}, source={"sha": "a" * 40})
        for field in ("outcome", "attempt", "timing", "host", "source", "reuse"):
            for value in (["wrong"], "wrong", 1):
                with self.subTest(field=field, value=value):
                    broken = {**base, "detail": {**base["detail"], field: value}}
                    result = DIAGNOSTICS.analyze_ledger([base, broken])
                    self.assertEqual(result["coverage"]["stage_rows"], 2)
                    self.assertEqual(result["gates"][0]["failed"], 2)
                    self.assertEqual(result["gates"][0]["median_exec_seconds"], 10)
                    self.assertIn({"name": "kept", "count": 1 if field == "outcome" else 2}, result["gates"][0]["failing_names"])

    def test_nested_counter_keys_and_names_are_type_checked(self):
        for failing in (123, "word", [["nested"]], {"name": "bad"}):
            with self.subTest(failing=failing):
                row = detailed(stage("run", "gate", 0, 10, "failed"),
                               outcome={"failure_class": ["bad"], "failing": failing},
                               attempt={"retry_cause": {"bad": True}})
                result = DIAGNOSTICS.analyze_ledger([row])
                self.assertEqual(result["gates"][0]["failure_classes"], [{"name": "unclassified", "count": 1}])
                self.assertEqual(result["gates"][0]["failing_names"], [])
                self.assertEqual(result["retry_causes"], [])
        row = detailed(stage("run", "gate", 0, 10, "failed"), outcome={"failure_class": "assertion", "failing": ["good", ["bad"], 42]})
        self.assertEqual(DIAGNOSTICS.analyze_ledger([row])["gates"][0]["failing_names"], [{"name":"good", "count":1}])


    """Failure reasons, rerun causes, reuse, queue/exec and gap attribution."""

    def rows(self) -> list[dict]:
        source = {"sha": "a" * 40, "files_changed": 3, "insertions": 10, "deletions": 2, "lanes": ["scripts"]}
        return [
            detailed(
                stage("run-1", "typescript", 0, 60, "failed"),
                outcome={"exit_code": 2, "failure_class": "typecheck", "failing": ["src/a.ts"]},
                attempt={"attempt": 1},
                timing={"setup_seconds": 1.0, "exec_seconds": 60.0, "queue_seconds": 30.0},
                host={"load1_peak": 7.5, "mem_available_min_mb": 900.0},
                source=source,
                reuse={"requested": True, "hit": False, "miss_reason": "no-prior-pass"},
            ),
            # 10 minutes fixing before the retry on a new commit.
            detailed(
                stage("run-1", "typescript", 660, 700),
                outcome={"exit_code": 0, "failure_class": None},
                attempt={"attempt": 2, "retry_cause": "new-commit", "fix_sha": "b" * 40},
                timing={"setup_seconds": 0.5, "exec_seconds": 40.0},
                reuse={"requested": True, "hit": False, "miss_reason": "inputs-changed"},
            ),
            detailed(stage("run-1", "typescript", 701, 701, "reused"), reuse={"requested": True, "hit": True}),
            # An older row without detail still counts as an attempt.
            stage("run-1", "prettier", 702, 710),
            event("deploy", "review-request", "coderabbit", 720),
            event("deploy", "review-arrival", "coderabbit", 1320),
            stage("run-1", "semantic", 1330, 1400),
            event("deploy", "production-start", "render", 1400),
            event("deploy", "production-finish", "render", 1700),
            event("deploy", "outcome", "completed", 1701),
            event("rca", "repro-attempt", "reproduced", 2000),
            event("rca", "repro-attempt", "fix-verified", 2100),
        ]

    def test_ledger_diagnostics_explain_failures_reruns_and_gaps(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            attempts = Path(directory) / "task_attempts.jsonl"
            attempts.write_text(
                "\n".join(
                    json.dumps(row)
                    for row in (
                        {"task": "a", "passed": True, "status": "COMPLETED", "duration_seconds": 10,
                         "timestamp": "2026-10-28T00:00:00+00:00", "run_id": "bench-1", "outcome_class": "passed"},
                        {"task": "b", "passed": False, "status": "ERROR", "duration_seconds": 30,
                         "timestamp": "2026-10-28T00:00:01+00:00", "run_id": "bench-1", "outcome_class": "failed"},
                        {"task": "c", "passed": True, "status": "COMPLETED", "duration_seconds": 5,
                         "timestamp": "2026-10-27T00:00:00+00:00"},
                    )
                )
                + "\n"
            )
            result = DIAGNOSTICS.analyze_ledger(
                self.rows(),
                attempts_path=attempts,
                descend_records=[{"run_id": "d1", "detail": {"infra_failed": 2, "scheduled_total": 600}}],
            )
        self.assertEqual(result["coverage"], {"stage_rows": 5, "stage_rows_with_detail": 3, "deploy_runs": 1, "rejected_rows": 0})
        gate = next(row for row in result["gates"] if row["gate"] == "typescript")
        self.assertEqual((gate["executed"], gate["failed"], gate["reruns"], gate["reused"]), (2, 1, 1, 1))
        self.assertEqual(gate["failure_classes"], [{"name": "typecheck", "count": 1}])
        self.assertEqual(gate["failing_names"], [{"name": "src/a.ts", "count": 1}])
        self.assertEqual(gate["median_queue_seconds"], 30.0)
        self.assertEqual(gate["median_exec_seconds"], 50.0)
        self.assertEqual((gate["max_load1"], gate["min_mem_available_mb"]), (7.5, 900.0))
        self.assertEqual(result["retry_causes"], [{"name": "new-commit", "count": 1}])
        self.assertEqual(result["reuse"], {"hit": 1, "miss:inputs-changed": 1, "miss:no-prior-pass": 1})
        causes = {row["cause"]: row for row in result["gap_causes"]}
        self.assertEqual(causes["fix-before-retry"]["seconds"], 600.0)
        self.assertEqual(causes["wait:review:coderabbit"]["seconds"], 600.0)
        self.assertNotIn("unattributed", causes)
        self.assertEqual(result["largest_gaps"][0]["before"], "typescript(passed)")
        self.assertEqual(result["waits"]["review:coderabbit"]["median_seconds"], 600.0)
        self.assertEqual(result["waits"]["external-deploy:render"]["total_seconds"], 300.0)
        self.assertEqual(result["sources"][0]["files_changed"], 3)
        self.assertEqual(result["rca"]["repro_attempts"], {"reproduced": 1, "fix-verified": 1})
        bench = result["benchmarks"]
        self.assertEqual(bench["attempts_without_run_id"], 1)
        self.assertEqual(bench["runs"][0]["passed"], 1)
        self.assertEqual(bench["runs"][0]["outcome_classes"], {"passed": 1, "failed": 1})
        self.assertEqual(result["descend"], [{"run_id": "d1", "infra_failed": 2, "scheduled_total": 600}])
        text = "\n".join(DIAGNOSTICS.render_text(result))
        self.assertIn("Rerun causes: new-commit=1", text)
        self.assertIn("typecheck (src/a.ts)", text)
        self.assertIn("fix-before-retry", text)

    def test_events_belong_to_latest_run_on_the_same_branch(self) -> None:
        rows = [
            stage("old", "build", 0, 10),
            stage("new", "build", 200, 210),
            # The event at the next start belongs to new, including the boundary.
            event("deploy", "review-request", "coderabbit", 200),
            event("deploy", "review-arrival", "coderabbit", 400),
            event("deploy", "outcome", "completed", 401),
        ]
        result = DIAGNOSTICS.analyze_ledger(rows)
        self.assertEqual(result["largest_gaps"], [{
            "run_id": "new", "seconds": 190.0, "after": "build(passed)",
            "before": "review-arrival:coderabbit", "cause": "wait:review:coderabbit",
        }])
        self.assertEqual(result["gap_causes"], [{
            "cause": "wait:review:coderabbit", "count": 1, "seconds": 190.0,
        }])

    def test_event_window_is_not_cut_off_by_other_branch(self) -> None:
        rows = [stage("original", "build", 0, 10),
                {**stage("other", "build", 100, 110), "branch": "feat/other"},
                event("deploy", "outcome", "completed", 200),
                event("deploy", "outcome", "outside-window", 10 + 6 * 3600 + 1)]
        result = DIAGNOSTICS.analyze_ledger(rows)
        self.assertEqual([(g["run_id"], g["seconds"]) for g in result["largest_gaps"]],
                         [("original", 190.0)])

    def test_reused_rows_do_not_count_as_failed_or_executed_deploy_calls(self) -> None:
        rows = [
            stage("run-1", "eslint", 0, 10),
            stage("run-1", "eslint", 20, 20, "reused"),
            event("deploy", "outcome", "completed", 30),
        ]
        (turn,) = FACTORY_REVIEW.ledger_deploy_turns(rows)
        stage_calls = [item for item in turn.invocations if "run-deploy-stage" in item.detail]
        self.assertEqual(len(stage_calls), 1)
        self.assertFalse(any(item.is_error for item in stage_calls))

    def test_conductor_parser_accepts_event_detail_arguments(self) -> None:
        self.assertEqual(
            FACTORY_REVIEW.parse_factory_event_command(
                "python3 scripts/record_factory_event.py rca repro-attempt reproduced --detail repro_attempt=2"
            ),
            ("rca", "repro-attempt", "reproduced"),
        )
        self.assertIsNone(
            FACTORY_REVIEW.parse_factory_event_command(
                "python3 scripts/record_factory_event.py deploy outcome completed --detail x=1; rm -rf /"
            )
        )


if __name__ == "__main__":
    unittest.main()
