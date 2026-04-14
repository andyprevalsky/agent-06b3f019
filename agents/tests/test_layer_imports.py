"""Structural dependency test — verifies forward-only import directions in domain layers.

Auto-discovers all domains under agents/domains/ and enforces:
  types.py   → external packages only (+ own domain types)
  config.py  → own types only
  repo.py    → own types, own config, providers (config, helpers, tools.base)
  service.py → own repo, own types, own config, providers
  handler.py → own service, own types, providers
"""

import ast
import sys
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parent.parent
DOMAINS_DIR = AGENTS_ROOT / "domains"

# Provider packages (shared infrastructure, not domain-specific)
PROVIDERS = {"config", "helpers", "tools", "activities", "workflows", "loop", "health_server"}


def _get_imports(filepath: Path) -> list[str]:
    """Extract all top-level import module names from a Python file."""
    source = filepath.read_text()
    tree = ast.parse(source, filename=str(filepath))
    modules = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                modules.append(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                modules.append(node.module.split(".")[0])
    return modules


def _is_own_domain(module: str, domain_name: str) -> bool:
    """Check if a module path refers to the same domain."""
    return module == "domains" or module.startswith(f"domains.{domain_name}")


def _is_external(module: str) -> bool:
    """Check if a module is external (stdlib or third-party)."""
    # Known first-party roots
    first_party = {"domains", "config", "helpers", "tools", "activities", "workflows", "loop", "health_server"}
    return module not in first_party


def _is_provider(module: str) -> bool:
    """Check if a module is a provider (shared infrastructure)."""
    return module in PROVIDERS


def _is_other_domain(module: str, domain_name: str) -> bool:
    """Check if a module imports from a different domain."""
    if not module.startswith("domains."):
        return False
    parts = module.split(".")
    if len(parts) < 2:
        return False
    return parts[1] != domain_name


def check_domain(domain_path: Path) -> list[str]:
    """Check a single domain for import direction violations. Returns list of violation messages."""
    domain_name = domain_path.name
    violations = []

    layer_rules = {
        "types.py": {
            "allowed_own_layers": set(),  # types imports nothing from own domain
            "description": "types.py may only import external packages",
        },
        "config.py": {
            "allowed_own_layers": {"types"},
            "description": "config.py may only import from own types",
        },
        "repo.py": {
            "allowed_own_layers": {"types", "config"},
            "description": "repo.py may import from own types, own config, and providers",
        },
        "service.py": {
            "allowed_own_layers": {"types", "config", "repo"},
            "description": "service.py may import from own repo, own types, own config, and providers",
        },
        "handler.py": {
            "allowed_own_layers": {"types", "config", "service"},
            "description": "handler.py may import from own service, own types, own config, and providers",
        },
    }

    for layer_file, rules in layer_rules.items():
        filepath = domain_path / layer_file
        if not filepath.exists():
            violations.append(f"{domain_name}/{layer_file}: FILE MISSING")
            continue

        imports = _get_imports(filepath)
        allowed_own = rules["allowed_own_layers"]

        for mod in imports:
            # Skip external/stdlib imports — always allowed
            if _is_external(mod):
                continue

            # Check cross-domain imports (never allowed)
            if _is_other_domain(mod, domain_name):
                violations.append(
                    f"{domain_name}/{layer_file}: imports from other domain '{mod}' — "
                    f"domains must not import from each other"
                )
                continue

            # Check own-domain imports against layer rules
            if mod.startswith("domains"):
                # Parse which layer is being imported
                # e.g. "domains.grep.repo" -> "repo"
                full_mod = mod
                # Re-parse from the actual import statement to get full module path
                source = filepath.read_text()
                tree = ast.parse(source)
                for node in ast.walk(tree):
                    if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith(f"domains.{domain_name}."):
                        imported_layer = node.module.split(".")[-1]
                        if imported_layer not in allowed_own:
                            violations.append(
                                f"{domain_name}/{layer_file}: imports from own '{imported_layer}' layer — "
                                f"{rules['description']}"
                            )
                continue

            # Provider imports — allowed for repo, service, handler
            if _is_provider(mod):
                if layer_file in ("types.py", "config.py"):
                    violations.append(
                        f"{domain_name}/{layer_file}: imports provider '{mod}' — "
                        f"{rules['description']}"
                    )

    return violations


def run_all() -> bool:
    """Auto-discover domains and check all. Returns True if no violations."""
    if not DOMAINS_DIR.exists():
        print("No domains/ directory found — nothing to check.")
        return True

    domains = sorted(p for p in DOMAINS_DIR.iterdir() if p.is_dir() and not p.name.startswith("_"))

    if not domains:
        print("No domains found under domains/.")
        return True

    all_violations = []
    for domain_path in domains:
        violations = check_domain(domain_path)
        all_violations.extend(violations)

    if all_violations:
        print(f"STRUCTURAL VIOLATIONS ({len(all_violations)}):")
        for v in all_violations:
            print(f"  - {v}")
        return False

    print(f"All {len(domains)} domain(s) pass structural dependency checks.")
    return True


if __name__ == "__main__":
    success = run_all()
    sys.exit(0 if success else 1)
