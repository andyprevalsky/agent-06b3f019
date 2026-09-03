"""Goal -> reference-plan retrieval for the planner LLM.

Lexical BM25 over past root goals (no external embedding call, no network on
the query path once the index is loaded). Returns a formatted
``# Reference Plans`` block that the planner activity injects as a user
message *after* the cached static prefix, so prompt caching is untouched.
"""

from __future__ import annotations

import asyncio
import math
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import structlog

from providers.planner_rag import store
from providers.planner_rag.corpus import PlanEntry

logger = structlog.get_logger(__name__)

REFERENCE_PLANS_PREFIX = "# Reference Plans"
DEFAULT_TOP_K = 3
MAX_BLOCK_CHARS = 6000
MAX_HIT_CHARS = 1800
MAX_TASK_GOAL_CHARS = 280
MAX_REFERENCE_GOAL_CHARS = 600
MIN_COVERAGE = 0.2
RELATIVE_SCORE_FLOOR = 0.25

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


def tokenize(text: str) -> list[str]:
    """Lowercase alphanumeric tokens minus stopwords, lightly stemmed."""
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
class ReferenceHit:
    entry: PlanEntry
    score: float
    coverage: float


class PlannerRagIndex:
    """Immutable BM25 index over ``PlanEntry.goal``. Build once, query many."""

    K1 = 1.2
    B = 0.75

    def __init__(self, entries: list[PlanEntry], *, generated_at: str = "", source: str = "") -> None:
        self.entries = list(entries)
        self.generated_at = generated_at
        self.source = source
        self._doc_tokens: list[list[str]] = [tokenize(e.goal) for e in self.entries]
        self._doc_len = [len(t) for t in self._doc_tokens]
        total = sum(self._doc_len)
        self._avgdl = (total / len(self._doc_len)) if self._doc_len else 0.0
        self._postings: dict[str, list[tuple[int, int]]] = {}
        for idx, tokens in enumerate(self._doc_tokens):
            counts: dict[str, int] = {}
            for token in tokens:
                counts[token] = counts.get(token, 0) + 1
            for token, tf in counts.items():
                self._postings.setdefault(token, []).append((idx, tf))
        self._n = len(self.entries)
        self._goal_key = [" ".join(t) for t in self._doc_tokens]

    def __len__(self) -> int:
        return self._n

    def _idf(self, term: str) -> float:
        df = len(self._postings.get(term, ()))
        if df == 0:
            return 0.0
        return math.log(1.0 + (self._n - df + 0.5) / (df + 0.5))

    def query(
        self,
        goal: str,
        *,
        user_id: Optional[str],
        k: int = DEFAULT_TOP_K,
        exclude_root_agent_id: Optional[str] = None,
        min_coverage: float = MIN_COVERAGE,
        relative_floor: float = RELATIVE_SCORE_FLOOR,
    ) -> list[ReferenceHit]:
        """Top-k visible, deduplicated exemplars for ``goal``.

        Visibility: an entry is shown to a user only if it is that user's own
        run or a benchmark run (shared corpus). Duplicated goals collapse to
        the best (passed, newest) run. Hits need ``min_coverage`` of the query
        terms and at least ``relative_floor`` of the top score.
        """
        if self._n == 0 or k <= 0:
            return []
        query_terms = sorted(set(tokenize(goal)))
        if not query_terms:
            return []

        scores: dict[int, float] = {}
        matched: dict[int, int] = {}
        for term in query_terms:
            idf = self._idf(term)
            if idf == 0.0:
                continue
            for idx, tf in self._postings[term]:
                dl = self._doc_len[idx]
                denom = tf + self.K1 * (1 - self.B + self.B * dl / (self._avgdl or 1.0))
                scores[idx] = scores.get(idx, 0.0) + idf * tf * (self.K1 + 1) / denom
                matched[idx] = matched.get(idx, 0) + 1

        best_per_goal: dict[str, tuple[int, float, float]] = {}
        for idx, score in scores.items():
            entry = self.entries[idx]
            if exclude_root_agent_id and entry.root_agent_id == exclude_root_agent_id:
                continue
            if not self._visible(entry, user_id):
                continue
            coverage = matched[idx] / len(query_terms)
            if coverage < min_coverage:
                continue
            key = self._goal_key[idx]
            current = best_per_goal.get(key)
            if current is None or self._prefer(idx, current[0]):
                best_per_goal[key] = (idx, score, coverage)

        if not best_per_goal:
            return []
        ranked = sorted(
            best_per_goal.values(), key=lambda item: (-item[1], self.entries[item[0]].created_at), reverse=False
        )
        top_score = ranked[0][1]
        hits = [
            ReferenceHit(entry=self.entries[idx], score=round(score, 4), coverage=round(coverage, 4))
            for idx, score, coverage in ranked
            if score >= top_score * relative_floor
        ]
        return hits[:k]

    @staticmethod
    def _visible(entry: PlanEntry, user_id: Optional[str]) -> bool:
        if entry.benchmark_task_name:
            return True
        return bool(user_id) and entry.user_id == user_id

    def _prefer(self, candidate: int, incumbent: int) -> bool:
        cand, inc = self.entries[candidate], self.entries[incumbent]
        if (cand.passed is True) != (inc.passed is True):
            return cand.passed is True
        return cand.created_at > inc.created_at


def _truncate(text: str, limit: int) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def format_reference_plans(
    hits: list[ReferenceHit],
    *,
    max_chars: int = MAX_BLOCK_CHARS,
    per_hit_chars: int = MAX_HIT_CHARS,
) -> str:
    """Render hits as the ``# Reference Plans`` user-message block (empty string if no hits)."""
    if not hits:
        return ""
    header = (
        f"{REFERENCE_PLANS_PREFIX}\n\n"
        f"{len(hits)} plan(s) below completed successfully for goals similar to the current GOAL; they were "
        "retrieved from the run archive. Treat them as structural references only (decomposition shape, "
        "tool_name choices, dependency edges). The current goal, its constraints, and the conversation take "
        "precedence: never copy names, numbers, URLs, or steps the current goal does not call for.\n"
    )
    blocks: list[str] = []
    used = len(header)
    for number, hit in enumerate(hits, start=1):
        entry = hit.entry
        when = entry.created_at[:10] if entry.created_at else "unknown date"
        lines = [
            f"\n## Reference {number} — similarity {hit.coverage:.2f} — completed {when}",
            f"Goal: {_truncate(entry.goal, MAX_REFERENCE_GOAL_CHARS)}",
            f'Plan: "{_truncate(entry.plan.title, 120)}" (join={entry.plan.join})',
        ]
        for idx, task in enumerate(entry.plan.tasks):
            deps = f" (depends_on: {', '.join(task.depends_on)})" if task.depends_on else ""
            lines.append(f"- {idx} [{task.tool_name}] {_truncate(task.goal, MAX_TASK_GOAL_CHARS)}{deps}")
        block = "\n".join(lines)
        if len(block) > per_hit_chars:
            block = block[: per_hit_chars - 14].rstrip() + "\n- [truncated]"
        if used + len(block) > max_chars:
            break
        blocks.append(block)
        used += len(block)
    return header + "\n".join(blocks) + "\n"


def planner_rag_enabled() -> bool:
    """Feature switch. Off by default inside blackbox capture mode so unrelated tests never load an index."""
    raw = os.environ.get("PLANNER_RAG_ENABLED", "").strip().lower()
    if raw in {"0", "false", "no", "off"}:
        return False
    if raw in {"1", "true", "yes", "on"}:
        return True
    return not os.environ.get("BLACKBOX_TEST_CAPTURE_OUTBOUND")


def index_from_document(document: dict[str, Any], *, source: str) -> PlannerRagIndex:
    entries = [PlanEntry.from_dict(raw) for raw in document.get("entries") or [] if isinstance(raw, dict)]
    return PlannerRagIndex(entries, generated_at=str(document.get("generated_at") or ""), source=source)


def load_index_from_store(*, backend: Optional[str] = None) -> Optional[PlannerRagIndex]:
    """Cold load: read + decrypt + parse the derived index and build BM25 structures."""
    backend = backend or store.storage_backend()
    document = store.read_encrypted_json(store.INDEX_KEY, backend=backend)
    if document is None:
        return None
    return index_from_document(document, source=backend)


@dataclass
class RetrievalResult:
    message: Optional[str]
    hits: list[ReferenceHit] = field(default_factory=list)
    corpus_size: int = 0
    source: str = "none"
    timing_ms: dict[str, float] = field(default_factory=dict)

    def summary(self) -> dict[str, Any]:
        return {
            "hits": [
                {
                    "root_agent_id": hit.entry.root_agent_id,
                    "task": hit.entry.benchmark_task_name,
                    "score": hit.score,
                    "coverage": hit.coverage,
                }
                for hit in self.hits
            ],
            "corpus_size": self.corpus_size,
            "source": self.source,
            "timing_ms": self.timing_ms,
            "message_chars": len(self.message or ""),
        }


async def retrieve_reference_plans(
    goal: str,
    *,
    user_id: Optional[str],
    k: int = DEFAULT_TOP_K,
    exclude_root_agent_id: Optional[str] = None,
) -> RetrievalResult:
    """Retrieve reference plans for ``goal``. Never raises: an unavailable index yields no message."""
    started = time.perf_counter()
    timing: dict[str, float] = {}
    try:
        load_started = time.perf_counter()
        index = await asyncio.to_thread(load_index_from_store)
        timing["index_load"] = round((time.perf_counter() - load_started) * 1000, 2)
        if index is None:
            logger.warning("planner_rag.index_unavailable", backend=store.storage_backend())
            timing["total"] = round((time.perf_counter() - started) * 1000, 2)
            return RetrievalResult(message=None, timing_ms=timing)

        query_started = time.perf_counter()
        hits = index.query(goal, user_id=user_id, k=k, exclude_root_agent_id=exclude_root_agent_id)
        timing["query"] = round((time.perf_counter() - query_started) * 1000, 2)

        format_started = time.perf_counter()
        message = format_reference_plans(hits) or None
        timing["format"] = round((time.perf_counter() - format_started) * 1000, 2)
        timing["total"] = round((time.perf_counter() - started) * 1000, 2)
        result = RetrievalResult(
            message=message, hits=hits, corpus_size=len(index), source=index.source, timing_ms=timing
        )
        logger.info("planner_rag.retrieved", **result.summary())
        return result
    except Exception as exc:
        timing["total"] = round((time.perf_counter() - started) * 1000, 2)
        logger.warning("planner_rag.retrieval_failed", error=str(exc)[:200], timing_ms=timing)
        return RetrievalResult(message=None, timing_ms=timing)


def insert_reference_plans(messages: list[dict[str, Any]], block: Optional[str]) -> list[dict[str, Any]]:
    """Insert the reference block as a user message right after the first user (GOAL) message.

    The system prompt (cached static prefix) is untouched, and any trailing
    per-attempt messages (e.g. ``[VALIDATION ERROR ...]``) stay last so the
    retry's prefix still matches the first attempt's cached prefix.
    """
    if not block:
        return messages
    reference = {"role": "user", "content": block}
    for idx, message in enumerate(messages):
        if message.get("role") == "user":
            return messages[: idx + 1] + [reference] + messages[idx + 1 :]
    return messages + [reference]
