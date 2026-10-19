#!/usr/bin/env python3
"""Weekly business review card for /biz-review.

collect  -> .context/biz-review/<stamp>/data.json   (read-only: git, prod DB, provider APIs)
render   -> .context/biz-review/<stamp>/index.html  (data.json + narrative.json written by the agent)

Credentials come from back-end/.env and agents/.env; values are never printed.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from biz_review_browsers import e2b_cost, kernel_cost, steel_cost
from biz_review_browsers import self_test as browsers_self_test
from biz_review_fly import fly_cost
from biz_review_lantern import lantern_cost
from biz_review_lantern import self_test as lantern_self_test
from biz_review_llm import cerebras_cost
from biz_review_llm import self_test as llm_self_test
from biz_review_search import search_costs
from biz_review_search import self_test as search_self_test
from biz_review_fly import self_test as fly_self_test

ROOT = Path(__file__).resolve().parent.parent
OUT_ROOT = ROOT / ".context" / "biz-review"
OPENROUTER_SNAPSHOTS = OUT_ROOT / "openrouter-usage.jsonl"
PACIFIC = ZoneInfo("America/Los_Angeles")
UA = "curl/8.5.0"

# Monthly list prices for fixed plans that expose no billing API. Prorated by day.
RENDER_PLAN_MONTHLY_USD = {
    "free": 0, "starter": 7, "standard": 25, "pro": 85,
    "pro_plus": 175, "pro_max": 225, "pro_ultra": 450,
}
SUPABASE_PRO_PLAN_MONTHLY_USD = 25
SUPABASE_PROJECT_REF = "kzlurqihzaolhzsbkctf"
DAYS_PER_MONTH = 30.4375


# ── helpers ──────────────────────────────────────────────────────────────────

def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for rel in ("agents/.env", "back-end/.env"):
        path = ROOT / rel
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            match = re.match(r"^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$", line)
            if match:
                env[match.group(1)] = match.group(2).strip().strip('"').strip("'")
    env.update({k: v for k, v in os.environ.items() if k in env})
    return env


def http_get(url: str, headers: dict[str, str], timeout: int = 60) -> tuple[int, str]:
    request = urllib.request.Request(url, headers={"User-Agent": UA, **headers})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, ""
    except (urllib.error.URLError, TimeoutError) as error:
        return 0, str(error)


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def git(*args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(ROOT), *args], check=True, capture_output=True, text=True
    ).stdout


def unavailable(reason: str) -> dict:
    return {"status": "unavailable", "detail": reason}


# ── git ──────────────────────────────────────────────────────────────────────

PR_SUBJECT = re.compile(r"Merge pull request #(\d+)|\(#(\d+)\)")


def collect_git(start: datetime, end: datetime) -> dict:
    subprocess.run(["git", "-C", str(ROOT), "fetch", "-q", "origin", "main"], check=False)
    ref = "origin/main"
    log = git("log", ref, "--first-parent", f"--since={iso(start)}", f"--until={iso(end)}",
              "--format=%H%x1f%cI%x1f%s%x1f%b%x1e")
    base = git("rev-list", "-1", "--first-parent", f"--before={iso(start)}", ref).strip()
    head = git("rev-list", "-1", "--first-parent", f"--before={iso(end)}", ref).strip()
    commits = int(git("rev-list", "--count", f"{base}..{head}").strip()) if base else 0
    prs, direct = [], []
    for record in filter(None, (r.strip("\n") for r in log.split("\x1e"))):
        sha, when, subject, body = (record.split("\x1f") + ["", "", "", ""])[:4]
        stat = git("diff", "--shortstat", f"{sha}^1", sha).strip() if sha else ""
        files = int(m.group(1)) if (m := re.search(r"(\d+) files? changed", stat)) else 0
        match = PR_SUBJECT.search(subject)
        entry = {"sha": sha[:9], "mergedAt": when, "files": files, "subject": subject}
        if match:
            number = int(match.group(1) or match.group(2))
            title = body.strip().splitlines()[0] if match.group(1) and body.strip() else subject
            prs.append({**entry, "number": number, "title": re.sub(r"\s*\(#\d+\).*$", "", title)})
        else:
            direct.append(entry)
    return {"status": "ready", "prsMerged": len(prs), "commitsMerged": commits,
            "directCommits": len(direct), "prs": prs, "direct": direct}


# ── costs ────────────────────────────────────────────────────────────────────

def vercel_cost(env: dict, start: datetime, end: datetime) -> dict:
    headers = {"Authorization": f"Bearer {env.get('VERCEL_TOKEN', '')}"}
    status, body = http_get("https://api.vercel.com/v2/teams", headers)
    if status != 200:
        return unavailable(f"Vercel teams HTTP {status}")
    team = json.loads(body)["teams"][0]["id"]
    query = urllib.parse.urlencode({"teamId": team, "from": iso(start), "to": iso(end)})
    status, body = http_get(f"https://api.vercel.com/v1/billing/charges?{query}", headers, 120)
    if status != 200:
        return unavailable(f"Vercel charges HTTP {status}")
    billed, services = 0.0, {}
    for line in filter(None, body.splitlines()):
        row = json.loads(line)
        cost = float(row.get("BilledCost") or 0)
        billed += cost
        services[row.get("ServiceName", "other")] = services.get(row.get("ServiceName", "other"), 0) + cost
    top = sorted(services.items(), key=lambda kv: -kv[1])[:3]
    return {"status": "ready", "basis": "billed", "usd": billed,
            "detail": ", ".join(f"{name} ${value:,.2f}" for name, value in top if value > 0)}


def openrouter_cost(env: dict, start: datetime, now: datetime) -> dict:
    """Billed OpenRouter spend. Exact per-day billing with OPENROUTER_MANAGEMENT_KEY;
    otherwise an exact lifetime-usage delta once a snapshot predates the window;
    otherwise this month's billed daily average × window days."""
    days = (now - start).total_seconds() / 86_400
    management = env.get("OPENROUTER_MANAGEMENT_KEY", "")
    if management:
        status, body = http_get("https://openrouter.ai/api/v1/activity", {"Authorization": f"Bearer {management}"})
        if status == 200:
            rows = json.loads(body)["data"]
            first_day, last_day = start.date().isoformat(), now.date().isoformat()
            usd = sum(float(r.get("usage", 0)) for r in rows if first_day <= str(r.get("date", ""))[:10] <= last_day)
            return {"status": "ready", "basis": "billed", "usd": usd, "detail": "per-day activity"}
    key_auth = {"Authorization": f"Bearer {env.get('OPENROUTER_API_KEY', '')}"}
    status, body = http_get("https://openrouter.ai/api/v1/key", key_auth)
    if status != 200:
        return unavailable(f"OpenRouter key HTTP {status}")
    usage = json.loads(body)["data"]
    total = float(usage["usage"])
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    snapshots = [json.loads(l) for l in OPENROUTER_SNAPSHOTS.read_text().splitlines()] \
        if OPENROUTER_SNAPSHOTS.exists() else []
    with OPENROUTER_SNAPSHOTS.open("a") as handle:
        handle.write(json.dumps({"at": iso(now), "totalUsageUsd": total}) + "\n")
    earlier = [s for s in snapshots if datetime.fromisoformat(s["at"].replace("Z", "+00:00")) <= start]
    if earlier:
        baseline = earlier[-1]
        return {"status": "ready", "basis": "billed", "usd": total - baseline["totalUsageUsd"],
                "detail": f"lifetime usage since {pacific(baseline['at'])}"}
    month_start = now.replace(day=1, hour=0, minute=0, second=0)
    elapsed = max((now - month_start).total_seconds() / 86_400, 1.0)
    monthly = float(usage["usage_monthly"])
    return {"status": "ready", "basis": "billed, month-to-date rate", "usd": monthly / elapsed * days,
            "detail": f"${monthly:,.0f} billed {month_start:%b} 1 – {now:%b} {now.day} · ${monthly / elapsed:,.0f}/day"}


BOXES_OVERAGE_USD_PER_HOUR = 0.60  # Pro plan prepaid overage (boxes-product-docs billing-and-limits)
BOXES_SNAPSHOTS = OUT_ROOT / "boxes-usage.jsonl"


def _hours(text: str) -> float:
    return float(str(text).replace(",", "").replace("h", "").strip() or 0)


def boxes_cost(start: datetime, now: datetime) -> dict:
    """boxes.dev box-hours used in the window beyond the plan's included hours, at the overage rate.
    Exact when a usage snapshot predates the window; otherwise this billing period's hourly rate."""
    result = subprocess.run(["dvb-onbox", "billing", "status", "--json"], capture_output=True, text=True)
    if result.returncode != 0:
        return unavailable("dvb-onbox billing status failed")
    status = json.loads(result.stdout)
    used, included = _hours(status["boxHoursUsed"]), _hours(status["boxHoursIncluded"])
    period_end = datetime.fromisoformat(status["billingPeriodEndsAt"].replace("Z", "+00:00"))
    period_start = period_end.replace(month=period_end.month - 1) if period_end.month > 1 \
        else period_end.replace(year=period_end.year - 1, month=12)
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    snapshots = [json.loads(l) for l in BOXES_SNAPSHOTS.read_text().splitlines()] if BOXES_SNAPSHOTS.exists() else []
    with BOXES_SNAPSHOTS.open("a") as handle:
        handle.write(json.dumps({"at": iso(now), "periodEnd": status["billingPeriodEndsAt"], "used": used}) + "\n")
    earlier = [s for s in snapshots if s["periodEnd"] == status["billingPeriodEndsAt"]
               and datetime.fromisoformat(s["at"].replace("Z", "+00:00")) <= start]
    if period_start >= start:
        window_hours, basis = used, "billed usage"
    elif earlier:
        window_hours, basis = used - earlier[-1]["used"], "billed usage"
    else:
        elapsed = (now - period_start).total_seconds() / 3600
        window_hours = used / elapsed * (now - start).total_seconds() / 3600
        basis = "billed, period-to-date rate"
    overage = max(0.0, min(window_hours, used - included))
    return {"status": "ready", "basis": basis, "usd": overage * BOXES_OVERAGE_USD_PER_HOUR,
            "detail": f"{window_hours:,.0f} box-hours this week · {overage:,.0f} h overage × "
                      f"${BOXES_OVERAGE_USD_PER_HOUR:.2f} · {used:,.0f} h used this period"}


def plan_costs(start: datetime, end: datetime) -> list[dict]:
    """Flat subscription plans from the reviewed plan list, prorated to the window."""
    rows = []
    for plan in json.loads((ROOT / "scripts" / "biz_review_plans.json").read_text())["plans"]:
        since = datetime.fromisoformat(plan["since"]).replace(tzinfo=timezone.utc)
        days = max(0.0, (end - max(start, since)).total_seconds() / 86_400)
        rows.append({"group": plan["group"], "name": f"{plan['provider']} {plan['plan']}", "status": "ready",
                     "basis": "plan rate", "usd": plan["monthlyUsd"] * plan["accounts"] * days / DAYS_PER_MONTH,
                     "detail": f"{plan['accounts']} × ${plan['monthlyUsd']}/mo"})
    return rows


def render_cost(env: dict, days: float) -> dict:
    status, body = http_get(f"https://api.render.com/v1/services/{env['RENDER_SERVICE_ID']}",
                            {"Authorization": f"Bearer {env['RENDER_API_KEY']}"})
    if status != 200:
        return unavailable(f"Render service HTTP {status}")
    plan = json.loads(body)["serviceDetails"].get("plan", "")
    if plan not in RENDER_PLAN_MONTHLY_USD:
        return unavailable(f"Render plan {plan!r} has no list price in biz_review.py")
    return {"status": "ready", "basis": "plan rate",
            "usd": RENDER_PLAN_MONTHLY_USD[plan] * days / DAYS_PER_MONTH, "detail": f"{plan} plan, 1 service"}


def supabase_cost(env: dict, days: float) -> dict:
    status, body = http_get(
        f"https://api.supabase.com/v1/projects/{SUPABASE_PROJECT_REF}/billing/addons",
        {"Authorization": f"Bearer {env.get('SUPABASE_ACCESS_TOKEN', '')}"})
    if status != 200:
        return unavailable(f"Supabase addons HTTP {status}")
    usd, names = SUPABASE_PRO_PLAN_MONTHLY_USD * days / DAYS_PER_MONTH, ["Pro plan"]
    for addon in json.loads(body).get("selected_addons", []):
        price = addon["variant"]["price"]
        hours = days * 24
        usd += price["amount"] * (hours if price["interval"] == "hourly" else days / DAYS_PER_MONTH)
        names.append(addon["variant"]["name"])
    return {"status": "ready", "basis": "plan rate", "usd": usd, "detail": " + ".join(names)}


def prod_metrics(days: int, end: datetime) -> dict:
    command = ["npx", "tsx", "scripts/biz-review-metrics.ts", "--end", iso(end), "--days", str(days)]
    result = subprocess.run(command, cwd=ROOT / "back-end", capture_output=True, text=True, timeout=600)
    line = next((l for l in reversed(result.stdout.splitlines()) if l.startswith('{"generatedAt"')), None)
    if result.returncode != 0 or line is None:
        return unavailable(f"biz-review-metrics.ts exit {result.returncode}: {result.stderr.strip()[-200:]}")
    return {"status": "ready", **json.loads(line)}




FIRECRAWL_PLAN_MONTHLY_USD = 99  # Standard, 100k credits/month (firecrawl.dev/pricing, 2026-10-19)


def search_api_costs(env: dict, start: datetime, end: datetime) -> list[dict]:
    """Provider-side search/scrape spend. Firecrawl bills a flat plan unless credits run out,
    so its spend is the prorated plan fee; credit usage stays in the detail."""
    rows = []
    for row in [*search_costs(env, start, end), {"name": "Lantern people search", **lantern_cost(env, start, end)}]:
        if row["name"] == "Lantern people search" and row.get("status") != "ready":
            continue
        if row["name"] == "Firecrawl" and row["status"] == "ready" and "credits left" in row.get("detail", ""):
            days = (end - start).total_seconds() / 86_400
            credits = row["detail"].split(" x ")[0]
            row = {**row, "basis": "plan rate", "usd": FIRECRAWL_PLAN_MONTHLY_USD * days / DAYS_PER_MONTH,
                   "detail": f"Standard plan · {credits} used, no overage"}
        rows.append(grouped("Search & data APIs", row))
    return rows


def grouped(group: str, row: dict) -> dict:
    return {"group": group, **row}


def collect(days: int, out_dir: Path) -> Path:
    env = load_env()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    start = now - timedelta(days=days)
    previous_start = start - timedelta(days=days)
    metrics = prod_metrics(days, now)
    costs = [grouped("LLM inference", {"name": "OpenRouter", **openrouter_cost(env, start, now)})]
    costs += [grouped("LLM inference", {"name": name, **fn(env, start, now)})
              for name, fn in (("Cerebras", cerebras_cost),)]
    costs += plan_costs(start, now)
    costs += [grouped("Fly.io", row) for row in fly_cost(env, start, now)]
    costs += [grouped("Browsers & sandboxes", {"name": name, **fn(env, start, now)})
              for name, fn in (("Kernel", kernel_cost), ("Steel", steel_cost), ("E2B", e2b_cost))]
    costs.append(grouped("Browsers & sandboxes", {"name": "boxes.dev box-hours", **boxes_cost(start, now)}))
    costs += search_api_costs(env, start, now)
    costs += [
        grouped("Hosting", {"name": "Vercel", **vercel_cost(env, start, now)}),
        grouped("Hosting", {"name": "Render backend", **render_cost(env, days)}),
        grouped("Hosting", {"name": "Supabase", **supabase_cost(env, days)}),
    ]
    data = {
        "window": {"start": iso(start), "end": iso(now), "days": days},
        "previousWindow": {"start": iso(previous_start), "end": iso(start)},
        "git": collect_git(start, now),
        "previousGit": {k: v for k, v in collect_git(previous_start, start).items()
                        if k in ("prsMerged", "commitsMerged")},
        "metrics": metrics,
        "costs": costs,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "data.json"
    path.write_text(json.dumps(data, indent=1))
    return path


# ── render ───────────────────────────────────────────────────────────────────

CSS = """
:root{--text:light-dark(#1f2328,#e6e8eb);--muted:light-dark(#5b6472,#a3acb9);--line:light-dark(#d5dae1,#3d4450);
--card:light-dark(#f6f8fa,#1c2028);--green:light-dark(#1a7f37,#4ac26b);--blue:light-dark(#0969da,#6cb6ff);
--amber:light-dark(#9a6700,#e3b341);font:14px/1.45 system-ui,sans-serif;color:var(--text)}
body{margin:0;padding:16px}main{max-width:760px;margin:0 auto}
.meta{color:var(--muted);font-size:12px;margin:0 0 12px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:8px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums;line-height:1.15}
.kpi span{color:var(--muted);font-size:12px}.kpi i{display:block;font-style:normal;color:var(--muted);font-size:11px}
.g{color:var(--green)}.bl{color:var(--blue)}.a{color:var(--amber)}.m{color:var(--muted)}
h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:18px 0 8px}
.row{display:grid;grid-template-columns:1fr auto;gap:2px 12px;padding:9px 12px;border-left:4px solid var(--green);
background:var(--card);border-radius:6px;margin-bottom:6px}
.row .t{font-weight:600}.row .pr{color:var(--muted);font-size:12px;white-space:nowrap}
.row .i{grid-column:1/-1;color:var(--muted);font-size:13px}
.tag{font-size:11px;font-weight:600;padding:1px 6px;border-radius:10px;border:1px solid currentColor;margin-left:6px;white-space:nowrap}
details{border:1px solid var(--line);border-radius:6px;margin-bottom:6px;background:var(--card)}
summary{cursor:pointer;padding:8px 12px;display:flex;gap:8px;list-style:none}
summary::-webkit-details-marker{display:none}summary::before{content:"▸";color:var(--muted)}
details[open] summary::before{content:"▾"}summary>span:first-of-type{margin-right:auto}
summary .n{color:var(--muted);font-size:12px;white-space:nowrap}
summary:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
details ul{margin:0;padding:0 12px 10px 34px;color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px}td{padding:6px 8px;border-top:1px solid var(--line)}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.basis{color:var(--muted);font-size:11px;white-space:nowrap}tr.total td{font-weight:600}
.bar{display:grid;grid-template-columns:1fr auto;gap:2px 8px;margin-top:8px;font-size:12px}
.kpi .bar b{display:inline;font-size:13px;line-height:1.4;font-variant-numeric:tabular-nums}.bar .track{grid-column:1/-1;height:6px;border-radius:3px;background:var(--line)}
.bar .track div{height:6px;border-radius:3px;background:var(--blue)}
table.tasks td.st{width:22px;text-align:center}
"""


def esc(value) -> str:
    return html.escape(str(value))


def money(value: float) -> str:
    return f"${value:,.2f}" if value < 1000 else f"${value:,.0f}"


def delta(current, previous, fmt, lower_is_better=False) -> str:
    if current is None or previous is None:
        return ""
    diff = current - previous
    if abs(diff) < 1e-9:
        return '<i>flat vs prior week</i>'
    good = (diff < 0) if lower_is_better else (diff > 0)
    arrow = "▲" if diff > 0 else "▼"
    return f'<i class="{"g" if good else "a"}">{arrow} {fmt(abs(diff))} vs prior week</i>'


TASK_STATES = {
    ("agent", "COMPLETED"): ("✅", "Completed", "g"),
    ("agent", "FAILED"): ("❌", "Failed", "a"),
    ("agent", "PAUSED"): ("⏸️", "Paused", "a"),
    ("agent", "ACTIVE"): ("🔄", "In progress", "bl"),
    ("agent", "STARTING_UP"): ("🔄", "Starting", "bl"),
}
PRIVATE_TEXT = re.compile(r"\+?\d[\d\s().-]{7,}\d|[\w.+-]+@[\w-]+\.[\w.]+")


def task_row(item: dict) -> str:
    """One task: status, title (phone numbers and emails masked), who, where, when."""
    icon, label, color = ("💬", "Answered", "m") if item["kind"] == "chat" else \
        TASK_STATES.get(("agent", item["status"]), ("•", item["status"].title(), "m"))
    when = datetime.fromisoformat(item["createdAt"].replace("Z", "+00:00")).astimezone(PACIFIC)
    title = PRIVATE_TEXT.sub("•••", item["title"])
    return (f'<tr><td class="st {color}" title="{esc(label)}">{icon}</td><td>{esc(title)}'
            f'<br><span class="m" style="font-size:11px">{esc(item["owner"].split()[0])} · '
            f'{esc(SOURCE_LABELS.get(item["source"], item["source"].title()))} · '
            f'{"Chat" if item["kind"] == "chat" else "Agent run"} · {when:%a %b} {when.day}</span></td>'
            f'<td class="num {color}" style="font-size:12px">{esc(label)}</td></tr>')


SOURCE_LABELS = {"MAC_APP": "Mac app", "SMS": "SMS", "WHATSAPP": "WhatsApp", "WEB": "Web"}


def kpi(value: str, label: str, color: str, sub: str = "") -> str:
    return f'<div class="kpi"><b class="{color}">{value}</b><span>{esc(label)}</span>{sub}</div>'


def pacific(stamp: str) -> str:
    moment = datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone(PACIFIC)
    return f"{moment:%B} {moment.day}, {moment:%-I:%M %p} {moment.tzname()}"


def render(data: dict, narrative: dict) -> str:
    window, gitd, prev_git = data["window"], data["git"], data["previousGit"]
    metrics = data["metrics"]
    parts = [f'<p class="meta">{esc(pacific(window["start"]))} → {esc(pacific(window["end"]))} · '
             f'last {window["days"]} days · main</p>']

    # Delivery
    parts.append("<h2>Delivery</h2><div class=\"kpis\">")
    parts.append(kpi(f'{gitd["prsMerged"]}', "PRs merged to main", "g",
                     delta(gitd["prsMerged"], prev_git["prsMerged"], lambda d: f"{d:.0f}")))
    parts.append(kpi(f'{gitd["commitsMerged"]:,}', "commits merged to main", "g",
                     delta(gitd["commitsMerged"], prev_git["commitsMerged"], lambda d: f"{d:,.0f}")))
    parts.append(kpi(str(len(narrative.get("majors", []))), "major updates", "bl"))
    parts.append("</div>")

    # Tasks
    parts.append("<h2>Tasks</h2>")
    if metrics["status"] == "ready":
        cur, prev = metrics["current"]["tasks"], metrics["previous"]["tasks"]
        rate, prev_rate = cur["completionRate"], prev["completionRate"]
        parts.append('<div class="kpis">')
        parts.append(kpi(f"{rate:.0%}" if rate is not None else "0 runs", "task completion rate", "g",
                         f'<i>{cur["completed"]} of {cur["agentRuns"]} agent runs completed</i>'
                         + delta(rate, prev_rate, lambda d: f"{d * 100:.0f} pts")))
        sources = " · ".join(f"{SOURCE_LABELS.get(name, name.title())} {count}"
                             for name, count in sorted(cur["bySource"].items(), key=lambda kv: -kv[1]))
        top = max(cur["byUser"].values(), default=1)
        bars = "".join(
            f'<div class="bar"><span>{esc(name)}</span><b>{count}</b>'
            f'<div class="track"><div style="width:{count / top * 100:.0f}%"></div></div></div>'
            for name, count in sorted(cur["byUser"].items(), key=lambda kv: -kv[1]) if count > 0)
        parts.append(kpi(str(cur["total"]), "user-initiated tasks", "bl",
                         f'<i>{cur["agentRuns"]} agent runs + {cur["chatOnly"]} chat · {esc(sources)}</i>'
                         + delta(cur["total"], prev["total"], lambda d: f"{d:.0f}") + bars))
        parts.append("</div>")
        rows = "".join(task_row(item) for item in cur["items"])
        parts.append(f'<details><summary><span>All tasks</span><span class="n">{cur["total"]}</span></summary>'
                     f'<table class="tasks">{rows}</table></details>')

    # Costs
    ready = [c for c in data["costs"] if c["status"] == "ready"]
    total = sum(c["usd"] for c in ready)
    groups: dict[str, list[dict]] = {}
    for cost in data["costs"]:
        groups.setdefault(cost.get("group", "Other"), []).append(cost)
    subtotal = {name: sum(c["usd"] for c in rows if c["status"] == "ready") for name, rows in groups.items()}
    parts.append("<h2>Compute costs</h2><div class=\"kpis\">")
    parts.append(kpi(money(total), "total compute this week", "bl"))
    for name in sorted(subtotal, key=lambda n: -subtotal[n])[:3]:
        parts.append(kpi(money(subtotal[name]), name, "bl"))
    parts.append("</div>")
    for name in sorted(groups, key=lambda n: -subtotal[n]):
        rows = sorted((c for c in groups[name] if c["status"] == "ready"), key=lambda c: -c["usd"])
        missing = [c["name"] for c in groups[name] if c["status"] != "ready"]
        body = "".join(
            f'<tr><td>{esc(c["name"])}<br><span class="m" style="font-size:11px">{esc(c.get("detail", ""))}</span></td>'
            f'<td class="basis">{esc(c["basis"])}</td><td class="num">{money(c["usd"])}</td></tr>' for c in rows)
        if missing:
            body += (f'<tr><td colspan="3" class="m" style="font-size:12px">Not connected yet: '
                     f'{esc(" · ".join(missing))}</td></tr>')
        parts.append(f'<details><summary><span>{esc(name)}</span><span class="n">{money(subtotal[name])}</span>'
                     f'</summary><table>{body}</table></details>')

    # Majors and minors
    parts.append("<h2>Major updates</h2>")
    for major in narrative.get("majors", []):
        prs = " ".join(f"#{n}" for n in major.get("prs", []))
        parts.append(f'<div class="row"><div class="t">{esc(major["title"])}'
                     f'<span class="tag g">{esc(major.get("tag", "SHIPPED"))}</span></div>'
                     f'<div class="pr">{esc(prs)}</div><div class="i">{esc(major["impact"])}</div></div>')
    parts.append("<h2>Minor updates · clustered</h2>")
    for cluster in narrative.get("clusters", []):
        items = "".join(f"<li>{esc(item)}</li>" for item in cluster.get("items", []))
        parts.append(f'<details><summary><span>{esc(cluster["title"])}</span>'
                     f'<span class="n">{esc(cluster.get("count", ""))}</span></summary><ul>{items}</ul></details>')
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><style>{CSS}</style></head>'
            f'<body><main>{"".join(parts)}</main></body></html>')


# ── self-test ────────────────────────────────────────────────────────────────

def self_test() -> None:
    tasks = {"total": 25, "agentRuns": 15, "chatOnly": 10, "completed": 5, "completionRate": 0.3333,
             "bySource": {"MAC_APP": 17, "SMS": 6}, "byUser": {"Andy Prevalsky": 22, "Tamara Chayo": 3},
             "items": [
                 {"title": "Text Mariana at +502 5555 1234 or a@b.co", "owner": "Tamara Chayo",
                  "createdAt": "2026-10-14T18:00:00Z", "status": "COMPLETED", "source": "SMS",
                  "kind": "agent", "archived": True},
                 {"title": "when does the caltrain leave", "owner": "Andy Prevalsky",
                  "createdAt": "2026-10-15T18:00:00Z", "status": "ACTIVE", "source": "MAC_APP",
                  "kind": "chat", "archived": False},
             ]}
    data = {
        "window": {"start": "2026-10-12T19:00:00Z", "end": "2026-10-19T19:00:00Z", "days": 7},
        "git": {"status": "ready", "prsMerged": 40, "commitsMerged": 812, "directCommits": 3, "prs": [], "direct": []},
        "previousGit": {"prsMerged": 30, "commitsMerged": 900},
        "metrics": {"status": "ready", "current": {"tasks": tasks, "recordedUsage": []},
                    "previous": {"tasks": {**tasks, "total": 23, "completionRate": 0.3077}}},
        "costs": [
            {"group": "Fly.io", "name": "Fly.io · bench", "status": "ready", "basis": "metered × list price",
             "usd": 1962.03, "detail": "4,994 machines"},
            {"group": "LLM inference", "name": "OpenRouter", "status": "ready", "basis": "billed", "usd": 1383.6},
            {"group": "LLM inference", "name": "Cerebras", "status": "unavailable", "detail": "no usage API"},
            {"group": "Compute plans", "name": "Claude Max 20x", "status": "ready", "basis": "plan rate", "usd": 92.0},
        ],
    }
    narrative = {"majors": [{"title": "A <b>", "impact": "i", "prs": [1]}],
                 "clusters": [{"title": "Chat", "count": "2 PRs", "items": ["x"]}]}
    page = render(data, narrative)
    assert "33%" in page and "5 of 15 agent runs completed" in page
    assert "25</b><span>user-initiated tasks" in page and "archived" not in page.lower()
    assert "Andy Prevalsky</span><b>22</b>" in page and "width:14%" in page, "per-user bars scale to the top user"
    assert "Text Mariana at ••• or •••" in page, "phone numbers and emails are masked"
    assert "✅" in page and "Answered" in page and "Tamara · SMS · Agent run" in page
    assert "▲ 3 pts vs prior week" in page
    assert "$3,438" in page, "total sums every metered row"
    assert "Not connected yet: Cerebras" in page
    assert "A &lt;b&gt;" in page, "narrative text must be escaped"
    for banned in ("null", "None", "N/A", "warming", "latency", "5xx"):
        assert banned not in page, banned
    assert "UTC" not in page and ("PDT" in page or "PST" in page)
    match = PR_SUBJECT.search("fix: x (#1511) [skip render]")
    assert match and match.group(2) == "1511"
    start = datetime(2026, 10, 12, 19, tzinfo=timezone.utc)
    plans = plan_costs(start, start + timedelta(days=7))
    claude = next(p for p in plans if p["name"].startswith("Claude"))
    assert abs(claude["usd"] - 2 * 200 * 7 / DAYS_PER_MONTH) < 1e-6, "plans prorate to the window"
    fly_self_test()
    browsers_self_test()
    search_self_test()
    llm_self_test()
    lantern_self_test()
    print("biz-review self-test passed")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect")
    c.add_argument("--days", type=int, default=7)
    c.add_argument("--out", type=Path)
    r = sub.add_parser("render")
    r.add_argument("--dir", type=Path, required=True)
    m = sub.add_parser("set-cost", help="record a provider figure the user read from a dashboard")
    m.add_argument("--dir", type=Path, required=True)
    m.add_argument("--name", required=True)
    m.add_argument("--usd", type=float, required=True)
    m.add_argument("--detail", default="")
    sub.add_parser("self-test")
    args = parser.parse_args()
    if args.cmd == "self-test":
        self_test()
    elif args.cmd == "set-cost":
        path = args.dir / "data.json"
        data = json.loads(path.read_text())
        row = next((c for c in data["costs"] if c["name"] == args.name), None)
        if row is None:
            raise SystemExit(f"no cost row named {args.name!r}")
        row.update({"status": "ready", "basis": "billed, provider dashboard", "usd": args.usd,
                    "detail": args.detail})
        path.write_text(json.dumps(data, indent=1))
        print(path)
    elif args.cmd == "collect":
        out = args.out or OUT_ROOT / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        print(collect(args.days, out))
    else:
        data = json.loads((args.dir / "data.json").read_text())
        narrative = json.loads((args.dir / "narrative.json").read_text())
        target = args.dir / "index.html"
        with tempfile.NamedTemporaryFile("w", dir=args.dir, delete=False) as handle:
            handle.write(render(data, narrative))
        os.replace(handle.name, target)
        print(target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
