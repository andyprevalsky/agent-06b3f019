"""Data generation pipeline: generates K candidates per task with evaluations.

Wraps decomposer + evaluators into a single call that produces
fully-evaluated DecompositionCandidates ready for labeling.
"""

import asyncio
import logging
from typing import List

from ..types import ClarifiedTask, DecompositionCandidate
from ..evaluators import evaluate_me, evaluate_ce, evaluate_complexity
from .decomposer import decompose_k, K_CANDIDATES

logger = logging.getLogger(__name__)


async def _evaluate_candidate(goal: str, candidate: DecompositionCandidate) -> DecompositionCandidate:
    """Run ME/CE/CX evaluations on a candidate in parallel."""
    if candidate.validation_errors:
        return candidate

    results = await asyncio.gather(
        evaluate_me(goal, candidate.planner_response),
        evaluate_ce(goal, candidate.planner_response),
        evaluate_complexity(goal, candidate.planner_response),
    )
    candidate.me = results[0][0]
    candidate.ce = results[1][0]
    candidate.complexity = results[2][0]
    return candidate


async def generate_candidates(
    task: ClarifiedTask,
    k: int = K_CANDIDATES,
) -> List[DecompositionCandidate]:
    """Generate K candidate decompositions with evaluations.

    1. Generate K candidates via planner LLM (parallel)
    2. Run ME/CE/CX evaluators on each valid candidate (parallel)
    3. Return fully-evaluated candidates
    """
    candidates = await decompose_k(task, k=k)

    if not candidates:
        return []

    evaluated = await asyncio.gather(
        *[_evaluate_candidate(task.raw_seed, c) for c in candidates]
    )
    return list(evaluated)
