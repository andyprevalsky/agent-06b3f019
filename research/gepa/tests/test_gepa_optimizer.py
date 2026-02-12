"""Tests for GEPA optimizer (DSPy GEPA integration).

Unit tests cover strategy extraction, prompt composition, depth computation,
and metric edge cases. Integration tests (marked) require API keys + Modal.
"""

import json
import math
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent / 'agents'))

from helpers.prompts import build_planner_system_prompt
from tools.set_plan import _get_planner_tools_description

from research.gepa.pipelines.gepa_optimizer import (
    STRATEGY_START,
    STRATEGY_END,
    OptimizationResult,
    extract_strategy,
    compose_prompt,
    get_initial_strategy,
    _build_prompt_skeleton,
    _compute_depth,
    _parse_plan,
    _load_trainset,
    make_gepa_metric,
    optimize_prompt,
)
from research.gepa.tests.fixtures import (
    VALID_LINEAR_2,
    VALID_LINEAR_3,
    VALID_DIAMOND_4,
    VALID_PARALLEL_2,
    make_planner_response,
)


# ---------------------------------------------------------------------------
# Strategy extraction
# ---------------------------------------------------------------------------

class TestExtractStrategy:
    def test_contains_expected_headers(self):
        strategy = get_initial_strategy()
        assert 'TWO-AXIS PLANNING FRAMEWORK' in strategy
        assert 'DECOMPOSITION PRINCIPLES' in strategy
        assert 'TASK COUNT LIMITS' in strategy

    def test_excludes_fixed_sections(self):
        strategy = get_initial_strategy()
        assert 'OUTPUT CONTRACT' not in strategy
        assert 'AVAILABLE TOOLS' not in strategy
        assert 'SPAWN_SUB_AGENT TOOL' not in strategy
        assert 'ATTACHED FILES' not in strategy
        assert 'CRITICAL REMINDERS' not in strategy

    def test_starts_at_marker(self):
        strategy = get_initial_strategy()
        assert strategy.startswith(STRATEGY_START)

    def test_does_not_contain_end_marker(self):
        strategy = get_initial_strategy()
        assert STRATEGY_END not in strategy

    def test_extract_from_full_prompt(self):
        tools_desc = _get_planner_tools_description()
        full = build_planner_system_prompt(tools_desc)
        strategy = extract_strategy(full)
        assert len(strategy) > 100
        assert len(strategy) < len(full)


# ---------------------------------------------------------------------------
# Prompt composition
# ---------------------------------------------------------------------------

class TestComposePrompt:
    def test_roundtrip(self):
        """Extract strategy then compose should reproduce original prompt."""
        tools_desc = _get_planner_tools_description()
        original = build_planner_system_prompt(tools_desc)
        strategy = extract_strategy(original)
        composed = compose_prompt(strategy)
        assert composed == original

    def test_modified_strategy_appears(self):
        modified = 'CUSTOM STRATEGY\n---\nAlways create exactly 5 tasks.'
        composed = compose_prompt(modified)
        assert 'CUSTOM STRATEGY' in composed
        assert 'Always create exactly 5 tasks.' in composed

    def test_fixed_sections_preserved(self):
        modified = 'CUSTOM STRATEGY\n---\nTest strategy.'
        composed = compose_prompt(modified)
        assert 'OUTPUT CONTRACT' in composed
        assert 'SPAWN_SUB_AGENT TOOL' in composed
        assert 'AVAILABLE TOOLS' in composed
        assert 'CRITICAL REMINDERS' in composed

    def test_original_strategy_removed(self):
        modified = 'REPLACEMENT STRATEGY ONLY'
        composed = compose_prompt(modified)
        assert 'Progress happens along two orthogonal axes' not in composed


# ---------------------------------------------------------------------------
# Prompt skeleton
# ---------------------------------------------------------------------------

class TestPromptSkeleton:
    def test_excludes_strategy_headers(self):
        skeleton = _build_prompt_skeleton()
        assert 'TWO-AXIS PLANNING FRAMEWORK' not in skeleton

    def test_includes_fixed_sections(self):
        skeleton = _build_prompt_skeleton()
        assert 'OUTPUT CONTRACT' in skeleton
        assert 'SPAWN_SUB_AGENT TOOL' in skeleton
        assert 'AVAILABLE TOOLS' in skeleton


# ---------------------------------------------------------------------------
# Compute depth
# ---------------------------------------------------------------------------

class TestComputeDepth:
    def test_parallel(self):
        """Fully parallel tasks have depth 0."""
        assert _compute_depth(VALID_PARALLEL_2) == 0

    def test_linear_2(self):
        """A → B has depth 1."""
        assert _compute_depth(VALID_LINEAR_2) == 1

    def test_linear_3(self):
        """A → B → C has depth 2."""
        assert _compute_depth(VALID_LINEAR_3) == 2

    def test_diamond(self):
        """A → (B, C) → D has depth 2."""
        assert _compute_depth(VALID_DIAMOND_4) == 2

    def test_all_parallel(self):
        pr = make_planner_response(tasks=[
            {'goal': 'a', 'depends_on': []},
            {'goal': 'b', 'depends_on': []},
        ])
        assert _compute_depth(pr) == 0

    def test_single_task(self):
        pr = make_planner_response(tasks=[{'goal': 'only', 'depends_on': []}])
        assert _compute_depth(pr) == 0


# ---------------------------------------------------------------------------
# Parse plan
# ---------------------------------------------------------------------------

class TestParsePlan:
    def test_valid_json(self):
        plan = {
            'title': 'Test',
            'content': 'Test',
            'tasks': [
                {'goal': 'a', 'tool_name': 'web_search', 'depends_on': []},
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

    def test_invalid_json_returns_none(self):
        assert _parse_plan('not json') is None

    def test_missing_fields_returns_none(self):
        assert _parse_plan('{"title": "only title"}') is None


# ---------------------------------------------------------------------------
# Metric function
# ---------------------------------------------------------------------------

class TestGepaMetric:
    def test_invalid_json_returns_zero(self):
        metric = make_gepa_metric()
        example = SimpleNamespace(goal='test', context='[]')
        pred = SimpleNamespace(plan_json='not valid json')
        assert float(metric(example, pred)) == 0.0

    def test_invalid_structure_returns_zero(self):
        """Valid JSON but only 1 task → fails hard_gate → 0.0."""
        metric = make_gepa_metric()
        plan = {
            'title': 'Bad',
            'content': 'Bad',
            'tasks': [{'goal': 'only one', 'tool_name': 'web_search', 'depends_on': []}],
            'dependencies_graph': [{'task_idx': '0', 'depends_on': []}],
            'join': 'all',
        }
        example = SimpleNamespace(goal='test', context='[]')
        pred = SimpleNamespace(plan_json=json.dumps(plan))
        assert float(metric(example, pred)) == 0.0

    def test_cycle_returns_zero(self):
        """Cyclic deps → fails hard_gate → 0.0."""
        metric = make_gepa_metric()
        plan = {
            'title': 'Cycle',
            'content': 'Cycle',
            'tasks': [
                {'goal': 'a', 'tool_name': 'web_search', 'depends_on': [1]},
                {'goal': 'b', 'tool_name': 'web_search', 'depends_on': [0]},
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

    @patch('research.gepa.pipelines.gepa_optimizer.score_candidates')
    def test_valid_plan_calls_critic(self, mock_score):
        """Valid plan should call score_candidates and return a score."""
        mock_score.return_value = [0.8]
        metric = make_gepa_metric('test_model')
        plan = {
            'title': 'Good',
            'content': 'Good plan',
            'tasks': [
                {'goal': 'research', 'tool_name': 'web_search', 'depends_on': []},
                {'goal': 'analyze', 'tool_name': 'reasoning', 'depends_on': []},
                {'goal': 'synthesize', 'tool_name': 'reasoning', 'depends_on': [0, 1]},
            ],
            'dependencies_graph': [
                {'task_idx': '0', 'depends_on': []},
                {'task_idx': '1', 'depends_on': []},
                {'task_idx': '2', 'depends_on': ['0', '1']},
            ],
            'join': 'all',
        }
        example = SimpleNamespace(goal='test goal', context='[]')
        pred = SimpleNamespace(plan_json=json.dumps(plan))
        score = metric(example, pred)

        mock_score.assert_called_once()
        assert score > 0.0

    @patch('research.gepa.pipelines.gepa_optimizer.score_candidates')
    def test_metric_exception_returns_zero(self, mock_score):
        """If critic call throws, metric should return 0.0."""
        mock_score.side_effect = RuntimeError('Modal unavailable')
        metric = make_gepa_metric()
        plan = {
            'title': 'Good',
            'content': 'Good plan',
            'tasks': [
                {'goal': 'a', 'tool_name': 'web_search', 'depends_on': []},
                {'goal': 'b', 'tool_name': 'reasoning', 'depends_on': [0]},
            ],
            'dependencies_graph': [
                {'task_idx': '0', 'depends_on': []},
                {'task_idx': '1', 'depends_on': ['0']},
            ],
            'join': 'all',
        }
        example = SimpleNamespace(goal='test', context='[]')
        pred = SimpleNamespace(plan_json=json.dumps(plan))
        assert float(metric(example, pred)) == 0.0


# ---------------------------------------------------------------------------
# Load trainset (tests raw data loading; dspy wrapping tested in integration)
# ---------------------------------------------------------------------------

class TestLoadTrainset:
    """Verify clarified task JSON files have the fields _load_trainset expects."""

    def _load_raw_tasks(self):
        from research.gepa.pipelines.gepa_optimizer import TASKS_DIR
        tasks = []
        for path in sorted(TASKS_DIR.glob('*.json')):
            tasks.append(json.loads(path.read_text()))
        return tasks

    def test_finds_tasks(self):
        tasks = self._load_raw_tasks()
        assert len(tasks) > 0

    def test_task_has_required_fields(self):
        tasks = self._load_raw_tasks()
        t = tasks[0]
        assert 'raw_seed' in t
        assert 'agent_context' in t
        assert isinstance(t['raw_seed'], str)
        assert len(t['raw_seed']) > 0

    def test_agent_context_is_list(self):
        tasks = self._load_raw_tasks()
        assert isinstance(tasks[0]['agent_context'], list)

    def test_prompt_skeleton_contains_fixed_sections(self):
        skeleton = _build_prompt_skeleton()
        assert 'OUTPUT CONTRACT' in skeleton
        assert 'AVAILABLE TOOLS' in skeleton


# ---------------------------------------------------------------------------
# Minimal end-to-end integration (requires OPENROUTER_API_KEY + dspy)
# ---------------------------------------------------------------------------

@pytest.mark.integration
class TestOptimizeMinimal:
    """Full end-to-end GEPA pipeline at reduced data scale (2 examples).

    Requires: OPENROUTER_API_KEY + MODAL env vars + dspy.
    """

    @pytest.fixture(autouse=True)
    def _skip_if_unavailable(self):
        import os
        from dotenv import load_dotenv
        load_dotenv(Path(__file__).resolve().parent.parent.parent.parent / 'agents' / '.env')
        if not os.getenv('OPENROUTER_API_KEY'):
            pytest.skip('OPENROUTER_API_KEY not set')
        try:
            import dspy  # noqa: F401
        except ImportError:
            pytest.skip('dspy import fails (gepa name collision)')

    def test_optimize_light_end_to_end(self):
        """auto='light', 2 examples, real metric through full pipeline."""
        trainset = _load_trainset()[:2]
        result = optimize_prompt(
            auto='light',
            num_threads=1,
            trainset=trainset,
        )

        assert isinstance(result, OptimizationResult)
        assert len(result.optimized_strategy) > 0
        assert len(result.optimized_prompt) > 0
        assert 'OUTPUT CONTRACT' in result.optimized_prompt
        assert 'AVAILABLE TOOLS' in result.optimized_prompt
        assert 'SPAWN_SUB_AGENT TOOL' in result.optimized_prompt
