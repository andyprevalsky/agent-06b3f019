"""Expansion pipeline (Step 1): grows task pool + candidate pairs.

Two expansion types:
1. Task expansion: generate new tasks from existing roots
2. Candidate expansion: generate 4-8 decompositions per task

STUB: Returns empty results. Replace with LLM calls in Phase B.
"""

from typing import List

from ..types import ClarifiedTask, DecompositionCandidate


async def expand_tasks(existing_tasks: List[ClarifiedTask], n: int = 10) -> List[ClarifiedTask]:
    """Generate new tasks from existing task roots.

    STUB: Returns empty list.
    """
    return []


async def expand_candidates(task: ClarifiedTask, n: int = 4) -> List[DecompositionCandidate]:
    """Generate multiple decomposition candidates for a task.

    STUB: Returns empty list.
    """
    return []
