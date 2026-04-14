"""Structural test: enforce forward-only import directions within domain layers.

Auto-discovers all domains under domains/ and verifies each layer file
only imports from layers it is allowed to depend on.

Layer ordering (forward-only):
  types  -> (external only)
  config -> own types
  repo   -> own types, own config
  service -> own repo, own types, own config
  handler -> own service, own types

Cross-domain imports and reverse-direction imports are violations.
"""

import ast
import sys
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
DOMAINS_DIR = AGENTS_ROOT / "domains"

LAYERS = ("types", "config", "repo", "service", "handler")

# For each layer, which same-domain layers may it import?
ALLOWED_INTRA_DOMAIN = {
    "types": set(),
    "config": {"types"},
    "repo": {"types", "config"},
    "service": {"repo", "types", "config"},
    "handler": {"service", "types"},
}


def _extract_domain_imports(filepath: Path, domain_pkg: str) -> list[str]:
    """Return all ``from domains.*`` module paths imported by *filepath*."""
    source = filepath.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(filepath))
    imports: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            if node.module.startswith("domains."):
                imports.append(node.module)
    return imports


def discover_domains() -> list[str]:
    """Return sorted list of domain package names under domains/."""
    if not DOMAINS_DIR.is_dir():
        return []
    return sorted(
        d.name
        for d in DOMAINS_DIR.iterdir()
        if d.is_dir() and (d / "__init__.py").exists() and d.name != "__pycache__"
    )


def check_domain(domain_name: str) -> list[str]:
    """Validate import directions for one domain. Returns list of violation strings."""
    domain_dir = DOMAINS_DIR / domain_name
    domain_pkg = f"domains.{domain_name}"
    violations: list[str] = []

    for layer in LAYERS:
        filepath = domain_dir / f"{layer}.py"
        if not filepath.exists():
            violations.append(f"{domain_name}/{layer}.py: MISSING (every domain needs every layer)")
            continue

        domain_imports = _extract_domain_imports(filepath, domain_pkg)
        allowed_layers = ALLOWED_INTRA_DOMAIN[layer]

        for imp in domain_imports:
            if imp.startswith(domain_pkg + "."):
                # Intra-domain import — check layer direction
                target_layer = imp.split(".")[-1]
                if target_layer not in allowed_layers:
                    violations.append(
                        f"{domain_name}/{layer}.py imports {imp} "
                        f"(allowed: {sorted(allowed_layers) or 'none'})"
                    )
            else:
                # Cross-domain import
                violations.append(f"{domain_name}/{layer}.py imports {imp} (cross-domain not allowed)")

    return violations


def test_all_domains():
    """Entry point: check every domain, print results, exit non-zero on failure."""
    domains = discover_domains()
    if not domains:
        print("No domains found under domains/ — nothing to check.")
        return True

    all_violations: list[str] = []
    for domain in domains:
        violations = check_domain(domain)
        status = "PASS" if not violations else "FAIL"
        print(f"  {domain}: {status}")
        for v in violations:
            print(f"    ✗ {v}")
        all_violations.extend(violations)

    print()
    if all_violations:
        print(f"FAIL: {len(all_violations)} violation(s)")
        return False

    print(f"PASS: {len(domains)} domain(s), 0 violations")
    return True


if __name__ == "__main__":
    ok = test_all_domains()
    sys.exit(0 if ok else 1)
