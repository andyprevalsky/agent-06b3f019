"""Devbox-independent cache of the native WMH build directory.

The WMH build directory (``WMH_BUILD_DIR``) holds the screening cache, the
per-bundle signatures in ``delta-index.json``, every exported trajectory and
the native model outputs. ``update_world_model_for_simulation`` reuses all of
it, so restoring the directory turns a multi-hour cold rebuild into an
incremental refresh of new bundles only.

The directory contains decrypted trajectories, so it is stored the same way the
trace archive stores everything else: a tarball split into parts, each part
AES-256-GCM encrypted with the trace-archive key (``encrypt_artifact``) and
uploaded to the trace-archive R2 bucket under ``wmh-build-cache/<name>/``.
A manifest lists every part's integrity metadata; ``pull`` verifies each part
before extracting.

Usage (from ``agents/`` with the venv active and ``.env`` loaded):

    python -m benchmarks.wmh_build_cache push --build-dir ../.context/world-model-native
    python -m benchmarks.wmh_build_cache pull --build-dir ../.context/world-model-native
    python -m benchmarks.wmh_build_cache status
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

from helpers.trace_archive import decrypt_and_validate_artifact, encrypt_artifact

CACHE_PREFIX = "wmh-build-cache"
DEFAULT_NAME = "rose-archive"
PART_BYTES = 256 * 1024 * 1024
MANIFEST_SCHEMA = "rose.wmh_build_cache.v1"


def _manifest_key(name: str) -> str:
    return f"{CACHE_PREFIX}/{name}/manifest.json"


def _part_key(name: str, upload_id: str, index: int) -> str:
    return f"{CACHE_PREFIX}/{name}/{upload_id}/part-{index:05d}.bin"


def _default_store() -> tuple[Any, str]:
    from helpers.trace_archive import r2_bucket, r2_client

    return r2_client(), r2_bucket()


def _source_commit() -> Optional[str]:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True, timeout=10
        ).stdout.strip()
    except Exception:
        return None


def _tar_chunks(build_dir: Path, part_bytes: int) -> Iterator[bytes]:
    """Stream a tar of ``build_dir`` and yield it in ``part_bytes`` chunks."""
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:  # child: write the tar stream into the pipe
        os.close(read_fd)
        with os.fdopen(write_fd, "wb") as sink:
            with tarfile.open(fileobj=sink, mode="w|") as tar:
                tar.add(str(build_dir), arcname=".")
        os._exit(0)
    os.close(write_fd)
    try:
        with os.fdopen(read_fd, "rb") as source:
            while True:
                chunk = source.read(part_bytes)
                if not chunk:
                    break
                yield chunk
    finally:
        _, status = os.waitpid(pid, 0)
        if os.waitstatus_to_exitcode(status) != 0:
            raise RuntimeError("tar of the WMH build directory failed")


def read_manifest(name: str = DEFAULT_NAME, *, store: Optional[tuple[Any, str]] = None) -> Optional[dict[str, Any]]:
    client, bucket = store or _default_store()
    try:
        body = client.get_object(Bucket=bucket, Key=_manifest_key(name))["Body"].read()
    except Exception as exc:
        if "NoSuchKey" in type(exc).__name__ or "NoSuchKey" in str(exc) or "404" in str(exc):
            return None
        raise
    return json.loads(body)


def push(
    build_dir: Path,
    *,
    name: str = DEFAULT_NAME,
    store: Optional[tuple[Any, str]] = None,
    part_bytes: int = PART_BYTES,
    log: Callable[[str], None] = print,
) -> dict[str, Any]:
    """Upload ``build_dir`` as encrypted parts, then publish the manifest last."""
    build_dir = build_dir.resolve()
    if not (build_dir / "delta-index.json").is_file():
        raise FileNotFoundError(f"{build_dir} is not a WMH build directory (no delta-index.json)")
    client, bucket = store or _default_store()
    upload_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{os.getpid()}"
    parts: list[dict[str, Any]] = []
    for index, chunk in enumerate(_tar_chunks(build_dir, part_bytes)):
        key = _part_key(name, upload_id, index)
        encrypted = encrypt_artifact(chunk, path=key, content_type="application/x-tar", compress=False)
        if encrypted is None:
            raise RuntimeError("trace-archive encryption key is unavailable; refusing to upload plaintext")
        ciphertext, metadata = encrypted
        client.put_object(Bucket=bucket, Key=key, Body=ciphertext)
        parts.append({"key": key, "metadata": metadata})
        log(f"[wmh-build-cache] uploaded part {index} ({len(chunk) / 1e6:.0f} MB)")
    delta = json.loads((build_dir / "delta-index.json").read_text())
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "name": name,
        "upload_id": upload_id,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source_commit": _source_commit(),
        "indexed_bundles": len(delta.get("bundles") or {}),
        "plaintext_bytes": sum(int(p["metadata"]["plaintext_bytes"]) for p in parts),
        "parts": parts,
    }
    # The manifest goes last so a reader never sees a partially uploaded cache.
    client.put_object(Bucket=bucket, Key=_manifest_key(name), Body=json.dumps(manifest).encode("utf-8"))
    log(f"[wmh-build-cache] published {name}: {len(parts)} parts, {manifest['indexed_bundles']} bundles")
    return manifest


def pull(
    build_dir: Path,
    *,
    name: str = DEFAULT_NAME,
    store: Optional[tuple[Any, str]] = None,
    force: bool = False,
    log: Callable[[str], None] = print,
) -> Optional[dict[str, Any]]:
    """Restore the cached build directory; returns the manifest, or None if no cache exists."""
    build_dir = build_dir.resolve()
    if build_dir.exists() and any(build_dir.iterdir()) and not force:
        raise FileExistsError(f"{build_dir} is not empty; pass --force to replace it")
    client, bucket = store or _default_store()
    manifest = read_manifest(name, store=(client, bucket))
    if manifest is None:
        log(f"[wmh-build-cache] no cache published for {name}")
        return None
    if manifest.get("schema") != MANIFEST_SCHEMA:
        raise ValueError(f"unsupported cache schema {manifest.get('schema')!r}")
    build_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=build_dir.parent, prefix=".wmh-cache-") as staging:
        tar_path = Path(staging) / "build.tar"
        with tar_path.open("wb") as sink:
            for index, part in enumerate(manifest["parts"]):
                ciphertext = client.get_object(Bucket=bucket, Key=part["key"])["Body"].read()
                sink.write(decrypt_and_validate_artifact(ciphertext, part["metadata"]))
                log(f"[wmh-build-cache] verified part {index + 1}/{len(manifest['parts'])}")
        extract_dir = Path(staging) / "extract"
        extract_dir.mkdir()
        with tarfile.open(tar_path, mode="r") as tar:
            tar.extractall(extract_dir, filter="data")
        if build_dir.exists():
            replaced = build_dir.with_name(build_dir.name + f".replaced-{int(time.time())}")
            build_dir.rename(replaced)
            log(f"[wmh-build-cache] moved previous build directory to {replaced}")
        extract_dir.rename(build_dir)
    log(f"[wmh-build-cache] restored {name} ({manifest['indexed_bundles']} bundles) into {build_dir}")
    return manifest


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("push", "pull", "status"))
    parser.add_argument("--build-dir", type=Path, default=Path(os.environ.get("WMH_BUILD_DIR", "../.context/world-model-native")))
    parser.add_argument("--name", default=os.environ.get("WMH_MODEL_NAME", DEFAULT_NAME))
    parser.add_argument("--force", action="store_true", help="pull: replace a non-empty build directory")
    args = parser.parse_args(argv)
    if args.command == "push":
        push(args.build_dir, name=args.name)
    elif args.command == "pull":
        return 0 if pull(args.build_dir, name=args.name, force=args.force) is not None else 1
    else:
        manifest = read_manifest(args.name)
        if manifest is None:
            print(f"no cache published for {args.name}")
            return 1
        summary = {k: manifest.get(k) for k in ("name", "created_at", "source_commit", "indexed_bundles", "plaintext_bytes")}
        summary["parts"] = len(manifest.get("parts") or [])
        print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
