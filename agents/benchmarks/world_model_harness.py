"""World Model Harness integration helpers for archived Rose trajectories.

The archive writer owns durability and encryption. This module is the read-side
bridge from a trace bundle to WMH's OpenTelemetry GenAI ingestion format:

  archive bundle -> canonical Rose transitions -> OTel GenAI JSONL -> WMH ingest/build

It deliberately keeps WMH-specific data in standard `gen_ai.*` attributes plus
WMH's documented `wmh.state.*`/`wmh.trace.metadata` enrichments so upstream
`world-model-harness` can ingest the output without a Rose-specific fork.
"""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import heapq
import json
import multiprocessing
import os
import re
import sys
import time
from collections import deque
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, Iterator, Optional

import httpx

from helpers.context_scope import is_internal_subagent_message
from helpers.trace_archive import (
    archive_backend_is_r2,
    decrypt_and_validate_artifact,
    list_r2_artifact_entries,
    local_archive_root,
    read_archive_artifact,
    read_archive_artifact_metadata,
)
from helpers.trace_archive import (
    list_archive_artifact_paths as list_backend_archive_artifact_paths,
)
from helpers.trace_archive import (
    list_archive_bundle_ids as list_backend_archive_bundle_ids,
)
from utils.world_model_observation import normalize_world_model_observation

_REPO_ROOT = Path(__file__).resolve().parents[2]
_LOCAL_ARCHIVE_ROOT = _REPO_ROOT / ".context" / "trace-archive"
_WMH_REFERENCE_ROOT = _REPO_ROOT / ".context" / "reference" / "world-model-harness"
_DEFAULT_WMH_BUILD_ROOT = _REPO_ROOT / ".context" / "world-model"
_BENCHMARK_TASKS_FILE = Path(__file__).with_name("tasks.json")
# Increment whenever cached per-bundle OTel/session output changes independently of archive bytes.
_WMH_EXPORT_SCHEMA_VERSION = 12

_SECRET_KEY_RE = re.compile(
    r"(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|"
    r"compute_token_used|claude_token_error|gpt_token_error)",
    re.IGNORECASE,
)
_SECRET_VALUE_RE = re.compile(
    r"(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+|"
    r"[A-Za-z0-9+/]{32,}={0,2})"
)
_HIGH_CONFIDENCE_SECRET_VALUE_RE = re.compile(r"(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)")


JsonObject = dict[str, Any]
ProgressCallback = Callable[[JsonObject], None]
_FIDELITY_DIMENSIONS = (
    "schema_validity",
    "content_accuracy",
    "state_transition_correctness",
    "error_behavior",
    "artifact_refs",
)
_EXPLORE_ORCHESTRATION_TOOLS = {"spawn_explore_agent", "explore"}
_FOR_EACH_ORCHESTRATION_TOOLS = {"spawn_general_purpose_agent_for_each", "for_each"}
_BROWSER_ORCHESTRATION_TOOLS = {"spawn_browser_agent", "spawn_browser_agent_activity_v3", "browser"}
_BROWSER_BOUNDARY_TOOLS = {"browser_action", "browser_click", "browser_type", "browser_http"}
_BROWSER_TOOLS = _BROWSER_ORCHESTRATION_TOOLS | _BROWSER_BOUNDARY_TOOLS
_CODE_TOOLS = {
    "spawn_code_agent",
    "spawn_claude_code_agent",
    "spawn_codex_code_agent",
    "claude_code",
    "codex_code",
}
_MESSAGE_TOOLS = {"message_person", "send_message_to_user", "send_sms", "send_direct_sms", "notify_sms_event"}
_PAYMENT_TOOLS = {"request_payment_card", "payment_lookup", "payment_mint", "x402", "purchase", "purchase_item"}
_VAPI_ORCHESTRATION_TOOLS = {"call_phone_number", "vapi"}
_VAPI_BOUNDARY_TOOLS = {"vapi_create_call", "vapi_poll_call", "vapi_recording_fetch"}
_VAPI_TOOLS = _VAPI_ORCHESTRATION_TOOLS | _VAPI_BOUNDARY_TOOLS
_GREP_TOOLS = {"grep", "web_search", "web_fetch", "web_fetch_download", "people_search"}
_DEMO_CACHE_TOOLS = {"fast_cache_read", "fast_cache_write"}
# DEMO cache is intentionally NOT an environment boundary: simulated runs keep
# the real cache active (WMH steps are expensive) and are isolated from real-run
# entries by the world-model scope segment in every cache key
# (demo_cache/normalize.py:world_model_cache_scope).
_ENVIRONMENT_BOUNDARY_TOOLS = (
    _EXPLORE_ORCHESTRATION_TOOLS
    | _CODE_TOOLS
    | _BROWSER_ORCHESTRATION_TOOLS
    | _BROWSER_BOUNDARY_TOOLS
    | _VAPI_ORCHESTRATION_TOOLS
    | _VAPI_BOUNDARY_TOOLS
    | {
        "web_search",
        "web_fetch",
        "web_fetch_download",
        "people_search",
        "send_direct_sms",
        "notify_sms_event",
        "payment_lookup",
        "payment_mint",
        "provider_request",
        "provider_response",
        "search_provider_request",
        "search_provider_response",
        "fetch_provider_request",
        "fetch_provider_response",
        "message_transport_send",
        "payment_provider_request",
        "payment_provider_response",
    }
)
_BROWSER_OBSERVATION_PATH_RE = re.compile(
    r"^media/browser/(?P<task_id>[^/]+)/observations/iteration_(?P<iteration>\d+)\.json$"
)
_BROWSER_NON_ACTION_EVENTS = {
    "auth_assistance",
    "browser",
    "credential_propagation",
    "diagnostics",
    "error",
    "network_recording",
    "recording",
    "request_user_assistance_for_authentication",
    "session_paused",
    "supervisor_recovery",
    "system",
    "task_complete",
    "task_started",
    "write_lock_rejected",
}
_TERMINAL_TOOL_STATUSES = {"FINISHED", "ERROR"}
# DB Message contains both agent actions and UI/workflow lifecycle rows. These
# names are produced by workflow plumbing rather than an assistant/DAG action,
# so treating them as environment transitions teaches the WMH to answer real
# tool calls with progress-card copy such as "Agent initialization complete."
_MESSAGE_FIXTURE_UI_ONLY_TOOLS = {
    "agent_init",
    "browser_session_auth",
    "cloud_agent",
    "completion_summary",
    "credential_failure_classifier",
}
_MESSAGE_FIXTURE_START_ACKS = {
    "browser agent started",
    "code agent started",
    "explore agent thinking",
    "research started",
    "task started",
}
_MESSAGE_FIXTURE_START_ACTION_TYPES = {
    "browser",
    "claude_code_started",
    "codex_code_started",
    "task_started",
}


@dataclass
class CanonicalAction:
    """Rose action schema carried inside WMH's generic tool_call Action."""

    category: str
    name: str
    arguments: JsonObject = field(default_factory=dict)
    agent_id: Optional[str] = None
    span_id: Optional[str] = None
    tool_call_id: Optional[str] = None
    artifact_refs: list[str] = field(default_factory=list)
    timestamp_ms: Optional[int] = None

    def to_wmh_tool_name(self) -> str:
        return f"rose.{self.category}.{self.name}".replace(" ", "_")

    def to_arguments(self) -> JsonObject:
        payload: JsonObject = {
            "schema": "rose.canonical_action.v1",
            "category": self.category,
            "name": self.name,
            "arguments": self.arguments,
        }
        if self.agent_id:
            payload["agent_id"] = self.agent_id
        if self.span_id:
            payload["span_id"] = self.span_id
        if self.tool_call_id:
            payload["tool_call_id"] = self.tool_call_id
        if self.artifact_refs:
            payload["artifact_refs"] = self.artifact_refs
        if self.timestamp_ms is not None:
            payload["timestamp_ms"] = self.timestamp_ms
        return payload


@dataclass
class CanonicalObservation:
    """Rose observation schema carried in WMH Observation.content/metadata."""

    category: str
    content: str
    is_error: bool = False
    metadata: JsonObject = field(default_factory=dict)
    artifact_refs: list[str] = field(default_factory=list)
    timestamp_ms: Optional[int] = None
    # Real measured start of the tool call whose completion is ``timestamp_ms``.
    # Kept out of the observation text: it is grounding evidence, not output.
    started_at_ms: Optional[int] = None

    @property
    def elapsed_ms(self) -> Optional[int]:
        """Measured time-to-complete (completion minus start), when both real clocks exist."""

        if self.started_at_ms is None or self.timestamp_ms is None or self.timestamp_ms < self.started_at_ms:
            return None
        return self.timestamp_ms - self.started_at_ms

    def to_output_text(self) -> str:
        payload: JsonObject = {
            "schema": "rose.canonical_observation.v1",
            "category": self.category,
            "content": self.content,
            "is_error": self.is_error,
            "metadata": self.metadata,
        }
        if self.artifact_refs:
            payload["artifact_refs"] = self.artifact_refs
        if self.timestamp_ms is not None:
            payload["timestamp_ms"] = self.timestamp_ms
        return json.dumps(payload, ensure_ascii=False, sort_keys=True)


@dataclass
class RoseTransition:
    """One `(state_before, action) -> observation` transition."""

    state_before: JsonObject
    scratchpad: str
    action: CanonicalAction
    observation: CanonicalObservation
    raw_span_ids: list[str] = field(default_factory=list)


ToolExecutor = Callable[[str, JsonObject, str], Awaitable[JsonObject]]


@dataclass
class FidelityStepScore:
    trace_id: str
    step_index: int
    action: str
    score: float
    dimensions: dict[str, float]
    actual: str
    predicted: str
    critique: str = ""

    def to_dict(self) -> JsonObject:
        return {
            "trace_id": self.trace_id,
            "step_index": self.step_index,
            "action": self.action,
            "score": self.score,
            "dimensions": self.dimensions,
            "actual": self.actual,
            "predicted": self.predicted,
            "critique": self.critique,
        }


def wmh_reference_available() -> bool:
    return (_WMH_REFERENCE_ROOT / "wmh" / "ingest" / "otel_genai.py").exists()


def list_archive_bundle_ids(root: Path | None = None) -> list[str]:
    if root is None:
        return list_backend_archive_bundle_ids()
    archive_root = root
    if not archive_root.exists():
        return []
    return sorted(p.name for p in archive_root.iterdir() if p.is_dir())


_archive_json_memo: contextvars.ContextVar[dict[tuple[str, ...], JsonObject] | None] = contextvars.ContextVar(
    "wmh_archive_json_memo", default=None
)


@contextmanager
def archive_json_memo() -> Iterator[None]:
    """Memoize read_archive_json for the duration of one bundle export.

    Exporting a bundle reads its start fixture three times and its end fixture
    twice (OTel transitions, replay-session transitions, initial state); the
    fixtures are tens of MB of ciphertext each, so the repeat downloads and
    decrypts dominated export time. Scoped to the calling context (one export
    worker) so memory is bounded by the in-flight bundles.
    """
    token = _archive_json_memo.set({})
    try:
        yield
    finally:
        _archive_json_memo.reset(token)


def read_archive_json(root_agent_id: str, path: str) -> JsonObject:
    memo = _archive_json_memo.get()
    if memo is not None and (root_agent_id, path) in memo:
        return memo[(root_agent_id, path)]
    stored = read_archive_artifact(root_agent_id=root_agent_id, path=path)
    if stored is None:
        raise FileNotFoundError(f"archive artifact not found: {root_agent_id}/{path}")
    plaintext = decrypt_and_validate_artifact(*stored)
    value = json.loads(plaintext.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"archive artifact {path} is not a JSON object")
    if memo is not None:
        memo[(root_agent_id, path)] = value
    return value


# Shadow runs execute real provider calls, so their observations are real signal.
_REAL_WORLD_MODEL_MODES = {"real", "shadow"}


def bundle_world_model_mode(root_agent_id: str) -> str:
    """Conservative world-model mode from the manifest and start fixture.

    Legacy bundles predate the marker and were real runs, so a missing field
    reads as "real". Any explicit non-real value wins if the two artifacts
    disagree; this prevents a stale ``real`` manifest from admitting a run
    whose authoritative launch snapshot says ``simulate``. An unreadable
    required artifact reads as "unknown".
    """
    try:
        manifest = read_archive_json(root_agent_id, "manifest.json.gz.enc")
    except Exception:
        return "unknown"
    manifest_value = manifest.get("world_model_mode")
    manifest_mode = (
        manifest_value.strip().lower() if isinstance(manifest_value, str) and manifest_value.strip() else None
    )
    try:
        start = read_archive_json(root_agent_id, "db/start.fixture.json.gz.enc")
    except FileNotFoundError:
        start = {}
    except Exception:
        return "unknown"
    rows = start.get("rows") if isinstance(start.get("rows"), dict) else {}
    agents = rows.get("Agent") if isinstance(rows, dict) else []
    root = (
        next(
            (row for row in agents if isinstance(row, dict) and row.get("id") == root_agent_id),
            {},
        )
        if isinstance(agents, list)
        else {}
    )
    fixture_value = root.get("worldModelMode") if isinstance(root, dict) else None
    fixture_mode = fixture_value.strip().lower() if isinstance(fixture_value, str) and fixture_value.strip() else None
    reported = [mode for mode in (manifest_mode, fixture_mode) if mode is not None]
    for mode in reported:
        if mode not in _REAL_WORLD_MODEL_MODES:
            return mode
    if "shadow" in reported:
        return "shadow"
    return "real"


def partition_real_world_bundles(bundle_ids: list[str]) -> tuple[list[str], dict[str, str]]:
    """Split bundles into real-interaction bundles vs excluded (simulated/unknown).

    Simulated trajectories contain world-model-emulated observations; feeding
    them back into the corpus the world model grounds on would be self-training
    on its own outputs.
    """
    real: list[str] = []
    excluded: dict[str, str] = {}
    for root_agent_id in bundle_ids:
        mode = bundle_world_model_mode(root_agent_id)
        if mode in _REAL_WORLD_MODEL_MODES:
            real.append(root_agent_id)
        else:
            excluded[root_agent_id] = mode
    return real, excluded


# Corpus eligibility = a classifiable real (non-simulated, non-legacy,
# non-DEMO) run with its START fixture (the replay state seed) and at least one
# possible result source. The END fixture is optional: provider/browser/trace
# artifacts and cumulative LLM contexts already preserve completed observations
# from unfinished runs. A launch-only shell has no completed step to embed, so
# rejecting it loses no training signal and avoids downloading its multi-MB
# fixture again during export.
_CORPUS_REQUIRED_ARTIFACTS = ("manifest.json.gz.enc", "db/start.fixture.json.gz.enc")
_CORPUS_RESULT_ARTIFACT = "db/end.fixture.json.gz.enc"
_CORPUS_RESULT_PREFIXES = ("llm/", "provider/", "browser/", "trace/", "otel/", "transitions/", "wmh/")
# Explicit diagnostic controls for total / per-bundle exported steps. Normal
# builds leave both at 0 (unlimited), so every completed step from every
# eligible bundle is embedded; a deliberately scoped operator run may opt in.
_WMH_MAX_STEPS_ENV = "WMH_MAX_STEPS"
_WMH_MAX_STEPS_PER_BUNDLE_ENV = "WMH_MAX_STEPS_PER_BUNDLE"
_WMH_EXPORT_WORKERS_ENV = "WMH_EXPORT_WORKERS"
_WMH_SCREEN_WORKERS_ENV = "WMH_SCREEN_WORKERS"
_WMH_SCREEN_BATCH_SIZE_ENV = "WMH_SCREEN_BATCH_SIZE"
_WMH_ARCHIVE_RETRY_ATTEMPTS_ENV = "WMH_ARCHIVE_RETRY_ATTEMPTS"
# Verdicts that a later terminal flush cannot change; anything else is re-checked
# after this many milliseconds (a running agent may still finalize).
_SCREENING_RECHECK_MS = 24 * 3600 * 1000
_FINAL_SCREENING_REASONS = ("eligible", "legacy-migrated", "simulated-run", "demo-task")
# Bump whenever bundle_corpus_eligibility changes: cached verdicts in the delta
# index were produced by the previous criterion and must be re-screened.
_SCREENING_POLICY_VERSION = "real-results-v6"


def _load_demo_benchmark_task_names() -> frozenset[str]:
    """Load the authoritative DEMO-tag task names without blocking a build.

    Archive manifests record the benchmark task name, while ``tasks.json`` owns
    the DEMO classification. A missing catalog produces no matches instead of
    turning archive screening into an ingestion failure.
    """
    try:
        tasks = json.loads(_BENCHMARK_TASKS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return frozenset()
    if not isinstance(tasks, list):
        return frozenset()
    names: set[str] = set()
    for task in tasks:
        if not isinstance(task, dict) or not isinstance(task.get("tags"), list):
            continue
        if not any(str(tag).strip().upper() == "DEMO" for tag in task["tags"]):
            continue
        name = task.get("name")
        if isinstance(name, str) and name.strip():
            names.add(name.strip())
    return frozenset(names)


_DEMO_BENCHMARK_TASK_NAMES = _load_demo_benchmark_task_names()


def _manifest_demo_task_name(manifest: JsonObject) -> str | None:
    """Return the catalog DEMO task named by an archive manifest, if any."""
    for manifest_field in ("benchmark_task_name", "benchmark_task"):
        value = manifest.get(manifest_field)
        if isinstance(value, str) and value.strip() in _DEMO_BENCHMARK_TASK_NAMES:
            return value.strip()
    return None


def partition_non_demo_bundles(bundle_ids: list[str]) -> tuple[list[str], dict[str, str]]:
    """Exclude DEMO-tagged benchmark runs without failing on unreadable manifests."""
    eligible: list[str] = []
    excluded: dict[str, str] = {}
    for root_agent_id in bundle_ids:
        try:
            manifest = read_archive_json(root_agent_id, "manifest.json.gz.enc")
        except Exception:
            # The gold policy handles unreadable manifests separately. The
            # legacy ``any-real`` policy remains best-effort, but never admits a
            # manifest that can be positively identified as a DEMO task.
            eligible.append(root_agent_id)
            continue
        demo_task_name = _manifest_demo_task_name(manifest)
        if demo_task_name is None:
            eligible.append(root_agent_id)
        else:
            excluded[root_agent_id] = f"demo-task:{demo_task_name}"
    return eligible, excluded


def _manifest_legacy_marker(manifest: JsonObject) -> bool:
    if manifest.get("legacy_migrated") is True:
        return True
    # Benchmark provenance is valid real-world signal when the run itself was
    # real and the catalog task is not tagged DEMO. Legacy migrations carry an
    # explicit marker on the manifest/fixtures; do not infer synthetic data
    # from benchmark generation alone.
    if manifest.get("source_kind") == "llm-only":
        return True
    restore = manifest.get("restore")
    if isinstance(restore, dict) and restore.get("legacy_migrated") is True:
        return True
    sensitive = manifest.get("sensitive")
    return isinstance(sensitive, dict) and isinstance(sensitive.get("legacy_fixture_limitations"), list)


def _is_transient_archive_error(exc: Exception) -> bool:
    response = getattr(exc, "response", None)
    error = response.get("Error") if isinstance(response, dict) else None
    metadata = response.get("ResponseMetadata") if isinstance(response, dict) else None
    code = str(error.get("Code") or "") if isinstance(error, dict) else ""
    status = int(metadata.get("HTTPStatusCode") or 0) if isinstance(metadata, dict) else 0
    text = f"{type(exc).__name__}: {exc}".lower()
    return (
        status in {429, 500, 502, 503, 504}
        or code.lower()
        in {
            "internalerror",
            "requesttimeout",
            "serviceunavailable",
            "slowdown",
            "throttling",
            "throttlingexception",
        }
        or any(
            marker in text
            for marker in (
                "connection reset",
                "incomplete read",
                "incompleteread",
                "read timeout",
                "reduce your concurrent request rate",
                "responsestreamingerror",
                "service unavailable",
                "temporarily unavailable",
                "too many requests",
            )
        )
    )


def _archive_listing_with_retry(
    root_agent_id: str,
    reader: Callable[[], list[Any]],
) -> list[Any]:
    attempts = max(1, int(os.environ.get(_WMH_ARCHIVE_RETRY_ATTEMPTS_ENV, "8") or "8"))
    for attempt in range(attempts):
        try:
            return reader()
        except Exception as exc:
            if attempt + 1 >= attempts or not _is_transient_archive_error(exc):
                raise
            # Deterministic jitter prevents every screening worker from retrying
            # the same R2 prefix in lockstep after a shared throttle response.
            jitter = int(hashlib.sha256(root_agent_id.encode()).hexdigest()[:2], 16) / 255
            time.sleep(min(8.0, 0.25 * (2**attempt)) + jitter)
    raise AssertionError("unreachable")


def _archive_artifact_paths_with_retry(root_agent_id: str) -> list[str]:
    return _archive_listing_with_retry(root_agent_id, lambda: archive_artifact_paths(root_agent_id))


def _r2_artifact_entries_with_retry(root_agent_id: str) -> list[JsonObject]:
    return _archive_listing_with_retry(root_agent_id, lambda: list_r2_artifact_entries(root_agent_id))


def prescreen_bundle_artifacts(root_agent_id: str) -> tuple[bool, str]:
    """Listing-only screen for the start metadata and a possible result source.

    An end fixture enriches a finalized bundle with terminal Message rows but
    is not required: incremental real provider/browser/trace observations from
    an unfinished run remain valid corpus steps.
    """
    paths = _archive_artifact_paths_with_retry(root_agent_id)
    present = set(paths)
    for required in _CORPUS_REQUIRED_ARTIFACTS:
        if required not in present:
            return False, f"missing:{required}"
    if _CORPUS_RESULT_ARTIFACT not in present and not any(path.startswith(_CORPUS_RESULT_PREFIXES) for path in paths):
        return False, "no-result-artifacts"
    return True, "artifacts-present"


def bundle_corpus_eligibility(root_agent_id: str) -> tuple[bool, str]:
    """Gold-policy verdict for one bundle: (eligible, reason).

    Runs the listing screen first so shells cost one request, then reads one
    small manifest for mode, legacy, and DEMO markers. The exporter validates
    the authoritative start-fixture mode before writing any OTel; doing that in
    this archive-wide screen downloaded every large start fixture twice.
    """
    ok, reason = prescreen_bundle_artifacts(root_agent_id)
    if not ok:
        return False, reason
    try:
        manifest = read_archive_json(root_agent_id, "manifest.json.gz.enc")
    except Exception as exc:
        return False, f"manifest-unreadable:{type(exc).__name__}"
    manifest_value = manifest.get("world_model_mode")
    mode = manifest_value.strip().lower() if isinstance(manifest_value, str) and manifest_value.strip() else "real"
    if mode not in _REAL_WORLD_MODEL_MODES:
        return False, f"simulated-run:{mode}"
    if _manifest_legacy_marker(manifest):
        return False, "legacy-migrated"
    demo_task_name = _manifest_demo_task_name(manifest)
    if demo_task_name is not None:
        return False, f"demo-task:{demo_task_name}"
    return True, "eligible"


def _indexed_step_count(old_bundles: Any, root_agent_id: str) -> int:
    prior = old_bundles.get(root_agent_id) if isinstance(old_bundles, dict) else None
    return int((prior or {}).get("steps") or 0) if isinstance(prior, dict) else 0


def _screening_verdict_is_final(reason: str) -> bool:
    return reason.startswith(_FINAL_SCREENING_REASONS)


def _screen_candidates(
    bundle_ids: list[str],
    cache: dict[str, JsonObject],
    now_ms: int,
) -> tuple[list[str], dict[str, str], int]:
    """Classify ``bundle_ids`` (parallel), reusing final or fresh cached verdicts.

    Returns (eligible ids in input order, excluded id -> reason, cache hits).
    Every verdict is written back to ``cache`` so the next refresh only pays
    for new bundles and for non-final ones whose recheck window elapsed.
    """
    pending: list[str] = []
    eligible: list[str] = []
    excluded: dict[str, str] = {}
    hits = 0
    for bundle_id in bundle_ids:
        cached = cache.get(bundle_id)
        if isinstance(cached, dict) and isinstance(cached.get("reason"), str):
            fresh = _screening_verdict_is_final(cached["reason"]) or (
                now_ms - int(cached.get("checked_at_ms") or 0) < _SCREENING_RECHECK_MS
            )
            if fresh:
                hits += 1
                if cached.get("eligible") is True:
                    eligible.append(bundle_id)
                else:
                    excluded[bundle_id] = cached["reason"]
                continue
        pending.append(bundle_id)
    if pending:
        verdicts: list[tuple[bool, str]] = []
        screened_started = time.time()
        # Each verdict is one listing request plus a manifest read only when a
        # bundle has a possible result. R2 can transiently throttle repeated
        # ListObjects calls, so each listing has bounded jittered retries.
        screen_workers = max(
            1,
            int(os.environ.get(_WMH_SCREEN_WORKERS_ENV) or _ARCHIVE_READ_WORKERS),
        )
        with ThreadPoolExecutor(max_workers=min(screen_workers, len(pending))) as pool:
            for verdict in pool.map(bundle_corpus_eligibility, pending):
                verdicts.append(verdict)
                if len(verdicts) % 5000 == 0:
                    # An uncapped screen walks the whole archive (~80k bundles);
                    # without this the build log is silent for ten-plus minutes.
                    print(
                        f"[WorldModel] Screened {len(verdicts)}/{len(pending)} bundles "
                        f"({sum(1 for ok, _ in verdicts if ok)} eligible, {time.time() - screened_started:.0f}s)",
                        flush=True,
                    )
        for bundle_id, (ok, reason) in zip(pending, verdicts):
            cache[bundle_id] = {"eligible": ok, "reason": reason, "checked_at_ms": now_ms}
            if ok:
                eligible.append(bundle_id)
            else:
                excluded[bundle_id] = reason
    # Preserve input order for eligibility (cache hits and fresh verdicts mixed).
    order = {bundle_id: index for index, bundle_id in enumerate(bundle_ids)}
    eligible.sort(key=order.__getitem__)
    return eligible, excluded, hits


def select_corpus_bundles(
    all_bundle_ids: list[str],
    old_bundles: dict[str, Any],
    *,
    max_bundles: int,
    cache: dict[str, JsonObject],
    now_ms: int,
    policy: str = "gold",
    checkpoint: Callable[[], None] | None = None,
) -> tuple[list[str], dict[str, str], int]:
    """Choose the corpus: gold-eligible bundles, already-indexed ones first.

    With a cap, candidates are screened in cap-sized batches until enough are
    eligible, so a refresh never classifies the whole archive just to fill a
    small corpus. ``policy="any-real"`` restores the pre-screening behaviour
    (cap by sorted id, then world-model mode only).
    """
    available = set(all_bundle_ids)
    retained = sorted(bundle_id for bundle_id in old_bundles if bundle_id in available)
    new = [bundle_id for bundle_id in all_bundle_ids if bundle_id not in old_bundles]
    if policy == "any-real":
        candidates = retained + new
        if max_bundles > 0 and len(candidates) > max_bundles:
            candidates = candidates[: max(max_bundles, len(retained))]
        real, excluded = partition_real_world_bundles(candidates)
        non_demo, demo_excluded = partition_non_demo_bundles(real)
        excluded.update(demo_excluded)
        return non_demo, excluded, 0
    limit = max(max_bundles, len(retained)) if max_bundles > 0 else 0
    ordered = retained + new
    selected: list[str] = []
    excluded: dict[str, str] = {}
    hits = 0
    position = 0
    screen_batch_size = max(
        1,
        int(os.environ.get(_WMH_SCREEN_BATCH_SIZE_ENV, "5000") or "5000"),
    )
    while position < len(ordered) and (limit == 0 or len(selected) < limit):
        batch_size = min(screen_batch_size, len(ordered) - position) if limit == 0 else max(limit - len(selected), 1)
        batch = ordered[position : position + batch_size]
        position += len(batch)
        eligible, batch_excluded, batch_hits = _screen_candidates(batch, cache, now_ms)
        excluded.update(batch_excluded)
        hits += batch_hits
        for bundle_id in eligible:
            if limit == 0 or len(selected) < limit:
                selected.append(bundle_id)
        if checkpoint is not None:
            checkpoint()
    return selected, excluded, hits


def archive_artifact_paths(root_agent_id: str, root: Path | None = None) -> list[str]:
    if root is None:
        return list_backend_archive_artifact_paths(root_agent_id)
    archive_root = root
    bundle = archive_root / root_agent_id
    if not bundle.exists():
        return []
    paths: list[str] = []
    for item in bundle.rglob("*"):
        if not item.is_file() or item.name.endswith(".meta.json"):
            continue
        paths.append(item.relative_to(bundle).as_posix())
    return sorted(paths)


def bundle_agent_ids(root_agent_id: str) -> list[str]:
    try:
        manifest = read_archive_json(root_agent_id, "manifest.json.gz.enc")
    except FileNotFoundError:
        return [root_agent_id]
    run = manifest.get("run") if isinstance(manifest.get("run"), dict) else {}
    correlations = manifest.get("correlations") if isinstance(manifest.get("correlations"), dict) else {}
    agent_ids = correlations.get("agent_ids") or run.get("agent_ids")
    if not isinstance(agent_ids, list):
        return [root_agent_id]
    ordered = [root_agent_id]
    for agent_id in agent_ids:
        if isinstance(agent_id, str) and agent_id not in ordered:
            ordered.append(agent_id)
    return ordered


def archive_artifact_paths_for_tree(root_agent_id: str) -> list[str]:
    paths: list[str] = []
    for agent_id in bundle_agent_ids(root_agent_id):
        for artifact_path in archive_artifact_paths(agent_id):
            if agent_id == root_agent_id:
                paths.append(artifact_path)
            else:
                paths.append(f"{agent_id}/{artifact_path}")
    return sorted(paths)


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        out: JsonObject = {}
        for key, inner in value.items():
            if _SECRET_KEY_RE.search(str(key)):
                out[key] = "[REDACTED]"
            else:
                out[key] = _redact(inner)
        return out
    if isinstance(value, list):
        return [_redact(v) for v in value]
    if isinstance(value, str):
        return _SECRET_VALUE_RE.sub("[REDACTED]", value)
    return value


def public_json_has_secret(value: Any) -> bool:
    encoded = json.dumps(value, ensure_ascii=False, default=str)
    if "[REDACTED]" in encoded:
        encoded = encoded.replace("[REDACTED]", "")
    if _HIGH_CONFIDENCE_SECRET_VALUE_RE.search(encoded):
        return True
    return any(_SECRET_KEY_RE.search(key) for key in _json_keys(value))


def _public_example_secret_violation(value: Any) -> bool:
    """True when a public-corpus record still carries a secret value or field."""
    if isinstance(value, dict):
        return any(
            (_SECRET_KEY_RE.search(str(key)) and inner != "[REDACTED]") or _public_example_secret_violation(inner)
            for key, inner in value.items()
        )
    if isinstance(value, list):
        return any(_public_example_secret_violation(inner) for inner in value)
    if isinstance(value, str):
        return bool(_HIGH_CONFIDENCE_SECRET_VALUE_RE.search(value.replace("[REDACTED]", "")))
    return False


def _json_keys(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for key, inner in value.items():
            yield str(key)
            yield from _json_keys(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from _json_keys(inner)


def _drop_secret_fields(value: Any) -> Any:
    """Remove secret-shaped fields from portable public evaluation artifacts."""

    if isinstance(value, dict):
        return {key: _drop_secret_fields(inner) for key, inner in value.items() if not _SECRET_KEY_RE.search(str(key))}
    if isinstance(value, list):
        return [_drop_secret_fields(inner) for inner in value]
    return value


def canonical_category_for_tool(tool_name: str) -> str:
    if tool_name in _EXPLORE_ORCHESTRATION_TOOLS:
        return "explore"
    if tool_name in _FOR_EACH_ORCHESTRATION_TOOLS:
        return "for_each"
    if tool_name in _BROWSER_TOOLS or tool_name.startswith("browser_"):
        return "browser"
    if tool_name in _CODE_TOOLS or "code" in tool_name:
        return "code"
    if tool_name in _MESSAGE_TOOLS or tool_name.startswith("message_"):
        return "message"
    if tool_name in _PAYMENT_TOOLS or "payment" in tool_name or "write_lock" in tool_name:
        return "payment"
    if tool_name in _VAPI_TOOLS or tool_name.startswith("vapi_"):
        return "vapi"
    if tool_name in _GREP_TOOLS or tool_name.startswith("grep"):
        return "grep"
    if tool_name in _DEMO_CACHE_TOOLS or "cache" in tool_name:
        return "fast_cache"
    if tool_name in {"request_user_approval", "request_user_signup", "request_user_auth"}:
        return "auth_approval"
    return "tool"


def is_world_model_environment_boundary(tool_name: str) -> bool:
    """Return true for provider boundaries and specialized subagent calls.

    General-purpose agent orchestration deliberately stays real, including
    for-each batches.
    """

    return tool_name in _ENVIRONMENT_BOUNDARY_TOOLS


def canonical_action_from_tool_call(
    tool_name: str,
    tool_args: JsonObject,
    tool_call_id: str,
    *,
    agent_id: str | None = None,
    span_id: str | None = None,
    redaction_mode: str = "public",
    timestamp_ms: int | None = None,
) -> CanonicalAction:
    return CanonicalAction(
        category=canonical_category_for_tool(tool_name),
        name=tool_name,
        arguments=_maybe_redact(tool_args, redaction_mode),
        agent_id=agent_id,
        span_id=span_id,
        tool_call_id=tool_call_id,
        timestamp_ms=timestamp_ms if timestamp_ms is not None else current_world_model_timestamp_ms(),
    )


def current_world_model_timestamp_ms() -> int:
    """Return the timestamp to stamp on WMH actions.

    Sim-clock work can provide an authoritative logical clock through env. Until
    that coordinator exists, wall clock remains the fallback.
    """

    for env_name in ("WMH_SIM_TIME_MS", "WORLD_MODEL_SIM_TIME_MS"):
        raw = os.environ.get(env_name)
        if raw is None or not raw.strip():
            continue
        try:
            return int(raw)
        except ValueError as exc:
            raise ValueError(f"{env_name} must be an integer millisecond timestamp") from exc
    return int(time.time() * 1000)


def _maybe_redact(value: Any, redaction_mode: str) -> Any:
    if redaction_mode == "none":
        return value
    if redaction_mode != "public":
        raise ValueError("redaction_mode must be 'public' or 'none'")
    return _redact(value)


def _stable_hex(value: str, chars: int) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:chars]


def _timestamp_nano(base_ms: int | None, offset: int) -> str:
    ms = base_ms if base_ms is not None else int(time.time() * 1000)
    return str((ms * 1_000_000) + offset)


# Characters that Python's ``str.splitlines()`` treats as line breaks but JSON
# does not require escaping. The upstream retriever loads ``steps.jsonl`` with
# ``read_text().splitlines()``, so a web page containing U+2028 (4 of 132k
# steps in the 2026-09-09 corpus) split one record in two and the model
# refused to serve. Escaping them keeps every record on exactly one line.
_JSONL_LINE_BREAKS = {"\u2028": "\\u2028", "\u2029": "\\u2029", "\u0085": "\\u0085"}


def jsonl_line(text: str) -> str:
    """One JSON document as a single physical line for any line-splitting reader."""
    for raw, escaped in _JSONL_LINE_BREAKS.items():
        if raw in text:
            text = text.replace(raw, escaped)
    return text


def normalize_world_model_index_records(model_root: str | Path) -> JsonObject:
    """Publish upstream's index with the same JSONL framing as delta refreshes.

    Ingestion decodes the exported escapes before upstream serializes Steps again.
    Stream physical records so embedded Unicode separators remain string content;
    validate the complete index before replacing it, without re-embedding or
    changing any decoded data or the parallel matrix.
    """
    import tempfile

    import numpy as np
    from wmh.core.types import Step

    index_path = Path(model_root) / "index"
    steps_path = index_path / "steps.jsonl"
    matrix = np.load(index_path / "embeddings.npy", mmap_mode="r")
    records = 0
    escaped_records = 0
    with tempfile.TemporaryDirectory(prefix="index-framing-", dir=str(index_path)) as tmp:
        normalized_path = Path(tmp) / "steps.jsonl"
        with steps_path.open(encoding="utf-8") as source, normalized_path.open("w", encoding="utf-8") as output:
            for line in source:
                if not line.strip():
                    continue
                Step.model_validate_json(line)
                normalized = jsonl_line(line)
                output.write(normalized)
                records += 1
                escaped_records += int(normalized != line)
        if matrix.ndim != 2 or matrix.shape[0] != records:
            raise ValueError(f"WMH index has {records} records but matrix shape {matrix.shape}")
        os.replace(normalized_path, steps_path)
    return {"indexed_steps": records, "escaped_records": escaped_records}


def _otel_attr(key: str, value: Any) -> JsonObject:
    if isinstance(value, bool):
        encoded: JsonObject = {"boolValue": value}
    elif isinstance(value, int):
        encoded = {"intValue": str(value)}
    elif isinstance(value, float):
        encoded = {"doubleValue": value}
    else:
        encoded = {"stringValue": value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)}
    return {"key": key, "value": encoded}


def _fixture_ref(root_agent_id: str, path: str) -> JsonObject | None:
    # Metadata-only: a ref never needs the (multi-MB) fixture ciphertext itself.
    metadata = read_archive_artifact_metadata(root_agent_id=root_agent_id, path=path)
    if metadata is None:
        return None
    return {
        "path": path,
        "plaintext_sha256": metadata.get("plaintext_sha256"),
        "plaintext_bytes": metadata.get("plaintext_bytes"),
    }


def _artifact_meta_ref(root_agent_id: str, path: str) -> JsonObject | None:
    metadata = read_archive_artifact_metadata(root_agent_id=root_agent_id, path=path)
    if metadata is None:
        return None
    return {
        "path": path,
        "category": _artifact_category(path, metadata.get("content_type")),
        "content_type": metadata.get("content_type"),
        "compression": metadata.get("compression"),
        "plaintext_sha256": metadata.get("plaintext_sha256"),
        "plaintext_bytes": metadata.get("plaintext_bytes"),
    }


def _artifact_category(path: str, content_type: Any = None) -> str:
    content = str(content_type or "")
    lower = path.lower()
    if content.startswith(("image/", "video/", "audio/")) or lower.endswith(
        (
            ".jpg.enc",
            ".jpeg.enc",
            ".png.enc",
            ".gif.enc",
            ".webp.enc",
            ".mp4.enc",
            ".m4a.enc",
            ".mp3.enc",
            ".wav.enc",
            ".m3u8.enc",
        )
    ):
        return "media"
    if lower.startswith("provider/") or "/provider/" in lower or "vapi" in lower:
        return "provider"
    if lower.startswith("browser/") or "/browser/" in lower or "dom" in lower or "screenshot" in lower:
        return "browser"
    if lower.startswith("db/"):
        return "db_fixture"
    return "artifact"


def _json_ref_paths(value: Any) -> list[str]:
    refs: list[str] = []
    if isinstance(value, dict):
        for key, inner in value.items():
            key_text = str(key)
            if key_text.endswith("_ref") and isinstance(inner, str):
                refs.append(inner)
            elif key_text.endswith("_refs") and isinstance(inner, list):
                refs.extend(item for item in inner if isinstance(item, str))
            refs.extend(_json_ref_paths(inner))
    elif isinstance(value, list):
        for inner in value:
            refs.extend(_json_ref_paths(inner))
    return sorted(dict.fromkeys(refs))


def _initial_trace_state(root_agent_id: str, redaction_mode: str) -> JsonObject:
    try:
        payload = read_archive_json(root_agent_id, "trace/transitions.json.gz.enc")
    except FileNotFoundError:
        return {}
    raw_transitions = payload.get("transitions")
    if not isinstance(raw_transitions, list) or not raw_transitions:
        return {}
    first = raw_transitions[0]
    if not isinstance(first, dict):
        return {}
    state_before = first.get("state_before")
    return _maybe_redact(state_before, redaction_mode) if isinstance(state_before, dict) else {}


def reconstruct_initial_state(root_agent_id: str, *, redaction_mode: str = "public") -> JsonObject:
    memo = _archive_json_memo.get()
    memo_key = ("__initial_state__", root_agent_id, redaction_mode)
    if memo is not None and memo_key in memo:
        return memo[memo_key]
    state = _reconstruct_initial_state(root_agent_id, redaction_mode=redaction_mode)
    if memo is not None:
        memo[memo_key] = state
    return state


def _reconstruct_initial_state(root_agent_id: str, *, redaction_mode: str) -> JsonObject:
    start = read_archive_json(root_agent_id, "db/start.fixture.json.gz.enc")
    rows = start.get("rows") if isinstance(start.get("rows"), dict) else {}
    row_counts = {table: len(values) for table, values in rows.items() if isinstance(values, list)}
    root_agent_rows = rows.get("Agent") if isinstance(rows, dict) else []
    root_goal = None
    if isinstance(root_agent_rows, list):
        for row in root_agent_rows:
            if isinstance(row, dict) and row.get("id") == root_agent_id:
                root_goal = row.get("goal")
                break
    initial_trace_state = _initial_trace_state(root_agent_id, redaction_mode)
    refs = ["db/start.fixture.json.gz.enc", *_json_ref_paths(initial_trace_state)]
    artifact_refs = [ref for ref in (_artifact_meta_ref(root_agent_id, path) for path in refs) if ref is not None]
    state = {
        "schema": "rose.initial_state.v1",
        "root_agent_id": root_agent_id,
        "user_id": start.get("user_id"),
        "base_image": start.get("base_image"),
        "agent_ids": start.get("agent_ids", []),
        "root_goal": root_goal,
        "db_fixture_ref": _fixture_ref(root_agent_id, "db/start.fixture.json.gz.enc"),
        # The rows themselves stay in the archive (``rows_ref`` = path + plaintext
        # sha256): they are tens of MB per bundle, nothing downstream reads them
        # from this state, and redacting them dominated export CPU.
        "db_fixture": {
            "restore": start.get("restore") if isinstance(start.get("restore"), dict) else {},
            "rows_ref": _fixture_ref(root_agent_id, "db/start.fixture.json.gz.enc"),
        },
        "row_counts": row_counts,
        "state_before_first_action": initial_trace_state,
        "artifact_refs": artifact_refs,
        "provider_artifacts": [ref for ref in artifact_refs if ref.get("category") == "provider"],
        "media_artifacts": [ref for ref in artifact_refs if ref.get("category") == "media"],
    }
    return _maybe_redact(state, redaction_mode)


def _retrieval_state_from_initial_state(initial_state: JsonObject) -> JsonObject:
    """Remove replay-only bulk data before repeating state in every retrieval step.

    Retrieval only needs the stable fixture reference/hash (``db_fixture_ref``), row counts,
    goal, and other compact provenance; the restore strategy is replay-only. Replay re-reads
    the rows from the archive via ``db_fixture.rows_ref``.
    """

    return {key: value for key, value in initial_state.items() if key != "db_fixture"}


def _real_clock_ms(value: Any) -> int | None:
    """Accept only an explicit nonnegative integer clock; never infer one."""

    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _transition_from_raw(raw: JsonObject, root_agent_id: str, redaction_mode: str) -> RoseTransition:
    action_raw = raw.get("action") if isinstance(raw.get("action"), dict) else {}
    observation_raw = raw.get("observation") if isinstance(raw.get("observation"), dict) else {}
    state_raw = raw.get("state_before") if isinstance(raw.get("state_before"), dict) else {}
    action = CanonicalAction(
        category=str(action_raw.get("category") or "tool"),
        name=str(action_raw.get("name") or action_raw.get("tool_name") or "unknown"),
        arguments=_maybe_redact(action_raw.get("arguments") or {}, redaction_mode),
        agent_id=str(action_raw.get("agent_id") or root_agent_id),
        span_id=str(action_raw.get("span_id") or raw.get("span_id") or ""),
        tool_call_id=str(action_raw.get("tool_call_id") or ""),
        artifact_refs=list(action_raw.get("artifact_refs") or []),
        timestamp_ms=action_raw.get("timestamp_ms") if isinstance(action_raw.get("timestamp_ms"), int) else None,
    )
    observation = CanonicalObservation(
        category=str(observation_raw.get("category") or action.category),
        content=str(_maybe_redact(observation_raw.get("content") or "", redaction_mode)),
        is_error=bool(observation_raw.get("is_error")),
        metadata=_maybe_redact(observation_raw.get("metadata") or {}, redaction_mode),
        artifact_refs=list(observation_raw.get("artifact_refs") or []),
        timestamp_ms=observation_raw.get("timestamp_ms")
        if isinstance(observation_raw.get("timestamp_ms"), int)
        else None,
        started_at_ms=_real_clock_ms(observation_raw.get("started_at_ms")),
    )
    return RoseTransition(
        state_before=_maybe_redact(state_raw, redaction_mode),
        scratchpad=str(_maybe_redact(str(raw.get("scratchpad") or ""), redaction_mode)),
        action=action,
        observation=observation,
        raw_span_ids=[str(v) for v in raw.get("raw_span_ids") or []],
    )


def _is_demo_cache_replay_transition(raw: JsonObject) -> bool:
    """A transition whose observation was replayed from the DEMO cache.

    The fresh write that populated the cache is the original signal and is
    already in the corpus from the run that recorded it; replays are
    low-signal duplicates and must not re-enter the RAG.
    """
    if raw.get("from_fast_cache") is True:
        return True
    observation = raw.get("observation")
    if isinstance(observation, dict):
        metadata = observation.get("metadata")
        if isinstance(metadata, dict) and metadata.get("from_fast_cache") is True:
            return True
    return False


def _transitions_from_trace_artifact(root_agent_id: str, redaction_mode: str) -> list[RoseTransition]:
    try:
        payload = read_archive_json(root_agent_id, "trace/transitions.json.gz.enc")
    except FileNotFoundError:
        return []
    raw_transitions = payload.get("transitions")
    if not isinstance(raw_transitions, list):
        raise ValueError("trace/transitions.json.gz.enc must contain a transitions array")
    raw_dicts = [raw for raw in raw_transitions if isinstance(raw, dict)]
    replay_count = sum(1 for raw in raw_dicts if _is_demo_cache_replay_transition(raw))
    if replay_count:
        print(
            f"[WorldModel] Dropped {replay_count} demo-cache replay transition(s) from "
            f"{root_agent_id} (corpus keeps fresh interactions only)",
            flush=True,
        )
    return [
        _transition_from_raw(raw, root_agent_id, redaction_mode)
        for raw in raw_dicts
        if not _is_demo_cache_replay_transition(raw)
    ]


def _latest_update_by_dump_id(archive_agent_id: str) -> dict[str, JsonObject]:
    updates: dict[str, JsonObject] = {}
    for path in archive_artifact_paths(archive_agent_id):
        if not path.startswith("llm-updates/") or not path.endswith(".json.gz.enc"):
            continue
        payload = read_archive_json(archive_agent_id, path)
        dump_id = payload.get("dump_id")
        if isinstance(dump_id, str):
            updates[dump_id] = payload
    return updates


def _transitions_from_llm_dumps(
    root_agent_id: str,
    redaction_mode: str,
    initial_state: JsonObject,
) -> list[RoseTransition]:
    transitions: list[RoseTransition] = []
    replay_dump_count = 0
    retrieval_state = _retrieval_state_from_initial_state(initial_state)
    for archive_agent_id in bundle_agent_ids(root_agent_id):
        updates = _latest_update_by_dump_id(archive_agent_id)
        for path in archive_artifact_paths(archive_agent_id):
            if not path.startswith("llm/") or not path.endswith(".json.gz.enc"):
                continue
            artifact_ref = path if archive_agent_id == root_agent_id else f"{archive_agent_id}/{path}"
            base = read_archive_json(archive_agent_id, path)
            base_payload = (
                base.get("payload")
                if base.get("kind") == "legacy-llm-dump" and isinstance(base.get("payload"), dict)
                else base
            )
            payload = updates.get(str(base_payload.get("dump_id")), base_payload)
            output = payload.get("output") if isinstance(payload.get("output"), dict) else {}
            usage = output.get("usage") if isinstance(output.get("usage"), dict) else {}
            if usage.get("from_fast_cache"):
                # Replayed responses duplicate a fresh interaction already in the
                # corpus (the run that wrote the cache entry). Replays normally
                # never produce dumps at all — this guards the invariant if a
                # future refactor starts dumping them.
                replay_dump_count += 1
                continue
            tool_calls = output.get("tool_calls") if isinstance(output.get("tool_calls"), list) else []
            if not tool_calls:
                content = str(output.get("content") or "")
                if not content:
                    continue
                tool_calls = [{"name": "assistant_message", "arguments": {"content": content}, "id": ""}]
            for index, call in enumerate(tool_calls):
                if not isinstance(call, dict):
                    continue
                raw_args = call.get("arguments")
                if isinstance(raw_args, str):
                    try:
                        args: Any = json.loads(raw_args) if raw_args.strip() else {}
                    except json.JSONDecodeError:
                        args = {"value": raw_args}
                else:
                    args = raw_args or {}
                if not isinstance(args, dict):
                    args = {"value": args}
                timestamp_ms = None
                metadata = (
                    payload.get("archive", {}).get("metadata") if isinstance(payload.get("archive"), dict) else {}
                )
                if isinstance(metadata, dict) and isinstance(metadata.get("created_at_ms"), int):
                    timestamp_ms = metadata["created_at_ms"] + index
                action = CanonicalAction(
                    category="llm_tool_call",
                    name=str(call.get("name") or "unknown"),
                    arguments=_maybe_redact(args, redaction_mode),
                    agent_id=str(payload.get("agent_id") or archive_agent_id),
                    span_id=str(payload.get("span_id") or ""),
                    tool_call_id=str(call.get("id") or ""),
                    artifact_refs=[artifact_ref],
                    timestamp_ms=timestamp_ms,
                )
                observation = CanonicalObservation(
                    category="tool_result",
                    content="",
                    metadata={
                        "source": "llm_dump",
                        "dump_id": payload.get("dump_id"),
                        "call_site": payload.get("call_site"),
                        "model": payload.get("model"),
                        "result_unavailable": True,
                    },
                    artifact_refs=[artifact_ref],
                    timestamp_ms=timestamp_ms,
                )
                transitions.append(
                    RoseTransition(
                        state_before=retrieval_state,
                        scratchpad="",
                        action=action,
                        observation=observation,
                        raw_span_ids=[str(payload.get("span_id") or "")],
                    )
                )
    if replay_dump_count:
        print(
            f"[WorldModel] Dropped {replay_dump_count} demo-cache replay LLM dump(s) from "
            f"{root_agent_id} (corpus keeps fresh interactions only)",
            flush=True,
        )
    return transitions


def _row_timestamp_ms(row: JsonObject) -> int | None:
    for key in ("createdAt", "created_at", "timestamp", "updatedAt", "updated_at"):
        value = row.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return int(value)
        if not isinstance(value, str) or not value.strip():
            continue
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            continue
        return int(parsed.timestamp() * 1000)
    return None


def _compact_browser_state(value: Any, redaction_mode: str) -> JsonObject:
    if not isinstance(value, dict):
        return {}
    state = {key: inner for key, inner in value.items() if key not in {"frame", "screenshot", "website_frame"}}
    dom_tree = state.get("dom_tree")
    if isinstance(dom_tree, str) and len(dom_tree) > 24_000:
        state["dom_tree"] = dom_tree[:24_000] + "\n[truncated]"
    return _maybe_redact(state, redaction_mode)


def _browser_action_arguments_from_entry(
    entry: JsonObject,
    *,
    root_goal: str,
    previous_state: JsonObject,
    redaction_mode: str,
) -> JsonObject:
    params = dict(entry.get("params") or {}) if isinstance(entry.get("params"), dict) else {}
    for key in ("index", "coordinates", "element_description"):
        if entry.get(key) is not None:
            params[key] = entry[key]
    return _maybe_redact(
        {
            "goal": root_goal,
            "action": str(entry.get("action") or "unknown"),
            "params": params,
            "thinking": str(entry.get("thinking") or ""),
            "current_browser_state": previous_state,
            "approval": {"granted": False, "type": None, "payment_card_last4": None},
        },
        redaction_mode,
    )


def _transitions_from_browser_observations(
    root_agent_id: str,
    redaction_mode: str,
    initial_state: JsonObject,
) -> tuple[list[RoseTransition], set[str]]:
    """Build grounded browser transitions from recorder DOM observations.

    Recorder observations are real post-action website states and include the
    exact cumulative action entries that produced them. An observation for
    iteration N is the state after the final action in its action_entries list;
    retaining that final action avoids falsely assigning one future state to
    every intermediate action when the recorder sampled multiple steps apart.
    """

    retrieval_state = _retrieval_state_from_initial_state(initial_state)
    root_goal = str(initial_state.get("root_goal") or "")
    grouped: dict[tuple[str, str], list[tuple[int, str]]] = {}
    for archive_agent_id in bundle_agent_ids(root_agent_id):
        for path in archive_artifact_paths(archive_agent_id):
            match = _BROWSER_OBSERVATION_PATH_RE.match(path)
            if not match:
                continue
            key = (archive_agent_id, match.group("task_id"))
            grouped.setdefault(key, []).append((int(match.group("iteration")), path))

    transitions: list[RoseTransition] = []
    grounded_task_ids: set[str] = set()
    for (archive_agent_id, task_id), observation_paths in sorted(grouped.items()):
        previous_browser_state: JsonObject = {}
        seen_actions: set[tuple[Any, str]] = set()
        for iteration, path in sorted(observation_paths):
            try:
                payload = read_archive_json(archive_agent_id, path)
            except (FileNotFoundError, ValueError):
                continue
            browser_state = _compact_browser_state(payload.get("browser_state"), redaction_mode)
            action_entries = payload.get("action_entries")
            if isinstance(action_entries, list) and action_entries:
                raw_entry = action_entries[-1]
                if isinstance(raw_entry, dict):
                    entry = raw_entry
                    action_name = str(entry.get("action") or "unknown")
                    action_key = (entry.get("step", iteration - 1), action_name)
                    if action_key not in seen_actions and browser_state:
                        seen_actions.add(action_key)
                        grounded_task_ids.add(task_id)
                        artifact_ref = path if archive_agent_id == root_agent_id else f"{archive_agent_id}/{path}"
                        action_result = entry.get("result") if isinstance(entry.get("result"), dict) else {}
                        observation_payload = _maybe_redact(
                            {
                                "browser_state": browser_state,
                                "action_result": action_result,
                            },
                            redaction_mode,
                        )
                        timestamp_ms = (
                            int(payload["ts_ms"])
                            if isinstance(payload.get("ts_ms"), (int, float))
                            and not isinstance(payload.get("ts_ms"), bool)
                            else None
                        )
                        state_before = dict(retrieval_state)
                        if previous_browser_state:
                            state_before["browser_state"] = previous_browser_state
                        transitions.append(
                            RoseTransition(
                                state_before=state_before,
                                scratchpad=str(_maybe_redact(str(entry.get("thinking") or ""), redaction_mode)),
                                action=CanonicalAction(
                                    category="browser",
                                    name="browser_action",
                                    arguments=_browser_action_arguments_from_entry(
                                        entry,
                                        root_goal=root_goal,
                                        previous_state=previous_browser_state,
                                        redaction_mode=redaction_mode,
                                    ),
                                    agent_id=archive_agent_id,
                                    tool_call_id=f"archive:{task_id}:{action_key[0]}",
                                    artifact_refs=[artifact_ref],
                                    timestamp_ms=timestamp_ms,
                                ),
                                observation=CanonicalObservation(
                                    category="browser_state",
                                    content=json.dumps(
                                        observation_payload,
                                        ensure_ascii=False,
                                        sort_keys=True,
                                    ),
                                    is_error=bool(action_result.get("success") is False),
                                    metadata={
                                        "source": "browser_observation",
                                        "task_id": task_id,
                                        "iteration": iteration,
                                        "action_step": action_key[0],
                                        "result_unavailable": False,
                                    },
                                    artifact_refs=[artifact_ref],
                                    timestamp_ms=timestamp_ms,
                                ),
                            )
                        )
            if browser_state:
                previous_browser_state = browser_state
    return transitions, grounded_task_ids


def _browser_params_from_message(metadata: JsonObject, title: str) -> JsonObject:
    params = dict(metadata.get("auxiliary") or {}) if isinstance(metadata.get("auxiliary"), dict) else {}
    action_type = str(metadata.get("action_type") or "")
    if action_type == "goto" and "→" in title:
        params["url"] = title.split("→", 1)[1].strip()
    elif action_type == "input_text":
        match = re.search(r"Typed '([^']*)'", title)
        if match:
            params["text"] = match.group(1)
    elif action_type == "press_key" and title.startswith("Pressed "):
        params["key"] = title[len("Pressed ") :].strip()
    elif action_type.startswith("scroll_"):
        params["direction"] = action_type.removeprefix("scroll_")
        match = re.search(r"(\d+)px", title)
        if match:
            params["amount"] = int(match.group(1))
    elif action_type == "wait":
        match = re.search(r"(\d+)ms", title)
        if match:
            params["time_ms"] = int(match.group(1))
    if title:
        params["grounded_event"] = title
    return params


def _browser_state_from_message(title: str, message: str, action_type: str) -> JsonObject:
    content = message.strip() or title.strip()
    url = ""
    if action_type == "goto" and "→" in title:
        url = title.split("→", 1)[1].strip()
    return {
        "url": url,
        "title": title,
        "dom_tree": content,
        "viewport": {"width": 1280, "height": 800},
        "scroll_position": {"pages_above": 0, "pages_below": 0, "total_pages": 1},
        "page_stats": {},
        "tabs": ([{"id": 0, "url": url, "title": title}] if url else []),
        "recent_events": [content] if content else [],
    }


def _assistant_tool_arguments(call: JsonObject) -> JsonObject:
    """Read both Responses-style nested arguments and Rose's flattened calls."""

    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    raw_arguments = call.get("arguments", function.get("arguments"))
    if isinstance(raw_arguments, str):
        try:
            decoded = json.loads(raw_arguments) if raw_arguments.strip() else {}
        except json.JSONDecodeError:
            decoded = {"value": raw_arguments}
        return decoded if isinstance(decoded, dict) else {"value": decoded}
    if isinstance(raw_arguments, dict):
        return dict(raw_arguments)
    excluded_keys = {"tool", "name", "tool_call_id", "id", "arguments", "function"}
    if function:
        excluded_keys.add("type")
    return {key: value for key, value in call.items() if key not in excluded_keys}


def _assistant_tool_name(call: JsonObject) -> str:
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    return str(call.get("name") or call.get("tool") or function.get("name") or "").strip()


def _llm_message_text(value: Any) -> str:
    """Flatten provider-neutral message content without losing tool results."""

    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content")
                parts.append(text if isinstance(text, str) else json.dumps(item, ensure_ascii=False, default=str))
            else:
                parts.append(str(item))
        return "\n".join(part for part in parts if part)
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False, default=str) if isinstance(value, dict) else str(value)


def _transitions_from_llm_message_history(
    root_agent_id: str,
    redaction_mode: str,
    initial_state: JsonObject,
) -> list[RoseTransition]:
    """Recover completed tool pairs from cumulative LLM contexts of partial runs.

    A live/interrupted run has no end fixture, but every subsequent model call
    archives its full input context. Those contexts contain the assistant tool
    call and the real tool-role result. Parse only such completed pairs and
    deduplicate their repeated appearances across cumulative dumps.
    """

    retrieval_state = _retrieval_state_from_initial_state(initial_state)
    contexts: list[tuple[int, str, str, JsonObject]] = []
    for archive_agent_id in bundle_agent_ids(root_agent_id):
        for path in archive_artifact_paths(archive_agent_id):
            if not path.startswith("llm/") or not path.endswith(".json.gz.enc"):
                continue
            try:
                payload = read_archive_json(archive_agent_id, path)
            except (FileNotFoundError, ValueError):
                continue
            metadata = read_archive_artifact_metadata(root_agent_id=archive_agent_id, path=path) or {}
            created_at_ms = int(metadata.get("created_at_ms") or 0)
            contexts.append((created_at_ms, path, archive_agent_id, payload))
    contexts.sort(key=lambda item: (item[0], item[1], item[2]))

    transitions: list[RoseTransition] = []
    seen_call_ids: set[tuple[str, str]] = set()
    last_timestamp_by_agent: dict[str, int] = {}
    for created_at_ms, path, archive_agent_id, payload in contexts:
        messages = payload.get("messages") if isinstance(payload.get("messages"), list) else []
        actions: dict[str, tuple[str, JsonObject, int]] = {}
        for position, message in enumerate(messages):
            if not isinstance(message, dict):
                continue
            role = str(message.get("role") or "").lower()
            if role == "assistant":
                calls = message.get("tool_calls") if isinstance(message.get("tool_calls"), list) else []
                for call in calls:
                    if not isinstance(call, dict):
                        continue
                    call_id = str(call.get("id") or call.get("tool_call_id") or "").strip()
                    tool_name = _assistant_tool_name(call)
                    if call_id and tool_name:
                        actions[call_id] = (tool_name, _assistant_tool_arguments(call), position)
                continue
            if role != "tool":
                continue
            call_id = str(message.get("tool_call_id") or message.get("toolCallId") or "").strip()
            dedupe_key = (str(payload.get("agent_id") or archive_agent_id), call_id)
            if not call_id or dedupe_key in seen_call_ids or call_id not in actions:
                continue
            tool_name, arguments, action_position = actions[call_id]
            tool_name = _canonical_message_tool_name(tool_name, {}, arguments)
            content = _llm_message_text(message.get("content"))
            if not content:
                continue
            seen_call_ids.add(dedupe_key)
            # The archive timestamp belongs to the next LLM request. These
            # inferred ordering timestamps do not establish physical event times.
            timestamp_ms = max(0, created_at_ms - len(messages) + action_position) if created_at_ms else None
            if timestamp_ms is not None:
                # Close archive writes can yield equal or decreasing estimates
                # as the cumulative context grows. Preserve observed result
                # order for this agent when the final corpus sort uses time.
                timestamp_ms = max(timestamp_ms, last_timestamp_by_agent.get(dedupe_key[0], -1) + 1)
                last_timestamp_by_agent[dedupe_key[0]] = timestamp_ms
            artifact_ref = path if archive_agent_id == root_agent_id else f"{archive_agent_id}/{path}"
            category = canonical_category_for_tool(tool_name)
            transitions.append(
                RoseTransition(
                    state_before=_maybe_redact(retrieval_state, redaction_mode),
                    scratchpad="",
                    action=CanonicalAction(
                        category=category,
                        name=tool_name,
                        arguments=_maybe_redact(arguments, redaction_mode),
                        agent_id=str(payload.get("agent_id") or archive_agent_id),
                        span_id=str(payload.get("span_id") or ""),
                        tool_call_id=call_id,
                        artifact_refs=[artifact_ref],
                        timestamp_ms=timestamp_ms,
                    ),
                    observation=CanonicalObservation(
                        category=f"{category}_result",
                        content=str(_maybe_redact(content, redaction_mode)),
                        metadata={
                            "source": "llm_context_tool_result",
                            "call_site": payload.get("call_site"),
                            "result_unavailable": False,
                        },
                        artifact_refs=[artifact_ref],
                        timestamp_ms=timestamp_ms,
                    ),
                )
            )
    return transitions


def _canonical_message_tool_name(tool_name: str, metadata: JsonObject, arguments: JsonObject) -> str:
    """Resolve unified ``spawn_agent`` rows to their concrete public tool."""

    if tool_name != "spawn_agent":
        return tool_name
    agent_type = str(metadata.get("agentType") or arguments.get("type") or "").strip().lower()
    return {
        "explore": "spawn_explore_agent",
        "browser": "spawn_browser_agent",
        "code": "spawn_code_agent",
        "general_purpose": "spawn_general_purpose_agent",
        "general-purpose": "spawn_general_purpose_agent",
        "for_each": "spawn_general_purpose_agent_for_each",
        "for-each": "spawn_general_purpose_agent_for_each",
    }.get(agent_type, tool_name)


def _message_fixture_call_key(row: JsonObject, metadata: JsonObject) -> tuple[str, str] | None:
    """Identity of one tool invocation inside a root tree's DB fixture."""

    tool_call_id = str(metadata.get("toolCallId") or "").strip()
    if not tool_call_id:
        return None
    return str(row.get("agentId") or ""), tool_call_id


def _message_fixture_is_browser_action(tool_name: str, metadata: JsonObject) -> bool:
    """Whether a Message row is one browser-policy action, not spawn lifecycle."""

    if tool_name not in _BROWSER_ORCHESTRATION_TOOLS:
        return False
    action_type = str(metadata.get("action_type") or "").strip()
    return bool(
        action_type
        and action_type not in _BROWSER_NON_ACTION_EVENTS
        and not action_type.startswith(("agentcard_", "purchase_"))
    )


def _latest_message_fixture_terminal_indices(messages: list[JsonObject]) -> dict[tuple[str, str], int]:
    """Match the agent boundary: one latest terminal result per tool call.

    Browser-policy action rows are intentionally excluded from this collapse.
    They are distinct environment steps recovered from legacy Message fixtures;
    the shared parent spawn id on those UI rows is not their action identity.
    """

    latest: dict[tuple[str, str], int] = {}
    for index, row in enumerate(messages):
        if str(row.get("role") or "").upper() != "TOOL":
            continue
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        if (
            str(metadata.get("toolStatus") or "").upper() not in _TERMINAL_TOOL_STATUSES
            or metadata.get("world_model_simulated") is True
            or bool(metadata.get("excludeFromModel"))
            or is_internal_subagent_message(row)
        ):
            continue
        tool_name = _canonical_message_tool_name(str(metadata.get("toolName") or ""), metadata, {})
        if _message_fixture_is_browser_action(tool_name, metadata):
            continue
        key = _message_fixture_call_key(row, metadata)
        if key is None:
            continue
        incumbent = latest.get(key)
        if incumbent is None or (_row_timestamp_ms(row) or 0) > (_row_timestamp_ms(messages[incumbent]) or 0):
            latest[key] = index
    return latest


def _message_fixture_is_preliminary_result(
    tool_name: str,
    metadata: JsonObject,
    content: str,
) -> bool:
    """Reject lifecycle acknowledgements mislabeled as terminal tool results."""

    if tool_name in _MESSAGE_FIXTURE_UI_ONLY_TOOLS:
        return True
    if tool_name == "attempt_completion" and str(metadata.get("title") or "") == "Beginning Execute Phase":
        return True
    action_type = str(metadata.get("action_type") or "").strip().lower()
    if action_type in _MESSAGE_FIXTURE_START_ACTION_TYPES:
        return True
    normalized = " ".join(content.strip().lower().rstrip(".").split())
    return normalized in _MESSAGE_FIXTURE_START_ACKS


def _message_fixture_progress_arguments(row: JsonObject, metadata: JsonObject) -> JsonObject:
    """Recover DAG-created action arguments from its IN_PROGRESS call row."""

    arguments = dict(metadata.get("auxiliary")) if isinstance(metadata.get("auxiliary"), dict) else {}
    agent_type = str(metadata.get("agentType") or "").strip()
    if agent_type:
        arguments.setdefault("type", agent_type)
    goal = str(metadata.get("fullGoal") or row.get("text") or "").strip()
    if goal:
        arguments.setdefault("goal", goal)
    return arguments


def _transitions_from_message_fixture(
    root_agent_id: str,
    redaction_mode: str,
    initial_state: JsonObject,
    *,
    skip_browser_task_ids: set[str],
) -> tuple[list[RoseTransition], bool]:
    """Recover every real terminal tool call from the archived DB fixture.

    Corpus coverage is intentionally broader than runtime interception. The
    model update needs examples for every tool shape found in real trajectories;
    ``is_world_model_environment_boundary`` independently decides which calls a
    simulated run may replace.
    """

    try:
        fixture = read_archive_json(root_agent_id, "db/end.fixture.json.gz.enc")
    except (FileNotFoundError, ValueError):
        return [], False
    rows = fixture.get("rows") if isinstance(fixture.get("rows"), dict) else {}
    raw_messages = rows.get("Message") if isinstance(rows, dict) else []
    if not isinstance(raw_messages, list):
        return [], True
    messages = [row for row in raw_messages if isinstance(row, dict)]
    # Stable timestamp sorting matches helpers.llm: equal timestamps preserve
    # fixture order, and the earlier terminal wins a tie.
    messages.sort(key=lambda row: _row_timestamp_ms(row) or 0)
    latest_terminal_indices = _latest_message_fixture_terminal_indices(messages)

    action_args: dict[tuple[str, str], JsonObject] = {}
    declared_action_keys: set[tuple[str, str]] = set()
    # Real measured start clocks per call: the tool's own first IN_PROGRESS row,
    # otherwise the ASSISTANT row that issued the call. The terminal row's clock
    # is the completion, so the pair is the call's actual time-to-complete.
    progress_started_ms: dict[tuple[str, str], int] = {}
    declared_started_ms: dict[tuple[str, str], int] = {}
    for row in messages:
        if str(row.get("role") or "").upper() != "ASSISTANT":
            continue
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        tool_calls = metadata.get("tool_calls") if isinstance(metadata.get("tool_calls"), list) else []
        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            call_id = str(call.get("tool_call_id") or call.get("id") or "")
            if not call_id:
                continue
            call_key = (str(row.get("agentId") or ""), call_id)
            declared_action_keys.add(call_key)
            action_args[call_key] = _assistant_tool_arguments(call)
            declared_ms = _row_timestamp_ms(row)
            if declared_ms is not None:
                declared_started_ms[call_key] = min(declared_ms, declared_started_ms.get(call_key, declared_ms))

    # Planned DAG calls do not have an ASSISTANT tool_use row. Their
    # IN_PROGRESS row is the action declaration the parent actually executed;
    # use it to pair the later terminal result and recover its delegated goal.
    for row in messages:
        if str(row.get("role") or "").upper() != "TOOL":
            continue
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        if (
            str(metadata.get("toolStatus") or "").upper() != "IN_PROGRESS"
            or metadata.get("world_model_simulated") is True
            or bool(metadata.get("excludeFromModel"))
            or is_internal_subagent_message(row)
        ):
            continue
        call_key = _message_fixture_call_key(row, metadata)
        if call_key is None:
            continue
        tool_name = _canonical_message_tool_name(str(metadata.get("toolName") or ""), metadata, {})
        if not tool_name or tool_name in _MESSAGE_FIXTURE_UI_ONLY_TOOLS:
            continue
        declared_action_keys.add(call_key)
        action_args.setdefault(call_key, _message_fixture_progress_arguments(row, metadata))
        progress_ms = _row_timestamp_ms(row)
        if progress_ms is not None:
            progress_started_ms[call_key] = min(progress_ms, progress_started_ms.get(call_key, progress_ms))

    retrieval_state = _retrieval_state_from_initial_state(initial_state)
    root_goal = str(initial_state.get("root_goal") or "")
    previous_browser_states: dict[str, JsonObject] = {}
    last_observations: dict[tuple[str, str], str] = {}
    transitions: list[RoseTransition] = []
    for message_index, row in enumerate(messages):
        if str(row.get("role") or "").upper() != "TOOL":
            continue
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        tool_status = str(metadata.get("toolStatus") or "").upper()
        if tool_status not in _TERMINAL_TOOL_STATUSES:
            continue
        if metadata.get("world_model_simulated") is True or bool(metadata.get("excludeFromModel")):
            continue
        tool_name = str(metadata.get("toolName") or "")
        tool_call_id = str(metadata.get("toolCallId") or "")
        title = str(metadata.get("title") or "").strip()
        # Prisma's Message payload column is ``text``. Older synthetic fixtures
        # used message/content, so retain those as compatibility fallbacks.
        message = str(row.get("text") or row.get("message") or row.get("content") or "").strip()
        timestamp_ms = _row_timestamp_ms(row)

        # Unified spawn_agent rows retain the public tool name in Message but
        # identify their concrete delegation class in agentType/arguments.
        call_key = _message_fixture_call_key(row, metadata)
        args = action_args.get(call_key or ("", "")) or (
            dict(metadata.get("auxiliary")) if isinstance(metadata.get("auxiliary"), dict) else {}
        )
        tool_name = _canonical_message_tool_name(tool_name, metadata, args)

        if tool_name in _BROWSER_ORCHESTRATION_TOOLS:
            action_type = str(metadata.get("action_type") or "").strip()
            task_id = str(metadata.get("task_id") or metadata.get("subAgentId") or "")
            # A unified browser result with no browser action is a useful
            # whole-subagent training observation. Legacy manager lifecycle
            # rows (including task_complete) stay out of the corpus so they do
            # not double-count the richer per-action browser extraction.
            if not action_type or action_type == "task_complete":
                pass
            elif (
                action_type in _BROWSER_NON_ACTION_EVENTS
                or action_type.startswith(("agentcard_", "purchase_"))
                or task_id in skip_browser_task_ids
            ):
                continue
            else:
                previous_state = previous_browser_states.get(task_id, {})
                next_state = _browser_state_from_message(title, message, action_type)
                action_args = {
                    "goal": root_goal,
                    "action": action_type,
                    "params": _browser_params_from_message(metadata, title),
                    "thinking": "",
                    "current_browser_state": previous_state,
                    "approval": {"granted": False, "type": None, "payment_card_last4": None},
                }
                state_before = dict(retrieval_state)
                if previous_state:
                    state_before["browser_state"] = previous_state
                result_payload = {
                    "browser_state": next_state,
                    "action_result": {"success": not bool(metadata.get("error")), "message": message},
                }
                transitions.append(
                    RoseTransition(
                        state_before=_maybe_redact(state_before, redaction_mode),
                        scratchpad="",
                        action=CanonicalAction(
                            category="browser",
                            name="browser_action",
                            arguments=_maybe_redact(action_args, redaction_mode),
                            agent_id=str(row.get("agentId") or root_agent_id),
                            tool_call_id=tool_call_id,
                            artifact_refs=["db/end.fixture.json.gz.enc"],
                            timestamp_ms=timestamp_ms,
                        ),
                        observation=CanonicalObservation(
                            category="browser_state",
                            content=json.dumps(
                                _maybe_redact(result_payload, redaction_mode),
                                ensure_ascii=False,
                                sort_keys=True,
                            ),
                            is_error=bool(metadata.get("error")),
                            metadata={
                                "source": "message_fixture",
                                "task_id": task_id,
                                "title": _maybe_redact(title, redaction_mode),
                                "result_unavailable": False,
                            },
                            artifact_refs=["db/end.fixture.json.gz.enc"],
                            timestamp_ms=timestamp_ms,
                        ),
                    )
                )
                previous_browser_states[task_id] = _maybe_redact(next_state, redaction_mode)
                continue

        # Agent contexts expose exactly one result for a tool_use: the latest
        # FINISHED/ERROR row for that agent + toolCallId. Earlier terminal rows
        # are UI/activity dual-writes ("Research started", "Task Started",
        # in-activity completion) rather than additional environment actions.
        if is_internal_subagent_message(row):
            continue
        if call_key is not None and latest_terminal_indices.get(call_key) != message_index:
            continue
        # A terminal DB chip without a corresponding assistant tool_use or DAG
        # IN_PROGRESS declaration was never an action. The agent may show such
        # unmatched workflow context as a user message, but it must not become
        # a fabricated action→observation training pair.
        if not tool_name or call_key is None or call_key not in declared_action_keys:
            continue
        content = message or title or f"{tool_name} {tool_status.lower()}"
        if _message_fixture_is_preliminary_result(tool_name, metadata, content):
            continue
        state_before = dict(retrieval_state)
        observation_key = (str(row.get("agentId") or root_agent_id), tool_name)
        if last_observations.get(observation_key):
            state_before["previous_observation"] = last_observations[observation_key]
        transitions.append(
            RoseTransition(
                state_before=_maybe_redact(state_before, redaction_mode),
                scratchpad="",
                action=CanonicalAction(
                    category=canonical_category_for_tool(tool_name),
                    name=tool_name,
                    arguments=_maybe_redact(args, redaction_mode),
                    agent_id=str(row.get("agentId") or root_agent_id),
                    tool_call_id=tool_call_id,
                    artifact_refs=["db/end.fixture.json.gz.enc"],
                    timestamp_ms=timestamp_ms,
                ),
                observation=CanonicalObservation(
                    category=f"{canonical_category_for_tool(tool_name)}_result",
                    content=str(_maybe_redact(content, redaction_mode)),
                    is_error=tool_status == "ERROR" or bool(metadata.get("error")),
                    metadata={
                        "source": "message_fixture",
                        "title": _maybe_redact(title, redaction_mode),
                        "tool_status": tool_status,
                        "result_unavailable": False,
                    },
                    artifact_refs=["db/end.fixture.json.gz.enc"],
                    timestamp_ms=timestamp_ms,
                    started_at_ms=progress_started_ms.get(call_key, declared_started_ms.get(call_key)),
                ),
            )
        )
        last_observations[observation_key] = content
    return transitions, True


def load_grounded_transitions(
    root_agent_id: str,
    *,
    redaction_mode: str = "public",
) -> list[RoseTransition]:
    """Load all actions paired with real archived terminal observations."""

    initial_state = reconstruct_initial_state(root_agent_id, redaction_mode=redaction_mode)
    explicit = [
        transition
        for transition in _transitions_from_trace_artifact(root_agent_id, redaction_mode)
        if transition.action.category != "llm_tool_call"
        and transition.observation.metadata.get("result_unavailable") is not True
    ]
    browser, grounded_task_ids = _transitions_from_browser_observations(
        root_agent_id,
        redaction_mode,
        initial_state,
    )
    messages, has_end_fixture = _transitions_from_message_fixture(
        root_agent_id,
        redaction_mode,
        initial_state,
        skip_browser_task_ids=grounded_task_ids,
    )
    partial_messages = (
        [] if has_end_fixture else _transitions_from_llm_message_history(root_agent_id, redaction_mode, initial_state)
    )
    # Explicit/provider and rich browser artifacts are more authoritative than
    # their UI Message projection. Keep the projection for every other tool.
    authoritative_call_keys = {
        (transition.action.agent_id, transition.action.tool_call_id)
        for transition in [*explicit, *browser]
        if transition.action.tool_call_id
    }
    messages = [
        transition
        for transition in messages
        if not transition.action.tool_call_id
        or (transition.action.agent_id, transition.action.tool_call_id) not in authoritative_call_keys
    ]
    authoritative_call_keys.update(
        (transition.action.agent_id, transition.action.tool_call_id)
        for transition in messages
        if transition.action.tool_call_id
    )
    partial_messages = [
        transition
        for transition in partial_messages
        if not transition.action.tool_call_id
        or (transition.action.agent_id, transition.action.tool_call_id) not in authoritative_call_keys
    ]
    combined = [*explicit, *browser, *messages, *partial_messages]
    combined.sort(
        key=lambda transition: (
            transition.action.timestamp_ms
            if transition.action.timestamp_ms is not None
            else transition.observation.timestamp_ms
            if transition.observation.timestamp_ms is not None
            else 2**63,
            transition.action.tool_call_id or "",
            transition.action.name,
        )
    )
    return combined


def load_transitions(root_agent_id: str, *, redaction_mode: str = "public") -> list[RoseTransition]:
    initial_state = reconstruct_initial_state(root_agent_id, redaction_mode=redaction_mode)
    transitions = _transitions_from_trace_artifact(root_agent_id, redaction_mode)
    if transitions:
        return transitions
    return _transitions_from_llm_dumps(root_agent_id, redaction_mode, initial_state)


def _span_status(is_error: bool) -> JsonObject:
    return {"code": "STATUS_CODE_ERROR" if is_error else "STATUS_CODE_OK"}


def write_eval_suite(
    output_dir: str | Path,
    *,
    trace_file: str | Path,
    title: str = "Rose archived trajectory replay",
    train_split: float = 0.7,
    sample_turns: str = "all",
    seed: int = 0,
    judge: str = "rubric",
) -> Path:
    """Write a WMH-style eval suite TOML next to an exported trace file."""

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    trace_path = Path(trace_file)
    rel_trace = os.path.relpath(trace_path, out_dir)
    content = "\n".join(
        [
            f'title = "{_toml_escape(title)}"',
            'description = "Open-loop reconstruction fidelity over Rose archived trajectories."',
            f'files = ["{_toml_escape(rel_trace)}"]',
            f"train_split = {train_split}",
            f'sample_turns = "{_toml_escape(sample_turns)}"',
            f"seed = {seed}",
            f'judge = "{_toml_escape(judge)}"',
            "",
        ]
    )
    target = out_dir / "default.toml"
    target.write_text(content, encoding="utf-8")
    return target


def _toml_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def provider_abstraction_decision() -> JsonObject:
    """Document the WMH provider boundary used by Rose integration code."""

    return {
        "schema": "rose.wmh_provider_abstraction.v1",
        "route": os.environ.get("ROSE_WMH_PROVIDER_ROUTE", "upstream"),
        "default": "upstream",
        "upstream_providers": ["anthropic", "bedrock", "azure", "openai", "openai_responses"],
        "rose_role": "trace_provenance_costs_and_attempt_trails",
    }


def _emit_progress(progress: ProgressCallback | None, title: str, status: str, **metadata: Any) -> None:
    event: JsonObject = {
        "title": title,
        "status": status,
        "metadata": {key: value for key, value in metadata.items() if value is not None},
    }
    if progress:
        progress(event)


def _read_delta_index(index_path: Path) -> JsonObject:
    if not index_path.exists():
        return {"schema": "rose.wmh_delta_index.v1", "bundles": {}}
    try:
        value = json.loads(index_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"schema": "rose.wmh_delta_index.v1", "bundles": {}}
    if not isinstance(value, dict):
        return {"schema": "rose.wmh_delta_index.v1", "bundles": {}}
    bundles = value.get("bundles")
    if not isinstance(bundles, dict):
        value["bundles"] = {}
    value.setdefault("schema", "rose.wmh_delta_index.v1")
    return value


def _write_delta_index(index_path: Path, index: JsonObject) -> None:
    index_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = index_path.with_suffix(index_path.suffix + ".tmp")
    tmp.write_text(json.dumps(index, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(index_path)


# Archive reads are latency-bound (~100ms per small R2 object); a corpus build
# touches hundreds of them, so signature/ref reads fan out on a thread pool.
_ARCHIVE_READ_WORKERS = max(1, int(os.environ.get("WMH_ARCHIVE_READ_WORKERS", "16") or "16"))


def _bundle_signature_from_r2_listing(root_agent_id: str) -> JsonObject:
    """Change digest from the listing alone: one paginated request per bundle.

    R2's listing already carries every object's size and ETag, so re-signing a
    6k-bundle corpus no longer costs one metadata GET per artifact (~1M reads,
    ~25 minutes, on every refresh — a mass-search bundle alone has ~5k). A
    ciphertext without its ``.meta.json`` sidecar is retained in the change
    digest but does not invalidate an otherwise readable bundle. If that orphan
    is a fixture needed by export, the normal authenticated read still fails
    closed; unrelated interrupted uploads must not discard valid trajectories.
    """
    entries = _r2_artifact_entries_with_retry(root_agent_id)
    present = {entry["path"] for entry in entries}
    artifacts: list[JsonObject] = []
    ciphertext_bytes = 0
    for entry in entries:
        path = entry["path"]
        if not path.endswith(".enc"):
            continue
        size = int(entry["size"])
        ciphertext_bytes += size
        artifact = {"path": path, "etag": entry["etag"], "ciphertext_bytes": size}
        if f"{path}.meta.json" not in present:
            artifact["metadata_present"] = False
        artifacts.append(artifact)
    digest_source = json.dumps(artifacts, sort_keys=True, separators=(",", ":"))
    return {
        "root_agent_id": root_agent_id,
        "artifact_count": len(artifacts),
        # Plaintext sizes live in the sidecars, which this path deliberately
        # does not read; the figure is informational only.
        "plaintext_bytes": 0,
        "ciphertext_bytes": ciphertext_bytes,
        "sha256": hashlib.sha256(digest_source.encode("utf-8")).hexdigest(),
    }


def _bundle_signature(root_agent_id: str) -> JsonObject:
    if archive_backend_is_r2():
        return _bundle_signature_from_r2_listing(root_agent_id)
    # Archive listings also contain intentionally plaintext public projections
    # (for example manifest.public.json). Only encrypted artifacts participate
    # in this signature and therefore carry the metadata read below.
    paths = [path for path in archive_artifact_paths(root_agent_id) if path.endswith(".enc")]
    artifacts: list[JsonObject] = []
    plaintext_bytes = 0
    ciphertext_bytes = 0

    # Metadata-only reads: the signature is a digest over the sidecar fields, so
    # downloading every ciphertext (screenshots, DB fixtures) was pure waste.
    def _metadata_or_orphan(path: str) -> JsonObject | None:
        try:
            return read_archive_artifact_metadata(root_agent_id=root_agent_id, path=path)
        except ValueError as exc:
            if "Archive metadata missing for" not in str(exc):
                raise
            return None

    if paths:
        with ThreadPoolExecutor(max_workers=min(_ARCHIVE_READ_WORKERS, len(paths))) as pool:
            metadata_by_path = list(pool.map(_metadata_or_orphan, paths))
    else:
        metadata_by_path = []
    for path, metadata in zip(paths, metadata_by_path):
        if metadata is None:
            cipher_bytes = (local_archive_root() / root_agent_id / path).stat().st_size
            ciphertext_bytes += cipher_bytes
            artifacts.append(
                {
                    "path": path,
                    "ciphertext_bytes": cipher_bytes,
                    "metadata_present": False,
                }
            )
            continue
        plain_bytes = int(metadata.get("plaintext_bytes") or 0)
        cipher_bytes = int(metadata.get("ciphertext_bytes") or 0)
        plaintext_bytes += plain_bytes
        ciphertext_bytes += cipher_bytes
        artifacts.append(
            {
                "path": path,
                "plaintext_sha256": metadata.get("plaintext_sha256"),
                "plaintext_bytes": plain_bytes,
            }
        )
    digest_source = json.dumps(artifacts, sort_keys=True, separators=(",", ":"))
    return {
        "root_agent_id": root_agent_id,
        "artifact_count": len(artifacts),
        "plaintext_bytes": plaintext_bytes,
        "ciphertext_bytes": ciphertext_bytes,
        "sha256": hashlib.sha256(digest_source.encode("utf-8")).hexdigest(),
    }


def _ensure_wmh_importable() -> None:
    if _WMH_REFERENCE_ROOT.exists():
        reference = str(_WMH_REFERENCE_ROOT)
        if reference not in sys.path:
            sys.path.insert(0, reference)


def build_world_model_from_archives(
    root_agent_ids: Iterable[str],
    output_dir: str | Path,
    *,
    name: str = "rose-archive",
    provider: str = "anthropic",
    model: str = "claude-opus-4-8",
    judge_model: str | None = None,
    gepa_budget: int = 10,
    train_split: float = 0.8,
    embed_dim: int = 512,
    upstream_build: Callable[..., Any] | None = None,
    config_factory: Callable[..., Any] | None = None,
    serve_provider: Any | None = None,
    judge_provider: Any | None = None,
    embedder: Any | None = None,
) -> JsonObject:
    """Export archives to OTel JSONL and build a WMH model through upstream WMH."""

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    trace_file = out_dir / "traces.otel.jsonl"
    eligible_bundle_ids: list[str] = []
    excluded_bundles: dict[str, str] = {}
    for root_agent_id in root_agent_ids:
        eligible, reason = bundle_corpus_eligibility(root_agent_id)
        if eligible:
            eligible_bundle_ids.append(root_agent_id)
        else:
            excluded_bundles[root_agent_id] = reason
    if excluded_bundles:
        print(
            f"[WorldModel] Excluded {len(excluded_bundles)} ineligible bundle(s) before corpus build "
            f"(reasons: {sorted(set(reason.split(':', 1)[0] for reason in excluded_bundles.values()))})",
            flush=True,
        )
    with trace_file.open("w", encoding="utf-8") as combined:
        for root_agent_id in eligible_bundle_ids:
            per_trace = out_dir / f"{root_agent_id}.otel.jsonl"
            export_archive_to_otel_jsonl(root_agent_id, per_trace, redaction_mode="public")
            text = per_trace.read_text(encoding="utf-8")
            if text.strip():
                combined.write(text.rstrip() + "\n")
    return build_world_model_from_otel_jsonl(
        trace_file,
        out_dir,
        name=name,
        provider=provider,
        model=model,
        judge_model=judge_model,
        gepa_budget=gepa_budget,
        train_split=train_split,
        embed_dim=embed_dim,
        upstream_build=upstream_build,
        config_factory=config_factory,
        serve_provider=serve_provider,
        judge_provider=judge_provider,
        embedder=embedder,
    )


def build_world_model_from_otel_jsonl(
    trace_file: str | Path,
    output_dir: str | Path,
    *,
    name: str = "rose-archive",
    provider: str = "anthropic",
    model: str = "claude-opus-4-8",
    judge_model: str | None = None,
    gepa_budget: int = 10,
    train_split: float = 0.8,
    embed_dim: int = 512,
    upstream_build: Callable[..., Any] | None = None,
    config_factory: Callable[..., Any] | None = None,
    serve_provider: Any | None = None,
    judge_provider: Any | None = None,
    embedder: Any | None = None,
) -> JsonObject:
    """Build a WMH artifact from OTel JSONL using upstream `wmh.engine.build`.

    Tests can inject `upstream_build` and `config_factory`; production imports the real
    world-model-harness package and lets its GEPA optimizer do prompt evolution.
    """

    _ensure_wmh_importable()
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    model_root = out_dir / "models" / name
    if upstream_build is None or config_factory is None:
        try:
            from wmh.config import HarnessConfig
            from wmh.engine.build import build as real_build
            from wmh.providers.base import EmbedderKind, ProviderKind
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "world-model-harness is not importable; install agents/requirements.txt "
                "or keep .context/reference/world-model-harness with its dependencies available"
            ) from exc
        upstream_build = upstream_build or real_build

        def real_config_factory(**kwargs: Any) -> Any:
            return HarnessConfig.for_build(
                serve_provider=ProviderKind(kwargs["provider"]),
                serve_model=kwargs["model"],
                region=os.environ.get("AWS_REGION"),
                embed_provider=EmbedderKind.HASHING,
                embed_model=None,
                embed_dim=kwargs["embed_dim"],
                gepa_budget=kwargs["gepa_budget"],
                train_split=kwargs["train_split"],
                judge_model=kwargs["judge_model"],
            )

        config_factory = config_factory or real_config_factory

    config = config_factory(
        provider=provider,
        model=model,
        judge_model=judge_model,
        gepa_budget=gepa_budget,
        train_split=train_split,
        embed_dim=embed_dim,
    )
    result = upstream_build(
        config,
        file=str(trace_file),
        root=str(model_root),
        serve_provider=serve_provider,
        judge_provider=judge_provider,
        embedder=embedder,
    )
    index_serialization = (
        normalize_world_model_index_records(model_root) if (model_root / "index" / "steps.jsonl").exists() else None
    )
    metrics = getattr(result, "metrics", None)
    if hasattr(metrics, "model_dump"):
        metrics_value = metrics.model_dump()
    elif isinstance(metrics, dict):
        metrics_value = metrics
    else:
        metrics_value = {}
    manifest: JsonObject = {
        "schema": "rose.wmh_build_manifest.v1",
        "name": name,
        "trace_file": str(Path(trace_file)),
        "model_root": str(model_root),
        "gepa_budget": gepa_budget,
        "train_split": train_split,
        "provider": provider,
        "model": model,
        "provider_abstraction": provider_abstraction_decision(),
        "metrics": metrics_value,
        "index_serialization": index_serialization,
    }
    manifest_path = out_dir / "build.manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    manifest["manifest_path"] = str(manifest_path)
    return manifest


def refresh_world_model_index(
    trace_file: str | Path,
    model_root: str | Path,
    *,
    embed_dim: int = 512,
) -> JsonObject:
    """Re-index the serving retriever from the aggregate trace file, keeping the built prompt.

    This is the cheap half of a WMH build: ingest + embed (offline HashingEmbedder, no LLM
    calls) + persist the retrieval index. The GEPA-optimized env prompt, config, and metrics
    under `model_root` are left untouched, so new gold traces become retrievable demos without
    paying for prompt re-evolution.
    """

    _ensure_wmh_importable()
    try:
        import numpy as np
        from wmh.core.render import encode_state_action

        # These parser helpers preserve upstream's exact OTel span -> Step mapping while consuming
        # Rose's ordered JSONL one transition at a time. OtelGenAIAdapter.from_file reads the
        # complete corpus into memory, and even one archived trace can contain hundreds of MiB.
        from wmh.ingest.otel_genai import (
            _build_steps,
            _collect_spans,
            _is_llm_span,
            _is_tool_span,
        )
        from wmh.retrieval import HashingEmbedder
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "world-model-harness is not importable; install agents/requirements.txt "
            "or keep .context/reference/world-model-harness with its dependencies available"
        ) from exc

    # Bounded batches keep memory flat (one batch of transitions plus its
    # embeddings in flight) while amortising per-call overhead; the previous
    # default of 1 spent 11 min on 132k steps (2026-09-09).
    batch_size = int(os.environ.get("WMH_INDEX_BATCH_SIZE", "256") or "256")
    if batch_size <= 0:
        raise ValueError(f"WMH_INDEX_BATCH_SIZE must be positive, got {batch_size}")
    # HashingEmbedder is pure Python (~4.6 ms per step, ~10 min for 132k steps on
    # one core) and deterministic, so batches embed in forked workers and are
    # written back in submission order; the result is byte-identical to the
    # in-process path. WMH_EMBED_WORKERS=1 keeps everything in this process.
    embed_workers = max(1, int(os.environ.get("WMH_EMBED_WORKERS") or (os.cpu_count() or 4)))

    trace_path = Path(trace_file)

    def iter_step_events():
        """Yield ``(trace_id, step-or-None)`` without materializing a trace or corpus.

        The ``None`` event marks the start of each contiguous trace so zero-step traces are still
        counted. Rose exports ordered action/tool-observation pairs, which lets upstream's
        ``_build_steps`` normalize one transition at a time instead of retaining every span in a
        potentially huge trace.
        """
        current_trace_id: str | None = None
        pending_spans = []
        with trace_path.open("r", encoding="utf-8") as source:
            for line in source:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    parsed_spans = _collect_spans(json.loads(stripped))
                except json.JSONDecodeError:
                    # Match upstream's JSONL behavior: a truncated/corrupt line is skipped while
                    # every complete line remains usable.
                    continue
                for span in parsed_spans:
                    if current_trace_id is not None and span.trace_id != current_trace_id:
                        for step in _build_steps(pending_spans):
                            yield current_trace_id, step
                        pending_spans = []
                        current_trace_id = None
                    if current_trace_id is None:
                        current_trace_id = span.trace_id
                        yield current_trace_id, None

                    if _is_llm_span(span):
                        # A second LLM action means the prior one had no tool observation.
                        for step in _build_steps(pending_spans):
                            yield current_trace_id, step
                        pending_spans = [span]
                    elif _is_tool_span(span):
                        pending_spans.append(span)
                        for step in _build_steps(pending_spans):
                            yield current_trace_id, step
                        pending_spans = []
        if current_trace_id is not None:
            for step in _build_steps(pending_spans):
                yield current_trace_id, step

    # Count in a bounded first pass so the final .npy can be opened as a disk-backed array with
    # its correct header. The second pass only retains one transition and one embedding batch.
    indexed_traces = 0
    indexed_steps = 0
    for _trace_id, step in iter_step_events():
        if step is None:
            indexed_traces += 1
        else:
            indexed_steps += 1

    index_path = Path(model_root) / "index"
    index_path.mkdir(parents=True, exist_ok=True)
    embedder = HashingEmbedder(dim=embed_dim)
    peak_batch_steps = 0

    import tempfile

    embed_pool = _export_executor(embed_workers, embed_workers) if embed_workers > 1 else None
    with tempfile.TemporaryDirectory(prefix="index-refresh-", dir=str(index_path.parent)) as tmp:
        tmp_path = Path(tmp)
        tmp_matrix_path = tmp_path / "embeddings.npy"
        tmp_steps_path = tmp_path / "steps.jsonl"
        if indexed_steps:
            matrix = np.lib.format.open_memmap(
                tmp_matrix_path,
                mode="w+",
                dtype=np.float64,
                shape=(indexed_steps, embed_dim),
            )
        else:
            matrix = None
            np.save(tmp_matrix_path, np.empty((0, 0), dtype=np.float64))

        row = 0
        inflight: deque[tuple[Any, list[str]]] = deque()
        with tmp_steps_path.open("w", encoding="utf-8") as steps_output:
            steps = []

            def flush_oldest() -> None:
                nonlocal row
                pending, lines = inflight.popleft()
                vectors = np.asarray(pending.result() if hasattr(pending, "result") else pending, dtype=np.float64)
                expected_shape = (len(lines), embed_dim)
                if vectors.shape != expected_shape:
                    raise ValueError(f"embedder returned shape {vectors.shape}, expected {expected_shape}")
                assert matrix is not None
                matrix[row : row + len(lines)] = vectors
                for line in lines:
                    steps_output.write(line + "\n")
                row += len(lines)

            def write_batch() -> None:
                nonlocal peak_batch_steps
                if not steps:
                    return
                peak_batch_steps = max(peak_batch_steps, len(steps))
                texts = [encode_state_action(step.state_before, step.action) for step in steps]
                lines = [jsonl_line(step.model_dump_json()) for step in steps]
                if embed_pool is None:
                    inflight.append((embedder.embed(texts), lines))
                else:
                    inflight.append((embed_pool.submit(_embed_texts, embed_dim, texts), lines))
                steps.clear()
                # Bound the in-flight work so memory stays flat on a large corpus.
                while len(inflight) > 2 * embed_workers:
                    flush_oldest()

            for _trace_id, step in iter_step_events():
                if step is not None:
                    steps.append(step)
                    if len(steps) >= batch_size:
                        write_batch()
            write_batch()
            while inflight:
                flush_oldest()
        if embed_pool is not None:
            embed_pool.shutdown()

        if row != indexed_steps:
            raise RuntimeError(f"trace corpus changed during index refresh: counted {indexed_steps} steps, wrote {row}")
        if matrix is not None:
            matrix.flush()
            del matrix
        os.replace(tmp_matrix_path, index_path / "embeddings.npy")
        os.replace(tmp_steps_path, index_path / "steps.jsonl")

    return {
        "indexed_traces": indexed_traces,
        "indexed_steps": indexed_steps,
        "index_path": str(index_path),
        "batch_size": batch_size,
        "peak_batch_steps": peak_batch_steps,
    }


def transitions_to_otel_spans(
    root_agent_id: str,
    transitions: Iterable[RoseTransition],
    *,
    task: str | None = None,
    metadata: JsonObject | None = None,
) -> list[JsonObject]:
    trace_id = _stable_hex(root_agent_id, 32)
    trace_metadata = {
        "schema": "rose.wmh_trace_metadata.v1",
        "root_agent_id": root_agent_id,
        **(metadata or {}),
    }
    if task:
        trace_metadata["task"] = task

    spans: list[JsonObject] = []
    next_pair_start = 0
    for index, transition in enumerate(transitions):
        action_id = _stable_hex(f"{root_agent_id}:{index}:action:{transition.action.tool_call_id}", 16)
        obs_id = _stable_hex(f"{root_agent_id}:{index}:observation:{transition.action.tool_call_id}", 16)
        base_ms = (
            transition.action.timestamp_ms
            if transition.action.timestamp_ms is not None
            else transition.observation.timestamp_ms
        )
        # Native ingestion sorts by start time and pairs consecutive action/result
        # spans. Reserve disjoint intervals even for equal or regressing archive
        # clocks; original timestamps remain in the canonical payloads.
        pair_start = max(int(_timestamp_nano(base_ms, 0)), next_pair_start)
        next_pair_start = pair_start + 4
        action_attrs = [
            _otel_attr("gen_ai.operation.name", "chat"),
            _otel_attr("gen_ai.tool.name", transition.action.to_wmh_tool_name()),
            _otel_attr("gen_ai.tool.call.arguments", transition.action.to_arguments()),
            _otel_attr("gen_ai.prompt", task or ""),
            _otel_attr("wmh.state.structured", transition.state_before),
            _otel_attr("wmh.state.scratchpad", transition.scratchpad),
            _otel_attr("wmh.trace.metadata", trace_metadata),
            _otel_attr("rose.root_agent_id", root_agent_id),
        ]
        obs_attrs = [
            _otel_attr("gen_ai.operation.name", "execute_tool"),
            _otel_attr("gen_ai.tool.name", transition.action.to_wmh_tool_name()),
            _otel_attr("gen_ai.tool.output", transition.observation.to_output_text()),
            _otel_attr("wmh.trace.metadata", trace_metadata),
            _otel_attr("rose.root_agent_id", root_agent_id),
        ]
        if transition.observation.elapsed_ms is not None:
            # Span clocks below are ordinal pairing slots; the real measured
            # interval travels as explicit attributes through native ingestion.
            obs_attrs.append(_otel_attr("rose.tool.started_at_ms", transition.observation.started_at_ms))
            obs_attrs.append(_otel_attr("rose.tool.completed_at_ms", transition.observation.timestamp_ms))
        if transition.action.agent_id:
            action_attrs.append(_otel_attr("rose.agent_id", transition.action.agent_id))
            obs_attrs.append(_otel_attr("rose.agent_id", transition.action.agent_id))
        if transition.action.span_id:
            action_attrs.append(_otel_attr("rose.span_id", transition.action.span_id))
        if transition.action.tool_call_id:
            action_attrs.append(_otel_attr("rose.tool_call_id", transition.action.tool_call_id))
            obs_attrs.append(_otel_attr("rose.tool_call_id", transition.action.tool_call_id))
        spans.append(
            {
                "traceId": trace_id,
                "spanId": action_id,
                "name": f"chat {transition.action.to_wmh_tool_name()}",
                "startTimeUnixNano": str(pair_start),
                "endTimeUnixNano": str(pair_start + 1),
                "attributes": action_attrs,
                "status": _span_status(False),
            }
        )
        spans.append(
            {
                "traceId": trace_id,
                "spanId": obs_id,
                "parentSpanId": action_id,
                "name": f"execute_tool {transition.action.to_wmh_tool_name()}",
                "startTimeUnixNano": str(pair_start + 2),
                "endTimeUnixNano": str(pair_start + 3),
                "attributes": obs_attrs,
                "status": _span_status(transition.observation.is_error),
            }
        )
    return spans


def export_archive_to_otel_jsonl(
    root_agent_id: str,
    output_path: str | Path,
    *,
    task: str | None = None,
    benchmark_task_name: str | None = None,
    redaction_mode: str = "public",
    max_transitions: int = 0,
    transitions: list[RoseTransition] | None = None,
) -> Path:
    manifest: JsonObject = {}
    try:
        manifest = read_archive_json(root_agent_id, "manifest.json.gz.enc")
    except FileNotFoundError:
        pass
    run = manifest.get("run") if isinstance(manifest.get("run"), dict) else {}
    task_name = benchmark_task_name or manifest.get("benchmark_task_name")
    root_goal = task or run.get("root_goal") or task_name
    if transitions is None:
        transitions = load_grounded_transitions(root_agent_id, redaction_mode=redaction_mode)
    if max_transitions > 0 and len(transitions) > max_transitions:
        # Keep the run's opening trajectory: the earliest steps carry the
        # planning context that later steps only repeat (mass search loops).
        transitions = transitions[:max_transitions]
    # Trace metadata is repeated on every span, so it must stay small: the
    # full artifact path list (~5k entries on a mass-search bundle) made each
    # span ~400 KB and one bundle's OTel 246 MB. Artifact refs live in the
    # sessions and the archive listing, not here.
    spans = transitions_to_otel_spans(
        root_agent_id,
        transitions,
        # Public corpora redact the goal like every argument and observation.
        task=str(_maybe_redact(str(root_goal or ""), redaction_mode)),
        metadata={
            "benchmark_task_name": task_name,
            "db_start_fixture_ref": _fixture_ref(root_agent_id, "db/start.fixture.json.gz.enc"),
            "db_end_fixture_ref": _fixture_ref(root_agent_id, "db/end.fixture.json.gz.enc"),
        },
    )
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        "\n".join(jsonl_line(json.dumps(span, ensure_ascii=False, sort_keys=True)) for span in spans) + "\n",
        encoding="utf-8",
    )
    return out


def _otel_attribute_map(span: JsonObject) -> JsonObject:
    decoded: JsonObject = {}
    attributes = span.get("attributes") if isinstance(span.get("attributes"), list) else []
    for attribute in attributes:
        if not isinstance(attribute, dict) or not isinstance(attribute.get("key"), str):
            continue
        wrapped = attribute.get("value") if isinstance(attribute.get("value"), dict) else {}
        value: Any = None
        for key in ("stringValue", "intValue", "doubleValue", "boolValue"):
            if key in wrapped:
                value = wrapped[key]
                break
        decoded[attribute["key"]] = value
    return decoded


def _json_object_from_otel(value: Any, *, field: str, line_number: int) -> JsonObject:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError(f"line {line_number}: {field} is not JSON: {exc.msg}") from exc
        if isinstance(decoded, dict):
            return decoded
    raise ValueError(f"line {line_number}: {field} is not an object")


def _iter_canonical_otel_examples(trace_file: str | Path) -> Iterator[tuple[JsonObject | None, str | None]]:
    """Stream validated Rose action/observation pairs from the exported OTel."""

    pending: dict[tuple[str, str], tuple[JsonObject, int]] = {}
    with Path(trace_file).open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            try:
                span = json.loads(line)
            except json.JSONDecodeError as exc:
                yield None, f"line {line_number}: invalid span JSON: {exc.msg}"
                continue
            if not isinstance(span, dict):
                yield None, f"line {line_number}: span is not an object"
                continue
            trace_id = str(span.get("traceId") or "")
            span_id = str(span.get("spanId") or "")
            parent_span_id = str(span.get("parentSpanId") or "")
            name = str(span.get("name") or "")
            attributes = _otel_attribute_map(span)
            if name.startswith("chat "):
                if not trace_id or not span_id:
                    yield None, f"line {line_number}: action span is missing traceId/spanId"
                    continue
                pending[(trace_id, span_id)] = (attributes, line_number)
                continue
            if not name.startswith("execute_tool "):
                continue
            pending_action = pending.pop((trace_id, parent_span_id), None)
            if pending_action is None:
                yield None, f"line {line_number}: observation has no matching action span"
                continue
            action_attributes, action_line = pending_action
            try:
                action = _json_object_from_otel(
                    action_attributes.get("gen_ai.tool.call.arguments"),
                    field="gen_ai.tool.call.arguments",
                    line_number=action_line,
                )
                observation = _json_object_from_otel(
                    attributes.get("gen_ai.tool.output"),
                    field="gen_ai.tool.output",
                    line_number=line_number,
                )
                raw_state = action_attributes.get("wmh.state.structured")
                state_before = (
                    _json_object_from_otel(
                        raw_state,
                        field="wmh.state.structured",
                        line_number=action_line,
                    )
                    if raw_state is not None
                    else {}
                )
                if action.get("schema") != "rose.canonical_action.v1":
                    raise ValueError(f"line {action_line}: unknown action schema {action.get('schema')!r}")
                if observation.get("schema") != "rose.canonical_observation.v1":
                    raise ValueError(f"line {line_number}: unknown observation schema {observation.get('schema')!r}")
                if not isinstance(action.get("name"), str) or not action["name"]:
                    raise ValueError(f"line {action_line}: action name is empty")
                if not isinstance(action.get("arguments"), dict):
                    raise ValueError(f"line {action_line}: action arguments are not an object")
                if not isinstance(observation.get("content"), str):
                    raise ValueError(f"line {line_number}: observation content is not text")
                metadata = observation.get("metadata")
                if not isinstance(metadata, dict):
                    raise ValueError(f"line {line_number}: observation metadata is not an object")
                if metadata.get("result_unavailable") is True:
                    raise ValueError(f"line {line_number}: observation result is unavailable")
                if metadata.get("world_model_simulated") is True:
                    raise ValueError(f"line {line_number}: simulated observation entered the real corpus")
                root_agent_id = str(
                    attributes.get("rose.root_agent_id") or action_attributes.get("rose.root_agent_id") or ""
                )
                if not root_agent_id:
                    raise ValueError(f"line {line_number}: root trajectory id is missing")
            except ValueError as exc:
                yield None, str(exc)
                continue
            fingerprint = hashlib.sha256(
                json.dumps(
                    {"root_agent_id": root_agent_id, "action": action, "observation": observation},
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest()
            yield (
                {
                    "fingerprint": fingerprint,
                    "root_agent_id": root_agent_id,
                    "tool_name": action["name"],
                    "category": str(action.get("category") or "tool"),
                    "task": str(action_attributes.get("gen_ai.prompt") or ""),
                    "state_before": state_before,
                    "scratchpad": str(action_attributes.get("wmh.state.scratchpad") or ""),
                    "action": action,
                    "observation": observation,
                },
                None,
            )
    for (_trace_id, _span_id), (_, line_number) in pending.items():
        yield None, f"line {line_number}: action has no matching observation span"


def write_world_model_conformance_suite(
    trace_file: str | Path,
    output_path: str | Path,
    *,
    example_count: int = 100,
    min_trajectories: int = 10,
    min_categories: int = 5,
    min_tool_names: int = 10,
) -> JsonObject:
    """Write a deterministic, category-stratified suite of real corpus examples.

    This validates the exact OTel consumed by WMH, not a parallel synthetic
    fixture. The bounded sampler can scan a multi-gigabyte corpus without
    retaining every observation in memory.
    """

    if example_count <= 0:
        raise ValueError("example_count must be positive")
    if min_trajectories <= 0 or min_categories <= 0 or min_tool_names <= 0:
        raise ValueError("conformance coverage minimums must be positive")
    candidate_limit = max(2_000, example_count * 20)
    candidate_heap: list[tuple[int, int, JsonObject]] = []
    best_by_category: dict[str, tuple[int, JsonObject]] = {}
    best_by_tool_name: dict[str, tuple[int, JsonObject]] = {}
    category_counts: dict[str, int] = {}
    tool_name_counts: dict[str, int] = {}
    trajectory_ids: set[str] = set()
    invalid_examples: list[str] = []
    invalid_example_count = 0
    eligible_examples = 0

    for example, invalid in _iter_canonical_otel_examples(trace_file):
        if invalid is not None:
            invalid_example_count += 1
            if len(invalid_examples) < 100:
                invalid_examples.append(invalid)
            continue
        assert example is not None
        eligible_examples += 1
        category = str(example["category"])
        tool_name = str(example["tool_name"])
        trajectory_ids.add(str(example["root_agent_id"]))
        category_counts[category] = category_counts.get(category, 0) + 1
        tool_name_counts[tool_name] = tool_name_counts.get(tool_name, 0) + 1
        priority = int(str(example["fingerprint"]), 16)
        prior_category = best_by_category.get(category)
        if prior_category is None or priority < prior_category[0]:
            best_by_category[category] = (priority, example)
        prior_tool = best_by_tool_name.get(tool_name)
        if prior_tool is None or priority < prior_tool[0]:
            best_by_tool_name[tool_name] = (priority, example)
        heap_item = (-priority, eligible_examples, example)
        if len(candidate_heap) < candidate_limit:
            heapq.heappush(candidate_heap, heap_item)
        elif heap_item[0] > candidate_heap[0][0]:
            heapq.heapreplace(candidate_heap, heap_item)

    candidates_by_fingerprint: dict[str, tuple[int, JsonObject]] = {}
    for priority, example in [*best_by_category.values(), *best_by_tool_name.values()]:
        candidates_by_fingerprint[str(example["fingerprint"])] = (priority, example)
    for negative_priority, _sequence, example in candidate_heap:
        candidates_by_fingerprint.setdefault(
            str(example["fingerprint"]),
            (-negative_priority, example),
        )
    ordered_candidates = [
        example
        for _priority, example in sorted(
            candidates_by_fingerprint.values(),
            key=lambda item: (item[0], str(item[1]["fingerprint"])),
        )
    ]

    selected: list[JsonObject] = []
    selected_fingerprints: set[str] = set()

    def select(example: JsonObject) -> bool:
        fingerprint = str(example["fingerprint"])
        if len(selected) >= example_count or fingerprint in selected_fingerprints:
            return False
        selected.append(example)
        selected_fingerprints.add(fingerprint)
        return True

    for category in sorted(best_by_category):
        select(best_by_category[category][1])
    selected_trajectories = {str(example["root_agent_id"]) for example in selected}
    for example in ordered_candidates:
        root_agent_id = str(example["root_agent_id"])
        if len(selected_trajectories) >= min_trajectories:
            break
        if root_agent_id not in selected_trajectories and select(example):
            selected_trajectories.add(root_agent_id)
    for tool_name in sorted(best_by_tool_name):
        select(best_by_tool_name[tool_name][1])
    for example in ordered_candidates:
        select(example)

    sampled_categories = {str(example["category"]) for example in selected}
    sampled_tool_names = {str(example["tool_name"]) for example in selected}
    status = (
        "passed"
        if len(selected) == example_count
        and invalid_example_count == 0
        and sampled_categories == set(category_counts)
        and len(selected_trajectories) >= min_trajectories
        and len(sampled_categories) >= min_categories
        and len(sampled_tool_names) >= min_tool_names
        else "failed"
    )
    report: JsonObject = {
        "schema": "rose.wmh_conformance_suite.v1",
        "status": status,
        "trace_file": str(Path(trace_file)),
        "requested_examples": example_count,
        "minimum_trajectories": min_trajectories,
        "minimum_categories": min_categories,
        "minimum_tool_names": min_tool_names,
        "eligible_examples": eligible_examples,
        "sampled_examples": len(selected),
        "trajectory_count": len(trajectory_ids),
        "sampled_trajectory_count": len(selected_trajectories),
        "category_count": len(category_counts),
        "sampled_category_count": len(sampled_categories),
        "tool_name_count": len(tool_name_counts),
        "sampled_tool_name_count": len(sampled_tool_names),
        "category_counts": dict(sorted(category_counts.items())),
        "tool_name_counts": dict(sorted(tool_name_counts.items())),
        "invalid_example_count": invalid_example_count,
        "invalid_examples": invalid_examples,
        "examples": selected,
    }
    # Native binding hashes each example's action and observation against the
    # corpus. A broad value pass rewrote non-secret artifact paths and
    # fingerprints (>=32 base64-like characters), so the real case had no
    # matching native record. Keep those exact and fail closed if they carry a
    # secret; the non-binding task/scratchpad/state keep the public redaction.
    examples = report.pop("examples")
    for example in examples:
        for name in ("task", "scratchpad", "state_before"):
            example[name] = _drop_secret_fields(_redact(example[name]))
    if _public_example_secret_violation(examples):
        raise ValueError("WMH conformance suite contains unredacted secret-looking content")
    redacted = _drop_secret_fields(_redact(report))
    if public_json_has_secret(redacted):
        raise ValueError("WMH conformance suite contains unredacted secret-looking content")
    redacted["examples"] = examples
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(redacted, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return redacted


def score_observation_prediction(
    actual: CanonicalObservation,
    predicted: JsonObject,
) -> tuple[float, dict[str, float], str]:
    """Score one predicted observation on WMH fidelity dimensions.

    This is intentionally deterministic and provider-free. When a real WMH model is configured,
    it grades that model's returned observation. When no model is configured, callers should return
    a disabled/not-configured report rather than pretending fidelity was measured.
    """

    predicted = normalize_world_model_observation(predicted, canonical=True)
    schema_validity = 1.0 if isinstance(predicted.get("content"), str) else 0.0
    predicted_content = str(predicted.get("content") or "")
    predicted_metadata = predicted.get("metadata") if isinstance(predicted.get("metadata"), dict) else {}
    if isinstance(predicted.get("artifact_refs"), list):
        predicted_metadata = {**predicted_metadata, "artifact_refs": predicted["artifact_refs"]}
    content_accuracy = _token_f1(actual.content, predicted_content)
    actual_note = actual.metadata.get("state_note")
    predicted_note = predicted_metadata.get("state_note")
    if actual_note is None:
        state_transition = 1.0
    else:
        state_transition = _token_f1(str(actual_note), str(predicted_note or ""))
    predicted_is_error = bool(predicted.get("is_error")) if "is_error" in predicted else False
    error_behavior = 1.0 if predicted_is_error == actual.is_error else 0.0
    artifact_refs = _artifact_ref_score(actual, predicted_content, predicted_metadata)
    dimensions = {
        "schema_validity": schema_validity,
        "content_accuracy": content_accuracy,
        "state_transition_correctness": state_transition,
        "error_behavior": error_behavior,
        "artifact_refs": artifact_refs,
    }
    score = sum(dimensions.values()) / len(dimensions)
    critique = "; ".join(f"{name}={value:.2f}" for name, value in dimensions.items() if value < 1.0)
    return score, dimensions, critique


def _token_f1(actual: str, predicted: str) -> float:
    actual_tokens = _tokens(actual)
    predicted_tokens = _tokens(predicted)
    if not actual_tokens and not predicted_tokens:
        return 1.0
    if not actual_tokens or not predicted_tokens:
        return 0.0
    actual_counts: dict[str, int] = {}
    for token in actual_tokens:
        actual_counts[token] = actual_counts.get(token, 0) + 1
    overlap = 0
    for token in predicted_tokens:
        count = actual_counts.get(token, 0)
        if count > 0:
            overlap += 1
            actual_counts[token] = count - 1
    if overlap == 0:
        return 0.0
    precision = overlap / len(predicted_tokens)
    recall = overlap / len(actual_tokens)
    return 2 * precision * recall / (precision + recall)


def _tokens(value: str) -> list[str]:
    return re.findall(r"[a-z0-9_.$:/-]+", value.lower())


def _artifact_ref_score(actual: CanonicalObservation, predicted_content: str, predicted_metadata: JsonObject) -> float:
    refs = set(actual.artifact_refs)
    for key in ("dom_ref", "screenshot_ref", "recording_ref", "provider_ref", "fixture_ref"):
        value = actual.metadata.get(key)
        if isinstance(value, str):
            refs.add(value)
    if not refs:
        return 1.0
    encoded_prediction = f"{predicted_content}\n{json.dumps(predicted_metadata, ensure_ascii=False, sort_keys=True)}"
    matched = sum(1 for ref in refs if ref in encoded_prediction)
    return matched / len(refs)


async def evaluate_archive_with_world_model(
    root_agent_id: str,
    *,
    world_model_name: str | None = None,
    base_url: str | None = None,
    redaction_mode: str = "public",
) -> JsonObject:
    """Replay an archived trajectory through a WMH server and score predictions.

    Returns a JSON-serializable result that can be stored directly in a benchmark run JSON. If no
    WMH server/model is configured, the result is explicit rather than silently skipped.
    """

    wmh_base_url = base_url or os.environ.get("WMH_BASE_URL") or os.environ.get("WORLD_MODEL_HARNESS_URL")
    model_name = world_model_name or os.environ.get("WMH_MODEL_NAME") or os.environ.get("WORLD_MODEL_NAME")
    enabled = os.environ.get("BENCHMARK_WMH_EVAL", "").strip().lower() in {"1", "true", "yes", "on"}
    if not enabled:
        return {"status": "disabled", "reason": "BENCHMARK_WMH_EVAL is not enabled"}
    if not wmh_base_url or not model_name:
        return {"status": "not_configured", "reason": "WMH_BASE_URL and WMH_MODEL_NAME are required"}

    transitions = load_grounded_transitions(root_agent_id, redaction_mode=redaction_mode)
    if not transitions:
        return {"status": "no_steps", "reason": "archive contains no transitions"}
    initial_state = reconstruct_initial_state(root_agent_id, redaction_mode=redaction_mode)
    client = WMHHttpClient(wmh_base_url)
    session_id = await client.start_session(
        model_name,
        task=str(initial_state.get("root_goal") or ""),
        seed_state={"structured": initial_state, "scratchpad": ""},
    )
    trace_id = _stable_hex(root_agent_id, 32)
    step_scores: list[FidelityStepScore] = []
    for index, transition in enumerate(transitions):
        predicted = await client.step(model_name, session_id, transition.action)
        score, dimensions, critique = score_observation_prediction(transition.observation, predicted)
        step_scores.append(
            FidelityStepScore(
                trace_id=trace_id,
                step_index=index,
                action=transition.action.to_wmh_tool_name(),
                score=score,
                dimensions=dimensions,
                actual=transition.observation.content,
                predicted=str(predicted.get("content") or ""),
                critique=critique,
            )
        )
    mean_score = sum(step.score for step in step_scores) / len(step_scores)
    dimension_means = {
        name: sum(step.dimensions[name] for step in step_scores) / len(step_scores) for name in _FIDELITY_DIMENSIONS
    }
    result: JsonObject = {
        "status": "scored",
        "world_model": model_name,
        "base_url": wmh_base_url,
        "session_id": session_id,
        "mean_score": mean_score,
        "n_steps": len(step_scores),
        "dimensions": dimension_means,
        "steps": [step.to_dict() for step in step_scores],
    }
    if redaction_mode == "public":
        result = _redact(result)
        if public_json_has_secret(result):
            raise ValueError("WMH fidelity result contains unredacted secret-looking content")
    return result


async def evaluate_archives_with_world_model(
    root_agent_ids: Iterable[str] | None = None,
    *,
    world_model_name: str | None = None,
    base_url: str | None = None,
    redaction_mode: str = "public",
) -> JsonObject:
    """Score every requested local archive bundle and return aggregate fidelity."""

    bundle_ids = list(root_agent_ids) if root_agent_ids is not None else list_archive_bundle_ids()
    results: list[JsonObject] = []
    scored: list[JsonObject] = []
    for root_agent_id in bundle_ids:
        result = await evaluate_archive_with_world_model(
            root_agent_id,
            world_model_name=world_model_name,
            base_url=base_url,
            redaction_mode=redaction_mode,
        )
        result = {"root_agent_id": root_agent_id, **result}
        results.append(result)
        if result.get("status") == "scored":
            scored.append(result)
    aggregate: JsonObject = {
        "schema": "rose.wmh_prediction_batch.v1",
        "status": "scored" if scored else "no_scored_bundles",
        "bundle_count": len(bundle_ids),
        "scored_bundle_count": len(scored),
        "mean_score": None,
        "n_steps": sum(int(item.get("n_steps") or 0) for item in scored),
        "results": results,
    }
    if scored:
        total_steps = sum(int(item.get("n_steps") or 0) for item in scored)
        weighted = sum(float(item.get("mean_score") or 0) * int(item.get("n_steps") or 0) for item in scored)
        aggregate["mean_score"] = weighted / total_steps if total_steps > 0 else None
        dimensions: dict[str, float] = {}
        for name in _FIDELITY_DIMENSIONS:
            numerator = 0.0
            for item in scored:
                item_dimensions = item.get("dimensions") if isinstance(item.get("dimensions"), dict) else {}
                numerator += float(item_dimensions.get(name) or 0) * int(item.get("n_steps") or 0)
            dimensions[name] = numerator / total_steps if total_steps > 0 else 0.0
        aggregate["dimensions"] = dimensions
    if redaction_mode == "public":
        aggregate = _redact(aggregate)
        if public_json_has_secret(aggregate):
            raise ValueError("WMH batch fidelity result contains unredacted secret-looking content")
    return aggregate


def deterministic_split(trace_ids: Iterable[str], *, heldout_fraction: float = 0.2) -> dict[str, str]:
    if heldout_fraction <= 0 or heldout_fraction >= 1:
        raise ValueError("heldout_fraction must be between 0 and 1")
    split: dict[str, str] = {}
    for trace_id in sorted(trace_ids):
        digest = hashlib.blake2b(trace_id.encode("utf-8"), digest_size=8).digest()
        fraction = int.from_bytes(digest, "big") / 2**64
        split[trace_id] = "heldout" if fraction >= (1.0 - heldout_fraction) else "train"
    return split


def build_replay_corpus(
    bundle_ids: Iterable[str], output_dir: str | Path, *, heldout_fraction: float = 0.2
) -> JsonObject:
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    bundle_ids = list(bundle_ids)
    split = deterministic_split(bundle_ids, heldout_fraction=heldout_fraction)
    sessions: list[JsonObject] = []
    for root_agent_id in bundle_ids:
        sessions.append(_build_replay_session(root_agent_id, split[root_agent_id]))
    corpus = {"schema": "rose.wmh_replay_corpus.v1", "sessions": sessions}
    (out_dir / "sessions.json").write_text(json.dumps(corpus, indent=2, sort_keys=True), encoding="utf-8")
    return corpus


def _build_replay_session(
    root_agent_id: str, split: str, transitions: list[RoseTransition] | None = None
) -> JsonObject:
    if transitions is None:
        transitions = load_grounded_transitions(root_agent_id, redaction_mode="public")
    state = reconstruct_initial_state(root_agent_id, redaction_mode="public")
    keys = []
    for transition in transitions:
        keys.append(
            {
                "task": state.get("root_goal"),
                "state_summary_hash": hashlib.sha256(
                    json.dumps(transition.state_before, sort_keys=True).encode()
                ).hexdigest(),
                "tool_action": transition.action.to_wmh_tool_name(),
                "arguments_hash": hashlib.sha256(
                    json.dumps(transition.action.arguments, sort_keys=True).encode()
                ).hexdigest(),
                "environment_fixture_hash": (state.get("db_fixture_ref") or {}).get("plaintext_sha256"),
                "provider_domain": transition.observation.metadata.get("provider_domain"),
            }
        )
    return {
        "root_agent_id": root_agent_id,
        "split": split,
        "initial_state": state,
        "transition_count": len(transitions),
        "similarity_keys": keys,
    }


def _export_bundle_worker(job: tuple[str, str, str, str, int]) -> tuple[str, int, str | None]:
    """Export one bundle's OTel spans + replay session; runs in a worker process.

    Returns ``(root_agent_id, steps, failure)``; a failure leaves no partial
    files behind so the bundle is simply excluded from the corpus.
    """
    root_agent_id, otel_path_text, session_path_text, split_name, max_steps_per_bundle = job
    otel_path = Path(otel_path_text)
    session_path = Path(session_path_text)
    attempts = max(1, int(os.environ.get(_WMH_ARCHIVE_RETRY_ATTEMPTS_ENV, "8") or "8"))
    for attempt in range(attempts):
        try:
            with archive_json_memo():
                _prefetch_bundle_fixtures(root_agent_id)
                # The manifest is the cheap archive-wide screen. Historical bundles
                # can carry a stale ``real`` manifest while their authoritative
                # launch snapshot says ``simulate``; reject that mismatch here,
                # before transitions or OTel are created, while reusing the start
                # fixture this export already needs.
                mode = bundle_world_model_mode(root_agent_id)
                if mode not in _REAL_WORLD_MODEL_MODES:
                    for stale in (otel_path, session_path):
                        if stale.exists():
                            stale.unlink()
                    return (
                        root_agent_id,
                        0,
                        "filtered:unknown-mode" if mode == "unknown" else f"filtered:simulated-run:{mode}",
                    )
                transitions = load_grounded_transitions(root_agent_id, redaction_mode="public")
                if not transitions:
                    for stale in (otel_path, session_path):
                        if stale.exists():
                            stale.unlink()
                    return root_agent_id, 0, "filtered:no-completed-results"
                if max_steps_per_bundle > 0:
                    # The session's similarity keys mirror the exported steps
                    # (an uncapped mass-search bundle made a 5 MB session).
                    transitions = transitions[:max_steps_per_bundle]
                export_archive_to_otel_jsonl(
                    root_agent_id,
                    otel_path,
                    redaction_mode="public",
                    max_transitions=max_steps_per_bundle,
                    transitions=transitions,
                )
                # One transition exports two spans (``chat`` action + ``execute_tool``
                # observation) and the retriever indexes one step per pair, so the
                # caps count observation spans.
                with otel_path.open("r", encoding="utf-8") as exported:
                    bundle_steps = sum(
                        1
                        for line in exported
                        if line.strip() and str(json.loads(line).get("name") or "").startswith("execute_tool ")
                    )
                session = _build_replay_session(root_agent_id, split_name, transitions=transitions)
            session_path.write_text(json.dumps(session, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            return root_agent_id, bundle_steps, None
        except Exception as exc:
            for stale in (otel_path, session_path):
                if stale.exists():
                    stale.unlink()
            if attempt + 1 < attempts and _is_transient_archive_error(exc):
                jitter = int(hashlib.sha256(root_agent_id.encode()).hexdigest()[:2], 16) / 255
                time.sleep(min(8.0, 0.25 * (2**attempt)) + jitter)
                continue
            return root_agent_id, 0, f"export-failed:{type(exc).__name__}: {str(exc)[:160]}"
    raise AssertionError("unreachable")


_BUNDLE_FIXTURE_PATHS = ("manifest.json.gz.enc", "db/start.fixture.json.gz.enc", "db/end.fixture.json.gz.enc")


def _prefetch_bundle_fixtures(root_agent_id: str) -> None:
    """Download the bundle's three JSON inputs concurrently into the read memo.

    An export otherwise fetches them one after another (each multi-MB fixture
    is a ~0.5 s stream), and with the memo in place that serial R2 latency —
    not CPU or bandwidth — bounded the forked exporter at ~2.6 bundles/s.
    Missing artifacts are left for the normal readers to report.
    """
    memo = _archive_json_memo.get()
    if memo is None:
        return

    def _read(path: str) -> JsonObject | None:
        try:
            return read_archive_json(root_agent_id, path)
        except FileNotFoundError:
            return None

    with ThreadPoolExecutor(max_workers=len(_BUNDLE_FIXTURE_PATHS)) as pool:
        for path, value in zip(_BUNDLE_FIXTURE_PATHS, pool.map(_read, _BUNDLE_FIXTURE_PATHS)):
            if value is not None:
                memo[(root_agent_id, path)] = value


def _embed_texts(embed_dim: int, texts: list[str]) -> list[list[float]]:
    """Embed one batch in a worker process (HashingEmbedder is deterministic and stateless)."""
    from wmh.retrieval import HashingEmbedder

    return [list(map(float, vector)) for vector in HashingEmbedder(dim=embed_dim).embed(texts)]


def _export_executor(workers: int, jobs: int) -> ProcessPoolExecutor | ThreadPoolExecutor:
    """Forked worker processes (one per core) unless disabled or unavailable.

    ``fork`` keeps in-process test seams (fake archive clients, patched
    readers) visible to the workers; ``WMH_EXPORT_PROCESSES=0`` falls back to
    threads for hosts where forking a threaded process is unsafe.
    """
    size = max(1, min(workers, jobs))
    use_processes = os.environ.get("WMH_EXPORT_PROCESSES", "1") != "0" and size > 1 and hasattr(os, "fork")
    if use_processes:
        return ProcessPoolExecutor(max_workers=size, mp_context=multiprocessing.get_context("fork"))
    return ThreadPoolExecutor(max_workers=size)


def _purge_stale_bundle_exports(
    otel_dir: Path,
    session_dir: Path,
    bundle_ids: Iterable[str],
) -> int:
    """Remove per-bundle staging files that are not members of the final corpus.

    The aggregate and retriever already use ``bundle_ids`` as their allow-list,
    but keeping an export from an older screening policy leaves misleading data
    on disk (and bloats snapshots).  Purge only the two WHM-owned staging
    filename patterns; aggregate/model artifacts are untouched.
    """
    retained = set(bundle_ids)
    purged = 0
    for directory, suffix in (
        (otel_dir, ".otel.jsonl"),
        (session_dir, ".session.json"),
    ):
        for path in directory.glob(f"*{suffix}"):
            if path.name.removesuffix(suffix) not in retained:
                path.unlink()
                purged += 1
    return purged


def update_world_model_for_simulation(
    *,
    output_dir: str | Path | None = None,
    root_agent_ids: Iterable[str] | None = None,
    name: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    judge_model: str | None = None,
    gepa_budget: int | None = None,
    train_split: float = 0.8,
    heldout_fraction: float = 0.2,
    embed_dim: int = 512,
    force: bool = False,
    progress: ProgressCallback | None = None,
    upstream_build: Callable[..., Any] | None = None,
    config_factory: Callable[..., Any] | None = None,
    serve_provider: Any | None = None,
    judge_provider: Any | None = None,
    embedder: Any | None = None,
    index_refresher: Callable[..., JsonObject] | None = None,
    conformance_examples: int | None = None,
    require_conformance: bool | None = None,
) -> JsonObject:
    """Incrementally update the local WMH corpus/model from archived gold bundles.

    The expensive archive reads and OTel/session exports are delta-based. Changed bundles
    trigger an index-only retriever refresh (offline embedding, zero LLM spend); the full
    upstream GEPA build runs only when no prior build manifest exists or `force=True`.
    """

    started = time.time()
    out_dir = Path(output_dir or os.environ.get("WMH_BUILD_DIR") or _DEFAULT_WMH_BUILD_ROOT)
    name = name or os.environ.get("WMH_MODEL_NAME") or os.environ.get("WORLD_MODEL_NAME") or "rose-archive"
    provider = provider or os.environ.get("WMH_BUILD_PROVIDER") or os.environ.get("WMH_PROVIDER") or "anthropic"
    model = model or os.environ.get("WMH_BUILD_MODEL") or os.environ.get("WMH_SERVE_MODEL") or "claude-opus-4-8"
    if gepa_budget is None:
        gepa_budget = int(os.environ.get("WMH_GEPA_BUDGET", "10"))
    if conformance_examples is None:
        conformance_examples = int(os.environ.get("WMH_CONFORMANCE_EXAMPLES", "100") or "100")
    if conformance_examples <= 0:
        raise ValueError("WMH_CONFORMANCE_EXAMPLES must be positive")
    if require_conformance is None:
        require_conformance = os.environ.get("WMH_REQUIRE_CONFORMANCE", "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
    index_path = out_dir / "delta-index.json"
    otel_dir = out_dir / "otel"
    session_dir = out_dir / "sessions"
    aggregate_trace_file = out_dir / "traces.otel.jsonl"
    aggregate_sessions_file = out_dir / "sessions.json"
    conformance_path = out_dir / "conformance.json"

    out_dir.mkdir(parents=True, exist_ok=True)
    otel_dir.mkdir(parents=True, exist_ok=True)
    session_dir.mkdir(parents=True, exist_ok=True)
    _emit_progress(
        progress,
        "World Model Updating",
        "IN_PROGRESS",
        output_dir=str(out_dir),
        archive_backend=os.environ.get("TRACE_ARCHIVE_BACKEND", "local"),
    )

    all_bundle_ids = sorted(list(root_agent_ids) if root_agent_ids is not None else list_archive_bundle_ids())
    index = _read_delta_index(index_path)
    old_bundles = index.get("bundles") if isinstance(index.get("bundles"), dict) else {}
    # Optional operator cap for deliberately scoped diagnostics. Normal builds
    # leave this unset/zero and ingest the complete eligible archive.
    _wmh_max_bundles = int(os.environ.get("WMH_MAX_BUNDLES", "0") or "0")
    # Only gold-eligible bundles enter the corpus (see bundle_corpus_eligibility).
    # Already-indexed bundles are retained first so maintenance never evicts the
    # known-good corpus; screening verdicts persist in the delta index so a
    # refresh only classifies new bundles and stale non-final ones.
    screening_cache = index.get("screening") if isinstance(index.get("screening"), dict) else {}
    if screening_cache and index.get("screening_policy") != _SCREENING_POLICY_VERSION:
        print(
            f"[WorldModel] Screening policy changed ({index.get('screening_policy')!r} -> "
            f"{_SCREENING_POLICY_VERSION!r}); re-screening {len(screening_cache)} cached verdicts",
            flush=True,
        )
        screening_cache = {}
    screening_started = time.time()
    index_before_screening = dict(index)

    def _checkpoint_screening_cache() -> None:
        if not screening_cache:
            return
        index_before_screening["screening"] = screening_cache
        index_before_screening["screening_policy"] = _SCREENING_POLICY_VERSION
        _write_delta_index(index_path, index_before_screening)

    bundle_ids, excluded_bundles, screening_cache_hits = select_corpus_bundles(
        all_bundle_ids,
        old_bundles,
        max_bundles=_wmh_max_bundles,
        cache=screening_cache,
        now_ms=int(time.time() * 1000),
        policy=(os.environ.get("WMH_CORPUS_POLICY") or "gold").strip().lower(),
        checkpoint=_checkpoint_screening_cache,
    )
    excluded_reasons: dict[str, int] = {}
    for reason in excluded_bundles.values():
        key = reason.split(":", 1)[0]
        excluded_reasons[key] = excluded_reasons.get(key, 0) + 1
    _emit_progress(
        progress,
        "World Model Corpus Screening",
        "IN_PROGRESS",
        archive_bundles=len(all_bundle_ids),
        screened=len(bundle_ids) + len(excluded_bundles),
        eligible=len(bundle_ids),
        excluded_reasons=excluded_reasons,
        screening_cache_hits=screening_cache_hits,
        elapsed_ms=int((time.time() - screening_started) * 1000),
    )
    # Checkpoint the verdicts now: an uncapped screen of the archive takes
    # ~17 minutes, and a crash in the signature/export phases below used to
    # discard all of it because the delta index was only written at the end.
    _checkpoint_screening_cache()
    split = deterministic_split(bundle_ids, heldout_fraction=heldout_fraction) if bundle_ids else {}
    changed: list[str] = []
    unchanged: list[str] = []
    signatures: dict[str, JsonObject] = {}
    total_plaintext_bytes = 0
    total_ciphertext_bytes = 0
    total_artifacts = 0

    # Signatures are independent per bundle: compute them concurrently (under
    # R2 each is one listing request; locally a fan-out of sidecar reads) so a
    # corpus of thousands takes a minute, not hours of sequential round trips.
    def _signature_or_failure(root_agent_id: str) -> JsonObject | str:
        try:
            return _bundle_signature(root_agent_id)
        except Exception as exc:
            return f"signature-failed:{type(exc).__name__}: {str(exc)[:160]}"

    if bundle_ids:
        with ThreadPoolExecutor(max_workers=min(_ARCHIVE_READ_WORKERS, len(bundle_ids))) as pool:
            computed = list(pool.map(_signature_or_failure, bundle_ids))
    else:
        computed = []
    signature_failures = {
        root_agent_id: outcome for root_agent_id, outcome in zip(bundle_ids, computed) if isinstance(outcome, str)
    }
    if signature_failures:
        # A ciphertext without its metadata sidecar means an interrupted upload;
        # one such bundle used to abort the whole corpus refresh.
        for root_agent_id, failure in signature_failures.items():
            print(f"[WorldModel] Skipping bundle {root_agent_id}: {failure}", flush=True)
        excluded_bundles.update(signature_failures)
        bundle_ids = [bundle_id for bundle_id in bundle_ids if bundle_id not in signature_failures]
        split = {bundle_id: value for bundle_id, value in split.items() if bundle_id not in signature_failures}
    for root_agent_id, signature in zip(bundle_ids, [outcome for outcome in computed if not isinstance(outcome, str)]):
        signatures[root_agent_id] = signature
        total_plaintext_bytes += int(signature["plaintext_bytes"])
        total_ciphertext_bytes += int(signature["ciphertext_bytes"])
        total_artifacts += int(signature["artifact_count"])
        otel_path = otel_dir / f"{root_agent_id}.otel.jsonl"
        session_path = session_dir / f"{root_agent_id}.session.json"
        previous = old_bundles.get(root_agent_id) if isinstance(old_bundles, dict) else None
        previous_sha = previous.get("sha256") if isinstance(previous, dict) else None
        previous_export_schema = previous.get("export_schema_version") if isinstance(previous, dict) else None
        if (
            force
            or previous_sha != signature["sha256"]
            or previous_export_schema != _WMH_EXPORT_SCHEMA_VERSION
            or not otel_path.exists()
            or not session_path.exists()
        ):
            changed.append(root_agent_id)
        else:
            unchanged.append(root_agent_id)

    _emit_progress(
        progress,
        "World Model RAG Populating",
        "IN_PROGRESS",
        total_traces=len(bundle_ids),
        traces_excluded_non_real=len(excluded_bundles),
        excluded_bundle_modes=sorted(set(excluded_bundles.values())),
        traces_to_update=len(changed),
        traces_unchanged=len(unchanged),
        artifact_count=total_artifacts,
        plaintext_bytes=total_plaintext_bytes,
        ciphertext_bytes=total_ciphertext_bytes,
    )

    exported_spans = 0
    exported_sessions = 0
    # A malformed bundle (no db/start fixture, undecryptable transitions, a
    # manifest that classifies as real but lacks its artifacts) must not abort
    # the whole corpus refresh: the R2 archive holds ~80k bundles of mixed
    # provenance, and one bad bundle in the capped selection previously killed
    # the build for every bench on the box. Skip it, report it, keep it out of
    # the aggregate and the delta index so the next refresh re-evaluates it.
    export_failures: dict[str, str] = {}
    preexport_exclusions: dict[str, str] = {}
    max_steps = int(os.environ.get(_WMH_MAX_STEPS_ENV, "0") or "0")
    max_steps_per_bundle = int(os.environ.get(_WMH_MAX_STEPS_PER_BUNDLE_ENV, "0") or "0")
    cpu_count = os.cpu_count() or 4
    # R2 exports are dominated by fixture download latency and each worker
    # prefetches the three fixtures concurrently. Two workers per vCPU keeps
    # the network busy while preserving explicit WMH_EXPORT_WORKERS control.
    default_export_workers = cpu_count * (2 if archive_backend_is_r2() else 1)
    export_workers = max(1, int(os.environ.get(_WMH_EXPORT_WORKERS_ENV) or default_export_workers))

    # Exports are independent per bundle and CPU-bound (decrypt + gunzip +
    # JSON-parse the start and optional end fixture, then redact), so threads only reached
    # ~1.6 bundles/s on one core under the GIL; forked worker processes use
    # every core. Results are consumed in submission order so the total step
    # cap drops a deterministic tail of candidates, which stay unindexed until
    # a refresh with a higher cap admits them.
    exported_spans += sum(_indexed_step_count(old_bundles, bundle_id) for bundle_id in unchanged)
    exported_by_bundle: dict[str, int] = {}
    dropped_for_step_cap: list[str] = []
    jobs = [
        (
            root_agent_id,
            str(otel_dir / f"{root_agent_id}.otel.jsonl"),
            str(session_dir / f"{root_agent_id}.session.json"),
            split[root_agent_id],
            max_steps_per_bundle,
        )
        for root_agent_id in changed
    ]
    if jobs:
        with _export_executor(export_workers, len(jobs)) as pool:
            futures = [pool.submit(_export_bundle_worker, job) for job in jobs]
            for position, future in enumerate(futures):
                if max_steps > 0 and exported_spans >= max_steps:
                    for pending in futures[position:]:
                        pending.cancel()
                    dropped_for_step_cap.extend(changed[position:])
                    break
                root_agent_id, bundle_steps, failure = future.result()
                if failure:
                    if failure.startswith("filtered:"):
                        reason = failure.removeprefix("filtered:")
                        preexport_exclusions[root_agent_id] = reason
                        screening_cache[root_agent_id] = {
                            "eligible": False,
                            "reason": reason,
                            "checked_at_ms": int(time.time() * 1000),
                        }
                        print(
                            f"[WorldModel] Filtering bundle {root_agent_id} before export: {reason}",
                            flush=True,
                        )
                    else:
                        export_failures[root_agent_id] = failure
                        print(f"[WorldModel] Skipping bundle {root_agent_id}: {failure}", flush=True)
                else:
                    exported_by_bundle[root_agent_id] = bundle_steps
                    exported_spans += bundle_steps
                    exported_sessions += 1
                completed = position + 1
                if completed % export_workers == 0 and completed < len(futures):
                    _emit_progress(
                        progress,
                        "World Model Trace Export",
                        "IN_PROGRESS",
                        updated_traces=len(exported_by_bundle),
                        pending_traces=len(futures) - completed,
                        exported_spans=exported_spans,
                        exported_sessions=exported_sessions,
                        export_failed=len(export_failures),
                    )
    if dropped_for_step_cap:
        for bundle_id in dropped_for_step_cap:
            excluded_bundles[bundle_id] = f"step-cap:{max_steps}"
        print(
            f"[WorldModel] Step cap {max_steps} reached at {exported_spans} steps; "
            f"{len(dropped_for_step_cap)} eligible bundles left unindexed",
            flush=True,
        )
        bundle_ids = [bundle_id for bundle_id in bundle_ids if bundle_id not in set(dropped_for_step_cap)]
        changed = [bundle_id for bundle_id in changed if bundle_id not in set(dropped_for_step_cap)]
    if export_failures:
        excluded_bundles.update(export_failures)
        bundle_ids = [bundle_id for bundle_id in bundle_ids if bundle_id not in export_failures]
        changed = [bundle_id for bundle_id in changed if bundle_id not in export_failures]
    if preexport_exclusions:
        excluded_bundles.update(preexport_exclusions)
        bundle_ids = [bundle_id for bundle_id in bundle_ids if bundle_id not in preexport_exclusions]
        changed = [bundle_id for bundle_id in changed if bundle_id not in preexport_exclusions]

    purged_staging_files = _purge_stale_bundle_exports(otel_dir, session_dir, bundle_ids)

    # Include every exclusion stage in the final waterfall, not only the cheap
    # archive-wide screening reasons computed above.
    excluded_reasons = {}
    for reason in excluded_bundles.values():
        key = reason.split(":", 1)[0]
        excluded_reasons[key] = excluded_reasons.get(key, 0) + 1

    _emit_progress(
        progress,
        "World Model Trace Export",
        "IN_PROGRESS",
        updated_traces=len(changed),
        exported_spans=exported_spans,
        exported_sessions=exported_sessions,
        export_failed=len(export_failures),
        filtered_before_export=len(preexport_exclusions),
    )

    sessions: list[JsonObject] = []
    with aggregate_trace_file.open("w", encoding="utf-8") as combined:
        for root_agent_id in bundle_ids:
            otel_path = otel_dir / f"{root_agent_id}.otel.jsonl"
            if otel_path.exists():
                with otel_path.open("r", encoding="utf-8") as exported:
                    for line in exported:
                        if line.strip():
                            combined.write(line if line.endswith("\n") else line + "\n")
            session_path = session_dir / f"{root_agent_id}.session.json"
            if session_path.exists():
                try:
                    session = json.loads(session_path.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    session = _build_replay_session(root_agent_id, split[root_agent_id])
                if isinstance(session, dict):
                    sessions.append(session)
    aggregate_sessions_file.write_text(
        json.dumps({"schema": "rose.wmh_replay_corpus.v1", "sessions": sessions}, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    aggregate_bytes = aggregate_trace_file.stat().st_size if aggregate_trace_file.exists() else 0
    session_bytes = aggregate_sessions_file.stat().st_size if aggregate_sessions_file.exists() else 0
    conformance = write_world_model_conformance_suite(
        aggregate_trace_file,
        conformance_path,
        example_count=conformance_examples,
    )
    _emit_progress(
        progress,
        "World Model Corpus Conformance",
        "FINISHED" if conformance["status"] == "passed" else "ERROR",
        report_path=str(conformance_path),
        requested_examples=conformance["requested_examples"],
        eligible_examples=conformance["eligible_examples"],
        sampled_examples=conformance["sampled_examples"],
        trajectory_count=conformance["trajectory_count"],
        category_count=conformance["category_count"],
        tool_name_count=conformance["tool_name_count"],
        invalid_example_count=conformance["invalid_example_count"],
    )
    if require_conformance and conformance["status"] != "passed":
        raise RuntimeError(
            "WMH corpus conformance failed: "
            f"requested={conformance_examples}, eligible={conformance['eligible_examples']}, "
            f"sampled={conformance['sampled_examples']}, invalid={conformance['invalid_example_count']}"
        )
    manifest_path = out_dir / "build.manifest.json"
    needs_build = force or not manifest_path.exists()
    native_engine = os.environ.get("WMH_ENGINE") == "experiential"
    if native_engine and manifest_path.exists():
        current_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        needs_build = needs_build or current_manifest.get("engine") != "experiential"
    # A newly ineligible retained bundle (for example a DEMO task admitted by
    # an older screening policy) changes the aggregate even when no surviving
    # bundle needs re-export. Refresh the retriever so removed steps cannot
    # remain live in its on-disk index.
    corpus_membership_changed = set(old_bundles) != set(bundle_ids)
    needs_index_refresh = (bool(changed) or corpus_membership_changed) and not needs_build
    _emit_progress(
        progress,
        "World Model Build",
        "IN_PROGRESS",
        build_required=needs_build,
        index_refresh_required=needs_index_refresh,
        total_traces=len(bundle_ids),
        updated_traces=len(changed),
        aggregate_trace_bytes=aggregate_bytes,
        replay_corpus_bytes=session_bytes,
        model_name=name,
        provider=provider,
        serve_model=model,
        gepa_budget=gepa_budget,
        embed_dim=embed_dim,
    )

    build_manifest: JsonObject
    index_refresh: JsonObject | None = None
    if native_engine:
        from benchmarks.experiential_bridge import build_native

        if needs_build or needs_index_refresh:
            build_native(out_dir, out_dir, name, os.environ.get("WMH_ROSE_POOL", "rose-1-ultra"))
        else:
            # Rebind the refreshed suite against the verified immutable artifact,
            # without reconstructing its dataset or index. Runtime identity checks
            # reject a changed prompt, pool, capability contract or corrupt source.
            build_native(out_dir, out_dir, name, os.environ.get("WMH_ROSE_POOL", "rose-1-ultra"), bind_only=True)
        build_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        build_manifest["build_skipped"] = not (needs_build or needs_index_refresh)
        build_ran = needs_build or needs_index_refresh
        conformance_path = out_dir / "conformance.native.json"
        conformance = json.loads(conformance_path.read_text(encoding="utf-8"))
    elif needs_build:
        build_manifest = build_world_model_from_otel_jsonl(
            aggregate_trace_file,
            out_dir,
            name=name,
            provider=provider,
            model=model,
            judge_model=judge_model,
            gepa_budget=gepa_budget,
            train_split=train_split,
            embed_dim=embed_dim,
            upstream_build=upstream_build,
            config_factory=config_factory,
            serve_provider=serve_provider,
            judge_provider=judge_provider,
            embedder=embedder,
        )
        build_ran = True
    else:
        build_ran = False
        build_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        build_manifest["build_skipped"] = True
        if needs_index_refresh:
            build_manifest["skip_reason"] = "index-only refresh (GEPA runs on first build or force)"
            refresh = index_refresher or refresh_world_model_index
            index_refresh = refresh(
                aggregate_trace_file,
                out_dir / "models" / name,
                embed_dim=embed_dim,
            )
            _emit_progress(
                progress,
                "World Model Index Refresh",
                "IN_PROGRESS",
                **index_refresh,
            )
        else:
            build_manifest["skip_reason"] = "no archive deltas"

    now_ms = int(time.time() * 1000)
    index["updated_at_ms"] = now_ms
    index["model_name"] = name
    index["trace_file"] = str(aggregate_trace_file)
    index["replay_corpus_file"] = str(aggregate_sessions_file)
    index["screening"] = screening_cache
    index["screening_policy"] = _SCREENING_POLICY_VERSION
    index["bundles"] = {
        root_agent_id: {
            **signatures[root_agent_id],
            "export_schema_version": _WMH_EXPORT_SCHEMA_VERSION,
            "split": split[root_agent_id],
            "otel_file": str(otel_dir / f"{root_agent_id}.otel.jsonl"),
            "session_file": str(session_dir / f"{root_agent_id}.session.json"),
            "steps": exported_by_bundle.get(root_agent_id, _indexed_step_count(old_bundles, root_agent_id)),
            "updated_at_ms": now_ms,
        }
        for root_agent_id in bundle_ids
    }
    _write_delta_index(index_path, index)

    elapsed_ms = int((time.time() - started) * 1000)
    result: JsonObject = {
        "schema": "rose.wmh_delta_update.v1",
        "status": "ready",
        "model_name": name,
        "output_dir": str(out_dir),
        "index_path": str(index_path),
        "trace_file": str(aggregate_trace_file),
        "replay_corpus_file": str(aggregate_sessions_file),
        "conformance_path": str(conformance_path),
        "conformance": {
            key: value
            for key, value in conformance.items()
            if key not in {"examples", "category_counts", "tool_name_counts", "invalid_examples"}
        },
        "build_manifest_path": str(manifest_path),
        "total_traces": len(bundle_ids),
        "total_steps": exported_spans,
        "updated_traces": len(changed),
        "unchanged_traces": len(unchanged),
        "export_failed": dict(export_failures),
        "purged_staging_files": purged_staging_files,
        "excluded_bundles": len(excluded_bundles),
        "excluded_reasons": excluded_reasons,
        "screening_cache_hits": screening_cache_hits,
        "artifact_count": total_artifacts,
        "plaintext_bytes": total_plaintext_bytes,
        "ciphertext_bytes": total_ciphertext_bytes,
        "aggregate_trace_bytes": aggregate_bytes,
        "replay_corpus_bytes": session_bytes,
        "build_ran": build_ran,
        "index_refreshed": needs_index_refresh,
        "index_refresh": index_refresh,
        "elapsed_ms": elapsed_ms,
        "build_manifest": build_manifest,
    }
    _emit_progress(
        progress,
        "World Model Ready",
        "FINISHED",
        model_name=name,
        total_traces=len(bundle_ids),
        total_steps=exported_spans,
        updated_traces=len(changed),
        unchanged_traces=len(unchanged),
        aggregate_trace_bytes=aggregate_bytes,
        replay_corpus_bytes=session_bytes,
        conformance_status=conformance["status"],
        conformance_examples=conformance["sampled_examples"],
        build_ran=build_ran,
        elapsed_ms=elapsed_ms,
    )
    return result


def compare_real_vs_world_model_benchmark(
    real_result: JsonObject,
    world_model_result: JsonObject,
    *,
    max_progress_delta: float = 10.0,
    min_fidelity_score: float = 0.0,
) -> JsonObject:
    """Compare one real benchmark task result with its world-model simulated run."""

    real_name = real_result.get("name")
    simulated_name = world_model_result.get("name")
    real_progress = float(real_result.get("progress_score") or 0)
    simulated_progress = float(world_model_result.get("progress_score") or 0)
    progress_delta = abs(real_progress - simulated_progress)
    fidelity = world_model_result.get("world_model_fidelity")
    fidelity_score = 0.0
    if isinstance(fidelity, dict) and fidelity.get("status") == "scored":
        fidelity_score = float(fidelity.get("mean_score") or 0)
    checks = {
        "task_name_match": real_name == simulated_name,
        "pass_outcome_match": bool(real_result.get("passed")) == bool(world_model_result.get("passed")),
        "terminal_status_match": str(real_result.get("status") or "") == str(world_model_result.get("status") or ""),
        "progress_within_delta": progress_delta <= max_progress_delta,
        "fidelity_above_threshold": fidelity_score >= min_fidelity_score,
        "world_model_mode_recorded": bool(
            world_model_result.get("world_model_mode") or world_model_result.get("world_model_fidelity")
        ),
    }
    comparison: JsonObject = {
        "schema": "rose.wmh_benchmark_comparison.v1",
        "task": real_name,
        "comparable": all(checks.values()),
        "checks": checks,
        "progress_delta": progress_delta,
        "fidelity_score": fidelity_score,
        "real_agent_id": real_result.get("agent_id"),
        "world_model_agent_id": world_model_result.get("agent_id"),
    }
    redacted = _redact(comparison)
    if public_json_has_secret(redacted):
        raise ValueError("WMH benchmark comparison contains unredacted secret-looking content")
    return redacted


class WMHHttpClient:
    """Small client for WMH's local HTTP serving API."""

    # WMH transitions can consume Rose's full 590-second provider deadline.
    # Keep transport headroom for provider rotation and response serialization.
    DEFAULT_TIMEOUT_SECONDS = 660.0

    def __init__(self, base_url: str, *, timeout: float | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        configured_timeout = timeout
        if configured_timeout is None:
            configured_timeout = float(os.environ.get("WMH_HTTP_TIMEOUT_SECONDS", str(self.DEFAULT_TIMEOUT_SECONDS)))
        if configured_timeout <= 0:
            raise ValueError("WMH HTTP timeout must be greater than zero")
        self.timeout = configured_timeout

    async def list_world_models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(f"{self.base_url}/world_models")
            response.raise_for_status()
            data = response.json()
        models = data.get("world_models")
        return models if isinstance(models, list) else []

    async def model_identity(self, world_model: str) -> JsonObject:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(f"{self.base_url}/healthz")
            response.raise_for_status()
            data = response.json()
        if data.get("world_model_name") != world_model:
            raise ValueError("Served native world model identity names another model")
        return {key: data.get(key) for key in ("world_model_id", "world_model_manifest_sha256", "execution_identity")}

    async def start_session(
        self, world_model: str, *, task: str | None = None, seed_state: JsonObject | None = None
    ) -> str:
        body: JsonObject = {"task": task, "seed_state": seed_state}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(f"{self.base_url}/world_models/{world_model}/sessions", json=body)
            response.raise_for_status()
            data = response.json()
        session_id = data.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            raise ValueError("WMH session response did not include session_id")
        return session_id

    async def step(self, world_model: str, session_id: str, action: CanonicalAction | JsonObject) -> JsonObject:
        if isinstance(action, CanonicalAction):
            wmh_action = {
                "kind": "tool_call",
                "name": action.to_wmh_tool_name(),
                "arguments": action.to_arguments(),
            }
        else:
            wmh_action = action
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                f"{self.base_url}/world_models/{world_model}/sessions/{session_id}/step",
                json={"action": wmh_action},
            )
            response.raise_for_status()
            data = response.json()
        observation = data.get("observation")
        if not isinstance(observation, dict):
            raise ValueError("WMH step response did not include observation")
        return observation


async def evaluate_world_model_conformance_suite(
    suite_file: str | Path,
    *,
    world_model_name: str,
    base_url: str | None = None,
    output_path: str | Path | None = None,
    concurrency: int = 8,
    min_mean_score: float = 0.7,
    min_content_accuracy: float = 0.25,
    client: Any | None = None,
    execution_policy: str = "upstream",
    runtime_config: dict | None = None,
) -> JsonObject:
    """Replay the static 100-case suite against a served model and score it.

    Each example starts from its archived pre-action state in an independent
    session. That makes this an open-loop prediction test: a preceding model
    mistake cannot contaminate later examples, and examples from the same real
    trajectory can run concurrently.
    """

    if concurrency <= 0:
        raise ValueError("concurrency must be positive")
    for name, value in (
        ("min_mean_score", min_mean_score),
        ("min_content_accuracy", min_content_accuracy),
    ):
        if value < 0 or value > 1:
            raise ValueError(f"{name} must be between 0 and 1")
    payload = json.loads(Path(suite_file).read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("schema") != "rose.wmh_conformance_suite.v1":
        raise ValueError("suite_file is not a Rose WMH conformance suite")
    raw_examples = payload.get("examples")
    if not isinstance(raw_examples, list) or not raw_examples:
        raise ValueError("suite_file contains no examples")
    examples = [example for example in raw_examples if isinstance(example, dict)]
    if len(examples) != len(raw_examples):
        raise ValueError("suite_file contains a non-object example")
    if client is None:
        if not base_url:
            raise ValueError("base_url is required when client is not provided")
        client = WMHHttpClient(base_url)
    bound_identity: JsonObject = {}
    if payload.get("native_world_model_id") or payload.get("native_world_model_manifest_sha256"):
        expected_identity = {
            "world_model_id": payload.get("native_world_model_id"),
            "world_model_manifest_sha256": payload.get("native_world_model_manifest_sha256"),
        }
        if not all(isinstance(value, str) and value for value in expected_identity.values()):
            raise ValueError("Native conformance suite has incomplete artifact identity")
        from benchmarks.wmh_execution_policy import execution_identity

        expected_execution = execution_identity(
            execution_policy, expected_identity["world_model_id"], expected_identity["world_model_manifest_sha256"],
            runtime_config=runtime_config,
        )
        suite_execution = payload.get("native_execution_identity")
        if execution_policy != "upstream" and suite_execution is None:
            raise ValueError("Activated native policy requires an execution-bound conformance suite")
        if suite_execution is not None and suite_execution != expected_execution:
            raise ValueError("Conformance suite execution identity differs from the explicit expectation")
        identity_reader = getattr(client, "model_identity", None)
        expected_identity["execution_identity"] = expected_execution
        if identity_reader is None or await identity_reader(world_model_name) != expected_identity:
            raise ValueError(
                "Served native artifact or execution identity differs from the bound conformance expectation"
            )
        bound_identity = {
            "native_world_model_id": expected_identity["world_model_id"],
            "native_world_model_manifest_sha256": expected_identity["world_model_manifest_sha256"],
            "native_execution_identity": expected_execution,
        }
    semaphore = asyncio.Semaphore(concurrency)

    async def score_example(index: int, example: JsonObject) -> JsonObject:
        action_raw = example.get("action") if isinstance(example.get("action"), dict) else {}
        observation_raw = example.get("observation") if isinstance(example.get("observation"), dict) else {}
        action = CanonicalAction(
            category=str(action_raw.get("category") or "tool"),
            name=str(action_raw.get("name") or ""),
            arguments=dict(action_raw.get("arguments") or {}),
            agent_id=str(action_raw.get("agent_id") or "") or None,
            span_id=str(action_raw.get("span_id") or "") or None,
            tool_call_id=str(action_raw.get("tool_call_id") or "") or None,
            artifact_refs=list(action_raw.get("artifact_refs") or []),
            timestamp_ms=(action_raw.get("timestamp_ms") if isinstance(action_raw.get("timestamp_ms"), int) else None),
        )
        actual = CanonicalObservation(
            category=str(observation_raw.get("category") or "tool_result"),
            content=str(observation_raw.get("content") or ""),
            is_error=bool(observation_raw.get("is_error")),
            metadata=dict(observation_raw.get("metadata") or {}),
            artifact_refs=list(observation_raw.get("artifact_refs") or []),
            timestamp_ms=(
                observation_raw.get("timestamp_ms") if isinstance(observation_raw.get("timestamp_ms"), int) else None
            ),
        )
        if not action.name:
            return {"index": index, "error": "action name is empty", "score": 0.0}
        async with semaphore:
            try:
                session_id = await client.start_session(
                    world_model_name,
                    task=str(example.get("task") or ""),
                    seed_state={
                        "structured": dict(example.get("state_before") or {}),
                        "scratchpad": str(example.get("scratchpad") or ""),
                    },
                )
                predicted = await client.step(world_model_name, session_id, action)
            except Exception as exc:
                return {
                    "index": index,
                    "fingerprint": example.get("fingerprint"),
                    "root_agent_id": example.get("root_agent_id"),
                    "tool_name": example.get("tool_name"),
                    "category": example.get("category"),
                    "error": f"{type(exc).__name__}: {str(exc)[:300]}",
                    "score": 0.0,
                }
        score, dimensions, critique = score_observation_prediction(actual, predicted)
        return {
            "index": index,
            "fingerprint": example.get("fingerprint"),
            "root_agent_id": example.get("root_agent_id"),
            "tool_name": example.get("tool_name"),
            "category": example.get("category"),
            "score": score,
            "dimensions": dimensions,
            "critique": critique,
        }

    scored = await asyncio.gather(*(score_example(index, example) for index, example in enumerate(examples)))
    score_count = len(scored)
    mean_score = sum(float(item.get("score") or 0) for item in scored) / score_count
    dimension_means = {
        dimension: sum(
            float((item.get("dimensions") or {}).get(dimension) or 0)
            for item in scored
            if isinstance(item.get("dimensions"), dict)
        )
        / score_count
        for dimension in _FIDELITY_DIMENSIONS
    }
    errors = [item for item in scored if item.get("error")]
    by_category: JsonObject = {}
    for category in sorted({str(item.get("category") or "tool") for item in scored}):
        category_items = [item for item in scored if str(item.get("category") or "tool") == category]
        by_category[category] = {
            "examples": len(category_items),
            "mean_score": sum(float(item.get("score") or 0) for item in category_items) / len(category_items),
            "content_accuracy": sum(
                float((item.get("dimensions") or {}).get("content_accuracy") or 0) for item in category_items
            )
            / len(category_items),
        }
    expected_count = int(payload.get("requested_examples") or len(examples))
    passed = (
        payload.get("status") == "passed"
        and score_count == expected_count
        and not errors
        and mean_score >= min_mean_score
        and dimension_means["content_accuracy"] >= min_content_accuracy
    )
    report: JsonObject = {
        "schema": "rose.wmh_prediction_conformance.v1",
        **bound_identity,
        "status": "passed" if passed else "failed",
        "world_model": world_model_name,
        "base_url": base_url,
        "suite_file": str(Path(suite_file)),
        "examples": score_count,
        "prediction_errors": len(errors),
        "min_mean_score": min_mean_score,
        "min_content_accuracy": min_content_accuracy,
        "mean_score": mean_score,
        "dimensions": dimension_means,
        "by_category": by_category,
        "results": scored,
    }
    public_report = _drop_secret_fields(_redact(report))
    # These fields came from exact verified expectations, never from arbitrary
    # observation text. Keep their nonsecret digests usable after redaction.
    public_report.update(bound_identity)
    if public_json_has_secret(public_report):
        raise ValueError("WMH prediction conformance report contains unredacted secret-looking content")
    if output_path is not None:
        target = Path(output_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(public_report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return public_report


class WorldModelToolExecutionAdapter:
    """Adapter for WMH simulation at provider/environment boundaries."""

    def __init__(
        self,
        *,
        mode: str = "real",
        client: WMHHttpClient | None = None,
        world_model_name: str | None = None,
        session_id: str | None = None,
        agent_id: str | None = None,
    ) -> None:
        if mode not in {"real", "shadow", "simulate"}:
            raise ValueError("mode must be one of: real, shadow, simulate")
        self.mode = mode
        self.client = client
        self.world_model_name = world_model_name
        self.session_id = session_id
        self.agent_id = agent_id

    def should_simulate(self, tool_name: str) -> bool:
        return self.mode == "simulate" and is_world_model_environment_boundary(tool_name)

    @classmethod
    def from_env(cls, *, agent_id: str | None = None) -> "WorldModelToolExecutionAdapter":
        mode = os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real").strip().lower() or "real"
        base_url = os.environ.get("WMH_BASE_URL") or os.environ.get("WORLD_MODEL_HARNESS_URL")
        model_name = os.environ.get("WMH_MODEL_NAME") or os.environ.get("WORLD_MODEL_NAME")
        session_id = os.environ.get("WMH_SESSION_ID") or os.environ.get("WORLD_MODEL_SESSION_ID")
        client = WMHHttpClient(base_url) if base_url else None
        return cls(
            mode=mode,
            client=client,
            world_model_name=model_name,
            session_id=session_id,
            agent_id=agent_id,
        )

    async def execute(
        self,
        tool_name: str,
        tool_args: JsonObject,
        tool_call_id: str,
        real_executor: ToolExecutor,
        *,
        allow_real_fallback: bool = True,
    ) -> JsonObject:
        if self.mode == "real" or not is_world_model_environment_boundary(tool_name):
            return await real_executor(tool_name, tool_args, tool_call_id)
        if not self.client or not self.world_model_name or not self.session_id:
            raise RuntimeError("WMH simulation requires WMH_BASE_URL, WMH_MODEL_NAME, and WMH_SESSION_ID")
        action = canonical_action_from_tool_call(
            tool_name,
            tool_args,
            tool_call_id,
            agent_id=self.agent_id,
        )
        if self.mode == "simulate":
            started = time.monotonic()
            observation = await self.client.step(self.world_model_name, self.session_id, action)
            wall_elapsed_ms = max(0, int((time.monotonic() - started) * 1000))
            result = world_model_observation_to_tool_result(
                observation,
                simulated=True,
                wall_elapsed_ms=wall_elapsed_ms,
            )
            result.setdefault("world_model_session_id", self.session_id)
            result.setdefault("world_model_name", self.world_model_name)
            result.setdefault("world_model_boundary", tool_name)
            if allow_real_fallback and _wmh_fallback_on_unavailable_enabled() and _wmh_result_unavailable(result):
                real_result = await real_executor(tool_name, tool_args, tool_call_id)
                if isinstance(real_result, dict):
                    real_result.setdefault("world_model_unavailable_fallback", True)
                    real_result.setdefault("world_model_unavailable_observation", observation)
                return real_result
            return result
        real_result = await real_executor(tool_name, tool_args, tool_call_id)
        started = time.monotonic()
        try:
            observation = await self.client.step(self.world_model_name, self.session_id, action)
        except Exception as exc:
            observation = {"error": str(exc)[:300], "is_error": True}
        wall_elapsed_ms = max(0, int((time.monotonic() - started) * 1000))
        if isinstance(real_result, dict):
            real_result.setdefault("world_model_shadow", observation)
            real_result.setdefault("world_model_shadow_wall_elapsed_ms", wall_elapsed_ms)
        return real_result


def _wmh_fallback_on_unavailable_enabled() -> bool:
    return os.environ.get("BENCHMARK_WMH_FALLBACK_ON_UNAVAILABLE", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _wmh_result_unavailable(value: Any) -> bool:
    if isinstance(value, dict):
        metadata = value.get("metadata")
        if isinstance(metadata, dict) and metadata.get("result_unavailable") is True:
            return True
        if value.get("result_unavailable") is True:
            return True
        for key in ("content", "message"):
            content = value.get(key)
            if isinstance(content, str) and content.strip():
                try:
                    parsed = json.loads(content)
                except json.JSONDecodeError:
                    continue
                if _wmh_result_unavailable(parsed):
                    return True
        for key in ("result", "tool_result", "world_model_observation"):
            if _wmh_result_unavailable(value.get(key)):
                return True
    return False


def _coerce_non_negative_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        if value < 0:
            return None
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            parsed = float(stripped)
        except ValueError:
            return None
        if parsed < 0:
            return None
        return int(parsed)
    return None


def predicted_latency_ms_from_observation(observation: JsonObject) -> int | None:
    """Extract the WMH-predicted action duration from common envelope fields."""

    for source in (observation, observation.get("metadata") if isinstance(observation.get("metadata"), dict) else {}):
        for key in ("predicted_latency_ms", "sim_latency_ms", "latency_ms", "duration_ms", "elapsed_ms"):
            coerced = _coerce_non_negative_int(source.get(key))
            if coerced is not None:
                return coerced
    return None


def world_model_observation_to_tool_result(
    observation: JsonObject,
    *,
    simulated: bool,
    wall_elapsed_ms: int | None = None,
) -> JsonObject:
    from helpers.world_model_runtime import world_model_observation_to_tool_result as convert

    return convert(observation, simulated=simulated, wall_elapsed_ms=wall_elapsed_ms)
