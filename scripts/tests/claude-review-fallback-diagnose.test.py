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


def run(path: Path, summary: Path | None = None, outcome: str | None = None) -> str:
    env = {k: v for k, v in os.environ.items() if k != "GITHUB_STEP_SUMMARY"}
    if summary is not None:
        env["GITHUB_STEP_SUMMARY"] = str(summary)
    proc = subprocess.run([sys.executable, str(SCRIPT), str(path)] + ([outcome] if outcome else []), capture_output=True, text=True, env=env, timeout=30)
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


def test_ambiguous_status_does_not_prescribe_credential_or_quota_repair(tmp: Path) -> None:
    for status, message in ((403, "Permission denied for this resource"),
                            (429, "Temporary rate limit; retry after 10 seconds")):
        path = tmp / f"{status}.json"
        path.write_text(json.dumps({"type": "result", "is_error": True,
                                    "api_error_status": status, "result": message}))
        out = run(path)
        assert "diagnosis: PROVIDER_ERROR" in out, out
        assert "claude setup-token" not in out and "Step 9a" not in out, out


def test_explicit_error_evidence_supports_diagnosis(tmp: Path) -> None:
    for status, message, expected in (
        (403, "OAuth access token is invalid", "CREDENTIAL_INVALID"),
        (429, "Claude AI usage limit reached", "USAGE_EXHAUSTED"),
        (429, "You've hit your session limit", "USAGE_EXHAUSTED"),
        (429, "You’ve hit your session limit", "USAGE_EXHAUSTED"),
        (None, "Your credit balance is too low", "USAGE_EXHAUSTED"),
    ):
        path = tmp / "evidence.json"
        path.write_text(json.dumps({"type": "result", "is_error": True,
                                    "api_error_status": status, "result": message}))
        assert f"diagnosis: {expected}" in run(path)


def test_execution_limits_preserve_subtype_and_errors(tmp: Path) -> None:
    for subtype in ("error_max_turns", "error_max_budget_usd", "error_during_execution"):
        path = tmp / "limit.json"
        path.write_text(json.dumps({"type": "result", "is_error": True,
                                    "subtype": subtype, "errors": ["Execution stopped at configured limit"]}))
        out = run(path)
        assert "diagnosis: EXECUTION_ERROR" in out, out
        assert f"subtype={subtype}" in out and "Execution stopped at configured limit" in out, out
        assert "Provider/API error" not in out, out


def test_success_prints_no_review_content(tmp: Path) -> None:
    path = tmp / "ok.json"
    path.write_text(json.dumps([{"type": "result", "is_error": False, "result": "SECRET REVIEW BODY"}]))
    out = run(path)
    assert "diagnosis: OK" in out and "SECRET REVIEW BODY" not in out, out


def test_action_failure_overrides_successful_cli(tmp: Path) -> None:
    path = tmp / "success.json"
    path.write_text(json.dumps({"type": "result", "is_error": False, "result": "PRIVATE REVIEW"}))
    for outcome, expected in (("failure", "EXECUTION_ERROR"), ("success", "OK")):
        out = run(path, outcome=outcome)
        assert f"diagnosis: {expected}" in out, out
        assert "PRIVATE REVIEW" not in out
    assert "REVIEW_OUTCOME: ${{ steps.review.outcome }}" in WORKFLOW.read_text()


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
    assert 'python3 -I "$GITHUB_WORKSPACE/.trusted-review/scripts/claude_review_fallback_diagnose.py" "$EXECUTION_FILE"' in wf
    assert "ref: ${{ github.event.repository.default_branch }}" in wf
    assert "path: .trusted-review" in wf
    assert "persist-credentials: false" in wf
    assert "if: ${{ false }}" in wf, "the retired fallback must remain disabled"
    deploy = DEPLOY.read_text()
    assert "Diagnose Claude failure" in deploy and "CREDENTIAL_INVALID" in deploy
    assert "~2s + 1 turn + $0 = provider-blocked" not in deploy, "signature alone must not imply exhaustion"


def main() -> int:
    tests = [test_action_failure_overrides_successful_cli, test_revoked_oauth_token_is_credential_invalid, test_429_is_usage_exhausted_jsonl,
             test_success_prints_no_review_content, test_other_and_missing, test_workflow_and_deploy_wiring,
             test_ambiguous_status_does_not_prescribe_credential_or_quota_repair,
             test_explicit_error_evidence_supports_diagnosis, test_execution_limits_preserve_subtype_and_errors]
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
