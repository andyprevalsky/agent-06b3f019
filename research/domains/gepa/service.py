"""GEPA domain service layer — business logic orchestration.

Aggregates the scoring, validation, critic, and optimisation primitives that
sit between the repo (file I/O) and runtime (CLI) layers.
"""

from __future__ import annotations

from research.gepa.critic import (
    score_candidates,
    serialize_candidate,
    serialize_prompt,
    train_reward_model,
)
from research.gepa.embeddings import (
    cosine_similarity,
    embed_texts,
    retrieve_similar_pairs,
)
from research.gepa.evaluators.collective_exhaustiveness import evaluate_ce
from research.gepa.evaluators.complexity_invariant import evaluate_complexity
from research.gepa.evaluators.mutual_exclusivity import evaluate_me
from research.gepa.pipelines.gepa_optimizer import (
    _build_prompt_skeleton,
    _make_decomposer_module,
    _parse_plan,
    _retry,
    compose_prompt,
    extract_strategy,
    get_initial_strategy,
    make_gepa_metric,
    optimize_prompt,
)
from research.gepa.scoring import (
    final_score,
    hard_gate,
    soft_penalties,
)
from research.gepa.validators import validate_decomposition

__all__ = [
    '_build_prompt_skeleton',
    '_make_decomposer_module',
    '_parse_plan',
    '_retry',
    'compose_prompt',
    'cosine_similarity',
    'embed_texts',
    'evaluate_ce',
    'evaluate_complexity',
    'evaluate_me',
    'extract_strategy',
    'final_score',
    'get_initial_strategy',
    'hard_gate',
    'make_gepa_metric',
    'optimize_prompt',
    'retrieve_similar_pairs',
    'score_candidates',
    'serialize_candidate',
    'serialize_prompt',
    'soft_penalties',
    'train_reward_model',
    'validate_decomposition',
]
