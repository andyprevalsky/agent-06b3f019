#!/usr/bin/env bash
# Cement FE-link browser validation: every spawn_browser_agent task must be
# terminated (task_complete) with a correctly attached recording.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="$ROOT_DIR/agents/venv/bin/python"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN="$(command -v python3)"
fi

"$PYTHON_BIN" - <<'PY'
from __future__ import annotations

import importlib.util
import io
import json
import os
import shutil
import subprocess
import tempfile
import threading
import urllib.request
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.response import addinfourl

path = Path("scripts/publish_evidence_links.py")
spec = importlib.util.spec_from_file_location("publish_evidence_links", path)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)
dual_spec = importlib.util.spec_from_file_location(
    "dual_write_route_control", Path("scripts/dual_write_claude_code_sessions.py")
)
dual_mod = importlib.util.module_from_spec(dual_spec)
assert dual_spec.loader is not None
dual_spec.loader.exec_module(dual_mod)

# Exercise the production opener and probe without creating a socket. The
# terminal transport sees the route after urllib's real ProxyHandler runs.
def check_inherited_proxy_routing() -> None:
    proxy_keys = tuple(
        key for stem in ("HTTP", "HTTPS", "ALL", "NO")
        for key in (stem + "_PROXY", stem.lower() + "_proxy")
    )
    before = {key: os.environ.get(key) for key in proxy_keys}
    requests = []
    session_output = "synthetic-session-output-with-at-least-32-characters"

    class SyntheticTransport(urllib.request.BaseHandler):
        handler_order = 400

        def http_open(self, request):
            requests.append((request.full_url, request.host, request.get_method()))
            headers = Message()
            redirect = request.full_url.startswith("http://localhost:8766/redirect")
            if redirect:
                headers["Location"] = "https://evidence.example.invalid/redirected"
            response = addinfourl(
                io.BytesIO(json.dumps({"output": session_output}).encode()),
                headers, request.full_url, 302 if redirect else 200,
            )
            response.msg = "OK"
            return response

        https_open = http_open

    build_opener = urllib.request.build_opener

    def isolated_opener(*handlers):
        return build_opener(*handlers, SyntheticTransport())

    cases = (
        ("http://evidence.example.invalid/recording", "fixture-proxy.invalid:8765"),
        ("https://evidence.example.invalid/recording", "fixture-proxy.invalid:8765"),
        ("https://localhost.external.invalid/recording", "fixture-proxy.invalid:8765"),
        ("http://localhost:8766/recording", "localhost:8766"),
        ("http://127.0.0.1:8766/recording", "127.0.0.1:8766"),
        ("http://[::1]:8766/recording", "[::1]:8766"),
        ("https://bypass.example.invalid/recording", "bypass.example.invalid"),
    )
    with (
        patch.object(urllib.request, "build_opener", isolated_opener),
        patch.object(
            urllib.request, "getproxies",
            return_value={
                "http": "http://fixture-proxy.invalid:8765",
                "https": "http://fixture-proxy.invalid:8765",
            },
        ),
        patch.object(
            urllib.request, "proxy_bypass",
            side_effect=lambda host: host == "bypass.example.invalid",
        ),
    ):
        for url, expected in cases:
            assert mod._probe_recording_view_url(url, timeout=1)
        for url, expected in cases[:3]:
            request = urllib.request.Request(url, data=b"synthetic-probe", method="POST")
            with mod._opener().open(request, timeout=1) as response:
                assert response.status == 200
        assert mod._probe_recording_view_url("http://localhost:8766/redirect", timeout=1)
        for url, expected in cases + (("http://localhost:8766/redirect", "localhost:8766"),):
            with (
                patch.object(dual_mod, "load_backend_env", return_value={}),
                patch.object(
                    dual_mod.os, "getenv",
                    side_effect=lambda key, default=None: {
                        "BENCHMARK_HUB_UPLOAD_URL": url,
                        "BACKEND_API_KEY": "fixture-key",
                    }.get(key, default),
                ),
            ):
                assert dual_mod.verify_session_on_hub("fixture-session") == len(session_output)
    assert {key: os.environ.get(key) for key in proxy_keys} == before
    expected_routes = cases + cases[:3] + (
        ("http://localhost:8766/redirect", "localhost:8766"),
        ("https://evidence.example.invalid/redirected", "fixture-proxy.invalid:8765"),
    )
    helper_routes = tuple(
        (url + "/api/claude-code-session/fixture-session", expected)
        for url, expected in cases
    ) + (
        ("http://localhost:8766/redirect/api/claude-code-session/fixture-session", "localhost:8766"),
        ("https://evidence.example.invalid/redirected", "fixture-proxy.invalid:8765"),
    )
    assert len(requests) == len(expected_routes) + len(helper_routes)
    results = [
        {"url": url, "expected_route_used": host == expected, "method": method}
        for (url, host, method), (_, expected)
        in zip(requests[:len(expected_routes)], expected_routes, strict=True)
    ]
    assert all(row["expected_route_used"] for row in results), (
        "publisher lost configured/default external proxy routing", results
    )
    helper_results = [
        {"url": url, "expected_route_used": host == expected, "method": method}
        for (url, host, method), (_, expected)
        in zip(requests[len(expected_routes):], helper_routes, strict=True)
    ]
    assert all(row["expected_route_used"] for row in helper_results), (
        "dual-write verifier lost configured/default external proxy routing", helper_results
    )


check_inherited_proxy_routing()

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
        }), text=True, capture_output=True, env=environment, timeout=60,
    )
    assert result.returncode == 1, result.returncode
    assert result.stdout == "backend-playwright-imported\n", result.stderr
    assert result.stderr.strip() == "STOP-before-browser-allocation", result.stderr

# Avoid network probes in unit checks: stub URL/pointer reachability.
setattr(mod, "_probe_recording_view_url", lambda url, timeout=20.0: url.startswith("https://ok/"))
setattr(
    mod,
    "_probe_recording_file_pointer",
    lambda agent_id, pointer, timeout=30.0: isinstance(pointer, dict)
    and pointer.get("id") == "fp-ok",
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

# Adjacent Markdown delimiter runs can be literal text inside emphasis. The
# verifier must preserve what the browser renders, not concatenate across them.
for source, rendered in (
    ("**Inspect the completed run****before recording evidence**",
     "Inspect the completed run****before recording evidence"),
    ("**Inspect the completed run** and **record the evidence**",
     "Inspect the completed run and record the evidence"),
    ("`Inspect **literal** delimiters` before recording evidence",
     "Inspect **literal** delimiters before recording evidence"),
    ("Inspect the &amp; symbol before recording evidence",
     "Inspect the & symbol before recording evidence"),
    (r"\*\*Inspect the escaped heading\*\*\nNext visible line",
     "Inspect the escaped heading"),
    ("~~Inspect the old evidence~~ before [checking](https://example.com)",
     "Inspect the old evidence before checking"),
    ("Short line\nA complete visible phrase on the next line",
     "A complete visible phrase on the next line"),
    ("![Invisible image description](https://example.com/image.png)\n\n"
     "Visible text after the image", "Visible text after the image"),
    ("| Completed benchmark evidence | Result |\n| --- | --- |\n| Receipt | Ready |",
     "Completed benchmark evidence"),
):
    assert mod.visible_transcript_snippets([
        {"role": "ASSISTANT", "text": source},
    ]) == {"user": [], "assistant": [rendered[:60]]}

# USER and assistant attachment bubbles render literal text, not Markdown.
literal = r"**Inspect the &amp; symbol** before retrying\nKeep this text"
for role, attachment in (("USER", None), ("ASSISTANT", {"id": "fixture"})):
    expected = {"user": [], "assistant": []}
    expected[role.lower()] = [literal[:60]]
    assert mod.visible_transcript_snippets([
        {"role": role, "text": literal, "file_pointer": attachment},
    ]) == expected

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
    "user": ["1. Open the benchmark link"],
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

# Sub-agent stream rows (browser-use reasoning) render inside the collapsed
# sub-agent panel, not the root transcript the share link opens.
nested_snippets = mod.visible_transcript_snippets(
    [
        {"role": "USER", "text": "Buy the three named products at checkout"},
        {
            "role": "ASSISTANT",
            "text": "I'm on the checkout page and the cart is ready",
            "metadata": '{"subAgentId": "6d61c149-db71-5ee1-9f87-5d9dc6f1a1d3"}',
        },
        {"role": "ASSISTANT", "text": "Order tp_57735378 is confirmed"},
    ]
)
assert nested_snippets == {
    "user": ["Buy the three named products at checkout"],
    "assistant": ["Order tp_57735378 is confirmed"],
}, nested_snippets

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
preparation = {
    "version": 1, "agent_id": agent, "task_id": "preparation-task",
    "tool_call_id": "preparation-call", "session_id": "preparation-session",
    "provider": "steel", "phase": "initial_session_preparation",
    "init_acknowledged": True, "task_actions_started": False,
}
preparation_messages = [msg(
    toolName="spawn_browser_agent", action_type="task_complete", toolStatus="FINISHED",
    task_id="preparation-task", toolCallId="preparation-call", excludeFromModel=True,
    browser_preparation_cancellation=preparation,
)]
owned_session = {"agent_id": agent, "provider": "steel", "session_id": "preparation-session"}
closed_snapshot = {
    "root_exists": True, "root_deleted": True, "tree_agent_ids": [agent],
    "browser_sessions": [owned_session],
}
preparation_bundle = {"run_id": "preparation-owned", "tasks": [{"agent_id": agent, "logs": {
    "messages": preparation_messages,
    "browser_preparation_cancellation_receipt": {
        "root_agent_id": agent, "tree_agent_ids": [agent],
        "task_ids_by_agent": {agent: ["preparation-task"]},
        "receipts": {"preparation-task": preparation}, "archive_browser_sessions": [owned_session],
    },
    "cloud_cleanup_evidence": {"after": closed_snapshot, "final": closed_snapshot, "errors": []},
    "cloud_provider_cleanup": {
        "root_agent_id": agent, "tree_sealed": True, "root_deleted": True,
        "provider_receipts": [{"provider": "steel", "session_id": "preparation-session", "status": 200}],
    },
}}]}
allowed_preparation = mod.verified_preparation_cancelled_tasks(preparation_bundle, agent)
assert allowed_preparation == {"preparation-task"}
assert mod.validate_browser_agents_terminated_with_recording(
    agent, preparation_messages, preparation_cancelled_task_ids=allowed_preparation,
) == []
assert mod.validate_browser_agents_terminated_with_recording(agent, preparation_messages)
assert mod.validate_browser_agents_terminated_with_recording(
    agent, preparation_messages + [msg(toolName="spawn_browser_agent", task_id="preparation-task",
                                    action_type="task_started", toolStatus="FINISHED")],
    preparation_cancelled_task_ids=allowed_preparation,
)
for poison in ("native-close", "foreign-owner", "unknown-phase", "unidentified-action", "malformed-task-map"):
    poisoned = copy.deepcopy(preparation_bundle)
    plogs = poisoned["tasks"][0]["logs"]
    if poison == "native-close":
        plogs["cloud_provider_cleanup"]["provider_receipts"] = []
    elif poison == "foreign-owner":
        plogs["cloud_cleanup_evidence"]["final"]["browser_sessions"][0]["agent_id"] = "foreign"
    elif poison == "unknown-phase":
        plogs["messages"][0]["metadata"]["browser_preparation_cancellation"]["init_acknowledged"] = False
    elif poison == "unidentified-action":
        plogs["messages"].append(msg(task_id="preparation-task", action_type="task_started"))
    else:
        plogs["browser_preparation_cancellation_receipt"]["task_ids_by_agent"] = []
    try:
        mod.verified_preparation_cancelled_tasks(poisoned, agent)
    except SystemExit:
        pass
    else:
        raise AssertionError(f"preparation cancellation accepted {poison}")

# A missing root entry uses the original root transcript; a present malformed
# entry must never borrow it. All nested cancellation containers fail explicitly.
with_tree = copy.deepcopy(preparation_bundle)
with_tree["tasks"][0]["logs"]["tree"] = {agent: {"messages": preparation_messages}}
assert mod.verified_preparation_cancelled_tasks(with_tree, agent) == {"preparation-task"}
without_root = copy.deepcopy(preparation_bundle)
without_root["tasks"][0]["logs"]["tree"] = {"other-root": {"messages": []}}
assert mod.verified_preparation_cancelled_tasks(without_root, agent) == {"preparation-task"}
malformed_failures = []
for boundary in ("tree", "tree-root", "cleanup", "provider", "after", "final", "tree-ids", "native-receipts"):
    for malformed in ([], ["malformed"], "malformed", False, 1):
        poisoned = copy.deepcopy(preparation_bundle)
        plogs = poisoned["tasks"][0]["logs"]
        if boundary == "tree":
            plogs["tree"] = malformed
        elif boundary == "tree-root":
            plogs["tree"] = {agent: malformed}
        elif boundary == "cleanup":
            plogs["cloud_cleanup_evidence"] = malformed
        elif boundary == "provider":
            plogs["cloud_provider_cleanup"] = malformed
        elif boundary in ("after", "final"):
            plogs["cloud_cleanup_evidence"][boundary] = malformed
        elif boundary == "tree-ids":
            plogs["cloud_cleanup_evidence"]["final"]["tree_agent_ids"] = malformed
        else:
            plogs["cloud_provider_cleanup"]["provider_receipts"] = malformed
        try:
            mod.verified_preparation_cancelled_tasks(poisoned, agent)
        except SystemExit as error:
            assert str(error) == "invalid exact pre-action browser cancellation receipt"
        except Exception as error:
            malformed_failures.append((boundary, repr(malformed), type(error).__name__))
        else:
            malformed_failures.append((boundary, repr(malformed), "accepted malformed evidence"))
assert not malformed_failures, malformed_failures

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
# Claude Code lifecycle events use task_started/task_complete too, but have no
# browser session or recording. They must not be treated as browser tasks.
claude_code_messages = [
    msg(
        task_id="code-1",
        toolName="spawn_claude_code_agent",
        action_type="task_started",
        toolStatus="FINISHED",
    ),
    msg(
        task_id="code-1",
        toolName="spawn_claude_code_agent",
        action_type="task_complete",
        toolStatus="FINISHED",
    ),
]
assert mod.validate_browser_agents_terminated_with_recording(agent, claude_code_messages) == []

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

# A pause/resume saves one recording per activity and the chip plays every
# part, so a broken pre-pause part fails even when the resumed part plays.
def paused_task(first_pointer: dict) -> list[dict]:
    return [
        msg(task_id="t3", toolName="spawn_browser_agent",
            action_type="task_complete", toolStatus="FINISHED"),
        msg(task_id="t3", toolName="spawn_browser_agent", action_type="recording",
            toolStatus="FINISHED", recording_file_pointer=first_pointer),
        msg(task_id="t3", toolName="spawn_browser_agent", action_type="recording",
            toolStatus="FINISHED",
            recording_file_pointer={"id": "fp-ok", "storage_path": "u/part-2.html"}),
    ]


failures = mod.validate_browser_agents_terminated_with_recording(
    agent, paused_task({"id": "fp-broken", "storage_path": "u/part-1.html"})
)
assert any("no correctly attached recording" in f for f in failures), failures
assert mod.validate_browser_agents_terminated_with_recording(
    agent, paused_task({"id": "fp-ok", "storage_path": "u/part-1.html"})
) == []
# A pre-pause part whose upload failed saved no source: that part is missing.
failures = mod.validate_browser_agents_terminated_with_recording(agent, paused_task(None))
assert any("no correctly attached recording" in f for f in failures), failures
# Every Kernel per-session segment the chip plays must be reachable too.
failures = mod.validate_browser_agents_terminated_with_recording(
    agent,
    [
        msg(task_id="t4", toolName="spawn_browser_agent",
            action_type="task_complete", toolStatus="FINISHED"),
        msg(task_id="t4", toolName="spawn_browser_agent", action_type="recording",
            toolStatus="FINISHED", recording_view_url="https://ok/seg-0.mp4",
            recording_view_urls=["https://ok/seg-0.mp4", "https://gone/seg-1.mp4"]),
    ],
)
assert any("no correctly attached recording" in f for f in failures), failures

# A Claude Code task shares task_started/task_complete action types but never
# records a browser, so it must not be held to the browser recording rule.
failures = mod.validate_browser_agents_terminated_with_recording(
    agent,
    [
        msg(
            task_id="cc1",
            toolName="spawn_claude_code_agent",
            action_type="claude_code_started",
            toolStatus="IN_PROGRESS",
        ),
        msg(
            task_id="cc1",
            toolName="spawn_claude_code_agent",
            action_type="task_started",
            toolStatus="FINISHED",
        ),
        msg(
            task_id="cc1",
            toolName="spawn_claude_code_agent",
            action_type="task_complete",
            toolStatus="FINISHED",
        ),
    ],
)
assert failures == [], failures

# A legacy browser row without toolName still counts as a browser task.
failures = mod.validate_browser_agents_terminated_with_recording(
    agent,
    [msg(task_id="t4", action_type="session_started", toolStatus="IN_PROGRESS")],
)
assert any("has not terminated" in f for f in failures), failures

# Dead view URL → fail recording
setattr(mod, "_probe_recording_view_url", lambda url, timeout=20.0: False)
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

# A lifecycle row without a tool name still counts as browser progress
failures = mod.validate_browser_agents_terminated_with_recording(
    agent,
    [msg(task_id="t4", action_type="task_complete", toolStatus="FINISHED")],
)
assert any("no correctly attached recording" in f for f in failures), failures

# Once an invalid response is observed, it must fail without another request or
# browser launch. Isolate delivery from socket scheduling: a 100ms transport
# timeout before the response arrives is a different, retryable boundary.
for fault in ("forbidden", "malformed"):
    for timeout_first in (False, True):
        requests = []

        class InvalidResponseTransport(urllib.request.BaseHandler):
            handler_order = 400

            def http_open(self, request):
                requests.append((request.get_header("Authorization"), request.timeout))
                if timeout_first and len(requests) == 1:
                    raise TimeoutError("fixture response not delivered")
                if fault == "forbidden":
                    raise urllib.error.HTTPError(
                        request.full_url, 403, "Forbidden", Message(), io.BytesIO(b"forbidden")
                    )
                response = addinfourl(
                    io.BytesIO(b"{"), Message(), request.full_url, 200
                )
                response.msg = "OK"
                return response

            https_open = http_open

        opener = urllib.request.build_opener(InvalidResponseTransport())
        with (
            patch.object(mod, "_opener", lambda: opener),
            patch.object(mod.subprocess, "run") as browser,
        ):
            try:
                mod.verify_agent_reachable(agent, "fixture.signature", timeout=0.1)
            except SystemExit as error:
                expected_cause = (
                    urllib.error.HTTPError if fault == "forbidden" else json.JSONDecodeError
                )
                assert isinstance(error.__cause__, expected_cause), (fault, error)
            else:
                raise AssertionError((fault, "invalid response was accepted"))
            assert requests == [("BenchmarkShare fixture.signature", 0.1)] * (
                2 if timeout_first else 1
            ), (fault, timeout_first, requests)
            browser.assert_not_called()

# Exercise actual socket timeouts separately. A fresh GET can recover stalled
# headers/body, while a persistent stall exhausts the unchanged two attempts.
for fault in ("headers-once", "body-once", "always", "always-late-receipt", "always-late-extra"):
    requests: list[str | None] = []
    receipt_condition = threading.Condition()
    observe_requests = threading.Event()
    if fault != "always-late-receipt":
        observe_requests.set()
    release = threading.Event()
    extra_arrived = threading.Event()
    extra_thread = None
    extra_result: list[Any] = []
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
                if self.headers.get("Authorization") == "BenchmarkShare fixture.extra":
                    extra_arrived.set()
                    assert release.wait(5), "fixture extra receipt was not released"
                # Model server scheduling after the client has already timed
                # out. Receipt collection is asynchronous to verifier return.
                assert observe_requests.wait(5), "fixture receipt observer was not released"
                with receipt_condition:
                    requests.append(self.headers.get("Authorization"))
                    receipt_condition.notify_all()
            stalled = is_api and (
                fault in {"always", "always-late-receipt", "always-late-extra"}
                or (len(requests) == 1 and fault.endswith("-once"))
            )
            try:
                if stalled and fault != "body-once":
                    release.wait(2)
                response = body
                self.send_response(200)
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
        if fault == "always-late-extra":
            # This test-owned third request cannot be recorded until cleanup.
            # A pre-join snapshot would incorrectly report only two receipts.
            def extra_request() -> None:
                request = urllib.request.Request(
                    f"{origin}/api/benchmarks/shared-agent/{agent}",
                    headers={"Authorization": "BenchmarkShare fixture.extra"},
                )
                try:
                    with mod._opener().open(request, timeout=5) as response:
                        response.read()
                        extra_result.append(response.status)
                except Exception as exc:
                    extra_result.append(exc)

            extra_thread = threading.Thread(target=extra_request)
            extra_thread.start()
            assert extra_arrived.wait(5), "fixture extra request did not arrive"
        expected_requests = 2 if recovered or fault.startswith("always") else 1
        # Client timeout does not join the server's receipt observer. Wait for
        # that independent fixture work, then compare a stable observation.
        with receipt_condition:
            observe_requests.set()
            assert receipt_condition.wait_for(lambda: len(requests) >= expected_requests, timeout=5), (
                fault,
                tuple(requests),
            )
        assert len(browser_calls) == int(recovered), fault
    finally:
        observe_requests.set()
        release.set()
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
        assert not thread.is_alive()
        if extra_thread is not None:
            extra_thread.join(timeout=5)
            assert not extra_thread.is_alive()
            assert extra_result == [200], extra_result

    # server_close joins every non-daemon request handler, including a late
    # extra request. Inspect the final immutable receipt only after that join.
    observed_requests = tuple(requests)
    expected_receipts = ("BenchmarkShare fixture.signature",) * expected_requests
    if fault == "always-late-extra":
        expected_receipts += ("BenchmarkShare fixture.extra",)
    assert observed_requests == expected_receipts, (
        fault,
        observed_requests,
    )

def check_fenced_recording_episode_provenance():
    from copy import deepcopy
    identity = dict(toolName="spawn_browser_agent", task_id="episode-task",
                    workflowGeneration="owned-generation",
                    browser_url="https://fixture.kernel.sh/browser/live/owned-session",
                    browser_session_metadata={"provider": "kernel", "profile_id": "owned-profile"})
    start = msg(**identity, action_type="recording", toolStatus="IN_PROGRESS",
                toolCallId="episode-start", recording_path="/owned/index.html")
    saved = msg(**identity, action_type="recording", toolStatus="FINISHED",
                toolCallId="episode-saved", recording_view_url="https://ok/recorded-part")
    terminal = msg(**identity, action_type="task_complete", toolStatus="FINISHED")
    fenced = msg(**identity, action_type="recording", toolStatus="FINISHED",
                 toolCallId="episode-start", recording_path="/owned/index.html",
                 error=True, errorCode="DEPLOY_INTERRUPTED", deploymentFenced=True)
    complete = [start, saved, terminal, fenced]
    assert mod.validate_browser_agents_terminated_with_recording(agent, complete) == [], (
        "a proven recorded episode's deployment diagnostic is not another saved media part")
    for field, value in (("task_id", "foreign-task"), ("workflowGeneration", "foreign-generation"),
                         ("browser_url", "https://fixture.kernel.sh/browser/live/foreign-session"),
                         ("toolCallId", "unknown-start")):
        bad = deepcopy(complete); bad[-1]["metadata"][field] = value
        assert mod.validate_browser_agents_terminated_with_recording(agent, bad), field
    for field in ("browser_url", "workflowGeneration"):
        bad = deepcopy(complete)
        for row in bad: row["metadata"].pop(field, None)
        assert mod.validate_browser_agents_terminated_with_recording(agent, bad), field
    for transform in ("no-start", "no-terminal", "unreachable", "placeholder-only", "unrecorded-resume"):
        bad = deepcopy(complete)
        if transform == "no-start": bad = bad[1:]
        elif transform == "no-terminal": bad.pop(2)
        elif transform == "unreachable": bad[1]["metadata"]["recording_view_url"] = "https://bad/unreachable"
        elif transform == "placeholder-only": bad[1]["metadata"].pop("recording_view_url")
        else:
            extra = deepcopy(start); extra["metadata"]["toolCallId"] = "unrecorded-resume"
            bad.insert(2, extra)
        assert mod.validate_browser_agents_terminated_with_recording(agent, bad), transform
    unknown = deepcopy(complete)
    for row in unknown: row["metadata"]["browser_session_metadata"]["provider"] = "unknown-provider"
    assert mod.validate_browser_agents_terminated_with_recording(agent, unknown)
    explicit = deepcopy(complete)
    for row in explicit:
        row["metadata"].pop("browser_url")
        row["metadata"]["browser_session_metadata"]["session_id"] = "native-session-a"
    assert mod.validate_browser_agents_terminated_with_recording(agent, explicit) == []
    explicit[2]["metadata"]["browser_session_metadata"] = {"provider": "kernel", "session_id": "native-session-b"}
    assert mod.validate_browser_agents_terminated_with_recording(agent, explicit), "foreign native session closed episode"
    other_start = deepcopy(start); other_start["metadata"]["toolCallId"] = "second-start"
    other_saved = deepcopy(saved); other_saved["metadata"]["recording_view_url"] = "https://ok/second-part"
    other_fenced = deepcopy(fenced); other_fenced["metadata"]["toolCallId"] = "second-start"
    assert mod.validate_browser_agents_terminated_with_recording(
        agent, [start, saved, other_start, other_saved, terminal, fenced, other_fenced]) == []
    for field, value in (("workflowGeneration", "new-generation"),
                         ("browser_url", "https://fixture.kernel.sh/browser/live/new-session")):
        extra = deepcopy(start); extra["metadata"][field] = value
        extra["metadata"]["toolCallId"] = "unrecorded-episode"
        assert mod.validate_browser_agents_terminated_with_recording(agent, complete + [extra]), field
    # A's terminal cannot close B, even if B already uploaded playable media.
    for task_started in (False, True):
        new_identity = dict(identity, browser_url="https://fixture.kernel.sh/browser/live/session-b")
        b_start = msg(**new_identity, action_type="recording", toolStatus="IN_PROGRESS",
                      toolCallId="b-start", recording_path="/b/index.html")
        b_saved = msg(**new_identity, action_type="recording", toolStatus="FINISHED",
                      recording_view_url="https://ok/b-recording")
        b_fenced = msg(**new_identity, action_type="recording", toolStatus="FINISHED",
                       toolCallId="b-start", recording_path="/b/index.html",
                       error=True, errorCode="DEPLOY_INTERRUPTED", deploymentFenced=True)
        prefix = [msg(**new_identity, action_type="task_started", toolStatus="IN_PROGRESS")] if task_started else []
        assert mod.validate_browser_agents_terminated_with_recording(
            agent, complete + prefix + [b_start, b_saved, b_fenced]), "earlier terminal closed later session B"
        foreign_terminal = msg(**identity, action_type="task_complete", toolStatus="FINISHED")
        assert mod.validate_browser_agents_terminated_with_recording(
            agent, complete + prefix + [b_start, b_saved, foreign_terminal, b_fenced]), "foreign session terminal closed B"
        b_terminal = msg(**new_identity, action_type="task_complete", toolStatus="FINISHED")
        assert mod.validate_browser_agents_terminated_with_recording(
            agent, complete + prefix + [b_start, b_terminal, b_saved, b_fenced]) == []


def check_tilion_recording_episode_provenance():
    from copy import deepcopy

    sessions = ["sess_" + digit * 32 for digit in ("a", "b")]

    def episode(session, call):
        identity = dict(toolName="spawn_browser_agent", task_id="tilion-task",
                        workflowGeneration="tilion-generation",
                        browser_session_metadata={"provider": "tilion"},
                        browser_url=f"https://back.tilion.dev/v1/session/{session}/live-view?token=REDACTED")
        start = msg(**identity, action_type="recording", toolStatus="IN_PROGRESS",
                    toolCallId=call, recording_path="/same/path/index.html")
        saved = msg(**identity, action_type="recording", toolStatus="FINISHED",
                    recording_view_url=f"https://ok/{call}")
        terminal = msg(**identity, action_type="task_complete", toolStatus="FINISHED")
        fenced = msg(**identity, action_type="recording", toolStatus="FINISHED",
                     toolCallId=call, recording_path="/same/path/index.html",
                     error=True, errorCode="DEPLOY_INTERRUPTED", deploymentFenced=True)
        return start, saved, terminal, fenced

    a, b = episode(sessions[0], "a-start"), episode(sessions[1], "b-start")
    complete = [*a[:3], *b[:3], a[3], b[3]]
    original = deepcopy(complete)
    assert mod.validate_browser_agents_terminated_with_recording(agent, complete) == [], (
        "Tilion native session URLs must distinguish saved episodes sharing a local path")
    assert complete == original, "validation must preserve every raw message"

    # URL tokens rotate; an explicit native handle and the URL name the same session.
    mixed = deepcopy(complete)
    for index, row in enumerate(mixed):
        meta = row["metadata"]
        session = sessions[0] if index in (0, 1, 2, 6) else sessions[1]
        meta["browser_url"] = meta["browser_url"].replace("REDACTED", f"rotated-{index}")
        if index % 2:
            meta["browser_session_metadata"]["session_id"] = session
            meta.pop("browser_url")
    assert mod.validate_browser_agents_terminated_with_recording(agent, mixed) == []

    unknown = deepcopy(mixed)
    for index, row in enumerate(unknown):
        meta = row["metadata"]
        meta["browser_session_metadata"] = {
            "provider": "unknown-provider", "session_id": sessions[0] if index in (0, 1, 2, 6) else sessions[1],
        }
        meta.pop("browser_url", None)
    assert mod.validate_browser_agents_terminated_with_recording(agent, unknown), "unknown explicit provider"

    bad = deepcopy(complete)
    bad[2]["metadata"].pop("browser_url")
    bad[2]["metadata"]["provider"] = "kernel"
    assert mod.validate_browser_agents_terminated_with_recording(agent, bad), "conflicting task-only terminal provider"

    for malformed in ({}, 0, False, ""):
        for index in (1, 2):
            bad = deepcopy(complete)
            bad[index]["metadata"]["session_id"] = malformed
            assert mod.validate_browser_agents_terminated_with_recording(agent, bad), "malformed explicit identity"

    for field, value in (("task_id", "foreign-task"), ("workflowGeneration", "foreign-generation"),
                         ("toolCallId", "unrelated-start"), ("recording_path", "/other/path"),
                         ("deploymentFenced", False), ("errorCode", "OTHER_ERROR"),
                         ("browser_url", f"https://back.tilion.dev/v1/session/{sessions[1]}/live-view")):
        bad = deepcopy(complete)
        bad[6]["metadata"][field] = value
        assert mod.validate_browser_agents_terminated_with_recording(agent, bad), field

    for transform in ("no-start", "no-close", "missing-first-media", "unreachable-first-media",
                      "unknown-episode", "conflicting-session", "conflicting-alias", "wrong-provider",
                      "conflicting-provider"):
        bad = deepcopy(complete)
        if transform == "no-start": bad.pop(0)
        elif transform == "no-close": bad.pop(2)
        elif transform == "missing-first-media": bad[1]["metadata"].pop("recording_view_url")
        elif transform == "unreachable-first-media": bad[1]["metadata"]["recording_view_url"] = "https://bad/media"
        elif transform == "unknown-episode":
            extra = episode("sess_" + "c" * 32, "unknown-start")[0]
            bad.append(extra)
        elif transform == "conflicting-session":
            bad[1]["metadata"]["browser_session_metadata"]["session_id"] = sessions[1]
        elif transform == "conflicting-alias":
            bad[1]["metadata"]["browser_session_metadata"].update(
                session_id=sessions[0], browser_session_id=sessions[1])
        elif transform == "conflicting-provider": bad[1]["metadata"]["provider"] = "kernel"
        else: bad[1]["metadata"]["browser_session_metadata"]["provider"] = "kernel"
        assert mod.validate_browser_agents_terminated_with_recording(agent, bad), transform

    suffix = f"/v1/session/{sessions[0]}/live-view"
    for url in ("https://evilback.tilion.dev" + suffix,
                "https://back.tilion.dev.evil.example" + suffix,
                "https://back.tilion.dev@evil.example" + suffix,
                "https://user@back.tilion.dev" + suffix,
                "http://back.tilion.dev" + suffix,
                "https://back.tilion.dev:444" + suffix,
                "https://back.tilion.dev/v1/session/malformed/live-view",
                "https://back.tilion.dev" + suffix + "/extra"):
        bad = deepcopy(complete)
        for index in (0, 1, 2, 6): bad[index]["metadata"]["browser_url"] = url
        assert mod.validate_browser_agents_terminated_with_recording(agent, bad), url


with patch.object(mod, "_probe_recording_view_url", lambda url, timeout=20.0: url.startswith("https://ok/")):
    check_fenced_recording_episode_provenance()
    check_tilion_recording_episode_provenance()
print("publish_evidence_links browser validation checks passed")
PY
