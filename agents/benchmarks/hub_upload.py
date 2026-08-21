"""Register and upload benchmark runs to the in-app Benchmark Hub.

Env-gated so MANUAL runs (local `scripts/run-bench --local`, on-box cloud
drivers) land in the in-app hub without the dispatch poller:

    BENCHMARK_HUB_UPLOAD_URL   e.g. https://navi-j9a9.onrender.com (unset = off)
    BENCHMARK_HUB_API_KEY      internal backend key (falls back to BACKEND_API_KEY)
    BENCHMARK_HUB_USER_ID      attribution (defaults to the benchmark runner user)

Actual benchmark entrypoints register fail-closed before execution. Completed
bundle uploads remain best-effort only for library callers that did not opt in
to the required runner contract.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import time
from urllib.parse import quote
import urllib.error
import urllib.request

DEFAULT_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
DEFAULT_HUB_URL = "https://navi-j9a9.onrender.com"
DURABLE_OPEN_AGENT_ORIGIN = "https://www.roselabs.ai"


class HubVisibilityError(RuntimeError):
    """A benchmark could not prove its run is visible in the in-app Hub."""


def hub_upload_enabled() -> bool:
    return bool(os.getenv("BENCHMARK_HUB_UPLOAD_URL"))


def is_ephemeral_hub_url(url: str | None) -> bool:
    """True when a Hub URL dies with the local/isolated stack that hosts it."""
    candidate = (url or "").rstrip("/")
    return candidate.startswith("http://localhost") or candidate.startswith(
        "http://127.0.0.1"
    )


def durable_open_agent_url(agent_id: str) -> str:
    """Always-on FE deep link that rehydrates archived bench agents from the Hub."""
    return f"{DURABLE_OPEN_AGENT_ORIGIN}/open-agent?agent-id={agent_id}"


def resolve_hub_upload_url(base_url: str | None = None) -> str:
    """Pick the Hub URL for fail-closed registration.

    Explicit ``BENCHMARK_HUB_UPLOAD_URL`` always wins. For localhost /
    127.0.0.1 stacks with no override, prefer the stack under test so a
    production outage cannot deadlock local smoke ``/deploy`` of the outage
    fix. Otherwise default to the always-on production Hub.

    Ephemeral (localhost) registration stays fail-closed against the stack
    under test; ``mirror_run_bundle_to_durable_hub`` dual-writes the terminal
    bundle to ``DEFAULT_HUB_URL`` so ``roselabs.ai/open-agent`` keeps working
    after teardown.
    """
    configured = (os.getenv("BENCHMARK_HUB_UPLOAD_URL") or "").rstrip("/")
    if configured:
        return configured
    candidate = (base_url or "").rstrip("/")
    if is_ephemeral_hub_url(candidate):
        return candidate
    return DEFAULT_HUB_URL


def _hub_url(*, required: bool) -> str:
    configured = (os.getenv("BENCHMARK_HUB_UPLOAD_URL") or "").rstrip("/")
    return configured or (DEFAULT_HUB_URL if required else "")

def _auth_headers(*, required: bool) -> dict[str, str] | None:
    key = os.getenv("BENCHMARK_HUB_API_KEY") or os.getenv("BACKEND_API_KEY") or ""
    if not key:
        if required:
            raise HubVisibilityError("benchmark Hub API key is missing")
        print("⚠️  hub upload skipped: no BENCHMARK_HUB_API_KEY/BACKEND_API_KEY")
        return None
    user_id = os.getenv("BENCHMARK_HUB_USER_ID") or DEFAULT_USER_ID
    return {
        "X-API-Key": key,
        "X-User-Id": user_id,
        "Content-Type": "application/json",
    }


def _post_run_bundle(
    base: str,
    bundle: dict,
    *,
    timeout: float,
    live: bool,
    required: bool,
    label: str,
) -> bool:
    headers = _auth_headers(required=required)
    if headers is None:
        return False
    body = dict(bundle)
    body.setdefault("source", "manual-run")
    suffix = "?live=1" if live else ""
    request = urllib.request.Request(
        f"{base.rstrip('/')}/api/benchmarks/runs{suffix}",
        data=json.dumps(body, default=str).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    # Localhost hub URLs must never route through an ambient HTTP proxy
    # (e.g. the fast-mode proxy) — same trap as archive_api's _direct_opener.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    max_attempts = 4 if required else 1
    for attempt in range(1, max_attempts + 1):
        try:
            with opener.open(request, timeout=timeout) as response:
                ok = 200 <= response.status < 300
                if ok:
                    print(f"📤 uploaded run bundle to {label}: {body.get('run_id')}")
                return ok
        except Exception as exc:
            retryable = not isinstance(exc, urllib.error.HTTPError) or exc.code in {
                408,
                425,
                429,
            } or exc.code >= 500
            if required and retryable and attempt < max_attempts:
                delay = min(2 ** (attempt - 1), 4)
                print(
                    f"⚠️  benchmark Hub upload attempt {attempt}/{max_attempts} "
                    f"failed transiently; retrying in {delay}s: {exc}"
                )
                time.sleep(delay)
                continue
            if required:
                raise HubVisibilityError(f"benchmark Hub upload failed: {exc}") from exc
            print(f"⚠️  hub upload failed (non-fatal): {exc}")
            return False
    raise AssertionError("unreachable")


def upload_run_bundle(
    bundle: dict,
    *,
    timeout: float = 30.0,
    live: bool = False,
    required: bool = False,
) -> bool:
    """POST the bundle to the hub. Returns True on success, False otherwise."""
    base = _hub_url(required=required)
    if not base:
        return False
    return _post_run_bundle(
        base,
        bundle,
        timeout=timeout,
        live=live,
        required=required,
        label="hub",
    )


def mirror_run_bundle_to_durable_hub(
    bundle: dict,
    *,
    timeout: float = 30.0,
) -> bool:
    """Dual-write terminal bundles from ephemeral Hubs to the always-on Hub.

    Fail-closed launch registration still targets the local stack (so a prod
    outage cannot deadlock ``/deploy``). After the run finishes, mirror the
    final bundle to ``DEFAULT_HUB_URL`` whenever the configured Hub is
    localhost/127.0.0.1 — otherwise ``roselabs.ai/open-agent`` 404s once the
    isolated stack tears down.

    Best-effort by default. Cloud Agent sessions (``CURSOR_AGENT`` set) treat a
    failed mirror as an error so FE evidence cannot silently rot.
    """
    primary = _hub_url(required=False)
    if not primary or not is_ephemeral_hub_url(primary):
        return False
    durable = DEFAULT_HUB_URL.rstrip("/")
    if primary.rstrip("/") == durable:
        return False
    required = bool(os.getenv("CURSOR_AGENT"))
    try:
        return _post_run_bundle(
            durable,
            bundle,
            timeout=timeout,
            live=False,
            required=required,
            label="durable hub",
        )
    except HubVisibilityError as exc:
        print(f"❌ durable hub mirror failed: {exc}")
        raise


def print_durable_agent_links(bundle: dict) -> None:
    """Print always-on open-agent URLs for every agent_id in the run bundle."""
    tasks = bundle.get("tasks") or []
    if not isinstance(tasks, list):
        return
    printed = False
    for task in tasks:
        if not isinstance(task, dict):
            continue
        agent_id = task.get("agent_id")
        if not agent_id:
            continue
        name = task.get("name") or "task"
        print(f"🔗 durable FE ({name}): {durable_open_agent_url(str(agent_id))}")
        printed = True
    if printed:
        print(
            "   (rehydrates from the in-app Benchmark Hub after the local stack is gone)"
        )


def verify_run_visible(run_id: str, *, timeout: float = 30.0) -> None:
    """Prove that the in-app read path resolves an exact run identifier."""
    if not run_id:
        raise HubVisibilityError("benchmark run_id is required for Hub registration")
    base = _hub_url(required=True)
    headers = _auth_headers(required=True)
    assert headers is not None
    request = urllib.request.Request(
        f"{base}/api/benchmarks/runs/{quote(run_id, safe='')}",
        headers=headers,
        method="GET",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            payload = json.loads(response.read() or b"{}")
    except Exception as exc:
        raise HubVisibilityError(f"benchmark Hub visibility check failed: {exc}") from exc
    visible_id = ((payload.get("run") or {}).get("run_id")) if isinstance(payload, dict) else None
    if visible_id != run_id:
        raise HubVisibilityError(
            f"benchmark Hub returned the wrong run after registration: {visible_id!r}"
        )
    print(f"✅ in-app Benchmark Hub registration verified: run={run_id}")


def require_run_visible(bundle: dict, *, timeout: float = 30.0) -> None:
    """Create a live Hub row and prove that the in-app read path can resolve it."""
    run_id = str(bundle.get("run_id") or "")
    if not run_id:
        raise HubVisibilityError("benchmark run_id is required for Hub registration")
    upload_run_bundle(bundle, timeout=timeout, live=True, required=True)
    verify_run_visible(run_id, timeout=timeout)


def _main() -> int:
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--require-visible", metavar="BUNDLE_JSON")
    action.add_argument("--upload-final", metavar="BUNDLE_JSON")
    action.add_argument("--verify-visible", metavar="RUN_ID")
    parser.add_argument("--run-id")
    parser.add_argument("--source", default="direct-benchmark")
    args = parser.parse_args()
    if args.verify_visible:
        verify_run_visible(args.verify_visible)
        return 0
    path = Path(args.require_visible or args.upload_final)
    bundle = json.loads(path.read_text())
    if args.run_id:
        bundle["run_id"] = args.run_id
    bundle.setdefault("source", args.source)
    if args.require_visible:
        require_run_visible(bundle)
    else:
        upload_run_bundle(bundle, required=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
