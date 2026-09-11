#!/usr/bin/env bash
# Cement FE-link browser validation: every spawn_browser_agent task must be
# terminated (task_complete) with a correctly attached recording.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

python3 - <<'PY'
from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

path = Path("scripts/publish_evidence_links.py")
spec = importlib.util.spec_from_file_location("publish_evidence_links", path)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)

# Avoid network probes in unit checks: stub URL/pointer reachability.
mod._probe_recording_view_url = lambda url, timeout=20.0: url.startswith("https://ok/")  # type: ignore[assignment]
mod._probe_recording_file_pointer = (  # type: ignore[assignment]
    lambda agent_id, pointer, timeout=30.0: isinstance(pointer, dict)
    and pointer.get("id") == "fp-ok"
)


def msg(**meta: Any) -> dict:
    return {"role": "TOOL", "message": "x", "metadata": meta}


agent = "00000000-0000-4000-8000-000000000001"

# No browser tasks → pass
assert mod.validate_browser_agents_terminated_with_recording(agent, []) == []

# Captured Claude Code lifecycle events share task_started/task_complete with
# browser agents, but a code terminal has no browser recording to attach.
code_messages = [
    msg(task_id="code-1", toolName="spawn_claude_code_agent",
        action_type="claude_code_started", toolStatus="IN_PROGRESS"),
    msg(task_id="code-1", toolName="spawn_claude_code_agent",
        action_type="task_started", toolStatus="FINISHED"),
    msg(task_id="code-1", toolName="code_agent_sdk_events",
        action_type="system", agentType="code", toolStatus="FINISHED"),
    msg(task_id="code-1", toolName="spawn_claude_code_agent",
        action_type="task_complete", toolStatus="FINISHED"),
]
assert mod.validate_browser_agents_terminated_with_recording(agent, code_messages) == []

# A code marker cannot hide browser evidence on the same task, regardless of
# event ordering. Unknown legacy lifecycle identities still fail closed.
for browser_start in (
    msg(task_id="code-1", toolName="spawn_browser_agent",
        action_type="browser", toolStatus="IN_PROGRESS"),
    msg(task_id="code-1", toolName="spawn_agent", agentType="browser",
        action_type="task_started", toolStatus="IN_PROGRESS"),
):
    for messages in ([browser_start, *code_messages], [*code_messages, browser_start]):
        failures = mod.validate_browser_agents_terminated_with_recording(agent, messages)
        assert any("no correctly attached recording" in f for f in failures), failures
failures = mod.validate_browser_agents_terminated_with_recording(
    agent, [msg(task_id="unknown", action_type="task_complete", toolStatus="FINISHED")]
)
assert any("no correctly attached recording" in f for f in failures), failures

# Explicit browser identity cannot bypass checks when action names evolve.
for identity in ({"agentType": "browser", "toolName": "spawn_agent"},
                 {"toolName": "spawn_browser_agent"}):
    for action in ("system", "future_action", ""):
        failures = mod.validate_browser_agents_terminated_with_recording(
            agent, [msg(task_id="identity-only", action_type=action, **identity)]
        )
        assert any("has not terminated" in f for f in failures), failures
        assert any("no correctly attached recording" in f for f in failures), failures

# Live browser without task_complete / recording → fail both
failures = mod.validate_browser_agents_terminated_with_recording(
    agent,
    [
        msg(
            task_id="t1",
            toolName="spawn_browser_agent",
            action_type="browser",
            toolStatus="IN_PROGRESS",
            title="Browser Agent In Progress",
        ),
        msg(
            task_id="t1",
            toolName="spawn_browser_agent",
            action_type="recording",
            toolStatus="IN_PROGRESS",
            title="Browser recording started",
        ),
    ],
)
assert any("has not terminated" in f for f in failures), failures
assert any("no correctly attached recording" in f for f in failures), failures

# Terminated + reachable view URL → pass
failures = mod.validate_browser_agents_terminated_with_recording(
    agent,
    [
        msg(
            task_id="t1",
            toolName="spawn_browser_agent",
            action_type="browser",
            toolStatus="IN_PROGRESS",
        ),
        msg(
            task_id="t1",
            toolName="spawn_browser_agent",
            action_type="task_complete",
            toolStatus="ERROR",
            title="Browser automation complete",
        ),
        msg(
            task_id="t1",
            toolName="spawn_browser_agent",
            action_type="recording",
            toolStatus="FINISHED",
            title="Browser recording saved",
            recording_view_url="https://ok/replay.mp4",
        ),
    ],
)
assert failures == [], failures

# Terminated + fetchable file pointer → pass
failures = mod.validate_browser_agents_terminated_with_recording(
    agent,
    [
        msg(
            task_id="t2",
            toolName="spawn_browser_agent",
            action_type="task_complete",
            toolStatus="FINISHED",
        ),
        msg(
            task_id="t2",
            toolName="spawn_browser_agent",
            action_type="recording",
            toolStatus="FINISHED",
            recording_file_pointer={"id": "fp-ok", "storage_path": "u/x.html"},
        ),
    ],
)
assert failures == [], failures

# Dead view URL → fail recording
mod._probe_recording_view_url = lambda url, timeout=20.0: False  # type: ignore[assignment]
failures = mod.validate_browser_agents_terminated_with_recording(
    agent,
    [
        msg(
            task_id="t3",
            toolName="spawn_browser_agent",
            action_type="task_complete",
            toolStatus="ERROR",
        ),
        msg(
            task_id="t3",
            toolName="spawn_browser_agent",
            action_type="recording",
            toolStatus="FINISHED",
            recording_view_url="https://dead/replay.mp4",
        ),
    ],
)
assert any("no correctly attached recording" in f for f in failures), failures

print("publish_evidence_links browser validation checks passed")
PY
