#!/usr/bin/env python3
"""Regression tests for bounded deploy review cycles."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "deploy_review_cycle", ROOT / "scripts/deploy_review_cycle.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ReviewCycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.state_path = Path(self.temp_dir.name) / "review.json"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def complete(self, head: str, kind: str, result: str, *, reset: bool = False) -> None:
        MODULE.start_cycle(self.state_path, head=head, kind=kind, reset=reset)
        MODULE.finish_cycle(self.state_path, head=head, result=result)

    def test_clean_latest_head_is_mergeable(self) -> None:
        head = "a" * 40
        self.complete(head, "initial", "clean", reset=True)

        cycle = MODULE.require_mergeable(self.state_path, head=head)

        self.assertEqual(cycle["number"], 1)

    def test_unreviewed_head_is_not_mergeable(self) -> None:
        self.complete("a" * 40, "initial", "clean", reset=True)

        with self.assertRaisesRegex(MODULE.ReviewCycleError, "unreviewed"):
            MODULE.require_mergeable(self.state_path, head="b" * 40)

    def test_findings_are_not_mergeable(self) -> None:
        head = "a" * 40
        self.complete(head, "initial", "findings", reset=True)

        with self.assertRaisesRegex(MODULE.ReviewCycleError, "not mergeable"):
            MODULE.require_mergeable(self.state_path, head=head)

    def test_fourth_cycle_is_refused(self) -> None:
        self.complete("a" * 40, "initial", "findings", reset=True)
        self.complete("b" * 40, "incremental", "findings")
        self.complete("c" * 40, "verification", "findings")

        with self.assertRaisesRegex(MODULE.ReviewCycleError, "cap reached"):
            MODULE.start_cycle(
                self.state_path,
                head="d" * 40,
                kind="verification",
            )

    def test_duplicate_or_overlapping_cycle_is_refused(self) -> None:
        head = "a" * 40
        MODULE.start_cycle(self.state_path, head=head, kind="initial", reset=True)
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "still open"):
            MODULE.start_cycle(self.state_path, head="b" * 40, kind="incremental")
        MODULE.finish_cycle(self.state_path, head=head, result="clean")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "exact HEAD"):
            MODULE.start_cycle(self.state_path, head=head, kind="incremental")

    def test_third_cycle_requires_second_cycle_findings(self) -> None:
        self.complete("a" * 40, "initial", "findings", reset=True)
        self.complete("b" * 40, "incremental", "clean")

        with self.assertRaisesRegex(MODULE.ReviewCycleError, "only after cycle two"):
            MODULE.start_cycle(
                self.state_path,
                head="c" * 40,
                kind="verification",
            )


class SyncInheritanceTest(unittest.TestCase):
    """A main-sync-only HEAD may inherit a clean review; anything else may not."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp_dir.name) / "repo"
        self.repo.mkdir()
        self.state_path = Path(self.temp_dir.name) / "review.json"
        self.git("init", "-q", "-b", "main")
        self.write("app.py", "one\n")
        self.write("main_only.py", "a\n")
        self.write("docs/rca/INDEX.md", "index v1\n")
        self.commit("base")
        self.git("checkout", "-q", "-b", "feature")
        self.write("app.py", "one\nfeature\n")
        self.write("docs/rca/INDEX.md", "index v1 + feature case\n")
        self.reviewed = self.commit("feature")
        self.git("checkout", "-q", "main")
        self.write("main_only.py", "a\nmain change\n")
        self.write("docs/rca/INDEX.md", "index v1 + main case\n")
        self.main = self.commit("main moves")
        self.git("checkout", "-q", "feature")
        MODULE.start_cycle(self.state_path, head=self.reviewed, kind="initial", reset=True)
        MODULE.finish_cycle(self.state_path, head=self.reviewed, result="clean")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def git(self, *args: str) -> str:
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@x"}
        return subprocess.run(["git", *args], cwd=self.repo, env=env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def write(self, name: str, text: str) -> None:
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self, message: str) -> str:
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    def sync(self, *, index: str = "index v1 + main case + feature case\n", extra=None) -> str:
        subprocess.run(["git", "merge", "-q", "--no-edit", "main"], cwd=self.repo,
                       capture_output=True, env={**os.environ, "GIT_AUTHOR_NAME": "t",
                       "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t",
                       "GIT_COMMITTER_EMAIL": "t@x"})
        self.write("docs/rca/INDEX.md", index)
        for name, text in (extra or {}).items():
            self.write(name, text)
        return self.commit("Merge main")

    def inherit(self, head: str) -> dict:
        return MODULE.inherit_sync(self.state_path, head=head, base="main", repo=self.repo)

    def test_generated_index_conflict_sync_inherits_and_is_mergeable(self) -> None:
        head = self.sync()
        entry = self.inherit(head)
        self.assertEqual(entry["kind"], "sync-inherited")
        self.assertEqual(entry["inherited_from"], self.reviewed)
        self.assertEqual(entry["generated_changed"], ["docs/rca/INDEX.md"])
        self.assertEqual(MODULE.require_mergeable(self.state_path, head=head)["head"], head)

    def test_resolution_that_edits_branch_code_is_refused(self) -> None:
        head = self.sync(extra={"app.py": "one\nfeature\nsneaked in\n"})
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "differs from the reviewed diff"):
            self.inherit(head)
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "unreviewed"):
            MODULE.require_mergeable(self.state_path, head=head)

    def test_new_non_merge_commit_is_refused(self) -> None:
        self.write("app.py", "one\nfeature\nmore\n")
        head = self.commit("more work")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "not a sync merge"):
            self.inherit(head)

    def test_merging_history_not_on_base_is_refused(self) -> None:
        self.git("checkout", "-q", "-b", "other", self.reviewed + "~1")
        self.write("other.py", "x\n")
        self.commit("other branch")
        self.git("checkout", "-q", "feature")
        self.git("merge", "-q", "--no-edit", "other")
        head = self.git("rev-parse", "HEAD")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "not on main"):
            self.inherit(head)

    def test_findings_review_cannot_be_inherited(self) -> None:
        self.write("app.py", "one\nfeature v2\n")
        second = self.commit("fix")
        MODULE.start_cycle(self.state_path, head=second, kind="incremental")
        MODULE.finish_cycle(self.state_path, head=second, result="findings")
        head = self.sync()
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "nothing clean to inherit"):
            self.inherit(head)

    def test_sync_entries_do_not_consume_review_cycles(self) -> None:
        head = self.sync()
        self.inherit(head)
        self.write("app.py", "one\nfeature v2\n")
        later = self.commit("new code after sync")
        cycle = MODULE.start_cycle(self.state_path, head=later, kind="incremental")
        self.assertEqual(cycle["number"], 2)



HEAD_A = "33d8cfbfed95812de3534a74bee0a0caa36f10fe"
HEAD_B = "f602c1814b6f5fddbbdd71a3f22f6862807ea06c"
HEAD_C = "da2dbd8b14e25c77dcd5d3b0df3fb42e27e7d9ea"
BOT = {"login": "coderabbitai[bot]"}
USER = {"login": "andyprevalsky"}


def review(review_id: int, head: str, body: str, user: dict = BOT) -> dict:
    return {"id": review_id, "user": user, "state": "COMMENTED", "commit_id": head,
            "submitted_at": "2026-10-31T10:15:31Z", "body": body}


def check_run(run_id: int, head: str, conclusion: str, title: str, completed: str) -> dict:
    return {"id": run_id, "name": "CodeRabbit", "head_sha": head, "status": "completed",
            "conclusion": conclusion, "started_at": completed, "completed_at": completed,
            "output": {"title": title, "summary": f"Result: {title}"}}


def issue_comment(comment_id: int, body: str, updated: str, user: dict = BOT) -> dict:
    return {"id": comment_id, "user": user, "body": body,
            "created_at": "2026-10-31T09:06:05Z", "updated_at": updated}


def review_comment(comment_id: int, head: str, body: str, *, user: dict = BOT,
                   reply_to: int | None = None, original: str | None = None) -> dict:
    return {"id": comment_id, "user": user, "body": body, "commit_id": head,
            "original_commit_id": original or head, "in_reply_to_id": reply_to,
            "created_at": "2026-10-31T10:16:53Z"}


# The mutable CodeRabbit overview comment as it read at 09:55:12Z on PR 1656
# (its body was later rewritten to the Findings list; the id survived).
CAP_COMMENT = issue_comment(6541489860, (
    "<!-- coderabbit-ai-generated:v1 -->\n\n## Review limit reached\n\n"
    "Your organization has reached its usage spending cap. Next included review available in 9 minutes.\n\n"
    "<details><summary>Commits</summary>\n\nReviewing files that changed from the base of the PR and between "
    f"{HEAD_A} and {HEAD_C}.\n\n</details>"), "2026-10-31T09:55:12Z")
# "Action not completed — Review rate limited." carries no exhaustion wording.
RATE_LIMIT_COMMENT = issue_comment(6541932795, (
    "<!-- coderabbit-ai-generated:v1 -->\n\n> [!TIP]\n> Action not completed\n> Review rate limited.\n\n"
    "> Note: CodeRabbit is an incremental review system and does not re-review already reviewed commits."),
    "2026-10-31T09:55:15Z")
RATE_LIMITED_CHECK = check_run(124506502581, HEAD_C, "neutral", "Review rate limited", "2026-10-31T09:55:14Z")
FINISHED_CHECK = check_run(124509628134, HEAD_C, "success", "Finished", "2026-10-31T10:15:36Z")
FINDINGS_REVIEW = review(5722311128, HEAD_C,
                         "<!-- coderabbit-ai-generated:v1 -->\n\n**Actionable comments posted: 1**\n\n---\n")
# CodeRabbit's replies to [FIXED] threads arrive as empty-body COMMENTED reviews of the new HEAD.
REPLY_WRAPPERS = [review(5722158877, HEAD_C, ""), review(5722158908, HEAD_C, "")]
FINDING_COMMENT = review_comment(
    4431365241, HEAD_C, "**Major** · Classify transport failures during the response-body read.")
DEFERRED_REPLY = review_comment(4431367989, HEAD_C, "[DEFERRED] Valid; fix lands in deploy/speed-followup-9-body-read",
                                user=USER, reply_to=4431365241)


def evidence(**parts) -> dict:
    base = {"issue_comments": [], "check_runs": [], "reviews": [], "review_comments": []}
    base.update(parts)
    return base


class UnavailableCycleTest(unittest.TestCase):
    """A cycle closed ``unavailable`` consumed no review; the superseding HEAD re-requests its kind.

    PR 1656 (2026-10-31): cycle 2 (incremental, f602c1814) closed unavailable
    when CodeRabbit was rate-limited and a gate fix superseded the HEAD; the
    ledger then refused both ``incremental`` and ``verification`` for
    da2dbd8b1 and forced ``start --reset``, which erased cycles 1-2.
    """

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.state_path = Path(self.temp_dir.name) / "review.json"
        MODULE.start_cycle(self.state_path, head=HEAD_A, kind="initial", reset=True)
        MODULE.finish_cycle(self.state_path, head=HEAD_A, result="findings")
        MODULE.start_cycle(self.state_path, head=HEAD_B, kind="incremental")
        MODULE.finish_cycle(self.state_path, head=HEAD_B, result="unavailable")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def entries(self) -> list:
        return MODULE.read_state(self.state_path)["cycles"]

    def test_superseding_head_re_requests_the_same_kind_without_reset(self) -> None:
        self.assertEqual(MODULE.next_cycle(self.entries()),
                         {"number": 2, "kind": "incremental", "replaces": HEAD_B})
        with self.assertRaisesRegex(MODULE.ReviewCycleError,
                                    r"cycle 2 must be incremental, not verification .*unavailable.*do not --reset"):
            MODULE.start_cycle(self.state_path, head=HEAD_C, kind="verification")
        cycle = MODULE.start_cycle(self.state_path, head=HEAD_C, kind="incremental")
        self.assertEqual((cycle["number"], cycle["replaces"]), (2, HEAD_B))
        heads = [entry["head"] for entry in self.entries()]
        self.assertEqual(heads, [HEAD_A, HEAD_B, HEAD_C], "the unavailable cycle must stay in the ledger")
        MODULE.finish_cycle(self.state_path, head=HEAD_C, result="clean")
        self.assertEqual(MODULE.require_mergeable(self.state_path, head=HEAD_C)["head"], HEAD_C)

    def test_unavailable_cycle_does_not_count_toward_the_cap(self) -> None:
        MODULE.start_cycle(self.state_path, head=HEAD_C, kind="incremental")
        MODULE.finish_cycle(self.state_path, head=HEAD_C, result="findings")
        verification = MODULE.start_cycle(self.state_path, head="d" * 40, kind="verification")
        self.assertEqual(verification["number"], 3)
        MODULE.finish_cycle(self.state_path, head="d" * 40, result="findings")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "cap reached"):
            MODULE.start_cycle(self.state_path, head="e" * 40, kind="verification")
        self.assertEqual(len(self.entries()), 4)

    def test_unavailable_verification_is_replaced_only_after_findings(self) -> None:
        MODULE.start_cycle(self.state_path, head=HEAD_C, kind="incremental")
        MODULE.finish_cycle(self.state_path, head=HEAD_C, result="findings")
        MODULE.start_cycle(self.state_path, head="d" * 40, kind="verification")
        MODULE.finish_cycle(self.state_path, head="d" * 40, result="unavailable")
        self.assertEqual(MODULE.next_cycle(self.entries())["kind"], "verification")
        self.assertEqual(MODULE.start_cycle(self.state_path, head="e" * 40, kind="verification")["number"], 3)

    def test_unavailable_head_is_not_mergeable_and_needs_a_replacement(self) -> None:
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "not mergeable"):
            MODULE.require_mergeable(self.state_path, head=HEAD_B)
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "unreviewed"):
            MODULE.require_mergeable(self.state_path, head=HEAD_C)


class SkipDispositionTest(unittest.TestCase):
    """Step 9a skip: evidence-bound, refuses whenever a substantive review of HEAD exists."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.state_path = root / "review.json"
        self.receipts = root / "dispositions.jsonl"
        MODULE.start_cycle(self.state_path, head=HEAD_C, kind="initial", reset=True)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def skip(self, data: dict, **kwargs) -> dict:
        normalized = MODULE.normalize_evidence(data, source="test")
        return MODULE.skip_cycle(self.state_path, head=HEAD_C, pr="1656", reason="usage-cap",
                                 evidence=normalized, receipts_path=self.receipts, **kwargs)

    def test_rate_limited_without_cap_wording_is_refused(self) -> None:
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "not usage exhaustion"):
            self.skip(evidence(issue_comments=[RATE_LIMIT_COMMENT], check_runs=[RATE_LIMITED_CHECK]))
        self.assertEqual(MODULE.read_state(self.state_path)["cycles"][-1]["status"], "open")
        self.assertFalse(self.receipts.exists())

    def test_cap_comment_must_name_the_head(self) -> None:
        other = dict(CAP_COMMENT, body=CAP_COMMENT["body"].replace(HEAD_C, "b" * 40))
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "no CodeRabbit comment names"):
            self.skip(evidence(issue_comments=[other], check_runs=[RATE_LIMITED_CHECK]))

    def test_substantive_review_with_findings_refuses_the_skip(self) -> None:
        with self.assertRaisesRegex(MODULE.ReviewCycleError,
                                    r"substantive CodeRabbit review exists .*5722311128 \(1\)"):
            self.skip(evidence(issue_comments=[CAP_COMMENT], check_runs=[RATE_LIMITED_CHECK, FINISHED_CHECK],
                               reviews=REPLY_WRAPPERS + [FINDINGS_REVIEW]))

    def test_clean_substantive_review_refuses_the_skip(self) -> None:
        clean = review(5722999999, HEAD_C, "**Actionable comments posted: 0**\n\nLGTM")
        with self.assertRaisesRegex(MODULE.ReviewCycleError,
                                    r"substantive CodeRabbit review exists .*5722999999 \(0\)"):
            self.skip(evidence(issue_comments=[CAP_COMMENT], check_runs=[RATE_LIMITED_CHECK], reviews=[clean]))

    def test_successful_check_without_review_is_not_exhaustion(self) -> None:
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "succeeded"):
            self.skip(evidence(issue_comments=[CAP_COMMENT], check_runs=[RATE_LIMITED_CHECK, FINISHED_CHECK]))

    def test_reply_wrapper_reviews_do_not_count_and_skip_records_evidence(self) -> None:
        other_head_review = review(5722119337, HEAD_A, "**Actionable comments posted: 2**")
        cycle = self.skip(evidence(issue_comments=[RATE_LIMIT_COMMENT, CAP_COMMENT],
                                   check_runs=[RATE_LIMITED_CHECK],
                                   reviews=[other_head_review] + REPLY_WRAPPERS))
        self.assertEqual((cycle["status"], cycle["result"], cycle["disposition"]),
                         ("completed", "clean", "skipped"))
        self.assertEqual(cycle["evidence"]["issue_comment_id"], 6541489860)
        self.assertEqual(cycle["evidence"]["issue_comment_updated_at"], "2026-10-31T09:55:12Z")
        self.assertEqual(cycle["evidence"]["check_run_id"], 124506502581)
        self.assertEqual(cycle["evidence"]["non_substantive_review_ids"], [5722158877, 5722158908])
        self.assertEqual(cycle["evidence"]["quote"],
                         "Review limit reached — Your organization has reached its usage spending cap. "
                         "Next included review available in 9 minutes.")
        row = cycle["report_row"]
        self.assertTrue(row.startswith("Code Review | ⚠️ Skipped | reviewers usage-exhausted (CodeRabbit: "), row)
        self.assertIn("issue comment 6541489860 updated 2026-10-31T09:55:12Z naming commit da2dbd8b1", row)
        self.assertIn("check run 124506502581 neutral 'Review rate limited'; Claude fallback disabled)", row)
        self.assertEqual(MODULE.require_mergeable(self.state_path, head=HEAD_C)["disposition"], "skipped")
        receipts = [json.loads(line) for line in self.receipts.read_text().splitlines()]
        self.assertEqual([(r["pr"], r["head"], r["disposition"]) for r in receipts], [("1656", HEAD_C, "skipped")])
        self.assertEqual(receipts[0]["report_row"], row)
        self.assertEqual(receipts[0]["evidence"]["issue_comment_id"], 6541489860)

    def test_skip_needs_an_open_cycle_on_that_head(self) -> None:
        MODULE.finish_cycle(self.state_path, head=HEAD_C, result="findings")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "no review cycle is open"):
            self.skip(evidence(issue_comments=[CAP_COMMENT], check_runs=[RATE_LIMITED_CHECK]))


class OverrideDispositionTest(unittest.TestCase):
    """Standing three-round deferral: finding ids, replies and the target are required."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.state_path = root / "review.json"
        self.receipts = root / "dispositions.jsonl"
        MODULE.start_cycle(self.state_path, head=HEAD_A, kind="initial", reset=True)
        MODULE.finish_cycle(self.state_path, head=HEAD_A, result="findings")
        MODULE.start_cycle(self.state_path, head=HEAD_B, kind="incremental")
        MODULE.finish_cycle(self.state_path, head=HEAD_B, result="unavailable")
        MODULE.start_cycle(self.state_path, head=HEAD_C, kind="incremental")
        self.data = evidence(check_runs=[RATE_LIMITED_CHECK, FINISHED_CHECK],
                             reviews=REPLY_WRAPPERS + [FINDINGS_REVIEW],
                             review_comments=[FINDING_COMMENT, DEFERRED_REPLY])

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def override(self, data: dict, *, ids=(4431365241,), prior_rounds: int = 0,
                 target: str = "deploy/speed-followup-9-body-read") -> dict:
        normalized = MODULE.normalize_evidence(data, source="test")
        return MODULE.override_cycle(self.state_path, head=HEAD_C, pr="1656", finding_ids=list(ids),
                                     deferred_to=target, evidence=normalized, prior_rounds=prior_rounds,
                                     receipts_path=self.receipts)

    def test_override_records_findings_target_and_rounds(self) -> None:
        cycle = self.override(self.data)
        self.assertEqual((cycle["result"], cycle["disposition"], cycle["rounds"]),
                         ("clean", "overridden", 3))
        self.assertEqual(cycle["finding_ids"], [4431365241])
        self.assertEqual(cycle["evidence"]["review_id"], 5722311128)
        self.assertEqual(cycle["evidence"]["findings"], [{"id": 4431365241, "reply_id": 4431367989}])
        row = cycle["report_row"]
        self.assertTrue(
            row.startswith("Code Review | ⚠️ Overridden | CodeRabbit review 5722311128 on da2dbd8b1"), row)
        self.assertIn("finding(s) 4431365241 deferred to deploy/speed-followup-9-body-read", row)
        self.assertIn("rounds=3); ledger result clean", row)
        self.assertEqual(MODULE.require_mergeable(self.state_path, head=HEAD_C)["disposition"], "overridden")
        receipt = json.loads(self.receipts.read_text().splitlines()[-1])
        self.assertEqual((receipt["disposition"], receipt["deferred_to"]),
                         ("overridden", "deploy/speed-followup-9-body-read"))

    def test_override_requires_three_rounds_counting_prior_deploys(self) -> None:
        MODULE.start_cycle(self.state_path, head=HEAD_A, kind="initial", reset=True)
        with self.assertRaisesRegex(MODULE.ReviewCycleError,
                                    "only after 3 review rounds; this ledger records 1"):
            MODULE.override_cycle(self.state_path, head=HEAD_A, pr="1656", finding_ids=[1],
                                  deferred_to="x", evidence=MODULE.normalize_evidence(self.data, source="t"),
                                  prior_rounds=0, receipts_path=self.receipts)
        # Two earlier deploys of the same PR satisfy the round count; the next gate then applies.
        with self.assertRaisesRegex(MODULE.ReviewCycleError,
                                    "no substantive CodeRabbit review on 33d8cfbfed95"):
            MODULE.override_cycle(self.state_path, head=HEAD_A, pr="1656", finding_ids=[1],
                                  deferred_to="x", evidence=MODULE.normalize_evidence(self.data, source="t"),
                                  prior_rounds=2, receipts_path=self.receipts)

    def test_override_requires_a_deferred_or_fixed_reply_on_each_finding(self) -> None:
        unanswered = dict(self.data, review_comments=[FINDING_COMMENT])
        with self.assertRaisesRegex(MODULE.ReviewCycleError,
                                    r"finding 4431365241 has no \[DEFERRED\]/\[FIXED\] reply"):
            self.override(unanswered)
        wrong_reply = dict(self.data,
                           review_comments=[FINDING_COMMENT, dict(DEFERRED_REPLY, body="will look later")])
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "has no"):
            self.override(wrong_reply)
        self.assertEqual(MODULE.read_state(self.state_path)["cycles"][-1]["status"], "open")

    def test_override_refuses_an_unlisted_unanswered_finding(self) -> None:
        second = review_comment(4431365300, HEAD_C, "**Minor** · another finding")
        with self.assertRaisesRegex(MODULE.ReviewCycleError,
                                    "comment 4431365300 on da2dbd8b14e2 is neither listed nor answered"):
            self.override(dict(self.data, review_comments=[FINDING_COMMENT, DEFERRED_REPLY, second]))
        fixed = review_comment(4431365301, HEAD_C, "[FIXED] in abc", user=USER, reply_to=4431365300)
        self.override(dict(self.data, review_comments=[FINDING_COMMENT, DEFERRED_REPLY, second, fixed]))

    def test_override_needs_a_substantive_review_and_a_target(self) -> None:
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "no substantive CodeRabbit review"):
            self.override(dict(self.data, reviews=REPLY_WRAPPERS))
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "--deferred-to"):
            self.override(self.data, target="  ")
        with self.assertRaisesRegex(MODULE.ReviewCycleError,
                                    "finding 1 is not a CodeRabbit review comment on da2dbd8b14e2"):
            self.override(self.data, ids=(4431365241, 1))


class DispositionCliTest(unittest.TestCase):
    """The CLI prints the TEST_REPORT row, then JSON; evidence comes from a file or from gh."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.state_path = self.root / ".context" / "deploy-review-cycle.json"
        MODULE.start_cycle(self.state_path, head=HEAD_C, kind="initial", reset=True)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def run_cli(self, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(ROOT / "scripts/deploy_review_cycle.py"), "--state", str(self.state_path), *args],
            capture_output=True, text=True, check=False, env=env or os.environ.copy(),
        )

    def test_skip_from_evidence_file_prints_row_then_json_and_writes_default_receipt(self) -> None:
        evidence_path = self.root / "evidence.json"
        evidence_path.write_text(json.dumps(evidence(
            issue_comments=[CAP_COMMENT], check_runs=[RATE_LIMITED_CHECK], reviews=REPLY_WRAPPERS)))
        result = self.run_cli("skip", "--head", HEAD_C, "--pr", "1656", "--reason", "usage-cap",
                              "--evidence-json", str(evidence_path))
        self.assertEqual(result.returncode, 0, result.stderr)
        row, payload = result.stdout.splitlines()
        self.assertTrue(row.startswith("Code Review | ⚠️ Skipped | "), row)
        self.assertEqual(json.loads(payload)["disposition"], "skipped")
        receipts = self.state_path.with_name("deploy-review-dispositions.jsonl")
        self.assertEqual(json.loads(receipts.read_text())["head"], HEAD_C)
        self.assertEqual(self.run_cli("require-mergeable", "--head", HEAD_C).returncode, 0)

    def test_refusal_exits_nonzero_and_leaves_the_cycle_open(self) -> None:
        evidence_path = self.root / "evidence.json"
        evidence_path.write_text(json.dumps(evidence(
            issue_comments=[RATE_LIMIT_COMMENT], check_runs=[RATE_LIMITED_CHECK])))
        result = self.run_cli("skip", "--head", HEAD_C, "--pr", "1656", "--reason", "usage-cap",
                              "--evidence-json", str(evidence_path))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not usage exhaustion", result.stderr)
        self.assertEqual(MODULE.read_state(self.state_path)["cycles"][-1]["status"], "open")

    def test_skip_fetches_evidence_through_gh_when_no_file_is_given(self) -> None:
        fixtures = self.root / "gh-fixtures"
        fixtures.mkdir()
        (fixtures / "issue_comments.json").write_text(json.dumps([RATE_LIMIT_COMMENT, CAP_COMMENT]))
        (fixtures / "check_runs.json").write_text(
            json.dumps({"total_count": 1, "check_runs": [RATE_LIMITED_CHECK]}))
        (fixtures / "reviews.json").write_text(json.dumps(REPLY_WRAPPERS))
        (fixtures / "review_comments.json").write_text(json.dumps([]))
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        fake_gh = bin_dir / "gh"
        fake_gh.write_text(f"""#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "{fixtures}/calls.log"
case "$*" in
  "repo view --json nameWithOwner") echo '{{"nameWithOwner":"acme/rose"}}' ;;
  "api repos/acme/rose/issues/1656/comments?per_page=100&page=1") cat "{fixtures}/issue_comments.json" ;;
  "api repos/acme/rose/commits/{HEAD_C}/check-runs?per_page=100") cat "{fixtures}/check_runs.json" ;;
  "api repos/acme/rose/pulls/1656/reviews?per_page=100&page=1") cat "{fixtures}/reviews.json" ;;
  "api repos/acme/rose/pulls/1656/comments?per_page=100&page=1") cat "{fixtures}/review_comments.json" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
""")
        fake_gh.chmod(0o755)
        env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"}
        result = self.run_cli("skip", "--head", HEAD_C, "--pr", "1656", "--reason", "usage-cap", env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.splitlines()[1])
        self.assertEqual(payload["evidence"]["source"], "gh:acme/rose")
        self.assertEqual(payload["evidence"]["issue_comment_id"], 6541489860)
        calls = (fixtures / "calls.log").read_text().splitlines()
        self.assertEqual(len(calls), 5, calls)

    def test_next_reports_the_replacement_kind(self) -> None:
        MODULE.finish_cycle(self.state_path, head=HEAD_C, result="unavailable")
        result = self.run_cli("next")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"number": 1, "kind": "initial", "replaces": HEAD_C})

    def test_deploy_step10_derives_the_kind_from_next(self) -> None:
        """deploy.md Step 10 must take the kind from ``next``: a count of ledger
        entries says ``verification`` after [findings, unavailable], which the
        ledger refuses for the superseding HEAD (PR 1656, 2026-10-31)."""
        deploy_md = (ROOT / ".claude" / "commands" / "deploy.md").read_text()
        step10 = deploy_md.split("## Step 10: Handle review results", 1)[1].split("\n# Phase 3", 1)[0]
        self.assertIn("REVIEW_NEXT=$(python3 scripts/deploy_review_cycle.py next)", step10)
        self.assertNotIn('len(json.load(sys.stdin)["cycles"])', step10)
        derivation = step10.split("REVIEW_NEXT=", 1)[1]
        derivation = "REVIEW_NEXT=" + derivation.split("python3 scripts/deploy_review_cycle.py start", 1)[0]
        derivation = derivation.replace("{\n", "{ exit 9\n", 1)  # never run the blocked branch here
        MODULE.finish_cycle(self.state_path, head=HEAD_C, result="findings")
        MODULE.start_cycle(self.state_path, head="b" * 40, kind="incremental")
        MODULE.finish_cycle(self.state_path, head="b" * 40, result="unavailable")
        cwd = self.root / "step10"
        (cwd / ".context").mkdir(parents=True)
        (cwd / "scripts").symlink_to(ROOT / "scripts")
        (cwd / ".context" / "deploy-review-cycle.json").write_bytes(self.state_path.read_bytes())
        result = subprocess.run(["bash", "-c", derivation + 'printf %s "$REVIEW_KIND"'], cwd=cwd,
                                capture_output=True, text=True, check=False)
        self.assertEqual((result.returncode, result.stdout), (0, "incremental"), result.stderr)

if __name__ == "__main__":
    unittest.main()
