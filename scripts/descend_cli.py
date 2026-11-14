#!/usr/bin/env python3
"""One-line commands for /descend steps (see .claude/commands/descend.md → Process).

`handoff <campaign-or-run-dir> <task>` prints the complete /rca handoff for one failed
task, built only from that run's artifacts: a campaign's summary.json and job logs, or a
fleet run's record. A missing required field exits 1 naming it, and nothing is printed.
"""
from __future__ import annotations

import argparse
import json
import shlex
import sys
from pathlib import Path

# The canonical FE link run_benchmark.durable_agent_frontend_url records for an agent.
DURABLE_FRONTEND_URL = "https://roselabs.ai"
PASSING = {"PASSED", "SUCCEEDED", "SUCCESS", "SKIPPED"}
UNFINISHED = {"queued", "running"}
TIME_BOX_MINUTES = 100


class Missing(Exception):
    """A required handoff field the run's artifacts do not hold."""


def need(value: object, field: str, where: str) -> object:
    if value is None or (isinstance(value, str) and not value.strip()):
        raise Missing(f"{where}: missing {field}")
    return value


def read_json(path: Path, field: str) -> dict:
    if not path.is_file():
        raise Missing(f"missing {field}: {path} does not exist")
    try:
        document = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise Missing(f"missing {field}: {path} is not JSON ({error})") from error
    if not isinstance(document, dict):
        raise Missing(f"missing {field}: {path} is not a JSON object")
    return document


def fleet_of(log: Path, job_id: str) -> Path:
    """The fleet run a job's controller printed in its monitor line, as run-bench-campaign.py binds it."""
    if not log.is_file():
        raise Missing(f"job {job_id}: missing job log {log}")
    for line in log.read_text(errors="replace").splitlines():
        if "/scripts/run-bench monitor " in line:
            try:
                fields = shlex.split(line.strip())
            except ValueError as error:
                raise Missing(f"job {job_id}: unreadable 'run-bench monitor' line in {log} ({error})") from error
            if "monitor" in fields[:-1]:
                return Path(fields[fields.index("monitor") + 1])
    raise Missing(f"job {job_id}: missing fleet run directory (no 'run-bench monitor' line in {log})")


def task_rows(fleet: Path, task: str) -> tuple[dict, list[dict]]:
    """A fleet run's record (`_batch/run.json`, or `<task>/run.json` for one task) and the task's rows."""
    candidates = (fleet / "_batch" / "run.json", fleet / task / "run.json")
    path = next((candidate for candidate in candidates if candidate.is_file()), None)
    if path is None:
        raise Missing(f"missing run record: neither {candidates[0]} nor {candidates[1]} exists")
    record = read_json(path, "run record")
    rows = [row for row in record.get("tasks") or [] if isinstance(row, dict) and row.get("name") == task]
    if not rows:
        raise Missing(f"{path}: missing the task row for {task}")
    return record, rows


def source_of(record: dict, fleet: Path, where: str) -> str:
    """The executed source: the record's own SHA, else the fleet's launch provenance."""
    if record.get("source_sha"):
        return str(record["source_sha"])
    provenance = read_json(fleet / "execution-provenance.json", f"source SHA for {where}")
    base = need(provenance.get("base_sha"), "source SHA (execution-provenance.json base_sha)", where)
    patch = provenance.get("workspace_patch_sha256")
    return str(base) if patch in (None, "none") else f"{base} + workspace patch sha256 {patch}"


def failed_copy(row: dict, record: dict, fleet: Path, job_id: str, attempt: object) -> dict:
    where = f"job {job_id} attempt {attempt}"
    if row.get("passed") is not False:
        raise Missing(f"{where}: missing a failed verdict in the run record (passed={row.get('passed')!r})")
    if row.get("job_id") not in (None, job_id) or row.get("attempt") not in (None, attempt):
        raise Missing(f"{where}: missing its own run record (it names job {row.get('job_id')} attempt "
                      f"{row.get('attempt')})")
    agent_id = str(need(row.get("agent_id"), "agent_id", where))
    return {
        "job_id": job_id,
        "attempt": attempt,
        "run_id": need(record.get("run_id"), "fleet run_id", where),
        "status": need(row.get("benchmark_status") or row.get("status"), "status", where),
        "agent_id": agent_id,
        "fe_link": row.get("agent_url") or f"{DURABLE_FRONTEND_URL}/?agent-id={agent_id}",
        "failure": need(row.get("failure_reason"), "failure_reason (evaluator failure text)", where),
        "source": source_of(record, fleet, where),
    }


def campaign_copies(directory: Path, task: str) -> tuple[str, list[dict], dict[str, list[str]], int]:
    summary = read_json(directory / "summary.json", "campaign summary")
    campaign_id = str(need(summary.get("campaign_id"), "campaign_id", "summary.json"))
    jobs = [job for job in summary.get("jobs") or [] if isinstance(job, dict) and job.get("task") == task]
    if not jobs:
        raise Missing(f"campaign {campaign_id}: missing any scheduled job for task {task}")
    failed: list[dict] = []
    others: dict[str, list[str]] = {"passed": [], "unfinished": [], "cancelled": []}
    for job in jobs:
        job_id = str(need(job.get("job_id"), "job_id", f"campaign {campaign_id} task {task}"))
        attempt = need(job.get("attempt"), "attempt", f"job {job_id}")
        status, verdict = job.get("status"), str(job.get("task_status") or "").upper()
        label = f"{job_id} (attempt {attempt})"
        if status in UNFINISHED:
            others["unfinished"].append(label)
        elif status == "cancelled":
            others["cancelled"].append(label)
        elif verdict in PASSING or (not verdict and status == "passed"):
            others["passed"].append(label)
        else:
            # Every attempt log lives in the campaign directory, even after it is archived elsewhere.
            log = directory / Path(str(need(job.get("log"), "log", f"job {job_id}"))).name
            fleet = fleet_of(log, job_id)
            record, rows = task_rows(fleet, task)
            if len(rows) != 1:
                raise Missing(f"job {job_id}: missing a single task row in {fleet} ({len(rows)} rows)")
            failed.append(failed_copy(rows[0], record, fleet, job_id, attempt))
    return f"Campaign: {campaign_id}", failed, others, len(jobs)


def fleet_copies(fleet: Path, task: str) -> tuple[str, list[dict], dict[str, list[str]], int]:
    record, rows = task_rows(fleet, task)
    run_id = str(need(record.get("run_id"), "fleet run_id", str(fleet)))
    failed: list[dict] = []
    others: dict[str, list[str]] = {"passed": [], "unfinished": [], "cancelled": []}
    for row in rows:
        # A direct fleet run is one physical attempt; campaign-bound records carry their own job and attempt.
        job_id, attempt = str(row.get("job_id") or run_id), row.get("attempt") or 1
        if row.get("passed") is False:
            failed.append(failed_copy(row, record, fleet, job_id, attempt))
        elif row.get("passed") is True:
            others["passed"].append(f"{job_id} (attempt {attempt})")
        else:
            others["unfinished"].append(f"{job_id} (attempt {attempt})")
    campaign = rows[0].get("campaign_id")
    return (f"Campaign: {campaign}\n" if campaign else "") + f"Fleet run: {run_id}", failed, others, len(rows)


def handoff_text(task: str, scope: str, failed: list[dict], others: dict[str, list[str]], total: int) -> str:
    lines = [
        f"/rca {task}: {len(failed)} of {total} scheduled copies failed in a /descend run.",
        "This handoff carries the evidence from the run's artifacts; start from it.",
        "",
        scope,
        "Failed copies:",
    ]
    for copy in failed:
        lines += [
            f"- Job {copy['job_id']}, attempt {copy['attempt']} (fleet run {copy['run_id']}): {copy['status']}",
            f"  Agent ID: {copy['agent_id']}",
            f"  FE link: {copy['fe_link']}",
            f"  Source SHA: {copy['source']}",
            f"  Evaluator failure: {copy['failure']}",
        ]
    for kind, label in (("passed", "Passed copies"), ("unfinished", "Still running or queued"),
                        ("cancelled", "Cancelled copies")):
        if others[kind]:
            lines.append(f"{label}: {', '.join(others[kind])}")
    lines += [
        "",
        f"Time box: {TIME_BOX_MINUTES} minutes of wall clock from when you start; no tool-call or token cap "
        "replaces it. At 90 minutes commit what works and hand back your evidence; at 100 minutes the parent "
        "takes what you handed back.",
        "",
        "Rules (/descend RCA per failure and Fixes):",
        "- Dedupe first: check the RCA ledger in the /descend state and search the archive with "
        "`python3 scripts/rca_archive.py search` and this failure's literal strings. If another RCA already owns "
        "this defect, hand it this task with the evidence above and stop. "
        "Post your named defect (code site and mechanism) to the ledger before writing a fix; the later of two "
        "RCAs naming the same site hands over the same way.",
        "- A shared symptom (failure string, evaluator, status, timeout, website or issue class) is not the same "
        "defect. Name a concrete defect at a code site (does X, should do Y, observed Z).",
        "- Prove the fix at the owning boundary with an isolated local repro and land the regression in the "
        "owning suite; a full benchmark rerun is not proof, and an end-to-end check needs a slot the parent "
        "grants.",
        "- Work in your own worktree on files no other RCA edits; never run scripts/setup-db.sh there.",
        "- Never deploy and never contact the user; never launch batches or change the active benchmark "
        "snapshot. Hand the fix to the parent, which commits it.",
    ]
    return "\n".join(lines)


def cmd_handoff(args: argparse.Namespace) -> int:
    directory = Path(args.run_dir)
    try:
        if not directory.is_dir():
            raise Missing(f"missing campaign or fleet run directory {directory}")
        collect = campaign_copies if (directory / "summary.json").is_file() else fleet_copies
        scope, failed, others, total = collect(directory, args.task)
        if not failed:
            raise Missing(f"{scope.replace(chr(10), ', ')}: missing a failed copy of {args.task} "
                          f"(passed: {len(others['passed'])}, still running or queued: {len(others['unfinished'])}, "
                          f"cancelled: {len(others['cancelled'])})")
    except Missing as error:
        print(f"descend handoff: {error}", file=sys.stderr)
        return 1
    print(handoff_text(args.task, scope, failed, others, total))
    return 0


def main(argv: list[str] | None = None) -> int:
    top = argparse.ArgumentParser(prog="scripts/descend", description=__doc__.splitlines()[0])
    sub = top.add_subparsers(dest="command", required=True)
    handoff = sub.add_parser("handoff", help="print the /rca handoff for one failed task (RCA_FAILURES)")
    handoff.add_argument("run_dir", metavar="campaign-or-run-dir")
    handoff.add_argument("task")
    handoff.set_defaults(func=cmd_handoff)
    args = top.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
