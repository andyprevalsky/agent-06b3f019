"""Structural test: verify domain layer import directions.

Auto-discovers all domain packages under tools/ that have layer files
(types.py, config.py, repo.py, service.py, handler.py) and validates
that each layer only imports from allowed sources.

Import direction rules (forward-only):
  types.py   -> external packages only
  config.py  -> own types only (no other domain layers)
  repo.py    -> own types, own config, providers (helpers/, config)
  service.py -> own repo, own types, own config, providers
  handler.py -> own service, own types, own config, providers (NOT own repo)
"""

import ast
import os
import sys

# ── Layer import rules ──
# Each layer lists which *own-domain* layers it may import from.
# Imports from external packages and providers (helpers/, config, tools.base) are always allowed.
ALLOWED_OWN_IMPORTS: dict[str, set[str]] = {
    "types": set(),
    "config": {"types"},
    "repo": {"types", "config"},
    "service": {"types", "config", "repo"},
    "handler": {"types", "config", "service"},
}

LAYER_FILES = {"types", "config", "repo", "service", "handler"}


def _get_domain_packages(tools_dir: str) -> list[str]:
    """Find all tool domain packages (directories with __init__.py and layer files)."""
    domains = []
    if not os.path.isdir(tools_dir):
        return domains
    for entry in sorted(os.listdir(tools_dir)):
        pkg_dir = os.path.join(tools_dir, entry)
        if not os.path.isdir(pkg_dir):
            continue
        if not os.path.exists(os.path.join(pkg_dir, "__init__.py")):
            continue
        # Check if it has at least one layer file
        has_layer = any(os.path.exists(os.path.join(pkg_dir, f"{layer}.py")) for layer in LAYER_FILES)
        if has_layer:
            domains.append(entry)
    return domains


def _extract_imports(filepath: str) -> list[str]:
    """Extract all import module strings from a Python file using AST."""
    with open(filepath) as f:
        tree = ast.parse(f.read(), filename=filepath)

    modules = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                modules.append(alias.name)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.append(node.module)
    return modules


def _check_layer_imports(domain: str, layer: str, filepath: str) -> list[str]:
    """Check that a layer file only imports from allowed own-domain layers.

    Returns list of violation descriptions (empty = pass).
    """
    if not os.path.exists(filepath):
        return []

    allowed = ALLOWED_OWN_IMPORTS.get(layer, set())
    violations = []
    domain_prefix = f"tools.{domain}."

    for module in _extract_imports(filepath):
        if not module.startswith(domain_prefix):
            continue  # External or provider import -- always allowed

        # Extract the layer name from the import (e.g. "tools.web_search.repo" -> "repo")
        parts = module.removeprefix(domain_prefix).split(".")
        imported_layer = parts[0]

        if imported_layer not in LAYER_FILES:
            continue  # Not a recognized layer file

        if imported_layer not in allowed:
            violations.append(
                f"  {layer}.py imports {imported_layer}.py "
                f"(allowed: {sorted(allowed) if allowed else 'none'})"
            )

    return violations


def test_domain_import_directions():
    """All domain layer files must follow forward-only import rules."""
    agents_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    tools_dir = os.path.join(agents_dir, "tools")

    domains = _get_domain_packages(tools_dir)
    if not domains:
        print("  (no domain packages found -- skipping)")
        return True

    all_violations: list[str] = []

    for domain in domains:
        pkg_dir = os.path.join(tools_dir, domain)
        domain_violations: list[str] = []

        for layer in LAYER_FILES:
            filepath = os.path.join(pkg_dir, f"{layer}.py")
            domain_violations.extend(_check_layer_imports(domain, layer, filepath))

        if domain_violations:
            all_violations.append(f"Domain '{domain}':")
            all_violations.extend(domain_violations)

    if all_violations:
        print("Import direction violations:")
        for v in all_violations:
            print(v)
        return False

    print(f"  All {len(domains)} domain(s) pass import direction rules: {domains}")
    return True


if __name__ == "__main__":
    passed = test_domain_import_directions()
    sys.exit(0 if passed else 1)
