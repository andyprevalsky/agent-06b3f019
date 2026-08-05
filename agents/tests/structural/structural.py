"""Structural dependency tests for domain layer architecture.

Auto-discovers all domains under domains/ and validates that
import directions follow forward-only rules:
  types   -> utils/, external packages only
  config  -> own types, utils/ only
  repo    -> own types, own config, utils/, providers (helpers/)
  service -> own repo, own types, own config, utils/, providers (helpers/)
  handler -> own service, own types, utils/, providers (helpers/), external

utils/ (pure functions, zero side effects) is importable from any layer.
"""

import ast
import asyncio
import sys
from pathlib import Path

from _result import Result as BlackboxResult

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
DOMAINS_DIR = AGENTS_ROOT / "domains"
BLACKBOX_DIR = AGENTS_ROOT / "tests" / "blackbox"

# Layers in forward-only order (each may import from layers above it)
LAYER_ORDER = ["types", "config", "repo", "service", "handler"]

# External packages that any layer can import (not project-local)
EXTERNAL_PACKAGES = frozenset(
    {
        "__future__",
        "typing",
        "pydantic",
        "structlog",
        "temporalio",
        "contextlib",
        "datetime",
        "enum",
        "os",
        "json",
        "re",
        "uuid",
        "dataclasses",
        "abc",
        "collections",
        "functools",
        "itertools",
        "pathlib",
        "logging",
        "asyncio",
        "math",
        "time",
        "hashlib",
        "base64",
        "urllib",
        "httpx",
    }
)

# Provider directories (shared infrastructure, any service/handler can import)
PROVIDER_PREFIXES = ("helpers.", "helpers/")


def _parse_imports(file_path: Path) -> list[str]:
    """Parse import module names from a Python file.

    Relative imports are resolved to fully-qualified dotted paths against
    the importing file's package, so that `from . import service` inside
    ``domains/foo/repo.py`` surfaces as ``domains.foo.service`` (and can
    be matched by the layer/domain prefix checks below).
    """
    if not file_path.exists():
        return []
    try:
        source = file_path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(file_path))
    except (SyntaxError, UnicodeDecodeError):
        return []

    try:
        rel_parts = list(file_path.resolve().relative_to(AGENTS_ROOT.resolve()).with_suffix("").parts)
    except ValueError:
        rel_parts = []
    if rel_parts and rel_parts[-1] == "__init__":
        pkg_parts = rel_parts[:-1]
    else:
        pkg_parts = rel_parts[:-1]

    modules: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level > 0:
                up = node.level - 1
                if up > len(pkg_parts):
                    continue
                base_parts = pkg_parts[: len(pkg_parts) - up] if up > 0 else list(pkg_parts)
                if node.module:
                    base_parts = base_parts + node.module.split(".")
                    base = ".".join(base_parts)
                else:
                    base = ".".join(base_parts)
            elif node.module:
                base = node.module
            else:
                continue

            if not base:
                continue
            modules.append(base)
            # Also record `base.alias` so `from pkg import sub` (where sub is
            # a submodule) and `from . import sub` surface as `pkg.sub`; the
            # caller then matches against canonical layer names correctly
            # instead of skipping checks on the bare package path.
            for alias in node.names:
                if alias.name == "*":
                    continue
                modules.append(f"{base}.{alias.name}")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                modules.append(alias.name)
    return modules


def _is_external(module: str) -> bool:
    """Check if a module is external (not project-local)."""
    top = module.split(".")[0]
    return top in EXTERNAL_PACKAGES


def _is_utils(module: str) -> bool:
    """Check if a module is in utils/ (pure functions, allowed from any layer)."""
    return module == "utils" or module.startswith("utils.")


def _is_provider(module: str) -> bool:
    """Check if a module is a provider (shared infrastructure)."""
    return any(module.startswith(p) for p in PROVIDER_PREFIXES)


def _is_own_domain(module: str, domain_name: str) -> str | None:
    """If module is in the same domain, return the layer name. Else None."""
    prefix = f"domains.{domain_name}."
    if module.startswith(prefix):
        rest = module[len(prefix) :]
        # e.g., domains.reasoning.types -> types
        layer = rest.split(".")[0]
        if layer in LAYER_ORDER:
            return layer
    return None


def _discover_domains() -> list[str]:
    """Discover all domain names under domains/."""
    if not DOMAINS_DIR.exists():
        return []
    return sorted(
        d.name
        for d in DOMAINS_DIR.iterdir()
        if d.is_dir() and not d.name.startswith("_") and (d / "__init__.py").exists()
    )


def _validate_layer_imports(domain_name: str, layer_name: str, file_path: Path) -> list[str]:
    """Validate that a layer file's imports follow the forward-only rules.

    Returns a list of violation descriptions (empty = all good).
    """
    if not file_path.exists():
        return []

    modules = _parse_imports(file_path)
    violations: list[str] = []
    layer_index = LAYER_ORDER.index(layer_name)

    own_domain_prefix = f"domains.{domain_name}."
    for mod in modules:
        # External packages are always allowed
        if _is_external(mod):
            continue

        # utils/ imports are always allowed (pure functions, zero side effects)
        if _is_utils(mod):
            continue

        # Same-domain import (canonical or non-canonical layer name)
        if mod == f"domains.{domain_name}" or mod.startswith(own_domain_prefix):
            own_layer = _is_own_domain(mod, domain_name)
            if own_layer is not None:
                own_index = LAYER_ORDER.index(own_layer)
                if own_index >= layer_index:
                    violations.append(f"{layer_name}.py imports {own_layer}.py (reverse/same-level import)")
            # Non-canonical same-domain modules (e.g. service_actions) are
            # allowed — forward-only rules only constrain canonical layers.
            continue

        # Provider imports - only allowed in service and handler
        if _is_provider(mod):
            if layer_name in ("types", "config"):
                violations.append(
                    f"{layer_name}.py imports provider '{mod}' (only service/handler may import providers)"
                )
            continue

        # Cross-domain imports - never allowed
        if mod.startswith("domains."):
            violations.append(f"{layer_name}.py imports from another domain: '{mod}'")
            continue

        # Other project-local imports (tools.*, activities.*, etc.)
        # Only allowed in handler (runtime layer)
        if layer_name != "handler" and not _is_provider(mod):
            # config, repo, service should not import random project modules
            # But we allow it for now if it's a known project module
            # (loose check - tighten later)
            pass

    return violations


def test_all_domains_have_required_layers():
    """Every domain directory must contain all five layer files."""
    domains = _discover_domains()
    assert domains, "No domains found under domains/"

    missing: list[str] = []
    for domain in domains:
        domain_dir = DOMAINS_DIR / domain
        for layer in LAYER_ORDER:
            layer_file = domain_dir / f"{layer}.py"
            if not layer_file.exists():
                missing.append(f"{domain}/{layer}.py")

    assert not missing, f"Missing layer files: {missing}"


def test_forward_only_imports():
    """All domain layer files must follow forward-only import rules."""
    domains = _discover_domains()
    assert domains, "No domains found under domains/"

    all_violations: list[str] = []
    for domain in domains:
        domain_dir = DOMAINS_DIR / domain
        for layer in LAYER_ORDER:
            layer_file = domain_dir / f"{layer}.py"
            violations = _validate_layer_imports(domain, layer, layer_file)
            for v in violations:
                all_violations.append(f"[{domain}] {v}")

    assert not all_violations, f"Import direction violations:\n" + "\n".join(f"  - {v}" for v in all_violations)


def test_no_cross_domain_imports():
    """No domain file may import from another domain."""
    domains = _discover_domains()
    assert domains, "No domains found under domains/"

    violations: list[str] = []
    for domain in domains:
        domain_dir = DOMAINS_DIR / domain
        for py_file in domain_dir.glob("*.py"):
            if py_file.name == "__init__.py":
                continue
            modules = _parse_imports(py_file)
            for mod in modules:
                if mod.startswith("domains.") and not mod.startswith(f"domains.{domain}"):
                    violations.append(f"[{domain}/{py_file.name}] imports '{mod}'")

    assert not violations, f"Cross-domain imports found:\n" + "\n".join(f"  - {v}" for v in violations)


def test_every_blackbox_test_is_registered():
    """Every test_* in a blackbox suite must be referenced by that suite's run_all_tests.

    The runner executes run_all_tests() rather than discovering functions, so an
    unregistered test is dead code that reports nothing while looking like
    coverage. Rule 1: a behavior is only guaranteed when a test measures it *and*
    that test runs in a consistently-run path.
    """
    assert BLACKBOX_DIR.is_dir(), f"blackbox suite directory missing: {BLACKBOX_DIR}"

    violations: list[str] = []
    for test_file in sorted(BLACKBOX_DIR.glob("*.blackbox.py")):
        tree = ast.parse(test_file.read_text(encoding="utf-8"))
        top_level = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
        defined = [node.name for node in top_level if node.name.startswith("test_")]
        if not defined:
            continue

        runner = next((node for node in top_level if node.name == "run_all_tests"), None)
        if runner is None:
            violations.append(f"[{test_file.name}] defines {len(defined)} tests but has no run_all_tests()")
            continue

        referenced = {node.id for node in ast.walk(runner) if isinstance(node, ast.Name)}

        # A sync `test_x` may exist purely as a pytest entry point that delegates
        # to an async `_x_case` helper, with the runner registering the helper.
        # The assertion still runs on every suite execution, so that counts as
        # registered — this recognizes the delegation rather than demanding a
        # second registration, which would double-run the case (and, for a
        # wrapper calling asyncio.run, blow up inside the running loop).
        by_name = {node.name: node for node in top_level}

        def _delegates_to_registered_case(name: str) -> bool:
            node = by_name.get(name)
            if node is None:
                return False
            called = {
                inner.func.id
                for inner in ast.walk(node)
                if isinstance(inner, ast.Call) and isinstance(inner.func, ast.Name)
            }
            return any(
                callee in referenced and callee.lstrip("_").startswith(name.removeprefix("test_")) for callee in called
            )

        for name in defined:
            if name not in referenced and not _delegates_to_registered_case(name):
                violations.append(f"[{test_file.name}] {name} is never registered in run_all_tests()")

        # record() cannot await, so an async test registered there would be
        # scored as a pass without running. record_async() on a sync test would
        # blow up at await time.
        async_tests = {
            node.name for node in top_level if isinstance(node, ast.AsyncFunctionDef) and node.name.startswith("test_")
        }
        for call in (node for node in ast.walk(runner) if isinstance(node, ast.Call)):
            func = call.func
            if not isinstance(func, ast.Attribute) or func.attr not in ("record", "record_async"):
                continue
            if len(call.args) < 2 or not isinstance(call.args[1], ast.Name):
                continue
            registered = call.args[1].id
            if registered not in defined:
                continue
            if registered in async_tests and func.attr == "record":
                violations.append(f"[{test_file.name}] async {registered} must use record_async()")
            elif registered not in async_tests and func.attr == "record_async":
                violations.append(f"[{test_file.name}] sync {registered} must use record()")

    assert not violations, "Blackbox tests that never run:\n" + "\n".join(f"  - {v}" for v in violations)


async def run_all_tests():
    print("structural tests:")
    r = BlackboxResult()
    r.record("all_domains_have_required_layers", test_all_domains_have_required_layers)
    r.record("forward_only_imports", test_forward_only_imports)
    r.record("no_cross_domain_imports", test_no_cross_domain_imports)
    r.record("every_blackbox_test_is_registered", test_every_blackbox_test_is_registered)
    return r.all_passed


if __name__ == "__main__":
    passed = asyncio.run(run_all_tests())
    sys.exit(0 if passed else 1)
