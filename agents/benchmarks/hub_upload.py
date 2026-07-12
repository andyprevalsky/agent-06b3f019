"""Best-effort upload of a completed benchmark run bundle to the Benchmark Hub.

Env-gated so MANUAL runs (local `scripts/run-bench --local`, on-box cloud
drivers) land in the in-app hub without the dispatch poller:

    BENCHMARK_HUB_UPLOAD_URL   e.g. https://navi-j9a9.onrender.com (unset = off)
    BENCHMARK_HUB_API_KEY      internal backend key (falls back to BACKEND_API_KEY)
    BENCHMARK_HUB_USER_ID      attribution (defaults to the benchmark runner user)

Uploads must NEVER fail the run: every error is swallowed after one line of
diagnostics.
"""

from __future__ import annotations

import json
import os
import urllib.request

DEFAULT_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"


def hub_upload_enabled() -> bool:
    return bool(os.getenv("BENCHMARK_HUB_UPLOAD_URL"))


def upload_run_bundle(bundle: dict, *, timeout: float = 30.0) -> bool:
    """POST the bundle to the hub. Returns True on success, False otherwise."""
    base = (os.getenv("BENCHMARK_HUB_UPLOAD_URL") or "").rstrip("/")
    if not base:
        return False
    key = os.getenv("BENCHMARK_HUB_API_KEY") or os.getenv("BACKEND_API_KEY") or ""
    if not key:
        print("⚠️  hub upload skipped: no BENCHMARK_HUB_API_KEY/BACKEND_API_KEY")
        return False
    user_id = os.getenv("BENCHMARK_HUB_USER_ID") or DEFAULT_USER_ID
    body = dict(bundle)
    body.setdefault("source", "manual-run")
    request = urllib.request.Request(
        f"{base}/api/benchmarks/runs",
        data=json.dumps(body, default=str).encode("utf-8"),
        headers={
            "X-API-Key": key,
            "X-User-Id": user_id,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    # Localhost hub URLs must never route through an ambient HTTP proxy
    # (e.g. the fast-mode proxy) — same trap as archive_api's _direct_opener.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            ok = 200 <= response.status < 300
            if ok:
                print(f"📤 uploaded run bundle to hub: {body.get('run_id')}")
            return ok
    except Exception as e:  # noqa: BLE001 — uploads are strictly best-effort
        print(f"⚠️  hub upload failed (non-fatal): {e}")
        return False
