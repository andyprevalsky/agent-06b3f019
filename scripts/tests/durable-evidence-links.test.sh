#!/usr/bin/env bash
# Cemented guard: RCA/descend evidence links must be durable + self-contained!
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

# 2b) The publisher surfaces the renderer's HTTPS dump URL (not the local path)
#     and renders under agents/venv, where the boto3 R2 upload is importable.
"$PYTHON_BIN" - <<'PY' || fail "publisher HTTPS dump URL"
import json, subprocess, tempfile
from pathlib import Path
import importlib.util

spec = importlib.util.spec_from_file_location("publish_evidence_links", Path("scripts/publish_evidence_links.py"))
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)

calls = []
def fake_run(cmd, **kwargs):
    calls.append(cmd)
    rendered = Path(cmd[cmd.index("-o") + 1])
    rendered.parent.mkdir(parents=True, exist_ok=True)
    rendered.write_text("<html></html>")
    artifacts = Path(cmd[cmd.index("--artifacts-dir") + 1])
    (artifacts / rendered.name).write_text("<html></html>")
    return subprocess.CompletedProcess(cmd, 0, stdout="https://example.r2.dev/dump.html?sig=1\n", stderr="")
mod.subprocess.run = fake_run

with tempfile.TemporaryDirectory() as tmp:
    mod.ARTIFACTS_ROOT = Path(tmp)
    dump = Path(tmp) / "dump.json"
    dump.write_text("{}")
    html, url = mod.publish_llm_dump(dump, "agent-1")
    assert html.is_file(), "canonical published HTML must exist"
    assert url == "https://example.r2.dev/dump.html?sig=1", url
    if mod.AGENTS_VENV_PYTHON.is_file():
        assert calls[0][0] == str(mod.AGENTS_VENV_PYTHON), calls[0][0]
    manifest = mod.write_manifest(
        agent_id="agent-1", run_id="", token="", fe_status="skipped", message_count=0,
        dump_html=html, dump_https_url=url, source_dump=dump,
    )
    assert json.loads(manifest.read_text())["llm_dump_https_url"] == url
print("ok publisher HTTPS dump URL")
PY

# 2c) Each agent keeps its rendered copy beside its evidence. A previous
#     publication's shared basename must not be overwritten (or block this one).
"$PYTHON_BIN" - <<'PY' || fail "publisher artifact isolation"
import importlib.util
import subprocess
import tempfile
from pathlib import Path

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, Path(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

publisher = load("isolated_publisher", "scripts/publish_evidence_links.py")
renderer = load("isolated_renderer", "scripts/render_llm_dump.py")
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    shared = root / "shared-artifacts"
    shared.mkdir()
    foreign = shared / "last_llm_call.html"
    foreign.write_text("retained publication from another agent")
    renderer.DEFAULT_ARTIFACTS_DIR = shared
    publisher.ARTIFACTS_ROOT = root / "evidence"
    dump = root / "actual-call.json"
    dump.write_text("{}")
    copied = []

    def render_locally(cmd, **kwargs):
        output = Path(cmd[cmd.index("-o") + 1])
        output.write_text("<html>this agent's actual call</html>")
        artifacts = (
            Path(cmd[cmd.index("--artifacts-dir") + 1])
            if "--artifacts-dir" in cmd else renderer.DEFAULT_ARTIFACTS_DIR
        )
        copied.append(renderer.publish_rendered_dump(output, artifacts))
        return subprocess.CompletedProcess(
            cmd, 0, stdout="https://example.r2.dev/this-agent.html\n", stderr=""
        )

    publisher.subprocess.run = render_locally
    html, url = publisher.publish_llm_dump(dump, "agent-1")
    assert foreign.read_text() == "retained publication from another agent"
    assert copied == [publisher.ARTIFACTS_ROOT / "agent-1" / "last_llm_call.html"]
    assert html.read_text() == "<html>this agent's actual call</html>"
    assert url == "https://example.r2.dev/this-agent.html"
print("ok publisher keeps other agents' artifacts intact")
PY

# 2d) A production run may have only archived dumps. The ordinary publisher
#     recovers them, checks the returned path/hash, and exposes recovery errors.
"$PYTHON_BIN" - <<'PY' || fail "publisher archived dump recovery"
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
from contextlib import redirect_stderr
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("archive_publisher", Path("scripts/publish_evidence_links.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
agent = "00000000-0000-4000-8000-000000000001"
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    publisher.REPO_ROOT = root
    publisher.ARTIFACTS_ROOT = root / "artifacts"
    (root / "back-end").mkdir()
    (root / "back-end" / ".env").write_text(
        "PUBLISHER_CLI_TEST_DEFAULT=from-file\nPUBLISHER_CLI_TEST_OVERRIDE=from-file\n"
    )
    os.environ.pop("PUBLISHER_CLI_TEST_DEFAULT", None)
    os.environ["PUBLISHER_CLI_TEST_OVERRIDE"] = "from-caller"
    publisher._load_cli_environment()
    assert os.environ["PUBLISHER_CLI_TEST_DEFAULT"] == "from-file"
    assert os.environ["PUBLISHER_CLI_TEST_OVERRIDE"] == "from-caller"
    calls = []
    failure = None
    corrupt = False
    escape = False

    def recover(cmd, **kwargs):
        calls.append(cmd)
        assert kwargs["cwd"] == str(root / "back-end")
        if failure:
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr=failure)
        directory = Path(cmd[cmd.index("--output-dir") + 1])
        recovered = root / "outside.json" if escape else directory / "latest.json"
        recovered.write_text(json.dumps({"agent_id": agent, "root_agent_id": agent, "messages": []}))
        digest = hashlib.sha256(recovered.read_bytes()).hexdigest()
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps({
            "rootAgentId": agent,
            "latest": {"path": str(recovered), "sha256": "wrong" if corrupt else digest},
        }), stderr="")

    publisher.subprocess.run = recover
    recovered = publisher.latest_dump_for_agent(agent)
    assert recovered.is_file()
    assert calls[0][:2] == ["node", "--import"] and calls[0][-1] == "--json"
    assert str(recovered).startswith(str(publisher.ARTIFACTS_ROOT / agent))
    local = root / ".llm-dumps" / agent / "123-existing.json"
    local.parent.mkdir(parents=True)
    local.write_text("{}")
    count = len(calls)
    assert publisher.latest_dump_for_agent(agent) == local
    assert len(calls) == count
    local.unlink()
    for flag in ("corrupt", "escape"):
        corrupt, escape = flag == "corrupt", flag == "escape"
        try:
            publisher.latest_dump_for_agent(agent)
        except SystemExit:
            pass
        else:
            raise AssertionError(f"archive {flag} must fail closed")
    corrupt = escape = False
    failure = "archive ciphertext failed integrity validation"
    publisher.parse_args = lambda: SimpleNamespace(agent_id=agent, dump=None, run_json=None)
    error = io.StringIO()
    with redirect_stderr(error):
        try:
            publisher.main()
        except SystemExit as exc:
            assert "archive" in str(exc).lower()
        else:
            raise AssertionError("failed recovery must stop before Hub upload")
    assert failure in error.getvalue()
print("ok publisher recovers and verifies archived dumps before upload")
PY

# Exercise the real Python -> TypeScript CLI contract against encrypted local
# archive files, with network access forbidden in every Node child.
"$PYTHON_BIN" "$ROOT/scripts/tests/publisher-archive-integration.test.py" || fail "publisher archive CLI integration"

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
bash "$ROOT/scripts/tests/publish_evidence_links_composite.test.sh" \
  || fail "publish_evidence_links composite projection checks failed"

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
