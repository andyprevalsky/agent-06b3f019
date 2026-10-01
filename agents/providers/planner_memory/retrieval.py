"""Goal -> memory hits: semantic candidates, LLM judge, at most one memory.

Retrieval (chosen by agents/benchmarks/memory_retrieval_bench.py):

1. The backend embeds the goal (voyage-4) and returns visible rows whose
   cosine(query, stored goal vector) >= ``min_similarity``, highest first.
2. The top ``top_n`` distinct goals go to one small judge LLM call that picks
   the single past run whose plan would help plan this goal (the planner's
   get_memories criteria: reusable entry points, tool choices, decomposition,
   session handling, pitfalls), or none. A judge timeout or error injects
   nothing. Cosine alone cannot separate "shares topic words" from "plan
   carries over"; the judge makes that call.

Hot path (10k agents): one backend search (one embedding call + one
visibility-filtered vector query), at most one judge call, and at most
``max_compressions`` compressor calls when the chosen hit has no cached
critical path. A Postgres lease elects one compressor per bundle; concurrent
planners skip the R2 read and LLM call.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import structlog
from pydantic import BaseModel

from providers.planner_memory import client as backend
from providers.planner_memory.compressor import COMPRESSOR_VERSION, compress_transcript
from providers.planner_memory.records import CriticalPath, MemoryHit

logger = structlog.get_logger(__name__)

COMPRESSION_BATCH_TIMEOUT_SECONDS = 15.0
JUDGE_CALL_SITE = "planner_memory_judge"
JUDGE_QUERY_MAX_CHARS = 3000
JUDGE_CANDIDATE_MAX_CHARS = 3000

JUDGE_PROMPT = """An AI assistant is about to plan this goal:
<goal>{request}</goal>

Past runs the assistant completed (their goals):
{candidates}

A past run is a useful memory when its plan would help plan this goal: the planner reuses a memory's entry points and URLs, tool choices, task decomposition, session handling, and known pitfalls, but never copies names, prices, dates, quantities, or steps the goal does not call for. So a run is useful when it worked on the same site, service, integration, or data source, or used the same kind of task mechanics, even if the specific details or wording differ. A run is NOT useful when it only shares topic or location words and none of its plan would carry over.
Pick the single most useful past run, or none.
Reply with JSON only: {{"match": <number or null>}}"""


class JudgeVerdict(BaseModel):
    match: Optional[int] = None


@dataclass(frozen=True)
class RetrievalConfig:
    # Winner of agents/benchmarks/memory_retrieval_bench.py on the frozen labels
    # (voyage-4 goal vectors → rose-1-mini judge over the top 5). Pinned by
    # tests/blackbox/memory_retrieval_bench.blackbox.py.
    min_similarity: float = 0.50
    top_n: int = 5
    # The judge picks at most one useful run, so at most one memory is rendered.
    k: int = 1
    candidate_limit: int = 20
    max_compressions: int = 1
    passed_only: bool = True
    judge_model: str = "rose-labs/rose-1-mini"
    judge_timeout_s: float = 5.0

    def with_(self, **overrides: Any) -> "RetrievalConfig":
        return RetrievalConfig(**{**self.__dict__, **overrides})


DEFAULT_CONFIG = RetrievalConfig()


def shortlist(candidates: list[dict[str, Any]], config: RetrievalConfig) -> list[MemoryHit]:
    """Completed runs only, one hit per unique goal text (prefer compressed, then newest), top_n by similarity."""
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
    return hits[: config.top_n]


def build_judge_messages(goal: str, hits: list[MemoryHit]) -> list[dict[str, Any]]:
    listing = "\n\n".join(f"[{n}]\n{hit.goal[:JUDGE_CANDIDATE_MAX_CHARS]}" for n, hit in enumerate(hits, start=1))
    prompt = JUDGE_PROMPT.format(request=goal[:JUDGE_QUERY_MAX_CHARS], candidates=listing)
    return [{"role": "user", "content": prompt}]


def apply_verdict(hits: list[MemoryHit], verdict: JudgeVerdict) -> Optional[MemoryHit]:
    """Only an in-range match becomes a memory; null means no candidate is useful."""
    if verdict.match is None:
        return None
    if not 1 <= verdict.match <= len(hits):
        return None
    return hits[verdict.match - 1]


async def judge_candidates(
    goal: str,
    hits: list[MemoryHit],
    *,
    config: RetrievalConfig,
    agent_id: Optional[str],
    user_id: Optional[str],
) -> JudgeVerdict:
    """One LLM call over the shortlisted goals. Raises on timeout / invalid output."""
    from helpers.llm import call_llm

    result = await asyncio.wait_for(
        call_llm(
            build_judge_messages(goal, hits),
            model=config.judge_model,
            temperature=0.0,
            # Reasoning tokens share this budget on the waterfall; 300 truncated the JSON.
            max_tokens=1500,
            # Plain JSON-by-prompt, parsed below: a response_format schema adds
            # constrained-decoding latency and is skipped by some waterfall layers.
            call_site=JUDGE_CALL_SITE,
            agent_id=agent_id,
            user_id=user_id,
            claude_token_user_id=user_id,
            skip_cache_write=True,
        ),
        timeout=config.judge_timeout_s,
    )
    content = result.get("content") if isinstance(result, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise ValueError("memory judge returned no content")
    text = content.strip()
    if "{" in text and "}" in text:
        text = text[text.index("{") : text.rindex("}") + 1]
    return JudgeVerdict.model_validate_json(text)


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
    shortlisted: int = 0
    judge: Optional[dict[str, Any]] = None
    compressed: int = 0
    skipped_uncompressed: int = 0
    timing_ms: dict[str, float] = field(default_factory=dict)
    error: Optional[str] = None

    def summary(self) -> dict[str, Any]:
        return {
            "hits": [hit.summary() for hit in self.hits],
            "candidates": self.candidates,
            "shortlisted": self.shortlisted,
            "judge": self.judge,
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
    config: Optional[RetrievalConfig] = None,
) -> MemoryRetrieval:
    """Never raises: any failure yields an empty retrieval with ``error`` set."""
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
        shortlisted = shortlist(candidates, config)
        result.shortlisted = len(shortlisted)
        if not shortlisted:
            return result

        judge_started = time.perf_counter()
        try:
            verdict = await judge_candidates(goal, shortlisted, config=config, agent_id=agent_id, user_id=user_id)
        except (asyncio.TimeoutError, TimeoutError):
            result.judge = {"error": "timeout"}
            logger.warning("planner_memory.judge_timeout", timeout_s=config.judge_timeout_s)
            return result
        finally:
            timing["judge"] = round((time.perf_counter() - judge_started) * 1000, 2)
        result.judge = verdict.model_dump()
        chosen = apply_verdict(shortlisted, verdict)
        if chosen is None:
            return result

        compress_started = time.perf_counter()
        if chosen.critical_path is not None:
            result.hits = [chosen]
        elif config.max_compressions < 1:
            result.skipped_uncompressed += 1
        else:
            task = asyncio.create_task(_ensure_critical_path(chosen, agent_id=agent_id, user_id=user_id))
            _done, unfinished = await asyncio.wait({task}, timeout=COMPRESSION_BATCH_TIMEOUT_SECONDS)
            if unfinished:
                task.cancel()
                # Let the cancelled compressor run its lease-release finally block.
                await asyncio.gather(task, return_exceptions=True)
                logger.warning(
                    "planner_memory.compress_timeout",
                    timeout_seconds=COMPRESSION_BATCH_TIMEOUT_SECONDS,
                    unfinished=1,
                )
                result.skipped_uncompressed += 1
            elif task.exception() is not None:
                result.skipped_uncompressed += 1
                logger.warning(
                    "planner_memory.compress_failed", root_agent_id=chosen.id, error=str(task.exception())[:200]
                )
            elif task.result() is True:
                result.hits = [chosen]
                result.compressed += 1
            else:
                result.skipped_uncompressed += 1
        timing["compress"] = round((time.perf_counter() - compress_started) * 1000, 2)
    except Exception as exc:
        result.error = str(exc)[:200]
        logger.warning("planner_memory.retrieval_failed", error=result.error)
    finally:
        timing["total"] = round((time.perf_counter() - started) * 1000, 2)
        logger.info("planner_memory.retrieved", **result.summary())
    return result
