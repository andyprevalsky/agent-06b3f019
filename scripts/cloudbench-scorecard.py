#!/usr/bin/env python3
"""Render the mandatory benchmark scorecard (FORMAT v8) from recorded artifacts.

    scripts/run-bench scorecard <run-dir> [--html OUT] [--text] [--json]
        [--agents FILE] [--issues FILE] [--ledger FILE] [--goal GOAL] [--shallow]
    scripts/run-bench scorecard --validate <card.html>
    scripts/run-bench scorecard --instruction <run-dir>

<run-dir> is a fleet run (``_batch/report-card.json``), a local run context
(``report-card.json``), a campaign directory (``summary.json``) or a sharded
original600 admission directory (``coordination.json``). Values come only from
those recorded artifacts and the experiments ledger; anything missing renders
as an explicit RUNNING / UNMEASURED / UNMETERED / UNRECORDED state, never as an
invented number. Stdlib only, so it runs from a scripts-only checkout.
"""

from __future__ import annotations

import argparse
import html
import json
import math
import re
import sys
import tarfile
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cloudbench_experiments as ledger_mod

FORMAT = "v8"
GENERATOR = "cloudbench-scorecard " + FORMAT
TERMINAL_JOB = {"passed", "failed", "cancelled", "skipped"}
CATEGORIES = ("PASS", "AGENT FAIL", "HARNESS", "INFRA", "UNKNOWN", "CANCELLED", "SKIPPED")
CATEGORY_CLASS = {"PASS": "ok", "AGENT FAIL": "agent", "HARNESS": "harness", "INFRA": "bad",
                  "UNKNOWN": "warn", "CANCELLED": "na", "SKIPPED": "na"}
STATE_ICON = {"RUNNING": "🔵", "COMPLETE": "✅", "FAILED": "🔴", "ABORTED": "🔴", "HELD": "⏸",
              "INCOMPLETE": "🟠", "NOT LAUNCHED": "⚪", "UNRECORDED": "🟠"}
STATE_CLASS = {"RUNNING": "run", "COMPLETE": "ok", "FAILED": "bad", "ABORTED": "bad", "HELD": "warn",
               "INCOMPLETE": "warn", "NOT LAUNCHED": "na", "UNRECORDED": "warn"}
LIFE_ICON = {"ok": "✅", "fail": "🔴", "warn": "🟠", "pending": "🔵"}
REQUIRED_SECTIONS = ("header", "kpis", "outcomes", "causes", "timing", "lifecycle", "history",
                     "agents", "issues", "footer")
REQUIRED_TEXT = ("Experiment #", "experiments/day", "Since last benchmark ended", "PASS", "HARNESS",
                 "INFRA", "Stop at", "LAST 3 EXPERIMENTS", "Lifecycle", "ISSUES / NEXT ACTION",
                 "ACTIVE SUB-AGENTS", "Cost", "Cache", "LLM")
SENTINEL = re.compile(r"(?<![\w/.-])(null|None|NaN|undefined|N/A|n/a)(?![\w/.-])|—")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


# ---------------------------------------------------------------- formatting

def pacific(epoch: float | None, date: bool = True) -> str:
    """12-hour America/Los_Angeles time with the PDT/PST of that instant (US rules since 2007)."""
    if not isinstance(epoch, (int, float)):
        return "UNRECORDED"
    utc = datetime.fromtimestamp(epoch, timezone.utc)
    year = utc.year
    march = datetime(year, 3, 1, tzinfo=timezone.utc)
    start = march + timedelta(days=(6 - march.weekday()) % 7 + 7, hours=10)  # 2:00 PST, 2nd Sunday March
    november = datetime(year, 11, 1, tzinfo=timezone.utc)
    end = november + timedelta(days=(6 - november.weekday()) % 7, hours=9)  # 2:00 PDT, 1st Sunday November
    daylight = start <= utc < end
    local = utc + timedelta(hours=-7 if daylight else -8)
    hour = local.hour % 12 or 12
    clock = f"{hour}:{local.minute:02d}:{local.second:02d} {'AM' if local.hour < 12 else 'PM'} {'PDT' if daylight else 'PST'}"
    return f"{local:%b} {local.day}, {clock}" if date else clock


def duration(seconds: float | None) -> str:
    if not isinstance(seconds, (int, float)) or seconds < 0:
        return "UNMEASURED"
    seconds = int(round(seconds))
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    minutes, secs = divmod(rest, 60)
    if days:
        return f"{days}d{hours}h"
    if hours:
        return f"{hours}h{minutes:02d}m"
    if minutes:
        return f"{minutes}m{secs:02d}s"
    return f"{secs}s"


def pct(numerator: int, denominator: int) -> str:
    return f"{100.0 * numerator / denominator:.1f}%" if denominator else "NO DATA"


def compact(number: float | None) -> str:
    if not isinstance(number, (int, float)):
        return "UNMETERED"
    for limit, suffix in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if abs(number) >= limit:
            return f"{number / limit:.2f}".rstrip("0").rstrip(".") + suffix
    return str(int(number))


def money(value: float) -> str:
    return f"${value:,.2f}"


def short_ref(ref) -> str:
    return ref[:9] if isinstance(ref, str) and ref else "UNRECORDED"


def quantile(values: list[float], q: float) -> float | None:
    values = sorted(v for v in values if isinstance(v, (int, float)))
    if not values:
        return None
    index = max(0, math.ceil(q * len(values)) - 1)
    return values[index]


def epoch_of(value) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def read_json(path: Path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


def read_epoch(path: Path) -> float | None:
    try:
        return float(Path(path).read_text().strip())
    except (OSError, ValueError):
        return None


def reason_key(text) -> str:
    """Cluster label for a recorded failure reason: first clause, IDs folded."""
    if not isinstance(text, str) or not text.strip():
        return ""
    head = text.strip().split(" | ")[0]
    head = UUID.sub("<id>", head)
    head = re.sub(r"\b[0-9a-f]{14,}\b", "<id>", head)
    return head[:240]


# -------------------------------------------------------------- job records

def classify(row: dict) -> str:
    """Logical job state: QUEUED / RUNNING or one terminal outcome category."""
    status = row.get("status")
    if status not in TERMINAL_JOB:
        return "RUNNING" if status == "running" or row.get("attempts") else "QUEUED"
    if status == "cancelled":
        return "CANCELLED"
    verdict = str(row.get("task_status") or "").upper()
    if row.get("infra_failure") is True or verdict == "INFRA_ERROR":
        return "INFRA"
    if row.get("harness_failure") is True:
        return "HARNESS"
    if verdict == "PASSED":
        return "PASS"
    if verdict == "FAILED":
        return "AGENT FAIL"
    if verdict == "SKIPPED" or status == "skipped":
        return "SKIPPED"
    return "UNKNOWN"


def card_task(card: dict | None, task: str | None) -> dict:
    rows = (card or {}).get("per_task") or []
    for row in rows:
        if isinstance(row, dict) and row.get("name") == task:
            return row
    return rows[0] if len(rows) == 1 and isinstance(rows[0], dict) else {}


def card_for(job: dict, cards: dict) -> dict | None:
    """The job's fleet report card: exact run ID first, then its controller PID run."""
    for attempt in [job, *reversed(job.get("attempts") or [])]:
        run_id = attempt.get("run_id")
        if run_id in cards:
            return cards[run_id]
    for attempt in [job, *reversed(job.get("attempts") or [])]:
        pid = attempt.get("controller_pid")
        if isinstance(pid, int):
            matches = [c for rid, c in cards.items() if rid.endswith(f"-{pid}") and card_task(c, job.get("task"))]
            if len(matches) == 1:
                return matches[0]
    return None


def compact_rows(summary: dict, cards: dict | None = None) -> list[dict]:
    """Bounded per-job rows from a campaign summary plus its fleet report cards."""
    cards = cards or {}
    rows = []
    for job in summary.get("jobs") or []:
        if not isinstance(job, dict):
            continue
        attempts = [a for a in job.get("attempts") or [] if isinstance(a, dict)]
        card = card_for(job, cards)
        task = card_task(card, job.get("task"))
        row = {
            "job_id": job.get("job_id"), "task": job.get("task"), "run": job.get("run"),
            "status": job.get("status"), "task_status": job.get("task_status"),
            "infra_failure": job.get("infra_failure"),
            "attempts": len(attempts),
            "terminal_attempts": sum(a.get("status") in TERMINAL_JOB and bool(a.get("finished_at")) for a in attempts),
            "infra_attempts": sum(a.get("infra_failure") is True for a in attempts),
            "wall_s": job.get("wall_clock_seconds"),
            "started_at": epoch_of(job.get("started_at")), "finished_at": epoch_of(job.get("finished_at")),
            "released": job.get("resources_released"), "lifecycle": job.get("lifecycle_verified"),
            "exec_s": task.get("duration_s"), "cost_usd": task.get("cost_usd"),
            "reason": reason_key(task.get("failure_reason")), "agent_id": task.get("agent_id"),
            "cache_hit": ((card or {}).get("cost") or {}).get("fast_cache_hit_rate"),
            "window_s": _window(card),
            "unmetered": sorted(k.replace("_usd", "") for k, v in ((card or {}).get("cost") or {}).items()
                                if k.endswith("_usd") and k != "total_usd" and v is None),
        }
        # An evaluated card verdict survives a later controller/release failure.
        if row["task_status"] is None and task.get("status") in ("passed", "failed") \
                and task.get("lifecycle_stage") in ("evaluated", "teardown", "released"):
            row["task_status"] = task["status"].upper()
            row["verdict_source"] = "report-card"
        if row["status"] in TERMINAL_JOB - {"cancelled"} and row["terminal_attempts"] == 0 and not attempts:
            row["terminal_attempts"] = 1
        rows.append(row)
    return rows


def _window(card) -> float | None:
    values = (((card or {}).get("execution_provenance") or {}).get("config") or {}).get("values") or {}
    try:
        return float(values.get("benchmark_wall_clock_backstop_seconds") or values.get("run_timeout_seconds"))
    except (TypeError, ValueError):
        return None


CARD_PATTERN = re.compile(r"(^|/)\.?context/fleet/runs/([^/]+)/_batch/report-card\.json$")
MACHINE_ID = re.compile(r"^[0-9a-f]{14}$")
RELEASED_TERMINALS = {"CONTROLLER_RELEASE_VERIFIED", "DEAD_OWNER_CONTROLLER_RELEASE_VERIFIED", "FAILED_BEFORE_SUPERVISOR_RELEASED"}
SUMMARY_PATTERN = re.compile(r"(^|/)\.?context/benchmarks/campaigns/[^/]+/summary\.json$")


def export_records(export: Path) -> dict:
    """One pass over a verified controller export: campaign summary and fleet report cards.
    Owned guest identities belong to scripts/cloudbench-native-release-audit.py."""
    records = {"summary": None, "cards": {}}
    archive = Path(export) / "originals.tar.gz"
    if not (Path(export) / "disposable-export.verified.json").exists() or not archive.exists():
        return records
    with tarfile.open(archive, "r:gz") as stream:
        for member in stream:
            if not member.isfile() or member.size > 4 * 1024 * 1024:
                continue
            if records["summary"] is None and SUMMARY_PATTERN.search(member.name):
                records["summary"] = json.loads(stream.extractfile(member).read())
            elif CARD_PATTERN.search(member.name):
                card = json.loads(stream.extractfile(member).read())
                if isinstance(card, dict) and isinstance(card.get("run_id"), str):
                    records["cards"][card["run_id"]] = card
    return records


def rows_from_counters(progress: dict) -> list[dict]:
    """Synthetic per-job rows from the supervisor's bounded live counters."""
    rows = []
    for item in progress.get("combos") or []:
        if not (isinstance(item, list) and len(item) == 4 and isinstance(item[3], int)):
            continue
        status, verdict, infra, count = item
        rows += [{"status": status, "task_status": verdict, "infra_failure": infra, "synthetic": True,
                  "attempts": 1 if status != "queued" else 0} for _ in range(min(count, 100000))]
    return rows


# -------------------------------------------------------------- experiment

def empty_experiment(kind: str, run_dir: Path) -> dict:
    return {"id": run_dir.name, "kind": kind, "run_dir": str(run_dir), "label": None, "surface": "cloud",
            "tasks": None, "runs": None, "scheduled_total": None, "source_ref": None, "task_ref": None,
            "triggered_at": None, "released_at": None, "ended_at": None, "end_evidence": None,
            "state": "RUNNING", "state_reason": "", "rows": [], "rows_source": None, "window_s": None,
            "lifecycle": [], "notes": [], "issues": []}


def finish_experiment(exp: dict) -> dict:
    """Derive progress, outcomes, infra accounting, timing and cost from rows."""
    rows = exp.pop("rows")
    scheduled = exp.get("scheduled_total") or len(rows) or None
    exp["scheduled_total"] = scheduled
    states = Counter(classify(r) for r in rows)
    completed = sum(states[c] for c in CATEGORIES)
    observed = len(rows)
    progress = {"queued": states["QUEUED"], "in_progress": states["RUNNING"], "completed": completed,
                "unobserved": max(0, (scheduled or 0) - observed)}
    if exp.get("state") == "NOT LAUNCHED":
        progress = {"queued": scheduled or 0, "in_progress": 0, "completed": 0, "unobserved": 0}
    exp["progress"] = progress if rows or exp.get("state") == "NOT LAUNCHED" else None
    outcomes = {c: states[c] for c in CATEGORIES}
    classified = completed and states["UNKNOWN"] == 0
    exp["harness_classified"] = bool(classified) or any(r.get("harness_failure") is not None for r in rows)
    exp["outcomes"] = outcomes if rows else None
    exp["scored"] = outcomes["PASS"] + outcomes["AGENT FAIL"] if rows else None
    exp["terminal_attempts"] = sum(r.get("terminal_attempts", 1 if classify(r) in CATEGORIES else 0) for r in rows) if rows else None
    exp["infra_attempts"] = sum(r.get("infra_attempts", 1 if classify(r) == "INFRA" else 0) for r in rows) if rows else None
    exp["infra_jobs"] = outcomes["INFRA"] if rows else exp.get("infra_jobs")
    exp["infra_threshold"] = math.ceil(scheduled / 20) if scheduled else None
    exp["infra_breached"] = bool(scheduled and exp["infra_jobs"] is not None and 20 * exp["infra_jobs"] >= scheduled)
    reasons = Counter()
    for row in rows:
        category = classify(row)
        if row.get("synthetic"):
            continue
        if category in ("AGENT FAIL", "INFRA", "UNKNOWN", "HARNESS"):
            reasons[(category, row.get("reason") or ("no task result recorded" if category == "UNKNOWN" else "reason UNRECORDED"))] += 1
    for category, text, count in exp.pop("live_reasons", []) or []:
        reasons[(category, text)] += count
    exp["reasons"] = [[cat, text, count] for (cat, text), count in reasons.most_common(6)]
    exp["reasons_more"] = sum(reasons.values()) - sum(r[2] for r in exp["reasons"])
    walls = [r["wall_s"] for r in rows if classify(r) in CATEGORIES and isinstance(r.get("wall_s"), (int, float))]
    execs = [r["exec_s"] for r in rows if classify(r) in CATEGORIES and isinstance(r.get("exec_s"), (int, float))]
    exp["wall"] = {"n": len(walls), "of": completed, "p50": quantile(walls, 0.5), "max": max(walls)} if walls else None
    exp["exec"] = {"n": len(execs), "of": completed, "p50": quantile(execs, 0.5), "p95": quantile(execs, 0.95)} if execs else None
    windows = {r.get("window_s") for r in rows if r.get("window_s")}
    if exp.get("window_s") is None and len(windows) == 1:
        exp["window_s"] = windows.pop()
    costs = [r["cost_usd"] for r in rows if isinstance(r.get("cost_usd"), (int, float))]
    unmetered = sorted({k for r in rows for k in r.get("unmetered") or []})
    exp["cost"] = {"metered_usd": round(sum(costs), 2) if costs else None, "n": len(costs), "of": observed,
                   "unmetered": unmetered} if rows else None
    hits = [r["cache_hit"] for r in rows if isinstance(r.get("cache_hit"), (int, float))]
    exp["cache"] = {"avg": sum(hits) / len(hits), "n": len(hits), "of": observed} if hits else None
    released = [r.get("released") for r in rows if started_terminal(r)]
    exp["released"] = {"yes": sum(v is True for v in released), "of": len(released)} if released else None
    lifecycle = [r.get("lifecycle") for r in rows if started_terminal(r)]
    exp["lifecycle_verified"] = {"yes": sum(v is True for v in lifecycle), "of": len(lifecycle)} if lifecycle else None
    exp["unknown_jobs"] = [r.get("task") or r.get("job_id") for r in rows if classify(r) == "UNKNOWN"][:6]
    exp["unreleased_jobs"] = [r.get("task") or r.get("job_id") for r in rows
                              if started_terminal(r) and r.get("released") is False][:6]
    return exp


def lifecycle_item(exp, state, label, detail="", issue=True):
    exp["lifecycle"].append({"state": state, "label": label, "detail": detail, "issue": issue})


def load_fleet(run_dir: Path) -> dict:
    exp = empty_experiment("fleet", run_dir)
    local = not (run_dir / "_batch").is_dir()
    batch = run_dir if local else run_dir / "_batch"
    card = read_json(batch / "report-card.json") or {}
    exp["surface"] = "local" if local else "cloud"
    exp["id"] = card.get("run_id") or run_dir.name
    tasks = card.get("tasks") or {}
    # The fleet's startup card lists starting tasks; later cards carry counts.
    total = len(tasks) if isinstance(tasks, list) else tasks.get("total")
    exp["scheduled_total"] = total if isinstance(total, int) else None
    code = str(card.get("code") or "")
    match = re.search(r"@([0-9a-f]{7,40})", code)
    exp["source_ref"] = match.group(1) if match else None
    exp["task_ref"] = ((card.get("execution_provenance") or {}).get("base_sha"))
    starts = [read_epoch(p) for p in run_dir.glob("*/bench-e2e.started-epoch")]
    starts = [s for s in starts if s]
    exp["triggered_at"] = min(starts) if starts else epoch_of(card.get("timestamp"))
    exp["window_s"] = _window(card)
    lifecycle = read_json(batch / "lifecycle.json")
    rows = []
    stage_status = {"queued": "queued", "starting": "running", "ready": "running", "running": "running",
                    "evaluated": "running", "teardown": "running"}
    for task in card.get("per_task") or []:
        if not isinstance(task, dict):
            continue
        name, status = task.get("name"), task.get("status")
        task_dir = run_dir / str(name)
        finished = (task_dir / "bench-e2e.finished-epoch").exists() or task.get("lifecycle_stage") == "released"
        verdict = {"passed": "PASSED", "failed": "FAILED", "skipped": "SKIPPED"}.get(status)
        rows.append({
            "job_id": name, "task": name,
            "status": ("passed" if verdict else "failed") if finished else stage_status.get(task.get("lifecycle_stage"), "queued"),
            "task_status": verdict, "infra_failure": False if verdict else None,
            "exec_s": task.get("duration_s"), "cost_usd": task.get("cost_usd"), "agent_id": task.get("agent_id"),
            "reason": reason_key(task.get("failure_reason")),
            "released": True if (isinstance(lifecycle, dict) and lifecycle.get("status") == "verified") else None,
            "cache_hit": (card.get("cost") or {}).get("fast_cache_hit_rate"),
            "unmetered": sorted(k.replace("_usd", "") for k, v in (card.get("cost") or {}).items()
                                if k.endswith("_usd") and k != "total_usd" and v is None),
            "wall_s": (read_epoch(task_dir / "bench-e2e.finished-epoch") or 0) - (read_epoch(task_dir / "bench-e2e.started-epoch") or 0)
            if (task_dir / "bench-e2e.finished-epoch").exists() and (task_dir / "bench-e2e.started-epoch").exists() else None,
        })
    exp["rows"], exp["rows_source"] = rows, "report-card.json"
    teardown = read_epoch(run_dir / "teardown-ownership/provider-teardown-verified.epoch")
    finishes = [read_epoch(p) for p in run_dir.glob("*/bench-e2e.finished-epoch")]
    finishes = [f for f in finishes if f]
    if isinstance(lifecycle, dict) and lifecycle.get("status") in ("verified", "failed"):
        exp["ended_at"] = teardown or (max(finishes) if finishes and len(finishes) == len(rows) else None)
        exp["end_evidence"] = "provider-teardown-verified.epoch" if teardown else "bench-e2e.finished-epoch"
        exp["state"] = "COMPLETE" if lifecycle["status"] == "verified" and not lifecycle.get("hub_publication_failed") else "INCOMPLETE"
        if lifecycle["status"] == "failed":
            exp["state"], exp["state_reason"] = "FAILED", "lifecycle.json status failed"
        lifecycle_item(exp, "ok" if lifecycle["status"] == "verified" else "fail", "Owned resources released",
                       "lifecycle.json " + lifecycle["status"])
        lifecycle_item(exp, "fail" if lifecycle.get("hub_publication_failed") else "ok", "Final Hub publication")
        lifecycle_item(exp, "ok" if lifecycle.get("controller_exit_code") in (0, 1) else "fail", "Controller exited",
                       f"exit {lifecycle.get('controller_exit_code')}")
    elif local:
        lifecycle_item(exp, "warn", "Owned resources released", "local stack: no lifecycle receipt")
        if rows and all(r["status"] in TERMINAL_JOB for r in rows):
            exp["state"], exp["state_reason"] = "INCOMPLETE", "results recorded; no release receipt"
    else:
        lifecycle_item(exp, "pending", "Owned resources released", "lifecycle.json pending")
    return finish_experiment(exp)


def load_campaign(run_dir: Path) -> dict:
    summary = read_json(run_dir / "summary.json") or {}
    exp = empty_experiment("campaign", run_dir)
    exp["id"] = summary.get("campaign_id") or run_dir.name
    exp["scheduled_total"] = summary.get("group_total") or summary.get("total_jobs")
    exp["runs"] = summary.get("runs")
    exp["tasks"] = summary.get("task_count")
    exp["triggered_at"] = epoch_of(summary.get("e2e_started_at_epoch")) or epoch_of(summary.get("started_at"))
    cards = {}
    for job in summary.get("jobs") or []:
        for attempt in [job, *(job.get("attempts") or [])]:
            fleet = attempt.get("fleet_dir") if isinstance(attempt, dict) else None
            if isinstance(fleet, str):
                card = read_json(Path(fleet) / "_batch/report-card.json")
                if isinstance(card, dict) and card.get("run_id"):
                    cards[card["run_id"]] = card
    exp["rows"], exp["rows_source"] = compact_rows(summary, cards), "summary.json"
    status = summary.get("status")
    if summary.get("finished_at"):
        exp["ended_at"], exp["end_evidence"] = epoch_of(summary["finished_at"]), "summary.json finished_at"
        exp["state"] = {"passed": "COMPLETE", "failed": "FAILED", "cancelled": "ABORTED"}.get(status, "INCOMPLETE")
        if summary.get("e2e_timeout_exceeded"):
            exp["state_reason"] = "whole-experiment deadline exceeded"
    _job_lifecycle(exp)
    return finish_experiment(exp)


def started_terminal(row) -> bool:
    """Terminal jobs that could own resources (a never-started cancellation owns none)."""
    return classify(row) in CATEGORIES and not (classify(row) == "CANCELLED" and not row.get("attempts"))


def _job_lifecycle(exp, audit=None, finished_after=None):
    rows = exp["rows"]
    terminal = [r for r in rows if started_terminal(r)]
    if not terminal:
        lifecycle_item(exp, "pending", "Guests released", "no terminal jobs yet")
        return
    released = sum(r.get("released") is True for r in terminal)
    checked = (audit or {}).get("checked") or {}
    usable = (isinstance(audit, dict) and audit.get("schema") == "cloudbench-native-release-audit-v1"
              and isinstance(audit.get("present"), list)
              # Registry/owner metadata can precede any recorded guest name; it still counts.
              and (checked.get("guest_names") or checked.get("guest_ids") or checked.get("guest_volumes")
                   or checked.get("owner_tokens") or checked.get("controller_ids") or audit.get("retained_owners"))
              and (not finished_after or (audit.get("observed_at") or 0) >= finished_after))
    lingering = (audit["present"] + (audit.get("present_volumes") or [])) if usable else []
    retained = (audit.get("retained_owners") or []) if usable else []
    if usable and (lingering or retained):
        detail = []
        if lingering:
            detail.append(f"still present: {', '.join(str(m.get('name') or m.get('id')) for m in lingering[:4])}")
        if retained:
            detail.append(f"retained owners: {', '.join(token[:12] for token in retained[:4])}")
        lifecycle_item(exp, "fail", "Guests released (native audit)", " · ".join(detail))
    elif usable and audit.get("released") is False:
        # Nothing listed, but the audit did not check every shard's export.
        lifecycle_item(exp, "warn", "Guests released (native audit incomplete)",
                       f"{checked.get('verified_exports')}/{checked.get('expected_shards')} verified shard exports checked")
    elif usable:
        exp["_audit_released"] = True
        lifecycle_item(exp, "ok", "Guests released (native audit)",
                       f"{pacific(audit['observed_at'])}: none present of {len(checked['guest_names'])} owned guests "
                       f"+ {len(checked.get('controller_ids') or [])} controllers")
    else:
        lifecycle_item(exp, "ok" if released == len(terminal) else "warn", "Guests released",
                       f"{released}/{len(terminal)} terminal jobs" + ("" if released == len(terminal) else " · no native audit"))
    verified = sum(r.get("lifecycle") is True for r in terminal)
    lifecycle_item(exp, "ok" if verified == len(terminal) else "warn", "Lifecycle verified",
                   f"{verified}/{len(terminal)} terminal jobs")


def shard_out(admission: Path, recorded: str) -> Path:
    path = Path(recorded)
    if path.exists():
        return path
    parts = path.parts
    if admission.name in parts:
        return admission.joinpath(*parts[parts.index(admission.name) + 1:])
    return path


RELEASED_VOLUME = ("ABSENT", "pending_destroy", "destroyed")


def canonical_release(export: Path) -> dict | None:
    """The exact cleanup helper's ``disposable-controller.release.json``, bound to this export's
    controller ownership record; the runner's terminal.json is absent when release ran outside it."""
    receipt = read_json(export / "disposable-controller.release.json")
    owned = read_json(export / "disposable-controller.ownership.json")
    workspace = read_json(export / "workspace-volume.ownership.json")
    if not (isinstance(receipt, dict) and isinstance(owned, dict)):
        return None
    mid, vid = receipt.get("machine_id"), receipt.get("volume_id")
    if not (isinstance(mid, str) and MACHINE_ID.match(mid) and isinstance(vid, str) and vid
            and receipt.get("machine_deleted") is True and receipt.get("volume_disposition") in RELEASED_VOLUME):
        return None
    if (owned.get("machine") or {}).get("id") != mid or (owned.get("volume") or {}).get("id") != vid:
        return None
    if isinstance(workspace, dict) and workspace.get("volume_id") != vid:
        return None
    return {"status": "CANONICAL_RELEASE_RECEIPT", "machine": mid, "volume_disposition": receipt["volume_disposition"]}


def barrier_never_released(coordination: dict, outs: list[Path]) -> bool:
    """The coordinator decided ABORT (never release), every runner joined, and every shard holds the
    delivered global-abort.json with no global-release.json: no scheduled job could start."""
    return bool(outs and coordination.get("aborted_at") and not coordination.get("released_at")
                and coordination.get("finished_at")
                and all((out / "global-abort.json").exists() and not (out / "global-release.json").exists()
                        for out in outs))


def load_sharded(run_dir: Path, deep: bool = True) -> dict:
    exp = empty_experiment("sharded", run_dir)
    coordination = read_json(run_dir / "coordination.json") or {}
    starts = [read_json(p) or {} for p in sorted(run_dir.glob("shard-*/attempt-start.safe.json"))]
    epochs = [s.get("started_at_epoch") for s in starts if isinstance(s.get("started_at_epoch"), (int, float))]
    exp["triggered_at"] = min(epochs) if epochs else coordination.get("started_at")
    refs = {s.get("source_ref") for s in starts} - {None}
    task_refs = {s.get("task_ref") for s in starts} - {None}
    exp["source_ref"] = next(iter(refs)) if len(refs) == 1 else None
    exp["task_ref"] = next(iter(task_refs)) if len(task_refs) == 1 else None
    exp["scheduled_total"] = coordination.get("scheduled_total")
    exp["released_at"] = coordination.get("released_at")
    group = (read_json(run_dir / "hub-group/hub-group.json") or {}).get("run_group") or {}
    members = [m for m in group.get("members") or [] if isinstance(m, dict)]
    if members:
        exp["tasks"] = len({m.get("name") for m in members})
        exp["runs"] = max((m.get("run_number") or 1) for m in members)
    controllers = coordination.get("controllers") or len(coordination.get("shards") or {})
    outs = [shard_out(run_dir, v.get("out", "")) for _, v in sorted((coordination.get("shards") or {}).items(),
                                                                       key=lambda item: int(item[0]))]
    terminals = [read_json(out / "terminal.json") for out in outs]
    statuses = [read_json(out / "shard-status.json") or {} for out in outs]
    result = read_json(run_dir / "result.json")
    if isinstance(result, dict) and isinstance(result.get("jobs"), list):
        exp["rows"], exp["rows_source"] = result["jobs"], "result.json"
    elif deep and any((out / "export/disposable-export.verified.json").exists() for out in outs):
        with ThreadPoolExecutor(max_workers=8) as pool:
            records = list(pool.map(lambda out: export_records(out / "export"), outs))
        for record in records:
            if record["summary"]:
                exp["rows"] += compact_rows(record["summary"], record["cards"])
        exp["rows_source"] = "verified controller exports"
    if not exp["rows"]:
        progress = [((s.get("infra") or {}).get("progress") or {}) for s in statuses]
        if any(p.get("combos") for p in progress):
            for item in progress:
                exp["rows"] += rows_from_counters(item)
                for entry in item.get("reasons") or []:
                    if isinstance(entry, list) and len(entry) in (2, 3) and isinstance(entry[-1], int):
                        category = entry[0] if len(entry) == 3 and entry[0] in CATEGORIES else "UNKNOWN"
                        exp.setdefault("live_reasons", []).append([category, reason_key(entry[-2]), entry[-1]])
            exp["rows_source"] = "live shard-status counters"
        elif isinstance(result, dict) and isinstance(result.get("task_status"), dict):
            exp["rows"], exp["rows_source"] = _rows_from_aggregate(result), "result.json aggregate"
    abort = None
    for name in ("manual-abort-after-operator-loss.json", "manual-abort.json", "manual-closure.json"):
        receipt = read_json(run_dir / name)
        if isinstance(receipt, dict):
            at = receipt.get("at") or max((r.get("at") or 0 for r in receipt.get("results") or []), default=0) or None
            abort = (name, at, str(receipt.get("reason") or name), receipt)
            break
    acks = (abort[3].get("results") if abort else None) or []
    aborted_before_release = bool(not coordination.get("released_at") and acks and exp["scheduled_total"]
                                  and len(acks) == controllers and all(r.get("abort_state") == "ABORTED" for r in acks))
    if aborted_before_release and all(classify(r) == "CANCELLED" for r in exp["rows"]):
        # Every shard acknowledged the barrier ABORT before release: no scheduled job started.
        if not exp["rows"]:
            exp["rows"] = [{"status": "cancelled", "task_status": None, "infra_failure": None, "attempts": 0,
                            "terminal_attempts": 0, "infra_attempts": 0, "synthetic": True}
                           for _ in range(exp["scheduled_total"])]
            exp["rows_source"] = abort[0]
        exp["rows_source"] = (exp["rows_source"] or abort[0]) + "; barrier ABORT acknowledged by every shard before release"
        exp["cancelled_before_release"] = True
    observed = result.get("observed_jobs") if isinstance(result, dict) else None
    if (not exp["rows"] and exp["scheduled_total"] and observed in (0, None)
            and barrier_never_released(coordination, outs)):
        # The coordinator never released the start barrier: every scheduled job stayed queued.
        exp["rows"] = [{"status": "queued", "task_status": None, "infra_failure": None, "attempts": 0,
                        "terminal_attempts": 0, "infra_attempts": 0, "synthetic": True}
                       for _ in range(exp["scheduled_total"])]
        exp["rows_source"] = "coordination.json barrier ABORT delivered to every shard before release"
        exp["never_started"] = True
    if not exp["rows"]:
        infra = [((s.get("infra") or {}).get("infra_true")) for s in statuses]
        if infra and all(isinstance(v, int) for v in infra):
            exp["infra_jobs"] = sum(infra)
    terminals = [t if isinstance(t, dict) else canonical_release(out / "export") for t, out in zip(terminals, outs)]
    released = [t for t in terminals if isinstance(t, dict) and t.get("status") in RELEASED_TERMINALS | {"CANONICAL_RELEASE_RECEIPT"}]
    failed = [t for t in terminals if isinstance(t, dict) and t not in released]
    exports = sum((out / "export/disposable-export.verified.json").exists() for out in outs)
    if coordination.get("released_at"):
        lifecycle_item(exp, "ok", "Global start barrier released", pacific(coordination["released_at"]))
    elif coordination.get("aborted_at") or abort:
        lifecycle_item(exp, "fail", "Global start barrier aborted",
                       str((abort or ("", "", coordination.get("abort_reason")))[2])[:140], issue=False)
    else:
        lifecycle_item(exp, "pending", "Global start barrier", "waiting for every shard cohort")
    if exp.get("cancelled_before_release"):
        lifecycle_item(exp, "ok", "No task started", f"barrier ABORT acknowledged by {len(acks)}/{controllers} shards before release")
    elif exp.get("never_started"):
        lifecycle_item(exp, "ok", "No task started", f"barrier ABORT delivered to {len(outs)}/{controllers} shards; never released")
    else:
        _job_lifecycle(exp, read_json(run_dir / "native-release-audit.json"), finished_after=coordination.get("finished_at"))
    statuses_seen = sorted({t.get("status") if t.get("status") != "CANONICAL_RELEASE_RECEIPT" else
                            "canonical release receipts (volume " + t["volume_disposition"] + ")" for t in released})
    lifecycle_item(exp, "ok" if len(released) == controllers else "fail" if failed else "pending",
                   "Controllers released", f"{len(released)}/{controllers} " + (" / ".join(statuses_seen) or "release receipts"))
    if not exp.get("cancelled_before_release"):
        lifecycle_item(exp, "ok" if exports == controllers else "pending" if not failed else "warn",
                       "Evidence exports verified", f"{exports}/{controllers} controller exports")
    if exp.get("cancelled_before_release"):
        pass
    elif isinstance(result, dict):
        lifecycle_item(exp, "ok", "Results recorded", "result.json")
        published = result.get("hub_group_final_published")
        reason = result.get("hub_group_final_error")
        lifecycle_item(exp, "ok" if published else "warn", "Hub group publication",
                       "final group published" if published else "final group NOT published"
                       + (f": {str(reason)[:160]}" if reason else ""))
    else:
        lifecycle_item(exp, "pending", "Results recorded", "result.json pending")
    finished = coordination.get("finished_at")
    exp["native_audit"] = bool(exp.pop("_audit_released", False))
    if abort or coordination.get("abort_reason") or coordination.get("terminate_reason"):
        exp["state"] = "ABORTED"
        exp["state_reason"] = (abort[2] if abort else coordination.get("abort_reason") or coordination.get("terminate_reason"))[:160]
        exp["ended_at"] = finished or (abort[1] if abort else None)
        exp["end_evidence"] = "coordination.finished_at" if finished else (abort[0] if abort else None)
    elif finished and isinstance(result, dict):
        exp["ended_at"], exp["end_evidence"] = finished, "coordination.finished_at"
        gaps = [i for i in exp["lifecycle"] if i["state"] in ("fail", "warn", "pending")]
        exp["state"] = "INCOMPLETE" if gaps else "COMPLETE"
        if result.get("missing_jobs"):
            exp["state"], exp["state_reason"] = "FAILED", f"{result['missing_jobs']} scheduled jobs without results"
    elif finished:
        exp["state_reason"] = "runners joined; operator writing result.json"
    finish = finish_experiment(exp)
    if finish["infra_breached"] and finish["state"] in ("COMPLETE", "INCOMPLETE"):
        finish["state"], finish["state_reason"] = "FAILED", "infra stop threshold reached"
    if finish["state"] == "INCOMPLETE" and not finish["state_reason"]:
        gaps = [i["label"] for i in finish["lifecycle"] if i["state"] != "ok"]
        finish["state_reason"] = "ended; open: " + ", ".join(gaps)
    return finish


def _rows_from_aggregate(result: dict) -> list[dict]:
    """Rows reconstructed only from result.json's recorded counts (history, no archives)."""
    status = dict(result.get("task_status") or {})
    infra = result.get("infra_failures") or 0
    rows = []
    rows += [{"status": "passed", "task_status": "PASSED", "infra_failure": False}] * status.pop("PASSED", 0)
    rows += [{"status": "failed", "task_status": "FAILED", "infra_failure": False}] * status.pop("FAILED", 0)
    infra_error = status.pop("INFRA_ERROR", 0)
    rows += [{"status": "failed", "task_status": "INFRA_ERROR", "infra_failure": True}] * max(infra, infra_error)
    other = sum(status.values()) - max(0, infra - infra_error)
    rows += [{"status": "failed", "task_status": None, "infra_failure": None}] * max(0, other)
    rows = [dict(r) for r in rows]
    # Only the recorded totals exist here; they set how many rows count as released/verified.
    for key, field in (("resources_released", "released"), ("lifecycle_verified", "lifecycle")):
        if isinstance(result.get(key), int):
            for index, row in enumerate(rows):
                row[field] = index < result[key]
    return rows


def load(run_dir: Path, deep: bool = True) -> dict:
    run_dir = Path(run_dir).absolute()
    if (run_dir / "coordination.json").exists():
        return load_sharded(run_dir, deep)
    if (run_dir / "summary.json").exists() and (read_json(run_dir / "summary.json") or {}).get("jobs") is not None:
        return load_campaign(run_dir)
    if (run_dir / "_batch/report-card.json").exists() or (run_dir / "report-card.json").exists():
        return load_fleet(run_dir)
    abort = read_json(run_dir / "preallocation-abort.json")
    if isinstance(abort, dict) and abort.get("allocated") is False:  # sharded launch refused before any Machine
        exp = empty_experiment("sharded", run_dir)
        exp["triggered_at"] = (read_json(run_dir / "admission-intent.private.json") or {}).get("started_at_epoch")
        exp["state"], exp["state_reason"] = "ABORTED", str(abort.get("reason") or "aborted before allocation")[:160]
        exp["ended_at"], exp["end_evidence"] = abort.get("ended_at"), "preallocation-abort.json"
        lifecycle_item(exp, "ok", "No Machine allocated", "launch aborted before capacity admission")
        return finish_experiment(exp)
    exp = empty_experiment("unknown", run_dir)
    exp["state"], exp["state_reason"] = "UNRECORDED", "no recorded benchmark artifacts in this directory"
    lifecycle_item(exp, "warn", "Recorded artifacts", "none found")
    return finish_experiment(exp)


# ------------------------------------------------------------- whole card

def build(run_dir: Path, *, ledger: Path | None = None, goal: str | None = None, agents=None, issues=None,
          now: float | None = None, deep: bool = True) -> dict:
    now = time.time() if now is None else now
    exp = load(run_dir, deep)
    entries = ledger_mod.read(ledger)
    every = ledger_mod.experiments(entries)
    mine = next((e for e in every if e["id"] == exp["id"] or e.get("run_dir") == exp["run_dir"]), None)
    goal = goal or (mine or {}).get("goal")
    for key in ("label", "tasks", "runs", "source_ref", "task_ref", "surface"):
        if exp.get(key) is None and mine and mine.get(key) is not None:
            exp[key] = mine[key]
    if exp.get("label") is None:
        exp["label"] = (mine or {}).get("slice") or exp["id"]
    history_entries = ledger_mod.experiments(entries, goal) if goal else ([mine] if mine else [])
    number = next((e["number"] for e in history_entries if mine and e["id"] == mine["id"]), None)
    rate = ledger_mod.launch_rate(history_entries, now) if history_entries else None
    history = []
    for entry in reversed(history_entries):
        if len(history) == 3:
            break
        if mine and entry["id"] == mine["id"]:
            item = dict(exp, number=entry["number"])
        else:
            path = Path(entry.get("run_dir") or "")
            item = load(path, deep=False) if entry.get("run_dir") and path.exists() else _from_ledger(entry)
            item["number"] = entry["number"]
            item["label"] = entry.get("slice") or item.get("label") or entry["id"]
        history.append(_history_row(item))
    if not mine:
        history.insert(0, _history_row(dict(exp, number=None)))
        history = history[:3]
    ended = [(h["ended_at"], h["label"]) for h in history if h.get("ended_at")]
    since = None
    if exp["state"] == "RUNNING":
        since = {"state": "RUNNING"}
    elif ended:
        at, label = max(ended)
        since = {"state": "ENDED", "label": label, "at": at, "age": now - at}
    elif exp.get("ended_at") is None:
        since = {"state": "END UNRECORDED"}
    exp_issues = _issues(exp) + [i for i in (issues or []) if isinstance(i, dict) and i.get("text")]
    agents = [a for a in (agents or []) if isinstance(a, dict) and a.get("name")]
    return {"format": FORMAT, "generated_at": now, "goal": goal, "number": number, "rate": rate,
            "since": since, "experiment": exp, "history": history, "agents": agents,
            "agents_blocking": any(a.get("blocking") for a in agents), "issues": exp_issues,
            "in_ledger": bool(mine)}


def _from_ledger(entry: dict) -> dict:
    exp = empty_experiment(entry.get("kind") or "unknown", Path(entry.get("run_dir") or entry["id"]))
    exp["id"] = entry["id"]
    exp["triggered_at"] = entry.get("triggered_at")
    end = entry.get("end") or {}
    exp["ended_at"] = end.get("ended_at")
    exp["state"] = end.get("state") or "RUNNING"
    exp["scheduled_total"] = entry.get("scheduled_total")
    outcome = end.get("outcome") or {}
    if isinstance(outcome.get("task_status"), dict):
        exp["rows"] = _rows_from_aggregate(outcome)
        exp["rows_source"] = "experiments ledger"
    return finish_experiment(exp)


def _history_row(exp: dict) -> dict:
    keys = ("number", "id", "label", "state", "state_reason", "triggered_at", "ended_at", "scheduled_total",
            "progress", "outcomes", "scored", "terminal_attempts", "infra_attempts", "infra_jobs", "cost",
            "harness_classified", "released", "rows_source", "end_evidence", "cancelled_before_release",
            "never_started")
    return {k: exp.get(k) for k in keys}


def _issues(exp: dict) -> list[dict]:
    out = []
    if exp["infra_breached"]:
        out.append({"severity": "red", "text": f"Infra stop threshold reached: {exp['infra_jobs']}/{exp['scheduled_total']} "
                    f"unique jobs (stop at {exp['infra_threshold']}).", "owner": "parent",
                    "action": "stop the exact owned run; /RCA each infra cluster"})
    elif exp.get("infra_jobs"):
        out.append({"severity": "amber", "text": f"{exp['infra_jobs']} infra-failed job(s) below the stop threshold.",
                    "owner": "parent", "action": "/RCA the first authentic failure now"})
    if exp.get("unknown_jobs"):
        out.append({"severity": "amber", "text": "No recorded task result: "
                    + ", ".join(job or "job ID UNRECORDED" for job in exp["unknown_jobs"]) + ".",
                    "owner": "parent", "action": "/RCA from the job log and controller receipts"})
    if exp.get("unreleased_jobs") and not exp.get("native_audit"):
        out.append({"severity": "amber", "text": "Release unverified: "
                    + ", ".join(job or "job ID UNRECORDED" for job in exp["unreleased_jobs"]) + ".",
                    "owner": "parent", "action": "native exact-owner audit before the next launch"})
    for item in exp["lifecycle"]:
        if item["state"] == "fail" and item.get("issue", True):
            out.append({"severity": "red", "text": f"{item['label']}: {item['detail']}.", "owner": "parent",
                        "action": "exact-owner recovery through the printed CLI"})
        elif item["state"] == "warn" and item.get("issue", True) and not item["label"].startswith("Guests released"):
            out.append({"severity": "amber", "text": f"{item['label']}: {item['detail']}.", "owner": "parent",
                        "action": "reconcile from the recorded receipts before the next launch"})
    return out


# ---------------------------------------------------------------- HTML

CSS = """
:root{color-scheme:light dark;--fg:light-dark(#1f2328,#e6edf3);--muted:light-dark(#59636e,#9198a1);
--line:light-dark(#d1d9e0,#3d444d);--tile:light-dark(#f6f8fa,#151b23);--ok:light-dark(#1a7f37,#3fb950);
--bad:light-dark(#cf222e,#ff7b72);--run:light-dark(#0969da,#58a6ff);--warn:light-dark(#9a6700,#d29922);
--na:light-dark(#6e7781,#8b949e);--agent:light-dark(#bc4c00,#f0883e);--harness:light-dark(#8250df,#bc8cff);
font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg)}
:root[data-theme=light]{color-scheme:light}:root[data-theme=dark]{color-scheme:dark}
body{margin:0;padding:12px;background:transparent}main{max-width:760px;margin:0 auto}
section{margin:0 0 14px}h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--run);margin:0 0 6px;font-weight:650}
.ok{color:var(--ok)}.bad{color:var(--bad)}.run{color:var(--run)}.warn{color:var(--warn)}.na{color:var(--na)}
.agent{color:var(--agent)}.harness{color:var(--harness)}.muted{color:var(--muted)}
.title{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline;font-size:19px;font-weight:700}
.badge{font-size:13px;font-weight:700;padding:1px 8px;border:1px solid currentColor;border-radius:999px}
.sub{color:var(--muted);font-size:13px;overflow-wrap:anywhere}.sub b{color:var(--fg)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.tile{background:var(--tile);border:1px solid var(--line);border-radius:10px;padding:8px 10px;min-width:0}
.tile .k{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.tile .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.2}
.tile .s{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.bar{display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--line)}
.bar.mini{height:8px;border-radius:4px;flex:1 1 120px;max-width:220px}
.seg{display:block;height:100%}.seg.ok{background:var(--ok)}.seg.bad{background:var(--bad)}.seg.warn{background:var(--warn)}
.seg.na{background:var(--na)}.seg.agent{background:var(--agent)}.seg.harness{background:var(--harness)}.seg.run{background:var(--run)}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;font-size:13px;font-variant-numeric:tabular-nums}
.legend span{white-space:nowrap}.note{font-size:12px;color:var(--muted);margin-top:4px}
.causes{display:grid;grid-template-columns:auto minmax(40px,90px) minmax(0,1fr);gap:3px 8px;align-items:center;font-size:13px}
.causes .n{font-weight:700;text-align:right;font-variant-numeric:tabular-nums}.causes .t,.clip{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.causes .meter{height:6px;border-radius:3px;background:var(--line);overflow:hidden}.causes .meter i{display:block;height:100%}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0;font-size:13px}dt{color:var(--muted)}
dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
ul{list-style:none;margin:0;padding:0;font-size:13px}li{margin:2px 0;overflow-wrap:anywhere}
.hist{border-top:1px solid var(--line);padding:6px 0;font-size:13px}.hist:first-of-type{border-top:0}
.hist .l1{display:flex;flex-wrap:wrap;gap:2px 10px;font-weight:650}.hist .l2,.hist .l3{color:var(--muted);overflow-wrap:anywhere}
.hist .l3{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}
.agents{display:grid;grid-template-columns:1fr auto auto auto;gap:2px 10px;font-size:13px;font-variant-numeric:tabular-nums}
.agents .h{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}.agents .life{text-align:right}
.agents .why{grid-column:1/-1;color:var(--bad);font-size:12px;padding-left:18px}
@media (max-width:420px){.causes{grid-template-columns:auto 36px minmax(0,1fr)}.tile .v{font-size:20px}}
footer{border-top:1px solid var(--line);padding-top:8px;font-weight:650}
.gen{font-size:11px;color:var(--muted);font-weight:400;margin-top:4px}
"""


def e(value) -> str:
    # Recorded prose may carry an em dash, which the card contract reserves as an empty sentinel.
    return html.escape(str(value).replace("\u2014", "-"), quote=True)


def _span(cls, text):
    return f'<span class="{cls}">{e(text)}</span>'


def _bar(outcomes: dict | None, total: int | None, mini=False, label="outcomes") -> str:
    if not outcomes or not total:
        return f'<div class="bar{" mini" if mini else ""}" role="img" aria-label="{e(label)}: no terminal outcomes"></div>'
    parts, aria = [], []
    for category in CATEGORIES:
        count = outcomes.get(category) or 0
        if count:
            parts.append(f'<i class="seg {CATEGORY_CLASS[category]}" style="width:{100.0 * count / total:.3f}%"></i>')
            aria.append(f"{category} {count}")
    rest = total - sum(outcomes.get(c) or 0 for c in CATEGORIES)
    if rest > 0:
        aria.append(f"not terminal {rest}")
    return (f'<div class="bar{" mini" if mini else ""}" role="img" aria-label="{e(label)}: {e(", ".join(aria))} of {total}">'
            + "".join(parts) + "</div>")


def _harness(exp) -> tuple[str, str]:
    if exp.get("outcomes") is None:
        return "UNMEASURED", "warn"
    count = exp["outcomes"]["HARNESS"]
    if count:
        return str(count), "bad"
    return ("0", "ok") if exp.get("harness_classified") else ("UNCLASSIFIED", "warn")


def _infra_text(exp) -> tuple[str, str, str]:
    attempts, infra = exp.get("terminal_attempts"), exp.get("infra_attempts")
    if not attempts:
        jobs = exp.get("infra_jobs")
        if isinstance(jobs, int) and not exp.get("outcomes"):
            return f"{jobs} jobs", "bad" if jobs else "ok", "live infra counter; NO TERMINAL ATTEMPTS"
        return "NO TERMINAL ATTEMPTS", "na", ""
    cls = "bad" if exp.get("infra_breached") else "warn" if infra else "ok"
    return pct(infra, attempts), cls, f"{infra}/{attempts} terminal attempts"


def _rate_text(card) -> str:
    """experiments/day for the goal; ``warming`` until the goal clock spans RATE_MIN_DAYS."""
    rate = card.get("rate")
    if not rate:
        return "experiments/day UNRECORDED (no ledger launch)"
    launches = f'{rate["launches"]} launch{"es" if rate["launches"] != 1 else ""}'
    if rate.get("warming"):
        age = duration(card["generated_at"] - rate["goal_started_at"])
        return f'experiments/day warming {age} · {launches} (rate after {ledger_mod.RATE_MIN_DAYS:g} d)'
    return (f'{rate["per_day"]:.1f} experiments/day · {launches} / {rate["days"]:.2f} d'
            + (" (lower bound)" if rate.get("backfilled") else ""))


def render_html(card: dict) -> str:
    exp = card["experiment"]
    state = exp["state"]
    number = f"#{card['number']}" if card.get("number") else "# UNRECORDED"
    o = exp.get("outcomes")
    total = exp.get("scheduled_total") or 0
    rate = card.get("rate")
    surface = exp.get("surface") or "cloud"
    shape = (f"{exp['tasks']} tasks × {exp['runs']} run{'s' if exp['runs'] != 1 else ''}"
             if exp.get("tasks") and exp.get("runs") else f"{total} scheduled" if total else "scheduled UNRECORDED")
    out = ['<!doctype html><html lang="en"><head><meta charset="utf-8">',
           '<meta name="viewport" content="width=device-width,initial-scale=1">',
           f'<meta name="generator" content="{GENERATOR}"><title>{e(exp["label"])} scorecard</title>',
           f"<style>{CSS}</style></head><body><main>"]
    # Header
    since = card.get("since") or {}
    since_html = (_span("run", "RUNNING") if since.get("state") == "RUNNING" else
                  f'<b>{e(duration(since["age"]))}</b> ago · {e(since["label"])} ended {e(pacific(since["at"]))}'
                  if since.get("state") == "ENDED" else _span("warn", "END UNRECORDED"))
    rate_html = (_span("warn", _rate_text(card)) if not rate or rate.get("warming") else
                 f'<b>{rate["per_day"]:.1f}</b> ' + e(_rate_text(card).split(" ", 1)[1]))
    goal_elapsed = (f' · goal elapsed {e(duration(card["generated_at"] - rate["goal_started_at"]))}' if rate else "")
    out.append('<section data-section="header"><div class="title">'
               f'<span>🧪 Experiment {e(number)}</span>'
               f'<span class="badge {STATE_CLASS[state]}">{STATE_ICON[state]} {e(state)}</span></div>'
               f'<div class="sub"><b>{e(exp["label"])}</b> · {e(shape)} · {e(surface)} · src {e(short_ref(exp.get("source_ref")))}'
               + (f' · tasks {e(short_ref(exp["task_ref"]))}' if exp.get("task_ref") else "") + "</div>"
               f'<div class="sub">Triggered {e(pacific(exp.get("triggered_at")))}{goal_elapsed}</div>'
               f'<div class="sub">{rate_html}</div>'
               f'<div class="sub">Since last benchmark ended: {since_html}</div></section>')
    # KPI tiles
    scored = exp.get("scored")
    pass_value = pct(o["PASS"], scored) if o and scored else "NO SCORED TASKS" if o else "UNMEASURED"
    pass_rate = o["PASS"] / scored if o and scored else None
    pass_cls = "na" if pass_rate is None else "ok" if pass_rate >= 0.9 else "warn" if pass_rate >= 0.5 else "bad"
    pass_sub = f'{o["PASS"]}/{scored} scored' if o and scored else "PASS + AGENT FAIL denominator"
    infra_value, infra_cls, infra_sub = _infra_text(exp)
    progress = exp.get("progress")
    if progress:
        prog_value = f'{progress["completed"]}/{total}' if total else str(progress["completed"])
        prog_sub = f'Q {progress["queued"]} · IP {progress["in_progress"]} · C {progress["completed"]}' + (
            f' · unobserved {progress["unobserved"]}' if progress["unobserved"] else "")
        prog_cls = "ok" if total and progress["completed"] == total else "run"
        if exp.get("never_started"):
            prog_sub, prog_cls = prog_sub + " · never started", "na"
    else:
        prog_value, prog_sub, prog_cls = "UNMEASURED", "no job records yet", "warn"
    end_or_now = exp.get("ended_at") or (card["generated_at"] if state == "RUNNING" else None)
    elapsed = duration(end_or_now - exp["triggered_at"]) if end_or_now and exp.get("triggered_at") else "UNMEASURED"
    window = f'exec window {duration(exp["window_s"])}' if exp.get("window_s") else "exec window UNRECORDED"
    threshold = exp.get("infra_threshold")
    out.append('<section data-section="kpis"><div class="kpis">'
               f'<div class="tile"><div class="k">✅ Pass</div><div class="v {pass_cls}">{e(pass_value)}</div><div class="s">{e(pass_sub)}</div></div>'
               f'<div class="tile"><div class="k">🧯 Infra</div><div class="v {infra_cls}">{e(infra_value)}</div>'
               f'<div class="s">{e(infra_sub)}{" · " if infra_sub else ""}stop at {e(threshold if threshold else "UNRECORDED")}</div></div>'
               f'<div class="tile"><div class="k">📦 Progress</div><div class="v {prog_cls}">{e(prog_value)}</div><div class="s">{e(prog_sub)}</div></div>'
               f'<div class="tile"><div class="k">⏱ Elapsed</div><div class="v {"run" if state == "RUNNING" else ""}">{e(elapsed)}</div>'
               f'<div class="s">{e(window)}</div></div></div></section>')
    # Outcomes
    harness_text, harness_cls = _harness(exp)
    legend = []
    for category in CATEGORIES:
        count = (o or {}).get(category, 0)
        always = category in ("PASS", "HARNESS", "INFRA")
        if not always and not count:
            continue
        if category == "HARNESS":
            legend.append(f'<span class="{harness_cls}">■ HARNESS {e(harness_text)}</span>')
            continue
        value = f"{count} · {pct(count, total)}" if o and total else "UNMEASURED"
        cls = "warn" if not o else "ok" if category == "INFRA" and not count else CATEGORY_CLASS[category]
        legend.append(f'<span class="{cls}">■ {category} {e(value)}</span>')
    pending = (progress["queued"] + progress["in_progress"] + progress["unobserved"]) if progress else 0
    if pending:
        legend.append(f'<span class="na">■ never started {pending}</span>' if exp.get("never_started")
                      else f'<span class="run">■ not terminal {pending}</span>')
    stop_note = (f'Stop at {threshold}/{total} unique infra-failed jobs (5% of scheduled); now {exp["infra_jobs"]}.'
                 if threshold and isinstance(exp.get("infra_jobs"), int) else
                 f"Stop at {threshold}/{total} unique infra-failed jobs (5% of scheduled)." if threshold
                 else "Stop at 5% of the original scheduled total; scheduled total UNRECORDED.")
    source = f' Source: {e(exp["rows_source"])}.' if exp.get("rows_source") else ""
    out.append(f'<section data-section="outcomes"><h2>Outcomes</h2>{_bar(o, total)}'
               f'<div class="legend">{"".join(legend)}</div><div class="note">{e(stop_note)}{source}</div></section>')
    # Failure causes
    reasons = exp.get("reasons") or []
    if reasons:
        top = max(r[2] for r in reasons)
        rows = "".join(f'<span class="n {CATEGORY_CLASS[cat]}">{count}</span>'
                       f'<span class="meter"><i class="seg {CATEGORY_CLASS[cat]}" style="width:{100.0 * count / top:.1f}%"></i></span>'
                       f'<span class="t" title="{e(text)}">{e(text)}</span>' for cat, text, count in reasons)
        more = f'<div class="note">+{exp["reasons_more"]} more in other causes.</div>' if exp.get("reasons_more") else ""
        out.append(f'<section data-section="causes"><h2>Failure causes</h2><div class="causes">{rows}</div>{more}</section>')
    else:
        text = "No failed or unclassified jobs." if o else "No terminal job records yet."
        out.append(f'<section data-section="causes"><h2>Failure causes</h2><div class="note">{e(text)}</div></section>')
    # Timing / cost / cache / llm
    wall, execs, cost, cache = exp.get("wall"), exp.get("exec"), exp.get("cost"), exp.get("cache")
    timing = [("Triggered", e(pacific(exp.get("triggered_at"))))]
    if exp.get("released_at"):
        timing.append(("Released", e(pacific(exp["released_at"]))))
    timing.append(("Ended", _span("run", "RUNNING") if state == "RUNNING" and not exp.get("ended_at")
                   else e(pacific(exp["ended_at"])) if exp.get("ended_at") else _span("warn", "END UNRECORDED")))
    timing.append(("Wall / job", f'p50 {e(duration(wall["p50"]))} · max {e(duration(wall["max"]))} · {wall["n"]}/{wall["of"]} jobs'
                   if wall else _span("warn", "UNMEASURED")))
    timing.append(("Execution", f'p50 {e(duration(execs["p50"]))} · p95 {e(duration(execs["p95"]))} · {execs["n"]}/{execs["of"]} tasks'
                   if execs else _span("warn", "UNMEASURED")))
    if cost and cost.get("metered_usd") is not None:
        unmetered = " · " + _span("warn", " / ".join(cost["unmetered"]) + " UNMETERED") if cost["unmetered"] else ""
        timing.append(("💲 Cost", f'{e(money(cost["metered_usd"]))} agent LLM metered · {cost["n"]}/{cost["of"]} runs{unmetered}'))
    else:
        timing.append(("💲 Cost", _span("warn", "UNMETERED")))
    timing.append(("Cache", f'agent fast-cache hit avg {cache["avg"] * 100:.0f}% · {cache["n"]}/{cache["of"]} runs'
                   if cache else _span("warn", "UNMEASURED")))
    timing.append(("LLM latency", _span("warn", "UNMEASURED")))
    out.append('<section data-section="timing"><h2>Timing · Cost</h2><dl>'
               + "".join(f"<dt>{k}</dt><dd>{v}</dd>" for k, v in timing) + "</dl></section>")
    # Lifecycle
    items = "".join(f'<li class="{ {"ok": "ok", "fail": "bad", "warn": "warn", "pending": "run"}[i["state"]] }">'
                    f'{LIFE_ICON[i["state"]]} {e(i["label"])}' + (f' <span class="muted">· {e(i["detail"])}</span>' if i["detail"] else "")
                    + "</li>" for i in exp["lifecycle"])
    out.append(f'<section data-section="lifecycle"><h2>Lifecycle</h2><ul>{items}</ul></section>')
    agents_html = _agents_html(card)
    if card.get("agents_blocking"):
        out.append(agents_html)
    out.append(_history_html(card))
    if not card.get("agents_blocking"):
        out.append(agents_html)
    issues = card.get("issues") or []
    if issues:
        lis = "".join(
            f'<li class="{ {"red": "bad", "amber": "warn", "blue": "run", "green": "ok"}.get(i.get("severity"), "warn") }">'
            f'{ {"red": "🔴", "amber": "🟠", "blue": "🔵", "green": "✅"}.get(i.get("severity"), "🟠") } {e(i["text"])}'
            + (f' <span class="muted">· owner {e(i["owner"])}' + (f' → {e(i["action"])}' if i.get("action") else "") + "</span>"
               if i.get("owner") else "") + "</li>" for i in issues)
    else:
        lis = '<li class="ok">✅ No open issues recorded.</li>'
    out.append(f'<section data-section="issues"><h2>ISSUES / NEXT ACTION</h2><ul>{lis}</ul></section>')
    reason = exp.get("state_reason") or {"RUNNING": "observe every 30s; card every 15 min", "COMPLETE": "results final, resources released"}.get(state, "")
    out.append(f'<footer data-section="footer"><span class="{STATE_CLASS[state]}">{STATE_ICON[state]} {e(state)}</span>'
               + (f" · {e(reason)}" if reason else "") +
               f'<div class="gen">Rendered by scripts/run-bench scorecard ({FORMAT}) at {e(pacific(card["generated_at"]))} from recorded artifacts.</div></footer>')
    data = json.dumps(_public(card), sort_keys=True, allow_nan=False).replace("</", "<\\/")
    out.append(f'</main><script type="application/json" id="scorecard-data">{data}</script></body></html>\n')
    return "".join(out)


def _public(card):
    exp = {k: v for k, v in card["experiment"].items() if k not in ("unknown_jobs", "unreleased_jobs")}
    return dict(card, experiment=exp)


def _agents_html(card) -> str:
    agents = card.get("agents") or []
    if not agents:
        body = '<div class="note">No active agents</div>'
    else:
        cells = ['<span class="h">Agent / work</span><span class="h">Tokens</span><span class="h">15m tok/min</span><span class="h life">Life</span>']
        for a in agents:
            icon = a.get("status") or ("⛔" if a.get("blocking") else "🔄")
            tokens = compact(a.get("tokens")) if isinstance(a.get("tokens"), (int, float)) else "UNMETERED"
            if isinstance(a.get("rate_15m"), (int, float)):
                rate = compact(a["rate_15m"]) + "/min"
            elif isinstance(a.get("warming_s"), (int, float)):
                rate = "warming " + duration(a["warming_s"])
            else:
                rate = a.get("rate_label") if a.get("rate_label") in ("complete",) else "UNMETERED"
            life = duration(a["life_s"]) if isinstance(a.get("life_s"), (int, float)) else (
                duration(card["generated_at"] - a["started_at"]) if isinstance(a.get("started_at"), (int, float)) else "UNMEASURED")
            red = icon in ("⛔", "🚨")
            cls = "bad" if red else "ok" if icon == "✅" else "run"
            cells.append(f'<span class="{cls}">{e(icon)} {e(a["name"])}' + (f' / {e(a["work"])}' if a.get("work") else "") + "</span>"
                         f'<span class="{"warn" if tokens == "UNMETERED" else ""}">{e(tokens)}</span>'
                         f'<span class="{"warn" if rate == "UNMETERED" else ""}">{e(rate)}</span><span class="life">{e(life)}</span>')
            if red:
                cells.append(f'<span class="why">{e(a.get("blocker") or "blocker UNRECORDED")} · owner/action: {e(a.get("action") or "UNRECORDED")}</span>')
        body = f'<div class="agents">{"".join(cells)}</div>'
    return f'<section data-section="agents"><h2>ACTIVE SUB-AGENTS / PARENT</h2>{body}</section>'


def _history_html(card) -> str:
    blocks = []
    for h in card.get("history") or []:
        state = h["state"]
        number = f"#{h['number']}" if h.get("number") else "#?"
        end_or_now = h.get("ended_at") or (card["generated_at"] if state == "RUNNING" else None)
        elapsed = duration(end_or_now - h["triggered_at"]) if end_or_now and h.get("triggered_at") else "UNMEASURED"
        end = ("RUNNING" if state == "RUNNING" and not h.get("ended_at") else pacific(h["ended_at"], date=False)
               if h.get("ended_at") else "END UNRECORDED")
        o, total = h.get("outcomes"), h.get("scheduled_total")
        if o:
            scored = h.get("scored") or 0
            attempts = h.get("terminal_attempts") or 0
            pass_text = f'PASS {o["PASS"]}/{scored} ({pct(o["PASS"], scored)})' if scored else "NO SCORED TASKS"
            infra_text = (f'INFRA {h.get("infra_attempts") or 0}/{attempts}' if attempts else "NO TERMINAL ATTEMPTS")
            harness = "HARNESS " + (str(o["HARNESS"]) if o["HARNESS"] or h.get("harness_classified") else "UNCLASSIFIED")
            extra = [f"{c.lower()} {o[c]}" for c in ("AGENT FAIL", "UNKNOWN", "CANCELLED", "SKIPPED") if o.get(c)]
            if h.get("cancelled_before_release"):
                extra = [f'{o["CANCELLED"]} cancelled before release']
            stats = " · ".join(extra[:1] + [pass_text, harness, infra_text] + extra[1:]
                               if h.get("cancelled_before_release") else [pass_text, harness, infra_text] + extra)
        else:
            stats = "PASS UNMEASURED · HARNESS UNMEASURED · INFRA UNMEASURED"
        prog = h.get("progress")
        prog_text = (f'Q {prog["queued"]} · IP {prog["in_progress"]} · C {prog["completed"]}/{total}'
                     + (" · never started" if h.get("never_started") else "") if prog and total else "progress UNMEASURED")
        cost = h.get("cost") or {}
        cost_text = f'💲 {money(cost["metered_usd"])} metered' if cost.get("metered_usd") is not None else "💲 UNMETERED"
        blocks.append(f'<div class="hist"><div class="l1"><span>{e(number)}</span><span class="{STATE_CLASS[state]}">'
                      f'{STATE_ICON[state]} {e(state)}</span><span>{e(h["label"])}</span><span class="muted">{e(elapsed)}</span></div>'
                      f'<div class="l2">{e(pacific(h.get("triggered_at")))} → {e(end)} · {e(prog_text)} · {e(cost_text)}</div>'
                      f'<div class="l3">{_bar(o, total, mini=True, label=str(number) + " outcomes")}<span>{e(stats)}</span></div>'
                      + (f'<div class="l2 clip" title="{e(h["state_reason"])}">{e(h["state_reason"])}</div>'
                         if h.get("state_reason") and state != "COMPLETE" else "")
                      + "</div>")
    if not blocks:
        blocks.append('<div class="note">No launched experiments recorded.</div>')
    return f'<section data-section="history"><h2>LAST 3 EXPERIMENTS</h2>{"".join(blocks)}</section>'


# ---------------------------------------------------------------- text

def render_text(card: dict) -> str:
    exp = card["experiment"]
    o = exp.get("outcomes")
    total = exp.get("scheduled_total") or 0
    state = exp["state"]
    rate = card.get("rate")
    lines = [f'🧪 EXPERIMENT #{card["number"] or "UNRECORDED"} · {STATE_ICON[state]} {state}',
             f'{exp["label"]} · {total or "UNRECORDED"} scheduled · {exp.get("surface")} · src {short_ref(exp.get("source_ref"))}',
             f'Triggered {pacific(exp.get("triggered_at"))}',
             _rate_text(card)]
    since = card.get("since") or {}
    lines.append("Since last benchmark ended: " + ("RUNNING" if since.get("state") == "RUNNING" else
                 f'{duration(since["age"])} ({since["label"]})' if since.get("state") == "ENDED" else "END UNRECORDED"))
    prog = exp.get("progress")
    lines.append(f'QUEUED {prog["queued"]} · IN_PROGRESS {prog["in_progress"]} · COMPLETED {prog["completed"]}/{total}'
                 + (" · never started (start barrier aborted before release)" if exp.get("never_started") else "")
                 if prog else "QUEUED / IN_PROGRESS / COMPLETED UNMEASURED")
    harness, _ = _harness(exp)
    infra_value, _, infra_sub = _infra_text(exp)
    if o:
        scored = exp.get("scored") or 0
        lines.append((f'PASS {o["PASS"]}/{scored} {pct(o["PASS"], scored)} · ' if scored else "PASS 0 · NO SCORED TASKS · ")
                     + f'HARNESS {harness} · INFRA {infra_value}' + (f' ({infra_sub})' if infra_sub else ""))
        extra = [f"{c} {o[c]}" for c in ("AGENT FAIL", "UNKNOWN", "CANCELLED", "SKIPPED") if o.get(c)]
        if extra:
            lines.append(" · ".join(extra))
    else:
        lines.append(f"PASS UNMEASURED · HARNESS {harness} · INFRA {infra_value}")
    if exp.get("infra_threshold"):
        lines.append(f'Stop at {exp["infra_threshold"]}/{total} unique infra-failed jobs (5%)')
    for cat, text, count in exp.get("reasons") or []:
        lines.append(f"  {count:>4} {cat}: {text}")
    cost = exp.get("cost") or {}
    lines.append("Cost " + (f'{money(cost["metered_usd"])} metered ({cost["n"]}/{cost["of"]})' if cost.get("metered_usd") is not None else "UNMETERED")
                 + (" · " + "/".join(cost["unmetered"]) + " UNMETERED" if cost.get("unmetered") else ""))
    cache = exp.get("cache")
    lines.append("Cache " + (f'agent fast-cache avg {cache["avg"] * 100:.0f}% ({cache["n"]}/{cache["of"]})' if cache else "UNMEASURED")
                 + " · LLM latency UNMEASURED")
    lines.append("Lifecycle")
    lines += [f'  {LIFE_ICON[i["state"]]} {i["label"]}' + (f' · {i["detail"]}' if i["detail"] else "") for i in exp["lifecycle"]]
    lines.append("LAST 3 EXPERIMENTS")
    for h in card.get("history") or []:
        ho = h.get("outcomes") or {}
        lines.append(f'  #{h.get("number") or "?"} {STATE_ICON[h["state"]]} {h["state"]} {h["label"]} · '
                     f'{pacific(h.get("triggered_at"))} → '
                     + ("RUNNING" if h["state"] == "RUNNING" and not h.get("ended_at") else pacific(h["ended_at"], date=False) if h.get("ended_at") else "END UNRECORDED")
                     + ((f' · PASS {ho.get("PASS")}/{h.get("scored")}' if h.get("scored") else " · NO SCORED TASKS")
                        + (f' · INFRA {h.get("infra_attempts")}/{h.get("terminal_attempts")}' if h.get("terminal_attempts") else " · NO TERMINAL ATTEMPTS")
                        + (f' · {ho["CANCELLED"]} cancelled' if ho.get("CANCELLED") else "")
                        + (f' · {h["scheduled_total"]} never started' if h.get("never_started") else "") if ho else " · UNMEASURED"))
    lines.append("ACTIVE SUB-AGENTS / PARENT")
    lines += [f'  {a.get("status") or "🔄"} {a["name"]}' for a in card.get("agents") or []] or ["  No active agents"]
    lines.append("ISSUES / NEXT ACTION")
    lines += [f'  • {i["text"]}' + (f' Owner {i["owner"]}' + (f' → {i["action"]}' if i.get("action") else "") if i.get("owner") else "")
              for i in card.get("issues") or []] or ["  • No open issues recorded."]
    lines.append(f'{STATE_ICON[state]} {state}' + (f' · {exp["state_reason"]}' if exp.get("state_reason") else ""))
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------- validation

class _Collector(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.text, self.sections, self.styles, self.urls, self.meta, self._skip = [], [], [], [], {}, 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ("script", "style"):
            self._skip += 1
        if attrs.get("data-section"):
            self.sections.append(attrs["data-section"])
        if attrs.get("style"):
            self.styles.append(attrs["style"])
        for key in ("src", "href"):
            if attrs.get(key):
                self.urls.append(attrs[key])
        if tag == "meta" and attrs.get("name"):
            self.meta[attrs["name"]] = attrs.get("content", "")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if self._skip:
            if self.lasttag == "style":
                self.styles.append(data)
            return
        self.text.append(data)


def validate_html(raw: str) -> list[str]:
    """Problems that make a card non-compliant with FORMAT v8 (empty list = valid)."""
    parser = _Collector()
    parser.feed(raw)
    problems = []
    if parser.meta.get("generator") != GENERATOR:
        problems.append(f"not rendered by {GENERATOR} (hand-written cards are non-compliant)")
    missing = [s for s in REQUIRED_SECTIONS if s not in parser.sections]
    if missing:
        problems.append("missing sections: " + ", ".join(missing))
    text = " ".join(" ".join(parser.text).split())
    for label in REQUIRED_TEXT:
        if label not in text:
            problems.append(f"missing required field: {label}")
    for match in SENTINEL.finditer(text):
        problems.append(f"empty sentinel displayed: {match.group(0)!r} near {text[max(0, match.start() - 30):match.end() + 30]!r}")
    for url in parser.urls:
        if re.match(r"^(https?:)?//", url):
            problems.append(f"remote load: {url}")
    css = "\n".join(parser.styles)
    if re.search(r"@import|url\(\s*['\"]?(https?:)?//", css):
        problems.append("remote CSS load")
    for match in re.finditer(r"(?<![-\w])(min-width|width)\s*:\s*(\d+(?:\.\d+)?)px", css):
        if float(match.group(2)) > 360:
            problems.append(f"fixed {match.group(1)} {match.group(2)}px exceeds 360px")
    if "max-width:760px" not in css.replace(" ", ""):
        problems.append("content width is not capped at max-width:760px")
    if "data-theme" not in css or "light-dark(" not in css:
        problems.append("missing light/dark theme colors")
    if re.search(r"\b\d+(\.\d+)?vh\b", css):
        problems.append("vh units are not allowed")
    return problems


# ----------------------------------------------------------- instruction

def instruction_lines(run_dir) -> list[str]:
    run_dir = str(run_dir)
    card = run_dir.rstrip("/") + "/scorecard.html"
    return [
        "📊 Report progress ONLY with the CLI scorecard (FORMAT v8); hand-written cards are non-compliant:",
        f"    scripts/run-bench scorecard {run_dir} --html {card}",
        f'    dvb-onbox visuals publish --file {card} --title "<run label> scorecard"',
        "    Publish at start, every 15 minutes, on each state change and at completion.",
        "    Off boxes.dev or when HTML is unavailable, post: scripts/run-bench scorecard " + run_dir + " --text",
    ]


def print_instruction(run_dir, stream=None) -> None:
    for line in instruction_lines(run_dir):
        print(line, file=stream or sys.stdout, flush=True)


# ---------------------------------------------------------------- CLI

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="scripts/run-bench scorecard", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("run_dir", nargs="?", type=Path)
    parser.add_argument("--html", type=Path, help="write the self-contained HTML card here")
    parser.add_argument("--text", action="store_true", help="print the plain-text fallback")
    parser.add_argument("--json", action="store_true", help="print the normalized card data")
    parser.add_argument("--agents", type=Path, help="JSON list of active sub-agent rows")
    parser.add_argument("--issues", type=Path, help="JSON list of {text, owner, action, severity}")
    parser.add_argument("--ledger", type=Path, help="experiments ledger (default: git-common)")
    parser.add_argument("--goal", help="experiment goal for numbering and history")
    parser.add_argument("--now", type=float, help=argparse.SUPPRESS)
    parser.add_argument("--shallow", action="store_true", help="skip reading verified export archives")
    parser.add_argument("--validate", type=Path, metavar="HTML", help="check a card against FORMAT v8")
    parser.add_argument("--instruction", type=Path, metavar="RUN_DIR", help="print the mandatory reporting instruction")
    args = parser.parse_args(argv)
    if args.instruction:
        print_instruction(args.instruction)
        return 0
    if args.validate:
        try:
            problems = validate_html(args.validate.read_text())
        except OSError as error:
            problems = [f"unreadable card: {error}"]
        print(json.dumps({"valid": not problems, "problems": problems}, indent=1))
        return 0 if not problems else 1
    if args.run_dir is None or not args.run_dir.is_dir():
        parser.error("an existing <run-dir> is required")
    agents = read_json(args.agents) if args.agents else None
    issues = read_json(args.issues) if args.issues else None
    card = build(args.run_dir, ledger=args.ledger or ledger_mod.ledger_path(HERE.parent), goal=args.goal,
                 agents=agents if isinstance(agents, list) else None,
                 issues=issues if isinstance(issues, list) else None, now=args.now, deep=not args.shallow)
    if args.html:
        document = render_html(card)
        problems = validate_html(document)
        args.html.parent.mkdir(parents=True, exist_ok=True)
        args.html.write_text(document)
        print(json.dumps({"html": str(args.html.absolute()), "valid": not problems, "problems": problems,
                          "publish": f'dvb-onbox visuals publish --file {args.html.absolute()} --title "{card["experiment"]["label"]} scorecard"'}))
        if problems:
            return 1
    if args.json:
        print(json.dumps(_public(card), indent=1, sort_keys=True))
    if args.text or not (args.html or args.json):
        sys.stdout.write(render_text(card))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
