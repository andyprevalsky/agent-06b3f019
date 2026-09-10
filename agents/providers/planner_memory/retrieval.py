"""Goal -> memory hits: backend lexical candidates, in-process scoring, absolute cutoff.

Hot path (10k agents): one indexed FTS query against the history table per
planner call, scoring over at most 50 candidates in-process, and at most
``RetrievalConfig.max_compressions`` compressor LLM calls when a hit has no
cached critical path yet. A Postgres lease elects one compressor per bundle;
concurrent planners skip the R2 read and LLM call.

Scoring strategies are all computed from the same candidate features so the
retrieval benchmark (agents/benchmarks/memory_retrieval_bench.py) can compare
them on the frozen labeled set; ``DEFAULT_CONFIG`` holds the winner.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Optional

import structlog

from providers.planner_memory import client as backend
from providers.planner_memory.compressor import COMPRESSOR_VERSION, compress_transcript
from providers.planner_memory.records import CriticalPath, MemoryHit

logger = structlog.get_logger(__name__)

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_STOPWORDS = frozenset(
    """
    a an the and or but if then else of to in on at by for with from as is are was were be been being am
    do does did done doing have has had having will would shall should can could may might must i me my we our
    you your he she it its they them their this that these those there here what which who whom whose when where
    why how all any each every some such no nor not only own same so than too very just also into over under
    again further once about above below up down out off through during before after between both while until
    use using used need needs needed please make sure want wants get got go going
    """.split()
)

STRATEGIES = ("jaccard", "coverage", "trgm", "fts", "hybrid", "coverage_fts", "coverage_trgm")
COMPRESSION_BATCH_TIMEOUT_SECONDS = 15.0


def tokenize(text: str) -> list[str]:
    tokens: list[str] = []
    for raw in _TOKEN_RE.findall(text.lower()):
        if len(raw) < 2 or raw in _STOPWORDS:
            continue
        tokens.append(_stem(raw))
    return tokens


def _stem(token: str) -> str:
    if len(token) <= 4 or token.isdigit():
        return token
    for suffix, replacement in (("ies", "y"), ("ing", ""), ("ed", ""), ("es", ""), ("s", "")):
        if token.endswith(suffix) and len(token) - len(suffix) >= 3:
            return token[: -len(suffix)] + replacement
    return token


@dataclass(frozen=True)
class RetrievalConfig:
    # Winner of agents/benchmarks/memory_retrieval_bench.py on the frozen labels
    # (fit split: objective 0.615, recall@1 0.54, negative false-positive rate 0;
    # held-out: objective 0.53, negative false-positive rate 0). Pinned by
    # tests/blackbox/memory_retrieval_bench.blackbox.py.
    strategy: str = "coverage"
    min_score: float = 0.65
    relative_floor: float = 0.0
    k: int = 3
    candidate_limit: int = 30
    max_compressions: int = 2
    passed_only: bool = True

    def with_(self, **overrides: Any) -> "RetrievalConfig":
        return RetrievalConfig(**{**self.__dict__, **overrides})


DEFAULT_CONFIG = RetrievalConfig()


def candidate_features(goal: str, candidate: dict[str, Any], *, max_fts_rank: float) -> dict[str, float]:
    query = set(tokenize(goal))
    doc = set(tokenize(str(candidate.get("goal") or "")))
    inter = len(query & doc)
    union = len(query | doc) or 1
    backend_coverage = candidate.get("lexical_coverage")
    coverage = float(backend_coverage) if isinstance(backend_coverage, (int, float)) else inter / (len(query) or 1)
    reverse = inter / (len(doc) or 1)
    trgm = float(candidate.get("trgm_similarity") or 0.0)
    fts = float(candidate.get("fts_rank") or 0.0)
    fts_norm = fts / max_fts_rank if max_fts_rank > 0 else 0.0
    jaccard = inter / union
    return {
        "jaccard": jaccard,
        "coverage": coverage,
        "reverse_coverage": reverse,
        "trgm": trgm,
        "fts": fts_norm,
        "hybrid": 0.5 * jaccard + 0.5 * trgm,
        # Stored goals are often the prompt plus runner-appended constraints, so the
        # query is contained in the memory goal (coverage 1.0) while symmetric
        # measures stay low. These blend containment with a lexical signal.
        "coverage_fts": 0.5 * coverage + 0.5 * fts_norm,
        "coverage_trgm": 0.7 * coverage + 0.3 * trgm,
    }


def score_candidates(goal: str, candidates: list[dict[str, Any]], config: RetrievalConfig) -> list[MemoryHit]:
    """Score, dedupe per unique goal text, apply the absolute cutoff + relative floor, keep top-k."""
    if not candidates:
        return []
    max_fts = max(float(c.get("fts_rank") or 0.0) for c in candidates)
    features = [candidate_features(goal, cand, max_fts_rank=max_fts) for cand in candidates]
    return rank_hits(candidates, features, config)


def rank_hits(
    candidates: list[dict[str, Any]], features_per_candidate: list[dict[str, float]], config: RetrievalConfig
) -> list[MemoryHit]:
    """Ranking given precomputed features (the retrieval benchmark reuses this across configs)."""
    scored: list[MemoryHit] = []
    for cand, features in zip(candidates, features_per_candidate):
        if config.passed_only and not _is_success(cand):
            continue
        score = features.get(config.strategy, features["hybrid"])
        cp = (
            _parse_critical_path(cand.get("critical_path"))
            if cand.get("compressor_version") == COMPRESSOR_VERSION
            else None
        )
        scored.append(
            MemoryHit(
                id=str(cand.get("id") or ""),
                goal=str(cand.get("goal") or ""),
                benchmark_task_name=cand.get("benchmark_task_name"),
                passed=cand.get("passed"),
                root_status=cand.get("root_status"),
                created_at=cand.get("agent_created_at"),
                similarity=float(score),
                critical_path=cp,
                features=features,
            )
        )
    # One hit per unique goal text: prefer an already-compressed row, then the newest.
    best: dict[str, MemoryHit] = {}
    for hit in scored:
        key = _goal_key(hit.goal)
        incumbent = best.get(key)
        if incumbent is None or _prefer(hit, incumbent):
            best[key] = hit
    hits = sorted(best.values(), key=lambda h: (-h.similarity, h.critical_path is None, h.created_at or ""))
    hits = [h for h in hits if h.similarity >= config.min_score]
    if not hits:
        return []
    top = hits[0].similarity
    hits = [h for h in hits if h.similarity >= top * config.relative_floor]
    return hits[: config.k]


@lru_cache(maxsize=8192)
def _goal_key(goal: str) -> str:
    return " ".join(tokenize(goal))


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


async def _ensure_critical_path(hit: MemoryHit, *, agent_id: Optional[str], user_id: Optional[str]) -> bool:
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
        record = await compress_transcript(transcript, agent_id=agent_id, user_id=user_id)
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
    config: RetrievalConfig = DEFAULT_CONFIG,
) -> MemoryRetrieval:
    """Never raises: any failure yields an empty retrieval with ``error`` set."""
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
        )
        timing["search"] = round((time.perf_counter() - search_started) * 1000, 2)
        result.candidates = len(candidates)
        hits = score_candidates(goal, candidates, config)

        compress_started = time.perf_counter()
        budget = config.max_compressions
        ready: list[MemoryHit] = []
        pending: list[MemoryHit] = []
        for hit in hits:
            if hit.critical_path is not None:
                ready.append(hit)
            elif len(pending) < budget:
                pending.append(hit)
            else:
                result.skipped_uncompressed += 1
        if pending:
            tasks = [
                asyncio.create_task(_ensure_critical_path(hit, agent_id=agent_id, user_id=user_id)) for hit in pending
            ]
            _done, unfinished = await asyncio.wait(
                tasks,
                timeout=COMPRESSION_BATCH_TIMEOUT_SECONDS,
            )
            if unfinished:
                for task in unfinished:
                    task.cancel()
                # Let every cancelled compressor run its lease-release finally
                # block before the planner continues.
                await asyncio.gather(*unfinished, return_exceptions=True)
                logger.warning(
                    "planner_memory.compress_timeout",
                    timeout_seconds=COMPRESSION_BATCH_TIMEOUT_SECONDS,
                    unfinished=len(unfinished),
                )
            outcomes: list[Any] = []
            for task in tasks:
                if task.cancelled():
                    outcomes.append(asyncio.TimeoutError("planner memory compression timed out"))
                    continue
                error = task.exception()
                outcomes.append(error if error is not None else task.result())
            for hit, outcome in zip(pending, outcomes):
                if outcome is True:
                    ready.append(hit)
                    result.compressed += 1
                else:
                    result.skipped_uncompressed += 1
                    if isinstance(outcome, Exception):
                        logger.warning("planner_memory.compress_failed", root_agent_id=hit.id, error=str(outcome)[:200])
        timing["compress"] = round((time.perf_counter() - compress_started) * 1000, 2)
        result.hits = sorted(ready, key=lambda h: -h.similarity)[: config.k]
    except Exception as exc:
        result.error = str(exc)[:200]
        logger.warning("planner_memory.retrieval_failed", error=result.error)
    timing["total"] = round((time.perf_counter() - started) * 1000, 2)
    logger.info("planner_memory.retrieved", **result.summary())
    return result
