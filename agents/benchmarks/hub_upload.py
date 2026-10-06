"""Register and upload benchmark runs to the in-app Benchmark Hub.

Env-gated so MANUAL runs (local `scripts/run-bench --local`, on-box cloud
drivers) land in the in-app hub without the dispatch poller:

    BENCHMARK_HUB_UPLOAD_URL   e.g. https://navi-j9a9.onrender.com (unset = off)
    BENCHMARK_HUB_API_KEY      internal backend key (falls back to BACKEND_API_KEY)
    BENCHMARK_HUB_USER_ID      attribution (defaults to the benchmark runner user)

Cloud fleets retain their publication owner before attempting an early status
write; transient transport delays warn while execution can continue. Other
entrypoints retain fail-closed registration. Required terminal uploads and
their durable verification remain part of the runner contract.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

# Script-mode (`python agents/benchmarks/hub_upload.py`) puts this file's
# directory on sys.path, not `agents/`. Cloudbench copies run that way.
# Put `agents/` on sys.path so `from benchmarks.logs` works when a sibling
# `logs.py` is absent; `_load_tree_helpers` still prefers the sibling file
# so a colliding `benchmarks` package cannot win.
_AGENTS_ROOT = Path(__file__).resolve().parents[1]
if str(_AGENTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_AGENTS_ROOT))

DEFAULT_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
DEFAULT_HUB_URL = "https://navi-j9a9.onrender.com"
DURABLE_OPEN_AGENT_ORIGIN = "https://www.roselabs.ai"


class HubVisibilityError(RuntimeError):
    """A benchmark could not prove its run is visible in the in-app Hub."""


def _safe_http_error_metadata(error: urllib.error.HTTPError) -> dict:
    """Keep upstream correlation without reading bodies or reflecting arbitrary headers."""
    result = {"status": error.code}
    headers = error.headers or {}
    for name, pattern in (
        ("CF-Ray", r"[0-9a-fA-F]{16,32}-[A-Z]{3}"),
        ("Rndr-Id", r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"),
        ("X-Request-Id", r"[0-9a-fA-F]{12}"),
        ("X-Span-Id", r"[0-9a-fA-F]{12}"),
    ):
        value = headers.get(name, "")
        if re.fullmatch(pattern, value):
            result[name.lower().replace("-", "_")] = value
    content_type = headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
    if content_type in {"application/json", "text/html", "text/plain", "application/octet-stream"}:
        result["content_type"] = content_type
    server = headers.get("Server", "").lower()
    if server in {"cloudflare", "render", "nginx"}:
        result["server"] = server
    if headers.get("CF-Mitigated") == "challenge":
        result["cf_mitigated"] = "challenge"
    length = headers.get("Content-Length", "")
    if re.fullmatch(r"[0-9]{1,10}", length):
        result["content_length"] = int(length)
    return result


def upload_timeout_for_payload(payload_bytes: int, *, base_timeout: float = 30.0) -> float:
    """Derive a Hub POST timeout that scales with payload size.

    Mass-agent smoke bundles can exceed 40MB; a flat 30s deadline times out on
    upload after the task already passed (seen on test-mass-agent-run-0). Floor
    at ``base_timeout``, grow ~2s per MB, and cap at 300s.
    """
    size = max(0, int(payload_bytes))
    derived = float(base_timeout) + (size / (512 * 1024))
    return min(300.0, max(float(base_timeout), derived))


# The backend accepts JSON bodies up to 100MB (back-end/src/server.ts). A
# 26-task run record is ~125MB, almost all of it raw worker log lines, and the
# 413 that came back turned a fully passing run into a failed invocation.
HUB_UPLOAD_MAX_BYTES = 90 * 1024 * 1024
WORKER_LOG_TRIM_KEY = "worker_logs"


def _encoded_size(value) -> int:
    return len(json.dumps(value, default=str).encode("utf-8"))


def fit_bundle_to_upload_limit(body: dict, *, max_bytes: int = HUB_UPLOAD_MAX_BYTES) -> dict:
    """Keep the upload under the Hub's body limit by shortening raw worker logs.

    Transcripts, trees and evaluator evidence are what the Hub renders, so they
    are never touched. Worker log lines are dropped oldest-first from the task
    that has the most, and each task records how many were left out. The full
    record stays on disk in ``runs/*.json``.
    """
    if _encoded_size(body) <= max_bytes:
        return body
    fitted = dict(body)
    tasks = [dict(task) if isinstance(task, dict) else task for task in fitted.get("tasks") or []]
    fitted["tasks"] = tasks
    for task in tasks:
        if isinstance(task, dict) and isinstance(task.get("logs"), dict):
            task["logs"] = dict(task["logs"])
    while _encoded_size(fitted) > max_bytes:
        candidates = [
            task
            for task in tasks
            if isinstance(task, dict)
            and isinstance((task.get("logs") or {}).get(WORKER_LOG_TRIM_KEY), list)
            and task["logs"][WORKER_LOG_TRIM_KEY]
        ]
        if not candidates:
            break
        heaviest = max(candidates, key=lambda task: _encoded_size(task["logs"][WORKER_LOG_TRIM_KEY]))
        lines = heaviest["logs"][WORKER_LOG_TRIM_KEY]
        keep = len(lines) // 2
        dropped = len(lines) - keep
        heaviest["logs"][WORKER_LOG_TRIM_KEY] = lines[dropped:]
        heaviest["logs"]["worker_logs_omitted_for_upload"] = (
            int(heaviest["logs"].get("worker_logs_omitted_for_upload") or 0) + dropped
        )
    omitted = sum(
        int((task.get("logs") or {}).get("worker_logs_omitted_for_upload") or 0)
        for task in tasks
        if isinstance(task, dict)
    )
    limit_mb = max_bytes // (1024 * 1024)
    print(f"✂️  Hub upload: left out {omitted} oldest worker log line(s) to fit the {limit_mb}MB body limit")
    return fitted


def hub_upload_enabled() -> bool:
    return bool(os.getenv("BENCHMARK_HUB_UPLOAD_URL"))


def is_ephemeral_hub_url(url: str | None) -> bool:
    """True when a Hub URL dies with the local/isolated stack that hosts it."""
    candidate = (url or "").rstrip("/")
    return candidate.startswith("http://localhost") or candidate.startswith("http://127.0.0.1")


def durable_open_agent_url(agent_id: str) -> str:
    """Always-on FE deep link that rehydrates archived bench agents from the Hub.

    Canonical shape is ``/?agent-id=…`` (Terminal route). ``/open-agent`` is an
    alias that the SPA redirects to the same query — never cite a path the
    production route table does not serve, or the SPA renders NotFound while
    HTTP still returns 200.
    """
    return f"{DURABLE_OPEN_AGENT_ORIGIN}/?agent-id={agent_id}"


def resolve_hub_upload_url(base_url: str | None = None) -> str:
    """Pick the Hub URL for fail-closed registration.

    Explicit ``BENCHMARK_HUB_UPLOAD_URL`` always wins. For localhost /
    127.0.0.1 stacks with no override, prefer the stack under test so a
    production outage cannot deadlock local smoke ``/deploy`` of the outage
    fix. Otherwise default to the always-on production Hub.

    Ephemeral (localhost) registration stays fail-closed against the stack
    under test; ``mirror_run_bundle_to_durable_hub`` dual-writes the terminal
    bundle to ``DEFAULT_HUB_URL`` so ``roselabs.ai/?agent-id=`` keeps working
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


def _hub_opener(url: str):
    """Keep loopback local and preserve configured routing for external Hubs."""
    if urlparse(url).hostname in {"localhost", "127.0.0.1", "::1"}:
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener()


_TOOL_USAGE_TREE_KEYS = frozenset(
    {
        "root_agent_id",
        "agent_count",
        "tool_usage_count",
        "llm_call_count",
        "tokens_in",
        "tokens_out",
        "total_cost_cents",
        "total_cost_dollars",
        "total_tokens_from_tools",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    }
)


def _fallback_canonicalize_agent_tree(raw):
    """Keep only agent-id-keyed nodes with parent/goal/status/messages."""
    if not isinstance(raw, dict):
        return {}
    out = {}
    for key, value in raw.items():
        if not key or key in _TOOL_USAGE_TREE_KEYS or not isinstance(value, dict):
            continue
        if not (
            isinstance(value.get("messages"), list)
            or "parent_agent_id" in value
            or isinstance(value.get("goal"), str)
            or isinstance(value.get("status"), str)
        ):
            continue
        out[str(key)] = value
    return out


def _fallback_tree_child_transcript_count(tree, root_id):
    canonical = _fallback_canonicalize_agent_tree(tree)
    return sum(
        1
        for agent_id, info in canonical.items()
        if agent_id != root_id and isinstance(info.get("messages"), list) and info["messages"]
    )


def _load_tree_helpers():
    """Load tree helpers from sibling logs.py, or use local fallbacks.

    Cloudbench copies this file as a raw script. A colliding `benchmarks`
    package on sys.path must not win, and a fixture that only copied
    hub_upload.py must still upload.
    """
    import importlib.util

    logs_path = Path(__file__).resolve().parent / "logs.py"
    if logs_path.is_file():
        spec = importlib.util.spec_from_file_location("_hub_upload_logs", logs_path)
        if spec is not None and spec.loader is not None:
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module.canonicalize_agent_tree, module.tree_child_transcript_count
    return _fallback_canonicalize_agent_tree, _fallback_tree_child_transcript_count


def prepare_run_bundle_for_upload(bundle: dict, *, live: bool = False, required: bool = False) -> dict:
    """Drop tool-usage-shaped logs.tree and refuse empty fan-out publishes.

    `logs.tree` must be `{agent_id: {parent_agent_id, goal, status, messages}}`.
    A `/api/tool-usage/tree` rollup in that slot makes Hub FE render every
    for_each child as "spinning up..." with message_count=0.
    """
    canonicalize_agent_tree, tree_child_transcript_count = _load_tree_helpers()

    body = dict(bundle)
    tasks = []
    for task in body.get("tasks") or []:
        if not isinstance(task, dict):
            tasks.append(task)
            continue
        task = dict(task)
        logs = dict(task.get("logs") or {})
        # The Hub renders messages/tree. Diagnostic process/event logs remain
        # in the unchanged local bundle and forensic archive; sending those
        # duplicated blobs with every task can exceed the decoded HTTP limit.
        for diagnostic in ("worker_logs", "backend_logs", "realtime_logs"):
            logs.pop(diagnostic, None)
        raw_tree = logs.get("tree")
        tree = canonicalize_agent_tree(raw_tree)
        if raw_tree and not tree:
            print("⚠️  stripped non-agent logs.tree (tool-usage rollup is not a fan-out transcript)")
        if tree:
            logs["tree"] = tree
        else:
            logs.pop("tree", None)
        task["logs"] = logs
        tree_agent_count = int(task.get("tree_agent_count") or 0)
        child_transcripts = tree_child_transcript_count(tree, task.get("agent_id"))
        if not live and tree_agent_count > 1 and child_transcripts == 0:
            message = (
                f"logs.tree for {task.get('name')} is missing child transcripts "
                f"(tree_agent_count={tree_agent_count}); refusing to publish empty fan-out chips"
            )
            if required:
                raise HubVisibilityError(message)
            print(f"⚠️  {message}")
        tasks.append(task)
    body["tasks"] = tasks
    return body


def _post_run_bundle(
    base: str,
    bundle: dict,
    *,
    timeout: float,
    live: bool,
    required: bool,
    label: str,
    verify_live_response: bool = False,
    max_attempts: int | None = None,
) -> bool:
    headers = _auth_headers(required=required)
    if headers is None:
        return False
    body = prepare_run_bundle_for_upload(bundle, live=live, required=required)
    body.setdefault("source", "manual-run")
    body = fit_bundle_to_upload_limit(body)
    payload = json.dumps(body, default=str).encode("utf-8")
    effective_timeout = upload_timeout_for_payload(len(payload), base_timeout=timeout)
    payload = gzip.compress(payload, mtime=0)
    headers = {**headers, "Content-Encoding": "gzip"}
    suffix = "?live=1" if live else ""
    request = urllib.request.Request(
        f"{base.rstrip('/')}/api/benchmarks/runs{suffix}",
        data=payload,
        headers=headers,
        method="POST",
    )
    opener = _hub_opener(base)
    max_attempts = max_attempts if max_attempts is not None else (4 if required else 1)
    if max_attempts < 1:
        raise ValueError("Hub upload attempts must be positive")
    for attempt in range(1, max_attempts + 1):
        try:
            with opener.open(request, timeout=effective_timeout) as response:
                ok = 200 <= response.status < 300
                if ok and verify_live_response:
                    stored = json.loads(response.read(1024 * 1024)).get("run") or {}
                    ok = live_response_matches(body, stored)
                if ok:
                    print(f"📤 uploaded run bundle to {label}: {body.get('run_id')}")
                return ok
        except Exception as exc:
            if isinstance(exc, urllib.error.HTTPError):
                try:
                    metadata = json.dumps(_safe_http_error_metadata(exc), sort_keys=True)
                    failure = f"HTTP Error {exc.code}; response_metadata={metadata}"
                finally:
                    exc.close()
            else:
                failure = str(exc)
            retryable = (
                exc.code in {408, 425, 429} or exc.code >= 500
                if isinstance(exc, urllib.error.HTTPError)
                else isinstance(exc, (urllib.error.URLError, TimeoutError, OSError))
            )
            recovered_visible_run = False
            run_id = str(body.get("run_id") or "")
            if required and live and retryable and run_id:
                try:
                    verify_run_visible(run_id, timeout=min(timeout, 5.0))
                    recovered_visible_run = True
                except HubVisibilityError:
                    pass
            if recovered_visible_run:
                print(
                    f"✅ benchmark Hub upload attempt {attempt} committed before "
                    "its response timed out; continuing from verified visibility"
                )
                return True
            if required and retryable and attempt < max_attempts:
                delay = min(2 ** (attempt - 1), 4)
                print(
                    f"⚠️  benchmark Hub upload attempt {attempt}/{max_attempts} "
                    f"failed transiently; retrying in {delay}s: {failure}"
                )
                time.sleep(delay)
                continue
            if required:
                raise HubVisibilityError(f"benchmark Hub upload failed: {failure}") from exc
            print(f"⚠️  hub upload failed (non-fatal): {failure}")
            return False
    raise AssertionError("unreachable")


def upload_run_bundle(
    bundle: dict,
    *,
    timeout: float = 30.0,
    live: bool = False,
    required: bool = False,
    verify_live_response: bool = False,
    max_attempts: int | None = None,
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
        verify_live_response=verify_live_response,
        max_attempts=max_attempts,
    )


def live_response_matches(bundle: dict, stored: dict) -> bool:
    """A terminal-to-live fenced no-op cannot acknowledge a new outcome."""

    def identity(task):
        passed = task.get("passed")
        status = "passed" if passed is True else "failed" if passed is False else task.get("status")
        return (
            task.get("name"),
            status,
            passed,
            task.get("agent_id"),
            task.get("lifecycle_stage"),
            task.get("startup_label"),
        )

    return (
        stored.get("live") is True
        and stored.get("run_id") == bundle.get("run_id")
        and [identity(t) for t in stored.get("tasks") or []] == [identity(t) for t in bundle["tasks"]]
    )


def live_bundle_from_report_card(card: dict, *, run_id: str, source: str) -> dict:
    """Project metadata from the same evaluated rows the fleet dashboard renders."""
    tasks = []
    for row in card.get("per_task") or []:
        status = row.get("status") or "running"
        agent_ids = parse_qs(urlparse(row.get("agent_url") or "").query).get("agent-id") or []
        cost = row.get("cost_usd")
        tasks.append(
            {
                "name": row["name"],
                "status": status,
                "passed": True if status == "passed" else False if status in ("failed", "error") else None,
                "agent_id": agent_ids[0] if agent_ids else None,
                "outcome_sha256": row.get("outcome_sha256"),
                "lifecycle_stage": row.get("lifecycle_stage"),
                "startup_label": (row.get("startup") or {}).get("label"),
                "duration_seconds": row.get("duration_s"),
                "cost_cents": round(cost * 100, 2) if isinstance(cost, (int, float)) else None,
                "world_model_mode": row.get("world_model_mode"),
                "fast_mode": bool(row.get("fast_mode")),
                "llm_call_count": row.get("llm_call_count"),
                "tree_agent_count": row.get("tree_agent_count"),
                "tokens_in": row.get("tokens_in"),
                "tokens_out": row.get("tokens_out"),
            }
        )
    return {
        "run_id": run_id,
        "timestamp": card.get("timestamp") or "",
        "source": source,
        "suite": "cloud-fleet",
        "tasks": tasks,
        "code": card.get("code"),
        "elapsed_s": card.get("elapsed_s"),
        "cost": card.get("cost"),
        "metadata": card.get("metadata"),
    }


def publish_live_report_card(card: dict, *, run_id: str, state_path: Path) -> bool:
    """Publish outcome changes immediately; coalesce ongoing cost/token refreshes."""
    bundle = live_bundle_from_report_card(card, run_id=run_id, source="direct-cloud-fleet")
    signature = [
        (
            task["name"],
            task["status"],
            task["agent_id"],
            task["outcome_sha256"],
            task["lifecycle_stage"],
            task["startup_label"],
        )
        for task in bundle["tasks"]
    ]
    now = time.time()
    try:
        previous = json.loads(state_path.read_text())
    except (OSError, ValueError):
        previous = {}
    if not isinstance(previous, dict):
        previous = {}
    epoch = previous.get("epoch", 0)
    if not isinstance(epoch, (int, float)):
        epoch = 0
    if previous.get("signature") == [list(row) for row in signature] and now - epoch < 15:
        return True
    began = time.monotonic()
    verified = upload_run_bundle(bundle, live=True, verify_live_response=True)
    # Only metadata: source-bound transport timing, without bodies, headers,
    # credentials, request IDs, or free-form provider errors.
    event = {
        "epoch": now,
        "elapsed_seconds": round(time.monotonic() - began, 3),
        "verified": verified,
        "task_counts": {
            status: sum(t["status"] == status for t in bundle["tasks"])
            for status in {t["status"] for t in bundle["tasks"]}
        },
    }
    try:
        with state_path.with_suffix(".events.jsonl").open("a") as stream:
            os.chmod(stream.name, 0o600)
            stream.write(json.dumps(event) + "\n")
    except OSError:
        pass
    if verified:
        temporary = state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"signature": signature, "epoch": now}))
        temporary.replace(state_path)
        return True
    return False


def mirror_run_bundle_to_durable_hub(
    bundle: dict,
    *,
    timeout: float = 30.0,
) -> bool:
    """Dual-write terminal bundles from ephemeral Hubs to the always-on Hub.

    Fail-closed launch registration still targets the local stack (so a prod
    outage cannot deadlock ``/deploy``). After the run finishes, mirror the
    final bundle to ``DEFAULT_HUB_URL`` whenever the configured Hub is
    localhost/127.0.0.1 — otherwise ``roselabs.ai/?agent-id=`` rot once the
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
        print("   (rehydrates from the in-app Benchmark Hub after the local stack is gone)")


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
    opener = _hub_opener(base)
    try:
        with opener.open(request, timeout=timeout) as response:
            payload = json.loads(response.read() or b"{}")
    except Exception as exc:
        raise HubVisibilityError(f"benchmark Hub visibility check failed: {exc}") from exc
    visible_id = ((payload.get("run") or {}).get("run_id")) if isinstance(payload, dict) else None
    if visible_id != run_id:
        raise HubVisibilityError(f"benchmark Hub returned the wrong run after registration: {visible_id!r}")
    print(f"✅ in-app Benchmark Hub registration verified: run={run_id}")


def require_run_visible(bundle: dict, *, timeout: float = 30.0) -> None:
    """Create a live Hub row and prove that the in-app read path can resolve it."""
    run_id = str(bundle.get("run_id") or "")
    if not run_id:
        raise HubVisibilityError("benchmark run_id is required for Hub registration")
    upload_run_bundle(bundle, timeout=timeout, live=True, required=True)
    verify_run_visible(run_id, timeout=timeout)


def register_starting_run(bundle: dict, *, timeout: float = 120.0) -> bool:
    """Attempt one early status write; transient delay does not abort work."""
    if not str(bundle.get("run_id") or ""):
        raise HubVisibilityError("benchmark run_id is required for Hub registration")
    try:
        return upload_run_bundle(bundle, timeout=timeout, live=True, required=True, max_attempts=1)
    except HubVisibilityError as error:
        cause = error.__cause__
        if isinstance(cause, urllib.error.HTTPError):
            retryable = cause.code in {408, 425, 429} or cause.code >= 500
        else:
            retryable = isinstance(cause, (urllib.error.URLError, TimeoutError, OSError))
        if not retryable:
            raise
        print("⚠️ initial Hub publication is pending; continuing with owned progress and terminal publication")
        return False


def _main() -> int:
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--require-visible", metavar="BUNDLE_JSON")
    action.add_argument("--register-starting", metavar="BUNDLE_JSON")
    action.add_argument("--upload-final", metavar="BUNDLE_JSON")
    action.add_argument("--upload-live", metavar="BUNDLE_JSON")
    action.add_argument("--verify-visible", metavar="RUN_ID")
    parser.add_argument("--run-id")
    parser.add_argument("--source", default="direct-benchmark")
    args = parser.parse_args()
    if args.verify_visible:
        verify_run_visible(args.verify_visible)
        return 0
    path = Path(args.require_visible or args.register_starting or args.upload_final or args.upload_live)
    bundle = json.loads(path.read_text())
    if args.run_id:
        bundle["run_id"] = args.run_id
    bundle.setdefault("source", args.source)
    if args.require_visible:
        require_run_visible(bundle)
    elif args.register_starting:
        register_starting_run(bundle)
    else:
        upload_run_bundle(bundle, live=bool(args.upload_live), required=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
