#!/usr/bin/env python3
"""
Maps agent domains to their source files by tracing import graphs.

Domains include:
  - Tool domains (tools/*.py)
  - Activity domains (activities/*.py)
  - Orchestration domain (workflows/agent_workflow.py + loop/*)

Usage:
    python scripts/map_domains.py                # show all domains
    python scripts/map_domains.py web-search     # show one domain
    python scripts/map_domains.py --json         # JSON output
    python scripts/map_domains.py --classify     # shared file classification
"""

import ast
import json
import sys
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = AGENTS_ROOT / "tools"
ACTIVITIES_DIR = AGENTS_ROOT / "activities"
WORKFLOWS_DIR = AGENTS_ROOT / "workflows"
LOOP_DIR = AGENTS_ROOT / "loop"
HELPERS_DIR = AGENTS_ROOT / "helpers"
BLACKBOX_DIR = AGENTS_ROOT / "tests" / "blackbox"

# Files in tools/ that are infrastructure, not domains
TOOL_INFRA_FILES = {"__init__.py", "base.py", "fetch_tools.py"}

# Files in activities/ that are infrastructure, not domains
ACTIVITY_INFRA_FILES = {"__init__.py"}

# App wiring files (composition root — the ONLY files allowed to import across all domains)
APP_WIRING_FILES = {"worker.py", "health_server.py"}

# Domain name → test file name (when they don't match by convention)
SPECIAL_TEST_MAPPINGS = {
    "orchestration": "workflow",
}


def file_to_domain_name(filename: str) -> str:
    """Convert a Python filename to a kebab-case domain name."""
    return filename.replace(".py", "").replace("_", "-")


def domain_name_to_file(domain: str) -> str:
    """Convert a kebab-case domain name back to a Python filename."""
    return domain.replace("-", "_") + ".py"


def parse_local_imports(file_path: Path) -> list[Path]:
    """Parse a Python file's AST and return all local import targets."""
    if not file_path.exists():
        return []
    try:
        source = file_path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(file_path))
    except (SyntaxError, UnicodeDecodeError):
        return []

    imports: list[Path] = []

    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            level = node.level or 0
            if level > 0:
                resolved = _resolve_relative_import(
                    node.module, level, file_path
                )
                if resolved:
                    imports.append(resolved)
            elif node.module:
                resolved = _resolve_import(node.module, file_path)
                if resolved:
                    imports.append(resolved)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                resolved = _resolve_import(alias.name, file_path)
                if resolved:
                    imports.append(resolved)

    return imports


def _resolve_relative_import(
    module_name: str | None, level: int, from_file: Path
) -> Path | None:
    """Resolve a relative import to a local .py file path."""
    base = from_file.parent
    for _ in range(level - 1):
        base = base.parent

    if module_name:
        parts = module_name.split(".")
        candidate = base / "/".join(parts)
    else:
        candidate = base

    py_file = candidate.with_suffix(".py")
    if py_file.exists() and _is_local(py_file):
        return py_file

    init_file = candidate / "__init__.py"
    if init_file.exists() and _is_local(init_file):
        return init_file

    return None


def _resolve_import(module_name: str, from_file: Path) -> Path | None:
    """Resolve a dotted module name to a local .py file path."""
    parts = module_name.split(".")

    # Try as a file: helpers.llm -> helpers/llm.py
    candidate = AGENTS_ROOT / "/".join(parts)
    py_file = candidate.with_suffix(".py")
    if py_file.exists() and _is_local(py_file):
        return py_file

    # Try as a package: browser_tools -> browser_tools/__init__.py
    init_file = candidate / "__init__.py"
    if init_file.exists() and _is_local(init_file):
        return init_file

    return None


def _is_local(path: Path) -> bool:
    """Check if a path is inside the agents root (not an external package)."""
    try:
        path.resolve().relative_to(AGENTS_ROOT.resolve())
        return True
    except ValueError:
        return False


def trace_imports(entry: Path) -> list[str]:
    """BFS-trace the full transitive import graph from an entry file."""
    seen: set[Path] = set()
    queue = [entry.resolve()]

    while queue:
        current = queue.pop()
        if current in seen:
            continue
        seen.add(current)
        for imp in parse_local_imports(current):
            resolved = imp.resolve()
            if resolved not in seen:
                queue.append(resolved)

    return sorted(
        str(p.relative_to(AGENTS_ROOT)) for p in seen if p.exists()
    )


def find_blackbox_test(domain_name: str) -> str | None:
    """Find a blackbox test file for a given domain name."""
    snake = domain_name.replace("-", "_")
    candidate = BLACKBOX_DIR / f"{snake}.blackbox.py"
    if candidate.exists():
        return str(candidate.relative_to(AGENTS_ROOT))
    # Check special mappings (e.g., orchestration -> workflow)
    mapped = SPECIAL_TEST_MAPPINGS.get(domain_name)
    if mapped:
        candidate = BLACKBOX_DIR / f"{mapped}.blackbox.py"
        if candidate.exists():
            return str(candidate.relative_to(AGENTS_ROOT))
    return None


def discover_tool_domains() -> list[dict]:
    """Discover tool domains from tools/*.py."""
    domains = []
    if not TOOLS_DIR.exists():
        return domains

    tool_files = sorted(
        f.name
        for f in TOOLS_DIR.iterdir()
        if f.suffix == ".py" and f.name not in TOOL_INFRA_FILES
    )

    for filename in tool_files:
        domain_name = file_to_domain_name(filename)
        entry_path = TOOLS_DIR / filename
        files = trace_imports(entry_path)
        test_file = find_blackbox_test(domain_name)

        domains.append({
            "domain": domain_name,
            "type": "tool",
            "entryFile": f"tools/{filename}",
            "files": files,
            "testFile": test_file,
            "fileCount": len(files),
        })

    return domains


def discover_activity_domains() -> list[dict]:
    """Discover activity domains from activities/*.py."""
    domains = []
    if not ACTIVITIES_DIR.exists():
        return domains

    activity_files = sorted(
        f.name
        for f in ACTIVITIES_DIR.iterdir()
        if f.suffix == ".py" and f.name not in ACTIVITY_INFRA_FILES
    )

    for filename in activity_files:
        domain_name = file_to_domain_name(filename)
        entry_path = ACTIVITIES_DIR / filename
        files = trace_imports(entry_path)
        test_file = find_blackbox_test(domain_name)

        domains.append({
            "domain": domain_name,
            "type": "activity",
            "entryFile": f"activities/{filename}",
            "files": files,
            "testFile": test_file,
            "fileCount": len(files),
        })

    return domains


def discover_orchestration_domain() -> list[dict]:
    """Discover the orchestration domain from workflows/ + loop/."""
    workflow_entry = WORKFLOWS_DIR / "agent_workflow.py"
    if not workflow_entry.exists():
        return []

    files = trace_imports(workflow_entry)
    test_file = find_blackbox_test("orchestration")

    return [{
        "domain": "orchestration",
        "type": "orchestration",
        "entryFile": "workflows/agent_workflow.py",
        "files": files,
        "testFile": test_file,
        "fileCount": len(files),
    }]


def discover_all_domains() -> list[dict]:
    """Discover all domains: tools, activities, orchestration."""
    domains = []
    domains.extend(discover_tool_domains())
    domains.extend(discover_activity_domains())
    domains.extend(discover_orchestration_domain())
    return domains


def _collect_all_source_files() -> set[str]:
    """Collect all .py source files in agents/ (excluding tests/scripts/venv)."""
    all_files: set[str] = set()
    skip_dirs = {"tests", "benchmarks", "scripts", ".venv", "venv", "__pycache__", "browser_tools"}

    for item in AGENTS_ROOT.rglob("*.py"):
        rel = str(item.relative_to(AGENTS_ROOT))
        parts = rel.split("/")
        if any(d in skip_dirs for d in parts):
            continue
        all_files.add(rel)

    return all_files


def classify_shared_files(domains: list[dict]) -> dict:
    """Classify files by how many domains reference them.

    Returns dict with:
      shared     — files in 2+ domain import graphs (future providers or utils)
      appWiring  — composition root files
      domainOnly — files unique to one domain's import graph
      orphaned   — source files in no domain's import graph
    """
    # Count which domains reference each file
    file_to_domains: dict[str, list[str]] = {}
    for d in domains:
        for f in d["files"]:
            file_to_domains.setdefault(f, []).append(d["domain"])

    all_source = _collect_all_source_files()

    # Domain entry files (the file that defines the domain, not shared)
    entry_files = {d["entryFile"] for d in domains}

    shared = []
    app_wiring = []
    domain_only = {}
    orphaned = []

    for f in sorted(all_source):
        basename = Path(f).name
        if basename in APP_WIRING_FILES:
            app_wiring.append(f)
        elif f in file_to_domains:
            using = file_to_domains[f]
            if f in entry_files:
                # This is a domain's own entry file, not shared
                domain_only[f] = using[0]
            elif len(using) >= 2:
                test_file = find_blackbox_test(
                    file_to_domain_name(basename)
                )
                shared.append({
                    "file": f,
                    "usedByCount": len(using),
                    "testFile": test_file,
                })
            else:
                domain_only[f] = using[0]
        else:
            orphaned.append(f)

    return {
        "shared": shared,
        "appWiring": app_wiring,
        "domainOnly": domain_only,
        "orphaned": orphaned,
    }


def main() -> None:
    domains = discover_all_domains()
    arg = sys.argv[1] if len(sys.argv) > 1 else None

    if arg == "--json":
        classification = classify_shared_files(domains)
        output = {
            "domains": domains,
            "classification": classification,
        }
        print(json.dumps(output, indent=2))
        sys.exit(0)

    if arg == "--classify":
        classification = classify_shared_files(domains)

        print("Shared files (in 2+ domain import graphs → future providers/utils):\n")
        for entry in classification["shared"]:
            tested = "✓" if entry["testFile"] else "✗"
            print(f"  {tested} {entry['file']:<45} ({entry['usedByCount']} domains)")

        print(f"\nApp wiring (composition root):\n")
        for f in classification["appWiring"]:
            print(f"  {f}")

        if classification["orphaned"]:
            print(f"\nOrphaned (in no domain's import graph):\n")
            for f in classification["orphaned"]:
                print(f"  {f}")

        tested_count = sum(1 for e in classification["shared"] if e["testFile"])
        total_shared = len(classification["shared"])
        print(f"\n{total_shared} shared files ({tested_count} tested), "
              f"{len(classification['appWiring'])} app wiring, "
              f"{len(classification['orphaned'])} orphaned")
        sys.exit(0)

    if arg and arg not in ("--json", "--classify"):
        match = next((d for d in domains if d["domain"] == arg), None)
        if not match:
            available = ", ".join(d["domain"] for d in domains)
            print(f"Unknown domain: {arg}", file=sys.stderr)
            print(f"Available: {available}", file=sys.stderr)
            sys.exit(1)
        print(f"Domain: {match['domain']}")
        print(f"Type:   {match['type']}")
        print(f"Entry:  {match['entryFile']}")
        print(f"Test:   {match['testFile'] or '(none)'}")
        print(f"Files ({match['fileCount']}):")
        for f in match["files"]:
            print(f"  {f}")
        sys.exit(0)

    # Summary mode
    tool_domains = [d for d in domains if d["type"] == "tool"]
    activity_domains = [d for d in domains if d["type"] == "activity"]
    orch_domains = [d for d in domains if d["type"] == "orchestration"]

    print(f"Agents Domain Map ({len(domains)} domains)\n")

    if tool_domains:
        print(f"  Tool domains ({len(tool_domains)}):")
        for d in tool_domains:
            test = "✓ tested" if d["testFile"] else "✗ NO TESTS"
            print(f"    {d['domain']:<30} {d['fileCount']:>3} files  [{test}]")

    if activity_domains:
        print(f"\n  Activity domains ({len(activity_domains)}):")
        for d in activity_domains:
            test = "✓ tested" if d["testFile"] else "✗ NO TESTS"
            print(f"    {d['domain']:<30} {d['fileCount']:>3} files  [{test}]")

    if orch_domains:
        print(f"\n  Orchestration domain ({len(orch_domains)}):")
        for d in orch_domains:
            test = "✓ tested" if d["testFile"] else "✗ NO TESTS"
            print(f"    {d['domain']:<30} {d['fileCount']:>3} files  [{test}]")

    print(f"\nUse: python scripts/map_domains.py <domain> for details")
    print(f"Use: python scripts/map_domains.py --json for machine-readable output")
    print(f"Use: python scripts/map_domains.py --classify for shared file analysis")


if __name__ == "__main__":
    main()
