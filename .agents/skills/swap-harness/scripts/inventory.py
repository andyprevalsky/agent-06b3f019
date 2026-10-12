#!/usr/bin/env python3
"""Privately collect current-project thread context via managed read-only tools."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def managed(*args: str) -> dict:
    result = subprocess.run(
        ["dvb-onbox", "threads", *args, "--json"],
        check=True, capture_output=True, text=True, timeout=120,
    )
    payload = json.loads(result.stdout)
    if payload.get("ok") is not True:
        raise RuntimeError(f"Managed operation failed: {args[0]}")
    return payload


def collect(targets: dict[str, str] | None = None) -> dict:
    targets = targets or {}
    threads: dict[str, dict] = {}
    cursor = None
    seen_cursors: set[str] = set()
    while True:
        args = ["list", "--scope", "project"]
        if cursor is not None:
            args += ["--cursor", cursor]
        page = managed(*args)
        for thread in page["threads"]:
            if not thread.get("archived", False):
                threads[thread["id"]] = thread
        pagination = page["pagination"]
        if pagination.get("complete") is True:
            break
        cursor = pagination.get("nextCursor")
        if not isinstance(cursor, str) or not cursor or cursor in seen_cursors:
            raise RuntimeError("Incomplete listing without a new cursor; inventory is not complete")
        seen_cursors.add(cursor)
    records = []
    for thread in threads.values():
        preview = managed("read", "--scope", "project", "--thread", thread["id"], "--turns", "10")
        records.append({
            "thread": thread,
            "devboxId": targets.get(thread["publicId"])
            or thread.get("executionInstanceId") or thread.get("devboxId"),
            "transcript": preview["transcript"],
        })
    return {
        "schemaVersion": 1,
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "scope": "project", "complete": True,
        "note": "Previews may be shortened; null devboxId needs supported routing resolution. Determine main-task ownership and exclude active Codex main work before dispatch. No quota classification was inferred.",
        "threads": records,
    }


def save_private(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump(payload, stream, indent=2)
        stream.write("\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--targets-file", type=Path)
    args = parser.parse_args()
    targets = json.loads(args.targets_file.read_text()) if args.targets_file else {}
    if not isinstance(targets, dict) or any(
        not isinstance(k, str) or not isinstance(v, str) or not v.strip() for k, v in targets.items()
    ):
        parser.error("targets-file must map public thread IDs to nonempty devbox IDs")
    payload = collect(targets)
    save_private(args.output, payload)
    print(json.dumps({"output": str(args.output), "threadCount": len(payload["threads"]), "complete": True}))


if __name__ == "__main__":
    main()
