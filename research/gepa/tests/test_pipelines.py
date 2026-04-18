"""Tests for pipeline stubs: data_generation, expansion, synthetic_pairs, gepa_optimizer.

Stub tests verify interfaces return expected types.
Behavioral tests (xfail) define contracts for Phase B.
"""

import pytest

from research.gepa.pipelines.data_generation import generate_candidates
from research.gepa.pipelines.expansion import expand_candidates, expand_tasks
from research.gepa.pipelines.gepa_optimizer import OptimizationResult
from research.gepa.pipelines.simulate_user import simulate_user
from research.gepa.pipelines.synthetic_pairs import (
    JudgeVerdict as PreferenceJudgment,
)
from research.gepa.pipelines.synthetic_pairs import (
    judge_preference,
)
from research.gepa.types import ClarifiedTask, DecompositionCandidate


def _make_stub_task() -> ClarifiedTask:
    return ClarifiedTask(
        id='test-1',
        raw_seed='Book a flight',
        agent_context=[],
        set_plan_args={},
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
        result = await generate_candidates(_make_stub_task(), k=2)
        assert isinstance(result, list)

    @pytest.mark.asyncio
    @pytest.mark.xfail(reason='STUB: awaiting LLM decomposer')
    async def test_generates_n_candidates(self):
        result = await generate_candidates(_make_stub_task(), k=2)
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
    async def test_judge_returns_verdict(self):
        """judge_preference with dict candidates returns JudgeVerdict."""
        good_cand = {
            'title': 'Good Plan',
            'content': 'Detailed plan',
            'tasks': [
                {'goal': 'Search for flights', 'tool_name': 'web_search', 'depends_on': []},
                {'goal': 'Book cheapest', 'tool_name': 'spawn_browser_agent', 'depends_on': [0]},
            ],
        }
        bad_cand = {
            'title': 'Bad Plan',
            'content': 'Vague plan',
            'tasks': [
                {'goal': 'Do something', 'tool_name': 'web_search', 'depends_on': []},
            ],
        }
        result = await judge_preference('Book a flight', good_cand, bad_cand)
        assert isinstance(result, PreferenceJudgment)
        assert result.overall_winner in ('A', 'B', 'TIE')
        assert result.confidence >= 0

    @pytest.mark.asyncio
    async def test_judge_differentiates_quality(self):
        """Judge should prefer better decomposition over worse one."""
        good_cand = {
            'title': 'Comprehensive Travel Plan',
            'content': 'Multi-step plan with research, comparison, and booking',
            'tasks': [
                {
                    'goal': 'Search for flights to destination',
                    'tool_name': 'web_search',
                    'depends_on': [],
                },
                {
                    'goal': 'Compare prices across airlines',
                    'tool_name': 'reasoning',
                    'depends_on': [0],
                },
                {
                    'goal': 'Book the best option',
                    'tool_name': 'spawn_browser_agent',
                    'depends_on': [1],
                },
                {
                    'goal': 'Confirm booking and save details',
                    'tool_name': 'reasoning',
                    'depends_on': [2],
                },
            ],
        }
        bad_cand = {
            'title': 'Simple Plan',
            'content': 'Just do it',
            'tasks': [
                {'goal': 'Figure it out', 'tool_name': 'web_search', 'depends_on': []},
                {'goal': 'Maybe do something', 'tool_name': 'reasoning', 'depends_on': []},
            ],
        }
        result = await judge_preference(
            'Complex multi-step travel booking with budget constraints', good_cand, bad_cand
        )
        assert 'STUB' not in result.overall_reasoning
        assert result.confidence > 50


class TestGEPAOptimizer:
    def test_optimization_result_shape(self):
        """Verify OptimizationResult dataclass has expected fields."""
        result = OptimizationResult(
            optimized_strategy='test',
            optimized_prompt='test prompt',
            initial_score=0.0,
            final_score=0.5,
            num_trials=3,
            demos=[],
        )
        assert isinstance(result, OptimizationResult)
        assert result.optimized_prompt == 'test prompt'
        assert result.num_trials == 3
