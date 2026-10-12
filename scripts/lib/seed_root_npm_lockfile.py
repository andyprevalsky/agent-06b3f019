#!/usr/bin/env python3
"""Seed a deploy worktree's root npm lockfile from its source workspace.

The repository commits no root ``package-lock.json`` (only the per-package
lockfiles), so a root ``npm install`` in a fresh deploy worktree resolves the
whole workspace graph from the live registry. On 2026-10-12 that resolution
crashed npm 10.9's arborist (``Cannot read properties of null (reading
'edgesOut')`` in ``#loadPeerSet``) and deploy-worktree preparation could not
install anything.

The source workspace already holds a verified installation whose resolved
tree npm records in ``node_modules/.package-lock.json``. When the deploy
worktree declares exactly the same root manifest and the same workspace
dependency declarations, that recorded tree is reused as the worktree's root
lockfile. ``npm install`` then installs those exact versions into the deploy
worktree's own ``node_modules`` instead of re-resolving the registry. Nothing
in the source workspace is modified, and any mismatch leaves the ordinary
fresh resolution untouched.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

DEPENDENCY_FIELDS = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
)
ROOT_FIELDS = ("name", "version", "workspaces", *DEPENDENCY_FIELDS)
INSTALL_SCRIPTS = ("preinstall", "install", "postinstall", "prepare")


def _load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path} is not a JSON object")
    return value


def _skip(reason: str) -> int:
    print(f"root lockfile seed: skipped ({reason})")
    return 0


def _workspace_paths(manifest: dict) -> list[str]:
    workspaces = manifest.get("workspaces") or []
    if isinstance(workspaces, dict):
        workspaces = workspaces.get("packages") or []
    return [str(entry) for entry in workspaces]


def _root_entry(manifest: dict) -> dict:
    entry = {field: manifest[field] for field in ROOT_FIELDS if field in manifest}
    scripts = manifest.get("scripts") or {}
    if any(name in scripts for name in INSTALL_SCRIPTS):
        entry["hasInstallScript"] = True
    return entry


def seed(worktree: Path, source: Path) -> int:
    target = worktree / "package-lock.json"
    if target.exists() or target.is_symlink():
        return _skip("the worktree already has a root package-lock.json")
    hidden = source / "node_modules" / ".package-lock.json"
    if not hidden.is_file():
        return _skip("the source workspace has no recorded npm installation")
    worktree_manifest_path = worktree / "package.json"
    source_manifest_path = source / "package.json"
    if not worktree_manifest_path.is_file() or not source_manifest_path.is_file():
        return _skip("a root package.json is missing")
    if worktree_manifest_path.read_bytes() != source_manifest_path.read_bytes():
        return _skip("the root package.json differs from the source workspace")

    manifest = _load_json(worktree_manifest_path)
    recorded = _load_json(hidden)
    packages = recorded.get("packages")
    if not isinstance(packages, dict) or not packages:
        return _skip("the source installation records no packages")

    for workspace in _workspace_paths(manifest):
        workspace_manifest_path = worktree / workspace / "package.json"
        if not workspace_manifest_path.is_file():
            continue
        installed = packages.get(workspace)
        if not isinstance(installed, dict):
            return _skip(f"the source installation does not record workspace {workspace}")
        workspace_manifest = _load_json(workspace_manifest_path)
        for field in DEPENDENCY_FIELDS:
            if (workspace_manifest.get(field) or {}) != (installed.get(field) or {}):
                return _skip(f"{workspace} {field} differ from the source installation")

    seeded = {key: value for key, value in recorded.items() if key != "packages"}
    seeded["packages"] = {"": _root_entry(manifest)}
    seeded["packages"].update(
        (key, value) for key, value in packages.items() if key != ""
    )

    fd, temp_name = tempfile.mkstemp(prefix=".package-lock.", dir=worktree)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(seeded, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, 0o644)
        os.link(temp_name, target)
    finally:
        os.unlink(temp_name)
    print(
        "root lockfile seed: reused the source workspace's verified npm tree "
        f"({len(packages)} packages) for {target}"
    )
    return 0


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: seed_root_npm_lockfile.py <worktree> <source-workspace>", file=sys.stderr)
        return 2
    return seed(Path(argv[1]).resolve(), Path(argv[2]).resolve())


if __name__ == "__main__":
    sys.exit(main(sys.argv))
