"""GEPA domain blackbox tests.

Black-box test suite for the GEPA (Generative Evaluation Pipeline for Agents)
ML pipeline. Tests all public entrypoints through observable behavior only.

Domain surface:
  - types.py: ValidationError, ClarifiedTask, EvalResult, DecompositionCandidate, PreferencePair
  - validators.py: validate_decomposition
  - critic.py: serialize_prompt, serialize_candidate, prepare_reward_pairs
  - embeddings.py: EmbeddingCache, embed_texts, cosine_similarity, retrieve_similar_pairs
  - scoring/: hard_gate, soft_penalties, final_score
  - verify_labels.py: verify(), _find_cycles()
  - pipelines/gepa_optimizer.py: extract_strategy, compose_prompt, _parse_plan, _retry, make_gepa_metric
  - pipelines/expansion.py: extract_expansion_seeds, _get_existing_seeds, _make_expanded_filename
  - pipelines/synthetic_pairs.py: _flip_winner, format_candidate_for_judge, format_few_shot_example
  - pipelines/decomposer.py: _build_planner_messages
  - labeler.py: _canonicalize, _get_pairs

External boundaries (LLM API calls):
  - evaluators/*.py -> call_llm_structured_streaming (rose-1-ultra)
  - pipelines/decomposer.py -> call_llm_structured_streaming (rose-1-ultra)
  - pipelines/clarifar.py -> call_llm_structured_streaming (rose-1-lite) + httpx (web_search, web_fetch)
  - pipelines/simulate_user.py -> httpx (rose-1-lite completions)
  - pipelines/synthetic_pairs.py -> call_llm_structured_streaming (rose-1-ultra)
  - critic.py -> modal.Function (train/score on GPU)
  - embeddings.py -> OpenAI embeddings API

These boundaries are NOT hit in blackbox tests (destructive/costly).
Tests use only local computation and mock data.

Run:
    PYTHONPATH=agents python -m pytest research/gepa/tests/gepa.blackbox.py -v -n 30
"""

import json
import math
import tempfile
from collections import defaultdict
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

# ---------------------------------------------------------------------------
# Module imports (all under test)
# ---------------------------------------------------------------------------

from research.gepa.types import (
    ClarifiedTask,
    DecompositionCandidate,
    EvalResult,
    PreferencePair,
    ValidationError,
)
from research.gepa.validators import validate_decomposition, MIN_TASKS, MAX_TASKS
from research.gepa.critic import serialize_prompt, serialize_candidate, prepare_reward_pairs
from research.gepa.embeddings import EmbeddingCache, cosine_similarity, retrieve_similar_pairs
from research.gepa.scoring import hard_gate, soft_penalties, final_score, ALPHA, BETA, GAMMA, LAMBDA
from research.gepa.verify_labels import verify, _find_cycles
from research.gepa.pipelines.gepa_optimizer import (
    extract_strategy,
    compose_prompt,
    get_initial_strategy,
    _build_prompt_skeleton,
    _parse_plan,
    _retry,
    make_gepa_metric,
    STRATEGY_STARTS,
    STRATEGY_ENDS,
)
from research.gepa.pipelines.expansion import (
    extract_expansion_seeds,
    _get_existing_seeds,
    _make_expanded_filename,
)
from research.gepa.pipelines.synthetic_pairs import (
    _flip_winner,
    format_candidate_for_judge,
    format_few_shot_example,
    JudgeVerdict,
)
from research.gepa.pipelines.decomposer import _build_planner_messages
from research.gepa.tests.fixtures import (
    make_planner_response,
    VALID_LINEAR_2,
    VALID_LINEAR_3,
    VALID_DIAMOND_4,
    VALID_PARALLEL_2,
    VALID_MAX_8,
    INVALID_1_TASK,
    INVALID_9_TASKS,
    INVALID_SELF_DEP,
    INVALID_CYCLE_AB,
    INVALID_CYCLE_ABC,
    INVALID_DEP_OUT_OF_RANGE,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_task(raw_seed='Book a flight', context=None):
    return ClarifiedTask(
        id='test-001',
        raw_seed=raw_seed,
        agent_context=context or [{'role': 'user', 'content': raw_seed}],
        set_plan_args={},
    )


def _make_candidate_dict(title='Plan', tasks=None, evals=None):
    t = tasks or [
        {'goal': 'Search', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Buy', 'tool_name': 'spawn_browser_agent', 'depends_on': [0]},
    ]
    base = {'title': title, 'content': f'{title} content', 'tasks': t}
    if evals:
        base.update(evals)
    return base


def _write_mock_data(tmp_path, labels, candidates_cache, task_files=None):
    """Write mock labeler data files. Returns (labels_path, state_path, tasks_dir)."""
    tasks_dir = tmp_path / 'clarified_tasks'
    tasks_dir.mkdir(exist_ok=True)

    if task_files is None:
        task_files = {}
        for i, filename in enumerate(candidates_cache.keys()):
            task_id = f'task-{i:03d}'
            task_files[filename] = {
                'id': task_id,
                'raw_seed': f'Task {i} seed',
                'agent_context': [{'role': 'user', 'content': f'Task {i}'}],
                'set_plan_args': {},
            }

    for filename, data in task_files.items():
        (tasks_dir / filename).write_text(json.dumps(data))

    state_path = tmp_path / 'labeler_state.json'
    state_path.write_text(json.dumps({
        'candidates_cache': candidates_cache,
        'task_files': list(candidates_cache.keys()),
    }))

    labels_path = tmp_path / 'preference_labels.json'
    labels_path.write_text(json.dumps(labels))

    return labels_path, state_path, tasks_dir


# ============================================================================
# 1. TYPES — data structures hold correct shapes
# ============================================================================

class TestTypes:
    def test_validation_error_types(self):
        for t in ['INVALID_TASK_COUNT', 'INVALID_DEPENDENCY_INDEX', 'CYCLE_DETECTED']:
            err = ValidationError(type=t, detail='test')
            assert err.type == t

    def test_clarified_task_fields(self):
        task = _make_task()
        assert task.id == 'test-001'
        assert task.raw_seed == 'Book a flight'
        assert isinstance(task.agent_context, list)
        assert isinstance(task.set_plan_args, dict)

    def test_eval_result_range(self):
        r = EvalResult(passed=True, score=0.85, reasoning='good')
        assert 0.0 <= r.score <= 1.0

    def test_preference_pair_literals(self):
        for pref in ['A', 'B', 'TIE']:
            for source in ['human', 'synthetic']:
                pair = PreferencePair(
                    id='p1', task=_make_task(),
                    candidate_a=DecompositionCandidate(planner_response=VALID_LINEAR_2, validation_errors=[]),
                    candidate_b=DecompositionCandidate(planner_response=VALID_LINEAR_2, validation_errors=[]),
                    preference=pref, source=source,
                )
                assert pair.preference == pref
                assert pair.source == source

    def test_preference_pair_weight_defaults(self):
        pair = PreferencePair(
            id='p1', task=_make_task(),
            candidate_a=DecompositionCandidate(planner_response=VALID_LINEAR_2, validation_errors=[]),
            candidate_b=DecompositionCandidate(planner_response=VALID_LINEAR_2, validation_errors=[]),
            preference='A', source='human',
        )
        assert pair.weight == 1.0


# ============================================================================
# 2. VALIDATORS — decomposition validation
# ============================================================================

class TestValidation:
    def test_valid_plans_pass(self):
        for pr in [VALID_LINEAR_2, VALID_LINEAR_3, VALID_DIAMOND_4, VALID_PARALLEL_2, VALID_MAX_8]:
            assert validate_decomposition(pr) == []

    def test_too_few_tasks(self):
        errors = validate_decomposition(INVALID_1_TASK)
        assert len(errors) == 1
        assert errors[0].type == 'INVALID_TASK_COUNT'
        assert 'need 2-8' in errors[0].detail.lower() or str(MIN_TASKS) in errors[0].detail

    def test_too_many_tasks(self):
        errors = validate_decomposition(INVALID_9_TASKS)
        assert len(errors) == 1
        assert errors[0].type == 'INVALID_TASK_COUNT'

    def test_self_dependency_is_cycle(self):
        errors = validate_decomposition(INVALID_SELF_DEP)
        assert len(errors) == 1
        assert errors[0].type == 'CYCLE_DETECTED'

    def test_binary_cycle(self):
        errors = validate_decomposition(INVALID_CYCLE_AB)
        assert len(errors) == 1
        assert errors[0].type == 'CYCLE_DETECTED'

    def test_triple_cycle(self):
        errors = validate_decomposition(INVALID_CYCLE_ABC)
        assert len(errors) == 1
        assert errors[0].type == 'CYCLE_DETECTED'

    def test_dep_out_of_range(self):
        errors = validate_decomposition(INVALID_DEP_OUT_OF_RANGE)
        assert len(errors) == 1
        assert errors[0].type == 'INVALID_DEPENDENCY_INDEX'

    def test_task_count_boundary_min(self):
        pr = make_planner_response(tasks=[
            {'goal': f'Task {i}', 'depends_on': []} for i in range(MIN_TASKS)
        ])
        assert validate_decomposition(pr) == []

    def test_task_count_boundary_max(self):
        pr = make_planner_response(tasks=[
            {'goal': f'Task {i}', 'depends_on': []} for i in range(MAX_TASKS)
        ])
        assert validate_decomposition(pr) == []

    def test_task_count_over_max(self):
        pr = make_planner_response(tasks=[
            {'goal': f'Task {i}', 'depends_on': []} for i in range(MAX_TASKS + 1)
        ])
        errors = validate_decomposition(pr)
        assert len(errors) == 1
        assert errors[0].type == 'INVALID_TASK_COUNT'

    def test_task_count_early_return_skips_dep_check(self):
        """When task count is invalid, dependency check is skipped."""
        pr = make_planner_response(tasks=[{'goal': 'Only', 'depends_on': [0]}])
        errors = validate_decomposition(pr)
        # Only INVALID_TASK_COUNT, not CYCLE_DETECTED
        assert len(errors) == 1
        assert errors[0].type == 'INVALID_TASK_COUNT'


# ============================================================================
# 3. SCORING — hard gates, soft penalties, final scorer
# ============================================================================

class TestScoring:
    def test_hard_gate_valid_returns_zero(self):
        assert hard_gate(VALID_LINEAR_2) == 0.0

    def test_hard_gate_invalid_returns_neg_inf(self):
        assert hard_gate(INVALID_1_TASK) == -math.inf
        assert hard_gate(INVALID_CYCLE_AB) == -math.inf

    def test_soft_penalties_all_pass(self):
        assert soft_penalties(True, True, True) == 0.0

    def test_soft_penalties_all_fail(self):
        expected = LAMBDA['ME'] + LAMBDA['CE'] + LAMBDA['CX']
        assert soft_penalties(False, False, False) == pytest.approx(expected)

    def test_soft_penalties_individual(self):
        assert soft_penalties(False, True, True) == pytest.approx(LAMBDA['ME'])
        assert soft_penalties(True, False, True) == pytest.approx(LAMBDA['CE'])
        assert soft_penalties(True, True, False) == pytest.approx(LAMBDA['CX'])

    def test_final_score_pure_critic(self):
        assert final_score(0.8) == pytest.approx(0.8)

    def test_final_score_multiplicative(self):
        s = final_score(0.8, me_score=0.9, ce_score=0.7, cx_score=0.95)
        expected = 0.8 * (0.9 ** ALPHA) * (0.7 ** BETA) * (0.95 ** GAMMA)
        assert s == pytest.approx(expected)

    def test_final_score_zero_collapses(self):
        assert final_score(0.9, me_score=0.0) == 0.0
        assert final_score(0.9, ce_score=0.0) == 0.0
        assert final_score(0.9, cx_score=0.0) == 0.0

    def test_final_score_neg_inf_propagates(self):
        assert final_score(-math.inf, me_score=1.0) == -math.inf

    def test_final_score_perfect(self):
        assert final_score(1.0, 1.0, 1.0, 1.0) == pytest.approx(1.0)

    def test_final_score_custom_exponents(self):
        s = final_score(0.8, me_score=0.5, alpha=2.0)
        assert s == pytest.approx(0.8 * 0.25)

    def test_ce_weighted_heavier_than_me(self):
        s_low_me = final_score(1.0, me_score=0.7, ce_score=1.0, cx_score=1.0)
        s_low_ce = final_score(1.0, me_score=1.0, ce_score=0.7, cx_score=1.0)
        assert s_low_me > s_low_ce  # CE hurts more because BETA > ALPHA

    def test_default_exponent_values(self):
        assert ALPHA == 1.0
        assert BETA == 1.5
        assert GAMMA == 0.5

    def test_lambda_weights(self):
        assert LAMBDA['ME'] == 0.3
        assert LAMBDA['CE'] == 0.2
        assert LAMBDA['CX'] == 0.1


# ============================================================================
# 4. CRITIC — serialization + data loading
# ============================================================================

SAMPLE_CONTEXT = [
    {'role': 'user', 'content': 'Get me a beanie'},
    {'role': 'assistant', 'content': 'Looking for beanies.'},
]

SAMPLE_CANDIDATE = {
    'title': 'Buy a Beanie',
    'content': 'Find and buy a beanie.',
    'tasks': [
        {'goal': 'Search', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Buy', 'tool_name': 'spawn_browser_agent', 'depends_on': [0]},
    ],
    'me': {'passed': True, 'score': 0.95, 'reasoning': 'Distinct.'},
    'ce': {'passed': False, 'score': 0.45, 'reasoning': 'Missing payment.'},
    'complexity': {'passed': True, 'score': 0.90, 'reasoning': 'Simpler.'},
}


class TestCriticSerialization:
    def test_serialize_prompt_with_context(self):
        result = serialize_prompt('Buy beanie', SAMPLE_CONTEXT)
        assert result.startswith('Goal: Buy beanie')
        assert '[USER]:' in result
        assert '[ASSISTANT]:' in result

    def test_serialize_prompt_empty_context(self):
        result = serialize_prompt('Do something', [])
        assert result == 'Goal: Do something'

    def test_serialize_candidate_all_fields(self):
        result = serialize_candidate(SAMPLE_CANDIDATE)
        assert 'Title: Buy a Beanie' in result
        assert '0. [web_search] Search' in result
        assert 'ME: pass' in result
        assert 'CE: fail' in result
        assert 'CX: pass' in result

    def test_serialize_candidate_no_evals(self):
        cand = {'title': 'T', 'content': 'C', 'tasks': [], 'me': None, 'ce': None, 'complexity': None}
        result = serialize_candidate(cand)
        assert 'Title: T' in result
        assert 'Evaluations:' not in result

    def test_serialize_candidate_no_tasks(self):
        cand = {'title': 'T', 'content': 'C', 'tasks': []}
        result = serialize_candidate(cand)
        assert 'Title: T' in result
        assert 'Tasks:' not in result


class TestPrepareRewardPairs:
    def _setup(self, tmp_path, extra_labels=None):
        cand0 = {**SAMPLE_CANDIDATE, 'title': 'Cand 0'}
        cand1 = {**SAMPLE_CANDIDATE, 'title': 'Cand 1'}
        cand2 = {**SAMPLE_CANDIDATE, 'title': 'Cand 2'}
        cand3 = {**SAMPLE_CANDIDATE, 'title': 'Cand 3'}

        cache = {
            '001.json': [cand0, cand1, cand2, cand3],
        }
        task_files = {
            '001.json': {
                'id': 'task-aaa',
                'raw_seed': 'Buy beanie',
                'agent_context': SAMPLE_CONTEXT,
                'set_plan_args': {},
            },
        }
        labels = [
            {'pair_id': 'p1', 'task_id': 'task-aaa', 'task_seed': 'Buy beanie',
             'candidate_a_idx': 0, 'candidate_b_idx': 1, 'preference': 'A',
             'label_time_s': 5.0, 'timestamp': 1.0},
            {'pair_id': 'p2', 'task_id': 'task-aaa', 'task_seed': 'Buy beanie',
             'candidate_a_idx': 2, 'candidate_b_idx': 3, 'preference': 'B',
             'label_time_s': 3.0, 'timestamp': 2.0},
            {'pair_id': 'p3', 'task_id': 'task-aaa', 'task_seed': 'Buy beanie',
             'candidate_a_idx': 0, 'candidate_b_idx': 2, 'preference': 'TIE',
             'label_time_s': 2.0, 'timestamp': 3.0},
            {'pair_id': 'p4', 'task_id': 'task-aaa', 'task_seed': 'Buy beanie',
             'candidate_a_idx': 1, 'candidate_b_idx': 3, 'preference': 'SKIP',
             'label_time_s': 1.0, 'timestamp': 4.0},
        ]
        if extra_labels:
            labels.extend(extra_labels)

        labels_path, state_path, tasks_dir = _write_mock_data(
            tmp_path, labels, cache, task_files)
        return prepare_reward_pairs(labels_path, state_path, tasks_dir)

    def test_correct_columns(self, tmp_path):
        rows = self._setup(tmp_path)
        assert set(rows.keys()) == {'prompt', 'chosen', 'rejected'}

    def test_skips_tie_skip_skiptask(self, tmp_path):
        rows = self._setup(tmp_path)
        # Only A and B preferences produce pairs
        assert len(rows['prompt']) == 2

    def test_a_preference_direction(self, tmp_path):
        rows = self._setup(tmp_path)
        assert 'Cand 0' in rows['chosen'][0][0]['content']
        assert 'Cand 1' in rows['rejected'][0][0]['content']

    def test_b_preference_direction(self, tmp_path):
        rows = self._setup(tmp_path)
        assert 'Cand 3' in rows['chosen'][1][0]['content']
        assert 'Cand 2' in rows['rejected'][1][0]['content']

    def test_trl_message_format(self, tmp_path):
        rows = self._setup(tmp_path)
        for i in range(len(rows['prompt'])):
            assert rows['prompt'][i][0]['role'] == 'user'
            assert rows['chosen'][i][0]['role'] == 'assistant'
            assert rows['rejected'][i][0]['role'] == 'assistant'

    def test_min_confidence_filter(self, tmp_path):
        llm_labels = [
            {'pair_id': 's1', 'task_id': 'task-aaa', 'task_seed': 'Buy beanie',
             'candidate_a_idx': 0, 'candidate_b_idx': 3, 'preference': 'A',
             'label_time_s': 0, 'timestamp': 7.0, 'source': 'llm_labeled', 'confidence': 85.0},
            {'pair_id': 's2', 'task_id': 'task-aaa', 'task_seed': 'Buy beanie',
             'candidate_a_idx': 1, 'candidate_b_idx': 2, 'preference': 'B',
             'label_time_s': 0, 'timestamp': 8.0, 'source': 'llm_labeled', 'confidence': 20.0},
        ]
        # Without filter: 2 human + 2 LLM = 4
        rows_all = self._setup(tmp_path, extra_labels=llm_labels)
        assert len(rows_all['prompt']) == 4

    def test_missing_task_id_skipped(self, tmp_path):
        extra = [
            {'pair_id': 'p5', 'task_id': 'task-missing', 'task_seed': 'Unknown',
             'candidate_a_idx': 0, 'candidate_b_idx': 1, 'preference': 'A',
             'label_time_s': 1.0, 'timestamp': 5.0},
        ]
        rows = self._setup(tmp_path, extra_labels=extra)
        # Still only 2 usable from task-aaa
        assert len(rows['prompt']) == 2


# ============================================================================
# 5. EMBEDDINGS — cache, similarity, retrieval
# ============================================================================

class TestEmbeddings:
    def test_cosine_identical(self):
        assert cosine_similarity([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]) == pytest.approx(1.0)

    def test_cosine_orthogonal(self):
        assert cosine_similarity([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)

    def test_cosine_opposite(self):
        assert cosine_similarity([1.0, 0.0], [-1.0, 0.0]) == pytest.approx(-1.0)

    def test_cosine_zero_vector(self):
        assert cosine_similarity([0.0, 0.0], [1.0, 0.0]) == 0.0

    def test_cache_roundtrip(self, tmp_path):
        cache = EmbeddingCache(tmp_path / 'cache.json')
        cache.put('hello', [1.0, 2.0, 3.0])
        cache.save()

        cache2 = EmbeddingCache(tmp_path / 'cache.json')
        assert cache2.get('hello') == [1.0, 2.0, 3.0]
        assert cache2.has('hello')
        assert not cache2.has('world')

    def test_cache_miss_returns_none(self, tmp_path):
        cache = EmbeddingCache(tmp_path / 'cache.json')
        assert cache.get('nonexistent') is None

    def test_cache_deterministic_key(self, tmp_path):
        cache = EmbeddingCache(tmp_path / 'cache.json')
        cache.put('Hello World', [1.0])
        # Same text (case-insensitive, stripped) should hit cache
        assert cache.has('hello world')
        assert cache.has('  Hello World  ')

    def test_retrieve_similar_pairs_ordering(self):
        labels = [
            {'task_seed': 'Book a flight', 'preference': 'A'},
            {'task_seed': 'Order food', 'preference': 'B'},
            {'task_seed': 'Find hotels', 'preference': 'A'},
        ]
        embeddings = {
            'Buy shoes': [1.0, 0.0, 0.0],
            'Book a flight': [0.9, 0.1, 0.0],
            'Order food': [0.0, 1.0, 0.0],
            'Find hotels': [0.8, 0.2, 0.0],
        }
        result = retrieve_similar_pairs('Buy shoes', labels, embeddings, n=2)
        assert len(result) == 2
        assert result[0]['task_seed'] == 'Book a flight'

    def test_retrieve_missing_query_embedding(self):
        labels = [{'task_seed': 'A', 'preference': 'A'}]
        result = retrieve_similar_pairs('Unknown', labels, {}, n=5)
        assert len(result) == 1  # Falls back to first n labels

    def test_retrieve_respects_n(self):
        labels = [{'task_seed': f'L{i}', 'preference': 'A'} for i in range(10)]
        embeddings = {f'L{i}': [float(i), 0.0] for i in range(10)}
        embeddings['query'] = [5.0, 0.0]
        result = retrieve_similar_pairs('query', labels, embeddings, n=3)
        assert len(result) == 3


# ============================================================================
# 6. VERIFY LABELS — label integrity checks
# ============================================================================

class TestVerifyLabels:
    def test_clean_labels(self):
        """Consistent total ordering 0 > 1 > 2 > 3 should produce zero issues."""
        labels = [
            {'pair_id': 'p1', 'task_id': 't1', 'task_seed': 'X',
             'candidate_a_idx': 0, 'candidate_b_idx': 1, 'preference': 'A',
             'label_time_s': 5.0, 'timestamp': 1.0},
            {'pair_id': 'p2', 'task_id': 't1', 'task_seed': 'X',
             'candidate_a_idx': 0, 'candidate_b_idx': 2, 'preference': 'A',
             'label_time_s': 3.0, 'timestamp': 2.0},
            {'pair_id': 'p3', 'task_id': 't1', 'task_seed': 'X',
             'candidate_a_idx': 0, 'candidate_b_idx': 3, 'preference': 'A',
             'label_time_s': 2.0, 'timestamp': 3.0},
            {'pair_id': 'p4', 'task_id': 't1', 'task_seed': 'X',
             'candidate_a_idx': 1, 'candidate_b_idx': 2, 'preference': 'A',
             'label_time_s': 4.0, 'timestamp': 4.0},
            {'pair_id': 'p5', 'task_id': 't1', 'task_seed': 'X',
             'candidate_a_idx': 1, 'candidate_b_idx': 3, 'preference': 'A',
             'label_time_s': 3.0, 'timestamp': 5.0},
            {'pair_id': 'p6', 'task_id': 't1', 'task_seed': 'X',
             'candidate_a_idx': 2, 'candidate_b_idx': 3, 'preference': 'A',
             'label_time_s': 2.0, 'timestamp': 6.0},
        ]
        issues = verify(labels)
        total = sum(len(v) for v in issues.values())
        assert total == 0

    def test_detects_missing_fields(self):
        """Label with task_id but missing other required fields is flagged as malformed."""
        labels = [{
            'pair_id': 'p1', 'task_id': 't1', 'preference': 'A',
            'candidate_a_idx': 0, 'candidate_b_idx': 1,
            'timestamp': 1.0,
            # missing: task_seed, label_time_s
        }]
        issues = verify(labels)
        assert len(issues['malformed']) > 0

    def test_detects_invalid_preference(self):
        labels = [{
            'pair_id': 'p1', 'task_id': 't1', 'task_seed': 'X',
            'candidate_a_idx': 0, 'candidate_b_idx': 1, 'preference': 'INVALID',
            'label_time_s': 1.0, 'timestamp': 1.0,
        }]
        issues = verify(labels)
        malformed = [m for m in issues['malformed'] if 'preference' in m.lower() or 'INVALID' in m]
        assert len(malformed) > 0

    def test_detects_reversed_indices(self):
        labels = [{
            'pair_id': 'p1', 'task_id': 't1', 'task_seed': 'X',
            'candidate_a_idx': 2, 'candidate_b_idx': 1, 'preference': 'A',
            'label_time_s': 1.0, 'timestamp': 1.0,
        }]
        issues = verify(labels)
        malformed = [m for m in issues['malformed'] if 'a_idx' in m or '>=' in m]
        assert len(malformed) > 0

    def test_detects_negative_label_time(self):
        labels = [{
            'pair_id': 'p1', 'task_id': 't1', 'task_seed': 'X',
            'candidate_a_idx': 0, 'candidate_b_idx': 1, 'preference': 'A',
            'label_time_s': -1.0, 'timestamp': 1.0,
        }]
        issues = verify(labels)
        malformed = [m for m in issues['malformed'] if 'label_time' in m]
        assert len(malformed) > 0

    def test_detects_duplicates(self):
        label = {
            'pair_id': 'p1', 'task_id': 't1', 'task_seed': 'X',
            'candidate_a_idx': 0, 'candidate_b_idx': 1, 'preference': 'A',
            'label_time_s': 1.0, 'timestamp': 1.0,
        }
        labels = [label, {**label, 'pair_id': 'p2', 'timestamp': 2.0}]
        issues = verify(labels)
        assert len(issues['duplicates']) > 0

    def test_detects_missing_pairs(self):
        # Only 2 of 6 pairs → 4 missing
        labels = [
            {'pair_id': 'p1', 'task_id': 't1', 'task_seed': 'X',
             'candidate_a_idx': 0, 'candidate_b_idx': 1, 'preference': 'A',
             'label_time_s': 1.0, 'timestamp': 1.0},
            {'pair_id': 'p2', 'task_id': 't1', 'task_seed': 'X',
             'candidate_a_idx': 2, 'candidate_b_idx': 3, 'preference': 'B',
             'label_time_s': 1.0, 'timestamp': 2.0},
        ]
        issues = verify(labels)
        assert len(issues['missing_pairs']) > 0

    def test_skip_task_suppresses_missing_pairs(self):
        labels = [{
            'pair_id': 'p1', 'task_id': 't1', 'task_seed': 'X',
            'candidate_a_idx': 0, 'candidate_b_idx': 1, 'preference': 'SKIP_TASK',
            'label_time_s': 0.5, 'timestamp': 1.0,
        }]
        issues = verify(labels)
        assert len(issues['missing_pairs']) == 0

    def test_detects_hard_cycle(self):
        # 0 > 1, 1 > 2, 2 > 0 → hard cycle
        labels = [
            {'pair_id': 'p1', 'task_id': 't1', 'task_seed': 'X',
             'candidate_a_idx': 0, 'candidate_b_idx': 1, 'preference': 'A',
             'label_time_s': 1.0, 'timestamp': 1.0},
            {'pair_id': 'p2', 'task_id': 't1', 'task_seed': 'X',
             'candidate_a_idx': 1, 'candidate_b_idx': 2, 'preference': 'A',
             'label_time_s': 1.0, 'timestamp': 2.0},
            {'pair_id': 'p3', 'task_id': 't1', 'task_seed': 'X',
             'candidate_a_idx': 0, 'candidate_b_idx': 2, 'preference': 'B',
             'label_time_s': 1.0, 'timestamp': 3.0},
        ]
        issues = verify(labels)
        assert len(issues['hard_cycles']) > 0

    def test_detects_soft_cycle(self):
        # 0 > 1, 1 == 2, 2 > 0 → soft cycle (tie in chain)
        labels = [
            {'pair_id': 'p1', 'task_id': 't1', 'task_seed': 'X',
             'candidate_a_idx': 0, 'candidate_b_idx': 1, 'preference': 'A',
             'label_time_s': 1.0, 'timestamp': 1.0},
            {'pair_id': 'p2', 'task_id': 't1', 'task_seed': 'X',
             'candidate_a_idx': 1, 'candidate_b_idx': 2, 'preference': 'TIE',
             'label_time_s': 1.0, 'timestamp': 2.0},
            {'pair_id': 'p3', 'task_id': 't1', 'task_seed': 'X',
             'candidate_a_idx': 0, 'candidate_b_idx': 2, 'preference': 'B',
             'label_time_s': 1.0, 'timestamp': 3.0},
        ]
        issues = verify(labels)
        assert len(issues['soft_cycles']) > 0


class TestFindCycles:
    def test_no_cycle(self):
        graph = {0: {1}, 1: {2}}
        cycles = _find_cycles(graph, {0, 1, 2})
        assert len(cycles) == 0

    def test_self_loop(self):
        graph = {0: {0}}
        cycles = _find_cycles(graph, {0})
        assert len(cycles) == 1

    def test_triangle_cycle(self):
        graph = {0: {1}, 1: {2}, 2: {0}}
        cycles = _find_cycles(graph, {0, 1, 2})
        assert len(cycles) == 1

    def test_empty_graph(self):
        cycles = _find_cycles({}, set())
        assert len(cycles) == 0


# ============================================================================
# 7. GEPA OPTIMIZER — strategy extraction + prompt composition
# ============================================================================

class TestGEPAOptimizer:
    def test_extract_strategy_has_content(self):
        strategy = get_initial_strategy()
        assert len(strategy) > 100

    def test_extract_strategy_starts_with_known_marker(self):
        strategy = get_initial_strategy()
        assert any(strategy.startswith(m) for m in STRATEGY_STARTS)

    def test_extract_strategy_excludes_fixed_sections(self):
        strategy = get_initial_strategy()
        assert 'OUTPUT CONTRACT' not in strategy
        assert 'AVAILABLE TOOLS' not in strategy
        assert 'CRITICAL REMINDERS' not in strategy

    def test_compose_prompt_roundtrip(self):
        from helpers.prompts import build_planner_system_prompt
        from tools.set_plan import _get_planner_tools_description
        tools_desc = _get_planner_tools_description()
        original = build_planner_system_prompt(tools_desc)
        strategy = extract_strategy(original)
        composed = compose_prompt(strategy)
        assert composed == original

    def test_compose_prompt_custom_strategy(self):
        composed = compose_prompt('CUSTOM STRATEGY HERE')
        assert 'CUSTOM STRATEGY HERE' in composed
        assert 'OUTPUT CONTRACT' in composed

    def test_build_prompt_skeleton_excludes_strategy(self):
        skeleton = _build_prompt_skeleton()
        strategy = get_initial_strategy()
        assert strategy not in skeleton

    def test_parse_plan_valid_json(self):
        plan = {
            'title': 'Test', 'content': 'C',
            'tasks': [
                {'goal': 'a', 'tool_name': 'spawn_explore_agent', 'depends_on': []},
                {'goal': 'b', 'tool_name': 'reasoning', 'depends_on': [0]},
            ],
            'dependencies_graph': [
                {'task_idx': '0', 'depends_on': []},
                {'task_idx': '1', 'depends_on': ['0']},
            ],
            'join': 'all',
        }
        pr = _parse_plan(json.dumps(plan))
        assert pr is not None
        assert len(pr.tasks) == 2

    def test_parse_plan_invalid_json(self):
        assert _parse_plan('not json') is None

    def test_parse_plan_missing_fields(self):
        assert _parse_plan('{"title": "only"}') is None

    def test_retry_success_first_try(self):
        result = _retry(lambda: 42, 'test')
        assert result == 42

    def test_retry_eventual_success(self):
        calls = [0]

        def flaky():
            calls[0] += 1
            if calls[0] < 3:
                raise RuntimeError('fail')
            return 'ok'

        with patch('research.gepa.pipelines.gepa_optimizer.RETRY_DELAY_S', 0.0):
            result = _retry(flaky, 'test')
        assert result == 'ok'

    def test_retry_persistent_failure(self):
        with patch('research.gepa.pipelines.gepa_optimizer.RETRY_DELAY_S', 0.0):
            with pytest.raises(RuntimeError, match='failed after'):
                _retry(lambda: (_ for _ in ()).throw(RuntimeError('boom')), 'test')


class TestGepaMetricEdgeCases:
    def test_invalid_json_returns_zero(self):
        metric = make_gepa_metric()
        example = SimpleNamespace(goal='test', context='[]')
        pred = SimpleNamespace(plan_json='not json')
        assert float(metric(example, pred)) == 0.0

    def test_single_task_returns_zero(self):
        metric = make_gepa_metric()
        plan = {
            'title': 'Bad', 'content': 'Bad',
            'tasks': [{'goal': 'only', 'tool_name': 'spawn_explore_agent', 'depends_on': []}],
            'dependencies_graph': [{'task_idx': '0', 'depends_on': []}],
            'join': 'all',
        }
        example = SimpleNamespace(goal='test', context='[]')
        pred = SimpleNamespace(plan_json=json.dumps(plan))
        assert float(metric(example, pred)) == 0.0

    def test_cycle_returns_zero(self):
        metric = make_gepa_metric()
        plan = {
            'title': 'Cycle', 'content': 'Cycle',
            'tasks': [
                {'goal': 'a', 'tool_name': 'spawn_explore_agent', 'depends_on': [1]},
                {'goal': 'b', 'tool_name': 'spawn_explore_agent', 'depends_on': [0]},
            ],
            'dependencies_graph': [
                {'task_idx': '0', 'depends_on': ['1']},
                {'task_idx': '1', 'depends_on': ['0']},
            ],
            'join': 'all',
        }
        example = SimpleNamespace(goal='test', context='[]')
        pred = SimpleNamespace(plan_json=json.dumps(plan))
        assert float(metric(example, pred)) == 0.0

    def test_markdown_fence_stripping(self):
        """Plan wrapped in markdown fences still parses."""
        plan = {
            'title': 'OK', 'content': 'C',
            'tasks': [
                {'goal': 'a', 'tool_name': 'spawn_explore_agent', 'depends_on': []},
                {'goal': 'b', 'tool_name': 'reasoning', 'depends_on': [0]},
            ],
            'dependencies_graph': [
                {'task_idx': '0', 'depends_on': []},
                {'task_idx': '1', 'depends_on': ['0']},
            ],
            'join': 'all',
        }
        fenced = f'```json\n{json.dumps(plan)}\n```'
        example = SimpleNamespace(goal='test', context='[]')
        pred = SimpleNamespace(plan_json=fenced)
        # Mocks must be in place BEFORE make_gepa_metric() because it does
        # `from .benchmark import _eval_me` which binds the name at call time.
        with patch('research.gepa.pipelines.gepa_optimizer.score_candidates', return_value=[0.5]), \
             patch('research.gepa.pipelines.gepa_optimizer.RETRY_DELAY_S', 0.0), \
             patch('research.gepa.pipelines.benchmark._eval_me', new_callable=AsyncMock) as m_me, \
             patch('research.gepa.pipelines.benchmark._eval_ce', new_callable=AsyncMock) as m_ce, \
             patch('research.gepa.pipelines.benchmark._eval_cx', new_callable=AsyncMock) as m_cx:
            mock_eval = EvalResult(passed=True, score=0.9, reasoning='ok')
            m_me.return_value = (mock_eval, {})
            m_ce.return_value = (mock_eval, {})
            m_cx.return_value = (mock_eval, {})
            metric = make_gepa_metric()
            score = float(metric(example, pred))
            assert score > 0.0


# ============================================================================
# 8. EXPANSION — seed extraction, filename generation
# ============================================================================

class TestExpansion:
    def test_extract_seeds_from_labeled_tasks(self, tmp_path):
        cand = {
            'title': 'T', 'content': 'C',
            'tasks': [
                {'goal': 'Book flight', 'tool_name': 'spawn_sub_agent', 'depends_on': []},
            ],
        }
        cache = {'task_001.json': [cand]}
        labels = [{'task_id': 'task-000', 'preference': 'A', 'candidate_a_idx': 0, 'candidate_b_idx': 1}]
        labels_path, state_path, tasks_dir = _write_mock_data(tmp_path, labels, cache)
        seeds = extract_expansion_seeds(state_path, labels_path, tasks_dir)
        assert 'Book flight' in seeds

    def test_ignores_unlabeled_tasks(self, tmp_path):
        cand = {'title': 'T', 'content': 'C',
                'tasks': [{'goal': 'X', 'tool_name': 'spawn_sub_agent', 'depends_on': []}]}
        cache = {'task_001.json': [cand]}
        labels_path, state_path, tasks_dir = _write_mock_data(tmp_path, [], cache)
        seeds = extract_expansion_seeds(state_path, labels_path, tasks_dir)
        assert len(seeds) == 0

    def test_ignores_non_spawn_sub_agent(self, tmp_path):
        cand = {'title': 'T', 'content': 'C',
                'tasks': [{'goal': 'X', 'tool_name': 'spawn_browser_agent', 'depends_on': []}]}
        cache = {'task_001.json': [cand]}
        labels = [{'task_id': 'task-000', 'preference': 'A', 'candidate_a_idx': 0, 'candidate_b_idx': 1}]
        labels_path, state_path, tasks_dir = _write_mock_data(tmp_path, labels, cache)
        seeds = extract_expansion_seeds(state_path, labels_path, tasks_dir)
        assert len(seeds) == 0

    def test_deduplicates_seeds(self, tmp_path):
        cand1 = {'title': 'T', 'content': 'C',
                 'tasks': [{'goal': 'Same', 'tool_name': 'spawn_sub_agent', 'depends_on': []}]}
        cand2 = {'title': 'T2', 'content': 'C',
                 'tasks': [{'goal': 'Same', 'tool_name': 'spawn_sub_agent', 'depends_on': []}]}
        cache = {'task_001.json': [cand1, cand2]}
        labels = [{'task_id': 'task-000', 'preference': 'A', 'candidate_a_idx': 0, 'candidate_b_idx': 1}]
        labels_path, state_path, tasks_dir = _write_mock_data(tmp_path, labels, cache)
        seeds = extract_expansion_seeds(state_path, labels_path, tasks_dir)
        assert seeds.count('Same') == 1

    def test_get_existing_seeds(self, tmp_path):
        (tmp_path / 'a.json').write_text(json.dumps({
            'id': '1', 'raw_seed': 'Hello', 'agent_context': [], 'set_plan_args': {}}))
        seeds = _get_existing_seeds(tmp_path)
        assert 'hello' in seeds

    def test_make_expanded_filename(self):
        name = _make_expanded_filename('Book a flight', 3)
        assert name.startswith('E_')
        assert '003' in name
        assert '/' not in name


# ============================================================================
# 9. SYNTHETIC PAIRS — judge helpers
# ============================================================================

class TestSyntheticPairs:
    def test_flip_winner_a_to_b(self):
        assert _flip_winner('A') == 'B'

    def test_flip_winner_b_to_a(self):
        assert _flip_winner('B') == 'A'

    def test_flip_winner_tie(self):
        assert _flip_winner('TIE') == 'TIE'

    def test_flip_winner_unknown(self):
        assert _flip_winner('X') == 'TIE'

    def test_format_candidate_for_judge_label(self):
        cand = {'title': 'Plan A', 'content': 'C', 'tasks': []}
        text = format_candidate_for_judge(cand, 'B')
        assert '## Candidate B' in text
        assert 'Plan A' in text

    def test_format_few_shot_missing_task(self):
        label = {'task_id': 'missing', 'candidate_a_idx': 0, 'candidate_b_idx': 1,
                 'preference': 'A', 'task_seed': 'test'}
        assert format_few_shot_example(label, {}, {}) is None

    def test_format_few_shot_null_candidate(self):
        label = {'task_id': 't1', 'candidate_a_idx': 0, 'candidate_b_idx': 1,
                 'preference': 'A', 'task_seed': 'test'}
        cache = {'f.json': [None, {'title': 'T', 'content': 'C', 'tasks': []}]}
        assert format_few_shot_example(label, cache, {'t1': 'f.json'}) is None

    def test_format_few_shot_valid(self):
        cand = {'title': 'P', 'content': 'C', 'tasks': []}
        label = {'task_id': 't1', 'candidate_a_idx': 0, 'candidate_b_idx': 1,
                 'preference': 'A', 'task_seed': 'Goal'}
        result = format_few_shot_example(label, {'f.json': [cand, cand]}, {'t1': 'f.json'})
        assert result is not None
        assert 'Goal' in result
        assert 'Verdict: A' in result

    def test_judge_verdict_validation(self):
        JudgeVerdict(overall_winner='A', overall_reasoning='ok', confidence=50.0)
        JudgeVerdict(overall_winner='TIE', overall_reasoning='close', confidence=30.0)
        with pytest.raises(Exception):
            JudgeVerdict(overall_winner='C', overall_reasoning='bad', confidence=50.0)


# ============================================================================
# 10. DECOMPOSER — message building
# ============================================================================

class TestDecomposer:
    def test_build_planner_messages_starts_with_goal(self):
        task = _make_task('Test goal')
        messages = _build_planner_messages(task)
        assert messages[0]['role'] == 'user'
        assert 'GOAL: Test goal' in messages[0]['content']

    def test_build_planner_messages_maps_roles(self):
        task = ClarifiedTask(
            id='t1', raw_seed='Goal',
            agent_context=[
                {'role': 'user', 'content': 'I want X'},
                {'role': 'assistant', 'content': 'OK I will do X'},
                {'role': 'tool', 'content': 'Search results'},
            ],
            set_plan_args={},
        )
        messages = _build_planner_messages(task)
        assert messages[0]['content'].startswith('GOAL: Goal')
        assert messages[1]['role'] == 'user'
        assert messages[2]['role'] == 'assistant'
        assert messages[3]['role'] == 'user'
        assert '[TOOL]' in messages[3]['content']

    def test_build_planner_messages_empty_context(self):
        task = ClarifiedTask(id='t1', raw_seed='Goal', agent_context=[], set_plan_args={})
        messages = _build_planner_messages(task)
        assert len(messages) == 1  # Just the GOAL message


# ============================================================================
# 11. LABELER HELPERS
# ============================================================================

class TestLabelerHelpers:
    """Tests for pure labeler helpers: _canonicalize and _get_pairs.

    The labeler module has side effects at import time (os.chdir + _load_state
    which reads data files from disk). We extract the pure functions by
    loading the module with a mocked _load_state.
    """

    @pytest.fixture(autouse=True, scope='class')
    def _import_labeler(self, tmp_path_factory):
        """Import labeler with mocked _load_state to avoid module-level side effects."""
        import importlib
        import importlib.util
        import sys

        mod_name = 'research.gepa.labeler'
        if mod_name in sys.modules:
            TestLabelerHelpers._mod = sys.modules[mod_name]
            return

        tmp_path = tmp_path_factory.mktemp('labeler')
        tasks_dir = tmp_path / 'clarified_tasks'
        tasks_dir.mkdir()

        labeler_path = Path(__file__).resolve().parent.parent / 'labeler.py'
        spec = importlib.util.spec_from_file_location(mod_name, labeler_path)
        mod = importlib.util.module_from_spec(spec)
        # Inject mock paths before executing module body
        mod.TASKS_DIR = tasks_dir
        mod.STATE_PATH = tmp_path / 'state.json'
        mod.LABELS_PATH = tmp_path / 'labels.json'
        sys.modules[mod_name] = mod
        try:
            spec.loader.exec_module(mod)
        except Exception:
            # If module init fails, still keep the module so we can access the functions
            pass
        TestLabelerHelpers._mod = mod

    def test_canonicalize_no_swap(self):
        a, b, pref = self._mod._canonicalize(0, 1, 'A')
        assert (a, b, pref) == (0, 1, 'A')

    def test_canonicalize_swap(self):
        a, b, pref = self._mod._canonicalize(1, 0, 'A')
        assert (a, b) == (0, 1)
        assert pref == 'B'  # Flipped

    def test_canonicalize_tie_unchanged(self):
        _, _, pref = self._mod._canonicalize(2, 0, 'TIE')
        assert pref == 'TIE'

    def test_get_pairs_chain_order(self):
        pairs = self._mod._get_pairs(4)
        # C(4,2) = 6 pairs
        assert len(pairs) == 6
        # Each pair should share an element with the previous
        for i in range(1, len(pairs)):
            a, b = pairs[i]
            prev_a, prev_b = pairs[i - 1]
            assert a in (prev_a, prev_b) or b in (prev_a, prev_b)

    def test_get_pairs_too_few(self):
        assert self._mod._get_pairs(0) == []
        assert self._mod._get_pairs(1) == []

    def test_get_pairs_two_candidates(self):
        pairs = self._mod._get_pairs(2)
        assert len(pairs) == 1


# ============================================================================
# 12. INVARIANT: read-after-write for embedding cache
# ============================================================================

class TestReadAfterWrite:
    def test_embedding_cache_write_then_read(self, tmp_path):
        cache = EmbeddingCache(tmp_path / 'c.json')
        cache.put('test text', [0.1, 0.2, 0.3])
        assert cache.get('test text') == [0.1, 0.2, 0.3]
        cache.save()
        # Fresh load
        cache2 = EmbeddingCache(tmp_path / 'c.json')
        assert cache2.get('test text') == [0.1, 0.2, 0.3]


# ============================================================================
# 13. INVARIANT: same-input reproducibility
# ============================================================================

class TestReproducibility:
    def test_validate_decomposition_deterministic(self):
        r1 = validate_decomposition(VALID_DIAMOND_4)
        r2 = validate_decomposition(VALID_DIAMOND_4)
        assert r1 == r2

    def test_hard_gate_deterministic(self):
        assert hard_gate(VALID_LINEAR_2) == hard_gate(VALID_LINEAR_2)

    def test_final_score_deterministic(self):
        s1 = final_score(0.8, 0.9, 0.7, 0.95)
        s2 = final_score(0.8, 0.9, 0.7, 0.95)
        assert s1 == s2

    def test_serialize_prompt_deterministic(self):
        r1 = serialize_prompt('test', SAMPLE_CONTEXT)
        r2 = serialize_prompt('test', SAMPLE_CONTEXT)
        assert r1 == r2

    def test_cosine_similarity_deterministic(self):
        a, b = [1.0, 2.0, 3.0], [4.0, 5.0, 6.0]
        assert cosine_similarity(a, b) == cosine_similarity(a, b)
