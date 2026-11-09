#!/usr/bin/env python3
"""Regression tests for bounded deploy review cycles."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch


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


class SyncRepoFixture(unittest.TestCase):
    """A feature branch with one clean reviewed HEAD and a moved main (no tests of its own)."""

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


class SyncInheritanceTest(SyncRepoFixture):
    """A main-sync-only HEAD may inherit a clean review; anything else may not."""

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


class PostCapUnreviewedTest(SyncRepoFixture):
    """After three delivered rounds and the cap, later changes are recorded as merged unreviewed."""

    def setUp(self) -> None:
        super().setUp()
        # Replace the inherited clean initial cycle with three delivered rounds ending clean.
        self.state_path.unlink()
        heads = [self.reviewed]
        for text in ("one\nfeature v2\n", "one\nfeature v3\n"):
            self.write("app.py", text)
            heads.append(self.commit("fix"))
        for kind, head, result in (("initial", heads[0], "findings"), ("incremental", heads[1], "findings"),
                                   ("verification", heads[2], "clean")):
            MODULE.start_cycle(self.state_path, head=head, kind=kind, reset=kind == "initial")
            MODULE.finish_cycle(self.state_path, head=head, result=result)
        self.final = heads[2]

    def record(self, head: str) -> dict:
        return MODULE.post_cap_unreviewed(self.state_path, head=head, base="main", repo=self.repo,
                                          reason="user pre-authorization: skip review after 3 rounds")

    def test_conflicting_sync_and_later_commit_are_recorded_unreviewed_and_mergeable(self) -> None:
        head = self.sync(extra={"app.py": "one\nfeature v3\nresolved with main\n"})
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "post-cap-unreviewed"):
            self.inherit(head)
        self.write("tool.py", "x\n")
        later = self.commit("tooling after the cap")
        entry = self.record(later)
        self.assertEqual((entry["kind"], entry["disposition"], entry["inherited_from"]),
                         ("post-cap-unreviewed", "unreviewed", self.final))
        self.assertIn("app.py", entry["changed_files"])
        self.assertIn("tool.py", entry["changed_files"])
        self.assertIn("merged unreviewed", entry["report_row"])
        self.assertEqual(MODULE.require_mergeable(self.state_path, head=later)["head"], later)
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "cap reached"):
            MODULE.next_cycle(MODULE.read_state(self.state_path)["cycles"])

    def test_refused_before_the_cap_or_with_open_findings(self) -> None:
        state = MODULE.read_state(self.state_path)
        state["cycles"][-1]["result"] = "findings"
        MODULE.write_state(self.state_path, state)
        head = self.sync()
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "override"):
            self.record(head)
        state["cycles"] = state["cycles"][:1]
        state["cycles"][0]["result"] = "clean"
        MODULE.write_state(self.state_path, state)
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "cap is not reached"):
            self.record(head)

    def test_quota_skips_are_not_delivered_rounds(self) -> None:
        state = MODULE.read_state(self.state_path)
        state["cycles"][0].update(result="clean", disposition="skipped", skip_reason="usage-cap")
        MODULE.write_state(self.state_path, state)
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "cap is not reached"):
            self.record(self.sync())

    def test_reason_is_required(self) -> None:
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "--reason"):
            MODULE.post_cap_unreviewed(self.state_path, head=self.sync(), base="main", repo=self.repo, reason=" ")


class ApprovedFinalVerificationTest(unittest.TestCase):
    setUp = ReviewCycleTest.setUp
    tearDown = ReviewCycleTest.tearDown
    complete = ReviewCycleTest.complete
    def prepared(self):
        self.complete("a" * 40, "initial", "clean", reset=True)
        self.complete("b" * 40, "incremental", "clean")
        return MODULE.read_state(self.state_path)["cycles"].copy()

    def test_explicit_admission_preserves_history_and_does_not_finish_review(self):
        old = self.prepared()
        MODULE.start_cycle(self.state_path, head="c" * 40, kind="verification",
                           verification_approval="PR1634-REVIEW-ADMISSION")
        state = MODULE.read_state(self.state_path)
        self.assertEqual(state["cycles"][:2], old)
        self.assertEqual(state["cycles"][2]["verification_approval"], "PR1634-REVIEW-ADMISSION")
        with self.assertRaises(MODULE.ReviewCycleError):
            MODULE.require_mergeable(self.state_path, head="c" * 40)
        with self.assertRaises(MODULE.ReviewCycleError):
            MODULE.finish_cycle(self.state_path, head="d" * 40, result="clean")
        MODULE.finish_cycle(self.state_path, head="c" * 40, result="clean")
        MODULE.require_mergeable(self.state_path, head="c" * 40)
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "cap reached"):
            MODULE.start_cycle(self.state_path, head="d" * 40, kind="verification",
                               verification_approval="PR1634-REVIEW-ADMISSION")

    def test_approval_is_not_a_findings_waiver(self):
        self.prepared()
        MODULE.start_cycle(self.state_path, head="c" * 40, kind="verification",
                           verification_approval="PR1634-REVIEW-ADMISSION")
        MODULE.finish_cycle(self.state_path, head="c" * 40, result="findings")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "not mergeable"):
            MODULE.require_mergeable(self.state_path, head="c" * 40)

    def test_approval_is_only_valid_at_the_exact_final_boundary(self):
        with self.assertRaises(MODULE.ReviewCycleError):
            MODULE.start_cycle(self.state_path, head="a" * 40, kind="initial", reset=True,
                               verification_approval="PR1634-REVIEW-ADMISSION")
        self.prepared()
        for ref in ("", "approval with spaces", "a" * 129):
            with self.assertRaises(MODULE.ReviewCycleError):
                MODULE.start_cycle(self.state_path, head="c" * 40, kind="verification",
                                   verification_approval=ref)
        self.assertEqual(len(MODULE.read_state(self.state_path)["cycles"]), 2)




class NoReviewablePathsTest(unittest.TestCase):
    """A HEAD whose changed paths CodeRabbit's committed path filters all exclude spends no review request."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp_dir.name) / "repo"
        self.repo.mkdir()
        self.state_path = Path(self.temp_dir.name) / ".context" / "deploy-review-cycle.json"
        self.receipts = self.state_path.with_name(MODULE.RECEIPTS_NAME)
        self.git("init", "-q", "-b", "main")
        # The real config: the canonical filters must stay parseable by the ledger.
        self.write(".coderabbit.yaml", (ROOT / ".coderabbit.yaml").read_text())
        self.write("scripts/tool.py", "one\n")
        self.write("scripts/tests/tool.test.py", "t1\n")
        self.commit("base")
        self.git("checkout", "-q", "-b", "feature")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    git = SyncInheritanceTest.git
    write = SyncInheritanceTest.write
    commit = SyncInheritanceTest.commit

    def record(self, head: str, **kwargs) -> dict:
        return MODULE.record_no_reviewable_paths(
            self.state_path, head=head, repo=self.repo, receipts_path=self.receipts, **kwargs)

    def reviewed(self, result: str = "clean") -> str:
        self.write("scripts/tool.py", "one\nfeature\n")
        head = self.commit("feature")
        MODULE.start_cycle(self.state_path, head=head, kind="initial", reset=True)
        MODULE.finish_cycle(self.state_path, head=head, result=result)
        return head

    def test_canonical_filters_exclude_tests_ledgers_and_docs_but_not_code(self) -> None:
        include, exclude, _ = MODULE.path_filters(self.repo, "HEAD")
        for name in ("scripts/tests/deploy-cli.test.py", "agents/tests/unit/test_x.py",
                     "agents/benchmarks/history/task_attempts.jsonl", "docs/plans/a.md", "README.md",
                     ".claude/commands/deploy.md", "back-end/src/x.blackbox.ts", "agents/x/__init__.py",
                     "agents/config.py", "front-end/package-lock.json"):
            self.assertFalse(MODULE.is_reviewable(name, include, exclude), name)
        for name in ("scripts/deploy_cli.py", "agents/tools/x.py", "back-end/src/server.ts",
                     "agents/tests/browser_tilion.blackbox.py", "agents/x/browser_tilion.blackbox.py",
                     "agents/tests/BROWSER_TILION.blackbox.py", "agents/x/Browser_Tilion.blackbox.py",
                     ".github/workflows/deploy.yml", ".github/notes.md"):
            self.assertTrue(MODULE.is_reviewable(name, include, exclude), name)

    def test_a_negated_extglob_in_a_middle_segment_stops_at_that_segment(self) -> None:
        middle = MODULE.glob_regex("a/!(b)/c.py")
        self.assertIsNone(middle.match("a/b/c.py"))
        self.assertIsNotNone(middle.match("a/x/c.py"))
        self.assertIsNotNone(middle.match("a/bb/c.py"))
        include, exclude, _ = MODULE.path_filters(self.repo, "HEAD")
        self.assertTrue(MODULE.is_reviewable("docs/handoffs/note.txt", include, exclude))
        self.assertFalse(MODULE.is_reviewable("docs/plans/note.txt", include, exclude))

    def test_unsupported_glob_syntax_refuses_rather_than_guessing(self) -> None:
        for pattern in ("src/{a,b}/**", "**/[ab].py", "+(a).py", "a//b", ""):
            with self.subTest(pattern=pattern), self.assertRaises(MODULE.ReviewCycleError):
                MODULE.glob_regex(pattern)

    def test_tests_only_batch_after_a_clean_review_is_recorded_without_spending_a_cycle(self) -> None:
        first = self.reviewed()
        self.write("scripts/tests/tool.test.py", "t2\n")
        self.write("agents/benchmarks/history/task_attempts.jsonl", "{}\n")
        head = self.commit("ledger rows and a test")
        entry = self.record(head, pr="7")
        self.assertEqual((entry["kind"], entry["result"], entry["inherited_from"]),
                         ("no-reviewable-paths", "clean", first))
        self.assertEqual(entry["changed_paths"],
                         ["agents/benchmarks/history/task_attempts.jsonl", "scripts/tests/tool.test.py"])
        self.assertIn("No reviewable paths", entry["report_row"])
        self.assertEqual(MODULE.require_mergeable(self.state_path, head=head)["head"], head)
        entries = MODULE.read_state(self.state_path)["cycles"]
        self.assertEqual(MODULE.next_cycle(entries)["number"], 2, "no review budget consumed")
        receipt = json.loads(self.receipts.read_text().splitlines()[-1])
        self.assertEqual((receipt["pr"], receipt["head"], receipt["disposition"]), ("7", head, "no-reviewable-paths"))
        self.write("scripts/tool.py", "one\nfeature\nmore\n")
        later = self.commit("real code")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "1 reviewable path"):
            self.record(later)
        self.assertEqual(MODULE.start_cycle(self.state_path, head=later, kind="incremental")["number"], 2)

    def test_first_head_of_a_tests_only_branch_needs_no_initial_request(self) -> None:
        self.write("scripts/tests/tool.test.py", "t2\n")
        self.write("docs/plans/active/x.md", "plan\n")
        head = self.commit("tests only")
        entry = self.record(head, reset=True, base="main")
        self.assertIsNone(entry["inherited_from"])
        MODULE.require_mergeable(self.state_path, head=head)
        self.assertEqual(MODULE.next_cycle(MODULE.read_state(self.state_path)["cycles"])["kind"], "initial")

    def test_reviewable_or_unsafe_changes_request_the_review(self) -> None:
        self.write("scripts/tool.py", "one\ncode\n")
        head = self.commit("code")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "reviewable path.*scripts/tool.py"):
            self.record(head, reset=True, base="main")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "needs --base"):
            self.record(head, reset=True)
        self.assertFalse(self.state_path.exists(), "a refusal records nothing")
        self.reviewed()
        cases = {
            "config": ({".coderabbit.yaml": "reviews:\n  path_filters:\n    - '!**'\n"}, "coderabbit.yaml changed"),
            "tilion": ({"agents/tests/browser_tilion.blackbox.py": "x\n"}, "reviewable path"),
        }
        base = self.git("rev-parse", "HEAD")
        for name, (files, message) in cases.items():
            with self.subTest(name=name):
                self.git("checkout", "-q", "-B", f"case-{name}", base)
                for path, text in files.items():
                    self.write(path, text)
                with self.assertRaisesRegex(MODULE.ReviewCycleError, message):
                    self.record(self.commit(name))
        self.git("checkout", "-q", "-B", "case-rename", base)
        self.git("mv", "scripts/tool.py", "scripts/tests/tool_moved.test.py")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "scripts/tool.py"):
            self.record(self.commit("move code into an excluded path"))
        self.git("checkout", "-q", "-B", "case-unrelated", "main")
        self.write("docs/x.md", "x\n")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "not an ancestor"):
            self.record(self.commit("unrelated history"))
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "already the latest"):
            self.record(base)

    def test_findings_or_an_open_cycle_are_never_carried(self) -> None:
        self.reviewed(result="findings")
        self.write("docs/x.md", "x\n")
        head = self.commit("docs")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "findings need a review cycle"):
            self.record(head)
        MODULE.start_cycle(self.state_path, head=head, kind="incremental")
        self.write("docs/y.md", "y\n")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "still open"):
            self.record(self.commit("more docs"))

    def test_after_the_cap_an_excluded_only_batch_still_merges_without_an_override(self) -> None:
        for index, (kind, result) in enumerate((("initial", "clean"), ("incremental", "findings"),
                                                ("verification", "clean"))):
            self.write("scripts/tool.py", f"v{index}\n")
            head = self.commit(f"cycle {index}")
            MODULE.start_cycle(self.state_path, head=head, kind=kind, reset=index == 0)
            MODULE.finish_cycle(self.state_path, head=head, result=result)
        self.write("scripts/tests/tool.test.py", "after cap\n")
        head = self.commit("test fix")
        self.record(head)
        MODULE.require_mergeable(self.state_path, head=head)

    def test_cli_prints_the_row_then_json_and_refusals_exit_nonzero(self) -> None:
        self.write("docs/x.md", "x\n")
        head = self.commit("docs")
        argv = [sys.executable, str(ROOT / "scripts/deploy_review_cycle.py"), "--state", str(self.state_path),
                "no-reviewable-paths", "--head", head, "--reset", "--base", "main", "--pr", "9"]
        result = subprocess.run(argv, cwd=self.repo, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        row, payload = result.stdout.splitlines()
        self.assertTrue(row.startswith("Code Review | ➖ No reviewable paths | 1 changed path(s)"), row)
        self.assertEqual(json.loads(payload)["head"], head)
        self.write("scripts/tool.py", "code\n")
        argv[argv.index(head)] = self.commit("code")
        refused = subprocess.run(argv, cwd=self.repo, capture_output=True, text=True, check=False)
        self.assertEqual((refused.returncode, refused.stdout), (1, ""))
        self.assertIn("reviewable path(s): scripts/tool.py", refused.stderr)


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

    def test_quota_skip_preserves_history_without_consuming_a_delivered_review(self) -> None:
        MODULE.start_cycle(self.state_path, head=HEAD_A, kind="initial", reset=True)
        MODULE.finish_cycle(self.state_path, head=HEAD_A, result="clean")
        MODULE.start_cycle(self.state_path, head=HEAD_C, kind="incremental")
        self.skip(evidence(issue_comments=[CAP_COMMENT], check_runs=[RATE_LIMITED_CHECK]))
        before = MODULE.read_state(self.state_path)["cycles"]
        self.assertEqual(MODULE.next_cycle(before)["kind"], "incremental")
        self.assertEqual(len(MODULE.budget_cycles(before)), 1)
        next_head = "e" * 40
        cycle = MODULE.start_cycle(self.state_path, head=next_head, kind="incremental")
        self.assertEqual(cycle["number"], 2)
        after = MODULE.read_state(self.state_path)["cycles"]
        self.assertEqual(after[:-1], before, "the unavailable outcome and evidence must remain immutable")
        self.assertEqual(after[1]["disposition"], "skipped")
        with self.assertRaises(MODULE.ReviewCycleError):
            MODULE.require_mergeable(self.state_path, head=next_head)
        # The replacement still needs fresh exact-HEAD evidence; old quota evidence never passes it.
        normalized = MODULE.normalize_evidence(evidence(issue_comments=[CAP_COMMENT], check_runs=[RATE_LIMITED_CHECK]), source="test")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "no CodeRabbit comment names"):
            MODULE.skip_cycle(self.state_path, head=next_head, pr="1656", reason="usage-cap",
                              evidence=normalized, receipts_path=self.receipts)

    def test_quota_skip_does_not_authorize_three_round_finding_deferral(self) -> None:
        self.skip(evidence(issue_comments=[CAP_COMMENT], check_runs=[RATE_LIMITED_CHECK]))
        entries = MODULE.read_state(self.state_path)["cycles"]
        self.assertEqual(len(MODULE.budget_cycles(entries)), 0)
        self.assertEqual(MODULE.require_mergeable(self.state_path, head=HEAD_C)["disposition"], "skipped")
        self.assertEqual(MODULE.next_cycle(entries)["kind"], "initial")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "exact HEAD"):
            MODULE.start_cycle(self.state_path, head=HEAD_C, kind="initial")

    def test_skip_needs_an_open_cycle_on_that_head(self) -> None:
        MODULE.finish_cycle(self.state_path, head=HEAD_C, result="findings")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "no review cycle is open"):
            self.skip(evidence(issue_comments=[CAP_COMMENT], check_runs=[RATE_LIMITED_CHECK]))

    def test_usage_cap_skip_preserves_history_without_consuming_a_review_round(self) -> None:
        self.skip(evidence(issue_comments=[CAP_COMMENT], check_runs=[RATE_LIMITED_CHECK]))
        self.assertEqual("skipped", MODULE.require_mergeable(self.state_path, head=HEAD_C)["disposition"])
        self.assertEqual({"number": 1, "kind": "initial", "replaces": None},
                         MODULE.next_cycle(MODULE.read_state(self.state_path)["cycles"]))
        next_head = "d" * 40
        cycle = MODULE.start_cycle(self.state_path, head=next_head, kind="initial")
        self.assertEqual(1, cycle["number"])
        self.assertEqual(2, len(MODULE.read_state(self.state_path)["cycles"]))
        self.assertEqual("skipped", MODULE.read_state(self.state_path)["cycles"][0]["disposition"])
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "still open"):
            MODULE.require_mergeable(self.state_path, head=next_head)
        second = MODULE.normalize_evidence(evidence(
            issue_comments=[{**CAP_COMMENT, "body": CAP_COMMENT["body"].replace(HEAD_C, next_head)}],
            check_runs=[{**RATE_LIMITED_CHECK, "head_sha": next_head}]), source="test")
        MODULE.skip_cycle(self.state_path, head=next_head, pr="1656", reason="usage-cap",
                          evidence=second, receipts_path=self.receipts)
        self.assertEqual({"number": 1, "kind": "initial", "replaces": None},
                         MODULE.next_cycle(MODULE.read_state(self.state_path)["cycles"]))
        self.assertEqual(1, MODULE.start_cycle(self.state_path, head="e" * 40, kind="initial")["number"])
        self.assertEqual(3, len(MODULE.read_state(self.state_path)["cycles"]))


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

    def test_unavailable_cycle_is_not_a_review_round(self) -> None:
        # findings + unavailable + open-with-review = two delivered reviews: the unavailable cycle
        # consumed no review budget and must not count toward the three-round pre-authorization.
        with self.assertRaises(MODULE.ReviewCycleError) as raised:
            self.override(self.data)
        self.assertIn("this ledger records 2", str(raised.exception))

    def test_quota_skipped_clean_cycles_do_not_count_as_delivered_rounds(self) -> None:
        state = MODULE.read_state(self.state_path)
        first = state["cycles"][0]
        first.update(result="clean", disposition="skipped", skip_reason="usage-cap")
        state["cycles"][1].update(result="clean", disposition="skipped", skip_reason="usage-cap")
        MODULE.write_state(self.state_path, state)
        before = self.state_path.read_bytes()
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "this ledger records 1"):
            self.override(self.data, prior_rounds=0)
        self.assertEqual(self.state_path.read_bytes(), before, "rejection must preserve ledger/history")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "this ledger records 2"):
            self.override(self.data, prior_rounds=1)
        cycle = self.override(self.data, prior_rounds=2)
        self.assertEqual(cycle["rounds"], 3)
        self.assertEqual(MODULE.read_state(self.state_path)["cycles"][0], first)

    def test_override_records_findings_target_and_rounds(self) -> None:
        cycle = self.override(self.data, prior_rounds=1)
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
            self.override(unanswered, prior_rounds=1)
        wrong_reply = dict(self.data,
                           review_comments=[FINDING_COMMENT, dict(DEFERRED_REPLY, body="will look later")])
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "has no"):
            self.override(wrong_reply, prior_rounds=1)
        self.assertEqual(MODULE.read_state(self.state_path)["cycles"][-1]["status"], "open")

    def test_override_refuses_an_unlisted_unanswered_finding(self) -> None:
        second = review_comment(4431365300, HEAD_C, "**Minor** · another finding")
        with self.assertRaisesRegex(MODULE.ReviewCycleError,
                                    "comment 4431365300 on da2dbd8b14e2 is neither listed nor answered"):
            self.override(dict(self.data, review_comments=[FINDING_COMMENT, DEFERRED_REPLY, second]), prior_rounds=1)
        fixed = review_comment(4431365301, HEAD_C, "[FIXED] in abc", user=USER, reply_to=4431365300)
        self.override(dict(self.data, review_comments=[FINDING_COMMENT, DEFERRED_REPLY, second, fixed]), prior_rounds=1)

    def publication_data(self) -> dict:
        # Native publication shape from PR1662 review5747657344; no private fixture dependency.
        body = (
            "<!-- coderabbit-ai-generated:v1 -->\n\n"
            "<!-- This is an auto-generated comment by CodeRabbit for review status -->\n\n"
            "<!-- coderabbit-ai-generated:v1 -->\n\n"
            "<!-- This is an auto-generated comment by CodeRabbit for review status -->\n\n"
            "<!-- coderabbit-review-publication v1 publication=0aedc319-5499-4a86-83f6-5afd88b33b92 "
            "attempt=04a5db64-7a68-4876-a99c-b2e4455d322b batch=1/1 -->\n\n"
            "<!-- autofix_checkbox_start -->\n"
            '- [ ] <!-- {"checkboxId":"4b0d0e0a-96d7-4f10-b296-3a18ea78f0b9"} --> '
            "Fix comments: Fix CodeRabbit comments on this PR\n<!-- autofix_checkbox_end -->"
        )
        return evidence(check_runs=[dict(FINISHED_CHECK, started_at="2026-10-31T10:15:00Z")],
                        reviews=[review(5747657344, HEAD_C, body)],
                        review_comments=[dict(FINDING_COMMENT, pull_request_review_id=5747657344),
                                         DEFERRED_REPLY])

    def test_fetch_all_check_attempts_preserves_earlier_publication_and_bounds_pagination(self) -> None:
        data = self.publication_data()
        latest = check_run(124509628999, HEAD_C, 'neutral', 'Review rate limited', '2026-10-31T10:20:00Z')
        calls = []
        def api(argv):
            calls.append(argv[-1])
            if 'filter=all' not in argv[-1]:
                return {'check_runs':[latest], 'total_count':1}  # Real default latest behaviour.
            page = int(argv[-1].rsplit('page=',1)[-1])
            return {'check_runs':{1:[latest],2:data['check_runs'],3:[]}[page], 'total_count':2}
        def pages(endpoint):
            return data['reviews'] if endpoint.endswith('/reviews') else data['review_comments'] if '/pulls/' in endpoint else data['issue_comments']
        with patch.object(MODULE,'_gh_json',side_effect=api), patch.object(MODULE,'_gh_pages',side_effect=pages), \
             patch.object(MODULE,'GH_PAGE_SIZE',1):
            captured = MODULE.fetch_evidence(pr='1662',head=HEAD_C,repo='acme/rose')
        self.assertTrue(MODULE.substantive_reviews(captured['reviews'],HEAD_C,captured))
        captured['issue_comments'] = [CAP_COMMENT]
        before = self.state_path.read_bytes()
        with self.assertRaisesRegex(MODULE.ReviewCycleError, 'substantive CodeRabbit review exists'):
            MODULE.skip_cycle(self.state_path, head=HEAD_C, pr='1662', reason='usage-cap',
                              evidence=captured, receipts_path=self.receipts)
        self.assertEqual(before, self.state_path.read_bytes())
        self.assertTrue(all('filter=all&per_page=1&page=' in call for call in calls)); self.assertEqual(3,len(calls))
        with patch.object(MODULE,'_gh_json',return_value={'check_runs':[RATE_LIMITED_CHECK]}), \
             patch.object(MODULE,'GH_PAGE_SIZE',1), patch.object(MODULE,'GH_MAX_PAGES',2):
            with self.assertRaisesRegex(MODULE.ReviewCycleError,'pagination'):
                MODULE._gh_check_runs('acme/rose',HEAD_C)
        with patch.object(MODULE,'_gh_json',return_value={'wrong':[]}):
            with self.assertRaises(MODULE.ReviewCycleError):MODULE._gh_check_runs('acme/rose',HEAD_C)

    def test_publication_original_commit_survives_comment_retarget(self) -> None:
        data = self.publication_data()
        data["review_comments"][0].update(original_commit_id=HEAD_C, commit_id=HEAD_B)
        cycle = self.override(data, prior_rounds=1)
        self.assertEqual("overridden", cycle["disposition"])
        self.assertEqual([4431365241], cycle["evidence"]["review_publication"]["inline_finding_ids"])

    def test_retargeted_publication_refuses_usage_skip_atomically(self) -> None:
        data = self.publication_data()
        data["review_comments"][0].update(original_commit_id=HEAD_C, commit_id=HEAD_B)
        data["check_runs"].append(check_run(124509628999, HEAD_C, "neutral", "Review rate limited",
                                            "2026-10-31T10:20:00Z"))
        data["issue_comments"] = [CAP_COMMENT]
        normalized = MODULE.normalize_evidence(data, source="test")
        before = self.state_path.read_bytes()
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "substantive CodeRabbit review exists"):
            MODULE.skip_cycle(self.state_path, head=HEAD_C, pr="1656", reason="usage-cap",
                              evidence=normalized, receipts_path=self.receipts)
        self.assertEqual(before, self.state_path.read_bytes())
        self.assertFalse(self.receipts.exists())

    def test_publication_original_binding_falls_back_only_when_absent(self) -> None:
        original = self.publication_data()
        for present, value, current, accepted in [(False, None, HEAD_C, True),
                (False, None, HEAD_B, False), (True, None, HEAD_C, False),
                (True, "", HEAD_C, False), (True, HEAD_B, HEAD_C, False),
                (True, HEAD_C, HEAD_B, True)]:
            with self.subTest(present=present, original=value, current=current):
                data = deepcopy(original)
                comment = data["review_comments"][0]
                comment["commit_id"] = current
                if present:
                    comment["original_commit_id"] = value
                else:
                    comment.pop("original_commit_id", None)
                proof = MODULE.publication_evidence(data["reviews"][0], HEAD_C, data)
                self.assertEqual(accepted, proof is not None)

    def test_publication_with_bound_finding_records_native_evidence(self) -> None:
        data = self.publication_data()
        self.assertIsNone(MODULE.SUBSTANTIVE_REVIEW.search(data["reviews"][0]["body"]))
        cycle = self.override(data, prior_rounds=1)
        self.assertEqual((cycle["result"], cycle["disposition"]), ("clean", "overridden"))
        self.assertEqual(cycle["evidence"]["review_id"], 5747657344)
        self.assertIsNone(cycle["evidence"]["review_findings"])
        native = cycle["evidence"]["review_publication"]
        self.assertEqual(native["publication"], "0aedc319-5499-4a86-83f6-5afd88b33b92")
        self.assertEqual(native["attempt"], "04a5db64-7a68-4876-a99c-b2e4455d322b")
        self.assertEqual(native["batch"], "1/1")
        self.assertEqual(native["inline_finding_ids"], [4431365241])
        self.assertEqual(native["check_run_id"], FINISHED_CHECK["id"])
        self.assertEqual(native["review_body_sha256"],
                         MODULE.hashlib.sha256(data["reviews"][0]["body"].encode()).hexdigest())
        self.assertEqual(json.loads(self.receipts.read_text())["evidence"], cycle["evidence"])
        self.assertIn("Overridden", cycle["report_row"])

    def test_earlier_publication_survives_later_same_head_exhaustion(self) -> None:
        data = self.publication_data()
        exhausted = check_run(124509628999, HEAD_C, "neutral", "Review rate limited", "2026-10-31T10:20:00Z")
        data["check_runs"].append(exhausted)
        data["issue_comments"] = [CAP_COMMENT]
        before = self.state_path.read_bytes()
        normalized = MODULE.normalize_evidence(data, source="test")
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "substantive CodeRabbit review exists"):
            MODULE.skip_cycle(self.state_path, head=HEAD_C, pr="1656", reason="usage-cap",
                              evidence=normalized, receipts_path=self.receipts)
        self.assertEqual(before, self.state_path.read_bytes())
        self.assertFalse(self.receipts.exists())
        cycle = self.override(data, prior_rounds=1)
        publication = cycle["evidence"]["review_publication"]
        self.assertEqual(FINISHED_CHECK["id"], publication["check_run_id"])
        self.assertEqual(MODULE.hashlib.sha256(data["reviews"][0]["body"].encode()).hexdigest(),
                         publication["review_body_sha256"])
        self.assertEqual("overridden", cycle["disposition"])
        self.assertEqual(exhausted["id"], cycle["evidence"]["check_run_id"])

    def test_publication_requires_finished_attempt_containing_submission(self) -> None:
        valid = self.publication_data()
        before = self.state_path.read_bytes()
        for submitted in [None, "not-a-date", "2026-10-31T10:15:31", "2026-10-31T10:14:59Z",
                          "2026-10-31T10:15:37Z"]:
            self.state_path.write_bytes(before); self.receipts.unlink(missing_ok=True)
            data = deepcopy(valid); data["reviews"][0]["submitted_at"] = submitted
            with self.subTest(submitted=submitted):
                with self.assertRaisesRegex(MODULE.ReviewCycleError, "no substantive CodeRabbit review"):
                    self.override(data, prior_rounds=1)
                self.assertEqual(before, self.state_path.read_bytes())
                self.assertFalse(self.receipts.exists())
        for field, value in [("started_at", None), ("completed_at", "invalid"),
                             ("started_at", "2026-10-31T10:16:00Z")]:
            self.state_path.write_bytes(before); self.receipts.unlink(missing_ok=True)
            data = deepcopy(valid); data["check_runs"][0][field] = value
            with self.subTest(field=field, value=value):
                with self.assertRaisesRegex(MODULE.ReviewCycleError, "no substantive CodeRabbit review"):
                    self.override(data, prior_rounds=1)
                self.assertEqual(before, self.state_path.read_bytes())
                self.assertFalse(self.receipts.exists())
        # Legacy substantive bodies remain independent of the publication-only time binding.
        legacy = MODULE.normalize_evidence(evidence(reviews=[FINDINGS_REVIEW],
            check_runs=[RATE_LIMITED_CHECK]), source="test")
        self.assertEqual([FINDINGS_REVIEW], MODULE.substantive_reviews(legacy["reviews"], HEAD_C, legacy))

    def test_publication_refusals_are_atomic(self) -> None:
        valid = self.publication_data()
        cases = {}
        for name in ["marker-only", "green-only", "wrong-head", "wrong-review-id", "nonbot-review",
                     "nonbot-finding", "reply-wrapper", "nonfinished", "failed-check", "wrong-check-head",
                     "missing-check-head", "old-root", "incomplete-batch", "malformed-marker", "pending-review"]:
            cases[name] = deepcopy(valid)
        cases["marker-only"]["review_comments"] = [DEFERRED_REPLY]
        cases["green-only"]["reviews"][0]["body"] = ""
        cases["wrong-head"]["reviews"][0]["commit_id"] = HEAD_B
        cases["wrong-review-id"]["review_comments"][0]["pull_request_review_id"] = 999
        cases["nonbot-review"]["reviews"][0]["user"] = USER
        cases["nonbot-finding"]["review_comments"][0]["user"] = USER
        cases["reply-wrapper"]["review_comments"][0]["in_reply_to_id"] = 123
        cases["nonfinished"]["check_runs"][0]["output"]["title"] = "Review skipped"
        cases["failed-check"]["check_runs"][0]["conclusion"] = "failure"
        cases["wrong-check-head"]["check_runs"][0]["head_sha"] = HEAD_B
        cases["missing-check-head"]["check_runs"][0].pop("head_sha")
        cases["old-root"]["review_comments"][0]["original_commit_id"] = HEAD_B
        cases["incomplete-batch"]["reviews"][0]["body"] = (
            valid["reviews"][0]["body"].replace("batch=1/1", "batch=1/2"))
        cases["malformed-marker"]["reviews"][0]["body"] = (
            valid["reviews"][0]["body"].replace("publication=0aed", "publication=invalid0aed"))
        cases["pending-review"]["reviews"][0]["state"] = "PENDING"
        before = self.state_path.read_bytes()
        for name, data in cases.items():
            with self.subTest(name=name):
                with self.assertRaisesRegex(MODULE.ReviewCycleError, "no substantive CodeRabbit review"):
                    self.override(data, prior_rounds=1)
                self.assertEqual(self.state_path.read_bytes(), before)
                self.assertFalse(self.receipts.exists())

    def test_publication_finding_refuses_usage_skip(self) -> None:
        data = self.publication_data()
        data["issue_comments"] = [CAP_COMMENT]
        normalized = MODULE.normalize_evidence(data, source="test")
        before = self.state_path.read_bytes()
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "substantive CodeRabbit review exists"):
            MODULE.skip_cycle(self.state_path, head=HEAD_C, pr="1656", reason="usage-cap",
                              evidence=normalized, receipts_path=self.receipts)
        self.assertEqual(self.state_path.read_bytes(), before)
        self.assertFalse(self.receipts.exists())

    def test_override_needs_a_substantive_review_and_a_target(self) -> None:
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "no substantive CodeRabbit review"):
            self.override(dict(self.data, reviews=REPLY_WRAPPERS), prior_rounds=1)
        with self.assertRaisesRegex(MODULE.ReviewCycleError, "--deferred-to"):
            self.override(self.data, target="  ", prior_rounds=1)
        with self.assertRaisesRegex(MODULE.ReviewCycleError,
                                    "finding 1 is not a CodeRabbit review comment on da2dbd8b14e2"):
            self.override(self.data, ids=(4431365241, 1), prior_rounds=1)


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
  "api repos/acme/rose/commits/{HEAD_C}/check-runs?filter=all&per_page=100&page=1") cat "{fixtures}/check_runs.json" ;;
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

    def test_deploy_review_next_derives_the_kind_from_next(self) -> None:
        """``scripts/deploy review-next`` (deploy.md step 10) must take the kind
        from ``next``: a count of ledger entries says ``verification`` after
        [findings, unavailable], which the ledger refuses for the superseding
        HEAD (PR 1656, 2026-10-31)."""
        deploy_md = (ROOT / ".claude" / "commands" / "deploy.md").read_text()
        self.assertIn("`scripts/deploy review-next`", deploy_md)
        cli_source = (ROOT / "scripts" / "deploy_cli.py").read_text()
        body = cli_source.split("def cmd_review_next(", 1)[1].split("\ndef ", 1)[0]
        self.assertIn("'scripts/deploy_review_cycle.py', 'next'", body)
        self.assertIn("json.loads(nxt.stdout)['kind']", body)
        self.assertNotIn("['cycles']", body)
        self.assertNotIn("len(", body)

        MODULE.finish_cycle(self.state_path, head=HEAD_C, result="findings")
        MODULE.start_cycle(self.state_path, head="b" * 40, kind="incremental")
        MODULE.finish_cycle(self.state_path, head="b" * 40, result="unavailable")
        # The ledger refuses the count-derived kind for the superseding HEAD.
        counted = self.run_cli("start", "--kind", "verification", "--head", "d" * 40)
        self.assertNotEqual(counted.returncode, 0)
        self.assertIn("must be incremental, not verification", counted.stderr)

        # Execute the real cmd_review_next against the real ``next`` and ledger.
        sys.path.insert(0, str(ROOT / "scripts"))
        try:
            import deploy_cli
        finally:
            sys.path.remove(str(ROOT / "scripts"))
        cwd = self.root / "review-next"
        (cwd / ".context").mkdir(parents=True)
        (cwd / "scripts").symlink_to(ROOT / "scripts")
        (cwd / ".context" / "deploy-review-cycle.json").write_bytes(self.state_path.read_bytes())
        calls: list[list[str]] = []
        patches = [
            patch.object(deploy_cli, "ROOT", cwd),
            patch.object(deploy_cli, "read_json", return_value={"pr": 1656}),
            patch.object(deploy_cli, "write_json"),
            patch.object(deploy_cli, "uncommitted", return_value=[]),
            patch.object(deploy_cli, "unapplied_ledger_rows", return_value=[]),
            patch.object(deploy_cli, "head", return_value="d" * 40),
            patch.object(deploy_cli, "factory"),
            patch.object(deploy_cli, "run", side_effect=lambda argv, **_: calls.append(argv) or 0),
        ]
        for item in patches:
            item.start()
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                code = deploy_cli.cmd_review_next(type("Args", (), {"verification_approval": None})())
        finally:
            for item in patches:
                item.stop()
        self.assertEqual(code, 0)
        self.assertEqual(calls[0][1:], ["scripts/deploy_review_cycle.py", "start", "--kind", "incremental",
                                        "--head", "d" * 40])


# Projections of authenticated PR1828 API captures, 2026-11-08; bodies are unmodified.
MODERN_QUOTA_DATA = {'issue_comments': [{'id': 6720503588,
                     'issue_url': 'https://api.github.com/repos/Rose-Ai-Labs/rose/issues/1828',
                     'body': '<!-- coderabbit-ai-generated:v1 -->\n'
                             '\n'
                             '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n'
                             '<!-- This is an auto-generated comment: skip review by coderabbit.ai -->\n'
                             '\n'
                             '> [!IMPORTANT]\n'
                             '> ## Review skipped\n'
                             '> \n'
                             '> Review was skipped due to path filters\n'
                             '> \n'
                             '> <details>\n'
                             '> <summary><strong>:no_entry: Files ignored due to path filters: '
                             '7</strong></summary>\n'
                             '> <dl>\n'
                             '> <dd>\n'
                             '> <br>\n'
                             '> \n'
                             '> * `back-end/src/tests/blackbox/code-session-inspect-cooldown.fixture.ts` is '
                             'excluded by `!**/tests/**/!(browser_tilion.blackbox.py)`\n'
                             '> * `back-end/src/tests/blackbox/code-session-inspect-isolation.blackbox.ts` '
                             'is excluded by `!**/tests/**/!(browser_tilion.blackbox.py)`, '
                             '`!**/*.blackbox.ts`\n'
                             '> * `back-end/src/tests/blackbox/code-session-inspect.blackbox.ts` is excluded '
                             'by `!**/tests/**/!(browser_tilion.blackbox.py)`, `!**/*.blackbox.ts`\n'
                             '> * `back-end/src/tests/blackbox/code-session-usage-limit.blackbox.ts` is '
                             'excluded by `!**/tests/**/!(browser_tilion.blackbox.py)`, `!**/*.blackbox.ts`\n'
                             '> * `back-end/src/tests/blackbox/funded-key-cooldown.support.ts` is excluded '
                             'by `!**/tests/**/!(browser_tilion.blackbox.py)`\n'
                             '> * `back-end/src/tests/unit/funded-key-cooldown-isolation.test.ts` is '
                             'excluded by `!**/tests/**/!(browser_tilion.blackbox.py)`, `!**/*.test.ts`\n'
                             '> * '
                             '`docs/rca/cases/2026-10-02-in-process-rose-tests-shared-funded-key-cooldown-row.md` '
                             'is excluded by `!docs/**`, `!**/*.md`\n'
                             '> \n'
                             '> </dd>\n'
                             '> </dl>\n'
                             '> </details>\n'
                             '> \n'
                             '> CodeRabbit blocks several paths by default. You can override this behavior '
                             'by explicitly including those paths in the path filters. For example, '
                             'including `**/dist/**` will override the default block on the `dist` '
                             'directory, by removing the pattern from both the lists.\n'
                             '> \n'
                             '> <details>\n'
                             '> <summary><strong><picture><source media="(prefers-color-scheme: dark)" '
                             'srcset="https://storage.googleapis.com/coderabbit_public_assets/review-comment-icons-v1/cog-dark.svg"><img '
                             'src="https://storage.googleapis.com/coderabbit_public_assets/review-comment-icons-v1/cog.svg" '
                             'width="16" height="16" align="absmiddle" alt=""></picture> Run '
                             'configuration</strong></summary>\n'
                             '> <dl>\n'
                             '> <dd>\n'
                             '> <br>\n'
                             '> \n'
                             '> - **Source mode**: Auto\n'
                             '> - **Repository**: '
                             '[Rose-Ai-Labs/rose](<https://github.com/Rose-Ai-Labs/rose>)\n'
                             '> - **Branch**: '
                             '[fix/inspection-cooldown-fixture-isolation](<https://github.com/Rose-Ai-Labs/rose/tree/fix%2Finspection-cooldown-fixture-isolation>)\n'
                             '> - **File**: '
                             '[.coderabbit.yaml](<https://github.com/Rose-Ai-Labs/rose/blob/b3a75f5183867198f931b24bb2ddbef68c59d55e/.coderabbit.yaml>)\n'
                             '> - **Commit**: '
                             '[b3a75f5](<https://github.com/Rose-Ai-Labs/rose/commit/b3a75f5183867198f931b24bb2ddbef68c59d55e>)\n'
                             '> - **Layers**: Repository YAML\n'
                             '> - **Review profile**: ASSERTIVE\n'
                             '> - **Plan**: Team\n'
                             '> - **Run ID**: `b8bba353-acb6-456d-a736-cc4e398d5bea`\n'
                             '> \n'
                             '> </dd>\n'
                             '> </dl>\n'
                             '> </details>\n'
                             '> \n'
                             '> You can disable this status message by setting the `reviews.review_status` '
                             'to `false` in the CodeRabbit configuration file.\n'
                             '> \n'
                             '> Use the checkbox below for a quick retry:\n'
                             '> - [ ] <!-- {"checkboxId":"e9bb8d72-00e8-4f67-9cb2-caf3b22574fe"} --> Trigger '
                             'review\n'
                             '\n'
                             '<!-- end of auto-generated comment: skip review by coderabbit.ai -->\n'
                             '\n'
                             '<!-- autopilot:start -->\n'
                             '- [ ] <!-- {"checkboxId":"2708ad07-9f24-4260-9c11-7dc76a49f2e3"} --> <strong '
                             'title="Keep fixing CodeRabbit findings and required CI, and resolving merge '
                             'conflicts">Autofix</strong> · Keep fixing CodeRabbit findings and required CI, '
                             'and resolving merge conflicts\n'
                             '<!-- autopilot:end -->',
                     'created_at': '2026-11-08T10:44:26Z',
                     'updated_at': '2026-11-08T10:45:44Z',
                     'author_association': 'NONE',
                     'user': {'login': 'coderabbitai[bot]', 'type': 'Bot'},
                     'performed_via_github_app': {'slug': 'coderabbitai'}},
                    {'id': 6720513816,
                     'issue_url': 'https://api.github.com/repos/Rose-Ai-Labs/rose/issues/1828',
                     'body': '@coderabbitai full review',
                     'created_at': '2026-11-08T10:45:32Z',
                     'updated_at': '2026-11-08T10:45:32Z',
                     'author_association': 'MEMBER',
                     'user': {'login': 'andyprevalsky', 'type': 'User'},
                     'performed_via_github_app': {'slug': 'boxes-dev'}},
                    {'id': 6720514622,
                     'issue_url': 'https://api.github.com/repos/Rose-Ai-Labs/rose/issues/1828',
                     'body': '<!-- coderabbit-ai-generated:v1 -->\n'
                             '\n'
                             '<!-- This is an auto-generated reply by CodeRabbit -->\n'
                             '<!-- CodeRabbit review command invocation: '
                             'v2:f8b3805c76b8f8b31daa79f8ed832664a65cfa455221f38b6dfb9369050f5854 -->\n'
                             '<details>\n'
                             '<summary>Action not completed</summary>\n'
                             '<dl>\n'
                             '<dd>\n'
                             '<br>\n'
                             '\n'
                             'Path filters excluded 7 files from this review.\n'
                             '\n'
                             '---\n'
                             '\n'
                             'Your included review limit is currently reached under our [Fair Usage Limits '
                             'Policy](https://docs.coderabbit.ai/management/rate-limits#fair-usage-limits-policy). '
                             'Your current included review allowance is based on your included PR review '
                             'attempts over the past 7 days. This review may still proceed through '
                             'usage-based billing if eligible. Your next included review will be available '
                             'in 59 minutes.\n'
                             '\n'
                             '</dd>\n'
                             '</dl>\n'
                             '</details>',
                     'created_at': '2026-11-08T10:45:38Z',
                     'updated_at': '2026-11-08T10:45:46Z',
                     'author_association': 'NONE',
                     'user': {'login': 'coderabbitai[bot]', 'type': 'Bot'},
                     'performed_via_github_app': {'slug': 'coderabbitai'}}],
 'check_runs': [{'id': 128706968531,
                 'head_sha': 'b3a75f5183867198f931b24bb2ddbef68c59d55e',
                 'name': 'CodeRabbit',
                 'status': 'completed',
                 'conclusion': 'skipped',
                 'started_at': '2026-11-08T10:44:27Z',
                 'completed_at': '2026-11-08T10:44:27Z',
                 'output': {'title': 'Path filters excluded 7 files from this review'},
                 'app': {'slug': 'coderabbitai'}}],
 'reviews': [],
 'review_comments': [],
 'captured_at': '2026-11-08T10:50:12.523118+00:00'}
MODERN_QUOTA_PR = {'number': 1828, 'state': 'open', 'head': {'sha': 'b3a75f5183867198f931b24bb2ddbef68c59d55e'}, 'base': {'repo': {'full_name': 'Rose-Ai-Labs/rose'}}}


class ModernQuotaTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name) / 'state.json'
        self.receipts = Path(self.temp.name) / 'receipts.jsonl'
        self.head = MODERN_QUOTA_PR['head']['sha']
        MODULE.start_cycle(self.state, head=self.head, kind='initial', reset=True)
        state = MODULE.read_state(self.state)
        state['cycles'][0]['started_at'] = '2026-11-08T10:44:10.883437+00:00'
        MODULE.write_state(self.state, state)
        self.data = deepcopy(MODERN_QUOTA_DATA)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def skip(self, data=None, live=None):
        def api(args):
            self.assertEqual(args, ['api', 'repos/Rose-Ai-Labs/rose/pulls/1828'])
            return deepcopy(MODERN_QUOTA_PR if live is None else live)
        with patch.object(MODULE, '_gh_json', side_effect=api), \
             patch.object(MODULE, 'now', return_value=self.data['captured_at']):
            return MODULE.skip_cycle(self.state, head=self.head, pr='1828', reason='usage-cap',
                evidence=MODULE.normalize_evidence(data or self.data, source='captured-gh-test'),
                receipts_path=self.receipts)

    def test_modern_quota_reply_binds_current_pr_cycle_and_configuration(self) -> None:
        cycle = self.skip()
        self.assertEqual(cycle['disposition'], 'skipped')
        proof = cycle['evidence']['head_binding']
        self.assertEqual(proof['method'], 'current-pr-command-config')
        self.assertEqual(proof['request_comment_id'], 6720513816)
        self.assertEqual(proof['configuration_comment_id'], 6720503588)
        self.assertEqual(proof['current_pr_head'], self.head)
        self.assertEqual(proof['invocation'], 'v2:f8b3805c76b8f8b31daa79f8ed832664a65cfa455221f38b6dfb9369050f5854')
        self.assertIn('Skipped', cycle['report_row'])
        self.assertNotIn('naming commit', cycle['report_row'])
        self.assertEqual(MODULE.next_cycle(MODULE.read_state(self.state)['cycles'])['number'], 1)

    def test_modern_ambiguous_or_stale_evidence_refuses_without_mutation(self) -> None:
        cases = {}
        for label in ['no-config', 'no-request', 'path-only', 'rate-only', 'no-marker',
                      'wrong-config-head', 'wrong-pr', 'spoof-bot', 'stale-reply',
                      'stale-config', 'edited-request', 'untrusted-request',
                      'duplicate-request', 'request-after-reply', 'duplicate-token', 'no-exact-check', 'successful-check']:
            cases[label] = deepcopy(self.data)
        cases['no-config']['issue_comments'].pop(0)
        cases['no-request']['issue_comments'].pop(1)
        cases['path-only']['issue_comments'].pop(2)
        cases['rate-only']['issue_comments'][2]['body'] = 'Action not completed. Review rate limited.'
        cases['no-marker']['issue_comments'][2]['body'] = self.data['issue_comments'][2]['body'].replace('v2:', 'v3:')
        cases['wrong-config-head']['issue_comments'][0]['body'] = self.data['issue_comments'][0]['body'].replace(self.head, 'd' * 40)
        cases['wrong-pr']['issue_comments'][2]['issue_url'] += '9'
        cases['spoof-bot']['issue_comments'][2]['performed_via_github_app']['slug'] = 'other'
        cases['stale-reply']['issue_comments'][2]['created_at'] = '2026-11-08T10:43:00Z'
        cases['stale-config']['issue_comments'][0]['updated_at'] = '2026-11-08T10:44:26Z'
        cases['edited-request']['issue_comments'][1]['updated_at'] = '2026-11-08T10:45:33Z'
        cases['untrusted-request']['issue_comments'][1]['author_association'] = 'NONE'
        cases['duplicate-request']['issue_comments'].append(deepcopy(self.data['issue_comments'][1]))
        cases['request-after-reply']['issue_comments'][1].update(created_at='2026-11-08T10:45:39Z', updated_at='2026-11-08T10:45:39Z')
        cases['duplicate-token']['issue_comments'].append(deepcopy(self.data['issue_comments'][2]))
        cases['no-exact-check']['check_runs'][0].pop('head_sha')
        cases['successful-check']['check_runs'][0]['conclusion'] = 'success'
        before = self.state.read_bytes()
        for label, data in cases.items():
            with self.subTest(label=label), self.assertRaises(MODULE.ReviewCycleError):
                self.skip(data)
            self.assertEqual(self.state.read_bytes(), before)
            self.assertFalse(self.receipts.exists())
        for changed in [dict(MODERN_QUOTA_PR, number=99),
                        dict(MODERN_QUOTA_PR, head={'sha': 'd' * 40}),
                        dict(MODERN_QUOTA_PR, state='closed')]:
            with self.subTest(live=changed), self.assertRaises(MODULE.ReviewCycleError):
                self.skip(live=changed)
            self.assertEqual(self.state.read_bytes(), before)

    def test_modern_incomplete_identities_and_expired_allowance_refuse(self) -> None:
        before = self.state.read_bytes()
        cases = []
        for index in range(3):
            missing = deepcopy(self.data)
            missing['issue_comments'][index].pop('id')
            cases.append(missing)
        for key, value in [('app', {'slug': 'other'}), ('head_sha', 'e' * 40), ('status', 'in_progress')]:
            changed = deepcopy(self.data)
            changed['check_runs'][0][key] = value
            cases.append(changed)
        for timestamp in ['2026-11-08T11:45:38Z', '2026-11-08T10:43:00Z']:
            changed = deepcopy(self.data)
            changed['captured_at'] = timestamp
            cases.append(changed)
        for data in cases:
            with self.subTest(data=data), self.assertRaises(MODULE.ReviewCycleError):
                self.skip(data)
            self.assertEqual(before, self.state.read_bytes())
            self.assertFalse(self.receipts.exists())
        for live in [None, [], {'head': None}, dict(MODERN_QUOTA_PR, base=None)]:
            with patch.object(MODULE, '_gh_json', return_value=live), \
                 patch.object(MODULE, 'now', return_value=self.data['captured_at']), \
                 self.assertRaises(MODULE.ReviewCycleError):
                MODULE.skip_cycle(self.state, head=self.head, pr='1828', reason='usage-cap',
                    evidence=MODULE.normalize_evidence(self.data, source='test'), receipts_path=self.receipts)
            self.assertEqual(before, self.state.read_bytes())

    def test_modern_expired_notice_and_truncated_inventory_refuse(self) -> None:
        data = deepcopy(self.data)
        data['captured_at'] = '2026-11-08T11:45:38Z'
        with patch.object(MODULE, 'now', return_value=data['captured_at']), \
             self.assertRaises(MODULE.ReviewCycleError):
            MODULE.skip_cycle(self.state, head=self.head, pr='1828', reason='usage-cap',
                evidence=MODULE.normalize_evidence(data, source='test'), receipts_path=self.receipts)
        self.assertFalse(self.receipts.exists())
        with patch.object(MODULE, '_gh_json', return_value=[{}]), \
             patch.object(MODULE, 'GH_PAGE_SIZE', 1), patch.object(MODULE, 'GH_MAX_PAGES', 2), \
             self.assertRaisesRegex(MODULE.ReviewCycleError, 'pagination'):
            MODULE._gh_pages('repos/Rose-Ai-Labs/rose/issues/1828/comments')

    def test_later_incremental_cycle_preserves_prior_quota_history(self) -> None:
        # Synthetic later-cycle variation of the captured native shape, not a new API observation.
        MODULE.finish_cycle(self.state, head=self.head, result='findings')
        self.head = 'd' * 40
        MODULE.start_cycle(self.state, head=self.head, kind='incremental')
        state = MODULE.read_state(self.state)
        state['cycles'][-1]['started_at'] = '2026-11-08T10:46:00Z'
        MODULE.write_state(self.state, state)
        prior = deepcopy(self.data['issue_comments'])
        newer = deepcopy(prior)
        for entry in newer:
            entry['id'] += 100
        newer[0]['body'] = newer[0]['body'].replace(MODERN_QUOTA_PR['head']['sha'], self.head)
        newer[0]['body'] = newer[0]['body'].replace(MODERN_QUOTA_PR['head']['sha'][:7], self.head[:7])
        newer[0]['updated_at'] = '2026-11-08T10:46:08Z'
        newer[1].update(body='@coderabbitai review', created_at='2026-11-08T10:46:01Z', updated_at='2026-11-08T10:46:01Z')
        newer[2]['body'] = newer[2]['body'].replace('f8b3805c76b8f8b31daa79f8ed832664a65cfa455221f38b6dfb9369050f5854', 'e' * 64)
        newer[2].update(created_at='2026-11-08T10:46:03Z', updated_at='2026-11-08T10:46:10Z')
        self.data['issue_comments'] = prior + newer
        self.data['check_runs'][0].update(head_sha=self.head, started_at='2026-11-08T10:46:00Z', completed_at='2026-11-08T10:46:00Z')
        live = deepcopy(MODERN_QUOTA_PR)
        live['head']['sha'] = self.head
        before = self.state.read_bytes()
        stale_only = deepcopy(self.data)
        stale_only['issue_comments'] = prior
        with self.assertRaises(MODULE.ReviewCycleError):
            self.skip(stale_only, live=live)
        self.assertEqual(before, self.state.read_bytes())
        cycle = self.skip(live=live)
        self.assertEqual(cycle['evidence']['head_binding']['request_comment_id'], 6720513916)
        self.assertEqual(cycle['evidence']['head_binding']['invocation'], 'v2:' + 'e' * 64)
        self.assertEqual(len(MODULE.read_state(self.state)['cycles']), 2)

    def test_r1_contradictory_reply_and_mixed_configuration_refuse_atomically(self) -> None:
        # Synthetic contradictions added to unmodified native-shaped evidence.
        cases = {}
        for size in (7, 12, 40):
            for reference in [f'Review request targets commit {"d" * size}.',
                              f'HEAD: `{ "d" * size }`',
                              f'https://github.com/Rose-Ai-Labs/rose/commit/{"d" * size}']:
                data = deepcopy(self.data)
                data['issue_comments'][2]['body'] += '\n' + reference
                cases[reference] = data
        for target in [f'- **Commit**: [ddddddd](<https://github.com/Rose-Ai-Labs/rose/commit/{"d" * 40}>)',
                       '- **Commit**: [main](<https://github.com/Rose-Ai-Labs/rose/commit/main>)',
                       f'- **File**: [.coderabbit.yaml](<https://github.com/Rose-Ai-Labs/rose/blob/{"d" * 40}/.coderabbit.yaml>)',
                       '- **Commit**: ddddddd',
                       f'- **File**: [.coderabbit.yaml](<https://github.com/another/repo/blob/{self.head}/.coderabbit.yaml>)']:
            data = deepcopy(self.data)
            data['issue_comments'][0]['body'] += '\nRun configuration\n' + target
            cases[target] = data
        before = self.state.read_bytes()
        receipt = b'{"prior":"retained receipt"}\n'
        for label, data in cases.items():
            with self.subTest(label=label):
                self.state.write_bytes(before)
                self.receipts.write_bytes(receipt)
                with self.assertRaises(MODULE.ReviewCycleError):
                    self.skip(data)
                self.assertEqual(before, self.state.read_bytes())
                self.assertEqual(receipt, self.receipts.read_bytes())

    def test_r1_contextual_head_prefix_and_opaque_tokens_remain_distinct(self) -> None:
        self.data['issue_comments'][2]['body'] += (
            f'\nReview request targets commit `{self.head[:7]}`.'
            '\nOpaque identifier: `dddddddddddddddddddddddddddddddddddddddd`.'
        )
        cycle = self.skip()
        self.assertEqual(cycle['disposition'], 'skipped')
        self.assertEqual(cycle['evidence']['head_binding']['current_pr_head'], self.head)

    def test_modern_quota_never_skips_a_substantive_review(self) -> None:
        self.data['reviews'] = [review(999, self.head, 'Actionable comments posted: 1')]
        with self.assertRaisesRegex(MODULE.ReviewCycleError, 'substantive'):
            self.skip()
        self.assertFalse(self.receipts.exists())

if __name__ == "__main__":
    unittest.main()
