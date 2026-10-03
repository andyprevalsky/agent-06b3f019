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
mod._probe_recording_view_url = lambda url, timeout=20.0: url.startswith("https://ok/")
mod._probe_recording_file_pointer = (
    lambda agent_id, pointer, timeout=30.0: isinstance(pointer, dict)
    and pointer.get("id") == "fp-ok"
)


def msg(**meta: Any) -> dict:
    return {"role": "TOOL", "message": "x", "metadata": meta}


agent = "00000000-0000-4000-8000-000000000001"

# The browser verifier checks both rendered roles. Markdown progress headings
# become plain text in the page, and hidden messages must not count.
snippets = mod.visible_transcript_snippets(
    [
        {"role": "USER", "text": "Raise the round for Rose Labs"},
        {"role": "ASSISTANT", "text": "**Setting the plan**\n\n"},
        {"role": "ASSISTANT", "text": "private hidden reply", "metadata": {"hidden": True}},
    ]
)
assert snippets == {
    "user": ["Raise the round for Rose Labs"],
    "assistant": ["Setting the plan"],
}, snippets

literal_snippets = mod.visible_transcript_snippets(
    [
        {"role": "USER", "text": "Investigate foo_bar failure"},
        {"role": "ASSISTANT", "text": "**Inspect `foo_bar` before retrying**"},
    ]
)
assert literal_snippets == {
    "user": ["Investigate foo_bar failure"],
    "assistant": ["Inspect foo_bar before retrying"],
}, literal_snippets

fe_url = mod.durable_fe_url(agent, agent, "run.signature")
assert "?agent-id=" in fe_url and "#benchmark-share=run.signature" in fe_url, fe_url
assert "benchmark-share=" not in fe_url.split("#", 1)[0], fe_url

list_snippets = mod.visible_transcript_snippets(
    [
        {"role": "USER", "text": "1. Open the benchmark link"},
        {"role": "ASSISTANT", "text": "- [Inspect the run](https://example.com/run) before retrying"},
    ]
)
assert list_snippets == {
    "user": ["Open the benchmark link"],
    "assistant": ["Inspect the run before retrying"],
}, list_snippets

# The root FE transcript nests a sub-agent's stream inside its collapsed card,
# so those rows are not page text (prod agent 96de1863-fd9d-40cd-9978-348643222007).
sub_agent_snippets = mod.visible_transcript_snippets(
    [
        {"role": "USER", "text": "Use a browser agent to complete checkout"},
        {"role": "ASSISTANT", "text": "", "metadata": {"tool_calls": [{"id": "c1"}]}},
        {
            "role": "ASSISTANT",
            "text": "Let's start by reading the current state of the browser",
            "metadata": {"streamId": "s1", "subAgentId": "browser-task-1"},
        },
        {
            "role": "ASSISTANT",
            "text": "Checkout finished on the root transcript",
            "metadata": '{"subAgentId": null}',
        },
    ]
)
assert sub_agent_snippets == {
    "user": ["Use a browser agent to complete checkout"],
    "assistant": ["Checkout finished on the root transcript"],
}, sub_agent_snippets

only_sub_agent_snippets = mod.visible_transcript_snippets(
    [
        {"role": "USER", "text": "Use a browser agent to complete checkout"},
        {
            "role": "ASSISTANT",
            "text": "We are on the test checkout page for payment",
            "metadata": '{"subAgentId": "browser-task-1"}',
        },
    ]
)
assert only_sub_agent_snippets == {
    "user": ["Use a browser agent to complete checkout"],
    "assistant": [],
}, only_sub_agent_snippets

# No browser tasks → pass
assert mod.validate_browser_agents_terminated_with_recording(agent, []) == []

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
mod._probe_recording_view_url = lambda url, timeout=20.0: False
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
