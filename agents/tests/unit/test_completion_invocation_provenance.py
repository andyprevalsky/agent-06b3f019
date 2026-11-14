"""Completion start evidence requires a native declaration and matching dispatch."""
import ast
import copy
from pathlib import Path
import textwrap

import pytest

from helpers.llm import build_verifier_context_messages


def declaration(origin="model", call_id="call-1", result=None):
    # Execute the actual metadata producer block, including synthetic handoff.
    source = (Path(__file__).resolve().parents[2] / "loop" / "run_agent.py").read_text()
    start = source.index("        assistant_metadata = {}", source.index("# 10. Persist assistant message"))
    end = source.index("        codex_reasoning_items =", start)
    namespace = {
        "assistant_tool_calls": [{"tool": "attempt_completion", "tool_call_id": call_id, "result": result}],
        "completed_child_output": None if origin == "model" else {"result": "child"},
    }
    exec(compile(ast.parse(textwrap.dedent(source[start:end])), "<metadata producer>", "exec"), namespace)
    return {"role": "ASSISTANT", "text": "", "metadata": namespace["assistant_metadata"]}


def started(call_id="call-1"):
    return {"role": "TOOL", "text": "", "metadata": {
        "toolName": "attempt_completion", "toolCallId": call_id, "toolStatus": "IN_PROGRESS",
    }}


def project(rows):
    import json
    before = copy.deepcopy(rows)
    messages = build_verifier_context_messages(rows, "system")
    assert rows == before
    return [json.loads(line.removeprefix("TOOL_INVOCATION "))
            for message in messages if isinstance(message.get("content"), str)
            for line in message["content"].splitlines() if line.startswith("TOOL_INVOCATION ")]


@pytest.mark.parametrize("scenario, count", [
    ("model", 1), ("automatic", 0), ("handoff", 0), ("interrupted", 0),
    ("repeat", 1), ("distinct", 2), ("conflicting-origin", 0), ("conflicting-args", 0),
    ("legacy", 0), ("wrong-start", 0), ("empty-id", 0), ("excluded", 0),
    ("started-error", 1),
])
def test_completion_invocation_provenance(scenario, count):
    model = declaration()
    progress = started()
    rows = [model, progress]
    if scenario == "automatic":
        rows = [progress]
    elif scenario == "handoff":
        rows = [declaration("handoff"), progress]
    elif scenario == "interrupted":
        rows = [model]
    elif scenario == "repeat":
        rows *= 2
    elif scenario == "distinct":
        rows += [declaration(call_id="call-2"), started("call-2")]
    elif scenario == "conflicting-origin":
        rows += [declaration("handoff")]
    elif scenario == "conflicting-args":
        rows += [declaration(result="different")]
    elif scenario == "legacy":
        model["metadata"].pop("tool_call_origin", None)
    elif scenario == "wrong-start":
        rows = [model, started("other")]
    elif scenario == "empty-id":
        rows = [declaration(call_id=""), started("")]
    elif scenario == "excluded":
        model["metadata"]["excludeFromModel"] = True
    elif scenario == "started-error":
        rows += [{"role": "TOOL", "text": "failed", "metadata": {
            "toolName": "attempt_completion", "toolCallId": "call-1", "toolStatus": "ERROR",
        }}]
    events = project(rows)
    assert len(events) == count
    assert all(set(event) == {"tool_name", "tool_call_id", "origin", "event"} for event in events)
    assert all(event["origin"] == "model" and event["event"] == "started" for event in events)
