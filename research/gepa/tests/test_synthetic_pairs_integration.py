"""Integration tests for synthetic pairs judge — makes real LLM API calls.

Run:
    PYTHONPATH=agents python -m pytest research/gepa/tests/test_synthetic_pairs_integration.py -v -s
"""

import pytest

from research.gepa.pipelines.synthetic_pairs import (
    JudgeVerdict,
    _judge_once,
    judge_preference,
    format_candidate_for_judge,
)
from research.gepa.critic import serialize_prompt


GOOD_CANDIDATE = {
    'title': 'Buy Black Beanie from Amazon',
    'content': 'Multi-step plan to find and purchase a black beanie',
    'tasks': [
        {'goal': 'Search Amazon for black beanies under $30 with 4+ star rating', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Compare top 3 results by price, rating, material, and shipping speed', 'tool_name': 'reasoning', 'depends_on': [0]},
        {'goal': 'Navigate to Amazon, add best option to cart, and complete checkout', 'tool_name': 'spawn_browser_agent', 'depends_on': [1]},
    ],
    'me': {'passed': True, 'score': 0.95, 'reasoning': 'Tasks are distinct'},
    'ce': {'passed': True, 'score': 0.90, 'reasoning': 'Covers full flow'},
    'complexity': {'passed': True, 'score': 0.85, 'reasoning': 'Appropriate complexity'},
}

BAD_CANDIDATE = {
    'title': 'Get Beanie',
    'content': 'Simple plan',
    'tasks': [
        {'goal': 'Look for a beanie online somewhere', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Think about hats', 'tool_name': 'reasoning', 'depends_on': []},
    ],
    'me': {'passed': False, 'score': 0.3, 'reasoning': 'Overlapping vague tasks'},
    'ce': {'passed': False, 'score': 0.2, 'reasoning': 'Missing purchase step'},
}


class TestJudgeOnce:

    @pytest.mark.asyncio
    async def test_returns_valid_verdict(self):
        context = serialize_prompt('Buy a black beanie from Amazon', [])
        a_text = format_candidate_for_judge(GOOD_CANDIDATE, 'A')
        b_text = format_candidate_for_judge(BAD_CANDIDATE, 'B')

        result = await _judge_once(
            goal='Buy a black beanie from Amazon',
            context=context,
            candidate_a_text=a_text,
            candidate_b_text=b_text,
            few_shot_section='',
        )

        assert isinstance(result, JudgeVerdict)
        assert result.overall_winner in ('A', 'B', 'TIE')
        assert 0 <= result.confidence <= 100
        assert len(result.overall_reasoning) > 0
        print(f'Winner: {result.overall_winner}, Confidence: {result.confidence}')
        print(f'Reasoning: {result.overall_reasoning}')


class TestDebiasedJudge:

    @pytest.mark.asyncio
    async def test_returns_valid_result(self):
        result = await judge_preference(
            goal='Buy a black beanie from Amazon',
            candidate_a=GOOD_CANDIDATE,
            candidate_b=BAD_CANDIDATE,
        )
        assert isinstance(result, JudgeVerdict)
        assert result.overall_winner in ('A', 'B', 'TIE')
        print(f'Debiased winner: {result.overall_winner}, Confidence: {result.confidence}')
        print(f'Reasoning: {result.overall_reasoning}')

    @pytest.mark.asyncio
    async def test_prefers_good_over_bad(self):
        """With clearly different quality, judge should pick the better plan."""
        result = await judge_preference(
            goal='Buy a black beanie from Amazon',
            candidate_a=GOOD_CANDIDATE,
            candidate_b=BAD_CANDIDATE,
        )
        # Good candidate has specific tasks, proper deps, covers full flow
        # Bad candidate is vague with no purchase step
        assert result.overall_winner == 'A', (
            f'Expected good candidate (A) to win, got {result.overall_winner}: {result.overall_reasoning}'
        )
        assert result.confidence > 50
