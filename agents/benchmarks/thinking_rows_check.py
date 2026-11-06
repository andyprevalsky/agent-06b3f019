"""Thinking-row static check (C6/C21): what the user is shown for model thinking.

    run ends ─► check_thinking_rows(root_agent_id, base_url, api_key, user_id, evidence=…)
                  GET /api/agents/<root_agent_id>            (X-API-Key + X-User-Id)
                  ─► .messages (root rows + every code agent's transcript carriers)
                  ─► node front-end/scripts/check-thinking-rows.mjs <messages.json> <root> [evidence.json]
                       (the production FE projections, loaded through Vite)
                  ─► {"passed", "report", "failures", "notes", "detail"}

The FE check (front-end/src/features/terminal-component-group/benchmark/
thinkingRowsCheck.ts) holds the root and each code agent to this, on the same projections
and components the UI renders:
  * ROWS EXIST: every thinking row that carries a recorded generation is rendered through
    the production thought-row path and must show the lightbulb tool row, its duration,
    output tokens and tok/s (never the animated indicator), at a plausible rate (1–5,000
    tok/s). A row without a generation fails only when the run's records prove it should
    have one (a code agent with turn-scoped usage, i.e. Claude Code; a root whose run-agent
    thinking rows carry none). It is reported, not failed, when its producer cannot record
    one (a root chat-router or DAG row; Codex session-scoped usage).
  * NO ROWS: evidence of thinking (the CLI recorded thinking blocks, or the caller-supplied
    `evidence[agent_id]["reasoningTokens"]` > 0) with no row fails. Otherwise the agent is
    reported "no thinking recorded for <agent> (N/A)" in `notes`/`detail`, never a failure.
Nothing is estimated here or there. `detail` has one verdict line per agent for a scorecard.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import httpx

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONT_END = REPO_ROOT / "front-end"
CLI = "scripts/check-thinking-rows.mjs"


def _error(message: str) -> dict[str, Any]:
    return {"passed": False, "report": None, "failures": [message], "notes": [], "detail": []}


def check_thinking_rows_from_messages(
    messages: list[dict[str, Any]],
    root_agent_id: str,
    *,
    evidence: dict[str, dict[str, Any]] | None = None,
    timeout_s: float = 120.0,
) -> dict[str, Any]:
    """Run the FE check on the root agent's agent-detail messages.

    `evidence` maps an agent id (the root's id, or a code agent's task id) to
    ``{"reasoningTokens": N}`` taken from recorded usage; an agent with N > 0 must show
    thinking rows. Prerequisites (an actionable failure when missing, never a silent
    pass): `node` on PATH and the front-end dependencies installed (`front-end/node_modules`
    or the hoisted root `node_modules`, which provide `vite`).
    """
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump({"messages": messages}, handle)
        path = handle.name
    evidence_path = None
    if evidence:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(evidence, handle)
            evidence_path = handle.name
    try:
        completed = subprocess.run(
            ["node", CLI, path, root_agent_id, *([evidence_path] if evidence_path else [])],
            cwd=FRONT_END,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except FileNotFoundError:
        return _error("check-thinking-rows needs `node` on PATH (and front-end dependencies installed)")
    except subprocess.TimeoutExpired:
        return _error(f"check-thinking-rows timed out after {timeout_s:.0f}s")
    finally:
        Path(path).unlink(missing_ok=True)
        if evidence_path:
            Path(evidence_path).unlink(missing_ok=True)
    # 0 = ok, 1 = the check found failures; anything else (2 bad input, 3 or a node crash) is not a verdict.
    if completed.returncode in (0, 1):
        try:
            report = json.loads(completed.stdout)
        except json.JSONDecodeError:
            report = None
        if isinstance(report, dict) and "ok" in report:
            return {
                "passed": bool(report["ok"]),
                "report": report,
                "failures": list(report["failures"]),
                "notes": list(report.get("notes", [])),
                "detail": list(report.get("detail", [])),
            }
    return _error(f"check-thinking-rows exited {completed.returncode}: {completed.stderr.strip()[-2000:]}")


def check_thinking_rows(
    root_agent_id: str,
    *,
    base_url: str,
    api_key: str,
    user_id: str,
    evidence: dict[str, dict[str, Any]] | None = None,
    timeout_s: float = 120.0,
) -> dict[str, Any]:
    """Fetch a finished run's root agent and check its thinking rows."""
    response = httpx.get(
        f"{base_url.rstrip('/')}/api/agents/{root_agent_id}",
        headers={"X-API-Key": api_key, "X-User-Id": user_id},
        timeout=30.0,
    )
    response.raise_for_status()
    return check_thinking_rows_from_messages(
        response.json()["messages"], root_agent_id, evidence=evidence, timeout_s=timeout_s
    )
