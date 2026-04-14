#!/usr/bin/env python3
"""Structural test: verify forward-only import directions in domain layers.

Auto-discovers all domains under domains/ and checks that each layer file
only imports from allowed sources.

Layer import rules:
  types.py   -> external packages only
  config.py  -> own types
  repo.py    -> own types, own config, providers (config, helpers, tools.base)
  service.py -> own repo, own types, own config, providers (helpers, tools.base)
  handler    -> own service, own types, own repo (via tools/<name>.py re-export)
"""

import ast
import sys
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
DOMAINS_DIR = AGENTS_ROOT / "domains"

# First-party top-level packages that are NOT domain layers
# (i.e., providers and shared infra the domain may import)
PROVIDER_PACKAGES = frozenset({
    "config",
    "helpers",
    "tools",
    "activities",
    "workflows",
    "loop",
    "browser_tools",
    "health_server",
})

LAYER_ORDER = ["types", "config", "repo", "service", "handler"]

# Allowed domain-internal imports per layer (references layers by name)
ALLOWED_INTERNAL = {
    "types": set(),
    "config": {"types"},
    "repo": {"types", "config"},
    "service": {"types", "config", "repo"},
    "handler": {"types", "config", "repo", "service"},
}

# Whether each layer may import from PROVIDER_PACKAGES
LAYER_MAY_IMPORT_PROVIDERS = {
    "types": False,
    "config": False,
    "repo": True,
    "service": True,
    "handler": True,
}


def _extract_imports(filepath: Path) -> list[str]:
    """Return all top-level import module names from a Python file."""
    source = filepath.read_text()
    tree = ast.parse(source)
    modules = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            modules.append(node.module)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                modules.append(alias.name)
    return modules


def _classify_import(module: str, domain_name: str) -> str | None:
    """Classify an import as 'internal:<layer>', 'provider', 'external', or None."""
    parts = module.split(".")

    # Own domain import: domains.<domain>.<layer>
    if len(parts) >= 3 and parts[0] == "domains" and parts[1] == domain_name:
        return f"internal:{parts[2]}"

    # Provider / shared infra
    if parts[0] in PROVIDER_PACKAGES:
        return "provider"

    # Everything else is external
    return "external"


def check_domain(domain_dir: Path) -> list[str]:
    """Check a single domain's layer imports. Returns list of violations."""
    domain_name = domain_dir.name
    violations: list[str] = []

    layer_files = {
        "types": domain_dir / "types.py",
        "config": domain_dir / "config.py",
        "repo": domain_dir / "repo.py",
        "service": domain_dir / "service.py",
    }

    for layer_name, filepath in layer_files.items():
        if not filepath.exists():
            violations.append(f"{domain_name}/{layer_name}.py: MISSING")
            continue

        imports = _extract_imports(filepath)
        allowed_internal = ALLOWED_INTERNAL[layer_name]
        may_use_providers = LAYER_MAY_IMPORT_PROVIDERS[layer_name]

        for module in imports:
            kind = _classify_import(module, domain_name)
            if kind is None:
                continue
            if kind == "external":
                continue
            if kind == "provider":
                if not may_use_providers:
                    violations.append(
                        f"{domain_name}/{layer_name}.py: "
                        f"imports provider '{module}' but {layer_name} layer forbids provider imports"
                    )
                continue
            # internal:<layer>
            imported_layer = kind.split(":")[1]
            if imported_layer not in allowed_internal:
                violations.append(
                    f"{domain_name}/{layer_name}.py: "
                    f"imports own '{imported_layer}' layer but {layer_name} may only import {allowed_internal or 'nothing'}"
                )

    return violations


def main() -> int:
    if not DOMAINS_DIR.exists():
        print("No domains/ directory found — nothing to check.")
        return 0

    all_violations: list[str] = []
    domain_count = 0

    for domain_dir in sorted(DOMAINS_DIR.iterdir()):
        if not domain_dir.is_dir() or domain_dir.name.startswith("_"):
            continue
        domain_count += 1
        all_violations.extend(check_domain(domain_dir))

    print(f"Checked {domain_count} domain(s)")

    if all_violations:
        print(f"\n{len(all_violations)} violation(s):")
        for v in all_violations:
            print(f"  ❌ {v}")
        return 1

    print("All import directions valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
