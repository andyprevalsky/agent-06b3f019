#!/usr/bin/env python3
"""Browser/sandbox provider cost estimates for the weekly business review.

Read-only.  Each ``*_cost(env, start, end)`` returns::

    {"status": "ready"|"unavailable", "basis": str, "usd": float, "detail": str}

``usd`` is present only when ``status == "ready"``.  Every function has a hard
wall-clock budget (``BUDGET_S``); when it is exceeded the function returns
``unavailable`` instead of a partial number.  Live-view/CDP URLs and secrets are
never logged or returned.  stdlib only.
"""

from __future__ import annotations

import json
import math
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

USER_AGENT = "curl/8.5.0"  # Steel 403s the urllib default UA.
BUDGET_S = 85.0
HTTP_TIMEOUT_S = 30.0
DAYS_PER_MONTH = 365.25 / 12

# --- Kernel (https://www.kernel.sh/pricing + /docs/info/pricing, fetched 2026-10-19)
# Usage is $0.0000166667 per GB-second; headless browser = 1 GB ($0.06/h),
# headful = 8 GB ($0.48/h); stealth adds no fee; idle/proxies not charged.
# Plan: Start-Up ($200/mo, $50 usage credits/mo) per repo capacity notes
# (scripts/tests/cloudbench-provider-capacity.test.py: "150 concurrent, Start-up plan").
KERNEL_HEADLESS_USD_PER_HOUR = 0.06
KERNEL_HEADFUL_USD_PER_HOUR = 0.48
KERNEL_PLAN_USD_PER_MONTH = 200.0
KERNEL_PLAN_CREDITS_USD_PER_MONTH = 50.0

# --- Steel (https://steel.dev/pricing + https://docs.steel.dev/overview/pricinglimits,
# fetched 2026-10-19).  Our plan is Scale: the API rejects sessions over 60 min
# "for your plan" (back-end/src/providers/steel/sessionLifetime.ts) and only Scale
# has a 1-hour cap.  Scale: $250/mo incl. $100 usage credits/mo, $0.08/browser-hour
# billed per minute rounded up, $6/GB Steel proxy, $1/1k CAPTCHA solves.
STEEL_USD_PER_BROWSER_HOUR = 0.08
STEEL_PROXY_USD_PER_GB = 6.0
STEEL_PLAN_USD_PER_MONTH = 250.0
STEEL_PLAN_CREDITS_USD_PER_MONTH = 100.0
STEEL_MAX_SESSION = timedelta(hours=1)

# --- E2B (https://e2b.dev/pricing, fetched 2026-10-19): $0.000014 per vCPU-second,
# $0.0000045 per GiB-second, storage free.  Pro plan $150/mo (Hobby caps at 20
# concurrent sandboxes; Pro is inferred when the team's peak concurrency > 20).
E2B_USD_PER_VCPU_SECOND = 0.000014
E2B_USD_PER_GIB_SECOND = 0.0000045
E2B_PRO_USD_PER_MONTH = 150.0
E2B_HOBBY_MAX_CONCURRENCY = 20
E2B_MAX_SANDBOX = timedelta(hours=24)


class _Budget:
    def __init__(self, seconds: float = BUDGET_S) -> None:
        self.deadline = time.monotonic() + seconds

    def left(self) -> float:
        return self.deadline - time.monotonic()

    def check(self) -> None:
        if self.left() <= 0:
            raise TimeoutError("time budget exceeded")


def _get(url: str, headers: dict[str, str], budget: _Budget) -> tuple[Any, dict[str, str]]:
    """GET JSON with small retry on 429/5xx.  Errors never include secrets."""
    last = ""
    for attempt in range(4):
        budget.check()
        req = urllib.request.Request(
            url, headers={**headers, "User-Agent": USER_AGENT, "Accept": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=min(HTTP_TIMEOUT_S, max(1.0, budget.left()))) as resp:
                hdrs = {k.lower(): v for k, v in resp.headers.items()}
                return json.loads(resp.read().decode()), hdrs
        except urllib.error.HTTPError as exc:
            body = exc.read().decode(errors="replace")[:160]
            last = f"HTTP {exc.code} {body.strip()}"
            if exc.code not in (429, 500, 502, 503, 504):
                break
            retry_after = exc.headers.get("retry-after")
            time.sleep(min(float(retry_after) if retry_after and retry_after.isdigit() else 0.5 * (attempt + 1), 3))
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = f"{type(exc).__name__}"
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(last or "request failed")


def _ts(value: str | None) -> datetime | None:
    if not value:
        return None
    v = value.strip().replace("Z", "+00:00")
    # Trim nanoseconds to microseconds for fromisoformat.
    if "." in v:
        head, frac = v.split(".", 1)
        tz = ""
        for sep in ("+", "-"):
            if sep in frac:
                frac, tz = frac.split(sep, 1)
                tz = sep + tz
                break
        v = f"{head}.{frac[:6]}{tz}"
    dt = datetime.fromisoformat(v)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _overlap_fraction(s: datetime, e: datetime, start: datetime, end: datetime) -> float:
    total = (e - s).total_seconds()
    if total <= 0:
        return 1.0 if start <= s < end else 0.0
    ov = (min(e, end) - max(s, start)).total_seconds()
    return max(0.0, min(1.0, ov / total))


def _plan_net(plan_month: float, credits_month: float, usage: float, days: float) -> tuple[float, float, float]:
    """Return (prorated fee, credits applied, total) for a window of `days`."""
    fee = plan_month * days / DAYS_PER_MONTH
    credits = min(usage, credits_month * days / DAYS_PER_MONTH)
    return fee, credits, fee + usage - credits


def _unavailable(basis: str, reason: str) -> dict[str, Any]:
    return {"status": "unavailable", "basis": basis, "detail": reason}


def _require_tz(start: datetime, end: datetime) -> None:
    if start.tzinfo is None or end.tzinfo is None:
        raise ValueError("start/end must be timezone-aware")


def _parallel_offset_pages(
    fetch: Callable[[int], list[dict]],
    page_size: int,
    stop: Callable[[list[dict]], bool],
    budget: _Budget,
    workers: int = 8,
    max_pages: int = 2000,
) -> list[dict]:
    """Fetch offset pages in parallel batches until `stop(page)` or an empty/short page."""
    out: list[dict] = []
    offset = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        while offset < max_pages * page_size:
            budget.check()
            offsets = [offset + i * page_size for i in range(workers)]
            pages = list(pool.map(fetch, offsets))
            done = False
            for page in pages:
                out.extend(page)
                if len(page) < page_size or stop(page):
                    done = True
                    break
            if done:
                return out
            offset += workers * page_size
    raise TimeoutError("page cap reached")


# --------------------------------------------------------------------- Kernel
def kernel_cost_from_sessions(sessions: Iterable[dict], start: datetime, end: datetime) -> dict[str, Any]:
    n = 0
    hl_h = hf_h = 0.0
    now = datetime.now(timezone.utc)
    for b in sessions:
        c = _ts(b.get("created_at"))
        if c is None:
            continue
        d = _ts(b.get("deleted_at")) or min(now, end)
        if d < start or c >= end:
            continue
        frac = _overlap_fraction(c, d, start, end)
        uptime_ms = (b.get("usage") or {}).get("uptime_ms")
        hours = (uptime_ms / 3.6e6) if uptime_ms is not None else (d - c).total_seconds() / 3600
        hours *= frac
        if hours <= 0 and frac <= 0:
            continue
        n += 1
        if b.get("headless"):
            hl_h += hours
        else:
            hf_h += hours
    usage = hl_h * KERNEL_HEADLESS_USD_PER_HOUR + hf_h * KERNEL_HEADFUL_USD_PER_HOUR
    days = (end - start).total_seconds() / 86400
    fee, credits, total = _plan_net(KERNEL_PLAN_USD_PER_MONTH, KERNEL_PLAN_CREDITS_USD_PER_MONTH, usage, days)
    return {
        "status": "ready",
        "basis": "provider usage × list price + prorated Start-Up plan",
        "usd": round(total, 2),
        "detail": (
            f"{n:,} sessions · {hf_h:,.1f} headful + {hl_h:,.1f} headless browser-hours · "
            f"usage ${usage:,.2f} + plan ${fee:,.2f} − credits ${credits:,.2f}"
        ),
    }


def kernel_cost(env: dict, start: datetime, end: datetime) -> dict[str, Any]:
    basis = "provider usage × list price + prorated Start-Up plan"
    _require_tz(start, end)
    key = env.get("KERNEL_API_KEY")
    if not key:
        return _unavailable(basis, "KERNEL_API_KEY missing")
    budget = _Budget()
    headers = {"Authorization": f"Bearer {key}"}
    limit = 100
    horizon = start - timedelta(hours=72)

    def fetch(offset: int) -> list[dict]:
        data, _ = _get(f"https://api.onkernel.com/browsers?status=all&limit={limit}&offset={offset}", headers, budget)
        # Keep only the fields we price; drop CDP/live-view URLs immediately.
        return [
            {k: b.get(k) for k in ("created_at", "deleted_at", "headless", "stealth", "usage")}
            for b in (data or [])
        ]

    def stop(page: list[dict]) -> bool:
        cs = [_ts(b.get("created_at")) for b in page]
        cs = [c for c in cs if c]
        desc = all(a >= b for a, b in zip(cs, cs[1:]))
        return bool(cs) and desc and max(cs) < horizon

    try:
        sessions = _parallel_offset_pages(fetch, limit, stop, budget)
    except TimeoutError as exc:
        return _unavailable(basis, f"Kernel listing incomplete: {exc}")
    except RuntimeError as exc:
        return _unavailable(basis, f"Kernel GET /browsers failed: {exc}")
    return kernel_cost_from_sessions(sessions, start, end)


# ---------------------------------------------------------------------- Steel
def steel_cost_from_sessions(sessions: Iterable[dict], start: datetime, end: datetime) -> dict[str, Any]:
    n = 0
    minutes = 0.0
    proxy_bytes = 0.0
    for s in sessions:
        c = _ts(s.get("createdAt"))
        if c is None:
            continue
        dur_ms = float(s.get("duration") or 0)
        e = c + timedelta(milliseconds=dur_ms)
        if e < start or c >= end:
            continue
        frac = _overlap_fraction(c, e, start, end)
        if frac <= 0:
            continue
        n += 1
        minutes += math.ceil(dur_ms / 60000) * frac  # billed per minute, rounded up
        if s.get("proxySource") == "steel":
            proxy_bytes += float(s.get("proxyBytesUsed") or 0) * frac
    hours = minutes / 60
    gb = proxy_bytes / 1e9
    usage = hours * STEEL_USD_PER_BROWSER_HOUR + gb * STEEL_PROXY_USD_PER_GB
    days = (end - start).total_seconds() / 86400
    fee, credits, total = _plan_net(STEEL_PLAN_USD_PER_MONTH, STEEL_PLAN_CREDITS_USD_PER_MONTH, usage, days)
    return {
        "status": "ready",
        "basis": "provider usage × list price + prorated Scale plan",
        "usd": round(total, 2),
        "detail": (
            f"{n:,} sessions · {hours:,.1f} browser-hours · {gb:,.2f} GB proxy · "
            f"usage ${usage:,.2f} + plan ${fee:,.2f} − credits ${credits:,.2f} (CAPTCHA solves not exposed)"
        ),
    }


def steel_cost(env: dict, start: datetime, end: datetime) -> dict[str, Any]:
    basis = "provider usage × list price + prorated Scale plan"
    _require_tz(start, end)
    key = env.get("STEEL_API_KEY")
    if not key:
        return _unavailable(basis, "STEEL_API_KEY missing")
    budget = _Budget()
    headers = {"steel-api-key": key}
    horizon = start - STEEL_MAX_SESSION

    def stream(status: str | None) -> list[dict]:
        out: list[dict] = []
        seen: set[str] = set()
        cursor = None
        while True:
            budget.check()
            q = "limit=100" + (f"&status={status}" if status else "")
            if cursor:
                # The API ignores `cursor`; the SDK pages with cursorId=<last session id>.
                q += f"&cursorId={cursor}"
            data, _ = _get(f"https://api.steel.dev/v1/sessions?{q}", headers, budget)
            page = data.get("sessions") or []
            fresh = [s for s in page if s.get("id") not in seen]
            if page and not fresh:
                raise RuntimeError("cursor did not advance")
            for s in fresh:
                seen.add(s.get("id"))
                out.append(
                    {k: s.get(k) for k in ("createdAt", "duration", "proxySource", "proxyBytesUsed", "status")}
                )
            cursor = page[-1].get("id") if page and data.get("nextCursor") else None
            last = _ts(page[-1].get("createdAt")) if page else None
            if not page or not cursor or (last and last < horizon):
                return out

    # Cursor paging is sequential; split by status so the streams run in parallel.
    try:
        with ThreadPoolExecutor(max_workers=3) as pool:
            parts = list(pool.map(stream, ["released", "failed", "live"]))
    except TimeoutError:
        return _unavailable(basis, f"Steel listing exceeded {BUDGET_S:.0f}s budget")
    except RuntimeError as exc:
        return _unavailable(basis, f"Steel GET /v1/sessions failed: {exc}")
    return steel_cost_from_sessions([s for p in parts for s in p], start, end)


# ------------------------------------------------------------------------ E2B
def e2b_cost_from_events(
    events: Iterable[dict], running: Iterable[dict], start: datetime, end: datetime, pro_plan: bool | None
) -> dict[str, Any]:
    n = 0
    vcpu_s = gib_s = 0.0
    seen: set[str] = set()
    for ev in events:
        ex = (ev.get("eventData") or {}).get("execution") or {}
        st = _ts(ex.get("started_at"))
        stop_at = _ts(ev.get("timestamp"))
        if st is None or stop_at is None or ex.get("execution_time") is None:
            continue
        key = ev.get("sandboxExecutionId") or ev.get("id") or f"{st}{stop_at}"
        if key in seen:
            continue
        seen.add(key)
        if stop_at < start or st >= end:
            continue
        frac = _overlap_fraction(st, stop_at, start, end)
        secs = float(ex["execution_time"]) / 1000 * frac
        if secs <= 0:
            continue
        n += 1
        vcpu_s += secs * float(ex.get("vcpu_count") or 0)
        gib_s += secs * float(ex.get("memory_mb") or 0) / 1024
    now = min(datetime.now(timezone.utc), end)
    for sb in running:
        st = _ts(sb.get("startedAt"))
        if st is None or st >= end:
            continue
        secs = max(0.0, (now - max(st, start)).total_seconds())
        n += 1
        vcpu_s += secs * float(sb.get("cpuCount") or 0)
        gib_s += secs * float(sb.get("memoryMB") or 0) / 1024
    usage = vcpu_s * E2B_USD_PER_VCPU_SECOND + gib_s * E2B_USD_PER_GIB_SECOND
    days = (end - start).total_seconds() / 86400
    fee = E2B_PRO_USD_PER_MONTH * days / DAYS_PER_MONTH if pro_plan is not False else 0.0
    plan_note = {True: "Pro", False: "Hobby", None: "Pro assumed"}[pro_plan]
    return {
        "status": "ready",
        "basis": f"provider usage × list price + prorated {plan_note} plan",
        "usd": round(usage + fee, 2),
        "detail": (
            f"{n:,} sandbox runs · {vcpu_s / 3600:,.1f} vCPU-hours · {gib_s / 3600:,.1f} GiB-hours · "
            f"usage ${usage:,.2f} + plan ${fee:,.2f}"
        ),
    }


def e2b_cost(env: dict, start: datetime, end: datetime) -> dict[str, Any]:
    basis = "provider usage × list price + prorated plan"
    _require_tz(start, end)
    key = env.get("E2B_API_KEY")
    if not key:
        return _unavailable(basis, "E2B_API_KEY missing")
    budget = _Budget()
    headers = {"X-API-Key": key}
    limit = 100
    horizon = start  # events are newest-first; stop once kills predate the window
    types = "&".join(f"types=sandbox.lifecycle.{t}" for t in ("killed", "paused"))

    def fetch(offset: int) -> list[dict]:
        data, _ = _get(
            f"https://api.e2b.dev/events/sandboxes?limit={limit}&offset={offset}&{types}", headers, budget
        )
        return [
            {k: e.get(k) for k in ("id", "timestamp", "eventData", "sandboxExecutionId", "sandboxTeamId")}
            for e in (data or [])
        ]

    def stop(page: list[dict]) -> bool:
        ts = [t for t in (_ts(e.get("timestamp")) for e in page) if t]
        return bool(ts) and min(ts) < horizon

    try:
        events = _parallel_offset_pages(fetch, limit, stop, budget, workers=6)
        running, _ = _get("https://api.e2b.dev/v2/sandboxes?state=running,paused&limit=100", headers, budget)
    except TimeoutError as exc:
        return _unavailable(basis, f"E2B listing incomplete: {exc}")
    except RuntimeError as exc:
        return _unavailable(basis, f"E2B API failed: {exc}")
    pro: bool | None = None
    team = next((e.get("sandboxTeamId") for e in events if e.get("sandboxTeamId")), None)
    if team:
        try:
            peak, _ = _get(
                f"https://api.e2b.dev/teams/{team}/metrics/max?start={int(start.timestamp())}"
                f"&end={int(end.timestamp())}&metric=concurrent_sandboxes",
                headers,
                budget,
            )
            pro = True if float(peak.get("value") or 0) > E2B_HOBBY_MAX_CONCURRENCY else None
        except (RuntimeError, TimeoutError, AttributeError):
            pro = None
    return e2b_cost_from_events(events, running or [], start, end, pro)


# ------------------------------------------------------------------ self-test
def self_test() -> None:
    start = datetime(2026, 10, 12, 19, tzinfo=timezone.utc)
    end = start + timedelta(days=7)
    days = 7.0

    def iso(dt: datetime) -> str:
        return dt.isoformat().replace("+00:00", "Z")

    # Kernel: 2h headful inside, 4h headless inside, 2h headful half outside, 1 fully outside.
    k = kernel_cost_from_sessions(
        [
            {"created_at": iso(start + timedelta(hours=1)), "deleted_at": iso(start + timedelta(hours=3)),
             "headless": False, "usage": {"uptime_ms": 7_200_000}},
            {"created_at": iso(start + timedelta(hours=5)), "deleted_at": iso(start + timedelta(hours=9)),
             "headless": True, "usage": {"uptime_ms": 14_400_000}},
            {"created_at": iso(start - timedelta(hours=1)), "deleted_at": iso(start + timedelta(hours=1)),
             "headless": False, "usage": {"uptime_ms": 7_200_000}},
            {"created_at": iso(start - timedelta(hours=9)), "deleted_at": iso(start - timedelta(hours=8)),
             "headless": False, "usage": {"uptime_ms": 3_600_000}},
        ],
        start,
        end,
    )
    usage = 3 * 0.48 + 4 * 0.06
    fee = 200 * days / DAYS_PER_MONTH
    exp = fee + usage - min(usage, 50 * days / DAYS_PER_MONTH)
    assert k["status"] == "ready" and abs(k["usd"] - round(exp, 2)) < 0.011, (k, exp)
    assert "3 sessions" in k["detail"], k

    # Steel: 61s -> 2 billed minutes; proxy only for Steel-sourced bytes.
    s = steel_cost_from_sessions(
        [
            {"createdAt": iso(start + timedelta(hours=1)), "duration": 61_000, "proxySource": "steel",
             "proxyBytesUsed": 2e9},
            {"createdAt": iso(start + timedelta(hours=2)), "duration": 3_600_000, "proxySource": None,
             "proxyBytesUsed": 5e9},
            {"createdAt": iso(end + timedelta(minutes=1)), "duration": 60_000, "proxySource": "steel",
             "proxyBytesUsed": 1e9},
        ],
        start,
        end,
    )
    usage = (62 / 60) * 0.08 + 2 * 6.0
    fee = 250 * days / DAYS_PER_MONTH
    exp = fee + usage - min(usage, 100 * days / DAYS_PER_MONTH)
    assert abs(s["usd"] - round(exp, 2)) < 0.011, (s, exp)
    assert "2 sessions" in s["detail"], s

    # E2B: 1h at 2 vCPU/1 GiB inside; duplicate execution counted once; half-overlapping run.
    ev = {"id": "a", "sandboxExecutionId": "x", "timestamp": iso(start + timedelta(hours=2)),
          "eventData": {"execution": {"started_at": iso(start + timedelta(hours=1)), "execution_time": 3_600_000,
                                      "vcpu_count": 2, "memory_mb": 1024}}}
    ev2 = {"id": "b", "sandboxExecutionId": "y", "timestamp": iso(start + timedelta(minutes=30)),
           "eventData": {"execution": {"started_at": iso(start - timedelta(minutes=30)), "execution_time": 3_600_000,
                                       "vcpu_count": 2, "memory_mb": 2048}}}
    e = e2b_cost_from_events([ev, dict(ev), ev2], [], start, end, True)
    usage = 3600 * (2 * 0.000014 + 1 * 0.0000045) + 1800 * (2 * 0.000014 + 2 * 0.0000045)
    exp = usage + 150 * days / DAYS_PER_MONTH
    assert abs(e["usd"] - round(exp, 2)) < 0.011, (e, exp)
    assert "2 sandbox runs" in e["detail"], e

    assert _ts("2026-10-19T18:55:18.533623693Z") == datetime(2026, 10, 19, 18, 55, 18, 533623, tzinfo=timezone.utc)
    try:
        kernel_cost({}, datetime(2026, 1, 1), datetime(2026, 1, 2))
    except ValueError:
        pass
    else:
        raise AssertionError("naive datetimes must be rejected")
    assert kernel_cost({}, start, end)["status"] == "unavailable"
    print("self_test ok")


def load_env(root: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for rel in ("agents/.env", "back-end/.env"):
        p = root / rel
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip().removeprefix("export ").strip()
            v = v.strip().strip('"').strip("'")
            if v and not env.get(k):
                env[k] = v
    return env


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        self_test()
        return 0
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=7)
    for a in argv:
        if a.startswith("--start="):
            start = _ts(a.split("=", 1)[1]) or start
        if a.startswith("--end="):
            end = _ts(a.split("=", 1)[1]) or end
    env = load_env(Path(__file__).resolve().parent.parent)
    out: dict[str, Any] = {"start": start.isoformat(), "end": end.isoformat()}
    fns = {"kernel": kernel_cost, "steel": steel_cost, "e2b": e2b_cost}
    def timed(fn: Callable[..., dict]) -> dict[str, Any]:
        t0 = time.monotonic()
        try:
            res = fn(env, start, end)
        except Exception as exc:  # report, never a partial number
            res = _unavailable("n/a", f"{type(exc).__name__}: {str(exc)[:160]}")
        res["elapsed_s"] = round(time.monotonic() - t0, 1)
        return res

    with ThreadPoolExecutor(max_workers=3) as pool:
        futs = {name: pool.submit(timed, fn) for name, fn in fns.items()}
        for name, fut in futs.items():
            out[name] = fut.result()
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
