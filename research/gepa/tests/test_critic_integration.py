"""Integration tests for critic training + inference pipeline via Modal GPU.

These tests download a real model, train on synthetic data, and score candidates.
They require Modal credentials and GPU access. ~3-5 min per run.

Run:
    PYTHONPATH=agents python -m pytest research/gepa/tests/test_critic_integration.py -v -s
"""

import modal
import pytest

from research.gepa.critic import serialize_candidate, serialize_prompt

train = modal.Function.from_name('gepa-critic', 'train')
score = modal.Function.from_name('gepa-critic', 'score')


def _make_candidate(title: str, tasks: list[dict], me_score: float = 0.9, ce_score: float = 0.8) -> dict:
    return {
        'title': title,
        'content': f'Plan: {title}',
        'tasks': tasks,
        'me': {'passed': me_score > 0.5, 'score': me_score, 'reasoning': 'test'},
        'ce': {'passed': ce_score > 0.5, 'score': ce_score, 'reasoning': 'test'},
        'complexity': {'passed': True, 'score': 0.9, 'reasoning': 'test'},
    }


# 10 synthetic preference pairs with clear signal:
# "good" candidates have specific, actionable tasks with proper dependencies
# "bad" candidates are vague single-step plans
SEED = 'Get me a black beanie from Amazon'
CONTEXT = [{'role': 'user', 'content': SEED}]

GOOD_CANDIDATES = [
    _make_candidate('Buy Black Beanie from Amazon', [
        {'goal': 'Search Amazon for black beanies under $30', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Compare top 3 results by rating and price', 'tool_name': 'reasoning', 'depends_on': [0]},
        {'goal': 'Add best option to cart and checkout', 'tool_name': 'spawn_browser_agent', 'depends_on': [1]},
    ], me_score=0.95, ce_score=0.90),
    _make_candidate('Purchase Warm Black Beanie', [
        {'goal': 'Search for black wool beanies on Amazon', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Filter results by Prime shipping and 4+ stars', 'tool_name': 'reasoning', 'depends_on': [0]},
        {'goal': 'Complete purchase of top-rated beanie', 'tool_name': 'spawn_browser_agent', 'depends_on': [1]},
    ], me_score=0.92, ce_score=0.88),
    _make_candidate('Find and Order Black Beanie', [
        {'goal': 'Browse Amazon beanie category', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Read reviews for top candidates', 'tool_name': 'web_search', 'depends_on': [0]},
        {'goal': 'Select best value option and purchase', 'tool_name': 'spawn_browser_agent', 'depends_on': [1]},
    ], me_score=0.90, ce_score=0.85),
    _make_candidate('Amazon Beanie Shopping', [
        {'goal': 'Search Amazon for highly-rated black beanies', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Analyze materials and sizing from listings', 'tool_name': 'reasoning', 'depends_on': [0]},
        {'goal': 'Purchase the best match', 'tool_name': 'spawn_browser_agent', 'depends_on': [1]},
    ], me_score=0.93, ce_score=0.87),
    _make_candidate('Get Premium Black Beanie', [
        {'goal': 'Research best black beanie brands on Amazon', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Compare Carhartt vs Nike vs generic options', 'tool_name': 'reasoning', 'depends_on': [0]},
        {'goal': 'Order the winner with fastest shipping', 'tool_name': 'spawn_browser_agent', 'depends_on': [1]},
    ], me_score=0.94, ce_score=0.91),
]

BAD_CANDIDATES = [
    _make_candidate('Get Beanie', [
        {'goal': 'Get a beanie somehow', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Do something else', 'tool_name': 'reasoning', 'depends_on': []},
    ], me_score=0.3, ce_score=0.2),
    _make_candidate('Look at Hats', [
        {'goal': 'Search for hats', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Think about hats', 'tool_name': 'reasoning', 'depends_on': []},
    ], me_score=0.4, ce_score=0.3),
    _make_candidate('Beanie Plan', [
        {'goal': 'Research beanies on the internet', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Summarize findings', 'tool_name': 'reasoning', 'depends_on': [0]},
    ], me_score=0.5, ce_score=0.25),
    _make_candidate('Hat Shopping', [
        {'goal': 'Go shopping for any hat', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Maybe buy one', 'tool_name': 'reasoning', 'depends_on': []},
    ], me_score=0.35, ce_score=0.2),
    _make_candidate('Find Something', [
        {'goal': 'Look around online', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Figure it out later', 'tool_name': 'reasoning', 'depends_on': []},
    ], me_score=0.3, ce_score=0.15),
]


def _build_training_rows() -> dict:
    """Build 10 preference pairs: each pairs a good candidate (chosen) with a bad one (rejected)."""
    prompt_text = serialize_prompt(SEED, CONTEXT)
    rows = {'prompt': [], 'chosen': [], 'rejected': []}

    for good, bad in zip(GOOD_CANDIDATES, BAD_CANDIDATES):
        rows['prompt'].append([{'role': 'user', 'content': prompt_text}])
        rows['chosen'].append([{'role': 'assistant', 'content': serialize_candidate(good)}])
        rows['rejected'].append([{'role': 'assistant', 'content': serialize_candidate(bad)}])

    # Also add 5 reversed pairs (bad preferred over worse-bad with shuffled text)
    for i in range(5):
        good = GOOD_CANDIDATES[i]
        bad = BAD_CANDIDATES[(i + 1) % 5]
        rows['prompt'].append([{'role': 'user', 'content': prompt_text}])
        rows['chosen'].append([{'role': 'assistant', 'content': serialize_candidate(good)}])
        rows['rejected'].append([{'role': 'assistant', 'content': serialize_candidate(bad)}])

    return rows


# Small non-gated model for integration testing (fast download + train)
# Production uses google/gemma-2-9b-it (gated, requires HF license acceptance)
TEST_BASE_MODEL = 'Qwen/Qwen2.5-0.5B-Instruct'
MODEL_ID = 'test_reward_model'


class TestTrainOnModal:
    """Train on 10 examples via Modal GPU and verify metrics."""

    def test_train_returns_metrics(self):
        rows = _build_training_rows()
        result = train.remote(
            rows,
            base_model=TEST_BASE_MODEL,
            model_id=MODEL_ID,
            num_epochs=1,
            per_device_batch_size=2,
            max_length=2048,
        )

        assert result['model_id'] == MODEL_ID
        assert result['num_examples'] == 10
        assert result['train_loss'] is not None
        assert isinstance(result['train_loss'], float)
        print(f"Train loss: {result['train_loss']}")
        print(f"Metrics: {result['metrics']}")


class TestScoreOnModal:
    """Score candidates via Modal GPU after training."""

    def test_scores_are_floats(self):
        prompt_text = serialize_prompt(SEED, CONTEXT)
        all_candidates = GOOD_CANDIDATES[:2] + BAD_CANDIDATES[:2]
        conversations = [
            [
                {'role': 'user', 'content': prompt_text},
                {'role': 'assistant', 'content': serialize_candidate(c)},
            ]
            for c in all_candidates
        ]

        scores = score.remote(conversations, model_id=MODEL_ID)

        assert len(scores) == 4
        for s in scores:
            assert isinstance(s, float)
        print(f'Scores: good={scores[:2]}, bad={scores[2:]}')

    def test_good_scores_higher_than_bad(self):
        """After training, good candidates should score higher on average."""
        prompt_text = serialize_prompt(SEED, CONTEXT)

        good_convs = [
            [
                {'role': 'user', 'content': prompt_text},
                {'role': 'assistant', 'content': serialize_candidate(c)},
            ]
            for c in GOOD_CANDIDATES
        ]
        bad_convs = [
            [
                {'role': 'user', 'content': prompt_text},
                {'role': 'assistant', 'content': serialize_candidate(c)},
            ]
            for c in BAD_CANDIDATES
        ]

        good_scores = score.remote(good_convs, model_id=MODEL_ID)
        bad_scores = score.remote(bad_convs, model_id=MODEL_ID)

        avg_good = sum(good_scores) / len(good_scores)
        avg_bad = sum(bad_scores) / len(bad_scores)

        print(f'Avg good score: {avg_good:.4f}')
        print(f'Avg bad score: {avg_bad:.4f}')
        print(f'Good scores: {good_scores}')
        print(f'Bad scores: {bad_scores}')

        # With only 10 examples this might not always hold, but with
        # clear signal (good vs obviously bad) it should
        assert avg_good > avg_bad, (
            f'Expected good candidates to score higher: avg_good={avg_good:.4f} vs avg_bad={avg_bad:.4f}'
        )
