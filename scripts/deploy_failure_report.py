#!/usr/bin/env python3
"""Failure exceptions in the existing deploy report; this is not a task board.

Attribution comes from /RCA; matching is an agent judgment. This helper enforces reporting
consequences, preserves original outcomes and produces cumulative scorecard rows.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlparse, parse_qs, unquote


def decision(entry: dict) -> str:
    attribution = entry.get("attribution")
    # Read retained reports without rewriting their original attribution/evidence.
    if attribution == "NOT INTRODUCED":
        attribution = "NOT_INTRODUCED"
    if attribution not in {"INTRODUCED", "NOT_INTRODUCED", "UNKNOWN"}:
        raise ValueError("Explicit attribution is required; unknown stays UNKNOWN")
    if not all(isinstance(entry.get(k), str) and entry[k].strip()
               for k in ["id", "description", "evidence", "native_result"]):
        raise ValueError("Failure identity, description, evidence and original native result are required")
    link = entry.get("repair_agent")
    external = entry.get("external_provider")
    if external:
        if link:
            raise ValueError("External provider failures must not have a repair handoff")
        if attribution != "NOT_INTRODUCED":
            raise ValueError("An introduced defect or unknown cause is not an external-provider exception")
        if external.get("reason") not in {"outage", "credits exhausted"} or not external.get("name"):
            raise ValueError("Record the evidenced provider and outage/credit-exhaustion reason")
        return "external / waived"
    if link:
        if attribution != "NOT_INTRODUCED":
            raise ValueError("Introduced and unknown failures cannot get delegation waivers")
        u = urlparse(link)
        rose = u.netloc in {"www.roselabs.ai", "roselabs.ai"} and bool(parse_qs(u.query).get("agent-id"))
        boxes = u.netloc == "boxes.dev" and re.fullmatch(r"/thread/[A-Za-z0-9_-]+", unquote(u.path)) is not None
        if u.scheme != "https" or not (rose or boxes):
            raise ValueError("A boxes.dev repair-thread or Rose repair-agent link is required")
        return "delegated / waived"
    return "blocking"


def record(path: Path, entry: dict) -> dict:
    status = decision(entry)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(path.suffix + ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        report = json.loads(path.read_text()) if path.exists() else {"failures": []}
        if any(x["id"] == entry["id"] for x in report["failures"]):
            existing = next(x for x in report["failures"] if x["id"] == entry["id"])
            if existing != {**entry, "disposition": status}:
                raise ValueError("An occurrence already has different evidence; retain it under a new occurrence id")
            return report
        report["failures"].append({**entry, "disposition": status})
        fd, name = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
        try:
            with os.fdopen(fd, "w") as out:
                json.dump(report, out, indent=2); out.write("\n"); out.flush(); os.fsync(out.fileno())
            os.replace(name, path)
        finally:
            if os.path.exists(name): os.unlink(name)
        return report


def render(report: dict, scorecard: str = "") -> str:
    lines = [scorecard.rstrip()] if scorecard.strip() else []
    if not scorecard.strip():
        blocking = [e for e in report["failures"] if e["disposition"] == "blocking"]
        if blocking:
            lines.append("BLOCKING")
            lines.extend(f"- {e['description']} — {e['native_result']} · Evidence: {e['evidence']}" for e in blocking)
    handed = [e for e in report["failures"] if e["disposition"] == "delegated / waived"]
    if handed:
        lines.extend(["", "DELEGATED"])
        lines.extend(f"- {e['description']} — {e['repair_agent']}" for e in handed)
    # Always appended after every other section, preserving failed native results.
    for e in report["failures"]:
        if e["disposition"] == "external / waived":
            p = e["external_provider"]
            lines.extend(["", f"🚨🚨 EXTERNAL PROVIDER FAILURE — {p['name']}: {p['reason']} — NEEDS FIXING",
                          f"Affected check: {e['description']} · {e['native_result']}", f"Evidence: {e['evidence']}"])
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["record", "render"])
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.action == "record":
        report = record(args.report, json.load(sys.stdin))
        print(json.dumps(report))
    else:
        print(render(json.loads(args.report.read_text()), sys.stdin.read()), end="")


if __name__ == "__main__":
    main()
