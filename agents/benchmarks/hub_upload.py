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
import contextlib
import fcntl
import functools
import gzip
import hashlib
import json
import os
import random
import re
import secrets
import signal
import sys
import tempfile
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


# ── Host-shared publication budget ─────────────────────────────────────────
# Every Hub write takes the backend's single cross-process catalog lock, whose
# cycle cost grows with the whole archive (a 21 MB catalog read-modify-write in
# October 2026), so the Hub admits only a few uploads per second in total. A
# campaign runs one live publisher per copy; without an aggregate budget, 600
# copies offered ~18 POST/s, the FIFO backlog outgrew every client timeout and
# the server spent its capacity on abandoned requests. The budget is shared by
# every publisher on this host (one sharded controller); a sharded operator
# divides its global budget between hosts through these variables.
LIVE_RATE_ENV = "BENCHMARK_HUB_LIVE_UPLOADS_PER_SECOND"
TERMINAL_SLOTS_ENV = "BENCHMARK_HUB_TERMINAL_CONCURRENCY"
TERMINAL_WINDOW_ENV = "BENCHMARK_HUB_TERMINAL_PUBLICATION_SECONDS"
BUDGET_FILE_ENV = "BENCHMARK_HUB_PUBLICATION_BUDGET_FILE"
DEFAULT_LIVE_UPLOADS_PER_SECOND = 1.0
DEFAULT_TERMINAL_CONCURRENCY = 2
DEFAULT_TERMINAL_WINDOW_SECONDS = 900.0
# Unchanged cost/token refreshes are the lowest-value live writes.
LIVE_REFRESH_SECONDS = 60.0
LIVE_BACKOFF_BASE_SECONDS = 15.0
LIVE_BACKOFF_CAP_SECONDS = 300.0
TERMINAL_BACKOFF_CAP_SECONDS = 60.0


def _positive_env(name: str, default: float, *, integer: bool = False) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw) if integer else float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a positive number") from exc
    if not value > 0 or value != value or value == float("inf"):
        raise ValueError(f"{name} must be a positive number")
    return value


def live_upload_rate() -> float:
    return _positive_env(LIVE_RATE_ENV, DEFAULT_LIVE_UPLOADS_PER_SECOND)


def _budget_path(base: str) -> Path:
    """One budget per Hub on this host: the capacity belongs to that Hub."""
    configured = os.environ.get(BUDGET_FILE_ENV, "").strip()
    if configured:
        return Path(configured)
    hub = hashlib.sha256(base.rstrip("/").encode()).hexdigest()[:16]
    return Path(tempfile.gettempdir()) / f"rose-benchmark-hub-publication-{os.getuid()}-{hub}.json"


def _process_birth(pid: int) -> str | None:
    """Native process birth so a recycled PID never keeps a stale slot."""
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        return f"proc-start:{boot}:{stat[stat.rfind(')') + 2:].split()[19]}"
    except OSError:
        pass
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass
    try:
        import subprocess

        started = subprocess.run(
            ["ps", "-p", str(pid), "-o", "lstart="], capture_output=True, text=True, timeout=5, check=False
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return " ".join(started.split()) or None


@contextlib.contextmanager
def _budget_state(base: str):
    """Exclusive read-modify-write of the host budget; refills live tokens."""
    path = _budget_path(base)
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_fd = os.open(f"{path}.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        try:
            state = json.loads(path.read_text())
        except (OSError, ValueError):
            state = {}
        if not isinstance(state, dict):
            state = {}
        rate = live_upload_rate()
        burst = max(2.0, min(30.0, rate * 20.0))
        now = time.time()
        tokens = state.get("tokens")
        at = state.get("at")
        if not isinstance(tokens, (int, float)) or not isinstance(at, (int, float)):
            tokens, at = burst, now
        tokens = max(-burst, min(burst, float(tokens) + max(0.0, now - float(at)) * rate))
        terminal = state.get("terminal") if isinstance(state.get("terminal"), dict) else {}
        terminal = {
            pid: entry
            for pid, entry in terminal.items()
            if isinstance(entry, dict) and str(pid).isdigit()
            and entry.get("birth") is not None and _process_birth(int(pid)) == entry.get("birth")
        }
        state = {"version": 1, "tokens": tokens, "at": now, "burst": burst, "terminal": terminal}
        yield state
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(state))
        os.chmod(temporary, 0o600)
        temporary.replace(path)
    finally:
        os.close(lock_fd)


def acquire_live_upload(*, priority: bool, base: str | None = None) -> bool:
    """Take one host live token without waiting.

    Outcome changes keep one reserved token; lower-value updates use only the
    surplus and yield to pending terminal publications on this host.
    """
    with _budget_state(base or _hub_url(required=True)) as state:
        if not priority and state["terminal"]:
            return False
        if state["tokens"] < (1.0 if priority else 2.0):
            return False
        state["tokens"] -= 1.0
        return True


def wait_for_live_upload(*, deadline: float) -> bool:
    while True:
        if acquire_live_upload(priority=True):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(min(2.0, max(0.05, deadline - time.monotonic())) * random.uniform(0.5, 1.0))


@contextlib.contextmanager
def terminal_publication_slot(*, deadline: float, base: str | None = None):
    """Bound host-wide in-flight terminal bundles; waiting preempts live writes.

    Terminal bundles are multi-megabyte and the Hub holds every queued body in
    memory until its catalog cycle, so concurrency, not only rate, is bounded.
    """
    slots = int(_positive_env(TERMINAL_SLOTS_ENV, DEFAULT_TERMINAL_CONCURRENCY, integer=True))
    base = base or _hub_url(required=True)
    pid = str(os.getpid())
    birth = _process_birth(os.getpid())
    if birth is None:
        raise HubVisibilityError("terminal Hub publication could not identify its own process")
    held = False
    try:
        while True:
            with _budget_state(base) as state:
                entry = state["terminal"].setdefault(pid, {"birth": birth, "since": time.time(), "holding": False})
                holding = sum(1 for value in state["terminal"].values() if value.get("holding"))
                if entry.get("holding") or holding < slots:
                    entry["holding"] = True
                    held = True
            if held:
                break
            if time.monotonic() >= deadline:
                raise HubVisibilityError("terminal Hub publication slot was not available within its window")
            time.sleep(random.uniform(0.5, 2.0))
        yield
    finally:
        with _budget_state(base) as state:
            state["terminal"].pop(pid, None)


def _retryable_upload_error(exc: BaseException) -> bool:
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code in {408, 425, 429} or exc.code >= 500
    return isinstance(exc, (urllib.error.URLError, TimeoutError, OSError))


def hub_run_id_for(run_id: str) -> str:
    """Bind a campaign member's Hub identity to its exact group membership.

    Fleet run IDs are ``<local time>-<pid>``. Disposable sharded controllers
    boot identically, so concurrent copies on different hosts can share a PID
    and second; their Hub records then collide and one member is rejected as a
    membership change. Standalone runs keep their historical identity.
    """
    if not re.fullmatch(r"[A-Za-z0-9._-]+", run_id or ""):
        raise ValueError("invalid benchmark run identity")
    group = os.environ.get("BENCHMARK_HUB_GROUP_RUN_ID", "").strip()
    if not group:
        return run_id
    member = os.environ.get("RUN_BENCH_CAMPAIGN_JOB_ID", "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", group) or not re.fullmatch(r"[A-Za-z0-9._-]+", member):
        raise ValueError("benchmark Hub group member identity is required")
    attempt = os.environ.get("RUN_BENCH_CAMPAIGN_ATTEMPT", "1").strip() or "1"
    digest = hashlib.sha256("\0".join((group, member, attempt, run_id)).encode()).hexdigest()[:12]
    return f"{run_id}-m{digest}"


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



def project_archived_diagnostics(bundle: dict, reference: dict, *, verify_archive) -> dict:
    """Project duplicated native diagnostics only after full archive verification.

    The verifier owns authenticated decryption/readback, not an upload ACK.
    Its returned manifest must match the public reference digest exactly.
    """
    receipt, manifest, verified_bindings = verify_archive(reference)
    if receipt.get("full_readback_verified") is not True:
        raise HubVisibilityError("Full forensic archive readback is required")
    for key in ("bucket", "key", "encryption_key_id", "ciphertext_sha256", "manifest_sha256"):
        if reference.get(key) != receipt.get(key):
            raise HubVisibilityError("Forensic archive identity differs")
    digest = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    if digest != receipt.get("manifest_sha256") or len(manifest) != receipt.get("files"):
        raise HubVisibilityError("Forensic archive manifest differs")
    members = {row["path"]: row for row in manifest}
    canonical = reference.get("canonical", {})
    if members.get(canonical.get("path")) != canonical:
        raise HubVisibilityError("Original canonical member is missing or differs")
    if verified_bindings.get("canonical") != canonical or verified_bindings.get("run_id") != bundle.get("run_id"):
        raise HubVisibilityError("Authenticated canonical run binding differs")
    if verified_bindings.get("bundle_sha256") != hashlib.sha256(
        json.dumps(bundle, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest():
        raise HubVisibilityError("Authenticated canonical bundle content differs")
    body = dict(bundle)
    tasks = []
    for original in bundle.get("tasks", []):
        task = dict(original)
        logs = dict(task.get("logs") or {})
        if "wmh_retirement" in logs:
            binding = reference.get("retirements", {}).get(task.get("agent_id"), {})
            if verified_bindings.get("retirements", {}).get(task.get("agent_id")) != binding:
                raise HubVisibilityError("Authenticated retirement binding differs")
            if binding.get("run_id") != bundle.get("run_id"):
                raise HubVisibilityError("Forensic retirement root/run differs")
            member = binding.get("member", {})
            if members.get(member.get("path")) != member:
                raise HubVisibilityError("Original native retirement member differs")
            if binding.get("diagnostic_sha256") != hashlib.sha256(
                json.dumps(logs["wmh_retirement"], sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest():
                raise HubVisibilityError("Forensic diagnostic projection differs")
            logs.pop("wmh_retirement")
            logs["forensic_archive_ref"] = {
                key: reference[key] for key in (
                    "bucket", "key", "encryption_key_id", "ciphertext_sha256", "manifest_sha256"
                )
            }
            logs["forensic_archive_ref"].update(
                canonical=canonical, native_retirement=member,
                diagnostic_sha256=binding["diagnostic_sha256"],
                run_id=bundle.get("run_id"), root_agent_id=task.get("agent_id"),
            )
        task["logs"] = logs
        tasks.append(task)
    body["tasks"] = tasks
    return body


def _project_hub_log_owner(task: dict, *, live: bool, required: bool) -> dict:
    """Use the same lossless view projection for task and owned-stage logs."""
    canonicalize_agent_tree, tree_child_transcript_count = _load_tree_helpers()
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
    child_transcripts = tree_child_transcript_count(tree, task.get("agent_id") or task.get("root_agent_id"))
    if not live and tree_agent_count > 1 and child_transcripts == 0:
        message = (
            f"logs.tree for {task.get('name')} is missing child transcripts "
            f"(tree_agent_count={tree_agent_count}); refusing to publish empty fan-out chips"
        )
        if required:
            raise HubVisibilityError(message)
        print(f"⚠️  {message}")
    return task


def prepare_run_bundle_for_upload(bundle: dict, *, live: bool = False, required: bool = False) -> dict:
    """Project all log owners without changing local custody or transcripts."""
    body = dict(bundle)
    tasks = []
    for task in body.get("tasks") or []:
        if not isinstance(task, dict):
            tasks.append(task)
            continue
        task = _project_hub_log_owner(task, live=live, required=required)
        if isinstance(task.get("owned_roots"), list):
            task["owned_roots"] = [
                _project_hub_log_owner(record, live=live, required=required)
                if isinstance(record, dict) else record
                for record in task["owned_roots"]
            ]
        tasks.append(task)
    body["tasks"] = tasks
    return body


def _with_run_group(bundle: dict) -> dict:
    """Campaign membership never transfers a child's publication authority."""
    group = os.environ.get("BENCHMARK_HUB_GROUP_RUN_ID", "").strip()
    if not group:
        return bundle
    if not re.fullmatch(r"[A-Za-z0-9._-]+", group) or group == str(bundle.get("run_id") or ""):
        raise ValueError("invalid benchmark Hub group identity")
    member = os.environ.get("RUN_BENCH_CAMPAIGN_JOB_ID", "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", member):
        raise ValueError("benchmark Hub group member identity is required")
    existing = bundle.get("group_run_id")
    if existing is not None and existing != group:
        raise ValueError("benchmark Hub group identity changed")
    fields = {
        **bundle,
        "group_run_id": group,
        "group_member_id": member,
        "group_run_number": int(os.environ.get("RUN_BENCH_CAMPAIGN_RUN", "1")),
        "group_timestamp": os.environ.get("RUN_BENCH_CAMPAIGN_STARTED_AT", ""),
        "group_total": int(os.environ.get("RUN_BENCH_CAMPAIGN_TOTAL_JOBS", "0")),
    }
    attempt = os.environ.get("RUN_BENCH_CAMPAIGN_ATTEMPT")
    if attempt is not None:
        attempt_number = int(attempt)
        if attempt_number < 1:
            raise ValueError("benchmark Hub attempt must be positive")
        if bundle.get("group_attempt") not in (None, attempt_number):
            raise ValueError("benchmark Hub attempt identity changed")
        fields["group_attempt"] = attempt_number
    return fields


@functools.lru_cache(maxsize=1)
def _upload_source_sha256() -> str | None:
    """Identify these deployed uploader bytes without changing upload results."""
    try:
        return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    except OSError:
        return None


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
    attempt_events: list[dict] | None = None,
    deadline: float | None = None,
) -> bool:
    preparation_began = time.monotonic()
    headers = _auth_headers(required=required)
    if headers is None:
        return False
    body = prepare_run_bundle_for_upload(_with_run_group(bundle), live=live, required=required)
    body.setdefault("source", "manual-run")
    body = fit_bundle_to_upload_limit(body)
    payload = json.dumps(body, default=str).encode("utf-8")
    payload_bytes = len(payload)
    effective_timeout = upload_timeout_for_payload(payload_bytes, base_timeout=timeout)
    payload = gzip.compress(payload, mtime=0)
    preparation_seconds = time.monotonic() - preparation_began
    headers = {**headers, "Content-Encoding": "gzip"}
    suffix = "?live=1" if live else ""
    opener = _hub_opener(base)
    max_attempts = max_attempts if max_attempts is not None else (4 if required else 1)
    if max_attempts < 1:
        raise ValueError("Hub upload attempts must be positive")
    if deadline is not None and not required:
        raise ValueError("a patient Hub publication window is only for required uploads")
    attempt = 0
    while True:
        attempt += 1
        attempt_timeout = effective_timeout
        if deadline is not None:
            # The window bounds every attempt; a replay never extends it.
            attempt_timeout = min(effective_timeout, max(1.0, deadline - time.monotonic()))
        request_id = secrets.token_hex(6)
        request = urllib.request.Request(
            f"{base.rstrip('/')}/api/benchmarks/runs{suffix}",
            data=payload,
            headers={**headers, "X-Request-Id": request_id},
            method="POST",
        )
        attempt_began = time.monotonic()
        phase = "open"
        status = None
        response_id_matches = None
        open_seconds = None
        read_seconds = None
        error_class = None
        try:
            try:
                with opener.open(request, timeout=attempt_timeout) as response:
                    open_seconds = time.monotonic() - attempt_began
                    phase = "response"
                    status = response.status
                    response_headers = getattr(response, "headers", None)
                    echo = response_headers.get("X-Request-Id", "") if response_headers is not None else ""
                    if isinstance(echo, str) and re.fullmatch(r"[0-9a-f]{12}", echo):
                        response_id_matches = echo == request_id
                    ok = 200 <= response.status < 300
                    if ok and verify_live_response:
                        phase = "read"
                        read_began = time.monotonic()
                        stored = json.loads(response.read(1024 * 1024)).get("run") or {}
                        read_seconds = time.monotonic() - read_began
                        phase = "verify"
                        ok = live_response_matches(body, stored)
                    if ok:
                        phase = "complete"
                        print(f"📤 uploaded run bundle to {label}: {body.get('run_id')}")
                    return ok
            except Exception as exc:
                if phase == "read":
                    read_seconds = time.monotonic() - read_began
                if isinstance(exc, urllib.error.HTTPError):
                    status = exc.code
                error_class = next((name for kind, name in (
                    (urllib.error.HTTPError, "HTTPError"),
                    (urllib.error.URLError, "URLError"),
                    (TimeoutError, "TimeoutError"),
                    (OSError, "OSError"),
                    (ValueError, "ValueError"),
                ) if isinstance(exc, kind)), "Other")
                raise
            finally:
                if attempt_events is not None:
                    attempt_events.append({
                        "request_id": request_id,
                        "attempt": attempt,
                        "source_sha256": _upload_source_sha256(),
                        "payload_bytes": payload_bytes,
                        "compressed_bytes": len(payload),
                        "effective_timeout": effective_timeout,
                        "preparation_seconds": preparation_seconds,
                        "attempt_seconds": time.monotonic() - attempt_began,
                        "open_seconds": open_seconds,
                        "read_seconds": read_seconds,
                        "phase": phase,
                        "status": status,
                        "response_id_matches": response_id_matches,
                        "error_class": error_class,
                    })
        except Exception as exc:
            if isinstance(exc, urllib.error.HTTPError):
                try:
                    metadata = json.dumps(_safe_http_error_metadata(exc), sort_keys=True)
                    failure = f"HTTP Error {exc.code}; response_metadata={metadata}"
                finally:
                    exc.close()
            else:
                failure = str(exc)
            retryable = _retryable_upload_error(exc)
            run_id = str(body.get("run_id") or "")
            if required and retryable:
                if deadline is None:
                    delay = min(2 ** (attempt - 1), 4)
                    more = attempt < max_attempts
                    readback_timeout = min(timeout, 5.0)
                    label_attempt = f"{attempt}/{max_attempts}"
                else:
                    # Exponential, jittered and bounded by the remaining window:
                    # a backlog drains only when its clients stop replaying.
                    remaining = deadline - time.monotonic()
                    delay = min(remaining, 2 ** min(attempt, 6) * random.uniform(0.5, 1.0),
                                TERMINAL_BACKOFF_CAP_SECONDS)
                    delay = max(0.0, delay)
                    readback_timeout = max(1.0, min(30.0, remaining - delay))
                    more = remaining - delay > 1.0
                    label_attempt = f"{attempt} (window {max(0, int(remaining))}s left)"
                if more:
                    print(
                        f"⚠️  benchmark Hub upload attempt {label_attempt} "
                        f"failed transiently; retrying in {delay:.0f}s: {failure}"
                    )
                # The Hub keeps processing a request after its client gives
                # up. Reconcile the exact read identity before replaying the
                # mutation or declaring it failed.
                time.sleep(delay)
                if run_id and _upload_committed(
                    base, body, live=live, timeout=readback_timeout,
                    verify_live_response=verify_live_response,
                ):
                    record = "visibility" if live else "final record"
                    print(
                        f"✅ benchmark Hub upload attempt {attempt} committed before "
                        f"its response failed; continuing from the verified {record}"
                    )
                    return True
                if more and (deadline is None or time.monotonic() < deadline - 1.0):
                    continue
            if required:
                raise HubVisibilityError(f"benchmark Hub upload failed: {failure}") from exc
            print(f"⚠️  hub upload failed (non-fatal): {failure}")
            return False


def upload_run_bundle(
    bundle: dict,
    *,
    timeout: float = 30.0,
    live: bool = False,
    required: bool = False,
    verify_live_response: bool = False,
    max_attempts: int | None = None,
    attempt_events: list[dict] | None = None,
    deadline: float | None = None,
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
        attempt_events=attempt_events,
        deadline=deadline,
    )


def publish_terminal_run_bundle(bundle: dict, *, live: bool = False) -> bool:
    """Patient, host-bounded terminal publication after resource release.

    One slot per bounded host concurrency carries the bundle; while waiting or
    holding it, this copy preempts lower-value live writes. Ambiguous failures
    are reconciled through the exact read-back before an identical replay,
    which the Hub coalesces with any still-queued copy of the same packet.
    """
    window = _positive_env(TERMINAL_WINDOW_ENV, DEFAULT_TERMINAL_WINDOW_SECONDS)
    deadline = time.monotonic() + window
    with terminal_publication_slot(deadline=deadline):
        return upload_run_bundle(bundle, live=live, required=True, deadline=deadline)


def _run_record_identity_matches(bundle: dict, stored: dict) -> bool:
    """Compare published run/campaign identity with JSON type distinctions."""
    fields = (
        "run_id", "timestamp", "suite", "source", "group_run_id", "group_member_id",
        "group_run_number", "group_timestamp", "group_total", "group_attempt",
    )
    return all(
        json.dumps(stored.get(key), sort_keys=True) == json.dumps(bundle.get(key), sort_keys=True)
        for key in fields
    )


def live_response_matches(bundle: dict, stored: dict) -> bool:
    """A terminal-to-live fenced no-op cannot acknowledge a new outcome."""

    def identity(task):
        passed = task.get("passed")
        status = "passed" if passed is True else "failed" if passed is False else task.get("status")
        # Tuple equality in Python would accept numeric 1 as boolean True.
        return json.dumps((
            task.get("name"), status, passed, task.get("agent_id"),
            task.get("lifecycle_stage"), task.get("startup_label"),
        ), sort_keys=True)

    return (
        stored.get("live") is True
        and _run_record_identity_matches(bundle, stored)
        and [identity(t) for t in stored.get("tasks") or []] == [identity(t) for t in bundle["tasks"]]
    )


def final_record_matches(bundle: dict, stored: dict) -> bool:
    """A terminal upload is committed only when the Hub reads back its exact final outcome."""

    def projected(task: dict) -> tuple:
        # Mirrors taskSummary in back-end/src/providers/benchmarkHubRunProjection.ts.
        status = task.get("status")
        infrastructure = task.get("passed") is not True and status in ("INFRA_ERROR", "error")
        passed = task.get("passed") if not infrastructure and isinstance(task.get("passed"), bool) else None
        if passed is not None:
            status = "passed" if passed else "failed"
        elif not (isinstance(status, str) and status):
            status = "running"
        agent_id = task.get("agent_id").strip() if isinstance(task.get("agent_id"), str) else ""
        labels = tuple(
            task.get(key) if isinstance(task.get(key), str) else None
            for key in ("lifecycle_stage", "startup_label", "failure_reason")
        )
        return (str(task.get("name") or ""), passed, status, agent_id or None, *labels)

    expected = [projected(task) for task in bundle.get("tasks") or [] if isinstance(task, dict)]
    actual = [projected(task) for task in stored.get("tasks") or [] if isinstance(task, dict)]
    return (
        stored.get("live") is False
        and _run_record_identity_matches(bundle, stored)
        and actual == expected
    )


def _upload_committed(
    base: str, body: dict, *, live: bool, timeout: float, verify_live_response: bool = False,
) -> bool:
    """Read back an ambiguously failed upload from the Hub it was sent to."""
    run_id = str(body.get("run_id") or "")
    try:
        if live:
            if verify_live_response:
                return live_response_matches(body, _read_hub_run(run_id, timeout=timeout, base=base))
            verify_run_visible(run_id, timeout=timeout, base=base)
            return True
        return final_record_matches(body, _read_hub_run(run_id, timeout=timeout, base=base))
    except HubVisibilityError:
        return False


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
    published = previous.get("signature")
    current = [list(row) for row in signature]
    unchanged = published == current
    if unchanged and now - epoch < LIVE_REFRESH_SECONDS:
        return True
    # The retry schedule lives beside, never inside, the verified projection.
    backoff_path = state_path.with_suffix(".backoff.json")
    try:
        backoff = json.loads(backoff_path.read_text())
    except (OSError, ValueError):
        backoff = {}
    if not isinstance(backoff, dict):
        backoff = {}
    retry_at = backoff.get("retry_at", 0)
    if isinstance(retry_at, (int, float)) and now < retry_at:
        # A failed or timed-out write backs off instead of retrying every tick.
        return False
    # Status, agent and evaluated-outcome changes outrank startup labels,
    # lifecycle stages and unchanged cost/token refreshes.
    previous_rows = {row[0]: row[1:4] for row in published or [] if isinstance(row, list) and len(row) >= 4}
    priority = any(previous_rows.get(row[0]) != list(row[1:4]) for row in current)
    base = _hub_url(required=False)
    if base and not acquire_live_upload(priority=priority, base=base):
        return False
    began = time.monotonic()
    attempts: list[dict] = []
    verified = upload_run_bundle(bundle, live=True, verify_live_response=True, attempt_events=attempts)
    # Only metadata: source-bound transport timing, without bodies, headers,
    # credentials or free-form provider errors. IDs are random safe correlation only.
    event = {
        "epoch": now,
        "elapsed_seconds": round(time.monotonic() - began, 3),
        "verified": verified,
        "attempts": attempts,
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
        backoff_path.unlink(missing_ok=True)
        return True
    # Only an overloaded or unreachable Hub backs off. A delivered response
    # that does not match (a fenced terminal no-op) retries on the next tick.
    overloaded = any(
        attempt.get("error_class") in {"TimeoutError", "URLError", "OSError"}
        or (attempt.get("error_class") == "HTTPError"
            and (attempt.get("status") in {408, 425, 429} or (attempt.get("status") or 0) >= 500))
        for attempt in attempts
    )
    if not overloaded:
        return False
    failures = backoff.get("failures", 0)
    failures = (failures if type(failures) is int and failures >= 0 else 0) + 1
    delay = min(LIVE_BACKOFF_CAP_SECONDS, LIVE_BACKOFF_BASE_SECONDS * 2 ** (failures - 1))
    temporary = backoff_path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"failures": failures,
                                     "retry_at": time.time() + delay * random.uniform(0.5, 1.5)}))
    temporary.replace(backoff_path)
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


def _read_hub_run(run_id: str, *, timeout: float, base: str | None = None) -> dict:
    """Read one exact run through the in-app read path."""
    if not run_id:
        raise HubVisibilityError("benchmark run_id is required for Hub registration")
    base = (base or _hub_url(required=True)).rstrip("/")
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
    run = payload.get("run") if isinstance(payload, dict) else None
    return run if isinstance(run, dict) else {}


def verify_run_visible(run_id: str, *, timeout: float = 30.0, base: str | None = None) -> None:
    """Prove that the in-app read path resolves an exact run identifier."""
    visible_id = _read_hub_run(run_id, timeout=timeout, base=base).get("run_id")
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
    # Startup never waits on the host budget. Without a token the write stays
    # pending: the first budgeted live publication upserts the same run.
    if not acquire_live_upload(priority=True):
        print("⚠️ initial Hub publication is pending behind the host publication budget; "
              "continuing with owned progress and terminal publication")
        return False
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
    action.add_argument("--print-run-id", metavar="RUN_ID")
    parser.add_argument("--run-id")
    parser.add_argument("--source", default="direct-benchmark")
    parser.add_argument("--follow-record-on-cancel", action="store_true")
    parser.add_argument("--publication-ack", type=Path)
    parser.add_argument("--publication-token")
    args = parser.parse_args()
    if args.publication_ack and not (args.follow_record_on_cancel and args.publication_token):
        parser.error("publication acknowledgement requires its campaign owner")
    if args.verify_visible:
        verify_run_visible(args.verify_visible)
        return 0
    if args.print_run_id:
        print(hub_run_id_for(args.print_run_id))
        return 0
    path = Path(args.require_visible or args.register_starting or args.upload_final or args.upload_live)
    cancelled = False

    def cancellation(_signal, _frame):
        nonlocal cancelled
        cancelled = True

    previous_handlers = {}
    if args.follow_record_on_cancel:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[signum] = signal.signal(signum, cancellation)
    bundle = json.loads(path.read_text())
    if args.run_id:
        bundle["run_id"] = args.run_id
    bundle.setdefault("source", args.source)
    published = False
    try:
        try:
            if args.require_visible:
                require_run_visible(bundle)
                published = True
            elif args.register_starting:
                published = register_starting_run(bundle)
            elif args.upload_final:
                published = publish_terminal_run_bundle(bundle)
            else:
                # Every caller treats this pre-release refresh as best effort;
                # the terminal publication after release carries the outcome.
                if not wait_for_live_upload(deadline=time.monotonic() + 15):
                    print("⚠️ live Hub update deferred behind the host publication budget")
                    return 1
                published = upload_run_bundle(bundle, live=True, required=True)
        except HubVisibilityError:
            if not cancelled:
                raise
        if cancelled:
            # Finish the in-flight request before correcting its projection;
            # this same publisher remains owned by the campaign's native drain.
            terminal = json.loads(path.read_text())
            if (
                terminal.get("run_id") != bundle.get("run_id")
                or terminal.get("timestamp") != bundle.get("timestamp")
                or (terminal.get("run_group") or {}).get("status") != "cancelled"
            ):
                raise HubVisibilityError("cancelled campaign publication changed its identity or terminal status")
            published = upload_run_bundle(terminal, required=True)
            bundle = terminal
        if args.publication_ack:
            if not published:
                raise HubVisibilityError("campaign publication was not acknowledged")
            acknowledgement = {
                "pid": os.getpid(),
                "token": args.publication_token,
                "record_sha256": hashlib.sha256(json.dumps(bundle, sort_keys=True).encode()).hexdigest(),
            }
            temporary = args.publication_ack.with_name(f".{args.publication_ack.name}.{os.getpid()}")
            temporary.write_text(json.dumps(acknowledgement) + "\n")
            temporary.chmod(0o600)
            temporary.replace(args.publication_ack)
    finally:
        for signum, previous in previous_handlers.items():
            signal.signal(signum, previous)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
