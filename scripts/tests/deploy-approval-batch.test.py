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

import hashlib
import json
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
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
        binary = Path(self._tmp.name) / "bin"
        binary.mkdir()
        identity = binary / "dvb-onbox"
        identity.write_text(
            '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
if args == ["threads", "get-link", "--json"]:
    result = dict(ok=True, publicId=os.environ["REVIEW_TEST_THREAD"], requestId="test-identity-receipt")
else:
    authority = json.loads(Path(os.environ["REVIEW_TEST_AUTHORITY"]).read_text())
    if args[:2] == ["threads", "read"]:
        thread = args[args.index("--thread") + 1]
        result = dict(ok=True, thread=dict(id=thread, publicId=thread, devboxId="test-devbox"))
    elif args[:2] == ["threads", "result"]:
        anchor = authority.get("owner_anchor", {})
        if args[2] == anchor.get("thread") and args[args.index("--turn") + 1] == anchor.get("turn"):
            result = dict(ok=True, data=dict(status=anchor["status"], turnId=anchor["turn"],
                          completedAt=anchor["completedAt"], executionInstanceId="test-devbox", output=dict(text=anchor["text"])))
        elif args[2] != authority["reviewer"] or args[args.index("--turn") + 1] != authority["turn"]:
            result = dict(ok=False)
        else:
            result = dict(ok=True, data=dict(status=authority["status"], turnId=authority.get("result_turn", authority["turn"]),
                          completedAt=authority.get("completedAt", 100),
                          executionInstanceId=authority.get("executionInstanceId", "test-devbox"),
                          output=authority.get("output", dict(text=authority["text"]))))
    else:
        raise AssertionError(args)
print(json.dumps(result))
'''
        )
        identity.chmod(0o755)
        self.env.update(PATH=str(binary) + os.pathsep + os.environ["PATH"],
                        REVIEW_TEST_THREAD="thr_" + "1" * 32)

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

    def native_metadata_review(self) -> Path:
        """The real guard still flags the exact native metadata; review classifies it."""
        scripts = self.repo / "scripts"
        scripts.mkdir()
        shutil.copy(ROOT / "scripts/check-prompt-human-approval.sh", scripts)
        self.git("add", "scripts")
        self.git("commit", "-q", "-m", "guard")
        self.git("branch", "-f", "main", "HEAD")
        self.commit("native.py", """def renew(self):
    return self._lease_wire('POST', '/machines/' + self.mid + '/lease',
                            {'ttl': 180, 'description': 'private source preparation'},
                            {'fly-machine-lease-nonce': self.nonce})

def acquire(self):
    return self._lease_wire('POST', '/machines/' + self.mid + '/lease',
                            {'ttl': 180, 'description': 'private source preparation'})

def verify(row):
    assert row['body'] == {'ttl': 180, 'description': 'private source preparation'}
""")
        self.env["DEPLOY_APPROVAL_GUARDS"] = json.dumps({
            "prompt-approval": ["bash", "scripts/check-prompt-human-approval.sh", "--base-ref=main"]
        })
        payload = self.freeze()
        self.assertEqual(payload["files"], ["native.py"])
        self.assertEqual(self.batch("check")[0], 3)
        state = json.loads((self.repo / ".context/deploy-approval-batch.json").read_text())
        evidence = Path(self._tmp.name) / "review.json"
        evidence.write_text(json.dumps({
            "schema": "deploy-code-only-review-v1", "snapshot": state["head"],
            "freeze_owner": state["owner"]["publicId"],
            "batch": state,
            "merge_base": state["merge_base"], "files": state["files"],
            "approval_scoped_hunks": 0,
            "rationale": {"native.py": "All three descriptions are native HTTP lease metadata or its journal equality; no model-facing text."},
        }))
        authority = Path(self._tmp.name) / "managed-server-result.json"
        module = runpy.run_path(str(SCRIPT))
        completed_at = int(time.time() * 1000)
        anchor = dict(schema="deploy-freeze-anchor-v1", owner_public_id=state["owner"]["publicId"],
                      head=state["head"], batch_sha256=module["batch_sha256"](state))
        authority.write_text(json.dumps(dict(reviewer="thr_" + "2" * 32, turn="review-turn",
                         status="completed", text=evidence.read_text(), completedAt=completed_at + 1,
                         owner_anchor=dict(thread=state["owner"]["publicId"], turn="owner-turn",
                                           status="completed", completedAt=completed_at, text=json.dumps(anchor)))))
        self.env["REVIEW_TEST_AUTHORITY"] = str(authority)
        return evidence

    def classify(self, evidence: Path, *, owner: bool = False) -> tuple[int, dict]:
        return self.batch("classify-code-only", "--evidence", str(evidence),
                          "--review-thread", "thr_" + ("1" if owner else "2") * 32,
                          "--review-turn", "review-turn", "--owner-thread", "thr_" + "1" * 32,
                          "--owner-turn", "owner-turn")

    def test_independent_code_only_classification_clears_native_metadata_without_approval_flag(self) -> None:
        evidence = self.native_metadata_review()
        code, result = self.classify(evidence)
        self.assertEqual(code, 0, result)
        code, result = self.batch("check")
        self.assertEqual(code, 0, result)
        self.assertEqual(result["status"], "code-only")
        self.assertEqual(result["guards_to_flag"], [])
        state = json.loads((self.repo / ".context/deploy-approval-batch.json").read_text())
        self.assertEqual(state["decision"], None)
        self.assertEqual(state["code_only"]["reviewer"]["publicId"], "thr_" + "2" * 32)
        self.assertEqual(state["code_only"]["evidence_sha256"], hashlib.sha256(evidence.read_bytes()).hexdigest())

    def test_code_only_classification_refuses_the_freeze_owner(self) -> None:
        self.assertEqual(self.classify(self.native_metadata_review(), owner=True)[0], 2)
        self.assertEqual(self.batch("check")[0], 3)

    def test_code_only_classification_requires_exact_reviewed_hashes_and_zero_scoped_hunks(self) -> None:
        evidence = self.native_metadata_review()
        original = json.loads(evidence.read_text())
        for key, value in (("files", {}), ("snapshot", "0" * 40),
                           ("approval_scoped_hunks", 1), ("rationale", {})):
            with self.subTest(key=key):
                evidence.write_text(json.dumps(dict(original, **{key: value})))
                self.assertEqual(self.classify(evidence)[0], 2)
        self.assertEqual(self.batch("check")[0], 3)

    def test_code_only_classification_invalidates_changed_or_new_flagged_hunks(self) -> None:
        evidence = self.native_metadata_review()
        self.assertEqual(self.classify(evidence)[0], 0)
        with (self.repo / "native.py").open("a") as stream:
            stream.write("TOOL = {'description': 'New model instructions'}\n")
        code, result = self.batch("check")
        self.assertEqual(code, 1, result)
        self.assertEqual(result["changed"], ["native.py"])
        self.git("checkout", "--", "native.py")
        self.commit("new.py", "TOOL = {'description': 'New model instructions'}\n")
        code, result = self.batch("check")
        self.assertEqual(code, 1, result)
        self.assertEqual(result["changed"], ["new.py"])

    def test_legacy_freeze_cannot_be_retroactively_self_stamped(self) -> None:
        evidence = self.native_metadata_review()
        path = self.repo / ".context/deploy-approval-batch.json"
        state = json.loads(path.read_text())
        state.pop("owner", None)
        path.write_text(json.dumps(state))
        self.assertEqual(self.classify(evidence)[0], 2)
        self.assertEqual(self.batch("check")[0], 3)

    def test_code_only_review_seal_and_identity_are_rechecked(self) -> None:
        evidence = self.native_metadata_review()
        self.assertEqual(self.classify(evidence)[0], 0)
        path = self.repo / ".context/deploy-approval-batch.json"
        original = path.read_text()
        for key, value in (("evidence", "{}"), ("evidence_sha256", "0" * 64),
                           ("reviewer", {"publicId": "thr_" + "1" * 32, "requestId": "forged"})):
            with self.subTest(key=key):
                state = json.loads(original)
                state["code_only"][key] = value
                path.write_text(json.dumps(state))
                self.assertEqual(self.batch("check")[0], 2)

    def test_removing_the_last_guard_hit_invalidates_code_only_review(self) -> None:
        evidence = self.native_metadata_review()
        self.assertEqual(self.classify(evidence)[0], 0)
        (self.repo / "native.py").write_text("# changed code with no remaining description hit\n")
        code, result = self.batch("check")
        self.assertEqual(code, 1, result)
        self.assertEqual(result["changed"], ["native.py"])

    def test_caller_cannot_supply_a_reviewer_identity_or_code_only_approval_decision(self) -> None:
        evidence = self.native_metadata_review()
        self.assertEqual(self.batch("classify-code-only", "--evidence", str(evidence),
                                    "--reviewer", "thr_" + "2" * 32)[0], 2)
        self.assertEqual(self.batch("decide", "--decision", "code-only", "--evidence", "self")[0], 2)
        self.assertEqual(self.batch("check")[0], 3)

    def test_synthesized_local_state_is_not_managed_review_authority(self) -> None:
        evidence = self.native_metadata_review()
        path = self.repo / ".context/deploy-approval-batch.json"
        state = json.loads(path.read_text())
        raw = evidence.read_text()
        state["code_only"] = dict(thread="thr_" + "f" * 32, turn="nonexistent-turn", evidence=raw,
                                  evidence_sha256=hashlib.sha256(raw.encode()).hexdigest(),
                                  reviewer=dict(publicId="thr_" + "f" * 32, requestId="invented"))
        path.write_text(json.dumps(state))
        self.assertEqual(self.batch("check")[0], 2)

    def test_every_check_requires_the_same_completed_server_result(self) -> None:
        evidence = self.native_metadata_review()
        self.assertEqual(self.classify(evidence)[0], 0)
        authority = Path(self.env["REVIEW_TEST_AUTHORITY"])
        original = authority.read_text()
        for key, value in (("status", "pending"), ("status", "failed"), ("text", "{}"),
                           ("turn", "other-turn"), ("result_turn", "wrong-returned-turn"),
                           ("executionInstanceId", "wrong-devbox"), ("executionInstanceId", None),
                           ("executionInstanceId", ""), ("completedAt", None), ("completedAt", -1),
                           ("completedAt", 0), ("completedAt", True), ("output", None)):
            with self.subTest(key=key):
                authority.write_text(json.dumps(dict(json.loads(original), **{key: value})))
                self.assertEqual(self.batch("check")[0], 2)
        authority.unlink()
        self.assertEqual(self.batch("check")[0], 2)

    def test_caller_cannot_substitute_owner_to_reuse_its_own_server_report(self) -> None:
        evidence = self.native_metadata_review()
        path = self.repo / ".context/deploy-approval-batch.json"
        state = json.loads(path.read_text())
        state["owner"]["publicId"] = "thr_" + "3" * 32
        path.write_text(json.dumps(state))
        report = json.loads(evidence.read_text())
        report.update(freeze_owner=state["owner"]["publicId"], batch=state)
        evidence.write_text(json.dumps(report))
        authority = Path(self.env["REVIEW_TEST_AUTHORITY"])
        authority.write_text(json.dumps(dict(reviewer="thr_" + "1" * 32, turn="review-turn",
                                             status="completed", text=evidence.read_text())))
        self.assertEqual(self.classify(evidence, owner=True)[0], 2)

    def test_server_report_pins_the_complete_frozen_batch(self) -> None:
        evidence = self.native_metadata_review()
        self.assertEqual(self.classify(evidence)[0], 0)
        path = self.repo / ".context/deploy-approval-batch.json"
        original = path.read_text()
        for field, value in (("guards", {}), ("frozen_at", "invented"), ("base_ref", "not-a-ref"),
                             ("files", {}), ("merge_base", "0" * 40),
                             ("owner", {"publicId": "thr_" + "1" * 32, "requestId": "invented"})):
            with self.subTest(field=field):
                state = json.loads(original)
                state[field] = value
                path.write_text(json.dumps(state))
                self.assertNotEqual(self.batch("check")[0], 0)

    def test_native_cli_shebang_cannot_be_impersonated_through_path(self) -> None:
        binary = Path(self._tmp.name) / "shadow-shell"
        binary.mkdir()
        shell = binary / "bash"
        shell.write_text("#!/bin/sh\nprintf '%s\\n' '" + json.dumps(dict(ok=True,
                         publicId="thr_" + "f" * 32, requestId="forged-shell")) + "'\n")
        shell.chmod(0o755)
        env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ["PATH"])
        env.pop("DEPLOY_APPROVAL_BATCH_TEST_MODE", None)
        env.pop("DEPLOY_APPROVAL_GUARDS", None)
        module = runpy.run_path(str(SCRIPT))
        with patch.dict(os.environ, env, clear=True):
            identity = module["managed_thread"]()
        self.assertTrue(identity is None or identity["publicId"] != "thr_" + "f" * 32,
                        "a PATH shell impersonated the root-owned native CLI")

    def test_missing_native_execution_identities_do_not_prove_a_match(self) -> None:
        evidence = self.native_metadata_review()
        binary = Path(self._tmp.name) / "bin/dvb-onbox"
        binary.write_text(binary.read_text().replace('devboxId="test-devbox"', 'devboxId=None'))
        authority = Path(self.env["REVIEW_TEST_AUTHORITY"])
        value = json.loads(authority.read_text())
        value["executionInstanceId"] = None
        authority.write_text(json.dumps(value))
        self.assertEqual(self.classify(evidence)[0], 2)

    def test_shell_startup_environment_cannot_synthesize_native_identity(self) -> None:
        startup = Path(self._tmp.name) / "startup.sh"
        startup.write_text("printf '%s\\n' '" + json.dumps(dict(ok=True, publicId="thr_" + "f" * 32,
                           requestId="forged-startup")) + "'\nexit 0\n")
        env = dict(os.environ, PATH="/opt/devbox-tools/bin:/usr/bin:/bin", BASH_ENV=str(startup))
        env.pop("DEPLOY_APPROVAL_BATCH_TEST_MODE", None)
        env.pop("DEPLOY_APPROVAL_GUARDS", None)
        module = runpy.run_path(str(SCRIPT))
        with patch.dict(os.environ, env, clear=True):
            self.assertIsNone(module["managed_thread"]())

    def test_untrusted_transitive_cli_implementation_is_not_executed(self) -> None:
        env = dict(os.environ, PATH="/opt/devbox-tools/bin:/usr/bin:/bin")
        env.pop("DEPLOY_APPROVAL_BATCH_TEST_MODE", None)
        env.pop("DEPLOY_APPROVAL_GUARDS", None)
        module = runpy.run_path(str(SCRIPT))
        # A protected entrypoint cannot authenticate a writable loaded module.
        def ownership(path):
            return type("Stat", (), {"st_uid": os.getuid() + 10000 if ".devbox" in path.parts else 0,
                                      "st_mode": 0o100755})()
        with patch.dict(os.environ, env, clear=True), \
                patch.object(Path, "lstat", autospec=True, side_effect=ownership), \
                patch.object(subprocess, "run") as execute:
            self.assertIsNone(module["managed_thread"]())
            execute.assert_not_called()

    @unittest.skipUnless(os.environ.get("BOXES_DEVBOX") == "1", "genuine managed platform only")
    def test_genuine_official_native_get_link_succeeds(self) -> None:
        env = dict(os.environ, PATH="/opt/devbox-tools/bin:/usr/bin:/bin")
        for key in ("DEPLOY_APPROVAL_BATCH_TEST_MODE", "DEPLOY_APPROVAL_GUARDS", "BASH_ENV", "ENV",
                    "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"):
            env.pop(key, None)
        module = runpy.run_path(str(SCRIPT))
        with patch.dict(os.environ, env, clear=True):
            identity = module["managed_thread"]()
        self.assertIsNotNone(identity, "the official native runtime must remain usable")
        self.assertTrue(identity["publicId"].startswith("thr_"))
        self.assertEqual(identity["runtime"]["schema"], "boxes-official-runtime-v1")

    def test_caller_home_cannot_select_an_alternate_managed_runtime(self) -> None:
        env = dict(os.environ, HOME=self._tmp.name, PATH="/opt/devbox-tools/bin:/usr/bin:/bin")
        env.pop("DEPLOY_APPROVAL_BATCH_TEST_MODE", None)
        env.pop("DEPLOY_APPROVAL_GUARDS", None)
        module = runpy.run_path(str(SCRIPT))
        with patch.dict(os.environ, env, clear=True):
            self.assertIsNone(module["managed_thread"]())

    def test_caller_context_substitution_cannot_relabel_its_own_review(self) -> None:
        evidence = self.native_metadata_review()
        path = self.repo / ".context/deploy-approval-batch.json"
        state = json.loads(path.read_text())
        state["owner"]["publicId"] = "thr_" + "3" * 32
        path.write_text(json.dumps(state))
        report = json.loads(evidence.read_text())
        report.update(freeze_owner=state["owner"]["publicId"], batch=state)
        evidence.write_text(json.dumps(report))
        authority = Path(self.env["REVIEW_TEST_AUTHORITY"])
        server = json.loads(authority.read_text())
        server.update(reviewer="thr_" + "1" * 32, text=evidence.read_text())
        authority.write_text(json.dumps(server))  # Preserve the actual original owner anchor.
        self.env["REVIEW_TEST_THREAD"] = "thr_" + "3" * 32
        self.assertEqual(self.classify(evidence, owner=True)[0], 2)

    def test_two_actual_results_allow_import_from_another_caller_context(self) -> None:
        evidence = self.native_metadata_review()
        self.env["REVIEW_TEST_THREAD"] = "thr_" + "3" * 32
        self.assertEqual(self.classify(evidence)[0], 0)
        self.assertEqual(self.batch("check")[0], 0)

    def test_owner_anchor_is_refetched_and_binds_batch_authorship_and_chronology(self) -> None:
        evidence = self.native_metadata_review()
        self.assertEqual(self.classify(evidence)[0], 0)
        authority = Path(self.env["REVIEW_TEST_AUTHORITY"])
        original = authority.read_text()
        for field, value in (("status", "pending"), ("text", "{}"), ("turn", "wrong-turn"),
                             ("completedAt", 1), ("completedAt", int(time.time() * 1000) + 100000)):
            with self.subTest(field=field):
                server = json.loads(original)
                server["owner_anchor"][field] = value
                authority.write_text(json.dumps(server))
                self.assertEqual(self.batch("check")[0], 2)

    def test_changed_platform_runtime_invalidates_the_anchored_batch(self) -> None:
        evidence = self.native_metadata_review()
        self.assertEqual(self.classify(evidence)[0], 0)
        path = self.repo / ".context/deploy-approval-batch.json"
        state = json.loads(path.read_text())
        state["owner"]["runtime"] = {"changed": True}
        path.write_text(json.dumps(state))
        self.assertEqual(self.batch("check")[0], 2)


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
