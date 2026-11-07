#!/usr/bin/env python3
"""Size a deploy's smoke width from LIVE usage of provider accounts every deploy shares.

The reviewed registry cap (cloudbench-provider-capacity.py) assumes one fleet is
alone on each provider account. Tilion's 20 browsers are ONE account shared by
production, dev and every devbox's deploys, so two concurrent deploys that each
sized their smoke run to the full cap (16) asked for 32 and starved each other
and production. Tilion lists the account's live sessions (GET /v1/sessions, the
call the backend orphan reaper already makes), so admission derives the width
from that live state instead of from a new lease store:

    usable   = limit * (1 - production_reserve_fraction)        # 20 * 0.8 = 16
    headroom = floor((usable - live_sessions) / per_bench_peak)  # every deploy + prod
    width    = min(requested, registry cap, headroom)

    probe ──▶ headroom >= 1 ─────────────────────────────▶ admit width
      │          └─ headroom < 1 or probe error ─▶ ⏳ progress line, sleep poll
      │                  └─ deadline reached ──────────────▶ refuse (ValueError)
      └─ no credential on this devbox ──▶ ⚠️ UNMEASURED, registry cap (old behavior)

Production keeps its reserve on top of what it is already using, and a deploy
that cannot get one browser waits (bounded by the caller's deadline) instead of
taking production's slots. A deploy launched before another deploy's guests
have opened their sessions cannot see them yet; once sessions are open every
later deploy sees them.

Cerebras (300 requests/min) is one organization shared by production, every
deploy's smoke fleet and every deploy's local latency ratchet. Its usage is
visible only in response headers (x-ratelimit-remaining/limit/reset-<window>,
parsed exactly as agents/providers/rose/cerebras.py does), so `cerebras-wait`
spends one 1-token completion per check and waits, bounded, while a per-minute
window is below the production reserve or the probe answers 429:

    cloudbench_provider_headroom.py cerebras-wait --timeout-seconds N   # 0 ready, 1 timed out

CEREBRAS_RATCHET_API_KEY, when set, is probed instead of CEREBRAS_API_KEY (a
dedicated ratchet credential must also be the one its local stack serves).
Standard library only; credentials never reach output or exceptions.
"""
from __future__ import annotations

import argparse
from fractions import Fraction
import json
import math
import os
from pathlib import Path
import runpy
import sys
import time
from typing import Callable
import urllib.error
import urllib.request

TILION_ROW = "tilion-browser-sessions"
TILION_DEFAULT_BASE_URL = "https://back.tilion.dev"
TILION_TIMEOUT_SECONDS = 15.0
MAX_LISTING_BYTES = 1024 * 1024
DEFAULT_WAIT_SECONDS = 900.0
POLL_SECONDS = 30.0
BACKEND_ENV_FILE = Path(__file__).resolve().parents[1] / "back-end" / ".env"
CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions"
CEREBRAS_MODEL = "qwen-3.8-27b"  # back-end/src/providers/rose/cerebrasRoute.ts CEREBRAS_CHAT_MODEL
CEREBRAS_MAX_PAUSE_SECONDS = 60.0  # every per-minute window resets within one minute

Probe = Callable[[], "int | None"]


class HeadroomUnavailable(RuntimeError):
    """Live usage could not be read; the message never carries a credential."""


class HeadroomRefused(ValueError):
    """The shared provider account has no headroom by the caller's deadline."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # a redirect must never carry the bearer token to another host


def _open(request: urllib.request.Request, timeout: float):
    return urllib.request.build_opener(_NoRedirect).open(request, timeout=timeout)


def tilion_live_sessions(api_key: str, base_url: str = TILION_DEFAULT_BASE_URL, *,
                         opener: Callable = _open, timeout: float = TILION_TIMEOUT_SECONDS) -> int:
    """Account-wide live Tilion sessions (prod + every deploy + dev); never implies ownership."""
    base = base_url.rstrip("/")
    if not base.startswith("https://"):
        raise HeadroomUnavailable("Tilion base URL must be https")
    request = urllib.request.Request(base + "/v1/sessions", method="GET", headers={
        "Authorization": f"Bearer {api_key}", "Accept": "application/json"})
    try:
        with opener(request, timeout) as response:
            status = getattr(response, "status", 200)
            body = response.read(MAX_LISTING_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise HeadroomUnavailable(f"Tilion GET /v1/sessions answered HTTP {error.code}") from None
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise HeadroomUnavailable(f"Tilion GET /v1/sessions failed: {type(error).__name__}") from None
    if status != 200:
        raise HeadroomUnavailable(f"Tilion GET /v1/sessions answered HTTP {status}")
    if len(body) > MAX_LISTING_BYTES:
        raise HeadroomUnavailable("Tilion session listing exceeds its size bound")
    try:
        sessions = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise HeadroomUnavailable("Tilion session listing is not JSON") from None
    if not isinstance(sessions, list) or any(not isinstance(item, dict) for item in sessions):
        raise HeadroomUnavailable("Tilion session listing is not a list of sessions")
    return len(sessions)  # every listed record holds a browser slot (conservative)


def _setting(name: str, env_file: Path, environ) -> str | None:
    value = environ.get(name)
    if value and value.strip():
        return value.strip()
    capacity = runpy.run_path(str(Path(__file__).resolve().with_name("cloudbench-provider-capacity.py")))
    found = capacity["dotenv_value"](env_file, name)
    return found.strip() if found and found.strip() else None


def live_probes(environ=None, env_file: Path | None = None) -> dict[str, Probe]:
    """Registry row id -> zero-argument live-usage probe (None result = UNMEASURED)."""
    environ = os.environ if environ is None else environ
    env_file = env_file or BACKEND_ENV_FILE

    def tilion() -> int | None:
        key = _setting("TILION_API_KEY", env_file, environ)
        if key is None:
            return None
        return tilion_live_sessions(key, _setting("TILION_BASE_URL", env_file, environ)
                                    or TILION_DEFAULT_BASE_URL)
    return {TILION_ROW: tilion}


def _percent(reserve: Fraction) -> str:
    value = reserve * 100
    return f"{value.numerator}%" if value.denominator == 1 else f"{float(value):g}%"


def admitted_width(requested: int, registry: dict, *, probes: dict[str, Probe], deadline: float,
                   clock: Callable[[], float] | None = None, sleep: Callable[[float], None] | None = None,
                   stream=None, poll_seconds: float = POLL_SECONDS) -> int:
    """min(requested, registry cap, live headroom of every bound shared account)."""
    stream = stream or sys.stderr
    clock, sleep = clock or time.time, sleep or time.sleep
    width = min(requested, registry["cap"])
    rows = [row for row in registry["enforced"] if row["id"] in probes]
    if width < 1 or not rows:
        return width
    reserve = registry["reserve"]
    while True:
        admitted, waits = width, []
        for row in rows:
            name, limit = row["name"], Fraction(row["limit"])
            try:
                live = probes[row["id"]]()
            except HeadroomUnavailable as error:
                admitted = 0
                waits.append(f"{name}: live usage unreadable ({error})")
                continue
            if live is None:
                print(f"⚠️  {name}: live account usage UNMEASURED (no credential on this devbox); "
                      f"sizing from the reviewed registry cap {row['cap']} only", file=stream, flush=True)
                continue
            usable = limit * (1 - reserve)
            headroom = max(0, math.floor((usable - live) / Fraction(row["per_bench_peak"])))
            print(f"🧮 {name}: {live} live account-wide of {limit} ({_percent(reserve)} reserved for production)"
                  f" → headroom {headroom} concurrent benches", file=stream, flush=True)
            admitted = min(admitted, headroom)
            if headroom < 1:
                waits.append(f"{name}: {live} live of {limit}, {_percent(reserve)} reserved for production")
        if admitted >= 1:
            print(f"🧮 provider headroom admits {admitted} concurrent smoke benches "
                  f"(requested {requested}, registry cap {registry['cap']})", file=stream, flush=True)
            return admitted
        remaining = deadline - clock()
        if remaining <= 0:
            raise HeadroomRefused("shared provider capacity cannot admit one smoke task by the deadline: "
                                  + "; ".join(waits))
        pause = min(poll_seconds, remaining)
        print(f"⏳ waiting for shared provider headroom ({'; '.join(waits)}); next check in {pause:.0f}s, "
              f"{remaining:.0f}s before refusing", file=stream, flush=True)
        sleep(pause)


def _float(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def cerebras_minute_windows(api_key: str, *, opener: Callable = _open,
                            timeout: float = TILION_TIMEOUT_SECONDS) -> tuple[int, dict, float | None]:
    """(status, {window: (remaining, limit, reset_s)}, retry_after_s) from one 1-token completion."""
    payload = json.dumps({"model": CEREBRAS_MODEL, "messages": [{"role": "user", "content": "ok"}],
                          "max_completion_tokens": 1, "stream": False}).encode()
    request = urllib.request.Request(CEREBRAS_URL, data=payload, method="POST", headers={
        "Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
    try:
        with opener(request, timeout) as response:
            status, headers = getattr(response, "status", 200), response.headers
            response.read(MAX_LISTING_BYTES)
    except urllib.error.HTTPError as error:
        status, headers = error.code, error.headers
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise HeadroomUnavailable(f"Cerebras quota probe failed: {type(error).__name__}") from None
    if status not in (200, 429):
        raise HeadroomUnavailable(f"Cerebras quota probe answered HTTP {status}")
    lowered = {str(name).lower(): value for name, value in (headers or {}).items()}
    windows = {}
    for name, value in lowered.items():
        if not name.startswith("x-ratelimit-remaining-") or not name.endswith("-minute"):
            continue
        window = name.removeprefix("x-ratelimit-remaining-")
        windows[window] = (_float(value), _float(lowered.get(f"x-ratelimit-limit-{window}")),
                           _float(lowered.get(f"x-ratelimit-reset-{window}")))
    return status, windows, _float(lowered.get("retry-after"))


def wait_for_cerebras(api_key: str, *, reserve: Fraction, deadline: float, opener: Callable = _open,
                      clock: Callable[[], float] | None = None, sleep: Callable[[float], None] | None = None,
                      stream=None) -> bool:
    """True once no per-minute window is inside the production reserve; False at the deadline."""
    stream = stream or sys.stdout
    clock, sleep = clock or time.time, sleep or time.sleep
    while True:
        short, pauses = [], []
        try:
            status, windows, retry_after = cerebras_minute_windows(api_key, opener=opener)
        except HeadroomUnavailable as error:
            short.append(str(error))
            pauses.append(POLL_SECONDS)
        else:
            if status == 429:
                short.append("probe answered 429")
                pauses.append(retry_after if retry_after is not None else CEREBRAS_MAX_PAUSE_SECONDS)
            for window, (remaining, limit, reset) in sorted(windows.items()):
                if remaining is not None and limit and remaining < limit * reserve:
                    short.append(f"{window} {remaining:g} of {limit:g} remaining")
                    pauses.append(reset if reset is not None else CEREBRAS_MAX_PAUSE_SECONDS)
            if not short:
                described = ", ".join(f"{w} {r:g}/{lim:g}" for w, (r, lim, _s) in sorted(windows.items())
                                      if r is not None and lim) or "no per-minute window reported"
                print(f"🧮 Cerebras shared quota ready ({described}; production reserve {_percent(reserve)})",
                      file=stream, flush=True)
                return True
        remaining_s = deadline - clock()
        if remaining_s <= 0:
            print(f"FAIL: Cerebras shared quota still short at the deadline: {'; '.join(short)}",
                  file=sys.stderr, flush=True)
            return False
        pause = min(max(1.0, max(pauses)), CEREBRAS_MAX_PAUSE_SECONDS, remaining_s)
        print(f"⏳ waiting for the shared Cerebras quota ({'; '.join(short)}; production reserve "
              f"{_percent(reserve)}); next check in {pause:.0f}s, {remaining_s:.0f}s before failing",
              file=stream, flush=True)
        sleep(pause)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    waiting = commands.add_parser("cerebras-wait", help="wait until the shared Cerebras quota has headroom")
    waiting.add_argument("--timeout-seconds", required=True, type=int)
    args = parser.parse_args(argv)
    if args.timeout_seconds < 0:
        parser.error("--timeout-seconds must be nonnegative")
    key = _setting("CEREBRAS_RATCHET_API_KEY", BACKEND_ENV_FILE, os.environ) \
        or _setting("CEREBRAS_API_KEY", BACKEND_ENV_FILE, os.environ)
    if key is None:
        print("⚠️  Cerebras shared quota UNMEASURED (no CEREBRAS_API_KEY on this devbox)", flush=True)
        return 0
    capacity = runpy.run_path(str(Path(__file__).resolve().with_name("cloudbench-provider-capacity.py")))
    reserve = capacity["load_registry"]()["reserve"]
    ready = wait_for_cerebras(key, reserve=reserve, deadline=time.time() + args.timeout_seconds)
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
