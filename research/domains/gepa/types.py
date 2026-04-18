"""GEPA domain types layer — dataclasses and schemas.

Only external packages and peer type-only imports may appear here. The core
GEPA value objects are defined in ``research.gepa.types``; they are
re-exported here so consumers can depend on the domain layer alone.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from research.gepa.types import (
    ClarifiedTask,
    DecompositionCandidate,
    EvalResult,
    PreferencePair,
    ValidationError,
)


@dataclass
class OptimizationResult:
    """Result of a GEPA prompt optimisation run.

    Mirrors ``research.gepa.pipelines.gepa_optimizer.OptimizationResult`` but
    is declared here so the domain types layer stays importable without the
    optimiser module's (side-effect-heavy) dependencies.
    """

    optimized_strategy: str
    optimized_prompt: str
    initial_score: float
    final_score: float
    num_trials: int
    demos: list = field(default_factory=list)


__all__ = [
    'ClarifiedTask',
    'DecompositionCandidate',
    'EvalResult',
    'OptimizationResult',
    'PreferencePair',
    'ValidationError',
]
