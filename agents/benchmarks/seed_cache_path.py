#!/usr/bin/env python3
"""Paths and immutable artifact identity for benchmark database dumps."""

from __future__ import annotations

import argparse
import hashlib
from datetime import datetime, timezone
from pathlib import Path

BASE_IMAGE_CACHE_REVISION = "victoria-prod-sync-v1-whatsapp-v2"


def _schema_hash(schema_path: Path) -> str:
    return hashlib.sha1(schema_path.read_bytes()).hexdigest()


def seed_cache_token(
    schema_path: Path,
    revision: str = BASE_IMAGE_CACHE_REVISION,
) -> str:
    """Return the immutable shared-cache key for the canonical base fixture."""
    return f"{_schema_hash(schema_path)}-{revision}"


def canonical_base_dump_path(schema_path: Path, cache_root: Path) -> Path:
    """Return the local cache path corresponding to the canonical R2 artifact."""
    return cache_root / f"{seed_cache_token(schema_path)}.dump"


def seed_dump_path(
    schema_path: Path,
    cache_root: Path,
    cache_day: str | None = None,
) -> Path:
    """Return the schema- and UTC-day-scoped benchmark seed dump path."""
    schema_hash = _schema_hash(schema_path)
    day = cache_day or datetime.now(timezone.utc).strftime("%Y%m%d")
    return cache_root / f"{schema_hash}-{day}.dump"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cache-token",
        action="store_true",
        help="print the immutable canonical base-image cache token",
    )
    parser.add_argument("schema_path", type=Path)
    parser.add_argument("cache_root", type=Path, nargs="?")
    parser.add_argument("cache_day", nargs="?")
    args = parser.parse_args()
    if args.cache_token:
        print(seed_cache_token(args.schema_path))
        return 0
    if args.cache_root is None:
        parser.error("cache_root is required unless --cache-token is used")
    print(seed_dump_path(args.schema_path, args.cache_root, args.cache_day))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
