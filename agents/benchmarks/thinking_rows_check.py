"""Thinking-row static check (C6): what the user is shown for model thinking.

    run ends ─► check_thinking_rows(root_agent_id, base_url, api_key, user_id)
                  GET /api/agents/<root_agent_id>            (X-API-Key + X-User-Id)
                  ─► .messages (root rows + every code agent's transcript carriers)
                  ─► node front-end/scripts/check-thinking-rows.mjs <messages.json> <root>
                       (the production FE projections, loaded through Vite)
                  ─► {"passed", "report", "failures"}

The FE check (front-end/src/features/terminal-component-group/benchmark/
thinkingRowsCheck.ts) asserts, on the same projections the UI renders:
  * root: thinking rows sit inside the work description, and at least one carries
    a recorded generation (the LLM call's output tokens over its measured window);
  * every code agent: its thinking records become thought rows, and at least one
    carries a generation bracketed by the session's own usage samples;
  * every recorded tok/s is plausible (1–5,000 tok/s).
Nothing is estimated here or there: a missing generation is a failure, not a guess.
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


def check_thinking_rows_from_messages(
    messages: list[dict[str, Any]], root_agent_id: str, *, timeout_s: float = 120.0
) -> dict[str, Any]:
    """Run the FE check on the root agent's agent-detail messages."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump({"messages": messages}, handle)
        path = handle.name
    try:
        completed = subprocess.run(
            ["node", CLI, path, root_agent_id],
            cwd=FRONT_END,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    finally:
        Path(path).unlink(missing_ok=True)
    if completed.returncode not in (0, 1):
        return {
            "passed": False,
            "report": None,
            "failures": [f"check-thinking-rows exited {completed.returncode}: {completed.stderr.strip()[-2000:]}"],
        }
    report = json.loads(completed.stdout)
    return {"passed": bool(report["ok"]), "report": report, "failures": list(report["failures"])}


def check_thinking_rows(
    root_agent_id: str, *, base_url: str, api_key: str, user_id: str, timeout_s: float = 120.0
) -> dict[str, Any]:
    """Fetch a finished run's root agent and check its thinking rows."""
    response = httpx.get(
        f"{base_url.rstrip('/')}/api/agents/{root_agent_id}",
        headers={"X-API-Key": api_key, "X-User-Id": user_id},
        timeout=30.0,
    )
    response.raise_for_status()
    return check_thinking_rows_from_messages(response.json()["messages"], root_agent_id, timeout_s=timeout_s)
