"""Structural architecture tests — boundary invariants beyond import direction.

Covers invariants NOT already tested by structural.blackbox.py (completeness,
forward-only imports) and structural_imports.blackbox.py (detailed import
directions, cross-domain isolation).

Invariants tested here:
  3. Provider boundary — helpers/ must not import from domains/
  4. Utils boundary    — utils/ must not import from project source tree
  6. Data access boundary — httpx only in repo*.py within domains/
  7. Framework leak    — temporalio.workflow not in types/config/repo layers
  9. Wiring correctness — worker.py should import refactored domains from domains/

All tests auto-discover domains. No hardcoded domain names.
"""

import ast
import asyncio
import sys
from pathlib import Path

from _test_utils import BlackboxResult

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
DOMAINS_DIR = AGENTS_ROOT / "domains"
HELPERS_DIR = AGENTS_ROOT / "helpers"
UTILS_DIR = AGENTS_ROOT / "utils"
WORKER_PY = AGENTS_ROOT / "worker.py"

# First-party top-level packages (anything in the project source tree)
FIRST_PARTY_PACKAGES = frozenset({
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
})

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
# httpx (HTTP client) should only appear in repo*.py files within domains/.
# types.py and config.py must never import httpx.
# service*.py importing httpx is flagged as tech debt.
# ═══════════════════════════════════════════════════════════════════════


def test_data_access_boundary():
    """httpx must not be imported in domain types.py or config.py files."""
    domains = _discover_domains()
    if not domains:
        return

    violations: list[str] = []
    # These layers must NEVER import the HTTP data client
    forbidden_layers = ("types", "config")

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


async def run_all_tests():
    print("structural-architecture blackbox tests:")
    r = BlackboxResult()
    r.record("provider_boundary", test_provider_boundary)
    r.record("utils_boundary", test_utils_boundary)
    r.record("data_access_boundary", test_data_access_boundary)
    r.record("no_framework_in_data_layers", test_no_framework_in_data_layers)
    r.record("wiring_correctness", test_wiring_correctness)
    return r.all_passed


if __name__ == "__main__":
    passed = asyncio.run(run_all_tests())
    sys.exit(0 if passed else 1)
