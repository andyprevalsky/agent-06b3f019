#!/usr/bin/env bash
# Cement FE-link browser validation: every spawn_browser_agent task must be
# terminated (task_complete) with a correctly attached recording.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

python3 - <<'PY'
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest.mock import patch

path = Path("scripts/publish_evidence_links.py")
spec = importlib.util.spec_from_file_location("publish_evidence_links", path)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)

# Run the real verifier with only the declared backend package available.
# Stop at launch so this control cannot allocate a browser or reach the network.
with tempfile.TemporaryDirectory(prefix="benchmark-share-import-") as temporary:
    fixture = Path(temporary)
    script = fixture / "scripts" / "verify_benchmark_share_link.cjs"
    script.parent.mkdir()
    shutil.copy2(Path("scripts/verify_benchmark_share_link.cjs"), script)
    backend = fixture / "back-end"
    package = backend / "node_modules" / "playwright"
    package.mkdir(parents=True)
    (backend / "package.json").write_text("{}")
    (package / "index.js").write_text(
        "exports.chromium = {launch: async () => {"
        "process.stdout.write('backend-playwright-imported\\n');"
        "throw new Error('STOP-before-browser-allocation');}};"
    )
    environment = dict(os.environ)
    environment.pop("NODE_PATH", None)
    result = subprocess.run(
        ["node", str(script)], input=json.dumps({
            "url": "https://example.invalid/", "agentId": "import-control",
            "snippets": {"user": [], "assistant": []},
        }), text=True, capture_output=True, env=environment, timeout=5,
    )
    assert result.returncode == 1, result.returncode
    assert result.stdout == "backend-playwright-imported\n", result.stderr
    assert result.stderr.strip() == "STOP-before-browser-allocation", result.stderr

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

# A root recording keeps nested browser reasoning in its browser panel. Those
# messages must not crowd out the actual root transcript's visible phrases.
scoped_messages = [
    {"role": "USER", "text": "Review the completed browser recording"},
    *[
        {
            "role": "ASSISTANT",
            "text": f"Nested browser reasoning step {i}",
            "metadata": {"subAgentId": "browser-task", "streamId": f"stream-{i}"},
        }
        for i in range(12)
    ],
    {
        "role": "USER",
        "text": "Nested browser task instructions",
        "metadata": json.dumps({"subAgentId": "browser-task"}),
    },
    {
        "role": "ASSISTANT",
        "text": "Root transcript remains visible",
        "metadata": json.dumps({"subAgentId": None}),
    },
    {
        "role": "ASSISTANT",
        "text": "Empty scope still belongs to a child",
        "metadata": {"subAgentId": ""},
    },
    {
        "role": "ASSISTANT",
        "text": "Visible exploration progress",
        "metadata": {"subAgentId": "explore-task", "agentType": "explore"},
    },
    {
        "role": "ASSISTANT",
        "text": "Hidden exploration progress",
        "metadata": {
            "subAgentId": "explore-task",
            "agentType": "explore",
            "hidden": True,
        },
    },
    {
        "role": "ASSISTANT",
        "text": "Code lifecycle anchor stays on root",
        "metadata": {
            "subAgentId": "code-task",
            "toolName": "spawn_claude_code_agent",
            "action_type": "task_complete",
        },
    },
]
assert mod.visible_transcript_snippets(scoped_messages) == {
    "user": ["Review the completed browser recording"],
    "assistant": [
        "Root transcript remains visible",
        "Visible exploration progress",
        "Code lifecycle anchor stays on root",
    ],
}
assert mod.visible_transcript_snippets(scoped_messages[:13]) == {
    "user": ["Review the completed browser recording"],
    "assistant": [],
}

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

# A cloud-owned browser call cancelled before session allocation has no video
# to attach. The exact root's three database reads and terminal provider
# receipt must all prove zero sessions before this narrow exception applies.
zero_messages = [
    msg(toolName="spawn_browser_agent", action_type="session_starting", toolStatus="IN_PROGRESS"),
    {"role": "TOOL", "message": "User paused the browser agent", "metadata": {
        "toolName": "spawn_browser_agent", "action_type": "task_complete",
        "toolStatus": "ERROR", "task_id": "zero-task",
    }},
]
zero_snapshot = {"root_exists": True, "tree_agent_ids": [agent], "browser_sessions": []}
bundle = {"run_id": "zero-owned", "tasks": [{"agent_id": agent, "logs": {
    "messages": zero_messages,
    "browser_zero_allocation_receipt": {
        "root_agent_id": agent, "task_ids": ["zero-task"], "tree_agent_ids": [agent],
        "task_ids_by_agent": {agent: ["zero-task"]},
        "before_browser_sessions": [], "archive_browser_sessions": [],
    },
    "cloud_cleanup_evidence": {
        "before": zero_snapshot, "after": zero_snapshot, "final": zero_snapshot,
        "errors": [], "provider_receipts": [],
    },
    "cloud_provider_cleanup": {
        "tree_sealed": True, "root_deleted": True, "provider_receipts": [],
    },
}}]}
allowed = mod.verified_zero_session_tasks(bundle, agent)
assert allowed == {"zero-task"}, allowed
assert mod.validate_browser_agents_terminated_with_recording(
    agent, zero_messages, zero_session_task_ids=allowed,
) == []
assert any("no correctly attached recording" in f for f in
    mod.validate_browser_agents_terminated_with_recording(agent, zero_messages))
assert any("no correctly attached recording" in f for f in
    mod.validate_browser_agents_terminated_with_recording(
        agent, zero_messages + [msg(toolName="spawn_browser_agent",
                                    action_type="session_init", task_id="zero-task",
                                    toolStatus="FINISHED")],
        zero_session_task_ids=allowed,
    ))
import copy
for changed in ("before", "after", "final"):
    poisoned = copy.deepcopy(bundle)
    poisoned["tasks"][0]["logs"]["cloud_cleanup_evidence"][changed]["browser_sessions"] = [
        {"provider": "kernel", "session_id": "session-present"}
    ]
    try:
        mod.verified_zero_session_tasks(poisoned, agent)
    except SystemExit:
        pass
    else:
        raise AssertionError(f"{changed} session allocation was accepted")

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

# Exercise actual socket timeouts at the public verifier boundary. A fresh GET
# can recover a stalled response, while persistent/auth/JSON failures stay closed.
for fault in ("headers-once", "body-once", "always", "forbidden", "malformed"):
    requests: list[str | None] = []
    release = threading.Event()
    body = json.dumps(
        {
            "messages": [
                {"role": "USER", "text": "Inspect the durable root transcript"},
            ]
        }
    ).encode()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args: Any) -> None:
            pass

        def do_GET(self) -> None:
            is_api = self.path.startswith("/api/benchmarks/shared-agent/")
            if is_api:
                requests.append(self.headers.get("Authorization"))
            stalled = is_api and (
                fault == "always" or (len(requests) == 1 and fault.endswith("-once"))
            )
            try:
                if stalled and fault != "body-once":
                    release.wait(2)
                response = b"{" if is_api and fault == "malformed" else body
                self.send_response(403 if is_api and fault == "forbidden" else 200)
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                if stalled and fault == "body-once":
                    self.wfile.write(response[:1])
                    self.wfile.flush()
                    release.wait(2)
                    response = response[1:]
                self.wfile.write(response)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = False
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01))
    thread.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    browser_calls: list[dict] = []

    def verify_browser(
        command: list[str], **kwargs: Any
    ) -> subprocess.CompletedProcess:
        assert command[0] == "node" and command[1].endswith(
            "verify_benchmark_share_link.cjs"
        )
        observed = json.loads(kwargs["input"])
        assert observed["snippets"] == {
            "user": ["Inspect the durable root transcript"],
            "assistant": [],
        }
        browser_calls.append(observed)
        return subprocess.CompletedProcess(command, 0, "", "")

    try:
        with (
            patch.object(mod, "DEFAULT_HUB", origin),
            patch.object(mod, "DURABLE_ORIGIN", origin),
            patch.object(mod.subprocess, "run", verify_browser),
        ):
            try:
                observed = mod.verify_agent_reachable(
                    agent, "fixture.signature", timeout=0.1
                )
            except SystemExit:
                observed = None
        recovered = fault.endswith("-once")
        assert observed == (("verified in fresh browser", 1) if recovered else None), (
            fault
        )
        expected_requests = 2 if recovered or fault == "always" else 1
        assert requests == ["BenchmarkShare fixture.signature"] * expected_requests, (
            fault,
            requests,
        )
        assert len(browser_calls) == int(recovered), fault
    finally:
        release.set()
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
        assert not thread.is_alive()

print("publish_evidence_links browser validation checks passed")
PY
