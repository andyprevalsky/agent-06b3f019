"""Tests for pipeline stubs: data_generation, expansion, synthetic_pairs, gepa_optimizer.

Stub tests verify interfaces return expected types.
Behavioral tests (xfail) define contracts for Phase B.
"""

import pytest

from research.gepa.pipelines.data_generation import generate_candidates
from research.gepa.pipelines.expansion import expand_tasks, expand_candidates
from research.gepa.pipelines.synthetic_pairs import judge_preference, PreferenceJudgment
from research.gepa.pipelines.gepa_optimizer import optimize_prompt, OptimizationResult
from research.gepa.pipelines.simulate_user import simulate_user
from research.gepa.types import ClarifiedTask, DecompositionCandidate


def _make_stub_task() -> ClarifiedTask:
    return ClarifiedTask(
        id='test-1', raw_seed='Book a flight',
        agent_context=[], set_plan_args={},
        simulated_responses=[], tools_used=[],
    )


class TestSimulateUser:

    @pytest.mark.asyncio
    async def test_returns_string(self):
        result = await simulate_user('What dates?', 'Book a flight')
        assert isinstance(result, str)
        assert len(result) > 0


class TestDataGeneration:

    @pytest.mark.asyncio
    async def test_stub_returns_list(self):
        result = await generate_candidates(_make_stub_task(), n=2)
        assert isinstance(result, list)

    @pytest.mark.asyncio
    @pytest.mark.xfail(reason='STUB: awaiting LLM decomposer')
    async def test_generates_n_candidates(self):
        result = await generate_candidates(_make_stub_task(), n=2)
        assert len(result) == 2
        for c in result:
            assert isinstance(c, DecompositionCandidate)


class TestExpansion:

    @pytest.mark.asyncio
    async def test_expand_tasks_stub(self):
        result = await expand_tasks([_make_stub_task()], n=5)
        assert isinstance(result, list)

    @pytest.mark.asyncio
    async def test_expand_candidates_stub(self):
        result = await expand_candidates(_make_stub_task(), n=4)
        assert isinstance(result, list)


class TestSyntheticPairs:

    @pytest.mark.asyncio
    async def test_judge_stub_returns_result(self):
        from research.gepa.tests.fixtures import VALID_LINEAR_2
        from research.gepa.types import DecompositionCandidate
        stub_candidate = DecompositionCandidate(
            planner_response=VALID_LINEAR_2,
            validation_errors=[],
        )
        result = await judge_preference('Book a flight', stub_candidate, stub_candidate)
        assert isinstance(result, PreferenceJudgment)
        assert result.winner in ('A', 'B', 'TIE')

    @pytest.mark.asyncio
    @pytest.mark.xfail(reason='STUB: awaiting LLM judge')
    async def test_judge_differentiates_quality(self):
        """Judge should prefer better decomposition over worse one."""
        from research.gepa.tests.fixtures import VALID_DIAMOND_4, VALID_LINEAR_2
        from research.gepa.types import DecompositionCandidate
        good = DecompositionCandidate(planner_response=VALID_DIAMOND_4, validation_errors=[])
        bad = DecompositionCandidate(planner_response=VALID_LINEAR_2, validation_errors=[])
        result = await judge_preference('Complex multi-step task', good, bad)
        assert 'STUB' not in result.reasoning
        assert result.confidence > 50


class TestGEPAOptimizer:

    @pytest.mark.asyncio
    async def test_stub_returns_result(self):
        result = await optimize_prompt('test prompt', max_generations=1)
        assert isinstance(result, OptimizationResult)
        assert result.optimized_prompt == 'test prompt'
        assert result.generations_run == 0

    @pytest.mark.asyncio
    @pytest.mark.xfail(reason='STUB: awaiting full GEPA implementation')
    async def test_improves_or_maintains_score(self):
        result = await optimize_prompt('test prompt', max_generations=3)
        assert result.final_score >= result.initial_score
        assert result.generations_run > 0
