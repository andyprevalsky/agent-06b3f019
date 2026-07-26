#!/usr/bin/env python3
"""Canonical schema/day path for isolated benchmark seed dumps."""

from __future__ import annotations

import argparse
import hashlib
from datetime import datetime, timezone
from pathlib import Path


def seed_dump_path(
    schema_path: Path,
    cache_root: Path,
    cache_day: str | None = None,
) -> Path:
    """Return the schema- and UTC-day-scoped benchmark seed dump path."""
    schema_hash = hashlib.sha1(schema_path.read_bytes()).hexdigest()
    day = cache_day or datetime.now(timezone.utc).strftime("%Y%m%d")
    return cache_root / f"{schema_hash}-{day}.dump"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("schema_path", type=Path)
    parser.add_argument("cache_root", type=Path)
    parser.add_argument("cache_day", nargs="?")
    args = parser.parse_args()
    print(seed_dump_path(args.schema_path, args.cache_root, args.cache_day))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
