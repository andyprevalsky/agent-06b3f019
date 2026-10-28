#!/usr/bin/env python3
"""Regression: a revoked Claude review OAuth token must not read as usage exhaustion.

RCA 2026-10-28: claude-code-review-fallback.yml failed every run since
2026-07-24 with `is_error:true, num_turns:1, ~2s, $0`, which /deploy Step 9a
classified as "usage exhaustion" and skipped. The fixture is the real result
message from Claude Code run locally with an invalid CLAUDE_CODE_OAUTH_TOKEN:
the identical signature, with `api_error_status: 401`. The workflow must
surface and classify it, and /deploy must treat 401 as a repairable credential.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "claude_review_fallback_diagnose.py"
FIXTURE = ROOT / "scripts" / "tests" / "fixtures" / "claude-review-fallback-401-execution.json"
WORKFLOW = ROOT / ".github" / "workflows" / "claude-code-review-fallback.yml"
DEPLOY = ROOT / ".claude" / "commands" / "deploy.md"


def run(path: Path, summary: Path | None = None) -> str:
    env = {k: v for k, v in os.environ.items() if k != "GITHUB_STEP_SUMMARY"}
    if summary is not None:
        env["GITHUB_STEP_SUMMARY"] = str(summary)
    proc = subprocess.run([sys.executable, str(SCRIPT), str(path)], capture_output=True, text=True, env=env, timeout=30)
    assert proc.returncode == 0, proc.stderr
    return proc.stdout


def test_revoked_oauth_token_is_credential_invalid(tmp: Path) -> None:
    result = json.loads(FIXTURE.read_text())[-1]
    # The exhaustion-looking signature /deploy used to rely on.
    assert result["is_error"] and result["num_turns"] == 1 and result["total_cost_usd"] == 0
    summary = tmp / "summary.md"
    out = run(FIXTURE, summary)
    assert out.startswith("::error::Claude review fallback diagnosis: CREDENTIAL_INVALID"), out
    assert "api_error_status=401" in out and "OAuth access token is invalid" in out, out
    assert "NOT usage exhaustion" in out and "claude setup-token" in out, out
    assert "CREDENTIAL_INVALID" in summary.read_text()


def test_429_is_usage_exhausted_jsonl(tmp: Path) -> None:
    path = tmp / "exec.jsonl"
    rows = [{"type": "system", "subtype": "init"},
            {"type": "result", "is_error": True, "num_turns": 1, "api_error_status": 429,
             "result": "Claude AI usage limit reached"}]
    path.write_text("\n".join(json.dumps(r) for r in rows))
    out = run(path)
    assert out.startswith("Claude review fallback diagnosis: USAGE_EXHAUSTED"), out
    assert "api_error_status=429" in out


def test_success_prints_no_review_content(tmp: Path) -> None:
    path = tmp / "ok.json"
    path.write_text(json.dumps([{"type": "result", "is_error": False, "result": "SECRET REVIEW BODY"}]))
    out = run(path)
    assert "diagnosis: OK" in out and "SECRET REVIEW BODY" not in out, out


def test_other_and_missing(tmp: Path) -> None:
    path = tmp / "500.json"
    path.write_text(json.dumps({"type": "result", "is_error": True, "api_error_status": 500, "result": "boom"}))
    assert "diagnosis: PROVIDER_ERROR" in run(path)
    assert "diagnosis: NO_RESULT" in run(tmp / "missing.json")


def test_workflow_and_deploy_wiring() -> None:
    wf = WORKFLOW.read_text()
    assert "id: review\n        uses: anthropics/claude-code-action@v1" in wf
    assert "if: failure() && steps.review.outcome == 'failure'" in wf
    assert "EXECUTION_FILE: ${{ steps.review.outputs.execution_file }}" in wf
    assert 'python3 scripts/claude_review_fallback_diagnose.py "$EXECUTION_FILE"' in wf
    deploy = DEPLOY.read_text()
    assert "Diagnose Claude failure" in deploy and "CREDENTIAL_INVALID" in deploy
    assert "~2s + 1 turn + $0 = provider-blocked" not in deploy, "signature alone must not imply exhaustion"


def main() -> int:
    tests = [test_revoked_oauth_token_is_credential_invalid, test_429_is_usage_exhausted_jsonl,
             test_success_prints_no_review_content, test_other_and_missing, test_workflow_and_deploy_wiring]
    for test in tests:
        with tempfile.TemporaryDirectory() as d:
            if test.__code__.co_argcount:
                test(Path(d))
            else:
                test()
        print(f"PASS {test.__name__}")
    print(f"All {len(tests)} Claude review fallback diagnosis checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
