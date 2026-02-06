"""GEPA-specific types. Agent types (PlannerResponse, etc.) are imported from agents lib."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

from helpers.tool_schemas import PlannerResponse


@dataclass
class ValidationError:
    type: Literal['INVALID_TASK_COUNT', 'INVALID_DEPENDENCY_INDEX', 'CYCLE_DETECTED']
    detail: str


@dataclass
class ClarifiedTask:
    id: str
    raw_seed: str
    agent_context: List[Dict[str, Any]]  # user/assistant turns (no system prompt)
    set_plan_args: Dict[str, Any]


@dataclass
class EvalResult:
    passed: bool
    score: float  # 0.0–1.0
    reasoning: str


@dataclass
class DecompositionCandidate:
    planner_response: PlannerResponse
    validation_errors: List[ValidationError]
    me: Optional[EvalResult] = None
    ce: Optional[EvalResult] = None
    complexity: Optional[EvalResult] = None


@dataclass
class PreferencePair:
    id: str
    task: ClarifiedTask
    candidate_a: DecompositionCandidate
    candidate_b: DecompositionCandidate
    preference: Literal['A', 'B', 'TIE']
    source: Literal['human', 'synthetic']
    weight: float = 1.0  # human=1.0, synthetic=0.5
