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

# Evidence renders stay private under the checkout on hosts without Cursor's
# artifact mount; the default used to fail after the Hub upload with EACCES.
repo = mod.REPO_ROOT
assert mod.evidence_artifacts_root({}, cursor_mount_exists=False) == repo / ".context" / "rca_evidence"
assert mod.evidence_artifacts_root({}, cursor_mount_exists=True) == Path("/opt/cursor/artifacts/rca_evidence")
assert mod.evidence_artifacts_root(
    {"CURSOR_ARTIFACTS_DIR": "/tmp/cursor"}, cursor_mount_exists=False
) == Path("/tmp/cursor/rca_evidence")
assert mod.evidence_artifacts_root(
    {"RCA_EVIDENCE_ARTIFACTS_ROOT": "/tmp/explicit", "CURSOR_ARTIFACTS_DIR": "/tmp/cursor"},
    cursor_mount_exists=True,
) == Path("/tmp/explicit")


# Latest evidence follows the captured canonical ID->node tree, never unrelated dumps.
import tempfile
with tempfile.TemporaryDirectory() as temporary:
    mod.REPO_ROOT = Path(temporary)
    root = "00000000-0000-4000-8000-000000000001"
    child = "00000000-0000-4000-8000-000000000002"
    grandchild = "00000000-0000-4000-8000-000000000003"
    foreign = "00000000-0000-4000-8000-000000000004"
    for owner, filename in [(root, "100-root.json"), (child, "200-child.json"), (grandchild, "300-grandchild.json"), (foreign, "999-foreign.json")]:
        folder = mod.REPO_ROOT / ".llm-dumps" / owner
        folder.mkdir(parents=True)
        (folder / filename).write_text("{}")
    tree = {root: {"parent_agent_id": None}, child: {"parent_agent_id": root}, grandchild: {"parent_agent_id": child}, foreign: {"parent_agent_id": "other"}}
    captured = {"tasks": [{"agent_id": root, "logs": {"tree": tree}}]}
    assert mod.latest_dump_for_agent(root, bundle=captured).name == "300-grandchild.json"
    assert mod.latest_dump_for_agent(root).name == "100-root.json"
mod.REPO_ROOT = repo

print("publish_evidence_links composite projection checks passed")
PY
