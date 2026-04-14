"""Structural dependency test: validates import direction rules for all domains.

Auto-discovers all domains under agents/domains/ and enforces forward-only imports.
Run: python tests/structural_test.py
"""

import ast
import sys
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parent.parent
DOMAINS_DIR = AGENTS_ROOT / "domains"

# Local package prefixes that count as "project imports"
LOCAL_PREFIXES = frozenset(
    {"domains", "config", "helpers", "tools", "loop", "activities", "workflows", "browser_tools"}
)

# Layer ordering (lower index = lower layer)
LAYER_ORDER = ["types", "config", "repo", "service", "handler"]

# Each layer may import from these layers (by index) plus providers/utils
ALLOWED_LAYER_IMPORTS = {
    "types": set(),  # Only external packages
    "config": {"types"},
    "repo": {"types", "config"},
    "service": {"types", "config", "repo"},
    "handler": {"types", "config", "repo", "service"},
}


def _extract_project_imports(filepath: Path) -> list[tuple[str, int]]:
    """Parse a Python file and return (module_path, line_number) for project-local imports."""
    source = filepath.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(filepath))
    result: list[tuple[str, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            if any(node.module.startswith(p) for p in LOCAL_PREFIXES):
                result.append((node.module, node.lineno))
    return result


def _layer_name(filename: str) -> str | None:
    """Extract the layer name from a filename (e.g. 'service.py' -> 'service')."""
    stem = Path(filename).stem
    return stem if stem in LAYER_ORDER else None


def check_domain(domain_dir: Path) -> list[str]:
    """Check one domain directory for import violations. Returns list of violation messages."""
    domain_name = domain_dir.name
    violations: list[str] = []

    for py_file in sorted(domain_dir.glob("*.py")):
        if py_file.name == "__init__.py":
            continue

        layer = _layer_name(py_file.name)
        if layer is None:
            continue

        allowed_layers = ALLOWED_LAYER_IMPORTS.get(layer, set())
        imports = _extract_project_imports(py_file)

        for module_path, lineno in imports:
            # Check cross-domain imports (domains.X where X != own domain)
            if module_path.startswith("domains."):
                parts = module_path.split(".")
                if len(parts) >= 2 and parts[1] != domain_name:
                    violations.append(
                        f"  {py_file.name}:{lineno} imports from foreign domain '{parts[1]}': {module_path}"
                    )
                    continue

                # Check same-domain layer direction
                if len(parts) >= 3:
                    imported_layer = parts[2]
                    if imported_layer not in allowed_layers:
                        violations.append(
                            f"  {py_file.name}:{lineno} layer '{layer}' cannot import "
                            f"from layer '{imported_layer}': {module_path}"
                        )
                continue

            # Non-domain project imports (helpers, tools, config, etc.) are allowed
            # for repo, service, handler layers. types and config should not import them
            # (except config.py which is the root config module).
            if layer == "types":
                violations.append(
                    f"  {py_file.name}:{lineno} types layer cannot import project module: {module_path}"
                )
            elif layer == "config" and module_path not in ("config",):
                # config layer can import root config (for env reads) and own types
                if not module_path.startswith(f"domains.{domain_name}.types"):
                    violations.append(
                        f"  {py_file.name}:{lineno} config layer should not import: {module_path}"
                    )

    return violations


def main() -> bool:
    """Run structural tests for all domains. Returns True if all pass."""
    if not DOMAINS_DIR.exists():
        print("No domains/ directory found. Nothing to check.")
        return True

    all_passed = True
    domain_count = 0

    for domain_dir in sorted(DOMAINS_DIR.iterdir()):
        if not domain_dir.is_dir() or domain_dir.name.startswith("_"):
            continue

        domain_count += 1
        violations = check_domain(domain_dir)

        if violations:
            print(f"FAIL: domains/{domain_dir.name}/")
            for v in violations:
                print(v)
            all_passed = False
        else:
            print(f"OK: domains/{domain_dir.name}/")

    if domain_count == 0:
        print("No domains found to check.")
        return True

    print(f"\n{'PASSED' if all_passed else 'FAILED'}: {domain_count} domain(s) checked")
    return all_passed


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
