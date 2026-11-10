"""Exactly one ClaudeCodeSession row per code-agent spawn.

A spawn_claude_code_agent tool call (one toolCallId) must create exactly one
code-agent task row. Prod root 1a3d495c (2026-11-06) had three rows for one
spawn: the backend create took ~152 s, the agents client timed out at 60 s and
Temporal retried the create twice, each retry restarting the CLI.

Check config: {"type": "code_agent_one_session_per_spawn"}. Per tree agent,
the ClaudeCodeSession rows (GET /api/claude-code-session/agent/:id) must equal
its distinct spawn tool calls; fails closed when no spawn call or no session
evidence was read.
"""

from __future__ import annotations

CHECK_TYPE = "code_agent_one_session_per_spawn"


def check(evidence: dict, config: dict) -> tuple[bool, str]:
    calls = evidence.get("spawn_calls_by_agent") or {}
    sessions = evidence.get("sessions_by_agent") or {}
    creates: dict[str, int] = {}
    for create in evidence.get("backend_creates") or []:
        creates[str(create.get("agentId"))] = creates.get(str(create.get("agentId")), 0) + 1
    total_calls = sum(len(ids) for ids in calls.values())
    if total_calls == 0:
        return False, f"{CHECK_TYPE}: no spawn_claude_code_agent tool call in the agent tree"
    if not sessions:
        error = (evidence.get("sources") or {}).get("session_evidence_error")
        return False, f"{CHECK_TYPE}: no ClaudeCodeSession rows were read ({error or 'empty'})"
    failures, detail = [], []
    for agent_id in sorted(set(calls) | set(sessions)):
        n_calls, rows = len(calls.get(agent_id) or []), sessions.get(agent_id) or []
        detail.append(
            f"agent {agent_id[:8]}: {n_calls} spawn call(s), {len(rows)} session row(s),"
            f" {creates.get(agent_id, 0)} backend create(s)"
        )
        if len(rows) != n_calls:
            failures.append(
                f"agent {agent_id[:8]} has {len(rows)} ClaudeCodeSession row(s) for {n_calls} spawn call(s)"
                f" (rows {[str(row.get('id'))[:8] for row in rows]})"
            )
    if failures:
        return False, f"{CHECK_TYPE} failed: {'; '.join(failures)} || {'; '.join(detail)}"
    return True, f"{CHECK_TYPE} ok: {'; '.join(detail)}"
