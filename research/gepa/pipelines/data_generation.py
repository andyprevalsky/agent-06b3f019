"""Data generation pipeline (Step 0): generates candidate decomposition pairs.

Flow:
  clarified_task → generate N candidates (PlannerResponse)
                 → validate each (hard gates)
                 → evaluate each (ME/CE/Complexity)
                 → store as DecompositionCandidate with metadata

STUB: Returns placeholder candidates. Replace with LLM decomposer in Phase B.
"""

from typing import List

from ..types import ClarifiedTask, DecompositionCandidate


async def generate_candidates(task: ClarifiedTask, n: int = 2) -> List[DecompositionCandidate]:
    """Generate N candidate decompositions for a clarified task.

    STUB: Returns empty list. In Phase B, this will:
    1. Call LLM decomposer N times with task context
    2. Validate each output
    3. Run ME/CE/Complexity evaluators
    4. Return candidates with metadata
    """
    return []
