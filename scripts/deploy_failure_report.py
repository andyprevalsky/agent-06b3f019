#!/usr/bin/env python3
"""Failure exceptions in the existing deploy report; this is not a task board.

Attribution comes from /RCA; matching is an agent judgment. This helper enforces reporting
consequences, preserves original outcomes and produces cumulative scorecard rows.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import re
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlparse, parse_qs, unquote

TREASURY_SKIP = 'treasury / skipped with warning'
TREASURY_POLICY = 'treasury-failures-skip-and-warn-2026-10-29'


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
    if 'standing_policy' in entry:
        policy = entry['standing_policy']
        if (not isinstance(policy, dict) or set(policy) != {'name', 'reason', 'affected_records', 'evidence_at'}
                or policy.get('name') != TREASURY_POLICY
                or entry.get('check') != 'backend-coverage-blackbox/blackbox:treasury-rails'
                or not isinstance(policy.get('reason'), str) or not policy['reason'].strip()
                or not isinstance(policy.get('affected_records'), list)
                or not all(isinstance(x, str) and x.strip() for x in policy['affected_records'])
                or len(set(policy['affected_records'])) != len(policy['affected_records'])
                or type(policy.get('evidence_at')) not in (int, float)
                or not math.isfinite(policy['evidence_at']) or policy['evidence_at'] <= 0
                or any(entry.get(k) is not None for k in ('external_provider', 'repair_agent', 'post_merge',
                       'execute_unverified', 'assigned_repair', 'resource_skip'))):
            raise ValueError('standing treasury policy requires the exact check, warning evidence and no other exception')
        if entry['native_result'] == 'prior waived failure; changed inputs':
            waiver = entry.get('prior_waiver')
            prior = waiver.get('rca') if isinstance(waiver, dict) else None
            if (not isinstance(prior, dict) or waiver.get('disposition') != TREASURY_SKIP
                    or prior.get('standing_policy') != policy or prior.get('check') != entry['check']
                    or decision(prior) != TREASURY_SKIP):
                raise ValueError('standing treasury renewal must retain its original native FAIL qualification')
        elif entry['native_result'] != 'FAIL' or 'prior_waiver' in entry:
            raise ValueError('standing treasury policy requires an actual native FAIL or its existing renewal')
        return TREASURY_SKIP
    link = entry.get("repair_agent")
    external = entry.get("external_provider")
    execute = entry.get("execute_unverified", False)
    if type(execute) is not bool:
        raise ValueError("execute_unverified must be an explicit boolean")
    if entry.get("post_merge") is not None:
        return pending_post_merge(entry, attribution, link, external, execute)
    if execute and (entry["native_result"] != "UNVERIFIED" or not link or external):
        raise ValueError("Execution recovery requires an unverified result and a repair handoff")
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
        return "execution required" if execute else "delegated / waived"
    return "blocking"


PENDING = "pending post-merge"
PACKET_FIELDS = ("test", "command", "scope", "error", "source", "evidence")


def pending_post_merge(entry: dict, attribution: str, link, external, execute: bool) -> str:
    """A test that ran and failed for a NOT_INTRODUCED cause, parked for post-merge repair.

    Nothing is waived: no repair link, no provider waiver, no execution recovery. The parent
    must dispatch the packet after merge and convert it with a real repair link.
    """
    if link or external or execute:
        raise ValueError("A pending post-merge packet cannot carry a repair link, provider waiver or execution recovery")
    if attribution != "NOT_INTRODUCED":
        raise ValueError("Only NOT_INTRODUCED failures can wait for post-merge repair; introduced/unknown stay blocking")
    if not str(entry["native_result"]).strip().upper().startswith("FAIL"):
        raise ValueError("Only a test that actually ran and failed can be pending post-merge; UNVERIFIED stays blocking")
    packet = entry["post_merge"]
    if not isinstance(packet, dict) or any(not packet.get(k) for k in PACKET_FIELDS):
        raise ValueError("A pending post-merge packet requires exact test, command, scope, verbatim error, "
                         "source revision and failure evidence")
    source = entry.get("source")
    # Retain revision-only packets; a full source object must also match its digest.
    expected_source = source.get("head") if isinstance(source, dict) and isinstance(packet["source"], str) else source
    if (packet["test"] != entry.get("check") or packet["command"] != entry.get("command")
            or packet["source"] != expected_source):
        raise ValueError("A post-merge packet must match the recorded failure test, command and source")
    return PENDING


def resolve_post_merge(path: Path, occurrence_id: str, repair_agent: str) -> dict:
    """pending post-merge -> delegated / waived, only with a real repair link supplied after merge."""
    if not isinstance(repair_agent, str) or not repair_agent.strip():
        raise ValueError("Resolving a pending post-merge packet requires the actual repair link")
    with path.with_suffix(path.suffix + ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        report = json.loads(path.read_text())
        entry = next((x for x in report["failures"] if x["id"] == occurrence_id), None)
        if entry is None or entry.get("disposition") != PENDING:
            raise ValueError("Only a recorded pending post-merge occurrence can be resolved")
        resolved = {k: v for k, v in entry.items() if k not in {"post_merge", "disposition"}}
        resolved["repair_agent"] = repair_agent
        status = decision(resolved)  # validates the link; introduced/unknown can never reach here
        entry.update(resolved, disposition=status, resolved_post_merge=entry["post_merge"])
        del entry["post_merge"]
        fd, name = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
        try:
            with os.fdopen(fd, "w") as out:
                json.dump(report, out, indent=2); out.write("\n"); out.flush(); os.fsync(out.fileno())
            os.replace(name, path)
        finally:
            if os.path.exists(name): os.unlink(name)
        return report


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
    executions = [e for e in report["failures"] if e["disposition"] == "execution required"]
    if executions:
        lines.extend(["", "EXECUTION REQUIRED"])
        lines.extend(f"- {e['description']} — {e['native_result']} · Evidence: {e['evidence']} · Repair: {e['repair_agent']}" for e in executions)
    pending = [e for e in report["failures"] if e["disposition"] == PENDING]
    if pending:
        lines.extend(["", "PENDING POST-MERGE"])
        for e in pending:
            p = e["post_merge"]
            lines.append(f"- {e['description']} — {e['native_result']} · unresolved: dispatch after merge")
            lines.append(f"  Test: {p['test']} · Command: {p['command']} · Scope: {p['scope']} · Source: {p['source']}")
            lines.append(f"  Error: {p['error']}")
            lines.append(f"  Evidence: {p['evidence']}")
    handed = [e for e in report["failures"] if e["disposition"] == "delegated / waived"]
    if handed:
        lines.extend(["", "DELEGATED"])
        lines.extend(f"- {e['description']} — {e['repair_agent']}" for e in handed)
    for e in report['failures']:
        if e['disposition'] == TREASURY_SKIP:
            p = e['standing_policy']
            lines.extend(['', f"⚠️ Skipped — {e['description']} · native FAIL retained",
                          f"Reason: {p['reason']} · Evidence time: {p['evidence_at']}",
                          f"Affected records: {', '.join(p['affected_records']) or 'not available'}",
                          f"Evidence: {e['evidence']} · Standing user instruction: October 29, 2026"])
    # Always appended after every other section, preserving failed native results.
    for e in report["failures"]:
        if e["disposition"] == "external / waived":
            p = e["external_provider"]
            lines.extend(["", f"🚨🚨 EXTERNAL PROVIDER FAILURE — {p['name']}: {p['reason']} — NEEDS FIXING",
                          f"Affected check: {e['description']} · {e['native_result']}", f"Evidence: {e['evidence']}"])
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["record", "render", "resolve"])
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--occurrence", help="resolve: pending post-merge occurrence id")
    parser.add_argument("--repair-agent", help="resolve: the actual post-merge repair link")
    args = parser.parse_args()
    if args.action == "resolve":
        print(json.dumps(resolve_post_merge(args.report, args.occurrence, args.repair_agent)))
    elif args.action == "record":
        report = record(args.report, json.load(sys.stdin))
        print(json.dumps(report))
    else:
        print(render(json.loads(args.report.read_text()), sys.stdin.read()), end="")


if __name__ == "__main__":
    main()
