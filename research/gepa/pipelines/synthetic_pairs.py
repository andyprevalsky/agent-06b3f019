"""Synthetic pair generator (Step 2): LLM judge picks winner from candidate pairs.

Flow:
  task → generate K candidates → form pairs → judge picks winner
      → store as synthetic preference pair (weight=0.5)

STUB: Returns placeholder judgment. Replace with LLM judge in Phase B.
"""

from typing import Literal

from dataclasses import dataclass

from ..types import DecompositionCandidate


@dataclass
class PreferenceJudgment:
    winner: Literal['A', 'B', 'TIE']
    reasoning: str
    confidence: float  # 0-100


async def judge_preference(
    goal: str,
    candidate_a: DecompositionCandidate,
    candidate_b: DecompositionCandidate,
) -> PreferenceJudgment:
    """Judge which candidate decomposition is better.

    STUB: Returns TIE. In Phase B, this will call a strong LLM
    with a rubric to evaluate both candidates.
    """
    return PreferenceJudgment(winner='TIE', reasoning='STUB: Not implemented', confidence=0.0)
