"""Unit tests for expansion pipeline — no API calls."""

import json
from pathlib import Path

from research.gepa.pipelines.expansion import (
    _get_existing_seeds,
    _make_expanded_filename,
    extract_expansion_seeds,
)


def _write_mock_data(
    tmp_path: Path, candidates_cache: dict, labels: list[dict] | None = None
) -> tuple[Path, Path, Path]:
    """Write mock labeler_state.json, labels, and task files. Returns (state_path, labels_path, tasks_dir)."""
    state_path = tmp_path / 'labeler_state.json'
    state_path.write_text(
        json.dumps(
            {
                'candidates_cache': candidates_cache,
                'task_files': list(candidates_cache.keys()),
            }
        )
    )

    labels_path = tmp_path / 'preference_labels.json'
    labels_path.write_text(json.dumps(labels or []))

    tasks_dir = tmp_path / 'clarified_tasks'
    tasks_dir.mkdir(exist_ok=True)

    # Create task files for each key in candidates_cache so id→filename mapping works
    for i, filename in enumerate(candidates_cache.keys()):
        task_id = f'task-{i:03d}'
        (tasks_dir / filename).write_text(
            json.dumps(
                {
                    'id': task_id,
                    'raw_seed': f'Task {i}',
                    'agent_context': [],
                    'set_plan_args': {},
                }
            )
        )

    return state_path, labels_path, tasks_dir


def _make_candidate(tasks: list[dict]) -> dict:
    return {
        'title': 'Test',
        'content': 'Test plan',
        'tasks': tasks,
        'dependencies_graph': [],
        'join': 'all',
        'validation_errors': [],
        'me': None,
        'ce': None,
        'complexity': None,
    }


class TestExtractExpansionSeeds:
    def test_finds_spawn_sub_agent_goals_from_labeled_tasks(self, tmp_path):
        cache = {
            'task_001.json': [
                _make_candidate(
                    [
                        {'goal': 'Search for flights', 'tool_name': 'web_search', 'depends_on': []},
                        {
                            'goal': 'Book the cheapest flight',
                            'tool_name': 'spawn_sub_agent',
                            'depends_on': [0],
                        },
                    ]
                ),
            ],
        }
        labels = [
            {'task_id': 'task-000', 'preference': 'A', 'candidate_a_idx': 0, 'candidate_b_idx': 1}
        ]
        state_path, labels_path, tasks_dir = _write_mock_data(tmp_path, cache, labels)
        seeds = extract_expansion_seeds(state_path, labels_path, tasks_dir)
        assert 'Book the cheapest flight' in seeds

    def test_ignores_spawn_browser_agent(self, tmp_path):
        """Only spawn_sub_agent goals are mined, not spawn_browser_agent."""
        cache = {
            'task_001.json': [
                _make_candidate(
                    [
                        {
                            'goal': 'Navigate to checkout',
                            'tool_name': 'spawn_browser_agent',
                            'depends_on': [],
                        },
                    ]
                ),
            ],
        }
        labels = [
            {'task_id': 'task-000', 'preference': 'A', 'candidate_a_idx': 0, 'candidate_b_idx': 1}
        ]
        state_path, labels_path, tasks_dir = _write_mock_data(tmp_path, cache, labels)
        seeds = extract_expansion_seeds(state_path, labels_path, tasks_dir)
        assert len(seeds) == 0

    def test_ignores_unlabeled_tasks(self, tmp_path):
        """Only mines from tasks that have labels."""
        cache = {
            'task_001.json': [
                _make_candidate(
                    [
                        {'goal': 'Book flight', 'tool_name': 'spawn_sub_agent', 'depends_on': []},
                    ]
                ),
            ],
        }
        # No labels for this task
        state_path, labels_path, tasks_dir = _write_mock_data(tmp_path, cache, labels=[])
        seeds = extract_expansion_seeds(state_path, labels_path, tasks_dir)
        assert len(seeds) == 0

    def test_ignores_non_spawn_tools(self, tmp_path):
        cache = {
            'task_001.json': [
                _make_candidate(
                    [
                        {'goal': 'Search for flights', 'tool_name': 'web_search', 'depends_on': []},
                        {'goal': 'Think about it', 'tool_name': 'reasoning', 'depends_on': [0]},
                    ]
                ),
            ],
        }
        labels = [
            {'task_id': 'task-000', 'preference': 'A', 'candidate_a_idx': 0, 'candidate_b_idx': 1}
        ]
        state_path, labels_path, tasks_dir = _write_mock_data(tmp_path, cache, labels)
        seeds = extract_expansion_seeds(state_path, labels_path, tasks_dir)
        assert len(seeds) == 0

    def test_deduplicates_goals(self, tmp_path):
        cache = {
            'task_001.json': [
                _make_candidate(
                    [
                        {'goal': 'Book flight', 'tool_name': 'spawn_sub_agent', 'depends_on': []},
                    ]
                ),
                _make_candidate(
                    [
                        {'goal': 'Book flight', 'tool_name': 'spawn_sub_agent', 'depends_on': []},
                    ]
                ),
            ],
        }
        labels = [
            {'task_id': 'task-000', 'preference': 'A', 'candidate_a_idx': 0, 'candidate_b_idx': 1}
        ]
        state_path, labels_path, tasks_dir = _write_mock_data(tmp_path, cache, labels)
        seeds = extract_expansion_seeds(state_path, labels_path, tasks_dir)
        assert seeds.count('Book flight') == 1

    def test_skips_none_candidates(self, tmp_path):
        cache = {
            'task_001.json': [
                None,
                _make_candidate(
                    [
                        {'goal': 'Do task', 'tool_name': 'spawn_sub_agent', 'depends_on': []},
                    ]
                ),
            ],
        }
        labels = [
            {'task_id': 'task-000', 'preference': 'A', 'candidate_a_idx': 0, 'candidate_b_idx': 1}
        ]
        state_path, labels_path, tasks_dir = _write_mock_data(tmp_path, cache, labels)
        seeds = extract_expansion_seeds(state_path, labels_path, tasks_dir)
        assert 'Do task' in seeds

    def test_empty_cache(self, tmp_path):
        state_path, labels_path, tasks_dir = _write_mock_data(tmp_path, {})
        seeds = extract_expansion_seeds(state_path, labels_path, tasks_dir)
        assert seeds == []


class TestGetExistingSeeds:
    def test_reads_raw_seeds_from_task_files(self, tmp_path):
        (tmp_path / 'task_001.json').write_text(
            json.dumps(
                {
                    'id': '1',
                    'raw_seed': 'Book a flight',
                    'agent_context': [],
                    'set_plan_args': {},
                }
            )
        )
        (tmp_path / 'task_002.json').write_text(
            json.dumps(
                {
                    'id': '2',
                    'raw_seed': 'Order food',
                    'agent_context': [],
                    'set_plan_args': {},
                }
            )
        )
        seeds = _get_existing_seeds(tmp_path)
        assert 'book a flight' in seeds
        assert 'order food' in seeds


class TestMakeExpandedFilename:
    def test_starts_with_prefix(self):
        name = _make_expanded_filename('Book a flight', 0)
        assert name.startswith('E_')

    def test_sanitizes_special_chars(self):
        name = _make_expanded_filename('Find/compare the best option', 0)
        assert '/' not in name

    def test_includes_index(self):
        name = _make_expanded_filename('Test seed', 5)
        assert '005' in name
