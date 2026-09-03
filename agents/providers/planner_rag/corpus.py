"""Corpus extraction: trace-archive bundle -> (goal, successful plan) entry.

Each finalized root bundle carries an encrypted ``manifest.json.gz.enc`` with
``run.root_goal`` / ``run.root_status`` / ``benchmark_result`` and an index of
LLM dumps. The planner's dump (``llm-updates/<dump>-<ts>-planner.json.gz.enc``)
stores the emitted ``PlannerResponse`` JSON in ``output.content``. This module
reads those (read-only) and produces compact ``PlanEntry`` records.
"""

from __future__ import annotations

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, Optional

import structlog

from helpers.trace_archive import (
    decrypt_and_validate_artifact,
    local_archive_root,
    read_archive_artifact,
    use_r2_archive,
)
from providers.planner_rag import store

logger = structlog.get_logger(__name__)

PLANNER_DUMP_SUFFIX = "-planner.json.gz.enc"
SUCCESS_STATUSES = {"COMPLETED"}
REAL_WORLD_MODEL_MODES = {"real", "shadow"}
# Skip reasons that may flip on a later scan (the run was still in flight).
TRANSIENT_SKIP_REASONS = {"no_public_manifest", "not_finalized", "no_llm_traces_recent"}
_RECENT_WINDOW_S = 24 * 3600
_DUMP_TS_RE = re.compile(r"^llm-updates/[0-9a-f]+-(\d+)-planner\.json\.gz\.enc$")
_LEGACY_UPDATE_RE = re.compile(r"^llm-updates/([^/]+)-(\d+)-update\.json\.gz\.enc$")
_SAFE_SEGMENT_RE = re.compile(r"[^A-Za-z0-9_.-]")
_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)\b((?:github\s+)?api[\s_-]?(?:key|token)|access[\s_-]?token|refresh[\s_-]?token|"
    r"authorization|password|passwd|secret|private[\s_-]?key)"
    r"(\s*[:=]\s*)([^\s,;]+)"
)
_BEARER_RE = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{12,}")
_HIGH_CONFIDENCE_SECRET_RE = re.compile(
    r"\b(?:"
    r"gh[pousr]_[A-Za-z0-9]{20,255}|"
    r"github_pat_[A-Za-z0-9_]{20,255}|"
    r"sk-[A-Za-z0-9_-]{20,255}|"
    r"xox[baprs]-[A-Za-z0-9-]{20,255}|"
    r"AKIA[A-Z0-9]{16}|"
    r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
    r")\b"
)


def redact_reference_text(text: str) -> str:
    """Remove credential-shaped values before text enters the derived corpus.

    Trace bundles preserve the original user input. Planner RAG is a separate
    derived surface shared across benchmark runs, so it must never propagate a
    pasted credential from an old goal or planner task into a new LLM request.
    """
    redacted = _SECRET_ASSIGNMENT_RE.sub(lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", text)
    redacted = _BEARER_RE.sub("Bearer [REDACTED]", redacted)
    return _HIGH_CONFIDENCE_SECRET_RE.sub("[REDACTED]", redacted)


@dataclass(frozen=True)
class PlanTask:
    goal: str
    tool_name: str
    depends_on: tuple[str, ...]


@dataclass(frozen=True)
class PlanExemplar:
    title: str
    join: str
    tasks: tuple[PlanTask, ...]


@dataclass(frozen=True)
class PlanEntry:
    root_agent_id: str
    goal: str
    user_id: Optional[str]
    benchmark_task_name: Optional[str]
    root_status: Optional[str]
    passed: Optional[bool]
    created_at: str
    plan: PlanExemplar

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.root_agent_id,
            "goal": self.goal,
            "user_id": self.user_id,
            "task": self.benchmark_task_name,
            "status": self.root_status,
            "passed": self.passed,
            "ts": self.created_at,
            "plan": {
                "title": self.plan.title,
                "join": self.plan.join,
                "tasks": [
                    {"goal": t.goal, "tool_name": t.tool_name, "depends_on": list(t.depends_on)}
                    for t in self.plan.tasks
                ],
            },
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "PlanEntry":
        plan_raw = raw.get("plan") or {}
        tasks = tuple(
            PlanTask(
                goal=redact_reference_text(str(t.get("goal") or "")),
                tool_name=str(t.get("tool_name") or ""),
                depends_on=tuple(str(d) for d in (t.get("depends_on") or [])),
            )
            for t in plan_raw.get("tasks") or []
        )
        return cls(
            root_agent_id=str(raw.get("id") or ""),
            goal=redact_reference_text(str(raw.get("goal") or "")),
            user_id=raw.get("user_id"),
            benchmark_task_name=raw.get("task"),
            root_status=raw.get("status"),
            passed=raw.get("passed"),
            created_at=str(raw.get("ts") or ""),
            plan=PlanExemplar(
                title=redact_reference_text(str(plan_raw.get("title") or "")),
                join=str(plan_raw.get("join") or "all"),
                tasks=tasks,
            ),
        )


def _safe_segment(value: str) -> str:
    return _SAFE_SEGMENT_RE.sub("_", value)[:96] or "unbound"


def read_public_manifest(root_agent_id: str) -> Optional[dict[str, Any]]:
    """Plain (unencrypted) ``manifest.public.json`` for a bundle, or None."""
    safe_id = _safe_segment(root_agent_id)
    if use_r2_archive():
        raw = store.read_bytes(f"trace-archive/{safe_id}/manifest.public.json", backend="r2")
    else:
        path = local_archive_root() / safe_id / "manifest.public.json"
        raw = path.read_bytes() if path.exists() else None
    if raw is None:
        return None
    value = json.loads(raw.decode("utf-8"))
    return value if isinstance(value, dict) else None


def read_encrypted_bundle_json(root_agent_id: str, path: str) -> Optional[dict[str, Any]]:
    stored = read_archive_artifact(root_agent_id=root_agent_id, path=path)
    if stored is None:
        return None
    value = json.loads(decrypt_and_validate_artifact(*stored).decode("utf-8"))
    return value if isinstance(value, dict) else None


def _llm_trace_paths(manifest: dict[str, Any]) -> list[str]:
    sensitive = manifest.get("sensitive") if isinstance(manifest.get("sensitive"), dict) else {}
    refs = sensitive.get("llm_trace_refs")
    if not isinstance(refs, list) or not refs:
        refs = manifest.get("artifacts") if isinstance(manifest.get("artifacts"), list) else []
    return [
        path
        for ref in refs
        if isinstance(ref, dict) and isinstance((path := ref.get("path")), str) and path.startswith("llm")
    ]


def _dump_timestamp(path: str) -> int:
    match = _DUMP_TS_RE.match(path) or _LEGACY_UPDATE_RE.match(path)
    return int(match.group(2) if match and match.lastindex == 2 else match.group(1)) if match else 0


def planner_dump_paths(manifest: dict[str, Any]) -> list[str]:
    """Modern planner LLM dump paths from a manifest, oldest first."""
    paths = [path for path in _llm_trace_paths(manifest) if path.endswith(PLANNER_DUMP_SUFFIX)]
    return sorted(set(paths), key=_dump_timestamp)


def legacy_planner_dump_paths(root_agent_id: str, manifest: dict[str, Any]) -> list[str]:
    """Recover planner updates written before filenames carried the call site.

    Historical updates ended in ``-update``. Their paired ``llm/<dump-id>``
    context is authoritative for the original call site, so schema-shaped
    outputs from other LLM calls cannot be mistaken for planner responses.
    """
    trace_paths = set(_llm_trace_paths(manifest))
    paths: list[str] = []
    for path in trace_paths:
        match = _LEGACY_UPDATE_RE.match(path)
        if match is None:
            continue
        context_path = f"llm/{match.group(1)}.json.gz.enc"
        if context_path not in trace_paths:
            continue
        context = read_encrypted_bundle_json(root_agent_id, context_path)
        if context is not None and context.get("call_site") == "planner":
            paths.append(path)
    return sorted(set(paths), key=_dump_timestamp)


def _parse_plan(dump: dict[str, Any]) -> Optional[PlanExemplar]:
    from utils.tool_schemas import PlannerResponse

    output = dump.get("output")
    content = output.get("content") if isinstance(output, dict) else output
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except json.JSONDecodeError:
            return None
    if not isinstance(content, dict):
        return None
    try:
        parsed = PlannerResponse.model_validate(content)
    except Exception:
        return None
    if not parsed.tasks:
        return None
    return PlanExemplar(
        title=redact_reference_text(parsed.title),
        join=parsed.join,
        tasks=tuple(
            PlanTask(
                goal=redact_reference_text(t.goal),
                tool_name=getattr(t.tool_name, "value", str(t.tool_name)),
                depends_on=tuple(t.depends_on),
            )
            for t in parsed.tasks
        ),
    )


def _generated_at_recent(public_manifest: dict[str, Any]) -> bool:
    raw = public_manifest.get("generated_at")
    if not isinstance(raw, str):
        return False
    from datetime import datetime, timezone

    try:
        generated = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    return (datetime.now(timezone.utc) - generated).total_seconds() < _RECENT_WINDOW_S


def extract_entry(root_agent_id: str) -> tuple[Optional[PlanEntry], str]:
    """Return ``(entry, "ok")`` or ``(None, skip_reason)`` for one bundle. Read-only."""
    public = read_public_manifest(root_agent_id)
    if public is None:
        return None, "no_public_manifest"
    if int(public.get("llm_trace_count") or 0) == 0:
        return None, "no_llm_traces_recent" if _generated_at_recent(public) else "no_llm_traces"

    manifest = read_encrypted_bundle_json(root_agent_id, "manifest.json.gz.enc")
    if manifest is None:
        return None, "no_manifest"
    if manifest.get("finalized") is False:
        return None, "not_finalized"
    mode = str(manifest.get("world_model_mode") or "real").strip().lower()
    if mode not in REAL_WORLD_MODEL_MODES:
        return None, f"simulated:{mode}"

    dump_paths = planner_dump_paths(manifest)
    if not dump_paths:
        dump_paths = legacy_planner_dump_paths(root_agent_id, manifest)
    if not dump_paths:
        return None, "no_planner_dump"

    run = manifest.get("run") if isinstance(manifest.get("run"), dict) else {}
    benchmark = manifest.get("benchmark_result") if isinstance(manifest.get("benchmark_result"), dict) else {}
    status = run.get("root_status")
    passed = benchmark.get("passed") if isinstance(benchmark.get("passed"), bool) else None
    if status not in SUCCESS_STATUSES and passed is not True:
        return None, f"not_successful:{status or 'unknown'}"
    goal = run.get("root_goal")
    if not isinstance(goal, str) or not goal.strip():
        return None, "no_goal"

    # The latest planner dump is the attempt whose plan was accepted (earlier
    # ones failed validation and were retried).
    dump = read_encrypted_bundle_json(root_agent_id, dump_paths[-1])
    if dump is None:
        return None, "planner_dump_missing"
    plan = _parse_plan(dump)
    if plan is None:
        return None, "planner_dump_unparseable"

    task_name = manifest.get("benchmark_task_name")
    return (
        PlanEntry(
            root_agent_id=root_agent_id,
            goal=redact_reference_text(goal.strip()),
            user_id=run.get("user_id") if isinstance(run.get("user_id"), str) else None,
            benchmark_task_name=task_name if isinstance(task_name, str) and task_name else None,
            root_status=status if isinstance(status, str) else None,
            passed=passed,
            created_at=str(run.get("root_created_at") or manifest.get("generated_at") or ""),
            plan=plan,
        ),
        "ok",
    )


ProgressCallback = Callable[[int, int, dict[str, int]], None]


def scan_bundles(
    bundle_ids: list[str],
    *,
    scan_state: dict[str, str],
    concurrency: int = 32,
    progress: Optional[ProgressCallback] = None,
    progress_every: int = 250,
) -> tuple[list[PlanEntry], dict[str, str], dict[str, int]]:
    """Extract entries for bundles not yet in ``scan_state`` (or with a transient reason).

    Returns ``(new_entries, updated_scan_state, reason_counts)``. Bundle reads
    are read-only and run on a thread pool (boto3 clients are thread-safe).
    """
    pending = [
        bundle_id
        for bundle_id in bundle_ids
        if scan_state.get(bundle_id) is None or scan_state.get(bundle_id) in TRANSIENT_SKIP_REASONS
    ]
    updated = dict(scan_state)
    entries: list[PlanEntry] = []
    counts: dict[str, int] = {}
    started = time.perf_counter()

    def _probe(bundle_id: str) -> tuple[str, Optional[PlanEntry], str]:
        try:
            entry, reason = extract_entry(bundle_id)
        except Exception as exc:  # one bad bundle must not sink the build
            logger.warning("planner_rag.scan.bundle_error", root_agent_id=bundle_id, error=str(exc)[:200])
            return bundle_id, None, f"error:{type(exc).__name__}"
        return bundle_id, entry, reason

    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        for done, (bundle_id, entry, reason) in enumerate(pool.map(_probe, pending), start=1):
            updated[bundle_id] = reason
            bucket = reason.split(":", 1)[0]
            counts[bucket] = counts.get(bucket, 0) + 1
            if entry is not None:
                entries.append(entry)
            if progress and (done % progress_every == 0 or done == len(pending)):
                progress(done, len(pending), counts)

    logger.info(
        "planner_rag.scan.complete",
        scanned=len(pending),
        new_entries=len(entries),
        elapsed_s=round(time.perf_counter() - started, 1),
        reasons=counts,
    )
    return entries, updated, counts
