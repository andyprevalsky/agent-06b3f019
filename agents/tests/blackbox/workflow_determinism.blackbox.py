"""Guard: workflow-scope modules must not call non-deterministic wall-clock/random APIs.

Temporal replays workflow code from history on every workflow task and on any
worker migration/restart. Raw `uuid.uuid4()`, `datetime.now()`, `time.time()`,
and `random.*` are recomputed on each replay, so an id/timestamp minted before a
replay diverges from the one minted after — which is exactly how a single
`for_each` fan-out split into two tool-call bubbles (the pre-replay one spun
forever, never receiving a matching FINISHED). Workflow code MUST use the
replay-stable equivalents: `workflow.uuid4()` and `workflow.now()`.

These modules run inside the workflow sandbox (awaited directly from
AgentWorkflow.run — no @activity boundary), so the ban applies to them. Activity
modules (activities/, helpers/, tools/ invoked via execute_activity) run outside
the sandbox and are intentionally NOT covered here.
"""

import ast
from pathlib import Path

from _test_utils import BlackboxResult

AGENTS_ROOT = Path(__file__).resolve().parents[2]

# Modules that execute in workflow scope (Temporal sandbox, replay-sensitive).
WORKFLOW_SCOPE_MODULES = [
    "workflows/agent_workflow.py",
    "loop/run_agent.py",
    "loop/dag_executor.py",
]

# (module_attr, method) pairs that are non-deterministic in workflow scope,
# mapped to their replay-stable replacement for the failure message.
BANNED = {
    ("uuid", "uuid4"): "workflow.uuid4()",
    ("datetime", "now"): "workflow.now()",
    ("datetime", "utcnow"): "workflow.now()",
    ("time", "time"): "workflow.now()",
    ("random", "random"): "a seeded/deterministic value",
    ("random", "randint"): "a seeded/deterministic value",
    ("random", "choice"): "a seeded/deterministic value",
    ("random", "shuffle"): "a seeded/deterministic value",
    ("random", "uniform"): "a seeded/deterministic value",
}


def _find_banned_calls(path: Path) -> list[str]:
    """Return 'module.method @ LN -> use REPLACEMENT' for each banned call in the file."""
    tree = ast.parse(path.read_text(), filename=str(path))
    hits: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute) or not isinstance(func.value, ast.Name):
            continue
        key = (func.value.id, func.attr)
        if key in BANNED:
            hits.append(f"{key[0]}.{key[1]}() @ line {node.lineno} -> use {BANNED[key]}")
    return hits


def _assert_module_clean(rel_path: str) -> None:
    path = AGENTS_ROOT / rel_path
    assert path.exists(), f"workflow-scope module not found: {path}"
    hits = _find_banned_calls(path)
    assert not hits, (
        f"{rel_path} is workflow-scope but calls non-deterministic APIs "
        f"(unsafe across Temporal replay):\n  " + "\n  ".join(hits)
    )


def test_agent_workflow_deterministic():
    _assert_module_clean("workflows/agent_workflow.py")


def test_run_agent_deterministic():
    _assert_module_clean("loop/run_agent.py")


def test_dag_executor_deterministic():
    _assert_module_clean("loop/dag_executor.py")


def test_scanner_detects_a_planted_violation():
    """Self-check: the AST scanner actually catches a banned call."""
    import tempfile

    src = "import uuid\ndef f():\n    return uuid.uuid4()\n"
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as fh:
        fh.write(src)
        tmp = Path(fh.name)
    try:
        hits = _find_banned_calls(tmp)
        assert any("uuid.uuid4()" in h for h in hits), f"scanner missed planted violation: {hits}"
    finally:
        tmp.unlink(missing_ok=True)


async def run_all_tests():
    print("workflow-determinism blackbox tests:")
    r = BlackboxResult()
    r.record("agent_workflow_deterministic", test_agent_workflow_deterministic)
    r.record("run_agent_deterministic", test_run_agent_deterministic)
    r.record("dag_executor_deterministic", test_dag_executor_deterministic)
    r.record("scanner_detects_planted_violation", test_scanner_detects_a_planted_violation)
    return r.summary() if hasattr(r, "summary") else r.all_passed
