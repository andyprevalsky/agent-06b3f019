#!/usr/bin/env python3
"""Produce private source-only runtime bytes from an exact Git commit, never the working tree.

No upload, credential lookup, dependency installation or provider operation occurs.
The caller supplies independently qualified native dependency/interpreter identities.
"""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def runtime_path(name: str) -> bool:
    """Match this image's runtime scope; wheels are already installed and separately bound."""
    parts = Path(name).parts
    if not parts or parts[0] != "agents":
        return False
    excluded = {"tests", "benchmarks", "vendor", "scripts", "venv", ".venv", ".git", ".context", "__pycache__"}
    if any(part in excluded or part.startswith(".env") for part in parts):
        return False
    return not name.endswith((".md", ".log", ".pyc", ".pyo", ".so")) and name not in (
        "agents/.dockerignore", "agents/.gitignore", "agents/deploy.sh",
    )


def git(repo: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.PIPE)


def build_bundle(repo: Path, commit: str, bootstrap_path: str, dependency_digest: str,
                 python_digest: str, namespace: str, base_queue: str, attempt: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("an exact immutable source commit is required")
    for digest in (dependency_digest, python_digest):
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("qualified native runtime digests are required")
    if git(repo, "rev-parse", commit + "^{commit}").decode().strip() != commit:
        raise ValueError("source commit identity mismatch")
    source_files = []
    total = 0
    for item in git(repo, "ls-tree", "-r", "-z", commit, "agents").split(b"\0"):
        if not item:
            continue
        meta, raw_name = item.split(b"\t", 1)
        name = raw_name.decode("utf-8")
        if not runtime_path(name):
            continue
        if not re.fullmatch(r"agents/[A-Za-z0-9_./-]+", name) or any(part in ("..", ".", "") for part in name.split("/")):
            raise ValueError("unsupported runtime path spelling")
        mode, kind, oid = meta.decode().split()
        if kind != "blob" or mode not in ("100644", "100755"):
            raise ValueError("runtime source must be regular files")
        body = git(repo, "cat-file", "blob", oid)
        total += len(body)
        if total > 128 * 1024 * 1024 or len(source_files) >= 20_000:
            raise ValueError("runtime source exceeds bound")
        source_files.append((name, 0o755 if mode == "100755" else 0o644, body))
    names = {name for name, _, _ in source_files}
    if not {"agents/worker.py", "agents/requirements.txt"} <= names:
        raise ValueError("worker runtime entrypoints are incomplete")
    manifest_files = []
    raw_archive = io.BytesIO()
    with tempfile.TemporaryDirectory(prefix="rose-worker-source-") as temporary:
        root = Path(temporary)
        with tarfile.open(fileobj=raw_archive, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name, mode, body in sorted(source_files):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body)
                entry = tarfile.TarInfo(name)
                entry.mode = mode
                entry.size = len(body)
                entry.mtime = 0
                archive.addfile(entry, io.BytesIO(body))
                manifest_files.append({"path": name, "mode": mode, "size": len(body), "sha256": sha256(body)})
        # Execute the canonical algorithm FROM the exact selected commit on its source bytes.
        algorithm = git(repo, "show", commit + ":scripts/agent_workflow_surface_hash.py").decode()
        surface = json.loads(subprocess.check_output(
            [sys.executable, "-c", algorithm, "--agents-dir", str(root / "agents"), "--json"], cwd=root))
    compressed = gzip.compress(raw_archive.getvalue(), mtime=0)
    if len(compressed) > 16 * 1024 * 1024:
        raise ValueError("compressed runtime source exceeds transport bound")
    bootstrap = git(repo, "show", commit + ":" + bootstrap_path).decode()
    requirements = next(body for name, _, body in source_files if name == "agents/requirements.txt")
    return {
        "sourceCommit": commit, "buildId": commit, "surfaceHash": surface["short"],
        "deploymentToken": attempt, "namespace": namespace, "baseTaskQueue": base_queue,
        "validationTaskQueue": "navi-agent-candidate-" + attempt,
        "bundleSHA256": sha256(compressed), "bundleBase64": base64.b64encode(compressed).decode(),
        "bootstrapSHA256": sha256(bootstrap.encode()), "bootstrapSource": bootstrap,
        "manifest": {"version": 1, "sourceCommit": commit,
                     "requirementsSHA256": sha256(requirements),
                     "installedDistributionsSHA256": dependency_digest, "pythonSHA256": python_digest,
                     "files": manifest_files},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--bootstrap-path", default="scripts/production_worker_process.py")
    parser.add_argument("--dependency-digest", required=True)
    parser.add_argument("--python-digest", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--base-queue", default="navi-agent-tasks")
    parser.add_argument("--attempt", required=True)
    args = parser.parse_args()
    artifact = build_bundle(args.repository, args.source_commit, args.bootstrap_path,
                            args.dependency_digest, args.python_digest, args.namespace,
                            args.base_queue, args.attempt)
    # Contains proprietary source, never credentials; callers must redirect to a private file.
    json.dump(artifact, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
