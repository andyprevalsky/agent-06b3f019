"""Structural architecture tests — boundary invariants beyond import direction.

Covers invariants NOT already tested by structural.py (completeness,
forward-only imports) and structural_imports.py (detailed import
directions, cross-domain isolation).

Invariants tested here:
  3. Provider boundary — helpers/ must not import from domains/
  4. Utils boundary    — utils/ must not import from project source tree
  6. Data access boundary — httpx only in repo*.py within domains/
  7. Framework leak    — temporalio.workflow not in types/config/repo layers
  8. No circular imports — no cycles in the first-party module graph
  9. Wiring correctness — worker.py should import refactored domains from domains/
  10. Cutover classification — every workflow.wait_condition/sleep is tagged
  11. Activity registration — every activity a workflow schedules is registered in worker.py
  12. Workflow sandbox — workers and tests run workflows under the production restrictions

All tests auto-discover domains. No hardcoded domain names.
"""

import ast
import asyncio
import re
import sys
from pathlib import Path

from _result import Result as BlackboxResult

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
DOMAINS_DIR = AGENTS_ROOT / "domains"
HELPERS_DIR = AGENTS_ROOT / "helpers"
UTILS_DIR = AGENTS_ROOT / "utils"
WORKER_PY = AGENTS_ROOT / "worker.py"

# First-party top-level packages (anything in the project source tree)
FIRST_PARTY_PACKAGES = frozenset(
    {
        "config",
        "domains",
        "tools",
        "helpers",
        "utils",
        "loop",
        "activities",
        "workflows",
        "browser_tools",
        "health_server",
    }
)

# Domain layer files
LAYER_FILES = ("types", "config", "repo", "service", "handler")


def _parse_imports(file_path: Path) -> list[str]:
    """Parse all import module names from a Python file."""
    if not file_path.exists():
        return []
    try:
        source = file_path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(file_path))
    except (SyntaxError, UnicodeDecodeError):
        return []

    modules: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            modules.append(node.module)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                modules.append(alias.name)
    return modules


def _file_imports_workflow(file_path: Path) -> bool:
    """Check if a file imports temporalio.workflow in any form.

    Catches:
      - ``from temporalio import workflow``
      - ``from temporalio.workflow import X``
      - ``import temporalio.workflow``
    """
    if not file_path.exists():
        return False
    try:
        source = file_path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(file_path))
    except (SyntaxError, UnicodeDecodeError):
        return False

    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            # from temporalio.workflow import X
            if node.module == "temporalio.workflow" or node.module.startswith("temporalio.workflow."):
                return True
            # from temporalio import workflow
            if node.module == "temporalio":
                for alias in node.names:
                    if alias.name == "workflow":
                        return True
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "temporalio.workflow" or alias.name.startswith("temporalio.workflow."):
                    return True
    return False


def _discover_domains() -> list[str]:
    """Discover all domain names under domains/."""
    if not DOMAINS_DIR.exists():
        return []
    return sorted(
        d.name
        for d in DOMAINS_DIR.iterdir()
        if d.is_dir() and not d.name.startswith("_") and (d / "__init__.py").exists()
    )


# ═══════════════════════════════════════════════════════════════════════
# Invariant 3: Provider boundary
# helpers/ must NEVER import from domains/. Providers are domain-agnostic.
# ═══════════════════════════════════════════════════════════════════════


def test_provider_boundary():
    """helpers/ files must not import from domains/."""
    if not HELPERS_DIR.exists():
        return  # no helpers dir

    violations: list[str] = []
    for py_file in sorted(HELPERS_DIR.glob("*.py")):
        if py_file.name == "__init__.py":
            continue
        for mod in _parse_imports(py_file):
            if mod.startswith("domains."):
                violations.append(
                    f"PROVIDER BOUNDARY VIOLATION in helpers/{py_file.name}:\n"
                    f"  Imports from '{mod}'\n"
                    f"  → Fix: Extract shared logic into a provider or pass it as an argument."
                )

    assert not violations, "\n".join(violations)


# ═══════════════════════════════════════════════════════════════════════
# Invariant 4: Utils boundary
# utils/ must NEVER import from the project source tree.
# Pure functions only — zero project dependencies.
# ═══════════════════════════════════════════════════════════════════════


def test_utils_boundary():
    """utils/ files must not import from project source tree (helpers, domains, tools, etc.)."""
    if not UTILS_DIR.exists():
        return  # no utils dir

    # utils may import from other utils modules — that's fine
    forbidden = FIRST_PARTY_PACKAGES - {"utils"}

    violations: list[str] = []
    for py_file in sorted(UTILS_DIR.glob("*.py")):
        if py_file.name == "__init__.py":
            continue
        for mod in _parse_imports(py_file):
            top = mod.split(".")[0]
            if top in forbidden:
                violations.append(
                    f"UTILS BOUNDARY VIOLATION in utils/{py_file.name}:\n"
                    f"  Imports from '{mod}'\n"
                    f"  → Fix: utils/ must have zero project dependencies. "
                    f"Move this to helpers/ or inline it."
                )

    assert not violations, "\n".join(violations)


# ═══════════════════════════════════════════════════════════════════════
# Invariant 6: Data access boundary
# httpx (HTTP client) may only appear in repo*.py and handler*.py files
# within domains/. types.py, config.py, and service.py must never import it —
# service layer stays pure; I/O belongs in repo.
# ═══════════════════════════════════════════════════════════════════════


def test_data_access_boundary():
    """httpx must not be imported in domain types.py, config.py, or service.py files."""
    domains = _discover_domains()
    if not domains:
        return

    violations: list[str] = []
    # These layers must NEVER import the HTTP data client
    forbidden_layers = ("types", "config", "service")

    for domain in domains:
        domain_dir = DOMAINS_DIR / domain
        for layer in forbidden_layers:
            layer_file = domain_dir / f"{layer}.py"
            if not layer_file.exists():
                continue
            for mod in _parse_imports(layer_file):
                if mod == "httpx" or mod.startswith("httpx."):
                    violations.append(
                        f"DATA ACCESS BOUNDARY VIOLATION in domains/{domain}/{layer}.py:\n"
                        f"  Imports '{mod}' but only repo and handler layers may use HTTP clients\n"
                        f"  → Fix: Move the HTTP call to repo.py and call it from {layer}."
                    )

    assert not violations, "\n".join(violations)


# ═══════════════════════════════════════════════════════════════════════
# Invariant 7: No framework types in data layers
# temporalio.workflow must not appear in types.py, config.py, or repo.py.
# These layers must be framework-agnostic.
# (temporalio.activity is allowed in service.py for @activity.defn)
# ═══════════════════════════════════════════════════════════════════════


def test_no_framework_in_data_layers():
    """temporalio.workflow must not be imported in types/config/repo layers."""
    domains = _discover_domains()
    if not domains:
        return

    violations: list[str] = []
    # These layers must be framework-agnostic
    framework_free_layers = ("types", "config", "repo")

    for domain in domains:
        domain_dir = DOMAINS_DIR / domain
        for layer in framework_free_layers:
            layer_file = domain_dir / f"{layer}.py"
            if _file_imports_workflow(layer_file):
                violations.append(
                    f"FRAMEWORK LEAK in domains/{domain}/{layer}.py:\n"
                    f"  Imports temporalio.workflow but {layer} must be framework-agnostic\n"
                    f"  → Fix: Accept typed args instead. Move framework coupling to handler."
                )

    assert not violations, "\n".join(violations)


# ═══════════════════════════════════════════════════════════════════════
# Invariant 8: No circular imports
# No cycles in the first-party module graph (domains/, helpers/, utils/,
# tools/, activities/, workflows/, loop/, browser_tools/, config, health_server).
# ═══════════════════════════════════════════════════════════════════════


def _module_name_for_path(file_path: Path) -> str | None:
    """Convert an absolute .py path under AGENTS_ROOT to a dotted module name.

    Returns None for files outside FIRST_PARTY_PACKAGES.
    """
    try:
        rel = file_path.relative_to(AGENTS_ROOT)
    except ValueError:
        return None
    parts = list(rel.with_suffix("").parts)
    if not parts:
        return None
    if parts[0] not in FIRST_PARTY_PACKAGES:
        return None
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts) if parts else None


def _resolve_to_first_party(module: str) -> str | None:
    """Return the module name if it maps to a first-party package, else None."""
    top = module.split(".")[0]
    if top not in FIRST_PARTY_PACKAGES:
        return None
    return module


def _collect_first_party_modules() -> dict[Path, str]:
    """Map each first-party .py file path to its dotted module name."""
    mapping: dict[Path, str] = {}
    for package in FIRST_PARTY_PACKAGES:
        pkg_path = AGENTS_ROOT / package
        # Packages may be either a directory or a single .py file (config, health_server)
        if pkg_path.is_dir():
            py_files = list(pkg_path.rglob("*.py"))
        else:
            py_file = AGENTS_ROOT / f"{package}.py"
            py_files = [py_file] if py_file.exists() else []
        for py_file in py_files:
            if any(p in py_file.parts for p in ("__pycache__", "venv", "tests")):
                continue
            mod_name = _module_name_for_path(py_file)
            if mod_name is None:
                continue
            mapping[py_file] = mod_name
    return mapping


def _extract_first_party_edges(file_path: Path, mod_name: str, known_modules: set[str]) -> set[str]:
    """Return first-party modules imported by this file.

    Resolves relative imports against the importing module's path and expands
    ``from pkg import sub`` to ``pkg.sub`` when ``sub`` is a known submodule
    (so the circular-import graph sees the real target, not just ``pkg``).
    """
    if not file_path.exists():
        return set()
    try:
        source = file_path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(file_path))
    except (SyntaxError, UnicodeDecodeError):
        return set()

    mod_parts = mod_name.split(".")
    is_package = file_path.name == "__init__.py"

    edges: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level > 0:
                # Relative import: resolve against importer's package.
                # For a package __init__.py, level=1 references the package itself;
                # for a regular module.py, level=1 references the parent package.
                base_parts = list(mod_parts) if is_package else mod_parts[:-1]
                up = node.level - 1
                if up > 0:
                    if up > len(base_parts):
                        continue
                    base_parts = base_parts[:-up]
                if node.module:
                    base_parts = base_parts + node.module.split(".")
                base = ".".join(base_parts)
            elif node.module:
                base = node.module
            else:
                continue

            if not base:
                continue

            # For each imported name, prefer the submodule target when it
            # exists (`from pkg import sub` → edge to `pkg.sub`); otherwise
            # the name is a symbol from `base`, so edge to `base`.
            for alias in node.names:
                if alias.name == "*":
                    target = base
                else:
                    expanded = f"{base}.{alias.name}"
                    target = expanded if expanded in known_modules else base
                if target == mod_name:
                    continue
                if target in known_modules:
                    edges.add(target)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == mod_name:
                    continue
                if alias.name in known_modules:
                    edges.add(alias.name)
    return edges


def _build_module_graph() -> dict[str, set[str]]:
    """Build directed graph: module -> set of first-party modules it imports."""
    file_to_module = _collect_first_party_modules()
    known_modules = set(file_to_module.values())
    graph: dict[str, set[str]] = {}
    for path, mod_name in file_to_module.items():
        graph[mod_name] = _extract_first_party_edges(path, mod_name, known_modules)
    return graph


def _find_cycles(graph: dict[str, set[str]]) -> list[list[str]]:
    """Return a list of cycles as module-name paths using DFS back-edge detection."""
    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[str, int] = {node: WHITE for node in graph}
    stack: list[str] = []
    cycles: list[list[str]] = []
    seen_cycles: set[tuple[str, ...]] = set()

    def dfs(node: str) -> None:
        color[node] = GRAY
        stack.append(node)
        for neighbor in graph.get(node, ()):
            if neighbor not in color:
                continue  # unresolved target (e.g., package import w/o __init__ entry)
            if color[neighbor] == GRAY:
                # Back-edge: extract the cycle from stack
                idx = stack.index(neighbor)
                cycle = stack[idx:] + [neighbor]
                # Normalize so duplicates collapse regardless of rotation
                key = tuple(sorted(cycle[:-1]))
                if key not in seen_cycles:
                    seen_cycles.add(key)
                    cycles.append(cycle)
            elif color[neighbor] == WHITE:
                dfs(neighbor)
        stack.pop()
        color[node] = BLACK

    for node in graph:
        if color[node] == WHITE:
            dfs(node)
    return cycles


def test_no_circular_imports():
    """First-party module graph must be acyclic."""
    graph = _build_module_graph()
    cycles = _find_cycles(graph)
    if not cycles:
        return
    violations: list[str] = []
    for cycle in cycles:
        chain = " → ".join(cycle)
        violations.append(
            f"CIRCULAR IMPORT in first-party modules:\n"
            f"  {chain}\n"
            f"  → Fix: Break the cycle by moving shared logic to a lower layer "
            f"or extracting to a provider."
        )
    assert not violations, "\n".join(violations)


# ═══════════════════════════════════════════════════════════════════════
# Invariant 9: Wiring correctness
# For each domain that exists under domains/, worker.py should import
# from domains/<name>/ rather than from tools/<name>.
# ═══════════════════════════════════════════════════════════════════════


def test_wiring_correctness():
    """Refactored domains should be wired from domains/, not tools/."""
    if not WORKER_PY.exists():
        return

    domains = set(_discover_domains())
    if not domains:
        return

    worker_imports = _parse_imports(WORKER_PY)

    violations: list[str] = []
    for mod in worker_imports:
        parts = mod.split(".")
        # Check for tools.<domain_name> imports where domain exists in domains/
        if len(parts) >= 2 and parts[0] == "tools":
            tool_name = parts[1]
            if tool_name in domains:
                violations.append(
                    f"WIRING VIOLATION in worker.py:\n"
                    f"  Imports '{mod}' but domain exists at domains/{tool_name}/\n"
                    f"  → Fix: Update import to point to domains/{tool_name}/ location."
                )

    assert not violations, "\n".join(violations)


_WORKFLOW_PARK_RE = re.compile(r"\b(?:workflow|wf)\.(wait_condition|sleep)\s*\(")
_CUTOVER_CLASS_RE = re.compile(r"cutover-class:\s*(primitive|activity-bound|bounded|deploy-gate)")
_CUTOVER_SCAN_DIRS = ("workflows", "domains", "loop", "helpers")


def test_every_workflow_park_is_cutover_classified():
    """Every Temporal workflow park must declare how cutover treats it.

    Unbounded in-tool waits must use wait_condition_or_generation_handoff
    (primitive). Activity-bound waits cannot continue_as_new until the
    activity ends (force-clear replaces). Bounded 30s slices re-check at
    the next run_agent checkpoint. Deploy-gate parks are isolated validation
    runs, never user agents.
    """
    violations: list[str] = []
    for dirname in _CUTOVER_SCAN_DIRS:
        root = AGENTS_ROOT / dirname
        if not root.is_dir():
            continue
        for path in root.rglob("*.py"):
            if "test" in path.parts:
                continue
            lines = path.read_text(encoding="utf-8").splitlines()
            for index, line in enumerate(lines):
                stripped = line.lstrip()
                if stripped.startswith("#"):
                    continue
                if not _WORKFLOW_PARK_RE.search(line):
                    continue
                window = "\n".join(lines[max(0, index - 3) : index + 1])
                if _CUTOVER_CLASS_RE.search(window):
                    continue
                rel = path.relative_to(AGENTS_ROOT)
                violations.append(f"{rel}:{index + 1}: {stripped}")
    assert not violations, (
        "Every workflow.wait_condition / workflow.sleep must be tagged "
        "`# cutover-class: primitive|activity-bound|bounded|deploy-gate` "
        "on the call or within the 3 preceding lines.\n" + "\n".join(violations)
    )


# ═══════════════════════════════════════════════════════════════════════
# Invariant 11: Activity registration
# An activity the workflow schedules but worker.py never registers fails
# only at runtime, on the first workflow that reaches that call.
# ═══════════════════════════════════════════════════════════════════════

_ACTIVITY_SCAN_DIRS = ("workflows", "domains", "loop", "helpers", "tools")


def _worker_registered_activities() -> set[str]:
    tree = ast.parse(WORKER_PY.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "registered_activities" for target in node.targets
        ):
            assert isinstance(node.value, ast.List), "worker.py registered_activities must be a list literal"
            return {
                elt.id if isinstance(elt, ast.Name) else elt.attr
                for elt in node.value.elts
                if isinstance(elt, (ast.Name, ast.Attribute))
            }
    raise AssertionError("worker.py no longer assigns registered_activities")


def test_every_scheduled_activity_is_registered():
    """workflow.execute_activity / start_activity targets are all in worker.py's registered_activities."""
    registered = _worker_registered_activities()
    violations: list[str] = []
    for dirname in _ACTIVITY_SCAN_DIRS:
        root = AGENTS_ROOT / dirname
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.py")):
            if "test" in path.parts or "tests" in path.parts:
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if not (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr in ("execute_activity", "start_activity")
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "workflow"
                    and node.args
                ):
                    continue
                target = node.args[0]
                if isinstance(target, ast.Name):
                    name = target.id
                elif isinstance(target, ast.Attribute):
                    name = target.attr
                elif isinstance(target, ast.Constant) and isinstance(target.value, str):
                    name = target.value
                else:
                    continue
                if name not in registered:
                    violations.append(f"{path.relative_to(AGENTS_ROOT)}:{node.lineno}: {name}")
    assert not violations, "Scheduled activities missing from worker.py registered_activities:\n" + "\n".join(
        violations
    )


def _registered_activity_functions() -> list:
    """Import every worker-registered activity function from its defining module."""
    import importlib

    registered = _worker_registered_activities()
    found: dict = {}
    for dirname in _ACTIVITY_SCAN_DIRS:
        for path in sorted((AGENTS_ROOT / dirname).rglob("*.py")):
            if "test" in path.parts or "tests" in path.parts:
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in tree.body:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in registered:
                    module = ".".join(path.relative_to(AGENTS_ROOT).with_suffix("").parts)
                    found.setdefault(node.name, module)
    if str(AGENTS_ROOT) not in sys.path:
        sys.path.insert(0, str(AGENTS_ROOT))
    return [getattr(importlib.import_module(module), name) for name, module in sorted(found.items())]


def _string_annotated_payload_classes(hint, seen: set) -> list[str]:
    """Payload classes reachable from ``hint`` whose own annotations are unevaluated strings."""
    import dataclasses
    import typing

    if id(hint) in seen:
        return []
    seen.add(id(hint))
    found: list[str] = []
    for arg in typing.get_args(hint):
        found += _string_annotated_payload_classes(arg, seen)
    if isinstance(hint, type) and (typing.is_typeddict(hint) or dataclasses.is_dataclass(hint)):
        raw = getattr(hint, "__annotations__", {})
        lazy = [field for field, value in raw.items() if isinstance(value, (str, typing.ForwardRef))]
        if lazy:
            found.append(f"{hint.__module__}.{hint.__qualname__} ({', '.join(sorted(lazy))})")
        for value in typing.get_type_hints(hint).values():
            found += _string_annotated_payload_classes(value, seen)
    return found


def test_activity_payload_types_need_no_module_globals():
    """Activity argument/result TypedDicts and dataclasses carry real (non-string) annotations.

    Temporal decodes an activity result inside the workflow sandbox with
    get_type_hints(), resolving string annotations against the sandbox's
    sys.modules. A payload class imported via imports_passed_through() is not
    in that map, so `from __future__ import annotations` in its module makes
    every result decode fail with NameError and the workflow task retries
    forever (root agents hung at "Preparing Cloud Agent", 2026-10-20).
    """
    import typing

    violations: list[str] = []
    for fn in _registered_activity_functions():
        for hint in typing.get_type_hints(fn).values():
            violations += [f"{fn.__name__}: {cls}" for cls in _string_annotated_payload_classes(hint, set())]
    assert not violations, (
        "Activity payload classes with string annotations (remove `from __future__ import annotations` "
        "from their module):\n" + "\n".join(sorted(set(violations)))
    )


_WORKFLOW_SANDBOX_MODULE = AGENTS_ROOT / "helpers" / "workflow_sandbox.py"
_SANDBOX_CONFIG_NAMES = frozenset({"SandboxRestrictions", "SandboxedWorkflowRunner", "UnsandboxedWorkflowRunner"})


def test_workflow_sandbox_is_production_only():
    """Only helpers/workflow_sandbox.py builds workflow sandbox restrictions or runners.

    A test sandbox that passes every module through hides workflow code that
    only fails under the worker's restrictions: a lazily imported module that
    calls os.getenv failed every production agent's first workflow task while
    the passthrough-all workflow suites stayed green.
    """
    violations: list[str] = []
    for path in sorted(AGENTS_ROOT.rglob("*.py")):
        if "venv" in path.parts or path == _WORKFLOW_SANDBOX_MODULE:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("temporalio.worker"):
                names = {alias.name for alias in node.names} & _SANDBOX_CONFIG_NAMES
                if names:
                    violations.append(f"{path.relative_to(AGENTS_ROOT)}:{node.lineno}: imports {sorted(names)}")
            elif isinstance(node, ast.Attribute) and node.attr in _SANDBOX_CONFIG_NAMES:
                violations.append(f"{path.relative_to(AGENTS_ROOT)}:{node.lineno}: uses {node.attr}")
    assert not violations, "Run workflows with helpers.workflow_sandbox.production_workflow_runner():\n" + "\n".join(
        violations
    )


async def run_all_tests():
    print("structural-architecture tests:")
    r = BlackboxResult()
    r.record("provider_boundary", test_provider_boundary)
    r.record("utils_boundary", test_utils_boundary)
    r.record("data_access_boundary", test_data_access_boundary)
    r.record("no_framework_in_data_layers", test_no_framework_in_data_layers)
    r.record("no_circular_imports", test_no_circular_imports)
    r.record("wiring_correctness", test_wiring_correctness)
    r.record("every_workflow_park_is_cutover_classified", test_every_workflow_park_is_cutover_classified)
    r.record("every_scheduled_activity_is_registered", test_every_scheduled_activity_is_registered)
    r.record("workflow_sandbox_is_production_only", test_workflow_sandbox_is_production_only)
    r.record("activity_payload_types_need_no_module_globals", test_activity_payload_types_need_no_module_globals)
    return r.all_passed


if __name__ == "__main__":
    passed = asyncio.run(run_all_tests())
    sys.exit(0 if passed else 1)
