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
import runpy
import os
import html
import hashlib
import json
import math
import re
import subprocess
import shlex
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
import cloudbench_global_progress as global_mod

FORMAT = "v8"
GENERATOR = "cloudbench-scorecard " + FORMAT
TERMINAL_JOB = {"passed", "failed", "cancelled", "skipped"}
CATEGORIES = ("PASS", "AGENT FAIL", "HARNESS", "INFRA", "UNKNOWN", "CANCELLED", "SKIPPED")
CATEGORY_CLASS = {"PASS": "ok", "AGENT FAIL": "agent", "HARNESS": "harness", "INFRA": "bad",
                  "UNKNOWN": "warn", "CANCELLED": "na", "SKIPPED": "na"}
STATE_ICON = {"RUNNING": "🔵", "COMPLETE": "✅", "FAILED": "🔴", "ABORTED": "🔴", "HELD": "⏸",
              "INCOMPLETE": "🟠", "NOT LAUNCHED": "⚪", "UNRECORDED": "🟠", "CONTROLLER LOST": "🔴",
              "UNVERIFIED": "🟠"}
STATE_CLASS = {"RUNNING": "run", "COMPLETE": "ok", "FAILED": "bad", "ABORTED": "bad", "HELD": "warn",
               "INCOMPLETE": "warn", "NOT LAUNCHED": "na", "UNRECORDED": "warn", "CONTROLLER LOST": "bad",
               "UNVERIFIED": "warn"}
# Non-terminal states whose recorded controller is not verified alive: never RUNNING.
UNLIVE = {"CONTROLLER LOST": "INTERRUPTED/UNRECONCILED", "UNVERIFIED": "IN_PROGRESS (UNVERIFIED)"}
LIFE_ICON = {"ok": "✅", "fail": "🔴", "warn": "🟠", "pending": "🔵"}
REQUIRED_SECTIONS = ("header", "kpis", "outcomes", "causes", "timing", "lifecycle", "history",
                     "agents", "issues", "footer")
REQUIRED_TEXT = ("Experiment #", "experiments/day", "Since last benchmark ended", "PASS", "HARNESS",
                 "INFRA", "Stop at", "EXPERIMENTS", "Lifecycle", "ISSUES / NEXT ACTION",
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


def agent_id_of(url) -> str | None:
    match = re.search(r"[?&]agent-id=([0-9a-fA-F-]{8,})", str(url or ""))
    return match.group(1) if match else None


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


def read_epoch_mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def local_cleanup_clean(path: Path, token: str) -> bool:
    """Check that an owned local cleanup receipt matches its recorded token."""
    if not token or path.is_symlink():
        return False
    try:
        fields = dict(line.split("=", 1) for line in path.read_text().splitlines())
        return fields.get("state") == "clean" and fields.get("token") == token
    except (OSError, ValueError):
        return False


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
        return "INFRA" if row.get("infra_confirmed") is True else "CANCELLED"
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


def provider_prompt_cache_share(task: dict) -> float | None:
    """Read provider prompt reuse only with the uncached-input denominator."""
    counts = [task.get("prompt_cache_" + name + "_input_tokens") for name in ("read", "creation", "uncached")]
    if any(isinstance(value, bool) or not isinstance(value, (int, float))
           or not math.isfinite(value) or value < 0 for value in counts):
        return None
    total = sum(counts)
    return counts[0] / total if math.isfinite(total) and total > 0 else None


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
            "infra_attempts": sum(a.get("infra_failure") is True and a.get("status") in TERMINAL_JOB - {"cancelled"}
                                  and bool(a.get("finished_at")) for a in attempts),
            "infra_confirmed": any(a.get("infra_failure") is True and a.get("status") in TERMINAL_JOB - {"cancelled"}
                                   and a.get("finished_at") for a in attempts),
            "wall_s": job.get("wall_clock_seconds"),
            "started_at": epoch_of(job.get("started_at")), "finished_at": epoch_of(job.get("finished_at")),
            "released": job.get("resources_released"), "lifecycle": job.get("lifecycle_verified"),
            "exec_s": task.get("duration_s"), "cost_usd": task.get("cost_usd"),
            "reason": reason_key(task.get("failure_reason")), "agent_id": task.get("agent_id"),
            "cache_hit": provider_prompt_cache_share(task),
            "window_s": _window(card),
            "unmetered": sorted(k.replace("_usd", "") for k, v in ((card or {}).get("cost") or {}).items()
                                if k.endswith("_usd") and k != "total_usd" and v is None),
        }
        # An evaluated card verdict survives a later controller/release failure.
        if row["task_status"] is None and task.get("status") in ("passed", "failed") \
                and task.get("lifecycle_stage") in ("evaluated", "teardown", "released"):
            row["task_status"] = task["status"].upper()
            row["verdict_source"] = "report-card"
        if started_terminal(row) and row["terminal_attempts"] == 0 and not attempts:
            row["terminal_attempts"] = 1
            row["infra_attempts"] = int(row["status"] != "cancelled" and row["infra_failure"] is True)
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
    exp["_telemetry_jobs"] = [{k: r.get(k) for k in ("job_id", "task", "task_status", "agent_id", "cost_usd")} for r in rows]
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
    confirmed_infra = sum(classify(r) == "INFRA" or r.get("infra_confirmed") is True for r in rows)
    exp["infra_unattributed_cancelled"] = sum(classify(r) == "CANCELLED" and r.get("infra_failure") is True
                                             and not r.get("cancellation_confirmed") for r in rows)
    exp["infra_confirmed_jobs"] = confirmed_infra
    exp["infra_jobs"] = (None if exp["infra_unattributed_cancelled"] else confirmed_infra) if rows else exp.get("infra_jobs")
    if exp["infra_unattributed_cancelled"]:
        exp["infra_attempts"] = None
    exp["infra_threshold"] = math.ceil(scheduled / 20) if scheduled else None
    exp["infra_breached"] = bool(scheduled and 20 * (confirmed_infra if rows else exp["infra_jobs"] or 0) >= scheduled)
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
    unknown = [r for r in rows if classify(r) == "UNKNOWN"]
    unreleased = [r for r in rows if started_terminal(r) and r.get("released") is False]
    exp["infra_unreconciled"] = not exp.get("recovered_provenance") and not exp.get("infra_jobs") and bool(unknown or states["CANCELLED"]) and not exp.get("cancelled_before_release")
    exp["unknown_jobs"] = [r.get("task") or r.get("job_id") for r in unknown][:6]
    exp["unreleased_jobs"] = [r.get("task") or r.get("job_id") for r in unreleased][:6]
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
    if local and exp["source_ref"] is None and re.fullmatch(r"[0-9a-f]{7,40}", str(card.get("source_sha") or "")):
        exp["source_ref"] = card["source_sha"]  # Local producer records the checkout HEAD it ran.
    exp["task_ref"] = ((card.get("execution_provenance") or {}).get("base_sha"))
    starts = [read_epoch(p) for p in run_dir.glob("*/bench-e2e.started-epoch")]
    starts = [s for s in starts if s]
    exp["triggered_at"] = min(starts) if starts else epoch_of(card.get("timestamp"))
    if local and exp["triggered_at"] is None:
        exp["triggered_at"] = epoch_of(card.get("started_at"))
    if local and exp["triggered_at"] is None:
        try:
            exp["triggered_at"] = float(run_dir.name.split("-", 1)[0])
        except ValueError:
            pass
    exp["window_s"] = _window(card)
    lifecycle = read_json(batch / "lifecycle.json")
    local_run = read_json(run_dir / "run.json") if local else None
    local_tasks = {task.get("name"): task for task in (local_run or {}).get("tasks", [])
                   if isinstance(task, dict) and task.get("name")}
    stack_owner = read_json(run_dir / "local-stack-owner.json") if local else None
    benchmark_owner = read_json(run_dir / "local-benchmark-owner.json") if local else None
    stack_token = (stack_owner or {}).get("token")
    benchmark_token = (benchmark_owner or {}).get("token")
    local_stack_clean = bool(local and (stack_owner or {}).get("run_id") == run_dir.name and
                             local_cleanup_clean(run_dir / "local-stack-cleanup.status", stack_token))
    local_benchmark_clean = bool(local and (benchmark_owner or {}).get("run_id") == run_dir.name and
                                 (benchmark_owner or {}).get("state") == "cleanup_verified" and
                                 local_cleanup_clean(run_dir / f"benchmark-cleanup-{benchmark_token}.status",
                                                     benchmark_token))
    local_released = bool(local_stack_clean and local_benchmark_clean)
    # A run context assembled from several lanes' stacks (run_captcha_probe.py --assemble) carries
    # each stack's own cleanup receipts under sources/; it is released only when every one is clean.
    assembled = read_json(run_dir / "assembled-from.json") if local else None
    unclean_stacks: list = []
    if isinstance(assembled, dict):
        for stack in assembled.get("stacks") or []:
            receipts = run_dir / str(stack.get("receipts") or "") if stack.get("receipts") else None
            owner = read_json(receipts / "local-stack-owner.json") if receipts else None
            clean = bool(owner and local_cleanup_clean(receipts / "local-stack-cleanup.status", owner.get("token")))
            bench_owner = read_json(receipts / "local-benchmark-owner.json") if receipts else None
            if clean and bench_owner:
                clean = local_cleanup_clean(receipts / f"benchmark-cleanup-{bench_owner.get('token')}.status",
                                            bench_owner.get("token"))
            if not clean:
                unclean_stacks.append(f"{stack.get('lane')}/{stack.get('stack_run_id')}")
        local_released = bool(assembled.get("stacks")) and not unclean_stacks
    rows = []
    stage_status = {"queued": "queued", "starting": "running", "ready": "running", "running": "running",
                    "evaluated": "running", "teardown": "running"}
    for task in card.get("per_task") or []:
        if not isinstance(task, dict):
            continue
        name, status = task.get("name"), task.get("status")
        local_task = local_tasks.get(name, {})
        task_dir = run_dir / str(name)
        finished = (task_dir / "bench-e2e.finished-epoch").exists() or task.get("lifecycle_stage") == "released"
        verdict = {"passed": "PASSED", "failed": "FAILED", "skipped": "SKIPPED"}.get(status)
        # A task the run interrupted has no task verdict: the local producer records it as
        # cancelled (benchmark_status CANCELLED in run.json; older cards flattened it to failed).
        cancelled = local and status != "passed" and (
            status == "cancelled" or str(local_task.get("benchmark_status") or "").upper() == "CANCELLED")
        if cancelled:
            verdict = None
        if local and (verdict or cancelled):
            finished = True  # Local CLI records terminal task status directly in report-card.json.
        rows.append({
            "job_id": name, "task": name,
            "status": ("cancelled" if cancelled else ("passed" if verdict else "failed")) if finished
            else stage_status.get(task.get("lifecycle_stage") or (status if local else None), "queued"),
            "task_status": verdict, "infra_failure": False if verdict else None,
            "exec_s": task.get("duration_s"), "cost_usd": task.get("cost_usd"),
            "agent_id": task.get("agent_id") or local_task.get("agent_id") or agent_id_of(task.get("agent_url")),
            "agent_url": task.get("agent_url"),
            "reason": reason_key(task.get("failure_reason") or local_task.get("failure_reason")),
            "released": (local_released if local else True if (isinstance(lifecycle, dict) and lifecycle.get("status") == "verified") else None),
            "cache_hit": provider_prompt_cache_share(local_task if local and local_task else task),
            "unmetered": sorted(k.replace("_usd", "") for k, v in (card.get("cost") or {}).items()
                                if k.endswith("_usd") and k != "total_usd" and v is None),
            "wall_s": (read_epoch(task_dir / "bench-e2e.finished-epoch") or 0) - (read_epoch(task_dir / "bench-e2e.started-epoch") or 0)
            if (task_dir / "bench-e2e.finished-epoch").exists() and (task_dir / "bench-e2e.started-epoch").exists() else None,
        })
    exp["rows"], exp["rows_source"] = rows, "report-card.json"
    if local:  # A local run is small: list every task with its recorded agent and FE link.
        exp["task_links"] = [{"task": r["task"], "outcome": classify(r), "agent_id": r["agent_id"],
                              "agent_url": r["agent_url"]} for r in rows]
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
    elif local and isinstance(assembled, dict):
        stacks = len(assembled.get("stacks") or [])
        lifecycle_item(exp, "ok" if local_released else "warn", "Owned resources released",
                       f"all {stacks} lane stacks have clean cleanup receipts" if local_released else
                       "cleanup receipt not clean: " + ", ".join(unclean_stacks or ["no stacks recorded"]))
        if rows and all(r["status"] in TERMINAL_JOB for r in rows):
            exp["ended_at"] = epoch_of(card.get("finished_at"))
            exp["end_evidence"] = "report-card.json finished_at (last recorded agent message)"
            if local_released:
                exp["state"] = "COMPLETE"
            else:
                exp["state"], exp["state_reason"] = "INCOMPLETE", "results recorded; a lane stack's cleanup receipt is not clean"
    elif local:
        lifecycle_item(exp, "ok" if local_released else "warn", "Owned resources released",
                       "local stack and benchmark cleanup clean" if local_released else "local cleanup receipt pending")
        if rows and all(r["status"] in TERMINAL_JOB for r in rows):
            if local_run and local_released:
                exp["state"] = "COMPLETE"
                exp["ended_at"] = max((run_dir / "local-stack-cleanup.status").stat().st_mtime,
                                      (run_dir / f"benchmark-cleanup-{benchmark_token}.status").stat().st_mtime,
                                      (run_dir / "run.json").stat().st_mtime)
                exp["end_evidence"] = "run.json and local cleanup receipts"
            else:
                exp["state"], exp["state_reason"] = "INCOMPLETE", "results recorded; local cleanup pending"
                if epoch_of(card.get("finished_at")):
                    exp["ended_at"], exp["end_evidence"] = epoch_of(card["finished_at"]), "report-card.json finished_at"
    else:
        lifecycle_item(exp, "pending", "Owned resources released", "lifecycle.json pending")
    return finish_experiment(exp)


def process_birth(pid: int) -> str | None:
    """``pid``'s identity in the form cloudbench-campaign-inventory.sh records ("" = not alive, None = unreadable)."""
    if Path("/proc/self/stat").exists():
        try:
            fields = Path("/proc", str(pid), "stat").read_text().rsplit(") ", 1)[1].split()
            boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        except (FileNotFoundError, ProcessLookupError):
            return ""
        except (OSError, IndexError):
            return None
        return "" if fields[0] in ("Z", "X") else f"proc-start:{boot}:{fields[19]}"
    try:
        result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode in (0, 1) else None


def controller_liveness(run_dir: Path, summary: dict) -> dict:
    """Is the campaign controller that wrote ``summary.json`` still the live process it recorded?

    Its exact identity is the parent PID + birth the campaign inventory publisher records in
    ``shared-inventory/owner``. A summary alone cannot prove liveness: a SIGKILLed controller
    leaves ``status: running`` forever (I-22).
    """
    recorded = (summary.get("shared_inventory") or {}).get("directory")
    owner = {}
    for path in [run_dir / "shared-inventory/owner"] + ([Path(recorded) / "owner"] if isinstance(recorded, str) else []):
        try:
            owner = dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)
            break
        except OSError:
            continue
    # Without a shared-inventory owner (concurrency 1), use the identity the campaign recorded itself.
    own = summary.get("controller") if isinstance(summary.get("controller"), dict) else {}
    pid = owner.get("parent_pid") or str(own.get("pid") or "")
    start = owner.get("parent_start") or str(own.get("birth") or "")
    if not pid.isdigit() or not start:
        return {"state": "UNVERIFIED", "pid": None, "detail": "campaign controller PID/birth not recorded"}
    current = process_birth(int(pid))
    if current == start:
        return {"state": "ALIVE", "pid": int(pid), "detail": f"controller PID {pid} alive"}
    if start.startswith("proc-start:"):
        boot = Path("/proc/sys/kernel/random/boot_id")
        try:
            same_boot = start.split(":")[1] == boot.read_text().strip()
        except OSError:  # missing or unreadable: the boot cannot be confirmed
            same_boot = False
        if not same_boot:
            return {"state": "UNVERIFIED", "pid": int(pid), "detail": f"controller PID {pid} recorded on another host boot"}
    if current is None:
        return {"state": "UNVERIFIED", "pid": int(pid), "detail": f"controller PID {pid} liveness unreadable"}
    return {"state": "LOST", "pid": int(pid),
            "detail": f"controller PID {pid} " + ("not alive" if current == "" else "reused by another process (birth differs)")}


RELEASE_KEYS = ("run_id", "fleet_dir", "fleet_owner_token", "resources_released", "lifecycle_verified",
                "released_at_epoch")


def refresh_release(run_dir: Path, summary: dict) -> None:
    """For finished jobs whose summary never recorded a release check (plain campaigns before
    I-29), read the fleet teardown receipts through the campaign's own release verifier, in
    memory only. The runner's exit-time check already covers jobs that recorded one; a receipt
    that cannot be verified, or that raises, leaves the job unverified."""
    parts = run_dir.resolve().parts
    if len(parts) < 5 or parts[-4:-1] != (".context", "benchmarks", "campaigns"):
        return  # The verifier binds receipts to the owning workspace root.
    verify = None
    for job in summary.get("jobs") or []:
        if (not isinstance(job, dict) or "resources_released" in job or not job.get("finished_at")
                or not isinstance(job.get("log"), str)):
            continue
        try:
            verify = verify or runpy.run_path(str(HERE / "run-bench-campaign.py"))["released_attempt"]
            found = verify(Path(*parts[:-4]), job)
        except Exception:
            continue
        if isinstance(found, dict) and found.get("resources_released") is True:
            job.update({key: found[key] for key in RELEASE_KEYS if key in found})


def campaign_fleet(attempt: dict) -> Path | None:
    """Read the physical handle emitted by the controller, including non-retry campaigns.

    Those summaries record verdicts but not fleet_dir. The monitor command in
    their job log is the producer's handle; PID/name guessing is not a binding.
    """
    if isinstance(attempt.get("fleet_dir"), str):
        return Path(attempt["fleet_dir"])
    log = attempt.get("log")
    if not isinstance(log, str):
        return None
    try:
        with Path(log).open(errors="replace") as stream:
            for line in stream:
                if "/scripts/run-bench monitor " not in line:
                    continue
                try:
                    fields = shlex.split(line.strip())
                except ValueError:
                    continue
                if len(fields) != 3 or fields[1] != "monitor":
                    continue
                command = Path(fields[0])
                if not command.is_absolute() or command.name != "run-bench" or command.parent.name != "scripts":
                    continue
                root = command.parent.parent
                fleet = Path(fields[2])
                if fleet.parent == root / ".context/fleet/runs":
                    # Match run-bench-campaign.terminal_task: the first handle is
                    # this controller; later ones may belong to its infra canary.
                    return fleet
    except OSError:
        return None
    return None


def campaign_receipts(fleet: Path, card: dict) -> tuple[bool, bool]:
    """Separate a run-bound provider release from the full lifecycle verdict."""
    lifecycle = read_json(fleet / "_batch/lifecycle.json") or {}
    try:
        meta = dict(line.split("=", 1) for line in (fleet / "teardown-ownership/meta").read_text().splitlines())
    except (OSError, ValueError):
        return False, False
    released_at = read_epoch(fleet / "teardown-ownership/provider-teardown-verified.epoch")
    released = bool(lifecycle.get("run_id") == card.get("run_id") == meta.get("run_id") == fleet.name
                and lifecycle.get("fleet_owner_token") == meta.get("fleet_owner_token")
                and lifecycle.get("fleet_owner_token")
                and lifecycle.get("workspace_root") == meta.get("workspace_root") == str(fleet.parents[3])
                and meta.get("status") == "provider-teardown-verified"
                and all(task.get("lifecycle_stage") == "released" for task in card.get("per_task") or [])
                and released_at is not None and math.isfinite(released_at) and released_at > 0)
    return released, bool(released and lifecycle.get("status") == "verified"
                          and lifecycle.get("hub_publication_failed") is False)


def operator_end_bindings(paths, *, now: float) -> dict:
    """Validate explicit custodian bindings; never discover or rewrite process receipts."""
    bindings = {}
    if paths and (type(now) not in (int, float) or not math.isfinite(now) or now <= 0):
        raise ValueError("operator end receipt requires a finite render time")
    for path in paths or []:
        path = Path(path)
        try:
            binding = json.loads(path.read_bytes())
            if not isinstance(binding, dict) or binding.get("schema") != "campaign-operator-end-v1":
                raise ValueError("invalid binding schema")
            def bound_path(key):
                value = binding.get(key)
                if not isinstance(value, str) or not value:
                    raise ValueError("missing " + key)
                target = Path(value)
                return (path.parent / target).resolve() if not target.is_absolute() else target.resolve()
            run = bound_path("run_dir")
            raw_summary = (run / "summary.json").read_bytes()
            raw_process = bound_path("process_receipt").read_bytes()
            for key, raw in (("summary_sha256", raw_summary), ("process_sha256", raw_process)):
                if not re.fullmatch(r"[0-9a-f]{64}", str(binding.get(key) or "")) or hashlib.sha256(raw).hexdigest() != binding[key]:
                    raise ValueError("mismatched " + key)
            summary, process = json.loads(raw_summary), json.loads(raw_process)
            if not isinstance(summary, dict) or not isinstance(process, dict):
                raise ValueError("expected summary and process objects")
            campaign = summary.get("campaign_id")
            if campaign != binding.get("campaign_id") or campaign != run.name:
                raise ValueError("campaign identity mismatch")
            if summary.get("status") != "running" or summary.get("finished_at") is not None:
                raise ValueError("summary already finalized or not running")
            source = binding.get("source_ref")
            if not isinstance(source, str) or not re.fullmatch(r"[0-9a-f]{40}", source) or process.get("source") != source:
                raise ValueError("operator source mismatch")
            pid, code = process.get("pid"), process.get("exit_code")
            if type(pid) is not int or pid <= 0 or type(code) is not int or not -255 <= code <= 255:
                raise ValueError("invalid terminal process identity/status")
            if not re.fullmatch(r"[1-9][0-9]*", str(process.get("birth_ticks") or "")) or not UUID.fullmatch(str(process.get("boot") or "")):
                raise ValueError("missing process birth identity")
            def finite(value):
                if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
                    raise ValueError("invalid process timestamp")
                return float(value)
            start = finite(process.get("whole_cli_started_epoch"))
            end = finite(process.get("finished_at"))
            summary_start = epoch_of(summary.get("started_at"))
            e2e_start = epoch_of(summary.get("e2e_started_at_epoch"))
            if (abs((epoch_of(process.get("whole_cli_started_utc")) or 0) - start) > 0.00001 or end < start or end > now
                    or summary_start is None or not 0 <= summary_start - start <= 5
                    or e2e_start is None or not 0 <= e2e_start - start <= 5):
                raise ValueError("operator/campaign clock mismatch")
            stamp = datetime.fromtimestamp(summary_start, timezone.utc).strftime("%Y%m%d-%H%M%S")
            if campaign != f"campaign-{stamp}-{pid}":
                raise ValueError("campaign/process identity mismatch")
            jobs, argv = summary.get("jobs"), process.get("argv")
            if not isinstance(jobs, list) or not jobs or not all(isinstance(j, dict) for j in jobs):
                raise ValueError("invalid campaign jobs")
            if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv) or Path(argv[0]).name != "run-bench":
                raise ValueError("invalid operator command")
            tasks = sorted({j.get("task") for j in jobs if isinstance(j.get("task"), str)})
            selected = argv[1:next((i for i, a in enumerate(argv[1:], 1) if a.startswith("-")), len(argv))]
            def flag(name):
                if argv.count(name) != 1 or argv.index(name) + 1 >= len(argv):
                    raise ValueError("missing or duplicated " + name)
                return int(argv[argv.index(name) + 1])
            runs, concurrency = flag("-k"), flag("--concurrency")
            if any(type(value) is not int or value <= 0 for value in
                   (summary.get("runs"), summary.get("concurrency"), summary.get("task_count"), summary.get("total_jobs"), process.get("concurrency"))):
                raise ValueError("invalid campaign counts")
            if (sorted(selected) != tasks or len(tasks) != summary.get("task_count")
                    or runs != summary.get("runs") or concurrency != summary.get("concurrency")
                    or type(process.get("original_jobs")) is not int
                    or process["original_jobs"] != len(jobs) or len(jobs) != summary.get("total_jobs")
                    or len(jobs) != len(tasks) * runs or process.get("concurrency") != concurrency):
                raise ValueError("operator/campaign command scope mismatch")
            if {(j.get("task"), j.get("run")) for j in jobs} != {(task, r) for task in tasks for r in range(1, runs + 1)}:
                raise ValueError("campaign job membership mismatch")
            for job in jobs:
                finished = epoch_of(job.get("finished_at"))
                if finished is not None and (not math.isfinite(finished) or finished > end):
                    raise ValueError("job evidence postdates operator end")
            if run in bindings:
                raise ValueError("duplicate operator binding")
            bindings[run] = dict(ended_at=end, exit_code=code, source_ref=source,
                                 summary_sha256=binding["summary_sha256"], process_sha256=binding["process_sha256"])
        except (OSError, ValueError, TypeError, OverflowError) as error:
            raise ValueError(f"operator end receipt refused: {path}: {error}") from error
    return bindings


def load_campaign(run_dir: Path, operator_ends=None) -> dict:
    operator = (operator_ends or {}).get(run_dir.resolve())
    if operator:
        try:
            raw = (run_dir / "summary.json").read_bytes()
        except OSError as error:
            raise ValueError("operator end receipt: summary unavailable during rendering") from error
        if hashlib.sha256(raw).hexdigest() != operator["summary_sha256"]:
            raise ValueError("operator end receipt: summary changed during rendering")
        summary = json.loads(raw)
    else:
        summary = read_json(run_dir / "summary.json") or {}
    refresh_release(run_dir, summary)
    exp = empty_experiment("campaign", run_dir)
    exp["id"] = summary.get("campaign_id") or run_dir.name
    exp["scheduled_total"] = summary.get("group_total") or summary.get("total_jobs")
    exp["runs"] = summary.get("runs")
    exp["tasks"] = summary.get("task_count")
    exp["triggered_at"] = epoch_of(summary.get("e2e_started_at_epoch")) or epoch_of(summary.get("started_at"))
    cards = {}
    jobs = []
    releases = {}
    lifecycles = {}
    child_exits = {}
    controller_exits = {}
    for job in summary.get("jobs") or []:
        if not isinstance(job, dict):
            continue
        job = dict(job)
        jobs.append(job)
        for attempt in [job, *reversed(job.get("attempts") or [])]:
            fleet = campaign_fleet(attempt) if isinstance(attempt, dict) else None
            if fleet is None:
                continue
            card = read_json(fleet / "_batch/report-card.json")
            if not isinstance(card, dict) or card.get("run_id") != fleet.name:
                continue
            tasks = card.get("per_task") or []
            if len(tasks) != 1 or not isinstance(tasks[0], dict) or tasks[0].get("name") != job.get("task"):
                continue
            if attempt.get("run_id") not in (None, card["run_id"]):
                continue
            cards[card["run_id"]] = card
            releases[card["run_id"]], lifecycles[card["run_id"]] = campaign_receipts(fleet, card)
            lifecycle = read_json(fleet / "_batch/lifecycle.json") or {}
            if (lifecycle.get("run_id") == fleet.name
                    and lifecycle.get("workspace_root") == str(fleet.parents[3])
                    and lifecycle.get("status") in ("verified", "failed")
                    and type(lifecycle.get("controller_exit_code")) is int
                    and lifecycle["controller_exit_code"] == card.get("controller_exit_code")
                    == attempt.get("controller_exit_code")):
                controller_exits[card["run_id"]] = lifecycle["controller_exit_code"]
            if Path(job["task"]).name == job["task"]:
                try:
                    child_exits[card["run_id"]] = int((fleet / job["task"] / "benchmark-child.finished").read_text().strip())
                except (OSError, ValueError):
                    pass
            if attempt is job and job.get("run_id") is None:
                job["run_id"] = card["run_id"]
    exp["rows"] = compact_rows(dict(summary, jobs=jobs), cards)
    exp["rows_source"] = "summary.json + fleet receipts" if cards else "summary.json"
    # The producer's latched breach precedes its cancellation cascade. Only
    # exact scheduled membership can preserve confirmed infra through that stop.
    stop = summary.get("infra_stop") or {}
    ids = stop.get("infra_job_ids") or []
    membership = {j.get("job_id") for j in jobs}
    confirmed = set(ids) if (isinstance(ids, list) and all(isinstance(i, str) for i in ids)
                            and len(set(ids)) == len(ids) == stop.get("infra_jobs")
                            and stop.get("scheduled_total") == exp["scheduled_total"]
                            and set(ids) <= membership) else set()
    refs = set()
    complete_sources = True
    for job, row in zip(jobs, exp["rows"]):
        if row.get("job_id") in confirmed:
            row["infra_confirmed"] = True
            row["infra_attempts"] = max(1, row["infra_attempts"])
        card = card_for(job, cards)
        if card and row["status"] == "cancelled" and row.get("infra_failure") is True:
            child_exit = child_exits.get(card["run_id"])
            # The native child supervisor reserves 125 for its infrastructure
            # failure; forwarded HUP/INT/TERM are 129/130/143. The terminal
            # task's generic INFRA_ERROR does not distinguish those paths.
            if child_exit == 125:
                row["infra_confirmed"] = True
                row["infra_attempts"] = max(1, row["infra_attempts"])
                row["reason"] = "Native child exit 125; " + (row["reason"] or "task result not recorded")
            elif child_exit in (129, 130, 143):
                row["cancellation_confirmed"] = True
            elif child_exit is None and controller_exits.get(card["run_id"]) in (129, 130, 143):
                # A preallocation controller has no child marker. Its matching
                # terminal summary/card/lifecycle still records forwarded TERM.
                # Ordinary failure exits alone never prove pre-cancel infra.
                row["cancellation_confirmed"] = True
        ref = ((card or {}).get("execution_provenance") or {}).get("base_sha")
        if not isinstance(ref, str) or not re.fullmatch(r"[0-9a-f]{40}", ref):
            complete_sources = False
        else:
            refs.add(ref)
        if card and releases.get(card["run_id"]):
            row["released"] = True
            row["lifecycle"] = lifecycles[card["run_id"]]
    if complete_sources and len(refs) == 1:
        exp["source_ref"] = refs.pop()
    status = summary.get("status")
    if summary.get("finished_at"):
        exp["ended_at"], exp["end_evidence"] = epoch_of(summary["finished_at"]), "summary.json finished_at"
        exp["state"] = {"passed": "COMPLETE", "failed": "FAILED", "cancelled": "ABORTED"}.get(status, "INCOMPLETE")
        if summary.get("e2e_timeout_exceeded"):
            exp["state_reason"] = "whole-experiment deadline exceeded"
    elif not operator:
        live = controller_liveness(run_dir, summary)
        if live["state"] != "ALIVE":
            exp["controller"] = dict(live, last_update_at=read_epoch_mtime(run_dir / "summary.json"))
            exp["state"] = "CONTROLLER LOST" if live["state"] == "LOST" else "UNVERIFIED"
            exp["state_reason"] = f'last update {pacific(exp["controller"]["last_update_at"])} · {live["detail"]}'
            lifecycle_item(exp, "fail" if live["state"] == "LOST" else "warn", "Campaign controller",
                           live["detail"], issue=False)
    operator = (operator_ends or {}).get(run_dir.resolve())
    if operator:
        source = exp.get("source_ref")
        if refs - {operator["source_ref"]} or (source and not operator["source_ref"].startswith(source)):
            raise ValueError("operator end receipt conflicts with campaign source")
        exp["ended_at"] = operator["ended_at"]
        exp["end_evidence"] = "hash-bound operator process receipt (summary unfinalized)"
        exp["state"] = "FAILED" if operator["exit_code"] else "INCOMPLETE"
        exp["state_reason"] = f'operator ended (exit {operator["exit_code"]}); summary unfinalized'
        exp["summary_finalized"] = False
        exp["operator_end"] = dict(operator)
    _job_lifecycle(exp)
    return finish_experiment(exp)


def started_terminal(row) -> bool:
    """Terminal jobs that could own resources (a never-started cancellation owns none)."""
    return classify(row) in CATEGORIES and not (classify(row) == "CANCELLED"
                                               and not row.get("attempts") and row.get("started_at") is None)


def _job_lifecycle(exp, audit=None, finished_after=None, physical_closure=None):
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
    if physical_closure:
        exp["physical_closure_asof"] = physical_closure
        lifecycle_item(exp, "ok", "Physical resources terminal (as of)",
            f"{pacific(physical_closure['observed_at'])}: {physical_closure['subjects']} subjects; "
            + ("all absent" if physical_closure["all_resources_absent"] else "provider-retained terminal objects; not all absent")
            + "; historical runtime evidence unchanged")
    if usable and (lingering or retained):
        detail = []
        if lingering:
            detail.append(f"still present: {', '.join(str(m.get('name') or m.get('id')) for m in lingering[:4])}")
        if retained:
            detail.append(f"retained owners: {', '.join(token[:12] for token in retained[:4])}")
        lifecycle_item(exp, "fail", "Historical guest release evidence (native audit)" if physical_closure else "Guests released (native audit)", " · ".join(detail), issue=not bool(physical_closure))
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


def load_sharded(run_dir: Path, deep: bool = True, raw: bool = False) -> dict:
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
    loaded_per_shard = False
    if isinstance(result, dict) and isinstance(result.get("jobs"), list):
        exp["rows"], exp["rows_source"] = result["jobs"], "result.json"
    elif deep and any((out / "export/disposable-export.verified.json").exists() for out in outs):
        with ThreadPoolExecutor(max_workers=8) as pool:
            records = list(pool.map(lambda out: export_records(out / "export"), outs))
        loaded_per_shard = True
        sources = set()
        for record, status in zip(records, statuses):
            if record["summary"]:
                exp["rows"] += compact_rows(record["summary"], record["cards"])
                sources.add("verified controller exports")
            else:
                progress = (status.get("infra") or {}).get("progress") or {}
                if progress.get("combos"):
                    exp["rows"] += rows_from_counters(progress)
                    sources.add("live shard-status counters")
                    for entry in progress.get("reasons") or []:
                        if isinstance(entry, list) and len(entry) in (2, 3) and isinstance(entry[-1], int):
                            category = entry[0] if len(entry) == 3 and entry[0] in CATEGORIES else "UNKNOWN"
                            exp.setdefault("live_reasons", []).append([category, reason_key(entry[-2]), entry[-1]])
        exp["rows_source"] = " + ".join(name for name in ("verified controller exports", "live shard-status counters")
                                        if name in sources) or "verified controller exports"
    if not exp["rows"]:
        progress = [] if loaded_per_shard else [((s.get("infra") or {}).get("progress") or {}) for s in statuses]
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
        audit = read_json(run_dir / "native-release-audit.json")
        closure = runpy.run_path(str(HERE / "cloudbench-resource-closure-report.py"))["load"](
            run_dir, audit, coordination.get("finished_at")) if isinstance(audit, dict) else None
        _job_lifecycle(exp, audit, finished_after=coordination.get("finished_at"), physical_closure=closure)
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
        finished = coordination.get("finished_at")
        lifecycle_item(exp, "warn" if finished else "pending", "Results recorded",
                       "final result.json absent after runners joined" if finished else "result.json pending")
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
        exp["ended_at"], exp["end_evidence"] = finished, "coordination.finished_at"
        exp["state"] = "INCOMPLETE"
        exp["state_reason"] = "runners joined; final result.json absent; recorded outcomes may be incomplete"
    if raw:  # one bounded wave; its batch card derives the totals
        return exp
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


def load_waves(run_dir: Path, deep: bool = True) -> dict:
    """One run-bench batch run as bounded sharded waves (batch.json): one card over every wave.

    The denominator is the batch's original scheduled copies; copies of waves that never
    launched stay QUEUED rows and are named, never dropped from the total."""
    batch = read_json(run_dir / "batch.json") or {}
    exp = empty_experiment("sharded-waves", run_dir)
    exp["scheduled_total"] = batch.get("scheduled_total")
    exp["tasks"], exp["runs"] = len(batch.get("tasks") or []) or None, batch.get("runs")
    exp["triggered_at"] = batch.get("created_at")
    refs, unlaunched, wave_proofs = set(), [], []
    for wave in batch.get("waves") or []:
        index, state = wave.get("index"), wave.get("state")
        admission = Path(wave["admission_dir"]) if wave.get("admission_dir") else None
        if admission is not None and (admission / "coordination.json").exists():
            sub = load_sharded(admission, deep, raw=True)
            wave_proofs.append((index, sub))
            exp["rows"] += sub["rows"]
            refs.add(sub.get("source_ref"))
            for item in sub["lifecycle"]:
                exp["lifecycle"].append(dict(item, label=f"Wave {index + 1}: {item['label']}"))
            if exp.get("released_at") is None:
                exp["released_at"] = sub.get("released_at")
        elif state in ("LAUNCHED", "JOINED", "RELEASED", "FAILED_NO_RESULT"):
            wave_proofs.append((index, {}))
            lifecycle_item(exp, "fail" if state == "FAILED_NO_RESULT" else "pending", f"Wave {index + 1}",
                           f"{state}: no admission record yet")
        else:
            unlaunched.append(wave)
            exp["rows"] += [{"status": "queued", "task_status": None, "infra_failure": None, "attempts": 0,
                             "terminal_attempts": 0, "infra_attempts": 0, "synthetic": True}] * (wave.get("copies") or 0)
    exp["native_audit"] = bool(wave_proofs) and all(sub.get("native_audit") for _, sub in wave_proofs)
    exp["release_evidence_complete"] = bool(wave_proofs) and all(
        sub.get("native_audit") or sub.get("physical_closure_asof") for _, sub in wave_proofs)
    exp["physical_closure_waves"] = [
        {"index": index, "evidence": sub["physical_closure_asof"]}
        for index, sub in wave_proofs if sub.get("physical_closure_asof")]
    if wave_proofs and all(sub.get("physical_closure_asof") for _, sub in wave_proofs):
        exp["physical_closure_asof"] = {
            "observed_at": min(sub["physical_closure_asof"]["observed_at"] for _, sub in wave_proofs),
            "waves": [{"index": index, "evidence": sub["physical_closure_asof"]} for index, sub in wave_proofs],
        }
    exp["source_ref"] = next(iter(refs)) if len(refs - {None}) == 1 and None not in refs else None
    exp["rows_source"] = "batch.json waves (wave result.json / exports)"
    waves = batch.get("waves") or []
    lifecycle_item(exp, "ok" if not unlaunched else "fail" if batch.get("stop_reason") else "pending",
                   "Waves launched", f"{len(waves) - len(unlaunched)}/{len(waves)} waves"
                   + (f"; not launched: {sum(len(w.get('tasks') or []) for w in unlaunched)} tasks "
                      f"({', '.join(t for w in unlaunched for t in (w.get('tasks') or [])[:3])}…)" if unlaunched else ""))
    exp["notes"].append(f"Bounded waves: at most {batch.get('concurrency')} simultaneous copies; infra "
                        f"{batch.get('infra_confirmed')}/{batch.get('scheduled_total')} confirmed across waves")
    if batch.get("stop_reason"):
        exp["state"], exp["state_reason"] = "ABORTED", str(batch["stop_reason"])[:160]
        exp["ended_at"], exp["end_evidence"] = batch.get("ended_at"), "batch.json ended_at" if batch.get("ended_at") else None
    elif batch.get("ended_at"):
        exp["ended_at"], exp["end_evidence"] = batch["ended_at"], "batch.json ended_at"
        gaps = [i for i in exp["lifecycle"] if i["state"] in ("fail", "warn", "pending")]
        exp["state"] = "COMPLETE" if batch.get("batch_complete") and not gaps else "INCOMPLETE"
    finish = finish_experiment(exp)
    if finish["infra_breached"] and finish["state"] in ("COMPLETE", "INCOMPLETE"):
        finish["state"], finish["state_reason"] = "FAILED", "infra stop threshold reached"
    if finish["state"] == "INCOMPLETE" and not finish["state_reason"]:
        finish["state_reason"] = "ended; open: " + ", ".join(i["label"] for i in finish["lifecycle"] if i["state"] != "ok")
    return finish


def load_local_worlds(run_dir: Path) -> dict:
    """Read native world custody and canonical grades; child cards never supply verdicts."""
    exp = empty_experiment("local-worlds", run_dir)
    exp["surface"] = "local"
    journal = read_json(run_dir / "local-worlds.json")
    if not isinstance(journal, dict) or type(journal.get("version")) is not int or journal.get("version") != 1 or journal.get("run_id") != run_dir.name or not isinstance(journal.get("tasks"), list):
        exp["state"], exp["state_reason"] = "UNRECORDED", "invalid native local-worlds journal identity"
        return finish_experiment(exp)
    children = journal["tasks"]
    exp["scheduled_total"], exp["rows_source"] = len(children), "local-worlds.json + exact child canonical result/index"
    exp["notes"].append("Parent producer clocks are unrecorded; no child-card or file-mtime clock is substituted.")
    sources = []
    for ordinal, child in enumerate(children):
        row = {"job_id": str(ordinal), "task": child.get("task") if isinstance(child, dict) else None,
               "status": "failed", "task_status": "ERROR", "infra_failure": None, "attempts": 1,
               "released": None, "lifecycle": None}
        try:
            expected = f"{run_dir.name}-{ordinal}"
            if not isinstance(child, dict) or type(child.get("ordinal")) is not int or child.get("ordinal") != ordinal or child.get("run_id") != expected:
                raise ValueError("child ordinal/run identity differs from native journal")
            context = run_dir.parent / expected
            if context.is_symlink() or Path(child.get("context_dir", "")).absolute() != context:
                raise ValueError("child context belongs to a foreign world")
            phase = child.get("status")
            if phase in {"queued", "launching", "running", "cancelled-before-start"}:
                row.update(status={"launching":"running", "cancelled-before-start":"cancelled"}.get(phase, phase),
                           task_status=None, attempts=0 if phase in {"queued", "cancelled-before-start"} else 1)
                exp["rows"].append(row)
                continue
            if phase not in {"passed", "failed", "failed-retained", "interrupted"}:
                raise ValueError("unknown native child state")
            payload = (context / "run.json").read_bytes()
            index = read_json(context / "local-benchmark-results.json")
            indexed = isinstance(index, dict)
            if indexed:
                entries = index.get("results")
                if type(index.get("version")) is not int or index.get("version") != 1 or index.get("run_id") != expected or not isinstance(entries, list) or len(entries) != 1:
                    raise ValueError("child result index has foreign or malformed identity")
                entry = entries[0]
                result_path = Path(entry["path"])
                exact = result_path.read_bytes()
                if hashlib.sha256(exact).hexdigest() != entry.get("sha256") or payload != exact:
                    raise ValueError("canonical result changed after publication or context copy differs")
                if child.get("results") is not None and child["results"] != [str(result_path)]:
                    raise ValueError("journal result pointer differs from child index")
            result = json.loads(payload)
            tasks = result.get("tasks")
            if not isinstance(tasks, list) or len(tasks) != 1 or tasks[0].get("name") != child.get("task"):
                raise ValueError("canonical task differs from selected child occurrence")
            task = tasks[0]
            verdict = str(task.get("benchmark_status") or task.get("status") or "").upper()
            positive_verdict = verdict in {"PASSED", "PASS", "COMPLETED"}
            if positive_verdict and task.get("passed") is not True:
                raise ValueError("positive canonical verdict contradicts the strict pass flag")
            passed = task.get("passed") is True and positive_verdict
            if passed and (not indexed or phase != "passed" or child.get("exit_code") != 0):
                raise ValueError("PASS has no verified native child publication")
            if phase == "passed" and not passed:
                raise ValueError("journal PASS contradicts canonical result")
            row.update(status="cancelled" if verdict == "CANCELLED" else "passed" if passed else "failed",
                       task_status="PASSED" if passed else verdict, agent_id=task.get("agent_id"),
                       infra_failure=task.get("infra_failure") if isinstance(task.get("infra_failure"), bool) else None,
                       harness_failure=task.get("harness_failure") if isinstance(task.get("harness_failure"), bool) else None,
                       agent_url=f"https://roselabs.ai/?agent-id={task['agent_id']}" if task.get("agent_id") else None,
                       exec_s=task.get("duration_seconds"), reason=reason_key(task.get("failure_reason") or child.get("error")))
            if isinstance(task.get("cost_cents"), (int, float)):
                row["cost_usd"] = task["cost_cents"] / 100
            detail = load_fleet(context) if (context / "report-card.json").is_file() else {}
            release = detail.get("released") or {}
            row["released"] = row["lifecycle"] = release.get("yes") == release.get("of") == 1
            sources.append(detail.get("source_ref"))
        except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
            row.update(status="failed", task_status="ERROR", reason=str(error))
        exp["rows"].append(row)
    if sources and len(sources) == len(children) and None not in sources and len(set(sources)) == 1:
        exp["source_ref"] = sources[0]
    exp["task_links"] = [{"task": r["task"], "outcome": classify(r), "agent_id": r.get("agent_id"),
                          "agent_url": r.get("agent_url")} for r in exp["rows"]]
    phase = journal.get("status")
    complete = bool(children) and all(classify(r) == "PASS" and r.get("released") for r in exp["rows"])
    exp["state"] = "RUNNING" if phase == "running" else "COMPLETE" if phase == "passed" and complete else "FAILED" if phase == "failed" else "INCOMPLETE"
    if phase == "passed" and not complete:
        exp["state_reason"] = "native child result or cleanup custody incomplete"
    terminal = [r for r in exp["rows"] if started_terminal(r)]
    clean = sum(r.get("released") is True for r in terminal)
    lifecycle_item(exp, "ok" if terminal and clean == len(terminal) else "warn", "Owned resources released",
                   f"{clean}/{len(terminal)} terminal native child receipts clean")
    return finish_experiment(exp)


def load(run_dir: Path, deep: bool = True, operator_ends=None) -> dict:
    run_dir = Path(run_dir).absolute()
    if (run_dir / "local-worlds.json").exists():
        return load_local_worlds(run_dir)
    if (run_dir / "batch.json").exists() and (read_json(run_dir / "batch.json") or {}).get("schema") == "run-bench-sharded-waves-v1":
        return load_waves(run_dir, deep)
    if (run_dir / "coordination.json").exists():
        return load_sharded(run_dir, deep)
    if (run_dir / "summary.json").exists() and (read_json(run_dir / "summary.json") or {}).get("jobs") is not None:
        return load_campaign(run_dir, operator_ends)
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

OVERLAY_MAX_AGE_S = 15 * 60


class StaleOverlay(ValueError):
    """Hand-supplied --agents/--issues rows that cannot be shown as current."""


def _observed_epoch(value) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def stale_overlay_rows(rows: list[dict], kind: str, *, now: float, evidence_at: float | None) -> list[str]:
    """Overlay rows are claims made outside the run's artifacts, so each carries ``observed_at``.

    A claim older than the 15-minute checkpoint, or made before the run's latest
    evidence (its end), may describe a world that no longer exists; it is refused
    rather than shown as current.
    """
    problems = []
    for row in rows:
        label = str(row.get("name") or row.get("text") or "?")[:80]
        at = _observed_epoch(row.get("observed_at"))
        if at is None:
            problems.append(f"{kind} row {label!r}: no parseable observed_at")
            continue
        reasons = []
        if now - at > OVERLAY_MAX_AGE_S:
            reasons.append(f"observed {duration(now - at)} ago (max {duration(OVERLAY_MAX_AGE_S)})")
        if evidence_at is not None and at < evidence_at:
            reasons.append(f"observed {duration(evidence_at - at)} before the run's latest evidence")
        if reasons:
            problems.append(f"{kind} row {label!r}: " + "; ".join(reasons))
    return problems


def build(run_dir: Path, *, ledger: Path | None = None, goal: str | None = None, iterations: int | None = None,
          agents=None, issues=None, history_ids: list[str] | None = None,
          global_acceptance=None, selected_tasks=None, selected_tasks_sha256=None, global_history=None, telemetry=None, global_runs=None, telemetry_membership=None, telemetry_sources=None, telemetry_receipt=None, telemetry_receipt_sha256=None,
          now: float | None = None, deep: bool = True, operator_end_receipts=None,
          recovered_results: Path | None = None, recovered_sha256: str | None = None) -> dict:
    now = time.time() if now is None else now
    operator_ends = operator_end_bindings(operator_end_receipts, now=now)
    exp = load(run_dir, deep if recovered_results is None else False, operator_ends=operator_ends)
    if recovered_results is not None:
        raw = Path(recovered_results).read_bytes()
        if hashlib.sha256(raw).hexdigest() != recovered_sha256:
            raise ValueError("recovered results: sidecar hash differs")
        recovery = runpy.run_path(str(HERE / "cloudbench-recovered-results.py"))
        rows, provenance = recovery["rows"](json.loads(raw), run_dir)
        exp["original_observation"] = {k: exp.get(k) for k in ("outcomes", "rows_source", "progress", "cost")}
        exp["recovered_provenance"] = provenance
        exp["rows"] = rows
        exp["rows_source"] = "hash-bound recovered classifications (job + Hub snapshots + accepted grades)"
        exp["recovery_sha256"] = recovered_sha256
        exp = finish_experiment(exp)
    entries = ledger_mod.read(ledger)
    every = ledger_mod.experiments(entries)
    mine = next((e for e in every if e["id"] == exp["id"] or e.get("run_dir") == exp["run_dir"]), None)
    goal = goal or (mine or {}).get("goal")
    for key in ("label", "tasks", "runs", "source_ref", "task_ref", "surface"):
        if exp.get(key) is None and mine and mine.get(key) is not None:
            exp[key] = mine[key]
    if exp.get("operator_end") and exp.get("source_ref") and not exp["operator_end"]["source_ref"].startswith(exp["source_ref"]):
        raise ValueError("operator end receipt conflicts with recorded source")
    if exp.get("label") is None:
        exp["label"] = (mine or {}).get("slice") or exp["id"]
    history_entries = ledger_mod.experiments(entries, goal) if goal else ([mine] if mine else [])
    if history_ids is not None:
        # A descent may rotate task cohorts; its explicit membership, not task
        # overlap or elapsed time, joins those original launches for reporting.
        if len(history_ids) != len(set(history_ids)):
            raise ValueError("history scope contains duplicate experiment IDs")
        selected = set(history_ids)
        known = {entry["id"] for entry in every}
        if selected - known:
            raise ValueError("history scope contains unrecorded experiment IDs: " + ", ".join(sorted(selected - known)))
        if not mine or mine["id"] not in selected:
            raise ValueError("history scope must include the current recorded experiment")
        history_entries = [dict(entry, number=index + 1) for index, entry in enumerate(
            entry for entry in every if entry["id"] in selected)]
    scoped_paths = {Path(run_dir).resolve()} | {Path(e["run_dir"]).resolve() for e in history_entries if e.get("run_dir")}
    if set(operator_ends) - scoped_paths:
        raise ValueError("operator end receipt is outside the selected campaign/history scope")
    number = next((e["number"] for e in history_entries if mine and e["id"] == mine["id"]), None)
    rate = ledger_mod.launch_rate(history_entries, now) if history_entries else None
    history_limit = 10 if iterations is not None else 3
    history = []
    for entry in reversed(history_entries):
        if len(history) == history_limit:
            break
        if mine and entry["id"] == mine["id"]:
            item = dict(exp, number=entry["number"])
        else:
            path = Path(entry.get("run_dir") or "")
            item = load(path, deep=False, operator_ends=operator_ends) if entry.get("run_dir") and path.exists() else _from_ledger(entry)
            item["number"] = entry["number"]
            item["label"] = entry.get("slice") or item.get("label") or entry["id"]
        history.append(_history_row(item))
    if not mine:
        history.insert(0, _history_row(dict(exp, number=None)))
    iteration_speed = finish_to_finish_speed(history, now, exp["id"] if exp["state"] == "RUNNING" else None) if iterations is not None and mine else None
    history = history[:history_limit]
    trend = []
    if iterations is None and len(history_entries) > 3:
        for entry in history_entries:
            if mine and entry["id"] == mine["id"]:
                item = exp
            else:
                path = Path(entry.get("run_dir") or "")
                item = load(path, deep=False, operator_ends=operator_ends) if entry.get("run_dir") and path.exists() else _from_ledger(entry)
            outcomes, scored = item.get("outcomes"), item.get("scored")
            trend.append({"number": entry["number"], "rate": outcomes["PASS"] / scored if outcomes and scored else None,
                          "running": item.get("state") == "RUNNING"})
    ended = [(h["ended_at"], h["label"]) for h in history if h.get("ended_at")]
    since = None
    if exp["state"] == "RUNNING":
        since = {"state": "RUNNING"}
    elif exp["state"] in UNLIVE:
        since = {"state": "END UNRECORDED"}
    elif ended:
        at, label = max(ended)
        since = {"state": "ENDED", "label": label, "at": at, "age": now - at}
    elif exp.get("ended_at") is None:
        since = {"state": "END UNRECORDED"}
    overlay_issues = [i for i in (issues or []) if isinstance(i, dict) and i.get("text")]
    agents = [a for a in (agents or []) if isinstance(a, dict) and a.get("name")]
    stale = (stale_overlay_rows(agents, "agent", now=now, evidence_at=exp.get("ended_at"))
             + stale_overlay_rows(overlay_issues, "issue", now=now, evidence_at=exp.get("ended_at")))
    if stale:
        raise StaleOverlay("stale overlay; refresh these rows from current evidence before rendering:\n  "
                           + "\n  ".join(stale))
    exp_issues = _issues(exp) + overlay_issues
    if iterations is None and any(value is not None for value in (global_acceptance, selected_tasks, selected_tasks_sha256, global_history, telemetry, global_runs, telemetry_membership, telemetry_sources, telemetry_receipt, telemetry_receipt_sha256)):
        raise ValueError("global progress and telemetry inputs require --iterations (descend mode)")
    if not telemetry and (telemetry_membership or telemetry_sources or telemetry_receipt or telemetry_receipt_sha256):
        raise ValueError("telemetry membership/source inputs require telemetry")
    global_progress = global_mod.load(global_acceptance, selected_tasks, selected_tasks_sha256, global_history, now, global_runs) if iterations is not None else None
    observed_telemetry = global_mod.telemetry(telemetry, exp["id"], exp.get("scheduled_total"), telemetry_membership, telemetry_sources, exp.get("_telemetry_jobs", []), telemetry_receipt, telemetry_receipt_sha256) if telemetry else None
    if observed_telemetry and observed_telemetry["cost"] is not None:
        exp["cost"] = observed_telemetry["cost"]
    return {"format": FORMAT, "generated_at": now, "goal": goal, "number": number, "rate": rate,
            "since": since, "experiment": exp, "history": history, "trend": trend,
            "history_limit": history_limit,
            "iteration_speed": iteration_speed,
            "live_iteration_speed": live_iteration_speed(history, now, exp["id"]) if iterations is not None and mine and exp["state"] == "RUNNING" else None,
            "global_progress": global_progress, "observed_telemetry": observed_telemetry,
            "speed_change": average_speed_change(history, now, exp["id"] if exp["state"] == "RUNNING" else None)
                            if iterations is not None and mine else None,
            "iterations": iterations, "agents": agents,
            "agents_blocking": any(a.get("blocking") for a in agents), "issues": exp_issues,
            "in_ledger": bool(mine)}



def valid_finish(value, now: float) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and 0 < value <= now)


def finish_to_finish_speed(history: list[dict], now: float, running_id: str | None = None) -> dict | None:
    """Latest adjacent completed pair in selected launch order, newest first."""
    rows = list(history)
    if rows and rows[0].get("id") == running_id and rows[0].get("state") == "RUNNING" and rows[0].get("ended_at") is None:
        rows.pop(0)
    if len(rows) < 2:
        return None
    newer, older = rows[:2]
    numbers = [older.get("number"), newer.get("number")]
    if (any(type(number) is not int or number <= 0 for number in numbers)
            or numbers[1] != numbers[0] + 1):
        return None
    if any(row.get("state") == "RUNNING" or not valid_finish(row.get("ended_at"), now)
           for row in (older, newer)):
        return None
    interval = newer["ended_at"] - older["ended_at"]
    if interval <= 0 or not math.isfinite(3600 / interval):
        return None
    return {"per_hour": 3600 / interval, "seconds": interval,
            "older_id": older["id"], "newer_id": newer["id"],
            "older_number": older.get("number"), "newer_number": newer.get("number")}


def finish_age(row: dict, now: float) -> str:
    if row.get("state") == "RUNNING":
        return "T-RUNNING"
    if not valid_finish(row.get("ended_at"), now):
        return "T-UNRECORDED"
    return "T-" + duration(now - row["ended_at"]) + " since finish"


def live_iteration_speed(history: list[dict], now: float, running_id: str) -> dict | None:
    """Upper bound for the next completion, not an additional completed iteration."""
    if not valid_finish(now, now) or len(history) < 2:
        return None
    current, previous = history[:2]
    if (current.get("id") != running_id or current.get("state") != "RUNNING"
            or current.get("ended_at") is not None
            or type(current.get("number")) is not int or current["number"] <= 0
            or type(previous.get("number")) is not int or previous["number"] <= 0
            or current["number"] != previous["number"] + 1
            or previous.get("state") == "RUNNING"
            or not valid_finish(previous.get("ended_at"), now)
            or not valid_finish(current.get("triggered_at"), now)
            or current["triggered_at"] < previous["ended_at"]):
        return None
    elapsed = now - previous["ended_at"]
    if elapsed <= 0 or not math.isfinite(3600 / elapsed):
        return None
    return {"per_hour": 3600 / elapsed, "seconds": elapsed,
            "previous_number": previous["number"], "running_number": current["number"]}


def average_speed_change(history: list[dict], now: float, running_id: str | None = None) -> dict:
    """Five consecutive finishes give four speeds and three percent changes."""
    rows = list(history)
    if rows and rows[0].get("id") == running_id and rows[0].get("state") == "RUNNING" and rows[0].get("ended_at") is None:
        rows.pop(0)
    rows = rows[:5]
    valid = []
    for row in rows:
        if row.get("state") == "RUNNING" or not valid_finish(row.get("ended_at"), now):
            break
        if type(row.get("number")) is not int or row["number"] <= 0:
            break
        if valid and (valid[-1]["number"] != row["number"] + 1 or valid[-1]["ended_at"] <= row["ended_at"]):
            break
        valid.append(row)
    result = {"runs": len(valid), "required": 5, "percent": None}
    if len(valid) != 5:
        return result
    chronological = list(reversed(valid))
    speeds = [3600 / (b["ended_at"] - a["ended_at"]) for a, b in zip(chronological, chronological[1:])]
    if any(not math.isfinite(value) or value <= 0 for value in speeds):
        return result
    changes = [100 * (b / a - 1) for a, b in zip(speeds, speeds[1:])]
    if any(not math.isfinite(value) for value in changes):
        return result
    mean = sum(value / 3 for value in changes)
    if math.isfinite(mean):
        result["percent"] = mean
    return result


def speed_change_text(card: dict) -> str:
    change = card.get("speed_change") or {}
    value = change.get("percent")
    if value is None:
        return f'avg Δ UNMEASURED ({change.get("runs", 0)}/5 consecutive finishes)'
    signed = f"{value:+.1f}%" if value else "0.0%"
    return f"avg Δ {signed} over last 5 completed runs"


def iteration_speed_label(card: dict) -> str:
    if card.get("experiment", {}).get("state") == "RUNNING":
        speed = card.get("live_iteration_speed")
        return (f'LIVE ≤{speed["per_hour"]:.2f}'.replace("≤0.", "≤.")
                if speed else "LIVE UNMEASURED")
    speed = card.get("iteration_speed")
    return f'{speed["per_hour"]:.2f}'.lstrip("0") if speed else "UNMEASURED"


def iteration_speed_text(card: dict) -> str:
    return f'{iteration_speed_label(card)} iter/h [{speed_change_text(card)}]'


def iteration_speed_detail(card: dict) -> str:
    speed = card.get("iteration_speed")
    pair = (f'#{speed["older_number"]} → #{speed["newer_number"]} · {duration(speed["seconds"])}'
            if speed else "UNMEASURED")
    measured = (f'{speed["per_hour"]:.2f} iter/h' if speed else "UNMEASURED")
    live = card.get("live_iteration_speed")
    prefix = (f'LIVE provisional upper bound: one future completion / {duration(live["seconds"])} '
              f'since #{live["previous_number"]} finished; #{live["running_number"]} still running. '
              if live else "LIVE provisional upper bound UNMEASURED. "
              if card.get("experiment", {}).get("state") == "RUNNING" else "")
    return (prefix + "Last completed finish-to-finish: " + pair + " · " + measured
            + "; includes work between experiments. "
            "Avg Δ: arithmetic mean of 3 successive speed percentage changes across 5 consecutive completed finishes.")


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
            "infra_unattributed_cancelled", "infra_confirmed_jobs",
            "never_started", "summary_finalized", "operator_end", "infra_unreconciled")
    return {k: exp.get(k) for k in keys}




def _issues(exp: dict) -> list[dict]:
    out = []
    controller = exp.get("controller")
    if controller and exp["state"] in UNLIVE:
        progress = exp.get("progress") or {}
        counts = (f'{progress.get("in_progress", 0)} in-progress job(s) {UNLIVE[exp["state"]]}, '
                  f'{progress.get("queued", 0)} queued' if progress else "job counts UNMEASURED")
        updated = f'summary.json last updated {pacific(controller.get("last_update_at"))}'
        if exp["state"] == "CONTROLLER LOST":
            out.append({"severity": "red", "text": f'Campaign controller lost: {controller["detail"]}; {updated}; {counts}.',
                        "owner": "parent", "action": "exact-owner recovery of its job controllers and guests; "
                        "preserve summary.json, job logs and original clocks before any relaunch"})
        else:
            out.append({"severity": "amber", "text": f'Campaign controller liveness UNVERIFIED: {controller["detail"]}; {updated}; {counts}.',
                        "owner": "parent", "action": "verify the exact controller PID/birth before treating the run as live"})
    if exp.get("infra_unattributed_cancelled"):
        out.append({"severity": "amber", "text": f'{exp["infra_unattributed_cancelled"]} cancelled jobs carry '
                    'unattributed INFRA_ERROR flags; pre-cancellation infra count is UNCLASSIFIED.',
                    "owner": "parent", "action": "retain the original failure and cancellation receipts; capture qualified pre-cancellation evidence"})
    if exp["infra_breached"]:
        progress = exp.get("progress") or {}
        terminal = (isinstance(exp.get("ended_at"), (int, float)) and exp["ended_at"] > 0
                    and bool(exp.get("end_evidence")) and bool(exp.get("scheduled_total"))
                    and progress.get("completed") == exp["scheduled_total"]
                    and all(progress.get(key) == 0 for key in ("queued", "in_progress", "unobserved"))) or bool(exp.get("operator_end"))
        label = "Infra threshold reached at termination" if terminal else "Infra stop threshold reached"
        action = ("preserve trigger and attempt evidence; /RCA each infra cluster; verify normal exact-owner release"
                  if terminal else "stop the exact owned run; /RCA each infra cluster")
        threshold_label = "threshold" if terminal else "stop at"
        out.append({"severity": "red", "text": f"{label}: {exp.get('infra_confirmed_jobs', exp['infra_jobs'])}/{exp['scheduled_total']} "
                    f"unique jobs ({threshold_label} {exp['infra_threshold']}).", "owner": "parent", "action": action})
    elif exp.get("infra_jobs"):
        out.append({"severity": "amber", "text": f"{exp['infra_jobs']} infra-failed job(s) below the stop threshold.",
                    "owner": "parent", "action": "/RCA the first authentic failure now"})
    if exp.get("unknown_jobs"):
        out.append({"severity": "amber", "text": "No recorded task result: "
                    + ", ".join(job or "job ID UNRECORDED" for job in exp["unknown_jobs"]) + ".",
                    "owner": "parent", "action": "/RCA from the job log and controller receipts"})
    if (exp.get("unreleased_jobs") and not exp.get("native_audit")
            and not exp.get("physical_closure_asof") and not exp.get("release_evidence_complete")):
        out.append({"severity": "amber", "text": "Release unverified: "
                    + ", ".join(job or "job ID UNRECORDED" for job in exp["unreleased_jobs"]) + ".",
                    "owner": "parent", "action": "native exact-owner audit before the next launch"})
    if exp.get("physical_closure_asof") or exp.get("physical_closure_waves"):
        out.append({"severity": "amber", "text": "Historical release/runtime evidence remains incomplete; separate physical closure is recorded as of its observation clock.",
                    "owner": "parent", "action": "retain original INFRA, runtime capture gaps and historical release counts; no historical success credit"})
    for item in exp["lifecycle"]:
        if item["state"] == "fail" and item.get("issue", True):
            out.append({"severity": "red", "text": f"{item['label']}: {item['detail']}.", "owner": "parent",
                        "action": "exact-owner recovery through the printed CLI"})
        elif item["state"] == "warn" and item.get("issue", True) and not re.sub(r"^Wave \d+: ", "", item["label"]).startswith("Guests released"):
            out.append({"severity": "amber", "text": f"{item['label']}: {item['detail']}.", "owner": "parent",
                        "action": "reconcile from the recorded receipts before the next launch"})
    return out


# ---------------------------------------------------------------- HTML


# Browser clock updates only the age label; producer finish timestamps stay fixed.
FINISH_AGE_SCRIPT = r"""
function finishAgeLabel(end, now) {
  if (!Number.isFinite(end) || end <= 0 || !Number.isFinite(now) || end > now) return 'T-UNRECORDED';
  const s = Math.floor(now - end + 0.5), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600);
  const m = Math.floor(s % 3600 / 60), sec = s % 60, pad = n => String(n).padStart(2, '0');
  const age = d ? `${d}d${h}h` : h ? `${h}h${pad(m)}m` : m ? `${m}m${pad(sec)}s` : `${sec}s`;
  return `T-${age} since finish`;
}
function updateFinishAges() {
  const now = Date.now() / 1000;
  document.querySelectorAll('[data-finished-at]').forEach(node => {
    node.textContent = finishAgeLabel(Number(node.dataset.finishedAt), now);
  });
}
updateFinishAges();
setInterval(updateFinishAges, 1000);
"""

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
.iteration-speed{font-size:26px;font-weight:800;color:var(--run);padding:10px 12px;border:2px solid var(--run);border-radius:10px;margin-bottom:10px;overflow-wrap:anywhere}
.global-cake{display:flex;align-items:center;gap:18px;flex-wrap:wrap}.global-cake svg{width:264px;max-width:100%;flex:0 1 264px}.global-cake text{fill:var(--fg);font-size:12px}.global-cake .cake-count{font-size:30px;font-weight:750}.global-cake>div{flex:1 1 220px}
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
.legend span{white-space:nowrap}.note{font-size:12px;color:var(--muted);margin-top:4px;overflow-wrap:anywhere}
.causes{display:grid;grid-template-columns:auto minmax(40px,90px) minmax(0,1fr);gap:3px 8px;align-items:center;font-size:13px}
.causes .n{font-weight:700;text-align:right;font-variant-numeric:tabular-nums}.causes .t,.clip{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.causes .meter{height:6px;border-radius:3px;background:var(--line);overflow:hidden}.causes .meter i{display:block;height:100%}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0;font-size:13px}dt{color:var(--muted)}
dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
ul{list-style:none;margin:0;padding:0;font-size:13px}li{margin:2px 0;overflow-wrap:anywhere}
.hist{border-top:1px solid var(--line);padding:6px 0;font-size:13px}.hist:first-of-type{border-top:0}
.hist .l1{display:flex;flex-wrap:wrap;gap:2px 10px;font-weight:650}.hist .l2,.hist .l3{color:var(--muted);overflow-wrap:anywhere}
.hist .l3{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}
.trend svg{display:block;width:100%;height:auto;max-height:300px}.trend text{fill:var(--fg);font-size:15px}.trend .grid{stroke:var(--line);stroke-width:1}.trend .path{fill:none;stroke:var(--ok);stroke-width:2}.trend .dot{fill:var(--ok);stroke:var(--ok);stroke-width:2}.trend .dot.running{fill:light-dark(#fff,#0d1117)}
[data-section="global-trend"] svg{max-height:none}.trend .point-label{font-size:18px;font-weight:650}
@media(max-width:500px){.trend .point-label{font-size:26px}}
.agents{display:grid;grid-template-columns:1fr auto auto auto;gap:2px 10px;font-size:13px;font-variant-numeric:tabular-nums}
.agents .h{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}.agents .life{text-align:right}
.agents .why{grid-column:1/-1;color:var(--bad);font-size:12px;padding-left:18px}
@media (max-width:420px){.causes{grid-template-columns:auto 36px minmax(0,1fr)}.tile .v{font-size:20px}.agents{grid-template-columns:repeat(3,minmax(0,1fr));gap:4px 6px}.agents>span{min-width:0;overflow-wrap:anywhere}.agents>.work{grid-column:1/-1;margin-top:4px}}
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


def _infra_text(exp, descent=False) -> tuple[str, str, str]:
    if exp.get("infra_unattributed_cancelled"):
        return "UNCLASSIFIED", "warn", (f'{exp.get("infra_confirmed_jobs", 0)} confirmed; '
                                        f'{exp["infra_unattributed_cancelled"]} cancelled flags lack attribution')
    if exp.get("infra_unreconciled"):
        return "UNRECONCILED", "warn", "original returned-task evidence is incomplete"
    if descent:
        jobs, total = exp.get("infra_jobs"), exp.get("scheduled_total")
        if type(jobs) is not int or type(total) is not int or total <= 0 or not 0 <= jobs <= total:
            return "UNMEASURED", "warn", "original scheduled job denominator unavailable"
        return pct(jobs, total), "ok" if jobs / total < .05 else "bad", f"{jobs}/{total} original scheduled jobs"
    attempts, infra = exp.get("terminal_attempts"), exp.get("infra_attempts")
    if not attempts:
        jobs = exp.get("infra_jobs")
        if isinstance(jobs, int) and not exp.get("outcomes"):
            return f"{jobs} jobs", "bad" if jobs else "ok", "live infra counter; NO TERMINAL ATTEMPTS"
        return "NO TERMINAL ATTEMPTS", "na", ""
    cls = "bad" if exp.get("infra_breached") else "warn" if infra else "ok"
    return pct(infra, attempts), cls, f"{infra}/{attempts} terminal attempts"


def _rate_text(card) -> str:
    """Observed launch rate remains numeric during the first goal day."""
    rate = card.get("rate")
    if not rate:
        return "experiments/day UNRECORDED (no ledger launch)"
    launches = f'{rate["launches"]} launch{"es" if rate["launches"] != 1 else ""}'
    if rate.get("per_day") is None:
        return f'experiments/day UNMEASURED (no elapsed goal time) · {launches}'
    text = f'{rate["per_day"]:.1f} experiments/day · {launches} / {rate["days"]:.2f} d'
    if rate.get("warming"):
        text += ' · warming ' + duration(card["generated_at"] - rate["goal_started_at"])
    if rate.get("backfilled"):
        text += " (lower bound)"
    return text


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
           f'<style>{CSS}</style></head><body><main data-descend="{str(card.get("iterations") is not None).lower()}">']
    # Descent speed is distinct from the secondary generic launch-rate metric.
    if card.get("iterations") is not None:
        change = (card.get("speed_change") or {}).get("percent")
        cls = "ok" if change is not None and change > 0 else "bad" if change is not None and change < 0 else "warn" if change is None else "muted"
        rate_text = iteration_speed_label(card)
        out.append('<section data-section="iteration-speed" class="iteration-speed" title="'
                   + e(iteration_speed_detail(card)) + '">' + e(rate_text) + ' iter/h '
                   + f'<span class="{cls}">[{e(speed_change_text(card))}]</span>'
                   + '<div class="sub">' + e(iteration_speed_detail(card)) + '</div></section>')
    if card.get("iterations") is not None:
        out.append(global_mod.render(card.get("global_progress")))
    # Header
    since = card.get("since") or {}
    since_html = (_span("run", "RUNNING") if since.get("state") == "RUNNING" else
                  f'<b>{e(duration(since["age"]))}</b> ago · {e(since["label"])} ended {e(pacific(since["at"]))}'
                  if since.get("state") == "ENDED" else _span("warn", "END UNRECORDED"))
    rate_html = _span("warn" if not rate or rate.get("warming") else "", _rate_text(card))
    goal_elapsed = (f' · goal elapsed {e(duration(card["generated_at"] - rate["goal_started_at"]))}' if rate else "")
    out.append('<section data-section="header"><div class="title">'
               f'<span>🧪 Experiment {e(number)}</span>'
               f'<span class="badge {STATE_CLASS[state]}">{STATE_ICON[state]} {e(state)}</span>'
               + (f'<span class="sub {STATE_CLASS[state]}">{e(exp["state_reason"])}</span>' if state in UNLIVE else "") + "</div>"
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
    infra_value, infra_cls, infra_sub = _infra_text(exp, card.get("iterations") is not None)
    if card.get("iterations") is not None:
        if scored:
            pass_sub = f'{o["PASS"]}/{scored} scored (PASS + FAIL)'
        pass_cls = "warn" if pass_rate is None else "ok" if pass_rate > .95 else "warn" if pass_rate > .80 else "bad"
    progress = exp.get("progress")
    end_or_now = exp.get("ended_at") or (card["generated_at"] if state == "RUNNING" else None)
    elapsed = duration(end_or_now - exp["triggered_at"]) if end_or_now and exp.get("triggered_at") else "UNMEASURED"
    window = f'exec window {duration(exp["window_s"])}' if exp.get("window_s") else "exec window UNRECORDED"
    threshold = exp.get("infra_threshold")
    tiles = []
    for label, key in (("QUEUED", "queued"), (UNLIVE.get(state, "IN_PROGRESS"), "in_progress"), ("COMPLETED", "completed")):
        count = str(progress[key]) if progress else "UNMEASURED"
        detail = "logical tasks" if progress else "no job records yet"
        if label == "COMPLETED" and progress:
            detail = f'of {total} scheduled' if total else "recorded terminal outcomes"
        if exp.get("never_started"):
            detail += " · never started"
        tiles.append(f'<div class="tile"><div class="k">{label}</div><div class="v {(STATE_CLASS[state] if state in UNLIVE and key == "in_progress" else "run") if progress else "warn"}">{e(count)}</div><div class="s">{e(detail)}</div></div>')
    if card.get("iterations") is not None:
        tiles += [
            f'<div class="tile"><div class="k">✅ Pass</div><div class="v {pass_cls}">{e(pass_value)}</div><div class="s">{e(pass_sub)}</div></div>',
            f'<div class="tile"><div class="k">🧯 Infra</div><div class="v {infra_cls}">{e(infra_value)}</div><div class="s">{e(infra_sub)}</div></div>',
            f'<div class="tile"><div class="k">⏱ Elapsed</div><div class="v">{e(elapsed)}</div><div class="s">{e(window)}</div></div>',
        ]
    out.append('<section data-section="kpis"><div class="kpis">' + "".join(tiles) + '</div></section>')
    threshold = exp.get("infra_threshold")
    # Outcomes
    harness_text, harness_cls = _harness(exp)
    legend = []
    labels = {"HARNESS": "HARNESS FAILURE", "INFRA": "INFRA FAILURE", "AGENT FAIL": "AGENT FAILURE"}
    for category in ("PASS", "HARNESS", "INFRA", "AGENT FAIL", "UNKNOWN", "CANCELLED", "SKIPPED"):
        count = (o or {}).get(category, 0)
        always = category in ("PASS", "HARNESS", "INFRA")
        if not always and not count:
            continue
        if category == "HARNESS":
            legend.append(f'<span class="{harness_cls}">■ HARNESS FAILURE {e(harness_text)}</span>')
            continue
        if category == "INFRA" and exp.get("infra_unattributed_cancelled"):
            legend.append('<span class="warn">■ INFRA UNCLASSIFIED</span>')
            continue
        value = "UNRECONCILED" if category == "INFRA" and exp.get("infra_unreconciled") else f"{count} · {pct(count, total)}" if o and total else "UNMEASURED"
        cls = "warn" if not o or (category == "INFRA" and exp.get("infra_unreconciled")) else "ok" if category == "INFRA" and not count else CATEGORY_CLASS[category]
        legend.append(f'<span class="{cls}">■ {labels.get(category, category)} {e(value)}</span>')
    pending = (progress["queued"] + progress["in_progress"] + progress["unobserved"]) if progress else 0
    if pending:
        legend.append(f'<span class="na">■ never started {pending}</span>' if exp.get("never_started")
                      else f'<span class="run">■ not terminal {pending}</span>')
    stop_note = (f'Stop at {threshold}/{total} unique infra-failed jobs (5% of scheduled); now {exp["infra_jobs"]}.'
                 if threshold and isinstance(exp.get("infra_jobs"), int) else
                 f"Stop at {threshold}/{total} unique infra-failed jobs (5% of scheduled)." if threshold
                 else "Stop at 5% of the original scheduled total; scheduled total UNRECORDED.")
    source = f' Source: {e(exp["rows_source"])}.' if exp.get("rows_source") else ""
    links = "".join(
        f'<div class="note"><span class="{CATEGORY_CLASS.get(t["outcome"], "run")}">{e(t["outcome"])}</span> {e(t["task"])} · '
        + (e(t["agent_url"]) if t.get("agent_url")  # text, not href: cards load nothing remote
           else e(t["agent_id"]) + " · FE link UNRECORDED" if t.get("agent_id") else "agent UNRECORDED") + '</div>'
        for t in exp.get("task_links") or [])
    if exp.get("recovery_sha256"):
        source += f' Recovery SHA256: {e(exp["recovery_sha256"])}; original observations retained in JSON.'
    if o and exp.get("scored") and card.get("iterations") is None:
        source += f' PASS {o["PASS"]}/{exp["scored"]} scored.'
    out.append(f'<section data-section="outcomes"><h2>Outcomes</h2>{_bar(o, total) if card.get("iterations") is None else ""}'
               f'<div class="legend">{"".join(legend)}</div><div class="note">{e(stop_note)}{source}</div>{links}</section>')
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
    timing = [("Triggered", e(pacific(exp.get("triggered_at")))), ("Elapsed", e(elapsed)), ("Execution window", e(window))]
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
        timing.append(("💲 Cost", f'{e(money(cost["metered_usd"]))} {e(cost.get("scope", "agent LLM metered"))} · {cost["n"]}/{cost["of"]} runs{unmetered}'))
    else:
        timing.append(("💲 Cost", _span("warn", "UNMETERED")))
    timing.append(("Cache", f'provider prompt-cache share avg {cache["avg"] * 100:.1f}% · {cache["n"]}/{cache["of"]} runs'
                   if cache else _span("warn", "UNMEASURED")))
    timing.append(("LLM latency", e(global_mod.latency_text(card.get("observed_telemetry"))) if card.get("iterations") is not None else _span("warn", "UNMEASURED")))
    out.append('<section data-section="timing"><h2>Timing · Cost</h2><dl>'
               + "".join(f"<dt>{k}</dt><dd>{v}</dd>" for k, v in timing) + "</dl></section>")
    # Lifecycle
    items = "".join(f'<li class="{ {"ok": "ok", "fail": "bad", "warn": "warn", "pending": "run"}[i["state"]] }">'
                    f'{LIFE_ICON[i["state"]]} {e(i["label"])}' + (f' <span class="muted">· {e(i["detail"])}</span>' if i["detail"] else "")
                    + "</li>" for i in exp["lifecycle"])
    if card.get("iterations") is None:
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
    reason = exp.get("state_reason") or {"RUNNING": "observing; card every 15 min", "COMPLETE": "results final, resources released"}.get(state, "")
    out.append(f'<footer data-section="footer"><span class="{STATE_CLASS[state]}">{STATE_ICON[state]} {e(state)}</span>'
               + (f" · {e(reason)}" if reason else "") +
               f'<div class="gen">Rendered by scripts/run-bench scorecard ({FORMAT}) at {e(pacific(card["generated_at"]))} from recorded artifacts.</div></footer>')
    data = json.dumps(_public(card), sort_keys=True, allow_nan=False).replace("</", "<\\/")
    out.append(f'</main><script type="application/json" id="scorecard-data">{data}</script>')
    if card.get("iterations") is not None:
        out.append('<script>' + FINISH_AGE_SCRIPT + '</script>')
    out.append('</body></html>\n')
    return "".join(out)


def _public(card):
    exp = {k: v for k, v in card["experiment"].items() if k not in ("unknown_jobs", "unreleased_jobs", "_telemetry_jobs")}
    return dict(card, experiment=exp)


def _agents_html(card) -> str:
    agents = card.get("agents") or []
    if not agents:
        body = '<div class="note">No active agents</div>'
    else:
        cells = ['<span class="h work">Agent / work</span><span class="h">Tokens</span><span class="h">15m tok/min</span><span class="h life">Life</span>']
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
            cells.append(f'<span class="{cls} work">{e(icon)} {e(a["name"])}' + (f' / {e(a["work"])}' if a.get("work") else "") + "</span>"
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
            pass_text = f'PASS {o["PASS"]}/{scored} ({pct(o["PASS"], scored)})' if scored else "NO SCORED TASKS"
            infra_text = ("INFRA UNCLASSIFIED" if h.get("infra_unattributed_cancelled") else
                          "INFRA UNRECONCILED" if h.get("infra_unreconciled") else "NO TERMINAL ATTEMPTS" if not h.get("terminal_attempts") else f'INFRA {h["infra_jobs"]}/{total}' if isinstance(h.get("infra_jobs"), int) and total else "INFRA UNMEASURED")
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
                      + ((f'<div class="l2 finish-age" data-finished-at="{h["ended_at"]}">{e(finish_age(h, card["generated_at"]))}</div>'
                          if h["state"] != "RUNNING" and valid_finish(h.get("ended_at"), card["generated_at"])
                          else f'<div class="l2">{e(finish_age(h, card["generated_at"]))}</div>')
                         if card.get("iterations") is not None else "")
                      + f'<div class="l2">{e(pacific(h.get("triggered_at")))} → {e(end)} · {e(prog_text)} · {e(cost_text)}</div>'
                      f'<div class="l3">{_bar(o, total, mini=True, label=str(number) + " outcomes") if card.get("iterations") is None else ""}<span>{e(stats)}</span></div>'
                      + (f'<div class="l2 clip" title="{e(h["state_reason"])}">{e(h["state_reason"])}</div>'
                         if h.get("state_reason") and state != "COMPLETE" else "")
                      + "</div>")
    if not blocks:
        blocks.append('<div class="note">No launched experiments recorded.</div>')
    return _trend_html(card) + f'<section data-section="history"><h2>LAST {card.get("history_limit", 3)} EXPERIMENTS</h2>{"".join(blocks)}</section>'


def _trend_html(card: dict) -> str:
    if card.get("iterations") is not None:
        return global_mod.curve(card.get("global_progress")) if card["iterations"] > 3 else ""
    trend = card.get("trend") or []
    if not trend or (len(trend) <= 3 and (card.get("iterations") or 0) <= 3):
        return ""
    width, height, left, top = 600, 150, 34, 10
    usable_width, usable_height = width - left - 10, height - top - 22
    x = lambda i: left + (usable_width / 2 if len(trend) == 1 else usable_width * i / (len(trend) - 1))
    y = lambda rate: top + usable_height * (1 - rate)
    parts = [f'<section data-section="trend" class="trend"><h2>SUCCESS RATE OVER TIME</h2>',
             f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="Task pass percentage by experiment; gaps mean no scored tasks">',
             f'<line class="grid" x1="{left}" y1="{y(1):.1f}" x2="{width-10}" y2="{y(1):.1f}"/>',
             f'<line class="grid" x1="{left}" y1="{y(0):.1f}" x2="{width-10}" y2="{y(0):.1f}"/>',
             f'<text x="0" y="{y(1)+4:.1f}">100%</text><text x="8" y="{y(0)+4:.1f}">0%</text>']
    for i in range(1, len(trend)):
        a, b = trend[i-1], trend[i]
        if a["rate"] is not None and b["rate"] is not None:
            parts.append(f'<path class="path" d="M {x(i-1):.1f} {y(a["rate"]):.1f} L {x(i):.1f} {y(b["rate"]):.1f}"/>')
    for i, item in enumerate(trend):
        if item["rate"] is None:
            continue
        label = f'Experiment #{item["number"]}: {item["rate"]*100:.1f}%'
        parts.append(f'<circle class="dot{" running" if item["running"] else ""}" cx="{x(i):.1f}" cy="{y(item["rate"]):.1f}" r="4"><title>{e(label)}</title></circle>')
    parts.append('</svg><div class="note">Task pass % per run · hollow point = running · gap = no scored tasks</div></section>')
    return "".join(parts)


# ---------------------------------------------------------------- text

def render_text(card: dict) -> str:
    exp = card["experiment"]
    o = exp.get("outcomes")
    total = exp.get("scheduled_total") or 0
    state = exp["state"]
    rate = card.get("rate")
    lines = [f'🧪 EXPERIMENT #{card["number"] or "UNRECORDED"} · {STATE_ICON[state]} {state}'
             + (f' · {exp["state_reason"]}' if state in UNLIVE else ""),
             f'{exp["label"]} · {total or "UNRECORDED"} scheduled · {exp.get("surface")} · src {short_ref(exp.get("source_ref"))}',
             f'Triggered {pacific(exp.get("triggered_at"))}',
             _rate_text(card)]
    if card.get("iterations") is not None:
        lines.insert(0, iteration_speed_detail(card))
        lines.insert(0, iteration_speed_text(card))
    since = card.get("since") or {}
    lines.append("Since last benchmark ended: " + ("RUNNING" if since.get("state") == "RUNNING" else
                 f'{duration(since["age"])} ({since["label"]})' if since.get("state") == "ENDED" else "END UNRECORDED"))
    prog = exp.get("progress")
    lines.append(f'QUEUED {prog["queued"]} · {UNLIVE.get(state, "IN_PROGRESS")} {prog["in_progress"]} · COMPLETED {prog["completed"]}/{total}'
                 + (" · never started (start barrier aborted before release)" if exp.get("never_started") else "")
                 if prog else "QUEUED / IN_PROGRESS / COMPLETED UNMEASURED")
    harness, _ = _harness(exp)
    infra_value, _, infra_sub = _infra_text(exp, card.get("iterations") is not None)
    if card.get("iterations") is not None:
        lines.append(f"Infra {infra_value} · {infra_sub}")
    if o:
        infra = ("UNCLASSIFIED" if exp.get("infra_unattributed_cancelled") else
                 "UNRECONCILED" if exp.get("infra_unreconciled") else str(o["INFRA"]))
        lines.append(f'PASS {o["PASS"]} · HARNESS FAILURE {harness} · INFRA FAILURE {infra}')
        extra = [f'{"AGENT FAILURE" if c == "AGENT FAIL" else c} {o[c]}' for c in ("AGENT FAIL", "UNKNOWN", "CANCELLED", "SKIPPED") if o.get(c)]
        if extra:
            lines.append(" · ".join(extra))
        if exp.get("scored"):
            lines.append(f'Pass rate {pct(o["PASS"], exp["scored"])} ({o["PASS"]}/{exp["scored"]} scored)')
        if exp.get("terminal_attempts"):
            lines.append(f'Infra attempts {exp.get("infra_attempts", 0)}/{exp["terminal_attempts"]}')
    else:
        lines.append(f"PASS UNMEASURED · HARNESS FAILURE {harness} · INFRA FAILURE UNMEASURED")
    if exp.get("infra_threshold"):
        lines.append(f'Stop at {exp["infra_threshold"]}/{total} unique infra-failed jobs (5%)')
    for cat, text, count in exp.get("reasons") or []:
        lines.append(f"  {count:>4} {cat}: {text}")
    if exp.get("task_links"):
        lines.append("TASKS")
        lines += [f'  {t["outcome"]} {t["task"]} · ' + (t.get("agent_url") or (f'{t["agent_id"]} · FE link UNRECORDED'
                  if t.get("agent_id") else "agent UNRECORDED")) for t in exp["task_links"]]
    cost = exp.get("cost") or {}
    lines.append("Cost " + (f'{money(cost["metered_usd"])} metered ({cost["n"]}/{cost["of"]})' if cost.get("metered_usd") is not None else "UNMETERED")
                 + (" · " + "/".join(cost["unmetered"]) + " UNMETERED" if cost.get("unmetered") else ""))
    cache = exp.get("cache")
    lines.append("Cache " + (f'provider prompt-cache share avg {cache["avg"] * 100:.1f}% ({cache["n"]}/{cache["of"]})' if cache else "UNMEASURED")
                 + (" · LLM latency UNMEASURED" if card.get("iterations") is None else ""))
    if card.get("iterations") is None:
        lines.append("Lifecycle")
        lines += [f'  {LIFE_ICON[i["state"]]} {i["label"]}' + (f' · {i["detail"]}' if i["detail"] else "") for i in exp["lifecycle"]]
    else:
        gp = card.get("global_progress")
        lines.append(f'GLOBAL latest {gp["k"] if gp else "X"} scored runs (historical outcomes): ' +
                     (f'{gp["slot_counts"]} / {gp["slot_count"]} individual run slots; final-source-qualified {gp["final_source_qualified"]}/{gp["task_count"]}' if gp else "UNRECORDED"))
        lines.append("LLM latency " + global_mod.latency_text(card.get("observed_telemetry")))
        lines.append("GLOBAL SUCCESS RATE OVER TIME: " + (" · ".join(
            f'{r["id"]}: PASS {r["slot_counts"]["PASS"] / gp["slot_count"] * 100:.1f}% · FAIL {r["slot_counts"]["FAIL"] / gp["slot_count"] * 100:.1f}% of {gp["slot_count"]} slots' if r.get("slot_counts") is not None else f'{r["id"]}: gap'
            for r in (gp or {}).get("history", [])) or "UNMEASURED"))
    if card.get("iterations") is None and card.get("trend") and (len(card["trend"]) > 3 or (card.get("iterations") or 0) > 3):
        lines.append("SUCCESS RATE OVER TIME")
        lines.append("  " + " · ".join(f'#{t["number"]} {t["rate"]*100:.1f}%{" (running)" if t["running"] else ""}'
                                       if t["rate"] is not None else f'#{t["number"]} gap' for t in card["trend"]))
    lines.append(f'LAST {card.get("history_limit", 3)} EXPERIMENTS')
    for h in card.get("history") or []:
        ho = h.get("outcomes") or {}
        age = (" · " + finish_age(h, card["generated_at"])) if card.get("iterations") is not None else ""
        lines.append(f'  #{h.get("number") or "?"} {STATE_ICON[h["state"]]} {h["state"]} {h["label"]}{age} · '
                     f'{pacific(h.get("triggered_at"))} → '
                     + ("RUNNING" if h["state"] == "RUNNING" and not h.get("ended_at") else pacific(h["ended_at"], date=False) if h.get("ended_at") else "END UNRECORDED")
                     + ((f' · PASS {ho.get("PASS")}/{h.get("scored")}' if h.get("scored") else " · NO SCORED TASKS")
                        + (" · INFRA UNCLASSIFIED" if h.get("infra_unattributed_cancelled") else
                           " · INFRA UNRECONCILED" if h.get("infra_unreconciled") else " · NO TERMINAL ATTEMPTS" if not h.get("terminal_attempts") else f' · INFRA {h["infra_jobs"]}/{h["scheduled_total"]}' if isinstance(h.get("infra_jobs"), int) and h.get("scheduled_total") else " · INFRA UNMEASURED")
                        + (f' · {ho["CANCELLED"]} cancelled' if ho.get("CANCELLED") else "")
                        + (f' · {h["scheduled_total"]} never started' if h.get("never_started") else "") if ho else " · UNMEASURED")
                     + (f' · {h["state_reason"]}' if h.get("operator_end") else ""))
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
    descent = 'data-descend="true"' in raw
    missing = [s for s in REQUIRED_SECTIONS if s not in parser.sections and not (descent and s == "lifecycle")]
    if missing:
        problems.append("missing sections: " + ", ".join(missing))
    text = " ".join(" ".join(parser.text).split())
    for label in REQUIRED_TEXT:
        if label not in text and not (descent and label == "Lifecycle"):
            problems.append(f"missing required field: {label}")
    if not re.search(r"LAST (3|10) EXPERIMENTS", text):
        problems.append("missing required experiment history heading")
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
        "    For /descend: publish every 15 minutes on original +900-second anchors, and on state changes.",
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
    parser.add_argument("--operator-end-receipt", type=Path, action="append", help="explicit hash-bound campaign operator-end binding (repeat for history)")
    parser.add_argument("--goal", help="experiment goal for numbering and history")
    parser.add_argument("--history-id", action="append", help="exact recorded experiment ID in this descent (repeat across cohort rotations)")
    parser.add_argument("--iterations", type=int, help="completed descent iterations; controls the >3 trend threshold")
    parser.add_argument("--global-acceptance", type=Path, help="full selected-suite rolling acceptance ledger")
    parser.add_argument("--selected-tasks", type=Path, help="persisted ordered descend-selected-tasks-v1 manifest")
    parser.add_argument("--selected-tasks-sha256", help="SHA256 of exact selected manifest bytes")
    parser.add_argument("--global-runs", type=int, help="required historical scored runs per selected task; must match artifact k")
    parser.add_argument("--global-history", type=Path, help="verified full-suite history snapshots; missing snapshots remain gaps")
    parser.add_argument("--telemetry-receipt-sha256", help="expected SHA256 from the original replay custodian")
    parser.add_argument("--telemetry-receipt", type=Path, help="hash-bound receipt from the native-event producer")
    parser.add_argument("--telemetry-membership", type=Path, help="original job/run/source membership projection")
    parser.add_argument("--telemetry-sources", type=Path, help="original export manifest, summary and native-log-index directories by shard")
    parser.add_argument("--telemetry", type=Path, help="matched original experiment cost and native LLM timing receipts")
    parser.add_argument("--now", type=float, help=argparse.SUPPRESS)
    parser.add_argument("--shallow", action="store_true", help="skip reading verified export archives")
    parser.add_argument("--recovered-results", type=Path, help="hash-bound recovered classification sidecar")
    parser.add_argument("--recovered-sha256", help="expected SHA256 of the recovery sidecar")
    parser.add_argument("--write-recovered-results", type=Path, help="validate and create a recovery sidecar; never changes run receipts")
    parser.add_argument("--results-csv", type=Path)
    parser.add_argument("--accepted-grades", type=Path)
    parser.add_argument("--recovery-jobs", type=Path)
    parser.add_argument("--recovery-hub", type=Path)
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
    if args.write_recovered_results:
        if args.run_dir.resolve() in args.write_recovered_results.resolve().parents:
            parser.error("recovery sidecar must be outside the original run; receipts are read-only")
        if not all((args.results_csv, args.accepted_grades, args.recovery_jobs, args.recovery_hub)):
            parser.error("recovery import requires results CSV, accepted grades, jobs and Hub snapshots")
        recovery = runpy.run_path(str(HERE / "cloudbench-recovered-results.py"))
        value = recovery["prepare"](args.run_dir, args.results_csv, args.accepted_grades, args.recovery_jobs, args.recovery_hub)
        raw = (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()
        with os.fdopen(os.open(args.write_recovered_results, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
            output.write(raw)
        print(json.dumps({"recovered_results": str(args.write_recovered_results), "sha256": hashlib.sha256(raw).hexdigest()}))
        return 0
    if any((args.results_csv, args.accepted_grades, args.recovery_jobs, args.recovery_hub)):
        parser.error("recovery source arguments require --write-recovered-results")
    if bool(args.recovered_results) != bool(args.recovered_sha256):
        parser.error("--recovered-results requires --recovered-sha256")
    agents = read_json(args.agents) if args.agents else None
    issues = read_json(args.issues) if args.issues else None
    try:
        card = build(args.run_dir, ledger=args.ledger or ledger_mod.ledger_path(HERE.parent), goal=args.goal,
                     iterations=args.iterations, operator_end_receipts=args.operator_end_receipt,
                     history_ids=args.history_id,
                     global_acceptance=args.global_acceptance, selected_tasks=args.selected_tasks,
                     selected_tasks_sha256=args.selected_tasks_sha256, global_history=args.global_history, telemetry=args.telemetry, global_runs=args.global_runs, telemetry_membership=args.telemetry_membership, telemetry_sources=args.telemetry_sources, telemetry_receipt=args.telemetry_receipt, telemetry_receipt_sha256=args.telemetry_receipt_sha256,
                     agents=agents if isinstance(agents, list) else None,
                     issues=issues if isinstance(issues, list) else None, now=args.now, deep=not args.shallow,
                     recovered_results=args.recovered_results, recovered_sha256=args.recovered_sha256)
    except (StaleOverlay, ValueError) as error:
        print(f"scorecard refused: {error}", file=sys.stderr)
        return 1
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
