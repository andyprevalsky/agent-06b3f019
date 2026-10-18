#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

python3 - <<'PY'
import importlib.util
from pathlib import Path
from uuid import UUID

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
    projected_id = UUID(projected["run_id"])
    assert projected_id.version == 5, projected_id
    assert str(projected_id) == projected["run_id"]
    assert mod.evidence_bundle_for_agent(bundle, root)["run_id"] == projected["run_id"]
    assert mod.evidence_bundle_for_agent({**bundle, "run_id": "run-2"}, root)["run_id"] != projected["run_id"]
    assert projected["source"] == "durable-evidence-projection"
    assert projected["source_run_id"] == "run-1"
    assert len(projected["tasks"]) == 1
    task = projected["tasks"][0]
    assert task["agent_id"] == root
    assert task["name"] == f"composite [{label} evidence]"
    assert task["passed"] is False
    assert task["logs"]["messages"][0]["message"] == prompt
    assert task["message_count"] == task["tree_agent_count"] == 1
assert mod.evidence_bundle_for_agent(bundle, gate)["run_id"] != mod.evidence_bundle_for_agent(bundle, post)["run_id"]
assert bundle["run_id"] == "run-1"
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

# Run the real renderer, offline, with a shared artifact root that must remain
# untouched. The publisher owns only the per-agent canonical directory.
import os
import subprocess
import tempfile
from unittest.mock import patch
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    shared = root / "shared"
    shared.mkdir()
    sentinel = shared / "last_llm_call.html"
    sentinel.write_text("unrelated owner's artifact")
    source = root / "completion_summary.json"
    source.write_text('{"agent_id":"test-agent","call_site":"completion_summary","messages":[],"output":"complete"}')
    real_run = subprocess.run
    def offline_renderer(cmd, **kwargs):
        env = dict(os.environ, CURSOR_ARTIFACTS_DIR=str(shared))
        for name in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_TRACE_ARCHIVE"):
            env.pop(name, None)
        return real_run(cmd, **kwargs, env=env)
    with patch.object(mod, "ARTIFACTS_ROOT", root / "owned"), patch.object(mod.subprocess, "run", offline_renderer):
        local, url = mod.publish_llm_dump(source, "test-agent")
    assert sentinel.read_text() == "unrelated owner's artifact", "renderer wrote into shared artifacts root"
    assert local == root / "owned/test-agent/last_llm_call.html"
    assert local.is_file() and "file://" not in local.read_text()
    assert url == ""  # Offline owning-boundary test; canonical live publication separately verifies R2.

print("publish_evidence_links composite projection checks passed")
PY
