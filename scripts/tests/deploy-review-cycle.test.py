#!/usr/bin/env python3
"""Regression tests for bounded deploy review cycles."""

from __future__ import annotations

import importlib.util
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


if __name__ == "__main__":
    unittest.main()
