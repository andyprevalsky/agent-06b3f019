"""Unit tests for the reward model critic (no model downloads)."""

import json
import tempfile
from pathlib import Path

import pytest

from research.gepa.critic import (
    prepare_reward_pairs,
    serialize_candidate,
    serialize_prompt,
)


# --- Test data ---

SAMPLE_CONTEXT = [
    {'role': 'user', 'content': 'Get me a black beanie'},
    {'role': 'assistant', 'content': 'I will find you a black beanie.'},
]

SAMPLE_CANDIDATE = {
    'title': 'Buy a Black Beanie',
    'content': 'Find and purchase a black beanie from Amazon.',
    'tasks': [
        {'goal': 'Search for black beanies', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Buy the best one', 'tool_name': 'spawn_browser_agent', 'depends_on': [0]},
    ],
    'dependencies_graph': [
        {'task_idx': '0', 'depends_on': []},
        {'task_idx': '1', 'depends_on': ['0']},
    ],
    'join': 'all',
    'validation_errors': [],
    'me': {'passed': True, 'score': 0.95, 'reasoning': 'Tasks are distinct.'},
    'ce': {'passed': False, 'score': 0.45, 'reasoning': 'Missing payment step.'},
    'complexity': {'passed': True, 'score': 0.90, 'reasoning': 'Each subtask is simpler.'},
}

SAMPLE_CANDIDATE_NO_EVALS = {
    'title': 'Simple Plan',
    'content': 'A plan without evaluations.',
    'tasks': [
        {'goal': 'Do task A', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Do task B', 'tool_name': 'reasoning', 'depends_on': [0]},
    ],
    'me': None,
    'ce': None,
    'complexity': None,
}


def _write_test_data(tmpdir: Path):
    """Write mock clarified tasks, labels, and labeler state for dataset tests."""
    tasks_dir = tmpdir / 'clarified_tasks'
    tasks_dir.mkdir()

    task_a = {
        'id': 'task-aaa',
        'raw_seed': 'Get me a black beanie',
        'agent_context': SAMPLE_CONTEXT,
        'set_plan_args': {},
    }
    (tasks_dir / '001_beanie.json').write_text(json.dumps(task_a))

    task_b = {
        'id': 'task-bbb',
        'raw_seed': 'Apply to jobs',
        'agent_context': [{'role': 'user', 'content': 'Apply to jobs'}],
        'set_plan_args': {},
    }
    (tasks_dir / '002_jobs.json').write_text(json.dumps(task_b))

    cand_0 = {**SAMPLE_CANDIDATE, 'title': 'Candidate 0'}
    cand_1 = {**SAMPLE_CANDIDATE, 'title': 'Candidate 1'}
    cand_2 = {**SAMPLE_CANDIDATE, 'title': 'Candidate 2'}
    cand_3 = {**SAMPLE_CANDIDATE, 'title': 'Candidate 3'}

    state = {
        'candidates_cache': {
            '001_beanie.json': [cand_0, cand_1, cand_2, cand_3],
            '002_jobs.json': [cand_0, cand_1, cand_2, cand_3],
        },
    }
    (tmpdir / 'labeler_state.json').write_text(json.dumps(state))

    labels = [
        {
            'pair_id': 'p1', 'task_id': 'task-aaa', 'task_seed': 'Get me a black beanie',
            'candidate_a_idx': 0, 'candidate_b_idx': 1,
            'preference': 'A', 'label_time_s': 5.0, 'timestamp': 1.0,
        },
        {
            'pair_id': 'p2', 'task_id': 'task-aaa', 'task_seed': 'Get me a black beanie',
            'candidate_a_idx': 2, 'candidate_b_idx': 3,
            'preference': 'B', 'label_time_s': 3.0, 'timestamp': 2.0,
        },
        {
            'pair_id': 'p3', 'task_id': 'task-aaa', 'task_seed': 'Get me a black beanie',
            'candidate_a_idx': 0, 'candidate_b_idx': 2,
            'preference': 'TIE', 'label_time_s': 4.0, 'timestamp': 3.0,
        },
        {
            'pair_id': 'p4', 'task_id': 'task-aaa', 'task_seed': 'Get me a black beanie',
            'candidate_a_idx': 1, 'candidate_b_idx': 3,
            'preference': 'SKIP', 'label_time_s': 1.0, 'timestamp': 4.0,
        },
        {
            'pair_id': 'p5', 'task_id': 'task-bbb', 'task_seed': 'Apply to jobs',
            'candidate_a_idx': 0, 'candidate_b_idx': 1,
            'preference': 'SKIP_TASK', 'label_time_s': 0.5, 'timestamp': 5.0,
        },
        # Label referencing a task with no candidates in cache
        {
            'pair_id': 'p6', 'task_id': 'task-missing', 'task_seed': 'Unknown',
            'candidate_a_idx': 0, 'candidate_b_idx': 1,
            'preference': 'A', 'label_time_s': 2.0, 'timestamp': 6.0,
        },
    ]
    (tmpdir / 'preference_labels.json').write_text(json.dumps(labels))

    return tasks_dir


class TestSerializePrompt:
    def test_formats_seed_and_context(self):
        result = serialize_prompt('Buy a beanie', SAMPLE_CONTEXT)
        assert result.startswith('Goal: Buy a beanie')
        assert '[USER]: Get me a black beanie' in result
        assert '[ASSISTANT]: I will find you a black beanie.' in result

    def test_empty_context(self):
        result = serialize_prompt('Do something', [])
        assert result == 'Goal: Do something'


class TestSerializeCandidate:
    def test_formats_candidate_with_tasks_and_evals(self):
        result = serialize_candidate(SAMPLE_CANDIDATE)
        assert 'Title: Buy a Black Beanie' in result
        assert 'Content: Find and purchase' in result
        assert '0. [web_search] Search for black beanies (depends: [])' in result
        assert '1. [spawn_browser_agent] Buy the best one (depends: [0])' in result
        assert 'ME: pass (0.95) - Tasks are distinct.' in result
        assert 'CE: fail (0.45) - Missing payment step.' in result
        assert 'CX: pass (0.90) - Each subtask is simpler.' in result

    def test_missing_evals(self):
        result = serialize_candidate(SAMPLE_CANDIDATE_NO_EVALS)
        assert 'Title: Simple Plan' in result
        assert 'Tasks:' in result
        assert 'Evaluations:' not in result


def _build_pairs(tmpdir):
    """Helper to build pairs from test data in tmpdir."""
    tmpdir = Path(tmpdir)
    tasks_dir = _write_test_data(tmpdir)
    return prepare_reward_pairs(
        labels_path=tmpdir / 'preference_labels.json',
        state_path=tmpdir / 'labeler_state.json',
        tasks_dir=tasks_dir,
    )


class TestPrepareRewardPairsFormat:
    def test_correct_columns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rows = _build_pairs(tmpdir)
            assert set(rows.keys()) == {'prompt', 'chosen', 'rejected'}


class TestPrepareRewardPairsSkipsMissing:
    def test_skips_labels_without_candidates(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rows = _build_pairs(tmpdir)
            # 6 labels total: 2 usable (A, B), 3 skipped (TIE, SKIP, SKIP_TASK), 1 missing
            assert len(rows['prompt']) == 2


class TestPrepareRewardPairsSkipsTies:
    def test_ties_are_excluded(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rows = _build_pairs(tmpdir)
            for i in range(len(rows['prompt'])):
                chosen_text = rows['chosen'][i][0]['content']
                rejected_text = rows['rejected'][i][0]['content']
                assert chosen_text != rejected_text


class TestPrepareRewardPairsPreferenceDirection:
    def test_a_preferred_means_a_is_chosen(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rows = _build_pairs(tmpdir)
            # First row is the A-preferred label (cand 0 > cand 1)
            assert 'Candidate 0' in rows['chosen'][0][0]['content']
            assert 'Candidate 1' in rows['rejected'][0][0]['content']

    def test_b_preferred_means_b_is_chosen(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rows = _build_pairs(tmpdir)
            # Second row is the B-preferred label (cand 3 > cand 2)
            assert 'Candidate 3' in rows['chosen'][1][0]['content']
            assert 'Candidate 2' in rows['rejected'][1][0]['content']


class TestDatasetConversationalFormat:
    def test_trl_format(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rows = _build_pairs(tmpdir)
            for i in range(len(rows['prompt'])):
                prompt = rows['prompt'][i]
                chosen = rows['chosen'][i]
                rejected = rows['rejected'][i]

                # prompt is a list of message dicts with role=user
                assert isinstance(prompt, list)
                assert len(prompt) == 1
                assert prompt[0]['role'] == 'user'
                assert 'Goal:' in prompt[0]['content']

                # chosen/rejected are lists of message dicts with role=assistant
                assert isinstance(chosen, list)
                assert len(chosen) == 1
                assert chosen[0]['role'] == 'assistant'

                assert isinstance(rejected, list)
                assert len(rejected) == 1
                assert rejected[0]['role'] == 'assistant'


class TestLLMLabeledIntegration:
    """Tests for prepare_reward_pairs with LLM-labeled pairs in same file."""

    def _write_test_data_with_llm_labels(self, tmpdir):
        """Write test data with both human and LLM-labeled entries."""
        tmpdir = Path(tmpdir)
        tasks_dir = _write_test_data(tmpdir)

        # Add LLM-labeled entries to the same preference_labels.json
        labels_path = tmpdir / 'preference_labels.json'
        with open(labels_path) as f:
            labels = json.load(f)

        labels.extend([
            {
                'pair_id': 's1', 'task_id': 'task-aaa', 'task_seed': 'Get me a black beanie',
                'candidate_a_idx': 0, 'candidate_b_idx': 3,
                'preference': 'A', 'label_time_s': 0, 'timestamp': 7.0,
                'source': 'llm_labeled', 'confidence': 85.0,
            },
            {
                'pair_id': 's2', 'task_id': 'task-aaa', 'task_seed': 'Get me a black beanie',
                'candidate_a_idx': 1, 'candidate_b_idx': 3,
                'preference': 'B', 'label_time_s': 0, 'timestamp': 8.0,
                'source': 'llm_labeled', 'confidence': 20.0,
            },
        ])
        labels_path.write_text(json.dumps(labels))
        return tasks_dir

    def test_includes_llm_labels(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tasks_dir = self._write_test_data_with_llm_labels(tmpdir)
            rows = prepare_reward_pairs(
                labels_path=Path(tmpdir) / 'preference_labels.json',
                state_path=Path(tmpdir) / 'labeler_state.json',
                tasks_dir=tasks_dir,
            )
            # 2 human usable + 2 LLM-labeled = 4
            assert len(rows['prompt']) == 4

    def test_min_confidence_filters_llm_labels(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tasks_dir = self._write_test_data_with_llm_labels(tmpdir)
            rows = prepare_reward_pairs(
                labels_path=Path(tmpdir) / 'preference_labels.json',
                state_path=Path(tmpdir) / 'labeler_state.json',
                tasks_dir=tasks_dir,
                min_confidence=50.0,
            )
            # 2 human usable + 1 LLM (85.0 >= 50, 20.0 filtered) = 3
            assert len(rows['prompt']) == 3

    def test_human_labels_unaffected_by_confidence_filter(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tasks_dir = self._write_test_data_with_llm_labels(tmpdir)
            rows = prepare_reward_pairs(
                labels_path=Path(tmpdir) / 'preference_labels.json',
                state_path=Path(tmpdir) / 'labeler_state.json',
                tasks_dir=tasks_dir,
                min_confidence=99.0,
            )
            # Human labels (no source field) pass through, only LLM labels filtered
            # 2 human + 0 LLM (both below 99) = 2
            assert len(rows['prompt']) == 2
