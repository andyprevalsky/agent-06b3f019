#!/usr/bin/env python3
"""Batched approvals at the source freeze stay snapshot-scoped.

A temporary repository with fake guards (same output contract as the real
Step 0p/0b/0c guards: exit 1 and "  - <file>" lines) proves that one freeze
covers every approval-scoped file, that unrelated post-freeze edits keep the
approval valid, and that any post-freeze edit to an approval-scoped hunk (or a
newly flagged file) forces a fresh request. The real guards run unchanged in
the last case to bind the parser to their actual output.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "deploy_approval_batch.py"

FAKE_GUARD = """#!/usr/bin/env bash
# Flags every changed file whose path contains $1 (like a real guard's scope).
flagged=$(git diff --name-only main -- . | grep -F "$1" || true)
[ -z "$flagged" ] && { echo "guard: nothing flagged"; exit 0; }
echo "guard failed:" >&2
printf '  - %s\\n' $flagged >&2
exit 1
"""


class ApprovalBatchTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.com")
        self.git("config", "user.name", "t")
        for name in ("prompt.txt", "loop.py", "ui.ts"):
            (self.repo / name).write_text("base\n")
        guard = Path(self._tmp.name) / "guard.sh"
        guard.write_text(FAKE_GUARD)
        self.git("add", ".")
        self.git("commit", "-q", "-m", "base")
        self.git("checkout", "-q", "-b", "feature")
        self.env = dict(
            os.environ,
            DEPLOY_APPROVAL_BATCH_TEST_MODE="1",
            DEPLOY_APPROVAL_GUARDS=json.dumps(
                {
                    "prompt-approval": ["bash", str(guard), "prompt"],
                    "agent-behavior-approval": ["bash", str(guard), "loop"],
                    "llm-trajectory-injection-approval": ["bash", str(guard), "inject"],
                }
            ),
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def git(self, *args: str) -> str:
        return subprocess.run(
            ("git", *args), cwd=self.repo, check=True, capture_output=True, text=True
        ).stdout

    def commit(self, name: str, text: str) -> str:
        (self.repo / name).write_text(text)
        self.git("add", name)
        self.git("commit", "-q", "-m", f"edit {name}")
        return self.git("rev-parse", "HEAD").strip()

    def batch(self, *args: str, env: dict | None = None) -> tuple[int, dict]:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--repo", str(self.repo), *args],
            env=env or self.env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        out = result.stdout.strip()
        return result.returncode, (json.loads(out) if out else {"stderr": result.stderr})

    def freeze(self, base: str = "main") -> dict:
        head = self.git("rev-parse", "HEAD").strip()
        code, payload = self.batch("freeze", "--head", head, "--base", base)
        self.assertEqual(code, 0, payload)
        return payload

    def test_one_freeze_batches_every_guard_and_writes_the_exact_diff(self) -> None:
        self.commit("prompt.txt", "new prompt\n")
        self.commit("loop.py", "terminal\n")
        payload = self.freeze()
        self.assertEqual(payload["status"], "approval-required")
        self.assertEqual(payload["files"], ["loop.py", "prompt.txt"])
        self.assertEqual(set(payload["guards"]), {"prompt-approval", "agent-behavior-approval"})
        diff = Path(payload["diff"]).read_text()
        self.assertIn("+new prompt", diff)
        self.assertIn("+terminal", diff)
        self.assertEqual(self.batch("check")[0], 3, "undecided batch must stay pending")

    def test_approval_survives_unrelated_post_freeze_fixes(self) -> None:
        self.commit("prompt.txt", "new prompt\n")
        self.freeze()
        self.assertEqual(self.batch("decide", "--decision", "approved", "--evidence", "user")[0], 0)
        self.commit("ui.ts", "gate fix\n")  # post-freeze, outside approval scope
        code, payload = self.batch("check")
        self.assertEqual(code, 0, payload)
        self.assertEqual(payload["status"], "covered")
        self.assertEqual(payload["guards_to_flag"], ["prompt-approval"])

    def test_post_freeze_edit_to_an_approved_hunk_requires_a_fresh_request(self) -> None:
        self.commit("prompt.txt", "new prompt\n")
        self.freeze()
        self.batch("decide", "--decision", "grounded", "--evidence", "reviewer a1 GROUNDED")
        self.commit("prompt.txt", "new prompt, edited to make a test pass\n")
        code, payload = self.batch("check")
        self.assertEqual(code, 1, payload)
        self.assertEqual(payload["status"], "re-request")
        self.assertEqual(payload["changed"], ["prompt.txt"])

    def test_uncommitted_edit_to_an_approved_hunk_is_also_caught(self) -> None:
        self.commit("prompt.txt", "new prompt\n")
        self.freeze()
        self.batch("decide", "--decision", "approved", "--evidence", "user")
        (self.repo / "prompt.txt").write_text("sneaky local edit\n")
        self.assertEqual(self.batch("check")[0], 1)

    def test_newly_flagged_file_after_a_clear_freeze_requires_a_request(self) -> None:
        self.commit("ui.ts", "ui only\n")
        self.assertEqual(self.freeze()["status"], "clear")
        self.assertEqual(self.batch("check")[0], 0)
        self.commit("loop.py", "terminal\n")
        code, payload = self.batch("check")
        self.assertEqual(code, 1, payload)
        self.assertEqual(payload["changed"], ["loop.py"])

    def test_rejection_blocks_and_cannot_be_overwritten(self) -> None:
        self.commit("prompt.txt", "new prompt\n")
        self.freeze()
        self.batch("decide", "--decision", "rejected", "--evidence", "user")
        self.assertEqual(self.batch("check")[0], 1)
        self.assertEqual(self.batch("decide", "--decision", "approved", "--evidence", "x")[0], 2)

    def test_freeze_refuses_a_dirty_or_moved_worktree(self) -> None:
        (self.repo / "ui.ts").write_text("dirty\n")
        head = self.git("rev-parse", "HEAD").strip()
        self.assertEqual(self.batch("freeze", "--head", head, "--base", "main")[0], 2)
        self.git("checkout", "-q", "--", "ui.ts")
        self.assertEqual(self.batch("freeze", "--head", "0" * 40, "--base", "main")[0], 2)

    def test_real_guards_output_contract_parses(self) -> None:
        # Bind the parser to the real Step 0p guard's output, not only the fake.
        scripts = self.repo / "scripts"
        scripts.mkdir()
        shutil.copy(ROOT / "scripts" / "check-prompt-human-approval.sh", scripts)
        self.git("add", "scripts")
        self.git("commit", "-q", "-m", "guard")
        self.git("branch", "-f", "main", "HEAD")
        (self.repo / ".claude" / "commands").mkdir(parents=True)
        (self.repo / ".claude" / "commands" / "x.md").write_text("new instruction\n")
        self.git("add", ".claude")
        self.git("commit", "-q", "-m", "instruction")
        env = dict(
            self.env,
            PROMPT_APPROVAL_BASE_REF="main",
            DEPLOY_APPROVAL_BATCH_TEST_MODE="1",
            DEPLOY_APPROVAL_GUARDS=json.dumps(
                {"prompt-approval": ["bash", "scripts/check-prompt-human-approval.sh", "--base-ref=main"]}
            ),
        )
        head = self.git("rev-parse", "HEAD").strip()
        code, payload = self.batch("freeze", "--head", head, "--base", "main", env=env)
        self.assertEqual(code, 0, payload)
        self.assertEqual(payload["files"], [".claude/commands/x.md"])


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
