#!/usr/bin/env python3
"""Lantern People (people.lantern.md) spend for the weekly business review.

Read-only, stdlib only. Findings (verified 2026-10-19):
- Calls: workers POST /v1/operations/find_people and
  /v1/operations/people_profiles_get with a Bearer OAuth access token. Prod
  workers have no PEOPLE_API_TOKEN; they fetch the token from the backend
  broker (/api/integrations/lantern-people/credentials/token), which reads the
  encrypted `lantern_people` Integration row (shared owner
  LANTERN_PEOPLE_SHARED_USER_ID when set -- unset on Render -- otherwise the
  acting user's own grant). Responses carry no cost/credit fields, and Rose
  records LANTERN_COST_CENTS_PER_QUERY = 0.0.
- Billing model (people.lantern.md, llms.txt): a workspace plan/trial includes
  people search and profile access; only "paid endpoints" (Exa, Parallel,
  Fiber...) consume research credits at provider price + 10%. Rose calls only
  the included operations, so marginal spend is $0. Any plan subscription is
  billed to the Lantern account owner, outside Rose; set
  LANTERN_PLAN_USD_MONTHLY to prorate it into the window.
- No usage/billing API: GET /v1/usage, /v1/credits, /v1/balance, /v1/account,
  /v1/me, /v1/plan, /v1/subscription... all 404 even with a valid token.
- Call volume is observable only in prod worker logs (ClickHouse
  observability.fly_logs, navi-whisper-lux only; cloud-fleet and local workers
  are not ingested). Benchmark volume comes from the attempts ledger.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

def _history_ledger():
    """agents/benchmarks/history_ledger.py: a ledger is its base file plus per-writer shards."""
    import importlib.util

    source = Path(__file__).resolve().parents[1] / "agents" / "benchmarks" / "history_ledger.py"
    spec = importlib.util.spec_from_file_location("benchmark_history_ledger", source)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TIMEOUT_S = 60
SECONDS_PER_MONTH = 30.4375 * 86400
LEDGER = Path(__file__).resolve().parent.parent / "agents/benchmarks/history/task_attempts.jsonl"
# Minimum people_search calls per attempt (tasks.json min_tool_counts).
BENCH_MIN_CALLS = {"lantern-people-discovery": 1, "lantern-people-enrichment": 2, "lantern-people-pagination": 2}


def _utc(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _ch_time(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%d %H:%M:%S")


def prod_call_query(start: datetime, end: datetime) -> str:
    """Count prod people_search activity calls routed to Lantern, by outcome."""
    window = f"ingested_at >= '{_ch_time(start)}' AND ingested_at < '{_ch_time(end)}'"
    return (
        "SELECT countIf(raw ILIKE '%Calling people_search_activity%') AS calls, "
        "countIf(raw ILIKE '%Tool people_search failed%') AS failures "
        f"FROM observability.fly_logs WHERE {window} AND raw ILIKE '%people_search%' "
        "AND raw ILIKE '%lantern%' FORMAT JSON"
    )


def prod_calls(env: dict, start: datetime, end: datetime) -> dict | None:
    endpoint, user, password = (env.get(k, "") for k in ("CLICKHOUSE_ENDPOINT", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD"))
    if not (endpoint and user and password):
        return None
    url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode({"query": prod_call_query(start, end)})
    auth = base64.b64encode(f"{user}:{password}".encode()).decode()
    request = urllib.request.Request(url, headers={"Authorization": f"Basic {auth}"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            row = json.loads(response.read().decode())["data"][0]
        return {"calls": int(row["calls"]), "failures": int(row["failures"])}
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError, IndexError):
        return None


def bench_calls(lines, start: datetime, end: datetime) -> dict:
    """Lantern benchmark attempts in the window and their minimum call count."""
    attempts = minimum = 0
    for line in lines:
        try:
            row = json.loads(line)
            task, moment = row.get("task", ""), _utc(row.get("timestamp", ""))
        except (ValueError, TypeError, AttributeError):
            continue
        if task in BENCH_MIN_CALLS and start <= moment < end:
            attempts += 1
            minimum += BENCH_MIN_CALLS[task]
    return {"attempts": attempts, "min_calls": minimum}


def lantern_cost(env: dict, start: str | datetime, end: str | datetime) -> dict:
    start, end = _utc(start), _utc(end)
    plan_monthly = env.get("LANTERN_PLAN_USD_MONTHLY", "").strip()
    try:
        monthly = float(plan_monthly) if plan_monthly else 0.0
    except ValueError:
        monthly = 0.0
    usd = round(monthly * (end - start).total_seconds() / SECONDS_PER_MONTH, 2)
    prod = prod_calls(env, start, end)
    bench = bench_calls(_history_ledger().read_lines(LEDGER), start, end)  # base + per-writer shards
    prod_text = (
        f"prod {prod['calls']} Lantern calls ({prod['failures']} failed)" if prod is not None
        else "prod calls unavailable (ClickHouse)"
    )
    plan_text = (
        f"plan ${monthly:g}/mo prorated" if monthly
        else "plan subscription (if any) billed to the Lantern account owner, not observable"
    )
    return {
        "status": "ready",
        "basis": "contract: included find_people/people_profiles_get are nonbillable; no usage API",
        "usd": usd,
        "detail": (
            f"{prod_text}; benchmarks {bench['attempts']} attempts (>= {bench['min_calls']} calls); "
            f"local/cloud-fleet calls not logged centrally; {plan_text}"
        ),
    }


def self_test() -> None:
    start, end = _utc("2026-10-12T19:00:00Z"), _utc("2026-10-19T19:00:00Z")
    query = prod_call_query(start, end)
    assert "'2026-10-12 19:00:00'" in query and "'2026-10-19 19:00:00'" in query
    lines = [
        json.dumps({"task": "lantern-people-enrichment", "timestamp": "2026-10-14T03:00:00Z"}),
        json.dumps({"task": "lantern-people-discovery", "timestamp": "2026-10-19T19:00:00Z"}),  # end-exclusive
        json.dumps({"task": "other-task", "timestamp": "2026-10-14T03:00:00Z"}),
        "not json",
    ]
    assert bench_calls(lines, start, end) == {"attempts": 1, "min_calls": 2}
    result = lantern_cost({}, start, end)
    assert result["status"] == "ready" and result["usd"] == 0.0 and "unavailable" in result["detail"]
    week = lantern_cost({"LANTERN_PLAN_USD_MONTHLY": "30.4375"}, start, end)
    assert week["usd"] == 7.0, week
    assert lantern_cost({"LANTERN_PLAN_USD_MONTHLY": "bad"}, start, end)["usd"] == 0.0
    print("biz_review_lantern self-test ok")


def _load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    path = Path(__file__).resolve().parent.parent / "agents/.env"
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                env[key.strip().removeprefix("export ").strip()] = value.strip().strip("'\"")
    return {**env, **os.environ}


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    else:
        args = sys.argv[1:] or ["2026-10-12T19:00:00Z", "2026-10-19T19:00:00Z"]
        print(json.dumps(lantern_cost(_load_env(), args[0], args[1]), indent=2))
