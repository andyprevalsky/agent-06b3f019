#!/usr/bin/env bash
# The evidence publisher must use a writable local artifact root on macOS while
# retaining Cursor Cloud's /opt/cursor default and allowing an explicit override.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

python3 - <<'PY'
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import shutil
import sys
import tempfile
from unittest.mock import patch

path = Path(os.environ.get("PUBLISH_EVIDENCE_SCRIPT_PATH", "scripts/publish_evidence_links.py"))
spec = importlib.util.spec_from_file_location("publish_evidence_links", path)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
with patch.dict(os.environ, {"CURSOR_ARTIFACTS_DIR": ""}), patch.object(sys, "platform", "darwin"):
    spec.loader.exec_module(mod)

# Reproduce the actual failing boundary: on a Mac, an attempt to create the
# Cursor Cloud-only root is denied before the dump can be rendered or verified.
real_mkdir = Path.mkdir


def deny_cloud_root(path: Path, *args: object, **kwargs: object) -> None:
    if path == Path("/opt/cursor") or Path("/opt/cursor") in path.parents:
        raise PermissionError(13, "Permission denied", "/opt/cursor")
    real_mkdir(path, *args, **kwargs)


with tempfile.TemporaryDirectory() as temp_dir:
    source = Path(temp_dir) / "latest.json"
    source.write_text("{}")
    agent = "artifact-root-regression"
    with patch.object(Path, "mkdir", deny_cloud_root), patch.object(mod.subprocess, "run"):
        output = mod.publish_llm_dump(source, agent)
    assert output.parent == Path.cwd() / ".context/artifacts/rca_evidence" / agent
    assert (output.parent / source.name).read_text() == "{}"
    shutil.rmtree(output.parent)

with patch.dict(os.environ, {"CURSOR_ARTIFACTS_DIR": "/tmp/rose-artifact-test"}):
    assert mod.resolve_artifacts_root(platform="darwin") == Path(
        "/tmp/rose-artifact-test/rca_evidence"
    )
    assert mod.resolve_artifacts_root(platform="linux") == Path(
        "/tmp/rose-artifact-test/rca_evidence"
    )

with patch.dict(os.environ, {}, clear=True):
    assert mod.resolve_artifacts_root(platform="darwin") == (
        Path.cwd() / ".context/artifacts/rca_evidence"
    )
    assert mod.resolve_artifacts_root(platform="linux") == Path(
        "/opt/cursor/artifacts/rca_evidence"
    )

with tempfile.TemporaryDirectory() as temp_dir:
    root = Path(temp_dir) / "artifacts/rca_evidence"
    source = Path(temp_dir) / "latest.json"
    source.write_text("{}")
    with patch.object(mod, "ARTIFACTS_ROOT", root), patch.object(mod.subprocess, "run") as run:
        output = mod.publish_llm_dump(source, "agent-1")
    assert output == root / "agent-1/last_llm_call.html"
    assert (root / "agent-1/latest.json").read_text() == "{}"
    command = run.call_args.args[0]
    assert command[command.index("--artifacts-dir") + 1] == str(root.parent)

with patch.dict(os.environ, {"CURSOR_ARTIFACTS_DIR": ""}), patch.object(sys, "platform", "darwin"):
    assert mod.ARTIFACTS_ROOT == mod.resolve_artifacts_root()
print("publish_evidence_links artifact root checks passed")
PY
