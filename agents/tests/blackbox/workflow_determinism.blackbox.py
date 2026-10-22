"""Guard: workflow-scope modules must not call non-deterministic wall-clock/random APIs.

Temporal replays workflow code from history on every workflow task and on any
worker migration/restart. Raw `uuid.uuid4()`, `datetime.now()`, `time.time()`,
and `random.*` are recomputed on each replay, so an id/timestamp minted before a
replay diverges from the one minted after — which is exactly how a single
`for_each` fan-out split into two tool-call bubbles (the pre-replay one spun
forever, never receiving a matching FINISHED). Workflow code MUST use the
replay-stable equivalents: `workflow.uuid4()` and `workflow.now()`.

The three core modules and direct ToolManager method bodies run in workflow
scope. This guard checks those bodies; helpers called by a manager still need
review when they are added. Activity functions run outside workflow replay.
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
    "workflows/background_agents.py",
    "helpers/background_agents.py",
    "domains/agent_messaging/handler.py",
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


def _find_banned_calls(path: Path, *, tool_managers_only: bool = False) -> list[str]:
    """Return 'module.method @ LN -> use REPLACEMENT' for each banned call in the file."""
    tree = ast.parse(path.read_text(), filename=str(path))
    aliases: dict[str, str] = {}
    imported_calls: dict[str, tuple[str, str]] = {}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for imported in node.names:
                aliases[imported.asname or imported.name] = imported.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            for imported in node.names:
                name = imported.asname or imported.name
                key = (node.module, imported.name)
                if key in BANNED:
                    imported_calls[name] = key
                elif node.module == "datetime" and imported.name == "datetime":
                    aliases[name] = "datetime"
    if tool_managers_only:
        roots = [
            node
            for node in tree.body
            if isinstance(node, ast.ClassDef)
            and any(isinstance(base, ast.Name) and base.id == "ToolManager" for base in node.bases)
        ]
    else:
        roots = [tree]
    hits: list[str] = []
    for node in (descendant for root in roots for descendant in ast.walk(root)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name):
            key = imported_calls.get(func.id)
        elif isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            key = (aliases.get(func.value.id, func.value.id), func.attr)
        elif (
            isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Attribute)
            and isinstance(func.value.value, ast.Name)
            and aliases.get(func.value.value.id, func.value.value.id) == "datetime"
            and func.value.attr == "datetime"
        ):
            key = ("datetime", func.attr)
        else:
            continue
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


def test_background_agent_modules_deterministic():
    """Background spawn + agent-messaging code runs in workflow scope too."""
    for rel_path in WORKFLOW_SCOPE_MODULES[3:]:
        _assert_module_clean(rel_path)


def test_tool_manager_workflow_paths_deterministic():
    """Check direct ToolManager bodies, including handlers that also define activities."""
    hits = [
        f"{path.relative_to(AGENTS_ROOT)}: {hit}"
        for root in (AGENTS_ROOT / "domains", AGENTS_ROOT / "tools")
        for path in root.rglob("*.py")
        for hit in _find_banned_calls(path, tool_managers_only=True)
    ]
    assert not hits, "ToolManager workflow path has replay-unsafe calls:\n  " + "\n  ".join(hits)


def test_scanner_detects_a_planted_violation():
    """Self-check: the AST scanner actually catches a banned call."""
    import tempfile

    src = (
        "import uuid as uuid_module\nfrom uuid import uuid4 as new_id\n"
        "class Example(ToolManager):\n    def f(self):\n"
        "        return uuid_module.uuid4(), new_id()\n"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as fh:
        fh.write(src)
        tmp = Path(fh.name)
    try:
        hits = _find_banned_calls(tmp, tool_managers_only=True)
        assert len(hits) == 2, f"scanner missed an aliased UUID call: {hits}"
    finally:
        tmp.unlink(missing_ok=True)


def test_sandbox_instance_does_not_reload_dotenv():
    """Every cache-miss workflow task builds a fresh sandbox and re-imports workflow modules.

    Activity modules on AgentWorkflow's import graph call load_config() at
    import. A re-imported config module re-ran load_dotenv per instance, copying
    os.environ through the sandbox proxy once per .env line (~0.4s per workflow
    task), which made full-history replays time out under load. config must be
    a passthrough module so a sandbox instance never imports dotenv.
    """
    import builtins
    import importlib
    import sys

    # Host import first, as the worker does before it builds sandbox instances.
    importlib.import_module("workflows.agent_workflow")
    from helpers.workflow_sandbox import workflow_sandbox_restrictions
    from temporalio.worker.workflow_sandbox._importer import Importer
    from temporalio.worker.workflow_sandbox._restrictions import RestrictionContext

    importer = Importer(workflow_sandbox_restrictions(), RestrictionContext())
    with importer.applied():
        builtins.__import__("workflows.agent_workflow")
    sandbox_modules = importer.new_modules
    assert sandbox_modules.get("workflows.agent_workflow") is not sys.modules["workflows.agent_workflow"], (
        "sandbox did not re-import the workflow module"
    )
    assert sandbox_modules.get("config") is sys.modules["config"], (
        "sandbox re-imported config instead of passing it through"
    )
    reloaded = sorted(name for name in sandbox_modules if name == "dotenv" or name.startswith("dotenv."))
    assert not reloaded, f"sandbox instance re-imported dotenv: {reloaded}"


async def run_all_tests():
    print("workflow-determinism blackbox tests:")
    r = BlackboxResult()
    r.record("agent_workflow_deterministic", test_agent_workflow_deterministic)
    r.record("run_agent_deterministic", test_run_agent_deterministic)
    r.record("dag_executor_deterministic", test_dag_executor_deterministic)
    r.record("background_agent_modules_deterministic", test_background_agent_modules_deterministic)
    r.record("tool_manager_workflow_paths_deterministic", test_tool_manager_workflow_paths_deterministic)
    r.record("scanner_detects_planted_violation", test_scanner_detects_a_planted_violation)
    r.record("sandbox_instance_does_not_reload_dotenv", test_sandbox_instance_does_not_reload_dotenv)
    return r.summary() if hasattr(r, "summary") else r.all_passed
