#!/usr/bin/env python3
"""Provider-side search/scraping API spend for the weekly business review.

Covers every caller of the provider account (prod, cloud benchmark stacks and
local runs), unlike the prod-DB recorded usage. Read-only GETs, stdlib only.

Provider findings (verified 2026-10-19):
- Firecrawl: GET /v2/team/credit-usage/historical returns credits used per
  calendar month (UTC) for the whole team; date/granularity params are ignored.
  /v2/team/credit-usage gives the current billing-period balance and
  /v2/team/activity lists jobs for only ~24 h without credits. A window inside
  a month is therefore prorated from that month's credits (basis says so).
  Price: Standard plan (100,000 credits/month) $99/month billed monthly,
  https://www.firecrawl.dev/pricing (read 2026-10-19).
- Exa: billing per API key via the Admin API
  (https://docs.exa.ai/reference/team-management/get-api-key-usage), which
  needs a team service key (EXA_SERVICE_API_KEY / EXA_ADMIN_API_KEY). The
  search key returns 401 there.
- Parallel AI: no usage API; spend is only in Platform > Usage
  (https://docs.parallel.ai/resources/faqs). /v1beta/usage rejects API keys.
- Perplexity: no usage API (only the console's usage page).
- Lantern people search: per-user/shared Lantern connection credentials; no
  provider usage API or Rose-held account key.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

UA = "curl/8.5.0"
TIMEOUT_S = 15
FIRECRAWL = "https://api.firecrawl.dev/v2/team"
FIRECRAWL_PLAN_PRICES = {  # plan credits/month -> monthly-billed USD
    5_000: 19.0, 100_000: 99.0, 500_000: 399.0, 1_000_000: 719.0,
}
FIRECRAWL_PRICING_SOURCE = "firecrawl.dev/pricing, read 2026-10-19"
EXA_ADMIN = "https://admin-api.exa.ai/team-management"


def _get(url: str, headers: dict[str, str]) -> tuple[int, object]:
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json", **headers})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return response.status, json.loads(response.read().decode() or "null")
    except urllib.error.HTTPError as error:
        return error.code, None
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        return 0, str(error)


def _utc(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _unavailable(name: str, basis: str, detail: str) -> dict:
    return {"name": name, "status": "unavailable", "basis": basis, "detail": detail}


# ── Firecrawl ────────────────────────────────────────────────────────────────

def firecrawl_window_credits(periods: list[dict], start: datetime, end: datetime,
                             now: datetime) -> tuple[float, bool]:
    """Credits attributable to [start, end); returns (credits, exact)."""
    total, exact = 0.0, True
    for period in periods:
        p_start = _utc(period["startDate"])
        p_end = _utc(period["endDate"]) if period.get("endDate") else now
        lo, hi = max(start, p_start), min(end, p_end, now)
        if hi <= lo or p_end <= p_start:
            continue
        share = (hi - lo) / (p_end - p_start)
        if share < 1:
            exact = False
        total += float(period.get("creditsUsed", 0)) * share
    return total, exact


def firecrawl_cost(env: dict, start: datetime, end: datetime, now: datetime | None = None) -> dict:
    name = "Firecrawl"
    key = env.get("FIRECRAWL_API_KEY", "")
    if not key:
        return _unavailable(name, "provider API", "FIRECRAWL_API_KEY not set")
    now = now or datetime.now(timezone.utc)
    auth = {"Authorization": f"Bearer {key}"}
    status, history = _get(f"{FIRECRAWL}/credit-usage/historical", auth)
    if status != 200 or not isinstance(history, dict) or "periods" not in history:
        return _unavailable(name, "provider API", f"credit-usage/historical HTTP {status}")
    status, current = _get(f"{FIRECRAWL}/credit-usage", auth)
    plan_credits = (current or {}).get("data", {}).get("planCredits") if status == 200 else None
    price = FIRECRAWL_PLAN_PRICES.get(plan_credits or 0)
    if price is None:
        return _unavailable(name, "provider API", f"unknown plan credits {plan_credits}")
    credits, exact = firecrawl_window_credits(history["periods"], start, end, now)
    usd_per_credit = price / plan_credits
    remaining = current["data"].get("remainingCredits")
    basis = ("provider credits, all keys" if exact else
             "provider credits, all keys; monthly buckets prorated to window (estimate)")
    return {
        "name": name, "status": "ready", "basis": basis,
        "usd": round(credits * usd_per_credit, 2),
        "detail": (f"{credits:,.0f} credits x ${usd_per_credit:.5f} "
                   f"(plan {plan_credits:,} credits ${price:.0f}/mo, {FIRECRAWL_PRICING_SOURCE}); "
                   f"{remaining:,} credits left this billing period"),
    }


# ── Exa ──────────────────────────────────────────────────────────────────────

def exa_cost(env: dict, start: datetime, end: datetime) -> dict:
    name = "Exa"
    key = env.get("EXA_SERVICE_API_KEY") or env.get("EXA_ADMIN_API_KEY") or ""
    if not key:
        return _unavailable(name, "provider Admin API",
                            "needs an Exa team service key (EXA_SERVICE_API_KEY); the search key gets 401")
    auth = {"x-api-key": key}
    status, listing = _get(f"{EXA_ADMIN}/api-keys", auth)
    keys = (listing or {}).get("apiKeys") if isinstance(listing, dict) else None
    if status != 200 or not isinstance(keys, list):
        return _unavailable(name, "provider Admin API", f"api-keys HTTP {status}")
    query = urllib.parse.urlencode({"start_date": _iso(start), "end_date": _iso(end), "group_by": "day"})
    total, failed = 0.0, 0
    for item in keys:
        status, usage = _get(f"{EXA_ADMIN}/api-keys/{item.get('id')}/usage?{query}", auth)
        if status != 200 or not isinstance(usage, dict):
            failed += 1
            continue
        total += float(usage.get("total_cost_usd") or 0)
    if failed:
        return _unavailable(name, "provider Admin API", f"usage failed for {failed}/{len(keys)} keys")
    return {"name": name, "status": "ready", "basis": "provider billing, all keys",
            "usd": round(total, 2), "detail": f"{len(keys)} API keys"}


# ── providers without a usage API ────────────────────────────────────────────

def parallel_cost(env: dict) -> dict:
    present = bool(env.get("PARRALLEL_API_KEY") or env.get("PARALLEL_API_KEY"))
    return _unavailable("Parallel AI (Search + Extract)", "dashboard only",
                        "no usage API; /v1beta/usage rejects API keys; see platform.parallel.ai Usage"
                        + ("" if present else "; key not set"))


def perplexity_cost(env: dict) -> dict:
    return _unavailable("Perplexity", "dashboard only", "no usage/billing API; see the API console usage page")


def lantern_cost(env: dict) -> dict:
    return _unavailable("Lantern people search", "no provider API",
                        "connection-scoped Lantern credentials; no usage endpoint")


def search_costs(env: dict, start: datetime, end: datetime) -> list[dict]:
    start, end = _utc(start), _utc(end)
    rows = []
    for name, fn in (("Firecrawl", lambda: firecrawl_cost(env, start, end)),
                     ("Exa", lambda: exa_cost(env, start, end)),
                     ("Parallel AI (Search + Extract)", lambda: parallel_cost(env)),
                     ("Perplexity", lambda: perplexity_cost(env)),
                     ("Lantern people search", lambda: lantern_cost(env))):
        try:
            rows.append(fn())
        except Exception as error:  # one provider never breaks the report
            rows.append(_unavailable(name, "error", type(error).__name__))
    return rows


# ── self test / CLI ──────────────────────────────────────────────────────────

def self_test() -> None:
    periods = [
        {"startDate": "2026-09-01T00:00:00.000Z", "endDate": "2026-10-01T00:00:00.000Z", "creditsUsed": 3000},
        {"startDate": "2026-10-01T00:00:00.000Z", "endDate": None, "creditsUsed": 1900},
    ]
    now = _utc("2026-10-20T00:00:00Z")
    credits, exact = firecrawl_window_credits(periods, _utc("2026-09-01T00:00:00Z"), _utc("2026-10-01T00:00:00Z"), now)
    assert credits == 3000 and exact
    credits, exact = firecrawl_window_credits(periods, _utc("2026-10-13T00:00:00Z"), _utc("2026-10-20T00:00:00Z"), now)
    assert abs(credits - 700) < 1e-6 and not exact
    credits, _ = firecrawl_window_credits(periods, _utc("2026-09-30T00:00:00Z"), _utc("2026-10-02T00:00:00Z"), now)
    assert abs(credits - (100 + 100)) < 1e-6
    rows = search_costs({}, now - timedelta(days=7), now)
    assert all(r["status"] == "unavailable" for r in rows)
    assert {r["name"] for r in rows} >= {"Firecrawl", "Exa"}
    assert "Bearer" not in json.dumps(rows)
    print("biz_review_search self-test ok")


def _load_env() -> dict[str, str]:
    root = Path(__file__).resolve().parent.parent
    env: dict[str, str] = {}
    for rel in ("agents/.env", "back-end/.env"):
        path = root / rel
        if path.exists():
            for line in path.read_text().splitlines():
                match = re.match(r"^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$", line)
                if match:
                    env[match.group(1)] = match.group(2).strip().strip('"').strip("'")
    env.update({k: v for k, v in os.environ.items() if k in env or k.startswith("EXA_")})
    return env


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
        sys.exit(0)
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    end = _utc(args[1]) if len(args) > 1 else datetime.now(timezone.utc)
    start = _utc(args[0]) if args else end - timedelta(days=7)
    began = time.monotonic()
    result = search_costs(_load_env(), start, end)
    print(json.dumps({"start": _iso(start), "end": _iso(end), "elapsed_s": round(time.monotonic() - began, 1),
                      "providers": result}, indent=2))
