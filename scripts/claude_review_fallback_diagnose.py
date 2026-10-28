#!/usr/bin/env python3
"""Classify a failed Claude review fallback run from its execution file.

claude-code-action hides the CLI output ("full output hidden for security"),
so a revoked OAuth token and an exhausted subscription both surface only as
``is_error:true, num_turns:1, ~2s, $0``. The SDK result message still records
``api_error_status`` and the error text; this prints them (error results only,
never review content) and classifies the failure so /deploy can tell a
repairable credential failure from provider usage exhaustion.

Usage: claude_review_fallback_diagnose.py [EXECUTION_FILE]
Defaults to $RUNNER_TEMP/claude-execution-output.json. Always exits 0: the
review step has already failed the job; this step only explains why.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Optional

CREDENTIAL_INVALID = "CREDENTIAL_INVALID"
USAGE_EXHAUSTED = "USAGE_EXHAUSTED"
PROVIDER_ERROR = "PROVIDER_ERROR"
NO_RESULT = "NO_RESULT"
OK = "OK"

REMEDIATION = {
    CREDENTIAL_INVALID: (
        "CLAUDE_CODE_OAUTH_TOKEN was rejected (repairable, NOT usage exhaustion). "
        "Mint a new token with `claude setup-token` and update the repository secret "
        "(user approval required for the secret write), then rerun this workflow."
    ),
    USAGE_EXHAUSTED: "Provider usage exhausted (HTTP 429); follow /deploy Step 9a usage-exhaustion clause.",
    PROVIDER_ERROR: "Provider/API error; inspect the message, repair and rerun (repairable).",
    NO_RESULT: "No Claude result message was recorded; the action failed before or outside the CLI run.",
    OK: "Claude review completed without an error result.",
}


def _messages(text: str) -> list[Any]:
    text = text.strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        out = []
        for line in text.splitlines():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out
    return data if isinstance(data, list) else [data]


def find_result(text: str) -> Optional[dict]:
    results = [m for m in _messages(text) if isinstance(m, dict) and m.get("type") == "result"]
    return results[-1] if results else None


def classify(result: Optional[dict]) -> str:
    if result is None:
        return NO_RESULT
    if result.get("is_error") is not True:
        return OK
    status = result.get("api_error_status")
    if status in (401, 403):
        return CREDENTIAL_INVALID
    if status == 429:
        return USAGE_EXHAUSTED
    return PROVIDER_ERROR


def report(result: Optional[dict], verdict: str) -> list[str]:
    lines = [f"Claude review fallback diagnosis: {verdict}"]
    if result is not None and verdict != OK:
        message = str(result.get("result") or "")[:500]
        lines.append(
            f"api_error_status={result.get('api_error_status')} "
            f"terminal_reason={result.get('terminal_reason')} "
            f"num_turns={result.get('num_turns')} duration_ms={result.get('duration_ms')} "
            f"total_cost_usd={result.get('total_cost_usd')}"
        )
        lines.append(f"error: {message}")
    lines.append(REMEDIATION[verdict])
    return lines


def main(argv: list[str]) -> int:
    default = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "claude-execution-output.json"
    path = Path(argv[1]) if len(argv) > 1 and argv[1] else default
    text = path.read_text(errors="replace") if path.is_file() else ""
    result = find_result(text)
    verdict = classify(result)
    lines = report(result, verdict)
    prefix = "::error::" if verdict in (CREDENTIAL_INVALID, PROVIDER_ERROR, NO_RESULT) else ""
    print(prefix + lines[0])
    for line in lines[1:]:
        print(line)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
