#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

python3 - <<'PY'
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "publish_evidence_links", Path("scripts/publish_evidence_links.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

gate = "00000000-0000-4000-8000-000000000001"
post = "00000000-0000-4000-8000-000000000002"
def stage(root, text):
    messages = [{"role": "USER", "message": text}]
    return {"messages": messages, "tree": {root: {"parent_agent_id": None, "messages": messages}}}

bundle = {
    "run_id": "run-1",
    "summary": {"passed": 0, "failed": 1},
    "tasks": [{
        "name": "composite",
        "agent_id": gate + "," + post,
        "passed": False,
        "logs": {"gate": stage(gate, "gate prompt"), "post": stage(post, "post prompt")},
    }],
}
for root, label, prompt in ((gate, "gate", "gate prompt"), (post, "post", "post prompt")):
    projected = mod.evidence_bundle_for_agent(bundle, root)
    assert projected["run_id"] == f"run-1.evidence.{root}"
    assert projected["source"] == "durable-evidence-projection"
    assert projected["source_run_id"] == "run-1"
    assert len(projected["tasks"]) == 1
    task = projected["tasks"][0]
    assert task["agent_id"] == root
    assert task["name"] == f"composite [{label} evidence]"
    assert task["passed"] is False
    assert task["logs"]["messages"][0]["message"] == prompt
    assert task["message_count"] == task["tree_agent_count"] == 1
assert bundle["tasks"][0]["agent_id"] == gate + "," + post

direct = {"run_id": "direct", "tasks": [{"agent_id": gate, "logs": {"messages": []}}]}
assert mod.evidence_bundle_for_agent(direct, gate) is direct

missing = {**bundle, "tasks": [{**bundle["tasks"][0], "logs": {"gate": {"tree": {gate: {}}}}}]}
try:
    mod.evidence_bundle_for_agent(missing, gate)
except SystemExit as exc:
    assert "exactly one captured stage transcript" in str(exc)
else:
    raise AssertionError("missing transcript must fail closed")

print("publish_evidence_links composite projection checks passed")
PY
