#!/usr/bin/env bash
# Cemented guard: RCA/descend evidence links must be durable + self-contained.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }

# Agents helpers import temporalio and other venv-only deps — prefer the repo venv.
PYTHON_BIN="$ROOT/agents/venv/bin/python"
if [ ! -x "$PYTHON_BIN" ]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python3)"
  else
    fail "neither agents/venv/bin/python nor python3 is available"
  fi
fi

# 1) Report FE URL defaults to always-on prod (never ephemeral localhost).
"$PYTHON_BIN" - <<'PY' || fail "durable report FE URL"
import os, sys
sys.path.insert(0, "agents")
os.environ.pop("BENCHMARK_REPORT_FRONTEND_URL", None)
os.environ.pop("BENCHMARK_REPORT_ALLOW_EPHEMERAL", None)
os.environ["CONDUCTOR_PORT"] = "3099"
from benchmarks.run_benchmark import (
    _report_frontend_url_for_benchmark,
    durable_agent_frontend_url,
    _is_ephemeral_frontend_url,
)
assert _report_frontend_url_for_benchmark("http://127.0.0.1:3099") == "https://roselabs.ai"
assert durable_agent_frontend_url("abc") == "https://roselabs.ai/?agent-id=abc"
assert _is_ephemeral_frontend_url("http://127.0.0.1:60784")
assert _is_ephemeral_frontend_url("https://foo.trycloudflare.com")
assert not _is_ephemeral_frontend_url("https://roselabs.ai")
print("ok durable FE helpers")
PY

# 2) Published dump is a single self-contained HTML (no file://, data URIs for frames).
"$PYTHON_BIN" - <<'PY' || fail "self-contained dump publish"
import json, tempfile, shutil
from pathlib import Path
import importlib.util

spec = importlib.util.spec_from_file_location("render_llm_dump", Path("scripts/render_llm_dump.py"))
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)

with tempfile.TemporaryDirectory() as tmp:
    tmp_path = Path(tmp)
    recording = tmp_path / "rec"
    frames = recording / "frames"
    frames.mkdir(parents=True)
    (frames / "a.jpg").write_bytes(b"\xff\xd8\xff\xe0frame")
    (recording / "index.html").write_text("<html></html>")
    manifest = recording / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "frames": [
                    {
                        "src": "frames/a.jpg",
                        "ts_ms": 1,
                        "label": "x",
                        "action": "click",
                        "metadata": {"step": 1, "phase": "start", "action": "click"},
                    }
                ]
            }
        )
    )
    dump = {
        "call_site": "browser_use_step_1",
        "agent_id": "agent-1",
        "model": "t",
        "messages": [],
        "output": {"action": {"action": "click"}},
        "extra": {
            "browser_recording_manifest_path": str(manifest),
            "iteration": 1,
            "output": {"action": {"action": "click"}},
        },
    }
    out = tmp_path / "out.html"
    src = tmp_path / "dump.json"
    src.write_text(json.dumps(dump))
    out.write_text(mod.build_html(dump, src, out))
    arts = tmp_path / "arts"
    arts.mkdir()
    published = mod.publish_rendered_dump(out, arts)
    assert published is not None
    html = published.read_text()
    assert "file://" not in html
    assert "data:image/jpeg;base64," in html
    assert "Browser Recording" in html
    # Sidecar optional: deleting it must not break the published HTML body.
    for child in arts.iterdir():
        if child != published:
            shutil.rmtree(child) if child.is_dir() else child.unlink()
    assert "data:image/jpeg;base64," in published.read_text()
print("ok self-contained dump publish")
PY

# 3) Approval format still demands durable FE + no invalid recordings.
FORMAT="$ROOT/.claude/shared/approval-format.md"
grep -Fq 'https://roselabs.ai/?agent-id=' "$FORMAT" || fail "approval format missing durable FE"
grep -Fq 'omit the recording player entirely' "$FORMAT" || fail "approval format missing invalid-recording ban"
grep -Fq 'HTTPS URL' "$FORMAT" || fail "approval format missing HTTPS dump URL requirement"
grep -Fq 'vscode-remote' "$FORMAT" || fail "approval format missing vscode-remote blank-viewer warning"
grep -Fq 'every `spawn_browser_agent` task on that agent to be terminated' "$FORMAT" \
  || fail "approval format missing browser terminate+recording FE validation"

# 3b) publish_evidence_links enforces browser terminate + recording attach.
bash "$ROOT/scripts/tests/publish_evidence_links_browser_validation.test.sh" \
  || fail "publish_evidence_links browser validation checks failed"

# 4) Gate must stay wired into /deploy structural suites (both docs + registry).
DEPLOY="$ROOT/.claude/commands/deploy.md"
RUNNER="$ROOT/scripts/run-deploy-structural-gates.py"
grep -Fq 'bash scripts/tests/durable-evidence-links.test.sh' "$DEPLOY" \
  || fail "/deploy must list durable-evidence-links.test.sh"
grep -Fq 'durable-evidence-links' "$RUNNER" \
  || fail "run-deploy-structural-gates.py must register durable-evidence-links"
grep -Fq 'publish-evidence-browser-validation' "$RUNNER" \
  || fail "run-deploy-structural-gates.py must register publish-evidence-browser-validation"

echo "All durable-evidence-links checks passed."
