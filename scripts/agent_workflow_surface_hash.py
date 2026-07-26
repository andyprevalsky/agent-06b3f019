#!/usr/bin/env python3
"""Compute a stable hash of the Temporal *replay surface* of the agent workflow.

The replay surface is every local module that can execute inside the workflow
sandbox during history replay: `agents/workflows/agent_workflow.py` plus the
transitive closure of its local (`agents/`-rooted) imports. Temporal only
requires *workflow* code to be deterministic across replay — but in this
codebase the workflow pulls its agent loop and tools into workflow scope via
`with workflow.unsafe.imports_passed_through():`, so those modules are part of
the surface too.

This hash is the **generation key** for zero-downtime cutover: two deploys with
the same surface hash are replay-compatible and share a task queue (a plain
rolling restart, no respawn); a changed surface hash means the generation must
roll over (versioned queue + overlapped kill-respawn).

Safety contract: this walk **over-includes rather than under-includes**. It
follows every resolvable local import (including activity modules). Over-
inclusion only causes an extra — safe — rollover. Under-inclusion would let a
determinism-breaking change ship without a rollover and crash replay in prod,
so we never do it. Third-party / stdlib imports are not our surface and are
ignored.

Usage:
    agent_workflow_surface_hash.py                # print 12-char surface hash
    agent_workflow_surface_hash.py --full         # full 64-char hash
    agent_workflow_surface_hash.py --list         # print every surface file
    agent_workflow_surface_hash.py --json         # {"hash":..., "files":[...]}
    agent_workflow_surface_hash.py --root PATH     # override the entry module
    agent_workflow_surface_hash.py --agents-dir D  # override the agents/ root
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import sys
from pathlib import Path


def _default_agents_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "agents"


def _resolve_local_module(
    module: str, agents_dir: Path
) -> list[Path]:
    """Resolve a dotted module name to local file(s) under `agents/`.

    `helpers.llm`  -> agents/helpers/llm.py  (and agents/helpers/llm/__init__.py)
    `tools`        -> agents/tools/__init__.py
    Returns every existing candidate so a package and a same-named submodule are
    both captured. Non-local modules resolve to [].
    """
    parts = module.split(".")
    candidates: list[Path] = []
    # module as a .py file: agents/<parts>.py
    py_file = agents_dir.joinpath(*parts).with_suffix(".py")
    if py_file.is_file():
        candidates.append(py_file)
    # module as a package: agents/<parts>/__init__.py
    pkg_init = agents_dir.joinpath(*parts) / "__init__.py"
    if pkg_init.is_file():
        candidates.append(pkg_init)
    return candidates


def _package_of(path: Path, agents_dir: Path) -> str:
    """Return the dotted package a file's relative imports resolve against.

    `agents/helpers/__init__.py` -> "helpers"   (a package; `.x` -> helpers.x)
    `agents/helpers/llm.py`      -> "helpers"   (module; `.x` -> helpers.x)
    `agents/tools/web_search/handler.py` -> "tools.web_search"
    """
    rel = path.resolve().relative_to(agents_dir.resolve())
    # The containing directory (relative to agents/) is the package for both a
    # regular module and a package __init__.py (Python resolves `.` to the
    # package that contains the current module).
    return ".".join(rel.parent.parts)


def _imported_modules(tree: ast.AST, current_package: str) -> set[str]:
    """Every top-level dotted module name referenced by import statements.

    For `from helpers import a, b` we emit `helpers`, `helpers.a`, `helpers.b`
    so a re-exported submodule (`agents/helpers/a.py`) is captured even when the
    package `__init__` does not itself import it. **Relative imports are resolved
    against `current_package`** — `agents/helpers/__init__.py` doing
    `from .llm import x` (or `from . import llm`) re-exports a local module that
    IS part of the replay surface; dropping it would let a change slip past the
    hash (under-inclusion → a missed rollover → nondeterministic replay in prod).
    """
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                modules.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            level = node.level or 0
            if level > 0:
                # Resolve the relative anchor: level 1 = current package, each
                # extra level strips one trailing package component.
                parts = current_package.split(".") if current_package else []
                if level - 1 > len(parts):
                    continue  # escapes the agents/ root — not a local module
                anchor = ".".join(parts[: len(parts) - (level - 1)])
                base = f"{anchor}.{node.module}" if node.module else anchor
            else:
                base = node.module
            if not base:
                continue
            modules.add(base)
            for alias in node.names:
                modules.add(f"{base}.{alias.name}")
    return modules


def surface_files(root: Path, agents_dir: Path) -> list[Path]:
    """Transitive closure of local files reachable from `root` via imports."""
    root = root.resolve()
    agents_dir = agents_dir.resolve()
    visited: set[Path] = set()
    queue: list[Path] = [root]
    while queue:
        current = queue.pop()
        if current in visited or not current.is_file():
            continue
        visited.add(current)
        try:
            tree = ast.parse(current.read_text(encoding="utf-8"), filename=str(current))
        except (SyntaxError, UnicodeDecodeError):
            # A file we cannot parse still contributes its bytes to the hash via
            # `visited`; we just cannot follow its imports.
            continue
        for module in _imported_modules(tree, _package_of(current, agents_dir)):
            for resolved in _resolve_local_module(module, agents_dir):
                if resolved not in visited:
                    queue.append(resolved)
    return sorted(visited)


def surface_hash(files: list[Path], agents_dir: Path) -> str:
    """Deterministic sha256 over (repo-relative path, content) of every file."""
    digest = hashlib.sha256()
    repo_root = agents_dir.parent
    for path in sorted(files):
        rel = path.resolve().relative_to(repo_root).as_posix()
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=None, help="entry workflow module")
    parser.add_argument("--agents-dir", type=Path, default=None, help="agents/ root")
    parser.add_argument("--full", action="store_true", help="print the full 64-char hash")
    parser.add_argument("--list", action="store_true", help="print surface files")
    parser.add_argument("--json", action="store_true", help="print JSON {hash, files}")
    args = parser.parse_args(argv)

    agents_dir = (args.agents_dir or _default_agents_dir()).resolve()
    root = (args.root or (agents_dir / "workflows" / "agent_workflow.py")).resolve()
    if not root.is_file():
        print(f"error: workflow entry not found: {root}", file=sys.stderr)
        return 2

    files = surface_files(root, agents_dir)
    full = surface_hash(files, agents_dir)
    short = full[:12]
    repo_root = agents_dir.parent
    rel_files = [p.resolve().relative_to(repo_root).as_posix() for p in files]

    if args.json:
        print(json.dumps({"hash": full, "short": short, "files": rel_files}))
    elif args.list:
        for rel in rel_files:
            print(rel)
    else:
        print(full if args.full else short)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
