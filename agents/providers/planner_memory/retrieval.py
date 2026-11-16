"""Goal -> memory hits: semantic search, top-k above a similarity cutoff.

Retrieval (chosen by agents/benchmarks/memory_retrieval_bench.py):

1. The backend embeds the goal (voyage-4) and returns visible rows whose
   cosine(query, stored goal vector) >= ``min_similarity``, highest first.
2. Completed runs only, one per distinct goal text, top ``k`` by similarity.
   There is no LLM filter: the cutoff alone decides what is injected.

Hot path (10k agents): one backend search (one embedding call + one
visibility-filtered vector query) and at most ``max_compressions`` compressor
calls for hits without a cached critical path. A Postgres lease elects one
compressor per bundle; concurrent planners skip the R2 read and LLM call.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

import structlog

from providers.planner_memory import client as backend
from providers.planner_memory.compressor import COMPRESSOR_VERSION, compress_transcript
from providers.planner_memory.records import CriticalPath, MemoryHit

logger = structlog.get_logger(__name__)

COMPRESSION_BATCH_TIMEOUT_SECONDS = 15.0


@dataclass(frozen=True)
class RetrievalConfig:
    # Pinned by tests/blackbox/memory_retrieval_bench.blackbox.py (labeled set +
    # real archived trajectories labeled from their executed plans).
    min_similarity: float = 0.70
    k: int = 3
    candidate_limit: int = 20
    max_compressions: int = 3
    passed_only: bool = True

    def with_(self, **overrides: Any) -> "RetrievalConfig":
        return RetrievalConfig(**{**self.__dict__, **overrides})


DEFAULT_CONFIG = RetrievalConfig()


def select_hits(candidates: list[dict[str, Any]], config: RetrievalConfig) -> list[MemoryHit]:
    """Completed runs at or above the cutoff, one hit per unique goal text (prefer compressed, then newest), top k."""
    best: dict[str, MemoryHit] = {}
    for cand in candidates:
        if config.passed_only and not _is_success(cand):
            continue
        similarity = float(cand.get("similarity") or 0.0)
        if similarity < config.min_similarity:
            continue
        cp = (
            _parse_critical_path(cand.get("critical_path"))
            if cand.get("compressor_version") == COMPRESSOR_VERSION
            else None
        )
        hit = MemoryHit(
            id=str(cand.get("id") or ""),
            goal=str(cand.get("goal") or ""),
            benchmark_task_name=cand.get("benchmark_task_name"),
            passed=cand.get("passed"),
            root_status=cand.get("root_status"),
            created_at=cand.get("agent_created_at"),
            similarity=similarity,
            critical_path=cp,
        )
        key = _goal_key(hit.goal)
        incumbent = best.get(key)
        if incumbent is None or _prefer(hit, incumbent):
            best[key] = hit
    hits = sorted(best.values(), key=lambda h: (-h.similarity, h.critical_path is None, h.created_at or ""))
    return hits[: config.k]


def _goal_key(goal: str) -> str:
    return " ".join(goal.lower().split())


def _prefer(candidate: MemoryHit, incumbent: MemoryHit) -> bool:
    if (candidate.critical_path is not None) != (incumbent.critical_path is not None):
        return candidate.critical_path is not None
    if abs(candidate.similarity - incumbent.similarity) > 1e-9:
        return candidate.similarity > incumbent.similarity
    return (candidate.created_at or "") > (incumbent.created_at or "")


def _is_success(candidate: dict[str, Any]) -> bool:
    if candidate.get("passed") is True:
        return True
    if candidate.get("passed") is None and str(candidate.get("root_status") or "").upper() == "COMPLETED":
        return True
    return False


def _parse_critical_path(raw: Any) -> Optional[CriticalPath]:
    if not isinstance(raw, dict):
        return None
    try:
        return CriticalPath.model_validate(raw).clamped()
    except Exception:
        return None


def planner_memory_available() -> bool:
    """Global availability switch (per-agent ``memory_enabled`` still gates each run)."""
    raw = os.environ.get("PLANNER_MEMORY_ENABLED", "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


@dataclass
class MemoryRetrieval:
    query: str
    hits: list[MemoryHit] = field(default_factory=list)
    candidates: int = 0
    compressed: int = 0
    skipped_uncompressed: int = 0
    timing_ms: dict[str, float] = field(default_factory=dict)
    error: Optional[str] = None

    def summary(self) -> dict[str, Any]:
        return {
            "hits": [hit.summary() for hit in self.hits],
            "candidates": self.candidates,
            "compressed": self.compressed,
            "skipped_uncompressed": self.skipped_uncompressed,
            "timing_ms": self.timing_ms,
            "error": self.error,
        }


async def _ensure_critical_path(
    hit: MemoryHit,
    *,
    agent_id: Optional[str],
    user_id: Optional[str],
    llm_auth: Optional[Mapping[str, Any]] = None,
) -> bool:
    """Lease, fill, and store one cache entry. Concurrent non-owners do no expensive work."""
    from providers.planner_memory.transcript import load_bundle_transcript

    if hit.critical_path is not None:
        return True
    claim = await backend.claim_compression(hit.id, compressor_version=COMPRESSOR_VERSION)
    if claim.get("claimed") is not True:
        if claim.get("reason") == "cached" and claim.get("compressor_version") == COMPRESSOR_VERSION:
            cached = _parse_critical_path(claim.get("critical_path"))
            if cached is not None:
                hit.critical_path = cached
                return True
        return False
    lease_id = claim.get("lease_id")
    if not isinstance(lease_id, str) or not lease_id:
        return False
    stored = False
    try:
        transcript = await asyncio.to_thread(load_bundle_transcript, hit.id)
        if transcript is None:
            return False
        if transcript.outcome != "passed":
            # Only completed runs become memories; a row can be marked passed at
            # search time and still carry a failed bundle (e.g. a verdict flip).
            logger.info("planner_memory.skip_failed_transcript", root_agent_id=hit.id, outcome=transcript.outcome)
            return False
        record = await compress_transcript(transcript, agent_id=agent_id, user_id=user_id, llm_auth=llm_auth)
        hit.critical_path = record
        hit.compressed_now = True
        stored = await backend.store_critical_path(
            hit.id,
            record.model_dump(),
            compressor_version=COMPRESSOR_VERSION,
            lease_id=lease_id,
        )
        if not stored:
            logger.warning("planner_memory.store_critical_path.lost_lease", root_agent_id=hit.id)
        return True
    finally:
        if not stored:
            try:
                await backend.release_compression(hit.id, lease_id=lease_id)
            except Exception as exc:
                logger.warning("planner_memory.release_compression_failed", root_agent_id=hit.id, error=str(exc)[:200])


async def retrieve_memories(
    goal: str,
    *,
    user_id: Optional[str],
    exclude_root_agent_id: Optional[str],
    agent_id: Optional[str] = None,
    config: Optional[RetrievalConfig] = None,
    llm_auth: Optional[Mapping[str, Any]] = None,
) -> MemoryRetrieval:
    """Never raises: any failure yields an empty retrieval with ``error`` set.

    ``llm_auth`` is the caller's leased compute token, lent to any plan-time compression.
    """
    config = config or DEFAULT_CONFIG
    started = time.perf_counter()
    result = MemoryRetrieval(query=goal)
    timing = result.timing_ms
    try:
        search_started = time.perf_counter()
        candidates = await backend.search_memories(
            goal,
            user_id=user_id,
            exclude_root_agent_id=exclude_root_agent_id,
            limit=config.candidate_limit,
            passed_only=config.passed_only,
            min_similarity=config.min_similarity,
        )
        timing["search"] = round((time.perf_counter() - search_started) * 1000, 2)
        result.candidates = len(candidates)
        hits = select_hits(candidates, config)

        compress_started = time.perf_counter()
        ready: list[MemoryHit] = []
        pending: list[MemoryHit] = []
        for hit in hits:
            if hit.critical_path is not None:
                ready.append(hit)
            elif len(pending) < config.max_compressions:
                pending.append(hit)
            else:
                result.skipped_uncompressed += 1
        if pending:
            tasks = [
                asyncio.create_task(_ensure_critical_path(hit, agent_id=agent_id, user_id=user_id, llm_auth=llm_auth))
                for hit in pending
            ]
            _done, unfinished = await asyncio.wait(tasks, timeout=COMPRESSION_BATCH_TIMEOUT_SECONDS)
            if unfinished:
                for task in unfinished:
                    task.cancel()
                # Let every cancelled compressor run its lease-release finally block.
                await asyncio.gather(*unfinished, return_exceptions=True)
                logger.warning(
                    "planner_memory.compress_timeout",
                    timeout_seconds=COMPRESSION_BATCH_TIMEOUT_SECONDS,
                    unfinished=len(unfinished),
                )
            for hit, task in zip(pending, tasks):
                if task.cancelled():
                    result.skipped_uncompressed += 1
                elif task.exception() is not None:
                    result.skipped_uncompressed += 1
                    logger.warning(
                        "planner_memory.compress_failed", root_agent_id=hit.id, error=str(task.exception())[:200]
                    )
                elif task.result() is True:
                    ready.append(hit)
                    result.compressed += 1
                else:
                    result.skipped_uncompressed += 1
        timing["compress"] = round((time.perf_counter() - compress_started) * 1000, 2)
        result.hits = sorted(ready, key=lambda h: -h.similarity)[: config.k]
    except Exception as exc:
        result.error = str(exc)[:200]
        logger.warning("planner_memory.retrieval_failed", error=result.error)
    finally:
        timing["total"] = round((time.perf_counter() - started) * 1000, 2)
        logger.info("planner_memory.retrieved", **result.summary())
    return result
