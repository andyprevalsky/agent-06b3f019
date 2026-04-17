"""Structural dependency test: verifies forward-only import directions in domain layers.

Auto-discovers all domains under domains/ and checks that each layer
only imports from permitted sources.

Import rules:
  types.py   -> utils/ (+ external)
  config.py  -> own types, utils/ (+ external)
  repo.py    -> own types, own config, utils/, providers (helpers/, tools/base) (+ external)
  service.py -> own types, own config, own repo, utils/ (+ external, NO handler, NO providers)
  handler.py -> own service, own types, own config, utils/, providers (helpers/*, tools/base) (+ external)

utils/ (pure functions, zero side effects) is importable from any layer.
"""

import ast
import asyncio
import sys
from pathlib import Path

from _result import Result as BlackboxResult

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
DOMAINS_DIR = AGENTS_ROOT / "domains"

# Known first-party top-level packages (anything NOT in this set is considered external)
FIRST_PARTY_PREFIXES = frozenset([
    "config",
    "domains",
    "tools",
    "helpers",
    "loop",
    "activities",
    "workflows",
    "browser_tools",
    "utils",
])

# utils/ contains pure functions with zero side effects — importable from any layer.
UTILS_PREFIX = "utils."


def _is_first_party(module: str) -> bool:
    top = module.split(".")[0]
    return top in FIRST_PARTY_PREFIXES


def _get_imports(path: Path) -> list[str]:
    """Return list of dotted module names imported by *path*."""
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(path))
    modules: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            modules.append(node.module)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                modules.append(alias.name)
    return modules


def _check_layer(
    domain_name: str,
    layer: str,
    path: Path,
    allowed_own_layers: set[str],
    allow_providers: bool,
) -> list[str]:
    """Return a list of violation descriptions (empty = pass)."""
    if not path.exists():
        return []

    own_prefix = f"domains.{domain_name}"
    violations: list[str] = []

    for mod in _get_imports(path):
        if not _is_first_party(mod):
            continue  # external package, always ok

        # utils/ imports are always allowed (pure functions, zero side effects)
        if mod.startswith(UTILS_PREFIX) or mod == "utils":
            continue

        # Own domain import?
        if mod.startswith(own_prefix):
            target_layer = mod.split(".")[-1] if mod.count(".") >= 2 else ""
            if target_layer and target_layer not in allowed_own_layers:
                violations.append(
                    f"{domain_name}/{layer} imports own layer '{target_layer}' "
                    f"(allowed: {sorted(allowed_own_layers)})"
                )
            continue

        # Cross-domain import?
        if mod.startswith("domains."):
            violations.append(
                f"{domain_name}/{layer} imports another domain: {mod}"
            )
            continue

        # First-party but not own domain -> provider-level import
        if not allow_providers:
            violations.append(
                f"{domain_name}/{layer} imports provider '{mod}' but providers are not allowed in this layer"
            )

    return violations


def _discover_domains() -> list[str]:
    if not DOMAINS_DIR.exists():
        return []
    return sorted(
        d.name for d in DOMAINS_DIR.iterdir()
        if d.is_dir() and (d / "__init__.py").exists()
    )


# ── Layer rules ──
# Each tuple: (layer_filename, set of own layers it may import, may_import_providers)
LAYER_RULES: list[tuple[str, set[str], bool]] = [
    ("types.py", set(), False),
    ("config.py", {"types"}, False),
    ("repo.py", {"types", "config"}, True),
    ("service.py", {"types", "config", "repo"}, True),
    ("handler.py", {"types", "config", "service"}, True),
]


async def test_import_directions():
    """All domain layers respect forward-only import directions."""
    domains = _discover_domains()
    assert domains, "No domains found under domains/ — expected at least one"

    all_violations: list[str] = []
    for domain in domains:
        domain_dir = DOMAINS_DIR / domain
        for layer_file, allowed, allow_prov in LAYER_RULES:
            path = domain_dir / layer_file
            violations = _check_layer(domain, layer_file.replace(".py", ""), path, allowed, allow_prov)
            all_violations.extend(violations)

    assert not all_violations, (
        f"Import direction violations ({len(all_violations)}):\n"
        + "\n".join(f"  - {v}" for v in all_violations)
    )


async def test_no_cross_domain_imports():
    """No domain imports from another domain."""
    domains = _discover_domains()
    violations: list[str] = []

    for domain in domains:
        domain_dir = DOMAINS_DIR / domain
        own_prefix = f"domains.{domain}"
        for py_file in domain_dir.glob("*.py"):
            for mod in _get_imports(py_file):
                if mod.startswith("domains.") and not mod.startswith(own_prefix):
                    violations.append(
                        f"{domain}/{py_file.name} imports cross-domain: {mod}"
                    )

    assert not violations, (
        f"Cross-domain import violations ({len(violations)}):\n"
        + "\n".join(f"  - {v}" for v in violations)
    )


async def run_all_tests():
    print("structural-imports tests:")
    r = BlackboxResult()
    await r.record_async("import_directions", test_import_directions)
    await r.record_async("no_cross_domain_imports", test_no_cross_domain_imports)
    return r.all_passed


if __name__ == "__main__":
    passed = asyncio.run(run_all_tests())
    sys.exit(0 if passed else 1)
