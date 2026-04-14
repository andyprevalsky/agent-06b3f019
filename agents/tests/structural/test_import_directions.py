"""Structural test: verify import directions in domain layer files.

Auto-discovers all domains under domains/ and validates that each layer
only imports from allowed sources (forward-only, never reverse).
"""

import ast
import sys
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(AGENTS_ROOT))

# Layer ordering (index = rank; lower may not import from higher)
LAYER_ORDER = ["types", "config", "repo", "service", "handler"]

# What each layer may import from (own domain only)
ALLOWED_OWN_IMPORTS: dict[str, set[str]] = {
    "types": set(),
    "config": {"types"},
    "repo": {"types", "config"},
    "service": {"types", "config", "repo"},
    "handler": {"types", "config", "repo", "service"},
}

# External (non-domain) imports that are always allowed
PROVIDER_PREFIXES = ("config", "tools.base", "helpers.")


def _get_relative_imports(file_path: Path) -> list[str]:
    """Parse relative imports from a Python file."""
    source = file_path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(file_path))
    modules = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level and node.level > 0 and node.module:
            modules.append(node.module.split(".")[0])
    return modules


def _get_absolute_domain_imports(file_path: Path) -> list[str]:
    """Parse absolute imports that reference another domain."""
    source = file_path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(file_path))
    domain_imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            if node.module.startswith("domains."):
                parts = node.module.split(".")
                if len(parts) >= 3:
                    domain_imports.append(f"{parts[1]}/{parts[2]}")
    return domain_imports


def discover_domains() -> list[str]:
    """Find all domain directories."""
    domains_dir = AGENTS_ROOT / "domains"
    if not domains_dir.exists():
        return []
    return sorted(
        d.name for d in domains_dir.iterdir()
        if d.is_dir() and not d.name.startswith("_")
    )


def check_domain(domain_name: str) -> list[str]:
    """Check import directions for a single domain. Returns list of violations."""
    domain_dir = AGENTS_ROOT / "domains" / domain_name
    violations = []

    for layer_name in LAYER_ORDER:
        layer_file = domain_dir / f"{layer_name}.py"
        if not layer_file.exists():
            violations.append(f"{domain_name}/{layer_name}.py: MISSING (all layers required)")
            continue

        # Check relative imports (within own domain)
        rel_imports = _get_relative_imports(layer_file)
        allowed = ALLOWED_OWN_IMPORTS[layer_name]
        for imp in rel_imports:
            if imp not in allowed:
                violations.append(
                    f"{domain_name}/{layer_name}.py: imports .{imp} "
                    f"(allowed: {sorted(allowed) if allowed else 'none'})"
                )

        # Check cross-domain imports
        cross_imports = _get_absolute_domain_imports(layer_file)
        for imp in cross_imports:
            other_domain = imp.split("/")[0]
            if other_domain != domain_name:
                violations.append(
                    f"{domain_name}/{layer_name}.py: imports from domain '{other_domain}' "
                    f"(cross-domain imports forbidden)"
                )

    return violations


def run_all() -> bool:
    """Run structural checks on all domains. Returns True if all pass."""
    domains = discover_domains()
    if not domains:
        print("No domains found under domains/")
        return True

    all_violations = []
    for domain in domains:
        violations = check_domain(domain)
        all_violations.extend(violations)

    if all_violations:
        print(f"STRUCTURAL VIOLATIONS ({len(all_violations)}):")
        for v in all_violations:
            print(f"  {v}")
        return False

    print(f"All {len(domains)} domain(s) pass structural checks: {', '.join(domains)}")
    return True


if __name__ == "__main__":
    passed = run_all()
    sys.exit(0 if passed else 1)
