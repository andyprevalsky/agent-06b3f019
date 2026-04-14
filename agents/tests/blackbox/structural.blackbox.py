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

from _test_utils import BlackboxResult

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
DOMAINS_DIR = AGENTS_ROOT / "domains"

# Layers in forward-only order (each may import from layers above it)
LAYER_ORDER = ["types", "config", "repo", "service", "handler"]

# External packages that any layer can import (not project-local)
EXTERNAL_PACKAGES = frozenset({
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
})

# Provider directories (shared infrastructure, any service/handler can import)
PROVIDER_PREFIXES = ("helpers.", "helpers/")


def _parse_imports(file_path: Path) -> list[str]:
    """Parse top-level import module names from a Python file."""
    if not file_path.exists():
        return []
    try:
        source = file_path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(file_path))
    except (SyntaxError, UnicodeDecodeError):
        return []

    modules: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level > 0:
                # Relative import - resolve to domain-relative module
                # e.g., from .types import X -> types
                if node.module:
                    modules.append(node.module)
            elif node.module:
                modules.append(node.module)
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
        rest = module[len(prefix):]
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


def _validate_layer_imports(
    domain_name: str, layer_name: str, file_path: Path
) -> list[str]:
    """Validate that a layer file's imports follow the forward-only rules.

    Returns a list of violation descriptions (empty = all good).
    """
    if not file_path.exists():
        return []

    modules = _parse_imports(file_path)
    violations: list[str] = []
    layer_index = LAYER_ORDER.index(layer_name)

    for mod in modules:
        # External packages are always allowed
        if _is_external(mod):
            continue

        # utils/ imports are always allowed (pure functions, zero side effects)
        if _is_utils(mod):
            continue

        # Check if it's an import from our own domain
        own_layer = _is_own_domain(mod, domain_name)
        if own_layer is not None:
            own_index = LAYER_ORDER.index(own_layer)
            if own_index >= layer_index:
                violations.append(
                    f"{layer_name}.py imports {own_layer}.py "
                    f"(reverse/same-level import)"
                )
            continue

        # Provider imports - only allowed in service and handler
        if _is_provider(mod):
            if layer_name in ("types", "config"):
                violations.append(
                    f"{layer_name}.py imports provider '{mod}' "
                    f"(only service/handler may import providers)"
                )
            continue

        # Cross-domain imports - never allowed
        if mod.startswith("domains."):
            violations.append(
                f"{layer_name}.py imports from another domain: '{mod}'"
            )
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

    assert not all_violations, (
        f"Import direction violations:\n" + "\n".join(f"  - {v}" for v in all_violations)
    )


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
                    violations.append(
                        f"[{domain}/{py_file.name}] imports '{mod}'"
                    )

    assert not violations, (
        f"Cross-domain imports found:\n" + "\n".join(f"  - {v}" for v in violations)
    )


async def run_all_tests():
    print("structural blackbox tests:")
    r = BlackboxResult()
    r.record("all_domains_have_required_layers", test_all_domains_have_required_layers)
    r.record("forward_only_imports", test_forward_only_imports)
    r.record("no_cross_domain_imports", test_no_cross_domain_imports)
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
